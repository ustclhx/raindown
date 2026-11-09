# Spec Delta

## ADDED Requirements

### Requirement: 按适配器契约声明能力
codex-orca SHALL 声明：授权请求以推断方式识别（`inferred`，来自终端弹窗）、能在运行中注入消息、能重新挂接会话、加载 Raindown MCP、能检测带外操作。终端文字分类只作为本适配器在 worker 未结构化上报时的兜底。

#### Scenario: 已上报的提问
- **WHEN** worker 调用了 `raindown_report question` 随后终端空闲
- **THEN** 以上报为准，不再用终端文字判定提问内容

### Requirement: Worker 终端标题
codex-orca 创建的终端标题 MUST 以统一前缀开头并包含任务 id，例如 `[Raindown] t-20261105-164210-10d41a`。

#### Scenario: 新建 worker 终端
- **WHEN** codex-orca 为任务创建 Orca 终端
- **THEN** 终端标题为统一前缀加任务 id

### Requirement: 带外批准与工作目录丢失
任务处于 `blocked(awaiting_approval)` 时，如果终端显示该请求已被批准或已执行而 Raindown 没有送达回复，codex-orca SHALL 上报带外操作并恢复为 `running`。任务的 worktree 目录不存在时 SHALL 上报 `blocked(workdir_missing)`，不再执行依赖该目录的命令。

#### Scenario: 终端里按了 y
- **WHEN** Raindown 尚未回复授权，终端出现 "You approved codex to run" 且命令开始执行
- **THEN** 节点上报带外操作，任务回到 `running`，原授权条目关闭
