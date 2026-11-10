import { loadRoles, type Role, roleIsolationTarget, type ValidationIssue } from '@raindown/core'
import type { RoleIsolationSource } from './service.ts'

/** 角色缓存的有效期：派送时最多使用这么久之前读到的角色配置（节点侧兜底以节点读到的配置为准）。 */
export const ROLE_ISOLATION_TTL_MS = 2_000

/**
 * 基于 raindown-home 的 `config/roles/` 的角色隔离要求（worker-credential-isolation 6.1）。
 * 每次领取请求开始与长轮询唤醒派送前按 TTL 重新读取（不另起定时器），`force` 时立即重新读取；
 * 读取失败时沿用上一次成功的结果。找不到的角色（从未读取成功、文件有错或未定义）`lookup` 返回 undefined，
 * 派送方据此把任务卡住（fail closed，`problem` 给出该角色文件的加载错误）。
 */
export function roleIsolationFromHome(
  home: string,
  o: { now?: () => number; ttlMs?: number } = {},
): RoleIsolationSource {
  const now = o.now ?? Date.now
  const ttl = o.ttlMs ?? ROLE_ISOLATION_TTL_MS
  let roles = new Map<string, Role>()
  let errors: ValidationIssue[] = []
  let loadError: string | undefined
  let loadedAt = Number.NEGATIVE_INFINITY
  let loading: Promise<void> | undefined
  return {
    lookup(contract) {
      return roleIsolationTarget(roles.get(contract.role), contract)
    },
    problem(name) {
      const file = `config/roles/${name}.yaml`
      const issues = errors
        .filter((e) => e.file === file)
        .map((e) => `${e.file}${e.field ? `：${e.field}` : ''}：${e.message}`)
      if (loadError) issues.push(`读取 config/roles/ 失败：${loadError}`)
      return issues.length ? issues.join('；') : undefined
    },
    refresh(opts = {}) {
      if (!opts.force && now() - loadedAt < ttl) return Promise.resolve()
      loading ??= (async () => {
        try {
          const loaded = await loadRoles(home)
          if (loaded.ok) {
            roles = new Map(loaded.data.roles.map((r) => [r.name, r]))
            errors = loaded.data.errors
            loadError = undefined
          } else loadError = `${loaded.error.code} ${loaded.error.message}`
          loadedAt = now()
        } finally {
          loading = undefined
        }
      })()
      return loading
    },
  }
}
