/**
 * 在页面里执行的快照函数：把可见的 DOM 变成「带编号的行」，
 * 交互元素编号后可由 browser_click / browser_type 按编号操作。
 *
 * 这个函数会被 toString() 后注入页面执行，因此必须自包含、不能引用模块作用域。
 */
export function snapshotInPage(options) {
  const opts = options || {}
  const maxChars = opts.maxChars || 24000
  const maxLines = opts.maxLines || 900
  const lines = []
  let chars = 0
  let refs = 0
  let truncated = false

  const INTERACTIVE = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[onclick]',
  ].join(',')

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE', 'SVG', 'PATH', 'CANVAS', 'AUDIO', 'VIDEO', 'SOURCE', 'TRACK'])
  const BREAK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'HR', 'BR'])

  const norm = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim()

  const push = (text, force) => {
    const value = norm(text)
    if (!value) return
    if (!force && value.length < 2) return
    if (lines.length >= maxLines || chars >= maxChars) {
      truncated = true
      return
    }
    lines.push(value)
    chars += value.length + 1
  }

  const visible = (el) => {
    if (!(el instanceof Element)) return false
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (Number(style.opacity) === 0) return false
    if (el.getAttribute('aria-hidden') === 'true' && !el.querySelector('[data-dsh-ref]')) {
      const role = el.getAttribute('role')
      if (role !== 'button' && role !== 'link') return false
    }
    return true
  }

  const role = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'select'
    if (tag === 'textarea') return 'textarea'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      return 'input:' + type
    }
    if (el.isContentEditable) return 'editable'
    return tag
  }

  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria) return norm(aria)
    const alt = el.getAttribute('alt')
    if (alt) return norm(alt)
    const title = el.getAttribute('title')
    if (title) return norm(title)
    const placeholder = el.getAttribute('placeholder')
    if (placeholder) return norm(placeholder)
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const value = el.value
      if (value) return norm(String(value)).slice(0, 80)
    }
    const text = norm(el.innerText || el.textContent || '')
    if (text) return text.slice(0, 120)
    const dataTestId = el.getAttribute('data-testid')
    if (dataTestId) return dataTestId
    const id = el.getAttribute('id')
    if (id) return '#' + id
    return ''
  }

  const stateOf = (el) => {
    const states = []
    if (el.disabled) states.push('disabled')
    if (el.checked) states.push('checked')
    if (el.getAttribute('aria-expanded') === 'true') states.push('expanded')
    if (el.getAttribute('aria-pressed') === 'true') states.push('pressed')
    if (el.getAttribute('aria-selected') === 'true') states.push('selected')
    return states.length ? ' [' + states.join(',') + ']' : ''
  }

  const refElements = []
  const describe = (el) => {
    refs += 1
    const ref = refs
    refElements.push(el)
    el.setAttribute('data-dsh-ref', String(ref))
    const roleName = role(el)
    let line = '[' + ref + '] <' + roleName + '>'
    const name = nameOf(el)
    if (name) line += ' "' + name.replace(/"/g, '“') + '"'
    if (el.tagName === 'A' && el.getAttribute('href')) {
      const href = el.href
      if (href && !href.startsWith('javascript:')) line += ' -> ' + href.slice(0, 200)
    }
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked) line += ' [checked]'
      } else if (type !== 'hidden' && el.value) {
        line += ' value="' + String(el.value).slice(0, 80) + '"'
      }
    }
    line += stateOf(el)
    return line
  }

  const walk = (node, depth) => {
    if (truncated || depth > 80) return
    if (node.nodeType === Node.TEXT_NODE) {
      const text = norm(node.nodeValue)
      if (text) push(text)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node
    if (SKIP.has(el.tagName)) return
    if (el.hasAttribute && el.hasAttribute('hidden')) return
    if (!visible(el)) return
    if (el.tagName === 'IFRAME') {
      push('[iframe] ' + (el.getAttribute('src') || ''), true)
      return
    }
    if (el.matches && el.matches(INTERACTIVE)) {
      push(describe(el), true)
      if (el.tagName === 'SELECT') {
        const selected = el.options && el.selectedOptions && el.selectedOptions[0]
        if (selected) push('  当前选项：' + norm(selected.textContent), false)
      }
      return
    }
    if (BREAK.has(el.tagName) && lines.length) lines.push('')
    for (const child of el.childNodes) walk(child, depth + 1)
    if (el.shadowRoot) for (const child of el.shadowRoot.childNodes) walk(child, depth + 1)
    if (BREAK.has(el.tagName) && lines.length) lines.push('')
  }

  // 清掉上一轮快照留下的编号：同一页面连续快照时，编号会从 1 重新开始，
  // 旧属性不清会让 querySelector 命中"文档顺序第一个"的旧元素（点到错的东西）。
  const clearRefs = (root) => {
    if (!root || !root.querySelectorAll) return
    for (const el of root.querySelectorAll('[data-dsh-ref]')) el.removeAttribute('data-dsh-ref')
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) clearRefs(el.shadowRoot)
  }
  clearRefs(document)
  walk(document.body || document.documentElement, 0)
  // 编号 → 元素 的映射存进页面，点击时按数组取，绝不按属性名猜
  window.__dshRefs = refElements

  const view = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const clipped = view.length > maxChars ? view.slice(0, maxChars) : view
  return {
    url: location.href,
    title: document.title,
    view: clipped,
    refs,
    truncated: truncated || view.length > maxChars,
  }
}

/**
 * 在页面里执行的正文提取：优先 main/article，退化为 body，
 * 去掉脚本、导航、页脚等噪声，返回适合模型阅读的纯文本。
 */
export function readInPage(options) {
  const opts = options || {}
  const maxChars = opts.maxChars || 20000
  const root =
    document.querySelector('article') ||
    document.querySelector('main') ||
    document.querySelector('[role="main"]') ||
    document.body ||
    document.documentElement
  if (!root) return { url: location.href, title: document.title, text: '' }
  const clone = root.cloneNode(true)
  const drop = clone.querySelectorAll('script,style,noscript,template,svg,iframe,nav,footer,aside,[aria-hidden="true"]')
  for (const node of drop) node.remove()
  // 脱离文档的 clone 没有布局信息，innerText 会退化成 textContent，
  // 所以按块级标签手动补换行，保住段落结构（审查：readInPage 丢失换行）
  const BLOCK = new Set([
    'P','DIV','SECTION','ARTICLE','MAIN','HEADER','FOOTER','NAV','ASIDE','UL','OL','LI','TABLE','THEAD','TBODY','TR','TD','TH',
    'H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','FORM','FIGURE','FIGCAPTION','BR','HR','DL','DT','DD',
  ])
  const parts = []
  const collect = (node) => {
    if (node.nodeType === 3) {
      const value = String(node.nodeValue || '').replace(/\s+/g, ' ').trim()
      if (value) parts.push(value)
      return
    }
    if (node.nodeType !== 1) return
    const block = BLOCK.has(node.tagName)
    if (block) parts.push('\n')
    for (const child of node.childNodes) collect(child)
    if (block) parts.push('\n')
  }
  collect(clone)
  const text = parts
    .join(' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return {
    url: location.href,
    title: document.title,
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
  }
}

/** 注入页面的「登录等待」提示条，带 shadow root 避免污染站点样式。 */
export function handoffBannerInPage(message, showButton) {
  const id = 'dsh-handoff-banner'
  const previous = document.getElementById(id)
  if (previous) previous.remove()
  const host = document.createElement('div')
  host.id = id
  host.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);pointer-events:none'
  const root = host.attachShadow({ mode: 'open' })
  const box = document.createElement('div')
  box.style.cssText =
    'background:#111827;color:#f9fafb;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:10px 14px;' +
    'border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center;max-width:80vw'
  const dot = document.createElement('span')
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#22c55e;flex:0 0 auto'
  const text = document.createElement('span')
  text.textContent = String(message)
  text.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '我已完成 ✓'
  button.style.cssText =
    'pointer-events:auto;cursor:pointer;border:0;border-radius:999px;padding:5px 12px;background:#22c55e;' +
    'color:#052e16;font:600 13px system-ui,-apple-system,Segoe UI,sans-serif;flex:0 0 auto'
  button.addEventListener('click', function () {
    window.__dshHandoffDone = true
    button.textContent = '已收到，继续…'
    button.disabled = true
    button.style.background = '#4b5563'
    button.style.color = '#e5e7eb'
    dot.style.background = '#f59e0b'
  })
  box.appendChild(dot)
  box.appendChild(text)
  if (showButton !== false) box.appendChild(button)
  root.appendChild(box)
  document.documentElement.appendChild(host)
  return true
}

/** 移除提示条。 */
export function clearBannerInPage() {
  document.getElementById('dsh-handoff-banner')?.remove()
  return true
}
