import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskContract } from '@raindown/core'
import { buildCodexCommand, resolveTaskRepo } from '../src/codex-orca/executor.ts'
import { createGhCli, createOrcaCli, execRunner, orcaErrorCode } from '../src/codex-orca/orca.ts'
import { CHILD_ENV_DENYLIST } from '../src/env.ts'
import { fixtureText, orcaHome } from './codex-orca-helpers.ts'

/**
 * Orca CLI 封装（add-m1-executors 2.1）：注入一个假的 `orca` 可执行文件（bun 脚本），
 * 它按预置的响应队列输出 JSON 并记录收到的 argv。不调用真实的 orca。
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const FAKE_BIN = `
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.FAKE_CLI_DIR
const args = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n')
const file = path.join(dir, 'responses.json')
const all = JSON.parse(fs.readFileSync(file, 'utf8'))
const key = args.slice(0, 2).join(' ')
const queue = all[key] || []
const r = queue.length > 1 ? queue.shift() : queue[0]
fs.writeFileSync(file, JSON.stringify(all))
if (!r) {
  process.stderr.write('no fake response for ' + key)
  process.exit(9)
}
if (r.stdout !== undefined) process.stdout.write(typeof r.stdout === 'string' ? r.stdout : JSON.stringify(r.stdout))
if (r.stderr) process.stderr.write(r.stderr)
process.exit(r.code ?? 0)
`

interface FakeResponse {
  stdout?: unknown
  stderr?: string
  code?: number
}

/** 在临时目录写一个假 CLI，返回它的路径、环境和调用记录。 */
function fakeCli(name: string, responses: Record<string, FakeResponse[]>) {
  const dir = mkdtempSync(join(tmpdir(), `raindown-fake-${name}-`))
  roots.push(dir)
  const bin = join(dir, name)
  writeFileSync(bin, `#!${process.execPath}\n${FAKE_BIN}`)
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'responses.json'), JSON.stringify(responses))
  return {
    bin,
    env: { ...process.env, FAKE_CLI_DIR: dir },
    calls: (): string[][] =>
      readFileSync(join(dir, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  }
}

const fx = (name: string) => ({ stdout: fixtureText(name) })
const HANDLE = 'term_00000000-0000-4000-8000-000000000002'

describe('orca 封装', () => {
  test('writable_paths 不能误用于 codex-orca，生成命令前报配置错误', () => {
    expect(
      buildCodexCommand({
        codexBin: 'codex',
        codexHome: '/raindown/run/executors/codex-orca/codex-home',
        worktreePath: '/repo',
        specPath: '/spec.md',
        role: { name: 'dev', permissions: { writable_paths: ['docs/**'] } },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_permissions',
        message: expect.stringContaining('仅适用于 claude-sdk'),
      },
    })
  })

  test('worktree create：argv 与 result.worktree.path / branch', async () => {
    const f = fakeCli('orca', { 'worktree create': [fx('orca/worktree-create.json')] })
    const orca = createOrcaCli({ bin: f.bin, env: f.env })
    const r = await orca.worktreeCreate({
      repo: '/repos/raindown',
      name: 't-1',
      baseBranch: 'origin/main',
    })
    expect(r).toEqual({
      ok: true,
      data: expect.objectContaining({
        path: '/Users/user/orca/workspaces/raindown/tmp-tui-capture',
        branch: 'refs/heads/example-user/tmp-tui-capture',
      }),
    })
    expect(f.calls()).toEqual([
      [
        'worktree',
        'create',
        '--repo',
        'path:/repos/raindown',
        '--name',
        't-1',
        '--base-branch',
        'origin/main',
        '--setup',
        'run',
        '--no-parent',
        '--json',
      ],
    ])
  })

  test('terminal list：按 worktree 列出终端，带 worktreePath 与 agentIdentity', async () => {
    const f = fakeCli('orca', { 'terminal list': [fx('orca/terminal-list.json')] })
    const orca = createOrcaCli({ bin: f.bin, env: f.env })
    const r = await orca.terminalList({ worktreePath: '/Users/user/orca/workspaces/raindown/t-1' })
    expect(r.ok && r.data.map((t) => [t.handle.slice(-2), t.agentIdentity])).toEqual([
      ['02', 'codex'],
      ['05', undefined],
    ])
    expect(f.calls()).toEqual([
      ['terminal', 'list', '--worktree', 'path:/Users/user/orca/workspaces/raindown/t-1', '--json'],
    ])
  })

  test('worktree rm、terminal create、read、close', async () => {
    const f = fakeCli('orca', {
      'worktree rm': [fx('orca/worktree-rm.json')],
      'terminal create': [fx('orca/terminal-create.json')],
      'terminal read': [fx('codex-tui/working.json')],
      'terminal close': [fx('orca/terminal-close.json')],
    })
    const orca = createOrcaCli({ bin: f.bin, env: f.env })
    expect((await orca.worktreeRm({ path: '/wt/t-1' })).ok).toBe(true)
    const created = await orca.terminalCreate({
      worktreePath: '/wt/t-1',
      title: 't-1 | 目标',
      command: "codex 'hi'",
    })
    // 创建结果带上进程身份（incarnationId），用于 stale 后确认接管的是同一个终端。
    expect(created).toEqual({
      ok: true,
      data: { handle: HANDLE, incarnationId: '00000000-0000-4000-8000-000000000005' },
    })
    const read = await orca.terminalRead({ handle: HANDLE, limit: 200 })
    expect(read.ok && read.data.status).toBe('running')
    expect(read.ok && read.data.tail.some((l) => l.includes('Working ('))).toBe(true)
    expect((await orca.terminalClose({ handle: HANDLE })).ok).toBe(true)
    expect(f.calls()).toEqual([
      ['worktree', 'rm', '--worktree', 'path:/wt/t-1', '--json'],
      [
        'terminal',
        'create',
        '--worktree',
        'path:/wt/t-1',
        '--title',
        't-1 | 目标',
        '--command',
        "codex 'hi'",
        '--json',
      ],
      ['terminal', 'read', '--terminal', HANDLE, '--limit', '200', '--json'],
      ['terminal', 'close', '--terminal', HANDLE, '--json'],
    ])
  })

  test('terminal send：只发回车不带 --text；复核用 --retry-request', async () => {
    const f = fakeCli('orca', {
      'terminal send': [
        fx('orca/terminal-send-enter.json'),
        fx('orca/terminal-send-no-turn.json'),
        fx('orca/terminal-send-retry.json'),
      ],
    })
    const orca = createOrcaCli({ bin: f.bin, env: f.env })
    const enter = await orca.terminalSend({ handle: HANDLE, enter: true })
    expect(enter.ok && enter.data.send.prompt).toBeUndefined()
    const first = await orca.terminalSend({
      handle: HANDLE,
      text: '用方案 A',
      enter: true,
      waitSubmitS: 10,
    })
    expect(first.ok && first.data.send.prompt?.stages).toEqual(['input_accepted'])
    expect(first.ok && first.data.warnings?.[0]).toContain('no turn start was observed')
    const id = first.ok ? first.data.send.prompt?.requestId : undefined
    const retry = await orca.terminalSend({
      handle: HANDLE,
      text: '用方案 A',
      enter: true,
      retryRequest: String(id),
      waitSubmitS: 10,
    })
    expect(retry.ok && retry.data.send.prompt?.stages).toContain('turn_started')
    expect(retry.ok && retry.data.mutation?.replayed).toBe(true)
    expect(f.calls()).toEqual([
      ['terminal', 'send', '--terminal', HANDLE, '--enter', '--json'],
      [
        'terminal',
        'send',
        '--terminal',
        HANDLE,
        '--text',
        '用方案 A',
        '--enter',
        '--wait-submit',
        '10',
        '--json',
      ],
      [
        'terminal',
        'send',
        '--terminal',
        HANDLE,
        '--text',
        '用方案 A',
        '--enter',
        '--retry-request',
        String(id),
        '--wait-submit',
        '10',
        '--json',
      ],
    ])
  })

  test('错误：Orca 的错误信封、非 JSON、格式不符、找不到可执行文件', async () => {
    const f = fakeCli('orca', {
      'terminal read': [
        { stdout: fixtureText('orca/error-handle-stale.json'), code: 1 },
        { stdout: '', stderr: 'runtime not reachable', code: 1 },
        { stdout: 'hello' },
        { stdout: { ok: true, result: { terminal: { handle: 'x' } } } },
      ],
    })
    const orca = createOrcaCli({ bin: f.bin, env: f.env })
    const stale = await orca.terminalRead({ handle: 'x' })
    expect(stale.ok).toBe(false)
    expect(!stale.ok && stale.error.code).toBe('orca_error')
    expect(orcaErrorCode(stale)).toBe('terminal_handle_stale')
    const down = await orca.terminalRead({ handle: 'x' })
    expect(!down.ok && down.error).toMatchObject({ code: 'orca_failed' })
    expect(!down.ok && down.error.message).toContain('runtime not reachable')
    const text = await orca.terminalRead({ handle: 'x' })
    expect(!text.ok && text.error.code).toBe('orca_bad_output')
    const shape = await orca.terminalRead({ handle: 'x' })
    expect(!shape.ok && shape.error.code).toBe('orca_bad_output')
    expect(orcaErrorCode(shape)).toBeUndefined()

    const missing = createOrcaCli({ bin: join(tmpdir(), 'raindown-no-such-orca-bin') })
    const r = await missing.terminalRead({ handle: 'x' })
    expect(!r.ok && r.error.code).toBe('orca_not_found')
  })
})

describe('gh 封装', () => {
  test('cwd 不存在时不启动 gh；可执行文件不存在时保留 gh_not_found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'raindown-gh-cwd-'))
    roots.push(dir)
    let calls = 0
    const injected = createGhCli({
      run: async () => {
        calls++
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      },
    })
    expect(await injected.prList({ cwd: join(dir, 'missing'), branch: 'b' })).toMatchObject({
      ok: false,
      error: { code: 'cwd_missing', message: `工作目录不存在：${join(dir, 'missing')}` },
    })
    expect(calls).toBe(0)
    const missingBin = join(dir, 'missing-gh')
    expect(await createGhCli({ bin: missingBin }).prList({ cwd: dir, branch: 'b' })).toMatchObject({
      ok: false,
      error: { code: 'gh_not_found', message: `找不到 gh 可执行文件：${missingBin}` },
    })
  })

  test('spawn 时 cwd 被删除：ENOENT 仍归为 cwd_missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'raindown-gh-race-'))
    roots.push(dir)
    const gh = createGhCli({
      run: async () => {
        rmSync(dir, { recursive: true })
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      },
    })
    expect(await gh.prList({ cwd: dir, branch: 'b' })).toMatchObject({
      ok: false,
      error: { code: 'cwd_missing', message: `工作目录不存在：${dir}` },
    })
  })

  test('pr list：按分支查询并校验输出', async () => {
    const f = fakeCli('gh', {
      'pr list': [
        {
          stdout: [
            {
              url: 'https://github.com/o/r/pull/7',
              number: 7,
              state: 'OPEN',
              isCrossRepository: false,
              headRefName: 'example-user/t-1',
            },
          ],
        },
        { stdout: '', stderr: 'no git remotes found', code: 1 },
        { stdout: [{ url: 'u' }] },
      ],
    })
    const gh = createGhCli({ bin: f.bin, env: f.env })
    const r = await gh.prList({ cwd: tmpdir(), branch: 'example-user/t-1' })
    expect(r).toEqual({
      ok: true,
      data: [
        {
          url: 'https://github.com/o/r/pull/7',
          number: 7,
          state: 'OPEN',
          isCrossRepository: false,
          headRefName: 'example-user/t-1',
        },
      ],
    })
    expect(f.calls()[0]).toEqual([
      'pr',
      'list',
      '--head',
      'example-user/t-1',
      '--state',
      'all',
      '--json',
      'url,number,state,isCrossRepository,headRefName',
    ])
    const failed = await gh.prList({ cwd: tmpdir(), branch: 'b' })
    expect(!failed.ok && failed.error.code).toBe('gh_failed')
    const bad = await gh.prList({ cwd: tmpdir(), branch: 'b' })
    expect(!bad.ok && bad.error.code).toBe('gh_bad_output')
  })
})

describe('仓库必须属于已定义的 workspace', () => {
  const contract = (over: Record<string, unknown> = {}) =>
    taskContract.parse({
      goal: 'g',
      workspace: 'ws/product-res',
      role: 'dev',
      executor: 'codex-orca',
      ...over,
    })

  test('inputs.repo、cwd、workspace 唯一的仓库都可以给出仓库', async () => {
    const h = orcaHome()
    roots.push(h.root)
    expect(await resolveTaskRepo(h.home, contract({ inputs: { repo: h.repo } }))).toEqual({
      ok: true,
      data: h.repo,
    })
    expect(await resolveTaskRepo(h.home, contract({ cwd: `${h.repo}/` }))).toEqual({
      ok: true,
      data: h.repo,
    })
    expect(await resolveTaskRepo(h.home, contract())).toEqual({ ok: true, data: h.repo })
    // inputs.repo 选择基础仓库的既有优先级不受节点上下文 cwd 规则影响。
    expect(
      await resolveTaskRepo(h.home, contract({ cwd: h.home, inputs: { repo: h.repo } })),
    ).toEqual({ ok: true, data: h.repo })
  })

  test('不在任何 workspace 中的仓库：repo_not_in_workspace', async () => {
    const h = orcaHome()
    roots.push(h.root)
    const r = await resolveTaskRepo(h.home, contract({ inputs: { repo: join(h.root, 'other') } }))
    expect(!r.ok && r.error.code).toBe('repo_not_in_workspace')
    const none = await resolveTaskRepo(h.home, contract({ workspace: 'ws/global' }))
    expect(!none.ok && none.error.code).toBe('repo_not_in_workspace')
  })

  test('只认合同自己的 workspace：属于另一个 workspace 的仓库也拒绝', async () => {
    const h = orcaHome()
    roots.push(h.root)
    const other = join(h.root, 'repos', 'blog')
    writeFileSync(
      join(h.home, 'config/workspaces/blog.yaml'),
      `id: blog\nname: Blog\ndescription: 博客\nkind: product\nrepos:\n  - ${other}\n`,
    )
    const r = await resolveTaskRepo(h.home, contract({ inputs: { repo: other } }))
    expect(!r.ok && r.error.code).toBe('repo_not_in_workspace')
    expect(!r.ok && r.error.message).toContain('ws/product-res')
    expect(
      await resolveTaskRepo(h.home, contract({ workspace: 'ws/blog', inputs: { repo: other } })),
    ).toEqual({
      ok: true,
      data: other,
    })
  })
})

describe('启动 Codex 的命令', () => {
  test('bypass 角色：与 run-codex.sh 等价，任务说明经文件传入', () => {
    const r = buildCodexCommand({
      codexBin: 'codex',
      codexHome: '/raindown/run/executors/codex-orca/codex-home',
      worktreePath: '/wt/t 1',
      specPath: '/home/state/tasks/t-1/spec.md',
      role: {
        name: 'dev',
        model: 'gpt-6.1-sol',
        effort: 'high',
        permissions: {
          approval: 'never',
          sandbox: 'danger-full-access',
          config: { service_tier: 'priority' },
        },
      },
    })
    expect(r).toEqual({
      ok: true,
      data:
        "cd '/wt/t 1' && exec env -u RAINDOWN_HUB_TOKEN -u RAINDOWN_HUB_TOKEN_FILE -u RAINDOWN_LEASE_TOKEN_FILE -u FLOW_LEASE_TOKEN_FILE -u FLOW_HUB_TOKEN -u FLOW_HUB_TOKEN_FILE RAINDOWN_ACTOR=dev FLOW_ACTOR=dev CODEX_HOME=/raindown/run/executors/codex-orca/codex-home codex -m gpt-6.1-sol -c model_reasoning_effort=high " +
        '-c service_tier=priority --dangerously-bypass-approvals-and-sandbox ' +
        '"$(cat /home/state/tasks/t-1/spec.md)"',
    })
  })

  test('on-request 角色：-a 与 -s，并默认将授权弹窗交给 Raindown', () => {
    const r = buildCodexCommand({
      codexBin: 'codex',
      codexHome: '/raindown/run/executors/codex-orca/codex-home',
      worktreePath: '/wt',
      specPath: '/s.md',
      role: { name: 'dev', permissions: { approval: 'on-request', sandbox: 'workspace-write' } },
    })
    expect(r.ok && r.data).toBe(
      'cd /wt && exec env -u RAINDOWN_HUB_TOKEN -u RAINDOWN_HUB_TOKEN_FILE -u RAINDOWN_LEASE_TOKEN_FILE -u FLOW_LEASE_TOKEN_FILE -u FLOW_HUB_TOKEN -u FLOW_HUB_TOKEN_FILE RAINDOWN_ACTOR=dev FLOW_ACTOR=dev CODEX_HOME=/raindown/run/executors/codex-orca/codex-home codex -c approvals_reviewer=user -a on-request -s workspace-write "$(cat /s.md)"',
    )
  })

  test.each([{}, { config: { approval_policy: 'on-request' } }])(
    '未设置 approval 时仍默认将授权弹窗交给 Raindown：%j',
    (permissions) => {
      const r = buildCodexCommand({
        codexBin: 'codex',
        codexHome: '/raindown/run/executors/codex-orca/codex-home',
        worktreePath: '/wt',
        specPath: '/s.md',
        role: { name: 'dev', permissions },
      })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toContain('-c approvals_reviewer=user')
    },
  )

  test('approval=never 时不默认追加 reviewer', () => {
    const r = buildCodexCommand({
      codexBin: 'codex',
      codexHome: '/raindown/run/executors/codex-orca/codex-home',
      worktreePath: '/wt',
      specPath: '/s.md',
      role: { name: 'dev', permissions: { approval: 'never', sandbox: 'workspace-write' } },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).not.toContain('approvals_reviewer=')
  })

  test.each(['user', 'auto_review', 'guardian_subagent'])(
    '角色显式配置 reviewer=%s 时只传角色值',
    (reviewer) => {
      const r = buildCodexCommand({
        codexBin: 'codex',
        codexHome: '/raindown/run/executors/codex-orca/codex-home',
        worktreePath: '/wt',
        specPath: '/s.md',
        role: {
          name: 'dev',
          permissions: {
            approval: 'on-request',
            sandbox: 'workspace-write',
            config: { approvals_reviewer: reviewer, service_tier: 'priority' },
          },
        },
      })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.data.match(/-c approvals_reviewer=\S+/g)).toEqual([
          `-c approvals_reviewer=${reviewer}`,
        ])
        expect(r.data).toContain('-c service_tier=priority')
      }
    },
  )
})

test('Orca 启动命令把角色身份传给实际子进程，并覆盖终端继承值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raindown-orca-env-'))
  roots.push(dir)
  const bin = join(dir, 'fake-codex')
  const specPath = join(dir, 'spec.md')
  writeFileSync(
    bin,
    '#!/bin/sh\nprintf "%s\\n%s\\n%s" "$RAINDOWN_ACTOR" "$FLOW_ACTOR" "$CODEX_HOME"\n',
  )
  chmodSync(bin, 0o755)
  writeFileSync(specPath, '临时任务')
  const command = buildCodexCommand({
    codexBin: bin,
    codexHome: join(dir, 'isolated home'),
    worktreePath: dir,
    specPath,
    role: { name: 'dev' },
  })
  if (!command.ok) throw new Error(command.error.message)
  const out = await execRunner('sh', ['-c', command.data], {
    timeoutMs: 5000,
    env: {
      ...process.env,
      RAINDOWN_ACTOR: 'user',
      FLOW_ACTOR: 'stale-role',
      CODEX_HOME: '/legacy-codex-home',
    },
  })
  expect(out.code).toBe(0)
  expect(out.stdout).toBe(`dev\ndev\n${join(dir, 'isolated home')}`)
})

test('Orca 启动命令移除完整 denylist，并拒绝包含 = 的 codexBin', () => {
  const base = {
    codexBin: 'codex',
    codexHome: '/raindown/run/executors/codex-orca/codex-home',
    worktreePath: '/wt',
    specPath: '/s.md',
    role: { name: 'dev' },
  }
  const command = buildCodexCommand(base)
  if (!command.ok) throw new Error(command.error.message)
  for (const key of CHILD_ENV_DENYLIST) expect(command.data).toContain(`-u ${key}`)
  for (const codexBin of ['RAINDOWN_ACTOR=user', '/tmp/codex=custom']) {
    expect(buildCodexCommand({ ...base, codexBin })).toMatchObject({
      ok: false,
      error: { code: 'invalid_codex_bin' },
    })
  }
})
