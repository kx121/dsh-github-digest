/**
 * gh_digest_info：被唤醒 / 要按用户设置跑一轮时，先调它拿配置，不要靠猜。
 */
import { readHistory } from '../store.js'
import { localDate } from '../util.js'
import { buildParameters, defineTool, TEXT_OUTPUT } from './schema.js'

export function createInfoTool(runtime) {
  return defineTool(runtime, {
    name: 'gh_digest_info',
    description: 'github-digest 的设置与路径：关注仓库、发现模式、过滤条件、读取开关、定时、目标会话、token 状态，以及判重表/执行记录/日报目录的绝对路径。被唤醒或要按用户设置跑一轮时，先调它拿配置，不要靠猜。',
    parameters: buildParameters({}),
    output: TEXT_OUTPUT,
    execute: async () => {
      const current = runtime.reloadConfig()
      const credential = runtime.credentialSnapshot()
      const paths = runtime.pathsFor(current)
      // 当天已跑几轮：报告文件名要用「当天第几轮」，模型自己数会数错。
      const history = readHistory(paths.history, 200)
      const today = localDate()
      const todayRuns = history.filter((row) => String((row && row.at) || '').startsWith(today)).length
      return {
        ok: true,
        enabled: current.enabled,
        watch_repos: current.watch_repos,
        discover_enabled: current.discover_enabled,
        topics: current.topics,
        profile_note: current.profile_note,
        min_stars: current.min_stars,
        discover_created_within_days: current.discover_created_within_days,
        max_items_per_run: current.max_items_per_run,
        max_repos_per_run: current.max_repos_per_run,
        cold_pick_min: current.cold_pick_min,
        cold_pick_max_stars: current.cold_pick_max_stars,
        release_body_chars: current.release_body_chars,
        read_readme: current.read_readme,
        read_releases: current.read_releases,
        read_commits: current.read_commits,
        tokenPresent: credential.present,
        tokenSource: credential.present ? credential.source : '',
        tokenSourceLabel: credential.present ? credential.sourceLabel : '',
        tokenMasked: credential.masked,
        schedule: current.schedule,
        target_session_id: current.target_session_id,
        paths,
        todayRuns,
        runIndexHint: '本轮是当天第 ' + (todayRuns + 1) + ' 轮，报告文件名用 ' + today + '-' + (todayRuns + 1) + '.md',
        note: 'GitHub 只读：不发 issue、不点 star、不改仓库。token 只用于提高限速。',
      }
    },
  })
}
