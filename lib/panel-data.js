/**
 * 面板 / 状态接口的数据组装。
 *
 * 数据来源：
 *   - history.jsonl（每轮一条，含 items / cost / repoVolume）
 *   - seen.md / runs.md（判重表、执行记录）
 *   - dsh-cost-meter 账本（今日全部消耗）
 *   - 日报目录（文件名列表）
 * 这一层只读，不写任何文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { COST_LEDGER_FILE, LEGACY_REPORT_DIR, VERSION } from './paths.js'
import { readSeen, readRuns, readHistory, readWatchState } from './store.js'
import { readCostMeter } from './cost.js'
import { readScheduleState } from './schedule.js'
import { publicConfig } from './config.js'

/** 日报文件名列表：新目录 + 旧目录（0.2.x 之前写在插件目录），去重、倒序。 */
export function listReports(paths, limit = 30) {
  const names = []
  for (const dir of [paths.outDir, LEGACY_REPORT_DIR]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.md') && !names.includes(name)) names.push(name)
      }
    } catch {
      /* 目录不存在是正常的 */
    }
  }
  return names.sort().reverse().slice(0, limit)
}

/** 设置页 / 状态接口：运行状态快照（需要凭据状态，所以 async）。 */
export async function buildStatus(runtime) {
  const config = runtime.reloadConfig()
  await runtime.refreshCredential(config)
  const paths = runtime.pathsFor(config)
  const state = readScheduleState(runtime.env.scheduleStateFile)
  const seen = readSeen(paths.seen)
  const runs = readRuns(paths.runs, 8)
  // schedule-state 只在定时器里写过；手动跑过的轮次从执行记录兜底。
  const latestRun = runs.readable && runs.rows.length ? runs.rows[runs.rows.length - 1] : null
  const fallbackFireAt = latestRun ? String(latestRun.time || '') : ''
  return {
    ok: true,
    version: VERSION,
    enabled: config.enabled,
    watchCount: config.watch_repos.length,
    discoverEnabled: config.discover_enabled,
    tokenPresent: Boolean(config.token),
    credential: runtime.credentialSnapshot(),
    schedule: config.schedule,
    targetSessionId: config.target_session_id,
    lastRunDate: state.lastRunDate || '',
    lastFireAt: state.lastFireAt || fallbackFireAt,
    lastFireReason: state.lastFireReason || runtime.state.lastFireReason,
    seenRows: seen.readable ? seen.rows.length : -1,
    seenReadable: seen.readable,
    recentRuns: runs.readable ? runs.rows : [],
    paths,
  }
}

/** 设置页首次加载：配置（脱敏）+ 路径 + 会话下拉 + 状态。 */
export async function buildConfigPayload(runtime) {
  const config = runtime.reloadConfig()
  return {
    ok: true,
    config: publicConfig(config),
    paths: runtime.pathsFor(config),
    sessions: runtime.sessions.listLiveSessions(),
    status: await buildStatus(runtime),
  }
}

/**
 * 查询串里的标点。一律当分隔符 —— 输入法打出来的全角逗号、句号、括号，
 * 和手打的空格应该是一个意思，都不该让搜索落空。
 *
 * 只切真正的句读符号：`.` `-` `_` `/` `@` 是版本号和仓库名的一部分，切了会把
 * `v1.3.3` 拆成 `v1 3 3`、`dsh-plugin` 拆成两个词，搜索结果会松得没法看。
 */
const QUERY_PUNCT = new Set([
  '，', ',', '、', '。', '；', ';', '：', ':', '！', '!', '？', '?',
  '（', '(', '）', ')', '【', '[', '】', ']', '{', '}', '《', '》', '<', '>',
  '"', "'", '‘', '’', '“', '”', '·', '…', '—', '–', '\\', '|', '~',
])

/** 把查询串切成词：空白和标点都当分隔符。客户端里有一份一样的（高亮要用），改规则记得两边一起改。 */
export function splitQuery(query) {
  const words = []
  let buf = ''
  for (const ch of String(query == null ? '' : query)) {
    if (/\s/u.test(ch) || QUERY_PUNCT.has(ch)) {
      if (buf) {
        words.push(buf)
        buf = ''
      }
      continue
    }
    buf += ch
  }
  if (buf) words.push(buf)
  return words
}

/**
 * 全文搜索历史记录里的项目。
 *
 * 面板只拿最近 20 轮（再往前渲染不动），但「之前见到过的项目」往往在更早的轮次里，
 * 所以搜索放在服务端做：history.jsonl 最多留 500 轮，一次线性扫完是微秒级。
 * 匹配范围是项目名 + 是什么 / 变化 / 影响 / 建议 + 推荐度；多词按「全部命中」算，
 * 词之间可以是空格，也可以是标点。
 */
export function searchHistory(paths, query, limit = 50) {
  const terms = splitQuery(query).map((word) => word.toLowerCase()).slice(0, 5)
  if (!terms.length) return []
  const cap = Math.min(200, Math.max(1, Number(limit) || 50))
  const rows = readHistory(paths.history, 500)
  const hits = []
  for (const run of rows) {
    const items = Array.isArray(run && run.items) ? run.items : []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const hay = [
        item.repo, item.what, item.whatChanged, item.impact, item.action,
        item.verdict, item.confidence, item.source,
      ].map((value) => String(value == null ? '' : value)).join(' ').toLowerCase()
      if (!terms.every((term) => hay.includes(term))) continue
      hits.push({
        at: String((run && run.at) || ''),
        repo: String(item.repo || ''),
        stars: item.stars == null ? null : Number(item.stars) || 0,
        verdict: String(item.verdict || 'skip'),
        confidence: String(item.confidence || ''),
        source: String(item.source || ''),
        what: String(item.what || ''),
        whatChanged: String(item.whatChanged || ''),
        impact: String(item.impact || ''),
        action: String(item.action || ''),
      })
      if (hits.length >= cap) return hits
    }
  }
  return hits
}

/**
 * 只取「当前关注列表里那些仓库」的检查状态。
 *
 * watch-state 的键按写入时的写法存（GitHub 规范大小写），取消关注后旧记录不会自己消失，
 * 所以这里按当前 watch_repos 过滤一遍，并且用大小写不敏感的方式对键。
 */
function pickWatchState(state, watchRepos) {
  const entries = Object.entries(state && typeof state === 'object' ? state : {})
  const byLower = new Map()
  for (const [key, value] of entries) {
    const lower = String(key || '').toLowerCase()
    if (!lower || !value || typeof value !== 'object') continue
    // 同一个仓库大小写写了两份时，取检查时间更新的那个。
    const prev = byLower.get(lower)
    const prevAt = prev ? Date.parse(String(prev.checkedAt || '')) || 0 : 0
    const nextAt = Date.parse(String(value.checkedAt || '')) || 0
    if (!prev || nextAt >= prevAt) byLower.set(lower, value)
  }
  const out = {}
  for (const repo of Array.isArray(watchRepos) ? watchRepos : []) {
    const value = byLower.get(String(repo || '').toLowerCase())
    out[repo] = {
      checkedAt: value ? String(value.checkedAt || '') : '',
      pushedAt: value ? String(value.pushedAt || '') : '',
      // first / pushed / unchanged / dormant，空字符串 = 还没检查过。
      lastDelta: value ? String(value.lastDelta || '') : '',
    }
  }
  return out
}

/** 侧边栏面板：一轮一条记录 + 当天成本 + 累计。 */
export function buildPanel(runtime) {
  const config = runtime.reloadConfig()
  const paths = runtime.pathsFor(config)
  const seen = readSeen(paths.seen)
  const allHistory = readHistory(paths.history, 500)
  const cumulative = { rounds: 0, input: 0, output: 0, cacheRead: 0, costCny: 0 }
  for (const row of allHistory) {
    const cost = row && row.cost
    if (!cost || typeof cost !== 'object') continue
    cumulative.rounds += 1
    cumulative.input += Number(cost.input) || 0
    cumulative.output += Number(cost.output) || 0
    cumulative.cacheRead += Number(cost.cacheRead) || 0
    cumulative.costCny += Number(cost.costCny) || 0
  }
  cumulative.costCny = Math.round(cumulative.costCny * 10000) / 10000
  return {
    ok: true,
    version: VERSION,
    enabled: config.enabled,
    watchCount: config.watch_repos.length,
    // 面板要按仓库名判断「已关注 / 未关注」，光有数量不够。
    watchRepos: config.watch_repos,
    // 每个关注仓库上次检查的结果：面板据此显示「未发现更新」。
    watchState: pickWatchState(readWatchState(paths.watchState), config.watch_repos),
    schedule: config.schedule,
    // 面板榜单的默认时间窗和条数（不进设置页，需要时改 config.json）。
    trending: { window: config.trending_window, limit: config.trending_limit },
    history: allHistory.slice(0, 20),
    cumulative,
    cost: readCostMeter(COST_LEDGER_FILE, runtime.env.today()),
    seen: { readable: seen.readable, rows: seen.readable ? seen.rows.length : -1 },
    reports: listReports(paths),
    paths: { outDir: paths.outDir, history: paths.history },
  }
}
