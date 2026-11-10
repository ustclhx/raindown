import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildProbePlan,
  codexNativeConfigValues,
  computeIsolationSpec,
  type Env,
  type ExecutorInfo,
  ISOLATION_LAYERS,
  type IsolationProbeItem,
  type IsolationProbeReport,
  type IsolationProbeRun,
  type IsolationSpec,
  isolationProbeItem,
  loadRoles,
  PROBE_FAKE_TOKEN_CONTENT,
  PROBE_FILE_PREFIX,
  type ProbeTargets,
  probeItemOk,
  probeRunPassed,
  type Result,
  type Role,
  raindownPaths,
  resolveAgeKeyFile,
  roleCodexNetwork,
  roleSandboxSetting,
  runTasksDir,
  taskIsolationProfile,
  taskRunDir,
} from '@raindown/core'
import { z } from 'zod'
import { prepareCodexHome } from '../codex-home.ts'
import {
  CODEX_NATIVE_MIN_VERSION,
  checkCodexNativeSupport,
  codexNativeProfileFromSpec,
} from '../codex-native.ts'
import { executorEnv } from '../env.ts'
import { type IsolationProbeGate, resolveExecutable } from '../isolation-gate.ts'
import {
  removeLeaseTokenFile,
  removeSeatbeltProfile,
  writeFileNoFollow,
  writeLeaseTokenFile,
} from '../lease-token.ts'
import { findOrcaSockets } from '../orca-ports.ts'
import { hubPortOf, type SeatbeltOptions, writeSeatbeltLaunch } from '../seatbelt.ts'

export { findOrcaSockets }

/**
 * 节点侧的隔离自检探针（add-worker-credential-isolation D6，tasks 3.1）：
 * 1. 对每个执行器 × 沙箱设置（声明的施加层不是 none）计算隔离清单（`computeIsolationSpec`）；
 * 2. 造临时的"他人任务"假令牌与"本任务"令牌、临时工作目录；
 * 3. 以与 worker 相同的包裹方式启动探针子进程（`launchWrapper`），在节点进程之外逐项尝试；
 * 4. 删除全部临时文件，返回结构化结果。
 *
 * 开关 `isolation.enforce` 关闭时适配器都是 `enforced: false`，探针实际以 none 方式（恒等包裹）运行，受保护项可读 → 不通过；
 * 这正是要如实上报的状态。开关打开时节点传入 `seatbeltProbeLaunchWrapper`：施加层为 seatbelt 的目标用与 worker 相同的
 * SBPL 生成函数写配置并以 `sandbox-exec -f` 启动（tasks 4.1–4.4 的探针联动）。
 */

/** 子进程入口（与本文件同目录）。 */
export const PROBE_CHILD_SCRIPT = fileURLToPath(new URL('./child.ts', import.meta.url))

/** 一个探针目标：执行器 × 沙箱设置。 */
export interface ProbeTarget {
  executor: string
  setting: string
  declared_layer: string
  /** 探针实际运行所用的施加层：适配器声明已施加时等于声明层，否则为 none。 */
  applied_layer: string
  /**
   * native 的联网组（PR #104 审查第二轮 M2）：该执行器 × workspace-write 下有打开网络的角色时，另以打开网络的 profile 探测一次，
   * 结果带 `network: true`；联网与不联网的角色各看各的结果。
   */
  network?: boolean
}

/** 启动包装的上下文：探针临时任务与它的隔离清单（与 worker 同一个 `computeIsolationSpec` 结果）。 */
export interface ProbeLaunch {
  home: string
  taskId: string
  spec: IsolationSpec
  /** 探针工作目录与读写类别（native 下写类角色把工作目录 `.git` 的 hooks、config 收回为只读，与 worker 一致）。 */
  cwd?: string
  access?: 'read' | 'write'
  /**
   * native：探针自己的临时 CODEX_HOME（与执行器的结构一致：`config.toml`、`tmp/`、链接到同一来源的 `auth.json`）。
   * 探针不改动执行器真实的 CODEX_HOME（其中的 auth.json 链接正被运行中的 worker 使用，审查第二轮）。
   */
  codexHome?: string
}

/** 启动包装：接收探针子进程的 argv，返回实际执行的 argv（施加 seatbelt 时加上 sandbox-exec）。缺省为恒等。 */
export type ProbeLaunchWrapper = (
  target: ProbeTarget,
  argv: readonly string[],
  launch: ProbeLaunch,
) => string[] | Promise<string[]>
export const identityLaunchWrapper: ProbeLaunchWrapper = (_target, argv) => [...argv]

/**
 * 开关打开时的启动包装：实际施加层为 seatbelt 的目标，用与 worker 相同的 SBPL 生成与写入（`writeSeatbeltLaunch`）
 * 写入探针临时任务目录的 `isolation.sb`，以 `sandbox-exec -f <配置>` 启动探针子进程；其他施加层恒等。
 */
export function seatbeltProbeLaunchWrapper(
  o: Pick<SeatbeltOptions, 'sandboxExec'> = {},
): ProbeLaunchWrapper {
  return async (target, argv, launch) => {
    if (target.applied_layer !== 'seatbelt') return [...argv]
    const prepared = await writeSeatbeltLaunch(o, launch.home, launch.taskId, launch.spec)
    if (!prepared.ok) throw new ProbeError(prepared.error.code, prepared.error.message)
    return [...prepared.data.prefix, ...argv]
  }
}

/** native 目标的探针工作目录的缺省父目录：不在 $TMPDIR、/tmp 下（`:workspace` 会放行它们）。 */
export const NATIVE_PROBE_TMP = '/var/tmp'

/** native 探针启动包装的选项。 */
export interface NativeProbeOptions {
  /** Codex 可执行文件；缺省 `codex`，按 `pathEnv` 解析为绝对路径（与 worker 启动相同）。测试用假脚本，**不运行真实 codex**。 */
  codexBin?: string
  /** 查找 codex 的 PATH；缺省为节点进程的 PATH（worker 的 PATH 来自节点环境）。 */
  pathEnv?: string
  /** `auth.json` 链接的源目录（与 worker 相同）；缺省为节点环境的 `CODEX_HOME`，再缺省为 `~/.codex`。只用于链接与拒绝项，不读取。 */
  codexAuthSource?: string
  /** 用户主目录（列出 Orca 套接字）；缺省 `os.homedir()`。 */
  userHome?: string
  /** profile 名（测试固定）；缺省每次随机。 */
  profileName?: string
  /** 启动闸门：记录本次探针使用的 codex（身份）与网络设置，worker 启动时据此核对（审查第一轮 H1）。 */
  gate?: IsolationProbeGate
}

/** 该执行器 × 沙箱设置 × 联网组下的角色（按本执行器推算设置，与 worker 启动、required 判定同一函数）。 */
async function nativeRoles(home: string, target: Pick<ProbeTarget, 'executor' | 'setting'>) {
  const loaded = await loadRoles(home)
  return loaded.ok
    ? loaded.data.roles.filter((r) => {
        const asTarget = { ...r, executor: target.executor as Role['executor'] }
        return r.executor === target.executor && roleSandboxSetting(asTarget) === target.setting
      })
    : []
}

/**
 * 该执行器 × 沙箱设置 × 联网组下角色的 `sandbox_workspace_write.*` 配置（与 worker 启动相同地以 `-c` 传入）。
 * 联网组以打开网络的 profile 运行：Orca 端口已解析时本机 TCP 可达，探针因此不通过，联网角色按未施加处理（审查第一轮 M3）；
 * 不联网的角色不受影响（审查第二轮 M2）。
 */
async function nativeRoleSettings(
  home: string,
  target: Pick<ProbeTarget, 'executor' | 'setting' | 'network'>,
): Promise<{ network: boolean; config: string[] }> {
  const network = target.network === true
  const roles = (await nativeRoles(home, target)).filter(
    (r) => roleCodexNetwork({ ...r, executor: target.executor as Role['executor'] }) === network,
  )
  const config = new Map<string, string>()
  for (const r of roles) {
    const c = (r.permissions?.config ?? {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(c))
      if (
        k.startsWith('sandbox_workspace_write.') &&
        ['string', 'number', 'boolean'].includes(typeof v)
      )
        config.set(k, `${k}=${String(v)}`)
  }
  return { network, config: [...config.values()].sort() }
}

/**
 * 开关打开时 native 目标的启动包装（tasks 5.1，审查第一轮 H1、M3）：与 worker 启动一致——
 * 1. 按 PATH 把 codex 解析为绝对路径，`<codex> --version`（不调用模型；按路径 + mtime 等身份缓存）低于 0.167.0 时失败；
 * 2. CODEX_HOME 是探针自己的临时目录，结构与执行器的一致（`prepareCodexHome`：config.toml、链接到同一来源的 auth.json；`tmp/`），
 *    不改动执行器真实的 CODEX_HOME；profile 由 `codexNativeProfileFromSpec` 从同一份隔离清单生成，
 *    带上该联网组的网络设置与角色的 `sandbox_workspace_write.*` 配置；
 * 3. 以 `env CODEX_HOME=<…> <codex 绝对路径> sandbox [-c 角色配置…] -c permissions.<名>=<内联表> -c default_permissions="<名>" -- <探针程序>`
 *    启动（与 worker 相同用 default_permissions 选中 profile，不用 -P）；
 * 4. 把所用 codex 的身份与网络设置记入闸门。其他施加层恒等。
 */
export function nativeProbeLaunchWrapper(n: NativeProbeOptions = {}): ProbeLaunchWrapper {
  const versions = new Map<string, Promise<Result<string>>>()
  return async (target, argv, launch) => {
    if (target.applied_layer !== 'native') return [...argv]
    if (target.setting !== 'workspace-write' && target.setting !== 'read-only')
      throw new ProbeError(
        'native_setting_unsupported',
        `native 只支持 workspace-write 与 read-only，不支持 ${target.setting}`,
      )
    const codexBin = n.codexBin ?? 'codex'
    // 与 worker 相同的 PATH：worker 环境是节点的 executorEnv()（执行器只追加 RAINDOWN_* 变量）。
    const codex = resolveExecutable(codexBin, n.pathEnv ?? executorEnv().PATH)
    if (!codex)
      throw new ProbeError(
        'native_codex_unsupported',
        `找不到 codex 可执行文件 ${codexBin}（按节点的 PATH 查找）；native 施加层需要 codex-cli ${CODEX_NATIVE_MIN_VERSION} 及以上`,
      )
    const authSource = n.codexAuthSource ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
    // 探针自己的临时 CODEX_HOME（结构与执行器的一致），不改动执行器真实的 CODEX_HOME（审查第二轮）。
    const probeHome = launch.codexHome ?? join(taskRunDir(launch.home, launch.taskId), 'codex-home')
    const prepared = await prepareCodexHome(probeHome, authSource)
    if (!prepared.ok) throw new ProbeError(prepared.error.code, prepared.error.message)
    const codexHome = prepared.data
    const env = {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      CODEX_HOME: codexHome,
    }
    let checked = versions.get(codex.key)
    if (!checked) {
      checked = checkCodexNativeSupport(codex.path, env)
      versions.set(codex.key, checked)
    }
    const version = await checked
    if (!version.ok) throw new ProbeError(version.error.code, version.error.message)
    const role = await nativeRoleSettings(launch.home, target)
    const profile = await codexNativeProfileFromSpec({
      spec: launch.spec,
      sandbox: target.setting,
      codexHome,
      authSource,
      codexPath: codex.path,
      ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
      ...(launch.access ? { access: launch.access } : {}),
      userHome: n.userHome ?? homedir(),
      ...(role.network ? { networkEnabled: true } : {}),
      ...(n.profileName !== undefined ? { name: n.profileName } : {}),
    })
    if (!profile.ok) throw new ProbeError(profile.error.code, profile.error.message)
    // 暂存：到节点把本轮报告交给闸门时才生效（审查第二轮）。
    n.gate?.record(target.executor, target.setting, { codex: codex.key, network: role.network })
    return [
      '/usr/bin/env',
      `CODEX_HOME=${codexHome}`,
      codex.path,
      'sandbox',
      ...role.config.flatMap((c) => ['-c', c]),
      ...codexNativeConfigValues(profile.data).flatMap((v) => ['-c', v]),
      '--',
      ...argv,
    ]
  }
}

/** 开关打开时的启动包装：seatbelt 目标走 `seatbeltProbeLaunchWrapper`，native 目标走 `nativeProbeLaunchWrapper`，其他恒等。 */
export function isolationProbeLaunchWrapper(
  o: Pick<SeatbeltOptions, 'sandboxExec'> = {},
  n: NativeProbeOptions = {},
): ProbeLaunchWrapper {
  const seatbelt = seatbeltProbeLaunchWrapper(o)
  const native = nativeProbeLaunchWrapper(n)
  return (target, argv, launch) =>
    target.applied_layer === 'native'
      ? native(target, argv, launch)
      : seatbelt(target, argv, launch)
}

export interface IsolationProbeOptions {
  home: string
  hubUrl: string
  executors: readonly ExecutorInfo[]
  /** 用户主目录（私钥、Orca 目录的来源）；测试必须注入临时目录。 */
  userHome?: string
  /** 解析遗留 home 时读取的环境变量；测试注入 `{}`。 */
  env?: Env
  /** 临时工作目录的父目录；缺省为系统临时目录。 */
  tmpDir?: string
  ageKeyFile?: string
  resolveOrcaPorts?: () => Promise<number[]> | number[]
  /** `config/node.yaml` 的 `isolation.extra_write`（与 worker 的隔离清单一致）。 */
  extraWrite?: readonly string[]
  /** 本用户的 `DARWIN_USER_CACHE_DIR`（与 worker 的隔离清单一致：放行 mds，4.5）。探针不写其中任何文件。 */
  darwinUserCacheDir?: string
  launchWrapper?: ProbeLaunchWrapper
  /** native 目标的探针工作目录的父目录；缺省 `/var/tmp`（不在 $TMPDIR、/tmp 下）。给出 `tmpDir` 时以 `tmpDir` 为准。 */
  nativeTmpDir?: string
  /** 子进程的可执行文件（缺省为当前运行时，即 bun）。 */
  execPath?: string
  /** 单个探针子进程的超时。 */
  timeoutMs?: number
  macosVersion?: () => Promise<string | null>
  now?: () => Date
}

export const PROBE_TIMEOUT_MS = 20_000
/** 探针临时任务 id 的前缀（造在 `run/tasks/` 下，结束即删除；节点启动清理也会删除残留的令牌文件）。 */
export const PROBE_TASK_PREFIX = 'isolation-probe-'
const PROBE_LEASE = 'isolation-probe'
/** 改名探针的临时目录名（位于探针临时任务目录下）。 */
const RENAME_PROBE_DIR = 'rename-probe'
/**
 * 写白名单探针（tasks 4.6、审查第一轮）的临时目录 `run/isolation-probe-<hex>/`：位于写白名单之外（不在本任务私有目录内），
 * 其中有模拟的用户主目录 `home/` 与模拟的登记仓库 `repo/.git`。探针工作目录造成独立 clone 的形状（`.git` 是真实目录，
 * `objects/info/alternates` 指向模拟登记仓库的对象库），按与 worker 相同的规则计算白名单。结束即删除。
 */
export const PROBE_SCRATCH_PREFIX = 'isolation-probe-'

/** 最小的 git 目录（不运行 git）：`HEAD`、`config`、`hooks/`、`objects/`、`refs/heads/`。 */
async function fakeGitDir(dir: string) {
  for (const d of [join(dir, 'hooks'), join(dir, 'objects', 'info'), join(dir, 'refs', 'heads')])
    await mkdir(d, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'HEAD'), 'ref: refs/heads/main\n', { mode: 0o600 })
  await writeFile(join(dir, 'config'), '[core]\n\trepositoryformatversion = 0\n', {
    mode: 0o600,
  })
}

/** 模拟登记仓库 `scratch/repo` 与独立 clone 形状的探针工作目录 `cwd`。 */
async function buildProbeRepo(scratch: string, cwd: string) {
  const repo = join(scratch, 'repo')
  await fakeGitDir(join(repo, '.git'))
  await fakeGitDir(join(cwd, '.git'))
  await writeFile(
    join(cwd, '.git', 'objects', 'info', 'alternates'),
    `${join(repo, '.git', 'objects')}\n`,
    { mode: 0o600 },
  )
  return {
    repo,
    plan: {
      gitHookFile: join(cwd, '.git', 'hooks', 'post-checkout'),
      gitObjectsDir: join(cwd, '.git', 'objects'),
      registeredGitObjectsDir: join(repo, '.git', 'objects'),
      gitCommondirFile: join(cwd, '.git', 'commondir'),
    },
  }
}

const knownLayer = (v: string | undefined) =>
  v !== undefined && (ISOLATION_LAYERS as readonly string[]).includes(v) ? v : 'none'

/** 需要探测的目标：声明了 `credential_isolation`、且该沙箱设置的施加层不是 none。 */
export function probeTargets(executors: readonly ExecutorInfo[]): ProbeTarget[] {
  const out: ProbeTarget[] = []
  for (const e of executors) {
    const declared = e.adapter_capabilities.credential_isolation
    if (!declared) continue
    for (const [setting, raw] of Object.entries(declared.layers).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const layer = knownLayer(raw)
      if (layer === 'none') continue
      out.push({
        executor: e.type,
        setting,
        declared_layer: layer,
        applied_layer: declared.enforced ? layer : 'none',
      })
    }
  }
  return out
}

/** 与执行器实际使用的 CODEX_HOME 子目录一致（codex-exec 的只读角色单独一个目录）。 */
function executorHomeFor(target: ProbeTarget): string | undefined {
  // 施加外层 seatbelt 的设置（danger-full-access）使用独立的 CODEX_HOME（审查第一轮 H3）。
  if (target.setting === 'danger-full-access' && target.executor.startsWith('codex-'))
    return 'codex-home-sealed'
  if (target.executor === 'codex-exec')
    return target.setting === 'read-only' ? 'codex-read-home' : 'codex-home'
  if (target.executor === 'codex-orca') return 'codex-home'
  return undefined
}

/** `sw_vers -productVersion`；非 macOS 或失败时为 null。 */
export function defaultMacosVersion(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('sw_vers', ['-productVersion'], { timeout: 5_000 }, (err, stdout) => {
      const v = String(stdout ?? '').trim()
      resolve(err || !/^[0-9][0-9.]{0,30}$/.test(v) ? null : v)
    })
  })
}

const childOutput = z.object({ items: z.array(isolationProbeItem).max(64) })

class ProbeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** 启动探针子进程：清单经 stdin 传入，只传 PATH 与 HOME 两个环境变量（不传任何凭证）。 */
function spawnProbe(
  argv: readonly string[],
  plan: unknown,
  timeoutMs: number,
  cwd: string,
): Promise<IsolationProbeItem[]> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv
    if (!cmd) return reject(new ProbeError('probe_spawn_failed', '启动包装返回了空命令'))
    const child = spawn(cmd, args, {
      // 在探针的临时工作目录中运行（与 worker 在任务工作目录中运行一致）。
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      },
    })
    let stdout = ''
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new ProbeError('probe_timeout', `探针子进程 ${timeoutMs}ms 内没有结束`)))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      if (stdout.length < 256_000) stdout += d
    })
    // stderr 只用于排障，不进入结果（避免意外内容进入账本）。
    child.stderr.resume()
    child.on('error', (err) =>
      finish(() =>
        reject(
          new ProbeError(
            'probe_spawn_failed',
            `无法启动探针子进程：${(err as NodeJS.ErrnoException).code ?? 'UNKNOWN'}`,
          ),
        ),
      ),
    )
    child.on('close', (code) =>
      finish(() => {
        if (code !== 0) return reject(new ProbeError('probe_failed', `探针子进程退出码 ${code}`))
        try {
          const parsed = childOutput.safeParse(JSON.parse(stdout))
          if (!parsed.success)
            return reject(new ProbeError('probe_bad_output', '探针子进程输出格式不正确'))
          resolve(parsed.data.items)
        } catch {
          reject(new ProbeError('probe_bad_output', '探针子进程输出不是 JSON'))
        }
      }),
    )
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(plan))
  })
}

/** 删除上次运行中断时残留的探针临时任务目录（节点持有单实例锁时调用）。 */
async function cleanStaleProbeTasks(home: string): Promise<void> {
  const root = runTasksDir(home)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.startsWith(PROBE_TASK_PREFIX)) continue
    const p = join(root, name)
    const info = await lstat(p).catch(() => undefined)
    if (info?.isDirectory() && !info.isSymbolicLink()) await rm(p, { recursive: true, force: true })
  }
}

/** 删除上次运行中断时残留的写白名单探针临时目录 `run/isolation-probe-*`（只删真实目录，不跟随链接）。 */
async function cleanStaleProbeScratch(home: string): Promise<void> {
  const root = raindownPaths(home).run
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.startsWith(PROBE_SCRATCH_PREFIX)) continue
    const p = join(root, name)
    const info = await lstat(p).catch(() => undefined)
    if (info?.isDirectory() && !info.isSymbolicLink()) await rm(p, { recursive: true, force: true })
  }
}

async function runOne(
  o: IsolationProbeOptions,
  target: ProbeTarget,
  shared: { userHome: string; sockets: ProbeTargets },
): Promise<IsolationProbeRun> {
  const base = {
    executor: target.executor,
    setting: target.setting,
    declared_layer: target.declared_layer,
    applied_layer: target.applied_layer,
    ...(target.network ? { network: true } : {}),
  }
  const failed = (code: string, message: string): IsolationProbeRun => ({
    ...base,
    passed: false,
    items: [],
    error: { code, message: message.slice(0, 1000) },
  })
  const hex = randomBytes(6).toString('hex')
  const ownTask = `${PROBE_TASK_PREFIX}self-${hex}`
  const otherTask = `${PROBE_TASK_PREFIX}other-${hex}`
  let cwd: string | undefined
  let scratch: string | undefined
  let nativeScratch: string | undefined
  const tokens: string[] = []
  const native = target.applied_layer === 'native'
  try {
    // 规范化为真实路径：与隔离清单中的路径一致（seatbelt 按真实路径匹配）。
    // native 的探针工作目录不放在 $TMPDIR 下（审查第一轮 M3）：`:workspace` 本来就放行 TMPDIR，那里可写证明不了工作目录可写。
    const workRoot =
      o.tmpDir ??
      (target.applied_layer === 'native' ? (o.nativeTmpDir ?? NATIVE_PROBE_TMP) : tmpdir())
    cwd = await realpath(await mkdtemp(join(workRoot, 'raindown-isolation-probe-')))
    // 写白名单探针（tasks 4.6）：模拟的用户主目录与登记仓库，位于写白名单之外。
    scratch = join(raindownPaths(o.home).run, `${PROBE_SCRATCH_PREFIX}${hex}`)
    await mkdir(join(scratch, 'home'), { recursive: true, mode: 0o700 })
    scratch = await realpath(scratch)
    // native（审查第二轮）：模拟 home 与改名目录放在 raindown-home 之外、工作目录的兄弟目录（同在 /var/tmp 下），
    // 不被 raindown-home 的整体拒绝覆盖，测的是 `:workspace` 对工作区之外的真实写限制。
    if (native) {
      nativeScratch = await realpath(
        await mkdtemp(join(workRoot, 'raindown-isolation-probe-scratch-')),
      )
      await mkdir(join(nativeScratch, 'home'), { mode: 0o700 })
    }
    const shellStartupFile = join(nativeScratch ?? scratch, 'home', '.zshenv')
    const repo = await buildProbeRepo(scratch, cwd)
    // 本任务令牌（允许项）与临时伪造的他人任务令牌（受保护项）：内容明显为假，结束后删除。
    const fake = PROBE_FAKE_TOKEN_CONTENT.trim()
    const ownToken = await writeLeaseTokenFile(o.home, ownTask, PROBE_LEASE, fake)
    tokens.push(ownToken)
    const otherToken = await writeLeaseTokenFile(o.home, otherTask, PROBE_LEASE, fake)
    tokens.push(otherToken)
    // 改名探针（审查第一轮 H1）：在本探针临时任务目录下自建 a/b/secret，把 secret 作为受保护项加入清单，
    // 子进程尝试改名 a（受保护路径的祖先目录）。只操作探针自建的临时目录树，绝不改名真实目录。
    const renameRoot = join(nativeScratch ?? taskRunDir(o.home, ownTask), RENAME_PROBE_DIR)
    await mkdir(join(renameRoot, 'a', 'b'), { recursive: true, mode: 0o700 })
    await writeFileNoFollow(join(renameRoot, 'a', 'b', 'secret'), `${fake}\n`)
    const renameTarget = await realpath(join(renameRoot, 'a'))
    const renameSecret = join(renameTarget, 'b', 'secret')
    const executorHome = executorHomeFor(target)
    const spec = await computeIsolationSpec({
      home: o.home,
      taskId: ownTask,
      executor: target.executor,
      ...(executorHome ? { executorHome } : {}),
      cwd,
      access: targetAccess(target),
      leaseTokenFile: ownToken,
      hubPort: hubPortOf(o.hubUrl),
      userHome: shared.userHome,
      ...(o.ageKeyFile ? { ageKeyFile: o.ageKeyFile } : {}),
      ...(o.resolveOrcaPorts ? { resolveOrcaPorts: o.resolveOrcaPorts } : {}),
      ...(o.env ? { env: o.env } : {}),
      ...(o.extraWrite ? { extraWrite: o.extraWrite } : {}),
      ...(o.darwinUserCacheDir !== undefined ? { darwinUserCacheDir: o.darwinUserCacheDir } : {}),
      // 模拟登记仓库的 .git 整体只读；探针工作目录按独立 clone 计算（写类角色时其 .git 可写）。
      registeredRepos: [repo.repo],
      sealedClone: cwd,
    })
    if (!spec.ok) return failed(spec.error.code, spec.error.message)
    const probeSpec: IsolationSpec = {
      ...spec.data,
      deny_read: [...spec.data.deny_read, renameSecret],
      deny_write: [...spec.data.deny_write, renameSecret],
    }
    // native：探针自己的临时 CODEX_HOME（启动包装按执行器的结构准备），不改动执行器真实的 CODEX_HOME。
    const probeCodexHome = join(taskRunDir(o.home, ownTask), 'codex-home')
    const plan = buildProbePlan({
      spec: probeSpec,
      renameTarget,
      profilePath: taskIsolationProfile(o.home, ownTask),
      home: o.home,
      ageKeyFile: resolveAgeKeyFile(
        o.ageKeyFile ? { ageKeyFile: o.ageKeyFile } : {},
        shared.userHome,
      ),
      otherTaskToken: otherToken,
      ownToken,
      cwd,
      hubUrl: o.hubUrl,
      orcaSockets: shared.sockets,
      shellStartupFile,
      ...repo.plan,
      sharedTmp: await realpath(tmpdir()),
      layer: target.applied_layer,
      gitConfigFile: join(cwd, '.git', 'config'),
      ...(native ? { codexHomeAuth: join(probeCodexHome, 'auth.json') } : {}),
    })
    const wrap = o.launchWrapper ?? identityLaunchWrapper
    const argv = await wrap(target, [o.execPath ?? process.execPath, PROBE_CHILD_SCRIPT], {
      home: o.home,
      taskId: ownTask,
      spec: probeSpec,
      cwd,
      access: targetAccess(target),
      ...(native ? { codexHome: probeCodexHome } : {}),
    })
    const items = await spawnProbe(argv, plan, o.timeoutMs ?? PROBE_TIMEOUT_MS, cwd)
    return {
      ...base,
      items,
      passed: probeRunPassed({ items, applied_layer: target.applied_layer }),
    }
  } catch (err) {
    if (
      err instanceof ProbeError &&
      err.code === 'probe_failed' &&
      target.applied_layer === 'native'
    )
      return failed(
        err.code,
        `${err.message}（codex sandbox 没有正常运行探针：Codex 可能不支持 permissions profile 或拒绝了生成的 profile，见 docs/executors.md「native」）`,
      )
    if (err instanceof ProbeError) return failed(err.code, err.message)
    return failed(
      'probe_failed',
      `探针运行失败：${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
    )
  } finally {
    for (const t of tokens) await removeLeaseTokenFile(t).catch(() => {})
    await removeSeatbeltProfile(o.home, ownTask).catch(() => {})
    // 探针临时任务目录（名字带固定前缀，全部由探针自建）：连同改名探针的目录树一起删除。
    for (const task of [ownTask, otherTask])
      await rm(taskRunDir(o.home, task), { recursive: true, force: true }).catch(() => {})
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {})
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {})
    if (nativeScratch) await rm(nativeScratch, { recursive: true, force: true }).catch(() => {})
  }
}

/** `config/` 下残留的写探针文件名（前缀 + 16 位十六进制，与 checks.ts 的随机后缀一致）。 */
const CONFIG_LEFTOVER_RE = new RegExp(`^${PROBE_FILE_PREFIX.replace(/[.]/g, '\\.')}[0-9a-f]{16}$`)

/**
 * 删除探针残留（节点持有单实例锁时调用：节点启动时与每次探针前）：
 * - `config/` 下写探针意外成功又未能删除的文件（只删名字精确匹配的普通文件）；
 * - `run/tasks/isolation-probe-*` 临时任务目录。
 */
export async function cleanProbeLeftovers(home: string): Promise<string[]> {
  const removed: string[] = []
  const config = raindownPaths(home).config
  let names: string[] = []
  try {
    names = await readdir(config)
  } catch {
    names = []
  }
  for (const name of names) {
    if (!CONFIG_LEFTOVER_RE.test(name)) continue
    const p = join(config, name)
    const info = await lstat(p).catch(() => undefined)
    if (info?.isFile()) {
      await rm(p, { force: true })
      removed.push(p)
    }
  }
  await cleanStaleProbeTasks(home)
  await cleanStaleProbeScratch(home)
  return removed
}

/** 某目标的工作目录是否应可写（与 runOne 中计算清单时的 access 一致）。 */
const targetAccess = (t: ProbeTarget): 'read' | 'write' =>
  t.setting === 'read-only' ? 'read' : 'write'

/**
 * 把同一施加层上代表目标的结果复用到另一个目标：受保护项与允许项相同，只有工作目录是否可写随角色读写类别变化，
 * 按该目标重新设定 `write.workdir` 的预期并重算 ok 与 passed。
 */
function reuseRun(rep: IsolationProbeRun, target: ProbeTarget): IsolationProbeRun {
  const items = rep.items.map((i) => {
    // 工作目录与登记仓库 .git 中 worktree 必需部分只对写类角色放行（tasks 4.6）。
    if (i.item !== 'write.workdir' && i.item !== 'write.git_objects') return i
    const expected = targetAccess(target) === 'write' ? ('allow' as const) : ('deny' as const)
    return { ...i, expected, ok: probeItemOk({ expected, actual: i.actual }) }
  })
  return {
    executor: target.executor,
    setting: target.setting,
    declared_layer: target.declared_layer,
    applied_layer: target.applied_layer,
    ...(target.network ? { network: true } : {}),
    items,
    passed: probeRunPassed({
      items,
      applied_layer: target.applied_layer,
      ...(rep.error ? { error: rep.error } : {}),
    }),
    ...(rep.error ? { error: rep.error } : {}),
  }
}

/**
 * 运行一次完整的探针，返回上报用的结果。没有可探测的目标时 `runs` 为空。
 * 同一实际施加层（`applied_layer`）的目标只真正运行一次（受保护文件每轮每个施加层只打开一次），
 * 结果复用到同层的其他执行器 × 沙箱设置；不同施加层并行运行。
 */
/**
 * native 的联网组（PR #104 审查第二轮 M2）：施加 native 的执行器 × workspace-write 下有打开网络的角色时，另加一个以打开网络的
 * profile 运行的目标（结果带 `network: true`）。联网与不联网的角色分别探测、分别判定，一个联网角色不会让同一设置下其他角色失败。
 */
async function withNetworkTargets(home: string, targets: ProbeTarget[]): Promise<ProbeTarget[]> {
  const out: ProbeTarget[] = []
  for (const t of targets) {
    out.push(t)
    if (t.applied_layer !== 'native' || t.setting !== 'workspace-write') continue
    const roles = await nativeRoles(home, t)
    if (roles.some((r) => roleCodexNetwork({ ...r, executor: t.executor as Role['executor'] })))
      out.push({ ...t, network: true })
  }
  return out
}

export async function runIsolationProbe(o: IsolationProbeOptions): Promise<IsolationProbeReport> {
  const userHome = o.userHome ?? homedir()
  await cleanProbeLeftovers(o.home)
  const targets = await withNetworkTargets(o.home, probeTargets(o.executors))
  const sockets: ProbeTargets = targets.length
    ? await findOrcaSockets(userHome)
    : { status: 'none', reason: '' }
  // 未施加（none）时各目标的结果相同，只运行一次；施加时清单随执行器及其 harness 子目录变化（保留的目录不同），
  // 按执行器 × harness 子目录分别运行（审查第一轮 L4），只在完全相同的配置之间复用。
  // native 的 profile 随沙箱设置变化（`:workspace` / `:read-only`），工作目录是否可写由 Codex 决定，按设置分别运行。
  const groupKey = (t: ProbeTarget) =>
    t.applied_layer === 'none'
      ? 'none'
      : `${t.applied_layer}|${t.executor}|${executorHomeFor(t) ?? ''}${t.applied_layer === 'native' ? `|${t.setting}${t.network ? '|net' : ''}` : ''}`
  const groups = new Map<string, ProbeTarget[]>()
  for (const t of targets) groups.set(groupKey(t), [...(groups.get(groupKey(t)) ?? []), t])
  const results = await Promise.all(
    [...groups.values()].map(async (group) => {
      const [rep, ...rest] = group as [ProbeTarget, ...ProbeTarget[]]
      const repRun = await runOne(o, rep, { userHome, sockets })
      return new Map<ProbeTarget, IsolationProbeRun>([
        [rep, repRun],
        ...rest.map((t) => [t, reuseRun(repRun, t)] as [ProbeTarget, IsolationProbeRun]),
      ])
    }),
  )
  const runs = targets.map((t) => {
    for (const m of results) {
      const r = m.get(t)
      if (r) return r
    }
    throw new Error('探针结果缺失')
  })
  return {
    ran_at: (o.now?.() ?? new Date()).toISOString(),
    macos_version: await (o.macosVersion ?? defaultMacosVersion)(),
    runs,
  }
}
