/**
 * dsh-browser-login —— 让 DSH 用你自己的浏览器（Chrome/Edge）浏览需要登录的站点。
 *
 * 设计要点：
 * 1. 真实用户 profile：每个 profile 是一个持久化的 Chrome user-data-dir，
 *    cookie / localStorage / IndexedDB / 设备信任凭证都留在磁盘上，
 *    因此「登录一次，以后接着用」是浏览器级行为，而不是伪造的指纹。
 * 2. 人工接管：遇到登录、扫码、验证码、二次验证时，工具会把窗口拉到前台并
 *    挂上提示条，等你在窗口里操作完，工具自动检测登录态并继续。
 * 3. 代理：profile 可单独配 --proxy-server，YouTube / X / Facebook 这类
 *    需要出网的站点用带代理的 profile 即可。
 *
 * 工具：browser_open / snapshot / click / type / press / scroll / read /
 *       eval / screenshot / tabs / login / login_status / handoff /
 *       profile / close
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { BrowserManager, portableState, resolveBrowserPath } from './browser.js'
import { resolveSite, siteFor, siteCatalog, SITES } from './sites.js'
import { detectLogin, waitForLogin, handoff as runHandoff, saveLoginState, hideBanner } from './login.js'
import { dshHome, nowIso, stamp, truncate, ensureDir, readJson, Mutex } from './util.js'

export const name = 'browser-login'
export const inject = ['tools']

const CONFIG_DEFAULTS = {
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
}

const PROFILE_DESC = '浏览器 profile 名（默认 default）。不同账号用不同 profile，登录态彼此隔离，可长期复用。'

/** 统一的结果条目 → 文本。 */
function renderValue(value) {
  if (typeof value.message === 'string' && value.message) return value.message
  if (typeof value.view === 'string') return value.view
  if (typeof value.text === 'string') return value.text
  return JSON.stringify(value, null, 2)
}

function registerTool(ctx, spec, locks) {
  const properties = spec.properties || {}
  const required = spec.required || []
  const definition = {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: Object.assign({ ok: { type: 'boolean' } }, spec.output || {}),
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: spec.timeoutMs,
    async execute(args, exec) {
      // 同一 profile 的浏览器操作排队执行：两个工具同时改 activeTargetId 会互相踩
      const key = String((args && args.profile) || spec.defaultProfile || 'default')
      if (!locks.has(key)) locks.set(key, new Mutex())
      const result = await locks.get(key).run(() => spec.run(args, exec))
      return Object.assign({ ok: true }, result)
    },
  }
  if (!spec.timeoutMs) delete definition.timeoutMs
  return ctx.tools.register(definition)
}

/** 页面摘要文本：URL / 标题 / 带编号的可见内容。 */
function pageSummary(profile, snapshot) {
  const head = 'profile: ' + profile + '\nURL: ' + snapshot.url + '\nTITLE: ' + snapshot.title
  return head + '\n\n' + snapshot.view
}

function requireRef(ref) {
  const value = Number(ref)
  if (!Number.isInteger(value) || value <= 0) throw new Error('ref 必须是 browser_snapshot 返回的编号（正整数）')
  return value
}

export function apply(ctx, config) {
  const settings = Object.assign({}, CONFIG_DEFAULTS, config || {})
  const manager = new BrowserManager(settings)
  const locks = new Map()
  const register = (spec) => registerTool(ctx, Object.assign({ defaultProfile: settings.defaultProfile }, spec), locks)

  const profile = (value) => (value && String(value).trim()) || settings.defaultProfile || 'default'

  register({
    name: 'browser_open',
    timeoutMs: 120000,
    description:
      '在持久化的浏览器 profile 里打开网址并返回页面快照。页面里的交互元素带 [编号]，后续用 browser_click / browser_type 按编号操作。' +
      '登录态保存在 profile 里，同一个页面第二次打开不需要重新登录。需要登录的站点先用 browser_login。',
    properties: {
      url: { type: 'string', description: '要打开的网址（含 https://）' },
      profile: { type: 'string', description: PROFILE_DESC },
      timeoutMs: { type: 'number', description: '等待页面加载的超时时间（毫秒），默认 60000' },
    },
    required: ['url'],
    output: {
      url: { type: 'string' },
      title: { type: 'string' },
      view: { type: 'string' },
      refs: { type: 'number' },
      message: { type: 'string' },
    },
    async run(args) {
      const entry = await manager.ensure(profile(args.profile))
      const page = await entry.goto(args.url, { timeoutMs: args.timeoutMs || 60000 })
      const snapshot = await entry.snapshot({ maxChars: settings.snapshotMaxChars, maxLines: settings.snapshotMaxLines })
      const url = await page.url()
      const view = truncate(snapshot.view, settings.snapshotMaxChars)
      const site = siteFor(url)
      const looksLikeLogin = /<input:password>/.test(view) || /(login|signin|sign_in|passport)/i.test(url)
      let hint = ''
      if (looksLikeLogin) {
        hint =
          '\n\n[提示] 这是登录/验证页面。需要人工登录时调用 browser_login' +
          (site ? '（site: ' + site.id + '）' : '（或用 url 参数指定登录页）') +
          '：会弹出窗口让你完成登录/扫码/验证码，成功后自动保存登录态。'
      }
      return {
        url,
        title: snapshot.title,
        view,
        refs: snapshot.refs,
        message: pageSummary(profile(args.profile), Object.assign({}, snapshot, { url })) + hint,
      }
    },
  })

  register({
    name: 'browser_snapshot',
    timeoutMs: 60000,
    description: '重新读取当前页面的快照（编号会刷新）。点击/输入之后、页面变化之后调用它获取最新编号。',
    properties: {
      profile: { type: 'string', description: PROFILE_DESC },
      maxChars: { type: 'number', description: '返回内容的最大字符数，默认跟随插件配置' },
    },
    required: [],
    output: {
      url: { type: 'string' },
      title: { type: 'string' },
      view: { type: 'string' },
      refs: { type: 'number' },
      truncated: { type: 'boolean' },
      message: { type: 'string' },
    },
    async run(args) {
      const entry = await manager.ensure(profile(args.profile))
      const snapshot = await entry.snapshot({ maxChars: args.maxChars || settings.snapshotMaxChars, maxLines: settings.snapshotMaxLines })
      const url = await entry.page().then((page) => page.url())
      return {
        url,
        title: snapshot.title,
        view: snapshot.view,
        refs: snapshot.refs,
        truncated: Boolean(snapshot.truncated),
        message: pageSummary(profile(args.profile), Object.assign({}, snapshot, { url })),
      }
    },
  })

  register({
    name: 'browser_click',
    timeoutMs: 90000,
    description: '按快照里的 [编号] 点击页面元素（真实鼠标事件）。如果点击打开了新标签页，会自动切换过去。',
    properties: {
      ref: { type: 'number', description: '快照里的元素编号' },
      profile: { type: 'string', description: PROFILE_DESC },
    },
    required: ['ref'],
    output: {
      url: { type: 'string' },
      title: { type: 'string' },
      view: { type: 'string' },
      refs: { type: 'number' },
      switched: { type: 'boolean' },
      message: { type: 'string' },
    },
    async run(args) {
      const entry = await manager.ensure(profile(args.profile))
      const before = await entry.listTargets().catch(() => [])
      const ids = before.map((info) => info.targetId)
      await entry.page().then((page) => page.click(requireRef(args.ref)))
      await new Promise((resolve) => setTimeout(resolve, 700))
      const switched = await entry.switchToNewestTab(ids)
      if (!switched) await entry.page().then((page) => page.waitReady(15000)).catch(() => {})
      const snapshot = await entry.snapshot({ maxChars: settings.snapshotMaxChars, maxLines: settings.snapshotMaxLines })
      const url = await entry.page().then((page) => page.url())
      return {
        url,
        title: snapshot.title,
        view: snapshot.view,
        refs: snapshot.refs,
        switched: Boolean(switched),
        message: pageSummary(profile(args.profile), Object.assign({}, snapshot, { url })),
      }
    },
  })

  register({
    name: 'browser_type',
    timeoutMs: 90000,
    description: '按快照编号把文本输入到输入框 / 可编辑区域。默认先清空原内容；submit=true 时输入后按回车。',
    properties: {
      ref: { type: 'number', description: '快照里的元素编号' },
      text: { type: 'string', description: '要输入的文本' },
      submit: { type: 'boolean', description: '输入后是否按回车提交，默认 false' },
      clear: { type: 'boolean', description: '是否先清空原内容，默认 true' },
      profile: { type: 'string', description: PROFILE_DESC },
    },
    required: ['ref', 'text'],
    output: {
      url: { type: 'string' },
      title: { type: 'string' },
      view: { type: 'string' },
      refs: { type: 'number' },
      message: { type: 'string' },
    },
    async run(args) {
      const entry = await manager.ensure(profile(args.profile))
      const page = await entry.page()
      await page.typeInto(requireRef(args.ref), args.text, { clear: args.clear !== false, submit: Boolean(args.submit) })
      await new Promise((resolve) => setTimeout(resolve, 500))
      await page.waitReady(15000).catch(() => {})
      const snapshot = await entry.snapshot({ maxChars: settings.snapshotMaxChars, maxLines: settings.snapshotMaxLines })
      const url = await page.url()
      return {
        url,
        title: snapshot.title,
        view: snapshot.view,
        refs: snapshot.refs,
        message: '已输入。\n\n' + pageSummary(profile(args.profile), Object.assign({}, snapshot, { url })),
      }
    },
  })

  register({
    name: 'browser_press',
    timeoutMs: 60000,
    description: '在当前焦点处按键：Enter / Tab / Escape / Backspace / ArrowDown / PageDown 等。用于提交搜索、翻页、关闭弹层。',
    properties: {
      key: { type: 'string', description: '按键名，如 Enter、Tab、Escape、PageDown' },
      profile: { type: 'string', description: PROFILE_DESC },
    },
    required: ['key'],
    output: {
      url: { type: 'string' },
      title: { type: 'string' },
      message: { type: 'string' },
    },
    async run(args) {
      const entry = await manager.ensure(profile(args.profile))
      const page = await entry.page()
      await page.press(args.key)
      await new Promise((resolve) => setTimeout(resolve, 600))
      await page.waitReady(15000).catch(() => {})
      return { url: await page.url(), title: await page.evaluate('document.title').catch(() => ''), message: '已按键 ' + args.key }
    },
  })

  register({
    name: 'browser_scroll',
    timeoutMs: 60000,
    description: '滚动页面（真实滚轮事件，能触发信息流的懒加载）。direction 支持 down/up/top/bottom，amount 是像素，默认 800。',
    properties: {
      direction: { type: 'string', description: 'down / up / top / bottom，默认 down' },
      amount: { type: 'number', description: '滚动像素，默认 800' },
      profile: { type: 'string', description: PROFILE_DESC },
    },
    required: [],
    output: {
      url: { type: 'string' },
      message: { type: 'string' },
    },
    async run(args) {
      const entry = await manager.ensure(profile(args.profile))
      const page = await entry.page()
      const direction = (args.direction || 'down').toLowerCase()
      const amount = args.amount || 800
      if (direction === 'top') await page.evaluate('window.scrollTo({ top: 0, behavior: "instant" })')
      else if (direction === 'bottom') await page.evaluate('window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" })')
      else await page.wheel(direction === 'up' ? -Math.abs(amount) : Math.abs(amount))
      await new Promise((resolve) => setTimeout(resolve, 600))
      return { url: await page.url(), message: '已滚动：' + direction }
    },
  })

  register({
    name: 'browser_read',
    timeoutMs: 60000,
    description: '提取当前页面的正文（去掉导航/页脚/脚本），适合读文章、帖子、视频简介。需要点击或看清结构时用 browser_snapshot。',
    properties: {
      profile: { type: 'string', description: PROFILE_DESC },
      maxChars: { type: 'number', description: '最大字符数，默认 20000' },
    },
    required: [],
    output: {
      url: { type: 'string' },
      title: { type: 'string' },
      text: { type: 'string' },
      truncated: { type: 'boolean' },
      message: { type: 'string' },
    },
    async run(args) {
      const entry = await manager.ensure(profile(args.profile))
      const page = await entry.page()
      const result = await page.read({ maxChars: args.maxChars || 20000 })
      return {
        url: result.url,
        title: result.title,
        text: result.text,
        truncated: Boolean(result.truncated),
        message: 'URL: ' + result.url + '\nTITLE: ' + result.title + '\n\n' + result.text,
      }
    },
  })

  register({
    name: 'browser_eval',
    timeoutMs: 60000,
    description: '在当前页面执行一段 JavaScript 并返回结果（JSON 字符串）。用于批量抓取页面数据，例如列表页里的标题/链接/点赞数。',
    properties: {
      expression: { type: 'string', description: '要执行的 JS 表达式；支持 Promise' },
      profile: { type: 'string', description: PROFILE_DESC },
    },
    required: ['expression'],
    output: {
      url: { type: 'string' },
      result: { type: 'string' },
      message: { type: 'string' },
    },
    async run(args) {
      const entry = await manager.ensure(profile(args.profile))
      const page = await entry.page()
      const value = await page.evaluate(args.expression, { timeoutMs: 45000 })
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      return { url: await page.url(), result: text, message: '执行结果：\n' + truncate(text || 'null', 20000) }
    },
  })

  register({
    name: 'browser_screenshot',
    timeoutMs: 60000,
    description: '对当前页面截图，返回 PNG 文件路径（可直接用 read_image 查看）。fullPage=true 截整页。',
    properties: {
      fullPage: { type: 'boolean', description: '是否截整页，默认 false' },
      path: { type: 'string', description: '保存路径，默认存到 profile 的 screenshots 目录' },
      profile: { type: 'string', description: PROFILE_DESC },
    },
    required: [],
    output: {
      path: { type: 'string' },
      bytes: { type: 'number' },
      message: { type: 'string' },
    },
    async run(args) {
      const name = profile(args.profile)
      const entry = await manager.ensure(name)
      const page = await entry.page()
      const data = await page.screenshot(Boolean(args.fullPage))
      const buffer = Buffer.from(data, 'base64')
      let target = args.path
      if (!target) {
        await ensureDir(entry.shotDir)
        target = path.join(entry.shotDir, 'shot-' + stamp() + '.png')
      } else {
        await ensureDir(path.dirname(path.resolve(target)))
      }
      await fs.writeFile(target, buffer)
      return { path: path.resolve(target), bytes: buffer.length, message: '截图已保存：' + path.resolve(target) }
    },
  })

  register({
    name: 'browser_tabs',
    timeoutMs: 60000,
    description: '列出 / 切换 / 关闭标签页。action=list 列出，action=switch 切到 index，action=close 关闭 index 并切回第一个。',
    properties: {
      action: { type: 'string', description: 'list / switch / close，默认 list' },
      index: { type: 'number', description: '标签页序号（从 0 开始），switch/close 时需要' },
      profile: { type: 'string', description: PROFILE_DESC },
    },
    required: [],
    output: {
      count: { type: 'number' },
      tabs: { type: 'string' },
      message: { type: 'string' },
    },
    async run(args) {
      const entry = await manager.ensure(profile(args.profile))
      const action = (args.action || 'list').toLowerCase()
      let tabs = await entry.tabs()
      if (action === 'switch') {
        if (typeof args.index !== 'number') throw new Error('switch 需要 index')
        await entry.switchTab(args.index)
        tabs = await entry.tabs()
      } else if (action === 'close') {
        if (typeof args.index !== 'number') throw new Error('close 需要 index')
        const tab = tabs[args.index]
        if (!tab) throw new Error('没有第 ' + args.index + ' 个标签页')
        await entry.client.send('Target.closeTarget', { targetId: tab.targetId })
        await new Promise((resolve) => setTimeout(resolve, 500))
        tabs = await entry.tabs()
        if (tabs.length) await entry.switchTab(0)
      }
      const text = tabs.map((tab, index) => '[' + index + '] ' + (tab.active ? '* ' : '  ') + tab.title + '\n    ' + tab.url).join('\n') || '(没有标签页)'
      return { count: tabs.length, tabs: text, message: '标签页（共 ' + tabs.length + ' 个）：\n' + text }
    },
  })

  register({
    name: 'browser_login',
    timeoutMs: 900000,
    description:
      '打开站点登录页，把浏览器窗口拉到前台交给你人工登录（账号密码 / 扫码 / 验证码 / 二次验证都在窗口里完成），' +
      '工具会轮询检测登录态，成功后保存 cookie 与设备状态到 profile。site 支持 bilibili/youtube/x/facebook/weibo/zhihu/reddit/instagram/douyin/xiaohongshu/github。' +
      '超时不算失败：窗口保持打开、cookie 已落盘，再调用一次会继续等待。',
    properties: {
      site: { type: 'string', description: '站点 id 或别名，如 bilibili、youtube、x、facebook' },
      url: { type: 'string', description: '直接给登录页/目标页 URL（与 site 二选一）' },
      profile: { type: 'string', description: PROFILE_DESC },
      timeoutMs: { type: 'number', description: '等待人工登录的毫秒数，默认 300000（5 分钟）' },
    },
    required: [],
    output: {
      status: { type: 'string' },
      site: { type: 'string' },
      account: { type: 'string' },
      url: { type: 'string' },
      profile: { type: 'string' },
      method: { type: 'string' },
      message: { type: 'string' },
    },
    async run(args, exec) {
      const name = profile(args.profile)
      const site = resolveSite(args.site) || siteFor(args.url || '')
      if (!site && !args.url) {
        throw new Error('请给 site（如 bilibili）或 url（登录页地址）。可用站点：' + siteCatalog().map((item) => item.id).join(', '))
      }
      // restartHeaded 会在需要时（无头 / 未启动）拉起带界面的浏览器
      const entry = await manager.restartHeaded(name)
      const target = args.url || site.login || site.home
      await entry.goto(target, { timeoutMs: 60000 })
      await entry.focusWindow()
      const timeoutMs = args.timeoutMs || settings.loginTimeoutMs
      const already = await detectLogin(entry, site)
      if (already.loggedIn) {
        const saved = await saveLoginState(entry, site, already)
        return {
          status: 'logged-in',
          site: site ? site.id : '',
          account: saved.account || already.account || '',
          url: already.url,
          profile: name,
          method: already.method,
          message:
            '已经是登录状态：' + (site ? site.name : already.url) + '（profile: ' + name + '，账号：' + (already.account || '未知') + '）。\n' +
            '不用再登录，直接 browser_open 打开目标页即可。',
        }
      }
      const outcome = await waitForLogin(entry, site, {
        timeoutMs,
        signal: exec.signal,
        banner: 'DSH 等你完成登录 / 验证（' + (site ? site.name : '当前页面') + '），完成后会自动继续',
      })
      if (outcome.status === 'logged-in') {
        return {
          status: 'logged-in',
          site: site ? site.id : '',
          account: outcome.detail.account || '',
          url: outcome.detail.url,
          profile: name,
          method: outcome.detail.method,
          message:
            '登录成功：' + (site ? site.name : outcome.detail.url) + '（profile: ' + name + '，账号：' + (outcome.detail.account || '已检测到登录 cookie') + '）。\n' +
            '登录态已保存到 ' + entry.dir + '，下次直接 browser_open 即可，无需重复登录。',
        }
      }
      return {
        status: outcome.status,
        site: site ? site.id : '',
        account: outcome.detail.account || '',
        url: outcome.detail.url || '',
        profile: name,
        method: outcome.detail.method || '',
        message:
          (outcome.status === 'canceled' ? '等待被取消。' : '等待超时，还没检测到登录成功。') +
          '\n浏览器窗口保持打开，当前 cookie 已保存到 profile "' + name + '"。' +
          '\n你可以在窗口里继续完成登录，然后再调用 browser_login_status 确认；或者再调用一次 browser_login 继续等待。',
      }
    },
  })

  register({
    name: 'browser_login_status',
    timeoutMs: 60000,
    description: '检测当前 profile 在某个站点上是否已登录（不打开新窗口、不等待）。',
    properties: {
      site: { type: 'string', description: '站点 id 或别名；省略则用当前页面判断' },
      profile: { type: 'string', description: PROFILE_DESC },
    },
    required: [],
    output: {
      status: { type: 'string' },
      site: { type: 'string' },
      account: { type: 'string' },
      url: { type: 'string' },
      message: { type: 'string' },
    },
    async run(args) {
      const name = profile(args.profile)
      const entry = await manager.ensure(name)
      const site = resolveSite(args.site) || null
      if (site) {
        const current = await entry.url().catch(() => '')
        const onSite = site.hosts.some((host) => current.includes(host))
        if (!onSite) await entry.goto(site.home, { timeoutMs: 45000 }).catch(() => {})
      }
      const detail = await detectLogin(entry, site)
      if (detail.loggedIn) await saveLoginState(entry, site, detail)
      const label = site ? site.name : detail.url
      return {
        status: detail.loggedIn ? 'logged-in' : 'logged-out',
        site: site ? site.id : '',
        account: detail.account || '',
        url: detail.url,
        message:
          (detail.loggedIn ? '已登录：' : '未登录：') + label +
          (detail.account ? '（账号：' + detail.account + '）' : '') +
          '\n判定方式：' + detail.method + '；profile：' + name,
      }
    },
  })

  register({
    name: 'browser_handoff',
    timeoutMs: 900000,
    description:
      '把当前页面交给你人工处理（滑块/验证码/手机确认/异常验证）。窗口顶部会出现提示条和「我已完成」按钮：' +
      '点按钮立即继续；不点的话，主页面跳转后静默 2.5 秒也会自动继续。reason 会显示在提示条里。',
    properties: {
      reason: { type: 'string', description: '需要你做什么，例如「完成滑块验证」' },
      timeoutMs: { type: 'number', description: '等待毫秒数，默认 600000（10 分钟）' },
      profile: { type: 'string', description: PROFILE_DESC },
    },
    required: [],
    output: {
      status: { type: 'string' },
      url: { type: 'string' },
      view: { type: 'string' },
      refs: { type: 'number' },
      message: { type: 'string' },
    },
    async run(args, exec) {
      const name = profile(args.profile)
      const entry = await manager.ensure(name)
      await entry.focusWindow()
      const outcome = await runHandoff(entry, {
        message: (args.reason ? args.reason + ' · ' : '') + '完成后点「我已完成」，或等页面自动跳转',
        timeoutMs: args.timeoutMs || settings.handoffTimeoutMs,
        signal: exec.signal,
      })
      const snapshot = await entry.snapshot({ maxChars: settings.snapshotMaxChars, maxLines: settings.snapshotMaxLines })
      return {
        status: outcome.status,
        url: snapshot.url,
        view: snapshot.view,
        refs: snapshot.refs,
        message:
          (outcome.status === 'resumed'
            ? '已恢复（' + (outcome.via === 'button' ? '你点了「我已完成」' : outcome.via === 'navigation' ? '检测到页面跳转' : '检测到验证码消失') + '），当前页面：'
            : outcome.status === 'timeout'
              ? '等待超时，当前页面：'
              : '已取消，当前页面：') +
          snapshot.url + '\n\n' + snapshot.view,
      }
    },
  })

  register({
    name: 'browser_profile',
    timeoutMs: 120000,
    description:
      '管理浏览器 profile：list 列出（含代理、是否运行、已登录站点），create 新建，remove 删除，set_proxy 设置代理，' +
      'show 查看详情，export 导出 cookie 包（可移植到别的机器），import 导入 cookie 包。' +
      '需要挂代理才能访问 YouTube / X / Facebook 时用 set_proxy，例如 socks5://127.0.0.1:7890。',
    properties: {
      action: { type: 'string', description: 'list / create / remove / set_proxy / show / export / import' },
      name: { type: 'string', description: 'profile 名，默认 default' },
      proxy: { type: 'string', description: '代理地址，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7890；空字符串表示直连' },
      file: { type: 'string', description: 'export 的导出路径 / import 的 cookie 包路径' },
    },
    required: ['action'],
    output: {
      message: { type: 'string' },
      profiles: { type: 'string' },
      count: { type: 'number' },
      dir: { type: 'string' },
    },
    async run(args) {
      const action = String(args.action || 'list').toLowerCase()
      if (action === 'list') {
        const rows = await manager.listProfiles()
        const text = rows
          .map((row) => '- ' + row.name + (row.running ? ' [运行中]' : '') + '\n    代理：' + (row.proxy || '直连') + '\n    已登录：' + (row.loggedSites.join(', ') || '无') + '\n    目录：' + row.dir)
          .join('\n')
        return { profiles: text, count: rows.length, message: '浏览器 profile（' + rows.length + ' 个）：\n' + (text || '(暂无)') }
      }
      const target = (args.name && String(args.name).trim()) || settings.defaultProfile
      if (action === 'create') {
        const profile = await manager.ensureProfile(target)
        if (args.proxy !== undefined) await manager.updateProfile(target, { proxy: args.proxy })
        return { dir: manager.profileDir(target), message: '已创建 profile "' + target + '"，目录：' + manager.profileDir(target), profiles: '', count: 1 }
      }
      if (action === 'remove') {
        await manager.deleteProfile(target)
        return { dir: manager.profileDir(target), message: '已删除 profile "' + target + '"（含 cookie 与登录态）', profiles: '', count: 0 }
      }
      if (action === 'set_proxy') {
        const proxy = args.proxy === undefined ? '' : String(args.proxy).trim()
        await manager.updateProfile(target, { proxy })
        return { dir: manager.profileDir(target), message: 'profile "' + target + '" 的代理已设为：' + (proxy || '直连') + '（下次启动浏览器生效）', profiles: '', count: 1 }
      }
      if (action === 'show') {
        const profile = await manager.ensureProfile(target)
        const state = await readJson(path.join(manager.profileDir(target), 'state', 'logins.json'), { sites: {} })
        const sites = Object.entries(state.sites || {})
          .map(([id, item]) => '- ' + id + '：' + (item.loggedIn ? '已登录' : '未登录') + (item.account ? '（' + item.account + '）' : '') + ' @ ' + (item.checkedAt || ''))
          .join('\n')
        return {
          dir: manager.profileDir(target),
          profiles: '',
          count: Object.keys(state.sites || {}).length,
          message:
            'profile：' + target + '\n目录：' + manager.profileDir(target) +
            '\n代理：' + (profile.proxy || '直连') + '\n无头：' + (profile.headless ? '是' : '否') +
            '\n登录记录：\n' + (sites || '(无)'),
        }
      }
      if (action === 'export') {
        const entry = await manager.ensure(target)
        const cookies = await entry.page().then((page) => page.cookies())
        const file = args.file || path.join(manager.profileDir(target), 'state', 'export-' + stamp() + '.json')
        await ensureDir(path.dirname(path.resolve(file)))
        await fs.writeFile(
          path.resolve(file),
          JSON.stringify({ exportedAt: nowIso(), profile: target, cookies: portableState(cookies) }, null, 2),
        )
        return { dir: manager.profileDir(target), profiles: '', count: cookies.length, message: '已导出 ' + cookies.length + ' 个 cookie 到：' + path.resolve(file) }
      }
      if (action === 'import') {
        if (!args.file) throw new Error('import 需要 file 参数（export 导出的 json）')
        const data = await readJson(path.resolve(args.file), null)
        if (!data || !Array.isArray(data.cookies)) throw new Error('cookie 包格式不对：需要 { cookies: [...] }')
        const entry = await manager.ensure(target)
        const page = await entry.page()
        await page.setCookies(data.cookies)
        return { dir: manager.profileDir(target), profiles: '', count: data.cookies.length, message: '已导入 ' + data.cookies.length + ' 个 cookie 到 profile "' + target + '"' }
      }
      throw new Error('未知 action：' + action + '（支持 list/create/remove/set_proxy/show/export/import）')
    },
  })

  register({
    name: 'browser_close',
    timeoutMs: 30000,
    description: '关闭某个 profile 的浏览器实例（cookie 与登录态已保存在磁盘上，不会丢）。',
    properties: {
      profile: { type: 'string', description: PROFILE_DESC },
    },
    required: [],
    output: {
      closed: { type: 'boolean' },
      message: { type: 'string' },
    },
    async run(args) {
      const name = profile(args.profile)
      const closed = await manager.close(name)
      return { closed, message: closed ? '已关闭 profile "' + name + '" 的浏览器。' : 'profile "' + name + '" 当前没有运行中的浏览器。' }
    },
  })

  // 给模型一段使用说明（systemPrompt 服务存在时才注册）。
  try {
    const systemPrompt = ctx.get ? ctx.get('systemPrompt') : undefined
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      const order = typeof systemPrompt.getSectionOrder === 'function' ? systemPrompt.getSectionOrder('TOOL_WEB_FETCH') : 900
      systemPrompt.section({
        name: 'tool:browser-login',
        order: Number.isFinite(order) ? order + 1 : 901,
        text: () =>
          'browser_* 工具操作的是用户本机一个持久化的 Chrome profile，登录态与设备状态都保存在其中。' +
          '工作流：browser_open 打开页面 → browser_snapshot 拿带编号的元素 → browser_click/browser_type 操作 → 页面变化后重新 snapshot。' +
          '遇到登录墙、验证码、二次验证时，用 browser_login 或 browser_handoff 把窗口交给用户，等它返回后继续；不要把账号密码或验证码写进工具参数。' +
          'YouTube / X / Facebook 等站点需要代理时，先 browser_profile set_proxy 给 profile 配代理。' +
          '抓取列表数据优先用 browser_eval 一次性取回，比逐条点击省时间。',
      })
    }
  } catch {}

  ctx.effect(() => async () => {
    if (settings.closeOnDispose) await manager.closeAll().catch(() => {})
  }, 'browser-login: dispose')
}

export { SITES, siteCatalog }
