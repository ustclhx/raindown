import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ORCA_RUNTIME_DIR } from '@raindown/core'

/**
 * Orca 本机 TCP 端口的只读解析（add-worker-credential-isolation D2，审查第一轮 M2）。不连接 Orca、不运行 orca 命令、
 * 不 attach 任何进程：
 * 1. 列出 Orca 运行时目录（`~/Library/Application Support/orca/`）中的 app 控制套接字 `o-<app pid>-<runtimeId 前缀>.sock`
 *    （1.1 实测的命名，只看目录项名字与类型，不读文件内容），得到 Orca app 进程的 pid；
 * 2. 用 `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN -Fn` 读取该进程正在监听的 TCP 端口（内核信息，不连接）。
 *
 * - 没有 Orca 运行时目录：返回空列表（本机没有 Orca，没有要拒绝的端口）；
 * - 目录存在但找不到 app 套接字、lsof 失败或没有任何监听端口（Orca 未运行等）：抛错，调用方按“未解析”处理：
 *   不生成端口规则，探针把 `connect.orca_port` 记为失败，该执行器不能显示为已施加。
 * 只解析 app 进程的端口；Orca 守护进程（`daemon/`）不在套接字名里带 pid，不在范围内。
 */

export const LSOF = '/usr/sbin/lsof'
const APP_SOCKET = /^o-(\d{1,9})-[A-Za-z0-9]{1,64}\.sock$/

export type LsofRunner = (args: readonly string[]) => Promise<{ code: number; stdout: string }>

export const defaultLsof: LsofRunner = (args) =>
  new Promise((resolve) => {
    execFile(LSOF, [...args], { timeout: 5_000, maxBuffer: 256_000 }, (err, stdout) => {
      const raw = (err as { code?: unknown } | null)?.code
      const code = !err ? 0 : typeof raw === 'number' ? raw : -1
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })

/** 解析 `lsof -Fn` 输出中的监听端口（`n127.0.0.1:60211`、`n*:10129`、`n[::1]:60211`）。 */
export function parseLsofPorts(stdout: string): number[] {
  const ports = new Set<number>()
  for (const line of stdout.split('\n')) {
    const m = /^n.*:(\d{1,5})$/.exec(line.trim())
    const port = m ? Number(m[1]) : Number.NaN
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

export interface OrcaPortOptions {
  readDir?: (path: string) => Promise<Dirent[]>
  lsof?: LsofRunner
}

export async function resolveOrcaPorts(
  userHome: string,
  o: OrcaPortOptions = {},
): Promise<number[]> {
  const root = join(userHome, ORCA_RUNTIME_DIR)
  let entries: Dirent[]
  try {
    entries = await (o.readDir ?? ((p) => readdir(p, { withFileTypes: true })))(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(
      `无法列出 Orca 运行时目录（${(err as NodeJS.ErrnoException).code ?? 'UNKNOWN'}）`,
    )
  }
  const pids = [
    ...new Set(
      entries
        .filter((e) => e.isSocket())
        .map((e) => APP_SOCKET.exec(e.name)?.[1])
        .filter((p): p is string => p !== undefined),
    ),
  ]
  if (pids.length === 0) throw new Error('Orca 运行时目录中没有 app 控制套接字（o-<pid>-*.sock）')
  const lsof = o.lsof ?? defaultLsof
  const ports = new Set<number>()
  for (const pid of pids) {
    const r = await lsof(['-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN', '-Fn'])
    // lsof 找不到匹配项时退出码为 1 且没有输出（进程已退出或没有监听端口）。
    if (r.code !== 0 && r.code !== 1) throw new Error(`lsof 失败（退出码 ${r.code}）`)
    for (const p of parseLsofPorts(r.stdout)) ports.add(p)
  }
  if (ports.size === 0)
    throw new Error('没有找到 Orca 进程监听的本机 TCP 端口（Orca 未运行或 lsof 没有结果）')
  return [...ports].sort((a, b) => a - b)
}
