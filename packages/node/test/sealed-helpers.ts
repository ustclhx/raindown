import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 把测试目录变成一个最小的 git 仓库（施加外层 seatbelt 的写类任务要从登记仓库建立独立 clone）。
 * 使用测试内的临时 HOME 与 `GIT_CONFIG_NOSYSTEM=1`，不读写用户真实的 git 配置；返回这份 git 环境，
 * 测试经 `SeatbeltOptions.gitEnv` 交给节点。只提交一个空提交，不把测试目录中的其他文件纳入仓库。
 */
export function initTestRepo(dir: string): NodeJS.ProcessEnv {
  const home = join(dir, '.git-test-home')
  mkdirSync(home, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    LANG: 'C',
  }
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' })
  git(['init', '-q', '-b', 'main'])
  git([
    '-c',
    'user.name=Raindown Test',
    '-c',
    'user.email=raindown@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  ])
  git(['remote', 'add', 'origin', 'https://example.invalid/acme/demo.git'])
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  return env
}
