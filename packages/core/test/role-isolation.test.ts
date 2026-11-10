import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type DoctorReport, runDoctor } from '../src/doctor.ts'
import { initRaindownHome } from '../src/init.ts'
import {
  assessIsolation,
  ISOLATION_UNAVAILABLE,
  isIsolationUnavailable,
  isolationUnavailableMessage,
  roleIsolationTarget,
} from '../src/isolation/requirement.ts'
import type { IsolationProbeReport } from '../src/ledger/isolation-probe.ts'
import { PROBE_REQUIRED_DENY_ITEMS } from '../src/ledger/isolation-probe.ts'
import { loadRoles, roleIsolationOf, roleSchema } from '../src/roles.ts'
import { doctorOptions } from './doctor-helpers.ts'
import { tempHome, writeText } from './helpers.ts'

/** 角色隔离要求（add-worker-credential-isolation 6.1）。 */

const base = { name: 'dev', executor: 'codex-exec', prompt: '测试' }

describe('角色配置 isolation', () => {
  test('取值 required | preferred | off，缺省 preferred；其他取值报错', () => {
    for (const isolation of ['required', 'preferred', 'off'])
      expect(roleSchema.safeParse({ ...base, isolation }).success).toBe(true)
    expect(roleSchema.safeParse({ ...base, isolation: 'strict' }).success).toBe(false)
    expect(roleSchema.safeParse({ ...base, isolation: true }).success).toBe(false)
    expect(roleIsolationOf(roleSchema.parse(base))).toBe('preferred')
    expect(roleIsolationOf(null)).toBe('preferred')
  })

  test('supervisor 唤醒会话与 pr-merge 不能设为 required，preferred / off 可以', () => {
    const supervisor = {
      name: 'supervisor',
      executor: 'claude-sdk',
      kind: 'supervisor',
      prompt: '测试',
    }
    const merger = { name: 'merger', executor: 'pr-merge', prompt: '测试' }
    for (const role of [supervisor, merger]) {
      const r = roleSchema.safeParse({ ...role, isolation: 'required' })
      expect(r.success).toBe(false)
      expect(r.error?.issues[0]?.path).toEqual(['isolation'])
      expect(r.error?.issues[0]?.message).toContain('不支持隔离')
      expect(roleSchema.safeParse({ ...role, isolation: 'off' }).success).toBe(true)
      expect(roleSchema.safeParse({ ...role, isolation: 'preferred' }).success).toBe(true)
    }
    // 非 supervisor 的 claude-sdk 角色可以 required。
    expect(
      roleSchema.safeParse({ ...base, executor: 'claude-sdk', isolation: 'required' }).success,
    ).toBe(true)
  })

  test('raindown doctor 对非法取值与不支持的 required 报错', async () => {
    const home = tempHome('raindown-role-isolation-')
    await initRaindownHome(home)
    writeText(
      join(home, 'config/roles/bad.yaml'),
      'name: bad\nexecutor: codex-exec\nprompt: x\nisolation: strict\n',
    )
    writeText(
      join(home, 'config/roles/merger2.yaml'),
      'name: merger2\nexecutor: pr-merge\nprompt: x\nisolation: required\n',
    )
    const loaded = await loadRoles(home)
    expect(loaded.ok && loaded.data.errors.map((e) => [e.file, e.field])).toEqual(
      expect.arrayContaining([
        ['config/roles/bad.yaml', 'isolation'],
        ['config/roles/merger2.yaml', 'isolation'],
      ]),
    )
    const r = await runDoctor(home, 'RAINDOWN_HOME', doctorOptions(home))
    expect(r.ok).toBe(false)
    const report = (r.ok ? r.data : r.error.details) as DoctorReport
    const bad = report.checks.find((c) => c.id === 'roles.config.config/roles/bad.yaml.isolation')
    expect(bad).toMatchObject({ ok: false })
    const merger = report.checks.find(
      (c) => c.id === 'roles.config.config/roles/merger2.yaml.isolation',
    )
    expect(merger).toMatchObject({ ok: false })
    expect(merger?.message).toContain('不支持隔离')
  })
})

const NOW = Date.parse('2026-11-10T08:00:00.000Z')
const report = (passed: boolean, ranAt = new Date(NOW - 60_000).toISOString()) =>
  ({
    ran_at: ranAt,
    macos_version: '15.1',
    runs: [
      {
        executor: 'codex-exec',
        setting: 'danger-full-access',
        declared_layer: 'seatbelt',
        applied_layer: 'seatbelt',
        passed,
        items: PROBE_REQUIRED_DENY_ITEMS.map((item) => ({
          item,
          expected: 'deny' as const,
          actual: !passed && item === 'write.config' ? ('allow' as const) : ('deny' as const),
          ok: passed || item !== 'write.config',
        })),
      },
    ],
  }) satisfies IsolationProbeReport

const caps = (enforced: boolean, layer = 'seatbelt') => ({
  credential_isolation: { layers: { 'danger-full-access': layer }, enforced },
})
const assess = (o: Partial<Parameters<typeof assessIsolation>[0]>) =>
  assessIsolation({
    capabilities: caps(true),
    setting: 'danger-full-access',
    probe: report(true),
    executor: 'codex-exec',
    now: NOW,
    ...o,
  })

describe('assessIsolation', () => {
  test('声明已施加、施加层非 none、探针通过且未过期：已隔离', () => {
    expect(assess({})).toEqual({
      view: { reported: true, layer: 'seatbelt', enforced: true },
      missing: [],
    })
  })

  test('逐项说明缺什么', () => {
    expect(assess({ capabilities: {} }).missing[0]).toContain('未上报凭证隔离能力')
    expect(assess({ setting: undefined }).missing[0]).toContain('无法确定角色的沙箱设置')
    expect(assess({ capabilities: caps(true, 'none') }).missing).toEqual([
      'codex-exec × danger-full-access 的施加层为 none',
    ])
    expect(assess({ capabilities: caps(true, 'future_layer') }).missing[0]).toContain(
      '施加层为 none',
    )
    expect(assess({ capabilities: caps(false) }).missing[0]).toContain('isolation.enforce')
    expect(assess({ capabilities: caps(false), platform: 'linux' }).missing[0]).toContain(
      '平台 linux 不支持隔离',
    )
    expect(assess({ capabilities: caps(false), platform: 'darwin' }).missing[0]).toBe(
      '隔离开关关闭（config/node.yaml isolation.enforce）',
    )
    expect(assess({ probe: null }).missing[0]).toContain('未探测')
    expect(assess({ probe: report(false) }).missing[0]).toContain('write.config')
    expect(
      assess({ probe: report(true, new Date(NOW - 13 * 3600_000).toISOString()) }).missing[0],
    ).toContain('已过期')
  })
})

describe('角色目标与卡住消息', () => {
  test('沙箱设置按合同执行器 × 角色权限推出', () => {
    expect(
      roleIsolationTarget(
        { name: 'dev', executor: 'codex-orca', permissions: { sandbox: 'danger-full-access' } },
        { executor: 'codex-exec' },
      ),
    ).toEqual({ role: 'dev', requirement: 'preferred', setting: 'danger-full-access' })
    expect(roleIsolationTarget(null, { executor: 'codex-exec' })).toBeUndefined()
  })

  test('消息以 isolation_unavailable： 开头并列出缺什么', () => {
    const m = isolationUnavailableMessage(
      { role: 'dev', setting: 'danger-full-access' },
      'codex-exec',
      ['节点 n1：施加层为 none'],
    )
    expect(m.startsWith(`${ISOLATION_UNAVAILABLE}：`)).toBe(true)
    expect(m).toContain('- 节点 n1：施加层为 none')
    expect(isIsolationUnavailable(m)).toBe(true)
    expect(isIsolationUnavailable('其他')).toBe(false)
    expect(isIsolationUnavailable(undefined)).toBe(false)
  })
})
