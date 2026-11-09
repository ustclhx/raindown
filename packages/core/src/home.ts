import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readRaindownEnv } from './env.ts'

/**
 * 用户数据目录（raindown-home）的位置与布局。所有命令都必须从这里解析路径，
 * 不得在平台代码仓库内写入用户数据（raindown-home spec）。
 */

export type Env = Record<string, string | undefined>

/** 优先新旧环境变量；默认用新目录，只有旧默认目录存在时兼容它。返回绝对路径。 */
export function resolveRaindownHome(env: Env = process.env, home: string = homedir()): string {
  const raw = readRaindownEnv('RAINDOWN_HOME', env)
  if (!raw)
    return join(
      home,
      raindownHomeSource(env, home) === 'legacy-default' ? 'flow-home' : 'raindown-home',
    )
  if (raw === '~') return home
  if (raw.startsWith('~/')) return join(home, raw.slice(2))
  return resolve(raw)
}

export interface RaindownPaths {
  home: string
  config: string
  brain: string
  raw: string
  state: string
  /** `config/workspaces/`：workspace 定义。 */
  workspaces: string
  /** `config/roles/`：角色定义及提示词。 */
  roles: string
  /** brain 中的固定文件。 */
  brainAgents: string
  brainIndex: string
  brainLog: string
  /** `brain/journal/`：按天的日志文件，不是条目。 */
  journal: string
  /** `raw/inbox/`：随手记。 */
  inbox: string
  /** M1 中枢与节点的配置：`config/hub.yaml`、`config/node.yaml`、`config/schedules.yaml`。 */
  hubConfig: string
  nodeConfig: string
  schedulesConfig: string
  /** `config/policies.yaml`：策略规则。 */
  policiesConfig: string
  /** `config/inbox.yaml`：收件箱分级覆盖与推送节奏。 */
  inboxConfig: string
  /** `config/channels.yaml`：推送渠道配置（Telegram 的绑定、代理等）。 */
  channelsConfig: string
  /** `state/telegram.json`：Telegram 长轮询的处理进度（offset）。 */
  telegramState: string
  /** 任务账本 `state/raindown.db`，只由中枢打开（design D1）。 */
  ledgerDb: string
  /** 中枢 token（0600）。 */
  hubToken: string
  /** 中枢单实例锁：SQLite 文件上的排他锁，进程退出（含崩溃）时由操作系统释放。 */
  hubLock: string
  /** 中枢 pid 记录（pid + token），仅供提示与状态查询，不参与互斥。 */
  hubPid: string
  /** 本机节点 id。 */
  nodeId: string
  /** `state/backups/`：账本每日备份。 */
  backups: string
  /** `state/logs/`：中枢与节点日志。 */
  logs: string
  /**
   * `run/`：worker 需要访问的节点运行目录（Raindown 管理的 CODEX_HOME、任务私有目录中的派工令牌），
   * 放在 `state/` 之外，使隔离可以整体拒绝 `state/`（add-worker-credential-isolation D2）。
   */
  run: string
}

/** 需要初始化为独立 git 仓库的子目录；`state/` 不进 git。 */
export const GIT_REPOS = ['config', 'brain', 'raw'] as const
export type RepoName = (typeof GIT_REPOS)[number]

export function raindownPaths(home: string): RaindownPaths {
  const config = join(home, 'config')
  const brain = join(home, 'brain')
  const raw = join(home, 'raw')
  const state = join(home, 'state')
  return {
    home,
    config,
    brain,
    raw,
    state,
    workspaces: join(config, 'workspaces'),
    roles: join(config, 'roles'),
    brainAgents: join(brain, 'AGENTS.md'),
    brainIndex: join(brain, 'index.md'),
    brainLog: join(brain, 'log.md'),
    journal: join(brain, 'journal'),
    inbox: join(raw, 'inbox'),
    hubConfig: join(config, 'hub.yaml'),
    nodeConfig: join(config, 'node.yaml'),
    schedulesConfig: join(config, 'schedules.yaml'),
    policiesConfig: join(config, 'policies.yaml'),
    inboxConfig: join(config, 'inbox.yaml'),
    channelsConfig: join(config, 'channels.yaml'),
    telegramState: join(state, 'telegram.json'),
    ledgerDb: join(state, 'raindown.db'),
    hubToken: join(state, 'hub.token'),
    hubLock: join(state, 'hub.lock'),
    hubPid: join(state, 'hub.pid'),
    nodeId: join(state, 'node-id'),
    backups: join(state, 'backups'),
    logs: join(state, 'logs'),
    run: join(home, 'run'),
  }
}

/** 数据目录来源；旧目录只被继续使用，不做自动移动或复制。 */
export type RaindownHomeSource = 'RAINDOWN_HOME' | 'FLOW_HOME' | 'default' | 'legacy-default'

export function raindownHomeSource(
  env: Env = process.env,
  home: string = homedir(),
): RaindownHomeSource {
  if (env.RAINDOWN_HOME?.trim()) return 'RAINDOWN_HOME'
  if (env.FLOW_HOME?.trim()) return 'FLOW_HOME'
  return !existsSync(join(home, 'raindown-home')) && existsSync(join(home, 'flow-home'))
    ? 'legacy-default'
    : 'default'
}
