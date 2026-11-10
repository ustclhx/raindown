import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fail, ok, type Result } from '@raindown/core'
import {
  type GhCli,
  type GhPr,
  type OrcaCli,
  type OrcaSendResult,
  type OrcaTerminalInfo,
  type OrcaTerminalRead,
  orcaTerminalReadResult,
  orcaTerminalSendResult,
  parseOrcaOutput,
  type TerminalSendInput,
} from '../src/codex-orca/orca.ts'

/**
 * codex-orca 测试的公共部分：真实终端片段 fixture 的读取、内存中的假 Orca / gh、临时 raindown-home。
 * 测试绝不调用真实的 orca、codex 或 gh。
 */

const FIXTURES = join(import.meta.dir, 'fixtures')

/** 读取一个 fixture 的原始 JSON 文本（`orca … --json` 的完整输出）。 */
export const fixtureText = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

/** codex-tui fixture 经 Orca 输出 schema 解析后的终端读取结果。 */
export function tuiFixture(name: string): OrcaTerminalRead {
  const r = parseOrcaOutput(
    { code: 0, stdout: fixtureText(`codex-tui/${name}.json`), stderr: '' },
    orcaTerminalReadResult,
    'terminal read',
  )
  if (!r.ok) throw new Error(r.error.message)
  return r.data.terminal
}

export function sendFixture(name: string): OrcaSendResult {
  const r = parseOrcaOutput(
    { code: 0, stdout: fixtureText(`orca/${name}.json`), stderr: '' },
    orcaTerminalSendResult,
    'terminal send',
  )
  if (!r.ok) throw new Error(r.error.message)
  return r.data
}

export const TUI_FIXTURES = [
  'trust-prompt',
  // 0.167 临时环境 PTY 实测文本，路径脱敏并套用 Orca 输出信封。
  'trust-prompt-0167',
  'starting',
  'working',
  'streaming',
  'question',
  'question-options',
  'approval',
  'approval-denied',
  'pr-opened',
  'stopped-statement',
  'shell-prompt',
  'codex-exited',
  'no-output',
] as const

export interface OrcaCall {
  op: string
  input: unknown
}

/**
 * 内存中的假 Orca：终端读取按 `reads` 队列依次返回（最后一个重复），发送按 `sends` 队列返回
 * （为空时返回只发回车的回执）。所有调用记入 `calls`。
 */
export class FakeOrca implements OrcaCli {
  calls: OrcaCall[] = []
  reads: Array<Result<OrcaTerminalRead>> = []
  sends: Array<Result<OrcaSendResult>> = []
  worktreeResult: Result<{ path: string; branch?: string }>
  handle = 'term_00000000-0000-4000-8000-0000000000aa'
  /** `terminal list` 的结果；缺省为本 worktree 中只有当前 handle 这一个 Codex 终端。 */
  terminals: Result<OrcaTerminalInfo[]> | undefined
  /** `terminal create` 返回的进程身份（ptyId / incarnationId）；缺省没有。 */
  identity: { ptyId?: string; incarnationId?: string } = {}

  constructor(public worktreePath: string) {
    this.worktreeResult = ok({ path: worktreePath, branch: 'refs/heads/example-user/t-orca-1' })
  }

  /** 让后续的读取依次返回这些 fixture。 */
  show(...names: string[]) {
    this.reads.push(...names.map((n) => ok(tuiFixture(n))))
  }

  ops(op?: string) {
    return op ? this.calls.filter((c) => c.op === op) : this.calls
  }

  async worktreeCreate(input: unknown) {
    this.calls.push({ op: 'worktreeCreate', input })
    mkdirSync(this.worktreePath, { recursive: true })
    writeFileSync(join(this.worktreePath, '.git'), 'gitdir: /unused-test-git-dir\n')
    return this.worktreeResult
  }
  async worktreeRm(input: unknown): Promise<Result<void>> {
    this.calls.push({ op: 'worktreeRm', input })
    return ok(undefined)
  }
  async terminalCreate(input: unknown) {
    this.calls.push({ op: 'terminalCreate', input })
    return ok({ handle: this.handle, ...this.identity })
  }
  async terminalRead(input: unknown): Promise<Result<OrcaTerminalRead>> {
    this.calls.push({ op: 'terminalRead', input })
    const next = this.reads.length > 1 ? this.reads.shift() : this.reads[0]
    if (!next) return ok({ handle: this.handle, status: 'running', tail: [] })
    return next
  }
  async terminalSend(input: TerminalSendInput): Promise<Result<OrcaSendResult>> {
    this.calls.push({ op: 'terminalSend', input })
    const next = this.sends.shift()
    if (next) return next
    if (input.text !== undefined && input.enter) {
      return ok({
        send: {
          accepted: true,
          prompt: { requestId: 'req-1', stages: ['input_accepted', 'turn_started'] },
        },
      })
    }
    return ok(sendFixture('terminal-send-enter'))
  }
  async terminalList(input: { worktreePath: string }): Promise<Result<OrcaTerminalInfo[]>> {
    this.calls.push({ op: 'terminalList', input })
    return (
      this.terminals ??
      ok([{ handle: this.handle, worktreePath: input.worktreePath, agentIdentity: 'codex' }])
    )
  }
  /** 注入的关闭终端结果（缺省成功）。 */
  closeResult: Result<void> | undefined
  async terminalClose(input: unknown): Promise<Result<void>> {
    this.calls.push({ op: 'terminalClose', input })
    return this.closeResult ?? ok(undefined)
  }
}

export const staleHandle = () =>
  fail('failure', 'orca_error', 'orca terminal read 返回错误 terminal_handle_stale', {
    code: 'terminal_handle_stale',
  })

export class FakeGh implements GhCli {
  prs: GhPr[] = []
  error: string | undefined
  calls: Array<{ cwd: string; branch: string }> = []
  async prList(input: { cwd: string; branch: string }): Promise<Result<GhPr[]>> {
    this.calls.push(input)
    if (this.error) return fail('failure', 'gh_failed', this.error)
    return ok(this.prs)
  }
}

export interface OrcaHome {
  root: string
  home: string
  repo: string
  worktree: string
}

/** 临时 raindown-home：一个 product workspace（仓库 repo）、dev 角色、一个 brain 条目。 */
export function orcaHome(): OrcaHome {
  const root = mkdtempSync(join(tmpdir(), 'raindown-codex-orca-'))
  const home = join(root, 'home')
  const repo = join(root, 'repos', 'product-res')
  const worktree = join(root, 'orca', 'workspaces', 'product-res', 't-orca-1')
  for (const d of ['config/workspaces', 'config/roles', 'brain/projects', 'state']) {
    mkdirSync(join(home, d), { recursive: true })
  }
  mkdirSync(repo, { recursive: true })
  writeFileSync(
    join(home, 'config/workspaces/product-res.yaml'),
    `id: product-res\nname: Product Res\ndescription: 产品资源\nkind: product\nrepos:\n  - ${repo}\n`,
  )
  writeFileSync(
    join(home, 'config/roles/dev.yaml'),
    'name: dev\nexecutor: codex-orca\nmodel: gpt-6.1-sol\neffort: high\nprompt: dev.md\npermissions:\n  approval: never\n  sandbox: danger-full-access\n',
  )
  writeFileSync(join(home, 'config/roles/dev.md'), '按任务合同完成开发，开 PR，不合并。\n')
  writeFileSync(
    join(home, 'brain/projects/product-res.md'),
    '---\ntype: project\ntitle: Product Res\nsummary: 产品资源站，Next.js 部署在 Cloudflare\n---\n\n正文\n',
  )
  return { root, home, repo, worktree }
}
