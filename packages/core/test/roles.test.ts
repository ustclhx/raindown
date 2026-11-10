import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { exitCodeOf, type Result } from '../src/result.ts'
import { DEFAULT_ROLE_FILES } from '../src/role-templates.ts'
import {
  actorMatches,
  CODEX_EXEC_READ_SAFE_CONFIG_KEYS,
  canCreateRole,
  effectiveRoleKind,
  findSupervisorRole,
  inferRoleKind,
  loadRoles,
  type Role,
  roleIsolationOf,
  roleSchema,
  supervisorRoleProblem,
} from '../src/roles.ts'
import { jsonSchemas } from '../src/schema/index.ts'
import { tempHome, writeText } from './helpers.ts'

const data = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}
const role = { name: 'dev', executor: 'fake', prompt: '完成任务并报告结果' }

describe('角色配置', () => {
  test('内联提示词、全部可选字段和执行器专用权限内容原样保留', async () => {
    const home = tempHome('raindown-roles-')
    const configured = {
      ...role,
      model: 'custom-model',
      effort: 'high',
      permissions: { sandbox: 'read-only', nested: { tools: ['Read'], enabled: true } },
      no_progress_minutes: 15,
    }
    writeText(join(home, 'config/roles/dev.yaml'), stringify(configured))
    expect(data(await loadRoles(home))).toEqual({ roles: [configured], errors: [] })
  })

  test('引用 Markdown 提示词：读取同目录文件', async () => {
    const home = tempHome('raindown-roles-')
    const prompt = '# 开发角色\n完成任务并运行验收。\n'
    writeText(join(home, 'config/roles/dev.yaml'), stringify({ ...role, prompt: 'dev.md' }))
    writeText(join(home, 'config/roles/dev.md'), prompt)
    expect(data(await loadRoles(home))).toEqual({
      roles: [{ ...role, prompt }],
      errors: [],
    })
  })

  test('提示词文件缺失时报 prompt_file_missing，不加载该角色且不影响其他角色', async () => {
    const home = tempHome('raindown-roles-')
    writeText(join(home, 'config/roles/dev.yaml'), stringify({ ...role, prompt: 'dev.md' }))
    writeText(join(home, 'config/roles/triage.yaml'), stringify({ ...role, name: 'triage' }))
    expect(data(await loadRoles(home))).toEqual({
      roles: [{ ...role, name: 'triage' }],
      errors: [
        {
          file: 'config/roles/dev.yaml',
          field: 'prompt',
          code: 'prompt_file_missing',
          message: '提示词文件 dev.md 不存在',
        },
      ],
    })
  })

  test('只解析同目录文件名，不读取路径指向的 Markdown', async () => {
    const home = tempHome('raindown-roles-')
    writeText(join(home, 'config/outside.md'), '目录外提示词')
    writeText(join(home, 'config/roles/dev.yaml'), stringify({ ...role, prompt: '../outside.md' }))
    expect(data(await loadRoles(home)).roles[0]?.prompt).toBe('../outside.md')
  })

  test('目录缺失返回空集，目录无法读取返回失败', async () => {
    const home = tempHome('raindown-roles-')
    expect(data(await loadRoles(home))).toEqual({ roles: [], errors: [] })
    writeText(join(home, 'config/roles'), '不是目录')
    const result = await loadRoles(home)
    expect(result).toMatchObject({ ok: false, error: { code: 'read_failed' } })
    expect(exitCodeOf(result)).toBe(1)
  })

  test('逐文件隔离 YAML、字段与读取错误，保留合法角色并报告文件和字段', async () => {
    const home = tempHome('raindown-roles-')
    const dir = join(home, 'config/roles')
    writeText(join(dir, 'dev.yaml'), stringify(role))
    writeText(join(dir, 'broken.yaml'), 'name: [\n')
    writeText(join(dir, 'invalid.yaml'), 'name: invalid\npermissions: []\n')
    writeText(join(dir, 'mismatch.yaml'), stringify({ ...role, name: 'other' }))
    writeText(
      join(dir, 'unreadable-prompt.yaml'),
      stringify({
        ...role,
        name: 'unreadable-prompt',
        prompt: 'directory.md',
      }),
    )
    mkdirSync(join(dir, 'directory.md'))
    mkdirSync(join(dir, 'unreadable.yaml'))
    const loaded = data(await loadRoles(home))
    expect(loaded.roles).toEqual([role])
    expect(loaded.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'config/roles/broken.yaml', code: 'invalid_yaml' }),
        expect.objectContaining({
          file: 'config/roles/invalid.yaml',
          field: 'executor',
          code: 'missing_field',
        }),
        expect.objectContaining({
          file: 'config/roles/invalid.yaml',
          field: 'prompt',
          code: 'missing_field',
        }),
        expect.objectContaining({
          file: 'config/roles/invalid.yaml',
          field: 'permissions',
          code: 'invalid_field',
        }),
        expect.objectContaining({
          file: 'config/roles/mismatch.yaml',
          field: 'name',
          code: 'role_name_mismatch',
        }),
        expect.objectContaining({
          file: 'config/roles/unreadable-prompt.yaml',
          field: 'prompt',
          code: 'read_failed',
        }),
        expect.objectContaining({ file: 'config/roles/unreadable.yaml', code: 'read_failed' }),
      ]),
    )
    expect(loaded.errors).toHaveLength(7)
  })

  test('schema 校验必填字段、可选类型和正整数阈值，permissions 只要求对象', () => {
    expect(roleSchema.safeParse({ ...role, executor: 'gpt-cli' }).success).toBe(true)
    for (const field of ['name', 'executor', 'prompt'] as const) {
      const { [field]: _omitted, ...missing } = role
      expect(roleSchema.safeParse(missing).success).toBe(false)
      expect(roleSchema.safeParse({ ...role, [field]: '' }).success).toBe(false)
    }
    for (const invalid of [
      { model: 123 },
      { effort: false },
      { permissions: [] },
      { permissions: null },
      { permissions: 'read-only' },
      { no_progress_minutes: 0 },
      { no_progress_minutes: -1 },
      { no_progress_minutes: 1.5 },
      { no_progress_minutes: '15' },
    ]) {
      expect(roleSchema.safeParse({ ...role, ...invalid }).success).toBe(false)
    }
    expect(roleSchema.safeParse({ ...role, permisions: {} }).success).toBe(false)
    expect(
      roleSchema.safeParse({
        ...role,
        executor: 'claude-sdk',
        permissions: { writable_paths: ['docs/**', '**/*.md'] },
      }).success,
    ).toBe(true)
    expect(
      roleSchema.safeParse({ ...role, permissions: { writable_paths: 'docs/**' } }).success,
    ).toBe(false)
    const exported = jsonSchemas()['config/role.schema.json'] as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(exported.required).toEqual(['name', 'executor', 'prompt'])
    expect(Object.keys(exported.properties)).toEqual([
      'name',
      'executor',
      'kind',
      'prompt',
      'model',
      'effort',
      'permissions',
      'no_progress_minutes',
      'creatable_by',
      'isolation',
    ])
  })

  test('writable_paths 只属于 claude-sdk；其他执行器加载时报告字段错误', async () => {
    const home = tempHome('raindown-role-writable-')
    for (const executor of ['codex-orca', 'codex-exec']) {
      writeText(
        join(home, 'config/roles', `${executor}.yaml`),
        stringify({
          ...role,
          name: executor,
          executor,
          permissions: { writable_paths: [] },
        }),
      )
    }
    const loaded = data(await loadRoles(home))
    expect(loaded.roles).toEqual([])
    expect(loaded.errors).toEqual(
      ['codex-exec', 'codex-orca'].map((executor) =>
        expect.objectContaining({
          file: `config/roles/${executor}.yaml`,
          field: 'permissions.writable_paths',
          code: 'invalid_field',
          message: '字段 permissions.writable_paths：writable_paths 仅适用于 claude-sdk 执行器',
        }),
      ),
    )
  })

  test('read_scope 只接受 cwd 且只属于 claude-sdk', async () => {
    const sdk = { ...role, executor: 'claude-sdk' }
    expect(roleSchema.safeParse({ ...sdk, permissions: { read_scope: 'cwd' } }).success).toBe(true)
    for (const read_scope of ['home', '', true, ['cwd']])
      expect(roleSchema.safeParse({ ...sdk, permissions: { read_scope } }).success).toBe(false)
    const home = tempHome('raindown-role-read-scope-')
    for (const executor of ['codex-orca', 'codex-exec']) {
      writeText(
        join(home, 'config/roles', `${executor}.yaml`),
        stringify({ ...role, name: executor, executor, permissions: { read_scope: 'cwd' } }),
      )
    }
    const loaded = data(await loadRoles(home))
    expect(loaded.roles).toEqual([])
    expect(loaded.errors).toEqual(
      ['codex-exec', 'codex-orca'].map((executor) =>
        expect.objectContaining({
          file: `config/roles/${executor}.yaml`,
          field: 'permissions.read_scope',
          code: 'invalid_field',
          message: '字段 permissions.read_scope：read_scope 仅适用于 claude-sdk 执行器',
        }),
      ),
    )
  })
})

describe('creatable_by（角色创建权限）', () => {
  test('精确值、前缀通配与 *；user 永远可以创建', () => {
    expect(actorMatches('*', 'node:n1')).toBe(true)
    expect(actorMatches('node:*', 'node:n-abc')).toBe(true)
    expect(actorMatches('node:*', 'node:')).toBe(false)
    expect(actorMatches('node:*', 'remote:grok')).toBe(false)
    expect(actorMatches('node:*', 'nodex:n1')).toBe(false)
    expect(actorMatches('node:n-abc', 'node:n-abc')).toBe(true)
    expect(actorMatches('node:n-abc', 'node:n-abd')).toBe(false)
    expect(actorMatches('claude', 'Claude')).toBe(false)

    expect(canCreateRole({}, 'user')).toBe(true)
    expect(canCreateRole({ creatable_by: [] }, 'user')).toBe(true)
    expect(canCreateRole({}, 'node:n1')).toBe(false)
    expect(canCreateRole({ creatable_by: [] }, 'claude')).toBe(false)
    expect(canCreateRole({ creatable_by: ['node:*'] }, 'node:n1')).toBe(true)
    expect(canCreateRole({ creatable_by: ['node:*'] }, 'remote:grok')).toBe(false)
    expect(canCreateRole({ creatable_by: ['remote:grok'] }, 'remote:grok')).toBe(true)
    expect(canCreateRole({ creatable_by: ['*'] }, 'codex')).toBe(true)
  })

  test('schema：接受精确值与通配，拒绝不合法的模式', () => {
    const accepted = roleSchema.safeParse({
      ...role,
      creatable_by: ['user', 'node:n-abc', 'node:*', 'remote:*', '*', 'agent:claude'],
    })
    expect(accepted.success).toBe(true)
    for (const bad of ['', 'node*', ':*', 'a b', '**', 'node:**']) {
      expect(roleSchema.safeParse({ ...role, creatable_by: [bad] }).success).toBe(false)
    }
    expect(roleSchema.safeParse({ ...role, creatable_by: 'node:*' }).success).toBe(false)
  })

  test('默认模板：dev 与 pr-reviewer 为 [supervisor]，reviewer 与 triage 为 ["*"]，supervisor 与 merger 不写', async () => {
    const home = tempHome('raindown-roles-')
    for (const [name, text] of Object.entries(DEFAULT_ROLE_FILES)) {
      writeText(join(home, 'config/roles', name), text)
    }
    const loaded = data(await loadRoles(home))
    expect(loaded.errors).toEqual([])
    const by = Object.fromEntries(loaded.roles.map((r) => [r.name, r.creatable_by]))
    expect(by).toEqual({
      dev: ['supervisor'],
      merger: undefined,
      'pr-reviewer': ['supervisor'],
      reviewer: ['*'],
      supervisor: undefined,
      triage: ['*'],
    })
  })

  test('默认模板：isolation 只以注释说明，实际取值保持缺省 preferred（worker-credential-isolation 6.2）', async () => {
    const home = tempHome('raindown-roles-')
    for (const [name, text] of Object.entries(DEFAULT_ROLE_FILES)) {
      writeText(join(home, 'config/roles', name), text)
    }
    const loaded = data(await loadRoles(home))
    expect(loaded.errors).toEqual([])
    for (const r of loaded.roles) {
      expect(r.isolation).toBeUndefined()
      expect(roleIsolationOf(r)).toBe('preferred')
    }
    const dev = DEFAULT_ROLE_FILES['dev.yaml'] ?? ''
    expect(dev).toContain('# isolation: required')
    expect(dev).toContain('isolation.enforce: true')
    expect(dev).toContain('isolation_unavailable')
    for (const name of [
      'reviewer.yaml',
      'triage.yaml',
      'pr-reviewer.yaml',
      'supervisor.yaml',
      'merger.yaml',
    ])
      expect(DEFAULT_ROLE_FILES[name] ?? '').toContain('isolation')
    // 注释之外不出现 isolation 键。
    for (const text of Object.values(DEFAULT_ROLE_FILES))
      expect(text.split('\n').filter((line) => /^\s*isolation\s*:/.test(line))).toEqual([])
  })
})

test('角色名只接受可声明的 AI 身份，拒绝 user、保留身份和非法格式', () => {
  for (const name of ['dev', 'reviewer', 'agent:claude']) {
    expect(roleSchema.safeParse({ ...role, name }).success).toBe(true)
  }
  for (const name of [
    'user',
    'User',
    'hub',
    'POLICY',
    'scheduler',
    'unknown',
    'node:n1',
    'NODE:n1',
    'bad name',
    'a'.repeat(65),
  ]) {
    expect(roleSchema.safeParse({ ...role, name })).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ path: ['name'] })] },
    })
  }
})

describe('角色有效类别（D9）', () => {
  const of = (executor: string, permissions?: Record<string, unknown>, kind?: Role['kind']) =>
    ({
      ...role,
      executor,
      ...(permissions ? { permissions } : {}),
      ...(kind ? { kind } : {}),
    }) as Role

  /** claude-sdk 推断为 read 的最小配置。 */
  const readOnly = {
    setting_sources: [],
    disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  }

  test('按执行器与权限推断类别', () => {
    expect(inferRoleKind(of('codex-orca'))).toBe('write')
    expect(inferRoleKind(of('pr-merge'))).toBe('merge')
    expect(inferRoleKind(of('fake'))).toBe('write')
    expect(inferRoleKind(of('gpt-cli'))).toBe('write')
  })

  test('codex-exec：只读沙箱且 config 只含白名单键才是 read', () => {
    expect(CODEX_EXEC_READ_SAFE_CONFIG_KEYS).toEqual(['model', 'model_reasoning_effort'])
    expect(inferRoleKind(of('codex-exec'))).toBe('read')
    expect(inferRoleKind(of('codex-exec', { sandbox: 'read-only' }))).toBe('read')
    expect(inferRoleKind(of('codex-exec', { config: {} }))).toBe('read')
    expect(
      inferRoleKind(
        of('codex-exec', { config: { model: 'gpt-x', model_reasoning_effort: 'high' } }),
      ),
    ).toBe('read')
    expect(inferRoleKind(of('codex-exec', { sandbox: 'workspace-write' }))).toBe('write')
    expect(inferRoleKind(of('codex-exec', { sandbox: 'danger-full-access' }))).toBe('write')
    for (const config of [
      { notify: 'say done' },
      { 'mcp_servers.x.command': 'evil' },
      { sandbox_mode: 'workspace-write' },
      { model: 'gpt-x', 'shell_environment_policy.inherit': 'all' },
    ]) {
      expect(inferRoleKind(of('codex-exec', { config }))).toBe('write')
    }
  })

  test('permissions 中有推断不认识的键：保守判为 write', () => {
    expect(inferRoleKind(of('claude-sdk', { ...readOnly, read_scope: 'cwd' }))).toBe('read')
    expect(inferRoleKind(of('claude-sdk', { ...readOnly, maxTurns: 5 }))).toBe('read')
    expect(inferRoleKind(of('claude-sdk', { ...readOnly, hooks: {} }))).toBe('write')
    expect(inferRoleKind(of('claude-sdk', { ...readOnly, additionalDirectories: ['/'] }))).toBe(
      'write',
    )
    expect(inferRoleKind(of('codex-exec', { sandbox: 'read-only', approval: 'never' }))).toBe(
      'write',
    )
    expect(inferRoleKind(of('codex-exec', { profile: 'x' }))).toBe('write')
  })

  test('claude-sdk：setting_sources 显式 []、禁用全部写工具、没有写规则才是 read', () => {
    expect(inferRoleKind(of('claude-sdk', readOnly))).toBe('read')
    expect(
      inferRoleKind(of('claude-sdk', { ...readOnly, allowedTools: ['Read', 'Glob', 'Grep'] })),
    ).toBe('read')
    expect(inferRoleKind(of('claude-sdk', { ...readOnly, permissionMode: 'plan' }))).toBe('read')
    expect(inferRoleKind(of('claude-sdk', { ...readOnly, permissionMode: 'default' }))).toBe('read')
    // setting_sources 缺省（执行器默认 ['project']）或含任何来源：仓库设置的 allow 与 hooks 生效。
    expect(inferRoleKind(of('claude-sdk'))).toBe('write')
    for (const setting_sources of [undefined, ['project'], ['local'], ['user'], 'project']) {
      expect(inferRoleKind(of('claude-sdk', { ...readOnly, setting_sources }))).toBe('write')
    }
    // disallowedTools 必须逐项覆盖 Bash、Edit、Write、MultiEdit、NotebookEdit。
    for (const missing of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const disallowedTools = readOnly.disallowedTools.filter((t) => t !== missing)
      expect(inferRoleKind(of('claude-sdk', { ...readOnly, disallowedTools }))).toBe('write')
    }
    expect(
      inferRoleKind(
        of('claude-sdk', {
          ...readOnly,
          disallowedTools: ['Bash(rm:*)', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
        }),
      ),
    ).toBe('write')
    for (const extra of [
      { writable_paths: [] },
      { writable_paths: ['docs/**'] },
      { allowedTools: ['Edit'] },
      { allowedTools: ['Write(src/**)'] },
      { allowedTools: ['MultiEdit'] },
      { allowedTools: ['NotebookEdit'] },
      { allowedTools: ['Bash'] },
      { allowedTools: ['Read', 'Bash(gh pr view:*)'] },
      { permissionMode: 'acceptEdits' },
      { permissionMode: 'bypassPermissions' },
      { permissionMode: 'auto' },
    ]) {
      expect(inferRoleKind(of('claude-sdk', { ...readOnly, ...extra }))).toBe('write')
    }
  })

  test('默认 reviewer 配有 writable_paths：有效类别为 write', async () => {
    const home = tempHome('raindown-roles-')
    for (const [name, text] of Object.entries(DEFAULT_ROLE_FILES)) {
      writeText(join(home, 'config/roles', name), text)
    }
    const loaded = data(await loadRoles(home))
    expect(loaded.errors).toEqual([])
    const kinds = Object.fromEntries(loaded.roles.map((r) => [r.name, effectiveRoleKind(r)]))
    expect(kinds).toEqual({
      dev: 'write',
      merger: 'merge',
      'pr-reviewer': 'read',
      reviewer: 'write',
      supervisor: 'supervisor',
      triage: 'read',
    })
    // 模板中的 supervisor 与 pr-reviewer 本身就推断为 read，声明没有放宽任何东西。
    for (const r of loaded.roles) {
      if (r.kind && r.kind !== 'supervisor') expect<string>(inferRoleKind(r)).toBe(r.kind)
    }
  })

  test('声明只能收紧：取声明与推断中更严格者', () => {
    expect(effectiveRoleKind(of('codex-orca', undefined, 'read'))).toBe('write')
    expect(effectiveRoleKind(of('claude-sdk', { ...readOnly, writable_paths: [] }, 'read'))).toBe(
      'write',
    )
    expect(effectiveRoleKind(of('claude-sdk', undefined, 'read'))).toBe('write')
    expect(effectiveRoleKind(of('claude-sdk', readOnly, 'write'))).toBe('write')
    expect(effectiveRoleKind(of('pr-merge', undefined, 'write'))).toBe('merge')
    expect(effectiveRoleKind(of('codex-exec', undefined, 'write'))).toBe('write')
    expect(effectiveRoleKind(of('codex-exec', undefined, 'merge'))).toBe('merge')
    expect(effectiveRoleKind(of('codex-orca', undefined, 'merge'))).toBe('merge')
    expect(effectiveRoleKind(of('claude-sdk', undefined, 'supervisor'))).toBe('supervisor')
    expect(effectiveRoleKind(of('claude-sdk', { allowedTools: ['Bash'] }, 'supervisor'))).toBe(
      'supervisor',
    )
  })

  test('kind: supervisor 只能用于 claude-sdk；未知 kind 被拒绝', () => {
    expect(
      roleSchema.safeParse({
        ...role,
        name: 'supervisor',
        executor: 'claude-sdk',
        kind: 'supervisor',
      }).success,
    ).toBe(true)
    for (const executor of ['codex-orca', 'codex-exec', 'pr-merge', 'fake']) {
      expect(
        roleSchema.safeParse({ ...role, name: 'supervisor', executor, kind: 'supervisor' }),
      ).toMatchObject({
        success: false,
        error: { issues: [expect.objectContaining({ path: ['kind'] })] },
      })
    }
    expect(roleSchema.safeParse({ ...role, kind: 'admin' }).success).toBe(false)
  })

  test('supervisor 为保留 actor：名字与 kind: supervisor 必须同时出现', async () => {
    const sdk = { ...role, executor: 'claude-sdk' }
    expect(roleSchema.safeParse({ ...sdk, name: 'supervisor', kind: 'supervisor' }).success).toBe(
      true,
    )
    for (const bad of [
      { ...sdk, name: 'supervisor' },
      { ...sdk, name: 'supervisor', kind: 'read' },
      { ...role, name: 'supervisor', kind: 'write' },
      { ...sdk, name: 'Supervisor', kind: 'supervisor' },
      { ...sdk, name: 'SUPERVISOR' },
      { ...sdk, name: 'boss', kind: 'supervisor' },
    ]) {
      expect(roleSchema.safeParse(bad)).toMatchObject({
        success: false,
        error: { issues: [expect.objectContaining({ path: ['name'] })] },
      })
    }
    expect(roleSchema.safeParse({ ...sdk, name: 'boss', kind: 'read' }).success).toBe(true)

    const home = tempHome('raindown-roles-')
    writeText(
      join(home, 'config/roles/supervisor.yaml'),
      stringify({ ...role, name: 'supervisor', executor: 'codex-orca' }),
    )
    const loaded = data(await loadRoles(home))
    expect(loaded.roles).toEqual([])
    expect(loaded.errors).toEqual([
      expect.objectContaining({ file: 'config/roles/supervisor.yaml', field: 'name' }),
    ])
  })

  test('findSupervisorRole：没有返回 null；唯一且只读返回该角色；多个或可写时报错', () => {
    const supRead = { ...readOnly, read_scope: 'cwd' }
    const sup = (name: string, permissions: Record<string, unknown> = supRead) =>
      ({ ...of('claude-sdk', permissions, 'supervisor'), name }) as Role
    expect(data(findSupervisorRole([of('codex-orca')]))).toBeNull()
    expect(data(findSupervisorRole([of('codex-orca'), sup('supervisor')]))?.name).toBe('supervisor')
    const r = findSupervisorRole([sup('supervisor'), sup('boss')])
    expect(r).toMatchObject({ ok: false, error: { code: 'multiple_supervisor_roles' } })
    expect(r.ok || r.error.message).toContain('supervisor、boss')
    for (const permissions of [
      { ...readOnly, allowedTools: ['Bash(git status)'] },
      { ...readOnly, allowedTools: ['Edit'] },
      { ...readOnly, writable_paths: ['docs/**'] },
      { ...readOnly, setting_sources: ['project'] },
      { setting_sources: [] },
      // 只读但没有 read_scope（会话可以读 state/ 下的 token 文件）。
      readOnly,
      { ...supRead, setting_sources: undefined },
    ]) {
      expect(findSupervisorRole([sup('supervisor', permissions)])).toMatchObject({
        ok: false,
        error: { code: 'supervisor_role_not_read' },
      })
    }
  })

  test('supervisorRoleProblem：claude-sdk、推断为 read、setting_sources: []、read_scope: cwd', () => {
    const supRead = { ...readOnly, read_scope: 'cwd' }
    expect(supervisorRoleProblem(of('claude-sdk', supRead, 'supervisor'))).toBeUndefined()
    expect(supervisorRoleProblem(of('codex-exec', {}, 'supervisor'))).toContain('claude-sdk')
    expect(supervisorRoleProblem(of('claude-sdk', readOnly, 'supervisor'))).toContain('read_scope')
    expect(
      supervisorRoleProblem(of('claude-sdk', { ...supRead, read_scope: 'home' }, 'supervisor')),
    ).toContain('read_scope')
    expect(
      supervisorRoleProblem(of('claude-sdk', { ...supRead, allowedTools: ['Bash'] }, 'supervisor')),
    ).toContain('read')
    // raindown init 的 supervisor 模板满足要求。
    const tpl = parse(DEFAULT_ROLE_FILES['supervisor.yaml'] ?? '') as Role
    expect(supervisorRoleProblem(tpl)).toBeUndefined()
  })
})
