import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { z } from 'zod'
import { raindownPaths } from '../home.ts'
import { BLOCKED_REASONS } from '../ledger/task.ts'
import { fail, ok, type Result } from '../result.ts'
import { workspaceRef } from '../schema/common.ts'
import { formatZodIssues, type ValidationIssue } from '../validation-issue.ts'
import {
  INBOX_BODY_MAX,
  INBOX_LEVELS,
  type InboxLevel,
  type InboxSource,
  inboxSource,
} from './schema.ts'

/**
 * `config/inbox.yaml`（inbox spec "默认分级"：用户可以覆盖默认级别）。
 *
 * ```yaml
 * levels:
 *   - reason: no_progress          # 所有 workspace 的无进展卡住只进每日摘要
 *     level: digest
 *   - source: task
 *     workspace: ws/product-res
 *     reason: question
 *     level: decide
 * ```
 *
 * 匹配：规则中写出的条件（source、workspace、reason）都要满足；多条命中时，条件更多的规则优先，
 * 条件数相同时文件中靠后的规则优先（后写的覆盖先写的）。都不命中时用默认级别（`defaultInboxLevel`）。
 * 单条规则写错只排除该条，并报告错误，其他规则照常生效。
 *
 * 推送节奏（inbox spec "推送节奏"，3.3；时间都按中枢所在系统的本地时区）：
 *
 * ```yaml
 * quiet_hours: { start: "23:00", end: "08:00" }   # 写 false 关闭静默时段
 * decide: { times: ["09:00", "18:00"], threshold: 5 }
 * digest: { time: "08:30" }
 * snippet_max_chars: 1500                          # 外发的终端片段最多保留末尾多少字符，0 表示不发
 * ```
 *
 * 节奏字段写错时该字段取默认值并报告错误，不影响分级规则。
 */

/** 级别写法不区分首字母大小写：spec 中写作 Interrupt / Decide / Digest。 */
const levelInput = z
  .enum([...INBOX_LEVELS, 'Interrupt', 'Decide', 'Digest'])
  .meta({ description: '级别：interrupt、decide 或 digest（首字母大小写均可）' })

export const inboxLevelRuleSchema = z
  .strictObject({
    source: inboxSource.optional().meta({ description: '只匹配该来源；缺省匹配所有来源' }),
    workspace: z
      .union([z.literal('*'), workspaceRef])
      .optional()
      .meta({ description: '只匹配该 workspace（ws/<id>）；缺省或 * 匹配所有' }),
    reason: z
      .enum([...BLOCKED_REASONS, 'user', 'supervisor'])
      .optional()
      .meta({ description: '只匹配该卡住原因或重试发起者（user、supervisor）；缺省匹配所有原因' }),
    level: levelInput,
  })
  .superRefine((rule, ctx) => {
    if (rule.source === undefined || rule.reason === undefined) return
    const retryReason = rule.reason === 'user' || rule.reason === 'supervisor'
    if (rule.source === 'task' && !retryReason) return
    if (rule.source === 'task_retry' && retryReason) return
    ctx.addIssue({
      code: 'custom',
      path: ['reason'],
      message:
        rule.source === 'task'
          ? 'task 的 reason 必须是卡住原因'
          : rule.source === 'task_retry'
            ? 'task_retry 的 reason 必须是 user 或 supervisor'
            : `${rule.source} 不支持 reason 条件`,
    })
  })
  .meta({ title: 'Inbox level rule', description: '一条分级覆盖规则' })

/** 本地时间 `HH:MM`（24 小时制）。 */
const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间应写成 HH:MM，例如 08:30')
  .meta({ description: '本地时间 HH:MM（24 小时制）' })

const quietHoursSchema = z
  .union([z.strictObject({ start: clockTime, end: clockTime }), z.literal(false)])
  .meta({ description: '静默时段（默认 23:00–08:00）；Interrupt 顺延到时段结束；false 关闭' })

const decideSchema = z
  .strictObject({
    times: z
      .array(clockTime)
      .max(24)
      .optional()
      .meta({ description: 'Decide 条目合并推送的时间点，默认 09:00 与 18:00' }),
    threshold: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .meta({ description: '尚未推送的 Decide 条目达到这个数量时提前推送，默认 5' }),
  })
  .meta({ description: 'Decide 条目的合并推送' })

const digestSchema = z
  .strictObject({
    time: clockTime.optional().meta({ description: '每日摘要的推送时间，默认 08:30' }),
  })
  .meta({ description: '每日摘要' })

const snippetMaxSchema = z
  .number()
  .int()
  .min(0)
  .max(INBOX_BODY_MAX)
  .meta({ description: '外发的终端输出片段保留末尾的字符数，默认 1500；0 表示不发送片段' })

export const inboxConfigSchema = z
  .strictObject({
    levels: z
      .array(inboxLevelRuleSchema)
      .default([])
      .meta({ description: '分级覆盖规则，按条件多少与先后决定优先级' }),
    quiet_hours: quietHoursSchema.optional(),
    decide: decideSchema.optional(),
    digest: digestSchema.optional(),
    snippet_max_chars: snippetMaxSchema.optional(),
  })
  .meta({ title: 'Raindown inbox config', description: 'config/inbox.yaml：收件箱配置' })

export interface InboxLevelRule {
  /** `levels` 数组中的原始索引，从 0 开始。 */
  rule_index: number
  source?: InboxSource
  workspace?: string
  reason?: string
  level: InboxLevel
}

/** 推送节奏（解析后、已填默认值）。 */
export interface InboxCadence {
  /** 静默时段；null 表示不设。start 晚于 end 时跨越午夜。 */
  quiet: { start: string; end: string } | null
  decide_times: string[]
  decide_threshold: number
  digest_time: string
  snippet_max_chars: number
}

export const DEFAULT_INBOX_CADENCE: Readonly<InboxCadence> = Object.freeze({
  quiet: { start: '23:00', end: '08:00' },
  decide_times: ['09:00', '18:00'],
  decide_threshold: 5,
  digest_time: '08:30',
  snippet_max_chars: 1500,
})

export interface InboxConfig {
  levels: InboxLevelRule[]
  /** 推送节奏；缺省为 `DEFAULT_INBOX_CADENCE`。 */
  cadence?: InboxCadence
  errors: (ValidationIssue & { rule_index?: number })[]
}

export const EMPTY_INBOX_CONFIG: InboxConfig = { levels: [], errors: [] }

/** 配置中的推送节奏，没有时取默认值。 */
export const inboxCadence = (config: Pick<InboxConfig, 'cadence'>): InboxCadence =>
  config.cadence ?? { ...DEFAULT_INBOX_CADENCE }

const FILE = 'config/inbox.yaml'

function issuesOf(error: z.ZodError, raw: unknown) {
  // strictObject 的未知键 issue 位于父对象，展开后才能精确报告拼错的字段。
  const issues = error.issues.flatMap<z.core.$ZodIssue>((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({ ...issue, path: [...issue.path, key] }))
      : [issue],
  )
  return formatZodIssues(issues, raw, { file: FILE })
}

/** 解析已读出的配置对象（测试与热加载共用）。文件级错误返回失败，单条规则错误收集到 errors。 */
export function parseInboxConfig(input: unknown): Result<InboxConfig> {
  if (input === null || input === undefined) return ok({ levels: [], errors: [] })
  if (typeof input !== 'object' || Array.isArray(input)) {
    return fail('failure', 'invalid_config', `${FILE} 顶层必须是对象`)
  }
  const obj = input as Record<string, unknown>
  const errors: InboxConfig['errors'] = []
  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push({ file: FILE, field: key, code: 'unknown_field', message: `未知字段 ${key}` })
    }
  }
  const cadence = parseCadence(obj, errors)
  const rawLevels = obj.levels ?? []
  if (!Array.isArray(rawLevels)) {
    return fail('failure', 'invalid_config', `${FILE} 的 levels 必须是规则数组`)
  }
  const levels: InboxLevelRule[] = []
  rawLevels.forEach((raw, rule_index) => {
    const parsed = inboxLevelRuleSchema.safeParse(raw)
    if (!parsed.success) {
      errors.push(
        ...issuesOf(parsed.error, raw).map((issue) => ({
          ...issue,
          field: `levels.${rule_index}${issue.field ? `.${issue.field}` : ''}`,
          rule_index,
          message: `第 ${rule_index + 1} 条分级规则：${issue.message}`,
        })),
      )
      return
    }
    const r = parsed.data
    levels.push({
      rule_index,
      ...(r.source ? { source: r.source } : {}),
      ...(r.workspace && r.workspace !== '*' ? { workspace: r.workspace } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      level: r.level.toLowerCase() as InboxLevel,
    })
  })
  return ok({ levels, cadence, errors })
}

const TOP_LEVEL_KEYS = new Set(['levels', 'quiet_hours', 'decide', 'digest', 'snippet_max_chars'])

/** 解析节奏字段：写错的字段取默认值并记录错误。 */
function parseCadence(obj: Record<string, unknown>, errors: InboxConfig['errors']): InboxCadence {
  const out: InboxCadence = {
    ...DEFAULT_INBOX_CADENCE,
    decide_times: [...DEFAULT_INBOX_CADENCE.decide_times],
  }
  const field = <T>(key: string, schema: z.ZodType<T>, use: (v: T) => void) => {
    if (obj[key] === undefined || obj[key] === null) return
    const parsed = schema.safeParse(obj[key])
    if (parsed.success) {
      use(parsed.data)
      return
    }
    errors.push(
      ...issuesOf(parsed.error, obj[key]).map((issue) => ({
        ...issue,
        field: `${key}${issue.field ? `.${issue.field}` : ''}`,
        message: `${key}：${issue.message}（使用默认值）`,
      })),
    )
  }
  field('quiet_hours', quietHoursSchema, (v) => {
    out.quiet = v === false || v.start === v.end ? null : v
  })
  field('decide', decideSchema, (v) => {
    if (v.times) out.decide_times = [...new Set(v.times)].sort()
    if (v.threshold !== undefined) out.decide_threshold = v.threshold
  })
  field('digest', digestSchema, (v) => {
    if (v.time) out.digest_time = v.time
  })
  field('snippet_max_chars', snippetMaxSchema, (v) => {
    out.snippet_max_chars = v
  })
  return out
}

/** 读取 `config/inbox.yaml`；文件不存在等同空配置。 */
export async function loadInboxConfig(home: string): Promise<Result<InboxConfig>> {
  let text: string
  try {
    text = await readFile(raindownPaths(home).inboxConfig, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ok({ levels: [], errors: [] })
    return fail('failure', 'read_failed', `无法读取 ${FILE}：${String(err)}`)
  }
  let input: unknown
  try {
    input = parse(text)
  } catch (err) {
    return fail('failure', 'invalid_config', `${FILE} 不是合法的 YAML：${String(err)}`)
  }
  return parseInboxConfig(input)
}

/** 分级的输入：条目来源、所属 workspace、来源内原因（任务的卡住原因或重试发起者）。 */
export interface LevelQuery {
  source: InboxSource
  workspace?: string | null
  reason?: string | null
}

/**
 * 默认级别（inbox spec "默认分级"）：
 * - awaiting_approval、question、crashed、node_lost：Interrupt；
 * - no_progress、other、待确认提案、supervisor 提问、任务提案、合并请求、未能交给任务或 supervisor 的 PR 评论：Decide；
 * - auto-report 策略记录、每日完成情况、决策回看提醒、隔离自检转为不通过、任务结束后重置 mds：Digest。
 * - 任务重试：supervisor 发起为 Interrupt，用户发起为 Digest。
 */
export function defaultInboxLevel(q: LevelQuery): InboxLevel {
  switch (q.source) {
    case 'task_retry':
      return q.reason === 'supervisor' ? 'interrupt' : 'digest'
    case 'reply_delivery':
    case 'out_of_band':
      return 'interrupt'
    case 'task':
      return q.reason === 'no_progress' || q.reason === 'other' ? 'decide' : 'interrupt'
    case 'proposal':
    case 'supervisor':
    case 'task_proposal':
    case 'merge_request':
    case 'pr_comment':
      return 'decide'
    case 'policy':
    case 'digest':
    case 'decision':
    case 'isolation':
      return 'digest'
  }
}

/** 按 `config/inbox.yaml` 的覆盖规则决定级别；不命中任何规则时取默认级别。 */
export function resolveInboxLevel(config: Pick<InboxConfig, 'levels'>, q: LevelQuery): InboxLevel {
  let best: { rule: InboxLevelRule; score: number } | undefined
  for (const rule of config.levels) {
    if (rule.source !== undefined && rule.source !== q.source) continue
    if (rule.workspace !== undefined && rule.workspace !== q.workspace) continue
    if (rule.reason !== undefined && rule.reason !== q.reason) continue
    const score =
      (rule.source === undefined ? 0 : 1) +
      (rule.workspace === undefined ? 0 : 1) +
      (rule.reason === undefined ? 0 : 1)
    // 同分时后面的规则覆盖前面的。
    if (best === undefined || score >= best.score) best = { rule, score }
  }
  return best?.rule.level ?? defaultInboxLevel(q)
}
