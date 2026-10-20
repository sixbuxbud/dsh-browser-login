# dsh-browser-login

让 DeepSeek Harness 用**你自己的 Chrome/Edge**去浏览需要登录的站点：B 站、YouTube、X、Facebook、微博、知乎、小红书、抖音、Instagram、Reddit、GitHub……

不是无头爬虫、不是伪造 UA 的 HTTP 请求，而是一个**持久化的真实浏览器 profile**：你在窗口里登录一次，cookie、localStorage、设备信任凭证都留在磁盘上，之后 DSH 直接接着用。遇到验证码、扫码、二次验证，工具会把窗口拉到前台交给你，你操作完它自己检测到登录态并继续。

---

## 它解决什么

| 痛点 | 这个插件的做法 |
| --- | --- |
| 社交站点都要登录才能看内容 | 持久化 profile，登录一次长期有效 |
| 登录要扫码 / 验证码 / 二次验证 | 弹出真实窗口，人工完成后自动继续 |
| 无头浏览器被风控识别 | 默认带界面运行，关掉 AutomationControlled 特征 |
| YouTube / X / Facebook 要出网 | 每个 profile 可单独配 HTTP / SOCKS5 代理 |
| 登录态丢了要重新登 | cookie 与设备状态双份落盘，重启浏览器/重启 DSH 都能恢复 |
| 让模型点来点去很慢 | `browser_eval` 一次取回整页结构化数据 |

---

## 和日常 Chrome 的关系

插件用的是**独立的 user-data-dir**（`~/.dsh/browser-profiles/<name>/chrome`），**不接管**你平时双击打开的那个 Chrome：

- 不影响日常浏览，不会互相踢下线，不同账号可以各建一个 profile；
- 代价是：所有站点都要在这个 profile 里**重新登录一次**，不能直接继承你日常 Chrome 已登录的状态；
- 登录一次之后长期有效，这也是它能「保存设备状态继续用」的前提。

---

## 安装

包就在当前目录，装进 DSH 的 profile 即可（默认 `~/.dsh/profiles/desktop`）：

```powershell
node scripts/install.mjs
```

脚本会做三件事：把本包以 `link:` 方式写进 profile 的 `package.json`、把 `dsh-browser-login` 加进 `dsh.profile.bundles`、在 profile 的 `node_modules` 下建一个目录联接。然后**重启 DSH**，在「插件」页能看到 `browser-login` 这一行。

也可以手动装：

```powershell
# 1) profile 的 package.json 里加依赖
#    "dsh-browser-login": "link:C:\\path\\to\\dsh-browser-login"
# 2) dsh.profile.bundles 数组里追加 "dsh-browser-login"
# 3) 在 profile 目录执行 pnpm install
```

依赖只有 Node 内置模块，不需要联网装 npm 包；Chrome / Edge 用系统已安装的。

---

## 第一次登录（以 B 站为例）

对 DSH 说：

> 用 browser_login 登录 bilibili

会发生：

1. 弹出一个 Chrome 窗口，打开 B 站登录页；
2. 窗口顶部出现提示条「DSH 等你完成登录 / 验证」；
3. 你用账号密码 / 扫码 / 短信验证码完成登录；
4. 插件每 1.5 秒检测一次，检测到 SESSDATA 或页面登录态就返回 logged-in，并把 cookie 与账号信息写进 profile；
5. 之后 `browser_open https://www.bilibili.com` 直接就是登录状态。

**超时不是失败**：默认等 5 分钟，超时后窗口保持打开、cookie 已落盘，再说一句「继续等登录」即可。

YouTube / X / Facebook 在国内容易连不上，先给 profile 配代理：

> 用 browser_profile 给 default 设置代理 socks5://127.0.0.1:7890，然后 browser_login youtube

---

## 工具

| 工具 | 作用 |
| --- | --- |
| `browser_open` | 打开网址，返回带 `[编号]` 的页面快照 |
| `browser_snapshot` | 重新取快照（编号刷新） |
| `browser_click` | 按编号点击（真实鼠标事件，新标签页自动切换） |
| `browser_type` | 按编号输入（可清空、可回车提交） |
| `browser_press` | Enter / Tab / Escape / PageDown 等按键 |
| `browser_scroll` | 滚轮滚动，能触发信息流懒加载 |
| `browser_read` | 提取正文（去导航/页脚） |
| `browser_eval` | 在页面里跑 JS，批量抓数据 |
| `browser_screenshot` | 截图，返回 PNG 路径 |
| `browser_tabs` | 列出 / 切换 / 关闭标签页 |
| `browser_login` | 打开登录页，人工登录，自动检测并保存登录态 |
| `browser_login_status` | 检测某站点是否已登录（不弹窗） |
| `browser_handoff` | 中途把页面交给人处理验证码/风控：点「我已完成」或主页面跳转后继续 |
| `browser_profile` | list / create / remove / set_proxy / show / export / import |
| `browser_close` | 关闭浏览器（登录态不丢） |

推荐工作流：`browser_open` → 看快照里的编号 → `browser_click` / `browser_type` → 页面变了再 `browser_snapshot`。要抓一屏列表（视频标题、点赞数、帖子链接），直接 `browser_eval` 写一段 `Array.from(document.querySelectorAll(...))` 一次拿回来，比逐个点击快得多。

---

## 登录态与「指纹」存在哪

每个 profile 一个目录（默认 `~/.dsh/browser-profiles/<profile>`）：

```text
<profile>/
  chrome/            Chrome 的 user-data-dir：cookie、localStorage、IndexedDB、设备信任凭证
  state/
    logins.json      各站点登录状态与账号名
    cookies.json     可移植的 cookie 包（含 HttpOnly）
    cookies-<site>.json
  screenshots/
```

「保存指纹继续」在这里是**真的保存浏览器状态**，不是拼装指纹：同一个 user-data-dir、同一台机器、同一个出口 IP，站点看到的还是上次那台设备。cookie 另存一份 JSON，是因为 Chrome 对会话 cookie（没有过期时间的）在重启时未必恢复，插件启动时会自动补回，DSH 重启、浏览器崩溃后都能续上。

- 备份 / 迁移：`browser_profile export` 导出 cookie 包，拷到另一台机器 `import` 导入（配合同样的代理出口更稳）。
- 换账号：`browser_profile create work` 建一个新 profile，不同账号用不同 profile，互不踢下线。
- 清空：`browser_profile remove <name>` 或直接删目录。

---

## 配置

插件行支持这些配置（`cordis.patch.yml` 里 `config:` 下写）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `defaultProfile` | `default` | 不指定 profile 时用哪个 |
| `profilesDir` | `~/.dsh/browser-profiles` | profile 根目录 |
| `browserPath` | 自动探测 | Chrome / Edge 可执行文件 |
| `headless` | `false` | 平时是否无头；登录时会强制带界面 |
| `proxy` | 空 | 新 profile 默认代理 |
| `locale` / `timezone` | `zh-CN` / 系统 | 语言与时区 |
| `viewport` | `1440x900` | 窗口尺寸 |
| `loginTimeoutMs` | `300000` | 人工登录等待上限 |
| `snapshotMaxChars` | `24000` | 快照返回上限 |

---

## 注意

- **一个 profile 同一时间只能被一个 Chrome 占用**。插件自己会复用，但如果你手动用同一个 user-data-dir 开了 Chrome，会启动失败并提示换 profile。
- 社交平台对自动化有风控。这个插件的定位是「代替你手动点」：节奏放慢、别用同一账号并发开多个任务、验证码永远交给人，比任何指纹伪装都管用。
- 账号密码、验证码**不要写进工具参数**——登录一律在窗口里手输，工具只负责等待和保存结果。
- 站点改版会影响登录判定。`browser_login_status` 的判定按 cookie → 页面探针 → DOM 兜底排序，cookie 名写在 `lib/sites.js` 里，好改。
- **cookie 是明文落盘的**（`state/cookies.json` 含 SESSDATA / auth_token）。这个目录等价于你的登录凭证：别同步到公共网盘、别提交进 git；多用户机器上建议给 `~/.dsh/browser-profiles` 收紧 ACL。
- `browser_eval` 会在**已登录页面**里执行任意 JS，模型能读该页面的数据、能带 cookie 发请求——没有额外护栏。只在你信任的任务里用。

---

## 自测

```powershell
node test/e2e.mjs
```

会用本地 HTTP 服务模拟「未登录 → 登录表单 → 提交 → 已登录」，完整跑一遍：启动浏览器、快照、点击、输入、提交、落盘、截图、重启后仍是登录态。全程无头，不碰真实站点。

---

## 变更记录

### 0.1.1（2026-10-20，按代码审查修复）

- **修复编号错位**：快照前清除旧 `data-dsh-ref`，并把「编号 → 元素」存进页面数组（`window.__dshRefs`），点击不再命中上一轮的隐藏元素；跨页跳转后旧编号会明确报「已失效」。
- **重写 handoff 判定**：只统计主框架导航（忽略广告/埋点 iframe 的周期性跳转）；横幅增加「我已完成」按钮，点了立即继续；保留「主框架跳转」和「验证码元素消失」两条启发式。
- `siteFor()` 改为精确 host 匹配，`netflix.com` / `box.com` 不再被当成 X。
- 工具按 profile 串行执行（同一 profile 并发调用不再抢 `activeTargetId`）。
- SPA 首屏：`readyState` 完成后等正文长度稳定，快照为空时自动重试一次。
- `readInPage` 按块级元素补回换行，段落不再糊成一行。
- `close()` 不再为了存 cookie 反向拉起浏览器；删除会清空全部 cookie 的死代码 `clearCookies()`。
- 删除开发用的 `test/cdp-smoke.mjs`（它会在包目录里留 profile 垃圾）。

---

## 卸载

```powershell
node scripts/install.mjs --uninstall
```

会从 profile 的依赖与 bundles 里移除本包，并删掉 node_modules 里的联接（profile 目录里的 cookie 数据保留，需要的话自己删 `~/.dsh/browser-profiles`）。
