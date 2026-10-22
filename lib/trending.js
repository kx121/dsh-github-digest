/**
 * 热门榜单：用 Search API 自己算，不抓 github.com/trending。
 *
 * 为什么不用官方 trending 页：github.com 在很多网络环境下连不上
 * （实测本机 github.com/trending 12 秒超时，api.github.com 354ms 正常）。
 * 榜单只能从 API 侧拼，好处是完全走官方接口，不需要为看榜单挂梯子。
 *
 * 口径是「时间窗内创建、star 最多的项目」。跟 GitHub 官方 trending 的隐藏权重
 * （评论、fork、issue 活跃度加权）不一样，方向一致但不是同一份数据，别混为一谈。
 */
import { toStringSafe } from './util.js'

/** 三个时间窗。minStars 是下限，太低会捞出一堆空壳仓库，排行榜就没意义了。 */
export const TRENDING_WINDOWS = {
  // 今日窗口只收「一天内创建」的仓库，池子本来就小；star 下限压到 5 才有 8 条左右，20 只剩 2 条。
  day: { days: 1, minStars: 5, label: '今日' },
  week: { days: 7, minStars: 100, label: '本周' },
  month: { days: 30, minStars: 500, label: '本月' },
}

export const DEFAULT_TRENDING_WINDOW = 'week'
/** 榜单变化慢，30 分钟足够；Search API 有独立限速，别每次开面板都打一次。 */
export const TRENDING_CACHE_MS = 30 * 60 * 1000
const TRENDING_CACHE_MAX = 12

const cache = new Map()

/** 时间窗 + 语言 → Search 查询串。日期用 UTC，跟 GitHub 的 created 语义一致。 */
export function buildTrendingQuery(windowKey, language, now = Date.now()) {
  const spec = TRENDING_WINDOWS[windowKey] || TRENDING_WINDOWS[DEFAULT_TRENDING_WINDOW]
  const since = new Date(now - spec.days * 86400000).toISOString().slice(0, 10)
  const parts = ['created:>' + since, 'stars:>' + spec.minStars]
  const lang = toStringSafe(language).trim()
  if (lang && lang.toLowerCase() !== 'all') parts.push('language:' + lang)
  return parts.join(' ')
}

/** 归一化时间窗；非法值回落到默认，不报错（参数来自前端，别因为一个坏值整个面板空白）。 */
export function normalizeWindow(windowKey) {
  const key = toStringSafe(windowKey).trim().toLowerCase()
  return TRENDING_WINDOWS[key] ? key : DEFAULT_TRENDING_WINDOW
}

function cacheKey(windowKey, language) {
  const lang = toStringSafe(language).trim().toLowerCase() || 'all'
  return windowKey + '|' + lang
}

export function trendingCacheGet(key, now = Date.now(), ttl = TRENDING_CACHE_MS) {
  const hit = cache.get(key)
  if (!hit) return null
  if (!(now - hit.at <= ttl)) {
    cache.delete(key)
    return null
  }
  return hit
}

export function trendingCacheSet(key, data, now = Date.now()) {
  cache.set(key, { at: now, data })
  if (cache.size > TRENDING_CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) cache.delete(oldest[0])
  }
}

export function clearTrendingCache() {
  cache.clear()
}

/** Search 返回的仓库 → 面板要的字段。描述截断，不然一条占三行。 */
export function shapeTrendingItem(repo) {
  return {
    repo: toStringSafe(repo && repo.fullName),
    stars: Number((repo && repo.stars) || 0) || 0,
    language: toStringSafe(repo && repo.language),
    description: toStringSafe(repo && repo.description).slice(0, 160),
    createdAt: toStringSafe(repo && repo.createdAt).slice(0, 10),
    pushedAt: toStringSafe(repo && repo.pushedAt).slice(0, 10),
    topics: Array.isArray(repo && repo.topics) ? repo.topics.slice(0, 5) : [],
    url: toStringSafe(repo && repo.htmlUrl),
  }
}

/**
 * 拉榜单。命中缓存就不发请求；失败原样返回 client 的错误码（RATE_LIMITED 之类）。
 */
export async function fetchTrending(client, options = {}) {
  const windowKey = normalizeWindow(options.windowKey)
  const language = toStringSafe(options.language).trim()
  const limit = Math.min(50, Math.max(1, Number(options.limit) || 25))
  const now = Number(options.now) || Date.now()
  const spec = TRENDING_WINDOWS[windowKey]
  const key = cacheKey(windowKey, language)

  const hit = trendingCacheGet(key, now)
  if (hit) {
    return {
      ok: true,
      cached: true,
      fetchedAt: hit.at,
      window: windowKey,
      windowLabel: spec.label,
      language: language || 'all',
      totalCount: hit.data.totalCount,
      items: hit.data.items.slice(0, limit),
    }
  }

  const query = buildTrendingQuery(windowKey, language, now)
  const result = await client.searchRepos({ q: query, sort: 'stars', order: 'desc', perPage: Math.min(100, Math.max(limit, 25)) })
  if (!result.ok) return { ...result, window: windowKey, windowLabel: spec.label, query }
  const items = result.repos.map(shapeTrendingItem)
  trendingCacheSet(key, { items, totalCount: result.totalCount }, now)
  return {
    ok: true,
    cached: false,
    fetchedAt: now,
    window: windowKey,
    windowLabel: spec.label,
    language: language || 'all',
    totalCount: result.totalCount,
    query,
    items: items.slice(0, limit),
  }
}
