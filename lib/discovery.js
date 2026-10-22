/**
 * 发现模式（按主题找新仓库）用到的纯函数。
 *
 * GitHub Search 的约束（实测）：
 *   - topic: 之间是 AND 语义，多个主题串进一个 q 必然 0 条；
 *   - OR 语法不被接受（422）；
 *   - 只能一轮一个主题，轮换着来。
 */
import { toStringSafe } from './util.js'

/** 主题名 → GitHub topic slug。「ai agent」→「ai-agent」。 */
export function topicSlug(name) {
  return toStringSafe(String(name == null ? '' : name))
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 词边界包含：needle 前后不能是英文字母 / 数字，避免 llm 误命中 htmlmeta。 */
export function containsTerm(haystack, needle) {
  const text = String(haystack || '').toLowerCase()
  const term = String(needle || '').toLowerCase()
  if (!text || !term) return false
  let from = 0
  while (from <= text.length - term.length) {
    const idx = text.indexOf(term, from)
    if (idx < 0) return false
    const before = idx === 0 ? '' : text[idx - 1]
    const after = idx + term.length >= text.length ? '' : text[idx + term.length]
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true
    from = idx + 1
  }
  return false
}

/**
 * 这个仓库命中了用户配置的哪几个主题。
 * 用途是排序依据，不是硬规则；两边都过 slug 归一后再比。
 *
 * 先看仓库自己填的 topics；没命中再退回「仓库名 + 描述」做词边界匹配 ——
 * 新项目有很大比例根本不填 topics，只比 topics 会让这条判断依据直接失效。
 */
export function matchTopicHits(repo, topics) {
  const list = Array.isArray(topics) ? topics : []
  if (!list.length) return []
  const repoTops = new Set((Array.isArray(repo && repo.topics) ? repo.topics : []).map((t) => String(t || '').toLowerCase()))
  const name = String((repo && (repo.name || repo.fullName)) || '')
  const description = String((repo && repo.description) || '')
  const haystack = (name + ' ' + description).toLowerCase()
  const hits = []
  for (const topic of list) {
    const slug = topicSlug(topic)
    if (!slug) continue
    if (repoTops.has(slug)) {
      hits.push(topic)
      continue
    }
    if (containsTerm(haystack, slug) || containsTerm(haystack, slug.replace(/-/g, ' '))) hits.push(topic)
  }
  return hits
}

/**
 * 从候选池里剔掉判重表已经记过的，再取前 limit 个。
 *
 * 判重键只看 owner/repo（忽略 @版本、大小写）。这一步必须放在插件里：
 * 让模型对着 100 条重复结果判断，既费 token 又费步数，还会把每轮名额占满。
 */
export function filterUnseen(repos, seenRows, limit) {
  const baseKey = (value) => String(value || '').toLowerCase().split('@')[0]
  const seenKeys = new Set((Array.isArray(seenRows) ? seenRows : []).map((row) => baseKey(row && row.repo)))
  const fresh = []
  let filtered = 0
  for (const repo of Array.isArray(repos) ? repos : []) {
    const key = baseKey(repo && repo.fullName)
    if (!key) continue
    if (seenKeys.has(key)) {
      filtered += 1
      continue
    }
    fresh.push(repo)
  }
  const take = Number(limit) > 0 ? Math.max(0, Math.floor(Number(limit))) : fresh.length
  return {
    fresh: fresh.slice(0, take),
    filtered,
    freshTotal: fresh.length,
    pool: Array.isArray(repos) ? repos.length : 0,
  }
}
