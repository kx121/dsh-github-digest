/**
 * github-duty —— 插件入口。
 *
 * 架构分四层：
 *   调度层（runner.js）：定时器 / 手动触发 → 把一轮值班投进会话；
 *   通道层（github.js + credential.js）：GitHub 只读接口与本机凭据探测；
 *   判断层（被唤醒会话里的 AI）：插件不调 LLM，只投工具和准则（prompts/duty.md）；
 *   记录层（store.js / cost.js / panel-data.js）：判重表、执行记录、日报、成本。
 *
 * ⚠️ apply 里任何异常都不许外抛：Host 的 apply 抛错 = entry failed，整个插件起不来。
 */
import { createRuntime } from './runtime.js'
import { createRunner } from './runner.js'
import { registerTools } from './tools/index.js'
import { registerRoutes } from './routes.js'
import { writeApplyProbe } from './probe.js'
import * as configModule from './config.js'
import * as scheduleModule from './schedule.js'
import * as storeModule from './store.js'
import * as costModule from './cost.js'
import * as pathsModule from './paths.js'
import * as discoveryModule from './discovery.js'
import * as utilModule from './util.js'
import * as githubModule from './github.js'
import * as repoRefModule from './repo-ref.js'
import * as credentialModule from './credential.js'
import * as sessionsModule from './sessions.js'
import * as wakeModule from './wake-message.js'
import * as panelModule from './panel-data.js'
import * as routesModule from './routes.js'
import * as trendingModule from './trending.js'
import * as toolsModule from './tools/index.js'

export const name = 'github-duty'
export const inject = ['timer', 'tools']

export function apply(ctx, rowConfig = {}) {
  let runtime = null
  try {
    runtime = createRuntime(ctx, rowConfig)
    writeApplyProbe({ phase: 'apply-start' })
    registerTools(runtime)
    const runner = createRunner(runtime)
    registerRoutes(runtime, runner)
    runner.startTimer()
    writeApplyProbe({ phase: 'apply-ok' })
  } catch (err) {
    writeApplyProbe({ phase: 'apply-failed', error: String((err && err.stack) || err) })
  }
}

/** 离线测试入口：把不需要宿主 ctx 的部分都暴露出来。 */
export const __test__ = {
  // 配置
  DEFAULT_CONFIG: configModule.DEFAULT_CONFIG,
  normalizeConfig: configModule.normalizeConfig,
  normalizeWorkspace: configModule.normalizeWorkspace,
  publicConfig: configModule.publicConfig,
  loadEffectiveConfig: configModule.loadEffectiveConfig,
  saveStoredConfig: configModule.saveStoredConfig,
  // 路径 / 版本
  resolvePaths: pathsModule.resolvePaths,
  PACKAGE_ROOT: pathsModule.PACKAGE_ROOT,
  // 调度
  scheduleDue: scheduleModule.scheduleDue,
  parseMinutes: scheduleModule.parseMinutes,
  readScheduleState: scheduleModule.readScheduleState,
  writeScheduleState: scheduleModule.writeScheduleState,
  // 记录
  RUN_COLUMNS: storeModule.RUN_COLUMNS,
  SEEN_COLUMNS: storeModule.SEEN_COLUMNS,
  readTable: storeModule.readTable,
  appendRow: storeModule.appendRow,
  readSeen: storeModule.readSeen,
  readRuns: storeModule.readRuns,
  readHistory: storeModule.readHistory,
  appendHistory: storeModule.appendHistory,
  trimHistory: storeModule.trimHistory,
  HISTORY_KEEP: storeModule.HISTORY_KEEP,
  readWatchState: storeModule.readWatchState,
  writeWatchState: storeModule.writeWatchState,
  readPending: storeModule.readPending,
  writePending: storeModule.writePending,
  cacheRepoData: storeModule.cacheRepoData,
  readCachedRepoData: storeModule.readCachedRepoData,
  recordRepoVolume: storeModule.recordRepoVolume,
  summarizeRepoVolume: storeModule.summarizeRepoVolume,
  readPendingCandidates: storeModule.readPendingCandidates,
  addPendingCandidates: storeModule.addPendingCandidates,
  clearPendingCandidates: storeModule.clearPendingCandidates,
  CANDIDATE_TTL_MS: storeModule.CANDIDATE_TTL_MS,
  // 成本
  readCostMeter: costModule.readCostMeter,
  readSessionCostTotals: costModule.readSessionCostTotals,
  costRate: costModule.costRate,
  computeRoundCost: costModule.computeRoundCost,
  // 发现
  topicSlug: discoveryModule.topicSlug,
  containsTerm: discoveryModule.containsTerm,
  matchTopicHits: discoveryModule.matchTopicHits,
  filterUnseen: discoveryModule.filterUnseen,
  // 工具函数
  escapeCell: utilModule.escapeCell,
  methodNames: utilModule.methodNames,
  formatCompactNumber: utilModule.formatCompactNumber,
  wellFormedDeep: utilModule.wellFormedDeep,
  // GitHub / 凭据
  parseRepoRef: repoRefModule.parseRepoRef,
  classifyError: githubModule.classifyError,
  createGithubClient: githubModule.createGithubClient,
  maskToken: credentialModule.maskToken,
  looksLikeToken: credentialModule.looksLikeToken,
  parseGitCredentials: credentialModule.parseGitCredentials,
  parseGhHosts: credentialModule.parseGhHosts,
  parseCredentialFill: credentialModule.parseCredentialFill,
  probeCredential: credentialModule.probeCredential,
  // 会话 / 唤醒 / 面板 / 路由
  readSessionIndex: sessionsModule.readSessionIndex,
  createSessionOps: sessionsModule.createSessionOps,
  buildWakeMessage: wakeModule.buildWakeMessage,
  readPromptText: wakeModule.readPromptText,
  buildPanel: panelModule.buildPanel,
  searchHistory: panelModule.searchHistory,
  splitQuery: panelModule.splitQuery,
  // 榜单
  buildTrendingQuery: trendingModule.buildTrendingQuery,
  normalizeWindow: trendingModule.normalizeWindow,
  fetchTrending: trendingModule.fetchTrending,
  shapeTrendingItem: trendingModule.shapeTrendingItem,
  clearTrendingCache: trendingModule.clearTrendingCache,
  TRENDING_WINDOWS: trendingModule.TRENDING_WINDOWS,
  buildStatus: panelModule.buildStatus,
  listReports: panelModule.listReports,
  createRouteTable: routesModule.createRouteTable,
  createToolDefinitions: toolsModule.createToolDefinitions,
  applyConfigPost: routesModule.applyConfigPost,
  requestRejection: routesModule.requestRejection,
  readBody: routesModule.readBody,
  // 组装
  createRuntime,
  createRunner,
}
