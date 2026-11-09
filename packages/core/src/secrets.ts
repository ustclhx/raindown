import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { execCommand } from './git.ts'
import { raindownPaths } from './home.ts'
import { fail, ok, type Result } from './result.ts'
import { CONFIG_GITLEAKS_TOML, SOPS_ALLOWLIST } from './templates.ts'
import { withWriteLock } from './write/lock.ts'
import { commitSecretFiles, readSecretFile } from './write/secret-store.ts'

export interface SecretsOptions {
  /** 默认路径与 sops 在 macOS 上的默认值不同，必须显式传入环境。 */
  ageKeyFile?: string
  sopsBin?: string
  ageKeygenBin?: string
  /** 测试中注入命令执行器，生产调用统一经过 execCommand。 */
  exec?: typeof execCommand
}

export const secretPathSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/)
  .refine((p) => !p.split('/').some((k) => ['__proto__', 'prototype', 'constructor'].includes(k)))
type SecretTree = { [key: string]: string | SecretTree }
const treeSchema: z.ZodType<SecretTree> = z.record(
  secretPathSchema.refine((k) => !k.includes('/')),
  z.lazy(() => z.union([z.string(), treeSchema])),
)
/** age 私钥文件的位置：显式传入优先，否则为 `<home>/.config/sops/age/keys.txt`；隔离清单据此确定私钥目录。 */
export const resolveAgeKeyFile = (
  opts: Pick<SecretsOptions, 'ageKeyFile'> = {},
  home: string = homedir(),
): string => opts.ageKeyFile ?? join(home, '.config/sops/age/keys.txt')
const keyFile = (opts: SecretsOptions) => resolveAgeKeyFile(opts)

async function sops(home: string, args: string[], opts: SecretsOptions, input?: string) {
  const r = await (opts.exec ?? execCommand)(opts.sopsBin ?? 'sops', args, {
    cwd: raindownPaths(home).config,
    env: { ...process.env, SOPS_AGE_KEY_FILE: keyFile(opts) },
    ...(input === undefined ? {} : { input }),
  })
  // 外部工具的诊断可能包含输入内容，不能向 CLI、日志或账本转发 stdout/stderr。
  if (r.code !== 0)
    return fail(
      'failure',
      r.code === 127 ? 'sops_missing' : 'sops_failed',
      'sops 调用失败，请检查安装、密钥和加密文件',
    )
  return ok(r.stdout)
}

async function readTree(home: string, opts: SecretsOptions): Promise<Result<SecretTree>> {
  if (!existsSync(join(raindownPaths(home).config, 'secrets.sops.yaml'))) {
    return fail('failure', 'secrets_not_initialized', '请先运行 raindown secrets init')
  }
  const decrypted = await sops(home, ['-d', '--output-type', 'json', 'secrets.sops.yaml'], opts)
  if (!decrypted.ok) return decrypted
  try {
    const parsed = treeSchema.safeParse(JSON.parse(decrypted.data))
    if (parsed.success) return ok(parsed.data)
  } catch {
    /* 不把解析器可能引用的明文放进错误信息。 */
  }
  return fail('failure', 'invalid_secrets', '密钥文件必须是嵌套的字符串键值映射')
}

async function encrypt(home: string, tree: SecretTree, opts: SecretsOptions, recipient?: string) {
  // sops 3.13.3 的 encrypt 子命令不传文件名时直接读 stdin；在 macOS 实测，
  // Linux 的 execCommand 子进程也已验证。不能传 /dev/stdin：Linux 下子进程
  // stdin 是 socket，重新按文件打开会报 ENXIO。--filename-override 用于匹配规则，
  // JSON 输入、YAML 输出支持空对象 {}。明文只经 stdin，不放 argv 或临时文件。
  return sops(
    home,
    [
      ...(recipient ? [] : ['--config', '.sops.yaml']),
      'encrypt',
      ...(recipient ? ['--age', recipient] : []),
      '--input-type',
      'json',
      '--output-type',
      'yaml',
      '--filename-override',
      'secrets.sops.yaml',
    ],
    opts,
    JSON.stringify(tree),
  )
}

/** 解密后的值只存在内存；供中枢的 secret:// 解析和脱敏名单使用。 */
export async function loadSecrets(
  home: string,
  opts: SecretsOptions = {},
): Promise<Result<Map<string, string>>> {
  try {
    const tree = await readTree(home, opts)
    if (!tree.ok) return tree
    const values = new Map<string, string>()
    const visit = (node: SecretTree, prefix: string) => {
      for (const [k, v] of Object.entries(node)) {
        const path = prefix ? `${prefix}/${k}` : k
        if (typeof v === 'string') values.set(path, v)
        else visit(v, path)
      }
    }
    visit(tree.data, '')
    return ok(values)
  } catch {
    return fail('failure', 'secrets_read_failed', '读取密钥失败')
  }
}

export const SECRETS_BACKUP_NOTICE = '⚠️ 请立即离线备份 age 私钥！私钥丢失将无法恢复所有密钥。'

export async function initSecrets(
  home: string,
  opts: SecretsOptions = {},
): Promise<Result<{ notice: string }>> {
  try {
    return await withWriteLock(home, async () => {
      const dir = raindownPaths(home).config
      if (!existsSync(join(dir, '.git')))
        return fail('failure', 'not_initialized', '请先运行 raindown init')
      const rulesPath = join(dir, '.sops.yaml')
      const encryptedPath = join(dir, 'secrets.sops.yaml')
      if (existsSync(keyFile(opts)) && existsSync(rulesPath) && existsSync(encryptedPath)) {
        return ok({ notice: SECRETS_BACKUP_NOTICE })
      }
      if (!existsSync(keyFile(opts))) {
        const generated = await (opts.exec ?? execCommand)(opts.ageKeygenBin ?? 'age-keygen', [])
        if (generated.code !== 0)
          return fail('failure', 'age_keygen_failed', 'age-keygen 生成密钥失败')
        await mkdir(dirname(keyFile(opts)), { recursive: true, mode: 0o700 })
        // wx 防止并发初始化覆盖已生成的私钥；私钥从创建起即为 0600。
        try {
          await writeFile(keyFile(opts), generated.stdout, { flag: 'wx', mode: 0o600 })
          await chmod(keyFile(opts), 0o600)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        }
      }
      const changes = new Map<string, string>()
      let recipient: string | undefined
      if (!existsSync(rulesPath)) {
        const pub = await (opts.exec ?? execCommand)(opts.ageKeygenBin ?? 'age-keygen', [
          '-y',
          keyFile(opts),
        ])
        if (pub.code !== 0 || !/^age1[0-9a-z]+$/.test(pub.stdout.trim())) {
          return fail('failure', 'age_keygen_failed', '无法读取 age 公钥')
        }
        recipient = pub.stdout.trim()
        changes.set(
          '.sops.yaml',
          `creation_rules:\n  - path_regex: ^secrets\\.sops\\.yaml$\n    age: ${pub.stdout.trim()}\n`,
        )
      }
      const config = await readSecretFile(join(dir, '.gitleaks.toml'))
      if (config === null) changes.set('.gitleaks.toml', CONFIG_GITLEAKS_TOML)
      else if (!config.includes(SOPS_ALLOWLIST.trim()))
        changes.set(
          '.gitleaks.toml',
          `${config.replace(/^\[allowlist\]$/gm, '[[allowlists]]')}\n${SOPS_ALLOWLIST}`,
        )
      if (!existsSync(encryptedPath)) {
        const encrypted = await encrypt(home, {}, opts, recipient)
        if (!encrypted.ok) return encrypted
        changes.set('secrets.sops.yaml', encrypted.data)
      }
      const committed = await commitSecretFiles(home, changes)
      return committed.ok ? ok({ notice: SECRETS_BACKUP_NOTICE }) : committed
    })
  } catch {
    return fail('failure', 'secrets_init_failed', '初始化密钥失败')
  }
}

export async function setSecret(
  home: string,
  path: string,
  value: string,
  opts: SecretsOptions = {},
): Promise<Result<{ path: string }>> {
  if (!secretPathSchema.safeParse(path).success)
    return fail('usage', 'invalid_secret_path', '密钥路径应为 a/b-c 格式')
  try {
    return await withWriteLock(home, async () => {
      const tree = await readTree(home, opts)
      if (!tree.ok) return tree
      const parts = path.split('/')
      const leaf = parts.pop() as string
      let node = tree.data
      for (const part of parts) {
        if (!Object.hasOwn(node, part)) node[part] = {}
        const next = node[part]
        if (typeof next === 'string')
          return fail('failure', 'secret_path_conflict', '密钥路径与现有键冲突')
        node = next as SecretTree
      }
      if (Object.hasOwn(node, leaf) && typeof node[leaf] !== 'string') {
        return fail('failure', 'secret_path_conflict', '密钥路径与现有键冲突')
      }
      node[leaf] = value
      const encrypted = await encrypt(home, tree.data, opts)
      if (!encrypted.ok) return encrypted
      const committed = await commitSecretFiles(
        home,
        new Map([['secrets.sops.yaml', encrypted.data]]),
      )
      return committed.ok ? ok({ path }) : committed
    })
  } catch {
    return fail('failure', 'secrets_write_failed', '写入密钥失败')
  }
}
