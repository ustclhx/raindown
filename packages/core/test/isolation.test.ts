import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalPath,
  computeIsolationSpec,
  credentialIsolationFor,
  describeCredentialIsolation,
  type IsolationSpec,
  type IsolationSpecInput,
  isWithin,
  NO_ADAPTER_CAPABILITIES,
  PROBE_REQUIRED_DENY_ITEMS,
  type ProbeEvidence,
  roleSandboxInfo,
  roleSandboxSetting,
  type SandboxSetting,
} from '../src/index.ts'

/** 按清单判断路径是否不可读（拒绝项，或 deny_children_except 的 dir 子树中 keep 以外的部分）。 */
function readDenied(spec: IsolationSpec, path: string): boolean {
  if (spec.deny_read.some((d) => isWithin(d, path))) return true
  return spec.deny_children_except.some(
    (dc) => path !== dc.dir && isWithin(dc.dir, path) && !isWithin(dc.keep, path),
  )
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 临时根目录：raindown-home、用户主目录与工作目录都在其中，不触碰真实主目录。 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'raindown-isolation-'))
  roots.push(root)
  const home = join(root, 'raindown-home')
  const userHome = join(root, 'user')
  const work = join(root, 'work')
  for (const dir of [join(home, 'state'), join(home, 'config'), userHome, work])
    mkdirSync(dir, { recursive: true })
  const real = realpathSync(root)
  const base: IsolationSpecInput = {
    home,
    taskId: 't-1',
    executor: 'codex-orca',
    cwd: work,
    access: 'write',
    hubPort: 7801,
    userHome,
    resolveOrcaPorts: () => [60211, 10129],
    env: {},
  }
  return { root, real, home, userHome, work, base }
}

describe('computeIsolationSpec', () => {
  test('清单内容：受保护目录、按任务与执行器保留的 run/ 子目录、允许项、端口与调试拒绝项', async () => {
    const s = setup()
    const token = join(s.home, 'run', 'tasks', 't-1', 'dispatch-tokens', 'l-1.token')
    const codexHome = join(s.home, 'run', 'executors', 'codex-orca', 'codex-home')
    const r = await computeIsolationSpec({
      ...s.base,
      leaseTokenFile: token,
      harnessPaths: [{ path: codexHome, access: 'write' }],
    })
    if (!r.ok) throw new Error(r.error.message)
    const R = (p: string) => join(s.real, p)
    const protectedDirs = [
      R('user/.config/sops/age'),
      R('user/Library/Application Support/orca'),
      R('user/Library/LaunchAgents'),
    ].sort()
    const realToken = R('raindown-home/run/tasks/t-1/dispatch-tokens/l-1.token')
    // raindown-home 内的受保护项（state/、config/、brain/、节点锁与日志）由整体拒绝覆盖，不单列。
    expect(r.data.deny_read).toEqual(protectedDirs)
    // 令牌只读：令牌所在的 dispatch-tokens 目录本身也拒绝写（不能经改名父目录绕开只读，#93 N3）。
    const realTokenDir = R('raindown-home/run/tasks/t-1/dispatch-tokens')
    expect(r.data.deny_write).toEqual([...protectedDirs, realTokenDir].sort())
    expect(r.data.deny_children_except).toEqual([
      { dir: R('raindown-home'), keep: R('raindown-home/run') },
      {
        dir: R('raindown-home/run/executors'),
        keep: R('raindown-home/run/executors/codex-orca'),
      },
      { dir: R('raindown-home/run/tasks'), keep: R('raindown-home/run/tasks/t-1') },
    ])
    const realCodex = R('raindown-home/run/executors/codex-orca/codex-home')
    expect(r.data.allow_read).toEqual([realCodex, realToken, R('work')].sort())
    expect(r.data.allow_write).toEqual([realCodex, R('work')].sort())
    expect(r.data.allow_write).not.toContain(realToken)
    expect(r.data.deny_unix_sockets).toEqual([R('user/Library/Application Support/orca')])
    expect(r.data.allow_unix_sockets).toEqual([])
    expect(r.data.allow_local_ports).toEqual([7801])
    expect(r.data.deny_local_ports).toEqual([10129, 60211])
    expect(r.data.orca_ports).toEqual({ status: 'resolved', ports: [10129, 60211] })
    expect(r.data.deny_process_debug).toEqual(['mach-priv-task-port', 'mach-task-name'])
    for (const p of [
      'raindown-home/state/hub.token',
      'raindown-home/config/policies.yaml',
      'raindown-home/brain/index.md',
      'raindown-home/raw/inbox/x.md',
      'raindown-home/future-dir/x',
      'raindown-home/root-file.txt',
      'raindown-home/run/tasks/t-2/dispatch-tokens/l-9.token',
      'raindown-home/run/executors/codex-exec/codex-home/auth.json',
    ])
      expect({ p, denied: readDenied(r.data, R(p)) }).toEqual({ p, denied: true })
    for (const p of [realToken, realCodex, R('work/src/a.ts')])
      expect({ p, denied: readDenied(r.data, p) }).toEqual({ p, denied: false })
  })

  test('只读角色的工作目录只读；age 私钥目录跟随显式的私钥文件位置', async () => {
    const s = setup()
    const r = await computeIsolationSpec({
      ...s.base,
      access: 'read',
      ageKeyFile: join(s.root, 'keys', 'age', 'keys.txt'),
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.allow_read).toEqual([join(s.real, 'work')])
    expect(r.data.allow_write).toEqual([])
    expect(r.data.deny_write).toContain(join(s.real, 'work'))
    expect(r.data.deny_read).toContain(join(s.real, 'keys', 'age'))
    expect(r.data.deny_read).not.toContain(join(s.real, 'user', '.config', 'sops', 'age'))
  })

  test('经符号链接的路径（如 /var → /private/var）一律规范化为真实路径', async () => {
    const s = setup()
    const alias = join(s.root, 'alias')
    symlinkSync(s.root, alias)
    const r = await computeIsolationSpec({
      ...s.base,
      home: join(alias, 'raindown-home'),
      userHome: join(alias, 'user'),
      cwd: join(alias, 'work'),
    })
    if (!r.ok) throw new Error(r.error.message)
    const all = [...r.data.deny_read, ...r.data.allow_read, ...r.data.deny_unix_sockets]
    for (const p of all) {
      expect(p.startsWith(s.real)).toBe(true)
      expect(p.includes('/alias/')).toBe(false)
    }
    expect(readDenied(r.data, join(s.real, 'raindown-home', 'state', 'hub.token'))).toBe(true)
    expect(r.data.deny_children_except[0]).toEqual({
      dir: join(s.real, 'raindown-home'),
      keep: join(s.real, 'raindown-home', 'run'),
    })
    if (process.platform === 'darwin' && existsSync('/private/var')) {
      expect(await canonicalPath('/var/raindown-isolation-does-not-exist')).toBe(
        '/private/var/raindown-isolation-does-not-exist',
      )
      expect(await canonicalPath('/tmp')).toBe('/private/tmp')
    }
  })

  test('不存在的路径按最近的已存在祖先规范化后拼回；悬空链接按目标规范化', async () => {
    const s = setup()
    const alias = join(s.root, 'alias')
    symlinkSync(s.root, alias)
    expect(await canonicalPath(join(alias, 'a', 'b', 'c'))).toBe(join(s.real, 'a', 'b', 'c'))
    const dangling = join(s.root, 'dangling')
    symlinkSync(join(alias, 'later', 'dir'), dangling)
    expect(await canonicalPath(join(dangling, 'x'))).toBe(join(s.real, 'later', 'dir', 'x'))
    // brain/ 与 run/ 都不存在，仍然列出。
    const r = await computeIsolationSpec({ ...s.base, cwd: join(alias, 'work', 'not-yet') })
    if (!r.ok) throw new Error(r.error.message)
    expect(readDenied(r.data, join(s.real, 'raindown-home', 'brain'))).toBe(true)
    expect(r.data.allow_write).toEqual([join(s.real, 'work', 'not-yet')])
  })

  test('允许项落在被拒目录内时报错，不静默生成祖先规则', async () => {
    const s = setup()
    const cases: Array<[string, Partial<IsolationSpecInput>]> = [
      ['工作目录在 state/ 内', { cwd: join(s.home, 'state', 'review', 'n-1', 't-1', 'worktree') }],
      [
        'harness 目录在 config/ 内',
        { harnessPaths: [{ path: join(s.home, 'config', 'codex'), access: 'read' }] },
      ],
      ['经符号链接进入 state/', { cwd: join(s.root, 'link-to-state') }],
      ['工作目录在其他任务的私有目录内', { cwd: join(s.home, 'run', 'tasks', 't-2') }],
      [
        'harness 目录属于其他执行器',
        {
          harnessPaths: [
            { path: join(s.home, 'run', 'executors', 'codex-exec', 'codex-home'), access: 'write' },
          ],
        },
      ],
      [
        '工作目录在 Orca 运行时目录内',
        { cwd: join(s.userHome, 'Library', 'Application Support', 'orca', 'x') },
      ],
    ]
    symlinkSync(join(s.home, 'state'), join(s.root, 'link-to-state'))
    for (const [name, override] of cases) {
      const r = await computeIsolationSpec({ ...s.base, ...override })
      expect({ name, code: r.ok ? 'ok' : r.error.code }).toEqual({
        name,
        code: 'isolation_allow_in_deny',
      })
    }
    // 包含被拒目录的允许项（例如工作目录是 raindown-home 的上级）不报错：生成配置时拒绝写在允许之后。
    expect((await computeIsolationSpec({ ...s.base, cwd: s.root })).ok).toBe(true)
  })

  test('派工令牌必须是本任务私有目录内的文件', async () => {
    const s = setup()
    for (const leaseTokenFile of [
      join(s.home, 'run', 'tasks', 't-2', 'dispatch-tokens', 'l-1.token'),
      join(s.home, 'run', 'tasks', 't-1'),
      join(s.work, 'l-1.token'),
    ]) {
      const r = await computeIsolationSpec({ ...s.base, leaseTokenFile })
      expect(r.ok ? 'ok' : r.error.code).toBe('isolation_token_outside_task_dir')
    }
  })

  test('Orca 端口解析失败时返回未解析标记而不抛错', async () => {
    const s = setup()
    const resolvers: Array<[IsolationSpecInput['resolveOrcaPorts'], RegExp]> = [
      [undefined, /没有提供/],
      [
        () => {
          throw new Error('找不到运行时文件')
        },
        /找不到运行时文件/,
      ],
      [async () => Promise.reject(new Error('lsof 失败')), /lsof 失败/],
      [() => [0, 70000], /非法端口/],
    ]
    for (const [resolveOrcaPorts, reason] of resolvers) {
      const input: IsolationSpecInput = { ...s.base }
      if (resolveOrcaPorts) input.resolveOrcaPorts = resolveOrcaPorts
      else delete input.resolveOrcaPorts
      const r = await computeIsolationSpec(input)
      if (!r.ok) throw new Error(r.error.message)
      expect(r.data.orca_ports.status).toBe('unresolved')
      if (r.data.orca_ports.status === 'unresolved')
        expect(r.data.orca_ports.reason).toMatch(reason)
      expect(r.data.deny_local_ports).toEqual([])
      expect(r.data.allow_local_ports).toEqual([7801])
      // 目录层面的 Orca 拒绝不依赖端口解析。
      expect(r.data.deny_unix_sockets).toHaveLength(1)
    }
  })

  test('中枢端口不合法或与 Orca 端口冲突时报错', async () => {
    const s = setup()
    const bad = await computeIsolationSpec({ ...s.base, hubPort: 0 })
    expect(bad.ok ? 'ok' : bad.error.code).toBe('invalid_hub_port')
    const conflict = await computeIsolationSpec({ ...s.base, resolveOrcaPorts: () => [7801] })
    expect(conflict.ok ? 'ok' : conflict.error.code).toBe('isolation_port_conflict')
  })

  test('isWithin 只按路径段比较', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true)
    expect(isWithin('/a/b', '/a/b/c')).toBe(true)
    expect(isWithin('/a/b', '/a/bc')).toBe(false)
    expect(isWithin('/a/b', '/a')).toBe(false)
  })
})

describe('credential_isolation 能力与角色沙箱设置', () => {
  test('角色沙箱设置按 D1 的表推出，无法确定时为 undefined', () => {
    const cases: Array<[Parameters<typeof roleSandboxSetting>[0], SandboxSetting | undefined]> = [
      [{ executor: 'codex-exec' }, 'read-only'],
      [{ executor: 'codex-exec', permissions: { sandbox: 'workspace-write' } }, 'workspace-write'],
      [
        { executor: 'codex-exec', permissions: { sandbox: 'danger-full-access' } },
        'danger-full-access',
      ],
      [
        {
          executor: 'codex-orca',
          permissions: { approval: 'never', sandbox: 'danger-full-access' },
        },
        'danger-full-access',
      ],
      [{ executor: 'codex-orca', permissions: { sandbox: 'read-only' } }, 'read-only'],
      [
        { executor: 'codex-orca', permissions: { config: { sandbox_mode: 'danger-full-access' } } },
        'danger-full-access',
      ],
      [{ executor: 'codex-orca' }, undefined],
      [{ executor: 'codex-orca', permissions: { sandbox: 'future-mode' } }, undefined],
      [{ executor: 'claude-sdk' }, 'bash-sandbox-off'],
      [{ executor: 'pr-merge' }, 'in-node'],
      [{ executor: 'fake' }, undefined],
    ]
    for (const [role, expected] of cases) expect(roleSandboxSetting(role)).toBe(expected)
  })

  test('声明值查询：未声明的设置与未上报都按 none；enforced 为 false 时不算已施加', () => {
    const caps = {
      ...NO_ADAPTER_CAPABILITIES,
      credential_isolation: {
        layers: { 'bash-sandbox-off': 'seatbelt', 'bash-sandbox-on': 'none' } as const,
        enforced: false,
      },
    }
    expect(credentialIsolationFor(caps, 'bash-sandbox-off')).toEqual({
      reported: true,
      layer: 'seatbelt',
      enforced: false,
    })
    expect(credentialIsolationFor(caps, 'read-only').layer).toBe('none')
    expect(credentialIsolationFor(caps, undefined).layer).toBe('none')
    expect(credentialIsolationFor(NO_ADAPTER_CAPABILITIES, 'read-only')).toEqual({
      reported: false,
      layer: 'none',
      enforced: false,
    })
    const enforced = {
      ...caps,
      credential_isolation: { ...caps.credential_isolation, enforced: true },
    }
    // enforced 由探针决定：没有探针结果、探针不通过、探针属于别的设置、结果过期时都为 false。
    const NOW = Date.parse('2026-11-09T12:00:00.000Z')
    const run = (
      passed: boolean,
      setting = 'bash-sandbox-off',
      ran_at = '2026-11-09T06:00:00.000Z',
    ): ProbeEvidence => ({
      ran_at,
      run: {
        executor: 'claude-sdk',
        setting,
        declared_layer: 'seatbelt',
        applied_layer: 'seatbelt',
        passed,
        items: PROBE_REQUIRED_DENY_ITEMS.map((item) => ({
          item,
          expected: 'deny' as const,
          actual: passed ? ('deny' as const) : ('allow' as const),
          ok: passed,
        })),
      },
    })
    const on = (
      c: typeof caps,
      e: ProbeEvidence | null,
      setting: SandboxSetting = 'bash-sandbox-off',
    ) => credentialIsolationFor(c, setting, e, NOW).enforced
    expect(credentialIsolationFor(enforced, 'bash-sandbox-off').enforced).toBe(false)
    expect(on(enforced, run(false))).toBe(false)
    expect(on(enforced, run(true))).toBe(true)
    expect(on(enforced, run(true, 'bash-sandbox-on'))).toBe(false)
    // 适配器未施加（enforced: false）时，即使探针通过也不算已施加。
    expect(on(caps, run(true))).toBe(false)
    expect(on(enforced, run(true, 'bash-sandbox-on'), 'bash-sandbox-on')).toBe(false)
    // 审查修复 L3：超过 12 小时的结果不算已施加。
    expect(on(enforced, run(true, 'bash-sandbox-off', '2026-11-08T23:59:00.000Z'))).toBe(false)
    // 审查修复 M2：上报的 ok / passed 不可信，按预期与实际重新计算。
    const lying = run(false)
    lying.run.passed = true
    lying.run.items = lying.run.items.map((i) => ({ ...i, ok: true }))
    expect(on(enforced, lying)).toBe(false)
    expect(describeCredentialIsolation(caps)).toBe(
      'bash-sandbox-off→seatbelt、bash-sandbox-on→none（仅声明，未施加）',
    )
    expect(describeCredentialIsolation(NO_ADAPTER_CAPABILITIES)).toBe('未上报（按 none 处理）')
  })
})

describe('审查修复（第一轮）', () => {
  test('M1：taskId / executor 不是单个安全路径段时报错', async () => {
    const s = setup()
    for (const override of [
      { taskId: '..' },
      { taskId: '.' },
      { taskId: 'a/b' },
      { taskId: '' },
      { executor: '..' },
      { executor: 'x/../y' },
      { executorHome: '..' },
    ]) {
      const r = await computeIsolationSpec({ ...s.base, ...override })
      expect({ override, code: r.ok ? 'ok' : r.error.code }).toEqual({
        override,
        code: 'invalid_isolation_input',
      })
    }
  })

  test('M1：本任务目录是指向其他任务目录的符号链接时报错，不放行其他任务的令牌', async () => {
    const s = setup()
    const tasks = join(s.home, 'run', 'tasks')
    mkdirSync(join(tasks, 'B', 'dispatch-tokens'), { recursive: true })
    writeFileSync(join(tasks, 'B', 'dispatch-tokens', 'l-1.token'), 'placeholder')
    symlinkSync(join(tasks, 'B'), join(tasks, 'A'))
    const r = await computeIsolationSpec({
      ...s.base,
      taskId: 'A',
      leaseTokenFile: join(tasks, 'A', 'dispatch-tokens', 'l-1.token'),
    })
    expect(r.ok ? 'ok' : r.error.code).toBe('isolation_keep_symlink')
    // 执行器目录与 run/ 本身同样不能是链接。
    const s2 = setup()
    mkdirSync(join(s2.home, 'run', 'executors', 'codex-exec'), { recursive: true })
    symlinkSync(
      join(s2.home, 'run', 'executors', 'codex-exec'),
      join(s2.home, 'run', 'executors', 'codex-orca'),
    )
    const r2 = await computeIsolationSpec(s2.base)
    expect(r2.ok ? 'ok' : r2.error.code).toBe('isolation_keep_symlink')
    const s3 = setup()
    mkdirSync(join(s3.root, 'elsewhere'))
    symlinkSync(join(s3.root, 'elsewhere'), join(s3.home, 'run'))
    const r3 = await computeIsolationSpec(s3.base)
    expect(r3.ok ? 'ok' : r3.error.code).toBe('isolation_keep_symlink')
  })

  test('M2：工作目录在 state/ 下（如任务说明所在的 state/tasks/<id>/）时返回 isolation_allow_in_deny', async () => {
    const s = setup()
    for (const cwd of [
      join(s.home, 'state', 'tasks', 't-1'),
      join(s.home, 'state', 'review', 'n-1', 't-1', 'worktree'),
    ]) {
      const r = await computeIsolationSpec({ ...s.base, cwd })
      expect(r.ok ? 'ok' : r.error.code).toBe('isolation_allow_in_deny')
    }
    // 审查目录的新位置在本任务私有目录内，可以放行。
    const review = join(s.home, 'run', 'tasks', 't-1', 'review', 'n-1', 'worktree')
    const r = await computeIsolationSpec({ ...s.base, access: 'read', cwd: review })
    expect(r.ok).toBe(true)
  })

  test('L4：存在的遗留 home 一并拒绝；与本 home 相同或互相包含的候选忽略', async () => {
    const s = setup()
    const flowHome = join(s.userHome, 'flow-home')
    mkdirSync(join(flowHome, 'state'), { recursive: true })
    const envHome = join(s.root, 'env-flow-home')
    mkdirSync(envHome)
    const r = await computeIsolationSpec({
      ...s.base,
      env: { FLOW_HOME: envHome, RAINDOWN_HOME: s.home },
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.deny_read).toContain(join(s.real, 'user', 'flow-home'))
    expect(r.data.deny_read).toContain(join(s.real, 'env-flow-home'))
    expect(r.data.deny_read).not.toContain(join(s.real, 'raindown-home'))
    // 不存在的候选（user/raindown-home）不列出。
    expect(r.data.deny_read).not.toContain(join(s.real, 'user', 'raindown-home'))
    // 显式给出 legacyHomes 时只用给出的值。
    const explicit = await computeIsolationSpec({ ...s.base, legacyHomes: [envHome, s.root] })
    if (!explicit.ok) throw new Error(explicit.error.message)
    expect(explicit.data.deny_read).toContain(join(s.real, 'env-flow-home'))
    expect(explicit.data.deny_read).not.toContain(join(s.real, 'user', 'flow-home'))
    expect(explicit.data.deny_read).not.toContain(s.real)
  })

  test('#93 N1：遗留 home 是工作目录的祖先时，错误写明遗留 home 及其来源变量', async () => {
    const s = setup()
    const legacy = join(s.root, 'old-flow-home')
    const cwd = join(legacy, 'worktrees', 'w1')
    mkdirSync(cwd, { recursive: true })
    const r = await computeIsolationSpec({ ...s.base, cwd, env: { FLOW_HOME: legacy } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('isolation_allow_in_deny')
    expect(r.error.message).toContain('遗留 home')
    expect(r.error.message).toContain('FLOW_HOME')
    expect(r.error.details).toMatchObject({
      legacy_home: join(s.real, 'old-flow-home'),
      legacy_source: '环境变量 FLOW_HOME',
    })
  })

  test('#93 N3：令牌直接位于任务目录下时只拒绝写文件本身', async () => {
    const s = setup()
    const token = join(s.home, 'run', 'tasks', 't-1', 'l-1.token')
    const r = await computeIsolationSpec({ ...s.base, leaseTokenFile: token })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.deny_write).toContain(join(s.real, 'raindown-home/run/tasks/t-1/l-1.token'))
    expect(r.data.deny_write).not.toContain(join(s.real, 'raindown-home/run/tasks/t-1'))
  })

  test('L4：age 私钥目录是用户主目录或其上级时返回明确错误', async () => {
    const s = setup()
    for (const ageKeyFile of [join(s.userHome, 'keys.txt'), join(s.root, 'keys.txt')]) {
      const r = await computeIsolationSpec({ ...s.base, ageKeyFile })
      expect(r.ok ? 'ok' : r.error.code).toBe('isolation_age_key_dir_too_broad')
    }
  })

  test('L5：只读 harness 目录与令牌显式写拒绝；codex-exec 读写角色的 harness 子目录互相拒绝', async () => {
    const s = setup()
    const exec = join(s.home, 'run', 'executors', 'codex-exec')
    const readHome = join(exec, 'codex-read-home')
    const r = await computeIsolationSpec({
      ...s.base,
      executor: 'codex-exec',
      executorHome: 'codex-read-home',
      access: 'read',
      harnessPaths: [
        { path: readHome, access: 'write' },
        { path: join(s.root, 'claude-config'), access: 'read' },
      ],
    })
    if (!r.ok) throw new Error(r.error.message)
    const R = (p: string) => join(s.real, p)
    expect(r.data.deny_write).toContain(R('claude-config'))
    expect(r.data.deny_write).not.toContain(
      R('raindown-home/run/executors/codex-exec/codex-read-home'),
    )
    expect(r.data.deny_children_except).toContainEqual({
      dir: R('raindown-home/run/executors/codex-exec'),
      keep: R('raindown-home/run/executors/codex-exec/codex-read-home'),
    })
    expect(
      readDenied(r.data, R('raindown-home/run/executors/codex-exec/codex-home/sessions/x.jsonl')),
    ).toBe(true)
    // 读角色不能把写角色的目录当作 harness 目录放行。
    const crossed = await computeIsolationSpec({
      ...s.base,
      executor: 'codex-exec',
      executorHome: 'codex-read-home',
      harnessPaths: [{ path: join(exec, 'codex-home'), access: 'write' }],
    })
    expect(crossed.ok ? 'ok' : crossed.error.code).toBe('isolation_allow_in_deny')
    // 可写路径不能位于只读路径内。
    const nested = await computeIsolationSpec({
      ...s.base,
      access: 'read',
      harnessPaths: [{ path: join(s.work, '.cache'), access: 'write' }],
    })
    expect(nested.ok ? 'ok' : nested.error.code).toBe('isolation_allow_in_deny')
  })

  test('L6：config.sandbox_mode 的 TOML 引号去掉后比较；profile 间接指定时无法确定并给出原因', () => {
    expect(
      roleSandboxSetting({
        executor: 'codex-orca',
        permissions: { config: { sandbox_mode: '"danger-full-access"' } },
      }),
    ).toBe('danger-full-access')
    expect(
      roleSandboxSetting({
        executor: 'codex-orca',
        permissions: { config: { sandbox_mode: "'workspace-write'" } },
      }),
    ).toBe('workspace-write')
    expect(
      roleSandboxSetting({ executor: 'codex-orca', permissions: { sandbox: '"read-only"' } }),
    ).toBe('read-only')
    const viaProfile = roleSandboxInfo({
      executor: 'codex-orca',
      permissions: { config: { profile: 'dev', sandbox_mode: 'danger-full-access' } },
    })
    expect(viaProfile.setting).toBeUndefined()
    expect(viaProfile.reason).toContain('config.profile')
    expect(roleSandboxInfo({ executor: 'codex-orca' }).reason).toContain('由 Codex 自行决定')
    // codex-exec 总是传 -s，profile 不影响。
    expect(
      roleSandboxSetting({ executor: 'codex-exec', permissions: { config: { profile: 'x' } } }),
    ).toBe('read-only')
  })

  test('L3：未知施加层按 none，展示时标明未知', () => {
    const caps = {
      ...NO_ADAPTER_CAPABILITIES,
      credential_isolation: { layers: { 'read-only': 'future-layer' }, enforced: true },
    }
    expect(credentialIsolationFor(caps, 'read-only')).toEqual({
      reported: true,
      layer: 'none',
      enforced: false,
    })
    expect(describeCredentialIsolation(caps)).toContain('future-layer（未知，按 none）')
  })
})
