import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { raindownPaths } from './home.ts'
import { executorType } from './ledger/common.ts'
import { isDeclarableActor } from './ledger/protocol.ts'
import type { TaskContract } from './ledger/task.ts'
import { fail, ok, type Result } from './result.ts'
import { formatZodIssues, type ValidationIssue } from './validation-issue.ts'
import { isValidActor, USER_ACTOR } from './write/policy.ts'

/** 当前内置的执行器类型；角色 schema 不限定此列表，由 doctor 检查可用性。 */
export const KNOWN_EXECUTORS = [
  'fake',
  'codex-orca',
  'claude-sdk',
  'codex-exec',
  'pr-merge',
] as const

/**
 * 保留 actor `supervisor`（design D7、D9、D15）：`kind: supervisor` 角色的名字必须正是它，
 * 名字不区分大小写地等于它、但类别不是 supervisor 的角色也在加载时报错。
 */
export const SUPERVISOR_ACTOR = 'supervisor'

/** 角色类别（design D9）。严格程度：supervisor、merge > write > read。 */
export const ROLE_KINDS = ['read', 'write', 'merge', 'supervisor'] as const
export const roleKind = z.enum(ROLE_KINDS).meta({
  description:
    '角色类别：read | write | merge | supervisor；与按配置推断的类别取更严格者（声明只能收紧）；supervisor 必须显式声明且只能用于 claude-sdk',
})
export type RoleKind = z.infer<typeof roleKind>

/**
 * `creatable_by` 中的一项：`*`；`<前缀>:*` 形式的前缀通配（例如 `node:*`、`remote:*`）；
 * 或精确的操作者标识（与 ACTOR_RE 相同的格式）。写成单个正则，导出的 JSON Schema 也带上同样的约束。
 */
const ACTOR_PATTERN_RE =
  /^(?:\*|[A-Za-z0-9][A-Za-z0-9._:@-]{0,62}:\*|[A-Za-z0-9][A-Za-z0-9._:@-]{0,63})$/

export const actorPattern = z
  .string()
  .regex(
    ACTOR_PATTERN_RE,
    '应为操作者标识（如 user、node:n-abc）、前缀通配（如 node:*、remote:*）或 *',
  )
  .meta({ description: '操作者模式：精确值，或 `*`、`<前缀>:*` 形式的前缀通配' })

/** 操作者是否匹配模式：`*` 匹配全部；`<前缀>:*` 匹配以 `<前缀>:` 开头的身份；其余精确比较（区分大小写）。 */
export function actorMatches(pattern: string, actor: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1)
    return actor.length > prefix.length && actor.startsWith(prefix)
  }
  return pattern === actor
}

/**
 * 某身份能否创建该角色的任务：`user` 永远可以；其他身份必须匹配 `creatable_by` 中的某一项。
 * 字段缺省时只有 `user` 可以创建（默认拒绝 AI 与节点）。
 */
export function canCreateRole(role: Pick<Role, 'creatable_by'>, actor: string): boolean {
  if (actor === USER_ACTOR) return true
  return (role.creatable_by ?? []).some((p) => actorMatches(p, actor))
}

export const writablePaths = z.array(z.string().min(1)).meta({
  description:
    '仅 claude-sdk 可配置，其他执行器报配置错误；cwd 相对路径 glob（*、**、?，不支持花括号）；原路径与真实路径都须匹配，硬性禁止 ..、越界、隐藏路径、代理指令文件及 NotebookEdit，禁写名称按 NFKC 和 Unicode 大小写折叠比较；[] 禁止全部，缺省沿用原有审批',
})

export const readScope = z.enum(['cwd']).meta({
  description:
    '仅 claude-sdk 可配置，其他执行器报配置错误；cwd：所有工具的路径类参数只能落在合同 cwd 与任务私有目录内，拒绝 ~、..、隐藏路径段、绝对 glob 与符号链接越界，只允许白名单内置工具与字段（Bash、WebFetch、非 Raindown 的 MCP 等一律拒绝）；Raindown MCP 不受影响',
})

/**
 * 角色的隔离要求（add-worker-credential-isolation 6.1）：
 * - `required`：只派给对该执行器 × 该角色沙箱设置隔离已施加且自检通过的节点；不满足时任务 `blocked(other)`，
 *   原因 `isolation_unavailable`，不启动 harness；
 * - `preferred`（缺省）：照常派送，节点未隔离时在任务与收件箱标明“未隔离”；
 * - `off`：不检查、不标注。
 */
export const ROLE_ISOLATION_LEVELS = ['required', 'preferred', 'off'] as const
export const roleIsolation = z.enum(ROLE_ISOLATION_LEVELS).meta({
  description:
    '隔离要求：required 只派给隔离已施加且自检通过的节点，否则任务 blocked(other)（isolation_unavailable）、不启动 harness；preferred（缺省）照常派送，未隔离时在任务与收件箱标明；off 不检查。supervisor 角色与 pr-merge 不支持 required',
})
export type RoleIsolation = z.infer<typeof roleIsolation>
/** 缺省为 preferred。 */
export const DEFAULT_ROLE_ISOLATION: RoleIsolation = 'preferred'

/** 角色的有效隔离要求（缺省 preferred）。 */
export const roleIsolationOf = (role: Partial<Pick<Role, 'isolation'>> | null | undefined) =>
  role?.isolation ?? DEFAULT_ROLE_ISOLATION

/**
 * `isolation: required` 在这些配置下不可满足，加载时拒绝（doctor 报错）：
 * supervisor 唤醒会话（沙箱设置 supervisor-session，按设计不施加外层隔离）与 pr-merge（in-node，不启动 harness）。
 */
export function requiredIsolationUnsupported(
  role: Pick<Role, 'executor'> & Partial<Pick<Role, 'kind'>>,
): string | undefined {
  if (role.executor === 'pr-merge')
    return '执行器 pr-merge 在节点内执行（in-node），不支持隔离，不能设为 isolation: required'
  if (role.executor === 'claude-sdk' && role.kind === 'supervisor')
    return 'supervisor 唤醒会话（supervisor-session）不支持隔离，不能设为 isolation: required'
  return undefined
}

export const roleSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .refine((name) => name !== USER_ACTOR && isValidActor(name) && isDeclarableActor(name), {
        message: '角色名必须是合法且可声明的 AI 身份，不能使用 user、保留身份或 node: 前缀',
      })
      .meta({ description: '可声明的 AI 角色名，与 YAML 文件名（不含扩展名）一致' }),
    executor: executorType,
    kind: roleKind.optional(),
    prompt: z.string().min(1).meta({
      description: '内联提示词；同目录的 .md 文件名视为文件引用，文件必须存在',
    }),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    permissions: z
      .looseObject({ writable_paths: writablePaths.optional(), read_scope: readScope.optional() })
      .optional()
      .meta({ description: '执行器专用权限设置；其余字段由执行器校验' }),
    no_progress_minutes: z.number().int().positive().optional(),
    creatable_by: z.array(actorPattern).optional().meta({
      description:
        '除 user 之外，允许哪些身份创建该角色的任务（精确值或 node:*、remote:*、* 等前缀通配）；缺省时只有 user 可以创建',
    }),
    isolation: roleIsolation.optional(),
  })
  .superRefine((role, ctx) => {
    if (role.kind === 'supervisor' && role.executor !== 'claude-sdk') {
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: 'kind: supervisor 只能用于 claude-sdk 执行器',
      })
    }
    if (role.name.toLowerCase() === SUPERVISOR_ACTOR && role.kind !== 'supervisor') {
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'supervisor 是保留身份，只能用作 kind: supervisor 角色的名字',
      })
    } else if (role.kind === 'supervisor' && role.name !== SUPERVISOR_ACTOR) {
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'kind: supervisor 角色的名字必须是小写 supervisor（保留身份）',
      })
    }
    if (role.permissions?.writable_paths !== undefined && role.executor !== 'claude-sdk') {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions', 'writable_paths'],
        message: 'writable_paths 仅适用于 claude-sdk 执行器',
      })
    }
    const unsupported =
      role.isolation === 'required' ? requiredIsolationUnsupported(role) : undefined
    if (unsupported) ctx.addIssue({ code: 'custom', path: ['isolation'], message: unsupported })
    if (role.permissions?.read_scope !== undefined && role.executor !== 'claude-sdk') {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions', 'read_scope'],
        message: 'read_scope 仅适用于 claude-sdk 执行器',
      })
    }
  })
  .meta({ title: 'Raindown role config', description: 'config/roles/<name>.yaml' })
export type Role = z.infer<typeof roleSchema>

export interface RoleSet {
  roles: Role[]
  /** 出错文件不会加载；路径相对 raindown-home，字段路径以点连接。 */
  errors: ValidationIssue[]
}

/** 目录不存在时返回空集；逐文件加载，单个文件错误不影响其他角色。 */
export async function loadRoles(home: string): Promise<Result<RoleSet>> {
  const dir = raindownPaths(home).roles
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.yaml') && !n.startsWith('.')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ok({ roles: [], errors: [] })
    return fail('failure', 'read_failed', `无法读取 ${dir}：${String(err)}`)
  }
  const roles: Role[] = []
  const errors: ValidationIssue[] = []
  for (const name of names) {
    const path = join(dir, name)
    const file = relative(home, path)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      errors.push({ file, code: 'read_failed', message: `无法读取角色文件：${String(err)}` })
      continue
    }
    let input: unknown
    try {
      input = parse(text)
    } catch (err) {
      errors.push({ file, code: 'invalid_yaml', message: `不是合法的 YAML：${String(err)}` })
      continue
    }
    const parsed = roleSchema.safeParse(input)
    if (!parsed.success) {
      errors.push(...formatZodIssues(parsed.error.issues, input, { file }))
      continue
    }
    const role = parsed.data
    if (role.name !== name.slice(0, -5)) {
      errors.push({
        file,
        field: 'name',
        code: 'role_name_mismatch',
        message: `角色名 ${role.name} 与文件名 ${name} 不一致`,
      })
      continue
    }
    // 只解释同目录的文件名；含路径的文本保持内联，不读取目录外的文件。
    if (role.prompt.endsWith('.md') && basename(role.prompt) === role.prompt) {
      try {
        role.prompt = await readFile(join(dir, role.prompt), 'utf8')
      } catch (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
        errors.push({
          file,
          field: 'prompt',
          code: missing ? 'prompt_file_missing' : 'read_failed',
          message: missing ? `提示词文件 ${role.prompt} 不存在` : String(err),
        })
        continue
      }
    }
    roles.push(role)
  }
  return ok({ roles, errors })
}

const KIND_RANK: Record<RoleKind, number> = { read: 0, write: 1, merge: 2, supervisor: 3 }

/** 允许后就能改文件或执行命令的工具；`Bash` 不论是否带括号规则都算写（design D9）。 */
const CLAUDE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
/**
 * claude-sdk 推断为 read 时 `disallowedTools` 必须逐项列出的工具（design D9）：没有禁用的工具会进入
 * Raindown 审批，可能被 auto 规则或 supervisor 代回复放行。
 */
export const CLAUDE_READ_REQUIRED_DISALLOWED = [
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
] as const
/** 不经 canUseTool 就会放行编辑或任意调用的权限模式。 */
const CLAUDE_WRITE_MODES = new Set(['acceptEdits', 'bypassPermissions', 'auto'])
/**
 * codex-exec 的 `permissions.config` 中不会启动进程或改变沙箱的键（design D9）；
 * 出现其他任何键都推断为 write（例如 MCP 服务器、通知命令、shell 环境、沙箱设置）。
 */
export const CODEX_EXEC_READ_SAFE_CONFIG_KEYS = ['model', 'model_reasoning_effort'] as const

/**
 * 推断时认识的权限键（与 node 执行器的权限 schema 对应；`read_scope` 只收紧读取范围）。
 * 出现其他键一律推断为 write：无法判断它的效果，方向保守。
 */
export const CLAUDE_SDK_KNOWN_PERMISSION_KEYS = [
  'permissionMode',
  'allowedTools',
  'disallowedTools',
  'writable_paths',
  'maxTurns',
  'approval_timeout_minutes',
  'setting_sources',
  'read_scope',
] as const
export const CODEX_EXEC_KNOWN_PERMISSION_KEYS = ['sandbox', 'config'] as const

const hasUnknownKey = (
  permissions: Record<string, unknown> | undefined,
  known: readonly string[],
) => Object.keys(permissions ?? {}).some((k) => !known.includes(k))

/** `Edit`、`Edit(src/**)`、`Bash(gh pr review:*)` 等允许规则取括号前的工具名。 */
const ruleTool = (rule: string) => rule.split('(', 1)[0]?.trim() ?? ''

const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null

function claudeSdkWrites(permissions: Record<string, unknown> | undefined): boolean {
  const p = permissions ?? {}
  if (hasUnknownKey(p, CLAUDE_SDK_KNOWN_PERMISSION_KEYS)) return true
  if (p.writable_paths !== undefined) return true
  // setting_sources 缺省时执行器用 ['project']；含任何来源时仓库 .claude/settings.json 的
  // permissions.allow 与 hooks 都会生效，只有显式 [] 才可能是 read。
  const sources = stringList(p.setting_sources)
  if (!sources || sources.length > 0) return true
  if (p.permissionMode !== undefined) {
    if (typeof p.permissionMode !== 'string' || CLAUDE_WRITE_MODES.has(p.permissionMode))
      return true
  }
  const disallowed = new Set(stringList(p.disallowedTools) ?? [])
  if (!CLAUDE_READ_REQUIRED_DISALLOWED.every((t) => disallowed.has(t))) return true
  const allowed = p.allowedTools === undefined ? [] : stringList(p.allowedTools)
  if (!allowed) return true
  return allowed.some((rule) => rule === '*' || CLAUDE_WRITE_TOOLS.has(ruleTool(rule)))
}

function codexExecWrites(permissions: Record<string, unknown> | undefined): boolean {
  if (hasUnknownKey(permissions, CODEX_EXEC_KNOWN_PERMISSION_KEYS)) return true
  const sandbox = permissions?.sandbox
  if (sandbox !== undefined && sandbox !== 'read-only') return true
  const config = permissions?.config
  if (config === undefined) return false
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return true
  const safe: readonly string[] = CODEX_EXEC_READ_SAFE_CONFIG_KEYS
  return Object.keys(config).some((k) => !safe.includes(k))
}

/**
 * 按配置推断的类别（design D9）：
 * - codex-orca → write；
 * - codex-exec：沙箱为只读（缺省即只读）且 `config` 只含 CODEX_EXEC_READ_SAFE_CONFIG_KEYS → read，否则 write；
 * - claude-sdk：以下全部满足才是 read，否则 write——`setting_sources` 显式为 `[]`；没有 writable_paths；
 *   权限模式不是 acceptEdits / bypassPermissions / auto；`disallowedTools` 列出
 *   CLAUDE_READ_REQUIRED_DISALLOWED 全部工具；`allowedTools` 中没有 Edit/Write/MultiEdit/NotebookEdit 与任何 Bash 规则；
 * - pr-merge → merge；
 * - 其他执行器（含 fake 与未知类型）按 write 处理；
 * - codex-exec、claude-sdk 的 permissions 中出现推断不认识的键 → write。
 * 这只是配置层判断；read 角色的只读最终由执行器强制（tasks 5.7）。
 * 推断结果永远不是 supervisor：它必须显式声明。
 */
export function inferRoleKind(role: Pick<Role, 'executor' | 'permissions'>): RoleKind {
  switch (role.executor) {
    case 'pr-merge':
      return 'merge'
    case 'codex-exec':
      return codexExecWrites(role.permissions) ? 'write' : 'read'
    case 'claude-sdk':
      return claudeSdkWrites(role.permissions) ? 'write' : 'read'
    default:
      return 'write'
  }
}

/** 有效类别：声明与推断中更严格者（声明只能收紧）。中枢据此判定建任务与委托的权限。 */
export function effectiveRoleKind(role: Pick<Role, 'executor' | 'permissions' | 'kind'>): RoleKind {
  const inferred = inferRoleKind(role)
  if (!role.kind) return inferred
  return KIND_RANK[role.kind] >= KIND_RANK[inferred] ? role.kind : inferred
}

/**
 * 在角色集合中找唯一的 supervisor 角色（按有效类别）：没有返回 null；多于一个返回
 * `multiple_supervisor_roles`；不满足 `supervisorRoleProblem`（必须是只读配置且设 `read_scope: cwd`）返回
 * `supervisor_role_not_read`。失败时中枢不唤醒 supervisor，doctor 报错。
 */
export function findSupervisorRole(roles: readonly Role[]): Result<Role | null> {
  const found = roles.filter((r) => effectiveRoleKind(r) === 'supervisor')
  if (found.length > 1) {
    return fail(
      'failure',
      'multiple_supervisor_roles',
      `最多只能有一个 kind: supervisor 角色，现有：${found.map((r) => r.name).join('、')}`,
    )
  }
  const role = found[0]
  const problem = role ? supervisorRoleProblem(role) : undefined
  if (role && problem) {
    return fail(
      'failure',
      'supervisor_role_not_read',
      `supervisor 角色 ${role.name} 不是只读配置：${problem}`,
      { role: role.name, problem },
    )
  }
  return ok(role ?? null)
}

/**
 * supervisor 角色必须是只读配置（add-m1-supervisor D6、D14，fail-closed）：执行器为 claude-sdk、
 * 按配置推断的类别为 read（声明的 `kind: supervisor` 不放宽它）、`setting_sources` 显式为 `[]`、
 * `read_scope` 为 `cwd`（会话读不到 `state/` 下的唤醒 token 文件与 `hub.token`）。
 * 返回第一条不满足的原因；满足时返回 undefined。`findSupervisorRole`、doctor 与节点执行器
 * （`failed(supervisor_role_not_read)`）共用。
 */
export function supervisorRoleProblem(
  role: Pick<Role, 'executor' | 'permissions' | 'kind'>,
): string | undefined {
  if (role.executor !== 'claude-sdk')
    return `执行器为 ${role.executor}，supervisor 只能用 claude-sdk`
  const inferred = inferRoleKind(role)
  if (inferred !== 'read')
    return `按配置推断的类别为 ${inferred}（writable_paths、写工具或 Bash 允许规则、宽松的权限模式，或未禁用 ${CLAUDE_READ_REQUIRED_DISALLOWED.join('/')}），必须是 read`
  const p = role.permissions ?? {}
  const sources = stringList(p.setting_sources)
  if (!sources || sources.length > 0) return 'permissions.setting_sources 必须显式写成 []'
  if (p.read_scope !== 'cwd') return 'permissions.read_scope 必须是 cwd'
  return undefined
}

/**
 * 审查角色（workspace `supervisor.reviewer_roles`）必须是只读配置（add-m1-supervisor D10，fail-closed）：
 * 执行器为 claude-sdk、有效类别为 read、`setting_sources` 显式为 `[]`、`read_scope` 为 `cwd`。
 * 返回第一条不满足的原因；满足时返回 undefined。执行器据此拒绝检出（`review_role_not_read`），doctor 报 error。
 */
export function reviewerRoleProblem(
  role: Pick<Role, 'executor' | 'permissions' | 'kind'>,
): string | undefined {
  if (role.executor !== 'claude-sdk') return `执行器为 ${role.executor}，审查角色只能用 claude-sdk`
  const kind = effectiveRoleKind(role)
  if (kind !== 'read') return `有效类别为 ${kind}，审查角色必须是 read`
  const p = role.permissions ?? {}
  const sources = stringList(p.setting_sources)
  if (!sources || sources.length > 0) return 'permissions.setting_sources 必须显式写成 []'
  if (p.read_scope !== 'cwd') return 'permissions.read_scope 必须是 cwd'
  return undefined
}

/** 任务有效类别比较用的次序（merge 与 supervisor 同级，与角色加载时的次序不同）。 */
const TASK_KIND_RANK: Record<RoleKind, number> = { read: 0, write: 1, merge: 2, supervisor: 2 }
const stricter = (a: RoleKind, b: RoleKind): RoleKind =>
  TASK_KIND_RANK[b] > TASK_KIND_RANK[a] ? b : a

/** 角色查找结果中参与类别判定的字段（测试注入的查找可以只给 name 与 creatable_by）。 */
export type RoleForKind = Pick<Role, 'name'> &
  Partial<Pick<Role, 'executor' | 'permissions' | 'kind'>>

/**
 * 新任务的有效类别（D9）。节点按**合同**的 `executor` 运行、按角色取权限，所以取两者中更严格者：
 * 角色自身的有效类别，与"用角色权限跑合同执行器"推断出的类别。角色未定义（只有 user 会走到这里）时
 * 只按合同执行器推断。比如 `role: triage`（read）配 `executor: codex-orca` 时为 write。
 *
 * 合同 `verify` 由节点在沙箱外直接执行，所以**非 user 身份**建的任务只要带 verify，至少按 write 计
 * （`opts.actor` 缺省时按非 user 处理）。
 */
export function taskKind(
  role: RoleForKind | null,
  contract: Pick<TaskContract, 'executor'> & Partial<Pick<TaskContract, 'verify'>>,
  opts: { actor?: string } = {},
): RoleKind {
  const viaContract = inferRoleKind({
    executor: contract.executor,
    ...(role?.permissions === undefined ? {} : { permissions: role.permissions }),
  })
  let kind: RoleKind
  if (!role || role.executor === undefined) {
    kind = role?.kind ? stricter(role.kind, viaContract) : viaContract
  } else {
    const own = effectiveRoleKind({
      executor: role.executor,
      ...(role.permissions === undefined ? {} : { permissions: role.permissions }),
      ...(role.kind === undefined ? {} : { kind: role.kind }),
    })
    kind = stricter(own, viaContract)
  }
  if (opts.actor !== USER_ACTOR && (contract.verify?.length ?? 0) > 0) {
    kind = stricter(kind, 'write')
  }
  return kind
}
