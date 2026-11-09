import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Activity,
  LEDGER_ID_RE,
  raindownPaths,
  registerNodeRequest,
  taskContract,
} from '@raindown/core'
import {
  createExecutorRegistry,
  createFakeExecutor,
  createNodeHubClient,
  generateNodeId,
  loadOrCreateNodeId,
  type NodeClock,
} from '../src/index.ts'

/** 手动推进的时钟。 */
function manualClock() {
  let time = 0
  const timers: Array<{ at: number; cb: () => void; live: boolean }> = []
  const clock: NodeClock = {
    now: () => time,
    setTimeout(cb, ms) {
      const t = { at: time + ms, cb, live: true }
      timers.push(t)
      return () => {
        t.live = false
      }
    },
  }
  return {
    clock,
    async advance(ms: number) {
      const target = time + ms
      for (;;) {
        const next = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        time = next.at
        next.live = false
        next.cb()
        await Promise.resolve()
      }
      time = target
    },
  }
}

const ctx = (signal = new AbortController().signal) => ({
  taskId: 't1',
  attempt: 1,
  cwd: '/tmp',
  nodeId: 'n1',
  signal,
})

const contract = (fake: Record<string, unknown>) =>
  taskContract.parse({
    goal: 'g',
    workspace: 'ws/demo',
    role: 'dev',
    executor: 'fake',
    inputs: { fake },
  })

async function collect(it: AsyncIterable<Activity>) {
  const out: string[] = []
  for await (const a of it) out.push(a.text ?? '')
  return out
}

describe('fake 执行器', () => {
  test('按 delay_ms 均匀上报活动后结束', async () => {
    const m = manualClock()
    const run = createFakeExecutor({ clock: m.clock }).run(
      contract({ outcome: 'done', delay_ms: 300, activity: ['a', 'b'] }),
      ctx(),
    )
    const activity = collect(run.activity)
    let settled = false
    void run.done.then(() => {
      settled = true
    })
    await m.advance(299)
    expect(settled).toBe(false)
    await m.advance(1)
    const r = await run.done
    expect(r.ok && r.data).toMatchObject({
      outcome: 'done',
      result: { node_id: 'n1', executor: 'fake' },
    })
    expect(await activity).toEqual(['a', 'b'])
  })

  test('blocked 附带原因、说明与 tail', async () => {
    const m = manualClock()
    const run = createFakeExecutor({ clock: m.clock }).run(
      contract({ outcome: 'blocked', blocked_reason: 'question', message: '?', activity: ['x'] }),
      ctx(),
    )
    await m.advance(0)
    expect((await run.done).ok && (await run.done)).toMatchObject({
      data: { outcome: 'blocked', reason: 'question', message: '?', tail: ['x'] },
    })
  })

  test('cancel 与 signal 都能结束长任务', async () => {
    const m = manualClock()
    const fake = createFakeExecutor({ clock: m.clock })
    const a = fake.run(contract({ delay_ms: 3_600_000 }), ctx())
    await a.cancel()
    expect((await a.done).ok && (await a.done)).toMatchObject({ data: { outcome: 'cancelled' } })
    const ac = new AbortController()
    const b = fake.run(contract({ delay_ms: 3_600_000 }), ctx(ac.signal))
    ac.abort()
    expect((await b.done).ok && (await b.done)).toMatchObject({ data: { outcome: 'cancelled' } })
    expect(await collect(b.activity)).toEqual([])
  })
})

describe('执行器注册表', () => {
  test('贡献 executor:<type> 能力；重复注册报错', () => {
    const reg = createExecutorRegistry([createFakeExecutor()])
    expect(reg.capabilities()).toEqual(['executor:fake'])
    expect(reg.info()).toEqual([
      {
        type: 'fake',
        mode: 'headless',
        task_inputs: true,
        adapter_capabilities: {
          approval_requests: 'structured',
          inject_while_running: true,
          resume_session: true,
          raindown_mcp: false,
          out_of_band_detection: false,
          credential_isolation: { layers: {}, enforced: false },
        },
      },
    ])
    const wire = JSON.parse(
      JSON.stringify({
        node_id: 'n-test',
        hostname: 'test',
        version: 'test',
        capabilities: reg.capabilities(),
        executors: reg.info(),
        concurrency: 1,
      }),
    )
    expect(registerNodeRequest.parse(wire).executors).toEqual(reg.info())
    expect(() => createExecutorRegistry([createFakeExecutor(), createFakeExecutor()])).toThrow()
  })
})

describe('节点 id', () => {
  test('由主机名派生且符合 id 格式；首次生成后持久化', async () => {
    expect(generateNodeId('Hxlee-MacBook.local', () => 'abc123')).toBe('n-hxlee-macbook-abc123')
    expect(generateNodeId('!!!', () => '000000')).toBe('n-node-000000')
    const home = join(mkdtempSync(join(tmpdir(), 'raindown-node-id-')), 'home')
    const first = await loadOrCreateNodeId(home, 'host')
    const second = await loadOrCreateNodeId(home, 'other')
    expect(first.ok && LEDGER_ID_RE.test(first.data)).toBe(true)
    expect(second).toEqual(first)
    expect(readFileSync(raindownPaths(home).nodeId, 'utf8').trim()).toBe(first.ok ? first.data : '')
  })
})

describe('节点 HTTP 客户端', () => {
  const token = 't'.repeat(43)

  test('连接失败返回可重试的 hub_unavailable', async () => {
    const client = createNodeHubClient({
      url: 'http://127.0.0.1:1',
      token,
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    })
    const r = await client.listNodes()
    expect(!r.ok && r.error).toMatchObject({ kind: 'retryable', code: 'hub_unavailable' })
  })

  test('中枢的错误响应原样转为错误码', async () => {
    const client = createNodeHubClient({
      url: 'http://hub',
      token,
      fetch: async () =>
        Response.json(
          {
            ok: false,
            error: { kind: 'failure', code: 'lease_expired', message: 'x', retryable: false },
          },
          { status: 409 },
        ),
    })
    const r = await client.renew('l-1', { lease_token: token })
    expect(!r.ok && r.error.code).toBe('lease_expired')
  })
})
