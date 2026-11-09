import { basename, join } from 'node:path'
import { type DoctorOptions, findExecutable } from '../src/doctor.ts'
import { execCommand } from '../src/git.ts'
import { fail } from '../src/result.ts'

/** 新执行器依赖全部模拟；只有旧检查的 git / gitleaks 可以运行真实命令。 */
export function doctorOptions(home: string, overrides: DoctorOptions = {}) {
  return {
    launchAgentsDir: join(home, 'LaunchAgents'),
    userHome: home,
    platform: 'linux',
    findExecutable: (name, env) =>
      ['codex', 'orca', 'claude'].includes(name) ? `/fake/${name}` : findExecutable(name, env),
    runCommand: async (bin, args, opts) => {
      switch (basename(bin)) {
        case 'codex':
          return { code: 0, stdout: 'codex-cli 0.164.0', stderr: '' }
        case 'orca':
          return {
            code: 0,
            stdout:
              args[0] === '--version' ? 'Orca 1.4.218' : '{"ok":true,"result":{"terminals":[]}}',
            stderr: '',
          }
        case 'claude':
          throw new Error('doctor 不能执行 claude')
        default:
          return execCommand(bin, args, opts)
      }
    },
    // 测试绝不连接中枢：缺省按中枢不可用处理。
    isolationNodes: async () => fail('retryable', 'hub_unavailable', '测试中不连接中枢'),
    inspectClaudeSdk: async () => ({
      version: '0.3.310',
      expectedVersion: '0.3.310',
      cliPath: '/fake/sdk/claude',
    }),
    ...overrides,
    env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: 'fixture', ...overrides.env },
  } satisfies DoctorOptions
}
