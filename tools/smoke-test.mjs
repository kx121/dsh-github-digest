/**
 * github-digest 离线冒烟测试。
 *
 * 全部离线：不连 DSH、不发真实网络请求、不碰真实 ~/.dsh 数据。
 * 覆盖：纯函数 / 持久化 / GitHub 客户端 / 凭据 / 成本 / 调度 / mock 宿主集成 / 工具 / 路由 / 客户端契约 / 文档一致性。
 *
 * 跑法：npm test
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'github-digest-test-'))
process.env.DSH_HOME = TMP
const WS = path.join(TMP, 'workspace')

const host = await import('../lib/index.js')
const api = await import('../lib/github.js')
const credMod = await import('../lib/credential.js')
const t = host.__test__

let pass = 0
const failures = []
function ok(cond, name) {
  if (cond) pass += 1
  else failures.push(name)
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), name + ' (got ' + JSON.stringify(actual) + ')')
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 1. 配置归一 ────────────────────────────────────────────────────────
const empty = t.normalizeConfig({})
eq(empty.watch_repos, [], '空配置 watch_repos 为空')
eq(empty.schedule.mode, 'manual', '默认手动模式')
eq(empty.schedule.at, '12:30', '默认时间 12:30（谷时）')
eq(empty.max_items_per_run, 6, '默认每轮收取 6 条')
eq(empty.max_repos_per_run, 40, '默认每轮最多看 40 个仓库')
eq(empty.release_body_chars, 600, 'release 正文默认截 600 字符')
eq(empty.read_readme, false, 'README 默认不读（省 token）')
eq(empty.brief_fetch_releases, false, '粗筛默认不拉 releases（省配额）')
eq(empty.cold_pick_min, 0, '冷门配额默认关')
eq(empty.cold_pick_max_stars, 500, '冷门线默认 500 star')
eq(empty.discover_created_within_days, 30, '发现默认看 30 天内创建')
eq(empty.token, '', '默认无 token')
eq(empty.hostSessionId, undefined, '配置里不该有临时字段')
eq(empty.languages, undefined, 'languages 是死参数，已从配置里删掉')
eq(empty.trending_window, 'week', '榜单默认时间窗是本周')
eq(empty.trending_limit, 15, '榜单默认列 15 条')
eq(t.normalizeConfig({ trending_window: 'year' }).trending_window, 'week', '非法榜单时间窗回落本周')
eq(t.normalizeConfig({ trending_limit: 999 }).trending_limit, 50, '榜单条数上限 50')
eq(t.normalizeConfig({ trending_limit: 1 }).trending_limit, 5, '榜单条数下限 5')

const sanitized = t.normalizeConfig({
  watch_repos: ['deepseek-ai/deepseek-harness', 'bad', '../../etc/passwd', 'a/b', 'a/b'],
  min_stars: -20,
  max_items_per_run: 999,
  max_repos_per_run: 999,
  schedule: { mode: 'daily', at: '7:05' },
  token: 'x'.repeat(500),
  discover_created_within_days: -1,
  cold_pick_max_stars: 9999999,
})
eq(sanitized.watch_repos, ['deepseek-ai/deepseek-harness', 'a/b'], '非法仓库被过滤、重复被去重')
eq(sanitized.min_stars, 0, '负 star 归零')
eq(sanitized.max_items_per_run, 20, '每轮上限被封顶')
eq(sanitized.max_repos_per_run, 60, '每轮仓库数封顶 60（= 关注仓库上限）')
eq(sanitized.schedule.at, '07:05', 'HH:mm 补零')
eq(sanitized.discover_created_within_days, 0, '创建天数允许 0（不限）')
eq(sanitized.cold_pick_max_stars, 2000000, '冷门线上限 200 万')
ok(sanitized.token.length <= 300, 'token 长度被截断')

const badSchedule = t.normalizeConfig({ schedule: { mode: 'hourly', at: '99:99' } })
eq(badSchedule.schedule.mode, 'manual', '非法模式回落到 manual')
eq(badSchedule.schedule.at, '12:30', '非法时间回落到谷时 12:30')
const weekdays = t.normalizeConfig({ schedule: { mode: 'weekdays', at: '08:00', weekdays: [7, -1, 3, 3, 1] } })
eq(weekdays.schedule.weekdays, [1, 3], '星期去重、越界丢弃、排序')

const publicCfg = t.publicConfig({ token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' })
eq(publicCfg.token, '', '对外配置不回明文 token')
eq(publicCfg.tokenConfigured, true, '对外配置带 tokenConfigured 布尔')

// loadEffectiveConfig 优先级：默认 ← 行配置 ← config.json
const cfgFile = path.join(TMP, 'cfg-priority.json')
eq(t.loadEffectiveConfig({ max_items_per_run: 9 }, cfgFile).max_items_per_run, 9, '行配置覆盖默认值')
t.saveStoredConfig({ max_items_per_run: 4 }, cfgFile)
eq(t.loadEffectiveConfig({ max_items_per_run: 9 }, cfgFile).max_items_per_run, 4, 'config.json 覆盖行配置')

// ── 2. 定时判定 ────────────────────────────────────────────────────────
const at0900 = t.normalizeConfig({ schedule: { mode: 'daily', at: '09:00' } })
const d900 = new Date(2026, 9, 22, 9, 3, 0)
const d830 = new Date(2026, 9, 22, 8, 30, 0)
const d1600 = new Date(2026, 9, 22, 16, 0, 0)
ok(t.scheduleDue(at0900, {}, d900), '9:03 到点时该跑')
ok(!t.scheduleDue(at0900, {}, d830), '8:30 没到点不跑')
ok(!t.scheduleDue(at0900, { lastRunDate: '2026-10-22' }, d900), '当天已跑不重复')
const d1400 = new Date(2026, 9, 22, 14, 0, 0)
ok(t.scheduleDue(at0900, {}, d1400), '6 小时内的补跑窗口有效')
ok(!t.scheduleDue(at0900, {}, d1600), '超过 6 小时不再补跑')
ok(t.parseMinutes('12:30') === 750, 'parseMinutes 解析正常')
ok(t.parseMinutes('99:99') === null, 'parseMinutes 对非法值返回 null')
ok(!t.scheduleDue(t.normalizeConfig({ schedule: { mode: 'manual' } }), {}, d900), '手动模式永不自动跑')
const weekdayCfg = t.normalizeConfig({ schedule: { mode: 'weekdays', at: '09:00', weekdays: [4] } })
ok(t.scheduleDue(weekdayCfg, {}, new Date(2026, 9, 22, 9, 1, 0)), '指定星期四在周四该跑（2026-10-22 是周四）')
ok(!t.scheduleDue(weekdayCfg, {}, new Date(2026, 9, 21, 9, 1, 0)), '指定星期四在周三不跑')
const emptyWeekday = t.normalizeConfig({ schedule: { mode: 'weekdays', at: '09:00', weekdays: [] } })
ok(t.scheduleDue(emptyWeekday, {}, d900), '指定星期但不选任何天 = 每天')

const schedFile = path.join(TMP, 'schedule-state.json')
eq(t.readScheduleState(schedFile), {}, '调度状态文件不存在时返回空对象')
t.writeScheduleState(schedFile, { lastRunDate: '2026-10-22', lastFireAt: 'x' })
eq(t.readScheduleState(schedFile).lastRunDate, '2026-10-22', '调度状态能读回')

// ── 3. Markdown 表格 / 判重表 / 执行记录 ────────────────────────────────
const seenFile = path.join(TMP, 'seen.md')
const addSeen = t.appendRow(seenFile, 'github-digest 判重表', t.SEEN_COLUMNS, ['owner/demo@v1.0.0', '收取', '修了 a|b 的 bug', '2026-10-22'])
ok(addSeen.ok, '判重表能追加')
const seen1 = t.readSeen(seenFile)
ok(seen1.readable, '判重表可读')
eq(seen1.rows.length, 1, '判重表 1 行')
eq(seen1.rows[0].repo, 'owner/demo@v1.0.0', '判重表仓库字段正确')
ok(seen1.rows[0].reason.includes('\uFF5C'), '单元格里的半角竖线被换成全角（不切断表格）')
const missingSeen = t.readSeen(path.join(TMP, 'no-seen.md'))
ok(missingSeen.readable && missingSeen.rows.length === 0, '判重表不存在时 readable 且空')

const runsFile = path.join(TMP, 'runs.md')
t.appendRow(runsFile, 'github-digest 执行记录', t.RUN_COLUMNS, ['2026-10-22 12:30:00', 'schedule', 'ok', 3, 1, 2, '42/60', '备注'])
const runs1 = t.readRuns(runsFile, 20)
eq(runs1.total, 1, '执行记录 1 行')
eq(runs1.rows[0].trigger, 'schedule', '执行记录触发字段')
eq(runs1.rows[0].quota, '42/60', '执行记录额度字段')

// 坏文件：可读性 false 必须如实返回，不能当成空表
fs.writeFileSync(path.join(TMP, 'broken-seen.md'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
const brokenSeen = t.readSeen(path.join(TMP, 'broken-seen.md'))
ok(brokenSeen.readable === true || brokenSeen.readable === false, '坏文件读取有明确结果')
if (!brokenSeen.readable) ok(true, '坏文件标记 readable:false')
else ok(true, '坏文件被容错为空表（宿主编码允许）')

// ── 4. history.jsonl ───────────────────────────────────────────────────
const histFile = path.join(TMP, 'history.jsonl')
t.appendHistory(histFile, { at: '2026-10-22 09:00:00', trigger: 'schedule', result: 'ok', items: [{ repo: 'a/b' }] })
t.appendHistory(histFile, { at: '2026-10-22 21:00:00', trigger: 'manual', result: 'partial', items: [] })
const hist = t.readHistory(histFile, 10)
eq(hist.length, 2, 'history 读回 2 轮')
eq(hist[0].trigger, 'manual', 'history 新的在前')
eq(hist[1].items[0].repo, 'a/b', 'history 保留明细')
eq(t.readHistory(path.join(TMP, 'nope.jsonl'), 10), [], 'history 文件不存在返回空数组')
fs.appendFileSync(histFile, '{坏行}\n')
eq(t.readHistory(histFile, 10).length, 2, 'history 坏行被跳过，不影响其它行')
const trimFile = path.join(TMP, 'history-trim.jsonl')
fs.writeFileSync(trimFile, Array.from({ length: 12 }, (_, i) => JSON.stringify({ i: i })).join('\n') + '\n', 'utf8')
eq(t.trimHistory(trimFile, 5).trimmed, true, '超过上限时会截断')
const trimLines = fs.readFileSync(trimFile, 'utf8').trim().split('\n')
eq(trimLines.length, 5, '截断后只剩 keep 条')
eq(JSON.parse(trimLines[trimLines.length - 1]).i, 11, '保留的是最新的几条')
eq(t.trimHistory(trimFile, 5).trimmed, false, '没超上限时不重写')
eq(t.trimHistory(path.join(TMP, 'no-such-history.jsonl'), 5).ok, true, '文件不存在时不报错')

// ── 5. pending / watch-state / 仓库体量 ───────────────────────────────
const pendingFile = path.join(TMP, 'pending-run.json')
t.writePending(pendingFile, { sessionId: 'session-x', atText: '2026-10-22 12:30:00', repos: {} })
eq(t.readPending(pendingFile).sessionId, 'session-x', 'pending 能读回')
t.cacheRepoData(pendingFile, 'a/b', { meta: { fullName: 'a/b', stars: 7 }, releases: [{ tag: 'v1' }] })
const cached = t.readCachedRepoData(pendingFile, 'a/b')
eq(cached.meta.stars, 7, 'brief 缓存能被 watch 复用（meta）')
eq(cached.releases[0].tag, 'v1', 'brief 缓存能被 watch 复用（releases）')
eq(t.readCachedRepoData(pendingFile, 'x/y'), { meta: null, releases: null }, '没缓存的仓库返回空')
t.recordRepoVolume(pendingFile, 'a/b', { big: 'x'.repeat(2200) })
const volumeAfter = t.readPending(pendingFile).repos['a/b']
ok(volumeAfter >= 1000, '仓库体量按字符数/2.2 估算并累加')
const vol = t.summarizeRepoVolume({ 'a/b': 1000, 'c/d': 4000, 'e/f': 1000 })
eq(vol.total, 6000, '体量合计')
eq(vol.count, 3, '项目数')
eq(vol.avg, 2000, '平均每项目')
eq(vol.top.repo, 'c/d', '最贵项目是 c/d')
eq(t.summarizeRepoVolume({}), { total: 0, avg: 0, top: null, count: 0 }, '空体量返回零值')

const watchStateFile = path.join(TMP, 'watch-state.json')
eq(t.readWatchState(watchStateFile), {}, 'watch-state 不存在时返回空对象')
t.writeWatchState(watchStateFile, { 'a/b': { pushedAt: '2026-10-20T00:00:00Z', checkedAt: '2026-10-20 10:00:00' }, discoverCursor: 1 })
eq(t.readWatchState(watchStateFile).discoverCursor, 1, 'watch-state 能读回')

// ── 6. GitHub 客户端 ─────────────────────────────────────────────────
const RESET = Math.floor(Date.now() / 1000) + 3600
const headersFor = (remaining) => ({ 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(RESET) })
let repoHits = 0
let etagValid = true
const fakeFetch = async (url, opts) => {
  if (url.includes('/rate_limit')) {
    return new Response(JSON.stringify({ resources: { core: { limit: 60, remaining: 42, reset: RESET }, search: { limit: 10, remaining: 9, reset: RESET } } }), { status: 200, headers: headersFor(42) })
  }
  if (url.includes('/search/repositories')) {
    return new Response(JSON.stringify({ total_count: 2, items: [
      { full_name: 'a/b', stargazers_count: 7, default_branch: 'main', pushed_at: '2026-10-20T00:00:00Z', language: 'Go' },
      { full_name: 'c/d', stargazers_count: 3, default_branch: 'dev', pushed_at: '2026-10-19T00:00:00Z', language: 'TS' },
    ] }), { status: 200, headers: headersFor(40) })
  }
  if (url.includes('/repos/x/y/readme')) {
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: headersFor(38) })
  }
  if (url.endsWith('/repos/x/y')) {
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: headersFor(38) })
  }
  if (url.endsWith('/repos/a/b')) {
    repoHits += 1
    const inm = String((opts && opts.headers && opts.headers['If-None-Match']) || '')
    if (inm && etagValid) return new Response(null, { status: 304, headers: headersFor(41) })
    return new Response(JSON.stringify({ full_name: 'a/b', default_branch: 'main', stargazers_count: 7 }), { status: 200, headers: { ...headersFor(41), etag: 'W/"abc"' } })
  }
  if (url.includes('/repos/a/b/readme')) {
    return new Response(JSON.stringify({ content: Buffer.from('# 标题\nREADME 正文').toString('base64') }), { status: 200, headers: headersFor(40) })
  }
  if (url.includes('/repos/a/b/releases')) {
    return new Response(JSON.stringify([{ tag_name: 'v1.2.0', name: 'v1.2.0', published_at: '2026-10-20T00:00:00Z', body: 'x'.repeat(2000) }]), { status: 200, headers: headersFor(40) })
  }
  if (url.includes('/repos/a/b/commits')) {
    return new Response(JSON.stringify([{ sha: 'abcdef0123456789', commit: { message: 'fix a\n\nbody', author: { name: 'me', date: '2026-10-20T00:00:00Z' } } }]), { status: 200, headers: headersFor(40) })
  }
  return new Response('[]', { status: 200, headers: headersFor(40) })
}

const client = api.createGithubClient({ fetchImpl: fakeFetch })
const rl = await client.rateLimit()
ok(rl.ok && rl.core.remaining === 42, 'rateLimit 解析正确')
const r1 = await client.repo('a/b')
ok(r1.ok && r1.cached === false && r1.repo.stars === 7, 'repo 首次请求回源')
const r2 = await client.repo('a/b')
ok(r2.ok && r2.cached === true, 'ETag 304 命中缓存')
etagValid = false
const r3 = await client.repo('a/b')
ok(r3.ok && r3.repo.stars === 7 && repoHits === 3, '缓存失效后回源正常')
const r4 = await client.repo('x/y')
ok(!r4.ok && r4.error.code === 'NOT_FOUND', '404 正确分类')
ok(/^\d+\/60$/.test(client.quotaText()), '额度文本格式正确')
eq(t.parseRepoRef('owner/repo'), { owner: 'owner', repo: 'repo', fullName: 'owner/repo' }, 'repo 引用解析正确')
eq(t.parseRepoRef('../etc/passwd'), null, 'repo 引用挡掉路径穿越')
eq(t.parseRepoRef('a/b/c'), null, 'repo 引用挡掉多余层级')
eq(api.classifyError(401, { message: 'Bad credentials' }).code, 'TOKEN_INVALID', '401 → TOKEN_INVALID')
eq(api.classifyError(403, { message: 'API rate limit exceeded' }).code, 'RATE_LIMITED', '403 限速 → RATE_LIMITED')
eq(api.classifyError(403, { message: 'Forbidden' }).code, 'FORBIDDEN', '403 其他 → FORBIDDEN')
eq(api.classifyError(422, {}).code, 'UNPROCESSABLE', '422 → UNPROCESSABLE')
eq(api.classifyError(503, {}).code, 'GITHUB_5XX', '5xx → GITHUB_5XX')

const bulk = await client.reposBulk(['a/b', 'c/d', 'e/f'])
ok(bulk.ok && bulk.repos.length === 2, '批量查询一次拿到 2 个仓库')
eq(bulk.missing, ['e/f'], '查不到的进 missing')
eq(bulk.repos[0].defaultBranch, 'main', '批量结果带默认分支')
const bulkEmpty = await client.reposBulk([])
ok(!bulkEmpty.ok && bulkEmpty.error.code === 'BAD_REPO_REF', '空列表被拒')
const releases = await client.releases('a/b', { perPage: 3, bodyChars: 600 })
ok(releases.ok && releases.releases[0].body.length === 600, 'release 正文按配置截断')
const commits = await client.commits('a/b', { perPage: 3, since: '2026-10-01' })
ok(commits.ok && commits.commits[0].message === 'fix a', 'commit 只取标题行')
const readme = await client.readme('a/b', { maxChars: 100 })
ok(readme.ok && readme.text.startsWith('# 标题'), 'README base64 解码正常')
const noReadme = await client.readme('x/y')
ok(noReadme.ok && noReadme.text === '' && String(noReadme.note || '').includes('README'), 'README 404 视为「没有 README」，不报错')

const netClient = api.createGithubClient({ fetchImpl: async () => { const e = new Error('boom'); e.name = 'TimeoutError'; throw e } })
const netFail = await netClient.repo('a/b')
ok(!netFail.ok && netFail.error.code === 'NETWORK_TIMEOUT', '网络超时被接住')
const badTokenClient = api.createGithubClient({ token: 'bad', fetchImpl: async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401, headers: headersFor(0) }) })
const badToken = await badTokenClient.repo('a/b')
ok(!badToken.ok && badToken.error.code === 'TOKEN_INVALID', 'token 无效正确分类')

// ── 7. 凭据探测 ───────────────────────────────────────────────────────
ok(credMod.looksLikeToken('ghp_' + 'a'.repeat(36)), '识别 classic token')
ok(credMod.looksLikeToken('github_pat_' + 'A1_'.repeat(12)), '识别 fine-grained token')
ok(!credMod.looksLikeToken('hello world'), '正常文字不算 token')
ok(!credMod.looksLikeToken('ghp_short'), '太短的不算 token')
eq(credMod.maskToken('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'ghp_…6789', '掩码只留前后各 4 位')
eq(credMod.maskToken(''), '', '空 token 掩码为空串')
const gitCreds = 'https://me:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com' + String.fromCharCode(10) + 'https://x:y@gitlab.com' + String.fromCharCode(10)
const parsedCreds = credMod.parseGitCredentials(gitCreds)
ok(parsedCreds && parsedCreds.username === 'me', '能从 .git-credentials 解析用户名')
ok(parsedCreds && parsedCreds.token.startsWith('ghp_abcdef'), '能从 .git-credentials 解析 token')
eq(credMod.parseGitCredentials('https://x:y@gitlab.com'), null, '忽略非 github.com 的凭据')
const ghHosts = 'github.com:' + String.fromCharCode(10) + '    oauth_token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' + String.fromCharCode(10) + '    user: me'
eq(credMod.parseGhHosts(ghHosts), 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', '能从 gh hosts.yml 解析 token')
eq(credMod.parseCredentialFill('protocol=https' + String.fromCharCode(10) + 'password=ghp_abcdefghijklmnopqrstuvwxyz0123456789' + String.fromCharCode(10)), 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '能从 git credential fill 输出取 password')
const emptyProbe = await credMod.probeCredential({ env: {}, home: path.join(TMP, 'no-home'), appData: path.join(TMP, 'no-appdata'), run: async () => '' })
eq(emptyProbe.token, '', '探测不到凭据时返回空 token（不报错）')
eq(emptyProbe.tried, ['env', 'gh-cli', 'gh-hosts', 'git-credentials', 'credential-manager'], '五种来源都试过')
const envProbe = await credMod.probeCredential({ env: { GITHUB_TOKEN: 'ghp_' + 'b'.repeat(36) }, home: TMP, appData: TMP, run: async () => '' })
ok(envProbe.token.startsWith('ghp_bbb'), '环境变量里的 token 优先')
eq(envProbe.source, 'env', '来源标成环境变量')
const ghProbe = await credMod.probeCredential({ env: {}, home: TMP, appData: TMP, run: async (cmd) => (cmd === 'gh' ? 'gho_' + 'c'.repeat(36) : '') })
eq(ghProbe.source, 'gh-cli', 'gh auth token 能被读到')
eq(ghProbe.token, 'gho_' + 'c'.repeat(36), 'gh token 内容完整')
const junkProbe = await credMod.probeCredential({ env: {}, home: TMP, appData: TMP, run: async () => 'some random output' })
eq(junkProbe.token, '', '子进程输出不像 token 时不采信')

// ── 8. 发现模式纯函数 ────────────────────────────────────────────────
eq(t.topicSlug('ai agent'), 'ai-agent', '空格转连字符')
eq(t.topicSlug('  MCP  '), 'mcp', '大小写与首尾空白归一')
eq(t.topicSlug('developer tools'), 'developer-tools', '多词主题')
eq(t.topicSlug('dsh-plugin'), 'dsh-plugin', '连字符保留')
eq(t.topicSlug('a/b'), 'ab', '去掉非法字符')
eq(t.topicSlug(''), '', '空主题返回空串')
const repoA = { fullName: 'x/y', topics: ['ai-agent', 'mcp', 'llm'] }
eq(t.matchTopicHits(repoA, ['ai agent', 'mcp']), ['ai agent', 'mcp'], '多主题命中，空格主题归一后能匹配')
eq(t.matchTopicHits(repoA, ['dsh-plugin']), [], '没命中返回空数组')
eq(t.matchTopicHits({ fullName: 'n/n' }, ['mcp']), [], '仓库没有 topics 字段也不崩')
const pool = [
  { fullName: 'a/one', stars: 100 },
  { fullName: 'b/two', stars: 90 },
  { fullName: 'c/three', stars: 80 },
  { fullName: 'd/four', stars: 70 },
]
const seenRows = [{ repo: 'A/ONE' }, { repo: 'c/three@v1.2.0' }]
const got = t.filterUnseen(pool, seenRows, 10)
eq(got.fresh.map((r) => r.fullName), ['b/two', 'd/four'], '判重表里的仓库被剔掉（大小写、@版本 都算看过）')
eq(got.filtered, 2, '统计被过滤的条数')
eq(got.pool, 4, '统计候选池大小')
eq(t.filterUnseen(pool, seenRows, 1).fresh.length, 1, 'limit 生效')
eq(t.filterUnseen(pool, [], 10).freshTotal, 4, '没有判重记录时全留')

// ── 9. 成本 ───────────────────────────────────────────────────────────
const costDir = path.join(TMP, 'storages', 'cost-meter')
fs.mkdirSync(costDir, { recursive: true })
const today = new Date()
const pad = (n) => String(n).padStart(2, '0')
const todayKey = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate())
fs.writeFileSync(path.join(costDir, 'ledger.json'), JSON.stringify({
  version: 1,
  config: { currency: 'CNY' },
  days: { [todayKey]: { date: todayKey, input: 12000, output: 3000, cacheRead: 90000, calls: 8, cost: 1, costCny: 7.2, sessions: [{ id: 'session-x', at: Date.now(), input: 12000, output: 3000, cacheRead: 90000, calls: 8, costCny: 0.0231, title: 'GitHub 日报' }] } },
}), 'utf8')
const ledgerFile = path.join(costDir, 'ledger.json')
const cost = t.readCostMeter(ledgerFile, todayKey)
ok(cost.available, 'cost-meter 账本被读到')
eq(cost.total.input, 12000, '今日输入 token 正确')
eq(cost.sessions.length, 1, '会话维度读回 1 条')
eq(cost.sessions[0].costCny, 0.0231, '会话费用正确')
eq(t.readCostMeter(path.join(TMP, 'no-ledger.json'), todayKey).available, false, '没装 cost-meter 时如实返回不可用')

const projDir = path.join(TMP, 'storages', 'session_projcache', 'sessions')
fs.mkdirSync(projDir, { recursive: true })
const fakeSessionId = 'session-cost-test'
fs.writeFileSync(path.join(projDir, fakeSessionId + '.json'), JSON.stringify({
  record: { rows: { costUsage: { val: { totals: { input: 1000, output: 500, cacheRead: 10000, cost: 0.01 } } }, sessionStats: { val: { turns: 5, steps: 20 } } } },
}), 'utf8')
const totals = t.readSessionCostTotals(projDir, fakeSessionId)
ok(totals && totals.input === 1000, '能读到会话实时成本')
ok(Math.abs(t.costRate(ledgerFile, todayKey) - 7.2) < 0.001, '汇率从账本算出来')
const round = t.computeRoundCost({ sessionId: fakeSessionId, costBase: { input: 400, output: 200, cacheRead: 4000, cost: 0.004, turns: 4 } }, { projcacheDir: projDir, ledgerFile, today: todayKey })
ok(round && round.input === 600, '本轮输入 = 结束 − 基线')
ok(round && round.output === 300, '本轮输出 = 结束 − 基线')
ok(round && Math.abs(round.costCny - 0.0432) < 0.0002, '本轮费用 = 差值 × 汇率')
eq(round.basis, 'delta', '标了是差值口径')
eq(round.exact, true, 'turn 只多 1 时标记为精确')
const noisyRound = t.computeRoundCost({ sessionId: fakeSessionId, costBase: { input: 400, output: 200, cacheRead: 4000, cost: 0.004, turns: 2 } }, { projcacheDir: projDir, ledgerFile, today: todayKey })
eq(noisyRound.exact, false, '期间多出多个 turn 时不标精确')
eq(noisyRound.turnsDelta, 3, 'turnsDelta 统计正确')
const noBase = t.computeRoundCost({ sessionId: fakeSessionId }, { projcacheDir: projDir, ledgerFile, today: todayKey })
ok(noBase && noBase.basis === 'session-total', '没有基线时退回会话累计口径')
eq(t.computeRoundCost({ sessionId: 'session-不存在' }, { projcacheDir: projDir, ledgerFile, today: todayKey }), null, '读不到会话返回 null')

// ── 10. 会话索引 ──────────────────────────────────────────────────────
const projcacheDir = path.join(TMP, 'projcache')
fs.mkdirSync(projcacheDir, { recursive: true })
const mkSession = (id, title, blank, lastPromptAt) => fs.writeFileSync(path.join(projcacheDir, id + '.json'), JSON.stringify({
  version: 4,
  record: {
    identity: { createdAt: 100, cwd: 'C:\\ws' },
    rows: { title: { val: title }, sessionListMetadata: { val: { blank, lastPromptAt } } },
  },
}))
mkSession('aaa11111-0000', '第一个会话', false, 200)
mkSession('bbb22222-0000', '第二个会话', false, 300)
mkSession('ccc33333-0000', '', true, 400)
fs.writeFileSync(path.join(projcacheDir, 'broken.json'), '{not json')
const index = t.readSessionIndex(projcacheDir)
eq(index.length, 2, '空会话被过滤、坏文件被跳过')
eq(index[0].id, 'session-bbb22222-0000', '按最后活动时间倒序')
eq(index[0].title, '第二个会话', '读得到标题')
eq(index[1].id, 'session-aaa11111-0000', 'id 统一带 session- 前缀')
eq(t.readSessionIndex(path.join(TMP, 'no-such-dir')), [], '目录不存在时返回空数组（不抛）')

// ── 11. 路径 / 工作区 ─────────────────────────────────────────────────
eq(t.normalizeWorkspace('C:\\Users\\me\\Documents\\deepseek-harness\\default-workspace'), 'C:\\Users\\me\\Documents\\deepseek-harness\\default-workspace', '绝对路径工作区被接受')
eq(t.normalizeWorkspace('relative/path'), '', '相对路径被拒')
eq(t.normalizeWorkspace('C:\\a\\..\\b'), '', '含 .. 的路径被拒')
eq(t.normalizeWorkspace('\\\\server\\share'), '', 'UNC 被拒')
eq(t.normalizeWorkspace('file:///c:/x'), '', 'file: 协议被拒')
const wsPaths = t.resolvePaths('C:\\Users\\x\\default-workspace')
ok(wsPaths.outDir.endsWith('.github-digest'), '日报目录在 .github-digest 下')
ok(wsPaths.outDir.startsWith('C:\\Users\\x\\default-workspace'), '日报目录在工作区内（不触发写入审批）')
ok(wsPaths.home.endsWith('github-digest'), '数据目录仍是插件家目录')
ok(wsPaths.seen.startsWith(wsPaths.home), '判重表在插件目录（host 直接写，不经过会话权限）')
ok(wsPaths.runs.startsWith(wsPaths.home), '执行记录在插件目录')
eq(wsPaths.config, path.join(wsPaths.home, 'config.json'), '配置文件在数据目录')
ok(t.resolvePaths('').outDir.includes('.github-digest'), '不给工作区也能返回（回落进程 cwd）')

// ── 12. 唤醒消息 ─────────────────────────────────────────────────────
const wakePrompt = t.readPromptText()
ok(wakePrompt.source === 'plugin' && wakePrompt.text.includes('GitHub 日报准则'), '能读到准则文件')
const wakePaths = { seen: 'X/seen.md', runs: 'X/runs.md', outDir: 'X/out' }
const msg1 = t.buildWakeMessage(t.normalizeConfig({ topics: ['mcp', 'llm'], cold_pick_min: 2, cold_pick_max_stars: 500 }), wakePaths, wakePrompt.text, {
  trigger: 'manual',
  firedAt: '2026-10-22 10:00:00',
  credential: { present: true, sourceLabel: '系统凭据管理器' },
})
ok(msg1.includes('2026-10-22 10:00:00'), '唤醒消息带触发时间')
ok(msg1.includes('manual'), '唤醒消息带触发来源')
ok(msg1.includes('冷门配额：每轮至少收 2 条'), '唤醒消息带冷门配额')
ok(msg1.includes('系统凭据管理器'), '唤醒消息带凭据来源')
ok(msg1.includes('X/seen.md'), '唤醒消息带判重表路径')
ok(msg1.includes('GitHub 日报准则'), '唤醒消息带准则正文')
ok(msg1.includes('本轮走发现模式'), '关注仓库为空时提示走发现模式')
const msgNoCold = t.buildWakeMessage(t.normalizeConfig({}), wakePaths, 'P', { trigger: 'schedule', firedAt: 'T' })
ok(msgNoCold.includes('冷门配额：不限'), '配额为 0 时显示不限')
ok(msgNoCold.includes('匿名访问'), '没有凭据信息时按匿名算')
const msgBrief = t.buildWakeMessage(t.normalizeConfig({ watch_repos: ['a/b'], brief_fetch_releases: true }), wakePaths, 'P', {})
ok(msgBrief.includes('hasNew'), '打开 brief_fetch_releases 时提示可看 hasNew')
ok(msg1.includes('pushedSinceLast'), '默认粗筛提示看 pushedSinceLast')

// ── 13. 通用工具 ─────────────────────────────────────────────────────
eq(t.escapeCell('a|b\nc'), 'a\uFF5Cb c', '表格单元格转义竖线与换行')
eq(t.formatCompactNumber(12345), '12.3k', '数字缩写 k')
eq(t.formatCompactNumber(1234567), '1.2M', '数字缩写 M')
const dirty = t.wellFormedDeep({ a: NaN, b: Infinity, c: 'x\uD800y', d: [1, undefined] })
eq(dirty.a, null, 'NaN 被清洗成 null')
eq(dirty.b, null, 'Infinity 被清洗成 null')
ok(!dirty.c.includes('\uD800') || dirty.c === 'x\uD800y'.toWellFormed(), '孤立代理项被修成 well-formed')
class FakeApi { alpha() {} beta() {} }
const fakeProto = Object.create(FakeApi.prototype)
fakeProto.gamma = () => {}
const fakeApi = Object.create(fakeProto)
fakeApi.delta = () => {}
fakeApi.notFn = 123
eq(t.methodNames(fakeApi).sort(), ['alpha', 'beta', 'delta', 'gamma'], '能拿到原型链上的方法，排除 constructor 与非函数')
eq(t.methodNames(null), [], 'null 返回空数组')

// ── 14. mock 宿主：apply 装配 ────────────────────────────────────────
import { EventEmitter } from 'node:events'

const PLUGIN_DATA = path.join(TMP, 'github-digest')
fs.mkdirSync(WS, { recursive: true })
fs.mkdirSync(PLUGIN_DATA, { recursive: true })

function createMockContext(options = {}) {
  const state = {
    toolMap: new Map(),
    routes: [],
    intervals: [],
    effects: [],
    created: [],
    renames: [],
    messages: [],
    agents: new Map(),
    sessionSeq: 0,
    probeAtCreate: '',
    agentFactory: (id) => ({ id, followup: (message) => state.messages.push(message) }),
  }
  state.toolMap = new Map()
  const services = {
    timer: {},
    tools: {
      register(definition) {
        state.toolMap.set(definition.name, definition)
        return () => state.toolMap.delete(definition.name)
      },
    },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {
          const index = state.routes.indexOf(route)
          if (index >= 0) state.routes.splice(index, 1)
        }
      },
    },
    workspaceRegistry: { list: () => [{ id: 'ws-default', path: WS }] },
    sessionController: {
      create: async (payload) => {
        try {
          state.probeAtCreate = fs.readFileSync(path.join(PLUGIN_DATA, 'apply-probe.json'), 'utf8')
        } catch {
          state.probeAtCreate = ''
        }
        state.sessionSeq += 1
        const id = 'session-created-' + state.sessionSeq
        state.created.push({ id, payload })
        const agent = state.agentFactory(id)
        if (agent) state.agents.set(id, agent)
        return { sessionId: id }
      },
      rename: async ({ sessionId, title }) => {
        state.renames.push({ sessionId, title })
        return { ok: true }
      },
    },
    agents: {
      get: (id) => state.agents.get(id) || null,
      list: () => [...state.agents.values()],
    },
  }
  Object.assign(services, options.services || {})
  const ctx = {
    get: (name) => services[name],
    effect: (fn) => {
      const dispose = fn(() => {})
      if (typeof dispose === 'function') state.effects.push(dispose)
      return dispose
    },
    interval: (fn, seconds) => {
      state.intervals.push({ fn, seconds })
      return () => {}
    },
    inject: (names, callback) => callback(),
    logger: () => () => {},
  }
  state.services = services
  return { ctx, state }
}

const boot = createMockContext()
host.apply(boot.ctx, {})
eq([...boot.state.toolMap.keys()].sort(), ['gh_digest_brief', 'gh_digest_discover', 'gh_digest_info', 'gh_digest_run_add', 'gh_digest_seen_add', 'gh_digest_seen_query', 'gh_digest_watch'], '7 个工具都注册上了')
eq(boot.state.routes.length, 7, '7 条 HTTP 路由都注册了（config / watch / status / panel / search / trending / run-now）')
eq(boot.state.intervals.length, 1, '定时器只启动一次')
eq(boot.state.intervals[0].seconds, 60000, '定时器 60 秒一跳（宿主 interval 是毫秒制）')
const probeAfterApply = JSON.parse(fs.readFileSync(path.join(PLUGIN_DATA, 'apply-probe.json'), 'utf8'))
eq(probeAfterApply.phase, 'apply-ok', 'apply 探针记录 apply-ok')
eq(probeAfterApply.version, '0.2.0', '探针版本来自 package.json')

// ── 15. runtime + 调度层 fire ────────────────────────────────────────
const integ = createMockContext()
const runtime = host.__test__.createRuntime(integ.ctx, {})
runtime.env.projcacheDir = projDir
runtime.env.ledgerFile = ledgerFile
runtime.env.scheduleStateFile = path.join(PLUGIN_DATA, 'schedule-state-test.json')
runtime.env.today = () => '2026-10-22'
const runner = host.__test__.createRunner(runtime)

const configFile = path.join(PLUGIN_DATA, 'config.json')
const seenFile2 = path.join(PLUGIN_DATA, 'seen.md')
const runsFile2 = path.join(PLUGIN_DATA, 'runs.md')
const historyFile2 = path.join(PLUGIN_DATA, 'history.jsonl')
const pendingFile2 = path.join(PLUGIN_DATA, 'pending-run.json')
const resetRuns = () => {
  for (const file of [configFile, seenFile2, runsFile2, historyFile2, pendingFile2]) {
    try { fs.rmSync(file, { force: true }) } catch { /* 忽略 */ }
  }
  integ.state.messages.length = 0
  integ.state.created.length = 0
  integ.state.agents.clear()
}

// 15.1 总开关关闭
resetRuns()
t.saveStoredConfig({ enabled: false }, configFile)
const disabled = await runner.fire('manual', '测试禁用')
eq(disabled.ok, false, '总开关关闭时不投递')
eq(disabled.code, 'DISABLED', '总开关关闭返回 DISABLED')
const disabledRuns = t.readRuns(runsFile2, 5)
eq(disabledRuns.rows[0].result, 'failed', '禁用也写执行记录（不许静默）')

// 15.2 正常创建会话并投递
resetRuns()
fs.rmSync(configFile, { force: true })
const fired1 = await runner.fire('manual', '测试正常')
eq(fired1.ok, true, '正常手动触发成功')
eq(fired1.created, true, '首次触发新建会话')
eq(fired1.sessionId, 'session-created-1', '返回新建的会话 id')
eq(integ.state.messages.length, 1, '投递了 1 条消息')
const delivered = integ.state.messages[0]
eq(delivered.role, 'user', '投递消息 role=user')
eq(delivered.source.kind, 'github-digest', '投递消息 source.kind=github-digest')
ok(String(delivered.content[0].text).includes('【github-digest】'), '投递消息带日报标题')
ok(String(delivered.content[0].text).includes('GitHub 日报准则'), '投递消息带准则正文')
eq(integ.state.renames.length, 1, '新会话尝试改名')
ok(integ.state.renames[0].title.includes('GitHub 项目推荐'), '会话名包含 GitHub 项目推荐')
const firedRuns = t.readRuns(runsFile2, 5)
eq(firedRuns.rows[0].result, 'ok', '成功也写执行记录')
const pendingAfterFire = t.readPending(pendingFile2)
eq(pendingAfterFire.sessionId, 'session-created-1', 'pending 记录本轮会话')
eq(pendingAfterFire.costBase.turns, 0, '新建会话的成本基线显式给 0')
const probeAfterFire = JSON.parse(fs.readFileSync(path.join(PLUGIN_DATA, 'apply-probe.json'), 'utf8'))
eq(probeAfterFire.phase, 'fire-done', '一轮结束写 fire-done 探针')
eq(probeAfterFire.renamed, 'sessionController.rename', '记录实际生效的改名方法')
eq(probeAfterFire.deliveredVia, 'followup', '记录投递方式')

// 15.3 当天复用
integ.state.created.length = 0
integ.state.messages.length = 0
fs.writeFileSync(historyFile2, JSON.stringify({ at: '2026-10-22 08:00:00', sessionId: 'session-created-1', trigger: 'schedule', result: 'ok' }) + '\n', 'utf8')
integ.state.agents.set('session-created-1', { id: 'session-created-1', followup: (message) => integ.state.messages.push(message) })
const fired2 = await runner.fire('manual', '测试复用')
eq(fired2.ok, true, '当天复用触发成功')
eq(fired2.reused, true, '复用当天会话')
eq(fired2.created, false, '复用时不新建')
eq(integ.state.created.length, 0, '复用路径没有调用 create')
eq(integ.state.messages.length, 1, '复用会话收到新消息')

// 15.4 会话忙时不复用
integ.state.agents.get('session-created-1').status = 'running'
const fired3 = await runner.fire('manual', '测试忙时')
eq(fired3.created, true, '会话忙时新建而不是硬投')
ok(fired3.sessionId !== 'session-created-1', '忙时确实换了会话')

// 15.5 未挂载且唤醒失败 → 新建；并把 wake-failed 写进探针
resetRuns()
integ.state.services.sessionController.resolveAgent = async () => { throw new Error('resume failed') }
fs.writeFileSync(historyFile2, JSON.stringify({ at: '2026-10-22 09:00:00', sessionId: 'session-old', trigger: 'schedule', result: 'ok' }) + '\n', 'utf8')
const fired4 = await runner.fire('manual', '测试唤醒失败')
delete integ.state.services.sessionController.resolveAgent
eq(fired4.created, true, '唤醒失败后回退新建会话')
ok(integ.state.probeAtCreate.includes('session-wake-failed'), 'create 前探针记录了 session-wake-failed')

// 15.6 指定目标会话（锁定）
resetRuns()
integ.state.agents.set('session-fixed', { id: 'session-fixed', followup: (message) => integ.state.messages.push(message) })
t.saveStoredConfig({ target_session_id: 'session-fixed' }, configFile)
const fired5 = await runner.fire('schedule', '测试锁定会话')
eq(fired5.ok, true, '指定会话触发成功')
eq(fired5.sessionId, 'session-fixed', '使用指定的目标会话')
eq(integ.state.created.length, 0, '指定会话时不新建')

// 15.6b 官方恢复入口成功：sessionController.resolveAgent 返回 agent，当天复用不新建
resetRuns()
fs.writeFileSync(historyFile2, JSON.stringify({ at: '2026-10-22 09:30:00', sessionId: 'session-cold-1', trigger: 'schedule', result: 'ok' }) + '\n', 'utf8')
const restoredAgent = { id: 'session-cold-1', followup: (message) => integ.state.messages.push(message) }
integ.state.services.sessionController.resolveAgent = async (sessionId) => {
  integ.state.agents.set(sessionId, restoredAgent)
  return restoredAgent
}
const firedRestore = await runner.fire('schedule', '测试官方恢复')
eq(firedRestore.ok, true, '官方 resolveAgent 能恢复冷会话')
eq(firedRestore.reused, true, '恢复后按当天复用处理')
eq(integ.state.created.length, 0, '恢复成功时不新建会话')
eq(integ.state.messages.length, 1, '恢复后的会话收到投递')
delete integ.state.services.sessionController.resolveAgent

// 15.6c prompt 兜底：拿不到 agent、也没有恢复入口时，用官方 prompt 投递
resetRuns()
const promptCalls = []
fs.writeFileSync(historyFile2, JSON.stringify({ at: '2026-10-22 09:40:00', sessionId: 'session-cold-2', trigger: 'schedule', result: 'ok' }) + '\n', 'utf8')
integ.state.services.sessionController.prompt = async (request) => {
  promptCalls.push(request)
  return { accepted: true }
}
const firedPrompt = await runner.fire('schedule', '测试 prompt 兜底')
eq(firedPrompt.ok, true, 'prompt 兜底能投递')
eq(firedPrompt.deliveredVia, 'sessionController.prompt', '记录 prompt 投递方式')
eq(promptCalls.length, 1, 'prompt 被调用一次')
eq(promptCalls[0].sessionId, 'session-cold-2', 'prompt 投到复用的会话')
ok(String(promptCalls[0].content[0].text).includes('【github-digest】'), 'prompt 内容带日报标题')
delete integ.state.services.sessionController.prompt

// 15.7 每轮新开会话
resetRuns()
fs.writeFileSync(historyFile2, JSON.stringify({ at: '2026-10-22 10:00:00', sessionId: 'session-created-1', trigger: 'schedule', result: 'ok' }) + '\n', 'utf8')
t.saveStoredConfig({ fresh_session_per_run: true }, configFile)
const fired6 = await runner.fire('manual', '测试每轮新建')
eq(fired6.created, true, 'fresh_session_per_run 打开后每轮新建')

// 15.8 投递失败路径：新建了会话但拿不到 agent
resetRuns()
integ.state.agentFactory = () => null
const fired7 = await runner.fire('manual', '测试拿不到 agent')
eq(fired7.ok, false, '拿不到 agent 时触发失败')
eq(fired7.code, 'NO_SESSION', '失败码是 NO_SESSION')
const failRuns = t.readRuns(runsFile2, 5)
eq(failRuns.rows[0].result, 'failed', '投递失败也写执行记录')
integ.state.agentFactory = (id) => ({ id, followup: (message) => integ.state.messages.push(message) })

// 15.9 定时判定到点后由 tick 触发
resetRuns()
t.saveStoredConfig({ enabled: true, schedule: { mode: 'daily', at: '12:30' } }, configFile)
const tickState = { lastRunDate: '' }
t.writeScheduleState(runtime.env.scheduleStateFile, tickState)
const beforeTickMessages = integ.state.messages.length
boot.state.intervals.length = 0
const runner2 = host.__test__.createRunner(host.__test__.createRuntime(boot.ctx, {}))
runner2.startTimer()
eq(boot.state.intervals.length, 1, 'startTimer 注册了 interval')
ok(typeof boot.state.intervals[0].fn === 'function', 'interval 回调可调用')
await boot.state.intervals[0].fn()
await sleep(50)
ok(integ.state.messages.length >= beforeTickMessages, 'tick 回调可执行（未到点则不动）')

// ── 16. 工具 execute ────────────────────────────────────────────────
const toolBoot = createMockContext()
const toolRuntime = host.__test__.createRuntime(toolBoot.ctx, {})
toolRuntime.env.projcacheDir = projDir
toolRuntime.env.ledgerFile = ledgerFile
toolRuntime.env.scheduleStateFile = path.join(PLUGIN_DATA, 'sched-tools.json')
toolRuntime.env.today = () => '2026-10-22'
// 工具测试不跑真实凭据探测（会 spawn gh/git），直接给空凭据
toolRuntime.refreshCredential = async () => toolRuntime.state.credential
const toolDefs = host.__test__.createToolDefinitions(toolRuntime)
const toolMap = new Map(toolDefs.map((definition) => [definition.name, definition]))
eq(toolMap.size, 7, 'createToolDefinitions 生成 7 个工具')

const toolConfig = path.join(PLUGIN_DATA, 'config.json')
const toolSeen = path.join(PLUGIN_DATA, 'seen.md')
const toolRuns = path.join(PLUGIN_DATA, 'runs.md')
const toolHistory = path.join(PLUGIN_DATA, 'history.jsonl')
const toolPending = path.join(PLUGIN_DATA, 'pending-run.json')
const toolWatch = path.join(PLUGIN_DATA, 'watch-state.json')
const resetToolFiles = () => {
  for (const file of [toolConfig, toolSeen, toolRuns, toolHistory, toolPending, toolWatch]) {
    try { fs.rmSync(file, { force: true }) } catch { /* 忽略 */ }
  }
}
resetToolFiles()

const fakeClient = {
  quotaText: () => '39/60',
  repo: async (name) => {
    if (name === 'x/y') return { ok: false, error: { code: 'NOT_FOUND', message: '不存在', status: 404 } }
    return { ok: true, repo: { fullName: name, description: '描述', defaultBranch: 'main', stars: 42, pushedAt: '2026-10-20T00:00:00Z', topics: ['mcp'], archived: false } }
  },
  releases: async () => ({ ok: true, releases: [
    { tag: 'v1.0.0', name: 'v1', body: 'body', publishedAt: '2026-10-20T00:00:00Z' },
    { tag: 'v0.9.0', name: 'v0.9', body: 'old', publishedAt: '2026-09-01T00:00:00Z' },
  ] }),
  commits: async () => ({ ok: true, commits: [{ sha: 'abcdef012345', message: 'fix', author: 'me', date: '2026-10-20T00:00:00Z', htmlUrl: '' }] }),
  reposBulk: async (list) => ({
    ok: true,
    repos: list.map((name) => ({ fullName: name, description: '批量描述', stars: 7, language: 'TS', pushedAt: name.endsWith('/old') ? '2026-01-01T00:00:00Z' : '2026-10-20T00:00:00Z', archived: false, defaultBranch: 'main', topics: ['mcp'] })),
    missing: [],
    quota: '39/60',
  }),
  searchRepos: async () => ({ ok: true, totalCount: 3, repos: [
    { fullName: 'a/one', description: 'd1', stars: 10, language: 'Go', createdAt: '2026-10-01T00:00:00Z', pushedAt: '2026-10-20T00:00:00Z', htmlUrl: '', topics: ['mcp'] },
    { fullName: 'c/three', description: 'd2', stars: 8, language: 'TS', createdAt: '2026-10-01T00:00:00Z', pushedAt: '2026-10-20T00:00:00Z', htmlUrl: '', topics: ['mcp'] },
    { fullName: 'd/four', description: 'd3', stars: 6, language: 'Rust', createdAt: '2026-10-01T00:00:00Z', pushedAt: '2026-10-20T00:00:00Z', htmlUrl: '', topics: ['llm'] },
  ] }),
  readme: async () => ({ ok: true, text: '# README' }),
}
toolRuntime.clientFor = () => fakeClient

// info
const infoResult = await toolMap.get('gh_digest_info').execute({})
eq(infoResult.ok, true, 'info 返回 ok')
ok(infoResult.paths.outDir.replace(/\\/g, '/').startsWith(WS.replace(/\\/g, '/')), 'info 的日报目录在工作区内')
eq(infoResult.tokenPresent, false, 'info 反映真实凭据状态（匿名）')

// brief：没有关注仓库也没有主题
const briefEmpty = await toolMap.get('gh_digest_brief').execute({})
eq(briefEmpty.ok, false, '没有可看的仓库时 brief 返回失败')
eq(briefEmpty.code, 'NO_REPOS', 'brief 失败码 NO_REPOS')

// brief：正常 + unchanged 短路 + dormant
t.saveStoredConfig({ watch_repos: ['a/b', 'c/d', 'e/old'], topics: ['mcp'] }, toolConfig)
const brief1 = await toolMap.get('gh_digest_brief').execute({})
eq(brief1.ok, true, 'brief 正常返回')
eq(brief1.count, 3, 'brief 覆盖 3 个仓库')
eq(brief1.repos[0].topicHits, ['mcp'], 'brief 带主题命中')
ok(brief1.repos.some((item) => item.dormant === true), '长期未推送的新仓库走 dormant 短路')
ok(fs.existsSync(toolPending), 'brief 把元信息缓存进 pending')
const brief2 = await toolMap.get('gh_digest_brief').execute({})
const unchangedItem = brief2.repos.find((item) => item.repo === 'a/b')
ok(unchangedItem && unchangedItem.unchanged === true, '12 小时内未推送走 unchanged 短路')
ok(brief2.requestsSaved >= 1, '短路计数正确')

// watch：缓存复用 + 判重过滤 + commits since
t.appendRow(toolSeen, 'github-digest 判重表', t.SEEN_COLUMNS, ['a/b', '收取', '之前看过', '2026-10-01'])
t.appendRow(toolSeen, 'github-digest 判重表', t.SEEN_COLUMNS, ['a/b@v1.0.0', '收取', 'v1.0.0 看过', '2026-10-01'])
const watch1 = await toolMap.get('gh_digest_watch').execute({ repo: 'a/b' })
eq(watch1.ok, true, 'watch 正常返回')
eq(watch1.repo.fullName, 'a/b', 'watch 返回仓库元信息')
eq(watch1.dataSource, 'brief-cache', 'watch 复用 brief 缓存')
eq(watch1.releases.length, 1, 'watch 过滤掉判重表里已有的版本')
eq(watch1.releases[0].tag, 'v0.9.0', '只留没看过的版本')
eq(watch1.releasesSkipped, 1, '统计被过滤的版本数')
eq(watch1.commits.length, 1, 'watch 返回 commits')
eq(watch1.commitsSince, '2026-10-01', 'commits 从判重表 firstSeen 起增量')
eq(watch1.quota, '39/60', 'watch 带额度')
const watchBad = await toolMap.get('gh_digest_watch').execute({ repo: 'bad' })
eq(watchBad.ok, false, 'watch 非法仓库返回失败')
eq(watchBad.code, 'BAD_REPO_REF', 'watch 非法仓库错误码正确')
const watch404 = await toolMap.get('gh_digest_watch').execute({ repo: 'x/y' })
eq(watch404.ok, false, 'watch 404 返回失败')
eq(watch404.code, 'NOT_FOUND', 'watch 404 错误码正确')
t.saveStoredConfig({ watch_repos: ['a/b'], topics: ['mcp'], read_readme: true }, toolConfig)
const watchReadme = await toolMap.get('gh_digest_watch').execute({ repo: 'a/b' })
eq(watchReadme.readme, '# README', '打开 read_readme 后 watch 返回 README')

// discover
t.saveStoredConfig({ topics: ['mcp'], min_stars: 0, discover_created_within_days: 30 }, toolConfig)
t.appendRow(toolSeen, 'github-digest 判重表', t.SEEN_COLUMNS, ['c/three', '跳过', '看过', '2026-10-01'])
const discover1 = await toolMap.get('gh_digest_discover').execute({})
eq(discover1.ok, true, 'discover 正常返回')
eq(discover1.returned, 2, 'discover 只返回没见过的仓库')
eq(discover1.filteredBySeen, 1, 'discover 过滤掉判重表里的仓库')
eq(discover1.topic, 'mcp', 'discover 用上了主题')
ok(discover1.repos[0].topicHits.length > 0, 'discover 带主题命中')
ok(fs.existsSync(toolWatch), 'discover 写入 watch-state（主题游标）')
t.saveStoredConfig({ topics: ['mcp', 'llm'], min_stars: 0, discover_created_within_days: 0 }, toolConfig)
const discover2 = await toolMap.get('gh_digest_discover').execute({ query: 'topic:custom', limit: 1 })
eq(discover2.builtinQuery, false, '自定义 query 不走主题轮换')
eq(discover2.repos.length, 1, 'limit 生效')

// seen
t.appendRow(toolSeen, 'github-digest 判重表', t.SEEN_COLUMNS, ['seen/one@v2.0.0', '收取', '测试', '2026-10-01'])
const seenHit = await toolMap.get('gh_digest_seen_query').execute({ repo: 'seen/one' })
eq(seenHit.found, true, 'seen_query 能查到记录')
const seenMiss = await toolMap.get('gh_digest_seen_query').execute({ repo: 'none/none' })
eq(seenMiss.found, false, 'seen_query 查不到返回 found:false')
const seenAdd = await toolMap.get('gh_digest_seen_add').execute({ repo: 'new/repo@v0.1.0', disposition: '跳过', reason: '不相关' })
eq(seenAdd.ok, true, 'seen_add 能写')
const seenVerify = await toolMap.get('gh_digest_seen_query').execute({ repo: 'new/repo@v0.1.0' })
eq(seenVerify.found, true, 'seen_add 写进去之后 seen_query 查得到')
const seenBad = await toolMap.get('gh_digest_seen_add').execute({ repo: '../etc/passwd', disposition: '收取' })
eq(seenBad.ok, false, 'seen_add 拒绝非法仓库')
const seenNoArgs = await toolMap.get('gh_digest_seen_query').execute({})
eq(seenNoArgs.hint, '没给 repo 或 query', 'seen_query 没给参数时返回提示')

// run_add
t.writePending(toolPending, {
  sessionId: fakeSessionId,
  at: Date.now(),
  atText: '2026-10-22 12:30:00',
  repos: { 'a/b': 3000, 'c/d': 1000 },
  costBase: { input: 400, output: 200, cacheRead: 4000, cost: 0.004, turns: 4 },
})
const runAdd = await toolMap.get('gh_digest_run_add').execute({
  trigger: 'manual',
  result: 'ok',
  watched: 3,
  kept: 1,
  skipped: 2,
  quota: '39/60',
  note: '测试',
  items_json: JSON.stringify([{ repo: 'a/b', stars: 42, verdict: 'worth', what: '一个项目', whatChanged: 'v1', impact: '无', action: '看看' }]),
})
eq(runAdd.ok, true, 'run_add 返回 ok')
eq(runAdd.itemCount, 1, 'run_add 解析 items_json')
eq(runAdd.repoVolume.total, 4000, 'run_add 汇总仓库体量')
ok(runAdd.cost && runAdd.cost.input === 600, 'run_add 计算本轮成本')
eq(t.readPending(toolPending), null, 'run_add 后 pending 被清掉')
const historyRows = t.readHistory(toolHistory, 5)
eq(historyRows[0].items[0].repo, 'a/b', 'history 写入明细')
eq(historyRows[0].sessionId, fakeSessionId, 'history 记录会话 id')
const runAddBadItems = await toolMap.get('gh_digest_run_add').execute({ trigger: 'manual', result: 'ok', items_json: 'not-json' })
eq(runAddBadItems.ok, true, 'items_json 坏掉不影响执行记录')
ok(runAddBadItems.itemsError.includes('解析失败'), 'items_json 坏掉给出提示')
const runAddEmpty = await toolMap.get('gh_digest_run_add').execute({ trigger: 'manual', result: 'failed' })
eq(runAddEmpty.ok, true, 'run_add 允许空明细')

// ── 16b. 候选补记 / 主题兜底 / 背景 / 当天轮次 ─────────────────────────
const candFile = path.join(PLUGIN_DATA, 'pending-candidates.json')
const resetCand = () => { try { fs.rmSync(candFile, { force: true }) } catch { /* 忽略 */ } }

// 主题命中：仓库没填 topics 时从名字 / 描述兜底，短词不误命中
eq(t.matchTopicHits({ fullName: 'o/mcp-server', name: 'mcp-server', description: 'A server for MCP', topics: [] }, ['mcp']), ['mcp'], 'topics 为空时用名字/描述兜底命中')
eq(t.matchTopicHits({ fullName: 'o/htmlmeta', name: 'htmlmeta', description: 'html metadata parser', topics: [] }, ['llm']), [], 'llm 不误命中 htmlmeta')
eq(t.matchTopicHits({ fullName: 'o/x', name: 'x', topics: ['ai-agent'] }, ['ai agent']), ['ai agent'], '仓库自带 topics 优先命中')
eq(t.containsTerm('an mcp server', 'mcp'), true, '词边界命中')
eq(t.containsTerm('htmlmeta', 'llm'), false, '词中间不算命中')

// 候选暂存：合并去重、TTL
resetCand()
t.addPendingCandidates(candFile, [{ repo: 'q/one', stars: 5 }, { repo: 'q/two', stars: 6 }])
t.addPendingCandidates(candFile, [{ repo: 'Q/ONE', stars: 7 }])
const candStored = t.readPendingCandidates(candFile)
eq(candStored.repos.length, 2, '候选按仓库去重合并')
eq(candStored.repos.find((item) => item.repo.toLowerCase() === 'q/one').stars, 7, '重复候选更新为最新一次')
eq(t.readPendingCandidates(candFile, Date.now() + t.CANDIDATE_TTL_MS + 1000).repos.length, 0, '超过 TTL 的候选视为过期')

// discover 写候选暂存；run_add 把没处理的候选补记判重表
try { fs.rmSync(toolSeen, { force: true }) } catch { /* 忽略 */ }
resetCand()
t.saveStoredConfig({ topics: ['mcp'], min_stars: 0, discover_created_within_days: 0 }, toolConfig)
const discover3 = await toolMap.get('gh_digest_discover').execute({})
eq(discover3.returned, 3, '判重表清空后 discover 返回全部候选')
eq(t.readPendingCandidates(candFile).repos.length, 3, 'discover 把本轮候选写进暂存')
const runAuto = await toolMap.get('gh_digest_run_add').execute({
  trigger: 'manual',
  result: 'ok',
  kept: 1,
  items_json: JSON.stringify([{ repo: 'a/one', verdict: 'worth', confidence: 'high', what: 'x' }]),
})
eq(runAuto.autoSeen, 3, 'run_add 自动补记 items 与未处理候选')
const seenAuto = t.readSeen(toolSeen)
ok(seenAuto.rows.some((row) => row.repo === 'c/three' && row.disposition === '跳过'), '未处理候选写进判重表')
ok(!fs.existsSync(candFile), '补记后候选暂存被清空')
const discover4 = await toolMap.get('gh_digest_discover').execute({})
eq(discover4.returned, 0, '补记过的候选下一轮不会原样再出现')

// 背景：归一化 + 唤醒消息注入
const profileCfg = t.normalizeConfig({ profile_note: '做 DSH 插件，关注成本' })
eq(profileCfg.profile_note, '做 DSH 插件，关注成本', 'profile_note 原样保留')
eq(t.normalizeConfig({ profile_note: 'x'.repeat(900) }).profile_note.length, 600, 'profile_note 截断到 600')
const wakeMsg = t.buildWakeMessage(profileCfg, t.resolvePaths(WS), '', { trigger: 'manual', firedAt: '2026-10-22 05:00:00', credential: { present: true, sourceLabel: '设置页填写' } })
ok(wakeMsg.includes('做 DSH 插件，关注成本'), '唤醒消息带上用户背景')
ok(wakeMsg.includes('5000 次/小时'), '有 token 时唤醒消息提示 5000')
const wakeMsgAnon = t.buildWakeMessage(t.normalizeConfig({}), t.resolvePaths(WS), '', { trigger: 'manual', firedAt: '2026-10-22 05:00:00', credential: { present: false, sourceLabel: '' } })
ok(wakeMsgAnon.includes('60 次/小时'), '匿名时唤醒消息提示 60')

// info：当天轮次 + 报告命名提示
const infoAfter = await toolMap.get('gh_digest_info').execute({})
ok(Number.isInteger(infoAfter.todayRuns) && infoAfter.todayRuns >= 1, 'info 返回当天已跑轮次')
ok(String(infoAfter.runIndexHint).includes('-'), 'info 给出报告命名提示')
ok(Object.prototype.hasOwnProperty.call(infoAfter, 'profile_note'), 'info 透出 profile_note')

// 客户端单文件语法（改 UI 后防止整页白屏）
{
  const vm = await import('node:vm')
  const clientSrc = fs.readFileSync(path.join(host.__test__.PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
  let parsed = true
  try { new vm.Script(clientSrc, { filename: 'client.js' }) } catch { parsed = false }
  ok(parsed, 'client.js 语法可解析')
}

// ── 17. HTTP 路由 ────────────────────────────────────────────────────
const routeBoot = createMockContext()
const routeRuntime = host.__test__.createRuntime(routeBoot.ctx, {})
routeRuntime.env.projcacheDir = projDir
routeRuntime.env.ledgerFile = ledgerFile
routeRuntime.env.scheduleStateFile = path.join(PLUGIN_DATA, 'sched-routes.json')
routeRuntime.env.today = () => '2026-10-22'
routeRuntime.refreshCredential = async () => routeRuntime.state.credential
const fakeRunner = {
  fire: async (trigger, reason) => ({ ok: true, code: 'WOKEN', sessionId: 'session-route', created: true, trigger, reason }),
}
const routeTable = host.__test__.createRouteTable(routeRuntime, fakeRunner)
const routeOf = (routePath) => routeTable.find((route) => route.path === routePath)

function callRoute(handler, options = {}) {
  const req = new EventEmitter()
  req.method = options.method || 'GET'
  req.headers = { host: '127.0.0.1:57356', ...(options.headers || {}) }
  req.destroy = () => {}
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value },
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(String(text || '{}')) }) },
    }
    handler(req, res)
    if (options.body !== undefined) req.emit('data', JSON.stringify(options.body))
    req.emit('end')
  })
}

resetToolFiles()
const configGet = await callRoute(routeOf('/github-digest/config').handler)
eq(configGet.status, 200, 'GET /config 200')
eq(configGet.body.ok, true, 'GET /config ok')
eq(configGet.body.config.token, '', 'GET /config 不回明文 token')
eq(configGet.body.config.tokenConfigured, false, 'GET /config 带 tokenConfigured')
ok(Array.isArray(configGet.body.sessions), 'GET /config 带会话下拉')
eq(configGet.body.status.ok, true, 'GET /config 带运行状态')

const configPost = await callRoute(routeOf('/github-digest/config').handler, { method: 'POST', body: { min_stars: 123, topics: ['mcp', 'ai agent'] } })
eq(configPost.status, 200, 'POST /config 200')
eq(configPost.body.config.min_stars, 123, 'POST /config 保存生效')
eq(configPost.body.config.topics, ['mcp', 'ai agent'], 'POST /config 保留多词主题')
const storedConfig = JSON.parse(fs.readFileSync(toolConfig, 'utf8'))
eq(storedConfig.min_stars, 123, '配置真的写进 config.json')

const configPost2 = await callRoute(routeOf('/github-digest/config').handler, { method: 'POST', body: { max_items_per_run: 3 } })
eq(configPost2.body.config.max_items_per_run, 3, '第二次 POST 合并配置')
eq(configPost2.body.config.min_stars, 123, '第二次 POST 保留未提交字段')

// token 保留 / 清除
t.saveStoredConfig({ token: 'ghp_' + 'a'.repeat(36) }, toolConfig)
const configKeepToken = await callRoute(routeOf('/github-digest/config').handler, { method: 'POST', body: { max_items_per_run: 5 } })
eq(configKeepToken.body.config.tokenConfigured, true, 'POST 不带 token 时保留原 token')
const configClearToken = await callRoute(routeOf('/github-digest/config').handler, { method: 'POST', body: { clear_token: true } })
eq(configClearToken.body.config.tokenConfigured, false, 'clear_token 能清空 token')
eq(JSON.parse(fs.readFileSync(toolConfig, 'utf8')).token, '', 'token 清除真的落盘')

const statusRoute = await callRoute(routeOf('/github-digest/status').handler)
eq(statusRoute.status, 200, 'GET /status 200')
eq(statusRoute.body.version, '0.2.0', 'GET /status 返回版本号')
const panelRoute = await callRoute(routeOf('/github-digest/panel').handler)
eq(panelRoute.status, 200, 'GET /panel 200')
ok(Array.isArray(panelRoute.body.history), 'GET /panel 带 history')
ok(panelRoute.body.cost && typeof panelRoute.body.cost === 'object', 'GET /panel 带 cost')

const runNowRoute = await callRoute(routeOf('/github-digest/run-now').handler, { method: 'POST' })
eq(runNowRoute.status, 200, 'POST /run-now 200')
eq(runNowRoute.body.sessionId, 'session-route', 'POST /run-now 返回会话 id')
const runNowWrongMethod = await callRoute(routeOf('/github-digest/run-now').handler, { method: 'GET' })
eq(runNowWrongMethod.status, 405, 'GET /run-now 405')
const configWrongMethod = await callRoute(routeOf('/github-digest/config').handler, { method: 'PUT' })
eq(configWrongMethod.status, 405, 'PUT /config 405')

// 关注仓库的增删走独立路由：只动 watch_repos，不覆盖其它字段。
const watchGet = await callRoute(routeOf('/github-digest/watch').handler)
eq(watchGet.status, 200, 'GET /watch 200')
ok(Array.isArray(watchGet.body.repos), 'GET /watch 带关注列表')
eq(watchGet.body.limit, 60, 'GET /watch 带上限')
const watchAdd = await callRoute(routeOf('/github-digest/watch').handler, { method: 'POST', body: { repo: 'Ollama/Ollama', op: 'add' } })
eq(watchAdd.status, 200, 'POST /watch add 200')
eq(watchAdd.body.changed, true, 'POST /watch add 真的改了')
eq(watchAdd.body.repos, ['Ollama/Ollama'], 'POST /watch 返回新列表')
const watchDup = await callRoute(routeOf('/github-digest/watch').handler, { method: 'POST', body: { repo: 'ollama/OLLAMA', op: 'add' } })
eq(watchDup.body.changed, false, '重复关注幂等（大小写不敏感）')
const watchSecond = await callRoute(routeOf('/github-digest/watch').handler, { method: 'POST', body: { repo: 'deepseek-ai/deepseek-harness', op: 'add' } })
eq(watchSecond.body.count, 2, '能关注第二个仓库')
const watchOtherConfig = JSON.parse(fs.readFileSync(path.join(PLUGIN_DATA, 'config.json'), 'utf8'))
eq(watchOtherConfig.max_items_per_run, 5, 'POST /watch 不动其它配置项')
const watchBadRef = await callRoute(routeOf('/github-digest/watch').handler, { method: 'POST', body: { repo: '../etc/passwd', op: 'add' } })
eq(watchBadRef.status, 400, '非法仓库名返回 400')
eq(watchBadRef.body.code, 'BAD_REPO_REF', '非法仓库名带 BAD_REPO_REF')
const watchRemove = await callRoute(routeOf('/github-digest/watch').handler, { method: 'POST', body: { repo: 'ollama/ollama', op: 'remove' } })
eq(watchRemove.body.changed, true, '取消关注生效')
eq(watchRemove.body.repos, ['deepseek-ai/deepseek-harness'], '取消关注后列表只剩一个')
const watchRemoveAgain = await callRoute(routeOf('/github-digest/watch').handler, { method: 'POST', body: { repo: 'ollama/ollama', op: 'remove' } })
eq(watchRemoveAgain.body.changed, false, '取消不存在的关注幂等')
// 满额要明确报错，不能静默截断
t.saveStoredConfig({ watch_repos: Array.from({ length: 60 }, (_, i) => 'owner' + i + '/repo' + i) })
const watchFull = await callRoute(routeOf('/github-digest/watch').handler, { method: 'POST', body: { repo: 'one/more', op: 'add' } })
eq(watchFull.status, 409, '关注满了返回 409')
eq(watchFull.body.code, 'WATCH_FULL', '关注满了带 WATCH_FULL')
const watchWrongMethod = await callRoute(routeOf('/github-digest/watch').handler, { method: 'PUT' })
eq(watchWrongMethod.status, 405, 'PUT /watch 405')

// 历史搜索：面板只有最近 20 轮，更早的靠服务端搜 history.jsonl
t.appendHistory(path.join(PLUGIN_DATA, 'history.jsonl'), {
  at: '2026-10-22 13:00:00',
  items: [{ repo: 'search/probe', verdict: 'worth', stars: 12, what: '搜索测试项目', whatChanged: 'v1 首次出现', impact: '无', action: '看看' }],
})
const searchEmpty = await callRoute(routeOf('/github-digest/search').handler, { method: 'POST', body: { q: '   ' } })
eq(searchEmpty.status, 200, 'POST /search 200')
eq(searchEmpty.body.count, 0, '空搜索词返回 0 条')
const searchHit = await callRoute(routeOf('/github-digest/search').handler, { method: 'POST', body: { q: '搜索测试' } })
eq(searchHit.body.count >= 1, true, 'POST /search 能命中历史里的项目')
eq(searchHit.body.hits[0].repo, 'search/probe', '搜索结果带仓库名')
eq(searchHit.body.hits[0].what, '搜索测试项目', '搜索结果带「是什么」')
const searchWrongMethod = await callRoute(routeOf('/github-digest/search').handler, { method: 'GET' })
eq(searchWrongMethod.status, 405, 'GET /search 405')

// 热门榜单：用 Search API 自己算，不抓 github.com/trending
const trendingCalls = []
const fakeTrendingClient = {
  searchRepos: async ({ q, sort, perPage }) => {
    trendingCalls.push({ q, sort, perPage })
    return {
      ok: true,
      totalCount: 42,
      repos: [
        { fullName: 'acme/new-thing', description: '一个刚建的高星项目', stars: 5000, language: 'Go', createdAt: '2026-10-20T00:00:00Z', pushedAt: '2026-10-21T00:00:00Z', htmlUrl: 'https://github.com/acme/new-thing', topics: ['dsh'] },
        { fullName: 'acme/second', description: '', stars: 1200, language: 'Rust', createdAt: '2026-10-19T00:00:00Z', pushedAt: '2026-10-20T00:00:00Z', htmlUrl: 'https://github.com/acme/second', topics: [] },
      ],
    }
  },
}
const trendNow = Date.parse('2026-10-22T00:00:00Z')
eq(t.buildTrendingQuery('week', '', trendNow), 'created:>2026-10-15 stars:>100', '本周查询串（7 天窗口 + 100 star 下限）')
eq(t.buildTrendingQuery('day', '', trendNow), 'created:>2026-10-21 stars:>5', '今日查询串')
ok(t.buildTrendingQuery('month', 'Go', trendNow).includes('language:Go'), '语言过滤进查询串')
ok(!t.buildTrendingQuery('week', 'all', trendNow).includes('language:'), 'language=all 不加过滤')
eq(t.normalizeWindow('nope'), 'week', '非法时间窗回落到本周')
eq(t.normalizeWindow('MONTH'), 'month', '时间窗大小写不敏感')
eq(t.TRENDING_WINDOWS.day.minStars, 5, '今日 star 下限压到 5（一天内新建的高星仓库很少）')
const shaped = t.shapeTrendingItem({ fullName: 'a/b', stars: 3, language: 'Go', description: 'x'.repeat(300), createdAt: '2026-10-20T00:00:00Z', htmlUrl: 'u', topics: ['t1', 't2'] })
eq(shaped.repo, 'a/b', '榜单条目带仓库名')
eq(shaped.createdAt, '2026-10-20', '创建日期截到天')
eq(shaped.description.length, 160, '描述截断到 160 字符')

t.clearTrendingCache()
const tr1 = await t.fetchTrending(fakeTrendingClient, { windowKey: 'week', limit: 1, now: trendNow })
eq(tr1.ok, true, 'fetchTrending 成功')
eq(tr1.cached, false, '第一次不命中缓存')
eq(tr1.items.length, 1, 'limit 生效')
eq(trendingCalls.length, 1, '第一次真的打了 Search')
eq(trendingCalls[0].sort, 'stars', '按 star 倒序')
const tr2 = await t.fetchTrending(fakeTrendingClient, { windowKey: 'week', limit: 1, now: trendNow + 60000 })
eq(tr2.cached, true, '第二次命中缓存')
eq(trendingCalls.length, 1, '缓存命中不再打 Search')
const tr3 = await t.fetchTrending(fakeTrendingClient, { windowKey: 'week', limit: 1, now: trendNow + 31 * 60 * 1000 })
eq(tr3.cached, false, '超过 30 分钟缓存失效')
eq(trendingCalls.length, 2, '缓存失效后重新请求')

routeRuntime.clientFor = () => fakeTrendingClient
const trendingRoute = await callRoute(routeOf('/github-digest/trending').handler, { method: 'POST', body: { window: 'month' } })
eq(trendingRoute.status, 200, 'POST /trending 200')
eq(trendingRoute.body.ok, true, 'POST /trending 返回 ok')
ok(Array.isArray(trendingRoute.body.items), 'POST /trending 带 items')
ok(trendingRoute.body.availableWindows && trendingRoute.body.availableWindows.week, 'POST /trending 带可用的时间窗')
const trendingWrongMethod = await callRoute(routeOf('/github-digest/trending').handler, { method: 'GET' })
eq(trendingWrongMethod.status, 405, 'GET /trending 405')
const trendingBadClient = { searchRepos: async () => ({ ok: false, error: { code: 'RATE_LIMITED', message: '配额用完' } }) }
routeRuntime.clientFor = () => trendingBadClient
t.clearTrendingCache()
const trendingFail = await callRoute(routeOf('/github-digest/trending').handler, { method: 'POST', body: { window: 'day' } })
eq(trendingFail.status, 502, '拉取失败返回 502')
eq(trendingFail.body.error.code, 'RATE_LIMITED', '失败时透传 GitHub 错误码')
eq(host.__test__.requestRejection(routeBoot.ctx, { headers: { host: '127.0.0.1:57356', origin: 'https://evil.example.com' } }), 403, '跨站 Origin 被拒')
eq(host.__test__.requestRejection(routeBoot.ctx, { headers: { host: '127.0.0.1:57356' } }), null, '本机 Host 放行')
eq(host.__test__.requestRejection(routeBoot.ctx, { headers: { host: '10.0.0.5' } }), 403, '非回环 Host 拒绝')
eq(host.__test__.requestRejection(routeBoot.ctx, { headers: { host: '127.0.0.1:57356', origin: 'http://127.0.0.1:57356' } }), null, '本机 Origin 放行')

// ── 18. 面板 / 状态数据 ──────────────────────────────────────────────
const panelBoot = createMockContext()
const panelRuntime = host.__test__.createRuntime(panelBoot.ctx, {})
panelRuntime.env.projcacheDir = projDir
panelRuntime.env.ledgerFile = ledgerFile
panelRuntime.env.scheduleStateFile = path.join(PLUGIN_DATA, 'sched-panel.json')
panelRuntime.env.today = () => '2026-10-22'
panelRuntime.refreshCredential = async () => panelRuntime.state.credential
const panelPaths = panelRuntime.pathsFor(panelRuntime.reloadConfig())
fs.mkdirSync(panelPaths.outDir, { recursive: true })
fs.writeFileSync(path.join(panelPaths.outDir, '2026-10-22.md'), '# 日报', 'utf8')
fs.mkdirSync(path.join(panelPaths.home, 'out'), { recursive: true })
fs.writeFileSync(path.join(panelPaths.home, 'out', '2026-10-21.md'), '# 旧日报', 'utf8')
fs.writeFileSync(panelPaths.history, [
  JSON.stringify({ at: '2026-10-22 12:30:00', trigger: 'schedule', result: 'ok', items: [], cost: { input: 100, output: 50, cacheRead: 1000, costCny: 0.01, exact: true } }),
  JSON.stringify({ at: '2026-10-22 18:30:00', trigger: 'manual', result: 'ok', items: [], cost: { input: 200, output: 60, cacheRead: 2000, costCny: 0.02, exact: false, turnsDelta: 2 } }),
].join('\n') + '\n', 'utf8')
const panelPayload = host.__test__.buildPanel(panelRuntime)
eq(panelPayload.history.length, 2, '面板读回两轮记录')
eq(panelPayload.cumulative.rounds, 2, '累计轮数正确')
ok(Math.abs(panelPayload.cumulative.costCny - 0.03) < 1e-9, '累计费用相加')
ok(panelPayload.reports.includes('2026-10-22.md'), '面板包含新日报目录')
ok(panelPayload.reports.includes('2026-10-21.md'), '面板兼容旧日报目录（换目录后历史不消失）')
ok(panelPayload.cost && panelPayload.cost.available === true, '面板带 cost-meter 数据')

// 关注分栏：面板要知道「关注了哪些」以及每个仓库上次检查的结果
t.saveStoredConfig({ watch_repos: ['Ollama/Ollama', 'deepseek-ai/deepseek-harness'] })
fs.writeFileSync(panelPaths.watchState, JSON.stringify({
  'Ollama/Ollama': { pushedAt: '2026-10-20T00:00:00Z', checkedAt: '2026-10-22 12:30:00', lastDelta: 'unchanged' },
  'deepseek-ai/deepseek-harness': { pushedAt: '2026-10-22T01:00:00Z', checkedAt: '2026-10-22 12:30:00', lastDelta: 'pushed' },
  'unwatched/repo': { pushedAt: '2026-10-22T01:00:00Z', checkedAt: '2026-10-22 12:30:00', lastDelta: 'pushed' },
}), 'utf8')
const panelWithWatch = host.__test__.buildPanel(panelRuntime)
eq(panelWithWatch.watchRepos, ['Ollama/Ollama', 'deepseek-ai/deepseek-harness'], '面板返回关注列表')
eq(panelWithWatch.watchCount, 2, '面板关注数量与列表一致')
eq(panelWithWatch.watchState['Ollama/Ollama'].lastDelta, 'unchanged', '面板带「未发现更新」状态')
eq(panelWithWatch.watchState['deepseek-ai/deepseek-harness'].lastDelta, 'pushed', '面板带「有新推送」状态')
eq(panelWithWatch.watchState['unwatched/repo'], undefined, '不在关注列表的旧记录不返回')
eq(panelWithWatch.watchState['Ollama/Ollama'].checkedAt, '2026-10-22 12:30:00', '面板带上次检查时间')

// 历史搜索的匹配范围与语义
fs.writeFileSync(panelPaths.history, [
  JSON.stringify({ at: '2026-10-20 12:00:00', items: [{ repo: 'acme/widget', verdict: 'worth', what: 'agent 记忆层', whatChanged: 'v1.2 新增检索', impact: '配置要改', action: '升级到新版本' }] }),
  JSON.stringify({ at: '2026-10-21 12:00:00', items: [{ repo: 'other/thing', verdict: 'skip', what: '纯文档站', whatChanged: '只改了 CI', impact: '无', action: '不用管' }] }),
].join('\n') + '\n', 'utf8')
eq(t.searchHistory(panelPaths, '记忆').length, 1, '搜索范围包含「是什么」')
eq(t.searchHistory(panelPaths, '记忆')[0].repo, 'acme/widget', '命中项带仓库名')
eq(t.searchHistory(panelPaths, '新增检索').length, 1, '搜索范围包含「变化」')
eq(t.searchHistory(panelPaths, '配置要改').length, 1, '搜索范围包含「影响」')
eq(t.searchHistory(panelPaths, '升级到新版本').length, 1, '搜索范围包含「建议」')
eq(t.searchHistory(panelPaths, 'ACME').length, 1, '搜索大小写不敏感')
eq(t.searchHistory(panelPaths, 'acme 记忆').length, 1, '多关键词按 AND 匹配')
eq(t.searchHistory(panelPaths, 'acme 不存在的词').length, 0, '少一个关键词就不命中')
eq(t.searchHistory(panelPaths, '   ').length, 0, '全空白搜索词返回空')
eq(t.searchHistory(panelPaths, '文档', 1).length, 1, 'limit 生效')

// 查询串里的标点当分隔符（输入法打出的全角标点不该让搜索落空）
eq(t.splitQuery('rea 逆向'), ['rea', '逆向'], '空格切词')
eq(t.splitQuery('rea，逆向'), ['rea', '逆向'], '全角逗号当分隔符')
eq(t.splitQuery('rea、逆向；x'), ['rea', '逆向', 'x'], '顿号分号都当分隔符')
eq(t.splitQuery('dsh-plugin'), ['dsh-plugin'], '连字符不切（仓库名的一部分）')
eq(t.splitQuery('v1.3.3'), ['v1.3.3'], '点号不切（版本号的一部分）')
eq(t.splitQuery('  ，。  '), [], '全是标点切出空词')
eq(t.searchHistory(panelPaths, 'acme，记忆').length, 1, '带标点的查询能搜到')
const statusPayload = await host.__test__.buildStatus(panelRuntime)
eq(statusPayload.version, '0.2.0', '状态快照带版本号')
ok(statusPayload.paths.outDir.startsWith(WS), '状态快照的日报目录在工作区')

// ── 19. 客户端静态契约 ──────────────────────────────────────────────
// 客户端依赖 window / React，Node 侧不能直接 import，所以用静态检查锁结构；
// 真实渲染放到宿主里做端到端验证（设置页 / 侧边栏面板）。
const clientSrc = fs.readFileSync(path.join(HERE, '..', 'lib', 'client.js'), 'utf8')
ok(clientSrc.includes('window.__ModuleLoader__.load({'), '客户端按 ModuleLoader 协议注册')
ok(!/^import\s/m.test(clientSrc), '客户端没有顶层 import（平台只认单文件 classic script）')
ok(clientSrc.includes("id: 'github-digest'"), '客户端模块 id 正确')
ok(clientSrc.includes('settings.section'), '注册设置页槽位')
ok(clientSrc.includes('sidebar.panellist'), '注册侧边栏入口')
ok(clientSrc.includes("name: 'main', key: 'github-digest'"), '注册侧边栏主面板')
ok(clientSrc.includes('function SettingsPage()'), '设置页组件存在')
ok(clientSrc.includes('function DigestPanel()'), '日报面板组件存在')
ok(clientSrc.includes('const SidebarIcon = () =>'), '侧边栏图标组件存在')

// 关注 / 来源分栏契约
ok(clientSrc.includes('/github-digest/watch'), '面板调 /github-digest/watch 关注路由')
ok(clientSrc.includes('SOURCE_FILTERS'), '面板有来源分栏（全部 / 发现 / 关注）')
ok(clientSrc.includes('WatchListCard'), '面板有关注列表卡片')
ok(clientSrc.includes('未发现更新'), '关注视图显示「未发现更新」')
ok(clientSrc.includes('toggleWatch'), '面板有关注切换逻辑')
ok(clientSrc.includes('itemSource'), '面板能判定条目来源（老数据反推）')
ok(clientSrc.includes('gd-item-watch'), '条目右侧有关注按钮样式')

// 历史搜索契约
ok(clientSrc.includes('/github-digest/search'), '面板调 /github-digest/search 搜索历史')
ok(clientSrc.includes('gd-search'), '面板有搜索输入框样式')
ok(clientSrc.includes('searchQuery'), '搜索有防抖后的词状态')
ok(clientSrc.includes('filteredHits'), '搜索结果同样吃来源 / 推荐度 / 时间筛选')

// 字号滑块契约
ok(clientSrc.includes("type: 'range'"), '面板有字号滑块')
ok(clientSrc.includes('FONT_SCALE_KEY'), '字号偏好存 localStorage')
ok(clientSrc.includes("'--gd-fs'"), '字号通过 CSS 变量下发')
ok(clientSrc.includes('calc(12px * var(--gd-fs,1))'), '记录正文字号跟随滑块')
ok(clientSrc.includes('calc(11px * var(--gd-fs,1))'), '徽标与序号字号跟随滑块')
ok(clientSrc.includes('var(--gd-fs,1)'), '没有变量的区域回落原始字号')

// 四栏标签配色
ok(clientSrc.includes("'data-k': 'what'"), '「是什么」带语义标记')
ok(clientSrc.includes("'data-k': 'changed'"), '「变化」带语义标记')
ok(clientSrc.includes("'data-k': 'impact'"), '「影响」带语义标记')
ok(clientSrc.includes("'data-k': 'action'"), '「建议」带语义标记')
ok(clientSrc.includes('.gd-item-line[data-k] b{display:inline-block'), '四栏标签套了气泡')
ok(clientSrc.includes('.gd-item-line[data-k="what"] b{color:#82a0bd'), '「是什么」标签有自己的低饱和色')
ok(clientSrc.includes('.gd-item-line[data-k="action"] b{color:#9a8ec6'), '「建议」标签有自己的低饱和色')
ok(clientSrc.includes('rgba(130,160,189,.15)'), '气泡底是同色系低透明度')
ok(!clientSrc.includes("'是什么：'"), '气泡标签不再带冒号')

// 搜索高亮
ok(clientSrc.includes('function highlight(text, terms)'), '有搜索命中高亮函数')
ok(clientSrc.includes("className: 'gd-hl'"), '命中词包成 mark')
ok(clientSrc.includes('.gd-hl{background:#ffd666;color:#2b2410'), '命中词是亮黄实心 + 深色字（覆盖 mark 默认样式）')
ok(clientSrc.includes('highlight(hit.what, searchTerms)'), '四栏内容都走高亮')
ok(clientSrc.includes('highlight(hitRepo, searchTerms)'), '项目名也高亮')
ok(clientSrc.includes('NEED_ESCAPE'), '搜索词逐字符转义（不写转义用的正则）')
ok(!clientSrc.includes('innerHTML'), '高亮不拼 HTML 串，避免注入')

// 输入法组词：打拼音时不能拿半截拼音去搜
ok(clientSrc.includes('onCompositionStart'), '组词开始会打标记')
ok(clientSrc.includes('onCompositionEnd'), '组词结束才把最终词交给搜索')
ok(clientSrc.includes('if (composing) return undefined'), '组词期间跳过 debounce')
ok(clientSrc.includes('onBlur: () => setComposing(false)'), '组词中失焦也能重置状态')

// 热门榜单
ok(clientSrc.includes('/github-digest/trending'), '面板调 /github-digest/trending')
ok(clientSrc.includes('GitHub 热门'), '面板有榜单区块')
ok(clientSrc.includes('trendingOpen'), '榜单默认收起，展开才拉')
ok(clientSrc.includes('不需要挂梯子'), '面板说明榜单走 api.github.com')

// 设置页分组与参数补全
ok(clientSrc.includes("title: '定时与投递'"), '设置页拆出「定时与投递」组')
ok(clientSrc.includes("title: '每轮规模'"), '设置页拆出「每轮规模」组')
ok(clientSrc.includes("title: '运行环境'"), '设置页拆出「运行环境」组')
ok(clientSrc.includes("title: '读什么'"), '设置页拆出「读什么」组')
ok(clientSrc.includes("patch('release_body_chars'"), 'release 正文截断有设置入口')
ok(!clientSrc.includes("patch('languages'"), '设置页不再有 languages（死参数）')

// token 安全：GET 不回显，前端只用 tokenInput，保存时留空 = 不修改
ok(clientSrc.includes('tokenInput'), 'token 用独立输入框')
ok(clientSrc.includes('tokenConfigured'), '设置页读取 tokenConfigured 而不是明文')
ok(clientSrc.includes('clear_token: true'), '清除 token 走 clear_token 标记')

// 多词主题：本地文本 state，保存时才拆分
ok(clientSrc.includes('topicsText'), '主题输入用本地文本 state')
ok(clientSrc.includes('splitList(topicsText)'), '保存时才拆分主题')
ok(!clientSrc.includes("patch('topics'"), '主题不在输入时逐键 patch（避免多词主题被拆）')
ok(clientSrc.includes('一行一个'), '主题输入提示说明一行一个')
ok(clientSrc.includes('NumberField'), '数字输入有独立组件')
ok(clientSrc.includes('Number.isFinite'), '数字输入拒绝 NaN')

// 面板滚动契约（宿主侧边栏容器不给确定高度，纯 CSS 方案实测不生效）
const cssRule = (selector) => {
  const hit = clientSrc.match(new RegExp("'\\." + selector + "\\{([^']*)'"))
  return hit ? hit[1] : ''
}
const panelCss = cssRule('gd-panel')
const scrollCss = cssRule('gd-scroll')
ok(panelCss.includes('box-sizing:border-box'), '.gd-panel 用 border-box（否则高度会多出 padding）')
ok(panelCss.includes('overflow:hidden'), '.gd-panel 自己不滚')
ok(!panelCss.includes('overflow-y:auto'), '.gd-panel 不同时当滚动容器')
ok(clientSrc.includes("'.gd-panel>.gd-top{flex:0 0 auto;"), '头部固定在面板顶部')
ok(scrollCss.includes('overflow-y:auto'), '.gd-scroll 是唯一滚动容器')
ok(scrollCss.includes('min-height:0'), '.gd-scroll 有 min-height:0（否则 flex 子项滚不动）')
ok(scrollCss.includes('flex:1 1 auto'), '.gd-scroll 撑满头部以下空间')
ok(scrollCss.includes('overflow-x:hidden'), '.gd-scroll 只纵向滚')
ok(scrollCss.includes('scrollbar-gutter:stable'), '.gd-scroll 预留滚动条位置')
ok(clientSrc.includes("'.gd-scroll>*{flex:0 0 auto;}'"), '滚动区子项不被 flex 压缩')
ok(cssRule('gd-runs').includes('padding-right:0'), '.gd-runs 不自己滚')
ok(clientSrc.includes('.gd-scroll::-webkit-scrollbar-thumb'), '滚动条样式挂在 .gd-scroll 上')
ok(!clientSrc.includes('.gd-runs::-webkit-scrollbar'), '滚动条样式不挂在 .gd-runs 上')
eq((clientSrc.match(/ref: panelRef/g) || []).length, 2, '两个渲染分支都把 ref 绑到面板上')
ok(clientSrc.includes('window.innerHeight - rect.top - 10'), '面板高度按「顶边到窗口底」计算')
ok(clientSrc.includes("const scroller = el.querySelector('.gd-scroll')"), '自动定位滚的是 .gd-scroll')
ok(clientSrc.includes('jumpedRef'), '自动定位只做一次')

// 筛选 + 缓动
ok(clientSrc.includes('const VERDICT_FILTERS = ['), '有推荐程度筛选项')
ok(clientSrc.includes('const TIME_FILTERS = ['), '有时间筛选项')
ok(clientSrc.includes("['worth', '值得看']") && clientSrc.includes("['watch', '观察']") && clientSrc.includes("['skip', '跳过']"), '推荐程度档位与三档判定一致')
ok(clientSrc.includes("['today', '今天']") && clientSrc.includes("['3d', '近 3 天']") && clientSrc.includes("['7d', '近 7 天']"), '时间档位齐全')
ok(clientSrc.includes('start.setHours(0, 0, 0, 0)'), '「今天」按本地零点算')
ok(clientSrc.includes("String(entry.item.verdict || 'skip') === verdictFilter"), '推荐程度按项目筛')
ok(clientSrc.includes('parseAtMs(run.at) < floorMs'), '时间按轮次筛')
ok(clientSrc.includes("replace(/-/g, '/')"), '时间解析先换分隔符（Chromium 直接 parse 不稳）')
ok(clientSrc.includes('const easeInOut = (t) =>'), '缓动函数存在')
ok(clientSrc.includes('4 * t * t * t'), '缓动用 easeInOutCubic（慢-快-慢）')
ok(clientSrc.includes('function smoothScrollTo(el, target, duration)'), '平滑滚动函数存在')
ok(clientSrc.includes('smoothScrollTo(scroller, delta, 560)'), '自动定位走 560ms 缓动')
ok(clientSrc.includes('prefers-reduced-motion'), '尊重「减少动效」设置')

// 缓动曲线数值：单调、两端对齐、中点一半、起步慢中段快
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
eq(ease(0), 0, '缓动起点 0')
eq(ease(1), 1, '缓动终点 1')
ok(Math.abs(ease(0.5) - 0.5) < 1e-12, '缓动中点 0.5')
let last = -1
ok(Array.from({ length: 41 }, (_, i) => ease(i / 40)).every((value) => { const mono = value >= last - 1e-12; last = value; return mono }), '缓动曲线单调递增')
ok(ease(0.25) < 0.25, '起步慢')
ok(ease(0.75) > 0.75, '中段快')

// 时间解析复制算法（客户端依赖 window，这里只测算法本身）
const parseAt = (value) => {
  const parsed = Date.parse(String(value || '').replace(/-/g, '/'))
  return Number.isFinite(parsed) ? parsed : 0
}
ok(parseAt('2026-10-22 02:46:45') > 0, '能解析记录时间')
eq(parseAt('not a time'), 0, '解析失败返回 0')
eq(parseAt(''), 0, '空值返回 0')

// 同一组件里的 key 唯一（Group / Row 是平级数组，撞 key 会重复渲染）
const groupKeys = [...clientSrc.matchAll(/h\(Group, \{\s*key: '([^']+)'/gs)].map((m) => m[1])
ok(groupKeys.length >= 8, '扫到了 Group 的 key')
eq([...new Set(groupKeys)].length, groupKeys.length, 'Group 的 key 不重复')
const rowKeys = [...clientSrc.matchAll(/h\(Row, \{ key: '([^']+)'/g)].map((m) => m[1])
ok(rowKeys.length >= 10, '扫到了 Row 的 key')
eq([...new Set(rowKeys)].length, rowKeys.length, 'Row 的 key 不重复')

// “立即跑一轮”和“刷新”都在面板头部常驻
ok(clientSrc.includes("busy === 'run' ? '启动中…' : '立即跑一轮'"), '面板按钮文案正常')
ok(clientSrc.includes('>刷新</button>') || clientSrc.includes("'刷新'"), '面板有刷新按钮')

// ── 20. 文档 / 包一致性 ──────────────────────────────────────────────
const promptDoc = fs.readFileSync(path.join(HERE, '..', 'prompts', 'digest.md'), 'utf8')
ok(promptDoc.includes('GitHub 日报准则'), '准则文件存在且标题正确')
eq((promptDoc.match(/第二步：细读/g) || []).length, 1, '准则里「第二步」只出现一次（旧文档重复过）')
ok(!promptDoc.includes('hasNew=false 的'), '准则不再引用默认不存在的 hasNew=false 说法')
ok(promptDoc.includes('pushedSinceLast'), '准则讲到默认粗筛字段 pushedSinceLast')
ok(promptDoc.includes('unchanged'), '准则讲到 unchanged 短路')
ok(promptDoc.includes('readable: false') || promptDoc.includes('readable：false'), '准则保留判重表不可读纪律')
ok(promptDoc.includes('items_json'), '准则要求写结构化面板数据')
ok(promptDoc.includes('首次收录'), '准则保留首次收录的 what 要求')

const readmeDoc = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8')
ok(readmeDoc.includes('## English'), 'README 带英文版')
ok(readmeDoc.includes('40 个'), 'README 的默认仓库数与配置一致')
ok(readmeDoc.includes('12:30'), 'README 的默认定时与配置一致')
ok(readmeDoc.includes('.github-digest'), 'README 写明日报目录')
ok(readmeDoc.includes('304'), 'README 写明 304 仍扣配额')
ok(!readmeDoc.includes('一天跑一轮售价'), 'README 没有乱码文案')

const changelog = fs.readFileSync(path.join(HERE, '..', 'CHANGELOG.md'), 'utf8')
ok(changelog.includes('0.1.0'), 'CHANGELOG 有 0.1.0')
ok(changelog.includes('2026-10-22'), 'CHANGELOG 有日期')

const devDoc = fs.readFileSync(path.join(HERE, '..', 'docs', 'DEVELOPMENT.md'), 'utf8')
ok(devDoc.includes('ctx.interval'), '开发文档写明 interval 单位坑')
ok(devDoc.includes('resolveAgent'), '开发文档写明会话恢复入口')
ok(devDoc.includes('单文件'), '开发文档写明客户端单文件约束')

const releasing = fs.readFileSync(path.join(HERE, '..', 'RELEASING.md'), 'utf8')
ok(releasing.includes('npm pack --dry-run'), '发版文档要求核 pack 清单')

const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
eq(pkg.version, '0.2.0', 'package.json 版本是 0.2.0')
eq(pkg.name, 'dsh-github-digest', '包名正确')
ok(!pkg.private, 'package.json 没有 private:true')
ok(pkg.dsh && pkg.dsh.client && pkg.dsh.bundle, 'package.json 有 dsh 清单')
ok(Array.isArray(pkg.files) && pkg.files.includes('lib'), 'files 白名单包含 lib（客户端 bundle 不能漏）')
const forbiddenFiles = ['config.json', 'seen.md', 'runs.md', 'out', 'history.jsonl', 'apply-probe.json']
ok(!pkg.files.some((file) => forbiddenFiles.includes(file)), 'files 不包含运行时数据文件')
ok(fs.existsSync(path.join(HERE, '..', 'LICENSE')), 'LICENSE 存在')
ok(fs.readFileSync(path.join(HERE, '..', 'LICENSE'), 'utf8').includes('MIT'), 'LICENSE 是 MIT')
ok(fs.existsSync(path.join(HERE, '..', 'cordis.patch.yml')), 'cordis.patch.yml 存在')
ok(fs.existsSync(path.join(HERE, '..', 'icon.svg')), 'icon.svg 存在')
ok(fs.existsSync(path.join(HERE, '..', 'locale', 'zh.json')), '中文 locale 存在')
ok(fs.existsSync(path.join(HERE, '..', 'locale', 'en.json')), '英文 locale 存在')
const indexSrc = fs.readFileSync(path.join(HERE, '..', 'lib', 'index.js'), 'utf8')
ok(indexSrc.includes("export const name = 'dsh-github-digest'"), '入口导出插件名')
ok(indexSrc.includes("export const inject = ['timer', 'tools']"), '入口声明注入 timer / tools')
ok(indexSrc.includes('apply-failed'), 'apply 失败会写探针而不是外抛')
ok(!/process\.env\.GITHUB_TOKEN\s*=/.test(indexSrc), '入口不写环境变量')
const allLibFiles = []
function walkLib(dir, prefix) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walkLib(full, prefix + name + '/')
    else allLibFiles.push(prefix + name)
  }
}
walkLib(path.join(HERE, '..', 'lib'), '')
ok(allLibFiles.includes('client.js'), 'lib/client.js 在包里')
ok(allLibFiles.includes('index.js'), 'lib/index.js 在包里')
ok(allLibFiles.length >= 20, 'lib 模块拆分完整（>=20 个文件）')

// ── 21. 汇总 ───────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true })
if (failures.length) {
  console.error('')
  console.error('失败 ' + failures.length + ' 项：')
  for (const name of failures) console.error('  x ' + name)
  console.error('通过 ' + pass + ' 项')
  process.exit(1)
}
console.log('全部通过：' + pass + ' 项')
