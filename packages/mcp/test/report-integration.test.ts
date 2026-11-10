import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HubClient, type Result, raindownPaths } from '@raindown/core'
import { runHub } from '../../hub/src/index.ts'
import { resolveLeaseMcpOptions } from '../src/server.ts'
import { callJson, connect, initTempHome } from './helpers.ts'

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.data
}

test('中枢重启后续约补发派工凭证，新令牌可用而旧令牌失效', async () => {
  const home = await initTempHome('raindown-report-restart-')
  const options = {
    home,
    port: 0,
    logger: { info() {}, warn() {} },
    secrets: { watch: false },
    inbox: { watch: false, channels: [] },
  }
  let hub = must(await runHub(options))
  try {
    await writeFile(raindownPaths(home).hubConfig, `port: ${hub.port}\n`)
    const node = new HubClient({
      home,
      actor: 'user',
      token: (await readFile(raindownPaths(home).hubToken, 'utf8')).trim(),
    })
    must(
      await node.createTask({
        goal: '恢复上报',
        workspace: 'ws/product-res',
        role: 'dev',
        executor: 'fake',
      }),
    )
    must(
      await node.request('nodes-register', {
        node_id: 'n-restart',
        hostname: 'test',
        version: '1',
        capabilities: ['executor:fake'],
      }),
    )
    const lease = must(
      await node.request('leases-acquire', {
        node_id: 'n-restart',
        capabilities: ['executor:fake'],
        wait_s: 0,
      }),
    ).lease
    if (!lease?.dispatch_token) throw new Error('未下发派工凭证')
    const oldWorker = new HubClient({ home, actor: 'dev', token: lease.dispatch_token })
    expect((await oldWorker.request('session-binding')).ok).toBe(true)
    await hub.stop()
    hub = must(await runHub(options))
    await writeFile(raindownPaths(home).hubConfig, `port: ${hub.port}\n`)
    expect(await oldWorker.request('session-binding')).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    })
    const renewed = must(
      await node.request('leases-renew', { lease_token: lease.lease_token }, lease.lease_id),
    )
    expect(renewed.dispatch_token).toBeString()
    expect(renewed.dispatch_token).not.toBe(lease.dispatch_token)
    if (!renewed.dispatch_token) throw new Error('未补发凭证')
    const newWorker = new HubClient({ home, actor: 'dev', token: renewed.dispatch_token })
    expect(await newWorker.request('session-binding')).toMatchObject({
      ok: true,
      data: { kind: 'task', task: { task_id: lease.task_id } },
    })
    expect(await oldWorker.request('session-binding')).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    })
    expect(
      must(
        await node.request(
          'leases-renew',
          {
            lease_token: lease.lease_token,
            dispatch_token_sha256: createHash('sha256')
              .update(renewed.dispatch_token)
              .digest('hex')
              .slice(0, 16),
          },
          lease.lease_id,
        ),
      ).dispatch_token,
    ).toBeUndefined()
  } finally {
    await hub.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('真实中枢派工经 MCP 上报、续约下发并引用 dropped 完成，结束后凭证失效', async () => {
  const home = await initTempHome('raindown-report-integration-')
  const previous = process.env.RAINDOWN_LEASE_TOKEN_FILE
  const hub = must(
    await runHub({
      home,
      port: 0,
      logger: { info() {}, warn() {} },
      secrets: { watch: false },
      inbox: { watch: false, channels: [] },
    }),
  )
  try {
    await writeFile(raindownPaths(home).hubConfig, `port: ${hub.port}\n`)
    const token = (await readFile(raindownPaths(home).hubToken, 'utf8')).trim()
    const node = new HubClient({ home, actor: 'user', token })
    const { task } = must(
      await node.createTask({
        goal: '核实问题',
        workspace: 'ws/product-res',
        role: 'dev',
        executor: 'fake',
      }),
    )
    must(
      await node.request('nodes-register', {
        node_id: 'n-report',
        hostname: 'test',
        version: '1',
        capabilities: ['executor:fake'],
      }),
    )
    const { lease } = must(
      await node.request('leases-acquire', {
        node_id: 'n-report',
        capabilities: ['executor:fake'],
        wait_s: 0,
      }),
    )
    if (!lease?.dispatch_token) throw new Error('派工未携带 worker 凭证')
    const file = join(home, 'dispatch.token')
    await writeFile(file, lease.dispatch_token, { mode: 0o600 })
    process.env.RAINDOWN_LEASE_TOKEN_FILE = file
    const mcp = await connect(
      await resolveLeaseMcpOptions({
        home,
        actor: 'dev',
        binding: { task: task.id },
      }),
    )
    try {
      expect(
        await callJson(mcp, 'raindown_report', {
          status: 'progress',
          summary: '正在核对',
        }),
      ).toMatchObject({ isError: false, doc: { ok: true } })
      expect(must(await node.showTask(task.id)).task.status).toBe('running')
      const reported = await callJson(mcp, 'raindown_report', {
        status: 'dropped',
        summary: '问题无法复现，无需处理',
        reason: '已核对全部复现步骤',
      })
      expect(reported.isError).toBe(false)
      const { report } = must(
        await node.request(
          'leases-renew',
          {
            lease_token: lease.lease_token,
          },
          lease.lease_id,
        ),
      )
      expect(report).toMatchObject({ status: 'dropped', attempt: 1 })
      if (!report) throw new Error('续约未下发上报')
      const completed = must(
        await node.request(
          'leases-complete',
          {
            lease_token: lease.lease_token,
            outcome: 'done',
            report_seq: report.seq,
            result: {
              summary: '已停止',
              artifacts: [],
              verify: [],
              executor: 'fake',
              node_id: 'n-report',
            },
          },
          lease.lease_id,
        ),
      )
      expect(completed.task).toMatchObject({ status: 'done', result: { dropped: true } })
      expect(
        (
          await callJson(mcp, 'raindown_report', {
            status: 'progress',
            summary: '过期报告',
          })
        ).doc,
      ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
      // fake 执行器不隔离：dev 角色缺省 preferred，只有一条“未隔离”提示（6.1），没有其他条目。
      expect(
        must(await node.listInbox()).items.filter(
          (i) => !(i.source === 'isolation' && i.reason === 'unisolated'),
        ),
      ).toEqual([])
    } finally {
      await mcp.close()
    }
  } finally {
    if (previous === undefined) delete process.env.RAINDOWN_LEASE_TOKEN_FILE
    else process.env.RAINDOWN_LEASE_TOKEN_FILE = previous
    await hub.stop()
    await rm(home, { recursive: true, force: true })
  }
})
