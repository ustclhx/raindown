import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

export const DAEMON_LABELS = ['dev.raindown.hub', 'dev.raindown.node'] as const
export const LEGACY_DAEMON_LABELS = ['dev.flow.hub', 'dev.flow.node'] as const
export const launchAgentsDirectory = () => join(homedir(), 'Library', 'LaunchAgents')

export interface PlistOptions {
  label: string
  bunPath: string
  cliPath: string
  command: readonly string[]
  home: string
  logPath: string
  path: string
}

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char] ?? char
  })

/**
 * 纯函数：所有字符串（包括 PATH 与命令参数）都经过 XML 转义。
 * `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` 关闭节点进程的 bun 转译缓存（缺省写在共享的 `~/Library/Caches`，
 * add-worker-credential-isolation 审查第一轮 M2）；已安装的服务需重新运行 `raindown daemon install` 才生效。
 */
export function generatePlist(options: PlistOptions): string {
  const string = (value: string) => `<string>${escapeXml(value)}</string>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(options.label)}
  <key>ProgramArguments</key>
  <array>
${[options.bunPath, options.cliPath, ...options.command].map((arg) => `    ${string(arg)}`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RAINDOWN_HOME</key>
    ${string(options.home)}
    <key>PATH</key>
    ${string(options.path)}
    <key>BUN_RUNTIME_TRANSPILER_CACHE_PATH</key>
    ${string('0')}
  </dict>
  <key>StandardOutPath</key>
  ${string(options.logPath)}
  <key>StandardErrorPath</key>
  ${string(options.logPath)}
</dict>
</plist>
`
}

const executablePaths = z
  .tuple([z.string().refine(isAbsolute), z.string().refine(isAbsolute)])
  .rest(z.string())

/** 只提取 Raindown XML plist 的字符串参数，不求值 XML 的 DTD 或外部实体。 */
export function parsePlistPaths(xml: string): { bunPath: string; cliPath: string } | null {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1]
  if (!array || array.replace(/<string>[^<]*<\/string>/g, '').trim()) return null
  const args = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((match) =>
    (match[1] ?? '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, key: string) => {
      if (key.startsWith('#')) {
        const code =
          key[1]?.toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1))
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key] ?? entity
    }),
  )
  const parsed = executablePaths.safeParse(args)
  return parsed.success ? { bunPath: parsed.data[0], cliPath: parsed.data[1] } : null
}

export interface PlistCheck {
  label: string
  plistPath: string
  installed: boolean
  bunPath: string | null
  cliPath: string | null
  bunExists: boolean
  cliExists: boolean
  error?: string
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** status 与 doctor 共用同一份路径诊断；未安装也不会读取账本。 */
export function checkDaemonPlists(
  directory: string,
  labels: readonly string[] = DAEMON_LABELS,
): PlistCheck[] {
  return labels.map((label) => {
    const plistPath = join(directory, `${label}.plist`)
    const check: PlistCheck = {
      label,
      plistPath,
      installed: existsSync(plistPath),
      bunPath: null,
      cliPath: null,
      bunExists: false,
      cliExists: false,
    }
    if (!check.installed) return check
    try {
      const paths = parsePlistPaths(readFileSync(plistPath, 'utf8'))
      if (!paths) return { ...check, error: '无法解析 plist 的绝对路径参数' }
      return {
        ...check,
        ...paths,
        bunExists: isFile(paths.bunPath),
        cliExists: isFile(paths.cliPath),
      }
    } catch (err) {
      return { ...check, error: `无法读取 plist：${(err as Error).message}` }
    }
  })
}
