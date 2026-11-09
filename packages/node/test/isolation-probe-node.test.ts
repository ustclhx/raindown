import { afterEach, expect, test } from 'bun:test'
import type { IsolationProbeReport } from '@raindown/core'
import { createFakeExecutor } from '../src/fake.ts'
import type { IsolationProbeOptions } from '../src/isolation-probe/run.ts'
import { type Bench, bench, type Intercept } from './harness.ts'

/**
 * 节点运行隔离探针并随注册上报（worker-credential-isolation 3.1–3.2）。探针实现由测试注入，
 * 不触碰真实用户目录、不连接 Orca。
 */

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

const report = (n: number, macos = '15.1'): IsolationProbeReport => ({
  ran_at: new Date(Date.UTC(2026, 10, 9, n)).toISOString(),
  macos_version: macos,
  runs: [
    {
      executor: 'codex-exec',
      setting: 'danger-full-access',
      declared_layer: 'seatbelt',
      applied_layer: 'none',
      passed: false,
      items: [
        {
          item: 'read.hub_token',
          target: '/h/state/hub.token',
          expected: 'deny',
          actual: 'allow',
          ok: false,
        },
      ],
    },
  ],
})

async function settle(b: Bench, pred: () => boolean) {
  for (let i = 0; i < 200 && !pred(); i++) {
    await b.clock.advance(0)
    await new Promise((r) => setTimeout(r, 1))
  }
  expect(pred()).toBe(true)
}

test('启动时先运行探针，首次注册即带上结果；每隔一段时间重新运行并重新注册', async () => {
  const calls: IsolationProbeOptions[] = []
  const run = async (o: IsolationProbeOptions) => {
    calls.push(o)
    return report(calls.length)
  }
  current = await bench({
    isolationProbe: {
      run,
      intervalMs: 10_000,
      versionCheckMs: 10_000,
      macosVersion: async () => '15.1',
    },
  })
  const b = current
  await settle(b, () => b.ledger.getNode('n-bench')?.isolation_probe != null)
  expect(b.ledger.getNode('n-bench')?.isolation_probe).toEqual(report(1))
  expect(calls[0]?.home).toBe(b.home)
  expect(calls[0]?.hubUrl).toBe('http://hub.test')
  await b.clock.advance(10_000)
  await settle(b, () => b.ledger.getNode('n-bench')?.isolation_probe?.ran_at === report(2).ran_at)
  expect(calls.length).toBe(2)
})

test('macOS 版本变化时重新运行探针', async () => {
  let version = '15.1'
  let n = 0
  current = await bench({
    isolationProbe: {
      run: async () => report(++n, version),
      intervalMs: 6 * 3600_000,
      versionCheckMs: 1_000,
      macosVersion: async () => version,
    },
  })
  const b = current
  await settle(b, () => b.ledger.getNode('n-bench')?.isolation_probe != null)
  await b.clock.advance(1_000)
  await settle(b, () => true)
  expect(n).toBe(1)
  version = '15.2'
  await b.clock.advance(1_000)
  await settle(b, () => b.ledger.getNode('n-bench')?.isolation_probe?.macos_version === '15.2')
  expect(n).toBe(2)
})

test('旧中枢不认识 isolation_probe：告警一次后不再上报该字段，注册照常成功', async () => {
  const warns: string[] = []
  let rejected = 0
  const rejectProbe: Intercept = (url, init) => {
    if (!url.endsWith('/v1/nodes') || !String(init?.body ?? '').includes('"isolation_probe"'))
      return
    rejected++
    return Response.json(
      {
        ok: false,
        error: {
          kind: 'usage',
          code: 'invalid_arguments',
          message: '节点注册请求不合法：Unrecognized key: "isolation_probe"',
          retryable: false,
          details: [{ code: 'invalid_field', message: 'Unrecognized key: "isolation_probe"' }],
        },
      },
      { status: 400 },
    )
  }
  current = await bench(
    {
      logger: { info() {}, warn: (m: string) => void warns.push(m) },
      isolationProbe: { run: async () => report(1), macosVersion: async () => '15.1' },
    },
    60,
    rejectProbe,
  )
  const b = current
  await settle(b, () => b.ledger.getNode('n-bench') !== null)
  expect(rejected).toBe(1)
  expect(b.ledger.getNode('n-bench')?.isolation_probe).toBeNull()
  expect(warns.filter((w) => w.includes('isolation_probe')).length).toBe(1)
})

test('未开启探针时不运行（缺省），注册不带结果', async () => {
  current = await bench({})
  const b = current
  await settle(b, () => b.ledger.getNode('n-bench') !== null)
  expect(b.ledger.getNode('n-bench')?.isolation_probe).toBeNull()
})

test('审查修复 L3：探针运行抛错时改为上报带错误的不通过结果，不再沿用之前的结果', async () => {
  const base = createFakeExecutor()
  const fake = {
    ...base,
    adapterCapabilities: {
      ...base.adapterCapabilities,
      credential_isolation: { layers: { 'danger-full-access': 'seatbelt' }, enforced: true },
    },
  }
  let n = 0
  current = await bench({
    executors: [fake],
    isolationProbe: {
      run: async () => {
        n++
        if (n === 1) return report(1)
        throw new Error('子进程无法启动')
      },
      intervalMs: 10_000,
      versionCheckMs: 10_000,
      macosVersion: async () => '15.1',
    },
  })
  const b = current
  await settle(b, () => b.ledger.getNode('n-bench')?.isolation_probe != null)
  await b.clock.advance(10_000)
  await settle(b, () => b.ledger.getNode('n-bench')?.isolation_probe?.runs[0]?.error !== undefined)
  const probe = b.ledger.getNode('n-bench')?.isolation_probe
  expect(probe?.runs).toEqual([
    expect.objectContaining({
      executor: 'fake',
      setting: 'danger-full-access',
      passed: false,
      items: [],
      error: expect.objectContaining({ code: 'probe_failed' }),
    }),
  ])
  expect(probe?.macos_version).toBe('15.1')
})

test('审查修复 L2：stop() 等待进行中的探针结束', async () => {
  let release = () => {}
  let finished = false
  current = await bench({
    isolationProbe: {
      run: () =>
        new Promise<IsolationProbeReport>((resolve) => {
          release = () => {
            finished = true
            resolve(report(1))
          }
        }),
      macosVersion: async () => '15.1',
    },
  })
  const b = current
  let stopped = false
  const stopping = b.node.stop().then(() => {
    stopped = true
  })
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1))
  expect(stopped).toBe(false)
  release()
  await stopping
  expect(finished).toBe(true)
  expect(stopped).toBe(true)
})
