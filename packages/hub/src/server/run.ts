import {
  appendCapture,
  chatDigest,
  EMPTY_INBOX_CONFIG,
  fail,
  findSupervisorRole,
  type HubConfig,
  type HubStatusData,
  inboxActRequest,
  loadChannelsConfig,
  loadHubConfig,
  loadRoles,
  loadWorkspaces,
  ok,
  policyRuleHash,
  type Result,
  raindownPaths,
  redactSecrets,
  registerKnownSecrets,
  saveTelegramBinding,
  type TelegramChannelConfig,
  telegramChannelConfigSchema,
  VERSION,
} from '@raindown/core'
import { Hono } from 'hono'
import { createBriefRoutes, wakeBinding } from '../briefs/index.ts'
import { buildStatusSnapshot } from '../channels/telegram/commands.ts'
import { createTelegramLinks, type TelegramLinks } from '../channels/telegram/link.ts'
import {
  TELEGRAM_CHANNEL_ID,
  type TelegramDeps,
  telegramChannelSpec,
} from '../channels/telegram/plugin.ts'
import { createTelegramRoutes } from '../channels/telegram/routes.ts'
import type { ChannelSpec } from '../channels/types.ts'
import {
  actOnInbox,
  createInboxRoutes,
  type InboxActionDeps,
  type InboxService,
  startInbox,
} from '../inbox/index.ts'
import { createKbRoutes } from '../kb/index.ts'
import { createTaskRoutes } from '../ledger/routes.ts'
import { type LedgerStore, openLedger } from '../ledger/store.ts'
import {
  createTaskService,
  roleLookupFromHome,
  workspaceCheckFromHome,
  workspaceLookupFromHome,
} from '../ledger/tasks.ts'
import { createExistingPrReactor, type ExistingPrLookup } from '../nodes/existing-pr.ts'
import { createNodeProtocol, type NodeProtocol } from '../nodes/protocol.ts'
import { createPolicyRoutes } from '../policy/routes.ts'
import { createPolicyService, type PolicyService } from '../policy/service.ts'
import { verifyPolicyFromHome } from '../policy/verify.ts'
import { createGhApi, type GhApi, type RepoOriginLookup } from '../pr/github.ts'
import { createPrPassthrough } from '../pr/passthrough.ts'
import { createPrSubscriptionReactor } from '../pr/subscriptions.ts'
import { createPrWatcher, type PrWatcher } from '../pr/watcher.ts'
import { createScheduler, type Scheduler } from '../scheduler/index.ts'
import { redactingLogger } from '../secrets/logger.ts'
import { SecretRedactor } from '../secrets/redactor.ts'
import { createHubSecrets, type HubSecretsOptions } from '../secrets/service.ts'
import { currentRuntime } from '../serve.ts'
import { createDelegationService, type DelegationService } from '../supervisor/delegation.ts'
import { createSupervisorRoutes } from '../supervisor/routes.ts'
import {
  createWakeScheduler,
  type WakeScheduler,
  workspaceConfigFromHome,
} from '../supervisor/scheduler.ts'
import {
  acceptTaskProposal,
  approveMergeRequest,
  createSupervisorToolRoutes,
  rejectMergeRequest,
  rejectTaskProposal,
  type SupervisorToolsDeps,
  startSupervisorTools,
  supervisorActiveFromHome,
} from '../supervisor-tools/index.ts'
import { createUiApp, createUiLoginCodeRoutes } from '../ui/app.tsx'
import { createUiSessions } from '../ui/sessions.ts'
import { createWorkerReportRoutes } from '../worker-report/routes.ts'
import { systemClock } from './clock.ts'
import { createTaskTokenAuthority } from './lease-tokens.ts'
import { consoleLogger } from './maintenance.ts'
import { type RunningHub, type StartHubOptions, startHub } from './start.ts'
import { ensureHubToken } from './token.ts'
import { createWakeTokenAuthority } from './wake-tokens.ts'

export interface RunHubOptions
  extends Omit<StartHubOptions, 'ledger' | 'openLedger' | 'routes' | 'onStop' | 'leaseHolders'> {
  /** 已有 PR 判定的只读查询注入点（测试用）。 */
  existingPrQuery?: ExistingPrLookup
  /** PR 订阅采集的注入点（测试用）：假的 gh 查询、登记仓库 origin 与轮询间隔。 */
  prWatch?: { gh?: GhApi; origin?: RepoOriginLookup; tickMs?: number }
  /** 密钥解析的注入点（测试用）；默认用 sops 解密 `config/secrets.sops.yaml`。 */
  secrets?: Pick<HubSecretsOptions, 'load' | 'debounceMs' | 'onChange'> & {
    /** 是否监听 config/ 的变化，默认 true。 */
    watch?: boolean
  }
  /** 收件箱的注入点（测试用）。 */
  inbox?: {
    /** 是否监听 config/inbox.yaml 与提案目录，默认 true。 */
    watch?: boolean
    proposalIntervalMs?: number
    /**
     * 推送渠道；缺省时按 `config/channels.yaml` 注册 Telegram 渠道（`telegram.enabled: false` 时不注册）。
     * 测试可以注入假渠道。
     */
    channels?: readonly ChannelSpec[]
    /** Telegram 插件的测试注入点（假的 Telegram 服务、fetch、等待函数等）。 */
    telegram?: Partial<
      Pick<TelegramDeps, 'fetch' | 'apiBase' | 'env' | 'pollTimeoutS' | 'sleep' | 'now'>
    >
    backoff?: { baseMs?: number; maxMs?: number }
  }
}

/**
 * 生产用的中枢组合：取得锁后打开 `state/raindown.db`，挂载任务路由与节点协议路由，
 * 启动租约过期扫描、睡眠检测与定时调度，把每日备份写成 `hub.backup_done`，启动成功后写入 `hub.started`，
 * 然后启动收件箱（反应器、提案目录监听、推送节奏与渠道管理器）。
 * 注入的 clock 同时用于账本的事件时间戳，保证租约到期时间与扫描用同一个时钟。
 */
export async function runHub(input: RunHubOptions): Promise<Result<RunningHub>> {
  const clock = input.clock ?? systemClock
  // 脱敏名单在任何事件写入之前就绪：取得锁后、打开账本时先解析一次密钥。
  // 名单注册进 core 的 redactSecrets，使正则兜底之前先替换已知值（名单优先）。
  const redactor = new SecretRedactor()
  const unregister = registerKnownSecrets(redactor.redact)
  const logger = redactingLogger(input.logger ?? consoleLogger, redactSecrets)
  const options: RunHubOptions = { ...input, logger }
  const secrets = createHubSecrets({
    home: options.home,
    redactor,
    logger,
    ...(options.secrets?.load ? { load: options.secrets.load } : {}),
    ...(options.secrets?.debounceMs !== undefined
      ? { debounceMs: options.secrets.debounceMs }
      : {}),
    onChange: (status) => {
      options.secrets?.onChange?.(status)
      // 密钥补上后，之前因缺少密钥未启动的渠道重试启动。
      void inbox?.channels.refresh()
    },
  })
  let stopWatch: (() => void) | undefined
  const startedAt = clock.now()
  let scheduler: Scheduler | undefined
  /** supervisor 唤醒调度器（add-m1-supervisor 3.1–3.4）：hub.started 之后启动。 */
  let wakes: WakeScheduler | undefined
  let taskService: ReturnType<typeof createTaskService> | undefined
  let inbox: InboxService | undefined
  /** 收件箱操作的依赖：HTTP 路由与中枢内渠道共用同一个实现（actOnInbox）。 */
  let inboxActions: InboxActionDeps | undefined
  let policiesService: PolicyService | undefined
  let ledger: LedgerStore | undefined
  let config: HubConfig | undefined
  let protocol: NodeProtocol | undefined
  /** supervisor 的提问、任务提案与决策回看（add-m1-supervisor 4.4–4.7）。 */
  let supervisorTools: SupervisorToolsDeps | undefined
  /** 卡住时由 supervisor 代用户回复（add-m1-supervisor 3.5、4.9）。 */
  let delegation: DelegationService | undefined
  let stopSupervisorTools: (() => void) | undefined
  let existingPr: ReturnType<typeof createExistingPrReactor> | undefined
  /** PR 自动订阅与采集（harness-neutral 8.1、8.3）：只对 github.watch 的 workspace 生效。 */
  let prSubscriptions: ReturnType<typeof createPrSubscriptionReactor> | undefined
  let prWatcher: PrWatcher | undefined
  let prPassthrough: ReturnType<typeof createPrPassthrough> | undefined
  // Web 页面（6.1）：会话只在内存中；Host 校验需要实际监听的端口，启动成功后才填入。
  const uiSessions = createUiSessions({ now: () => clock.now() })
  const activeLedgerFor = () => {
    if (!ledger) throw new Error('账本尚未打开')
    return ledger
  }
  // Telegram 绑定码（5.1）：只在内存中，HTTP 路由申请、插件兑换。
  const telegramLinks = createTelegramLinks({ now: () => clock.now() })
  let uiPort: number | undefined
  const leaseHolders = (taskId: string) => {
    const lease = ledger?.activeLease(taskId)
    return lease && Date.parse(lease.expires_at) > clock.now() ? [lease.node_id] : []
  }
  // 唤醒绑定 token（add-m1-supervisor D6）：领租约时签发，鉴权时按账本核对租约与唤醒。
  const wakeTokens = createWakeTokenAuthority({ ledger: () => ledger, now: () => clock.now() })
  const taskTokens = createTaskTokenAuthority({ ledger: () => ledger, now: () => clock.now() })
  const started = await startHub({
    ...options,
    leaseHolders,
    wakeTokens,
    taskTokens,
    openLedger: async () => {
      // startHub 在打开账本之前已校验过 hub.yaml，这里再读一次取租约参数。
      const loaded = await loadHubConfig(options.home)
      if (!loaded.ok) throw new Error(loaded.error.message)
      config = loaded.data
      const token = await ensureHubToken(options.home)
      if (token.ok) redactor.add('state/hub.token', token.data)
      await secrets.reload()
      ledger = await openLedger(raindownPaths(options.home).ledgerDb, {
        now: () => clock.now(),
        redact: redactor.redact,
      })
      policiesService = createPolicyService({ home: options.home, ledger, clock, logger })
      // 策略文件错误由 status 报告；后续判定继续失败关闭，定期检查会重试。
      const initialPolicies = await policiesService.load()
      if (!initialPolicies.ok) logger.warn('策略加载失败', initialPolicies.error)
      // 中枢停机期间节点无法续约：重启后给每个活动租约至少一个 TTL 的宽限，
      // 让仍在运行的节点有机会续上，而不是在第一次扫描时被误判为 node_lost（hub-daemon "崩溃后自动恢复"）。
      const graceUntil = new Date(clock.now() + config.lease_ttl_s * 1000).toISOString()
      for (const lease of ledger.activeLeases()) {
        if (lease.expires_at < graceUntil) ledger.renewLease(lease.lease_id, graceUntil)
      }
      return ledger
    },
    routes: () => {
      if (!ledger || !config || !policiesService) return []
      const policy = policiesService
      const tasks = createTaskService({
        ledger,
        policy,
        workspaceExists: workspaceCheckFromHome(options.home),
        workspaces: workspaceLookupFromHome(options.home),
        verifyPolicy: verifyPolicyFromHome(options.home, policy),
        roles: roleLookupFromHome(options.home),
        now: () => clock.now(),
      })
      delegation = createDelegationService({
        ledger,
        policy,
        clock,
        workspaces: workspaceLookupFromHome(options.home),
        roles: roleLookupFromHome(options.home),
        supervisorRole: async () => {
          const loaded = await loadRoles(options.home)
          return loaded.ok ? findSupervisorRole(loaded.data.roles) : loaded
        },
        logger,
        // 判定为不委托、委托被转交后，条目按原级别推送。
        onRelease: () => {
          void inbox?.pusher.tick()
        },
      })
      const tools: SupervisorToolsDeps = {
        ledger,
        tasks,
        delegation,
        policy,
        home: options.home,
        workspaces: workspaceLookupFromHome(options.home),
        roles: roleLookupFromHome(options.home),
        verifyPolicy: verifyPolicyFromHome(options.home, policy),
        levels: () => inbox?.config() ?? EMPTY_INBOX_CONFIG,
        supervisorActive: supervisorActiveFromHome(options.home),
        now: () => clock.now(),
      }
      supervisorTools = tools
      taskService = tasks
      protocol = createNodeProtocol({
        ledger,
        clock,
        leaseTtlS: config.lease_ttl_s,
        leaseWaitMaxS: config.lease_wait_max_s,
        issueWakeToken: (grant) => wakeTokens.issue(grant),
        issueTaskToken: (grant) => taskTokens.issue(grant),
        renewTaskToken: (grant) => taskTokens.ensure(grant),
        onResume: () => scheduler?.resume(),
        ...(options.logger ? { logger: options.logger } : {}),
      })
      // HTTP 路由、/ui 与中枢内渠道共用同一个收件箱操作实现（actOnInbox）。
      const inboxDeps: InboxActionDeps = {
        ledger,
        tasks,
        home: options.home,
        scanProposals: async () => {
          await inbox?.proposals.scan()
        },
        taskProposals: {
          accept: (item, o) => acceptTaskProposal(tools, item, o),
          reject: (item, o) => rejectTaskProposal(tools, item, o),
        },
        mergeRequests: {
          approve: (item, o) => approveMergeRequest(tools, item, o),
          reject: (item, o) => rejectMergeRequest(tools, item, o),
        },
      }
      inboxActions = inboxDeps
      const status = new Hono()
      status.get('/v1/hub/status', async (c) => {
        const policies = await policy.load()
        const backup = ledger?.latestEvent(undefined, 'hub.backup_done')
        const scheduleErrors = scheduler?.errors() ?? []
        const data: HubStatusData = {
          version: options.version ?? VERSION,
          pid: process.pid,
          started_at: new Date(startedAt).toISOString(),
          runtime: options.runtime ?? currentRuntime(),
          uptime: Math.max(0, (clock.now() - startedAt) / 1000),
          ledger_seq: ledger?.seq() ?? 0,
          schedules: { loaded: scheduler?.loaded() ?? 0, errors: scheduleErrors },
          schedule_errors: scheduleErrors,
          last_backup:
            backup?.type === 'hub.backup_done'
              ? { path: backup.payload.path, at: backup.ts }
              : null,
          secrets: secrets.status(),
          policies: policies.ok
            ? {
                loaded: policies.data.rules.length,
                version: policies.data.version,
                errors: policies.data.errors,
                ...(policies.data.warnings.length ? { warnings: policies.data.warnings } : {}),
              }
            : {
                loaded: 0,
                errors: [
                  {
                    file: 'config/policies.yaml',
                    code: policies.error.code,
                    message: redactSecrets(policies.error.message),
                  },
                ],
              },
          channels: inbox?.channels.status() ?? [],
          pr_watch: prWatcher?.status() ?? {
            watched: 0,
            errors: [],
            identity: null,
            shared: [],
            warnings: [],
          },
        }
        return c.json({ ok: true as const, data })
      })
      return [
        { path: '/', app: status },
        { path: '/', app: createTaskRoutes({ ledger, tasks }) },
        { path: '/', app: createWorkerReportRoutes({ ledger, now: () => clock.now() }) },
        { path: '/', app: createInboxRoutes(inboxDeps) },
        {
          path: '/',
          app: createSupervisorRoutes({ scheduler: () => wakes, ledger, now: () => clock.now() }),
        },
        {
          path: '/',
          app: createBriefRoutes({
            ledger,
            home: options.home,
            // 调用方的唤醒只取自鉴权中间件按唤醒绑定 token 认定的结果（D6）；其他认证方式没有绑定，
            // supervisor 的写请求因此失败即拒绝。
            binding: wakeBinding,
          }),
        },
        { path: '/', app: createSupervisorToolRoutes(tools) },
        // 任务绑定的知识读取（add-worker-credential-isolation D3）：只接受派工令牌。
        { path: '/', app: createKbRoutes({ home: options.home }) },
        { path: '/', app: createUiLoginCodeRoutes(uiSessions) },
        {
          path: '/',
          app: createTelegramRoutes({
            links: telegramLinks,
            unavailable: () => telegramUnavailable(inbox?.channels.status() ?? []),
            isBound: async () => {
              const loaded = await loadChannelsConfig(options.home)
              return loaded.ok && loaded.data.telegram?.chat_id !== undefined
            },
            unlink: () => unlinkTelegram(options.home, activeLedgerFor(), telegramLinks),
          }),
        },
        {
          path: '/',
          app: createUiApp({
            sessions: uiSessions,
            inbox: inboxDeps,
            port: () => uiPort,
            settle: async () => {
              await inbox?.idle()
            },
            now: () => clock.now(),
          }),
        },
        {
          path: '/',
          app: createPolicyRoutes({
            home: options.home,
            ledger,
            policy,
            leaseHolders,
            now: () => clock.now(),
          }),
        },
        { path: '/', app: protocol.routes },
      ]
    },
    onStop: async () => {
      await policiesService?.stop()
      await existingPr?.stop()
      await prWatcher?.stop()
      await prPassthrough?.stop()
      await prSubscriptions?.stop()
      stopSupervisorTools?.()
      wakes?.stop()
      delegation?.stop()
      await inbox?.stop()
      scheduler?.stop()
      protocol?.stop()
      stopWatch?.()
      secrets.close()
      // 账本写入端的 redact 仍直接持有名单；这里只撤下 core 正则之前的全局名单。
      unregister()
    },
    onBackupDone: (info) => {
      options.onBackupDone?.(info)
      ledger?.append(
        {
          type: 'hub.backup_done',
          payload: {
            path: info.path,
            size_bytes: info.size_bytes,
            duration_ms: info.duration_ms,
            removed: info.removed,
          },
        },
        { actor: 'hub' },
      )
    },
  })
  if (!started.ok || !ledger || !policiesService) {
    secrets.close()
    unregister()
    return started
  }
  uiPort = started.data.port
  const baseline = await policiesService.load()
  const marker = ledger.append(
    {
      type: 'hub.started',
      payload: {
        version: options.version ?? VERSION,
        pid: process.pid,
        runtime: options.runtime ?? currentRuntime(),
        port: started.data.port,
        ...(baseline.ok
          ? {
              policy_version: baseline.data.version,
              policy_rules: baseline.data.rules.map(policyRuleHash),
            }
          : {}),
      },
    },
    { actor: 'hub' },
  )
  if (!marker.ok) {
    await started.data.stop()
    return marker
  }
  policiesService.start()
  scheduler = await createScheduler({
    ledger,
    clock,
    home: options.home,
    ...(options.logger ? { logger: options.logger } : {}),
  })
  const activeLedger = ledger
  // 代回复先于唤醒调度器与收件箱启动：判定中的卡住要先挡住推送，调度器的 onReplyUnavailable 要能转交。
  delegation?.start()
  if (taskService) {
    const activeDelegation = delegation
    wakes = createWakeScheduler({
      ledger,
      tasks: taskService,
      clock,
      logger,
      workspaces: workspaceLookupFromHome(options.home),
      // 每次调度只读一次 config/workspaces/（状态与加载结果一并给出）。
      workspaceConfig: workspaceConfigFromHome(options.home),
      listWorkspaces: async () => {
        const loaded = await loadWorkspaces(options.home)
        return loaded.ok ? loaded.data.workspaces : []
      },
      supervisorRole: async () => {
        const loaded = await loadRoles(options.home)
        return loaded.ok ? findSupervisorRole(loaded.data.roles) : loaded
      },
      ...(activeDelegation
        ? { onReplyUnavailable: (info) => activeDelegation.onReplyUnavailable(info) }
        : {}),
    })
    wakes.start()
  }
  const channels =
    options.inbox?.channels ??
    (await defaultChannels({
      home: options.home,
      logger,
      links: telegramLinks,
      overrides: options.inbox?.telegram ?? {},
      deps: {
        ledger: activeLedger,
        wake: () => {
          void inbox?.channels.wake(TELEGRAM_CHANNEL_ID)
        },
        status: () =>
          buildStatusSnapshot({
            ledger: activeLedger,
            now: clock.now(),
            startedAt,
            version: options.version ?? VERSION,
            channels: inbox?.channels.status() ?? [],
          }),
        // /ask：写 user.instruction（user 身份、via telegram）并调度唤醒（3.4）。
        ask: async (workspace, text) =>
          wakes
            ? wakes.instruct(workspace, text, 'telegram')
            : fail('retryable', 'hub_busy', '中枢尚未就绪，请稍后重试'),
      },
    }))
  // 收件箱（add-m1-inbox 3.1）：hub.started 之后补处理停机期间的事件，再开始监听。
  inbox = await startInbox({
    ledger,
    home: options.home,
    clock,
    logger,
    scheduler,
    resolve: (value) => secrets.resolve(value),
    channels,
    ...(delegation ? { held: delegation.held } : {}),
    // 渠道在中枢进程内运行，不经过 HTTP 鉴权，直接以 user 身份执行并记录 via（design D9）。
    act: async (id, action, text, via) => {
      if (!inboxActions) return fail('retryable', 'hub_starting', '中枢尚未就绪')
      const input = inboxActRequest.safeParse({ action, ...(text ? { text } : {}), via })
      if (!input.success) return fail('usage', 'invalid_arguments', '条目操作参数不合法')
      return actOnInbox(inboxActions, id, input.data, 'user')
    },
    ...(options.inbox?.backoff ? { backoff: options.inbox.backoff } : {}),
    ...(options.inbox?.watch !== undefined ? { watch: options.inbox.watch } : {}),
    ...(options.inbox?.proposalIntervalMs !== undefined
      ? { proposalIntervalMs: options.inbox.proposalIntervalMs }
      : {}),
  })
  if (supervisorTools) {
    const tools = await startSupervisorTools(supervisorTools, { scheduler, logger })
    stopSupervisorTools = tools.stop
  }
  existingPr = createExistingPrReactor({
    ledger,
    clock,
    roles: roleLookupFromHome(options.home),
    workspaces: workspaceLookupFromHome(options.home),
    logger,
    ...(options.existingPrQuery ? { query: options.existingPrQuery } : {}),
  })
  existingPr.start()
  prSubscriptions = createPrSubscriptionReactor({
    ledger,
    workspaces: workspaceLookupFromHome(options.home),
    logger,
  })
  prSubscriptions.start(clock.now())
  // 直通先于采集启动：pr-watcher 写下的事件都能被分发（harness-neutral 8.4–8.6）。
  prPassthrough = createPrPassthrough({
    ledger,
    workspaces: workspaceLookupFromHome(options.home),
    roles: roleLookupFromHome(options.home),
    supervisorActive: supervisorActiveFromHome(options.home),
    logger,
    now: () => clock.now(),
  })
  prPassthrough.start()
  prWatcher = createPrWatcher({
    ledger,
    workspaces: workspaceLookupFromHome(options.home),
    gh: options.prWatch?.gh ?? createGhApi(),
    ...(options.prWatch?.origin ? { origin: options.prWatch.origin } : {}),
    ...(options.prWatch?.tickMs !== undefined ? { tickMs: options.prWatch.tickMs } : {}),
    clock,
    logger,
  })
  prWatcher.start()
  protocol?.start()
  if (options.secrets?.watch !== false) stopWatch = secrets.watch()
  return started
}

/** `raindown telegram unlink`：删掉 channels.yaml 中的绑定并提交，插件立即停止接受原 chat，记 `channel.unlinked`。 */
async function unlinkTelegram(
  home: string,
  ledger: LedgerStore,
  links: TelegramLinks,
): Promise<Result<{ unlinked: boolean }>> {
  const loaded = await loadChannelsConfig(home)
  if (!loaded.ok) return loaded
  const chat = loaded.data.telegram?.chat_id
  if (chat === undefined) {
    links.onUnlinked?.()
    return ok({ unlinked: false })
  }
  const saved = await saveTelegramBinding(home, null)
  if (!saved.ok) return saved
  links.onUnlinked?.()
  const r = ledger.append(
    {
      type: 'channel.unlinked',
      payload: {
        channel: TELEGRAM_CHANNEL_ID,
        chat: chatDigest(TELEGRAM_CHANNEL_ID, chat),
        via: 'cli',
      },
    },
    { actor: 'user' },
  )
  if (!r.ok) return r
  return ok({ unlinked: true })
}

/** 绑定码路由用：Telegram 渠道不能接收绑定码时的原因。 */
function telegramUnavailable(
  statuses: readonly {
    id: string
    state: string
    missing_secrets: string[]
    last_error: string | null
  }[],
): string | null {
  const s = statuses.find((c) => c.id === TELEGRAM_CHANNEL_ID)
  if (!s) return 'Telegram 渠道未启用（config/channels.yaml 中 telegram.enabled 为 false）'
  if (s.state === 'stopped') return '中枢正在停止'
  if (s.state !== 'disabled') return null
  if (s.missing_secrets.length > 0) {
    return `Telegram 渠道未启动：缺少 ${s.missing_secrets.map((p) => `secret://${p}`).join('、')}，先运行 raindown secrets set telegram/bot-token`
  }
  return s.last_error ?? 'Telegram 渠道未启动'
}

/**
 * 默认的推送渠道：按 `config/channels.yaml` 注册 Telegram（add-m1-inbox 5.1）。
 * - 文件不存在或没有 telegram 段时也注册（token 引用默认为 `secret://telegram/bot-token`）：
 *   没有设置 token 时渠道为 disabled，`raindown hub status` 报告缺少的密钥路径；
 * - `telegram.enabled: false` 时不注册；
 * - 配置写错时注册一个创建即失败的渠道，状态中报告错误，中枢其他功能照常。
 */
async function defaultChannels(o: {
  home: string
  logger: TelegramDeps['logger']
  links: TelegramLinks
  overrides: Partial<TelegramDeps>
  deps: Pick<TelegramDeps, 'ledger' | 'wake' | 'status' | 'ask'>
}): Promise<ChannelSpec[]> {
  const loaded = await loadChannelsConfig(o.home)
  if (!loaded.ok) {
    o.logger?.warn('config/channels.yaml 无法加载，Telegram 渠道不启动', loaded.error.message)
    const message = loaded.error.message
    return [
      {
        id: TELEGRAM_CHANNEL_ID,
        create: () => {
          throw new Error(message)
        },
      },
    ]
  }
  const config: TelegramChannelConfig =
    loaded.data.telegram ?? telegramChannelConfigSchema.parse({})
  if (!config.enabled) return []
  const deps: TelegramDeps = {
    links: o.links,
    ...(o.logger ? { logger: o.logger } : {}),
    redact: redactSecrets,
    statePath: raindownPaths(o.home).telegramState,
    loadConfig: () => loadChannelsConfig(o.home),
    saveBinding: (binding) => saveTelegramBinding(o.home, binding),
    capture: async (text) => {
      const r = await appendCapture(o.home, { text, source: 'telegram' }, { actor: 'user' })
      return r.ok ? ok({ file: r.data.file }) : r
    },
    ...o.deps,
    ...o.overrides,
  }
  return [telegramChannelSpec(config, deps) as ChannelSpec]
}
