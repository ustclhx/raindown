import { existsSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { type Env, raindownPaths, resolveRaindownHome } from '../home.ts'
import { fail, ok, type Result } from '../result.ts'
import { resolveAgeKeyFile } from '../secrets.ts'
import {
  canonicalPath,
  executorRunDir,
  isWithin,
  runExecutorsDir,
  runTasksDir,
  taskRunDir,
} from './paths.ts'
import {
  defaultCacheDirs,
  defaultTmpDirs,
  type GitWriteRules,
  gitWriteRules,
  normalizeExtraWrite,
  resolveGitLayout,
  userClaudeTmpDir,
  WRITE_ALLOWLIST_DEVICE_DIRS,
  WRITE_ALLOWLIST_DEVICES,
} from './write-allowlist.ts'

/**
 * 跨进程调试的拒绝项（1.1 实测：`allow default` 下可以 attach 同用户的非 hardened 进程）。
 * 取值是 seatbelt 的操作名，生成配置时写成 `(deny <op> (target others))`。
 */
export const ISOLATION_DENY_PROCESS_DEBUG = ['mach-priv-task-port', 'mach-task-name'] as const

/** Orca 运行时目录（相对用户主目录）：文件与其中的 unix 套接字整体拒绝。 */
export const ORCA_RUNTIME_DIR = join('Library', 'Application Support', 'orca')
/** launchd 用户级 plist 目录（相对用户主目录）。 */
export const LAUNCH_AGENTS_DIR = join('Library', 'LaunchAgents')

/** Orca 本机 TCP 端口的解析结果：失败时不抛错，留给探针与 doctor 报告。 */
export type OrcaPortResolution =
  | { status: 'resolved'; ports: number[] }
  | { status: 'unresolved'; reason: string }

/** 适配器声明的 harness 目录（例如 Raindown 管理的 CODEX_HOME、Claude 的配置目录）。 */
export interface HarnessPath {
  path: string
  access: 'read' | 'write'
  /** `access: write` 时只放行这一个文件（`literal`），而不是整个子树（例如 CODEX_HOME 中 `auth.json` 链接的目标）。 */
  literal?: boolean
  /**
   * `access: write` 的目录中仍不可写的条目（相对该目录）：会被 harness 加载或执行的配置与扩展
   * （例如 CODEX_HOME 的 `config.toml`、`rules/`，Claude 配置目录的 `settings.json`、`hooks/`）。
   */
  denyWrite?: readonly string[]
}

/**
 * 拒绝 `dir` 下除 `keep` 子树以外的全部内容（读写），`dir` 本身不拒绝；`keep` 总是 `dir` 的直接子目录且不是符号链接。
 * 依次用于：raindown-home（只保留 `run/`）、`run/executors/`（只保留本执行器）、`run/executors/<执行器>/`
 * （只保留本次的 harness 子目录，给出 `executorHome` 时）、`run/tasks/`（只保留本任务）。
 * 允许项因此不落在被拒目录内，也不需要为祖先目录额外生成元数据规则。
 */
export interface DenyChildrenExcept {
  dir: string
  keep: string
}

/**
 * 一次派工的隔离描述（design D1）。路径全部是 realpath，已去重、排序；
 * 被另一条拒绝项覆盖的拒绝项被省略。生成配置时允许项写在拒绝项之前，拒绝优先。
 *
 * 写入是白名单（tasks 4.6）：默认拒绝一切写，只放行 `allow_write`（子树）与 `allow_write_literals`（单个文件）；
 * 其中 `write_carve_outs*` 再拒绝（登记仓库的 git 目录、harness 目录中的配置），之后 `allow_write_git*` 放行 worktree 必需的
 * git 部分。`deny_write`、`deny_read` 等受保护项写在最后，白名单不能重新放开它们。
 */
export interface IsolationSpec {
  deny_read: string[]
  deny_write: string[]
  deny_children_except: DenyChildrenExcept[]
  allow_read: string[]
  /** 写白名单（子树）：工作目录（写类角色）、本任务私有目录、harness 目录、临时与缓存目录、`isolation.extra_write`。 */
  allow_write: string[]
  /** 写白名单（单个文件）：设备文件、harness 声明的单个文件。 */
  allow_write_literals: string[]
  /** 白名单内再拒绝写的子树（git 目录、harness 目录中的配置与扩展）。 */
  write_carve_outs: string[]
  /** 白名单内再拒绝写的单个文件（linked worktree 的 `.git` 指针文件）。 */
  write_carve_out_literals: string[]
  /** 登记仓库 `.git` 中 worktree 必需的子目录（只给写类角色）。 */
  allow_write_git: string[]
  /** 登记仓库 `.git` 中 worktree 必需的单个文件（含锁文件）。 */
  allow_write_git_literals: string[]
  /** 拒绝连接其中 unix 套接字的目录（文件规则拦不住 connect）。 */
  deny_unix_sockets: string[]
  /** 显式放行的 unix 套接字（适配器声明；目前为空）。 */
  allow_unix_sockets: string[]
  /** 显式放行的本机 TCP 端口（中枢端口）；其余本机端口不默认拒绝。 */
  allow_local_ports: number[]
  /** 拒绝的本机 TCP 端口（解析出的 Orca 端口）。 */
  deny_local_ports: number[]
  /** Orca 端口的解析结果；`unresolved` 时 `deny_local_ports` 不含 Orca 端口，探针与 doctor 据此报告。 */
  orca_ports: OrcaPortResolution
  deny_process_debug: string[]
}

export interface IsolationSpecInput {
  /** raindown-home。 */
  home: string
  /** 任务 id；必须是单个安全的路径段（不能是 `.`、`..`，不含 `/`）。 */
  taskId: string
  /** 执行器类型，例如 `codex-orca`；同样必须是单个安全的路径段。 */
  executor: string
  /**
   * `run/executors/<执行器>/` 下本次使用的 harness 子目录名（例如 `codex-home`、`codex-read-home`）。
   * 给出时同一执行器的其他子目录也拒绝（codex-exec 的读角色读不到写角色的会话，反之亦然）。
   */
  executorHome?: string
  /** 本任务工作目录。 */
  cwd: string
  /** 角色的读写类别：write 时工作目录可写；read 时工作目录只读（显式写拒绝）。 */
  access: 'read' | 'write'
  /** 本次派工令牌文件（只读放行这一个文件），必须位于本任务私有目录 `run/tasks/<任务>/` 内。 */
  leaseTokenFile?: string
  harnessPaths?: readonly HarnessPath[]
  hubPort: number
  /** Orca 端口解析函数（由节点注入）；缺省视为未解析。抛错或返回非法端口同样视为未解析。 */
  resolveOrcaPorts?: () => Promise<number[]> | number[]
  /** 用户主目录（LaunchAgents、Orca 目录与 sops 私钥默认位置的来源）；缺省为 `os.homedir()`。 */
  userHome?: string
  /** age 私钥文件；缺省按 secrets 的规则（`<userHome>/.config/sops/age/keys.txt`）。 */
  ageKeyFile?: string
  /** 节点锁文件与日志目录；缺省为 `state/node.lock` 与 `state/logs/`（位于 raindown-home 内时被整体拒绝覆盖）。 */
  nodeLockFile?: string
  logsDir?: string
  /**
   * 其他可能的数据目录（遗留 home）。缺省按 home 解析规则的候选：`FLOW_HOME`、`RAINDOWN_HOME`、
   * `<userHome>/flow-home`、`<userHome>/raindown-home`；只收录存在、且与本 home 互不包含的目录。
   */
  legacyHomes?: readonly string[]
  /** 解析遗留 home 时读取的环境变量；缺省为 `process.env`。 */
  env?: Env
  /** 写白名单中的临时目录；缺省 `defaultTmpDirs()`（`/private/tmp`、本用户 `TMPDIR` 及同级 `C`）。测试注入。 */
  tmpDirs?: readonly string[]
  /** 写白名单中的缓存与钥匙串目录；缺省 `defaultCacheDirs(userHome)`。测试注入。 */
  cacheDirs?: readonly string[]
  /** 节点配置 `isolation.extra_write`：追加的可写目录（绝对路径，不能是受保护路径或其祖先）。 */
  extraWrite?: readonly string[]
  /** 本用户 uid（拒绝写 `/private/tmp/claude-<uid>`）；缺省 `process.getuid()`；null 或没有时不生成该项。 */
  uid?: number | null
}

/** 与节点写派工令牌时相同的路径段规则：不以 `.` 开头，因此排除 `.` 与 `..`。 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/

const validPort = (p: unknown): p is number =>
  typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536

async function resolvePorts(input: IsolationSpecInput): Promise<OrcaPortResolution> {
  if (!input.resolveOrcaPorts) return { status: 'unresolved', reason: '没有提供 Orca 端口解析' }
  try {
    const ports = await input.resolveOrcaPorts()
    if (!Array.isArray(ports) || !ports.every(validPort))
      return { status: 'unresolved', reason: 'Orca 端口解析返回了非法端口' }
    return { status: 'resolved', ports: [...new Set(ports)].sort((a, b) => a - b) }
  } catch (err) {
    return { status: 'unresolved', reason: `Orca 端口解析失败：${(err as Error).message}` }
  }
}

/** 去重、排序，并省略被其他项覆盖的子路径。 */
function minimal(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort()
  return sorted.filter((p) => !sorted.some((q) => q !== p && isWithin(q, p)))
}

const uniqueSorted = (paths: readonly string[]) => [...new Set(paths)].sort()

const bad = (code: string, message: string, details?: unknown) =>
  fail('usage', code, message, details)

/**
 * `dir` 下只保留 `segment` 子目录。保留项必须是真实的直接子目录：不能是符号链接（否则任务 A 的目录可以指向任务 B），
 * 规范化后仍须是 `dir` 的直接子项且名字不变。
 */
async function keepChild(dir: string, segment: string): Promise<Result<DenyChildrenExcept>> {
  const raw = join(dir, segment)
  try {
    if ((await lstat(raw)).isSymbolicLink())
      return bad('isolation_keep_symlink', `保留目录 ${raw} 是符号链接，拒绝放行`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const d = await canonicalPath(dir)
  const keep = await canonicalPath(raw)
  if (dirname(keep) !== d || basename(keep) !== segment)
    return bad(
      'isolation_keep_mismatch',
      `保留目录 ${raw} 规范化后（${keep}）不是 ${d} 的直接子目录 ${segment}`,
    )
  return ok({ dir: d, keep })
}

/** 遗留 home 候选及其来源（环境变量名、默认目录或调用方显式传入），用于说明 `isolation_allow_in_deny` 的原因。 */
interface LegacyHome {
  path: string
  source: string
}

async function legacyHomeCandidates(
  input: IsolationSpecInput,
  userHome: string,
): Promise<LegacyHome[]> {
  const env = input.env ?? process.env
  const raw: LegacyHome[] =
    input.legacyHomes?.map((path) => ({ path, source: 'legacyHomes 参数' })) ??
    [
      env.FLOW_HOME?.trim()
        ? {
            path: resolveRaindownHome({ RAINDOWN_HOME: env.FLOW_HOME }, userHome),
            source: '环境变量 FLOW_HOME',
          }
        : undefined,
      env.RAINDOWN_HOME?.trim()
        ? {
            path: resolveRaindownHome({ RAINDOWN_HOME: env.RAINDOWN_HOME }, userHome),
            source: '环境变量 RAINDOWN_HOME',
          }
        : undefined,
      { path: join(userHome, 'flow-home'), source: '默认目录 ~/flow-home' },
      { path: join(userHome, 'raindown-home'), source: '默认目录 ~/raindown-home' },
    ].filter((p): p is LegacyHome => p !== undefined)
  const home = await canonicalPath(input.home)
  const found: LegacyHome[] = []
  for (const p of raw) {
    const real = await canonicalPath(p.path)
    if (!existsSync(real) || isWithin(real, home) || isWithin(home, real)) continue
    if (found.some((f) => f.path === real)) continue
    found.push({ path: real, source: p.source })
  }
  return found
}

/** 工作目录所属仓库的 git 写规则；工作目录不在 git 仓库内时为空。 */
async function gitLayoutRules(cwd: string, access: 'read' | 'write'): Promise<GitWriteRules> {
  const layout = await resolveGitLayout(cwd)
  if (!layout)
    return { carveOuts: [], carveOutLiterals: [], allow: [], allowLiterals: [], deny: [] }
  return gitWriteRules(layout, access)
}

/**
 * 计算一次派工的受保护/允许资源清单（design D2）。只计算，不施加。
 * - raindown-home 整体拒绝，只保留 `run/`（覆盖 state/、config/、brain/、raw/、根目录文件与将来新增的子目录）；
 *   `run/executors/`、`run/tasks/` 再只保留本执行器（及其 harness 子目录）、本任务；
 * - 允许项落在被拒目录内时返回 `isolation_allow_in_deny`：不静默生成祖先元数据规则，调用方应修正目录布局；
 * - 写入是白名单（tasks 4.6）：见 `IsolationSpec` 与 `write-allowlist.ts`。
 */
export async function computeIsolationSpec(
  input: IsolationSpecInput,
): Promise<Result<IsolationSpec>> {
  if (!validPort(input.hubPort)) return bad('invalid_hub_port', `中枢端口不合法：${input.hubPort}`)
  for (const [field, value] of [
    ['taskId', input.taskId],
    ['executor', input.executor],
    ...(input.executorHome !== undefined ? [['executorHome', input.executorHome]] : []),
  ] as const) {
    if (!SAFE_SEGMENT.test(value))
      return bad('invalid_isolation_input', `${field} 不能用作单个路径段：${JSON.stringify(value)}`)
  }
  try {
    const paths = raindownPaths(input.home)
    const userHome = input.userHome ?? homedir()
    const c = canonicalPath

    const ageDir = await c(
      dirname(
        resolveAgeKeyFile(
          input.ageKeyFile === undefined ? {} : { ageKeyFile: input.ageKeyFile },
          userHome,
        ),
      ),
    )
    const realUserHome = await c(userHome)
    if (isWithin(ageDir, realUserHome))
      return bad(
        'isolation_age_key_dir_too_broad',
        `age 私钥目录 ${ageDir} 是用户主目录或其上级，无法只拒绝私钥；请把私钥放进单独的目录（例如 ~/.config/sops/age/）`,
      )

    const keeps: DenyChildrenExcept[] = []
    const entries: Array<[string, string]> = [
      [input.home, 'run'],
      [runExecutorsDir(input.home), input.executor],
      ...(input.executorHome !== undefined
        ? [[executorRunDir(input.home, input.executor), input.executorHome] as [string, string]]
        : []),
      [runTasksDir(input.home), input.taskId],
    ]
    for (const [dir, segment] of entries) {
      const k = await keepChild(dir, segment)
      if (!k.ok) return k
      keeps.push(k.data)
    }
    const realHome = await c(input.home)
    const realRun = await c(paths.run)
    const ownTask = await c(taskRunDir(input.home, input.taskId))
    // 已被 raindown-home 整体拒绝覆盖的项不再单列。
    const coveredByHome = (p: string) => isWithin(realHome, p) && !isWithin(realRun, p)

    const legacy = await legacyHomeCandidates(input, userHome)
    const deny = minimal(
      [
        ageDir,
        await c(join(userHome, LAUNCH_AGENTS_DIR)),
        await c(join(userHome, ORCA_RUNTIME_DIR)),
        await c(input.nodeLockFile ?? join(paths.state, 'node.lock')),
        await c(input.logsDir ?? paths.logs),
        ...legacy.map((l) => l.path),
      ].filter((p) => !coveredByHome(p)),
    )
    const orcaDir = await c(join(userHome, ORCA_RUNTIME_DIR))

    const cwd = await c(input.cwd)
    const allowRead: string[] = [cwd]
    const allowWrite: string[] = []
    const readOnly: string[] = []
    if (input.access === 'write') allowWrite.push(cwd)
    else readOnly.push(cwd)
    if (input.leaseTokenFile !== undefined) {
      const token = await c(input.leaseTokenFile)
      if (token === ownTask || !isWithin(ownTask, token))
        return bad(
          'isolation_token_outside_task_dir',
          `派工令牌文件 ${token} 不在本任务私有目录 ${ownTask} 内`,
        )
      allowRead.push(token)
      readOnly.push(token)
      // 令牌所在目录（`dispatch-tokens/`）本身也拒绝写：否则 worker 可以把父目录改名后重建同名目录，
      // 绕开令牌文件的只读（#93 N3）。令牌直接位于任务目录下时只保护文件本身，不拒绝整个任务目录。
      const tokenDir = dirname(token)
      if (tokenDir !== ownTask) readOnly.push(tokenDir)
    }
    const allowWriteLiterals: string[] = []
    const carveOuts: string[] = []
    for (const h of input.harnessPaths ?? []) {
      const p = await c(h.path)
      allowRead.push(p)
      if (h.access === 'write') {
        if (h.literal) allowWriteLiterals.push(p)
        else allowWrite.push(p)
        // 不解析最后一级：条目可能是指向用户目录的链接，要拒绝的是替换链接本身（经链接写入目标时按目标路径判断，本来就不在白名单内）。
        for (const rel of h.denyWrite ?? []) {
          if (isAbsolute(rel) || rel.split('/').some((s) => s === '..' || s === '.' || s === ''))
            return bad(
              'invalid_isolation_input',
              `harness 拒绝写条目不是相对路径：${JSON.stringify(rel)}`,
            )
          carveOuts.push(join(p, rel))
        }
      } else readOnly.push(p)
    }

    for (const allowed of uniqueSorted([...allowRead, ...allowWrite])) {
      const inside = deny.find((d) => isWithin(d, allowed))
      if (inside) {
        // 遗留 home（另一个可能的数据目录）是工作目录等允许路径的祖先时，写明它是遗留 home 及其来源变量。
        const legacyHome = legacy.find((l) => isWithin(l.path, inside) || isWithin(inside, l.path))
        return bad(
          'isolation_allow_in_deny',
          legacyHome
            ? `允许路径 ${allowed} 位于遗留 home ${legacyHome.path}（来源：${legacyHome.source}）内；遗留 home 整体受保护，请把工作目录移出该目录，或移走/改名遗留 home`
            : `允许路径 ${allowed} 位于受保护目录 ${inside} 内`,
          {
            allowed,
            denied: inside,
            ...(legacyHome
              ? { legacy_home: legacyHome.path, legacy_source: legacyHome.source }
              : {}),
          },
        )
      }
      for (const dc of keeps) {
        if (allowed !== dc.dir && isWithin(dc.dir, allowed) && !isWithin(dc.keep, allowed))
          return bad(
            'isolation_allow_in_deny',
            `允许路径 ${allowed} 位于受保护目录 ${dc.dir} 内（只保留 ${dc.keep}）`,
            { allowed, denied: dc.dir },
          )
      }
    }
    for (const writable of allowWrite) {
      const ro = readOnly.find((r) => isWithin(r, writable))
      if (ro)
        return bad('isolation_allow_in_deny', `可写路径 ${writable} 位于只读路径 ${ro} 内`, {
          allowed: writable,
          denied: ro,
        })
    }

    const orcaPorts = await resolvePorts(input)
    const denyPorts = orcaPorts.status === 'resolved' ? orcaPorts.ports : []
    if (denyPorts.includes(input.hubPort))
      return bad('isolation_port_conflict', `中枢端口 ${input.hubPort} 与 Orca 端口冲突`)

    // ---- 写白名单（tasks 4.6）----
    // 本任务私有目录可写（派工令牌与 `dispatch-tokens/` 仍在 deny_write 中，写在最后）。
    allowWrite.push(ownTask)
    // 临时目录、缓存与钥匙串目录：与任务无关，不参与上面的“允许项不在受保护目录内”检查（受保护项写在最后，仍然优先）。
    const tmpDirs = await Promise.all((input.tmpDirs ?? (await defaultTmpDirs())).map((p) => c(p)))
    const cacheDirs = await Promise.all(
      (input.cacheDirs ?? (await defaultCacheDirs(userHome))).map((p) => c(p)),
    )
    allowWrite.push(...tmpDirs, ...cacheDirs)
    allowWriteLiterals.push(...WRITE_ALLOWLIST_DEVICES)
    allowWrite.push(...WRITE_ALLOWLIST_DEVICE_DIRS)
    // 登记仓库的 git 目录：整体从白名单中挖掉，写类角色再放行 worktree 必需部分；hooks、config 等写在最后拒绝。
    const gitRules = await gitLayoutRules(cwd, input.access)
    carveOuts.push(...gitRules.carveOuts)
    const finalDenyWrite = [...gitRules.deny]
    const uid = input.uid === undefined ? process.getuid?.() : input.uid
    if (uid !== undefined && uid !== null) finalDenyWrite.push(await c(userClaudeTmpDir(uid)))
    const denyWrite = minimal([...deny, ...readOnly, ...finalDenyWrite])
    if (input.extraWrite?.length) {
      const extra = await normalizeExtraWrite(input.extraWrite, userHome, [
        ...denyWrite,
        ...keeps.map((k) => k.dir),
        realHome,
        orcaDir,
      ])
      if (!extra.ok)
        return bad(
          'isolation_extra_write_invalid',
          `isolation.extra_write 中的 ${extra.path} 不能放行：${extra.reason}`,
          { path: extra.path },
        )
      allowWrite.push(...extra.paths)
    }

    return ok({
      deny_read: deny,
      deny_write: denyWrite,
      deny_children_except: keeps,
      allow_read: uniqueSorted(allowRead),
      allow_write: uniqueSorted(allowWrite),
      allow_write_literals: uniqueSorted(allowWriteLiterals),
      write_carve_outs: minimal(carveOuts),
      write_carve_out_literals: uniqueSorted(gitRules.carveOutLiterals),
      allow_write_git: uniqueSorted(gitRules.allow),
      allow_write_git_literals: uniqueSorted(gitRules.allowLiterals),
      deny_unix_sockets: [orcaDir],
      allow_unix_sockets: [],
      allow_local_ports: [input.hubPort],
      deny_local_ports: denyPorts,
      orca_ports: orcaPorts,
      deny_process_debug: [...ISOLATION_DENY_PROCESS_DEBUG],
    })
  } catch (err) {
    return fail('failure', 'isolation_spec_failed', `无法计算隔离清单：${(err as Error).message}`)
  }
}
