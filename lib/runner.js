/**
 * 调度层：到点（或手动）把一轮值班投进会话，并把这一轮的执行记录 / 成本基线落盘。
 *
 * fire() 是所有失败路径的唯一出口：每一处失败都写 runs.md 一行（failed），不许静默。
 * 定时路径不用锁：scheduleDue 在 fire 之前写 lastRunDate，天然幂等（失败也算跑过，
 * 当天不再自动重试 —— 失败原因写进 schedule-state，用户可手动补跑）。
 * 手动路径在路由层加锁，防止连点建出两个会话。
 */
import path from 'node:path'
import { appendRow, writePending, readPending, RUN_COLUMNS } from './store.js'
import { readScheduleState, scheduleDue, writeScheduleState } from './schedule.js'
import { localDate, localStamp, ensureDir } from './util.js'
import { readSessionCostTotals } from './cost.js'
import { buildWakeMessage, readPromptText } from './wake-message.js'
import { resolveCreateUserMessage } from './llm.js'

/** 宿主 ctx.interval 的单位是毫秒（cordis-plugin-timer 直接传给原生 setInterval）。 */
const TICK_INTERVAL_MS = 60 * 1000
const RUNS_TITLE = 'github-duty 执行记录'

export function createRunner(runtime) {
  const { ctx, state } = runtime

  /** 投递一轮。返回 { ok, code, message, sessionId, firedAt, created, reused, deliveredVia }。 */
  async function fire(trigger, reason = '') {
    const current = runtime.reloadConfig()
    await runtime.refreshCredential(current)
    const paths = runtime.pathsFor(current)
    // 目录由插件先建好，省得会话第一次写日报还要自己 mkdir（失败一次就白跑一轮）。
    ensureDir(paths.outDir)
    const firedAt = localStamp()
    const firedAtMs = Date.now()

    // 每写一次原因就落盘一次：手动跑也要更新「上次运行」，不能只在定时器里写。
    const note = (text) => {
      state.lastFireReason = text
      try {
        writeScheduleState(runtime.env.scheduleStateFile, {
          ...readScheduleState(runtime.env.scheduleStateFile),
          lastFireAt: firedAt,
          lastFireReason: text,
        })
      } catch {
        /* 记不上不影响值班 */
      }
      return text
    }
    const writeFail = (message) => {
      appendRow(paths.runs, RUNS_TITLE, RUN_COLUMNS, [firedAt, trigger, 'failed', current.watch_repos.length, 0, 0, '-', note(message)])
      runtime.probe({ phase: 'fire-failed', trigger, sessionId: '', message: String(message || '') })
    }

    if (!current.enabled) {
      writeFail('总开关关着（enabled=false），本轮停跑')
      return { ok: false, code: 'DISABLED', message: state.lastFireReason }
    }

    // 上一轮如果没走 run_add，pending 会被这一轮覆盖。先备份，避免成本基线静默丢失。
    let pendingBackup = ''
    try {
      const previous = readPending(paths.pending)
      if (previous && (previous.sessionId || previous.repos || previous.reposMeta)) {
        writePending(path.join(paths.home, 'pending-run.prev.json'), previous)
        pendingBackup = String(previous.atText || '') + '｜' + String(previous.sessionId || '')
      }
    } catch {
      /* 备份失败不影响本轮 */
    }

    const promptText = readPromptText(paths.prompt)
    const messageText = buildWakeMessage(current, paths, promptText.text, {
      trigger,
      firedAt,
      credential: runtime.credentialSnapshot(),
    })

    let sessionId = current.target_session_id
    const targetLocked = Boolean(sessionId)
    let created = false
    let reused = false
    let renamedVia = ''

    /** 新建会话并改名。 */
    const createSessionForRun = async () => {
      const made = await runtime.sessions.createSession(current)
      if (!made.ok) return { ok: false, code: made.code || 'NO_TARGET', message: made.message || '自动新建会话失败' }
      sessionId = made.sessionId
      created = true
      const wantedTitle = localDate().slice(5) + ' GitHub 项目推荐'
      const renamed = await runtime.sessions.renameSession(sessionId, wantedTitle)
      renamedVia = renamed.ok ? renamed.via : ('failed(候选 ' + renamed.tried + ' 个)')
      return { ok: true }
    }

    // 当天已经建过值班会话就复用它，不要每跑一轮就多一个会话。
    // 用户明确指定 target_session_id 时永远用指定的那个（锁定）。
    if (!sessionId && !current.fresh_session_per_run) {
      const todayId = runtime.sessions.findTodaysSession(paths, () => runtime.env.today())
      if (todayId) {
        const live = runtime.sessions.getAgent(todayId)
        if (!runtime.sessions.isBusy(live)) {
          sessionId = todayId
          reused = true
        }
      }
    }

    if (!sessionId) {
      const made = await createSessionForRun()
      if (!made.ok) {
        writeFail(made.message)
        return { ok: false, code: made.code || 'NO_TARGET', message: state.lastFireReason }
      }
    }

    /**
     * 投递。拿不到已挂载 agent 时：
     *   1) wakeSession 走官方恢复（sessionController.resolveAgent / agents.resume）；
     *   2) 还不行就用 sessionController.prompt 兜底（它内部也会 resolveAgent）。
     * 旧版只试不存在的四个方法名，导致空闲会话被卸载后「当天复用」静默退化成每轮新建。
     */
    const deliver = async () => {
      // 新会话可能还没在老注册表里挂上，给一次极短等待（不轮询，不阻塞定时器）。
      if (created) await new Promise((resolve) => setTimeout(resolve, 300))
      let agent = runtime.sessions.getAgent(sessionId)
      if (!agent) {
        const woken = await runtime.sessions.wakeSession(sessionId)
        agent = woken.agent
        if (woken.tried && woken.tried.length) {
          runtime.probe({
            phase: agent ? 'session-woken' : 'session-wake-failed',
            sessionId,
            via: woken.via,
            tried: woken.tried,
            ...runtime.sessions.probeHostMethods(),
          })
        }
      }
      if (agent) {
        const { createUserMessage } = await resolveCreateUserMessage()
        // source.kind 不能叫 plugin，DSH session format v4 直接拒。
        agent.followup(createUserMessage({ content: [{ type: 'text', text: messageText }], source: { kind: 'github-duty' } }))
        return { ok: true, via: 'followup' }
      }
      const prompted = await runtime.sessions.promptSession(sessionId, messageText)
      if (prompted.ok) return { ok: true, via: prompted.via }
      return { ok: false, code: 'NO_SESSION', message: prompted.message || '会话不可投递' }
    }

    let delivery = await deliver()
    // 复用的会话恢复失败：回退新建一次，别让这一轮白跑。按用户指定的会话不做替换。
    if (!delivery.ok && !created && !targetLocked) {
      const made = await createSessionForRun()
      if (made.ok) delivery = await deliver()
    }
    if (!delivery.ok) {
      writeFail('投递失败：' + (delivery.message || '会话不可投递'))
      return { ok: false, code: delivery.code || 'NO_SESSION', message: state.lastFireReason, sessionId }
    }

    note('已唤醒会话' + (created ? '（新建 ' + sessionId.slice(0, 8) + '）' : '') + (reason ? '：' + reason : '') + '｜准则 ' + promptText.source + '｜投递 ' + delivery.via)
    appendRow(paths.runs, RUNS_TITLE, RUN_COLUMNS, [firedAt, trigger, 'ok', current.watch_repos.length, 0, 0, '-', state.lastFireReason])

    // 记一笔待回填的成本基线：这一轮跑完由 run_add 用前后差值算本轮费用。
    try {
      const costBase = readSessionCostTotals(runtime.env.projcacheDir, sessionId) ||
        // 新建会话没有历史成本，基线显式给 0 —— 否则会被判成「没有基线、不可信」。
        (created ? { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0 } : null)
      writePending(paths.pending, {
        at: firedAtMs,
        atText: firedAt,
        trigger,
        sessionId,
        created,
        watchCount: current.watch_repos.length,
        costBase,
      })
    } catch {
      /* 记不上不影响值班 */
    }

    runtime.probe({
      phase: 'fire-done',
      trigger,
      sessionId,
      created,
      reused,
      deliveredVia: delivery.via,
      renamed: renamedVia,
      pendingBackup,
    })
    return { ok: true, code: 'WOKEN', sessionId, firedAt, created, reused, deliveredVia: delivery.via }
  }

  /** 60 秒一跳。到点后 fire 是异步的，不阻塞下一次 tick。 */
  function startTimer() {
    try {
      if (typeof ctx.interval !== 'function') {
        runtime.probe({ phase: 'timer-unavailable' })
        return
      }
      ctx.effect(() => ctx.interval(() => {
        try {
          const current = runtime.reloadConfig()
          if (!current.enabled) return
          const schedState = readScheduleState(runtime.env.scheduleStateFile)
          if (!scheduleDue(current, schedState)) return
          // 先记日期再 fire：进程在中途挂掉也不会同一天重复跑。
          writeScheduleState(runtime.env.scheduleStateFile, {
            ...schedState,
            lastRunDate: localDate(),
            lastFireAt: localStamp(),
          })
          void fire('schedule', '定时到点 ' + current.schedule.at).catch((err) => {
            runtime.probe({ phase: 'fire-failed', trigger: 'schedule', message: String((err && err.message) || err) })
          })
        } catch (err) {
          runtime.probe({ phase: 'tick-failed', error: String((err && err.message) || err) })
        }
      }, TICK_INTERVAL_MS))
    } catch (err) {
      runtime.probe({ phase: 'timer-failed', error: String((err && err.message) || err) })
    }
  }

  return { fire, startTimer }
}
