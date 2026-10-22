/**
 * 投递消息构造：优先用宿主官方 createUserMessage，拿不到再用本地兜底。
 *
 * 为什么必须用官方的：裸对象缺 role / id 会让接收方会话之后每次请求都被网关拒绝（实测）。
 * 为什么用动态 import：宿主版本一换、导出没了，顶层静态 import 会直接让整个插件模块加载失败。
 */
import { randomUUID } from 'node:crypto'

let resolved = null
let source = 'pending'

/** 本地兜底：字段与官方实现对齐，够宿主接收。 */
export function fallbackCreateUserMessage(input) {
  return { ...(input || {}), role: 'user', id: randomUUID() }
}

/** 异步解析一次并缓存。返回 { createUserMessage, source }。 */
export async function resolveCreateUserMessage() {
  if (resolved) return { createUserMessage: resolved, source }
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof (mod && mod.createUserMessage) === 'function') {
      resolved = mod.createUserMessage
      source = 'official'
      return { createUserMessage: resolved, source }
    }
  } catch {
    /* 旧宿主没有这个模块，走兜底 */
  }
  resolved = fallbackCreateUserMessage
  source = 'fallback(local)'
  return { createUserMessage: resolved, source }
}

/** 同步读当前来源，给 apply-probe 用。 */
export function createUserMessageSource() {
  return source
}
