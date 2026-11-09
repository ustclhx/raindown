# executor-codex-orca Specification

## Purpose
把用户现在的"Orca 建 worktree、在终端里启动 Codex、盯着终端"流程做成节点上的执行器，用于长时间、交互式的开发任务。

## Requirements

### Requirement: 按任务创建 worktree
执行 `codex-orca` 任务时，执行器 SHALL 在合同的仓库中，基于 `origin/<默认分支>` 创建一个以任务 id 命名的 Orca worktree，并在仓库定义了 setup 时等待它完成。仓库必须是某个已定义 workspace 的仓库，否则任务 MUST 以 `failed`（`repo_not_in_workspace`）结束。

#### Scenario: 为 product-res 的任务创建 worktree
- **WHEN** 一个 `ws/product-res` 的 dev 任务被本机节点领取
- **THEN** Orca 中出现一个以该任务 id 命名的 product-res worktree，分支基于 origin/main

### Requirement: 任务说明
执行器 SHALL 把任务合同渲染成一份任务说明交给 Codex，包括：
- 目标、角色提示词；
- 上下文引用：brain 条目要内联其摘要，并给出 `raindown kb get` 命令；
- 允许修改的范围、验收命令；
- 完成标准：在分支上提交、推送并开 PR，不合并；
- "遇到无法判断的问题时写明问题后停下"这条约定。

任务说明同时保存在 `state/tasks/<id>/spec.md`，便于事后回看。

#### Scenario: 任务说明带上下文
- **WHEN** 合同的 context 中包含 `projects/product-res`
- **THEN** 任务说明中包含该项目卡片的摘要，以及 `raindown kb get projects/product-res`

### Requirement: 自动处理文件夹信任提示
Codex 在新 worktree 中停在文件夹信任提示上时，如果该仓库属于已定义的 workspace，执行器 SHALL 自动确认，方法是只发送回车，然后继续监控；否则上报 `blocked(awaiting_approval)`。

#### Scenario: 首次进入仓库
- **WHEN** Codex 启动后输出末尾是 "Trust this folder?" 提示
- **THEN** 执行器发送回车，Codex 继续工作，任务保持 `running`

### Requirement: 终端监控与结束判定
执行器 SHALL 定期读取终端末尾的输出（默认每 30 秒），并作为活动上报。
- 输出中出现忙碌标记（例如 `Working (`、`esc to interrupt`），视为在工作。
- 连续两次都没有忙碌标记，视为已停止。停止后按卡住检测的规则判定：
  - 分支上存在本任务的 PR：以 `done` 结束，产物中包含 PR 链接；
  - 否则：以 `blocked` 结束，附带原因和末尾输出。

#### Scenario: Codex 开完 PR 停下
- **WHEN** Codex 推送分支、开了 PR 后停止
- **THEN** 任务进入验收阶段，最终结果的产物中包含该 PR 的链接

#### Scenario: Codex 停下提问
- **WHEN** Codex 停止，没有 PR，末尾输出是一个问题
- **THEN** 任务变为 `blocked(question)`，说明中附带末尾 40 行输出

### Requirement: 送达回复与取消
收到用户对 `blocked` 任务的回复时，执行器 SHALL 把回复文字送进该任务的 Orca 终端，然后恢复监控。任务被取消时，执行器 MUST 关闭终端；worktree 保留，用于排查，由后续的清理流程处理。

#### Scenario: 回复后继续
- **WHEN** 用户对 `blocked(question)` 的任务回复"用方案 A"
- **THEN** 终端收到这段文字，Codex 重新开始工作，任务回到 `running`

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
