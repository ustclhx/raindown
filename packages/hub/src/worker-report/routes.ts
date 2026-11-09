import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  ENDPOINTS,
  fail,
  isAllowedHumanPrEvent,
  ok,
  parseRemoteUrl,
  prRepoOf,
  type Result,
  samePrUrl,
  sameRepo,
  type TaskView,
  type WorkerReport,
  workerReportData,
  workerReportRequest,
} from '@raindown/core'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { respond } from '../ledger/routes.ts'
import type { LedgerStore } from '../ledger/store.ts'
import { readLimitedJson } from '../server/body.ts'

const execFileAsync = promisify(execFile)
const githubPr =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/

const checkedPr = z.object({
  url: z.string().url(),
  headRefName: z.string().min(1),
  headRepository: z.object({ nameWithOwner: z.string().min(1) }),
  isCrossRepository: z.boolean(),
})
type RunGh = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>

/** 只查询任务仓库的 PR，所有核对失败都隐藏 gh 的诊断与仓库信息。 */
export async function verifyReportDeliverable(
  ref: string,
  task: Pick<TaskView, 'branch' | 'repo_snapshot'>,
  run: RunGh = execFileAsync,
): Promise<Result<null>> {
  const rejected = () => fail('failure', 'deliverable_check_failed', '无法核实本任务的交付物')
  const repo = task.repo_snapshot ? parseRemoteUrl(task.repo_snapshot.remote_url) : undefined
  const requested = githubPr.test(ref) ? prRepoOf(ref.replace(/\/$/, '')) : undefined
  if (!task.branch || !repo || !requested || !sameRepo(repo, requested)) return rejected()
  try {
    const { stdout } = await run(
      'gh',
      ['pr', 'view', ref, '--json', 'url,headRefName,headRepository,isCrossRepository'],
      { timeout: 15_000, maxBuffer: 64 * 1024 },
    )
    const parsed = checkedPr.safeParse(JSON.parse(stdout))
    if (!parsed.success) return rejected()
    const pr = parsed.data
    const head = parseRemoteUrl(`https://github.com/${pr.headRepository.nameWithOwner}`)
    if (
      !samePrUrl(pr.url, ref.replace(/\/$/, '')) ||
      pr.isCrossRepository ||
      !head ||
      !sameRepo(repo, head)
    )
      return rejected()
    // 其余核对都通过、只有分支不一致：单独给出错误码与处理办法，避免 worker 反复提交 ready。
    if (pr.headRefName !== task.branch)
      return fail(
        'failure',
        'deliverable_branch_mismatch',
        `PR 不是从本任务登记的分支 ${task.branch} 开出；登记分支不可更改。请在该分支上提交并开 PR，否则改用 blocked 说明情况，不要反复提交 ready`,
      )
    return ok(null)
  } catch {
    return rejected()
  }
}

const REPORT_BODY_MAX = 32 * 1024
const REPORT_WINDOW_MS = 60_000
const REPORT_WINDOW_MAX = 10
const REPORT_ATTEMPT_MAX = 200

/** 不依赖 Content-Length；逐块限制实际字节数，在 JSON 解析前限制内存。 */
const reportBody = (c: Context): Promise<Result<unknown>> =>
  readLimitedJson(c, REPORT_BODY_MAX, '上报请求体不合法或超过 32 KiB')

export interface WorkerReportRoutesDeps {
  ledger: LedgerStore
  verifyDeliverable?: (ref: string, task: TaskView) => Promise<Result<null>>
  now?: () => number
}

/** 这里只记录 worker 的事实；状态转换由节点消费上报后通过续约/完成协议提交。 */
export function createWorkerReportRoutes({
  ledger,
  verifyDeliverable = verifyReportDeliverable,
  now = Date.now,
}: WorkerReportRoutesDeps): Hono {
  const app = new Hono()
  const inFlight = new Set<string>()
  // 成功报告从账本恢复限额；失败请求也消耗额度，但这部分只保留到中枢重启。
  const failures = new Map<string, { total: number; times: number[] }>()
  app.post(ENDPOINTS['tasks-report'].path, async (c) => {
    const auth = c.get('auth')
    if (auth?.kind !== 'task' || auth.task.task_id !== c.req.param('id'))
      return respond(
        c,
        fail('failure', 'forbidden', '只能由当前派工令牌为本任务上报'),
        workerReportData,
      )
    const caller = auth.task
    const current = () => {
      const task = ledger.getTask(caller.task_id)
      const lease = ledger.getLease(caller.lease_id)
      return task?.status === 'running' &&
        task.attempt === caller.attempt &&
        task.workspace === caller.workspace &&
        lease?.state === 'active' &&
        lease.task_id === caller.task_id &&
        lease.attempt === caller.attempt &&
        ledger.activeLease(caller.task_id)?.lease_id === caller.lease_id &&
        !ledger.attemptEnded(caller.task_id, caller.attempt)
        ? task
        : null
    }
    const task = current()
    if (!task)
      return respond(
        c,
        fail('failure', 'not_running', '任务当前没有运行中的有效派工'),
        workerReportData,
      )
    // 清理已经结束的租约；无需读取该任务的事件历史。
    for (const leaseId of failures.keys()) {
      if (ledger.getLease(leaseId)?.state !== 'active') failures.delete(leaseId)
    }
    if (inFlight.has(caller.lease_id))
      return respond(
        c,
        fail('retryable', 'report_busy', '当前派工正在处理上报，请稍后重试'),
        workerReportData,
      )
    const admittedAt = now()
    const since = admittedAt - REPORT_WINDOW_MS
    const failed = failures.get(caller.lease_id) ?? { total: 0, times: [] }
    failed.times = failed.times.filter((time) => time >= since)
    const usage = ledger.workerReportUsage(
      caller.task_id,
      caller.lease_id,
      caller.attempt,
      new Date(since).toISOString(),
    )
    if (
      usage.total + failed.total >= REPORT_ATTEMPT_MAX ||
      usage.recent + failed.times.length >= REPORT_WINDOW_MAX
    )
      return respond(
        c,
        fail('retryable', 'report_rate_limited', '当前派工上报已达限额'),
        workerReportData,
      )
    failures.set(caller.lease_id, failed)
    failed.total++
    failed.times.push(admittedAt)
    inFlight.add(caller.lease_id)
    try {
      const body = await reportBody(c)
      if (!body.ok) return respond(c, body, workerReportData)
      const parsed = workerReportRequest.safeParse(body.data)
      if (!parsed.success)
        return respond(
          c,
          fail(
            'usage',
            'invalid_arguments',
            '上报字段不合法',
            parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
          ),
          workerReportData,
        )
      const report: WorkerReport = parsed.data
      if (report.status === 'ready') {
        if (!task.branch)
          return respond(
            c,
            fail(
              'failure',
              'branch_unknown',
              '尚未登记本任务分支；请先上报 blocked，说明缺少的分支信息与已尝试的办法',
            ),
            workerReportData,
          )
        for (const ref of report.deliverables ?? []) {
          const checked = await verifyDeliverable(ref, task)
          if (!checked.ok) return respond(c, checked, workerReportData)
        }
      }
      // 外部核对期间派工可能结束，写入前重新核对；后续同步写入不会与其他请求交错。
      if (!current())
        return respond(
          c,
          fail('failure', 'not_running', '核对交付物时派工已结束'),
          workerReportData,
        )
      // 交回（harness-neutral 8.6）：只能交回本任务收到过的、名单内用户的人类评论；
      // 交回等同用户指令，进入 supervisor 的 instruction 唤醒队列并附 worker 的理由。
      const handback = report.handback
      if (handback) {
        const event = ledger.prEvent(handback.pr_event_seq)
        if (
          !event ||
          event.workspace !== task.workspace ||
          !ledger.taskHasPrInput(task.id, event.seq) ||
          !isAllowedHumanPrEvent(event.payload)
        )
          return respond(
            c,
            fail(
              'failure',
              'handback_invalid',
              '只能交回本任务收到过的、允许名单内用户的 PR 评论；机器人、CI 与名单外用户的内容不能交回',
            ),
            workerReportData,
          )
      }
      const handedBack =
        handback && !ledger.prWakeRequested(handback.pr_event_seq, 'handback', task.id)
      const written = ledger.appendMany(
        [
          {
            task_id: task.id,
            workspace: task.workspace,
            type: 'task.reported',
            payload: { ...report, attempt: caller.attempt, lease_id: caller.lease_id },
          },
          ...(handback && handedBack
            ? [
                {
                  type: 'pr.wake_requested' as const,
                  task_id: task.id,
                  workspace: task.workspace,
                  payload: {
                    pr_event_seq: handback.pr_event_seq,
                    reason: 'handback' as const,
                    note: handback.reason,
                  },
                },
              ]
            : []),
        ],
        { actor: caller.actor, actors: handedBack ? [caller.actor, 'hub'] : [caller.actor] },
      )
      if (written.ok) {
        failed.total--
        failed.times.splice(failed.times.indexOf(admittedAt), 1)
      }
      return respond(
        c,
        written.ok
          ? ok({ seq: (written.data[0] as { seq: number }).seq, attempt: caller.attempt })
          : written,
        workerReportData,
      )
    } finally {
      inFlight.delete(caller.lease_id)
    }
  })
  return app
}
