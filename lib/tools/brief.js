/**
 * gh_duty_brief：粗筛。一次 Search 请求拿多个仓库的元信息。
 *
 * 默认不拉 releases（这是省配额的大头）：元信息 + pushedAt 就够筛，
 * 正文留给 gh_duty_watch。打开 brief_fetch_releases 才顺带拉版本标题。
 */
import { parseRepoRef } from '../repo-ref.js'
import { matchTopicHits } from '../discovery.js'
import { readSeen, readWatchState, writeWatchState, cacheRepoData } from '../store.js'
import { localStamp } from '../util.js'
import { buildParameters, defineTool, TEXT_OUTPUT } from './schema.js'

const DORMANT_DAYS = 30
const SHORT_CIRCUIT_HOURS = 12

export function createBriefTool(runtime) {
  return defineTool(runtime, {
    name: 'gh_duty_brief',
    description: '粗筛：一次看多个仓库的元信息（描述、star、语言、最近推送时间、上次检查后有没有推送 pushedSinceLast）。默认不拉 releases，只用 1 次 Search 请求拿全部仓库。用 pushedSinceLast + 描述筛掉不相关的，再对选中的调 gh_duty_watch 拿正文 —— 这是控制配额与 token 的关键：40 个仓库粗筛 1 次请求，逐个读正文要 40 次。',
    parameters: buildParameters({
      repos: { type: 'string', description: '逗号或换行分隔的 owner/repo 列表；不填则用设置里的全部关注仓库' },
    }),
    output: TEXT_OUTPUT,
    execute: async (args = {}) => {
      const current = runtime.reloadConfig()
      const client = runtime.clientFor(current)
      const rawList = typeof args.repos === 'string' ? args.repos.trim() : ''
      const paths = runtime.pathsFor(current)
      const seen = readSeen(paths.seen)
      const seenKeys = new Set(seen.readable ? seen.rows.map((row) => row.repo.toLowerCase()) : [])
      const watchState = readWatchState(paths.watchState)
      // 用户填的可能是任意大小写，watch-state 的键跟着 GitHub 返回的写法走；
      // 只按精确键取，改个大小写就会把「检查过的仓库」重新当成首次检查。
      const watchStateLower = new Map()
      for (const [key, value] of Object.entries(watchState)) {
        const lower = String(key || '').toLowerCase()
        if (!lower || !value || typeof value !== 'object') continue
        if (!watchStateLower.has(lower)) watchStateLower.set(lower, value)
      }
      const explicit = rawList ? rawList.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean) : []
      const all = explicit.length ? explicit : current.watch_repos

      if (!all.length) {
        const hint = current.topics.length
          ? '关注仓库为空，但设置了主题（' + current.topics.join('、') + '）：改用 gh_duty_discover 按主题找项目'
          : '关注仓库为空，也没设主题：去设置页填 owner/repo，或填主题后用发现模式'
        return { ok: false, code: 'NO_REPOS', message: '没有可看的仓库', hint, topics: current.topics }
      }

      // 不指定列表时按「最久没检查的」排队：固定取前 N 个会让后面的仓库永远饿死。
      let list
      let omitted = 0
      if (explicit.length) {
        list = explicit.slice(0, current.max_repos_per_run)
        omitted = Math.max(0, explicit.length - list.length)
      } else {
        const checkedAt = (name) => {
          const prev = watchState[name] || watchState[name.toLowerCase()]
          return Date.parse(String((prev && prev.checkedAt) || '')) || 0
        }
        const ranked = all.slice().sort((a, b) => checkedAt(a) - checkedAt(b))
        list = ranked.slice(0, current.max_repos_per_run)
        omitted = Math.max(0, ranked.length - list.length)
      }

      // 一次 Search 拿全部元信息（1 次请求 vs N 次），拿不到的再逐个兜底。
      const bulk = await client.reposBulk(list)
      const metaMap = new Map((bulk.ok ? bulk.repos : []).map((item) => [String(item.fullName).toLowerCase(), item]))
      const items = []
      for (const item of list) {
        const ref = parseRepoRef(item)
        if (!ref) {
          items.push({ repo: item, ok: false, error: '格式要写 owner/repo' })
          continue
        }
        let meta = metaMap.get(ref.fullName.toLowerCase())
        if (!meta) {
          const single = await client.repo(ref.fullName)
          if (!single.ok) {
            items.push({ repo: ref.fullName, ok: false, error: single.error.code })
            continue
          }
          meta = single.repo
        }
        const pushedMs = Date.parse(String(meta.pushedAt || ''))
        const prev = watchState[ref.fullName] || watchStateLower.get(ref.fullName.toLowerCase()) || null
        const brief = {
          repo: ref.fullName,
          ok: true,
          stars: meta.stars,
          language: meta.language,
          description: String(meta.description || '').slice(0, 120),
          pushedAt: String(meta.pushedAt || '').slice(0, 10),
          pushedAgoDays: Number.isFinite(pushedMs) ? Math.round((Date.now() - pushedMs) / 86400000) : null,
          archived: meta.archived,
          topicHits: matchTopicHits(meta, current.topics),
          // 上次检查之后有没有推送 —— 这是「值不值得点开看」的第一道筛。
          pushedSinceLast: prev && prev.pushedAt ? prev.pushedAt !== meta.pushedAt : null,
        }
        // 短路只在 12 小时内有效：有些 release 不走代码推送，长时间不看会漏。
        const prevAt = Date.parse(String((prev && prev.checkedAt) || ''))
        const stale = !Number.isFinite(prevAt) || (Date.now() - prevAt) > SHORT_CIRCUIT_HOURS * 3600 * 1000
        const unchanged = Boolean(!stale && prev && prev.pushedAt && meta.pushedAt && prev.pushedAt === meta.pushedAt)
        if (unchanged) {
          brief.unchanged = true
          brief.note = '自上次检查（' + String(prev.checkedAt || '') + '）以来没有推送，跳过 releases 请求'
          watchState[ref.fullName] = { ...prev, checkedAt: localStamp(), lastDelta: 'unchanged' }
          items.push(brief)
          continue
        }
        // 首次检查新仓库时，很久没推送的直接跳过 releases：
        // 否则「一次扫 50 个」会变成 50 次请求，配额当场见底。
        const pushedAgoDays = Number.isFinite(pushedMs) ? (Date.now() - pushedMs) / 86400000 : Infinity
        if (!prev && pushedAgoDays > DORMANT_DAYS) {
          brief.dormant = true
          brief.note = '最近 ' + Math.round(pushedAgoDays) + ' 天没推送，跳过 releases（只更新了元信息）'
          watchState[ref.fullName] = { pushedAt: meta.pushedAt || '', checkedAt: localStamp(), lastDelta: 'dormant' }
          cacheRepoData(paths.pending, ref.fullName, { meta })
          items.push(brief)
          continue
        }
        // lastDelta 给面板用：pushed=这次看到新推送，first=第一次检查这个仓库。
        const changedSince = Boolean(prev && prev.pushedAt) && Boolean(meta.pushedAt) && prev.pushedAt !== meta.pushedAt
        watchState[ref.fullName] = {
          pushedAt: meta.pushedAt || '',
          checkedAt: localStamp(),
          lastDelta: changedSince ? 'pushed' : 'first',
        }
        cacheRepoData(paths.pending, ref.fullName, { meta })
        // 默认不拉 releases：筛选用元信息就够了，正文留给 gh_duty_watch。
        if (!current.brief_fetch_releases) {
          brief.latestSkipped = '未拉 releases（brief_fetch_releases 关闭，省配额）'
          items.push(brief)
          continue
        }
        // 正文一起拿（存缓存给 watch 用），但不返回给模型 —— 粗筛不该占上下文。
        const rel = await client.releases(ref.fullName, { perPage: 3, bodyChars: current.release_body_chars })
        if (rel.ok) cacheRepoData(paths.pending, ref.fullName, { meta, releases: rel.releases })
        if (rel.ok) {
          brief.latest = rel.releases.map((r) => ({
            tag: r.tag,
            date: String(r.publishedAt || '').slice(0, 10),
            title: String(r.name || r.body || '').split('\n')[0].slice(0, 80),
            seen: seenKeys.has((ref.fullName + '@' + r.tag).toLowerCase()),
          }))
          brief.hasNew = brief.latest.some((r) => !r.seen)
        } else {
          brief.latestError = rel.error.code
        }
        items.push(brief)
      }

      writeWatchState(paths.watchState, watchState)
      const unchangedCount = items.filter((item) => item && item.unchanged).length
      const dormantCount = items.filter((item) => item && item.dormant).length
      return {
        ok: true,
        count: items.length,
        unchangedCount,
        dormantCount,
        requestsSaved: unchangedCount + dormantCount,
        omitted,
        repos: items,
        seenReadable: seen.readable,
        quota: client.quotaText(),
        tip: omitted > 0
          ? '这批 ' + items.length + ' 个，还有 ' + omitted + ' 个没看（按最久未检查排队）。再调一次 gh_duty_brief 覆盖剩下的，别只扫一批就收工。'
          : '对 pushedSinceLast=true / hasNew=true 的仓库调 gh_duty_watch；unchanged / dormant 的直接跳过并在判重表里留一句理由',
      }
    },
  })
}
