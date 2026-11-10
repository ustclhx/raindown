import { loadRoles, type Role, roleIsolationTarget } from '@raindown/core'
import type { RoleIsolationSource } from './service.ts'

/** 角色缓存的有效期：派送时最多使用这么久之前读到的角色配置（节点侧兜底以节点读到的配置为准）。 */
export const ROLE_ISOLATION_TTL_MS = 2_000

/**
 * 基于 raindown-home 的 `config/roles/` 的角色隔离要求（worker-credential-isolation 6.1）。
 * 每次领取请求开始时按 TTL 重新读取（不另起定时器）；读取失败或角色文件有错时沿用上一次成功的结果，
 * 从未成功时没有角色（不检查，节点侧兜底仍按节点的角色配置判断）。
 */
export function roleIsolationFromHome(
  home: string,
  o: { now?: () => number; ttlMs?: number } = {},
): RoleIsolationSource {
  const now = o.now ?? Date.now
  const ttl = o.ttlMs ?? ROLE_ISOLATION_TTL_MS
  let roles = new Map<string, Role>()
  let loadedAt = Number.NEGATIVE_INFINITY
  let loading: Promise<void> | undefined
  return {
    lookup(contract) {
      return roleIsolationTarget(roles.get(contract.role), contract)
    },
    refresh() {
      if (now() - loadedAt < ttl) return Promise.resolve()
      loading ??= (async () => {
        try {
          const loaded = await loadRoles(home)
          if (loaded.ok) roles = new Map(loaded.data.roles.map((r) => [r.name, r]))
          loadedAt = now()
        } finally {
          loading = undefined
        }
      })()
      return loading
    },
  }
}
