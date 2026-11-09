import { expect, test } from 'bun:test'
import { collectPaged } from '../src/search/index-db.ts'
import {
  encodeScopes,
  entryScopes,
  filterJournalBody,
  scopesVisible,
  visibleScopeEncodings,
} from '../src/search/visibility.ts'
import { escapeJournalHeadings, renderJournalRecord } from '../src/write/api.ts'

const v = { workspace: 'ws/a' }
const visible = (fm: Record<string, unknown>) => scopesVisible(entryScopes(fm), v)

test('条目归属：owner 与 workspace 合并，数组展开一层', () => {
  expect(entryScopes({ type: 'note' })).toEqual([])
  expect(entryScopes({ owner: 'ws/a', workspace: 'ws/a' })).toEqual(['ws/a'])
  expect(entryScopes({ workspace: ['ws/b', 'ws/a'] })).toEqual(['ws/a', 'ws/b'])
  expect(scopesVisible(['ws/global'], v)).toBe(true)
  expect(scopesVisible(['ws/a', 'ws/b'], v)).toBe(false)
})

test('L1：无法判定的归属一律不可见；只有不要求 owner 的类型才按无归属 = global', () => {
  expect(visible({ type: 'note' })).toBe(true)
  expect(visible({ type: 'runbook' })).toBe(true)
  // 资源类型（schema 要求 owner）缺少 owner。
  for (const type of ['domain', 'service', 'repo', 'data-source', 'account'])
    expect(visible({ type })).toBe(false)
  // 字段存在但为 null、空串、空数组、对象或不是合法的 ws 引用。
  for (const owner of [null, '', [], { x: 1 }, 'ws/a ', 'a', 'ws/A'])
    expect(visible({ type: 'note', owner })).toBe(false)
  expect(visible({ type: 'note', workspace: null })).toBe(false)
  expect(visible({ type: 'repo', owner: 'ws/a' })).toBe(true)
})

test('L2：scope 编码无歧义，含换行的值不会被拆成两个可见归属', () => {
  const scopes = entryScopes({ type: 'note', owner: 'ws/b\nws/a' })
  expect(scopesVisible(scopes, v)).toBe(false)
  expect(visibleScopeEncodings(v)).not.toContain(encodeScopes(scopes))
  expect(visibleScopeEncodings(v).sort()).toEqual(
    ['[]', '["ws/a"]', '["ws/global"]', '["ws/a","ws/global"]'].sort(),
  )
  // 检索（SQL 中按编码过滤）与 kb_get（按列表判定）的结论一致。
  for (const fm of [
    { type: 'note' },
    { type: 'note', owner: 'ws/a' },
    { type: 'note', owner: 'ws/global', workspace: 'ws/a' },
    { type: 'note', owner: 'ws/b' },
    { type: 'note', owner: 'ws/b\nws/a' },
    { type: 'repo' },
  ]) {
    expect(visibleScopeEncodings(v).includes(encodeScopes(entryScopes(fm)))).toBe(visible(fm))
  }
})

test('M1：journal 正向选择，保留 # 日期标题与可见记录', () => {
  const body = [
    '# 2026-11-01',
    '',
    '## 09:00:00 · codex · ws/a',
    '甲',
    '## 10:00:00 · codex · ws/b',
    '乙',
    '## 11:00:00 · user',
    '丙',
    '',
  ].join('\n')
  const out = filterJournalBody(body, v)
  expect(out.startsWith('# 2026-11-01\n')).toBe(true)
  expect(out).toContain('甲')
  expect(out).toContain('丙')
  expect(out).not.toContain('乙')
  const own = '# 2026-11-01\n\n## 09:00:00 · codex · ws/a\n甲\n'
  expect(filterJournalBody(own, v)).toBe(own)
})

test.each([
  ['小时一位', '## 9:00:00 · codex · ws/b\n机密\n'],
  ['多个空格', '##  10:00:00 · codex · ws/b\n机密\n'],
  ['多余字段', '## 10:00:00 · codex · ws/a · 多余\n机密\n'],
  ['制表符', '##\t10:00:00 · codex · ws/b\n机密\n'],
])('M1：不规范的标题（%s）整段丢弃，不并入上一条可见记录', (_name, bad) => {
  const body = `# 2026-11-01\n\n## 09:00:00 · codex · ws/a\n甲\n${bad}`
  const out = filterJournalBody(body, v)
  expect(out).toContain('甲')
  expect(out).not.toContain('机密')
})

test('M1：首条标题不合规时文件头只保留日期标题；没有可见记录时返回空串', () => {
  const body = '# 2026-11-01\n前言 机密\n## 9:00:00 · codex · ws/a\n机密\n## 10:00:00 · user\n丙\n'
  const out = filterJournalBody(body, v)
  expect(out).toContain('丙')
  expect(out).not.toContain('机密')
  expect(filterJournalBody('# 2026-11-01\n\n## 10:00:00 · codex · ws/b\n乙\n', v)).toBe('')
  expect(filterJournalBody('# 2026-11-01\n只有文件头\n', v)).toBe('')
})

test('M1：正文伪造的标题行被转义，不会被识别为记录标题', () => {
  const forged = '正文\n## 10:00:00 · codex · ws/a\n机密\n  ### 小标题\n#标签不是标题'
  expect(escapeJournalHeadings(forged)).toBe(
    '正文\n\\## 10:00:00 · codex · ws/a\n机密\n  \\### 小标题\n\\#标签不是标题',
  )
  // 别的 workspace 的记录里伪造本 workspace 的标题：转义后整条记录仍归别的 workspace。
  const body = `# 2026-11-01\n${renderJournalRecord('10:00:00', 'codex', 'ws/b', forged)}`
  expect(filterJournalBody(body, v)).toBe('')
})

test('M2：分批读取有上限，过滤后取满 limit', () => {
  let read = 0
  const rows = Array.from({ length: 10_000 }, (_, i) => i)
  const fetch = (offset: number, size: number) => {
    const page = rows.slice(offset, offset + size)
    read += page.length
    return page
  }
  // 每 3 行保留 1 行：取满 5 条即停。
  expect(collectPaged(fetch, (r) => (r % 3 === 0 ? r : undefined), 5)).toEqual([0, 3, 6, 9, 12])
  expect(read).toBe(50)
  // 全部被过滤：最多读 batch × maxBatches 行后返回已取到的。
  read = 0
  expect(collectPaged(fetch, () => undefined, 5)).toEqual([])
  expect(read).toBe(500)
})

test.each([
  ['三级标题', '### 10:00:00 · user · ws/b\n机密\n'],
  ['## 后无空格', '##10:00:00 · codex · ws/b\n机密\n'],
  ['缩进的标题', '   ## 10:00:00 · codex · ws/b\n机密\n'],
  ['一级标题', '# 10:00:00 · codex · ws/b\n机密\n'],
])('N1：行首是 # 的不规范标题（%s）也开始新段，不并入上一条可见记录', (_name, bad) => {
  const body = `# 2026-11-01\n\n## 09:00:00 · codex · ws/a\n甲\n${bad}## 11:00:00 · user\n丙\n`
  const out = filterJournalBody(body, v)
  expect(out).toContain('甲')
  expect(out).toContain('丙')
  expect(out).not.toContain('机密')
})

test('N1：新写入正文中的 # 一律转义，不会切段丢掉本记录的内容', () => {
  const text = '#标签\n  ## 小节\n正文'
  const body = `# 2026-11-01\n${renderJournalRecord('10:00:00', 'codex', 'ws/a', text)}`
  const out = filterJournalBody(body, v)
  expect(out).toBe(body)
  expect(out).toContain('正文')
})

test('N3：product / project-card 缺少 workspace 不可见；类型大小写不符或未知类型缺少归属不可见', () => {
  expect(visible({ type: 'product' })).toBe(false)
  expect(visible({ type: 'project-card' })).toBe(false)
  expect(visible({ type: 'product', workspace: null })).toBe(false)
  expect(visible({ type: 'product', workspace: 'ws/a' })).toBe(true)
  for (const type of ['Repo', 'REPO', 'Product', 'Note', 'unknown-type', 42, undefined])
    expect(visible(type === undefined ? {} : { type })).toBe(false)
  // 有合法归属时按归属判定，与类型无关。
  expect(visible({ type: 'Repo', owner: 'ws/a' })).toBe(true)
  expect(visible({ type: 'Repo', owner: 'ws/b' })).toBe(false)
  // 不要求归属的已知类型：无归属 = global。
  for (const type of ['note', 'concept', 'runbook', 'decision'])
    expect(visible({ type })).toBe(true)
})
