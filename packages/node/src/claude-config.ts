import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { executorRunDir, fail, ok, type Result } from '@raindown/core'

/**
 * 施加外层 seatbelt 时 claude-sdk 使用的 Claude Code 配置目录（add-worker-credential-isolation 4.6）。
 *
 * 写入是白名单，Claude Code 又必须写自己的数据目录（会话记录、shell 快照、待办、缓存、全局状态 `.claude.json` 等）。
 * 用户自己的 `~/.claude` 与 `~/.claude.json` 不能放行：
 * - `~/.claude/shell-snapshots/` 会被用户自己（沙箱外）的 Claude Code 会话在每条 Bash 命令前 source；
 * - `~/.claude/projects/<项目>/memory/` 会进入用户会话的系统提示词；
 * - `~/.claude.json` 可以按项目配置 MCP 服务器（命令）；`settings.json` 可以配置 hooks。
 * worker 写入这些位置，就能让代码在沙箱外执行。因此 claude-sdk 在施加外层 seatbelt 时把 `CLAUDE_CONFIG_DIR` 指向 Raindown
 * 管理的 `run/executors/claude-sdk/claude-config/`（只给受隔离的 worker 会话使用，supervisor 唤醒会话不使用），
 * 并设 `CLAUDE_SECURESTORAGE_CONFIG_DIR`，使登录凭证仍取自用户原来的钥匙串条目（见 docs/executors.md「写白名单」）。
 *
 * 用户级的设置与扩展以符号链接只读引入（目录中只有链接本身；链接本身与这些名字在白名单内仍拒绝写）。
 */

/** 从用户 Claude 配置目录只读引入的条目（`setting_sources` 含 `user` 时与未隔离时行为一致）。 */
export const CLAUDE_CONFIG_LINKED = [
  'settings.json',
  'CLAUDE.md',
  'commands',
  'agents',
  'skills',
  'output-styles',
  'plugins',
] as const

/**
 * 隔离配置目录中拒绝写的条目：会被 Claude Code 加载或执行的配置与扩展（含上面链接的名字）。
 * 它们只影响之后同样受隔离的会话；拒绝写防止任务之间借此互相影响。
 */
export const CLAUDE_CONFIG_DENY_WRITE = [
  ...CLAUDE_CONFIG_LINKED,
  'settings.local.json',
  'hooks',
  'rules',
  'keybindings.json',
  'managed-settings.json',
  '.mcp.json',
] as const

/** `run/executors/claude-sdk/claude-config/`。 */
export const CLAUDE_CONFIG_HOME = 'claude-config'
export const claudeConfigDir = (home: string) =>
  join(executorRunDir(home, 'claude-sdk'), CLAUDE_CONFIG_HOME)

/** 用户自己的 Claude 配置目录：`CLAUDE_CONFIG_DIR`，缺省 `~/.claude`。 */
export const userClaudeConfigDir = (env: NodeJS.ProcessEnv, userHome = homedir()) =>
  env.CLAUDE_CONFIG_DIR?.trim() ? resolve(env.CLAUDE_CONFIG_DIR) : join(userHome, '.claude')

/**
 * 隔离会话的环境变量：配置目录改为 Raindown 管理的目录；钥匙串条目仍按用户原来的配置目录计算
 * （Claude Code 2.1.310：`CLAUDE_SECURESTORAGE_CONFIG_DIR` 为空串时使用缺省条目 `Claude Code-credentials`，
 * 为某目录时按该目录计算后缀，与用户以 `CLAUDE_CONFIG_DIR=<该目录>` 登录时相同）；
 * Claude Code 的临时目录改到本用户 `TMPDIR`（缺省 `/tmp/claude-<uid>` 属于用户自己的会话，worker 不可写）。
 */
export function claudeIsolatedEnv(
  env: NodeJS.ProcessEnv,
  configDir: string,
  tmpDir: string,
): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR:
      env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR?.trim() ?? '',
    CLAUDE_CODE_TMPDIR: env.CLAUDE_CODE_TMPDIR?.trim() || tmpDir,
  }
}

const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'
const bad = (message: string) => fail('failure', 'claude_config_failed', message)

/**
 * 准备隔离配置目录（0700，不能是符号链接），并把 `CLAUDE_CONFIG_LINKED` 中用户目录里存在的条目以符号链接引入
 * （临时链接 + rename 原子替换；来源不存在时删除旧链接）。目录中已有同名的普通文件或目录时不覆盖，返回错误。
 */
export async function prepareClaudeConfigDir(
  home: string,
  userConfigDir: string,
): Promise<Result<string>> {
  const dir = claudeConfigDir(home)
  try {
    const source = resolve(userConfigDir)
    if (source === resolve(dir)) return bad(`CLAUDE_CONFIG_DIR 指向隔离目录 ${dir}`)
    // 新建的各级目录都是 0700（`run/`、`run/executors/`、`run/executors/claude-sdk/`）。
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const info = await lstat(dir)
    if (info.isSymbolicLink() || !info.isDirectory())
      return bad(`${dir} 必须是 Raindown 管理的普通目录，不能是符号链接或文件`)
    await chmod(dir, 0o700)
    for (const name of CLAUDE_CONFIG_LINKED) {
      const link = join(dir, name)
      const target = join(source, name)
      let current: string | undefined
      try {
        const st = await lstat(link)
        if (!st.isSymbolicLink())
          return bad(`${link} 不是 Raindown 创建的符号链接，请确认后删除再重试`)
        current = await readlink(link)
      } catch (err) {
        if (!missing(err)) throw err
      }
      let exists = true
      try {
        await lstat(target)
      } catch (err) {
        if (!missing(err)) throw err
        exists = false
      }
      if (!exists) {
        if (current !== undefined) await rm(link, { force: true })
        continue
      }
      if (current === target) continue
      const tmp = `${link}.${randomBytes(8).toString('hex')}.tmp`
      try {
        await symlink(target, tmp)
        await rename(tmp, link)
      } finally {
        await rm(tmp, { force: true })
      }
    }
    return ok(dir)
  } catch (err) {
    return bad(`无法准备 Claude Code 的隔离配置目录：${(err as Error).message}`)
  }
}
