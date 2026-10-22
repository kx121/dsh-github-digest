/**
 * 判重表读写：gh_digest_seen_query / gh_digest_seen_add。
 *
 * 「判重表读不出来」不是「没记录过」：readable:false 必须原样交给模型，让它写进报告，
 * 否则一旦文件损坏就会重复收同一批项目。
 */
import { parseRepoRef } from '../repo-ref.js'
import { readSeen, appendRow, SEEN_COLUMNS } from '../store.js'
import { localDate, toStringSafe } from '../util.js'
import { buildParameters, defineTool, TEXT_OUTPUT } from './schema.js'

export function createSeenQueryTool(runtime) {
  return defineTool(runtime, {
    name: 'gh_digest_seen_query',
    description: '查判重表：这个仓库（或 仓库@版本）看过没有。返回 readable:false 表示判重表读不出来——不许当成「没记录过」。',
    parameters: buildParameters({
      repo: { type: 'string', description: '仓库 full_name，可带版本：owner/repo@v1.2.0' },
      query: { type: 'string', description: '可选：按关键词模糊搜（仓库名/理由片段）' },
    }),
    output: TEXT_OUTPUT,
    execute: async (args = {}) => {
      const current = runtime.reloadConfig()
      const paths = runtime.pathsFor(current)
      const seen = readSeen(paths.seen)
      if (!seen.readable) {
        return {
          ok: true,
          readable: false,
          code: 'SEEN_UNREADABLE',
          message: seen.error || '判重表读不出来',
          hint: '判重表读不出来，本轮不要当它不存在，把这事写进报告。',
        }
      }
      const needle = (toStringSafe(args.repo) || toStringSafe(args.query)).toLowerCase()
      if (!needle) return { ok: true, readable: true, found: false, hint: '没给 repo 或 query' }
      const hit = seen.rows.find((row) => row.repo.toLowerCase().includes(needle))
      if (hit) return { ok: true, readable: true, found: true, entry: hit }
      const base = needle.split('@')[0]
      const related = base && base !== needle ? seen.rows.filter((row) => row.repo.toLowerCase().startsWith(base)) : []
      return { ok: true, readable: true, found: false, total: seen.rows.length, related: related.slice(0, 10) }
    },
  })
}

export function createSeenAddTool(runtime) {
  return defineTool(runtime, {
    name: 'gh_digest_seen_add',
    description: '把一条记录写进判重表。处置取值：收取 / 跳过 / 待复核。跟版本的写 仓库@tag，没版本就写仓库。',
    parameters: buildParameters({
      repo: { type: 'string', required: true, description: '仓库 full_name，跟版本写 owner/repo@v1.2.0' },
      disposition: { type: 'string', required: true, description: '收取 / 跳过 / 待复核' },
      reason: { type: 'string', description: '一句话理由（为什么要看 / 为什么跳过）' },
      first_seen: { type: 'string', description: '可选：YYYY-MM-DD，缺省今天' },
    }),
    output: TEXT_OUTPUT,
    execute: async (args = {}) => {
      const current = runtime.reloadConfig()
      const paths = runtime.pathsFor(current)
      const raw = toStringSafe(args.repo)
      const base = raw.split('@')[0]
      const ref = parseRepoRef(base)
      if (!raw || !ref) return { ok: false, code: 'BAD_REPO_REF', message: '仓库格式要写 owner/repo，可带 @版本', hint: '例如 ollama/ollama@v0.40.7' }
      const disposition = (toStringSafe(args.disposition) || '待复核').slice(0, 20)
      const reason = toStringSafe(args.reason).slice(0, 300)
      const firstSeen = /^\d{4}-\d{2}-\d{2}$/.test(toStringSafe(args.first_seen)) ? toStringSafe(args.first_seen) : localDate()
      const written = appendRow(paths.seen, 'github-digest 判重表', SEEN_COLUMNS, [raw, disposition, reason, firstSeen])
      if (!written.ok) return { ok: false, code: 'SEEN_WRITE_FAILED', message: '判重表写不进去：' + written.error }
      return { ok: true, file: paths.seen, entry: { repo: raw, disposition, reason, firstSeen } }
    },
  })
}
