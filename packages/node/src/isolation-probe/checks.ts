import { randomBytes } from 'node:crypto'
import { open, rename, symlink, unlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import {
  type IsolationProbeItem,
  type ProbePlan,
  type ProbePlanItem,
  probeTempPath,
} from '@raindown/core'

/**
 * 探针子进程逐项尝试的实现（add-worker-credential-isolation D6，tasks 3.1）。
 *
 * **绝不读出受保护文件的内容**：读项只打开文件并读取最多 1 字节，字节写进一个 1 字节缓冲区后立即清零丢弃；
 * 结果只记录成功与否和错误码（`err.code`），不记录 `err.message`、不记录读到的字节。
 * 连接项只建立连接后立即关闭，不发送任何数据。
 */

/** 可注入的系统接口（测试用它模拟"拒绝"，不依赖 chmod 或真实 seatbelt）。 */
export interface ProbeSystem {
  /** 打开并读取最多 1 字节；成功返回读到的字节数（内容不返回）。 */
  readOneByte(path: string): Promise<number>
  /** 以独占方式新建文件（不写内容）；删除由调用方随后用 `unlink` 完成。 */
  createExclusive(path: string): Promise<void>
  symlink(target: string, path: string): Promise<void>
  unlink(path: string): Promise<void>
  /** 以读写方式打开已有文件后立即关闭（不写入、不截断）。 */
  openWrite(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  connectUnix(path: string, timeoutMs: number): Promise<void>
  connectTcp(host: string, port: number, timeoutMs: number): Promise<void>
  /** GET 并返回状态码；不读取响应正文。 */
  httpGet(url: string, timeoutMs: number): Promise<number>
  random(): string
}

const errCode = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN'
}

/** 默认系统接口：真实文件系统与网络。 */
export const realProbeSystem: ProbeSystem = {
  async readOneByte(path) {
    const fh = await open(path, 'r')
    const buf = Buffer.alloc(1)
    try {
      const { bytesRead } = await fh.read(buf, 0, 1, 0)
      return bytesRead
    } finally {
      buf.fill(0)
      await fh.close()
    }
  },
  async createExclusive(path) {
    const fh = await open(path, 'wx', 0o600)
    await fh.close()
  },
  symlink: (target, path) => symlink(target, path),
  unlink: (path) => unlink(path),
  async openWrite(path) {
    const fh = await open(path, 'r+')
    await fh.close()
  },
  rename: (from, to) => rename(from, to),
  connectUnix: (path, timeoutMs) => connectOnce(() => createConnection({ path }), timeoutMs),
  connectTcp: (host, port, timeoutMs) =>
    connectOnce(() => createConnection({ host, port }), timeoutMs),
  async httpGet(url, timeoutMs) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    await res.body?.cancel().catch(() => {})
    return res.status
  },
  random: () => randomBytes(8).toString('hex'),
}

/** 建立连接后立即销毁，不写任何数据。 */
function connectOnce(
  make: () => ReturnType<typeof createConnection>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = make()
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve()
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    })
  })
}

const DENIED = new Set(['EACCES', 'EPERM', 'EROFS'])

type Outcome = Pick<IsolationProbeItem, 'actual' | 'detail'>

/** 文件类操作的错误归类：权限错误为拒绝，目标不存在为跳过，其余为错误。 */
function fileOutcome(err: unknown): Outcome {
  const code = errCode(err)
  if (DENIED.has(code)) return { actual: 'deny', detail: code }
  if (code === 'ENOENT' || code === 'ENOTDIR')
    return { actual: 'skipped', detail: `目标不存在（${code}），无法验证` }
  return { actual: 'error', detail: code }
}

/**
 * 连接类错误归类。ECONNREFUSED 记为拒绝并注明歧义：seatbelt 拒绝 unix 套接字连接时 bun 报的也是 ECONNREFUSED
 * （见 docs/executors.md「隔离实测」第 3 点），与失效套接字、没有监听的端口无法区分。
 */
function connectOutcome(err: unknown): Outcome {
  const code = errCode(err)
  if (DENIED.has(code)) return { actual: 'deny', detail: code }
  if (code === 'ECONNREFUSED')
    return {
      actual: 'deny',
      detail: 'ECONNREFUSED（被拒绝；也可能是套接字失效或端口无人监听，无法区分）',
    }
  if (code === 'ENOENT') return { actual: 'skipped', detail: '套接字不存在（ENOENT），无法验证' }
  return { actual: 'error', detail: code }
}

async function attempt(item: ProbePlanItem, plan: ProbePlan, sys: ProbeSystem): Promise<Outcome> {
  const target = item.target ?? ''
  const timeout = plan.connect_timeout_ms
  switch (item.kind) {
    case 'read':
      try {
        await sys.readOneByte(target)
        return { actual: 'allow' }
      } catch (err) {
        return fileOutcome(err)
      }
    case 'read_via_symlink': {
      if (item.link) {
        // 节点在沙箱外预先建好的链接（见 probePlanItem.link）：只读取，不删除（随探针工作目录一起清理）。
        try {
          await sys.readOneByte(item.link)
          return { actual: 'allow' }
        } catch (err) {
          return fileOutcome(err)
        }
      }
      const link = probeTempPath(plan.workdir, `link-${sys.random()}`)
      try {
        await sys.symlink(target, link)
      } catch (err) {
        return { actual: 'error', detail: `无法在工作目录建立符号链接（${errCode(err)}）` }
      }
      try {
        await sys.readOneByte(link)
        return { actual: 'allow' }
      } catch (err) {
        return fileOutcome(err)
      } finally {
        await sys.unlink(link).catch(() => {})
      }
    }
    case 'write_new': {
      const path = probeTempPath(target, sys.random())
      try {
        // 成功即立即删除（受保护目录意外可写时不留下探针文件）。
        await sys.createExclusive(path)
      } catch (err) {
        return fileOutcome(err)
      }
      // 新建成功即为“可写”（不论之后能否删除）；随后立即删除，删除失败时在说明中写出残留路径
      // （节点启动清理会删除 config/ 下残留的探针文件）。
      try {
        await sys.unlink(path)
        return { actual: 'allow' }
      } catch (err) {
        return { actual: 'allow', detail: `探针文件未能删除，残留 ${path}（${errCode(err)}）` }
      }
    }
    case 'create_file':
      // 只用于探针自建的临时目录（模拟的 shell 启动文件、临时仓库的 .git/hooks）；成功即为“可写”，随后立即删除。
      try {
        await sys.createExclusive(target)
      } catch (err) {
        return fileOutcome(err)
      }
      try {
        await sys.unlink(target)
        return { actual: 'allow' }
      } catch (err) {
        return { actual: 'allow', detail: `探针文件未能删除，残留 ${target}（${errCode(err)}）` }
      }
    case 'open_write':
      try {
        await sys.openWrite(target)
        return { actual: 'allow' }
      } catch (err) {
        return fileOutcome(err)
      }
    case 'rename': {
      // 只用于探针自建的临时目录（见 buildProbePlan 的 renameTarget）；成功即为“可改名”，随后立即改回。
      const moved = `${target}.moved-${sys.random()}`
      try {
        await sys.rename(target, moved)
      } catch (err) {
        return fileOutcome(err)
      }
      try {
        await sys.rename(moved, target)
        return { actual: 'allow' }
      } catch (err) {
        return { actual: 'allow', detail: `改名后未能改回，残留 ${moved}（${errCode(err)}）` }
      }
    }
    case 'unix_connect':
      try {
        await sys.connectUnix(target, timeout)
        return { actual: 'allow' }
      } catch (err) {
        return connectOutcome(err)
      }
    case 'tcp_connect': {
      const m = /^(.+):(\d{1,5})$/.exec(target)
      if (!m) return { actual: 'error', detail: '目标不是 host:port' }
      try {
        await sys.connectTcp(m[1] as string, Number(m[2]), timeout)
        return { actual: 'allow' }
      } catch (err) {
        return connectOutcome(err)
      }
    }
    case 'http_get':
      try {
        const status = await sys.httpGet(target, timeout)
        return status >= 200 && status < 300
          ? { actual: 'allow' }
          : { actual: 'error', detail: `HTTP ${status}` }
      } catch (err) {
        const cause = (err as { cause?: unknown }).cause
        return connectOutcome(cause ?? err)
      }
    case 'process_debug':
      return { actual: 'unverified', detail: '探针不实现跨进程调试检查' }
  }
}

/** 逐项尝试，返回结构化结果 `{item, target, expected, actual, ok, detail}`。 */
export async function runProbeItems(
  plan: ProbePlan,
  sys: ProbeSystem = realProbeSystem,
): Promise<IsolationProbeItem[]> {
  const out: IsolationProbeItem[] = []
  for (const item of plan.items) {
    let outcome: Outcome
    if (item.fail !== undefined) outcome = { actual: 'error', detail: item.fail }
    else if (item.skip !== undefined) outcome = { actual: 'skipped', detail: item.skip }
    else if (item.unverified !== undefined)
      outcome = { actual: 'unverified', detail: item.unverified }
    else outcome = await attempt(item, plan, sys)
    const ok =
      outcome.actual === 'skipped' || outcome.actual === 'unverified'
        ? null
        : outcome.actual === item.expected
    out.push({
      item: item.item,
      ...(item.target === undefined ? {} : { target: item.target }),
      expected: item.expected,
      actual: outcome.actual,
      ok,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail.slice(0, 500) }),
    })
  }
  return out
}
