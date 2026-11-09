import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { runTasksDir } from '@raindown/core'
import { type CommandRunner, execRunner } from './codex-orca/orca.ts'
import { SEALED_CLONE_DIR, sealedConfigHash, verifySealedClone } from './sealed-clone.ts'

/**
 * 节点自己在 worker 目录里运行 git 的"安全 git"（add-m1-supervisor D15，tasks 5.6 审查第 1 条）。
 *
 * worker（Codex、Claude）能改写自己 worktree 里的文件。节点在沙箱外运行 git 时，git 会读取仓库配置、
 * 执行 fsmonitor、hook、clean/smudge 过滤器、外部 diff、textconv……这些都可能是 worker 写进去的程序。
 * 因此：
 * 1. **先校验 gitdir**（`verifyGitLocation`，纯文件系统检查，不运行 git）：目录要么就是某个登记仓库
 *    本身（`.git` 是真实目录），要么是它的 worktree——`.git` 是普通文件（gitfile），指向
 *    `<登记仓库 common dir>/worktrees/<name>`，该目录的 `gitdir` 文件反向指回本 worktree 的 `.git`，
 *    `commondir` 指回登记仓库的 common dir。不满足时不运行任何 git。
 * 2. **所有 git 走 `createSafeGit`**：用校验过的 `GIT_DIR` / `GIT_WORK_TREE` 固定仓库（不再读 gitfile），
 *    去掉调用方环境里所有 `GIT_*` 变量，加 `GIT_OPTIONAL_LOCKS=0`、`GIT_LFS_SKIP_SMUDGE=1`、
 *    `GIT_TERMINAL_PROMPT=0`、`--no-pager`；以 `-c` 覆盖 `core.fsmonitor=false`、
 *    `core.hooksPath=/dev/null`、`diff.external=`，并对 `git config --get-regexp '^(filter|diff)\.'`
 *    列出的每个 filter / diff driver 清空 `clean`、`smudge`、`process`（`required=false`）与
 *    `command`、`textconv`；diff 类命令另加 `--no-ext-diff --no-textconv`（调用方传 `diff: true`）。
 *    不设 `GIT_CONFIG_NOSYSTEM`：保持用户的 system 配置（global 配置取自节点的 HOME）；只有基础环境里
 *    本来就设了它时才保留（与 worker 的 git 看到的配置一致；测试夹具据此隔离 CI 机器的 system 配置）。
 *
 * G8（PR #53）的审查准备里有类似的中和，之后可以合并成一个助手。
 */

export type GitLocation = {
  /** 工作区根目录（realpath）。 */
  workTree: string
  /** 本工作区的 gitdir（登记仓库本身为 `<repo>/.git`，worktree 为 `<common>/worktrees/<name>`）。 */
  gitDir: string
  /** 登记仓库的 common dir（`<repo>/.git` 的 realpath）。 */
  commonDir: string
  /** 所属的登记仓库（realpath）。 */
  repo: string
  /**
   * 本任务的独立 clone（审查第一轮，第一步方案）：节点写入的 `.git/config` 的 sha256。给出时每次运行 git 前核对，
   * 不一致（worker 设法改动了配置）即不运行。
   */
  sealedConfigSha256?: string
}

export type LocationResult = ({ ok: true } & GitLocation) | { ok: false; reason: string }

async function real(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

async function readSmall(path: string): Promise<string | undefined> {
  try {
    const st = await lstat(path)
    if (!st.isFile() || st.size > 4096) return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 登记仓库的 common dir：`<repo>/.git` 必须是真实目录（不是符号链接或 gitfile）。 */
async function repoCommonDir(repo: string): Promise<{ repo: string; common: string } | undefined> {
  const r = await real(repo)
  if (!r) return undefined
  try {
    const st = await lstat(join(r, '.git'))
    if (!st.isDirectory()) return undefined
  } catch {
    return undefined
  }
  const common = await real(join(r, '.git'))
  return common ? { repo: r, common } : undefined
}

/**
 * 校验目录的 gitdir 指向登记仓库（不运行 git）。见文件头注释的规则；任何不确定都返回不通过。
 */
export async function verifyGitLocation(
  dir: string,
  registeredRepos: readonly string[],
  opts: { home?: string } = {},
): Promise<LocationResult> {
  const workTree = await real(dir)
  if (!workTree) return { ok: false, reason: 'cwd_unresolved' }
  // 本任务的独立 clone：只认 `<home>/run/tasks/<任务>/repo`，并按节点记录核对（.git 是真实目录、config 的 sha256、alternates）。
  if (opts.home) {
    const tasks = await real(runTasksDir(opts.home))
    if (tasks && basename(workTree) === SEALED_CLONE_DIR && dirname(dirname(workTree)) === tasks) {
      const sealed = await verifySealedClone(opts.home, basename(dirname(workTree)))
      if (!sealed.ok) return { ok: false, reason: sealed.error.code }
      const repos = (await Promise.all(registeredRepos.map(repoCommonDir))).filter(
        (r): r is { repo: string; common: string } => r !== undefined,
      )
      if (!repos.some((r) => r.repo === sealed.data.repo))
        return { ok: false, reason: 'repo_not_registered' }
      const gitDir = join(workTree, '.git')
      return {
        ok: true,
        workTree,
        gitDir,
        commonDir: gitDir,
        repo: sealed.data.repo,
        sealedConfigSha256: sealed.data.config_sha256,
      }
    }
  }
  const repos = (await Promise.all(registeredRepos.map(repoCommonDir))).filter(
    (r): r is { repo: string; common: string } => r !== undefined,
  )
  const self = repos.find((r) => r.repo === workTree)
  if (self)
    return { ok: true, workTree, gitDir: self.common, commonDir: self.common, repo: self.repo }
  const dotGit = join(workTree, '.git')
  const content = await readSmall(dotGit)
  if (content === undefined) return { ok: false, reason: 'gitfile_invalid' }
  const m = /^gitdir: (.+)\n?$/.exec(content)
  const target = m?.[1]
  if (!target || target.includes('\n') || target.includes('\0')) {
    return { ok: false, reason: 'gitfile_invalid' }
  }
  const gitDir = await real(isAbsolute(target) ? target : resolve(workTree, target))
  if (!gitDir) return { ok: false, reason: 'gitfile_invalid' }
  const owner = repos.find((r) => dirname(gitDir) === join(r.common, 'worktrees'))
  if (!owner) return { ok: false, reason: 'repo_not_registered' }
  try {
    if (!(await lstat(gitDir)).isDirectory()) return { ok: false, reason: 'gitfile_invalid' }
  } catch {
    return { ok: false, reason: 'gitfile_invalid' }
  }
  // 反向指针：worktrees/<name>/gitdir 指回本 worktree 的 .git；commondir 指回登记仓库。
  const back = (await readSmall(join(gitDir, 'gitdir')))?.trim()
  if (!back || (await real(isAbsolute(back) ? back : resolve(gitDir, back))) !== dotGit) {
    return { ok: false, reason: 'gitdir_backlink_mismatch' }
  }
  const commondir = (await readSmall(join(gitDir, 'commondir')))?.trim()
  if (!commondir || (await real(resolve(gitDir, commondir))) !== owner.common) {
    return { ok: false, reason: 'commondir_mismatch' }
  }
  return { ok: true, workTree, gitDir, commonDir: owner.common, repo: owner.repo }
}

export interface SafeGitOptions {
  run?: CommandRunner
  /** 基础环境（其中的 `GIT_*` 一律去掉）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface SafeGit {
  /** 运行一条 git 子命令；失败（非零退出、超时、找不到程序）返回 undefined。 */
  run(args: readonly string[], opts?: { diff?: boolean }): Promise<string | undefined>
}

/** 中和用的 `-c` 参数里不能出现的字符：driver 名含这些字符时无法安全覆盖。 */
const UNSAFE_DRIVER = /[=\n\0]/

/** 由 `git config --get-regexp` 的输出生成中和参数；无法安全生成时返回 undefined。 */
export function neutralizeDrivers(listing: string): string[] | undefined {
  const args: string[] = []
  const seen = new Set<string>()
  for (const raw of listing.split('\0')) {
    if (raw === '') continue
    // 子节名区分大小写（`filter.Evil.clean` 与 `filter.evil.clean` 是不同的 driver）：
    // 只把 section 与变量名转小写，子节名原样保留。
    const key = raw.split('\n')[0] ?? ''
    const m = /^(filter|diff)\.(.+)\.([^.]+)$/i.exec(key)
    if (!m) continue
    const [, rawSection, name] = m as unknown as [string, string, string]
    const section = rawSection.toLowerCase()
    if (UNSAFE_DRIVER.test(name)) return undefined
    const id = `${section}.${name}`
    if (seen.has(id)) continue
    seen.add(id)
    if (section === 'filter') {
      args.push(
        '-c',
        `filter.${name}.clean=`,
        '-c',
        `filter.${name}.smudge=`,
        '-c',
        `filter.${name}.process=`,
        '-c',
        `filter.${name}.required=false`,
      )
    } else {
      args.push('-c', `diff.${name}.command=`, '-c', `diff.${name}.textconv=`)
    }
  }
  return args
}

/**
 * 安全 git 的环境：去掉基础环境中的 `GIT_*`（只保留 `GIT_CONFIG_NOSYSTEM`：调用方本来就设了它时，
 * worker 的 git 同样不读 system 配置），固定 `GIT_DIR` / `GIT_WORK_TREE`。节点运行 gh 时也用它。
 */
export function safeGitEnv(loc: GitLocation, base: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (!k.startsWith('GIT_') || k === 'GIT_CONFIG_NOSYSTEM') env[k] = v
  }
  Object.assign(env, {
    GIT_DIR: loc.gitDir,
    GIT_WORK_TREE: loc.workTree,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  })
  return env
}

export function createSafeGit(loc: GitLocation, o: SafeGitOptions = {}): SafeGit {
  const runner = o.run ?? execRunner
  const timeoutMs = o.timeoutMs ?? 5_000
  const env = safeGitEnv(loc, o.env ?? process.env)
  const base = [
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'diff.external=',
    '-c',
    'protocol.ext.allow=never',
  ]
  const exec = async (args: readonly string[]): Promise<string | undefined> => {
    if (loc.sealedConfigSha256 !== undefined) {
      const current = await sealedConfigHash(loc.workTree)
      if (current !== loc.sealedConfigSha256) return undefined
    }
    try {
      const out = await runner('git', args, { cwd: loc.workTree, timeoutMs, env })
      return out.code === 0 ? out.stdout : undefined
    } catch {
      return undefined
    }
  }
  let drivers: Promise<string[] | undefined> | undefined
  const neutral = () => {
    drivers ??= (async () => {
      const out = await exec([...base, 'config', '--null', '--get-regexp', '^(filter|diff)\\.'])
      // 没有匹配项时 git config 以 1 退出：视为空。其他失败无法区分，按空处理之前先确认能读配置。
      if (out !== undefined) return neutralizeDrivers(out)
      const probe = await exec([...base, 'config', '--null', '--list'])
      return probe === undefined ? undefined : neutralizeDrivers(probe)
    })()
    return drivers
  }
  return {
    async run(args, opts = {}) {
      const extra = await neutral()
      if (!extra) return undefined
      const [sub, ...rest] = args
      if (sub === undefined) return undefined
      const diffFlags = opts.diff ? ['--no-ext-diff', '--no-textconv'] : []
      return exec([...base, ...extra, sub, ...diffFlags, ...rest])
    },
  }
}
