import { z } from 'zod'
import { executorType, timestamp } from './common.ts'

/**
 * 隔离自检探针的结果（add-worker-credential-isolation D6，tasks 3.1–3.2）。随节点注册上报，中枢投影保存最近一次。
 *
 * 结果只含项名、目标路径/端口、预期与实际，**不含受保护文件的内容**：探针只判断能否打开，读取最多 1 字节且不记录。
 */

/** 探针项的预期：受保护项应被拒绝，允许项应可用。 */
export const PROBE_EXPECTATIONS = ['deny', 'allow'] as const
/**
 * 实际结果：
 * - `deny` / `allow`：确实被拒绝 / 确实成功；
 * - `skipped`：目标不存在或未解析（例如没有 Orca 套接字、Orca 端口未解析），无法尝试；
 * - `unverified`：探针无法可靠地验证（例如跨进程调试），如实标为未验证；
 * - `error`：出现无法归类的错误（按失败处理）。
 */
export const PROBE_ACTUALS = ['deny', 'allow', 'skipped', 'unverified', 'error'] as const

const probeItemId = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/)

export const isolationProbeItem = z
  .object({
    item: probeItemId.meta({ description: '探针项标识，例如 read.hub_token' }),
    target: z
      .string()
      .max(1024)
      .optional()
      .meta({ description: '尝试访问的路径、套接字或 host:port；不含任何文件内容' }),
    expected: z.enum(PROBE_EXPECTATIONS),
    actual: z.enum(PROBE_ACTUALS),
    ok: z.boolean().nullable().meta({
      description: '实际是否符合预期；skipped / unverified 为 null（既不算通过也不算失败）',
    }),
    detail: z
      .string()
      .max(500)
      .optional()
      .meta({ description: '说明：错误码（如 EACCES）、跳过或未验证的原因' }),
  })
  .meta({ title: 'Isolation probe item' })
export type IsolationProbeItem = z.infer<typeof isolationProbeItem>

export const isolationProbeRun = z
  .object({
    executor: executorType,
    setting: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .meta({ description: '角色沙箱设置' }),
    declared_layer: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .meta({ description: '适配器为该沙箱设置声明的施加层' }),
    applied_layer: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .meta({ description: '探针实际运行时所用的施加层；适配器尚未施加时为 none' }),
    passed: z.boolean().meta({
      description:
        '受保护项全部被拒绝、允许项全部可用（跳过与未验证不计入），且至少一个受保护项确实被拒绝',
    }),
    items: z.array(isolationProbeItem).max(64),
    error: z
      .object({ code: z.string().max(64), message: z.string().max(1000) })
      .optional()
      .meta({ description: '探针无法运行的原因（例如隔离清单计算失败）；此时 passed 为 false' }),
  })
  .meta({ title: 'Isolation probe run' })
export type IsolationProbeRun = z.infer<typeof isolationProbeRun>

export const isolationProbeReport = z
  .object({
    ran_at: timestamp,
    macos_version: z.string().max(64).nullable().meta({ description: '运行时的 macOS 版本' }),
    runs: z.array(isolationProbeRun).max(64),
  })
  .meta({ title: 'Isolation probe report' })
export type IsolationProbeReport = z.infer<typeof isolationProbeReport>

/** 读侧：不合法的结果按"未探测"（null）处理，不让投影读取失败。 */
export const readIsolationProbeReport = isolationProbeReport.nullable().catch(null)

/** 每次运行都必须出现、并且确实被拒绝的核心受保护项；缺任何一项都不能算通过。 */
export const PROBE_REQUIRED_DENY_ITEMS = [
  'read.hub_token',
  'read.ledger_db',
  'read.other_task_token',
  'write.config',
  // 审查第一轮 H1、H2：受保护路径的祖先目录不可改名；本任务实际使用的 seatbelt 配置不可改写。
  'rename.protected_ancestor',
  'write.own_profile',
  // tasks 4.6 写白名单：白名单之外（模拟的 shell 启动文件）与登记仓库的 .git/hooks 不可写。
  'write.shell_startup',
  'write.git_hooks',
  // 审查第一轮 H1：登记仓库的 .git 对 worker 整体只读（worker 在本任务的独立 clone 中工作）。
  'write.registered_git',
  // 审查第二轮 L1、H1：共享的系统临时目录不可写；独立 clone 的 .git/commondir 不可写。
  'write.shared_tmp',
  'write.git_commondir',
] as const

/**
 * `native` 施加层（Codex permissions profile，tasks 5.1）的核心受保护项：与 seatbelt 相同的读拒绝项、`config/` 不可写、
 * 受保护路径的祖先不可改名，以及白名单之外的模拟 shell 启动文件不可写（Codex 沙箱只放行工作区与临时目录）。
 * seatbelt 专有的项不适用：配置经命令行 `-c` 传入，没有可改写的配置文件（`write.own_profile`）；
 * git 目录与共享临时目录的写入由 Codex 沙箱语义决定，不是 Raindown 的写白名单（`write.git_*`、`write.registered_git`、`write.shared_tmp`）。
 */
export const PROBE_NATIVE_REQUIRED_DENY_ITEMS = [
  'read.hub_token',
  'read.ledger_db',
  'read.other_task_token',
  'write.config',
  'rename.protected_ancestor',
  'write.shell_startup',
] as const

/** 某施加层的核心受保护项：native 用 `PROBE_NATIVE_REQUIRED_DENY_ITEMS`，其余（seatbelt、none 等）用 `PROBE_REQUIRED_DENY_ITEMS`。 */
export function probeRequiredDenyItems(appliedLayer?: string): readonly string[] {
  return appliedLayer === 'native' ? PROBE_NATIVE_REQUIRED_DENY_ITEMS : PROBE_REQUIRED_DENY_ITEMS
}

/**
 * 由预期与实际重新计算 `ok`，不信任上报值：deny / allow 时为 `actual === expected`；
 * skipped / unverified 为 null；error 为 false。
 */
export function probeItemOk(i: Pick<IsolationProbeItem, 'expected' | 'actual'>): boolean | null {
  if (i.actual === 'skipped' || i.actual === 'unverified') return null
  if (i.actual === 'error') return false
  return i.actual === i.expected
}

/**
 * 按条目重新计算一次运行是否通过，**不信任上报的 `ok` 与 `passed`**：没有运行错误，没有（重新计算后）不符合预期的项，
 * 并且核心受保护项（按实际施加层，`probeRequiredDenyItems`）全部出现且确实被拒绝（全部跳过或缺项不能算通过）。
 */
export function probeRunPassed(
  run: Pick<IsolationProbeRun, 'items' | 'error'> & { applied_layer?: string },
): boolean {
  if (run.error) return false
  if (run.items.some((i) => probeItemOk(i) === false)) return false
  return probeRequiredDenyItems(run.applied_layer).every((id) =>
    run.items.some((i) => i.item === id && i.expected === 'deny' && i.actual === 'deny'),
  )
}

/** 中枢写入前规范化：逐项重算 `ok`、逐次运行重算 `passed`，节点上报的这两个值一律不用。 */
export function normalizeProbeReport(report: IsolationProbeReport): IsolationProbeReport {
  return {
    ...report,
    runs: report.runs.map((run) => {
      const items = run.items.map((i) => ({ ...i, ok: probeItemOk(i) }))
      return {
        ...run,
        items,
        passed: probeRunPassed({
          items,
          applied_layer: run.applied_layer,
          ...(run.error ? { error: run.error } : {}),
        }),
      }
    }),
  }
}

/** 探针结果的有效期：超过它的结果不能作为“已施加”的依据（`credentialIsolationFor`）。 */
export const PROBE_MAX_AGE_MS = 12 * 60 * 60_000

/** 某执行器 × 沙箱设置最近一次的探针运行。 */
export function findProbeRun(
  report: IsolationProbeReport | null | undefined,
  executor: string,
  setting: string,
): IsolationProbeRun | undefined {
  return report?.runs.find((r) => r.executor === executor && r.setting === setting)
}
