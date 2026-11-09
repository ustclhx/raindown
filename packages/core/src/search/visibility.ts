/**
 * 知识读取的 workspace 可见范围（add-worker-credential-isolation D3）。
 *
 * 任务绑定的会话经中枢读取知识时，只能看到本任务所属 workspace 与 `ws/global` 的内容：
 * - 条目的归属取自 frontmatter 的 `owner`（资源类）与 `workspace`（产品、手册、决策、项目卡片等）；
 *   两者都没有的条目属于 global。只要任一归属值不在可见范围内，条目就不可见（取严）。
 *   归属值不是字符串（例如对象，属于不合法的 frontmatter）时无法判定，同样按不可见处理。
 * - journal 是按天的文件，一个文件里混有多个 workspace 的记录：按记录标题行 `## HH:MM:SS · 操作者 · ws/<id>`
 *   过滤，只保留未标 workspace 的记录与可见 workspace 的记录。
 *
 * 不带可见范围（CLI、无绑定与唤醒绑定的 MCP）时行为不变。
 */

/** global workspace 的引用；所有 workspace 都能看到它。 */
export const GLOBAL_WORKSPACE_REF = 'ws/global'

/** 读取方可见的范围：绑定的 workspace（`ws/<id>`）加 global。 */
export interface KbVisibility {
  workspace: string
}

/** 无法判定归属时使用的标记：不是合法的 workspace 引用，永远不可见。 */
const UNKNOWN_SCOPE = '?'

/** 归属字段：资源类用 `owner`，其余类型用 `workspace`。 */
const SCOPE_KEYS = ['owner', 'workspace'] as const

/**
 * 条目的归属 workspace 列表（去重、排序）。空列表表示 global。
 * 数组只展开一层，与索引的字段展开一致；非字符串的值记为无法判定。
 */
export function entryScopes(frontmatter: Record<string, unknown>): string[] {
  const out = new Set<string>()
  for (const key of SCOPE_KEYS) {
    if (!(key in frontmatter)) continue
    const value = frontmatter[key]
    if (value === null || value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) {
      out.add(typeof v === 'string' ? v.trim() : UNKNOWN_SCOPE)
    }
  }
  return [...out].sort()
}

/** 归属列表在可见范围内：每个归属都是绑定的 workspace 或 global。 */
export function scopesVisible(scopes: readonly string[], visibility: KbVisibility): boolean {
  return scopes.every((s) => s === visibility.workspace || s === GLOBAL_WORKSPACE_REF)
}

/** 索引中保存归属列表的编码（换行分隔；workspace 引用不含换行）。 */
export const encodeScopes = (scopes: readonly string[]): string => scopes.join('\n')
export const decodeScopes = (encoded: string): string[] =>
  encoded === '' ? [] : encoded.split('\n')

/** journal 记录标题行；与 `renderJournalRecord` 的格式一致。 */
const JOURNAL_HEADING_RE = /^## (\d{2}:\d{2}:\d{2}) · ([^\r\n]+)$/gm

/**
 * 只保留可见的 journal 记录：未标 workspace 的记录与可见 workspace 的记录；文件头（第一条记录之前的
 * 内容）原样保留。标题行字段数不符合格式（例如三段以上）的记录无法判定归属，按不可见处理。
 * 没有记录被去掉时返回原文（便于调用方判断是否需要重算摘要片段）。
 */
export function filterJournalBody(body: string, visibility: KbVisibility): string {
  const headings = [...body.matchAll(JOURNAL_HEADING_RE)]
  if (headings.length === 0) return body
  let out = body.slice(0, headings[0]?.index ?? 0)
  let removed = false
  headings.forEach((h, i) => {
    const end = headings[i + 1]?.index ?? body.length
    const fields = (h[2] ?? '').split(' · ')
    const visible =
      fields.length === 1 ||
      (fields.length === 2 && scopesVisible([fields[1] as string], visibility))
    if (visible) out += body.slice(h.index, end)
    else removed = true
  })
  return removed ? out : body
}
