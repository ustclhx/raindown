import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ExecutorInfo,
  HubClient,
  ISOLATION_UNAVAILABLE,
  type IsolationProbeReport,
  initRaindownHome,
  NO_ADAPTER_CAPABILITIES,
  PROBE_REQUIRED_DENY_ITEMS,
  type Result,
  type RoleIsolation,
  raindownPaths,
  roleIsolationTarget,
  type TaskContractInput,
} from '@raindown/core'
import {
  createNodeProtocol,
  createTaskService,
  type LedgerStore,
  type NodeProtocol,
  type RoleIsolationSource,
  roleIsolationFromHome,
  runHub,
} from '../src/index.ts'
import { anyRole, contractInput, tempLedger } from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

/** 角色隔离要求的派送（add-worker-credential-isolation 6.1）。 */

const NOW = Date.parse('2026-11-10T08:00:00.000Z')
const SETTING = 'danger-full-access'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

const executors = (enforced: boolean, layer = 'seatbelt'): ExecutorInfo[] => [
  {
    type: 'codex-exec',
    adapter_capabilities: {
      ...NO_ADAPTER_CAPABILITIES,
      credential_isolation: { layers: { [SETTING]: layer }, enforced },
    },
  },
]

/** 一次探针结果：passed 时全部核心项被拒绝；否则 hub.token 可读。 */
const probe = (passed: boolean, ranAt = new Date(NOW - 60_000).toISOString()) =>
  ({
    ran_at: ranAt,
    macos_version: '15.1',
    runs: [
      {
        executor: 'codex-exec',
        setting: SETTING,
        declared_layer: 'seatbelt',
        applied_layer: 'seatbelt',
        passed,
        items: PROBE_REQUIRED_DENY_ITEMS.map((item) => ({
          item,
          expected: 'deny' as const,
          actual: !passed && item === 'read.hub_token' ? ('allow' as const) : ('deny' as const),
          ok: passed || item !== 'read.hub_token',
        })),
      },
    ],
  }) satisfies IsolationProbeReport

type NodeKind = 'isolated' | 'unisolated' | 'probe_failed' | 'switch_off' | 'legacy'

interface Ctx {
  ledger: LedgerStore
  protocol: NodeProtocol
  clock: FakeClock
  level: { value: RoleIsolation }
  register(nodeId: string, kind: NodeKind): void
  create(over?: Partial<TaskContractInput>): Promise<string>
  acquire(nodeId: string, capabilities?: string[]): Promise<string | null>
  retry(id: string): Promise<void>
}

async function setup(opts: { roleIsolation?: RoleIsolationSource } = {}): Promise<Ctx> {
  const clock = new FakeClock(NOW)
  const t = await tempLedger({ now: clock.now })
  const level = { value: 'required' as RoleIsolation }
  const roleIsolation: RoleIsolationSource = opts.roleIsolation ?? {
    lookup: (contract) =>
      roleIsolationTarget(
        {
          name: contract.role,
          executor: 'codex-exec',
          permissions: { sandbox: SETTING },
          isolation: level.value,
        },
        contract,
      ),
  }
  const protocol = createNodeProtocol({
    ledger: t.store,
    clock,
    leaseTtlS: 60,
    leaseWaitMaxS: 30,
    roleIsolation,
  })
  cleanups.push(() => {
    protocol.stop()
    t.cleanup()
  })
  const tasks = createTaskService({
    ledger: t.store,
    workspaceExists: () => true,
    roles: anyRole,
    now: clock.now,
  })
  return {
    ledger: t.store,
    protocol,
    clock,
    level,
    register(nodeId, kind) {
      const base = {
        node_id: nodeId,
        hostname: 'h',
        version: '0',
        capabilities: ['executor:codex-exec'],
      }
      const body =
        kind === 'legacy'
          ? base
          : {
              ...base,
              executors: executors(
                kind !== 'switch_off',
                kind === 'unisolated' ? 'none' : 'seatbelt',
              ),
              ...(kind === 'isolated' ? { isolation_probe: probe(true) } : {}),
              ...(kind === 'probe_failed' ? { isolation_probe: probe(false) } : {}),
            }
      const r = protocol.service.registerNode(body, 'unknown')
      if (!r.ok) throw new Error(r.error.message)
    },
    async create(over = {}) {
      const r = await tasks.createTask(contractInput({ executor: 'codex-exec', ...over }), {
        actor: 'user',
      })
      if (!r.ok) throw new Error(r.error.message)
      return r.data.task.id
    },
    async acquire(nodeId, capabilities = ['executor:codex-exec']) {
      const r = await protocol.service.acquire({ node_id: nodeId, capabilities, wait_s: 0 })
      if (!r.ok) throw new Error(r.error.message)
      return r.data.lease?.task_id ?? null
    },
    async retry(id) {
      const r = await tasks.retryTask(id, { actor: 'user' })
      if (!r.ok) throw new Error(r.error.message)
    },
  }
}

const started = (ledger: LedgerStore, id: string) =>
  ledger.taskEvents(id).filter((e) => e.type === 'task.started')
const unisolatedItems = (ledger: LedgerStore) =>
  ledger
    .listInboxItems({ source: 'isolation', limit: 100 })
    .filter((i) => i.reason === 'unisolated')

describe('派送：三种取值 × 节点情况', () => {
  for (const value of ['required', 'preferred', 'off'] as const) {
    test(`${value}：已隔离节点照常派送，不标注`, async () => {
      const c = await setup()
      c.level.value = value
      c.register('n-iso', 'isolated')
      const id = await c.create()
      expect(await c.acquire('n-iso')).toBe(id)
      expect(c.ledger.getTask(id)?.status).toBe('running')
      const [s] = started(c.ledger, id)
      expect(s?.type === 'task.started' && s.payload.unisolated).toBeFalsy()
      expect(unisolatedItems(c.ledger)).toEqual([])
    })

    test(`${value}：没有可用节点时留在队列`, async () => {
      const c = await setup()
      c.level.value = value
      // 只有不具备执行器能力的节点在领取。
      const r = c.protocol.service.registerNode(
        { node_id: 'n-other', hostname: 'h', version: '0', capabilities: ['executor:fake'] },
        'unknown',
      )
      expect(r.ok).toBe(true)
      const id = await c.create()
      expect(await c.acquire('n-other', ['executor:fake'])).toBeNull()
      expect(c.ledger.getTask(id)?.status).toBe('queued')
      expect(unisolatedItems(c.ledger)).toEqual([])
    })
  }

  test('required：未隔离节点不派送，中枢写 blocked(other) isolation_unavailable，说明缺什么', async () => {
    const c = await setup()
    c.register('n-plain', 'unisolated')
    const id = await c.create()
    expect(await c.acquire('n-plain')).toBeNull()
    const task = c.ledger.getTask(id)
    expect(task?.status).toBe('blocked')
    expect(task?.attempt).toBe(0)
    expect(task?.blocked?.reason).toBe('other')
    expect(task?.blocked?.message.startsWith(`${ISOLATION_UNAVAILABLE}：`)).toBe(true)
    expect(task?.blocked?.message).toContain(`codex-exec × ${SETTING} 的施加层为 none`)
    expect(task?.blocked?.message).toContain('n-plain')
    expect(task?.blocked?.no_delegate).toBe(true)
    expect(started(c.ledger, id)).toEqual([])
    expect(c.ledger.getTask(id)?.blocked).not.toBeNull()
  })

  test('required：开关关闭（适配器未施加）与探针失败项写进卡住消息', async () => {
    const c = await setup()
    c.register('n-off', 'switch_off')
    const a = await c.create()
    expect(await c.acquire('n-off')).toBeNull()
    expect(c.ledger.getTask(a)?.blocked?.message).toContain('isolation.enforce')

    c.register('n-off', 'probe_failed')
    const b = await c.create()
    expect(await c.acquire('n-off')).toBeNull()
    const message = c.ledger.getTask(b)?.blocked?.message ?? ''
    expect(message).toContain('隔离自检失败项')
    expect(message).toContain('read.hub_token')
  })

  test('required：过期的探针结果不算已隔离', async () => {
    const c = await setup()
    const r = c.protocol.service.registerNode(
      {
        node_id: 'n-stale',
        hostname: 'h',
        version: '0',
        capabilities: ['executor:codex-exec'],
        executors: executors(true),
        isolation_probe: probe(true, new Date(NOW - 13 * 60 * 60_000).toISOString()),
      },
      'unknown',
    )
    expect(r.ok).toBe(true)
    const id = await c.create()
    expect(await c.acquire('n-stale')).toBeNull()
    expect(c.ledger.getTask(id)?.blocked?.message).toContain('已过期')
  })

  test('preferred：未隔离节点照常派送，task.started 记“未隔离”，收件箱 Digest 提示', async () => {
    const c = await setup()
    c.level.value = 'preferred'
    c.register('n-plain', 'unisolated')
    const id = await c.create()
    expect(await c.acquire('n-plain')).toBe(id)
    const [s] = started(c.ledger, id)
    expect(s?.type === 'task.started' && s.payload.unisolated).toContain('未隔离')
    const items = unisolatedItems(c.ledger)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ level: 'digest', source_ref: `n-plain/codex-exec/${SETTING}` })
    expect(items[0]?.body).toContain(`最近一个任务：${id}`)
    expect(items[0]?.body).toContain('施加层为 none')
  })

  test('off：未隔离节点照常派送，不标注', async () => {
    const c = await setup()
    c.level.value = 'off'
    c.register('n-plain', 'unisolated')
    const id = await c.create()
    expect(await c.acquire('n-plain')).toBe(id)
    const [s] = started(c.ledger, id)
    expect(s?.type === 'task.started' && s.payload.unisolated).toBeFalsy()
    expect(unisolatedItems(c.ledger)).toEqual([])
  })
})

describe('派送：细节', () => {
  test('required：另有已隔离节点时，未隔离节点不领取也不卡住，留给已隔离节点', async () => {
    const c = await setup()
    c.register('n-plain', 'unisolated')
    c.register('n-iso', 'isolated')
    const id = await c.create()
    expect(await c.acquire('n-plain')).toBeNull()
    expect(c.ledger.getTask(id)?.status).toBe('queued')
    expect(await c.acquire('n-iso')).toBe(id)
  })

  test('旧节点（不上报 credential_isolation）按 none：required 卡住，preferred 标注', async () => {
    const c = await setup()
    c.register('n-old', 'legacy')
    const a = await c.create()
    expect(await c.acquire('n-old')).toBeNull()
    expect(c.ledger.getTask(a)?.blocked?.message).toContain('未上报凭证隔离能力')

    c.level.value = 'preferred'
    const b = await c.create()
    expect(await c.acquire('n-old')).toBe(b)
    expect(unisolatedItems(c.ledger).map((i) => i.source_ref)).toEqual([
      `n-old/codex-exec/${SETTING}`,
    ])
    expect(unisolatedItems(c.ledger)[0]?.body).toContain(b)
  })

  test('preferred：同一任务重新派送时收件箱只提示一次', async () => {
    const c = await setup()
    c.level.value = 'preferred'
    c.register('n-plain', 'unisolated')
    const id = await c.create()
    expect(await c.acquire('n-plain')).toBe(id)
    // 结束这一轮后重试，再次派到未隔离节点。
    const lease = c.ledger.taskEvents(id).find((e) => e.type === 'lease.granted')
    if (lease?.type !== 'lease.granted') throw new Error('没有租约')
    c.ledger.appendMany(
      [
        {
          task_id: id,
          workspace: c.ledger.getTask(id)?.workspace ?? '',
          type: 'task.failed',
          payload: { message: '测试失败' },
        },
      ],
      { actor: 'user' },
    )
    await c.retry(id)
    expect(await c.acquire('n-plain')).toBe(id)
    expect(started(c.ledger, id)).toHaveLength(2)
    expect(unisolatedItems(c.ledger)).toHaveLength(1)
  })

  test('required：恢复隔离（重新注册且探针通过）后重试即可正常派送', async () => {
    const c = await setup()
    c.register('n1', 'probe_failed')
    const id = await c.create()
    expect(await c.acquire('n1')).toBeNull()
    expect(c.ledger.getTask(id)?.status).toBe('blocked')
    // 卡住期间仍不可满足时重试会再次卡住。
    await c.retry(id)
    expect(c.ledger.getTask(id)?.status).toBe('queued')
    expect(await c.acquire('n1')).toBeNull()
    expect(c.ledger.getTask(id)?.status).toBe('blocked')
    c.register('n1', 'isolated')
    await c.retry(id)
    expect(await c.acquire('n1')).toBe(id)
    expect(c.ledger.getTask(id)?.attempt).toBe(1)
  })

  test('排队中的任务只能由中枢以 isolation_unavailable 卡住', async () => {
    const c = await setup()
    const id = await c.create()
    const workspace = c.ledger.getTask(id)?.workspace ?? ''
    const draft = (message: string) => ({
      task_id: id,
      workspace,
      type: 'task.blocked' as const,
      payload: { reason: 'other' as const, message, lease_held: false },
    })
    expect(c.ledger.append(draft(`${ISOLATION_UNAVAILABLE}：x`), { actor: 'user' }).ok).toBe(false)
    expect(c.ledger.append(draft('其他原因'), { actor: 'hub' }).ok).toBe(false)
    expect(c.ledger.append(draft(`${ISOLATION_UNAVAILABLE}：x`), { actor: 'hub' }).ok).toBe(true)
  })

  test('未配置角色隔离来源时不检查（等同 off）', async () => {
    const clock = new FakeClock(NOW)
    const t = await tempLedger({ now: clock.now })
    const protocol = createNodeProtocol({
      ledger: t.store,
      clock,
      leaseTtlS: 60,
      leaseWaitMaxS: 30,
    })
    cleanups.push(() => {
      protocol.stop()
      t.cleanup()
    })
    const tasks = createTaskService({
      ledger: t.store,
      workspaceExists: () => true,
      roles: anyRole,
      now: clock.now,
    })
    protocol.service.registerNode(
      { node_id: 'n1', hostname: 'h', version: '0', capabilities: ['executor:codex-exec'] },
      'unknown',
    )
    const r = await tasks.createTask(contractInput({ executor: 'codex-exec' }), { actor: 'user' })
    if (!r.ok) throw new Error(r.error.message)
    const a = await protocol.service.acquire({
      node_id: 'n1',
      capabilities: ['executor:codex-exec'],
      wait_s: 0,
    })
    expect(a.ok && a.data.lease?.task_id).toBe(r.data.task.id)
  })
})

describe('审查修复（第一轮）', () => {
  test('M1：同一 节点 × 执行器 × 沙箱设置 连续多个任务只有一条未隔离提示', async () => {
    const c = await setup()
    c.level.value = 'preferred'
    c.register('n-plain', 'unisolated')
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const id = await c.create()
      expect(await c.acquire('n-plain')).toBe(id)
      ids.push(id)
    }
    const items = unisolatedItems(c.ledger)
    expect(items).toHaveLength(1)
    expect(items[0]?.body).toContain(`最近一个任务：${ids[0]}`)
    // 每个任务上仍有“未隔离”标记。
    for (const id of ids) {
      const [s] = started(c.ledger, id)
      expect(s?.type === 'task.started' && s.payload.unisolated).toContain('未隔离')
    }
  })

  test('M1：原因变化时重新提示；恢复隔离后再次未隔离也重新提示', async () => {
    const c = await setup()
    c.level.value = 'preferred'
    c.register('n1', 'unisolated')
    await c.create()
    await c.acquire('n1')
    expect(unisolatedItems(c.ledger)).toHaveLength(1)
    // 原因变化：施加层 none → 开关关闭。
    c.register('n1', 'switch_off')
    const b = await c.create()
    expect(await c.acquire('n1')).toBe(b)
    expect(unisolatedItems(c.ledger)).toHaveLength(2)
    const latest = unisolatedItems(c.ledger).find((i) => i.body.includes(b))
    expect(latest?.body).toContain('isolation.enforce')
    // 同样原因不再提示。
    await c.create()
    await c.acquire('n1')
    expect(unisolatedItems(c.ledger)).toHaveLength(2)
    // 恢复隔离（重新注册且探针通过）后再次变为同样原因的未隔离：重新提示。
    c.register('n1', 'isolated')
    const d = await c.create()
    expect(await c.acquire('n1')).toBe(d)
    c.register('n1', 'switch_off')
    await c.create()
    await c.acquire('n1')
    expect(unisolatedItems(c.ledger)).toHaveLength(3)
  })

  test('M1：中枢重启后（新的派送服务）同样原因不重复提示', async () => {
    const c = await setup()
    c.level.value = 'preferred'
    c.register('n1', 'unisolated')
    await c.create()
    await c.acquire('n1')
    const again = createNodeProtocol({
      ledger: c.ledger,
      clock: c.clock,
      leaseTtlS: 60,
      leaseWaitMaxS: 30,
      roleIsolation: {
        lookup: (contract) =>
          roleIsolationTarget(
            {
              name: contract.role,
              executor: 'codex-exec',
              permissions: { sandbox: SETTING },
              isolation: 'preferred',
            },
            contract,
          ),
      },
    })
    cleanups.push(() => again.stop())
    await c.create()
    const r = await again.service.acquire({
      node_id: 'n1',
      capabilities: ['executor:codex-exec'],
      wait_s: 0,
    })
    expect(r.ok && r.data.lease).toBeTruthy()
    expect(unisolatedItems(c.ledger)).toHaveLength(1)
  })

  test('M2：已隔离节点离线时 required 任务卡住，消息注明离线；在线时等待', async () => {
    const c = await setup()
    c.register('n-iso', 'isolated')
    c.register('n-plain', 'unisolated')
    const a = await c.create()
    expect(await c.acquire('n-plain')).toBeNull()
    expect(c.ledger.getTask(a)?.status).toBe('queued')
    // n-iso 之后没有任何活动；n-plain 继续领取。
    c.clock.time += 10 * 60_000
    expect(await c.acquire('n-plain')).toBeNull()
    const task = c.ledger.getTask(a)
    expect(task?.status).toBe('blocked')
    expect(task?.blocked?.message).toContain('已隔离节点 n-iso 最近活动于')
    expect(task?.blocked?.message).toContain('当前离线')
  })

  test('M3：缓存过期 + 长轮询等待中的旧节点：新改为 required 的角色不被派给它', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raindown-role-iso-m3-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const rolesDir = join(home, 'config/roles')
    mkdirSync(rolesDir, { recursive: true })
    const writeRole = (isolation: string) =>
      writeFileSync(
        join(rolesDir, 'developer.yaml'),
        `name: developer\nexecutor: codex-exec\nprompt: 测试\npermissions:\n  sandbox: ${SETTING}\nisolation: ${isolation}\n`,
      )
    writeRole('off')
    let now = NOW
    const source = roleIsolationFromHome(home, { now: () => now, ttlMs: 1000 })
    const c = await setup({ roleIsolation: source })
    c.register('n-old', 'legacy')
    // 旧节点开始长轮询（此时缓存里角色为 off）。
    const pending = c.protocol.service.acquire({
      node_id: 'n-old',
      capabilities: ['executor:codex-exec'],
      wait_s: 30,
    })
    for (let i = 0; i < 20 && c.protocol.service.waiting() === 0; i++)
      await new Promise((r) => setTimeout(r, 1))
    expect(c.protocol.service.waiting()).toBe(1)
    writeRole('required')
    now += 5000
    const id = await c.create()
    for (let i = 0; i < 100 && c.ledger.getTask(id)?.status === 'queued'; i++)
      await new Promise((r) => setTimeout(r, 2))
    expect(c.ledger.getTask(id)?.status).toBe('blocked')
    expect(started(c.ledger, id)).toEqual([])
    await c.clock.advance(30_000)
    const r = await pending
    expect(r.ok && r.data.lease).toBeNull()
  })

  test('M3：角色不在缓存中时强制刷新；仍找不到则不派送（fail closed）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raindown-role-iso-m3b-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const rolesDir = join(home, 'config/roles')
    mkdirSync(rolesDir, { recursive: true })
    const source = roleIsolationFromHome(home, { now: () => NOW, ttlMs: 60_000 })
    const c = await setup({ roleIsolation: source })
    c.register('n-iso', 'isolated')
    const id = await c.create()
    // 角色未定义：不派送，留在队列。
    expect(await c.acquire('n-iso')).toBeNull()
    expect(c.ledger.getTask(id)?.status).toBe('queued')
    // 缓存仍在有效期内时新写入角色：强制刷新后即可派送。
    writeFileSync(
      join(rolesDir, 'developer.yaml'),
      `name: developer\nexecutor: codex-exec\nprompt: 测试\npermissions:\n  sandbox: ${SETTING}\nisolation: required\n`,
    )
    expect(await c.acquire('n-iso')).toBe(id)
  })
})

describe('roleIsolationFromHome', () => {
  test('按 raindown-home 的角色配置判定，领取前按 TTL 刷新', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raindown-role-iso-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const rolesDir = join(home, 'config/roles')
    mkdirSync(rolesDir, { recursive: true })
    const writeRole = (isolation: string) =>
      writeFileSync(
        join(rolesDir, 'developer.yaml'),
        `name: developer\nexecutor: codex-exec\nprompt: 测试\npermissions:\n  sandbox: ${SETTING}\nisolation: ${isolation}\n`,
      )
    writeRole('required')
    let now = NOW
    const source = roleIsolationFromHome(home, { now: () => now, ttlMs: 1000 })
    const c = await setup({ roleIsolation: source })
    c.register('n-plain', 'unisolated')
    const a = await c.create()
    expect(await c.acquire('n-plain')).toBeNull()
    expect(c.ledger.getTask(a)?.status).toBe('blocked')

    writeRole('off')
    now += 2000
    const b = await c.create()
    expect(await c.acquire('n-plain')).toBe(b)
    const contract = (role: string) => ({ ...contractInput({ role, executor: 'codex-exec' }) })
    expect(source.lookup(contract('developer') as never)?.requirement).toBe('off')
    expect(source.lookup(contract('missing') as never)).toBeUndefined()
  })
})

describe('runHub 端到端', () => {
  test('required 角色在未隔离节点上：任务卡住并生成收件箱条目，重试后仍不可满足则再次卡住', async () => {
    const root = mkdtempSync(join(tmpdir(), 'raindown-role-iso-hub-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const home = join(root, 'home')
    const init = await initRaindownHome(home)
    if (!init.ok) throw new Error(init.error.message)
    mkdirSync(join(home, 'config', 'workspaces'), { recursive: true })
    writeFileSync(
      join(home, 'config', 'workspaces', 'demo.yaml'),
      'id: demo\nkind: product\nname: Demo\ndescription: 测试\nrepos: []\n',
    )
    writeFileSync(
      join(home, 'config', 'roles', 'iso.yaml'),
      'name: iso\nexecutor: fake\nprompt: 测试\nisolation: required\n',
    )
    const quiet = { info() {}, warn() {}, error() {} }
    const started = await runHub({
      home,
      port: 0,
      logger: quiet as never,
      secrets: { watch: false },
      inbox: { watch: false, channels: [] },
    })
    if (!started.ok) throw new Error(started.error.message)
    const hub = started.data
    try {
      writeFileSync(raindownPaths(home).hubConfig, `port: ${hub.port}\n`)
      const token = readFileSync(raindownPaths(home).hubToken, 'utf8').trim()
      const client = new HubClient({ home, actor: 'user', token })
      const must = <T>(r: Result<T>): T => {
        if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
        return r.data
      }
      must(
        await client.request('nodes-register', {
          node_id: 'n-plain',
          hostname: 'h',
          version: '0',
          capabilities: ['executor:fake'],
        }),
      )
      const { task } = must(
        await client.createTask({
          goal: '隔离',
          workspace: 'ws/demo',
          role: 'iso',
          executor: 'fake',
        }),
      )
      const acquire = () =>
        client.request('leases-acquire', {
          node_id: 'n-plain',
          capabilities: ['executor:fake'],
          wait_s: 0,
        })
      expect(must(await acquire()).lease).toBeNull()
      const shown = must(await client.showTask(task.id)).task
      expect(shown.status).toBe('blocked')
      expect(shown.blocked?.message.startsWith(`${ISOLATION_UNAVAILABLE}：`)).toBe(true)
      // 节点没有上报执行器信息（旧节点）：按 none 处理。
      expect(shown.blocked?.message).toContain('未上报凭证隔离能力')
      let items: Array<{ source: string; reason: string | null; source_ref: string }> = []
      for (let i = 0; i < 100; i++) {
        items = must(await client.listInbox()).items
        if (items.some((x) => x.source === 'task')) break
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'task', reason: 'other', source_ref: task.id }),
        ]),
      )
      must(await client.retryTask(task.id))
      expect(must(await acquire()).lease).toBeNull()
      expect(must(await client.showTask(task.id)).task.status).toBe('blocked')
    } finally {
      await hub.stop()
    }
  })
})
