import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  execCodexHome,
  migrateCodexHomes,
  orcaCodexHome,
  prepareCodexHome,
  readCodexHome,
  sameCodexHome,
} from '../src/codex-home.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'raindown-codex-home-'))
  dirs.push(root)
  const home = join(root, 'raindown-home')
  const source = join(root, 'auth-source')
  mkdirSync(source)
  writeFileSync(join(source, 'auth.json'), '{"placeholder":true}')
  const isolated = orcaCodexHome(home)
  mkdirSync(isolated, { recursive: true })
  return { root, home, source, isolated }
}

describe('Raindown 管理的 Codex 目录', () => {
  test('重建配置与扩展不影响会话和用户源目录', async () => {
    const s = setup()
    const sourceConfig = join(s.source, 'config.toml')
    writeFileSync(sourceConfig, 'notify = ["source-notify"]\n')
    symlinkSync(sourceConfig, join(s.isolated, 'config.toml'))
    for (const name of ['rules', 'skills', 'plugins']) {
      mkdirSync(join(s.isolated, name))
      writeFileSync(join(s.isolated, name, 'old'), '污染扩展')
    }
    for (const name of ['hooks.json', 'AGENTS.md', 'AGENTS.override.md'])
      writeFileSync(join(s.isolated, name), '污染扩展')
    mkdirSync(join(s.isolated, 'sessions'))
    const session = join(s.isolated, 'sessions', 'session.jsonl')
    writeFileSync(session, '会话状态')

    expect(await prepareCodexHome(s.isolated, s.source)).toEqual({ ok: true, data: s.isolated })
    expect(lstatSync(join(s.isolated, 'config.toml')).isSymbolicLink()).toBe(false)
    const config = readFileSync(join(s.isolated, 'config.toml'), 'utf8')
    expect(config.split('\n').every((line) => !line.trim() || line.startsWith('#'))).toBe(true)
    expect(readFileSync(sourceConfig, 'utf8')).toBe('notify = ["source-notify"]\n')
    for (const name of [
      'rules',
      'skills',
      'plugins',
      'hooks.json',
      'AGENTS.md',
      'AGENTS.override.md',
    ])
      expect(existsSync(join(s.isolated, name))).toBe(false)
    expect(readlinkSync(join(s.isolated, 'auth.json'))).toBe(join(s.source, 'auth.json'))
    expect(await prepareCodexHome(s.isolated, s.source)).toEqual({ ok: true, data: s.isolated })
    expect(readFileSync(session, 'utf8')).toBe('会话状态')
  })

  test('读目录保持固定，两个执行器的写目录与会话状态独立', async () => {
    const s = setup()
    const orca = orcaCodexHome(s.home)
    const exec = execCodexHome(s.home)
    expect(readCodexHome(s.home)).toBe(
      join(s.home, 'run', 'executors', 'codex-exec', 'codex-read-home'),
    )
    expect(orca).toBe(join(s.home, 'run', 'executors', 'codex-orca', 'codex-home'))
    expect(exec).toBe(join(s.home, 'run', 'executors', 'codex-exec', 'codex-home'))
    for (const dir of [orca, exec]) {
      expect(await prepareCodexHome(dir, s.source)).toEqual({ ok: true, data: dir })
      mkdirSync(join(dir, 'sessions'))
      writeFileSync(join(dir, 'sessions', 'session.jsonl'), dir)
      expect(readlinkSync(join(dir, 'auth.json'))).toBe(join(s.source, 'auth.json'))
    }
    expect(await prepareCodexHome(orca, s.source)).toEqual({ ok: true, data: orca })
    expect(readFileSync(join(orca, 'sessions', 'session.jsonl'), 'utf8')).toBe(orca)
    expect(readFileSync(join(exec, 'sessions', 'session.jsonl'), 'utf8')).toBe(exec)
  })

  test('恢复目录按 realpath 比较，接受符号链接与路径规范化别名', async () => {
    const s = setup()
    const alias = join(s.root, 'alias')
    symlinkSync(s.isolated, alias)
    mkdirSync(join(s.isolated, 'child'))
    expect(await sameCodexHome(alias, s.isolated)).toBe(true)
    expect(await sameCodexHome(s.isolated, alias)).toBe(true)
    expect(await sameCodexHome(`${s.isolated}/child/..`, s.isolated)).toBe(true)
  })

  test('恢复目录未知、不同、缺失或无法解析时拒绝', async () => {
    const s = setup()
    const missing = join(s.root, 'missing')
    const loop = join(s.root, 'loop')
    symlinkSync(loop, loop)
    expect(await sameCodexHome(undefined, s.isolated)).toBe(false)
    expect(await sameCodexHome(s.source, s.isolated)).toBe(false)
    expect(await sameCodexHome(missing, s.isolated)).toBe(false)
    expect(await sameCodexHome(s.isolated, missing)).toBe(false)
    expect(await sameCodexHome(missing, missing)).toBe(false)
    expect(await sameCodexHome(loop, s.isolated)).toBe(false)
    expect(await sameCodexHome(s.isolated, loop)).toBe(false)
  })

  test('清理期间其他 worker 刷新成普通 auth 文件时保留并拒绝启动', async () => {
    const s = setup()
    mkdirSync(join(s.isolated, 'rules'))
    // 模拟有积累规则的共享目录，留出真实文件监听事件送达的时间窗。
    for (let i = 0; i < 2000; i++) writeFileSync(join(s.isolated, 'rules', `${i}.rules`), '')
    const auth = join(s.isolated, 'auth.json')
    let refreshed = false
    const watcher = watch(s.isolated, (_, name) => {
      if (refreshed || name !== 'config.toml') return
      refreshed = true
      writeFileSync(auth, '刷新后的凭证占位')
    })
    try {
      const result = await prepareCodexHome(s.isolated, s.source)
      expect(refreshed).toBe(true)
      expect(result).toMatchObject({ ok: false, error: { code: 'codex_home_failed' } })
      expect(lstatSync(auth).isFile()).toBe(true)
      expect(readFileSync(auth, 'utf8')).toBe('刷新后的凭证占位')
    } finally {
      watcher.close()
    }
  })

  test('清除 rules 符号链接只删除链接，不触碰源目录', async () => {
    const s = setup()
    mkdirSync(join(s.source, 'rules'))
    const rule = join(s.source, 'rules', 'user.rules')
    writeFileSync(rule, '用户审批规则')
    symlinkSync(join(s.source, 'rules'), join(s.isolated, 'rules'))
    expect((await prepareCodexHome(s.isolated, s.source)).ok).toBe(true)
    expect(existsSync(join(s.isolated, 'rules'))).toBe(false)
    expect(readFileSync(rule, 'utf8')).toBe('用户审批规则')
  })

  test('隔离目录自身是符号链接时拒绝，不能改写用户配置和规则', async () => {
    const s = setup()
    const config = join(s.source, 'config.toml')
    writeFileSync(config, '用户配置')
    rmSync(s.isolated, { recursive: true })
    symlinkSync(s.source, s.isolated)
    expect(await prepareCodexHome(s.isolated, s.source)).toMatchObject({
      ok: false,
      error: { code: 'codex_home_failed' },
    })
    expect(readFileSync(config, 'utf8')).toBe('用户配置')
    expect(readFileSync(join(s.source, 'auth.json'), 'utf8')).toBe('{"placeholder":true}')
  })

  test('拒绝相同目录和 realpath 别名，在失败前保留原配置', async () => {
    const s = setup()
    writeFileSync(join(s.isolated, 'config.toml'), '原配置')
    const alias = join(s.root, 'alias')
    symlinkSync(s.isolated, alias)
    for (const source of [s.isolated, alias])
      expect(await prepareCodexHome(s.isolated, source)).toMatchObject({
        ok: false,
        error: { code: 'codex_home_failed' },
      })
    expect(readFileSync(join(s.isolated, 'config.toml'), 'utf8')).toBe('原配置')
  })

  test('保留普通 auth 文件并拒绝启动；旧链接可替换，无来源凭证时移除旧链接', async () => {
    const s = setup()
    const auth = join(s.isolated, 'auth.json')
    writeFileSync(auth, '刷新后的凭证占位')
    expect(await prepareCodexHome(s.isolated, s.source)).toMatchObject({
      ok: false,
      error: { code: 'codex_home_failed' },
    })
    expect(readFileSync(auth, 'utf8')).toBe('刷新后的凭证占位')
    rmSync(auth)
    symlinkSync(join(s.root, 'old-auth'), auth)
    expect((await prepareCodexHome(s.isolated, s.source)).ok).toBe(true)
    expect(readlinkSync(auth)).toBe(join(s.source, 'auth.json'))
    rmSync(join(s.source, 'auth.json'))
    expect((await prepareCodexHome(s.isolated, s.source)).ok).toBe(true)
    expect(existsSync(auth)).toBe(false)
    expect((await prepareCodexHome(s.isolated, s.source)).ok).toBe(true)
    expect(existsSync(auth)).toBe(false)
  })
})

describe('CODEX_HOME 从 state/ 迁到 run/', () => {
  function legacyHome() {
    const root = mkdtempSync(join(tmpdir(), 'raindown-codex-migrate-'))
    dirs.push(root)
    const home = join(root, 'raindown-home')
    const legacy = {
      orca: join(home, 'state', 'codex-orca-home'),
      exec: join(home, 'state', 'codex-exec-home'),
      read: join(home, 'state', 'codex-read-home'),
    }
    for (const [name, dir] of Object.entries(legacy)) {
      mkdirSync(join(dir, 'sessions'), { recursive: true })
      writeFileSync(join(dir, 'sessions', 'rollout.jsonl'), `会话-${name}`)
    }
    return { root, home, legacy }
  }

  test('迁移保留会话，旧位置留下指向新位置的链接；重复运行幂等', async () => {
    const { home, legacy } = legacyHome()
    // 迁移前继续使用旧位置。
    expect(orcaCodexHome(home)).toBe(legacy.orca)
    const logs: string[] = []
    const first = await migrateCodexHomes(home, (m) => logs.push(m))
    const current = {
      orca: join(home, 'run', 'executors', 'codex-orca', 'codex-home'),
      exec: join(home, 'run', 'executors', 'codex-exec', 'codex-home'),
      read: join(home, 'run', 'executors', 'codex-exec', 'codex-read-home'),
    }
    expect(first.migrated.sort()).toEqual(Object.values(current).sort())
    expect(logs).toEqual([])
    expect(orcaCodexHome(home)).toBe(current.orca)
    expect(execCodexHome(home)).toBe(current.exec)
    expect(readCodexHome(home)).toBe(current.read)
    for (const name of ['orca', 'exec', 'read'] as const) {
      expect(readFileSync(join(current[name], 'sessions', 'rollout.jsonl'), 'utf8')).toBe(
        `会话-${name}`,
      )
      expect(lstatSync(legacy[name]).isSymbolicLink()).toBe(true)
      // 升级前启动、环境里是旧路径的存活终端仍能按真实路径重新挂接。
      expect(await sameCodexHome(legacy[name], current[name])).toBe(true)
    }
    for (const dir of [
      join(home, 'run'),
      join(home, 'run', 'executors'),
      join(home, 'run', 'executors', 'codex-orca'),
    ])
      expect(lstatSync(dir).mode & 0o777).toBe(0o700)

    const second = await migrateCodexHomes(home, (m) => logs.push(m))
    expect(second.migrated).toEqual([])
    expect(logs).toEqual([])
    expect(readFileSync(join(current.orca, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('会话-orca')
  })

  test('没有旧目录时什么也不做', async () => {
    const root = mkdtempSync(join(tmpdir(), 'raindown-codex-migrate-'))
    dirs.push(root)
    const logs: string[] = []
    expect(await migrateCodexHomes(join(root, 'raindown-home'), (m) => logs.push(m))).toEqual({
      migrated: [],
    })
    expect(logs).toEqual([])
    expect(existsSync(join(root, 'raindown-home', 'run'))).toBe(false)
  })

  test('新旧位置同时存在时保留旧位置继续使用并记日志', async () => {
    const { home, legacy } = legacyHome()
    const current = join(home, 'run', 'executors', 'codex-orca', 'codex-home')
    mkdirSync(current, { recursive: true })
    const logs: string[] = []
    const result = await migrateCodexHomes(home, (m) => logs.push(m))
    expect(result.migrated).not.toContain(current)
    expect(logs.some((m) => m.includes('同时存在'))).toBe(true)
    expect(lstatSync(legacy.orca).isDirectory()).toBe(true)
    expect(orcaCodexHome(home)).toBe(legacy.orca)
    expect(readFileSync(join(legacy.orca, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('会话-orca')
  })

  test('rename 失败时保留旧位置继续使用，不丢登录状态', async () => {
    const { home, legacy } = legacyHome()
    // run/ 是普通文件：无法创建新位置，迁移失败。
    writeFileSync(join(home, 'run'), '占位')
    const logs: string[] = []
    const result = await migrateCodexHomes(home, (m) => logs.push(m))
    expect(result.migrated).toEqual([])
    expect(logs.length).toBe(3)
    expect(logs.every((m) => m.includes('继续使用旧位置'))).toBe(true)
    for (const name of ['orca', 'exec', 'read'] as const) {
      expect(lstatSync(legacy[name]).isDirectory()).toBe(true)
      expect(readFileSync(join(legacy[name], 'sessions', 'rollout.jsonl'), 'utf8')).toBe(
        `会话-${name}`,
      )
    }
    expect(orcaCodexHome(home)).toBe(legacy.orca)
    expect(execCodexHome(home)).toBe(legacy.exec)
    expect(readCodexHome(home)).toBe(legacy.read)
    // 修复后再次启动即可完成迁移。
    rmSync(join(home, 'run'))
    expect((await migrateCodexHomes(home, () => {})).migrated.length).toBe(3)
    expect(orcaCodexHome(home)).toBe(join(home, 'run', 'executors', 'codex-orca', 'codex-home'))
  })
})
