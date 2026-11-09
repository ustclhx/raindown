import { describe, expect, test } from 'bun:test'
import { buildCodexCommand, codexTrustConfig } from '../src/codex-orca/executor.ts'

describe('预置项目信任（审查第一轮 M6）', () => {
  test('用顶层键 projects 加内联表，目录作为 TOML 基本字符串转义；含控制字符时拒绝', () => {
    expect(codexTrustConfig('/h/run/tasks/t-1/repo')).toEqual({
      ok: true,
      data: 'projects={"/h/run/tasks/t-1/repo"={trust_level="trusted"}}',
    })
    expect(codexTrustConfig('/a"b\\c.d')).toEqual({
      ok: true,
      data: 'projects={"/a\\"b\\\\c.d"={trust_level="trusted"}}',
    })
    for (const bad of ['/a\nb', '/a\u0000b', '/a\u007fb'])
      expect(codexTrustConfig(bad).ok).toBe(false)
  })

  test('命令构造：只有给出 trustProject 与 extraEnv 时才出现（开关关闭时命令不变）', () => {
    const base = {
      codexBin: 'codex',
      codexHome: '/h/run/executors/codex-orca/codex-home',
      worktreePath: '/w',
      specPath: '/h/state/tasks/t-1/spec.md',
      role: {
        name: 'dev',
        permissions: { approval: 'never', sandbox: 'danger-full-access' },
      },
    }
    const plain = buildCodexCommand(base)
    if (!plain.ok) throw new Error(plain.error.message)
    expect(plain.data).not.toContain('projects=')
    expect(plain.data).not.toContain('TMPDIR=')
    const sealed = buildCodexCommand({
      ...base,
      trustProject: "/h/run/tasks/t-1/it's",
      extraEnv: { TMPDIR: '/h/run/tasks/t-1/tmp' },
    })
    if (!sealed.ok) throw new Error(sealed.error.message)
    expect(sealed.data).toContain('TMPDIR=/h/run/tasks/t-1/tmp ')
    // 单引号经 shell 引号转义；TOML 键是双引号字符串。
    expect(sealed.data).toContain(
      `-c 'projects={"/h/run/tasks/t-1/it'\\''s"={trust_level="trusted"}}'`,
    )
    // 审查第二轮 L2：信任后 clone 内的 .codex/config.toml 可能被加载，命令行固定 notify 与 model_provider。
    expect(sealed.data).toContain(`-c 'notify=[]' -c 'model_provider="openai"'`)
    expect(plain.data).not.toContain('notify=')
    const custom = buildCodexCommand({
      ...base,
      role: {
        ...base.role,
        permissions: { ...base.role.permissions, config: { model_provider: '"azure"' } },
      },
      trustProject: '/h/run/tasks/t-1/repo',
    })
    if (!custom.ok) throw new Error(custom.error.message)
    expect(custom.data).toContain(`-c 'model_provider="azure"'`)
    expect(custom.data.lastIndexOf('model_provider=')).toBeGreaterThan(
      custom.data.indexOf('trust_level'),
    )
  })
})
