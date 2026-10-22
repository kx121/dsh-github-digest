/**
 * 配置：默认值、归一化、读写。
 *
 * 三条约定：
 *   1. 读进来的任何值都先归一化（clamp / 去重 / 过滤非法项），UI 和后端共用同一套规则；
 *   2. 设置页没存过时，用 cordis.patch.yml 的行配置当初始值；存过之后以 config.json 为准；
 *   3. 配置里可以带 token，但对外接口（设置页 GET）只回 tokenConfigured 布尔值，不回明文。
 */
import { CONFIG_FILE } from './paths.js'
import { parseRepoRef } from './repo-ref.js'
import { clampInt, toBool, toStringSafe, readJsonSafe, writeJsonAtomic } from './util.js'

/** 关注仓库上限。再多一轮也看不完，只会让每轮都看不全。 */
export const MAX_WATCH = 60
/** 主题数量上限。 */
export const MAX_TOPICS = 20

export const DEFAULT_CONFIG = {
  enabled: true,
  watch_repos: [],
  discover_enabled: true,
  // 默认主题放宽：只填 dsh-plugin 时只能扫到几十个仓库，「大面积扫」扫不动。
  topics: ['ai agent', 'mcp', 'llm', 'developer tools', 'dsh-plugin'],
  // 用户背景：判断「对你有没有用」的第一依据。空 = 让模型按主题 / 关注仓库推断。
  profile_note: '',
  languages: [],
  // 这个插件是来找「有意思但还没火」的项目的，默认不卡 star。
  min_stars: 0,
  // 发现模式只看最近 N 天创建的项目；0 = 不限。
  discover_created_within_days: 30,
  // 粗筛默认不拉 releases：元信息就够筛，正文留给 watch。这是省配额的大头。
  brief_fetch_releases: false,
  // 每轮往报告里放几条。
  max_items_per_run: 6,
  // 每轮最多看几个仓库（粗筛是一次 Search 批量拿的，多看几个几乎不花配额）。
  max_repos_per_run: 40,
  // 冷门配额：每轮至少收几条 star ≤ cold_pick_max_stars 的项目。0 = 不强制。
  cold_pick_min: 0,
  cold_pick_max_stars: 500,
  // release 正文截断字符数：这段直接进模型上下文，600 是「够判断、不烧 token」的折中。
  release_body_chars: 600,
  read_readme: false,
  read_releases: true,
  read_commits: true,
  token: '',
  // 每轮新开一个会话（默认关：当天复用同一个）。
  fresh_session_per_run: false,
  // 值班会话归到哪个工作区（绝对路径）。空 = 自动挑宿主的默认工作区。
  workspace: '',
  // 默认 12:30 —— DeepSeek 峰时 09-12 / 14-18，12-14 是谷时，跑值班便宜一半。
  schedule: { mode: 'manual', at: '12:30', weekdays: [] },
  // 指定会话后永远投到它（锁定），不再自动新建 / 复用。
  target_session_id: '',
}

function normalizeStringList(value, maxItems, maxChars) {
  const list = Array.isArray(value) ? value : []
  const out = []
  for (const item of list) {
    const text = toStringSafe(item)
    if (!text || text.length > maxChars || out.includes(text)) continue
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

/** 关注仓库：解析成 owner/repo，非法项丢弃，去重，封顶。 */
export function normalizeRepos(value) {
  const list = Array.isArray(value) ? value : []
  const out = []
  for (const item of list) {
    const ref = parseRepoRef(item)
    if (!ref) continue
    if (!out.includes(ref.fullName)) out.push(ref.fullName)
    if (out.length >= MAX_WATCH) break
  }
  return out
}

/** 会话工作区：只接受本地绝对路径，挡掉 UNC / 相对路径 / 路径穿越。 */
export function normalizeWorkspace(value) {
  const text = toStringSafe(value)
  if (!text || text.length > 260 || text.includes('..')) return ''
  // UNC（两开头都是反斜杠，如 \\server\share）不算本地工作区。用 charCode 避开转义。
  if (text.charCodeAt(0) === 92 && text.charCodeAt(1) === 92) return ''
  // 有 scheme 但不是盘符形式的（file: / http: 这类）一律不收。
  if (/^[a-z]+:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) return ''
  return /^[a-z]:[\\/]/i.test(text) || text.startsWith('/') ? text : ''
}

/** 定时配置：mode 只认 manual/daily/weekdays，时间归一成 HH:mm。 */
export function normalizeSchedule(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const mode = raw.mode === 'daily' || raw.mode === 'weekdays' ? raw.mode : 'manual'
  const atRaw = String(raw.at || '')
  const at = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(atRaw) ? (atRaw.length === 4 ? '0' + atRaw : atRaw) : '12:30'
  const weekdays = Array.isArray(raw.weekdays)
    ? [...new Set(raw.weekdays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b)
    : []
  return { mode, at, weekdays }
}

/** 归一化整份配置。任何时候读到外部输入都过这一步。 */
export function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  return {
    enabled: toBool(raw.enabled, DEFAULT_CONFIG.enabled),
    watch_repos: normalizeRepos(raw.watch_repos),
    discover_enabled: toBool(raw.discover_enabled, DEFAULT_CONFIG.discover_enabled),
    topics: normalizeStringList(raw.topics, MAX_TOPICS, 60),
    profile_note: toStringSafe(raw.profile_note).slice(0, 600),
    languages: normalizeStringList(raw.languages, 20, 30),
    min_stars: clampInt(raw.min_stars, 0, 500000, DEFAULT_CONFIG.min_stars),
    discover_created_within_days: clampInt(raw.discover_created_within_days, 0, 365, DEFAULT_CONFIG.discover_created_within_days),
    brief_fetch_releases: toBool(raw.brief_fetch_releases, DEFAULT_CONFIG.brief_fetch_releases),
    max_items_per_run: clampInt(raw.max_items_per_run, 1, 20, DEFAULT_CONFIG.max_items_per_run),
    max_repos_per_run: clampInt(raw.max_repos_per_run, 1, MAX_WATCH, DEFAULT_CONFIG.max_repos_per_run),
    cold_pick_min: clampInt(raw.cold_pick_min, 0, 20, DEFAULT_CONFIG.cold_pick_min),
    cold_pick_max_stars: clampInt(raw.cold_pick_max_stars, 0, 2000000, DEFAULT_CONFIG.cold_pick_max_stars),
    release_body_chars: clampInt(raw.release_body_chars, 200, 3000, DEFAULT_CONFIG.release_body_chars),
    read_readme: toBool(raw.read_readme, DEFAULT_CONFIG.read_readme),
    read_releases: toBool(raw.read_releases, DEFAULT_CONFIG.read_releases),
    read_commits: toBool(raw.read_commits, DEFAULT_CONFIG.read_commits),
    token: toStringSafe(raw.token).slice(0, 300),
    fresh_session_per_run: toBool(raw.fresh_session_per_run, DEFAULT_CONFIG.fresh_session_per_run),
    workspace: normalizeWorkspace(raw.workspace),
    schedule: normalizeSchedule(raw.schedule),
    target_session_id: toStringSafe(raw.target_session_id).slice(0, 120),
  }
}

/**
 * 有效配置 = 默认值 ← cordis 行配置 ← config.json。
 * 行配置只在设置页还没存过时起作用（config.json 不存在时）。
 */
export function loadEffectiveConfig(rowConfig, configFile = CONFIG_FILE) {
  const stored = readJsonSafe(configFile, null)
  const base = normalizeConfig({ ...DEFAULT_CONFIG, ...(rowConfig || {}) })
  return stored && typeof stored === 'object' ? normalizeConfig({ ...base, ...stored }) : base
}

export function saveStoredConfig(config, configFile = CONFIG_FILE) {
  return writeJsonAtomic(configFile, normalizeConfig(config))
}

/** 给设置页 / 接口看的配置：去掉明文 token，只留是否已配置。 */
export function publicConfig(config) {
  const value = normalizeConfig(config)
  return { ...value, token: '', tokenConfigured: Boolean(normalizeConfig(config).token) }
}
