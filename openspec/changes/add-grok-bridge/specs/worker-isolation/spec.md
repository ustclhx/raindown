# Spec Delta

## MODIFIED Requirements

### Requirement: 角色的隔离要求
角色配置 SHALL 支持 `isolation: required | preferred | off`。`required` 的角色只派给声明 `credential_isolation` 且隔离自检通过的执行器与节点；无法满足时任务以明确原因卡住或拒绝派工，MUST NOT 在无隔离的情况下运行。`preferred` 在无法隔离时运行并在任务与收件箱中标明"未隔离"。

harness 不在本机运行的执行器（声明 `off_machine: true`，例如 `grok-routine`）没有可隔离的本机 worker 进程，SHALL 如实声明施加层为 `none`：
- 这类执行器的角色设为 `required` 时 MUST 在加载时报错（角色加载看不到节点运行时的声明，按执行器名判定，与 pr-merge、supervisor 唤醒会话相同）（`raindown doctor` 报告"不支持隔离"），该角色的任务无法创建，不得视为已满足；
- `preferred` 下不标注"未隔离"、不产生未隔离提示，任务标明"外部执行"；
- 它们触达 Raindown 的范围由远程调用方的凭证与能力限定（见 remote-mcp）。

#### Scenario: 隔离不可用
- **WHEN** 一个 `isolation: required` 的开发任务被派到隔离自检失败的节点
- **THEN** 任务不启动 harness，卡住原因写明隔离不可用及自检失败项

#### Scenario: 外部执行的角色要求隔离
- **WHEN** `config/roles/grok-research.yaml` 的执行器为 `grok-routine`，且写了 `isolation: required`
- **THEN** 角色加载失败，`raindown doctor` 报告该执行器不支持隔离，创建该角色的任务返回 `unknown_role`

#### Scenario: 外部执行的角色缺省设置
- **WHEN** 一个 `grok-routine` 角色未写 `isolation`（即 `preferred`）的任务开始执行
- **THEN** 任务照常派发，`task.started` 标明外部执行，不产生"未隔离"的收件箱提示
