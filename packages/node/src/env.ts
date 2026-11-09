import {
  fail,
  HUB_TOKEN_ENV,
  HUB_TOKEN_FILE_ENV,
  isDeclarableActor,
  isValidActor,
  ok,
  type Result,
} from '@raindown/core'

/**
 * 节点 spawn 执行器、worker 与验收命令时使用的环境变量（design D9）。
 *
 * 去掉中枢凭证 `RAINDOWN_HUB_TOKEN` 与 `RAINDOWN_HUB_TOKEN_FILE`：它是节点自己的绑定 token，不能被任务里运行的任意代码继承。
 * 所有执行器都应通过它（或 `ExecutorContext.env`）拿 env，不要直接把 `process.env` 传给子进程。
 */
export const CHILD_ENV_DENYLIST: readonly string[] = [
  HUB_TOKEN_ENV,
  HUB_TOKEN_FILE_ENV,
  'RAINDOWN_LEASE_TOKEN_FILE',
  'FLOW_LEASE_TOKEN_FILE',
  // 中枢地址只由适配器随派工令牌显式设置；节点自身环境中的值不继承，避免把 MCP 指向别处。
  'RAINDOWN_HUB_URL',
  'FLOW_HUB_URL',
  'FLOW_HUB_TOKEN',
  'FLOW_HUB_TOKEN_FILE',
]

// 过渡期向旧版 CLI 与脚本同时传递旧名；调用方只声明新名。
export function dualRaindownEnv(
  values: Record<`RAINDOWN_${string}`, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([name, value]) => [
      [name, value],
      [name.replace(/^RAINDOWN_/, 'FLOW_'), value],
    ]),
  )
}

export function executorEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of CHILD_ENV_DENYLIST) delete env[key]
  return env
}

/** 执行器角色只能声明普通 AI 身份；不能回退为 user 或替换成其他名字。 */
export function executorRoleEnv(
  actor: string,
  base: NodeJS.ProcessEnv = process.env,
): Result<NodeJS.ProcessEnv> {
  if (actor === 'user' || !isValidActor(actor) || !isDeclarableActor(actor)) {
    return fail('usage', 'invalid_actor', `角色 ${actor} 不能声明为执行器的 AI 身份`)
  }
  return ok({ ...executorEnv(base), ...dualRaindownEnv({ RAINDOWN_ACTOR: actor }) })
}
