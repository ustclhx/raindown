import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePlist } from '../src/daemon/plist.ts'
import {
  runDoctor as actualDoctor,
  CLAUDE_READ_ONLY_SNIPPET,
  compareVersions,
  DEV_CREATABLE_BY_SNIPPET,
  type DoctorOptions,
  type DoctorReport,
  findExecutable,
  formatDoctorReport,
} from '../src/doctor.ts'
import { initRaindownHome } from '../src/init.ts'
import { loadPoliciesConfig } from '../src/policy/config.ts'
import { policyVersion } from '../src/policy/version.ts'
import { doctorOptions } from './doctor-helpers.ts'
import { tempHome, writeText } from './helpers.ts'

/** 只包含 git 的 PATH，用来模拟未安装 gitleaks。 */
function pathWithoutGitleaks(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raindown-path-'))
  const gitBin = findExecutable('git')
  if (!gitBin) throw new Error('测试需要 git')
  symlinkSync(gitBin, join(dir, 'git'))
  return dir
}

const reportOf = (r: Awaited<ReturnType<typeof runDoctor>>): DoctorReport =>
  r.ok ? r.data : (r.error.details as DoctorReport)

/** 未通过且不是 info 提示的检查。 */
const failed = (r: DoctorReport) =>
  r.checks.filter((c) => !c.ok && c.severity !== 'info').map((c) => c.id)
const runDoctor = (home: string, source: DoctorReport['homeSource'], options: DoctorOptions = {}) =>
  actualDoctor(home, source, doctorOptions(home, options))

describe('raindown doctor', () => {
  test('显示从当前有效规则计算的策略版本', async () => {
    const home = tempHome('raindown-doctor-policy-version-')
    writeText(
      join(home, 'config/policies.yaml'),
      '- scope: "*"\n  action: shell.exec\n  level: notify\n',
    )
    const loaded = await loadPoliciesConfig(home)
    if (!loaded.ok) throw new Error(loaded.error.message)
    const version = policyVersion(loaded.data.rules)
    const report = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
    expect(report.checks.find((check) => check.id === 'policies.version')).toMatchObject({
      ok: true,
      message: `当前策略版本：${version}`,
    })
    expect(formatDoctorReport(report)).toContain(`当前策略版本：${version}`)
  })

  test('执行器未知：报告角色文件和 executor，已知执行器全部通过；配置错误带字段', async () => {
    const home = tempHome('raindown-doctor-roles-')
    await initRaindownHome(home)
    writeText(join(home, 'config/roles/fake.yaml'), 'name: fake\nexecutor: fake\nprompt: 测试\n')
    writeText(
      join(home, 'config/roles/custom.yaml'),
      'name: custom\nexecutor: gpt-cli\nprompt: 测试\n',
    )
    writeText(join(home, 'config/roles/broken.yaml'), 'name: broken\nprompt: 测试\n')
    const result = await runDoctor(home, 'RAINDOWN_HOME')
    expect(result.ok).toBe(false)
    const report = reportOf(result)
    const unknown = report.checks.find((c) => c.id === 'role.custom.executor')
    expect(unknown).toMatchObject({ ok: false })
    expect(unknown?.message).toContain('config/roles/custom.yaml：executor gpt-cli 不存在')
    expect(
      report.checks.filter((c) => /^role\.(dev|reviewer|triage|fake)\.executor$/.test(c.id)),
    ).toEqual(
      expect.arrayContaining(
        ['dev', 'reviewer', 'triage', 'fake'].map((name) =>
          expect.objectContaining({ id: `role.${name}.executor`, ok: true }),
        ),
      ),
    )
    expect(
      report.checks.find((c) => c.id === 'roles.config.config/roles/broken.yaml.executor'),
    ).toMatchObject({ ok: false, message: expect.stringContaining('executor') })
  })

  test('角色 creatable_by 缺省或为空：中性 info 提示；非空列表不提示', async () => {
    const home = tempHome('raindown-doctor-roles-')
    await initRaindownHome(home)
    writeText(
      join(home, 'config/roles/empty.yaml'),
      'name: empty\nexecutor: fake\nprompt: 测试\ncreatable_by: []\n',
    )
    const report = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
    const hints = report.checks.filter((c) => c.id.endsWith('.creatable_by'))
    // 缺省与显式空数组的行为一致。
    // 默认模板都写了 creatable_by，或按类别限定创建者（supervisor、merger），不提示。
    expect(hints).toEqual([
      expect.objectContaining({
        id: 'role.empty.creatable_by',
        severity: 'info',
        message: expect.stringContaining('仅 user 可创建'),
      }),
    ])
    expect(formatDoctorReport(report)).toContain(
      '[info] config/roles/empty.yaml：creatable_by 缺省或为空，仅 user 可创建',
    )
  })

  test('无法确定沙箱设置的角色给出 info 提示（凭证隔离按 none）；默认模板不提示', async () => {
    const home = tempHome('raindown-doctor-sandbox-')
    await initRaindownHome(home)
    writeText(
      join(home, 'config/roles/profiled.yaml'),
      'name: profiled\nexecutor: codex-orca\nprompt: 测试\npermissions:\n  config:\n    profile: dev\n',
    )
    writeText(
      join(home, 'config/roles/quoted.yaml'),
      'name: quoted\nexecutor: codex-orca\nprompt: 测试\npermissions:\n  config:\n    sandbox_mode: \'"danger-full-access"\'\n',
    )
    const report = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
    const hints = report.checks.filter((c) => c.id.endsWith('.sandbox'))
    expect(hints).toEqual([
      expect.objectContaining({
        id: 'role.profiled.sandbox',
        severity: 'info',
        message: expect.stringContaining('config.profile'),
      }),
    ])
    expect(report.ok).toBe(true)
  })

  test('显示每个角色的有效类别；声明放宽时给出警告', async () => {
    const home = tempHome('raindown-doctor-kind-')
    await initRaindownHome(home)
    writeText(
      join(home, 'config/roles/loose.yaml'),
      'name: loose\nexecutor: codex-orca\nkind: read\nprompt: 测试\n',
    )
    const report = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
    const kinds = Object.fromEntries(
      report.checks.filter((c) => c.id.endsWith('.kind')).map((c) => [c.id, c]),
    )
    expect(Object.keys(kinds).sort()).toEqual(
      ['dev', 'loose', 'merger', 'pr-reviewer', 'reviewer', 'supervisor', 'triage'].map(
        (n) => `role.${n}.kind`,
      ),
    )
    expect(kinds['role.reviewer.kind']).toMatchObject({
      ok: true,
      message: 'config/roles/reviewer.yaml：有效类别 write（推断 write）',
    })
    expect(kinds['role.supervisor.kind']).toMatchObject({
      ok: true,
      message: 'config/roles/supervisor.yaml：有效类别 supervisor（推断 read，声明 supervisor）',
    })
    expect(kinds['role.triage.kind']?.message).toContain('有效类别 read')
    expect(kinds['role.merger.kind']?.message).toContain('有效类别 merge')
    expect(kinds['role.loose.kind']).toMatchObject({ ok: false, severity: 'warning' })
    expect(kinds['role.loose.kind']?.message).toContain('声明 kind: read 比按配置推断的 write 宽松')
    expect(failed(report)).toContain('role.loose.kind')
    // 默认模板之间没有 supervisor 冲突，也不需要 dev 升级提示。
    expect(report.checks.some((c) => c.id === 'roles.supervisor')).toBe(false)
    expect(report.checks.some((c) => c.id === 'role.dev.supervisor')).toBe(false)
    expect(formatDoctorReport(report)).toContain('[warn] config/roles/loose.yaml：声明 kind: read')
  })

  test('第二个 kind: supervisor 角色（名字不是 supervisor）：角色配置报错', async () => {
    const home = tempHome('raindown-doctor-kind-')
    await initRaindownHome(home)
    writeText(
      join(home, 'config/roles/boss.yaml'),
      'name: boss\nexecutor: claude-sdk\nkind: supervisor\nprompt: 测试\n',
    )
    const result = await runDoctor(home, 'RAINDOWN_HOME')
    const report = reportOf(result)
    const check = report.checks.find((c) => c.id === 'roles.config.config/roles/boss.yaml.name')
    expect(check).toMatchObject({ ok: false, severity: 'error' })
    expect(check?.message).toContain('必须是小写 supervisor')
    expect(result.ok).toBe(false)
  })

  test('名为 supervisor 但类别不是 supervisor：角色配置报错', async () => {
    const home = tempHome('raindown-doctor-kind-')
    await initRaindownHome(home)
    writeText(
      join(home, 'config/roles/supervisor.yaml'),
      'name: supervisor\nexecutor: claude-sdk\nprompt: 测试\n',
    )
    const report = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
    expect(
      report.checks.find((c) => c.id === 'roles.config.config/roles/supervisor.yaml.name'),
    ).toMatchObject({ ok: false, message: expect.stringContaining('保留身份') })
  })

  test('supervisor 角色可写（写工具、未禁用写工具或加载项目设置）：doctor 报错并附片段', async () => {
    const home = tempHome('raindown-doctor-kind-')
    await initRaindownHome(home)
    for (const permissions of [
      '  setting_sources: []\n  disallowedTools: [Bash, Edit, Write, MultiEdit, NotebookEdit]\n  allowedTools: ["Bash(git status)"]\n',
      '  setting_sources: []\n  disallowedTools: [Bash, Edit, Write, MultiEdit, NotebookEdit]\n  writable_paths: ["docs/**"]\n',
      '  disallowedTools: [Bash, Edit, Write, MultiEdit, NotebookEdit]\n',
      '  setting_sources: []\n  disallowedTools: [Bash, Edit, Write, NotebookEdit]\n',
    ]) {
      writeText(
        join(home, 'config/roles/supervisor.yaml'),
        `name: supervisor\nkind: supervisor\nexecutor: claude-sdk\nprompt: 测试\npermissions:\n${permissions}`,
      )
      const result = await runDoctor(home, 'RAINDOWN_HOME')
      const check = reportOf(result).checks.find((c) => c.id === 'roles.supervisor')
      expect(check).toMatchObject({ ok: false, severity: 'error' })
      expect(check?.message).toContain('中枢不会唤醒 supervisor')
      expect(check?.hint).toContain(CLAUDE_READ_ONLY_SNIPPET)
      expect(result.ok).toBe(false)
    }
  })

  test('claude-sdk 角色声明 read 但推断为 write：警告并附只读片段', async () => {
    const home = tempHome('raindown-doctor-kind-')
    await initRaindownHome(home)
    writeText(
      join(home, 'config/roles/looker.yaml'),
      'name: looker\nkind: read\nexecutor: claude-sdk\nprompt: 测试\n',
    )
    const check = reportOf(await runDoctor(home, 'RAINDOWN_HOME')).checks.find(
      (c) => c.id === 'role.looker.kind',
    )
    expect(check).toMatchObject({ ok: false, severity: 'warning' })
    expect(check?.hint).toContain(
      'permissions:\n  setting_sources: []\n  disallowedTools:\n    - Bash\n    - Edit\n    - Write\n    - MultiEdit\n    - NotebookEdit',
    )
  })

  test('codex-exec 角色声明 read 但推断为 write：提示 sandbox 与 config 白名单', async () => {
    const home = tempHome('raindown-doctor-kind-')
    await initRaindownHome(home)
    writeText(
      join(home, 'config/roles/scan.yaml'),
      'name: scan\nkind: read\nexecutor: codex-exec\nprompt: 测试\npermissions:\n  sandbox: workspace-write\n  config:\n    notify: say\n',
    )
    const check = reportOf(await runDoctor(home, 'RAINDOWN_HOME')).checks.find(
      (c) => c.id === 'role.scan.kind',
    )
    expect(check).toMatchObject({ ok: false, severity: 'warning' })
    expect(check?.hint).toContain('sandbox: read-only')
    expect(check?.hint).toContain('config 只允许 model、model_reasoning_effort')
  })

  test('已有用户升级：dev.yaml 没有 creatable_by 且存在 supervisor 角色时给出可复制片段', async () => {
    const home = tempHome('raindown-doctor-kind-')
    await initRaindownHome(home)
    const devYaml = 'name: dev\nexecutor: codex-orca\nprompt: dev.md\n'
    writeText(join(home, 'config/roles/dev.yaml'), devYaml)
    const report = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
    const check = report.checks.find((c) => c.id === 'role.dev.supervisor')
    expect(check).toMatchObject({ ok: false, severity: 'warning' })
    expect(check?.message).toContain('supervisor 无法创建 dev 任务')
    expect(check?.hint).toContain('creatable_by:\n  - supervisor')
    expect(formatDoctorReport(report)).toContain('         creatable_by:\n           - supervisor')
    // 片段追加到 dev.yaml 后即可通过，并能被加载。
    writeText(join(home, 'config/roles/dev.yaml'), `${devYaml}${DEV_CREATABLE_BY_SNIPPET}\n`)
    const fixed = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
    expect(fixed.checks.some((c) => c.id === 'role.dev.supervisor')).toBe(false)
    expect(fixed.checks.some((c) => c.id.startsWith('roles.config.'))).toBe(false)

    // 没有 supervisor 角色时不提示。
    rmSync(join(home, 'config/roles/supervisor.yaml'))
    writeText(join(home, 'config/roles/dev.yaml'), devYaml)
    const none = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
    expect(none.checks.some((c) => c.id === 'role.dev.supervisor')).toBe(false)
  })

  test('reviewer_roles 中的角色不是只读配置：doctor 报 error；默认 pr-reviewer 通过', async () => {
    const home = tempHome('raindown-doctor-reviewers-')
    await initRaindownHome(home)
    writeText(
      join(home, 'config/workspaces/demo.yaml'),
      'id: demo\nname: Demo\ndescription: 测试\nkind: product\nrepos: []\nsupervisor:\n  reviewer_roles: [pr-reviewer, reviewer]\n',
    )
    const report = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
    const errors = report.checks.filter((c) => c.id.endsWith('.review_role_not_read'))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ ok: false, severity: 'error' })
    expect(errors[0]?.message).toContain('审查角色 reviewer')
  })

  test('已安装 plist 的 bun 或入口失效时报错并提示重新安装；有效路径通过', async () => {
    const home = tempHome('raindown-doctor-')
    await initRaindownHome(home)
    const directory = join(home, 'LaunchAgents')
    mkdirSync(directory)
    const bunPath = join(home, 'bun & <test>')
    const cliPath = join(home, 'main.ts')
    const plist = generatePlist({
      label: 'dev.raindown.hub',
      bunPath,
      cliPath,
      command: ['hub', 'start'],
      home,
      logPath: join(home, 'hub.log'),
      path: '/usr/bin',
    })
    writeFileSync(join(directory, 'dev.raindown.hub.plist'), plist)
    const report = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
    const check = report.checks.find((c) => c.id === 'daemon.dev.raindown.hub')
    expect(check?.ok).toBe(false)
    expect(check?.message).toContain('bun 失效')
    expect(check?.message).toContain('入口 失效')
    expect(check?.hint).toContain('raindown daemon install')
    writeFileSync(bunPath, '')
    writeFileSync(cliPath, '')
    expect(
      reportOf(await runDoctor(home, 'RAINDOWN_HOME')).checks.find((c) => c.id === check?.id)?.ok,
    ).toBe(true)
  })

  test('损坏的 plist 不会静默跳过，未安装的服务不要求安装', async () => {
    const home = tempHome('raindown-doctor-')
    mkdirSync(join(home, 'LaunchAgents'), { recursive: true })
    writeFileSync(join(home, 'LaunchAgents', 'dev.raindown.node.plist'), 'broken plist')
    const checks = reportOf(await runDoctor(home, 'RAINDOWN_HOME')).checks.filter((c) =>
      c.id.startsWith('daemon.'),
    )
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ id: 'daemon.dev.raindown.node', ok: false })
    expect(checks[0]?.hint).toContain('raindown daemon install')
  })

  test('缺少密钥扫描工具：指出缺失的工具与安装方式，非零退出', async () => {
    const home = tempHome('raindown-doctor-')
    expect((await initRaindownHome(home)).ok).toBe(true)
    const r = await runDoctor(home, 'RAINDOWN_HOME', { env: { PATH: pathWithoutGitleaks() } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('doctor_failed')
    expect(!r.ok && r.error.kind).toBe('failure')
    const report = reportOf(r)
    expect(failed(report)).toEqual(['tool.gitleaks'])
    const check = report.checks.find((c) => c.id === 'tool.gitleaks')
    expect(check?.message).toContain('未找到 gitleaks')
    expect(check?.hint).toContain('brew install gitleaks')
    expect(!r.ok && r.error.message).toContain('brew install gitleaks')
  })

  test.skipIf(!findExecutable('gitleaks'))('初始化完整时全部通过', async () => {
    const home = tempHome('raindown-doctor-')
    await initRaindownHome(home)
    const r = await runDoctor(home, 'RAINDOWN_HOME')
    expect(r.ok ? [] : failed(reportOf(r))).toEqual([])
    expect(r.ok && r.data.home).toBe(home)
  })

  test('缺少钩子或钩子不可执行时失败，并提示修复', async () => {
    const home = tempHome('raindown-doctor-')
    await initRaindownHome(home)
    rmSync(join(home, 'brain', '.git', 'hooks', 'pre-commit'))
    chmodSync(join(home, 'raw', '.git', 'hooks', 'pre-commit'), 0o644)
    const report = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
    expect(failed(report).filter((id) => id.startsWith('hook.'))).toEqual([
      'hook.brain',
      'hook.raw',
    ])
    expect(report.checks.find((c) => c.id === 'hook.brain')?.hint).toContain('raindown init')
  })

  test('未初始化时报告缺失的目录', async () => {
    const report = reportOf(await runDoctor(tempHome('raindown-doctor-'), 'default'))
    expect(report.ok).toBe(false)
    expect(failed(report)).toEqual(
      expect.arrayContaining(['home', 'dir.config', 'dir.brain', 'dir.raw', 'dir.state']),
    )
  })

  test('缺少 brain 固定文件与 .gitleaks.toml 时失败', async () => {
    const home = tempHome('raindown-doctor-')
    await initRaindownHome(home)
    rmSync(join(home, 'brain', 'log.md'))
    rmSync(join(home, 'config', '.gitleaks.toml'))
    const ids = failed(reportOf(await runDoctor(home, 'RAINDOWN_HOME')))
    expect(ids).toEqual(expect.arrayContaining(['brain.log.md', 'gitleaks-config.config']))
  })
})

test('compareVersions', () => {
  expect(compareVersions('8.30.1', '8.19.0')).toBeGreaterThan(0)
  expect(compareVersions('2.39.5', '2.40.0')).toBeLessThan(0)
  expect(compareVersions('2.28', '2.28.0')).toBe(0)
})

test('非法角色身份在配置阶段报 error，不作为可执行角色加载', async () => {
  const home = tempHome('raindown-doctor-role-actors-')
  await initRaindownHome(home)
  for (const name of ['user', 'POLICY', 'node:n1', 'bad name']) {
    writeText(
      join(home, 'config/roles', `${name}.yaml`),
      JSON.stringify({ name, executor: 'fake', prompt: '测试' }),
    )
  }
  const report = reportOf(await runDoctor(home, 'RAINDOWN_HOME'))
  expect(report.ok).toBe(false)
  for (const name of ['user', 'POLICY', 'node:n1', 'bad name']) {
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: `roles.config.config/roles/${name}.yaml.name`,
        ok: false,
        severity: 'error',
        message: expect.stringContaining('角色名必须是合法且可声明的 AI 身份'),
      }),
    )
    expect(report.checks.some((c) => c.id === `role.${name}.executor`)).toBe(false)
  }
})

test('旧目录、旧策略与旧 launchd 只给迁移警告，并显示四种目录来源', async () => {
  const home = tempHome('raindown-doctor-legacy-')
  await initRaindownHome(home)
  writeText(
    join(home, 'config/policies.yaml'),
    '- scope: "*"\n  action: flow.admin\n  level: auto\n',
  )
  writeText(
    join(home, 'LaunchAgents/dev.flow.hub.plist'),
    generatePlist({
      label: 'dev.flow.hub',
      bunPath: process.execPath,
      cliPath: join(home, 'old-entry.ts'),
      command: ['hub', 'start'],
      home,
      logPath: join(home, 'hub.log'),
      path: '/usr/bin',
    }),
  )
  const report = reportOf(await runDoctor(home, 'FLOW_HOME'))
  expect(report.checks.find((check) => check.id === 'home.legacy')).toMatchObject({
    severity: 'warning',
  })
  expect(report.checks.find((check) => check.id.startsWith('policies.config.'))).toMatchObject({
    severity: 'warning',
  })
  expect(report.checks.find((check) => check.id === 'daemon.legacy.dev.flow.hub')).toMatchObject({
    severity: 'warning',
  })
  expect(report.checks.filter((check) => check.severity === 'error' && !check.ok)).toEqual([])
  for (const [homeSource, source] of [
    ['RAINDOWN_HOME', 'RAINDOWN_HOME'],
    ['FLOW_HOME', 'FLOW_HOME'],
    ['default', '~/raindown-home（默认）'],
    ['legacy-default', '~/flow-home（旧默认）'],
  ] as const) {
    expect(formatDoctorReport({ ...report, homeSource })).toContain(`来源：${source}`)
  }
})
