import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type Activity,
  approvalFingerprint,
  BLOCKED_REQUEST_TEXT_MAX,
  type BlockedReason,
  type BlockedRequest,
  type CompleteLeaseRequest,
  clipTail,
  clipText,
  DEFAULT_NO_PROGRESS_MINUTES,
  type DeliveredInput,
  type DeliveredReply,
  fail,
  HUB_TOKEN_ENV,
  type IsolationProbeReport,
  LEASE_SLOT_KINDS,
  LEDGER_ID_RE,
  type LeaseGrant,
  type LeaseSlotKind,
  type LeaseSlots,
  loadHubConfig,
  loadNodeConfig,
  loadRoles,
  type OutOfBandSignal,
  ok,
  outOfBandSignal,
  PROTOCOL_MESSAGE_MAX,
  probeRunPassed,
  type RenewLeaseData,
  type ReportQuestion,
  type RepoSnapshot,
  type Result,
  raindownPaths,
  readRaindownEnv,
  redactLines,
  resolveHubUrl,
  type TaskContract,
  taskBranch,
  VERSION,
} from '@raindown/core'
import { createNodeHubClient, type FetchLike, type NodeHubClient } from './client.ts'
import { type NodeClock, sleep, systemClock } from './clock.ts'
import { migrateCodexHomes } from './codex-home.ts'
import type { CommandRunner } from './codex-orca/orca.ts'
import { dualRaindownEnv, executorEnv } from './env.ts'
import {
  createExecutorRegistry,
  type DeliverResult,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRegistry,
  type ExecutorRun,
  type InjectResult,
  isIdleSignal,
  isResumedSignal,
  type StuckVerdict,
} from './executor.ts'
import { createFakeExecutor } from './fake.ts'
import {
  defaultMacosVersion,
  type IsolationProbeOptions,
  runIsolationProbe,
} from './isolation-probe/run.ts'
import {
  cleanLeaseTokenFiles,
  removeEmptyTaskRunDir,
  removeLeaseTokenFile,
  writeLeaseTokenFile,
} from './lease-token.ts'
import { acquireNodeLock } from './node-lock.ts'
import { createPolicyPrecheck, type Precheck, type PrecheckRequest } from './precheck.ts'
import {
  computeDiffStat,
  type NodeEnvReport,
  nodeEnvReport,
  snapshotRepoResult,
} from './push-env.ts'
import { verifyTask } from './verify.ts'
import { cleanWakeTokenDir, removeWakeTokenFile, writeWakeTokenFile } from './wake-token.ts'
import { checkWorkingDirectory, resolveContractCwd, workspaceRepos } from './workdir.ts'

/**
 * `raindown node` 执行节点（tasks.md 4.3；design D6；node-protocol spec）。
 *
 * - 身份：`state/node-id`，首次启动时生成；
 * - 注册 → 领取循环（long-poll）→ 每个租约一个 LeaseRunner：执行器 + 续约循环（TTL/3）
 *   + 活动批量随续约上报 + 取消处理 + 卡住检测与回复送达（add-m1-executors 1.2）+ 提交结束；
 * - 时钟跳变检测：墙钟比单调时钟多走超过 30 秒（睡眠唤醒）时立即续约全部租约（D5）；
 * - 并发上限按执行槽类别计数（add-m1-supervisor D12）：普通槽 concurrency，另有 `reserved.supervisor`
 *   与 `reserved.reply` 两类预留槽。每个容量大于 0 的类别各有一个领取循环，领取时只上报本类别的
 *   空位（`slots`；普通循环不带 slots，兼容旧中枢），因此普通槽占满（例如 dev 任务卡住并持有租约）时仍为唤醒任务领取；
 * - `stop()` 不提交结果：停止续约并取消执行器，租约到期后由中枢按合同处理（与进程被杀一致）。
 */

export interface NodeLogger {
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
}

const consoleLogger: NodeLogger = {
  info: (m, d) => console.error(m, d ?? ''),
  warn: (m, d) => console.error(m, d ?? ''),
}

export interface StartNodeOptions {
  home: string
  clock?: NodeClock
  /** 执行器插件；默认只有 fake。 */
  executors?: readonly ExecutorPlugin[]
  /** 中枢地址；默认按 node.yaml 的 hub_url 或 hub.yaml 的端口。 */
  hubUrl?: string
  /** 中枢 token；默认读取 `state/hub.token`。 */
  token?: string
  fetch?: FetchLike
  hostname?: string
  /** 覆盖 `state/node-id`（同一 raindown-home 上运行多个节点的测试用）。 */
  nodeId?: string
  version?: string
  /** 额外能力（与 node.yaml 合并）。 */
  capabilities?: readonly string[]
  /** 覆盖 node.yaml 的 concurrency。 */
  concurrency?: number
  /** 覆盖 node.yaml 的 reserved（D12）。 */
  reserved?: { supervisor: number; reply: number }
  /** long-poll 等待秒数，默认 30（中枢按 lease_wait_max_s 截断）。 */
  waitS?: number
  /** 中枢不可用等错误后的重试间隔，默认 1000 毫秒。 */
  retryMs?: number
  /**
   * 中枢拒绝 `slots`（旧中枢的 strict 校验返回 invalid_arguments）后，预留槽循环的重试间隔，
   * 默认 5 分钟；中枢升级后自动恢复。
   */
  slotsRetryMs?: number
  /** 时钟跳变阈值，默认 30 秒。 */
  jumpThresholdMs?: number
  /**
   * 角色设定的无进展阈值（分钟）。合同的 `no_progress_minutes` 优先，缺省为 15 分钟。
   * 不传时按合同的角色读取 `config/roles/<role>.yaml` 的 `no_progress_minutes`。
   */
  noProgressMinutes?: NoProgressResolver
  /** 超时后等待执行器响应取消的毫秒数，默认 10 秒。 */
  timeoutGraceMs?: number
  /** deliver 超过多少毫秒记警告（不重送），默认 60 秒。 */
  deliverTimeoutMs?: number
  /** deliver 超过多少毫秒仍无结果就按 not_running 处理，默认 10 分钟。 */
  deliverGiveUpMs?: number
  /** 策略预检的超时毫秒（add-m1-inbox 2.3），默认 5 秒；超时按需要用户处理。 */
  precheckTimeoutMs?: number
  /**
   * 节点自己执行 git / gh 的方式（推送与 gh 环境检查、diff_stat，D15）；测试注入，缺省 execFile。
   */
  envRunner?: CommandRunner
  /** 上述检查使用的环境变量（含禁用变量的检查），缺省为 `executorEnv()`；测试注入。 */
  envVars?: NodeJS.ProcessEnv
  logger?: NodeLogger
  /**
   * 隔离自检探针（worker-credential-isolation 3.1–3.2）：启动时、每 6 小时、macOS 版本变化时运行，结果随注册上报。
   * 缺省不运行（测试不触碰真实的用户目录）；`raindown node start` 显式开启。
   */
  isolationProbe?: IsolationProbeNodeOptions
}

export interface IsolationProbeNodeOptions
  extends Partial<Omit<IsolationProbeOptions, 'home' | 'hubUrl' | 'executors'>> {
  /** 定期运行的间隔，默认 6 小时。 */
  intervalMs?: number
  /** 检查 macOS 版本是否变化的间隔，默认 1 小时。 */
  versionCheckMs?: number
  /** 替换探针实现（测试用）。 */
  run?: (o: IsolationProbeOptions) => Promise<IsolationProbeReport>
}

export const ISOLATION_PROBE_INTERVAL_MS = 6 * 60 * 60_000
export const ISOLATION_PROBE_VERSION_CHECK_MS = 60 * 60_000

export interface RunningNode {
  nodeId: string
  hubUrl: string
  capabilities: string[]
  /** 当前持有的租约数。 */
  active(): number
  /** 停止领取、取消执行器、不提交结果；可重复调用。 */
  stop(): Promise<void>
}

export const JUMP_THRESHOLD_MS = 30_000
/**
 * 中枢的 `invalid_arguments` 是否因为某个字段（旧中枢的 strict 校验不认识它）：只看 `details`
 * 中逐字段的问题是否提到该字段，其他原因的参数错误不当作"旧中枢"。
 */
export function rejectsField(error: { code: string; details?: unknown }, field: string): boolean {
  if (error.code !== 'invalid_arguments' || !Array.isArray(error.details)) return false
  const re = new RegExp(`(^|[^A-Za-z0-9_])${field}([^A-Za-z0-9_]|$)`)
  return error.details.some((d) => {
    if (!d || typeof d !== 'object') return false
    // `field` 是 `formatZodIssues` 给出的点分路径；未知字段（unrecognized_keys）没有路径，只在 message 中。
    const { message, field: at } = d as { message?: unknown; field?: unknown }
    if (typeof at === 'string' && (at === field || at.startsWith(`${field}.`))) return true
    return typeof message === 'string' && re.test(message)
  })
}

/** 中枢拒绝 slots 后预留槽循环的重试间隔。 */
export const SLOTS_RETRY_MS = 5 * 60_000
const JUMP_CHECK_MS = 1_000
const ACTIVITY_PER_RENEW = 500
const ACTIVITY_BUFFER_MAX = 5_000

/** 由主机名派生的节点 id：`n-<主机名>-<6 位十六进制>`。 */
export function generateNodeId(host: string, random = () => randomBytes(3).toString('hex')) {
  const slug =
    host
      .toLowerCase()
      .replace(/\.local$/, '')
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
      .slice(0, 40) || 'node'
  return `n-${slug}-${random()}`
}

/** 读取 `state/node-id`；不存在时生成并保存。 */
export async function loadOrCreateNodeId(home: string, host: string): Promise<Result<string>> {
  const path = raindownPaths(home).nodeId
  if (existsSync(path)) {
    const id = (await readFile(path, 'utf8')).trim()
    if (!LEDGER_ID_RE.test(id)) {
      return fail('failure', 'invalid_node_id', `${path} 中的节点 id 不合法：${id}`)
    }
    return ok(id)
  }
  const id = generateNodeId(host)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${id}\n`, { mode: 0o644 })
  return ok(id)
}

interface Env {
  home: string
  nodeId: string
  /** 中枢地址；随派工令牌交给任务绑定 MCP（worker 侧不读 config/，add-worker-credential-isolation D3）。 */
  hubUrl?: string
  client: NodeHubClient
  clock: NodeClock
  registry: ExecutorRegistry
  logger: NodeLogger
  retryMs: number
  /** 角色设定的无进展阈值（分钟），来自 `config/roles/`。 */
  roleNoProgressMinutes: NoProgressResolver | undefined
  timeoutGraceMs: number
  deliverTimeoutMs: number
  deliverGiveUpMs: number
  precheckTimeoutMs: number | undefined
  envRunner: CommandRunner | undefined
  envVars: NodeJS.ProcessEnv | undefined
}

/** 按合同（通常按角色）给出无进展阈值分钟数；返回 undefined 表示没有设定。 */
export type NoProgressResolver = (contract: TaskContract) => number | undefined

/**
 * 无进展阈值（stuck-detection "无进展超时"）：合同的 `no_progress_minutes` 优先，
 * 其次是角色设定（`resolver`，由角色配置提供），最后是默认的 15 分钟。返回毫秒。
 */
export function noProgressMs(contract: TaskContract, resolver?: NoProgressResolver): number {
  const minutes =
    contract.no_progress_minutes ?? resolver?.(contract) ?? DEFAULT_NO_PROGRESS_MINUTES
  return Math.max(1, Math.round(minutes * 60_000))
}

/** 经续约上报的卡住（含代回复相关字段，D15）。 */
interface BlockedSignal {
  basis?: 'reported' | 'inferred'
  question?: ReportQuestion
  missing?: string
  tried?: string
  reason: BlockedReason
  message: string
  tail?: string[]
  session?: string
  decision_id?: number
  request?: BlockedRequest
  approval_fingerprint?: string
  diff_stat?: string
  no_delegate?: boolean
}

/** 本租约预检得到的 supervisor 档位判定：请求与当时上报的环境（D15）。 */
interface SupervisorDecision {
  req: PrecheckRequest
  report: NodeEnvReport
  /** 实际送去判定的路径（含 realpath 展开），与 policy.decided 一致。 */
  sentPaths?: string[] | undefined
}

/** 每个租约最多记住的 supervisor 判定数（只有最近的会被卡住引用）。 */
const DECISIONS_KEEP = 20

/** 由节点记录的预检请求生成卡住的请求文本；命令超长时省略（中枢无法核对，交给用户）。 */
export function blockedRequestOf(
  req: PrecheckRequest,
  sentPaths: readonly string[] | undefined = req.paths,
): BlockedRequest {
  const reason = req.reason?.trim()
  const paths = sentPaths
  return {
    tool: req.tool.slice(0, 128),
    ...(req.command !== undefined &&
    req.command.length > 0 &&
    req.command.length <= BLOCKED_REQUEST_TEXT_MAX
      ? { command: req.command }
      : {}),
    ...(paths?.length &&
    paths.length <= 200 &&
    paths.every((p) => p.length > 0 && p.length <= BLOCKED_REQUEST_TEXT_MAX)
      ? { paths: [...paths] }
      : {}),
    ...(reason ? { reason: clipText(reason, BLOCKED_REQUEST_TEXT_MAX) } : {}),
  }
}

type PendingReport = NonNullable<RenewLeaseData['report']>
type ReportConflict = { report_seq: number; observed: 'idle' | 'busy' | 'no_progress' }

type RenewSignal =
  | { blocked: BlockedSignal; report_seq?: number; report_conflict?: ReportConflict }
  | { resumed: { note: string } }
  | { phase: 'verifying' }

/** 节点上报 blocked 时附带的末尾输出行数（stuck-detection "卡住的原因分类"）。 */
export const STUCK_TAIL_LINES = 40
const TAIL_KEEP = 200
/** 上报受阻后仍忙碌，最多等两分钟即以上报为准。 */
const REPORT_BUSY_MS = 2 * 60_000
/** 超时后等待执行器响应取消的宽限时间；过后不再等待，直接提交 failed(timeout)。 */
export const TIMEOUT_GRACE_MS = 10_000
/** deliver 超过这个时长只记警告：不重送，继续等待结果（避免重复送达）。 */
export const DELIVER_TIMEOUT_MS = 60_000
/** deliver 超过这个时长仍无结果：按 not_running 处理，带着回复重新排队并取消当前 worker。 */
export const DELIVER_GIVE_UP_MS = 10 * 60_000

/** 上报前按协议上限截断说明与末尾输出（超长的请求会被中枢拒绝）。 */
function clipBlocked<T extends { message: string; tail?: string[] | undefined }>(b: T): T {
  return {
    ...b,
    message: clipText(b.message, PROTOCOL_MESSAGE_MAX),
    ...(b.tail ? { tail: clipTail(b.tail) } : {}),
  }
}

function clipCompletion(req: CompleteLeaseRequest): CompleteLeaseRequest {
  if (req.outcome === 'blocked') return clipBlocked(req)
  if (req.outcome === 'cancelled' && req.message !== undefined) {
    return { ...req, message: clipText(req.message, PROTOCOL_MESSAGE_MAX) }
  }
  return req
}

/**
 * 一个租约的生命周期：执行器、续约循环、卡住检测、回复送达、提交（add-m1-executors 1.2）。
 *
 * 卡住检测（stuck-detection spec）：
 * - 执行器在活动流中报告 idle：调用 `classify` 判定原因，无法识别时为 other；
 * - 超过无进展阈值没有任何活动：先问 `classify`，没有判定时为 no_progress；
 *   以上两种 worker 仍然活着，经续约上报 `blocked`（lease_held=true），租约继续持有（D7a）；
 * - 执行器进程意外退出（`exited` 或执行器错误）：提交 blocked(crashed)，附退出码与末尾输出；
 * - 运行时间超过 `timeout_s`（不含 blocked 等待回复的时间）：停止执行器，提交 failed（reason=timeout）；
 *   执行器在宽限时间内不响应取消也照样提交。
 *
 * 回复送达（task-interaction "送达与恢复"）：blocked 期间续约响应带回复时交给 `deliver`，
 * 再用 ack-reply 报告结果；同一条回复只交给执行器一次，确认失败时只重试确认。
 */
class LeaseRunner {
  private buffer: Activity[] = []
  private abort = new AbortController()
  private cancelRenew = () => {}
  private cancelTimeout = () => {}
  private cancelIdle = () => {}
  private cancelGrace = () => {}
  private cancelReportWait = () => {}
  /** idle 先续约读取最新上报，避免终端信号与 MCP 上报到达顺序影响判定。 */
  private observedIdle: { at: number; hint?: Record<string, unknown>; text?: string } | undefined
  private pendingReport: PendingReport | undefined
  private lastReportSeq = 0
  /**
   * 非运行阶段到达、或因恢复而作废的上报：随下一次续约以 report_seq 确认消费，不再参与判定
   * （避免 worker 恢复后旧问题再次转 blocked 或接管下一次 idle）。
   */
  private staleReportSeq: number | undefined
  private terminalReport: PendingReport | undefined
  private adapterOutcome: Result<ExecutorOutcome> | undefined
  private renewing: Promise<void> | undefined
  private renewAgain = false
  private run: ExecutorRun | undefined
  private executor: ExecutorPlugin | undefined
  /** 中枢在续约响应中要求取消。 */
  private cancelRequested = false
  private timedOut = false
  /** 租约已不属于本节点（过期、被处理、令牌不符）或节点停止：不再续约，也不提交。 */
  private released = false
  /** 节点视角的阶段：blocked 表示已判定卡住、等待回复（worker 仍活着）。 */
  private phase: 'running' | 'blocked' | 'verifying' = 'running'
  /** 按发生顺序逐次续约上报状态变化，避免新卡住覆盖尚未确认的恢复。 */
  private signals: RenewSignal[] = []
  /** 带外操作独立缓冲，避免被后续 blocked/resumed 状态覆盖；id 用于中枢幂等。 */
  private outOfBand: OutOfBandSignal[] = []
  /** 最近的输出行。 */
  private tail: string[] = []
  private lastActivityAt: number
  /** 已交给执行器的回复 id（保证只送达一次）。 */
  private delivered = new Set<string>()
  /** 已交给执行器、尚未被中枢确认的送达结果。 */
  private unacked: { reply_id: string; outcome: DeliverResult } | undefined
  /** 进行中的 deliver（后台执行，不阻塞续约）。 */
  private delivering: Promise<void> | undefined
  /** 已送进 worker 的输入（按 input_seq 只送一次）与待随续约确认的输入（harness-neutral 8.4）。 */
  private injected = new Set<number>()
  private inputAcks: number[] = []
  /** 随派工输入交给执行器、待随续约确认的输入（中枢确认后才记为送达）。 */
  private dispatchAcks: number[] = []
  private injecting: Promise<void> | undefined
  /** 执行器已结束：之后不再重新计时。 */
  private runEnded = false
  /** 初始写入与续约刷新共用最新 token 和串行写队列，清理关闭队列后不再创建文件。 */
  private dispatchToken: string | undefined
  private leaseTokenFile: string | undefined
  /** 只确认实际成功写入凭证文件的内容。 */
  private dispatchTokenSha256: string | undefined
  private renewReadFailed = false
  private tokenWrites: Promise<void> = Promise.resolve()
  private tokenFilesReady = false
  private tokenFilesClosed = false
  private tokenWriteFailed = false
  /** 剩余的超时预算（毫秒）与本段开始计时的单调时间。 */
  private timeoutLeftMs: number
  private timeoutArmedAt = 0
  private forceDone: ((r: Result<ExecutorOutcome>) => void) | undefined
  /** 本租约预检得到的 supervisor 判定（decision_id → 请求与环境，D15）。 */
  private decisions = new Map<number, SupervisorDecision>()
  /** 当前这次卡住引用的判定：supervisor 的批准送达前据此复核。 */
  private blockedDecision: SupervisorDecision | undefined
  /** supervisor 的批准被拒收后：下一次卡住以 no_delegate 上报，直接交给用户。 */
  private noDelegateNext = false
  /** 待随续约上报的任务分支（写类适配器启动前，D15）；上报成功后清空。 */
  private pendingBranch:
    | { branch: string; worktree: string; repo_snapshot?: RepoSnapshot }
    | undefined
  /** 已上报的任务分支（推送来源必须解析为它）。 */
  private reportedBranch: string | undefined
  /** 租约开始、worker 启动前对登记仓库的快照（D15）。 */
  private snapshot: RepoSnapshot | undefined
  /** 执行器最近一次预检得到的 supervisor 判定 id；最近一次不是 supervisor 时为 undefined。 */
  private latestDecision: number | undefined
  private precheckSeq = 0
  private branchReported = false
  /** 执行器上报的 worktree（realpath）：diff_stat 在这里计算。 */
  private workdir: string | undefined
  /** 节点解析的合同工作目录。 */
  private cwd: string | undefined
  /** workspace 登记的仓库（推送与 gh 环境检查）。 */
  private repos: string[] = []
  /** 卡住上报的代数：异步计算 diff_stat 期间状态变化（恢复、送达）时作废这次上报。 */
  private stuckGen = 0
  readonly finished: Promise<void>

  constructor(
    private readonly env: Env,
    readonly grant: LeaseGrant,
  ) {
    this.lastActivityAt = this.mono()
    this.timeoutLeftMs = grant.contract.timeout_s * 1000
    this.dispatchToken = grant.dispatch_token
    this.finished = this.execute()
  }

  private mono() {
    return this.env.clock.monotonic?.() ?? this.env.clock.now()
  }

  private get intervalMs() {
    return Math.max(100, Math.floor((this.grant.ttl_s * 1000) / 3))
  }

  /** 节点停止：放弃租约，不提交。 */
  async abandon() {
    this.release()
    await this.run?.cancel().catch(() => {})
    await this.finished
  }

  private release() {
    this.released = true
    this.cancelRenew()
    this.cancelTimeout()
    this.cancelIdle()
    this.cancelGrace()
    this.cancelReportWait()
    this.abort.abort()
    // 不再等执行器：让 execute 尽快退出。
    this.forceDone?.(ok({ outcome: 'cancelled', message: '租约已释放' }))
  }

  private scheduleRenew(ms = this.intervalMs) {
    this.cancelRenew()
    if (this.released) return
    this.cancelRenew = this.env.clock.setTimeout(() => void this.renewNow(), ms)
  }

  /** 立即续约（串行；进行中时合并为下一次）。 */
  renewNow(): Promise<void> {
    if (this.released) return Promise.resolve()
    if (this.renewing) {
      this.renewAgain = true
      return this.renewing
    }
    this.renewing = (async () => {
      do {
        this.renewAgain = false
        await this.renewOnce()
      } while (this.renewAgain && !this.released)
    })().finally(() => {
      this.renewing = undefined
    })
    return this.renewing
  }

  private async renewOnce() {
    this.cancelRenew()
    const batch = this.buffer.splice(0, ACTIVITY_PER_RENEW)
    const signal = this.signals.shift()
    const branch = this.pendingBranch
    const outOfBand = this.outOfBand.splice(0, 100)
    const inputAcks = this.inputAcks.splice(0, 50)
    const dispatchAcks = this.dispatchAcks.splice(0, 200)
    // 同批信号已带 report_seq 时不混发（report_conflict 须与之一致），留到下一次续约。
    const staleAck =
      signal && 'report_seq' in signal && signal.report_seq !== undefined
        ? undefined
        : this.staleReportSeq
    const r = await this.env.client.renew(this.grant.lease_id, {
      lease_token: this.grant.lease_token,
      ...(this.dispatchTokenSha256 ? { dispatch_token_sha256: this.dispatchTokenSha256 } : {}),
      activity: batch,
      ...(signal && 'blocked' in signal
        ? { ...signal, blocked: clipBlocked(signal.blocked) }
        : (signal ?? {})),
      ...(staleAck !== undefined ? { report_seq: staleAck } : {}),
      ...(branch ? { branch } : {}),
      ...(outOfBand.length > 0 ? { out_of_band: outOfBand } : {}),
      ...(inputAcks.length > 0 ? { inputs_delivered: inputAcks } : {}),
      ...(dispatchAcks.length > 0 ? { inputs_dispatched: dispatchAcks } : {}),
    })
    if (this.released) return
    if (r.ok && staleAck !== undefined && this.staleReportSeq === staleAck)
      this.staleReportSeq = undefined
    this.renewReadFailed = !r.ok && r.error.kind === 'retryable'
    // 中枢已处理分支上报（写入或因已上报而忽略）：不再重复发送。
    // 分支上报的结果（D15）：只有中枢明确说临时失败（retry）时保留重发；写入、忽略或旧版中枢
    // （没有该字段）都不再上报。
    if (r.ok && branch && this.pendingBranch === branch && r.data.branch_report !== 'retry') {
      this.pendingBranch = undefined
    }
    if (!r.ok) {
      if (r.error.kind === 'retryable') {
        this.buffer.unshift(...batch)
        this.outOfBand.unshift(...outOfBand)
        this.inputAcks.unshift(...inputAcks)
        this.dispatchAcks.unshift(...dispatchAcks)
        // 重试仍从队首发送，先确认恢复再上报后续的新回合。
        if (signal) this.signals.unshift(signal)
        this.scheduleRenew(Math.min(this.intervalMs, this.env.retryMs))
        return
      }
      if (branch && r.error.code === 'invalid_arguments') {
        // 旧版中枢不认识 `branch` 字段：不再上报分支（push_to 随之恒不满足），其余照常重试，不放弃任务。
        this.env.logger.warn('中枢不接受任务分支上报，忽略', r.error.message)
        if (this.pendingBranch === branch) this.pendingBranch = undefined
        this.buffer.unshift(...batch)
        this.outOfBand.unshift(...outOfBand)
        this.inputAcks.unshift(...inputAcks)
        this.dispatchAcks.unshift(...dispatchAcks)
        if (signal) this.signals.unshift(signal)
        this.scheduleRenew(0)
        return
      }
      this.env.logger.warn(`租约 ${this.grant.lease_id} 续约被拒绝，放弃任务`, r.error.code)
      this.release()
      await this.run?.cancel().catch(() => {})
      return
    }
    if (r.data.dispatch_token) {
      this.dispatchToken = r.data.dispatch_token
      if (this.tokenFilesReady) await this.writeDispatchToken()
      if (this.released) return
    }
    if (
      this.buffer.length > 0 ||
      this.signals.length > 0 ||
      this.outOfBand.length > 0 ||
      this.inputAcks.length > 0 ||
      this.dispatchAcks.length > 0 ||
      this.staleReportSeq !== undefined
    )
      this.renewAgain = true
    if (r.data.cancel_requested && !this.cancelRequested) {
      this.cancelRequested = true
      this.abort.abort()
      await this.run?.cancel().catch(() => {})
    }
    if (!this.cancelRequested) {
      if (r.data.report) this.acceptReport(r.data.report)
      this.mergeIdle()
    }
    if (r.data.blocked?.request_id) {
      this.run?.bindBlocked?.({ seq: r.data.blocked.seq, request_id: r.data.blocked.request_id })
    }
    if (r.data.reply && !this.cancelRequested && !this.unacked) this.deliver(r.data.reply)
    if (r.data.inputs?.length && !this.cancelRequested) this.inject(r.data.inputs)
    if (this.unacked) await this.ack()
    this.scheduleRenew()
  }

  /**
   * 把续约带来的输入送进运行中的 worker（PR 直通，harness-neutral 8.4）：后台依次送，不阻塞续约；
   * 每条只送一次，送达后随下一次续约以 inputs_delivered 确认。适配器暂时不能送（not_now）或 worker
   * 已不在（not_running）时不确认，中枢会在之后的续约或下一次派工再给。
   */
  private inject(inputs: readonly DeliveredInput[]) {
    const run = this.run
    if (this.injecting || !run?.inject || this.released || this.runEnded) return
    const todo = inputs.filter((i) => !this.injected.has(i.input_seq))
    if (!todo.length) return
    this.injecting = (async () => {
      for (const input of todo) {
        if (this.released || this.runEnded || this.cancelRequested) return
        let result: InjectResult
        try {
          result = (await run.inject?.(input)) ?? 'not_running'
        } catch (error) {
          this.env.logger.warn(`输入 ${input.input_seq} 暂时未送达，下一次续约重试`, String(error))
          return
        }
        if (result !== 'delivered') return
        this.injected.add(input.input_seq)
        this.inputAcks.push(input.input_seq)
      }
    })().finally(() => {
      this.injecting = undefined
      if (this.inputAcks.length && !this.released) this.scheduleRenew(0)
    })
  }

  /**
   * 把回复交给执行器（每条只交一次），结果留待 ack。不阻塞续约循环：送达可能很慢
   * （例如往终端里输入），等它会让租约过期（PR #16 审查第 9 条）。
   * - 执行器明确返回 not_running，或根本不支持 deliver：确认 worker 不在；
   * - deliver 抛出异常：视为临时错误，不确认、不取消执行器，下一次续约再送（第 6 条）。
   */
  private deliver(reply: DeliveredReply) {
    // 执行器已结束就不再送达：交给提交结束的流程，回复随重新排队带到下一次执行。
    if (this.delivered.has(reply.reply_id) || this.released || this.runEnded) return
    this.delivered.add(reply.reply_id)
    const run = this.run
    const { clock, logger, deliverTimeoutMs, deliverGiveUpMs } = this.env
    let settled = false
    let cancelSoft = () => {}
    let cancelHard = () => {}
    const settle = () => {
      settled = true
      cancelSoft()
      cancelHard()
    }
    const record = (outcome: DeliverResult) => {
      if (settled) return
      settle()
      if (this.released) return
      this.unacked = { reply_id: reply.reply_id, outcome }
      void this.renewNow()
    }
    this.delivering = new Promise<void>((resolve) => {
      if (!run?.deliver) {
        record('not_running')
        return resolve()
      }
      // 超时只是不再阻塞：底层 deliver 可能仍在执行，重送会让 worker 收到两次（PR #16 第三轮复核第 2 条）。
      // 所以超时后不重送，回复保持在途，等迟到的结果。
      cancelSoft = clock.setTimeout(() => {
        logger.warn(
          `回复 ${reply.reply_id} 的送达超过 ${deliverTimeoutMs}ms 未返回，继续等待，不重送`,
        )
      }, deliverTimeoutMs)
      // 迟迟没有结果：按 not_running 处理——中枢带着回复重新排队，由下一次执行接收；
      // 确认后本节点取消当前 worker（见 ack），避免两边都收到同一条回复。迟到的结果随后被忽略。
      cancelHard = clock.setTimeout(() => {
        logger.warn(
          `回复 ${reply.reply_id} 的送达超过 ${deliverGiveUpMs}ms 仍无结果，按 not_running 处理`,
        )
        record('not_running')
        resolve()
      }, deliverGiveUpMs)
      run.deliver(reply).then(
        (outcome) => {
          record(outcome)
          resolve()
        },
        (err) => {
          // deliver 明确失败（抛异常）时它已经结束，重送是安全的：视为临时错误，
          // 不确认、不取消执行器，下一次续约重送。
          if (!settled) {
            settle()
            logger.warn(`回复 ${reply.reply_id} 送达失败，下一次续约重试`, String(err))
            this.delivered.delete(reply.reply_id)
          }
          resolve()
        },
      )
    }).finally(() => {
      this.delivering = undefined
    })
  }

  /** 恢复时只允许拒收租约自带的回复，执行器不能指定其他回复。 */
  private reportResumeReplyDropped(details?: { attempted?: boolean }) {
    const reply = this.grant.resume?.reply
    if (!reply || this.released || this.delivered.has(reply.reply_id)) return
    this.delivered.add(reply.reply_id)
    this.unacked = {
      reply_id: reply.reply_id,
      outcome: { outcome: 'dropped', reason: 'round_closed', ...details },
    }
    void this.renewNow()
  }

  private async ack() {
    const u = this.unacked
    if (!u) return
    const r = await this.env.client.ackReply(this.grant.lease_id, {
      lease_token: this.grant.lease_token,
      reply_id: u.reply_id,
      outcome: typeof u.outcome === 'string' ? u.outcome : u.outcome.outcome,
      ...(typeof u.outcome === 'object'
        ? {
            reason: u.outcome.reason,
            ...(u.outcome.attempted !== undefined ? { attempted: u.outcome.attempted } : {}),
          }
        : u.outcome === 'dropped'
          ? { reason: 'request_changed' as const }
          : {}),
    })
    if (this.released) return
    if (!r.ok) {
      // 可重试的错误下一次续约时再确认；其他错误（例如任务已被取消）放弃确认。
      if (r.error.kind !== 'retryable') {
        this.env.logger.warn(`回复 ${u.reply_id} 的送达确认被拒绝`, r.error.code)
        this.unacked = undefined
        // 中枢若仍把它当作待送达，下一次续约会再次返回它，允许重新送达（PR #16 审查第 8 条）。
        this.delivered.delete(u.reply_id)
      }
      return
    }
    this.unacked = undefined
    if (u.outcome === 'delivered') {
      // 幂等确认可能返回后续回合的 blocked；只有中枢确实恢复运行时才重新计时。
      if (r.data.task.status === 'running') this.enterRunning()
    } else if (typeof u.outcome === 'object' && u.outcome.reason === 'round_closed') {
      this.env.logger.info(`回复 ${u.reply_id} 已拒收：授权回合已关闭或请求已变化`)
    } else if (
      u.outcome === 'dropped' ||
      (typeof u.outcome === 'object' && u.outcome.reason === 'request_changed')
    ) {
      // supervisor 的批准被拒收（D15）：中枢解除卡住后，下一次以 no_delegate 上报。
      // 策略已撤回批准时幂等确认仍返回 blocked，保留当前回合，不能重新上报卡住。
      this.env.logger.info(`回复 ${u.reply_id} 已拒收：待批请求已变化或环境复查未通过`)
      if (r.data.task.status === 'running') {
        this.enterRunning()
        this.noDelegateNext = true
      }
    } else {
      // worker 已不在：中枢让任务带着回复重新排队，本租约随之结束。
      this.release()
      await this.run?.cancel().catch(() => {})
    }
  }

  private pushTail(text: string) {
    for (const line of text.split('\n')) this.tail.push(line)
    if (this.tail.length > TAIL_KEEP) this.tail.splice(0, this.tail.length - TAIL_KEEP)
  }

  /**
   * 最近的输出：先对完整的缓冲（最多 200 行）脱敏，再取末尾 40 行。
   * 否则截取窗口切掉 `-----BEGIN … PRIVATE KEY-----` 那一行后，私钥正文就认不出来了（第三轮复核第 1 条）。
   */
  private recentTail() {
    return redactLines(this.tail).slice(-STUCK_TAIL_LINES)
  }

  private onActivity(a: Activity) {
    this.buffer.push(a)
    if (this.buffer.length > ACTIVITY_BUFFER_MAX) this.buffer.shift()
    if (a.kind === 'output' && a.text !== undefined) this.pushTail(a.text)
    this.lastActivityAt = this.mono()
    if (a.kind === 'status' && a.data?.out_of_band !== undefined) {
      const parsed = outOfBandSignal.safeParse(a.data.out_of_band)
      if (parsed.success) {
        this.outOfBand.push(parsed.data)
        void this.renewNow()
      } else this.env.logger.warn('执行器的带外操作信号不合法', parsed.error.message)
    }
    if (isIdleSignal(a)) {
      const hint = a.data?.hint
      this.observedIdle ??= {
        at: this.mono(),
        ...(hint && typeof hint === 'object' ? { hint: hint as Record<string, unknown> } : {}),
        ...(a.text ? { text: a.text } : {}),
      }
      void this.renewNow()
    } else if (isResumedSignal(a)) {
      this.observedIdle = undefined
      // round_closed 只确认旧回复被拒收；确认重试期间的真实恢复仍须上报。
      if (
        this.phase === 'blocked' &&
        (!this.unacked ||
          (typeof this.unacked.outcome === 'object' &&
            this.unacked.outcome.reason === 'round_closed'))
      ) {
        this.signals.push({ resumed: { note: a.text ?? 'worker 自行恢复' } })
        this.enterRunning()
        void this.renewNow()
      }
    } else if (this.phase === 'running') {
      this.observedIdle = undefined
      this.armIdle()
    }
  }

  /** 续约重复下发同一上报时不重复转换，也不重置两分钟期限。 */
  private acceptReport(report: PendingReport) {
    if (report.attempt !== this.grant.attempt || report.seq <= this.lastReportSeq) return
    this.lastReportSeq = report.seq
    this.pendingReport = report
    this.cancelReportWait()
    const terminal =
      report.status === 'ready' || report.status === 'failed' || report.status === 'dropped'
    if (!terminal && this.phase !== 'running') {
      // 已经 blocked（推断或上报）或在验收：这次上报针对的是当前这一轮，立即确认消费，
      // 不存为待处理上报、不启动两分钟计时；当前 blocked 照常交给回复流程。
      this.pendingReport = undefined
      this.discardReport(report.seq)
      return
    }
    if (terminal) {
      this.terminalReport = report
      this.pendingReport = undefined
      this.cancelIdle()
      this.cancelTimeout()
      const outcome = this.reportedOutcome(report)
      this.forceDone?.(outcome)
      // 先固定结构化结果，再取消 harness；取消返回的 cancelled 不能覆盖上报。
      void this.run?.cancel().catch(() => {})
    } else if (report.status === 'question' || report.status === 'blocked') {
      this.cancelIdle()
      this.cancelReportWait = this.env.clock.setTimeout(() => {
        if (this.pendingReport !== report || this.observedIdle || this.runEnded) return
        this.stuck('idle', undefined, undefined, 'busy')
      }, REPORT_BUSY_MS)
    } else this.armIdle()
  }

  /** 作废的上报随下一次续约确认消费（中枢以 seq 作水位，较大的 seq 覆盖较小的）。 */
  private discardReport(seq: number) {
    this.staleReportSeq = Math.max(this.staleReportSeq ?? 0, seq)
    void this.renewNow()
  }

  private reportedOutcome(report: PendingReport): Result<ExecutorOutcome> {
    const prior = this.adapterOutcome?.ok ? this.adapterOutcome.data : undefined
    const result =
      prior && (prior.outcome === 'done' || prior.outcome === 'failed') ? prior.result : undefined
    const artifacts = [...(result?.artifacts ?? [])]
    for (const ref of report.deliverables ?? []) {
      if (!artifacts.some((a) => a.ref === ref)) artifacts.push({ kind: 'pr', ref })
    }
    return ok({
      outcome: report.status === 'failed' ? 'failed' : 'done',
      ...(this.workdir
        ? { workdir: this.workdir }
        : prior?.outcome === 'done' && prior.workdir
          ? { workdir: prior.workdir }
          : {}),
      result: {
        ...result,
        summary: report.summary,
        artifacts,
        verify: result?.verify ?? [],
        executor: this.grant.contract.executor,
        node_id: this.env.nodeId,
        ...(report.reason ? { reported_reason: report.reason } : {}),
        ...(report.status === 'failed' ? { reason: 'worker_failed' } : {}),
        ...(report.status === 'dropped' ? { dropped: true } : {}),
      },
    })
  }

  /** progress 与 idle 矛盾时先等无进展阈值，其余 idle 立即合并。 */
  private mergeIdle() {
    const idle = this.observedIdle
    if (!idle || this.phase !== 'running' || this.terminalReport || this.runEnded) return
    if (this.pendingReport?.status === 'progress') {
      const wait = noProgressMs(this.grant.contract, this.env.roleNoProgressMinutes)
      const left = wait - (this.mono() - idle.at)
      if (left > 0) {
        this.cancelIdle()
        this.cancelIdle = this.env.clock.setTimeout(() => this.mergeIdle(), left)
        return
      }
    }
    this.stuck('idle', idle.hint, idle.text)
  }

  /** 判定卡住并经续约上报（lease_held）。 */
  private stuck(
    trigger: 'idle' | 'no_progress',
    hint?: Record<string, unknown>,
    text?: string,
    observed?: ReportConflict['observed'],
  ) {
    if (this.phase !== 'running' || this.released || this.cancelRequested || this.timedOut) return
    const tail = this.recentTail()
    const workerReport = this.pendingReport
    const reported = workerReport?.status === 'question' || workerReport?.status === 'blocked'
    let verdict: StuckVerdict | null = reported
      ? {
          reason: workerReport.status === 'question' ? 'question' : 'other',
          message:
            workerReport.status === 'question'
              ? (workerReport.question as string)
              : workerReport.summary,
        }
      : null
    try {
      if (!reported)
        verdict =
          this.executor?.classify?.({
            trigger,
            tail,
            idle_ms: Math.max(0, this.mono() - this.lastActivityAt),
            ...(hint ? { hint } : {}),
            contract: this.grant.contract,
          }) ?? null
    } catch (err) {
      this.env.logger.warn('执行器的 classify 抛出异常，按未识别处理', String(err))
    }
    const minutes = noProgressMs(this.grant.contract, this.env.roleNoProgressMinutes) / 60_000
    const v: StuckVerdict =
      verdict ??
      (trigger === 'idle'
        ? { reason: 'other', message: text?.trim() || '执行器报告 worker 已停下，未能识别原因' }
        : {
            reason: 'no_progress',
            message: `已经 ${Number(minutes.toFixed(2))} 分钟没有任何新活动`,
          })
    this.phase = 'blocked'
    this.cancelIdle()
    this.cancelReportWait()
    this.pauseTimeout()
    const session = v.session ?? (typeof hint?.session === 'string' ? hint.session : undefined)
    const fingerprint = approvalFingerprint.safeParse(hint?.approval_fingerprint)
    const delegation = this.delegationFor(v.reason, hint)
    const gen = ++this.stuckGen
    const report = (diff?: string) => {
      // 计算期间 worker 已恢复、回复已送达或租约已结束：这次上报作废。
      if (gen !== this.stuckGen || this.phase !== 'blocked' || this.released) return
      if (this.pendingReport === workerReport) this.pendingReport = undefined
      this.signals.push({
        ...(workerReport ? { report_seq: workerReport.seq } : {}),
        ...(workerReport && (observed || workerReport.status === 'progress')
          ? { report_conflict: { report_seq: workerReport.seq, observed: observed ?? trigger } }
          : {}),
        blocked: {
          basis: reported ? 'reported' : 'inferred',
          ...(workerReport?.status === 'question'
            ? {
                question: {
                  text: workerReport.question as string,
                  options: workerReport.options as ReportQuestion['options'],
                  recommended: workerReport.recommended as string,
                },
              }
            : {}),
          ...(workerReport?.status === 'blocked'
            ? {
                missing: workerReport.missing as string,
                tried: workerReport.tried as string,
              }
            : {}),
          reason: v.reason,
          message: v.message,
          ...(typeof hint?.request_id === 'string' ? { request_id: hint.request_id } : {}),
          ...(fingerprint.success ? { approval_fingerprint: fingerprint.data } : {}),
          ...(tail.length > 0 ? { tail } : {}),
          ...(session ? { session } : {}),
          ...delegation,
          ...(diff ? { diff_stat: diff } : {}),
        },
      })
      void this.renewNow()
    }
    // 改动摘要（D15）：工作目录在 git 仓库中时附带；不是 git 目录直接上报，取不到时省略。
    if (!this.inGitRepo()) report()
    else void this.diffStat().then(report)
  }

  /** 工作目录是否在 git 仓库中（向上找 `.git`，不启动进程）。 */
  private inGitRepo(): boolean {
    let dir = this.workdir ?? this.cwd
    if (!dir) return false
    for (;;) {
      if (existsSync(join(dir, '.git'))) return true
      const parent = dirname(dir)
      if (parent === dir) return false
      dir = parent
    }
  }

  /**
   * 这次卡住的代回复字段（D15）：
   * - supervisor 的批准刚被拒收：`no_delegate: true`，不带 decision_id；
   * - 授权卡住且执行器在 hint 中给出 `decision_id`，并且它确实来自本租约的预检：带上 decision_id 与
   *   节点记录的请求文本（工具、命令来自节点发出的预检，不取执行器的说法）；
   * - 其他：不带。
   */
  private delegationFor(
    reason: BlockedReason,
    hint: Record<string, unknown> | undefined,
  ): Pick<BlockedSignal, 'decision_id' | 'request' | 'no_delegate'> {
    this.blockedDecision = undefined
    if (this.noDelegateNext) {
      this.noDelegateNext = false
      return { no_delegate: true }
    }
    if (reason !== 'awaiting_approval') return {}
    const id = hint?.decision_id
    if (typeof id !== 'number' || !Number.isInteger(id)) return {}
    // 只认执行器最近一次预检的判定：更早的判定可能对应已经消失的请求。
    if (id !== this.latestDecision) return {}
    const rec = this.decisions.get(id)
    if (!rec) return {}
    this.blockedDecision = rec
    return { decision_id: id, request: blockedRequestOf(rec.req, rec.sentPaths) }
  }

  private async diffStat(): Promise<string | undefined> {
    const dir = this.workdir ?? this.cwd
    if (!dir || !this.inGitRepo()) return undefined
    try {
      // gitdir 必须指向登记仓库，否则不计算（computeDiffStat 内校验，所有 git 走安全 git）。
      return await computeDiffStat(dir, {
        registeredRepos: this.repos,
        ...(this.env.envRunner ? { run: this.env.envRunner } : {}),
        env: this.env.envVars ?? executorEnv(),
      })
    } catch {
      return undefined
    }
  }

  private envReport(command: string | undefined, cwd: string): Promise<NodeEnvReport> {
    return nodeEnvReport(command, cwd, {
      registeredRepos: this.repos,
      snapshot: this.snapshot,
      taskBranch: this.reportedBranch,
      ...(this.env.envRunner ? { run: this.env.envRunner } : {}),
      env: this.env.envVars ?? executorEnv(),
    })
  }

  /**
   * supervisor 的批准送达前的复核（D15）：执行器传入实时读到的待批请求。只有与这次卡住引用的
   * 判定请求一致才放行；判定时上报过环境（执行目录可信）的，还要重新校验 gitdir、执行目录不变、
   * 推送或 gh 环境复查通过。其他回复（用户的、拒绝、文字）直接通过。任何不确定都返回 false。
   */
  private async confirmApproval(
    reply: DeliveredReply,
    live: PrecheckRequest | undefined,
  ): Promise<boolean> {
    if (reply.by !== 'supervisor' || reply.kind !== 'approve') return true
    try {
      const rec = this.blockedDecision
      if (!rec || !live) return false
      if (live.tool !== rec.req.tool || live.command !== rec.req.command) return false
      if (JSON.stringify(live.paths ?? []) !== JSON.stringify(rec.req.paths ?? [])) return false
      if (live.workdirTrusted !== rec.req.workdirTrusted) return false
      // 判定时没有上报环境（执行目录不可信）：只核对请求本身。
      if (rec.req.workdirTrusted !== true) return true
      const cwd = live.cwd
      if (!cwd || cwd !== rec.req.cwd) return false
      // 重新计算（含 gitdir 校验）：gitfile 在等待期间被改写时 command_cwd 缺失，复核不通过。
      const now = await this.envReport(live.command, cwd)
      if (now.command_cwd === undefined || now.command_cwd !== rec.report.command_cwd) return false
      if (rec.report.push_env_ok !== undefined || now.push_env_ok !== undefined) {
        if (now.push_env_ok !== true) return false
      }
      if (rec.report.gh_env_ok !== undefined || now.gh_env_ok !== undefined) {
        if (now.gh_env_ok !== true) return false
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * 执行器上报任务分支（写类适配器启动 worker 之前）：worktree realpath 后随下一次续约上报，
   * 每个租约一次。中枢还没有快照时，对执行器解析出的登记仓库（`report.repo`）采集快照一并上报；
   * 已有快照（随租约下发）时只用它，不重新采集。
   */
  /**
   * 返回的 Promise 在 realpath 与仓库快照采集完成、待上报内容就绪后结束（不等中枢确认）：执行器应等它
   * 结束再启动 worker，快照因此反映 worker 改动之前的仓库状态（remote_url 等）。不会 reject。
   */
  private reportBranch(report: { branch: string; worktree: string; repo?: string }): Promise<void> {
    if (this.branchReported) return Promise.resolve()
    if (!taskBranch.safeParse(report.branch).success) {
      this.env.logger.warn(`执行器上报的任务分支不合法，忽略：${report.branch}`)
      return Promise.resolve()
    }
    this.branchReported = true
    return (async () => {
      let worktree: string
      try {
        worktree = await realpath(report.worktree)
      } catch {
        this.env.logger.warn(`任务 worktree ${report.worktree} 无法解析，不上报任务分支`)
        return
      }
      let collected: RepoSnapshot | undefined
      if (!this.snapshot && report.repo) {
        let why: string
        try {
          const r = await snapshotRepoResult(report.repo, {
            registeredRepos: this.repos,
            ...(this.env.envRunner ? { run: this.env.envRunner } : {}),
            env: this.env.envVars ?? executorEnv(),
          })
          collected = r.ok ? r.snapshot : undefined
          why = r.ok ? '' : r.reason
        } catch (err) {
          collected = undefined
          why = String(err)
        }
        // 没有快照的任务之后不能走合并流程（中枢与 pr-merge 都只认快照），记下原因便于排查。
        if (!collected) {
          this.env.logger.warn(`登记仓库 ${report.repo} 的快照没有采到（${why}），任务分支照常上报`)
        }
      }
      if (this.released) return
      this.snapshot ??= collected
      this.workdir = worktree
      this.reportedBranch = report.branch
      this.pendingBranch = {
        branch: report.branch,
        worktree,
        ...(collected ? { repo_snapshot: collected } : {}),
      }
      void this.renewNow()
    })().catch((err) => {
      this.env.logger.warn('准备任务分支上报失败', String(err))
    })
  }

  private enterRunning() {
    this.observedIdle = undefined
    // 从非运行阶段恢复时旧的上报已经过时：取消等待计时并确认消费，不接管之后的判定。
    // 已在运行（幂等确认重复进入）时保留运行中刚到达的上报。
    if (this.phase !== 'running') this.cancelReportWait()
    if (this.phase !== 'running' && this.pendingReport) {
      const stale = this.pendingReport
      this.pendingReport = undefined
      this.discardReport(stale.seq)
    }
    this.phase = 'running'
    this.stuckGen++
    this.blockedDecision = undefined
    if (this.runEnded) return
    this.lastActivityAt = this.mono()
    this.armIdle()
    this.armTimeout()
  }

  private armIdle() {
    this.cancelIdle()
    if (
      this.released ||
      this.phase !== 'running' ||
      this.pendingReport?.status === 'question' ||
      this.pendingReport?.status === 'blocked'
    )
      return
    this.cancelIdle = this.env.clock.setTimeout(
      () => this.stuck('no_progress'),
      noProgressMs(this.grant.contract, this.env.roleNoProgressMinutes),
    )
  }

  private armTimeout() {
    this.cancelTimeout()
    if (this.released || this.timedOut) return
    this.timeoutArmedAt = this.mono()
    this.cancelTimeout = this.env.clock.setTimeout(
      () => this.onTimeout(),
      Math.max(0, this.timeoutLeftMs),
    )
  }

  /** blocked 等待回复期间不计入运行时间。 */
  private pauseTimeout() {
    this.cancelTimeout()
    this.cancelTimeout = () => {}
    this.timeoutLeftMs -= Math.max(0, this.mono() - this.timeoutArmedAt)
  }

  private onTimeout() {
    if (this.released) return
    this.timedOut = true
    this.cancelIdle()
    this.abort.abort()
    void this.run?.cancel().catch(() => {})
    this.cancelGrace = this.env.clock.setTimeout(() => {
      this.env.logger.warn(`任务 ${this.grant.task_id} 超时后执行器未响应取消，强制结束`)
      this.forceDone?.(ok({ outcome: 'cancelled', message: '超时后强制结束' }))
    }, this.env.timeoutGraceMs)
  }

  private dispatchTokenFailure(): Result<ExecutorOutcome> {
    return ok({
      outcome: 'failed',
      result: {
        summary: '无法写入派工绑定 token 文件',
        reason: 'lease_token_write_failed',
        artifacts: [],
        verify: [],
        executor: this.grant.contract.executor,
        node_id: this.env.nodeId,
      },
    })
  }

  private writeDispatchToken(): Promise<void> {
    const token = this.dispatchToken
    if (!token || this.tokenFilesClosed) return Promise.resolve()
    this.tokenWrites = this.tokenWrites.then(async () => {
      if (this.released || this.tokenFilesClosed) return
      try {
        this.leaseTokenFile = await writeLeaseTokenFile(
          this.env.home,
          this.grant.task_id,
          this.grant.lease_id,
          token,
        )
        this.dispatchTokenSha256 = createHash('sha256').update(token).digest('hex').slice(0, 16)
      } catch {
        if (this.executor?.adapterCapabilities.raindown_mcp === true) {
          this.tokenWriteFailed = true
          this.forceDone?.(this.dispatchTokenFailure())
          this.abort.abort()
          void this.run?.cancel().catch(() => {})
        } else {
          this.env.logger.warn(`任务 ${this.grant.task_id} 无法写入派工绑定 token 文件，继续执行`)
        }
      }
    })
    return this.tokenWrites
  }

  private async execute() {
    const { grant, env } = this
    const executor = env.registry.get(grant.contract.executor)
    this.executor = executor
    let outcome: Result<ExecutorOutcome>
    this.scheduleRenew()
    const cwd = await resolveContractCwd(env.home, grant.contract)
    this.repos = cwd.ok ? await workspaceRepos(env.home, grant.contract.workspace) : []
    const directory = cwd.ok ? checkWorkingDirectory(cwd.data) : undefined
    if (this.released) return
    if (!executor) {
      outcome = fail('failure', 'unknown_executor', `节点没有执行器 ${grant.contract.executor}`)
    } else if (!cwd.ok) {
      outcome = ok({
        outcome: 'failed',
        result: {
          summary: cwd.error.message,
          reason: cwd.error.code,
          artifacts: [],
          verify: [],
          executor: grant.contract.executor,
          node_id: env.nodeId,
        },
      })
    } else if (directory && !directory.ok) {
      const registeredRepoMissing = this.repos.includes(cwd.data)
      outcome =
        directory.error.code === 'cwd_missing'
          ? ok({
              outcome: 'blocked',
              reason: registeredRepoMissing ? 'other' : 'workdir_missing',
              message: registeredRepoMissing
                ? `登记的仓库路径不存在：${cwd.data}`
                : directory.error.message,
            })
          : directory
    } else {
      this.cwd = cwd.data
      // 登记仓库快照（D15）：中枢投影里已固定的快照随租约下发，节点直接使用、不再采集；
      // 没有时在任务首次上报分支时对执行器解析出的仓库采集（见 reportBranch）。
      this.snapshot = grant.repo_snapshot
      if (this.released) return
      const basePrecheck = createPolicyPrecheck({
        client: env.client,
        taskId: grant.task_id,
        cwd: cwd.data,
        clock: env.clock,
        signal: this.abort.signal,
        ...(env.precheckTimeoutMs === undefined ? {} : { timeoutMs: env.precheckTimeoutMs }),
        leaseToken: grant.lease_token,
        envReport: (command, dir) => this.envReport(command, dir),
        onSupervisorDecision: (id, req, report, sentPaths) => {
          this.decisions.set(id, { req, report, sentPaths })
          while (this.decisions.size > DECISIONS_KEEP) {
            const oldest = this.decisions.keys().next().value
            if (oldest === undefined) break
            this.decisions.delete(oldest)
          }
        },
      })
      // 记下执行器最近一次预检的判定：卡住只能引用它（更早的判定可能对应已消失的请求）。
      const precheck: Precheck = async (req) => {
        const seq = ++this.precheckSeq
        this.latestDecision = undefined
        const v = await basePrecheck(req)
        if (seq === this.precheckSeq) this.latestDecision = v.allow ? undefined : v.decision_id
        return v
      }
      this.armTimeout()
      this.armIdle()
      // 唤醒绑定 token 写进 state/wake/<task>.token，执行器只拿到路径（tasks 5.3；D6）：token 不进 argv、
      // env、日志；执行结束（含失败、取消、放弃租约）即删除。
      let wakeTokenFile: string | undefined
      try {
        if (grant.wake_token) {
          wakeTokenFile = await writeWakeTokenFile(
            env.home,
            grant.task_id,
            grant.lease_id,
            grant.wake_token,
          )
        }
        this.tokenFilesReady = true
        await this.writeDispatchToken()
        if (this.tokenWriteFailed) throw new Error('无法写入派工绑定 token 文件')
        // 写文件期间可能已放弃租约：不再启动会话，finally 仍会清理凭证。
        if (this.released) return
        this.run = executor.run(grant.contract, {
          taskId: grant.task_id,
          attempt: grant.attempt,
          cwd: cwd.data,
          nodeId: env.nodeId,
          env: {
            ...executorEnv(),
            ...dualRaindownEnv({
              RAINDOWN_HOME: env.home,
              RAINDOWN_TASK_ID: grant.task_id,
              RAINDOWN_WORKSPACE: grant.contract.workspace,
            }),
          },
          signal: this.abort.signal,
          ...(grant.resume ? { resume: grant.resume } : {}),
          ...(grant.recovery ? { recovery: grant.recovery } : {}),
          ...(grant.inputs?.length ? { inputs: grant.inputs } : {}),
          ...(wakeTokenFile ? { wakeTokenFile } : {}),
          ...(this.leaseTokenFile ? { leaseTokenFile: this.leaseTokenFile } : {}),
          ...(this.env.hubUrl ? { hubUrl: this.env.hubUrl } : {}),
          precheck,
          reportBranch: (report) => this.reportBranch(report),
          confirmApproval: (reply, live) => this.confirmApproval(reply, live),
          ...(grant.resume
            ? { reportResumeReplyDropped: (details) => this.reportResumeReplyDropped(details) }
            : {}),
        })
        const run = this.run
        // 派工输入已交给执行器：不再中途重复注入，并随下一次续约确认（中枢据此记为送达）。
        for (const input of grant.inputs ?? []) {
          this.injected.add(input.input_seq)
          this.dispatchAcks.push(input.input_seq)
        }
        const forced = new Promise<Result<ExecutorOutcome>>((resolve) => {
          this.forceDone = resolve
        })
        const pump = (async () => {
          for await (const a of run.activity) this.onActivity(a)
        })().catch(() => {})
        const adapterDone = run.done.then((result) => {
          this.adapterOutcome = result
          return result
        })
        outcome = await Promise.race([adapterDone, forced])
        // 等执行器把剩余活动交出来（执行器结束时应关闭活动流），最多等一个续约周期。
        await Promise.race([pump, forced, sleep(env.clock, this.intervalMs, this.abort.signal)])
      } catch (err) {
        outcome = this.tokenWriteFailed
          ? this.dispatchTokenFailure()
          : grant.wake_token && !wakeTokenFile
            ? ok({
                outcome: 'failed',
                result: {
                  summary: '无法写入唤醒绑定 token 文件',
                  reason: 'wake_token_write_failed',
                  artifacts: [],
                  verify: [],
                  executor: grant.contract.executor,
                  node_id: env.nodeId,
                },
              })
            : fail('failure', 'executor_error', (err as Error).message)
      } finally {
        this.cancelTimeout()
        this.cancelIdle()
        this.cancelGrace()
        this.cancelReportWait()
        this.tokenFilesClosed = true
        await this.tokenWrites
        if (wakeTokenFile) await removeWakeTokenFile(wakeTokenFile).catch(() => {})
        if (this.leaseTokenFile) await removeLeaseTokenFile(this.leaseTokenFile).catch(() => {})
        // 任务私有目录变空时一并删除（审查目录由执行器在会话结束时清理）。
        await removeEmptyTaskRunDir(this.env.home, this.grant.task_id).catch(() => {})
      }
    }
    this.runEnded = true
    // 回复已交给 worker、worker 随即结束：先把送达确认完（写 task.unblocked），回复才不会被当作丢弃。
    if (this.delivering) await this.delivering
    // 送到一半的输入先结束；待发的派工 / 运行中输入确认随下面提交前的续约一并发出（短任务不丢确认）。
    if (this.injecting) await this.injecting
    while (this.unacked && !this.released) {
      await this.renewNow()
      if (this.unacked && !this.released) await sleep(env.clock, env.retryMs)
    }
    if (this.released) return
    // harness 的结束可能紧随 MCP 上报；提交前再读取一次中枢，保留最后的结构化结果。
    do {
      await this.renewNow()
      if (this.renewReadFailed && !this.released) await sleep(env.clock, env.retryMs)
    } while (
      (this.renewReadFailed || this.dispatchAcks.length > 0 || this.inputAcks.length > 0) &&
      !this.released
    )
    if (this.released) return
    if (this.terminalReport) outcome = this.reportedOutcome(this.terminalReport)
    let req = this.completion(this.tokenWriteFailed ? this.dispatchTokenFailure() : outcome)
    if (this.terminalReport && !this.timedOut && !this.tokenWriteFailed) {
      req = { ...req, report_seq: this.terminalReport.seq }
    } else if (
      !this.timedOut &&
      !this.cancelRequested &&
      !this.tokenWriteFailed &&
      this.pendingReport &&
      (this.pendingReport.status === 'question' || this.pendingReport.status === 'blocked')
    ) {
      const report = this.pendingReport
      req = {
        lease_token: grant.lease_token,
        outcome: 'blocked',
        report_seq: report.seq,
        basis: 'reported',
        blocked_reason: report.status === 'question' ? 'question' : 'other',
        message: report.status === 'question' ? (report.question as string) : report.summary,
        ...(report.status === 'question'
          ? {
              question: {
                text: report.question as string,
                options: report.options as ReportQuestion['options'],
                recommended: report.recommended as string,
              },
            }
          : { missing: report.missing as string, tried: report.tried as string }),
      }
      this.pendingReport = undefined
    }
    // 卡住期间执行器完成（例如用户直接在终端里答复后 worker 做完了）：blocked 不能直接转 done，
    // 先上报恢复为 running。崩溃或以 blocked 结束时不上报恢复：中枢写 blocked → blocked，
    // 有待送达的回复时带着回复重新排队（PR #16 审查第 5 条）。
    if (this.phase === 'blocked' && req.outcome === 'done') {
      this.phase = 'running'
      this.stuckGen++
      this.signals.push({ resumed: { note: '执行器已结束' } })
    }
    if (req.outcome === 'blocked') {
      // 以 blocked 结束（崩溃、执行器自己判定卡住）时同样附带改动摘要；刚拒收过批准时不委托。
      const diff = await this.diffStat()
      if (this.released) return
      const noDelegate = this.noDelegateNext
      this.noDelegateNext = false
      if (diff || noDelegate) {
        req = {
          ...req,
          ...(diff ? { diff_stat: diff } : {}),
          ...(noDelegate ? { no_delegate: true } : {}),
        }
      }
    }
    // 最后一批活动与状态变化随续约送达，再提交结束。
    while (
      !this.released &&
      (this.buffer.length > 0 || this.signals.length > 0 || this.outOfBand.length > 0)
    ) {
      await this.renewNow()
      if ((this.signals.length > 0 || this.outOfBand.length > 0) && !this.released)
        await sleep(env.clock, env.retryMs)
    }
    if (this.released) return
    if (
      req.outcome === 'done' &&
      cwd.ok &&
      grant.contract.verify?.length &&
      this.terminalReport?.status !== 'dropped' &&
      !this.cancelRequested
    ) {
      this.phase = 'verifying'
      this.signals.push({ phase: 'verifying' })
      // 中枢确认阶段切换后才启动命令；可重试错误时保留 signal，期间继续续约。
      while (this.signals.length > 0 && !this.released && !this.cancelRequested) {
        await this.renewNow()
        if (this.signals.length > 0 && !this.released) await sleep(env.clock, env.retryMs)
      }
      if (this.released) return
      const verify = await verifyTask(
        grant.contract.verify,
        // 执行器给出的工作目录优先（codex-orca 在 Orca worktree 里工作，不在合同的 cwd）。
        (outcome.ok && outcome.data.outcome === 'done' ? outcome.data.workdir : undefined) ??
          cwd.data,
        env.clock,
        this.abort.signal,
        grant.contract.role,
      )
      if (this.released) return
      const failed = !this.cancelRequested && verify.some((v) => v.exit_code !== 0 || v.timed_out)
      const missing = failed
        ? verify.find((v) => {
            if (v.cwd === undefined) return false
            const directory = checkWorkingDirectory(v.cwd)
            return !directory.ok && directory.error.code === 'cwd_missing'
          })
        : undefined
      if (missing) {
        const message = `工作目录不存在：${missing.cwd}`
        this.outOfBand.push({
          id: `verify-workdir-missing:${grant.lease_id}`,
          kind: 'session_removed',
          message,
        })
        req = {
          lease_token: grant.lease_token,
          outcome: 'blocked',
          blocked_reason: 'workdir_missing',
          basis: 'inferred',
          ...(req.report_seq ? { report_seq: req.report_seq } : {}),
          message,
        }
        while (!this.released && this.outOfBand.length > 0) {
          await this.renewNow()
          if (this.outOfBand.length > 0 && !this.released) await sleep(env.clock, env.retryMs)
        }
      } else {
        req = {
          ...req,
          outcome: failed ? 'failed' : 'done',
          result: { ...req.result, verify, ...(failed ? { reason: 'verify_failed' } : {}) },
        }
      }
    }
    if (this.cancelRequested) {
      req = {
        lease_token: grant.lease_token,
        outcome: 'cancelled',
        ...('result' in req ? { result: req.result } : {}),
      }
    }
    await this.submit(req)
  }

  private completion(outcome: Result<ExecutorOutcome>): CompleteLeaseRequest {
    const token = { lease_token: this.grant.lease_token }
    const tail = this.recentTail()
    const withTail = tail.length > 0 ? { tail } : {}
    const failed = (summary: string, reason: string): CompleteLeaseRequest => ({
      ...token,
      outcome: 'failed',
      result: {
        summary,
        artifacts: [],
        verify: [],
        executor: this.grant.contract.executor,
        node_id: this.env.nodeId,
        reason,
      },
    })
    // 超时优先：无论执行器以什么结果收尾，超时的任务都是 failed(timeout)。
    if (this.timedOut && !this.cancelRequested) {
      return failed(
        `执行超时（timeout_s=${this.grant.contract.timeout_s}），执行器已停止`,
        'timeout',
      )
    }
    if (!outcome.ok) {
      return {
        ...token,
        outcome: 'blocked',
        blocked_reason: 'crashed',
        basis: 'inferred',
        message: `执行器出错（${outcome.error.code}）：${outcome.error.message}`,
        ...withTail,
      }
    }
    const o = outcome.data
    switch (o.outcome) {
      case 'done':
      case 'failed':
        return { ...token, outcome: o.outcome, result: o.result }
      case 'blocked':
        return {
          ...token,
          outcome: 'blocked',
          blocked_reason: o.reason,
          basis: 'inferred',
          message: o.message,
          ...(o.tail ? { tail: o.tail.slice(-200) } : withTail),
          ...(o.session ? { session: o.session } : {}),
        }
      case 'exited': {
        const how = o.exit_code === null ? `信号 ${o.signal ?? '未知'}` : `退出码 ${o.exit_code}`
        return {
          ...token,
          outcome: 'blocked',
          blocked_reason: 'crashed',
          basis: 'inferred',
          message: `执行器进程意外退出（${how}）${o.message ? `：${o.message}` : ''}`,
          ...withTail,
        }
      }
      case 'cancelled':
        if (this.cancelRequested) {
          return {
            ...token,
            outcome: 'cancelled',
            ...(o.message ? { message: o.message } : {}),
            ...(o.result ? { result: o.result } : {}),
          }
        }
        return {
          ...token,
          outcome: 'blocked',
          blocked_reason: 'crashed',
          basis: 'inferred',
          message: o.message ?? '执行器自行中止',
          ...withTail,
        }
    }
  }

  /** 提交结束：可重试的错误持续重试（期间续约照常），其他错误放弃。 */
  private async submit(req: CompleteLeaseRequest) {
    for (;;) {
      if (this.released) return
      const r = await this.env.client.complete(this.grant.lease_id, clipCompletion(req))
      if (r.ok) break
      if (r.error.kind !== 'retryable') {
        this.env.logger.warn(`租约 ${this.grant.lease_id} 提交被拒绝`, r.error.code)
        break
      }
      await sleep(this.env.clock, this.env.retryMs)
    }
    this.released = true
    this.cancelRenew()
    this.cancelReportWait()
  }
}

/**
 * 启动节点。先取得节点单实例锁（`state/node.lock`）：启动清理（`state/wake/` 的 token 文件、执行器残留）
 * 只在确认没有并行节点时进行；锁在节点停止或启动失败时释放。
 */
export async function startNode(options: StartNodeOptions): Promise<Result<RunningNode>> {
  const lock = await acquireNodeLock(options.home)
  if (!lock.ok) return lock
  let started: Result<RunningNode>
  try {
    started = await startNodeLocked(options)
  } catch (err) {
    lock.data.release()
    throw err
  }
  if (!started.ok) {
    lock.data.release()
    return started
  }
  const node = started.data
  let stopping: Promise<void> | undefined
  return ok({
    ...node,
    stop() {
      stopping ??= node.stop().finally(() => lock.data.release())
      return stopping
    },
  })
}

async function startNodeLocked(options: StartNodeOptions): Promise<Result<RunningNode>> {
  const { home } = options
  const clock = options.clock ?? systemClock
  const logger = options.logger ?? consoleLogger
  const host = options.hostname ?? osHostname()

  const hubConfig = await loadHubConfig(home)
  if (!hubConfig.ok) return hubConfig
  const nodeConfig = await loadNodeConfig(home)
  if (!nodeConfig.ok) return nodeConfig

  // 本机节点用 user token（options.token 或 state/hub.token），不声明身份：中枢在注册与租约流程中
  // 按 node_id 记为 node:<id>（user token 不能声明 node:*）。设置了 RAINDOWN_HUB_TOKEN 时它是签发给
  // node:<id> 的绑定 token，此时声明同一身份（design D9）。
  const envToken = options.token === undefined ? readRaindownEnv(HUB_TOKEN_ENV) : undefined
  let token = options.token ?? envToken
  if (token === undefined) {
    const path = raindownPaths(home).hubToken
    if (!existsSync(path)) {
      return fail(
        'retryable',
        'hub_token_missing',
        `缺少 ${path}，请先启动中枢（raindown hub start）`,
      )
    }
    token = (await readFile(path, 'utf8')).trim()
  }

  // 上次运行残留的唤醒 token 文件（进程被杀时来不及删除）：启动时清理，租约早已失效。
  // 调用方（startNode）已持有节点单实例锁，不会误删并行节点的文件。
  await cleanWakeTokenDir(home)
  await cleanLeaseTokenFiles(home)
  // CODEX_HOME 从 state/ 迁到 run/（worker-credential-isolation D2）；失败时保留旧位置继续使用。
  const codexHomes = await migrateCodexHomes(home, (message) => logger.warn(message))
  for (const dir of codexHomes.migrated) logger.info(`CODEX_HOME 已迁移到 ${dir}`)

  const id =
    options.nodeId !== undefined ? ok(options.nodeId) : await loadOrCreateNodeId(home, host)
  if (!id.ok) return id
  const nodeId = id.data

  let registry: ExecutorRegistry
  try {
    registry = createExecutorRegistry(options.executors ?? [createFakeExecutor({ clock })])
  } catch (err) {
    return fail('usage', 'invalid_executors', (err as Error).message)
  }
  const capabilities = [
    ...new Set([
      ...nodeConfig.data.capabilities,
      ...(options.capabilities ?? []),
      ...registry.capabilities(),
    ]),
  ].sort()
  const concurrency = options.concurrency ?? nodeConfig.data.concurrency
  const hubUrl = options.hubUrl ?? resolveHubUrl(hubConfig.data, nodeConfig.data)
  const client = createNodeHubClient({
    url: hubUrl,
    token,
    ...(envToken ? { actor: `node:${nodeId}` } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const retryMs = options.retryMs ?? 1_000
  const env: Env = {
    home,
    nodeId,
    hubUrl,
    client,
    clock,
    registry,
    logger,
    retryMs,
    roleNoProgressMinutes: options.noProgressMinutes,
    timeoutGraceMs: options.timeoutGraceMs ?? TIMEOUT_GRACE_MS,
    deliverTimeoutMs: options.deliverTimeoutMs ?? DELIVER_TIMEOUT_MS,
    deliverGiveUpMs: options.deliverGiveUpMs ?? DELIVER_GIVE_UP_MS,
    precheckTimeoutMs: options.precheckTimeoutMs,
    envRunner: options.envRunner,
    envVars: options.envVars,
  }

  const reserved = options.reserved ?? nodeConfig.data.reserved
  /** 各类别执行槽的容量（D12）。 */
  const capacity: Record<LeaseSlotKind, number> = {
    general: concurrency,
    supervisor: reserved.supervisor,
    reply: reserved.reply,
  }
  const runners = new Map<LeaseRunner, LeaseSlotKind>()
  const stopper = new AbortController()
  const slotWakes = new Set<() => void>()
  const acquireAborts = new Set<AbortController>()
  let cancelJump = () => {}

  const used = (kind: LeaseSlotKind) => {
    let n = 0
    for (const k of runners.values()) if (k === kind) n++
    return n
  }
  const wakeSlots = () => {
    for (const wake of [...slotWakes]) wake()
  }
  /** 等到有租约结束或节点停止。 */
  const waitForSlot = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        slotWakes.delete(done)
        stopper.signal.removeEventListener('abort', done)
        resolve()
      }
      slotWakes.add(done)
      stopper.signal.addEventListener('abort', done, { once: true })
    })

  /**
   * 角色设定的无进展阈值：显式传入的 resolver 优先；否则每次领到租约时重新读取
   * `config/roles/`（改了角色无需重启节点），读取失败时用默认值。
   */
  const roleResolver = async (): Promise<NoProgressResolver | undefined> => {
    if (options.noProgressMinutes) return options.noProgressMinutes
    const loaded = await loadRoles(home)
    if (!loaded.ok) return undefined
    const minutes = new Map(loaded.data.roles.map((r) => [r.name, r.no_progress_minutes]))
    return (contract) => minutes.get(contract.role)
  }

  const startRunner = async (grant: LeaseGrant, kind: LeaseSlotKind) => {
    const resolver = await roleResolver()
    // 读取角色期间节点被停止：不再启动，租约到期后由中枢按合同处理（与 stop 的语义一致）。
    if (stopper.signal.aborted) return
    const runner = new LeaseRunner({ ...env, roleNoProgressMinutes: resolver }, grant)
    runners.set(runner, kind)
    void runner.finished.finally(() => {
      runners.delete(runner)
      wakeSlots()
    })
  }

  /** 最近一次隔离探针结果；随注册上报。旧中枢拒绝该字段后不再上报。 */
  let latestProbe: IsolationProbeReport | undefined
  let probeFieldRejected = false
  const register = () =>
    client.register({
      node_id: nodeId,
      hostname: host,
      version: options.version ?? VERSION,
      capabilities,
      executors: registry.info(),
      concurrency,
      ...(latestProbe && !probeFieldRejected ? { isolation_probe: latestProbe } : {}),
    })
  /** 注册失败时，若是旧中枢不认识 isolation_probe：之后不再上报该字段，返回 true 表示应立即重试。 */
  const dropProbeFieldIfRejected = (error: { code: string; details?: unknown }) => {
    if (probeFieldRejected || !latestProbe || !rejectsField(error, 'isolation_probe')) return false
    probeFieldRejected = true
    logger.warn('中枢不接受隔离探针结果（isolation_probe），之后注册不再上报，中枢显示为未探测')
    return true
  }

  /** 各领取循环共用的注册：成功前持续重试，节点停止时返回 false。 */
  let registration: Promise<boolean> | undefined
  const ensureRegistered = () => {
    registration ??= (async () => {
      while (!stopper.signal.aborted) {
        const r = await register()
        if (r.ok) {
          logger.info(`节点 ${nodeId} 已注册到 ${hubUrl}`, { capabilities })
          return true
        }
        if (dropProbeFieldIfRejected(r.error)) continue
        logger.warn('节点注册失败，稍后重试', r.error.code)
        await sleep(clock, retryMs, stopper.signal)
      }
      return false
    })()
    return registration
  }

  // 隔离自检探针：启动时（领取任务之前）、每 6 小时、macOS 版本变化时运行；之后的结果经重新注册上报。
  const probeOptions = options.isolationProbe
  let probing: Promise<void> | undefined
  let cancelProbeTimers = () => {}
  const runProbe = (why: string): Promise<void> => {
    if (!probeOptions) return Promise.resolve()
    probing ??= (async () => {
      try {
        const { run, intervalMs: _i, versionCheckMs: _v, ...rest } = probeOptions
        latestProbe = await (run ?? runIsolationProbe)({
          ...rest,
          home,
          hubUrl,
          executors: registry.info(),
        })
        const failed = latestProbe.runs.filter((r) => !probeRunPassed(r)).length
        logger.info(
          `隔离自检（${why}）完成：${latestProbe.runs.length} 项执行器 × 沙箱设置，${failed} 项不通过`,
        )
      } catch (err) {
        logger.warn(`隔离自检（${why}）失败`, String(err))
      } finally {
        probing = undefined
      }
    })()
    return probing
  }
  /** 探针结果变化后重新注册一次（失败只记日志，领取循环在中枢丢失注册时会自行重新注册）。 */
  const reportProbe = async () => {
    if (stopper.signal.aborted || !registration) return
    let r = await register()
    if (!r.ok && dropProbeFieldIfRejected(r.error)) r = await register()
    if (!r.ok) logger.warn('上报隔离自检结果失败', r.error.code)
  }
  if (probeOptions) {
    const intervalMs = probeOptions.intervalMs ?? ISOLATION_PROBE_INTERVAL_MS
    const versionCheckMs = probeOptions.versionCheckMs ?? ISOLATION_PROBE_VERSION_CHECK_MS
    const macosVersion = probeOptions.macosVersion ?? defaultMacosVersion
    let lastRun = clock.now()
    const tick = async () => {
      if (stopper.signal.aborted) return
      let why: string | undefined
      if (clock.now() - lastRun >= intervalMs) why = '定期'
      else if (latestProbe) {
        const v = await macosVersion()
        if (v !== null && v !== latestProbe.macos_version) why = `macOS 版本变为 ${v}`
      }
      if (why) {
        lastRun = clock.now()
        await runProbe(why)
        await reportProbe()
      }
    }
    const step = Math.min(intervalMs, versionCheckMs)
    const arm = () => {
      cancelProbeTimers = clock.setTimeout(() => {
        void tick()
          .catch((err) => logger.warn('隔离自检调度失败', String(err)))
          .finally(() => {
            if (!stopper.signal.aborted) arm()
          })
      }, step)
    }
    arm()
  }

  const slotsRetryMs = options.slotsRetryMs ?? SLOTS_RETRY_MS
  const slotsRejected = new Set<LeaseSlotKind>()

  /** 一个类别的领取循环：只为本类别的空位领取，计数也只算本类别（D12）。 */
  const loop = async (kind: LeaseSlotKind) => {
    while (!stopper.signal.aborted) {
      if (!(await ensureRegistered())) break
      const current = registration
      const free = capacity[kind] - used(kind)
      if (free <= 0) {
        await waitForSlot()
        continue
      }
      // 普通循环不带 slots：在新中枢上与 {general: n} 等价，同时兼容不认识 slots 的旧中枢。
      const slots: LeaseSlots | undefined =
        kind === 'general' ? undefined : { general: 0, supervisor: 0, reply: 0, [kind]: free }
      const abort = new AbortController()
      acquireAborts.add(abort)
      const r = await client.acquire(
        { node_id: nodeId, capabilities, wait_s: options.waitS ?? 30, ...(slots ? { slots } : {}) },
        AbortSignal.any([abort.signal, stopper.signal]),
      )
      acquireAborts.delete(abort)
      if (stopper.signal.aborted) break
      if (!r.ok) {
        // 中枢丢失了注册（例如重建）：重新注册；多个循环同时发现时只重置一次。
        if (r.error.code === 'node_not_registered') {
          if (registration === current) registration = undefined
        } else if (slots && rejectsField(r.error, 'slots')) {
          // 旧中枢不认识 slots：只告警一次，长退避后再试（中枢升级后自动恢复）。
          if (!slotsRejected.has(kind)) {
            slotsRejected.add(kind)
            logger.warn(`中枢不接受执行槽（slots），${kind} 预留槽暂停领取，稍后重试`, r.error.code)
          }
          await sleep(clock, slotsRetryMs, stopper.signal)
          continue
        } else logger.warn('领取任务失败，稍后重试', r.error.code)
        await sleep(clock, retryMs, stopper.signal)
        continue
      }
      if (slots && slotsRejected.delete(kind)) {
        logger.info(`中枢已接受执行槽（slots），${kind} 预留槽恢复领取`)
      }
      if (r.data.lease) await startRunner(r.data.lease, kind)
    }
  }

  // 时钟跳变（睡眠唤醒）：立即续约全部租约。
  const monotonic = clock.monotonic?.bind(clock)
  if (monotonic) {
    const threshold = options.jumpThresholdMs ?? JUMP_THRESHOLD_MS
    let lastWall = clock.now()
    let lastMono = monotonic()
    const check = () => {
      const wall = clock.now()
      const mono = monotonic()
      const jumped = wall - lastWall - (mono - lastMono)
      lastWall = wall
      lastMono = mono
      if (jumped > threshold) {
        logger.info(`检测到时钟跳变 ${Math.round(jumped)}ms（睡眠唤醒），立即续约`)
        for (const r of runners.keys()) void r.renewNow()
      }
      if (!stopper.signal.aborted) cancelJump = clock.setTimeout(check, JUMP_CHECK_MS)
    }
    cancelJump = clock.setTimeout(check, JUMP_CHECK_MS)
  }

  // 执行器的启动清理（例如移除审查任务残留的 worktree）在领取任务之前完成。
  const prepared = (async () => {
    for (const p of registry.list()) {
      try {
        await p.prepare?.({ nodeId })
      } catch (err) {
        logger.warn(`执行器 ${p.type} 的启动清理失败`, String(err))
      }
    }
    // 启动时的隔离自检在首次注册之前完成，首次注册即带上结果。
    await runProbe('节点启动')
  })()
  const looping = prepared.then(() =>
    Promise.all(
      LEASE_SLOT_KINDS.filter((kind) => capacity[kind] > 0).map((kind) =>
        loop(kind).catch((err) => logger.warn(`节点领取循环（${kind}）异常退出`, String(err))),
      ),
    ),
  )

  let stopping: Promise<void> | undefined
  return ok({
    nodeId,
    hubUrl,
    capabilities,
    active: () => runners.size,
    stop() {
      stopping ??= (async () => {
        stopper.abort()
        for (const a of acquireAborts) a.abort()
        cancelJump()
        cancelProbeTimers()
        wakeSlots()
        await Promise.allSettled([...runners.keys()].map((r) => r.abandon()))
        await looping
      })()
      return stopping
    },
  })
}
