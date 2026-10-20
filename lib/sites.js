/**
 * 站点清单：登录页、登录态判定方式（cookie / 页面探针）。
 *
 * cookie 判定是主力：各站点登录后都会下发可长期复用的凭证 cookie，
 * 这类 cookie 与设备/IP 绑定，保存在持久化 profile 里就能「继续上次的登录」。
 * 页面探针只是补充，用来拿到账号名，以及应对个别站点改 cookie 名的情况。
 */
export const SITES = {
  bilibili: {
    id: 'bilibili',
    name: '哔哩哔哩',
    hosts: ['bilibili.com', 'b23.tv', 'biliapi.net'],
    home: 'https://www.bilibili.com/',
    login: 'https://passport.bilibili.com/login',
    cookies: ['SESSDATA'],
    accountCookies: ['DedeUserID'],
    probe: "(async () => { try { const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }); const j = await r.json(); const d = (j && j.data) || {}; return { loggedIn: !!d.isLogin, account: d.uname || '' }; } catch (e) { return { loggedIn: false, account: '' }; } })()",
    dom: ['a[href*="message.bilibili.com"]', '.header-avatar-wrap'],
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    hosts: ['youtube.com', 'youtu.be', 'accounts.google.com'],
    home: 'https://www.youtube.com/',
    login: 'https://accounts.google.com/ServiceLogin?service=youtube',
    cookies: ['SID', 'SAPISID', '__Secure-3PSID', 'LOGIN_INFO'],
    probe: "(() => { try { var cfg = window.ytcfg; var logged = !!(cfg && cfg.get && cfg.get('LOGGED_IN')); var btn = document.querySelector('#avatar-btn, ytd-topbar-menu-button-renderer button'); var nameEl = document.querySelector('yt-formatted-string#account-name, #account-name'); return { loggedIn: logged || !!btn, account: nameEl ? nameEl.textContent.trim() : '' }; } catch (e) { return { loggedIn: false, account: '' }; } })()",
    dom: ['#avatar-btn', 'ytd-topbar-menu-button-renderer'],
  },
  x: {
    id: 'x',
    name: 'X (Twitter)',
    hosts: ['x.com', 'twitter.com'],
    home: 'https://x.com/home',
    login: 'https://x.com/i/flow/login',
    cookies: ['auth_token'],
    probe: "(() => { var el = document.querySelector('[data-testid=\"SideNav_AccountSwitcher_Button\"]'); var nameEl = document.querySelector('[data-testid=\"SideNav_AccountSwitcher_Button\"] [dir=\"ltr\"] span'); return { loggedIn: !!el, account: nameEl ? nameEl.textContent.trim() : '' }; })()",
    dom: ['[data-testid="SideNav_AccountSwitcher_Button"]', '[data-testid="AppTabBar_Profile_Link"]'],
  },
  facebook: {
    id: 'facebook',
    name: 'Facebook',
    hosts: ['facebook.com', 'fb.com', 'm.facebook.com'],
    home: 'https://www.facebook.com/',
    login: 'https://www.facebook.com/login',
    cookies: ['c_user', 'xs'],
    probe: "(() => { var link = document.querySelector('a[href*=\"/me/\"], [aria-label=\"Your profile\"], [aria-label=\"你的个人主页\"]'); return { loggedIn: !!link, account: (document.title || '').replace(/\\s*\\|.*$/, '').trim() }; })()",
    dom: ['[aria-label="Your profile"]', 'a[href*="/me/"]'],
  },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    hosts: ['instagram.com'],
    home: 'https://www.instagram.com/',
    login: 'https://www.instagram.com/accounts/login/',
    cookies: ['sessionid'],
    probe: "(() => { var el = document.querySelector('a[href*=\"/direct/inbox/\"], img[alt*=\"profile picture\"]'); return { loggedIn: !!el, account: '' }; })()",
    dom: ['a[href*="/direct/inbox/"]'],
  },
  weibo: {
    id: 'weibo',
    name: '微博',
    hosts: ['weibo.com', 'weibo.cn'],
    home: 'https://weibo.com/',
    login: 'https://weibo.com/login.php',
    cookies: ['SUB', 'SUBP'],
    probe: "(() => { var el = document.querySelector('.gn_name, .woo-avatar'); return { loggedIn: !!el, account: (el && el.textContent ? el.textContent.trim() : '') }; })()",
    dom: ['.gn_name', '.woo-avatar'],
  },
  zhihu: {
    id: 'zhihu',
    name: '知乎',
    hosts: ['zhihu.com'],
    home: 'https://www.zhihu.com/',
    login: 'https://www.zhihu.com/signin',
    cookies: ['z_c0'],
    probe: "(() => { var el = document.querySelector('.AppHeader-profile, .Avatar--user'); return { loggedIn: !!el, account: '' }; })()",
    dom: ['.AppHeader-profile'],
  },
  reddit: {
    id: 'reddit',
    name: 'Reddit',
    hosts: ['reddit.com'],
    home: 'https://www.reddit.com/',
    login: 'https://www.reddit.com/login/',
    cookies: ['reddit_session'],
    probe: "(() => ({ loggedIn: !!document.querySelector('#expand-user-drawer-button, [data-testid=\"user-drawer-button\"], faceplate-tracker[noun=\"profile\"]'), account: '' }))()",
    dom: ['#expand-user-drawer-button'],
  },
  douyin: {
    id: 'douyin',
    name: '抖音',
    hosts: ['douyin.com'],
    home: 'https://www.douyin.com/',
    login: 'https://www.douyin.com/',
    cookies: ['sessionid', 'sessionid_ss'],
    probe: "(() => ({ loggedIn: !!document.querySelector('[data-e2e=\"user-avatar\"], .avatar'), account: '' }))()",
    dom: ['[data-e2e="user-avatar"]'],
  },
  xiaohongshu: {
    id: 'xiaohongshu',
    name: '小红书',
    hosts: ['xiaohongshu.com'],
    home: 'https://www.xiaohongshu.com/',
    login: 'https://www.xiaohongshu.com/login',
    cookies: ['web_session'],
    probe: "(() => ({ loggedIn: !!document.querySelector('.user, .side-bar .user'), account: '' }))()",
    dom: ['.side-bar .user'],
  },
  github: {
    id: 'github',
    name: 'GitHub',
    hosts: ['github.com'],
    home: 'https://github.com/',
    login: 'https://github.com/login',
    cookies: ['user_session', '__Host-user_session_same_site'],
    probe: "(() => { var el = document.querySelector('summary[aria-label*=\"View profile\"], .Header-link .avatar'); return { loggedIn: !!el, account: (document.querySelector('.Header-link .p-nickname') || {}).textContent || '' }; })()",
    dom: ['summary[aria-label*="View profile"]'],
  },
}

export const SITE_ALIASES = {
  b站: 'bilibili',
  '哔哩哔哩': 'bilibili',
  bili: 'bilibili',
  yt: 'youtube',
  油管: 'youtube',
  twitter: 'x',
  推特: 'x',
  fb: 'facebook',
  脸书: 'facebook',
  ins: 'instagram',
  ig: 'instagram',
  微博: 'weibo',
  知乎: 'zhihu',
  红迪: 'reddit',
  抖音: 'douyin',
  小红书: 'xiaohongshu',
  gh: 'github',
}

/** 依据 URL 归属站点。 */
export function siteFor(url) {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  for (const site of Object.values(SITES)) {
    if (site.hosts.some((item) => host === item || host.endsWith('.' + item))) return site
  }
  return null
}

/** 把用户给的站点名（中英文/别名）解析成站点 id。 */
export function resolveSite(name) {
  if (!name) return null
  const raw = String(name).trim().toLowerCase()
  if (SITES[raw]) return SITES[raw]
  const alias = SITE_ALIASES[raw]
  if (alias && SITES[alias]) return SITES[alias]
  for (const site of Object.values(SITES)) {
    if (site.name.toLowerCase() === raw) return site
    if (site.hosts.some((host) => raw === host || raw.endsWith('.' + host))) return site
  }
  return null
}

/** 站点列表，供工具描述与 browser_profile 输出使用。 */
export function siteCatalog() {
  return Object.values(SITES).map((site) => ({
    id: site.id,
    name: site.name,
    home: site.home,
    login: site.login,
    cookie: site.cookies.join('/'),
  }))
}
