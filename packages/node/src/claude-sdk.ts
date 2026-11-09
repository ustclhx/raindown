import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  CanUseTool,
  EffortLevel,
  McpStdioServerConfig,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk'
import {
  BLOCKED_REASONS,
  type BlockedReason,
  RAINDOWN_MCP_TOOL_PREFIX as CORE_RAINDOWN_MCP_TOOL_PREFIX,
  clipText,
  type DeliveredReply,
  effectiveRoleKind,
  fail,
  HUB_TOKEN_FILE_ENV,
  loadRoles,
  loadWorkspaces,
  normalizeBindingWorkspace,
  ok,
  type Result,
  type ReviewOutput,
  type Role,
  type RoleKind,
  readScope,
  redactLines,
  redactSecrets,
  renderRecoveryPrompt,
  renderTaskInputs,
  renderWorkerTaskPrompt,
  reviewerRoleProblem,
  reviewOutput,
  SUPERVISOR_ACTOR,
  type SupervisorConfig,
  supervisorRoleProblem,
  type TaskContract,
  type TaskCost,
  type TaskResult,
  writablePaths,
} from '@raindown/core'
import { z } from 'zod'
import {
  checkReadScope,
  isRaindownMcp,
  READ_SCOPE_ENV,
  type ReadScopeCall,
  type ReadScopeContext,
} from './claude-read-scope.ts'
import { CLAUDE_FILE_WRITE_MATCHER, checkWritableTool } from './claude-writable-paths.ts'
import { type NodeClock, systemClock } from './clock.ts'
import { CHILD_ENV_DENYLIST, dualRaindownEnv, executorRoleEnv } from './env.ts'
import {
  ActivityQueue,
  type DeliverResult,
  type ExecutorContext,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRun,
  type InjectResult,
  idleSignal,
  resumedSignal,
  type StuckSnapshot,
  type StuckVerdict,
} from './executor.ts'
import {
  createGitHubCli,
  type GitConfigPair,
  type GitHubCli,
  type GitOptions,
  gitConfigEnv,
  UNTRUSTED_CHECKOUT_ENV,
} from './github.ts'
import { autoApprovedText, needsUserText, type PrecheckRequest } from './precheck.ts'
import {
  cleanupStaleReviews,
  type PreparedReview,
  prepareReview,
  reviewPromptSection,
} from './review-prep.ts'
import { resolveContractCwd } from './workdir.ts'

/**
 * claude-sdk 执行器（add-m1-executors 3.1 / 3.2；design D5；executor-claude-sdk spec）。
 *
 * 通过 Claude Agent SDK 无头运行 Claude Code：
 * - 流式输入：首条用户消息是任务说明，运行中的文字回复再作为用户消息推入；
 * - 角色提示词追加在 `claude_code` 预设之后；设置来源由角色的 `setting_sources` 决定（默认 `['project']`，
 *   为 `[]` 时改为追加 cwd 下 CLAUDE.md / AGENTS.md 的纯文本）；权限模式默认 `default`；
 * - 注入任务绑定的 Raindown MCP（stdio），worker 只放行派工受限工具，supervisor 沿用唤醒工具清单；
 * - 工具审批：`canUseTool` 先做策略预检（add-m1-inbox 2.3，`claudePrecheckRequest`），中枢判定 auto /
 *   auto-report 时直接放行；否则挂起，经 idle 信号上报 `blocked(awaiting_approval)`，
 *   approve / deny 经 `deliver` 送达后 resolve 对应的 Promise；超过角色设定的时限则任务失败；
 * - 结果：摘要取最后一条助手文本，记录会话 id 与费用；SDK 报错或轮次耗尽时以 failed 结束；
 * - 取消：`abortController.abort()` 加 `close()`。
 *
 * SDK 只在真正运行时才动态加载；测试注入模拟的 `query`，绝不调用真实的 Claude。
 */

export const CLAUDE_SDK_EXECUTOR = 'claude-sdk'
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
/** 审批等待的默认时限：24 小时。 */
export const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 24 * 60

/**
 * 不经审批即放行的 raindown MCP 工具（工具名 = `packages/core/src/ops` 中的操作名）。
 *
 * 只放行读知识库、写 journal / capture、提交提案（提案仍需用户接受）和只读查看任务：
 * 这些操作都落在 AI 写入边界之内，不会让 worker 获得比自身角色更大的权限。
 * 其余工具一律走 canUseTool 审批，尤其是：
 * - `task_create`：只读的 reviewer 可以借此创建一个 `role: dev`（codex-orca + danger-full-access）的任务，等于提权；
 * - `task_cancel`、`task_reply`：可以干预其他任务（包括替用户答复审批）；
 * - `kb_proposals_accept` / `reject`、`resource_transfer`：属于用户的决定；
 * - 以后新增的 raindown 工具：默认不在清单里，需要审批，评估后再加入。
 */
export const RAINDOWN_MCP_AUTO_ALLOWED = [
  'kb_search',
  'kb_get',
  'kb_query',
  'kb_journal',
  'capture',
  'kb_propose',
  'ws_brief',
  // 只写 supervisor 自己的简报笔记：身份、workspace 绑定与 base_hash 由中枢核对（design D7）。
  'brief_update',
  'task_list',
  'task_show',
] as const
/** 只在中枢凭证已校验的 task / wake 绑定会话中自动放行的读取工具。 */
export const BOUND_MCP_AUTO_ALLOWED = ['event_get'] as const
/**
 * 派工绑定只暴露这些受限工具；supervisor 沿用自己的唤醒工具清单。
 * `event_get` 不在这里：它按 BOUND_MCP_AUTO_ALLOWED 的规则处理（中枢限制本任务），
 * worker 会话中写角色仍经审批，只读角色由 readRoleMayUse 按绑定放行。
 */
export const WORKER_MCP_AUTO_ALLOWED = [
  'raindown_report',
  'task_show',
  'kb_search',
  'kb_get',
  'kb_query',
] as const

const WORKER_REPORT_CONVENTION =
  '优先使用 raindown_report，每次必填 status 和 summary：question 填 question 问题、2–8 个 options（label、description）及 recommended 推荐标签；blocked 说明 missing/tried；' +
  '交付就绪时 ready 用 deliverables 填 PR 地址；branch_unknown 或 deliverable_branch_mismatch 时不要反复提交 ready，改用 blocked 说明分支情况及已尝试的操作；无需继续时 dropped 说明 reason；失败用 failed 说明 reason。' +
  'question/blocked 后停下等待，progress 后继续工作，ready/failed/dropped 后结束本轮；上报不可用时才以文字说明状态。'

/**
 * 只在 supervisor 会话（`kind: supervisor`）中自动放行的 raindown MCP 工具（design D7；tasks 4.1）：
 * `ask_user`、`task_propose`、`decision_review` 只产生等待用户处理的内容；`patrol_report` 只写 journal 与
 * Digest 条目（中枢只接受巡检唤醒，D13）；`task_respond` 的权限由中枢按
 * D15 核对（不再经策略审批，否则会自我阻塞）。其他角色不放行它们（readRoleMayUse 也不认），
 * `task_create`、`pr_merge_request` 对 supervisor 仍走策略。
 */
export const SUPERVISOR_MCP_AUTO_ALLOWED = [
  'ask_user',
  'task_propose',
  'decision_review',
  'patrol_report',
  'task_respond',
] as const
/**
 * 已登记在 supervisor 放行清单、但 `packages/core/src/ops` 中尚未实现的操作名（4.4、4.6、4.7、4.9
 * 实现时必须从这里删除，测试会核对）。没有对应工具时清单项不起作用。
 */
export const RAINDOWN_MCP_AUTO_ALLOWED_PENDING: readonly string[] = []
/** SDK 中 raindown MCP 工具的全名前缀（服务名 raindown），与 core 的动作识别共用。 */
export const RAINDOWN_MCP_TOOL_PREFIX = CORE_RAINDOWN_MCP_TOOL_PREFIX
/**
 * 有效类别为 read 的角色（design D9；tasks 5.7）可用的内置工具：SDK `tools` 选项只提供这些，
 * canUseTool 对其余工具一律拒绝、不进审批。ToolSearch 与 WaitForMcpServers 用于加载 Raindown MCP 工具；
 * StructuredOutput 只在配置了结构化输出（审查任务）时可用，它不是内置工具，不放进 `tools`。
 */
export const READ_ROLE_TOOLS = ['Read', 'Grep', 'Glob', 'ToolSearch', 'WaitForMcpServers'] as const
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput'

/** 只读角色能否使用该工具：白名单内置工具、结构化输出（已配置时）与自动放行的 Raindown MCP 工具。 */
export function readRoleMayUse(
  toolName: string,
  structuredOutput: boolean,
  mcpServer?: { name: string; source: string },
  binding?: 'task' | 'wake',
): boolean {
  if ((READ_ROLE_TOOLS as readonly string[]).includes(toolName)) return true
  if (toolName === STRUCTURED_OUTPUT_TOOL) return structuredOutput
  if (!toolName.startsWith(RAINDOWN_MCP_TOOL_PREFIX)) return false
  // SDK 没有给出来源时按名字判断（只读角色不加载其他 MCP 来源：setting_sources 必须为 []）；给出时必须是 raindown。
  if (mcpServer !== undefined && !isRaindownMcp(toolName, mcpServer)) return false
  const name = toolName.slice(RAINDOWN_MCP_TOOL_PREFIX.length)
  return (
    ([...RAINDOWN_MCP_AUTO_ALLOWED, ...WORKER_MCP_AUTO_ALLOWED] as readonly string[]).includes(
      name,
    ) ||
    (binding !== undefined && (BOUND_MCP_AUTO_ALLOWED as readonly string[]).includes(name))
  )
}

/**
 * 审查结构化输出的 JSON Schema（与 `schemas/tasks/review-output.schema.json` 同源）。
 * 去掉 `$schema` 声明：Claude Code 2.1.311 校验 --json-schema 时不认识 draft 2020-12 的元 schema，进程直接退出。
 */
let reviewSchemaCache: Record<string, unknown> | undefined
export function reviewOutputJsonSchema(): Record<string, unknown> {
  if (!reviewSchemaCache) {
    const { $schema: _, ...rest } = z.toJSONSchema(reviewOutput, { io: 'input' }) as Record<
      string,
      unknown
    >
    reviewSchemaCache = rest
  }
  return reviewSchemaCache
}

/** 结构化输出失败时的原因码（pr-acceptance：`failed(review_output_invalid)`）。 */
export const REVIEW_OUTPUT_INVALID = 'review_output_invalid'

/** 项目约定文件（setting_sources 为 [] 时作为纯文本追加到系统提示词）。 */
export const PROJECT_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const
const PROJECT_INSTRUCTION_MAX = 16_000
/** 取消时等 SDK 子进程（及其 raindown MCP 孙进程）退出的时限。 */
export const CANCEL_GRACE_MS = 10_000

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const satisfies readonly PermissionMode[]
const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

const SETTING_SOURCES = ['user', 'project', 'local'] as const satisfies readonly SettingSource[]

/**
 * 角色 `permissions` 在 claude-sdk 执行器下的形态（这里细化执行器专用配置）。
 *
 * - `permissionMode` 默认 `default`：每一次未被允许列表放行的调用都进 canUseTool、交给 Raindown 审批。
 *   `auto` 下分类器有把握的调用根本不会进 canUseTool，等于让模型自己决定，只有角色显式写出才使用；
 * - `setting_sources` 默认 `['project']`。注意被操作仓库的 `.claude/settings.json` 会随之生效：
 *   其中的 hooks 会直接执行命令，`permissions.allow` 会在 canUseTool 之前放行，绕过 Raindown 的审批。
 *   审查他人仓库的角色（reviewer 模板）应设为 `[]`，此时执行器改为把 cwd 下 CLAUDE.md / AGENTS.md
 *   的纯文本追加到系统提示词，保留项目约定但不加载 hooks 与权限规则。
 */
export const claudeSdkPermissions = z.strictObject({
  permissionMode: z.enum(PERMISSION_MODES).default('default'),
  allowedTools: z.array(z.string().min(1)).default([]),
  disallowedTools: z.array(z.string().min(1)).default([]),
  writable_paths: writablePaths.optional(),
  read_scope: readScope.optional(),
  maxTurns: z.number().int().positive().optional(),
  approval_timeout_minutes: z
    .number()
    .positive()
    .max(10 * 24 * 60)
    .default(DEFAULT_APPROVAL_TIMEOUT_MINUTES),
  setting_sources: z.array(z.enum(SETTING_SOURCES)).default(['project']),
})
export type ClaudeSdkPermissions = z.infer<typeof claudeSdkPermissions>

/** SDK `query()` 的返回值中本执行器用到的部分（真实的 `Query` 满足它）。 */
export interface ClaudeQueryHandle extends AsyncIterable<SDKMessage> {
  close(): void
}
/** 与 SDK `query()` 同签名的函数；测试注入模拟实现。 */
export type ClaudeQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => ClaudeQueryHandle

/** 会写文件的工具：缺少路径时不做预检，直接交给用户。 */
const PATH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const

/**
 * 把 SDK 的一次工具调用转成策略预检请求（add-m1-inbox 2.3）：
 * - Bash：`command` 作为命令文本（必须是字符串，否则不预检）；
 * - 其他工具：`file_path` / `notebook_path` / `path` 中的字符串作为 paths，原样传给中枢
 *   （不改写成相对路径：规则的路径模式匹配不上时只会更保守）；
 * - Edit / Write / MultiEdit / NotebookEdit 缺少路径时不预检；
 * - 其余工具只有工具名。
 *
 * 返回 undefined 表示无法可靠地构造请求，调用方交给用户审批。
 */
export function claudePrecheckRequest(
  toolName: string,
  input: Record<string, unknown>,
): PrecheckRequest | undefined {
  if (toolName === 'Bash') {
    const command = input.command
    if (typeof command !== 'string' || command.trim() === '') return undefined
    return { tool: toolName, command }
  }
  const paths = PATH_FIELDS.map((k) => input[k]).filter(
    (v): v is string => typeof v === 'string' && v !== '',
  )
  if (PATH_TOOLS.has(toolName) && paths.length === 0) return undefined
  return { tool: toolName, ...(paths.length > 0 ? { paths } : {}) }
}

export interface ClaudeSdkExecutorOptions {
  /** raindown-home：读取角色，并作为 raindown MCP 的 RAINDOWN_HOME。 */
  home: string
  clock?: NodeClock
  /** 注入的 `query`；缺省时动态加载 `@anthropic-ai/claude-agent-sdk`。 */
  query?: ClaudeQueryFn
  /** 按名字解析角色；缺省读取 `config/roles/`。 */
  resolveRole?: (name: string) => Promise<Result<Role>>
  /** 启动 raindown 的命令（argv 前缀），缺省 `['raindown']`。 */
  raindownCommand?: readonly string[]
  /** 待审批请求重新上报的初始间隔（之后指数退避到 10 分钟），缺省 1 秒。 */
  reannounceMs?: number
  /** 两条 SDK 消息间隔超过这么久时附带 resumed 信号（让 no_progress 之后恢复），缺省 60 秒。 */
  resumeGapMs?: number
  /** 取消后等 SDK 子进程退出的毫秒数，超时后 close() 强制结束；缺省 10 秒。 */
  cancelGraceMs?: number
  /** 读取项目约定文件；缺省读 cwd 下的文件，不存在时返回 undefined。 */
  readProjectFile?: (path: string) => Promise<string | undefined>
  /** 审查准备用的 gh（缺省调用本机 gh）；测试注入假 gh，绝不调用真实 gh。 */
  gh?: GitHubCli
  /** 审查准备的 git 选项（runner、环境）。 */
  git?: GitOptions
  /** 读取 workspace 的 supervisor 配置（reviewer_roles）；缺省读 `config/workspaces/`。没有该 workspace 时返回 undefined。 */
  resolveSupervisor?: (
    workspace: string,
  ) => Promise<Result<Pick<SupervisorConfig, 'reviewer_roles'> | undefined>>
}

const REANNOUNCE_MAX_MS = 10 * 60_000
const ACTIVITY_TEXT_MAX = 16_000
const SUMMARY_MAX = 16_000
const INPUT_SUMMARY_MAX = 500
const STDERR_KEEP = 20

/** 截断后脱敏，再截断到 max（与 sanitizeMessage 同序）。 */
const safe = (text: string, max: number) =>
  clipText(redactSecrets(clipText(text, Math.max(max * 4, 4000))), max)

/** 工具输入的一句话摘要：常见工具取关键字段，其余取 JSON。已脱敏、限长。 */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  let raw: string | undefined
  if (toolName === 'Bash') raw = pick('command')
  else if (['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(toolName))
    raw = pick('file_path') ?? pick('notebook_path')
  else if (toolName === 'WebFetch') raw = pick('url')
  else if (toolName === 'Glob' || toolName === 'Grep') raw = pick('pattern')
  if (raw === undefined) {
    try {
      raw = JSON.stringify(input) ?? ''
    } catch {
      raw = '（无法序列化的输入）'
    }
  }
  return safe(raw.replace(/\s+/g, ' ').trim(), INPUT_SUMMARY_MAX)
}

/** 卡住识别：idle 信号的 hint 中带有合法原因时照用（审批挂起即 awaiting_approval）。 */
export function classifyClaudeSdk(snapshot: StuckSnapshot): StuckVerdict | null {
  const reason = snapshot.hint?.reason
  if (typeof reason !== 'string' || !(BLOCKED_REASONS as readonly string[]).includes(reason)) {
    return null
  }
  const message = snapshot.hint?.message
  const session = snapshot.hint?.session
  return {
    reason: reason as BlockedReason,
    message: typeof message === 'string' && message ? message : `Claude 已停下（${reason}）`,
    ...(typeof session === 'string' && session ? { session } : {}),
  }
}

/** 首条用户消息：任务说明。 */
export function renderTaskPrompt(contract: TaskContract, cwd: string, taskId?: string): string {
  const lines = ['# 任务', '', renderWorkerTaskPrompt(contract, taskId), '', `工作目录：${cwd}`]
  if (contract.context?.length) {
    lines.push('', '## 上下文引用', ...contract.context.map((c) => `- ${c}`))
    lines.push('（brain 条目可以通过 raindown MCP 的 kb 工具检索。）')
  }
  if (contract.verify?.length) {
    lines.push(
      '',
      '## 验收命令',
      '你结束后 Raindown 会依次运行：',
      ...contract.verify.map((v) => `- \`${v.cmd.join(' ')}\`${v.cwd ? `（目录 ${v.cwd}）` : ''}`),
    )
  }
  lines.push(
    '',
    '## 约定',
    '- 需要的工具权限会由 Raindown 转给用户审批，被拒绝时请按理由调整做法。',
    '- 完成后用简短的文字总结结果，最后一段文字会作为任务结果摘要。',
  )
  return lines.join('\n')
}

/** 把一条回复写成给 Claude 的用户消息。 */
export function renderReply(reply: DeliveredReply): string {
  const text = reply.text?.trim()
  switch (reply.kind) {
    case 'approve':
      return `用户（${reply.by}）批准了你上一次请求的操作，请继续。${text ? `\n附言：${text}` : ''}`
    case 'deny':
      return `用户（${reply.by}）拒绝了你上一次请求的操作${text ? `，理由：${text}` : '。'}\n请调整做法后继续。`
    case 'text':
      return `用户（${reply.by}）回复：\n${text ?? ''}`
  }
}

const userMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
})

/** 简单的异步队列：作为 SDK 的流式输入。 */
class InputStream implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | undefined
  closed = false

  /** 已推入、SDK 还没读取的消息数。 */
  get unread() {
    return this.items.length
  }

  push(item: SDKUserMessage) {
    if (this.closed) return
    const w = this.waiting
    this.waiting = undefined
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.closed = true
    const w = this.waiting
    this.waiting = undefined
    w?.({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

interface PendingApproval {
  toolUseID: string
  toolName: string
  input: Record<string, unknown>
  message: string
  /** 预检判定为 supervisor 档位时的判定 id（D15）：随 idle 信号的 hint 上报。 */
  decisionId?: number
  /** 预检时的请求（工具、命令、路径）：supervisor 的批准送达前交给节点复核。 */
  request?: PrecheckRequest
  resolve(r: PermissionResult): void
  cancelTimer(): void
}

/** 结果消息的费用与用量（字段以 SDK 的 SDKResultMessage 为准）。 */
export function costOf(r: SDKResultMessage): TaskCost {
  let input = 0
  let output = 0
  for (const u of Object.values(r.modelUsage ?? {})) {
    input += u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens
    output += u.outputTokens
  }
  const int = (n: number) => Math.max(0, Math.round(n))
  return {
    usd: Math.max(0, r.total_cost_usd),
    turns: int(r.num_turns),
    duration_ms: int(r.duration_ms),
    input_tokens: int(input),
    output_tokens: int(output),
  }
}

async function defaultResolveRole(home: string, name: string): Promise<Result<Role>> {
  const loaded = await loadRoles(home)
  if (!loaded.ok) return loaded
  const role = loaded.data.roles.find((r) => r.name === name)
  if (role) return ok(role)
  const issue = loaded.data.errors.find((e) => e.file.endsWith(`${name}.yaml`))
  return fail(
    'failure',
    'unknown_role',
    issue ? `角色 ${name} 不合法：${issue.message}` : `没有角色 ${name}`,
  )
}

let sdkQuery: ClaudeQueryFn | undefined
/** 动态加载真实 SDK（只在真正运行任务时发生）。 */
async function loadSdkQuery(): Promise<ClaudeQueryFn> {
  if (!sdkQuery) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    sdkQuery = sdk.query
  }
  return sdkQuery
}

export function createClaudeSdkExecutor(options: ClaudeSdkExecutorOptions): ExecutorPlugin {
  const clock = options.clock ?? systemClock
  const resolveRole = options.resolveRole ?? ((name) => defaultResolveRole(options.home, name))
  const raindownCommand = options.raindownCommand ?? ['raindown']
  const reannounceMs = options.reannounceMs ?? 1000
  const resumeGapMs = options.resumeGapMs ?? 60_000
  const cancelGraceMs = options.cancelGraceMs ?? CANCEL_GRACE_MS
  const readProjectFile = options.readProjectFile ?? defaultReadProjectFile
  const gh = options.gh ?? createGitHubCli()
  const resolveSupervisor =
    options.resolveSupervisor ??
    (async (workspace: string) => {
      const loaded = await loadWorkspaces(options.home)
      if (!loaded.ok) return loaded
      return ok(loaded.data.workspaces.find((w) => w.ref === workspace)?.supervisor)
    })

  return {
    type: CLAUDE_SDK_EXECUTOR,
    mode: 'interactive',
    adapterCapabilities: {
      approval_requests: 'structured',
      inject_while_running: true,
      resume_session: true,
      raindown_mcp: true,
      out_of_band_detection: false,
      // D1：bash 沙箱关闭时经 spawnClaudeCodeProcess 包裹外层 seatbelt；开启时原生 denyRead 只覆盖 Bash，不提供。
      // 本阶段只声明，尚未施加。
      credential_isolation: {
        layers: { 'bash-sandbox-off': 'seatbelt', 'bash-sandbox-on': 'none' },
        enforced: false,
      },
    },
    classify: classifyClaudeSdk,
    // 节点启动时清理本节点残留的审查 worktree 与私有目录（D10）。
    prepare: ({ nodeId }) => cleanupStaleReviews(options.home, nodeId, options.git),
    run(contract: TaskContract, ctx: ExecutorContext): ExecutorRun {
      const queue = new ActivityQueue()
      const input = new InputStream()
      const abortController = new AbortController()
      const pending: PendingApproval[] = []
      const seenReplies = new Set<string>()
      /** 已推给 Claude 的输入（PR 直通，按 input_seq 幂等）；首条消息发出前不注入，保证顺序。 */
      const seenInputs = new Set<number>()
      let firstSent = false
      const stderrTail: string[] = []
      const writtenFiles = new Set<string>()
      let q: ClaudeQueryHandle | undefined
      let finished = false
      /** 会话实际使用的上下文：审查任务改为 PR head 的临时 worktree 与私有目录。 */
      let sessionCtx: ExecutorContext = ctx
      /** 审查任务的准备结果（D10）；结束时移除 worktree。 */
      let review: PreparedReview | undefined
      let reviewCleaned: Promise<void> | undefined
      const cleanupReview = () => {
        if (review) reviewCleaned ??= review.cleanup()
        return reviewCleaned ?? Promise.resolve()
      }
      let session = ctx.resume?.session
      let lastText: string | undefined
      let lastMessageAt = clock.now()
      let cancelAnnounce = () => {}
      let announceDelay = reannounceMs
      /**
       * 用户看到的那条审批（tool_use_id）。节点只在 running 时接受 idle 信号、转为 blocked，
       * 所以只有"节点可能在 running"时发出的上报才会成为用户看到的那一条：
       * 运行开始、回复送达（节点随即回到 running）、发出 resumed 信号之后。
       */
      let presented: string | undefined
      let nodeMayBeRunning = true
      /** SDK 消息循环是否已经退出（子进程已结束输出）。 */
      let loopClosed = false
      let resolveLoop = () => {}
      const loopEnded = new Promise<void>((resolve) => {
        resolveLoop = resolve
      })
      let settle: (r: Result<ExecutorOutcome>) => void = () => {}
      const done = new Promise<Result<ExecutorOutcome>>((resolve) => {
        settle = resolve
      })

      const iso = () => new Date(clock.now()).toISOString()
      const output = (text: string) =>
        queue.push({ ts: iso(), kind: 'output', text: clipText(text, ACTIVITY_TEXT_MAX) })
      const status = (text: string, data?: Record<string, unknown>) =>
        queue.push({
          ts: iso(),
          kind: 'status',
          text: clipText(text, ACTIVITY_TEXT_MAX),
          ...(data ? { data } : {}),
        })
      const result = (summary: string, extra: Partial<TaskResult> = {}): TaskResult => ({
        summary: safe(summary.trim() || '（没有输出）', SUMMARY_MAX),
        artifacts: [...writtenFiles].sort().map((ref) => ({ kind: 'file', ref })),
        verify: [],
        executor: CLAUDE_SDK_EXECUTOR,
        node_id: ctx.nodeId,
        ...(session ? { session } : {}),
        ...extra,
      })

      /**
       * 结束：拒绝全部待决审批、关闭输入、中止查询，等 SDK 子进程（连同它启动的 raindown MCP 孙进程）
       * 随 abort 退出，最多 cancelGraceMs，之后 close() 强制结束，再结束活动流、给出结果。
       */
      const finish = (r: Result<ExecutorOutcome>) => {
        if (finished) return
        finished = true
        cancelAnnounce()
        for (const p of pending.splice(0)) {
          p.cancelTimer()
          p.resolve({ behavior: 'deny', message: '任务已结束', interrupt: true })
        }
        input.close()
        abortController.abort()
        ctx.signal.removeEventListener('abort', onAbort)
        const finalize = () => {
          try {
            q?.close()
          } catch {
            // 已经结束的查询再 close 可能抛出，忽略。
          }
          queue.close()
          settle(r)
        }
        if (!q || loopClosed) {
          finalize()
          return
        }
        let cancelGrace = () => {}
        const grace = new Promise<void>((resolve) => {
          cancelGrace = clock.setTimeout(resolve, cancelGraceMs)
        })
        void Promise.race([loopEnded, grace]).then(() => {
          cancelGrace()
          finalize()
        })
      }
      const onAbort = () => {
        finish(ok({ outcome: 'cancelled', message: 'claude-sdk 执行器已取消' }))
      }

      /** 上报队首的待审批请求（idle 信号）；节点在 blocked 期间会忽略，所以退避重报。 */
      const announce = () => {
        cancelAnnounce()
        const head = pending[0]
        if (!head || finished) return
        if (nodeMayBeRunning) {
          presented = head.toolUseID
          nodeMayBeRunning = false
        }
        queue.push(
          idleSignal(iso(), head.message, {
            reason: 'awaiting_approval',
            message: head.message,
            tool: head.toolName,
            tool_use_id: head.toolUseID,
            ...(head.decisionId === undefined ? {} : { decision_id: head.decisionId }),
            ...(session ? { session } : {}),
          }),
        )
        cancelAnnounce = clock.setTimeout(announce, announceDelay)
        announceDelay = Math.min(announceDelay * 2, REANNOUNCE_MAX_MS)
      }
      const resetAnnounce = () => {
        announceDelay = reannounceMs
        cancelAnnounce()
        if (pending.length > 0) cancelAnnounce = clock.setTimeout(announce, announceDelay)
      }

      /** 解决队首审批，并安排下一条的上报。 */
      const settleHead = (r: PermissionResult) => {
        const head = pending.shift()
        if (!head) return
        head.cancelTimer()
        head.resolve(r)
        resetAnnounce()
      }

      const makeCanUseTool =
        (perms: ClaudeSdkPermissions, kind: RoleKind, boundWake: boolean): CanUseTool =>
        async (toolName, toolInput, opts) => {
          if (finished) return { behavior: 'deny', message: '任务已结束', interrupt: true }
          // 有效类别为 read 的角色（tasks 5.7）：非只读工具一律拒绝，不做预检、不进审批。
          if (
            kind === 'read' &&
            !readRoleMayUse(
              toolName,
              sessionCtx.readScope?.structuredOutput === true,
              opts.mcpServer,
              boundWake ? 'wake' : undefined,
            )
          ) {
            return {
              behavior: 'deny',
              message: `只读角色不能使用 ${toolName}（只允许 Read、Grep、Glob 与只读的 Raindown 工具）`,
            }
          }
          // 结构化输出只产生结论、不访问文件：配置了 outputFormat 时直接放行，不进审批（否则审查会卡在审批上）。
          if (
            toolName === STRUCTURED_OUTPUT_TOOL &&
            sessionCtx.readScope?.structuredOutput === true
          )
            return { behavior: 'allow', updatedInput: toolInput }
          // PreToolUse 已先判定一次；这里兜底（例如钩子之外进入审批的调用），并沿用改写后的输入。
          const guard = await guardTool(perms, sessionCtx, toolName, toolInput, {
            ...(opts.mcpServer ? { mcpServer: opts.mcpServer } : {}),
          })
          if (finished || opts.signal.aborted)
            return { behavior: 'deny', message: '任务或工具调用已中止', interrupt: true }
          if (guard.kind === 'deny') return { behavior: 'deny', message: guard.message }
          if (guard.kind === 'allow') return { behavior: 'allow', updatedInput: guard.input }
          if (guard.input) toolInput = guard.input
          const summary = summarizeToolInput(toolName, toolInput)
          // ---- 策略预检（add-m1-inbox 2.3）：交给用户之前先问策略引擎。 ----
          // 只有中枢明确判定 auto / auto-report 才放行；其余结果与调用失败一律交给用户。
          const pre = ctx.precheck ? claudePrecheckRequest(toolName, toolInput) : undefined
          let decisionId: number | undefined
          if (ctx.precheck && pre) {
            const verdict = await ctx.precheck(pre)
            if (!verdict.allow) decisionId = verdict.decision_id
            if (finished) return { behavior: 'deny', message: '任务已结束', interrupt: true }
            if (verdict.allow && !opts.signal.aborted) {
              status(autoApprovedText(`${toolName}：${summary}`, verdict), {
                policy: { level: verdict.level, actions: verdict.actions, tool: toolName },
              })
              return { behavior: 'allow', updatedInput: toolInput }
            }
            if (!verdict.allow) status(safe(needsUserText(verdict), 1000))
          }
          // ---- 交给用户审批：挂起直到 deliver 送达 approve / deny，或超时。 ----
          const title = opts.title ? safe(opts.title, 300) : toolName
          const message = safe(`等待授权：${title}：${summary}`, 1000)
          return new Promise<PermissionResult>((resolve) => {
            const approval: PendingApproval = {
              toolUseID: opts.toolUseID,
              toolName,
              input: toolInput,
              message,
              ...(decisionId === undefined ? {} : { decisionId }),
              ...(pre ? { request: pre } : {}),
              resolve,
              cancelTimer: () => {},
            }
            approval.cancelTimer = clock.setTimeout(() => {
              const i = pending.indexOf(approval)
              if (i < 0) return
              pending.splice(i, 1)
              resolve({ behavior: 'deny', message: '审批超时', interrupt: true })
              const minutes = perms.approval_timeout_minutes
              finish(
                ok({
                  outcome: 'failed',
                  result: result(
                    `工具 ${toolName} 的审批等待超过 ${minutes} 分钟未获答复：${summary}`,
                    { reason: 'approval_timeout' },
                  ),
                }),
              )
            }, perms.approval_timeout_minutes * 60_000)
            opts.signal.addEventListener(
              'abort',
              () => {
                const i = pending.indexOf(approval)
                if (i < 0) return
                pending.splice(i, 1)
                approval.cancelTimer()
                resolve({ behavior: 'deny', message: '已中止', interrupt: true })
                if (i === 0) resetAnnounce()
              },
              { once: true },
            )
            pending.push(approval)
            output(`[审批] ${message}`)
            if (pending.length === 1) {
              announceDelay = reannounceMs
              announce()
            }
          })
        }

      /** 处理一条 SDK 消息：上报活动，遇到结果消息时返回它。 */
      const onMessage = (m: SDKMessage): SDKResultMessage | undefined => {
        const sid = (m as { session_id?: unknown }).session_id
        if (typeof sid === 'string' && sid) session = sid
        const now = clock.now()
        // 长时间静默后又有消息：worker 自行恢复（节点只在 blocked 时据此回到 running）。
        if (now - lastMessageAt >= resumeGapMs && pending.length === 0) {
          queue.push(resumedSignal(iso(), 'Claude 恢复了输出'))
          nodeMayBeRunning = true
        }
        lastMessageAt = now
        switch (m.type) {
          case 'system':
            if (m.subtype === 'init') {
              status(
                `Claude 会话 ${m.session_id} 已启动（模型 ${m.model}，权限 ${m.permissionMode}）`,
              )
            }
            return undefined
          case 'assistant': {
            const content = Array.isArray(m.message?.content) ? m.message.content : []
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                if (m.parent_tool_use_id === null) lastText = block.text
                output(safe(block.text, ACTIVITY_TEXT_MAX))
              } else if (block.type === 'tool_use') {
                const toolInput =
                  block.input && typeof block.input === 'object'
                    ? (block.input as Record<string, unknown>)
                    : {}
                output(`→ ${block.name}：${summarizeToolInput(block.name, toolInput)}`)
              }
            }
            return undefined
          }
          case 'result':
            return m
          default:
            return undefined
        }
      }

      const outcomeOf = (r: SDKResultMessage): ExecutorOutcome => {
        const cost = costOf(r)
        if (r.subtype === 'error_max_structured_output_retries') {
          return {
            outcome: 'failed',
            result: result(`结构化输出重试用尽，没有给出合规的结论（${r.num_turns} 轮）`, {
              reason: REVIEW_OUTPUT_INVALID,
              cost,
            }),
          }
        }
        if (r.subtype === 'success') {
          if (!r.is_error && review) {
            // 审查结论：verdict / blocking / notes 取自结构化输出，reviewed_sha 取会话前记录的 head。
            const parsed = reviewOutput.safeParse(r.structured_output)
            if (!parsed.success) {
              return {
                outcome: 'failed',
                result: result(`审查会话的结构化输出不合规：${safe(parsed.error.message, 1000)}`, {
                  reason: REVIEW_OUTPUT_INVALID,
                  cost,
                }),
              }
            }
            return {
              outcome: 'done',
              result: result(lastText ?? reviewSummary(parsed.data), {
                cost,
                review: { ...parsed.data, reviewed_sha: review.headSha },
              }),
            }
          }
          if (!r.is_error) {
            return { outcome: 'done', result: result(lastText ?? r.result, { cost }) }
          }
          return {
            outcome: 'failed',
            result: result(`Claude 报告错误：${r.result || '（无说明）'}`, {
              reason: 'sdk_error',
              cost,
            }),
          }
        }
        switch (r.subtype) {
          case 'error_max_turns':
            return {
              outcome: 'failed',
              result: result(`达到最大轮次上限（${r.num_turns} 轮），运行未完成`, {
                reason: 'max_turns',
                cost,
              }),
            }
          case 'error_max_budget_usd':
            return {
              outcome: 'failed',
              result: result(`达到费用上限（${r.total_cost_usd} 美元），运行未完成`, {
                reason: 'max_budget',
                cost,
              }),
            }
          default: {
            const errors = (r.errors ?? []).join('；')
            return {
              outcome: 'failed',
              result: result(`Claude 执行出错（${r.subtype}）${errors ? `：${errors}` : ''}`, {
                reason: 'sdk_error',
                cost,
              }),
            }
          }
        }
      }

      /**
       * 审查准备（D10）：合同带 inputs.review 且角色属于 workspace 的 reviewer_roles 时，
       * 校验登记仓库与 PR 归属、记录 head、写 diff、检出临时 worktree，并把会话上下文换成它。
       * 不是审查角色时原样运行（其结果中的 review 不会被采信）。
       */
      const prepareReviewSession = async (reviewRole: Role): Promise<Result<void>> => {
        const target = contract.inputs?.review
        if (!target) return ok(undefined)
        const sup = await resolveSupervisor(contract.workspace)
        if (!sup.ok)
          return fail(
            'failure',
            'review_prep_failed',
            `无法读取 workspace 配置：${sup.error.message}`,
          )
        // 节点上找不到该 workspace：无法判断是不是审查角色，按失败处理（不当作普通任务运行）。
        if (!sup.data)
          return fail(
            'failure',
            'review_prep_failed',
            `节点上没有 workspace ${contract.workspace}，无法核对 reviewer_roles`,
          )
        if (!sup.data.reviewer_roles.includes(reviewRole.name)) return ok(undefined)
        // 审查角色必须是只读配置（fail-closed）：有效类别 read、setting_sources 为 []、read_scope 为 cwd。
        const problem = reviewerRoleProblem(reviewRole)
        if (problem)
          return fail(
            'failure',
            'review_role_not_read',
            `审查角色 ${reviewRole.name} 不是只读配置：${problem}；不检出 PR`,
          )
        const repo = await resolveContractCwd(options.home, contract, true)
        if (!repo.ok) return repo
        if (finished) return ok(undefined)
        const prep = await prepareReview({
          home: options.home,
          nodeId: ctx.nodeId,
          taskId: ctx.taskId,
          repo: repo.data,
          pr: target.pr,
          gh,
          ...(options.git ? { git: options.git } : {}),
        })
        if (!prep.ok) return prep
        review = prep.data
        status(`审查准备完成：${review.pr.url} 的 head ${review.headSha} 已检出到临时 worktree`)
        sessionCtx = {
          ...ctx,
          cwd: review.worktree,
          readScope: {
            privateDir: review.privateDir,
            allowDotGithub: true,
            structuredOutput: true,
          },
          // 审查会话不恢复旧会话：旧会话可能看过另一个 head，回复附在新的任务说明之后。
          ...(ctx.resume ? { resume: { reply: ctx.resume.reply } } : {}),
        }
        return ok(undefined)
      }

      const main = async () => {
        const role = await resolveRole(contract.role)
        if (finished) return
        if (!role.ok) {
          finish(
            ok({
              outcome: 'failed',
              result: result(role.error.message, { reason: 'unknown_role' }),
            }),
          )
          return
        }
        const env = executorRoleEnv(role.data.name, ctx.env)
        if (!env.ok) {
          finish(
            ok({
              outcome: 'failed',
              result: result(env.error.message, { reason: env.error.code }),
            }),
          )
          return
        }
        const perms = claudeSdkPermissions.safeParse(role.data.permissions ?? {})
        if (!perms.success) {
          finish(
            ok({
              outcome: 'failed',
              result: result(
                `角色 ${role.data.name} 的 permissions 不合法：${perms.error.message}`,
                {
                  reason: 'invalid_role',
                },
              ),
            }),
          )
          return
        }
        // supervisor 会话绑定（tasks 5.3；D6）：中枢以唤醒绑定 token 认定调用方。注入 token 之前逐条核对，
        // 任何一条不满足都直接失败、不启动 SDK。
        const supervisor = await supervisorSession(role.data, contract, ctx)
        if (!supervisor.ok) {
          finish(
            ok({
              outcome: 'failed',
              result: result(supervisor.error.message, { reason: supervisor.error.code }),
            }),
          )
          return
        }
        if (finished) return
        const effort = role.data.effort
        if (effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
          finish(
            ok({
              outcome: 'failed',
              result: result(`角色 ${role.data.name} 的 effort 不合法：${effort}`, {
                reason: 'invalid_role',
              }),
            }),
          )
          return
        }
        const kind = effectiveRoleKind(role.data)
        // ---- 审查准备（D10）：只对带 inputs.review 且角色在 reviewer_roles 中的任务。 ----
        const prepared = await prepareReviewSession(role.data)
        if (finished) {
          await cleanupReview()
          return
        }
        if (!prepared.ok) {
          finish(
            ok({
              outcome: 'failed',
              result: result(prepared.error.message, { reason: prepared.error.code }),
            }),
          )
          return
        }
        // 不上报任务分支：本适配器不创建专用分支或 worktree，工作目录当前分支通常是 main 或用户的检出，
        // 不是本任务拥有的分支（push_to: task_branch、gh_scope --head 会据此放行；见 docs/executors.md）。
        if (finished) return
        // 不加载项目设置时，把项目约定文件的纯文本追加到系统提示词（不含 hooks 与权限规则）。
        // 审查任务从登记仓库读取（不是 PR 的检出），PR 不能借 CLAUDE.md / AGENTS.md 改写系统提示词。
        const instructions = perms.data.setting_sources.includes('project')
          ? undefined
          : await projectInstructions(ctx.cwd, readProjectFile)
        if (finished) return
        const query = options.query ?? (await loadSdkQuery())
        if (finished) return
        const options_ = buildOptions({
          ...(instructions ? { projectInstructions: instructions } : {}),
          role: role.data,
          env: env.data,
          perms: perms.data,
          kind,
          ctx: sessionCtx,
          home: options.home,
          raindownCommand,
          ...(supervisor.data ? { supervisor: supervisor.data } : {}),
          ...(review
            ? {
                outputFormat: { type: 'json_schema', schema: reviewOutputJsonSchema() },
                reviewGitConfig: review.gitConfig,
              }
            : {}),
          canUseTool: makeCanUseTool(perms.data, kind, supervisor.data !== undefined),
          abortController,
          writtenFiles,
          stderr: (data) => {
            for (const line of data.split('\n')) if (line.trim()) stderrTail.push(line)
            if (stderrTail.length > STDERR_KEEP)
              stderrTail.splice(0, stderrTail.length - STDERR_KEEP)
          },
        })
        // 首条用户消息：恢复会话时是回复本身，否则是任务说明（无会话可恢复时把回复附在后面）。
        const resume = sessionCtx.resume
        const taskInput = resume?.session
          ? renderReply(resume.reply)
          : [
              renderTaskPrompt(contract, sessionCtx.cwd, sessionCtx.taskId),
              ...(review ? ['', reviewPromptSection(review)] : []),
              ...(resume ? ['', renderReply(resume.reply)] : []),
            ].join('\n')
        // 恢复提示、未运行期间到达的输入（已由中枢包裹）放在派工输入开头。
        const first = [
          ...(sessionCtx.recovery ? [renderRecoveryPrompt(sessionCtx.recovery)] : []),
          ...(sessionCtx.inputs?.length ? [renderTaskInputs(sessionCtx.inputs)] : []),
          taskInput,
        ].join('\n\n')
        if (resume) seenReplies.add(resume.reply.reply_id)
        for (const i of sessionCtx.inputs ?? []) seenInputs.add(i.input_seq)
        input.push(userMessage(first))
        firstSent = true
        status(
          resume?.session
            ? `恢复 Claude 会话 ${resume.session}（${role.data.name}，模型 ${options_.model}）`
            : `启动 Claude（${role.data.name}，模型 ${options_.model}）`,
        )
        q = query({ prompt: input, options: options_ })
        let last: SDKResultMessage | undefined
        try {
          try {
            for await (const m of q) {
              if (finished) return
              const r = onMessage(m)
              if (!r) continue
              last = r
              // 运行中推入的回复还在排队（SDK 已收下但未处理，或还没读取）：等它的那一轮结束。
              if ((r.queued_turn_count ?? 0) > 0 || input.unread > 0) continue
              break
            }
          } finally {
            loopClosed = true
            resolveLoop()
          }
        } catch (err) {
          if (finished) return
          for (const line of redactLines(stderrTail)) output(line)
          finish(
            ok({
              outcome: 'exited',
              exit_code: null,
              message: `Claude 进程异常：${safe((err as Error)?.message ?? String(err), 1000)}`,
            }),
          )
          return
        }
        if (finished) return
        if (!last) {
          for (const line of redactLines(stderrTail)) output(line)
          finish(
            ok({ outcome: 'exited', exit_code: null, message: 'Claude 在给出结果之前结束了输出' }),
          )
          return
        }
        finish(ok(outcomeOf(last)))
      }

      if (ctx.signal.aborted) onAbort()
      else {
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        main().catch((err) => {
          finish(fail('failure', 'claude_sdk_error', String((err as Error)?.message ?? err)))
        })
      }

      return {
        activity: queue,
        // 结束后移除审查 worktree 与私有目录（D10），再交出结果。
        done: done.then(async (r) => {
          await cleanupReview()
          return r
        }),
        cancel: async () => {
          if (!finished) onAbort()
        },
        inject: async (i): Promise<InjectResult> => {
          if (finished || loopClosed) return 'not_running'
          if (seenInputs.has(i.input_seq)) return 'delivered'
          if (!firstSent) return 'not_now'
          seenInputs.add(i.input_seq)
          // 运行中的输入：作为用户消息推入流式输入（不解除待审批的工具调用，也不能当作批准）。
          input.push(userMessage(i.text))
          status(`已把 PR 动态（输入 ${i.input_seq}）推给 Claude`)
          return 'delivered'
        },
        deliver: async (reply): Promise<DeliverResult> => {
          if (finished) return 'not_running'
          // 按 reply_id 幂等：同一条回复只交给 Claude 一次。
          if (seenReplies.has(reply.reply_id)) return 'delivered'
          seenReplies.add(reply.reply_id)
          // 送达确认后节点回到 running：下一次上报会成为用户看到的那一条。
          nodeMayBeRunning = true
          const text = reply.text?.trim()
          const head = pending[0]
          // 答复只作用于用户看到的那条审批（按 tool_use_id 匹配，而不是队列位置）。
          if (head && head.toolUseID === presented) {
            // 只有 supervisor 的批准才复核、才可能拒收（用户的回复中枢不接受 dropped）。
            if (reply.kind === 'approve' && reply.by === SUPERVISOR_ACTOR && ctx.confirmApproval) {
              // D15：待批的工具调用不会变，但推送与 gh 环境可能已变；按预检时的请求交给节点复核。
              const live = head.request ?? claudePrecheckRequest(head.toolName, head.input)
              const confirmed = await ctx.confirmApproval(reply, live)
              if (finished) return 'not_running'
              if (!confirmed || pending[0] !== head) {
                status(
                  `回复 ${reply.reply_id}（${reply.by} 批准 ${head.toolName}）未送达：待批请求已变化或环境复查未通过`,
                )
                // 不放行；之后重新上报队首（节点以 no_delegate 交给用户）。
                delete head.decisionId
                resetAnnounce()
                return 'dropped'
              }
            }
            if (reply.kind === 'approve') {
              status(`已批准 ${head.toolName}（${reply.by}）`)
              settleHead({ behavior: 'allow', updatedInput: head.input })
            } else if (reply.kind === 'deny') {
              status(`已拒绝 ${head.toolName}（${reply.by}）`)
              settleHead({
                behavior: 'deny',
                message: text ? `用户拒绝了这次调用，理由：${text}` : '用户拒绝了这次调用',
              })
            } else {
              // 审批挂起时的文字回复：拒绝这次调用，把文字作为理由交给 Claude。
              status(`以文字回复代替审批 ${head.toolName}（${reply.by}）`)
              settleHead({
                behavior: 'deny',
                message: `用户没有批准这次调用，而是回复：${text ?? ''}`,
              })
            }
            return 'delivered'
          }
          if (head) {
            // 用户答复的那条审批已经不在了（例如被 Claude 中止）：不能套到用户没见过的请求上，
            // 文字照常推给 Claude，然后重新上报当前队首。
            if (reply.kind === 'text' && text) input.push(userMessage(renderReply(reply)))
            status(
              `回复 ${reply.reply_id}（${reply.kind}）对应的审批已失效，重新上报待审批的 ${head.toolName}`,
            )
            resetAnnounce()
            return 'delivered'
          }
          if (reply.kind === 'text' || text) {
            // 运行中的回复：作为用户消息推入流式输入。
            input.push(userMessage(renderReply(reply)))
            status(`已把 ${reply.by} 的回复推给 Claude`)
          } else {
            status(`没有待审批的请求，忽略 ${reply.kind}（${reply.by}）`)
          }
          return 'delivered'
        },
      }
    },
  }
}

/** supervisor 唤醒会话的绑定（tasks 5.3）。 */
export interface SupervisorSession {
  /** 规范化的 workspace（`ws/<id>`）。 */
  workspace: string
  taskId: string
  /** 唤醒绑定 token 文件：只以 `RAINDOWN_HUB_TOKEN_FILE` 交给 raindown MCP 进程，token 本身不进 argv 与 env。 */
  wakeTokenFile: string
  /** reply 唤醒：MCP 本地只放行只读操作（`--reply-only`）。 */
  replyOnly: boolean
}

/** `child` 的真实路径是否在 `parent` 之内（含相等）；路径不存在时按词法比较。 */
async function isWithin(child: string, parent: string): Promise<boolean> {
  const real = async (p: string) => {
    try {
      return await realpath(p)
    } catch {
      return resolve(p)
    }
  }
  const rel = relative(await real(parent), await real(child))
  // 只有 `..` 本身或以 `../` 开头才在外面；`..foo/x` 是 parent 下名为 `..foo` 的目录。
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * 注入唤醒 token 之前的核对（tasks 5.3；D6、D14）。不是 supervisor 角色返回 undefined；
 * 不满足时返回失败原因码：
 * - 有 token 文件但角色不是 supervisor → `wake_token_unexpected`；
 * - supervisor 角色不是只读配置（`supervisorRoleProblem`）→ `supervisor_role_not_read`；
 * - 租约没有下发 token → `wake_token_missing`；
 * - 合同 workspace 不合法 → `invalid_workspace`；
 * - token 文件落在会话可读的目录（cwd、任务私有目录）内 → `wake_token_unsafe`。
 */
export async function supervisorSession(
  role: Role,
  contract: TaskContract,
  ctx: Pick<ExecutorContext, 'taskId' | 'cwd' | 'wakeTokenFile' | 'readScope'>,
): Promise<Result<SupervisorSession | undefined>> {
  if (role.kind !== 'supervisor') {
    if (ctx.wakeTokenFile) {
      return fail(
        'failure',
        'wake_token_unexpected',
        `角色 ${role.name} 不是 supervisor，却领到了唤醒绑定 token`,
      )
    }
    return ok(undefined)
  }
  const problem = supervisorRoleProblem(role)
  if (problem) {
    return fail('failure', 'supervisor_role_not_read', `supervisor 角色不是只读配置：${problem}`)
  }
  if (!ctx.wakeTokenFile) {
    return fail(
      'failure',
      'wake_token_missing',
      '租约没有下发唤醒绑定 token，无法以 supervisor 身份运行',
    )
  }
  const workspace = normalizeBindingWorkspace(contract.workspace)
  if (!workspace) {
    return fail(
      'failure',
      'invalid_workspace',
      `唤醒任务的 workspace 不合法：${JSON.stringify(contract.workspace)}`,
    )
  }
  for (const dir of [ctx.cwd, ctx.readScope?.privateDir]) {
    if (dir && (await isWithin(ctx.wakeTokenFile, dir))) {
      return fail('failure', 'wake_token_unsafe', '唤醒 token 文件位于会话可读的目录内，拒绝运行')
    }
  }
  return ok({
    workspace,
    taskId: ctx.taskId,
    wakeTokenFile: ctx.wakeTokenFile,
    replyOnly: contract.inputs?.wake?.origin === 'reply',
  })
}

interface BuildOptionsInput {
  env: NodeJS.ProcessEnv
  /** `kind: supervisor` 角色的唤醒会话绑定；其他角色缺省。 */
  supervisor?: SupervisorSession
  role: Role
  perms: ClaudeSdkPermissions
  /** 角色的有效类别；read 时用 SDK `tools` 只提供只读工具（tasks 5.7）。缺省按角色计算。 */
  kind?: RoleKind
  /** 审查任务的结构化输出。 */
  outputFormat?: Options['outputFormat']
  /** 审查会话：检出时用的 git 配置覆盖，经 GIT_CONFIG_* 注入会话环境（D10）。 */
  reviewGitConfig?: readonly GitConfigPair[]
  ctx: ExecutorContext
  home: string
  raindownCommand: readonly string[]
  canUseTool: CanUseTool
  abortController: AbortController
  stderr: (data: string) => void
  /** 只由成功的 PostToolUse 记录，审批放行本身不算文件产物。 */
  writtenFiles: Set<string>
  /** setting_sources 不含 project 时读到的项目约定纯文本（已脱敏、限长）。 */
  projectInstructions?: string
}

/** 由角色与任务上下文拼出 SDK 的 `query()` 选项。 */
export function buildOptions(i: BuildOptionsInput): Options & { model: string } {
  const [command = 'raindown', ...prefix] = i.raindownCommand
  const sup = i.supervisor
  // supervisor 会话：MCP 绑定 workspace 与唤醒任务（写类只作用于该 workspace、task_create 自动填 parent），
  // MCP 进程经 RAINDOWN_HUB_TOKEN_FILE 读取唤醒 token：token 不进 argv（--mcp-config）与任何 env（D6）。
  const raindownMcp: McpStdioServerConfig = {
    type: 'stdio',
    command,
    args: [
      ...prefix,
      'mcp',
      '--actor',
      i.role.name,
      ...(sup
        ? [
            '--workspace',
            sup.workspace,
            '--task',
            sup.taskId,
            ...(sup.replyOnly ? ['--reply-only'] : []),
          ]
        : ['--task', i.ctx.taskId]),
    ],
    env: {
      ...dualRaindownEnv({ RAINDOWN_HOME: i.home, RAINDOWN_ACTOR: i.role.name }),
      ...(sup
        ? {
            ...dualRaindownEnv({
              RAINDOWN_WORKSPACE: sup.workspace,
              RAINDOWN_TASK_ID: sup.taskId,
              [HUB_TOKEN_FILE_ENV]: sup.wakeTokenFile,
            }),
          }
        : i.ctx.leaseTokenFile
          ? { RAINDOWN_LEASE_TOKEN_FILE: i.ctx.leaseTokenFile }
          : {}),
    },
  }
  const kind = i.kind ?? effectiveRoleKind(i.role)
  const readOnly = kind === 'read'
  // supervisor 会话与只读角色一样：只用注入的 Raindown MCP、不加载 claude.ai connector、内置工具只有白名单。
  const lockedDown = readOnly || sup !== undefined
  const review = i.reviewGitConfig !== undefined
  const structured = i.outputFormat !== undefined
  // 有效类别为 read：allowedTools 只保留 readRoleMayUse 为真的条目（规则取括号前的工具名），
  // 写工具或 MCP 写操作不能借 allowedTools 跳过拦截。
  const roleAllowed = readOnly
    ? i.perms.allowedTools.filter((rule) =>
        readRoleMayUse(
          rule.split('(', 1)[0]?.trim() ?? '',
          structured,
          undefined,
          sup ? 'wake' : undefined,
        ),
      )
    : i.perms.allowedTools
  // 只放行清单中的 raindown 工具（见 RAINDOWN_MCP_AUTO_ALLOWED），其余 raindown 工具走 canUseTool 审批。
  const allowedTools = [
    ...new Set([
      ...roleAllowed,
      ...(sup ? RAINDOWN_MCP_AUTO_ALLOWED : WORKER_MCP_AUTO_ALLOWED).map(
        (name) => `${RAINDOWN_MCP_TOOL_PREFIX}${name}`,
      ),
      ...(sup
        ? [...BOUND_MCP_AUTO_ALLOWED, ...SUPERVISOR_MCP_AUTO_ALLOWED].map(
            (name) => `${RAINDOWN_MCP_TOOL_PREFIX}${name}`,
          )
        : []),
      // 结构化输出（审查任务）只产生结论，不经审批。
      ...(i.outputFormat ? [STRUCTURED_OUTPUT_TOOL] : []),
    ]),
  ]
  const append = [i.role.prompt, i.projectInstructions, ...(sup ? [] : [WORKER_REPORT_CONVENTION])]
    .filter(Boolean)
    .join('\n\n')
  return {
    cwd: i.ctx.cwd,
    // SDK 默认把 process.env 整个传给 Claude Code 子进程；改用去掉中枢凭证的 env（design D9）。
    // read_scope 下 Glob 不加 --hidden / --no-ignore（CLI 2.1.310 的 CLAUDE_CODE_GLOB_* 变量）。
    env: (() => {
      const env: NodeJS.ProcessEnv = {
        ...i.env,
        ...(i.perms.read_scope ? READ_SCOPE_ENV : {}),
        // 只读角色与审查会话不加载 claude.ai connector（CLI 2.1.310 的 ENABLE_CLAUDEAI_MCP_SERVERS）。
        ...(lockedDown || review ? { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } : {}),
        // 审查会话中 Claude Code 自己运行的 git 同样不运行 hook、fsmonitor 与 filter driver。
        ...(i.reviewGitConfig
          ? { ...gitConfigEnv(i.reviewGitConfig, i.env), ...UNTRUSTED_CHECKOUT_ENV }
          : {}),
        // supervisor 会话的绑定信息（不是凭证）。
        ...(sup
          ? dualRaindownEnv({ RAINDOWN_WORKSPACE: sup.workspace, RAINDOWN_TASK_ID: sup.taskId })
          : {}),
      }
      // 防御：会话进程的 env 绝不带中枢凭证（执行器 env 已去掉，这里再删一次；token 文件路径只给 MCP）。
      for (const name of CHILD_ENV_DENYLIST) delete env[name]
      return env
    })(),
    model: i.role.model ?? DEFAULT_CLAUDE_MODEL,
    ...(i.role.effort ? { effort: i.role.effort as EffortLevel } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append },
    // 审查会话无条件不加载任何设置来源（角色配置已核对，这里再兜底）。
    settingSources: review ? [] : [...i.perms.setting_sources],
    mcpServers: { raindown: raindownMcp },
    // 只读角色与审查会话只用注入的 Raindown MCP：忽略 .mcp.json、用户设置、插件中的 MCP 服务器。
    ...(lockedDown || review ? { strictMcpConfig: true } : {}),
    // 角色显式写 auto / bypassPermissions 时照原样传递；缺省为 default（见 claudeSdkPermissions）。
    permissionMode: i.perms.permissionMode,
    ...(i.perms.permissionMode === 'bypassPermissions'
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    // 有效类别为 read：可用的内置工具只有白名单（Raindown MCP 不受 tools 影响）。
    ...(lockedDown ? { tools: [...READ_ROLE_TOOLS] } : {}),
    ...(i.outputFormat ? { outputFormat: i.outputFormat } : {}),
    allowedTools,
    disallowedTools: i.perms.disallowedTools,
    ...(i.perms.maxTurns ? { maxTurns: i.perms.maxTurns } : {}),
    canUseTool: i.canUseTool,
    // canUseTool 可能被 SDK 权限模式、允许规则或会话批准跳过；每次文件调用仍要经过本地边界。
    // 只读角色始终安装：allowedTools 或权限模式放行的调用也要经过 readRoleMayUse。
    ...(readOnly || i.perms.writable_paths !== undefined || i.perms.read_scope !== undefined
      ? {
          hooks: {
            PreToolUse: [
              {
                // SDK 0.3.310 的类型示例省略 matcher，表示匹配所有此类事件。
                // 未知的非 MCP 路径工具也必须经过 fail-closed 判定。
                hooks: [
                  async (input) => {
                    if (input.hook_event_name !== 'PreToolUse') return {}
                    if (
                      readOnly &&
                      !readRoleMayUse(
                        input.tool_name,
                        i.ctx.readScope?.structuredOutput === true,
                        input.mcp_server,
                        sup ? 'wake' : undefined,
                      )
                    ) {
                      return {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'deny',
                          permissionDecisionReason: `只读角色不能使用 ${input.tool_name}`,
                        },
                      }
                    }
                    const guard = await guardTool(
                      i.perms,
                      i.ctx,
                      input.tool_name,
                      input.tool_input,
                      {
                        sessionCwd: input.cwd,
                        ...(input.mcp_server ? { mcpServer: input.mcp_server } : {}),
                      },
                    )
                    if (guard.kind === 'pass')
                      // 没有 permissionDecision 的 updatedInput 只改写输入，权限流程照常继续（CLI 2.1.310）。
                      return guard.input
                        ? {
                            hookSpecificOutput: {
                              hookEventName: 'PreToolUse',
                              updatedInput: guard.input,
                            },
                          }
                        : {}
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: guard.kind,
                        ...(guard.kind === 'deny'
                          ? { permissionDecisionReason: guard.message }
                          : { updatedInput: guard.input }),
                      },
                    }
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                matcher: CLAUDE_FILE_WRITE_MATCHER,
                hooks: [
                  async (input) => {
                    if (input.hook_event_name !== 'PostToolUse') return {}
                    const write = await checkWritableTool(
                      input.tool_name,
                      input.tool_input,
                      i.ctx.cwd,
                      i.perms.writable_paths,
                    )
                    if (write?.behavior === 'allow') i.writtenFiles.add(write.path)
                    return {}
                  },
                ],
              },
            ],
          },
        }
      : {}),
    abortController: i.abortController,
    ...(i.ctx.resume?.session ? { resume: i.ctx.resume.session } : {}),
    stderr: i.stderr,
  }
}

type ToolGuard =
  | { kind: 'deny'; message: string }
  | { kind: 'allow'; input: Record<string, unknown> }
  /** 交还 SDK 权限流程；`input` 为改写后的输入（未改写时缺省）。 */
  | { kind: 'pass'; input?: Record<string, unknown> }

/**
 * 钩子与 canUseTool 共用的本地边界：先判读边界（只拒绝或改写），再按写白名单放行或拒绝。
 * 任何异常都按拒绝处理。
 */
async function guardTool(
  perms: ClaudeSdkPermissions,
  ctx: ExecutorContext,
  toolName: string,
  toolInput: unknown,
  call: ReadScopeCall,
): Promise<ToolGuard> {
  try {
    let input = toolInput
    let rewritten: Record<string, unknown> | undefined
    if (perms.read_scope) {
      const read = await checkReadScope(toolName, toolInput, readScopeContext(ctx), call)
      if (read?.behavior === 'deny') return { kind: 'deny', message: read.message }
      if (read) input = rewritten = read.updatedInput
    }
    const write = await checkWritableTool(toolName, input, ctx.cwd, perms.writable_paths)
    if (write?.behavior === 'deny') return { kind: 'deny', message: write.message }
    if (write?.behavior === 'allow')
      return {
        kind: 'allow',
        input: { ...(input as Record<string, unknown>), file_path: write.path },
      }
    return rewritten ? { kind: 'pass', input: rewritten } : { kind: 'pass' }
  } catch (err) {
    return {
      kind: 'deny',
      message: `本地文件边界检查出错，拒绝本次调用：${safe(String((err as Error)?.message ?? err), 300)}`,
    }
  }
}

/** 合同 cwd 加节点注入的私有目录与 `.github/` 选项。 */
function readScopeContext(ctx: ExecutorContext): ReadScopeContext {
  return {
    cwd: ctx.cwd,
    ...(ctx.readScope?.privateDir !== undefined ? { privateDir: ctx.readScope.privateDir } : {}),
    ...(ctx.readScope?.allowDotGithub ? { allowDotGithub: true } : {}),
    ...(ctx.readScope?.structuredOutput ? { structuredOutput: true } : {}),
  }
}

/** 审查结论的可读摘要（会话没有留下文字时使用）。 */
function reviewSummary(r: ReviewOutput): string {
  const head =
    r.verdict === 'approve' ? '审查结论：approve（没有阻塞问题）' : '审查结论：changes_requested'
  return [head, ...r.blocking.map((b) => `- ${b}`), ...(r.notes ? ['', r.notes] : [])].join('\n')
}

async function defaultReadProjectFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 读取 cwd 下的项目约定文件（CLAUDE.md、AGENTS.md）作为纯文本：每个文件限长、经脱敏。
 * 只取文本，不解释 `@` 引用，不加载 hooks 与权限规则。没有任何文件时返回 undefined。
 */
export async function projectInstructions(
  cwd: string,
  read: (path: string) => Promise<string | undefined> = defaultReadProjectFile,
): Promise<string | undefined> {
  const parts: string[] = []
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const text = (await read(join(cwd, name)))?.trim()
    if (!text) continue
    parts.push(`## ${name}\n\n${safe(text, PROJECT_INSTRUCTION_MAX)}`)
  }
  if (parts.length === 0) return undefined
  return [
    '# 项目约定（Raindown 读取的纯文本，未加载该仓库的 Claude Code 设置、hooks 与权限规则）',
    '',
    ...parts,
  ].join('\n')
}
