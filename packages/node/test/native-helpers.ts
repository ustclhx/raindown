import { type IsolationProbeRun, PROBE_NATIVE_REQUIRED_DENY_ITEMS } from '@raindown/core'
import { IsolationProbeGate, resolveExecutable } from '../src/isolation-gate.ts'

/**
 * 测试用的 native 启动闸门：报告中给定执行器 × 沙箱设置（× 联网组）的探针以 native 运行且通过，并记录探针用的 codex 为 `codexBin`
 * （按 PATH 解析）。不运行任何 codex。`networks` 缺省只有不联网组；`[false, true]` 时两组都有（联网组带 `network: true`）。
 */
export function passingNativeGate(
  executor: string,
  settings: readonly string[],
  codexBin: string,
  opts: { networks?: readonly boolean[]; passed?: boolean; ranAt?: string } = {},
): IsolationProbeGate {
  const gate = new IsolationProbeGate()
  const id = resolveExecutable(codexBin, process.env.PATH)
  if (!id) throw new Error(`找不到 ${codexBin}`)
  const leak = opts.passed === false
  const runs: IsolationProbeRun[] = []
  for (const setting of settings)
    for (const network of opts.networks ?? [false]) {
      gate.record(executor, setting, { codex: id.key, network })
      runs.push({
        executor,
        setting,
        declared_layer: 'native',
        applied_layer: 'native',
        ...(network ? { network: true } : {}),
        passed: !leak,
        items: PROBE_NATIVE_REQUIRED_DENY_ITEMS.map((item) => ({
          item,
          expected: 'deny' as const,
          actual: leak && item === 'read.hub_token' ? ('allow' as const) : ('deny' as const),
          ok: !(leak && item === 'read.hub_token'),
        })),
      })
    }
  gate.update({ ran_at: opts.ranAt ?? new Date().toISOString(), macos_version: null, runs })
  return gate
}
