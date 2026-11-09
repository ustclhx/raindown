import { lstat, open } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { canonicalPath, isWithin, taskRunDir } from './paths.ts'

/**
 * 外层 seatbelt 的写白名单（add-worker-credential-isolation 4.6，design D2）。
 *
 * `allow default` 之后先 `(deny file-write*)`，只放行 worker 与 harness 正常工作所需的位置：
 * 工作目录（写类角色，施加时是本任务的独立 clone）、本任务私有目录（其中有按任务私有的临时与缓存目录）、
 * 适配器声明的 harness 目录、设备文件与登录钥匙串文件。共享的临时与缓存目录、用户主目录下的配置、
 * 登记仓库的 `.git` 都不可写（审查第一轮：它们会被沙箱外的进程执行或信任）。
 * 本模块只计算路径（realpath），不读写这些位置的内容；规则的顺序见 `renderSeatbeltProfile`。
 */

/** 设备文件（`literal`）：只放行需要的设备，不放行整个 `/dev`。终端从设备 `/dev/ttys<N>` 由生成配置时的固定正则放行。 */
export const WRITE_ALLOWLIST_DEVICES = [
  '/dev/null',
  '/dev/zero',
  '/dev/tty',
  '/dev/ptmx',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/random',
  '/dev/urandom',
  '/dev/dtracehelper',
] as const

/** 设备目录（`subpath`）：进程自己的文件描述符。 */
export const WRITE_ALLOWLIST_DEVICE_DIRS = ['/dev/fd'] as const

/** 本任务私有目录中的临时与缓存目录（审查第一轮 M2：共享的临时与缓存目录会被沙箱外的进程直接使用）。 */
export const TASK_SCRATCH_DIRS = ['tmp', 'cache'] as const
export const taskTmpDir = (home: string, taskId: string) => join(taskRunDir(home, taskId), 'tmp')
export const taskCacheDir = (home: string, taskId: string) =>
  join(taskRunDir(home, taskId), 'cache')

/**
 * 施加外层 seatbelt 时注入 worker 的环境变量：临时目录与常见工具的缓存一律指到本任务私有目录
 * （`run/tasks/<任务>/tmp|cache/`），任务结束时删除。`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` 关闭 bun 的转译缓存。
 */
export function taskScratchEnv(home: string, taskId: string): Record<string, string> {
  const tmp = taskTmpDir(home, taskId)
  const cache = taskCacheDir(home, taskId)
  return {
    TMPDIR: tmp,
    XDG_CACHE_HOME: join(cache, 'xdg'),
    BUN_INSTALL_CACHE_DIR: join(cache, 'bun'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    npm_config_cache: join(cache, 'npm'),
    PNPM_STORE_DIR: join(cache, 'pnpm-store'),
    npm_config_store_dir: join(cache, 'pnpm-store'),
    PLAYWRIGHT_BROWSERS_PATH: join(cache, 'ms-playwright'),
    COREPACK_HOME: join(cache, 'corepack'),
    PRE_COMMIT_HOME: join(cache, 'pre-commit'),
    GOCACHE: join(cache, 'go-build'),
    GOMODCACHE: join(cache, 'go-mod'),
    PIP_CACHE_DIR: join(cache, 'pip'),
    UV_CACHE_DIR: join(cache, 'uv'),
  }
}

/** 正则元字符转义（路径用作 SBPL 正则的前缀）。 */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 登录钥匙串（审查第一轮 M3）：Claude Code 经 `security add-generic-password` 刷新 OAuth 凭证，写入发生在调用进程内，
 * 落在 `login.keychain-db` 及其原子替换用的临时文件 `login.keychain-db.sb-*`。只放行这两类文件，不放行整个 `~/Library/Keychains`。
 * 残留风险：worker 可以损坏或替换登录钥匙串文件（见 design Risks）。
 */
export const keychainWriteRegex = (realUserHome: string) =>
  `^${escapeRegex(join(realUserHome, 'Library', 'Keychains', 'login.keychain-db'))}(\\.sb-[^/]+)?$`

/**
 * 会在沙箱外被执行或加载的持久化位置（相对用户主目录）。
 * - `isolation.extra_write` 不能是它们、位于它们之内或是它们的祖先；
 * - 纵深防御：施加时整体写拒绝（写在白名单之后；`~/.codex` 保留 auth.json 链接目标这一个文件，见审查第一轮 M1）。
 */
export const PERSISTENCE_PATHS = [
  '.zshenv',
  '.zshrc',
  '.zprofile',
  '.zlogin',
  '.zlogout',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.inputrc',
  '.gitconfig',
  join('.config', 'git'),
  join('.config', 'gh'),
  join('.config', 'sops'),
  join('.config', 'fish'),
  '.ssh',
  join('.local', 'bin'),
  join('.bun', 'bin'),
  '.npmrc',
  '.bunfig.toml',
  '.claude',
  '.claude.json',
  '.codex',
  join('Library', 'LaunchAgents'),
  join('Library', 'Application Support', 'orca'),
] as const

/** 不能整体追加的位置（审查第一轮 L1）：其中的应用数据可能是插件或脚本。 */
export const APPLICATION_SUPPORT = join('Library', 'Application Support')

/** 一个仓库的 git 目录布局（全部 realpath）。 */
export interface GitLayout {
  /** 含 `.git` 的目录（worktree 根）。 */
  root: string
  /** `<root>/.git` 本身（linked worktree 中是指向 gitdir 的文件）。 */
  dotGit: string
  dotGitIsFile: boolean
  /** 本 worktree 的 git 目录：主 worktree 为 `.git/`，linked worktree 为 `<common>/worktrees/<名字>/`。 */
  gitDir: string
  /** 共享的主仓库 `.git`。 */
  commonDir: string
  /**
   * 指针是否可信：`.git` 指针文件可能被之前未隔离的进程改写，指向任意目录（例如用户主目录）。
   * 可信要求与 git 自己的检查一致：linked worktree 的 gitdir 必须是 `<commonDir>/worktrees/<名字>`，且其 `gitdir` 回指本 `.git`；
   * 没有 commondir 时（`--separate-git-dir`）gitdir 必须有 `HEAD` 文件与 `objects/` 目录。
   */
  trusted: boolean
}

/** 见 `GitLayout.trusted`。 */
async function pointerTrusted(dotGit: string, gitDir: string, commonDir: string): Promise<boolean> {
  try {
    if (gitDir !== commonDir) {
      if (dirname(gitDir) !== join(commonDir, 'worktrees')) return false
      const back = (await readSmall(join(gitDir, 'gitdir'))).trim()
      if (!back) return false
      const target = await canonicalPath(isAbsolute(back) ? back : resolve(gitDir, back))
      return target === (await canonicalPath(dotGit))
    }
    const [head, objects] = await Promise.all([
      lstat(join(gitDir, 'HEAD')),
      lstat(join(gitDir, 'objects')),
    ])
    return head.isFile() && objects.isDirectory()
  } catch {
    return false
  }
}

const MAX_POINTER_BYTES = 4096

async function readSmall(path: string): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(MAX_POINTER_BYTES)
    const { bytesRead } = await fh.read(buf, 0, MAX_POINTER_BYTES, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

/**
 * 从工作目录向上查找 `.git`，解析 gitdir 与 commondir（只读这两个指针文件，不运行 git）。
 * 找不到时返回 undefined（工作目录不是 git 仓库）。指针不可解析或 `.git` 是符号链接时返回不可信的布局。
 */
export async function resolveGitLayout(cwd: string): Promise<GitLayout | undefined> {
  let dir = await canonicalPath(cwd)
  for (;;) {
    const dotGit = join(dir, '.git')
    let info: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      info = await lstat(dotGit)
    } catch {
      info = undefined
    }
    if (info?.isDirectory()) {
      const gitDir = await canonicalPath(dotGit)
      return { root: dir, dotGit, dotGitIsFile: false, gitDir, commonDir: gitDir, trusted: true }
    }
    if (info?.isFile() || info?.isSymbolicLink()) {
      const m = info.isFile() ? /^gitdir:\s*(.+?)\s*$/m.exec(await readSmall(dotGit)) : null
      if (!m?.[1])
        return {
          root: dir,
          dotGit,
          dotGitIsFile: true,
          gitDir: dotGit,
          commonDir: dotGit,
          trusted: false,
        }
      const gitDir = await canonicalPath(isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]))
      let commonDir = gitDir
      try {
        const rel = (await readSmall(join(gitDir, 'commondir'))).trim()
        if (rel) commonDir = await canonicalPath(isAbsolute(rel) ? rel : resolve(gitDir, rel))
      } catch {
        // 没有 commondir：gitdir 本身就是共享目录（例如 `git clone --separate-git-dir`）。
      }
      return {
        root: dir,
        dotGit,
        dotGitIsFile: true,
        gitDir,
        commonDir,
        trusted: await pointerTrusted(dotGit, gitDir, commonDir),
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * linked worktree 的 git 目录中不可写的指针与配置：改写 `commondir`、`gitdir` 可以让沙箱外在本 worktree 中运行的 git
 * 改用 worker 伪造的仓库（及其 hooks、config）；`config.worktree` 在 `extensions.worktreeConfig` 打开时会被加载。
 */
export const GIT_WORKTREE_DENY_FILES = ['commondir', 'gitdir', 'config.worktree'] as const
/**
 * `.git` 中最后显式拒绝写的位置：配置、hooks、`info/`（attributes、exclude）、子模块，以及对象库的替代源
 * （`objects/info/alternates` 可以把对象读取重定向到 worker 控制的目录）。
 */
export const GIT_DENY = [
  'config',
  'hooks',
  'info',
  'modules',
  // 改写这些指针或新建 worktree 管理目录可以让沙箱外的 git 改读别处的配置（审查第二轮 H1：独立 clone 的 commondir 重定向）。
  'commondir',
  'gitdir',
  'config.worktree',
  'worktrees',
  join('objects', 'info', 'alternates'),
  join('objects', 'info', 'http-alternates'),
] as const

/** 一次派工的 git 写规则（全部 realpath）。 */
export interface GitWriteRules {
  /** 白名单内再拒绝：仓库的 git 目录整体（含 `.git` 指针文件），之后再按 `allow` 放行。 */
  carveOuts: string[]
  carveOutLiterals: string[]
  /** 本任务独立 clone 的 `.git`（只给施加了外层 seatbelt 的写类角色）。 */
  allow: string[]
  /** 最后写拒绝（与受保护项同一阶段，白名单不能重新放开）。 */
  deny: string[]
}

export interface GitWriteRulesInput {
  /** 工作目录所属仓库的布局（工作目录不是 git 仓库时缺省）。 */
  layout?: GitLayout | undefined
  access: 'read' | 'write'
  /** 本任务独立 clone 的根目录（realpath；施加外层 seatbelt 的写类角色）。只有它的 `.git` 可写。 */
  sealedClone?: string | undefined
  /** 全部登记仓库的 `.git`（realpath）：整体只读（审查第一轮 H1、H2、M4）。 */
  registeredGitDirs?: readonly string[]
}

/**
 * git 写规则（审查第一轮 H1、H2、M4）：登记仓库与工作目录所属仓库的 git 目录整体挖掉；只有本任务的独立 clone
 * （`.git` 是真实目录、指针可信、根目录正是 `sealedClone`）在写类角色下放行其 `.git`，其中配置、hooks、`info/`、
 * 子模块与 `objects/info/alternates` 最后再拒绝。其他情况（共享 commondir 的 worktree、主检出、只读角色）git 目录只读。
 */
export function gitWriteRules(i: GitWriteRulesInput): GitWriteRules {
  const carveOuts = [...(i.registeredGitDirs ?? [])]
  const carveOutLiterals: string[] = []
  const deny: string[] = []
  const allow: string[] = []
  const layout = i.layout
  if (layout) {
    carveOuts.push(layout.gitDir, layout.commonDir)
    if (layout.dotGitIsFile) carveOutLiterals.push(layout.dotGit)
    else carveOuts.push(layout.dotGit)
    deny.push(...GIT_DENY.map((n) => join(layout.commonDir, n)))
    if (layout.gitDir !== layout.commonDir)
      deny.push(...GIT_WORKTREE_DENY_FILES.map((n) => join(layout.gitDir, n)))
    const sealed =
      i.access === 'write' &&
      i.sealedClone !== undefined &&
      layout.trusted &&
      !layout.dotGitIsFile &&
      layout.root === i.sealedClone &&
      !(i.registeredGitDirs ?? []).includes(layout.commonDir)
    if (sealed) allow.push(layout.gitDir)
  }
  return { carveOuts, carveOutLiterals, allow, deny }
}

/** 大小写折叠与 Unicode NFD（APFS 默认不区分大小写、按规范化比较文件名）。 */
const fold = (p: string) => p.normalize('NFD').toLowerCase()
const overlaps = (a: string, b: string) => isWithin(fold(a), fold(b)) || isWithin(fold(b), fold(a))

export interface ExtraWriteContext {
  userHome: string
  /** 受保护路径（raindown-home、私钥目录、派工令牌等）。 */
  protectedPaths: readonly string[]
  /** 登记仓库（含工作区与 `.git`）。 */
  registeredRepos?: readonly string[]
  /** `PATH`（按分隔符拆分后逐个比较）。 */
  pathEnv?: string | undefined
}

/**
 * 校验并规范化 `isolation.extra_write`（审查第一轮 L1）：只接受绝对路径；不能是 `/`、用户主目录或其祖先；
 * 不能与受保护路径、持久化位置、登记仓库、`PATH` 中的目录或 `~/Library/Application Support` 互相包含。
 * 比较时大小写折叠并做 Unicode NFD。返回 realpath 或错误说明。
 */
export async function normalizeExtraWrite(
  paths: readonly string[],
  ctx: ExtraWriteContext,
): Promise<{ ok: true; paths: string[] } | { ok: false; path: string; reason: string }> {
  const realHome = await canonicalPath(ctx.userHome)
  const blocked: Array<{ path: string; what: string }> = []
  for (const rel of PERSISTENCE_PATHS)
    blocked.push({ path: await canonicalPath(join(ctx.userHome, rel)), what: '持久化位置' })
  blocked.push({
    path: await canonicalPath(join(ctx.userHome, APPLICATION_SUPPORT)),
    what: '应用数据目录',
  })
  for (const p of ctx.protectedPaths)
    blocked.push({ path: await canonicalPath(p), what: '受保护位置' })
  for (const p of ctx.registeredRepos ?? [])
    blocked.push({ path: await canonicalPath(p), what: '登记仓库' })
  for (const p of (ctx.pathEnv ?? '').split(delimiter))
    if (isAbsolute(p)) blocked.push({ path: await canonicalPath(p), what: 'PATH 中的目录' })
  const out: string[] = []
  for (const raw of paths) {
    if (!isAbsolute(raw)) return { ok: false, path: raw, reason: '不是绝对路径' }
    const p = await canonicalPath(raw)
    if (isWithin(fold(p), fold(realHome)) || dirname(p) === p)
      return { ok: false, path: raw, reason: `是根目录或用户主目录（${realHome}）本身及其祖先` }
    for (const b of blocked) {
      if (overlaps(p, b.path)) return { ok: false, path: raw, reason: `与${b.what} ${b.path} 重叠` }
    }
    out.push(p)
  }
  return { ok: true, paths: [...new Set(out)].sort() }
}
