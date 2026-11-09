import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildProbePlan,
  computeIsolationSpec,
  formatDoctorReport,
  type IsolationProbeReport,
  type IsolationProbeRun,
  isolationProbeChecks,
  NO_ADAPTER_CAPABILITIES,
  type NodeView,
  ok,
  probeRegressions,
  probeRunPassed,
  runDoctor,
} from '../src/index.ts'
import { doctorOptions } from './doctor-helpers.ts'
import { tempHome } from './helpers.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('探针清单（buildProbePlan）', () => {
  async function spec(opts: { access?: 'read' | 'write'; ports?: number[] } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'raindown-probe-plan-'))
    roots.push(root)
    const home = join(root, 'raindown-home')
    const cwd = join(root, 'work')
    mkdirSync(cwd, { recursive: true })
    const r = await computeIsolationSpec({
      home,
      taskId: 'isolation-probe-self-1',
      executor: 'codex-exec',
      cwd,
      access: opts.access ?? 'write',
      hubPort: 7801,
      userHome: join(root, 'user'),
      env: {},
      ...(opts.ports ? { resolveOrcaPorts: () => opts.ports as number[] } : {}),
    })
    if (!r.ok) throw new Error(r.error.message)
    return { home, cwd: realpathSync(cwd), spec: r.data }
  }

  test('受保护项总是预期拒绝；允许项与工作目录按清单；套接字与端口未解析时跳过；跨进程调试未验证', async () => {
    const s = await spec()
    const plan = buildProbePlan({
      spec: s.spec,
      home: s.home,
      ageKeyFile: '/u/.config/sops/age/keys.txt',
      otherTaskToken: '/x/other.token',
      ownToken: '/x/own.token',
      cwd: s.cwd,
      hubUrl: 'http://127.0.0.1:7801/',
      orcaSockets: { status: 'none', reason: 'Orca 运行时目录不存在' },
    })
    const by = Object.fromEntries(plan.items.map((i) => [i.item, i]))
    for (const id of [
      'read.hub_token',
      'read.ledger_db',
      'read.other_task_token',
      'read.age_key',
      'read.hub_token_via_symlink',
      'write.config',
      'connect.orca_socket',
      'connect.orca_port',
      'debug.process',
    ])
      expect({ id, expected: by[id]?.expected }).toEqual({ id, expected: 'deny' })
    expect(by['read.hub_token']?.target).toBe(join(s.home, 'state', 'hub.token'))
    expect(by['read.ledger_db']?.target).toBe(join(s.home, 'state', 'raindown.db'))
    expect(by['write.config']?.target).toBe(join(s.home, 'config'))
    expect(by['connect.orca_socket']?.skip).toBe('Orca 运行时目录不存在')
    expect(by['connect.orca_port']?.skip).toContain('Orca 端口未解析')
    expect(by['debug.process']?.unverified).toContain('未验证')
    expect(by['write.workdir']).toMatchObject({ expected: 'allow', target: s.cwd })
    expect(by['read.own_task_token']).toMatchObject({ expected: 'allow', target: '/x/own.token' })
    expect(by['connect.hub']).toMatchObject({
      expected: 'allow',
      target: 'http://127.0.0.1:7801/v1/health',
    })
  })

  test('只读角色的工作目录预期不可写；解析出的 Orca 端口与找到的套接字逐个尝试', async () => {
    const s = await spec({ access: 'read', ports: [60211] })
    const plan = buildProbePlan({
      spec: s.spec,
      home: s.home,
      ageKeyFile: '/k',
      otherTaskToken: '/o',
      ownToken: '/s',
      cwd: s.cwd,
      hubUrl: 'http://127.0.0.1:7801',
      orcaSockets: { status: 'found', paths: ['/orca/a.sock', '/orca/daemon/d.sock'] },
    })
    const by = Object.fromEntries(plan.items.map((i) => [i.item, i]))
    expect(by['write.workdir']?.expected).toBe('deny')
    expect(by['connect.orca_port.60211']).toMatchObject({
      kind: 'tcp_connect',
      target: '127.0.0.1:60211',
    })
    expect(by['connect.orca_socket.1']?.target).toBe('/orca/a.sock')
    expect(by['connect.orca_socket.2']?.target).toBe('/orca/daemon/d.sock')
  })
})

const run = (
  over: Partial<IsolationProbeRun> & { failing?: boolean; skipped?: boolean } = {},
): IsolationProbeRun => {
  const { failing, skipped, ...rest } = over
  return {
    executor: 'codex-exec',
    setting: 'danger-full-access',
    declared_layer: 'seatbelt',
    applied_layer: 'none',
    passed: !failing,
    items: [
      {
        item: 'read.hub_token',
        target: '/h/state/hub.token',
        expected: 'deny',
        actual: failing ? 'allow' : 'deny',
        ok: !failing,
        ...(failing ? {} : { detail: 'EPERM' }),
      },
      ...(skipped
        ? [
            {
              item: 'connect.orca_port',
              expected: 'deny' as const,
              actual: 'skipped' as const,
              ok: null,
              detail: 'Orca 端口未解析：没有提供 Orca 端口解析',
            },
          ]
        : []),
      {
        item: 'debug.process',
        expected: 'deny',
        actual: 'unverified',
        ok: null,
        detail: '未验证的原因',
      },
    ],
    ...rest,
  }
}

const nodeView = (probe: IsolationProbeReport | null, enforced = false): NodeView => ({
  node_id: 'n-1',
  hostname: 'h',
  version: '0',
  capabilities: [],
  executors: [
    {
      type: 'codex-exec',
      adapter_capabilities: {
        ...NO_ADAPTER_CAPABILITIES,
        credential_isolation: {
          layers: { 'danger-full-access': 'seatbelt', 'in-node': 'none' },
          enforced,
        },
      },
    },
    { type: 'fake', adapter_capabilities: NO_ADAPTER_CAPABILITIES },
  ],
  concurrency: 1,
  registered_at: '2026-11-09T00:00:00.000Z',
  last_seen_at: null,
  active_leases: 0,
  isolation_probe: probe,
})

const probe = (r: IsolationProbeRun): IsolationProbeReport => ({
  ran_at: '2026-11-09T01:00:00.000Z',
  macos_version: '15.1',
  runs: [r],
})

describe('通过判定与状态变化', () => {
  test('全部跳过或上报 passed 但条目失败都不算通过', () => {
    expect(probeRunPassed(run())).toBe(true)
    expect(probeRunPassed(run({ failing: true }))).toBe(false)
    expect(probeRunPassed({ ...run(), items: run().items.slice(1) })).toBe(false)
    expect(probeRunPassed({ ...run({ failing: true }), passed: true })).toBe(false)
    expect(probeRunPassed({ ...run(), error: { code: 'x', message: 'y' } })).toBe(false)
  })

  test('只有通过 → 不通过算变化', () => {
    expect(probeRegressions(probe(run()), probe(run({ failing: true }))).length).toBe(1)
    expect(probeRegressions(probe(run({ failing: true })), probe(run({ failing: true })))).toEqual(
      [],
    )
    expect(probeRegressions(null, probe(run({ failing: true })))).toEqual([])
    expect(probeRegressions(probe(run()), probe(run()))).toEqual([])
  })
})

describe('doctor 显示隔离自检（worker-credential-isolation 3.2）', () => {
  const checksFor = async (nodes: NodeView[]) => isolationProbeChecks(async () => ok({ nodes }))

  test('未探测：info，提示升级并重启节点；施加层 none 的设置不探测；未上报能力的执行器单独说明', async () => {
    const checks = await checksFor([nodeView(null)])
    const seatbelt = checks.find((c) => c.id === 'isolation.n-1.codex-exec.danger-full-access')
    expect(seatbelt).toMatchObject({ ok: false, severity: 'info' })
    expect(seatbelt?.message).toContain(
      'codex-exec × danger-full-access：声明 seatbelt，未施加；未探测',
    )
    expect(checks.find((c) => c.id === 'isolation.n-1.codex-exec.in-node')?.message).toContain(
      '施加层为 none，不探测',
    )
    expect(checks.find((c) => c.id === 'isolation.n-1.fake')?.message).toContain(
      '未上报凭证隔离能力',
    )
  })

  test('全部通过：ok；适配器已施加且通过时显示已施加', async () => {
    const checks = await checksFor([nodeView(probe(run()), true)])
    const c = checks.find((x) => x.id === 'isolation.n-1.codex-exec.danger-full-access')
    expect(c?.ok).toBe(true)
    expect(c?.message).toContain('声明 seatbelt，已施加')
    expect(c?.message).toContain('最近探针 2026-11-09T01:00:00.000Z，macOS 15.1')
    expect(c?.message).toContain('：通过')
    expect(c?.message).toContain('未验证 debug.process')
  })

  test('部分失败：warning（不影响退出码），列出失败项名与路径，不含内容', async () => {
    const checks = await checksFor([nodeView(probe(run({ failing: true })))])
    const c = checks.find((x) => x.id === 'isolation.n-1.codex-exec.danger-full-access')
    expect(c).toMatchObject({ ok: false, severity: 'warning' })
    expect(c?.message).toContain('：不通过')
    expect(c?.message).toContain('失败 read.hub_token（/h/state/hub.token）：预期拒绝，实际 allow')
    expect(c?.hint).toContain('尚未施加')
  })

  test('跳过项与原因', async () => {
    const checks = await checksFor([nodeView(probe(run({ skipped: true })))])
    const c = checks.find((x) => x.id === 'isolation.n-1.codex-exec.danger-full-access')
    expect(c?.message).toContain('跳过 connect.orca_port：Orca 端口未解析：没有提供 Orca 端口解析')
  })

  test('探针无法运行时显示原因（例如遗留 home 是工作目录的祖先）', async () => {
    const checks = await checksFor([
      nodeView(
        probe({
          ...run(),
          passed: false,
          items: [],
          error: {
            code: 'isolation_allow_in_deny',
            message: '允许路径 /x 位于遗留 home /y（来源：环境变量 FLOW_HOME）内',
          },
        }),
      ),
    ])
    const c = checks.find((x) => x.id === 'isolation.n-1.codex-exec.danger-full-access')
    expect(c?.message).toContain('无法运行：isolation_allow_in_deny')
    expect(c?.message).toContain('FLOW_HOME')
  })

  test('中枢不可用时只给 info；完整 doctor 报告包含隔离汇总且退出码不受探针影响', async () => {
    const down = await isolationProbeChecks(async () => {
      throw new Error('连接失败')
    })
    expect(down).toEqual([expect.objectContaining({ id: 'isolation.probe', severity: 'info' })])

    const home = await tempHome()
    const r = await runDoctor(
      home,
      'RAINDOWN_HOME',
      doctorOptions(home, {
        isolationNodes: async () => ok({ nodes: [nodeView(probe(run({ failing: true })))] }),
      }),
    )
    const report = r.ok ? r.data : (r.error.details as Parameters<typeof formatDoctorReport>[0])
    const text = formatDoctorReport(report)
    expect(text).toContain('[warn] 隔离 n-1 codex-exec × danger-full-access')
    expect(report.checks.some((c) => c.id.startsWith('isolation.') && c.severity === 'error')).toBe(
      false,
    )
  })
})
