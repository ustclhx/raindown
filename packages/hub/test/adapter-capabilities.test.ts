import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  type AdapterCapabilities,
  credentialIsolationFor,
  type ExecutorInfo,
  NO_ADAPTER_CAPABILITIES,
  openDatabase,
  roleSandboxSetting,
} from '@raindown/core'
import { createNodeProtocol } from '../src/index.ts'
import { tempLedger } from './ledger-helpers.ts'

let savedHome: string | undefined
const cleanups: Array<() => void> = []
beforeEach(() => {
  savedHome = process.env.RAINDOWN_HOME
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  if (savedHome === undefined) delete process.env.RAINDOWN_HOME
  else process.env.RAINDOWN_HOME = savedHome
})

async function setup() {
  const ledger = await tempLedger()
  process.env.RAINDOWN_HOME = ledger.dir
  cleanups.push(ledger.cleanup)
  const protocol = createNodeProtocol({ ledger: ledger.store, leaseTtlS: 60, leaseWaitMaxS: 30 })
  cleanups.push(() => protocol.stop())
  return { ...ledger, service: protocol.service, routes: protocol.routes }
}

const registration = {
  node_id: 'n-adapter',
  hostname: 'host',
  version: '0',
  capabilities: ['executor:custom-harness'],
}

test('注册保存任意适配器自述的能力，重放后仍可列出', async () => {
  const { store, service } = await setup()
  const capabilities: AdapterCapabilities = {
    approval_requests: 'structured',
    inject_while_running: true,
    resume_session: false,
    raindown_mcp: true,
    out_of_band_detection: false,
  }
  const executors: ExecutorInfo[] = [
    { type: 'custom-harness', mode: 'headless', adapter_capabilities: capabilities },
  ]
  const registered = service.registerNode({ ...registration, executors }, 'unknown')
  expect(registered.ok && registered.data.node.executors).toEqual(executors)
  expect(store.eventsAfter(0)[0]?.payload).toMatchObject({ executors })
  expect(store.rebuild().ok).toBe(true)
  const listed = service.listNodes()
  expect(listed.ok && listed.data.nodes[0]?.executors).toEqual(executors)
})

test('旧节点注册、旧投影与旧注册事件重放都补齐保守能力', async () => {
  const { path, store, service } = await setup()
  const oldExecutor = { type: 'codex-orca', mode: 'interactive' as const }
  const oldExecutors = [oldExecutor]
  const expected = [{ ...oldExecutor, adapter_capabilities: NO_ADAPTER_CAPABILITIES }]
  const registered = service.registerNode({ ...registration, executors: oldExecutors }, 'unknown')
  expect(registered.ok && registered.data.node.executors).toEqual(expected)

  // 模拟升级前已存在的节点投影和账本，不能靠新写入的 schema 补缺省。
  const db = await openDatabase(path)
  try {
    db.prepare('UPDATE nodes SET executors_json = ? WHERE node_id = ?').run(
      JSON.stringify(oldExecutors),
      registration.node_id,
    )
    db.prepare('INSERT INTO events (ts, type, actor, payload_json) VALUES (?, ?, ?, ?)').run(
      '2026-11-06T00:00:00.000Z',
      'node.registered',
      'node:n-adapter',
      JSON.stringify({ ...registration, executors: oldExecutors, concurrency: 1 }),
    )
  } finally {
    db.close()
  }
  expect(store.getNode(registration.node_id)?.executors).toEqual(expected)
  expect(store.rebuild().ok).toBe(true)
  expect(store.getNode(registration.node_id)?.executors).toEqual(expected)
})

test('HTTP 注册剥离未来能力键，已知能力字段类型错误仍拒绝', async () => {
  const { routes } = await setup()
  const register = (adapter_capabilities: unknown, mode?: unknown) =>
    routes.request('/v1/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...registration,
        executors: [{ type: 'custom-harness', mode, adapter_capabilities, future_metadata: true }],
      }),
    })
  const response = await register({ ...NO_ADAPTER_CAPABILITIES, future_feature: true })
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toHaveProperty('data.node.executors', [
    { type: 'custom-harness', adapter_capabilities: NO_ADAPTER_CAPABILITIES },
  ])
  const invalid = await register({ ...NO_ADAPTER_CAPABILITIES, resume_session: 'true' })
  expect(invalid.status).toBe(400)
  const invalidMode = await register(NO_ADAPTER_CAPABILITIES, 'future-mode')
  expect(invalidMode.status).toBe(400)
})

test.each(['event', 'projection'] as const)(
  '读取 %s 的未来 mode、能力键与未知字段值时逐项降级，保留其他已知能力',
  async (source) => {
    const { path, store, service } = await setup()
    const registered = service.registerNode(
      { ...registration, executors: [{ type: 'custom-harness' }] },
      'unknown',
    )
    expect(registered.ok).toBe(true)
    const executors = [
      {
        type: 'custom-harness',
        mode: 'future-mode',
        future_metadata: true,
        adapter_capabilities: {
          approval_requests: 'future-approval-mode',
          inject_while_running: true,
          resume_session: 'unsupported',
          raindown_mcp: true,
          future_feature: true,
        },
      },
    ]
    const db = await openDatabase(path)
    try {
      if (source === 'projection') {
        db.prepare('UPDATE nodes SET executors_json = ? WHERE node_id = ?').run(
          JSON.stringify(executors),
          registration.node_id,
        )
      } else {
        db.prepare('INSERT INTO events (ts, type, actor, payload_json) VALUES (?, ?, ?, ?)').run(
          '2026-11-06T00:00:00.000Z',
          'node.registered',
          'node:n-adapter',
          JSON.stringify({ ...registration, executors, concurrency: 1 }),
        )
      }
    } finally {
      db.close()
    }
    if (source === 'event') expect(store.rebuild().ok).toBe(true)
    const storedExecutors = store.getNode(registration.node_id)?.executors
    expect(JSON.stringify(storedExecutors)).not.toContain('"mode"')
    expect(storedExecutors).toEqual([
      {
        type: 'custom-harness',
        adapter_capabilities: {
          ...NO_ADAPTER_CAPABILITIES,
          inject_while_running: true,
          raindown_mcp: true,
        },
      },
    ])
  },
)

describe('凭证隔离能力 credential_isolation（worker-credential-isolation 1.3）', () => {
  const declared: AdapterCapabilities = {
    ...NO_ADAPTER_CAPABILITIES,
    raindown_mcp: true,
    credential_isolation: {
      layers: {
        'danger-full-access': 'seatbelt',
        'workspace-write': 'native',
        'read-only': 'native',
      },
      enforced: false,
    },
  }

  test('注册保存按沙箱设置声明的施加层与未施加状态，重放后不变', async () => {
    const { store, service } = await setup()
    const executors: ExecutorInfo[] = [{ type: 'codex-exec', adapter_capabilities: declared }]
    const registered = service.registerNode({ ...registration, executors }, 'unknown')
    expect(registered.ok && registered.data.node.executors).toEqual(executors)
    expect(store.rebuild().ok).toBe(true)
    const caps = store.getNode(registration.node_id)?.executors[0]?.adapter_capabilities
    expect(caps).toEqual(declared)
    const dev = { executor: 'codex-exec', permissions: { sandbox: 'danger-full-access' } }
    expect(
      credentialIsolationFor(caps ?? NO_ADAPTER_CAPABILITIES, roleSandboxSetting(dev)),
    ).toEqual({ reported: true, layer: 'seatbelt', enforced: false })
    expect(
      credentialIsolationFor(
        caps ?? NO_ADAPTER_CAPABILITIES,
        roleSandboxSetting({ executor: 'codex-exec' }),
      ),
    ).toEqual({ reported: true, layer: 'native', enforced: false })
  })

  test('旧节点不上报时投影为未上报（按 none 处理），不影响注册', async () => {
    const { store, service } = await setup()
    const registered = service.registerNode(
      { ...registration, executors: [{ type: 'codex-orca', mode: 'interactive' }] },
      'unknown',
    )
    expect(registered.ok).toBe(true)
    const caps = store.getNode(registration.node_id)?.executors[0]?.adapter_capabilities
    expect(caps?.credential_isolation).toBeUndefined()
    expect(
      credentialIsolationFor(
        caps ?? NO_ADAPTER_CAPABILITIES,
        roleSandboxSetting({
          executor: 'codex-orca',
          permissions: { sandbox: 'danger-full-access' },
        }),
      ),
    ).toEqual({ reported: false, layer: 'none', enforced: false })
  })

  test('HTTP 注册接受未来的沙箱设置键与格式合法的未知施加层（查询按 none），格式错误仍拒绝', async () => {
    const { routes } = await setup()
    const register = (credential_isolation: unknown) =>
      routes.request('/v1/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...registration,
          executors: [
            {
              type: 'custom-harness',
              adapter_capabilities: { ...NO_ADAPTER_CAPABILITIES, credential_isolation },
            },
          ],
        }),
      })
    const future = await register({ layers: { 'future-sandbox': 'seatbelt' }, enforced: false })
    expect(future.status).toBe(200)
    expect(await future.json()).toHaveProperty(
      'data.node.executors.0.adapter_capabilities.credential_isolation',
      { layers: { 'future-sandbox': 'seatbelt' }, enforced: false },
    )
    expect(
      (await register({ layers: { 'read-only': 'Bad Layer!' }, enforced: false })).status,
    ).toBe(400)
    const unknownLayer = await register({ layers: { 'read-only': 'future-layer' }, enforced: true })
    expect(unknownLayer.status).toBe(200)
    const body = (await unknownLayer.json()) as {
      data: { node: { executors: Array<{ adapter_capabilities: AdapterCapabilities }> } }
    }
    const caps = body.data.node.executors[0]?.adapter_capabilities ?? NO_ADAPTER_CAPABILITIES
    expect(caps.credential_isolation?.layers).toEqual({ 'read-only': 'future-layer' })
    // 新节点的未知施加层不能被当作已支持的隔离。
    expect(credentialIsolationFor(caps, 'read-only')).toEqual({
      reported: true,
      layer: 'none',
      enforced: false,
    })
    expect((await register({ layers: {}, enforced: 'no' })).status).toBe(400)
  })

  test.each(['event', 'projection'] as const)(
    '读取 %s 中不认识的施加层与不合法字段时逐项降级，不影响其他能力',
    async (source) => {
      const { path, store, service } = await setup()
      expect(
        service.registerNode(
          { ...registration, executors: [{ type: 'custom-harness' }] },
          'unknown',
        ).ok,
      ).toBe(true)
      const executors = [
        {
          type: 'custom-harness',
          adapter_capabilities: {
            ...NO_ADAPTER_CAPABILITIES,
            inject_while_running: true,
            credential_isolation: {
              layers: {
                'danger-full-access': 'future-layer',
                'read-only': 'native',
                'workspace-write': 42,
              },
              enforced: 'unknown',
              future_field: 1,
            },
          },
        },
        {
          type: 'other-harness',
          adapter_capabilities: { ...NO_ADAPTER_CAPABILITIES, credential_isolation: 'seatbelt' },
        },
      ]
      const db = await openDatabase(path)
      try {
        if (source === 'projection') {
          db.prepare('UPDATE nodes SET executors_json = ? WHERE node_id = ?').run(
            JSON.stringify(executors),
            registration.node_id,
          )
        } else {
          db.prepare('INSERT INTO events (ts, type, actor, payload_json) VALUES (?, ?, ?, ?)').run(
            '2026-11-09T00:00:00.000Z',
            'node.registered',
            'node:n-adapter',
            JSON.stringify({ ...registration, executors, concurrency: 1 }),
          )
        }
      } finally {
        db.close()
      }
      if (source === 'event') expect(store.rebuild().ok).toBe(true)
      const stored = store.getNode(registration.node_id)?.executors
      expect(stored?.[0]?.adapter_capabilities).toEqual({
        ...NO_ADAPTER_CAPABILITIES,
        inject_while_running: true,
        credential_isolation: {
          layers: {
            'danger-full-access': 'future-layer',
            'read-only': 'native',
            'workspace-write': 'none',
          },
          enforced: false,
        },
      })
      expect(stored?.[1]?.adapter_capabilities).toEqual(NO_ADAPTER_CAPABILITIES)
      expect(stored?.[1]?.adapter_capabilities.credential_isolation).toBeUndefined()
    },
  )
})
