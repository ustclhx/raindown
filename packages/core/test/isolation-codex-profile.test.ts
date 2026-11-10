import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_NATIVE_EXTENDS,
  codexNativeConfigValues,
  codexNativeProfile,
  computeIsolationSpec,
  type IsolationSpec,
  renderCodexNativeProfileTable,
  tomlBasicString,
} from '../src/index.ts'

/**
 * native 施加层（add-worker-credential-isolation 5.1）：由隔离清单生成 Codex permissions profile。
 * 只验证生成结果（结构、条目与 TOML 转义），不运行 Codex。
 */

const HOME = '/Users/u/raindown-home'
const SPEC: IsolationSpec = {
  deny_read: [
    '/Users/u/.config/sops/age',
    '/Users/u/Library/Application Support/orca',
    '/Users/u/Library/LaunchAgents',
  ],
  deny_write: ['/Users/u/.config/sops/age', `${HOME}/run/tasks/t-1/dispatch-tokens`],
  deny_children_except: [
    { dir: HOME, keep: `${HOME}/run` },
    { dir: `${HOME}/run/executors`, keep: `${HOME}/run/executors/codex-exec` },
    { dir: `${HOME}/run/tasks`, keep: `${HOME}/run/tasks/t-1` },
  ],
  allow_read: [`${HOME}/run/tasks/t-1/dispatch-tokens/l-1.token`, '/Users/u/work'],
  allow_write: ['/Users/u/work', `${HOME}/run/tasks/t-1`],
  allow_write_literals: [],
  write_carve_outs: [],
  write_carve_out_literals: [],
  allow_write_regex: [],
  allow_write_git: [],
  regular_files_only: [],
  deny_write_except: [],
  deny_unix_sockets: ['/Users/u/Library/Application Support/orca'],
  allow_unix_sockets: [],
  allow_local_ports: [7477],
  deny_local_ports: [],
  orca_ports: { status: 'unresolved', reason: 'test' },
  deny_process_debug: ['mach-priv-task-port', 'mach-task-name'],
}

const CODEX_HOME = `${HOME}/run/executors/codex-exec/codex-read-home`

/** 用 TOML 解析器还原 `-c key=value`（Codex 同样按 TOML 解析值）。 */
const parse = (values: string[]) => Bun.TOML.parse(values.join('\n')) as Record<string, unknown>

describe('Codex permissions profile（native）', () => {
  test('read-only：受保护路径与 raindown-home 整体 deny，派工令牌与 CODEX_HOME/tmp 为 read；结构快照', () => {
    const r = codexNativeProfile({
      spec: SPEC,
      sandbox: 'read-only',
      name: 'raindown-abc',
      extraDeny: [CODEX_HOME, '/Users/u/.codex/auth.json'],
      extraRead: [`${CODEX_HOME}/tmp`],
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data).toEqual({
      name: 'raindown-abc',
      extends: ':read-only',
      filesystem: [
        ['/Users/u/.codex/auth.json', 'deny'],
        ['/Users/u/.config/sops/age', 'deny'],
        ['/Users/u/Library/Application Support/orca', 'deny'],
        ['/Users/u/Library/LaunchAgents', 'deny'],
        // CODEX_HOME 被 raindown-home 的拒绝覆盖，不单列。
        [HOME, 'deny'],
        [`${CODEX_HOME}/tmp`, 'read'],
        [`${HOME}/run/tasks/t-1/dispatch-tokens/l-1.token`, 'read'],
      ],
      unixSockets: ['/Users/u/Library/Application Support/orca'],
      networkEnabled: false,
    })
    const values = codexNativeConfigValues(r.data)
    expect(values).toMatchSnapshot()
    expect(values[1]).toBe('default_permissions="raindown-abc"')
    const parsed = parse(values)
    expect(parsed.default_permissions).toBe('raindown-abc')
    expect(parsed.permissions).toEqual({
      'raindown-abc': {
        extends: ':read-only',
        filesystem: Object.fromEntries(r.data.filesystem),
        network: { unix_sockets: { '/Users/u/Library/Application Support/orca': 'deny' } },
      },
    })
  })

  test('workspace-write：extends=:workspace；角色打开网络时写 network.enabled=true；read-only 下忽略', () => {
    const ws = codexNativeProfile({
      spec: SPEC,
      sandbox: 'workspace-write',
      name: 'raindown-x',
      networkEnabled: true,
    })
    if (!ws.ok) throw new Error(ws.error.message)
    expect(ws.data.extends).toBe(CODEX_NATIVE_EXTENDS['workspace-write'])
    expect(renderCodexNativeProfileTable(ws.data)).toContain('network={enabled=true,unix_sockets=')
    const ro = codexNativeProfile({
      spec: SPEC,
      sandbox: 'read-only',
      name: 'raindown-x',
      networkEnabled: true,
    })
    if (!ro.ok) throw new Error(ro.error.message)
    expect(ro.data.networkEnabled).toBe(false)
    // 工作目录不在拒绝目录内：不写 read 条目（`:workspace` / `:read-only` 下本来可读）。
    expect(ws.data.filesystem.some(([p]) => p === '/Users/u/work')).toBe(false)
  })

  test('注入：路径中的引号、反斜杠、换行与控制字符不能改变内联表结构，解析后与原路径相同', () => {
    const evil = [
      '/tmp/a"=read,"/Users/u/raindown-home"="read"}',
      '/tmp/b\\"}\n[permissions.x]\nextends=":danger-full-access"',
      '/tmp/c\u0000d\u0007e\u007f\u0085\r\t',
      "/tmp/d'''",
    ]
    const spec: IsolationSpec = { ...SPEC, deny_read: [...SPEC.deny_read, ...evil] }
    const r = codexNativeProfile({ spec, sandbox: 'read-only', name: 'raindown-x' })
    if (!r.ok) throw new Error(r.error.message)
    const values = codexNativeConfigValues(r.data)
    // 每个值只占一行。
    for (const v of values)
      for (const ch of ['\n', '\r', String.fromCharCode(0)]) expect(v.includes(ch)).toBe(false)
    const parsed = parse(values) as {
      permissions: Record<string, { extends: string; filesystem: Record<string, string> }>
    }
    expect(Object.keys(parsed.permissions)).toEqual(['raindown-x'])
    const p = parsed.permissions['raindown-x']
    expect(p?.extends).toBe(':read-only')
    for (const e of evil) expect(p?.filesystem[e]).toBe('deny')
    // raindown-home 仍是 deny，没有被注入的 read 覆盖。
    expect(p?.filesystem[HOME]).toBe('deny')
    expect(Object.values(p?.filesystem ?? {}).filter((v) => v === 'read')).toHaveLength(1)
  })

  test('审查第一轮 M3：readOnly 中的路径（可写工作区内的 .git/hooks、.git/config）一律写 read', () => {
    const r = codexNativeProfile({
      spec: SPEC,
      sandbox: 'workspace-write',
      name: 'raindown-x',
      readOnly: ['/Users/u/work/.git/hooks', '/Users/u/work/.git/config'],
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.filesystem).toContainEqual(['/Users/u/work/.git/hooks', 'read'])
    expect(r.data.filesystem).toContainEqual(['/Users/u/work/.git/config', 'read'])
  })

  test('tomlBasicString：转义反斜杠、引号与全部控制字符', () => {
    expect(tomlBasicString('a\\b"c')).toBe('"a\\\\b\\"c"')
    expect(tomlBasicString('x\ny\u0000\u001f\u007f')).toBe('"x\\u000Ay\\u0000\\u001F\\u007F"')
    expect(tomlBasicString('中文 路径')).toBe('"中文 路径"')
  })

  test('拒绝非法的 profile 名、相对路径与不支持的沙箱设置', () => {
    for (const name of ['', 'a.b', 'A', 'x"y', 'raindown x'])
      expect(codexNativeProfile({ spec: SPEC, sandbox: 'read-only', name }).ok).toBe(false)
    const rel = codexNativeProfile({
      spec: { ...SPEC, deny_read: ['relative/path'] },
      sandbox: 'read-only',
      name: 'raindown-x',
    })
    expect(rel.ok).toBe(false)
    if (!rel.ok) expect(rel.error.code).toBe('codex_profile_invalid_path')
    expect(
      codexNativeProfile({
        spec: SPEC,
        sandbox: 'danger-full-access' as never,
        name: 'raindown-x',
      }).ok,
    ).toBe(false)
  })

  test('与 computeIsolationSpec 联动：真实（临时）目录下的路径全部是 realpath', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'raindown-codex-profile-')))
    try {
      const home = join(root, 'home')
      const user = join(root, 'user')
      const cwd = join(root, 'work')
      for (const d of [join(home, 'run/tasks/t-1/dispatch-tokens'), user, cwd])
        await mkdir(d, { recursive: true })
      const token = join(home, 'run/tasks/t-1/dispatch-tokens/l-1.token')
      await writeFile(token, 'x\n')
      const spec = await computeIsolationSpec({
        home,
        taskId: 't-1',
        executor: 'codex-exec',
        executorHome: 'codex-read-home',
        cwd,
        access: 'read',
        leaseTokenFile: token,
        hubPort: 7477,
        userHome: user,
        env: {},
      })
      if (!spec.ok) throw new Error(spec.error.message)
      const r = codexNativeProfile({ spec: spec.data, sandbox: 'read-only', name: 'raindown-x' })
      if (!r.ok) throw new Error(r.error.message)
      expect(r.data.filesystem).toContainEqual([home, 'deny'])
      expect(r.data.filesystem).toContainEqual([token, 'read'])
      expect(r.data.filesystem).toContainEqual([join(user, '.config/sops/age'), 'deny'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
