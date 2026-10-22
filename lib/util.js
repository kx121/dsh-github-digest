/**
 * 通用小工具：JSON 原子读写、时间格式化、输入归一、文本清洗。
 *
 * 这一层不依赖宿主 ctx，也不依赖插件的其它模块，离线测试可以直接 import。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 建目录，失败不抛。 */
export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 读 JSON，读不到 / 解析失败都返回 fallback，不抛。 */
export function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 原子写 JSON：先写同目录临时文件再 rename。
 * 进程中途被杀也不会留下半个 JSON（rename 在同一分区上是原子的）。
 */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file)
  if (!ensureDir(dir)) return { ok: false, error: '建目录失败：' + dir }
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now() + '.tmp')
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清理失败不影响结果 */ }
    return { ok: false, error: String(err && err.message || err) }
  }
}

export function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 本地时间：「2026-10-22 12:30:00」。记录文件统一用这个格式。 */
export function localStamp(d = new Date()) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}

/** 本地日期：「2026-10-22」。 */
export function localDate(d = new Date()) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/** 取整并夹在 [min, max]；非法值用 fallback。 */
export function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** 宽松布尔：接受 true/false、1/0、"true"/"false"，其余用 fallback。 */
export function toBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  return fallback
}

/** 只接受字符串，顺手 trim；其它类型回退。 */
export function toStringSafe(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

/** 去掉孤立代理项，保证输出是 well-formed UTF-16（宿主校验 lossless JSON 时会拒）。 */
export function toWellFormedText(text) {
  const s = typeof text === 'string' ? text : String(text == null ? '' : text)
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s
}

/** 递归清洗要交给模型的值：NaN/Infinity → null，字符串做 well-formed 处理。 */
export function wellFormedDeep(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return toWellFormedText(value)
  if (Array.isArray(value)) return value.map((item) => wellFormedDeep(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = wellFormedDeep(item, depth + 1)
    return out
  }
  return value
}

/** 统一的 JSON 响应。响应头已发出时吞掉异常。 */
export function jsonResponse(res, code, body) {
  try {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(body))
  } catch {
    /* 连接可能已断开 */
  }
}

/** 对象上所有可调用方法名（含原型链，最多向上 4 层）。宿主 API 没文档，探测用。 */
export function methodNames(obj) {
  if (!obj) return []
  const found = new Set()
  let proto = obj
  // 不要把 Object.prototype 上的 toString/hasOwnProperty 当成宿主 API。
  for (let depth = 0; depth < 4 && proto && proto !== Object.prototype; depth += 1) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue
      try {
        if (typeof obj[name] === 'function') found.add(name)
      } catch {
        /* getter 抛错就跳过 */
      }
    }
    proto = Object.getPrototypeOf(proto)
  }
  return [...found]
}

/** Markdown 表格单元格：半角竖线会切断表格，换全角｜；换行压成空格。 */
export function escapeCell(text) {
  return toStringSafe(String(text == null ? '' : text)).replace(/\|/g, '\uFF5C').replace(/\r?\n/g, ' ')
}

/** 12345 → "12.3k"；1200000 → "1.2M"。面板展示用。 */
export function formatCompactNumber(value) {
  const n = Number(value) || 0
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}
