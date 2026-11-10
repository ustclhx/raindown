import { createHash, timingSafeEqual } from 'node:crypto'
import {
  ACTOR_RE,
  ENDPOINTS,
  type EndpointName,
  HEADERS,
  isHttpDeclarableActor,
  isHubIssuedActor,
  isNodeActor,
  USER_ACTOR,
} from '@raindown/core'
import type { Context, MiddlewareHandler } from 'hono'
import { errorResponse } from '../app.ts'
import type { TaskCaller, TaskTokenAuthority } from './lease-tokens.ts'
import type { BoundTokenLookup } from './tokens.ts'
import type { WakeCaller, WakeTokenAuthority } from './wake-tokens.ts'

/** 请求的认证方式：user token（`state/hub.token`）、绑定 token 或唤醒绑定 token（D6）。 */
export type AuthInfo =
  | { kind: 'user' }
  | { kind: 'bound'; token_id: string; remote: boolean }
  | { kind: 'wake'; wake: WakeCaller }
  | { kind: 'task'; task: TaskCaller }
  | { kind: 'none' }

// 子应用无需额外的 Hono 泛型即可读取已校验的审计身份。
declare module 'hono' {
  interface ContextVariableMap {
    actor: string
    auth: AuthInfo
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest()

export interface HubAuthOptions {
  /** user token（`state/hub.token`）。 */
  token?: string
  tokens?: BoundTokenLookup
  /** 唤醒绑定 token（D6）：只有它能认定 `supervisor` 身份。 */
  wakeTokens?: Pick<WakeTokenAuthority, 'authenticate'>
  /** 当前派工绑定的 worker 凭证。 */
  taskTokens?: Pick<TaskTokenAuthority, 'authenticate'>
  /** 某任务未过期的活动租约所属节点 id；用于任务详情与策略检查的 scope 校验。 */
  leaseHolders?: (taskId: string) => readonly string[]
}

/** node:* 身份可以访问的接口；任务详情与策略检查还要校验任务级 scope。 */
const NODE_ENDPOINTS: readonly EndpointName[] = [
  'policy-check',
  'nodes-register',
  'nodes-isolation-notice',
  'leases-acquire',
  'leases-renew',
  'leases-complete',
  'leases-ack-reply',
]

const matcher = (name: EndpointName) => {
  const { method, path } = ENDPOINTS[name]
  const re = new RegExp(`^${path.replace(/:id/g, '([^/]+)')}$`)
  return (c: Context) => (c.req.method === method ? re.exec(c.req.path) : null)
}
const nodeMatchers = NODE_ENDPOINTS.map((n) => ({ name: n, match: matcher(n) }))
const taskShow = matcher('tasks-show')
const eventGet = matcher('events-get')
const policyCheck = matcher('policy-check')
/** 任务绑定的知识读取（add-worker-credential-isolation D3）：范围由路由按凭证的 workspace 计算。 */
const kbReads = (['kb-search', 'kb-get', 'kb-query'] as const).map(matcher)

/** 任务级 scope：user 可调试任意任务；节点只能操作自己持有未过期活动租约的任务。 */
export function checkTaskScope(
  c: Context,
  taskId: string,
  leaseHolders: HubAuthOptions['leaseHolders'],
): Response | null {
  const actor = c.get('actor')
  if (actor === USER_ACTOR) return null
  if (isNodeActor(actor) && leaseHolders?.(taskId).includes(actor.slice('node:'.length)))
    return null
  return errorResponse(c, 'scope_denied', `身份 ${actor} 不能访问该任务`)
}

/**
 * node:* 身份的权限范围：节点协议接口，以及自己持有活动租约任务的详情和策略检查。
 * 策略检查需要先校验请求并查到任务，再在路由中调用 checkTaskScope。
 * 注册与领取时，请求体中的 node_id 必须与身份一致。
 */
async function checkNodeScope(
  c: Context,
  actor: string,
  leaseHolders: HubAuthOptions['leaseHolders'],
): Promise<Response | null> {
  const nodeId = actor.slice('node:'.length)
  const denied = () => errorResponse(c, 'scope_denied', `节点身份 ${actor} 不能访问该接口`)
  const hit = nodeMatchers.find((m) => m.match(c))
  if (hit) {
    if (hit.name === 'nodes-register' || hit.name === 'leases-acquire') {
      let bodyNode: unknown
      try {
        // Hono 缓存请求体，后续路由仍可再次读取。
        bodyNode = (JSON.parse(await c.req.text()) as { node_id?: unknown } | null)?.node_id
      } catch {
        bodyNode = undefined
      }
      if (bodyNode !== undefined && bodyNode !== nodeId) {
        return errorResponse(c, 'scope_denied', `节点身份 ${actor} 不能代表 ${String(bodyNode)}`)
      }
    }
    // 隔离事实上报：路径中的节点必须是本身份。
    if (hit.name === 'nodes-isolation-notice') {
      const m = hit.match(c)
      if (decodeURIComponent(m?.[1] ?? '') !== nodeId)
        return errorResponse(c, 'scope_denied', `节点身份 ${actor} 只能以自己的节点 id 上报`)
    }
    return null
  }
  const show = taskShow(c)
  if (show?.[1]) return checkTaskScope(c, decodeURIComponent(show[1]), leaseHolders)
  return denied()
}

/**
 * 鉴权中间件（hub-daemon "Token 认证"、design D9）。判定表见 `docs/hub-auth.md`：
 *
 * | token                  | X-Raindown-Actor                    | 结果                    |
 * |------------------------|---------------------------------|-------------------------|
 * | 缺失 / 不认识 / 已撤销  | 任意                            | 401 unauthorized        |
 * | 任意有效 token          | 格式不合法                       | 400 invalid_arguments   |
 * | user token             | 缺省、空或 user                  | user                    |
 * | user token             | 保留身份（不分大小写）或 node:*  | 403 reserved_actor      |
 * | user token             | 其他合法身份                     | 该身份（只能降级）        |
 * | 绑定 token             | 与绑定身份不一致（含 user）       | 403 actor_mismatch      |
 * | 绑定 token（remote）    | 缺省或一致                       | 403 remote_not_allowed  |
 * | 绑定 token（node:<id>） | 缺省或一致                       | node:<id>，限节点协议    |
 * | 唤醒绑定 token          | 缺省或 supervisor                | supervisor（绑定该唤醒）  |
 * | 唤醒绑定 token          | 其他                             | 403 actor_mismatch      |
 *
 * `supervisor` 只能由唤醒绑定 token 认定（D6）：user token 声明它（不分大小写）返回 403 `reserved_actor`，
 * 绑定 token 的身份是它时同样拒绝。
 * 摘要用常数时间比较；错误响应不包含凭证或账本信息。健康检查不鉴权，身份记为 `unknown`。
 */
export function hubAuth(options: HubAuthOptions = {}): MiddlewareHandler {
  const { token, tokens, wakeTokens, taskTokens, leaseHolders } = options
  const expected = digest(token ?? '')
  return async (c, next) => {
    if (c.req.method === ENDPOINTS.health.method && c.req.path === ENDPOINTS.health.path) {
      c.set('actor', 'unknown')
      c.set('auth', { kind: 'none' })
      await next()
      return
    }
    const header = c.req.header(HEADERS.authorization) ?? ''
    const presented = /^Bearer (\S+)$/i.exec(header)?.[1]
    if (!presented) return errorResponse(c, 'unauthorized', '未授权')
    const isUser =
      timingSafeEqual(digest(presented), expected) && token !== undefined && token !== ''
    // 各种 token 都检查，避免按 token 种类出现时间差。
    const bound = tokens?.authenticate(presented) ?? null
    const wake = wakeTokens?.authenticate(presented) ?? null
    const task = taskTokens?.authenticate(presented) ?? null
    if (!isUser && !bound && !wake && !task) return errorResponse(c, 'unauthorized', '未授权')

    const currentActor = c.req.header(HEADERS.actor)?.trim()
    const legacyActor = c.req.header('X-Flow-Actor')?.trim()
    if (currentActor !== undefined && legacyActor !== undefined && currentActor !== legacyActor) {
      return errorResponse(c, 'invalid_arguments', 'X-Raindown-Actor 与 X-Flow-Actor 必须一致')
    }
    const declared = currentActor ?? legacyActor ?? ''
    if (declared !== '' && !ACTOR_RE.test(declared)) {
      return errorResponse(c, 'invalid_arguments', '操作者标识格式不合法')
    }
    let actor: string
    if (isUser) {
      if (declared !== '' && !isHttpDeclarableActor(declared)) {
        return errorResponse(
          c,
          'reserved_actor',
          `不能声明保留身份 ${declared}（user 之外的保留身份、node:* 与 supervisor 由中枢设置）`,
        )
      }
      actor = declared === '' ? USER_ACTOR : declared
      c.set('auth', { kind: 'user' })
    } else if (bound) {
      // supervisor 只能由唤醒绑定 token 认定；即使旧文件中有这样的记录也不接受。
      if (isHubIssuedActor(bound.actor)) {
        return errorResponse(c, 'reserved_actor', `绑定 token 不能代表 ${bound.actor}`)
      }
      if (declared !== '' && declared !== bound.actor) {
        return errorResponse(
          c,
          'actor_mismatch',
          `该 token 绑定的身份为 ${bound.actor}，不能声明为 ${declared}`,
        )
      }
      if (bound.remote) {
        return errorResponse(
          c,
          'remote_not_allowed',
          '远程 token 只能用于远程入口，不能访问本机端口',
        )
      }
      actor = bound.actor
      c.set('auth', { kind: 'bound', token_id: bound.id, remote: bound.remote })
    } else if (wake) {
      if (declared !== '' && declared !== wake.actor) {
        return errorResponse(
          c,
          'actor_mismatch',
          `该 token 绑定的身份为 ${wake.actor}，不能声明为 ${declared}`,
        )
      }
      actor = wake.actor
      c.set('auth', { kind: 'wake', wake })
    } else if (task) {
      if (declared !== '' && declared !== task.actor) {
        return errorResponse(c, 'actor_mismatch', `该 token 绑定的身份为 ${task.actor}`)
      }
      actor = task.actor
      c.set('auth', { kind: 'task', task })
    } else return errorResponse(c, 'unauthorized', '未授权')
    c.set('actor', actor)
    if (c.get('auth').kind === 'task') {
      // 身份与 scope 来自凭证，任何自报 task id 或 actor 都不能扩权。默认拒绝未来新增接口。
      const show = taskShow(c)
      const report =
        c.req.method === 'POST' ? /^\/v1\/tasks\/([^/]+)\/report$/.exec(c.req.path) : null
      // 事件范围由路由读取事件后按凭证的任务与 workspace 校验。
      // 知识读取的可见范围由路由按凭证绑定的 workspace 过滤。
      if (
        eventGet(c) ||
        kbReads.some((m) => m(c)) ||
        (c.req.method === 'GET' && c.req.path === '/v1/binding')
      ) {
        await next()
        return
      }
      const id = show?.[1] ?? report?.[1]
      let decoded: string | undefined
      try {
        decoded = id === undefined ? undefined : decodeURIComponent(id)
      } catch {
        return errorResponse(c, 'invalid_arguments', '任务路径编码不合法')
      }
      if (!decoded || decoded !== task?.task_id) {
        return errorResponse(c, 'forbidden', '派工凭证只能读取与上报当前任务')
      }
      await next()
      return
    }
    if (policyCheck(c) && actor !== USER_ACTOR && !isNodeActor(actor)) {
      return errorResponse(c, 'scope_denied', '策略检查只允许 user 或持有活动租约的节点调用')
    }
    if (isNodeActor(actor)) {
      const denied = await checkNodeScope(c, actor, leaseHolders)
      if (denied) return denied
    }
    // 节点协议的写接口（注册、领取、续约、完成、ack-reply）只允许 user（本机节点用 user token）与 node:*。
    // 其他身份（user token 降级的 AI、绑定 AI token、唤醒绑定 token）一律拒绝：领取租约会拿到任务合同、
    // 唤醒绑定 token 与租约令牌（add-m1-supervisor D6）。
    if (actor !== USER_ACTOR && !isNodeActor(actor) && nodeMatchers.some((m) => m.match(c))) {
      return errorResponse(c, 'scope_denied', `身份 ${actor} 不能访问节点协议接口`)
    }
    await next()
  }
}

/**
 * 只有用户能做的操作（hub-daemon "只有用户能做的操作"）：身份不是 user 时返回 403 `user_only`，
 * 在读取请求体和调用服务之前拒绝，因此不会产生任何事件。
 */
export function userOnly(what: string): MiddlewareHandler {
  return async (c, next) => {
    const who = c.get('actor')
    if (who !== USER_ACTOR) {
      return errorResponse(c, 'user_only', `只有用户本人可以${what}，当前身份为 ${who}`)
    }
    await next()
  }
}
