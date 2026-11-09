import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { raindownPaths } from '../home.ts'
import { capability } from '../ledger/common.ts'
import { DEFAULT_HUB_PORT, HUB_HOSTNAME } from '../ledger/protocol.ts'
import { fail, ok, type Result } from '../result.ts'
import { formatZodIssues } from '../validation-issue.ts'

/**
 * `config/hub.yaml` 与 `config/node.yaml`（design D6、D10）。
 *
 * 放在 core 而不是 hub / node 各自的包里：中枢、节点、CLI（`raindown daemon status`、
 * `HubClient` 解析中枢地址）都要读 `hub.yaml`，节点还要同时读两份；放在 core 只有一份定义，
 * 也能和其他契约一起导出到 `schemas/config/`。
 *
 * 所有字段可选、有默认值；未知字段视为错误（拼错的键不会被静默忽略）。
 */

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export const hubConfigSchema = z
  .strictObject({
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(DEFAULT_HUB_PORT)
      .meta({ description: `中枢监听端口（只监听 ${HUB_HOSTNAME}），默认 ${DEFAULT_HUB_PORT}` }),
    heartbeat_url: z
      .url({ protocol: /^https?$/ })
      .optional()
      .meta({ description: '外部心跳地址（例如 healthchecks.io）；不配置则不发心跳' }),
    heartbeat_interval_s: z
      .number()
      .int()
      .min(10)
      .default(300)
      .meta({ description: '外部心跳间隔秒数，默认 300' }),
    lease_ttl_s: z
      .number()
      .int()
      .min(5)
      .max(3600)
      .default(60)
      .meta({ description: '租约有效期秒数，默认 60' }),
    lease_wait_max_s: z
      .number()
      .int()
      .min(0)
      .max(300)
      .default(30)
      .meta({ description: '领取租约 long-poll 的最长等待秒数，默认 30' }),
    backup_keep: z
      .number()
      .int()
      .min(1)
      .default(14)
      .meta({ description: '保留的账本备份份数，默认 14' }),
    backup_at: z
      .string()
      .regex(HHMM_RE, '应为 24 小时制 HH:MM')
      .default('03:30')
      .meta({ description: '每日备份的本地时间 HH:MM，默认 03:30' }),
  })
  .meta({ title: 'Raindown hub config', description: 'config/hub.yaml' })
export type HubConfig = z.infer<typeof hubConfigSchema>

export const NODE_RESERVED_DEFAULTS = { supervisor: 1, reply: 1 } as const

/** 节点为 supervisor 预留的执行槽（D12）：领取时作为 `slots.supervisor` / `slots.reply` 上报。 */
export const nodeReservedSchema = z
  .strictObject({
    supervisor: z.number().int().min(0).max(8).default(NODE_RESERVED_DEFAULTS.supervisor).meta({
      description: '只给普通 supervisor 唤醒（instruction / autonomous）的槽位数，默认 1',
    }),
    reply: z
      .number()
      .int()
      .min(0)
      .max(8)
      .default(NODE_RESERVED_DEFAULTS.reply)
      .meta({ description: '只给代回复（reply）唤醒的槽位数，默认 1' }),
  })
  .meta({ title: 'Node reserved slots' })

/**
 * 节点级的 worker 隔离开关（add-worker-credential-isolation 4.1–4.4）。`enforce` 缺省 false：
 * 关闭时各适配器的 harness 启动方式与之前逐字节一致，只声明施加层、不施加；打开后对施加层为 `seatbelt`
 * 的角色以 `/usr/bin/sandbox-exec` 包裹 harness 进程（仅 macOS）。真实开启需用户同意（tasks 4.5）。
 */
export const nodeIsolationSchema = z
  .strictObject({
    enforce: z.boolean().default(false).meta({
      description:
        '是否施加外层 seatbelt（仅 macOS）；缺省 false，只声明不施加。改为 true 后需重启节点；改回 false 即回滚',
    }),
    extra_write: z
      .array(
        z
          .string()
          .min(1)
          .max(1024)
          .refine((p) => p.startsWith('/'), { message: '必须是绝对路径' })
          // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拒绝控制字符
          .refine((p) => !/[\u0000-\u001f\u007f-\u009f]/.test(p), { message: '不能含控制字符' }),
      )
      .max(64)
      .default([])
      .meta({
        description:
          '外层 seatbelt 写白名单之外追加的可写目录（tasks 4.6）；只接受绝对路径，不能是受保护路径、持久化位置（shell 启动文件、~/.ssh、~/.gitconfig 等）、登记仓库、PATH 中的目录、~/Library/Application Support、用户主目录或它们的祖先',
      }),
    dissociate: z.boolean().default(false).meta({
      description:
        '施加外层 seatbelt 时任务的独立 clone 完整复制对象（git clone --no-hardlinks），不经 alternates 引用登记仓库；缺省 false（git clone --shared）',
    }),
  })
  .meta({ title: 'Node worker isolation' })

export const nodeConfigSchema = z
  .strictObject({
    capabilities: z
      .array(capability)
      .default([])
      .meta({ description: '节点声明的能力；执行器插件自动贡献 executor:<type>，不必写出' }),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(64)
      .default(1)
      .meta({ description: '同时执行的任务数，默认 1' }),
    hub_url: z
      .url({ protocol: /^https?$/ })
      .optional()
      .meta({ description: '中枢地址；缺省为 http://127.0.0.1:<hub.yaml 的 port>' }),
    reserved: nodeReservedSchema.default({ ...NODE_RESERVED_DEFAULTS }).meta({
      description:
        '在 concurrency 之外为 supervisor 预留的执行槽（add-m1-supervisor D12）：普通槽满时仍为它们领取任务',
    }),
    isolation: nodeIsolationSchema
      .default({ enforce: false, extra_write: [], dissociate: false })
      .meta({
        description:
          'worker 凭证隔离（add-worker-credential-isolation）；缺省不施加（enforce: false）',
      }),
  })
  .meta({ title: 'Raindown node config', description: 'config/node.yaml' })
export type NodeConfig = z.infer<typeof nodeConfigSchema>

/** 读取并校验一份可选的 YAML 配置：文件不存在或为空时取全部默认值。 */
async function loadYamlConfig<S extends z.ZodType>(
  home: string,
  path: string,
  schema: S,
): Promise<Result<z.infer<S>>> {
  const file = relative(home, path)
  let data: unknown = {}
  if (existsSync(path)) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      return fail('failure', 'read_failed', `无法读取 ${file}：${(err as Error).message}`)
    }
    try {
      data = parse(text) ?? {}
    } catch (err) {
      return fail(
        'failure',
        'invalid_config',
        `${file} 不是合法的 YAML：${(err as Error).message}`,
        [{ file, code: 'invalid_yaml', message: (err as Error).message }],
      )
    }
  }
  const parsed = schema.safeParse(data)
  if (parsed.success) return ok(parsed.data as z.infer<S>)
  const issues = formatZodIssues(parsed.error.issues, data, { file })
  const detail = issues.map((i) => (i.field ? `${i.field}: ${i.message}` : i.message)).join('；')
  return fail('failure', 'invalid_config', `${file} 配置不合法：${detail}`, issues)
}

export const loadHubConfig = (home: string): Promise<Result<HubConfig>> =>
  loadYamlConfig(home, raindownPaths(home).hubConfig, hubConfigSchema)

export const loadNodeConfig = (home: string): Promise<Result<NodeConfig>> =>
  loadYamlConfig(home, raindownPaths(home).nodeConfig, nodeConfigSchema)

/** 节点应连接的中枢地址：node.yaml 的 hub_url 优先，否则用回环地址加 hub.yaml 的端口。 */
export const resolveHubUrl = (hub: Pick<HubConfig, 'port'>, node?: Pick<NodeConfig, 'hub_url'>) =>
  (node?.hub_url ?? `http://${HUB_HOSTNAME}:${hub.port}`).replace(/\/+$/, '')
