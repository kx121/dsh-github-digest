/**
 * 路径与版本：插件数据目录、会话工作区里的日报目录、宿主缓存位置。
 *
 * 关键区别：
 *   - 插件自己的数据（配置 / 判重表 / 执行记录 / 历史）写在 ~/.dsh/github-duty，
 *     这些是 host 进程直接写盘，不受会话文件策略约束。
 *   - 日报写在「会话工作区」里的 .github-duty/ 下，因为日报是会话里的 AI 写的，
 *     写到工作区之外每轮都会触发一次 danger-full-access 审核（实测踩得很疼）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDir, toStringSafe } from './util.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 插件包根目录（lib/ 的上一级）。 */
export const PACKAGE_ROOT = path.resolve(HERE, '..')

/** 跨插件共用的 DSH 家目录。测试通过 DSH_HOME 环境变量隔离。 */
export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** 本插件的数据目录。 */
export const PLUGIN_HOME = path.join(DSH_HOME, 'github-duty')

export const CONFIG_FILE = path.join(PLUGIN_HOME, 'config.json')
export const SCHEDULE_STATE_FILE = path.join(PLUGIN_HOME, 'schedule-state.json')
export const APPLY_PROBE_FILE = path.join(PLUGIN_HOME, 'apply-probe.json')
export const PROMPT_FILE = path.join(PACKAGE_ROOT, 'prompts', 'duty.md')

/** 宿主会话投影缓存：设置页的会话列表、按轮成本都从这里读。 */
export const SESSION_PROJCACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')

/** dsh-cost-meter 的账本（没装这个插件时读不到，属正常）。 */
export const COST_LEDGER_FILE = path.join(DSH_HOME, 'storages', 'cost-meter', 'ledger.json')

/** 0.2.x 时代的旧日报目录。只用于面板兼容展示，不再写入。 */
export const LEGACY_REPORT_DIR = path.join(PLUGIN_HOME, 'out')

/** 版本号只认 package.json，别再手抄（历史教训：面板显示 0.1.0，包里已经是 0.2.4）。 */
export const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

/**
 * 解析插件用到的全部路径。
 * workspace 必须是「建会话时用的那个工作区」，日报目录跟着它走。
 */
export function resolvePaths(workspace) {
  ensureDir(PLUGIN_HOME)
  const workspaceRoot = toStringSafe(workspace) || process.cwd()
  return {
    home: PLUGIN_HOME,
    config: CONFIG_FILE,
    seen: path.join(PLUGIN_HOME, 'seen.md'),
    runs: path.join(PLUGIN_HOME, 'runs.md'),
    outDir: path.join(workspaceRoot, '.github-duty'),
    history: path.join(PLUGIN_HOME, 'history.jsonl'),
    pending: path.join(PLUGIN_HOME, 'pending-run.json'),
    candidates: path.join(PLUGIN_HOME, 'pending-candidates.json'),
    watchState: path.join(PLUGIN_HOME, 'watch-state.json'),
    prompt: PROMPT_FILE,
    workspace: workspaceRoot,
  }
}
