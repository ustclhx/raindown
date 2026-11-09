import {
  type AdapterCapabilities,
  ISOLATION_LAYERS,
  type IsolationLayer,
  type SandboxSetting,
} from '../ledger/adapter.ts'
import {
  type IsolationProbeRun,
  PROBE_MAX_AGE_MS,
  probeRunPassed,
} from '../ledger/isolation-probe.ts'
import type { Role } from '../roles.ts'

const CODEX_SANDBOXES: readonly string[] = ['danger-full-access', 'workspace-write', 'read-only']

const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/** `-c` 的值按 TOML 解析：`"danger-full-access"` 与 `'danger-full-access'` 都是同一个字符串，比较前去掉一层引号。 */
const unquote = (v: string): string => {
  const t = v.trim()
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0] ? t.slice(1, -1) : t
}

const codexSandbox = (v: unknown): SandboxSetting | undefined => {
  if (typeof v !== 'string') return undefined
  const s = unquote(v)
  return CODEX_SANDBOXES.includes(s) ? (s as SandboxSetting) : undefined
}

/** 角色沙箱设置及无法确定时的原因（doctor 展示）。 */
export interface RoleSandboxInfo {
  setting?: SandboxSetting
  reason?: string
}

/** 间接决定沙箱的 Codex 配置键：生效值取决于 profile 内容，Raindown 不解析。 */
const CODEX_INDIRECT_KEYS = ['profile', 'default_permissions'] as const

/**
 * 角色的沙箱设置（D1 的表的行）；无法确定时没有 `setting`，按 `none` 处理（方向保守），并给出原因。
 * - codex-exec：`permissions.sandbox`，缺省 read-only（执行器总是传 `-s`，它优先于 config 与 profile）；
 * - codex-orca：`approval: never` + `danger-full-access` 是 bypass，同属 danger-full-access；
 *   其次 `permissions.sandbox`（`-s`），再次 `permissions.config.sandbox_mode`（不传 `-s` 时生效，值可带 TOML 引号）；
 *   经 `profile` / `default_permissions` 间接指定或都没有时无法确定；
 * - claude-sdk：Raindown 目前不向 SDK 传 `sandbox` 选项，bash 沙箱关闭（项目设置能否开启见 tasks 4.4）；
 * - pr-merge：节点内执行。
 */
export function roleSandboxInfo(role: Pick<Role, 'executor' | 'permissions'>): RoleSandboxInfo {
  const p = role.permissions ?? {}
  const unknown = (reason: string): RoleSandboxInfo => ({ reason })
  switch (role.executor) {
    case 'codex-exec': {
      if (p.sandbox === undefined) return { setting: 'read-only' }
      const setting = codexSandbox(p.sandbox)
      return setting ? { setting } : unknown(`不认识的 sandbox 取值 ${JSON.stringify(p.sandbox)}`)
    }
    case 'codex-orca': {
      if (p.sandbox !== undefined) {
        const setting = codexSandbox(p.sandbox)
        return setting ? { setting } : unknown(`不认识的 sandbox 取值 ${JSON.stringify(p.sandbox)}`)
      }
      const config = record(p.config) ?? {}
      const indirect = CODEX_INDIRECT_KEYS.filter((k) => config[k] !== undefined)
      if (indirect.length)
        return unknown(`沙箱经 config.${indirect.join('、config.')} 间接指定，Raindown 无法确定`)
      if (config.sandbox_mode !== undefined) {
        const setting = codexSandbox(config.sandbox_mode)
        return setting
          ? { setting }
          : unknown(`不认识的 config.sandbox_mode 取值 ${JSON.stringify(config.sandbox_mode)}`)
      }
      return unknown('没有设置 sandbox 或 config.sandbox_mode，由 Codex 自行决定')
    }
    case 'claude-sdk':
      return { setting: 'bash-sandbox-off' }
    case 'pr-merge':
      return { setting: 'in-node' }
    default:
      return unknown(`执行器 ${role.executor} 没有沙箱设置的定义`)
  }
}

export function roleSandboxSetting(
  role: Pick<Role, 'executor' | 'permissions'>,
): SandboxSetting | undefined {
  return roleSandboxInfo(role).setting
}

const knownLayer = (v: string | undefined): IsolationLayer =>
  v !== undefined && (ISOLATION_LAYERS as readonly string[]).includes(v)
    ? (v as IsolationLayer)
    : 'none'

/** 某执行器在某沙箱设置下的隔离声明，供展示与（后续）派送使用。 */
export interface CredentialIsolationView {
  /** 节点是否上报了 `credential_isolation`；旧节点为 false。 */
  reported: boolean
  /** 声明的施加层；未上报、设置未知或未列出时为 none。 */
  layer: IsolationLayer
  /** 适配器声明已施加、施加层非 none 且最近一次探针通过时为 true。 */
  enforced: boolean
}

/** 一次探针运行及其所属报告的运行时间（判断是否过期）。 */
export interface ProbeEvidence {
  run: IsolationProbeRun
  ran_at: string
}

/**
 * `enforced` 由探针决定（worker-credential-isolation 3.2）：适配器声明已施加、施加层不是 none，
 * 该执行器 × 沙箱设置最近一次探针（按条目重新计算）全部通过，并且结果没有过期（`PROBE_MAX_AGE_MS`）才为 true。
 * 没有探针结果（旧节点、未探测）一律为 false。
 */
export function credentialIsolationFor(
  capabilities: Pick<AdapterCapabilities, 'credential_isolation'>,
  setting: SandboxSetting | undefined,
  probe?: ProbeEvidence | null,
  now: number = Date.now(),
): CredentialIsolationView {
  const declared = capabilities.credential_isolation
  if (!declared) return { reported: false, layer: 'none', enforced: false }
  // 较新节点上报的未知施加层按 none（只能收紧，不能被当作已支持的隔离）。
  const layer = setting === undefined ? 'none' : knownLayer(declared.layers[setting])
  const ranAt = probe ? Date.parse(probe.ran_at) : Number.NaN
  const fresh =
    Number.isFinite(ranAt) && now - ranAt <= PROBE_MAX_AGE_MS && ranAt - now <= PROBE_MAX_AGE_MS
  const probed =
    probe != null && probe.run.setting === setting && fresh && probeRunPassed(probe.run)
  return { reported: true, layer, enforced: declared.enforced && layer !== 'none' && probed }
}

/** 一行文字描述执行器的隔离声明（`node list` 等展示用），明确标出“未施加”。 */
export function describeCredentialIsolation(
  capabilities: Pick<AdapterCapabilities, 'credential_isolation'>,
): string {
  const declared = capabilities.credential_isolation
  if (!declared) return '未上报（按 none 处理）'
  const entries = Object.entries(declared.layers)
  const layers = entries.length
    ? entries
        .map(([k, v]) => `${k}→${knownLayer(v) === v ? v : `${v}（未知，按 none）`}`)
        .join('、')
    : 'none'
  return `${layers}（${declared.enforced ? '适配器已施加，是否生效以自检结果为准' : '仅声明，未施加'}）`
}
