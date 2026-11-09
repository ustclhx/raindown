import {
  type Artifact,
  clipText,
  fail,
  gitSha,
  latestTrustedReview,
  loadRoles,
  loadWorkspaces,
  mergeInputs,
  NO_ADAPTER_CAPABILITIES,
  ok,
  type Result,
  type Role,
  redactSecrets,
  reviewApproves,
  type SupervisorConfig,
  samePrUrl,
  type TaskContract,
  type TaskResult,
  type TaskView,
  taskKind,
} from '@raindown/core'
import type { NodeHubClient } from './client.ts'
import { nodeHubClientFromHome } from './client.ts'
import { type NodeClock, sleep, systemClock } from './clock.ts'
import {
  ActivityQueue,
  type ExecutorContext,
  type ExecutorOutcome,
  type ExecutorPlugin,
} from './executor.ts'
import {
  createGitHubCli,
  type GhCheck,
  type GhPrMergeState,
  type GhRun,
  type GitHubCli,
  type GitOptions,
  originRepo,
  type PrRef,
  type PrSnapshot,
  parsePrUrl,
  parseRemoteUrl,
  type RepoRef,
  sameRepo,
} from './github.ts'
import { resolveContractCwd } from './workdir.ts'

/**
 * pr-merge 执行器（add-m1-supervisor D10 第 5 步；tasks 5.4；pr-acceptance "合并前的条件核对"
 * "合并后确认发布流水线"）。**不调用任何模型**，全部条件由确定性代码核对，任何一项拿不准都判失败、不合并。
 *
 * 合并前依次核对（任一不满足 → `failed(<原因码>)`，不合并）：
 * 1. 合同 `inputs.merge = {pr, review_task}` 合法（`invalid_inputs`）；
 * 2. 工作目录是本 workspace 登记的仓库，PR 链接的仓库等于其 `remote.origin.url`（`repo_not_in_workspace`）；
 *    并且等于开出 PR 的任务在 worker 启动前采集的 `repo_snapshot.remote_url`（第 4 步读到任务列表后核对）；
 * 3. 本任务由 hub 或 user 创建、origin 为 instruction、`parent` 就是审查任务（`merge_not_eligible`）；
 * 4. 审查任务：同一 workspace、执行器 claude-sdk、角色在 `supervisor.reviewer_roles` 中、已 done、
 *    `inputs.review.pr` 等于该 PR、结论 approve，且是该 PR **最新一次**可信审查（`review_not_approved`）；
 *    中枢不可达时 `failed(merge_unverifiable)`，摘要写明未合并、可重试；
 * 5. 一次 GraphQL 读取 PR 的同一时刻状态（`PrSnapshot`）：链接与编号一致（`pr_unverifiable`）、仓库一致且不是 fork PR
 *    （`repo_not_in_workspace`）、head 分支等于 `inputs.merge.branch`（`head_branch_mismatch`）、open（`pr_not_open`）、base 为默认分支（`base_not_default`）、没有启用合并队列
 *    （`merge_queue_unsupported`）、head 等于 `reviewed_sha` 且检查就是这个提交的（`head_moved`）、不是草稿且可合并
 *    （`not_mergeable`；`UNKNOWN` 时短暂重试）；
 * 6. 同一快照中的检查：至少一项且全部成功、没有进行中的（`checks_not_green`）；`supervisor.allow_no_checks` 时允许没有检查。
 *    `skipping` 不算失败，但不计入"至少一项成功"；检查超过一次查询的上限时无法确认，判失败；
 * 7. 合并前再读一次 head，仍须等于 `reviewed_sha`（`head_moved`）。
 *
 * 合并：`gh pr merge <url> --<merge_method> --match-head-commit <reviewed_sha>`（head 在核对之后变化时 GitHub 拒绝合并）。
 * 不带 `--auto`、分支没有合并队列时 gh 不会改为启用自动合并；为防万一，合并后若 PR 仍为 OPEN 且出现了本次之前没有的
 * 自动合并请求，执行器把它关掉。合并后必须读到 MERGED、合并提交与 `headRefOid == reviewed_sha`，否则 `failed(merge_failed)`；
 * 读不回状态时 `failed(merge_unverified)`，摘要写明 PR 可能已合并。
 *
 * 合并后等待默认分支上该合并提交的 workflow runs（`gh run list --commit <sha> --branch <default>`，只计 `push` 与
 * `workflow_run` 事件）：每次轮询都上报一条活动（心跳，避免被判为无进展）；全部成功（success / skipped / neutral）且下一次查询
 * 没有新的 run → done 附链接；有其他结论 → `failed(pipeline_failed)`（cancelled 的 run 附说明：可能是被同一并发组中更新的
 * 提交取代，请确认最新提交的流水线）；超时（默认 30 分钟）→ `failed(pipeline_timeout)` 附链接；发现窗口（默认 2 分钟）内一直
 * 没有 run → done 并注明未发现发布流水线。合并后被取消时，cancelled 的结果带合并提交与 artifacts。
 */

export const PR_MERGE_EXECUTOR = 'pr-merge'
export const DEFAULT_PIPELINE_TIMEOUT_MS = 30 * 60_000
export const DEFAULT_PIPELINE_POLL_MS = 15_000
export const DEFAULT_RUN_DISCOVERY_MS = 2 * 60_000
/** `mergeable` 为 UNKNOWN（GitHub 仍在计算）时的重试次数与间隔。 */
/** merger 合同 timeout_s 的下限：合并前核对加 30 分钟流水线等待，留出余量（docs/executors.md）。 */
export const MIN_MERGER_TIMEOUT_S = 40 * 60
export const MERGEABLE_RETRIES = 3
export const MERGEABLE_RETRY_MS = 5_000
/** 核对"最新一次可信审查"时读取的任务数（按创建时间倒序）。 */
const REVIEW_SCAN_LIMIT = 500
/** 未结束的任务状态：同一 PR 有这些状态的审查任务时不合并。 */
const UNFINISHED = ['queued', 'running', 'verifying', 'blocked'] as const
/** 计入发布流水线的 workflow run 事件。 */
export const PIPELINE_EVENTS = new Set(['push', 'workflow_run'])

type HubReader = Pick<NodeHubClient, 'showTask' | 'listTasks'>

export interface PrMergeOptions {
  home: string
  clock?: NodeClock
  /** 注入的 gh；缺省调用本机 gh。测试绝不调用真实 gh。 */
  gh?: GitHubCli
  git?: GitOptions
  /** 读取任务的中枢客户端；缺省按 raindown-home 构造。 */
  hub?: HubReader
  /** 读取 workspace 的 supervisor 配置；缺省读 `config/workspaces/`，没有该 workspace 时返回 undefined。 */
  resolveSupervisor?: (workspace: string) => Promise<Result<SupervisorConfig | undefined>>
  /** 全部角色（核对开出 PR 的任务的有效类别）；缺省读 `config/roles/`。 */
  resolveRoles?: () => Promise<Result<readonly Role[]>>
  /** 合并后等待流水线的最长毫秒数，缺省 30 分钟。 */
  pipelineTimeoutMs?: number
  /** 查询 workflow runs 的间隔，缺省 15 秒（也是心跳间隔，不得超过 2 分钟）。 */
  pollMs?: number
  /** 合并后多久仍没有任何 run 即视为没有发布流水线，缺省 2 分钟。 */
  discoveryMs?: number
}

/** 检查的判定（纯函数）。 */
export function evaluateChecks(
  checks: readonly GhCheck[],
  allowNoChecks: boolean,
): { ok: true; note: string } | { ok: false; reason: string } {
  if (checks.length === 0) {
    return allowNoChecks
      ? { ok: true, note: 'PR 没有任何检查（supervisor.allow_no_checks 允许）' }
      : { ok: false, reason: 'PR 没有任何检查（未配置 supervisor.allow_no_checks）' }
  }
  const bad = checks.filter((c) => c.bucket !== 'pass' && c.bucket !== 'skipping')
  if (bad.length > 0) {
    const list = bad.map((c) => `${c.name}（${c.bucket}/${c.state}）`).join('、')
    return { ok: false, reason: `检查未全部成功：${list}` }
  }
  const passed = checks.filter((c) => c.bucket === 'pass').length
  if (passed === 0 && !allowNoChecks)
    return { ok: false, reason: '所有检查都被跳过，没有一项成功的检查' }
  return { ok: true, note: `${passed} 项检查成功` }
}

const RUN_OK = new Set(['success', 'skipped', 'neutral'])

/** workflow runs 的判定（纯函数）：有未结束的为 pending；全部结束时看结论。 */
export function evaluateRuns(runs: readonly GhRun[]): 'pending' | 'success' | 'failed' {
  if (runs.some((r) => r.status !== 'completed')) return 'pending'
  return runs.every((r) => RUN_OK.has(r.conclusion)) ? 'success' : 'failed'
}

const MERGE_ACTORS = new Set(['hub', 'user'])
const samePrUrlOpt = (a: string | undefined, b: string) => a !== undefined && samePrUrl(a, b)

/** 中枢不可达等无法核实的情况：以 failed(merge_unverifiable) 结束（未合并，可重试）。 */
class Unverifiable extends Error {}

export function createPrMergeExecutor(options: PrMergeOptions): ExecutorPlugin {
  const clock = options.clock ?? systemClock
  const gh = options.gh ?? createGitHubCli()
  const timeoutMs = options.pipelineTimeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS
  const pollMs = Math.min(options.pollMs ?? DEFAULT_PIPELINE_POLL_MS, 2 * 60_000)
  const discoveryMs = options.discoveryMs ?? DEFAULT_RUN_DISCOVERY_MS
  const resolveSupervisor =
    options.resolveSupervisor ??
    (async (workspace: string) => {
      const loaded = await loadWorkspaces(options.home)
      if (!loaded.ok) return loaded
      return ok(loaded.data.workspaces.find((w) => w.ref === workspace)?.supervisor)
    })
  const resolveRoles =
    options.resolveRoles ??
    (async () => {
      const loaded = await loadRoles(options.home)
      return loaded.ok ? ok(loaded.data.roles) : loaded
    })
  let hubClient: HubReader | undefined = options.hub
  const hub = async (): Promise<HubReader> => {
    if (hubClient) return hubClient
    const r = await nodeHubClientFromHome(options.home)
    if (!r.ok) throw new Unverifiable(`无法连接中枢：${r.error.message}`)
    hubClient = r.data
    return hubClient
  }
  /** 中枢返回可重试的错误（不可达等）时抛出 Unverifiable；其他错误交给调用方按核对失败处理。 */
  const hubCall = <T>(r: Result<T>, what: string): Result<T> => {
    if (!r.ok && r.error.kind === 'retryable')
      throw new Unverifiable(`${what}失败（${r.error.code}）：${r.error.message}`)
    return r
  }

  return {
    type: PR_MERGE_EXECUTOR,
    mode: 'headless',
    // 节点内执行、不启动 harness，节点属于可信计算基（D1）。
    adapterCapabilities: {
      ...NO_ADAPTER_CAPABILITIES,
      credential_isolation: { layers: { 'in-node': 'none' }, enforced: false },
    },
    taskInputs: false,
    classify: () => null,
    run(contract: TaskContract, ctx: ExecutorContext) {
      const queue = new ActivityQueue()
      const abort = new AbortController()
      const signal = AbortSignal.any([ctx.signal, abort.signal])
      const iso = () => new Date(clock.now()).toISOString()
      const status = (text: string) =>
        queue.push({ ts: iso(), kind: 'status', text: clipText(redactSecrets(text), 4000) })
      const artifacts: Artifact[] = []
      const result = (summary: string, reason?: string): TaskResult => ({
        summary: clipText(redactSecrets(summary), 16_000),
        artifacts: [...artifacts],
        verify: [],
        executor: PR_MERGE_EXECUTOR,
        node_id: ctx.nodeId,
        ...(reason ? { reason } : {}),
      })
      const failed = (reason: string, summary: string): ExecutorOutcome => {
        status(`未合并或流水线未通过（${reason}）：${summary}`)
        return { outcome: 'failed', result: result(summary, reason) }
      }
      const cancelled = (message: string, withResult = false): ExecutorOutcome => ({
        outcome: 'cancelled',
        message,
        ...(withResult ? { result: result(message) } : {}),
      })

      /** 读取 PR 快照；mergeable 为 UNKNOWN 时短暂重试。 */
      const snapshot = async (pr: PrRef): Promise<Result<PrSnapshot>> => {
        let snap = await gh.prSnapshot(pr)
        for (
          let i = 0;
          i < MERGEABLE_RETRIES && snap.ok && snap.data.mergeable === 'UNKNOWN';
          i++
        ) {
          status('GitHub 仍在计算 PR 是否可合并，稍后重读')
          await sleep(clock, MERGEABLE_RETRY_MS, signal)
          if (signal.aborted) break
          snap = await gh.prSnapshot(pr)
        }
        return snap
      }

      const main = async (): Promise<ExecutorOutcome> => {
        // ---- 1. 合同 ----
        const inputs = mergeInputs.safeParse(contract.inputs?.merge)
        if (!inputs.success)
          return failed('invalid_inputs', `合同缺少合法的 inputs.merge：${inputs.error.message}`)
        const { pr: prUrl, review_task: reviewTaskId, branch } = inputs.data
        const pr = parsePrUrl(prUrl)
        if (!pr) return failed('invalid_inputs', `PR 链接不合法：${prUrl}`)
        artifacts.push({ kind: 'pr', ref: pr.url })
        // 超时会在等待流水线时打断任务（PR 已合并却报超时）：合并前就拒绝过短的 timeout_s。
        if (contract.timeout_s < MIN_MERGER_TIMEOUT_S)
          return failed(
            'timeout_too_short',
            `merger 合同的 timeout_s=${contract.timeout_s} 小于 ${MIN_MERGER_TIMEOUT_S} 秒（40 分钟），不发起合并`,
          )

        // ---- 2. 登记仓库与 PR 归属 ----
        const repoDir = await resolveContractCwd(options.home, contract, true)
        if (!repoDir.ok) return failed(repoDir.error.code, repoDir.error.message)
        const origin = await originRepo(repoDir.data, options.git)
        if (!origin.ok) return failed(origin.error.code, origin.error.message)
        if (!sameRepo(origin.data, pr))
          return failed(
            'repo_not_in_workspace',
            `PR ${pr.url} 不属于登记仓库 ${origin.data.host}/${origin.data.owner}/${origin.data.repo}`,
          )
        const repo: RepoRef = origin.data
        const sup = await resolveSupervisor(contract.workspace)
        if (!sup.ok)
          return failed('merge_not_eligible', `无法读取 workspace 配置：${sup.error.message}`)
        if (!sup.data) return failed('merge_not_eligible', `没有 workspace ${contract.workspace}`)
        const supervisor = sup.data

        // ---- 3、4. 本任务与审查任务（D10 第 4 步，再次核对） ----
        const client = await hub()
        const self = hubCall(await client.showTask(ctx.taskId), '读取本任务')
        if (!self.ok) return failed('merge_not_eligible', `无法读取本任务：${self.error.message}`)
        const eligible = checkSelf(self.data.task, contract, reviewTaskId)
        if (eligible) return failed('merge_not_eligible', eligible)
        const reviewTask = hubCall(await client.showTask(reviewTaskId), '读取审查任务')
        if (!reviewTask.ok)
          return failed(
            'review_not_approved',
            `无法读取审查任务 ${reviewTaskId}：${reviewTask.error.message}`,
          )
        const approves = reviewApproves(
          reviewTask.data.task,
          { workspace: contract.workspace, pr: pr.url },
          supervisor,
        )
        if (!approves.ok) return failed('review_not_approved', approves.reason)
        const listed = hubCall(
          await client.listTasks({
            workspace: contract.workspace,
            status: 'done',
            limit: REVIEW_SCAN_LIMIT,
          }),
          '读取任务列表',
        )
        if (!listed.ok)
          return failed('review_not_approved', `无法核对最新审查：${listed.error.message}`)
        // 同一 PR 还有未结束的审查任务：新的结论可能推翻这次 approve，不合并。
        for (const st of UNFINISHED) {
          const pending = hubCall(
            await client.listTasks({
              workspace: contract.workspace,
              status: st,
              limit: REVIEW_SCAN_LIMIT,
            }),
            '读取任务列表',
          )
          if (!pending.ok)
            return failed('review_not_approved', `无法核对进行中的审查：${pending.error.message}`)
          const other = pending.data.tasks.find(
            (t) =>
              t.id !== reviewTaskId &&
              samePrUrlOpt(t.contract.inputs?.review?.pr, pr.url) &&
              supervisor.reviewer_roles.includes(t.contract.role),
          )
          if (other)
            return failed(
              'review_not_approved',
              `同一 PR 还有未结束的审查任务 ${other.id}（${other.status}），等它结束后再合并`,
            )
        }
        const latest = latestTrustedReview(
          [...listed.data.tasks, reviewTask.data.task],
          { workspace: contract.workspace, pr: pr.url },
          supervisor,
        )
        if (latest?.id !== reviewTaskId)
          return failed(
            'review_not_approved',
            `审查任务 ${reviewTaskId} 不是该 PR 最新一次可信审查（最新为 ${latest?.id ?? '无'}）`,
          )
        // 开出 PR 的任务启动前的仓库快照（与中枢相同的纵深核对）：worker 在沙箱外运行，可能改写登记仓库的
        // remote，只认 worker 启动前采集的 `repo_snapshot.remote_url`。
        const roles = await resolveRoles()
        if (!roles.ok)
          return failed('merge_not_eligible', `无法读取角色配置：${roles.error.message}`)
        const snapshotProblem = devSnapshotProblem(listed.data.tasks, pr, branch, repo, roles.data)
        if (snapshotProblem) return failed('repo_not_in_workspace', snapshotProblem)
        const reviewedSha = approves.reviewed_sha
        status(`审查任务 ${reviewTaskId} 结论 approve，审查的 head ${reviewedSha}`)
        if (signal.aborted) return cancelled('合并前已取消')

        // ---- 5、6. 同一时刻的 PR 状态与检查 ----
        const snap = await snapshot(pr)
        if (signal.aborted) return cancelled('合并前已取消')
        if (!snap.ok) return failed('pr_unverifiable', `读取 PR 状态失败：${snap.error.message}`)
        const v = snap.data
        if (v.number !== pr.number)
          return failed('pr_unverifiable', `gh 返回的 PR 编号 ${v.number} 与链接不符`)
        if (v.url.toLowerCase() !== pr.url.toLowerCase())
          return failed('pr_unverifiable', `gh 返回的 PR 链接 ${v.url} 与合同不符`)
        if (v.nameWithOwner.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase())
          return failed(
            'repo_not_in_workspace',
            `gh 报告的仓库 ${v.nameWithOwner} 与登记仓库 ${repo.owner}/${repo.repo} 不一致`,
          )
        if (v.isCrossRepository)
          return failed('repo_not_in_workspace', 'PR 来自 fork（head 仓库不是登记仓库），不合并')
        if (v.headRefName !== branch)
          return failed(
            'head_branch_mismatch',
            `PR 的 head 分支 ${v.headRefName} 不是开出它的任务的分支 ${branch}`,
          )
        if (v.state !== 'OPEN') return failed('pr_not_open', `PR 状态为 ${v.state}，不是 OPEN`)
        if (v.baseRefName !== v.defaultBranch)
          return failed(
            'base_not_default',
            `PR 的 base 为 ${v.baseRefName}，不是默认分支 ${v.defaultBranch}`,
          )
        if (v.mergeQueue || v.inMergeQueue)
          return failed(
            'merge_queue_unsupported',
            '目标分支启用了合并队列：pr-merge 无法在合并前确定性核对条件，不发起合并',
          )
        if (v.headRefOid !== reviewedSha)
          return failed(
            'head_moved',
            `PR 当前 head ${v.headRefOid} 与审查时的 ${reviewedSha} 不一致（审查后有新提交）`,
          )
        if (v.checksOid !== reviewedSha)
          return failed(
            'head_moved',
            `检查所属的提交 ${v.checksOid ?? '（无）'} 不是审查时的 ${reviewedSha}`,
          )
        if (v.isDraft) return failed('not_mergeable', 'PR 仍是草稿')
        // mergeStateStatus（BLOCKED、BEHIND、UNSTABLE 等）只读取、记录在活动里，不作为判定依据：
        // 合并条件由上面的确定性核对与下面的检查判定，分支保护由 GitHub 在合并时执行。
        status(`mergeStateStatus=${v.mergeStateStatus}（只记录，不判定）`)
        if (v.mergeable !== 'MERGEABLE')
          return failed('not_mergeable', `PR 当前不可合并（mergeable=${v.mergeable}）`)
        if (v.checksTruncated)
          return failed('checks_not_green', '检查项超过一次查询的上限（100），无法确认全部检查')
        const verdict = evaluateChecks(v.checks, supervisor.allow_no_checks)
        if (!verdict.ok) return failed('checks_not_green', verdict.reason)
        status(verdict.note)

        // ---- 7. 合并前再读一次 head ----
        const again = await gh.prView(pr.url)
        if (!again.ok)
          return failed('pr_unverifiable', `合并前重读 PR 失败：${again.error.message}`)
        if (again.data.isCrossRepository || again.data.headRefName !== branch)
          return failed(
            'head_branch_mismatch',
            `合并前重读：PR 的 head 为 ${again.data.headRefName}${again.data.isCrossRepository ? '（fork）' : ''}，不是任务分支 ${branch}`,
          )
        if (again.data.headRefOid !== reviewedSha)
          return failed(
            'head_moved',
            `读完检查后 PR head 变为 ${again.data.headRefOid}，不再是审查时的 ${reviewedSha}`,
          )
        if (signal.aborted) return cancelled('合并前已取消')

        // ---- 合并 ----
        const method = supervisor.merge_method
        status(`合并 ${pr.url}（${method}，要求 head 为 ${reviewedSha}）`)
        const merged = await gh.prMerge(pr.url, method, reviewedSha)
        let after: Result<GhPrMergeState> = await gh.prMergeState(pr.url)
        // 合并后立即读取可能失败或尚未反映合并：短暂重试几次再下结论。
        for (let i = 0; i < 3 && (!after.ok || (merged.ok && after.data.state !== 'MERGED')); i++) {
          await sleep(clock, 2_000)
          after = await gh.prMergeState(pr.url)
        }
        if (!after.ok)
          return failed(
            'merge_unverified',
            `已发起合并但读不回 PR 状态，PR 可能已合并，请人工确认：${after.error.message}${
              merged.ok ? '' : `（gh pr merge 报错：${merged.error.message}）`
            }`,
          )
        const state = after.data
        const mergeCommit = state.mergeCommit?.oid
        if (state.state !== 'MERGED' || !mergeCommit || !gitSha.safeParse(mergeCommit).success) {
          // 自动合并只关掉本次之前没有、本次之后出现的那一个，不动别人设置的。
          const autoNow = state.autoMergeRequest !== null && state.autoMergeRequest !== undefined
          if (state.state === 'OPEN' && autoNow && !v.autoMerge) {
            const off = await gh.prDisableAuto(pr.url)
            status(off.ok ? '已关闭本次触发的自动合并' : `关闭自动合并失败：${off.error.message}`)
          }
          const why = !merged.ok
            ? merged.error.message
            : `合并后 PR 状态为 ${state.state}，没有合并提交`
          return failed('merge_failed', `合并没有完成：${why}`)
        }
        artifacts.push({ kind: 'commit', ref: mergeCommit, note: `合并到 ${v.defaultBranch}` })
        if (state.headRefOid !== reviewedSha)
          return failed(
            'merge_unverified',
            `PR 已合并（${mergeCommit}），但合并时的 head ${state.headRefOid} 不是审查时的 ${reviewedSha}，请人工确认`,
          )
        status(
          merged.ok
            ? `已合并，合并提交 ${mergeCommit}`
            : `gh pr merge 报错但 PR 已合并（合并提交 ${mergeCommit}）：${merged.error.message}`,
        )

        // ---- 等待流水线 ----
        return waitPipeline(repo, v.defaultBranch, mergeCommit, pr.url)
      }

      const runLinks = (runs: readonly GhRun[]) => {
        for (const r of runs)
          if (!artifacts.some((a) => a.ref === r.url))
            artifacts.push({
              kind: 'url',
              ref: r.url,
              note: `${r.name}：${r.status}/${r.conclusion || '-'}`,
            })
      }

      const waitPipeline = async (
        repo: RepoRef,
        branch: string,
        sha: string,
        prLink: string,
      ): Promise<ExecutorOutcome> => {
        const start = clock.now()
        let seen = false
        let stable: string | undefined
        let lastRuns: GhRun[] = []
        let lastError: string | undefined
        for (let poll = 1; ; poll++) {
          if (signal.aborted) {
            runLinks(lastRuns)
            return cancelled(`PR 已合并（合并提交 ${sha}），取消了流水线等待`, true)
          }
          const listed = await gh.runList(repo, sha, branch)
          const elapsed = clock.now() - start
          if (listed.ok) {
            lastError = undefined
            const runs = listed.data.filter(
              (r) => r.headSha === sha && PIPELINE_EVENTS.has(r.event ?? ''),
            )
            lastRuns = runs
            if (runs.length > 0) seen = true
            const done = runs.filter((r) => r.status === 'completed').length
            // 心跳：每次轮询都上报，节点据此知道仍在进展（不会判为无进展）。
            status(
              `等待流水线（第 ${poll} 次查询，已等 ${Math.round(elapsed / 1000)} 秒）：${
                runs.length ? `${done}/${runs.length} 个 run 已结束` : '尚未发现 run'
              }`,
            )
            const verdict = runs.length > 0 ? evaluateRuns(runs) : 'pending'
            if (verdict !== 'pending') {
              // 全部结束后再查一次：确认没有新出现的 run（例如 workflow_run 触发的部署）。
              const key = runs
                .map((r) => `${r.databaseId}:${r.conclusion}`)
                .sort()
                .join(',')
              if (stable === key) {
                runLinks(runs)
                const summary = runs.map((r) => `${r.name}：${r.conclusion}（${r.url}）`).join('\n')
                if (verdict === 'success')
                  return {
                    outcome: 'done',
                    result: result(`已合并 ${prLink}（${sha}），流水线全部成功：\n${summary}`),
                  }
                const cancelledRuns = runs.filter((r) => r.conclusion === 'cancelled')
                const note = cancelledRuns.length
                  ? `\n其中 ${cancelledRuns.map((r) => r.name).join('、')} 被取消：可能是被同一并发组中更新的提交取代，请确认默认分支最新提交的流水线。`
                  : ''
                return failed(
                  'pipeline_failed',
                  `已合并 ${prLink}（${sha}），流水线失败：\n${summary}${note}`,
                )
              }
              stable = key
            } else stable = undefined
          } else {
            lastError = listed.error.message
            status(`查询 workflow runs 失败，稍后重试：${listed.error.message}`)
          }
          if (!seen && listed.ok && elapsed >= discoveryMs) {
            return {
              outcome: 'done',
              result: result(
                `已合并 ${prLink}（${sha}）；${Math.round(discoveryMs / 1000)} 秒内未发现默认分支 ${branch} 上该提交的 workflow run，未发现发布流水线`,
              ),
            }
          }
          if (elapsed >= timeoutMs) {
            runLinks(lastRuns)
            const pending = lastRuns
              .filter((r) => r.status !== 'completed')
              .map((r) => `${r.name}（${r.url}）`)
            return failed(
              'pipeline_timeout',
              `已合并 ${prLink}（${sha}），等待流水线超过 ${Math.round(timeoutMs / 60_000)} 分钟仍未结束${
                pending.length ? `：${pending.join('、')}` : ''
              }${lastError ? `；最近一次查询失败：${lastError}` : ''}`,
            )
          }
          await sleep(clock, pollMs, signal)
        }
      }

      const done = main()
        .then((o): Result<ExecutorOutcome> => ok(o))
        .catch((err): Result<ExecutorOutcome> => {
          if (err instanceof Unverifiable)
            return ok(failed('merge_unverifiable', `未合并，中枢不可达，可重试：${err.message}`))
          return fail('failure', 'pr_merge_error', String((err as Error)?.message ?? err))
        })
        .finally(() => queue.close())
      return {
        activity: queue,
        done,
        cancel: async () => {
          abort.abort()
        },
        deliver: async () => 'not_running',
      }
    },
  }
}

/**
 * 开出 PR 的任务的仓库快照核对。候选与中枢的资格核对一致：所有已 done、产出该 PR、上报的任务分支等于
 * `inputs.merge.branch`、origin 为 instruction、有效类别为 write（按当前角色配置）的任务。至少一个，且每个
 * 都带可识别的 `repo_snapshot`，指向 PR 所在仓库与当前登记仓库。返回不满足的原因。
 */
export function devSnapshotProblem(
  done: readonly TaskView[],
  pr: PrRef,
  branch: string,
  current: RepoRef,
  roles: readonly Role[],
): string | null {
  const devs = done.filter((t) => {
    if (t.status !== 'done' || t.origin !== 'instruction' || t.branch !== branch) return false
    if (!(t.result?.artifacts ?? []).some((a) => a.kind === 'pr' && samePrUrl(a.ref, pr.url)))
      return false
    const role = roles.find((r) => r.name === t.contract.role)
    return role !== undefined && taskKind(role, t.contract, { actor: t.created_by }) === 'write'
  })
  if (devs.length === 0)
    return `没有找到开出 PR ${pr.url}（任务分支 ${branch}）的已完成写类任务，无法核对它启动前的登记仓库快照`
  for (const t of devs) {
    const snap = t.repo_snapshot ? parseRemoteUrl(t.repo_snapshot.remote_url) : undefined
    if (!snap) return `开出 PR 的任务 ${t.id} 没有可识别的登记仓库快照（repo_snapshot）`
    if (!sameRepo(snap, pr) || !sameRepo(snap, current))
      return `PR 不属于开出它的任务 ${t.id} 启动前的登记仓库 ${snap.host}/${snap.owner}/${snap.repo}`
  }
  return null
}

/** 本任务的资格：由 hub 或 user 创建、origin 为 instruction、parent 为审查任务。返回不满足的原因。 */
function checkSelf(task: TaskView, contract: TaskContract, reviewTask: string): string | undefined {
  if (task.workspace !== contract.workspace) return `本任务属于 ${task.workspace}`
  if (!MERGE_ACTORS.has(task.created_by))
    return `merger 任务由 ${task.created_by} 创建，只接受 hub 或 user`
  if (task.origin !== 'instruction')
    return `merger 任务的 origin 为 ${task.origin ?? '空'}，不是 instruction`
  if (task.contract.parent !== reviewTask)
    return `merger 任务的 parent 为 ${task.contract.parent ?? '空'}，不是审查任务 ${reviewTask}`
  const own = task.contract.inputs?.merge
  if (
    own?.pr !== contract.inputs?.merge?.pr ||
    own?.review_task !== reviewTask ||
    own?.branch !== contract.inputs?.merge?.branch
  )
    return '中枢记录的 inputs.merge 与本次执行的合同不一致'
  return undefined
}
