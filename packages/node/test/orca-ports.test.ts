import { afterEach, describe, expect, test } from 'bun:test'
import type { Dirent } from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLsofPorts, resolveOrcaPorts } from '../src/orca-ports.ts'

/**
 * Orca 本机端口的只读解析（审查第一轮 M2）。目录项与 lsof 都是注入的：测试不读取真实的 Orca 目录、不运行 lsof。
 */

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const socket = (name: string, isSocket = true) =>
  ({ name, isSocket: () => isSocket }) as unknown as Dirent

describe('Orca 端口解析', () => {
  test('lsof -Fn 输出：IPv4、IPv6、通配地址都取端口，去重排序', () => {
    expect(parseLsofPorts('p123\nf20\nn127.0.0.1:60211\nf21\nn*:10129\nn[::1]:60211\n')).toEqual([
      10129, 60211,
    ])
    expect(parseLsofPorts('')).toEqual([])
  })

  test('没有 Orca 运行时目录：本机没有 Orca，返回空列表（不拒绝任何端口）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'raindown-orca-ports-'))
    roots.push(root)
    expect(await resolveOrcaPorts(join(root, 'user'))).toEqual([])
  })

  test('从 app 控制套接字名取 pid，再用 lsof 读取监听端口', async () => {
    const calls: string[][] = []
    const ports = await resolveOrcaPorts('/u', {
      readDir: async () => [
        socket('o-4242-ab12.sock'),
        socket('o-4242-ab12.sock.lock', false),
        socket('daemon', false),
        socket('other.sock'),
      ],
      lsof: async (args) => {
        calls.push([...args])
        return { code: 0, stdout: 'p4242\nn127.0.0.1:60211\nn*:10129\n' }
      },
    })
    expect(ports).toEqual([10129, 60211])
    expect(calls).toEqual([['-nP', '-a', '-p', '4242', '-iTCP', '-sTCP:LISTEN', '-Fn']])
  })

  test.each([
    ['没有 app 套接字', [socket('other.sock')], { code: 0, stdout: '' }, '没有 app 控制套接字'],
    ['进程已退出或没有监听端口', [socket('o-1-x.sock')], { code: 1, stdout: '' }, '没有找到'],
    ['lsof 失败', [socket('o-1-x.sock')], { code: 2, stdout: '' }, 'lsof 失败'],
  ])('%s：抛错（调用方按未解析处理）', async (_name, entries, lsofResult, message) => {
    await expect(
      resolveOrcaPorts('/u', { readDir: async () => entries, lsof: async () => lsofResult }),
    ).rejects.toThrow(message)
  })

  test('真实目录：只看目录项类型，普通文件不当作套接字', async () => {
    const root = mkdtempSync(join(tmpdir(), 'raindown-orca-ports-'))
    roots.push(root)
    const dir = join(root, 'Library', 'Application Support', 'orca')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'o-1-x.sock'), '')
    await expect(
      resolveOrcaPorts(root, { lsof: async () => ({ code: 0, stdout: 'n*:1\n' }) }),
    ).rejects.toThrow('没有 app 控制套接字')
  })
})
