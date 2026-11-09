import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { readRaindownEnv } from '../env.ts'
import { raindownPaths } from '../home.ts'
import type { InboxActRequest, inboxListQuery } from '../inbox/schema.ts'
import type { UnsubscribeTaskRequest } from '../ledger/pr-subscription.ts'
import {
  type AskUserRequest,
  type BriefUpdateRequest,
  type CancelTaskRequest,
  type CreateTaskRequest,
  compatibleTaskShowResponse,
  type DecisionReviewRequest,
  ENDPOINTS,
  type EndpointName,
  errorBody,
  HEADERS,
  type HealthData,
  HUB_UNAVAILABLE,
  type HubStatusData,
  type IssueTokenRequest,
  type listTasksQuery,
  type MergeRequestRequest,
  okBody,
  type PatrolReportRequest,
  type PolicyCheckRequest,
  type ReplyTaskRequest,
  type RetryTaskRequest,
  type ShowTaskData,
  type ShowTaskQuery,
  type TaskProposeRequest,
  type TaskRespondRequest,
  type TaskShowResponse,
  type TelegramLinkCodeRequest,
} from '../ledger/protocol.ts'
import type { SupervisorWakeRequest } from '../ledger/supervisor-api.ts'
import { fail, ok, type Result } from '../result.ts'
import { loadHubConfig, resolveHubUrl } from './config.ts'

export interface HubClientOptions {
  home: string
  /** 写入 `X-Raindown-Actor`。user token 可以借此降级；绑定 token 必须与绑定身份一致。 */
  actor: string
  /**
   * 显式的中枢 token。缺省时依次取 `RAINDOWN_LEASE_TOKEN_FILE`（worker 派工）、`RAINDOWN_HUB_TOKEN_FILE` 指向的文件（supervisor 唤醒的
   * MCP 进程，见 add-m1-supervisor D6）、`RAINDOWN_HUB_TOKEN`（例如签发给某个 AI 的绑定 token），
   * 最后取 `state/hub.token`（user token）。
   */
  token?: string
  /** 默认 5 秒；覆盖整个 HTTP 请求与响应体读取。 */
  timeoutMs?: number
  fetch?: (request: Request) => Promise<Response>
}

export type HubStatus = HealthData & {
  pid: number | null
  schedules: HubStatusData['schedules']
  last_backup: HubStatusData['last_backup']
  secrets?: HubStatusData['secrets']
  policies?: HubStatusData['policies']
  channels?: HubStatusData['channels']
  pr_watch?: HubStatusData['pr_watch']
}

type JsonEndpoint = Exclude<EndpointName, 'events'>
type ResponseData<N extends JsonEndpoint> = z.infer<(typeof ENDPOINTS)[N]['response']>
/** 进程以绑定 token 访问中枢时设置的环境变量（design D9）。 */
export const HUB_TOKEN_ENV = 'RAINDOWN_HUB_TOKEN'
/**
 * 进程从文件读取中枢 token 时设置的环境变量（add-m1-supervisor D6；优先于 `RAINDOWN_HUB_TOKEN`）：
 * 节点把唤醒绑定 token 写进 `state/wake/<task>.token`，只把路径交给 MCP 进程，token 本身不进 argv 与 env。
 */
export const HUB_TOKEN_FILE_ENV = 'RAINDOWN_HUB_TOKEN_FILE'
/** worker 派工凭证的文件路径；优先于通用中枢凭证，读取失败时不降级。 */
export const LEASE_TOKEN_FILE_ENV = 'RAINDOWN_LEASE_TOKEN_FILE'
/**
 * 节点随派工令牌交给受管 MCP 的中枢地址（不是凭证；add-worker-credential-isolation D2、D3）。
 * 只在任务绑定会话（设置了 `RAINDOWN_LEASE_TOKEN_FILE`）中使用：worker 侧不读 `config/hub.yaml`，
 * 隔离后 `config/` 对 worker 不可读。无绑定与唤醒绑定仍按 `config/hub.yaml` 解析。
 */
export const HUB_URL_ENV = 'RAINDOWN_HUB_URL'

/** 任务绑定会话的中枢地址：只接受 http(s) 地址；不合法时返回 undefined（回退到配置）。 */
export function leaseHubUrl(): string | undefined {
  if (!readRaindownEnv(LEASE_TOKEN_FILE_ENV)) return undefined
  const raw = readRaindownEnv(HUB_URL_ENV)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return raw.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

const unavailable = () =>
  fail('retryable', HUB_UNAVAILABLE, '无法连接中枢，请运行 raindown daemon status 检查')
const invalidResponse = () => fail('failure', 'invalid_hub_response', '中枢响应不符合协议')
const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'

/** 任务与中枢管理共用的 HTTP 客户端；不打开账本，操作者随每个请求传递。 */
export class HubClient {
  constructor(private readonly options: HubClientOptions) {}

  async request<N extends JsonEndpoint>(
    name: N,
    input?: unknown,
    id?: string,
  ): Promise<Result<ResponseData<N>>> {
    let base = leaseHubUrl()
    if (base === undefined) {
      const config = await loadHubConfig(this.options.home)
      if (!config.ok) return config
      base = resolveHubUrl(config.data)
    }
    const endpoint = ENDPOINTS[name]
    let token: string | undefined
    if (endpoint.auth) {
      token = this.options.token?.trim() || undefined
      const tokenFile = readRaindownEnv(LEASE_TOKEN_FILE_ENV) ?? readRaindownEnv(HUB_TOKEN_FILE_ENV)
      if (token === undefined && tokenFile) {
        // 指定了 token 文件就只用它：读不到时失败，不回退到 user token。
        try {
          token = (await readFile(tokenFile, 'utf8')).trim()
        } catch (err) {
          if (isMissing(err))
            return fail('failure', 'token_file_missing', '中枢 token 文件不存在（派工可能已结束）')
          return fail('failure', 'read_failed', '无法读取中枢 token 文件')
        }
        if (!token) return fail('failure', 'token_file_missing', '中枢 token 文件为空')
      }
      token ??= readRaindownEnv(HUB_TOKEN_ENV)
      if (token === undefined) {
        try {
          token = (await readFile(raindownPaths(this.options.home).hubToken, 'utf8')).trim()
        } catch (err) {
          if (isMissing(err)) return unavailable()
          return fail('failure', 'read_failed', '无法读取中枢 token 文件')
        }
      }
      if (!token) return unavailable()
    }
    const url = new URL(endpoint.path.replace(':id', encodeURIComponent(id ?? '')), base)
    if (endpoint.method === 'GET' && input) {
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 5000)
    let text: string
    let response: Response
    try {
      const request = new Request(url.toString(), {
        method: endpoint.method,
        headers: {
          ...(token ? { [HEADERS.authorization]: `Bearer ${token}` } : {}),
          [HEADERS.actor]: this.options.actor,
          'Content-Type': 'application/json',
        },
        ...(endpoint.method === 'POST' ? { body: JSON.stringify(input ?? {}) } : {}),
        signal,
      })
      response = await (this.options.fetch ?? fetch)(request)
      text = await response.text()
    } catch {
      return unavailable()
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return invalidResponse()
    }
    const error = errorBody.safeParse(body)
    if (error.success) {
      const { kind, code, message, details } = error.data.error
      return fail(kind, code, message, details)
    }
    const schema = name === 'tasks-show' ? compatibleTaskShowResponse : endpoint.response
    const parsed = okBody(schema).safeParse(body)
    if (!response.ok || !parsed.success) return invalidResponse()
    return ok(parsed.data.data as ResponseData<N>)
  }

  createTask(input: CreateTaskRequest) {
    return this.request('tasks-create', input)
  }
  listTasks(input: z.input<typeof listTasksQuery> = {}) {
    return this.request('tasks-list', input)
  }
  showTask(id: string): Promise<Result<ShowTaskData>>
  showTask(id: string, query: ShowTaskQuery): Promise<Result<TaskShowResponse>>
  showTask(id: string, query?: ShowTaskQuery): Promise<Result<TaskShowResponse>> {
    return this.request('tasks-show', query, id)
  }
  getEvent(seq: number) {
    return this.request('events-get', undefined, String(seq))
  }
  cancelTask(id: string, input: CancelTaskRequest = {}) {
    return this.request('tasks-cancel', input, id)
  }
  retryTask(id: string, input: RetryTaskRequest = {}) {
    return this.request('tasks-retry', input, id)
  }
  unsubscribeTask(id: string, input: UnsubscribeTaskRequest) {
    return this.request('tasks-unsubscribe', input, id)
  }
  replyTask(id: string, input: ReplyTaskRequest) {
    return this.request('tasks-reply', input, id)
  }
  updateBrief(input: BriefUpdateRequest) {
    return this.request('briefs-update', input)
  }
  briefContext(workspace: string) {
    return this.request('briefs-context', { workspace })
  }
  askUser(input: AskUserRequest) {
    return this.request('supervisor-ask', input)
  }
  reportPatrol(input: PatrolReportRequest) {
    return this.request('supervisor-patrol-report', input)
  }
  proposeTask(input: TaskProposeRequest) {
    return this.request('task-proposals-create', input)
  }
  reviewDecision(input: DecisionReviewRequest) {
    return this.request('decisions-review', input)
  }
  requestMerge(input: MergeRequestRequest) {
    return this.request('merge-requests-create', input)
  }
  respondTask(input: TaskRespondRequest) {
    return this.request('supervisor-respond', input)
  }
  listInbox(input: z.input<typeof inboxListQuery> = {}) {
    return this.request('inbox-list', input)
  }
  actInbox(id: string, input: InboxActRequest) {
    return this.request('inbox-act', input, id)
  }
  checkPolicy(input: PolicyCheckRequest) {
    return this.request('policy-check', input)
  }
  health() {
    return this.request('health')
  }
  rebuild() {
    return this.request('hub-rebuild')
  }
  issueToken(input: IssueTokenRequest) {
    return this.request('hub-tokens-issue', input)
  }
  listTokens() {
    return this.request('hub-tokens-list')
  }
  revokeToken(id: string) {
    return this.request('hub-tokens-revoke', {}, id)
  }
  uiLoginCode() {
    return this.request('ui-login-code', {})
  }
  telegramLinkCode(input: TelegramLinkCodeRequest = {}) {
    return this.request('telegram-link-code', input)
  }
  telegramUnlink() {
    return this.request('telegram-unlink', {})
  }
  /** `raindown ask` / `raindown supervisor wake`（仅 user）。 */
  supervisorWake(input: SupervisorWakeRequest) {
    return this.request('supervisor-wake', input)
  }
  /** `raindown supervisor status`（仅 user）。 */
  supervisorStatus(input: { workspace?: string } = {}) {
    return this.request('supervisor-status', input)
  }

  /** `raindown supervisor report`（D10，tasks 7.4）：observe 一致率、卡住 basis 与未执行的自主动作。 */
  supervisorReport(input: { workspace?: string; since?: string; until?: string } = {}) {
    return this.request('supervisor-report', input)
  }

  /** 旧中枢没有 status 路由时，用 health 加本地文件补足可观测信息。 */
  async status(): Promise<Result<HubStatus>> {
    const status = await this.request('hub-status')
    if (status.ok || status.error.code !== 'not_found') return status
    const health = await this.health()
    if (!health.ok) return health
    const paths = raindownPaths(this.options.home)
    try {
      let pid: number | null = null
      try {
        const lock = z
          .object({ pid: z.number().int().positive() })
          .parse(JSON.parse(await readFile(paths.hubPid, 'utf8')))
        pid = lock.pid
      } catch (err) {
        if (!isMissing(err)) throw err
      }
      let names: string[] = []
      try {
        names = await readdir(paths.backups)
      } catch (err) {
        if (!isMissing(err)) throw err
      }
      const backups = await Promise.all(
        names.map(async (name) => {
          const path = join(paths.backups, name)
          const info = await stat(path)
          return info.isFile() ? { path, at: info.mtime.toISOString() } : null
        }),
      )
      const latest = backups.filter((b) => b !== null).sort((a, b) => b.at.localeCompare(a.at))[0]
      return ok({
        ...health.data,
        pid,
        schedules: { loaded: 0, errors: [] },
        last_backup: latest ?? null,
      })
    } catch {
      return fail('failure', 'read_failed', '无法读取中枢状态文件')
    }
  }
}
