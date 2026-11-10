import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { raindownPaths } from '@raindown/core'
import { z } from 'zod'

/**
 * macOS Security 框架的 `DARWIN_USER_CACHE_DIR/mds/`（worker-credential-isolation 4.5，用户 2026-11-10 决定方案 1：放行 + 节点校验与重置）。
 *
 * Codex 校验登录时 Security 框架以写方式打开其中的 `mds.lock`、`mdsDirectory.db`、`mdsObject.db`，外层 seatbelt 因此放行整个
 * `mds/` 子树。这个目录与沙箱外所有使用 Security 框架的进程共用，为缩短 worker 篡改的暴露窗口：
 * - 节点每次启动 harness 前（`recordMdsBaseline`）把 `mds/` 下各条目的类型与普通文件的 sha256 记到 worker 读写都被拒绝的
 *   `state/tasks/<任务>/mds-baseline.json`（已有记录时保留：同一次执行中较早的记录覆盖更长的时间段）；
 * - harness 每次结束后（节点统一出口，`verifyMdsBaseline`）比较：内容变化、新增的条目、非普通文件（符号链接等）一律删除
 *   （`rm` 不跟随链接；`mds/` 目录本身保留），macOS 会自动重建；结果只含文件名，由调用方写任务事件与 Digest 收件箱条目。
 * 沙箱外的进程在此期间合法更新这些文件同样会触发重置（重建无害）。
 */

export const MDS_BASELINE_FILE = 'mds-baseline.json'
export const mdsBaselinePath = (home: string, taskId: string) =>
  join(raindownPaths(home).state, 'tasks', taskId, MDS_BASELINE_FILE)

const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/

const entrySchema = z.union([
  z.strictObject({ type: z.literal('file'), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ type: z.literal('other') }),
])
const baselineSchema = z.strictObject({
  version: z.literal(1),
  dir: z.string().min(1),
  recorded_at: z.string(),
  entries: z.record(z.string(), entrySchema),
})
type MdsEntry = z.infer<typeof entrySchema>
type MdsBaseline = z.infer<typeof baselineSchema>

/** 列出 `dir` 下的直接条目：普通文件记 sha256，其他（符号链接、目录、设备等）只记类型；不跟随链接。目录不存在时为空。 */
export async function snapshotMds(dir: string): Promise<Record<string, MdsEntry>> {
  const out: Record<string, MdsEntry> = {}
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out
    throw err
  }
  for (const name of names.sort()) {
    const p = join(dir, name)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    if (!info.isFile()) {
      out[name] = { type: 'other' }
      continue
    }
    try {
      out[name] = {
        type: 'file',
        sha256: createHash('sha256')
          .update(await readFile(p))
          .digest('hex'),
      }
    } catch (err) {
      // 读取期间被删除或替换：按非普通文件处理（之后比较时视为变化）。
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      out[name] = { type: 'other' }
    }
  }
  return out
}

async function readBaseline(path: string): Promise<MdsBaseline | undefined> {
  let text: string
  try {
    const info = await lstat(path)
    if (!info.isFile()) return undefined
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  const parsed = baselineSchema.safeParse(JSON.parse(text))
  return parsed.success ? parsed.data : undefined
}

/**
 * harness 启动前记录 `mds/` 的基线（见模块说明）。`mdsDir` 必须是绝对路径（节点由已校验的 `DARWIN_USER_CACHE_DIR` 得到，测试注入）。
 * 已有可解析的基线时保留不覆盖。写入 `state/tasks/<任务>/`（0700；文件 0600，同目录原子替换）。
 */
export async function recordMdsBaseline(
  home: string,
  taskId: string,
  mdsDir: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (!SAFE_SEGMENT.test(taskId)) throw new Error('任务 id 不合法')
  if (!isAbsolute(mdsDir)) throw new Error(`mds 目录不是绝对路径：${mdsDir}`)
  const path = mdsBaselinePath(home, taskId)
  const existing = await readBaseline(path).catch(() => undefined)
  if (existing && existing.dir === mdsDir) return
  const dir = dirname(path)
  for (const d of [raindownPaths(home).state, dirname(dir), dir]) {
    await mkdir(d, { recursive: true, mode: 0o700 })
    const info = await lstat(d)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${d} 不是普通目录`)
  }
  const baseline: MdsBaseline = {
    version: 1,
    dir: mdsDir,
    recorded_at: now().toISOString(),
    entries: await snapshotMds(mdsDir),
  }
  const pending = join(dir, `${MDS_BASELINE_FILE}.${randomUUID()}.tmp`)
  try {
    await writeFile(pending, `${JSON.stringify(baseline)}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(pending, 0o600)
    await rename(pending, path)
  } finally {
    await rm(pending, { force: true })
  }
}

export interface MdsVerification {
  dir: string
  /** 已删除的条目名（有变化、新增或不是普通文件）。 */
  reset: string[]
  /** 删除失败的条目名。 */
  failed: string[]
  /** `mds` 目录本身不是普通目录（例如被换成符号链接）：不处理其中内容，由调用方报告。 */
  dirReplaced?: boolean
}

/**
 * harness 结束后按基线校验并重置 `mds/`（见模块说明）；没有基线时返回 undefined。完成后删除基线文件。
 * 只删除有变化的条目本身：`rm` 不跟随符号链接，目录条目递归删除其内容但不跟随其中的链接；`mds/` 目录本身保留。
 */
export async function verifyMdsBaseline(
  home: string,
  taskId: string,
): Promise<MdsVerification | undefined> {
  if (!SAFE_SEGMENT.test(taskId)) return undefined
  const path = mdsBaselinePath(home, taskId)
  let baseline: MdsBaseline | undefined
  try {
    baseline = await readBaseline(path)
  } catch {
    baseline = undefined
  }
  if (!baseline) {
    await rm(path, { force: true }).catch(() => {})
    return undefined
  }
  const dir = baseline.dir
  const result: MdsVerification = { dir, reset: [], failed: [] }
  try {
    const info = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined
      throw err
    })
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      result.dirReplaced = true
      return result
    }
    const current = await snapshotMds(dir)
    for (const [name, entry] of Object.entries(current)) {
      const before = baseline.entries[name]
      const changed =
        entry.type !== 'file' ||
        before === undefined ||
        before.type !== 'file' ||
        before.sha256 !== entry.sha256
      if (!changed) continue
      try {
        await rm(join(dir, name), { recursive: true, force: true })
        result.reset.push(name)
      } catch {
        result.failed.push(name)
      }
    }
    return result
  } finally {
    await rm(path, { force: true }).catch(() => {})
  }
}

/** 给任务事件与日志用的一行说明（只含文件名）。 */
export function describeMdsVerification(v: MdsVerification): string | undefined {
  if (v.dirReplaced)
    return `macOS Security 缓存目录 ${v.dir} 不是普通目录（可能被替换成符号链接），未处理；请手动检查`
  if (v.reset.length === 0 && v.failed.length === 0) return undefined
  const parts: string[] = []
  if (v.reset.length > 0)
    parts.push(`已删除有变化或新增的条目（macOS 会自动重建）：${v.reset.join('、')}`)
  if (v.failed.length > 0) parts.push(`删除失败：${v.failed.join('、')}`)
  return `harness 结束后校验 ${v.dir}：${parts.join('；')}`
}
