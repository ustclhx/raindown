import type { AdapterCapabilities, SandboxSetting } from '../ledger/adapter.ts'
import {
  findProbeRun,
  type IsolationProbeReport,
  PROBE_MAX_AGE_MS,
  probeRunPassed,
} from '../ledger/isolation-probe.ts'
import type { TaskContract } from '../ledger/task.ts'
import { type Role, type RoleIsolation, roleIsolationOf } from '../roles.ts'
import {
  type CredentialIsolationView,
  credentialIsolationFor,
  roleSandboxSetting,
} from './capability.ts'
import { probeRunSummary } from './probe.ts'

/**
 * 角色隔离要求的判定（add-worker-credential-isolation 6.1）。中枢派送与节点启动 harness 前的兜底共用。
 *
 * 卡住原因码：`blocked(other)` 的 message 以 `isolation_unavailable：` 开头（`blocked_reason` 枚举不变，旧节点与旧中枢兼容）。
 */
export const ISOLATION_UNAVAILABLE = 'isolation_unavailable'

/**
 * 按设计不施加凭证隔离的沙箱设置：supervisor 唤醒会话与节点内执行（pr-merge）。`preferred` 不对它们标注“未隔离”，
 * `required` 在角色加载时即被拒绝（`requiredIsolationUnsupported`）。
 */
export const ISOLATION_NOT_APPLICABLE_SETTINGS: readonly SandboxSetting[] = [
  'supervisor-session',
  'in-node',
]

/** 任务对应的隔离要求与沙箱设置。 */
export interface RoleIsolationTarget {
  role: string
  requirement: RoleIsolation
  /** 合同执行器 × 角色权限推出的沙箱设置；无法确定时 undefined（按 none）。 */
  setting: SandboxSetting | undefined
}

/**
 * 按角色配置给出任务的隔离要求。节点按**合同**的执行器运行、按角色取权限，所以沙箱设置用合同执行器推出；
 * 角色未定义时返回 undefined（调用方按缺省 preferred 处理或不检查）。
 */
export function roleIsolationTarget(
  role:
    | (Pick<Role, 'name' | 'executor' | 'permissions'> & Partial<Pick<Role, 'kind' | 'isolation'>>)
    | null
    | undefined,
  contract: Pick<TaskContract, 'executor'>,
): RoleIsolationTarget | undefined {
  if (!role) return undefined
  return {
    role: role.name,
    requirement: roleIsolationOf(role),
    setting: roleSandboxSetting({ ...role, executor: contract.executor }),
  }
}

/** 节点上某执行器的隔离判定：view 与（未施加时）缺什么。 */
export interface IsolationAssessment {
  view: CredentialIsolationView
  /** 未施加时的原因（开关关闭 / 平台不支持 / 施加层 none / 未探测 / 过期 / 探针失败项）；已施加时为空。 */
  missing: string[]
}

export interface AssessIsolationInput {
  /** 执行器的能力；旧节点没有上报执行器信息时传 `{}`（按未上报处理）。 */
  capabilities: Pick<AdapterCapabilities, 'credential_isolation'>
  setting: SandboxSetting | undefined
  /** 节点最近一次上报（或本地）的探针结果。 */
  probe: IsolationProbeReport | null | undefined
  executor: string
  now?: number
  /** 节点本地判断时给出运行平台，用来区分“平台不支持”与“开关关闭”。中枢不知道，缺省不区分。 */
  platform?: string
}

/** 判定某节点的某执行器 × 沙箱设置是否已施加隔离，并列出缺什么。 */
export function assessIsolation(o: AssessIsolationInput): IsolationAssessment {
  const now = o.now ?? Date.now()
  const caps = o.capabilities
  const run = o.setting === undefined ? undefined : findProbeRun(o.probe, o.executor, o.setting)
  const view = credentialIsolationFor(
    caps,
    o.setting,
    run && o.probe ? { run, ran_at: o.probe.ran_at } : null,
    now,
  )
  if (view.enforced) return { view, missing: [] }
  const declared = caps.credential_isolation
  if (!declared)
    return { view, missing: [`执行器 ${o.executor} 未上报凭证隔离能力（旧节点，按 none 处理）`] }
  if (o.setting === undefined) return { view, missing: ['无法确定角色的沙箱设置（按 none 处理）'] }
  const missing: string[] = []
  if (!declared.enforced) {
    missing.push(
      o.platform === undefined
        ? '适配器未施加隔离（开关 config/node.yaml isolation.enforce 关闭，或平台不支持）'
        : o.platform !== 'darwin'
          ? `平台 ${o.platform} 不支持隔离（外层 seatbelt 仅 macOS）`
          : '隔离开关关闭（config/node.yaml isolation.enforce）',
    )
  }
  if (view.layer === 'none') missing.push(`${o.executor} × ${o.setting} 的施加层为 none`)
  if (declared.enforced && view.layer !== 'none') {
    if (!run || !o.probe) missing.push(`${o.executor} × ${o.setting} 没有隔离自检结果（未探测）`)
    else {
      const ranAt = Date.parse(o.probe.ran_at)
      const fresh =
        Number.isFinite(ranAt) && now - ranAt <= PROBE_MAX_AGE_MS && ranAt - now <= PROBE_MAX_AGE_MS
      if (!fresh) missing.push(`隔离自检结果已过期（${o.probe.ran_at}）`)
      if (!probeRunPassed(run)) {
        if (run.error) missing.push(`隔离自检无法运行：${run.error.code} ${run.error.message}`)
        const failed = probeRunSummary(run).failed
        missing.push(failed.length ? `隔离自检失败项：${failed.join('；')}` : '隔离自检未通过')
      }
    }
  }
  if (missing.length === 0) missing.push('隔离未施加')
  return { view, missing }
}

/** `blocked(other)` 的消息：以 `isolation_unavailable：` 开头，说明角色要求与缺什么。 */
export function isolationUnavailableMessage(
  target: Pick<RoleIsolationTarget, 'role' | 'setting'>,
  executor: string,
  details: readonly string[],
): string {
  return [
    `${ISOLATION_UNAVAILABLE}：角色 ${target.role} 要求隔离（isolation: required），${executor} × ${target.setting ?? '未知沙箱设置'} 没有可用的已隔离节点，未启动 harness`,
    ...details.map((d) => `- ${d}`),
    '恢复隔离（开关、平台、自检通过并重新注册）后重试任务（task_retry）',
  ].join('\n')
}

/** 卡住消息是否为隔离不可用。 */
export const isIsolationUnavailable = (message: string | undefined): boolean =>
  message?.startsWith(`${ISOLATION_UNAVAILABLE}：`) === true
