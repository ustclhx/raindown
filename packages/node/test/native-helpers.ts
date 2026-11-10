import { PROBE_NATIVE_REQUIRED_DENY_ITEMS } from '@raindown/core'
import { IsolationProbeGate, resolveExecutable } from '../src/isolation-gate.ts'

/**
 * 测试用的 native 启动闸门：报告中给定执行器 × 沙箱设置的探针以 native 运行且通过，并记录探针用的 codex 为 `codexBin`
 * （按 PATH 解析）。不运行任何 codex。
 */
export function passingNativeGate(
  executor: string,
  settings: readonly string[],
  codexBin: string,
  opts: { network?: boolean; passed?: boolean; ranAt?: string } = {},
): IsolationProbeGate {
  const gate = new IsolationProbeGate()
  const id = resolveExecutable(codexBin, process.env.PATH)
  if (!id) throw new Error(`找不到 ${codexBin}`)
  for (const setting of settings)
    gate.record(executor, setting, { codex: id.key, network: opts.network === true })
  gate.update({
    ran_at: opts.ranAt ?? new Date().toISOString(),
    macos_version: null,
    runs: settings.map((setting) => ({
      executor,
      setting,
      declared_layer: 'native',
      applied_layer: 'native',
      passed: opts.passed !== false,
      items: PROBE_NATIVE_REQUIRED_DENY_ITEMS.map((item) => ({
        item,
        expected: 'deny' as const,
        actual:
          opts.passed === false && item === 'read.hub_token'
            ? ('allow' as const)
            : ('deny' as const),
        ok: !(opts.passed === false && item === 'read.hub_token'),
      })),
    })),
  })
  return gate
}
