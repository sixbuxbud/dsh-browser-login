import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CdpClient } from './cdp.js'
import { snapshotInPage, readInPage, handoffBannerInPage, clearBannerInPage } from './snapshot.js'
import { sleep, ensureDir, readJson, writeJson, nowIso, stamp, truncate, waitFor, dshHome, Mutex } from './util.js'

/** 常见 Chromium 内核浏览器位置（Windows 优先）。 */
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** 找一个可用的浏览器可执行文件。 */
export async function resolveBrowserPath(configured) {
  if (configured && configured.trim()) return configured.trim()
  if (process.env.DSH_BROWSER_PATH) return process.env.DSH_BROWSER_PATH
  for (const candidate of CANDIDATES) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {}
  }
  const local = process.env.LOCALAPPDATA
  if (local) {
    const extra = path.join(local, 'Google\\Chrome\\Application\\chrome.exe')
    try {
      await fs.access(extra)
      return extra
    } catch {}
  }
  throw new Error('找不到 Chrome/Edge。请安装 Chrome，或在插件 config / browser_profile 里用 browserPath 指定 chrome.exe 路径。')
}

const DEFAULTS = {
  defaultProfile: 'default',
  profilesDir: '',
  browserPath: '',
  headless: false,
  proxy: '',
  userAgent: '',
  locale: 'zh-CN',
  timezone: '',
  viewport: { width: 1440, height: 900 },
  snapshotMaxChars: 24000,
  snapshotMaxLines: 900,
  loginTimeoutMs: 300000,
  handoffTimeoutMs: 600000,
  autoFocusWindow: true,
  closeOnDispose: false,
  settleMs: 400,
}

/** 常用按键的 CDP 参数。 */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
}

/** 一个页面的 CDP 句柄。 */
class PageHandle {
  constructor(entry, targetId, sessionId) {
    this.entry = entry
    this.targetId = targetId
    this.sessionId = sessionId
  }

  send(method, params, options) {
    const payload = Object.assign({}, options || {}, { sessionId: this.sessionId })
    return this.entry.client.send(method, params || {}, payload)
  }

  async init() {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
    this.entry.client.on('Page.javascriptDialogOpening', (params, sessionId) => {
      if (sessionId !== this.sessionId) return
      this.send('Page.handleJavaScriptDialog', { accept: params.type === 'beforeunload' }).catch(() => {})
    })
    // 不在这里抢焦点：只有登录/人工接管时才调 focusWindow
  }

  async evaluate(expression, options) {
    const opts = options || {}
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: opts.awaitPromise !== false,
        returnByValue: opts.returnByValue !== false,
        userGesture: true,
      },
      { timeoutMs: opts.timeoutMs || 30000 },
    )
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '未知错误'
      throw new Error('页面脚本异常：' + String(detail).split('\n')[0])
    }
    return result.result ? result.result.value : undefined
  }

  async url() {
    try {
      return await this.evaluate('location.href')
    } catch {
      return this.info ? this.info.url : ''
    }
  }

  async readyState() {
    try {
      return await this.evaluate('document.readyState', { timeoutMs: 5000 })
    } catch {
      return 'loading'
    }
  }

  async waitReady(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 45000)
    while (Date.now() < deadline) {
      const state = await this.readyState()
      if (state === 'complete') {
        await sleep(250)
        return true
      }
      await sleep(150)
    }
    return false
  }

  /** readyState=complete 之后，等正文长度连续两次不变，缓解 SPA 首屏还没渲染的问题。 */
  async waitStable(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 4000)
    let last = -1
    let stable = 0
    while (Date.now() < deadline) {
      const size = await this.evaluate('document.body ? document.body.innerText.length : 0', { timeoutMs: 4000 }).catch(() => -1)
      if (size === last) {
        stable += 1
        if (stable >= 2) return true
      } else {
        stable = 0
        last = size
      }
      await sleep(300)
    }
    return false
  }

  async snapshot(options) {
    const opts = Object.assign({ maxChars: 24000, maxLines: 900 }, options || {})
    const result = await this.evaluate('(' + snapshotInPage.toString() + ')(' + JSON.stringify(opts) + ')', { timeoutMs: 30000 })
    if (!result) throw new Error('页面快照失败（页面可能尚未就绪）')
    return result
  }

  async read(options) {
    const opts = Object.assign({ maxChars: 20000 }, options || {})
    return this.evaluate('(' + readInPage.toString() + ')(' + JSON.stringify(opts) + ')', { timeoutMs: 30000 })
  }

  /** 取编号对应的元素：优先用快照写进页面的数组，旧属性只作兜底。 */
  resolveExpression(ref) {
    const selector = '[data-dsh-ref="' + Number(ref) + '"]'
    return '((window.__dshRefs || [])[' + (Number(ref) - 1) + '] || document.querySelector(' + JSON.stringify(selector) + '))'
  }

  async boxOf(ref) {
    return this.evaluate(
      '(function(){ var el = ' + this.resolveExpression(ref) + '; if (!el || !el.isConnected) return null;' +
        ' el.scrollIntoView({ block: "center", inline: "center" });' +
        ' var r = el.getBoundingClientRect();' +
        ' return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, tag: el.tagName }; })()',
      { timeoutMs: 10000 },
    )
  }

  async click(ref) {
    const box = await this.boxOf(ref)
    if (!box) throw new Error('编号 [' + ref + '] 已失效（页面已变化或已跳转），请重新调用 browser_snapshot 拿新编号')
    if (box.w >= 1 && box.h >= 1) {
      const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
      await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved' }, base))
      await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base))
      await sleep(60)
      await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base))
    } else {
      await this.evaluate('(function(){ var el = ' + this.resolveExpression(ref) + '; if (el) el.click(); })()')
    }
    return box
  }

  async focus(ref) {
    return this.evaluate(
      '(function(){ var el = ' + this.resolveExpression(ref) + '; if (!el) return false;' +
        ' el.scrollIntoView({ block: "center" }); el.focus(); return true; })()',
    )
  }

  async typeInto(ref, text, options) {
    const opts = Object.assign({ clear: true, submit: false }, options || {})
    const focused = await this.focus(ref)
    if (!focused) throw new Error('找不到编号 [' + ref + '] 的输入框，请先调用 browser_snapshot')
    if (opts.clear) {
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    }
    await this.send('Input.insertText', { text: String(text) })
    if (opts.submit) await this.press('Enter')
  }

  async press(key) {
    const spec = KEYS[key] || KEYS[key.charAt(0).toUpperCase() + key.slice(1)]
    if (!spec) throw new Error('不支持的按键：' + key + '（支持 ' + Object.keys(KEYS).join('/') + '）')
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk }
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base, spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}))
    if (spec.text) await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: spec.text, unmodifiedText: spec.text }, base))
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base))
  }

  async wheel(deltaY) {
    const size = await this.evaluate('({ w: window.innerWidth, h: window.innerHeight })').catch(() => ({ w: 1200, h: 800 }))
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(size.w / 2),
      y: Math.round(size.h / 2),
      deltaX: 0,
      deltaY: Math.round(deltaY),
      pointerType: 'mouse',
    })
    await sleep(this.entry.config.settleMs)
  }

  async screenshot(fullPage) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(fullPage) }, { timeoutMs: 30000 })
    return result.data
  }

  async cookies() {
    const result = await this.send('Storage.getCookies', {}, { timeoutMs: 20000 })
    return result.cookies || []
  }

  async setCookies(cookies) {
    await this.send('Storage.setCookies', { cookies }, { timeoutMs: 20000 })
  }


}

/** 一个 profile 对应的浏览器实例。 */
export class BrowserEntry {
  constructor(manager, name, profile) {
    this.manager = manager
    this.config = manager.config
    this.name = name
    this.profile = profile
    this.mutex = new Mutex()
    this.child = null
    this.client = null
    this.pages = new Map()
    this.activeTargetId = null
    this.browserVersion = ''
    this.launching = null
  }

  get dir() {
    return this.manager.profileDir(this.name)
  }

  get stateDir() {
    return path.join(this.dir, 'state')
  }

  get shotDir() {
    return path.join(this.dir, 'screenshots')
  }

  get dataDir() {
    return path.join(this.dir, 'chrome')
  }

  args(headed) {
    const profile = this.profile
    const viewport = profile.viewport || this.config.viewport || { width: 1440, height: 900 }
    const args = [
      '--remote-debugging-port=0',
      '--user-data-dir=' + this.dataDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,TranslateUI,MediaRouter,OptimizationHints',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-popup-blocking',
      '--hide-crash-restore-bubble',
      '--window-size=' + (viewport.width || 1440) + ',' + (viewport.height || 900),
      '--lang=' + (profile.locale || this.config.locale || 'zh-CN'),
    ]
    if (profile.timezone || this.config.timezone) args.push('--timezone=' + (profile.timezone || this.config.timezone))
    if (profile.proxy || this.config.proxy) args.push('--proxy-server=' + (profile.proxy || this.config.proxy))
    if (profile.userAgent || this.config.userAgent) args.push('--user-agent=' + (profile.userAgent || this.config.userAgent))
    if (!headed) args.push('--headless=new')
    args.push('about:blank')
    return args
  }

  async launch(options) {
    if (this.client && !this.client.closed) return this
    if (this.launching) return this.launching
    this.launching = this._launch(options || {}).finally(() => {
      this.launching = null
    })
    return this.launching
  }

  async _launch(options) {
    // forceHeaded：登录/人工接管时强制带界面，即使 profile 平时是无头的
    const forceHeaded = options.forceHeaded === true
    const headless = forceHeaded
      ? false
      : this.profile.headless !== undefined
        ? Boolean(this.profile.headless)
        : Boolean(this.config.headless)
    this.headless = headless
    await ensureDir(this.dataDir)
    const browserPath = this.profile.browserPath || await resolveBrowserPath(this.config.browserPath)
    const existingPort = await this.readPort().catch(() => '')
    if (existingPort && (await this.pingPort(existingPort))) {
      await this.connect(existingPort)
      return this
    }
    this.spawnError = ''
    this.child = spawn(browserPath, this.args(!headless), { stdio: 'ignore', windowsHide: false })
    this.child.on('error', (error) => {
      this.spawnError = error.message || String(error)
    })
    this.pid = this.child.pid
    const exited = new Promise((resolve) => this.child.once('exit', (code) => resolve(code)))
    this.child.on('exit', () => {
      this.child = null
      this.client = null
      this.pages.clear()
      this.activeTargetId = null
    })
    const port = await this.waitForPort(exited, 25000)
    if (!port) {
      const reason = this.spawnError ? '启动命令失败：' + this.spawnError : '没有拿到调试端口'
      throw new Error(
        '浏览器启动失败或 profile 被占用（' + reason + '）\n' +
          '浏览器：' + browserPath + '\n' +
          'profile 目录：' + this.dataDir + '\n' +
          '如果已经有一个用同一 profile 打开的 Chrome 窗口，请先关闭它，或换一个 profile。',
      )
    }
    await this.connect(port)
    return this
  }

  async readPort() {
    const text = await fs.readFile(path.join(this.dataDir, 'DevToolsActivePort'), 'utf8')
    return text.split(/\r?\n/)[0].trim()
  }

  async pingPort(port) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) })
      return response.ok
    } catch {
      return false
    }
  }

  async waitForPort(exited, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const port = await this.readPort()
        if (port && (await this.pingPort(port))) return port
      } catch {}
      if (this.spawnError) return ''
      const code = await Promise.race([exited, sleep(120).then(() => 'pending')])
      if (code !== 'pending') {
        if (code === 0) {
          await sleep(600)
          try {
            const port = await this.readPort()
            if (port && (await this.pingPort(port))) return port
          } catch {}
        }
        return ''
      }
    }
    return ''
  }

  async connect(port) {
    let version = null
    let lastError = null
    for (let attempt = 0; attempt < 10 && !version; attempt++) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(3000) })
        version = await response.json()
      } catch (error) {
        lastError = error
        await sleep(200)
      }
    }
    if (!version) throw new Error('连不上浏览器调试端口 ' + port + '：' + (lastError ? lastError.message : '未知错误'))
    this.browserVersion = version.Browser || 'Chromium'
    this.client = await CdpClient.connect(version.webSocketDebuggerUrl)
    this.client.on('Target.targetDestroyed', (params) => {
      this.pages.delete(params.targetId)
      if (this.activeTargetId === params.targetId) this.activeTargetId = null
    })
    this.client.on('Target.targetCreated', (params) => {
      const info = params.targetInfo
      if (info.type !== 'page') return
      if (!this.activeTargetId) this.activeTargetId = info.targetId
    })
    await this.client.send('Target.setDiscoverTargets', { discover: true })
    this.connectedAt = Date.now()
  }

  async listTargets() {
    const result = await this.client.send('Target.getTargets')
    return (result.targetInfos || []).filter((info) => info.type === 'page')
  }

  async attach(targetId) {
    if (this.pages.has(targetId)) return this.pages.get(targetId)
    const attached = await this.client.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new PageHandle(this, targetId, attached.sessionId)
    await page.init()
    this.pages.set(targetId, page)
    return page
  }

  async page() {
    const page = await this._page()
    if (!this.restored) {
      this.restored = true
      await this.restoreCookiesOn(page).catch(() => {})
    }
    return page
  }

  async _page() {
    await this.launch()
    if (this.activeTargetId && this.pages.has(this.activeTargetId)) return this.pages.get(this.activeTargetId)
    if (this.activeTargetId) {
      try {
        return await this.attach(this.activeTargetId)
      } catch {}
    }
    const targets = await this.listTargets()
    const usable = targets.find((info) => !info.url.startsWith('devtools://')) || targets[0]
    if (usable) {
      this.activeTargetId = usable.targetId
      return this.attach(usable.targetId)
    }
    const created = await this.client.send('Target.createTarget', { url: 'about:blank' })
    this.activeTargetId = created.targetId
    return this.attach(created.targetId)
  }

  /** 把当前浏览器的 cookie 落盘，供下次启动恢复（会话 cookie 也照顾到）。 */
  async savePortableCookies() {
    if (!this.client || this.client.closed) return 0
    try {
      const page = await this._page()
      const cookies = await page.cookies()
      if (!cookies.length) return 0
      await ensureDir(this.stateDir)
      await writeJson(path.join(this.stateDir, 'cookies.json'), { savedAt: nowIso(), cookies: portableState(cookies) })
      return cookies.length
    } catch {
      return 0
    }
  }

  /** 启动后补回缺失的 cookie：Chrome 不会恢复无过期时间的会话 cookie，这里替它补上。 */
  async restoreCookiesOn(page) {
    const saved = await readJson(path.join(this.stateDir, 'cookies.json'), null)
    if (!saved || !Array.isArray(saved.cookies) || !saved.cookies.length) return 0
    const existing = await page.cookies()
    const keyOf = (cookie) => cookie.name + '|' + cookie.domain + '|' + (cookie.path || '/')
    const have = new Set(existing.map(keyOf))
    const nowSeconds = Date.now() / 1000
    const missing = saved.cookies.filter((cookie) => {
      if (!cookie || !cookie.name || !cookie.domain) return false
      if (have.has(keyOf(cookie))) return false
      if (typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires < nowSeconds) return false
      return true
    })
    if (!missing.length) return 0
    await page.setCookies(missing)
    return missing.length
  }

  /** 当前活动页面的便捷方法（转发到 PageHandle）。 */
  async snapshot(options) {
    const page = await this.page()
    let result = await page.snapshot(options)
    if (!result || !result.view || result.view.length < 20) {
      // 首屏还在渲染时补一次：先等稳定再截
      await page.waitStable(4000)
      result = await page.snapshot(options)
    }
    return result
  }

  async read(options) {
    const page = await this.page()
    return page.read(options)
  }

  async evaluate(expression, options) {
    const page = await this.page()
    return page.evaluate(expression, options)
  }

  async url() {
    const page = await this.page()
    return page.url()
  }

  async newPage(url) {
    await this.launch()
    const created = await this.client.send('Target.createTarget', { url: url || 'about:blank' })
    const page = await this.attach(created.targetId)
    this.activeTargetId = created.targetId
    return page
  }

  async goto(url, options) {
    const page = await this.page()
    const timeoutMs = (options && options.timeoutMs) || 60000
    try {
      await page.send('Page.navigate', { url }, { timeoutMs })
    } catch (error) {
      throw new Error('打开 ' + url + ' 失败：' + (error.message || error))
    }
    await page.waitReady(timeoutMs)
    await page.waitStable(4000)
    await sleep(this.config.settleMs)
    return page
  }

  async switchToNewestTab(previousIds) {
    const targets = await this.listTargets()
    const fresh = targets.find((info) => !previousIds.includes(info.targetId))
    if (!fresh) return null
    this.activeTargetId = fresh.targetId
    const page = await this.attach(fresh.targetId)
    await page.waitReady(20000)
    await sleep(this.config.settleMs)
    return page
  }

  async tabs() {
    await this.launch()
    const targets = await this.listTargets()
    return targets.map((info, index) => ({
      index,
      title: info.title,
      url: info.url,
      active: info.targetId === this.activeTargetId,
      targetId: info.targetId,
    }))
  }

  async switchTab(index) {
    const tabs = await this.tabs()
    const tab = tabs[index]
    if (!tab) throw new Error('没有第 ' + index + ' 个标签页')
    this.activeTargetId = tab.targetId
    const page = await this.attach(tab.targetId)
    await page.send('Page.bringToFront').catch(() => {})
    return tab
  }

  async focusWindow() {
    await this.page().then((page) => page.send('Page.bringToFront')).catch(() => {})
    if (!this.config.autoFocusWindow || process.platform !== 'win32' || !this.pid) return
    try {
      const { execFile } = await import('node:child_process')
      const script = 'try { $ws = New-Object -ComObject WScript.Shell; $ws.AppActivate(' + Number(this.pid) + ') | Out-Null } catch {}'
      execFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { timeout: 4000, windowsHide: true }, () => {})
    } catch {}
  }

  async close() {
    // 只在浏览器还活着时存 cookie；否则 close 会为了存 cookie 反向拉起一个浏览器
    if (this.client && !this.client.closed) {
      await Promise.race([this.savePortableCookies(), sleep(1500)]).catch(() => {})
      await this.client.send('Browser.close', {}, { timeoutMs: 5000 }).catch(() => {})
    }
    try { this.client?.close() } catch {}
    this.client = null
    this.pages.clear()
    this.activeTargetId = null
    if (this.child) {
      const child = this.child
      this.child = null
      try { child.kill() } catch {}
      await sleep(800)
    }
    this.restored = false
  }
}

/** profile 与浏览器实例管理。 */
export class BrowserManager {
  constructor(config) {
    this.config = Object.assign({}, DEFAULTS, config || {})
    this.profilesDir = this.config.profilesDir && this.config.profilesDir.trim()
      ? this.config.profilesDir
      : path.join(dshHome(), 'browser-profiles')
    this.profilesFile = path.join(this.profilesDir, 'profiles.json')
    this.entries = new Map()
    this.store = null
    this.opening = new Map()
  }

  profileDir(name) {
    const safe = String(name || this.config.defaultProfile || 'default').replace(/[^A-Za-z0-9._-]/g, '_')
    return path.join(this.profilesDir, safe)
  }

  async load() {
    if (this.store) return this.store
    const store = await readJson(this.profilesFile, { version: 1, profiles: {} })
    if (!store.profiles || typeof store.profiles !== 'object') store.profiles = {}
    this.store = store
    return store
  }

  async save() {
    await writeJson(this.profilesFile, this.store)
  }

  async ensureProfile(name) {
    const store = await this.load()
    const key = name || this.config.defaultProfile || 'default'
    if (!store.profiles[key]) {
      store.profiles[key] = {
        name: key,
        createdAt: nowIso(),
        proxy: this.config.proxy || '',
        locale: this.config.locale || 'zh-CN',
        timezone: this.config.timezone || '',
        userAgent: this.config.userAgent || '',
        viewport: this.config.viewport,
        headless: Boolean(this.config.headless),
      }
      await this.save()
    }
    return store.profiles[key]
  }

  async listProfiles() {
    const store = await this.load()
    const names = Object.keys(store.profiles)
    const rows = []
    for (const name of names) {
      const profile = await this.ensureProfile(name)
      const entry = this.entries.get(name)
      let loggedSites = []
      try {
        const state = await readJson(path.join(this.profileDir(name), 'state', 'logins.json'), { sites: {} })
        loggedSites = Object.entries(state.sites || {}).filter(([, item]) => item && item.loggedIn).map(([site]) => site)
      } catch {}
      rows.push({
        name,
        proxy: profile.proxy || '',
        headless: Boolean(profile.headless),
        running: Boolean(entry && entry.client && !entry.client.closed),
        browser: entry ? entry.browserVersion : '',
        dir: this.profileDir(name),
        loggedSites,
        lastUsedAt: profile.lastUsedAt || '',
      })
    }
    return rows
  }

  async updateProfile(name, patch) {
    const profile = await this.ensureProfile(name)
    Object.assign(profile, patch, { updatedAt: nowIso() })
    await this.save()
    const entry = this.entries.get(name)
    if (entry && (patch.proxy !== undefined || patch.headless !== undefined || patch.userAgent !== undefined)) {
      await entry.close()
      this.entries.delete(name)
    }
    return profile
  }

  async deleteProfile(name) {
    const entry = this.entries.get(name)
    if (entry) await entry.close()
    this.entries.delete(name)
    const store = await this.load()
    delete store.profiles[name]
    await this.save()
    await fs.rm(this.profileDir(name), { recursive: true, force: true })
  }

  async ensure(name, options) {
    const key = name || this.config.defaultProfile || 'default'
    if (this.opening.has(key)) return this.opening.get(key)
    const task = (async () => {
      const profile = await this.ensureProfile(key)
      let entry = this.entries.get(key)
      if (entry && entry.client && !entry.client.closed) return entry
      entry = new BrowserEntry(this, key, profile)
      this.entries.set(key, entry)
      await entry.launch(options || {})
      profile.lastUsedAt = nowIso()
      await this.save()
      return entry
    })().finally(() => this.opening.delete(key))
    this.opening.set(key, task)
    return task
  }

  async restartHeaded(name) {
    const key = name || this.config.defaultProfile || 'default'
    const entry = this.entries.get(key)
    if (entry && entry.client && !entry.client.closed && entry.headless !== true) return entry
    if (entry) {
      await entry.close()
      this.entries.delete(key)
    }
    const fresh = await this.ensure(key, { forceHeaded: true })
    return fresh
  }

  async close(name) {
    const key = name || this.config.defaultProfile || 'default'
    const entry = this.entries.get(key)
    if (!entry) return false
    await entry.close()
    this.entries.delete(key)
    return true
  }

  async closeAll() {
    for (const [name, entry] of this.entries) {
      await entry.close().catch(() => {})
      this.entries.delete(name)
    }
  }
}

/** 把 cookie 列表压成可移植的状态包。 */
export function portableState(cookies) {
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  }))
}

export { truncate, stamp }
