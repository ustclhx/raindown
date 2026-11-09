import { HubClient, LEASE_TOKEN_FILE_ENV } from '../daemon/client.ts'
import { readRaindownEnv } from '../env.ts'
import { fail, type Result } from '../result.ts'
import {
  type GetOutput,
  kbGetInput,
  kbQueryInput,
  kbSearchInput,
  type QueryOutput,
  type SearchInput,
  type SearchOutput,
} from '../schema/search.ts'
import { getEntry, queryIndex, searchIndex } from '../search/index-db.ts'
import { defineOperation, type OpContext } from './operation.ts'

/**
 * 任务绑定会话（worker 的派工 MCP）的知识读取经中枢执行（add-worker-credential-isolation D3）：
 * worker 侧进程不读取 raindown-home，凭证只用派工令牌文件。无绑定与唤醒绑定仍在本地读取。
 */
const viaHub = (ctx: OpContext) => ctx.binding?.kind === 'task'

/** 旧中枢没有 kb 路由时的错误：鉴权中间件对派工令牌访问未知接口返回 forbidden，或路由不存在。 */
function missingRoute(error: { code: string; message: string }): boolean {
  return (
    error.code === 'forbidden' ||
    (error.code === 'not_found' && error.message.startsWith('没有这个接口'))
  )
}

/**
 * 调用中枢的 kb 读取路由。不回退到本地读取：回退会让 worker 重新需要读取 raindown-home，使隔离失效。
 */
async function hubKb<T>(
  ctx: OpContext,
  name: 'kb-search' | 'kb-get' | 'kb-query',
  input: unknown,
): Promise<Result<T>> {
  // 只用派工令牌：没有令牌文件时 HubClient 会回退到其他中枢凭证，这里直接拒绝。
  if (!readRaindownEnv(LEASE_TOKEN_FILE_ENV)) {
    return fail(
      'failure',
      'lease_token_required',
      '任务绑定会话的知识读取需要派工令牌文件（RAINDOWN_LEASE_TOKEN_FILE）',
    )
  }
  const r = await new HubClient(ctx).request(name, input)
  if (!r.ok && missingRoute(r.error)) {
    return fail(
      'failure',
      'hub_kb_unsupported',
      '中枢不支持任务绑定的知识读取（中枢版本过旧？请先升级中枢再升级节点）；为保持隔离，不会回退到本地读取',
    )
  }
  return r as Result<T>
}

export const kbSearchOp = defineOperation({
  name: 'kb_search',
  access: 'read',
  cli: 'kb search',
  summary: '检索 brain 条目和工作日志',
  input: kbSearchInput,
  positional: ['query'],
  run: (input: SearchInput, ctx) =>
    viaHub(ctx) ? hubKb<SearchOutput>(ctx, 'kb-search', input) : searchIndex(ctx.home, input),
  human: (output) =>
    output.results.map((r) => `${r.id} — ${r.title}：${r.summary}\n  ${r.snippet}`).join('\n'),
})

export const kbGetOp = defineOperation({
  name: 'kb_get',
  access: 'read',
  cli: 'kb get',
  summary: '按标识读取完整知识条目',
  input: kbGetInput,
  positional: ['id'],
  run: (input: { id: string }, ctx) =>
    viaHub(ctx) ? hubKb<GetOutput>(ctx, 'kb-get', { id: input.id }) : getEntry(ctx.home, input.id),
})

export const kbQueryOp = defineOperation({
  name: 'kb_query',
  access: 'read',
  cli: 'kb query',
  summary: '按 frontmatter 字段筛选知识条目',
  input: kbQueryInput,
  positional: ['filters'],
  run: (input: { filters: string[] }, ctx) =>
    viaHub(ctx)
      ? hubKb<QueryOutput>(ctx, 'kb-query', { filters: input.filters })
      : queryIndex(ctx.home, input.filters),
  human: (output) => output.results.map((r) => `${r.id} — ${r.title}：${r.summary}`).join('\n'),
})
