import {
  ACTIVITY_TEXT_MAX,
  type ActiveDelegation,
  type Activity,
  activeDelegation,
  checkTaskEvent,
  type Database,
  DELEGATION_ENDING_EVENTS,
  type EventOf,
  type EventPayload,
  type EventType,
  eventPayloads,
  fail,
  INBOX_LEVEL_RANK,
  type InboxItemView,
  type InboxLevel,
  type InboxSource,
  inboxShortId,
  isAllowedHumanPrEvent,
  isIsolationUnavailable,
  type LedgerEvent,
  type LedgerEventDraft,
  type ListTasksQuery,
  type NodeView,
  normalizePrUrl,
  ok,
  openDatabase,
  type PrSubscriptionView,
  parseLedgerEventDraft,
  type RebuildData,
  type ReplyView,
  type Result,
  readExecutorInfo,
  readIsolationProbeReport,
  redactKnownSecrets,
  type SqlValue,
  sanitizeText,
  type TaskResume,
  type TaskStatus,
  type TaskView,
  TERMINAL_STATUSES,
  type WakeOrigin,
} from '@raindown/core'
import type { z } from 'zod'
import { redactDeep } from '../secrets/redactor.ts'
import { type Applier, createApplier } from './apply.ts'
import type { EventFilter, LedgerMaintenance, LedgerReader } from './port.ts'
import { indexTaskPrs } from './pr-index.ts'
import {
  LEDGER_COLUMN_MIGRATIONS,
  LEDGER_DDL,
  PROJECTION_KEYS,
  PROJECTION_TABLES,
  type ProjectionTable,
  SOFT_COLUMNS,
} from './schema.ts'
import { scrubPayload } from './scrub.ts'

/**
 * 账本 store（design D1、D2；tasks.md 2.1、2.2）。
 *
 * 写入流程：在同一个事务里 校验信封与载荷（`parseLedgerEventDraft`）→ 基于投影当前状态检查
 * 状态机（`checkTaskEvent`）与一致性 → 插入事件 → `apply(event)` 更新投影；事务提交后按序通知
 * 订阅者。任何一步失败都整体回滚，不写入任何东西。
 */

/** 待写入事件：没有 seq / ts；actor 由 `append` 的选项提供。 */
export type EventInput = {
  [T in EventType]: {
    type: T
    workspace?: string
    task_id?: string
    actor?: string
    /** 调用方形态：带默认值的字段可省略，写入时由 schema 补齐。 */
    payload: z.input<(typeof eventPayloads)[T]>
  }
}[EventType]

export interface AppendOptions {
  /** 操作者，写入事件信封的 `actor`。 */
  actor: string
  /**
   * 逐条覆盖操作者（与 drafts 按下标对应，缺省项用 `actor`）。只供中枢内部在同一事务里写入不同身份的
   * 事件（例如用户批准合并与 hub 建 merger，D10）；草稿自身的 `actor` 字段始终被忽略。每条事件仍按
   * 写入身份白名单（`EVENT_ACTORS`）校验。给出时长度必须等于 drafts，否则整体不写（`invalid_arguments`）。
   */
  actors?: readonly (string | undefined)[]
  /**
   * 写入前在**同一事务**里执行的额外核对（只读投影，不写任何东西）：失败时整体不写。
   * 用于必须与写入原子完成的核对，例如 `task_respond` 对调用方唤醒、委托与卡住序号的核对（D15）。
   */
  check?: () => Result<null>
}

export interface RebuildOptions {
  /** 活动租约重置后的有效期秒数；缺省用各租约 `lease.granted` 时的 ttl_s（D2）。 */
  leaseTtlS?: number
  /** 写入 `hub.rebuilt` 的操作者，默认 `hub`。 */
  actor?: string
}

export interface LeaseRecord {
  lease_id: string
  task_id: string
  node_id: string
  attempt: number
  token_sha256: string
  ttl_s: number
  granted_at: string
  expires_at: string
  state: 'active' | 'released' | 'expired'
  ended_at: string | null
}

export interface OpenLedgerOptions {
  /** 毫秒时钟，默认 `Date.now`；事件 ts 与软状态时间都取自它。测试可注入。 */
  now?: () => number
  /** 每个任务保留的最近活动条数，默认 50。 */
  activityKeep?: number
  /**
   * 写入前对事件载荷与活动片段中所有字符串做的替换（secret-hygiene "已知密钥值的脱敏"）。
   * 中枢传入脱敏名单；重建只重放已写入（已脱敏）的事件，不再替换。
   */
  redact?: (text: string) => string
}

/** 收件箱条目的查询条件（3.2 的 inbox_list 在此之上加参数校验）。 */
export interface InboxItemFilter {
  state?: 'open' | 'closed'
  level?: InboxLevel
  workspace?: string
  task_id?: string
  source?: InboxSource
  /** 默认 200。 */
  limit?: number
}

/** 唤醒任务的账本记录（`supervisor.wake_started`）。 */
export interface WakeRecord {
  task_id: string
  workspace: string
  origin: WakeOrigin
  generation: number
  /** `supervisor.wake_started` 事件的 seq。 */
  seq: number
  /** 这次唤醒合并的账本事件 seq（`supervisor.wake_started.events`，中枢写入）。 */
  events: number[]
  /** 合并了 PR 评论（`pr.wake_requested`）的唤醒：来源记为 instruction:pr。 */
  source?: 'pr'
}

/** 每张投影表按主键排序后的行（JSON 字段保持原文）。 */
export type ProjectionSnapshot = Record<ProjectionTable, Record<string, unknown>[]>

export interface LedgerStore extends LedgerReader, LedgerMaintenance {
  /** 追加一条事件。 */
  append(draft: EventInput, opts: AppendOptions): Result<LedgerEvent>
  /** 在一个事务里依次追加多条事件；任一条不合法则全部不写。 */
  appendMany(drafts: readonly EventInput[], opts: AppendOptions): Result<LedgerEvent[]>
  /** 清空投影并按 seq 重放全部事件，软状态按 D2 重置，最后写入 `hub.rebuilt`。 */
  rebuild(opts?: RebuildOptions): Result<RebuildData>

  /** 最近一条事件；beforeSeq 用于取得本次 hub.started 之前的恢复边界。 */
  latestEvent(beforeSeq?: number, type?: EventType): LedgerEvent | null
  /** 某时刻（含）之后策略自动放行（auto、auto-report）的次数（Telegram `/status`）。 */
  countAutoDecisions(sinceIso: string): number
  /** 某 workspace 中给定类型的最近 limit 条事件，按 seq 倒序（简报的代回复记录等）。 */
  recentEvents(workspace: string, types: readonly EventType[], limit: number): LedgerEvent[]
  /** 某类型在时间窗 [fromIso, toIso) 内的事件，按 seq 升序，最多 limit 条（每日摘要等）。 */
  /** 某类型、`ts` 在 [fromIso, toIso) 内、seq > afterSeq（缺省 0）的事件，按 seq 升序，最多 limit 条。 */
  eventsBetween(
    type: EventType,
    fromIso: string,
    toIso: string,
    limit?: number,
    afterSeq?: number,
  ): LedgerEvent[]
  hasScheduleFire(ruleId: string, plannedAt: string): boolean
  /**
   * 某类型中载荷字段 `key`（顶层）等于 `value` 的事件，按 seq 升序（任务提案、决策回看去重等按载荷查找）。
   */
  eventsByPayload(type: EventType, key: string, value: string): LedgerEvent[]

  getTask(id: string): TaskView | null
  /**
   * `open_only`：只取未结束（非 done / failed / cancelled）的任务；`exclude_ids`：排除这些任务；
   * `limit: -1` 不截取。
   */
  listTasks(
    filter?: Partial<ListTasksQuery> & { open_only?: boolean; exclude_ids?: readonly string[] },
  ): TaskView[]
  /** 从可重放的 PR 索引读取，按创建时间倒序分页，包含历史派工产物。 */
  tasksForPr(workspace: string, pr: string, limit?: number, offset?: number): TaskView[]
  taskPrs(taskId: string): string[]
  /** 任务的 PR 订阅（含已结束的），按订阅先后。 */
  prSubscriptions(taskId: string): PrSubscriptionView[]
  /** 有效订阅（可按 workspace 过滤），按订阅先后；pr-watcher 据此决定轮询哪些 PR。 */
  activePrSubscriptions(workspace?: string): (PrSubscriptionView & { workspace: string })[]
  /** 某 workspace、PR 各种类已入账的最大游标（kind → cursor）。 */
  prCursors(workspace: string, pr: string): Record<string, string>
  /** 某 workspace、PR、种类中游标不早于 since 的已入账游标（同一秒竞态去重用）。 */
  prEventCursorsSince(workspace: string, pr: string, kind: string, sinceIso: string): string[]
  /** 一条 pr.event（不存在或不是 pr.event 时为 null）。 */
  prEvent(seq: number): EventOf<'pr.event'> | null
  /** ts 不早于 since 的 pr.event，按 seq 升序（中枢启动时补处理直通）。 */
  recentPrEvents(sinceIso: string): EventOf<'pr.event'>[]
  /** 是否已为这条 PR 事件写过同一原因（与任务）的 supervisor 唤醒请求。 */
  prWakeRequested(prEventSeq: number, reason: string, taskId?: string): boolean
  /** 直通已处理到的最后一条 pr.event 的 seq（持久化检查点；没有时为 0）。 */
  prDispatchedUpTo(): number
  /** 这条 pr.event 是否已有直通检查点。 */
  prIsDispatched(prEventSeq: number): boolean
  /** seq 大于 after 的 pr.event，按 seq 升序。 */
  prEventsAfter(after: number, limit: number): EventOf<'pr.event'>[]
  /** 任务尚未送达的输入，按 seq 升序。 */
  pendingTaskInputs(taskId: string, limit?: number): { seq: number; pr_event_seq: number }[]
  /** 任务是否收到过这条 PR 事件（task.input_added）。 */
  taskHasPrInput(taskId: string, prEventSeq: number): boolean
  prTasksSummary(workspace: string, pr: string): { count: number; chars: number }
  /** 某 workspace 未结束（非 done / failed / cancelled）的任务，按更新时间倒序，最多 limit 条。 */
  openTasks(workspace: string, limit: number): TaskView[]
  /** 全部 queued 任务，按创建先后（created_seq 升序），供租约分配使用。 */
  queuedTasks(): TaskView[]
  findTaskByIdempotencyKey(key: string): TaskView | null
  /**
   * 该任务是否是 supervisor 唤醒任务（D1：以账本中的 `supervisor.wake_started` 为准，不看角色名或 inputs），
   * 是则返回该事件记录的 origin、代数与 seq。
   */
  wakeOf(taskId: string): WakeRecord | null
  /** 这些 seq 的事件所属的任务 id（去重）。 */
  eventTaskIds(seqs: readonly number[]): string[]
  /** 以某任务为 parent、由某身份创建的任务数（D4 每次唤醒建任务数）。 */
  countChildren(parentId: string, createdBy: string): number
  /**
   * 本 workspace 中对某 PR（链接不区分大小写）给出 `changes_requested` 的审查任务数（D4 审查轮数）：
   * 只统计角色在 `roles` 中、执行器为 claude-sdk 的任务的 `result.review.verdict`。
   */
  countChangesRequested(workspace: string, pr: string, roles: readonly string[]): number
  /**
   * 合并请求的资格核对（D10 第 4 步）用：workspace 中合同带 `inputs.review`，或结果中有 `kind: pr`
   * 产物、且链接以 `/pull/<prNumber>` 结尾的任务（按创建先后，最多 limit 条）。只是预筛：PR 号是各种写法
   * （大小写、`www.`、`:443`）共有的部分，PR 是否相同由调用方用 `samePrUrl` 判断；返回条数达到 limit 时
   * 调用方应判为无法确认（fail-closed）。
   */
  prRelatedTasks(workspace: string, prNumber: number, limit: number): TaskView[]
  /** 某任务的全部事件（按 seq）。 */
  taskEvents(taskId: string): LedgerEvent[]
  /** 本任务某类事件在 beforeSeq（不含）之前的最近一条。 */
  latestTaskEvent(taskId: string, type: EventType, beforeSeq?: number): LedgerEvent | null
  /** 回复只绑定到 task.replied 之前最近一次卡住。 */
  replyBlock(
    taskId: string,
    replyId: string,
  ): { block_seq: number; approval_fingerprint?: string } | undefined
  /** 本次派工是否已明确结束。 */
  attemptEnded(taskId: string, attempt: number): boolean
  /** 按派工与账本序号定位上报。 */
  workerReport(
    taskId: string,
    leaseId: string,
    attempt: number,
    seq: number,
  ): EventOf<'task.reported'> | null
  /** 本次派工的指定上报是否已记录观察矛盾。 */
  workerReportConflict(taskId: string, leaseId: string, attempt: number, seq: number): boolean
  /** 本次派工最近一次上报。 */
  latestWorkerReport(
    taskId: string,
    leaseId: string,
    attempt: number,
  ): EventOf<'task.reported'> | null
  /** 本次派工已消费的最大上报序号，没有消费时为 0。 */
  workerReportWatermark(taskId: string, leaseId: string, attempt: number): number
  /** 本次派工的上报总数及指定时间（含）之后的上报数。 */
  workerReportUsage(
    taskId: string,
    leaseId: string,
    attempt: number,
    sinceIso: string,
  ): { total: number; recent: number }
  /**
   * 该任务当前有效的代回复委托（D15，core `activeDelegation`）：任务离开该次卡住
   * （包括进入新的卡住）时隐式失效。调度与 task_respond 统一用它判断。
   */
  activeDelegation(taskId: string): ActiveDelegation | null
  /** 该任务 `supervisor.wake_started` 的 origin；不是唤醒任务时为 null（D1、D12）。 */
  wakeOrigin(taskId: string): WakeOrigin | null
  getNode(nodeId: string): NodeView | null
  listNodes(): NodeView[]
  getLease(leaseId: string): LeaseRecord | null
  /** 任务当前的活动租约。 */
  activeLease(taskId: string): LeaseRecord | null
  activeLeases(): LeaseRecord[]
  /** 某任务最早一条待送达的回复。 */
  pendingReply(taskId: string): ReplyView | null
  getReply(replyId: string): ReplyView | null
  /** 回复是否早于账本首次记录交付；只供旧账本的策略撤回回执兜底。 */
  replyPredatesDeliveryTracking(replyId: string): boolean
  /** 某任务的全部回复（按收到先后）。 */
  taskReplies(taskId: string): ReplyView[]
  /** 任务带着回复重新排队后，下一次执行要带上的恢复信息。 */
  taskResume(taskId: string): TaskResume | null

  getInboxItem(itemId: string): InboxItemView | null
  /** 按短 id（创建事件 seq 的 base36）找条目，渠道按钮用。 */
  getInboxItemByShortId(shortId: string): InboxItemView | null
  /** 某渠道的一条消息里包含的条目 id（按条目创建先后）。 */
  channelMessageItems(channel: string, ref: string): string[]
  /** 某渠道上条目已关闭、但消息还没改为"已处理"的消息，按发送先后。 */
  pendingChannelUpdates(channel: string): { ref: string; item_ids: string[] }[]
  /** 某渠道上记为推送失败（op=failed）的条目数。 */
  channelFailedCount(channel: string): number
  /** 按级别（interrupt → digest）再按创建先后排序。 */
  listInboxItems(filter?: InboxItemFilter): InboxItemView[]
  /**
   * 收件箱反应器已处理到的账本位置的下界：全部收件箱事件中 `source_seq` 与 `cause_seq` 的最大值。
   * 反应器按 seq 顺序处理，写出某个源事件的条目时，更早的事件都已处理过。
   */
  inboxCursor(): number

  // ---- 软状态（不入账本，D2） ----
  /** 刷新节点最近活动时间；节点不存在时返回 false。 */
  touchNode(nodeId: string, at?: string): boolean
  /** 续约：只更新活动租约的到期时间；租约不存在或已结束时返回 false。 */
  renewLease(leaseId: string, expiresAt: string): boolean
  /** 把全部活动租约的到期时间顺延 ms 毫秒（睡眠恢复，D5），返回受影响的租约数。 */
  extendActiveLeases(ms: number): number
  /** 记录任务活动：保留最近 N 条，更新 last_activity_at。任务不存在时返回 false。 */
  recordActivity(taskId: string, activities: readonly Activity[]): boolean
  taskActivity(taskId: string): Activity[]

  /** 投影表快照；`includeSoft: false` 时去掉软状态列（性质测试与诊断用）。 */
  snapshot(opts?: { includeSoft?: boolean }): ProjectionSnapshot
}

/** 打开（必要时创建）账本数据库并建表。 */
export async function openLedger(path: string, opts: OpenLedgerOptions = {}): Promise<LedgerStore> {
  const db = await openDatabase(path)
  const hadPrIndex = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_prs'")
    .get()
  // 建表与回填在一个事务中完成，升级中断后不会留下貌似已初始化的空索引。
  db.transaction(() => {
    db.exec(LEDGER_DDL)
    migrateColumns(db)
    if (!hadPrIndex) {
      let after = 0
      for (;;) {
        const rows = db
          .prepare(
            "SELECT * FROM events WHERE seq > ? AND type IN ('task.created', 'task.done', 'task.failed', 'task.cancelled') ORDER BY seq LIMIT 500",
          )
          .all(after) as EventRow[]
        if (!rows.length) break
        for (const row of rows) indexTaskPrs(db, rowToEvent(row))
        after = rows.at(-1)?.seq ?? after
      }
    }
  })
  return createStore(db, opts)
}

/** 给旧账本补上新增的投影列（见 `LEDGER_COLUMN_MIGRATIONS`）。 */
function migrateColumns(db: Database) {
  for (const m of LEDGER_COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === m.column)) db.exec(m.ddl)
  }
}

class Abort extends Error {
  constructor(readonly result: Result<never>) {
    super(result.ok ? 'abort' : result.error.message)
  }
}

interface EventRow {
  seq: number
  ts: string
  type: string
  workspace: string | null
  task_id: string | null
  actor: string
  payload_json: string
}

interface TaskRow {
  id: string
  workspace: string
  status: TaskStatus
  contract_json: string
  attempt: number
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
  cancel_requested: number
  blocked_json: string | null
  result_json: string | null
  created_by: string
  origin: TaskView['origin']
  mandate_json: string | null
  branch: string | null
  worktree: string | null
  repo_snapshot_json: string | null
  last_activity_at: string | null
  lease_id: string | null
  lease_node_id: string | null
  lease_expires_at: string | null
}

interface ReplyRow {
  id: string
  task_id: string
  kind: ReplyView['kind']
  text: string | null
  by: string
  created_at: string
  state: ReplyView['state']
  fetched_at: string | null
  delivered_at: string | null
}

const rowToReply = (r: ReplyRow): ReplyView => ({
  id: r.id,
  task_id: r.task_id,
  kind: r.kind,
  text: r.text,
  by: r.by,
  created_at: r.created_at,
  state: r.state,
  ...(r.fetched_at == null ? {} : { fetched_at: r.fetched_at }),
  delivered_at: r.delivered_at,
})

interface PrSubscriptionRow {
  subscribed_seq: number
  task_id: string
  workspace: string
  pr: string
  role: PrSubscriptionView['role']
  subscribed_at: string
  state: 'active' | 'ended'
  ended_at: string | null
  reason: PrSubscriptionView['reason']
}

const rowToSubscription = (r: PrSubscriptionRow): PrSubscriptionView => ({
  task_id: r.task_id,
  pr: r.pr,
  role: r.role,
  subscribed_at: r.subscribed_at,
  subscribed_seq: r.subscribed_seq,
  active: r.state === 'active',
  ended_at: r.ended_at,
  reason: r.reason,
})

interface NodeRow {
  node_id: string
  hostname: string
  version: string
  capabilities_json: string
  executors_json: string
  concurrency: number
  registered_at: string
  last_seen_at: string | null
  active_leases: number
  isolation_probe_json: string | null
}

interface InboxRow {
  id: string
  level: InboxLevel
  source: InboxSource
  source_ref: string
  reason: string | null
  workspace: string | null
  task_id: string | null
  title: string
  body: string
  actions_json: string
  options_json: string | null
  state: 'open' | 'closed'
  created_seq: number
  created_at: string
  created_by: string
  updated_at: string
  deferred_until: string | null
  pushed_at: string | null
  channel_refs_json: string
  close_reason: string | null
  close_note: string | null
  closed_at: string | null
  closed_by: string | null
  cause_actor: string | null
  closed_via: string | null
}

function rowToInbox(r: InboxRow): InboxItemView {
  return {
    id: r.id,
    short_id: inboxShortId(r.created_seq),
    level: r.level,
    source: r.source,
    source_ref: r.source_ref,
    reason: r.reason,
    workspace: r.workspace,
    task_id: r.task_id,
    title: r.title,
    body: r.body,
    actions: JSON.parse(r.actions_json),
    ...(r.options_json ? { options: JSON.parse(r.options_json) } : {}),
    state: r.state,
    created_at: r.created_at,
    created_by: r.created_by,
    updated_at: r.updated_at,
    deferred_until: r.deferred_until,
    pushed_at: r.pushed_at,
    channels: JSON.parse(r.channel_refs_json),
    closed:
      r.state === 'closed' && r.closed_at !== null && r.closed_by !== null
        ? {
            reason: r.close_reason as NonNullable<InboxItemView['closed']>['reason'],
            note: r.close_note,
            at: r.closed_at,
            by: r.closed_by,
            cause_actor: r.cause_actor,
            via: r.closed_via as NonNullable<InboxItemView['closed']>['via'],
          }
        : null,
  }
}

const LEVEL_ORDER = `CASE level ${Object.entries(INBOX_LEVEL_RANK)
  .map(([level, rank]) => `WHEN '${level}' THEN ${rank}`)
  .join(' ')} END`

const TASK_SELECT = `SELECT t.*, l.lease_id AS lease_id, l.node_id AS lease_node_id,
  l.expires_at AS lease_expires_at
  FROM tasks t LEFT JOIN leases l ON l.task_id = t.id AND l.state = 'active'`

const NODE_SELECT = `SELECT n.*, (SELECT COUNT(*) FROM leases l
  WHERE l.node_id = n.node_id AND l.state = 'active') AS active_leases FROM nodes n`

function rowToEvent(r: EventRow): LedgerEvent {
  return {
    seq: r.seq,
    ts: r.ts,
    type: r.type,
    ...(r.workspace === null ? {} : { workspace: r.workspace }),
    ...(r.task_id === null ? {} : { task_id: r.task_id }),
    actor: r.actor,
    payload: JSON.parse(r.payload_json),
  } as LedgerEvent
}

function rowToTask(r: TaskRow): TaskView {
  return {
    id: r.id,
    workspace: r.workspace,
    status: r.status,
    contract: JSON.parse(r.contract_json),
    attempt: r.attempt,
    created_at: r.created_at,
    updated_at: r.updated_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    cancel_requested: r.cancel_requested === 1,
    // lease_held 不单独存储：blocked 期间仍有活动租约即为持有（D7a）。
    blocked:
      r.blocked_json === null
        ? null
        : { ...JSON.parse(r.blocked_json), lease_held: r.lease_id !== null },
    lease:
      r.lease_id === null || r.lease_node_id === null || r.lease_expires_at === null
        ? null
        : { lease_id: r.lease_id, node_id: r.lease_node_id, expires_at: r.lease_expires_at },
    result: r.result_json === null ? null : JSON.parse(r.result_json),
    created_by: r.created_by,
    origin: r.origin ?? null,
    ...(r.mandate_json ? { mandate: JSON.parse(r.mandate_json) } : {}),
    branch: r.branch ?? null,
    worktree: r.worktree ?? null,
    repo_snapshot: r.repo_snapshot_json ? JSON.parse(r.repo_snapshot_json) : null,
    last_activity_at: r.last_activity_at,
  }
}

function rowToNode(r: NodeRow): NodeView {
  return {
    node_id: r.node_id,
    hostname: r.hostname,
    version: r.version,
    capabilities: JSON.parse(r.capabilities_json),
    executors: readExecutorInfo.array().parse(JSON.parse(r.executors_json)),
    concurrency: r.concurrency,
    registered_at: r.registered_at,
    last_seen_at: r.last_seen_at,
    active_leases: r.active_leases,
    isolation_probe: readIsolationProbeReport.parse(
      r.isolation_probe_json ? safeJson(r.isolation_probe_json) : null,
    ),
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 新事件的写入身份白名单（store 层兜底；路由层另有 user-only 等检查）：
 * - 用户的决定：指令、放行、接受 / 驳回提案、批准 / 驳回合并只接受 user；
 * - 中枢内部：唤醒、丢弃队列积压、定时触发、提案登记、合并请求登记、决策回看、代回复委托只接受 hub；
 * - `task.reply_escalated` 按 reason 区分（见 `ESCALATION_BY_USER`）：user_replied、user_dismissed
 *   在用户回复或忽略的同一次 append 中写入，只接受 user；其他原因只接受 hub；
 * - `supervisor.answered`（D11）由收件箱回复路由写入：路由以 user 身份直接写，
 *   或由中枢（hub）代为写入，取实际调用方，两者都接受。
 */
const EVENT_ACTORS: Partial<Record<LedgerEventDraft['type'], readonly string[]>> = {
  'user.instruction': ['user'],
  'supervisor.release': ['user'],
  'supervisor.queue_dropped': ['hub'],
  'supervisor.scheduler_initialized': ['hub'],
  'schedule.fired': ['hub'],
  'task_proposal.accepted': ['user'],
  'task_proposal.rejected': ['user'],
  'merge_request.approved': ['user'],
  'merge_request.rejected': ['user'],
  'merge_request.created': ['hub'],
  'supervisor.wake_started': ['hub'],
  'supervisor.answered': ['hub', 'user'],
  'task_proposal.created': ['hub'],
  'decision.review_due': ['hub'],
  'policy.changed': ['hub'],
  'task.policy_changed': ['hub'],
  'task.reply_delegated': ['hub'],
  'task.reply_fetched': ['hub'],
  // observe 判断与未执行的自主动作（D10）只由中枢写入。
  'task.reply_observed': ['hub'],
  'supervisor.observed_action': ['hub'],
  // 回复只有用户本人与 supervisor（经 task_respond、落在有效委托上）能写（D15）。
  'task.replied': ['user', 'supervisor'],
  // PR 订阅与事件（harness-neutral D11）：只由中枢写入；用户只能取消订阅。
  'pr.subscribed': ['hub'],
  'pr.unsubscribed': ['hub', 'user'],
  'pr.event': ['hub'],
  'task.input_added': ['hub'],
  'task.input_delivered': ['hub'],
  'pr.wake_requested': ['hub'],
  'pr.dispatched': ['hub'],
}

/** 由用户操作结束委托的转交原因：与用户的 task_reply / 忽略同一次 append 写入，actor 为 user。 */
const ESCALATION_BY_USER: ReadonlySet<string> = new Set(['user_replied', 'user_dismissed'])

/** supervisor 保留身份（与 core 的 SUPERVISOR_ACTOR 相同）。 */
const SUPERVISOR = 'supervisor'

/**
 * 自己创建专用分支与 worktree、因而拥有任务分支的执行器（D15；docs/executors.md 适配器契约）。
 * claude-sdk、codex-exec 在给定 cwd 中运行，当前分支通常是 main 或用户的检出，不在此列；
 * 新适配器只有在自己创建分支时才能加入。
 */
const BRANCH_OWNING_EXECUTORS: ReadonlySet<string> = new Set(['codex-orca'])

const invalidEvent = (message: string, details?: unknown) =>
  fail('failure', 'invalid_event', message, details)

function createStore(db: Database, opts: OpenLedgerOptions): LedgerStore {
  const nowMs = opts.now ?? Date.now
  const iso = (ms = nowMs()) => new Date(ms).toISOString()
  const activityKeep = opts.activityKeep ?? 50
  const redact = opts.redact
  /** 活动 data 等结构化字段只做名单替换（见 scrub.ts）。 */
  const knownOnly = (text: string) => redactKnownSecrets(redact ? redact(text) : text)
  const apply: Applier = createApplier(db)
  const listeners = new Set<(event: LedgerEvent) => void>()

  const all = <T>(sql: string, ...params: SqlValue[]) => db.prepare(sql).all(...params) as T[]
  const get = <T>(sql: string, ...params: SqlValue[]) =>
    db.prepare(sql).get(...params) as T | undefined
  const run = (sql: string, ...params: SqlValue[]) => db.prepare(sql).run(...params)

  const taskState = (id: string) =>
    get<{ status: TaskStatus; workspace: string; attempt: number }>(
      'SELECT status, workspace, attempt FROM tasks WHERE id = ?',
      id,
    )

  const hasActiveLease = (taskId: string | undefined) =>
    !!get("SELECT 1 FROM leases WHERE task_id = ? AND state = 'active'", taskId ?? null)
  const noLease = (from: TaskStatus | null, type: string, why: string) =>
    fail('failure', 'invalid_transition', why, { from, type })
  const replyPredatesDeliveryTracking = (replyId: string): boolean => {
    const reply = get<{ created_seq: number }>(
      'SELECT created_seq FROM replies WHERE id = ?',
      replyId,
    )
    const firstFetched = get<{ seq: number }>(
      "SELECT seq FROM events WHERE type = 'task.reply_fetched' AND seq < ? ORDER BY seq LIMIT 1",
      before,
    )
    return !!reply && (!firstFetched || reply.created_seq < firstFetched.seq)
  }
  /** 待送达回复可以消费；只有交付机制之前的旧批准允许用迟到回执纠正策略撤回。 */
  const pendingReplyOf = (
    draft: Extract<
      LedgerEventDraft,
      {
        type: 'task.unblocked' | 'task.requeued_with_reply' | 'task.reply_fetched'
      }
    >,
  ) => {
    const r = get<{ task_id: string; state: string; by: string; kind: string }>(
      'SELECT task_id, state, by, kind FROM replies WHERE id = ?',
      draft.payload.reply_id ?? null,
    )
    if (r && r.task_id === draft.task_id) {
      if (r.state === 'pending') return ok(null)
      if (
        draft.type === 'task.unblocked' &&
        r.state === 'dropped' &&
        r.by === SUPERVISOR &&
        r.kind === 'approve' &&
        replyPredatesDeliveryTracking(draft.payload.reply_id ?? '')
      ) {
        const block = lastBlocked(draft.task_id)
        if (
          block &&
          get(
            `SELECT 1 FROM events WHERE task_id = ? AND type = 'task.reply_escalated'
             AND json_extract(payload_json, '$.reason') = 'policy_changed'
             AND json_extract(payload_json, '$.dropped_reply_id') = ?
             AND json_extract(payload_json, '$.block_seq') = ? AND seq < ?`,
            draft.task_id ?? null,
            draft.payload.reply_id ?? null,
            block.seq,
            before,
          )
        )
          return ok(null)
      }
    }
    return invalidEvent(`回复 ${draft.payload.reply_id} 不是该任务待送达的回复`)
  }

  /**
   * 账本位置上界：写入新事件时为无穷大；重建重放时为被校验事件自身的 seq——此时 events 表里已有
   * 全部事件，按事件查询的核对必须只看它之前的事件，否则会被"未来"的事件误导。
   */
  let before = Number.MAX_SAFE_INTEGER
  const attemptEnded = (taskId: string, attempt: number, upto = Number.MAX_SAFE_INTEGER) =>
    !!get(
      `SELECT 1 FROM events WHERE task_id = ? AND type = 'task.attempt_ended'
         AND json_extract(payload_json, '$.attempt') = ? AND seq < ? LIMIT 1`,
      taskId,
      attempt,
      upto,
    )
  const workerReport = (taskId: string, leaseId: string, attempt: number, seq: number) => {
    const row = get<EventRow>(
      `SELECT * FROM events WHERE seq = ? AND task_id = ? AND type = 'task.reported'
         AND json_extract(payload_json, '$.lease_id') = ?
         AND json_extract(payload_json, '$.attempt') = ?`,
      seq,
      taskId,
      leaseId,
      attempt,
    )
    return row ? (rowToEvent(row) as EventOf<'task.reported'>) : null
  }
  const latestTaskEvent = (
    taskId: string,
    type: EventType,
    beforeSeq = Number.MAX_SAFE_INTEGER,
  ) => {
    const row = get<EventRow>(
      'SELECT * FROM events WHERE task_id = ? AND type = ? AND seq < ? ORDER BY seq DESC LIMIT 1',
      taskId,
      type,
      beforeSeq,
    )
    return row ? rowToEvent(row) : null
  }
  const taskEventsOf = (taskId: string, upto = Number.MAX_SAFE_INTEGER) =>
    all<EventRow>(
      'SELECT * FROM events WHERE task_id = ? AND seq < ? ORDER BY seq',
      taskId,
      upto,
    ).map(rowToEvent)
  const currentDelegation = (taskId: string | undefined) => {
    const t = taskId === undefined ? undefined : taskState(taskId)
    return t && taskId !== undefined ? activeDelegation(t, taskEventsOf(taskId, before)) : null
  }

  /** 该任务最近一次 task.blocked（即当前或最后一次卡住）。 */
  const lastBlocked = (taskId: string | undefined) => {
    const row = get<{ seq: number; payload_json: string }>(
      `SELECT seq, payload_json FROM events WHERE task_id = ? AND type = 'task.blocked'
         AND seq < ? ORDER BY seq DESC LIMIT 1`,
      taskId ?? null,
      before,
    )
    return row
      ? { seq: row.seq, payload: JSON.parse(row.payload_json) as EventPayload<'task.blocked'> }
      : null
  }
  /** 该任务针对某次卡住的委托 / 转交事件。 */
  const delegationOf = (
    taskId: string | undefined,
    blockSeq: number,
    type: 'task.reply_delegated' | 'task.reply_escalated',
  ) =>
    !!get(
      `SELECT 1 FROM events WHERE task_id = ? AND type = ?
         AND json_extract(payload_json, '$.block_seq') = ? AND seq < ? LIMIT 1`,
      taskId ?? null,
      type,
      blockSeq,
      before,
    )

  const notDelegable = (why: string) => fail('failure', 'not_delegable', why)

  /** 一条 pr.event（只看校验位置之前的账本）。 */
  const prEventRow = (seq: number) => {
    if (seq >= before) return null
    const row = get<EventRow>("SELECT * FROM events WHERE seq = ? AND type = 'pr.event'", seq)
    return row ? (rowToEvent(row) as EventOf<'pr.event'>) : null
  }
  const taskHasInput = (taskId: string | undefined, prEventSeq: number) =>
    !!get(
      `SELECT 1 FROM events WHERE task_id = ? AND type = 'task.input_added'
         AND json_extract(payload_json, '$.pr_event_seq') = ? AND seq < ? LIMIT 1`,
      taskId ?? null,
      prEventSeq,
      before,
    )
  const wakeRequested = (prEventSeq: number, reason: string, taskId?: string) =>
    !!get(
      `SELECT 1 FROM events WHERE type = 'pr.wake_requested'
         AND json_extract(payload_json, '$.pr_event_seq') = ?
         AND json_extract(payload_json, '$.reason') = ?
         AND (task_id IS ? OR (task_id IS NULL AND ? IS NULL)) AND seq < ? LIMIT 1`,
      prEventSeq,
      reason,
      taskId ?? null,
      taskId ?? null,
      before,
    )

  /**
   * `task.reply_delegated` 的不变量（D15 "判定与卡住绑定"）：
   * - block_seq 是当前这次卡住，kind 与卡住原因一致；同一次卡住只委托一次；
   * - 卡住带 no_delegate 或 prior_reason（node_lost 遗留）时不委托；
   * - awaiting_approval：卡住时节点持有租约；必须带 decision_id，且等于卡住上报的 decision_id、
   *   指向本任务的 policy.decided，写于上一次离开 blocked 之后、本次卡住之前，档位为 supervisor。
   */
  function validateDelegation(draft: Extract<LedgerEventDraft, { type: 'task.reply_delegated' }>) {
    const p = draft.payload
    if (p.task_id !== draft.task_id) {
      return invalidEvent('task.reply_delegated 的 task_id 必须与信封一致')
    }
    const last = lastBlocked(draft.task_id)
    if (!last || last.seq !== p.block_seq) {
      return invalidEvent(`block_seq ${p.block_seq} 不是该任务当前的卡住`)
    }
    const blocked = last.payload
    if (blocked.reason !== p.kind) {
      return invalidEvent(`委托的 kind ${p.kind} 与卡住原因 ${blocked.reason} 不一致`)
    }
    // 旧账本没有 basis 时可能已合法委托；重放保留事实，启动恢复负责转交用户。
    // 新追加始终执行 reported 门槛，历史中显式 inferred 的记录也不豁免。
    const legacyReplay = before !== Number.MAX_SAFE_INTEGER && blocked.basis === undefined
    if (blocked.reason === 'question' && blocked.basis !== 'reported' && !legacyReplay) {
      return notDelegable('推断的提问不能委托 supervisor 代答')
    }
    if (blocked.no_delegate === true) return notDelegable('这次卡住带 no_delegate，不能委托')
    if (blocked.prior_reason !== undefined) {
      return notDelegable('节点掉线后保留 prior_reason 的卡住不能委托')
    }
    if (
      get(
        `SELECT 1 FROM events WHERE task_id = ? AND seq > ? AND type IN (${[
          ...DELEGATION_ENDING_EVENTS,
        ]
          .map((t) => `'${t}'`)
          .join(', ')}) AND seq < ? LIMIT 1`,
        draft.task_id ?? null,
        p.block_seq,
        before,
      )
    ) {
      return notDelegable('任务已离开这次卡住（例如租约过期），不能委托')
    }
    if (delegationOf(draft.task_id, p.block_seq, 'task.reply_delegated')) {
      return fail('failure', 'duplicate_delegation', `卡住 ${p.block_seq} 已经委托过`, {
        block_seq: p.block_seq,
      })
    }
    if (p.kind !== 'awaiting_approval') return ok(null)
    if (blocked.lease_held !== undefined && blocked.lease_held !== true) {
      return notDelegable('授权请求卡住时节点必须持有租约（lease_held）')
    }
    if (p.decision_id === undefined) {
      return invalidEvent('awaiting_approval 的委托必须带 decision_id')
    }
    if (blocked.decision_id !== p.decision_id) {
      return invalidEvent(`decision_id ${p.decision_id} 与卡住上报的判定不一致`)
    }
    const decision = get<{ type: string; task_id: string | null; payload_json: string }>(
      'SELECT type, task_id, payload_json FROM events WHERE seq = ?',
      p.decision_id,
    )
    if (decision?.type !== 'policy.decided' || decision.task_id !== draft.task_id) {
      return invalidEvent(`decision_id ${p.decision_id} 不是本任务的策略判定`)
    }
    // 下界取"上一次离开 blocked"、"上一次 task.blocked"与这一轮执行开始（task.started、
    // task.lease_expired）中最晚者：blocked → blocked 时前一次卡住期间的判定属于前一次卡住；
    // 上一轮执行（另一个租约、可能是另一个 worker）里的判定也不能拿来委托这一轮的卡住。
    const left =
      get<{ seq: number | null }>(
        `SELECT MAX(seq) AS seq FROM events WHERE task_id = ? AND seq < ?
           AND type IN ('task.unblocked', 'task.requeued_with_reply', 'task.requeued', 'task.blocked',
                        'task.started', 'task.lease_expired')`,
        draft.task_id ?? null,
        p.block_seq,
      )?.seq ?? 0
    if (p.decision_id <= left || p.decision_id >= p.block_seq) {
      return invalidEvent(
        `策略判定 ${p.decision_id} 不属于这次卡住（早于上一次离开 blocked 或上一次卡住）`,
      )
    }
    // 判定之后、卡住之前本任务不能再有别的策略判定：否则卡住的可能是后一个请求（判定不能错套）。
    if (
      get(
        `SELECT 1 FROM events WHERE task_id = ? AND type = 'policy.decided' AND seq > ? AND seq < ?
           LIMIT 1`,
        draft.task_id ?? null,
        p.decision_id,
        p.block_seq,
      )
    ) {
      // 正常的时序（worker 连续发出多个请求），不是数据错误：按不可委托处理，调用方不必告警。
      return notDelegable(`策略判定 ${p.decision_id} 之后、卡住之前还有别的策略判定`)
    }
    const level = (JSON.parse(decision.payload_json) as { level?: string }).level
    if (level !== 'supervisor') {
      return invalidEvent(`策略判定 ${p.decision_id} 的档位是 ${level}，不是 supervisor`)
    }
    return ok(null)
  }

  /**
   * `task.replied` 与代回复委托（D15）：
   * - supervisor 的回复必须 `via: supervisor`，且只能落在当前这次卡住上仍有效的委托上；
   * - 其他身份不能声称 `via: supervisor`；
   * - 委托仍有效时，用户的回复必须在同一次追加里先写 `task.reply_escalated{reason: user_replied}`
   *   结束委托（"用户优先"），否则拒绝，避免委托在用户回复后仍被当作有效。
   */
  function validateReplyDelegation(draft: Extract<LedgerEventDraft, { type: 'task.replied' }>) {
    const viaSupervisor = draft.payload.via === 'supervisor'
    if (draft.actor === SUPERVISOR) {
      if (!viaSupervisor) return invalidEvent('supervisor 的回复必须记为 via: supervisor')
      const active = currentDelegation(draft.task_id)
      if (!active || active.block_seq !== lastBlocked(draft.task_id)?.seq) {
        return fail('failure', 'not_delegated', '这次卡住没有仍有效的 supervisor 委托')
      }
      // observe（D10）：判断只记录为 task.reply_observed，supervisor 的回复绝不入账、不送达。
      if (active.observe === true) {
        return fail(
          'failure',
          'not_delegated',
          '这次委托处于 observe 模式，supervisor 的判断不能送达',
        )
      }
      // 回复类型必须与委托的卡住类型一致：提问只能文字回答，授权请求只能批准或拒绝。
      const allowed = active.kind === 'question' ? ['text'] : ['approve', 'deny']
      if (!allowed.includes(draft.payload.kind)) {
        return invalidEvent(
          `委托的卡住为 ${active.kind}，supervisor 不能以 ${draft.payload.kind} 回复`,
        )
      }
      return ok(null)
    }
    if (viaSupervisor) return invalidEvent('只有 supervisor 的回复可以记为 via: supervisor')
    if (currentDelegation(draft.task_id)) {
      return invalidEvent(
        '这次卡住仍委托给 supervisor：用户回复必须在同一次追加中先写 task.reply_escalated（user_replied）',
      )
    }
    return ok(null)
  }

  /**
   * `task.reply_observed`（D10）：observe 判断只能落在当前这次卡住上仍有效的委托上，引用必须与委托一致；
   * 信封不带 task_id（任务绑定的读取看不到它），workspace 与任务一致；判断类型与卡住类型一致。
   */
  function validateObserved(draft: Extract<LedgerEventDraft, { type: 'task.reply_observed' }>) {
    const p = draft.payload
    if (draft.task_id !== undefined) {
      return invalidEvent('task.reply_observed 不带信封 task_id（任务 id 只写在载荷中）')
    }
    const t = taskState(p.task_id)
    if (!t) return fail('failure', 'not_found', `没有任务 ${p.task_id}`)
    if (t.workspace !== draft.workspace) {
      return invalidEvent(`事件的 workspace ${draft.workspace} 与任务的 ${t.workspace} 不一致`)
    }
    if (t.status !== 'blocked') {
      return fail('failure', 'invalid_transition', `任务状态为 ${t.status}，不能记录 observe 判断`)
    }
    const last = lastBlocked(p.task_id)
    if (!last || last.seq !== p.block_seq) {
      return invalidEvent(`block_seq ${p.block_seq} 不是该任务当前的卡住`)
    }
    const active = currentDelegation(p.task_id)
    if (!active || active.block_seq !== p.block_seq || active.seq !== p.delegation_seq) {
      return fail('failure', 'not_delegated', '这次卡住没有仍有效的 supervisor 委托')
    }
    if (active.kind !== p.kind || active.decision_id !== p.decision_id) {
      return invalidEvent('observe 判断的卡住类型或策略判定与委托不一致')
    }
    const allowed = p.kind === 'question' ? ['answer', 'escalate'] : ['approve', 'deny', 'escalate']
    if (!allowed.includes(p.decision)) {
      return invalidEvent(`委托的卡住为 ${p.kind}，不能记录 ${p.decision}`)
    }
    if (p.decision === 'answer' && p.text === undefined) {
      return invalidEvent('answer 的 observe 判断必须带 text')
    }
    return ok(null)
  }

  /** 写入前的校验：信封、状态机与投影一致性。只读投影，不写任何东西。 */
  function validate(draft: LedgerEventDraft): Result<null> {
    before = (draft as { seq?: number }).seq ?? Number.MAX_SAFE_INTEGER
    try {
      return validateAt(draft)
    } finally {
      before = Number.MAX_SAFE_INTEGER
    }
  }

  function validateAt(draft: LedgerEventDraft): Result<null> {
    const allowed = EVENT_ACTORS[draft.type]
    if (allowed && !allowed.includes(draft.actor)) {
      return fail(
        'failure',
        'actor_mismatch',
        `${draft.type} 只接受 ${allowed.join('、')} 身份写入（实际为 ${draft.actor}）`,
        { type: draft.type, actor: draft.actor },
      )
    }
    const task = draft.task_id === undefined ? undefined : taskState(draft.task_id)
    const checked = checkTaskEvent(task?.status ?? null, draft)
    if (!checked.ok) return checked
    if (task !== undefined && draft.workspace !== task.workspace) {
      return invalidEvent(`事件的 workspace ${draft.workspace} 与任务的 ${task.workspace} 不一致`)
    }
    switch (draft.type) {
      case 'task.done': {
        if (draft.payload.result.completed_via !== 'existing_pr') return ok(null)
        const blocked = lastBlocked(draft.task_id)
        if (
          draft.actor !== 'hub' ||
          task?.status !== 'blocked' ||
          !blocked ||
          !['workdir_missing', 'crashed'].includes(blocked.payload.reason)
        ) {
          return invalidEvent('已有 PR 完成判定只允许中枢结束因工作目录丢失或崩溃卡住的任务')
        }
        return ok(null)
      }
      case 'policy.decided':
        return draft.payload.task_id === draft.task_id
          ? ok(null)
          : invalidEvent('policy.decided 的 task_id 必须与信封一致')
      case 'task.created': {
        const c = draft.payload.contract
        if (c.workspace !== draft.workspace) {
          return invalidEvent('task.created 的 workspace 必须与合同中的 workspace 一致')
        }
        if (c.idempotency_key !== undefined) {
          const hit = get<{ id: string }>(
            'SELECT id FROM tasks WHERE idempotency_key = ?',
            c.idempotency_key,
          )
          if (hit) {
            return fail('failure', 'idempotency_conflict', `幂等键已被任务 ${hit.id} 使用`, {
              task_id: hit.id,
            })
          }
        }
        return ok(null)
      }
      case 'task.started': {
        const expected = (task?.attempt ?? 0) + 1
        if (draft.payload.attempt !== expected) {
          return invalidEvent(`task.started 的 attempt 应为 ${expected}`)
        }
        return ok(null)
      }
      case 'task.reported': {
        const lease = get('SELECT * FROM leases WHERE lease_id = ?', draft.payload.lease_id) as
          | { task_id: string; state: string; attempt: number }
          | undefined
        if (
          draft.payload.attempt !== task?.attempt ||
          lease?.task_id !== draft.task_id ||
          lease?.state !== 'active'
        ) {
          return invalidEvent('上报必须属于当前活动派工')
        }
        return ok(null)
      }
      case 'task.report_consumed':
      case 'task.report_conflict': {
        const report = workerReport(
          draft.task_id ?? '',
          draft.payload.lease_id,
          draft.payload.attempt,
          draft.payload.report_seq,
        )
        if (!report || report.seq >= before || draft.payload.attempt !== task?.attempt) {
          return invalidEvent('消费确认必须引用本派工的上报')
        }
        return ok(null)
      }
      case 'task.attempt_ended': {
        if (draft.payload.attempt !== task?.attempt) {
          return invalidEvent('task.attempt_ended 的 attempt 必须是当前派工')
        }
        if (attemptEnded(draft.task_id ?? '', draft.payload.attempt, before)) {
          return invalidEvent('同一派工只能记录一次 task.attempt_ended')
        }
        return ok(null)
      }
      case 'lease.granted': {
        if (get('SELECT 1 FROM leases WHERE lease_id = ?', draft.payload.lease_id)) {
          return invalidEvent(`租约 ${draft.payload.lease_id} 已存在`)
        }
        if (
          get("SELECT 1 FROM leases WHERE task_id = ? AND state = 'active'", draft.task_id ?? null)
        ) {
          return fail('failure', 'invalid_transition', '任务已有活动租约，不能再次分配', {
            from: task?.status ?? null,
            type: draft.type,
          })
        }
        return ok(null)
      }
      case 'task.blocked': {
        // queued → blocked 只用于中枢判定隔离不可用（worker-credential-isolation 6.1）：不持有租约、不委托 supervisor。
        if (
          task?.status === 'queued' &&
          (draft.actor !== 'hub' ||
            draft.payload.reason !== 'other' ||
            draft.payload.lease_held === true ||
            !isIsolationUnavailable(draft.payload.message))
        ) {
          return noLease(
            'queued',
            draft.type,
            '排队中的任务只能由中枢以 isolation_unavailable 卡住',
          )
        }
        if (draft.payload.lease_held && !hasActiveLease(draft.task_id)) {
          return noLease(task?.status ?? null, draft.type, 'lease_held=true 要求任务仍有活动租约')
        }
        return ok(null)
      }
      case 'task.unblocked': {
        // D7a：没有活动租约就不能回到 running（否则成了"running 但无人持有"），应改为重新排队。
        if (!hasActiveLease(draft.task_id)) {
          return noLease(task?.status ?? null, draft.type, '任务没有活动租约，应改为重新排队')
        }
        if (draft.payload.reply_id !== undefined) return pendingReplyOf(draft)
        return ok(null)
      }
      case 'task.cancel_requested': {
        if (task?.status === 'blocked' && !hasActiveLease(draft.task_id)) {
          return noLease('blocked', draft.type, '没有节点持有该任务，应直接取消')
        }
        return ok(null)
      }
      case 'task.reply_fetched': {
        const pending = pendingReplyOf(draft)
        if (!pending.ok) return pending
        const reply = get<{ fetched_at: string | null }>(
          'SELECT fetched_at FROM replies WHERE id = ?',
          draft.payload.reply_id,
        )
        if (reply?.fetched_at != null) return invalidEvent('这条回复已经交给节点')
        const lease = get<{ task_id: string; state: string }>(
          'SELECT task_id, state FROM leases WHERE lease_id = ?',
          draft.payload.lease_id,
        )
        return lease && lease.task_id === draft.task_id && lease.state === 'active'
          ? ok(null)
          : invalidEvent(`租约 ${draft.payload.lease_id} 不是该任务的活动租约`)
      }
      case 'task.replied': {
        if (get('SELECT 1 FROM replies WHERE id = ?', draft.payload.reply_id)) {
          return invalidEvent(`回复 ${draft.payload.reply_id} 已存在`)
        }
        const pending = get<{ id: string }>(
          "SELECT id FROM replies WHERE task_id = ? AND state = 'pending'",
          draft.task_id ?? null,
        )
        if (pending) {
          return fail('failure', 'reply_pending', `任务已有尚未送达的回复 ${pending.id}`, {
            reply_id: pending.id,
          })
        }
        return validateReplyDelegation(draft)
      }
      case 'task.reply_dropped': {
        const reply = get<{ task_id: string; state: string }>(
          'SELECT task_id, state FROM replies WHERE id = ?',
          draft.payload.reply_id,
        )
        // dropped 保留给旧版账本重建：历史上自动丢弃后仍可能追加拒收通知。
        if (
          !reply ||
          reply.task_id !== draft.task_id ||
          !['pending', 'requeued', 'dropped'].includes(reply.state)
        ) {
          return invalidEvent('只能丢弃该任务待送达、重新排队或已丢弃的回复')
        }
        if (
          get(
            `SELECT 1 FROM events WHERE task_id = ? AND type = 'task.reply_dropped' AND json_extract(payload_json, '$.reply_id') = ? AND seq < ?`,
            draft.task_id ?? null,
            draft.payload.reply_id,
            before,
          )
        ) {
          return invalidEvent('这条回复已经记录拒收')
        }
        return ok(null)
      }
      case 'task.requeued': {
        if (draft.payload.reason !== 'input') return ok(null)
        // 恢复只由中枢写入，并且紧跟在同一任务对一条名单内人类评论的 task.input_added 之后。
        if (draft.actor !== 'hub') {
          return fail('failure', 'actor_mismatch', 'reason 为 input 的 task.requeued 只接受 hub')
        }
        const last = get<{ type: string; payload_json: string }>(
          'SELECT type, payload_json FROM events WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1',
          draft.task_id ?? null,
          before,
        )
        const input =
          last?.type === 'task.input_added'
            ? (JSON.parse(last.payload_json) as { pr_event_seq: number })
            : undefined
        const ev = input ? prEventRow(input.pr_event_seq) : null
        if (
          !input ||
          input.pr_event_seq !== draft.payload.pr_event_seq ||
          !ev ||
          !isAllowedHumanPrEvent(ev.payload)
        ) {
          return invalidEvent('因输入恢复必须紧跟名单内人类评论的 task.input_added')
        }
        return ok(null)
      }
      case 'task.requeued_with_reply':
        return pendingReplyOf(draft)
      case 'task.lease_expired': {
        if (task?.status === 'blocked' && !hasActiveLease(draft.task_id)) {
          return noLease('blocked', draft.type, '任务卡住时没有持有租约，不存在可过期的租约')
        }
        const lease = get<{ task_id: string; state: string }>(
          'SELECT task_id, state FROM leases WHERE lease_id = ?',
          draft.payload.lease_id,
        )
        if (!lease || lease.task_id !== draft.task_id || lease?.state !== 'active') {
          return invalidEvent(`租约 ${draft.payload.lease_id} 不是该任务的活动租约`)
        }
        return ok(null)
      }
      case 'inbox.item_created': {
        // 条目 id 由来源确定性生成：同一来源重复写入（反应器重放、重启续跑）在这里被拒绝。
        if (get('SELECT 1 FROM inbox_items WHERE id = ?', draft.payload.item_id)) {
          return fail('failure', 'duplicate_item', `收件箱条目 ${draft.payload.item_id} 已存在`, {
            item_id: draft.payload.item_id,
          })
        }
        return ok(null)
      }
      case 'inbox.pushed': {
        // 推送记录不检查条目状态：消息发出与条目关闭可能交错，已发出的消息必须如实入账。
        for (const itemId of draft.payload.item_ids) {
          if (!get('SELECT 1 FROM inbox_items WHERE id = ?', itemId)) {
            return fail('failure', 'not_found', `收件箱条目 ${itemId} 不存在`)
          }
          if (
            draft.payload.ref !== undefined &&
            draft.payload.op !== 'send' &&
            !get(
              'SELECT 1 FROM channel_messages WHERE channel = ? AND ref = ? AND item_id = ?',
              draft.payload.channel,
              draft.payload.ref,
              itemId,
            )
          ) {
            return invalidEvent(`条目 ${itemId} 不在渠道 ${draft.payload.channel} 的该消息中`)
          }
        }
        return ok(null)
      }
      case 'inbox.item_updated':
      case 'inbox.item_closed': {
        const item = get<{ state: string }>(
          'SELECT state FROM inbox_items WHERE id = ?',
          draft.payload.item_id,
        )
        if (!item) {
          return fail('failure', 'not_found', `收件箱条目 ${draft.payload.item_id} 不存在`)
        }
        if (item.state !== 'open') {
          return fail('failure', 'item_closed', `收件箱条目 ${draft.payload.item_id} 已关闭`, {
            item_id: draft.payload.item_id,
          })
        }
        return ok(null)
      }
      case 'task.reply_delegated':
        return validateDelegation(draft)
      case 'task.reply_observed':
        return validateObserved(draft)
      case 'task.reply_escalated': {
        // 身份按 reason 区分：user_replied / user_dismissed 只接受 user，其他原因只接受 hub。
        const expected = ESCALATION_BY_USER.has(draft.payload.reason) ? 'user' : 'hub'
        if (draft.actor !== expected) {
          return fail(
            'failure',
            'actor_mismatch',
            `reason 为 ${draft.payload.reason} 的 task.reply_escalated 只接受 ${expected} 身份写入（实际为 ${draft.actor}）`,
            { type: draft.type, actor: draft.actor, reason: draft.payload.reason },
          )
        }
        // 只能结束当前这次卡住上仍有效的委托：任务离开该次卡住（含进入新的卡住）后委托已隐式失效，
        // 不再写转交事件（activeDelegation）。
        const last = lastBlocked(draft.task_id)
        if (!last || last.seq !== draft.payload.block_seq) {
          return invalidEvent(`block_seq ${draft.payload.block_seq} 不是该任务当前的卡住`)
        }
        const active = currentDelegation(draft.task_id)
        if (!active || active.block_seq !== draft.payload.block_seq) {
          return fail('failure', 'not_delegated', '这次卡住没有仍有效的 supervisor 委托', {
            block_seq: draft.payload.block_seq,
          })
        }
        const p = draft.payload
        if (
          (p.dropped_reply_id !== undefined || p.to_version !== undefined) &&
          p.reason !== 'policy_changed'
        ) {
          return invalidEvent('只有策略变化转交可以撤回批准或记录新策略版本')
        }
        if (p.dropped_reply_id !== undefined) {
          const reply = get<{
            task_id: string
            state: string
            by: string
            kind: string
            fetched_at: string | null
          }>(
            'SELECT task_id, state, by, kind, fetched_at FROM replies WHERE id = ?',
            p.dropped_reply_id,
          )
          if (
            active.kind !== 'awaiting_approval' ||
            !reply ||
            reply.task_id !== draft.task_id ||
            reply.state !== 'pending' ||
            reply.fetched_at !== null ||
            reply.by !== SUPERVISOR ||
            reply.kind !== 'approve'
          ) {
            return invalidEvent(`回复 ${p.dropped_reply_id} 不是该委托尚未送达的 supervisor 批准`)
          }
        }
        return ok(null)
      }
      case 'task.branch_reported': {
        // D15：只有自己创建并拥有任务分支的适配器上报（push_to: task_branch、gh_scope --head 据此放行，
        // 不能把工作目录里用户检出的分支当成任务分支）；只接受当前租约持有节点写入，且不可改写。
        const row = get<{
          contract_json: string
          branch: string | null
          worktree: string | null
        }>('SELECT contract_json, branch, worktree FROM tasks WHERE id = ?', draft.task_id ?? null)
        const executor = row
          ? (JSON.parse(row.contract_json) as { executor?: string }).executor
          : null
        if (!executor || !BRANCH_OWNING_EXECUTORS.has(executor)) {
          return invalidEvent(
            `只有创建任务分支的执行器（${[...BRANCH_OWNING_EXECUTORS].join('、')}）上报任务分支（该任务执行器为 ${executor}）`,
          )
        }
        const lease = get<{ node_id: string }>(
          "SELECT node_id FROM leases WHERE task_id = ? AND state = 'active'",
          draft.task_id ?? null,
        )
        if (!lease || draft.actor !== `node:${lease.node_id}`) {
          return fail(
            'failure',
            'invalid_lease_token',
            '只有持有该任务活动租约的节点能上报任务分支',
            { task_id: draft.task_id },
          )
        }
        // worktree 缺失的旧任务（G9 之前上报）可以补报一次：分支必须相同，补上 worktree 与快照。
        const backfill =
          row?.branch != null &&
          row.worktree == null &&
          draft.payload.worktree !== undefined &&
          draft.payload.branch === row.branch
        if (backfill && draft.payload.repo_snapshot !== undefined) {
          return invalidEvent('补报只补 worktree，不补登记仓库快照')
        }
        if (row?.branch != null && !backfill) {
          return fail('failure', 'invalid_transition', '任务分支已上报，不能更改', {
            from: task?.status ?? null,
            type: draft.type,
          })
        }
        return ok(null)
      }
      case 'supervisor.wake_started': {
        // 必须与唤醒任务的 task.created 在同一次 appendMany 中写入（D1：唤醒身份以本事件为准，
        // 不能留下"已建但没有 wake_started"的窗口）；这里要求任务创建后还没有其他任务事件。
        // store 不读角色配置：唤醒调度器（supervisor/scheduler.ts）在 createTask 前用 findSupervisorRole
        // （按 effectiveRoleKind）确认唯一的、只读的 supervisor 角色；createTask 再按有效类别只许 hub 建。
        const p = draft.payload
        if (p.task_id !== draft.task_id || p.workspace !== draft.workspace) {
          return invalidEvent('supervisor.wake_started 的 task_id、workspace 必须与信封一致')
        }
        const dup = get<{ seq: number }>(
          `SELECT seq FROM events WHERE type = 'supervisor.wake_started' AND task_id = ?
             AND seq < ? LIMIT 1`,
          draft.task_id ?? null,
          before,
        )
        if (dup) {
          return fail('failure', 'duplicate_wake', '该任务已记录为唤醒任务', { seq: dup.seq })
        }
        const row = get<{ created_seq: number; last_seq: number }>(
          'SELECT created_seq, last_seq FROM tasks WHERE id = ?',
          draft.task_id ?? null,
        )
        if (!row || row.created_seq !== row.last_seq) {
          return invalidEvent('supervisor.wake_started 必须紧随唤醒任务的 task.created 写入')
        }
        const max = get<{ g: number | null }>(
          `SELECT MAX(json_extract(payload_json, '$.generation')) AS g FROM events
           WHERE type = 'supervisor.wake_started' AND workspace = ? AND seq < ?`,
          draft.workspace ?? null,
          before,
        )?.g
        if (max != null && p.generation <= max) {
          return fail(
            'failure',
            'duplicate_wake',
            `唤醒代数必须严格递增：${draft.workspace} 已有第 ${max} 代`,
            { generation: max },
          )
        }
        return ok(null)
      }
      case 'task.input_added': {
        const ev = prEventRow(draft.payload.pr_event_seq)
        if (!ev || ev.workspace !== draft.workspace) {
          return invalidEvent(
            `pr_event_seq ${draft.payload.pr_event_seq} 不是本 workspace 的 PR 事件`,
          )
        }
        // 只送给事件发生前就已订阅的任务：后来才订阅的任务不能收到（或被重放）更早的 PR 事件。
        if (
          !get(
            `SELECT 1 FROM pr_subscriptions WHERE task_id = ? AND pr = ? AND state = 'active'
               AND subscribed_seq < ?`,
            draft.task_id ?? null,
            ev.payload.pr,
            ev.seq,
          )
        ) {
          return fail(
            'failure',
            'not_subscribed',
            `任务在该事件之前没有有效的 ${ev.payload.pr} 订阅`,
          )
        }
        if (
          get(
            'SELECT 1 FROM task_inputs WHERE task_id = ? AND pr_event_seq = ?',
            draft.task_id ?? null,
            draft.payload.pr_event_seq,
          )
        ) {
          return fail('failure', 'duplicate_input', '这条 PR 事件已送给该任务')
        }
        // 已结束的任务只能因名单内的人类评论恢复（紧接着同一事务写 task.requeued{reason: input}）。
        if (
          (task?.status === 'done' || task?.status === 'failed') &&
          !isAllowedHumanPrEvent(ev.payload)
        ) {
          return fail(
            'failure',
            'not_allowed_input',
            '机器人、CI 与名单外用户的内容不能恢复已结束的任务',
          )
        }
        return ok(null)
      }
      case 'task.input_delivered': {
        const lease = get<{ node_id: string }>(
          "SELECT node_id FROM leases WHERE lease_id = ? AND task_id = ? AND state = 'active'",
          draft.payload.lease_id,
          draft.task_id ?? null,
        )
        if (!lease) return invalidEvent(`租约 ${draft.payload.lease_id} 不是该任务的活动租约`)
        for (const seq of draft.payload.input_seqs) {
          if (
            !get(
              "SELECT 1 FROM task_inputs WHERE seq = ? AND task_id = ? AND state = 'pending'",
              seq,
              draft.task_id ?? null,
            )
          ) {
            return invalidEvent(`输入 ${seq} 不是该任务待送达的输入`)
          }
        }
        return ok(null)
      }
      case 'pr.wake_requested': {
        // 只有名单内的人类评论能唤醒 supervisor（store 兜底，调用方另有检查）。
        const ev = prEventRow(draft.payload.pr_event_seq)
        if (!ev || ev.workspace !== draft.workspace) {
          return invalidEvent(
            `pr_event_seq ${draft.payload.pr_event_seq} 不是本 workspace 的 PR 事件`,
          )
        }
        if (!ev.payload.allowed || ev.payload.actor_kind !== 'human') {
          return fail('failure', 'not_allowed_input', '只有名单内用户的人类评论能唤醒 supervisor')
        }
        if (draft.payload.reason !== 'no_subscriber' && draft.task_id === undefined) {
          return invalidEvent(`reason 为 ${draft.payload.reason} 时必须带 task_id`)
        }
        if (draft.payload.reason === 'handback' && !taskHasInput(draft.task_id, ev.seq)) {
          return fail('failure', 'handback_invalid', '只能交回本任务收到过的 PR 事件')
        }
        if (wakeRequested(ev.seq, draft.payload.reason, draft.task_id)) {
          return fail('failure', 'duplicate_event', '这条 PR 事件已经请求过唤醒')
        }
        return ok(null)
      }
      case 'pr.subscribed':
      case 'pr.unsubscribed': {
        if (normalizePrUrl(draft.payload.pr) !== draft.payload.pr) {
          return invalidEvent('PR 链接必须是规范化形式')
        }
        if (!task) return fail('failure', 'not_found', `没有任务 ${draft.task_id}`)
        const active = get(
          `SELECT 1 FROM pr_subscriptions WHERE task_id = ? AND pr = ? AND state = 'active'`,
          draft.task_id ?? null,
          draft.payload.pr,
        )
        if (draft.type === 'pr.subscribed' && active) {
          return fail('failure', 'duplicate_subscription', `任务已订阅 ${draft.payload.pr}`)
        }
        if (draft.type === 'pr.unsubscribed' && !active) {
          return fail('failure', 'not_subscribed', `任务没有有效的 ${draft.payload.pr} 订阅`)
        }
        // 用户只能以 user 原因取消；中枢判定的原因只由中枢写入。
        if (
          draft.type === 'pr.unsubscribed' &&
          (draft.actor === 'user') !== (draft.payload.reason === 'user')
        ) {
          return fail(
            'failure',
            'actor_mismatch',
            'reason 为 user 的取消只接受 user，其余原因只接受 hub',
          )
        }
        return ok(null)
      }
      case 'pr.event':
        return normalizePrUrl(draft.payload.pr) === draft.payload.pr
          ? ok(null)
          : invalidEvent('PR 链接必须是规范化形式')
      case 'supervisor.scheduler_initialized':
        // 只写一次：重复写入会让"初始化之前的事件"边界后移，丢掉真实指令。
        // 重建时重放的事件自身已在表中：只看更早的。
        return get(
          `SELECT 1 FROM events WHERE type = 'supervisor.scheduler_initialized' AND seq < ? LIMIT 1`,
          (draft as { seq?: number }).seq ?? Number.MAX_SAFE_INTEGER,
        )
          ? fail('failure', 'duplicate_event', '唤醒调度器已初始化')
          : ok(null)
      case 'schedule.fired': {
        const dup = get(
          'SELECT 1 FROM schedule_fires WHERE rule_id = ? AND planned_at = ?',
          draft.payload.rule_id,
          draft.payload.planned_at,
        )
        return dup
          ? fail('failure', 'duplicate_fire', `规则 ${draft.payload.rule_id} 在该计划时间已触发`)
          : ok(null)
      }
      default:
        return ok(null)
    }
  }

  /** 唤醒任务的账本记录（`supervisor.wake_started`）；`wakeOf` 与 `wakeOrigin` 共用。 */
  function wakeRecordOf(taskId: string): WakeRecord | null {
    const r = get<{ seq: number; workspace: string; payload_json: string }>(
      `SELECT seq, workspace, payload_json FROM events
         WHERE type = 'supervisor.wake_started' AND task_id = ? ORDER BY seq LIMIT 1`,
      taskId,
    )
    if (!r) return null
    const p = JSON.parse(r.payload_json) as {
      origin: WakeOrigin
      generation: number
      events?: number[]
      source?: 'pr'
    }
    return {
      task_id: taskId,
      workspace: r.workspace,
      origin: p.origin,
      generation: p.generation,
      seq: r.seq,
      events: p.events ?? [],
      ...(p.source === 'pr' ? { source: 'pr' as const } : {}),
    }
  }

  const insertEvent = db.prepare(
    `INSERT INTO events (ts, type, workspace, task_id, actor, payload_json)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`,
  )

  /** 事务内：校验 → 插入 → apply。不合法时抛出 Abort 让事务回滚。 */
  function writeOne(raw: unknown, ts: string): LedgerEvent {
    // 先脱敏再校验：脱敏后的载荷仍须符合 schema。
    const parsed = parseLedgerEventDraft(
      raw !== null && typeof raw === 'object' && 'payload' in raw
        ? {
            ...raw,
            payload: scrubPayload(
              String((raw as { type?: unknown }).type),
              (raw as { payload: unknown }).payload,
              redact,
            ),
          }
        : raw,
    )
    if (!parsed.ok) throw new Abort(parsed)
    const draft = parsed.data
    const valid = validate(draft)
    if (!valid.ok) throw new Abort(valid)
    const row = insertEvent.get(
      ts,
      draft.type,
      draft.workspace ?? null,
      draft.task_id ?? null,
      draft.actor,
      JSON.stringify(draft.payload),
    ) as { seq: number }
    const event = { ...draft, seq: row.seq, ts } as LedgerEvent
    apply(event)
    return event
  }

  function notify(events: readonly LedgerEvent[]) {
    for (const event of events) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch {
          // 订阅者的异常不影响写入方与其他订阅者。
        }
      }
    }
  }

  /** 在事务中执行 fn；Abort 转为失败结果，其他异常原样抛出。 */
  function inTransaction<T>(fn: () => T): Result<T> {
    try {
      return ok(db.transaction(fn))
    } catch (err) {
      if (err instanceof Abort) return err.result
      throw err
    }
  }

  function appendMany(drafts: readonly EventInput[], o: AppendOptions): Result<LedgerEvent[]> {
    if (drafts.length === 0) return ok([])
    if (o.actors !== undefined && o.actors.length !== drafts.length) {
      return fail(
        'usage',
        'invalid_arguments',
        `actors 的长度 ${o.actors.length} 与事件数 ${drafts.length} 不一致`,
      )
    }
    const ts = iso()
    const result = inTransaction(() => {
      if (o.check) {
        const checked = o.check()
        if (!checked.ok) throw new Abort(checked)
      }
      return drafts.map((d, i) => {
        // 已结束任务上的输入只能与恢复同一事务写入，并紧跟 task.requeued{reason: input}。
        if (d.type === 'task.input_added' && d.task_id !== undefined) {
          const status = taskState(d.task_id)?.status
          const next = drafts[i + 1]
          if (
            (status === 'done' || status === 'failed') &&
            !(
              next?.type === 'task.requeued' &&
              next.task_id === d.task_id &&
              (next.payload as { reason?: string }).reason === 'input'
            )
          ) {
            throw new Abort(
              invalidEvent(
                '已结束任务上的 task.input_added 必须在同一事务中紧跟 task.requeued{reason: input}',
              ),
            )
          }
        }
        return writeOne({ ...d, actor: o.actors?.[i] ?? o.actor }, ts)
      })
    })
    if (result.ok) notify(result.data)
    return result
  }

  function eventsAfter(after: number, filter: EventFilter = {}, limit = 500): LedgerEvent[] {
    const where = ['seq > ?']
    const params: SqlValue[] = [after]
    if (filter.task_id !== undefined) {
      where.push('task_id = ?')
      params.push(filter.task_id)
    }
    if (filter.workspace !== undefined) {
      where.push('workspace = ?')
      params.push(filter.workspace)
    }
    params.push(limit)
    return all<EventRow>(
      `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`,
      ...params,
    ).map(rowToEvent)
  }

  function rebuild(o: RebuildOptions = {}): Result<RebuildData> {
    const started = nowMs()
    let replayed: LedgerEvent[] = []
    try {
      replayed = db.transaction(() => {
        for (const table of PROJECTION_TABLES) run(`DELETE FROM ${table}`)
        let count = 0
        let after = 0
        for (;;) {
          const batch = eventsAfter(after, {}, 1000)
          if (batch.length === 0) break
          for (const event of batch) {
            // 新版本写入的事件保留在账本中，旧版本不校验、不折叠未知类型。
            if (!Object.hasOwn(eventPayloads, event.type)) continue
            // 重放时同样校验，账本自相矛盾时整体回滚，保留原投影。
            const valid = validate(event)
            if (!valid.ok) {
              throw new Abort(
                fail(
                  'failure',
                  'ledger_inconsistent',
                  `重放到 seq ${event.seq}（${event.type}）时校验失败：${valid.error.message}`,
                  { seq: event.seq, error: valid.error },
                ),
              )
            }
            apply(event)
          }
          count += batch.length
          after = batch[batch.length - 1]?.seq ?? after
        }
        // 软状态（D2）：清空活动与心跳；活动租约的到期时间重置为"重建时刻 + TTL"。
        const now = nowMs()
        run("UPDATE tasks SET last_activity_at = NULL, activity_json = '[]'")
        run('UPDATE nodes SET last_seen_at = NULL')
        for (const l of all<{ lease_id: string; ttl_s: number }>(
          "SELECT lease_id, ttl_s FROM leases WHERE state = 'active'",
        )) {
          const ttl = o.leaseTtlS ?? l.ttl_s
          run(
            'UPDATE leases SET expires_at = ? WHERE lease_id = ?',
            iso(now + ttl * 1000),
            l.lease_id,
          )
        }
        const marker = writeOne(
          {
            type: 'hub.rebuilt',
            actor: o.actor ?? 'hub',
            payload: { events_replayed: count, duration_ms: Math.max(0, now - started) },
          },
          iso(now),
        )
        return [marker]
      })
    } catch (err) {
      if (err instanceof Abort) return err.result
      return fail('failure', 'internal_error', `重建失败：${(err as Error).message}`)
    }
    notify(replayed)
    const marker = replayed[0] as Extract<LedgerEvent, { type: 'hub.rebuilt' }>
    return ok({ ...marker.payload, ledger_seq: marker.seq })
  }

  const leaseRow = (r: LeaseRecord | undefined) => r ?? null

  return {
    seq: () => get<{ s: number }>('SELECT COALESCE(MAX(seq), 0) AS s FROM events')?.s ?? 0,
    eventsAfter,
    latestEvent(beforeSeq, type) {
      const row = get<EventRow>(
        'SELECT * FROM events WHERE seq < ? AND (? IS NULL OR type = ?) ORDER BY seq DESC LIMIT 1',
        beforeSeq ?? Number.MAX_SAFE_INTEGER,
        type ?? null,
        type ?? null,
      )
      return row ? rowToEvent(row) : null
    },
    recentEvents(workspace, types, limit) {
      if (types.length === 0 || limit <= 0) return []
      return all<EventRow>(
        `SELECT * FROM events WHERE workspace = ? AND type IN (${types.map(() => '?').join(', ')})
           ORDER BY seq DESC LIMIT ?`,
        workspace,
        ...types,
        limit,
      ).map(rowToEvent)
    },
    countAutoDecisions(sinceIso) {
      return (
        get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM events WHERE type = 'policy.decided' AND ts >= ?
             AND json_extract(payload_json, '$.level') IN ('auto', 'auto-report')`,
          sinceIso,
        )?.n ?? 0
      )
    },
    eventsBetween(type, fromIso, toIso, limit = 1000, afterSeq = 0) {
      return all<EventRow>(
        'SELECT * FROM events WHERE type = ? AND ts >= ? AND ts < ? AND seq > ? ORDER BY seq LIMIT ?',
        type,
        fromIso,
        toIso,
        afterSeq,
        limit,
      ).map(rowToEvent)
    },
    hasScheduleFire(ruleId, plannedAt) {
      return !!get(
        'SELECT 1 FROM schedule_fires WHERE rule_id = ? AND planned_at = ?',
        ruleId,
        plannedAt,
      )
    },
    eventsByPayload(type, key, value) {
      if (!/^[a-z_]+$/.test(key)) return []
      return all<EventRow>(
        `SELECT * FROM events WHERE type = ? AND json_extract(payload_json, '$.${key}') = ?
         ORDER BY seq`,
        type,
        value,
      ).map(rowToEvent)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    append(draft, o) {
      const r = appendMany([draft], o)
      return r.ok ? ok(r.data[0] as LedgerEvent) : r
    },
    appendMany,
    rebuild,

    getTask(id) {
      const r = get<TaskRow>(`${TASK_SELECT} WHERE t.id = ?`, id)
      return r ? rowToTask(r) : null
    },
    listTasks(filter = {}) {
      const where: string[] = []
      const params: SqlValue[] = []
      for (const key of ['workspace', 'status', 'parent'] as const) {
        const v = filter[key]
        if (v !== undefined) {
          where.push(`t.${key} = ?`)
          params.push(v)
        }
      }
      if (filter.pr !== undefined) {
        where.push(
          `t.id IN (SELECT task_id FROM task_prs WHERE pr = ?${filter.workspace === undefined ? '' : ' AND workspace = ?'})`,
        )
        params.push(normalizePrUrl(filter.pr) ?? '')
        if (filter.workspace !== undefined) params.push(filter.workspace)
      }
      if (filter.open_only) {
        where.push(`t.status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})`)
        params.push(...TERMINAL_STATUSES)
      }
      if (filter.exclude_ids !== undefined && filter.exclude_ids.length > 0) {
        // 用 json_each 传入整组 id，避免超出 SQLite 参数个数上限。
        where.push('t.id NOT IN (SELECT value FROM json_each(?))')
        params.push(JSON.stringify(filter.exclude_ids))
      }
      params.push(filter.limit ?? 50, filter.offset ?? 0)
      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      return all<TaskRow>(
        `${TASK_SELECT} ${clause} ORDER BY t.created_seq DESC LIMIT ? OFFSET ?`,
        ...params,
      ).map(rowToTask)
    },
    openTasks(workspace, limit) {
      return all<TaskRow>(
        `${TASK_SELECT} WHERE t.workspace = ? AND t.status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})
           ORDER BY t.updated_at DESC, t.id ASC LIMIT ?`,
        workspace,
        ...TERMINAL_STATUSES,
        limit,
      ).map(rowToTask)
    },
    queuedTasks() {
      return all<TaskRow>(
        `${TASK_SELECT} WHERE t.status = 'queued' ORDER BY t.created_seq ASC`,
      ).map(rowToTask)
    },
    findTaskByIdempotencyKey(key) {
      const r = get<TaskRow>(`${TASK_SELECT} WHERE t.idempotency_key = ?`, key)
      return r ? rowToTask(r) : null
    },
    wakeOf: wakeRecordOf,
    eventTaskIds(seqs) {
      if (seqs.length === 0) return []
      const rows = all<{ task_id: string }>(
        `SELECT DISTINCT task_id FROM events
         WHERE task_id IS NOT NULL AND seq IN (${seqs.map(() => '?').join(', ')})`,
        ...seqs,
      )
      return rows.map((r) => r.task_id)
    },
    countChildren(parentId, createdBy) {
      return (
        get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM tasks WHERE parent = ? AND created_by = ?',
          parentId,
          createdBy,
        )?.n ?? 0
      )
    },
    countChangesRequested(workspace, pr, roles) {
      if (roles.length === 0) return 0
      return (
        get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE workspace = ?
             AND lower(json_extract(contract_json, '$.inputs.review.pr')) = lower(?)
             AND json_extract(contract_json, '$.executor') = 'claude-sdk'
             AND json_extract(contract_json, '$.role') IN (${roles.map(() => '?').join(', ')})
             AND json_extract(result_json, '$.review.verdict') = 'changes_requested'`,
          workspace,
          pr,
          ...roles,
        )?.n ?? 0
      )
    },
    tasksForPr(workspace, pr, limit = 50, offset = 0) {
      const normalized = normalizePrUrl(pr)
      if (!normalized) return []
      return all<TaskRow>(
        `${TASK_SELECT} JOIN task_prs p ON p.task_id = t.id WHERE p.workspace = ? AND p.pr = ? ORDER BY t.created_seq DESC LIMIT ? OFFSET ?`,
        workspace,
        normalized,
        limit,
        offset,
      ).map(rowToTask)
    },
    prTasksSummary(workspace, pr) {
      const row = get<{ count: number; chars: number }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(p.summary_chars + length(t.status)), 0) + MAX(COUNT(*) - 1, 0) + 2 AS chars
         FROM task_prs p JOIN tasks t ON t.id = p.task_id WHERE p.workspace = ? AND p.pr = ?`,
        workspace,
        normalizePrUrl(pr) ?? '',
      )
      return row ?? { count: 0, chars: 2 }
    },
    taskPrs(taskId) {
      return all<{ url: string }>(
        'SELECT url FROM task_prs WHERE task_id = ? ORDER BY pr',
        taskId,
      ).map((row) => row.url)
    },
    prSubscriptions(taskId) {
      return all<PrSubscriptionRow>(
        'SELECT * FROM pr_subscriptions WHERE task_id = ? ORDER BY subscribed_seq',
        taskId,
      ).map(rowToSubscription)
    },
    activePrSubscriptions(workspace) {
      return all<PrSubscriptionRow>(
        `SELECT * FROM pr_subscriptions WHERE state = 'active' AND (? IS NULL OR workspace = ?)
         ORDER BY subscribed_seq`,
        workspace ?? null,
        workspace ?? null,
      ).map((r) => ({ ...rowToSubscription(r), workspace: r.workspace }))
    },
    prEventCursorsSince(workspace, pr, kind, sinceIso) {
      return all<{ cursor: string }>(
        `SELECT json_extract(payload_json, '$.cursor') AS cursor FROM events
         WHERE type = 'pr.event' AND workspace = ? AND json_extract(payload_json, '$.pr') = ?
           AND json_extract(payload_json, '$.kind') = ? AND json_extract(payload_json, '$.cursor') >= ?`,
        workspace,
        pr,
        kind,
        sinceIso,
      ).map((r) => r.cursor)
    },
    prEvent(seq) {
      const row = get<EventRow>("SELECT * FROM events WHERE seq = ? AND type = 'pr.event'", seq)
      return row ? (rowToEvent(row) as EventOf<'pr.event'>) : null
    },
    recentPrEvents(sinceIso) {
      return all<EventRow>(
        "SELECT * FROM events WHERE type = 'pr.event' AND ts >= ? ORDER BY seq",
        sinceIso,
      ).map((r) => rowToEvent(r) as EventOf<'pr.event'>)
    },
    prDispatchedUpTo() {
      // 无缺口的检查点：第一条还没有 pr.dispatched 的 pr.event 之前（处理失败或追赶中的事件不会被跳过）。
      const first = get<{ s: number | null }>(
        `SELECT MIN(e.seq) AS s FROM events e WHERE e.type = 'pr.event' AND NOT EXISTS (
           SELECT 1 FROM events d WHERE d.type = 'pr.dispatched'
             AND json_extract(d.payload_json, '$.pr_event_seq') = e.seq)`,
      )?.s
      if (first != null) return first - 1
      return (
        get<{ s: number | null }>("SELECT MAX(seq) AS s FROM events WHERE type = 'pr.event'")?.s ??
        0
      )
    },
    prIsDispatched(prEventSeq) {
      return !!get(
        `SELECT 1 FROM events WHERE type = 'pr.dispatched'
           AND json_extract(payload_json, '$.pr_event_seq') = ? LIMIT 1`,
        prEventSeq,
      )
    },
    prEventsAfter(after, limit) {
      return all<EventRow>(
        "SELECT * FROM events WHERE type = 'pr.event' AND seq > ? ORDER BY seq LIMIT ?",
        after,
        limit,
      ).map((r) => rowToEvent(r) as EventOf<'pr.event'>)
    },
    prWakeRequested(prEventSeq, reason, taskId) {
      return wakeRequested(prEventSeq, reason, taskId)
    },
    pendingTaskInputs(taskId, limit = 50) {
      return all<{ seq: number; pr_event_seq: number }>(
        "SELECT seq, pr_event_seq FROM task_inputs WHERE task_id = ? AND state = 'pending' ORDER BY seq LIMIT ?",
        taskId,
        limit,
      )
    },
    taskHasPrInput(taskId, prEventSeq) {
      return !!get(
        'SELECT 1 FROM task_inputs WHERE task_id = ? AND pr_event_seq = ?',
        taskId,
        prEventSeq,
      )
    },
    prCursors(workspace, pr) {
      return Object.fromEntries(
        all<{ kind: string; cursor: string }>(
          'SELECT kind, cursor FROM pr_cursors WHERE workspace = ? AND pr = ?',
          workspace,
          pr,
        ).map((r) => [r.kind, r.cursor]),
      )
    },
    prRelatedTasks(workspace, prNumber, limit) {
      return all<TaskRow>(
        `${TASK_SELECT} WHERE t.id IN (SELECT task_id FROM task_prs WHERE workspace = ? AND pr_number = ?) ORDER BY t.created_seq ASC LIMIT ?`,
        workspace,
        Math.trunc(prNumber),
        limit,
      ).map(rowToTask)
    },
    taskEvents(taskId) {
      return taskEventsOf(taskId)
    },
    latestTaskEvent,
    replyBlock(taskId, replyId) {
      const reply = get<{ seq: number }>(
        `SELECT seq FROM events WHERE task_id = ? AND type = 'task.replied'
           AND json_extract(payload_json, '$.reply_id') = ? ORDER BY seq LIMIT 1`,
        taskId,
        replyId,
      )
      if (!reply) return undefined
      const block = latestTaskEvent(taskId, 'task.blocked', reply.seq)
      return block?.type === 'task.blocked'
        ? {
            block_seq: block.seq,
            ...(block.payload.approval_fingerprint
              ? { approval_fingerprint: block.payload.approval_fingerprint }
              : {}),
          }
        : undefined
    },
    attemptEnded,
    workerReport,
    workerReportConflict(taskId, leaseId, attempt, seq) {
      return !!get(
        `SELECT 1 FROM events WHERE task_id = ? AND type = 'task.report_conflict'
           AND json_extract(payload_json, '$.lease_id') = ?
           AND json_extract(payload_json, '$.attempt') = ?
           AND json_extract(payload_json, '$.report_seq') = ? LIMIT 1`,
        taskId,
        leaseId,
        attempt,
        seq,
      )
    },
    latestWorkerReport(taskId, leaseId, attempt) {
      const row = get<EventRow>(
        `SELECT * FROM events WHERE task_id = ? AND type = 'task.reported'
           AND json_extract(payload_json, '$.lease_id') = ?
           AND json_extract(payload_json, '$.attempt') = ? ORDER BY seq DESC LIMIT 1`,
        taskId,
        leaseId,
        attempt,
      )
      return row ? (rowToEvent(row) as EventOf<'task.reported'>) : null
    },
    workerReportWatermark(taskId, leaseId, attempt) {
      return (
        get<{ watermark: number }>(
          `SELECT COALESCE(MAX(json_extract(payload_json, '$.report_seq')), 0) AS watermark
         FROM events WHERE task_id = ? AND type = 'task.report_consumed'
           AND json_extract(payload_json, '$.lease_id') = ?
           AND json_extract(payload_json, '$.attempt') = ?`,
          taskId,
          leaseId,
          attempt,
        )?.watermark ?? 0
      )
    },
    workerReportUsage(taskId, leaseId, attempt, sinceIso) {
      return (
        get<{ total: number; recent: number }>(
          `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END), 0) AS recent
         FROM events WHERE task_id = ? AND type = 'task.reported'
           AND json_extract(payload_json, '$.lease_id') = ?
           AND json_extract(payload_json, '$.attempt') = ?`,
          sinceIso,
          taskId,
          leaseId,
          attempt,
        ) ?? { total: 0, recent: 0 }
      )
    },
    activeDelegation(taskId) {
      return currentDelegation(taskId)
    },
    wakeOrigin: (taskId) => wakeRecordOf(taskId)?.origin ?? null,
    getNode(nodeId) {
      const r = get<NodeRow>(`${NODE_SELECT} WHERE n.node_id = ?`, nodeId)
      return r ? rowToNode(r) : null
    },
    listNodes() {
      return all<NodeRow>(`${NODE_SELECT} ORDER BY n.node_id`).map(rowToNode)
    },
    getLease(leaseId) {
      return leaseRow(get<LeaseRecord>('SELECT * FROM leases WHERE lease_id = ?', leaseId))
    },
    activeLease(taskId) {
      return leaseRow(
        get<LeaseRecord>("SELECT * FROM leases WHERE task_id = ? AND state = 'active'", taskId),
      )
    },
    activeLeases() {
      return all<LeaseRecord>("SELECT * FROM leases WHERE state = 'active' ORDER BY expires_at")
    },
    pendingReply(taskId) {
      const r = get<ReplyRow>(
        "SELECT * FROM replies WHERE task_id = ? AND state = 'pending' ORDER BY created_seq LIMIT 1",
        taskId,
      )
      return r ? rowToReply(r) : null
    },
    replyPredatesDeliveryTracking,
    getReply(replyId) {
      const r = get<ReplyRow>('SELECT * FROM replies WHERE id = ?', replyId)
      return r ? rowToReply(r) : null
    },
    taskReplies(taskId) {
      return all<ReplyRow>(
        'SELECT * FROM replies WHERE task_id = ? ORDER BY created_seq',
        taskId,
      ).map(rowToReply)
    },
    taskResume(taskId) {
      const r = get<{ resume_json: string | null }>(
        'SELECT resume_json FROM tasks WHERE id = ?',
        taskId,
      )
      return r?.resume_json ? (JSON.parse(r.resume_json) as TaskResume) : null
    },

    getInboxItem(itemId) {
      const r = /^[0-9a-z]{1,11}$/.test(itemId)
        ? get<InboxRow>(
            'SELECT * FROM inbox_items WHERE created_seq = ?',
            Number.parseInt(itemId, 36),
          )
        : get<InboxRow>('SELECT * FROM inbox_items WHERE id = ?', itemId)
      return r ? rowToInbox(r) : null
    },
    getInboxItemByShortId(shortId) {
      if (!/^[0-9a-z]{1,12}$/.test(shortId)) return null
      const seq = Number.parseInt(shortId, 36)
      if (!Number.isSafeInteger(seq)) return null
      const r = get<InboxRow>('SELECT * FROM inbox_items WHERE created_seq = ?', seq)
      return r ? rowToInbox(r) : null
    },
    channelMessageItems(channel, ref) {
      return all<{ item_id: string }>(
        `SELECT m.item_id FROM channel_messages m JOIN inbox_items i ON i.id = m.item_id
         WHERE m.channel = ? AND m.ref = ? AND m.ref != '' ORDER BY i.created_seq`,
        channel,
        ref,
      ).map((r) => r.item_id)
    },
    pendingChannelUpdates(channel) {
      const rows = all<{ ref: string; item_id: string }>(
        `SELECT m.ref, m.item_id FROM channel_messages m JOIN inbox_items i ON i.id = m.item_id
         WHERE m.channel = ? AND m.synced_at IS NULL AND m.ref != '' AND i.state = 'closed'
         ORDER BY m.sent_seq, i.created_seq`,
        channel,
      )
      const out = new Map<string, string[]>()
      for (const r of rows) out.set(r.ref, [...(out.get(r.ref) ?? []), r.item_id])
      return [...out].map(([ref, item_ids]) => ({ ref, item_ids }))
    },
    channelFailedCount(channel) {
      return (
        get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM channel_messages WHERE channel = ? AND failed_at IS NOT NULL',
          channel,
        )?.n ?? 0
      )
    },
    listInboxItems(filter = {}) {
      const where: string[] = []
      const params: SqlValue[] = []
      for (const key of ['state', 'level', 'workspace', 'task_id', 'source'] as const) {
        const v = filter[key]
        if (v !== undefined) {
          where.push(`${key} = ?`)
          params.push(v)
        }
      }
      params.push(filter.limit ?? 200)
      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      return all<InboxRow>(
        `SELECT * FROM inbox_items ${clause} ORDER BY ${LEVEL_ORDER}, created_seq LIMIT ?`,
        ...params,
      ).map(rowToInbox)
    },
    inboxCursor() {
      return (
        get<{ s: number }>(
          `SELECT MAX(COALESCE(MAX(source_seq), 0), COALESCE(MAX(cause_seq), 0)) AS s
           FROM inbox_items`,
        )?.s ?? 0
      )
    },

    touchNode(nodeId, at = iso()) {
      if (!get('SELECT 1 FROM nodes WHERE node_id = ?', nodeId)) return false
      run('UPDATE nodes SET last_seen_at = ? WHERE node_id = ?', at, nodeId)
      return true
    },
    renewLease(leaseId, expiresAt) {
      if (!get("SELECT 1 FROM leases WHERE lease_id = ? AND state = 'active'", leaseId))
        return false
      run('UPDATE leases SET expires_at = ? WHERE lease_id = ?', expiresAt, leaseId)
      return true
    },
    extendActiveLeases(ms) {
      return db.transaction(() => {
        const active = all<{ lease_id: string; expires_at: string }>(
          "SELECT lease_id, expires_at FROM leases WHERE state = 'active'",
        )
        for (const l of active) {
          run(
            'UPDATE leases SET expires_at = ? WHERE lease_id = ?',
            iso(Date.parse(l.expires_at) + ms),
            l.lease_id,
          )
        }
        return active.length
      })
    },
    recordActivity(taskId, activities) {
      const row = get<{ activity_json: string }>(
        'SELECT activity_json FROM tasks WHERE id = ?',
        taskId,
      )
      if (!row) return false
      if (activities.length === 0) return true
      // 活动文本是自由文本：限长并脱敏（sanitizeText：名单 → 截断 → 正则）；data 只做名单替换。
      const incoming = activities.map((a) => ({
        ...redactDeep(a, knownOnly),
        ...(a.text === undefined
          ? {}
          : { text: sanitizeText(redact ? redact(a.text) : a.text, ACTIVITY_TEXT_MAX) }),
      }))
      const kept = [...(JSON.parse(row.activity_json) as Activity[]), ...incoming].slice(
        -activityKeep,
      )
      let last = activities[0]?.ts ?? iso()
      for (const a of activities) if (a.ts > last) last = a.ts
      run(
        'UPDATE tasks SET activity_json = ?, last_activity_at = ? WHERE id = ?',
        JSON.stringify(kept),
        last,
        taskId,
      )
      return true
    },
    taskActivity(taskId) {
      const row = get<{ activity_json: string }>(
        'SELECT activity_json FROM tasks WHERE id = ?',
        taskId,
      )
      return row ? (JSON.parse(row.activity_json) as Activity[]) : []
    },

    snapshot({ includeSoft = true } = {}) {
      const out = {} as ProjectionSnapshot
      for (const table of PROJECTION_TABLES) {
        const rows = all<Record<string, unknown>>(
          `SELECT * FROM ${table} ORDER BY ${PROJECTION_KEYS[table]}`,
        )
        out[table] = includeSoft
          ? rows
          : rows.map((r) =>
              Object.fromEntries(
                Object.entries(r).filter(([k]) => !SOFT_COLUMNS[table].includes(k)),
              ),
            )
      }
      return out
    },

    backupTo(path) {
      db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`)
    },
    close() {
      listeners.clear()
      db.close()
    },
  }
}
