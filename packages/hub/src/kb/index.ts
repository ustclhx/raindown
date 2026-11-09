import {
  ENDPOINTS,
  fail,
  getEntry,
  type KbVisibility,
  kbGetOutput,
  kbGetRequest,
  kbQueryOutput,
  kbQueryRequest,
  kbSearchOutput,
  kbSearchRequest,
  queryIndex,
  type Result,
  searchIndex,
} from '@raindown/core'
import { type Context, Hono } from 'hono'
import type { z } from 'zod'
import { errorResponse } from '../app.ts'
import { respond } from '../ledger/routes.ts'
import { fieldIssues } from '../ledger/tasks.ts'

/**
 * 任务绑定的知识读取路由（add-worker-credential-isolation D3；knowledge-access "任务绑定会话经中枢读取"）。
 *
 * - `POST /v1/kb/search`、`/v1/kb/get`、`/v1/kb/query` 与 CLI 的 `raindown kb search|get|query`
 *   使用同一个 core 实现，输出结构相同；
 * - 只接受任务绑定令牌（`fls_`）。user 令牌、绑定令牌（含 `node:*`）、唤醒令牌一律 403 `scope_denied`：
 *   它们的会话在本地读取，不需要这个路由；
 * - 可见范围按令牌绑定的任务所属 workspace 计算（本 workspace 加 global），请求中不能声明 workspace；
 *   别的 workspace 的条目不返回，`kb/get` 对它返回与不存在相同的 not_found；
 * - 令牌每次请求按账本重核（任务结束、租约失效后 401），由鉴权中间件负责。
 */

export interface KbRoutesDeps {
  /** 中枢的 raindown-home；读取其 brain/ 与 state/index.db。 */
  home: string
}

/** 请求体上限：最长的合法请求（20 条各 500 字的条件）也远小于它。 */
const BODY_MAX = 32 * 1024

function visibilityOf(c: Context): KbVisibility | null {
  const auth = c.get('auth')
  return auth?.kind === 'task' ? { workspace: auth.task.workspace } : null
}

async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<Result<z.infer<S>>> {
  const text = await c.req.text()
  if (text.length > BODY_MAX) return fail('usage', 'invalid_arguments', '请求体过大')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return fail('usage', 'invalid_arguments', '请求体不是合法的 JSON')
  }
  const parsed = schema.safeParse(data)
  if (parsed.success) return { ok: true, data: parsed.data }
  const fields = fieldIssues(parsed.error.issues, data)
  return fail(
    'usage',
    'invalid_arguments',
    `请求体不合法：${fields.map((f) => f.message).join('；')}`,
    fields,
  )
}

export function createKbRoutes(deps: KbRoutesDeps): Hono {
  const app = new Hono()

  /** 校验令牌种类与请求体后执行；三个路由共用。 */
  const route = <S extends z.ZodType, O>(
    schema: S,
    output: z.ZodType,
    run: (input: z.infer<S>, visibility: KbVisibility) => Promise<Result<O>>,
  ) => {
    return async (c: Context) => {
      const visibility = visibilityOf(c)
      if (!visibility) return errorResponse(c, 'scope_denied', 'kb 读取路由只接受任务绑定令牌')
      const input = await parseBody(c, schema)
      if (!input.ok) return respond(c, input, output)
      return respond(c, await run(input.data, visibility), output)
    }
  }

  app.post(
    ENDPOINTS['kb-search'].path,
    route(kbSearchRequest, kbSearchOutput, (input, v) => searchIndex(deps.home, input, v)),
  )
  app.post(
    ENDPOINTS['kb-get'].path,
    route(kbGetRequest, kbGetOutput, (input, v) => getEntry(deps.home, input.id, v)),
  )
  app.post(
    ENDPOINTS['kb-query'].path,
    route(kbQueryRequest, kbQueryOutput, (input, v) => queryIndex(deps.home, input.filters, v)),
  )
  return app
}
