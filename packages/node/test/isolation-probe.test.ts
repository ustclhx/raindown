import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ExecutorInfo,
  NO_ADAPTER_CAPABILITIES,
  type ProbePlan,
  probeRunPassed,
  renderSeatbeltProfile,
  runTasksDir,
} from '@raindown/core'
import { type ProbeSystem, runProbeItems } from '../src/isolation-probe/checks.ts'
import {
  cleanProbeLeftovers,
  findOrcaSockets,
  probeTargets,
  runIsolationProbe,
  seatbeltProbeLaunchWrapper,
} from '../src/isolation-probe/run.ts'
import { effectiveCredentialIsolation } from '../src/seatbelt.ts'

/** 假受保护文件的特征字符串：断言探针输出中绝不出现。 */
const MARKER = 'PROBE-MARKER-must-not-leak'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) s.close()
  for (const root of roots.splice(0)) {
    // chmod 000 的文件需要先恢复权限才能删除目录（rm 在 macOS 上对 000 文件本身可删，目录需可写）。
    await rm(root, { recursive: true, force: true })
  }
})

const codexExec = (enforced = false): ExecutorInfo => ({
  type: 'codex-exec',
  adapter_capabilities: {
    ...NO_ADAPTER_CAPABILITIES,
    credential_isolation: {
      layers: { 'danger-full-access': 'seatbelt', 'workspace-write': 'native', 'in-node': 'none' },
      enforced,
    },
  },
})

/** 临时 raindown-home、用户主目录与本机中枢（只提供无鉴权的 /v1/health）。 */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'raindown-probe-'))
  roots.push(root)
  const home = join(root, 'raindown-home')
  const userHome = join(root, 'user')
  const tmp = join(root, 'tmp')
  for (const d of [
    join(home, 'state'),
    join(home, 'config'),
    join(userHome, '.config/sops/age'),
    tmp,
  ])
    await mkdir(d, { recursive: true })
  await writeFile(join(home, 'state', 'hub.token'), `${MARKER}-hub-token\n`, { mode: 0o600 })
  await writeFile(join(home, 'state', 'raindown.db'), `${MARKER}-ledger\n`, { mode: 0o600 })
  await writeFile(join(userHome, '.config/sops/age/keys.txt'), `${MARKER}-age\n`, { mode: 0o600 })
  const server = createServer((req, res) => {
    res.statusCode = req.url === '/v1/health' ? 200 : 404
    res.end('{"ok":true}')
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { root, home, userHome, tmp, hubUrl: `http://127.0.0.1:${port}` }
}

const probeOptions = (s: Awaited<ReturnType<typeof setup>>, executors = [codexExec()]) => ({
  home: s.home,
  hubUrl: s.hubUrl,
  executors,
  userHome: s.userHome,
  env: {},
  tmpDir: s.tmp,
  macosVersion: async () => '15.1',
  now: () => new Date('2026-11-09T00:00:00.000Z'),
})

describe('探针目标', () => {
  test('只探测声明了非 none 施加层的执行器 × 沙箱设置；未施加时实际以 none 运行', () => {
    const targets = probeTargets([
      codexExec(),
      { type: 'fake', adapter_capabilities: NO_ADAPTER_CAPABILITIES },
    ])
    expect(targets).toEqual([
      {
        executor: 'codex-exec',
        setting: 'danger-full-access',
        declared_layer: 'seatbelt',
        applied_layer: 'none',
      },
      {
        executor: 'codex-exec',
        setting: 'workspace-write',
        declared_layer: 'native',
        applied_layer: 'none',
      },
    ])
    expect(probeTargets([codexExec(true)])[0]?.applied_layer).toBe('seatbelt')
  })

  test('没有 Orca 运行时目录或其中没有套接字时记为没有目标', async () => {
    const s = await setup()
    expect(await findOrcaSockets(s.userHome)).toEqual({
      status: 'none',
      reason: 'Orca 运行时目录不存在',
    })
    await mkdir(join(s.userHome, 'Library/Application Support/orca'), { recursive: true })
    expect((await findOrcaSockets(s.userHome)).status).toBe('none')
  })
})

describe('未施加隔离（受保护项可读）', () => {
  test('探针如实报告不通过并列出失败项；输出不含受保护文件内容；伪造令牌与临时文件全部删除', async () => {
    const s = await setup()
    const report = await runIsolationProbe(probeOptions(s))
    expect(report.ran_at).toBe('2026-11-09T00:00:00.000Z')
    expect(report.macos_version).toBe('15.1')
    expect(report.runs.map((r) => r.setting)).toEqual(['danger-full-access', 'workspace-write'])
    for (const run of report.runs) {
      expect(run.error).toBeUndefined()
      expect(run.passed).toBe(false)
      expect(probeRunPassed(run)).toBe(false)
      const by = Object.fromEntries(run.items.map((i) => [i.item, i]))
      for (const id of [
        'read.hub_token',
        'read.ledger_db',
        'read.other_task_token',
        'read.age_key',
        'read.hub_token_via_symlink',
        'write.config',
      ])
        expect({ id, actual: by[id]?.actual, ok: by[id]?.ok }).toEqual({
          id,
          actual: 'allow',
          ok: false,
        })
      // 允许项可用。
      for (const id of ['write.workdir', 'read.own_task_token', 'connect.hub'])
        expect({ id, actual: by[id]?.actual, ok: by[id]?.ok }).toEqual({
          id,
          actual: 'allow',
          ok: true,
        })
      // 套接字、端口未解析为跳过；跨进程调试为未验证。
      expect(by['connect.orca_socket']).toMatchObject({ actual: 'skipped', ok: null })
      expect(by['connect.orca_socket']?.detail).toContain('Orca 运行时目录不存在')
      // Orca 端口未解析：无法证明控制端口被拒绝，记为失败而不是跳过（审查第一轮 M2）。
      expect(by['connect.orca_port']).toMatchObject({ actual: 'error', ok: false })
      expect(by['connect.orca_port']?.detail).toContain('Orca 端口未解析')
      // 改名探针与本任务配置：未施加时改名成功（随后改回），没有配置文件时跳过。
      expect(by['rename.protected_ancestor']).toMatchObject({ actual: 'allow', ok: false })
      expect(by['write.own_profile']).toMatchObject({ actual: 'skipped', ok: null })
      expect(by['debug.process']).toMatchObject({ actual: 'unverified', ok: null })
      expect(by['read.hub_token']?.target).toBe(join(s.home, 'state', 'hub.token'))
    }
    // 结果中没有任何受保护文件或伪造令牌的内容。
    const text = JSON.stringify(report)
    expect(text).not.toContain(MARKER)
    expect(text).not.toContain('RAINDOWN-ISOLATION-PROBE-FAKE-TOKEN')
    // 伪造令牌、临时任务目录、工作目录与 config/ 下的写探针都已删除。
    const tasks = runTasksDir(s.home)
    expect(existsSync(tasks) ? readdirSync(tasks) : []).toEqual([])
    expect(readdirSync(s.tmp)).toEqual([])
    expect(readdirSync(join(s.home, 'config'))).toEqual([])
  })

  test('chmod 000 的受保护文件记为拒绝（EACCES），其余可读项仍报告失败', async () => {
    if (process.getuid?.() === 0) return
    const s = await setup()
    await chmod(join(s.home, 'state', 'hub.token'), 0o000)
    await chmod(join(s.home, 'config'), 0o500)
    try {
      const report = await runIsolationProbe(probeOptions(s, [codexExec()]))
      const run = report.runs[0]
      if (!run) throw new Error('没有探针运行')
      const by = Object.fromEntries(run.items.map((i) => [i.item, i]))
      expect(by['read.hub_token']).toMatchObject({ actual: 'deny', ok: true, detail: 'EACCES' })
      expect(by['read.hub_token_via_symlink']).toMatchObject({ actual: 'deny', ok: true })
      expect(by['write.config']).toMatchObject({ actual: 'deny', ok: true })
      expect(by['read.ledger_db']).toMatchObject({ actual: 'allow', ok: false })
      expect(run.passed).toBe(false)
    } finally {
      await chmod(join(s.home, 'config'), 0o700)
      await chmod(join(s.home, 'state', 'hub.token'), 0o600)
    }
  })

  test('隔离清单无法计算时（遗留 home 是工作目录的祖先）报告原因，不通过', async () => {
    const s = await setup()
    const legacy = join(s.root, 'legacy-home')
    await mkdir(join(legacy, 'tmp'), { recursive: true })
    const report = await runIsolationProbe({
      ...probeOptions(s),
      tmpDir: join(legacy, 'tmp'),
      env: { FLOW_HOME: legacy },
    })
    const run = report.runs[0]
    expect(run?.passed).toBe(false)
    expect(run?.error?.code).toBe('isolation_allow_in_deny')
    expect(run?.error?.message).toContain('遗留 home')
    expect(run?.error?.message).toContain('FLOW_HOME')
    expect(readdirSync(join(legacy, 'tmp'))).toEqual([])
  })

  test('启动包装接收与 worker 相同的目标，本阶段恒等', async () => {
    const s = await setup()
    const seen: string[] = []
    const report = await runIsolationProbe({
      ...probeOptions(s),
      launchWrapper: (target, argv) => {
        seen.push(`${target.executor}/${target.setting}/${target.applied_layer}`)
        return [...argv]
      },
    })
    // 同一实际施加层（none）只启动一次，代表目标为排序后的第一个。
    expect(seen).toEqual(['codex-exec/danger-full-access/none'])
    expect(report.runs.every((r) => r.items.length > 0)).toBe(true)
  })
})

describe('模拟已隔离（注入的文件系统接口拒绝受保护项）', () => {
  const plan: ProbePlan = {
    workdir: '/w',
    connect_timeout_ms: 1000,
    items: [
      { item: 'read.hub_token', kind: 'read', expected: 'deny', target: '/h/state/hub.token' },
      { item: 'read.ledger_db', kind: 'read', expected: 'deny', target: '/h/state/raindown.db' },
      { item: 'read.other_task_token', kind: 'read', expected: 'deny', target: '/h/run/tasks/o/t' },
      {
        item: 'read.age_key',
        kind: 'read',
        expected: 'deny',
        target: '/u/.config/sops/age/keys.txt',
      },
      {
        item: 'read.hub_token_via_symlink',
        kind: 'read_via_symlink',
        expected: 'deny',
        target: '/h/state/hub.token',
      },
      { item: 'write.config', kind: 'write_new', expected: 'deny', target: '/h/config' },
      {
        item: 'rename.protected_ancestor',
        kind: 'rename',
        expected: 'deny',
        target: '/h/run/tasks/p/rename-probe/a',
      },
      {
        item: 'write.own_profile',
        kind: 'open_write',
        expected: 'deny',
        target: '/h/state/tasks/p/isolation.sb',
      },
      {
        item: 'connect.orca_socket.1',
        kind: 'unix_connect',
        expected: 'deny',
        target: '/o/x.sock',
      },
      { item: 'connect.orca_port', kind: 'tcp_connect', expected: 'deny', skip: '未解析' },
      { item: 'debug.process', kind: 'process_debug', expected: 'deny', unverified: '未验证' },
      { item: 'write.workdir', kind: 'write_new', expected: 'allow', target: '/w' },
      { item: 'read.own_task_token', kind: 'read', expected: 'allow', target: '/h/run/tasks/s/t' },
      {
        item: 'connect.hub',
        kind: 'http_get',
        expected: 'allow',
        target: 'http://127.0.0.1:1/v1/health',
      },
    ],
  }
  const eperm = () => Object.assign(new Error('x'), { code: 'EPERM' })
  const deniedSystem = (overrides: Partial<ProbeSystem> = {}): ProbeSystem => {
    const links = new Map<string, string>()
    const allowed = (p: string) => p.startsWith('/w') || p.startsWith('/h/run/tasks/s')
    const resolve = (p: string) => links.get(p) ?? p
    return {
      readOneByte: async (p) => {
        if (!allowed(resolve(p))) throw eperm()
        return 1
      },
      createExclusive: async (p) => {
        if (!allowed(p)) throw eperm()
      },
      symlink: async (t, p) => {
        links.set(p, t)
      },
      unlink: async (p) => {
        links.delete(p)
      },
      openWrite: async (p) => {
        if (!allowed(p)) throw eperm()
      },
      rename: async (p) => {
        if (!allowed(p)) throw eperm()
      },
      connectUnix: async () => {
        throw eperm()
      },
      connectTcp: async () => {},
      httpGet: async () => 200,
      random: () => 'r',
      ...overrides,
    }
  }

  test('受保护项全部被拒绝、允许项可用时通过；跳过与未验证不计入', async () => {
    const items = await runProbeItems(plan, deniedSystem())
    expect(items.filter((i) => i.ok === false)).toEqual([])
    expect(items.find((i) => i.item === 'connect.orca_port')).toMatchObject({
      actual: 'skipped',
      ok: null,
    })
    expect(items.find((i) => i.item === 'debug.process')).toMatchObject({
      actual: 'unverified',
      ok: null,
    })
    expect(probeRunPassed({ items })).toBe(true)
  })

  test('任一受保护项可读即不通过；允许项不可用同样不通过', async () => {
    const leaky = await runProbeItems(plan, deniedSystem({ connectUnix: async () => {} }))
    expect(leaky.find((i) => i.item === 'connect.orca_socket.1')).toMatchObject({
      actual: 'allow',
      ok: false,
    })
    expect(probeRunPassed({ items: leaky })).toBe(false)
    const noHub = await runProbeItems(
      plan,
      deniedSystem({
        httpGet: async () => {
          throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } })
        },
      }),
    )
    expect(noHub.find((i) => i.item === 'connect.hub')).toMatchObject({ actual: 'deny', ok: false })
    expect(probeRunPassed({ items: noHub })).toBe(false)
  })

  test('受保护项全部不存在（跳过）不能算通过', async () => {
    const enoent = () => Object.assign(new Error('x'), { code: 'ENOENT' })
    const items = await runProbeItems(
      { ...plan, items: plan.items.filter((i) => i.kind === 'read' && i.expected === 'deny') },
      deniedSystem({
        readOneByte: async () => {
          throw enoent()
        },
      }),
    )
    expect(items.every((i) => i.actual === 'skipped')).toBe(true)
    expect(probeRunPassed({ items })).toBe(false)
  })

  test('写探针意外成功时立即删除；符号链接用后删除', async () => {
    const created: string[] = []
    const removed: string[] = []
    const links: string[] = []
    const sys = deniedSystem({
      createExclusive: async (p) => {
        created.push(p)
      },
      symlink: async (_t, p) => {
        links.push(p)
      },
      unlink: async (p) => {
        if (links.includes(p)) links.splice(links.indexOf(p), 1)
        else removed.push(p)
      },
    })
    const items = await runProbeItems(plan, sys)
    expect(items.find((i) => i.item === 'write.config')).toMatchObject({
      actual: 'allow',
      ok: false,
    })
    expect(created.every((p) => p.includes('.raindown-isolation-probe-'))).toBe(true)
    expect(removed.sort()).toEqual(created.sort())
    expect(links).toEqual([])
  })

  test('审查修复 M1：新建成功但删除失败仍记为可写（不是拒绝），说明中写出残留路径', async () => {
    const sys = deniedSystem({
      createExclusive: async () => {},
      unlink: async () => {
        throw eperm()
      },
    })
    const items = await runProbeItems(plan, sys)
    const config = items.find((i) => i.item === 'write.config')
    expect(config).toMatchObject({ actual: 'allow', ok: false })
    expect(config?.detail).toContain('未能删除，残留 /h/config/.raindown-isolation-probe-')
    expect(probeRunPassed({ items })).toBe(false)
  })
})

describe('审查修复', () => {
  test('M1/L1：节点启动清理删除 config/ 下残留的探针文件（只删名字精确匹配的普通文件）', async () => {
    const s = await setup()
    const config = join(s.home, 'config')
    const leftover = join(config, '.raindown-isolation-probe-0123456789abcdef')
    const keepShort = join(config, '.raindown-isolation-probe-0123')
    const keepDir = join(config, '.raindown-isolation-probe-fedcba9876543210')
    await writeFile(leftover, 'x')
    await writeFile(keepShort, 'x')
    await mkdir(keepDir)
    const staleTask = join(runTasksDir(s.home), 'isolation-probe-self-abc')
    await mkdir(join(staleTask, 'dispatch-tokens'), { recursive: true })
    expect(await cleanProbeLeftovers(s.home)).toEqual([leftover])
    expect(existsSync(leftover)).toBe(false)
    expect(existsSync(keepShort)).toBe(true)
    expect(existsSync(keepDir)).toBe(true)
    expect(existsSync(staleTask)).toBe(false)
  })

  test('L4：同一实际施加层只运行一次，结果复用到同层其他组合；只读角色的工作目录预期按各自角色设定', async () => {
    const s = await setup()
    const launched: string[] = []
    const executors: ExecutorInfo[] = [
      codexExec(),
      {
        type: 'codex-orca',
        adapter_capabilities: {
          ...NO_ADAPTER_CAPABILITIES,
          credential_isolation: {
            layers: { 'danger-full-access': 'seatbelt', 'read-only': 'native' },
            enforced: false,
          },
        },
      },
    ]
    const report = await runIsolationProbe({
      ...probeOptions(s, executors),
      launchWrapper: (target, argv) => {
        launched.push(`${target.executor}/${target.setting}`)
        return [...argv]
      },
    })
    expect(launched.length).toBe(1)
    expect(report.runs.map((r) => `${r.executor}/${r.setting}`)).toEqual([
      'codex-exec/danger-full-access',
      'codex-exec/workspace-write',
      'codex-orca/danger-full-access',
      'codex-orca/read-only',
    ])
    const workdir = (setting: string) =>
      report.runs
        .find((r) => r.executor === 'codex-orca' && r.setting === setting)
        ?.items.find((i) => i.item === 'write.workdir')
    expect(workdir('danger-full-access')).toMatchObject({ expected: 'allow', ok: true })
    expect(workdir('read-only')).toMatchObject({ expected: 'deny', actual: 'allow', ok: false })
  })

  test('L6：探针子进程在临时工作目录中运行', async () => {
    const s = await setup()
    const script = join(s.root, 'cwd-child.ts')
    // 替身子进程：把自己的工作目录写到文件，输出合法的空结果。
    const marker = join(s.root, 'cwd.txt')
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, process.cwd())\nprocess.stdout.write('{"items":[]}')\n`,
    )
    await runIsolationProbe({
      ...probeOptions(s),
      launchWrapper: (_t, argv) => [argv[0] as string, script],
    })
    const cwd = await readFile(marker, 'utf8')
    expect(cwd).toContain('raindown-isolation-probe-')
    expect(cwd.startsWith(await realpath(s.tmp))).toBe(true)
  })
})

describe('探针联动（worker-credential-isolation 4.1–4.4）', () => {
  test('启动包装：只有实际施加层为 seatbelt 的目标加上 sandbox-exec -f <同一生成函数写出的配置>', async () => {
    const s = await setup()
    const seen: string[][] = []
    const wrapper = seatbeltProbeLaunchWrapper({ sandboxExec: '/nonexistent/sandbox-exec' })
    const report = await runIsolationProbe({
      ...probeOptions(s, [codexExec(true)]),
      launchWrapper: async (target, argv, launch) => {
        const out = await wrapper(target, argv, launch)
        seen.push(out)
        if (target.applied_layer === 'seatbelt') {
          // 配置与 worker 使用同一个生成函数，内容来自同一份隔离清单。
          const profile = await readFile(out[2] as string, 'utf8')
          const expected = renderSeatbeltProfile(launch.spec)
          expect(expected.ok && expected.data).toBe(profile)
          // 配置在 worker 读写都被拒绝的 state/tasks/ 下（审查第一轮 H2）。
          expect(out[2]).toBe(join(s.home, 'state/tasks', launch.taskId, 'isolation.sb'))
        }
        return out
      },
    })
    // seatbelt 目标以假的 sandbox-exec 启动失败（如实报告无法运行）；native 目标（未施加）恒等运行。
    const bySetting = Object.fromEntries(report.runs.map((r) => [r.setting, r]))
    expect(bySetting['danger-full-access']?.error?.code).toBe('probe_spawn_failed')
    expect(seen.find((a) => a[0] === '/nonexistent/sandbox-exec')?.slice(1, 2)).toEqual(['-f'])
    expect(seen.some((a) => a[0] === process.execPath)).toBe(true)
    // 配置随临时任务目录一起删除。
    const tasks = runTasksDir(s.home)
    expect(existsSync(tasks) ? readdirSync(tasks) : []).toEqual([])
  })

  test('同一施加层的不同执行器（保留的执行器目录不同）分别运行，不复用结果（审查第一轮 L4）', async () => {
    const s = await setup()
    const seatbelt = (type: string): ExecutorInfo => ({
      type,
      adapter_capabilities: {
        ...NO_ADAPTER_CAPABILITIES,
        credential_isolation: {
          layers: { 'danger-full-access': 'seatbelt', 'workspace-write': 'none' },
          enforced: true,
        },
      },
    })
    const launches: Array<{ executor: string; keeps: string[] }> = []
    const report = await runIsolationProbe({
      ...probeOptions(s, [seatbelt('codex-exec'), seatbelt('codex-orca')]),
      launchWrapper: (target, argv, launch) => {
        launches.push({
          executor: target.executor,
          keeps: launch.spec.deny_children_except.map((d) => d.keep),
        })
        return [...argv]
      },
    })
    expect(report.runs.map((r) => r.executor)).toEqual(['codex-exec', 'codex-orca'])
    expect(launches.map((l) => l.executor).sort()).toEqual(['codex-exec', 'codex-orca'])
    for (const l of launches)
      expect(l.keeps.some((k) => k.endsWith(`/run/executors/${l.executor}`))).toBe(true)
  })

  test('开关打开时的能力声明：native 未实现，声明为 none，不探测', () => {
    const declared = effectiveCredentialIsolation(
      {
        layers: {
          'danger-full-access': 'seatbelt',
          'workspace-write': 'native',
          'read-only': 'native',
        },
        enforced: false,
      },
      { enforce: true, platform: 'darwin' },
    )
    expect(declared).toEqual({
      layers: { 'danger-full-access': 'seatbelt', 'workspace-write': 'none', 'read-only': 'none' },
      enforced: true,
    })
    const targets = probeTargets([
      {
        type: 'codex-exec',
        adapter_capabilities: { ...NO_ADAPTER_CAPABILITIES, credential_isolation: declared },
      },
    ])
    expect(targets).toEqual([
      {
        executor: 'codex-exec',
        setting: 'danger-full-access',
        declared_layer: 'seatbelt',
        applied_layer: 'seatbelt',
      },
    ])
    // 开关关闭或非 macOS：原样返回。
    const original = { layers: { x: 'native' }, enforced: false }
    expect(effectiveCredentialIsolation(original, { enforce: false, platform: 'darwin' })).toBe(
      original,
    )
    expect(effectiveCredentialIsolation(original, { enforce: true, platform: 'linux' })).toBe(
      original,
    )
  })

  test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
    'macOS 实测：开关打开时探针以 sandbox-exec 运行，受保护项全部拒绝、允许项可用，通过',
    async () => {
      const s = await setup()
      // 模拟 Orca 的本机端口：一个真实监听的临时 TCP 端口，沙箱外可连、沙箱内应被拒绝。
      const orca = createServer((_req, res) => res.end())
      servers.push(orca)
      await new Promise<void>((resolve) => orca.listen(0, '127.0.0.1', resolve))
      const orcaPort = (orca.address() as AddressInfo).port
      const report = await runIsolationProbe({
        ...probeOptions(s, [codexExec(true)]),
        resolveOrcaPorts: () => [orcaPort],
        launchWrapper: seatbeltProbeLaunchWrapper(),
      })
      const run = report.runs.find((r) => r.setting === 'danger-full-access')
      if (!run) throw new Error('没有 seatbelt 目标的运行')
      expect(run.applied_layer).toBe('seatbelt')
      expect(run.error).toBeUndefined()
      const by = Object.fromEntries(run.items.map((i) => [i.item, i]))
      for (const id of [
        'read.hub_token',
        'read.ledger_db',
        'read.other_task_token',
        'read.age_key',
        'read.hub_token_via_symlink',
        'write.config',
        // 审查第一轮 H1：改名受保护路径的上级目录（探针自建的临时目录树）被拒绝。
        'rename.protected_ancestor',
        // 审查第一轮 H2：本任务实际使用的 seatbelt 配置不可改写。
        'write.own_profile',
        `connect.orca_port.${orcaPort}`,
      ])
        expect({ id, actual: by[id]?.actual }).toEqual({ id, actual: 'deny' })
      expect(by['write.own_profile']?.target).toContain('/state/tasks/isolation-probe-self-')
      // 改名只针对探针自建的临时目录树。
      expect(by['rename.protected_ancestor']?.target).toContain('/run/tasks/isolation-probe-self-')
      expect(by['rename.protected_ancestor']?.target).toEndWith('/rename-probe/a')
      for (const id of ['write.workdir', 'read.own_task_token', 'connect.hub'])
        expect({ id, actual: by[id]?.actual }).toEqual({ id, actual: 'allow' })
      expect(run.passed).toBe(true)
      expect(probeRunPassed(run)).toBe(true)
      expect(JSON.stringify(report)).not.toContain(MARKER)
      const tasks = runTasksDir(s.home)
      expect(existsSync(tasks) ? readdirSync(tasks) : []).toEqual([])
      // 探针的 seatbelt 配置（state/tasks/isolation-probe-*/isolation.sb）连同目录一起删除。
      expect(readdirSync(join(s.home, 'state/tasks'))).toEqual([])
    },
  )

  test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
    'macOS 实测：Orca 端口未解析时 connect.orca_port 记为失败，不能通过',
    async () => {
      const s = await setup()
      const report = await runIsolationProbe({
        ...probeOptions(s, [codexExec(true)]),
        launchWrapper: seatbeltProbeLaunchWrapper(),
      })
      const run = report.runs.find((r) => r.setting === 'danger-full-access')
      const item = run?.items.find((i) => i.item === 'connect.orca_port')
      expect(item).toMatchObject({ actual: 'error', ok: false })
      expect(item?.detail).toContain('Orca 端口未解析')
      expect(run?.passed).toBe(false)
    },
  )
})
