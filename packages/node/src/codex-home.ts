import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  type CredentialIsolation,
  executorRunDir,
  fail,
  type HarnessPath,
  ok,
  type Result,
  raindownPaths,
  taskRunDir,
} from '@raindown/core'

/**
 * Raindown 管理的 CODEX_HOME 位于 `run/executors/<执行器>/` 下（D2：移出 `state/`，隔离可整体拒绝 `state/`）。
 * 旧版本放在 `state/` 下；节点启动时由 `migrateCodexHomes` 迁移。旧位置仍是普通目录（迁移失败或尚未迁移）时继续使用旧位置，
 * 不丢失登录状态与会话。
 */
interface CodexHomeLocation {
  legacy: string
  current: string
}

const codexHomeLocations = (home: string) => {
  const state = raindownPaths(home).state
  return {
    // 读任务单独一个目录，保留已有会话以便恢复。
    read: {
      legacy: join(state, 'codex-read-home'),
      current: join(executorRunDir(home, 'codex-exec'), 'codex-read-home'),
    },
    // 写任务按执行器隔离运行状态，避免交互式与无头 Codex 互相影响。
    orca: {
      legacy: join(state, 'codex-orca-home'),
      current: join(executorRunDir(home, 'codex-orca'), 'codex-home'),
    },
    exec: {
      legacy: join(state, 'codex-exec-home'),
      current: join(executorRunDir(home, 'codex-exec'), 'codex-home'),
    },
  } satisfies Record<string, CodexHomeLocation>
}

/** 旧位置是普通目录（不是迁移后留下的链接）时继续使用旧位置。 */
function activeLocation(loc: CodexHomeLocation): string {
  try {
    const info = lstatSync(loc.legacy)
    if (info.isDirectory() && !info.isSymbolicLink()) return loc.legacy
  } catch {
    // 旧位置不存在或不可访问：使用新位置。
  }
  return loc.current
}

export const readCodexHome = (home: string) => activeLocation(codexHomeLocations(home).read)
export const orcaCodexHome = (home: string) => activeLocation(codexHomeLocations(home).orca)
export const execCodexHome = (home: string) => activeLocation(codexHomeLocations(home).exec)

/**
 * 节点启动时（持有节点锁之后）把旧位置的 CODEX_HOME 迁到 `run/`：同一文件系统内 rename，再在旧位置留一个指向新位置的
 * 符号链接，使升级前启动、环境里仍是旧路径的存活 Codex 终端继续可用，并能通过 `sameCodexHome` 的真实路径比较重新挂接。
 * 幂等：旧位置已是链接或不存在时跳过。新旧位置同时存在、rename 失败（例如跨文件系统）时保留旧位置继续使用并记日志。
 * 返回实际迁移的条目，供测试与日志使用。
 */
export async function migrateCodexHomes(
  home: string,
  log: (message: string) => void,
): Promise<{ migrated: string[] }> {
  const migrated: string[] = []
  await cleanTmpLinks(home, log)
  for (const loc of Object.values(codexHomeLocations(home))) {
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(loc.legacy)
    } catch (err) {
      if (!missing(err)) log(`无法检查旧 CODEX_HOME ${loc.legacy}：${(err as Error).message}`)
      continue
    }
    if (info.isSymbolicLink()) continue
    if (!info.isDirectory()) {
      log(`旧 CODEX_HOME ${loc.legacy} 不是目录，跳过迁移`)
      continue
    }
    try {
      await lstat(loc.current)
      log(
        `CODEX_HOME 新旧位置同时存在（${loc.legacy}：${await authState(loc.legacy)}；${loc.current}：${await authState(loc.current)}），继续使用旧位置；请确认后手动合并`,
      )
      continue
    } catch (err) {
      if (!missing(err)) {
        log(`无法检查 ${loc.current}，继续使用旧位置：${(err as Error).message}`)
        continue
      }
    }
    // 先在旧目录旁建好指向新位置的临时链接，rename 目录后立即把链接 rename 到旧位置，
    // 旧路径不存在的窗口只有两次 rename 之间。
    const tmpLink = `${loc.legacy}.${randomBytes(8).toString('hex')}.link`
    try {
      await ensureRunDirs(dirname(loc.current), raindownPaths(home).run)
      await symlink(loc.current, tmpLink)
    } catch (err) {
      await rm(tmpLink, { force: true }).catch(() => {})
      log(
        `迁移 CODEX_HOME ${loc.legacy} → ${loc.current} 失败，继续使用旧位置：${(err as Error).message}`,
      )
      continue
    }
    try {
      await rename(loc.legacy, loc.current)
    } catch (err) {
      await rm(tmpLink, { force: true }).catch(() => {})
      log(
        `迁移 CODEX_HOME ${loc.legacy} → ${loc.current} 失败，继续使用旧位置：${(err as Error).message}`,
      )
      continue
    }
    migrated.push(loc.current)
    try {
      await rename(tmpLink, loc.legacy)
    } catch (err) {
      await rm(tmpLink, { force: true }).catch(() => {})
      // 新位置已生效；只有升级前启动的存活终端会因此无法重挂接。
      log(`已迁移到 ${loc.current}，但无法在旧位置留下链接：${(err as Error).message}`)
    }
  }
  return { migrated }
}

/** 迁移时在旧位置旁创建的临时链接名（`codex-<x>-home.<16 位十六进制>.link`）。 */
const TMP_LINK_RE = /^codex-(?:orca|exec|read)-home\.[0-9a-f]{16}\.link$/

/**
 * 删除上次迁移中途被打断时残留在 `state/` 下的临时链接（#93 N2）。只删除名字匹配且确实是符号链接的条目，
 * `rm` 不跟随链接，不影响链接目标。
 */
async function cleanTmpLinks(home: string, log: (message: string) => void): Promise<void> {
  const state = raindownPaths(home).state
  let names: string[]
  try {
    names = await readdir(state)
  } catch (err) {
    if (!missing(err)) log(`无法列出 ${state}，跳过临时链接清理：${(err as Error).message}`)
    return
  }
  for (const name of names) {
    if (!TMP_LINK_RE.test(name)) continue
    const p = join(state, name)
    try {
      if ((await lstat(p)).isSymbolicLink()) await rm(p, { force: true })
    } catch (err) {
      if (!missing(err)) log(`无法删除残留的临时链接 ${p}：${(err as Error).message}`)
    }
  }
}

/** 只报告 auth.json 的存在性与是否为链接，不读取内容。 */
async function authState(dir: string): Promise<string> {
  try {
    const info = await lstat(join(dir, 'auth.json'))
    return info.isSymbolicLink() ? 'auth.json 是链接' : 'auth.json 是普通文件'
  } catch (err) {
    return missing(err) ? '没有 auth.json' : `auth.json 无法检查（${(err as Error).message}）`
  }
}

/** 逐级创建 `run/` 到 `dir` 的目录并收紧为 0700（已存在的目录也收紧，拒绝符号链接）。 */
async function ensureRunDirs(dir: string, runRoot: string): Promise<void> {
  const chain: string[] = []
  for (let d = dir; d.startsWith(runRoot); d = dirname(d)) {
    chain.unshift(d)
    if (d === runRoot) break
  }
  for (const d of chain) {
    await mkdir(d, { recursive: true, mode: 0o700 })
    const info = await lstat(d)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${d} 不是普通目录`)
    await chmod(d, 0o700)
  }
}

/**
 * codex-orca 与 codex-exec 的凭证隔离声明（D1）：harness 沙箱关闭（danger-full-access / bypass）时由外层 seatbelt 施加，
 * 开启（workspace-write / read-only）时由 Codex permissions profile 施加。本阶段只声明，尚未施加。
 */
export const CODEX_CREDENTIAL_ISOLATION: CredentialIsolation = {
  layers: { 'danger-full-access': 'seatbelt', 'workspace-write': 'native', 'read-only': 'native' },
  enforced: false,
}

const HOME_CONFIG = `# 由 Raindown 生成，每次启动 Codex 前覆盖。
# 不含任务绑定、notify、hooks 与项目信任记录；Raindown MCP 由本模块生成的 -c 层注入。
`

/**
 * 共享 CODEX_HOME 只保存无任务状态的配置；绑定放在每个进程独有的 -c 层，避免并发启动相互覆盖。
 * 官方 MCP 配置支持 env_vars 和 server 级 default_tools_approval_mode：
 * https://learn.chatgpt.com/docs/extend/mcp
 * 只免除受限 Raindown 工具的审批，不改变 shell、沙箱或其他工具的审批策略。
 */
export function codexTaskMcpConfig(binding: {
  home: string
  role: string
  taskId: string
}): string {
  const args = ['mcp', '--actor', binding.role, '--task', binding.taskId]
  return `mcp_servers.raindown={command="raindown",args=${JSON.stringify(args)},env={RAINDOWN_HOME=${JSON.stringify(binding.home)},RAINDOWN_ACTOR=${JSON.stringify(binding.role)}},env_vars=["RAINDOWN_LEASE_TOKEN_FILE","RAINDOWN_HUB_URL"],default_tools_approval_mode="approve"}`
}

/** Codex 默认 shell 环境排除项（大小写不敏感的 glob），加上任务凭证路径本身。 */
export const CODEX_SHELL_ENV_EXCLUDES = [
  '*KEY*',
  '*SECRET*',
  '*TOKEN*',
  'RAINDOWN_LEASE_TOKEN_FILE',
] as const

/**
 * Codex 进程环境带有 `RAINDOWN_LEASE_TOKEN_FILE`（MCP `env_vars` 透传需要）。模型执行的 shell 命令
 * 依赖 `shell_environment_policy` 的默认排除项（`*TOKEN*` 等）看不到它；角色配置可以用
 * `ignore_default_excludes = true` 或改写 `exclude` 把它重新暴露。这里生成放在角色配置之后的 -c 层，
 * 固定默认排除生效，并把角色自己的排除项（可解析时）与上面的固定排除项合并，后写的 -c 覆盖角色配置。
 */
export function codexShellEnvPolicyConfig(roleConfig?: Record<string, unknown>): string[] {
  const own = roleConfig?.['shell_environment_policy.exclude']
  let extra: string[] = []
  if (typeof own === 'string') {
    try {
      const parsed: unknown = JSON.parse(own)
      if (Array.isArray(parsed)) extra = parsed.filter((v): v is string => typeof v === 'string')
    } catch {
      // 无法解析的角色排除项不再保留：固定排除项仍然生效（方向安全）。
    }
  }
  const exclude = [...new Set([...extra, ...CODEX_SHELL_ENV_EXCLUDES])]
  return [
    'shell_environment_policy.ignore_default_excludes=false',
    `shell_environment_policy.exclude=${JSON.stringify(exclude)}`,
  ]
}

// 隔离目录由 Raindown 管理，不加载用户级扩展；尤其不能保留审批后积累的 allow 规则。
const HOME_EXTENSIONS = [
  'rules',
  'hooks.json',
  'AGENTS.md',
  'AGENTS.override.md',
  'skills',
  'plugins',
]

const bad = (message: string) => fail('failure', 'codex_home_failed', message)
const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'

async function sameRealPath(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch (err) {
    if (missing(err)) return false
    throw err
  }
}

/** 恢复会话只接受能确认相同的真实目录，缺失或不可访问时拒绝。 */
export async function sameCodexHome(a: string | undefined, b: string): Promise<boolean> {
  if (a === undefined) return false
  try {
    return await sameRealPath(a, b)
  } catch {
    return false
  }
}

/**
 * 实测 Codex 0.164：-c mcp_servers={} 与用户配置的表合并，无法清空已有 MCP；因此必须隔离整个目录。
 * 只从用户目录链接 auth.json；配置与扩展始终由 Raindown 控制，会话等运行状态保留。
 * Codex 若把 auth.json 链接替换成普通文件，保留该文件并拒绝启动，避免丢失刷新后的凭证。
 */
export async function prepareCodexHome(dir: string, authSource: string): Promise<Result<string>> {
  try {
    // 先拒绝根目录链接和认证来源别名，任何清理均不能影响用户自己的 CODEX_HOME。
    try {
      const stat = await lstat(dir)
      if (stat.isSymbolicLink() || !stat.isDirectory())
        return bad(`${dir} 必须是 Raindown 管理的普通目录，不能是符号链接或文件`)
    } catch (err) {
      if (!missing(err)) throw err
    }
    if (resolve(authSource) === resolve(dir) || (await sameRealPath(authSource, dir)))
      return bad(`CODEX_HOME（${authSource}）指向隔离目录 ${dir}，请改回用户自己的 Codex 目录`)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // mkdir 后再次检查，避免使用刚被替换成链接的目录。
    const stat = await lstat(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      return bad(`${dir} 必须是 Raindown 管理的普通目录，不能是符号链接或文件`)

    const link = join(dir, 'auth.json')
    const target = join(resolve(authSource), 'auth.json')
    // 使用临时文件再原子替换，不跟随旧 config.toml 符号链接写入用户配置。
    const config = join(dir, 'config.toml')
    const configTmp = `${config}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(configTmp, HOME_CONFIG, { mode: 0o600, flag: 'wx' })
      await rename(configTmp, config)
    } finally {
      await rm(configTmp, { force: true })
    }
    // rm 不跟随符号链接，旧扩展即使链接到用户目录也只删除链接本身。
    for (const extension of HOME_EXTENSIONS)
      await rm(join(dir, extension), { recursive: true, force: true })

    // 清理可能耗时；结束后再检查凭证，保留并发 worker 刚刷新的普通文件。
    let current: string | undefined
    try {
      const authStat = await lstat(link)
      if (!authStat.isSymbolicLink())
        return bad(
          `${link} 是普通文件而不是指向 ${target} 的符号链接（可能是 Codex 刷新凭证时写入的）。请确认后把它合并回 ${target} 再删除，或直接删除后重新运行`,
        )
      current = await readlink(link)
    } catch (err) {
      if (!missing(err)) throw err
    }

    if (!existsSync(target)) {
      if (current !== undefined) await rm(link, { force: true })
      return ok(dir)
    }
    if (current === target) return ok(dir)
    // 先创建临时链接再原子替换，避免切换来源时出现没有 auth.json 的窗口。
    const authTmp = `${link}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await symlink(target, authTmp)
      await rename(authTmp, link)
    } finally {
      await rm(authTmp, { force: true })
    }
    return ok(dir)
  } catch (err) {
    return bad(`无法准备 Codex 的 CODEX_HOME：${(err as Error).message}`)
  }
}

/**
 * 施加外层 seatbelt 的设置使用的独立 CODEX_HOME（审查第一轮 H3、第二轮 M1）：**每个任务一个** `run/tasks/<任务>/codex-home/`。
 * - 与 workspace-write / read-only 设置的 CODEX_HOME 不共享：共享时 worker 写入的 `.env`、`config.toml` 等会被之后
 *   没有外层 seatbelt 的 Codex 进程加载；
 * - 也不在任务之间共享：共享时一个任务的 worker 能改写另一个任务的会话记录，后者恢复会话时被注入。
 * 同一任务恢复会话用同一目录；任务完成或取消时删除（`removeSealedCodexHome`）。准备方式与普通 CODEX_HOME 相同
 * （`prepareCodexHome`：覆盖 config.toml、清除扩展、链接 auth.json）。
 */
export const sealedCodexHome = (home: string, taskId: string) =>
  join(taskRunDir(home, taskId), 'codex-home')

/**
 * 施加时 `run/executors/<执行器>/` 下只“保留”这个不存在的子目录名：执行器级的 CODEX_HOME（`codex-home`、`codex-read-home`，
 * 被未施加的设置使用）对 worker 读写都拒绝。
 */
export const SEALED_CODEX_HOME = 'codex-home-sealed'

/** 删除本任务的独立 CODEX_HOME（`rm` 不跟随 auth.json 链接）；不抛出。 */
export async function removeSealedCodexHome(home: string, taskId: string): Promise<void> {
  await rm(sealedCodexHome(home, taskId), { recursive: true, force: true }).catch(() => {})
}

/**
 * 外层 seatbelt 下 Codex 的 harness 目录（本任务的独立 CODEX_HOME，用户 2026-11-10 决定，4.5 实测）：
 * - 目录**整体可写**：Codex 启动时写 `installation_id`、`thread-writer-locks/`、`tui-thread-reference-capabilities/`、
 *   `.sqlite-maintenance.lock`、`.sandbox_migration`、`config.toml`（TUI 状态）、`models_cache.json`、`plugins/`、`shell_snapshots/`、
 *   `skills/.system/` 等，内部白名单会使 TUI 启动即退出。该目录只被本任务沙箱内的 Codex 读取（与未施加的设置、其他任务都不共享，
 *   任务完成或取消时删除），worker 写入的内容只影响本任务，且仍在沙箱内执行；节点每次启动前重新覆盖 `config.toml`、清除扩展；
 * - `auth.json` 链接本身拒绝写（不能被删除或换成指向别处的链接、普通文件，审查第一轮 M1）；它是拒绝项，所以 `codex-home` 目录本身
 *   作为其祖先不能改名（`protectedAncestors`）；
 * - 链接目标（用户的 `auth.json`）这一个文件可写：Codex 在进程内刷新登录凭证并经链接写回。worker 因此可以把它换成
 *   攻击者账号的凭证（登记在 design Risks）；改由节点在沙箱外刷新需要 Codex 支持只读凭证，目前不可行（见 docs）。
 */
export const codexHarnessPaths = (codexHome: string): HarnessPath[] => [
  { path: codexHome, access: 'write', denyWrite: ['auth.json'] },
  { path: join(codexHome, 'auth.json'), access: 'write', literal: true },
]
