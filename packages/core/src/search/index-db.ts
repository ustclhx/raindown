import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type BrainEntry, entryIdOf, listEntryFiles, readBrainEntries } from '../entries.ts'
import { parseFrontmatter } from '../frontmatter.ts'
import { raindownPaths } from '../home.ts'
import { fail, ok, type Result } from '../result.ts'
import type { GetOutput, QueryOutput, SearchInput, SearchOutput } from '../schema/search.ts'
import { type Database, openDatabase, type SqlValue } from '../sqlite.ts'
import {
  decodeScopes,
  encodeScopes,
  entryScopes,
  filterJournalBody,
  type KbVisibility,
  scopesVisible,
} from './visibility.ts'

// 2：entries 增加 scope 列（条目归属的 workspace，用于任务绑定读取的可见范围）。
const INDEX_VERSION = 2
const JOURNAL_FILE = /^\d{4}-\d{2}-\d{2}\.md$/

function scalar(value: unknown): string | undefined {
  if (value === null) return 'null'
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value)
  return undefined
}

/** 仅展开一层数组；对象不是可查询的标量字段。 */
function fieldsOf(frontmatter: Record<string, unknown>): [string, string][] {
  return Object.entries(frontmatter).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value]).flatMap((v) => {
      const text = scalar(v)
      return text === undefined ? [] : [[key, text] as [string, string]]
    }),
  )
}

const textField = (fm: Record<string, unknown>, key: string, fallback = '') =>
  typeof fm[key] === 'string' ? fm[key] : fallback

function journalEntry(home: string, name: string, body: string): BrainEntry {
  const id = `journal/${name.slice(0, -3)}`
  return {
    id,
    file: `brain/${id}.md`,
    absPath: join(raindownPaths(home).journal, name),
    frontmatter: { type: 'journal', title: id, summary: '' },
    body,
  }
}

async function journalFiles(home: string): Promise<string[]> {
  try {
    return (await readdir(raindownPaths(home).journal, { withFileTypes: true }))
      .filter((e) => e.isFile() && JOURNAL_FILE.test(e.name))
      .map((e) => e.name)
      .sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

function ensureSchema(db: Database): void {
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (version.user_version === INDEX_VERSION) return
  db.exec(`
    DROP TABLE IF EXISTS search;
    DROP TABLE IF EXISTS fields;
    DROP TABLE IF EXISTS entries;
    CREATE TABLE entries (
      id TEXT PRIMARY KEY, file TEXT NOT NULL, hash TEXT NOT NULL, mtime REAL NOT NULL,
      type TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, scope TEXT NOT NULL
    );
    CREATE TABLE fields (entry_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL);
    CREATE INDEX fields_lookup ON fields (key, value, entry_id);
    CREATE VIRTUAL TABLE search USING fts5(
      id UNINDEXED, title, summary, body, field_values, tokenize='trigram'
    );
    PRAGMA user_version = ${INDEX_VERSION};
  `)
}

/** 对比文件清单、mtime 与 SHA-256；索引版本变化时整体重建。 */
export async function syncIndex(home: string): Promise<Result<undefined>> {
  let db: Database | undefined
  try {
    const paths = raindownPaths(home)
    // 先发现 brain 文件，避免未初始化时创建 state/。
    const files = await listEntryFiles(paths.brain)
    const documents: { entry: BrainEntry; hash: string; mtime: number }[] = []
    const journalNames = await journalFiles(home)
    for (const file of [...files, ...journalNames.map((name) => join(paths.journal, name))]) {
      const content = await readFile(file, 'utf8')
      const mtime = (await stat(file)).mtimeMs
      const id = entryIdOf(paths.brain, file)
      let entry: BrainEntry
      if (id.startsWith('journal/')) {
        entry = journalEntry(home, `${id.slice('journal/'.length)}.md`, content)
      } else {
        const parsed = parseFrontmatter(content)
        // 与 readBrainEntries 一致：解析失败的条目不进入索引。
        if (!parsed.ok) continue
        entry = {
          id,
          file: `brain/${id}.md`,
          absPath: file,
          frontmatter: parsed.data.data,
          body: parsed.data.body,
        }
      }
      documents.push({ entry, hash: createHash('sha256').update(content).digest('hex'), mtime })
    }
    await mkdir(paths.state, { recursive: true })
    db = await openDatabase(join(paths.state, 'index.db'))
    const index = db
    index.transaction(() => {
      ensureSchema(index)
      const previous = new Map(
        (
          index.prepare('SELECT id, file, hash, mtime FROM entries').all() as {
            id: string
            file: string
            hash: string
            mtime: number
          }[]
        ).map((e) => [e.id, e]),
      )
      const remove = (id: string) => {
        index.prepare('DELETE FROM search WHERE id = ?').run(id)
        index.prepare('DELETE FROM fields WHERE entry_id = ?').run(id)
        index.prepare('DELETE FROM entries WHERE id = ?').run(id)
      }
      for (const { entry, hash, mtime } of documents) {
        const old = previous.get(entry.id)
        previous.delete(entry.id)
        if (old?.hash === hash && old.mtime === mtime && old.file === entry.file) continue
        remove(entry.id)
        const type = textField(entry.frontmatter, 'type')
        const title = textField(entry.frontmatter, 'title', entry.id)
        const summary = textField(entry.frontmatter, 'summary')
        const fields = fieldsOf(entry.frontmatter)
        // journal 的归属按记录在读取时过滤，文件本身记为 global。
        const scope = entry.id.startsWith('journal/')
          ? ''
          : encodeScopes(entryScopes(entry.frontmatter))
        index
          .prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(entry.id, entry.file, hash, mtime, type, title, summary, scope)
        index
          .prepare(
            'INSERT INTO search (id, title, summary, body, field_values) VALUES (?, ?, ?, ?, ?)',
          )
          .run(entry.id, title, summary, entry.body, fields.map(([, v]) => v).join('\n'))
        const insertField = index.prepare('INSERT INTO fields VALUES (?, ?, ?)')
        for (const [key, value] of fields) insertField.run(entry.id, key, value)
      }
      for (const id of previous.keys()) remove(id)
    })
    return ok(undefined)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return fail('failure', 'not_initialized', '未找到 brain，请先运行 raindown init')
    }
    return fail('failure', 'index_failed', `同步检索索引失败：${(err as Error).message}`)
  } finally {
    db?.close()
  }
}

/** LIKE 通配符也按字面匹配，避免用户输入改变查询含义。 */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`

function excerpt(text: string, query: string): string {
  const position = text.toLowerCase().indexOf(query.toLowerCase())
  const start = Math.max(0, position - 40)
  return `${start ? '…' : ''}${text
    .slice(start, start + 160)
    .replace(/\s+/g, ' ')
    .trim()}${text.length > start + 160 ? '…' : ''}`
}

/** 文本是否包含查询词（不区分大小写）；与 trigram 短语匹配、LIKE 子串匹配的语义一致。 */
const containsQuery = (text: string, query: string) =>
  text.toLowerCase().includes(query.toLowerCase())

/**
 * 每次检索前同步；FTS 输入统一引用为短语，短查询使用 LIKE。score 越大越相关。
 *
 * 给出 `visibility`（任务绑定经中枢读取，D3）时：不可见的条目在 SQL 中排除；journal 去掉不可见的记录后
 * 若不再包含查询词则不返回，片段按过滤后的正文重算。为了在过滤后仍能取满 `limit`，先取全部命中再截断，
 * 排序与不带可见范围时相同。
 */
export async function searchIndex(
  home: string,
  input: SearchInput,
  visibility?: KbVisibility,
): Promise<Result<SearchOutput>> {
  const synced = await syncIndex(home)
  if (!synced.ok) return synced
  const db = await openDatabase(join(raindownPaths(home).state, 'index.db'))
  try {
    const query = input.query.trim()
    const short = Array.from(query).length < 3
    const params: SqlValue[] = []
    const conditions: string[] = []
    if (short) {
      conditions.push(`(s.title LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\'
        OR s.body LIKE ? ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM fields f WHERE f.entry_id = e.id AND f.value LIKE ? ESCAPE '\\'))`)
      params.push(...Array<SqlValue>(4).fill(likePattern(query)))
    } else {
      conditions.push('search MATCH ?')
      params.push(`"${query.replaceAll('"', '""')}"`)
    }
    if (input.type !== undefined) {
      conditions.push('e.type = ?')
      params.push(input.type)
    }
    if (input.includeJournal === false) conditions.push("e.type != 'journal'")
    const limit = input.limit ?? 20
    if (!visibility) params.push(limit)
    let rows = db
      .prepare(`
      SELECT e.id, e.type, e.title, e.summary, e.scope, s.body, s.field_values,
        ${short ? '1.0' : '-bm25(search, 0, 5, 2, 1, 1)'} AS score,
        ${short ? "''" : "snippet(search, -1, '', '', '…', 40)"} AS snippet
      FROM search s JOIN entries e ON e.id = s.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY (e.type = 'journal'), score DESC, e.id${visibility ? '' : ' LIMIT ?'}
    `)
      .all(...params) as (SearchOutput['results'][number] & {
      scope: string
      body: string
      field_values: string
    })[]
    if (visibility) {
      rows = rows
        .filter((row) => scopesVisible(decodeScopes(row.scope), visibility))
        .flatMap((row) => {
          if (!row.id.startsWith('journal/')) return [row]
          const body = filterJournalBody(row.body, visibility)
          if (body === row.body) return [row]
          // 去掉了别的 workspace 的记录：只按剩下的正文判断是否命中，片段也只从剩下的正文中取。
          if (![row.title, row.summary, body].some((v) => containsQuery(v, query))) return []
          return [{ ...row, body, snippet: short ? '' : excerpt(body, query) }]
        })
        .slice(0, limit)
    }
    return ok({
      results: rows.map(({ body, field_values, scope: _scope, ...row }) => ({
        ...row,
        snippet: short
          ? excerpt(
              [row.title, row.summary, body, field_values].find((v) => containsQuery(v, query)) ??
                body,
              query,
            )
          : row.snippet.replace(/\s+/g, ' ').trim(),
      })),
    })
  } catch (err) {
    return fail('failure', 'search_failed', `检索失败：${(err as Error).message}`)
  } finally {
    db.close()
  }
}

/** 多条件 AND；同一字段可以重复指定以匹配数组中的多个值。给出 `visibility` 时只返回可见的条目。 */
export async function queryIndex(
  home: string,
  filters: string[],
  visibility?: KbVisibility,
): Promise<Result<QueryOutput>> {
  const parsed = filters.map((filter) => /^([^=\s]+)=(.+)$/s.exec(filter))
  if (filters.length === 0 || parsed.some((p) => !p?.[2]?.trim())) {
    return fail('usage', 'invalid_filter', '过滤条件必须为 key=value，且键和值不能为空')
  }
  const synced = await syncIndex(home)
  if (!synced.ok) return synced
  const db = await openDatabase(join(raindownPaths(home).state, 'index.db'))
  try {
    const conditions = parsed.map(
      () => 'EXISTS (SELECT 1 FROM fields f WHERE f.entry_id = e.id AND f.key = ? AND f.value = ?)',
    )
    const params = parsed.flatMap((p) => [p?.[1] as string, p?.[2] as string])
    const rows = db
      .prepare(
        `SELECT id, type, title, summary, scope FROM entries e WHERE ${conditions.join(' AND ')} ORDER BY id`,
      )
      .all(...params) as (QueryOutput['results'][number] & { scope: string })[]
    return ok({
      results: rows
        .filter((row) => !visibility || scopesVisible(decodeScopes(row.scope), visibility))
        .map(({ scope: _scope, ...row }) => row),
    })
  } catch (err) {
    return fail('failure', 'query_failed', `字段查询失败：${(err as Error).message}`)
  } finally {
    db.close()
  }
}

/**
 * 从文件读取完整条目，不依赖索引缓存；journal 返回合成的基本元数据。
 * 给出 `visibility` 时：不可见的条目与不存在的条目返回同样的 not_found（不泄露存在性），
 * journal 只保留可见的记录。
 */
export async function getEntry(
  home: string,
  id: string,
  visibility?: KbVisibility,
): Promise<Result<GetOutput>> {
  const read = await readBrainEntries(home)
  if (!read.ok) return read
  let entry = read.data.entries.find((e) => e.id === id)
  if (!entry && id.startsWith('journal/')) {
    const name = `${id.slice('journal/'.length)}.md`
    if ((await journalFiles(home)).includes(name)) {
      entry = journalEntry(
        home,
        name,
        await readFile(join(raindownPaths(home).journal, name), 'utf8'),
      )
    }
  }
  if (
    !entry ||
    (visibility &&
      !entry.id.startsWith('journal/') &&
      !scopesVisible(entryScopes(entry.frontmatter), visibility))
  ) {
    return fail('failure', 'not_found', `未找到条目：${id}`)
  }
  const body =
    visibility && entry.id.startsWith('journal/')
      ? filterJournalBody(entry.body, visibility)
      : entry.body
  return ok({
    id: entry.id,
    type: textField(entry.frontmatter, 'type'),
    frontmatter: entry.frontmatter,
    body,
    file: entry.file,
  })
}
