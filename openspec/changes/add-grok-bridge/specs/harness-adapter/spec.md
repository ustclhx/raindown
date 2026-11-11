# Spec Delta

## MODIFIED Requirements

### Requirement: 能力声明
每个执行器适配器 SHALL 在节点注册时声明能力：是否能结构化地报告授权请求、是否能在运行中注入消息、是否能恢复会话、是否加载 Raindown MCP（从而能使用 `raindown_report`）、是否能检测带外操作，以及 harness 是否在节点本机之外运行（`off_machine`）。中枢 MUST 按声明决定交互方式，不得按执行器类型名硬编码。旧节点未声明 `off_machine` 时按 false 处理；只有声明 `off_machine: true` 的执行器才能请求中枢进行远程派发，因而只有它们的派工会接受远程调用方的上报。

#### Scenario: 不能中途注入消息的执行器
- **WHEN** 一个声明不能中途注入消息的执行器的任务收到直通的 PR 事件
- **THEN** 事件留在任务的待送达输入中，下一次派工开始时一并送达

#### Scenario: 本机执行器不接受远程上报
- **WHEN** 一个未声明 `off_machine` 的执行器正在执行的任务，收到远程调用方的 `raindown_report`
- **THEN** 返回 `forbidden`，不按执行器类型名另行判断
