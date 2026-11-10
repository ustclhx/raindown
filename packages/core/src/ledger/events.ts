import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  channelId,
  channelMessageKind,
  channelRef,
  INBOX_BODY_MAX,
  INBOX_NOTE_MAX,
  INBOX_PUSH_REASON_MAX,
  INBOX_TITLE_MAX,
  INBOX_VIA,
  inboxAction,
  inboxCloseReason,
  inboxItemId,
  inboxLevel,
  inboxOptions,
  inboxSource,
  inboxVia,
} from '../inbox/schema.ts'
import { indexedPolicyRuleSchema, policyDecisionSchema } from '../policy/decide.ts'
import { policyRuleHashSchema, policyVersionSchema } from '../policy/version.ts'
import { fail, ok, type Result } from '../result.ts'
import { dateString, workspaceRef } from '../schema/common.ts'
import { adapterCapabilities, NO_ADAPTER_CAPABILITIES, readAdapterCapabilities } from './adapter.ts'
import { actor, capability, executorType, leaseId, nodeId, taskId, timestamp } from './common.ts'
import { isolationProbeReport } from './isolation-probe.ts'
import { prEventPayload, prSubscriptionRole, prUnsubscribeReason } from './pr-subscription.ts'
import { PROTOCOL_MESSAGE_MAX } from './redact.ts'
import {
  approvalFingerprint,
  blockedDelegationShape,
  blockedReason,
  canTransition,
  gitSha,
  outOfBandSignal,
  policyDecisionId,
  prUrl,
  replyId,
  replyKind,
  repoSnapshot,
  type TaskStatus,
  taskAttemptEndReason,
  taskBranch,
  taskContract,
  taskMandate,
  taskOrigin,
  taskResult,
  taskWorktree,
  wakeGeneration,
  wakeOrigin,
} from './task.ts'
import { workerReportRequest } from './worker-report.ts'

/**
 * 账本事件（design D2：事件类型集中定义在这里，导出到 `schemas/events/`）。
 *
 * 公共信封：`seq`（中枢分配，单调递增）、`ts`、`type`、`workspace?`、`task_id?`、`actor`、`payload`。
 * 与任务相关的事件（task.*、lease.granted）必须带 `task_id` 与 `workspace`。
 *
 * **不入账本的高频信号**（只更新投影中的"软状态"列，不产生事件）：
 * - 续约（lease renew）：每个租约每 TTL/3 左右一次。只刷新 `leases.expires_at`。
 *   中枢重启后按表中到期时间恢复（D2）；投影重建时活动租约的到期时间重置为
 *   "重建时刻 + lease_ttl_s"，与睡眠恢复（D5）一样宁可多等一个 TTL，也不误判掉线。
 * - 活动（activity）：输出片段量大且价值短暂。中枢只在内存/投影中保留每个任务最近 N 条
 *   与 `last_activity_at`；需要持久化的末尾输出随 `task.blocked` 的 `tail` 写入账本。
 * - 节点心跳（node seen）：每次注册、领取、续约都刷新 `nodes.last_seen_at`。
 * 因此 `lease.renewed`、`task.activity`、`node.seen` 不是事件类型。
 * 代价：重建后 `last_activity_at`、`last_seen_at` 与活动缓存为空，直到下一次续约；
 * 任务的状态、尝试次数与事件时间戳不受影响（task-ledger "投影可重建"）。
 */

// ---------------------------------------------------------------------------
// 载荷
// ---------------------------------------------------------------------------

/** 渠道 chat id 的摘要（sha256 十六进制前 16 位），账本里不记明文 chat id。 */
export const chatDigestSchema = z.string().regex(/^[0-9a-f]{16}$/)
export const chatDigest = (channel: string, chatId: number): string =>
  createHash('sha256').update(`${channel}-chat:${chatId}`).digest('hex').slice(0, 16)

export const executorInfo = z
  .object({
    type: executorType,
    mode: z
      .enum(['interactive', 'headless'])
      .optional()
      .meta({ description: '交互式（如 codex-orca）或无头（如 claude-sdk）；由变更 ② 使用' }),
    adapter_capabilities: adapterCapabilities.default({ ...NO_ADAPTER_CAPABILITIES }),
    task_inputs: z.boolean().optional().meta({
      description:
        '执行器会把派工的 inputs 放进输入并由节点确认（PR 直通，harness-neutral 8.4）；旧节点没有该字段时中枢不随派工下发输入',
    }),
  })
  .meta({ title: 'Executor info' })
export type ExecutorInfo = z.infer<typeof executorInfo>

/** 注册输入仍校验已知字段的类型；读取与重放使用可逐字段降级的能力 schema。 */
export const readExecutorInfo = executorInfo.extend({
  mode: executorInfo.shape.mode.catch(undefined),
  adapter_capabilities: readAdapterCapabilities,
  task_inputs: z.boolean().optional().catch(undefined),
})

/**
 * `task.replied` 的渠道：收件箱渠道之外多一个 `supervisor`（D15：supervisor 代用户回复）。
 * 只用于回复事件，不扩大收件箱其他事件的 via。
 */
export const REPLY_VIA = [...INBOX_VIA, 'supervisor'] as const
export type ReplyVia = (typeof REPLY_VIA)[number]
export const replyVia = z.enum(REPLY_VIA).meta({
  description: '回复发起的渠道；supervisor 表示 supervisor 代用户回复',
})

/**
 * 代回复委托结束的原因（D15 "转交与竞态"）。任务离开该次卡住（包括进入新的卡住）时委托隐式失效，
 * 不写事件，见 `activeDelegation`。
 */
export const REPLY_ESCALATION_REASONS = [
  'supervisor',
  'timeout',
  'wake_unavailable',
  'wake_failed',
  'wake_ended',
  'user_dismissed',
  'user_replied',
  'policy_changed',
  'observe',
  'config_unavailable',
] as const
export type ReplyEscalationReason = (typeof REPLY_ESCALATION_REASONS)[number]
export const replyEscalationReason = z.enum(REPLY_ESCALATION_REASONS).meta({
  description:
    'supervisor 主动转交；timeout 超时；wake_unavailable 唤醒无法开始；wake_failed / wake_ended 唤醒失败或结束仍未回复；user_dismissed 用户忽略；user_replied 用户已回复；policy_changed 依赖的策略已改变；observe 该项处于 observe 模式，supervisor 的判断只记录不送达；config_unavailable 回复时 workspace 配置无法读取，判断按失败即不送达处理',
})

/** `supervisor.observed_action.args` 的上限（D10：参数摘要做遮蔽与长度限制）。 */
export const OBSERVED_ARGS_MAX = 1000

/** supervisor 代回复（task_respond）的理由上限。 */
export const REPLY_REASON_MAX = 2000

/** 可委托给 supervisor 的卡住原因（D15）。 */
export const DELEGABLE_BLOCKED_REASONS = ['question', 'awaiting_approval'] as const
export const delegableBlockedReason = z.enum(DELEGABLE_BLOCKED_REASONS)

/** 普通唤醒队列（`supervisor.release` 只能放行这两条；reply 队列不暂停、不放行）。 */
export const SUPERVISOR_QUEUES = ['instruction', 'autonomous'] as const
export const supervisorQueue = z.enum(SUPERVISOR_QUEUES)

/** 丢弃队列积压的原因（`supervisor.queue_dropped`）。 */
export const QUEUE_DROP_REASONS = [
  'unknown_workspace',
  'global',
  'disabled',
  'no_role',
  'role_invalid',
  'no_repo',
  'workspaces_invalid',
] as const
export type QueueDropReason = (typeof QUEUE_DROP_REASONS)[number]
export const queueDropReason = z.enum(QUEUE_DROP_REASONS).meta({
  description:
    'global / disabled / no_repo / no_role / unknown_workspace：稳定地不可唤醒，立即丢弃；role_invalid / workspaces_invalid（定义文件有错）：暂时不可唤醒持续超过 24 小时，丢弃早于宽限期的事件',
})

/** 任务提案 id：`tp-<随机串>`。 */
export const taskProposalId = z
  .string()
  .regex(/^tp-[A-Za-z0-9_.-]{1,64}$/, '任务提案 id 形如 tp-<随机串>')
  .meta({ description: '任务提案 id，由中枢在提交时分配' })

/** 合并请求 id（`pr_merge_request`，D10）：中枢在请求时分配。 */
export const mergeRequestId = z
  .string()
  .regex(/^mr-[A-Za-z0-9_.-]{1,64}$/, '合并请求 id 形如 mr-<随机串>')
  .meta({ description: '合并请求 id，由中枢在请求时分配' })

/** brain 中决策条目的路径（相对 brain/），例如 `decisions/2026-10-26-cache.md`。 */
export const decisionPath = z
  .string()
  .max(256)
  .regex(/^decisions\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, '决策路径应形如 decisions/<名称>.md')
  .meta({ description: '决策条目路径（相对 brain/）' })

/** 任务提案附带的决策（D11）：接受时写入 brain/decisions/，到回看日期唤醒 supervisor 回看。 */
export const taskProposalDecision = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    expected_outcome: z.string().trim().min(1).max(2000),
    metric: z.string().trim().min(1).max(2000),
    review_date: dateString.meta({
      description: '回看日期（YYYY-MM-DD），晚于当天且不超过 180 天',
    }),
  })
  .meta({ title: 'Task proposal decision' })

export const eventPayloads = {
  'policy.changed': z.strictObject({
    from: policyVersionSchema.nullable(),
    to: policyVersionSchema,
    added: z.array(policyRuleHashSchema),
    removed: z.array(policyRuleHashSchema),
  }),
  'policy.decided': policyDecisionSchema.extend({
    task_id: taskId,
    policy_version: policyVersionSchema.optional(),
    request: z.strictObject({
      tool: z.string().min(1).max(128),
      actions: z.array(z.string().min(1)),
      command: z.string().max(2000).optional(),
      paths: z.array(z.string().max(2000)).max(200).optional(),
      push_env_ok: z
        .boolean()
        .optional()
        .meta({ description: '节点上报的推送环境检查结果（D15）；缺失视为不满足' }),
      gh_env_ok: z
        .boolean()
        .optional()
        .meta({ description: '节点上报的 gh 仓库解析检查结果（D15）；缺失视为不满足' }),
      command_cwd: taskWorktree
        .optional()
        .meta({ description: '节点上报的命令实际执行目录（realpath，D15）' }),
    }),
  }),
  'task.created': z.strictObject({
    contract: taskContract,
    mandate: taskMandate.optional(),
    origin: taskOrigin.optional().meta({
      description: '中枢计算的来源（D2），创建时写入、之后不变；不在 supervisor 链上的任务省略',
    }),
  }),
  'task.policy_changed': z.strictObject({
    policy_seq: z.number().int().min(1),
    rules: z.array(policyRuleHashSchema),
    note: z.string().max(2000).optional(),
  }),
  'task.started': z.strictObject({
    node_id: nodeId,
    lease_id: leaseId,
    attempt: z.number().int().min(1).meta({ description: '第几次尝试，从 1 开始' }),
    unisolated: z.string().min(1).max(4000).optional().meta({
      description:
        '角色 isolation: preferred 而这次派到的节点未施加隔离时，中枢记下的“未隔离”说明（缺什么）；已隔离或 off 时没有',
    }),
  }),
  'task.attempt_ended': z.strictObject({
    attempt: z.number().int().min(1),
    reason: taskAttemptEndReason,
    last_report: z.string().max(16_384).optional().meta({ description: '派工最后一次上报的摘要' }),
  }),
  'task.verifying': z.strictObject({ node_id: nodeId }),
  'task.done': z.strictObject({ result: taskResult }),
  'task.failed': z
    .strictObject({
      result: taskResult.optional().meta({ description: '节点提交失败时的结果' }),
      message: z.string().min(1).optional().meta({ description: '人或 supervisor 放弃时的说明' }),
    })
    .refine((p) => p.result !== undefined || p.message !== undefined, {
      message: 'task.failed 至少需要 result 或 message',
    }),
  'task.reported': workerReportRequest.safeExtend({
    attempt: z.number().int().positive(),
    lease_id: leaseId,
  }),
  'task.report_consumed': z.strictObject({
    attempt: z.number().int().positive(),
    lease_id: leaseId,
    report_seq: z.number().int().positive(),
  }),
  'task.report_conflict': z.strictObject({
    attempt: z.number().int().positive(),
    lease_id: leaseId,
    report_seq: z.number().int().positive(),
    observed: z.enum(['idle', 'busy', 'no_progress']),
  }),
  'task.blocked': z.strictObject({
    request_id: z.string().min(1).max(512).optional(),
    approval_fingerprint: approvalFingerprint.optional(),
    reason: blockedReason,
    message: z.string().min(1),
    tail: z
      .array(z.string())
      .max(200)
      .optional()
      .meta({ description: '卡住时终端或输出的末尾若干行' }),
    node_id: nodeId.optional(),
    lease_held: z.boolean().default(false).meta({
      description:
        'true：交互式执行器的 worker 还活着，节点继续持有并续约租约（D7a）；false：这一轮执行已结束，租约随之释放',
    }),
    session: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .meta({ description: '执行器的会话 id；带回复重新排队时附到下一次执行（D6）' }),
    prior_reason: blockedReason.optional().meta({
      description:
        'node_lost 时节点掉线之前的卡住原因，例如 awaiting_approval（仍可 approve / deny）',
    }),
    ...blockedDelegationShape,
  }),
  'task.reply_dropped': z.strictObject({
    reply_id: replyId,
    reason: z.literal('round_closed'),
    message: z.string().min(1).max(2000),
  }),
  'task.out_of_band': outOfBandSignal,
  'task.unblocked': z.strictObject({
    note: z.string().optional().meta({ description: '解除卡住的说明，例如用户的答复摘要' }),
    reply_id: replyId
      .optional()
      .meta({ description: '因送达这条回复而解除卡住（ack-reply）；没有时为执行器自行恢复' }),
    dropped_reply_ids: z.array(replyId).optional().meta({
      description: 'worker 自行恢复时尚未送达、因此被丢弃的回复（供收件箱通知回复者）',
    }),
  }),
  'task.reply_fetched': z.strictObject({ reply_id: replyId, lease_id: leaseId }),
  'task.replied': z
    .strictObject({
      reply_id: replyId,
      kind: replyKind,
      via: replyVia.optional(),
      policy_version: policyVersionSchema.optional(),
      matched_rules: z.array(indexedPolicyRuleSchema).optional(),
      text: z.string().min(1).max(16_384).optional().meta({ description: '回复文字或拒绝理由' }),
      reason: z.string().min(1).max(REPLY_REASON_MAX).optional().meta({
        description:
          'supervisor 代回复时给出的理由（D15，只用于 via: supervisor）；只进用户可见的每日摘要，不进简报',
      }),
    })
    .refine((p) => p.kind !== 'text' || p.text !== undefined, {
      message: '文字回复必须带 text',
      path: ['text'],
    })
    .refine((p) => p.reason === undefined || p.via === 'supervisor', {
      message: '只有 supervisor 代回复（via: supervisor）可以带 reason',
      path: ['reason'],
    }),
  'task.requeued_with_reply': z.strictObject({
    reply_id: replyId,
    session: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .meta({ description: '上一轮卡住时上报的会话 id，下一次执行据此恢复' }),
  }),
  'task.requeued': z.strictObject({
    reason: z.enum(['lease_expired', 'manual', 'input']).meta({
      description:
        'lease_expired：允许重试的任务租约过期；manual：人或 supervisor 重新排队；input：已结束任务因名单内用户的 PR 评论恢复（harness-neutral 8.5，只由中枢写入）',
    }),
    pr_event_seq: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({ description: 'reason 为 input 时：恢复所依据的 pr.event' }),
    pr_sourced: z.literal(true).optional().meta({
      description: '中枢计算：由 PR 来源唤醒发起的重试（污染随任务保留，不因重试清除）',
    }),
    requested_by: z.enum(['user', 'supervisor']).optional(),
    retry_reason: z.string().trim().min(1).max(PROTOCOL_MESSAGE_MAX).optional(),
    policy_version: policyVersionSchema.optional(),
    note: z.string().optional(),
  }),
  'task.cancel_requested': z.strictObject({ reason: z.string().optional() }),
  'task.cancelled': z.strictObject({
    reason: z.string().optional(),
    result: taskResult.optional().meta({ description: '取消时已执行的验收命令结果' }),
    node_id: nodeId.optional().meta({ description: '由持有租约的节点确认取消时填写' }),
  }),
  'task.lease_expired': z.strictObject({
    lease_id: leaseId,
    node_id: nodeId,
    expired_at: timestamp,
    attempt: z.number().int().min(1),
  }),
  /**
   * 卡住委托给 supervisor 代回复（D15）。`block_seq` 是该次 `task.blocked` 的 seq；
   * 委托期间条目不推送，到 `deadline` 仍未回复则转交用户。
   */
  'task.reply_delegated': z.strictObject({
    task_id: taskId,
    block_seq: z.number().int().min(1).meta({ description: '被委托的那次 task.blocked 的 seq' }),
    kind: delegableBlockedReason.meta({ description: '卡住原因：question 或 awaiting_approval' }),
    decision_id: policyDecisionId.optional(),
    policy_version: policyVersionSchema.optional(),
    matched_rules: z.array(indexedPolicyRuleSchema).optional(),
    deadline: timestamp.meta({ description: '超过此时间仍未回复即转交用户（reply_timeout_s）' }),
    observe: z.literal(true).optional().meta({
      description:
        '委托时该项处于 observe 模式（D10）：supervisor 的判断只记录为 task.reply_observed，不送达 worker',
    }),
  }),
  /** 代回复委托结束、转交用户（D15）；除 user_replied、user_dismissed 外按条目原级别推送。 */
  'task.reply_escalated': z.strictObject({
    reason: replyEscalationReason,
    policy_version: policyVersionSchema.optional(),
    matched_rules: z.array(indexedPolicyRuleSchema).optional(),
    to_version: policyVersionSchema.optional().meta({
      description: '策略变化导致转交时的新策略版本；policy_version 保留原委托的判定版本',
    }),
    dropped_reply_id: replyId.optional().meta({
      description: '策略变化时撤回的尚未送达的 supervisor 批准回复；任务保持 blocked',
    }),
    block_seq: z
      .number()
      .int()
      .min(1)
      .meta({ description: '被结束的委托对应的 task.blocked seq（必须是当前这次卡住）' }),
    note: z.string().max(2000).optional().meta({ description: '说明，例如 supervisor 转交的理由' }),
  }),
  /**
   * observe 模式下 supervisor 对委托给出的判断（D10）：只记录"会怎么做"，**不写 task.replied、不送达 worker**，
   * 随后以 `task.reply_escalated{reason: observe}` 转给用户。信封不带 task_id（workspace 级事件），
   * 任务绑定的读取（task_show / event_get）因此看不到它；任务 id 在载荷里。
   */
  'task.reply_observed': z.strictObject({
    task_id: taskId,
    block_seq: z.number().int().min(1).meta({ description: '被委托的那次 task.blocked 的 seq' }),
    delegation_seq: z
      .number()
      .int()
      .min(1)
      .meta({ description: '对应的 task.reply_delegated 的 seq' }),
    kind: delegableBlockedReason,
    decision_id: policyDecisionId.optional(),
    decision: z.enum(['approve', 'deny', 'answer', 'escalate']).meta({
      description: 'supervisor 的判断：批准、拒绝、回答或转交',
    }),
    text: z.string().min(1).max(2000).optional().meta({ description: '回答的文字（answer）' }),
    reason: z.string().min(1).max(REPLY_REASON_MAX).meta({ description: 'supervisor 给出的理由' }),
    policy_version: policyVersionSchema.optional(),
    forced: z.literal('config_unavailable').optional().meta({
      description:
        '不是 observe 模式：回复时 workspace 配置无法读取，按失败即不送达只记录（不计入 supervisor report 一致率）',
    }),
  }),
  /**
   * 执行器创建的任务分支（D15，写类适配器启动前上报）：只接受持有该任务活动租约的节点写入，
   * 每个任务只写一次、不可更改。`when.push_to: task_branch` 以它为准。
   */
  'task.branch_reported': z.strictObject({
    branch: taskBranch,
    worktree: taskWorktree.optional().meta({
      description:
        '任务 worktree（节点 realpath 后的绝对路径）；push_to / gh_scope 要求命令在其中执行，缺失即不满足',
    }),
    repo_snapshot: repoSnapshot.optional().meta({
      description: '租约开始、worker 启动前节点对登记仓库的快照；push_to 的默认分支只取这里的值',
    }),
  }),
  'lease.granted': z.strictObject({
    lease_id: leaseId,
    node_id: nodeId,
    token_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .meta({ description: '租约令牌的 SHA-256；令牌明文不入账本' }),
    ttl_s: z.number().int().positive(),
    expires_at: timestamp,
  }),
  'node.registered': z.strictObject({
    node_id: nodeId,
    hostname: z.string().min(1),
    version: z.string().min(1),
    capabilities: z.array(capability),
    executors: z.array(executorInfo).default([]),
    concurrency: z.number().int().min(1),
    isolation_probe: isolationProbeReport.optional(),
  }),
  'schedule.fired': z.strictObject({
    rule_id: z.string().min(1),
    planned_at: timestamp,
    missed: z.boolean().default(false).meta({ description: '中枢停机或睡眠期间错过、恢复后补发' }),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
  'hub.started': z.strictObject({
    version: z.string().min(1),
    policy_version: policyVersionSchema.optional(),
    policy_rules: z.array(policyRuleHashSchema).optional(),
    pid: z.number().int().positive(),
    runtime: z.enum(['bun', 'node']),
    port: z.number().int().min(1).max(65535),
  }),
  'hub.resumed': z.strictObject({
    slept_ms: z.number().int().min(0).meta({ description: '墙钟比单调时钟多走的毫秒数' }),
    extended_leases: z.number().int().min(0),
  }),
  'hub.backup_done': z.strictObject({
    path: z.string().min(1).meta({ description: '备份文件路径（相对 raindown-home）' }),
    size_bytes: z.number().int().min(0),
    duration_ms: z.number().int().min(0),
    removed: z.array(z.string()).default([]).meta({ description: '按保留份数删除的旧备份' }),
  }),
  'hub.rebuilt': z.strictObject({
    events_replayed: z.number().int().min(0),
    duration_ms: z.number().int().min(0),
  }),
  // 收件箱（add-m1-inbox design D1）：由中枢的反应器与提案监听写入，折叠成 inbox_items 投影。
  'inbox.item_created': z.strictObject({
    item_id: inboxItemId,
    level: inboxLevel,
    source: inboxSource,
    source_ref: z
      .string()
      .min(1)
      .max(256)
      .meta({ description: '关联对象：任务 id、提案 id 或源事件 seq' }),
    reason: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .meta({ description: '来源内的原因，例如卡住原因 question' }),
    title: z.string().min(1).max(INBOX_TITLE_MAX),
    body: z.string().max(INBOX_BODY_MAX).default(''),
    actions: z.array(inboxAction).default([]).meta({
      description: '可用的操作；忽略（dismiss）总是可用，不写在这里',
    }),
    options: inboxOptions.optional().meta({
      description: 'supervisor 提问的候选答复（2–4 个，D11）；只用于 source=supervisor 的条目',
    }),
    source_seq: z.number().int().min(1).optional().meta({
      description: '触发该条目的账本事件 seq（反应器的幂等键）；提案等账本外的来源没有',
    }),
    deferred_until: timestamp
      .optional()
      .meta({ description: '静默时段内生成时，顺延推送到此时（3.3）' }),
  }),
  'inbox.item_updated': z
    .strictObject({
      item_id: inboxItemId,
      level: inboxLevel.optional(),
      title: z.string().min(1).max(INBOX_TITLE_MAX).optional(),
      body: z.string().max(INBOX_BODY_MAX).optional(),
      actions: z.array(inboxAction).optional(),
      deferred_until: timestamp.nullable().optional().meta({ description: 'null 表示取消顺延' }),
    })
    .refine((p) => Object.keys(p).length > 1, { message: 'inbox.item_updated 至少要改一个字段' }),
  'inbox.item_closed': z.strictObject({
    item_id: inboxItemId,
    reason: inboxCloseReason,
    note: z.string().max(INBOX_NOTE_MAX).optional(),
    cause_seq: z.number().int().min(1).optional().meta({
      description: '导致关闭的账本事件 seq（例如 task.unblocked），反应器据此续跑',
    }),
    cause_actor: actor.optional().meta({
      description: '导致关闭的操作者，例如答复任务的 user（渠道据此显示"已处理（来自 CLI）"）',
    }),
    via: inboxVia.optional().meta({ description: '操作发起的渠道；缺省表示命令行或自动关闭' }),
  }),
  /**
   * 渠道推送记录（add-m1-inbox 3.3 / 4.1）：
   * - `op: send`：消息已发出，`item_ids` 是消息里的条目（Decide 合并消息有多个）；
   * - `op: update`：条目关闭后消息已改为"已处理"，`item_ids` 是这次同步了关闭状态的条目；
   * - `op: failed`：放弃推送（消息级失败连续 5 次、永久错误或超时 3 次），`reason` 说明原因。
   *   没有 `ref` 时是发送失败（这些条目不再推送到该渠道）；有 `ref` 时是该消息的"已处理"同步失败。
   *   投影把它视为已处理，条目视图与 `raindown hub status` 中标出"推送失败"。
   * 投影维护 `pushed_at`、`channels`（channel_refs_json）与 `channel_messages`，可重建。
   * 条目关闭后仍可写入（推送与关闭可能交错）。
   */
  'inbox.pushed': z
    .strictObject({
      channel: channelId,
      ref: channelRef.optional(),
      op: z.enum(['send', 'update', 'failed']).default('send'),
      kind: channelMessageKind.default('item'),
      item_ids: z.array(inboxItemId).min(1).max(500),
      reason: z
        .string()
        .min(1)
        .max(INBOX_PUSH_REASON_MAX)
        .optional()
        .meta({ description: 'op=failed 时放弃推送的原因' }),
    })
    .refine((p) => p.op === 'failed' || p.ref !== undefined, {
      message: 'send / update 必须带 ref',
      path: ['ref'],
    })
    .refine((p) => (p.op === 'failed') === (p.reason !== undefined), {
      message: '只有 op=failed 带 reason，且必须带',
      path: ['reason'],
    }),
  /**
   * 用户下达给 supervisor 的指令（telegram-channel "命令"：`/ask <workspace> <内容>`）。
   * 由变更 ④ 的 supervisor 消费；在它上线之前只入账，不产生任何投影。
   */
  /**
   * 渠道改绑（add-m1-inbox 5.1 审查）：已绑定的 Telegram 被新的绑定码改绑到另一个 chat。
   * 只记 chat id 的摘要（`chatDigest`），不记明文 id；改绑前已通知原 chat。
   */
  'channel.rebound': z.strictObject({
    channel: channelId,
    from_chat: chatDigestSchema.meta({ description: '原 chat id 的摘要' }),
    to_chat: chatDigestSchema.meta({ description: '新 chat id 的摘要' }),
    via: inboxVia,
  }),
  /** 渠道解除绑定（`raindown telegram unlink`）。 */
  'channel.unlinked': z.strictObject({
    channel: channelId,
    chat: chatDigestSchema.meta({ description: '解除绑定的 chat id 的摘要' }),
    via: inboxVia,
  }),
  'user.instruction': z.strictObject({
    text: z.string().min(1).max(PROTOCOL_MESSAGE_MAX).meta({ description: '指令原文' }),
    via: inboxVia.meta({ description: '指令来自哪个渠道' }),
  }),
  /**
   * supervisor 唤醒开始（D1、D3）：中枢以 hub 身份创建唤醒任务后立即写入。
   * **判断某任务是不是唤醒任务、它的 origin 是什么，都以这条事件为准**，不看角色名或 inputs。
   * `events` 是这次唤醒合并的账本事件 seq。
   */
  'supervisor.wake_started': z.strictObject({
    task_id: taskId.meta({ description: '唤醒任务 id' }),
    workspace: workspaceRef,
    origin: wakeOrigin,
    events: z
      .array(z.number().int().min(1))
      .max(200)
      .meta({ description: '这次唤醒合并的账本事件 seq（按顺序）' }),
    generation: wakeGeneration,
    source: z.literal('pr').optional().meta({
      description:
        '合并了 PR 评论（pr.wake_requested）的唤醒：保留 instruction 队列优先级，但不满足 auto_merge、受 observe 约束、新任务不继承原始指令',
    }),
  }),
  /** 用户回答了 supervisor 的提问（D11）：条目关闭为 answered，并唤醒 supervisor。 */
  'supervisor.answered': z.strictObject({
    item_id: inboxItemId,
    text: z.string().min(1).max(INBOX_BODY_MAX).meta({ description: '答复原文或所选选项' }),
    via: inboxVia.optional(),
  }),
  /** 用户手动放行一条普通唤醒队列（`raindown supervisor wake <ws> --release <queue>`，D3）。 */
  'supervisor.release': z.strictObject({ queue: supervisorQueue }),
  /**
   * 中枢丢弃一条普通唤醒队列中的积压（G10 审查）：该 workspace 稳定地不可唤醒（未启用、global、
   * 没有登记仓库），或暂时不可唤醒（没有或不合格的 supervisor 角色、workspace 未定义）持续超过 24 小时。
   * 投影据此清掉该队列中 seq 不大于 `up_to_seq` 的事件，重放结果确定；之后启用不会带出旧事件。
   */
  /**
   * 唤醒调度器首次启动的初始化标记（G10 审查）：只写一次。调度器只处理 seq 大于 `up_to_seq` 的
   * 普通队列事件，之前写下的旧事件（例如调度器上线前的 user.instruction）不回放。
   */
  'supervisor.scheduler_initialized': z.strictObject({
    up_to_seq: z
      .number()
      .int()
      .min(0)
      .meta({ description: '初始化时账本的最新 seq（空账本为 0）' }),
  }),
  /**
   * observe 模式下 autonomous 唤醒的写类动作（D10）：只记录，不执行。`args` 是遮蔽并截断后的参数摘要。
   */
  'supervisor.observed_action': z.strictObject({
    wake_task_id: taskId.meta({ description: '发起动作的 autonomous 唤醒任务' }),
    action: z.enum(['task_create', 'task_propose', 'pr_merge_request']),
    args: z
      .string()
      .max(OBSERVED_ARGS_MAX)
      .meta({ description: '参数摘要（遮蔽疑似密钥，最多 1000 字符）' }),
    reason: z.string().min(1).max(2000).meta({ description: '未执行的原因' }),
  }),
  'supervisor.queue_dropped': z.strictObject({
    queue: supervisorQueue,
    up_to_seq: z.number().int().min(1).meta({ description: '清掉该队列中 seq 不大于它的事件' }),
    reason: queueDropReason,
  }),
  /** supervisor 提交任务提案（D11）：`draft` 是接受后要建的任务合同。 */
  'task_proposal.created': z.strictObject({
    proposal_id: taskProposalId,
    wake_task_id: taskId.meta({ description: '提交提案的唤醒任务' }),
    instruction_seq: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({ description: '经中枢校验的提案原始指令序号' }),
    draft: taskContract,
    decision: taskProposalDecision.optional(),
    decision_path: decisionPath.optional().meta({
      description: '带决策时，接受后写入的决策条目路径（提交时由中枢确定，接受与重试都用它）',
    }),
    reason: z.string().max(2000).optional().meta({ description: '提案理由' }),
  }),
  /** 用户接受任务提案：中枢以 user 身份建任务（origin instruction），有决策时写入 brain。 */
  'task_proposal.accepted': z.strictObject({
    proposal_id: taskProposalId,
    task_id: taskId.meta({ description: '据此创建的任务' }),
    goal: z
      .string()
      .trim()
      .min(1)
      .optional()
      .meta({ description: '用户在 Web 上修改后的目标；没有修改时省略' }),
    decision_path: decisionPath.optional(),
    via: inboxVia.optional(),
  }),
  'task_proposal.rejected': z.strictObject({
    proposal_id: taskProposalId,
    note: z.string().max(2000).optional(),
    via: inboxVia.optional(),
  }),
  /** 决策到回看日期（D11）：同一决策只写一次，停机错过的在下一次扫描补发。 */
  'decision.review_due': z.strictObject({
    path: decisionPath,
    review_date: dateString,
    missed: z.boolean().default(false).meta({ description: '停机期间错过、恢复后补发' }),
  }),
  /**
   * supervisor 的合并请求通过了中枢的资格核对（D10 第 4 步）：全部字段由中枢从账本取得。
   * `auto_merge` 时与 merger 任务在同一事务中写入（带 `merger_task`）；否则与 `merge_request`
   * 收件箱条目一起写入（带 `item_id`），等待用户批准。
   */
  'merge_request.created': z.strictObject({
    request_id: mergeRequestId,
    wake_task_id: taskId.meta({ description: '发起请求的唤醒任务' }),
    pr: prUrl,
    review_task: taskId.meta({ description: '给出 approve 结论的审查任务（最新一次可信审查）' }),
    dev_task: taskId.meta({
      description: '开出该 PR 的任务（origin instruction、有效类别 write）',
    }),
    reviewed_sha: gitSha.meta({ description: '审查时的 PR head（执行器记录）' }),
    auto_merge: z
      .boolean()
      .meta({ description: '是否按 supervisor.auto_merge 直接建 merger 任务' }),
    item_id: inboxItemId
      .optional()
      .meta({ description: '等待批准的收件箱条目（auto_merge 为 false）' }),
    merger_task: taskId
      .optional()
      .meta({ description: '直接创建的 merger 任务（auto_merge 为 true）' }),
  }),
  /** 用户批准了 supervisor 的合并请求（D10）：中枢随后以 hub 身份建 merger 任务。 */
  'merge_request.approved': z.strictObject({
    item_id: inboxItemId.optional().meta({ description: '合并请求的收件箱条目' }),
    pr: prUrl,
    review_task: taskId.meta({ description: '给出 approve 结论的审查任务' }),
    approved_by: actor.meta({ description: '批准者' }),
    via: inboxVia.optional(),
  }),
  /** 用户驳回 supervisor 的合并请求（D10）：唤醒 supervisor（instruction 队列）。 */
  'merge_request.rejected': z.strictObject({
    item_id: inboxItemId.meta({ description: '合并请求的收件箱条目' }),
    pr: prUrl,
    review_task: taskId,
    note: z.string().max(2000).optional().meta({ description: '驳回理由' }),
    via: inboxVia.optional(),
  }),
  /**
   * 任务订阅 PR（D11；pr-subscription "订阅 PR"）：开发任务在任务分支上开出的 PR（author）、
   * 审查任务审查的 PR（reviewer）。只由中枢写入；同一任务对同一 PR 同时只有一条有效订阅。
   */
  'pr.subscribed': z.strictObject({
    pr: prUrl.meta({ description: '规范化的 PR 链接' }),
    role: prSubscriptionRole,
  }),
  /** 结束订阅：用户取消（actor user）或中枢判定（PR 关闭满保留期、不是任务分支开出、仓库未登记）。 */
  'pr.unsubscribed': z.strictObject({
    pr: prUrl,
    reason: prUnsubscribeReason,
  }),
  /**
   * 给任务的新输入（harness-neutral 8.4）：订阅的 PR 上的事件。运行中的任务经续约下发（与回复同一通道，
   * 但不解除 blocked）；执行器不能中途注入时排队到下一次派工输入。只由中枢写入。
   */
  'task.input_added': z.strictObject({
    source: z.literal('pr'),
    pr_event_seq: z.number().int().positive().meta({ description: '对应的 pr.event 的 seq' }),
  }),
  /** 节点确认已把输入送进运行中的 worker（续约的 inputs_delivered）。 */
  'task.input_delivered': z.strictObject({
    input_seqs: z.array(z.number().int().positive()).min(1).max(200),
    lease_id: leaseId,
    via: z.enum(['running', 'dispatch']).optional().meta({
      description:
        'running 送进运行中的 worker；dispatch 随派工输入交给执行器（节点确认后才记为送达）',
    }),
  }),
  /**
   * 名单内用户的 PR 评论进入 supervisor 的 instruction 唤醒队列（harness-neutral 8.5、8.6）：
   * handback 由 worker 交回（附理由）；no_subscriber 没有订阅任务接收；resume_rejected 已结束任务恢复前的
   * 授权校验未通过。只由中枢写入，且只能指向 allowed 的人类评论。
   */
  'pr.wake_requested': z.strictObject({
    pr_event_seq: z.number().int().positive(),
    reason: z.enum(['handback', 'no_subscriber', 'resume_rejected']),
    note: z
      .string()
      .min(1)
      .max(PROTOCOL_MESSAGE_MAX)
      .optional()
      .meta({ description: 'handback 时为 worker 的理由；resume_rejected 时为校验未通过的原因' }),
  }),
  /** 直通已处理这条 PR 事件（持久化检查点：中枢重启后从它之后继续，不按时间窗口重放）。 */
  'pr.dispatched': z.strictObject({ pr_event_seq: z.number().int().positive() }),
  /**
   * 中枢 pr-watcher 读到的一条 PR 事件（D11）。只由中枢写入；`allowed` 由中枢按 `github.allowed_users`
   * 计算，不取自任何评论内容。重启后按 `cursor` 续读，已入账的不再送达。
   */
  'pr.event': prEventPayload,
} as const

export type EventType = keyof typeof eventPayloads
export const EVENT_TYPES = Object.keys(eventPayloads) as EventType[]
export const isKnownEventType = (type: unknown): type is EventType =>
  typeof type === 'string' && Object.hasOwn(eventPayloads, type)

/** 客户端只跳过未知类型；损坏的信封和已知事件仍交给协议 schema 严格校验。 */
export function filterUnknownEventTypes(events: unknown): unknown {
  return Array.isArray(events)
    ? events.filter(
        (event) =>
          typeof event !== 'object' ||
          event === null ||
          !('type' in event) ||
          typeof event.type !== 'string' ||
          isKnownEventType(event.type),
      )
    : events
}
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloads)[T]>

/** 信封中 task_id / workspace 的要求。 */
type Scope = 'task' | 'workspace' | 'none'
export const EVENT_SCOPES: Record<EventType, Scope> = {
  'policy.changed': 'none',
  'policy.decided': 'task',
  'task.created': 'task',
  'task.policy_changed': 'task',
  'task.started': 'task',
  'task.attempt_ended': 'task',
  'task.verifying': 'task',
  'task.done': 'task',
  'task.failed': 'task',
  'task.reported': 'task',
  'task.report_consumed': 'task',
  'task.report_conflict': 'task',
  'task.blocked': 'task',
  'task.reply_dropped': 'task',
  'task.out_of_band': 'task',
  'task.unblocked': 'task',
  'task.replied': 'task',
  'task.reply_fetched': 'task',
  'task.requeued_with_reply': 'task',
  'task.requeued': 'task',
  'task.cancel_requested': 'task',
  'task.cancelled': 'task',
  'task.lease_expired': 'task',
  'task.reply_delegated': 'task',
  'task.reply_escalated': 'task',
  // 不带 task_id：任务绑定的读取看不到 observe 判断（D10）。
  'task.reply_observed': 'workspace',
  'task.branch_reported': 'task',
  'lease.granted': 'task',
  'node.registered': 'none',
  'schedule.fired': 'workspace',
  'hub.started': 'none',
  'hub.resumed': 'none',
  'hub.backup_done': 'none',
  'hub.rebuilt': 'none',
  // 任务来源的条目带 task_id 与 workspace；提案等全局来源都可省略。
  'inbox.item_created': 'none',
  'inbox.item_updated': 'none',
  'inbox.item_closed': 'none',
  'inbox.pushed': 'none',
  'channel.rebound': 'none',
  'channel.unlinked': 'none',
  'user.instruction': 'workspace',
  // 唤醒事件带唤醒任务 id 与 workspace；唤醒任务刚创建（queued）时写入。
  'supervisor.wake_started': 'task',
  'supervisor.answered': 'workspace',
  'supervisor.release': 'workspace',
  'supervisor.queue_dropped': 'workspace',
  'supervisor.observed_action': 'workspace',
  'supervisor.scheduler_initialized': 'none',
  'task_proposal.created': 'workspace',
  'task_proposal.accepted': 'workspace',
  'task_proposal.rejected': 'workspace',
  // 决策可能没有 workspace（此时只生成 Digest 条目）。
  'decision.review_due': 'none',
  'merge_request.created': 'workspace',
  'merge_request.approved': 'workspace',
  'merge_request.rejected': 'workspace',
  'pr.subscribed': 'task',
  'pr.unsubscribed': 'task',
  'pr.event': 'workspace',
  'task.input_added': 'task',
  'task.input_delivered': 'task',
  'pr.wake_requested': 'workspace',
  'pr.dispatched': 'workspace',
}

const scopeShape = (scope: Scope) =>
  scope === 'task'
    ? { workspace: workspaceRef, task_id: taskId }
    : scope === 'workspace'
      ? { workspace: workspaceRef, task_id: taskId.optional() }
      : { workspace: workspaceRef.optional(), task_id: taskId.optional() }

const seq = z.number().int().min(1).meta({ description: '账本序号，单调递增' })

function variants(withSeq: boolean) {
  return EVENT_TYPES.map((type) =>
    z
      .strictObject({
        ...(withSeq ? { seq, ts: timestamp } : {}),
        type: z.literal(type),
        ...scopeShape(EVENT_SCOPES[type]),
        actor,
        payload: eventPayloads[type],
      })
      .meta({ title: type }),
  )
}

const eventVariants = variants(true)
const draftVariants = variants(false)

/** 已写入账本的事件（SSE 每条消息的 data 也是它）。 */
export const ledgerEvent = z
  .discriminatedUnion(
    'type',
    eventVariants as unknown as [
      (typeof eventVariants)[number],
      ...(typeof eventVariants)[number][],
    ],
  )
  .meta({ title: 'Raindown ledger event', description: '账本事件；按 type 区分载荷' })

/** 待写入的事件：没有 seq 与 ts，由中枢写入时分配。 */
export const ledgerEventDraft = z
  .discriminatedUnion(
    'type',
    draftVariants as unknown as [
      (typeof draftVariants)[number],
      ...(typeof draftVariants)[number][],
    ],
  )
  .meta({ title: 'Raindown ledger event draft' })

/** 单个类型的事件 schema（含信封），用于导出 `schemas/events/<type>.schema.json`。 */
export const eventSchemas = Object.fromEntries(
  EVENT_TYPES.map((t, i) => [t, eventVariants[i] as z.ZodType]),
) as Record<EventType, z.ZodType>

interface Envelope<T extends EventType> {
  seq: number
  ts: string
  type: T
  workspace?: string
  task_id?: string
  actor: string
  payload: EventPayload<T>
}

/** 账本事件（按 type 收窄载荷）。 */
export type LedgerEvent = { [T in EventType]: Envelope<T> }[EventType]
export type LedgerEventDraft = {
  [T in EventType]: Omit<Envelope<T>, 'seq' | 'ts'>
}[EventType]
export type EventOf<T extends EventType> = Extract<LedgerEvent, { type: T }>

// ---------------------------------------------------------------------------
// 事件触发的状态转换
// ---------------------------------------------------------------------------

/** `unchanged`：事件合法但不改变状态（例如 lease.granted、task.cancel_requested）。 */
export interface TransitionRule {
  /** 允许的当前状态；`null` 表示任务尚不存在。 */
  from: readonly (TaskStatus | null)[]
  to: TaskStatus | 'unchanged'
}

/** 每种任务事件的转换规则；`apply(event)` 与写入前的校验都以此为准。 */
export const TASK_EVENT_RULES: Readonly<
  Record<
    Exclude<
      EventType,
      | `node.${string}`
      | `hub.${string}`
      | `inbox.${string}`
      | `user.${string}`
      | `channel.${string}`
      | `task_proposal.${string}`
      | `decision.${string}`
      | `merge_request.${string}`
      | `pr.${string}`
      | 'policy.changed'
      | 'supervisor.answered'
      | 'supervisor.release'
      | 'supervisor.queue_dropped'
      | 'supervisor.scheduler_initialized'
      | 'supervisor.observed_action'
      | 'task.reply_observed'
      | 'schedule.fired'
    >,
    TransitionRule
  >
> = {
  'policy.decided': {
    from: ['queued', 'running', 'verifying', 'blocked', 'done', 'failed', 'cancelled'],
    to: 'unchanged',
  },
  'task.created': { from: [null], to: 'queued' },
  'task.policy_changed': { from: ['running', 'verifying', 'blocked'], to: 'unchanged' },
  'task.started': { from: ['queued'], to: 'running' },
  'task.attempt_ended': {
    from: ['queued', 'running', 'verifying', 'blocked', 'done', 'failed', 'cancelled'],
    to: 'unchanged',
  },
  'lease.granted': { from: ['running'], to: 'unchanged' },
  'task.verifying': { from: ['running'], to: 'verifying' },
  'task.done': { from: ['running', 'verifying', 'blocked'], to: 'done' },
  'task.failed': { from: ['running', 'verifying', 'blocked'], to: 'failed' },
  // blocked → blocked：只用于"本轮结束"（lease_held=false），例如卡住期间 worker 崩溃、节点掉线（D7a）。
  'task.reported': { from: ['running'], to: 'unchanged' },
  'task.report_consumed': { from: ['running', 'verifying', 'blocked'], to: 'unchanged' },
  'task.report_conflict': { from: ['running', 'verifying', 'blocked'], to: 'unchanged' },
  // queued → blocked：只由中枢写入，`isolation: required` 的任务没有可用的已隔离节点（worker-credential-isolation 6.1），不带租约。
  'task.blocked': { from: ['queued', 'running', 'verifying', 'blocked'], to: 'blocked' },
  'task.out_of_band': {
    from: ['queued', 'running', 'verifying', 'blocked', 'done', 'failed', 'cancelled'],
    to: 'unchanged',
  },
  'task.reply_dropped': {
    from: ['queued', 'running', 'verifying', 'blocked', 'done', 'failed', 'cancelled'],
    to: 'unchanged',
  },
  'task.unblocked': { from: ['blocked'], to: 'running' },
  'task.replied': { from: ['blocked'], to: 'unchanged' },
  'task.reply_fetched': { from: ['blocked'], to: 'unchanged' },
  'task.requeued_with_reply': { from: ['blocked'], to: 'queued' },
  'task.requeued': { from: ['blocked', 'running', 'verifying', 'failed', 'done'], to: 'queued' },
  // blocked：交互式执行器卡住期间仍持有租约（D7a），可以请求取消、租约也可能过期。
  'task.cancel_requested': { from: ['running', 'verifying', 'blocked'], to: 'unchanged' },
  'task.cancelled': { from: ['queued', 'running', 'verifying', 'blocked'], to: 'cancelled' },
  'task.lease_expired': { from: ['running', 'verifying', 'blocked'], to: 'unchanged' },
  // 代回复委托与转交只发生在卡住期间（D15）。
  'task.reply_delegated': { from: ['blocked'], to: 'unchanged' },
  'task.reply_escalated': { from: ['blocked'], to: 'unchanged' },
  // PR 直通的输入（harness-neutral 8.4）：已取消的任务不再接收；已结束的任务只在同一事务紧接着恢复时接收。
  'task.input_added': {
    from: ['queued', 'running', 'verifying', 'blocked', 'done', 'failed'],
    to: 'unchanged',
  },
  'task.input_delivered': { from: ['running', 'verifying', 'blocked'], to: 'unchanged' },
  // codex-orca 开始执行后上报一次（持有活动租约，见 store 的校验）。
  'task.branch_reported': { from: ['running', 'verifying', 'blocked'], to: 'unchanged' },
  // 唤醒任务创建后立即写入（同一事务或紧随其后），此时任务仍在排队。
  'supervisor.wake_started': { from: ['queued'], to: 'unchanged' },
}

export const isTaskEventType = (type: EventType): type is keyof typeof TASK_EVENT_RULES =>
  type in TASK_EVENT_RULES

/**
 * 检查一个事件能否作用于处于 `current` 状态的任务（`null` 表示任务不存在），
 * 返回事件之后的状态。不合法时返回 `invalid_transition`，此时不得写入事件。
 * 非任务事件（node.*、hub.*、schedule.fired）原样返回 `current`。
 */
export function checkTaskEvent(
  current: TaskStatus | null,
  event: Pick<LedgerEventDraft, 'type' | 'payload'>,
): Result<TaskStatus | null> {
  if (!isTaskEventType(event.type)) return ok(current)
  const rule = TASK_EVENT_RULES[event.type]
  const reject = (why: string) =>
    fail('failure', 'invalid_transition', `任务状态为 ${current ?? '（不存在）'}，${why}`, {
      from: current,
      type: event.type,
    })
  if (!rule.from.includes(current)) return reject(`不能接受 ${event.type}`)
  if (event.type === 'task.done' && current === 'blocked') {
    const result = (event.payload as EventPayload<'task.done'>).result
    if (result.completed_via !== 'existing_pr' || !result.prs?.length) {
      return reject('卡住的任务只能依据已存在的 PR 判定完成')
    }
  }
  if (event.type === 'task.blocked' && current === 'blocked') {
    const held = (event.payload as { lease_held?: boolean }).lease_held === true
    if (held) return reject('已卡住的任务只能以 lease_held=false 再次上报 task.blocked（本轮结束）')
    return ok('blocked')
  }
  if (event.type === 'task.requeued' && current !== null) {
    const reason = (event.payload as EventPayload<'task.requeued'>).reason
    // done 只能因名单内用户的 PR 评论恢复（input）；failed 可手动重试或因评论恢复。
    const expected =
      current === 'done'
        ? ['input']
        : current === 'failed'
          ? ['manual', 'input']
          : current === 'blocked'
            ? ['manual']
            : ['lease_expired']
    if (!expected.includes(reason)) {
      return reject(`task.requeued 的 reason 应为 ${expected.join(' 或 ')}`)
    }
  }
  const to = rule.to === 'unchanged' ? current : rule.to
  if (to !== null && current !== null && to !== current && !canTransition(current, to)) {
    return reject(`不能转换到 ${to}`)
  }
  return ok(to)
}

/** 校验并收窄一个事件；失败时返回 `invalid_event` 与 zod issues。 */
export function parseLedgerEvent(raw: unknown): Result<LedgerEvent> {
  const parsed = ledgerEvent.safeParse(raw)
  return parsed.success
    ? ok(parsed.data as LedgerEvent)
    : fail('failure', 'invalid_event', z.prettifyError(parsed.error), parsed.error.issues)
}

/** 校验并收窄一个待写入事件。 */
export function parseLedgerEventDraft(raw: unknown): Result<LedgerEventDraft> {
  const parsed = ledgerEventDraft.safeParse(raw)
  return parsed.success
    ? ok(parsed.data as LedgerEventDraft)
    : fail('failure', 'invalid_event', z.prettifyError(parsed.error), parsed.error.issues)
}
