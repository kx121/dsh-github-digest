/**
 * 运行时：把配置、路径、凭据、GitHub 客户端、会话操作组装成一个对象，
 * 传给工具层 / 路由层 / 调度层。所有跨模块共享的可变状态都收在这里，不再散落成一堆闭包变量。
 */
import { loadEffectiveConfig } from './config.js'
import { resolvePaths, VERSION, SESSION_PROJCACHE_DIR, COST_LEDGER_FILE, SCHEDULE_STATE_FILE } from './paths.js'
import { localDate } from './util.js'
import { writeApplyProbe } from './probe.js'
import { createSessionOps } from './sessions.js'
import { detectCredential, describeSource, maskToken } from './credential.js'
import { createGithubClient } from './github.js'

export function createRuntime(ctx, rowConfig = {}) {
  const state = {
    config: loadEffectiveConfig(rowConfig),
    credential: { token: '', source: '', detail: '', tried: [], at: 0 },
    lastFireReason: '',
  }

  /** 宿主 logger 是「ctx.logger(level) → 写函数」的形态，不能直接把消息当 level 传。 */
  const log = (level, message) => {
    try {
      const write = typeof ctx.logger === 'function' ? ctx.logger(level) : null
      if (typeof write === 'function') write('[github-digest] ' + message)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  const probe = (extra = {}) => writeApplyProbe(extra)

  /** 每次工具调用 / 定时 tick 都重读配置：设置页改完立刻生效，不必重启。 */
  const reloadConfig = () => {
    state.config = loadEffectiveConfig(rowConfig)
    return state.config
  }

  const sessions = createSessionOps({ ctx, log, probe })

  /** 本轮该用哪个工作区：配置 → 宿主默认工作区 → 进程 cwd。 */
  const workspaceCwd = (config) => {
    const target = sessions.resolveWorkspaceTarget(config)
    if (target && target.cwd) return target.cwd
    return (config && config.workspace) ? config.workspace : ''
  }

  /** 日报目录跟着工作区走；插件数据仍在 ~/.dsh/github-digest。 */
  const pathsFor = (config) => resolvePaths(workspaceCwd(config))

  /** 凭据：手填优先，其次本机自动探测；探测结果 5 分钟缓存。 */
  const refreshCredential = async (current, force) => {
    const manual = String((current && current.token) || '').trim()
    if (manual) {
      state.credential = { token: manual, source: 'manual', detail: '设置页填写', tried: [], at: Date.now() }
      return state.credential
    }
    try {
      const found = await detectCredential({ force: force === true })
      state.credential = {
        token: (found && found.token) || '',
        source: (found && found.source) || '',
        detail: (found && found.detail) || '',
        tried: (found && found.tried) || [],
        at: Date.now(),
      }
    } catch {
      state.credential = { token: '', source: '', detail: '', tried: [], at: Date.now() }
    }
    return state.credential
  }

  /** 给设置页 / 面板的凭据状态。token 只以掩码形式出去。 */
  const credentialSnapshot = () => {
    const token = state.credential.token
    return {
      present: Boolean(token),
      source: state.credential.source,
      sourceLabel: describeSource(state.credential.source),
      masked: maskToken(token),
      anonymous: !token,
      quotaLimit: token ? 5000 : 60,
      tried: state.credential.tried,
    }
  }

  /** GitHub 客户端单例：ETag 缓存在实例里，每轮 new 一个会让 brief→watch 重复打同样的 URL。 */
  let clientRef = null
  let clientTokenKey = null
  const clientFor = (current) => {
    const token = String((current && current.token) || state.credential.token || '')
    if (!clientRef || clientTokenKey !== token) {
      clientRef = createGithubClient({
        token,
        userAgent: 'dsh-github-digest/' + VERSION,
        log: (message) => log('warn', message),
      })
      clientTokenKey = token
    }
    return clientRef
  }

  return {
    ctx,
    state,
    log,
    probe,
    reloadConfig,
    pathsFor,
    workspaceCwd,
    refreshCredential,
    credentialSnapshot,
    clientFor,
    sessions,
    /** 测试 / 数据层需要的环境路径。 */
    env: {
      projcacheDir: SESSION_PROJCACHE_DIR,
      ledgerFile: COST_LEDGER_FILE,
      scheduleStateFile: SCHEDULE_STATE_FILE,
      today: () => localDate(),
    },
  }
}
