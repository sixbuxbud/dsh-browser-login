import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { BrowserManager } from '../lib/browser.js'
import { detectLogin, saveLoginState, handoff } from '../lib/login.js'
import { siteFor } from '../lib/sites.js'
import { connectWebSocket } from '../lib/ws.js'

const CHROME = process.env.DSH_BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

function startFixture() {
  const state = { users: new Map() }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const cookie = req.headers.cookie || ''
    const session = /sid=([^;]+)/.exec(cookie)?.[1] || ''
    const user = state.users.get(session) || ''
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><head><title>Fixture Home</title></head><body>' +
          '<h1>Fixture 站点</h1>' +
          (user
            ? '<p id="status">已登录 ' + user + '</p><a href="/feed">打开信息流</a>'
            : '<p id="status">未登录</p><a id="login" href="/login">登录</a>') +
          '</body></html>',
      )
      return
    }
    if (url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><head><title>登录</title></head><body>' +
          '<h1>请登录</h1><form method="post" action="/api/login">' +
          '<label>用户名 <input id="u" name="u" placeholder="用户名"></label>' +
          '<label>密码 <input id="p" name="p" type="password" placeholder="密码"></label>' +
          '<button id="go" type="submit">提交</button>' +
          '</form></body></html>',
      )
      return
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const params = new URLSearchParams(body)
        const token = 'tok-' + Math.random().toString(36).slice(2)
        state.users.set(token, params.get('u') || 'anon')
        res.writeHead(302, { 'set-cookie': 'sid=' + token + '; Path=/; HttpOnly', location: '/' })
        res.end()
      })
      return
    }
    if (url.pathname === '/two') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><head><title>两个按钮</title></head><body>' +
          '<button id="a" onclick="document.getElementById(\'log\').textContent=\'a\'">AAA</button>' +
          '<button id="b" onclick="document.getElementById(\'log\').textContent=\'b\'">BBB</button>' +
          '<div id="log"></div>' +
          '</body></html>',
      )
      return
    }
    if (url.pathname === '/hiframe') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><head><title>handoff</title></head><body>' +
          '<h1>请完成验证</h1><iframe id="f" src="/frame"></iframe>' +
          '<script>setInterval(function(){document.getElementById("f").src="/frame?t="+Date.now()},500)</script>' +
          '</body></html>',
      )
      return
    }
    if (url.pathname === '/redirect') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>跳转</title><body><p>验证中</p><script>setTimeout(function(){location.href="/done"},1500)</script></body>')
      return
    }
    if (url.pathname === '/done') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>完成</title><body><h1>验证完成</h1></body>')
      return
    }
    if (url.pathname === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body>frame</body></html>')
      return
    }
    if (url.pathname === '/paragraphs') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>段落</title></head><body><main><p>第一段</p><p>第二段</p></main></body></html>')
      return
    }
    if (url.pathname === '/feed') {
      const items = Array.from({ length: 30 }, (_, i) => '<li class="item">条目 ' + (i + 1) + ' 内容</li>').join('')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>信息流</title></head><body><h1>信息流</h1><ul>' + items + '</ul></body></html>')
      return
    }
    res.writeHead(404).end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, base: 'http://127.0.0.1:' + port })
    })
  })
}

function refsOf(view, pattern) {
  return [...view.matchAll(pattern)].map((match) => ({ ref: Number(match[1]), text: match[0] }))
}

export async function runE2E() {
  const { server, base } = await startFixture()
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Temp', 'dsh-browser-login-e2e-' + Date.now())
  const checks = []
  const check = (name, condition, detail) => {
    checks.push({ name, ok: Boolean(condition), detail })
    if (!condition) throw new Error('FAIL ' + name + (detail ? '：' + detail : ''))
  }
  const manager = new BrowserManager({
    profilesDir: root,
    headless: true,
    defaultProfile: 'e2e',
    browserPath: CHROME,
    settleMs: 200,
  })
  try {
    const entry = await manager.ensure('e2e')
    check('浏览器启动', Boolean(entry.browserVersion), entry.browserVersion)

    await entry.goto(base + '/')
    let snapshot = await entry.snapshot({})
    check('首页快照含未登录状态', snapshot.view.includes('未登录'), snapshot.view.slice(0, 200))
    const loginRef = refsOf(snapshot.view, /\[(\d+)\] <link> "登录"/g)[0]
    check('快照里能找到登录链接编号', Boolean(loginRef), snapshot.view)

    await entry.page().then((page) => page.click(loginRef.ref))
    await new Promise((resolve) => setTimeout(resolve, 900))
    let page = await entry.page()
    check('点击后进入登录页', (await page.url()).endsWith('/login'), await page.url())

    const loginPage = await entry.snapshot({})
    const userRef = refsOf(loginPage.view, /\[(\d+)\] <input:text> "用户名"/g)[0]
    const passRef = refsOf(loginPage.view, /\[(\d+)\] <input:password> "密码"/g)[0]
    const submitRef = refsOf(loginPage.view, /\[(\d+)\] <button> "提交"/g)[0]
    check('登录表单三个控件都有编号', Boolean(userRef && passRef && submitRef), loginPage.view)

    await page.typeInto(userRef.ref, 'alice')
    await page.typeInto(passRef.ref, 'secret')
    await page.click(submitRef.ref)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    page = await entry.page()
    check('提交后回到首页', (await page.url()) === base + '/', await page.url())
    check('页面显示已登录 alice', (await page.evaluate('document.querySelector("#status").textContent')) === '已登录 alice')

    const detail = await detectLogin(entry, null)
    check('detectLogin 判定已登录', detail.loggedIn, JSON.stringify(detail))
    await saveLoginState(entry, null, detail)
    const stateFile = path.join(root, 'e2e', 'state', 'cookies.json')
    const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    check('cookie 已落盘', saved.cookies.some((cookie) => cookie.name === 'sid'), stateFile)

    const shotPath = path.join(root, 'shot.png')
    const data = await page.screenshot(false)
    await fs.writeFile(shotPath, Buffer.from(data, 'base64'))
    const stat = await fs.stat(shotPath)
    check('截图已生成', stat.size > 1000, String(stat.size))

    await entry.goto(base + '/feed')
    const count = await page.evaluate('document.querySelectorAll(".item").length')
    check('信息流条目数正确', count === 30, String(count))
    await page.wheel(1200)
    await new Promise((resolve) => setTimeout(resolve, 400))

    // 用原始 WebSocket 实现再连一次，验证无全局 WebSocket 时的回退路径
    const nativeWs = globalThis.WebSocket
    globalThis.WebSocket = undefined
    try {
      const port = await entry.readPort()
      const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json()
      const transport = await connectWebSocket(version.webSocketDebuggerUrl)
      await transport.ready
      const reply = await new Promise((resolve) => {
        transport.on('message', (text) => resolve(JSON.parse(text)))
        transport.send(JSON.stringify({ id: 1, method: 'Browser.getVersion', params: {} }))
      })
      check('回退 WebSocket 可用', Boolean(reply.result && reply.result.product), JSON.stringify(reply).slice(0, 120))
      transport.close()
    } finally {
      globalThis.WebSocket = nativeWs
    }

    // 审查 bug 1：隐藏元素后重新快照，编号必须指向新元素
    await entry.goto(base + '/two')
    const first = await entry.snapshot({})
    check('两个按钮都进入快照', first.view.includes('AAA') && first.view.includes('BBB'), first.view)
    await entry.page().then((page) => page.evaluate('document.getElementById("a").style.display="none"'))
    const second = await entry.snapshot({})
    const bbbRef = Number(/\[(\d+)\] <button> "BBB"/.exec(second.view)[1])
    await entry.page().then((page) => page.click(bbbRef))
    await new Promise((resolve) => setTimeout(resolve, 400))
    const log = await entry.page().then((page) => page.evaluate('document.getElementById("log").textContent'))
    check('隐藏旧元素后点击编号命中新元素', log === 'b', 'log=' + log)

    // 审查 bug 2：iframe 持续自导航不应拖住 handoff；点「我已完成」立即恢复
    await entry.goto(base + '/hiframe')
    const started = Date.now()
    const handoffPromise = handoff(entry, { message: '请完成验证', timeoutMs: 12000 })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    await entry.page().then((page) =>
      page.evaluate(
        '(function(){ var b = document.getElementById("dsh-handoff-banner"); if (b && b.shadowRoot) { var btn = b.shadowRoot.querySelector("button"); if (btn) btn.click(); } })()',
      ),
    )
    const outcome = await handoffPromise
    const elapsed = Date.now() - started
    check('handoff 点按钮后立即恢复', outcome.status === 'resumed' && outcome.via === 'button', JSON.stringify(outcome))
    check('handoff 不再被 iframe 导航拖到超时', elapsed < 6000, elapsed + 'ms')

    // 主框架跳转这条路径仍然有效
    await entry.goto(base + '/redirect')
    const navStarted = Date.now()
    const navOutcome = await handoff(entry, { message: '等页面跳转', timeoutMs: 10000 })
    check('handoff 能识别主框架跳转', navOutcome.status === 'resumed' && navOutcome.via === 'navigation', JSON.stringify(navOutcome))
    check('主框架跳转判定不拖太久', Date.now() - navStarted < 8000, Date.now() - navStarted + 'ms')

    // 审查：host 精确匹配，netflix.com / box.com 不能被当成 X
    check('netflix.com 不归属 X', siteFor('https://www.netflix.com/') === null)
    check('x.com 仍归属 X', siteFor('https://x.com/home')?.id === 'x')

    // 审查：readInPage 保留段落换行
    await entry.goto(base + '/paragraphs')
    const readResult = await entry.read({})
    check('正文保留段落换行', readResult.text.includes('第一段\n第二段') || readResult.text.includes('第一段\n\n第二段'), JSON.stringify(readResult.text))

    await entry.close()
    const revived = await manager.ensure('e2e')
    check('重启浏览器', Boolean(revived.browserVersion))
    await revived.goto(base + '/')
    const status = await revived.page().then((item) => item.evaluate('document.querySelector("#status").textContent'))
    check('重启后仍是登录态', status === '已登录 alice', status)
    await revived.close()
    return { ok: true, checks, root }
  } finally {
    await manager.closeAll().catch(() => {})
    server.close()
  }
}

if (import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/')) {
  runE2E()
    .then((result) => {
      console.log('E2E PASS（' + result.checks.length + ' 项检查）')
      for (const item of result.checks) console.log('  ✓ ' + item.name + (item.detail ? '：' + item.detail : ''))
      console.log('隔离目录：' + result.root)
    })
    .catch((error) => {
      console.error('E2E FAIL：' + error.message)
      process.exitCode = 1
    })
}
