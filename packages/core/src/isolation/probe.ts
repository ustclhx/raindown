import { join } from 'node:path'
import { z } from 'zod'
import { raindownPaths } from '../home.ts'
import type { AdapterCapabilities } from '../ledger/adapter.ts'
import {
  findProbeRun,
  type IsolationProbeReport,
  type IsolationProbeRun,
  probeItemOk,
  probeRequiredDenyItems,
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
 * - `create_file`：以独占方式新建**指定路径**的文件（例如模拟的 shell 启动文件），成功则立即删除；只用于探针自建的临时目录；
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
  'create_file',
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
  /**
   * 写白名单探针（tasks 4.6）：探针自建的临时 home 中模拟的 shell 启动文件路径（例如 `<临时 home>/.zshenv`），
   * 位于写白名单之外；绝不指向真实的用户主目录。缺省时该项记为跳过。
   */
  shellStartupFile?: string
  /** 探针自建的临时仓库（按登记仓库同规则计算白名单）中 `.git/hooks/` 下的文件路径。缺省时该项记为跳过。 */
  gitHookFile?: string
  /** 探针工作目录（独立 clone 形状）的 `.git/objects/`：写类角色应可写，只读角色应拒绝。 */
  gitObjectsDir?: string
  /** 模拟登记仓库的 `.git/objects/`：一律拒绝（审查第一轮 H1：登记仓库的 `.git` 对 worker 整体只读）。 */
  registeredGitObjectsDir?: string
  /** 探针工作目录（独立 clone 形状）的 `.git/commondir`：拒绝（审查第二轮 H1：commondir 重定向）。 */
  gitCommondirFile?: string
  /** 共享的系统临时目录（`TMPDIR`）：拒绝（审查第一轮 M2，worker 改用按任务私有的临时目录）。 */
  sharedTmp?: string
  /**
   * 探针实际运行的施加层。`native`（Codex permissions profile，tasks 5.1）时：
   * - 读拒绝项、`write.config`、`rename.protected_ancestor`、`write.shell_startup` 与 seatbelt 相同；
   * - `write.own_profile` 跳过：profile 经命令行 `-c` 传入，没有可改写的配置文件；
   * - `write.git_commondir`、`write.registered_git`、`write.shared_tmp` 跳过（见 `NATIVE_CODEX_WRITE_ITEMS`）；
   *   `write.git_hooks`、新增的 `write.git_config` 预期拒绝，`write.git_objects` 按读写类别；新增 `read.codex_home_auth` 预期拒绝；
   * - `connect.hub` 跳过：native 下 worker 经沙箱外的 Raindown MCP 访问中枢，沙箱内命令的网络按角色设置；
   * - `write.workdir` 按读写类别（read-only 下工作目录不可写不算失败）。
   */
  layer?: string
  /** native：探针工作目录 `.git/config`（以读写方式打开，预期拒绝：写类角色的 `.git/config` 在 profile 中收回为只读）。 */
  gitConfigFile?: string
  /** native：该执行器 CODEX_HOME 中的 `auth.json`（读取预期拒绝，Codex 进程本身不在沙箱内）。 */
  codexHomeAuth?: string
}

/** native 下按 Codex 沙箱语义判定、不属于 Raindown 写白名单的写入项的跳过原因。 */
export const PROBE_NATIVE_CODEX_WRITE_SKIP =
  'native：能否写入由 Codex 沙箱语义决定（:workspace 放行工作区与临时目录，:read-only 全部拒绝），不属于 Raindown 的写白名单'
/** native 下 `write.own_profile` 的跳过原因。 */
export const PROBE_NATIVE_PROFILE_SKIP =
  'native：permissions profile 每次启动经命令行 -c 传入，没有可改写的配置文件'
/** native 下 `connect.hub` 的跳过原因。 */
export const PROBE_NATIVE_HUB_SKIP =
  'native：worker 经沙箱外的 Raindown MCP 访问中枢；沙箱内命令的网络按角色设置（缺省不联网）'

const isWithinPath = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

/** 按清单的写白名单与写拒绝判断某路径是否应可写（写拒绝优先）。 */
const writableBySpec = (spec: IsolationSpec, path: string, allow: readonly string[]) =>
  allow.some((p) => isWithinPath(p, path)) && !spec.deny_write.some((p) => isWithinPath(p, path))

/**
 * 从隔离清单推导探针清单。受保护项总是预期拒绝（不因清单遗漏而改成允许，遗漏会以失败项暴露）；
 * 工作目录是否可写按清单的 `allow_write` 与 `deny_write` 决定；Orca 端口取清单中解析出的端口，未解析时记为跳过。
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
  // 写白名单（tasks 4.6）：白名单之外的模拟 shell 启动文件、登记仓库同规则下的 .git/hooks 都应拒绝。
  items.push(
    input.shellStartupFile
      ? {
          item: 'write.shell_startup',
          kind: 'create_file',
          expected: 'deny',
          target: input.shellStartupFile,
        }
      : {
          item: 'write.shell_startup',
          kind: 'create_file',
          expected: 'deny',
          skip: '没有提供探针的临时 home',
        },
    input.gitHookFile
      ? {
          item: 'write.git_hooks',
          kind: 'create_file',
          expected: 'deny',
          target: input.gitHookFile,
        }
      : {
          item: 'write.git_hooks',
          kind: 'create_file',
          expected: 'deny',
          skip: '没有提供探针的临时仓库',
        },
  )
  items.push(
    input.registeredGitObjectsDir
      ? {
          item: 'write.registered_git',
          kind: 'write_new',
          expected: 'deny',
          target: input.registeredGitObjectsDir,
        }
      : {
          item: 'write.registered_git',
          kind: 'write_new',
          expected: 'deny',
          skip: '没有提供探针的模拟登记仓库',
        },
  )
  items.push(
    input.sharedTmp
      ? { item: 'write.shared_tmp', kind: 'write_new', expected: 'deny', target: input.sharedTmp }
      : {
          item: 'write.shared_tmp',
          kind: 'write_new',
          expected: 'deny',
          skip: '没有提供共享的系统临时目录',
        },
    input.gitCommondirFile
      ? {
          item: 'write.git_commondir',
          kind: 'create_file',
          expected: 'deny',
          target: input.gitCommondirFile,
        }
      : {
          item: 'write.git_commondir',
          kind: 'create_file',
          expected: 'deny',
          skip: '没有提供探针的临时仓库',
        },
  )
  if (input.gitObjectsDir)
    items.push({
      item: 'write.git_objects',
      kind: 'write_new',
      expected: writableBySpec(input.spec, input.gitObjectsDir, input.spec.allow_write_git)
        ? 'allow'
        : 'deny',
      target: input.gitObjectsDir,
    })
  const cwdWritable = writableBySpec(input.spec, input.cwd, input.spec.allow_write)
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
  if (input.layer === 'native') {
    if (input.gitConfigFile)
      items.push({
        item: 'write.git_config',
        kind: 'open_write',
        expected: 'deny',
        target: input.gitConfigFile,
      })
    if (input.codexHomeAuth)
      items.push({
        item: 'read.codex_home_auth',
        kind: 'read',
        expected: 'deny',
        target: input.codexHomeAuth,
      })
  }
  return {
    workdir: input.cwd,
    items: input.layer === 'native' ? items.map(nativeItem) : items,
    connect_timeout_ms: 3_000,
  }
}

/**
 * native 下跳过的写入项：`write.git_commondir`（profile 只能把已存在的 git 指针收回为只读）、`write.registered_git`
 * （native 的写类角色直接在登记仓库中工作，由 `write.git_hooks`、`write.git_config` 覆盖）、`write.shared_tmp`（`:workspace` 放行 TMPDIR）。
 * `write.git_hooks` 与 `write.git_config` 预期拒绝：profile 把工作目录 `.git` 的 hooks、config 收回为只读（审查第一轮 M3）。
 */
const NATIVE_CODEX_WRITE_ITEMS: ReadonlySet<string> = new Set([
  'write.git_commondir',
  'write.registered_git',
  'write.shared_tmp',
])

/** native 下改为跳过的项（见 `ProbePlanInput.layer`）：只保留项名、种类与预期，不尝试。 */
function nativeItem(i: ProbePlanItem): ProbePlanItem {
  const skip = NATIVE_CODEX_WRITE_ITEMS.has(i.item)
    ? PROBE_NATIVE_CODEX_WRITE_SKIP
    : i.item === 'write.own_profile'
      ? PROBE_NATIVE_PROFILE_SKIP
      : i.item === 'connect.hub'
        ? PROBE_NATIVE_HUB_SKIP
        : undefined
  return skip === undefined ? i : { item: i.item, kind: i.kind, expected: i.expected, skip }
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
        : probeRequiredDenyItems(run.applied_layer)
            .filter((id) => !run.items.some((i) => i.item === id && i.expected === 'deny'))
            .map((id) => `${id}：缺少核心受保护项`)),
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
  /** native 的联网组（PR #104 审查第二轮 M2）：只给联网角色看的探针结果。 */
  network?: boolean
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
      // 联网组（native）另起一行：联网与不联网的角色各看各的结果。
      const netRun = findProbeRun(report, e.type, setting, true)
      if (netRun && report) {
        const view = credentialIsolationFor(
          e.adapter_capabilities,
          setting as never,
          { run: netRun, ran_at: report.ran_at },
          now,
        )
        rows.push({
          executor: e.type,
          setting,
          declared_layer: declared.layers[setting] ?? 'none',
          enforced: view.enforced,
          probe: probeRunPassed(netRun) ? 'passed' : 'failed',
          ran_at: report.ran_at,
          macos_version: report.macos_version,
          run: netRun,
          network: true,
        })
      }
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
  const head = `${row.executor} × ${row.setting}${row.network ? '（联网角色）' : ''}：声明 ${row.declared_layer}，${applied}`
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
