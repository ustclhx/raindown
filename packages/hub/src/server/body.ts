import { fail, ok, type Result } from '@raindown/core'
import type { Context } from 'hono'

/**
 * 读取有大小上限的 JSON 请求体：先看 Content-Length（格式不合法或超限直接拒绝），再边读边按实际字节计数，
 * 超限即取消读取；不依赖 Content-Length 的真实性，在 JSON 解析前限制内存。UTF-8 解码失败同样拒绝。
 * 失败一律返回 `invalid_arguments`（文案由调用方给出）。
 */
export async function readLimitedJson(
  c: Context,
  max: number,
  message: string,
): Promise<Result<unknown>> {
  const invalid = () => fail('usage', 'invalid_arguments', message)
  const length = c.req.header('content-length')
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > max)) return invalid()
  const reader = c.req.raw.body?.getReader()
  if (!reader) return invalid()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel()
        return invalid()
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return ok(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch {
    return invalid()
  } finally {
    reader.releaseLock()
  }
}
