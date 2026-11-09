import { lstat, open, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { canonicalPath, isWithin } from './paths.ts'

/**
 * 外层 seatbelt 的写白名单（add-worker-credential-isolation 4.6，design D2）。
 *
 * `allow default` 之后先 `(deny file-write*)`，只放行 worker 与 harness 正常工作所需的位置：
 * 工作目录（写类角色）、本任务私有目录、适配器声明的 harness 目录、临时目录、常见缓存子目录、设备文件、
 * 钥匙串文件，以及登记仓库 `.git` 中 worktree 必需的部分。其余位置（shell 启动文件、`~/.gitconfig`、`~/.ssh/`、
 * 用户可写的 PATH 目录、共享 `.git/hooks` 与 `.git/config` 等会在沙箱外被执行或加载的位置）一律不可写。
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

/**
 * 常见缓存目录（相对用户主目录）。只放行缓存子目录，不放行工具的配置文件或全局 bin
 * （`~/.npmrc`、`~/.bunfig.toml`、`~/.bun/bin`、`~/Library/pnpm` 本身等都不在内）。
 * `~/.npm/_npx` 不在内：其中安装的包会被沙箱外的 `npx` 直接执行。
 */
export const WRITE_ALLOWLIST_CACHE_DIRS = [
  '.cache',
  join('Library', 'Caches'),
  join('.bun', 'install', 'cache'),
  join('.npm', '_cacache'),
  join('.npm', '_logs'),
  join('Library', 'pnpm', 'store'),
  join('.local', 'share', 'pnpm', 'store'),
] as const

/**
 * 钥匙串文件目录（相对用户主目录）：Claude Code 经 `security add-generic-password` 刷新 OAuth 凭证，
 * git 的 osxkeychain 凭证助手同理，写入发生在调用进程内。这里不是会在沙箱外执行的位置。
 */
export const WRITE_ALLOWLIST_KEYCHAINS = join('Library', 'Keychains')

/**
 * 会在沙箱外被执行或加载的持久化位置（相对用户主目录）。`isolation.extra_write` 不能是它们、位于它们之内或是它们的祖先。
 * 不在写白名单内时它们本来就不可写；这份清单只用于拒绝错误的追加配置。
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
  '.profile',
  '.gitconfig',
  join('.config', 'git'),
  join('.config', 'gh'),
  join('.config', 'sops'),
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

/** 用户自己的 Claude Code 临时目录根（`/tmp/claude-<uid>`）：会话的临时脚本、输出所在，worker 不可写。 */
export const userClaudeTmpDir = (uid: number) => join('/private/tmp', `claude-${uid}`)

/**
 * 缺省的临时目录：`/private/tmp`、本用户的 `TMPDIR`（`/private/var/folders/<x>/<y>/T`）及同级的缓存目录
 * `…/C`（`DARWIN_USER_CACHE_DIR`，clang 模块缓存、Metal 着色器缓存等写在这里）。全部 realpath。
 */
export async function defaultTmpDirs(): Promise<string[]> {
  const out = ['/private/tmp']
  const t = await canonicalPath(tmpdir())
  out.push(t)
  if (/^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(t)) out.push(join(dirname(t), 'C'))
  const real: string[] = []
  for (const p of out) real.push(await canonicalPath(p))
  return [...new Set(real)]
}

export async function defaultCacheDirs(userHome: string): Promise<string[]> {
  const out: string[] = []
  for (const rel of [...WRITE_ALLOWLIST_CACHE_DIRS, WRITE_ALLOWLIST_KEYCHAINS])
    out.push(await canonicalPath(join(userHome, rel)))
  return out
}

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
  /** 计算时 `<commonDir>/worktrees/` 下已有的 worktree 管理目录（realpath，含本 worktree 自己）。 */
  worktreeDirs: string[]
  /**
   * 指针是否可信：`.git` 指针文件可能被之前未隔离的进程改写，指向任意目录（例如用户主目录），按它放行 gitdir 子树就等于放开白名单。
   * 可信要求与 git 自己的检查一致：linked worktree 的 gitdir 必须是 `<commonDir>/worktrees/<名字>`，且其 `gitdir` 回指本 `.git`；
   * 没有 commondir 时（`--separate-git-dir`）gitdir 必须有 `HEAD` 文件与 `objects/` 目录。不可信时只挖掉、不放行任何 git 部分。
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

/** `<commonDir>/worktrees/` 下的管理目录（只看目录项，不跟随链接）。 */
async function listWorktreeDirs(commonDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(commonDir, 'worktrees'), { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(commonDir, 'worktrees', e.name))
      .sort()
  } catch {
    return []
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
 * 找不到或指针不可解析时返回 undefined（工作目录不是 git 仓库：不生成 git 规则）。
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
      return {
        root: dir,
        dotGit,
        dotGitIsFile: false,
        gitDir,
        commonDir: gitDir,
        worktreeDirs: await listWorktreeDirs(gitDir),
        trusted: true,
      }
    }
    if (info?.isFile() || info?.isSymbolicLink()) {
      const m = info.isFile() ? /^gitdir:\s*(.+?)\s*$/m.exec(await readSmall(dotGit)) : null
      // 指针不可解析或 `.git` 是符号链接：只挖掉 `.git` 本身，不放行任何 git 部分。
      if (!m?.[1])
        return {
          root: dir,
          dotGit,
          dotGitIsFile: true,
          gitDir: dotGit,
          commonDir: dotGit,
          worktreeDirs: [],
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
        worktreeDirs: await listWorktreeDirs(commonDir),
        trusted: await pointerTrusted(dotGit, gitDir, commonDir),
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** 共享 `.git` 中 worktree 必需的子目录（实测：commit、branch、fetch、merge、stash、rebase、tag、gc）。 */
export const GIT_COMMON_WRITE_DIRS = ['objects', 'refs', 'logs', 'lfs', 'rr-cache'] as const
/** 共享 `.git` 中 worktree 必需的单个文件（含锁文件）。`HEAD.lock`：`git gc` 的 reflog expire 会锁主 worktree 的 HEAD。 */
export const GIT_COMMON_WRITE_FILES = [
  'packed-refs',
  'packed-refs.lock',
  'packed-refs.new',
  'gc.pid',
  'gc.pid.lock',
  'gc.log',
  'gc.log.lock',
  'shallow',
  'shallow.lock',
  'HEAD.lock',
] as const
/** 工作目录就是主 worktree（`.git` 是目录）时，每个 worktree 自己的状态文件（及其 `.lock`）直接位于共享 `.git` 下。 */
export const GIT_MAIN_WORKTREE_FILES = [
  'HEAD',
  'index',
  'ORIG_HEAD',
  'FETCH_HEAD',
  'COMMIT_EDITMSG',
  'MERGE_HEAD',
  'MERGE_MSG',
  'MERGE_MODE',
  'MERGE_RR',
  'MERGE_AUTOSTASH',
  'AUTO_MERGE',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'SQUASH_MSG',
  'TAG_EDITMSG',
  'BISECT_LOG',
  'BISECT_START',
  'BISECT_TERMS',
  'BISECT_NAMES',
  'BISECT_EXPECTED_REV',
  'BISECT_ANCESTORS_OK',
  'BISECT_HEAD',
] as const
export const GIT_MAIN_WORKTREE_DIRS = ['rebase-merge', 'rebase-apply', 'sequencer'] as const
/**
 * linked worktree 的 git 目录中不可写的指针与配置：改写 `commondir`、`gitdir` 可以让沙箱外在本 worktree 中运行的 git
 * 改用 worker 伪造的仓库（及其 hooks、config）；`config.worktree` 在 `extensions.worktreeConfig` 打开时会被加载。
 */
export const GIT_WORKTREE_DENY_FILES = ['commondir', 'gitdir', 'config.worktree'] as const
/** 共享 `.git` 中显式拒绝写的位置（不在白名单内本来就不可写；显式列出防止追加的白名单误放开）。 */
export const GIT_COMMON_DENY = ['config', 'hooks', 'info', 'modules'] as const

/** 一次派工的 git 写规则（全部 realpath）。 */
export interface GitWriteRules {
  /** 白名单内再拒绝：仓库的 git 目录整体（含 `.git` 指针文件），之后再按 `allow*` 放行必需部分。 */
  carveOuts: string[]
  carveOutLiterals: string[]
  /** worktree 必需部分（只给写类角色）。 */
  allow: string[]
  allowLiterals: string[]
  /** 最后写拒绝（与受保护项同一阶段，白名单不能重新放开）。 */
  deny: string[]
}

export function gitWriteRules(layout: GitLayout, access: 'read' | 'write'): GitWriteRules {
  const carveOuts = [layout.gitDir, layout.commonDir]
  const carveOutLiterals: string[] = []
  if (layout.dotGitIsFile) carveOutLiterals.push(layout.dotGit)
  else carveOuts.push(layout.dotGit)
  const deny = GIT_COMMON_DENY.map((n) => join(layout.commonDir, n))
  const linked = layout.gitDir !== layout.commonDir
  if (linked) deny.push(...GIT_WORKTREE_DENY_FILES.map((n) => join(layout.gitDir, n)))
  // 只读角色与不可信的指针：只挖掉、拒绝，不放行任何 git 部分。
  if (access === 'read' || !layout.trusted)
    return { carveOuts, carveOutLiterals, allow: [], allowLiterals: [], deny }
  const allow = GIT_COMMON_WRITE_DIRS.map((n) => join(layout.commonDir, n))
  const allowLiterals = GIT_COMMON_WRITE_FILES.map((n) => join(layout.commonDir, n))
  // `git gc` 的 `reflog expire --all` 会锁每个 worktree 的 HEAD 并改写其 reflog（实测）。其他 worktree 只放行这三个文件：
  // 锁文件不能改名成 HEAD（HEAD 本身不在白名单内），reflog 不会被执行。计算之后才新建的 worktree 不在内（见 docs）。
  for (const w of layout.worktreeDirs) {
    if (linked && w === layout.gitDir) continue
    allowLiterals.push(join(w, 'HEAD.lock'), join(w, 'logs', 'HEAD'), join(w, 'logs', 'HEAD.lock'))
  }
  if (linked) allow.push(layout.gitDir)
  else {
    allow.push(...GIT_MAIN_WORKTREE_DIRS.map((n) => join(layout.commonDir, n)))
    for (const n of GIT_MAIN_WORKTREE_FILES)
      allowLiterals.push(join(layout.commonDir, n), join(layout.commonDir, `${n}.lock`))
  }
  return { carveOuts, carveOutLiterals, allow, allowLiterals, deny }
}

/**
 * 校验并规范化 `isolation.extra_write`：只接受绝对路径；不能是 `/`、用户主目录或其祖先；
 * 不能与受保护路径（`protectedPaths`）或持久化位置（`PERSISTENCE_PATHS`）互相包含。返回 realpath 或错误说明。
 */
export async function normalizeExtraWrite(
  paths: readonly string[],
  userHome: string,
  protectedPaths: readonly string[],
): Promise<{ ok: true; paths: string[] } | { ok: false; path: string; reason: string }> {
  const realHome = await canonicalPath(userHome)
  const persistence: string[] = []
  for (const rel of PERSISTENCE_PATHS) persistence.push(await canonicalPath(join(userHome, rel)))
  for (const p of protectedPaths) persistence.push(await canonicalPath(p))
  const out: string[] = []
  for (const raw of paths) {
    if (!isAbsolute(raw)) return { ok: false, path: raw, reason: '不是绝对路径' }
    const p = await canonicalPath(raw)
    if (isWithin(p, realHome) || dirname(p) === p)
      return { ok: false, path: raw, reason: `是根目录或用户主目录（${realHome}）本身及其祖先` }
    for (const q of persistence) {
      if (isWithin(p, q) || isWithin(q, p))
        return {
          ok: false,
          path: raw,
          reason: `与受保护或持久化位置 ${q} 重叠（${basename(q)}）`,
        }
    }
    out.push(p)
  }
  return { ok: true, paths: [...new Set(out)].sort() }
}
