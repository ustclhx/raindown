import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadNodeConfig, resolveHubUrl } from '../src/index.ts'

test('节点包骨架：从临时 raindown-home 读取默认配置', async () => {
  const home = join(mkdtempSync(join(tmpdir(), 'raindown-node-')), 'home')
  const r = await loadNodeConfig(home)
  expect(r).toEqual({
    ok: true,
    data: {
      capabilities: [],
      concurrency: 1,
      reserved: { supervisor: 1, reply: 1 },
      isolation: { enforce: false, extra_write: [], dissociate: false },
    },
  })
  expect(resolveHubUrl({ port: 7477 }, r.ok ? r.data : undefined)).toBe('http://127.0.0.1:7477')
})
