import path from 'node:path'
import fs from 'node:fs/promises'
import { sleep, writeJson, readJson, ensureDir, nowIso } from './util.js'
import { handoffBannerInPage, clearBannerInPage } from './snapshot.js'
import { portableState } from './browser.js'

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function domainMatches(cookieDomain, site) {
  const domain = String(cookieDomain || '').replace(/^\./, '').toLowerCase()
  if (!domain) return false
  return site.hosts.some((host) => domain === host || domain.endsWith('.' + host) || host.endsWith('.' + domain))
}

/**
 * 判断当前页面是否已登录。
 * 顺序：站点探针（能拿到账号名）→ 登录 cookie（最可靠）→ DOM 兜底。
 */
export async function detectLogin(entry, site) {
  const page = await entry.page()
  const url = await page.url().catch(() => '')
  let probe = null
  if (site && site.probe) {
    try {
      probe = await page.evaluate(site.probe, { timeoutMs: 12000 })
    } catch {}
  }
  let cookies = []
  try {
    cookies = await page.cookies()
  } catch {}
  const matched = site
    ? cookies.filter((cookie) => site.cookies.includes(cookie.name) && domainMatches(cookie.domain, site))
    : []
  let domHit = false
  if (!probe || !probe.loggedIn) {
    if (site && site.dom && site.dom.length) {
      const expression = '[' + site.dom.map((selector) => 'document.querySelector(' + JSON.stringify(selector) + ')').join(',') + '].some(Boolean)'
      try {
        domHit = Boolean(await page.evaluate(expression, { timeoutMs: 8000 }))
      } catch {}
    }
  }
  if (!site) {
    let password = false
    try {
      password = Boolean(await page.evaluate('!!document.querySelector("input[type=password]")', { timeoutMs: 5000 }))
    } catch {}
    const loggedIn = cookies.length > 0 && !password && !/login|signin|passport/i.test(url)
    return {
      loggedIn,
      account: '',
      url,
      cookies: cookies.length,
      method: loggedIn ? 'cookies' : 'none',
    }
  }
  const loggedIn = Boolean((probe && probe.loggedIn) || matched.length > 0 || domHit)
  return {
    loggedIn,
    account: (probe && probe.account) || '',
    url,
    cookies: cookies.length,
    matched: matched.map((cookie) => cookie.name),
    method: probe && probe.loggedIn ? 'probe' : matched.length ? 'cookie' : domHit ? 'dom' : 'none',
  }
}

/** 登录成功后把状态落盘：站点记录 + 可移植 cookie 包。 */
export async function saveLoginState(entry, site, detail) {
  await ensureDir(entry.stateDir)
  const file = path.join(entry.stateDir, 'logins.json')
  const state = await readJson(file, { sites: {} })
  state.sites = state.sites || {}
  const key = site ? site.id : hostOf(detail.url) || 'generic'
  state.sites[key] = {
    loggedIn: Boolean(detail.loggedIn),
    account: detail.account || '',
    url: detail.url || '',
    method: detail.method || '',
    checkedAt: nowIso(),
  }
  state.updatedAt = nowIso()
  await writeJson(file, state)
  let cookies = []
  try {
    const page = await entry.page()
    cookies = await page.cookies()
  } catch {}
  if (cookies.length) {
    const portable = portableState(cookies)
    await writeJson(path.join(entry.stateDir, 'cookies.json'), { savedAt: nowIso(), cookies: portable })
    if (site) {
      const subset = portable.filter((cookie) => domainMatches(cookie.domain, site))
      await writeJson(path.join(entry.stateDir, 'cookies-' + site.id + '.json'), { savedAt: nowIso(), cookies: subset })
    }
  }
  return state.sites[key]
}

/** 注入「请人工完成登录/验证」提示条；页面跳转后会自动补注。 */
export async function showBanner(entry, message, options) {
  try {
    const page = await entry.page()
    const button = !(options && options.button === false)
    await page.evaluate('(' + handoffBannerInPage.toString() + ')(' + JSON.stringify(message) + ',' + JSON.stringify(button) + ')', {
      timeoutMs: 5000,
    })
  } catch {}
}

export async function hideBanner(entry) {
  try {
    const page = await entry.page()
    await page.evaluate('(' + clearBannerInPage.toString() + ')()', { timeoutMs: 5000 })
  } catch {}
}

/**
 * 等人工完成登录：每 1.5s 检测一次，登录成功立即返回；超时返回 pending，
 * 浏览器窗口保持打开，profile 里的 cookie 也保留，下次调用可继续。
 */
export async function waitForLogin(entry, site, options) {
  const opts = options || {}
  const timeoutMs = opts.timeoutMs || 300000
  const signal = opts.signal
  const deadline = Date.now() + timeoutMs
  let last = { loggedIn: false }
  let lastUrl = ''
  let ticks = 0
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return { status: 'canceled', detail: last }
    last = await detectLogin(entry, site)
    if (last.loggedIn) {
      await saveLoginState(entry, site, last)
      await hideBanner(entry)
      return { status: 'logged-in', detail: last }
    }
    if (last.url && last.url !== lastUrl) {
      lastUrl = last.url
      await showBanner(entry, opts.banner || 'DSH 正在等待你完成登录 / 验证，完成后会自动继续', { button: false })
    }
    ticks += 1
    if (opts.onTick) {
      try { opts.onTick(ticks, last) } catch {}
    }
    await sleep(1500)
  }
  const final = await detectLogin(entry, site).catch(() => last)
  if (final.loggedIn) {
    await saveLoginState(entry, site, final)
    await hideBanner(entry)
    return { status: 'logged-in', detail: final }
  }
  await saveLoginState(entry, site, final)
  return { status: 'pending', detail: final }
}

/**
 * 中途人工接管（验证码 / 二次验证 / 设备确认）：
 * 等页面完成一次导航并稳定下来，或者超时。
 */
export async function handoff(entry, options) {
  const opts = options || {}
  const timeoutMs = opts.timeoutMs || 600000
  const signal = opts.signal
  const page = await entry.page()
  const startUrl = await page.url().catch(() => '')
  let navigations = 0
  // 只认主框架导航。广告 / 埋点 iframe 每几百毫秒自导航一次，
  // 旧逻辑会把静默计时器无限重置，handoff 永远等到超时（审查 bug 2）。
  const off = entry.client
    ? entry.client.on('Page.frameNavigated', (params) => {
        if (params && params.frame && params.frame.parentId) return
        navigations += 1
      })
    : () => {}
  const challengeSelector =
    'iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="arkose"], iframe[src*="hcaptcha"], #nc_1_wrapper, .nc-container, .geetest_panel, [class*="captcha"], [id*="captcha"], [data-testid*="challenge"]'
  const countChallenges = () =>
    page.evaluate('document.querySelectorAll(' + JSON.stringify(challengeSelector) + ').length', { timeoutMs: 5000 }).catch(() => 0)
  const baselineChallenges = await countChallenges()
  const bannerText = opts.message || '需要你手动完成验证，完成后点「我已完成」或等页面跳转'
  await page.evaluate('window.__dshHandoffDone = false').catch(() => {})
  await showBanner(entry, bannerText)
  const deadline = Date.now() + timeoutMs
  let lastNav = Date.now()
  let last = navigations
  let lastChallenge = baselineChallenges
  let challengeClearedAt = 0

  const finish = async (via, url) => {
    await hideBanner(entry)
    return { status: 'resumed', via, url, navigations }
  }

  try {
    while (Date.now() < deadline) {
      if (signal && signal.aborted) return { status: 'canceled', url: await page.url().catch(() => startUrl) }
      // 1) 用户点「我已完成」——最可靠的信号，先查它
      const done = await page.evaluate('window.__dshHandoffDone === true', { timeoutMs: 5000 }).catch(() => false)
      const url = await page.url().catch(() => '')
      if (done) return await finish('button', url)
      if (navigations !== last) {
        last = navigations
        lastNav = Date.now()
        // 主框架跳转后 banner 会被冲掉，补一张（用户还能再点按钮）
        await showBanner(entry, bannerText).catch(() => {})
      }
      // 2) 验证码 / 挑战元素消失
      const challenges = await countChallenges()
      if (challenges !== lastChallenge) {
        lastChallenge = challenges
        if (baselineChallenges > 0 && challenges === 0) challengeClearedAt = Date.now()
      }
      // 3) 主框架导航后静默 2.5 秒
      const navigated = Date.now() - lastNav > 2500 && (navigations > 0 || url !== startUrl)
      const cleared = challengeClearedAt > 0 && Date.now() - challengeClearedAt > 1500
      if (navigated) return await finish('navigation', url)
      if (cleared) return await finish('challenge-cleared', url)
      await sleep(700)
    }
    return { status: 'timeout', url: await page.url().catch(() => startUrl), navigations, challenges: lastChallenge }
  } finally {
    off()
  }
}

export { hostOf, domainMatches }
