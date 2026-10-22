/**
 * HTTP 路由：设置页 / 面板的数据接口，以及手动触发。
 *
 * 两条硬约束：
 *   1. webServer 可能晚于插件就绪（冷启动时 ctx.get('webServer') 是 undefined），要等；
 *   2. 注册返回的 disposer 必须交给 ctx.effect，否则插件重载后会被拒 duplicate exact route。
 */
import { jsonResponse, readJsonSafe, toStringSafe, wellFormedDeep } from './util.js'
import { MAX_WATCH, normalizeConfig, publicConfig, saveStoredConfig } from './config.js'
import { parseRepoRef } from './repo-ref.js'
import { buildConfigPayload, buildPanel, buildStatus, searchHistory } from './panel-data.js'
import { TRENDING_WINDOWS, fetchTrending } from './trending.js'
import { writeApplyProbe } from './probe.js'

const MAX_BODY_BYTES = 256 * 1024

/** 来源校验：只接受本机回环来源。跨站 / 陌生 Origin 直接 403。 */
export function requestRejection(ctx, req) {
  const headers = (req && req.headers) || {}
  const host = String(headers.host || '')
  if (host && !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(host)) return 403
  const source = String(headers.origin || headers.referer || '')
  if (source) {
    try {
      const url = new URL(source)
      const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
      const ownScheme = url.protocol === 'dsh-app:' || url.protocol === 'file:' || url.protocol === 'chrome-extension:'
      if (!loopback && !ownScheme) return 403
    } catch {
      return 403
    }
  }
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (connection && typeof connection.requestRejection === 'function') {
      const code = connection.requestRejection(req)
      if (code !== undefined && code !== null && code !== false) return typeof code === 'number' ? code : 403
    }
  } catch {
    return 403
  }
  return null
}

/** 读 JSON 请求体；超过上限 / 解析失败返回 null。 */
export function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        try { req.destroy() } catch { /* 连接可能已断 */ }
        resolve(null)
        return
      }
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * 处理 POST /github-digest/config：
 *   - token 不在 GET 里回明文，所以 POST 里 token 为空 = 不修改；clear_token:true 才清空。
 *   - 其它字段整体覆盖，normalizeConfig 负责 clamp / 过滤。
 */
export function applyConfigPost(runtime, body) {
  if (!body || typeof body !== 'object') return { code: 400, body: { ok: false, code: 'BAD_JSON', message: '请求体不是合法 JSON' } }
  const current = runtime.reloadConfig()
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  const merged = normalizeConfig({
    ...current,
    ...body,
    // token 单独处理：空字符串表示「不修改」，只有显式 clear_token 才清空。
    token: token || (body.clear_token === true ? '' : current.token),
  })
  const written = saveStoredConfig(merged)
  if (!written.ok) return { code: 500, body: { ok: false, code: 'CONFIG_WRITE_FAILED', message: '配置写不进去：' + written.error } }
  runtime.state.config = merged
  return { code: 200, body: { ok: true, config: publicConfig(merged) } }
}

/**
 * 处理 POST /github-digest/watch：只增删一个关注仓库，其它配置一个字节都不动。
 *
 * 为什么不复用 /config：面板拿不到完整配置，硬套就得先 GET 一次再整体 POST 回去，
 * 这中间设置页要是也保存过，两边会互相覆盖。而且「点一下关注」不该触发全量写入。
 */
export function applyWatchPost(runtime, body) {
  if (!body || typeof body !== 'object') return { code: 400, body: { ok: false, code: 'BAD_JSON', message: '请求体不是合法 JSON' } }
  const ref = parseRepoRef(body.repo)
  if (!ref) {
    return {
      code: 400,
      body: { ok: false, code: 'BAD_REPO_REF', message: '仓库格式要写 owner/repo（可带 @版本，会忽略）', hint: '例如 ollama/ollama' },
    }
  }
  const current = runtime.reloadConfig()
  const op = String(body.op || '') === 'remove' ? 'remove' : 'add'
  const list = current.watch_repos.slice()
  const key = ref.fullName.toLowerCase()
  const at = list.findIndex((item) => String(item).toLowerCase() === key)

  // 幂等：重复点「关注」或取消一个本来就没关注的，都返回成功但 changed:false。
  if (op === 'add' && at >= 0) {
    return { code: 200, body: { ok: true, changed: false, op, repos: list, count: list.length, message: '已在关注列表里' } }
  }
  if (op === 'remove' && at < 0) {
    return { code: 200, body: { ok: true, changed: false, op, repos: list, count: list.length, message: '本来就不在关注列表里' } }
  }
  // 上限要明说：normalizeRepos 超了是静默截断，按钮点了没反应会让人以为坏了。
  if (op === 'add' && list.length >= MAX_WATCH) {
    return {
      code: 409,
      body: {
        ok: false,
        code: 'WATCH_FULL',
        message: '关注仓库已满 ' + MAX_WATCH + ' 个，先取消几个再加',
        count: list.length,
        limit: MAX_WATCH,
      },
    }
  }
  if (op === 'add') list.push(ref.fullName)
  else list.splice(at, 1)

  const merged = normalizeConfig({ ...current, watch_repos: list })
  const written = saveStoredConfig(merged)
  if (!written.ok) {
    return { code: 500, body: { ok: false, code: 'CONFIG_WRITE_FAILED', message: '配置写不进去：' + written.error } }
  }
  runtime.state.config = merged
  return {
    code: 200,
    body: {
      ok: true,
      changed: true,
      op,
      repos: merged.watch_repos,
      count: merged.watch_repos.length,
      message: op === 'add' ? '已加入关注' : '已取消关注',
    },
  }
}

/** 路由表。runner 用于 /run-now；其余路由只读或写配置。 */
export function createRouteTable(runtime, runner) {
  let manualFiring = false
  return [
    {
      kind: 'exact',
      path: '/github-digest/config',
      handler: async (req, res) => {
        const current = runtime.reloadConfig()
        if (req.method === 'GET') {
          jsonResponse(res, 200, await buildConfigPayload(runtime))
          return
        }
        if (req.method !== 'POST') {
          jsonResponse(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 GET / POST' })
          return
        }
        const body = await readBody(req)
        const result = applyConfigPost(runtime, body)
        jsonResponse(res, result.code, result.body)
        void current
      },
    },
    {
      kind: 'exact',
      path: '/github-digest/watch',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const current = runtime.reloadConfig()
          jsonResponse(res, 200, { ok: true, repos: current.watch_repos, count: current.watch_repos.length, limit: MAX_WATCH })
          return
        }
        if (req.method !== 'POST') {
          jsonResponse(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 GET / POST' })
          return
        }
        const body = await readBody(req)
        const result = applyWatchPost(runtime, body)
        jsonResponse(res, result.code, result.body)
      },
    },
    {
      kind: 'exact',
      path: '/github-digest/status',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          jsonResponse(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 GET' })
          return
        }
        jsonResponse(res, 200, await buildStatus(runtime))
      },
    },
    {
      kind: 'exact',
      path: '/github-digest/search',
      handler: async (req, res) => {
        // 用 POST 而不是 GET + query：exact 路由的匹配口径不确定是否含 query string，
        // 把搜索词放 body 里就不依赖这个假设。
        if (req.method !== 'POST') {
          jsonResponse(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 POST' })
          return
        }
        const body = await readBody(req)
        const query = toStringSafe(body && body.q).slice(0, 120)
        if (!query.trim()) {
          jsonResponse(res, 200, { ok: true, query: '', count: 0, hits: [] })
          return
        }
        const current = runtime.reloadConfig()
        const paths = runtime.pathsFor(current)
        const hits = searchHistory(paths, query, Number(body && body.limit) || 50)
        jsonResponse(res, 200, { ok: true, query, count: hits.length, hits })
      },
    },
    {
      kind: 'exact',
      path: '/github-digest/panel',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          jsonResponse(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 GET' })
          return
        }
        jsonResponse(res, 200, buildPanel(runtime))
      },
    },
    {
      kind: 'exact',
      path: '/github-digest/run-now',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          jsonResponse(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 POST' })
          return
        }
        // 手动触发要防连点：fire 里有建会话、改名的 await，第二次点会再建一个会话。
        if (manualFiring) {
          jsonResponse(res, 409, { ok: false, code: 'BUSY', message: '上一轮还在启动，等它投递完再点' })
          return
        }
        manualFiring = true
        try {
          const result = await runner.fire('manual', '设置页点立即跑一轮')
          jsonResponse(res, result.ok ? 200 : 409, result)
        } finally {
          manualFiring = false
        }
      },
    },
    {
      kind: 'exact',
      path: '/github-digest/trending',
      handler: async (req, res) => {
        // 跟 /search 一样用 POST：不依赖 exact 路由对 query string 的处理方式。
        if (req.method !== 'POST') {
          jsonResponse(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 POST' })
          return
        }
        const body = await readBody(req)
        const current = runtime.reloadConfig()
        try {
          const result = await fetchTrending(runtime.clientFor(current), {
            windowKey: body && body.window,
            language: body && body.language,
            limit: body && body.limit,
          })
          if (!result.ok) {
            jsonResponse(res, 502, { ...result, availableWindows: TRENDING_WINDOWS })
            return
          }
          jsonResponse(res, 200, { ...result, availableWindows: TRENDING_WINDOWS })
        } catch (err) {
          jsonResponse(res, 500, {
            ok: false,
            code: 'TRENDING_FAILED',
            message: '拉榜单失败：' + String((err && err.message) || err),
          })
        }
      },
    },
  ]
}

/**
 * 注册全部路由。webServer 晚到也没关系：先挂起，服务就绪后统一注册。
 * 路由 handler 外面统一包来源校验 + 异常兜底，坏请求不会打穿到宿主。
 */
export function registerRoutes(runtime, runner) {
  const { ctx } = runtime
  const waiters = []
  let webServerRef = null

  const whenWebServer = (callback) => {
    if (webServerRef) {
      callback(webServerRef)
      return
    }
    waiters.push(callback)
    if (waiters.length > 1) return
    const flush = (server) => {
      webServerRef = server
      for (const waiter of waiters.splice(0)) {
        try {
          waiter(server)
        } catch (err) {
          runtime.log('warn', 'webServer 回调出错：' + String((err && err.message) || err))
        }
      }
    }
    const immediate = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (immediate && typeof immediate.register === 'function') {
      flush(immediate)
      return
    }
    if (typeof ctx.inject !== 'function') {
      waiters.length = 0
      writeApplyProbe({ phase: 'webserver-missing' })
      return
    }
    try {
      ctx.inject(['webServer'], () => {
        const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
        if (server) flush(server)
      })
    } catch (err) {
      waiters.length = 0
      writeApplyProbe({ phase: 'webserver-inject-failed', error: String((err && err.message) || err) })
    }
  }

  for (const route of createRouteTable(runtime, runner)) {
    const inner = typeof route.handler === 'function' ? route.handler : null
    if (!inner) continue
    const guarded = {
      ...route,
      handler: async (req, res) => {
        const denied = requestRejection(ctx, req)
        if (denied !== null) {
          jsonResponse(res, denied, { ok: false, code: 'UNTRUSTED_ORIGIN', message: '来源不受信（code=' + denied + '）' })
          return
        }
        try {
          await inner(req, res)
        } catch (err) {
          runtime.log('warn', '路由 ' + route.path + ' 失败：' + String((err && err.message) || err))
          jsonResponse(res, 500, { ok: false, code: 'ROUTE_FAILED', message: String((err && err.message) || err) })
        }
      },
    }
    whenWebServer((webServer) => {
      // disposer 必须交给 ctx.effect，否则重载后 duplicate exact route。
      ctx.effect(() => {
        const dispose = webServer.register(guarded)
        return () => {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            /* 忽略 */
          }
        }
      })
    })
  }
}
