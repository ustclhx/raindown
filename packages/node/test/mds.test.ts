import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ok } from '@raindown/core'
import {
  deliverMdsNotices,
  describeMdsVerification,
  hasPendingMdsNotices,
  MDS_MAX_HASH_BYTES,
  MDS_REPEAT_ESCALATE,
  type MdsNotice,
  mdsBaselineHeld,
  mdsBaselinePath,
  mdsNoticesDir,
  prepareSeatbelt,
  queueMdsNotice,
  recordMdsBaseline,
  recordSeatbeltMdsBaseline,
  setMdsBaselineHold,
  snapshotMds,
  sweepStaleMdsBaselines,
  verifyMdsBaseline,
} from '../src/index.ts'

/**
 * mds 的基线、校验与重置（worker-credential-isolation 4.5，用户 2026-11-10 决定方案 1）。
 * 只用注入的临时目录（结构 `<tmp>/C/mds/…`）与临时 raindown-home，绝不读写真实的 `/private/var/folders/*\/C/mds`。
 */

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function env() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raindown-mds-')))
  roots.push(root)
  const home = join(root, 'raindown-home')
  const cacheDir = join(root, 'C')
  const mds = join(cacheDir, 'mds')
  const outside = join(root, 'outside')
  await mkdir(mds, { recursive: true })
  await mkdir(outside)
  await writeFile(join(mds, 'mds.lock'), '')
  await writeFile(join(mds, 'mdsDirectory.db'), 'DIRECTORY-v1')
  await writeFile(join(mds, 'mdsObject.db'), 'OBJECT-v1')
  await writeFile(join(outside, 'target'), 'KEEP-ME')
  return { root, home, cacheDir, mds, outside }
}

describe('mds 基线与校验重置', () => {
  test('未变化：不删除任何条目，基线文件在校验后删除', async () => {
    const e = await env()
    await recordMdsBaseline(e.home, 't-1', e.mds)
    const path = mdsBaselinePath(e.home, 't-1')
    expect(path).toBe(join(e.home, 'state/tasks/t-1/mds-baseline.json'))
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
    // 基线只记哈希与类型，不含文件内容。
    expect(readFileSync(path, 'utf8')).not.toContain('DIRECTORY-v1')
    const v = await verifyMdsBaseline(e.home, 't-1')
    expect(v).toEqual({ dir: e.mds, reset: [], failed: [] })
    expect(v && describeMdsVerification(v)).toBeUndefined()
    expect((await readdir(e.mds)).sort()).toEqual(['mds.lock', 'mdsDirectory.db', 'mdsObject.db'])
    expect(existsSync(path)).toBe(false)
    // 没有基线时不做任何事。
    expect(await verifyMdsBaseline(e.home, 't-1')).toBeUndefined()
  })

  test('内容变化、新增文件、符号链接与目录：删除这些条目（不跟随链接），未变化的保留，mds 目录本身保留', async () => {
    const e = await env()
    await recordMdsBaseline(e.home, 't-1', e.mds)
    await writeFile(join(e.mds, 'mdsDirectory.db'), 'DIRECTORY-tampered')
    await writeFile(join(e.mds, 'planted.db'), 'x')
    await symlink(join(e.outside, 'target'), join(e.mds, 'link.db'))
    await mkdir(join(e.mds, 'subdir'))
    await symlink(e.outside, join(e.mds, 'subdir', 'escape'))
    const v = await verifyMdsBaseline(e.home, 't-1')
    expect(v?.reset.sort()).toEqual(['link.db', 'mdsDirectory.db', 'planted.db', 'subdir'])
    expect(v?.failed).toEqual([])
    expect((await readdir(e.mds)).sort()).toEqual(['mds.lock', 'mdsObject.db'])
    expect((await lstat(e.mds)).isDirectory()).toBe(true)
    // 链接目标与链接所指目录都没有被删除。
    expect(readFileSync(join(e.outside, 'target'), 'utf8')).toBe('KEEP-ME')
    // 说明只含文件名，不含内容。
    const text = v ? describeMdsVerification(v) : undefined
    expect(text).toContain('mdsDirectory.db')
    expect(text).not.toContain('tampered')
    expect(text).not.toContain('KEEP-ME')
  })

  test('基线已存在时保留（同一次执行中多次准备不覆盖较早的基线）', async () => {
    const e = await env()
    await recordMdsBaseline(e.home, 't-1', e.mds)
    await writeFile(join(e.mds, 'mdsObject.db'), 'OBJECT-tampered')
    await recordMdsBaseline(e.home, 't-1', e.mds)
    // 第二次记录前先按已有基线比较（审查第一轮）：改动的条目已被重置；基线仍是较早的那份。
    expect(existsSync(join(e.mds, 'mdsObject.db'))).toBe(false)
    const b = JSON.parse(readFileSync(mdsBaselinePath(e.home, 't-1'), 'utf8'))
    expect(Object.keys(b.entries)).toContain('mdsObject.db')
    // macOS 重建后内容相同：不再视为变化。
    await writeFile(join(e.mds, 'mdsObject.db'), 'OBJECT-v1')
    const v = await verifyMdsBaseline(e.home, 't-1')
    expect(v?.reset).toEqual([])
  })

  test('mds 目录被换成符号链接：不处理其中内容，报告目录被替换', async () => {
    const e = await env()
    await recordMdsBaseline(e.home, 't-1', e.mds)
    await rm(e.mds, { recursive: true })
    await symlink(e.outside, e.mds)
    const v = await verifyMdsBaseline(e.home, 't-1')
    expect(v?.dirReplaced).toBe(true)
    expect(readFileSync(join(e.outside, 'target'), 'utf8')).toBe('KEEP-ME')
    expect(v && describeMdsVerification(v)).toContain('不是普通目录')
  })

  test('recordSeatbeltMdsBaseline：未配置 darwinUserCacheDir 时不写基线；配置时记录 <dir>/mds', async () => {
    const e = await env()
    expect((await recordSeatbeltMdsBaseline({}, e.home, 't-1')).ok).toBe(true)
    expect(existsSync(mdsBaselinePath(e.home, 't-1'))).toBe(false)
    expect(
      (await recordSeatbeltMdsBaseline({ darwinUserCacheDir: e.cacheDir }, e.home, 't-1')).ok,
    ).toBe(true)
    expect(JSON.parse(readFileSync(mdsBaselinePath(e.home, 't-1'), 'utf8')).dir).toBe(e.mds)
    expect(
      (await recordSeatbeltMdsBaseline({ darwinUserCacheDir: e.cacheDir }, e.home, '../x')).ok,
    ).toBe(false)
  })

  test('prepareSeatbelt：配置 darwinUserCacheDir 时配置放行 mds 并在启动前记录基线；未配置时两者都没有', async () => {
    const e = await env()
    const userHome = join(e.root, 'user')
    const cwd = join(e.root, 'work')
    await mkdir(userHome)
    await mkdir(cwd)
    const input = {
      home: e.home,
      taskId: 't-1',
      executor: 'codex-exec',
      cwd,
      access: 'write' as const,
      hubUrl: 'http://127.0.0.1:7477',
    }
    const base = { enforce: true, platform: 'darwin' as const, userHome, env: {} }
    const off = await prepareSeatbelt(base, input)
    if (!off.ok) throw new Error(off.error.message)
    expect(readFileSync(off.data.profilePath, 'utf8')).not.toContain('/mds"')
    expect(existsSync(mdsBaselinePath(e.home, 't-1'))).toBe(false)
    const on = await prepareSeatbelt({ ...base, darwinUserCacheDir: e.cacheDir }, input)
    if (!on.ok) throw new Error(on.error.message)
    expect(readFileSync(on.data.profilePath, 'utf8')).toContain(`(subpath "${e.mds}")`)
    expect(existsSync(mdsBaselinePath(e.home, 't-1'))).toBe(true)
  })
})

/** 读出待送达的通知（只含任务 id、文件名与收件箱类别）。缺省只列会写收件箱的（不含 inbox=none 的计数通知）。 */
async function notices(
  home: string,
  o: { all?: boolean } = {},
): Promise<Array<{ task: string; files: string[]; inbox?: string; repeats?: unknown }>> {
  const dir = mdsNoticesDir(home)
  if (!existsSync(dir)) return []
  const out: Array<{ task: string; files: string[]; inbox?: string; repeats?: unknown }> = []
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json'))) {
    const n = JSON.parse(readFileSync(join(dir, name), 'utf8')) as MdsNotice
    if (!o.all && n.signal.inbox === 'none') continue
    out.push({
      task: n.task_id,
      files: [...n.signal.files].sort(),
      ...(n.signal.inbox ? { inbox: n.signal.inbox } : {}),
      ...(n.signal.repeats ? { repeats: n.signal.repeats } : {}),
    })
  }
  return out.sort(
    (a, b) => a.task.localeCompare(b.task) || (a.inbox ?? '').localeCompare(b.inbox ?? ''),
  )
}

describe('审查第一轮', () => {
  test('超大文件（稀疏）与 FIFO：不读取内容，直接视为变化并删除', async () => {
    const e = await env()
    await recordMdsBaseline(e.home, 't-1', e.mds)
    // 稀疏的 4 GiB 文件：只截断扩展，不占磁盘；读取整个文件会拖垮节点。
    await writeFile(join(e.mds, 'huge.db'), '')
    await truncate(join(e.mds, 'huge.db'), 4 * 1024 * 1024 * 1024)
    // 刚好超过上限的普通文件也不计算哈希。
    await writeFile(join(e.mds, 'big.db'), Buffer.alloc(MDS_MAX_HASH_BYTES + 1))
    if (process.platform === 'darwin' || process.platform === 'linux')
      spawnSync('/usr/bin/mkfifo', [join(e.mds, 'fifo')])
    const started = Date.now()
    const snap = await snapshotMds(e.mds)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(snap['huge.db']).toEqual({ type: 'other' })
    expect(snap['big.db']).toEqual({ type: 'other' })
    if (existsSync(join(e.mds, 'fifo'))) expect(snap.fifo).toEqual({ type: 'other' })
    const v = await verifyMdsBaseline(e.home, 't-1')
    expect(v?.reset).toEqual(expect.arrayContaining(['big.db', 'huge.db']))
    expect((await readdir(e.mds)).sort()).toEqual(['mds.lock', 'mdsDirectory.db', 'mdsObject.db'])
  })

  test('记录新基线前先与全部已有基线比较：不一致时先重置，并为基线所属任务记通知（含本任务的重新挂接）', async () => {
    const e = await env()
    await recordMdsBaseline(e.home, 't-a', e.mds, { hold: true })
    // t-a 的终端在阻塞期间改动了 mds。
    await writeFile(join(e.mds, 'mdsDirectory.db'), 'tampered-while-blocked')
    await writeFile(join(e.mds, 'planted.db'), 'x')
    // 另一个任务启动前：先比较、重置，再记录自己的基线。
    await recordMdsBaseline(e.home, 't-b', e.mds)
    expect((await readdir(e.mds)).sort()).toEqual(['mds.lock', 'mdsObject.db'])
    expect(await notices(e.home)).toEqual([
      { task: 't-a', files: ['mdsDirectory.db', 'planted.db'] },
    ])
    const b = JSON.parse(readFileSync(mdsBaselinePath(e.home, 't-b'), 'utf8'))
    // 新基线对刚被重置的条目沿用已知良好的哈希（审查第三轮）；基线外的新文件不记。
    const a = JSON.parse(readFileSync(mdsBaselinePath(e.home, 't-a'), 'utf8'))
    expect(b.entries['mdsDirectory.db']).toEqual(a.entries['mdsDirectory.db'])
    expect(b.entries['planted.db']).toBeUndefined()
    // 同一任务重新挂接：已有基线保留，但仍先比较。
    await writeFile(join(e.mds, 'again.db'), 'x')
    await recordMdsBaseline(e.home, 't-a', e.mds, { hold: true })
    expect(existsSync(join(e.mds, 'again.db'))).toBe(false)
    expect((await notices(e.home)).filter((n) => n.files.includes('again.db'))).toHaveLength(2)
  })

  test('hold：执行结束不校验、不删除基线；解除后校验并删除', async () => {
    const e = await env()
    await recordMdsBaseline(e.home, 't-1', e.mds)
    await setMdsBaselineHold(e.home, 't-1', true)
    expect(mdsBaselineHeld(e.home, 't-1')).toBe(true)
    await writeFile(join(e.mds, 'mdsObject.db'), 'tampered')
    expect(await verifyMdsBaseline(e.home, 't-1')).toMatchObject({ held: true })
    expect(existsSync(mdsBaselinePath(e.home, 't-1'))).toBe(true)
    expect(readFileSync(join(e.mds, 'mdsObject.db'), 'utf8')).toBe('tampered')
    await setMdsBaselineHold(e.home, 't-1', false)
    expect(mdsBaselineHeld(e.home, 't-1')).toBe(false)
    expect((await verifyMdsBaseline(e.home, 't-1'))?.reset).toEqual(['mdsObject.db'])
    expect(existsSync(mdsBaselinePath(e.home, 't-1'))).toBe(false)
    expect(await notices(e.home)).toEqual([{ task: 't-1', files: ['mdsObject.db'] }])
  })

  test('节点启动：校验全部残留基线并重置；没有 hold 的删除，hold 的保留', async () => {
    const e = await env()
    await recordMdsBaseline(e.home, 't-1', e.mds)
    await recordMdsBaseline(e.home, 't-2', e.mds, { hold: true })
    await writeFile(join(e.mds, 'planted.db'), 'x')
    expect((await sweepStaleMdsBaselines(e.home)).sort()).toEqual(['t-1', 't-2'])
    expect(existsSync(join(e.mds, 'planted.db'))).toBe(false)
    expect(existsSync(mdsBaselinePath(e.home, 't-1'))).toBe(false)
    expect(existsSync(mdsBaselinePath(e.home, 't-2'))).toBe(true)
    expect((await notices(e.home)).map((n) => n.task)).toContain('t-1')
  })

  test('送达通知：成功与不可重试的拒绝删除通知，可重试的错误保留；日志中的文件名逐个引号转义', async () => {
    const e = await env()
    await queueMdsNotice(e.home, 't-1', ['a.db'])
    await queueMdsNotice(e.home, 't-2', ['evil\nname'])
    expect(hasPendingMdsNotices(e.home)).toBe(true)
    const logs: string[] = []
    await deliverMdsNotices(
      e.home,
      async () => ({ ok: false, error: { kind: 'retryable', code: 'hub_unavailable' } }) as never,
      (m) => logs.push(m),
    )
    expect((await notices(e.home)).length).toBe(2)
    const sent: string[] = []
    await deliverMdsNotices(
      e.home,
      async (n) => {
        sent.push(n.task_id)
        return n.task_id === 't-1'
          ? ok({ recorded: true })
          : ({ ok: false, error: { kind: 'failure', code: 'scope_denied' } } as never)
      },
      (m) => logs.push(m),
    )
    expect(sent.sort()).toEqual(['t-1', 't-2'])
    expect(hasPendingMdsNotices(e.home)).toBe(false)
    expect(logs.some((l) => l.includes('"evil\\nname"'))).toBe(true)
    expect(logs.some((l) => l.includes('evil\nname'))).toBe(false)
    // describeMdsVerification 同样转义。
    expect(describeMdsVerification({ dir: e.mds, reset: ['x\ny'], failed: [] })).toContain(
      '"x\\ny"',
    )
  })
})

describe('审查第三轮：基线只保存已知良好的哈希，通知去重', () => {
  test('审查者的序列：B 写 EVIL1，A 启动时重置，B 再写 EVIL2，B/A/C 结束：EVIL2 被重置，每个任务每个文件只有一条通知', async () => {
    const e = await env()
    const file = join(e.mds, 'mdsDirectory.db')
    await recordMdsBaseline(e.home, 't-b', e.mds, { hold: true })
    await recordMdsBaseline(e.home, 't-c', e.mds)
    await writeFile(file, 'EVIL1')
    await recordMdsBaseline(e.home, 't-a', e.mds)
    expect(existsSync(file)).toBe(false)
    // 重置后、macOS 重建之前，worker 抢先写入：不会被采纳。
    await writeFile(file, 'EVIL2')
    await setMdsBaselineHold(e.home, 't-b', false)
    for (const t of ['t-b', 't-a', 't-c']) await verifyMdsBaseline(e.home, t)
    expect(existsSync(file) && readFileSync(file, 'utf8') === 'EVIL2').toBe(false)
    const inbox = (await notices(e.home)).filter((n) => n.files.includes('mdsDirectory.db'))
    // 每个任务最多一条会写收件箱的通知。
    for (const t of ['t-a', 't-b', 't-c'])
      expect(inbox.filter((n) => n.task === t).length).toBeLessThanOrEqual(1)
    // A 启动时 B、C 的基线看到 EVIL1；A 的基线沿用已知良好哈希，EVIL2 在 B 结束时已被重置。
    expect(inbox.map((n) => n.task).sort()).toEqual(['t-b', 't-c'])
    // 重复的重置只计数，以只写任务事件的通知记下（t-b 被重置两次）。
    const counts = (await notices(e.home, { all: true })).filter((n) => n.inbox === 'none')
    expect(counts).toEqual([
      { task: 't-b', files: ['mdsDirectory.db'], inbox: 'none', repeats: { 'mdsDirectory.db': 2 } },
    ])
  })

  test('hold 的基线 + 3 次内容不同的重建：每次都重置，只有一条通知', async () => {
    const e = await env()
    const file = join(e.mds, 'mdsDirectory.db')
    await recordMdsBaseline(e.home, 't-a', e.mds, { hold: true })
    for (let i = 1; i <= 3; i++) {
      await writeFile(file, `DIRECTORY-rebuilt-${i}`)
      await recordMdsBaseline(e.home, `t-${i}`, e.mds)
      expect({ i, exists: existsSync(file) }).toEqual({ i, exists: false })
    }
    // hold 的基线（t-a）只有一条通知；之后启动的任务的基线各自第一次看到变化时也各有一条。
    expect((await notices(e.home)).filter((n) => n.task === 't-a')).toEqual([
      { task: 't-a', files: ['mdsDirectory.db'] },
    ])
    for (const n of await notices(e.home)) expect(n.files).toEqual(['mdsDirectory.db'])
    const a = JSON.parse(readFileSync(mdsBaselinePath(e.home, 't-a'), 'utf8'))
    expect(a.resets).toEqual({ 'mdsDirectory.db': 3 })
  })

  test('内容与已知良好哈希相同的重建：不重置、不通知；缺失也不算变化', async () => {
    const e = await env()
    const file = join(e.mds, 'mdsDirectory.db')
    await recordMdsBaseline(e.home, 't-a', e.mds, { hold: true })
    await writeFile(file, 'tampered')
    await recordMdsBaseline(e.home, 't-b', e.mds)
    expect(existsSync(file)).toBe(false)
    // 缺失期间启动的任务：不算变化。
    await recordMdsBaseline(e.home, 't-c', e.mds)
    // macOS 以原内容重建。
    await writeFile(file, 'DIRECTORY-v1')
    await recordMdsBaseline(e.home, 't-d', e.mds)
    expect(readFileSync(file, 'utf8')).toBe('DIRECTORY-v1')
    for (const t of ['t-b', 't-c', 't-d'])
      expect((await verifyMdsBaseline(e.home, t))?.reset).toEqual([])
    expect(await notices(e.home)).toEqual([{ task: 't-a', files: ['mdsDirectory.db'] }])
  })

  test('启动时扫描（force + keep）保持一致：内容不同的重建再次重置，只计数不重复通知', async () => {
    const e = await env()
    const file = join(e.mds, 'mdsObject.db')
    await recordMdsBaseline(e.home, 't-a', e.mds, { hold: true })
    await writeFile(file, 'tampered')
    await sweepStaleMdsBaselines(e.home)
    expect(existsSync(file)).toBe(false)
    await writeFile(file, 'OBJECT-rebuilt-differently')
    await sweepStaleMdsBaselines(e.home)
    expect(existsSync(file)).toBe(false)
    expect(await notices(e.home)).toEqual([{ task: 't-a', files: ['mdsObject.db'] }])
    const a = JSON.parse(readFileSync(mdsBaselinePath(e.home, 't-a'), 'utf8'))
    expect(a.resets).toEqual({ 'mdsObject.db': 2 })
  })

  test(`同一基线下同一文件重置超过 ${MDS_REPEAT_ESCALATE} 次：另发一条“反复重置”通知（只一次），并继续重置`, async () => {
    const e = await env()
    const file = join(e.mds, 'mdsObject.db')
    await recordMdsBaseline(e.home, 't-a', e.mds, { hold: true })
    for (let i = 1; i <= MDS_REPEAT_ESCALATE + 3; i++) {
      await writeFile(file, `tampered-${i}`)
      await recordMdsBaseline(e.home, `t-${i}`, e.mds)
      expect(existsSync(file)).toBe(false)
    }
    const forA = (await notices(e.home)).filter((n) => n.task === 't-a')
    expect(forA).toEqual([
      { task: 't-a', files: ['mdsObject.db'] },
      {
        task: 't-a',
        files: ['mdsObject.db'],
        inbox: 'repeated',
        repeats: { 'mdsObject.db': MDS_REPEAT_ESCALATE + 1 },
      },
    ])
  })
})
