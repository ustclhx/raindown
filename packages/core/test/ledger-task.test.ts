import { describe, expect, test } from 'bun:test'
import {
  activity,
  BLOCKED_REASONS,
  canTransition,
  capabilitiesSatisfy,
  createTaskRequest,
  fakeInputs,
  isTerminalStatus,
  requiredCapabilities,
  TASK_STATUSES,
  type TaskStatus,
  taskContract,
  taskResult,
  taskStatus,
  taskView,
} from '../src/index.ts'

const contract = {
  goal: '修复登录页的 bug',
  workspace: 'ws/product-res',
  role: 'developer',
  executor: 'codex-orca',
}

const issuePaths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  (r.error?.issues ?? []).map((i) => i.path.join('.'))

describe('任务合同', () => {
  test('最小合同补齐默认值', () => {
    const c = taskContract.parse(contract)
    expect(c.timeout_s).toBe(3600)
    expect(c.requires).toEqual([])
    expect(c.retry).toBeUndefined()
  })

  test('完整合同（含 verify、retry、fake inputs）合法', () => {
    const c = taskContract.parse({
      ...contract,
      executor: 'fake',
      requires: ['repo:/Users/hxlee/workspace/product-res', 'browser'],
      cwd: '/Users/hxlee/workspace/product-res',
      context: ['resources/services/web', 'docs/prd.md'],
      verify: [{ cmd: ['bun', 'test'] }, { cmd: ['bun', 'run', 'lint'], cwd: '/tmp/x' }],
      timeout_s: 600,
      retry: { max_attempts: 3 },
      parent: 't_parent1',
      idempotency_key: 'supervisor:2026-10-24:1',
      inputs: {
        fake: { outcome: 'blocked', blocked_reason: 'question', message: '要用哪个分支？' },
      },
    })
    expect(c.inputs?.fake?.delay_ms).toBe(0)
    expect(c.inputs?.fake?.activity).toEqual([])
  })

  test('缺少 workspace：错误指出 workspace 字段', () => {
    const { workspace: _, ...rest } = contract
    const r = taskContract.safeParse(rest)
    expect(r.success).toBe(false)
    expect(issuePaths(r)).toEqual(['workspace'])
  })

  test.each([
    ['workspace 不是 ws/<id>', { workspace: 'product-res' }, 'workspace'],
    ['goal 为空', { goal: '  ' }, 'goal'],
    ['executor 大写', { executor: 'Codex' }, 'executor'],
    ['verify.cmd 是字符串（必须 argv 数组）', { verify: [{ cmd: 'bun test' }] }, 'verify.0.cmd'],
    ['verify.cmd 空数组', { verify: [{ cmd: [] }] }, 'verify.0.cmd'],
    ['timeout_s 非正', { timeout_s: 0 }, 'timeout_s'],
    ['retry.max_attempts 为 0', { retry: { max_attempts: 0 } }, 'retry.max_attempts'],
    ['能力格式不合法', { requires: ['Bad Cap'] }, 'requires.0'],
    ['未知字段', { prioritty: 1 }, ''],
    ['inputs.fake 用于非 fake 执行器', { inputs: { fake: { outcome: 'done' } } }, 'inputs.fake'],
  ])('非法：%s', (_name, patch, path) => {
    const r = taskContract.safeParse({ ...contract, ...patch })
    expect(r.success).toBe(false)
    expect(issuePaths(r)).toContain(path)
  })

  test('其他执行器的 inputs 原样保留', () => {
    const c = taskContract.parse({ ...contract, inputs: { orca: { model: 'gpt-5' } } })
    expect(c.inputs).toEqual({ orca: { model: 'gpt-5' } })
  })
})

describe('fake 执行器指令', () => {
  test('合法', () => {
    expect(fakeInputs.parse({})).toEqual({ outcome: 'done', delay_ms: 0, activity: [] })
    expect(
      fakeInputs.parse({ outcome: 'failed', delay_ms: 100, activity: ['a', 'b'], message: 'x' }),
    ).toMatchObject({ outcome: 'failed' })
  })
  test.each([
    ['blocked 缺少原因', { outcome: 'blocked' }, 'blocked_reason'],
    ['done 带原因', { outcome: 'done', blocked_reason: 'question' }, 'blocked_reason'],
    ['delay_ms 为负', { delay_ms: -1 }, 'delay_ms'],
    ['未知 outcome', { outcome: 'hang' }, 'outcome'],
    ['未知字段', { exec: 'rm -rf /' }, ''],
  ])('非法：%s', (_n, input, path) => {
    const r = fakeInputs.safeParse(input)
    expect(r.success).toBe(false)
    expect(issuePaths(r)).toContain(path)
  })
})

describe('能力匹配', () => {
  test('executor:<executor> 隐含必需', () => {
    const c = taskContract.parse({ ...contract, requires: ['browser'] })
    expect(requiredCapabilities(c)).toEqual(['browser', 'executor:codex-orca'])
    expect(capabilitiesSatisfy(['browser', 'executor:codex-orca', 'x'], c)).toBe(true)
    expect(capabilitiesSatisfy(['browser'], c)).toBe(false)
    expect(capabilitiesSatisfy(['executor:fake', 'browser'], c)).toBe(false)
  })
})

const result = {
  summary: '已修复并提交 PR',
  artifacts: [{ kind: 'pr', ref: 'https://github.com/x/y/pull/1' }],
  verify: [{ cmd: ['bun', 'test'], exit_code: 0, duration_ms: 1200, output_tail: ['1 pass'] }],
  executor: 'codex-orca',
  node_id: 'node-mac-1',
}

describe('任务结果', () => {
  test('合法；默认值补齐', () => {
    const r = taskResult.parse(result)
    expect(r.verify[0]?.timed_out).toBe(false)
    expect(taskResult.parse({ ...result, artifacts: undefined, verify: undefined })).toMatchObject({
      artifacts: [],
      verify: [],
    })
    expect(
      taskResult.parse({
        ...result,
        verify: [{ cmd: ['x'], exit_code: null, duration_ms: 1, timed_out: true }],
      }).verify[0]?.exit_code,
    ).toBeNull()
  })
  test.each([
    ['缺少 summary', { summary: undefined }, 'summary'],
    ['未知产物类型', { artifacts: [{ kind: 'docker', ref: 'x' }] }, 'artifacts.0.kind'],
    [
      'exit_code 非整数',
      { verify: [{ cmd: ['x'], exit_code: 1.5, duration_ms: 1 }] },
      'verify.0.exit_code',
    ],
    ['缺少 node_id', { node_id: undefined }, 'node_id'],
  ])('非法：%s', (_n, patch, path) => {
    const r = taskResult.safeParse({ ...result, ...patch })
    expect(r.success).toBe(false)
    expect(issuePaths(r)).toContain(path)
  })
})

describe('活动', () => {
  test('合法与非法', () => {
    expect(
      activity.safeParse({ ts: '2026-10-24T08:00:00.000Z', kind: 'output', text: 'hi' }).success,
    ).toBe(true)
    expect(activity.safeParse({ ts: '2026-10-24T08:00:00Z', kind: 'heartbeat' }).success).toBe(true)
    expect(activity.safeParse({ ts: 'yesterday', kind: 'output' }).success).toBe(false)
    expect(activity.safeParse({ ts: '2026-10-24T08:00:00Z', kind: 'tool' }).success).toBe(false)
  })
})

describe('状态与状态机', () => {
  test('状态枚举', () => {
    expect(taskStatus.safeParse('queued').success).toBe(true)
    expect(taskStatus.safeParse('paused').success).toBe(false)
    expect(BLOCKED_REASONS).toEqual([
      'awaiting_approval',
      'question',
      'no_progress',
      'crashed',
      'workdir_missing',
      'node_lost',
      'other',
    ])
    expect(TASK_STATUSES.filter(isTerminalStatus)).toEqual(['done', 'failed', 'cancelled'])
  })

  /** task-ledger spec 的转换表，外加"允许重试的租约过期 → queued"。 */
  const legal = new Set([
    'queued>running',
    'running>verifying',
    'running>done',
    'running>failed',
    'running>blocked',
    'verifying>done',
    'verifying>failed',
    'verifying>blocked',
    'blocked>queued',
    'blocked>running',
    'blocked>cancelled',
    'blocked>failed',
    'blocked>done',
    'queued>cancelled',
    // worker-credential-isolation 6.1：中枢判定 isolation: required 不可满足时直接卡住（不带租约）。
    'queued>blocked',
    'running>cancelled',
    'verifying>cancelled',
    'running>queued',
    'verifying>queued',
    'failed>queued',
    // harness-neutral 8.5：已完成的任务只能因名单内用户的 PR 评论恢复（task.requeued{reason: input}）。
    'done>queued',
  ])

  const pairs: [TaskStatus, TaskStatus][] = TASK_STATUSES.flatMap((from) =>
    TASK_STATUSES.map((to) => [from, to] as [TaskStatus, TaskStatus]),
  )

  test.each(pairs.filter(([f, t]) => legal.has(`${f}>${t}`)))('合法：%s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true)
  })

  test.each(pairs.filter(([f, t]) => !legal.has(`${f}>${t}`)))('非法：%s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false)
  })

  test('取消不能恢复；完成与失败仅允许重新排队', () => {
    expect(TASK_STATUSES.some((t) => canTransition('cancelled', t))).toBe(false)
    expect(TASK_STATUSES.filter((t) => canTransition('done', t))).toEqual(['queued'])
    expect(TASK_STATUSES.filter((t) => canTransition('failed', t))).toEqual(['queued'])
  })
})

describe('任务视图', () => {
  const view = {
    id: 't_1',
    workspace: 'ws/product-res',
    status: 'blocked',
    contract: taskContract.parse(contract),
    attempt: 1,
    created_at: '2026-10-24T08:00:00.000Z',
    updated_at: '2026-10-24T08:01:00.000Z',
    started_at: '2026-10-24T08:00:05.000Z',
    finished_at: null,
    cancel_requested: false,
    blocked: { reason: 'question', message: '用哪个分支？', lease_held: false },
    lease: null,
    result: null,
    created_by: 'agent:supervisor',
    origin: null,
    branch: null,
    last_activity_at: null,
  }
  test('合法', () => expect(taskView.safeParse(view).success).toBe(true))
  test('非法：未知 blocked 原因', () => {
    const r = taskView.safeParse({ ...view, blocked: { reason: 'sleepy', message: 'x' } })
    expect(issuePaths(r)).toContain('blocked.reason')
  })
})

test('创建合同 cwd 只接受绝对路径或 ~/ 开头，保留路径供节点展开', () => {
  for (const cwd of ['.', './repo', '../repo', 'repo', '~', '~other/repo']) {
    expect(issuePaths(createTaskRequest.safeParse({ ...contract, cwd }))).toEqual(['cwd'])
  }
  for (const cwd of ['/', '/tmp/repo', '~/repo']) {
    expect(createTaskRequest.parse({ ...contract, cwd }).cwd).toBe(cwd)
  }
})
