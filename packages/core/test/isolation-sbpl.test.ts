import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeIsolationSpec,
  type IsolationSpec,
  renderSeatbeltProfile,
  sbplString,
} from '../src/index.ts'

/**
 * 外层 seatbelt 配置生成（add-worker-credential-isolation 4.1）：快照、注入与（仅 macOS）`sandbox-exec` 实测。
 * 只用临时目录与伪造的受保护文件。
 */

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

const SPEC: IsolationSpec = {
  deny_read: [
    '/Users/u/.config/sops/age',
    '/Users/u/Library/Application Support/orca',
    '/Users/u/Library/LaunchAgents',
  ],
  deny_write: [
    '/Users/u/.config/sops/age',
    '/Users/u/Library/Application Support/orca',
    '/Users/u/Library/LaunchAgents',
    '/Users/u/raindown-home/run/tasks/t-1/dispatch-tokens',
  ],
  deny_children_except: [
    { dir: '/Users/u/raindown-home', keep: '/Users/u/raindown-home/run' },
    { dir: '/Users/u/raindown-home/run/tasks', keep: '/Users/u/raindown-home/run/tasks/t-1' },
  ],
  allow_read: ['/Users/u/raindown-home/run/tasks/t-1/dispatch-tokens/l-1.token', '/Users/u/work'],
  allow_write: ['/Users/u/work', '/Users/u/raindown-home/run/tasks/t-1'],
  allow_write_literals: ['/dev/null', '/Users/u/.codex/auth.json'],
  write_carve_outs: [
    '/Users/u/repo/.git',
    '/Users/u/raindown-home/run/executors/codex-exec/codex-home/config.toml',
  ],
  write_carve_out_literals: ['/Users/u/work/.git'],
  allow_write_regex: ['^/Users/u/Library/Keychains/login\\.keychain-db(\\.sb-[^/]+)?$'],
  allow_write_git: ['/Users/u/clone/.git'],
  regular_files_only: ['/private/var/folders/xx/yy/C/mds'],
  deny_write_except: [
    { path: '/Users/u/.codex', except: ['/Users/u/.codex/auth.json'] },
    { path: '/Users/u/.zshenv', except: [] },
  ],
  deny_unix_sockets: ['/Users/u/Library/Application Support/orca'],
  allow_unix_sockets: [],
  allow_local_ports: [7477],
  deny_local_ports: [60211],
  orca_ports: { status: 'resolved', ports: [60211] },
  deny_process_debug: ['mach-priv-task-port', 'mach-task-name'],
}

describe('SBPL 生成', () => {
  test('快照：allow default + 默认写拒绝 + 写白名单 + 显式拒绝在后', () => {
    const r = renderSeatbeltProfile(SPEC)
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data).toMatchSnapshot()
    // 写白名单（4.6）：默认写拒绝在任何放行之前；受保护项的拒绝都在全部放行之后（同一操作后写的规则优先：拒绝优先）。
    const defaultDeny = r.data.indexOf('(deny file-write*)\n')
    expect(defaultDeny).toBeGreaterThan(0)
    expect(defaultDeny).toBeLessThan(r.data.indexOf('(allow file-'))
    const lastAllow = r.data.lastIndexOf('(allow ')
    const protectedStart = r.data.indexOf(';; 2. ')
    expect(lastAllow).toBeLessThan(protectedStart)
    expect(r.data.indexOf('(deny file-read*')).toBeGreaterThan(protectedStart)
    // 挖掉的 git 目录在白名单放行之后、git 必需部分放行之前。
    const carve = r.data.indexOf('(subpath "/Users/u/repo/.git")')
    expect(carve).toBeGreaterThan(
      r.data.indexOf('(subpath "/Users/u/raindown-home/run/tasks/t-1")'),
    )
    expect(carve).toBeLessThan(r.data.indexOf('(subpath "/Users/u/clone/.git")'))
    expect(r.data).toContain('(regex #"^/dev/ttys[0-9]+$")')
    expect(r.data).toContain('(literal "/Users/u/work/.git")')
    expect(r.data.startsWith(';;')).toBe(true)
    expect(r.data).toContain('(version 1)\n(allow default)\n')
    expect(r.data).toContain('(deny mach-priv-task-port (target others))')
    expect(r.data).toContain('(deny mach-task-name (target others))')
  })

  test('Orca 端口未解析时不生成端口规则；其他本机端口从不拒绝；空列表不生成空规则', () => {
    const r = renderSeatbeltProfile({
      ...SPEC,
      deny_local_ports: [],
      orca_ports: { status: 'unresolved', reason: '没有提供 Orca 端口解析' },
      allow_write: [],
      allow_write_literals: [],
      write_carve_outs: [],
      write_carve_out_literals: [],
      allow_write_git: [],
      regular_files_only: [],
      allow_write_regex: [],
      deny_write_except: [],
      deny_read: [],
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data).not.toContain('(remote ip "*:')
    expect(r.data).not.toContain('localhost:*')
    // 没有过滤器的 (deny file-read*) 会拒绝一切：绝不能出现。唯一的例外是有意的默认写拒绝（写白名单），恰好一行。
    expect(r.data.match(/^\(deny file-write\*\)$/gm)).toHaveLength(1)
    const rules = r.data
      .replace('(allow default)', '')
      .replace('(deny file-write*)\n', '')
      // 第 7 节的拒绝项（派生任务、偏好设置等）本身就是不带过滤器的整体拒绝。
      .replace(/^\(deny (?:job-creation|user-preference-write|lsopen|appleevent-send)\)$/gm, '')
    expect(rules).not.toMatch(/^\((?:allow|deny) [a-z*-]+(?: [a-z*-]+)*\)$/m)
    expect(rules).not.toContain('(allow file-write*')
  })

  test.each([
    ['引号', '/tmp/a"b'],
    ['反斜杠', '/tmp/a\\b'],
    ['括号与注入', '/tmp/x")(allow default)(deny file-read* (subpath "/'],
    ['反斜杠在引号前', '/tmp/x\\")(allow default'],
    ['分号注释', '/tmp/a;b'],
  ])('注入：路径含%s时结构不变', (_name, evil) => {
    const r = renderSeatbeltProfile({ ...SPEC, deny_read: [evil], deny_write: [] })
    if (!r.ok) throw new Error(r.error.message)
    // 只有一行 (allow default)（字面量内的同名文本不构成规则），且字面量按转义规则还原后等于原路径。
    expect(r.data.match(/^\(allow default\)$/gm)).toHaveLength(1)
    const lit = sbplString(evil)
    expect(r.data).toContain(`(deny file-read*\n  (subpath ${lit}))`)
    // 解析字面量：去掉两侧引号，按 \\ 与 \" 还原。
    const inner = lit.slice(1, -1)
    expect(/(^|[^\\])(\\\\)*"/.test(inner)).toBe(false)
    expect(inner.replace(/\\(["\\])/g, '$1')).toBe(evil)
    // 写白名单的各字段同样转义（4.6）。
    for (const key of [
      'allow_write',
      'allow_write_literals',
      'write_carve_outs',
      'write_carve_out_literals',
      'allow_write_git',
      'regular_files_only',
    ] as const) {
      const w = renderSeatbeltProfile({ ...SPEC, [key]: [evil] })
      if (!w.ok) throw new Error(w.error.message)
      expect(w.data.match(/^\(allow default\)$/gm)).toHaveLength(1)
      expect(w.data).toContain(lit)
    }
    for (const deny_write_except of [
      [{ path: evil, except: [] }],
      [{ path: '/x', except: [evil] }],
    ]) {
      const w = renderSeatbeltProfile({ ...SPEC, deny_write_except })
      if (!w.ok) throw new Error(w.error.message)
      expect(w.data.match(/^\(allow default\)$/gm)).toHaveLength(1)
      expect(w.data).toContain(lit)
    }
  })

  test('正则过滤器：含双引号、控制字符或不以 ^/ 开头时拒绝生成（审查第一轮）', () => {
    for (const bad of ['^/a"b', '^/a\nb', 'a', '/a']) {
      const r = renderSeatbeltProfile({ ...SPEC, allow_write_regex: [bad] })
      expect(!r.ok && r.error.code).toBe('isolation_profile_invalid_path')
    }
  })

  test.each([
    ['换行', '/tmp/a\nb'],
    ['回车', '/tmp/a\rb'],
    ['NUL', '/tmp/a\u0000b'],
    ['制表符', '/tmp/a\tb'],
    ['DEL', '/tmp/a\u007fb'],
    ['C1', '/tmp/a\u0085b'],
  ])('路径含%s时返回错误、不生成配置', (_name, evil) => {
    for (const spec of [
      { ...SPEC, deny_read: [evil] },
      { ...SPEC, allow_read: [evil] },
      { ...SPEC, deny_children_except: [{ dir: '/tmp', keep: evil }] },
      { ...SPEC, deny_unix_sockets: [evil] },
      { ...SPEC, allow_write_literals: [evil] },
      { ...SPEC, write_carve_outs: [evil] },
      { ...SPEC, write_carve_out_literals: [evil] },
      { ...SPEC, allow_write_git: [evil] },
      { ...SPEC, deny_write_except: [{ path: evil, except: [] }] },
      { ...SPEC, deny_write_except: [{ path: '/x', except: [evil] }] },
      { ...SPEC, allow_write_regex: [`^${evil}`] },
    ]) {
      const r = renderSeatbeltProfile(spec)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('isolation_profile_invalid_path')
    }
  })

  test('相对路径、非法端口、非法操作名返回错误', () => {
    const rel = renderSeatbeltProfile({ ...SPEC, deny_read: ['relative/path'] })
    expect(!rel.ok && rel.error.code).toBe('isolation_profile_invalid_path')
    const port = renderSeatbeltProfile({ ...SPEC, deny_local_ports: [70000] })
    expect(!port.ok && port.error.code).toBe('isolation_profile_invalid_port')
    const op = renderSeatbeltProfile({ ...SPEC, deny_process_debug: ['x) (allow default'] })
    expect(!op.ok && op.error.code).toBe('isolation_profile_invalid_operation')
  })
})

/** 临时 raindown-home 与用户主目录，受保护文件全部伪造。路径含引号、括号与反斜杠，验证转义在真实 seatbelt 中有效。 */
async function fakeHome(weird: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raindown-sbpl-')))
  roots.push(root)
  const base = weird ? join(root, 'we"ird) (allow default\\x') : root
  const home = join(base, 'raindown-home')
  const userHome = join(base, 'user')
  const cwd = join(base, 'work')
  for (const d of [
    join(home, 'state'),
    join(home, 'config'),
    join(home, 'run/tasks/t-1/dispatch-tokens'),
    join(home, 'run/tasks/t-other/dispatch-tokens'),
    join(userHome, '.config/sops/age'),
    join(userHome, 'Library/LaunchAgents'),
    join(home, 'run/executors/codex-exec/codex-home'),
    join(home, 'run/tasks/t-1/tmp'),
    cwd,
  ])
    await mkdir(d, { recursive: true })
  const files = {
    hubToken: join(home, 'state/hub.token'),
    policies: join(home, 'config/policies.yaml'),
    otherToken: join(home, 'run/tasks/t-other/dispatch-tokens/l-2.token'),
    ownToken: join(home, 'run/tasks/t-1/dispatch-tokens/l-1.token'),
    ageKey: join(userHome, '.config/sops/age/keys.txt'),
    workFile: join(cwd, 'README.md'),
  }
  for (const [k, p] of Object.entries(files)) await writeFile(p, `FAKE-${k}-not-a-secret\n`)
  const spec = await computeIsolationSpec({
    home,
    taskId: 't-1',
    executor: 'codex-exec',
    executorHome: 'codex-home',
    cwd,
    access: 'write',
    leaseTokenFile: files.ownToken,
    harnessPaths: [{ path: join(home, 'run/executors/codex-exec/codex-home'), access: 'write' }],
    hubPort: 7477,
    userHome,
    env: {},
  })
  if (!spec.ok) throw new Error(spec.error.message)
  const profile = renderSeatbeltProfile(spec.data)
  if (!profile.ok) throw new Error(profile.error.message)
  const profilePath = join(root, 'isolation.sb')
  await writeFile(profilePath, profile.data, { mode: 0o600 })
  return { root, base, home, userHome, cwd, files, profilePath }
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const onMac = process.platform === 'darwin' && existsSync(SANDBOX_EXEC)

describe.skipIf(!onMac)('macOS 实测：sandbox-exec 包裹 /bin/cat、/usr/bin/touch', () => {
  test.each([false, true])(
    '受保护文件被拒绝、允许文件可读（路径含特殊字符：%s）',
    async (weird) => {
      const s = await fakeHome(weird)
      const cat = (path: string) =>
        spawnSync(SANDBOX_EXEC, ['-f', s.profilePath, '/bin/cat', path], { encoding: 'utf8' })
      for (const p of [s.files.hubToken, s.files.policies, s.files.otherToken, s.files.ageKey]) {
        const r = cat(p)
        expect(r.status).not.toBe(0)
        expect(r.stdout).toBe('')
        expect(r.stderr).toContain('Operation not permitted')
      }
      for (const p of [s.files.ownToken, s.files.workFile]) {
        const r = cat(p)
        expect(r.status).toBe(0)
        expect(r.stdout).toContain('FAKE-')
      }
      const touch = (path: string) =>
        spawnSync(SANDBOX_EXEC, ['-f', s.profilePath, '/usr/bin/touch', path], { encoding: 'utf8' })
      expect(touch(join(s.home, 'config/new.yaml')).status).not.toBe(0)
      expect(touch(s.files.ownToken).status).not.toBe(0)
      expect(touch(join(s.cwd, 'new-file')).status).toBe(0)
      // 不在沙箱内时同一文件可读（对照：拒绝来自配置）。
      expect(spawnSync('/bin/cat', [s.files.hubToken], { encoding: 'utf8' }).status).toBe(0)
    },
  )
})

describe.skipIf(!onMac)('macOS 实测：改名祖先目录不能绕过拒绝（审查第一轮 H1）', () => {
  const run = (profile: string, argv: string[]) =>
    spawnSync(SANDBOX_EXEC, ['-f', profile, ...argv], { encoding: 'utf8' })

  test.each([false, true])(
    '受保护路径的任何一级祖先都不能改名（路径含特殊字符：%s）',
    async (weird) => {
      const s = await fakeHome(weird)
      const moves: Array<[string, string, string]> = [
        [s.home, `${s.home}2`, join(`${s.home}2`, 'state/hub.token')],
        [join(s.home, 'state'), join(s.home, 'state2'), join(s.home, 'state2/hub.token')],
        [
          join(s.home, 'run/tasks'),
          join(s.home, 'run/t2'),
          join(s.home, 'run/t2/t-other/dispatch-tokens/l-2.token'),
        ],
        [join(s.home, 'run'), join(s.home, 'run2'), join(s.home, 'run2/tasks/t-other')],
        [
          join(s.userHome, '.config/sops'),
          join(s.userHome, '.config/s2'),
          join(s.userHome, '.config/s2/age/keys.txt'),
        ],
        [
          join(s.userHome, '.config'),
          join(s.userHome, 'c2'),
          join(s.userHome, 'c2/sops/age/keys.txt'),
        ],
        [s.userHome, `${s.userHome}2`, join(`${s.userHome}2`, '.config/sops/age/keys.txt')],
        [s.base, `${s.base}-moved`, join(`${s.base}-moved`, 'raindown-home/state/hub.token')],
        // 本任务目录（派工令牌目录的上级）也不能整体搬走。
        [join(s.home, 'run/tasks/t-1'), join(s.cwd, 't-1'), join(s.cwd, 't-1/dispatch-tokens')],
      ]
      for (const [from, to, probe] of moves) {
        const mv = run(s.profilePath, ['/bin/mv', from, to])
        expect({ from, status: mv.status }).not.toEqual({ from, status: 0 })
        expect(existsSync(from)).toBe(true)
        expect(existsSync(probe)).toBe(false)
      }
      expect(run(s.profilePath, ['/bin/cat', s.files.hubToken]).status).not.toBe(0)
    },
  )

  test('工作目录、CODEX_HOME、本任务目录、临时与缓存目录中新建文件、目录、符号链接与改名仍然可用', async () => {
    const s = await fakeHome(false)
    const codexHome = join(s.home, 'run/executors/codex-exec/codex-home')
    const ownTask = join(s.home, 'run/tasks/t-1')
    for (const dir of [s.cwd, codexHome, ownTask, join(s.home, 'run/tasks/t-1/tmp')]) {
      for (const argv of [
        ['/usr/bin/touch', join(dir, 'new-file')],
        ['/bin/mkdir', join(dir, 'new-dir')],
        ['/bin/ln', '-s', join(dir, 'new-file'), join(dir, 'new-link')],
        ['/bin/mv', join(dir, 'new-dir'), join(dir, 'renamed-dir')],
        ['/bin/rm', join(dir, 'new-link')],
      ]) {
        const r = run(s.profilePath, argv)
        expect({ argv, status: r.status, stderr: r.stderr }).toEqual({
          argv,
          status: 0,
          stderr: '',
        })
      }
    }
  })
})
