import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { raindownPaths, runTasksDir, taskRunDir } from '@raindown/core'

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

export async function writeLeaseTokenFile(
  home: string,
  taskId: string,
  leaseId: string,
  token: string,
): Promise<string> {
  if (!SAFE_SEGMENT.test(taskId) || !SAFE_SEGMENT.test(leaseId)) {
    throw new Error('派工凭证的任务或租约 id 不合法')
  }
  await privateDirectory(raindownPaths(home).run)
  const tasks = runTasksDir(home)
  await privateDirectory(tasks)
  await privateDirectory(join(tasks, taskId))
  const dir = join(tasks, taskId, TOKEN_DIR)
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
  for (const task of await cleanTokenRoot(runTasksDir(home)))
    await removeEmptyTaskRunDir(home, task, [TOKEN_DIR])
  await cleanTokenRoot(legacyTasksDir(home))
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
