/**
 * owner/repo 引用解析。
 * 只放行 GitHub 合法字符，顺带挡掉路径注入；大小写原样保留（GitHub 仓库名不区分大小写，
 * 但显示与判重都沿用用户输入的写法，只在比较时 toLowerCase）。
 */
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/

export function isValidOwner(value) {
  return typeof value === 'string' && NAME_RE.test(value) && value !== '.' && value !== '..'
}

/** "owner/repo" → { owner, repo, fullName }；非法返回 null。 */
export function parseRepoRef(value) {
  const text = String(value == null ? '' : value).trim()
  const m = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(text)
  if (!m) return null
  if (!isValidOwner(m[1]) || !isValidOwner(m[2])) return null
  return { owner: m[1], repo: m[2], fullName: m[1] + '/' + m[2] }
}
