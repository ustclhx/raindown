import type { z } from 'zod'
import { hubConfigSchema, nodeConfigSchema } from '../daemon/config.ts'
import { schedulesConfigSchema } from '../daemon/schedule-schema.ts'
import { EVENT_TYPES, eventSchemas, ledgerEvent } from './events.ts'
import { createTaskRequest, ENDPOINTS, errorBody, okBody } from './protocol.ts'
import { activity, reviewOutput, taskResult, taskStatus, taskView } from './task.ts'

export * from './adapter.ts'
export * from './attempts.ts'
export * from './common.ts'
export * from './delegation.ts'
export * from './events.ts'
export * from './isolation-probe.ts'
export * from './pr-input.ts'
export * from './pr-subscription.ts'
export * from './protocol.ts'
export * from './read-pointer.ts'
export * from './recovery.ts'
export * from './redact.ts'
export * from './review.ts'
export * from './stage.ts'
export * from './supervisor-api.ts'
export * from './task.ts'
export * from './worker-input.ts'
export * from './worker-report.ts'

type SchemaEntry = { schema: z.ZodType; io: 'input' | 'output' }

/**
 * 任务、事件、协议与守护进程配置的 JSON Schema（相对 `schemas/` 的路径 → schema）。
 * - 调用方写入的数据（合同、请求体、配置）用 input 形态：带默认值的字段可省略；
 * - 中枢产生的数据（事件、响应、任务视图）用 output 形态：默认值已补齐。
 */
export function ledgerSchemaEntries(): Record<string, SchemaEntry> {
  const out: Record<string, SchemaEntry> = {
    'tasks/contract.schema.json': { schema: createTaskRequest, io: 'input' },
    'tasks/result.schema.json': { schema: taskResult, io: 'input' },
    'tasks/task.schema.json': { schema: taskView, io: 'output' },
    'tasks/status.schema.json': { schema: taskStatus, io: 'output' },
    'tasks/activity.schema.json': { schema: activity, io: 'input' },
    // 审查会话的结构化输出（SDK outputFormat: json_schema，add-m1-supervisor D10）。
    'tasks/review-output.schema.json': { schema: reviewOutput, io: 'input' },
    'events/event.schema.json': { schema: ledgerEvent, io: 'output' },
    'protocol/error.schema.json': { schema: errorBody, io: 'output' },
    'config/hub.schema.json': { schema: hubConfigSchema, io: 'input' },
    'config/schedules.schema.json': { schema: schedulesConfigSchema, io: 'input' },
    'config/node.schema.json': { schema: nodeConfigSchema, io: 'input' },
  }
  for (const type of EVENT_TYPES) {
    out[`events/${type}.schema.json`] = { schema: eventSchemas[type], io: 'output' }
  }
  for (const [name, def] of Object.entries(ENDPOINTS)) {
    if ('request' in def) {
      out[`protocol/${name}.request.schema.json`] = { schema: def.request, io: 'input' }
    }
    const response = 'stream' in def ? def.response : okBody(def.response)
    out[`protocol/${name}.response.schema.json`] = { schema: response, io: 'output' }
  }
  return out
}
