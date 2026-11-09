import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeIsolationSpec,
  defaultTmpDirs,
  GIT_COMMON_WRITE_DIRS,
  gitWriteRules,
  type IsolationSpecInput,
  normalizeExtraWrite,
  renderSeatbeltProfile,
  resolveGitLayout,
} from '../src/index.ts'

/**
 * 外层 seatbelt 写白名单（add-worker-credential-isolation 4.6）。只用临时目录、临时 HOME 与临时 raindown-home；
 * macOS 上用真实 `/usr/bin/sandbox-exec` 包裹 `/bin/sh`、`git`、`touch` 实测（Linux 跳过实测部分）。
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

/** 只造 git 目录结构（不运行 git）：主仓库 `.git/` 与一个 linked worktree。 */
async function fakeRepo(root: string) {
  const repo = join(root, 'repo')
  const common = join(repo, '.git')
  const wt = join(root, 'wt')
  const admin = join(common, 'worktrees', 'wt')
  for (const d of [join(common, 'hooks'), join(common, 'objects'), admin, wt])
    await mkdir(d, { recursive: true })
  await writeFile(join(admin, 'commondir'), '../..\n')
  await writeFile(join(admin, 'gitdir'), `${join(wt, '.git')}\n`)
  await writeFile(join(common, 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(wt, '.git'), 'gitdir: ../repo/.git/worktrees/wt\n')
  return { repo, common, wt, admin }
}

describe('git 布局与写规则', () => {
  test('linked worktree：解析 gitdir 与 commondir（相对路径），只放行必需部分', async () => {
    const root = await tempRoot('raindown-git-layout-')
    const r = await fakeRepo(root)
    await mkdir(join(r.wt, 'sub'), { recursive: true })
    const layout = await resolveGitLayout(join(r.wt, 'sub'))
    expect(layout).toEqual({
      root: r.wt,
      dotGit: join(r.wt, '.git'),
      dotGitIsFile: true,
      gitDir: r.admin,
      commonDir: r.common,
      worktreeDirs: [r.admin],
      trusted: true,
    })
    if (!layout) throw new Error('unreachable')
    const w = gitWriteRules(layout, 'write')
    expect(w.carveOuts).toEqual([r.admin, r.common])
    expect(w.carveOutLiterals).toEqual([join(r.wt, '.git')])
    expect(w.allow).toEqual([...GIT_COMMON_WRITE_DIRS.map((d) => join(r.common, d)), r.admin])
    expect(w.allowLiterals).toContain(join(r.common, 'packed-refs'))
    expect(w.allowLiterals).not.toContain(join(r.common, 'config'))
    expect(w.allow.some((p) => p.endsWith('/hooks'))).toBe(false)
    expect(w.deny).toEqual(
      expect.arrayContaining([
        join(r.common, 'config'),
        join(r.common, 'hooks'),
        join(r.admin, 'commondir'),
        join(r.admin, 'gitdir'),
        join(r.admin, 'config.worktree'),
      ]),
    )
    // 只读角色：仍挖掉 git 目录、拒绝 hooks 与 config，但不放行任何 git 写入。
    const ro = gitWriteRules(layout, 'read')
    expect(ro.allow).toEqual([])
    expect(ro.allowLiterals).toEqual([])
    expect(ro.carveOuts).toEqual(w.carveOuts)
  })

  test('主 worktree：.git 是目录，每个 worktree 的状态文件直接位于共享目录', async () => {
    const root = await tempRoot('raindown-git-layout-')
    const r = await fakeRepo(root)
    const layout = await resolveGitLayout(r.repo)
    expect(layout).toMatchObject({ dotGitIsFile: false, gitDir: r.common, commonDir: r.common })
    if (!layout) throw new Error('unreachable')
    const w = gitWriteRules(layout, 'write')
    expect(w.carveOuts).toContain(r.common)
    expect(w.allowLiterals).toEqual(
      expect.arrayContaining([
        join(r.common, 'HEAD'),
        join(r.common, 'index'),
        join(r.common, 'index.lock'),
      ]),
    )
    expect(w.allowLiterals).not.toContain(join(r.common, 'config'))
  })

  test('指针不可信：不可解析、是符号链接、gitdir 不在 <common>/worktrees/ 下或不回指本 .git 时只挖掉，不放行', async () => {
    const root = await tempRoot('raindown-git-layout-')
    const bad = join(root, 'bad')
    await mkdir(bad)
    await writeFile(join(bad, '.git'), 'not a pointer\n')
    const unparsable = await resolveGitLayout(bad)
    expect(unparsable).toMatchObject({ trusted: false, dotGitIsFile: true })
    if (!unparsable) throw new Error('unreachable')
    const u = gitWriteRules(unparsable, 'write')
    expect(u.carveOutLiterals).toEqual([join(bad, '.git')])
    expect(u.allow).toEqual([])
    expect(u.allowLiterals).toEqual([])

    // 之前未隔离的进程把指针改成指向“用户主目录”：不能按它放行整个目录。
    const r = await fakeRepo(root)
    const fakeHome = join(root, 'home')
    await mkdir(join(fakeHome, 'objects'), { recursive: true })
    await writeFile(join(r.wt, '.git'), `gitdir: ${fakeHome}\n`)
    const hijacked = await resolveGitLayout(r.wt)
    expect(hijacked).toMatchObject({ trusted: false, gitDir: fakeHome })
    if (!hijacked) throw new Error('unreachable')
    expect(gitWriteRules(hijacked, 'write').allow).toEqual([])

    // gitdir 位于 <common>/worktrees/ 下但回指别的 .git：不可信。
    await writeFile(join(r.wt, '.git'), 'gitdir: ../repo/.git/worktrees/wt\n')
    await writeFile(join(r.admin, 'gitdir'), `${join(root, 'elsewhere/.git')}\n`)
    expect(await resolveGitLayout(r.wt)).toMatchObject({ trusted: false })

    // .git 是符号链接。
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
  for (const d of [
    join(home, 'state'),
    join(home, 'config'),
    join(home, 'run/tasks/t-1/dispatch-tokens'),
    join(home, 'run/executors/codex-orca/codex-home/rules'),
    join(userHome, 'Library/LaunchAgents'),
    join(userHome, '.config/sops/age'),
    join(userHome, '.ssh'),
    join(userHome, '.local/bin'),
    join(userHome, '.cache'),
    join(userHome, 'Library/Caches'),
    join(root, 'tmp'),
  ])
    await mkdir(d, { recursive: true })
  await writeFile(join(home, 'state/hub.token'), 'FAKE-HUB-TOKEN-not-a-secret\n')
  await writeFile(join(home, 'run/tasks/t-1/dispatch-tokens/l-1.token'), 'FAKE\n')
  await writeFile(join(userHome, '.config/sops/age/keys.txt'), 'FAKE-AGE\n')
  return { home, userHome, codexHome: join(home, 'run/executors/codex-orca/codex-home') }
}

const baseInput = (
  root: string,
  e: Awaited<ReturnType<typeof fakeEnv>>,
  cwd: string,
): IsolationSpecInput => ({
  home: e.home,
  taskId: 't-1',
  executor: 'codex-orca',
  executorHome: 'codex-home',
  cwd,
  access: 'write',
  leaseTokenFile: join(e.home, 'run/tasks/t-1/dispatch-tokens/l-1.token'),
  harnessPaths: [
    { path: e.codexHome, access: 'write', denyWrite: ['config.toml', 'rules'] },
    { path: join(e.codexHome, 'auth.json'), access: 'write', literal: true },
  ],
  hubPort: 7477,
  userHome: e.userHome,
  env: {},
  tmpDirs: [join(root, 'tmp')],
  cacheDirs: [join(e.userHome, '.cache'), join(e.userHome, 'Library/Caches')],
})

describe('computeIsolationSpec：写白名单', () => {
  test('白名单内容：工作目录、本任务目录、harness、临时、缓存、设备；git 与 harness 配置挖掉；令牌仍只读', async () => {
    const root = await tempRoot('raindown-allowlist-')
    const e = await fakeEnv(root)
    const r = await fakeRepo(root)
    // auth.json 是指向“用户 Codex 目录”的链接：放行的是链接目标这一个文件。
    await mkdir(join(e.userHome, '.codex'))
    await writeFile(join(e.userHome, '.codex/auth.json'), '{}')
    await symlink(join(e.userHome, '.codex/auth.json'), join(e.codexHome, 'auth.json'))
    const spec = await computeIsolationSpec(baseInput(root, e, r.wt))
    if (!spec.ok) throw new Error(spec.error.message)
    const s = spec.data
    expect(s.allow_write).toEqual(
      expect.arrayContaining([
        r.wt,
        join(e.home, 'run/tasks/t-1'),
        e.codexHome,
        join(root, 'tmp'),
        join(e.userHome, '.cache'),
        join(e.userHome, 'Library/Caches'),
        '/dev/fd',
      ]),
    )
    expect(s.allow_write).not.toContain(e.userHome)
    expect(s.allow_write_literals).toEqual(
      expect.arrayContaining(['/dev/null', '/dev/tty', join(e.userHome, '.codex/auth.json')]),
    )
    expect(s.allow_write.some((p) => p.endsWith('/.codex'))).toBe(false)
    expect(s.write_carve_outs).toEqual(
      expect.arrayContaining([
        r.common,
        join(e.codexHome, 'config.toml'),
        join(e.codexHome, 'rules'),
      ]),
    )
    expect(s.write_carve_out_literals).toEqual([join(r.wt, '.git')])
    expect(s.allow_write_git).toContain(join(r.common, 'objects'))
    expect(s.allow_write_git).toContain(r.admin)
    expect(s.deny_write).toEqual(
      expect.arrayContaining([
        join(e.home, 'run/tasks/t-1/dispatch-tokens'),
        join(r.common, 'hooks'),
        join(r.common, 'config'),
        join(r.admin, 'commondir'),
      ]),
    )
  })

  test('只读角色：工作目录不放行写，git 不放行任何部分', async () => {
    const root = await tempRoot('raindown-allowlist-')
    const e = await fakeEnv(root)
    const r = await fakeRepo(root)
    const spec = await computeIsolationSpec({ ...baseInput(root, e, r.wt), access: 'read' })
    if (!spec.ok) throw new Error(spec.error.message)
    expect(spec.data.allow_write).not.toContain(r.wt)
    expect(spec.data.deny_write).toContain(r.wt)
    expect(spec.data.allow_write_git).toEqual([])
    expect(spec.data.allow_write_git_literals).toEqual([])
  })

  test('harness 拒绝写条目必须是相对路径', async () => {
    const root = await tempRoot('raindown-allowlist-')
    const e = await fakeEnv(root)
    for (const rel of ['../x', '/abs', 'a/../b', '']) {
      const spec = await computeIsolationSpec({
        ...baseInput(root, e, join(root, 'tmp')),
        harnessPaths: [{ path: e.codexHome, access: 'write', denyWrite: [rel] }],
      })
      expect(!spec.ok && spec.error.code).toBe('invalid_isolation_input')
    }
  })

  test('isolation.extra_write：放行合法的绝对路径；受保护路径、持久化位置、用户主目录及其祖先报错', async () => {
    const root = await tempRoot('raindown-allowlist-')
    const e = await fakeEnv(root)
    const ok = await computeIsolationSpec({
      ...baseInput(root, e, join(root, 'tmp')),
      extraWrite: [join(e.userHome, 'Library/Developer/Xcode/DerivedData')],
    })
    if (!ok.ok) throw new Error(ok.error.message)
    expect(ok.data.allow_write).toContain(join(e.userHome, 'Library/Developer/Xcode/DerivedData'))
    for (const bad of [
      e.userHome,
      root,
      '/',
      join(e.userHome, '.zshenv'),
      join(e.userHome, '.ssh'),
      join(e.userHome, '.ssh/config'),
      join(e.userHome, '.config'),
      join(e.userHome, '.local/bin'),
      join(e.userHome, '.gitconfig'),
      join(e.userHome, '.config/git'),
      join(e.userHome, '.config/sops/age'),
      join(e.userHome, 'Library'),
      join(e.userHome, 'Library/LaunchAgents'),
      e.home,
      join(e.home, 'state'),
      join(e.home, 'run'),
    ]) {
      const r = await computeIsolationSpec({
        ...baseInput(root, e, join(root, 'tmp')),
        extraWrite: [bad],
      })
      expect({ bad, code: !r.ok && r.error.code }).toEqual({
        bad,
        code: 'isolation_extra_write_invalid',
      })
    }
    const rel = await normalizeExtraWrite(['relative/x'], e.userHome, [])
    expect(rel.ok).toBe(false)
  })

  test('缺省临时目录含 /private/tmp 与本用户 TMPDIR（realpath）', async () => {
    const dirs = await defaultTmpDirs()
    expect(dirs).toContain('/private/tmp')
    expect(dirs).toContain(await realpath(tmpdir()))
  })
})

// ---------------------------------------------------------------------------
// macOS 实测
// ---------------------------------------------------------------------------

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const hasGit = spawnSync('git', ['--version']).status === 0
const onMac = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && hasGit

/** 真实 git 仓库：本地远端、主仓库、本任务的 linked worktree 与另一个 worktree。git 只在临时目录中运行。 */
async function realRepos(root: string, userHome: string) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: userHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  }
  const sh = (cmd: string, cwd = root) => {
    const r = spawnSync('/bin/sh', ['-c', cmd], { cwd, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`)
  }
  sh('git init -q --bare -b main remote.git && git init -q -b main repo')
  const repo = join(root, 'repo')
  sh(
    'echo a > a && git add a && git commit -qm init && git remote add origin ../remote.git && git push -q origin main && git config gc.autoDetach false',
    repo,
  )
  sh('git worktree add -q ../wt -b task && git worktree add -q ../wt-other -b other', repo)
  // 远端多一个提交，供 fetch / merge / rebase。
  sh(
    'git clone -q remote.git up && cd up && echo z > z && git add z && git commit -qm z && git push -q origin main',
  )
  return {
    env,
    repo,
    common: join(repo, '.git'),
    wt: join(root, 'wt'),
    other: join(root, 'wt-other'),
  }
}

/**
 * git 的 stderr，去掉已知可接受的一行：`git gc` 结束时 `update-server-info` 更新 `.git/info/refs`（只供 dumb HTTP 服务使用）
 * 被拒绝，git 只告警、退出码仍为 0。`info/` 不放行（`info/attributes` 等会被沙箱外的 git 读取）。
 */
const gitErr = (stderr: string) =>
  stderr
    .split('\n')
    .filter(
      (l) => l.trim() && !/^error: unable to update .*info\/refs: Operation not permitted$/.test(l),
    )
    .join('\n')

async function profileFor(root: string, input: IsolationSpecInput, name: string) {
  const spec = await computeIsolationSpec(input)
  if (!spec.ok) throw new Error(spec.error.message)
  const profile = renderSeatbeltProfile(spec.data)
  if (!profile.ok) throw new Error(profile.error.message)
  const path = join(root, `${name}.sb`)
  await writeFile(path, profile.data, { mode: 0o600 })
  return path
}

describe.skipIf(!onMac)('macOS 实测：写白名单', () => {
  const sandboxed = (profile: string, cmd: string, cwd: string, env: Record<string, string>) =>
    spawnSync(SANDBOX_EXEC, ['-f', profile, '/bin/sh', '-c', cmd], { cwd, env, encoding: 'utf8' })

  test('linked worktree：白名单内可写、白名单外拒绝，git 全流程可用，hooks 与 config 不可写', async () => {
    const root = await tempRoot('raindown-allowlist-mac-')
    const e = await fakeEnv(root)
    const g = await realRepos(root, e.userHome)
    const profile = await profileFor(root, baseInput(root, e, g.wt), 'wt')
    const run = (cmd: string) => sandboxed(profile, cmd, g.wt, g.env)

    // 白名单内：工作目录、临时目录、缓存目录、CODEX_HOME 的运行状态、本任务目录、设备文件。
    for (const p of [
      join(g.wt, 'new-file'),
      join(root, 'tmp/x'),
      join(e.userHome, '.cache/x'),
      join(e.userHome, 'Library/Caches/x'),
      join(e.codexHome, 'sessions-x'),
      join(e.home, 'run/tasks/t-1/x'),
    ]) {
      const r = run(`echo ok > '${p}' && echo ok > /dev/null`)
      expect({ p, status: r.status, err: r.stderr }).toEqual({ p, status: 0, err: '' })
    }

    // 白名单外与受保护项：拒绝，且文件没有被创建或改动。
    for (const p of [
      join(e.userHome, '.zshenv'),
      join(e.userHome, '.zshrc'),
      join(e.userHome, '.gitconfig'),
      join(e.userHome, '.ssh/config'),
      join(e.userHome, '.local/bin/x'),
      join(e.userHome, 'Library/LaunchAgents/x.plist'),
      join(g.common, 'hooks/post-checkout'),
      join(g.common, 'config'),
      join(g.common, 'info/exclude'),
      join(g.common, 'worktrees/wt/commondir'),
      join(g.common, 'worktrees/wt/gitdir'),
      join(g.common, 'worktrees/wt/config.worktree'),
      join(g.common, 'worktrees/wt-other/HEAD'),
      join(g.wt, '.git'),
      join(g.other, 'x'),
      join(e.codexHome, 'config.toml'),
      join(e.codexHome, 'rules/x.rules'),
      join(e.home, 'config/x.yaml'),
      join(e.home, 'run/tasks/t-1/dispatch-tokens/l-1.token'),
      join(root, 'outside'),
    ]) {
      const before = existsSync(p) ? readFileSync(p, 'utf8') : undefined
      const r = run(`echo PWNED >> '${p}'`)
      expect({ p, status: r.status }).not.toEqual({ p, status: 0 })
      expect(r.stderr).toContain('Operation not permitted')
      expect(existsSync(p) ? readFileSync(p, 'utf8') : undefined).toBe(before)
    }

    // git 全流程（实测确定的最小集合）。
    for (const cmd of [
      'echo b > b && git add b && git commit -qm b',
      'git branch b2 && git checkout -q -b b3 && git checkout -q task',
      'git fetch -q origin',
      'git merge -q --no-edit origin/main',
      'echo c >> b && git stash -q && git stash pop -q && git commit -qam c',
      'git tag t1 && git tag -d t1 >/dev/null',
      'git rebase -q origin/main',
      'git pack-refs --all',
      'git -c gc.auto=1 -c gc.autoPackLimit=1 gc --auto -q',
      'git gc -q',
      // 删除分支时 git 顺带删除其 `branch.<名>` 配置节，写 .git/config 被拒绝只告警，退出码仍为 0。
      'git branch -D b2 -q 2>/dev/null',
      // 不设置上游的新建分支可用（见下方：设置上游要写 .git/config）。
      'git checkout -q --no-track -b t2 origin/main && git checkout -q task',
      'git commit --amend -qm amended',
      'git reset -q --hard HEAD~1 && git reset -q --hard ORIG_HEAD',
      'git status --porcelain >/dev/null && git log --oneline -3 >/dev/null',
    ]) {
      const r = run(cmd)
      expect({ cmd, status: r.status, err: gitErr(r.stderr) }).toEqual({ cmd, status: 0, err: '' })
    }
    // 需要写共享配置或其他 worktree 的操作被拒绝。设置上游（`checkout -b x origin/main` 的自动跟踪、`--set-upstream-to`、
    // `push -u` 的跟踪配置）要写 .git/config，同样失败（已知限制，见 docs/executors.md「写白名单」）。
    for (const cmd of [
      'git checkout -q -b t3 origin/main',
      'git branch --set-upstream-to=origin/main',
      'git worktree add -q ../wt3 -b x',
      'git config core.hooksPath /tmp/x',
      'git config --global user.name x',
    ]) {
      const r = run(cmd)
      expect({ cmd, status: r.status }).not.toEqual({ cmd, status: 0 })
    }
    expect(readFileSync(join(g.common, 'config'), 'utf8')).not.toContain('hooksPath')

    // 改名工作目录（使挖掉的 .git 指针不再匹配）被拒绝；受保护文件仍不可读。
    const mv = run(`/bin/mv '${g.wt}' '${root}/tmp/wt-moved'`)
    expect(mv.status).not.toBe(0)
    expect(existsSync(g.wt)).toBe(true)
    expect(run(`cat '${join(e.home, 'state/hub.token')}'`).status).not.toBe(0)
    // 对照：沙箱外同一写入可行（拒绝来自配置）。
    expect(spawnSync('/usr/bin/touch', [join(root, 'outside')]).status).toBe(0)
  })

  test('主 worktree（工作目录就是登记仓库）：git 可用，hooks 与 config 不可写', async () => {
    const root = await tempRoot('raindown-allowlist-mac-')
    const e = await fakeEnv(root)
    const g = await realRepos(root, e.userHome)
    const profile = await profileFor(root, baseInput(root, e, g.repo), 'main')
    const run = (cmd: string) => sandboxed(profile, cmd, g.repo, g.env)
    for (const cmd of [
      'echo b > b && git add b && git commit -qm b',
      'git checkout -q -b b3 && git checkout -q main',
      'git fetch -q origin && git merge -q --no-edit origin/main',
      'git stash list >/dev/null',
      'git gc -q',
    ]) {
      const r = run(cmd)
      expect({ cmd, status: r.status, err: gitErr(r.stderr) }).toEqual({ cmd, status: 0, err: '' })
    }
    for (const p of [
      join(g.common, 'hooks/pre-commit'),
      join(g.common, 'config'),
      join(g.common, 'worktrees/wt/HEAD'),
    ]) {
      const r = run(`echo PWNED >> '${p}'`)
      expect({ p, status: r.status }).not.toEqual({ p, status: 0 })
    }
    expect(run(`/bin/mv '${g.common}' '${g.repo}/.git2'`).status).not.toBe(0)
  })

  test('只读角色：工作目录与 git 都不可写，临时目录仍可写', async () => {
    const root = await tempRoot('raindown-allowlist-mac-')
    const e = await fakeEnv(root)
    const g = await realRepos(root, e.userHome)
    const profile = await profileFor(root, { ...baseInput(root, e, g.wt), access: 'read' }, 'read')
    const run = (cmd: string) => sandboxed(profile, cmd, g.wt, g.env)
    expect(run('git log --oneline -1 >/dev/null && cat a >/dev/null').status).toBe(0)
    expect(run('echo x > new-file').status).not.toBe(0)
    expect(run('echo b > /dev/null && git commit -q --allow-empty -m x').status).not.toBe(0)
    expect(run(`echo x > '${join(root, 'tmp/x')}'`).status).toBe(0)
  })
})
