import { createHash, randomUUID } from 'node:crypto'
import { constants, readdirSync, readFileSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { mdsResetSignal, type Result, raindownPaths } from '@raindown/core'
import { z } from 'zod'

/**
 * macOS Security 框架的 `DARWIN_USER_CACHE_DIR/mds/`（worker-credential-isolation 4.5，用户 2026-11-10 决定方案 1：放行 + 节点校验与重置）。
 *
 * Codex 校验登录时 Security 框架以写方式打开其中的 `mds.lock`、`mdsDirectory.db`、`mdsObject.db`，外层 seatbelt 因此放行
 * `mds/` 子树（其中只能新建普通文件，见 core 的 `regular_files_only`）。这个目录与沙箱外所有使用 Security 框架的进程共用，
 * 为缩短 worker 篡改的暴露窗口：
 * - 节点每次启动（或 codex-orca 重新挂接）施加外层 seatbelt 的 harness 前（`recordMdsBaseline`）先把当前的 `mds/` 与
 *   **全部**已有基线（任何任务）比较，不一致就先重置并为该基线所属任务记一条通知；然后才记录本任务的基线
 *   （`state/tasks/<任务>/mds-baseline.json`，worker 读写都被拒绝；已有时保留较早的那份）。
 * - harness 结束后（节点统一出口，`verifyMdsBaseline`）按基线比较并重置，然后删除基线。codex-orca 的终端在阻塞期间继续运行，
 *   它的基线标记为 `hold`：执行结束时不校验也不删除。任务完成或取消时执行器做最后一次校验并删除；回滚时解除 hold，交给执行结束出口。
 * - 节点启动时（`sweepStaleMdsBaselines`）校验全部残留基线；没有 `hold` 的随后删除。
 * - 比较规则：内容变化、新增的条目、非普通文件、超过 `MDS_MAX_HASH_BYTES` 的文件一律视为变化（不读取其内容）。
 *   重置只删除这些条目本身（不跟随符号链接；目录条目递归删除也不跟随其中的链接；`mds/` 目录本身保留），macOS 会自动重建。
 * - 通知只含文件名：先写进 `state/mds-notices/`（worker 不可写），再由节点经 `POST /v1/nodes/:id/isolation-notices` 送达中枢
 *   （不依赖租约；失败的保留到下一次送达），中枢写任务事件与 Digest 收件箱条目。
 * - 基线只保存已知良好的哈希，重置后**不**刷新（审查第三轮：内容无法区分 macOS 重建与 worker 重写）：重新出现的文件哈希与基线相同
 *   或文件不存在都算正常（macOS 会重建），内容不同就再次重置。新记录的基线对当前不存在的条目沿用其他基线中的已知良好哈希。
 * - 通知去重（审查第三轮）：同一基线存续期间，每个（任务，文件名）只发一条通知；重复重置只计数，基线结束时以一条只写任务事件的通知
 *   带上计数；同一文件重置超过 `MDS_REPEAT_ESCALATE` 次时另发一条“反复重置”的 Digest 通知（每个基线一次），并继续重置。
 * 沙箱外的进程在此期间合法更新这些文件同样会触发重置（重建无害）。
 */

export const MDS_BASELINE_FILE = 'mds-baseline.json'
export const mdsBaselinePath = (home: string, taskId: string) =>
  join(raindownPaths(home).state, 'tasks', taskId, MDS_BASELINE_FILE)
/** 待送达的 mds 重置通知目录。 */
export const mdsNoticesDir = (home: string) => join(raindownPaths(home).state, 'mds-notices')
/** 超过这个大小的文件不计算哈希，直接视为变化（审查第一轮：避免稀疏的超大文件拖垮节点）。 */
export const MDS_MAX_HASH_BYTES = 8 * 1024 * 1024
/** 同一基线下同一文件被重置超过这个次数时，另发一条“反复重置”的 Digest 通知（审查第三轮）。 */
export const MDS_REPEAT_ESCALATE = 5

const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/
const NOTICE_FILE = /^[0-9a-f-]{36}\.json$/

const entrySchema = z.union([
  z.strictObject({ type: z.literal('file'), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ type: z.literal('other') }),
])
const baselineSchema = z.strictObject({
  version: z.literal(1),
  dir: z.string().min(1),
  recorded_at: z.string(),
  hold: z.boolean().optional(),
  entries: z.record(z.string(), entrySchema),
  /** 本基线存续期间各条目被重置的次数（审查第三轮：通知去重与反复重置的升级）。 */
  resets: z.record(z.string(), z.number().int().min(1)).optional(),
  /** 已发过“反复重置”通知。 */
  escalated: z.boolean().optional(),
})
type MdsEntry = z.infer<typeof entrySchema>
type MdsBaseline = z.infer<typeof baselineSchema>
const counterSchema = z.strictObject({
  resets: z.record(z.string(), z.number().int().min(1)).optional(),
  escalated: z.boolean().optional(),
})
type ResetCounter = z.infer<typeof counterSchema>
/**
 * 节点级的已知良好快照（审查第四轮）：`state/mds-known-good.json`（worker 读写都被拒绝）。由第一次记录的基线建立；
 * 每次记录新基线、节点启动时先把当前的 mds 与它比较并重置差异；新基线直接复制它的哈希（不取当前内容）。
 * 只在没有任何基线（运行中或 hold）时、且一次校验没有任何差异时更新。`last_task`：最近结束的基线所属任务——
 * 之后才发现的差异（例如逃出进程组的子进程在基线结束后写入）记在它名下。`counters`：按任务的通知去重计数。
 */
const knownGoodSchema = z.strictObject({
  version: z.literal(1),
  dir: z.string().min(1),
  updated_at: z.string(),
  entries: z.record(z.string(), entrySchema),
  last_task: z.string().optional(),
  counters: z.record(z.string(), counterSchema).optional(),
})
type KnownGood = z.infer<typeof knownGoodSchema>
export const mdsKnownGoodPath = (home: string) =>
  join(raindownPaths(home).state, 'mds-known-good.json')

async function readKnownGood(home: string, dir: string): Promise<KnownGood | undefined> {
  try {
    const path = mdsKnownGoodPath(home)
    if (!(await lstat(path)).isFile()) return undefined
    const parsed = knownGoodSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success && parsed.data.dir === dir ? parsed.data : undefined
  } catch {
    return undefined
  }
}
const noticeSchema = z.strictObject({ task_id: z.string().min(1), signal: mdsResetSignal })
export type MdsNotice = z.infer<typeof noticeSchema>

const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * 普通文件的 sha256：以 `O_NOFOLLOW | O_NONBLOCK` 打开（不跟随链接，FIFO 不阻塞），打开后再按描述符确认是普通文件且不超过
 * `MDS_MAX_HASH_BYTES`，分块读取；读到的字节超过上限（文件在读取期间变大）同样视为变化。不是普通文件或过大时返回 `other`。
 */
async function hashEntry(path: string): Promise<MdsEntry | undefined> {
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    if (missing(err)) return undefined
    return { type: 'other' }
  }
  try {
    const info = await fh.stat()
    if (!info.isFile() || info.size > MDS_MAX_HASH_BYTES) return { type: 'other' }
    const hash = createHash('sha256')
    const buf = Buffer.alloc(64 * 1024)
    let total = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > MDS_MAX_HASH_BYTES) return { type: 'other' }
      hash.update(buf.subarray(0, bytesRead))
    }
    return { type: 'file', sha256: hash.digest('hex') }
  } catch {
    return { type: 'other' }
  } finally {
    await fh.close().catch(() => {})
  }
}

/** 列出 `dir` 下的直接条目（见 `hashEntry`）；不跟随链接。目录不存在时为空。 */
export async function snapshotMds(dir: string): Promise<Record<string, MdsEntry>> {
  const out: Record<string, MdsEntry> = {}
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if (missing(err)) return out
    throw err
  }
  for (const name of names.sort()) {
    const p = join(dir, name)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(p)
    } catch (err) {
      if (missing(err)) continue
      throw err
    }
    if (!info.isFile()) {
      out[name] = { type: 'other' }
      continue
    }
    const entry = await hashEntry(p)
    if (entry) out[name] = entry
  }
  return out
}

/**
 * 与基线比较，返回有变化的条目名：内容与基线的已知良好哈希不同、基线中没有（新增）、非普通文件或过大。
 * 基线中有、现在不存在的条目不算变化（macOS 会重建）。
 */
function compareEntries(
  current: Record<string, MdsEntry>,
  baseline: Record<string, MdsEntry>,
): string[] {
  const changed: string[] = []
  for (const [name, entry] of Object.entries(current)) {
    const before = baseline[name]
    if (
      entry.type !== 'file' ||
      before === undefined ||
      before.type !== 'file' ||
      before.sha256 !== entry.sha256
    )
      changed.push(name)
  }
  return changed
}

/**
 * 删除条目本身：外层 seatbelt 只允许在 `mds/` 中新建普通文件，非普通条目只可能来自沙箱外；仍按类型处理且从不跟随链接——
 * 真实目录递归删除（`rm` 不跟随其中的链接），其他（普通文件、符号链接、FIFO 等）`unlink`。
 */
async function resetEntries(
  dir: string,
  names: readonly string[],
): Promise<{ reset: string[]; failed: string[] }> {
  const reset: string[] = []
  const failed: string[] = []
  for (const name of names) {
    const p = join(dir, name)
    try {
      const info = await lstat(p)
      if (info.isDirectory()) await rm(p, { recursive: true, force: true })
      else await unlink(p)
      reset.push(name)
    } catch (err) {
      if (missing(err)) reset.push(name)
      else failed.push(name)
    }
  }
  return { reset, failed }
}

async function readBaseline(path: string): Promise<MdsBaseline | undefined> {
  let text: string
  try {
    const info = await lstat(path)
    if (!info.isFile()) return undefined
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (missing(err)) return undefined
    throw err
  }
  try {
    const parsed = baselineSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** 逐级创建 `state/` 下的目录（0700，拒绝符号链接与非目录）。 */
async function stateDirs(home: string, dir: string): Promise<void> {
  const state = raindownPaths(home).state
  const chain: string[] = []
  for (let d = dir; d.startsWith(state); d = dirname(d)) {
    chain.unshift(d)
    if (d === state) break
  }
  for (const d of chain) {
    await mkdir(d, { recursive: true, mode: 0o700 })
    const info = await lstat(d)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${d} 不是普通目录`)
  }
}

/** 同目录原子替换写入（0600，不跟随已有的同名链接）。 */
async function writeState(home: string, path: string, data: unknown): Promise<void> {
  const dir = dirname(path)
  await stateDirs(home, dir)
  const pending = join(dir, `.${randomUUID()}.tmp`)
  try {
    await writeFile(pending, `${JSON.stringify(data)}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(pending, 0o600)
    await rename(pending, path)
  } finally {
    await rm(pending, { force: true })
  }
}

/**
 * 记一条待送达的重置通知（只含文件名）。`repeats`：各文件在同一基线下被重置的次数；`inbox`：`none` 只写任务事件，
 * `repeated` 写“反复重置”的收件箱条目，缺省写普通的重置条目。
 */
export async function queueMdsNotice(
  home: string,
  taskId: string,
  files: readonly string[],
  extra: { repeats?: Record<string, number>; inbox?: 'none' | 'repeated' } = {},
): Promise<void> {
  if (files.length === 0) return
  const id = randomUUID()
  const kept = files.slice(0, 100).map((f) => f.slice(0, 255))
  const repeats = extra.repeats
    ? Object.fromEntries(
        Object.entries(extra.repeats)
          .filter(([n]) => kept.includes(n.slice(0, 255)))
          .map(([n, c]) => [n.slice(0, 255), c]),
      )
    : undefined
  const notice: MdsNotice = {
    task_id: taskId,
    signal: {
      id: `mds-reset:${id}`,
      kind: 'mds_reset',
      files: kept,
      ...(repeats && Object.keys(repeats).length > 0 ? { repeats } : {}),
      ...(extra.inbox ? { inbox: extra.inbox } : {}),
    },
  }
  await writeState(home, join(mdsNoticesDir(home), `${id}.json`), notice)
}

/**
 * 记下一次重置（审查第三轮）：累计本基线各文件的重置次数；第一次重置的文件发一条通知，之后只计数；
 * 有文件超过 `MDS_REPEAT_ESCALATE` 次且本基线还没升级过时，另发一条“反复重置”通知。返回更新后的基线。
 */
async function countResets<T extends ResetCounter>(
  home: string,
  taskId: string,
  baseline: T,
  names: readonly string[],
): Promise<T> {
  if (names.length === 0) return baseline
  const resets = { ...(baseline.resets ?? {}) }
  const first: string[] = []
  for (const name of names) {
    resets[name] = (resets[name] ?? 0) + 1
    if (resets[name] === 1) first.push(name)
  }
  await queueMdsNotice(home, taskId, first)
  let escalated = baseline.escalated
  const repeated = Object.entries(resets).filter(([, c]) => c > MDS_REPEAT_ESCALATE)
  if (!escalated && repeated.length > 0) {
    await queueMdsNotice(
      home,
      taskId,
      repeated.map(([n]) => n),
      { repeats: Object.fromEntries(repeated), inbox: 'repeated' },
    )
    escalated = true
  }
  return { ...baseline, resets, ...(escalated ? { escalated: true } : {}) }
}

/** 基线结束（删除）时：把重复重置的计数以一条只写任务事件的通知记下（审查第三轮）。 */
async function summarizeRepeats(home: string, taskId: string, baseline: MdsBaseline) {
  const repeated = Object.entries(baseline.resets ?? {}).filter(([, c]) => c > 1)
  if (repeated.length === 0) return
  await queueMdsNotice(
    home,
    taskId,
    repeated.map(([n]) => n),
    { repeats: Object.fromEntries(repeated), inbox: 'none' },
  )
}

/** 是否有待送达的通知（同步检查：没有时调用方不必 await，不改变执行结束时的时序）。 */
export function hasPendingMdsNotices(home: string): boolean {
  try {
    return readdirSync(mdsNoticesDir(home)).some((n) => NOTICE_FILE.test(n))
  } catch {
    return false
  }
}

/**
 * 送达待送达的通知：`send` 成功或返回不可重试的错误时删除通知文件（错误记日志），可重试的错误保留到下一次。
 */
export async function deliverMdsNotices(
  home: string,
  send: (notice: MdsNotice) => Promise<Result<unknown>>,
  log: (message: string) => void,
): Promise<void> {
  const dir = mdsNoticesDir(home)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => NOTICE_FILE.test(n)).sort()
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    let notice: MdsNotice | undefined
    try {
      const parsed = noticeSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
      notice = parsed.success ? parsed.data : undefined
    } catch {
      notice = undefined
    }
    if (!notice) {
      log(`删除无法解析的 mds 重置通知 ${path}`)
      await rm(path, { force: true }).catch(() => {})
      continue
    }
    const r = await send(notice).catch(
      (err: Error) => ({ ok: false, error: { kind: 'retryable', message: err.message } }) as const,
    )
    if (r.ok) {
      await rm(path, { force: true }).catch(() => {})
      continue
    }
    const error = r.error as { kind?: string; code?: string; message?: string }
    if (error.kind === 'retryable') return
    log(
      `任务 ${notice.task_id} 的 mds 重置通知被中枢拒绝（${error.code ?? error.kind}），只记在节点日志：${notice.signal.files.map((f) => JSON.stringify(f)).join('、')}`,
    )
    await rm(path, { force: true }).catch(() => {})
  }
}

/** 列出全部任务的基线（`state/tasks/*\/mds-baseline.json`）。 */
async function allBaselines(
  home: string,
): Promise<Array<{ taskId: string; baseline: MdsBaseline }>> {
  const root = join(raindownPaths(home).state, 'tasks')
  let tasks: string[]
  try {
    tasks = await readdir(root)
  } catch {
    return []
  }
  const out: Array<{ taskId: string; baseline: MdsBaseline }> = []
  for (const taskId of tasks.sort()) {
    if (!SAFE_SEGMENT.test(taskId)) continue
    const baseline = await readBaseline(mdsBaselinePath(home, taskId)).catch(() => undefined)
    if (baseline) out.push({ taskId, baseline })
  }
  return out
}

/** mds 目录本身是否仍是真实目录（不存在也算：没有内容可比较）。 */
async function dirIntact(dir: string): Promise<boolean> {
  try {
    const info = await lstat(dir)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch (err) {
    if (missing(err)) return true
    throw err
  }
}

/**
 * 启动新 harness 前（审查第一轮）：把当前的 `mds/` 与全部已有基线（任何任务，含本任务）比较，有变化的条目先重置，
 * 并按基线记下重置（通知去重，见 `countResets`）。基线的已知良好哈希不变（审查第三轮）。返回被重置的条目名。
 */
async function crossCheck(home: string, mdsDir: string, launchingTask?: string): Promise<string[]> {
  const baselines = (await allBaselines(home)).filter((b) => b.baseline.dir === mdsDir)
  const kg = await readKnownGood(home, mdsDir)
  if ((baselines.length === 0 && !kg) || !(await dirIntact(mdsDir))) return []
  const current = await snapshotMds(mdsDir)
  const perTask = baselines.map((b) => ({
    ...b,
    changed: compareEntries(current, b.baseline.entries),
  }))
  // 已知良好快照（审查第四轮）：没有基线覆盖的时间段里（例如逃出进程组的子进程在基线结束后写入）发生的改动也能发现。
  const kgChanged = kg ? compareEntries(current, kg.entries) : []
  const union = [...new Set([...perTask.flatMap((p) => p.changed), ...kgChanged])].sort()
  if (union.length === 0) return []
  const { reset, failed } = await resetEntries(mdsDir, union)
  const done = (n: string) => reset.includes(n) || failed.includes(n)
  for (const p of perTask) {
    const files = p.changed.filter(done)
    if (files.length === 0) continue
    const next = await countResets(home, p.taskId, p.baseline, files)
    await writeState(home, mdsBaselinePath(home, p.taskId), next)
  }
  // 只有已知良好快照发现的差异：记在最近结束的基线所属任务名下（没有时记在正要启动的任务名下）。
  const attributed = new Set(perTask.flatMap((p) => p.changed))
  const kgOnly = kgChanged.filter((n) => !attributed.has(n) && done(n))
  const owner = kg?.last_task ?? launchingTask
  if (kg && kgOnly.length > 0 && owner) await countKnownGood(home, kg, owner, kgOnly)
  return reset
}

/** 已知良好快照发现的重置：按任务去重计数（与基线相同的规则）。 */
async function countKnownGood(
  home: string,
  kg: KnownGood,
  taskId: string,
  names: readonly string[],
): Promise<void> {
  const fresh = (await readKnownGood(home, kg.dir)) ?? kg
  const counters = { ...(fresh.counters ?? {}) }
  counters[taskId] = await countResets(home, taskId, counters[taskId] ?? {}, names)
  await writeState(home, mdsKnownGoodPath(home), { ...fresh, counters })
}

/**
 * harness 启动前记录 `mds/` 的基线（见模块说明）：先与全部已有基线比较并重置，再记录本任务的基线（已有时保留，`hold` 只会被打开）。
 * 当前不存在的条目沿用其他基线中的已知良好哈希（刚被重置、等待 macOS 重建的文件以原内容出现时不算变化）。
 * `mdsDir` 必须是绝对路径（节点由已校验的 `DARWIN_USER_CACHE_DIR` 得到，测试注入）。
 */
export async function recordMdsBaseline(
  home: string,
  taskId: string,
  mdsDir: string,
  o: { hold?: boolean; now?: () => Date } = {},
): Promise<void> {
  if (!SAFE_SEGMENT.test(taskId)) throw new Error('任务 id 不合法')
  if (!isAbsolute(mdsDir)) throw new Error(`mds 目录不是绝对路径：${mdsDir}`)
  await crossCheck(home, mdsDir, taskId)
  const path = mdsBaselinePath(home, taskId)
  const existing = await readBaseline(path).catch(() => undefined)
  if (existing && existing.dir === mdsDir) {
    if (o.hold && !existing.hold) await writeState(home, path, { ...existing, hold: true })
    return
  }
  const now = (o.now ?? (() => new Date()))().toISOString()
  const kg = await readKnownGood(home, mdsDir)
  let entries: Record<string, MdsEntry>
  if (kg) {
    // 新基线复制已知良好的哈希，不取当前内容（审查第四轮：比较之后、记录之前被写入的内容不会被当作已知良好）。
    entries = { ...kg.entries }
  } else {
    entries = await snapshotMds(mdsDir)
    for (const { baseline } of await allBaselines(home)) {
      if (baseline.dir !== mdsDir) continue
      for (const [name, entry] of Object.entries(baseline.entries))
        if (entry.type === 'file' && entries[name] === undefined) entries[name] = entry
    }
    // 第一次记录基线：同时建立已知良好快照。
    const seed: KnownGood = { version: 1, dir: mdsDir, updated_at: now, entries }
    await writeState(home, mdsKnownGoodPath(home), seed)
  }
  const baseline: MdsBaseline = {
    version: 1,
    dir: mdsDir,
    recorded_at: now,
    ...(o.hold ? { hold: true } : {}),
    entries,
  }
  await writeState(home, path, baseline)
}

/** 设置或解除基线的 `hold`（codex-orca 的终端仍在运行时保留基线）；没有基线时什么也不做。 */
export async function setMdsBaselineHold(
  home: string,
  taskId: string,
  hold: boolean,
): Promise<void> {
  if (!SAFE_SEGMENT.test(taskId)) return
  const path = mdsBaselinePath(home, taskId)
  const existing = await readBaseline(path).catch(() => undefined)
  if (!existing || (existing.hold ?? false) === hold) return
  const { hold: _drop, ...rest } = existing
  await writeState(home, path, hold ? { ...rest, hold: true } : rest)
}

/** 被 `hold` 的基线所属任务（codex-orca 启动时检查其终端是否仍在运行）。 */
export async function heldMdsBaselines(home: string): Promise<string[]> {
  return (await allBaselines(home)).filter((b) => b.baseline.hold === true).map((b) => b.taskId)
}

/** 本任务的基线是否被 `hold`（同步，供执行结束出口判断是否需要 await）。 */
export function mdsBaselineHeld(home: string, taskId: string): boolean {
  try {
    const text = readFileSync(mdsBaselinePath(home, taskId), 'utf8')
    return (JSON.parse(text) as { hold?: unknown }).hold === true
  } catch {
    return false
  }
}

export interface MdsVerification {
  dir: string
  /** 已删除的条目名（有变化、新增、非普通文件或过大）。 */
  reset: string[]
  /** 删除失败的条目名。 */
  failed: string[]
  /** `mds` 目录本身不是普通目录（例如被换成符号链接）：不处理其中内容，由调用方报告。 */
  dirReplaced?: boolean
  /** 基线被 `hold` 且没有强制校验：未比较，基线保留。 */
  held?: boolean
}

/**
 * 按基线校验并重置 `mds/`（见模块说明）；没有基线时返回 undefined。有变化时记一条待送达的通知。
 * 基线被 `hold` 且 `force` 不为 true 时不比较、保留基线；否则校验后删除基线（`keep` 时保留，节点启动时处理仍被 hold 的基线）。
 */
export async function verifyMdsBaseline(
  home: string,
  taskId: string,
  o: { force?: boolean; keep?: boolean } = {},
): Promise<MdsVerification | undefined> {
  if (!SAFE_SEGMENT.test(taskId)) return undefined
  const path = mdsBaselinePath(home, taskId)
  const baseline = await readBaseline(path).catch(() => undefined)
  if (!baseline) {
    await rm(path, { force: true }).catch(() => {})
    return undefined
  }
  const dir = baseline.dir
  if (baseline.hold && !o.force) return { dir, reset: [], failed: [], held: true }
  const result: MdsVerification = { dir, reset: [], failed: [] }
  let current = baseline
  try {
    if (!(await dirIntact(dir))) {
      result.dirReplaced = true
      current = await countResets(home, taskId, baseline, ['mds'])
      return result
    }
    const changed = compareEntries(await snapshotMds(dir), baseline.entries)
    const { reset, failed } = await resetEntries(dir, changed)
    result.reset = reset
    result.failed = failed
    current = await countResets(home, taskId, baseline, [...reset, ...failed])
    if (o.keep) await writeState(home, path, current)
    return result
  } finally {
    if (!o.keep) {
      await summarizeRepeats(home, taskId, current).catch(() => {})
      await rm(path, { force: true }).catch(() => {})
      const clean = !result.dirReplaced && result.reset.length === 0 && result.failed.length === 0
      await afterBaselineEnded(home, dir, taskId, clean).catch(() => {})
    }
  }
}

/**
 * 基线结束后（审查第四轮）：已知良好快照记下最近结束的任务；这次校验没有差异、且本 home 上已没有任何基线（运行中或 hold）时，
 * 再与已知良好快照比较一次，仍没有差异才更新它（加入新出现、内容一致的条目；缺失的保留原哈希）。
 */
async function afterBaselineEnded(
  home: string,
  dir: string,
  taskId: string,
  clean: boolean,
): Promise<void> {
  const kg = await readKnownGood(home, dir)
  if (!kg) return
  let next: KnownGood = { ...kg, last_task: taskId }
  if (
    clean &&
    (await allBaselines(home)).every((b) => b.baseline.dir !== dir) &&
    (await dirIntact(dir))
  ) {
    const live = await snapshotMds(dir)
    if (compareEntries(live, kg.entries).length === 0)
      next = { ...next, entries: { ...kg.entries, ...live }, updated_at: new Date().toISOString() }
  }
  await writeState(home, mdsKnownGoodPath(home), next)
}

/**
 * 节点启动时（审查第一轮）：校验全部残留基线并重置（此时本节点上没有正在运行的执行）。没有 `hold` 的基线随后删除；
 * 被 `hold` 的（codex-orca 的终端可能仍在运行）校验后保留，终端结束时再处理。返回处理过的任务 id。
 */
export async function sweepStaleMdsBaselines(home: string): Promise<string[]> {
  const done: string[] = []
  // 先按已知良好快照比较并重置（审查第四轮）：节点停止期间或基线结束之后的改动。
  const kgPath = mdsKnownGoodPath(home)
  try {
    const raw = knownGoodSchema.safeParse(JSON.parse(await readFile(kgPath, 'utf8')))
    if (raw.success) await crossCheck(home, raw.data.dir)
  } catch {
    // 没有已知良好快照：只校验基线。
  }
  for (const { taskId, baseline } of await allBaselines(home)) {
    await verifyMdsBaseline(home, taskId, { force: true, keep: baseline.hold === true })
    done.push(taskId)
  }
  return done
}

/** 给任务活动与日志用的一行说明（只含文件名，逐个 JSON 引号转义）。 */
export function describeMdsVerification(v: MdsVerification): string | undefined {
  if (v.dirReplaced)
    return `macOS Security 缓存目录 ${v.dir} 不是普通目录（可能被替换成符号链接），未处理；请手动检查`
  if (v.reset.length === 0 && v.failed.length === 0) return undefined
  const q = (names: readonly string[]) => names.map((n) => JSON.stringify(n)).join('、')
  const parts: string[] = []
  if (v.reset.length > 0) parts.push(`已删除有变化或新增的条目（macOS 会自动重建）：${q(v.reset)}`)
  if (v.failed.length > 0) parts.push(`删除失败：${q(v.failed)}`)
  return `harness 结束后校验 ${v.dir}：${parts.join('；')}`
}
