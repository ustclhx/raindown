import { lstat, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { raindownPaths } from '../home.ts'

/**
 * `run/` 的布局（add-worker-credential-isolation D2）：
 * - `run/executors/<执行器>/`：执行器级的 harness 目录，例如 Raindown 管理的 CODEX_HOME；
 * - `run/tasks/<任务 id>/`：任务私有目录：派工令牌（`dispatch-tokens/<租约>.token`）、claude-sdk 审查目录
 *   （`review/<node-id>/`）。施加外层 seatbelt 时生成的配置不放在这里（worker 可写），见 `taskIsolationProfile`。
 * 各级目录均为 0700。节点自己的任务状态（任务说明、orca.json 等）仍在 `state/tasks/<id>/`。
 */
export const runExecutorsDir = (home: string) => join(raindownPaths(home).run, 'executors')
export const runTasksDir = (home: string) => join(raindownPaths(home).run, 'tasks')
export const executorRunDir = (home: string, executor: string) =>
  join(runExecutorsDir(home), executor)
export const taskRunDir = (home: string, taskId: string) => join(runTasksDir(home), taskId)
/** 外层 seatbelt 配置文件名（0600；tasks 4.1）。 */
export const ISOLATION_PROFILE_FILE = 'isolation.sb'
/**
 * 本任务的外层 seatbelt 配置：`state/tasks/<任务>/isolation.sb`。放在 worker 读写都被拒绝的 `state/` 下（审查第一轮 H2）：
 * 放在 worker 可写的 `run/tasks/<任务>/` 时，后台常驻进程可以改写它，下次同任务启动 harness 时就没有隔离。
 * `sandbox-exec` 在施加沙箱之前读取配置，不受拒绝规则影响。
 */
export const taskIsolationProfile = (home: string, taskId: string) =>
  join(raindownPaths(home).state, 'tasks', taskId, ISOLATION_PROFILE_FILE)

const MAX_LINKS = 40

const errCode = (err: unknown) => (err as NodeJS.ErrnoException).code

/**
 * 把路径规范化为真实路径（seatbelt 按真实路径匹配，未规范化的规则会静默失效）：
 * - 存在的路径直接 realpath，符号链接解析到目标；
 * - 不存在的路径按最近的已存在祖先 realpath 后拼回剩余部分；
 * - 悬空的符号链接按链接目标继续规范化（目标以后被创建时规则仍然匹配）。
 * 只做规范化，不判断路径是否应当存在。
 */
export async function canonicalPath(path: string, depth = 0): Promise<string> {
  const abs = resolve(path)
  if (depth > MAX_LINKS) throw new Error(`符号链接层数过多：${abs}`)
  try {
    return await realpath(abs)
  } catch (err) {
    const code = errCode(err)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
  }
  // 自身是悬空链接：跟随目标。
  try {
    const info = await lstat(abs)
    if (info.isSymbolicLink()) {
      const target = await readlink(abs)
      return canonicalPath(isAbsolute(target) ? target : join(dirname(abs), target), depth + 1)
    }
  } catch (err) {
    const code = errCode(err)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
  }
  const parent = dirname(abs)
  if (parent === abs) return abs
  return join(await canonicalPath(parent, depth), basename(abs))
}

/** `child` 是否等于 `parent` 或位于其下（两者都应是规范化后的绝对路径）。 */
export function isWithin(parent: string, child: string): boolean {
  if (parent === child) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}
