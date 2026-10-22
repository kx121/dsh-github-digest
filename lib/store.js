/**
 * 持久化记录：Markdown 表（判重表 / 执行记录）、history.jsonl、watch-state、本轮缓存。
 *
 * 所有函数都显式接收文件路径 —— 不读模块级常量，离线测试可以随便喂临时目录。
 * 写 Markdown 表用追加；写 JSON 用原子替换。这里的数据都是「丢了可重来」的，
 * 所以读失败一律降级为空，不抛异常、不阻塞日报。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readJsonSafe, writeJsonAtomic, escapeCell, toStringSafe, localStamp } from './util.js'

export const RUN_COLUMNS = ['时间', '触发', '结果', '关注', '收取', '跳过', '额度', '备注']
export const SEEN_COLUMNS = ['仓库', '处置', '理由', '首次看到']

/** 读 Markdown 表格。第一段表格当数据区（跳过表头）。 */
export function readTable(file) {
  if (!fs.existsSync(file)) return { readable: true, exists: false, rows: [] }
  try {
    const rows = []
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.startsWith('|')) continue
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/\\\|/g, '|'))
      if (!cells.length || cells[0] === '') continue
      if (cells.every((cell) => /^-+$/.test(cell) || cell === '')) continue
      rows.push(cells)
    }
    if (!rows.length) return { readable: true, exists: true, rows: [] }
    return { readable: true, exists: true, rows: rows.slice(1) }
  } catch (err) {
    return { readable: false, exists: true, rows: [], error: String(err && err.message || err) }
  }
}

function tableHeader(title, columns) {
  return ['# ' + title, '', '| ' + columns.join(' | ') + ' |', '| ' + columns.map(() => '---').join(' | ') + ' |', ''].join('\n')
}

/** 文件不存在时先写表头，存在就什么都不做。 */
export function ensureTable(file, title, columns) {
  if (!ensureDir(path.dirname(file))) return { ok: false, error: '建目录失败' }
  if (fs.existsSync(file)) return { ok: true }
  try {
    fs.writeFileSync(file, tableHeader(title, columns), 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

/** 追加一行（单元格里的竖线 / 换行会被转义）。 */
export function appendRow(file, title, columns, cells) {
  const prepared = ensureTable(file, title, columns)
  if (!prepared.ok) return { ok: false, error: prepared.error }
  try {
    fs.appendFileSync(file, '| ' + cells.map(escapeCell).join(' | ') + ' |\n', 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

/** 判重表 → { readable, rows:[{repo,disposition,reason,firstSeen}] }。readable:false 必须当真。 */
export function readSeen(file) {
  const table = readTable(file)
  if (!table.readable) return { readable: false, rows: [], error: table.error }
  return {
    readable: true,
    exists: table.exists,
    rows: table.rows.map((cells) => ({
      repo: cells[0] || '',
      disposition: cells[1] || '',
      reason: cells[2] || '',
      firstSeen: cells[3] || '',
    })),
  }
}

/** 执行记录，返回最后 limit 条（按文件顺序，旧的在前）。 */
export function readRuns(file, limit = 20) {
  const table = readTable(file)
  if (!table.readable) return { readable: false, rows: [], error: table.error }
  const rows = table.rows.map((cells) => ({
    time: cells[0] || '',
    trigger: cells[1] || '',
    result: cells[2] || '',
    watched: cells[3] || '',
    kept: cells[4] || '',
    skipped: cells[5] || '',
    quota: cells[6] || '',
    note: cells[7] || '',
  }))
  return { readable: true, rows: rows.slice(-limit), total: rows.length }
}

/** 面板最多读 500 条；文件超过 1MB 才收拾，避免每轮白读整个文件。 */
export const HISTORY_KEEP = 500
const HISTORY_TRIM_BYTES = 1024 * 1024

/** 读 history.jsonl（新的在前）。坏行跳过，不阻塞面板。 */
export function readHistory(file, limit = 20) {
  if (!fs.existsSync(file)) return []
  const rows = []
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* 单行坏了跳过 */
      }
    }
  } catch {
    return []
  }
  return rows.slice(-limit).reverse()
}

export function trimHistory(file, keep = HISTORY_KEEP) {
  try {
    // 文件还不存在 = 没东西可收拾，不算失败。
    if (!fs.existsSync(file)) return { ok: true, trimmed: false }
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim())
    if (lines.length <= keep) return { ok: true, trimmed: false }
    fs.writeFileSync(file, lines.slice(-keep).join('\n') + '\n', 'utf8')
    return { ok: true, trimmed: true, kept: keep }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

/** 追加一轮结构化记录，必要时触发截断。 */
export function appendHistory(file, record) {
  try {
    ensureDir(path.dirname(file))
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
    try {
      if (fs.statSync(file).size > HISTORY_TRIM_BYTES) trimHistory(file)
    } catch {
      /* 收拾失败不影响这一轮记录 */
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

/** watch-state：每个仓库上次检查时的 pushedAt / checkedAt，以及发现模式的主题游标。 */
export function readWatchState(file) {
  const value = readJsonSafe(file, null)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function writeWatchState(file, state) {
  return writeJsonAtomic(file, state && typeof state === 'object' ? state : {})
}

/** 本轮缓存（pending-run.json）：fire 时写入会话与成本基线，工具往里补数据，run_add 收尾清掉。 */
export function readPending(file) {
  const value = readJsonSafe(file, null)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

export function writePending(file, value) {
  return writeJsonAtomic(file, value || {})
}

/** 读-改-写 pending，写入失败不影响主流程。 */
export function updatePending(file, mutator) {
  try {
    const pending = readPending(file) || {}
    const next = mutator(pending)
    return writeJsonAtomic(file, next || pending)
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

export function clearPending(file) {
  try {
    fs.rmSync(file, { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

/**
 * 发现模式的「本轮候选」暂存（pending-candidates.json）。
 *
 * 用途：run_add 收尾时，把模型看过但没写判重表的候选自动补记 ——
 * 实测漏记会让下一轮原样再出现同一批候选，白烧一次 Search 和一轮判断。
 * 超过 TTL 的暂存视为上一轮残留，读出来就是空。
 */
export const CANDIDATE_TTL_MS = 6 * 3600 * 1000
const CANDIDATE_MAX = 200

export function readPendingCandidates(file, now = Date.now()) {
  const value = readJsonSafe(file, null)
  if (!value || typeof value !== 'object' || !Array.isArray(value.repos)) return { at: 0, repos: [], expired: false }
  const at = Number(value.at) || 0
  if (at && now - at > CANDIDATE_TTL_MS) return { at, repos: [], expired: true }
  return {
    at,
    expired: false,
    repos: value.repos.filter((item) => item && typeof item.repo === 'string' && item.repo),
  }
}

/** 合并写入本轮候选（同一仓库只留一条，保留最新描述）。 */
export function addPendingCandidates(file, repos) {
  const list = Array.isArray(repos) ? repos : []
  if (!list.length) return { ok: true, count: 0 }
  try {
    const current = readJsonSafe(file, null)
    const byRepo = new Map()
    if (current && Array.isArray(current.repos)) {
      for (const item of current.repos) {
        if (item && item.repo) byRepo.set(String(item.repo).toLowerCase(), item)
      }
    }
    for (const item of list) {
      if (!item || !item.repo) continue
      const repo = toStringSafe(item.repo)
      if (!repo) continue
      byRepo.set(repo.toLowerCase(), {
        repo,
        stars: Number(item.stars) || 0,
        why: toStringSafe(item.why).slice(0, 80),
        at: localStamp(),
      })
    }
    const merged = [...byRepo.values()].slice(-CANDIDATE_MAX)
    writeJsonAtomic(file, { at: Date.now(), repos: merged })
    return { ok: true, count: merged.length }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

export function clearPendingCandidates(file) {
  try {
    fs.rmSync(file, { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

/** 把本轮已经拿到的仓库数据存进 pending，watch 直接复用，不重复请求。 */
export function cacheRepoData(file, repo, payload) {
  return updatePending(file, (pending) => {
    const meta = pending.reposMeta && typeof pending.reposMeta === 'object' ? { ...pending.reposMeta } : {}
    const releases = pending.repoReleases && typeof pending.repoReleases === 'object' ? { ...pending.repoReleases } : {}
    if (payload && payload.meta) meta[repo] = payload.meta
    if (payload && Array.isArray(payload.releases)) releases[repo] = payload.releases
    return { ...pending, reposMeta: meta, repoReleases: releases }
  })
}

export function readCachedRepoData(file, repo) {
  const pending = readPending(file)
  if (!pending) return { meta: null, releases: null }
  const meta = pending.reposMeta && pending.reposMeta[repo] ? pending.reposMeta[repo] : null
  const releases = pending.repoReleases && Array.isArray(pending.repoReleases[repo]) ? pending.repoReleases[repo] : null
  return { meta, releases }
}

/**
 * 记一笔「这个仓库这轮吐了多少字」。≈token 用 chars/2.2 估（中英混排经验值），
 * 只用于面板展示与相对比较，不当作计费依据。
 */
export function recordRepoVolume(file, repo, value) {
  return updatePending(file, (pending) => {
    const repos = pending.repos && typeof pending.repos === 'object' ? { ...pending.repos } : {}
    const chars = JSON.stringify(value == null ? '' : value).length
    repos[repo] = Math.round((Number(repos[repo]) || 0) + chars / 2.2)
    return { ...pending, repos }
  })
}

/** 汇总本轮各仓库体量：合计 / 平均 / 最贵。 */
export function summarizeRepoVolume(repos) {
  const entries = Object.entries(repos || {}).filter(([, value]) => Number(value) > 0)
  if (!entries.length) return { total: 0, avg: 0, top: null, count: 0 }
  entries.sort((a, b) => Number(b[1]) - Number(a[1]))
  const total = entries.reduce((sum, [, value]) => sum + Number(value), 0)
  return {
    total: Math.round(total),
    avg: Math.round(total / entries.length),
    count: entries.length,
    top: { repo: entries[0][0], tokens: Math.round(Number(entries[0][1])) },
  }
}

/** 判重表里的记录键 → 基础仓库名（去掉 @版本、小写）。 */
export function seenBaseRepo(value) {
  return toStringSafe(String(value == null ? '' : value)).toLowerCase().split('@')[0]
}
