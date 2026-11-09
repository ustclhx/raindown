import { afterEach, describe, expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_CONFIG_DENY_WRITE,
  CLAUDE_CONFIG_LINKED,
  claudeConfigDir,
  claudeIsolatedEnv,
  prepareClaudeConfigDir,
  userClaudeConfigDir,
} from '../src/claude-config.ts'

/** claude-sdk 的隔离配置目录（worker-credential-isolation 4.6）。全部在临时目录中，不触碰真实的 ~/.claude。 */

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'raindown-claude-config-')))
  roots.push(root)
  const home = join(root, 'raindown-home')
  const user = join(root, 'user/.claude')
  mkdirSync(join(user, 'skills'), { recursive: true })
  writeFileSync(join(user, 'settings.json'), '{}')
  return { root, home, user }
}

describe('prepareClaudeConfigDir', () => {
  test('建立 0700 目录，只读链接用户目录中存在的设置与扩展；幂等；来源消失时删除链接', async () => {
    const s = setup()
    const r = await prepareClaudeConfigDir(s.home, s.user)
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data).toBe(claudeConfigDir(s.home))
    expect(statSync(r.data).mode & 0o777).toBe(0o700)
    expect(readlinkSync(join(r.data, 'settings.json'))).toBe(join(s.user, 'settings.json'))
    expect(readlinkSync(join(r.data, 'skills'))).toBe(join(s.user, 'skills'))
    expect(() => lstatSync(join(r.data, 'CLAUDE.md'))).toThrow()
    // 幂等。
    expect((await prepareClaudeConfigDir(s.home, s.user)).ok).toBe(true)
    rmSync(join(s.user, 'skills'), { recursive: true })
    expect((await prepareClaudeConfigDir(s.home, s.user)).ok).toBe(true)
    expect(() => lstatSync(join(r.data, 'skills'))).toThrow()
  })

  test('同名条目是普通文件时不覆盖；隔离目录是符号链接或与来源相同时拒绝', async () => {
    const s = setup()
    const dir = claudeConfigDir(s.home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{"hooks":{}}')
    const r = await prepareClaudeConfigDir(s.home, s.user)
    expect(!r.ok && r.error.code).toBe('claude_config_failed')
    const same = await prepareClaudeConfigDir(s.home, dir)
    expect(same.ok).toBe(false)
  })

  test('链接的名字都在拒绝写清单内；用户配置目录取 CLAUDE_CONFIG_DIR，缺省 ~/.claude', () => {
    for (const name of CLAUDE_CONFIG_LINKED) expect(CLAUDE_CONFIG_DENY_WRITE).toContain(name)
    for (const name of ['settings.local.json', 'hooks'] as const)
      expect(CLAUDE_CONFIG_DENY_WRITE).toContain(name)
    expect(userClaudeConfigDir({}, '/u')).toBe('/u/.claude')
    expect(userClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/c' }, '/u')).toBe('/c')
  })

  test('隔离环境变量：钥匙串条目按用户原来的配置目录计算，临时目录不用 /tmp/claude-<uid>', () => {
    expect(claudeIsolatedEnv({}, '/r/cfg', '/t')).toEqual({
      CLAUDE_CONFIG_DIR: '/r/cfg',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      CLAUDE_CODE_TMPDIR: '/t',
    })
    expect(claudeIsolatedEnv({ CLAUDE_CONFIG_DIR: '/c' }, '/r/cfg', '/t')).toMatchObject({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/c',
    })
    expect(
      claudeIsolatedEnv(
        { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/s', CLAUDE_CODE_TMPDIR: '/x' },
        '/r',
        '/t',
      ),
    ).toMatchObject({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '/s', CLAUDE_CODE_TMPDIR: '/x' })
  })
})
