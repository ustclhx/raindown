import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

/**
 * 仓库 `orca.yaml` 中的 setup 脚本（`scripts.setup`）。施加外层 seatbelt 时 codex-orca 的 Orca worktree 只作终端宿主、
 * 跳过 Orca 自己的 setup；节点在本任务的独立 clone 中、以与 worker 相同的 seatbelt 配置运行这段脚本（审查第一轮，第一步方案 (b)）。
 * 只读取 clone 刚检出、worker 尚未运行时的文件；不是普通文件、过大或格式不对时视为没有 setup。
 */
const orcaYaml = z.object({ scripts: z.object({ setup: z.string().min(1).max(64_000) }) })

export async function readOrcaSetupScript(dir: string): Promise<string | undefined> {
  const path = join(dir, 'orca.yaml')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 256_000) return undefined
    const parsed = orcaYaml.safeParse(parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data.scripts.setup : undefined
  } catch {
    return undefined
  }
}
