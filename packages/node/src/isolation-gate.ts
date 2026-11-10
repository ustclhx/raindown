import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import {
  findProbeRun,
  type IsolationProbeReport,
  PROBE_MAX_AGE_MS,
  probeRunPassed,
} from '@raindown/core'

/**
 * native 施加层的启动闸门（PR #104 审查第一轮 H1）：native 启动前要求该执行器 × 沙箱设置最近一次探针**以 native 运行且通过**，
 * 并且探针与这次启动用的是**同一个 codex 可执行文件**（真实路径 + mtime + 大小 + inode 相同），角色打开网络时探针也必须是以打开网络的
 * profile 运行的。任何一项不满足都不启动（fail closed），原因 `isolation_not_applied`。
 *
 * 节点在 `raindown node start` 中创建一个闸门：探针的 native 启动包装记录它用的 codex 与网络设置（`record`），
 * 节点在每次探针结束后传入报告（`update`）；执行器在启动 native 的 Codex 之前调用 `check`。
 * 可执行文件变化（例如 Codex 升级）时 `check` 失败，并请节点尽快重新运行探针（`onStale`，同一时间只请求一次）。
 */

/** 可执行文件的身份：真实路径 + mtime + 大小 + inode。 */
export interface ExecutableIdentity {
  path: string
  key: string
}

/** 按 PATH 查找可执行文件（与 shell 的查找顺序相同），返回真实路径与身份；找不到时返回 undefined。 */
export function resolveExecutable(
  bin: string,
  pathEnv: string | undefined,
): ExecutableIdentity | undefined {
  const candidates = bin.includes('/')
    ? [isAbsolute(bin) ? bin : resolve(bin)]
    : (pathEnv ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((d) => join(d, bin))
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK)
      const real = realpathSync(c)
      const st = statSync(real)
      if (!st.isFile()) continue
      return { path: real, key: `${real}|${st.mtimeMs}|${st.size}|${st.ino}` }
    } catch {
      // 不存在或不可执行：继续找下一个。
    }
  }
  return undefined
}

/** 探针以 native 运行某个执行器 × 沙箱设置时用的 codex 与网络设置。 */
export interface NativeProbeRecord {
  codex: string
  network: boolean
}

export type NativeGateResult = { ok: true } | { ok: false; reason: string }

export interface NativeProbeGate {
  check(
    executor: string,
    setting: string,
    launch: NativeProbeRecord,
    now?: number,
  ): NativeGateResult
}

export class IsolationProbeGate implements NativeProbeGate {
  private report: IsolationProbeReport | undefined
  private readonly records = new Map<string, NativeProbeRecord>()
  private staleRequested = false
  /** 启动时发现 codex 可执行文件与探针不同：请节点重新运行探针（节点设置）。 */
  onStale: (() => void) | undefined

  /** 探针的 native 启动包装记录本次使用的 codex（身份 key）与网络设置。 */
  record(executor: string, setting: string, r: NativeProbeRecord): void {
    this.records.set(`${executor}|${setting}`, r)
  }

  /** 节点在每次探针结束（含失败）后传入报告。 */
  update(report: IsolationProbeReport): void {
    this.report = report
    this.staleRequested = false
  }

  check(
    executor: string,
    setting: string,
    launch: NativeProbeRecord,
    now: number = Date.now(),
  ): NativeGateResult {
    const report = this.report
    if (!report)
      return { ok: false, reason: `${executor} × ${setting} 还没有隔离自检结果（节点启动时运行）` }
    const run = findProbeRun(report, executor, setting)
    const ranAt = Date.parse(report.ran_at)
    if (run === undefined || run.applied_layer !== 'native')
      return { ok: false, reason: `${executor} × ${setting} 最近一次隔离自检没有以 native 运行` }
    if (!Number.isFinite(ranAt) || Math.abs(now - ranAt) > PROBE_MAX_AGE_MS)
      return {
        ok: false,
        reason: `${executor} × ${setting} 的隔离自检结果已过期（${report.ran_at}）`,
      }
    if (!probeRunPassed(run))
      return {
        ok: false,
        reason: `${executor} × ${setting} 最近一次隔离自检不通过${run.error ? `（${run.error.code}：${run.error.message}）` : '（失败项见 raindown doctor）'}`,
      }
    const rec = this.records.get(`${executor}|${setting}`)
    if (!rec || rec.codex !== launch.codex) {
      if (!this.staleRequested) {
        this.staleRequested = true
        this.onStale?.()
      }
      return {
        ok: false,
        reason: `本次启动的 codex 可执行文件（${launch.codex.split('|')[0]}）与隔离自检时不同或已变化（例如升级），已请求重新自检`,
      }
    }
    if (launch.network && !rec.network)
      return {
        ok: false,
        reason:
          '角色打开了 sandbox_workspace_write.network_access，但隔离自检是以不联网的 profile 运行的',
      }
    return { ok: true }
  }
}
