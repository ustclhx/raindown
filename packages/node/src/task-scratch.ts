import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { taskCacheDir, taskRunDir, taskScratchEnv, taskTmpDir } from '@raindown/core'
import { ensureTaskRunDir } from './lease-token.ts'

/**
 * 按任务私有的临时与缓存目录（add-worker-credential-isolation 审查第一轮 M2）。
 *
 * 施加外层 seatbelt 时，共享的临时与缓存目录（`/private/tmp`、`TMPDIR`、`~/.cache`、`~/Library/Caches`、
 * `~/.bun/install/cache`、`~/.npm/_cacache`、pnpm store……）不在写白名单内：其中的内容会被之后沙箱外的安装、运行直接使用。
 * worker 改用 `run/tasks/<任务>/tmp|cache/`（经 `taskScratchEnv` 注入的环境变量），每次执行结束删除。
 */

async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} 不是普通目录`)
  await chmod(path, 0o700)
}

/** 建好本任务的临时与缓存目录（0700），返回要注入 worker 的环境变量。 */
export async function prepareTaskScratch(
  home: string,
  taskId: string,
): Promise<Record<string, string>> {
  await ensureTaskRunDir(home, taskId)
  const env = taskScratchEnv(home, taskId)
  await privateDir(taskTmpDir(home, taskId))
  await privateDir(taskCacheDir(home, taskId))
  for (const [key, value] of Object.entries(env)) {
    if (key === 'TMPDIR' || key === 'BUN_RUNTIME_TRANSPILER_CACHE_PATH') continue
    await privateDir(value)
  }
  return env
}

/** 删除本任务的临时与缓存目录（`rm` 不跟随符号链接）；不抛出。 */
export async function removeTaskScratch(home: string, taskId: string): Promise<void> {
  for (const dir of [taskTmpDir(home, taskId), taskCacheDir(home, taskId)]) {
    if (!dir.startsWith(join(taskRunDir(home, taskId), ''))) continue
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
