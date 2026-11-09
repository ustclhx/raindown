import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initRaindownHome,
  NO_ADAPTER_CAPABILITIES,
  type NodeView,
  raindownPaths,
} from '@raindown/core'
import { runHub } from '@raindown/hub'
import { CODEX_CREDENTIAL_ISOLATION, createFakeExecutor, startNode } from '@raindown/node'
import { commands } from '../src/commands/index.ts'
import { isolationLines } from '../src/commands/node.ts'
import { runCli } from '../src/run.ts'

/** `raindown node list`（node-protocol "查看节点"）：临时 RAINDOWN_HOME，真实中枢与节点。 */
let saved: string | undefined
let home: string
const stops: Array<() => Promise<void>> = []
const quiet = { info() {}, warn() {}, error() {} }

beforeEach(async () => {
  saved = process.env.RAINDOWN_HOME
  home = join(mkdtempSync(join(tmpdir(), 'raindown-cli-node-')), 'home')
  process.env.RAINDOWN_HOME = home
  const init = await initRaindownHome(home)
  if (!init.ok) throw new Error(init.error.message)
})

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
  if (saved === undefined) delete process.env.RAINDOWN_HOME
  else process.env.RAINDOWN_HOME = saved
})

test('raindown node list：输出节点 id、能力与最近活动时间', async () => {
  const hub = await runHub({ home, port: 0, logger: quiet as never })
  if (!hub.ok) throw new Error(hub.error.message)
  stops.push(hub.data.stop)
  writeFileSync(
    raindownPaths(home).nodeConfig,
    `hub_url: ${hub.data.url}\ncapabilities: [browser]\n`,
  )
  const node = await startNode({ home, logger: quiet, hostname: 'cli-host', waitS: 1 })
  if (!node.ok) throw new Error(node.error.message)
  stops.push(node.data.stop)

  let out = ''
  for (let i = 0; i < 100 && !out.includes(node.data.nodeId); i++) {
    out = (await runCli(['node', 'list'], commands)).stdout
    if (!out.includes(node.data.nodeId)) await new Promise((r) => setTimeout(r, 20))
  }
  expect(out).toContain(node.data.nodeId)
  expect(out).toContain('cli-host')
  expect(out).toContain('browser, executor:fake')
  expect(out).toMatch(/\d{4}-\d{2}-\d{2}T/)
  expect(out).toContain(`${node.data.nodeId} fake：none（仅声明，未施加）`)

  const json = JSON.parse((await runCli(['node', 'list', '--json'], commands)).stdout)
  expect(json.data.nodes[0]).toMatchObject({
    node_id: node.data.nodeId,
    hostname: 'cli-host',
    executors: [
      {
        type: 'fake',
        mode: 'headless',
        adapter_capabilities: createFakeExecutor().adapterCapabilities,
      },
    ],
  })
})

test('raindown node list：中枢从未启动时返回可重试错误（退出码 3）', async () => {
  const r = await runCli(['node', 'list'], commands)
  expect(r.exitCode).toBe(3)
})

test('node list 的凭证隔离：显示每个执行器的声明值与“未施加”，旧节点显示未上报', () => {
  const view = (node_id: string, executors: NodeView['executors']): NodeView => ({
    node_id,
    hostname: 'h',
    version: '0',
    capabilities: [],
    executors,
    concurrency: 1,
    registered_at: '2026-11-09T00:00:00.000Z',
    last_seen_at: null,
    active_leases: 0,
    isolation_probe: null,
  })
  const text = isolationLines([
    view('n-new', [
      {
        type: 'codex-orca',
        adapter_capabilities: {
          ...NO_ADAPTER_CAPABILITIES,
          credential_isolation: CODEX_CREDENTIAL_ISOLATION,
        },
      },
    ]),
    view('n-old', [{ type: 'codex-orca', adapter_capabilities: NO_ADAPTER_CAPABILITIES }]),
  ])
  expect(text).toContain(
    'n-new codex-orca：danger-full-access→seatbelt、workspace-write→native、read-only→native（仅声明，未施加）',
  )
  expect(text).toContain('n-old codex-orca：未上报（按 none 处理）')
  // 新节点还没有探针结果：每个沙箱设置显示“未探测”。
  expect(text).toContain('codex-orca × danger-full-access：声明 seatbelt，未施加；未探测')
  expect(text).not.toContain('已施加')
  expect(isolationLines([])).toBe('')
})

test('node list 的隔离自检：显示最近探针时间、失败项与跳过项（只含项名与路径）', () => {
  const node: NodeView = {
    node_id: 'n-1',
    hostname: 'h',
    version: '0',
    capabilities: [],
    executors: [
      {
        type: 'codex-exec',
        adapter_capabilities: {
          ...NO_ADAPTER_CAPABILITIES,
          credential_isolation: { layers: { 'danger-full-access': 'seatbelt' }, enforced: false },
        },
      },
    ],
    concurrency: 1,
    registered_at: '2026-11-09T00:00:00.000Z',
    last_seen_at: null,
    active_leases: 0,
    isolation_probe: {
      ran_at: '2026-11-09T01:00:00.000Z',
      macos_version: '15.1',
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
              target: '/tmp/h/state/hub.token',
              expected: 'deny',
              actual: 'allow',
              ok: false,
            },
            {
              item: 'connect.orca_port',
              expected: 'deny',
              actual: 'skipped',
              ok: null,
              detail: 'Orca 端口未解析',
            },
          ],
        },
      ],
    },
  }
  const text = isolationLines([node])
  expect(text).toContain(
    'codex-exec × danger-full-access：声明 seatbelt，未施加；最近探针 2026-11-09T01:00:00.000Z，macOS 15.1（实际以 none 运行）：不通过',
  )
  expect(text).toContain('失败 read.hub_token（/tmp/h/state/hub.token）：预期拒绝，实际 allow')
  expect(text).toContain('跳过 connect.orca_port：Orca 端口未解析')
})
