import { isAbsolute } from 'node:path'
import { fail, ok, type Result } from '../result.ts'
import type { IsolationSpec } from './spec.ts'

/**
 * 由 `IsolationSpec` 生成外层 seatbelt 配置（SBPL，add-worker-credential-isolation 4.1）。
 *
 * 结构：`(version 1)(allow default)`，之后依次是
 * 1. 最窄允许项（本任务工作目录、派工令牌、harness 目录、中枢端口、显式放行的套接字）；
 * 2. 显式拒绝：`deny_read`、`deny_write`、`deny_children_except`、Orca unix 套接字、已解析的 Orca 端口、跨进程调试。
 *
 * 允许项写在拒绝项之前，同一操作后写的规则优先，所以**拒绝优先**（与 `IsolationSpec` 的约定一致）：
 * `computeIsolationSpec` 已保证允许项不落在任何读拒绝目录内，`allow default` 下允许项本身不放开任何东西，只作记录；
 * 而只读语义（派工令牌、令牌目录、只读工作目录）以写拒绝表示，写在最后才能保证它们即使位于可写目录内也不可写。
 * 其他本机端口不拒绝（worker 自己的 dev server、测试服务器需要可用）；Orca 端口未解析时不生成端口规则，探针与 doctor 照实显示“跳过”。
 *
 * 路径一律内联为 SBPL 字符串字面量，严格转义 `\` 与 `"`；含控制字符（NUL、换行、回车、制表符等 C0/C1 与 DEL）
 * 或不是绝对路径时返回错误、不生成配置。选择内联而不是 `sandbox-exec -D KEY=VALUE` + `(param "KEY")`：
 * 配置文件自包含（探针与 worker 用同一份文件、同一条命令前缀，codex-orca 的终端命令不必再为每个参数做 shell 引号），
 * 转义只涉及两个字符，并由注入测试与 macOS 上的 `sandbox-exec` 实测覆盖。
 */

/** C0 控制字符、DEL 与 C1 控制字符：任何一个出现在路径中都拒绝生成配置。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要匹配控制字符
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

/** seatbelt 操作名（跨进程调试拒绝项）：只接受小写标识，防止注入。 */
const OPERATION_NAME = /^[a-z][a-z0-9*-]{0,63}$/

const validPort = (p: number) => Number.isInteger(p) && p > 0 && p < 65536

class ProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** 把路径写成 SBPL 字符串字面量（含两侧引号）。 */
export function sbplString(path: string): string {
  if (CONTROL_CHARS.test(path))
    throw new ProfileError(
      'isolation_profile_invalid_path',
      `路径含控制字符，拒绝生成 seatbelt 配置：${JSON.stringify(path)}`,
    )
  if (!isAbsolute(path))
    throw new ProfileError(
      'isolation_profile_invalid_path',
      `路径不是绝对路径，拒绝生成 seatbelt 配置：${JSON.stringify(path)}`,
    )
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const port = (p: number): number => {
  if (!validPort(p))
    throw new ProfileError('isolation_profile_invalid_port', `端口不合法：${JSON.stringify(p)}`)
  return p
}

/** 一条规则：没有过滤器时不生成（空过滤器的 deny 会拒绝全部操作，必须避免）。 */
const rule = (action: 'allow' | 'deny', ops: string, filters: readonly string[]): string[] =>
  filters.length === 0
    ? []
    : [`(${action} ${ops}`, ...filters.map((f) => `  ${f}`).slice(0, -1), `  ${filters.at(-1)})`]

const subpaths = (paths: readonly string[]) => paths.map((p) => `(subpath ${sbplString(p)})`)

/**
 * 生成 SBPL 配置文本。只依赖传入的隔离清单（其路径来自节点与角色配置，已 realpath），不读取任何文件。
 * 返回的文本以换行结尾；同一清单总是生成同一文本（便于快照测试）。
 */
export function renderSeatbeltProfile(spec: IsolationSpec): Result<string> {
  try {
    const lines: string[] = [
      ';; 由 Raindown 节点生成（add-worker-credential-isolation 4.1），不要手动修改；每次启动 harness 前重新生成。',
      ';; 规则按出现顺序求值，同一操作后写的规则优先：允许项在前、拒绝项在后，拒绝优先。',
      '(version 1)',
      '(allow default)',
      '',
      ';; 1. 最窄允许项（allow default 下只作记录；均不位于下面的读拒绝目录内）',
      ...rule('allow', 'file-read*', subpaths(spec.allow_read)),
      ...rule('allow', 'file-write*', subpaths(spec.allow_write)),
      ...rule(
        'allow',
        'network-outbound',
        spec.allow_local_ports.map((p) => `(remote ip "localhost:${port(p)}")`),
      ),
      ...rule(
        'allow',
        'network-outbound',
        spec.allow_unix_sockets.map((p) => `(remote unix-socket (path-literal ${sbplString(p)}))`),
      ),
      '',
      ';; 2. 受保护资源：读写拒绝（以目录为单位，新增文件自动覆盖）',
      ...rule('deny', 'file-read*', subpaths(spec.deny_read)),
      ...rule('deny', 'file-write*', subpaths(spec.deny_write)),
      '',
      ';; 3. 目录下除保留子目录以外的全部内容（目录本身可见）',
      ...spec.deny_children_except.flatMap((d) =>
        rule('deny', 'file-read* file-write*', [
          `(require-all (subpath ${sbplString(d.dir)}) (require-not (literal ${sbplString(d.dir)})) (require-not (subpath ${sbplString(d.keep)})))`,
        ]),
      ),
      '',
      ';; 4. 控制通道：文件规则拦不住 unix 套接字 connect，单独拒绝；只拒绝已解析的 Orca 端口，其他本机端口不拒绝',
      ...rule(
        'deny',
        'network-outbound',
        spec.deny_unix_sockets.map((p) => `(remote unix-socket (subpath ${sbplString(p)}))`),
      ),
      ...rule(
        'deny',
        'network-outbound',
        spec.deny_local_ports.map((p) => `(remote ip "*:${port(p)}")`),
      ),
      '',
      ';; 5. 跨进程调试（allow default 下默认允许 attach 同用户的非 hardened 进程）',
      ...spec.deny_process_debug.map((op) => {
        if (!OPERATION_NAME.test(op))
          throw new ProfileError(
            'isolation_profile_invalid_operation',
            `不认识的 seatbelt 操作名：${JSON.stringify(op)}`,
          )
        return `(deny ${op} (target others))`
      }),
    ]
    return ok(`${lines.join('\n')}\n`)
  } catch (err) {
    if (err instanceof ProfileError) return fail('usage', err.code, err.message)
    throw err
  }
}
