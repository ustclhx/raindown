import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type BlockedReason,
  clipText,
  type EventOf,
  foldTaskAttempts,
  INBOX_BODY_MAX,
  INBOX_TITLE_MAX,
  type InboxCloseReason,
  type InboxConfig,
  type InboxItemAction,
  type InboxVia,
  type LedgerEvent,
  type ReplyEscalationReason,
  resolveInboxLevel,
  type TaskStatus,
  type TaskView,
} from '@raindown/core'
import type { EventInput, LedgerStore } from '../ledger/store.ts'
import { acceptedReplyKinds } from '../ledger/tasks.ts'
import type { HubLogger } from '../server/maintenance.ts'
import { blockedText } from './blocked.ts'

/**
 * 收件箱反应器（add-m1-inbox design D1；inbox spec "条目来源""默认分级""自动关闭"）。
 *
 * 订阅账本事件，把底层事件转换成收件箱事件：
 * - `task.blocked` → 开条目（按卡住原因与 `config/inbox.yaml` 分级）；
 * - `task.unblocked`、`task.requeued*`、终态 → 关闭该任务未关闭的条目；
 * - `task.requeued(manual)` → 独立重试通知（记录发起者与上一派工事实）；
 * - `policy.decided` 的 auto-report → Digest 条目（不随任务状态关闭，由每日摘要 3.3 处理）。
 *
 * **幂等**：条目 id 由源事件确定（`blk.<seq>`、`pol.<seq>`、`retry.<seq>`），账本拒绝重复创建（`duplicate_item`）
 * 与重复关闭（`item_closed`）。关闭只作用于"源事件 seq 小于关闭事件 seq"的条目，所以重放旧事件
 * 不会关掉之后新开的条目。开条目前还要求该事件仍是任务最近一次卡住且任务仍处于 blocked：
 * 卡住后立刻恢复（同一批写入）不会打扰用户，首次在旧账本上运行也不会为历史卡住补开条目。
 *
 * **重建不重复**：反应器写的是普通事件，投影重建只重放事件，不重跑反应器。
 *
 * **续跑**：启动时从 `max(游标文件, ledger.inboxCursor())` 之后补处理，然后核对一次：任务已不再
 * 因该事件卡住的条目按当前状态关闭；仍卡住却没有对应条目的补开。写入失败后的 drain 也会核对。
 * 游标文件只是加速，丢失时退回账本推导。
 *
 * **异步**：订阅回调只入队，处理放到微任务中：在账本通知订阅者的循环里同步追加事件，
 * 会让 SSE 等其他订阅者先看到更大的 seq，再看到更小的 seq（SSE 按游标丢弃）。
 */

export interface InboxReactorOptions {
  ledger: LedgerStore
  /** 当前的分级配置（热加载时返回新值）。 */
  config?: () => Pick<InboxConfig, 'levels'>
  logger?: Pick<HubLogger, 'warn'>
  /** 续跑游标文件（`state/inbox-reactor.json`）；缺省不持久化，只靠账本推导。 */
  cursorPath?: string
  /** 写入收件箱事件的操作者，默认 `hub`。 */
  actor?: string
}

export interface InboxReactor {
  /** 订阅账本、补处理游标之后的事件，并核对未关闭的任务条目。 */
  start(): void
  stop(): void
  /** 等到队列处理完（测试与停机用）。 */
  idle(): Promise<void>
  /** 已处理到的 seq。 */
  processed(): number
  /** 直接处理一条事件（测试用；正常路径经由订阅）。 */
  handle(event: LedgerEvent): void
  /** 立即做一次兜底核对（启动时与写入失败后的 drain 会自动做）。 */
  reconcile(): void
}

const REASON_LABEL: Readonly<Record<BlockedReason, string>> = {
  awaiting_approval: '等待授权',
  question: '提问',
  no_progress: '没有进展',
  crashed: '崩溃',
  workdir_missing: '工作目录或会话丢失',
  node_lost: '节点掉线',
  other: '卡住',
}

/** 正文里末尾输出最多保留的行数（渠道发送时再按配置截断，notify-channel 默认 1500 字符）。 */
const TAIL_LINES = 40

const CLOSING: Partial<Record<LedgerEvent['type'], InboxCloseReason>> = {
  'task.unblocked': 'task_running',
  'task.requeued': 'task_queued',
  'task.requeued_with_reply': 'task_queued',
  'task.done': 'task_done',
  'task.failed': 'task_failed',
  'task.cancelled': 'task_cancelled',
}

const STATUS_CLOSE: Readonly<Record<TaskStatus, InboxCloseReason>> = {
  queued: 'task_queued',
  running: 'task_running',
  verifying: 'task_running',
  blocked: 'superseded',
  done: 'task_done',
  failed: 'task_failed',
  cancelled: 'task_cancelled',
}

export const blockedItemId = (seq: number) => `blk.${seq}`
export const policyItemId = (seq: number) => `pol.${seq}`
export const outOfBandItemId = (seq: number) => `oob.${seq}`
export const retryItemId = (seq: number) => `retry.${seq}`

/** 条目上的操作：与 `task_reply` 接受的回复种类一致（text → reply）。 */
export function blockedActions(reason: string, priorReason?: string): InboxItemAction[] {
  return acceptedReplyKinds(reason, priorReason).map((k) => (k === 'text' ? 'reply' : k))
}

/** 正文：卡住说明，加上从末尾往前、能放进上限的输出行。 */
function blockedBody(message: string, tail: readonly string[] | undefined): string {
  const head = clipText(message, INBOX_BODY_MAX)
  const lines = (tail ?? []).slice(-TAIL_LINES)
  if (lines.length === 0) return head
  let budget = INBOX_BODY_MAX - head.length - 2
  const kept: string[] = []
  for (let i = lines.length - 1; i >= 0 && budget > 0; i--) {
    const line = lines[i] ?? ''
    if (line.length + 1 > budget) break
    kept.unshift(line)
    budget -= line.length + 1
  }
  return kept.length === 0 ? head : `${head}\n\n${kept.join('\n')}`
}

export function createInboxReactor(o: InboxReactorOptions): InboxReactor {
  const { ledger } = o
  const actor = o.actor ?? 'hub'
  const config = o.config ?? (() => ({ levels: [] }))
  const queue: LedgerEvent[] = []
  let done = 0
  let savedCursor = 0
  let scheduled: Promise<void> | null = null
  let unsubscribe: (() => void) | undefined
  let stopped = false

  /** 本轮处理中有写入失败：drain 结束时再核对一次（补开漏掉的条目、关闭过时的条目）。 */
  let needsReconcile = false

  /** 在一个事务里写入多条收件箱事件：任一条被拒绝则全部不写。 */
  const write = (...drafts: EventInput[]) => {
    if (drafts.length === 0) return true
    const r = ledger.appendMany(drafts, { actor })
    if (!r.ok && r.error.code !== 'duplicate_item' && r.error.code !== 'item_closed') {
      needsReconcile = true
      o.logger?.warn('收件箱事件写入失败', { types: drafts.map((d) => d.type), error: r.error })
    }
    return r.ok
  }

  const latestBlocked = (taskId: string): EventOf<'task.blocked'> | null => {
    const events = ledger.taskEvents(taskId)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'task.blocked') return e
    }
    return null
  }
  const latestBlockedSeq = (taskId: string): number | null => latestBlocked(taskId)?.seq ?? null

  /** 任务卡住开出的未关闭条目（策略记录等同一任务上的其他来源不随任务状态关闭）。 */
  const openTaskItems = (taskId: string) =>
    ledger.listInboxItems({ task_id: taskId, source: 'task', state: 'open', limit: 1000 })

  /** 关闭任务上源事件早于 cause 的未关闭条目的草稿。 */
  function closeTaskDrafts(
    task: { id: string; workspace: string },
    reason: InboxCloseReason,
    cause: { seq?: number; actor?: string; via?: InboxVia; note?: string },
  ): EventInput[] {
    const out: EventInput[] = []
    for (const item of openTaskItems(task.id)) {
      const sourceSeq = Number(item.id.startsWith('blk.') ? item.id.slice(4) : Number.NaN)
      if (cause.seq !== undefined && Number.isFinite(sourceSeq) && sourceSeq >= cause.seq) continue
      out.push({
        type: 'inbox.item_closed',
        task_id: task.id,
        workspace: task.workspace,
        payload: {
          item_id: item.id,
          reason,
          ...(cause.note === undefined ? {} : { note: cause.note }),
          ...(cause.seq === undefined ? {} : { cause_seq: cause.seq }),
          ...(cause.actor === undefined ? {} : { cause_actor: cause.actor }),
          ...(cause.via === undefined ? {} : { via: cause.via }),
        },
      })
    }
    return out
  }

  /**
   * 为任务最近一次卡住开条目：关闭被取代的旧条目与开新条目在同一个事务里写入。
   * 若分两次写入、中间崩溃，关闭事件的 cause_seq 会把 inboxCursor 推过这次卡住，重启后不再补开。
   */
  function openBlocked(task: TaskView, e: EventOf<'task.blocked'>) {
    // 同一任务再次卡住（例如等待授权期间节点掉线）：旧条目由新条目取代。
    const closes = closeTaskDrafts(task, 'superseded', { seq: e.seq, actor: e.actor })
    write(...closes, blockedDraft(task, e))
  }

  function onBlocked(e: EventOf<'task.blocked'>) {
    const task = ledger.getTask(e.task_id ?? '')
    if (task?.status !== 'blocked' || latestBlockedSeq(task.id) !== e.seq) return
    openBlocked(task, e)
  }

  /** 条目标题：委托给 supervisor 期间加上"supervisor 处理中"（D15）。 */
  const delegatedNow = (task: TaskView, blockSeq: number) =>
    ledger.activeDelegation(task.id)?.block_seq === blockSeq

  function blockedDraft(task: TaskView, e: EventOf<'task.blocked'>): EventInput {
    const p = e.payload
    const title = blockedTitle(task, p.reason)
    return {
      type: 'inbox.item_created',
      task_id: task.id,
      workspace: task.workspace,
      payload: {
        item_id: blockedItemId(e.seq),
        level: resolveInboxLevel(config(), {
          source: 'task',
          workspace: task.workspace,
          reason: p.reason,
        }),
        source: 'task',
        source_ref: task.id,
        reason: p.reason,
        title: delegatedNow(task, e.seq) ? delegatedTitle(title) : title,
        body: blockedBody(blockedText(p), p.tail),
        ...(p.reason === 'question' && p.question
          ? { options: p.question.options.map((option) => option.label) }
          : {}),
        actions: blockedActions(p.reason, p.prior_reason),
        source_seq: e.seq,
      },
    }
  }

  /** 带外条目独立于卡住条目，直到用户确认才关闭。 */
  function onOutOfBand(e: EventOf<'task.out_of_band'>) {
    const task = ledger.getTask(e.task_id ?? '')
    if (!task) return
    const p = e.payload
    if (p.kind === 'mds_reset') {
      // 外层 seatbelt 下 harness 结束后 mds/ 被改动并已重置（worker-credential-isolation 4.5）：Digest 级通知，只列文件名。
      if (ledger.getInboxItem(outOfBandItemId(e.seq))) return
      write({
        type: 'inbox.item_created',
        task_id: task.id,
        workspace: task.workspace,
        payload: {
          item_id: outOfBandItemId(e.seq),
          level: resolveInboxLevel(config(), {
            source: 'isolation',
            workspace: task.workspace,
            reason: p.kind,
          }),
          source: 'isolation',
          source_ref: task.id,
          source_seq: e.seq,
          reason: p.kind,
          title: clipText(`[${task.workspace}] 重置了 macOS Security 缓存（mds）`, INBOX_TITLE_MAX),
          body: clipText(
            [
              `任务 ${task.id} 的 harness 在外层 seatbelt 内运行期间，DARWIN_USER_CACHE_DIR/mds 下以下条目有变化或新增，节点已在校验时删除（macOS 会自动重建）：`,
              // 文件名由 worker 控制：逐个 JSON 引号转义，不能伪造换行或格式。
              ...p.files.map((f) => `- ${JSON.stringify(f)}`),
              '沙箱外的进程同时合法更新这些文件也会触发重置，重建无害。',
            ].join('\n'),
            INBOX_BODY_MAX,
          ),
          actions: [],
        },
      })
      return
    }
    const drafts: EventInput[] = []
    if (p.kind === 'approval_outside_raindown') {
      for (const draft of closeTaskDrafts(task, 'handled_externally', {
        seq: e.seq,
        actor: e.actor,
      })) {
        if (draft.type !== 'inbox.item_closed') continue
        const item = ledger.getInboxItem(draft.payload.item_id)
        if (item?.reason === 'awaiting_approval') drafts.push(draft)
      }
    }
    if (!ledger.getInboxItem(outOfBandItemId(e.seq))) {
      const label =
        p.kind === 'approval_outside_raindown'
          ? '授权在 Raindown 之外被批准'
          : '工作目录或会话被删除'
      drafts.push({
        type: 'inbox.item_created',
        task_id: task.id,
        workspace: task.workspace,
        payload: {
          item_id: outOfBandItemId(e.seq),
          level: 'interrupt',
          source: 'out_of_band',
          source_ref: task.id,
          source_seq: e.seq,
          reason: p.kind,
          title: clipText(`[${task.workspace}] ${label}`, INBOX_TITLE_MAX),
          body: clipText(
            [
              label,
              `任务 ${task.id}`,
              ...(p.command ? [`命令 ${p.command}`] : []),
              ...(p.message ? [p.message] : []),
            ].join('\n'),
            INBOX_BODY_MAX,
          ),
        },
      })
    }
    write(...drafts)
  }

  /** 回复拒收是独立通知，不随任务恢复或新一轮卡住关闭。 */
  function onReplyDropped(e: EventOf<'task.reply_dropped'>) {
    const task = ledger.getTask(e.task_id ?? '')
    const itemId = `reply.${e.payload.reply_id}`
    if (!task) return
    const blocked = latestBlocked(task.id)
    const reply = ledger
      .taskEvents(task.id)
      .find(
        (event) => event.type === 'task.replied' && event.payload.reply_id === e.payload.reply_id,
      )
    // 只恢复这条 supervisor 回复所属的当前卡住；旧回复拒收通知不改新回合的标题。
    if (
      blocked &&
      reply?.actor === 'supervisor' &&
      reply.seq > blocked.seq &&
      !delegatedNow(task, blocked.seq)
    ) {
      restoreDelegatedTitle(task.id)
    }
    if (ledger.getInboxItem(itemId)) return
    write({
      type: 'inbox.item_created',
      task_id: task.id,
      workspace: task.workspace,
      payload: {
        item_id: itemId,
        source: 'reply_delivery',
        source_ref: e.payload.reply_id,
        source_seq: e.seq,
        level: 'interrupt',
        reason: e.payload.reason,
        title: clipText(
          `[${task.workspace}] 回复${e.payload.message.startsWith('这条回复可能没有送达') ? '可能没有' : '没有'}送达`,
          INBOX_TITLE_MAX,
        ),
        body: clipText(
          `任务 ${task.id}\n回复 ${e.payload.reply_id}\n${e.payload.message}`,
          INBOX_BODY_MAX,
        ),
        actions: [],
      },
    })
  }

  /** 人或 supervisor 的主动重试是独立通知，正文只读取重试发生之前的派工事实。 */
  function onRetry(e: EventOf<'task.requeued'>) {
    if (e.payload.reason !== 'manual' || ledger.getInboxItem(retryItemId(e.seq))) return
    const requestedBy =
      e.payload.requested_by ??
      (e.actor === 'user' || e.actor === 'supervisor' ? e.actor : undefined)
    if (!requestedBy) return
    const task = ledger.getTask(e.task_id ?? '')
    if (!task) return
    const history = ledger.taskEvents(task.id).filter((event) => event.seq < e.seq)
    const previous = foldTaskAttempts(task, history).at(-1)
    const started = previous
      ? history.findLast(
          (event) => event.type === 'task.started' && event.payload.attempt === previous.attempt,
        )
      : undefined
    const priorEvents = started ? history.filter((event) => event.seq >= started.seq) : []
    const blocked = priorEvents.findLast((event) => event.type === 'task.blocked')
    const failed = priorEvents.findLast((event) => event.type === 'task.failed')
    const lines = [
      `第 ${(previous?.attempt ?? 0) + 1} 次派工：已重新排队，尚未开始`,
      `发起者：${requestedBy}`,
      previous
        ? `上次派工：第 ${previous.attempt} 次；结束事实：${previous.reason ?? '未记录'}`
        : '上次派工：未记录',
      `重试理由：${clipText(e.payload.retry_reason ?? e.payload.note ?? '未提供', 1000)}`,
    ]
    // retry 结束事实不能覆盖原先的崩溃、目录丢失或失败说明。
    if (blocked?.type === 'task.blocked') {
      lines.push(
        `上次卡住：${blocked.payload.reason}（${REASON_LABEL[blocked.payload.reason]}）；${clipText(blocked.payload.message, 800)}`,
      )
    }
    if (failed?.type === 'task.failed') {
      lines.push(
        `上次失败：${clipText([failed.payload.result?.summary, failed.payload.message].filter(Boolean).join('；'), 800)}`,
      )
    }
    if (previous?.last_report) lines.push(`上次上报：${clipText(previous.last_report, 800)}`)
    write({
      type: 'inbox.item_created',
      task_id: task.id,
      workspace: task.workspace,
      payload: {
        item_id: retryItemId(e.seq),
        source: 'task_retry',
        source_ref: task.id,
        source_seq: e.seq,
        reason: requestedBy,
        level: resolveInboxLevel(config(), {
          source: 'task_retry',
          reason: requestedBy,
          workspace: task.workspace,
        }),
        title: clipText(`任务 ${task.id} 被重试`, INBOX_TITLE_MAX),
        body: clipText(lines.join('\n'), INBOX_BODY_MAX),
        actions: [],
      },
    })
  }

  /** 终态结束此前重试通知的生命周期；后续重试不能被旧终态关闭。 */
  function closeRetryDrafts(
    task: TaskView,
    e: LedgerEvent,
    reason: InboxCloseReason,
  ): EventInput[] {
    return ledger
      .listInboxItems({ task_id: task.id, source: 'task_retry', state: 'open', limit: 1000 })
      .filter((item) => Number(item.id.slice('retry.'.length)) < e.seq)
      .map((item) => ({
        type: 'inbox.item_closed',
        task_id: task.id,
        workspace: task.workspace,
        payload: {
          item_id: item.id,
          reason,
          note: `任务进入 ${e.type.slice('task.'.length)} 终态，自动关闭重试通知`,
          cause_seq: e.seq,
          cause_actor: e.actor,
        },
      }))
  }

  function onTaskLeft(e: LedgerEvent, reason: InboxCloseReason) {
    const task = ledger.getTask(e.task_id ?? '')
    if (!task) return
    // 因回复而恢复：关闭原因归到回复者（例如在终端答复的 user），渠道据此显示来源。
    const replyId =
      e.type === 'task.unblocked' || e.type === 'task.requeued_with_reply'
        ? e.payload.reply_id
        : undefined
    const by = replyId === undefined ? undefined : ledger.getReply(replyId)?.by
    const reply =
      replyId === undefined
        ? undefined
        : ledger
            .taskEvents(task.id)
            .find((event) => event.type === 'task.replied' && event.payload.reply_id === replyId)
    const via = reply?.type === 'task.replied' ? reply.payload.via : undefined
    write(
      ...closeTaskDrafts(task, reason, {
        seq: e.seq,
        actor: by ?? e.actor,
        ...(e.type === 'task.done' && e.payload.result.completed_via === 'existing_pr'
          ? {
              note: clipText(
                `依据本任务已有 PR 判定完成：${e.payload.result.prs?.join('、')}；原卡住条目自动关闭，审查与合并资格仍须核对。`,
                1000,
              ),
            }
          : {}),
        // supervisor 代回复不是收件箱渠道：关闭记录只留 cause_actor（supervisor），不写 via。
        ...(via && via !== 'supervisor' ? { via } : {}),
      }),
      ...(e.type === 'task.done' || e.type === 'task.failed' || e.type === 'task.cancelled'
        ? closeRetryDrafts(task, e, reason)
        : []),
    )
  }

  /**
   * `policy.decided`（策略引擎 2.2）：auto-report 档位生成 Digest 条目，正文为请求的工具与命令。
   * 其他档位：auto 不打扰用户；需要用户的档位由随后的 `task.blocked(awaiting_approval)` 开条目。
   */
  function onPolicyDecided(e: EventOf<'policy.decided'>) {
    const p = e.payload
    if (p.level !== 'auto-report') return
    // policy.decided 是任务事件，信封必带 workspace 与 task_id。
    const ws = e.workspace as string
    const actions = p.request.actions.filter((a) => !a.startsWith('tool:'))
    const shown = actions.length > 0 ? actions : p.request.actions
    write({
      type: 'inbox.item_created',
      task_id: e.task_id as string,
      workspace: ws,
      payload: {
        item_id: policyItemId(e.seq),
        level: resolveInboxLevel(config(), { source: 'policy', workspace: ws }),
        source: 'policy',
        source_ref: String(e.seq),
        title: clipText(
          `[${ws}] 策略自动放行：${shown.join('、') || p.request.tool}`,
          INBOX_TITLE_MAX,
        ),
        body: clipText(
          [`任务 ${e.task_id}`, `工具 ${p.request.tool}`, p.request.command]
            .filter((x): x is string => typeof x === 'string' && x.length > 0)
            .join('\n'),
          INBOX_BODY_MAX,
        ),
        source_seq: e.seq,
      },
    })
  }

  /** 策略变化作为独立通知保留；不改变任务状态或取消任务。 */
  function onTaskPolicyChanged(e: EventOf<'task.policy_changed'>) {
    const ws = e.workspace as string
    write({
      type: 'inbox.item_created',
      task_id: e.task_id as string,
      workspace: ws,
      payload: {
        item_id: `policychg.${e.seq}`,
        level: 'decide',
        source: 'policy',
        source_ref: String(e.seq),
        source_seq: e.seq,
        title: clipText(`[${ws}] 任务授权策略已变化：${e.task_id}`, INBOX_TITLE_MAX),
        body: clipText(
          `${e.payload.note ? `${e.payload.note}\n\n` : ''}策略变化事件 #${e.payload.policy_seq}；任务 ${e.task_id} 依赖的规则已删除或修改：${e.payload.rules.join('、')}。任务继续保留。`,
          INBOX_BODY_MAX,
        ),
      },
    })
  }

  /**
   * 代回复委托（D15）：委托开始时条目标题标"supervisor 处理中"；委托结束（转交）时恢复标题，
   * 由 supervisor、超时或唤醒问题转交的在正文末尾注明原因（转交说明来自 supervisor，只给用户看）。
   * 按目标内容比较后再写，重放同一事件不会重复修改。
   */
  function onDelegation(e: EventOf<'task.reply_delegated'> | EventOf<'task.reply_escalated'>) {
    const task = ledger.getTask(e.task_id ?? '')
    if (!task) return
    const blockSeq = e.payload.block_seq
    const item = ledger.getInboxItem(blockedItemId(blockSeq))
    if (item?.state !== 'open') return
    const blocked = ledger.taskEvents(task.id).find((x) => x.seq === blockSeq)
    if (blocked?.type !== 'task.blocked') return
    const base = blockedTitle(task, blocked.payload.reason)
    let title = base
    let body = item.body
    if (e.type === 'task.reply_delegated') {
      title = delegatedNow(task, blockSeq) ? delegatedTitle(base) : base
    } else if (e.payload.reason === 'observe') {
      // observe（D10）：附上 supervisor 会怎么做；判断只在用户可见的条目里，不送达 worker。
      const observed = ledger
        .eventsByPayload('task.reply_observed', 'task_id', task.id)
        .findLast(
          (x) =>
            x.type === 'task.reply_observed' && x.payload.block_seq === blockSeq && x.seq < e.seq,
        )
      const line =
        observed?.type === 'task.reply_observed'
          ? observeLine(observed.payload)
          : `${OBSERVE_LINE_PREFIX}（判断记录缺失）`
      const original = blockedBody(blockedText(blocked.payload), blocked.payload.tail)
      body = clipText(`${line}\n\n${original}`, INBOX_BODY_MAX)
    } else if (e.payload.reason !== 'user_replied' && e.payload.reason !== 'user_dismissed') {
      const line = clipText(
        `supervisor 未代为处理，已转交给你：${ESCALATION_LABEL[e.payload.reason]}${
          e.payload.note ? `（${e.payload.note}）` : ''
        }`,
        600,
      )
      const original = blockedBody(blockedText(blocked.payload), blocked.payload.tail)
      body = clipText(`${line}\n\n${original}`, INBOX_BODY_MAX)
    }
    if (title === item.title && body === item.body) return
    write({
      type: 'inbox.item_updated',
      task_id: task.id,
      workspace: task.workspace,
      payload: {
        item_id: item.id,
        ...(title === item.title ? {} : { title }),
        ...(body === item.body ? {} : { body }),
      },
    })
  }

  /** 委托隐式结束（请求取消或当前回复拒收）：去掉"supervisor 处理中"。 */
  function restoreDelegatedTitle(taskId: string) {
    const task = ledger.getTask(taskId)
    if (task?.status !== 'blocked') return
    const blocked = latestBlocked(task.id)
    if (!blocked) return
    const item = ledger.getInboxItem(blockedItemId(blocked.seq))
    if (item?.state !== 'open' || !item.title.startsWith(DELEGATED_TITLE_PREFIX)) return
    write({
      type: 'inbox.item_updated',
      task_id: task.id,
      workspace: task.workspace,
      payload: { item_id: item.id, title: blockedTitle(task, blocked.payload.reason) },
    })
  }

  function handle(e: LedgerEvent) {
    if (e.seq <= done) return
    try {
      if (e.type === 'task.blocked') onBlocked(e)
      else if (e.type === 'task.reply_dropped') onReplyDropped(e)
      else if (e.type === 'task.out_of_band') onOutOfBand(e)
      else if (e.type === 'policy.decided') onPolicyDecided(e)
      else if (e.type === 'task.policy_changed') onTaskPolicyChanged(e)
      else if (e.type === 'task.reply_delegated' || e.type === 'task.reply_escalated') {
        onDelegation(e)
      } else if (e.type === 'task.cancel_requested') restoreDelegatedTitle(e.task_id ?? '')
      else {
        const reason = CLOSING[e.type]
        if (reason !== undefined) onTaskLeft(e, reason)
        if (e.type === 'task.requeued') onRetry(e)
      }
    } catch (err) {
      o.logger?.warn('收件箱反应器处理事件失败', { seq: e.seq, type: e.type, error: String(err) })
    }
    done = e.seq
  }

  function saveCursor() {
    if (!o.cursorPath || done <= savedCursor) return
    try {
      mkdirSync(dirname(o.cursorPath), { recursive: true })
      const tmp = `${o.cursorPath}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ seq: done })}\n`)
      renameSync(tmp, o.cursorPath)
      savedCursor = done
    } catch (err) {
      o.logger?.warn('收件箱游标保存失败', String(err))
    }
  }

  function drain() {
    while (queue.length > 0 && !stopped) {
      const e = queue.shift() as LedgerEvent
      handle(e)
    }
    if (needsReconcile && !stopped) reconcile()
    saveCursor()
  }

  function kick() {
    if (scheduled) return
    scheduled = Promise.resolve().then(() => {
      scheduled = null
      drain()
    })
  }

  function readCursor(): number {
    if (!o.cursorPath) return 0
    try {
      const seq = (JSON.parse(readFileSync(o.cursorPath, 'utf8')) as { seq?: unknown }).seq
      // 账本被换成更短的（例如从备份恢复）时，文件里的游标作废。
      return typeof seq === 'number' && Number.isInteger(seq) && seq <= ledger.seq() ? seq : 0
    } catch {
      return 0
    }
  }

  /**
   * 续跑与写入失败后的兜底核对：
   * - 未关闭的任务条目，若任务已不再因该事件卡住，按任务当前状态关闭；
   * - 仍处于 blocked、最近一次卡住还没有对应条目的任务，补开条目。条目已存在（包括已被用户
   *   忽略而关闭的）就不动：同一次卡住只开一次。
   * - 带外、拒收与主动重试通知扫描源事件补齐；重试通知在其后的任务终态自动关闭。
   */
  function reconcile() {
    needsReconcile = false
    for (const kind of ['approval_outside_raindown', 'session_removed', 'mds_reset']) {
      for (const event of ledger.eventsByPayload('task.out_of_band', 'kind', kind)) {
        if (event.type === 'task.out_of_band') onOutOfBand(event)
      }
    }
    for (const event of ledger.eventsByPayload('task.reply_dropped', 'reason', 'round_closed')) {
      if (event.type === 'task.reply_dropped') onReplyDropped(event)
    }
    for (const event of ledger.eventsByPayload('task.requeued', 'reason', 'manual')) {
      if (event.type === 'task.requeued') onRetry(event)
    }
    for (const task of ledger.listTasks({ status: 'blocked', limit: 100_000 })) {
      const e = latestBlocked(task.id)
      if (e === null || ledger.getInboxItem(blockedItemId(e.seq))) continue
      openBlocked(task, e)
    }
    for (const item of ledger.listInboxItems({ source: 'task', state: 'open', limit: 10_000 })) {
      if (item.task_id === null) continue
      const task = ledger.getTask(item.task_id)
      if (!task) continue
      const latest = latestBlockedSeq(task.id)
      if (task.status === 'blocked' && latest !== null) {
        if (item.id === blockedItemId(latest)) continue
        // 最近一次卡住的条目还没开：由上面的补开与关闭一起原子写入，这里不单独关闭。
        if (!ledger.getInboxItem(blockedItemId(latest))) continue
      }
      write({
        type: 'inbox.item_closed',
        task_id: task.id,
        workspace: task.workspace,
        payload: {
          item_id: item.id,
          reason: STATUS_CLOSE[task.status],
          ...(task.status === 'done' && task.result?.completed_via === 'existing_pr'
            ? {
                note: clipText(
                  `依据本任务已有 PR 判定完成：${task.result.prs?.join('、')}；原卡住条目自动关闭，审查与合并资格仍须核对。`,
                  1000,
                ),
              }
            : {}),
        },
      })
    }
    // 游标可能已越过终态，通知也可能在补齐历史时才创建，因此按源 seq 再核对一次。
    for (const item of ledger.listInboxItems({
      source: 'task_retry',
      state: 'open',
      limit: 10_000,
    })) {
      if (item.task_id === null) continue
      const task = ledger.getTask(item.task_id)
      if (!task) continue
      const sourceSeq = Number(item.id.slice('retry.'.length))
      const ended = ledger
        .taskEvents(task.id)
        .find(
          (event) =>
            event.seq > sourceSeq &&
            (event.type === 'task.done' ||
              event.type === 'task.failed' ||
              event.type === 'task.cancelled'),
        )
      const reason = ended ? CLOSING[ended.type] : undefined
      if (ended && reason !== undefined) write(...closeRetryDrafts(task, ended, reason))
    }
    // 这里的写入再失败时 needsReconcile 重新置位：下一轮 drain（有新事件时）或下次启动再试，不在此循环重试。
  }

  return {
    start() {
      if (unsubscribe || stopped) return
      unsubscribe = ledger.subscribe((e) => {
        if (stopped) return
        queue.push(e)
        kick()
      })
      const from = Math.max(readCursor(), ledger.inboxCursor())
      done = from
      savedCursor = from
      for (let after = from; ; ) {
        const batch = ledger.eventsAfter(after, {}, 1000)
        if (batch.length === 0) break
        for (const e of batch) handle(e)
        after = batch[batch.length - 1]?.seq ?? after
      }
      reconcile()
      saveCursor()
    },
    stop() {
      if (stopped) return
      drain()
      stopped = true
      unsubscribe?.()
      unsubscribe = undefined
    },
    async idle() {
      while (scheduled) await scheduled
    },
    processed: () => done,
    handle,
    reconcile,
  }
}

/** observe 模式下条目正文第一段的前缀（D10）；渠道渲染据此附上这一行。 */
export const OBSERVE_LINE_PREFIX = '【observe】supervisor 会：'

const OBSERVE_DECISION_LABEL = {
  approve: '批准',
  deny: '拒绝',
  answer: '回答',
  escalate: '转交给你',
} as const

/**
 * 去掉条目正文开头的 observe 行（D10）：observe 判断只给用户看，非 user 的调用方（AI 身份、任务绑定、
 * supervisor 唤醒）读取收件箱时只看到条目标题与原卡住说明。
 */
export function stripObserveLine(body: string): string {
  if (!body.startsWith(OBSERVE_LINE_PREFIX)) return body
  const cut = body.indexOf('\n\n')
  return cut === -1 ? '' : body.slice(cut + 2)
}

/** "【observe】supervisor 会：批准（理由）"——一行，最多 600 字符。 */
export function observeLine(p: {
  decision: keyof typeof OBSERVE_DECISION_LABEL
  text?: string | undefined
  reason: string
}): string {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  const answer = p.decision === 'answer' && p.text ? `「${flat(p.text)}」` : ''
  return clipText(
    `${OBSERVE_LINE_PREFIX}${OBSERVE_DECISION_LABEL[p.decision]}${answer}（${flat(p.reason)}）`,
    600,
  )
}

/** 委托给 supervisor 期间的条目标题前缀（D15 "supervisor 处理中"）。 */
export const DELEGATED_TITLE_PREFIX = '【supervisor 处理中】'
const delegatedTitle = (title: string) =>
  clipText(`${DELEGATED_TITLE_PREFIX}${title}`, INBOX_TITLE_MAX)

const ESCALATION_LABEL: Record<ReplyEscalationReason, string> = {
  supervisor: 'supervisor 判断需要你来决定',
  timeout: 'supervisor 超时未回复',
  policy_changed: '代批依据的策略规则已删除或修改',
  wake_unavailable: 'supervisor 无法开始处理',
  wake_failed: 'supervisor 处理失败',
  wake_ended: 'supervisor 结束时没有回复',
  user_dismissed: '你忽略了该条目',
  user_replied: '你已回复',
  observe: '该项处于 observe 模式，supervisor 的判断只记录、未送达',
  config_unavailable: '回复时无法读取 workspace 配置，supervisor 的判断未送达',
}

function blockedTitle(task: TaskView, reason: BlockedReason): string {
  const goal = task.contract.goal.split('\n')[0] ?? ''
  return clipText(`[${task.workspace}] ${REASON_LABEL[reason]}：${goal}`, INBOX_TITLE_MAX)
}
