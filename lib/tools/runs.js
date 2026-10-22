/**
 * gh_duty_run_add：一轮结束收尾。
 *
 * 做四件事：
 *   1. 往 runs.md 追加人类可读的一行（每轮都写，失败也写）；
 *   2. 解析 items_json，连同本轮体积 / 成本写进 history.jsonl（面板读这个）；
 *   3. 本轮成本用「结束累计 − 开始基线」算（见 cost.js）；
 *   4. 清掉 pending-run.json，避免下一轮误用这一轮的会话。
 */
import {
  appendRow, appendHistory, readPending, clearPending, readSeen,
  readPendingCandidates, clearPendingCandidates,
  summarizeRepoVolume, seenBaseRepo, RUN_COLUMNS, SEEN_COLUMNS,
} from '../store.js'
import { computeRoundCost } from '../cost.js'
import { localDate, localStamp, toStringSafe } from '../util.js'
import { buildParameters, defineTool, TEXT_OUTPUT } from './schema.js'

const MAX_ITEMS_JSON = 128 * 1024

export function createRunAddTool(runtime) {
  return defineTool(runtime, {
    name: 'gh_duty_run_add',
    description: '往执行记录（runs.md）追加一行。每轮结束都要写，失败也要写，不许静默。列口径：时间 | 触发 | 结果 | 关注 | 收取 | 跳过 | 额度 | 备注。',
    parameters: buildParameters({
      trigger: { type: 'string', required: true, description: 'manual | schedule | plugin' },
      result: { type: 'string', required: true, description: 'ok | partial | failed' },
      watched: { type: 'number', description: '看了几个仓库' },
      kept: { type: 'number', description: '收取几条' },
      skipped: { type: 'number', description: '跳过几条' },
      quota: { type: 'string', description: '额度，如 42/60' },
      note: { type: 'string', description: '失败原因或补充说明' },
      items_json: { type: 'string', description: '本轮明细的 JSON 数组字符串（给侧边栏面板用），每项：{"repo":"owner/repo","stars":123,"verdict":"worth|skip|watch","confidence":"high|medium|low","source":"watch|discover","what":"这是什么项目（首次收录必写）","whatChanged":"变了什么","impact":"对你的影响","action":"建议"}。source = 这条是从关注列表看的（watch）还是按主题发现的（discover），面板靠它分「发现 / 关注」两栏；不写就按当前关注列表反推。发现模式本轮看过的候选如果没写判重表，插件会自动补记（返回 autoSeen 条数）。' },
      time: { type: 'string', description: '可选：YYYY-MM-DD HH:mm:ss，缺省当前时间' },
    }),
    output: TEXT_OUTPUT,
    execute: async (args = {}) => {
      const current = runtime.reloadConfig()
      const paths = runtime.pathsFor(current)
      const timeText = toStringSafe(args.time)
      const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeText) ? timeText : localStamp()
      const watched = Number(args.watched) || 0
      const kept = Number(args.kept) || 0
      const skipped = Number(args.skipped) || 0
      const trigger = (toStringSafe(args.trigger) || 'manual').slice(0, 20)
      const result = (toStringSafe(args.result) || 'ok').slice(0, 20)
      const quota = toStringSafe(String(args.quota == null ? '' : args.quota)).slice(0, 40)
      const note = toStringSafe(args.note).slice(0, 500)

      const written = appendRow(paths.runs, 'github-duty 执行记录', RUN_COLUMNS, [
        at, trigger, result, watched, kept, skipped, quota || '-', note,
      ])

      // 面板要的是结构化数据：runs.md 给人看，history.jsonl 给界面读。
      let items = []
      let itemsError = ''
      const rawItems = typeof args.items_json === 'string' ? args.items_json.trim() : ''
      if (rawItems) {
        if (rawItems.length > MAX_ITEMS_JSON) {
          itemsError = 'items_json 超过 ' + Math.round(MAX_ITEMS_JSON / 1024) + 'KB，已忽略'
        } else {
          try {
            const parsed = JSON.parse(rawItems)
            if (Array.isArray(parsed)) items = parsed.slice(0, 50)
            else itemsError = 'items_json 不是数组'
          } catch (err) {
            itemsError = 'items_json 解析失败：' + String((err && err.message) || err)
          }
        }
      }

      // 兜底补记判重表：模型漏写会让下一轮原样再出现同一批候选（实测发生过）。
      //   1) items_json 里本轮已处理的仓库按 verdict 补记；
      //   2) 发现模式看过、但没处理的候选记成「跳过」。
      // 判重表读不出来时一律不补 —— 「读不出来」不等于「没记录过」。
      const candidates = readPendingCandidates(paths.candidates)
      const seenBefore = readSeen(paths.seen)
      let autoSeen = 0
      if (seenBefore.readable) {
        const seenKeys = new Set(seenBefore.rows.map((row) => seenBaseRepo(row && row.repo)))
        const handledRepos = new Set()
        const today = localDate()
        const recordOne = (repo, disposition, reason) => {
          const key = seenBaseRepo(repo)
          if (!key || handledRepos.has(key)) return
          handledRepos.add(key)
          if (seenKeys.has(key)) return
          const writtenSeen = appendRow(paths.seen, 'github-duty 判重表', SEEN_COLUMNS, [repo, disposition, reason, today])
          if (writtenSeen.ok) {
            autoSeen += 1
            seenKeys.add(key)
          }
        }
        for (const item of items) {
          const verdict = String((item && item.verdict) || '').toLowerCase()
          const disposition = verdict === 'worth' ? '收取' : (verdict === 'watch' ? '待复核' : '跳过')
          recordOne(String((item && item.repo) || ''), disposition, '本轮已处理（自动补记）')
        }
        for (const candidate of candidates.repos) {
          recordOne(candidate.repo, '跳过', '本轮粗筛未细读（自动补记）')
        }
        clearPendingCandidates(paths.candidates)
      }

      const pending = readPending(paths.pending)
      const record = {
        at,
        atMs: Date.now(),
        trigger,
        result,
        watched,
        kept,
        skipped,
        quota,
        note,
        sessionId: pending && pending.sessionId ? pending.sessionId : '',
        fireAtMs: pending && pending.at ? pending.at : 0,
        items,
        // 每个仓库这轮吐了多少（估算 token），面板用来算平均与最贵项目。
        repoVolume: summarizeRepoVolume(pending && pending.repos),
        // 本轮精确消耗（token + 人民币），来自会话投影缓存的前后差值。
        cost: computeRoundCost(pending, {
          projcacheDir: runtime.env.projcacheDir,
          ledgerFile: runtime.env.ledgerFile,
          today: runtime.env.today(),
        }),
      }
      appendHistory(paths.history, record)
      clearPending(paths.pending)

      const base = {
        file: paths.runs,
        history: paths.history,
        itemCount: items.length,
        repoVolume: record.repoVolume,
        autoSeen,
        cost: record.cost,
        itemsError,
      }
      return written.ok
        ? { ok: true, ...base }
        : { ok: false, code: 'RUN_ADD_FAILED', message: '执行记录写不进去：' + written.error, ...base }
    },
  })
}
