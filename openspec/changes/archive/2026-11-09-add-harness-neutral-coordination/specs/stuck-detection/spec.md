# Spec Delta

## MODIFIED Requirements

### Requirement: 卡住的原因分类
任务卡住时 SHALL 被归入一个原因：
- `awaiting_approval`：等待授权；
- `question`：在向用户提问；
- `no_progress`：长时间没有新活动；
- `crashed`：进程意外退出；
- `workdir_missing`：任务的工作目录或 harness 会话被外部删除；
- `other`。

每次上报 `blocked` 时都 MUST 附带原因、来源 `basis`（`reported` 或 `inferred`，见 worker-report）、一句话说明和最近的输出片段（默认末尾 40 行）。worker 已结构化上报时以上报为准；否则判断依据是各执行器适配器提供的识别规则，适配器无法识别时归为 `other`。说明 MUST 如实反映原因，不能把工作目录不存在报成某个程序找不到。

#### Scenario: 等待授权
- **WHEN** Codex 终端末尾显示一个需要用户确认的命令执行请求
- **THEN** 任务以 `blocked(awaiting_approval)` 上报，说明中包含该命令

#### Scenario: worker 结构化提问
- **WHEN** worker 调用 `raindown_report question` 后停下
- **THEN** 任务以 `blocked(question)` 上报，`basis` 为 `reported`

#### Scenario: worktree 被删除
- **WHEN** codex-orca 任务的 worktree 被删除，节点随后在该目录下执行命令失败
- **THEN** 任务以 `blocked(workdir_missing)` 上报，说明写明目录不存在，而不是"找不到 gh"
