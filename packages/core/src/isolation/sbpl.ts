import { dirname, isAbsolute } from 'node:path'
import { fail, ok, type Result } from '../result.ts'
import type { IsolationSpec } from './spec.ts'

/**
 * 由 `IsolationSpec` 生成外层 seatbelt 配置（SBPL，add-worker-credential-isolation 4.1）。
 *
 * 结构：`(version 1)(allow default)`，之后依次是
 * 0. `(deny file-write*)`：写入是白名单（tasks 4.6），只有下面放行的位置可写；
 * 1. 最窄允许项（本任务工作目录、派工令牌、harness 目录、中枢端口、显式放行的套接字）与写白名单
 *    （本任务私有目录、harness 运行状态、设备文件等），之后在白名单内挖掉登记仓库的 git 目录与 harness 配置，
 *    再放行本任务独立 clone 的 `.git`；最后是持久化位置的拒绝与派生任务、偏好设置等拒绝（审查第一轮）；
 * 2. 显式拒绝：`deny_read`、`deny_write`、`deny_children_except`、受保护路径全部祖先目录的写（防改名绕过）、
 *    Orca unix 套接字、已解析的 Orca 端口、跨进程调试。
 *
 * 允许项写在拒绝项之前，同一操作后写的规则优先，所以**拒绝优先**（与 `IsolationSpec` 的约定一致）：
 * `computeIsolationSpec` 已保证允许项不落在任何读拒绝目录内，`allow default` 下读放行本身不放开任何东西，只作记录；
 * 写放行只抵消第 0 步的默认写拒绝，受保护项的拒绝在其后，白名单不能重新放开它们；而只读语义（派工令牌、令牌目录、只读工作目录）以写拒绝表示，写在最后才能保证它们即使位于可写目录内也不可写。
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
const literals = (paths: readonly string[]) => paths.map((p) => `(literal ${sbplString(p)})`)

/**
 * 正则过滤器（写白名单中的登录钥匙串、harness 运行状态文件）：正则由 core 生成（路径前缀已转义），
 * 这里再校验一次——必须以 `^/` 开头，不能含双引号与控制字符（SBPL 的 `#"…"` 字面量不能转义双引号）。
 */
export function sbplRegex(src: string): string {
  if (CONTROL_CHARS.test(src) || src.includes('"') || !src.startsWith('^/'))
    throw new ProfileError(
      'isolation_profile_invalid_path',
      `正则不合法（须以 ^/ 开头，不能含双引号或控制字符），拒绝生成 seatbelt 配置：${JSON.stringify(src)}`,
    )
  return `(regex #"${src}")`
}

/**
 * 持久化与外部启动通道（审查第一轮 L5）：派生 launchd 任务、写偏好设置、经 LaunchServices 打开应用、发送 AppleEvents。
 * 只验证了本机 sandbox 能解析这些操作名；`user-preference-write` 拦不住经 cfprefsd 的 `defaults write`（实测，见 docs）。
 */
export const DENY_LAUNCH_OPERATIONS = [
  'job-creation',
  'user-preference-write',
  'lsopen',
  'appleevent-send',
] as const

/** 终端从设备（`/dev/ttys<N>`）：数目不定，用固定正则放行；不接受任何外部输入。 */
export const TTY_DEVICE_REGEX = '(regex #"^/dev/ttys[0-9]+$")'

/** `path` 的全部祖先目录（不含自身），直到 `/`。 */
function ancestors(path: string): string[] {
  const out: string[] = []
  for (let d = dirname(path); ; d = dirname(d)) {
    out.push(d)
    if (dirname(d) === d) break
  }
  return out
}

/**
 * 受保护路径的祖先目录（审查第一轮 H1）：读写拒绝都按路径匹配，改名任何一级祖先目录（`mv home home2`）
 * 就能在新路径下读到受保护文件。因此对每个受保护路径的全部祖先目录、`deny_children_except` 的 `dir` 本身及其祖先，
 * 都写 `(deny file-write* (literal …))`：只拒绝对目录节点本身的写（改名、删除、改属性），
 * 不影响在这些目录里新建、修改其他文件或子目录（新建子项按子项自己的路径检查）。
 */
export function protectedAncestors(spec: IsolationSpec): string[] {
  const set = new Set<string>()
  for (const p of [
    ...spec.deny_read,
    ...spec.deny_write,
    ...spec.deny_unix_sockets,
    // 白名单内挖掉的位置（git 目录、.git 指针文件、harness 配置）：改名其祖先（例如工作目录）后同样能绕过（tasks 4.6）。
    ...spec.write_carve_outs,
    ...spec.write_carve_out_literals,
    ...spec.deny_write_except.map((d) => d.path),
  ])
    for (const a of ancestors(p)) set.add(a)
  for (const d of spec.deny_children_except) {
    set.add(d.dir)
    for (const a of ancestors(d.dir)) set.add(a)
  }
  return [...set].sort()
}

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
      ';; 0. 写白名单（tasks 4.6）：默认拒绝一切写，下面只放行需要的位置',
      '(deny file-write*)',
      '',
      ';; 1. 最窄允许项：读放行只作记录（均不位于下面的读拒绝目录内）；写放行即写白名单',
      ...rule('allow', 'file-read*', subpaths(spec.allow_read)),
      ...rule('allow', 'file-write*', [
        ...subpaths(spec.allow_write),
        ...literals(spec.allow_write_literals),
        ...spec.allow_write_regex.map(sbplRegex),
        ...(spec.allow_write_literals.length > 0 ? [TTY_DEVICE_REGEX] : []),
      ]),
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
      ';; 1a. 白名单内再拒绝写：登记仓库的 git 目录与 .git 指针文件、harness 目录中会被加载或执行的配置',
      ...rule('deny', 'file-write*', [
        ...subpaths(spec.write_carve_outs),
        ...literals(spec.write_carve_out_literals),
      ]),
      ';; 1b. 本任务独立 clone 的 .git（写类角色）；config、hooks、alternates 等在下面再次拒绝。登记仓库的 .git 整体只读',
      ...rule('allow', 'file-write*', [
        ...subpaths(spec.allow_write_git),
        ...subpaths(spec.allow_write_inside),
        ...literals(spec.allow_write_inside_literals),
        ...spec.allow_write_inside_regex.map(sbplRegex),
      ]),
      '',
      ';; 2. 受保护资源：读写拒绝（以目录为单位，新增文件自动覆盖）；写在白名单之后，白名单不能重新放开',
      ...rule('deny', 'file-read*', subpaths(spec.deny_read)),
      ...rule('deny', 'file-write*', subpaths(spec.deny_write)),
      ';; 2a. 持久化位置（shell 启动文件、~/.ssh、~/.gitconfig 等）：纵深防御，追加的白名单也不能放开；只保留已放行的单个文件',
      ...rule(
        'deny',
        'file-write*',
        spec.deny_write_except.map((d) =>
          d.except.length === 0
            ? `(subpath ${sbplString(d.path)})`
            : `(require-all (subpath ${sbplString(d.path)})${d.except.map((e) => ` (require-not (literal ${sbplString(e)}))`).join('')})`,
        ),
      ),
      '',
      ';; 3. 目录下除保留子目录以外的全部内容（目录本身可见）',
      ...spec.deny_children_except.flatMap((d) =>
        rule('deny', 'file-read* file-write*', [
          `(require-all (subpath ${sbplString(d.dir)}) (require-not (literal ${sbplString(d.dir)})) (require-not (subpath ${sbplString(d.keep)})))`,
        ]),
      ),
      '',
      ';; 4. 受保护路径的祖先目录：拒绝对目录节点本身的写（改名、删除），防止改名祖先目录后在新路径下绕过上面的规则',
      ...rule(
        'deny',
        'file-write*',
        protectedAncestors(spec).map((p) => `(literal ${sbplString(p)})`),
      ),
      '',
      ';; 5. 控制通道：文件规则拦不住 unix 套接字 connect，单独拒绝；只拒绝已解析的 Orca 端口，其他本机端口不拒绝',
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
      ';; 6. 跨进程调试（allow default 下默认允许 attach 同用户的非 hardened 进程）',
      ...spec.deny_process_debug.map((op) => {
        if (!OPERATION_NAME.test(op))
          throw new ProfileError(
            'isolation_profile_invalid_operation',
            `不认识的 seatbelt 操作名：${JSON.stringify(op)}`,
          )
        return `(deny ${op} (target others))`
      }),
      '',
      ';; 7. 派生 launchd 任务、写偏好设置、经 LaunchServices 打开应用、发送 AppleEvents（审查第一轮 L5）',
      ...DENY_LAUNCH_OPERATIONS.map((op) => `(deny ${op})`),
    ]
    return ok(`${lines.join('\n')}\n`)
  } catch (err) {
    if (err instanceof ProfileError) return fail('usage', err.code, err.message)
    throw err
  }
}
