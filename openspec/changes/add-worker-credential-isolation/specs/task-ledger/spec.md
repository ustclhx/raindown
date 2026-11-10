# Spec Delta

## MODIFIED Requirements

### Requirement: 状态机
任务状态 SHALL 只按以下转换变化：
- `queued → running`
- `queued → blocked`：仅由中枢写入，用于 `isolation: required` 的任务没有可用的已隔离节点（`blocked(other)`，消息以 `isolation_unavailable：` 开头，不带租约；见 worker-isolation "角色的隔离要求"）
- `running → verifying | done | failed | blocked`
- `verifying → done | failed | blocked`
- `blocked → queued | running | cancelled | failed`
- 任何非终态 → `cancelled`
- `running | verifying → queued`：仅当允许重试的任务租约过期、且未超过最大尝试次数时（见 node-protocol "租约过期处理"）

其中 `done`、`failed`、`cancelled` 是终态。不合法的转换 MUST 被拒绝，并且不写入事件。

#### Scenario: 已完成的任务不能再运行
- **WHEN** 对一个 `done` 状态的任务提交 `task.started`
- **THEN** 该请求被拒绝，错误码为 `invalid_transition`，任务状态保持 `done`

#### Scenario: 排队中的任务只能因隔离不可用而卡住
- **WHEN** 中枢以外的身份，或不带 `isolation_unavailable` 消息，对 `queued` 任务提交 `task.blocked`
- **THEN** 该请求被拒绝，任务保持 `queued`
