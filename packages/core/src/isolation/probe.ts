import { join } from 'node:path'
import { z } from 'zod'
import { raindownPaths } from '../home.ts'
import type { AdapterCapabilities } from '../ledger/adapter.ts'
import {
  findProbeRun,
  type IsolationProbeReport,
  type IsolationProbeRun,
  PROBE_REQUIRED_DENY_ITEMS,
  probeItemOk,
  probeRunPassed,
} from '../ledger/isolation-probe.ts'
import { credentialIsolationFor } from './capability.ts'
import type { IsolationSpec } from './spec.ts'

/**
 * 隔离自检探针的清单（add-worker-credential-isolation D6，tasks 3.1）。清单由节点从 `computeIsolationSpec` 的结果与
 * 节点自己造的临时文件推导，交给探针子进程逐项尝试。清单只含路径、端口与 URL，不含任何凭证。
 *
 * 探针子进程按 `kind` 尝试：
 * - `read`：打开并读取最多 1 字节，字节立即丢弃，不记录、不上报、不打印；
 * - `read_via_symlink`：在探针工作目录里建一个指向目标的符号链接，经链接读取（验证 realpath 规范化），结束后删除链接；
 * - `write_new`：在目标目录下以独占方式新建一个探针文件，成功则立即删除；
 * - `open_write`：以读写方式打开已有文件后立即关闭，不写入、不截断（验证本任务的 seatbelt 配置不可改写）；
 * - `rename`：把探针自己在临时位置造的目录改名，成功则立即改回（验证受保护路径的祖先目录不可改名；绝不对真实目录使用）；
 * - `unix_connect` / `tcp_connect`：只建立连接后立即关闭，不发送任何数据；
 * - `http_get`：对中枢的无鉴权端点（`/v1/health`）发 GET；
 * - `process_debug`：跨进程调试，见 `PROCESS_DEBUG_UNVERIFIED`。
 */
export const PROBE_KINDS = [
  'read',
  'read_via_symlink',
  'write_new',
  'open_write',
  'rename',
  'unix_connect',
  'tcp_connect',
  'http_get',
  'process_debug',
] as const
export type ProbeKind = (typeof PROBE_KINDS)[number]

export const probePlanItem = z.strictObject({
  item: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  kind: z.enum(PROBE_KINDS),
  expected: z.enum(['deny', 'allow']),
  target: z.string().min(1).max(1024).optional(),
  /** 不尝试，直接记为跳过（目标未解析等）。 */
  skip: z.string().max(500).optional(),
  /** 不尝试，直接记为未验证。 */
  unverified: z.string().max(500).optional(),
  /** 不尝试，直接记为失败（actual 为 error），例如 Orca 端口未解析：无法证明控制端口被拒绝。 */
  fail: z.string().max(500).optional(),
})
export type ProbePlanItem = z.infer<typeof probePlanItem>

export const probePlan = z.strictObject({
  /** 探针工作目录（符号链接项在这里建临时链接）。 */
  workdir: z.string().min(1),
  items: z.array(probePlanItem).max(64),
  /** 每个连接类探针项的超时毫秒。 */
  connect_timeout_ms: z.number().int().min(100).max(60_000).default(3_000),
})
export type ProbePlan = z.infer<typeof probePlan>

/** 套接字与端口的解析结果：没有可尝试的目标时给出原因，记为跳过。 */
export type ProbeTargets = { status: 'found'; paths: string[] } | { status: 'none'; reason: string }

/**
 * 跨进程调试为什么记为"未验证"：不需要 sudo、不触碰真实进程的检查都不能区分"隔离生效"与"本来就不允许"：
 * - `task_for_pid` 需要调试授权（com.apple.security.cs.debugger 或 root），未授权的探针进程无论是否隔离都会失败，失败不能证明隔离；
 * - 能代表“被 seatbelt 拒绝”的 `lldb -p` 需要一个未加固（非 hardened runtime）的同用户目标进程，探针能起的
 *   `/bin/sleep`、bun 都是平台或加固二进制，本来就拒绝 attach；
 * - 不 attach 任何真实进程。
 * 外层 seatbelt 配置（tasks 4.1）显式拒绝 `mach-priv-task-port` 与 `mach-task-name`，由配置生成测试覆盖。
 */
export const PROCESS_DEBUG_UNVERIFIED =
  '不需 sudo 且不触碰真实进程的检查无法区分隔离与系统本身的限制（task_for_pid 需要调试授权，可起的子进程都是平台或加固二进制），未验证；由 seatbelt 配置显式拒绝 mach-priv-task-port、mach-task-name'

export interface ProbePlanInput {
  spec: IsolationSpec
  home: string
  /** age 私钥文件（与 `computeIsolationSpec` 使用同一个位置）。 */
  ageKeyFile: string
  /** 探针运行前造的"他人任务"假令牌文件。 */
  otherTaskToken: string
  /** 探针自己的"本任务"令牌文件（允许项）。 */
  ownToken: string
  /** 探针工作目录（与清单中的 cwd 相同）。 */
  cwd: string
  hubUrl: string
  /** Orca 运行时目录中的 unix 套接字。 */
  orcaSockets: ProbeTargets
  /** 每类套接字最多尝试几个（缺省 3）。 */
  maxSockets?: number
  /**
   * 改名探针目标：探针在本任务私有目录下自建的目录（其下的文件已作为受保护项加入隔离清单），尝试改名它。
   * 只用于探针自建的临时目录树，绝不指向真实目录。缺省时该项记为跳过。
   */
  renameTarget?: string
  /** 本次探针实际使用的 seatbelt 配置文件（施加 seatbelt 时存在；不存在时该项按目标不存在跳过）。 */
  profilePath?: string
}

const isWithinPath = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

/**
 * 从隔离清单推导探针清单。受保护项总是预期拒绝（不因清单遗漏而改成允许，遗漏会以失败项暴露）；
 * 工作目录是否可写按清单的 `allow_write` 决定；Orca 端口取清单中解析出的端口，未解析时记为跳过。
 */
export function buildProbePlan(input: ProbePlanInput): ProbePlan {
  const paths = raindownPaths(input.home)
  const items: ProbePlanItem[] = [
    { item: 'read.hub_token', kind: 'read', expected: 'deny', target: paths.hubToken },
    { item: 'read.ledger_db', kind: 'read', expected: 'deny', target: paths.ledgerDb },
    {
      item: 'read.other_task_token',
      kind: 'read',
      expected: 'deny',
      target: input.otherTaskToken,
    },
    { item: 'read.age_key', kind: 'read', expected: 'deny', target: input.ageKeyFile },
    {
      item: 'read.hub_token_via_symlink',
      kind: 'read_via_symlink',
      expected: 'deny',
      target: paths.hubToken,
    },
    { item: 'write.config', kind: 'write_new', expected: 'deny', target: paths.config },
    input.renameTarget
      ? {
          item: 'rename.protected_ancestor',
          kind: 'rename',
          expected: 'deny',
          target: input.renameTarget,
        }
      : {
          item: 'rename.protected_ancestor',
          kind: 'rename',
          expected: 'deny',
          skip: '没有提供改名探针的临时目录',
        },
    input.profilePath
      ? {
          item: 'write.own_profile',
          kind: 'open_write',
          expected: 'deny',
          target: input.profilePath,
        }
      : {
          item: 'write.own_profile',
          kind: 'open_write',
          expected: 'deny',
          skip: '没有 seatbelt 配置文件',
        },
  ]
  if (input.orcaSockets.status === 'found' && input.orcaSockets.paths.length > 0) {
    for (const [i, p] of input.orcaSockets.paths.slice(0, input.maxSockets ?? 3).entries())
      items.push({
        item: `connect.orca_socket.${i + 1}`,
        kind: 'unix_connect',
        expected: 'deny',
        target: p,
      })
  } else {
    items.push({
      item: 'connect.orca_socket',
      kind: 'unix_connect',
      expected: 'deny',
      skip:
        input.orcaSockets.status === 'none'
          ? input.orcaSockets.reason
          : 'Orca 运行时目录中没有套接字',
    })
  }
  const ports = input.spec.orca_ports
  if (ports.status === 'resolved' && ports.ports.length > 0) {
    for (const port of ports.ports)
      items.push({
        item: `connect.orca_port.${port}`,
        kind: 'tcp_connect',
        expected: 'deny',
        target: `127.0.0.1:${port}`,
      })
  } else if (ports.status === 'unresolved') {
    // 未解析时无法证明 Orca 控制端口被拒绝（任何 worker 都能连本机端口）：记为失败，不是跳过（审查第一轮 M2）。
    items.push({
      item: 'connect.orca_port',
      kind: 'tcp_connect',
      expected: 'deny',
      fail: `Orca 端口未解析：${ports.reason}`,
    })
  } else {
    items.push({
      item: 'connect.orca_port',
      kind: 'tcp_connect',
      expected: 'deny',
      skip: '没有 Orca 端口（本机没有 Orca 运行时目录）',
    })
  }
  items.push({
    item: 'debug.process',
    kind: 'process_debug',
    expected: 'deny',
    unverified: PROCESS_DEBUG_UNVERIFIED,
  })
  const cwdWritable = input.spec.allow_write.some((p) => isWithinPath(p, input.cwd))
  items.push(
    {
      item: 'write.workdir',
      kind: 'write_new',
      expected: cwdWritable ? 'allow' : 'deny',
      target: input.cwd,
    },
    { item: 'read.own_task_token', kind: 'read', expected: 'allow', target: input.ownToken },
    {
      item: 'connect.hub',
      kind: 'http_get',
      expected: 'allow',
      target: `${input.hubUrl.replace(/\/+$/, '')}/v1/health`,
    },
  )
  return { workdir: input.cwd, items, connect_timeout_ms: 3_000 }
}

/** 探针运行前造的假令牌内容：明显为假，便于在输出中断言不出现。 */
export const PROBE_FAKE_TOKEN_CONTENT = 'RAINDOWN-ISOLATION-PROBE-FAKE-TOKEN not-a-secret\n'
/** 探针临时文件名前缀（工作目录、config/ 下的写探针与符号链接）。 */
export const PROBE_FILE_PREFIX = '.raindown-isolation-probe-'
export const probeTempName = (suffix: string) => `${PROBE_FILE_PREFIX}${suffix}`
export const probeTempPath = (dir: string, suffix: string) => join(dir, probeTempName(suffix))

// ---------------------------------------------------------------------------
// 展示（doctor、node list）
// ---------------------------------------------------------------------------

const itemLabel = (i: IsolationProbeRun['items'][number]) =>
  `${i.item}${i.target ? `（${i.target}）` : ''}`

/** 一次运行的失败、跳过与未验证项（只含项名、路径与原因，不含任何内容）。 */
export function probeRunSummary(run: IsolationProbeRun): {
  failed: string[]
  skipped: string[]
  unverified: string[]
} {
  return {
    failed: [
      ...run.items
        // 按预期与实际重新计算，不使用上报的 ok。
        .filter((i) => probeItemOk(i) === false)
        .map(
          (i) =>
            `${itemLabel(i)}：预期${i.expected === 'deny' ? '拒绝' : '可用'}，实际 ${i.actual}${i.detail ? `（${i.detail}）` : ''}`,
        ),
      ...(run.error
        ? []
        : PROBE_REQUIRED_DENY_ITEMS.filter(
            (id) => !run.items.some((i) => i.item === id && i.expected === 'deny'),
          ).map((id) => `${id}：缺少核心受保护项`)),
    ],
    skipped: run.items
      .filter((i) => i.actual === 'skipped')
      .map((i) => `${itemLabel(i)}：${i.detail ?? '未说明原因'}`),
    unverified: run.items
      .filter((i) => i.actual === 'unverified')
      .map((i) => `${i.item}：${i.detail ?? '未说明原因'}`),
  }
}

/** 节点的一个执行器 × 沙箱设置的隔离状态（展示用）。 */
export interface IsolationStatusRow {
  executor: string
  setting: string
  declared_layer: string
  /** 声明且最近一次探针通过才为 true（`credentialIsolationFor` 的 enforced）。 */
  enforced: boolean
  probe: 'untested' | 'not_applicable' | 'passed' | 'failed'
  ran_at: string | null
  macos_version: string | null
  run?: IsolationProbeRun
}

/** 列出节点每个执行器 × 沙箱设置的隔离状态；执行器未上报 `credential_isolation` 时给出一行 `setting: '—'`。 */
export function isolationStatusRows(
  node: {
    executors: ReadonlyArray<{
      type: string
      adapter_capabilities: Pick<AdapterCapabilities, 'credential_isolation'>
    }>
    isolation_probe: IsolationProbeReport | null
  },
  now: number = Date.now(),
): IsolationStatusRow[] {
  const report = node.isolation_probe
  const rows: IsolationStatusRow[] = []
  for (const e of node.executors) {
    const declared = e.adapter_capabilities.credential_isolation
    if (!declared) {
      rows.push({
        executor: e.type,
        setting: '—',
        declared_layer: 'none',
        enforced: false,
        probe: 'not_applicable',
        ran_at: null,
        macos_version: null,
      })
      continue
    }
    for (const setting of Object.keys(declared.layers).sort()) {
      const run = findProbeRun(report, e.type, setting)
      const view = credentialIsolationFor(
        e.adapter_capabilities,
        setting as never,
        run && report ? { run, ran_at: report.ran_at } : null,
        now,
      )
      const layer = declared.layers[setting] ?? 'none'
      rows.push({
        executor: e.type,
        setting,
        declared_layer: layer,
        enforced: view.enforced,
        probe: run
          ? probeRunPassed(run)
            ? 'passed'
            : 'failed'
          : view.layer === 'none'
            ? 'not_applicable'
            : 'untested',
        ran_at: run ? (report?.ran_at ?? null) : null,
        macos_version: run ? (report?.macos_version ?? null) : null,
        ...(run ? { run } : {}),
      })
    }
  }
  return rows
}

/** 一行加若干缩进行描述一个执行器 × 沙箱设置的隔离状态。 */
export function describeIsolationStatus(row: IsolationStatusRow, indent = '    '): string[] {
  if (row.setting === '—') return [`${row.executor}：未上报凭证隔离能力（按 none 处理，未探测）`]
  const applied = row.enforced ? '已施加' : '未施加'
  const head = `${row.executor} × ${row.setting}：声明 ${row.declared_layer}，${applied}`
  switch (row.probe) {
    case 'not_applicable':
      return [`${head}；施加层为 none，不探测`]
    case 'untested':
      return [`${head}；未探测`]
    default: {
      const run = row.run as IsolationProbeRun
      const at = `${row.ran_at ?? '—'}${row.macos_version ? `，macOS ${row.macos_version}` : ''}`
      const lines = [
        `${head}；最近探针 ${at}（实际以 ${run.applied_layer} 运行）：${row.probe === 'passed' ? '通过' : '不通过'}`,
      ]
      if (run.error) lines.push(`${indent}无法运行：${run.error.code} ${run.error.message}`)
      const s = probeRunSummary(run)
      for (const f of s.failed) lines.push(`${indent}失败 ${f}`)
      for (const f of s.skipped) lines.push(`${indent}跳过 ${f}`)
      for (const f of s.unverified) lines.push(`${indent}未验证 ${f}`)
      return lines
    }
  }
}

/**
 * 从通过变为不通过的执行器 × 沙箱设置（收件箱通知用）：上一次与这一次都有该项的运行，且上一次通过、这一次不通过。
 * 未探测（没有上一次）或一直不通过都不算变化。
 */
export function probeRegressions(
  previous: IsolationProbeReport | null | undefined,
  next: IsolationProbeReport | null | undefined,
): IsolationProbeRun[] {
  if (!previous || !next) return []
  return next.runs.filter((run) => {
    const before = findProbeRun(previous, run.executor, run.setting)
    return before !== undefined && probeRunPassed(before) && !probeRunPassed(run)
  })
}
