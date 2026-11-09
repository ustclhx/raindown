import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { ok, type Result, type Role, type TaskContract, taskResult } from '@raindown/core'
import {
  type ClaudeQueryFn,
  type ClaudeSdkExecutorOptions,
  cleanupStaleReviews,
  createClaudeSdkExecutor,
  type ExecutorContext,
  type ExecutorOutcome,
  legacyReviewRoot,
  READ_ROLE_TOOLS,
  REVIEW_DIFF_FILE,
  readRoleMayUse,
  reviewDir as reviewDirOf,
  reviewMetaPath,
} from '../src/index.ts'
import { fakeGh, gitEnv, PR_URL, sh, type TempRepo, tempRepo } from './github-helpers.ts'

/**
 * claude-sdk 审查准备与结构化输出（add-m1-supervisor 5.2；executor-claude-sdk "审查任务的准备与结构化输出"；
 * pr-acceptance "审查结论由执行器把关"），以及只读角色的执行器强制（5.7）。
 * 模拟 SDK 的 query()，本地临时仓库，注入的假 gh：绝不调用真实 Claude、gh 或远端。
 */

interface Io {
  options: Options
  first: string
  ask(tool: string, input: Record<string, unknown>): Promise<PermissionResult | null>
}
type Script = (io: Io) => AsyncGenerator<SDKMessage, void>

const SID = 's-review'
const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage
const say = (text: string) =>
  msg({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: SID,
  })
const resultMsg = (over: Record<string, unknown> = {}) =>
  msg({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    num_turns: 2,
    duration_ms: 10,
    duration_api_ms: 5,
    total_cost_usd: 0.1,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    stop_reason: 'end_turn',
    queued_turn_count: 0,
    uuid: 'u',
    session_id: SID,
    ...over,
  })

function mockQuery(script: Script) {
  const calls: Options[] = []
  const query: ClaudeQueryFn = ({ prompt, options }) => {
    calls.push(options)
    const gen = (async function* () {
      const it = prompt[Symbol.asyncIterator]()
      const r = await it.next()
      const c = (r.value as SDKUserMessage | undefined)?.message.content
      const first = typeof c === 'string' ? c : JSON.stringify(c)
      let n = 0
      yield* script({
        options,
        first,
        ask: async (tool, input) => {
          const can = options.canUseTool
          if (!can) throw new Error('没有 canUseTool')
          n++
          return can(tool, input, {
            signal: new AbortController().signal,
            toolUseID: `tu-${n}`,
            requestId: `rq-${n}`,
          })
        },
      })
    })()
    return { [Symbol.asyncIterator]: () => gen, close() {} }
  }
  return { query, calls }
}

const prReviewer = (over: Partial<Role> = {}): Role => ({
  name: 'pr-reviewer',
  kind: 'read',
  executor: 'claude-sdk',
  prompt: '只读审查 PR。',
  permissions: {
    permissionMode: 'default',
    setting_sources: [],
    read_scope: 'cwd',
    allowedTools: ['Read', 'Grep', 'Glob'],
    disallowedTools: [
      'Bash',
      'Edit',
      'Write',
      'MultiEdit',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
    ],
  },
  ...over,
})

const roleResolver =
  (...roles: Role[]) =>
  async (name: string): Promise<Result<Role>> => {
    const role = roles.find((r) => r.name === name)
    return role
      ? ok(role)
      : { ok: false, error: { kind: 'failure', code: 'unknown_role', message: name } }
  }

let repos: TempRepo[] = []
afterEach(() => {
  for (const r of repos) rmSync(r.root, { recursive: true, force: true })
  repos = []
})

function setup(workspaceExtra = '') {
  const r = tempRepo(workspaceExtra)
  repos.push(r)
  return r
}

const contract = (r: TempRepo, over: Partial<TaskContract> = {}): TaskContract => ({
  goal: '审查 PR',
  workspace: 'ws/demo',
  role: 'pr-reviewer',
  executor: 'claude-sdk',
  requires: [],
  timeout_s: 3600,
  cwd: r.repo,
  inputs: { review: { pr: PR_URL } },
  ...over,
})
const ctx = (r: TempRepo, over: Partial<ExecutorContext> = {}): ExecutorContext => ({
  taskId: 't-review',
  attempt: 1,
  cwd: r.repo,
  nodeId: 'n-test',
  signal: new AbortController().signal,
  ...over,
})

async function runOnce(
  r: TempRepo,
  script: Script,
  opts: Partial<ClaudeSdkExecutorOptions> = {},
  c: TaskContract = contract(r),
  context: ExecutorContext = ctx(r),
) {
  const { query, calls } = mockQuery(script)
  const gh = opts.gh ?? fakeGh({ pr: { ...fakeGh().state.pr, headRefOid: r.head } }).gh
  const ex = createClaudeSdkExecutor({
    home: r.home,
    query,
    resolveRole: roleResolver(prReviewer()),
    raindownCommand: ['raindown'],
    gh,
    git: { env: gitEnv },
    readProjectFile: async () => undefined,
    ...opts,
  })
  const run = ex.run(c, context)
  const texts: string[] = []
  for await (const a of run.activity) texts.push(a.text ?? '')
  const done = await run.done
  if (!done.ok) throw new Error(JSON.stringify(done.error))
  return { outcome: done.data, calls, texts }
}

/** 调用 PreToolUse 钩子，返回 deny / allow / pass（只改写输入、交还权限流程）。 */
async function preToolUse(
  options: Options,
  cwd: string,
  tool_name: string,
  tool_input: Record<string, unknown>,
  mcp_server?: { name: string; source: string },
): Promise<string> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0]
  if (!hook) throw new Error('缺少 PreToolUse 钩子')
  const out = (await hook(
    {
      session_id: SID,
      transcript_path: '',
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name,
      tool_input,
      tool_use_id: 'tu',
      ...(mcp_server ? { mcp_server } : {}),
    },
    'tu',
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string } }
  return out.hookSpecificOutput?.permissionDecision ?? 'pass'
}

const reviewDir = (r: TempRepo, task = 't-review') => reviewDirOf(r.home, 'n-test', task)

const reasonOf = (o: ExecutorOutcome) =>
  o.outcome === 'failed' || o.outcome === 'done' ? o.result.reason : undefined

describe('审查准备', () => {
  test('审查通过：会话在 PR head 的临时 worktree 中运行，diff 在私有目录，reviewed_sha 取执行器记录的 head', async () => {
    const r = setup()
    let seen: {
      cwd?: string
      diff?: string
      ci?: string
      hidden?: string
      diffRead?: string
      so?: PermissionResult | null
    } = {}
    const { outcome, calls } = await runOnce(r, async function* (io) {
      const cwd = io.options.cwd ?? ''
      const diffPath = join(reviewDir(r), REVIEW_DIFF_FILE)
      seen = {
        cwd,
        diff: readFileSync(diffPath, 'utf8'),
        // .github/ 在审查 worktree 内可读（PreToolUse 钩子按读边界判定）；StructuredOutput 不进审批。
        ci: await preToolUse(io.options, cwd, 'Read', { file_path: '.github/workflows/ci.yml' }),
        hidden: await preToolUse(io.options, cwd, 'Read', { file_path: '.git' }),
        diffRead: await preToolUse(io.options, cwd, 'Read', { file_path: diffPath }),
        so: await io.ask('StructuredOutput', { verdict: 'approve' }),
      }
      expect(sh(cwd, 'rev-parse', 'HEAD')).toBe(r.head)
      expect(existsSync(join(cwd, 'feature.ts'))).toBe(true)
      expect(io.first).toContain(PR_URL)
      expect(io.first).toContain(r.head)
      expect(io.first).toContain(diffPath)
      yield say('没有阻塞问题。')
      // 模型若在结构化输出里写 reviewed_sha 也不会被采信（schema 不允许该字段）。
      yield resultMsg({
        structured_output: { verdict: 'approve', blocking: [], notes: '补个测试更好' },
      })
    })
    expect(outcome.outcome).toBe('done')
    if (outcome.outcome !== 'done') return
    expect(taskResult.parse(outcome.result).review).toEqual({
      verdict: 'approve',
      blocking: [],
      notes: '补个测试更好',
      reviewed_sha: r.head,
    })
    expect(outcome.result.summary).toBe('没有阻塞问题。')
    expect(seen.cwd).toBe(join(reviewDir(r), 'worktree'))
    expect(seen.diff).toContain('feature.ts')
    expect(seen.ci).toBe('pass')
    expect(seen.diffRead).toBe('pass')
    expect(seen.hidden).toBe('deny')
    expect(seen.so?.behavior).toBe('allow')
    const o = calls[0]
    expect(o?.outputFormat).toMatchObject({ type: 'json_schema' })
    expect(JSON.stringify(o?.outputFormat)).toContain('changes_requested')
    // Claude Code 不认识 draft 2020-12 的 $schema 声明，传了会直接退出。
    expect(JSON.stringify(o?.outputFormat)).not.toContain('$schema')
    expect(o?.tools).toEqual([...READ_ROLE_TOOLS])
    expect(o?.allowedTools).toContain('StructuredOutput')
    // 结束后移除 worktree 与私有目录，登记仓库里不留 worktree 记录。
    expect(existsSync(reviewDir(r))).toBe(false)
    // 审查目录位于 state/ 之外的本任务私有目录；结束后变空的任务目录一并删除。
    expect(reviewDir(r)).toBe(join(r.home, 'run', 'tasks', 't-review', 'review', 'n-test'))
    expect(existsSync(join(r.home, 'run', 'tasks', 't-review'))).toBe(false)
    expect(sh(r.repo, 'worktree', 'list')).not.toContain('worktree')
    // 任务专用 ref 已删除；会话不加载任何设置来源，只用 Raindown MCP，git 覆盖经环境注入。
    expect(sh(r.repo, 'for-each-ref', 'refs/raindown/')).toBe('')
    expect(o?.settingSources).toEqual([])
    expect(o?.strictMcpConfig).toBe(true)
    expect(o?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
    expect(o?.env?.GIT_LFS_SKIP_SMUDGE).toBe('1')
    expect(o?.env?.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    expect(o?.env?.GIT_CONFIG_KEY_1).toBe('core.fsmonitor')
  })

  test('changes_requested：blocking 写入结果；没有文字时摘要由结论生成', async () => {
    const r = setup()
    const { outcome } = await runOnce(r, async function* () {
      yield resultMsg({
        structured_output: { verdict: 'changes_requested', blocking: ['feature.ts 缺少测试'] },
      })
    })
    expect(outcome).toMatchObject({
      outcome: 'done',
      result: {
        review: {
          verdict: 'changes_requested',
          blocking: ['feature.ts 缺少测试'],
          reviewed_sha: r.head,
        },
      },
    })
    if (outcome.outcome === 'done') expect(outcome.result.summary).toContain('changes_requested')
  })

  test('结构化输出不合规或重试用尽：failed(review_output_invalid)，worktree 照样清理', async () => {
    const r = setup()
    for (const last of [
      resultMsg({ structured_output: { verdict: 'lgtm' } }),
      resultMsg({ structured_output: { verdict: 'approve', blocking: ['有问题'] } }),
      resultMsg({ structured_output: { verdict: 'approve', reviewed_sha: 'f'.repeat(40) } }),
      resultMsg({}),
      resultMsg({ subtype: 'error_max_structured_output_retries', is_error: true, errors: [] }),
    ]) {
      const { outcome } = await runOnce(r, async function* () {
        yield last
      })
      expect(outcome.outcome).toBe('failed')
      expect(reasonOf(outcome)).toBe('review_output_invalid')
      if (outcome.outcome === 'failed') expect(outcome.result.review).toBeUndefined()
      expect(existsSync(reviewDir(r))).toBe(false)
    }
  })

  test('他人仓库的 PR：启动前 failed(repo_not_in_workspace)，不启动会话、不调用 gh', async () => {
    const r = setup()
    const { gh, state } = fakeGh()
    const { outcome, calls } = await runOnce(
      r,
      async function* () {
        yield resultMsg()
      },
      { gh },
      contract(r, { inputs: { review: { pr: 'https://github.com/evil/demo/pull/7' } } }),
    )
    expect(reasonOf(outcome)).toBe('repo_not_in_workspace')
    expect(calls).toHaveLength(0)
    expect(state.calls).toEqual([])
  })

  test('合同 cwd 不是登记仓库：failed(repo_not_in_workspace)', async () => {
    const r = setup()
    const other = join(r.root, 'other')
    mkdirSync(other)
    const { outcome, calls } = await runOnce(
      r,
      async function* () {
        yield resultMsg()
      },
      {},
      contract(r, { cwd: other }),
      ctx(r, { cwd: other }),
    )
    expect(reasonOf(outcome)).toBe('repo_not_in_workspace')
    expect(calls).toHaveLength(0)
  })

  test('gh 报告的 head 与取到的 PR head 不一致：failed(head_moved)，不启动会话', async () => {
    const r = setup()
    const { gh } = fakeGh({ pr: { ...fakeGh().state.pr, headRefOid: r.head } })
    r.pushToPr()
    const { outcome, calls } = await runOnce(
      r,
      async function* () {
        yield resultMsg()
      },
      { gh },
    )
    expect(reasonOf(outcome)).toBe('head_moved')
    expect(calls).toHaveLength(0)
    expect(existsSync(reviewDir(r))).toBe(false)
  })

  test('fork PR（isCrossRepository）：启动前 failed(repo_not_in_workspace)，不检出、不启动会话', async () => {
    const r = setup()
    const { gh, state } = fakeGh({
      pr: { ...fakeGh().state.pr, headRefOid: r.head, isCrossRepository: true },
    })
    const { outcome, calls } = await runOnce(
      r,
      async function* () {
        yield resultMsg()
      },
      { gh },
    )
    expect(reasonOf(outcome)).toBe('repo_not_in_workspace')
    expect(calls).toHaveLength(0)
    expect(state.calls.some((c) => c.startsWith('pr diff'))).toBe(false)
    expect(existsSync(reviewDir(r))).toBe(false)
  })

  test('PR 编号不符或 head 不是 sha：failed(review_prep_failed)', async () => {
    const r = setup()
    for (const pr of [
      { ...fakeGh().state.pr, number: 8, headRefOid: r.head },
      { ...fakeGh().state.pr, headRefOid: 'main' },
    ]) {
      const { outcome } = await runOnce(
        r,
        async function* () {
          yield resultMsg()
        },
        { gh: fakeGh({ pr }).gh },
      )
      expect(reasonOf(outcome)).toBe('review_prep_failed')
    }
  })

  test('不在 reviewer_roles 中的角色：不做审查准备，结果没有 review', async () => {
    const r = setup('supervisor:\n  reviewer_roles: [other-reviewer]\n')
    const { gh, state } = fakeGh()
    const { outcome, calls } = await runOnce(
      r,
      async function* (io) {
        expect(io.options.cwd).toBe(r.repo)
        expect(io.options.outputFormat).toBeUndefined()
        yield resultMsg({ structured_output: { verdict: 'approve' } })
      },
      { gh },
    )
    expect(outcome.outcome).toBe('done')
    if (outcome.outcome === 'done') expect(outcome.result.review).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(state.calls).toEqual([])
  })

  test('恢复执行时不恢复旧会话（旧会话可能看过另一个 head），回复附在新的任务说明之后', async () => {
    const r = setup()
    const { outcome, calls } = await runOnce(
      r,
      async function* (io) {
        expect(io.first).toContain(PR_URL)
        expect(io.first).toContain('请继续')
        yield resultMsg({ structured_output: { verdict: 'approve' } })
      },
      {},
      contract(r),
      ctx(r, {
        attempt: 2,
        resume: {
          session: 'old',
          reply: { reply_id: 'r-1', kind: 'text', text: '请继续', by: 'user' },
        },
      }),
    )
    expect(outcome.outcome).toBe('done')
    expect(calls[0]?.resume).toBeUndefined()
  })

  test('节点启动清理：移除本节点残留的审查 worktree 与私有目录，不动其他节点的', async () => {
    const r = setup()
    // 模拟崩溃：会话进行中直接丢弃（不等清理），再看启动清理。
    const dir = reviewDir(r, 't-stale')
    mkdirSync(dir, { recursive: true })
    // 清理用的元数据由节点保存在 state/（审查第一轮 L4）；私有目录中 worker 可写的副本不被信任。
    const meta = reviewMetaPath(r.home, 'n-test', 't-stale')
    mkdirSync(join(meta, '..'), { recursive: true })
    writeFileSync(meta, JSON.stringify({ repo: r.repo }))
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({ repo: '/nonexistent/evil', ref: 'refs/heads/main' }),
    )
    sh(r.repo, 'worktree', 'add', '--detach', join(dir, 'worktree'), r.base)
    const other = reviewDirOf(r.home, 'n-other', 't-x')
    mkdirSync(other, { recursive: true })
    // 旧位置 state/review/<node>/<task>/ 的残留同样清理，其他节点的旧目录不动。
    const legacy = join(legacyReviewRoot(r.home, 'n-test'), 't-old')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'meta.json'), JSON.stringify({ repo: r.repo }))
    sh(r.repo, 'worktree', 'add', '--detach', join(legacy, 'worktree'), r.base)
    const legacyOther = join(legacyReviewRoot(r.home, 'n-other'), 't-y')
    mkdirSync(legacyOther, { recursive: true })
    const { query } = mockQuery(async function* () {
      yield resultMsg()
    })
    const ex = createClaudeSdkExecutor({ home: r.home, query, git: { env: gitEnv } })
    await ex.prepare?.({ nodeId: 'n-test' })
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(r.home, 'run', 'tasks', 't-stale'))).toBe(false)
    expect(sh(r.repo, 'worktree', 'list')).not.toContain('t-stale')
    expect(existsSync(meta)).toBe(false)
    // 伪造的副本把 ref 指向 main：没有被当作清理目标。
    expect(sh(r.repo, 'rev-parse', '--verify', '-q', 'refs/heads/main').trim()).not.toBe('')
    expect(existsSync(other)).toBe(true)
    expect(existsSync(legacy)).toBe(false)
    expect(sh(r.repo, 'worktree', 'list')).not.toContain('t-old')
    expect(existsSync(legacyOther)).toBe(true)
    // 没有残留目录时不报错。
    await cleanupStaleReviews(r.home, 'n-none')
  })
})

describe('审查角色必须是只读配置（fail-closed）', () => {
  test('write 类角色、setting_sources 含 project、没有 read_scope：failed(review_role_not_read)，不检出、不启动会话', async () => {
    const r = setup()
    const base = prReviewer()
    const perms = base.permissions as Record<string, unknown>
    for (const role of [
      // 默认 reviewer 那样能写文档、能用 Bash 的角色。
      prReviewer({
        kind: undefined,
        permissions: {
          ...perms,
          allowedTools: ['Read', 'Bash(gh pr review:*)'],
          disallowedTools: [],
        },
      }),
      prReviewer({ permissions: { ...perms, setting_sources: ['project'] } }),
      prReviewer({ permissions: { ...perms, read_scope: undefined } }),
    ]) {
      const { gh, state } = fakeGh()
      const { outcome, calls } = await runOnce(
        r,
        async function* () {
          yield resultMsg()
        },
        { gh, resolveRole: roleResolver(role) },
      )
      expect(reasonOf(outcome)).toBe('review_role_not_read')
      expect(calls).toHaveLength(0)
      expect(state.calls).toEqual([])
      expect(existsSync(reviewDir(r))).toBe(false)
    }
  })

  test('节点上没有该 workspace：failed(review_prep_failed)，不当作普通任务运行', async () => {
    const r = setup()
    const { outcome, calls } = await runOnce(
      r,
      async function* () {
        yield resultMsg()
      },
      {},
      contract(r, { workspace: 'ws/missing' }),
    )
    expect(reasonOf(outcome)).toBe('review_prep_failed')
    expect(calls).toHaveLength(0)
  })

  test('gh 返回的 PR 链接与合同不符：failed(review_prep_failed)', async () => {
    const r = setup()
    const { gh } = fakeGh({
      pr: { ...fakeGh().state.pr, headRefOid: r.head, url: 'https://github.com/acme/demo/pull/77' },
    })
    const { outcome } = await runOnce(
      r,
      async function* () {
        yield resultMsg()
      },
      { gh },
    )
    expect(reasonOf(outcome)).toBe('review_prep_failed')
  })
})

describe('检出与会话中不运行由配置驱动的程序', () => {
  test('fsmonitor 与 filter driver（含 PR 的 .gitattributes 引用）在检出和会话的 git 中都不执行', async () => {
    const r = setup()
    const marker = join(r.root, 'markers')
    mkdirSync(marker)
    const fsmon = join(r.root, 'fsmonitor.sh')
    writeFileSync(fsmon, `#!/bin/sh\ntouch ${join(marker, 'fsmonitor')}\nexit 1\n`, { mode: 0o755 })
    const filter = join(r.root, 'filter.sh')
    writeFileSync(filter, `#!/bin/sh\ntouch ${join(marker, 'filter')}\ncat\n`, { mode: 0o755 })
    sh(r.repo, 'config', 'core.fsmonitor', fsmon)
    sh(r.repo, 'config', 'filter.mark.smudge', filter)
    sh(r.repo, 'config', 'filter.mark.clean', filter)
    sh(r.repo, 'config', 'filter.mark.required', 'true')
    for (const [name, key] of [
      ['textconv', 'diff.mark.textconv'],
      ['diffcmd', 'diff.mark.command'],
      ['external', 'diff.external'],
    ] as const) {
      const script = join(r.root, `${name}.sh`)
      writeFileSync(script, `#!/bin/sh\ntouch ${join(marker, name)}\n`, { mode: 0o755 })
      sh(r.repo, 'config', key, script)
    }
    // PR 内容引用该 driver。
    sh(r.repo, 'checkout', '-q', 'feature')
    writeFileSync(join(r.repo, '.gitattributes'), '*.ts filter=mark diff=mark\n')
    writeFileSync(join(r.repo, 'other.ts'), 'export const y = 1\n')
    sh(
      r.repo,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'filter.mark.clean=',
      '-c',
      'filter.mark.required=false',
      'add',
      '.',
    )
    sh(
      r.repo,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'attrs',
    )
    const head = sh(r.repo, 'rev-parse', 'HEAD')
    sh(r.repo, 'push', '-q', '-f', 'origin', 'HEAD:refs/pull/7/head')
    sh(r.repo, '-c', 'core.fsmonitor=false', 'checkout', '-q', 'main')
    rmSync(marker, { recursive: true, force: true })
    mkdirSync(marker)
    let sessionMarkers: string[] = []
    const { outcome, calls } = await runOnce(
      r,
      async function* (io) {
        // 会话中 Claude Code 自己运行的 git：用会话环境在 worktree 里跑 status（会触发 fsmonitor）。
        const env = { ...gitEnv, ...(io.options.env as Record<string, string>) }
        execFileSync('git', ['status', '--porcelain'], { cwd: io.options.cwd, env, stdio: 'pipe' })
        execFileSync('git', ['checkout', '--', 'other.ts'], {
          cwd: io.options.cwd,
          env,
          stdio: 'pipe',
        })
        // diff 驱动与外部 diff 被置空：git 报错而不是运行配置里的程序。
        for (const args of [
          ['diff', 'HEAD~1'],
          ['diff', '--no-ext-diff', 'HEAD~1'],
        ])
          try {
            execFileSync('git', args, { cwd: io.options.cwd, env, stdio: 'pipe' })
          } catch {
            // 预期失败（cannot run）。
          }
        sessionMarkers = readdirSync(marker)
        yield resultMsg({ structured_output: { verdict: 'approve' } })
      },
      { gh: fakeGh({ pr: { ...fakeGh().state.pr, headRefOid: head } }).gh },
    )
    expect(outcome.outcome).toBe('done')
    expect(calls[0]?.env?.GIT_CONFIG_COUNT).toBeDefined()
    expect(sessionMarkers).toEqual([])
    expect(readdirSync(marker)).toEqual([])
    // 对照：不加覆盖时同样的操作确实会运行它们（证明测试有效）。
    sh(r.repo, 'worktree', 'add', '-q', '--detach', join(r.root, 'control'), head)
    sh(join(r.root, 'control'), 'status', '--porcelain')
    sh(join(r.root, 'control'), 'diff', 'HEAD~1')
    sh(join(r.root, 'control'), 'diff', '--no-ext-diff', 'HEAD~1')
    expect(readdirSync(marker).sort()).toEqual([
      'diffcmd',
      'external',
      'filter',
      'fsmonitor',
      'textconv',
    ])
  })
})

describe('只读角色由执行器强制（5.7）', () => {
  test('有效类别 read：SDK tools 只给白名单；canUseTool 对非只读工具直接拒绝、不预检不审批', async () => {
    const r = setup()
    const prechecks: string[] = []
    const decisions: Record<string, string> = {}
    const { calls } = await runOnce(
      r,
      async function* (io) {
        for (const tool of [
          'Bash',
          'Edit',
          'Write',
          'WebFetch',
          'Agent',
          'mcp__raindown__task_create',
          'mcp__raindown__task_reply',
          'mcp__other__x',
          'StructuredOutput',
        ])
          decisions[tool] =
            (await io.ask(tool, { command: 'ls', file_path: 'README.md' }))?.behavior ?? 'none'
        yield resultMsg()
      },
      {},
      contract(r, { inputs: {} }),
      ctx(r, {
        precheck: async (req) => {
          prechecks.push(req.tool)
          return { allow: true, level: 'auto', actions: [] }
        },
      }),
    )
    expect(calls[0]?.tools).toEqual([...READ_ROLE_TOOLS])
    for (const tool of Object.keys(decisions)) expect(decisions[tool]).toBe('deny')
    expect(prechecks).toEqual([])
  })

  test('allowedTools 含 MCP 写工具或 Bash：从 allowedTools 中滤掉，PreToolUse 钩子按 readRoleMayUse 拒绝（没有 read_scope 也安装）', async () => {
    const r = setup()
    const triage: Role = {
      name: 'triage-claude',
      kind: 'read',
      executor: 'claude-sdk',
      prompt: '只读',
      permissions: {
        setting_sources: [],
        allowedTools: ['Read', 'Grep(src/**)', 'mcp__raindown__task_create', 'mcp__other__write'],
        disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      },
    }
    const decisions: Record<string, string> = {}
    const { calls } = await runOnce(
      r,
      async function* (io) {
        for (const [tool, mcp] of [
          ['mcp__raindown__task_create', { name: 'raindown', source: 'dynamic' }],
          ['mcp__other__write', { name: 'other', source: 'project' }],
          ['mcp__raindown__kb_search', { name: 'raindown', source: 'dynamic' }],
          ['Bash', undefined],
          ['Read', undefined],
        ] as const)
          decisions[tool] = await preToolUse(
            io.options,
            r.repo,
            tool,
            { file_path: 'README.md' },
            mcp,
          )
        yield resultMsg()
      },
      { resolveRole: roleResolver(triage) },
      contract(r, { role: 'triage-claude', inputs: {} }),
    )
    const o = calls[0]
    expect(o?.allowedTools).toContain('Read')
    expect(o?.allowedTools).toContain('Grep(src/**)')
    expect(o?.allowedTools).not.toContain('mcp__raindown__task_create')
    expect(o?.allowedTools).not.toContain('mcp__other__write')
    expect(o?.strictMcpConfig).toBe(true)
    expect(o?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
    expect(decisions).toEqual({
      mcp__raindown__task_create: 'deny',
      mcp__other__write: 'deny',
      mcp__raindown__kb_search: 'pass',
      Bash: 'deny',
      Read: 'pass',
    })
  })

  test('有效类别 write 的角色不设 tools，非只读工具照常走预检', async () => {
    const r = setup()
    const writer: Role = { name: 'writer', executor: 'claude-sdk', prompt: '写文档' }
    const prechecks: string[] = []
    const { calls } = await runOnce(
      r,
      async function* (io) {
        await io.ask('Bash', { command: 'ls' })
        yield resultMsg()
      },
      { resolveRole: roleResolver(writer) },
      contract(r, { role: 'writer', inputs: {} }),
      ctx(r, {
        precheck: async (req) => {
          prechecks.push(req.tool)
          return { allow: true, level: 'auto', actions: [] }
        },
      }),
    )
    expect(calls[0]?.tools).toBeUndefined()
    expect(prechecks).toEqual(['Bash'])
  })

  test('readRoleMayUse：白名单、结构化输出开关与 Raindown MCP 自动放行清单', () => {
    for (const t of READ_ROLE_TOOLS) expect(readRoleMayUse(t, false)).toBe(true)
    expect(readRoleMayUse('StructuredOutput', false)).toBe(false)
    expect(readRoleMayUse('StructuredOutput', true)).toBe(true)
    expect(readRoleMayUse('mcp__raindown__kb_search', false)).toBe(true)
    expect(
      readRoleMayUse('mcp__raindown__kb_search', false, { name: 'raindown', source: 'dynamic' }),
    ).toBe(true)
    expect(
      readRoleMayUse('mcp__raindown__kb_search', false, { name: 'raindown', source: 'project' }),
    ).toBe(false)
    expect(readRoleMayUse('mcp__raindown__task_create', false)).toBe(false)
    expect(readRoleMayUse('Bash', true)).toBe(false)
  })
})
