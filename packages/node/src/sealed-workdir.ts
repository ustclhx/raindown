import { existsSync } from 'node:fs'
import { fail, type HarnessPath, ok, type Result, readOrcaSetupScript } from '@raindown/core'
import type { CommandRunner } from './codex-orca/orca.ts'
import {
  defaultCloneBase,
  ensureSealedClone,
  removeSealedClone,
  runCloneSetup,
  sealedCloneRecordPath,
} from './sealed-clone.ts'
import { prepareSeatbelt, type SeatbeltOptions } from './seatbelt.ts'
import { prepareTaskScratch } from './task-scratch.ts'

/**
 * 施加外层 seatbelt 的写类任务的工作目录（审查第一轮，第一步方案）：按任务私有的临时与缓存目录（M2）、
 * 独立 clone（`run/tasks/<任务>/repo`）、本次 harness 的 seatbelt 配置；新建 clone 后在同一配置下运行仓库 `orca.yaml` 的 setup。
 * 三个适配器（codex-orca、codex-exec、claude-sdk）共用。
 */
export interface SealedWorkdirInput {
  home: string
  taskId: string
  executor: string
  executorHome?: string
  /** 登记仓库（realpath）。 */
  repo: string
  /** 新建分支的基准（例如 `origin/main`）；缺省取登记仓库的 `origin/HEAD`，取不到时 `origin/main`。 */
  base?: string
  branch: string
  leaseTokenFile?: string
  hubUrl?: string
  harnessPaths?: readonly HarnessPath[]
  allowKeychain?: boolean
  /** worker 的环境（setup 在同样的环境中运行，另加按任务私有的临时与缓存目录）。 */
  env: NodeJS.ProcessEnv
  setupTimeoutMs?: number
  run?: CommandRunner
  /** setup 前后的进度说明。 */
  status?: (text: string) => void
}

export interface SealedWorkdir {
  dir: string
  fresh: boolean
  /** `[sandbox-exec, -f, <配置>]`。 */
  prefix: string[]
  profilePath: string
  /** 注入 worker 的临时与缓存目录环境变量。 */
  scratchEnv: Record<string, string>
}

export async function prepareSealedWorkdir(
  o: SeatbeltOptions,
  i: SealedWorkdirInput,
): Promise<Result<SealedWorkdir>> {
  // 没有中枢地址时不建立 clone（与 prepareSeatbelt 的检查一致，失败得更早）。
  if (!i.hubUrl)
    return fail(
      'failure',
      'isolation_hub_url_missing',
      '没有中枢地址，无法计算隔离清单（中枢端口）；开关 isolation.enforce 已打开，不启动 harness',
    )
  const gitOpts = {
    ...(i.run ? { run: i.run } : {}),
    ...(o.gitEnv ? { env: o.gitEnv } : {}),
  }
  let scratchEnv: Record<string, string>
  try {
    scratchEnv = await prepareTaskScratch(i.home, i.taskId)
  } catch (err) {
    return fail(
      'failure',
      'task_scratch_failed',
      `无法建立任务私有的临时与缓存目录：${(err as Error).message}`,
    )
  }
  const clone = await ensureSealedClone({
    home: i.home,
    taskId: i.taskId,
    repo: i.repo,
    base: i.base ?? (await defaultCloneBase(i.repo, gitOpts)),
    branch: i.branch,
    ...(o.dissociate ? { dissociate: true } : {}),
    ...gitOpts,
  })
  if (!clone.ok) return clone
  const prepared = await prepareSeatbelt(o, {
    home: i.home,
    taskId: i.taskId,
    executor: i.executor,
    ...(i.executorHome !== undefined ? { executorHome: i.executorHome } : {}),
    cwd: clone.data.path,
    access: 'write',
    sealedClone: clone.data.path,
    ...(i.leaseTokenFile ? { leaseTokenFile: i.leaseTokenFile } : {}),
    ...(i.hubUrl ? { hubUrl: i.hubUrl } : {}),
    ...(i.harnessPaths ? { harnessPaths: i.harnessPaths } : {}),
    ...(i.allowKeychain ? { allowKeychain: true } : {}),
  })
  if (!prepared.ok) return prepared
  if (clone.data.fresh) {
    const script = await readOrcaSetupScript(clone.data.path)
    if (script) {
      i.status?.(`在独立 clone ${clone.data.path} 中以外层 seatbelt 运行 orca.yaml 的 setup`)
      const setup = await runCloneSetup(script, {
        dir: clone.data.path,
        prefix: prepared.data.prefix,
        env: { ...i.env, ...scratchEnv },
        timeoutMs: i.setupTimeoutMs ?? 600_000,
        ...(i.run ? { run: i.run } : {}),
      })
      if (!setup.ok) {
        // 刚建好、worker 尚未运行：删除，重试时重新建立并再次运行 setup。
        await removeSealedClone(i.home, i.taskId, { fetchBack: false, ...gitOpts })
        return setup
      }
    }
  }
  return ok({
    dir: clone.data.path,
    fresh: clone.data.fresh,
    prefix: prepared.data.prefix,
    profilePath: prepared.data.profilePath,
    scratchEnv,
  })
}

/**
 * 回滚（开关关闭后再次运行同一任务）：本任务有独立 clone 时，把任务分支取回登记仓库（只快进；不行时取到
 * `raindown/recovered/<任务>`）再删除 clone。返回给用户看的说明；没有 clone 时返回 undefined。取回失败时 clone 保留。
 */
export async function rollbackSealedClone(
  home: string,
  taskId: string,
  o: { run?: CommandRunner; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  if (!existsSync(sealedCloneRecordPath(home, taskId))) return undefined
  const r = await removeSealedClone(home, taskId, {
    fetchBack: true,
    ...(o.run ? { run: o.run } : {}),
    ...(o.env ? { env: o.env } : {}),
  })
  if (!r.ok) return `外层 seatbelt 已关闭，但无法回收独立 clone：${r.error.message}`
  return r.data.recoveredBranch
    ? `外层 seatbelt 已关闭：独立 clone 中的任务分支已取回登记仓库的 ${r.data.recoveredBranch}，clone 已删除`
    : '外层 seatbelt 已关闭：独立 clone 已删除'
}
