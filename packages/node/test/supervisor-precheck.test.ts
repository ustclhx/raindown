import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NO_ADAPTER_CAPABILITIES, ok, type Result, type TaskView } from '@raindown/core'
import {
  ActivityQueue,
  type DeliverResult,
  type ExecutorOutcome,
  type ExecutorPlugin,
  idleSignal,
  type PrecheckRequest,
  type PrecheckVerdict,
} from '../src/index.ts'
import { type GitFixture, gitFixture, TASK_BRANCH } from './git-fixture.ts'
import { type Bench, bench, type Intercept } from './harness.ts'

/**
 * ④ G9（tasks 5.6）节点侧的代回复支撑，真实中枢路由 + 节点循环 + 本地临时 git 仓库：
 * - codex-orca 开始时上报任务分支与 worktree；
 * - 开始时快照登记仓库（origin 地址、默认分支），随任务分支上报；
 * - 执行目录可信的 precheck 上报 command_cwd、push_env_ok 与租约令牌，`supervisor` 档位不放行；
 *   执行目录不可信（codex-orca、claude-sdk 的现状）时不上报环境字段，push_to 不满足；
 * - 卡住带 decision_id、请求文本与 diff_stat；
 * - supervisor 的批准送达前复核请求与推送环境，不一致时 ack 拒收并以 no_delegate 重新卡住。
 * 执行器是测试里的脚本执行器（类型 codex-orca，不启动 Orca 或 Codex）；gh 是假的，不联网。
 */

// 每个测试都会启动若干 git 子进程（真实 I/O）。
setDefaultTimeout(30_000)

let b: Bench | undefined
let g: GitFixture | undefined
afterEach(async () => {
  await b?.close()
  b = undefined
  g?.cleanup()
  g = undefined
})

const PUSH = `git push -u origin ${TASK_BRANCH}`

interface Script {
  /** 是否在开始时上报任务分支。 */
  branch: boolean
  command: string
  /** 送达时执行器"重新读到"的待批请求；缺省与预检时相同。 */
  live?: PrecheckRequest | undefined
  /** 伪造 hint 中的 decision_id（不是本租约的预检给出的）。 */
  forgedDecision?: number
  /** 像 codex-orca 一样不声明执行目录可信。 */
  untrusted?: boolean
  /** 预检两次，却在 hint 里报告第一次（较旧）的判定。 */
  staleDecision?: boolean
  /** 像 native 下的 codex-orca 一样：请求批准即脱离隔离（预检带 escapesIsolation，hint 带 isolation_escape）。 */
  isolationEscape?: boolean
  verdicts: PrecheckVerdict[]
  delivered: Array<{ reply_id: string; by: string; kind: string }>
  dropped: string[]
  /** 测试确认分支已入账后放行预检。 */
  go(): void
}

function scriptedExecutor(s: Omit<Script, 'verdicts' | 'delivered' | 'dropped' | 'go'>) {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const script: Script = { ...s, verdicts: [], delivered: [], dropped: [], go: () => release() }
  const plugin: ExecutorPlugin = {
    type: 'codex-orca',
    mode: 'interactive',
    adapterCapabilities: NO_ADAPTER_CAPABILITIES,
    classify: (snap) => ({
      reason: 'awaiting_approval',
      message: typeof snap.hint?.message === 'string' ? snap.hint.message : '等待授权',
    }),
    run(_contract, ctx) {
      const queue = new ActivityQueue()
      let settle: (r: Result<ExecutorOutcome>) => void = () => {}
      const done = new Promise<Result<ExecutorOutcome>>((r) => {
        settle = r
      })
      const worktree = (g as GitFixture).worktree
      const req: PrecheckRequest = {
        tool: 'CodexCommand',
        command: script.command,
        cwd: worktree,
        ...(script.untrusted ? {} : { workdirTrusted: true }),
        ...(script.isolationEscape ? { escapesIsolation: true } : {}),
      }
      const message = `等待授权：${script.command}`
      let waiting = false
      const idle = (decisionId?: number) =>
        queue.push(
          idleSignal(new Date().toISOString(), message, {
            message,
            ...(decisionId === undefined ? {} : { decision_id: decisionId }),
            ...(script.isolationEscape ? { isolation_escape: true } : {}),
          }),
        )
      void (async () => {
        if (script.branch) {
          ctx.reportBranch?.({ branch: TASK_BRANCH, worktree, repo: (g as GitFixture).repo })
        }
        await gate
        const verdict = (await ctx.precheck?.(req)) ?? { allow: false }
        script.verdicts.push(verdict)
        if (script.staleDecision)
          script.verdicts.push((await ctx.precheck?.(req)) ?? { allow: false })
        waiting = true
        idle(script.forgedDecision ?? (verdict.allow ? undefined : verdict.decision_id))
      })()
      ctx.signal.addEventListener('abort', () => {
        queue.close()
        settle(ok({ outcome: 'cancelled', message: '已取消' }))
      })
      return {
        activity: queue,
        done,
        cancel: async () => {
          queue.close()
          settle(ok({ outcome: 'cancelled', message: '已取消' }))
        },
        async deliver(reply): Promise<DeliverResult> {
          const live = 'live' in script ? script.live : req
          if (waiting && reply.kind === 'approve' && ctx.confirmApproval) {
            if (!(await ctx.confirmApproval(reply, live))) {
              script.dropped.push(reply.reply_id)
              // 不放行；稍后重新报告停下（节点确认拒收后才会接受新的停下信号，之前的会被忽略）。
              let left = 100
              const again = () => {
                if (!waiting || left-- <= 0) return
                idle()
                setTimeout(again, 50)
              }
              setTimeout(again, 20)
              return 'dropped'
            }
          }
          waiting = false
          script.delivered.push({ reply_id: reply.reply_id, by: reply.by, kind: reply.kind })
          return 'delivered'
        },
      }
    },
  }
  return { plugin, script }
}

async function setup(
  s: Omit<Script, 'verdicts' | 'delivered' | 'dropped' | 'go'>,
  policies: unknown[] = [
    { scope: 'ws/demo', action: 'git.push', level: 'supervisor', when: { push_to: 'task_branch' } },
  ],
  intercept?: Intercept,
) {
  g = gitFixture()
  const { plugin, script } = scriptedExecutor(s)
  b = await bench(
    {
      policies,
      executors: [plugin],
      envRunner: g.run,
      envVars: g.env,
      precheckTimeoutMs: 3_600_000,
    },
    60,
    intercept,
  )
  mkdirSync(join(b.home, 'config', 'workspaces'), { recursive: true })
  writeFileSync(
    join(b.home, 'config', 'workspaces', 'demo.yaml'),
    `id: demo\nkind: product\nname: 演示\ndescription: 测试\nrepos: [${JSON.stringify(g.repo)}]\n`,
  )
  const id = await b.create({ executor: 'codex-orca', cwd: g.repo })
  return { bench: b, git: g, script, id }
}

/** 真实 I/O（git 子进程）与虚拟时钟交错：小步拨动时钟并让出真实时间，直到条件成立。 */
async function settle(bb: Bench, pred: () => boolean, what: string, ms = 8000) {
  const end = performance.now() + ms
  while (!pred()) {
    if (performance.now() > end) throw new Error(`等待超时：${what}`)
    await bb.clock.advance(50)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const decisions = (bb: Bench, id: string) =>
  bb.events(id).filter((e) => e.type === 'policy.decided')

function supervisorApprove(bb: Bench, t: TaskView, replyId: string) {
  // supervisor 的回复只能落在有效的委托上（D15，store 校验）：中枢的委托判定不在本测试范围内，直接写入。
  if (!bb.ledger.activeDelegation(t.id)) {
    const blocked = bb
      .events(t.id)
      .filter((e) => e.type === 'task.blocked')
      .at(-1)
    const p = blocked?.type === 'task.blocked' ? blocked.payload : undefined
    const d = bb.ledger.append(
      {
        task_id: t.id,
        workspace: t.workspace,
        type: 'task.reply_delegated',
        payload: {
          task_id: t.id,
          block_seq: blocked?.seq ?? 0,
          kind: 'awaiting_approval',
          ...(p?.decision_id === undefined ? {} : { decision_id: p.decision_id }),
          deadline: '2099-01-01T00:00:00.000Z',
        },
      },
      { actor: 'hub' },
    )
    if (!d.ok) throw new Error(d.error.message)
  }
  const r = bb.ledger.append(
    {
      task_id: t.id,
      workspace: t.workspace,
      type: 'task.replied',
      payload: { reply_id: replyId, kind: 'approve', via: 'supervisor' },
    },
    { actor: 'supervisor' },
  )
  if (!r.ok) throw new Error(r.error.message)
}

async function blockedWithDecision(s: Omit<Script, 'verdicts' | 'delivered' | 'dropped' | 'go'>) {
  const ctx = await setup(s)
  const { bench: bb, id, script, git } = ctx
  await settle(bb, () => bb.task(id).branch !== null, '任务分支入账')
  expect(bb.task(id)).toMatchObject({ branch: TASK_BRANCH, worktree: git.worktree })
  script.go()
  await settle(bb, () => bb.task(id).status === 'blocked', '卡住')
  return ctx
}

describe('precheck 与卡住上报', () => {
  test('push_to 满足：判为 supervisor，不放行；blocked 带 decision_id、请求文本与 diff_stat', async () => {
    const {
      bench: bb,
      id,
      script,
      git,
    } = await blockedWithDecision({ branch: true, command: PUSH })
    expect(script.verdicts).toHaveLength(1)
    expect(script.verdicts[0]).toMatchObject({ allow: false, level: 'supervisor' })
    const [decided] = decisions(bb, id)
    expect(decided?.payload).toMatchObject({
      level: 'supervisor',
      request: {
        tool: 'CodexCommand',
        command: PUSH,
        push_env_ok: true,
        command_cwd: git.worktree,
      },
    })
    expect(decided?.payload).not.toHaveProperty('request.default_branch')
    // 快照随分支固定在投影里：默认分支只取这里的值。
    expect(bb.task(id).repo_snapshot).toEqual({
      remote_url: 'https://github.com/acme/demo.git',
      default_branch: 'main',
    })
    expect(bb.task(id).blocked).toMatchObject({
      reason: 'awaiting_approval',
      lease_held: true,
      decision_id: decided?.seq,
      request: { tool: 'CodexCommand', command: PUSH },
      diff_stat: '（相对任务基点没有改动）',
    })
    expect(bb.task(id).blocked).not.toHaveProperty('no_delegate')
    // 任务分支只上报一次。
    expect(bb.types(id).filter((t) => t === 'task.branch_reported')).toHaveLength(1)
  })

  test('批准即脱离隔离（native，design D4/D5）：不送中枢判定、不委托 supervisor，以 no_delegate 卡住', async () => {
    const {
      bench: bb,
      id,
      script,
    } = await blockedWithDecision({ branch: true, command: PUSH, isolationEscape: true })
    expect(script.verdicts).toEqual([{ allow: false, level: 'user', escapes_isolation: true }])
    expect(decisions(bb, id)).toEqual([])
    expect(bb.task(id).blocked).toMatchObject({ reason: 'awaiting_approval', no_delegate: true })
    expect(bb.task(id).blocked).not.toHaveProperty('decision_id')
  })

  test('执行目录不可信（codex-orca 现状）：不上报环境字段，push_to 不满足，交给用户', async () => {
    const {
      bench: bb,
      id,
      script,
    } = await blockedWithDecision({
      branch: true,
      command: PUSH,
      untrusted: true,
    })
    expect(script.verdicts[0]).toMatchObject({ allow: false, level: 'user' })
    const request =
      (decisions(bb, id)[0]?.payload as { request?: object } | undefined)?.request ?? {}
    expect(request).not.toHaveProperty('push_env_ok')
    expect(request).not.toHaveProperty('command_cwd')
    expect(bb.task(id).blocked).not.toHaveProperty('decision_id')
  })

  test('hint 里的 decision_id 不是最近一次预检的：不上报', async () => {
    const {
      bench: bb,
      id,
      script,
    } = await blockedWithDecision({
      branch: true,
      command: PUSH,
      staleDecision: true,
    })
    expect(script.verdicts).toHaveLength(2)
    expect(script.verdicts[1]).toMatchObject({ allow: false, level: 'supervisor' })
    expect(bb.task(id).blocked).not.toHaveProperty('decision_id')
  })

  test('旧版中枢不接受 branch 字段：节点不再上报分支，任务照常运行（push_to 不满足）', async () => {
    let rejected = 0
    const {
      bench: bb,
      id,
      script,
    } = await setup({ branch: true, command: PUSH }, undefined, (url, init) => {
      if (url.includes('/renew') && String(init?.body ?? '').includes('"branch"')) {
        rejected++
        return new Response(
          JSON.stringify({
            ok: false,
            error: {
              kind: 'usage',
              code: 'invalid_arguments',
              message: '续约请求不合法',
              retryable: false,
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return undefined
    })
    await settle(bb, () => rejected > 0, '分支上报被拒绝')
    script.go()
    await settle(bb, () => bb.task(id).status === 'blocked', '卡住')
    expect(rejected).toBe(1)
    expect(bb.task(id).branch).toBeNull()
    expect(script.verdicts[0]).toMatchObject({ allow: false, level: 'user' })
  })

  test('没有上报任务分支：push_to 不满足，交给用户，blocked 不带 decision_id', async () => {
    const { bench: bb, id, script } = await setup({ branch: false, command: PUSH })
    script.go()
    await settle(bb, () => bb.task(id).status === 'blocked', '卡住')
    expect(script.verdicts[0]).toMatchObject({ allow: false, level: 'user' })
    expect(bb.task(id).blocked).not.toHaveProperty('decision_id')
  })

  test('推送环境不通过（core.sshCommand）：push_env_ok=false，交给用户', async () => {
    const ctx = await setup({ branch: true, command: PUSH })
    ctx.git.git(['config', 'core.sshCommand', 'sh -c evil'])
    await settle(ctx.bench, () => ctx.bench.task(ctx.id).branch !== null, '任务分支入账')
    ctx.script.go()
    await settle(ctx.bench, () => ctx.bench.task(ctx.id).status === 'blocked', '卡住')
    expect(ctx.script.verdicts[0]).toMatchObject({ allow: false, level: 'user' })
    expect(decisions(ctx.bench, ctx.id)[0]?.payload).toMatchObject({
      request: { push_env_ok: false },
    })
  })

  test('执行器伪造的 decision_id（不是本租约预检给出的）：不上报', async () => {
    const { bench: bb, id } = await blockedWithDecision({
      branch: true,
      command: PUSH,
      forgedDecision: 1,
    })
    expect(bb.task(id).blocked).not.toHaveProperty('decision_id')
    expect(bb.task(id).blocked).not.toHaveProperty('request')
  })
})

describe('supervisor 的批准送达前复核', () => {
  test('等待期间 gitfile 被改写：复核时重新校验 gitdir，拒收', async () => {
    const {
      bench: bb,
      id,
      script,
      git,
    } = await blockedWithDecision({
      branch: true,
      command: PUSH,
    })
    writeFileSync(join(git.worktree, '.git'), 'gitdir: ./.evil\n')
    supervisorApprove(bb, bb.task(id), 'r-sup-gitfile')
    await settle(bb, () => script.dropped.length === 1, '拒收')
    expect(script.delivered).toHaveLength(0)
  })

  test('请求与环境都没变：放行（delivered）', async () => {
    const { bench: bb, id, script } = await blockedWithDecision({ branch: true, command: PUSH })
    supervisorApprove(bb, bb.task(id), 'r-sup-1')
    await settle(bb, () => script.delivered.length === 1, '送达')
    expect(script.delivered[0]).toEqual({ reply_id: 'r-sup-1', by: 'supervisor', kind: 'approve' })
    await settle(bb, () => bb.task(id).status === 'running', '恢复运行')
    expect(bb.ledger.getReply('r-sup-1')).toMatchObject({ state: 'delivered' })
  })

  test('等待期间推送环境变了：ack 拒收，回复 dropped，以 no_delegate 重新卡住', async () => {
    const {
      bench: bb,
      id,
      script,
      git,
    } = await blockedWithDecision({
      branch: true,
      command: PUSH,
    })
    const firstBlock = bb.task(id).blocked
    git.git(['config', 'url.https://evil.example/.pushInsteadOf', 'https://github.com/'])
    supervisorApprove(bb, bb.task(id), 'r-sup-2')
    await settle(bb, () => script.dropped.length === 1, '拒收')
    expect(script.delivered).toHaveLength(0)
    await settle(
      bb,
      () => bb.task(id).status === 'blocked' && bb.task(id).blocked?.no_delegate === true,
      '以 no_delegate 重新卡住',
    )
    expect(bb.ledger.getReply('r-sup-2')).toMatchObject({ state: 'dropped' })
    const types = bb.types(id)
    expect(types.slice(types.lastIndexOf('task.replied'))).toEqual([
      'task.replied',
      'task.reply_fetched',
      'task.unblocked',
      'task.blocked',
    ])
    const unblocked = bb.events(id).find((e) => e.type === 'task.unblocked')
    expect(unblocked?.payload).toMatchObject({ dropped_reply_ids: ['r-sup-2'] })
    expect(bb.task(id).blocked).not.toHaveProperty('decision_id')
    expect(firstBlock?.decision_id).toBeDefined()
  })

  test('等待期间待批请求变成了另一条命令：拒收', async () => {
    const {
      bench: bb,
      id,
      script,
      git,
    } = await blockedWithDecision({
      branch: true,
      command: PUSH,
    })
    script.live = {
      tool: 'CodexCommand',
      command: 'git push origin main',
      cwd: git.worktree,
      workdirTrusted: true,
    }
    supervisorApprove(bb, bb.task(id), 'r-sup-3')
    await settle(bb, () => script.dropped.length === 1, '拒收')
    await settle(bb, () => bb.task(id).blocked?.no_delegate === true, '重新卡住')
  })

  test('待批请求已不在（读不到弹窗）：拒收', async () => {
    const { bench: bb, id, script } = await blockedWithDecision({ branch: true, command: PUSH })
    script.live = undefined
    supervisorApprove(bb, bb.task(id), 'r-sup-4')
    await settle(bb, () => script.dropped.length === 1, '拒收')
  })

  test('用户的批准不复核：环境变了也照常送达', async () => {
    const {
      bench: bb,
      id,
      script,
      git,
    } = await blockedWithDecision({
      branch: true,
      command: PUSH,
    })
    git.git(['config', 'core.sshCommand', 'evil'])
    const r = await bb.api<{ ok: boolean }>('POST', `/v1/tasks/${id}/reply`, { kind: 'approve' })
    expect(r.ok).toBe(true)
    await settle(bb, () => script.delivered.length === 1, '送达')
    expect(script.delivered[0]?.by).toBe('user')
    expect(script.dropped).toHaveLength(0)
  })
})
