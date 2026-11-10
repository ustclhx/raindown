import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ExecutorInfo,
  type IsolationSpec,
  NO_ADAPTER_CAPABILITIES,
  PROBE_NATIVE_REQUIRED_DENY_ITEMS,
  type ProbePlan,
  probeRunPassed,
  renderSeatbeltProfile,
  runTasksDir,
} from '@raindown/core'
import { IsolationProbeGate, resolveExecutable } from '../src/isolation-gate.ts'
import { type ProbeSystem, runProbeItems } from '../src/isolation-probe/checks.ts'
import {
  cleanProbeLeftovers,
  findOrcaSockets,
  isolationProbeLaunchWrapper,
  NATIVE_PROBE_TMP,
  nativeProbeLaunchWrapper,
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
      {
        item: 'write.shell_startup',
        kind: 'create_file',
        expected: 'deny',
        target: '/h/run/isolation-probe-p/home/.zshenv',
      },
      {
        item: 'write.git_hooks',
        kind: 'create_file',
        expected: 'deny',
        target: '/h/run/isolation-probe-p/repo/.git/hooks/post-checkout',
      },
      {
        item: 'write.registered_git',
        kind: 'write_new',
        expected: 'deny',
        target: '/h/run/isolation-probe-p/repo/.git/objects',
      },
      {
        item: 'write.shared_tmp',
        kind: 'write_new',
        expected: 'deny',
        target: '/tmp-shared',
      },
      {
        item: 'write.git_commondir',
        kind: 'create_file',
        expected: 'deny',
        target: '/c/.git/commondir',
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

  test('预先建好的符号链接（只读工作目录）：只经它读取，不在工作目录新建或删除链接', async () => {
    const touched: string[] = []
    const sys = deniedSystem({
      readOneByte: async (p) => {
        // 预建链接指向 hub.token：经它读取被拒绝。
        if (p === '/w/pre-link' || !p.startsWith('/w')) throw eperm()
        return 1
      },
      symlink: async (_t, p) => {
        touched.push(`symlink ${p}`)
        throw eperm()
      },
      unlink: async (p) => {
        touched.push(`unlink ${p}`)
      },
    })
    const items = await runProbeItems(
      {
        ...plan,
        items: plan.items
          .filter((i) => i.item === 'read.hub_token_via_symlink')
          .map((i) => ({ ...i, link: '/w/pre-link' })),
      },
      sys,
    )
    expect(items).toEqual([
      expect.objectContaining({ item: 'read.hub_token_via_symlink', actual: 'deny', ok: true }),
    ])
    expect(touched).toEqual([])
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
    // 目录写探针用带前缀的随机文件名；指定路径的写探针（4.6）只针对探针自建临时目录中的固定路径。
    const fixed = new Set(
      plan.items.filter((i) => i.kind === 'create_file').map((i) => i.target as string),
    )
    expect(created.every((p) => p.includes('.raindown-isolation-probe-') || fixed.has(p))).toBe(
      true,
    )
    expect(created.filter((p) => fixed.has(p)).sort()).toEqual([...fixed].sort())
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

  test('探针与 worker 用同一个 darwinUserCacheDir（4.5，审查第一轮）：探针配置同样放行 mds 且只能新建普通文件', async () => {
    const s = await setup()
    // 注入的假目录；探针不写其中任何文件。
    const cacheDir = join(s.home, '..', 'C')
    mkdirSync(join(cacheDir, 'mds'), { recursive: true })
    const specs: IsolationSpec[] = []
    await runIsolationProbe({
      ...probeOptions(s, [
        {
          type: 'codex-exec',
          adapter_capabilities: {
            ...NO_ADAPTER_CAPABILITIES,
            credential_isolation: { layers: { 'danger-full-access': 'seatbelt' }, enforced: true },
          },
        },
      ]),
      darwinUserCacheDir: cacheDir,
      launchWrapper: (_target, argv, launch) => {
        specs.push(launch.spec)
        return [...argv]
      },
    })
    const mds = join(realpathSync(cacheDir), 'mds')
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) {
      expect(spec.allow_write).toContain(mds)
      expect(spec.regular_files_only).toEqual([mds])
    }
    expect(readdirSync(join(cacheDir, 'mds'))).toEqual([])
  })

  test('开关打开时的能力声明：seatbelt 与 native 都已实现，按声明探测', () => {
    const declared = effectiveCredentialIsolation(
      {
        layers: {
          'danger-full-access': 'seatbelt',
          'workspace-write': 'native',
          'read-only': 'native',
          other: 'separate_user',
        },
        enforced: false,
      },
      { enforce: true, platform: 'darwin' },
    )
    expect(declared).toEqual({
      layers: {
        'danger-full-access': 'seatbelt',
        'workspace-write': 'native',
        'read-only': 'native',
        other: 'none',
      },
      enforced: true,
    })
    const targets = probeTargets([
      {
        type: 'codex-exec',
        adapter_capabilities: { ...NO_ADAPTER_CAPABILITIES, credential_isolation: declared },
      },
    ])
    expect(targets.map((t) => [t.setting, t.applied_layer])).toEqual([
      ['danger-full-access', 'seatbelt'],
      ['read-only', 'native'],
      ['workspace-write', 'native'],
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
        // 4.6 写白名单：白名单之外的模拟 shell 启动文件、临时仓库（按登记仓库同规则）的 .git/hooks。
        'write.shell_startup',
        'write.git_hooks',
        `connect.orca_port.${orcaPort}`,
      ])
        expect({ id, actual: by[id]?.actual }).toEqual({ id, actual: 'deny' })
      expect(by['write.shell_startup']?.target).toMatch(
        /\/run\/isolation-probe-[0-9a-f]+\/home\/\.zshenv$/,
      )
      // 写类角色：临时仓库 .git/objects 可写（worktree 必需部分）。
      expect(by['write.git_objects']).toMatchObject({ expected: 'allow', actual: 'allow' })
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

describe('native 探针（worker-credential-isolation 5.1）', () => {
  const nativeExec = (): ExecutorInfo => ({
    type: 'codex-exec',
    adapter_capabilities: {
      ...NO_ADAPTER_CAPABILITIES,
      credential_isolation: {
        layers: { 'workspace-write': 'native', 'read-only': 'native' },
        enforced: true,
      },
    },
  })
  /**
   * 假的 codex 可执行文件（sh 脚本，**不运行真实 codex**）：记录参数与 CODEX_HOME；`--version` 打印给定版本；
   * `sandbox … -- <cmd>` 时去掉 `--` 之前的参数后直接运行探针程序（不施加任何沙箱，所以受保护项可读、探针不通过）。
   */
  async function fakeCodex(root: string, version = '0.167.0') {
    const script = join(root, 'fake-codex.sh')
    // 每次调用写一个文件（探针按设置并行运行，追加同一文件会交错）。
    const reports = join(root, 'fake-codex-argv')
    await mkdir(reports)
    await writeFile(
      script,
      [
        '#!/bin/sh',
        `printf '%s\\n' "CODEX_HOME=$CODEX_HOME" "$@" > '${reports}/'$$.txt`,
        `if [ "$1" = "--version" ]; then echo "codex-cli ${version}"; exit 0; fi`,
        'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
        'shift',
        'exec "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    const calls = async () =>
      Promise.all(
        readdirSync(reports).map(async (f) =>
          (await readFile(join(reports, f), 'utf8')).trimEnd().split('\n'),
        ),
      )
    return { script, calls }
  }

  test('与 worker 启动一致：codex 绝对路径、结构一致的临时 CODEX_HOME、-c default_permissions、联网与不联网分别探测；native 专有的项', async () => {
    const s = await setup()
    const fake = await fakeCodex(s.root)
    // 用户的 Codex 目录中有 auth.json：探针临时 CODEX_HOME 中的链接存在，read.codex_home_auth 才能实际尝试。
    await mkdir(join(s.userHome, '.codex'), { recursive: true })
    await writeFile(join(s.userHome, '.codex', 'auth.json'), `${MARKER}-auth\n`)
    // 执行器真实的 CODEX_HOME 已有指向别处的 auth.json 链接（运行中的 worker 在用）：探针不得改动它（审查第二轮）。
    const realCodexHome = join(s.home, 'run', 'executors', 'codex-exec', 'codex-home')
    await mkdir(realCodexHome, { recursive: true })
    await symlink(join(s.root, 'worker-auth.json'), join(realCodexHome, 'auth.json'))
    // workspace-write 的一个角色打开了网络、另一个没有：两组分别探测（审查第二轮 M2）。
    await mkdir(join(s.home, 'config', 'roles'), { recursive: true })
    await writeFile(
      join(s.home, 'config', 'roles', 'netter.yaml'),
      'name: netter\nexecutor: codex-exec\nprompt: p.md\npermissions:\n  sandbox: workspace-write\n  config:\n    sandbox_workspace_write.network_access: true\n',
    )
    await writeFile(
      join(s.home, 'config', 'roles', 'quiet.yaml'),
      'name: quiet\nexecutor: codex-exec\nprompt: p.md\npermissions:\n  sandbox: workspace-write\n',
    )
    await writeFile(join(s.home, 'config', 'roles', 'p.md'), 'x\n')
    const gate = new IsolationProbeGate()
    const report = await runIsolationProbe({
      ...probeOptions(s, [nativeExec()]),
      launchWrapper: nativeProbeLaunchWrapper({
        codexBin: fake.script,
        codexAuthSource: join(s.userHome, '.codex'),
        userHome: s.userHome,
        profileName: 'raindown-probe',
        gate,
      }),
    })
    expect(report.runs.map((r) => [r.setting, r.applied_layer, r.network === true])).toEqual([
      ['read-only', 'native', false],
      ['workspace-write', 'native', false],
      ['workspace-write', 'native', true],
    ])
    expect(readlinkSync(join(realCodexHome, 'auth.json'))).toBe(join(s.root, 'worker-auth.json'))
    const calls = await fake.calls()
    // 版本按可执行文件身份缓存：只检查一次。
    expect(calls.filter((c) => c[1] === '--version')).toHaveLength(1)
    const sandboxes = calls.filter((c) => c[1] === 'sandbox')
    expect(sandboxes).toHaveLength(3)
    const home = realpathSync(s.home)
    let networked = 0
    for (const c of sandboxes) {
      // 探针自己的临时 CODEX_HOME（结构与执行器的一致），不是执行器真实的 CODEX_HOME。
      expect(c[0]).toMatch(
        /^CODEX_HOME=.*\/run\/tasks\/isolation-probe-self-[0-9a-f]+\/codex-home$/,
      )
      const dash = c.indexOf('--')
      const flags = c.slice(2, dash)
      const def = flags.find((f) => f.startsWith('permissions.raindown-probe=')) as string
      expect(def).toBeDefined()
      expect(flags).toContain('default_permissions="raindown-probe"')
      expect(flags).not.toContain('-P')
      expect(def).toContain(`"${home}"="deny"`)
      expect(def).toContain(`"${join(realpathSync(s.userHome), '.codex')}"="deny"`)
      expect(def).toMatch(/dispatch-tokens\/isolation-probe\.token"="read"/)
      // 模拟 home 与改名目录在 raindown-home 之外，不再声明 read 例外。
      expect(def).not.toMatch(/isolation-probe-[0-9a-f]+\/home"="read"/)
      expect(def).not.toMatch(/rename-probe"="read"/)
      expect(c[dash + 2]).toEndWith('child.ts')
      if (/extends=":workspace"/.test(def)) {
        expect(def).toMatch(/\/\.git\/hooks"="read"/)
        expect(def).toMatch(/\/\.git\/config"="read"/)
        if (def.includes('enabled=true')) {
          networked++
          expect(flags).toContain('sandbox_workspace_write.network_access=true')
        } else expect(flags).not.toContain('sandbox_workspace_write.network_access=true')
      } else expect(def).not.toContain('enabled=true')
    }
    expect(networked).toBe(1)
    const ws = report.runs.find((r) => r.setting === 'workspace-write' && !r.network)
    const by = Object.fromEntries((ws?.items ?? []).map((i) => [i.item, i]))
    for (const id of [
      'write.own_profile',
      'write.git_commondir',
      'write.registered_git',
      'write.shared_tmp',
      'connect.hub',
    ])
      expect({ id, actual: by[id]?.actual }).toEqual({ id, actual: 'skipped' })
    for (const id of ['write.git_hooks', 'write.git_config', 'read.codex_home_auth'])
      expect({ id, expected: by[id]?.expected }).toEqual({ id, expected: 'deny' })
    expect(by['read.codex_home_auth']?.target).toMatch(
      /run\/tasks\/isolation-probe-self-[0-9a-f]+\/codex-home\/auth\.json$/,
    )
    // 模拟 home 与改名目录在 raindown-home 之外（与工作目录同级）。
    for (const id of ['write.shell_startup', 'rename.protected_ancestor'])
      expect(by[id]?.target?.startsWith(home)).toBe(false)
    expect(by['write.shell_startup']?.target).toMatch(
      /raindown-isolation-probe-scratch-[^/]+\/home\/\.zshenv$/,
    )
    // 假 codex 不施加沙箱：受保护项可读，探针如实不通过。
    expect(by['read.hub_token']?.actual).toBe('allow')
    expect(ws?.passed).toBe(false)
    const ro = report.runs.find((r) => r.setting === 'read-only')
    const roBy = Object.fromEntries((ro?.items ?? []).map((i) => [i.item, i]))
    expect(roBy['write.workdir']?.expected).toBe('deny')
    expect(by['write.workdir']?.expected).toBe('allow')
    expect(JSON.stringify(report)).not.toContain(MARKER)
    // 闸门：探针记录在 update 之前不生效；联网与不联网分别核对。
    const id = resolveExecutable(fake.script, undefined)
    if (!id) throw new Error('fake codex')
    const now = Date.parse(report.ran_at)
    const passed = {
      ...report,
      runs: report.runs.map((r) => ({
        ...r,
        passed: true,
        items: PROBE_NATIVE_REQUIRED_DENY_ITEMS.map((item) => ({
          item,
          expected: 'deny' as const,
          actual: 'deny' as const,
          ok: true,
        })),
      })),
    }
    gate.update(passed)
    expect(gate.check('codex-exec', 'read-only', { codex: id.key, network: false }, now)).toEqual({
      ok: true,
    })
    for (const network of [false, true])
      expect(gate.check('codex-exec', 'workspace-write', { codex: id.key, network }, now)).toEqual({
        ok: true,
      })
    expect(gate.check('codex-exec', 'read-only', { codex: 'other', network: false }, now).ok).toBe(
      false,
    )
    // 临时任务目录与 /var/tmp 下的探针目录全部删除。
    const tasks = runTasksDir(s.home)
    expect(existsSync(tasks) ? readdirSync(tasks) : []).toEqual([])
    expect(readdirSync(s.tmp)).toEqual([])
  })

  test('闸门：探针运行中暂存的记录在报告生效前不起作用；同一不一致只请求一次重新自检', () => {
    const gate = new IsolationProbeGate()
    let stale = 0
    gate.onStale = () => {
      stale++
    }
    const now = Date.now()
    const report = {
      ran_at: new Date(now).toISOString(),
      macos_version: null,
      runs: [
        {
          executor: 'codex-exec',
          setting: 'read-only',
          declared_layer: 'native',
          applied_layer: 'native',
          passed: true,
          items: PROBE_NATIVE_REQUIRED_DENY_ITEMS.map((item) => ({
            item,
            expected: 'deny' as const,
            actual: 'deny' as const,
            ok: true,
          })),
        },
      ],
    }
    gate.record('codex-exec', 'read-only', { codex: 'A', network: false })
    gate.update(report)
    // 下一轮探针运行中记录了新身份 B：报告生效前仍按 A 核对。
    gate.record('codex-exec', 'read-only', { codex: 'B', network: false })
    expect(gate.check('codex-exec', 'read-only', { codex: 'A', network: false }, now).ok).toBe(true)
    expect(gate.check('codex-exec', 'read-only', { codex: 'B', network: false }, now).ok).toBe(
      false,
    )
    gate.update(report)
    expect(gate.check('codex-exec', 'read-only', { codex: 'B', network: false }, now).ok).toBe(true)
    // 同一不一致（例如 PATH 不同）只请求一次重新自检，重新自检后仍不一致也不再请求。
    for (let i = 0; i < 3; i++)
      gate.check('codex-exec', 'read-only', { codex: 'C', network: false }, now)
    gate.update(report)
    gate.check('codex-exec', 'read-only', { codex: 'C', network: false }, now)
    // 身份 B 在报告生效前不一致请求过一次，C 一次。
    expect(stale).toBe(2)
  })

  test('native 的探针工作目录缺省不在 $TMPDIR 下（nativeTmpDir，缺省 /var/tmp）', async () => {
    const s = await setup()
    const fake = await fakeCodex(s.root)
    const vt = join(s.root, 'vartmp')
    await mkdir(vt)
    const { tmpDir: _t, ...opts } = probeOptions(s, [nativeExec()])
    const report = await runIsolationProbe({
      ...opts,
      nativeTmpDir: vt,
      launchWrapper: nativeProbeLaunchWrapper({
        codexBin: fake.script,
        codexAuthSource: join(s.userHome, '.codex'),
        userHome: s.userHome,
      }),
    })
    for (const run of report.runs)
      expect(run.items.find((i) => i.item === 'write.workdir')?.target).toStartWith(
        realpathSync(vt),
      )
    expect(NATIVE_PROBE_TMP).toBe('/var/tmp')
  })

  test('native 的通过判定：与 seatbelt 相同的读拒绝项为必过项；seatbelt 专有的项缺失或跳过不影响', () => {
    const item = (id: string, actual: 'deny' | 'allow' | 'skipped', expected = 'deny') => ({
      item: id,
      expected: expected as 'deny' | 'allow',
      actual,
      ok: null,
    })
    const items = [
      item('read.hub_token', 'deny'),
      item('read.ledger_db', 'deny'),
      item('read.other_task_token', 'deny'),
      item('write.config', 'deny'),
      item('rename.protected_ancestor', 'deny'),
      item('write.shell_startup', 'deny'),
      item('write.own_profile', 'skipped'),
      item('write.workdir', 'deny'),
    ]
    expect(probeRunPassed({ items, applied_layer: 'native' })).toBe(true)
    // 同样的结果按 seatbelt 判定不通过（缺 seatbelt 的必过项）。
    expect(probeRunPassed({ items, applied_layer: 'seatbelt' })).toBe(false)
    const leaky = items.map((i) =>
      i.item === 'read.hub_token' ? { ...i, actual: 'allow' as const } : i,
    )
    expect(probeRunPassed({ items: leaky, applied_layer: 'native' })).toBe(false)
    const missing = items.filter((i) => i.item !== 'write.shell_startup')
    expect(probeRunPassed({ items: missing, applied_layer: 'native' })).toBe(false)
  })

  test('Codex 版本过低：不运行 sandbox，探针失败并提示（native_codex_unsupported）', async () => {
    const s = await setup()
    const fake = await fakeCodex(s.root, '0.144.4')
    const report = await runIsolationProbe({
      ...probeOptions(s, [nativeExec()]),
      launchWrapper: isolationProbeLaunchWrapper(
        {},
        {
          codexBin: fake.script,
          codexAuthSource: join(s.userHome, '.codex'),
          userHome: s.userHome,
        },
      ),
    })
    expect(report.runs).toHaveLength(2)
    for (const run of report.runs) {
      expect(run.passed).toBe(false)
      expect(run.error?.code).toBe('native_codex_unsupported')
      expect(run.error?.message).toContain('0.144.4')
      expect(run.error?.message).toContain('0.167.0')
    }
    expect((await fake.calls()).some((c) => c[1] === 'sandbox')).toBe(false)
  })

  test('codex sandbox 非零退出：探针失败，原因提示可能不支持 permissions profile', async () => {
    const s = await setup()
    const script = join(s.root, 'fake-codex-fail.sh')
    await writeFile(
      script,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "codex-cli 0.170.1"; exit 0; fi',
        'echo "error: unexpected argument -P" >&2',
        'exit 2',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    const report = await runIsolationProbe({
      ...probeOptions(s, [nativeExec()]),
      launchWrapper: nativeProbeLaunchWrapper({
        codexBin: script,
        codexAuthSource: join(s.userHome, '.codex'),
        userHome: s.userHome,
      }),
    })
    const run = report.runs[0]
    expect(run?.error?.code).toBe('probe_failed')
    expect(run?.error?.message).toContain('permissions profile')
  })
})
