import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { taskRunDir } from '@raindown/core'
import {
  cleanLeaseTokenFiles,
  leaseTokenDir,
  removeEmptyTaskRunDir,
  removeLeaseTokenFile,
  writeLeaseTokenFile,
} from '../src/lease-token.ts'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
const tempHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'raindown-dispatch-token-'))
  homes.push(home)
  return home
}

test('派工凭证文件 0600、目录 0700；旧派工清理不会删除新租约文件', async () => {
  const home = await tempHome()
  const first = await writeLeaseTokenFile(home, 't-1', 'l-1', 'first')
  const next = await writeLeaseTokenFile(home, 't-1', 'l-2', 'next')
  expect((await stat(first)).mode & 0o777).toBe(0o600)
  expect((await stat(leaseTokenDir(home, 't-1'))).mode & 0o777).toBe(0o700)
  await removeLeaseTokenFile(first)
  expect(existsSync(first)).toBe(false)
  expect((await readFile(next, 'utf8')).trim()).toBe('next')
  for (const id of ['../x', '.hidden', 'x/y', '']) {
    await expect(writeLeaseTokenFile(home, id, 'l-1', 'bad')).rejects.toThrow()
    await expect(writeLeaseTokenFile(home, 't-1', id, 'bad')).rejects.toThrow()
  }
})

test('启动只删除受管 token 文件，保留任务产物且不跟随目录符号链接', async () => {
  const home = await tempHome()
  await cleanLeaseTokenFiles(home)
  const token = await writeLeaseTokenFile(home, 't-1', 'l-1', 'token')
  const artifact = join(taskRunDir(home, 't-1'), 'result.json')
  await writeFile(artifact, '{}')
  const unrelated = join(leaseTokenDir(home, 't-1'), 'keep.json')
  await writeFile(unrelated, '{}')
  const outside = join(home, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'l-2.token'), 'keep')
  await symlink(outside, join(home, 'run', 'tasks', 't-link'))
  await mkdir(taskRunDir(home, 't-2'))
  await symlink(outside, leaseTokenDir(home, 't-2'))
  await expect(writeLeaseTokenFile(home, 't-2', 'l-2', 'bad')).rejects.toThrow()
  await cleanLeaseTokenFiles(home)
  expect(existsSync(token)).toBe(false)
  for (const path of [artifact, unrelated, join(outside, 'l-2.token')])
    expect(existsSync(path)).toBe(true)
})

test('派工凭证写在 state/ 之外的 run/tasks/<任务>/；启动时也清理旧位置 state/tasks/ 残留的凭证', async () => {
  const home = await tempHome()
  const token = await writeLeaseTokenFile(home, 't-1', 'l-1', 'token')
  expect(token).toBe(join(home, 'run', 'tasks', 't-1', 'dispatch-tokens', 'l-1.token'))
  for (const dir of [join(home, 'run'), join(home, 'run', 'tasks'), taskRunDir(home, 't-1')])
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  const legacyDir = join(home, 'state', 'tasks', 't-old', 'dispatch-tokens')
  await mkdir(legacyDir, { recursive: true })
  const legacyToken = join(legacyDir, 'l-0.token')
  await writeFile(legacyToken, 'old')
  const legacySpec = join(home, 'state', 'tasks', 't-old', 'spec.md')
  await writeFile(legacySpec, '# 任务说明')
  await cleanLeaseTokenFiles(home)
  expect(existsSync(token)).toBe(false)
  expect(existsSync(legacyToken)).toBe(false)
  expect(existsSync(legacySpec)).toBe(true)
})

test.each(['done', 'abandon'] as const)('节点只传派工凭证文件路径，%s 后删除', async (ending) => {
  const { bench, fake } = await import('./harness.ts')
  const { createFakeExecutor } = await import('../src/fake.ts')
  const inner = createFakeExecutor()
  let path: string | undefined
  let seen: string | undefined
  let forward: ((input: string, init?: RequestInit) => Promise<Response>) | undefined
  let release: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const token = `fls_${'a'.repeat(43)}`
  const b = await bench({
    executors: [
      {
        ...inner,
        run(contract, ctx) {
          path = ctx.leaseTokenFile
          expect(ctx.env?.RAINDOWN_LEASE_TOKEN_FILE).toBeUndefined()
          const run = inner.run(contract, ctx)
          return {
            ...run,
            done: (async () => {
              if (path) seen = (await readFile(path, 'utf8')).trim()
              return run.done
            })(),
          }
        },
      },
    ],
    fetch: async (input, init) => {
      await ready
      if (!forward) throw new Error('测试中枢未就绪')
      const response = await forward(input, init)
      if (!input.endsWith('/v1/leases')) return response
      const body = (await response.json()) as { data?: { lease?: { dispatch_token?: string } } }
      if (body.data?.lease) body.data.lease.dispatch_token = token
      return new Response(JSON.stringify(body), response)
    },
  })
  forward = b.hubFetch
  release()
  try {
    const id = await b.create(fake({ delay_ms: ending === 'done' ? 0 : 60_000 }))
    if (ending === 'done') await b.until(id, (task) => task.status === 'done')
    else {
      await b.until(id, (task) => task.status === 'running' && path !== undefined)
      await b.node.stop()
    }
    expect(path).toBeDefined()
    expect(seen).toBe(token)
    expect(existsSync(path ?? '')).toBe(false)
    // 派工结束后变空的任务私有目录 run/tasks/<任务>/ 一并删除。
    expect(existsSync(dirname(dirname(path ?? '')))).toBe(false)
  } finally {
    await b.close()
  }
})

test('同一租约刷新凭证保留路径和 0600 权限', async () => {
  const home = await tempHome()
  const path = await writeLeaseTokenFile(home, 't-1', 'l-1', 'before')
  expect(await writeLeaseTokenFile(home, 't-1', 'l-1', 'after')).toBe(path)
  expect((await readFile(path, 'utf8')).trim()).toBe('after')
  expect((await stat(path)).mode & 0o777).toBe(0o600)
})

test.each([false, true])('节点凭证写失败仅对 MCP 执行器致命（raindown_mcp=%s）', async (mcp) => {
  const { bench } = await import('./harness.ts')
  const { createFakeExecutor } = await import('../src/fake.ts')
  const inner = createFakeExecutor()
  const warnings: string[] = []
  let started = 0
  let forward: ((input: string, init?: RequestInit) => Promise<Response>) | undefined
  let home = ''
  let ready: () => void = () => {}
  const initialized = new Promise<void>((resolve) => {
    ready = resolve
  })
  const b = await bench({
    executors: [
      {
        ...inner,
        adapterCapabilities: { ...inner.adapterCapabilities, raindown_mcp: mcp },
        run(contract, ctx) {
          started++
          expect(ctx.leaseTokenFile).toBeUndefined()
          return inner.run(contract, ctx)
        },
      },
    ],
    logger: {
      info() {},
      warn(message) {
        warnings.push(message)
      },
    },
    fetch: async (input, init) => {
      await initialized
      if (!forward) throw new Error('测试中枢未就绪')
      const response = await forward(input, init)
      if (!input.endsWith('/v1/leases')) return response
      const body = (await response.json()) as {
        data?: { lease?: { task_id: string; dispatch_token?: string } }
      }
      if (body.data?.lease) {
        const lease = body.data.lease
        await mkdir(taskRunDir(home, lease.task_id), { recursive: true })
        await symlink(home, leaseTokenDir(home, lease.task_id))
        lease.dispatch_token = 'dispatch-secret-never-log'
      }
      return new Response(JSON.stringify(body), response)
    },
  })
  home = b.home
  forward = b.hubFetch
  ready()
  try {
    const id = await b.create()
    const task = await b.until(id, (task) => ['done', 'failed'].includes(task.status))
    expect(task.status).toBe(mcp ? 'failed' : 'done')
    expect(started).toBe(mcp ? 0 : 1)
    if (mcp) expect(task.result?.reason).toBe('lease_token_write_failed')
    else
      expect(warnings.some((message) => message.includes('无法写入派工绑定 token 文件'))).toBe(true)
    expect(warnings.join('\n')).not.toContain('dispatch-secret-never-log')
  } finally {
    await b.close()
  }
})

test('凭证准备期间释放租约会取消计时器并清理已写入的唤醒凭证', async () => {
  const { bench } = await import('./harness.ts')
  const { createFakeExecutor } = await import('../src/fake.ts')
  const inner = createFakeExecutor()
  let started = false
  let stopping: Promise<void> | undefined
  let forward: ((input: string, init?: RequestInit) => Promise<Response>) | undefined
  let home = ''
  let taskId = ''
  let leaseId = ''
  let stop: (() => Promise<void>) | undefined
  let ready: () => void = () => {}
  const initialized = new Promise<void>((resolve) => {
    ready = resolve
  })
  const b = await bench({
    executors: [
      {
        ...inner,
        run(contract, ctx) {
          started = true
          return inner.run(contract, ctx)
        },
      },
    ],
    logger: {
      info() {},
      warn(message) {
        if (message.includes('无法写入派工绑定 token 文件')) stopping = stop?.()
      },
    },
    fetch: async (input, init) => {
      await initialized
      if (!forward) throw new Error('测试中枢未就绪')
      const response = await forward(input, init)
      if (!input.endsWith('/v1/leases')) return response
      const body = (await response.json()) as {
        data?: {
          lease?: {
            task_id: string
            lease_id: string
            dispatch_token?: string
            wake_token?: string
          }
        }
      }
      if (body.data?.lease) {
        const lease = body.data.lease
        taskId = lease.task_id
        leaseId = lease.lease_id
        await mkdir(taskRunDir(home, taskId), { recursive: true })
        await symlink(home, leaseTokenDir(home, taskId))
        lease.dispatch_token = 'dispatch-secret-initial'
        lease.wake_token = 'wake-secret-initial'
      }
      return new Response(JSON.stringify(body), response)
    },
  })
  home = b.home
  forward = b.hubFetch
  stop = () => b.node.stop()
  ready()
  try {
    const id = await b.create()
    await b.until(id, () => stopping !== undefined)
    await stopping
    expect(started).toBe(false)
    expect(b.node.active()).toBe(0)
    expect(b.clock.pendingTimers()).toBe(0)
    expect(existsSync(join(home, 'state', 'wake', `${taskId}.${leaseId}.token`))).toBe(false)
  } finally {
    await b.close()
  }
})

test.each([false, true])(
  '续约刷新同一凭证路径，%s MCP 执行器写失败按能力处理并清理',
  async (mcp) => {
    const { bench, fake } = await import('./harness.ts')
    const { createFakeExecutor } = await import('../src/fake.ts')
    const inner = createFakeExecutor()
    const warnings: string[] = []
    let path: string | undefined
    const fingerprints: (string | undefined)[] = []
    let forward: ((input: string, init?: RequestInit) => Promise<Response>) | undefined
    let refreshToken: string | undefined
    let ready: () => void = () => {}
    const initialized = new Promise<void>((resolve) => {
      ready = resolve
    })
    const b = await bench({
      executors: [
        {
          ...inner,
          adapterCapabilities: { ...inner.adapterCapabilities, raindown_mcp: mcp },
          run(contract, ctx) {
            path = ctx.leaseTokenFile
            return inner.run(contract, ctx)
          },
        },
      ],
      logger: {
        info() {},
        warn(message) {
          warnings.push(message)
        },
      },
      fetch: async (input, init) => {
        await initialized
        if (!forward) throw new Error('测试中枢未就绪')
        if (input.endsWith('/renew')) {
          const request = JSON.parse(String(init?.body)) as { dispatch_token_sha256?: string }
          fingerprints.push(request.dispatch_token_sha256)
        }
        const response = await forward(input, init)
        if (!input.endsWith('/v1/leases') && !input.endsWith('/renew')) return response
        const body = (await response.json()) as {
          data?: { lease?: { dispatch_token?: string }; dispatch_token?: string }
        }
        if (body.data?.lease) body.data.lease.dispatch_token = 'initial-secret-token'
        else if (body.data && refreshToken && input.endsWith('/renew'))
          body.data.dispatch_token = refreshToken
        return new Response(JSON.stringify(body), response)
      },
    })
    forward = b.hubFetch
    ready()
    try {
      const id = await b.create(fake({ script: [{ do: 'hang' }] }))
      await b.until(id, () => path !== undefined)
      expect((await readFile(path as string, 'utf8')).trim()).toBe('initial-secret-token')
      refreshToken = 'renewed-secret-token'
      await b.clock.advance(20_000)
      for (let i = 0; i < 1000; i++) {
        if ((await readFile(path as string, 'utf8')).trim() === 'renewed-secret-token') break
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      expect((await readFile(path as string, 'utf8')).trim()).toBe('renewed-secret-token')
      expect((await stat(path as string)).mode & 0o777).toBe(0o600)
      expect(fingerprints.find((value) => value !== undefined)).toBe(
        createHash('sha256').update('initial-secret-token').digest('hex').slice(0, 16),
      )
      // 让原凭证目录变成符号链接，触发真实的刷新写入失败。
      const dir = leaseTokenDir(b.home, id)
      await rm(path as string)
      await rm(dir, { recursive: true })
      await symlink(b.home, dir)
      refreshToken = 'failed-refresh-secret'
      await b.clock.advance(20_000)
      expect(fingerprints.at(-1)).toBe(
        createHash('sha256').update('renewed-secret-token').digest('hex').slice(0, 16),
      )
      if (mcp) {
        const task = await b.until(id, (task) => task.status === 'failed')
        expect(task.result?.reason).toBe('lease_token_write_failed')
      } else {
        await b.until(id, () =>
          warnings.some((message) => message.includes('无法写入派工绑定 token 文件')),
        )
        expect(b.task(id).status).toBe('running')
        expect(warnings.some((message) => message.includes('无法写入派工绑定 token 文件'))).toBe(
          true,
        )
        await b.node.stop()
      }
      expect(existsSync(path as string)).toBe(false)
      expect(warnings.join('\n')).not.toContain('failed-refresh-secret')
    } finally {
      await b.close()
    }
  },
)

test('启动期间续约保留最新 token，释放后的迟到续约不会重建凭证', async () => {
  const { bench, fake } = await import('./harness.ts')
  const { createFakeExecutor } = await import('../src/fake.ts')
  const inner = createFakeExecutor()
  let path: string | undefined
  let forward: ((input: string, init?: RequestInit) => Promise<Response>) | undefined
  let renewals = 0
  let lateRenewStarted = false
  let resumeLateRenew: () => void = () => {}
  const lateRenew = new Promise<void>((resolve) => {
    resumeLateRenew = resolve
  })
  let ready: () => void = () => {}
  const initialized = new Promise<void>((resolve) => {
    ready = resolve
  })
  const b = await bench({
    executors: [
      {
        ...inner,
        adapterCapabilities: { ...inner.adapterCapabilities, raindown_mcp: true },
        run(contract, ctx) {
          path = ctx.leaseTokenFile
          return inner.run(contract, ctx)
        },
      },
    ],
    fetch: async (input, init) => {
      await initialized
      if (!forward) throw new Error('测试中枢未就绪')
      const response = await forward(input, init)
      if (!input.endsWith('/v1/leases') && !input.endsWith('/renew')) return response
      const body = (await response.json()) as {
        data?: { lease?: { dispatch_token?: string }; dispatch_token?: string }
      }
      if (body.data?.lease) body.data.lease.dispatch_token = 'initial-secret-token'
      else if (body.data && input.endsWith('/renew')) {
        renewals++
        body.data.dispatch_token = 'renewed-secret-token'
        if (renewals > 1) {
          lateRenewStarted = true
          await lateRenew
        }
      }
      return new Response(JSON.stringify(body), response)
    },
  })
  forward = b.hubFetch
  // 第一轮续约在 execute 首次 await 前触发，使响应与初始凭证准备交错。
  const setTimer = b.clock.setTimeout.bind(b.clock)
  let earlyRenew = true
  b.clock.setTimeout = (callback, delayMs) => {
    const cancel = setTimer(callback, delayMs)
    if (earlyRenew && delayMs === 20_000) {
      earlyRenew = false
      cancel()
      callback()
    }
    return cancel
  }
  ready()
  try {
    const id = await b.create(fake({ script: [{ do: 'hang' }] }))
    await b.until(id, () => path !== undefined && renewals > 0)
    for (let i = 0; i < 1000; i++) {
      if ((await readFile(path as string, 'utf8')).trim() === 'renewed-secret-token') break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect((await readFile(path as string, 'utf8')).trim()).toBe('renewed-secret-token')
    await b.clock.advance(20_000)
    await b.until(id, () => lateRenewStarted)
    const stopping = b.node.stop()
    await b.clock.advance(60_000)
    await stopping
    expect(existsSync(path as string)).toBe(false)
    resumeLateRenew()
    await b.clock.advance(60_000)
    expect(existsSync(path as string)).toBe(false)
    expect(b.clock.pendingTimers()).toBe(0)
  } finally {
    resumeLateRenew()
    await b.close()
  }
})

test('启动清理与 removeEmptyTaskRunDir 只删除变空的任务私有目录', async () => {
  const home = await tempHome()
  await writeLeaseTokenFile(home, 't-empty', 'l-1', 'token')
  await writeLeaseTokenFile(home, 't-busy', 'l-1', 'token')
  const artifact = join(taskRunDir(home, 't-busy'), 'review', 'n-1', 'pr.diff')
  await mkdir(dirname(artifact), { recursive: true })
  await writeFile(artifact, 'diff')
  await cleanLeaseTokenFiles(home)
  expect(existsSync(taskRunDir(home, 't-empty'))).toBe(false)
  expect(existsSync(leaseTokenDir(home, 't-busy'))).toBe(false)
  expect(existsSync(artifact)).toBe(true)
  // 非空、不存在、不安全的 id 都不报错，也不删除内容。
  await removeEmptyTaskRunDir(home, 't-busy')
  await removeEmptyTaskRunDir(home, 't-missing')
  await removeEmptyTaskRunDir(home, '..')
  expect(existsSync(artifact)).toBe(true)
  // 目录本身是符号链接时 rmdir 失败，链接目标不受影响。
  const outside = join(home, 'outside')
  await mkdir(outside)
  await symlink(outside, taskRunDir(home, 't-link'))
  await removeEmptyTaskRunDir(home, 't-link')
  expect(existsSync(outside)).toBe(true)
})
