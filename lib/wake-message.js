/**
 * 唤醒消息：投给会话的第一条消息正文 = 本轮参数 + 操作步骤 + 判断准则全文。
 *
 * 准则文件单独放在 prompts/duty.md，用户可以直接改；读不到时退回一句最小提示，不空转。
 */
import fs from 'node:fs'
import { PROMPT_FILE } from './paths.js'

/** 读判断准则。返回 { text, source }，缺文件不报错。 */
export function readPromptText(file = PROMPT_FILE) {
  try {
    return { text: fs.readFileSync(file, 'utf8'), source: 'plugin' }
  } catch {
    return { text: '', source: 'missing' }
  }
}

/**
 * 拼唤醒消息。
 * meta: { trigger, firedAt, credential: { present, sourceLabel } }
 */
export function buildWakeMessage(config, paths, promptText, meta = {}) {
  const watch = config.watch_repos.length ? config.watch_repos.join('、') : '（还没填关注仓库）'
  // 没填关注仓库但填了主题 → 自动走发现模式，这轮不至于空转。
  const discoverOnly = config.watch_repos.length === 0 && config.topics.length > 0
  const cred = meta.credential || null
  const quotaHint = cred && cred.present
    ? '已带 token（来源：' + (cred.sourceLabel || '未知') + '，5000 次/小时，基本不用管额度）'
    : '匿名访问（60 次/小时：批量元信息 1 次 + 每个细读的仓库 1-2 次，一轮约 3-8 次）'
  const briefHint = config.brief_fetch_releases
    ? '粗筛时会顺带拉 references，可看 hasNew / 版本标题（这条是设置里打开的，会多花配额）'
    : '粗筛只返回元信息，看 pushedSinceLast / unchanged / dormant 三个字段筛'
  const lines = [
    '【github-duty】一轮值班（' + (meta.trigger || 'schedule') + '，' + (meta.firedAt || '') + '）',
    '',
    '关注仓库：' + watch,
    '主题 / 关键词：' + (config.topics.length ? config.topics.join('、') : '（未填）'),
    '我的背景（判断「对我有没有用」的第一依据）：' + (config.profile_note ? config.profile_note : '（没填，按主题和关注仓库推断）'),
    '发现模式：' + (config.discover_enabled ? '开' : (config.watch_repos.length ? '关' : '关注仓库为空时自动启用')),
    '每轮：最多看 ' + config.max_repos_per_run + ' 个仓库、收取 ' + config.max_items_per_run + ' 条｜读取 README：' + (config.read_readme ? '开' : '关'),
    '冷门配额：' + (config.cold_pick_min > 0
      ? '每轮至少收 ' + config.cold_pick_min + ' 条 star ≤ ' + config.cold_pick_max_stars + ' 的项目（搜冷门池时加 stars:<' + config.cold_pick_max_stars + '）'
      : '不限（star ≤ ' + config.cold_pick_max_stars + ' 算冷门）'),
    '额度：' + quotaHint,
    '判重表：' + paths.seen,
    '执行记录：' + paths.runs,
    '日报目录：' + paths.outDir,
    '',
    discoverOnly
      ? '本轮走发现模式（关注仓库为空、但填了主题）：'
      : '步骤（两阶段，不要跳过第一阶段 —— 直接逐个 watch 会把会话上下文撑爆）：',
    discoverOnly
      ? '1) 调 gh_duty_info 拿配置与额度；'
      : '1) 调 gh_duty_info 拿配置和额度；',
    discoverOnly
      ? '2) 调 gh_duty_discover 拿候选（用主题拼接搜索条件），再用 gh_duty_seen_query 排掉看过的；'
      : '2) 粗筛：调一次 gh_duty_brief（不传参数 = 全部关注仓库）。' + briefHint + '；',
    discoverOnly
      ? '3) 对候选调 gh_duty_watch 看正文（每个仓库一次）；'
      : '3) 细读：只对「上次检查后推送过」的仓库调 gh_duty_watch（它已按判重表过滤旧版本）；',
    '4) 写日报到日报目录（文件名当天日期），会话里只回一句结论，不要把仓库正文贴进对话；',
    '5) 调 gh_duty_run_add 写执行记录（失败也写，items_json 必填），每条看过的调 gh_duty_seen_add 记进判重表。',
    '成本：粗筛 40 个仓库约 1 次请求，逐个读正文要 1-2 次/仓库。没有新动静的仓库不要调 watch。',
    '',
    '—— 判断准则 ——',
    promptText || '（准则文件没读到，按常识判断：能解决具体问题、有可跑的代码、版本有实际变化才值得看。）',
  ]
  return lines.join('\n')
}
