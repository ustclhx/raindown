import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { BRAIN_JOURNAL_DIR } from '../entries.ts'
import { raindownPaths } from '../home.ts'
import { fail, ok, type Result } from '../result.ts'
import { entryId as entryIdSchema, WS_REF_RE } from '../schema/common.ts'
import { localDate } from '../validate.ts'
import { loadWorkspaces } from '../workspaces.ts'
import {
  checkRepoReady,
  commitWrite,
  hashContent,
  type WriteContext,
  type WriteReceipt,
} from './commit.ts'
import { type WriteLock, withWriteLock } from './lock.ts'
import { checkRepoPath, classifyBrainPath } from './policy.ts'
import type { LogOp } from './render.ts'

/**
 * 建立在 `commitWrite` 之上的便捷写入函数。它们只负责拼装内容，
 * 策略、校验、扫描、提交都由 `commitWrite` 统一完成。
 */

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

/** 本地时间的 ISO 8601（带时区偏移），例如 `2026-10-24T14:03:05+08:00`。 */
export function localIsoTime(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${localDate(d)}T${localTime(d)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 截取正文第一行作为 log 简述。 */
const firstLine = (text: string, max = 60): string => {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

// ---------------------------------------------------------------------------
// 条目

export type EntryInput =
  | { id: string; content: string }
  | { id: string; frontmatter: Record<string, unknown>; body?: string }

export interface WriteEntryOptions extends WriteContext {
  /**
   * 冲突检测（design D4）：`undefined` 不检查（不存在则新建、存在则替换）；
   * `null` 要求条目尚不存在；字符串要求条目存在且当前内容的 `hashContent` 与之相等。
   */
  expectedBaseHash?: string | null
  /** log 操作类型，默认 `apply`。 */
  op?: LogOp
  /** log 与提交信息的简述，默认 `新增 <id>` / `更新 <id>`。 */
  summary?: string
}

export interface WriteEntryReceipt extends WriteReceipt {
  id: string
  /** 写入后条目内容的哈希。 */
  hash: string
  created: boolean
}

/** 由 frontmatter 与正文拼出条目文件内容。 */
export function renderEntry(frontmatter: Record<string, unknown>, body = ''): string {
  return `---\n${stringify(frontmatter)}---\n${body}`
}

/** 条目标识 → 相对 brain 的文件路径；标识不合法时返回错误。 */
export function entryPath(id: string): Result<string> {
  const parsed = entryIdSchema.safeParse(id)
  const path = `${id}.md`
  const bad = parsed.success ? checkRepoPath(path) : null
  if (!parsed.success || bad || classifyBrainPath(path) !== 'entry') {
    return fail('usage', 'invalid_entry_id', `条目标识不合法：${JSON.stringify(id)}`)
  }
  return ok(path)
}

/** 新增或整体替换一个 brain 条目（走 schema 校验与 AI 写入边界）。 */
export async function writeEntry(
  home: string,
  input: EntryInput,
  opts: WriteEntryOptions,
): Promise<Result<WriteEntryReceipt>> {
  const path = entryPath(input.id)
  if (!path.ok) return path
  const notReady = checkRepoReady(home, 'brain')
  if (notReady) return notReady
  const content = 'content' in input ? input.content : renderEntry(input.frontmatter, input.body)
  const { expectedBaseHash, op, summary, ...ctx } = opts

  // 在锁内判断条目是否存在，避免判断与写入之间被别的进程插入。
  const writeLocked = async (lock: WriteLock): Promise<Result<WriteEntryReceipt>> => {
    const exists = existsSync(join(raindownPaths(home).brain, path.data))
    if (expectedBaseHash === null && exists) {
      return fail('failure', 'base_conflict', `条目已存在，不能新建：${input.id}`, {
        path: path.data,
        expected: null,
      })
    }
    if (typeof expectedBaseHash === 'string' && !exists) {
      return fail('failure', 'base_conflict', `条目已不存在，不予写入：${input.id}`, {
        path: path.data,
        expected: expectedBaseHash,
        actual: null,
      })
    }
    const r = await commitWrite(
      home,
      {
        repo: 'brain',
        op: op ?? 'apply',
        summary: summary ?? `${exists ? '更新' : '新增'} ${input.id}`,
        files: [
          exists
            ? {
                op: 'replace',
                path: path.data,
                content,
                ...(typeof expectedBaseHash === 'string' ? { baseHash: expectedBaseHash } : {}),
              }
            : { op: 'create', path: path.data, content },
        ],
      },
      { ...ctx, lock },
    )
    if (!r.ok) return r
    return ok({ ...r.data, id: input.id, hash: hashContent(content), created: !exists })
  }
  if (ctx.lock) return writeLocked(ctx.lock)
  return withWriteLock(
    home,
    writeLocked,
    ctx.lockTimeoutMs === undefined ? {} : { timeoutMs: ctx.lockTimeoutMs },
  )
}

// ---------------------------------------------------------------------------
// journal

export interface JournalInput {
  /** 关联的 workspace（`ws/<id>`），可选。 */
  workspace?: string
  text: string
}

export interface JournalReceipt extends WriteReceipt {
  /** 相对 raindown-home 的 journal 文件，例如 `brain/journal/2026-10-24.md`。 */
  file: string
  date: string
  time: string
}

/**
 * 转义正文行首（可有缩进）的 `#`：正文不能伪造 journal 记录标题行，也不会在按记录过滤时切出新段，
 * 记录归属（workspace）的判定因此只取决于真正的标题行（add-worker-credential-isolation D3）。
 */
export const escapeJournalHeadings = (text: string): string => text.replace(/^([ \t]*)#/gm, '$1\\#')

/** 一条 journal 记录的 Markdown：标题行带时间、操作者、workspace，下面是正文。 */
export function renderJournalRecord(
  time: string,
  actor: string,
  workspace: string | undefined,
  text: string,
): string {
  const head = [time, actor, ...(workspace ? [workspace] : [])].join(' · ')
  return `\n## ${head}\n\n${escapeJournalHeadings(text.trim())}\n`
}

/** 追加一条 journal 到 `brain/journal/<YYYY-MM-DD>.md`（任何操作者都可以直接追加）。 */
export async function appendJournal(
  home: string,
  input: JournalInput,
  ctx: WriteContext,
): Promise<Result<JournalReceipt>> {
  if (input.text.trim() === '') return fail('usage', 'empty_text', 'journal 正文不能为空')
  const ws = input.workspace
  if (ws !== undefined) {
    if (!WS_REF_RE.test(ws)) {
      return fail('usage', 'invalid_workspace', `workspace 标识应形如 ws/<id>：${ws}`)
    }
    const loaded = await loadWorkspaces(home)
    if (!loaded.ok) return loaded
    if (!loaded.data.workspaces.some((w) => w.ref === ws)) {
      return fail('failure', 'unknown_workspace', `未定义的 workspace：${ws}`)
    }
  }
  const now = ctx.now ?? new Date()
  const date = localDate(now)
  const time = localTime(now)
  const path = `${BRAIN_JOURNAL_DIR}/${date}.md`
  const r = await commitWrite(
    home,
    {
      repo: 'brain',
      op: 'journal',
      summary: `${ws ? `${ws} ` : ''}${firstLine(input.text)}`,
      files: [
        {
          op: 'append',
          path,
          header: `# ${date}\n`,
          content: renderJournalRecord(time, ctx.actor, ws, input.text),
        },
      ],
    },
    { ...ctx, now },
  )
  if (!r.ok) return r
  return ok({ ...r.data, file: `brain/${path}`, date, time })
}

// ---------------------------------------------------------------------------
// 随手记

export interface CaptureInput {
  text: string
  /** 来源，例如 `cli`、`mcp:claude`。 */
  source: string
}

export interface CaptureReceipt extends WriteReceipt {
  /** 相对 raindown-home 的新文件，例如 `raw/inbox/2026-10-24T140305-a1b2c3.md`。 */
  file: string
}

const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,99}$/

/**
 * 随手记：在 `raw/inbox/` 新建一个只追加、不修改的文件，带时间、操作者与来源元数据。
 * 只在 raw 仓库产生一次提交，绝不触碰 brain。
 */
export async function appendCapture(
  home: string,
  input: CaptureInput,
  ctx: WriteContext,
): Promise<Result<CaptureReceipt>> {
  if (input.text.trim() === '') return fail('usage', 'empty_text', '随手记内容不能为空')
  if (!SOURCE_RE.test(input.source)) {
    return fail('usage', 'invalid_source', `来源标识不合法：${JSON.stringify(input.source)}`)
  }
  const now = ctx.now ?? new Date()
  const stamp = `${localDate(now)}T${localTime(now).replace(/:/g, '')}`
  const path = `inbox/${stamp}-${randomBytes(3).toString('hex')}.md`
  const meta = { captured_at: localIsoTime(now), actor: ctx.actor, source: input.source }
  const r = await commitWrite(
    home,
    {
      repo: 'raw',
      op: 'capture',
      summary: firstLine(input.text),
      files: [{ op: 'create', path, content: renderEntry(meta, `${input.text.trim()}\n`) }],
    },
    { ...ctx, now },
  )
  if (!r.ok) return r
  return ok({ ...r.data, file: `raw/${path}` })
}
