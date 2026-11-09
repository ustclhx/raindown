import { z } from 'zod'

/**
 * 凭证隔离的施加层（add-worker-credential-isolation D1）：外层 seatbelt、harness 原生读限制、独立系统用户，
 * 或不提供隔离。
 */
export const ISOLATION_LAYERS = ['seatbelt', 'native', 'separate_user', 'none'] as const
export const isolationLayer = z.enum(ISOLATION_LAYERS)
export type IsolationLayer = z.infer<typeof isolationLayer>

/**
 * 角色的沙箱设置（决定可用的施加层，D1 的表）。由 `roleSandboxSetting` 从角色配置推出：
 * - codex：`danger-full-access`（含 bypass）、`workspace-write`、`read-only`；
 * - claude-sdk：`bash-sandbox-off`、`bash-sandbox-on`，以及 supervisor 唤醒会话 `supervisor-session`（不施加外层隔离）；
 * - `in-node`：在节点进程内执行、不启动 harness（pr-merge）。
 * 键在注册时只校验格式，未来的新设置不会让旧中枢拒绝注册。
 */
export const SANDBOX_SETTINGS = [
  'danger-full-access',
  'workspace-write',
  'read-only',
  'bash-sandbox-off',
  'bash-sandbox-on',
  'supervisor-session',
  'in-node',
] as const
export type SandboxSetting = (typeof SANDBOX_SETTINGS)[number]
const sandboxSettingKey = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
/** 写侧接受格式合法的未知施加层（较新节点的新取值不会让旧中枢拒绝注册），读侧与查询按 none 处理。 */
const futureLayer = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)

export const credentialIsolation = z
  .object({
    layers: z.record(sandboxSettingKey, isolationLayer.or(futureLayer)).meta({
      description: `按角色沙箱设置声明的施加层（已知取值：${ISOLATION_LAYERS.join('、')}；不认识的取值按 none）；已知设置：${SANDBOX_SETTINGS.join('、')}。未列出的设置视为 none`,
    }),
    enforced: z.boolean().meta({
      description:
        '适配器当前是否真正施加上述隔离。false 表示只是声明将要支持的施加层，尚未施加，不能显示为已隔离；自检结果另行上报',
    }),
  })
  .meta({ title: 'Credential isolation' })
export type CredentialIsolation = z.infer<typeof credentialIsolation>

/**
 * 读侧逐项降级：格式合法的未知施加层原样保留（展示时标明“未知”，`credentialIsolationFor` 按 none 处理），
 * 不合法的取值按 none；layers 或 enforced 不合法时分别退回空表与 false。
 */
const readCredentialIsolation = z.object({
  layers: z.record(z.string(), isolationLayer.or(futureLayer).catch('none')).catch({}),
  enforced: z.boolean().catch(false),
})

/**
 * 适配器的交互能力（D1）；与派送匹配用的 `executor:<type>` 等字符串标签无关。
 * resume_session 指进程结束后仍能继续同一个 harness 会话，重新挂接存活终端不算恢复。
 * raindown_mcp 指具有任务绑定且可调用 raindown_report，仅加载知识库 MCP 不算。
 */
export const adapterCapabilities = z
  .object({
    approval_requests: z.enum(['structured', 'inferred', 'none']),
    inject_while_running: z.boolean(),
    resume_session: z.boolean().meta({ description: '进程结束后仍能继续同一个 harness 会话' }),
    raindown_mcp: z.boolean(),
    out_of_band_detection: z.boolean(),
    credential_isolation: credentialIsolation.optional().meta({
      description: '凭证隔离的施加层声明；旧节点不上报时视为未知（按 none 处理）',
    }),
  })
  .meta({ title: 'Adapter capabilities' })
export type AdapterCapabilities = z.infer<typeof adapterCapabilities>

/** 旧节点未上报能力时采用保守缺省；不按执行器类型推断。`credential_isolation` 缺省为未上报。 */
export const NO_ADAPTER_CAPABILITIES: Readonly<AdapterCapabilities> = Object.freeze({
  approval_requests: 'none',
  inject_while_running: false,
  resume_session: false,
  raindown_mcp: false,
  out_of_band_detection: false,
})

/** 读取旧账本或新版本投影时，剥离未知键；不认识或缺少的字段逐项退回保守值。 */
export const readAdapterCapabilities = z
  .object({
    approval_requests: adapterCapabilities.shape.approval_requests.catch(
      NO_ADAPTER_CAPABILITIES.approval_requests,
    ),
    inject_while_running: z.boolean().catch(NO_ADAPTER_CAPABILITIES.inject_while_running),
    resume_session: z.boolean().catch(NO_ADAPTER_CAPABILITIES.resume_session),
    raindown_mcp: z.boolean().catch(NO_ADAPTER_CAPABILITIES.raindown_mcp),
    out_of_band_detection: z.boolean().catch(NO_ADAPTER_CAPABILITIES.out_of_band_detection),
    credential_isolation: readCredentialIsolation.optional().catch(undefined),
  })
  .catch({ ...NO_ADAPTER_CAPABILITIES })
