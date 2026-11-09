import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  ISOLATION_PROFILE_FILE,
  raindownPaths,
  runTasksDir,
  taskIsolationProfile,
  taskRunDir,
} from '@raindown/core'

const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/
const TOKEN_FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.token$/
const TOKEN_DIR = 'dispatch-tokens'

/**
 * 派工凭证存放在任务私有目录 `run/tasks/<任务>/dispatch-tokens/`，按租约隔离；适配器只向受管 MCP 传文件路径。
 * 位于 `state/` 之外，隔离时只需放行这一个文件（add-worker-credential-isolation D2）。
 */
export const leaseTokenDir = (home: string, taskId: string) =>
  join(taskRunDir(home, taskId), TOKEN_DIR)

/** 旧版本的任务私有目录根（`state/tasks/`），只用于启动时清理残留的派工凭证。 */
const legacyTasksDir = (home: string) => join(raindownPaths(home).state, 'tasks')

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('派工凭证目录不是普通目录')
  await chmod(path, 0o700)
}

/** 逐级创建任务私有目录 `run/tasks/<任务>/`（各级 0700，拒绝符号链接与非目录），返回其路径。 */
export async function ensureTaskRunDir(home: string, taskId: string): Promise<string> {
  if (!SAFE_SEGMENT.test(taskId)) throw new Error('任务 id 不合法')
  await privateDirectory(raindownPaths(home).run)
  const tasks = runTasksDir(home)
  await privateDirectory(tasks)
  const dir = join(tasks, taskId)
  await privateDirectory(dir)
  return dir
}

export async function writeLeaseTokenFile(
  home: string,
  taskId: string,
  leaseId: string,
  token: string,
): Promise<string> {
  if (!SAFE_SEGMENT.test(taskId) || !SAFE_SEGMENT.test(leaseId)) {
    throw new Error('派工凭证的任务或租约 id 不合法')
  }
  const dir = join(await ensureTaskRunDir(home, taskId), TOKEN_DIR)
  await privateDirectory(dir)
  const path = join(dir, `${leaseId}.token`)
  // 同目录原子替换：MCP 每次读取同一路径时只会看到完整的旧 token 或新 token。
  const pending = join(dir, `${leaseId}.${randomUUID()}.token`)
  try {
    await writeFile(pending, `${token}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(pending, 0o600)
    await rename(pending, path)
  } finally {
    await rm(pending, { force: true })
  }
  return path
}

export async function removeLeaseTokenFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

/**
 * 删除变空的任务私有目录：依次尝试删除 `subdirs`（相对 `run/tasks/<任务>/`，由深到浅）与任务目录本身。
 * 只用 rmdir：非空目录、符号链接与不存在的路径都保持原样，不抛出。
 */
export async function removeEmptyTaskRunDir(
  home: string,
  taskId: string,
  subdirs: readonly string[] = [TOKEN_DIR],
): Promise<void> {
  if (!SAFE_SEGMENT.test(taskId)) return
  const root = taskRunDir(home, taskId)
  for (const dir of [...subdirs.map((d) => join(root, d)), root]) {
    try {
      await rmdir(dir)
    } catch {
      // 非空、不存在或不是目录：留给之后的清理。
    }
  }
}

/**
 * 节点已持有单实例锁。只清理受管目录中的凭证文件，不递归删除任务产物或跟随符号链接。
 * 同时清理新位置（`run/tasks/`）与旧位置（`state/tasks/`）：节点重启后所有租约凭证都已失效，旧位置的凭证不必迁移。
 */
export async function cleanLeaseTokenFiles(home: string): Promise<void> {
  for (const task of await cleanTokenRoot(runTasksDir(home))) {
    await removeEmptyTaskRunDir(home, task, [TOKEN_DIR])
  }
  await cleanTokenRoot(legacyTasksDir(home))
  // 上次运行残留的外层 seatbelt 配置（4.1）：只在启动 harness 时读取，可以随时删除。
  await cleanSeatbeltProfiles(home)
}

/** 清理一个任务根目录下的凭证文件，返回检查过的任务 id。 */
async function cleanTokenRoot(tasks: string): Promise<string[]> {
  const seen: string[] = []
  const info = await lstat(tasks).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined
    throw err
  })
  if (!info?.isDirectory() || info.isSymbolicLink()) return seen
  for (const task of await readdir(tasks, { withFileTypes: true })) {
    if (!task.isDirectory() || !SAFE_SEGMENT.test(task.name)) continue
    seen.push(task.name)
    const dir = join(tasks, task.name, TOKEN_DIR)
    const tokens = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined
      throw err
    })
    if (!tokens?.isDirectory() || tokens.isSymbolicLink()) continue
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (TOKEN_FILE.test(file.name) && (file.isFile() || file.isSymbolicLink())) {
        await rm(join(dir, file.name), { force: true })
      }
    }
  }
  return seen
}

/**
 * 删除本任务的外层 seatbelt 配置（`state/tasks/<任务>/isolation.sb`，tasks 4.1）。`sandbox-exec` 只在启动时读取配置，
 * 任务结束或节点启动清理时即可删除；只删除普通文件或符号链接本身（`rm` 不跟随链接），随后尝试删除变空的任务状态目录。
 */
export async function removeSeatbeltProfile(home: string, taskId: string): Promise<void> {
  if (!SAFE_SEGMENT.test(taskId)) return
  const path = taskIsolationProfile(home, taskId)
  const info = await lstat(path).catch(() => undefined)
  if (info && (info.isFile() || info.isSymbolicLink())) await rm(path, { force: true })
  await rmdir(dirname(path)).catch(() => {})
}

/**
 * 写入本任务的外层 seatbelt 配置（0600，同目录原子替换，不跟随已有的同名链接），返回路径。
 * 位置在 worker 读写都被拒绝的 `state/tasks/<任务>/`（审查第一轮 H2）；目录不存在时按 0700 创建，拒绝符号链接与非目录。
 */
export async function writeSeatbeltProfile(
  home: string,
  taskId: string,
  content: string,
): Promise<string> {
  if (!SAFE_SEGMENT.test(taskId)) throw new Error('任务 id 不合法')
  const path = taskIsolationProfile(home, taskId)
  const dir = dirname(path)
  for (const d of [raindownPaths(home).state, dirname(dir), dir]) {
    await mkdir(d, { recursive: true, mode: 0o700 })
    const info = await lstat(d)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${d} 不是普通目录`)
  }
  const pending = join(dir, `${ISOLATION_PROFILE_FILE}.${randomUUID()}.tmp`)
  try {
    await writeFile(pending, content, { flag: 'wx', mode: 0o600 })
    await chmod(pending, 0o600)
    await rename(pending, path)
  } finally {
    await rm(pending, { force: true })
  }
  return path
}

/**
 * 节点往任务私有目录（worker 可写）写文件的方式（审查第二轮 L3，design D2 的不变量）：先以 `wx`（`O_CREAT|O_EXCL`，
 * 不跟随已有的符号链接）在同一目录写临时文件，再 rename 到目标——rename 替换的是目录项本身，worker 预埋在目标路径的
 * 符号链接不会被跟随写入。
 */
export async function writeFileNoFollow(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const pending = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(pending, data, { flag: 'wx', mode })
    await rename(pending, path)
  } finally {
    await rm(pending, { force: true })
  }
}

/** 节点启动时删除上次运行残留的外层 seatbelt 配置（`state/tasks/<任务>/isolation.sb`）。 */
async function cleanSeatbeltProfiles(home: string): Promise<void> {
  const root = legacyTasksDir(home)
  const info = await lstat(root).catch(() => undefined)
  if (!info?.isDirectory() || info.isSymbolicLink()) return
  for (const task of await readdir(root, { withFileTypes: true })) {
    if (task.isDirectory() && SAFE_SEGMENT.test(task.name))
      await removeSeatbeltProfile(home, task.name)
  }
}
