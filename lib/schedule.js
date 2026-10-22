/**
 * 定时判定。纯函数 + 调度状态读写，不碰宿主 ctx。
 *
 * 语义：
 *   - manual：从不自动跑；
 *   - daily：每天到点后 CATCH_UP_MINUTES 内补跑一次（电脑睡眠错过也能补）；
 *   - weekdays：在 daily 基础上再限定星期。
 * 同一天最多跑一次（lastRunDate），定时器自己写当天日期，天然幂等。
 */
import { readJsonSafe, writeJsonAtomic, localDate } from './util.js'

/** 错过多久之内还补跑。超过这个窗口就等明天。 */
export const CATCH_UP_MINUTES = 360

/** "12:30" → 750，非法返回 null。 */
export function parseMinutes(at) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(at || ''))
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * 现在该不该跑。
 * state.lastRunDate 是「已经跑过的那天」，由定时路径在 fire 之前写入。
 */
export function scheduleDue(config, state, now = new Date()) {
  const schedule = (config && config.schedule) || {}
  const mode = schedule.mode
  if (mode !== 'daily' && mode !== 'weekdays') return false
  const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : []
  if (mode === 'weekdays' && weekdays.length && !weekdays.includes(now.getDay())) return false
  const target = parseMinutes(schedule.at)
  if (target === null) return false
  const gap = (now.getHours() * 60 + now.getMinutes()) - target
  if (gap < 0 || gap > CATCH_UP_MINUTES) return false
  if (state && state.lastRunDate === localDate(now)) return false
  return true
}

export function readScheduleState(file) {
  const value = readJsonSafe(file, null)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function writeScheduleState(file, state) {
  const value = state && typeof state === 'object' ? state : {}
  return writeJsonAtomic(file, value)
}
