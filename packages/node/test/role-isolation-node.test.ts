import { afterEach, describe, expect, test } from 'bun:test'
import {
  fail,
  ISOLATION_UNAVAILABLE,
  type IsolationProbeReport,
  ok,
  PROBE_REQUIRED_DENY_ITEMS,
  type Role,
  type RoleIsolation,
} from '@raindown/core'
import type { ExecutorPlugin } from '../src/executor.ts'
import { createFakeExecutor } from '../src/fake.ts'
import type { StartNodeOptions } from '../src/node.ts'
import { type Bench, bench } from './harness.ts'

/**
 * 节点侧兜底（add-worker-credential-isolation 6.1）：角色 `isolation: required` 时，节点在启动 harness 前
 * 按本地的能力声明与最近一次探针再确认一次；不满足时不启动 harness，以 `blocked(other)` `isolation_unavailable` 结束。
 * 测试台的中枢不检查角色隔离要求（只测节点本身）。
 */

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

const SETTING = 'danger-full-access'
const START = Date.parse('2026-10-25T08:00:00.000Z')

const probe = (passed: boolean): IsolationProbeReport => ({
  ran_at: new Date(START).toISOString(),
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
})

/** 以 codex-exec 名义注册的 fake 执行器；记录 run 次数。 */
function executor(declared: 'enforced' | 'declared_only' | 'legacy') {
  const base = createFakeExecutor()
  const runs = { count: 0, expected: [] as unknown[] }
  const { credential_isolation: _drop, ...caps } = base.adapterCapabilities
  const e: ExecutorPlugin = {
    ...base,
    type: 'codex-exec',
    adapterCapabilities:
      declared === 'legacy'
        ? caps
        : {
            ...caps,
            credential_isolation: {
              layers: { [SETTING]: 'seatbelt' },
              enforced: declared === 'enforced',
            },
          },
    run(contract, ctx) {
      runs.count++
      runs.expected.push(ctx.isolationExpected)
      return base.run(contract, ctx)
    },
  }
  return { e, runs }
}

const role = (isolation: RoleIsolation): Role => ({
  name: 'dev',
  executor: 'codex-exec',
  prompt: '测试',
  permissions: { sandbox: SETTING },
  isolation,
})

async function start(o: {
  isolation: RoleIsolation
  declared?: 'enforced' | 'declared_only' | 'legacy'
  probe?: IsolationProbeReport | null
  platform?: NodeJS.Platform
  loadRole?: StartNodeOptions['loadRole']
}) {
  const { e, runs } = executor(o.declared ?? 'enforced')
  const report = o.probe
  current = await bench({
    executors: [e],
    platform: o.platform ?? 'darwin',
    loadRole: o.loadRole ?? (async (name) => ok(name === 'dev' ? role(o.isolation) : null)),
    ...(report
      ? {
          isolationProbe: {
            run: async () => report,
            macosVersion: async () => '15.1',
          },
        }
      : {}),
  })
  const b = current
  // 等首次注册（启动探针之后）完成。
  for (let i = 0; i < 200 && b.ledger.getNode('n-bench') === null; i++) {
    await b.clock.advance(0)
    await new Promise((r) => setTimeout(r, 1))
  }
  const id = await b.create({ executor: 'codex-exec' })
  return { b, id, runs }
}

describe('节点启动 harness 前确认隔离（required）', () => {
  test('PR #104 审查第二轮 M1：判定已隔离时把 (设置, 施加层, 联网) 交给执行器核对；preferred 不给', async () => {
    const req = await start({ isolation: 'required', probe: probe(true) })
    await req.b.until(req.id, (t) => t.status !== 'queued' && t.status !== 'running')
    expect(req.runs.count).toBe(1)
    expect(req.runs.expected).toEqual([{ setting: SETTING, layer: 'seatbelt', network: false }])
    await req.b.close()
    current = undefined
    const pref = await start({ isolation: 'preferred', probe: probe(true) })
    await pref.b.until(pref.id, (t) => t.status !== 'queued' && t.status !== 'running')
    expect(pref.runs.expected).toEqual([undefined])
  })

  test('探针失败：不启动 harness，blocked(other) isolation_unavailable 并列出失败项', async () => {
    const { b, id, runs } = await start({ isolation: 'required', probe: probe(false) })
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.reason).toBe('other')
    expect(t.blocked?.message.startsWith(`${ISOLATION_UNAVAILABLE}：`)).toBe(true)
    expect(t.blocked?.message).toContain('read.hub_token')
    expect(t.blocked?.message).toContain('n-bench')
    expect(t.blocked?.no_delegate).toBe(true)
    expect(runs.count).toBe(0)
  })

  test('没有探针结果（未探测）：不启动 harness', async () => {
    const { b, id, runs } = await start({ isolation: 'required', probe: null })
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.message).toContain('未探测')
    expect(runs.count).toBe(0)
  })

  test('开关关闭（适配器只声明未施加）：消息写明开关；非 macOS 写明平台不支持', async () => {
    const off = await start({ isolation: 'required', declared: 'declared_only', probe: null })
    const t = await off.b.until(off.id, (t) => t.status === 'blocked')
    expect(t.blocked?.message).toContain('isolation.enforce')
    expect(off.runs.count).toBe(0)
    await current?.close()
    current = undefined

    const linux = await start({
      isolation: 'required',
      declared: 'declared_only',
      probe: null,
      platform: 'linux',
    })
    const u = await linux.b.until(linux.id, (t) => t.status === 'blocked')
    expect(u.blocked?.message).toContain('平台 linux 不支持隔离')
  })

  test('执行器未上报 credential_isolation（旧适配器）按 none：不启动 harness', async () => {
    const { b, id, runs } = await start({ isolation: 'required', declared: 'legacy', probe: null })
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.message).toContain('未上报凭证隔离能力')
    expect(runs.count).toBe(0)
  })

  test('已施加且探针通过：照常启动 harness', async () => {
    const { b, id, runs } = await start({ isolation: 'required', probe: probe(true) })
    await b.until(id, (t) => t.status === 'done')
    expect(runs.count).toBe(1)
  })
})

describe('preferred 与 off 不在节点拦截', () => {
  for (const isolation of ['preferred', 'off'] as const) {
    test(`${isolation}：未隔离也启动 harness`, async () => {
      const { b, id, runs } = await start({ isolation, probe: probe(false) })
      await b.until(id, (t) => t.status === 'done')
      expect(runs.count).toBe(1)
    })
  }
})

describe('审查修复（第一轮）', () => {
  test('L1：找不到角色时 fail closed：不启动 harness，blocked(other) isolation_unavailable，不委托', async () => {
    const { b, id, runs } = await start({
      isolation: 'off',
      probe: probe(true),
      loadRole: async () => ok(null),
    })
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.reason).toBe('other')
    expect(t.blocked?.message.startsWith(`${ISOLATION_UNAVAILABLE}：`)).toBe(true)
    expect(t.blocked?.message).toContain('没有合法的角色 dev')
    expect(t.blocked?.no_delegate).toBe(true)
    expect(runs.count).toBe(0)
  })

  test('L1：读取角色配置失败时 fail closed', async () => {
    const { b, id, runs } = await start({
      isolation: 'off',
      probe: probe(true),
      loadRole: async () => fail('failure', 'read_failed', '无法读取'),
    })
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.message).toContain('无法读取角色配置')
    expect(runs.count).toBe(0)
  })

  test('L4：节点侧 isolation_unavailable 卡住带 no_delegate', async () => {
    const { b, id } = await start({ isolation: 'required', probe: probe(false) })
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.no_delegate).toBe(true)
    const blocked = b.events(id).find((e) => e.type === 'task.blocked')
    expect(blocked?.type === 'task.blocked' && blocked.payload.no_delegate).toBe(true)
  })
})
