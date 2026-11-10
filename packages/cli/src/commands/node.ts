import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  describeCredentialIsolation,
  describeIsolationStatus,
  fail,
  isolationStatusRows,
  loadNodeConfig,
  type NodeView,
  ok,
  raindownPaths,
  renderTable,
  resolveDarwinUserCacheDir,
  resolveRaindownHome,
  rotateLog,
} from '@raindown/core'
import {
  createClaudeSdkExecutor,
  createCodexExecExecutor,
  createCodexOrcaExecutor,
  createFakeExecutor,
  createPrMergeExecutor,
  isolationProbeLaunchWrapper,
  nodeHubClientFromHome,
  resolveOrcaPorts,
  type SeatbeltOptions,
  seatbeltActive,
  startNode,
} from '@raindown/node'
import { defineCommand } from '../command.ts'

/**
 * `raindown node start`：前台运行执行节点，SIGINT / SIGTERM 时优雅退出（停止领取、取消执行器，
 * 不提交结果，租约到期后由中枢按合同处理）。日志写 stderr。
 */
export const nodeStartCommand = defineCommand({
  name: 'node start',
  summary: '在前台运行执行节点：注册到中枢，领取并执行任务（Ctrl-C 退出）',
  run: async () => {
    const home = resolveRaindownHome(process.env)
    const rotated = await rotateLog(join(raindownPaths(home).logs, 'node.log'))
    if (!rotated.ok) return rotated
    // launchd 的标准流仍指向归档文件，退出后由 KeepAlive 重新打开当前日志。
    if (rotated.data && process.env.XPC_SERVICE_NAME === 'dev.raindown.node') {
      return fail('retryable', 'log_rotated', '日志已轮转，等待 launchd 重新启动节点')
    }
    // 外层 seatbelt 开关（config/node.yaml 的 isolation.enforce，缺省 false；worker-credential-isolation 4.1–4.4）。
    // 关闭时各执行器的启动方式与之前一致、探针以恒等包裹运行；打开时（仅 macOS）探针与 worker 用同一 SBPL / permissions profile 生成函数。
    const nodeConfig = await loadNodeConfig(home)
    if (!nodeConfig.ok) return nodeConfig
    // Orca 本机端口只读解析（目录项名 + lsof，不连接 Orca）；未解析时不生成端口规则，探针记为失败（审查第一轮 M2）。
    const orcaPorts = () => resolveOrcaPorts(homedir())
    const isolation: SeatbeltOptions = {
      enforce: nodeConfig.data.isolation.enforce,
      resolveOrcaPorts: orcaPorts,
      // 写白名单之外追加的可写目录（tasks 4.6）；worker 与探针用同一份。
      extraWrite: nodeConfig.data.isolation.extra_write,
      dissociate: nodeConfig.data.isolation.dissociate,
    }
    if (isolation.enforce && !seatbeltActive(isolation))
      console.error(
        'config/node.yaml 的 isolation.enforce 已打开，但外层 seatbelt 只支持 macOS，本机不施加',
      )
    if (seatbeltActive(isolation)) {
      // macOS Security 框架的 mds/（4.5 实测：Codex 校验登录需要写）：解析失败时不放行，Codex 可能无法校验登录（doctor 提示）。
      const cacheDir = await resolveDarwinUserCacheDir()
      if (cacheDir.ok) isolation.darwinUserCacheDir = cacheDir.dir
      else
        console.error(
          `无法解析 DARWIN_USER_CACHE_DIR，外层 seatbelt 不放行 mds：${cacheDir.reason}`,
        )
    }
    // fake 用于端到端测试；其余执行器调用本机的 Orca / Codex、Claude Agent SDK 与 gh。
    const started = await startNode({
      home,
      executors: [
        createFakeExecutor(),
        createCodexOrcaExecutor({ home, isolation }),
        createClaudeSdkExecutor({ home, isolation }),
        createCodexExecExecutor({ home, isolation }),
        // 不调用模型，按确定性条件合并 PR（add-m1-supervisor D10）。
        createPrMergeExecutor({ home }),
      ],
      // 外层 seatbelt 生效时才定期重试 mds 重置通知（开关关闭时不启动定时器）。
      isolationActive: seatbeltActive(isolation),
      // 隔离自检探针：启动时、每 6 小时、macOS 版本变化时运行，结果随注册上报（worker-credential-isolation 3.1）。
      // 探针只判断受保护文件能否打开，不读取内容。
      isolationProbe: {
        resolveOrcaPorts: orcaPorts,
        extraWrite: nodeConfig.data.isolation.extra_write,
        // 与 worker 相同的 mds 放行（4.5），探针配置与 worker 配置一致。
        ...(isolation.darwinUserCacheDir !== undefined
          ? { darwinUserCacheDir: isolation.darwinUserCacheDir }
          : {}),
        // seatbelt 目标以 sandbox-exec 运行，native 目标以 `codex sandbox -P` 运行（profile 与 worker 同源，tasks 5.1）。
        ...(seatbeltActive(isolation)
          ? { launchWrapper: isolationProbeLaunchWrapper(isolation) }
          : {}),
      },
    })
    if (!started.ok) return started
    const node = started.data
    console.error(
      `节点 ${node.nodeId} 已启动，中枢 ${node.hubUrl}，能力：${node.capabilities.join(', ')}`,
    )
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve())
      process.once('SIGTERM', () => resolve())
    })
    await node.stop()
    return ok({ node_id: node.nodeId, stopped: true })
  },
  human: (d) => `节点 ${d.node_id} 已停止`,
})

const lastSeen = (n: NodeView) => n.last_seen_at ?? '—'

/**
 * 每个执行器的凭证隔离声明（worker-credential-isolation 1.3）与隔离自检结果（3.2）：
 * 每个执行器 × 沙箱设置的声明施加层、是否已施加、最近探针时间、失败项（项名与路径）、跳过项与原因。
 * 适配器尚未施加隔离时明确标为“未施加”，不能读成已隔离；旧节点没有探针结果时显示“未探测”。
 */
export function isolationLines(nodes: readonly NodeView[]): string {
  const lines = nodes.flatMap((n) => {
    const rows = isolationStatusRows(n)
    return n.executors.flatMap((e) => [
      `  ${n.node_id} ${e.type}：${describeCredentialIsolation(e.adapter_capabilities)}`,
      ...rows
        .filter((r) => r.executor === e.type && r.setting !== '—')
        .flatMap((r) =>
          describeIsolationStatus(r, '        ').map((l, i) => (i === 0 ? `    ${l}` : l)),
        ),
    ])
  })
  return lines.length
    ? `凭证隔离（按角色沙箱设置声明的施加层与自检结果）：\n${lines.join('\n')}`
    : ''
}

/** `raindown node list`：列出已注册的节点（node-protocol "查看节点"）。 */
export const nodeListCommand = defineCommand({
  name: 'node list',
  summary: '列出已注册的节点：id、主机、能力与最近活动时间',
  run: async ({ actor }) => {
    const client = await nodeHubClientFromHome(resolveRaindownHome(process.env), { actor })
    if (!client.ok) return client
    return client.data.listNodes()
  },
  human: (d) => {
    const table = renderTable(
      d.nodes,
      [
        { header: 'ID', value: (n) => n.node_id },
        { header: '主机', value: (n) => n.hostname },
        { header: '能力', value: (n) => n.capabilities.join(', '), max: 60 },
        { header: '租约', value: (n) => String(n.active_leases) },
        { header: '最近活动', value: lastSeen },
      ],
      '（没有已注册的节点）',
    )
    const isolation = isolationLines(d.nodes)
    return isolation ? `${table}\n\n${isolation}` : table
  },
})
