import { join } from 'node:path'
import {
  describeCredentialIsolation,
  fail,
  type NodeView,
  ok,
  raindownPaths,
  renderTable,
  resolveRaindownHome,
  rotateLog,
} from '@raindown/core'
import {
  createClaudeSdkExecutor,
  createCodexExecExecutor,
  createCodexOrcaExecutor,
  createFakeExecutor,
  createPrMergeExecutor,
  nodeHubClientFromHome,
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
    // fake 用于端到端测试；其余执行器调用本机的 Orca / Codex、Claude Agent SDK 与 gh。
    const started = await startNode({
      home,
      executors: [
        createFakeExecutor(),
        createCodexOrcaExecutor({ home }),
        createClaudeSdkExecutor({ home }),
        createCodexExecExecutor({ home }),
        // 不调用模型，按确定性条件合并 PR（add-m1-supervisor D10）。
        createPrMergeExecutor({ home }),
      ],
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
 * 每个执行器的凭证隔离声明（worker-credential-isolation 1.3）。目前只是声明将要支持的施加层，
 * 尚未施加，明确标为“未施加”，不能读成已隔离。
 */
export function isolationLines(nodes: readonly NodeView[]): string {
  const lines = nodes.flatMap((n) =>
    n.executors.map(
      (e) => `  ${n.node_id} ${e.type}：${describeCredentialIsolation(e.adapter_capabilities)}`,
    ),
  )
  return lines.length ? `凭证隔离（按角色沙箱设置声明的施加层）：\n${lines.join('\n')}` : ''
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
