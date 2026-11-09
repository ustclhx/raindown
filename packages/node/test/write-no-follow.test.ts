import { afterEach, expect, test } from 'bun:test'
import { lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileNoFollow } from '../src/lease-token.ts'

/** 节点往任务私有目录写文件不跟随 worker 预埋的符号链接（add-worker-credential-isolation 审查第二轮 L3）。 */

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

test('目标是预埋的符号链接时替换链接本身，不写入链接目标；目录中不留临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raindown-nofollow-'))
  roots.push(root)
  const victim = join(root, 'victim-zshenv')
  await writeFile(victim, '# original\n')
  const target = join(root, 'pr.diff')
  await symlink(victim, target)
  await writeFileNoFollow(target, 'diff --git a b\n')
  expect(await readFile(victim, 'utf8')).toBe('# original\n')
  expect((await lstat(target)).isSymbolicLink()).toBe(false)
  expect(await readFile(target, 'utf8')).toBe('diff --git a b\n')
  expect(((await lstat(target)).mode & 0o777).toString(8)).toBe('600')
  // 再写一次（覆盖普通文件）同样可行。
  await writeFileNoFollow(target, 'second\n')
  expect(await readFile(target, 'utf8')).toBe('second\n')
  const left = (await import('node:fs')).readdirSync(root).filter((n) => n.endsWith('.tmp'))
  expect(left).toEqual([])
  expect(await readlink(join(root, 'nonexistent')).catch(() => 'none')).toBe('none')
})
