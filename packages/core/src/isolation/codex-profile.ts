import { isAbsolute } from 'node:path'
import { fail, ok, type Result } from '../result.ts'
import { isWithin } from './paths.ts'
import type { IsolationSpec } from './spec.ts'

/**
 * `native` 施加层：由 `IsolationSpec` 生成 Codex permissions profile（add-worker-credential-isolation 5.1，design D1）。
 *
 * 1.1 实测（Codex 0.167.0）：`[permissions.<名>.filesystem]` 中的 `"deny"` 可靠地拒绝沙箱内命令读取该路径（具体目录按子树匹配），
 * 在 deny 目录内对单个文件写 `"read"` 可以重新放行（更具体的条目优先）。profile 只约束 Codex **在沙箱内执行的命令**：
 * Codex 进程本身及其内置工具、MCP 服务器、经审批越出沙箱的命令都不受约束（见 docs/executors.md「`native`」）。
 *
 * 生成规则：
 * - `extends`：workspace-write 为 `":workspace"`，read-only 为 `":read-only"`；
 * - `filesystem`：受保护路径（`deny_read`，以及 `deny_children_except` 的 `dir` 整体——native 下 raindown-home 整体拒绝，
 *   因为 worker 的命令不需要读取其中任何内容）与调用方追加的拒绝项（该执行器的 CODEX_HOME、`auth.json` 链接的源文件）全部 `"deny"`；
 *   `allow_read` 中落在拒绝目录内的项（本任务的派工令牌）与调用方追加的只读项写 `"read"`；路径一律是 realpath 的具体目录或文件，不用 glob；
 * - `network.unix_sockets`：Orca 运行时目录（`deny_unix_sockets`）与调用方给出的套接字 `"deny"`（`:workspace` 本来就拒绝 unix 套接字，这里是纵深防御）；
 * - `network.enabled`：只在角色原本打开了 workspace-write 的网络（`sandbox_workspace_write.network_access`）时写 `true`，
 *   否则不写，沿用 `extends` 的缺省（不联网），与角色原有语义一致。
 *
 * 输出是一个 `-c` 值（TOML 内联表），每次启动随命令行传入，不写进共享 CODEX_HOME 的 `config.toml`
 * （同一执行器的 CODEX_HOME 被多个任务共享，profile 含按任务的条目，写文件会竞态）。路径写成 TOML 基本字符串，
 * 严格转义反斜杠、引号与全部控制字符（含换行），不能改变内联表的结构（注入测试覆盖）。
 */

/** native 支持的 Codex 沙箱设置。 */
export type CodexNativeSandbox = 'workspace-write' | 'read-only'

export const CODEX_NATIVE_EXTENDS: Record<CodexNativeSandbox, string> = {
  'workspace-write': ':workspace',
  'read-only': ':read-only',
}

/** profile 名：只用小写字母、数字与连字符（作为 `-c` 的点分键的一段，不能含点号、引号）。 */
const PROFILE_NAME = /^[a-z][a-z0-9-]{0,63}$/

/** profile 名的前缀；后缀由调用方给出（节点每次启动取随机值，见 `codexNativeProfileName`）。 */
export const CODEX_NATIVE_PROFILE_PREFIX = 'raindown-'

export interface CodexNativeProfileInput {
  spec: IsolationSpec
  sandbox: CodexNativeSandbox
  /** profile 名（`[permissions.<名>]`）。 */
  name: string
  /**
   * 追加的拒绝项（realpath）：该执行器的 CODEX_HOME、`auth.json` 链接的源文件等。Codex 进程本身不在沙箱内，
   * 拒绝这些路径不影响 harness，只让沙箱内的命令读不到会话记录与登录凭证。
   */
  extraDeny?: readonly string[]
  /** 追加的只读项（realpath），应位于某个拒绝目录内（例如 CODEX_HOME 的 `tmp/`：Codex 的 arg0 别名在沙箱内执行）。 */
  extraRead?: readonly string[]
  /** 追加拒绝连接的 unix 套接字（例如 Orca 运行时目录中找到的套接字）。 */
  unixSockets?: readonly string[]
  /** 角色原本打开了 workspace-write 的网络（`sandbox_workspace_write.network_access`）。 */
  networkEnabled?: boolean
}

/** profile 的文件系统条目（排好序，供测试与文档展示）。 */
export interface CodexNativeProfile {
  name: string
  extends: string
  filesystem: Array<[path: string, access: 'deny' | 'read']>
  unixSockets: string[]
  networkEnabled: boolean
}

/**
 * TOML 基本字符串（含两侧引号）：转义 `\`、`"` 与全部控制字符（U+0000–U+001F、U+007F，以及 C1 U+0080–U+009F），
 * 换行、回车、制表符同样写成转义序列，结果只占一行，不能闭合字符串或改变内联表结构。
 */
export function tomlBasicString(s: string): string {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0) as number
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
      out += `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`
    else out += ch
  }
  return `${out}"`
}

const badPath = (path: string, why: string) =>
  fail(
    'usage',
    'codex_profile_invalid_path',
    `${why}，拒绝生成 Codex permissions profile：${JSON.stringify(path)}`,
  )

/** 去重、排序，并省略被其他拒绝目录覆盖的子路径。 */
function minimal(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort()
  return sorted.filter((p) => !sorted.some((q) => q !== p && isWithin(q, p)))
}

/** 由隔离清单计算 profile 的条目（不渲染）。 */
export function codexNativeProfile(input: CodexNativeProfileInput): Result<CodexNativeProfile> {
  if (!PROFILE_NAME.test(input.name))
    return fail(
      'usage',
      'codex_profile_invalid_name',
      `Codex permissions profile 名不合法：${JSON.stringify(input.name)}`,
    )
  const ext = CODEX_NATIVE_EXTENDS[input.sandbox]
  if (!ext)
    return fail(
      'usage',
      'codex_profile_invalid_sandbox',
      `native 只支持 workspace-write 与 read-only：${JSON.stringify(input.sandbox)}`,
    )
  const spec = input.spec
  const deny = minimal([
    ...spec.deny_read,
    ...spec.deny_children_except.map((d) => d.dir),
    ...(input.extraDeny ?? []),
  ])
  // 只读放行只对落在拒绝目录内的允许项有意义（其余路径在 `:workspace` / `:read-only` 下本来就可读）。
  const read = [...new Set([...spec.allow_read, ...(input.extraRead ?? [])])]
    .filter((p) => deny.some((d) => isWithin(d, p)))
    .filter((p) => !deny.includes(p))
    .sort()
  const sockets = [...new Set([...spec.deny_unix_sockets, ...(input.unixSockets ?? [])])].sort()
  for (const p of [...deny, ...read, ...sockets]) {
    if (!isAbsolute(p)) return badPath(p, '路径不是绝对路径')
    if (p.length === 0) return badPath(p, '路径为空')
  }
  const filesystem: CodexNativeProfile['filesystem'] = [
    ...deny.map((p) => [p, 'deny'] as [string, 'deny']),
    ...read.map((p) => [p, 'read'] as [string, 'read']),
  ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return ok({
    name: input.name,
    extends: ext,
    filesystem,
    unixSockets: sockets,
    networkEnabled: input.sandbox === 'workspace-write' && input.networkEnabled === true,
  })
}

/** profile 的 TOML 内联表（不含键）。 */
export function renderCodexNativeProfileTable(p: CodexNativeProfile): string {
  const fs = p.filesystem.map(([path, access]) => `${tomlBasicString(path)}="${access}"`).join(',')
  const sockets = p.unixSockets.map((s) => `${tomlBasicString(s)}="deny"`).join(',')
  const network = [...(p.networkEnabled ? ['enabled=true'] : []), `unix_sockets={${sockets}}`].join(
    ',',
  )
  return `{extends=${tomlBasicString(p.extends)},filesystem={${fs}},network={${network}}}`
}

/**
 * 启动 Codex 时追加的 `-c` 参数（不含 `-c` 本身）：先定义 profile，再选中它。
 * 官方要求 `default_permissions` 不与 `sandbox_mode`（`-s`）混用，调用方施加时不再传 `-s` 与 `config.sandbox_mode`。
 */
export function codexNativeConfigValues(p: CodexNativeProfile): string[] {
  return [
    `permissions.${p.name}=${renderCodexNativeProfileTable(p)}`,
    `default_permissions=${tomlBasicString(p.name)}`,
  ]
}
