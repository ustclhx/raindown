import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeMdsVerification,
  mdsBaselinePath,
  prepareSeatbelt,
  recordMdsBaseline,
  recordSeatbeltMdsBaseline,
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
    const v = await verifyMdsBaseline(e.home, 't-1')
    expect(v?.reset).toEqual(['mdsObject.db'])
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
