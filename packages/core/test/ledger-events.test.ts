import { describe, expect, test } from 'bun:test'
import {
  canTransition,
  checkTaskEvent,
  EVENT_TYPES,
  type EventType,
  isTaskEventType,
  ledgerEvent,
  ledgerEventDraft,
  parseLedgerEvent,
  parseLedgerEventDraft,
  TASK_EVENT_RULES,
  TASK_STATUSES,
  type TaskStatus,
} from '../src/index.ts'

const ts = '2026-10-24T08:00:00.000Z'
const contract = { goal: 'g', workspace: 'ws/product-res', role: 'developer', executor: 'fake' }
const result = { summary: 's', executor: 'fake', node_id: 'n1' }
const task = { workspace: 'ws/product-res', task_id: 't_1' }
const sha = 'a'.repeat(64)

/** 每种事件一个合法样例（只写 type 之外的信封字段与载荷）与一个非法样例。 */
const samples: Record<
  EventType,
  { valid: Record<string, unknown>; invalid: Record<string, unknown> }
> = {
  'policy.changed': {
    valid: { payload: { from: null, to: '012345abcdef', added: [sha], removed: [] } },
    invalid: { payload: { from: null, to: 'invalid', added: [sha], removed: [] } },
  },
  'policy.decided': {
    valid: {
      ...task,
      payload: {
        task_id: task.task_id,
        request: { tool: 'Bash', actions: ['tool:Bash', 'git.push'], command: 'git push' },
        level: 'user',
        matched_rules: [],
        actions: [{ action: 'git.push', level: 'user', matched_rules: [], guarded: false }],
      },
    },
    invalid: { ...task, payload: { level: 'always' } },
  },
  'task.created': {
    valid: { ...task, payload: { contract } },
    invalid: { ...task, payload: { contract: { ...contract, workspace: undefined } } },
  },
  'task.policy_changed': {
    valid: { ...task, payload: { policy_seq: 10, rules: [sha] } },
    invalid: { ...task, payload: { policy_seq: 0, rules: [sha] } },
  },
  'task.started': {
    valid: { ...task, payload: { node_id: 'n1', lease_id: 'l1', attempt: 1 } },
    invalid: { ...task, payload: { node_id: 'n1', lease_id: 'l1', attempt: 0 } },
  },
  'task.attempt_ended': {
    valid: { ...task, payload: { attempt: 1, reason: 'failed', last_report: '执行器退出' } },
    invalid: { ...task, payload: { attempt: 1, reason: 'unknown' } },
  },
  'task.verifying': {
    valid: { ...task, payload: { node_id: 'n1' } },
    invalid: { workspace: 'ws/product-res', payload: { node_id: 'n1' } },
  },
  'task.done': {
    valid: { ...task, payload: { result } },
    invalid: { ...task, payload: {} },
  },
  'task.failed': {
    valid: { ...task, payload: { message: '用户放弃' } },
    invalid: { ...task, payload: {} },
  },
  'task.reported': {
    valid: {
      ...task,
      payload: { attempt: 1, lease_id: 'l1', status: 'progress', summary: '完成数据层' },
    },
    invalid: {
      ...task,
      payload: { attempt: 1, lease_id: 'l1', status: 'question', summary: '缺少问题' },
    },
  },
  'task.report_consumed': {
    valid: { ...task, payload: { attempt: 1, lease_id: 'l1', report_seq: 1 } },
    invalid: { ...task, payload: { attempt: 1, lease_id: 'l1', report_seq: 0 } },
  },
  'task.report_conflict': {
    valid: { ...task, payload: { attempt: 1, lease_id: 'l1', report_seq: 1, observed: 'idle' } },
    invalid: {
      ...task,
      payload: { attempt: 1, lease_id: 'l1', report_seq: 1, observed: 'unknown' },
    },
  },
  'task.blocked': {
    valid: { ...task, payload: { reason: 'question', message: '哪个分支？', tail: ['> ?'] } },
    invalid: { ...task, payload: { reason: 'tired', message: 'x' } },
  },
  'task.reply_dropped': {
    valid: {
      ...task,
      payload: { reply_id: 'r-1', reason: 'round_closed', message: '授权回合已关闭' },
    },
    invalid: { ...task, payload: { reply_id: 'r-1', reason: 'unknown', message: '拒收' } },
  },
  'task.out_of_band': {
    valid: { ...task, payload: { id: 'oob-1', kind: 'session_removed' } },
    invalid: { ...task, payload: { id: 'oob-1', kind: 'approval_outside_raindown' } },
  },
  'task.unblocked': {
    valid: { ...task, payload: { note: '用 main', reply_id: 'r-1' } },
    invalid: { ...task, payload: { note: 1 } },
  },
  'task.reply_fetched': {
    valid: { ...task, payload: { reply_id: 'r-1', lease_id: 'l1' } },
    invalid: { ...task, payload: { reply_id: 'bad', lease_id: 'l1' } },
  },
  'task.replied': {
    valid: { ...task, payload: { reply_id: 'r-1', kind: 'text', text: '用 main' } },
    invalid: { ...task, payload: { reply_id: 'r-1', kind: 'text' } },
  },
  'task.requeued_with_reply': {
    valid: { ...task, payload: { reply_id: 'r-1', session: 'sess-1' } },
    invalid: { ...task, payload: { reply_id: 'bad' } },
  },
  'task.requeued': {
    valid: { ...task, payload: { reason: 'lease_expired' } },
    invalid: { ...task, payload: { reason: 'because' } },
  },
  'task.cancel_requested': {
    valid: { ...task, payload: { reason: '不需要了' } },
    invalid: { task_id: 't_1', payload: {} },
  },
  'task.cancelled': {
    valid: { ...task, payload: { node_id: 'n1' } },
    invalid: { ...task, payload: { node_id: 'bad id' } },
  },
  'task.lease_expired': {
    valid: { ...task, payload: { lease_id: 'l1', node_id: 'n1', expired_at: ts, attempt: 1 } },
    invalid: { ...task, payload: { lease_id: 'l1', node_id: 'n1', attempt: 1 } },
  },
  'task.reply_delegated': {
    valid: {
      ...task,
      payload: { task_id: 't_1', block_seq: 7, kind: 'question', deadline: ts },
    },
    invalid: {
      ...task,
      payload: { task_id: 't_1', block_seq: 7, kind: 'no_progress', deadline: ts },
    },
  },
  'task.reply_escalated': {
    valid: { ...task, payload: { reason: 'timeout', block_seq: 7 } },
    invalid: { ...task, payload: { reason: 'bored' } },
  },
  'task.reply_observed': {
    valid: {
      workspace: 'ws/product-res',
      payload: {
        task_id: 't-1',
        block_seq: 7,
        delegation_seq: 8,
        kind: 'awaiting_approval',
        decision_id: 6,
        decision: 'approve',
        reason: '只读检查',
      },
    },
    invalid: {
      workspace: 'ws/product-res',
      payload: {
        task_id: 't-1',
        block_seq: 7,
        delegation_seq: 8,
        kind: 'question',
        decision: 'maybe',
        reason: 'x',
      },
    },
  },
  'task.branch_reported': {
    valid: { ...task, payload: { branch: 'ustclhx/t-1' } },
    invalid: { ...task, payload: { branch: 'feature/../main' } },
  },
  'lease.granted': {
    valid: {
      ...task,
      payload: { lease_id: 'l1', node_id: 'n1', token_sha256: sha, ttl_s: 60, expires_at: ts },
    },
    invalid: {
      ...task,
      payload: {
        lease_id: 'l1',
        node_id: 'n1',
        token_sha256: 'plain-token',
        ttl_s: 60,
        expires_at: ts,
      },
    },
  },
  'node.registered': {
    valid: {
      payload: {
        node_id: 'n1',
        hostname: 'mac',
        version: '0.0.0',
        capabilities: ['executor:fake'],
        executors: [{ type: 'fake', mode: 'headless' }],
        concurrency: 1,
      },
    },
    invalid: {
      payload: {
        node_id: 'n1',
        hostname: 'mac',
        version: '0',
        capabilities: ['X'],
        concurrency: 1,
      },
    },
  },
  'schedule.fired': {
    valid: {
      workspace: 'ws/global',
      payload: { rule_id: 'daily', planned_at: ts, missed: true, payload: { kind: 'patrol' } },
    },
    invalid: { payload: { rule_id: 'daily', planned_at: ts } },
  },
  'hub.started': {
    valid: { payload: { version: '0.0.0', pid: 123, runtime: 'bun', port: 7477 } },
    invalid: { payload: { version: '0.0.0', pid: 123, runtime: 'deno', port: 7477 } },
  },
  'hub.resumed': {
    valid: { payload: { slept_ms: 3_600_000, extended_leases: 2 } },
    invalid: { payload: { slept_ms: -1, extended_leases: 0 } },
  },
  'hub.backup_done': {
    valid: { payload: { path: 'state/backups/raindown-x.db', size_bytes: 10, duration_ms: 3 } },
    invalid: { payload: { size_bytes: 10, duration_ms: 3 } },
  },
  'hub.rebuilt': {
    valid: { payload: { events_replayed: 10, duration_ms: 3 } },
    invalid: { payload: { events_replayed: 10, duration_ms: 3, extra: true } },
  },
  'inbox.item_created': {
    valid: {
      ...task,
      payload: {
        item_id: 'blk.12',
        level: 'interrupt',
        source: 'task',
        source_ref: 't_1',
        reason: 'question',
        title: '需要确认',
        actions: ['reply'],
        source_seq: 12,
      },
    },
    invalid: {
      payload: { item_id: 'blk.12', level: 'urgent', source: 'task', source_ref: 't', title: 'x' },
    },
  },
  'inbox.item_updated': {
    valid: { payload: { item_id: 'blk.12', level: 'digest' } },
    invalid: { payload: { item_id: 'blk.12' } },
  },
  'inbox.item_closed': {
    valid: { ...task, payload: { item_id: 'blk.12', reason: 'task_running', cause_seq: 13 } },
    invalid: { payload: { item_id: 'blk.12', reason: 'whatever' } },
  },
  'inbox.pushed': {
    valid: { payload: { channel: 'telegram', ref: '42:7', item_ids: ['blk.12'] } },
    invalid: { payload: { channel: 'Tele Gram', ref: '42:7', item_ids: [] } },
  },
  'channel.rebound': {
    valid: {
      payload: {
        channel: 'telegram',
        from_chat: '0123456789abcdef',
        to_chat: 'fedcba9876543210',
        via: 'telegram',
      },
    },
    invalid: {
      payload: { channel: 'telegram', from_chat: '7001', to_chat: '9009', via: 'telegram' },
    },
  },
  'channel.unlinked': {
    valid: { payload: { channel: 'telegram', chat: '0123456789abcdef', via: 'cli' } },
    invalid: { payload: { channel: 'telegram', chat: 7001, via: 'cli' } },
  },
  'user.instruction': {
    valid: { workspace: 'ws/global', payload: { text: '看看昨天的部署', via: 'telegram' } },
    invalid: { payload: { text: '缺少 workspace', via: 'telegram' } },
  },
  'supervisor.wake_started': {
    valid: {
      ...task,
      payload: {
        task_id: 't_1',
        workspace: 'ws/product-res',
        origin: 'reply',
        events: [3, 5],
        generation: 2,
      },
    },
    invalid: {
      ...task,
      payload: { task_id: 't_1', workspace: 'ws/product-res', origin: 'patrol', events: [] },
    },
  },
  'supervisor.answered': {
    valid: { ...task, payload: { item_id: 'sup.12', text: 'B', via: 'telegram' } },
    invalid: { payload: { item_id: 'sup.12', text: 'B' } },
  },
  'supervisor.release': {
    valid: { workspace: 'ws/product-res', payload: { queue: 'autonomous' } },
    invalid: { workspace: 'ws/product-res', payload: { queue: 'reply' } },
  },
  'supervisor.scheduler_initialized': {
    valid: { payload: { up_to_seq: 0 } },
    invalid: { payload: { up_to_seq: -1 } },
  },
  'supervisor.observed_action': {
    valid: {
      workspace: 'ws/product-res',
      payload: { wake_task_id: 't-1', action: 'task_create', args: '{}', reason: 'observe' },
    },
    invalid: {
      workspace: 'ws/product-res',
      payload: { wake_task_id: 't-1', action: 'task_retry', args: '{}', reason: 'observe' },
    },
  },
  'supervisor.queue_dropped': {
    valid: {
      workspace: 'ws/product-res',
      payload: { queue: 'instruction', up_to_seq: 12, reason: 'disabled' },
    },
    invalid: {
      workspace: 'ws/product-res',
      payload: { queue: 'reply', up_to_seq: 12, reason: 'disabled' },
    },
  },
  'task_proposal.created': {
    valid: {
      workspace: 'ws/product-res',
      payload: {
        proposal_id: 'tp-1',
        wake_task_id: 't_1',
        draft: contract,
        decision: {
          title: '加缓存',
          expected_outcome: 'p95 降到 200ms',
          metric: 'p95 延迟',
          review_date: '2026-11-30',
        },
      },
    },
    invalid: {
      workspace: 'ws/product-res',
      payload: { proposal_id: 'p-1', wake_task_id: 't_1', draft: contract },
    },
  },
  'task_proposal.accepted': {
    valid: {
      workspace: 'ws/product-res',
      payload: {
        proposal_id: 'tp-1',
        task_id: 't_2',
        decision_path: 'decisions/2026-10-26-cache.md',
      },
    },
    invalid: {
      workspace: 'ws/product-res',
      payload: { proposal_id: 'tp-1', task_id: 't_2', decision_path: '../x.md' },
    },
  },
  'task_proposal.rejected': {
    valid: { workspace: 'ws/product-res', payload: { proposal_id: 'tp-1', via: 'web' } },
    invalid: { payload: { proposal_id: 'tp-1' } },
  },
  'decision.review_due': {
    valid: { payload: { path: 'decisions/2026-10-26-cache.md', review_date: '2026-11-30' } },
    invalid: { payload: { path: 'decisions/x.md', review_date: '11/30' } },
  },
  'merge_request.created': {
    valid: {
      workspace: 'ws/product-res',
      payload: {
        request_id: 'mr-1a2b',
        wake_task_id: 't_1',
        pr: 'https://github.com/o/r/pull/12',
        review_task: 't_3',
        dev_task: 't_2',
        reviewed_sha: 'a'.repeat(40),
        auto_merge: false,
        item_id: 'mr.1a2b',
      },
    },
    invalid: {
      workspace: 'ws/product-res',
      payload: {
        request_id: 'x-1',
        wake_task_id: 't_1',
        pr: 'https://github.com/o/r/pull/12',
        review_task: 't_3',
        dev_task: 't_2',
        reviewed_sha: 'abc',
        auto_merge: true,
      },
    },
  },
  'merge_request.approved': {
    valid: {
      workspace: 'ws/product-res',
      payload: {
        item_id: 'mr.9',
        pr: 'https://github.com/o/r/pull/12',
        review_task: 't_3',
        approved_by: 'user',
        via: 'telegram',
      },
    },
    invalid: {
      workspace: 'ws/product-res',
      payload: { pr: 'https://github.com/o/r/issues/12', review_task: 't_3', approved_by: 'user' },
    },
  },
  'merge_request.rejected': {
    valid: {
      workspace: 'ws/product-res',
      payload: {
        item_id: 'mr.9',
        pr: 'https://github.com/o/r/pull/12',
        review_task: 't_3',
        note: '先别合',
        via: 'web',
      },
    },
    invalid: { workspace: 'ws/product-res', payload: { pr: 'https://github.com/o/r/pull/12' } },
  },
  'pr.subscribed': {
    valid: { ...task, payload: { pr: 'https://github.com/o/r/pull/12', role: 'author' } },
    invalid: { ...task, payload: { pr: 'https://github.com/o/r/pull/12', role: 'owner' } },
  },
  'pr.unsubscribed': {
    valid: { ...task, payload: { pr: 'https://github.com/o/r/pull/12', reason: 'user' } },
    invalid: {
      workspace: 'ws/product-res',
      payload: { pr: 'https://github.com/o/r/pull/12', reason: 'user' },
    },
  },
  'task.input_added': {
    valid: { ...task, payload: { source: 'pr', pr_event_seq: 7 } },
    invalid: { ...task, payload: { source: 'email', pr_event_seq: 7 } },
  },
  'task.input_delivered': {
    valid: { ...task, payload: { input_seqs: [8], lease_id: 'l1' } },
    invalid: { ...task, payload: { input_seqs: [], lease_id: 'l1' } },
  },
  'pr.wake_requested': {
    valid: {
      workspace: 'ws/product-res',
      task_id: 't_1',
      payload: { pr_event_seq: 7, reason: 'handback', note: '超出范围' },
    },
    invalid: { workspace: 'ws/product-res', payload: { pr_event_seq: 7, reason: 'please' } },
  },
  'pr.dispatched': {
    valid: { workspace: 'ws/product-res', payload: { pr_event_seq: 7 } },
    invalid: { workspace: 'ws/product-res', payload: { pr_event_seq: 0 } },
  },
  'pr.event': {
    valid: {
      workspace: 'ws/product-res',
      payload: {
        pr: 'https://github.com/o/r/pull/12',
        kind: 'issue_comment',
        actor: 'octo',
        actor_kind: 'human',
        allowed: false,
        text: '顺便把 X 删掉',
        url: 'https://github.com/o/r/pull/12#issuecomment-1',
        cursor: '2026-10-24T08:00:00.000Z|1',
      },
    },
    invalid: {
      workspace: 'ws/product-res',
      payload: {
        pr: 'https://github.com/o/r/pull/12',
        kind: 'issue_comment',
        actor: 'octo',
        actor_kind: 'human',
        allowed: false,
        text: 'x',
        url: 'https://evil.example/x',
        cursor: '2026-10-24T08:00:00.000Z|1',
      },
    },
  },
}

const envelope = (type: EventType, body: Record<string, unknown>) => ({
  seq: 1,
  ts,
  type,
  actor: 'hub',
  ...body,
})

describe('事件 schema', () => {
  test('事件类型清单', () => {
    expect(EVENT_TYPES).toEqual(Object.keys(samples) as EventType[])
  })

  test.each(EVENT_TYPES)('%s：合法样例通过，非法样例被拒', (type) => {
    const { valid, invalid } = samples[type]
    const ok = ledgerEvent.safeParse(envelope(type, valid))
    if (!ok.success) throw new Error(ok.error.message)
    expect(ledgerEvent.safeParse(envelope(type, invalid)).success).toBe(false)
    // 草稿没有 seq/ts
    const { seq: _s, ts: _t, ...draft } = envelope(type, valid)
    expect(ledgerEventDraft.safeParse(draft).success).toBe(true)
  })

  test('task.requeued 兼容旧载荷并校验重试身份、理由与策略版本', () => {
    const parse = (payload: Record<string, unknown>) =>
      ledgerEvent.safeParse(envelope('task.requeued', { ...task, payload }))
    expect(parse({ reason: 'manual', note: '旧理由' }).success).toBe(true)
    expect(
      parse({
        reason: 'manual',
        requested_by: 'supervisor',
        retry_reason: '  已恢复目录  ',
        policy_version: '012345abcdef',
      }).success,
    ).toBe(true)
    expect(parse({ reason: 'manual', requested_by: 'user' }).success).toBe(true)
    expect(parse({ reason: 'manual', requested_by: 'hub' }).success).toBe(false)
    for (const policy_version of ['invalid', '012345abcde', '012345abcdeF']) {
      expect(parse({ reason: 'manual', policy_version }).success).toBe(false)
    }
    for (const retry_reason of ['', '   ', 'x'.repeat(8193)]) {
      expect(parse({ reason: 'manual', retry_reason }).success).toBe(false)
    }
  })

  test('策略变化转交保留原判定版本，并校验新版本与撤回回复 id', () => {
    const payload = {
      reason: 'policy_changed',
      block_seq: 7,
      policy_version: '012345abcdef',
      to_version: 'abcdef012345',
      dropped_reply_id: 'r-policy',
    }
    const event = envelope('task.reply_escalated', { ...task, payload })
    expect(ledgerEvent.parse(event).payload).toEqual(payload)
    expect(
      ledgerEvent.safeParse({ ...event, payload: { ...payload, to_version: 'invalid' } }).success,
    ).toBe(false)
    expect(
      ledgerEvent.safeParse({ ...event, payload: { ...payload, dropped_reply_id: 'bad' } }).success,
    ).toBe(false)
  })

  test('信封：seq、ts、actor 与未知 type', () => {
    const good = envelope('hub.rebuilt', samples['hub.rebuilt'].valid)
    expect(ledgerEvent.safeParse({ ...good, seq: 0 }).success).toBe(false)
    expect(ledgerEvent.safeParse({ ...good, ts: '昨天' }).success).toBe(false)
    expect(ledgerEvent.safeParse({ ...good, actor: '' }).success).toBe(false)
    expect(ledgerEvent.safeParse({ ...good, type: 'lease.renewed' }).success).toBe(false)
    expect(ledgerEvent.safeParse({ ...good, extra: 1 }).success).toBe(false)
  })

  test('task.created 的合同补齐默认值', () => {
    const r = parseLedgerEvent(envelope('task.created', samples['task.created'].valid))
    expect(r.ok).toBe(true)
    if (r.ok && r.data.type === 'task.created') expect(r.data.payload.contract.timeout_s).toBe(3600)
  })

  test('parse 辅助函数返回 invalid_event', () => {
    const r = parseLedgerEventDraft({ type: 'task.done', actor: 'hub', payload: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_event')
  })
})

describe('事件触发的状态转换', () => {
  /** 期望表：事件 → 允许的当前状态（null=任务不存在）→ 之后的状态。独立于实现手写。 */
  const expected: Record<string, [TaskStatus | null, TaskStatus][]> = {
    'policy.decided': TASK_STATUSES.map((status) => [status, status]),
    'task.created': [[null, 'queued']],
    'task.policy_changed': [
      ['running', 'running'],
      ['verifying', 'verifying'],
      ['blocked', 'blocked'],
    ],
    'task.started': [['queued', 'running']],
    'task.attempt_ended': TASK_STATUSES.map((status) => [status, status]),
    'lease.granted': [['running', 'running']],
    'task.reported': [['running', 'running']],
    'task.report_consumed': [
      ['running', 'running'],
      ['verifying', 'verifying'],
      ['blocked', 'blocked'],
    ],
    'task.report_conflict': [
      ['running', 'running'],
      ['verifying', 'verifying'],
      ['blocked', 'blocked'],
    ],
    'task.verifying': [['running', 'verifying']],
    'task.done': [
      ['running', 'done'],
      ['verifying', 'done'],
    ],
    'task.failed': [
      ['running', 'failed'],
      ['verifying', 'failed'],
      ['blocked', 'failed'],
    ],
    'task.blocked': [
      // 仅中枢的 isolation_unavailable（store 另行校验身份与消息，worker-credential-isolation 6.1）。
      ['queued', 'blocked'],
      ['running', 'blocked'],
      ['verifying', 'blocked'],
      ['blocked', 'blocked'],
    ],
    'task.out_of_band': TASK_STATUSES.map((status) => [status, status]),
    'task.reply_dropped': TASK_STATUSES.map((status) => [status, status]),
    'task.unblocked': [['blocked', 'running']],
    'task.replied': [['blocked', 'blocked']],
    'task.reply_fetched': [['blocked', 'blocked']],
    'task.requeued_with_reply': [['blocked', 'queued']],
    'task.requeued': [
      ['blocked', 'queued'],
      ['running', 'queued'],
      ['verifying', 'queued'],
      ['failed', 'queued'],
      ['done', 'queued'],
    ],
    'task.input_added': [
      ['queued', 'queued'],
      ['running', 'running'],
      ['verifying', 'verifying'],
      ['blocked', 'blocked'],
      ['done', 'done'],
      ['failed', 'failed'],
    ],
    'task.input_delivered': [
      ['running', 'running'],
      ['verifying', 'verifying'],
      ['blocked', 'blocked'],
    ],
    'task.cancel_requested': [
      ['running', 'running'],
      ['verifying', 'verifying'],
      ['blocked', 'blocked'],
    ],
    'task.cancelled': [
      ['queued', 'cancelled'],
      ['running', 'cancelled'],
      ['verifying', 'cancelled'],
      ['blocked', 'cancelled'],
    ],
    'task.lease_expired': [
      ['running', 'running'],
      ['verifying', 'verifying'],
      ['blocked', 'blocked'],
    ],
    'task.reply_delegated': [['blocked', 'blocked']],
    'task.reply_escalated': [['blocked', 'blocked']],
    'task.branch_reported': [
      ['running', 'running'],
      ['verifying', 'verifying'],
      ['blocked', 'blocked'],
    ],
    'supervisor.wake_started': [['queued', 'queued']],
  }

  test('规则覆盖全部任务事件', () => {
    expect(Object.keys(TASK_EVENT_RULES).sort()).toEqual(Object.keys(expected).sort())
    expect(EVENT_TYPES.filter(isTaskEventType).sort() as string[]).toEqual(
      Object.keys(expected).sort(),
    )
  })

  const states: (TaskStatus | null)[] = [null, ...TASK_STATUSES]
  const cases = Object.keys(expected).flatMap((type) =>
    states.map((from) => [type as EventType, from] as const),
  )

  const payloadFor = (type: EventType, from: TaskStatus | null) => {
    if (type === 'task.requeued')
      return {
        reason:
          from === 'done'
            ? 'input'
            : from === 'blocked' || from === 'failed'
              ? 'manual'
              : 'lease_expired',
      }
    return samples[type].valid.payload
  }

  test.each(cases)('%s 作用于 %s', (type, from) => {
    const hit = expected[type]?.find(([f]) => f === from)
    const r = checkTaskEvent(from, { type, payload: payloadFor(type, from) } as never)
    if (hit) {
      expect(r).toEqual({ ok: true, data: hit[1] })
      if (from !== null && hit[1] !== from) expect(canTransition(from, hit[1])).toBe(true)
    } else {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('invalid_transition')
    }
  })

  test('已完成的任务不能再运行（task-ledger 场景）', () => {
    const r = checkTaskEvent('done', {
      type: 'task.started',
      payload: samples['task.started'].valid.payload,
    } as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_transition')
  })

  test('blocked → blocked 只接受 lease_held=false（本轮结束）', () => {
    const held = {
      type: 'task.blocked',
      payload: { reason: 'question', message: 'x', lease_held: true },
    } as never
    const ended = {
      type: 'task.blocked',
      payload: { reason: 'crashed', message: 'x', lease_held: false },
    } as never
    expect(checkTaskEvent('blocked', held).ok).toBe(false)
    expect(checkTaskEvent('blocked', ended)).toEqual({ ok: true, data: 'blocked' })
    expect(checkTaskEvent('running', held)).toEqual({ ok: true, data: 'blocked' })
  })

  test('task.requeued 的 reason 必须与来源状态匹配', () => {
    const manual = { type: 'task.requeued', payload: { reason: 'manual' } } as never
    const expired = { type: 'task.requeued', payload: { reason: 'lease_expired' } } as never
    expect(checkTaskEvent('running', manual).ok).toBe(false)
    expect(checkTaskEvent('blocked', expired).ok).toBe(false)
    expect(checkTaskEvent('failed', expired).ok).toBe(false)
    expect(checkTaskEvent('failed', manual)).toEqual({ ok: true, data: 'queued' })
    expect(checkTaskEvent('done', manual).ok).toBe(false)
    expect(checkTaskEvent('cancelled', manual).ok).toBe(false)
    // 因 PR 评论恢复（input）只用于已结束的 done / failed。
    const input = { type: 'task.requeued', payload: { reason: 'input', pr_event_seq: 3 } } as never
    expect(checkTaskEvent('done', input)).toEqual({ ok: true, data: 'queued' })
    expect(checkTaskEvent('failed', input)).toEqual({ ok: true, data: 'queued' })
    expect(checkTaskEvent('blocked', input).ok).toBe(false)
    expect(checkTaskEvent('running', input).ok).toBe(false)
    expect(checkTaskEvent('cancelled', input).ok).toBe(false)
  })

  test('非任务事件不涉及状态', () => {
    expect(checkTaskEvent(null, { type: 'hub.rebuilt', payload: {} } as never)).toEqual({
      ok: true,
      data: null,
    })
  })
})
