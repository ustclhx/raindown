import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fail, ok, type Result, raindownPaths, runTasksDir, taskRunDir } from '@raindown/core'
import { z } from 'zod'
import { type CommandRunner, execRunner } from './codex-orca/orca.ts'
import { ensureTaskRunDir } from './lease-token.ts'

/**
 * 每个任务独立的 git clone（add-worker-credential-isolation 审查第一轮 H1、H2、M4；第一步方案）。
 *
 * 施加外层 seatbelt 的写类角色不再与用户的登记仓库共享 commondir：worker 能写共享的 `.git` 时，可以改写已有对象
 * （对象 id 不变，绕过审查）、预埋符号链接让沙箱外的 git 把内容追加进任意文件、伪造 refs 与 `objects/info/alternates`。
 * 改为节点（沙箱外）在 `run/tasks/<任务>/repo/` 建一个 `git clone --shared`：
 * - 对象经 `objects/info/alternates` 只读引用登记仓库的对象库，**不硬链接**（缺省的 `--local` 会硬链接对象文件，
 *   同一个 inode，worker 经硬链接就能改写登记仓库的对象）；`isolation.dissociate` 打开时改为 `--no-hardlinks` 完整复制；
 * - `origin` 指向登记仓库的远端，worker 直接推送到远端；登记仓库的 `.git` 对 worker 整体只读；
 * - `.git/config` 由节点写入（上游跟踪、`push.default=current`、`core.logAllRefUpdates=false`），记录 sha256：
 *   worker 不能写 config、hooks、`info/`、`modules/`、`objects/info/alternates`（seatbelt 拒绝），
 *   节点每次在 clone 中运行 git 前核对 sha256，不一致即不运行（`safe-git.ts`）；
 * - 记录写在 worker 读写都被拒绝的 `state/tasks/<任务>/sealed-clone.json`。
 */

export const SEALED_CLONE_DIR = 'repo'
export const SEALED_CLONE_RECORD = 'sealed-clone.json'

export const sealedCloneDir = (home: string, taskId: string) =>
  join(taskRunDir(home, taskId), SEALED_CLONE_DIR)
export const sealedCloneRecordPath = (home: string, taskId: string) =>
  join(raindownPaths(home).state, 'tasks', taskId, SEALED_CLONE_RECORD)

const recordSchema = z.strictObject({
  path: z.string(),
  repo: z.string(),
  branch: z.string(),
  config_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** `--shared` 时为登记仓库对象库的 realpath；`dissociate` 时为 null（没有 alternates）。 */
  alternates: z.string().nullable(),
  created_at: z.string(),
})
export type SealedCloneRecord = z.infer<typeof recordSchema>

/** 分支名：只接受安全字符（与任务 id、Orca 分支名一致）。 */
const SAFE_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$/

export interface SealedCloneGit {
  run?: CommandRunner
  /** 基础环境（其中的 `GIT_*` 一律去掉）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** 节点在沙箱外运行 git 的环境与固定参数：去掉调用方的 `GIT_*`，不运行 hooks、fsmonitor，不弹提示。 */
function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base))
    if (!k.startsWith('GIT_') || k === 'GIT_CONFIG_NOSYSTEM') env[k] = v
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}
const GIT_SAFE = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.ext.allow=never',
]

async function git(
  o: SealedCloneGit,
  cwd: string,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const out = await (o.run ?? execRunner)('git', [...GIT_SAFE, ...args], {
      cwd,
      timeoutMs: o.timeoutMs ?? 600_000,
      env: gitEnv(o.env),
    })
    return { ok: out.code === 0, stdout: out.stdout, stderr: out.stderr }
  } catch (err) {
    return { ok: false, stdout: '', stderr: (err as Error).message }
  }
}

/** 登记仓库的缺省基准：`origin/HEAD` 指向的远端分支，取不到时 `origin/main`。 */
export async function defaultCloneBase(repo: string, o: SealedCloneGit = {}): Promise<string> {
  const r = await git(o, repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const ref = r.stdout.trim()
  return r.ok && /^origin\/[\w./-]+$/.test(ref) ? ref : 'origin/main'
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

/** 读取不跟随链接的普通文件；不是普通文件时返回 undefined。 */
async function readPlain(path: string): Promise<Buffer | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile()) return undefined
    return await readFile(path)
  } catch {
    return undefined
  }
}

async function readRecord(home: string, taskId: string): Promise<SealedCloneRecord | undefined> {
  const raw = await readPlain(sealedCloneRecordPath(home, taskId))
  if (!raw) return undefined
  try {
    const parsed = recordSchema.safeParse(JSON.parse(raw.toString('utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

async function writeRecord(home: string, taskId: string, r: SealedCloneRecord): Promise<void> {
  const path = sealedCloneRecordPath(home, taskId)
  const dir = dirname(path)
  for (const d of [raindownPaths(home).state, dirname(dir), dir]) {
    await mkdir(d, { recursive: true, mode: 0o700 })
    const info = await lstat(d)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${d} 不是普通目录`)
  }
  const pending = join(dir, `${SEALED_CLONE_RECORD}.${randomUUID()}.tmp`)
  try {
    await writeFile(pending, `${JSON.stringify(r)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(pending, path)
  } finally {
    await rm(pending, { force: true })
  }
}

const bad = (code: string, message: string) => fail('failure', code, message)

/**
 * 核对独立 clone：记录存在且合法；目录正是 `run/tasks/<任务>/repo`（realpath）；`.git` 是真实目录；
 * `.git/config` 是普通文件且 sha256 与记录一致；alternates 与记录一致。任何不一致都返回错误（不在其中运行 git）。
 */
export async function verifySealedClone(
  home: string,
  taskId: string,
): Promise<Result<SealedCloneRecord>> {
  const record = await readRecord(home, taskId)
  if (!record) return bad('sealed_clone_missing', `任务 ${taskId} 没有独立 clone 记录`)
  let dir: string
  try {
    dir = await realpath(sealedCloneDir(home, taskId))
  } catch {
    return bad('workdir_missing', `独立 clone 不存在：${sealedCloneDir(home, taskId)}`)
  }
  if (dir !== record.path) return bad('sealed_clone_invalid', `独立 clone 路径与记录不一致：${dir}`)
  try {
    const dotGit = await lstat(join(dir, '.git'))
    if (!dotGit.isDirectory() || dotGit.isSymbolicLink())
      return bad('sealed_clone_invalid', `${dir}/.git 不是真实目录`)
  } catch {
    return bad('sealed_clone_invalid', `${dir}/.git 不存在`)
  }
  const config = await readPlain(join(dir, '.git', 'config'))
  if (!config || sha256(config) !== record.config_sha256)
    return bad('sealed_clone_config_changed', `${dir}/.git/config 已被改动，不在其中运行 git`)
  const alt = await readPlain(join(dir, '.git', 'objects', 'info', 'alternates'))
  if (
    record.alternates === null
      ? alt !== undefined
      : alt?.toString('utf8').trim() !== record.alternates
  )
    return bad('sealed_clone_invalid', `${dir}/.git/objects/info/alternates 与记录不一致`)
  return ok(record)
}

/** `.git/config` 的 sha256（核对用；不是普通文件时 undefined）。 */
export async function sealedConfigHash(dir: string): Promise<string | undefined> {
  const config = await readPlain(join(dir, '.git', 'config'))
  return config ? sha256(config) : undefined
}

export interface EnsureSealedCloneInput extends SealedCloneGit {
  home: string
  taskId: string
  /** 登记仓库（realpath）。 */
  repo: string
  /** 新建分支的基准（例如 `origin/main`、`main`）。 */
  base: string
  /** 任务分支名。 */
  branch: string
  /** `isolation.dissociate`：完整复制对象（`--no-hardlinks`），不经 alternates 引用登记仓库。 */
  dissociate?: boolean
}

/**
 * 建立或复用本任务的独立 clone，返回记录与是否新建。已有 clone 核对不通过时不覆盖（其中可能有 worker 的提交），返回错误。
 * 分支来源依次为：登记仓库中已有的同名本地分支（迁移：之前在共享 worktree 中的提交）、登记仓库的 `origin/<分支>`
 * （恢复已有 PR）、`base`。
 */
export async function ensureSealedClone(
  i: EnsureSealedCloneInput,
): Promise<Result<SealedCloneRecord & { fresh: boolean }>> {
  if (!SAFE_BRANCH.test(i.branch) || i.branch.includes('..'))
    return fail('usage', 'invalid_branch', `分支名不合法：${i.branch}`)
  const dir = sealedCloneDir(i.home, i.taskId)
  const existing = await verifySealedClone(i.home, i.taskId)
  if (existing.ok) return ok({ ...existing.data, fresh: false })
  if (existing.error.code !== 'sealed_clone_missing' && existing.error.code !== 'workdir_missing')
    return existing
  try {
    await lstat(dir)
    return bad(
      'sealed_clone_invalid',
      `${dir} 已存在但没有可用的记录；其中可能有未推送的提交，请确认后删除再重试`,
    )
  } catch {
    // 不存在：新建。
  }
  try {
    const parent = await ensureTaskRunDir(i.home, i.taskId)
    if ((await realpath(dirname(parent))) !== (await realpath(runTasksDir(i.home))))
      return bad('sealed_clone_invalid', '任务私有目录不在 run/tasks/ 下')
  } catch (err) {
    return bad('sealed_clone_failed', `无法建立任务私有目录：${(err as Error).message}`)
  }
  const repo = await realpath(i.repo)
  const step = async (cwd: string, args: readonly string[], what: string) => {
    const r = await git(i, cwd, args)
    if (!r.ok) throw new Error(`${what}失败：${r.stderr.trim().slice(0, 500)}`)
    return r.stdout
  }
  try {
    await step(
      dirname(dir),
      [
        'clone',
        '--quiet',
        i.dissociate ? '--no-hardlinks' : '--shared',
        '--no-checkout',
        '--origin',
        'local',
        '--',
        repo,
        basename(dir),
      ],
      'git clone ',
    )
    // 登记仓库的远端跟踪分支（例如 origin/main）作为基准与恢复来源。
    await step(
      dir,
      ['fetch', '--quiet', '--no-tags', 'local', '+refs/remotes/origin/*:refs/remotes/origin/*'],
      '复制远端跟踪分支',
    )
    const has = async (ref: string) =>
      (await git(i, dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok
    const start = (await has(`refs/remotes/local/${i.branch}`))
      ? `local/${i.branch}`
      : (await has(`refs/remotes/origin/${i.branch}`))
        ? `origin/${i.branch}`
        : (await has(i.base))
          ? i.base
          : `local/${i.base}`
    await step(dir, ['checkout', '--quiet', '--no-track', '-b', i.branch, start], '检出任务分支')
    const url = (await git(i, repo, ['config', '--get', 'remote.origin.url'])).stdout.trim()
    const pushUrl = (await git(i, repo, ['config', '--get', 'remote.origin.pushurl'])).stdout.trim()
    await step(dir, ['remote', 'remove', 'local'], '移除本地来源')
    if (url) {
      await step(dir, ['config', 'remote.origin.url', url], '设置远端')
      await step(
        dir,
        ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
        '设置远端',
      )
      if (pushUrl) await step(dir, ['config', 'remote.origin.pushurl', pushUrl], '设置远端')
      await step(dir, ['config', `branch.${i.branch}.remote`, 'origin'], '设置上游')
      await step(dir, ['config', `branch.${i.branch}.merge`, `refs/heads/${i.branch}`], '设置上游')
    }
    await step(dir, ['config', 'push.default', 'current'], '设置推送方式')
    // 沙箱外运行的 git 不再追加 reflog：worker 预埋在 logs/ 中的符号链接不会让它写进任意文件（审查第一轮 H2）。
    await step(dir, ['config', 'core.logAllRefUpdates', 'false'], '关闭 reflog')
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    return bad('sealed_clone_failed', `无法建立独立 clone：${(err as Error).message}`)
  }
  const real = await realpath(dir)
  const config = await readPlain(join(real, '.git', 'config'))
  if (!config) return bad('sealed_clone_failed', '独立 clone 没有 .git/config')
  const alt = await readPlain(join(real, '.git', 'objects', 'info', 'alternates'))
  const record: SealedCloneRecord = {
    path: real,
    repo,
    branch: i.branch,
    config_sha256: sha256(config),
    alternates: alt ? alt.toString('utf8').trim() : null,
    created_at: new Date().toISOString(),
  }
  try {
    await writeRecord(i.home, i.taskId, record)
  } catch (err) {
    return bad('sealed_clone_failed', `无法写入独立 clone 记录：${(err as Error).message}`)
  }
  return ok({ ...record, fresh: true })
}

/**
 * 回滚或清理：先把任务分支取回登记仓库（只快进；同名分支无法快进或被检出时改用 `raindown/recovered/<任务>`），
 * 再删除 clone 与记录。clone 核对不通过时不取回、不删除（其中可能有 worker 的提交，交给用户处理）。
 */
export async function removeSealedClone(
  home: string,
  taskId: string,
  o: SealedCloneGit & { fetchBack: boolean },
): Promise<Result<{ recoveredBranch?: string }>> {
  const record = await verifySealedClone(home, taskId)
  if (!record.ok) {
    if (record.error.code === 'sealed_clone_missing' || record.error.code === 'workdir_missing') {
      await rm(sealedCloneRecordPath(home, taskId), { force: true }).catch(() => {})
      return ok({})
    }
    return record
  }
  const r = record.data
  let recoveredBranch: string | undefined
  if (o.fetchBack) {
    const fetch = (dst: string, force: boolean) =>
      git(o, r.repo, [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        r.path,
        `${force ? '+' : ''}refs/heads/${r.branch}:refs/heads/${dst}`,
      ])
    if ((await fetch(r.branch, false)).ok) recoveredBranch = r.branch
    else {
      const alt = `raindown/recovered/${taskId}`
      if (!(await fetch(alt, true)).ok)
        return bad(
          'sealed_clone_fetch_back_failed',
          `无法把 ${r.branch} 取回登记仓库 ${r.repo}；独立 clone ${r.path} 保留，请手动处理`,
        )
      recoveredBranch = alt
    }
  }
  await rm(r.path, { recursive: true, force: true })
  await rm(sealedCloneRecordPath(home, taskId), { force: true })
  return ok(recoveredBranch ? { recoveredBranch } : {})
}

/**
 * 在独立 clone 中运行仓库 `orca.yaml` 的 setup 脚本（`/bin/sh -c`）。`prefix` 是与 worker 相同的 seatbelt 命令前缀，
 * 环境是 worker 的环境（含按任务私有的临时与缓存目录）。只在新建 clone 后运行一次。
 */
export async function runCloneSetup(
  script: string,
  o: {
    dir: string
    prefix: readonly string[]
    env: NodeJS.ProcessEnv
    timeoutMs: number
    run?: CommandRunner
  },
): Promise<Result<void>> {
  const [bin, ...rest] = [...o.prefix, '/bin/sh', '-c', script]
  try {
    const out = await (o.run ?? execRunner)(bin as string, rest, {
      cwd: o.dir,
      timeoutMs: o.timeoutMs,
      env: o.env,
    })
    if (out.code === 0) return ok(undefined)
    return bad(
      'setup_failed',
      `独立 clone 的 setup 失败（退出码 ${out.code}）：${(out.stderr || out.stdout).trim().slice(-800)}`,
    )
  } catch (err) {
    return bad('setup_failed', `独立 clone 的 setup 无法运行：${(err as Error).message}`)
  }
}
