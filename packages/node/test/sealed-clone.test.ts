import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { computeIsolationSpec, renderSeatbeltProfile } from '@raindown/core'
import { createSafeGit, verifyGitLocation } from '../src/safe-git.ts'
import {
  ensureSealedClone,
  removeSealedClone,
  sealedCloneDir,
  sealedCloneRecordPath,
  verifySealedClone,
} from '../src/sealed-clone.ts'
import { type GitFixture, gitFixture, ORIGIN_URL, TASK_BRANCH } from './git-fixture.ts'

/**
 * 每个任务独立的 git clone（add-worker-credential-isolation 审查第一轮 H1、H2、M4；第一步方案）。
 * 全部在临时目录、临时 HOME 中进行（git 夹具不读写用户的 git 配置）；macOS 上另用真实 `/usr/bin/sandbox-exec` 实测。
 */

const fixtures: GitFixture[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})

function setup() {
  const fx = gitFixture()
  fixtures.push(fx)
  const home = join(fx.root, 'raindown-home')
  mkdirSync(join(home, 'state'), { recursive: true })
  const opts = { env: fx.env }
  return { fx, home, opts }
}

/** 目录下全部普通文件的 inode（不跟随链接）。 */
function inodes(dir: string): Map<number, string> {
  const out = new Map<number, string>()
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.set(lstatSync(p).ino, p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

const commitIn = (fx: GitFixture, dir: string, file: string) => {
  writeFileSync(join(dir, file), `${file}\n`)
  fx.git(['add', file], dir)
  fx.git(['commit', '-q', '-m', file], dir)
}

describe('ensureSealedClone', () => {
  test('--shared：对象经 alternates 只读引用登记仓库，不硬链接；origin 与上游、reflog 配置由节点写入', async () => {
    const { fx, home, opts } = setup()
    const r = await ensureSealedClone({
      home,
      taskId: 't-1',
      repo: fx.repo,
      base: 'origin/main',
      branch: 't-1',
      ...opts,
    })
    if (!r.ok) throw new Error(r.error.message)
    const clone = realpathSync(sealedCloneDir(home, 't-1'))
    expect(r.data).toMatchObject({ fresh: true, path: clone, branch: 't-1' })
    expect(r.data.alternates).toBe(join(realpathSync(fx.repo), '.git', 'objects'))
    const cfg = (k: string) => fx.git(['config', '--get', k], clone).trim()
    expect(cfg('remote.origin.url')).toBe(ORIGIN_URL)
    expect(cfg('branch.t-1.remote')).toBe('origin')
    expect(cfg('branch.t-1.merge')).toBe('refs/heads/t-1')
    expect(cfg('push.default')).toBe('current')
    expect(cfg('core.logAllRefUpdates')).toBe('false')
    expect(fx.git(['remote'], clone).trim()).toBe('origin')
    expect(fx.git(['rev-parse', '--abbrev-ref', 'HEAD'], clone).trim()).toBe('t-1')
    // 记录在 worker 读写都被拒绝的 state/ 下。
    expect(existsSync(sealedCloneRecordPath(home, 't-1'))).toBe(true)
    // worker 新建的对象只在 clone 中；与登记仓库没有共用的 inode（缺省 --local 会硬链接）。
    commitIn(fx, clone, 'a.txt')
    const main = inodes(join(fx.repo, '.git', 'objects'))
    for (const [ino, p] of inodes(join(clone, '.git', 'objects')))
      expect({ p, shared: main.has(ino) }).toEqual({ p, shared: false })
    // 幂等：已有的 clone 核对通过后复用。
    const again = await ensureSealedClone({
      home,
      taskId: 't-1',
      repo: fx.repo,
      base: 'origin/main',
      branch: 't-1',
      ...opts,
    })
    expect(again.ok && again.data.fresh).toBe(false)
  })

  test('dissociate：完整复制对象，没有 alternates，同样不硬链接', async () => {
    const { fx, home, opts } = setup()
    const r = await ensureSealedClone({
      home,
      taskId: 't-1',
      repo: fx.repo,
      base: 'origin/main',
      branch: 't-1',
      dissociate: true,
      ...opts,
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.alternates).toBeNull()
    expect(existsSync(join(r.data.path, '.git/objects/info/alternates'))).toBe(false)
    const main = inodes(join(fx.repo, '.git', 'objects'))
    const copy = inodes(join(r.data.path, '.git', 'objects'))
    expect(copy.size).toBeGreaterThan(0)
    for (const [ino, p] of copy) expect({ p, shared: main.has(ino) }).toEqual({ p, shared: false })
  })

  test('迁移：登记仓库已有同名本地分支（共享 worktree 中的提交）时从它开始', async () => {
    const { fx, home, opts } = setup()
    commitIn(fx, fx.worktree, 'from-old-worktree.txt')
    const r = await ensureSealedClone({
      home,
      taskId: 't-1',
      repo: fx.repo,
      base: 'origin/main',
      branch: TASK_BRANCH,
      ...opts,
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(existsSync(join(r.data.path, 'from-old-worktree.txt'))).toBe(true)
  })

  test('目录已存在但没有记录时不覆盖（其中可能有未推送的提交）', async () => {
    const { fx, home, opts } = setup()
    mkdirSync(sealedCloneDir(home, 't-1'), { recursive: true })
    const r = await ensureSealedClone({
      home,
      taskId: 't-1',
      repo: fx.repo,
      base: 'origin/main',
      branch: 't-1',
      ...opts,
    })
    expect(!r.ok && r.error.code).toBe('sealed_clone_invalid')
  })
})

describe('审查第二轮', () => {
  test('H1：.git/commondir 重定向——核对失败；已取得的安全 git 固定 GIT_COMMON_DIR，不读伪造的配置', async () => {
    const { fx, home, opts } = setup()
    const r = await ensureSealedClone({
      home,
      taskId: 't-1',
      repo: fx.repo,
      base: 'origin/main',
      branch: 't-1',
      ...opts,
    })
    if (!r.ok) throw new Error(r.error.message)
    const loc = await verifyGitLocation(r.data.path, [fx.repo], { home })
    if (!loc.ok) throw new Error(loc.reason)
    const git = createSafeGit(loc, { env: fx.env })
    // 模拟复现：伪造的 .git/evil（refs、HEAD、对象链回），config 改写远端；再写 commondir 指向它。
    const gitDir = join(r.data.path, '.git')
    const evil = join(gitDir, 'evil')
    mkdirSync(join(evil, 'refs', 'heads'), { recursive: true })
    writeFileSync(join(evil, 'HEAD'), readFileSync(join(gitDir, 'HEAD')))
    symlinkSync(join(gitDir, 'objects'), join(evil, 'objects'))
    writeFileSync(
      join(evil, 'config'),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://evil.invalid/x.git\n',
    )
    writeFileSync(join(gitDir, 'commondir'), 'evil\n')
    // 对照：不固定时普通 git 确实改读伪造的配置。
    expect(fx.git(['config', '--get', 'remote.origin.url'], r.data.path)).toBe(
      'https://evil.invalid/x.git\n',
    )
    expect(await git.run(['config', '--get', 'remote.origin.url'])).toBe(`${ORIGIN_URL}\n`)
    const v = await verifySealedClone(home, 't-1')
    expect(!v.ok && v.error.code).toBe('sealed_clone_invalid')
    expect((await verifyGitLocation(r.data.path, [fx.repo], { home })).ok).toBe(false)
    // 回收时不取回、不删除（交给用户处理）。
    expect((await removeSealedClone(home, 't-1', { fetchBack: true, ...opts })).ok).toBe(false)
    expect(existsSync(r.data.path)).toBe(true)
    for (const name of ['config.worktree', 'worktrees']) {
      const { fx: fx2, home: home2 } = setup()
      const c = await ensureSealedClone({
        home: home2,
        taskId: 't-2',
        repo: fx2.repo,
        base: 'origin/main',
        branch: 't-2',
        env: fx2.env,
      })
      if (!c.ok) throw new Error(c.error.message)
      if (name === 'worktrees') mkdirSync(join(c.data.path, '.git', name))
      else writeFileSync(join(c.data.path, '.git', name), '[core]\n')
      const bad = await verifySealedClone(home2, 't-2')
      expect({ name, code: !bad.ok && bad.error.code }).toEqual({
        name,
        code: 'sealed_clone_invalid',
      })
    }
  })

  test('M2：检出 worker 写过的分支时不运行用户配置的 filter（.gitattributes 引用），也不做 LFS smudge', async () => {
    const { fx, home, opts } = setup()
    const marker = join(fx.root, 'filter-ran')
    // 用户（夹具的临时 HOME）的全局配置里有一个会执行命令的 filter driver。
    const gitconfig = join(fx.env.HOME as string, '.gitconfig')
    writeFileSync(
      gitconfig,
      `${readFileSync(gitconfig, 'utf8')}[filter "evil"]\n\tsmudge = touch ${marker}; cat\n\tclean = cat\n`,
    )
    // worker 之前在任务分支上提交了引用它的 .gitattributes（迁移：共享 worktree 中的提交）。
    writeFileSync(join(fx.worktree, '.gitattributes'), '*.txt filter=evil\n')
    writeFileSync(join(fx.worktree, 'a.txt'), 'hello\n')
    fx.git(['-c', 'filter.evil.clean=cat', 'add', '.gitattributes', 'a.txt'], fx.worktree)
    fx.git(['commit', '-q', '-m', 'attrs'], fx.worktree)
    expect(existsSync(marker)).toBe(false)
    const r = await ensureSealedClone({
      home,
      taskId: 't-1',
      repo: fx.repo,
      base: 'origin/main',
      branch: TASK_BRANCH,
      ...opts,
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(readFileSync(join(r.data.path, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(existsSync(marker)).toBe(false)
    // 对照：不中和时普通检出确实会运行这个 filter。
    execFileSync('rm', ['-f', join(fx.worktree, 'a.txt')])
    fx.git(['checkout', '--', 'a.txt'], fx.worktree)
    expect(existsSync(marker)).toBe(true)
  })
})

describe('核对与安全 git', () => {
  test('.git/config 被改动后核对失败，安全 git 不再运行；verifyGitLocation 只在严格条件下接受独立 clone', async () => {
    const { fx, home, opts } = setup()
    const r = await ensureSealedClone({
      home,
      taskId: 't-1',
      repo: fx.repo,
      base: 'origin/main',
      branch: 't-1',
      ...opts,
    })
    if (!r.ok) throw new Error(r.error.message)
    // 没有 home：不认独立 clone。
    expect((await verifyGitLocation(r.data.path, [fx.repo])).ok).toBe(false)
    // 不是登记仓库的 clone：不认。
    expect((await verifyGitLocation(r.data.path, [], { home })).ok).toBe(false)
    const loc = await verifyGitLocation(r.data.path, [fx.repo], { home })
    if (!loc.ok) throw new Error(loc.reason)
    expect(loc).toMatchObject({
      repo: realpathSync(fx.repo),
      sealedConfigSha256: r.data.config_sha256,
    })
    const git = createSafeGit(loc, { env: fx.env })
    expect(await git.run(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('t-1\n')
    // worker（假设设法）改动配置：核对失败，安全 git 不运行。
    writeFileSync(
      join(r.data.path, '.git/config'),
      `${readFileSync(join(r.data.path, '.git/config'), 'utf8')}[core]\n\tfsmonitor = /tmp/evil\n`,
    )
    expect(await git.run(['rev-parse', '--abbrev-ref', 'HEAD'])).toBeUndefined()
    const v = await verifySealedClone(home, 't-1')
    expect(!v.ok && v.error.code).toBe('sealed_clone_config_changed')
    expect((await verifyGitLocation(r.data.path, [fx.repo], { home })).ok).toBe(false)
  })
})

describe('removeSealedClone（回滚与清理）', () => {
  test('任务分支快进取回登记仓库后删除 clone；无法快进时取到 raindown/recovered/<任务>', async () => {
    const { fx, home, opts } = setup()
    const make = async (taskId: string, branch: string) => {
      const r = await ensureSealedClone({
        home,
        taskId,
        repo: fx.repo,
        base: 'origin/main',
        branch,
        ...opts,
      })
      if (!r.ok) throw new Error(r.error.message)
      commitIn(fx, r.data.path, `${taskId}.txt`)
      return r.data
    }
    const a = await make('t-a', 'feature-a')
    const ra = await removeSealedClone(home, 't-a', { fetchBack: true, ...opts })
    expect(ra).toEqual({ ok: true, data: { recoveredBranch: 'feature-a' } })
    expect(existsSync(a.path)).toBe(false)
    expect(fx.git(['log', '--format=%s', '-1', 'feature-a'])).toBe('t-a.txt\n')
    // 任务分支在登记仓库中被一个 worktree 检出（不能快进更新）：取到恢复用的名字。
    await make('t-b', TASK_BRANCH)
    const rb = await removeSealedClone(home, 't-b', { fetchBack: true, ...opts })
    expect(rb).toEqual({ ok: true, data: { recoveredBranch: 'raindown/recovered/t-b' } })
    expect(fx.git(['log', '--format=%s', '-1', 'raindown/recovered/t-b'])).toBe('t-b.txt\n')
  })

  test('H2：worker 在 clone 的 logs/ 中预埋指向外部文件的符号链接，节点的核对、安全 git 与取回都不写入它', async () => {
    const { fx, home, opts } = setup()
    const r = await ensureSealedClone({
      home,
      taskId: 't-1',
      repo: fx.repo,
      base: 'origin/main',
      branch: 't-1',
      ...opts,
    })
    if (!r.ok) throw new Error(r.error.message)
    commitIn(fx, r.data.path, 'x.txt')
    const victim = join(fx.root, 'victim-zshenv')
    writeFileSync(victim, '# original\n')
    for (const rel of ['logs/HEAD', 'logs/refs/heads/t-1', 'FETCH_HEAD', 'ORIG_HEAD']) {
      const p = join(r.data.path, '.git', rel)
      mkdirSync(join(p, '..'), { recursive: true })
      execFileSync('rm', ['-f', p])
      symlinkSync(victim, p)
    }
    const loc = await verifyGitLocation(r.data.path, [fx.repo], { home })
    if (!loc.ok) throw new Error(loc.reason)
    const git = createSafeGit(loc, { env: fx.env })
    await git.run(['status', '--porcelain'])
    await git.run(['log', '--oneline', '-1'])
    expect(await removeSealedClone(home, 't-1', { fetchBack: true, ...opts })).toMatchObject({
      ok: true,
    })
    expect(readFileSync(victim, 'utf8')).toBe('# original\n')
  })
})

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const onMac = process.platform === 'darwin' && existsSync(SANDBOX_EXEC)

describe.skipIf(!onMac)('macOS 实测：独立 clone 下的 seatbelt', () => {
  test('clone 中 git 全流程可用；登记仓库的 .git（对象、refs、reflog、alternates、hooks、config）与 clone 的配置、hooks、alternates 都不可写', async () => {
    const { fx, home, opts } = setup()
    const r = await ensureSealedClone({
      home,
      taskId: 't-1',
      repo: fx.repo,
      base: 'origin/main',
      branch: 't-1',
      ...opts,
    })
    if (!r.ok) throw new Error(r.error.message)
    const clone = r.data.path
    const spec = await computeIsolationSpec({
      home,
      taskId: 't-1',
      executor: 'codex-orca',
      cwd: clone,
      access: 'write',
      hubPort: 7477,
      userHome: join(fx.root, 'user'),
      env: {},
      registeredRepos: [fx.repo],
      sealedClone: clone,
    })
    if (!spec.ok) throw new Error(spec.error.message)
    const profile = renderSeatbeltProfile(spec.data)
    if (!profile.ok) throw new Error(profile.error.message)
    const profilePath = join(fx.root, 'p.sb')
    writeFileSync(profilePath, profile.data)
    const env = { ...fx.env, GIT_AUTHOR_DATE: '2026-11-10T00:00:00Z' }
    const sh = (cmd: string, cwd = clone) =>
      spawnSync(SANDBOX_EXEC, ['-f', profilePath, '/bin/sh', '-c', cmd], {
        cwd,
        env,
        encoding: 'utf8',
      })
    const mainGit = join(realpathSync(fx.repo), '.git')
    // 任选一个已有对象文件（H1：改写已有对象内容）。
    const someObject = [...inodes(join(mainGit, 'objects')).values()].find((p) =>
      /objects\/[0-9a-f]{2}\//.test(p),
    )
    if (!someObject) throw new Error('登记仓库没有松散对象')
    const before = readFileSync(someObject)

    for (const cmd of [
      'echo b > b && git add b && git commit -qm b',
      'git branch b2 && git checkout -q -b b3 && git checkout -q t-1',
      'echo c >> b && git stash -q && git stash pop -q && git commit -qam c',
      'git tag t1 && git tag -d t1 >/dev/null',
      `git fetch -q '${fx.repo}' main`,
      'git gc -q',
      // 删除分支时顺带删除其配置节：写 .git/config 被拒绝只告警，退出码 0。
      'git branch -D b2 -q 2>/dev/null',
      'git reset -q --hard HEAD~1 && git reset -q --hard ORIG_HEAD',
    ]) {
      const res = sh(cmd)
      // git gc 结束时更新 .git/info/refs（只供 dumb HTTP 服务）被拒绝只告警、退出码 0：info/ 不放行。
      const err = res.stderr.replace(
        /^error: unable to update .*info\/refs: Operation not permitted\n/m,
        '',
      )
      expect({ cmd, status: res.status, err }).toEqual({ cmd, status: 0, err: '' })
    }
    for (const [what, cmd] of [
      ['改写登记仓库已有对象', `chmod u+w '${someObject}'; echo x > '${someObject}'`],
      ['登记仓库新建对象', `echo x > '${join(mainGit, 'objects/ab/cdef')}'`],
      ['伪造登记仓库的 refs', `echo 0000 > '${join(mainGit, 'refs/heads/main')}'`],
      ['伪造登记仓库的远端跟踪', `echo 0000 > '${join(mainGit, 'refs/remotes/origin/main')}'`],
      ['登记仓库 reflog 预埋链接', `ln -sf /tmp/x '${join(mainGit, 'logs/HEAD')}'`],
      ['登记仓库 alternates', `echo /tmp > '${join(mainGit, 'objects/info/alternates')}'`],
      ['登记仓库 hooks', `echo x > '${join(mainGit, 'hooks/post-checkout')}'`],
      ['登记仓库 config', `echo x >> '${join(mainGit, 'config')}'`],
      ['clone 的 config', `echo x >> '${join(clone, '.git/config')}'`],
      ['clone 的 hooks', `echo x > '${join(clone, '.git/hooks/post-checkout')}'`],
      ['clone 的 info', `echo x > '${join(clone, '.git/info/exclude')}'`],
      ['clone 的 alternates', `echo /tmp > '${join(clone, '.git/objects/info/alternates')}'`],
      ['git config', 'git config core.fsmonitor /tmp/evil'],
      // 审查第二轮 H1：commondir 重定向、config.worktree、新建 worktree 管理目录、gitdir。
      ['clone 的 commondir', `echo evil > '${join(clone, '.git/commondir')}'`],
      ['clone 的 config.worktree', `echo x > '${join(clone, '.git/config.worktree')}'`],
      ['clone 的 worktrees', `mkdir -p '${join(clone, '.git/worktrees/x')}'`],
      ['clone 的 gitdir', `echo x > '${join(clone, '.git/gitdir')}'`],
      ['改名 clone 的 .git', `mv '${join(clone, '.git')}' '${join(clone, '.git2')}'`],
    ] as const) {
      const res = sh(cmd)
      expect({ what, status: res.status }).not.toEqual({ what, status: 0 })
    }
    expect(readFileSync(someObject)).toEqual(before)
    expect(existsSync(join(mainGit, 'objects/info/alternates'))).toBe(false)
    expect(lstatSync(join(mainGit, 'logs/HEAD')).isSymbolicLink()).toBe(false)
    expect((await verifySealedClone(home, 't-1')).ok).toBe(true)
  })
})
