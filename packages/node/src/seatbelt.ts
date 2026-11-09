import {
  type CredentialIsolation,
  computeIsolationSpec,
  type Env,
  fail,
  type HarnessPath,
  type IsolationLayer,
  type IsolationSpec,
  ok,
  type Result,
  type Role,
  renderSeatbeltProfile,
  roleSandboxSetting,
} from '@raindown/core'
import { writeSeatbeltProfile } from './lease-token.ts'

/**
 * 外层 seatbelt 的施加（add-worker-credential-isolation 4.1–4.4）。
 *
 * 开关是节点级的 `config/node.yaml` 中 `isolation.enforce`（缺省 false）。关闭时各适配器不调用本模块的施加路径，
 * harness 的启动命令与之前逐字节一致；能力声明也与之前相同（`enforced: false`）。
 * 打开后（仅 macOS），角色沙箱设置的施加层为 `seatbelt` 时：节点计算隔离清单（`computeIsolationSpec`）、生成 SBPL
 * （`renderSeatbeltProfile`）写入 `run/tasks/<任务>/isolation.sb`（0600），以 `/usr/bin/sandbox-exec -f <配置>` 包裹 harness。
 * 任何一步失败都不启动 harness（不静默降级为未隔离运行）。
 */

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** 本阶段已实现的施加层：只有外层 seatbelt。`native`（Codex permissions profile）留给 tasks 5.1。 */
export const IMPLEMENTED_ISOLATION_LAYERS: readonly IsolationLayer[] = ['seatbelt']

export interface SeatbeltOptions {
  /** `config/node.yaml` 的 `isolation.enforce`；缺省 false。 */
  enforce: boolean
  /** `sandbox-exec` 的路径，缺省 `/usr/bin/sandbox-exec`。 */
  sandboxExec?: string
  /** 运行平台，缺省 `process.platform`；非 macOS 时开关不起作用（声明与启动都不变）。 */
  platform?: NodeJS.Platform
  /** 用户主目录（私钥、Orca 目录、LaunchAgents 的来源）；缺省 `os.homedir()`，测试注入临时目录。 */
  userHome?: string
  /** 解析遗留 home 时读取的环境变量；缺省 `process.env`，测试注入 `{}`。 */
  env?: Env
  /** age 私钥文件；缺省按 secrets 的规则。 */
  ageKeyFile?: string
  /** Orca 本机端口解析；缺省未解析（不生成端口拒绝规则，探针与 doctor 显示“跳过”）。 */
  resolveOrcaPorts?: () => Promise<number[]> | number[]
}

/** 开关是否在本机生效：打开且运行在 macOS 上。 */
export const seatbeltActive = (o?: SeatbeltOptions): o is SeatbeltOptions =>
  o?.enforce === true && (o.platform ?? process.platform) === 'darwin'

/**
 * 适配器上报的凭证隔离声明。开关未生效时原样返回（只声明、`enforced: false`）；
 * 生效时只保留已实现的施加层，其余（`native` 等）改为 `none` 并标记 `enforced: true`：未实现的施加层不能显示为已施加。
 */
export function effectiveCredentialIsolation(
  declared: CredentialIsolation,
  o?: SeatbeltOptions,
): CredentialIsolation {
  if (!seatbeltActive(o)) return declared
  const layers: Record<string, string> = {}
  for (const [setting, layer] of Object.entries(declared.layers))
    layers[setting] = (IMPLEMENTED_ISOLATION_LAYERS as readonly string[]).includes(layer)
      ? layer
      : 'none'
  return { layers, enforced: true }
}

/** 该角色在该执行器上是否施加外层 seatbelt：开关生效，且角色沙箱设置对应的施加层为 `seatbelt`。 */
export function seatbeltApplies(
  capability: CredentialIsolation,
  role: Pick<Role, 'executor' | 'permissions'>,
  o?: SeatbeltOptions,
): o is SeatbeltOptions {
  if (!seatbeltActive(o) || !capability.enforced) return false
  const setting = roleSandboxSetting(role)
  return setting !== undefined && capability.layers[setting] === 'seatbelt'
}

/** 中枢地址中的端口（隔离清单放行的本机端口）。 */
export function hubPortOf(hubUrl: string): number {
  const u = new URL(hubUrl)
  if (u.port) return Number(u.port)
  return u.protocol === 'https:' ? 443 : 80
}

/** 写入配置并给出命令前缀（`[sandbox-exec, -f, <配置>]`）；探针与 worker 共用。 */
export async function writeSeatbeltLaunch(
  o: Pick<SeatbeltOptions, 'sandboxExec'>,
  home: string,
  taskId: string,
  spec: IsolationSpec,
): Promise<Result<{ profilePath: string; prefix: string[] }>> {
  const profile = renderSeatbeltProfile(spec)
  if (!profile.ok) return profile
  try {
    const profilePath = await writeSeatbeltProfile(home, taskId, profile.data)
    return ok({ profilePath, prefix: [o.sandboxExec ?? SANDBOX_EXEC, '-f', profilePath] })
  } catch (err) {
    return fail(
      'failure',
      'isolation_profile_write_failed',
      `无法写入外层 seatbelt 配置：${(err as Error).message}`,
    )
  }
}

export interface SeatbeltLaunchInput {
  home: string
  taskId: string
  executor: string
  /** `run/executors/<执行器>/` 下本次使用的 harness 子目录名（例如 `codex-home`）。 */
  executorHome?: string
  cwd: string
  access: 'read' | 'write'
  leaseTokenFile?: string
  hubUrl?: string
  harnessPaths?: readonly HarnessPath[]
}

/**
 * 为一次 harness 启动准备外层 seatbelt：计算隔离清单、生成并写入配置，返回命令前缀。
 * 失败时返回错误，调用方据此不启动 harness。
 */
export async function prepareSeatbelt(
  o: SeatbeltOptions,
  input: SeatbeltLaunchInput,
): Promise<Result<{ profilePath: string; prefix: string[] }>> {
  if (!input.hubUrl)
    return fail(
      'failure',
      'isolation_hub_url_missing',
      '没有中枢地址，无法计算隔离清单（中枢端口）；开关 isolation.enforce 已打开，不启动 harness',
    )
  let hubPort: number
  try {
    hubPort = hubPortOf(input.hubUrl)
  } catch {
    return fail('failure', 'isolation_hub_url_invalid', `中枢地址不合法：${input.hubUrl}`)
  }
  const spec = await computeIsolationSpec({
    home: input.home,
    taskId: input.taskId,
    executor: input.executor,
    ...(input.executorHome !== undefined ? { executorHome: input.executorHome } : {}),
    cwd: input.cwd,
    access: input.access,
    ...(input.leaseTokenFile !== undefined ? { leaseTokenFile: input.leaseTokenFile } : {}),
    ...(input.harnessPaths ? { harnessPaths: input.harnessPaths } : {}),
    hubPort,
    ...(o.resolveOrcaPorts ? { resolveOrcaPorts: o.resolveOrcaPorts } : {}),
    ...(o.userHome !== undefined ? { userHome: o.userHome } : {}),
    ...(o.ageKeyFile !== undefined ? { ageKeyFile: o.ageKeyFile } : {}),
    ...(o.env ? { env: o.env } : {}),
  })
  if (!spec.ok) return spec
  return writeSeatbeltLaunch(o, input.home, input.taskId, spec.data)
}

/** 施加失败时给 worker 结果用的说明（带上原错误码与原因）。 */
export const seatbeltFailureMessage = (message: string) =>
  `外层 seatbelt 无法施加（config/node.yaml 的 isolation.enforce 已打开），不启动 harness：${message}`
