import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getEntry, initRaindownHome, queryIndex, searchIndex } from '@raindown/core'
import { tempHome, writeEntry, writeText } from '../../core/test/helpers.ts'
import { createHubApp } from '../src/app.ts'
import { createKbRoutes } from '../src/kb/index.ts'
import type { HubTokenStore } from '../src/server/tokens.ts'

interface Doc {
  ok: boolean
  data: { results: { id: string }[]; body: string } & Record<string, unknown>
  error: { code: string; message: string }
}

/**
 * 任务绑定的 kb 读取路由（add-worker-credential-isolation 2.1、D3）：令牌种类、workspace 可见范围、
 * 参数校验。鉴权中间件的各类令牌用替身，路由本身用真实的 core 实现与临时 home。
 */

const USER = 'user-fixture'
const TASK = 'fls_fixture-task'
const TASK_XUANXUE = 'fls_fixture-other-ws'
const WAKE = 'fwk_fixture'
const BOUND = 'fht_fixture'
const NODE = 'fht_fixture-node'

let home: string
let app: ReturnType<typeof createHubApp>

const taskCaller = (workspace: string) => ({
  actor: 'dev',
  task_id: 't1',
  workspace,
  lease_id: 'l1',
  attempt: 1,
})

beforeAll(async () => {
  home = tempHome('raindown-kb-routes-')
  const r = await initRaindownHome(home)
  if (!r.ok) throw new Error(r.error.message)
  writeEntry(home, 'concepts/ganzhi', {
    type: 'concept',
    title: '干支日 概念',
    summary: '全局概念',
    scope: 'work',
  })
  writeEntry(home, 'resources/repos/res', {
    type: 'repo',
    title: '干支日 仓库甲',
    summary: '本 workspace 的仓库',
    scope: 'work',
    owner: 'ws/product-res',
    path: '/tmp/res',
  })
  writeEntry(home, 'resources/repos/xuanxue', {
    type: 'repo',
    title: '干支日 仓库乙',
    summary: '别的 workspace 的仓库',
    scope: 'work',
    owner: 'ws/xuanxue-saas',
    path: '/tmp/xuanxue',
  })
  writeEntry(home, 'products/mixed', {
    type: 'product',
    title: '干支日 产品',
    summary: '归属不一致的条目按不可见处理',
    scope: 'work',
    owner: 'ws/product-res',
    workspace: 'ws/xuanxue-saas',
    status: 'beta',
  })
  writeEntry(home, 'notes/bad-owner', {
    type: 'note',
    title: '干支日 坏归属',
    summary: '归属不是字符串',
    scope: 'work',
    owner: { nested: true },
  })
  writeText(
    join(home, 'brain', 'journal', '2026-11-01.md'),
    [
      '# 2026-11-01',
      '',
      '## 09:00:00 · codex · ws/product-res',
      '',
      '本 workspace 记录：干支日 进展',
      '',
      '## 10:00:00 · codex · ws/xuanxue-saas',
      '',
      '别的 workspace 记录：机密排期',
      '',
      '## 11:00:00 · user',
      '',
      '未标 workspace 的记录',
      '',
    ].join('\n'),
  )
  writeText(
    join(home, 'brain', 'journal', '2026-11-02.md'),
    '# 2026-11-02\n\n## 09:00:00 · codex · ws/xuanxue-saas\n\n只属于别的 workspace：干支日 秘密\n',
  )
  app = createHubApp({
    token: USER,
    tokens: {
      authenticate: (t: string) =>
        t === BOUND
          ? { id: 'tok_a', actor: 'codex', remote: false }
          : t === NODE
            ? { id: 'tok_b', actor: 'node:n1', remote: false }
            : null,
    } as unknown as HubTokenStore,
    wakeTokens: {
      authenticate: (t) =>
        t === WAKE
          ? {
              actor: 'supervisor',
              task_id: 'w1',
              workspace: 'ws/product-res',
              lease_id: 'lw',
              origin: 'instruction',
              generation: 1,
            }
          : null,
    },
    taskTokens: {
      authenticate: (t) =>
        t === TASK
          ? taskCaller('ws/product-res')
          : t === TASK_XUANXUE
            ? taskCaller('ws/xuanxue-saas')
            : null,
    },
    mount: [{ path: '/', app: createKbRoutes({ home }) }],
  })
})

afterAll(() => rmSync(dirname(home), { recursive: true, force: true }))

async function call(path: string, body: unknown, token = TASK, actor?: string) {
  const res = await app.request(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(actor ? { 'X-Raindown-Actor': actor } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, doc: (await res.json()) as Doc }
}

const ids = (doc: Doc) => doc.data.results.map((r) => r.id)

describe('令牌种类', () => {
  test.each([
    ['user 令牌', USER, undefined],
    ['user 令牌降级为 AI', USER, 'dev'],
    ['绑定令牌', BOUND, undefined],
    ['节点令牌', NODE, undefined],
    ['唤醒令牌', WAKE, undefined],
  ])('%s 被拒绝', async (_name, token, actor) => {
    for (const path of ['/v1/kb/search', '/v1/kb/get', '/v1/kb/query']) {
      const body =
        path === '/v1/kb/search'
          ? { query: '干支日' }
          : path === '/v1/kb/get'
            ? { id: 'concepts/ganzhi' }
            : { filters: ['type=concept'] }
      const { status, doc } = await call(path, body, token, actor)
      expect(status).toBe(403)
      expect(doc).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
    }
  })

  test('不认识或已失效的令牌 401', async () => {
    const { status, doc } = await call('/v1/kb/search', { query: '干支日' }, 'fls_unknown')
    expect(status).toBe(401)
    expect(doc.error.code).toBe('unauthorized')
  })

  test('任务令牌不能声明别的身份', async () => {
    const { status, doc } = await call('/v1/kb/search', { query: '干支日' }, TASK, 'user')
    expect(status).toBe(403)
    expect(doc.error.code).toBe('actor_mismatch')
  })
})

describe('可见范围', () => {
  test('search：只返回本 workspace 与 global；结果与不过滤的同一实现在可见条目上一致', async () => {
    const { status, doc } = await call('/v1/kb/search', { query: '干支日' })
    expect(status).toBe(200)
    expect(ids(doc).sort()).toEqual(
      ['concepts/ganzhi', 'journal/2026-11-01', 'resources/repos/res'].sort(),
    )
    const full = await searchIndex(home, { query: '干支日' })
    if (!full.ok) throw new Error(full.error.message)
    // 没有被过滤的条目与 CLI（同一实现、不带可见范围）完全相同，顺序也相同。
    const visible = new Set(['concepts/ganzhi', 'resources/repos/res'])
    expect(doc.data.results.filter((r) => visible.has(r.id))).toEqual(
      full.data.results.filter((r) => visible.has(r.id)),
    )
    // 别的 workspace 的令牌看到另一半。
    const other = await call('/v1/kb/search', { query: '干支日' }, TASK_XUANXUE)
    expect(ids(other.doc).sort()).toEqual(
      ['concepts/ganzhi', 'journal/2026-11-02', 'resources/repos/xuanxue'].sort(),
    )
  })

  test('search：journal 中别的 workspace 的记录不参与匹配，也不出现在片段中', async () => {
    const secret = await call('/v1/kb/search', { query: '机密排期' })
    expect(ids(secret.doc)).toEqual([])
    const own = await call('/v1/kb/search', { query: '进展' })
    expect(ids(own.doc)).toEqual(['journal/2026-11-01'])
    expect(JSON.stringify(own.doc)).not.toContain('机密')
    // 短查询（LIKE 路径）同样过滤。
    const short = await call('/v1/kb/search', { query: '机密' })
    expect(ids(short.doc)).toEqual([])
  })

  test('search：过滤后仍能取满 limit', async () => {
    const { doc } = await call('/v1/kb/search', { query: '干支日', limit: 2 })
    expect(doc.data.results).toHaveLength(2)
  })

  test('query：别的 workspace 的条目不返回', async () => {
    const all = await call('/v1/kb/query', { filters: ['type=repo'] })
    expect(ids(all.doc)).toEqual(['resources/repos/res'])
    const other = await call('/v1/kb/query', { filters: ['owner=ws/xuanxue-saas'] })
    expect(ids(other.doc)).toEqual([])
    const local = await queryIndex(home, ['type=repo', 'owner=ws/product-res'])
    const viaHub = await call('/v1/kb/query', { filters: ['type=repo', 'owner=ws/product-res'] })
    expect(viaHub.doc.data as unknown).toEqual(local.ok ? local.data : undefined)
  })

  test('get：别的 workspace 的条目与不存在的条目返回同样的 not_found', async () => {
    const own = await call('/v1/kb/get', { id: 'resources/repos/res' })
    const local = await getEntry(home, 'resources/repos/res')
    expect(own.doc.data as unknown).toEqual(local.ok ? local.data : undefined)
    for (const id of ['resources/repos/xuanxue', 'products/mixed', 'notes/bad-owner']) {
      const hidden = await call('/v1/kb/get', { id })
      expect(hidden.status).toBe(404)
      expect(hidden.doc.error).toMatchObject({ code: 'not_found', message: `未找到条目：${id}` })
      const missing = await call('/v1/kb/get', { id: `${id}-missing` })
      expect(missing.status).toBe(404)
      expect(missing.doc.error.message).toBe(`未找到条目：${id}-missing`)
    }
  })

  test('get：journal 只保留可见记录', async () => {
    const { doc } = await call('/v1/kb/get', { id: 'journal/2026-11-01' })
    expect(doc.data.body).toContain('本 workspace 记录')
    expect(doc.data.body).toContain('未标 workspace 的记录')
    expect(doc.data.body).not.toContain('机密排期')
  })
})

describe('参数校验', () => {
  test.each([
    ['/v1/kb/search', { query: 'x'.repeat(501) }],
    ['/v1/kb/search', { query: '干支日', limit: 101 }],
    ['/v1/kb/search', { query: '   ' }],
    ['/v1/kb/search', '不是 JSON'],
    ['/v1/kb/get', { id: '../config/hub' }],
    ['/v1/kb/get', { id: '/etc/passwd' }],
    ['/v1/kb/get', { id: 'notes/../../state/hub' }],
    ['/v1/kb/get', { id: 'notes\\x' }],
    ['/v1/kb/get', { id: '.hidden/x' }],
    ['/v1/kb/get', { id: 'x'.repeat(513) }],
    ['/v1/kb/query', { filters: [] }],
    ['/v1/kb/query', { filters: Array.from({ length: 21 }, () => 'type=repo') }],
  ])('%s %j → 400', async (path, body) => {
    const { status, doc } = await call(path, body)
    expect(status).toBe(400)
    expect(doc.error.code).toBe('invalid_arguments')
  })

  test('过大的请求体被拒绝', async () => {
    const { status } = await call('/v1/kb/search', { query: '干支日', pad: 'x'.repeat(40_000) })
    expect(status).toBe(400)
  })
})
