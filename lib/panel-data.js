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
import { readSeen, readRuns, readHistory } from './store.js'
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
    schedule: config.schedule,
    history: allHistory.slice(0, 20),
    cumulative,
    cost: readCostMeter(COST_LEDGER_FILE, runtime.env.today()),
    seen: { readable: seen.readable, rows: seen.readable ? seen.rows.length : -1 },
    reports: listReports(paths),
    paths: { outDir: paths.outDir, history: paths.history },
  }
}
