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
import {
  hasPendingMdsNotices,
  mdsBaselinePath,
  queueMdsNotice,
  recordMdsBaseline,
} from '../src/mds.ts'
import { type Bench, bench } from './harness.ts'
import { waitFor } from './wait.ts'

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

test('mds（worker-credential-isolation 4.5）：harness 结束后节点按基线重置被改动的条目，经隔离事实接口写任务事件（不依赖租约）', async () => {
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
    await waitFor(
      () => b.events(id).some((event) => event.type === 'task.out_of_band'),
      'mds 重置通知送达',
    )
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

test('mds 重置通知在租约结束之后仍送达（审查第一轮）：已完成任务的待送达通知随下一次执行结束送达', async () => {
  const b = await bench()
  current = b
  const first = await b.create()
  await b.until(first, (task) => task.status === 'done')
  // 模拟：上一次执行的租约已结束（或被放弃）后才记下的通知。
  await queueMdsNotice(b.home, first, ['mdsDirectory.db'])
  expect(hasPendingMdsNotices(b.home)).toBe(true)
  const second = await b.create()
  await b.until(second, (task) => task.status === 'done')
  // 后台送达（审查第二轮：不拖延执行结束）。
  await waitFor(
    () => b.events(first).some((event) => event.type === 'task.out_of_band'),
    'mds 重置通知送达',
  )
  const events = b.events(first).filter((event) => event.type === 'task.out_of_band')
  expect(events).toHaveLength(1)
  expect(events[0]?.payload).toMatchObject({ kind: 'mds_reset', files: ['mdsDirectory.db'] })
  expect(b.events(second).filter((event) => event.type === 'task.out_of_band')).toHaveLength(0)
  await waitFor(() => !hasPendingMdsNotices(b.home), '送达后删除通知')
})

test('中枢暂时不可达（审查第二轮）：执行照常结束，通知保留到下一次送达', async () => {
  let notices = 0
  const b = await bench({}, 60, (url) => {
    if (!url.includes('/isolation-notices')) return undefined
    notices++
    return new Response(
      JSON.stringify({
        ok: false,
        error: { kind: 'retryable', code: 'hub_unavailable', message: '稍后重试' },
      }),
      { status: 503 },
    )
  })
  current = b
  const first = await b.create()
  await b.until(first, (task) => task.status === 'done')
  await queueMdsNotice(b.home, first, ['mdsDirectory.db'])
  const second = await b.create()
  await b.until(second, (task) => task.status === 'done')
  await waitFor(() => notices > 0, '尝试送达')
  expect(hasPendingMdsNotices(b.home)).toBe(true)
  expect(b.events(first).filter((event) => event.type === 'task.out_of_band')).toHaveLength(0)
})

test('审查第三轮：待送达的通知定期重试，节点空闲时中枢恢复后也能送达', async () => {
  let down = true
  const b = await bench({ mdsNoticeRetryMs: 60_000, isolationActive: true }, 60, (url) => {
    if (!url.includes('/isolation-notices') || !down) return undefined
    return new Response(
      JSON.stringify({
        ok: false,
        error: { kind: 'retryable', code: 'hub_unavailable', message: '稍后重试' },
      }),
      { status: 503 },
    )
  })
  current = b
  const first = await b.create()
  await b.until(first, (task) => task.status === 'done')
  await queueMdsNotice(b.home, first, ['mdsDirectory.db'])
  // 中枢恢复，之后不再有任务：只靠定期重试送达。
  down = false
  for (let i = 0; i < 5 && hasPendingMdsNotices(b.home); i++) {
    await b.clock.advance(60_000)
    await new Promise((r) => setTimeout(r, 20))
  }
  await waitFor(
    () => b.events(first).some((event) => event.type === 'task.out_of_band'),
    '定期重试送达',
  )
  await waitFor(() => !hasPendingMdsNotices(b.home), '送达后删除通知')
})

test('审查第四轮：外层 seatbelt 未生效、启动时没有待送达通知时不启动定期重试', async () => {
  let sent = 0
  const b = await bench({ mdsNoticeRetryMs: 60_000 }, 60, (url) => {
    if (url.includes('/isolation-notices')) sent++
    return undefined
  })
  current = b
  const first = await b.create()
  await b.until(first, (task) => task.status === 'done')
  await queueMdsNotice(b.home, first, ['mdsDirectory.db'])
  for (let i = 0; i < 3; i++) await b.clock.advance(60_000)
  await new Promise((r) => setTimeout(r, 50))
  expect(sent).toBe(0)
  expect(hasPendingMdsNotices(b.home)).toBe(true)
})
