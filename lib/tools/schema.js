/**
 * 工具定义的小工具：参数 schema、输出 schema、统一异常/清洗包装。
 */
import { wellFormedDeep } from '../util.js'

export const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

/** { repo: { type:'string', required:true, description } } → JSON Schema。 */
export function buildParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(spec || {})) {
    properties[key] = { type: field.type, description: field.description }
    if (field.required) required.push(key)
  }
  const out = { type: 'object', properties }
  if (required.length) out.required = required
  return out
}

/** 把 GitHub 客户端的 error 对象转成统一的工具失败结构。 */
export function githubError(error, extra = {}) {
  const value = error && typeof error === 'object' ? error : {}
  return {
    ok: false,
    code: value.code || 'GITHUB_ERROR',
    message: value.message || 'GitHub 请求失败',
    ...(value.hint ? { hint: value.hint } : {}),
    ...(value.status ? { status: value.status } : {}),
    ...extra,
  }
}

/**
 * 包装一个工具定义：
 *   - 调用前刷新凭据（命中缓存，不产生 I/O）；
 *   - 执行结果递归清洗（NaN / 孤立代理项都会让宿主拒收）；
 *   - 未捕获异常兜底成结构化失败，不让模型看到裸异常。
 */
export function defineTool(runtime, spec) {
  const inner = typeof spec.execute === 'function' ? spec.execute : null
  if (!inner) return spec
  return {
    ...spec,
    execute: async (...args) => {
      await runtime.refreshCredential(runtime.reloadConfig())
      try {
        return wellFormedDeep(await inner(...args))
      } catch (err) {
        runtime.log('warn', '工具 ' + spec.name + ' 执行失败：' + String((err && err.message) || err))
        return { ok: false, code: 'TOOL_FAILED', message: String((err && err.message) || err) }
      }
    },
  }
}
