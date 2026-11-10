import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type Activity,
  type DeliveredInput,
  fail,
  NO_ADAPTER_CAPABILITIES,
  ok,
  type Result,
  renderRecoveryPrompt,
  renderTaskInputs,
  type TaskRecovery,
  type TaskResume,
  taskContract,
} from '@raindown/core'
import { analyzeTail, approvalForPrecheck } from '../src/codex-orca/classify.ts'
import { createCodexOrcaExecutor } from '../src/codex-orca/executor.ts'
import {
  ActivityQueue,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRun,
  mdsBaselineHeld,
  mdsBaselinePath,
  recordMdsBaseline,
  type SeatbeltOptions,
  writeLeaseTokenFile,
} from '../src/index.ts'
import {
  FakeGh,
  FakeOrca,
  type OrcaHome,
  orcaHome,
  sendFixture,
  staleHandle,
  tuiFixture,
} from './codex-orca-helpers.ts'
import { bench, ManualClock } from './harness.ts'
import { initTestRepo } from './sealed-helpers.ts'
import { waitFor as until } from './wait.ts'

/**
 * codex-orca 执行器的监控循环、deliver 与 cancel（add-m1-executors 2.3；executor-codex-orca spec）。
 * Orca 与 gh 都是内存中的假实现，终端内容来自真实片段 fixture；时钟是手动拨动的虚拟时钟。
 */

const POLL = 30_000
let h: OrcaHome | undefined
afterEach(() => {
  if (h) rmSync(h.root, { recursive: true, force: true })
  h = undefined
})

const realWait = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Started {
  run: ExecutorRun
  orca: FakeOrca
  gh: FakeGh
  clock: ManualClock
  activity: Activity[]
  abort: AbortController
  outcome: () => Result<ExecutorOutcome> | undefined
  /** 拨动一次轮询间隔。 */
  poll(n?: number): Promise<void>
}

async function start(
  over: Record<string, unknown> = {},
  prepare?: (o: FakeOrca) => void,
  extra: {
    home?: OrcaHome
    resume?: TaskResume
    recovery?: TaskRecovery
    inputs?: DeliveredInput[]
    leaseTokenFile?: string
    reportResumeReplyDropped?: (options?: { attempted?: boolean }) => void
    directoryStat?: (path: string) => { isDirectory(): boolean }
    isolation?: SeatbeltOptions
    hubUrl?: string
  } = {},
) {
  h = extra.home ?? orcaHome()
  const clock = new ManualClock()
  const orca = new FakeOrca(h.worktree)
  const gh = new FakeGh()
  prepare?.(orca)
  const plugin = createCodexOrcaExecutor({
    home: h.home,
    codexAuthSource: join(h.root, 'user-codex'),
    clock,
    orca,
    gh,
    baseBranch: async () => 'origin/main',
    waitForSetup: async () => ok(undefined),
    ...(extra.directoryStat ? { directoryStat: extra.directoryStat } : {}),
    ...(extra.isolation ? { isolation: extra.isolation } : {}),
  })
  const contract = taskContract.parse({
    goal: '修正 README',
    workspace: 'ws/product-res',
    role: 'dev',
    executor: 'codex-orca',
    context: ['projects/product-res'],
    inputs: { repo: h.repo },
    ...over,
  })
  const abort = new AbortController()
  const run = plugin.run(contract, {
    taskId: 't-orca-1',
    attempt: extra.home ? 2 : 1,
    cwd: h.home,
    nodeId: 'n-test',
    signal: abort.signal,
    ...(extra.resume ? { resume: extra.resume } : {}),
    ...(extra.recovery ? { recovery: extra.recovery } : {}),
    ...(extra.inputs ? { inputs: extra.inputs } : {}),
    ...(extra.leaseTokenFile ? { leaseTokenFile: extra.leaseTokenFile } : {}),
    ...(extra.hubUrl ? { hubUrl: extra.hubUrl } : {}),
    ...(extra.reportResumeReplyDropped
      ? { reportResumeReplyDropped: extra.reportResumeReplyDropped }
      : {}),
  })
  const activity: Activity[] = []
  // 直接运行执行器的测试模拟中枢 blocked 回执，以及每条回复固定的来源 seq。
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
  const s: Started = {
    run,
    orca,
    gh,
    clock,
    activity,
    abort,
    outcome: () => outcome,
    async poll(n = 1) {
      for (let i = 0; i < n; i++) {
        // 创建终端、接管 handle 都可能还在异步落盘；等监控真正开始等待后再拨钟。
        await until(() => clock.pendingTimers() > 0 || outcome !== undefined, '轮询定时器')
        const before = orca.ops('terminalRead').length
        await clock.advance(POLL)
        await until(
          () => orca.ops('terminalRead').length > before || outcome !== undefined,
          '终端读取',
        )
        // terminalRead 只表示本轮开始；下一次 sleep 或结束才表示本轮处理完毕。
        await until(() => clock.pendingTimers() > 0 || outcome !== undefined, '本轮监控结束')
      }
    },
  }
  return s
}

const ready = (s: Started) =>
  until(() => s.clock.pendingTimers() > 0 || s.outcome() !== undefined, '启动 Codex 并落盘')
const idles = (s: Started) => s.activity.filter((a) => a.data?.idle === true)
const sends = (s: Started) => s.orca.ops('terminalSend').map((c) => c.input)

describe('启动', () => {
  test.each([undefined, '/private/old-lease.token', '/private/current-lease.token'])(
    '重挂接核对派工 MCP 绑定，旧路径 %s 不可沿用',
    async (previous) => {
      const first = await start(
        {},
        (o) => o.show('question'),
        previous ? { leaseTokenFile: previous } : {},
      )
      await ready(first)
      const home = h
      if (!home) throw new Error('no home')
      const current = '/private/current-lease.token'
      const second = await start({}, (o) => o.show('question'), { home, leaseTokenFile: current })
      await ready(second)
      expect(second.orca.ops('worktreeCreate')).toHaveLength(0)
      if (previous === current) {
        expect(second.orca.ops('terminalClose')).toHaveLength(0)
        expect(second.orca.ops('terminalCreate')).toHaveLength(0)
      } else {
        expect(second.orca.ops('terminalClose')).toHaveLength(1)
        expect(second.orca.ops('terminalCreate')).toHaveLength(1)
        const created = second.orca.ops('terminalCreate')[0]?.input as
          | { command: string }
          | undefined
        expect(created?.command).toContain(`RAINDOWN_LEASE_TOKEN_FILE=${current}`)
        expect(created?.command).toContain('mcp_servers.raindown=')
        // 进程环境带凭证路径：shell 环境排除项固定在角色配置之后（模型命令看不到它）。
        expect(created?.command).toContain('shell_environment_policy.ignore_default_excludes=false')
        expect(created?.command).toContain('RAINDOWN_LEASE_TOKEN_FILE"]')
      }
      const state = JSON.parse(
        readFileSync(join(home.home, 'state/tasks/t-orca-1/orca.json'), 'utf8'),
      )
      expect(state.lease_token_file).toBe(current)
      await first.run.cancel()
      await second.run.cancel()
    },
  )

  test('重挂接直接送达恢复提示，普通输入框出现前不向授权弹窗输入文字', async () => {
    const first = await start({}, (o) => o.show('question'))
    await ready(first)
    const home = h
    if (!home) throw new Error('no home')
    const recovery: TaskRecovery = { previous_end: { attempt: 1, reason: 'node_lost' }, prs: [] }
    const second = await start({}, (o) => o.show('approval'), { home, recovery })
    await ready(second)
    expect(sends(second)).toEqual([])
    second.orca.reads.splice(0)
    second.orca.show('question')
    await second.poll()
    const recoveryInput = renderRecoveryPrompt(recovery).replace(/\n/g, ' ')
    expect(sends(second)).toEqual([
      { handle: second.orca.handle, text: recoveryInput, enter: true, waitSubmitS: 10 },
    ])
    second.orca.reads.splice(0)
    // 旧 Orca 只返回 accepted、没有 prompt 元数据；下一次仍空闲也不能重复发送。
    second.orca.show('question')
    await second.poll()
    expect(sends(second)).toHaveLength(1)
    expect(second.orca.ops('terminalCreate')).toEqual([])
    expect(readFileSync(join(home.home, 'state/tasks/t-orca-1/spec.md'), 'utf8')).toStartWith(
      renderRecoveryPrompt(recovery),
    )
    await second.run.cancel()
    await first.run.cancel()
  })

  test('恢复提示补回车失败时不记送达，下一轮用原 request id 重验', async () => {
    const first = await start({}, (o) => o.show('question'))
    await ready(first)
    const home = h
    if (!home) throw new Error('no home')
    const recovery: TaskRecovery = { previous_end: { attempt: 1, reason: 'retry' }, prs: [] }
    const noTurn = ok(sendFixture('terminal-send-no-turn'))
    const second = await start(
      {},
      (o) => {
        o.show('question')
        o.sends.push(noTurn, noTurn, noTurn, fail('failure', 'orca_error', '发送失败'))
      },
      { home, recovery },
    )
    await ready(second)
    const statePath = join(home.home, 'state/tasks/t-orca-1/orca.json')
    expect(JSON.parse(readFileSync(statePath, 'utf8')).replies['recovery-2'].done).toBeUndefined()
    second.orca.sends.push(ok(sendFixture('terminal-send-retry')))
    await second.poll()
    expect(JSON.parse(readFileSync(statePath, 'utf8')).replies['recovery-2'].done).toBe(true)
    const inputs = sends(second) as Array<{ text?: string; retryRequest?: string }>
    expect(inputs.filter((input) => input.text && !input.retryRequest)).toHaveLength(1)
    expect(inputs.at(-1)?.retryRequest).toBe('00000000-0000-4000-8000-000000000003')
    await second.run.cancel()
    await first.run.cancel()
  })

  test('0：codex-orca 声明带外检测能力', () => {
    expect(
      createCodexOrcaExecutor({ home: '/unused' }).adapterCapabilities.out_of_band_detection,
    ).toBe(true)
  })
  test('按任务 id 建 worktree（基于 origin/main），任务说明写入 state/tasks/<id>/spec.md，在终端启动 Codex', async () => {
    const s = await start()
    await ready(s)
    expect(s.orca.ops('worktreeCreate')[0]?.input).toEqual({
      repo: h?.repo,
      name: 't-orca-1',
      baseBranch: 'origin/main',
      setup: 'run',
      comment: 'raindown 任务 t-orca-1',
    })
    const specPath = join(h?.home ?? '', 'state/tasks/t-orca-1/spec.md')
    const spec = readFileSync(specPath, 'utf8')
    expect(spec).toContain('`raindown kb get projects/product-res`')
    expect(spec).toContain('example-user/t-orca-1')
    const created = s.orca.ops('terminalCreate')[0]?.input as {
      command: string
      worktreePath: string
    }
    expect(created).toMatchObject({ title: '[Raindown] t-orca-1' })
    expect(created.worktreePath).toBe(h?.worktree ?? '')
    expect(created.command).toContain(
      `RAINDOWN_ACTOR=dev FLOW_ACTOR=dev CODEX_HOME=${join(h?.home ?? '', 'run/executors/codex-orca/codex-home')} codex`,
    )
    expect(created.command).toContain('RAINDOWN_TASK_ID=t-orca-1 FLOW_TASK_ID=t-orca-1')
    expect(created.command).toContain(
      'RAINDOWN_WORKSPACE=ws/product-res FLOW_WORKSPACE=ws/product-res',
    )
    expect(created.command).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(created.command).toContain(`"$(cat ${specPath})"`)
    const statePath = join(h?.home ?? '', 'state/tasks/t-orca-1/orca.json')
    // 状态文件是异步写入的：等 handle 落盘。
    await until(
      () => readFileSync(statePath, 'utf8').includes(s.orca.handle),
      'orca.json 写入 handle',
    )
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(state).toMatchObject({ branch: 'example-user/t-orca-1', handle: s.orca.handle })
    await s.run.cancel()
  })

  test('启动前清理隔离配置和规则，不改用户的 Codex 目录', async () => {
    const s = await start({}, () => {
      const dir = join(h?.home ?? '', 'run/executors/codex-orca/codex-home')
      const source = join(h?.root ?? '', 'user-codex')
      mkdirSync(join(dir, 'rules'), { recursive: true })
      mkdirSync(source, { recursive: true })
      const config = 'notify = ["unused"]\n[mcp_servers.unused]\ncommand = "unused"\n'
      writeFileSync(join(source, 'config.toml'), config)
      writeFileSync(join(dir, 'config.toml'), config)
      writeFileSync(
        join(dir, 'rules/default.rules'),
        'prefix_rule(pattern=["git", "push"], decision="allow")',
      )
    })
    await ready(s)
    const dir = join(h?.home ?? '', 'run/executors/codex-orca/codex-home')
    const config = readFileSync(join(dir, 'config.toml'), 'utf8')
    expect(config.replace(/^#.*$/gm, '').trim()).toBe('')
    expect(existsSync(join(dir, 'rules'))).toBe(false)
    expect(readFileSync(join(h?.root ?? '', 'user-codex/config.toml'), 'utf8')).toContain(
      'mcp_servers',
    )
    expect(s.orca.ops('terminalCreate')).toHaveLength(1)
    await s.run.cancel()
  })

  test('仓库不属于 workspace：failed(repo_not_in_workspace)，不调用 Orca', async () => {
    const s = await start({ inputs: { repo: '/somewhere/else' } })
    await until(() => s.outcome() !== undefined, '结束')
    const o = s.outcome()
    expect(o?.ok && o.data.outcome).toBe('failed')
    expect(o?.ok && o.data.outcome === 'failed' && o.data.result.reason).toBe(
      'repo_not_in_workspace',
    )
    expect(s.orca.calls).toEqual([])
  })

  test.each(['directory', 'dangling-link'])(
    '项目 .codex 已存在（%s）：blocked(other)，不启动终端、不改项目配置',
    async (kind) => {
      const s = await start({}, (o) => {
        mkdirSync(o.worktreePath, { recursive: true })
        const config = join(o.worktreePath, '.codex')
        if (kind === 'directory') {
          mkdirSync(config)
          writeFileSync(join(config, 'config.toml'), 'notify = ["project-hook"]')
        } else symlinkSync(join(o.worktreePath, 'missing-config'), config)
      })
      await ready(s)
      expect(s.outcome()).toMatchObject({
        ok: true,
        data: { outcome: 'blocked', reason: 'other', message: expect.stringContaining('.codex') },
      })
      expect(s.orca.ops('terminalCreate')).toEqual([])
      expect(sends(s)).toEqual([])
      const config = join(s.orca.worktreePath, '.codex')
      if (kind === 'directory')
        expect(readFileSync(join(config, 'config.toml'), 'utf8')).toBe('notify = ["project-hook"]')
      else expect(lstatSync(config).isSymbolicLink()).toBe(true)
    },
  )

  test('worktree 缺少 .git：blocked(other)，说明祖先配置风险，不启动 Codex', async () => {
    const s = await start({}, (o) => {
      const create = o.worktreeCreate.bind(o)
      o.worktreeCreate = async (input) => {
        const result = await create(input)
        rmSync(join(o.worktreePath, '.git'))
        return result
      }
    })
    await ready(s)
    expect(s.outcome()).toMatchObject({
      ok: true,
      data: {
        outcome: 'blocked',
        reason: 'other',
        message: expect.stringContaining('worktree_git_missing'),
      },
    })
    expect(s.orca.ops('terminalCreate')).toEqual([])
    expect(sends(s)).toEqual([])
  })

  test('创建终端期间出现 .codex：创建后立即关闭，不等信任弹窗', async () => {
    const s = await start({}, (o) => {
      const create = o.terminalCreate.bind(o)
      o.terminalCreate = async (input) => {
        const result = await create(input)
        mkdirSync(join(o.worktreePath, '.codex'))
        return result
      }
    })
    await ready(s)
    expect(s.outcome()).toMatchObject({
      ok: true,
      data: {
        outcome: 'blocked',
        reason: 'other',
        message: expect.stringContaining('project_codex_config'),
      },
    })
    expect(s.orca.ops('terminalCreate')).toHaveLength(1)
    expect(s.orca.ops('terminalClose')).toHaveLength(1)
    expect(s.orca.ops('terminalRead')).toEqual([])
    expect(sends(s)).toEqual([])
  })
})

describe('监控循环', () => {
  test('worker 忙碌时创建 .codex：下一轮即关闭终端并 blocked(other)', async () => {
    const s = await start({}, (o) => o.show('working'))
    await ready(s)
    await s.poll()
    mkdirSync(join(s.orca.worktreePath, '.codex'))
    await s.poll()
    expect(s.outcome()).toMatchObject({
      ok: true,
      data: {
        outcome: 'blocked',
        reason: 'other',
        message: expect.stringContaining('project_codex_config'),
      },
    })
    expect(s.orca.ops('terminalClose')).toHaveLength(1)
    expect(s.activity.some((a) => a.data?.reason === 'project_codex_config')).toBe(true)
    expect(sends(s)).toEqual([])
  })

  test('启动后出现 .codex：确认信任前重新检查，blocked(other)，不发回车', async () => {
    const s = await start({}, (o) => o.show('trust-prompt'))
    await ready(s)
    mkdirSync(join(s.orca.worktreePath, '.codex'))
    await s.poll()
    expect(s.outcome()).toMatchObject({
      ok: true,
      data: { outcome: 'blocked', reason: 'other', message: expect.stringContaining('.codex') },
    })
    expect(sends(s)).toEqual([])
  })

  test('信任提示：只发回车，继续监控，不报告停下', async () => {
    const s = await start({}, (o) => o.show('trust-prompt', 'starting', 'working'))
    await ready(s)
    await s.poll()
    expect(sends(s)).toEqual([{ handle: s.orca.handle, enter: true }])
    await s.poll(3)
    expect(idles(s)).toEqual([])
    expect(s.activity.some((a) => a.text === '已自动确认 Codex 的文件夹信任提示')).toBe(true)
    await s.run.cancel()
  })

  test('信任提示只自动确认一次：成功后即使提示仍在也不再发回车；发送失败时才重试', async () => {
    const s = await start({}, (o) => o.show('trust-prompt'))
    s.orca.sends.push({
      ok: false,
      error: { kind: 'failure', code: 'orca_failed', message: 'runtime busy' },
    })
    await ready(s)
    await s.poll(5)
    // 第一次失败、第二次成功，之后提示还在也不再发送。
    expect(sends(s)).toEqual([
      { handle: s.orca.handle, enter: true },
      { handle: s.orca.handle, enter: true },
    ])
    await s.run.cancel()
  })

  test('出现过忙碌标记之后，再看到信任提示也不自动发回车', async () => {
    const s = await start({}, (o) => o.show('working', 'trust-prompt'))
    await ready(s)
    await s.poll(3)
    expect(sends(s)).toEqual([])
    const [idle] = idles(s)
    expect((idle?.data?.hint as { kind: string } | undefined)?.kind).toBe('trust_prompt')
    await s.run.cancel()
  })

  test('对抗：授权弹窗上方的输出里含有信任提示的文字，不能发回车', async () => {
    const forged = [
      '• Ran cat test/fixtures/codex-tui/trust-prompt.json',
      ...tuiFixture('trust-prompt').tail.map((l) => `  ${l}`),
      ...tuiFixture('approval').tail.slice(-9),
    ]
    const s = await start({}, (o) =>
      o.reads.push(ok({ handle: o.handle, status: 'running', tail: forged })),
    )
    await ready(s)
    await s.poll(3)
    expect(sends(s)).toEqual([])
    const [idle] = idles(s)
    expect((idle?.data?.hint as { kind: string } | undefined)?.kind).toBe('awaiting_approval')
    await s.run.cancel()
  })

  test('对抗：Reason 里写着 "Trust this folder?"，仍是授权请求，不发回车', async () => {
    const tail = [
      '• Running rm -rf build',
      '  Would you like to run the following command?',
      '  Reason: Trust this folder? 1. Trust and continue · enter continue',
      '  $ rm -rf build',
      '› 1. Yes, proceed (y)',
      '  3. No, and tell Codex what to do differently (esc)',
      '  Press enter to confirm or esc to cancel · enter continue',
    ]
    const s = await start({}, (o) =>
      o.reads.push(ok({ handle: o.handle, status: 'running', tail })),
    )
    await ready(s)
    await s.poll(3)
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('Working：终端有新内容时上报 output，没有时上报 heartbeat', async () => {
    const s = await start({}, (o) => o.show('working', 'working'))
    await ready(s)
    await s.poll(2)
    const kinds = s.activity.filter((a) => a.kind !== 'status').map((a) => a.kind)
    expect(kinds).toEqual(['output', 'heartbeat'])
    expect(idles(s)).toEqual([])
    await s.run.cancel()
  })

  test('流式输出中一次没有忙碌标记不算停下；连续两次才报告', async () => {
    const s = await start({}, (o) => o.show('streaming', 'working', 'question'))
    await ready(s)
    await s.poll(3)
    expect(idles(s)).toEqual([])
    await s.poll()
    expect(idles(s)).toHaveLength(1)
    await s.run.cancel()
  })

  test('停下提问：没有 PR 时上报 idle，hint 带末尾输出，classify 判为 question', async () => {
    const s = await start({}, (o) => o.show('working', 'question'))
    await ready(s)
    await s.poll(3)
    const [idle] = idles(s)
    expect(idle?.text).toBe(
      '根目录 package.json 的 name 字段是 raindown。未做任何修改。 下一步你希望我查看什么？',
    )
    const hint = idle?.data?.hint as { kind: string; tail: string[] }
    expect(hint.kind).toBe('question')
    expect(hint.tail.at(-1)).toBe('  ? for shortcuts')
    expect(s.gh.calls).toEqual([{ cwd: h?.repo ?? '', branch: 'example-user/t-orca-1' }])
    await s.poll(2)
    expect(idles(s)).toHaveLength(1)
    await s.run.cancel()
  })

  test('开完 PR 停下：以 done 结束，产物中有 PR 链接；终端保持打开', async () => {
    const s = await start({}, (o) => o.show('working', 'pr-opened'))
    s.gh.prs = [
      {
        url: 'https://github.com/example-user/raindown/pull/20',
        number: 20,
        state: 'OPEN',
        isCrossRepository: false,
        headRefName: 'example-user/t-orca-1',
      },
    ]
    await ready(s)
    await s.poll(3)
    await until(() => s.outcome() !== undefined, '结束')
    const o = s.outcome()
    expect(o?.ok && o.data.outcome).toBe('done')
    if (o?.ok && o.data.outcome === 'done') {
      expect(o.data.result.artifacts[0]).toEqual({
        kind: 'pr',
        ref: 'https://github.com/example-user/raindown/pull/20',
      })
      expect(o.data.result.executor).toBe('codex-orca')
    }
    expect(s.orca.ops('terminalClose')).toEqual([])
  })

  test('同名分支上的 fork PR 或 head 分支不符的 PR 不算本任务的产物', async () => {
    const s = await start({}, (o) => o.show('pr-opened'))
    s.gh.prs = [
      {
        url: 'https://github.com/example-user/raindown/pull/21',
        number: 21,
        state: 'OPEN',
        isCrossRepository: true,
        headRefName: 'example-user/t-orca-1',
      },
      {
        url: 'https://github.com/example-user/raindown/pull/22',
        number: 22,
        state: 'OPEN',
        isCrossRepository: false,
        headRefName: 'other-branch',
      },
    ]
    await ready(s)
    await s.poll(3)
    expect(s.outcome()).toBeUndefined()
    expect(s.gh.calls.length).toBeGreaterThan(0)
    await s.run.cancel()
  })

  test('done 带上 workdir：验收在 worktree 中运行', async () => {
    const s = await start({}, (o) => o.show('pr-opened'))
    s.gh.prs = [
      {
        url: 'https://github.com/example-user/raindown/pull/20',
        number: 20,
        state: 'OPEN',
        isCrossRepository: false,
        headRefName: 'example-user/t-orca-1',
      },
    ]
    await ready(s)
    await s.poll(2)
    await until(() => s.outcome() !== undefined, '结束')
    expect(s.outcome()).toMatchObject({
      ok: true,
      data: { outcome: 'done', workdir: h?.worktree },
    })
  })

  test('gh 不可用：终端里有 PR 链接也不判 done，上报停下并说明 gh 不可用', async () => {
    const s = await start({}, (o) => o.show('pr-opened'))
    s.gh.error = 'gh: not logged in'
    await ready(s)
    await s.poll(3)
    expect(s.outcome()).toBeUndefined()
    const [idle] = idles(s)
    expect(idle?.text).toContain('gh 不可用')
    const hint = idle?.data?.hint as Record<string, unknown>
    expect(hint.gh_error).toBe('gh: not logged in')
    const v = createCodexOrcaExecutor({ home: '/nonexistent' }).classify?.({
      trigger: 'idle',
      tail: [],
      idle_ms: 0,
      hint,
      contract: taskContract.parse({
        goal: 'g',
        workspace: 'ws/product-res',
        role: 'dev',
        executor: 'codex-orca',
      }),
    })
    expect(v?.reason).toBe('other')
    expect(v?.message).toContain('gh 不可用')
    await s.run.cancel()
  })

  test('gh 不可用且终端已退出：exited，不判 done 或会话删除', async () => {
    const s = await start({}, (o) =>
      o.reads.push(ok({ ...tuiFixture('pr-opened'), status: 'exited' })),
    )
    s.gh.error = 'gh: not logged in'
    await ready(s)
    await s.poll()
    await until(() => s.outcome() !== undefined, '结束')
    const o = s.outcome()
    expect(o).toMatchObject({ ok: true, data: { outcome: 'exited' } })
    expect(o?.ok && o.data.outcome === 'exited' && o.data.message).toContain('gh 不可用')
    expect(s.gh.calls).toHaveLength(1)
    expect(s.activity.filter((a) => a.data?.out_of_band)).toHaveLength(0)
  })

  test('无输出：终端已退出且目录仍在，以 exited 结束', async () => {
    const s = await start({}, (o) => o.show('no-output'))
    await ready(s)
    await s.poll()
    await until(() => s.outcome() !== undefined, '结束')
    expect(s.outcome()).toMatchObject({
      ok: true,
      data: { outcome: 'exited' },
    })
    expect(s.activity.filter((a) => a.data?.out_of_band)).toHaveLength(0)
  })

  test('handle 失效（stale）不等于终端已死：在本 worktree 找到进程身份相同的唯一 Codex 就接上', async () => {
    const replacement = 'term_00000000-0000-4000-8000-0000000000bb'
    const s = await start({}, (o) => {
      o.identity = { ptyId: 'pty-current' }
      o.reads.push(staleHandle())
      o.show('question')
    })
    await ready(s)
    s.orca.terminals = ok([
      {
        handle: replacement,
        worktreePath: h?.worktree ?? '',
        agentIdentity: 'codex',
        ptyId: 'pty-current',
      },
      { handle: 'term_shell', worktreePath: h?.worktree ?? '' },
    ])
    await s.poll(3)
    expect(s.outcome()).toBeUndefined()
    const reads = s.orca.ops('terminalRead') as Array<{ input: { handle: string } }>
    expect(reads.at(-1)?.input.handle).toBe(replacement)
    expect(idles(s)).toHaveLength(1)
    const state = JSON.parse(
      readFileSync(join(h?.home ?? '', 'state/tasks/t-orca-1/orca.json'), 'utf8'),
    )
    expect(state.handle).toBe(replacement)
    await s.run.cancel()
  })

  test('stale 后缺少原进程身份：即使唯一候选也不接管，避免接入未隔离 Codex', async () => {
    const s = await start({}, (o) => o.reads.push(staleHandle()))
    await ready(s)
    s.orca.terminals = ok([
      { handle: 'term_legacy', worktreePath: h?.worktree ?? '', agentIdentity: 'codex' },
    ])
    await s.poll(2)
    expect(
      s.orca
        .ops('terminalRead')
        .every((c) => (c.input as { handle: string }).handle === s.orca.handle),
    ).toBe(true)
    expect(s.outcome()).toBeUndefined()
    await s.run.cancel()
  })

  test('stale 后接管：过滤孤儿和已断开的终端，只接管进程身份一致的那个', async () => {
    const wt = () => h?.worktree ?? ''
    const s = await start({}, (o) => {
      o.identity = { ptyId: 'pty-A', incarnationId: 'inc-A' }
      o.reads.push(staleHandle())
      o.show('question')
    })
    await ready(s)
    const statePath = join(h?.home ?? '', 'state/tasks/t-orca-1/orca.json')
    await until(() => readFileSync(statePath, 'utf8').includes('inc-A'), '进程身份落盘')
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      pty_id: 'pty-A',
      incarnation_id: 'inc-A',
    })
    const codex = (handle: string, extra: Record<string, unknown>) => ({
      handle,
      worktreePath: wt(),
      agentIdentity: 'codex',
      ...extra,
    })
    // 第一轮：孤儿、已断开的被过滤；剩下唯一的那个身份不一致 → 不接管。
    s.orca.terminals = ok([
      codex('term_orphan', { orphaned: true, ptyId: 'pty-A', incarnationId: 'inc-A' }),
      codex('term_gone', { connected: false, ptyId: 'pty-A', incarnationId: 'inc-A' }),
      codex('term_other', { connected: true, ptyId: 'pty-B', incarnationId: 'inc-B' }),
    ])
    await s.poll()
    const handles = () =>
      (s.orca.ops('terminalRead') as Array<{ input: { handle: string } }>).map(
        (c) => c.input.handle,
      )
    expect(handles().every((x) => x === s.orca.handle)).toBe(true)
    // 第二轮：身份一致的终端出现 → 接管。
    s.orca.reads.unshift(staleHandle())
    s.orca.terminals = ok([
      codex('term_orphan', { orphaned: true, ptyId: 'pty-A', incarnationId: 'inc-A' }),
      codex('term_same', { connected: true, ptyId: 'pty-A', incarnationId: 'inc-A' }),
    ])
    await s.poll(2)
    expect(handles().at(-1)).toBe('term_same')
    expect(JSON.parse(readFileSync(statePath, 'utf8')).handle).toBe('term_same')
    await s.run.cancel()
  })

  test('handle 失效且找不到替代：按临时错误继续重试，不判退出；deliver 抛出而不是 not_running', async () => {
    const s = await start({}, (o) => {
      o.reads.push(staleHandle())
    })
    s.orca.terminals = ok([])
    await ready(s)
    await s.poll(3)
    expect(s.outcome()).toBeUndefined()
    await expect(
      s.run.deliver?.({ reply_id: 'r-1', kind: 'text', text: 'x', by: 'user' }) ??
        Promise.resolve('none'),
    ).rejects.toThrow()
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('报告停下后 Codex 自行恢复（用户直接在终端里答复）：上报 resumed', async () => {
    const s = await start({}, (o) => o.show('question', 'question', 'working'))
    await ready(s)
    await s.poll(3)
    expect(idles(s)).toHaveLength(1)
    expect(s.activity.some((a) => a.data?.resumed === true)).toBe(true)
    await s.run.cancel()
  })
})

describe('deliver 与 cancel', () => {
  test('两次轮询之间出现 .codex：deliver 检查后关闭终端，不发送文字', async () => {
    const s = await start({}, (o) => o.show('question'))
    await ready(s)
    mkdirSync(join(s.orca.worktreePath, '.codex'))
    expect(
      await s.run.deliver?.({ reply_id: 'r-guard', kind: 'text', text: '继续', by: 'user' }),
    ).toBe('not_running')
    expect(await s.run.done).toMatchObject({
      ok: true,
      data: {
        outcome: 'blocked',
        reason: 'other',
        message: expect.stringContaining('project_codex_config'),
      },
    })
    expect(s.orca.ops('terminalClose')).toHaveLength(1)
    expect(sends(s)).toEqual([])
  })

  test.each(['trust-prompt', 'trust-prompt-0167'])(
    '重新挂接后仍在信任弹窗（%s）：拒绝把回复和 Enter 打入弹窗',
    async (fixture) => {
      const first = await start({}, (o) => o.show(fixture))
      await ready(first)
      const home = h
      if (!home) throw new Error('no home')
      const reply = {
        reply_id: 'r-trust',
        kind: 'text' as const,
        text: '已经移出配置，请继续',
        by: 'user',
      }
      const second = await start({}, (o) => o.show(fixture), { home, resume: { reply } })
      await ready(second)
      expect(await second.run.deliver?.(reply)).toEqual({
        outcome: 'dropped',
        reason: 'round_closed',
      })
      expect(
        await second.run.deliver?.({ reply_id: 'r-trust-approve', kind: 'approve', by: 'user' }),
      ).toEqual({ outcome: 'dropped', reason: 'round_closed' })
      expect(sends(second)).toEqual([])
      expect(second.orca.ops('terminalCreate')).toEqual([])
      await first.run.cancel()
      await second.run.cancel()
    },
  )

  test('回复提问：文字加回车送进终端，按 reply_id 幂等', async () => {
    const s = await start({}, (o) => o.show('question'))
    await ready(s)
    await s.poll(2)
    const reply = { reply_id: 'r-1', kind: 'text' as const, text: '用方案 A\n谢谢', by: 'user' }
    expect(await s.run.deliver?.(reply)).toBe('delivered')
    expect(await s.run.deliver?.(reply)).toBe('delivered')
    expect(sends(s)).toEqual([
      { handle: s.orca.handle, text: '用方案 A 谢谢', enter: true, waitSubmitS: 10 },
    ])
    await s.run.cancel()
  })

  test('没有观察到这一轮开始：用同一个 request id 复核，不重发', async () => {
    const s = await start({}, (o) => {
      o.show('question')
      o.sends.push(ok(sendFixture('terminal-send-no-turn')), ok(sendFixture('terminal-send-retry')))
    })
    await ready(s)
    await s.poll(2)
    expect(await s.run.deliver?.({ reply_id: 'r-1', kind: 'text', text: '继续', by: 'user' })).toBe(
      'delivered',
    )
    const id = '00000000-0000-4000-8000-000000000003'
    expect(sends(s)).toEqual([
      { handle: s.orca.handle, text: '继续', enter: true, waitSubmitS: 10 },
      { handle: s.orca.handle, text: '继续', enter: true, retryRequest: id, waitSubmitS: 10 },
    ])
    await s.run.cancel()
  })

  test('复核两次仍未开始：补发一次回车', async () => {
    const noTurn = ok(sendFixture('terminal-send-no-turn'))
    const s = await start({}, (o) => {
      o.show('question')
      o.sends.push(noTurn, noTurn, noTurn)
    })
    await ready(s)
    await s.poll(2)
    await s.run.deliver?.({ reply_id: 'r-1', kind: 'text', text: '继续', by: 'user' })
    const all = sends(s) as Array<{ text?: string; retryRequest?: string }>
    expect(all).toHaveLength(4)
    expect(all.filter((x) => x.text !== undefined && !x.retryRequest)).toHaveLength(1)
    expect(all.at(-1) as unknown).toEqual({ handle: s.orca.handle, enter: true })
    await s.run.cancel()
  })

  test('送达失败抛出后重送：已拿到的 request id 用于复核，Codex 不会收到第二次', async () => {
    const s = await start({}, (o) => {
      o.show('question')
      o.sends.push(
        ok(sendFixture('terminal-send-no-turn')),
        { ok: false, error: { kind: 'failure', code: 'orca_failed', message: 'runtime down' } },
        { ok: false, error: { kind: 'failure', code: 'orca_failed', message: 'runtime down' } },
        { ok: false, error: { kind: 'failure', code: 'orca_failed', message: 'runtime down' } },
      )
    })
    await ready(s)
    await s.poll(2)
    const reply = { reply_id: 'r-1', kind: 'text' as const, text: '继续', by: 'user' }
    // 两次复核失败后补发回车也失败：仍视为已送达（输入已被接受）。
    expect(await s.run.deliver?.(reply)).toBe('delivered')
    const fresh = (sends(s) as Array<{ text?: string; retryRequest?: string }>).filter(
      (x) => x.text !== undefined && !x.retryRequest,
    )
    expect(fresh).toHaveLength(1)
    await s.run.cancel()
  })

  test('批准授权请求：只发回车', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await ready(s)
    await s.poll(2)
    const [idle] = idles(s)
    expect((idle?.data?.hint as { kind: string } | undefined)?.kind).toBe('awaiting_approval')
    expect(await s.run.deliver?.({ reply_id: 'r-1', kind: 'approve', by: 'user' })).toBe(
      'delivered',
    )
    expect(sends(s)).toEqual([{ handle: s.orca.handle, enter: true }])
    await s.run.cancel()
  })

  test('拒绝授权请求：先发 Esc，再把理由作为新一轮发出', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await ready(s)
    await s.poll(2)
    const timers = s.clock.pendingTimers()
    const p = s.run.deliver?.({ reply_id: 'r-1', kind: 'deny', text: '不要写 /tmp', by: 'user' })
    // Esc 发出后还要持久化送达状态，之后才会挂上 1 秒延时。
    await until(() => s.clock.pendingTimers() > timers, 'Esc 后的延时定时器')
    s.orca.reads = [ok(tuiFixture('question'))]
    await s.clock.advance(1_000)
    expect(await p).toBe('delivered')
    expect(sends(s)).toEqual([
      { handle: s.orca.handle, text: '\u001b' },
      { handle: s.orca.handle, text: '不同意：不要写 /tmp', enter: true, waitSubmitS: 10 },
    ])
    await s.run.cancel()
  })

  test('送达后 Codex 回答完又停下：再次报告停下', async () => {
    const s = await start({}, (o) =>
      o.show('question', 'question', 'question', 'working', 'question'),
    )
    await ready(s)
    await s.poll(2)
    expect(idles(s)).toHaveLength(1)
    await s.run.deliver?.({ reply_id: 'r-1', kind: 'text', text: '看 README', by: 'user' })
    await s.poll(4)
    expect(idles(s)).toHaveLength(2)
    await s.run.cancel()
  })

  test('提问之后出现授权弹窗：旧回合的批准不能操作新弹窗', async () => {
    const s = await start({}, (o) => o.show('question', 'question', 'approval'))
    await ready(s)
    await s.poll(2)
    await expect(
      s.run.deliver?.({ reply_id: 'r-1', kind: 'approve', by: 'user' }),
    ).resolves.toMatchObject({ outcome: 'dropped', reason: 'round_closed' })
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('授权弹窗消失：批准不能作为文字输入忙碌或提问中的 Codex', async () => {
    const s = await start({}, (o) => o.show('approval', 'approval', 'question'))
    await ready(s)
    await s.poll(2)
    await expect(
      s.run.deliver?.({ reply_id: 'r-1', kind: 'approve', by: 'user' }),
    ).resolves.toMatchObject({ outcome: 'dropped', reason: 'round_closed' })
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('deliver 时终端已退出：not_running', async () => {
    const s = await start({}, (o) => o.show('question', 'question', 'no-output'))
    await ready(s)
    await s.poll(2)
    expect(await s.run.deliver?.({ reply_id: 'r-1', kind: 'text', text: 'x', by: 'user' })).toBe(
      'not_running',
    )
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('送达记录持久化：节点重启后同一个 reply_id 不再送进终端', async () => {
    const reply = { reply_id: 'r-1', kind: 'text' as const, text: '用方案 A', by: 'user' }
    const first = await start({}, (o) => o.show('question'))
    await ready(first)
    await first.poll(2)
    expect(await first.run.deliver?.(reply)).toBe('delivered')
    const home = h
    if (!home) throw new Error('no home')
    // 模拟节点重启：终端不关闭，第一次执行直接被丢弃，新的执行从 orca.json 恢复。
    const state = JSON.parse(
      readFileSync(join(home.home, 'state/tasks/t-orca-1/orca.json'), 'utf8'),
    )
    expect(state.replies['r-1']).toMatchObject({ done: true })
    expect(state.codex_home).toBe(join(home.home, 'run/executors/codex-orca/codex-home'))

    const second = await start({}, (o) => o.show('question'), { home, resume: { reply } })
    await until(
      () => second.activity.some((a) => a.text?.includes('接着使用已有的终端')),
      '复用终端',
    )
    await realWait(20)
    expect(await second.run.deliver?.(reply)).toBe('delivered')
    expect(sends(second)).toEqual([])
    expect(second.orca.ops('terminalCreate')).toEqual([])
    await second.run.cancel()
  })

  test.each([undefined, '/legacy-codex-home', 'codex-work-home'])(
    '拒绝重挂接未使用当前隔离目录的存活终端：%s',
    async (codexHome) => {
      const first = await start({}, (o) => o.show('question'))
      await ready(first)
      const home = h
      if (!home) throw new Error('no home')
      const statePath = join(home.home, 'state/tasks/t-orca-1/orca.json')
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      if (codexHome === 'codex-work-home') {
        state.codex_home = join(home.home, 'state', codexHome)
        mkdirSync(state.codex_home)
      } else state.codex_home = codexHome
      writeFileSync(statePath, JSON.stringify(state))
      const second = await start({}, (o) => o.show('question'), { home })
      await ready(second)
      expect(second.outcome()).toMatchObject({
        ok: true,
        data: { outcome: 'failed', result: { reason: 'codex_home_mismatch' } },
      })
      expect(second.orca.ops('terminalCreate')).toEqual([])
      expect(sends(second)).toEqual([])
      await first.run.cancel()
    },
  )

  test('恢复记录中的 CODEX_HOME 是真实目录别名：规范化后仍复用终端', async () => {
    const first = await start({}, (o) => o.show('question'))
    await ready(first)
    const home = h
    if (!home) throw new Error('no home')
    const statePath = join(home.home, 'state/tasks/t-orca-1/orca.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const alias = join(home.root, 'codex-alias')
    symlinkSync(realpathSync(state.codex_home), alias)
    state.codex_home = `${alias}/.`
    writeFileSync(statePath, JSON.stringify(state))
    const second = await start({}, (o) => o.show('question'), { home })
    await ready(second)
    expect(second.activity.some((a) => a.text?.includes('接着使用已有的终端'))).toBe(true)
    expect(second.orca.ops('terminalCreate')).toEqual([])
    await first.run.cancel()
    await second.run.cancel()
  })

  test('worker 创建 .codex 后恢复：blocked(other)，不重挂接或送达回复', async () => {
    const first = await start({}, (o) => o.show('working'))
    await ready(first)
    const home = h
    if (!home) throw new Error('no home')
    mkdirSync(join(home.worktree, '.codex'))
    const second = await start({}, (o) => o.show('working'), {
      home,
      resume: { reply: { reply_id: 'r-restore', kind: 'text', text: '继续', by: 'user' } },
    })
    await ready(second)
    expect(second.outcome()).toMatchObject({
      ok: true,
      data: { outcome: 'blocked', reason: 'other', message: expect.stringContaining('.codex') },
    })
    expect(second.orca.ops('terminalRead')).toEqual([])
    expect(second.orca.ops('terminalCreate')).toEqual([])
    expect(sends(second)).toEqual([])
    await first.run.cancel()
  })

  test('恢复时整个 worktree 丢失：blocked(workdir_missing)，不重建目录或启动 Codex', async () => {
    const first = await start({}, (o) => o.show('working'))
    await ready(first)
    const home = h
    if (!home) throw new Error('no home')
    rmSync(home.worktree, { recursive: true })
    const second = await start({}, (o) => o.show('working'), { home })
    await ready(second)
    expect(second.outcome()).toMatchObject({
      ok: true,
      data: {
        outcome: 'blocked',
        reason: 'workdir_missing',
        message: expect.stringContaining('工作目录不存在'),
      },
    })
    expect(second.orca.ops('worktreeCreate')).toEqual([])
    expect(second.orca.ops('terminalCreate')).toEqual([])
    expect(existsSync(home.worktree)).toBe(false)
    await first.run.cancel()
  })

  test('复用记录中的 handle 前确认它属于这个 worktree；不属于时新建终端', async () => {
    const first = await start({}, (o) => o.show('working'))
    await ready(first)
    const home = h
    if (!home) throw new Error('no home')
    const statePath = join(home.home, 'state/tasks/t-orca-1/orca.json')
    await until(() => readFileSync(statePath, 'utf8').includes(first.orca.handle), 'handle 落盘')
    const second = await start(
      {},
      (o) => {
        o.show('working')
        o.terminals = ok([{ handle: o.handle, worktreePath: '/elsewhere', agentIdentity: 'codex' }])
      },
      { home },
    )
    await ready(second)
    // 记录中的 handle 经 terminal list 校验后被拒绝，才新建终端。
    expect(second.orca.ops('terminalList')).toHaveLength(1)
    expect(second.orca.ops('terminalCreate')).toHaveLength(1)
    await first.run.cancel()
    await second.run.cancel()
  })

  test('取消：关闭终端，worktree 保留；之后 deliver 返回 not_running', async () => {
    const s = await start({}, (o) => o.show('working'))
    await ready(s)
    await s.poll()
    await s.run.cancel()
    await until(() => s.outcome() !== undefined, '结束')
    expect(s.outcome()).toMatchObject({ ok: true, data: { outcome: 'cancelled' } })
    expect(s.orca.ops('terminalClose')).toEqual([
      { op: 'terminalClose', input: { handle: s.orca.handle } },
    ])
    expect(s.orca.ops('worktreeRm')).toEqual([])
    expect(existsSync(h?.worktree ?? '')).toBe(true)
    expect(await s.run.deliver?.({ reply_id: 'r-9', kind: 'text', text: 'x', by: 'user' })).toBe(
      'not_running',
    )
  })

  test('节点的取消信号同样关闭终端', async () => {
    const s = await start({}, (o) => o.show('working'))
    await ready(s)
    s.abort.abort()
    await until(() => s.outcome() !== undefined, '结束')
    expect(s.outcome()).toMatchObject({ ok: true, data: { outcome: 'cancelled' } })
    expect(s.orca.ops('terminalClose')).toHaveLength(1)
  })
})

describe('验收目录（PR #24 审查第 3 条）', () => {
  test('执行器在 done 中给出 workdir 时，验收命令在 workdir 中运行，而不是合同的 cwd', async () => {
    h = orcaHome()
    const workdir = h.worktree
    mkdirSync(workdir, { recursive: true })
    const plugin: ExecutorPlugin = {
      type: 'codex-orca',
      mode: 'interactive',
      adapterCapabilities: NO_ADAPTER_CAPABILITIES,
      run: (_c, ctx) => {
        const queue = new ActivityQueue()
        queue.close()
        return {
          activity: queue,
          done: Promise.resolve(
            ok({
              outcome: 'done' as const,
              workdir,
              result: {
                summary: 'ok',
                artifacts: [],
                verify: [],
                executor: 'codex-orca',
                node_id: ctx.nodeId,
              },
            }),
          ),
          cancel: async () => {},
        }
      },
    }
    const b = await bench({ executors: [plugin] })
    try {
      const id = await b.create({
        executor: 'codex-orca',
        cwd: h.repo,
        verify: [{ cmd: [process.execPath, '-e', 'console.log(process.cwd())'] }],
      })
      const deadline = Date.now() + 10_000
      while (!['done', 'failed'].includes(b.task(id).status)) {
        if (Date.now() > deadline) throw new Error(`等待验收超时：${b.task(id).status}`)
        await b.clock.advance(1000)
        await realWait(5)
      }
      const t = b.task(id)
      expect(t.status).toBe('done')
      expect(t.result?.verify[0]?.output_tail).toContain(realpathSync(workdir))
      expect(t.result?.verify[0]?.output_tail).not.toContain(realpathSync(h.repo))
    } finally {
      await b.close()
    }
  })
})

describe('经节点与中枢的完整流程', () => {
  test('Codex 停下提问 → blocked(question) 附末尾输出 → 用户回复"用方案 A" → 终端收到 → 开 PR → done', async () => {
    let real: ExecutorPlugin | undefined
    const proxy: ExecutorPlugin = {
      type: 'codex-orca',
      mode: 'interactive',
      adapterCapabilities: createCodexOrcaExecutor({ home: '/nonexistent' }).adapterCapabilities,
      classify: (snap) => real?.classify?.(snap) ?? null,
      run: (c, ctx) => {
        if (!real) throw new Error('执行器尚未就绪')
        return real.run(c, ctx)
      },
    }
    const b = await bench({ executors: [proxy] })
    h = orcaHome()
    const orca = new FakeOrca(h.worktree)
    orca.show('working', 'question')
    const gh = new FakeGh()
    real = createCodexOrcaExecutor({
      home: h.home,
      codexAuthSource: join(h.root, 'user-codex'),
      clock: b.clock,
      orca,
      gh,
      baseBranch: async () => 'origin/main',
      waitForSetup: async () => ok(undefined),
    })
    try {
      const id = await b.create({
        executor: 'codex-orca',
        workspace: 'ws/product-res',
        inputs: { repo: h.repo },
      })
      await until(() => orca.ops('terminalCreate').length > 0, '启动 Codex')
      const blocked = await b.until(id, (t) => t.status === 'blocked', 600_000)
      expect(blocked.blocked).toMatchObject({
        reason: 'question',
        message:
          '根目录 package.json 的 name 字段是 raindown。未做任何修改。 下一步你希望我查看什么？',
        lease_held: true,
      })
      expect(blocked.blocked?.tail?.join('\n')).toContain('下一步你希望我查看什么？')

      orca.reads = []
      orca.show('working', 'pr-opened')
      gh.prs = [
        {
          url: 'https://github.com/example-user/raindown/pull/20',
          number: 20,
          state: 'OPEN',
          isCrossRepository: false,
          headRefName: 'example-user/t-orca-1',
        },
      ]
      await b.api('POST', `/v1/tasks/${id}/reply`, { kind: 'text', text: '用方案 A' })
      const done = await b.until(id, (t) => t.status === 'done', 600_000)
      expect(done.result?.artifacts[0]).toEqual({
        kind: 'pr',
        ref: 'https://github.com/example-user/raindown/pull/20',
      })
      const texts = (orca.ops('terminalSend') as Array<{ input: { text?: string } }>).map(
        (c) => c.input.text,
      )
      expect(texts).toEqual(['用方案 A'])
      expect(b.types(id)).toContain('task.unblocked')
    } finally {
      await b.close()
    }
  })
})

describe('脱敏', () => {
  test('终端输出作为活动上报前脱敏', async () => {
    const token = ['ghp', 'B'.repeat(36)].join('_')
    const s = await start({}, (o) => {
      o.reads.push(
        ok({
          handle: o.handle,
          status: 'running',
          tail: [`• Ran echo ${token}`, '• Working (1s • esc to interrupt)'],
        }),
      )
    })
    await ready(s)
    await s.poll()
    const out = s.activity
      .filter((a) => a.kind === 'output')
      .map((a) => a.text ?? '')
      .join('\n')
    expect(out).toContain('[REDACTED:github-token]')
    expect(out).not.toContain(token)
    await s.run.cancel()
  })
})

test('user 角色在创建 worktree 或接管旧终端前失败', async () => {
  h = orcaHome()
  writeFileSync(
    join(h.home, 'config/roles/user.yaml'),
    'name: user\nexecutor: codex-orca\nprompt: 测试\n',
  )
  const s = await start({ role: 'user' }, undefined, { home: h })
  await ready(s)
  expect(await s.run.done).toMatchObject({
    ok: true,
    data: { outcome: 'failed', result: { reason: 'unknown_role' } },
  })
  expect(s.orca.calls).toEqual([])
})

const outside = (s: Started) => s.activity.filter((a) => a.data?.out_of_band)
const APPROVAL_COMMAND = 'mkdir -p /tmp/raindown-tui-probe-dir2'
const executed = (line: string) => ({
  ...tuiFixture('working'),
  tail: [line, '• Working (1s • esc to interrupt)'],
})

function approvalCommand(command: string) {
  const approval = tuiFixture('approval')
  return {
    ...approval,
    tail: approval.tail.map((line) => line.replaceAll(APPROVAL_COMMAND, command)),
  }
}

describe('弹窗指纹', () => {
  for (const change of ['行尾空白', '括号内容']) {
    test(`两次终端读取仅改变${change}时，指纹${change === '行尾空白' ? '相同' : '不同'}`, async () => {
      const first = approvalCommand("rm -rf '/tmp/(1s harmless)'")
      const second =
        change === '行尾空白'
          ? { ...first, tail: first.tail.map((line) => `${line} \t `) }
          : approvalCommand("rm -rf '/tmp/(2s valuable)'")
      const s = await start({}, (o) => {
        o.reads = [ok(first)]
      })
      await s.poll(2)
      s.orca.reads = [ok(tuiFixture('working'))]
      await s.poll()
      s.orca.reads = [ok(second)]
      await s.poll(2)
      const fingerprints = idles(s).map(
        (a) =>
          (a.data?.hint as { approval_fingerprint?: string } | undefined)?.approval_fingerprint,
      )
      expect(fingerprints).toHaveLength(2)
      expect(fingerprints[0]).toMatch(/^[a-f0-9]{64}$/)
      if (change === '行尾空白') expect(fingerprints[1]).toBe(fingerprints[0])
      else expect(fingerprints[1]).not.toBe(fingerprints[0])
      await s.run.cancel()
    })
  }
})

describe('授权回合跨重启恢复', () => {
  async function pendingApproval(command?: string) {
    const first = await start({}, (o) => {
      o.reads = [ok(command ? approvalCommand(command) : tuiFixture('approval'))]
    })
    await first.poll(2)
    const home = h
    if (!home) throw new Error('no home')
    const path = join(home.home, 'state/tasks/t-orca-1/orca.json')
    await until(
      () => JSON.parse(readFileSync(path, 'utf8')).approval_round?.blockSeq === 1,
      '授权回合及中枢 blockSeq 落盘',
    )
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    const hint = idles(first)[0]?.data?.hint as
      | { request_id?: string; approval_fingerprint?: string }
      | undefined
    expect(saved.approval_round.request_id).toBe(hint?.request_id)
    const fingerprint = createHash('sha256').update(saved.approval_round.fingerprint).digest('hex')
    expect(hint?.approval_fingerprint).toBe(fingerprint)
    return { first, home, path, saved, fingerprint }
  }

  test.each(['approve', 'deny'] as const)(
    '恢复原授权回合的 %s：核对账本指纹后送达',
    async (kind) => {
      const { first, home, fingerprint } = await pendingApproval()
      let dropped = 0
      const reply = {
        reply_id: 'r-resume',
        kind,
        by: 'user',
        text: '不要写 /tmp',
        block_seq: 1,
        approval_fingerprint: fingerprint,
      }
      // 模拟进程消失，保留终端和 orca.json，由新执行器接管。
      const second = await start({}, (o) => o.show('approval'), {
        home,
        resume: { reply },
        reportResumeReplyDropped: () => dropped++,
      })
      if (kind === 'deny') {
        await until(() => second.clock.pendingTimers() > 0, '恢复拒绝后的 Esc 延时')
        second.orca.reads = [ok(tuiFixture('question'))]
        await second.clock.advance(1_000)
      }
      await ready(second)
      expect(await second.run.deliver?.(reply)).toBe('delivered')
      expect(sends(second)).toEqual(
        kind === 'approve'
          ? [{ handle: second.orca.handle, enter: true }]
          : [
              { handle: second.orca.handle, text: '\u001b' },
              {
                handle: second.orca.handle,
                text: '不同意：不要写 /tmp',
                enter: true,
                waitSubmitS: 10,
              },
            ],
      )
      expect(second.orca.ops('terminalCreate')).toHaveLength(0)
      expect(dropped).toBe(0)
      await second.run.cancel()
      await first.run.cancel()
    },
  )

  test('恢复投递连续临时失败跨过两次轮询，不重建原授权回合，恢复后仍可送达', async () => {
    const { first, home, path, saved, fingerprint } = await pendingApproval()
    let dropped = 0
    const reply = {
      reply_id: 'r-resume-retry',
      kind: 'approve' as const,
      by: 'user',
      block_seq: 1,
      approval_fingerprint: fingerprint,
    }
    const second = await start(
      {},
      (o) => {
        o.show('approval')
        o.sends = Array.from({ length: 3 }, () =>
          fail('retryable', 'orca_unavailable', '临时不可访问'),
        )
      },
      { home, resume: { reply }, reportResumeReplyDropped: () => dropped++ },
    )
    await second.poll(2)
    const restored = JSON.parse(readFileSync(path, 'utf8')).approval_round
    expect(restored.blockSeq).toBe(1)
    expect(restored.fingerprint).toBe(saved.approval_round.fingerprint)
    expect(idles(second)).toHaveLength(0)
    await second.poll()
    expect(await second.run.deliver?.(reply)).toBe('delivered')
    expect(sends(second)).toHaveLength(4)
    expect(dropped).toBe(0)
    await second.run.cancel()
    await first.run.cancel()
  })

  test.each(['seq_missing', 'prompt_changed', 'legacy_ledger', 'escaped_before_restart'])(
    '恢复授权回复不再匹配（%s）：不发送按键，主动报告回复未送达',
    async (mismatch) => {
      const { first, home, path, saved, fingerprint } = await pendingApproval()
      if (mismatch === 'escaped_before_restart') {
        saved.replies['r-resume'] = {
          round_id: saved.approval_round.request_id,
          esc_sent: true,
        }
        saved.approval_round.attempted = true
        writeFileSync(path, JSON.stringify(saved))
      }
      let dropped = 0
      const reply = {
        reply_id: 'r-resume',
        kind: mismatch === 'escaped_before_restart' ? ('deny' as const) : ('approve' as const),
        by: 'user',
        block_seq: mismatch === 'seq_missing' ? undefined : 1,
        approval_fingerprint: mismatch === 'legacy_ledger' ? undefined : fingerprint,
      }
      const second = await start(
        {},
        (o) => {
          o.reads = [
            ok(
              mismatch === 'prompt_changed'
                ? approvalCommand('git push --force origin HEAD')
                : tuiFixture(mismatch === 'escaped_before_restart' ? 'question' : 'approval'),
            ),
          ]
        },
        { home, resume: { reply }, reportResumeReplyDropped: () => dropped++ },
      )
      await ready(second)
      expect(dropped).toBe(1)
      expect(sends(second)).toEqual([])
      expect(await second.run.deliver?.(reply)).toEqual({
        outcome: 'dropped',
        reason: 'round_closed',
        ...(mismatch === 'escaped_before_restart' ? { attempted: true } : {}),
      })
      await second.run.cancel()
      expect(dropped).toBe(1)
      await first.run.cancel()
    },
  )

  test.each(['resume', 'ordinary', 'command_timer'])(
    '伪造 orca.json 的回合指纹不能将批准送进另一个弹窗（%s）',
    async (mode) => {
      const { first, home, path, saved, fingerprint } = await pendingApproval(
        mode === 'command_timer' ? "rm -rf '/tmp/(1s harmless)'" : undefined,
      )
      const changed = approvalCommand(
        mode === 'command_timer' ? "rm -rf '/tmp/(2s valuable)'" : 'git push --force origin HEAD',
      )
      const changedAnalysis = analyzeTail(changed.tail)
      saved.approval_round.fingerprint = changedAnalysis.last_message.join('\n')
      saved.approval_round.command = 'git push --force origin HEAD'
      saved.approval_round.request_id = 'forged-request'
      writeFileSync(path, JSON.stringify(saved))
      let dropped = 0
      const reply = {
        reply_id: 'forged-cache',
        kind: 'approve' as const,
        by: 'user',
        block_seq: 1,
        approval_fingerprint: fingerprint,
      }
      const second = await start(
        {},
        (o) => {
          o.reads = [ok(changed)]
        },
        {
          home,
          ...(mode === 'ordinary' ? {} : { resume: { reply } }),
          reportResumeReplyDropped: () => dropped++,
        },
      )
      await ready(second)
      if (mode === 'ordinary') {
        expect(await second.run.deliver?.(reply)).toEqual({
          outcome: 'dropped',
          reason: 'round_closed',
        })
      }
      expect(sends(second)).toEqual([])
      expect(dropped).toBe(mode === 'ordinary' ? 0 : 1)
      await second.run.cancel()
      await first.run.cancel()
    },
  )

  test.each(['missing', 'changed', 'closed_same_prompt'])(
    '账本指纹匹配时忽略本地回合缓存（%s）',
    async (cache) => {
      const { first, home, path, saved, fingerprint } = await pendingApproval()
      if (cache === 'missing') delete saved.approval_round
      else if (cache === 'closed_same_prompt') {
        // 固有限制：离线期间旧请求被处理后出现相同弹窗，只靠账本指纹无法区分。
        saved.approval_round.closed = true
        saved.approval_round.attempted = true
      } else {
        saved.approval_round.fingerprint = 'forged'
        saved.approval_round.blockSeq = 999
        saved.approval_round.closed = true
      }
      writeFileSync(path, JSON.stringify(saved))
      let dropped = 0
      const second = await start({}, (o) => o.show('approval'), {
        home,
        resume: {
          reply: {
            reply_id: 'ledger-approval',
            kind: 'approve',
            by: 'user',
            block_seq: 1,
            approval_fingerprint: fingerprint,
          },
        },
        reportResumeReplyDropped: () => dropped++,
      })
      await ready(second)
      expect(sends(second)).toEqual([{ handle: second.orca.handle, enter: true }])
      expect(dropped).toBe(0)
      await second.run.cancel()
      await first.run.cancel()
    },
  )

  test('恢复时回合曾尝试发送，拒收回执及提示说明可能没有送达', async () => {
    const { first, home, path, saved, fingerprint } = await pendingApproval()
    saved.approval_round.attempted = true
    writeFileSync(path, JSON.stringify(saved))
    const rejections: Array<{ attempted?: boolean } | undefined> = []
    const second = await start(
      {},
      (o) => {
        o.reads = [ok(approvalCommand('git push --force origin HEAD'))]
      },
      {
        home,
        resume: {
          reply: {
            reply_id: 'attempted-approval',
            kind: 'approve',
            by: 'user',
            block_seq: 1,
            approval_fingerprint: fingerprint,
          },
        },
        reportResumeReplyDropped: (options) => {
          rejections.push(options)
        },
      },
    )
    await ready(second)
    expect(rejections).toEqual([{ attempted: true }])
    expect(second.activity.some((a) => a.text?.includes('这条回复可能没有送达'))).toBe(true)
    expect(sends(second)).toEqual([])
    await second.run.cancel()
    await first.run.cancel()
  })
})

describe('第二轮审查回归', () => {
  test('1：弹窗离开为提问后，同指纹弹窗重现会建立新回合', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await s.poll(2)
    s.orca.reads = [ok(tuiFixture('question'))]
    await s.poll(2)
    s.orca.reads = [ok(tuiFixture('approval'))]
    await s.poll(3)
    expect(idles(s)).toHaveLength(3)
    expect(s.activity.filter((a) => a.data?.resumed)).toHaveLength(2)
    expect(await s.run.deliver?.({ reply_id: 'reappeared', kind: 'approve', by: 'user' })).toBe(
      'delivered',
    )
    expect(sends(s)).toEqual([{ handle: s.orca.handle, enter: true }])
    await s.run.cancel()
  })
  const wrapped = () => {
    const modal = approvalCommand('gh pr create --title "long title" --body "long description"')
    return {
      ...modal,
      tail: modal.tail.flatMap((line) =>
        line.trimStart().startsWith('$ ')
          ? ['  $ gh pr create --title "long title"', '    --body "long description"']
          : [line],
      ),
    }
  }
  const edits = () => {
    const modal = tuiFixture('approval')
    return {
      ...modal,
      tail: modal.tail.flatMap((line) =>
        line.includes('Would you like to run the following command?')
          ? ['  Would you like to make the following edits?']
          : line.trimStart().startsWith('$ ')
            ? ['  *** Update File: README.md', '  + new text']
            : [line],
      ),
    }
  }
  for (const [name, modal] of [
    ['折行长命令', wrapped],
    ['编辑类', edits],
  ] as const) {
    test(`1：${name}弹窗不能由 supervisor 绕过严格解析代批`, async () => {
      const s = await start({}, (o) => o.reads.push(ok(modal())))
      await s.poll(2)
      expect(
        await s.run.deliver?.({
          reply_id: 'supervisor-unparsed',
          kind: 'approve',
          by: 'supervisor',
        }),
      ).toBe('dropped')
      expect(sends(s)).toEqual([])
      await s.run.cancel()
    })
    for (const kind of ['approve', 'deny'] as const) {
      test(`1：${name}弹窗严格解析失败，用户仍可 ${kind}`, async () => {
        expect(approvalForPrecheck(modal().tail)).toBeUndefined()
        expect(analyzeTail(modal().tail).kind).toBe('awaiting_approval')
        const s = await start({}, (o) => o.reads.push(ok(modal())))
        await s.poll(2)
        const timers = s.clock.pendingTimers()
        const delivery = s.run.deliver?.({
          reply_id: `human-${kind}`,
          kind,
          by: 'user',
          text: kind === 'deny' ? '停止' : undefined,
        })
        if (kind === 'deny') {
          await until(() => s.clock.pendingTimers() > timers, 'Esc 后等待')
          s.orca.reads = [ok(tuiFixture('question'))]
          await s.clock.advance(1_000)
        }
        expect(await delivery).toBe('delivered')
        expect(sends(s)[0]).toMatchObject(kind === 'approve' ? { enter: true } : { text: '\u001b' })
        await s.run.cancel()
      })
    }
  }

  test('1：命令相同但弹窗指纹变化，旧批准被确定性丢弃', async () => {
    const s = await start({}, (o) => o.reads.push(ok(wrapped())))
    await s.poll(2)
    const changed = wrapped()
    changed.tail = changed.tail.map((line) =>
      line.includes('Reason:') ? '  Reason: 已改变的授权范围' : line,
    )
    s.orca.reads = [ok(changed)]
    expect(
      await s.run.deliver?.({ reply_id: 'changed-modal', kind: 'approve', by: 'user' }),
    ).toEqual({ outcome: 'dropped', reason: 'round_closed' })
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('2：Esc 后理由发送暂时失败，弹窗关闭后可重试文字且不重发 Esc', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await s.poll(2)
    s.orca.sends = [
      ok(sendFixture('terminal-send-enter')),
      fail('failure', 'orca_failed', 'temporary send error'),
    ]
    const timers = s.clock.pendingTimers()
    const reply = { reply_id: 'retry-denial', kind: 'deny' as const, by: 'user', text: '停止写入' }
    const failed = s.run.deliver?.(reply).then(
      () => false,
      () => true,
    )
    await until(() => s.clock.pendingTimers() > timers, 'Esc 后等待')
    s.orca.reads = [ok(tuiFixture('question'))]
    await s.clock.advance(1_000)
    expect(await failed).toBe(true)
    await s.poll(2)
    expect(await s.run.deliver?.(reply)).toBe('delivered')
    expect(
      (sends(s) as Array<{ text?: string }>).filter((input) => input.text === '\u001b'),
    ).toHaveLength(1)
    await s.run.cancel()
  })

  test('2：Esc 后文字已接受但等待回执时出现新弹窗，不补发裸 Enter', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await s.poll(2)
    const noTurn = ok(sendFixture('terminal-send-no-turn'))
    s.orca.sends = [ok(sendFixture('terminal-send-enter')), noTurn, noTurn, noTurn]
    const original = s.orca.terminalSend.bind(s.orca)
    s.orca.terminalSend = async (input) => {
      const result = await original(input)
      if (input.retryRequest) s.orca.reads = [ok(approvalCommand('git push --force origin HEAD'))]
      return result
    }
    const timers = s.clock.pendingTimers()
    const delivery = s.run.deliver?.({
      reply_id: 'no-extra-enter',
      kind: 'deny',
      text: '停止',
      by: 'user',
    })
    await until(() => s.clock.pendingTimers() > timers, 'Esc 后等待')
    s.orca.reads = [ok(tuiFixture('question'))]
    await s.clock.advance(1_000)
    expect(await delivery).toEqual({ outcome: 'dropped', reason: 'round_closed', attempted: true })
    expect(
      (sends(s) as Array<{ text?: string; enter?: boolean }>).filter(
        (input) => input.enter && input.text === undefined,
      ),
    ).toEqual([])
    await s.run.cancel()
  })

  test('4：未知 reply_id 的旧 blocked seq 不能首次绑定到新弹窗', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await s.poll(2)
    s.orca.reads = [ok(tuiFixture('working'))]
    await s.poll()
    s.orca.reads = [ok(approvalCommand('git push --force origin HEAD'))]
    await s.poll(2)
    expect(
      await s.run.deliver?.({
        reply_id: 'unseen-old-approval',
        block_seq: 1,
        kind: 'approve',
        by: 'user',
      }),
    ).toEqual({ outcome: 'dropped', reason: 'round_closed' })
    expect(sends(s)).toEqual([])
    expect(
      await s.run.deliver?.({
        reply_id: 'new-approval',
        block_seq: 2,
        kind: 'approve',
        by: 'user',
      }),
    ).toBe('delivered')
    expect(sends(s)).toEqual([{ handle: s.orca.handle, enter: true }])
    await s.run.cancel()
  })
})

describe('第一轮审查回归', () => {
  test('1：外批后重投旧回复，下一回合的新弹窗不会收到 Enter 或 Esc', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await s.poll(2)
    const reply = { reply_id: 'old-approval', kind: 'approve' as const, by: 'user' }
    s.orca.reads = [ok(executed(`• Ran ${APPROVAL_COMMAND}`))]
    await expect(s.run.deliver?.(reply)).resolves.toMatchObject({
      outcome: 'dropped',
      reason: 'round_closed',
    })
    s.orca.reads = [ok(approvalCommand('git push --force origin HEAD'))]
    await expect(s.run.deliver?.(reply)).resolves.toMatchObject({
      outcome: 'dropped',
      reason: 'round_closed',
    })
    await s.poll(2)
    await expect(s.run.deliver?.(reply)).resolves.toMatchObject({
      outcome: 'dropped',
      reason: 'round_closed',
    })
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('2：终端直接拒绝后继续工作，恢复 running 并关闭旧授权回合', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await s.poll(2)
    s.orca.reads = [ok(executed(`✗ You did not approve codex to run ${APPROVAL_COMMAND}`))]
    await s.poll()
    expect(s.activity.filter((a) => a.data?.resumed)).toHaveLength(1)
    expect(outside(s)).toHaveLength(0)
    await expect(
      s.run.deliver?.({ reply_id: 'late-denial', kind: 'deny', by: 'user' }),
    ).resolves.toMatchObject({ outcome: 'dropped', reason: 'round_closed' })
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('1：拒绝的 Esc 已发送，随后出现新弹窗时理由不能被当作批准输入', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await s.poll(2)
    const timers = s.clock.pendingTimers()
    const delivery = s.run.deliver?.({
      reply_id: 'deny-old',
      kind: 'deny',
      text: '停止',
      by: 'user',
    })
    const rejected = delivery?.then(
      (r) => typeof r === 'object' && r.outcome === 'dropped',
      () => false,
    )
    await until(() => s.clock.pendingTimers() > timers, 'Esc 后等待')
    s.orca.reads = [ok(approvalCommand('git push --force origin HEAD'))]
    await s.clock.advance(1_000)
    expect(await rejected).toBe(true)
    expect(sends(s)).toEqual([{ handle: s.orca.handle, text: '\u001b' }])
    await s.run.cancel()
  })

  test('3：同一批准文本出现第二次，保留历史行也会检测到新增证据', async () => {
    const line = `✔ You approved codex to run ${APPROVAL_COMMAND} this time`
    const approval = tuiFixture('approval')
    const s = await start({}, (o) =>
      o.reads.push(ok({ ...approval, tail: [line, ...approval.tail] })),
    )
    await s.poll(2)
    s.orca.reads = [
      ok({ ...executed(line), tail: [line, line, '• Working (1s • esc to interrupt)'] }),
    ]
    await s.poll()
    expect(outside(s)).toHaveLength(1)
    await s.run.cancel()
  })

  test('4：开出 PR 后终端退出，保留原有 done 判定且不报告删除', async () => {
    const s = await start({}, (o) => o.show('no-output'))
    s.gh.prs = [
      {
        url: 'https://github.com/example-user/raindown/pull/7',
        number: 7,
        state: 'OPEN',
        isCrossRepository: false,
        headRefName: 'example-user/t-orca-1',
      },
    ]
    await s.poll()
    expect(await s.run.done).toMatchObject({ ok: true, data: { outcome: 'done' } })
    expect(outside(s)).toHaveLength(0)
  })

  test('4：送达时发现终端退出，先按 PR 完成而不是报告会话删除', async () => {
    const s = await start({}, (o) => o.show('question'))
    await s.poll(2)
    s.gh.prs = [
      {
        url: 'https://github.com/example-user/raindown/pull/8',
        number: 8,
        state: 'OPEN',
        isCrossRepository: false,
        headRefName: 'example-user/t-orca-1',
      },
    ]
    s.orca.reads = [ok(tuiFixture('no-output'))]
    expect(
      await s.run.deliver?.({ reply_id: 'exit-reply', kind: 'text', text: '继续', by: 'user' }),
    ).toBe('not_running')
    expect(await s.run.done).toMatchObject({ ok: true, data: { outcome: 'done' } })
    expect(outside(s)).toHaveLength(0)
  })

  test('4：重新挂接时终端已退出，先查 PR，不新建终端', async () => {
    const first = await start({}, (o) => o.show('working'))
    await ready(first)
    const home = h as OrcaHome
    await first.run.cancel()
    const second = await start({}, (o) => o.show('no-output'), { home })
    second.gh.prs = [
      {
        url: 'https://github.com/example-user/raindown/pull/9',
        number: 9,
        state: 'MERGED',
        isCrossRepository: false,
        headRefName: 'example-user/t-orca-1',
      },
    ]
    await ready(second)
    expect(await second.run.done).toMatchObject({ ok: true, data: { outcome: 'done' } })
    expect(second.orca.ops('terminalCreate')).toHaveLength(0)
    expect(outside(second)).toHaveLength(0)
  })

  test('5：Raindown 按键已尝试但回执超时，后续批准记录不算带外', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await s.poll(2)
    s.orca.sends = [fail('failure', 'orca_failed', '回执超时')]
    await expect(
      s.run.deliver?.({ reply_id: 'timeout-approval', kind: 'approve', by: 'user' }),
    ).rejects.toThrow()
    s.orca.reads = [ok(executed(`✔ You approved codex to run ${APPROVAL_COMMAND} this time`))]
    await s.poll()
    expect(outside(s)).toHaveLength(0)
    expect(s.activity.filter((a) => a.data?.resumed)).toHaveLength(1)
    await s.run.cancel()
  })

  test('6：真实 stale 夹具只触发重试，不能推断会话已删除', async () => {
    const s = await start({}, (o) => o.reads.push(staleHandle()))
    await s.poll(2)
    expect(s.outcome()).toBeUndefined()
    expect(outside(s)).toHaveLength(0)
    await s.run.cancel()
  })

  test('gh 查询失败不影响为当前授权建立回合并送达用户回复', async () => {
    const s = await start({}, (o) => o.show('approval'))
    s.gh.error = 'gh unavailable'
    await s.poll(2)
    expect(idles(s)[0]?.data?.hint).toMatchObject({ gh_error: 'gh unavailable' })
    expect(
      await s.run.deliver?.({ reply_id: 'approve-without-gh', kind: 'approve', by: 'user' }),
    ).toBe('delivered')
    expect(sends(s)).toEqual([{ handle: s.orca.handle, enter: true }])
    await s.run.cancel()
  })

  test.each(['EACCES', 'EIO'])('8：目录检查 %s 时暂停并重试，不结束或报告删除', async (code) => {
    let inaccessible = false
    const s = await start({}, (o) => o.show('working'), {
      directoryStat(path) {
        if (inaccessible && path === h?.worktree)
          throw Object.assign(new Error('暂时无法访问'), { code })
        return statSync(path)
      },
    })
    await ready(s)
    inaccessible = true
    await s.clock.advance(POLL)
    expect(s.orca.ops('terminalRead')).toHaveLength(0)
    expect(s.outcome()).toBeUndefined()
    expect(outside(s)).toHaveLength(0)
    inaccessible = false
    await s.clock.advance(POLL)
    await until(() => s.orca.ops('terminalRead').length > 0, '目录恢复后继续读取')
    await s.run.cancel()
  })
})

describe('带外操作', () => {
  for (const line of [
    `✓ You approved codex to run ${APPROVAL_COMMAND} this time`,
    `✔ You approved codex to run ${APPROVAL_COMMAND} every time this session`,
    `• Ran ${APPROVAL_COMMAND}`,
  ]) {
    test(`待批后出现明确记录：${line}`, async () => {
      const s = await start({}, (o) => o.show('approval'))
      await s.poll(2)
      expect(idles(s)).toHaveLength(1)
      s.orca.reads = [ok(executed(line))]
      await s.poll(2)
      expect(outside(s)).toHaveLength(1)
      expect(outside(s)[0]?.data?.out_of_band).toMatchObject({
        id: expect.any(String),
        kind: 'approval_outside_raindown',
        command: APPROVAL_COMMAND,
      })
      expect(s.activity.filter((a) => a.data?.resumed)).toHaveLength(1)
      await s.run.cancel()
    })
  }

  test('历史批准、其他命令与模糊 working 不算外部批准', async () => {
    const history = `• Ran ${APPROVAL_COMMAND}`
    const approval = tuiFixture('approval')
    const s = await start({}, (o) =>
      o.reads.push(ok({ ...approval, tail: [history, ...approval.tail] })),
    )
    await s.poll(2)
    s.orca.reads = [ok(executed(history))]
    await s.poll()
    s.orca.reads = [ok(executed(`• Ran ${APPROVAL_COMMAND} --other`))]
    await s.poll()
    expect(outside(s)).toHaveLength(0)
    expect(s.activity.filter((a) => a.data?.resumed)).toHaveLength(1)
    await s.run.cancel()
  })

  test('Raindown 批准送达后出现执行行：没有带外事件', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await s.poll(2)
    expect(await s.run.deliver?.({ reply_id: 'r-approved', kind: 'approve', by: 'user' })).toBe(
      'delivered',
    )
    s.orca.reads = [ok(executed(`• Ran ${APPROVAL_COMMAND}`))]
    await s.poll()
    expect(outside(s)).toHaveLength(0)
    await s.run.cancel()
  })

  test('外部批准发生在轮询与回复之间：送达前记录带外，不发回复、不误报 delivered', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await s.poll(2)
    s.orca.reads = [ok(executed(`• Ran ${APPROVAL_COMMAND}`))]
    await expect(
      s.run.deliver?.({ reply_id: 'r-late', kind: 'approve', by: 'user' }),
    ).resolves.toMatchObject({ outcome: 'dropped', reason: 'round_closed' })
    expect(sends(s)).toHaveLength(0)
    expect(outside(s)).toHaveLength(1)
    expect(s.activity.filter((a) => a.data?.resumed)).toHaveLength(1)
    await s.run.cancel()
  })

  test('还未上报待批就出现执行行：没有带外事件', async () => {
    const s = await start({}, (o) => o.reads.push(ok(executed(`• Ran ${APPROVAL_COMMAND}`))))
    await s.poll()
    expect(outside(s)).toHaveLength(0)
    await s.run.cancel()
  })
})

describe('目录不存在', () => {
  test('监控时 worktree 被删：不再读终端，记录删除并 blocked', async () => {
    const s = await start()
    await ready(s)
    rmSync(h?.worktree ?? '', { recursive: true })
    await s.poll()
    expect(s.orca.ops('terminalRead')).toHaveLength(0)
    expect(s.outcome()).toMatchObject({
      ok: true,
      data: {
        outcome: 'blocked',
        reason: 'workdir_missing',
        message: `工作目录不存在：${h?.worktree}`,
      },
    })
    expect(outside(s)[0]?.data?.out_of_band).toMatchObject({ kind: 'session_removed' })
  })

  test('deliver 时 worktree 被普通文件替换：不读终端也不发送', async () => {
    const s = await start()
    await ready(s)
    rmSync(h?.worktree ?? '', { recursive: true })
    writeFileSync(h?.worktree ?? '', 'not a directory')
    expect(await s.run.deliver?.({ reply_id: 'r-missing', kind: 'approve', by: 'user' })).toBe(
      'not_running',
    )
    expect(s.orca.ops('terminalRead')).toHaveLength(0)
    expect(sends(s)).toHaveLength(0)
    expect(await s.run.done).toMatchObject({
      ok: true,
      data: { outcome: 'blocked', reason: 'workdir_missing' },
    })
  })

  test('保存 state 中的 worktree 丢失：保留记录，不静默新建', async () => {
    const first = await start()
    await ready(first)
    const home = h as OrcaHome
    await first.run.cancel()
    rmSync(home.worktree, { recursive: true })
    const second = await start({}, undefined, { home })
    await ready(second)
    expect(second.orca.ops('worktreeCreate')).toHaveLength(0)
    expect(second.orca.ops('terminalCreate')).toHaveLength(0)
    expect(second.outcome()).toMatchObject({
      ok: true,
      data: { outcome: 'blocked', reason: 'workdir_missing' },
    })
  })

  test('登记 repo 被删：不调用 gh，说明目录不存在', async () => {
    const s = await start({}, (o) => o.show('question'))
    await ready(s)
    rmSync(h?.repo ?? '', { recursive: true })
    await s.poll(2)
    expect(s.gh.calls).toHaveLength(0)
    expect(s.outcome()).toMatchObject({
      ok: true,
      data: {
        outcome: 'blocked',
        reason: 'workdir_missing',
        message: `工作目录不存在：${h?.repo}`,
      },
    })
  })
})

describe('PR 直通的输入（harness-neutral 8.4）', () => {
  const input = (seq: number): DeliveredInput => ({
    input_seq: seq,
    source: 'pr',
    pr_event_seq: 100 + seq,
    text: `## 订阅的 PR 有新动态\n<untrusted-pr-event>\n{"text": "第 ${seq} 条"}\n</untrusted-pr-event>`,
  })

  test('只在回合结束后的普通空闲输入框送入，按 input_seq 幂等；送达不掩盖之后的停下', async () => {
    const s = await start({}, (o) => o.show('working'))
    await ready(s)
    s.orca.reads.splice(0)
    s.orca.show('stopped-statement')
    expect(await s.run.inject?.(input(1))).toBe('delivered')
    expect(await s.run.inject?.(input(1))).toBe('delivered')
    const text = input(1).text.replace(/\n/g, ' ')
    expect(sends(s)).toEqual([{ handle: s.orca.handle, text, enter: true, waitSubmitS: 10 }])
    await s.run.cancel()
    expect(await s.run.inject?.(input(2))).toBe('not_running')
  })

  test('Codex 已退出回到 shell、滚动历史中残留输入框：PR 输入与文字回复都不敲进 shell', async () => {
    const shell = [
      '• Done.',
      '',
      '› Ask Codex to do anything',
      '  ? for shortcuts',
      '',
      'Token usage: total=1',
      'user@host repo %',
    ]
    const s = await start({}, (o) => o.show('working'))
    await ready(s)
    s.orca.reads = [ok({ handle: s.orca.handle, status: 'running', tail: shell })]
    expect(await s.run.inject?.(input(8))).toBe('not_now')
    const reply = { reply_id: 'r-shell', kind: 'text' as const, text: 'rm -rf $HOME', by: 'user' }
    expect(await s.run.deliver?.(reply)).toBe('not_running')
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('Codex 停在提问时不送入（不能替用户回答），已上报停下后也不送入', async () => {
    const s = await start({}, (o) => o.show('working'))
    await ready(s)
    s.orca.reads.splice(0)
    s.orca.show('question')
    expect(await s.run.inject?.(input(6))).toBe('not_now')
    // 连续两轮停在普通输入框后上报停下：之后即使屏幕看起来空闲也不送入。
    s.orca.reads.splice(0)
    s.orca.show('stopped-statement')
    await s.poll(3)
    expect(idles(s).length).toBeGreaterThan(0)
    expect(await s.run.inject?.(input(7))).toBe('not_now')
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test.each(['approval', 'trust-prompt', 'working'])(
    '终端停在 %s 时不送入（不能当作批准或信任确认的按键）',
    async (screen) => {
      const s = await start({}, (o) => o.show('question'))
      await ready(s)
      s.orca.reads.splice(0)
      s.orca.show(screen)
      expect(await s.run.inject?.(input(3))).toBe('not_now')
      expect(sends(s)).toEqual([])
      await s.run.cancel()
    },
  )

  test('授权回合打开或文字回复已发 Esc 尚未送完时不送入（不能替用户回答）', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await ready(s)
    await s.poll(3)
    // 已上报授权停下：回合打开。即使屏幕随后显示普通输入框，也不把输入打进去。
    const state = JSON.parse(
      readFileSync(join(h?.home ?? '', 'state/tasks/t-orca-1/orca.json'), 'utf8'),
    )
    expect(state.approval_round?.closed).toBe(false)
    s.orca.reads.splice(0)
    s.orca.show('question')
    expect(await s.run.inject?.(input(5))).toBe('not_now')
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('如实声明不支持运行中注入：PR 输入排队到下一次派工', () => {
    expect(
      createCodexOrcaExecutor({ home: '/unused' }).adapterCapabilities.inject_while_running,
    ).toBe(false)
  })

  test('派工输入：新终端从 spec 读取（放在恢复提示之后），不再另行送入', async () => {
    const recovery: TaskRecovery = { previous_end: { attempt: 1, reason: 'done' }, prs: [] }
    const s = await start({}, (o) => o.show('question'), { recovery, inputs: [input(4)] })
    await ready(s)
    await s.poll(2)
    const spec = readFileSync(join(h?.home ?? '', 'state/tasks/t-orca-1/spec.md'), 'utf8')
    expect(spec).toStartWith(`${renderRecoveryPrompt(recovery)}\n\n${renderTaskInputs([input(4)])}`)
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })
})

describe('外层 seatbelt（worker-credential-isolation 4.2）', () => {
  const HUB = 'http://127.0.0.1:7477'
  // 施加时写类角色在本任务的独立 clone 中运行（审查第一轮，第一步方案）：登记仓库先变成 git 仓库（临时 HOME）。
  const gitEnvs = new Map<string, NodeJS.ProcessEnv>()
  const on = (home: OrcaHome): SeatbeltOptions => {
    let gitEnv = gitEnvs.get(home.repo)
    if (!gitEnv) {
      gitEnv = initTestRepo(home.repo)
      gitEnvs.set(home.repo, gitEnv)
    }
    return { enforce: true, platform: 'darwin', userHome: join(home.root, 'user'), env: {}, gitEnv }
  }
  const cloneOf = (home: OrcaHome) => join(home.home, 'run/tasks/t-orca-1/repo')
  const created = (s: Started) =>
    s.orca.ops('terminalCreate').map((c) => (c.input as { command: string }).command)
  /** 把临时目录换成占位符，便于快照。 */
  const norm = (text: string | undefined, home: OrcaHome) =>
    (text ?? '').split(realpathSync(home.root)).join('<root>').split(home.root).join('<root>')
  const token = (home: OrcaHome, lease: string) =>
    writeLeaseTokenFile(home.home, 't-orca-1', lease, 'fake-lease-token-not-a-secret')

  test('开关关闭：终端命令与之前逐字节一致（快照），不生成配置', async () => {
    const home = orcaHome()
    const leaseTokenFile = await token(home, 'l-1')
    const s = await start({}, (o) => o.show('working'), { home, leaseTokenFile, hubUrl: HUB })
    await ready(s)
    const [command] = created(s)
    expect(norm(command, home)).toMatchSnapshot()
    expect(command).not.toContain('sandbox-exec')
    expect(existsSync(join(home.home, 'state/tasks/t-orca-1/isolation.sb'))).toBe(false)
    const state = JSON.parse(
      readFileSync(join(home.home, 'state/tasks/t-orca-1/orca.json'), 'utf8'),
    )
    expect(state).not.toHaveProperty('isolation_layer')
    await s.run.cancel()
  })
  test('开关打开、bypass：在独立 clone 中启动，Orca worktree 只作终端宿主；sandbox-exec 只包住 codex，任务说明仍由外层 shell 读取', async () => {
    const home = orcaHome()
    const leaseTokenFile = await token(home, 'l-1')
    const s = await start({}, (o) => o.show('working'), {
      home,
      leaseTokenFile,
      hubUrl: HUB,
      isolation: on(home),
    })
    await ready(s)
    const [command] = created(s)
    const profile = join(home.home, 'state/tasks/t-orca-1/isolation.sb')
    const clone = realpathSync(cloneOf(home))
    expect(norm(command, home)).toMatchSnapshot()
    // 顺序：cd <独立 clone> && exec env … CODEX_HOME=… /usr/bin/sandbox-exec -f <配置> codex … "$(cat spec.md)"
    expect(command).toStartWith(`cd ${clone} && exec env `)
    const sandboxAt = command?.indexOf(`/usr/bin/sandbox-exec -f ${profile} codex `) ?? -1
    expect(sandboxAt).toBeGreaterThan(command?.indexOf('CODEX_HOME=') ?? Infinity)
    expect(command?.indexOf('exec env ')).toBeLessThan(sandboxAt)
    expect(command?.indexOf('"$(cat ')).toBeGreaterThan(sandboxAt)
    expect(command).toEndWith(`"$(cat ${join(home.home, 'state/tasks/t-orca-1/spec.md')})"`)
    // 独立的 CODEX_HOME（H3）、按任务私有的临时目录（M2）、预置项目信任（M6）。
    expect(command).toContain(`CODEX_HOME=${join(home.home, 'run/tasks/t-orca-1/codex-home')} `)
    expect(command).toContain(`TMPDIR=${join(home.home, 'run/tasks/t-orca-1/tmp')} `)
    expect(command).toContain(`-c 'projects={"${clone}"={trust_level="trusted"}}'`)
    // 终端仍开在 Orca worktree（宿主）；Orca 的 setup 跳过，setup 在独立 clone 中运行。
    const createInput = s.orca.ops('terminalCreate')[0]?.input as { worktreePath: string }
    expect(createInput.worktreePath).toBe(home.worktree)
    expect((s.orca.ops('worktreeCreate')[0]?.input as { setup?: string } | undefined)?.setup).toBe(
      'skip',
    )
    expect(lstatSync(profile).mode & 0o777).toBe(0o600)
    const text = readFileSync(profile, 'utf8')
    expect(text).toContain(`(subpath ${JSON.stringify(join(clone, '.git'))})`)
    expect(text).toContain(`(subpath ${JSON.stringify(join(clone, '.git', 'config'))})`)
    expect(text).toContain(`(subpath ${JSON.stringify(join(realpathSync(home.repo), '.git'))})`)
    expect(text).toContain(`(subpath ${JSON.stringify(realpathSync(leaseTokenFile))})`)
    const state = JSON.parse(
      readFileSync(join(home.home, 'state/tasks/t-orca-1/orca.json'), 'utf8'),
    )
    expect(state).toMatchObject({
      isolation_layer: 'seatbelt',
      layout: 'sealed',
      worktree_path: clone,
      host_worktree: home.worktree,
    })
    await s.run.cancel()
  })

  test('mds（4.5，审查第一轮）：启动前记录基线并在终端运行期间 hold；任务取消（终端结束）时校验并删除基线', async () => {
    const home = orcaHome()
    // 注入的假 DARWIN_USER_CACHE_DIR，绝不碰真实的 /private/var/folders/*/C/mds。
    const cacheDir = join(home.root, 'C')
    mkdirSync(join(cacheDir, 'mds'), { recursive: true })
    writeFileSync(join(cacheDir, 'mds', 'mds.lock'), '')
    // 上一个终端（已不存在）留下的 hold 基线与运行期间的改动：启动新终端前做最后一次校验（审查第二轮）。
    await recordMdsBaseline(home.home, 't-orca-1', join(realpathSync(cacheDir), 'mds'), {
      hold: true,
    })
    writeFileSync(join(cacheDir, 'mds', 'planted.db'), 'x')
    const leaseTokenFile = await token(home, 'l-1')
    const s = await start({}, (o) => o.show('working'), {
      home,
      leaseTokenFile,
      hubUrl: HUB,
      isolation: { ...on(home), darwinUserCacheDir: cacheDir },
    })
    await ready(s)
    const profile = readFileSync(join(home.home, 'state/tasks/t-orca-1/isolation.sb'), 'utf8')
    const mds = join(realpathSync(cacheDir), 'mds')
    expect(profile).toContain(`(subpath ${JSON.stringify(mds)})`)
    expect(profile).toContain('(require-not (vnode-type REGULAR-FILE))')
    expect(existsSync(mdsBaselinePath(home.home, 't-orca-1'))).toBe(true)
    expect(mdsBaselineHeld(home.home, 't-orca-1')).toBe(true)
    expect(existsSync(join(cacheDir, 'mds', 'planted.db'))).toBe(false)
    // 旧的 hold 基线已删除，新终端用新记录的基线（旧基线会带着 planted.db 的重置标记）。
    const baseline = JSON.parse(readFileSync(mdsBaselinePath(home.home, 't-orca-1'), 'utf8'))
    expect(Object.keys(baseline.entries)).toEqual(['mds.lock'])
    // 终端运行期间的改动：任务取消（终端结束）时由执行器校验、重置并删除基线，不依赖节点的执行结束出口（4.5 试运行发现）。
    writeFileSync(join(cacheDir, 'mds', 'during.db'), 'x')
    await s.run.cancel()
    await s.run.done
    expect(mdsBaselineHeld(home.home, 't-orca-1')).toBe(false)
    expect(existsSync(mdsBaselinePath(home.home, 't-orca-1'))).toBe(false)
    expect(existsSync(join(cacheDir, 'mds', 'during.db'))).toBe(false)
    expect(existsSync(join(cacheDir, 'mds', 'mds.lock'))).toBe(true)
  })

  test('mds（4.5）：取消时关闭终端失败（终端可能仍在运行）则保留 hold 的基线，留给节点启动时处理', async () => {
    const home = orcaHome()
    // 注入的假 DARWIN_USER_CACHE_DIR，绝不碰真实的 /private/var/folders/*/C/mds。
    const cacheDir = join(home.root, 'C')
    mkdirSync(join(cacheDir, 'mds'), { recursive: true })
    writeFileSync(join(cacheDir, 'mds', 'mds.lock'), '')
    const leaseTokenFile = await token(home, 'l-1')
    const s = await start({}, (o) => o.show('working'), {
      home,
      leaseTokenFile,
      hubUrl: HUB,
      isolation: { ...on(home), darwinUserCacheDir: cacheDir },
    })
    await ready(s)
    expect(mdsBaselineHeld(home.home, 't-orca-1')).toBe(true)
    s.orca.closeResult = fail('failure', 'orca_error', 'orca terminal close 失败')
    await s.run.cancel()
    await s.run.done
    expect(existsSync(mdsBaselinePath(home.home, 't-orca-1'))).toBe(true)
    expect(mdsBaselineHeld(home.home, 't-orca-1')).toBe(true)
  })

  test('mds（审查第二轮）：节点启动时终端已不存在的 hold 基线做最后一次校验并删除；仍在运行的保留', async () => {
    const home = orcaHome()
    const cacheDir = join(home.root, 'C')
    const mds = join(cacheDir, 'mds')
    mkdirSync(mds, { recursive: true })
    writeFileSync(join(mds, 'mds.lock'), '')
    const fake = new FakeOrca(home.worktree)
    const writeState = (taskId: string, handle?: string) => {
      mkdirSync(join(home.home, 'state/tasks', taskId), { recursive: true })
      writeFileSync(
        join(home.home, 'state/tasks', taskId, 'orca.json'),
        JSON.stringify({
          repo: home.repo,
          worktree_path: home.worktree,
          branch: taskId,
          base_branch: 'origin/main',
          ...(handle ? { handle, isolation_layer: 'seatbelt' } : {}),
          replies: {},
        }),
      )
    }
    for (const t of ['t-nostate', 't-gone', 't-alive'])
      await recordMdsBaseline(home.home, t, mds, { hold: true })
    writeState('t-gone', 'term_gone')
    writeState('t-alive', fake.handle)
    // 运行期间留下的改动：最后一次校验时重置。
    writeFileSync(join(mds, 'planted.db'), 'x')
    const executor = createCodexOrcaExecutor({ home: home.home, orca: fake })
    await executor.prepare?.({ nodeId: 'n-1' })
    expect(existsSync(mdsBaselinePath(home.home, 't-nostate'))).toBe(false)
    expect(existsSync(mdsBaselinePath(home.home, 't-gone'))).toBe(false)
    expect(mdsBaselineHeld(home.home, 't-alive')).toBe(true)
    expect(existsSync(join(mds, 'planted.db'))).toBe(false)
  })

  test('开关打开但角色为 workspace-write（native 未实现）：命令不变', async () => {
    const home = orcaHome()
    writeFileSync(
      join(home.home, 'config/roles/dev.yaml'),
      'name: dev\nexecutor: codex-orca\nprompt: dev.md\npermissions:\n  approval: on-request\n  sandbox: workspace-write\n',
    )
    const s = await start({}, (o) => o.show('working'), {
      home,
      hubUrl: HUB,
      isolation: on(home),
    })
    await ready(s)
    expect(created(s)[0]).not.toContain('sandbox-exec')
    expect(existsSync(join(home.home, 'state/tasks/t-orca-1/isolation.sb'))).toBe(false)
    await s.run.cancel()
  })

  test('开关打开：升级前（共享 worktree、未隔离）启动的终端关闭，迁移到独立 clone 后以隔离方式重启', async () => {
    const first = await start({}, (o) => o.show('question'))
    await ready(first)
    const home = h
    if (!home) throw new Error('no home')
    const second = await start({}, (o) => o.show('question'), {
      home,
      hubUrl: HUB,
      isolation: on(home),
    })
    await ready(second)
    expect(second.outcome()).toBeUndefined()
    expect(second.orca.ops('terminalClose')).toHaveLength(1)
    expect(created(second)[0]).toContain('/usr/bin/sandbox-exec -f ')
    const state = JSON.parse(
      readFileSync(join(home.home, 'state/tasks/t-orca-1/orca.json'), 'utf8'),
    )
    expect(state).toMatchObject({
      layout: 'sealed',
      isolation_layer: 'seatbelt',
      worktree_path: realpathSync(cloneOf(home)),
      host_worktree: home.worktree,
    })
    await first.run.cancel()
    await second.run.cancel()
  })

  test('开关关闭后再次运行（回滚）：任务分支取回登记仓库，独立 clone 删除，回到 Orca worktree', async () => {
    const home = orcaHome()
    const first = await start({}, (o) => o.show('question'), {
      home,
      hubUrl: HUB,
      isolation: on(home),
    })
    await ready(first)
    await first.run.cancel()
    expect(existsSync(cloneOf(home))).toBe(true)
    const second = await start({}, (o) => o.show('question'), { home, hubUrl: HUB })
    await ready(second)
    expect(second.outcome()).toMatchObject({
      ok: true,
      data: { outcome: 'failed', result: { reason: 'isolation_layout_changed' } },
    })
    expect(existsSync(cloneOf(home))).toBe(false)
    const state = JSON.parse(
      readFileSync(join(home.home, 'state/tasks/t-orca-1/orca.json'), 'utf8'),
    )
    expect(state.worktree_path).toBe(home.worktree)
    expect(state).not.toHaveProperty('layout')
  })

  test('开关打开：派工绑定已变化的未隔离旧终端关闭后以隔离方式重启（审查第一轮 L1）', async () => {
    const home = orcaHome()
    const first = await start({}, (o) => o.show('question'), {
      home,
      leaseTokenFile: await token(home, 'l-1'),
      hubUrl: HUB,
    })
    await ready(first)
    const second = await start({}, (o) => o.show('question'), {
      home,
      leaseTokenFile: await token(home, 'l-2'),
      hubUrl: HUB,
      isolation: on(home),
    })
    await ready(second)
    expect(second.outcome()).toBeUndefined()
    expect(second.orca.ops('terminalClose')).toHaveLength(1)
    expect(created(second)[0]).toContain('/usr/bin/sandbox-exec -f ')
    const state = JSON.parse(
      readFileSync(join(home.home, 'state/tasks/t-orca-1/orca.json'), 'utf8'),
    )
    expect(state.isolation_layer).toBe('seatbelt')
    await first.run.cancel()
    await second.run.cancel()
  })

  test('开关打开：已隔离的终端照常重挂接；派工绑定变化后新起的终端同样施加', async () => {
    const home = orcaHome()
    const first = await start({}, (o) => o.show('question'), {
      home,
      leaseTokenFile: await token(home, 'l-1'),
      hubUrl: HUB,
      isolation: on(home),
    })
    await ready(first)
    const same = await start({}, (o) => o.show('question'), {
      home,
      leaseTokenFile: join(home.home, 'run/tasks/t-orca-1/dispatch-tokens/l-1.token'),
      hubUrl: HUB,
      isolation: on(home),
    })
    await ready(same)
    expect(same.orca.ops('terminalCreate')).toEqual([])
    expect(same.activity.some((a) => a.text?.includes('接着使用已有的终端'))).toBe(true)
    await same.run.cancel()
    const relaunched = await start({}, (o) => o.show('question'), {
      home,
      leaseTokenFile: await token(home, 'l-2'),
      hubUrl: HUB,
      isolation: on(home),
    })
    await ready(relaunched)
    expect(relaunched.orca.ops('terminalClose')).toHaveLength(1)
    expect(created(relaunched)[0]).toContain('/usr/bin/sandbox-exec -f ')
    await first.run.cancel()
    await relaunched.run.cancel()
  })

  test('开关打开但无法计算隔离清单（派工令牌不在任务私有目录）：不启动 Codex', async () => {
    const home = orcaHome()
    const s = await start({}, (o) => o.show('working'), {
      home,
      leaseTokenFile: join(home.root, 'elsewhere.token'),
      hubUrl: HUB,
      isolation: on(home),
    })
    await ready(s)
    expect(s.outcome()).toMatchObject({
      ok: true,
      data: { outcome: 'failed', result: { reason: 'isolation_token_outside_task_dir' } },
    })
    expect(s.orca.ops('terminalCreate')).toEqual([])
  })
})
