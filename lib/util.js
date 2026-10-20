import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** 等待毫秒。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** DSH 主目录（与 profile / storages 同级）。 */
export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
}

/** 递归建目录。 */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

/** 读 JSON，失败返回兜底值。 */
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写 JSON（先写临时文件再 rename，避免半截文件）。 */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/** 当前 ISO 时间。 */
export const nowIso = () => new Date().toISOString()

/** 截断字符串并标注。 */
export function truncate(text, max) {
  const value = String(text ?? '')
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return value
  return `${value.slice(0, max)}\n…（已截断，原长 ${value.length} 字符）`
}

/** 时间戳，用于文件名。 */
export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

/** 串行互斥锁：同一 profile 的浏览器操作排队执行。 */
export class Mutex {
  constructor() {
    this.tail = Promise.resolve()
  }

  run(task) {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => {})
    return next
  }
}

/** 给 Promise 加超时。 */
export function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || '操作'}超时（${timeoutMs}ms）`)), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 轮询等待 predicate 为真。 */
export async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 150, signal } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('操作已取消')
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw lastError ?? new Error(`等待超时（${timeoutMs}ms）`)
}

/** 把错误压成一行人类可读文本。 */
export function errorText(error) {
  if (!error) return '未知错误'
  const parts = [error.message || String(error)]
  if (error.code) parts.push(`code=${error.code}`)
  if (error.data) {
    try { parts.push(typeof error.data === 'string' ? error.data : JSON.stringify(error.data)) } catch {}
  }
  return parts.join(' ')
}
