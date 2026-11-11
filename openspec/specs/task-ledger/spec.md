# task-ledger Specification

## Purpose
规定 Raindown 任务账本的事件模型、任务合同、状态机与投影，使任务的每一次变化都可追溯、可重放，并在进程崩溃后不丢失。

## Requirements

### Requirement: 只追加的事件账本
系统 SHALL 把所有任务相关的变化记录为事件，写入 `state/raindown.db`。每个事件包含：单调递增的序号、时间、类型、所属 workspace、关联任务、操作者，以及载荷。已写入的事件 MUST NOT 被修改或删除。

#### Scenario: 状态变化留下事件
- **WHEN** 一个任务从 `queued` 变为 `running`
- **THEN** 账本新增一条 `task.started` 事件，此前的事件保持不变

### Requirement: 投影可重建
任务的当前状态 SHALL 由事件投影得到。系统 MUST 能从事件流完整重建全部投影，重建结果与增量维护的结果一致。

#### Scenario: 删除投影后重建
- **WHEN** 投影表被清空后运行 `raindown hub rebuild`
- **THEN** 每个任务的状态、尝试次数和时间戳与清空前完全一致

### Requirement: 任务合同
创建任务时 SHALL 提供一份合同，包括：目标、所属 workspace、角色、执行器类型、工作目录（可选）、所需节点能力、上下文引用（brain 条目或文件路径）、验收命令（可选）、超时，以及是否允许重试。不符合 schema 的合同 MUST 被拒绝，并返回逐字段的错误。

#### Scenario: 缺少 workspace
- **WHEN** 创建任务时没有提供 workspace
- **THEN** 创建被拒绝，错误中指出 `workspace` 字段缺失，账本不新增任何事件

#### Scenario: workspace 未定义
- **WHEN** 合同中的 workspace 是 `ws/unknown`
- **THEN** 创建被拒绝，错误码为 `unknown_workspace`

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

### Requirement: 任务结果
任务结束（`done` 或 `failed`）时 SHALL 附带结果，包括：摘要、产物列表（文件路径、PR 链接等）、验收命令的执行结果，以及执行者。结果格式由 JSON Schema 描述。

#### Scenario: 查看已完成任务的结果
- **WHEN** 用户运行 `raindown task show <id>`，而该任务已完成
- **THEN** 输出包含结果摘要、产物和每条验收命令的退出码

### Requirement: 幂等创建
创建任务时 SHALL 支持可选的幂等键。同一个幂等键再次提交时，系统 MUST 返回已有的任务，不创建新任务。

#### Scenario: 重复提交
- **WHEN** 用同一个幂等键连续两次创建任务
- **THEN** 两次返回同一个任务 id，账本中只有一条 `task.created` 事件

### Requirement: 取消
用户与 supervisor SHALL 能取消非终态的任务。任务正在运行时，持有租约的节点 MUST 在下一次续约时得知取消，停止执行器，并以 `cancelled` 结束。

#### Scenario: 取消运行中的任务
- **WHEN** 用户取消一个 `running` 状态的任务
- **THEN** 节点在下一次续约时收到取消指令，停止执行器，任务最终变为 `cancelled`
