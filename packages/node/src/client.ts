import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  type AckReplyData,
  type AckReplyRequest,
  type AcquireLeaseData,
  type AcquireLeaseRequest,
  ackReplyData,
  acquireLeaseData,
  type CompleteLeaseData,
  type CompleteLeaseRequest,
  compatibleShowTaskData,
  completeLeaseData,
  ENDPOINTS,
  errorBody,
  fail,
  HEADERS,
  HUB_TOKEN_ENV,
  HUB_UNAVAILABLE,
  type IsolationNoticeData,
  type IsolationNoticeRequest,
  isolationNoticeData,
  type ListTasksData,
  listNodesData,
  listTasksData,
  loadHubConfig,
  loadNodeConfig,
  type NodeView,
  ok,
  type PolicyCheckData,
  type PolicyCheckRequest,
  policyCheckData,
  type RegisterNodeRequest,
  type RenewLeaseData,
  type RenewLeaseRequest,
  type Result,
  raindownPaths,
  readRaindownEnv,
  registerNodeData,
  type registerNodeRequest,
  renewLeaseData,
  resolveHubUrl,
  type ShowTaskData,
  type TaskStatus,
} from '@raindown/core'
import type { z } from 'zod'

/**
 * 节点访问中枢的最小 HTTP 客户端：只覆盖 nodes / leases（含 ack-reply）端点（node-protocol spec），
 * 以及执行器审批前的策略预检（policy/check，add-m1-inbox 2.3）。
 * 与 core 的 HubClient（tasks.md 5.1）职责不重叠，之后可以合并。
 *
 * - 成功响应按协议 schema 校验 `data`；
 * - 中枢返回的失败原样转为 `fail(kind, code)`；
 * - 连接被拒绝、超时或响应不是协议格式时返回可重试的 `hub_unavailable`。
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface NodeHubClientOptions {
  url: string
  token: string
  /** 写入 `X-Raindown-Actor`，通常为 `node:<id>`。 */
  actor?: string
  fetch?: FetchLike
  /** 普通请求的超时毫秒，默认 10 秒；long-poll 额外加上等待时间。 */
  timeoutMs?: number
}

export interface NodeHubClient {
  readonly url: string
  register(req: RegisterRequest): Promise<Result<{ node: NodeView }>>
  listNodes(): Promise<Result<{ nodes: NodeView[] }>>
  acquire(
    req: Partial<AcquireLeaseRequest> & Pick<AcquireLeaseRequest, 'node_id' | 'capabilities'>,
    signal?: AbortSignal,
  ): Promise<Result<AcquireLeaseData>>
  renew(
    leaseId: string,
    req: Partial<RenewLeaseRequest> & Pick<RenewLeaseRequest, 'lease_token'>,
  ): Promise<Result<RenewLeaseData>>
  complete(leaseId: string, req: CompleteLeaseRequest): Promise<Result<CompleteLeaseData>>
  ackReply(
    leaseId: string,
    req: Partial<AckReplyRequest> & Pick<AckReplyRequest, 'lease_token' | 'reply_id'>,
  ): Promise<Result<AckReplyData>>
  /** 隔离事实上报（mds 重置，worker-credential-isolation 4.5），不依赖租约。测试替身可以不实现（通知保留在节点）。 */
  isolationNotice?(
    nodeId: string,
    req: IsolationNoticeRequest,
  ): Promise<Result<IsolationNoticeData>>
  /** 策略预检；节点不得传 dry_run（中枢会拒绝），因此这里不提供该字段。 */
  policyCheck(
    req: Omit<PolicyCheckRequest, 'dry_run'>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<PolicyCheckData>>
  /**
   * 任务详情（pr-merge 再次核对审查任务用）。本机节点以 user token 访问；绑定 token 的节点身份只能看
   * 自己持有租约的任务，读不到审查任务时调用方按核对失败处理。
   */
  showTask(id: string): Promise<Result<ShowTaskData>>
  /** 任务列表（按创建时间倒序）；pr-merge 用它核对"最新一次可信审查"。 */
  listTasks(query: {
    workspace?: string
    status?: TaskStatus
    limit?: number
  }): Promise<Result<ListTasksData>>
}

/** 注册请求（调用方形态：带默认值的字段可省略）。 */
export type RegisterRequest = Partial<z.input<typeof registerNodeRequest>> &
  Pick<RegisterNodeRequest, 'node_id' | 'hostname' | 'version' | 'capabilities'>

/**
 * 按 raindown-home 构造客户端：地址取 node.yaml 的 hub_url 或 hub.yaml 的端口，token 取 `state/hub.token`。
 * token 不存在时返回可重试的 `hub_unavailable`（中枢从未启动过）。
 */
export async function nodeHubClientFromHome(
  home: string,
  opts: Omit<NodeHubClientOptions, 'url' | 'token'> = {},
): Promise<Result<NodeHubClient>> {
  const hub = await loadHubConfig(home)
  if (!hub.ok) return hub
  const node = await loadNodeConfig(home)
  if (!node.ok) return node
  // 本机节点用 user token 并声明 node:<id>；设置了 RAINDOWN_HUB_TOKEN（绑定 token）时用它（design D9）。
  let token = readRaindownEnv(HUB_TOKEN_ENV)
  if (!token) {
    const path = raindownPaths(home).hubToken
    if (!existsSync(path)) {
      return fail(
        'retryable',
        HUB_UNAVAILABLE,
        `缺少 ${path}，中枢尚未启动过（raindown hub start）`,
      )
    }
    token = (await readFile(path, 'utf8')).trim()
  }
  return ok(createNodeHubClient({ ...opts, url: resolveHubUrl(hub.data, node.data), token }))
}

export function createNodeHubClient(o: NodeHubClientOptions): NodeHubClient {
  const base = o.url.replace(/\/+$/, '')
  const doFetch: FetchLike = o.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = o.timeoutMs ?? 10_000

  async function call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Result<z.infer<S>>> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? timeoutMs)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    let response: Response
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          [HEADERS.authorization]: `Bearer ${o.token}`,
          ...(o.actor ? { [HEADERS.actor]: o.actor } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      })
    } catch (err) {
      return fail('retryable', HUB_UNAVAILABLE, `无法连接中枢 ${base}：${(err as Error).message}`)
    }
    let json: unknown
    try {
      json = await response.json()
    } catch {
      return fail('retryable', HUB_UNAVAILABLE, `中枢响应不是 JSON（HTTP ${response.status}）`)
    }
    const error = errorBody.safeParse(json)
    if (error.success) {
      const e = error.data.error
      return fail(e.kind, e.code, e.message, e.details)
    }
    const data = (json as { ok?: unknown; data?: unknown } | null)?.data
    const parsed = schema.safeParse(data)
    if (!response.ok || (json as { ok?: unknown } | null)?.ok !== true || !parsed.success) {
      return fail('retryable', HUB_UNAVAILABLE, `中枢响应不符合协议（HTTP ${response.status}）`)
    }
    return ok(parsed.data as z.infer<S>)
  }

  const leasePath = (path: string, id: string) => path.replace(':id', encodeURIComponent(id))

  return {
    url: base,
    register: (req) => call('POST', ENDPOINTS['nodes-register'].path, registerNodeData, req),
    listNodes: () => call('GET', ENDPOINTS['nodes-list'].path, listNodesData),
    acquire: (req, signal) =>
      call('POST', ENDPOINTS['leases-acquire'].path, acquireLeaseData, req, {
        ...(signal ? { signal } : {}),
        timeoutMs: timeoutMs + (req.wait_s ?? 30) * 1000,
      }),
    renew: (id, req) =>
      call('POST', leasePath(ENDPOINTS['leases-renew'].path, id), renewLeaseData, req),
    complete: (id, req) =>
      call('POST', leasePath(ENDPOINTS['leases-complete'].path, id), completeLeaseData, req),
    ackReply: (id, req) =>
      call('POST', leasePath(ENDPOINTS['leases-ack-reply'].path, id), ackReplyData, req),
    isolationNotice: (nodeId, req) =>
      call(
        'POST',
        leasePath(ENDPOINTS['nodes-isolation-notice'].path, nodeId),
        isolationNoticeData,
        req,
      ),
    policyCheck: (req, opts = {}) =>
      call('POST', ENDPOINTS['policy-check'].path, policyCheckData, req, opts),
    showTask: (id) =>
      call('GET', leasePath(ENDPOINTS['tasks-show'].path, id), compatibleShowTaskData),
    listTasks: (query) => {
      const params = new URLSearchParams()
      if (query.workspace) params.set('workspace', query.workspace)
      if (query.status) params.set('status', query.status)
      if (query.limit) params.set('limit', String(query.limit))
      const qs = params.toString()
      return call('GET', `${ENDPOINTS['tasks-list'].path}${qs ? `?${qs}` : ''}`, listTasksData)
    },
  }
}
