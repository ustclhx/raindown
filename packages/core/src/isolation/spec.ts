import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { raindownPaths } from '../home.ts'
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
}

/**
 * 拒绝 `dir` 下除 `keep` 子树以外的全部内容（读写），`dir` 本身不拒绝。
 * 用于 `run/tasks/`（只保留本任务目录）与 `run/executors/`（只保留本执行器目录）：
 * 允许项因此不落在被拒目录内，也不需要为祖先目录额外生成元数据规则。
 */
export interface DenyChildrenExcept {
  dir: string
  keep: string
}

/**
 * 一次派工的隔离描述（design D1）。路径全部是 realpath，已去重、排序；
 * 被另一条拒绝项覆盖的拒绝项被省略。生成配置时允许项写在拒绝项之前，拒绝优先。
 */
export interface IsolationSpec {
  deny_read: string[]
  deny_write: string[]
  deny_children_except: DenyChildrenExcept[]
  allow_read: string[]
  allow_write: string[]
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
  taskId: string
  /** 执行器类型，例如 `codex-orca`。 */
  executor: string
  /** 本任务工作目录。 */
  cwd: string
  /** 角色的读写类别：write 时工作目录可写，否则只读。 */
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
  /** 节点锁文件与日志目录；缺省为 `state/node.lock` 与 `state/logs/`（位于 `state/` 内时被合并）。 */
  nodeLockFile?: string
  logsDir?: string
}

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
 * 计算一次派工的受保护/允许资源清单（design D2）。只计算，不施加。
 * 允许项落在被拒目录内时返回 `isolation_allow_in_deny`：不静默生成祖先元数据规则，调用方应修正目录布局。
 */
export async function computeIsolationSpec(
  input: IsolationSpecInput,
): Promise<Result<IsolationSpec>> {
  if (!validPort(input.hubPort)) return bad('invalid_hub_port', `中枢端口不合法：${input.hubPort}`)
  try {
    const paths = raindownPaths(input.home)
    const userHome = input.userHome ?? homedir()
    const c = canonicalPath

    const protectedDirs = await Promise.all([
      c(paths.state),
      c(paths.config),
      c(paths.brain),
      c(
        dirname(
          resolveAgeKeyFile(
            input.ageKeyFile === undefined ? {} : { ageKeyFile: input.ageKeyFile },
            userHome,
          ),
        ),
      ),
      c(join(userHome, LAUNCH_AGENTS_DIR)),
      c(join(userHome, ORCA_RUNTIME_DIR)),
      c(input.nodeLockFile ?? join(paths.state, 'node.lock')),
      c(input.logsDir ?? paths.logs),
    ])
    const deny = minimal(protectedDirs)
    const orcaDir = await c(join(userHome, ORCA_RUNTIME_DIR))

    const ownTask = await c(taskRunDir(input.home, input.taskId))
    const ownExecutor = await c(executorRunDir(input.home, input.executor))
    const denyChildren: DenyChildrenExcept[] = [
      { dir: await c(runExecutorsDir(input.home)), keep: ownExecutor },
      { dir: await c(runTasksDir(input.home)), keep: ownTask },
    ]

    const cwd = await c(input.cwd)
    const allowRead: string[] = [cwd]
    const allowWrite: string[] = input.access === 'write' ? [cwd] : []
    if (input.leaseTokenFile !== undefined) {
      const token = await c(input.leaseTokenFile)
      if (token === ownTask || !isWithin(ownTask, token))
        return bad(
          'isolation_token_outside_task_dir',
          `派工令牌文件 ${token} 不在本任务私有目录 ${ownTask} 内`,
        )
      allowRead.push(token)
    }
    for (const h of input.harnessPaths ?? []) {
      const p = await c(h.path)
      allowRead.push(p)
      if (h.access === 'write') allowWrite.push(p)
    }

    for (const allowed of uniqueSorted([...allowRead, ...allowWrite])) {
      const inside = deny.find((d) => isWithin(d, allowed))
      if (inside)
        return bad('isolation_allow_in_deny', `允许路径 ${allowed} 位于受保护目录 ${inside} 内`, {
          allowed,
          denied: inside,
        })
      for (const dc of denyChildren) {
        if (allowed !== dc.dir && isWithin(dc.dir, allowed) && !isWithin(dc.keep, allowed))
          return bad(
            'isolation_allow_in_deny',
            `允许路径 ${allowed} 位于受保护目录 ${dc.dir} 内（只保留 ${dc.keep}）`,
            { allowed, denied: dc.dir },
          )
      }
    }

    const orcaPorts = await resolvePorts(input)
    const denyPorts = orcaPorts.status === 'resolved' ? orcaPorts.ports : []
    if (denyPorts.includes(input.hubPort))
      return bad('isolation_port_conflict', `中枢端口 ${input.hubPort} 与 Orca 端口冲突`)

    return ok({
      deny_read: deny,
      deny_write: deny,
      deny_children_except: denyChildren,
      allow_read: uniqueSorted(allowRead),
      allow_write: uniqueSorted(allowWrite),
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
