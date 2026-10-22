/**
 * 会话：工作区解析、新建、唤醒、改名、列表、当天复用。
 *
 * 这一层是宿主 API 适配层。宿主没有公开文档，所以：
 *   - 每个 API 都先探测再用，猜错只返回「方法不存在」，没有副作用；
 *   - 失败路径全部抛出可读的 code，不假装成功；
 *   - 探测结果写进 apply-probe，方便下一版收敛。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SESSION_PROJCACHE_DIR } from './paths.js'
import { methodNames } from './util.js'

/**
 * 读宿主的会话投影缓存，列出本机所有会话（含没挂载的）。
 *
 * 每个会话一个 json：
 *   record.rows.title.val                 → 标题
 *   record.rows.sessionListMetadata.val   → { blank, lastPromptAt }
 *   record.identity.cwd / createdAt       → 工作目录、创建时间
 *
 * 为什么不能只问 agents.list()：它只返回已挂载的实例，设置页下拉经常是空的（实测）。
 */
export function readSessionIndex(projcacheDir) {
  const out = []
  try {
    for (const name of fs.readdirSync(projcacheDir)) {
      if (!name.endsWith('.json')) continue
      const shortId = name.slice(0, -5)
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(projcacheDir, name), 'utf8'))
        const record = (raw && raw.record) || {}
        const rows = record.rows || {}
        const meta = (rows.sessionListMetadata && rows.sessionListMetadata.val) || {}
        // blank = 建了但一句话没说，列进下拉只是噪音。
        if (meta.blank === true) continue
        const title = rows.title && rows.title.val ? String(rows.title.val).trim() : ''
        out.push({
          id: shortId.startsWith('session-') ? shortId : 'session-' + shortId,
          title: title || shortId.slice(0, 8),
          cwd: String((record.identity && record.identity.cwd) || ''),
          lastAt: Number(meta.lastPromptAt) || Number((record.identity && record.identity.createdAt) || 0) || 0,
        })
      } catch {
        /* 单个读坏跳过，不影响别的 */
      }
    }
  } catch {
    return out
  }
  out.sort((a, b) => b.lastAt - a.lastAt)
  return out
}

/**
 * 建一组绑定到某个 ctx 的会话操作。
 * 返回的方法都只依赖宿主服务，离线下用 mock ctx 可以直接测。
 */
export function createSessionOps({ ctx, log, probe }) {
  const getService = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
  let sessionIndexCache = { at: 0, list: [] }
  let lastWorkspaceTarget = null
  let createSessionError = ''

  /**
   * 决定新会话归到哪个工作区。
   * 关键：优先给 workspaceId —— 只给 cwd 时宿主会把会话建在正确目录，但不写进该工作区的
   * sessionIds，侧边栏看起来就像新建的分区（实测踩到）。
   */
  function resolveWorkspaceTarget(config) {
    const wantedWorkspace = config && config.workspace ? String(config.workspace) : ''
    const registry = getService('workspaceRegistry')
    if (wantedWorkspace) {
      if (registry && typeof registry.list === 'function') {
        try {
          const wanted = wantedWorkspace.replace(/\\/g, '/').toLowerCase()
          const list = registry.list()
          if (Array.isArray(list)) {
            for (const w of list) {
              const id = String((w && (w.id || w.workspaceId)) || '')
              const wpath = String((w && (w.path || w.root || w.cwd || w.directory)) || '').replace(/\\/g, '/').toLowerCase()
              if (id && wpath && wpath === wanted) return { workspaceId: id, cwd: wantedWorkspace, via: 'config+registry' }
            }
          }
        } catch {
          /* 查不到就只用 cwd */
        }
      }
      return { cwd: wantedWorkspace, via: 'config' }
    }
    if (registry && typeof registry.list === 'function') {
      try {
        const list = registry.list()
        if (Array.isArray(list) && list.length) {
          const mapped = list.map((w) => ({
            id: String((w && (w.id || w.workspaceId)) || ''),
            path: String((w && (w.path || w.root || w.cwd || w.directory)) || ''),
          })).filter((w) => w.id || w.path)
          const preferred = mapped.find((w) => /default-workspace/i.test(w.path.replace(/\\/g, '/'))) || mapped[0]
          if (preferred && preferred.id) return { workspaceId: preferred.id, cwd: preferred.path, via: 'registry' }
          if (preferred && preferred.path) return { cwd: preferred.path, via: 'registry-path' }
        }
      } catch {
        /* 拿不到工作区就退回进程 cwd */
      }
    }
    return { cwd: process.cwd(), via: 'process-cwd' }
  }

  /** 新建会话。优先 sessionController.create，旧宿主走 apiProxy.sessions.create。 */
  async function createSession(config) {
    const target = resolveWorkspaceTarget(config)
    lastWorkspaceTarget = target
    const payload = target.workspaceId ? { workspaceId: target.workspaceId } : { cwd: target.cwd }
    const controller = getService('sessionController')
    if (controller && typeof controller.create === 'function') {
      try {
        let created = null
        try {
          created = await controller.create(payload)
        } catch (err) {
          // workspaceId 被拒时退回 cwd 再试一次（宿主版本差异）。
          createSessionError = 'create(workspaceId) 失败：' + String((err && err.message) || err)
          created = await controller.create({ cwd: target.cwd })
        }
        const id = String((created && (created.sessionId || created.id)) || '')
        if (id) return { ok: true, sessionId: id, via: 'sessionController', workspace: target }
        createSessionError = 'sessionController.create 没返回 sessionId'
      } catch (err) {
        createSessionError = 'sessionController.create 失败：' + String((err && err.message) || err)
      }
    }
    const apiProxy = getService('apiProxy')
    if (apiProxy && apiProxy.sessions && typeof apiProxy.sessions.create === 'function') {
      try {
        const response = await apiProxy.sessions.create({ rpcId: randomUUID(), payload })
        if (response && response.result && response.result.ok) {
          const id = String((response.result.value && response.result.value.sessionId) || '')
          if (id) return { ok: true, sessionId: id, via: 'apiProxy', workspace: target }
        }
        createSessionError = 'apiProxy.sessions.create 返回失败：' + String((response && response.result && response.result.error && response.result.error.message) || '未知')
      } catch (err) {
        createSessionError = 'apiProxy.sessions.create 失败：' + String((err && err.message) || err)
      }
    }
    return {
      ok: false,
      code: 'NO_SESSION_CREATE',
      message: '没法自动新建会话（宿主没提供 sessionController / apiProxy）' + (createSessionError ? '：' + createSessionError : ''),
    }
  }

  /**
   * 给会话命名。宿主没有公开的改名接口，依次试候选方法名：
   * 猜错只会返回「方法不存在」，没有副作用；哪个成功记进 apply-probe。
   */
  async function renameSession(sessionId, title) {
    const controller = getService('sessionController')
    const apiProxy = getService('apiProxy')
    const attempts = []
    if (controller && typeof controller.setTitle === 'function') attempts.push(['sessionController.setTitle', () => controller.setTitle({ sessionId, title })])
    if (controller && typeof controller.rename === 'function') attempts.push(['sessionController.rename', () => controller.rename({ sessionId, title })])
    if (apiProxy && apiProxy.sessions && typeof apiProxy.sessions.setTitle === 'function') {
      attempts.push(['apiProxy.sessions.setTitle', () => apiProxy.sessions.setTitle({ rpcId: randomUUID(), payload: { sessionId, title } })])
    }
    if (apiProxy && apiProxy.sessions && typeof apiProxy.sessions.rename === 'function') {
      attempts.push(['apiProxy.sessions.rename', () => apiProxy.sessions.rename({ rpcId: randomUUID(), payload: { sessionId, title } })])
    }
    for (const [name, run] of attempts) {
      try {
        const result = await run()
        if (result && result.result && result.result.ok === false) continue
        return { ok: true, via: name }
      } catch {
        /* 试下一个 */
      }
    }
    return { ok: false, tried: attempts.length }
  }

  /**
   * 让一个「没挂载」的会话重新变成可投递状态。
   *
   * 宿主事实（0.2.1-rc.2 源码核实）：
   *   - sessionController 没有 resume/activate/load/open 这些方法；
   *   - 官方恢复入口是 sessionController.resolveAgent(sessionId) → agent | { error }；
   *   - agents.resume 需要 { resumeSessionId, agentOptions, setup }，插件拿不到 setup，只能作为次选；
   *   - 投递还有一层兜底 sessionController.prompt()，它内部会先 resolveAgent 再 admit。
   * 旧版试的四个方法名在当前宿主全部不存在，导致「当天复用」静默退化成每轮新建。
   */
  async function wakeSession(sessionId) {
    const agents = getService('agents')
    const controller = getService('sessionController')
    const pick = () => {
      const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null
      return agent && typeof agent.followup === 'function' ? agent : null
    }
    const ready = pick()
    if (ready) return { agent: ready, via: 'already-mounted', tried: [] }

    const tried = []
    const attempts = []
    if (controller && typeof controller.resolveAgent === 'function') {
      attempts.push(['sessionController.resolveAgent', async () => {
        const resolved = await controller.resolveAgent(sessionId)
        if (resolved && resolved.error) throw resolved.error
        return resolved && typeof resolved.followup === 'function' ? resolved : null
      }])
    }
    if (agents && typeof agents.resume === 'function') {
      attempts.push(['agents.resume', async () => {
        const handle = await agents.resume({ resumeSessionId: sessionId })
        return (handle && handle.agent) || pick()
      }])
    }
    for (const [label, run] of attempts) {
      tried.push(label)
      try {
        const agent = await run()
        const found = agent && typeof agent.followup === 'function' ? agent : pick()
        if (found) return { agent: found, via: label, tried }
      } catch {
        /* 试下一个 */
      }
    }
    // 旧宿主兼容探测：字符串参数的 resume/activate/load/open。没有就快速跳过。
    for (const [label, api] of [['sessionController', controller], ['agents', agents]]) {
      if (!api) continue
      for (const name of ['resume', 'activate', 'load', 'open']) {
        if (typeof api[name] !== 'function') continue
        tried.push(label + '.' + name)
        try {
          await api[name](sessionId)
        } catch {
          continue
        }
        for (let i = 0; i < 3; i += 1) {
          const agent = pick()
          if (agent) return { agent, via: label + '.' + name, tried }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    }
    return { agent: null, via: '', tried }
  }

  /**
   * 投递兜底：sessionController.prompt(request) 会内部 resolveAgent 再 admit。
   * 返回 { ok, via } 或 { ok:false, code, message }。成功后消息来源由宿主标成 user。
   */
  async function promptSession(sessionId, text) {
    const controller = getService('sessionController')
    if (!controller || typeof controller.prompt !== 'function') {
      return { ok: false, code: 'NO_PROMPT_API', message: '宿主没有 sessionController.prompt，无法兜底投递' }
    }
    try {
      const result = await controller.prompt({
        sessionId,
        content: [{ type: 'text', text }],
        requestId: randomUUID(),
      })
      return { ok: true, via: 'sessionController.prompt', result }
    } catch (err) {
      return { ok: false, code: 'PROMPT_FAILED', message: String((err && err.message) || err) }
    }
  }

  /**
   * 会话是否已归档。
   *
   * 宿主事实（0.2.1-rc.2 源码核实）：归档状态挂在 `workspaceRegistry.archivedSessionIds` 上。
   * 归档会话还能被 resolveAgent / prompt 唤醒，投递也不报错，但宿主的 `archived-session-gate`
   * 会在 agent/pre-step 直接 reject，这一轮静默 blocked——执行记录写着 ok，用户却看不到新对话。
   * 所以「投递成功」不等于「能跑」，复用前必须先查这个集合。
   */
  function isArchivedSession(sessionId) {
    const registry = getService('workspaceRegistry')
    if (!registry || !sessionId) return false
    try {
      const ids = registry.archivedSessionIds
      if (!ids) return false
      if (Array.isArray(ids)) return ids.includes(sessionId)
      if (typeof ids.has === 'function') return ids.has(sessionId)
      if (typeof ids[Symbol.iterator] === 'function') return [...ids].includes(sessionId)
    } catch {
      /* 宿主导出失败按未归档处理：不能因为查不到就卡住投递 */
    }
    return false
  }

  /**
   * 今天已经跑过的那轮用的会话 id，用于当天复用。
   * 已归档的跳过（否则会一直往归档会话里投，永远不新建）；pending 比 history 新，先看它。
   */
  function findTodaysSession(paths, localDateFn) {
    const today = localDateFn()
    const candidates = []
    try {
      const pendingText = paths.pending && fs.existsSync(paths.pending) ? fs.readFileSync(paths.pending, 'utf8') : ''
      const pending = pendingText ? JSON.parse(pendingText) : null
      if (pending && pending.sessionId && String(pending.atText || '').startsWith(today)) candidates.push(pending.sessionId)
    } catch {
      /* 忽略 */
    }
    try {
      const history = paths.history ? readHistoryLite(paths.history) : []
      for (const row of history) {
        if (row && row.sessionId && String(row.at || '').startsWith(today)) candidates.push(row.sessionId)
      }
    } catch {
      /* 读不到就新建 */
    }
    const seen = new Set()
    for (const id of candidates) {
      if (seen.has(id)) continue
      seen.add(id)
      if (!isArchivedSession(id)) return id
    }
    return ''
  }

  /** 已挂载的 agent；拿不到返回 null。 */
  function getAgent(sessionId) {
    const agents = getService('agents')
    if (!agents || typeof agents.get !== 'function') return null
    const agent = agents.get(sessionId)
    return agent && typeof agent.followup === 'function' ? agent : null
  }

  /** 会话是否正忙（冒烟：上一轮还没跑完 / 用户正在里面聊天）。 */
  function isBusy(agent) {
    if (!agent) return false
    if (agent.status === 'running' || agent.busy === true) return true
    return Boolean(agent.session && agent.session.status === 'running')
  }

  /** 设置页「目标会话」下拉：投影缓存 + 已挂载实例，60 秒缓存。 */
  function listLiveSessions() {
    const now = Date.now()
    if (now - sessionIndexCache.at < 60 * 1000) return sessionIndexCache.list
    const byId = new Map()
    for (const item of readSessionIndex(SESSION_PROJCACHE_DIR)) byId.set(item.id, item)
    try {
      const agents = getService('agents')
      if (agents && typeof agents.list === 'function') {
        for (const agent of agents.list()) {
          const rawId = String((agent && (agent.id || (agent.session && agent.session.id))) || '')
          if (!rawId) continue
          const id = rawId.startsWith('session-') ? rawId : 'session-' + rawId
          const title = String((agent && (agent.title || (agent.session && (agent.session.title || agent.session.name)))) || '')
          const prev = byId.get(id)
          if (prev) {
            if (title) prev.title = title
            prev.lastAt = Math.max(prev.lastAt || 0, now)
          } else {
            byId.set(id, { id, title: title || rawId.slice(0, 8), cwd: '', lastAt: now })
          }
        }
      }
    } catch {
      /* 忽略 */
    }
    const list = [...byId.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    sessionIndexCache = { at: now, list }
    return list
  }

  /** 探测宿主方法名，供 apply-probe 记录。 */
  function probeHostMethods() {
    return {
      controllerMethods: methodNames(getService('sessionController')),
      agentMethods: methodNames(getService('agents')),
    }
  }

  return {
    resolveWorkspaceTarget,
    createSession,
    renameSession,
    wakeSession,
    promptSession,
    findTodaysSession,
    isArchivedSession,
    getAgent,
    isBusy,
    listLiveSessions,
    probeHostMethods,
    getLastWorkspaceTarget: () => lastWorkspaceTarget,
  }
}

/** findTodaysSession 用：只读最后几行就够，不必解析整个 history。 */
function readHistoryLite(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim())
    return lines.slice(-50).map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean).reverse()
  } catch {
    return []
  }
}
