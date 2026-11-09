import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalPath,
  computeIsolationSpec,
  credentialIsolationFor,
  describeCredentialIsolation,
  type IsolationSpecInput,
  isWithin,
  NO_ADAPTER_CAPABILITIES,
  roleSandboxSetting,
  type SandboxSetting,
} from '../src/index.ts'

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
      R('raindown-home/brain'),
      R('raindown-home/config'),
      R('raindown-home/state'),
      R('user/.config/sops/age'),
      R('user/Library/Application Support/orca'),
      R('user/Library/LaunchAgents'),
    ].sort()
    // 节点锁与日志位于 state/ 内，被合并。
    expect(r.data.deny_read).toEqual(protectedDirs)
    expect(r.data.deny_write).toEqual(protectedDirs)
    expect(r.data.deny_children_except).toEqual([
      {
        dir: R('raindown-home/run/executors'),
        keep: R('raindown-home/run/executors/codex-orca'),
      },
      { dir: R('raindown-home/run/tasks'), keep: R('raindown-home/run/tasks/t-1') },
    ])
    const realToken = R('raindown-home/run/tasks/t-1/dispatch-tokens/l-1.token')
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
    expect(r.data.deny_read).toContain(join(s.real, 'raindown-home', 'state'))
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
    expect(r.data.deny_read).toContain(join(s.real, 'raindown-home', 'brain'))
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
    expect(credentialIsolationFor(enforced, 'bash-sandbox-off').enforced).toBe(true)
    expect(credentialIsolationFor(enforced, 'bash-sandbox-on').enforced).toBe(false)
    expect(describeCredentialIsolation(caps)).toBe(
      'bash-sandbox-off→seatbelt、bash-sandbox-on→none（仅声明，未施加）',
    )
    expect(describeCredentialIsolation(NO_ADAPTER_CAPABILITIES)).toBe('未上报（按 none 处理）')
  })
})
