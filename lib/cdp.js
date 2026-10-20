import { connectWebSocket } from './ws.js'

/** CDP 协议错误（浏览器返回的 error 对象）。 */
export class CdpError extends Error {
  constructor(message, info = {}) {
    super(message)
    this.name = 'CdpError'
    this.method = info.method
    this.code = info.code
    this.data = info.data
  }
}

/**
 * Chrome DevTools Protocol 客户端：一条 WebSocket 复用所有 target，
 * 通过 sessionId 路由到对应页面（flatten 模式）。
 */
export class CdpClient {
  static async connect(url, { timeoutMs = 20000 } = {}) {
    const transport = await connectWebSocket(url, { timeoutMs })
    await transport.ready
    return new CdpClient(transport, url)
  }

  constructor(transport, url) {
    this.transport = transport
    this.url = url
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    transport.on('message', (text) => this.dispatch(text))
    transport.on('close', (code, reason) => {
      this.closed = true
      this.failAll(new Error('CDP 连接已断开' + (reason ? '：' + reason : '') + ' (' + (code ?? '') + ')'))
    })
  }

  dispatch(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(
          new CdpError(message.error.message || 'CDP 调用失败', {
            method: entry.method,
            code: message.error.code,
            data: message.error.data,
          }),
        )
      } else {
        entry.resolve(message.result ?? {})
      }
      return
    }
    if (!message.method) return
    const handlers = this.listeners.get(message.method)
    if (!handlers) return
    for (const handler of [...handlers]) {
      try {
        handler(message.params ?? {}, message.sessionId)
      } catch {
        // 事件回调异常不应打断协议循环
      }
    }
  }

  send(method, params = {}, { sessionId, timeoutMs = 30000 } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'))
    const id = ++this.nextId
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError('CDP 调用超时：' + method, { method, code: 'TIMEOUT' }))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.transport.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(handler)
    return () => this.listeners.get(method)?.delete(handler)
  }

  waitFor(method, { timeoutMs = 20000, sessionId, predicate } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new CdpError('等待事件超时：' + method, { method, code: 'TIMEOUT' }))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      const off = this.on(method, (params, sid) => {
        if (sessionId && sid !== sessionId) return
        if (predicate && !predicate(params, sid)) return
        clearTimeout(timer)
        off()
        resolve(params)
      })
    })
  }

  failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  close() {
    this.closed = true
    this.failAll(new Error('CDP 连接已关闭'))
    try { this.transport.close() } catch {}
  }
}
