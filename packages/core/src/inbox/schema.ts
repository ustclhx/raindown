import { z } from 'zod'
import { actor, taskId, timestamp } from '../ledger/common.ts'
import { taskStageSchema } from '../ledger/stage.ts'
import { workspaceRef } from '../schema/common.ts'

/**
 * 收件箱条目的基础类型（add-m1-inbox design D1；inbox spec）。
 *
 * 条目是账本的投影：`inbox.item_created` / `inbox.item_updated` / `inbox.item_closed`
 * 折叠成 `inbox_items` 表，可随时从事件重建。这里只放数据形状，业务规则见 hub 的反应器。
 */

/** 条目级别：Interrupt 立即推送、Decide 成批推送、Digest 进每日摘要（inbox spec "推送节奏"）。 */
export const INBOX_LEVELS = ['interrupt', 'decide', 'digest'] as const
export type InboxLevel = (typeof INBOX_LEVELS)[number]
export const inboxLevel = z.enum(INBOX_LEVELS).meta({
  description: '条目级别：interrupt 立即推送，decide 成批推送，digest 写进每日摘要',
})

/** 级别的显示顺序（列表排序用）：interrupt 最前。 */
export const INBOX_LEVEL_RANK: Readonly<Record<InboxLevel, number>> = {
  interrupt: 0,
  decide: 1,
  digest: 2,
}

/**
 * 条目来源：
 * - `task`：任务进入 blocked；
 * - `task_retry`：用户或 supervisor 将终态任务重新排队；
 * - `proposal`：待确认的修改提案（state/proposals/，不在账本中）；
 * - `policy`：`auto-report` 策略的执行记录；
 * - `supervisor`：supervisor 的提问（`ask_user`，变更 ④ D11）；
 * - `digest`：每日摘要（3.3）；
 * - `task_proposal`：supervisor 的任务提案（`task_propose`，D11）。与知识修改提案 `proposal` 分开：
 *   动作路由到中枢的提案接受 / 驳回，不受提案目录扫描（`proposal_removed`）影响；
 * - `merge_request`：supervisor 的合并请求等待用户批准（D10，4.8 接入）；
 * - `decision`：到期决策的回看提醒（D11：决策没有 workspace 或 workspace 未启用 supervisor 时）。
 * - `isolation`：节点的隔离自检从通过变为不通过（worker-credential-isolation 3.2），或任务结束后节点重置了被改动的 mds（4.5）；默认 Digest。
 */
export const INBOX_SOURCES = [
  'task',
  'task_retry',
  'out_of_band',
  'reply_delivery',
  'proposal',
  'policy',
  'supervisor',
  'digest',
  'task_proposal',
  'merge_request',
  'decision',
  'pr_comment',
  'isolation',
] as const
export type InboxSource = (typeof INBOX_SOURCES)[number]
export const inboxSource = z.enum(INBOX_SOURCES).meta({ description: '条目来源' })

/**
 * 条目上的操作（inbox spec "操作"，3.2 映射到已有操作），按条目来源路由：
 * - `task`：approve / deny / reply → `task_reply`；
 * - `proposal`：accept / reject → `kb_proposals_accept` / `kb_proposals_reject`；
 * - `supervisor`（提问）：reply → 条目以 `answered` 关闭并写 `supervisor.answered`；
 * - `task_proposal`：accept / reject → 中枢建任务 / 驳回（`task_proposal.accepted|rejected`）；
 * - `merge_request`：approve（批准合并）/ reject（驳回）→ 合并请求处理（4.8）。
 * dismiss（忽略）对任何未关闭的条目都可用，不写进 `actions`。
 */
export const INBOX_ACTIONS = ['approve', 'deny', 'reply', 'accept', 'reject'] as const
/** 写在条目上的操作。 */
export type InboxItemAction = (typeof INBOX_ACTIONS)[number]
/** 3.2 的 inbox_act 接受的操作：条目上的操作加上忽略。 */
export type InboxAction = InboxItemAction | 'dismiss'
export const inboxAction = z.enum(INBOX_ACTIONS).meta({ description: '条目上可用的操作' })

/** 操作发起的渠道（design D3）：Telegram、Web 页面或命令行。 */
export const INBOX_VIA = ['telegram', 'web', 'cli'] as const
export type InboxVia = (typeof INBOX_VIA)[number]
export const inboxVia = z.enum(INBOX_VIA).meta({ description: '操作发起的渠道' })

/**
 * 关闭原因（inbox spec "自动关闭"：注明原因）：
 * - `task_running`：任务回到 running（回复已送达或执行器自行恢复）；
 * - `task_queued`：任务带着回复或被人工重新排队；
 * - `task_done` / `task_failed` / `task_cancelled`：任务进入终态；
 * - `superseded`：同一任务再次卡住（原因变了），由新条目取代；
 * - `proposal_accepted` / `proposal_rejected` / `proposal_removed`：提案已处理或已不存在；
 * - `answered`：提问已被答复（变更 ④）；`expired`：提问 7 天未答复（D11）；
 * - `dismissed`：用户忽略（3.2）；`acted`：用户在条目上执行了操作（3.2）；
 * - `digested`：策略执行记录、重试派工或巡检日报已写进每日摘要（3.3），不再单独保留。
 */
export const INBOX_CLOSE_REASONS = [
  'task_running',
  'handled_externally',
  'task_queued',
  'task_done',
  'task_failed',
  'task_cancelled',
  'superseded',
  'proposal_accepted',
  'proposal_rejected',
  'proposal_removed',
  'answered',
  'expired',
  'dismissed',
  'acted',
  'digested',
] as const
export type InboxCloseReason = (typeof INBOX_CLOSE_REASONS)[number]
export const inboxCloseReason = z.enum(INBOX_CLOSE_REASONS).meta({ description: '条目关闭原因' })

/**
 * 条目 id：`<来源前缀>.<来源内标识>`，由来源确定性地生成，同一来源只会有一个条目（幂等）：
 * - 任务卡住：`blk.<task.blocked 的 seq>`；
 * - 提案：`prop.<提案 id>`；
 * - 策略记录：`pol.<policy.decided 的 seq>`。
 * 渠道里用的短 id 是 `short_id`（创建事件 seq 的 base36），不在这里。
 */
export const INBOX_ITEM_ID_RE = /^[a-z]{2,12}\.[A-Za-z0-9_.-]{1,120}$/
export const inboxItemId = z
  .string()
  .regex(INBOX_ITEM_ID_RE, '条目 id 应形如 <来源前缀>.<标识>')
  .meta({ description: '条目 id，例如 blk.42、prop.<提案 id>' })

/** 标题、正文、关闭说明的长度上限（字符）；账本写入前按此截断（scrub.ts）。 */
export const INBOX_TITLE_MAX = 200
export const INBOX_BODY_MAX = 4000
export const INBOX_NOTE_MAX = 1000
/** 收件箱提问的选项：2–8 个，每个标签最多 100 字符。 */
export const INBOX_OPTION_MAX = 100
export const inboxOptions = z
  .array(z.string().trim().min(1).max(INBOX_OPTION_MAX))
  .min(2)
  .max(8)
  .refine((o) => new Set(o).size === o.length, '选项不能重复')
  .meta({ description: '提问的候选答复（2–8 个）；渠道上显示为按钮，点选即以该选项答复' })
/** 推送失败原因（`inbox.pushed` op=failed）的长度上限。 */
export const INBOX_PUSH_REASON_MAX = 500

/**
 * 推送渠道 id（notify-channel "渠道插件接口"）：例如 `telegram`、`ntfy`。
 * 也用在 `inbox.pushed` 事件与条目的消息引用中。
 */
export const CHANNEL_ID_RE = /^[a-z][a-z0-9-]{0,31}$/
export const channelId = z
  .string()
  .regex(CHANNEL_ID_RE, '渠道 id 应为小写字母开头的短名，例如 telegram')
  .meta({ description: '推送渠道 id，例如 telegram' })

/** 渠道内的消息引用（由渠道生成，中枢只保存不解析），例如 Telegram 的 `<chat_id>:<message_id>`。 */
export const CHANNEL_REF_MAX = 256
export const channelRef = z
  .string()
  .min(1)
  .max(CHANNEL_REF_MAX)
  .meta({ description: '渠道内的消息引用，由渠道生成' })

/**
 * 推送的消息形态：`item` 是单个条目（Interrupt、每日摘要），`batch` 是多条 Decide 合并成的一条消息。
 */
export const CHANNEL_MESSAGE_KINDS = ['item', 'batch'] as const
export type ChannelMessageKind = (typeof CHANNEL_MESSAGE_KINDS)[number]
export const channelMessageKind = z.enum(CHANNEL_MESSAGE_KINDS)

/** 条目在某个渠道上的一条消息（`inbox.pushed` 折叠而来）。 */
export const inboxChannelRef = z.strictObject({
  channel: channelId,
  /** 渠道内的消息引用；发送失败（没有发出消息）时为 null。 */
  ref: channelRef.nullable(),
  kind: channelMessageKind,
  /** 发出（或放弃发送）的时间。 */
  sent_at: timestamp,
  /** 条目关闭后，消息已改为"已处理"的时间（同步失败时为放弃的时间）；未关闭或尚未同步时为 null。 */
  synced_at: timestamp.nullable(),
  /** 推送失败：发送失败（ref 为 null）或"已处理"同步失败；没有失败时为 null。 */
  failed: z.strictObject({ reason: z.string(), at: timestamp }).nullable(),
})
export type InboxChannelRef = z.infer<typeof inboxChannelRef>

/** 条目视图（3.2 的 `inbox_list` 与渠道都读它）。 */
export const inboxItemView = z
  .strictObject({
    id: inboxItemId,
    short_id: z.string().meta({ description: '短 id：创建事件 seq 的 base36，供渠道按钮使用' }),
    level: inboxLevel,
    source: inboxSource,
    source_ref: z.string().meta({ description: '关联对象：任务 id、提案 id 或源事件 seq' }),
    reason: z.string().nullable().meta({ description: '来源内的原因，例如卡住原因 question' }),
    workspace: workspaceRef.nullable(),
    task_id: taskId.nullable(),
    title: z.string(),
    body: z.string(),
    actions: z.array(inboxAction),
    options: inboxOptions.optional(),
    state: z.enum(['open', 'closed']),
    created_at: timestamp,
    created_by: actor,
    updated_at: timestamp,
    deferred_until: timestamp
      .nullable()
      .meta({ description: '静默时段内生成的 Interrupt 条目顺延到此时推送（3.3）' }),
    pushed_at: timestamp.nullable().meta({ description: '首次推送到渠道的时间（4.1 维护）' }),
    channels: z
      .array(inboxChannelRef)
      .meta({ description: '条目在各渠道上的消息（推送与"已处理"同步记录）' }),
    closed: z
      .strictObject({
        reason: inboxCloseReason,
        note: z.string().nullable(),
        at: timestamp,
        by: actor,
        cause_actor: actor
          .nullable()
          .meta({ description: '导致关闭的操作者，例如答复任务的 user' }),
        via: inboxVia.nullable(),
      })
      .nullable(),
  })
  .meta({ title: 'Inbox item', description: '收件箱条目（inbox_items 投影的一行）' })
export type InboxItemView = z.infer<typeof inboxItemView>

/** 条目的短 id：创建事件 seq 的 base36。 */
export const inboxShortId = (createdSeq: number): string => createdSeq.toString(36)

/** 操作入口接受完整 id 或表格中的 base36 短 id。 */
export const inboxItemRef = z.union([inboxItemId, z.string().regex(/^[0-9a-z]{1,11}$/)])

export const inboxListQuery = z.strictObject({
  state: z.enum(['open', 'closed']).default('open'),
  level: inboxLevel.optional(),
  workspace: workspaceRef.optional(),
})
export type InboxListQuery = z.infer<typeof inboxListQuery>
/** 读响应扩展：阶段随任务与委托变化派生，不进入收件箱投影或创建事件。 */
export const inboxItemData = inboxItemView.extend({
  task_stage: taskStageSchema.nullable().optional(),
})
export type InboxItemData = z.infer<typeof inboxItemData>
export const inboxListData = z.object({ items: z.array(inboxItemData) })

/** 任务提案接受时可改写的目标的长度上限（字符）。 */
export const INBOX_GOAL_MAX = 16_384

export const inboxActRequest = z.strictObject({
  action: z.enum([...INBOX_ACTIONS, 'dismiss']),
  text: z.string().trim().min(1).max(16_384).optional(),
  goal: z.string().trim().min(1).max(INBOX_GOAL_MAX).optional().meta({
    description: '只用于接受任务提案（task_proposal 条目的 accept）：用修改后的目标建任务',
  }),
  via: inboxVia.optional(),
})
export type InboxActRequest = z.infer<typeof inboxActRequest>
/** 非 dismiss 操作成功时条目可能仍在等待底层状态变化。 */
export const inboxActData = z.object({ item: inboxItemData })
