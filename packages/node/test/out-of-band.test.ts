import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_ADAPTER_CAPABILITIES, ok, type Result } from '@raindown/core'
import {
  ActivityQueue,
  type ExecutorOutcome,
  type ExecutorPlugin,
  idleSignal,
  resumedSignal,
} from '../src/executor.ts'
import { mdsBaselinePath, recordMdsBaseline } from '../src/mds.ts'
import { type Bench, bench } from './harness.ts'

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

test('带外信号经节点续约上报，临时失败重试且中枢只记一次', async () => {
  const activity = new ActivityQueue()
  let finish: (result: Result<ExecutorOutcome>) => void = () => {}
  const done = new Promise<Result<ExecutorOutcome>>((resolve) => {
    finish = resolve
  })
  const executor: ExecutorPlugin = {
    type: 'probe',
    adapterCapabilities: NO_ADAPTER_CAPABILITIES,
    classify: () => ({ reason: 'awaiting_approval', message: '等待授权：gh pr create' }),
    run: () => ({
      activity,
      done,
      async cancel() {
        activity.close()
        finish(ok({ outcome: 'cancelled' }))
      },
    }),
  }
  let failures = 0
  const b = await bench({ executors: [executor] }, 60, (url, init) => {
    if (
      url.endsWith('/renew') &&
      String(init?.body).includes('"out_of_band"') &&
      failures++ === 0
    ) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { kind: 'retryable', code: 'hub_busy', message: '稍后重试' },
        }),
        { status: 503 },
      )
    }
    return undefined
  })
  current = b
  const id = await b.create({ executor: 'probe' })
  activity.push(idleSignal(new Date(b.clock.now()).toISOString(), '等待授权'))
  await b.until(id, (task) => task.status === 'blocked')
  activity.push({
    ts: new Date(b.clock.now()).toISOString(),
    kind: 'status',
    data: {
      out_of_band: { id: 'outside-1', kind: 'approval_outside_raindown', command: 'gh pr create' },
    },
  })
  activity.push(resumedSignal(new Date(b.clock.now()).toISOString(), '外部批准后继续'))
  await b.until(id, (task) => task.status === 'running')
  await b.clock.advance(60_000)
  expect(failures).toBeGreaterThanOrEqual(2)
  expect(b.events(id).filter((event) => event.type === 'task.out_of_band')).toMatchObject([
    { payload: { id: 'outside-1', kind: 'approval_outside_raindown', command: 'gh pr create' } },
  ])
  expect(b.types(id).filter((type) => type === 'task.unblocked')).toHaveLength(1)
})

test('mds（worker-credential-isolation 4.5）：harness 结束后节点按基线重置被改动的条目，经带外信号写任务事件', async () => {
  // 注入的假 DARWIN_USER_CACHE_DIR（<tmp>/C/mds），绝不碰真实的 /private/var/folders/*/C/mds。
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raindown-node-mds-')))
  const mds = join(root, 'C', 'mds')
  await mkdir(mds, { recursive: true })
  await writeFile(join(mds, 'mds.lock'), '')
  await writeFile(join(mds, 'mdsDirectory.db'), 'v1')
  let home = ''
  const executor: ExecutorPlugin = {
    type: 'probe',
    adapterCapabilities: NO_ADAPTER_CAPABILITIES,
    classify: () => ({ reason: 'other', message: '' }),
    run: (_contract, ctx) => {
      const activity = new ActivityQueue()
      // 模拟：施加外层 seatbelt 时启动前记录基线，worker 在运行期间改动 mds 后崩溃退出。
      const done = (async (): Promise<Result<ExecutorOutcome>> => {
        await recordMdsBaseline(home, ctx.taskId, mds)
        await writeFile(join(mds, 'mdsDirectory.db'), 'tampered')
        await writeFile(join(mds, 'planted.db'), 'x')
        activity.close()
        return ok({ outcome: 'exited', exit_code: 1 })
      })()
      return { activity, done, cancel: async () => {} }
    },
  }
  try {
    const b = await bench({ executors: [executor] })
    current = b
    home = b.home
    const id = await b.create({ executor: 'probe' })
    await b.until(id, (task) => task.status === 'blocked')
    const events = b.events(id).filter((event) => event.type === 'task.out_of_band')
    expect(events).toHaveLength(1)
    const payload = events[0]?.payload as { kind?: string; files?: string[] }
    expect(payload.kind).toBe('mds_reset')
    expect([...(payload.files ?? [])].sort()).toEqual(['mdsDirectory.db', 'planted.db'])
    expect((await readdir(mds)).sort()).toEqual(['mds.lock'])
    expect(existsSync(mdsBaselinePath(b.home, id))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
