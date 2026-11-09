import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { z } from 'zod'
import { loadNodeConfig } from './daemon/config.ts'
import { checkDaemonPlists, LEGACY_DAEMON_LABELS, launchAgentsDirectory } from './daemon/plist.ts'
import { checkPatrolRules } from './doctor-patrol.ts'
import { type DoctorSdk, inspectClaudeSdk } from './doctor-sdk.ts'
import { reservedNameVariants } from './entries.ts'
import type { execCommand } from './git.ts'
import { isRepoRoot } from './git.ts'
import { type Env, GIT_REPOS, type RaindownHomeSource, raindownPaths } from './home.ts'
import { roleSandboxInfo } from './isolation/capability.ts'
import { describeIsolationStatus, isolationStatusRows } from './isolation/probe.ts'
import { normalizeExtraWrite } from './isolation/write-allowlist.ts'
import type { NodeView } from './ledger/protocol.ts'
import { loadPoliciesConfig } from './policy/config.ts'
import { policyVersion } from './policy/version.ts'
import { fail, ok, type Result } from './result.ts'
import {
  CLAUDE_READ_REQUIRED_DISALLOWED,
  CLAUDE_SDK_KNOWN_PERMISSION_KEYS,
  CODEX_EXEC_KNOWN_PERMISSION_KEYS,
  CODEX_EXEC_READ_SAFE_CONFIG_KEYS,
  canCreateRole,
  effectiveRoleKind,
  findSupervisorRole,
  inferRoleKind,
  KNOWN_EXECUTORS,
  loadRoles,
  type Role,
  SUPERVISOR_ACTOR,
} from './roles.ts'
import type { GithubConfig } from './schema/github.ts'
import type { SupervisorConfig } from './schema/supervisor.ts'
import { loadWorkspaces, reviewerRoleIssues } from './workspaces.ts'

/** gitleaks 需 staged/stdin；Codex 需 exec --json/resume；Codex、Orca 下限取已验证的 fixture 版本。 */
export const MIN_VERSIONS = {
  git: '2.28.0',
  gitleaks: '8.19.0',
  codex: '0.164.0',
  orca: '1.4.218',
} as const

const INIT_HINT = '运行 raindown init 补齐（已有文件不会被覆盖）'

export const INSTALL_HINTS = {
  codex: '安装或更新 Codex CLI，并确保 codex 在节点的 PATH 中',
  orca: '安装或更新 Orca，并确保 orca 在节点的 PATH 中；运行 Orca 应用后重试',
  git: '安装 git：xcode-select --install 或 brew install git',
  gitleaks:
    '安装 gitleaks：brew install gitleaks（其他平台见 https://github.com/gitleaks/gitleaks#installing）',
} as const

export interface DoctorCheck {
  /** 稳定的检查标识，例如 `tool.gitleaks`、`repo.brain`、`hook.raw`。 */
  id: string
  ok: boolean
  /** info / warning 不影响退出码；旧检查省略时，失败按 error、成功按 info。 */
  severity?: 'error' | 'warning' | 'info'
  message: string
  /** 失败时的修复提示。 */
  hint?: string
}

export interface DoctorReport {
  home: string
  /** 新旧环境变量或默认目录。 */
  homeSource: RaindownHomeSource
  ok: boolean
  checks: DoctorCheck[]
}

export interface DoctorOptions {
  /** 测试必须注入临时目录，避免读取真实的 LaunchAgents。 */
  launchAgentsDir?: string
  /** 用于查找外部工具的环境（主要是 PATH）；测试中注入以模拟缺少工具。 */
  env?: Env
  /** 所有外部命令（包括 git）；缺省 argv 执行，10 秒超时、最多 1MB 输出。 */
  runCommand?: typeof execCommand
  findExecutable?: typeof findExecutable
  /** 测试注入模拟 SDK，绝不加载或运行真实 Claude。 */
  inspectClaudeSdk?: () => Promise<DoctorSdk | null>
  /** 凭证只检查文件是否存在；测试必须注入临时用户目录。 */
  userHome?: string
  platform?: NodeJS.Platform
  /**
   * 读取中枢的节点列表，用于汇总各节点的隔离自检结果（worker-credential-isolation 3.2）。
   * 缺省不读取；CLI 的 doctor 经中枢读取，测试注入。中枢不可用时只给 info，不影响退出码。
   */
  isolationNodes?: () => Promise<Result<{ nodes: NodeView[] }>>
}

/** 在 PATH 中查找可执行文件，返回绝对路径。 */
export function findExecutable(name: string, env: Env = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, name)
    try {
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK)
        return p
      }
    } catch {}
  }
  return null
}

/** 比较 `a.b.c` 版本号：a<b 返回负数。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const extractVersion = (text: string): string | null =>
  /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? null

const doctorCommand: typeof execCommand = (bin, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { ...opts, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
      },
    )
  })

async function checkTool(
  name: keyof typeof MIN_VERSIONS,
  args: string[],
  env: Env,
  run: typeof execCommand,
  find: typeof findExecutable,
  roles?: string[],
): Promise<{ check: DoctorCheck; bin: string | null }> {
  const id = `tool.${name}`
  if (roles?.length === 0) {
    return {
      bin: null,
      check: { id, ok: false, severity: 'info', message: `${name} 没有角色引用，跳过检查` },
    }
  }
  const bin = find(name, env)
  const suffix = roles ? `（角色：${roles.join('、')}）` : ''
  if (!bin) {
    return {
      bin,
      check: {
        id,
        ok: false,
        severity: 'error',
        message: `未找到 ${name}${suffix}`,
        hint: INSTALL_HINTS[name],
      },
    }
  }
  const r = await run(bin, args, { env })
  const version = extractVersion(`${r.stdout}\n${r.stderr}`)
  const min = MIN_VERSIONS[name]
  if (r.code !== 0 || !version || compareVersions(version, min) < 0) {
    return {
      bin,
      check: {
        id,
        ok: false,
        severity: r.code === 0 && version && roles ? 'warning' : 'error',
        message: `${name}${r.code !== 0 ? ' 版本命令失败' : !version ? ' 版本无法解析' : ` 版本 ${version} 低于最低要求 ${min}`}${suffix}`,
        hint: INSTALL_HINTS[name],
      },
    }
  }
  return { bin, check: { id, ok: true, message: `${name} ${version}（${bin}）${suffix}` } }
}

const orcaTerminals = z.object({
  ok: z.literal(true),
  result: z.object({ terminals: z.array(z.object({})) }),
})

async function checkExecutors(
  roles: Role[],
  env: Env,
  opts: DoctorOptions,
  run: typeof execCommand,
  find: typeof findExecutable,
): Promise<DoctorCheck[]> {
  const users = (...executors: string[]) =>
    roles.filter((r) => executors.includes(r.executor)).map((r) => r.name)
  const codex = await checkTool(
    'codex',
    ['--version'],
    env,
    run,
    find,
    users('codex-orca', 'codex-exec'),
  )
  const orcaRoles = users('codex-orca')
  const orca = await checkTool('orca', ['--version'], env, run, find, orcaRoles)
  const checks = [codex.check, orca.check]
  const dependency = (
    id: string,
    available: boolean,
    message: string,
    usedBy: string[],
    hint?: string,
  ): DoctorCheck => ({
    id,
    ok: available,
    severity: !available && usedBy.length > 0 ? 'error' : 'info',
    message: `${message}（${usedBy.length ? `角色：${usedBy.join('、')}` : '没有角色引用'}）`,
    ...(!available && hint ? { hint } : {}),
  })
  if (orca.bin) {
    const r = await run(orca.bin, ['terminal', 'list', '--json'], { env })
    let available = false
    try {
      available = r.code === 0 && orcaTerminals.safeParse(JSON.parse(r.stdout)).success
    } catch {
      // 非 JSON / 不合法信封按不可用报告，不把终端内容或命令输出带进报告。
    }
    checks.push(
      dependency(
        'orca.app',
        available,
        available ? 'Orca 应用可连接' : '无法连接 Orca 应用或 terminal list 返回无效 JSON',
        orcaRoles,
        '启动 Orca 应用后重试 orca terminal list --json；若仍失败，检查 CLI 与应用版本是否匹配',
      ),
    )
  }

  const claudeRoles = users('claude-sdk')
  if (claudeRoles.length === 0) {
    checks.push(dependency('tool.claude-sdk', false, 'Claude Agent SDK 跳过检查', claudeRoles))
    return checks
  }
  let sdk: DoctorSdk | undefined
  try {
    sdk = (await (opts.inspectClaudeSdk ?? inspectClaudeSdk)()) ?? undefined
    checks.push(
      dependency(
        'tool.claude-sdk',
        Boolean(sdk),
        sdk
          ? `Claude Agent SDK ${sdk.version} 可 import（node 声明：${sdk.expectedVersion}）`
          : 'Claude Agent SDK 未安装（无法从 @raindown/node 解析）',
        claudeRoles,
        '在 Raindown 仓库运行 bun install --frozen-lockfile，安装 @raindown/node 声明的 SDK',
      ),
    )
  } catch {
    checks.push(
      dependency(
        'tool.claude-sdk',
        false,
        'Claude Agent SDK 无法 import 或包版本无法解析',
        claudeRoles,
        '在 Raindown 仓库运行 bun install --frozen-lockfile，确保 @anthropic-ai/claude-agent-sdk 安装完整',
      ),
    )
  }
  const claude = find('claude', env)
  checks.push(
    dependency(
      'tool.claude',
      Boolean(sdk?.cliPath),
      sdk?.cliPath
        ? `SDK 原生 claude CLI 存在：${sdk.cliPath}`
        : `SDK 原生 claude CLI 缺失${claude ? `（PATH 有 ${claude}，SDK 不自动使用它）` : '；PATH 也未找到 claude'}`,
      claudeRoles,
      '重新安装 SDK 的当前平台可选依赖（不要使用 --omit=optional）；doctor 不执行 claude',
    ),
  )

  const userHome = opts.userHome ?? env.HOME ?? homedir()
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(userHome, '.claude')
  const credentialEnv = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ].some((key) => Boolean(env[key]))
  const credentialFile = existsSync(join(configDir, '.credentials.json'))
  const auth = dependency(
    'claude.credentials',
    credentialEnv || credentialFile,
    credentialEnv || credentialFile
      ? 'Claude 凭证来源存在（未验证有效性）'
      : '未发现 Claude 凭证环境变量或 .credentials.json',
    claudeRoles,
    '在节点运行环境配置 Claude 登录或凭证；仅检测存在性，不读取内容、不发起 API 调用',
  )
  // macOS 登录也可能只保存在 Keychain，无法仅通过文件存在性断定未登录。
  if (!auth.ok && (opts.platform ?? process.platform) === 'darwin' && find('security', env)) {
    auth.severity = 'warning'
    auth.message += '；macOS Keychain 登录状态未检查，请人工确认'
  }
  checks.push(auth)
  return checks
}

/**
 * 检查 raindown-home 与外部依赖（raindown-home spec：状态检查）。
 * 有 error 未通过时返回 `doctor_failed` 失败，details 中带完整报告。
 */
export async function runDoctor(
  home: string,
  homeSource: DoctorReport['homeSource'],
  opts: DoctorOptions = {},
): Promise<Result<DoctorReport>> {
  const env = opts.env ?? process.env
  const run = opts.runCommand ?? doctorCommand
  const find = opts.findExecutable ?? findExecutable
  const paths = raindownPaths(home)
  const checks: DoctorCheck[] = []
  if (homeSource === 'FLOW_HOME' || homeSource === 'legacy-default') {
    checks.push({
      id: 'home.legacy',
      ok: false,
      severity: 'warning',
      message: `正在使用旧数据目录（${homeSource === 'FLOW_HOME' ? 'FLOW_HOME' : '~/flow-home'}）：${home}`,
      hint: '确认数据备份后手动迁移到 ~/raindown-home，并使用 RAINDOWN_HOME；不会自动移动或复制数据',
    })
  }

  const gitTool = await checkTool('git', ['--version'], env, run, find)
  const gitleaksTool = await checkTool('gitleaks', ['version'], env, run, find)
  checks.push(gitTool.check, gitleaksTool.check)
  const gitRun = (cwd: string, args: string[]) => run(gitTool.bin ?? 'git', args, { env, cwd })

  checks.push(
    existsSync(home)
      ? { id: 'home', ok: true, message: `raindown-home：${home}` }
      : { id: 'home', ok: false, message: `raindown-home 不存在：${home}`, hint: INIT_HINT },
  )

  for (const sub of ['config', 'brain', 'raw', 'state'] as const) {
    const exists = existsSync(paths[sub])
    checks.push(
      exists
        ? { id: `dir.${sub}`, ok: true, message: `${sub}/ 存在` }
        : { id: `dir.${sub}`, ok: false, message: `缺少 ${sub}/`, hint: INIT_HINT },
    )
  }

  for (const repo of GIT_REPOS) {
    const dir = paths[repo]
    if (!existsSync(dir)) continue
    if (!isRepoRoot(dir) || !gitTool.bin) {
      checks.push({
        id: `repo.${repo}`,
        ok: false,
        message: `${repo}/ 不是 git 仓库${gitTool.bin ? '' : '（无法检查：缺少 git）'}`,
        hint: gitTool.bin ? INIT_HINT : INSTALL_HINTS.git,
      })
      continue
    }
    const committed = (await gitRun(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0
    checks.push(
      committed
        ? { id: `repo.${repo}`, ok: true, message: `${repo}/ 是 git 仓库` }
        : { id: `repo.${repo}`, ok: false, message: `${repo}/ 还没有任何提交`, hint: INIT_HINT },
    )
    const toml = existsSync(join(dir, '.gitleaks.toml'))
    checks.push(
      toml
        ? { id: `gitleaks-config.${repo}`, ok: true, message: `${repo}/.gitleaks.toml 存在` }
        : {
            id: `gitleaks-config.${repo}`,
            ok: false,
            message: `缺少 ${repo}/.gitleaks.toml`,
            hint: INIT_HINT,
          },
    )
    checks.push(await checkHook(repo, dir, gitRun))
  }

  if (existsSync(paths.state) && gitTool.bin) {
    const r = await gitRun(paths.state, ['rev-parse', '--is-inside-work-tree'])
    const inGit = r.code === 0 && r.stdout.trim() === 'true'
    checks.push(
      inGit
        ? {
            id: 'state.untracked',
            ok: false,
            message: 'state/ 位于某个 git 仓库内，但它不应被纳入版本管理',
            hint: '把 raindown-home 移出任何 git 仓库，或删除包含 state/ 的仓库',
          }
        : { id: 'state.untracked', ok: true, message: 'state/ 不在 git 中' },
    )
  }

  for (const [name, p] of [
    ['AGENTS.md', paths.brainAgents],
    ['index.md', paths.brainIndex],
    ['log.md', paths.brainLog],
  ] as const) {
    if (!existsSync(paths.brain)) break
    checks.push(
      existsSync(p)
        ? { id: `brain.${name}`, ok: true, message: `brain/${name} 存在` }
        : { id: `brain.${name}`, ok: false, message: `缺少 brain/${name}`, hint: INIT_HINT },
    )
  }
  // 保留名的大小写变体（`Journal/`、`Index.md`）：不当作条目，写入路径也拒绝产生；已有的提示改名。
  const variants = await reservedNameVariants(paths.brain)
  if (variants.length > 0) {
    checks.push({
      id: 'brain.reserved-names',
      ok: false,
      severity: 'warning',
      message: `brain 中有与保留名只差大小写的目录或文件：${variants.map((v) => `brain/${v}`).join('、')}`,
      hint: '改名或移出 brain/：在不区分大小写的文件系统上它们与 journal/、briefs/、index.md 等保留文件冲突',
    })
  }

  const roles = await loadRoles(home)
  if (!roles.ok) {
    checks.push({ id: 'roles.config', ok: false, message: roles.error.message })
  } else {
    for (const error of roles.data.errors) {
      checks.push({
        id: `roles.config.${error.file}.${error.field ?? ''}`,
        ok: false,
        message: `${error.file}${error.field ? `：${error.field}` : ''}：${error.message}`,
        hint: '修正角色配置后重新运行 raindown doctor',
      })
    }
    for (const role of roles.data.roles) {
      const known = (KNOWN_EXECUTORS as readonly string[]).includes(role.executor)
      checks.push({
        id: `role.${role.name}.executor`,
        ok: known,
        message: `config/roles/${role.name}.yaml：executor ${role.executor}${known ? '' : ' 不存在'}`,
        ...(known ? {} : { hint: `将 executor 改为 ${KNOWN_EXECUTORS.join('、')} 之一` }),
      })
      // supervisor 与 merge 类别的任务由中枢按类别限定创建者（hub / user），不看 creatable_by。
      const byKind = ['supervisor', 'merge'].includes(effectiveRoleKind(role))
      if (!role.creatable_by?.length && !byKind) {
        checks.push({
          id: `role.${role.name}.creatable_by`,
          ok: false,
          severity: 'info',
          message: `config/roles/${role.name}.yaml：creatable_by 缺省或为空，仅 user 可创建该角色的任务`,
          hint: '需要允许本机 AI 身份创建时，加上 creatable_by（例如 ["*"] 或 ["reviewer"]）；见 docs/executors.md',
        })
      }
    }
    for (const role of roles.data.roles) {
      // 只对已知执行器提示；无法确定的沙箱设置在凭证隔离上按 none 处理（worker-credential-isolation 1.3）。
      if (!(KNOWN_EXECUTORS as readonly string[]).includes(role.executor)) continue
      const sandbox = roleSandboxInfo(role)
      if (sandbox.setting || !sandbox.reason || role.executor === 'fake') continue
      checks.push({
        id: `role.${role.name}.sandbox`,
        ok: false,
        severity: 'info',
        message: `config/roles/${role.name}.yaml：无法确定沙箱设置（${sandbox.reason}），凭证隔离按 none 处理`,
        hint: '需要凭证隔离时在 permissions.sandbox 中显式写出 danger-full-access、workspace-write 或 read-only；见 docs/executors.md「凭证隔离声明」',
      })
    }
    checks.push(...checkRoleKinds(roles.data.roles))
  }

  const policies = await loadPoliciesConfig(home)
  if (!policies.ok) {
    checks.push({ id: 'policies.config', ok: false, message: policies.error.message })
  } else {
    checks.push({
      id: 'policies.version',
      ok: true,
      message: `当前策略版本：${policyVersion(policies.data.rules)}`,
    })
    for (const issue of [...policies.data.errors, ...policies.data.warnings]) {
      const warning = policies.data.warnings.includes(issue)
      checks.push({
        id: `policies.config.${issue.rule_index}.${issue.field ?? ''}`,
        ok: false,
        severity: warning ? 'warning' : 'error',
        message: `${issue.file}：${issue.message}`,
        hint: warning
          ? '按提示将旧策略动作改为 Raindown 名称；兼容期间旧规则仍生效'
          : '修正策略配置后重新运行 raindown doctor',
      })
    }
  }

  checks.push(...(await checkWorkspaces(home, roles.ok ? roles.data.roles : undefined)))
  checks.push(...(await checkPatrolRules(home, roles.ok ? roles.data.roles : undefined)))

  checks.push(...(await checkExecutors(roles.ok ? roles.data.roles : [], env, opts, run, find)))

  for (const plist of checkDaemonPlists(opts.launchAgentsDir ?? launchAgentsDirectory())) {
    if (!plist.installed) continue
    checks.push({
      id: `daemon.${plist.label}`,
      ok: !plist.error && plist.bunExists && plist.cliExists,
      message:
        plist.error ??
        `${plist.label}：bun ${plist.bunExists ? '有效' : '失效'}（${plist.bunPath}），入口 ${plist.cliExists ? '有效' : '失效'}（${plist.cliPath}）`,
      hint: '重新运行 raindown daemon install 更新 plist 中的路径',
    })
  }

  for (const plist of checkDaemonPlists(
    opts.launchAgentsDir ?? launchAgentsDirectory(),
    LEGACY_DAEMON_LABELS,
  )) {
    if (!plist.installed) continue
    checks.push({
      id: `daemon.legacy.${plist.label}`,
      ok: false,
      severity: 'warning',
      message: `检测到旧 launchd 服务 ${plist.label}（${plist.plistPath}）`,
      hint: '确认旧服务已停止后运行 raindown daemon install，避免新旧服务同时运行',
    })
  }

  checks.push(
    ...(await isolationSwitchChecks(home, opts.platform ?? process.platform, opts.userHome)),
  )
  if (opts.isolationNodes) checks.push(...(await isolationProbeChecks(opts.isolationNodes)))

  const normalized: DoctorCheck[] = checks.map((c) => ({
    ...c,
    severity: c.severity ?? (c.ok ? 'info' : 'error'),
  }))
  const report: DoctorReport = {
    home,
    homeSource,
    ok: normalized.every((c) => c.ok || c.severity !== 'error'),
    checks: normalized,
  }
  if (!report.ok) return fail('failure', 'doctor_failed', formatDoctorReport(report), report)
  return ok(report)
}

/**
 * 本机节点的外层 seatbelt 开关（`config/node.yaml` 的 `isolation.enforce`，审查第一轮 L3）：
 * 打开但不在 macOS 上时明确提示“未施加”；node.yaml 读取失败由节点启动时报告，这里不重复。
 * 写白名单的追加目录 `isolation.extra_write`（tasks 4.6）不为空时逐条显示，并按受保护的 raindown-home 与持久化位置预先检查
 * （完整检查在每次启动 harness 前计算隔离清单时进行，不合法时任务以 `isolation_extra_write_invalid` 失败）。
 */
export async function isolationSwitchChecks(
  home: string,
  platform: NodeJS.Platform,
  userHome: string = homedir(),
): Promise<DoctorCheck[]> {
  const config = await loadNodeConfig(home)
  if (!config.ok) return []
  const checks: DoctorCheck[] = []
  const extra = config.data.isolation.extra_write
  if (extra.length > 0) {
    const workspaces = await loadWorkspaces(home)
    const checked = await normalizeExtraWrite(extra, {
      userHome,
      protectedPaths: [home],
      registeredRepos: workspaces.ok ? workspaces.data.workspaces.flatMap((w) => w.repos) : [],
      pathEnv: process.env.PATH,
    })
    checks.push(
      checked.ok
        ? {
            id: 'isolation.extra_write',
            ok: true,
            message: `外层 seatbelt 写白名单追加目录（config/node.yaml 的 isolation.extra_write）：${extra.join('、')}`,
          }
        : {
            id: 'isolation.extra_write',
            ok: false,
            severity: 'warning',
            message: `config/node.yaml 的 isolation.extra_write 中的 ${checked.path} 不能放行：${checked.reason}；施加外层 seatbelt 时任务会以 isolation_extra_write_invalid 失败`,
            hint: '只追加工具的缓存或数据子目录，不要追加用户主目录、shell 启动文件、~/.ssh、~/.gitconfig、raindown-home 等位置或它们的祖先',
          },
    )
  }
  if (!config.data.isolation.enforce) return checks
  if (platform !== 'darwin')
    return [
      {
        id: 'isolation.enforce',
        ok: false,
        severity: 'warning',
        message: `config/node.yaml 的 isolation.enforce 已打开，但本机平台（${platform}）不支持外层 seatbelt，未施加任何隔离`,
        hint: '外层 seatbelt 只支持 macOS；Linux 的施加层尚未实现。不需要时把 isolation.enforce 改回 false',
      },
      ...checks,
    ]
  return [
    {
      id: 'isolation.enforce',
      ok: true,
      message:
        'config/node.yaml 的 isolation.enforce 已打开：施加层为 seatbelt 的角色以 sandbox-exec 启动，写入为白名单（是否生效以隔离自检为准）',
    },
    ...checks,
  ]
}

/**
 * 各节点每个执行器 × 沙箱设置的隔离状态（worker-credential-isolation 3.2）：声明的施加层、是否已施加、最近探针时间、
 * 失败项（只列项名与路径，不含内容）、跳过项与未验证项及原因。
 * - 探针不通过：warning（开关 isolation.enforce 关闭时适配器尚未施加隔离，探针预期不通过；不影响退出码）；
 * - 未探测、施加层为 none、通过：info；
 * - 中枢不可用或读取失败：info，说明无法汇总。
 */
export async function isolationProbeChecks(
  loadNodes: () => Promise<Result<{ nodes: NodeView[] }>>,
  now: number = Date.now(),
): Promise<DoctorCheck[]> {
  let loaded: Result<{ nodes: NodeView[] }>
  try {
    loaded = await loadNodes()
  } catch (err) {
    loaded = fail('retryable', 'hub_unavailable', (err as Error).message)
  }
  if (!loaded.ok)
    return [
      {
        id: 'isolation.probe',
        ok: false,
        severity: 'info',
        message: `无法从中枢读取节点的隔离自检结果（${loaded.error.code}）`,
        hint: '启动中枢与节点后重新运行 raindown doctor；也可用 raindown node list 查看',
      },
    ]
  if (loaded.data.nodes.length === 0)
    return [{ id: 'isolation.probe', ok: true, message: '隔离自检：没有已注册的节点' }]
  const checks: DoctorCheck[] = []
  for (const node of loaded.data.nodes) {
    for (const row of isolationStatusRows(node, now)) {
      const [head, ...rest] = describeIsolationStatus(row, '       ')
      const message = [`隔离 ${node.node_id} ${head ?? ''}`, ...rest].join('\n')
      const id = `isolation.${node.node_id}.${row.executor}${row.setting === '—' ? '' : `.${row.setting}`}`
      if (row.probe === 'failed')
        checks.push({
          id,
          ok: false,
          severity: 'warning',
          message,
          // 失败的探针不会让 enforced 为 true；按探针实际运行的施加层区分“已施加但失效”与“尚未施加”。
          hint:
            row.run && row.run.applied_layer !== 'none'
              ? row.run.items.some((i) => i.item === 'connect.orca_port' && i.actual === 'error')
                ? '已施加隔离，但 Orca 本机端口未解析（无法证明 Orca 控制端口被拒绝），不能算已施加：确认 Orca 正在运行后等待下次自检'
                : '已施加隔离但探针不通过，隔离可能失效：检查失败项、macOS 更新与 seatbelt 配置'
              : '适配器尚未施加隔离（config/node.yaml 的 isolation.enforce 为 false、不在 macOS 上或该施加层尚未实现），探针如实报告受保护项可访问',
        })
      else if (row.probe === 'untested')
        checks.push({
          id,
          ok: false,
          severity: 'info',
          message,
          hint: '节点尚未上报探针结果（旧节点或刚启动）；升级并重启节点后会在启动时运行',
        })
      else checks.push({ id, ok: true, message })
    }
  }
  return checks
}

/** supervisor 设置的一行摘要（add-m1-supervisor 1.2：doctor 显示）。 */
export function describeSupervisorConfig(c: SupervisorConfig): string {
  if (!c.enabled) return '未启用'
  const l = c.limits
  return [
    '启用（需要 kind: supervisor 角色才会唤醒）',
    `自动合并 ${c.auto_merge ? '开' : '关'}`,
    `合并方式 ${c.merge_method}`,
    `无检查时${c.allow_no_checks ? '允许' : '不允许'}合并`,
    `审查角色 ${c.reviewer_roles.join('、')}`,
    `代回复 ${c.delegate_replies ? `开（超时 ${c.reply_timeout_s}s）` : '关'}`,
    `observe：代答 ${c.observe.replies ? '开' : '关'}、代批 ${c.observe.approvals ? '开' : '关'}、自主工作 ${c.observe.autonomous ? '开' : '关'}`,
    `上限：每次唤醒 ${l.tasks_per_wake} 个任务，每天 ${l.wakes_per_day} 次唤醒（autonomous ${l.autonomous_wakes_per_day}、reply ${l.reply_wakes_per_day}），链深 ${l.chain_depth}，审查 ${l.review_rounds} 轮，未答提问 ${l.open_questions}`,
  ].join('；')
}

/** github 设置的一行摘要（harness-neutral 8.2：doctor 显示）。 */
export function describeGithubConfig(c: GithubConfig): string {
  const users =
    c.allowed_users === undefined
      ? '缺省为 PR 所属登记仓库 origin 的 owner（仅个人账号；组织或解析不出时为空名单，没有人的评论算请求）'
      : c.allowed_users.length
        ? c.allowed_users.join('、')
        : '空（没有人的评论算请求）'
  return [
    c.watch
      ? '轮询有订阅的 PR（CI、审查与评论直通给订阅的任务）'
      : '不轮询 PR（github.watch: false）',
    `允许名单：${users}；名单外用户与机器人的内容只作为不可信上下文送达运行中的任务`,
    c.worker_identity
      ? `worker 身份：${c.worker_identity}（它发的内容标为 agent，永不算请求）。当前版本该设置不生效：worker 仍以本机 gh 登录发评论；需等 bot 凭证注入`
      : 'worker 身份：未配置',
  ].join('；')
}

/** workspace 定义文件的问题与每个 workspace 的 supervisor 设置。 */
async function checkWorkspaces(home: string, roles?: Role[]): Promise<DoctorCheck[]> {
  const loaded = await loadWorkspaces(home)
  if (!loaded.ok) return [{ id: 'workspaces.config', ok: false, message: loaded.error.message }]
  // 审查角色必须是只读配置（D10）：否则执行器拒绝审查任务、结论不会产生。
  const reviewers: DoctorCheck[] = roles
    ? reviewerRoleIssues(loaded.data.workspaces, roles).map((issue) => ({
        id: `workspaces.config.${issue.file}.${issue.field ?? ''}.${issue.code}`,
        ok: false,
        severity: 'error' as const,
        message: `${issue.file}：${issue.field}：${issue.message}`,
        hint: `审查角色参考 raindown init 生成的 pr-reviewer.yaml（kind: read、setting_sources: []、read_scope: cwd）；${claudeReadHint}`,
      }))
    : []
  const checks: DoctorCheck[] = loaded.data.issues.map((issue) => ({
    id: `workspaces.config.${issue.file}.${issue.field ?? ''}`,
    ok: false,
    message: `${issue.file}${issue.field ? `：${issue.field}` : ''}：${issue.message}`,
    hint: '修正 workspace 配置后重新运行 raindown doctor；有问题的文件不会被加载',
  }))
  for (const issue of loaded.data.warnings) {
    checks.push({
      id: `workspaces.config.${issue.file}.${issue.field ?? ''}`,
      ok: false,
      severity: 'warning',
      message: `${issue.file}${issue.field ? `：${issue.field}` : ''}：${issue.message}（supervisor 视为未启用）`,
      hint: '修正 supervisor 段后重新运行 raindown doctor；该 workspace 其余配置照常生效',
    })
  }
  for (const ws of loaded.data.workspaces) {
    if (ws.file === null) {
      checks.push({
        id: `workspace.${ws.id}.supervisor`,
        ok: true,
        severity: 'info',
        message: `${ws.ref} supervisor：未启用（global 不启用 supervisor，不唤醒、不代回复）`,
      })
      continue
    }
    checks.push({
      id: `workspace.${ws.id}.supervisor`,
      ok: true,
      severity: 'info',
      message: `${ws.ref} supervisor：${describeSupervisorConfig(ws.supervisor)}`,
    })
    if (ws.github.watch || ws.github.allowed_users !== undefined) {
      checks.push({
        id: `workspace.${ws.id}.github`,
        ok: true,
        severity: 'info',
        message: `${ws.ref} github：${describeGithubConfig(ws.github)}`,
      })
    }
    if (ws.github.watch) {
      checks.push({
        id: `workspace.${ws.id}.github_shared_identity`,
        ok: false,
        severity: 'warning',
        message: `${ws.ref} 共享 GitHub 身份：worker 以本机 gh 登录发评论，与允许名单中的你无法区分；当前版本所有 PR 评论一律只作上下文，不恢复已结束任务、不交回、不唤醒 supervisor`,
        hint: '需等后续版本把独立 bot 账号或 App 的凭证注入 worker 后才能解除；github.worker_identity 在当前版本不生效',
      })
    }
    if (ws.github.watch && ws.github.allowed_users === undefined) {
      checks.push({
        id: `workspace.${ws.id}.github_default_users`,
        ok: true,
        severity: 'info',
        message: `${ws.ref} 允许名单取 PR 所属仓库的 owner；owner 是组织时默认名单为空，请在 github.allowed_users 中显式列出`,
      })
    }
    if (ws.github.watch && ws.repos.length === 0) {
      checks.push({
        id: `workspace.${ws.id}.github_repo`,
        ok: false,
        severity: 'warning',
        message: `${ws.ref} 打开了 github.watch 但没有登记仓库：中枢无法确认 PR 所在仓库，不会轮询`,
        hint: `在 config/workspaces/${ws.id}.yaml 的 repos 中登记仓库，或设置 github.watch: false`,
      })
    }
    // 唤醒任务以登记仓库为工作目录：没有仓库时视为不可唤醒（design D3），积压事件会被丢弃。
    if (ws.supervisor.enabled && ws.repos.length === 0) {
      checks.push({
        id: `workspace.${ws.id}.supervisor_repo`,
        ok: false,
        severity: 'warning',
        message: `${ws.ref} 启用了 supervisor 但没有登记仓库：中枢不会唤醒它，期间的指令与事件会被丢弃`,
        hint: `在 config/workspaces/${ws.id}.yaml 的 repos 中登记仓库，或设置 supervisor.enabled: false`,
      })
    }
  }
  checks.push(...reviewers)
  return checks
}

/** 可直接复制进已有 dev.yaml 的片段（design D14：升级用户）。 */
export const DEV_CREATABLE_BY_SNIPPET = `creatable_by:\n  - ${SUPERVISOR_ACTOR}`

/** claude-sdk 角色推断为 read 所需的权限片段（design D9），放在 permissions 下。 */
export const CLAUDE_READ_ONLY_SNIPPET = [
  'permissions:',
  '  setting_sources: []',
  '  disallowedTools:',
  ...CLAUDE_READ_REQUIRED_DISALLOWED.map((t) => `    - ${t}`),
].join('\n')

const codexExecReadHint = `permissions 中写 sandbox: read-only（或不写，缺省即只读）；config 只允许 ${CODEX_EXEC_READ_SAFE_CONFIG_KEYS.join('、')}，其他键（如 notify、mcp_servers.*）一律删除；permissions 不要有 ${CODEX_EXEC_KNOWN_PERMISSION_KEYS.join('、')} 以外的键`

const claudeReadHint = `不设 writable_paths、permissions 只含 ${CLAUDE_SDK_KNOWN_PERMISSION_KEYS.join('、')}、不允许写工具与 Bash 规则，并确保 permissions 包含（已有列表时合并）：\n${CLAUDE_READ_ONLY_SNIPPET}`

/** 角色有效类别（design D9）、supervisor 唯一且只读、dev 的 creatable_by 升级提示。 */
function checkRoleKinds(roles: Role[]): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  for (const role of roles) {
    const inferred = inferRoleKind(role)
    const effective = effectiveRoleKind(role)
    const file = `config/roles/${role.name}.yaml`
    const loosened = role.kind !== undefined && role.kind !== effective
    checks.push({
      id: `role.${role.name}.kind`,
      ok: !loosened,
      severity: loosened ? 'warning' : 'info',
      message: loosened
        ? `${file}：声明 kind: ${role.kind} 比按配置推断的 ${inferred} 宽松，声明只能收紧，有效类别为 ${effective}`
        : `${file}：有效类别 ${effective}（推断 ${inferred}${role.kind ? `，声明 ${role.kind}` : ''}）`,
      ...(loosened
        ? {
            hint:
              role.executor === 'claude-sdk' && role.kind === 'read'
                ? claudeReadHint
                : role.executor === 'codex-exec' && role.kind === 'read'
                  ? codexExecReadHint
                  : `删除 kind 或改为 ${effective}；要降低类别，请收紧执行器权限配置`,
          }
        : {}),
    })
  }
  const supervisor = findSupervisorRole(roles)
  if (!supervisor.ok) {
    const writable = supervisor.error.code === 'supervisor_role_not_read'
    checks.push({
      id: 'roles.supervisor',
      ok: false,
      severity: 'error',
      message: `${supervisor.error.message}；中枢不会唤醒 supervisor`,
      hint: writable
        ? `supervisor 只应有 Read、Grep、Glob 与 Raindown MCP，并设 read_scope: cwd（参考 raindown init 生成的 supervisor.yaml）；${claudeReadHint}`
        : '只保留一个 kind: supervisor 角色',
    })
    if (!writable) return checks
  }
  const hasSupervisor = roles.some((r) => effectiveRoleKind(r) === 'supervisor')
  const dev = roles.find((r) => r.name === 'dev')
  if (hasSupervisor && dev && !canCreateRole(dev, SUPERVISOR_ACTOR)) {
    checks.push({
      id: 'role.dev.supervisor',
      ok: false,
      severity: 'warning',
      message:
        'config/roles/dev.yaml：creatable_by 不包含 supervisor，supervisor 无法创建 dev 任务',
      hint: `在 dev.yaml 中加入（已有 creatable_by 时把 supervisor 追加到列表）：\n${DEV_CREATABLE_BY_SNIPPET}`,
    })
  }
  return checks
}

async function checkHook(
  repo: string,
  dir: string,
  gitRun: (cwd: string, args: string[]) => ReturnType<typeof execCommand>,
): Promise<DoctorCheck> {
  const id = `hook.${repo}`
  const r = await gitRun(dir, ['rev-parse', '--git-path', 'hooks/pre-commit'])
  const path = r.stdout.trim()
  const p =
    r.code === 0
      ? path.startsWith('/')
        ? path
        : join(dir, path)
      : join(dir, '.git', 'hooks', 'pre-commit')
  if (!existsSync(p)) {
    return {
      id,
      ok: false,
      message: `${repo}/ 没有安装提交前密钥扫描钩子（${p}）`,
      hint: INIT_HINT,
    }
  }
  try {
    accessSync(p, constants.X_OK)
  } catch {
    return {
      id,
      ok: false,
      message: `${repo}/ 的提交前钩子不可执行（${p}）`,
      hint: `chmod +x ${p}`,
    }
  }
  const content = readFileSync(p, 'utf8')
  if (!content.includes('gitleaks')) {
    return {
      id,
      ok: false,
      message: `${repo}/ 的提交前钩子没有调用 gitleaks（${p}）`,
      hint: '在钩子中加入：gitleaks git --pre-commit --staged --redact --verbose .',
    }
  }
  return { id, ok: true, message: `${repo}/ 已安装提交前密钥扫描钩子` }
}

export function formatDoctorReport(r: DoctorReport): string {
  const sources: Record<RaindownHomeSource, string> = {
    RAINDOWN_HOME: 'RAINDOWN_HOME',
    FLOW_HOME: 'FLOW_HOME',
    default: '~/raindown-home（默认）',
    'legacy-default': '~/flow-home（旧默认）',
  }
  const lines = [`raindown-home：${r.home}（来源：${sources[r.homeSource]}）`]
  for (const c of r.checks) {
    const tag = c.ok
      ? '[ok]  '
      : c.severity === 'warning'
        ? '[warn]'
        : c.severity === 'info'
          ? '[info]'
          : '[fail]'
    lines.push(`${tag} ${c.message}`)
    // 多行提示（例如可复制的 yaml 片段）的后续行与首行对齐。
    if (!c.ok && c.hint) lines.push(`       修复：${c.hint.split('\n').join('\n         ')}`)
  }
  const errors = r.checks.filter((c) => !c.ok && (c.severity ?? 'error') === 'error').length
  const warnings = r.checks.filter((c) => !c.ok && c.severity === 'warning').length
  lines.push(
    `${r.ok ? '全部检查通过' : `${errors} 项未通过`}${warnings ? `（${warnings} 项警告）` : ''}`,
  )
  return lines.join('\n')
}
