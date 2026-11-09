import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  type DeliveredReply,
  ok,
  operations,
  type Result,
  type Role,
  renderRecoveryPrompt,
  renderTaskInputs,
  renderWorkerTaskPrompt,
  type TaskContract,
  type TaskRecovery,
  taskResult,
} from '@raindown/core'
import { DEFAULT_ROLE_FILES } from '../../core/src/role-templates.ts'
import {
  type ClaudeQueryFn,
  type ClaudeSdkExecutorOptions,
  classifyClaudeSdk,
  createClaudeSdkExecutor,
  type ExecutorOutcome,
  type NodeClock,
  projectInstructions,
  RAINDOWN_MCP_AUTO_ALLOWED,
  RAINDOWN_MCP_AUTO_ALLOWED_PENDING,
  READ_ROLE_TOOLS,
  readRoleMayUse,
  SUPERVISOR_MCP_AUTO_ALLOWED,
  summarizeToolInput,
  systemClock,
} from '../src/index.ts'
import { type Bench, bench, ManualClock } from './harness.ts'
import { waitFor } from './wait.ts'

/**
 * claude-sdk 执行器（add-m1-executors 3.1 / 3.2；executor-claude-sdk spec 全部场景）。
 * SDK 的 `query()` 换成模拟实现：脚本以异步生成器产出 SDK 消息，读取流式输入，调用 canUseTool。
 * 绝不加载真实 SDK、绝不调用 Claude。
 */

// ---------------------------------------------------------------------------
// 模拟 SDK
// ---------------------------------------------------------------------------

interface MockIO {
  options: Options
  /** 读取流式输入的下一条用户消息（文本）；输入关闭时为 undefined。 */
  nextUser(): Promise<string | undefined>
  /** 以 SDK 的方式调用 canUseTool。 */
  ask(
    tool: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PermissionResult | null>
}
type Script = (io: MockIO) => AsyncGenerator<SDKMessage, void>

interface MockState {
  calls: Options[]
  prompts: string[]
  permissions: Array<PermissionResult | null>
  closed: number
  executed: string[]
  /** 调用顺序：abort（abortController 被中止）、end（脚本结束）、close。 */
  events: string[]
}

function mockSdk(script: Script): { query: ClaudeQueryFn; state: MockState } {
  const state: MockState = {
    calls: [],
    prompts: [],
    permissions: [],
    closed: 0,
    executed: [],
    events: [],
  }
  let n = 0
  const query: ClaudeQueryFn = ({ prompt, options }) => {
    state.calls.push(options)
    options.abortController?.signal.addEventListener('abort', () => state.events.push('abort'))
    const it = prompt[Symbol.asyncIterator]()
    const io: MockIO = {
      options,
      async nextUser() {
        const r = await it.next()
        if (r.done) return undefined
        const msg = r.value as SDKUserMessage
        const c = msg.message.content
        const t = typeof c === 'string' ? c : JSON.stringify(c)
        state.prompts.push(t)
        return t
      },
      async ask(tool, input, signal) {
        const canUseTool = options.canUseTool
        if (!canUseTool) throw new Error('没有 canUseTool')
        n++
        const r = await canUseTool(tool, input, {
          signal: signal ?? options.abortController?.signal ?? new AbortController().signal,
          toolUseID: `tu-${n}`,
          requestId: `rq-${n}`,
        })
        state.permissions.push(r)
        if (r?.behavior === 'allow') state.executed.push(String(r.updatedInput?.command ?? tool))
        return r
      },
    }
    const inner = script(io)
    const gen = (async function* () {
      try {
        yield* inner
      } finally {
        state.events.push('end')
      }
    })()
    return {
      [Symbol.asyncIterator]: () => gen,
      close() {
        state.closed++
        state.events.push('close')
      },
    }
  }
  return { query, state }
}

// event_get 不在 worker 自动放行清单：按 #82 的绑定规则处理（只读角色经 readRoleMayUse 按绑定放行）。
const WORKER_TOOLS = ['raindown_report', 'task_show', 'kb_search', 'kb_get', 'kb_query']
const SID = 's-review-1'
const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage
const init = (sid = SID) =>
  msg({
    type: 'system',
    subtype: 'init',
    session_id: sid,
    model: 'claude-opus-5-5',
    permissionMode: 'auto',
  })
const say = (text: string, sid = SID) =>
  msg({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: sid,
  })
const toolUse = (name: string, input: Record<string, unknown>, sid = SID) =>
  msg({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu', name, input }] },
    parent_tool_use_id: null,
    session_id: sid,
  })
const result = (over: Record<string, unknown> = {}) =>
  msg({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '（SDK 的结果文本）',
    num_turns: 3,
    duration_ms: 1200,
    duration_api_ms: 900,
    total_cost_usd: 0.42,
    usage: {},
    modelUsage: {
      'claude-opus-5-5': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        webSearchRequests: 0,
        costUSD: 0.42,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
    permission_denials: [],
    stop_reason: 'end_turn',
    queued_turn_count: 0,
    uuid: 'u-1',
    session_id: SID,
    ...over,
  })

// ---------------------------------------------------------------------------
// 角色与测试台
// ---------------------------------------------------------------------------

const reviewer = (permissions: Record<string, unknown> = {}): Role => ({
  name: 'reviewer',
  executor: 'claude-sdk',
  prompt: '只读审查 PR。',
  model: 'claude-opus-5-5',
  permissions: {
    permissionMode: 'auto',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash(gh pr review:*)'],
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    ...permissions,
  },
})
const roleResolver =
  (role: Role) =>
  async (name: string): Promise<Result<Role>> =>
    name === role.name
      ? ok(role)
      : { ok: false, error: { kind: 'failure', code: 'unknown_role', message: `没有角色 ${name}` } }

/** 执行器构造时还没有测试台的虚拟时钟：用一个转发的时钟。 */
function deferredClock() {
  let target: NodeClock = systemClock
  const clock: NodeClock = {
    now: () => target.now(),
    setTimeout: (cb, ms) => target.setTimeout(cb, ms),
  }
  return { clock, set: (c: NodeClock) => (target = c) }
}

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

async function sdkBench(
  script: Script,
  role: Role = reviewer(),
  extra: Partial<ClaudeSdkExecutorOptions> = {},
) {
  const { query, state } = mockSdk(script)
  const dc = deferredClock()
  const executor = createClaudeSdkExecutor({
    home: '/tmp/raindown-home-not-used',
    clock: dc.clock,
    query,
    resolveRole: roleResolver(role),
    git: { run: async () => ({ code: 1, stdout: '', stderr: '无分支' }) },
    ...extra,
  })
  const b = await bench({ executors: [executor] })
  dc.set(b.clock)
  current = b
  const cwd = join(b.home, 'repo')
  mkdirSync(cwd, { recursive: true })
  const create = (over: Record<string, unknown> = {}) =>
    b.create({
      goal: '审查 PR #42',
      role: 'reviewer',
      executor: 'claude-sdk',
      cwd,
      ...over,
    })
  return { b, state, create }
}

const reply = (b: Bench, id: string, body: unknown) =>
  b.api<{ ok: boolean; error?: { code: string } }>('POST', `/v1/tasks/${id}/reply`, body)

const MIN = 60_000

// ---------------------------------------------------------------------------
// 按角色运行 / 注入 Raindown MCP / 结果
// ---------------------------------------------------------------------------

describe('按角色运行', () => {
  test('长原文读取指针使用实际 SDK 执行上下文的任务 id', async () => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const task = contract({
      origin_instruction: {
        seq: 12,
        text: '原文预览',
        chars: 5000,
        read: { op: 'event_get', args: { seq: 12 } },
      },
    })
    const ex = createClaudeSdkExecutor({
      home: '/tmp/raindown-home-not-used',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const outcome = await ex.run(task, ctx({ taskId: 't-real' })).done
    expect(outcome.ok && outcome.data.outcome).toBe('done')
    expect(state.prompts[0]).toContain(renderWorkerTaskPrompt(task, 't-real'))
    expect(task.origin_instruction?.read?.op).toBe('event_get')
  })

  test('写任务不上报工作目录的当前分支：claude-sdk 不拥有任务分支', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raindown-claude-branch-'))
    const repo = join(home, 'repo')
    const reports: unknown[] = []
    const gitCalls: (readonly string[])[] = []
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    try {
      mkdirSync(repo)
      mkdirSync(join(home, 'config', 'workspaces'), { recursive: true })
      writeFileSync(
        join(home, 'config', 'workspaces', 'demo.yaml'),
        `id: demo\nname: 测试\ndescription: 分支报告\nkind: product\nrepos:\n  - ${repo}\n`,
      )
      const ex = createClaudeSdkExecutor({
        home,
        query,
        resolveRole: roleResolver(reviewer()),
        git: {
          run: async (_cmd, args) => {
            gitCalls.push(args)
            return {
              code: 0,
              stdout: args.includes('symbolic-ref') ? 'main\n' : `${repo}\n`,
              stderr: '',
            }
          },
        },
      })
      const run = ex.run(
        contract({ cwd: repo }),
        ctx({
          cwd: repo,
          env: { PATH: process.env.PATH },
          reportBranch: async (report: unknown) => {
            reports.push(report)
          },
        }),
      )
      expect(await run.done).toMatchObject({ ok: true, data: { outcome: 'done' } })
      expect(state.calls).toHaveLength(1)
      expect(reports).toEqual([])
      expect(gitCalls.some((args) => args.includes('symbolic-ref'))).toBe(false)
      expect(createClaudeSdkExecutor({ home, query }).adapterCapabilities.raindown_mcp).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('审查一个 PR：在仓库目录运行，账本可见活动，结果含审查摘要、会话 id 与费用', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield init()
      yield toolUse('Bash', { command: 'gh pr diff 42' })
      yield say('正在阅读 diff')
      yield say('审查结论：改动正确，建议补一条回归测试。')
      yield result()
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'done')
    expect(t.result).toMatchObject({
      summary: '审查结论：改动正确，建议补一条回归测试。',
      executor: 'claude-sdk',
      session: SID,
      cost: {
        usd: 0.42,
        turns: 3,
        duration_ms: 1200,
        input_tokens: 115,
        output_tokens: 50,
      },
    })
    const texts = b.ledger.taskActivity(id).map((a) => a.text ?? '')
    expect(texts).toContain('→ Bash：gh pr diff 42')
    expect(texts).toContain('正在阅读 diff')
    expect(texts.some((x) => x.includes(`Claude 会话 ${SID} 已启动`))).toBe(true)

    const o = state.calls[0]
    expect(o?.cwd).toBe(join(b.home, 'repo'))
    // 子进程环境来自节点（executorEnv），不含中枢凭证。
    expect(o?.env?.PATH).toBe(process.env.PATH)
    expect(o?.env?.RAINDOWN_ACTOR).toBe('reviewer')
    expect(o?.env && 'RAINDOWN_HUB_TOKEN' in o.env).toBe(false)
    expect(o?.model).toBe('claude-opus-5-5')
    expect(o?.settingSources).toEqual(['project'])
    expect(o?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: expect.stringContaining('只读审查 PR。'),
    })
    expect(o?.permissionMode).toBe('auto')
    expect(o?.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit'])
    expect(o?.allowedTools).toContain('Bash(gh pr review:*)')
    expect(o?.resume).toBeUndefined()
    // 首条用户消息是任务说明。
    expect(state.prompts[0]).toContain('审查 PR #42')
    expect(state.prompts[0]).toContain(join(b.home, 'repo'))
  })

  test('默认 reviewer 角色模板：权限模式、允许与禁止列表原样传给 SDK，模型默认 claude-opus-5-5', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raindown-claude-sdk-'))
    try {
      const dir = join(home, 'config', 'roles')
      mkdirSync(dir, { recursive: true })
      for (const name of ['reviewer.yaml', 'reviewer.md']) {
        writeFileSync(join(dir, name), DEFAULT_ROLE_FILES[name] ?? '')
      }
      // 去掉 model 的变体，验证默认模型。
      writeFileSync(
        join(dir, 'plain.yaml'),
        'name: plain\nexecutor: claude-sdk\nprompt: 只看不改。\n',
      )
      const { query, state } = mockSdk(async function* (io) {
        await io.nextUser()
        yield say('好')
        yield result()
      })
      const ex = createClaudeSdkExecutor({
        home,
        query,
        raindownCommand: ['bun', '/x/raindown.ts'],
      })
      for (const role of ['reviewer', 'plain']) {
        const run = ex.run(contract({ role }), ctx())
        for await (const _ of run.activity) {
        }
        const r = await run.done
        expect(r.ok && r.data.outcome).toBe('done')
      }
      const [rev, plain] = state.calls
      expect(rev?.model).toBe('claude-opus-5-5')
      expect(rev?.permissionMode).toBe('default')
      expect(rev?.settingSources).toEqual([])
      expect(rev?.allowedTools).toEqual([
        'Read',
        'Glob',
        'Grep',
        'Bash(gh pr comment:*)',
        'Bash(gh pr review:*)',
        ...WORKER_TOOLS.map((n) => `mcp__raindown__${n}`),
      ])
      expect(rev?.disallowedTools).toEqual(['NotebookEdit'])
      expect(rev?.hooks?.PreToolUse).toHaveLength(1)
      expect(String((rev?.systemPrompt as { append?: string } | undefined)?.append)).toContain(
        '可以新建或修改文档文件',
      )
      expect(rev?.mcpServers?.raindown).toEqual({
        type: 'stdio',
        command: 'bun',
        args: ['/x/raindown.ts', 'mcp', '--actor', 'reviewer', '--task', 't-1'],
        env: {
          RAINDOWN_HOME: home,
          FLOW_HOME: home,
          RAINDOWN_ACTOR: 'reviewer',
          FLOW_ACTOR: 'reviewer',
        },
      })
      expect(plain?.model).toBe('claude-opus-5-5')
      // 角色没写：默认 default，设置来源默认 ['project']。
      expect(plain?.permissionMode).toBe('default')
      expect(plain?.settingSources).toEqual(['project'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('角色不存在或 permissions 不合法：任务 failed，不启动 SDK', async () => {
    const { query, state } = mockSdk(async function* () {})
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer({ permissionMode: 'yolo' })),
    })
    const a = await ex.run(contract({ role: 'ghost' }), ctx()).done
    expect(a.ok && a.data.outcome === 'failed' && a.data.result.reason).toBe('unknown_role')
    const b2 = await ex.run(contract(), ctx()).done
    expect(b2.ok && b2.data.outcome === 'failed' && b2.data.result.reason).toBe('invalid_role')
    expect(state.calls).toHaveLength(0)
  })
})

describe('注入 Raindown MCP', () => {
  test('worker MCP 绑定角色与任务，只自动放行派工工具', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield toolUse('mcp__raindown__task_show', { id: 't-1' })
      yield say('已记录 journal')
      yield result()
    })
    const id = await create()
    await b.until(id, (t) => t.status === 'done')
    const raindown = state.calls[0]?.mcpServers?.raindown
    expect(raindown).toMatchObject({
      type: 'stdio',
      command: 'raindown',
      args: ['mcp', '--actor', 'reviewer', '--task', id],
    })
    const allowed = state.calls[0]?.allowedTools ?? []
    expect(allowed.filter((name) => name.startsWith('mcp__raindown__'))).toEqual(
      WORKER_TOOLS.map((name) => `mcp__raindown__${name}`),
    )
    // 不再整体放行 raindown 服务；创建、取消任务等不在清单里。
    expect(allowed).not.toContain('mcp__raindown')
    expect(allowed).not.toContain('mcp__raindown__event_get')
    for (const tool of ['task_create', 'task_cancel', 'task_reply', 'kb_proposals_accept']) {
      expect(allowed).not.toContain(`mcp__raindown__${tool}`)
    }
  })

  test('放行清单与 raindown 的实际工具名一致；PENDING 只列尚未实现的 supervisor 操作', () => {
    const names = new Set(operations.map((op) => op.name))
    for (const n of RAINDOWN_MCP_AUTO_ALLOWED) expect(names.has(n)).toBe(true)
    expect(RAINDOWN_MCP_AUTO_ALLOWED as readonly string[]).not.toContain('event_get')
    expect(readRoleMayUse('mcp__raindown__event_get', false)).toBe(false)
    for (const binding of ['task', 'wake'] as const) {
      expect(
        readRoleMayUse(
          'mcp__raindown__event_get',
          false,
          { name: 'raindown', source: 'dynamic' },
          binding,
        ),
      ).toBe(true)
      expect(
        readRoleMayUse(
          'mcp__raindown__event_get',
          false,
          { name: 'foreign', source: 'dynamic' },
          binding,
        ),
      ).toBe(false)
    }
    for (const n of SUPERVISOR_MCP_AUTO_ALLOWED) {
      expect(names.has(n) || RAINDOWN_MCP_AUTO_ALLOWED_PENDING.includes(n)).toBe(true)
    }
    // 已实现的名字不能留在 PENDING 中；PENDING 只能是 supervisor 清单的子集。
    for (const n of RAINDOWN_MCP_AUTO_ALLOWED_PENDING) {
      expect(names.has(n)).toBe(false)
      expect(SUPERVISOR_MCP_AUTO_ALLOWED as readonly string[]).toContain(n)
    }
    // tasks 4.1：supervisor 专属工具不在通用清单，只读角色也不认；建任务、请求合并仍走策略。
    for (const n of SUPERVISOR_MCP_AUTO_ALLOWED) {
      expect(RAINDOWN_MCP_AUTO_ALLOWED as readonly string[]).not.toContain(n)
      expect(readRoleMayUse(`mcp__raindown__${n}`, false)).toBe(false)
    }
    for (const n of ['task_create', 'pr_merge_request']) {
      // 4.8：pr_merge_request 已是真实工具，但不自动放行，supervisor 调用时仍走策略审批。
      expect(names.has(n)).toBe(true)
      expect(RAINDOWN_MCP_AUTO_ALLOWED as readonly string[]).not.toContain(n)
      expect(SUPERVISOR_MCP_AUTO_ALLOWED as readonly string[]).not.toContain(n)
    }
  })

  test('worker 创建任务需要审批：task_create 进 canUseTool，批准前不创建', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      const r = await io.ask('mcp__raindown__task_create', { role: 'dev', goal: '改 main' })
      yield say(r?.behavior === 'allow' ? '已创建' : '未创建')
      yield result()
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.reason).toBe('awaiting_approval')
    expect(t.blocked?.message).toContain('mcp__raindown__task_create')
    expect(state.executed).toEqual([])
    await reply(b, id, { kind: 'deny', text: '不允许' })
    const done = await b.until(id, (t) => t.status === 'done')
    expect(done.result?.summary).toBe('未创建')
  })
})

describe('结果', () => {
  test('轮次耗尽：任务 failed，原因注明轮次上限', async () => {
    const { b, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield say('还在看')
      yield result({ subtype: 'error_max_turns', num_turns: 30, errors: [] })
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'failed')
    expect(t.result?.reason).toBe('max_turns')
    expect(t.result?.summary).toContain('最大轮次上限')
    expect(t.result?.session).toBe(SID)
  })

  test('SDK 报告执行错误：failed(sdk_error)，摘要附带错误', async () => {
    const { b, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield result({ subtype: 'error_during_execution', errors: ['API 不可用'] })
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'failed')
    expect(t.result?.reason).toBe('sdk_error')
    expect(t.result?.summary).toContain('API 不可用')
  })

  test('Claude 进程异常（迭代器抛错）：blocked(crashed)', async () => {
    const { b, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield say('开始')
      throw new Error('Claude Code process exited with code 1')
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.reason).toBe('crashed')
    expect(t.blocked?.message).toContain('exited with code 1')
  })

  test('取消：abortController 被中止并调用 close()，任务 cancelled', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield say('开始')
      await io.ask('Bash', { command: 'make deploy' })
      yield result()
    })
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    await b.api('POST', `/v1/tasks/${id}/cancel`, {})
    await b.until(id, (t) => t.status === 'cancelled', 2 * MIN)
    expect(state.closed).toBeGreaterThanOrEqual(1)
    expect(state.calls[0]?.abortController?.signal.aborted).toBe(true)
    expect(state.executed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 工具审批挂起等待
// ---------------------------------------------------------------------------

describe('工具审批挂起等待', () => {
  test('带 path 的 MCP 工具仍等待现有审批，不能被未知文件工具兜底拒绝或自动放行', async () => {
    const { b, state, create } = await sdkBench(
      async function* (io) {
        await io.nextUser()
        await io.ask('mcp__external__read', { path: 'docs/review.md' })
        yield result()
      },
      reviewer({ writable_paths: ['**/*.md'] }),
    )
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    expect(state.executed).toEqual([])
    await reply(b, id, { kind: 'approve' })
    await b.until(id, (t) => t.status === 'done')
    expect(state.permissions[0]).toMatchObject({ behavior: 'allow' })
  })

  test('writable_paths 先于策略与用户审批：文档直接放行，其余写入直接拒绝', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'raindown-reviewer-docs-'))
    let prechecks = 0
    try {
      const { query, state } = mockSdk(async function* (io) {
        await io.nextUser()
        for (const path of [
          'docs/reviews/new.md',
          'src/design.mdx',
          'src/code.ts',
          '../outside.md',
        ]) {
          await io.ask('Write', { file_path: path })
        }
        await io.ask('NotebookEdit', { notebook_path: 'docs/review.ipynb' })
        yield result()
      })
      const ex = createClaudeSdkExecutor({
        home: repo,
        query,
        resolveRole: roleResolver(
          reviewer({
            disallowedTools: ['NotebookEdit'],
            writable_paths: ['docs/**', '**/*.md', '**/*.mdx'],
          }),
        ),
      })
      const run = ex.run(
        contract(),
        ctx({
          cwd: repo,
          precheck: async () => {
            prechecks++
            return { allow: true, level: 'auto', actions: ['file.write'] }
          },
        }),
      )
      const r = await run.done
      expect(r.ok && r.data.outcome).toBe('done')
      expect(state.permissions.map((p) => p?.behavior)).toEqual([
        'allow',
        'allow',
        'deny',
        'deny',
        'deny',
      ])
      expect(prechecks).toBe(0)
      // 允许工具不等于实际写入，不能据此生成产物。
      expect(r.ok && 'result' in r.data && r.data.result?.artifacts).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('SDK 提前放行时 PreToolUse 仍执行边界；只将成功的文件操作去重写入 artifacts', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'raindown-reviewer-hooks-'))
    try {
      const { query } = mockSdk(async function* (io) {
        await io.nextUser()
        const pre = io.options.hooks?.PreToolUse?.[0]?.hooks[0]
        const post = io.options.hooks?.PostToolUse?.[0]?.hooks[0]
        if (!pre || !post) throw new Error('缺少文件工具 hooks')
        expect(io.options.hooks?.PreToolUse?.[0]).not.toHaveProperty('matcher')
        const base = {
          session_id: SID,
          transcript_path: '',
          cwd: '/sdk-changed-cwd',
          tool_use_id: 'write-1',
        }
        const opts = { signal: new AbortController().signal }
        for (const [name, path, decision] of [
          ['Write', 'docs/review.md', 'allow'],
          ['Edit', 'src/code.ts', 'deny'],
          ['MultiEdit', '.git/report.md', 'deny'],
          ['NotebookEdit', 'docs/review.md', 'deny'],
          ['FutureWrite', 'docs/review.md', 'deny'],
          ['Write', 'docs/AGENTS.md', 'deny'],
        ]) {
          const r = await pre(
            {
              ...base,
              hook_event_name: 'PreToolUse',
              tool_name: name as string,
              tool_input: { file_path: path },
            },
            'write-1',
            opts,
          )
          expect(r).toMatchObject({ hookSpecificOutput: { permissionDecision: decision } })
          if (decision === 'allow')
            expect(r).toMatchObject({
              hookSpecificOutput: {
                updatedInput: {
                  file_path: join(realpathSync(repo), 'docs/review.md'),
                },
              },
            })
        }
        for (const tool_name of ['Read', 'Glob', 'Grep', 'LSP', 'mcp__external__read']) {
          expect(
            await pre(
              {
                ...base,
                hook_event_name: 'PreToolUse',
                tool_name,
                tool_input: { path: 'docs/review.md' },
              },
              'read-1',
              opts,
            ),
          ).toEqual({})
        }
        const input = {
          ...base,
          hook_event_name: 'PostToolUse' as const,
          tool_name: 'Write',
          tool_input: { file_path: join(realpathSync(repo), 'docs/review.md') },
          tool_response: { success: true },
        }
        // 模拟成功工具的 PostToolUse；拒绝、失败及仅批准的调用没有此事件。
        await post(input, 'write-1', opts)
        await post(input, 'write-1', opts)
        yield result()
      })
      const ex = createClaudeSdkExecutor({
        home: repo,
        query,
        resolveRole: roleResolver(
          reviewer({
            permissionMode: 'bypassPermissions',
            allowedTools: ['Edit', 'Write'],
            disallowedTools: ['NotebookEdit'],
            writable_paths: ['docs/**', '**/*.md', '**/*.mdx'],
          }),
        ),
      })
      const r = await ex.run(contract(), ctx({ cwd: repo })).done
      expect(r.ok && r.data.outcome).toBe('done')
      expect(r.ok && 'result' in r.data && r.data.result?.artifacts).toEqual([
        { kind: 'file', ref: join(realpathSync(repo), 'docs/review.md') },
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('审批后继续：不在允许列表的 Bash 命令 → blocked(awaiting_approval) → --approve → 命令执行、回到 running', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield say('需要跑一下测试')
      const r = await io.ask('Bash', { command: 'bun test --coverage' })
      yield say(r?.behavior === 'allow' ? '测试通过' : '没能运行测试')
      yield result()
    })
    const id = await create()
    const blocked = await b.until(id, (t) => t.status === 'blocked')
    expect(blocked.blocked).toMatchObject({
      reason: 'awaiting_approval',
      lease_held: true,
      session: SID,
    })
    expect(blocked.blocked?.message).toContain('bun test --coverage')
    expect(blocked.blocked?.tail?.some((l) => l.includes('bun test --coverage'))).toBe(true)

    expect((await reply(b, id, { kind: 'approve' })).ok).toBe(true)
    const t = await b.until(id, (t) => t.status === 'done')
    expect(state.executed).toEqual(['bun test --coverage'])
    expect(state.permissions[0]).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'bun test --coverage' },
    })
    expect(t.result?.summary).toBe('测试通过')
    const types = b.types(id)
    expect(types.indexOf('task.unblocked')).toBeGreaterThan(types.indexOf('task.replied'))
  })

  test('--deny 附带理由：拒绝这次调用，理由交给 Claude', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      const r = await io.ask('Bash', { command: 'git push --force' })
      yield say(r?.behavior === 'deny' ? `收到拒绝：${r.message}` : '已推送')
      yield result()
    })
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    expect((await reply(b, id, { kind: 'deny', text: '不要强推' })).ok).toBe(true)
    const t = await b.until(id, (t) => t.status === 'done')
    expect(state.executed).toEqual([])
    expect(state.permissions[0]).toMatchObject({ behavior: 'deny' })
    expect((state.permissions[0] as { message: string }).message).toContain('不要强推')
    expect(t.result?.summary).toContain('不要强推')
  })

  test('审批挂起时的文字回复：拒绝这次调用，并把文字作为理由交给 Claude', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      const r = await io.ask('Bash', { command: 'rm -rf dist' })
      yield say(r?.behavior === 'deny' ? r.message : '已删除')
      yield result()
    })
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    expect((await reply(b, id, { kind: 'text', text: '先别删，改用 bun run clean' })).ok).toBe(true)
    const t = await b.until(id, (t) => t.status === 'done')
    expect(state.executed).toEqual([])
    expect(t.result?.summary).toContain('改用 bun run clean')
  })

  test('连续两次审批：第一次批准后，第二次重新上报 blocked(awaiting_approval)', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      await io.ask('Bash', { command: 'bun install' })
      await io.ask('Bash', { command: 'bun run build' })
      yield say('构建完成')
      yield result()
    })
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    await reply(b, id, { kind: 'approve' })
    await b.until(
      id,
      (t) => t.status === 'blocked' && (t.blocked?.message ?? '').includes('bun run build'),
      5 * MIN,
    )
    await reply(b, id, { kind: 'approve' })
    await b.until(id, (t) => t.status === 'done')
    expect(state.executed).toEqual(['bun install', 'bun run build'])
  })

  test('审批超时：超过角色设定的时限，任务 failed(approval_timeout)', async () => {
    const { b, state, create } = await sdkBench(
      async function* (io) {
        await io.nextUser()
        await io.ask('Bash', { command: 'make release' })
        yield result()
      },
      reviewer({ approval_timeout_minutes: 3 }),
    )
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    const t = await b.until(id, (t) => t.status === 'failed', 10 * MIN)
    expect(t.result?.reason).toBe('approval_timeout')
    expect(t.result?.summary).toContain('make release')
    expect(state.permissions[0]).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(state.executed).toEqual([])
  })

  test('审批说明中的工具输入经脱敏、限长', async () => {
    // 运行时拼出的令牌形状文本，不是真的密钥。
    const token = ['gh', 'p_', 'A'.repeat(36)].join('')
    const { b, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      await io.ask('Bash', {
        command: `curl -H "Authorization: Bearer ${token}" ${'x'.repeat(3000)}`,
      })
      yield result()
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.message).not.toContain(token)
    expect(t.blocked?.message).toContain('[REDACTED:')
    expect((t.blocked?.message ?? '').length).toBeLessThanOrEqual(1000)
    expect(JSON.stringify(t.blocked?.tail)).not.toContain(token)
  })
})

// ---------------------------------------------------------------------------
// 运行中的回复与会话恢复
// ---------------------------------------------------------------------------

describe('运行中的回复与会话恢复', () => {
  test.each([false, true])('恢复提示放在首条消息开头（恢复旧会话：%s）', async (resume) => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const recovery: TaskRecovery = {
      previous_end: { attempt: 1, reason: 'blocked', blocked_reason: 'crashed' },
      prs: ['https://github.com/example/repo/pull/32'],
    }
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    await ex.run(
      contract(),
      ctx({
        attempt: 2,
        recovery,
        ...(resume
          ? {
              resume: {
                session: 's-old',
                reply: { reply_id: 'r-recovery', kind: 'text', text: '继续', by: 'user' },
              },
            }
          : {}),
      }),
    ).done
    expect(state.prompts[0]).toStartWith(`${renderRecoveryPrompt(recovery)}\n\n`)
    expect(state.calls[0]?.resume).toBe(resume ? 's-old' : undefined)
  })

  test('PR 直通：派工输入放在恢复提示之后；运行中的输入推入流式输入，按 input_seq 幂等', async () => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield say('开始处理')
      const extra = await io.nextUser()
      yield say(`收到：${extra}`)
      yield result()
    })
    const recovery: TaskRecovery = { previous_end: { attempt: 1, reason: 'done' }, prs: [] }
    const dispatched = {
      input_seq: 7,
      source: 'pr' as const,
      pr_event_seq: 70,
      text: '<untrusted-pr-event>{"text": "派工时的评论"}</untrusted-pr-event>',
    }
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const run = ex.run(contract(), ctx({ attempt: 2, recovery, inputs: [dispatched] }))
    const live = {
      ...dispatched,
      input_seq: 8,
      pr_event_seq: 80,
      text: '<untrusted-pr-event>运行中的 CI 失败</untrusted-pr-event>',
    }
    const results: string[] = []
    for await (const a of run.activity) {
      if (a.kind === 'output' && a.text === '开始处理') {
        results.push(String(await run.inject?.(dispatched)))
        results.push(String(await run.inject?.(live)))
        results.push(String(await run.inject?.(live)))
      }
    }
    await run.done
    expect(state.prompts[0]).toStartWith(
      `${renderRecoveryPrompt(recovery)}\n\n${renderTaskInputs([dispatched])}\n\n`,
    )
    expect(results).toEqual(['delivered', 'delivered', 'delivered'])
    expect(state.prompts[1]).toBe(live.text)
    expect(state.prompts).toHaveLength(2)
    expect(await run.inject?.({ ...live, input_seq: 9 })).toBe('not_running')
  })

  test('无进展后的文字回复：作为用户消息推入流式输入，Claude 接着完成', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield say('要审查哪个提交范围？')
      const answer = await io.nextUser()
      yield say(`按回复处理：${answer}`)
      yield result()
    })
    const id = await create({ no_progress_minutes: 1 })
    const blocked = await b.until(id, (t) => t.status === 'blocked', 5 * MIN)
    expect(blocked.blocked?.reason).toBe('no_progress')
    expect((await reply(b, id, { kind: 'text', text: '只看最后两个提交' })).ok).toBe(true)
    const t = await b.until(id, (t) => t.status === 'done')
    expect(state.prompts[1]).toContain('只看最后两个提交')
    expect(t.result?.summary).toContain('只看最后两个提交')
  })

  test('ctx.resume 带会话 id：用 SDK 的 resume 恢复会话，首条消息是回复本身', async () => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield say('继续审查', 's-old')
      yield result({ session_id: 's-old' })
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const run = ex.run(
      contract(),
      ctx({
        resume: {
          session: 's-old',
          reply: { reply_id: 'r-1', kind: 'text', text: '看 main 分支', by: 'user' },
        },
      }),
    )
    for await (const _ of run.activity) {
    }
    const r = await run.done
    expect(state.calls[0]?.resume).toBe('s-old')
    expect(state.prompts[0]).toContain('看 main 分支')
    expect(state.prompts[0]).not.toContain('# 任务')
    expect(r.ok && r.data.outcome === 'done' && r.data.result.session).toBe('s-old')
  })

  test('ctx.resume 没有会话 id：重新开始，任务说明后附上回复', async () => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    await ex.run(
      contract(),
      ctx({ resume: { reply: { reply_id: 'r-2', kind: 'text', text: '补充说明', by: 'user' } } }),
    ).done
    expect(state.calls[0]?.resume).toBeUndefined()
    expect(state.prompts[0]).toContain('# 任务')
    expect(state.prompts[0]).toContain('补充说明')
  })

  test('deliver 按 reply_id 幂等；结束后返回 not_running', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      await io.ask('Bash', { command: 'ls' })
      await gate
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
      reannounceMs: 60_000,
    })
    const run = ex.run(contract(), ctx())
    const outcomes: ExecutorOutcome[] = []
    let awaitingApproval = false
    const pumped = (async () => {
      for await (const a of run.activity) {
        if (a.data?.idle) awaitingApproval = true
      }
    })()
    await waitFor(() => awaitingApproval, 'canUseTool 挂起审批')
    const approve: DeliveredReply = { reply_id: 'r-a', kind: 'approve', by: 'user' }
    expect(await run.deliver?.(approve)).toBe('delivered')
    expect(await run.deliver?.(approve)).toBe('delivered')
    await waitFor(() => state.permissions.length === 1, 'SDK 收到审批结果')
    expect(state.permissions).toHaveLength(1)
    release()
    const r = await run.done
    if (r.ok) outcomes.push(r.data)
    await pumped
    expect(outcomes[0]?.outcome).toBe('done')
    expect(await run.deliver?.({ reply_id: 'r-b', kind: 'text', text: 'x', by: 'user' })).toBe(
      'not_running',
    )
  })
})

describe('supervisor 档位与批准复核（D15，tasks 5.6）', () => {
  test('预检判为 supervisor：挂起审批，hint 带 decision_id；supervisor 的批准经 confirmApproval，拒收时不放行', async () => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      await io.ask('Bash', { command: 'git push origin ustclhx/t-1' })
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
      reannounceMs: 20,
    })
    const lives: unknown[] = []
    let answer = false
    const run = ex.run(
      contract(),
      ctx({
        precheck: async () => ({ allow: false, level: 'supervisor', decision_id: 9 }),
        confirmApproval: async (_reply: DeliveredReply, live: unknown) => {
          lives.push(live)
          return answer
        },
      }),
    )
    const hints: Array<Record<string, unknown>> = []
    const pumped = (async () => {
      for await (const a of run.activity) {
        if (a.data?.idle) hints.push(a.data.hint as Record<string, unknown>)
      }
    })()
    await waitFor(() => hints.length > 0, 'canUseTool 挂起审批')
    expect(hints[0]).toMatchObject({ reason: 'awaiting_approval', decision_id: 9 })
    const approve: DeliveredReply = { reply_id: 'r-s', kind: 'approve', by: 'supervisor' }
    expect(await run.deliver?.(approve)).toBe('dropped')
    expect(lives).toEqual([{ tool: 'Bash', command: 'git push origin ustclhx/t-1' }])
    expect(state.permissions).toHaveLength(0)
    // 拒收后重新上报队首，不再带 decision_id。
    const before = hints.length
    await waitFor(() => hints.length > before, '重新上报')
    expect(hints.at(-1)).not.toHaveProperty('decision_id')
    answer = true
    expect(await run.deliver?.({ ...approve, reply_id: 'r-s2' })).toBe('delivered')
    await waitFor(() => state.permissions.length === 1, 'SDK 收到审批结果')
    expect(state.permissions[0]?.behavior).toBe('allow')
    const r = await run.done
    expect(r.ok && r.data.outcome).toBe('done')
    await pumped
  })
})

describe('权限模式与设置来源', () => {
  const runOnce = async (role: Role, cwd = '/repo/demo') => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(role),
    })
    const r = await ex.run(contract(), ctx({ cwd })).done
    expect(r.ok && r.data.outcome).toBe('done')
    return state.calls[0]
  }

  test('角色显式写 auto / bypassPermissions：照原样传递（bypass 同时声明 allowDangerouslySkipPermissions）', async () => {
    expect((await runOnce(reviewer({ permissionMode: 'auto' })))?.permissionMode).toBe('auto')
    const bypass = await runOnce(reviewer({ permissionMode: 'bypassPermissions' }))
    expect(bypass?.permissionMode).toBe('bypassPermissions')
    expect(bypass?.allowDangerouslySkipPermissions).toBe(true)
    const { permissionMode: _drop, ...rest } = reviewer().permissions ?? {}
    const def = await runOnce({ ...reviewer(), permissions: rest })
    expect(def?.permissionMode).toBe('default')
    expect(def?.allowDangerouslySkipPermissions).toBeUndefined()
  })

  test('审查不受被审查仓库的设置影响：setting_sources 为 [] 时不加载设置，CLAUDE.md / AGENTS.md 以纯文本追加（限长、脱敏）', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'raindown-claude-sdk-repo-'))
    try {
      // 运行时拼出的令牌形状文本，不是真的密钥。
      const token = ['gh', 'p_', 'B'.repeat(36)].join('')
      mkdirSync(join(repo, '.claude'))
      writeFileSync(
        join(repo, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { PreToolUse: [] }, permissions: { allow: ['Bash(*)'] } }),
      )
      writeFileSync(join(repo, 'CLAUDE.md'), `本仓库用 bun。\nCI_TOKEN=${token}\n`)
      writeFileSync(join(repo, 'AGENTS.md'), `注释用中文。\n${'长'.repeat(40_000)}`)
      const o = await runOnce(reviewer({ permissionMode: 'default', setting_sources: [] }), repo)
      expect(o?.settingSources).toEqual([])
      expect(o?.permissionMode).toBe('default')
      const append = String((o?.systemPrompt as { append?: string } | undefined)?.append)
      expect(append.startsWith('只读审查 PR。')).toBe(true)
      expect(append).toContain('本仓库用 bun。')
      expect(append).toContain('注释用中文。')
      expect(append).not.toContain(token)
      expect(append).toContain('[REDACTED:')
      expect(append).not.toContain('Bash(*)')
      expect(append.length).toBeLessThan(40_000)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('setting_sources 含 project 时不另外读取约定文件；都不存在时不追加', async () => {
    const reads: string[] = []
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
      readProjectFile: async (path) => {
        reads.push(path)
        return '不应读取'
      },
    })
    await ex.run(contract(), ctx()).done
    expect(reads).toEqual([])
    expect(state.calls[0]?.settingSources).toEqual(['project'])
    expect(await projectInstructions('/nowhere', async () => undefined)).toBeUndefined()
  })
})

describe('健壮性', () => {
  test('结果到达时输入流里还有未读取的回复：继续等下一个结果，回复不丢', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { query } = mockSdk(async function* (io) {
      await io.nextUser()
      yield say('第一轮')
      await gate
      // SDK 还没读取运行中推入的回复，就报告了这一轮的结果。
      yield result({ queued_turn_count: 0 })
      const answer = await io.nextUser()
      yield say(`第二轮：${answer}`)
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const run = ex.run(contract(), ctx())
    let firstTurn = false
    const pumped = (async () => {
      for await (const a of run.activity) {
        if (a.text === '第一轮') firstTurn = true
      }
    })()
    await waitFor(() => firstTurn, 'SDK 读完首条输入并开始第一轮')
    expect(
      await run.deliver?.({ reply_id: 'r-q', kind: 'text', text: '再看 CI', by: 'user' }),
    ).toBe('delivered')
    release()
    const r = await run.done
    await pumped
    expect(r.ok && r.data.outcome === 'done' && r.data.result.summary).toContain('再看 CI')
  })

  test('审批按 tool_use_id 匹配：用户答复的请求已被中止时不套到下一条，重新上报队首', async () => {
    const clock = new ManualClock()
    const abortA = new AbortController()
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      const a = io.ask('Bash', { command: 'A' }, abortA.signal)
      const b = io.ask('Bash', { command: 'B' })
      await Promise.all([a, b])
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      clock,
      query,
      resolveRole: roleResolver(reviewer()),
      reannounceMs: 1000,
    })
    const run = ex.run(contract(), ctx())
    const idles: string[] = []
    const pumped = (async () => {
      for await (const a of run.activity) {
        const hint = a.data?.hint as { tool_use_id?: string } | undefined
        if (a.data?.idle && hint?.tool_use_id) idles.push(hint.tool_use_id)
      }
    })()
    await clock.advance(0)
    expect(idles).toEqual(['tu-1'])
    // Claude 中止了用户看到的 A；队首变成 B，但节点仍显示 A。
    abortA.abort()
    await clock.advance(0)
    expect(state.permissions[0]).toMatchObject({ behavior: 'deny', message: '已中止' })
    // 用户对 A 的批准不能落到 B 上。
    expect(await run.deliver?.({ reply_id: 'r-1', kind: 'approve', by: 'user' })).toBe('delivered')
    expect(state.executed).toEqual([])
    // 重新上报队首 B，之后的批准才作用于 B。
    await clock.advance(1000)
    expect(idles.at(-1)).toBe('tu-2')
    expect(await run.deliver?.({ reply_id: 'r-2', kind: 'approve', by: 'user' })).toBe('delivered')
    await clock.advance(0)
    const r = await run.done
    await pumped
    expect(r.ok && r.data.outcome).toBe('done')
    expect(state.executed).toEqual(['B'])
  })

  test('stderr 末尾上报前脱敏', async () => {
    const token = ['gh', 'p_', 'C'.repeat(36)].join('')
    const { query } = mockSdk(async function* (io) {
      await io.nextUser()
      io.options.stderr?.(`auth failed: --token ${token}\nfatal`)
      yield say('启动失败')
      throw new Error('Claude Code process exited with code 1')
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const run = ex.run(contract(), ctx())
    const texts: string[] = []
    for await (const a of run.activity) texts.push(a.text ?? '')
    const r = await run.done
    expect(r.ok && r.data.outcome).toBe('exited')
    expect(texts.join('\n')).not.toContain(token)
    expect(texts.some((t) => t.includes('[REDACTED:'))).toBe(true)
    expect(texts).toContain('fatal')
  })

  test('取消：先 abort，等 SDK 子进程退出后再 close（raindown MCP 孙进程随之结束）', async () => {
    const clock = new ManualClock()
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield say('开始')
      // 模拟子进程：收到 abort 后过一会儿才退出。
      await new Promise<void>((resolve) =>
        io.options.abortController?.signal.addEventListener('abort', () =>
          clock.setTimeout(resolve, 2000),
        ),
      )
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      clock,
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const run = ex.run(contract(), ctx())
    const pumped = (async () => {
      for await (const _ of run.activity) {
      }
    })()
    await clock.advance(0)
    let settled = false
    void run.done.then(() => {
      settled = true
    })
    await run.cancel()
    await clock.advance(1000)
    expect(settled).toBe(false)
    expect(state.events).toEqual(['abort'])
    await clock.advance(1000)
    const r = await run.done
    await pumped
    expect(r.ok && r.data.outcome).toBe('cancelled')
    expect(state.events).toEqual(['abort', 'end', 'close'])
  })

  test('取消：子进程 10 秒内不退出，close() 强制结束', async () => {
    const clock = new ManualClock()
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield say('开始')
      await new Promise<void>(() => {})
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      clock,
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const run = ex.run(contract(), ctx())
    void (async () => {
      for await (const _ of run.activity) {
      }
    })()
    await clock.advance(0)
    let settled = false
    void run.done.then(() => {
      settled = true
    })
    await run.cancel()
    await clock.advance(9_999)
    expect(settled).toBe(false)
    expect(state.closed).toBe(0)
    await clock.advance(1)
    const r = await run.done
    expect(r.ok && r.data.outcome).toBe('cancelled')
    expect(state.events).toEqual(['abort', 'close'])
  })

  test('结果中的 session 上限与 blocked 一致：512', () => {
    const base = { summary: 's', executor: 'claude-sdk', node_id: 'n-test' }
    expect(taskResult.safeParse({ ...base, session: 'x'.repeat(512) }).success).toBe(true)
    expect(taskResult.safeParse({ ...base, session: 'x'.repeat(513) }).success).toBe(false)
  })
})

describe('辅助函数', () => {
  test('classify 只认 idle 信号 hint 中的合法原因', () => {
    const base = { trigger: 'idle' as const, tail: [], idle_ms: 0, contract: contract() }
    expect(
      classifyClaudeSdk({
        ...base,
        hint: { reason: 'awaiting_approval', message: '等待授权：Bash', session: 's' },
      }),
    ).toEqual({ reason: 'awaiting_approval', message: '等待授权：Bash', session: 's' })
    expect(classifyClaudeSdk({ ...base, hint: { reason: 'bogus' } })).toBeNull()
    expect(classifyClaudeSdk(base)).toBeNull()
  })

  test('工具输入摘要：Bash 取命令，文件类取路径，其余取 JSON，限长', () => {
    expect(summarizeToolInput('Bash', { command: 'ls  -la\n/tmp' })).toBe('ls -la /tmp')
    expect(summarizeToolInput('Edit', { file_path: '/a/b.ts', old_string: 'x' })).toBe('/a/b.ts')
    expect(summarizeToolInput('Task', { prompt: 'hi' })).toBe('{"prompt":"hi"}')
    expect(summarizeToolInput('Bash', { command: 'y'.repeat(5000) }).length).toBeLessThanOrEqual(
      500,
    )
  })
})

// ---------------------------------------------------------------------------

function contract(over: Partial<TaskContract> = {}): TaskContract {
  return {
    goal: '审查 PR #42',
    workspace: 'ws/demo',
    role: 'reviewer',
    executor: 'claude-sdk',
    requires: [],
    timeout_s: 3600,
    ...over,
  }
}

function ctx(over: Record<string, unknown> = {}) {
  return {
    taskId: 't-1',
    attempt: 1,
    cwd: '/repo/demo',
    nodeId: 'n-test',
    signal: new AbortController().signal,
    ...over,
  }
}

test('SDK 会话覆盖继承的 RAINDOWN_ACTOR，重新过滤 token；user 角色不启动会话', async () => {
  for (const name of ['reviewer', 'user']) {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/tmp/raindown-home-not-used',
      query,
      resolveRole: roleResolver({ ...reviewer(), name }),
    })
    const run = ex.run(
      contract({ role: name }),
      ctx({
        env: { RAINDOWN_ACTOR: 'user', RAINDOWN_HUB_TOKEN: 'must-not-reach-worker' },
      }),
    )
    const outcome = await run.done
    if (name === 'user') {
      expect(outcome).toMatchObject({
        ok: true,
        data: { outcome: 'failed', result: { reason: 'invalid_actor' } },
      })
      expect(state.calls).toHaveLength(0)
    } else {
      expect(outcome.ok && outcome.data.outcome).toBe('done')
      expect(state.calls[0]?.env).toEqual({ RAINDOWN_ACTOR: 'reviewer', FLOW_ACTOR: 'reviewer' })
    }
  }
})

describe('读边界 read_scope: cwd', () => {
  test('PreToolUse 覆盖全部工具：越界与 Bash 拒绝、路径改写、与 writable_paths 同时生效、Raindown MCP 按来源豁免', async () => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), 'raindown-read-scope-sdk-')))
    const repo = join(temp, 'repo')
    const priv = join(temp, 'private')
    const home = join(temp, 'raindown-home')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    mkdirSync(priv)
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(join(repo, 'README.md'), '说明')
    writeFileSync(join(priv, 'pr.diff'), 'diff')
    writeFileSync(join(home, 'state', 'hub.token'), 'placeholder')
    try {
      const { query, state } = mockSdk(async function* (io) {
        await io.nextUser()
        const pre = io.options.hooks?.PreToolUse?.[0]?.hooks[0]
        if (!pre) throw new Error('缺少 PreToolUse hook')
        expect(io.options.hooks?.PreToolUse?.[0]).not.toHaveProperty('matcher')
        const opts = { signal: new AbortController().signal }
        const call = (
          tool_name: string,
          tool_input: unknown,
          extra: Record<string, unknown> = {},
        ) =>
          pre(
            {
              session_id: SID,
              transcript_path: '',
              cwd: repo,
              hook_event_name: 'PreToolUse',
              tool_name,
              tool_input,
              tool_use_id: 'tu',
              ...extra,
            },
            'tu',
            opts,
          )
        type Out = {
          hookSpecificOutput?: {
            permissionDecision?: string
            updatedInput?: Record<string, unknown>
          }
        }
        const decision = (r: unknown) => (r as Out).hookSpecificOutput?.permissionDecision
        const updated = (r: unknown) => (r as Out).hookSpecificOutput?.updatedInput
        // Spec 场景：读取中枢 token、用 Glob 越界。
        for (const [tool, input] of [
          ['Read', { file_path: join(home, 'state/hub.token') }],
          ['Read', { file_path: '~/raindown-home/state/hub.token' }],
          ['Glob', { pattern: '/Users/x/.ssh/*' }],
          ['Glob', { pattern: '*', path: '~' }],
          ['Bash', { command: 'cat ~/.ssh/id_rsa' }],
          ['WebFetch', { url: 'https://example.com', prompt: 'x' }],
          ['FutureRead', { source_path: 'README.md' }],
          ['Write', { file_path: join(temp, 'x.md'), content: '' }],
          ['Write', { file_path: 'src/a.ts', content: '' }],
        ] as const)
          expect(decision(await call(tool, input))).toBe('deny')
        expect(decision(await call('Read', { file_path: 'README.md' }, { cwd: temp }))).toBe('deny')
        // 检查出错（这里是读取输入时抛错）按拒绝处理。
        const hostile = new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('boom')
            },
          },
        )
        expect(decision(await call('Read', hostile))).toBe('deny')
        // 写白名单内写入：放行，路径为真实绝对路径。
        const w = await call('Write', { file_path: 'docs/r.md', content: '' })
        expect(decision(w)).toBe('allow')
        expect(updated(w)?.file_path).toBe(join(repo, 'docs/r.md'))
        // 读边界通过时不作决定，只改写输入，交还 SDK 权限流程。
        const r = await call('Read', { file_path: 'README.md' })
        expect(decision(r)).toBeUndefined()
        expect(updated(r)).toEqual({ file_path: join(repo, 'README.md') })
        expect(updated(await call('Read', { file_path: join(priv, 'pr.diff') }))?.file_path).toBe(
          join(priv, 'pr.diff'),
        )
        expect(updated(await call('Grep', { pattern: 'x' }))).toEqual({
          pattern: 'x',
          path: repo,
          glob: '!.*',
        })
        // Raindown MCP：名称与来源都对得上才豁免。
        const token = { path: join(home, 'state/hub.token') }
        expect(
          await call('mcp__raindown__kb_get', token, {
            mcp_server: { name: 'raindown', source: 'dynamic' },
          }),
        ).toEqual({})
        expect(decision(await call('mcp__raindown__kb_get', token))).toBe('deny')
        expect(
          decision(
            await call('mcp__raindown__kb_get', token, {
              mcp_server: { name: 'raindown', source: 'project' },
            }),
          ),
        ).toBe('deny')
        // canUseTool 同样兜底拒绝；缺少 mcpServer 的 Raindown 工具也不豁免。
        expect(await io.ask('Read', { file_path: join(home, 'state/hub.token') })).toMatchObject({
          behavior: 'deny',
        })
        expect(await io.ask('mcp__raindown__kb_get', token)).toMatchObject({ behavior: 'deny' })
        yield result()
      })
      const ex = createClaudeSdkExecutor({
        home,
        query,
        resolveRole: roleResolver(
          reviewer({
            allowedTools: ['Read', 'Glob', 'Grep'],
            disallowedTools: ['NotebookEdit'],
            read_scope: 'cwd',
            writable_paths: ['docs/**'],
          }),
        ),
      })
      const r = await ex.run(contract(), ctx({ cwd: repo, readScope: { privateDir: priv } })).done
      expect(r.ok && r.data.outcome).toBe('done')
      expect(state.calls[0]?.hooks?.PreToolUse).toHaveLength(1)
      expect(state.calls[0]?.env).toMatchObject({
        CLAUDE_CODE_GLOB_HIDDEN: 'false',
        CLAUDE_CODE_GLOB_NO_IGNORE: 'false',
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('只设 read_scope 时也安装 PreToolUse；不设任何边界时不安装 hooks、不改 env；非法取值使任务 failed', async () => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    for (const perms of [{ read_scope: 'cwd' }, {}]) {
      const ex = createClaudeSdkExecutor({
        home: '/nonexistent',
        query,
        resolveRole: roleResolver(reviewer(perms)),
      })
      const r = await ex.run(contract(), ctx()).done
      expect(r.ok && r.data.outcome).toBe('done')
    }
    expect(state.calls[0]?.hooks?.PreToolUse).toHaveLength(1)
    expect(state.calls[1]?.hooks).toBeUndefined()
    expect(state.calls[1]?.env).not.toHaveProperty('CLAUDE_CODE_GLOB_HIDDEN')
    const bad = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer({ read_scope: 'home' })),
    })
    const r = await bad.run(contract(), ctx()).done
    expect(r.ok && r.data.outcome === 'failed' && r.data.result.reason).toBe('invalid_role')
  })
})

// ---------------------------------------------------------------------------
// supervisor 会话绑定（add-m1-supervisor 5.3；executor-claude-sdk "supervisor 会话绑定"）
// ---------------------------------------------------------------------------

describe('supervisor 会话绑定', () => {
  /** 测试用的唤醒 token（形如中枢签发的 fwk_ token，不是真实凭证）。 */
  const WAKE = `fwk_${'w'.repeat(43)}`
  const SUP_PERMS = {
    setting_sources: [],
    read_scope: 'cwd',
    allowedTools: ['Read', 'Grep', 'Glob'],
    disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  }
  const supervisorRole = (permissions: Record<string, unknown> = SUP_PERMS): Role => ({
    name: 'supervisor',
    kind: 'supervisor',
    executor: 'claude-sdk',
    prompt: '你是 supervisor。',
    permissions,
  })
  const wakeContract = (
    origin: 'instruction' | 'reply' = 'instruction',
    workspace = 'ws/product-res',
  ) =>
    contract({
      goal: '处理唤醒',
      workspace,
      role: 'supervisor',
      inputs: { wake: { origin, generation: 1, events: [] } },
    } as Partial<TaskContract>)

  /** 临时 raindown-home 中的唤醒 token 文件与任务目录（互不包含）。 */
  function files() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'raindown-sup-sdk-')))
    const home = join(root, 'raindown-home')
    const repo = join(root, 'repo')
    mkdirSync(join(home, 'state', 'wake'), { recursive: true })
    mkdirSync(repo)
    const tokenFile = join(home, 'state', 'wake', 't-1.l-1.token')
    writeFileSync(tokenFile, `${WAKE}\n`, { mode: 0o600 })
    // 另一个 raindown-home 的 state/wake 符号链接到 repo 内的目录。
    const linkedHome = join(root, 'linked-home')
    mkdirSync(join(repo, '.wake'))
    mkdirSync(join(linkedHome, 'state'), { recursive: true })
    symlinkSync(join(repo, '.wake'), join(linkedHome, 'state', 'wake'))
    const linkedTokenFile = join(linkedHome, 'state', 'wake', 't-1.l-1.token')
    writeFileSync(linkedTokenFile, `${WAKE}\n`, { mode: 0o600 })
    mkdirSync(join(repo, '..wake'))
    const dotdotTokenFile = join(repo, '..wake', 't-1.l-1.token')
    writeFileSync(dotdotTokenFile, `${WAKE}\n`, { mode: 0o600 })
    return {
      root,
      home,
      repo,
      tokenFile,
      linkedTokenFile,
      dotdotTokenFile,
      done: () => rmSync(root, { recursive: true, force: true }),
    }
  }

  test('注入 --workspace --task、RAINDOWN_WORKSPACE、RAINDOWN_TASK_ID 与 RAINDOWN_HUB_TOKEN_FILE；argv、env、活动与结果都不含 token', async () => {
    const f = files()
    try {
      const { query, state } = mockSdk(async function* (io) {
        await io.nextUser()
        // 会话读不到 token：read_scope 下 Bash 被拒，Read token 文件被拒。
        const pre = io.options.hooks?.PreToolUse?.[0]?.hooks[0]
        if (!pre) throw new Error('缺少 PreToolUse hook')
        const call = async (
          tool_name: string,
          tool_input: unknown,
          mcp_server?: { name: string; source: string },
        ) =>
          (
            (await pre(
              {
                session_id: SID,
                transcript_path: '',
                cwd: f.repo,
                hook_event_name: 'PreToolUse',
                tool_name,
                tool_input,
                ...(mcp_server ? { mcp_server } : {}),
                tool_use_id: 'tu',
              },
              'tu',
              { signal: new AbortController().signal },
            )) as { hookSpecificOutput?: { permissionDecision?: string } }
          ).hookSpecificOutput?.permissionDecision
        expect(await call('Bash', { command: 'ps eww' })).toBe('deny')
        expect(await call('Read', { file_path: f.tokenFile })).toBe('deny')
        expect(
          await call(
            'mcp__raindown__event_get',
            { seq: 1 },
            { name: 'raindown', source: 'dynamic' },
          ),
        ).not.toBe('deny')
        expect(
          await call(
            'mcp__raindown__event_get',
            { seq: 1 },
            { name: 'foreign', source: 'dynamic' },
          ),
        ).toBe('deny')
        yield say('完成')
        yield result()
      })
      const ex = createClaudeSdkExecutor({
        home: f.home,
        query,
        resolveRole: roleResolver(supervisorRole()),
        raindownCommand: ['bun', '/x/raindown.ts'],
      })
      const run = ex.run(wakeContract(), {
        ...ctx({
          taskId: 't-1',
          cwd: f.repo,
          env: { PATH: '/usr/bin', RAINDOWN_HUB_TOKEN: 'leak', RAINDOWN_HUB_TOKEN_FILE: '/leak' },
        }),
        wakeTokenFile: f.tokenFile,
      })
      const activities: unknown[] = []
      for await (const a of run.activity) activities.push(a)
      const done = await run.done
      expect(done.ok && done.data.outcome).toBe('done')
      const o = state.calls[0]
      expect(o?.mcpServers?.raindown).toEqual({
        type: 'stdio',
        command: 'bun',
        args: [
          '/x/raindown.ts',
          'mcp',
          '--actor',
          'supervisor',
          '--workspace',
          'ws/product-res',
          '--task',
          't-1',
        ],
        env: {
          RAINDOWN_HOME: f.home,
          FLOW_HOME: f.home,
          RAINDOWN_ACTOR: 'supervisor',
          FLOW_ACTOR: 'supervisor',
          RAINDOWN_WORKSPACE: 'ws/product-res',
          RAINDOWN_TASK_ID: 't-1',
          RAINDOWN_HUB_TOKEN_FILE: f.tokenFile,
          FLOW_WORKSPACE: 'ws/product-res',
          FLOW_TASK_ID: 't-1',
          FLOW_HUB_TOKEN_FILE: f.tokenFile,
        },
      })
      // 会话进程的 env 不含任何中枢凭证或 token 文件路径，但带绑定信息。
      expect(o?.env).not.toHaveProperty('RAINDOWN_HUB_TOKEN')
      expect(o?.env).not.toHaveProperty('RAINDOWN_HUB_TOKEN_FILE')
      expect(o?.env).not.toHaveProperty('FLOW_HUB_TOKEN')
      expect(o?.env).not.toHaveProperty('FLOW_HUB_TOKEN_FILE')
      expect(o?.env).toMatchObject({
        RAINDOWN_ACTOR: 'supervisor',
        FLOW_ACTOR: 'supervisor',
        FLOW_TASK_ID: 't-1',
        FLOW_WORKSPACE: 'ws/product-res',
        RAINDOWN_WORKSPACE: 'ws/product-res',
        RAINDOWN_TASK_ID: 't-1',
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      })
      // 与只读角色一样锁定：只用注入的 MCP、内置工具白名单。
      expect(o?.strictMcpConfig).toBe(true)
      expect(o?.tools).toEqual([...READ_ROLE_TOOLS])
      // token 不出现在 argv（MCP 配置整体）、env、提示词、活动与结果中。
      const visible = JSON.stringify([
        o?.mcpServers,
        o?.env,
        o?.systemPrompt,
        state.prompts,
        activities,
        done,
      ])
      expect(visible).not.toContain('fwk_')
      // supervisor 专属工具只在这里自动放行；task_create 仍走审批。
      for (const n of SUPERVISOR_MCP_AUTO_ALLOWED)
        expect(o?.allowedTools).toContain(`mcp__raindown__${n}`)
      expect(o?.allowedTools).toContain('mcp__raindown__brief_update')
      expect(o?.allowedTools).toContain('mcp__raindown__event_get')
      expect(o?.allowedTools).not.toContain('mcp__raindown__task_create')
    } finally {
      f.done()
    }
  })

  test('reply 唤醒：MCP 加 --reply-only', async () => {
    const f = files()
    try {
      const { query, state } = mockSdk(async function* (io) {
        await io.nextUser()
        yield result()
      })
      const ex = createClaudeSdkExecutor({
        home: f.home,
        query,
        resolveRole: roleResolver(supervisorRole()),
      })
      const r = await ex.run(wakeContract('reply'), {
        ...ctx({ taskId: 't-7', cwd: f.repo }),
        wakeTokenFile: f.tokenFile,
      }).done
      expect(r.ok && r.data.outcome).toBe('done')
      expect(
        (state.calls[0]?.mcpServers?.raindown as { args: string[] } | undefined)?.args,
      ).toEqual([
        'mcp',
        '--actor',
        'supervisor',
        '--workspace',
        'ws/product-res',
        '--task',
        't-7',
        '--reply-only',
      ])
    } finally {
      f.done()
    }
  })

  test('注入前的核对：不满足时任务 failed，不启动 SDK', async () => {
    const f = files()
    try {
      const { query, state } = mockSdk(async function* () {})
      const cases: Array<[Role, TaskContract, Record<string, unknown>, string]> = [
        // 没有 token 文件。
        [supervisorRole(), wakeContract(), {}, 'wake_token_missing'],
        // supervisor 角色缺 read_scope、可写、加载项目设置。
        [
          supervisorRole({ ...SUP_PERMS, read_scope: undefined }),
          wakeContract(),
          { wakeTokenFile: f.tokenFile },
          'supervisor_role_not_read',
        ],
        [
          supervisorRole({ ...SUP_PERMS, allowedTools: ['Bash'] }),
          wakeContract(),
          { wakeTokenFile: f.tokenFile },
          'supervisor_role_not_read',
        ],
        [
          supervisorRole({ ...SUP_PERMS, setting_sources: ['project'] }),
          wakeContract(),
          { wakeTokenFile: f.tokenFile },
          'supervisor_role_not_read',
        ],
        // 合同 workspace 不合法。
        [
          supervisorRole(),
          wakeContract('instruction', 'ws/Bad'),
          { wakeTokenFile: f.tokenFile },
          'invalid_workspace',
        ],
        // token 文件落在 cwd 或任务私有目录内（会话可读）。
        [
          supervisorRole(),
          wakeContract(),
          { wakeTokenFile: f.tokenFile, cwd: f.home },
          'wake_token_unsafe',
        ],
        [
          supervisorRole(),
          wakeContract(),
          { wakeTokenFile: f.tokenFile, readScope: { privateDir: join(f.home, 'state') } },
          'wake_token_unsafe',
        ],
        // state/wake 是指向 cwd 内的符号链接：按真实路径判定为会话可读。
        [
          supervisorRole(),
          wakeContract(),
          { wakeTokenFile: f.linkedTokenFile },
          'wake_token_unsafe',
        ],
        // cwd 下名为 `..x` 的目录仍在 cwd 内（不能按 `..` 前缀误判为外面）。
        [
          supervisorRole(),
          wakeContract(),
          { wakeTokenFile: f.dotdotTokenFile },
          'wake_token_unsafe',
        ],
        // 不是 supervisor 角色却有 token 文件。
        [reviewer(), contract(), { wakeTokenFile: f.tokenFile }, 'wake_token_unexpected'],
      ]
      for (const [role, c, over, reason] of cases) {
        const ex = createClaudeSdkExecutor({ home: f.home, query, resolveRole: roleResolver(role) })
        const r = await ex.run(c, { ...ctx({ cwd: f.repo }), ...over }).done
        expect(r.ok && r.data.outcome === 'failed' && r.data.result.reason).toBe(reason)
        expect(JSON.stringify(r)).not.toContain('fwk_')
      }
      expect(state.calls).toHaveLength(0)
    } finally {
      f.done()
    }
  })

  test('其他角色：绑定当前任务，不放行 supervisor 专属工具', async () => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/tmp/raindown-home-x',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const r = await ex.run(contract(), ctx({ leaseTokenFile: '/private/task.token' })).done
    expect(r.ok && r.data.outcome).toBe('done')
    expect(state.calls[0]?.mcpServers?.raindown).toEqual({
      type: 'stdio',
      command: 'raindown',
      args: ['mcp', '--actor', 'reviewer', '--task', 't-1'],
      env: {
        RAINDOWN_LEASE_TOKEN_FILE: '/private/task.token',
        RAINDOWN_HOME: '/tmp/raindown-home-x',
        FLOW_HOME: '/tmp/raindown-home-x',
        RAINDOWN_ACTOR: 'reviewer',
        FLOW_ACTOR: 'reviewer',
      },
    })
    for (const n of SUPERVISOR_MCP_AUTO_ALLOWED)
      expect(state.calls[0]?.allowedTools).not.toContain(`mcp__raindown__${n}`)
  })

  test('任务绑定：中枢地址随派工令牌交给 MCP，任务绑定会话不读 config/hub.yaml', async () => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/tmp/raindown-home-x',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const r = await ex.run(
      contract(),
      ctx({ leaseTokenFile: '/private/task.token', hubUrl: 'http://127.0.0.1:7477' }),
    ).done
    expect(r.ok && r.data.outcome).toBe('done')
    expect(state.calls[0]?.mcpServers?.raindown).toMatchObject({
      env: {
        RAINDOWN_LEASE_TOKEN_FILE: '/private/task.token',
        RAINDOWN_HUB_URL: 'http://127.0.0.1:7477',
      },
    })
  })
})
