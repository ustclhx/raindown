import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  clipDiffStat,
  parsePushTarget,
  type RepoSnapshot,
  splitCommands,
  taskBranch,
} from '@raindown/core'
import { type CommandRunner, execRunner } from './codex-orca/orca.ts'
import {
  createSafeGit,
  type GitLocation,
  type SafeGit,
  safeGitEnv,
  verifyGitLocation,
} from './safe-git.ts'

/**
 * 节点侧的推送与 gh 环境检查（add-m1-supervisor D15，tasks 5.6）。
 *
 * 中枢的 `push_to` / `gh_scope` 条件只判定命令文本；命令真正推到哪里、gh 作用于哪个仓库，取决于
 * 命令执行目录里的 git 配置、hook 与 gh 的解析。这些由节点在 precheck 时检查，结果以
 * `push_env_ok` / `gh_env_ok` 随 `policy/check` 上报，supervisor 的批准送达前再查一次。
 *
 * 安全关键：**任何不确定都返回不通过**（命令失败、超时、输出无法解析、gitdir 不指向登记仓库……），
 * 宁可交给用户也不误放行。检查只读，不修改仓库；所有 git 都经 `safe-git.ts`（先校验 gitdir、
 * 中和 fsmonitor / hook / 过滤器 / 外部 diff）。
 *
 * 只有执行器能可靠确定命令实际执行目录时（`PrecheckRequest.workdirTrusted`）节点才计算这些字段；
 * 目前 codex-orca 与 claude-sdk 都不能（见 design D15），因此它们的请求不带环境字段。
 *
 * 局限：worker 的环境变量不一定与节点相同；这里按节点交给执行器的环境检查环境变量，作为尽力而为的补充。
 * git 的 global 配置取自**节点**的 HOME。
 */

/**
 * git 配置项禁用清单（按 `git config --list --show-scope` 判定，键为 git 输出的形式：section 与变量名
 * 小写，子节名原样，匹配时不区分大小写）。`scope`：
 * - `all`：任何作用域中出现即 `push_env_ok = false`；
 * - `repo`：只在 local / worktree 作用域禁止（worker 能影响的仓库配置），system / global 由用户自己负责。
 * `credential.*` 单独处理（见 `credentialAllowed`）。global 配置取自**节点**的 HOME。
 */
export const FORBIDDEN_GIT_CONFIG: ReadonlyArray<{
  pattern: RegExp
  scope: 'all' | 'repo'
  why: string
}> = [
  { pattern: /^include\./i, scope: 'all', why: '引入其他配置文件' },
  { pattern: /^includeif\./i, scope: 'all', why: '引入其他配置文件' },
  { pattern: /^core\.fsmonitor$/i, scope: 'all', why: 'git 命令执行 fsmonitor 钩子' },
  { pattern: /^core\.hookspath$/i, scope: 'all', why: 'hook 目录被改写（pre-push 在沙箱外运行）' },
  { pattern: /^core\.sshcommand$/i, scope: 'all', why: '推送时执行任意命令' },
  { pattern: /^hook\./i, scope: 'all', why: '配置式 hook' },
  { pattern: /^core\.gitproxy$/i, scope: 'all', why: '推送时执行代理命令' },
  { pattern: /^core\.askpass$/i, scope: 'all', why: '推送时执行凭证提示程序' },
  { pattern: /^core\.alternaterefscommand$/i, scope: 'all', why: '执行任意命令' },
  { pattern: /^remote\..+\.receivepack$/i, scope: 'all', why: '远端执行任意命令' },
  { pattern: /^remote\..+\.uploadpack$/i, scope: 'all', why: '远端执行任意命令' },
  { pattern: /^remote\..+\.push$/i, scope: 'all', why: '改写推送的 refspec' },
  { pattern: /^remote\..+\.vcs$/i, scope: 'all', why: '使用外部 remote helper' },
  { pattern: /^remote\..+\.proxy$/i, scope: 'all', why: '经代理改写连接' },
  { pattern: /^remote\..+\.mirror$/i, scope: 'all', why: '镜像推送全部 ref' },
  { pattern: /^submodule\.recurse$/i, scope: 'all', why: '同时推送子模块' },
  { pattern: /^push\./i, scope: 'all', why: '改变推送行为（子模块、签名、推送选项……）' },
  { pattern: /^filter\./i, scope: 'repo', why: '执行过滤程序' },
  { pattern: /^diff\./i, scope: 'repo', why: '执行外部 diff / textconv' },
  { pattern: /^http\./i, scope: 'repo', why: '改变连接（代理、额外请求头、证书……）' },
  { pattern: /^url\./i, scope: 'repo', why: '改写地址（insteadOf / pushInsteadOf）' },
  { pattern: /^pager\./i, scope: 'repo', why: '执行分页程序' },
  { pattern: /^gpg\./i, scope: 'repo', why: '执行签名程序' },
  { pattern: /^protocol\./i, scope: 'repo', why: '允许其他传输协议' },
  { pattern: /^core\.pager$/i, scope: 'repo', why: '执行分页程序' },
]
/** worker 能影响的作用域。 */
const REPO_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree'])
// 说明：`remote.<name>.pushurl` 不单独禁用：要求个数为 0，或恰好一个且与 `remote.<name>.url` 相同；
// `git remote get-url --push --all` 必须恰好一个值并等于登记仓库快照中的地址。

/** `credential.*`：local / worktree 作用域中出现任何一项都拒绝；system / global 中只允许 helper。 */
export function credentialAllowed(scope: string, key: string): boolean {
  if (!/^credential\./i.test(key)) return true
  if (scope === 'local' || scope === 'worktree') return false
  return /^credential\.(?:.+\.)?helper$/i.test(key)
}

/** 会改变 git 行为或执行命令的环境变量：worker 环境中出现即不通过。 */
export const FORBIDDEN_GIT_ENV: readonly string[] = [
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_PROXY_COMMAND',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_EXEC_PATH',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
]
/** 会改变 gh 解析的仓库或主机的环境变量。 */
export const FORBIDDEN_GH_ENV: readonly string[] = ['GH_REPO', 'GH_HOST']

/** 推送与 gh 检查只接受的主机。 */
export const ALLOWED_HOST = 'github.com'

export type EnvCheck = { ok: true } | { ok: false; reason: string }
const no = (reason: string): EnvCheck => ({ ok: false, reason })
const YES: EnvCheck = { ok: true }

export interface RepoEnvOptions {
  /** raindown-home：给出时也接受本任务的独立 clone（`run/tasks/<任务>/repo`，按节点记录核对）。 */
  home?: string
  /** workspace 登记的仓库路径（节点本地）；命令目录必须属于其中之一。 */
  registeredRepos: readonly string[]
  /** 租约开始时对登记仓库的快照；推送与 gh 检查都与它比对，缺失即不通过。 */
  snapshot?: RepoSnapshot | undefined
  /** 执行器上报的任务分支；推送的来源必须解析为它。 */
  taskBranch?: string | undefined
  /** 执行 git / gh；测试注入。 */
  run?: CommandRunner
  /** worker 的环境变量（缺省 process.env，已去掉中枢凭证）。 */
  env?: NodeJS.ProcessEnv
  /** 单条命令的超时，默认 5 秒。 */
  timeoutMs?: number
}

/** 解析 `git config --list --show-scope --null`：每项为 `scope\0key\nvalue\0`。 */
export function parseScopedConfig(
  out: string,
): Array<{ scope: string; key: string; value: string }> | undefined {
  const parts = out.split('\0')
  if (parts.at(-1) === '') parts.pop()
  if (parts.length % 2 !== 0) return undefined
  const entries: Array<{ scope: string; key: string; value: string }> = []
  for (let i = 0; i < parts.length; i += 2) {
    const scope = parts[i] as string
    const raw = parts[i + 1] as string
    const nl = raw.indexOf('\n')
    const key = (nl < 0 ? raw : raw.slice(0, nl)).trim()
    if (!/^[a-z]+$/.test(scope) || !key || /\s/.test(key)) return undefined
    // 子节名区分大小写，原样保留；清单匹配不区分大小写。
    entries.push({ scope, key, value: nl < 0 ? '' : raw.slice(nl + 1) })
  }
  return entries
}

/** 命中禁用清单（或不允许的 credential 项）的第一个配置项；`command` 作用域（节点自己的 -c）不计。 */
export function forbiddenGitConfig(
  entries: ReadonlyArray<{ scope?: string; key: string }>,
): { key: string; why: string } | undefined {
  for (const { scope = 'local', key } of entries) {
    if (scope === 'command') continue
    if (!credentialAllowed(scope, key)) return { key, why: 'local / worktree 中的凭证配置' }
    const hit = FORBIDDEN_GIT_CONFIG.find(
      (f) => f.pattern.test(key) && (f.scope === 'all' || REPO_SCOPES.has(scope)),
    )
    if (hit) return { key, why: hit.why }
  }
  return undefined
}

/**
 * 可接受的远端地址：`https://host/owner/repo(.git)`、`ssh://[user@]host[:port]/owner/repo(.git)`、
 * `user@host:owner/repo(.git)`。本地路径、`file://`、`ext::` 等 remote helper、带空白或控制字符的
 * 地址一律不接受。
 */
const REMOTE_URL_RES: readonly RegExp[] = [
  /^https:\/\/([A-Za-z0-9.-]+)(?::\d+)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  /^[A-Za-z0-9_.-]+@([A-Za-z0-9.-]+):([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
]

/** 解析远端地址的主机与 owner/repo；不认识的写法返回 undefined。 */
export function parseRemoteUrl(
  url: string,
): { host: string; owner: string; repo: string } | undefined {
  if (url.startsWith('-') || url.includes('::')) return undefined
  for (const re of REMOTE_URL_RES) {
    const m = re.exec(url)
    if (m) {
      const [, host, owner, repo] = m as unknown as [string, string, string, string]
      if (owner.startsWith('.') || repo.startsWith('.') || repo === '') return undefined
      return { host: host.toLowerCase(), owner, repo }
    }
  }
  return undefined
}

const lines = (out: string | undefined): string[] | undefined =>
  out === undefined ? undefined : out.split('\n').filter((l) => l !== '')

/** 只有恰好一个值时返回它（`--get-all` 等多值输出）；否则 undefined。 */
const single = (out: string | undefined): string | undefined => {
  const l = lines(out)
  return l?.length === 1 ? l[0] : undefined
}

/** 校验 gitdir 并创建安全 git；不通过时返回原因。 */
async function open(
  cwd: string,
  o: Pick<RepoEnvOptions, 'registeredRepos' | 'home' | 'run' | 'env' | 'timeoutMs'>,
): Promise<{ ok: true; loc: GitLocation; git: SafeGit } | { ok: false; reason: string }> {
  const loc = await verifyGitLocation(cwd, o.registeredRepos, o.home ? { home: o.home } : {})
  if (!loc.ok) return loc
  return {
    ok: true,
    loc,
    git: createSafeGit(loc, {
      ...(o.run ? { run: o.run } : {}),
      ...(o.env ? { env: o.env } : {}),
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    }),
  }
}

/**
 * 登记仓库快照（租约开始、worker 启动之前）：origin 地址恰好一个、可识别且主机为 github.com，
 * 默认分支取 `refs/remotes/origin/HEAD`（取不到时省略）。目录必须就是登记仓库本身。
 */
export async function snapshotRepo(
  repo: string,
  o: Pick<RepoEnvOptions, 'registeredRepos' | 'home' | 'run' | 'env' | 'timeoutMs'>,
): Promise<RepoSnapshot | undefined> {
  const r = await snapshotRepoResult(repo, o)
  return r.ok ? r.snapshot : undefined
}

/** 同 `snapshotRepo`，采不到时给出原因（供日志）。 */
export async function snapshotRepoResult(
  repo: string,
  o: Pick<RepoEnvOptions, 'registeredRepos' | 'home' | 'run' | 'env' | 'timeoutMs'>,
): Promise<{ ok: true; snapshot: RepoSnapshot } | { ok: false; reason: string }> {
  const opened = await open(repo, o)
  if (!opened.ok) return { ok: false, reason: opened.reason }
  if (opened.loc.workTree !== opened.loc.repo) {
    return { ok: false, reason: 'not_repo_root' }
  }
  const url = single(await opened.git.run(['config', '--get-all', 'remote.origin.url']))
  if (!url) return { ok: false, reason: 'origin_url_not_single' }
  if (parseRemoteUrl(url)?.host !== ALLOWED_HOST) return { ok: false, reason: 'origin_not_github' }
  const head = (
    await opened.git.run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  )?.trim()
  const branch = head?.startsWith('origin/') ? head.slice('origin/'.length) : undefined
  return {
    ok: true,
    snapshot: {
      remote_url: url,
      ...(branch && taskBranch.safeParse(branch).success ? { default_branch: branch } : {}),
    },
  }
}

/** hooks 目录（`<common dir>/hooks`）里只有 `.sample` 普通文件；目录不存在也算通过。 */
async function hooksClean(commonDir: string): Promise<EnvCheck> {
  const dir = join(commonDir, 'hooks')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? YES : no('hooks_unreadable')
  }
  for (const name of names) {
    if (!name.endsWith('.sample')) return no(`hook_enabled:${name}`)
    try {
      if (!(await lstat(join(dir, name))).isFile()) return no(`hook_enabled:${name}`)
    } catch {
      return no('hooks_unreadable')
    }
  }
  return YES
}

export interface PushEnvInput {
  /** 命令实际执行目录。 */
  cwd: string
  remote: string
  /** refspec 的来源与目标分支（短名或 refs/heads/…）。 */
  src: string
  dst: string
}

const short = (ref: string) => (ref.startsWith('refs/heads/') ? ref.slice(11) : ref)

function forbiddenEnv(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of FORBIDDEN_GIT_ENV) if (env[key] !== undefined) return key
  return Object.keys(env).find((k) => /^GIT_CONFIG_(?:KEY|VALUE)_/.test(k))
}

/**
 * 推送环境检查（D15），全部满足才通过：
 * 1. worker 环境没有 `FORBIDDEN_GIT_ENV` 中的变量（也没有 `GIT_CONFIG_KEY_*`）；
 * 2. 命令目录的 gitdir 指向登记仓库（`verifyGitLocation`），之后的 git 都走安全 git；
 * 3. 可见的 git 配置（按作用域）中没有禁用项（`forbiddenGitConfig`）；
 * 4. `remote.<remote>.url` 恰好一个，`pushurl` 为 0 个或恰好一个且与 url 相同，
 *    `git remote get-url --push --all` 恰好一个值；三者都等于登记仓库快照中的地址（github.com）；
 * 5. hooks 目录只有 `.sample`；
 * 6. 本地没有与来源、目标分支同名的 tag；来源经 `rev-parse --symbolic-full-name` 解析为
 *    `refs/heads/<任务分支>`。
 */
export async function checkPushEnv(input: PushEnvInput, o: RepoEnvOptions): Promise<EnvCheck> {
  const env = o.env ?? process.env
  const bad = forbiddenEnv(env)
  if (bad) return no(`env:${bad}`)
  const snapshot = o.snapshot
  if (!snapshot || parseRemoteUrl(snapshot.remote_url)?.host !== ALLOWED_HOST) {
    return no('no_repo_snapshot')
  }
  if (!o.taskBranch) return no('no_task_branch')
  const opened = await open(input.cwd, o)
  if (!opened.ok) return no(opened.reason)
  const { git, loc } = opened
  const list = await git.run(['config', '--list', '--show-scope', '--null'])
  const entries = list === undefined ? undefined : parseScopedConfig(list)
  if (!entries) return no('config_unreadable')
  const forbidden = forbiddenGitConfig(entries)
  if (forbidden) return no(`config:${forbidden.key}`)
  const url = single(await git.run(['config', '--get-all', `remote.${input.remote}.url`]))
  if (url !== snapshot.remote_url) return no('remote_url_mismatch')
  const pushUrls = await git.run(['config', '--get-all', `remote.${input.remote}.pushurl`])
  const pushUrlList = lines(pushUrls) ?? []
  if (pushUrlList.length > 1 || (pushUrlList.length === 1 && pushUrlList[0] !== url)) {
    return no('pushurl_mismatch')
  }
  const effective = single(await git.run(['remote', 'get-url', '--push', '--all', input.remote]))
  if (effective !== url) return no('push_url_mismatch')
  const hooks = await hooksClean(loc.commonDir)
  if (!hooks.ok) return hooks
  for (const name of new Set([short(input.src), short(input.dst)])) {
    const tags = await git.run(['for-each-ref', '--format=%(refname)', `refs/tags/${name}`])
    if (tags === undefined) return no('tags_unreadable')
    if (tags.trim() !== '') return no(`tag_conflict:${name}`)
  }
  const full = (await git.run(['rev-parse', '--symbolic-full-name', input.src]))?.trim()
  if (full !== `refs/heads/${o.taskBranch}`) return no('source_not_task_branch')
  return YES
}

/**
 * gh 环境检查（D15）：worker 环境没有 `GH_REPO`、`GH_HOST`；命令目录的 gitdir 指向登记仓库；
 * `gh repo view --json nameWithOwner` 解析出的仓库与登记仓库快照中的 owner/repo 完全一致
 * （只认 github.com）。
 */
export async function checkGhEnv(input: { cwd: string }, o: RepoEnvOptions): Promise<EnvCheck> {
  const env = o.env ?? process.env
  for (const key of FORBIDDEN_GH_ENV) if (env[key] !== undefined) return no(`env:${key}`)
  const parsed = o.snapshot ? parseRemoteUrl(o.snapshot.remote_url) : undefined
  if (parsed?.host !== ALLOWED_HOST) return no('no_repo_snapshot')
  const opened = await open(input.cwd, o)
  if (!opened.ok) return no(opened.reason)
  const run = o.run ?? execRunner
  let out: string | undefined
  try {
    // 与安全 git 相同的环境：固定 GIT_DIR / GIT_WORK_TREE，gh 调用的 git 不再读 gitfile。
    const r = await run('gh', ['repo', 'view', '--json', 'nameWithOwner'], {
      cwd: opened.loc.workTree,
      timeoutMs: o.timeoutMs ?? 5_000,
      env: safeGitEnv(opened.loc, env),
    })
    out = r.code === 0 ? r.stdout : undefined
  } catch {
    out = undefined
  }
  if (out === undefined) return no('gh_failed')
  let name: unknown
  try {
    name = (JSON.parse(out) as { nameWithOwner?: unknown } | null)?.nameWithOwner
  } catch {
    return no('gh_output_invalid')
  }
  if (typeof name !== 'string') return no('gh_output_invalid')
  return name === `${parsed.owner}/${parsed.repo}` ? YES : no('gh_repo_mismatch')
}

/** 仓库配置中出现这些项时不计算改动摘要。 */
const DIFF_STAT_BLOCKERS =
  /^(?:filter\.|diff\.|include\.|includeif\.|core\.fsmonitor$|core\.hookspath$)/i

/** 改动摘要中未提交改动最多列出的文件数。 */
const STATUS_MAX = 200

/**
 * 卡住时附带的改动摘要（node-protocol "卡住时附带改动摘要"）：
 * - 已提交部分：`git diff --stat <基点> HEAD`（基点为 `HEAD` 与 `refs/remotes/origin/HEAD` 的 merge-base，
 *   取不到时为 `HEAD`）；
 * - 未提交部分：`git status --porcelain` 的文件列表（不计算内容差异，不运行过滤器）。
 * 两者都经安全 git；gitdir 不指向登记仓库、不是 git 目录或取不到时返回 undefined。节点先按 2000 字符截断。
 */
export async function computeDiffStat(
  cwd: string,
  o: Pick<RepoEnvOptions, 'registeredRepos' | 'home' | 'run' | 'env' | 'timeoutMs'>,
): Promise<string | undefined> {
  const opened = await open(cwd, o)
  if (!opened.ok) return undefined
  const { git } = opened
  // 先看仓库配置：local / worktree 作用域里有过滤器、diff driver、include、fsmonitor 或 hooksPath 时
  // 不计算（中和之外再加一道保守的关口）。
  const list = await git.run(['config', '--list', '--show-scope', '--null'])
  const entries = list === undefined ? undefined : parseScopedConfig(list)
  if (!entries || entries.some((e) => REPO_SCOPES.has(e.scope) && DIFF_STAT_BLOCKERS.test(e.key))) {
    return undefined
  }
  const base = (await git.run(['merge-base', 'HEAD', 'refs/remotes/origin/HEAD']))?.trim() || 'HEAD'
  if (!/^(?:[0-9a-f]{40,64}|HEAD)$/.test(base)) return undefined
  const committed =
    base === 'HEAD' ? '' : await git.run(['diff', '--stat=200', base, 'HEAD', '--'], { diff: true })
  if (committed === undefined) return undefined
  const status = await git.run([
    'status',
    '--porcelain=v1',
    '--ignore-submodules=all',
    '--untracked-files=all',
  ])
  if (status === undefined) return undefined
  const changed = status.split('\n').filter((l) => l.trim() !== '')
  const parts = [
    committed.trimEnd() ? `已提交：\n${committed.trimEnd()}` : '',
    changed.length > 0
      ? `未提交：\n${changed
          .slice(0, STATUS_MAX)
          .map((l) => ` ${l}`)
          .join('\n')}${changed.length > STATUS_MAX ? `\n …（共 ${changed.length} 个文件）` : ''}`
      : '',
  ].filter(Boolean)
  const text = parts.join('\n')
  return clipDiffStat(text === '' ? '（相对任务基点没有改动）' : text)
}

/** 节点随 `policy/check` 上报的环境字段（D15）。 */
export interface NodeEnvReport {
  command_cwd?: string
  push_env_ok?: boolean
  gh_env_ok?: boolean
}

/** 命令是否为 `gh …`（单段、首词就是 gh）：只对这类命令计算 gh_env_ok。 */
function isGhCommand(command: string): boolean {
  const parsed = splitCommands(command)
  return !parsed.opaque && parsed.commands.length === 1 && parsed.commands[0]?.[0] === 'gh'
}

/**
 * 为一次预检计算节点上报的环境字段（只在执行器能可靠确定命令执行目录时调用）：
 * - `command_cwd`：命令执行目录的 realpath（gitdir 校验通过时）；
 * - 命令能按 `parsePushTarget` 解析为推送时：`push_env_ok`；
 * - `gh …` 命令：`gh_env_ok`。
 * 其他命令只上报 `command_cwd`。永不抛出。
 */
export async function nodeEnvReport(
  command: string | undefined,
  cwd: string,
  o: RepoEnvOptions,
): Promise<NodeEnvReport> {
  const report: NodeEnvReport = {}
  try {
    const loc = await verifyGitLocation(cwd, o.registeredRepos, o.home ? { home: o.home } : {})
    // gitdir 不指向登记仓库：不上报执行目录，环境字段判为不通过（只对推送 / gh 命令上报）。
    if (loc.ok) report.command_cwd = loc.workTree
    if (command === undefined) return report
    const push = parsePushTarget(command)
    if (push.ok) {
      report.push_env_ok = loc.ok
        ? (
            await checkPushEnv(
              { cwd: loc.workTree, remote: push.remote, src: push.src, dst: push.dst },
              o,
            )
          ).ok
        : false
    } else if (isGhCommand(command)) {
      report.gh_env_ok = loc.ok ? (await checkGhEnv({ cwd: loc.workTree }, o)).ok : false
    }
  } catch {
    // 不确定即不通过：已算出的字段保留，push_env_ok / gh_env_ok 缺失即视为不满足。
  }
  return report
}
