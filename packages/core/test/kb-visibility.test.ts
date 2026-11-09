import { expect, test } from 'bun:test'
import { entryScopes, filterJournalBody, scopesVisible } from '../src/search/visibility.ts'

const v = { workspace: 'ws/a' }

test('条目归属：owner 与 workspace 合并，数组展开一层，非字符串记为无法判定', () => {
  expect(entryScopes({ type: 'note' })).toEqual([])
  expect(entryScopes({ owner: 'ws/a', workspace: 'ws/a' })).toEqual(['ws/a'])
  expect(entryScopes({ workspace: ['ws/b', 'ws/a'] })).toEqual(['ws/a', 'ws/b'])
  expect(scopesVisible(entryScopes({ owner: { x: 1 } }), v)).toBe(false)
  expect(scopesVisible(entryScopes({ workspace: null }), v)).toBe(true)
  expect(scopesVisible(['ws/global'], v)).toBe(true)
  expect(scopesVisible(['ws/a', 'ws/b'], v)).toBe(false)
})

test('journal 过滤：保留文件头、未标 workspace 与可见记录；字段数异常的记录不可见', () => {
  const body = [
    '# 2026-11-01',
    '',
    '## 09:00:00 · codex · ws/a',
    '甲',
    '## 10:00:00 · codex · ws/b',
    '乙',
    '## 11:00:00 · user',
    '丙',
    '## 12:00:00 · codex · ws/a · 多余',
    '丁',
    '',
  ].join('\n')
  const out = filterJournalBody(body, v)
  expect(out).toContain('# 2026-11-01')
  expect(out).toContain('甲')
  expect(out).toContain('丙')
  expect(out).not.toContain('乙')
  expect(out).not.toContain('丁')
  const own = '# d\n\n## 09:00:00 · codex · ws/a\n甲\n'
  expect(filterJournalBody(own, v)).toBe(own)
})
