import { WS_REF_RE } from '../schema/common.ts'
import { isResourceType } from '../schema/entries.ts'

/**
 * 知识读取的 workspace 可见范围（add-worker-credential-isolation D3）。
 *
 * 任务绑定的会话经中枢读取知识时，只能看到本任务所属 workspace 与 `ws/global` 的内容：
 * - 条目的归属取自 frontmatter 的 `owner`（资源类）与 `workspace`（产品、手册、决策、项目卡片等）；
 *   两者都没有、且类型不要求 owner 的条目属于 global。只要任一归属不在可见范围内，条目就不可见（取严）。
 *   无法判定的归属一律不可见：资源类型（schema 要求 owner）缺少合法 owner；字段存在但为 null、空串、
 *   空数组；值不是合法的 `ws/<id>`（例如对象、含换行或空白）。
 * - journal 是按天的文件，一个文件里混有多个 workspace 的记录：按记录标题行 `## HH:MM:SS · 操作者 · ws/<id>`
 *   正向选择，只保留未标 workspace 的记录与可见 workspace 的记录。
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
 * 数组只展开一层，与索引的字段展开一致；无法判定的归属记为 `?`（永远不可见）。
 */
export function entryScopes(frontmatter: Record<string, unknown>): string[] {
  const out = new Set<string>()
  // schema 要求 owner 的资源类型，缺少 owner 时无法判定归属。
  if (isResourceType(frontmatter.type) && !('owner' in frontmatter)) out.add(UNKNOWN_SCOPE)
  for (const key of SCOPE_KEYS) {
    if (!(key in frontmatter)) continue
    const value = frontmatter[key]
    const values = Array.isArray(value) ? value : [value]
    if (values.length === 0) out.add(UNKNOWN_SCOPE)
    for (const v of values) {
      out.add(typeof v === 'string' && WS_REF_RE.test(v) ? v : UNKNOWN_SCOPE)
    }
  }
  return [...out].sort()
}

/** 归属列表在可见范围内：每个归属都是绑定的 workspace 或 global。 */
export function scopesVisible(scopes: readonly string[], visibility: KbVisibility): boolean {
  return scopes.every((s) => s === visibility.workspace || s === GLOBAL_WORKSPACE_REF)
}

/** 索引中保存归属列表的编码：排序去重后的 JSON 数组（无歧义，检索与 kb_get 的判定一致）。 */
export const encodeScopes = (scopes: readonly string[]): string =>
  JSON.stringify([...new Set(scopes)].sort())

/**
 * 可见的全部 scope 编码：可见集合 {绑定 workspace, global} 的每个子集（含空集 = global）。
 * 检索与字段查询在 SQL 中用 `scope IN (...)` 过滤。
 */
export function visibleScopeEncodings(visibility: KbVisibility): string[] {
  const set = [...new Set([visibility.workspace, GLOBAL_WORKSPACE_REF])]
  const subsets: string[][] = [[]]
  for (const ws of set) for (const s of [...subsets]) subsets.push([...s, ws])
  return [...new Set(subsets.map(encodeScopes))]
}

/** journal 记录标题行；与 `renderJournalRecord` 的格式严格一致（身份同 `ACTOR_RE`，workspace 同 `WS_REF_RE`）。 */
const JOURNAL_HEADING_RE =
  /^## (\d{2}:\d{2}:\d{2}) · ([A-Za-z0-9._:@-]{1,64})(?: · (ws\/[a-z0-9][a-z0-9-]*))?$/
/** 切段：任何以 `##` 加空白开头的行都开始一个新段（包括不规范的标题行）。 */
const SEGMENT_START_RE = /^##\s/
/** 文件头只承认 `# YYYY-MM-DD` 标题行。 */
const JOURNAL_TITLE_RE = /^# \d{4}-\d{2}-\d{2}$/

/**
 * 只保留可见的 journal 记录（正向选择）：按任何 `^##\s` 行切段，只保留首行严格匹配记录标题、且未标
 * workspace 或标了可见 workspace 的段；格式不规范的段（例如小时一位、多余空格、多余字段）一律丢弃。
 * 文件头（第一段之前）只保留 `# YYYY-MM-DD` 标题行。
 *
 * - 没有任何可见记录时返回空串：调用方据此把整个 journal 视为不可见（kb_get 返回 not_found）。
 * - 全部内容都被保留时返回原文，便于调用方判断是否需要重算摘要片段。
 */
export function filterJournalBody(body: string, visibility: KbVisibility): string {
  const lines = body.split('\n')
  const header: string[] = []
  const segments: string[][] = []
  for (const line of lines) {
    if (SEGMENT_START_RE.test(line)) segments.push([line])
    else if (segments.length > 0) (segments[segments.length - 1] as string[]).push(line)
    else header.push(line)
  }
  let changed = false
  const kept: string[] = []
  for (const seg of segments) {
    const m = JOURNAL_HEADING_RE.exec((seg[0] as string).replace(/\r$/, ''))
    const ws = m?.[3]
    if (m && (ws === undefined || scopesVisible([ws], visibility))) kept.push(seg.join('\n'))
    else changed = true
  }
  if (kept.length === 0) return ''
  const title = header.find((l) => JOURNAL_TITLE_RE.test(l.replace(/\r$/, '')))
  if (header.some((l) => l.trim() !== '' && l !== title)) changed = true
  if (!changed) return body
  return [...(title ? [title, ''] : []), ...kept].join('\n')
}
