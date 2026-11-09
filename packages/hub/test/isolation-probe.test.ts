import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  credentialIsolationFor,
  type ExecutorInfo,
  findProbeRun,
  type IsolationProbeReport,
  NO_ADAPTER_CAPABILITIES,
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

const executors = (enforced: boolean): ExecutorInfo[] => [
  {
    type: 'codex-exec',
    adapter_capabilities: {
      ...NO_ADAPTER_CAPABILITIES,
      credential_isolation: { layers: { 'danger-full-access': 'seatbelt' }, enforced },
    },
  },
]

const registration = {
  node_id: 'n-probe',
  hostname: 'host',
  version: '0',
  capabilities: ['executor:codex-exec'],
}

/** 一次探针结果：passed 时 hub.token 被拒绝，否则可读。 */
const report = (passed: boolean, ranAt = '2026-11-09T00:00:00.000Z'): IsolationProbeReport => ({
  ran_at: ranAt,
  macos_version: '15.1',
  runs: [
    {
      executor: 'codex-exec',
      setting: 'danger-full-access',
      declared_layer: 'seatbelt',
      applied_layer: 'seatbelt',
      passed,
      items: [
        {
          item: 'read.hub_token',
          target: '/h/state/hub.token',
          expected: 'deny',
          actual: passed ? 'deny' : 'allow',
          ok: passed,
          ...(passed ? { detail: 'EPERM' } : {}),
        },
      ],
    },
  ],
})

const isolationItems = (store: Awaited<ReturnType<typeof setup>>['store']) =>
  store.listInboxItems({ source: 'isolation', limit: 100 })

describe('探针结果随节点注册上报（worker-credential-isolation 3.2）', () => {
  test('中枢投影保存最近一次结果、时间与 macOS 版本，重放后不变', async () => {
    const { store, service } = await setup()
    const r = service.registerNode(
      { ...registration, executors: executors(false), isolation_probe: report(false) },
      'unknown',
    )
    expect(r.ok && r.data.node.isolation_probe).toEqual(report(false))
    expect(store.rebuild().ok).toBe(true)
    const node = store.getNode(registration.node_id)
    expect(node?.isolation_probe?.macos_version).toBe('15.1')
    expect(node?.isolation_probe?.ran_at).toBe('2026-11-09T00:00:00.000Z')
  })

  test('旧节点不上报：投影为 null（未探测），之后不带结果的注册也清空为未探测', async () => {
    const { store, service } = await setup()
    expect(service.registerNode(registration, 'unknown').ok).toBe(true)
    expect(store.getNode(registration.node_id)?.isolation_probe).toBeNull()
    service.registerNode({ ...registration, isolation_probe: report(true) }, 'unknown')
    expect(store.getNode(registration.node_id)?.isolation_probe).not.toBeNull()
    service.registerNode(registration, 'unknown')
    expect(store.getNode(registration.node_id)?.isolation_probe).toBeNull()
  })

  test('不合法的探针结果拒绝注册（400），不影响后续合法注册', async () => {
    const { service } = await setup()
    const bad = service.registerNode(
      { ...registration, isolation_probe: { ran_at: 'yesterday', runs: [] } },
      'unknown',
    )
    expect(bad.ok).toBe(false)
    expect(service.registerNode(registration, 'unknown').ok).toBe(true)
  })

  test('enforced 由探针决定：声明已施加且最近一次探针通过才为 true', async () => {
    const { store, service } = await setup()
    for (const [enforced, passed, expected] of [
      [true, true, true],
      [true, false, false],
      [false, true, false],
    ] as const) {
      service.registerNode(
        { ...registration, executors: executors(enforced), isolation_probe: report(passed) },
        'unknown',
      )
      const node = store.getNode(registration.node_id)
      const caps = node?.executors[0]?.adapter_capabilities ?? NO_ADAPTER_CAPABILITIES
      const run = findProbeRun(node?.isolation_probe, 'codex-exec', 'danger-full-access')
      expect(credentialIsolationFor(caps, 'danger-full-access', run).enforced).toBe(expected)
    }
  })
})

describe('隔离自检失败通知', () => {
  test('从通过变为不通过时写一条 Digest 收件箱条目；未变化不重复写', async () => {
    const { store, service } = await setup()
    const reg = (passed: boolean, at: string) =>
      service.registerNode(
        { ...registration, executors: executors(false), isolation_probe: report(passed, at) },
        'unknown',
      )
    reg(true, '2026-11-09T00:00:00.000Z')
    reg(true, '2026-11-09T06:00:00.000Z')
    expect(isolationItems(store)).toEqual([])
    reg(false, '2026-11-09T12:00:00.000Z')
    const items = isolationItems(store)
    expect(items.length).toBe(1)
    expect(items[0]).toMatchObject({ level: 'digest', source: 'isolation', state: 'open' })
    expect(items[0]?.title).toContain('n-probe')
    expect(items[0]?.body).toContain('read.hub_token（/h/state/hub.token）')
    expect(items[0]?.body).toContain('codex-exec × danger-full-access')
    // 一直不通过：不重复写。
    reg(false, '2026-11-09T18:00:00.000Z')
    expect(isolationItems(store).length).toBe(1)
    // 恢复通过后再次变为不通过：写新的一条。
    reg(true, '2026-11-10T00:00:00.000Z')
    reg(false, '2026-11-10T06:00:00.000Z')
    expect(isolationItems(store).length).toBe(2)
  })

  test('首次探测就不通过、或从未探测变为不通过时不写（没有“通过”的上一次）', async () => {
    const { store, service } = await setup()
    service.registerNode({ ...registration, isolation_probe: report(false) }, 'unknown')
    service.registerNode(registration, 'unknown')
    service.registerNode({ ...registration, isolation_probe: report(false) }, 'unknown')
    expect(isolationItems(store)).toEqual([])
  })
})
