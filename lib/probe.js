/**
 * apply 探针：把插件加载到哪一步写进 ~/.dsh/github-duty/apply-probe.json。
 *
 * apply 里任何异常都不许外抛（Host 的 apply 抛错 = entry failed，整个插件起不来），
 * 所以失败路径也靠这个文件留证据。写探针本身失败不影响功能。
 */
import { writeJsonAtomic, localStamp } from './util.js'
import { APPLY_PROBE_FILE, VERSION } from './paths.js'
import { createUserMessageSource } from './llm.js'

export function writeApplyProbe(extra = {}) {
  try {
    writeJsonAtomic(APPLY_PROBE_FILE, {
      at: localStamp(),
      version: VERSION,
      node: process.versions.node,
      createUserMessage: createUserMessageSource(),
      ...extra,
    })
  } catch {
    /* 探针文件不影响功能 */
  }
}
