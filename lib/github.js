/**
 * GitHub 数据面：只读 REST + Search 的薄封装。
 *
 * 三件事必须做对，否则装到别人机器上一定翻车：
 *   1. 错误分类：不能只抛一句 fetch failed，要能看出是 token 错了、被限速了、还是仓库不存在；
 *   2. 省请求：304 只能省流量，**不省配额**（实测：6 次请求含 1 次 304，remaining 照样 -5），
 *      所以省额度只能靠少发请求（批量元信息、本轮缓存、pushed_at 短路）；
 *   3. 只读：本模块只发 GET，没有任何写接口。
 */
import { parseRepoRef } from './repo-ref.js'

const API_ROOT = 'https://api.github.com'
const DEFAULT_TIMEOUT_MS = 12000
const CACHE_LIMIT = 200

function fail(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } }
}

/**
 * HTTP 状态 + 响应体 → 使用者看得懂的错误码。
 * 这段是「开源插件体验」的分水岭：别人装完第一次跑，十有八九因为 token 或限速失败。
 */
export function classifyError(status, body) {
  const message = String((body && body.message) || '')
  const docs = String((body && body.documentation_url) || '')
  if (status === 401) {
    return { code: 'TOKEN_INVALID', message: 'GitHub token 无效或已过期', hint: '去设置页检查 token，或清空它改用匿名模式。', docs }
  }
  if (status === 403) {
    if (/rate limit/i.test(message) || /rate limit/i.test(docs)) {
      return { code: 'RATE_LIMITED', message: 'GitHub 限速已用完', hint: '填一个只读 token（5000 次/小时），或等配额重置后再跑。', docs }
    }
    return { code: 'FORBIDDEN', message: message || 'GitHub 拒绝访问（403）', hint: '私有仓库需要 token 且有访问权限。', docs }
  }
  if (status === 404) return { code: 'NOT_FOUND', message: message || '仓库或资源不存在', hint: '检查 owner/repo 拼写；私有仓库要 token。', docs }
  if (status === 422) return { code: 'UNPROCESSABLE', message: message || '参数被 GitHub 拒绝（422）', docs }
  if (status >= 500) return { code: 'GITHUB_5XX', message: message || 'GitHub 服务端错误', hint: '稍后重试。', docs }
  return { code: 'HTTP_' + status, message: message || ('HTTP ' + status), docs }
}

/**
 * 创建客户端。
 * options: { token, timeoutMs, fetchImpl, userAgent, log }
 * 返回的对象是全 GET 的，没有 tokenPresent 之外的身份信息。
 */
export function createGithubClient(options = {}) {
  const token = typeof options.token === 'string' ? options.token.trim() : ''
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const userAgent = typeof options.userAgent === 'string' && options.userAgent ? options.userAgent : 'dsh-github-digest'
  const log = typeof options.log === 'function' ? options.log : () => {}

  /** url → { etag, data }。304 时直接回这份，省一次下载（但不省配额）。 */
  const cache = new Map()
  const state = {
    limit: null,
    remaining: null,
    resetAt: null,
    resetEpochMs: null,
    requests: 0,
    notModified: 0,
  }

  function requestHeaders(extra = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
      ...extra,
    }
    if (token) headers.Authorization = 'Bearer ' + token
    return headers
  }

  function readRateLimit(headers) {
    const limit = headers.get('x-ratelimit-limit')
    const remaining = headers.get('x-ratelimit-remaining')
    const reset = headers.get('x-ratelimit-reset')
    if (limit !== null) state.limit = Number(limit)
    if (remaining !== null) state.remaining = Number(remaining)
    if (reset !== null) {
      const epoch = Number(reset) * 1000
      state.resetEpochMs = epoch
      state.resetAt = new Date(epoch).toISOString()
    }
  }

  function cachePut(url, etag, data) {
    if (!etag) return
    cache.set(url, { etag, data })
    if (cache.size > CACHE_LIMIT) {
      const first = cache.keys().next().value
      if (first !== undefined) cache.delete(first)
    }
  }

  /** 底层 GET：返回 { ok:true, data, cached } 或 { ok:false, error }。网络异常自己接住。 */
  async function getJson(path, { useCache = true } = {}) {
    const url = path.startsWith('http') ? path : API_ROOT + path
    const cached = useCache ? cache.get(url) : undefined
    const headers = requestHeaders(cached && cached.etag ? { 'If-None-Match': cached.etag } : {})

    state.requests += 1
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const name = String((err && err.name) || '')
      if (name === 'TimeoutError' || name === 'AbortError') {
        return fail('NETWORK_TIMEOUT', '请求 GitHub 超时（' + timeoutMs + 'ms）', { hint: '网络不稳定或需要代理；稍后重试一次。' })
      }
      return fail('NETWORK_FAILED', '连不上 api.github.com：' + String((err && err.message) || err).slice(0, 160), {
        hint: '换个网络或代理；插件本身没有代理配置。',
      })
    }

    readRateLimit(response.headers)

    if (response.status === 304) {
      state.notModified += 1
      if (cached) return { ok: true, data: cached.data, cached: true }
      // 缓存对不上（极少见）：丢掉条件头重来一次，避免死循环只重试一次。
      cache.delete(url)
      return getJson(path, { useCache: false })
    }

    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }

    let body = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }

    if (!response.ok) {
      const error = classifyError(response.status, body)
      return { ok: false, error: { ...error, status: response.status } }
    }
    if (text && body === null) return fail('BAD_JSON', 'GitHub 返回了无法解析的内容', { status: response.status })

    if (useCache) cachePut(url, response.headers.get('etag'), body)
    return { ok: true, data: body, cached: false }
  }

  // ── 对外接口（全是 GET）─────────────────────────────────────────────

  /** /rate_limit 不计配额，第一轮先打它，把剩余额度写进报告头。 */
  async function rateLimit() {
    const result = await getJson('/rate_limit', { useCache: false })
    if (!result.ok) return result
    const core = result.data && result.data.resources && result.data.resources.core
    const search = result.data && result.data.resources && result.data.resources.search
    return {
      ok: true,
      core: core ? { limit: core.limit, remaining: core.remaining, resetAt: new Date(core.reset * 1000).toISOString() } : null,
      search: search ? { limit: search.limit, remaining: search.remaining, resetAt: new Date(search.reset * 1000).toISOString() } : null,
    }
  }

  async function repo(fullName) {
    const ref = parseRepoRef(fullName)
    if (!ref) return fail('BAD_REPO_REF', '仓库格式要写 owner/repo', { hint: '例如 deepseek-ai/deepseek-harness' })
    const result = await getJson('/repos/' + ref.owner + '/' + ref.repo)
    if (!result.ok) return result
    const d = result.data || {}
    return {
      ok: true,
      cached: result.cached,
      repo: {
        fullName: d.full_name,
        description: d.description || '',
        htmlUrl: d.html_url,
        stars: d.stargazers_count,
        forks: d.forks_count,
        openIssues: d.open_issues_count,
        language: d.language || '',
        license: d.license && d.license.spdx_id ? d.license.spdx_id : '',
        archived: Boolean(d.archived),
        defaultBranch: d.default_branch || 'main',
        createdAt: d.created_at,
        pushedAt: d.pushed_at,
        topics: Array.isArray(d.topics) ? d.topics.slice(0, 20) : [],
      },
    }
  }

  async function releases(fullName, { perPage = 5, bodyChars = 600 } = {}) {
    const ref = parseRepoRef(fullName)
    if (!ref) return fail('BAD_REPO_REF', '仓库格式要写 owner/repo')
    const n = Math.min(20, Math.max(1, Number(perPage) || 5))
    const result = await getJson('/repos/' + ref.owner + '/' + ref.repo + '/releases?per_page=' + n)
    if (!result.ok) return result
    const list = Array.isArray(result.data) ? result.data : []
    return {
      ok: true,
      cached: result.cached,
      releases: list.map((r) => ({
        tag: r.tag_name || '',
        name: r.name || '',
        publishedAt: r.published_at || r.created_at || '',
        prerelease: Boolean(r.prerelease),
        draft: Boolean(r.draft),
        author: (r.author && r.author.login) || '',
        // 正文截断：这段直接进模型上下文，600 字符是「够判断、不烧 token」的折中。
        body: String(r.body || '').slice(0, bodyChars),
        htmlUrl: r.html_url || '',
      })),
    }
  }

  async function commits(fullName, { perPage = 3, branch = '', since = '' } = {}) {
    const ref = parseRepoRef(fullName)
    if (!ref) return fail('BAD_REPO_REF', '仓库格式要写 owner/repo')
    const n = Math.min(20, Math.max(1, Number(perPage) || 3))
    let path = '/repos/' + ref.owner + '/' + ref.repo + '/commits?per_page=' + n
    if (branch) path += '&sha=' + encodeURIComponent(String(branch).slice(0, 100))
    if (since) {
      const ts = Date.parse(since)
      if (Number.isFinite(ts)) path += '&since=' + new Date(ts).toISOString()
    }
    const result = await getJson(path)
    if (!result.ok) return result
    const list = Array.isArray(result.data) ? result.data : []
    return {
      ok: true,
      cached: result.cached,
      commits: list.map((c) => ({
        sha: String(c.sha || '').slice(0, 12),
        message: String((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 200),
        author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || '',
        date: (c.commit && c.commit.author && c.commit.author.date) || '',
        htmlUrl: c.html_url || '',
      })),
    }
  }

  /** 发现模式用。Search 未认证 10 次/分钟，别在循环里调。 */
  async function searchRepos({ q, sort = 'stars', order = 'desc', perPage = 10 } = {}) {
    const query = String(q || '').trim()
    if (!query) return fail('BAD_QUERY', '搜索条件不能为空')
    // 100 是 Search API 单页上限。取 100 和取 10 花的是同一次请求，所以一次拉满。
    const n = Math.min(100, Math.max(1, Number(perPage) || 10))
    const path = '/search/repositories?q=' + encodeURIComponent(query.slice(0, 300)) +
      '&sort=' + encodeURIComponent(sort) + '&order=' + encodeURIComponent(order) + '&per_page=' + n
    const result = await getJson(path, { useCache: false })
    if (!result.ok) return result
    const items = Array.isArray(result.data && result.data.items) ? result.data.items : []
    return {
      ok: true,
      totalCount: (result.data && result.data.total_count != null) ? result.data.total_count : items.length,
      repos: items.map((d) => ({
        fullName: d.full_name,
        description: d.description || '',
        stars: d.stargazers_count,
        language: d.language || '',
        createdAt: d.created_at,
        pushedAt: d.pushed_at,
        htmlUrl: d.html_url,
        topics: Array.isArray(d.topics) ? d.topics.slice(0, 10) : [],
      })),
    }
  }

  /**
   * 一次请求拿多个仓库的元信息。
   * 走 Search API：q=repo:a/b repo:c/d（OR 语义），40 个仓库 1 次请求。
   * Search 的 q 太长会 422，所以按字符数分批，每批最多 50 个 repo（实测 1378 字符可通过）。
   */
  async function reposBulk(fullNames) {
    const refs = (Array.isArray(fullNames) ? fullNames : []).map(parseRepoRef).filter(Boolean)
    if (!refs.length) return fail('BAD_REPO_REF', '没有合法的 owner/repo')

    const found = new Map()
    const chunks = []
    let current = []
    let currentChars = 0
    for (const ref of refs.slice(0, 50)) {
      const token = 'repo:' + ref.fullName
      if (current.length && (current.length >= 50 || currentChars + token.length > 1400)) {
        chunks.push(current)
        current = []
        currentChars = 0
      }
      current.push(ref)
      currentChars += token.length + 1
    }
    if (current.length) chunks.push(current)

    for (const chunk of chunks) {
      const q = chunk.map((r) => 'repo:' + r.fullName).join(' ')
      const path = '/search/repositories?q=' + encodeURIComponent(q) + '&per_page=' + Math.min(100, chunk.length + 5)
      const result = await getJson(path, { useCache: false })
      if (!result.ok) return result
      const items = Array.isArray(result.data && result.data.items) ? result.data.items : []
      for (const d of items) {
        if (!d || !d.full_name) continue
        found.set(String(d.full_name).toLowerCase(), {
          fullName: d.full_name,
          description: d.description || '',
          htmlUrl: d.html_url,
          stars: d.stargazers_count,
          forks: d.forks_count,
          openIssues: d.open_issues_count,
          language: d.language || '',
          license: d.license && d.license.spdx_id ? d.license.spdx_id : '',
          archived: Boolean(d.archived),
          defaultBranch: d.default_branch || 'main',
          createdAt: d.created_at,
          pushedAt: d.pushed_at,
          topics: Array.isArray(d.topics) ? d.topics.slice(0, 20) : [],
          via: 'search',
        })
      }
    }

    const repos = []
    const missing = []
    for (const ref of refs) {
      const hit = found.get(ref.fullName.toLowerCase())
      if (hit) repos.push(hit)
      else missing.push(ref.fullName)
    }
    return {
      ok: true,
      repos,
      missing,
      quota: state.remaining === null ? '未知' : state.remaining + '/' + (state.limit == null ? '?' : state.limit),
    }
  }

  /** README 前 4KB。用 JSON 接口拿 base64，比 raw 稳（raw 域名常被代理拦）。 */
  async function readme(fullName, { maxChars = 4000 } = {}) {
    const ref = parseRepoRef(fullName)
    if (!ref) return fail('BAD_REPO_REF', '仓库格式要写 owner/repo')
    const result = await getJson('/repos/' + ref.owner + '/' + ref.repo + '/readme')
    if (!result.ok) {
      if (result.error.code === 'NOT_FOUND') return { ok: true, cached: false, text: '', note: '这个仓库没有 README' }
      return result
    }
    const raw = String((result.data && result.data.content) || '').replace(/\s/g, '')
    let text = ''
    try {
      text = Buffer.from(raw, 'base64').toString('utf8')
    } catch {
      text = ''
    }
    return { ok: true, cached: result.cached, text: text.slice(0, maxChars), truncated: text.length > maxChars }
  }

  return {
    tokenPresent: Boolean(token),
    rateLimit,
    reposBulk,
    repo,
    releases,
    commits,
    searchRepos,
    readme,
    getState: () => ({ ...state }),
    /** 给报告头用的一句话。 */
    quotaText: () => state.remaining === null ? '未知' : state.remaining + '/' + (state.limit == null ? '?' : state.limit),
  }
}
