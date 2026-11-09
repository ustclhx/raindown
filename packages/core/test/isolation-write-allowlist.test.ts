import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeIsolationSpec,
  DENY_LAUNCH_OPERATIONS,
  GIT_DENY,
  gitWriteRules,
  type IsolationSpecInput,
  keychainWriteRegex,
  normalizeExtraWrite,
  renderSeatbeltProfile,
  resolveGitLayout,
  taskScratchEnv,
} from '../src/index.ts'

/**
 * 外层 seatbelt 写白名单（add-worker-credential-isolation 4.6 与审查第一轮）。只用临时目录、临时 HOME 与临时 raindown-home；
 * macOS 上用真实 `/usr/bin/sandbox-exec` 包裹 `/bin/sh`、`touch`、`cat` 实测（Linux 跳过实测部分）。
 * 独立 clone 与 git 全流程的实测在 packages/node/test/sealed-clone.test.ts。
 */

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function tempRoot(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

/** 只造 git 目录结构（不运行 git）：登记仓库 `.git/`、它的 linked worktree，以及独立 clone 形状的目录。 */
async function fakeRepos(root: string) {
  const repo = join(root, 'repo')
  const common = join(repo, '.git')
  const wt = join(root, 'wt')
  const admin = join(common, 'worktrees', 'wt')
  const clone = join(root, 'clone')
  for (const d of [
    join(common, 'hooks'),
    join(common, 'objects'),
    admin,
    wt,
    join(clone, '.git', 'objects', 'info'),
    join(clone, '.git', 'hooks'),
  ])
    await mkdir(d, { recursive: true })
  await writeFile(join(admin, 'commondir'), '../..\n')
  await writeFile(join(admin, 'gitdir'), `${join(wt, '.git')}\n`)
  await writeFile(join(common, 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(wt, '.git'), 'gitdir: ../repo/.git/worktrees/wt\n')
  await writeFile(join(clone, '.git', 'HEAD'), 'ref: refs/heads/t\n')
  await writeFile(join(clone, '.git', 'objects', 'info', 'alternates'), `${common}/objects\n`)
  return { repo, common, wt, admin, clone }
}

describe('git 布局与写规则（审查第一轮 H1、H2、M4）', () => {
  test('登记仓库的 linked worktree：git 目录整体挖掉，写类角色也不放行任何部分', async () => {
    const root = await tempRoot('raindown-git-layout-')
    const r = await fakeRepos(root)
    await mkdir(join(r.wt, 'sub'), { recursive: true })
    const layout = await resolveGitLayout(join(r.wt, 'sub'))
    expect(layout).toEqual({
      root: r.wt,
      dotGit: join(r.wt, '.git'),
      dotGitIsFile: true,
      gitDir: r.admin,
      commonDir: r.common,
      trusted: true,
    })
    const w = gitWriteRules({ layout, access: 'write', registeredGitDirs: [r.common] })
    expect(w.allow).toEqual([])
    expect(w.carveOuts).toEqual(expect.arrayContaining([r.common, r.admin]))
    expect(w.carveOutLiterals).toEqual([join(r.wt, '.git')])
    expect(w.deny).toEqual(
      expect.arrayContaining([
        join(r.common, 'config'),
        join(r.common, 'hooks'),
        join(r.common, 'objects', 'info', 'alternates'),
        join(r.admin, 'commondir'),
        join(r.admin, 'gitdir'),
      ]),
    )
  })

  test('独立 clone：只有根目录正是 sealedClone、.git 是真实目录且不是登记仓库时放行其 .git', async () => {
    const root = await tempRoot('raindown-git-layout-')
    const r = await fakeRepos(root)
    const layout = await resolveGitLayout(r.clone)
    const base = { layout, registeredGitDirs: [r.common] }
    const w = gitWriteRules({ ...base, access: 'write', sealedClone: r.clone })
    expect(w.allow).toEqual([join(r.clone, '.git')])
    for (const n of GIT_DENY) expect(w.deny).toContain(join(r.clone, '.git', n))
    expect(w.carveOuts).toContain(r.common)
    // 只读角色、没有声明 sealedClone、声明的不是本目录：都不放行。
    expect(gitWriteRules({ ...base, access: 'read', sealedClone: r.clone }).allow).toEqual([])
    expect(gitWriteRules({ ...base, access: 'write' }).allow).toEqual([])
    expect(gitWriteRules({ ...base, access: 'write', sealedClone: r.repo }).allow).toEqual([])
    // 登记仓库本身被当作 sealedClone：不放行。
    const repoLayout = await resolveGitLayout(r.repo)
    expect(
      gitWriteRules({
        layout: repoLayout,
        access: 'write',
        sealedClone: r.repo,
        registeredGitDirs: [r.common],
      }).allow,
    ).toEqual([])
  })

  test('指针不可信：不可解析、是符号链接、指向任意目录或不回指本 .git 时只挖掉，不放行', async () => {
    const root = await tempRoot('raindown-git-layout-')
    const bad = join(root, 'bad')
    await mkdir(bad)
    await writeFile(join(bad, '.git'), 'not a pointer\n')
    expect(await resolveGitLayout(bad)).toMatchObject({ trusted: false, dotGitIsFile: true })

    const r = await fakeRepos(root)
    const fakeHome = join(root, 'home')
    await mkdir(join(fakeHome, 'objects'), { recursive: true })
    await writeFile(join(r.wt, '.git'), `gitdir: ${fakeHome}\n`)
    expect(await resolveGitLayout(r.wt)).toMatchObject({ trusted: false, gitDir: fakeHome })

    await writeFile(join(r.wt, '.git'), 'gitdir: ../repo/.git/worktrees/wt\n')
    await writeFile(join(r.admin, 'gitdir'), `${join(root, 'elsewhere/.git')}\n`)
    expect(await resolveGitLayout(r.wt)).toMatchObject({ trusted: false })

    const link = join(root, 'link')
    await mkdir(link)
    await symlink(r.common, join(link, '.git'))
    expect(await resolveGitLayout(link)).toMatchObject({ trusted: false })
  })
})

/** 临时 raindown-home 与用户主目录（受保护文件全部伪造）。 */
async function fakeEnv(root: string) {
  const home = join(root, 'raindown-home')
  const userHome = join(root, 'user')
  const codexHome = join(home, 'run/executors/codex-orca/codex-home-sealed')
  for (const d of [
    join(home, 'state'),
    join(home, 'config'),
    join(home, 'run/tasks/t-1/dispatch-tokens'),
    join(home, 'run/tasks/t-1/tmp'),
    join(home, 'run/tasks/t-1/cache'),
    join(codexHome, 'sessions'),
    join(userHome, '.config/sops/age'),
    join(userHome, '.ssh'),
    join(userHome, '.local/bin'),
    join(userHome, '.cache'),
    join(userHome, '.codex'),
    join(userHome, 'Library/Caches'),
    join(userHome, 'Library/LaunchAgents'),
    join(userHome, 'Library/Keychains'),
  ])
    await mkdir(d, { recursive: true })
  await writeFile(join(home, 'state/hub.token'), 'FAKE-HUB-TOKEN-not-a-secret\n')
  await writeFile(join(home, 'run/tasks/t-1/dispatch-tokens/l-1.token'), 'FAKE\n')
  await writeFile(join(userHome, '.config/sops/age/keys.txt'), 'FAKE-AGE\n')
  await writeFile(join(userHome, '.codex/auth.json'), '{"fake":true}\n')
  await writeFile(join(userHome, 'Library/Keychains/login.keychain-db'), 'FAKE-KEYCHAIN\n')
  await symlink(join(userHome, '.codex/auth.json'), join(codexHome, 'auth.json'))
  return { home, userHome, codexHome }
}

const baseInput = (
  e: Awaited<ReturnType<typeof fakeEnv>>,
  cwd: string,
  over: Partial<IsolationSpecInput> = {},
): IsolationSpecInput => ({
  home: e.home,
  taskId: 't-1',
  executor: 'codex-orca',
  executorHome: 'codex-home-sealed',
  cwd,
  access: 'write',
  leaseTokenFile: join(e.home, 'run/tasks/t-1/dispatch-tokens/l-1.token'),
  harnessPaths: [
    {
      path: e.codexHome,
      access: 'write',
      only: {
        subpaths: ['sessions', 'log', 'tmp'],
        files: ['history.jsonl'],
        fileRegex: '[^/]+\\.sqlite(-wal|-shm)?',
      },
      denyWrite: ['auth.json'],
    },
    { path: join(e.codexHome, 'auth.json'), access: 'write', literal: true },
  ],
  hubPort: 7477,
  userHome: e.userHome,
  env: {},
  ...over,
})

describe('computeIsolationSpec：写白名单', () => {
  test('共享的临时与缓存目录不在白名单内；本任务私有目录、harness 运行状态、设备文件在内', async () => {
    const root = await tempRoot('raindown-allowlist-')
    const e = await fakeEnv(root)
    const cwd = join(root, 'work')
    await mkdir(cwd)
    const spec = await computeIsolationSpec(baseInput(e, cwd))
    if (!spec.ok) throw new Error(spec.error.message)
    const s = spec.data
    expect(s.allow_write).toEqual(
      expect.arrayContaining([
        cwd,
        join(e.home, 'run/tasks/t-1'),
        join(e.codexHome, 'sessions'),
        join(e.codexHome, 'tmp'),
        '/dev/fd',
      ]),
    )
    // 独立 CODEX_HOME 内部也是白名单（H3）：目录本身不整体放行。
    expect(s.allow_write).not.toContain(e.codexHome)
    for (const shared of [
      '/private/tmp',
      await realpath(tmpdir()),
      join(e.userHome, '.cache'),
      join(e.userHome, 'Library/Caches'),
      join(e.userHome, 'Library/Keychains'),
    ])
      expect(s.allow_write).not.toContain(shared)
    expect(s.allow_write_literals).toEqual(
      expect.arrayContaining([
        '/dev/null',
        join(e.codexHome, 'history.jsonl'),
        join(e.userHome, '.codex/auth.json'),
      ]),
    )
    expect(s.allow_write_regex).toHaveLength(1)
    expect(s.allow_write_regex[0]).toContain('\\.sqlite')
    // auth.json 链接本身拒绝写（M1）。
    expect(s.write_carve_outs).toContain(join(e.codexHome, 'auth.json'))
    // 持久化位置的纵深防御（L1）：~/.codex 保留 auth.json 链接目标。
    const codex = s.deny_write_except.find((d) => d.path === join(e.userHome, '.codex'))
    expect(codex?.except).toEqual([join(e.userHome, '.codex/auth.json')])
    expect(s.deny_write_except.map((d) => d.path)).toEqual(
      expect.arrayContaining([
        join(e.userHome, '.zshenv'),
        join(e.userHome, '.ssh'),
        join(e.userHome, '.gitconfig'),
      ]),
    )
  })

  test('登录钥匙串只在 allowKeychain 时放行，且只放行 login.keychain-db 与其 .sb-* 临时文件（M3）', async () => {
    const root = await tempRoot('raindown-allowlist-')
    const e = await fakeEnv(root)
    const cwd = join(root, 'work')
    await mkdir(cwd)
    const off = await computeIsolationSpec(baseInput(e, cwd))
    const on = await computeIsolationSpec(baseInput(e, cwd, { allowKeychain: true }))
    if (!off.ok || !on.ok) throw new Error('spec')
    expect(off.data.allow_write_regex).not.toContain(keychainWriteRegex(e.userHome))
    expect(on.data.allow_write_regex).toContain(keychainWriteRegex(e.userHome))
    const re = new RegExp(keychainWriteRegex(e.userHome))
    expect(re.test(join(e.userHome, 'Library/Keychains/login.keychain-db'))).toBe(true)
    expect(re.test(join(e.userHome, 'Library/Keychains/login.keychain-db.sb-1a2b-x'))).toBe(true)
    expect(re.test(join(e.userHome, 'Library/Keychains/other.keychain-db'))).toBe(false)
    expect(re.test(join(e.userHome, 'Library/Keychains/sub/login.keychain-db'))).toBe(false)
  })

  test('harness 的放行与拒绝条目必须是相对路径；文件名正则不能含 / 或引号', async () => {
    const root = await tempRoot('raindown-allowlist-')
    const e = await fakeEnv(root)
    for (const rel of ['../x', '/abs', 'a/../b', '']) {
      for (const h of [
        { path: e.codexHome, access: 'write' as const, denyWrite: [rel] },
        { path: e.codexHome, access: 'write' as const, only: { subpaths: [rel] } },
      ]) {
        const spec = await computeIsolationSpec(baseInput(e, root, { harnessPaths: [h] }))
        expect(!spec.ok && spec.error.code).toBe('invalid_isolation_input')
      }
    }
    for (const fileRegex of ['a/b', 'a"b']) {
      const spec = await computeIsolationSpec(
        baseInput(e, root, {
          harnessPaths: [{ path: e.codexHome, access: 'write', only: { fileRegex } }],
        }),
      )
      expect(!spec.ok && spec.error.code).toBe('invalid_isolation_input')
    }
  })

  test('isolation.extra_write（L1）：大小写折叠与 NFD；拒绝持久化位置、登记仓库、PATH 目录、Application Support', async () => {
    const root = await tempRoot('raindown-allowlist-')
    const e = await fakeEnv(root)
    const cwd = join(root, 'work')
    const repo = join(root, 'repos/app')
    const bin = join(root, 'opt/bin')
    for (const d of [cwd, repo, bin]) await mkdir(d, { recursive: true })
    const input = (extra: string) =>
      baseInput(e, cwd, {
        extraWrite: [extra],
        registeredRepos: [repo],
        env: { PATH: `${bin}:/usr/bin` },
      })
    const ok = await computeIsolationSpec(input(join(e.userHome, 'Library/Developer/DerivedData')))
    if (!ok.ok) throw new Error(ok.error.message)
    expect(ok.data.allow_write).toContain(join(e.userHome, 'Library/Developer/DerivedData'))
    for (const bad of [
      e.userHome,
      root,
      '/',
      join(e.userHome, '.zshenv'),
      join(e.userHome, '.SSH'),
      join(e.userHome, '.ssh/config'),
      join(e.userHome, '.config'),
      join(e.userHome, '.local/bin'),
      join(e.userHome, '.GitConfig'),
      join(e.userHome, 'Library'),
      join(e.userHome, 'Library/Application Support'),
      join(e.userHome, 'Library/Application Support/SomeApp'),
      join(e.userHome, 'Library/LaunchAgents'),
      e.home,
      join(e.home, 'state'),
      repo,
      join(repo, '.git'),
      join(root, 'repos'),
      bin,
      join(bin, 'x'),
      '/usr/bin',
    ]) {
      const r = await computeIsolationSpec(input(bad))
      expect({ bad, code: !r.ok && r.error.code }).toEqual({
        bad,
        code: 'isolation_extra_write_invalid',
      })
    }
    // Unicode NFD：分解形式的名字与组合形式的登记仓库视为同一位置。
    const nfd = await normalizeExtraWrite([join(root, 'café', 'x')], {
      userHome: e.userHome,
      protectedPaths: [],
      registeredRepos: [join(root, 'café')],
    })
    expect(nfd.ok).toBe(false)
    const rel = await normalizeExtraWrite(['relative/x'], {
      userHome: e.userHome,
      protectedPaths: [],
    })
    expect(rel.ok).toBe(false)
  })

  test('按任务私有的临时与缓存环境变量都在本任务目录内（M2）', () => {
    const env = taskScratchEnv('/h', 't-1')
    expect(env.TMPDIR).toBe('/h/run/tasks/t-1/tmp')
    expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe('0')
    for (const [k, v] of Object.entries(env))
      if (k !== 'BUN_RUNTIME_TRANSPILER_CACHE_PATH')
        expect({ k, inside: v.startsWith('/h/run/tasks/t-1/') }).toEqual({ k, inside: true })
    for (const k of [
      'XDG_CACHE_HOME',
      'BUN_INSTALL_CACHE_DIR',
      'npm_config_cache',
      'PNPM_STORE_DIR',
      'npm_config_store_dir',
      'PLAYWRIGHT_BROWSERS_PATH',
      'COREPACK_HOME',
      'PRE_COMMIT_HOME',
    ])
      expect(env[k]).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// macOS 实测
// ---------------------------------------------------------------------------

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const onMac = process.platform === 'darwin' && existsSync(SANDBOX_EXEC)

async function profileFor(root: string, input: IsolationSpecInput, name: string) {
  const spec = await computeIsolationSpec(input)
  if (!spec.ok) throw new Error(spec.error.message)
  const profile = renderSeatbeltProfile(spec.data)
  if (!profile.ok) throw new Error(profile.error.message)
  const path = join(root, `${name}.sb`)
  await writeFile(path, profile.data, { mode: 0o600 })
  return { path, text: profile.data }
}

describe.skipIf(!onMac)('macOS 实测：写白名单', () => {
  const run = (profile: string, cmd: string, cwd: string) =>
    spawnSync(SANDBOX_EXEC, ['-f', profile, '/bin/sh', '-c', cmd], {
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' },
      encoding: 'utf8',
    })

  test('白名单内可写；共享临时与缓存目录、持久化位置、受保护项拒绝；auth.json 可经链接写入但链接本身不能替换', async () => {
    const root = await tempRoot('raindown-allowlist-mac-')
    const e = await fakeEnv(root)
    const cwd = join(root, 'work')
    await mkdir(cwd)
    const { path } = await profileFor(root, baseInput(e, cwd, { allowKeychain: true }), 'p')
    const sh = (cmd: string) => run(path, cmd, cwd)

    for (const p of [
      join(cwd, 'new-file'),
      join(e.home, 'run/tasks/t-1/tmp/x'),
      join(e.home, 'run/tasks/t-1/cache/x'),
      join(e.codexHome, 'sessions/rollout.jsonl'),
      join(e.codexHome, 'history.jsonl'),
      join(e.codexHome, 'state_5.sqlite'),
      join(e.codexHome, 'state_5.sqlite-wal'),
      join(e.userHome, 'Library/Keychains/login.keychain-db.sb-1234-abcd'),
    ]) {
      const r = sh(`echo ok > '${p}' && echo ok > /dev/null`)
      expect({ p, status: r.status, err: r.stderr }).toEqual({ p, status: 0, err: '' })
    }
    // 经链接写入用户的 auth.json（凭证刷新）可行。
    expect(sh(`echo '{"refreshed":true}' > '${join(e.codexHome, 'auth.json')}'`).status).toBe(0)
    expect(readFileSync(join(e.userHome, '.codex/auth.json'), 'utf8')).toContain('refreshed')

    for (const p of [
      join(await realpath(tmpdir()), `raindown-allowlist-probe-${Date.now()}`),
      join('/private/tmp', `raindown-allowlist-probe-${Date.now()}`),
      join(e.userHome, '.cache/x'),
      join(e.userHome, 'Library/Caches/x'),
      join(e.userHome, 'Library/Keychains/other.keychain-db'),
      join(e.userHome, '.zshenv'),
      join(e.userHome, '.gitconfig'),
      join(e.userHome, '.ssh/config'),
      join(e.userHome, '.local/bin/x'),
      join(e.userHome, '.codex/config.toml'),
      join(e.userHome, 'Library/LaunchAgents/x.plist'),
      join(e.codexHome, '.env'),
      join(e.codexHome, 'config.toml'),
      join(e.codexHome, 'models_cache.json'),
      join(e.codexHome, 'shell_snapshots'),
      join(e.home, 'config/x.yaml'),
      join(e.home, 'run/tasks/t-1/dispatch-tokens/l-1.token'),
      join(root, 'outside'),
    ]) {
      const r = sh(`echo PWNED >> '${p}'`)
      expect({ p, status: r.status }).not.toEqual({ p, status: 0 })
      expect(existsSync(p) && readFileSync(p, 'utf8').includes('PWNED')).toBe(false)
    }
    // auth.json 链接本身不能被删除、替换成普通文件或指向别处的链接（M1）。
    const link = join(e.codexHome, 'auth.json')
    for (const cmd of [
      `rm -f '${link}'`,
      `ln -sfn /etc/hosts '${link}'`,
      `mv '${link}' '${link}.bak'`,
    ])
      expect({ cmd, status: sh(cmd).status }).not.toEqual({ cmd, status: 0 })
    expect(await readlink(link)).toBe(join(e.userHome, '.codex/auth.json'))
    expect(sh(`cat '${join(e.home, 'state/hub.token')}'`).status).not.toBe(0)
  })

  test('L5：job-creation、user-preference-write、lsopen、appleevent-send 规则可被本机 sandbox 解析，且不影响常用命令', async () => {
    const root = await tempRoot('raindown-allowlist-mac-')
    const e = await fakeEnv(root)
    const cwd = join(root, 'work')
    await mkdir(cwd)
    const { path, text } = await profileFor(root, baseInput(e, cwd), 'l5')
    for (const op of DENY_LAUNCH_OPERATIONS) expect(text).toContain(`(deny ${op})`)
    const r = run(path, 'echo ok > f && cat f && /usr/bin/true', cwd)
    expect({ status: r.status, out: r.stdout.trim() }).toEqual({ status: 0, out: 'ok' })
  })
})
