/**
 * HTTP 路由：设置页 / 面板的数据接口，以及手动触发。
 *
 * 两条硬约束：
 *   1. webServer 可能晚于插件就绪（冷启动时 ctx.get('webServer') 是 undefined），要等；
 *   2. 注册返回的 disposer 必须交给 ctx.effect，否则插件重载后会被拒 duplicate exact route。
 */
import { jsonResponse, readJsonSafe, toStringSafe, wellFormedDeep } from './util.js'
import { normalizeConfig, publicConfig, saveStoredConfig } from './config.js'
import { buildConfigPayload, buildPanel, buildStatus } from './panel-data.js'
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
 * 处理 POST /github-duty/config：
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

/** 路由表。runner 用于 /run-now；其余路由只读或写配置。 */
export function createRouteTable(runtime, runner) {
  let manualFiring = false
  return [
    {
      kind: 'exact',
      path: '/github-duty/config',
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
      path: '/github-duty/status',
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
      path: '/github-duty/panel',
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
      path: '/github-duty/run-now',
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
