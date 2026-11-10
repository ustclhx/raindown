import { randomBytes } from 'node:crypto'
import {
  type CancelTaskData,
  type CreateTaskData,
  canCreateRole,
  checkContractSecrets,
  createTaskRequest,
  decide,
  decideVerifySteps,
  defaultSupervisorConfig,
  fail,
  foldTaskAttempts,
  formatZodIssues,
  hiddenFromWorker,
  type InboxVia,
  isKnownEventType,
  isWaitingHumanStage,
  type ListTasksData,
  listTasksQuery,
  loadRoles,
  loadWorkspaces,
  normalizePrUrl,
  ok,
  type PolicyConfig,
  policyVersion,
  RETRYABLE_BLOCKED_REASONS,
  type ReplyKind,
  type ReplyTaskData,
  type Result,
  type RetryTaskData,
  type Role,
  redactSecrets,
  replyTaskRequest,
  retryTaskRequest,
  reviewTaskGoal,
  type ShowTaskData,
  type ShowTaskQuery,
  SUPERVISOR_ACTOR,
  samePrUrl,
  showTaskQuery,
  type TaskContract,
  type TaskOrigin,
  type TaskShowResponse,
  type TaskView,
  type UnsubscribeTaskData,
  USER_ACTOR,
  unsubscribeTaskRequest,
  type VerifyStep,
  type VerifyVerdict,
  type WakeInputs,
  type Workspace,
  wakeInputs,
} from '@raindown/core'
import { auditRules } from '../policy/service.ts'
import { redactDeep } from '../secrets/redactor.ts'
import {
  observeAutonomous,
  prSourcedTask,
  prSourcedWake,
  recordObservedAction,
} from '../supervisor/observe.ts'
import type { EventInput, LedgerStore } from './store.ts'
import {
  chainDepth,
  checkRepoInWorkspace,
  computeOrigin,
  HUB_ACTOR,
  isReservedIdempotencyKey,
  isReviewTask,
  isTaskProposalKey,
  isTerminal,
  prsForNewTask,
  type RepoCheckOptions,
  type RoleForKind,
  reservedCapabilitiesIn,
  taskKind,
  wakePrs,
} from './supervisor-checks.ts'
import { readTaskStage, stageFromEvents } from './task-stage.ts'

/**
 * 任务服务（tasks.md 2.3；task-ledger spec "任务合同""幂等创建""取消"）。
 * HTTP 路由与以后的反应器都经由它操作任务，不直接拼事件。
 */

/** workspace 是否存在。中枢里用 `workspaceCheckFromHome`，测试可注入任意函数。 */
export type WorkspaceCheck = (ref: string) => boolean | Promise<boolean>

/** 基于 raindown-home 的 `config/workspaces/` 检查（每次调用都重新读取，配置改动无需重启）。 */
export function workspaceCheckFromHome(home: string): WorkspaceCheck {
  return async (ref) => {
    const loaded = await loadWorkspaces(home)
    return loaded.ok && loaded.data.workspaces.some((w) => w.ref === ref)
  }
}

/** 建任务校验需要的 workspace 信息：登记仓库与 supervisor 设置；github 缺省视为不关注 PR。 */
export type WorkspaceInfo = Pick<Workspace, 'ref' | 'repos' | 'supervisor'> &
  Partial<Pick<Workspace, 'github'>>

/** 按 ref 查 workspace：未定义时为 null。 */
export type WorkspaceLookup = (ref: string) => Promise<WorkspaceInfo | null>

/** 基于 raindown-home 的 `config/workspaces/`（每次调用都重新读取）。 */
export function workspaceLookupFromHome(home: string): WorkspaceLookup {
  return async (ref) => {
    const loaded = await loadWorkspaces(home)
    return loaded.ok ? (loaded.data.workspaces.find((w) => w.ref === ref) ?? null) : null
  }
}

/**
 * 按名字查角色：不存在（或该角色文件有错、未能加载）时为 null。
 * `executor`、`permissions`、`kind` 用于有效类别（D9）；测试注入的查找可以省略，省略时按合同执行器推断。
 */
export type RoleLookup = (
  name: string,
) => Promise<Result<(Pick<Role, 'name' | 'creatable_by'> & RoleForKind) | null>>

/**
 * 基于 raindown-home 的 `config/roles/`（复用 core 的 loadRoles）：与 workspaceCheckFromHome 一样每次调用都重新读取，
 * 修改 `creatable_by` 后下一次创建请求即生效，无需重启中枢。
 */
export function roleLookupFromHome(home: string): RoleLookup {
  return async (name) => {
    const loaded = await loadRoles(home)
    if (!loaded.ok) {
      return fail(
        'failure',
        'unknown_role',
        `角色 ${name} 未定义或加载失败，运行 raindown doctor 查看`,
        {
          field: 'role',
          role: name,
        },
      )
    }
    return ok(loaded.data.roles.find((r) => r.name === name) ?? null)
  }
}

/**
 * 任务 id：`t-<UTC yyyymmdd>-<UTC hhmmss>-<6 位十六进制随机数>`，例如 `t-20261024-083015-3fa9c2`。
 * - 满足 `LEDGER_ID_RE`（字母数字开头，只含 `-`）；
 * - 按字典序大致等于创建时间顺序，人读起来也能看出创建时刻；
 * - 同一秒内靠 24 位随机数区分，碰撞时（极少）重新生成。
 */
export function generateTaskId(nowMs: number, random: () => string = defaultRandom): string {
  const s = new Date(nowMs).toISOString() // 2026-10-24T08:30:15.123Z
  return `t-${s.slice(0, 10).replaceAll('-', '')}-${s.slice(11, 19).replaceAll(':', '')}-${random()}`
}
const defaultRandom = () => randomBytes(3).toString('hex')

/** 回复 id：`r-<16 位十六进制>`。 */
export const generateReplyId = () => `r-${randomBytes(8).toString('hex')}`

/**
 * 各卡住原因接受的回复类型（task-interaction "审批答复不能用于提问"）：
 * awaiting_approval 接受 approve / deny / 文字，其余原因（question、no_progress、crashed…）只接受文字。
 */
export function acceptedReplyKinds(
  reason: string | undefined,
  priorReason?: string,
): readonly ReplyKind[] {
  // 节点掉线（node_lost）前在等授权：仍然可以 approve / deny（PR #16 复核第 5 条）。
  const effective = reason === 'node_lost' && priorReason ? priorReason : reason
  return effective === 'awaiting_approval' ? ['approve', 'deny', 'text'] : ['text']
}

/**
 * 验收命令的建任务时策略判定（D5）：返回每条命令的判定。中枢里用 `verifyPolicyFromHome`
 * （读取 policies.yaml）；缺省时没有任何规则，非 user 身份带 verify 的建任务一律被拒。
 */
export type VerifyPolicyCheck = (
  scope: { workspace: string; role: string },
  steps: readonly VerifyStep[],
) => Promise<Result<VerifyVerdict[]>>

export interface TaskServiceOptions {
  ledger: LedgerStore
  workspaceExists: WorkspaceCheck
  /** 非 user 身份创建任务时用来校验角色存在与 `creatable_by`；中枢里用 `roleLookupFromHome`。 */
  roles: RoleLookup
  /**
   * workspace 的登记仓库与 supervisor 设置（D5 仓库检查、D4 上限、D10 审查角色）；中枢里用
   * `workspaceLookupFromHome`。缺省时按 `workspaceExists` 判断存在，仓库为空、supervisor 取默认值。
   */
  workspaces?: WorkspaceLookup
  /** 仓库检查的选项（测试注入家目录）。 */
  repoCheck?: RepoCheckOptions
  /** 创建与手动重试时固化策略版本；生产环境注入共享策略加载器。 */
  policy?: { load(): Promise<Result<PolicyConfig>>; current?(): PolicyConfig | undefined }
  /** 验收命令的策略判定；缺省为没有规则（全部拒绝）。 */
  verifyPolicy?: VerifyPolicyCheck
  now?: () => number
  /** 生成任务 id，默认 `generateTaskId`。 */
  newTaskId?: (nowMs: number) => string
  /** 生成回复 id，默认 `generateReplyId`。 */
  newReplyId?: () => string
}

export interface CreateTaskOptions {
  actor: string
  /** 仅中枢内部创建路径可指定授权来源；HTTP 与 MCP 不得取自请求。 */
  mandateOrigin?: string
  /** 仅中枢内部管线：从此账本任务追溯唤醒与原始指令（如 merger 的源 dev）。 */
  mandateSourceTask?: string
  /** 仅中枢接受提案：指令序号与所属唤醒，原文始终重读账本。 */
  instructionSource?: { seq: number; wake: string }
  /** 幂等键；也可以写在合同的 `idempotency_key` 中（两处都给时必须一致）。 */
  idempotency_key?: string
  /**
   * 中枢计算出的任务来源（add-m1-supervisor D2），写入 `task.created`、之后不变。
   * **只供中枢内部调用方传入**（调度器、提案接受等）；HTTP 路由与 MCP 不得从请求中取值。
   * 计算规则见 D2，由后续任务（2.3）实现；缺省表示不在 supervisor 链上。
   */
  origin?: TaskOrigin
  /**
   * 只限 hub：与 `task.created` 在同一次 appendMany（同一事务、同一次通知）中写入的事件，
   * 参数是新任务的 id。用于唤醒任务的 `supervisor.wake_started`（D1），保证租约分配等订阅者
   * 不会看到"任务已建、但还没有 wake_started"的窗口。事件以同一身份（hub）写入。
   */
  withCreated?: (taskId: string) => EventInput[]
  /** 仅 hub：在 id 分配后生成含读取指针的唤醒输入。 */
  wakeInputs?: (taskId: string) => WakeInputs
  /**
   * 只限 hub：以**另一个身份**在同一事务里写入的事件——`before` 在 `task.created` 之前、`after(taskId)`
   * 在 `withCreated` 之后。用于用户批准合并（D10）：`merge_request.approved`（actor user）、hub 建 merger、
   * 条目关闭（actor user）三者要么一起写入，要么都不写。只在真正新建任务时写入，幂等命中时不写。
   * 身份只能是 `user`（目前唯一的用途；需要别的身份时再放开并补核对）。
   */
  coWrite?: { actor: 'user'; before?: EventInput[]; after?: (taskId: string) => EventInput[] }
  /**
   * 调用方所在的唤醒（D6）：**只由路由按唤醒绑定 token 填入**，不取自请求体、`--task` 或请求头。
   * actor 为 supervisor 时必须提供，其他身份不得提供。
   */
  wake?: { task_id: string }
  /**
   * 只供中枢内部调用方：即使 actor 为 user，也按非 user 身份的规则对 `verify` 逐条做策略判定（D5 第 5 步）。
   * 接受任务提案（D11）以 user 身份建任务，但验收命令出自 supervisor 的草稿，不能借 user 身份跳过判定。
   */
  enforceVerify?: boolean
  /**
   * 只供中枢内部调用方（接受任务提案，D11）：允许使用这个保留的 `task-proposal:<id>` 幂等键。
   * HTTP 路由与 MCP 不得传入。
   */
  proposalKey?: string
}

export interface CancelTaskOptions {
  actor: string
  /** 调用方所在的唤醒（D6，只由路由按唤醒绑定 token 填入）：只能取消本次唤醒建的任务。 */
  wake?: { task_id: string; workspace: string }
  reason?: string
}

export interface RetryTaskOptions {
  actor: string
  /** 只由鉴权中间件按有效唤醒 token 填入，不接受请求体传入。 */
  wake?: { task_id: string }
  reason?: string
}

export interface ReplyTaskOptions {
  actor: string
  via?: InboxVia
}

export interface GetTaskOptions {
  /**
   * 调用方是任务绑定（worker 的派工令牌）：事件列表去掉 `hiddenFromWorker` 的类型（D10 observe 判断、
   * 未执行的动作与收件箱条目）。只由路由按鉴权结果填入。
   */
  forWorker?: boolean
}

export interface TaskService {
  createTask(contractInput: unknown, opts: CreateTaskOptions): Promise<Result<CreateTaskData>>
  listTasks(filter?: unknown): Result<ListTasksData>
  getTask(id: string): Result<ShowTaskData>
  getTask(id: string, query: ShowTaskQuery, opts?: GetTaskOptions): Result<TaskShowResponse>
  cancelTask(id: string, opts: CancelTaskOptions): Result<CancelTaskData>
  retryTask(id: string, opts: RetryTaskOptions): Promise<Result<RetryTaskData>>
  replyTask(id: string, body: unknown, opts: ReplyTaskOptions): Result<ReplyTaskData>
  /** 用户取消任务对某个 PR 的订阅（harness-neutral 8.1）。 */
  unsubscribeTask(id: string, body: unknown, opts: { actor: string }): Result<UnsubscribeTaskData>
}

/** zod issues → 逐字段错误（field、code=missing_field|invalid_field、message）。 */
export function fieldIssues(issues: Parameters<typeof formatZodIssues>[0], data: unknown) {
  return formatZodIssues(issues, data, { file: '' }).map(({ file: _file, ...rest }) => rest)
}

const invalidArguments = (
  what: string,
  issues: Parameters<typeof formatZodIssues>[0],
  data: unknown,
) => {
  const fields = fieldIssues(issues, data)
  return fail(
    'usage',
    'invalid_arguments',
    `${what}不合法：${fields.map((f) => f.message).join('；')}`,
    fields,
  )
}

export function createTaskService(o: TaskServiceOptions): TaskService {
  const { ledger } = o
  const now = o.now ?? Date.now
  const newTaskId = o.newTaskId ?? ((ms: number) => generateTaskId(ms))
  const newReplyId = o.newReplyId ?? generateReplyId

  const notFound = (id: string) => fail('failure', 'not_found', `没有任务 ${id}`)
  const lookupWorkspace: WorkspaceLookup =
    o.workspaces ??
    (async (ref) =>
      (await o.workspaceExists(ref))
        ? { ref, repos: [], supervisor: defaultSupervisorConfig() }
        : null)
  const verifyPolicy: VerifyPolicyCheck =
    o.verifyPolicy ?? (async (scope, steps) => ok(decideVerifySteps([], scope, steps)))

  function getTask(id: string): Result<ShowTaskData>
  function getTask(
    id: string,
    query: ShowTaskQuery,
    opts?: GetTaskOptions,
  ): Result<TaskShowResponse>
  function getTask(
    id: string,
    query: ShowTaskQuery = {},
    opts: GetTaskOptions = {},
  ): Result<TaskShowResponse> {
    const parsed = showTaskQuery.safeParse(query)
    if (!parsed.success) return invalidArguments('查询参数', parsed.error.issues, query)
    const storedTask = ledger.getTask(id)
    if (!storedTask) return notFound(id)
    const { section, offset, limit } = parsed.data
    // 分段读取不能在 task 副本里再次附上完整终端输出。
    const task =
      section && storedTask.blocked
        ? { ...storedTask, blocked: { ...storedTask.blocked, tail: undefined } }
        : storedTask
    if (section === 'summary') return ok({ task, section })
    const all = ledger.taskEvents(id)
    const events = all.filter(
      (event) =>
        isKnownEventType(event.type) && !(opts.forWorker === true && hiddenFromWorker(event.type)),
    )
    if (section === undefined) {
      return ok({
        // 只读一次事件：阶段与详情共用同一份事件。
        task: { ...task, stage: stageFromEvents(task, all) },
        events,
        replies: ledger.taskReplies(id),
        attempts: foldTaskAttempts(task, events),
        subscriptions: ledger.prSubscriptions(id),
      })
    }
    const pagination = (total: number) => {
      const has_more = offset + limit < total
      return {
        task,
        offset,
        limit,
        total,
        has_more,
        ...(has_more ? { next_offset: offset + limit } : {}),
      }
    }
    switch (section) {
      case 'instruction': {
        const seq = task.contract.origin_instruction?.seq
        const source = seq === undefined ? undefined : ledger.eventsAfter(seq - 1, undefined, 1)[0]
        // 授权对象始终是本任务；原文来源必须由合同关联并再次核对，不接受调用方指定 seq。
        const instruction =
          source?.seq === seq &&
          source?.type === 'user.instruction' &&
          source.actor === USER_ACTOR &&
          source.workspace === task.workspace
            ? source
            : undefined
        const text = instruction ? redactSecrets(instruction.payload.text) : ''
        return ok({
          ...pagination(text.length),
          section,
          text: text.slice(offset, offset + limit),
          ...(instruction ? { instruction_seq: instruction.seq } : {}),
        })
      }
      case 'events':
        return ok({
          ...pagination(events.length),
          section,
          events: events.slice(offset, offset + limit).map((event) => ({
            ...event,
            payload: redactDeep(event.payload, redactSecrets),
          })),
        })
      case 'replies': {
        const replies = ledger.taskReplies(id)
        return ok({
          ...pagination(replies.length),
          section,
          replies: replies.slice(offset, offset + limit),
        })
      }
      case 'attempts': {
        const attempts = foldTaskAttempts(task, events)
        return ok({
          ...pagination(attempts.length),
          section,
          attempts: attempts.slice(offset, offset + limit),
        })
      }
      case 'tail': {
        // 必须先遮蔽完整片段再分页，避免把跨页密钥拆开后暴露。
        const tail = redactSecrets(
          (
            storedTask.blocked?.tail ??
            events.findLast((event) => event.type === 'task.blocked')?.payload.tail ??
            []
          ).join('\n'),
        )
        return ok({ ...pagination(tail.length), section, tail: tail.slice(offset, offset + limit) })
      }
    }
  }

  return {
    async createTask(contractInput, opts) {
      const parsed = createTaskRequest.safeParse(contractInput)
      if (!parsed.success) return invalidArguments('任务合同', parsed.error.issues, contractInput)
      const { instruction_seq: requestedInstruction, ...requestContract } = parsed.data
      const contract: TaskContract = requestContract
      // 合同入账时只做已知值的名单替换，不跑正则；高置信度的疑似密钥在这里直接拒绝。
      const suspected = checkContractSecrets(contract)
      if (!suspected.ok) return suspected
      if (
        opts.idempotency_key !== undefined &&
        contract.idempotency_key !== undefined &&
        opts.idempotency_key !== contract.idempotency_key
      ) {
        return fail('usage', 'invalid_arguments', '幂等键与合同中的 idempotency_key 不一致', [
          { field: 'idempotency_key', code: 'invalid_field', message: '幂等键不一致' },
        ])
      }
      if (
        (opts.withCreated !== undefined ||
          opts.coWrite !== undefined ||
          opts.wakeInputs !== undefined) &&
        opts.actor !== HUB_ACTOR
      ) {
        return fail(
          'failure',
          'actor_mismatch',
          'withCreated、coWrite、wakeInputs 只限中枢（hub）使用',
        )
      }
      // 类型已限定为 user；运行时再核对一次，不让别的身份借 hub 的事务写入。
      if (opts.coWrite !== undefined && opts.coWrite.actor !== 'user') {
        return fail('failure', 'actor_mismatch', 'coWrite 的身份只能是 user')
      }
      // inputs.wake 只由中枢的唤醒调度写入（D1）；其他身份携带即拒绝，避免伪造唤醒上下文。
      if (contract.inputs?.wake !== undefined && opts.actor !== HUB_ACTOR) {
        return fail('usage', 'invalid_arguments', 'inputs.wake 只能由中枢创建唤醒任务时写入', [
          { field: 'inputs.wake', code: 'invalid_field', message: 'inputs.wake 只能由中枢写入' },
        ])
      }
      const key = opts.idempotency_key ?? contract.idempotency_key
      if (key !== undefined) contract.idempotency_key = key
      const isHub = opts.actor === HUB_ACTOR
      const isUser = opts.actor === USER_ACTOR
      const isSupervisor = opts.actor.toLowerCase() === SUPERVISOR_ACTOR

      // D3、D10：`supervisor:`、`merge:` 幂等键前缀只保留给 hub（唤醒任务、merger 任务的幂等键），防止抢注或借幂等键拿到它们。
      // 例外：中枢接受任务提案时（`proposalKey`）以 user 身份使用 `task-proposal:<id>`，且必须恰好是该键。
      const proposalKeyOk =
        key !== undefined &&
        opts.proposalKey !== undefined &&
        isTaskProposalKey(key) &&
        key === opts.proposalKey
      if (key !== undefined && isReservedIdempotencyKey(key) && !proposalKeyOk) {
        if (!isHub || isTaskProposalKey(key)) {
          return fail(
            'failure',
            'reserved_idempotency_key',
            '幂等键前缀 supervisor:、task-proposal:、merge: 保留给中枢内部（唤醒任务、接受任务提案、merger 任务）',
            { field: 'idempotency_key' },
          )
        }
      }
      // 唤醒调度用的保留能力只有 hub 能声明。
      const reservedCaps = isHub ? [] : reservedCapabilitiesIn(contract.requires)
      if (reservedCaps.length > 0) {
        return fail(
          'usage',
          'invalid_arguments',
          `requires 不能声明保留能力 ${reservedCaps.join('、')}（只供中枢创建唤醒任务）`,
          [{ field: 'requires', code: 'invalid_field', message: '保留能力只供中枢使用' }],
        )
      }
      // D6：supervisor 身份只由唤醒绑定 token 认定；调用方唤醒只能随该身份出现。
      if (isSupervisor && opts.wake === undefined) {
        return fail('failure', 'scope_denied', 'supervisor 身份只能经唤醒绑定 token 创建任务')
      }
      if (opts.wake !== undefined && opts.actor !== SUPERVISOR_ACTOR) {
        return fail('failure', 'actor_mismatch', '唤醒绑定只能用于 supervisor 身份')
      }

      // 角色创建权限（role-config `creatable_by`）：user 不受限制；hub 显式跳过（D1）；
      // 其他身份必须引用已定义的角色，且匹配 creatable_by，防止 AI 借 dev 等高权限角色提权。
      // 在幂等命中之前检查：被拒绝的身份不能凭幂等键拿到已有任务。
      const found = await o.roles(contract.role)
      let role: RoleForKind | null = null
      if (found.ok) role = found.data
      else if (!isUser) return found
      if (!isUser) {
        if (!role) {
          return fail(
            'failure',
            'unknown_role',
            `角色 ${contract.role} 未定义或加载失败，运行 raindown doctor 查看`,
            {
              field: 'role',
              role: contract.role,
            },
          )
        }
        if (!isHub && found.ok && found.data && !canCreateRole(found.data, opts.actor)) {
          return fail(
            'failure',
            'role_not_allowed',
            `身份 ${opts.actor} 不能创建角色 ${contract.role} 的任务（config/roles/${contract.role}.yaml 的 creatable_by 不包含该身份）`,
            { field: 'role', role: contract.role, actor: opts.actor },
          )
        }
      }
      // 有效类别（D9）：supervisor 类只能由 hub 建（名为 supervisor 的角色同样按保留名处理，
      // 角色文件有错时也不放过）；merge 类只能由 hub 与 user 建（D10）。非 user 身份带 verify 至少是 write。
      const kind = taskKind(role, contract, { actor: opts.actor })
      if (!isHub && (kind === 'supervisor' || contract.role.toLowerCase() === SUPERVISOR_ACTOR)) {
        return fail(
          'failure',
          'role_not_allowed',
          `supervisor 唤醒任务只能由中枢创建；要手动唤醒请用 raindown supervisor wake <ws> [<说明>]`,
          { field: 'role', role: contract.role, actor: opts.actor },
        )
      }
      if (kind === 'merge' && !isHub && !isUser) {
        return fail(
          'failure',
          'role_not_allowed',
          `合并类任务（角色 ${contract.role}）只能由用户或中枢创建；supervisor 请用 pr_merge_request`,
          { field: 'role', role: contract.role, actor: opts.actor },
        )
      }

      // D5 第 0 步：调用方是 reply 唤醒 → 只能回复，不能建任务。
      const callerWake = opts.wake ? ledger.wakeOf(opts.wake.task_id) : null
      if (opts.wake !== undefined) {
        if (!callerWake) {
          return fail('failure', 'scope_denied', '调用方不是有效的唤醒任务')
        }
        if (callerWake.origin === 'reply') {
          return fail(
            'failure',
            'reply_only_wake',
            '代回复（reply）唤醒只能用 task_respond 与只读操作，不能建任务',
          )
        }
      }

      // D2：所有身份的 parent 都必须存在且同一 workspace。
      let parent: TaskView | null = null
      if (contract.parent !== undefined) {
        parent = ledger.getTask(contract.parent)
        if (!parent) {
          return fail('failure', 'parent_not_found', `parent 任务 ${contract.parent} 不存在`, {
            field: 'parent',
            parent: contract.parent,
          })
        }
        if (parent.workspace !== contract.workspace) {
          return fail(
            'failure',
            'workspace_mismatch',
            `parent 任务 ${parent.id} 属于 ${parent.workspace}，与新任务的 ${contract.workspace} 不一致`,
            { field: 'parent', parent: parent.id, workspace: parent.workspace },
          )
        }
      }
      const parentWake = parent ? ledger.wakeOf(parent.id) : null
      // D2：直接挂到唤醒任务下（从而取得唤醒的 origin）只允许 hub、user 与绑定该唤醒的 supervisor。
      if (
        parent &&
        parentWake &&
        !isHub &&
        !isUser &&
        !(callerWake && parent.id === callerWake.task_id)
      ) {
        return fail(
          'failure',
          'parent_required',
          `只有中枢、用户与绑定该唤醒的 supervisor 能以唤醒任务 ${parent.id} 为 parent`,
          { field: 'parent', parent: parent.id },
        )
      }

      let workspace: WorkspaceInfo | null = null
      const loadWorkspace = async () => {
        workspace ??= await lookupWorkspace(contract.workspace)
        return workspace
      }
      const unknownWorkspace = () =>
        fail('failure', 'unknown_workspace', `workspace ${contract.workspace} 未定义`, {
          field: 'workspace',
          workspace: contract.workspace,
        })

      if (callerWake) {
        // D6：写类操作只能作用于绑定的 workspace。
        if (contract.workspace !== callerWake.workspace) {
          return fail(
            'failure',
            'workspace_mismatch',
            `本次唤醒绑定 ${callerWake.workspace}，不能为 ${contract.workspace} 建任务`,
            { field: 'workspace', workspace: callerWake.workspace },
          )
        }
        // D5 第 1 步：parent 必须是本 workspace 未结束的普通唤醒，且就是调用方这次唤醒。
        if (
          !parent ||
          !parentWake ||
          parent.id !== callerWake.task_id ||
          parentWake.origin === 'reply' ||
          isTerminal(parent)
        ) {
          return fail(
            'failure',
            'parent_required',
            'supervisor 建的任务必须以本次（未结束的）唤醒任务为 parent',
            { field: 'parent', wake: callerWake.task_id },
          )
        }
        // D5 第 2 步：autonomous 唤醒与 PR 来源唤醒不能直接建写类任务（含带 verify 的任务），只能提案。
        if (
          kind === 'write' &&
          (callerWake.origin === 'autonomous' || prSourcedWake(ledger, callerWake.task_id))
        ) {
          return fail(
            'failure',
            'proposal_required',
            `巡检、回看等自发工作不能直接建写类任务（角色 ${contract.role}${contract.verify?.length ? '，带验收命令' : ''}），请用 task_propose 提交任务提案`,
            { field: 'role', role: contract.role, kind },
          )
        }
        // D5 第 3 步（上面的类别检查已覆盖，这里保留为显式的一步）。
        if (kind === 'merge' || kind === 'supervisor') {
          return fail('failure', 'role_not_allowed', `supervisor 不能创建 ${kind} 类任务`, {
            field: 'role',
            role: contract.role,
            kind,
          })
        }
        const ws = await loadWorkspace()
        if (!ws) return unknownWorkspace()
        // D5 第 4 步：cwd / inputs.repo 必须在本 workspace 登记仓库内；通过后写回规范化路径。
        const repo = await checkRepoInWorkspace(contract, ws, o.repoCheck)
        if (!repo.ok) return repo
        if (repo.data.cwd !== undefined) contract.cwd = repo.data.cwd
        if (repo.data.repo !== undefined) {
          contract.inputs = { ...contract.inputs, repo: repo.data.repo }
        }
      }

      // D5 第 5 步：非 user 身份建任务时，每条验收命令在创建时经策略判定，只有 auto / auto-report 放行。
      const verify = contract.verify ?? []
      if ((!isUser || opts.enforceVerify === true) && verify.length > 0) {
        const verdicts = await verifyPolicy(
          { workspace: contract.workspace, role: contract.role },
          verify,
        )
        if (!verdicts.ok) return verdicts
        const denied = verdicts.data.filter((v) => !v.allowed)
        if (denied.length > 0) {
          return fail(
            'failure',
            'verify_not_allowed',
            `验收命令未获策略自动放行（policies.yaml 中 tool:Verify 的 auto 规则）：${denied
              .map((v) => `#${v.index} ${v.command}（${v.reason ?? v.level}）`)
              .join('；')}`,
            {
              field: 'verify',
              denied: denied.map((v) => ({
                index: v.index,
                command: v.command,
                level: v.level,
                ...(v.reason === undefined ? {} : { reason: v.reason }),
              })),
            },
          )
        }
      }

      // D4 上限与 parent 状态：全部是同步的账本查询。先查一次尽早拒绝，写入前（最后一个 await 之后）
      // 再查一次，避免并发请求各自通过检查后一起写入。
      const limitWs = callerWake || (parent && !isUser && !isHub) ? await loadWorkspace() : null
      const limits = (limitWs?.supervisor ?? defaultSupervisorConfig()).limits
      const reviewerRoles = (limitWs?.supervisor ?? defaultSupervisorConfig()).reviewer_roles
      const checkLimits = (): Result<null> => {
        if (callerWake) {
          const wakeTask = ledger.getTask(callerWake.task_id)
          if (!wakeTask || isTerminal(wakeTask)) {
            return fail('failure', 'parent_required', '本次唤醒已结束，不能再建任务', {
              field: 'parent',
              wake: callerWake.task_id,
            })
          }
          const made = ledger.countChildren(callerWake.task_id, SUPERVISOR_ACTOR)
          if (made >= limits.tasks_per_wake) {
            return fail(
              'failure',
              'limit_exceeded',
              `本次唤醒已创建 ${made} 个任务，达到上限 ${limits.tasks_per_wake}（supervisor.limits.tasks_per_wake）`,
              { limit: 'tasks_per_wake', max: limits.tasks_per_wake },
            )
          }
          if (kind === 'write') {
            for (const pr of prsForNewTask(contract, wakePrs(ledger, callerWake))) {
              const rounds = ledger.countChangesRequested(contract.workspace, pr, reviewerRoles)
              if (rounds >= limits.review_rounds) {
                return fail(
                  'failure',
                  'review_rounds_exceeded',
                  `PR ${pr} 已有 ${rounds} 次 changes_requested，达到上限 ${limits.review_rounds}（supervisor.limits.review_rounds）`,
                  { pr, rounds, max: limits.review_rounds },
                )
              }
            }
          }
        }
        // D4：parent 链深度（user 与 hub 不受限）。
        if (parent && !isUser && !isHub) {
          const depth = chainDepth(ledger, parent, limits.chain_depth)
          if (depth > limits.chain_depth) {
            return fail(
              'failure',
              'limit_exceeded',
              `parent 链深度 ${depth} 超过上限 ${limits.chain_depth}（supervisor.limits.chain_depth）`,
              { limit: 'chain_depth', max: limits.chain_depth },
            )
          }
        }
        return ok(null)
      }
      const early = checkLimits()
      if (!early.ok) return early

      // D9：选择原始指令与 mandate 共用同一个结果，原文只从账本读取。
      const source = opts.mandateSourceTask ? ledger.getTask(opts.mandateSourceTask) : parent
      let provenanceWake = opts.mandateSourceTask ? null : (callerWake ?? parentWake)
      let ancestor = source
      const seen = new Set<string>()
      while (!provenanceWake && ancestor && !seen.has(ancestor.id)) {
        seen.add(ancestor.id)
        provenanceWake = ledger.wakeOf(ancestor.mandate?.wake_task ?? ancestor.id)
        ancestor = ancestor.contract.parent ? ledger.getTask(ancestor.contract.parent) : null
      }
      const instructions =
        provenanceWake?.origin === 'instruction'
          ? provenanceWake.events.flatMap((seq) => {
              const event = ledger.eventsAfter(seq - 1, undefined, 1)[0]
              return event?.seq === seq &&
                event.type === 'user.instruction' &&
                event.actor === USER_ACTOR &&
                event.workspace === contract.workspace
                ? [event]
                : []
            })
          : []
      const instructionError = (message: string) =>
        fail('usage', 'invalid_arguments', message, [
          { field: 'instruction_seq', code: 'invalid_field', message },
        ])
      if (
        requestedInstruction !== undefined &&
        (!callerWake || !instructions.some((event) => event.seq === requestedInstruction))
      ) {
        return instructionError('instruction_seq 必须是本次唤醒的 user.instruction 事件')
      }
      if (callerWake && instructions.length > 1 && requestedInstruction === undefined) {
        return instructionError('本次唤醒包含多条用户指令，必须指定 instruction_seq')
      }
      let instructionNote: string | undefined
      const readInstruction = (seq: number) => {
        const event = ledger.eventsAfter(seq - 1, undefined, 1)[0]
        return event?.seq === seq &&
          event.type === 'user.instruction' &&
          event.actor === USER_ACTOR &&
          event.workspace === contract.workspace
          ? event
          : undefined
      }
      let instruction =
        requestedInstruction !== undefined
          ? instructions.find((event) => event.seq === requestedInstruction)
          : instructions.length === 1
            ? instructions[0]
            : undefined
      const sourceInstruction =
        source?.contract.origin_instruction?.seq ?? source?.mandate?.instruction_seq
      if (
        !callerWake &&
        source?.contract.workspace === contract.workspace &&
        sourceInstruction !== undefined
      ) {
        instruction = readInstruction(sourceInstruction)
      }
      if (opts.instructionSource) {
        const sourceWake = ledger.wakeOf(opts.instructionSource.wake)
        const event = readInstruction(opts.instructionSource.seq)
        if (
          !sourceWake ||
          sourceWake.workspace !== contract.workspace ||
          sourceWake.origin !== 'instruction' ||
          !sourceWake.events.includes(opts.instructionSource.seq) ||
          !event
        ) {
          return instructionError('提案指令必须属于提交提案的唤醒')
        }
        instruction = event
        provenanceWake = sourceWake
      } else if (
        !instruction &&
        instructions.length === 0 &&
        provenanceWake?.origin === 'instruction' &&
        callerWake?.source === 'pr'
      ) {
        // PR 评论引起的唤醒（instruction:pr）：新任务不继承来源任务的原始指令。
        instructionNote = '本次唤醒来自 PR 评论，新任务不继承来源任务的原始指令'
      } else if (
        !instruction &&
        instructions.length === 0 &&
        provenanceWake?.origin === 'instruction'
      ) {
        const candidates = new Map<string, TaskView>()
        const addSource = (task: TaskView | null) => {
          if (task?.contract.workspace === contract.workspace) candidates.set(task.id, task)
        }
        if (opts.mandateSourceTask || !callerWake) addSource(source)
        if (callerWake) {
          const reviewPr = contract.inputs?.review?.pr
          if (reviewPr) {
            // 通过 PR 索引定位开发产物，审查重试与其他 workspace 不能成为来源。
            for (let offset = 0; ; offset += 100) {
              const page = ledger.tasksForPr(contract.workspace, reviewPr, 100, offset)
              for (const task of page) {
                if (
                  !reviewerRoles.includes(task.contract.role) &&
                  !task.contract.inputs?.review &&
                  ledger
                    .taskEvents(task.id)
                    .some(
                      (event) =>
                        (event.type === 'task.done' ||
                          event.type === 'task.failed' ||
                          event.type === 'task.cancelled') &&
                        event.payload.result?.artifacts.some(
                          (artifact) => artifact.kind === 'pr' && samePrUrl(artifact.ref, reviewPr),
                        ),
                    )
                )
                  addSource(task)
              }
              if (page.length < 100) break
            }
          } else {
            for (const id of ledger.eventTaskIds(callerWake.events)) addSource(ledger.getTask(id))
          }
        }
        const inherited = new Map<number, NonNullable<ReturnType<typeof readInstruction>>>()
        for (const task of candidates.values()) {
          const seq = task.contract.origin_instruction?.seq ?? task.mandate?.instruction_seq
          const event = seq === undefined ? undefined : readInstruction(seq)
          if (event) inherited.set(event.seq, event)
        }
        if (inherited.size === 1) instruction = inherited.values().next().value
        else if (inherited.size > 1)
          instructionNote = '候选任务关联多条不同用户指令，无法确定原始指令，未继承'
      }
      const instructionSeq = instruction?.seq
      if (instruction) {
        const originalText = instruction.payload.text
        // 与 event_get 使用相同的输出遮蔽，历史指令中的疑似密钥不能经合同重新暴露。
        const text = redactSecrets(originalText)
        contract.origin_instruction = {
          seq: instruction.seq,
          text: text.slice(0, 4000),
          ...(originalText.length > 4000
            ? {
                chars: originalText.length,
                read: { op: 'event_get' as const, args: { seq: instruction.seq } },
              }
            : {}),
        }
      }

      const existing = () => (key === undefined ? null : ledger.findTaskByIdempotencyKey(key))
      const hit = existing()
      if (hit) return ok({ task: hit, created: false })

      if (!(await o.workspaceExists(contract.workspace))) return unknownWorkspace()

      // D10 第 2 步：reviewer_roles 角色且带 inputs.review 的任务，丢弃调用方的目标，用中枢模板重写。
      const review = contract.inputs?.review
      if (review !== undefined) {
        const ws = await loadWorkspace()
        if (isReviewTask(contract, ws?.supervisor ?? defaultSupervisorConfig())) {
          contract.goal = reviewTaskGoal(review)
        }
      }

      // 授权依据只由中枢计算；与策略检查共用加载与版本比较入口。
      const loadedPolicy = o.policy
        ? await o.policy.load()
        : ok({ rules: [], version: policyVersion([]) })
      // 任务创建权限沿用角色与 verify 校验；策略损坏不能额外阻止原本合法的创建。
      // mandate 只记录最近成功加载的快照或空规则，不能把损坏配置当成已授权的依据。
      const policy = loadedPolicy.ok
        ? loadedPolicy.data
        : (o.policy?.current?.() ?? { rules: [], version: policyVersion([]) })
      const creationDecision = decide(policy.rules, {
        scope: { workspace: contract.workspace, role: opts.actor },
        actions: ['task.create'],
      })
      const mandate = {
        created_by: opts.actor,
        origin:
          opts.mandateOrigin ??
          (callerWake ? `supervisor:${callerWake.origin}` : undefined) ??
          (isHub && review !== undefined ? 'pipeline:review' : opts.actor),
        ...(provenanceWake ? { wake_task: provenanceWake.task_id } : {}),
        ...(instructionSeq === undefined ? {} : { instruction_seq: instructionSeq }),
        ...(instructionNote ? { instruction_note: instructionNote } : {}),
        // PR 来源的污染：调用方唤醒为 PR 来源，或来源 / 父任务带标记时向下传递（中枢计算，调用方不能提供）。
        // 用户接受提案不清除污染：提案的唤醒（provenanceWake）为 PR 来源时同样标记。
        ...((callerWake && prSourcedWake(ledger, callerWake.task_id)) ||
        prSourcedWake(ledger, provenanceWake?.task_id) ||
        prSourcedWake(ledger, contract.parent) ||
        prSourcedTask(ledger, source) ||
        prSourcedTask(ledger, contract.parent ? ledger.getTask(contract.parent) : null)
          ? // 以上每项只读一层已固化的标记（见 observe.ts），不递归重算。
            { pr_sourced: true as const }
          : {}),
        policy_version: policy.version,
        matched_rules: auditRules(creationDecision.matched_rules),
      }

      // 从这里到 append 都是同步代码，不会与其他请求交错：重新检查幂等键、上限与 parent 状态。
      const raced = existing()
      if (raced) return ok({ task: raced, created: false })
      const late = checkLimits()
      if (!late.ok) return late
      // observe（D10）：autonomous 唤醒建任务只记录为 supervisor.observed_action，不执行。核对全部通过后才记录，
      // 记录的是"本会执行"的动作；workspace 已在唤醒分支中读取（这里没有 await）。
      if (
        callerWake &&
        observeAutonomous(
          callerWake.origin,
          (workspace as WorkspaceInfo | null)?.supervisor,
          callerWake.source,
        )
      ) {
        // 结构化字段在前、目标放最后：摘要截断时优先保留角色、执行器与仓库。
        const { idempotency_key: _key, goal, ...shown } = contract
        return recordObservedAction(ledger, {
          workspace: contract.workspace,
          wake_task_id: callerWake.task_id,
          action: 'task_create',
          args: { ...shown, goal },
          limit: limits.tasks_per_wake,
        })
      }
      const parentNow = parent ? ledger.getTask(parent.id) : null
      const origin = computeOrigin(
        opts.origin,
        parentNow ? { task: parentNow, wake: parentWake } : null,
        opts.actor,
      )

      let id = newTaskId(now())
      for (let i = 0; ledger.getTask(id) !== null; i++) {
        if (i >= 5) return fail('failure', 'internal_error', '无法生成不重复的任务 id')
        id = newTaskId(now())
      }
      if (opts.wakeInputs) {
        const parsedWake = wakeInputs.safeParse(opts.wakeInputs(id))
        if (!parsedWake.success)
          return invalidArguments('唤醒输入', parsedWake.error.issues, contract)
        contract.inputs = { ...contract.inputs, wake: parsedWake.data }
        const wakeSecrets = checkContractSecrets(contract)
        if (!wakeSecrets.ok) return wakeSecrets
      }
      const created: EventInput = {
        type: 'task.created',
        task_id: id,
        workspace: contract.workspace,
        payload: { contract, mandate, ...(origin === undefined ? {} : { origin }) },
      }
      const before = opts.coWrite?.before ?? []
      const own = [created, ...(opts.withCreated?.(id) ?? [])]
      const after = opts.coWrite?.after?.(id) ?? []
      const co = opts.coWrite?.actor
      const written = ledger.appendMany([...before, ...own, ...after], {
        actor: opts.actor,
        ...(co === undefined
          ? {}
          : {
              actors: [
                ...before.map(() => co),
                ...own.map(() => undefined),
                ...after.map(() => co),
              ],
            }),
      })
      if (!written.ok) return written
      const task = ledger.getTask(id)
      return task
        ? ok({ task, created: true })
        : fail('failure', 'internal_error', '任务写入后不可见')
    },

    listTasks(filter = {}) {
      const parsed = listTasksQuery.safeParse(filter)
      if (!parsed.success) return invalidArguments('查询参数', parsed.error.issues, filter)
      const { stage, limit, offset = 0, ...filters } = parsed.data
      // 未结束的候选：每个任务只读一次事件派生阶段；终态任务没有阶段，不读事件。
      const open = ledger
        .listTasks({ ...filters, open_only: true, limit: -1 })
        .map((task) => ({ ...task, stage: readTaskStage(ledger, task) }))
      if (stage !== undefined) {
        // 按阶段过滤：offset 作用于过滤后的结果，不能交给 SQL。
        const tasks = open
          .filter((task) =>
            stage === 'waiting-human' ? isWaitingHumanStage(task.stage) : task.stage === stage,
          )
          .slice(offset, offset + limit)
        return ok({ tasks })
      }
      // 默认顺序：全部等人的任务（按创建倒序）在前，其余按 SQL 原顺序接在后面，再整体分页；
      // 等人的任务不会因为有更多较新的任务而被挤出第一页，翻页（例如按 PR 的指针分页）保持确定。
      const waiting = open.filter((task) => isWaitingHumanStage(task.stage))
      const head = waiting.slice(offset, offset + limit)
      const need = limit - head.length
      const stages = new Map(open.map((task) => [task.id, task.stage]))
      const rest =
        need <= 0
          ? []
          : ledger
              .listTasks({
                ...filters,
                exclude_ids: waiting.map((task) => task.id),
                limit: need,
                offset: Math.max(0, offset - waiting.length),
              })
              .map((task) => ({
                ...task,
                stage: stages.has(task.id)
                  ? (stages.get(task.id) ?? null)
                  : readTaskStage(ledger, task),
              }))
      const tasks = [...head, ...rest]
      return ok({ tasks })
    },

    getTask,

    cancelTask(id, opts) {
      const task = ledger.getTask(id)
      if (!task) return notFound(id)
      // D6：唤醒身份只能作用于绑定的 workspace，且只能取消本次唤醒自己建的任务。
      if (opts.wake) {
        if (task.workspace !== opts.wake.workspace) {
          return fail(
            'failure',
            'workspace_mismatch',
            `本次唤醒绑定 ${opts.wake.workspace}，不能取消 ${task.workspace} 的任务`,
          )
        }
        if (task.contract.parent !== opts.wake.task_id || task.created_by !== SUPERVISOR_ACTOR) {
          return fail('failure', 'scope_denied', '唤醒只能取消本次唤醒自己创建的任务')
        }
      } else if (opts.actor.toLowerCase() === SUPERVISOR_ACTOR) {
        return fail('failure', 'scope_denied', 'supervisor 身份只能经唤醒绑定 token 取消任务')
      }
      const reason = opts.reason === undefined ? {} : { reason: opts.reason }
      const base = { task_id: id, workspace: task.workspace }
      // blocked 但节点仍持有租约（D7a）：与 running 一样经续约通知节点停止执行器。
      const status =
        task.status === 'blocked' && ledger.activeLease(id) !== null ? 'running' : task.status
      switch (status) {
        case 'queued':
        case 'blocked': {
          const r = ledger.append(
            { ...base, type: 'task.cancelled', payload: reason },
            { actor: opts.actor },
          )
          if (!r.ok) return r
          break
        }
        case 'running':
        case 'verifying': {
          // 已请求过取消时不重复写事件，保持幂等。
          if (task.cancel_requested) return ok({ task })
          const r = ledger.append(
            { ...base, type: 'task.cancel_requested', payload: reason },
            { actor: opts.actor },
          )
          if (!r.ok) return r
          break
        }
        default:
          return fail(
            'failure',
            'invalid_transition',
            `任务状态为 ${task.status}（终态），不能取消`,
            { from: task.status, type: 'task.cancelled' },
          )
      }
      const after = ledger.getTask(id)
      return after ? ok({ task: after }) : notFound(id)
    },

    async retryTask(id, opts) {
      if (opts.actor !== USER_ACTOR && opts.actor !== SUPERVISOR_ACTOR) {
        return fail('failure', 'role_not_allowed', '只有用户或有效唤醒中的 supervisor 可以重试任务')
      }
      if (opts.wake && opts.actor !== SUPERVISOR_ACTOR) {
        return fail('failure', 'actor_mismatch', '唤醒绑定只能用于 supervisor 身份')
      }
      const input = retryTaskRequest.safeParse({ reason: opts.reason })
      if (!input.success || (opts.actor === SUPERVISOR_ACTOR && !input.data.reason)) {
        return fail(
          'usage',
          'invalid_arguments',
          '重试理由 reason 必须为非空且不超过 8192 字符的文字；supervisor 必填',
          {
            field: 'reason',
          },
        )
      }
      const reason = input.data.reason
      const before = ledger.getTask(id)
      if (!before) return notFound(id)
      let role: RoleForKind | null = null
      if (opts.actor === SUPERVISOR_ACTOR) {
        const found = await o.roles(before.contract.role)
        if (!found.ok) return found
        if (!found.data) {
          return fail('failure', 'unknown_role', `角色 ${before.contract.role} 未定义或加载失败`)
        }
        role = found.data
      }
      // 与建任务共用策略快照，加载失败时保留最近成功版本；这里只追溯重试依据，不增加放行门槛。
      const loadedPolicy = o.policy
        ? await o.policy.load()
        : ok({ rules: [], version: policyVersion([]) })
      const policy = loadedPolicy.ok
        ? loadedPolicy.data
        : (o.policy?.current?.() ?? { rules: [], version: policyVersion([]) })
      // 角色与策略加载后重新读状态；此后的校验与写入之间不能 await，避免撤销并发取消或释放新租约。
      const task = ledger.getTask(id)
      if (!task) return notFound(id)
      if (task.cancel_requested) {
        return fail('failure', 'cancel_requested', '任务已请求取消，不能重试')
      }
      if (ledger.wakeOf(id)) {
        return fail('failure', 'wake_retry_forbidden', '唤醒任务由调度器重新唤醒，不能直接重试')
      }
      if (ledger.activeLease(id) !== null) {
        return fail('failure', 'lease_active', '任务仍持有活动租约，不能重试')
      }
      if (opts.actor === SUPERVISOR_ACTOR) {
        const wake = opts.wake ? ledger.wakeOf(opts.wake.task_id) : null
        const caller = wake ? ledger.getTask(wake.task_id) : null
        if (!wake || !caller || isTerminal(caller)) {
          return fail('failure', 'scope_denied', 'supervisor 只能经有效唤醒绑定 token 重试任务')
        }
        if (wake.origin === 'reply') {
          return fail('failure', 'reply_only_wake', 'reply 唤醒只能调用 task_respond 与只读操作')
        }
        if (task.workspace !== wake.workspace) {
          return fail(
            'failure',
            'workspace_mismatch',
            `本次唤醒绑定 ${wake.workspace}，不能重试 ${task.workspace} 的任务`,
          )
        }
        const kind = taskKind(role, task.contract, { actor: opts.actor })
        if (kind === 'merge' || kind === 'supervisor') {
          return fail('failure', 'role_not_allowed', `supervisor 不能重试 ${kind} 类任务`)
        }
        if (
          kind === 'write' &&
          (wake.origin === 'autonomous' || prSourcedWake(ledger, wake.task_id))
        ) {
          return fail(
            'failure',
            'proposal_required',
            '自发唤醒与 PR 评论引起的唤醒不能直接重试写类任务，请提交任务提案',
          )
        }
        // 任务必须确实源自本 workspace 的普通唤醒；后续唤醒可以恢复前代唤醒的子孙任务。
        // origin 由中枢固化，不能只凭用户可填写的 parent 借任意任务进入唤醒链。
        const seen = new Set<string>()
        let ancestor = task.origin ? task : null
        let derived = false
        while (ancestor?.contract.parent && !seen.has(ancestor.id)) {
          seen.add(ancestor.id)
          if (ancestor.created_by !== SUPERVISOR_ACTOR && ancestor.created_by !== HUB_ACTOR) break
          const parent = ledger.getTask(ancestor.contract.parent)
          if (!parent || parent.workspace !== wake.workspace) break
          const parentWake = ledger.wakeOf(parent.id)
          if (parentWake) {
            derived =
              parent.created_by === HUB_ACTOR &&
              parentWake.workspace === wake.workspace &&
              parentWake.origin !== 'reply'
            break
          }
          if (!parent.origin) break
          ancestor = parent
        }
        if (!derived) {
          return fail('failure', 'scope_denied', 'supervisor 只能重试本 workspace 唤醒链派生的任务')
        }
      }
      const retryable =
        task.status === 'failed' ||
        (task.status === 'blocked' &&
          task.blocked !== null &&
          RETRYABLE_BLOCKED_REASONS.some((reason) => reason === task.blocked?.reason))
      if (!retryable) {
        return fail(
          'failure',
          'invalid_transition',
          `任务状态 ${task.status}${task.blocked ? `(${task.blocked.reason})` : ''} 不允许重试`,
          {
            from: task.status,
            type: 'task.requeued',
          },
        )
      }
      const base = { task_id: id, workspace: task.workspace }
      const written = ledger.appendMany(
        [
          // 从未开始执行（中枢判定隔离不可用而卡住，attempt 为 0）时没有可结束的派工。
          ...(task.attempt > 0 &&
          !ledger
            .taskEvents(id)
            .some(
              (event) =>
                event.type === 'task.attempt_ended' && event.payload.attempt === task.attempt,
            )
            ? [
                {
                  ...base,
                  type: 'task.attempt_ended' as const,
                  payload: { attempt: task.attempt, reason: 'retry' as const },
                },
              ]
            : []),
          {
            ...base,
            type: 'task.requeued',
            payload: {
              reason: 'manual',
              requested_by: opts.actor,
              policy_version: policy.version,
              ...(reason === undefined ? {} : { retry_reason: reason, note: reason }),
              // PR 来源唤醒的重试：污染随任务保留（中枢计算）。
              ...(opts.wake && prSourcedWake(ledger, opts.wake.task_id)
                ? { pr_sourced: true as const }
                : {}),
            },
          },
        ],
        { actor: opts.actor },
      )
      if (!written.ok) return written
      const after = ledger.getTask(id)
      return after ? ok({ task: after }) : notFound(id)
    },

    unsubscribeTask(id, body, opts) {
      // 取消订阅只限用户本人：supervisor 与 worker 不能借此让任务错过 PR 上的请求。
      if (opts.actor !== USER_ACTOR) {
        return fail('failure', 'user_only', `只有用户本人可以取消 PR 订阅，当前为 ${opts.actor}`)
      }
      const parsed = unsubscribeTaskRequest.safeParse(body)
      if (!parsed.success) return invalidArguments('取消订阅请求', parsed.error.issues, body)
      const task = ledger.getTask(id)
      if (!task) return notFound(id)
      const pr = normalizePrUrl(parsed.data.pr) ?? parsed.data.pr
      const find = () => ledger.prSubscriptions(id).findLast((sub) => sub.pr === pr)
      const current = find()
      if (!current) return fail('failure', 'not_subscribed', `任务 ${id} 没有订阅 ${pr}`)
      if (!current.active) return ok({ subscription: current, changed: false })
      const written = ledger.append(
        {
          type: 'pr.unsubscribed',
          task_id: id,
          workspace: task.workspace,
          payload: { pr, reason: 'user' },
        },
        { actor: USER_ACTOR },
      )
      if (!written.ok) return written
      const after = find()
      return after
        ? ok({ subscription: after, changed: true })
        : fail('failure', 'internal_error', '订阅写入后不可见')
    },

    replyTask(id, body, opts) {
      // 防止 AI 自批：只接受 actor=user 的回复（与 task_reply 操作一致）。
      // 身份由鉴权中间件按 token 决定（add-m1-inbox D9），路由层的 userOnly 先拒绝；
      // 这里保留同样的检查作为服务层的第二道防线。supervisor 代为答复只能走 task_respond（D15）。
      if (opts.actor !== 'user') {
        return fail(
          'failure',
          'user_only',
          `只有用户本人可以回复卡住的任务，当前为 ${opts.actor}`,
          {
            actor: opts.actor,
          },
        )
      }
      const parsed = replyTaskRequest.safeParse(body)
      if (!parsed.success) return invalidArguments('回复', parsed.error.issues, body)
      const { kind, text } = parsed.data
      const task = ledger.getTask(id)
      if (!task) return notFound(id)
      if (task.status !== 'blocked') {
        return fail(
          'failure',
          'not_blocked',
          `任务状态为 ${task.status}，只有 blocked 的任务可以回复`,
          {
            status: task.status,
          },
        )
      }
      const reason = task.blocked?.reason
      const accepted = acceptedReplyKinds(reason, task.blocked?.prior_reason)
      if (!accepted.includes(kind)) {
        return fail(
          'failure',
          'reply_kind_mismatch',
          `任务卡在 ${reason}，只接受 ${accepted.join(' / ')} 回复，不接受 ${kind}`,
          { reason, kind, accepted },
        )
      }
      const replyId = newReplyId()
      const base = { task_id: id, workspace: task.workspace }
      // 没有节点持有该任务（无头执行器已结束这一轮、或节点掉线）：带着回复重新排队（D7、D7a）。
      const requeue = ledger.activeLease(id) === null
      const session = task.blocked?.session
      // D15 "用户优先"：这次卡住仍委托给 supervisor 时，在同一次追加里先结束委托（user_replied）。
      // 在同一同步流程里读取委托（与 append 之间没有 await），没有委托时用户回复照常写入。
      const delegation = ledger.activeDelegation(id)
      const written = ledger.appendMany(
        [
          ...(delegation
            ? [
                {
                  ...base,
                  type: 'task.reply_escalated' as const,
                  payload: { reason: 'user_replied' as const, block_seq: delegation.block_seq },
                },
              ]
            : []),
          {
            ...base,
            type: 'task.replied',
            payload: {
              reply_id: replyId,
              kind,
              via: opts.via ?? 'cli',
              ...(text === undefined ? {} : { text }),
            },
          },
          ...(requeue &&
          task.attempt > 0 &&
          !ledger
            .taskEvents(id)
            .some(
              (event) =>
                event.type === 'task.attempt_ended' && event.payload.attempt === task.attempt,
            )
            ? [
                {
                  ...base,
                  type: 'task.attempt_ended' as const,
                  payload: { attempt: task.attempt, reason: 'blocked' as const },
                },
              ]
            : []),
          ...(requeue
            ? [
                {
                  ...base,
                  type: 'task.requeued_with_reply' as const,
                  payload: { reply_id: replyId, ...(session ? { session } : {}) },
                },
              ]
            : []),
        ],
        { actor: opts.actor },
      )
      if (!written.ok) return written
      const after = ledger.getTask(id)
      const reply = ledger.getReply(replyId)
      return after && reply
        ? ok({ task: after, reply, requeued: requeue })
        : fail('failure', 'internal_error', '回复写入后不可见')
    },
  }
}
