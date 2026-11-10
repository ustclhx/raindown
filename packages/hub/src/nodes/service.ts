import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type AckReplyData,
  type AcquireLeaseData,
  ackReplyRequest,
  acquireLeaseRequest,
  type BlockedRequest,
  type CompleteLeaseData,
  type CompleteLeaseRequest,
  capabilitiesSatisfy,
  clipDiffStat,
  clipText,
  completeLeaseRequest,
  type DeliveredInput,
  fail,
  INBOX_BODY_MAX,
  INBOX_TITLE_MAX,
  type IsolationNoticeData,
  isolationNoticeRequest,
  isSqliteBusy,
  type LeaseGrant,
  type LeaseSlots,
  type LedgerEvent,
  leaseSlotFor,
  type NodeView,
  normalizeProbeReport,
  ok,
  probeRegressions,
  probeRunSummary,
  type RegisterNodeRequest,
  type RenewLeaseData,
  type RenewLeaseRequest,
  type ReplyView,
  type ReportQuestion,
  type Result,
  registerNodeRequest,
  renderPrEventInput,
  renewLeaseRequest,
  SUPERVISOR_ACTOR,
  sanitizeMessage,
  sanitizeTail,
  stripUntrustedReview,
  type TaskView,
  type WakeOrigin,
} from '@raindown/core'
import type { z } from 'zod'
import type { EventInput, LeaseRecord, LedgerStore } from '../ledger/store.ts'
import { fieldIssues } from '../ledger/tasks.ts'
import { type HubClock, systemClock } from '../server/clock.ts'
import type { HubLogger } from '../server/maintenance.ts'
import { recoveryForTask } from './recovery.ts'

/**
 * 节点协议的中枢侧（tasks.md 4.1；node-protocol spec；design D4）。
 *
 * - 注册：写 `node.registered`，刷新 `last_seen_at`。
 * - 领取：同步代码里"选出第一个满足能力的 queued 任务 → 同一事务写 `task.started` + `lease.granted`"。
 *   JS 单线程、SQLite 同步 API，选择与写入之间没有 await，两个请求不会交错；即便交错，
 *   store 的校验（task.started 只接受 queued、lease.granted 拒绝第二个活动租约）也会让后者失败，
 *   这里遇到 invalid_transition 时换下一个任务重试。
 * - 执行槽（add-m1-supervisor D12）：请求带 `slots` 时只分配有可用空位的任务——普通任务只用
 *   general，普通唤醒可用 supervisor 或 general，reply 唤醒可用 reply 或 general；
 *   唤醒身份以账本 `supervisor.wake_started` 为准（`leaseSlotFor`）。不带 `slots` 的请求
 *   （旧节点、新节点的普通循环）只有普通空位；唤醒要分给普通空位前，先交给同一节点正在等待、
 *   类别匹配的预留槽领取，避免挤占普通槽。
 * - 无可领取任务时挂入内存等待队列（不进投影），`task.created` / `task.requeued` 到来时唤醒。
 * - 续约 / 提交校验租约令牌（账本只存 SHA-256）；租约已不是 active（过期或已被处理）时返回
 *   `lease_expired`。
 * - 过期扫描：按合同 retry 决定 `task.requeued(lease_expired)` 或 `task.blocked(node_lost)`，
 *   同一事务先写 `task.lease_expired`。
 *
 * 交互式执行器 blocked 期间持有租约（add-m1-executors D7a）：
 * - 续约可以带 `blocked`（写 `task.blocked`，lease_held=true，租约不释放）或 `resumed`（写 `task.unblocked`）；
 * - blocked 任务的续约响应带上最早一条待送达的回复；节点送达后调用 ack-reply，中枢在同一事务中
 *   写 `task.unblocked`（带 reply_id）并把回复标记为已送达；worker 已不在时写 `task.requeued_with_reply`；
 * - 持有租约的 blocked 任务租约过期：记 `task.lease_expired`，有待送达回复时同一事务带着回复重新排队，
 *   已请求取消时直接取消，否则保持 blocked（之后的回复会让它重新排队）。
 */

export interface NodeProtocolConfig {
  /** 租约有效期秒数（hub.yaml lease_ttl_s）。 */
  leaseTtlS: number
  /** long-poll 最长等待秒数（hub.yaml lease_wait_max_s）。 */
  leaseWaitMaxS: number
}

/** 每个任务最多记录的 mds 重置通知（worker-credential-isolation 4.5，审查第二轮）。 */
export const MDS_RESET_NOTICE_LIMIT = 50
const mdsResetCount = (events: readonly LedgerEvent[]) =>
  events.filter((e) => e.type === 'task.out_of_band' && e.payload.kind === 'mds_reset').length

export interface NodeServiceOptions extends NodeProtocolConfig {
  ledger: LedgerStore
  clock?: HubClock
  newLeaseId?: () => string
  newLeaseToken?: () => string
  /**
   * 唤醒绑定 token 的签发（add-m1-supervisor D6）：领到 supervisor 唤醒任务时调用，返回值随租约下发
   * （`wake_token`）；不是唤醒任务时返回 undefined。缺省不签发。
   */
  issueWakeToken?: (grant: { lease_id: string; task_id: string }) => string | undefined
  issueTaskToken?: (grant: { lease_id: string; task_id: string }) => string | undefined
  /** 中枢重启等导致派工凭证记录丢失时，在续约响应补发。 */
  renewTaskToken?: (grant: {
    lease_id: string
    task_id: string
    dispatch_token_sha256?: string
  }) => string | undefined
  /** 不影响请求结果的失败（例如任务分支上报写入失败）只记日志。 */
  logger?: Pick<HubLogger, 'warn'>
}

export interface AcquireOptions {
  /** 请求方断开或中枢停止时中止等待。 */
  signal?: AbortSignal
  /**
   * 调用方身份（鉴权中间件认定）。唤醒绑定 token 只在调用方是 `user`（本机节点用 user token）或
   * `node:<body.node_id>` 时随租约下发；缺省或其他身份不下发（D6）。
   */
  actor?: string
}

export interface NodeService {
  registerNode(body: unknown, actor: string): Result<{ node: NodeView }>
  listNodes(): Result<{ nodes: NodeView[] }>
  acquire(body: unknown, opts?: AcquireOptions): Promise<Result<AcquireLeaseData>>
  renew(leaseId: string, body: unknown): Result<RenewLeaseData>
  complete(leaseId: string, body: unknown): Result<CompleteLeaseData>
  ackReply(leaseId: string, body: unknown): Result<AckReplyData>
  /** 节点上报隔离事实（mds 重置，worker-credential-isolation 4.5），不依赖活动租约。 */
  isolationNotice(nodeId: string, body: unknown): Result<IsolationNoticeData>
  /**
   * 处理全部已到期的活动租约，返回处理的数量。`graceMs`：中枢自身最近被卡住（事件循环得不到调度）的
   * 时长，到期不足这么久的租约这一轮先不处理——卡住期间节点的续约可能正排在后面等待处理。
   */
  expireDue(opts?: { graceMs?: number }): number
  /** 当前挂起的 long-poll 数（测试与诊断）。 */
  waiting(): number
  /** 结束全部等待（返回空结果）并取消订阅。 */
  close(): void
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** `task.unblocked` 的说明：回复者与回复摘要。 */
function replyNote(reply: ReplyView): string {
  const what = reply.kind === 'approve' ? '批准' : reply.kind === 'deny' ? '拒绝' : '回复'
  const text = reply.text
    ? `：${reply.text.length > 200 ? `${reply.text.slice(0, 200)}…` : reply.text}`
    : ''
  return `${reply.by} ${what}${text}`
}

function tokenMatches(token: string, expectedHex: string): boolean {
  const a = Buffer.from(sha256(token), 'hex')
  const b = Buffer.from(expectedHex, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

const defaultLeaseId = () => `l-${randomBytes(8).toString('hex')}`
const defaultLeaseToken = () => randomBytes(32).toString('base64url')

function parse<S extends z.ZodType>(schema: S, body: unknown, what: string): Result<z.infer<S>> {
  const parsed = schema.safeParse(body)
  if (parsed.success) return ok(parsed.data as z.infer<S>)
  const fields = fieldIssues(parsed.error.issues, body)
  return fail(
    'usage',
    'invalid_arguments',
    `${what}不合法：${fields.map((f) => f.message).join('；')}`,
    fields,
  )
}

/** 持有活动租约时允许续约的任务状态；blocked 且租约仍是 active 即 lease_held（D7a）。 */
const RENEWABLE: ReadonlySet<TaskView['status']> = new Set(['running', 'verifying', 'blocked'])

/** 唤醒等待者的事件：有任务可能变为 queued。 */
const WAKING: ReadonlySet<LedgerEvent['type']> = new Set([
  'task.created',
  'task.requeued',
  'hub.rebuilt',
])

/**
 * 卡住上报中与代回复相关的可选字段（D15）：原样带入 `task.blocked`；旧节点不带时省略。
 * `diff_stat` 是自由文本，入账前由 scrub 脱敏。
 */
function delegationFields(b: {
  decision_id?: number | undefined
  request?: BlockedRequest | undefined
  diff_stat?: string | undefined
  no_delegate?: boolean | undefined
  basis?: 'reported' | 'inferred' | undefined
  question?: ReportQuestion | undefined
  missing?: string | undefined
  tried?: string | undefined
}) {
  return {
    basis: b.basis ?? 'inferred',
    ...(b.question ? { question: b.question } : {}),
    ...(b.missing ? { missing: b.missing } : {}),
    ...(b.tried ? { tried: b.tried } : {}),
    ...(b.decision_id !== undefined ? { decision_id: b.decision_id } : {}),
    ...(b.request !== undefined ? { request: b.request } : {}),
    // 协议允许 8192 字符，入账前截到 2000（clipDiffStat，与 scrub 的 clipText 同一截断标记）。
    ...(b.diff_stat !== undefined ? { diff_stat: clipDiffStat(b.diff_stat) } : {}),
    ...(b.no_delegate !== undefined ? { no_delegate: b.no_delegate } : {}),
  }
}

/**
 * 提交结束对应的事件（纯函数）。
 * 不可能是审查结论的 `result.review`（合同没有 inputs.review 或执行器不是 claude-sdk）不入账（D10）。
 * 任务已处于 blocked（交互式卡住期间 worker 崩溃或这一轮直接以 blocked 结束）时，
 * 写 blocked → blocked（lease_held=false）；此时若有待送达的回复，同一事务带着回复重新排队，
 * 回复不会被静默丢弃（PR #16 审查第 5 条）。末尾输出与说明入账前脱敏、限长（第 7 条）。
 */
export function completionDrafts(
  task: TaskView,
  lease: LeaseRecord,
  req: CompleteLeaseRequest,
  pendingReply: ReplyView | null = null,
  lastReport?: string,
): EventInput[] {
  const base = { task_id: task.id, workspace: task.workspace }
  const ended = (reason: 'done' | 'failed' | 'blocked' | 'cancelled'): EventInput => ({
    ...base,
    type: 'task.attempt_ended',
    payload: { attempt: lease.attempt, reason, ...(lastReport ? { last_report: lastReport } : {}) },
  })
  switch (req.outcome) {
    case 'done':
      return [
        {
          ...base,
          type: 'task.done',
          payload: { result: stripUntrustedReview(task.contract, req.result, 'done') },
        },
        ended('done'),
      ]
    case 'failed':
      return [
        {
          ...base,
          type: 'task.failed',
          payload: { result: stripUntrustedReview(task.contract, req.result, 'failed') },
        },
        ended('failed'),
      ]
    case 'blocked': {
      const session = req.session ?? task.blocked?.session
      const blocked: EventInput = {
        ...base,
        type: 'task.blocked',
        payload: {
          reason: req.blocked_reason,
          message: sanitizeMessage(req.message),
          ...(req.tail ? { tail: sanitizeTail(req.tail) } : {}),
          ...(session ? { session } : {}),
          ...delegationFields(req),
          node_id: lease.node_id,
          lease_held: false,
        },
      }
      // 已请求取消：不论有没有回复，都以 cancelled 结束，不让重新排队覆盖取消（复核第 2 条）。
      if (task.cancel_requested) {
        return [
          {
            ...base,
            type: 'task.cancelled',
            payload: {
              reason: sanitizeMessage(`已请求取消；worker 结束：${req.message}`),
              node_id: lease.node_id,
            },
          },
          ended('cancelled'),
        ]
      }
      if (task.status === 'blocked' && pendingReply) {
        return [
          blocked,
          ended('blocked'),
          {
            ...base,
            type: 'task.requeued_with_reply',
            payload: { reply_id: pendingReply.id, ...(session ? { session } : {}) },
          },
        ]
      }
      return [blocked, ended('blocked')]
    }
    case 'cancelled':
      return [
        {
          ...base,
          type: 'task.cancelled',
          payload: {
            ...(req.message ? { reason: req.message } : {}),
            ...(req.result
              ? { result: stripUntrustedReview(task.contract, req.result, 'cancelled') }
              : {}),
            node_id: lease.node_id,
          },
        },
        ended('cancelled'),
      ]
  }
}

/**
 * 租约过期对应的事件（纯函数；node-protocol "租约过期处理"）。
 * blocked（lease_held）任务的过期见文件头；`pendingReply` 为该任务待送达的回复。
 */
export function expiryDrafts(
  task: TaskView,
  lease: LeaseRecord,
  pendingReply: ReplyView | null = null,
): EventInput[] {
  const base = { task_id: task.id, workspace: task.workspace }
  const ended = (reason: 'lease_expired' | 'node_lost' | 'cancelled'): EventInput => ({
    ...base,
    type: 'task.attempt_ended',
    payload: { attempt: lease.attempt, reason },
  })
  const expired: EventInput = {
    ...base,
    type: 'task.lease_expired',
    payload: {
      lease_id: lease.lease_id,
      node_id: lease.node_id,
      expired_at: lease.expires_at,
      attempt: lease.attempt,
    },
  }
  // 已请求取消：无论 running / verifying / blocked，租约过期一律取消，不重新排队、不转 node_lost
  // （与 completionDrafts、ackReply 中"不让重新排队覆盖取消"一致）。节点没有确认，worker 可能仍在运行。
  if (task.cancel_requested) {
    return [
      expired,
      ended('cancelled'),
      {
        ...base,
        type: 'task.cancelled',
        payload: {
          reason: `已请求取消；节点 ${lease.node_id} 的租约过期，未确认 worker 已停止`,
          node_id: lease.node_id,
        },
      },
    ]
  }
  if (task.status === 'blocked') {
    if (pendingReply) {
      const session = task.blocked?.session
      return [
        expired,
        ended('lease_expired'),
        {
          ...base,
          type: 'task.requeued_with_reply',
          payload: { reply_id: pendingReply.id, ...(session ? { session } : {}) },
        },
      ]
    }
    // 没有待送达的回复：转为 blocked(node_lost)，让用户看到节点已掉线、worker 已不在。
    // 不按 retry 自动重新排队：任务正在等人答复，自动重跑会丢掉这个问题（PR #16 审查第 4 条）。
    // 原来的卡住原因与说明保留在 message 里，之后的文字回复会让任务带着回复重新排队。
    const was = task.blocked
    const session = was?.session
    return [
      expired,
      ended('node_lost'),
      {
        ...base,
        type: 'task.blocked',
        payload: {
          reason: 'node_lost',
          message: sanitizeMessage(
            `节点 ${lease.node_id} 在等待回复期间掉线（租约 ${lease.expires_at} 过期）` +
              (was ? `；原卡住原因：${was.reason} — ${was.message}` : ''),
          ),
          ...(was?.tail ? { tail: was.tail } : {}),
          ...(session ? { session } : {}),
          ...(was ? { prior_reason: was.prior_reason ?? was.reason } : {}),
          node_id: lease.node_id,
          lease_held: false,
        },
      },
    ]
  }
  const maxAttempts = task.contract.retry?.max_attempts ?? 1
  if (task.attempt < maxAttempts) {
    return [
      expired,
      ended('lease_expired'),
      {
        ...base,
        type: 'task.requeued',
        payload: {
          reason: 'lease_expired',
          note: `节点 ${lease.node_id} 的租约过期，第 ${task.attempt}/${maxAttempts} 次尝试后重新排队`,
        },
      },
    ]
  }
  return [
    expired,
    ended('node_lost'),
    {
      ...base,
      type: 'task.blocked',
      payload: {
        reason: 'node_lost',
        message: `节点 ${lease.node_id} 的租约在 ${lease.expires_at} 过期，未续约`,
        node_id: lease.node_id,
      },
    },
  ]
}

interface Waiter {
  nodeId: string
  capabilities: string[]
  slots: LeaseSlots | undefined
  resolve(grant: LeaseGrant | null): void
}

export function createNodeService(o: NodeServiceOptions): NodeService {
  const { ledger } = o
  const clock = o.clock ?? systemClock
  const newLeaseId = o.newLeaseId ?? defaultLeaseId
  const newLeaseToken = o.newLeaseToken ?? defaultLeaseToken
  const iso = (ms = clock.now()) => new Date(ms).toISOString()
  const waiters: Waiter[] = []
  let draining = false
  let closed = false

  /** 回复绑定到写入 task.replied 之前的卡住，不能借用之后出现的新回合。 */
  function replyBinding(taskId: string, replyId: string) {
    return ledger.replyBlock(taskId, replyId)
  }

  /** 渲染待送达的输入（PR 直通，harness-neutral 8.4）：内容一律经 core 模板包裹与转义。 */
  function pendingInputs(taskId: string, limit: number): DeliveredInput[] {
    return ledger.pendingTaskInputs(taskId, limit).flatMap((input) => {
      const event = ledger.prEvent(input.pr_event_seq)
      return event
        ? [
            {
              input_seq: input.seq,
              source: 'pr' as const,
              pr_event_seq: input.pr_event_seq,
              text: renderPrEventInput(event),
            },
          ]
        : []
    })
  }

  const executorOf = (nodeId: string, task: TaskView) =>
    ledger.getNode(nodeId)?.executors.find((e) => e.type === task.contract.executor)

  /** 节点为该任务注册的执行器能否在运行中注入输入；不能时输入排队到下一次派工。 */
  function injectsWhileRunning(nodeId: string, task: TaskView): boolean {
    return executorOf(nodeId, task)?.adapter_capabilities.inject_while_running === true
  }

  /** 节点是否声明会处理派工的 inputs 并确认；旧节点不下发，输入保持待送达。 */
  function acceptsDispatchInputs(nodeId: string, task: TaskView): boolean {
    return executorOf(nodeId, task)?.task_inputs === true
  }

  /** 恢复回复只属于紧接该次重新排队的派工，不能跨过其他派工或手动重新排队。 */
  function isLeaseResumeReply(taskId: string, leaseId: string, replyId: string): boolean {
    const events = ledger.taskEvents(taskId)
    const started = events.findIndex(
      (event) => event.type === 'task.started' && event.payload.lease_id === leaseId,
    )
    for (let i = started - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'task.requeued_with_reply') return event.payload.reply_id === replyId
      if (event?.type === 'task.started' || event?.type === 'task.requeued') return false
    }
    return false
  }

  /** 在同一事务写 `task.started` + `lease.granted`；被其他请求抢先时返回 null。 */
  function grantTask(task: TaskView, nodeId: string): LeaseGrant | null {
    // resume 只交给紧接着的这一次执行：task.started 会在投影里清空它（PR #16 审查第 1 条）。
    const resume = ledger.taskResume(task.id)
    const recovery = recoveryForTask(ledger, task)
    // 尚未送达的输入随这次派工下发；节点在执行器拿到它们后经续约确认（inputs_dispatched）才记为送达。
    const inputs = acceptsDispatchInputs(nodeId, task) ? pendingInputs(task.id, 200) : []
    const leaseId = newLeaseId()
    const token = newLeaseToken()
    const attempt = task.attempt + 1
    const ttl = o.leaseTtlS
    const expiresAt = iso(clock.now() + ttl * 1000)
    const base = { task_id: task.id, workspace: task.workspace }
    const written = ledger.appendMany(
      [
        {
          ...base,
          type: 'task.started',
          payload: { node_id: nodeId, lease_id: leaseId, attempt },
        },
        {
          ...base,
          type: 'lease.granted',
          payload: {
            lease_id: leaseId,
            node_id: nodeId,
            token_sha256: sha256(token),
            ttl_s: ttl,
            expires_at: expiresAt,
          },
        },
      ],
      { actor: `node:${nodeId}` },
    )
    // 被其他请求抢先（理论上不会发生，见文件头）。
    if (!written.ok) return null
    ledger.touchNode(nodeId)
    return {
      lease_id: leaseId,
      lease_token: token,
      task_id: task.id,
      workspace: task.workspace,
      contract: task.contract,
      attempt,
      ttl_s: ttl,
      expires_at: expiresAt,
      ...(recovery ? { recovery } : {}),
      ...(inputs.length ? { inputs } : {}),
      ...(resume
        ? {
            resume: {
              ...resume,
              reply: { ...resume.reply, ...replyBinding(task.id, resume.reply.reply_id) },
            },
          }
        : {}),
      // 投影中固定的登记仓库快照（D15）：节点据此检查，不再重新采集。
      ...(task.repo_snapshot ? { repo_snapshot: task.repo_snapshot } : {}),
    }
  }

  /**
   * 同一节点上正在等待、能用预留槽（supervisor / reply）接这个唤醒的等待者（D12）。
   * 唤醒落到普通空位之前先交给它，避免挤占普通槽。
   */
  function reservedWaiterFor(
    task: TaskView,
    wake: WakeOrigin | null,
    nodeId: string,
    self: Waiter | undefined,
  ): Waiter | undefined {
    if (wake === null) return undefined
    return waiters.find((w) => {
      if (w === self || w.nodeId !== nodeId || !w.slots) return false
      if (!capabilitiesSatisfy(w.capabilities, task.contract)) return false
      const slot = leaseSlotFor(w.slots, wake)
      return slot === 'supervisor' || slot === 'reply'
    })
  }

  /**
   * 选出并分配第一个可领取的 queued 任务；没有时返回 null。全程同步。
   * - `slots` 只有预留空位时，按 `leaseSlotFor` 过滤（需要查唤醒身份）；
   * - 有普通空位（含旧节点不带 `slots`）时任何任务都可以接，只在同一节点另有预留槽等待者时
   *   才查唤醒身份：唤醒先交给那个等待者，本请求继续找下一个任务。
   */
  function tryGrant(
    nodeId: string,
    capabilities: readonly string[],
    slots: LeaseSlots | undefined,
    self?: Waiter,
  ): LeaseGrant | null {
    const general = !slots || slots.general > 0
    for (const task of ledger.queuedTasks()) {
      if (!capabilitiesSatisfy(capabilities, task.contract)) continue
      const hasReservedWaiter = waiters.some((w) => w !== self && w.nodeId === nodeId && w.slots)
      if (general && !hasReservedWaiter) {
        const grant = grantTask(task, nodeId)
        if (grant) return grant
        continue
      }
      const wake = ledger.wakeOrigin(task.id)
      const slot = leaseSlotFor(slots, wake)
      if (slot === null) continue
      if (slot === 'general') {
        const other = reservedWaiterFor(task, wake, nodeId, self)
        if (other) {
          const grant = grantTask(task, nodeId)
          if (grant) other.resolve(grant)
          continue
        }
      }
      const grant = grantTask(task, nodeId)
      if (grant) return grant
    }
    return null
  }

  /** 按先来后到给等待者分配任务。推迟到微任务执行，避免在账本通知回调里重入写入。 */
  function scheduleDrain() {
    if (draining || waiters.length === 0) return
    draining = true
    queueMicrotask(() => {
      draining = false
      if (closed) return
      for (const w of [...waiters]) {
        // 可能已在本轮中作为预留槽等待者被分配（见 tryGrant）。
        if (!waiters.includes(w)) continue
        const grant = tryGrant(w.nodeId, w.capabilities, w.slots, w)
        if (grant) w.resolve(grant)
      }
    })
  }

  const unsubscribe = ledger.subscribe((event) => {
    if (WAKING.has(event.type)) scheduleDrain()
  })

  /** 令牌与租约状态校验。顺序：租约不存在 → 令牌不符 → 租约已结束。 */
  function authorize(
    leaseId: string,
    token: string,
  ): Result<{ lease: LeaseRecord; task: TaskView }> {
    const lease = ledger.getLease(leaseId)
    if (!lease) return fail('failure', 'lease_not_found', `没有租约 ${leaseId}`)
    if (!tokenMatches(token, lease.token_sha256)) {
      return fail('failure', 'invalid_lease_token', '租约令牌不正确')
    }
    const task = ledger.getTask(lease.task_id)
    if (lease.state !== 'active' || !task) {
      return fail(
        'failure',
        'lease_expired',
        `租约 ${leaseId} 已${lease.state === 'expired' ? '过期' : '结束'}，任务状态为 ${task?.status ?? '未知'}`,
        { lease_state: lease.state, task_status: task?.status ?? null },
      )
    }
    return ok({ lease, task })
  }

  /**
   * 隔离自检从通过变为不通过时写一条 Digest 收件箱条目（worker-credential-isolation 3.2；design Open Question 先取 Digest）。
   * 只比较同一执行器 × 沙箱设置的上一次与这一次结果；未探测或一直不通过不写，同一结果重复上报不重复写。
   * 条目只列项名与路径，不含任何文件内容。写入失败只记日志，不影响注册。
   */
  function notifyProbeRegression(
    nodeId: string,
    seq: number,
    previous: NodeView['isolation_probe'],
    next: RegisterNodeRequest['isolation_probe'],
  ) {
    const regressed = probeRegressions(previous, next ?? null)
    if (regressed.length === 0) return
    const lines = [`节点 ${nodeId} 的隔离自检从通过变为不通过（${next?.ran_at ?? '—'}）`]
    for (const run of regressed) {
      lines.push(`${run.executor} × ${run.setting}（声明 ${run.declared_layer}）：`)
      if (run.error) lines.push(`  无法运行：${run.error.code} ${run.error.message}`)
      for (const f of probeRunSummary(run).failed) lines.push(`  失败 ${f}`)
    }
    lines.push('运行 raindown doctor 查看详情')
    const r = ledger.append(
      {
        type: 'inbox.item_created',
        payload: {
          item_id: `iso.${seq}`,
          level: 'digest',
          source: 'isolation',
          source_ref: nodeId,
          reason: 'probe_failed',
          title: clipText(`节点 ${nodeId} 隔离自检不通过`, INBOX_TITLE_MAX),
          body: clipText(lines.join('\n'), INBOX_BODY_MAX),
          actions: [],
        },
      },
      { actor: 'hub' },
    )
    if (!r.ok && r.error.code !== 'duplicate_item')
      o.logger?.warn('隔离自检通知写入失败', r.error.code)
  }

  const notRegistered = (nodeId: string) =>
    fail('failure', 'node_not_registered', `节点 ${nodeId} 尚未注册`, { node_id: nodeId })

  return {
    registerNode(body, actor) {
      const req = parse(registerNodeRequest, body, '节点注册请求')
      if (!req.ok) return req
      const previousProbe = ledger.getNode(req.data.node_id)?.isolation_probe ?? null
      // 节点上报的 ok / passed 不可信：写入前由中枢按预期与实际重新计算。
      const payload = req.data.isolation_probe
        ? { ...req.data, isolation_probe: normalizeProbeReport(req.data.isolation_probe) }
        : req.data
      const written = ledger.append(
        { type: 'node.registered', payload },
        // 未声明身份（unknown）或用 user token 未降级（user）时，记为该节点。
        { actor: actor === 'unknown' || actor === 'user' ? `node:${req.data.node_id}` : actor },
      )
      if (!written.ok) return written
      notifyProbeRegression(
        req.data.node_id,
        written.data.seq,
        previousProbe,
        payload.isolation_probe,
      )
      ledger.touchNode(req.data.node_id)
      const node = ledger.getNode(req.data.node_id)
      return node ? ok({ node }) : fail('failure', 'internal_error', '节点写入后不可见')
    },

    isolationNotice(nodeId, body) {
      const req = parse(isolationNoticeRequest, body, '隔离事实上报')
      if (!req.ok) return req
      const task = ledger.getTask(req.data.task_id)
      // 只接受该节点曾经领取过租约的任务：节点不能给其他节点的任务写事件。
      const events = task ? ledger.taskEvents(task.id) : []
      const held = events.some((e) => e.type === 'lease.granted' && e.payload.node_id === nodeId)
      if (!task || !held)
        return fail(
          'failure',
          'scope_denied',
          `节点 ${nodeId} 没有领取过任务 ${req.data.task_id} 的租约`,
        )
      const signal = req.data.signal
      if (events.some((e) => e.type === 'task.out_of_band' && e.payload.id === signal.id))
        return ok({ recorded: false })
      // 每个任务最多记录 MDS_RESET_NOTICE_LIMIT 条（审查第二轮）：节点出错或被滥用时不会无限写事件与收件箱条目。
      if (mdsResetCount(events) >= MDS_RESET_NOTICE_LIMIT)
        return fail(
          'failure',
          'isolation_notice_limit',
          `任务 ${task.id} 的 mds 重置通知已达上限 ${MDS_RESET_NOTICE_LIMIT} 条，不再记录`,
        )
      const written = ledger.append(
        {
          task_id: task.id,
          workspace: task.workspace,
          type: 'task.out_of_band',
          payload: signal,
        },
        { actor: `node:${nodeId}` },
      )
      if (!written.ok) return written
      return ok({ recorded: true })
    },

    listNodes() {
      return ok({ nodes: ledger.listNodes() })
    },

    async acquire(body, opts = {}) {
      const req = parse(acquireLeaseRequest, body, '领取请求')
      if (!req.ok) return req
      const { node_id: nodeId, capabilities, slots } = req.data
      if (!ledger.touchNode(nodeId)) return notRegistered(nodeId)
      // 唤醒绑定 token 按这次请求的调用方决定是否下发（等待者可能领到为别的请求挑出的任务）。
      const mayIssue = opts.actor === 'user' || opts.actor === `node:${nodeId}`
      const withWakeToken = (g: LeaseGrant | null): LeaseGrant | null => {
        if (!g || !mayIssue) return g
        const wakeToken = o.issueWakeToken?.({ lease_id: g.lease_id, task_id: g.task_id })
        const taskToken = o.issueTaskToken?.({ lease_id: g.lease_id, task_id: g.task_id })
        return {
          ...g,
          ...(wakeToken === undefined ? {} : { wake_token: wakeToken }),
          ...(taskToken === undefined ? {} : { dispatch_token: taskToken }),
        }
      }
      const grant = tryGrant(nodeId, capabilities, slots)
      const waitMs = Math.min(req.data.wait_s, o.leaseWaitMaxS) * 1000
      if (grant || waitMs === 0 || closed || opts.signal?.aborted) {
        return ok({ lease: withWakeToken(grant) })
      }

      const lease = await new Promise<LeaseGrant | null>((resolve) => {
        let cancelTimer = () => {}
        const waiter: Waiter = {
          nodeId,
          capabilities,
          slots,
          resolve: (g) => {
            const i = waiters.indexOf(waiter)
            if (i >= 0) waiters.splice(i, 1)
            cancelTimer()
            opts.signal?.removeEventListener('abort', onAbort)
            resolve(g)
          },
        }
        const onAbort = () => waiter.resolve(null)
        waiters.push(waiter)
        cancelTimer = clock.setTimeout(() => waiter.resolve(null), waitMs)
        opts.signal?.addEventListener('abort', onAbort, { once: true })
      })
      ledger.touchNode(nodeId)
      return ok({ lease: withWakeToken(lease) })
    },

    renew(leaseId, body) {
      const req = parse(renewLeaseRequest, body, '续约请求')
      if (!req.ok) return req
      const auth = authorize(leaseId, req.data.lease_token)
      if (!auth.ok) return auth
      const { lease, task } = auth.data
      if (!RENEWABLE.has(task.status)) {
        return fail('failure', 'lease_expired', `任务状态为 ${task.status}，租约不能续约`)
      }
      const consumed = reportConsumption(task, lease, req.data.report_seq)
      if (!consumed.ok) return consumed
      const steps = renewSteps(task, lease, req.data, consumed.data)
      if (!steps.ok) return steps
      // 节点确认已交给执行器的输入（重复确认幂等：只记仍待送达的那些）。
      const pendingSeqs = () => new Set(ledger.pendingTaskInputs(task.id, 1000).map((i) => i.seq))
      for (const [via, list] of [
        ['dispatch', req.data.inputs_dispatched],
        ['running', req.data.inputs_delivered],
      ] as const) {
        if (!list?.length) continue
        const pending = pendingSeqs()
        const seqs = [...new Set(list)].filter((seq) => pending.has(seq))
        if (!seqs.length) continue
        const acked = ledger.append(
          {
            type: 'task.input_delivered',
            task_id: task.id,
            workspace: task.workspace,
            payload: { input_seqs: seqs, lease_id: lease.lease_id, via },
          },
          { actor: 'hub' },
        )
        if (!acked.ok) return acked
      }
      const expiresAt = iso(clock.now() + lease.ttl_s * 1000)
      ledger.renewLease(lease.lease_id, expiresAt)
      ledger.touchNode(lease.node_id)
      // 任务分支在续约生效之后写入：无论结果如何都不影响续约，结果随响应返回。
      const branchReport = req.data.branch
        ? reportBranch(ledger.getTask(task.id) ?? task, lease, req.data.branch)
        : undefined
      const after = ledger.getTask(task.id) ?? task
      // 已请求取消的任务不再送达回复。
      const pending =
        after.status === 'blocked' && !after.cancel_requested ? ledger.pendingReply(task.id) : null
      // 先提交交付事实再把回复交给节点；追加失败时不下发，重复续约不重复记录。
      if (pending && pending.fetched_at == null) {
        const fetched = ledger.append(
          {
            type: 'task.reply_fetched',
            task_id: task.id,
            workspace: task.workspace,
            payload: { reply_id: pending.id, lease_id: lease.lease_id },
          },
          { actor: 'hub' },
        )
        if (!fetched.ok) return fetched
      }
      const lastBlock = req.data.blocked
        ? ledger.latestTaskEvent(task.id, 'task.blocked')
        : undefined
      const reportedBlock =
        lastBlock?.type === 'task.blocked' &&
        lastBlock.payload.request_id === req.data.blocked?.request_id &&
        after.status === 'blocked'
          ? lastBlock
          : undefined
      // 先持久化回复交付事实，再补发凭证；记录失败的续约不能留下未送达的新凭证。
      const dispatchToken = o.renewTaskToken?.({
        lease_id: lease.lease_id,
        task_id: task.id,
        ...(req.data.dispatch_token_sha256
          ? { dispatch_token_sha256: req.data.dispatch_token_sha256 }
          : {}),
      })
      return ok({
        lease_id: lease.lease_id,
        expires_at: expiresAt,
        ...(dispatchToken ? { dispatch_token: dispatchToken } : {}),
        cancel_requested: after.cancel_requested,
        ...pendingReport(task, lease),
        ...(branchReport ? { branch_report: branchReport } : {}),
        ...(reportedBlock
          ? {
              blocked: {
                seq: reportedBlock.seq,
                ...(reportedBlock.payload.request_id
                  ? { request_id: reportedBlock.payload.request_id }
                  : {}),
              },
            }
          : {}),
        reply: pending
          ? {
              reply_id: pending.id,
              ...replyBinding(task.id, pending.id),
              kind: pending.kind,
              ...(pending.text === null ? {} : { text: pending.text }),
              by: pending.by,
            }
          : null,
        // 输入与回复同一通道下发，但不解除 blocked；不能中途注入的执行器等下一次派工。
        // 任务卡住（提问、待授权）时扣留：输入不能被当成对提问的回答或授权弹窗上的按键。
        inputs:
          !after.cancel_requested &&
          (after.status === 'running' || after.status === 'verifying') &&
          injectsWhileRunning(lease.node_id, after)
            ? pendingInputs(task.id, 10)
            : [],
      })
    },

    ackReply(leaseId, body) {
      const req = parse(ackReplyRequest, body, '回复确认请求')
      if (!req.ok) return req
      const auth = authorize(leaseId, req.data.lease_token)
      if (!auth.ok) return auth
      const { lease, task } = auth.data
      const reply = ledger.getReply(req.data.reply_id)
      if (!reply || reply.task_id !== task.id) {
        return fail('failure', 'reply_not_found', `任务 ${task.id} 没有回复 ${req.data.reply_id}`)
      }
      // 重复确认（例如上一次的响应丢失）：已送达或已拒收就直接返回，保证只处理一次。
      if (reply.state === 'delivered' && req.data.outcome === 'delivered') return ok({ task })
      if (req.data.outcome === 'dropped' && req.data.reason === 'round_closed') {
        // 自行恢复已通过 task.unblocked 丢弃的回复不追加通知；主动拒收同样只确认一次。
        if (reply.state === 'dropped') return ok({ task })
        if (reply.state !== 'pending' && reply.state !== 'requeued') {
          return fail(
            'failure',
            'invalid_transition',
            `回复 ${reply.id} 已是 ${reply.state}，不能丢弃`,
          )
        }
        if (reply.state === 'requeued' && !isLeaseResumeReply(task.id, lease.lease_id, reply.id)) {
          return fail('failure', 'invalid_transition', `回复 ${reply.id} 不属于本租约的恢复回复`)
        }
        const written = ledger.append(
          {
            task_id: task.id,
            workspace: task.workspace,
            type: 'task.reply_dropped',
            payload: {
              reply_id: reply.id,
              reason: 'round_closed',
              message: `这条回复${req.data.attempted ? '可能没有' : '没有'}送达，原因：授权回合已关闭或请求已变化。请查看当前任务后重新回复。`,
            },
          },
          { actor: `node:${lease.node_id}` },
        )
        if (!written.ok) return written
        ledger.touchNode(lease.node_id)
        return ok({ task: ledger.getTask(task.id) ?? task })
      }
      if (
        reply.state === 'dropped' &&
        req.data.outcome === 'delivered' &&
        reply.by === SUPERVISOR_ACTOR &&
        reply.kind === 'approve' &&
        task.status === 'blocked' &&
        ledger.replyPredatesDeliveryTracking(reply.id)
      ) {
        const events = ledger.taskEvents(task.id)
        const blocked = events.findLast((event) => event.type === 'task.blocked')
        const withdrawal = events.findLast(
          (event) =>
            event.type === 'task.reply_escalated' &&
            event.payload.reason === 'policy_changed' &&
            event.payload.dropped_reply_id === reply.id,
        )
        if (
          withdrawal?.type === 'task.reply_escalated' &&
          blocked?.seq === withdrawal.payload.block_seq
        ) {
          // 仅兼容交付机制之前的旧回复：确认实际送达，并保留原撤回与纠正说明供审计。
          const written = ledger.append(
            {
              type: 'task.unblocked',
              task_id: task.id,
              workspace: task.workspace,
              payload: {
                reply_id: reply.id,
                note: '节点确认批准已送达；批准在撤回生效前已交给节点，纠正先前的策略撤回记录。',
              },
            },
            { actor: `node:${lease.node_id}` },
          )
          if (!written.ok) return written
          ledger.touchNode(lease.node_id)
          const after = ledger.getTask(task.id)
          return after ? ok({ task: after }) : fail('failure', 'internal_error', '任务不可见')
        }
      }
      if (reply.state === 'dropped' && req.data.outcome === 'dropped') return ok({ task })
      // request_changed 仍只用于 supervisor 的批准（D15）；人类回复只能经带通知的 round_closed 拒收。
      if (
        req.data.outcome === 'dropped' &&
        (reply.by !== SUPERVISOR_ACTOR || reply.kind !== 'approve')
      ) {
        return fail(
          'usage',
          'invalid_arguments',
          `只有 supervisor 的批准可以拒收（回复 ${reply.id} 来自 ${reply.by}，类型 ${reply.kind}）`,
        )
      }
      if (reply.state !== 'pending' || task.status !== 'blocked') {
        return fail(
          'failure',
          'invalid_transition',
          `回复 ${reply.id} 状态为 ${reply.state}、任务状态为 ${task.status}，不能确认送达`,
          { from: task.status, type: 'task.unblocked' },
        )
      }
      const base = { task_id: task.id, workspace: task.workspace }
      const session = task.blocked?.session
      const draft: EventInput =
        req.data.outcome === 'not_running' && task.cancel_requested
          ? {
              // 已请求取消：worker 不在了就直接取消，不带着回复重新排队（复核第 2 条）。
              ...base,
              type: 'task.cancelled',
              payload: { reason: '已请求取消；送达回复时 worker 已不在', node_id: lease.node_id },
            }
          : req.data.outcome === 'delivered'
            ? {
                ...base,
                type: 'task.unblocked',
                payload: { reply_id: reply.id, note: replyNote(reply) },
              }
            : req.data.outcome === 'dropped'
              ? {
                  // 节点拒收（D15：supervisor 的批准送达时待批请求已变或环境复查未通过）：
                  // 任务回到 running、这条回复标记为 dropped（不带 reply_id 的 unblocked 丢弃全部待送达回复），
                  // 节点随后以 no_delegate 重新上报卡住，直接交给用户。
                  ...base,
                  type: 'task.unblocked',
                  payload: {
                    note: `${reply.by} 的${reply.kind === 'approve' ? '批准' : '回复'}${req.data.attempted ? '可能没有送达' : '未送达'}：待批请求已变化或环境复查未通过（${req.data.reason ?? 'request_changed'}）`,
                    dropped_reply_ids: [reply.id],
                  },
                }
              : {
                  ...base,
                  type: 'task.requeued_with_reply',
                  payload: { reply_id: reply.id, ...(session ? { session } : {}) },
                }
      const drafts: EventInput[] =
        req.data.outcome === 'not_running'
          ? [
              {
                ...base,
                type: 'task.attempt_ended',
                payload: {
                  attempt: lease.attempt,
                  reason: task.cancel_requested ? 'cancelled' : 'blocked',
                },
              },
              draft,
            ]
          : [draft]
      const written = ledger.appendMany(drafts, { actor: `node:${lease.node_id}` })
      if (!written.ok) return written
      ledger.touchNode(lease.node_id)
      const after = ledger.getTask(task.id)
      return after ? ok({ task: after }) : fail('failure', 'internal_error', '任务不可见')
    },

    complete(leaseId, body) {
      const req = parse(completeLeaseRequest, body, '提交请求')
      if (!req.ok) return req
      const auth = authorize(leaseId, req.data.lease_token)
      if (!auth.ok) return auth
      const { lease, task } = auth.data
      if (req.data.outcome === 'cancelled' && !task.cancel_requested) {
        return fail(
          'failure',
          'invalid_transition',
          '任务没有被请求取消，不能提交 cancelled；执行器自行中止请提交 failed 或 blocked',
          { from: task.status, type: 'task.cancelled' },
        )
      }
      const consumed = reportConsumption(task, lease, req.data.report_seq)
      if (!consumed.ok) return consumed
      const completion = reportedCompletion(task, lease, req.data)
      if (!completion.ok) return completion
      const pending = task.status === 'blocked' ? ledger.pendingReply(task.id) : null
      const written = ledger.appendMany(
        [
          ...(consumed.data ? [consumed.data] : []),
          ...completionDrafts(
            task,
            lease,
            completion.data,
            pending,
            ledger.latestWorkerReport(task.id, lease.lease_id, lease.attempt)?.payload.summary,
          ),
        ],
        {
          actor: `node:${lease.node_id}`,
        },
      )
      if (!written.ok) return written
      ledger.touchNode(lease.node_id)
      const after = ledger.getTask(task.id)
      return after ? ok({ task: after }) : fail('failure', 'internal_error', '任务不可见')
    },

    expireDue(opts = {}) {
      const now = clock.now() - Math.max(0, opts.graceMs ?? 0)
      let handled = 0
      for (const lease of ledger.activeLeases()) {
        // activeLeases 按 expires_at 升序。
        if (Date.parse(lease.expires_at) > now) break
        const task = ledger.getTask(lease.task_id)
        if (!task) continue
        const pending = task.status === 'blocked' ? ledger.pendingReply(task.id) : null
        const written = ledger.appendMany(expiryDrafts(task, lease, pending), { actor: 'hub' })
        if (written.ok) handled++
      }
      return handled
    },

    waiting: () => waiters.length,

    close() {
      if (closed) return
      closed = true
      unsubscribe()
      for (const w of [...waiters]) w.resolve(null)
    },
  }

  function reportFor(task: TaskView, lease: LeaseRecord, seq: number) {
    return ledger.workerReport(task.id, lease.lease_id, lease.attempt, seq)
  }

  /** 消费以 seq 作水位，确认较新的上报后不再重新投递旧上报；重复确认幂等。 */
  function reportConsumption(
    task: TaskView,
    lease: LeaseRecord,
    seq?: number,
  ): Result<EventInput | null> {
    if (seq === undefined) return ok(null)
    if (!reportFor(task, lease, seq))
      return fail('usage', 'invalid_arguments', 'report_seq 必须引用本派工的上报')
    if (ledger.workerReportWatermark(task.id, lease.lease_id, lease.attempt) >= seq) return ok(null)
    return ok({
      task_id: task.id,
      workspace: task.workspace,
      type: 'task.report_consumed',
      payload: { lease_id: lease.lease_id, attempt: lease.attempt, report_seq: seq },
    })
  }

  function pendingReport(task: TaskView, lease: LeaseRecord) {
    const consumed = ledger.workerReportWatermark(task.id, lease.lease_id, lease.attempt)
    const event = ledger.latestWorkerReport(task.id, lease.lease_id, lease.attempt)
    if (!event || event.seq <= consumed) return {}
    const { lease_id: _, ...report } = event.payload
    return { report: { seq: event.seq, ...report } }
  }

  /** 节点只引用上报：中枢从账本取回实际内容，防止结果与被引用的上报不一致。 */
  function reportedCompletion(
    task: TaskView,
    lease: LeaseRecord,
    req: CompleteLeaseRequest,
  ): Result<CompleteLeaseRequest> {
    if (req.report_seq === undefined) return ok(req)
    const report = reportFor(task, lease, req.report_seq)?.payload
    if (!report) return fail('usage', 'invalid_arguments', 'report_seq 不属于当前派工')
    if (
      req.outcome === 'blocked' &&
      (report.status === 'question' || report.status === 'blocked')
    ) {
      return ok({
        ...req,
        blocked_reason: report.status === 'question' ? 'question' : 'other',
        message:
          report.status === 'question'
            ? (report.question as string)
            : `${report.summary}\n缺少：${report.missing}\n已尝试：${report.tried}`,
        basis: 'reported',
        ...(report.status === 'question'
          ? {
              question: {
                text: report.question as string,
                options: report.options as ReportQuestion['options'],
                recommended: report.recommended as string,
              },
            }
          : { missing: report.missing as string, tried: report.tried as string }),
      })
    }
    // ready 只代表交付物已存在；节点随后的强制验收仍可失败或因工作目录丢失受阻。
    if (
      report.status === 'ready' &&
      ((req.outcome === 'failed' && req.result.reason === 'verify_failed') ||
        (req.outcome === 'blocked' && req.blocked_reason === 'workdir_missing'))
    )
      return ok(req)
    if (
      (req.outcome === 'done' && (report.status === 'ready' || report.status === 'dropped')) ||
      (req.outcome === 'failed' && report.status === 'failed')
    ) {
      const artifacts = [...req.result.artifacts]
      for (const ref of report.deliverables ?? []) {
        if (!artifacts.some((artifact) => artifact.kind === 'pr' && artifact.ref === ref))
          artifacts.push({ kind: 'pr', ref })
      }
      return ok({
        ...req,
        result: {
          ...req.result,
          summary: report.summary,
          ...(report.reason ? { reported_reason: report.reason } : {}),
          artifacts,
          ...(report.status === 'dropped' ? { dropped: true } : {}),
        },
      })
    }
    return fail('usage', 'invalid_arguments', '完成状态与引用的上报状态不一致')
  }

  /**
   * 写入任务分支（D15）：每个任务只写一次、不可更改；worktree 缺失的旧任务可补报一次 worktree
   * （分支相同，不补快照）。返回 recorded / ignored / retry：只有明确的临时性错误（SQLITE_BUSY）
   * 才让节点重发，其他失败（已上报、租约不匹配、数据不合法……）节点放弃上报——没有分支时
   * push_to 恒不满足。
   */
  function reportBranch(
    task: TaskView,
    lease: LeaseRecord,
    b: NonNullable<RenewLeaseRequest['branch']>,
  ): 'recorded' | 'ignored' | 'retry' {
    const first = task.branch == null
    const backfill = !first && task.worktree == null && task.branch === b.branch
    if (!first && !backfill) return 'ignored'
    try {
      const written = ledger.append(
        {
          task_id: task.id,
          workspace: task.workspace,
          type: 'task.branch_reported',
          payload: {
            branch: b.branch,
            worktree: b.worktree,
            ...(first && b.repo_snapshot ? { repo_snapshot: b.repo_snapshot } : {}),
          },
        },
        { actor: `node:${lease.node_id}` },
      )
      if (written.ok) return 'recorded'
      o.logger?.warn('任务分支上报写入失败，忽略', { task_id: task.id, error: written.error })
      return 'ignored'
    } catch (err) {
      if (isSqliteBusy(err)) return 'retry'
      o.logger?.warn('任务分支上报写入失败，忽略', { task_id: task.id, error: String(err) })
      return 'ignored'
    }
  }

  /** 续约附带事件与消费确认在同一事务入账。 */
  function renewSteps(
    task: TaskView,
    lease: LeaseRecord,
    req: RenewLeaseRequest,
    consumed: EventInput | null,
  ): Result<null> {
    const base = { task_id: task.id, workspace: task.workspace }
    const actor = { actor: `node:${lease.node_id}` }
    if (req.activity.length > 0) ledger.recordActivity(task.id, req.activity)
    // 先记录带外事实，再解除卡住：反应器据此前一条授权以“已在外部处理”关闭。
    const seen = new Set(
      req.out_of_band?.length
        ? ledger
            .taskEvents(task.id)
            .flatMap((e) => (e.type === 'task.out_of_band' ? [e.payload.id] : []))
        : [],
    )
    const signals: EventInput[] = consumed ? [consumed] : []
    if (
      req.report_conflict &&
      !ledger.workerReportConflict(
        task.id,
        lease.lease_id,
        lease.attempt,
        req.report_conflict.report_seq,
      )
    ) {
      signals.push({
        ...base,
        type: 'task.report_conflict',
        payload: { lease_id: lease.lease_id, attempt: lease.attempt, ...req.report_conflict },
      })
    }
    let externalApproval = false
    let mdsResets = req.out_of_band?.some((s) => s.kind === 'mds_reset')
      ? mdsResetCount(ledger.taskEvents(task.id))
      : 0
    for (const signal of req.out_of_band ?? []) {
      if (seen.has(signal.id)) continue
      // mds 重置通知与隔离事实接口共用上限（审查第二轮），超过时丢弃。
      if (signal.kind === 'mds_reset' && mdsResets++ >= MDS_RESET_NOTICE_LIMIT) continue
      signals.push({ ...base, type: 'task.out_of_band', payload: signal })
      seen.add(signal.id)
      if (signal.kind === 'approval_outside_raindown') externalApproval = true
    }
    // 重复上报（上一次的响应丢失后重试）时任务已经处于目标状态，忽略即可。
    if ((req.resumed || externalApproval) && task.status === 'blocked') {
      // 自行恢复时尚未送达的回复会被丢弃：记下它们的 id，供收件箱通知回复者（PR #16 审查第 5 条）。
      const dropped = ledger
        .taskReplies(task.id)
        .filter((r) => r.state === 'pending')
        .map((r) => r.id)
      signals.push({
        ...base,
        type: 'task.unblocked',
        payload: {
          note: externalApproval
            ? '授权已在 Raindown 之外处理，worker 继续运行'
            : (req.resumed?.note ?? 'worker 自行恢复'),
          ...(dropped.length > 0 ? { dropped_reply_ids: dropped } : {}),
        },
      })
    }
    const current =
      (req.resumed || externalApproval) && task.status === 'blocked' ? 'running' : task.status
    if (req.blocked && (current === 'running' || current === 'verifying')) {
      signals.push({
        ...base,
        type: 'task.blocked',
        payload: {
          reason: req.blocked.reason,
          ...(req.blocked.request_id ? { request_id: req.blocked.request_id } : {}),
          ...(req.blocked.approval_fingerprint
            ? { approval_fingerprint: req.blocked.approval_fingerprint }
            : {}),
          message: sanitizeMessage(req.blocked.message),
          ...(req.blocked.tail ? { tail: sanitizeTail(req.blocked.tail) } : {}),
          ...(req.blocked.session ? { session: req.blocked.session } : {}),
          ...delegationFields(req.blocked),
          node_id: lease.node_id,
          lease_held: true,
        },
      })
    } else if (req.phase === 'verifying' && current === 'running') {
      signals.push({
        task_id: task.id,
        workspace: task.workspace,
        type: 'task.verifying',
        payload: { node_id: lease.node_id },
      })
    }
    if (signals.length > 0) {
      const written = ledger.appendMany(signals, actor)
      if (!written.ok) return written
    }
    return ok(null)
  }
}
