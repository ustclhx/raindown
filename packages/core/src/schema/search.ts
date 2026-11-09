import { z } from 'zod'

/**
 * 知识读取的输入上限：CLI、MCP 与中枢 kb 路由（add-worker-credential-isolation D3）共用同一份 schema，
 * 任务绑定会话经中枢读取时与本地读取的校验与错误码一致。
 */
export const KB_QUERY_MAX = 500
export const KB_LIMIT_MAX = 100
export const KB_ID_MAX = 512
export const KB_FILTERS_MAX = 20
export const KB_TYPE_MAX = 64

/** 相对 brain/ 的条目标识：不能是绝对路径，不能含以 `.` 开头的段（含 `.`、`..`）、反斜杠或控制字符。 */
const kbEntryIdParam = z
  .string()
  .min(1)
  .max(KB_ID_MAX)
  .refine(
    (v) =>
      !v.startsWith('/') &&
      !v.endsWith('.md') &&
      ![...v].some((ch) => ch === '\\' || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) &&
      v.split('/').every((seg) => seg !== '' && !seg.startsWith('.')),
    '条目标识应为相对 brain/ 的路径（不含 .md、不能以 / 开头、不能含 . 或 .. 段）',
  )
  .describe('条目标识：相对 brain/ 的路径，不含 .md')

export const kbSearchInput = z.object({
  query: z.string().trim().min(1).max(KB_QUERY_MAX).describe('检索短语'),
  limit: z.number().int().positive().max(KB_LIMIT_MAX).default(20).describe('最多返回的条目数'),
  type: z.string().max(KB_TYPE_MAX).optional().describe('仅检索指定类型'),
  includeJournal: z.boolean().default(true).describe('是否包含工作日志'),
})

export const kbGetInput = z.object({ id: kbEntryIdParam })
/** 空条件与格式错误由 `queryIndex` 返回 `invalid_filter`（本地与中枢一致）。 */
export const kbQueryInput = z.object({
  filters: z
    .array(z.string().max(KB_QUERY_MAX))
    .max(KB_FILTERS_MAX)
    .describe('AND 条件，例如 type=data-source owner=ws/xuanxue-saas'),
})

/** 中枢 kb 读取路由的请求体：与 CLI / MCP 的输入相同。 */
export const kbSearchRequest = kbSearchInput.meta({ title: 'POST /v1/kb/search 请求体' })
export const kbGetRequest = kbGetInput.meta({ title: 'POST /v1/kb/get 请求体' })
export const kbQueryRequest = kbQueryInput.meta({ title: 'POST /v1/kb/query 请求体' })

const entrySummary = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  summary: z.string(),
})
export const kbSearchOutput = z.object({
  results: z.array(entrySummary.extend({ snippet: z.string(), score: z.number() })),
})
export const kbGetOutput = z.object({
  id: z.string(),
  type: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string(),
  file: z.string(),
})
export const kbQueryOutput = z.object({ results: z.array(entrySummary) })

export type SearchInput = z.input<typeof kbSearchInput>
export type SearchOutput = z.infer<typeof kbSearchOutput>
export type GetOutput = z.infer<typeof kbGetOutput>
export type QueryOutput = z.infer<typeof kbQueryOutput>

/** 输入及 data 部分的输出契约，供 CLI 与 MCP 共用。 */
export const searchSchemas = {
  'kb-search.input': kbSearchInput,
  'kb-search.output': kbSearchOutput,
  'kb-get.input': kbGetInput,
  'kb-get.output': kbGetOutput,
  'kb-query.input': kbQueryInput,
  'kb-query.output': kbQueryOutput,
}
