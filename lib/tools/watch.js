/**
 * gh_digest_watch：细读一个仓库（元信息 + 新 releases + 增量 commits + 可选 README）。
 */
import { parseRepoRef } from '../repo-ref.js'
import { readSeen, readCachedRepoData, recordRepoVolume } from '../store.js'
import { buildParameters, defineTool, githubError, TEXT_OUTPUT } from './schema.js'

export function createWatchTool(runtime) {
  return defineTool(runtime, {
    name: 'gh_digest_watch',
    description: '看一个仓库最近的变化：仓库元信息 + 最近 releases + 最近 commits（可选 README 开头）。一个仓库调一次就够，别拆成多次反复打接口（每仓库约 1-3 次请求；匿名 60 次/小时，有 token 5000 次/小时）。',
    parameters: buildParameters({
      repo: { type: 'string', required: true, description: '仓库 full_name，例如 deepseek-ai/deepseek-harness' },
      releases: { type: 'number', description: '拉几个最近 release，默认 3，最多 10' },
      commits: { type: 'number', description: '拉几条最近 commit，默认 3，最多 20' },
    }),
    output: TEXT_OUTPUT,
    execute: async (args = {}) => {
      const current = runtime.reloadConfig()
      const client = runtime.clientFor(current)
      const ref = parseRepoRef(args.repo)
      if (!ref) return { ok: false, code: 'BAD_REPO_REF', message: '仓库格式要写 owner/repo', hint: '例如 deepseek-ai/deepseek-harness' }

      const paths = runtime.pathsFor(current)
      // 优先用本轮 brief 已经拿到的数据，不再重复请求（304 也计配额，实测）。
      const cached = readCachedRepoData(paths.pending, ref.fullName)
      let meta = cached.meta
      if (!meta) {
        const info = await client.repo(ref.fullName)
        if (!info.ok) return githubError(info.error, { repo: ref.fullName })
        meta = info.repo
      }
      const out = {
        ok: true,
        repo: meta,
        dataSource: cached.meta ? 'brief-cache' : 'api',
      }

      // 增量：判重表里已记录的 仓库@tag 不再返回正文 —— 这是省 token 的主要手段。
      const seen = readSeen(paths.seen)
      const seenKeys = new Set(seen.readable ? seen.rows.map((row) => row.repo.toLowerCase()) : [])
      if (current.read_releases) {
        let releases = cached.releases
        if (!releases) {
          const rel = await client.releases(ref.fullName, {
            perPage: Math.min(10, Math.max(1, Number(args.releases) || 3)),
            bodyChars: current.release_body_chars,
          })
          if (rel.ok) releases = rel.releases
          else out.releasesError = githubError(rel.error)
        } else {
          out.releasesCached = true
        }
        if (releases) {
          out.releases = releases.filter((item) => !seenKeys.has((ref.fullName + '@' + item.tag).toLowerCase()))
          out.releasesSkipped = releases.length - out.releases.length
          if (!out.releases.length) out.note = '最近几个 release 都已在判重表里，没有新版本'
        }
      }

      if (current.read_commits) {
        const repoRows = seen.readable ? seen.rows.filter((row) => row.repo.toLowerCase().startsWith(ref.fullName.toLowerCase())) : []
        const since = repoRows.length ? repoRows[repoRows.length - 1].firstSeen : ''
        const com = await client.commits(ref.fullName, {
          perPage: Math.min(20, Math.max(1, Number(args.commits) || 3)),
          branch: meta.defaultBranch,
          since,
        })
        out.commits = com.ok ? com.commits : []
        out.commitsSince = since || '全部历史'
        if (!com.ok) out.commitsError = githubError(com.error)
      }

      if (current.read_readme) {
        const rm = await client.readme(ref.fullName, { maxChars: 1200 })
        out.readme = rm.ok ? rm.text : ''
        if (!rm.ok) out.readmeError = githubError(rm.error)
      }

      out.quota = client.quotaText()
      out.seenFiltered = seen.readable
      recordRepoVolume(paths.pending, ref.fullName, out)
      return out
    },
  })
}
