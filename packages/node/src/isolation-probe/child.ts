/**
 * 隔离自检探针的子进程入口（add-worker-credential-isolation D6）。由节点以与 worker 相同的包裹方式启动
 * （本阶段为恒等包裹），从 stdin 读取探针清单（JSON），逐项尝试后把结构化结果写到 stdout：
 * `{"items":[{item, target, expected, actual, ok, detail}]}`。
 *
 * 输出只含项名、目标路径与结果，不含任何受保护文件的内容（见 checks.ts）。
 */
import { probePlan } from '@raindown/core'
import { runProbeItems } from './checks.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<number> {
  let raw: unknown
  try {
    raw = JSON.parse(await readStdin())
  } catch {
    process.stderr.write('探针清单不是合法的 JSON\n')
    return 2
  }
  const plan = probePlan.safeParse(raw)
  if (!plan.success) {
    process.stderr.write('探针清单格式不正确\n')
    return 2
  }
  const items = await runProbeItems(plan.data)
  process.stdout.write(`${JSON.stringify({ items })}\n`)
  return 0
}

process.exitCode = await main()
