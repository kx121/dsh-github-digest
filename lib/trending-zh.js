/**
 * 热门榜单的中文简介。
 *
 * 榜单数据只有仓库自带的英文 description；面板要中文，就在拉榜后批量问一次模型：
 * 一页（最多 25 个）合并成一次请求，结果按 repo + 描述哈希缓存，重新打开面板不再花 token。
 * 模型不可用、超时、返回格式坏掉，一律静默降级成英文原文 —— 面板不能因为翻译失败就打不开。
 */
import { toStringSafe } from './util.js'

/** 缓存条数上限：一页 15~25 条，留几个时间窗的量。 */
const CACHE_MAX = 400
/** 一次请求的硬超时。面板在等它，宁可先给英文。 */
const REQUEST_TIMEOUT_MS = 12000
/** 单条中文长度上限，防止模型写小作文。 */
const ZH_MAX_CHARS = 80

const cache = new Map()

/** 便宜的字符串哈希：只用来判断描述有没有变，不需要抗碰撞。 */
function hashText(text) {
  const value = toStringSafe(text)
  let hash = 0
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return hash
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text)
}

export function cachedChinese(repo, description) {
  const hit = cache.get(toStringSafe(repo))
  if (!hit || hit.hash !== hashText(description)) return ''
  return hit.zh
}

export function rememberChinese(repo, description, zh) {
  const key = toStringSafe(repo)
  const text = toStringSafe(zh).trim()
  if (!key || !text) return
  cache.set(key, { hash: hashText(description), zh: text.slice(0, ZH_MAX_CHARS) })
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/** 把整页仓库压成一段提示词。一次请求，别一条一条调。 */
export function buildPrompt(items) {
  const lines = items.map((item, index) => {
    const repo = toStringSafe(item && item.repo)
    const description = toStringSafe(item && item.description).slice(0, 200)
    const language = toStringSafe(item && item.language)
    const topics = Array.isArray(item && item.topics) ? item.topics.slice(0, 5).join(', ') : ''
    const meta = [language, topics ? '标签 ' + topics : ''].filter(Boolean).join('；')
    return (index + 1) + '. ' + repo + (meta ? '（' + meta + '）' : '') + '：' + (description || '仓库没写描述')
  })
  return [
    '下面是 GitHub 上最近创建、涨 star 最快的仓库。给每个仓库写一句中文介绍，40 字以内，',
    '说清「这是什么、用来干什么」，别写评价、别写营销词、别编功能。',
    '只输出 JSON 数组，每项 {"repo":"owner/repo","zh":"中文介绍"}，顺序与输入一致，不要别的文字。',
    '',
    ...lines,
  ].join('\n')
}

/** 从模型输出里抠出 JSON 数组；抠不出来就按「owner/repo：中文」逐行兜底。 */
export function parseChinese(text, items) {
  const result = new Map()
  const raw = toStringSafe(text)
  if (!raw) return result
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start !== -1 && end > start) {
    try {
      const list = JSON.parse(raw.slice(start, end + 1))
      if (Array.isArray(list)) {
        for (const entry of list) {
          const repo = toStringSafe(entry && entry.repo).trim()
          const zh = toStringSafe(entry && (entry.zh || entry.zh_cn || entry.chinese)).trim()
          if (!repo || !zh || !hasChinese(zh)) continue
          result.set(repo, zh.slice(0, ZH_MAX_CHARS))
        }
      }
    } catch {
      /* 落到逐行兜底 */
    }
  }
  if (result.size === 0) {
    const lines = raw.split('\n')
    for (const item of Array.isArray(items) ? items : []) {
      const repo = toStringSafe(item && item.repo)
      if (!repo) continue
      const line = lines.find((candidate) => candidate.includes(repo))
      if (!line) continue
      const zh = line.slice(line.indexOf(repo) + repo.length).replace(/^[）)\s:：-]+/u, '').trim()
      if (zh && hasChinese(zh)) result.set(repo, zh.slice(0, ZH_MAX_CHARS))
    }
  }
  return result
}

/** 消费流并把文本拼起来；超时也把已收到的交出去，不让面板干等。 */
function collectStream(stream, timeoutMs) {
  return new Promise((resolve) => {
    let text = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => finish(text), timeoutMs)
    ;(async () => {
      try {
        for await (const chunk of stream) {
          if (!chunk) continue
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk.type === 'finish') break
        }
      } catch {
        /* 失败也把已收到的文本交出去 */
      }
      clearTimeout(timer)
      finish(text)
    })()
  })
}

/**
 * 给榜单条目补中文介绍。
 * 返回同一个数组；item.zh 补上中文，补不到就保持 undefined（前端回退英文）。
 */
export async function localizeTrending(ctx, items) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return list
  const pending = []
  for (const item of list) {
    const repo = toStringSafe(item && item.repo)
    if (!repo) continue
    const cached = cachedChinese(repo, item && item.description)
    if (cached) item.zh = cached
    else pending.push(item)
  }
  if (!pending.length) return list
  let selection = null
  try {
    const defaults = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
    if (defaults && typeof defaults.currentSelection === 'function') selection = defaults.currentSelection()
  } catch {
    selection = null
  }
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : null
  if (!selection || !selection.provider || !selection.model || !llm || typeof llm.stream !== 'function') return list
  let text = ''
  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(pending) }] }],
    })
    text = await collectStream(stream, REQUEST_TIMEOUT_MS)
  } catch {
    return list
  }
  const parsed = parseChinese(text, pending)
  for (const item of pending) {
    const repo = toStringSafe(item && item.repo)
    const zh = parsed.get(repo)
    if (!zh) continue
    item.zh = zh
    rememberChinese(repo, item && item.description, zh)
  }
  return list
}
