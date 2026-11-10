import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
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
  roleSandboxSetting,
} from '@raindown/core'
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
  /** `auth.json` 链接的源目录（用户平时的 CODEX_HOME）；拒绝其中的 `auth.json`。 */
  authSource: string
  /** 用户主目录（列出 Orca 运行时目录中的套接字）。 */
  userHome?: string
  networkEnabled?: boolean
  name?: string
}

/** 由隔离清单生成 native profile（worker 启动与探针共用）。 */
export async function codexNativeProfileFromSpec(
  input: CodexNativeProfileFromSpec,
): Promise<Result<CodexNativeProfile>> {
  try {
    const codexHome = await canonicalPath(input.codexHome)
    const sockets = input.userHome ? await findOrcaSockets(input.userHome) : undefined
    return codexNativeProfile({
      spec: input.spec,
      sandbox: input.sandbox,
      name: input.name ?? codexNativeProfileName(),
      extraDeny: [codexHome, await canonicalPath(join(input.authSource, 'auth.json'))],
      extraRead: [join(codexHome, 'tmp')],
      ...(sockets?.status === 'found' ? { unixSockets: sockets.paths } : {}),
      ...(input.networkEnabled ? { networkEnabled: true } : {}),
    })
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
  leaseTokenFile?: string
  hubUrl?: string
  networkEnabled?: boolean
  /** 测试注入固定的 profile 名。 */
  profileName?: string
}

/**
 * 为一次 Codex 启动准备 native：计算隔离清单、生成 profile，返回追加到 argv 的 `-c` 参数。
 * 任何一步失败都返回错误，调用方据此不启动 Codex（不静默降级为未隔离运行）。
 */
export async function prepareCodexNative(
  o: SeatbeltOptions,
  input: CodexNativeLaunchInput,
): Promise<Result<{ args: string[]; profile: CodexNativeProfile }>> {
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
    // 列出 Orca 运行时目录中的套接字（只看目录项类型）；缺省为当前用户主目录，与 computeIsolationSpec 一致。
    userHome: o.userHome ?? homedir(),
    ...(input.networkEnabled ? { networkEnabled: true } : {}),
    ...(input.profileName !== undefined ? { name: input.profileName } : {}),
  })
  if (!profile.ok) return profile
  return ok({
    args: codexNativeConfigValues(profile.data).flatMap((v) => ['-c', v]),
    profile: profile.data,
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
