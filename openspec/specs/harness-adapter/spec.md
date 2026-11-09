# harness-adapter Specification

## Purpose
把 Raindown 与具体 harness（Codex、Claude 等）之间的边界定义成与 harness 无关的契约：每个执行器作为适配器声明能力、负责识别授权请求、隔离 harness 自带的放行配置，并让 Raindown 能察觉绕过它的操作。

## Requirements

### Requirement: 能力声明
每个执行器适配器 SHALL 在节点注册时声明能力：是否能结构化地报告授权请求、是否能在运行中注入消息、是否能恢复会话、是否加载 Raindown MCP（从而能使用 `raindown_report`）、是否能检测带外操作。中枢 MUST 按声明决定交互方式，不得按执行器类型名硬编码。

#### Scenario: 不能中途注入消息的执行器
- **WHEN** 一个声明不能中途注入消息的执行器的任务收到直通的 PR 事件
- **THEN** 事件留在任务的待送达输入中，下一次派工开始时一并送达

### Requirement: 授权请求由适配器识别
授权请求 SHALL 由适配器转换成统一结构：动作、命令或参数、理由、命令执行目录、请求 id，以及识别方式（`structured` 或 `inferred`）。策略判定、supervisor 代批与推送只使用这一结构，不读取 harness 的原始输出。

#### Scenario: 两种执行器的同一请求
- **WHEN** 一个 SDK 型执行器和一个终端型执行器都请求执行 `pnpm check`
- **THEN** 两者产生的授权请求结构相同，命中同一条策略规则

### Requirement: 隔离 harness 自带的放行配置
适配器 MUST 保证 harness 的用户级或全局配置不能削弱 Raindown 的授权：自动放行规则、自动审批器、hooks、额外的 MCP 服务器与项目信任记录都不得生效；harness 需要的配置只能来自角色配置与 Raindown 生成的配置。登录凭证可以共享，但适配器不得读取其内容。

#### Scenario: 用户级规则放行了 git push
- **WHEN** 用户本机的 harness 配置里有放行 `git push` 的规则，Raindown 派出的 worker 请求在沙箱外执行 `git push`
- **THEN** 请求作为授权请求交给 Raindown 处理，不被自动放行

### Requirement: Raindown 管理的会话可辨识
适配器在 harness 提供可见界面时 SHALL 让 Raindown 管理的会话与用户自己的会话可以一眼区分（例如统一的标题前缀或单独分组），并在会话里标明任务 id。

#### Scenario: Orca 中的 worker 终端
- **WHEN** 用户在 Orca 中查看终端列表
- **THEN** Raindown 派出的终端标题带统一前缀与任务 id

### Requirement: 带外操作检测
声明了带外检测能力的适配器 SHALL 在以下情况记录带外操作事件并让用户知道：Raindown 没有回复而待处理的授权请求已被执行或消失；任务的工作目录或会话被外部删除或关闭。带外事件 MUST 标明涉及的请求与任务，不改变已发生的事实，任务按实际状态继续或卡住。

#### Scenario: 在终端里直接按了确认
- **WHEN** 一个 `blocked(awaiting_approval)` 的任务在 Raindown 未回复的情况下，终端显示该命令已执行
- **THEN** 账本记录带外操作事件，收件箱出现一条说明"授权在 Raindown 之外被批准"的条目，任务回到 `running`
