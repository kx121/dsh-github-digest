/**
 * 工具注册入口。工具用到的共享状态全在 runtime 里，这里只负责组装与注册。
 */
import { createInfoTool } from './info.js'
import { createWatchTool } from './watch.js'
import { createBriefTool } from './brief.js'
import { createDiscoverTool } from './discover.js'
import { createSeenAddTool, createSeenQueryTool } from './seen.js'
import { createRunAddTool } from './runs.js'

/** 七个工具的定义；顺序与 README / 准则一致。 */
export function createToolDefinitions(runtime) {
  return [
    createInfoTool(runtime),
    createBriefTool(runtime),
    createWatchTool(runtime),
    createDiscoverTool(runtime),
    createSeenQueryTool(runtime),
    createSeenAddTool(runtime),
    createRunAddTool(runtime),
  ]
}

/** 注册到宿主 tools 服务。注册失败只影响该工具，不抛。 */
export function registerTools(runtime) {
  const tools = typeof runtime.ctx.get === 'function' ? runtime.ctx.get('tools') : undefined
  if (!tools || typeof tools.register !== 'function') {
    runtime.probe({ phase: 'tools-missing' })
    return []
  }
  const disposers = []
  for (const definition of createToolDefinitions(runtime)) {
    try {
      const dispose = tools.register(definition)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (err) {
      runtime.probe({ phase: 'register-failed', tool: definition.name, error: String((err && err.message) || err) })
    }
  }
  return disposers
}
