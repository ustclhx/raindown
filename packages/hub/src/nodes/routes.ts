import {
  ackReplyData,
  acquireLeaseData,
  completeLeaseData,
  ENDPOINTS,
  fail,
  isolationNoticeData,
  listNodesData,
  redactSecrets,
  registerNodeData,
  renewLeaseData,
} from '@raindown/core'
import { Hono } from 'hono'
import { jsonBody, respond } from '../ledger/routes.ts'
import type { NodeService } from './service.ts'

/**
 * 节点与租约路由（protocol.ts 的 nodes-register / nodes-list / leases-*）。
 * 与任务路由一样是独立的 Hono 子应用，认证由主应用负责。
 */
export interface NodeRoutesDeps {
  service: NodeService
}

export function createNodeRoutes({ service }: NodeRoutesDeps): Hono {
  const app = new Hono()

  app.post(ENDPOINTS['nodes-register'].path, async (c) => {
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, registerNodeData)
    return respond(
      c,
      service.registerNode(body.data, c.get('actor') ?? 'unknown'),
      registerNodeData,
    )
  })

  app.post(ENDPOINTS['nodes-isolation-notice'].path, async (c) => {
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, isolationNoticeData)
    return respond(c, service.isolationNotice(c.req.param('id'), body.data), isolationNoticeData)
  })

  app.get(ENDPOINTS['nodes-list'].path, (c) => respond(c, service.listNodes(), listNodesData))

  app.post(ENDPOINTS['leases-acquire'].path, async (c) => {
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, acquireLeaseData)
    const r = await service.acquire(body.data, {
      signal: c.req.raw.signal,
      actor: c.get('actor') ?? 'unknown',
    })
    return respond(c, r, acquireLeaseData)
  })

  app.post(ENDPOINTS['leases-renew'].path, async (c) => {
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, renewLeaseData)
    return respond(c, service.renew(c.req.param('id'), body.data), renewLeaseData)
  })

  app.post(ENDPOINTS['leases-complete'].path, async (c) => {
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, completeLeaseData)
    return respond(c, service.complete(c.req.param('id'), body.data), completeLeaseData)
  })

  app.post(ENDPOINTS['leases-ack-reply'].path, async (c) => {
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, ackReplyData)
    return respond(c, service.ackReply(c.req.param('id'), body.data), ackReplyData)
  })

  app.onError((err, c) =>
    respond(c, fail('failure', 'internal_error', redactSecrets(err.message)), listNodesData),
  )

  return app
}
