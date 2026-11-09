import type { AdapterCapabilities, IsolationLayer, SandboxSetting } from '../ledger/adapter.ts'
import type { Role } from '../roles.ts'

const CODEX_SANDBOXES: readonly string[] = ['danger-full-access', 'workspace-write', 'read-only']

const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

const codexSandbox = (v: unknown): SandboxSetting | undefined =>
  typeof v === 'string' && CODEX_SANDBOXES.includes(v) ? (v as SandboxSetting) : undefined

/**
 * 角色的沙箱设置（D1 的表的行）；无法确定时返回 undefined，按 `none` 处理（方向保守）。
 * - codex-exec：`permissions.sandbox`，缺省 read-only（执行器总是传 `-s`，它优先于 config 中的 sandbox_mode）；
 * - codex-orca：`approval: never` + `danger-full-access` 是 bypass，同属 danger-full-access；
 *   其次 `permissions.sandbox`，再次 `permissions.config.sandbox_mode`（不传 `-s` 时生效）；都没有时由 Codex 自行决定，无法确定；
 * - claude-sdk：Raindown 目前不向 SDK 传 `sandbox` 选项，bash 沙箱关闭；
 * - pr-merge：节点内执行。
 */
export function roleSandboxSetting(
  role: Pick<Role, 'executor' | 'permissions'>,
): SandboxSetting | undefined {
  const p = role.permissions ?? {}
  switch (role.executor) {
    case 'codex-exec':
      return p.sandbox === undefined ? 'read-only' : codexSandbox(p.sandbox)
    case 'codex-orca':
      return codexSandbox(p.sandbox) ?? codexSandbox(record(p.config)?.sandbox_mode)
    case 'claude-sdk':
      return 'bash-sandbox-off'
    case 'pr-merge':
      return 'in-node'
    default:
      return undefined
  }
}

/** 某执行器在某沙箱设置下的隔离声明，供展示与（后续）派送使用。 */
export interface CredentialIsolationView {
  /** 节点是否上报了 `credential_isolation`；旧节点为 false。 */
  reported: boolean
  /** 声明的施加层；未上报、设置未知或未列出时为 none。 */
  layer: IsolationLayer
  /** 适配器是否已经真正施加；只有为 true 且自检通过才能算已隔离。 */
  enforced: boolean
}

export function credentialIsolationFor(
  capabilities: Pick<AdapterCapabilities, 'credential_isolation'>,
  setting: SandboxSetting | undefined,
): CredentialIsolationView {
  const declared = capabilities.credential_isolation
  if (!declared) return { reported: false, layer: 'none', enforced: false }
  const layer = setting === undefined ? 'none' : (declared.layers[setting] ?? 'none')
  return { reported: true, layer, enforced: declared.enforced && layer !== 'none' }
}

/** 一行文字描述执行器的隔离声明（`node list` 等展示用），明确标出“未施加”。 */
export function describeCredentialIsolation(
  capabilities: Pick<AdapterCapabilities, 'credential_isolation'>,
): string {
  const declared = capabilities.credential_isolation
  if (!declared) return '未上报（按 none 处理）'
  const entries = Object.entries(declared.layers)
  const layers = entries.length ? entries.map(([k, v]) => `${k}→${v}`).join('、') : 'none'
  return `${layers}（${declared.enforced ? '已施加，以自检结果为准' : '仅声明，未施加'}）`
}
