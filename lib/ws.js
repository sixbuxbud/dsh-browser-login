import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

/**
 * 最小 WebSocket 客户端。
 *
 * 宿主 Node 一般自带全局 WebSocket（Node >= 22），这里优先用它；
 * 若运行环境没有全局 WebSocket（较老的 Electron / Node），退回到
 * 本文件里手写的 RFC 6455 客户端，保证插件不依赖任何第三方包。
 */

export async function connectWebSocket(url, { timeoutMs = 15000 } = {}) {
  if (typeof globalThis.WebSocket === 'function') return openNative(url, timeoutMs)
  return RawWebSocket.connect(url, timeoutMs)
}

function openNative(url, timeoutMs) {
  const ws = new globalThis.WebSocket(url)
  const emitter = new EventEmitter()
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener('error', (event) => {
      clearTimeout(timer)
      reject(new Error('WebSocket 连接失败：' + (event?.message || url)))
    })
    ws.addEventListener('message', (event) => {
      const data = event.data
      emitter.emit('message', typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    })
    ws.addEventListener('close', (event) => {
      emitter.emit('close', event?.code, event?.reason)
    })
  })
  return {
    ready,
    on: (event, handler) => emitter.on(event, handler),
    send: (text) => ws.send(text),
    close: () => {
      try { ws.close() } catch {}
    },
  }
}

class RawWebSocket extends EventEmitter {
  static connect(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = new RawWebSocket(url, timeoutMs, resolve, reject)
      socket.start()
    })
  }

  constructor(url, timeoutMs, resolve, reject) {
    super()
    this.url = new URL(url)
    this.resolve = resolve
    this.reject = reject
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
    this.open = false
    this.key = crypto.randomBytes(16).toString('base64')
    this.timer = setTimeout(() => this.fail(new Error('WebSocket 握手超时')), timeoutMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    this.ready = new Promise((res, rej) => {
      this.readyResolve = res
      this.readyReject = rej
    })
  }

  start() {
    const secure = this.url.protocol === 'wss:'
    const options = { host: this.url.hostname, port: Number(this.url.port || (secure ? 443 : 80)) }
    this.socket = secure ? tls.connect({ ...options, servername: this.url.hostname }) : net.connect(options)
    this.socket.on('error', (error) => this.fail(error))
    this.socket.on(secure ? 'secureConnect' : 'connect', () => this.handshake())
    this.socket.on('data', (chunk) => this.consume(chunk))
    this.socket.on('close', () => this.emit('close', 1006, 'socket closed'))
  }

  handshake() {
    const path = this.url.pathname + this.url.search
    const host = this.url.host
    const request = [
      'GET ' + path + ' HTTP/1.1',
      'Host: ' + host,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + this.key,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n')
    this.socket.write(request)
  }

  fail(error) {
    clearTimeout(this.timer)
    if (!this.open) {
      this.reject(error)
      this.readyReject(error)
    } else {
      this.emit('close', 1006, error.message)
    }
    try { this.socket?.destroy() } catch {}
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (!this.open) {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = this.buffer.slice(0, end).toString('latin1')
      this.buffer = this.buffer.slice(end + 4)
      if (!/^HTTP\/1\.1 101/.test(head)) {
        this.fail(new Error('WebSocket 握手被拒绝：' + head.split('\r\n')[0]))
        return
      }
      const accept = /sec-websocket-accept:\s*(.+)/i.exec(head)
      const expected = crypto.createHash('sha1').update(this.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      if (accept && accept[1].trim() !== expected) {
        this.fail(new Error('WebSocket 握手校验失败'))
        return
      }
      this.open = true
      clearTimeout(this.timer)
      this.resolve(this)
      this.readyResolve()
    }
    this.parseFrames()
  }

  parseFrames() {
    for (;;) {
      if (this.buffer.length < 2) return
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < offset + 2) return
        length = this.buffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return
        length = Number(this.buffer.readBigUInt64BE(offset))
        offset += 8
      }
      let mask = null
      if (masked) {
        if (this.buffer.length < offset + 4) return
        mask = this.buffer.slice(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + length) return
      let payload = this.buffer.slice(offset, offset + length)
      this.buffer = this.buffer.slice(offset + length)
      if (mask) {
        const copy = Buffer.allocUnsafe(length)
        for (let i = 0; i < length; i++) copy[i] = payload[i] ^ mask[i % 4]
        payload = copy
      }
      if (opcode === 0x8) {
        this.emit('close', 1005, '')
        try { this.socket.end() } catch {}
        return
      }
      if (opcode === 0x9) {
        this.frame(0xa, payload)
        continue
      }
      if (opcode === 0xa) continue
      if (opcode === 0x0) {
        this.fragments.push(payload)
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8')
          this.fragments = []
          this.emit('message', text)
        }
        continue
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          this.fragmentOpcode = opcode
          this.fragments = [payload]
          continue
        }
        this.emit('message', payload.toString('utf8'))
      }
      void this.fragmentOpcode
    }
  }

  frame(opcode, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    const length = body.length
    let header
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | length])
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    const mask = crypto.randomBytes(4)
    const masked = Buffer.allocUnsafe(length)
    for (let i = 0; i < length; i++) masked[i] = body[i] ^ mask[i % 4]
    this.socket.write(Buffer.concat([header, mask, masked]))
  }

  send(text) {
    if (!this.open) throw new Error('WebSocket 尚未连接')
    this.frame(0x1, Buffer.from(text, 'utf8'))
  }

  close() {
    if (this.open) {
      try { this.frame(0x8, Buffer.alloc(0)) } catch {}
    }
    try { this.socket?.end() } catch {}
    this.open = false
  }
}
