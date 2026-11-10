import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  CODEX_NATIVE_PROFILE_PREFIX,
  type CodexNativeProfile,
  type CodexNativeSandbox,
  type CredentialIsolation,
  canonicalPath,
  codexNativeConfigValues,
  codexNativeProfile,
  computeIsolationSpec,
  executorRunDir,
  fail,
  type IsolationSpec,
  ok,
  type Result,
  type Role,
  resolveGitLayout,
  roleSandboxSetting,
} from '@raindown/core'
import { resolveExecutable } from './isolation-gate.ts'
import { findOrcaSockets } from './orca-ports.ts'
import { hubPortOf, type SeatbeltOptions, seatbeltActive } from './seatbelt.ts'

/**
 * `native` 施加层（add-worker-credential-isolation 5.1，design D1）：角色沙箱设置为 workspace-write / read-only 的
 * codex-orca、codex-exec，由 Codex 自己的 permissions profile 拒绝沙箱内命令读取受保护路径。
 *
 * - 开关与外层 seatbelt 相同：`config/node.yaml` 的 `isolation.enforce`，仅 macOS（`seatbeltActive`）；关闭时启动命令逐字节不变。
 * - profile 由 core 的 `codexNativeProfile` 从与 seatbelt 同一个 `computeIsolationSpec` 结果生成，探针（`codex sandbox -P`）与
 *   worker 启动共用 `codexNativeProfileFor`，同源。
 * - **位置：每次启动经 `-c` 传入整个 profile（TOML 内联表）**，不写进 CODEX_HOME 的 `config.toml`：同一执行器的 CODEX_HOME 被多个任务
 *   共享，而 profile 含按任务的条目（派工令牌），写共享文件会竞态。profile 名带每次启动的随机后缀（`raindown-<hex>`）：`-c` 对表是合并而不是替换，
 *   固定的名字可能被预先写好的同名表（例如可信项目的 `.codex/config.toml`）追加条目；随机名无法预知。
 *   profile 内容只来自节点与角色配置；CODEX_HOME 本身在 profile 中拒绝，worker 的命令读写不了它。
 * - 启动参数：不再传 `-s <mode>`，改传 `-c permissions.<名>=<内联表> -c default_permissions="<名>"`（官方要求两者不混用）；
 *   角色经 `config.sandbox_mode` 指定沙箱时同样去掉该键（`NATIVE_DROPPED_CONFIG_KEYS`）。
 * - Codex 进程本身不在沙箱内，所以 profile 额外拒绝该执行器的 CODEX_HOME（会话记录 `sessions/`、`auth.json` 链接）与链接的源文件
 *   （用户的 `~/.codex/auth.json`），harness 照常工作；只保留 CODEX_HOME 的 `tmp/` 可读：Codex 把 `apply_patch` 等别名放在
 *   `tmp/arg0/` 下，在沙箱内执行（**未验证**，交给真实验收）。
 */

/** native 需要的最低 Codex 版本：1.1 在 codex-cli 0.167.0 上实测了 permissions profile 与 `codex sandbox -P`。 */
export const CODEX_NATIVE_MIN_VERSION = '0.167.0'

/** 施加 native 时从角色 `permissions.config` 中去掉的键：沙箱改由 permissions profile 决定，二者不混用。 */
export const NATIVE_DROPPED_CONFIG_KEYS: readonly string[] = ['sandbox_mode']

/** 角色是否打开了 workspace-write 的网络（`-c sandbox_workspace_write.network_access=true`）。 */
export function roleNetworkEnabled(config: Readonly<Record<string, unknown>> | undefined): boolean {
  const v = config?.['sandbox_workspace_write.network_access']
  return v === true || (typeof v === 'string' && v.trim() === 'true')
}

/** 本次启动的 profile 名（随机后缀，见模块说明）。 */
export const codexNativeProfileName = (suffix: string = randomBytes(6).toString('hex')) =>
  `${CODEX_NATIVE_PROFILE_PREFIX}${suffix}`

/**
 * 角色在该执行器上是否施加 native：开关生效（macOS），声明已施加，且角色沙箱设置对应的施加层为 `native`。
 * 返回 Codex 的沙箱设置（workspace-write / read-only），不施加时为 undefined。
 */
export function nativeApplies(
  capability: CredentialIsolation,
  role: Pick<Role, 'executor' | 'permissions'> & Partial<Pick<Role, 'kind'>>,
  o?: SeatbeltOptions,
): CodexNativeSandbox | undefined {
  if (!seatbeltActive(o) || !capability.enforced) return undefined
  const setting = roleSandboxSetting(role)
  if (setting !== 'workspace-write' && setting !== 'read-only') return undefined
  return capability.layers[setting] === 'native' ? setting : undefined
}

export interface CodexNativeProfileFromSpec {
  spec: IsolationSpec
  sandbox: CodexNativeSandbox
  /** 该执行器实际使用的 CODEX_HOME（拒绝；只保留 `tmp/` 可读）。 */
  codexHome: string
  /** `auth.json` 链接的源目录（用户平时的 CODEX_HOME，例如 `~/.codex`）：整体拒绝（审查第一轮）。 */
  authSource: string
  /**
   * 本次使用的 codex 可执行文件（真实路径）。它位于拒绝目录内（例如 `~/.codex/packages/standalone/…`）时，其所在目录写 `"read"`：
   * Codex 在沙箱内经 arg0 别名（`CODEX_HOME/tmp/arg0/`）执行自己（`apply_patch` 等）。
   */
  codexPath?: string
  /** 工作目录与读写类别：写类角色把工作目录所属仓库的 `.git/hooks`、`.git/config` 等收回为只读（审查第一轮 M3）。 */
  cwd?: string
  access?: 'read' | 'write'
  /** 探针额外放行读的路径（探针自建的模拟 home 与改名目录，位于拒绝目录内；审查第一轮 M3）。 */
  extraRead?: readonly string[]
  /** 用户主目录（列出 Orca 运行时目录中的套接字）。 */
  userHome?: string
  networkEnabled?: boolean
  name?: string
}

/** 写类角色在可写工作区内仍应只读的 git 位置（存在的才列出）：hooks、config、info、`.git` 指针文件与 commondir 指针。 */
async function gitReadOnly(cwd: string): Promise<string[]> {
  const layout = await resolveGitLayout(cwd)
  if (!layout) return []
  const out = new Set<string>()
  for (const dir of new Set([layout.gitDir, layout.commonDir]))
    for (const name of ['hooks', 'config', 'config.worktree', 'info', 'commondir', 'gitdir'])
      out.add(join(dir, name))
  if (layout.dotGitIsFile) out.add(layout.dotGit)
  const existing: string[] = []
  for (const p of out) {
    try {
      await lstat(p)
      existing.push(p)
    } catch {
      // 不存在：不列出（Codex 的条目要求路径可规范化）。
    }
  }
  return existing
}

/**
 * profile 中每个 `"read"` 例外都必须是规范化后的真实路径、不是符号链接（审查第一轮 H2）：否则 worker 或其他进程可以把例外指向
 * 受保护目录（例如把 `CODEX_HOME/tmp` 换成指向 `state/` 的链接）。CODEX_HOME 的 `tmp/` 不存在时由节点创建（0700）。
 */
async function checkReadExceptions(
  profile: CodexNativeProfile,
  codexTmp: string,
): Promise<Result<CodexNativeProfile>> {
  for (const [path, access] of profile.filesystem) {
    if (access !== 'read') continue
    const bad = (why: string) =>
      fail(
        'failure',
        'codex_profile_unsafe_read',
        `Codex permissions profile 的只读例外 ${path} ${why}，拒绝启动`,
      )
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(path)
    } catch (err) {
      if (path === codexTmp && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(path, { mode: 0o700 })
        info = await lstat(path)
      } else return bad('不存在或无法检查')
    }
    if (info.isSymbolicLink()) return bad('是符号链接')
    if (!info.isFile() && !info.isDirectory()) return bad('不是普通文件或目录')
    if ((await canonicalPath(path)) !== path) return bad('不是规范化后的真实路径')
    if (path === codexTmp && !info.isDirectory()) return bad('不是目录')
  }
  return ok(profile)
}

/** 由隔离清单生成 native profile（worker 启动与探针共用）。 */
export async function codexNativeProfileFromSpec(
  input: CodexNativeProfileFromSpec,
): Promise<Result<CodexNativeProfile>> {
  try {
    const codexHome = await canonicalPath(input.codexHome)
    const codexTmp = join(codexHome, 'tmp')
    const sockets = input.userHome ? await findOrcaSockets(input.userHome) : undefined
    const profile = codexNativeProfile({
      spec: input.spec,
      sandbox: input.sandbox,
      name: input.name ?? codexNativeProfileName(),
      extraDeny: [codexHome, await canonicalPath(input.authSource)],
      extraRead: [
        codexTmp,
        ...(input.codexPath ? [dirname(input.codexPath)] : []),
        ...(input.extraRead ?? []),
      ],
      ...(input.cwd !== undefined && input.access === 'write' && input.sandbox === 'workspace-write'
        ? { readOnly: await gitReadOnly(input.cwd) }
        : {}),
      ...(sockets?.status === 'found' ? { unixSockets: sockets.paths } : {}),
      ...(input.networkEnabled ? { networkEnabled: true } : {}),
    })
    if (!profile.ok) return profile
    return await checkReadExceptions(profile.data, codexTmp)
  } catch (err) {
    return fail(
      'failure',
      'codex_profile_failed',
      `无法生成 Codex permissions profile：${(err as Error).message}`,
    )
  }
}

export interface CodexNativeLaunchInput {
  home: string
  taskId: string
  executor: 'codex-orca' | 'codex-exec'
  /** 本次使用的 CODEX_HOME（执行器级，`prepareCodexHome` 的结果）。 */
  codexHome: string
  authSource: string
  cwd: string
  access: 'read' | 'write'
  sandbox: CodexNativeSandbox
  /**
   * codex 可执行文件（名字或路径）与查找它的 PATH（worker 实际使用的 PATH）。节点解析为绝对路径，启动命令改用该路径，
   * 并要求它与隔离自检时用的是同一个文件（审查第一轮 H1）。
   */
  codexBin: string
  pathEnv: string | undefined
  leaseTokenFile?: string
  hubUrl?: string
  networkEnabled?: boolean
  /** 测试注入固定的 profile 名。 */
  profileName?: string
}

/** 准备结果：追加到 argv 的 `-c` 参数与解析出的 codex 绝对路径。 */
export interface CodexNativeLaunch {
  args: string[]
  profile: CodexNativeProfile
  codexPath: string
}

/**
 * 为一次 Codex 启动准备 native：解析 codex 可执行文件、确认隔离自检通过（同一可执行文件、同样的网络设置）、计算隔离清单、
 * 生成 profile，返回追加到 argv 的 `-c` 参数。任何一步失败都返回错误，调用方据此不启动 Codex（不静默降级为未隔离运行）。
 */
export async function prepareCodexNative(
  o: SeatbeltOptions,
  input: CodexNativeLaunchInput,
): Promise<Result<CodexNativeLaunch>> {
  const codex = resolveExecutable(input.codexBin, input.pathEnv)
  if (!codex)
    return fail(
      'failure',
      'isolation_not_applied',
      `找不到 codex 可执行文件 ${input.codexBin}（按 worker 的 PATH 查找），无法确认与隔离自检使用的是同一个文件`,
    )
  const gate = o.nativeGate
  const checked = gate
    ? gate.check(input.executor, input.sandbox, {
        codex: codex.key,
        network: input.networkEnabled === true,
      })
    : ({ ok: false, reason: '节点没有隔离自检结果（未配置探针）' } as const)
  if (!checked.ok)
    return fail(
      'failure',
      'isolation_not_applied',
      `${checked.reason}；native 只在 ${input.executor} × ${input.sandbox} 最近一次隔离自检通过后启动`,
    )
  if (!input.hubUrl)
    return fail(
      'failure',
      'isolation_hub_url_missing',
      '没有中枢地址，无法计算隔离清单；开关 isolation.enforce 已打开，不启动 harness',
    )
  let hubPort: number
  try {
    hubPort = hubPortOf(input.hubUrl)
  } catch {
    return fail('failure', 'isolation_hub_url_invalid', `中枢地址不合法：${input.hubUrl}`)
  }
  // CODEX_HOME 直接位于 `run/executors/<执行器>/` 下时，按它保留该子目录（与探针一致）；旧位置（state/ 下）时不保留任何子目录。
  const executorHome =
    dirname(input.codexHome) === executorRunDir(input.home, input.executor)
      ? basename(input.codexHome)
      : undefined
  const spec = await computeIsolationSpec({
    home: input.home,
    taskId: input.taskId,
    executor: input.executor,
    ...(executorHome !== undefined ? { executorHome } : {}),
    cwd: input.cwd,
    access: input.access,
    ...(input.leaseTokenFile !== undefined ? { leaseTokenFile: input.leaseTokenFile } : {}),
    hubPort,
    ...(o.resolveOrcaPorts ? { resolveOrcaPorts: o.resolveOrcaPorts } : {}),
    ...(o.userHome !== undefined ? { userHome: o.userHome } : {}),
    ...(o.ageKeyFile !== undefined ? { ageKeyFile: o.ageKeyFile } : {}),
    ...(o.env ? { env: o.env } : {}),
  })
  if (!spec.ok) return spec
  const profile = await codexNativeProfileFromSpec({
    spec: spec.data,
    sandbox: input.sandbox,
    codexHome: input.codexHome,
    authSource: input.authSource,
    codexPath: codex.path,
    cwd: input.cwd,
    access: input.access,
    // 列出 Orca 运行时目录中的套接字（只看目录项类型）；缺省为当前用户主目录，与 computeIsolationSpec 一致。
    userHome: o.userHome ?? homedir(),
    ...(input.networkEnabled ? { networkEnabled: true } : {}),
    ...(input.profileName !== undefined ? { name: input.profileName } : {}),
  })
  if (!profile.ok) return profile
  return ok({
    args: codexNativeConfigValues(profile.data).flatMap((v) => ['-c', v]),
    profile: profile.data,
    codexPath: codex.path,
  })
}

/** native 施加失败时给 worker 结果用的说明。 */
export const nativeFailureMessage = (message: string) =>
  `Codex 原生隔离（native，permissions profile）无法施加（config/node.yaml 的 isolation.enforce 已打开），不启动 harness：${message}`

/** 授权请求的标注：native 下批准即让这条命令在 Codex 沙箱之外执行，脱离隔离（design D4/D5）。 */
export const ISOLATION_ESCAPE_NOTE = '批准即解除本次命令的隔离'

/** `a.b.c` 形式的版本比较；无法解析时返回 undefined。 */
export function compareVersion(a: string, b: string): number | undefined {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  if (pa.length !== 3 || pb.length !== 3 || [...pa, ...pb].some((n) => !Number.isInteger(n)))
    return undefined
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number)
    if (d !== 0) return d
  }
  return 0
}

/** 从 `codex --version` 的输出（例如 `codex-cli 0.167.0`）取版本号。 */
export function parseCodexVersion(stdout: string): string | undefined {
  return /(?:^|\s)v?(\d{1,5}\.\d{1,5}\.\d{1,5})(?:[-+\s]|$)/m.exec(stdout)?.[1]
}

/**
 * 确认 Codex 支持 native（permissions profile 与 `codex sandbox -P`）：运行 `<codex> --version`（不调用模型），
 * 版本低于 `CODEX_NATIVE_MIN_VERSION` 或无法确认时返回 `native_codex_unsupported`。
 */
export function checkCodexNativeSupport(
  codexBin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<Result<string>> {
  return new Promise((resolve) => {
    execFile(codexBin, ['--version'], { timeout: timeoutMs, env }, (err, stdout) => {
      const unsupported = (why: string) =>
        resolve(
          fail(
            'failure',
            'native_codex_unsupported',
            `${why}；native 施加层需要 codex-cli ${CODEX_NATIVE_MIN_VERSION} 及以上（permissions profile 与 codex sandbox -P）`,
          ),
        )
      if (err) return unsupported(`无法运行 ${codexBin} --version`)
      const version = parseCodexVersion(String(stdout ?? ''))
      if (!version) return unsupported('无法从 codex --version 的输出中识别版本')
      const cmp = compareVersion(version, CODEX_NATIVE_MIN_VERSION)
      if (cmp === undefined || cmp < 0) return unsupported(`Codex 版本 ${version} 过低`)
      resolve(ok(version))
    })
  })
}
