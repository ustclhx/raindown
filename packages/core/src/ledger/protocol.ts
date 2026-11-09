import { z } from 'zod'
import { scheduleErrorSchema } from '../daemon/schedule-schema.ts'
import {
  inboxActData,
  inboxActRequest,
  inboxItemView,
  inboxListData,
  inboxListQuery,
  inboxOptions,
} from '../inbox/schema.ts'
import { policyDecisionSchema } from '../policy/decide.ts'
import { policyVersionSchema } from '../policy/version.ts'
import { workspaceRef } from '../schema/common.ts'
import {
  kbGetOutput,
  kbGetRequest,
  kbQueryOutput,
  kbQueryRequest,
  kbSearchOutput,
  kbSearchRequest,
} from '../schema/search.ts'
import { taskAttempt } from './attempts.ts'
import { actor, capability, leaseId, nodeId, taskId, timestamp } from './common.ts'
import {
  decisionPath,
  executorInfo,
  filterUnknownEventTypes,
  isKnownEventType,
  ledgerEvent,
  mergeRequestId,
  REPLY_REASON_MAX,
  readExecutorInfo,
  taskProposalDecision,
  taskProposalId,
} from './events.ts'
import { deliveredInput, lenientInputs } from './pr-input.ts'
import {
  prSubscriptionView,
  unsubscribeTaskData,
  unsubscribeTaskRequest,
} from './pr-subscription.ts'
import { taskRecovery } from './recovery.ts'
import { PROTOCOL_MESSAGE_MAX, TAIL_LINE_MAX } from './redact.ts'
import { taskStageFilter, taskStageSchema } from './stage.ts'
import {
  supervisorReportData,
  supervisorReportQuery,
  supervisorStatusData,
  supervisorStatusQuery,
  supervisorWakeData,
  supervisorWakeRequest,
} from './supervisor-api.ts'
import {
  activity,
  approvalFingerprint,
  blockedReason,
  deliveredReply,
  outOfBandSignal,
  policyDecisionId,
  protocolBlockedDelegationShape,
  prUrl,
  replyId,
  replyKind,
  replyView,
  repoSnapshot,
  taskBranch,
  taskContract,
  taskResult,
  taskResume,
  taskStatus,
  taskView,
  taskWorktree,
  type WakeOrigin,
} from './task.ts'
import { pendingWorkerReport, workerReportData, workerReportRequest } from './worker-report.ts'

/**
 * 中枢 HTTP 协议（hub-daemon、node-protocol spec；design D3、D4）。
 *
 * 约定：
 * - 全部路径以 `/v1` 开头，只监听 127.0.0.1。
 * - 除 `GET /v1/health` 外都需要 `Authorization: Bearer <token>`。操作者由 token 决定（design D9）：
 *   `state/hub.token` 是 user，可用 `X-Raindown-Actor` 降级声明非 user 身份；绑定 token 的身份固定，
 *   请求头与之不一致时返回 403 `actor_mismatch`。
 * - 成功响应：`{ ok: true, data }`；失败响应与 CLI `--json` 一致：
 *   `{ ok: false, error: { kind, code, message, details?, retryable } }`（见 `toJsonDocument`）。
 * - 请求体与响应 `data` 都用这里的 zod 定义校验，并导出到 `schemas/protocol/`。
 */

export const PROTOCOL_VERSION = 'v1'

/**
 * 节点上报的卡住说明与末尾输出的上限（PR #16 复核第 1 条）：超长的请求直接被 zod 拒绝，
 * 不让任意大小的文本进入中枢的同步写事务。节点上报前用 `clipTail` 截断。
 */
const blockedMessage = z.string().min(1).max(PROTOCOL_MESSAGE_MAX)
const blockedTail = z
  .array(z.string().max(TAIL_LINE_MAX))
  .max(200)
  .optional()
  .meta({ description: '末尾输出：最多 200 行，每行最多 2000 字符' })
export const DEFAULT_HUB_PORT = 7477
export const HUB_HOSTNAME = '127.0.0.1'

export const HEADERS = {
  authorization: 'Authorization',
  actor: 'X-Raindown-Actor',
  lastEventId: 'Last-Event-ID',
} as const

/** 协议错误码及其 HTTP 状态与错误类别。各组实现必须使用这里的码，不要另起。 */
export const PROTOCOL_ERRORS = {
  invalid_arguments: { status: 400, kind: 'usage' },
  unauthorized: { status: 401, kind: 'failure' },
  not_found: { status: 404, kind: 'failure' },
  unknown_workspace: { status: 422, kind: 'failure' },
  unknown_role: { status: 422, kind: 'failure' },
  invalid_transition: { status: 409, kind: 'failure' },
  lease_expired: { status: 409, kind: 'failure' },
  lease_active: { status: 409, kind: 'failure' },
  cancel_requested: { status: 409, kind: 'failure' },
  wake_retry_forbidden: { status: 409, kind: 'failure' },
  lease_not_found: { status: 404, kind: 'failure' },
  invalid_lease_token: { status: 403, kind: 'failure' },
  node_not_registered: { status: 409, kind: 'failure' },
  not_running: { status: 409, kind: 'failure' },
  forbidden: { status: 403, kind: 'failure' },
  deliverable_not_found: { status: 422, kind: 'failure' },
  deliverable_check_failed: { status: 502, kind: 'failure' },
  branch_unknown: { status: 409, kind: 'failure' },
  deliverable_branch_mismatch: { status: 409, kind: 'failure' },
  report_busy: { status: 429, kind: 'retryable' },
  report_rate_limited: { status: 429, kind: 'retryable' },
  not_blocked: { status: 409, kind: 'failure' },
  reply_kind_mismatch: { status: 409, kind: 'failure' },
  reply_pending: { status: 409, kind: 'failure' },
  reply_not_found: { status: 404, kind: 'failure' },
  action_not_available: { status: 409, kind: 'failure' },
  item_closed: { status: 409, kind: 'failure' },
  user_only: { status: 403, kind: 'failure' },
  actor_mismatch: { status: 403, kind: 'failure' },
  reserved_actor: { status: 403, kind: 'failure' },
  remote_not_allowed: { status: 403, kind: 'failure' },
  scope_denied: { status: 403, kind: 'failure' },
  role_not_allowed: { status: 403, kind: 'failure' },
  secret_suspected: { status: 400, kind: 'usage' },
  // add-m1-supervisor：任务创建的校验（D2、D4、D5）与唤醒、委托（G1 的账本校验也对外暴露）
  parent_not_found: { status: 422, kind: 'failure' },
  reserved_idempotency_key: { status: 403, kind: 'failure' },
  parent_required: { status: 403, kind: 'failure' },
  proposal_required: { status: 403, kind: 'failure' },
  repo_not_in_workspace: { status: 403, kind: 'failure' },
  verify_not_allowed: { status: 403, kind: 'failure' },
  limit_exceeded: { status: 429, kind: 'failure' },
  review_rounds_exceeded: { status: 429, kind: 'failure' },
  duplicate_wake: { status: 409, kind: 'failure' },
  not_delegable: { status: 409, kind: 'failure' },
  duplicate_delegation: { status: 409, kind: 'failure' },
  not_delegated: { status: 409, kind: 'failure' },
  /** task_respond 的 block_seq 不是任务当前的卡住，或委托已结束、已有待送达的回复（D15）。 */
  stale_block: { status: 409, kind: 'failure' },
  hub_busy: { status: 503, kind: 'retryable' },
  /** base_hash 与当前内容不一致（brief_update）。 */
  conflict: { status: 409, kind: 'failure' },
  brief_too_long: { status: 422, kind: 'failure' },
  /** 绑定了 workspace 的调用方写其他 workspace（design D6）。 */
  workspace_mismatch: { status: 403, kind: 'failure' },
  /** reply 唤醒只能调用 task_respond 与只读操作（design D15）。 */
  reply_only_wake: { status: 403, kind: 'failure' },
  /** 同一 workspace 未回答的提问达到上限（`supervisor.limits.open_questions`，D4、D11）。 */
  too_many_questions: { status: 429, kind: 'failure' },
  /** decision_review 的目标不是本次回看唤醒关联的决策（D11）。 */
  not_review_target: { status: 403, kind: 'failure' },
  /** 该 workspace 不能唤醒 supervisor（未启用、global、没有或有多个 supervisor 角色等，D3）。 */
  supervisor_disabled: { status: 409, kind: 'failure' },
  /** 合并请求的资格核对未通过（D10 第 4 步）：details.reasons 列出原因。 */
  merge_not_eligible: { status: 403, kind: 'failure' },
  /** patrol_report 只限合并了巡检触发（`schedule.fired{payload.kind: supervisor_patrol}`）的唤醒（D13）。 */
  not_patrol_wake: { status: 403, kind: 'failure' },
  /** 本次唤醒已经提交过巡检日报（D13：每次巡检唤醒一份）。 */
  patrol_already_reported: { status: 409, kind: 'failure' },
  /** observe 模式（D10）：autonomous 唤醒的写类动作只记录为 supervisor.observed_action，未执行。 */
  observe_not_executed: { status: 409, kind: 'failure' },
  /** 任务没有该 PR 的有效订阅（harness-neutral 8.1）。 */
  not_subscribed: { status: 409, kind: 'failure' },
  duplicate_subscription: { status: 409, kind: 'failure' },
  /** handback 的 pr_event_seq 不是本任务收到过的名单内人类评论（harness-neutral 8.6）。 */
  handback_invalid: { status: 422, kind: 'failure' },
  internal_error: { status: 500, kind: 'failure' },
} as const satisfies Record<string, { status: number; kind: 'usage' | 'failure' | 'retryable' }>
export type ProtocolErrorCode = keyof typeof PROTOCOL_ERRORS

/** 客户端侧（HubClient）专用：连接被拒绝或超时，不会出现在中枢响应中。 */
export const HUB_UNAVAILABLE = 'hub_unavailable'

export const errorBody = z
  .object({
    ok: z.literal(false),
    error: z.object({
      kind: z.enum(['failure', 'usage', 'retryable']),
      code: z.string().min(1).meta({ description: '稳定的机器可读错误码' }),
      message: z.string(),
      details: z.unknown().optional(),
      retryable: z.boolean(),
    }),
  })
  .meta({ title: 'Raindown API error', description: '失败响应，与 CLI --json 的失败形态一致' })
export type ErrorBody = z.infer<typeof errorBody>

/** 成功响应信封。 */
export const okBody = <T extends z.ZodType>(data: T) => z.object({ ok: z.literal(true), data })

const limit = z.coerce.number().int().min(1).max(500)

// ---------------------------------------------------------------------------
// health / hub
// ---------------------------------------------------------------------------

export const healthData = z
  .object({
    version: z.string(),
    uptime: z.number().min(0).meta({ description: '中枢已运行的秒数' }),
    ledger_seq: z.number().int().min(0).meta({ description: '账本最新序号，空账本为 0' }),
  })
  .meta({ title: 'GET /v1/health' })
export type HealthData = z.infer<typeof healthData>

/** 中枢运行时的密钥解析状态（secret-provider "运行时解析"）：只有个数与缺失的路径，没有值。 */
export const secretsStatus = z.object({
  loaded: z.number().int().min(0).meta({ description: '已解析的密钥个数' }),
  missing: z
    .array(z.object({ path: z.string(), file: z.string() }))
    .meta({ description: '配置中引用了但尚未设置的密钥路径；依赖它们的功能不启动' }),
  error: z.string().nullable().meta({ description: '最近一次解密失败的错误码' }),
})
export type SecretsStatusData = z.infer<typeof secretsStatus>

const policyStatusIssue = z.object({
  file: z.string(),
  rule_index: z.number().int().min(0).optional(),
  field: z.string().optional(),
  code: z.string(),
  message: z.string(),
})

export const policiesStatus = z.object({
  version: policyVersionSchema.optional(),
  loaded: z.number().int().min(0),
  errors: z.array(policyStatusIssue),
  warnings: z.array(policyStatusIssue).optional(),
})

/** 推送渠道的状态（notify-channel；add-m1-inbox 4.1）。 */
export const channelStatus = z.object({
  id: z.string(),
  state: z.enum(['running', 'backoff', 'disabled', 'stopped']).meta({
    description:
      'running 正常；backoff 失败后等待重试；disabled 缺少密钥等原因未启动；stopped 正在停止',
  }),
  missing_secrets: z.array(z.string()).meta({ description: '该渠道缺少的密钥路径' }),
  failures: z.number().int().min(0).meta({ description: '连续失败次数' }),
  next_retry_at: timestamp.nullable(),
  last_error: z.string().nullable().meta({ description: '最近一次失败的说明（已脱敏）' }),
  failed_items: z
    .number()
    .int()
    .min(0)
    .default(0)
    .meta({ description: '记为推送失败（放弃推送或同步）的条目数' }),
  ignored_inbound: z
    .number()
    .int()
    .min(0)
    .default(0)
    .meta({ description: '被忽略的入站消息与按钮数（例如陌生 chat 发来的），自中枢启动起计' }),
  warning: z.string().nullable().default(null).meta({
    description: '需要用户注意的情况，例如"可能有人在使用同一个 bot token"',
  }),
  last_rebound_at: timestamp
    .nullable()
    .default(null)
    .meta({ description: '最近一次改绑（channel.rebound）的时间' }),
})
export type ChannelStatusData = z.infer<typeof channelStatus>

export const hubStatusData = healthData
  .extend({
    pid: z.number().int().positive(),
    started_at: timestamp,
    runtime: z.enum(['bun', 'node']),
    schedules: z.object({
      loaded: z.number().int().min(0),
      errors: z.array(scheduleErrorSchema),
    }),
    schedule_errors: z.array(scheduleErrorSchema).default([]),
    last_backup: z.object({ path: z.string(), at: timestamp }).nullable(),
    secrets: secretsStatus.default({ loaded: 0, missing: [], error: null }),
    policies: policiesStatus.default({ loaded: 0, errors: [] }),
    channels: z.array(channelStatus).default([]).meta({ description: '推送渠道的状态' }),
    pr_watch: z
      .object({
        watched: z.number().int().min(0).meta({ description: '正在轮询的 PR 数' }),
        errors: z
          .array(
            z.object({
              workspace: workspaceRef,
              pr: prUrl,
              failures: z.number().int().min(1),
              message: z.string(),
              since: timestamp,
            }),
          )
          .meta({ description: '连续 3 次及以上查询失败的 PR（系统问题）' }),
        identity: z
          .object({ ok: z.boolean(), login: z.string().nullable(), message: z.string().optional() })
          .nullable()
          .default(null)
          .meta({ description: '中枢 gh 登录；查询失败（ok=false）时按共享身份处理' }),
        shared: z
          .array(z.object({ workspace: workspaceRef, reason: z.string() }))
          .default([])
          .meta({
            description:
              '共享身份：中枢 gh 登录在允许名单中或无法确认，PR 评论只作上下文；附原因与解除方法',
          }),
        warnings: z.array(z.string()).default([]),
      })
      .default({ watched: 0, errors: [], identity: null, shared: [], warnings: [] })
      .meta({ description: 'PR 订阅采集（harness-neutral D11）的状态' }),
  })
  .meta({ title: 'GET /v1/hub/status' })
export type HubStatusData = z.infer<typeof hubStatusData>

// ---------------------------------------------------------------------------
// hub tokens（design D9：按 token 绑定操作者身份）
// ---------------------------------------------------------------------------

/**
 * 保留身份（比较时不区分大小写）：`user` 只属于 `state/hub.token`；`hub`、`scheduler`、`policy`
 * 是中枢内部写事件用的身份，`unknown` 是历史上缺省的占位。`node:*` 只由中枢在节点注册流程中设置，
 * 或由签发给 `node:<id>` 的绑定 token 使用。
 */
export const RESERVED_ACTORS = ['user', 'hub', 'scheduler', 'policy', 'unknown'] as const

/** 名字（不区分大小写）属于保留身份。 */
export const isReservedName = (a: string) =>
  (RESERVED_ACTORS as readonly string[]).includes(a.toLowerCase())
/** 身份（不区分大小写）以 `node:` 开头。 */
export const isNodeActor = (a: string) => a.toLowerCase().startsWith('node:')

/**
 * user token 用 `X-Raindown-Actor` 降级时可以声明的身份：除精确的 `user` 外，
 * 不能是保留身份或其大小写变体，也不能是 `node:*`。
 */
export const isDeclarableActor = (a: string) =>
  a === 'user' || (!isReservedName(a) && !isNodeActor(a))

/**
 * 只由中枢按租约签发唤醒绑定 token 认定的身份（add-m1-supervisor D6）：`supervisor`（不区分大小写）。
 * 它仍是合法的角色名与 `raindown mcp --actor`（本机第一道防线不变），但在中枢 HTTP 鉴权中
 * user token 不能用 `X-Raindown-Actor` 降级声明它，也不能签发为绑定 token。
 */
export const HUB_ISSUED_ACTORS = ['supervisor'] as const
export const isHubIssuedActor = (a: string) =>
  (HUB_ISSUED_ACTORS as readonly string[]).includes(a.toLowerCase())

/** 中枢 HTTP 上 user token 可以用 `X-Raindown-Actor` 声明的身份：可声明、且不是中枢签发的身份。 */
export const isHttpDeclarableActor = (a: string) => isDeclarableActor(a) && !isHubIssuedActor(a)

export const hubTokenId = z
  .string()
  .regex(/^tok_[0-9a-f]{12}$/, 'token id 格式为 tok_ 加 12 位十六进制')
  .meta({ description: '绑定 token 的 id（不是 token 本身）' })

const NODE_ACTOR_RE = /^node:[A-Za-z0-9][A-Za-z0-9._-]{0,57}$/

/** 绑定 token 的身份：不能是保留身份（不区分大小写）；`node:` 前缀必须是小写且后接合法节点 id。 */
export const boundActor = actor
  .refine((a) => !isReservedName(a), {
    message: `绑定 token 的身份不能是 ${RESERVED_ACTORS.join('、')}（不区分大小写）`,
  })
  .refine((a) => !isHubIssuedActor(a), {
    message: `${HUB_ISSUED_ACTORS.join('、')} 只由中枢按唤醒租约签发，不能签发为绑定 token`,
  })
  .refine((a) => !isNodeActor(a) || NODE_ACTOR_RE.test(a), {
    message: '节点身份应为 node:<节点 id>（小写 node:）',
  })

/** token 记录的公开视图：不含摘要。 */
export const hubTokenView = z
  .object({
    id: hubTokenId,
    actor,
    issued_at: timestamp,
    note: z.string().optional(),
    last_used_at: timestamp.nullable(),
    revoked_at: timestamp.nullable(),
    remote: z
      .boolean()
      .optional()
      .meta({ description: '供远程调用方使用（变更 ⑤ 的远程入口）；本变更只做标注' }),
  })
  .meta({ title: 'Hub token' })
export type HubTokenView = z.infer<typeof hubTokenView>

export const issueTokenRequest = z
  .strictObject({
    actor: boundActor,
    note: z.string().max(200).optional(),
    remote: z.boolean().optional(),
  })
  // 目前只签发两类：本机以外的节点（node:<id>），或给变更 ⑤ 远程入口用的 remote token。
  .refine((r) => NODE_ACTOR_RE.test(r.actor) || r.remote === true, {
    message: '目前只能签发 node:<id> 身份的 token，或带 --remote 标注的 token',
    path: ['actor'],
  })
  .meta({ title: 'POST /v1/hub/tokens', description: '签发绑定 token；仅 user' })
export type IssueTokenRequest = z.infer<typeof issueTokenRequest>

export const issueTokenData = z
  .object({
    token: hubTokenView,
    secret: z.string().meta({ description: 'token 明文，只在签发时返回这一次' }),
  })
  .meta({ title: 'POST /v1/hub/tokens 响应' })
export type IssueTokenData = z.infer<typeof issueTokenData>

export const listTokensData = z
  .object({ tokens: z.array(hubTokenView) })
  .meta({ title: 'GET /v1/hub/tokens' })
export type ListTokensData = z.infer<typeof listTokensData>

export const revokeTokenData = z
  .object({ token: hubTokenView })
  .meta({ title: 'POST /v1/hub/tokens/:id/revoke' })
export type RevokeTokenData = z.infer<typeof revokeTokenData>

/**
 * Web 页面的一次性登录码（add-m1-inbox 6.1，design D5）：`raindown ui` 申请后打开
 * `/ui/login?code=...`。登录码只在内存中以摘要保存，60 秒内有效、只能使用一次；仅 user。
 */
export const uiLoginCodeData = z
  .object({
    code: z.string().meta({ description: '一次性登录码明文，只在申请时返回这一次' }),
    login_path: z.string().meta({ description: '登录路径（含登录码），拼在中枢地址之后打开' }),
    expires_at: timestamp,
  })
  .meta({ title: 'POST /v1/ui/login-code 响应' })
export type UiLoginCodeData = z.infer<typeof uiLoginCodeData>

/**
 * Telegram 绑定码（add-m1-inbox 5.1，telegram-channel "绑定用户本人"）：`raindown telegram link` 申请，
 * 用户在 Telegram 中给 bot 发送 `/link <绑定码>`（或打开 `link_url`）。绑定码至少 64 位随机，
 * 只在中枢内存中以摘要保存，10 分钟内有效，只能使用一次；仅 user。
 */
export const telegramLinkCodeRequest = z
  .strictObject({
    rebind: z.boolean().default(false).meta({
      description: '已绑定时必须为 true 才发码（改绑到另一个账号）；改绑成功前会通知原 chat',
    }),
  })
  .meta({ title: 'POST /v1/telegram/link-code' })
export type TelegramLinkCodeRequest = z.input<typeof telegramLinkCodeRequest>

/** `POST /v1/telegram/unlink`：解除 Telegram 绑定（仅 user）。 */
export const telegramUnlinkData = z
  .object({ unlinked: z.boolean().meta({ description: 'false 表示原本就没有绑定' }) })
  .meta({ title: 'POST /v1/telegram/unlink 响应' })
export type TelegramUnlinkData = z.infer<typeof telegramUnlinkData>

export const telegramLinkCodeData = z
  .object({
    code: z.string().meta({ description: '一次性绑定码明文，只在申请时返回这一次' }),
    command: z.string().meta({ description: '要发给 bot 的完整命令，例如 /link <绑定码>' }),
    link_url: z.string().nullable().meta({
      description: 't.me 深链接（打开后点"开始"即发送绑定码）；不知道 bot 用户名时为 null',
    }),
    expires_at: timestamp,
  })
  .meta({ title: 'POST /v1/telegram/link-code 响应' })
export type TelegramLinkCodeData = z.infer<typeof telegramLinkCodeData>

export const rebuildData = z
  .object({
    events_replayed: z.number().int().min(0),
    duration_ms: z.number().int().min(0),
    ledger_seq: z.number().int().min(0),
  })
  .meta({ title: 'POST /v1/hub/rebuild' })
export type RebuildData = z.infer<typeof rebuildData>

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

/** 创建入口要求绝对 cwd；读路径的 taskContract 兼容历史合同。 */
export const createTaskRequest = taskContract
  .safeExtend({
    origin_instruction: z.never().optional(),
    instruction_seq: z.number().int().positive().optional().meta({
      description: '本次唤醒中的用户指令序号；多条原始指令时必填',
    }),
    cwd: z
      .string()
      .regex(/^(?:\/|~\/)/, 'cwd 必须是绝对路径或以 ~/ 开头')
      .optional()
      .meta({ description: '工作目录（节点上的绝对路径，允许 ~/ 开头并由节点展开）' }),
  })
  .meta({ title: 'Raindown task contract', description: '创建任务时提交的合同' })
export type CreateTaskRequest = z.input<typeof createTaskRequest>
export const createTaskData = z
  .object({
    task: taskView,
    created: z.boolean().meta({ description: 'false 表示命中幂等键，返回的是已有任务' }),
  })
  .meta({ title: 'POST /v1/tasks' })
export type CreateTaskData = z.infer<typeof createTaskData>

/** scope 只能来自任务合同，不能由请求方覆盖。超长输入拒绝，不能截断后参与判定。 */
export const policyCheckRequest = z
  .strictObject({
    task_id: taskId,
    tool: z.string().trim().min(1).max(128),
    command: z.string().max(PROTOCOL_MESSAGE_MAX).optional(),
    paths: z.array(z.string().min(1).max(TAIL_LINE_MAX)).max(200).optional(),
    dry_run: z.boolean().optional().meta({
      description: '默认 false；user 可设为 true 只判定不入账，节点传 true 返回 400',
    }),
    push_env_ok: z.boolean().optional().meta({
      description:
        'git push 的推送环境检查（D15）：push 地址与登记仓库一致、没有会执行命令或改写目标的 git 配置、没有启用的 hook；缺失视为不满足',
    }),
    gh_env_ok: z.boolean().optional().meta({
      description: 'gh 命令的仓库检查（D15）：gh 实际解析出的仓库与登记仓库一致；缺失视为不满足',
    }),
    command_cwd: taskWorktree.optional().meta({
      description:
        '命令实际执行目录（D15），节点解析符号链接后上报；push_to / gh_scope 要求它与任务 worktree 相同',
    }),
    lease_token: z.string().min(16).max(512).optional().meta({
      description:
        '持有该任务活动租约的节点证明身份（本机节点用 user token 调用）；push_env_ok、gh_env_ok、command_cwd 只在 node actor 持有租约或令牌匹配时采信。不入账',
    }),
  })
  .meta({ title: 'POST /v1/policy/check' })
export type PolicyCheckRequest = z.infer<typeof policyCheckRequest>
/**
 * 非 strict：以后可以加字段。注意旧节点用 strict 的旧版 schema 解析响应，
 * 因此新字段只能出现在旧节点不会遇到的情况下（`decision_id` 只随 supervisor 档位返回）。
 */
export const policyCheckData = z
  .object({
    ...policyDecisionSchema.shape,
    decision_id: policyDecisionId.optional().meta({
      description:
        '只在判定为 supervisor 档位时返回：本次判定的 id（对应 policy.decided 的 seq），节点上报卡住时带上。其他档位与 dry_run 没有该字段',
    }),
  })
  .meta({ title: 'POST /v1/policy/check 响应' })
export type PolicyCheckData = z.infer<typeof policyCheckData>

export const listTasksQuery = z
  .strictObject({
    workspace: workspaceRef.optional(),
    status: taskStatus.optional(),
    stage: taskStageFilter.optional(),
    parent: taskId.optional(),
    pr: prUrl.optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
    limit: limit.default(50),
  })
  .meta({
    title: 'GET /v1/tasks 查询参数',
    description: '等人的任务优先，同组按创建时间倒序',
  })
export type ListTasksQuery = z.infer<typeof listTasksQuery>

/** 阶段只在读取时附加；可缺省以兼容旧中枢，不进入任务投影。 */
const stagedTaskView = taskView.extend({ stage: taskStageSchema.nullable().optional() })
export const listTasksData = z
  .object({ tasks: z.array(stagedTaskView) })
  .meta({ title: 'GET /v1/tasks' })
export type ListTasksData = z.infer<typeof listTasksData>

export const showTaskData = z
  .object({
    task: stagedTaskView,
    events: z.array(ledgerEvent).meta({ description: '该任务的全部事件' }),
    replies: z.array(replyView).default([]).meta({ description: '该任务收到的全部回复' }),
    attempts: z.array(taskAttempt).default([]).meta({ description: '按开始时间排列的派工列表' }),
    subscriptions: z
      .array(prSubscriptionView)
      .default([])
      .meta({ description: '任务的 PR 订阅（含已结束的）；旧版中枢的响应没有该字段' }),
  })
  .meta({ title: 'GET /v1/tasks/:id' })
export type ShowTaskData = z.infer<typeof showTaskData>

/** CLI 与节点共用的任务详情读侧兼容规则，不放宽已知事件的载荷校验。 */
export const compatibleShowTaskData = showTaskData.extend({
  events: z.preprocess(filterUnknownEventTypes, showTaskData.shape.events),
})

export const showTaskQuery = z.strictObject({
  section: z.enum(['summary', 'events', 'tail', 'attempts', 'replies', 'instruction']).optional(),
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})
export type ShowTaskQuery = z.input<typeof showTaskQuery>

const taskPage = {
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(1000),
  total: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative().optional(),
}
export const taskSectionData = z.object({ task: taskView }).and(
  z.discriminatedUnion('section', [
    z.object({ section: z.literal('summary') }),
    z.object({ ...taskPage, section: z.literal('events'), events: z.array(ledgerEvent) }),
    z.object({ ...taskPage, section: z.literal('tail'), tail: z.string() }),
    z.object({
      ...taskPage,
      section: z.literal('instruction'),
      text: z.string(),
      instruction_seq: z.number().int().positive().optional(),
    }),
    z.object({ ...taskPage, section: z.literal('attempts'), attempts: z.array(taskAttempt) }),
    z.object({ ...taskPage, section: z.literal('replies'), replies: z.array(replyView) }),
  ]),
)
export type TaskSectionData = z.infer<typeof taskSectionData>
export const taskShowResponse = z.union([taskSectionData, showTaskData])
export type TaskShowResponse = z.infer<typeof taskShowResponse>

/** 分页事件沿用完整详情的读侧兼容规则。 */
export const compatibleTaskShowResponse = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null || !('events' in value)) return value
  return { ...value, events: filterUnknownEventTypes(value.events) }
}, taskShowResponse)

export const eventGetQuery = z.strictObject({ seq: z.coerce.number().int().positive() })
/** 未知类型保留原始 JSON；已知类型仍执行对应事件的严格校验。 */
export const readableLedgerEvent = z.union([
  ledgerEvent,
  z.strictObject({
    seq: z.number().int().positive(),
    ts: timestamp,
    type: z
      .string()
      .min(1)
      .refine((type) => !isKnownEventType(type)),
    workspace: workspaceRef.optional(),
    task_id: taskId.optional(),
    actor,
    payload: z.record(z.string(), z.unknown()),
  }),
])
export const eventGetData = z.object({ event: readableLedgerEvent })
export type EventGetData = z.infer<typeof eventGetData>

export const cancelTaskRequest = z
  .strictObject({ reason: z.string().optional() })
  .meta({ title: 'POST /v1/tasks/:id/cancel' })
export type CancelTaskRequest = z.infer<typeof cancelTaskRequest>
export const cancelTaskData = z.object({ task: taskView }).meta({
  title: 'POST /v1/tasks/:id/cancel 响应',
  description: 'queued/blocked 任务立即 cancelled；running/verifying 任务 cancel_requested=true',
})
export type CancelTaskData = z.infer<typeof cancelTaskData>

/** 原任务重试：仅恢复可重试的 blocked 或 failed，不改任务合同与交付物。 */
export const retryTaskRequest = z
  .strictObject({ reason: z.string().trim().min(1).max(PROTOCOL_MESSAGE_MAX).optional() })
  .meta({ title: 'POST /v1/tasks/:id/retry' })
export type RetryTaskRequest = z.infer<typeof retryTaskRequest>
export const retryTaskData = z.object({ task: taskView }).meta({
  title: 'POST /v1/tasks/:id/retry 响应',
  description: '原任务重新排队，下一次派工沿用原任务的工作目录、分支与 PR',
})
export type RetryTaskData = z.infer<typeof retryTaskData>

/**
 * `POST /v1/tasks/:id/reply`（task-interaction spec）：只有 blocked 任务可以回复。
 * - question：只接受文字；awaiting_approval：approve / deny / 文字；其他原因：只接受文字。
 * - 节点仍持有租约时，回复在下一次续约时送达；否则任务带着回复重新排队（D7）。
 */
export const replyTaskRequest = z
  .strictObject({
    kind: replyKind,
    text: z.string().trim().min(1).max(16_384).optional().meta({
      description: '回复文字；kind=deny 时可作为理由，kind=text 时必填',
    }),
  })
  .refine((r) => r.kind !== 'text' || r.text !== undefined, {
    message: '文字回复不能为空',
    path: ['text'],
  })
  .meta({ title: 'POST /v1/tasks/:id/reply' })
export type ReplyTaskRequest = z.infer<typeof replyTaskRequest>
export const replyTaskData = z
  .object({
    task: taskView,
    reply: replyView,
    requeued: z.boolean().meta({ description: 'true：没有节点持有该任务，任务已带着回复重新排队' }),
  })
  .meta({ title: 'POST /v1/tasks/:id/reply 响应' })
export type ReplyTaskData = z.infer<typeof replyTaskData>

// ---------------------------------------------------------------------------
// events（SSE）
// ---------------------------------------------------------------------------

/**
 * `GET /v1/events?after=<seq>`：SSE 流。每条消息 `id` 为 seq、`event` 为事件 type、
 * `data` 为事件信封的 JSON（`ledgerEvent`）。断线重连时用 `after` 或 `Last-Event-ID`。
 */
export const eventsQuery = z
  .strictObject({
    after: z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .meta({ description: '只发送 seq 大于它的事件' }),
    task_id: taskId.optional(),
    workspace: workspaceRef.optional(),
  })
  .meta({ title: 'GET /v1/events 查询参数' })
export type EventsQuery = z.infer<typeof eventsQuery>

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

export const registerNodeRequest = z
  .strictObject({
    node_id: nodeId,
    hostname: z.string().min(1),
    version: z.string().min(1),
    capabilities: z
      .array(capability)
      .meta({ description: '节点能力，含执行器贡献的 executor:<type>' }),
    executors: z.array(executorInfo).default([]),
    concurrency: z.number().int().min(1).default(1),
  })
  .meta({ title: 'POST /v1/nodes' })
export type RegisterNodeRequest = z.infer<typeof registerNodeRequest>

export const nodeView = z
  .object({
    node_id: nodeId,
    hostname: z.string(),
    version: z.string(),
    capabilities: z.array(capability),
    executors: z.array(readExecutorInfo),
    concurrency: z.number().int().min(1),
    registered_at: timestamp,
    last_seen_at: timestamp
      .nullable()
      .meta({ description: '最近一次活动；非事件派生，重建后为 null' }),
    active_leases: z.number().int().min(0),
  })
  .meta({ title: 'Raindown node' })
export type NodeView = z.infer<typeof nodeView>

export const registerNodeData = z.object({ node: nodeView }).meta({ title: 'POST /v1/nodes 响应' })
export const listNodesData = z.object({ nodes: z.array(nodeView) }).meta({ title: 'GET /v1/nodes' })

// ---------------------------------------------------------------------------
// leases
// ---------------------------------------------------------------------------

/** 执行槽类别（add-m1-supervisor D12）。 */
export const LEASE_SLOT_KINDS = ['general', 'supervisor', 'reply'] as const
export type LeaseSlotKind = (typeof LEASE_SLOT_KINDS)[number]

const slotCount = (description: string) =>
  z.number().int().min(0).max(64).default(0).meta({ description })

/**
 * 领取请求携带的空闲执行槽（D12）：普通任务只用 general；普通唤醒（origin 为 instruction /
 * autonomous）可用 supervisor 或 general；reply 唤醒可用 reply 或 general。
 * 唤醒身份以账本 `supervisor.wake_started` 为准。
 */
export const leaseSlots = z
  .strictObject({
    general: slotCount('普通空位数'),
    supervisor: slotCount('只给普通唤醒的空位数'),
    reply: slotCount('只给 reply 唤醒的空位数'),
  })
  .meta({ title: 'Lease slots', description: '本次领取时节点各类别的空闲执行槽数' })
export type LeaseSlots = z.infer<typeof leaseSlots>

/**
 * 某任务在一次领取请求中可以占用的执行槽（纯函数，D12）。`wake` 是该任务
 * `supervisor.wake_started` 的 origin，不是唤醒任务时为 null。
 *
 * - `slots` 缺省时视为只有普通空位、数量不限：旧节点，以及新节点的普通（general）领取循环
 *   都不带 `slots`（新节点因此也能连旧中枢）；任何任务都返回 `general`。
 * - 带 `slots` 时（新节点的 supervisor / reply 循环）：唤醒优先占对应的预留槽，其次普通空位；
 *   普通任务只用普通空位；没有可用空位时返回 null。
 *
 * 唤醒落到普通空位之前，中枢会先把它交给同一节点正在等待的预留槽领取（见 hub 的 tryGrant），
 * 避免唤醒挤占普通槽。
 */
export function leaseSlotFor(
  slots: LeaseSlots | undefined,
  wake: WakeOrigin | null,
): LeaseSlotKind | null {
  if (!slots) return 'general'
  if (wake === 'reply' && slots.reply > 0) return 'reply'
  if ((wake === 'instruction' || wake === 'autonomous') && slots.supervisor > 0) return 'supervisor'
  return slots.general > 0 ? 'general' : null
}

export const acquireLeaseRequest = z
  .strictObject({
    node_id: nodeId,
    capabilities: z.array(capability),
    slots: leaseSlots.optional().meta({
      description: '各类别的空闲执行槽（D12）；不带时视为只有普通空位（旧节点兼容）',
    }),
    wait_s: z
      .number()
      .int()
      .min(0)
      .max(300)
      .default(30)
      .meta({ description: 'long-poll 最长等待秒数；中枢按 lease_wait_max_s 截断' }),
  })
  .meta({ title: 'POST /v1/leases' })
export type AcquireLeaseRequest = z.infer<typeof acquireLeaseRequest>

export const leaseGrant = z
  .object({
    lease_id: leaseId,
    lease_token: z.string().min(16).meta({ description: '租约令牌；续约与提交时必须携带' }),
    task_id: taskId,
    workspace: workspaceRef,
    contract: taskContract,
    attempt: z.number().int().min(1),
    ttl_s: z.number().int().positive(),
    expires_at: timestamp,
    resume: taskResume
      .optional()
      .meta({ description: '任务带着回复重新排队时，本次执行要带上的回复与会话 id' }),
    // 恢复上下文只是提示；较新中枢扩展字段或原因时，旧节点仍须接受租约。
    recovery: taskRecovery.optional().catch(undefined),
    inputs: z
      .preprocess(lenientInputs, z.array(deliveredInput).max(200))
      .optional()
      .catch(undefined)
      .meta({
        description:
          '任务未运行期间到达的输入（PR 直通，harness-neutral 8.4）：适配器放在派工输入开头；旧节点忽略',
      }),
    dispatch_token: z
      .string()
      .min(16)
      .optional()
      .meta({ description: '当前派工的 worker 受限身份凭证；与节点 lease_token 分离' }),
    wake_token: z.string().min(16).optional().meta({
      description:
        '唤醒绑定 token（add-m1-supervisor D6）：只在领到 supervisor 唤醒任务时下发，身份为 supervisor，绑定 workspace 与该唤醒，租约结束或任务结束即失效；旧节点忽略',
    }),
    repo_snapshot: repoSnapshot.optional().meta({
      description:
        '中枢投影中固定的登记仓库快照（D15，任务首次上报分支时采集）；有它时节点不再重新采集；旧节点忽略',
    }),
  })
  .meta({ title: 'Lease grant' })
export type LeaseGrant = z.infer<typeof leaseGrant>

export const acquireLeaseData = z
  .object({ lease: leaseGrant.nullable().meta({ description: '等待结束仍无可领取任务时为 null' }) })
  .meta({ title: 'POST /v1/leases 响应' })
export type AcquireLeaseData = z.infer<typeof acquireLeaseData>

export const renewLeaseRequest = z
  .strictObject({
    lease_token: z.string().min(16),
    dispatch_token_sha256: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional()
      .meta({
        description:
          '节点当前派工凭证的 SHA-256 前 16 位；不匹配、或中枢没有当前凭证时重新下发；缺失且中枢已有当前凭证时不轮换',
      }),
    report_conflict: z
      .strictObject({
        report_seq: z.number().int().positive(),
        observed: z.enum(['idle', 'busy', 'no_progress']),
      })
      .optional()
      .meta({ description: '上报与观察矛盾；须与同批 report_seq 相同' }),
    activity: z.array(activity).max(500).default([]).meta({ description: '自上次续约以来的活动' }),
    report_seq: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({ description: '确认已消费本派工的上报，确认后续约不再下发' }),
    phase: z
      .literal('verifying')
      .optional()
      .meta({ description: '开始执行验收命令时带上，中枢写入 task.verifying' }),
    blocked: z
      .strictObject({
        request_id: z.string().min(1).max(512).optional(),
        approval_fingerprint: approvalFingerprint.optional(),
        reason: blockedReason,
        message: blockedMessage,
        tail: blockedTail,
        session: z
          .string()
          .min(1)
          .max(512)
          .optional()
          .meta({ description: '执行器会话 id；重新排队时随 resume 带给下一次执行' }),
        ...protocolBlockedDelegationShape,
      })
      .optional()
      .meta({
        description:
          'worker 卡住但仍活着（交互式执行器）：中枢写入 task.blocked(lease_held=true)，租约照常续约',
      }),
    out_of_band: z.array(outOfBandSignal).max(100).optional().meta({
      description: '自上次续约以来的带外操作；每个信号的 id 在重试时不变',
    }),
    resumed: z
      .strictObject({ note: z.string().optional() })
      .optional()
      .meta({ description: 'worker 未经回复自行恢复（或即将结束）：中枢写入 task.unblocked' }),
    inputs_delivered: z.array(z.number().int().positive()).min(1).max(50).optional().meta({
      description:
        '已送进运行中 worker 的输入（响应 inputs 的 input_seq）；中枢写 task.input_delivered',
    }),
    inputs_dispatched: z.array(z.number().int().positive()).min(1).max(200).optional().meta({
      description:
        '已随派工输入交给执行器的输入（lease.inputs 的 input_seq）；中枢确认后才记为送达',
    }),
    branch: z
      .strictObject({
        branch: taskBranch,
        worktree: taskWorktree,
        repo_snapshot: repoSnapshot.optional(),
      })
      .optional()
      .meta({
        description:
          '执行器创建的任务分支与 worktree，以及节点在任务首次上报时对执行器解析出的登记仓库的快照（D15，写类适配器启动前）：中枢在续约生效后写入 task.branch_reported（每个任务一次；worktree 缺失的旧任务可补报一次 worktree，不补快照），结果见响应的 branch_report',
      }),
  })
  .refine((r) => !r.report_conflict || r.report_seq === r.report_conflict.report_seq, {
    message: 'report_conflict 必须与同批 report_seq 引用同一上报',
    path: ['report_conflict'],
  })
  .refine((r) => r.blocked === undefined || r.resumed === undefined, {
    message: 'blocked 与 resumed 不能同时出现',
    path: ['resumed'],
  })
  .meta({ title: 'POST /v1/leases/:id/renew' })
export type RenewLeaseRequest = z.infer<typeof renewLeaseRequest>

export const renewLeaseData = z
  .object({
    lease_id: leaseId,
    expires_at: timestamp,
    dispatch_token: z.string().min(16).optional().meta({
      description: '节点凭证指纹与中枢当前记录不一致时重新签发；节点须更新同一凭证文件',
    }),
    cancel_requested: z
      .boolean()
      .meta({ description: '为 true 时节点应停止执行器并提交 cancelled' }),
    blocked: z
      .object({
        seq: z.number().int().min(1),
        request_id: z.string().min(1).max(512).optional(),
      })
      .optional()
      .meta({ description: '本次 blocked 上报对应的事件；request_id 不同则不确认' }),
    report: pendingWorkerReport.optional(),
    branch_report: z.enum(['recorded', 'ignored', 'retry']).optional().meta({
      description:
        '续约带了 branch 时的处理结果（D15）：recorded 已写入；ignored 已上报过或被拒绝（节点不再上报）；retry 临时失败（例如数据库忙），节点保留并重发',
    }),
    reply: deliveredReply.nullable().default(null).meta({
      description:
        '任务处于 blocked 时最早一条未送达的回复；节点交给执行器后用 ack-reply 确认，确认前每次续约都会返回它',
    }),
    inputs: z.preprocess(lenientInputs, z.array(deliveredInput).default([])).meta({
      description:
        '待送达的输入（PR 直通，harness-neutral 8.4）：只发给能中途注入的执行器；不解除 blocked。节点送达后在下一次续约的 inputs_delivered 确认，确认前每次续约都会返回',
    }),
  })
  .meta({ title: 'POST /v1/leases/:id/renew 响应' })
export type RenewLeaseData = z.infer<typeof renewLeaseData>

const token = {
  lease_token: z.string().min(16),
  report_seq: z.number().int().positive().optional(),
}
export const completeLeaseRequest = z
  .discriminatedUnion('outcome', [
    z.strictObject({ ...token, outcome: z.literal('done'), result: taskResult }),
    z.strictObject({ ...token, outcome: z.literal('failed'), result: taskResult }),
    z.strictObject({
      ...token,
      outcome: z.literal('blocked'),
      blocked_reason: blockedReason,
      message: blockedMessage,
      tail: blockedTail,
      session: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .meta({ description: '执行器会话 id，回复后下一次执行据此恢复' }),
      ...protocolBlockedDelegationShape,
    }),
    z.strictObject({
      ...token,
      outcome: z.literal('cancelled'),
      message: z.string().max(PROTOCOL_MESSAGE_MAX).optional(),
      result: taskResult.optional().meta({ description: '取消时已执行的验收命令结果' }),
    }),
  ])
  .meta({
    title: 'POST /v1/leases/:id/complete',
    description: '结束租约；cancelled 仅用于确认续约响应中的取消指令',
  })
export type CompleteLeaseRequest = z.infer<typeof completeLeaseRequest>

export const completeLeaseData = z
  .object({ task: taskView })
  .meta({ title: 'POST /v1/leases/:id/complete 响应' })
export type CompleteLeaseData = z.infer<typeof completeLeaseData>

/**
 * `POST /v1/leases/:id/ack-reply`：节点报告回复的送达结果（node-protocol "续约携带待送达的回复"）。
 * - delivered：中枢在同一事务中写入 `task.unblocked`（带 reply_id），回复标记为已送达；
 * - not_running：worker 已不在运行，中枢写入 `task.requeued_with_reply`，任务带着回复重新排队。
 * 对已确认过的回复重复确认是幂等的。
 */
export const ackReplyRequest = z
  .strictObject({
    lease_token: z.string().min(16),
    reply_id: replyId,
    outcome: z.enum(['delivered', 'not_running', 'dropped']).default('delivered').meta({
      description:
        'dropped：round_closed 只丢弃该回复并通知用户，保留当前任务状态；request_changed 仅用于 supervisor 的批准，中枢解除卡住后由节点以 no_delegate 重新上报',
    }),
    reason: z
      .enum(['request_changed', 'round_closed'])
      .optional()
      .meta({ description: 'outcome 为 dropped 时必填：拒收的原因' }),
    attempted: z.boolean().optional().meta({
      description: '拒收回复时是否已经尝试注入；true 表示可能已送达',
    }),
  })
  .refine((r) => (r.outcome === 'dropped') === (r.reason !== undefined), {
    message: 'outcome 为 dropped 时必须带 reason，其他 outcome 不能带 reason',
    path: ['reason'],
  })
  .meta({ title: 'POST /v1/leases/:id/ack-reply' })
export type AckReplyRequest = z.infer<typeof ackReplyRequest>
export const ackReplyData = z
  .object({ task: taskView })
  .meta({ title: 'POST /v1/leases/:id/ack-reply 响应' })
export type AckReplyData = z.infer<typeof ackReplyData>

// ---------------------------------------------------------------------------
// 端点清单（导出 JSON Schema 与文档用）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 简报笔记（design D7、D8）
// ---------------------------------------------------------------------------

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, '应为 64 位小写十六进制 sha256')

export const briefUpdateRequest = z
  .strictObject({
    workspace: workspaceRef,
    text: z.string().meta({ description: '新的笔记全文（整体替换，最多 3000 字符）' }),
    base_hash: sha256Hex.meta({ description: '读到的笔记哈希（ws_brief 的 note_hash）' }),
  })
  .meta({ title: 'POST /v1/briefs 请求体' })
export type BriefUpdateRequest = z.infer<typeof briefUpdateRequest>

export const briefUpdateData = z
  .object({
    workspace: workspaceRef,
    file: z.string(),
    hash: sha256Hex.meta({ description: '写入后的笔记哈希' }),
    sha: z.string().nullable().meta({ description: '提交 sha；内容未变时为 null' }),
    changed: z.boolean(),
  })
  .meta({ title: 'POST /v1/briefs' })
export type BriefUpdateData = z.infer<typeof briefUpdateData>

export const briefContextQuery = z
  .strictObject({ workspace: workspaceRef })
  .meta({ title: 'GET /v1/briefs/context 查询参数' })

/** 代回复记录中的决定：approve / deny / answer 来自 task.replied，escalate 来自 task.reply_escalated。 */
export const BRIEF_REPLY_DECISIONS = ['approve', 'deny', 'answer', 'escalate'] as const

export const briefContextData = z
  .object({
    workspace: workspaceRef,
    tasks: z
      .array(
        z.object({
          id: taskId,
          role: z.string(),
          status: taskStatus,
          goal: z.string().meta({ description: '截断后的任务目标' }),
          blocked_reason: blockedReason.nullable(),
          updated_at: timestamp,
        }),
      )
      .meta({ description: '未结束的任务，按更新时间倒序' }),
    inbox: z
      .array(
        z.object({
          short_id: z.string(),
          level: z.string(),
          source: z.string(),
          title: z.string().meta({ description: '截断后的标题' }),
          created_at: timestamp,
        }),
      )
      .meta({ description: '本 workspace 未关闭的收件箱条目，按创建时间倒序' }),
    replies: z
      .array(
        z.object({
          task_id: taskId,
          decision: z.enum(BRIEF_REPLY_DECISIONS),
          reason: z.string().nullable().meta({ description: '转交原因（只有 escalate 有）' }),
          at: timestamp,
          answer_chars: z.number().int().min(0).nullable().meta({
            description:
              '回答或拒绝理由的字符数；没有文字时为 null。原文不进入简报（reply 唤醒不能写入会进入后续上下文的内容）',
          }),
        }),
      )
      .meta({
        description:
          '代回复记录：中枢根据 task.replied（actor supervisor）与 task.reply_escalated 生成，按时间倒序；只含任务 id、决定、时间与回答长度，不含回答原文',
      }),
  })
  .meta({ title: 'GET /v1/briefs/context' })
export type BriefContextData = z.infer<typeof briefContextData>

// ---------------------------------------------------------------------------
// supervisor 的提问、任务提案与决策回看（design D7、D11）
// ---------------------------------------------------------------------------

/** 提问正文的上限（字符）。 */
export const QUESTION_MAX = 2000
/** 决策回看结论的上限（字符）。 */
export const DECISION_REVIEW_MAX = 4000

export const askUserRequest = z
  .strictObject({
    workspace: workspaceRef,
    question: z.string().trim().min(1).max(QUESTION_MAX).meta({ description: '提问全文' }),
    options: inboxOptions.max(4).optional(),
  })
  .meta({ title: 'POST /v1/supervisor/questions 请求体' })
export type AskUserRequest = z.infer<typeof askUserRequest>
export const askUserData = z
  .object({ item: inboxItemView })
  .meta({ title: 'POST /v1/supervisor/questions' })

/** 巡检日报正文的上限（字符，D13）。 */
export const PATROL_REPORT_MAX = 3500

export const patrolReportRequest = z
  .strictObject({
    workspace: workspaceRef,
    text: z
      .string()
      .trim()
      .min(1)
      .max(PATROL_REPORT_MAX)
      .meta({ description: '巡检日报正文：写入 journal，并作为 Digest 条目进入每日摘要' }),
  })
  .meta({ title: 'POST /v1/supervisor/patrol-report 请求体' })
export type PatrolReportRequest = z.infer<typeof patrolReportRequest>
export const patrolReportData = z
  .object({
    item: inboxItemView,
    journal: z
      .object({ file: z.string(), sha: z.string() })
      .meta({ description: '写入的 journal 文件与 brain 提交 sha' }),
  })
  .meta({ title: 'POST /v1/supervisor/patrol-report' })
export type PatrolReportData = z.infer<typeof patrolReportData>

export const taskProposeRequest = z
  .strictObject({
    draft: createTaskRequest.meta({ description: '接受后要建的任务合同草稿' }),
    reason: z.string().trim().min(1).max(2000).optional().meta({ description: '提案理由' }),
    decision: taskProposalDecision.optional().meta({
      description: '接受时写入 brain/decisions/ 的决策（标题、预期效果、衡量指标、回看日期）',
    }),
  })
  .meta({ title: 'POST /v1/task-proposals 请求体' })
export type TaskProposeRequest = z.infer<typeof taskProposeRequest>
export const taskProposeData = z
  .object({ proposal_id: taskProposalId, item: inboxItemView })
  .meta({ title: 'POST /v1/task-proposals' })

export const decisionReviewRequest = z
  .strictObject({
    path: decisionPath,
    text: z
      .string()
      .trim()
      .min(1)
      .max(DECISION_REVIEW_MAX)
      .meta({ description: '回看结论：追加到决策的“回看”一节' }),
  })
  .meta({ title: 'POST /v1/decisions/review 请求体' })
export type DecisionReviewRequest = z.infer<typeof decisionReviewRequest>
export const decisionReviewData = z
  .object({
    path: decisionPath,
    status: z.literal('reviewed'),
    last_verified: z.string().meta({ description: '回看日期（YYYY-MM-DD，中枢时区）' }),
    sha: z.string().meta({ description: 'brain 提交 sha' }),
  })
  .meta({ title: 'POST /v1/decisions/review' })
export type DecisionReviewData = z.infer<typeof decisionReviewData>

/**
 * 合并请求（`pr_merge_request`，design D10 第 4 步）：supervisor 只给出 PR 与审查任务，
 * 其余（workspace、开出 PR 的任务、审查结论、reviewed_sha）全部由中枢从账本取得。
 */
export const mergeRequestRequest = z
  .strictObject({
    pr: prUrl,
    review_task: taskId.meta({
      description: '给出 approve 结论的审查任务（该 PR 最新一次可信审查）',
    }),
  })
  .meta({ title: 'POST /v1/merge-requests 请求体' })
export type MergeRequestRequest = z.infer<typeof mergeRequestRequest>
export const mergeRequestData = z
  .object({
    request_id: mergeRequestId,
    mode: z.enum(['auto', 'approval']).meta({
      description: 'auto：已直接建 merger 任务；approval：已生成合并审批条目，等待用户批准',
    }),
    task: taskView.optional().meta({ description: 'auto 时创建的 merger 任务' }),
    item: inboxItemView.optional().meta({ description: 'approval 时生成的收件箱条目' }),
  })
  .meta({ title: 'POST /v1/merge-requests' })
export type MergeRequestData = z.infer<typeof mergeRequestData>
// ---------------------------------------------------------------------------
// task_respond（design D15；tasks 4.9）
// ---------------------------------------------------------------------------

export const TASK_RESPOND_DECISIONS = ['approve', 'deny', 'answer', 'escalate'] as const
export type TaskRespondDecision = (typeof TASK_RESPOND_DECISIONS)[number]
/** answer 的文字上限（D15）。 */
export const TASK_RESPOND_TEXT_MAX = 2000

export const taskRespondRequest = z
  .strictObject({
    task_id: taskId.meta({ description: '委托给本次 reply 唤醒的任务' }),
    block_seq: z
      .number()
      .int()
      .min(1)
      .meta({ description: '这次卡住的 task.blocked seq（inputs.wake 中委托事件的 block_seq）' }),
    decision: z.enum(TASK_RESPOND_DECISIONS).meta({
      description:
        'approve / deny 只用于授权请求（awaiting_approval）；answer 只用于提问（question）；escalate 两者都可，转交用户',
    }),
    text: z.string().trim().min(1).max(TASK_RESPOND_TEXT_MAX).optional().meta({
      description:
        'answer 必填：回答全文；deny 可选：拒绝理由（交给 worker）；approve 与 escalate 不接受',
    }),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(REPLY_REASON_MAX)
      .meta({ description: '为什么这样决定；escalate 时作为转交说明给用户看' }),
  })
  .superRefine((r, ctx) => {
    if (r.decision === 'answer' && r.text === undefined) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'answer 必须带 text' })
    }
    if ((r.decision === 'approve' || r.decision === 'escalate') && r.text !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: `${r.decision} 不接受 text` })
    }
  })
  .meta({ title: 'POST /v1/supervisor/respond 请求体' })
export type TaskRespondRequest = z.infer<typeof taskRespondRequest>
export const taskRespondData = z
  .object({
    task: taskView,
    decision: z.enum(TASK_RESPOND_DECISIONS),
    reply: replyView
      .nullable()
      .meta({ description: '写入的回复（approve / deny / answer）；escalate 时为 null' }),
    requeued: z.boolean().meta({ description: 'true：没有节点持有该任务，任务已带着回复重新排队' }),
    observed: z.literal(true).optional().meta({
      description:
        'observe 模式（D10）：判断只记录为 task.reply_observed，未送达 worker，卡住已转给用户',
    }),
  })
  .meta({ title: 'POST /v1/supervisor/respond' })
export type TaskRespondData = z.infer<typeof taskRespondData>

export interface EndpointDef {
  method: 'GET' | 'POST'
  path: string
  auth: boolean
  /** 请求体（POST）或查询参数（GET）。 */
  request?: z.ZodType
  /** 成功响应的 data；SSE 端点为单条消息的 data。 */
  response: z.ZodType
  stream?: 'sse'
}

export const sessionBindingData = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task'),
    task: z.object({
      actor,
      task_id: taskId,
      workspace: workspaceRef,
      lease_id: leaseId,
      attempt: z.number().int().positive(),
    }),
  }),
  z.object({
    kind: z.literal('wake'),
    wake: z.object({
      actor,
      task_id: taskId,
      workspace: workspaceRef,
      lease_id: leaseId,
      origin: z.enum(['instruction', 'autonomous', 'reply']),
      generation: z.number().int().nonnegative(),
    }),
  }),
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('bound') }),
  z.object({ kind: z.literal('none') }),
])
export type SessionBindingData = z.infer<typeof sessionBindingData>

export const ENDPOINTS = {
  'session-binding': {
    method: 'GET',
    path: '/v1/binding',
    auth: true,
    response: sessionBindingData,
  },
  'tasks-report': {
    method: 'POST',
    path: '/v1/tasks/:id/report',
    auth: true,
    request: workerReportRequest,
    response: workerReportData,
  },
  'inbox-list': {
    method: 'GET',
    path: '/v1/inbox',
    auth: true,
    request: inboxListQuery,
    response: inboxListData,
  },
  'inbox-act': {
    method: 'POST',
    path: '/v1/inbox/:id/act',
    auth: true,
    request: inboxActRequest,
    response: inboxActData,
  },
  'policy-check': {
    method: 'POST',
    path: '/v1/policy/check',
    auth: true,
    request: policyCheckRequest,
    response: policyCheckData,
  },
  health: { method: 'GET', path: '/v1/health', auth: false, response: healthData },
  'hub-status': { method: 'GET', path: '/v1/hub/status', auth: true, response: hubStatusData },
  'hub-rebuild': { method: 'POST', path: '/v1/hub/rebuild', auth: true, response: rebuildData },
  'hub-tokens-issue': {
    method: 'POST',
    path: '/v1/hub/tokens',
    auth: true,
    request: issueTokenRequest,
    response: issueTokenData,
  },
  'hub-tokens-list': {
    method: 'GET',
    path: '/v1/hub/tokens',
    auth: true,
    response: listTokensData,
  },
  'hub-tokens-revoke': {
    method: 'POST',
    path: '/v1/hub/tokens/:id/revoke',
    auth: true,
    response: revokeTokenData,
  },
  'ui-login-code': {
    method: 'POST',
    path: '/v1/ui/login-code',
    auth: true,
    response: uiLoginCodeData,
  },
  'telegram-link-code': {
    method: 'POST',
    path: '/v1/telegram/link-code',
    auth: true,
    request: telegramLinkCodeRequest,
    response: telegramLinkCodeData,
  },
  'telegram-unlink': {
    method: 'POST',
    path: '/v1/telegram/unlink',
    auth: true,
    response: telegramUnlinkData,
  },
  // supervisor 唤醒调度的用户接口（add-m1-supervisor 3.4，仅 user）。
  'supervisor-wake': {
    method: 'POST',
    path: '/v1/supervisor/wake',
    auth: true,
    request: supervisorWakeRequest,
    response: supervisorWakeData,
  },
  'supervisor-status': {
    method: 'GET',
    path: '/v1/supervisor/status',
    auth: true,
    request: supervisorStatusQuery,
    response: supervisorStatusData,
  },
  'supervisor-report': {
    method: 'GET',
    path: '/v1/supervisor/report',
    auth: true,
    request: supervisorReportQuery,
    response: supervisorReportData,
  },
  'tasks-create': {
    method: 'POST',
    path: '/v1/tasks',
    auth: true,
    request: createTaskRequest,
    response: createTaskData,
  },
  'tasks-list': {
    method: 'GET',
    path: '/v1/tasks',
    auth: true,
    request: listTasksQuery,
    response: listTasksData,
  },
  'tasks-show': {
    method: 'GET',
    path: '/v1/tasks/:id',
    auth: true,
    request: showTaskQuery,
    response: taskShowResponse,
  },
  'events-get': {
    method: 'GET',
    path: '/v1/events/:id',
    auth: true,
    response: eventGetData,
  },
  // 任务绑定的知识读取（add-worker-credential-isolation D3）：只接受任务绑定令牌，按任务所属 workspace 过滤。
  // 只读，但用 POST 携带 JSON 请求体（kb_query 的条件是数组）。
  'kb-search': {
    method: 'POST',
    path: '/v1/kb/search',
    auth: true,
    request: kbSearchRequest,
    response: kbSearchOutput,
  },
  'kb-get': {
    method: 'POST',
    path: '/v1/kb/get',
    auth: true,
    request: kbGetRequest,
    response: kbGetOutput,
  },
  'kb-query': {
    method: 'POST',
    path: '/v1/kb/query',
    auth: true,
    request: kbQueryRequest,
    response: kbQueryOutput,
  },
  'tasks-cancel': {
    method: 'POST',
    path: '/v1/tasks/:id/cancel',
    auth: true,
    request: cancelTaskRequest,
    response: cancelTaskData,
  },
  'tasks-unsubscribe': {
    method: 'POST',
    path: '/v1/tasks/:id/unsubscribe',
    auth: true,
    request: unsubscribeTaskRequest,
    response: unsubscribeTaskData,
  },
  'tasks-retry': {
    method: 'POST',
    path: '/v1/tasks/:id/retry',
    auth: true,
    request: retryTaskRequest,
    response: retryTaskData,
  },
  'tasks-reply': {
    method: 'POST',
    path: '/v1/tasks/:id/reply',
    auth: true,
    request: replyTaskRequest,
    response: replyTaskData,
  },
  events: {
    method: 'GET',
    path: '/v1/events',
    auth: true,
    request: eventsQuery,
    response: ledgerEvent,
    stream: 'sse',
  },
  'nodes-register': {
    method: 'POST',
    path: '/v1/nodes',
    auth: true,
    request: registerNodeRequest,
    response: registerNodeData,
  },
  'nodes-list': { method: 'GET', path: '/v1/nodes', auth: true, response: listNodesData },
  'leases-acquire': {
    method: 'POST',
    path: '/v1/leases',
    auth: true,
    request: acquireLeaseRequest,
    response: acquireLeaseData,
  },
  'leases-renew': {
    method: 'POST',
    path: '/v1/leases/:id/renew',
    auth: true,
    request: renewLeaseRequest,
    response: renewLeaseData,
  },
  'leases-complete': {
    method: 'POST',
    path: '/v1/leases/:id/complete',
    auth: true,
    request: completeLeaseRequest,
    response: completeLeaseData,
  },
  'briefs-update': {
    method: 'POST',
    path: '/v1/briefs',
    auth: true,
    request: briefUpdateRequest,
    response: briefUpdateData,
  },
  'briefs-context': {
    method: 'GET',
    path: '/v1/briefs/context',
    auth: true,
    request: briefContextQuery,
    response: briefContextData,
  },
  'supervisor-ask': {
    method: 'POST',
    path: '/v1/supervisor/questions',
    auth: true,
    request: askUserRequest,
    response: askUserData,
  },
  'supervisor-patrol-report': {
    method: 'POST',
    path: '/v1/supervisor/patrol-report',
    auth: true,
    request: patrolReportRequest,
    response: patrolReportData,
  },
  'task-proposals-create': {
    method: 'POST',
    path: '/v1/task-proposals',
    auth: true,
    request: taskProposeRequest,
    response: taskProposeData,
  },
  'decisions-review': {
    method: 'POST',
    path: '/v1/decisions/review',
    auth: true,
    request: decisionReviewRequest,
    response: decisionReviewData,
  },
  'merge-requests-create': {
    method: 'POST',
    path: '/v1/merge-requests',
    auth: true,
    request: mergeRequestRequest,
    response: mergeRequestData,
  },
  'supervisor-respond': {
    method: 'POST',
    path: '/v1/supervisor/respond',
    auth: true,
    request: taskRespondRequest,
    response: taskRespondData,
  },
  'leases-ack-reply': {
    method: 'POST',
    path: '/v1/leases/:id/ack-reply',
    auth: true,
    request: ackReplyRequest,
    response: ackReplyData,
  },
} as const satisfies Record<string, EndpointDef>
export type EndpointName = keyof typeof ENDPOINTS
