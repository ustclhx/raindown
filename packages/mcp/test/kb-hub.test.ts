import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HubClient, type Result, raindownPaths } from '@raindown/core'
import { commands } from '../../cli/src/commands/index.ts'
import { runCli } from '../../cli/src/run.ts'
import { writeEntry, writeText } from '../../core/test/helpers.ts'
import { runHub } from '../../hub/src/index.ts'
import { serve } from '../../hub/src/serve.ts'
import { resolveLeaseMcpOptions } from '../src/server.ts'
import { callJson, connect, initTempHome } from './helpers.ts'

/**
 * 任务绑定的 MCP 经中枢读取知识（add-worker-credential-isolation 2.2、D3）：
 * worker 侧的 raindown-home 没有 brain/ 与 state/（模拟隔离下不可读），kb 操作仍成功，结果与 CLI 一致；
 * 中枢没有 kb 路由（旧中枢）时报明确错误，不回退到本地读取。
 */

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.data
}

const cleanups: (() => Promise<void>)[] = []
const previousTokenFile = process.env.RAINDOWN_LEASE_TOKEN_FILE
const previousHome = process.env.RAINDOWN_HOME
afterEach(async () => {
  if (previousTokenFile === undefined) delete process.env.RAINDOWN_LEASE_TOKEN_FILE
  else process.env.RAINDOWN_LEASE_TOKEN_FILE = previousTokenFile
  if (previousHome === undefined) delete process.env.RAINDOWN_HOME
  else process.env.RAINDOWN_HOME = previousHome
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** worker 侧的 home：只有 config/hub.yaml（用来找到中枢），没有 brain/ 与 state/。 */
async function workerHome(port: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'raindown-kb-worker-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'hub.yaml'), `port: ${port}\n`)
  return home
}

test('任务绑定会话在 raindown-home 不可读时经中枢读取，结果与 CLI 一致；派工结束后被拒', async () => {
  const home = await initTempHome('raindown-kb-hub-')
  cleanups.push(() => rm(dirname(home), { recursive: true, force: true }))
  writeEntry(home, 'concepts/ganzhi', {
    type: 'concept',
    title: '干支日 概念',
    summary: '全局概念',
    scope: 'work',
  })
  writeEntry(home, 'resources/repos/res', {
    type: 'repo',
    title: '干支日 仓库甲',
    summary: '本 workspace 的仓库',
    scope: 'work',
    owner: 'ws/product-res',
    path: '/tmp/res',
  })
  writeEntry(home, 'resources/repos/xuanxue', {
    type: 'repo',
    title: '干支日 仓库乙',
    summary: '别的 workspace 的仓库',
    scope: 'work',
    owner: 'ws/xuanxue-saas',
    path: '/tmp/xuanxue',
  })
  writeText(
    join(home, 'brain', 'journal', '2026-11-01.md'),
    '# 2026-11-01\n\n## 09:00:00 · codex · ws/product-res\n\n干支日 进展\n',
  )
  const hub = must(
    await runHub({
      home,
      port: 0,
      logger: { info() {}, warn() {} },
      secrets: { watch: false },
      inbox: { watch: false, channels: [] },
    }),
  )
  cleanups.push(() => hub.stop())
  await writeFile(raindownPaths(home).hubConfig, `port: ${hub.port}\n`)
  const node = new HubClient({
    home,
    actor: 'user',
    token: (await readFile(raindownPaths(home).hubToken, 'utf8')).trim(),
  })
  const { task } = must(
    await node.createTask({
      goal: '查资料',
      workspace: 'ws/product-res',
      role: 'dev',
      executor: 'fake',
    }),
  )
  must(
    await node.request('nodes-register', {
      node_id: 'n-kb',
      hostname: 'test',
      version: '1',
      capabilities: ['executor:fake'],
    }),
  )
  const { lease } = must(
    await node.request('leases-acquire', {
      node_id: 'n-kb',
      capabilities: ['executor:fake'],
      wait_s: 0,
    }),
  )
  if (!lease?.dispatch_token) throw new Error('派工未携带 worker 凭证')

  const worker = await workerHome(hub.port)
  const tokenFile = join(dirname(worker), 'dispatch.token')
  await writeFile(tokenFile, lease.dispatch_token, { mode: 0o600 })
  process.env.RAINDOWN_LEASE_TOKEN_FILE = tokenFile
  const mcp = await connect(
    await resolveLeaseMcpOptions({ home: worker, actor: 'dev', binding: { task: task.id } }),
  )
  try {
    // CLI 以 user 身份在中枢的 home 上执行同一查询。
    process.env.RAINDOWN_HOME = home
    const cli = async (args: string[]) => {
      const r = await runCli([...args, '--json'], commands)
      expect(r.exitCode).toBe(0)
      return JSON.parse(r.stdout).data
    }

    const search = await callJson(mcp, 'kb_search', { query: '干支日' })
    expect(search.isError).toBe(false)
    const cliSearch = await cli(['kb', 'search', '干支日'])
    // 与 CLI 相同，只是去掉了别的 workspace 的条目（顺序不变）。
    expect(search.doc.data).toEqual({
      results: cliSearch.results.filter((r: { id: string }) => r.id !== 'resources/repos/xuanxue'),
    })
    expect(cliSearch.results.map((r: { id: string }) => r.id)).toContain('resources/repos/xuanxue')

    const query = await callJson(mcp, 'kb_query', { filters: ['type=repo'] })
    expect(query.doc.data).toEqual({
      results: (await cli(['kb', 'query', 'type=repo'])).results.filter(
        (r: { id: string }) => r.id !== 'resources/repos/xuanxue',
      ),
    })

    const get = await callJson(mcp, 'kb_get', { id: 'resources/repos/res' })
    expect(get.doc.data).toEqual(await cli(['kb', 'get', 'resources/repos/res']))
    expect(await callJson(mcp, 'kb_get', { id: 'resources/repos/xuanxue' })).toMatchObject({
      isError: true,
      doc: { ok: false, error: { code: 'not_found' } },
    })

    // worker 侧没有读写过 raindown-home 的 brain/ 与 state/。
    expect(existsSync(join(worker, 'brain'))).toBe(false)
    expect(existsSync(join(worker, 'state'))).toBe(false)

    // 派工结束后凭证失效：kb 读取被拒，也不回退到本地。
    must(
      await node.request(
        'leases-complete',
        {
          lease_token: lease.lease_token,
          outcome: 'done',
          result: {
            summary: '完成',
            artifacts: [],
            verify: [],
            executor: 'fake',
            node_id: 'n-kb',
          },
        },
        lease.lease_id,
      ),
    )
    expect((await callJson(mcp, 'kb_search', { query: '干支日' })).doc).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    })
  } finally {
    await mcp.close()
  }
})

test('旧中枢没有 kb 路由：报明确错误，不回退到本地读取', async () => {
  // 旧中枢的鉴权中间件对派工令牌访问未知接口一律返回 403 forbidden。
  const hub = await serve(
    async (request) => {
      const path = new URL(request.url).pathname
      if (path === '/v1/binding') {
        return Response.json({
          ok: true,
          data: {
            kind: 'task',
            task: {
              actor: 'dev',
              task_id: 'task-a',
              workspace: 'ws/product-res',
              lease_id: 'lease-a',
              attempt: 1,
            },
          },
        })
      }
      return Response.json(
        {
          ok: false,
          error: {
            kind: 'failure',
            code: 'forbidden',
            message: '派工凭证只能读取与上报当前任务',
            retryable: false,
          },
        },
        { status: 403 },
      )
    },
    { port: 0 },
  )
  cleanups.push(() => hub.close())
  // worker 侧 home 里放一份本地可读的知识：若回退到本地读取，会读到它。
  const worker = await workerHome(hub.port)
  writeEntry(worker, 'concepts/local', {
    type: 'concept',
    title: '干支日 本地',
    summary: '不应被读到',
    scope: 'work',
  })
  const tokenFile = join(dirname(worker), 'dispatch.token')
  await writeFile(tokenFile, 'fls_fixture')
  process.env.RAINDOWN_LEASE_TOKEN_FILE = tokenFile
  const mcp = await connect(await resolveLeaseMcpOptions({ home: worker, actor: 'dev' }))
  try {
    for (const [name, args] of [
      ['kb_search', { query: '干支日' }],
      ['kb_get', { id: 'concepts/local' }],
      ['kb_query', { filters: ['type=concept'] }],
    ] as const) {
      const r = await callJson(mcp, name, args)
      expect(r).toMatchObject({
        isError: true,
        doc: { ok: false, error: { code: 'hub_kb_unsupported' } },
      })
      expect(JSON.stringify(r.doc)).not.toContain('不应被读到')
    }
  } finally {
    await mcp.close()
  }
})

test('任务绑定但没有派工令牌文件：拒绝，不改用其他中枢凭证', async () => {
  delete process.env.RAINDOWN_LEASE_TOKEN_FILE
  const worker = await workerHome(1)
  const mcp = await connect({
    home: worker,
    actor: 'dev',
    binding: { kind: 'task', workspace: 'ws/product-res', task: 'task-a' },
  })
  try {
    expect((await callJson(mcp, 'kb_search', { query: '干支日' })).doc).toMatchObject({
      ok: false,
      error: { code: 'lease_token_required' },
    })
  } finally {
    await mcp.close()
  }
})
