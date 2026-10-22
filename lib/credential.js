/**
 * 从本机已有的地方捞一个 GitHub token。
 *
 * 为什么要这个文件：让用户去 Settings 页手动创建 token 是本插件最大的门槛。
 * 但很多机器上其实早就躺着 token 了 —— git 推送过、GitHub Desktop / VS Code 登录过、gh CLI 登录过。
 * 这里按代价从低到高挨个试，全部只读、失败静默、token 只进内存。
 *
 * 纪律：
 *   1. 只读：不写凭据、不改 git config、不触发任何交互；
 *   2. 失败静默：探测不到返回空 token，插件回到匿名模式（60 次/小时）继续干活；
 *   3. 不外泄：日志里只出现 maskToken() 后的前 4 后 4 位。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const DETECT_TIMEOUT_MS = 5000
const CACHE_TTL_MS = 5 * 60 * 1000

/** 来源 → 给用户看的说法。顺序也是探测顺序。 */
export const SOURCE_LABELS = {
  env: '环境变量',
  'gh-cli': 'gh 命令行',
  'gh-hosts': 'gh 配置文件',
  'git-credentials': '.git-credentials',
  'credential-manager': '系统凭据管理器',
  manual: '设置页填写',
}

export function describeSource(source) {
  return SOURCE_LABELS[String(source || '')] || ''
}

/** 只留前 4 后 4 位，够用户认出是哪把，又不足以复原。 */
export function maskToken(token) {
  const value = String(token || '')
  if (!value) return ''
  if (value.length < 12) return '***'
  return value.slice(0, 4) + '\u2026' + value.slice(-4)
}

/**
 * 判断一段文本像不像 GitHub token。
 * classic 前缀 ghp_ / gho_ / ghu_ / ghs_ / ghr_，fine-grained 是 github_pat_；
 * 另外放宽接受 40 位以上的 urlsafe 串（部分 OAuth 返回不带前缀）。
 */
export function looksLikeToken(value) {
  const text = String(value == null ? '' : value).trim()
  if (text.length < 20 || text.length > 300) return false
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return false
  return /^(gh[pousr]_|github_pat_)/.test(text) || /^[A-Za-z0-9_-]{40,}$/.test(text)
}

/** 解析 ~/.git-credentials：每行 https://user:token@github.com */
export function parseGitCredentials(text) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = /^https:\/\/([^:@/\s]+):([^@/\s]+)@github\.com\/?$/.exec(line)
    if (!m) continue
    let token = m[2]
    try {
      token = decodeURIComponent(token)
    } catch {
      /* 编码坏了就用原串 */
    }
    if (looksLikeToken(token)) return { token, username: m[1] }
  }
  return null
}

/**
 * 解析 gh 的 hosts.yml，只认 github.com 那一段。
 * 格式缩进敏感，逐行扫 —— 企业版 host 在前时不能取错。
 */
export function parseGhHosts(text) {
  let inGithub = false
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line) continue
    if (/^\S/.test(line)) {
      inGithub = /^github\.com\s*:\s*$/.test(line)
      continue
    }
    if (!inGithub) continue
    const m = /^\s+oauth_token:\s*([^\s#]+)/.exec(line)
    if (m && looksLikeToken(m[1])) return m[1]
  }
  return null
}

/** 解析 git credential fill 的输出（key=value 多行，取 password=）。 */
export function parseCredentialFill(text) {
  const m = /^password=(.+)$/m.exec(String(text || ''))
  if (!m) return null
  const token = m[1].trim()
  return looksLikeToken(token) ? token : null
}

/**
 * 跑一个子进程拿 stdout。永不 reject、永不抛：
 * 命令不存在 / 超时 / 退出码非 0 一律返回空串，调用方按「没找到」处理。
 */
export function runProcess(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DETECT_TIMEOUT_MS
  const input = options.input || ''
  const extraEnv = options.env && typeof options.env === 'object' ? options.env : {}
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(command, Array.isArray(args) ? args : [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, ...extraEnv },
      })
    } catch {
      return done('')
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
      done('')
    }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); done('') })
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.on('close', () => { clearTimeout(timer); done(stdout) })
    try {
      if (input) child.stdin.write(input)
      child.stdin.end()
    } catch {
      /* 进程可能已经退出 */
    }
  })
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 真正的探测。拆出来是为了测试时可以注入 run / env / home。 */
export async function probeCredential(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const home = options.home || os.homedir()
  const appData = options.appData || env.APPDATA || ''
  const run = typeof options.run === 'function' ? options.run : runProcess
  const tried = []
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  const hit = (token, source, detail) => ({ token, source, detail, tried, ms: elapsed() })

  // 1. 环境变量：最便宜，用户自己设的，优先级最高。
  tried.push('env')
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN']) {
    const value = String(env[name] == null ? '' : env[name]).trim()
    if (looksLikeToken(value)) return hit(value, 'env', name)
  }

  // 2. gh CLI：登录过就直接有。
  tried.push('gh-cli')
  const ghToken = String(await run('gh', ['auth', 'token'], { timeoutMs: DETECT_TIMEOUT_MS })).trim()
  if (looksLikeToken(ghToken)) return hit(ghToken, 'gh-cli', 'gh auth token')

  // 3. gh 的配置文件：gh 不在 PATH 里、但确实登录过。
  tried.push('gh-hosts')
  const hostFiles = [
    path.join(appData, 'GitHub CLI', 'hosts.yml'),
    path.join(home, '.config', 'gh', 'hosts.yml'),
    path.join(home, 'AppData', 'Roaming', 'GitHub CLI', 'hosts.yml'),
  ]
  for (const file of hostFiles) {
    const token = parseGhHosts(readText(file))
    if (token) return hit(token, 'gh-hosts', file)
  }

  // 4. ~/.git-credentials：老式明文存储，还在用的人不少。
  tried.push('git-credentials')
  const credFile = path.join(home, '.git-credentials')
  const plain = parseGitCredentials(readText(credFile))
  if (plain) return hit(plain.token, 'git-credentials', credFile)

  // 5. 系统凭据管理器：git 会去问 GCM / wincred / macOS Keychain。
  //    GCM_INTERACTIVE=never 是关键 —— 否则没凭据时会弹登录窗、卡住不返回。
  tried.push('credential-manager')
  const filled = await run('git', ['credential', 'fill'], {
    timeoutMs: DETECT_TIMEOUT_MS,
    input: 'protocol=https\nhost=github.com\n\n',
    env: { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  })
  const fromStore = parseCredentialFill(String(filled))
  if (fromStore) return hit(fromStore, 'credential-manager', 'git credential fill')

  return { token: '', source: '', detail: '', tried, ms: elapsed() }
}

let cache = { at: 0, result: null }

/** 带缓存的探测。5 分钟内重复调用只读内存。 */
export async function detectCredential(options = {}) {
  const force = options.force === true
  if (!force && cache.result && Date.now() - cache.at < CACHE_TTL_MS) return cache.result
  let result
  try {
    result = await probeCredential(options)
  } catch (err) {
    result = { token: '', source: '', detail: '', tried: [], ms: 0, error: String((err && err.message) || err) }
  }
  cache = { at: Date.now(), result }
  return result
}
