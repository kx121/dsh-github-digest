/**
 * gh_digest_discover：按主题 / 关键词找新仓库（GitHub Search）。
 *
 * 关键实现约束（都是实测踩出来的）：
 *   - topic: 是 AND 语义，多主题串一个 query 必然 0 条；OR 直接 422 —— 只能一轮一个主题、轮换着来；
 *   - 一次拉 100 条（单页上限，仍是 1 次请求），本地按判重表过滤后只把没见过的交给模型；
 *   - 不翻页：star 排序会漂移，翻到第 3 页内容已经全变了。用「取当前 top 100 再过滤」天然免疫。
 */
import { topicSlug, matchTopicHits, filterUnseen } from '../discovery.js'
import { readSeen, readWatchState, writeWatchState, addPendingCandidates } from '../store.js'
import { localDate } from '../util.js'
import { buildParameters, defineTool, githubError, TEXT_OUTPUT } from './schema.js'

export function createDiscoverTool(runtime) {
  return defineTool(runtime, {
    name: 'gh_digest_discover',
    description: '按 topic / 关键词发现新仓库（GitHub Search API），按 star 排序。一次拉 100 条候选，插件内部用判重表剔掉看过的，只把没见过的交给模型（默认 20 条，本轮看过的会由 run_add 自动补记判重表）。不填 query 时用设置里的主题 + 最少 star + 最近创建天数拼条件。Search 限额：匿名 10 次/分钟，有 token 30 次/分钟，一轮 1-4 次都安全。',
    parameters: buildParameters({
      query: { type: 'string', description: '搜索词，例如 topic:dsh-plugin 或 mcp server' },
      limit: { type: 'number', description: '要几条，默认 20，最多 50' },
    }),
    output: TEXT_OUTPUT,
    execute: async (args = {}) => {
      const current = runtime.reloadConfig()
      const client = runtime.clientFor(current)
      const paths = runtime.pathsFor(current)
      const rawQuery = typeof args.query === 'string' ? args.query.trim() : ''
      const want = Math.max(1, Math.min(50, Number(args.limit) || 20))
      const seen = readSeen(paths.seen)
      const seenRows = seen.readable ? seen.rows : []

      const topics = current.topics.length ? current.topics : ['dsh-plugin']
      const tail = [
        'stars:>=' + current.min_stars,
        current.discover_created_within_days > 0
          ? 'created:>' + localDate(new Date(Date.now() - current.discover_created_within_days * 86400000))
          : '',
      ].filter(Boolean).join(' ')

      let cursor = 0
      const candidates = []
      if (rawQuery) {
        candidates.push({ query: rawQuery, topic: '' })
      } else {
        const state = readWatchState(paths.watchState)
        cursor = Number(state.discoverCursor) || 0
        if (!Number.isFinite(cursor) || cursor < 0) cursor = 0
        cursor = Math.floor(cursor) % topics.length
        // 最多试 2 个主题：某个 slug 一个结果都没有时自动换下一个。
        for (let i = 0; i < Math.min(2, topics.length); i += 1) {
          const slug = topicSlug(topics[(cursor + i) % topics.length])
          if (!slug) continue
          candidates.push({ query: ('topic:' + slug + ' ' + tail).trim(), topic: slug })
        }
      }
      if (!candidates.length) candidates.push({ query: ('topic:dsh-plugin ' + tail).trim(), topic: 'dsh-plugin' })

      let result = null
      let used = candidates[0]
      let attempts = 0
      for (const candidate of candidates) {
        attempts += 1
        const attempt = await client.searchRepos({ q: candidate.query, perPage: 100 })
        if (!attempt.ok) {
          if (attempts === candidates.length) return githubError(attempt.error, { query: candidate.query })
          continue
        }
        result = attempt
        used = candidate
        if (attempt.totalCount > 0) break
      }
      if (!result) return { ok: false, code: 'NO_RESULT', message: '搜索没有返回结果', query: used.query }

      if (!rawQuery) {
        // 游标前进 attempts 格：下一个主题下次轮到，几个主题几轮覆盖一遍。
        const state = readWatchState(paths.watchState)
        writeWatchState(paths.watchState, { ...state, discoverCursor: (cursor + attempts) % topics.length })
      }

      const picked = filterUnseen(result.repos, seenRows, want)
      // 主题命中：跟用户配的关键词越贴越该往前排。是判断依据，不直接改 verdict。
      const freshRepos = picked.fresh.map((repo) => ({ ...repo, topicHits: matchTopicHits(repo, topics) }))
      // 记下「本轮真正交给模型看过的候选」：run_add 收尾时把没写进判重表的自动补记，
      // 否则下一轮同一批候选会原样再出现（实测发生过）。
      addPendingCandidates(paths.candidates, picked.fresh.map((repo) => ({
        repo: repo.fullName,
        stars: repo.stars,
        why: String(repo.description || '').slice(0, 60),
      })))

      let note = ''
      if (!seen.readable) {
        note = '判重表读不出来：这批候选「有没有看过」是未知的，不要当成没看过，写进报告。'
      } else if (picked.pool > 0 && picked.freshTotal === 0) {
        note = '主题 ' + (used.topic || used.query) + ' 的前 ' + picked.pool + ' 个结果全部在判重表里。再调一次换个主题，或把 min_stars 调低、created 窗口缩短；不要回头重复判断这些看过的项目。'
      } else if (picked.freshTotal < want) {
        note = '候选池 ' + picked.pool + ' 条里只有 ' + picked.freshTotal + ' 条没看过（' + picked.filtered + ' 条已在判重表）。就判断这 ' + picked.freshTotal + ' 条，不用回看被过滤掉的。'
      } else {
        note = '候选池 ' + picked.pool + ' 条，其中 ' + picked.filtered + ' 条已在判重表，本轮交给你 ' + picked.fresh.length + ' 条没见过的。'
      }

      return {
        ok: true,
        query: used.query,
        topic: used.topic,
        topicCursor: rawQuery ? null : (cursor + attempts) % topics.length,
        builtinQuery: !rawQuery,
        searchAttempts: attempts,
        pool: picked.pool,
        totalMatching: result.totalCount,
        filteredBySeen: picked.filtered,
        freshAvailable: picked.freshTotal,
        returned: picked.fresh.length,
        repos: freshRepos,
        seenReadable: seen.readable,
        quota: client.quotaText(),
        note,
      }
    },
  })
}
