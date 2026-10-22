/**
 * 成本：读 dsh-cost-meter 账本（精确、按天）和会话投影缓存（实时、按会话）。
 *
 * 「本轮」成本没有官方按轮快照，只能用「结束累计 − 开始基线」的差值，
 * 并且用 turn 数变化判断这段时间里有没有别的东西混进来。算不出就返回 null，不编。
 */
import { readJsonSafe, localDate } from './util.js'

/** 读 cost-meter 账本当天的数据；没装 cost-meter 返回 available:false（不是错误）。 */
export function readCostMeter(ledgerFile, today = localDate()) {
  const ledger = readJsonSafe(ledgerFile, null)
  if (!ledger || typeof ledger !== 'object' || !ledger.days) {
    return { available: false, reason: '没找到 dsh-cost-meter 的账本' }
  }
  const day = ledger.days[today]
  if (!day) return { available: true, today, sessions: [], total: null, currency: (ledger.config && ledger.config.currency) || 'CNY' }
  return {
    available: true,
    today,
    currency: (ledger.config && ledger.config.currency) || 'CNY',
    total: {
      input: day.input || 0,
      output: day.output || 0,
      cacheRead: day.cacheRead || 0,
      calls: day.calls || 0,
      costCny: day.costCny || 0,
    },
    sessions: (Array.isArray(day.sessions) ? day.sessions : []).map((s) => ({
      id: String(s.id || ''),
      at: Number(s.at) || 0,
      input: s.input || 0,
      output: s.output || 0,
      cacheRead: s.cacheRead || 0,
      calls: s.calls || 0,
      costCny: s.costCny || 0,
      title: String(s.title || ''),
    })),
  }
}

/** 从会话投影缓存读实时成本（USD）。这是唯一能按会话切分的来源。 */
export function readSessionCostTotals(projcacheDir, sessionId) {
  if (!sessionId) return null
  const doc = readJsonSafe(projcacheDir + '/' + String(sessionId) + '.json', null)
  const rows = doc && doc.record && doc.record.rows
  const totals = rows && rows.costUsage && rows.costUsage.val && rows.costUsage.val.totals
  if (!totals) return null
  const stats = rows && rows.sessionStats && rows.sessionStats.val
  return {
    input: Number(totals.input) || 0,
    output: Number(totals.output) || 0,
    cacheRead: Number(totals.cacheRead) || 0,
    cost: Number(totals.cost) || 0,
    // 判断「这一轮期间会话里有没有别的东西混进来」。
    turns: Number(stats && stats.turns) || 0,
    steps: Number(stats && stats.steps) || 0,
  }
}

/** 美元 → 人民币：优先用账本当天实际比值，没有就按 7.2 估。 */
export function costRate(ledgerFile, today = localDate()) {
  try {
    const ledger = readJsonSafe(ledgerFile, null)
    const day = ledger && ledger.days && ledger.days[today]
    if (day && Number(day.cost) > 0 && Number(day.costCny) > 0) {
      const ratio = Number(day.costCny) / Number(day.cost)
      if (Number.isFinite(ratio) && ratio > 1 && ratio < 20) return ratio
    }
  } catch {
    /* 退回默认汇率 */
  }
  return 7.2
}

/**
 * 本轮成本 = 结束时累计 − 开始时基线。
 * env: { projcacheDir, ledgerFile, today }
 */
export function computeRoundCost(pending, env = {}) {
  if (!pending || !pending.sessionId) return null
  const now = readSessionCostTotals(env.projcacheDir, pending.sessionId)
  if (!now) return null
  const base = pending.costBase && typeof pending.costBase === 'object'
    ? pending.costBase
    : { input: 0, output: 0, cacheRead: 0, cost: 0 }
  const rate = costRate(env.ledgerFile, env.today || localDate())
  const round = (n) => Math.round(n * 10000) / 10000
  const delta = {
    input: Math.max(0, now.input - (Number(base.input) || 0)),
    output: Math.max(0, now.output - (Number(base.output) || 0)),
    cacheRead: Math.max(0, now.cacheRead - (Number(base.cacheRead) || 0)),
    costUsd: Math.max(0, now.cost - (Number(base.cost) || 0)),
  }
  // 差值法会被并发污染：同一会话里还有别的交互时，结束累计包含它们。
  // 宿主没有按轮的 token 快照，只能靠 turn 数变化判断：只多 1 个 turn = 干净。
  const turnsDelta = Math.max(0, (now.turns || 0) - (Number(base.turns) || 0))
  const hasBase = Boolean(pending.costBase)
  return {
    input: delta.input,
    output: delta.output,
    cacheRead: delta.cacheRead,
    costCny: round(delta.costUsd * rate),
    sessionCostCny: round(now.cost * rate),
    rate: round(rate),
    basis: hasBase ? 'delta' : 'session-total',
    // exact=false 时面板要显示「≈」并说明原因，别假装精确。
    exact: hasBase ? turnsDelta <= 1 : false,
    turnsDelta,
  }
}
