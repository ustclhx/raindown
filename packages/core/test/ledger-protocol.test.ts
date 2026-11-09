import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  acquireLeaseData,
  acquireLeaseRequest,
  adapterCapabilities,
  cancelTaskRequest,
  completeLeaseRequest,
  createTaskData,
  ENDPOINTS,
  type EndpointName,
  errorBody,
  eventsQuery,
  fail,
  healthData,
  jsonSchemas,
  leaseSlotFor,
  listTasksQuery,
  loadHubConfig,
  loadNodeConfig,
  NO_ADAPTER_CAPABILITIES,
  okBody,
  PROTOCOL_ERRORS,
  registerNodeRequest,
  renewLeaseData,
  renewLeaseRequest,
  resolveHubUrl,
  taskContract,
  toJsonDocument,
} from '../src/index.ts'
import { tempHome } from './helpers.ts'

const ts = '2026-10-24T08:00:00.000Z'
const token = 'x'.repeat(24)
const result = { summary: 's', executor: 'fake', node_id: 'n1' }
const contract = taskContract.parse({
  goal: 'g',
  workspace: 'ws/global',
  role: 'r',
  executor: 'fake',
})
const view = {
  id: 't_1',
  workspace: 'ws/global',
  status: 'queued',
  contract,
  attempt: 0,
  created_at: ts,
  updated_at: ts,
  started_at: null,
  finished_at: null,
  cancel_requested: false,
  blocked: null,
  lease: null,
  result: null,
  created_by: 'user',
  origin: null,
  branch: null,
  last_activity_at: null,
}

describe('请求体', () => {
  test.each([
    [
      'tasks list 查询参数（字符串 limit 被转换）',
      listTasksQuery,
      { status: 'running', limit: '10' },
      true,
    ],
    ['tasks list：未知状态', listTasksQuery, { status: 'sleeping' }, false],
    ['tasks list：limit 超上限', listTasksQuery, { limit: '1000' }, false],
    ['cancel：可带原因', cancelTaskRequest, { reason: '不需要了' }, true],
    ['cancel：未知字段', cancelTaskRequest, { force: true }, false],
    ['events：after 字符串', eventsQuery, { after: '10' }, true],
    ['events：after 为负', eventsQuery, { after: '-1' }, false],
    [
      'nodes register',
      registerNodeRequest,
      { node_id: 'n1', hostname: 'mac', version: '0', capabilities: ['executor:fake'] },
      true,
    ],
    [
      'nodes register：缺 hostname',
      registerNodeRequest,
      { node_id: 'n1', version: '0', capabilities: [] },
      false,
    ],
    [
      'leases acquire',
      acquireLeaseRequest,
      { node_id: 'n1', capabilities: ['executor:fake'], wait_s: 30 },
      true,
    ],
    [
      'leases acquire：带 slots（D12）',
      acquireLeaseRequest,
      { node_id: 'n1', capabilities: [], slots: { general: 0, supervisor: 1, reply: 1 } },
      true,
    ],
    [
      'leases acquire：slots 为负数',
      acquireLeaseRequest,
      { node_id: 'n1', capabilities: [], slots: { general: -1 } },
      false,
    ],
    [
      'leases acquire：slots 未知类别',
      acquireLeaseRequest,
      { node_id: 'n1', capabilities: [], slots: { merge: 1 } },
      false,
    ],
    [
      'leases acquire：wait_s 过大',
      acquireLeaseRequest,
      { node_id: 'n1', capabilities: [], wait_s: 3600 },
      false,
    ],
    [
      'leases renew（批量活动 + 进入验收）',
      renewLeaseRequest,
      { lease_token: token, activity: [{ ts, kind: 'output', text: 'x' }], phase: 'verifying' },
      true,
    ],
    ['leases renew：缺令牌', renewLeaseRequest, { activity: [] }, false],
    ['complete done', completeLeaseRequest, { lease_token: token, outcome: 'done', result }, true],
    [
      'complete failed',
      completeLeaseRequest,
      { lease_token: token, outcome: 'failed', result },
      true,
    ],
    [
      'complete blocked',
      completeLeaseRequest,
      { lease_token: token, outcome: 'blocked', blocked_reason: 'question', message: '?' },
      true,
    ],
    [
      'complete cancelled',
      completeLeaseRequest,
      { lease_token: token, outcome: 'cancelled' },
      true,
    ],
    ['complete done 缺结果', completeLeaseRequest, { lease_token: token, outcome: 'done' }, false],
    [
      'complete blocked 缺说明',
      completeLeaseRequest,
      { lease_token: token, outcome: 'blocked', blocked_reason: 'question' },
      false,
    ],
    [
      'complete 未知 outcome',
      completeLeaseRequest,
      { lease_token: token, outcome: 'verifying' },
      false,
    ],
  ] as const)('%s', (_n, schema, body, valid) => {
    expect(schema.safeParse(body).success).toBe(valid)
  })

  test('acquire 的 wait_s 默认 30', () => {
    expect(acquireLeaseRequest.parse({ node_id: 'n1', capabilities: [] }).wait_s).toBe(30)
  })

  test('旧节点省略适配器能力时保守缺省，不按类型推断', () => {
    const request = registerNodeRequest.parse({
      node_id: 'n1',
      hostname: 'mac',
      version: '0',
      capabilities: ['executor:codex-orca'],
      executors: [{ type: 'codex-orca', mode: 'interactive' }],
    })
    expect(request.executors[0]?.adapter_capabilities).toEqual(NO_ADAPTER_CAPABILITIES)
  })

  test('声明的适配器能力须完整且类型合法', () => {
    expect(adapterCapabilities.safeParse({}).success).toBe(false)
    expect(
      adapterCapabilities.safeParse({ ...NO_ADAPTER_CAPABILITIES, approval_requests: 'auto' })
        .success,
    ).toBe(false)
    expect(
      adapterCapabilities.safeParse({ ...NO_ADAPTER_CAPABILITIES, resume_session: 'true' }).success,
    ).toBe(false)
  })

  test('适配器注册能力剥离未来新增键，保留已知字段', () => {
    expect(adapterCapabilities.parse({ ...NO_ADAPTER_CAPABILITIES, future_feature: true })).toEqual(
      NO_ADAPTER_CAPABILITIES,
    )
  })

  test('acquire 的 slots 可选，缺省类别为 0', () => {
    expect(acquireLeaseRequest.parse({ node_id: 'n1', capabilities: [] }).slots).toBeUndefined()
    expect(
      acquireLeaseRequest.parse({ node_id: 'n1', capabilities: [], slots: { reply: 1 } }).slots,
    ).toEqual({ general: 0, supervisor: 0, reply: 1 })
  })

  test('leaseSlotFor：按唤醒 origin 选择执行槽（D12）', () => {
    const s = (general: number, supervisor: number, reply: number) => ({
      general,
      supervisor,
      reply,
    })
    // 旧节点：只有普通空位，任何任务都可以
    expect(leaseSlotFor(undefined, null)).toBe('general')
    expect(leaseSlotFor(undefined, 'reply')).toBe('general')
    // 普通任务只用普通空位
    expect(leaseSlotFor(s(0, 1, 1), null)).toBeNull()
    expect(leaseSlotFor(s(1, 1, 1), null)).toBe('general')
    // 普通唤醒优先占 supervisor 槽，其次普通空位；不用 reply 槽
    expect(leaseSlotFor(s(1, 1, 1), 'instruction')).toBe('supervisor')
    expect(leaseSlotFor(s(1, 0, 1), 'autonomous')).toBe('general')
    expect(leaseSlotFor(s(0, 0, 1), 'instruction')).toBeNull()
    // reply 唤醒优先占 reply 槽，其次普通空位；不用 supervisor 槽
    expect(leaseSlotFor(s(1, 1, 1), 'reply')).toBe('reply')
    expect(leaseSlotFor(s(1, 1, 0), 'reply')).toBe('general')
    expect(leaseSlotFor(s(0, 1, 0), 'reply')).toBeNull()
  })
})

describe('响应体', () => {
  test('health', () => {
    expect(
      okBody(healthData).safeParse({ ok: true, data: { version: '0', uptime: 1.5, ledger_seq: 0 } })
        .success,
    ).toBe(true)
    expect(healthData.safeParse({ version: '0', uptime: 1, ledger_seq: -1 }).success).toBe(false)
  })
  test('create task', () => {
    expect(createTaskData.safeParse({ task: view, created: true }).success).toBe(true)
    expect(
      createTaskData.safeParse({ task: { ...view, status: 'new' }, created: true }).success,
    ).toBe(false)
  })
  test('acquire：无任务时为 null；有任务时带租约', () => {
    expect(acquireLeaseData.safeParse({ lease: null }).success).toBe(true)
    const lease = {
      lease_id: 'l1',
      lease_token: token,
      task_id: 't_1',
      workspace: 'ws/global',
      contract,
      attempt: 1,
      ttl_s: 60,
      expires_at: ts,
    }
    expect(acquireLeaseData.safeParse({ lease }).success).toBe(true)
    expect(acquireLeaseData.safeParse({ lease: { ...lease, attempt: 0 } }).success).toBe(false)
    const recovery = { previous_end: { attempt: 1, reason: 'lease_expired' as const }, prs: [] }
    expect(acquireLeaseData.parse({ lease: { ...lease, recovery } }).lease?.recovery).toEqual(
      recovery,
    )
    // 恢复提示的未来字段或结束原因不能让已分配的租约在旧节点上解析失败。
    for (const future of [
      { ...recovery, future_field: true },
      { ...recovery, previous_end: { attempt: 1, reason: 'future_end_reason' } },
    ]) {
      const parsed = acquireLeaseData.parse({ lease: { ...lease, recovery: future } }).lease
      expect(parsed?.lease_id).toBe(lease.lease_id)
      expect(parsed?.recovery).toBeUndefined()
    }
  })
  test('renew', () => {
    expect(
      renewLeaseData.safeParse({ lease_id: 'l1', expires_at: ts, cancel_requested: true }).success,
    ).toBe(true)
    expect(renewLeaseData.safeParse({ lease_id: 'l1', expires_at: ts }).success).toBe(false)
  })
  test('错误体与 toJsonDocument 的失败形态一致', () => {
    const doc = toJsonDocument(fail('failure', 'unauthorized', '缺少 token'))
    expect(errorBody.safeParse(doc).success).toBe(true)
    expect(errorBody.safeParse({ ok: false, error: { code: 'x', message: 'y' } }).success).toBe(
      false,
    )
  })
  test('错误码映射到 HTTP 状态', () => {
    expect(PROTOCOL_ERRORS.unauthorized.status).toBe(401)
    expect(PROTOCOL_ERRORS.invalid_transition.status).toBe(409)
    expect(PROTOCOL_ERRORS.lease_expired.status).toBe(409)
  })
})

describe('端点清单与 JSON Schema 导出', () => {
  test('端点', () => {
    const list = Object.entries(ENDPOINTS).map(([, d]) => `${d.method} ${d.path}`)
    expect(list).toEqual([
      'GET /v1/binding',
      'POST /v1/tasks/:id/report',
      'GET /v1/inbox',
      'POST /v1/inbox/:id/act',
      'POST /v1/policy/check',
      'GET /v1/health',
      'GET /v1/hub/status',
      'POST /v1/hub/rebuild',
      'POST /v1/hub/tokens',
      'GET /v1/hub/tokens',
      'POST /v1/hub/tokens/:id/revoke',
      'POST /v1/ui/login-code',
      'POST /v1/telegram/link-code',
      'POST /v1/telegram/unlink',
      'POST /v1/supervisor/wake',
      'GET /v1/supervisor/status',
      'GET /v1/supervisor/report',
      'POST /v1/tasks',
      'GET /v1/tasks',
      'GET /v1/tasks/:id',
      'GET /v1/events/:id',
      'POST /v1/kb/search',
      'POST /v1/kb/get',
      'POST /v1/kb/query',
      'POST /v1/tasks/:id/cancel',
      'POST /v1/tasks/:id/unsubscribe',
      'POST /v1/tasks/:id/retry',
      'POST /v1/tasks/:id/reply',
      'GET /v1/events',
      'POST /v1/nodes',
      'GET /v1/nodes',
      'POST /v1/leases',
      'POST /v1/leases/:id/renew',
      'POST /v1/leases/:id/complete',
      'POST /v1/briefs',
      'GET /v1/briefs/context',
      'POST /v1/supervisor/questions',
      'POST /v1/supervisor/patrol-report',
      'POST /v1/task-proposals',
      'POST /v1/decisions/review',
      'POST /v1/merge-requests',
      'POST /v1/supervisor/respond',
      'POST /v1/leases/:id/ack-reply',
    ])
    expect(Object.values(ENDPOINTS).filter((d) => !d.auth)).toHaveLength(1)
  })

  test('schemas/ 下包含 tasks、events、protocol、config', () => {
    const files = Object.keys(jsonSchemas())
    for (const f of [
      'tasks/contract.schema.json',
      'tasks/result.schema.json',
      'events/event.schema.json',
      'events/task.created.schema.json',
      'protocol/error.schema.json',
      'protocol/leases-complete.request.schema.json',
      'config/hub.schema.json',
      'config/node.schema.json',
    ]) {
      expect(files).toContain(f)
    }
    for (const name of Object.keys(ENDPOINTS) as EndpointName[]) {
      expect(files).toContain(`protocol/${name}.response.schema.json`)
    }
  })

  test('合同 schema 用输入形态：带默认值的字段不是必填', () => {
    const s = jsonSchemas()['tasks/contract.schema.json'] as { required: string[] }
    expect(s.required.sort()).toEqual(['executor', 'goal', 'role', 'workspace'])
  })
})

describe('守护进程配置', () => {
  const setup = (files: Record<string, string>) => {
    const home = tempHome()
    mkdirSync(join(home, 'config'), { recursive: true })
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(home, 'config', name), content)
    return home
  }

  test('文件不存在或为空时取默认值', async () => {
    const home = setup({ 'node.yaml': '' })
    expect(await loadHubConfig(home)).toEqual({
      ok: true,
      data: {
        port: 7477,
        heartbeat_interval_s: 300,
        lease_ttl_s: 60,
        lease_wait_max_s: 30,
        backup_keep: 14,
        backup_at: '03:30',
      },
    })
    expect(await loadNodeConfig(home)).toEqual({
      ok: true,
      data: {
        capabilities: [],
        concurrency: 1,
        reserved: { supervisor: 1, reply: 1 },
        isolation: { enforce: false, extra_write: [], dissociate: false },
      },
    })
  })

  test('合法配置', async () => {
    const home = setup({
      'hub.yaml': 'port: 8000\nheartbeat_url: https://hc-ping.com/abc\nbackup_at: "23:05"\n',
      'node.yaml':
        'capabilities: [browser, "repo:/x/y"]\nconcurrency: 2\nhub_url: http://127.0.0.1:8000/\n',
    })
    const hub = await loadHubConfig(home)
    const node = await loadNodeConfig(home)
    expect(hub.ok && hub.data.port).toBe(8000)
    expect(node.ok && node.data.concurrency).toBe(2)
    if (hub.ok && node.ok) {
      expect(resolveHubUrl(hub.data, node.data)).toBe('http://127.0.0.1:8000')
      expect(resolveHubUrl(hub.data)).toBe('http://127.0.0.1:8000')
    }
  })

  test.each([
    ['hub.yaml', 'port: 70000\n', 'port'],
    ['hub.yaml', 'backup_at: "3:30"\n', 'backup_at'],
    ['hub.yaml', 'heartbeat_url: ftp://x\n', 'heartbeat_url'],
    ['hub.yaml', 'lease_tll_s: 30\n', ''],
    ['node.yaml', 'capabilities: [Browser]\n', 'capabilities.0'],
    ['node.yaml', 'concurrency: 0\n', 'concurrency'],
    ['node.yaml', 'reserved: { supervisor: -1 }\n', 'reserved.supervisor'],
    ['node.yaml', 'reserved: { supervisr: 1 }\n', 'reserved'],
  ])('非法 %s：%s 错误带字段路径', async (file, content, field) => {
    const home = setup({ [file]: content })
    const r = file === 'hub.yaml' ? await loadHubConfig(home) : await loadNodeConfig(home)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_config')
      const issues = r.error.details as { file: string; field?: string }[]
      expect(issues[0]?.file).toBe(`config/${file}`)
      expect(issues[0]?.field ?? '').toBe(field)
    }
  })

  test('YAML 语法错误', async () => {
    const r = await loadHubConfig(setup({ 'hub.yaml': 'port: [1\n' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_config')
  })
})
