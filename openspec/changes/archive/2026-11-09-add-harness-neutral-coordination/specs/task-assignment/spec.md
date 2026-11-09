# Spec Delta

## Purpose
把"一件被授权的工作"（任务）和"某个执行器的一次执行"（派工）分开，使重跑、恢复与崩溃后的继续都发生在原任务下，任务状态不随某次执行的失败而失真。

## ADDED Requirements

### Requirement: 派工记录
任务 SHALL 拥有按时间排列的派工列表，每次派工记录执行器、节点、开始与结束时间、结束原因和最后一次上报。任务的 `attempt` 等于派工数。现有的租约过期重排与带回复重排 MUST 表现为同一任务下的新派工。

#### Scenario: 查看派工
- **WHEN** 用户执行 `raindown task show <id>`，该任务经历过一次崩溃和一次重试
- **THEN** 输出列出两次派工及各自的结束原因

### Requirement: 重试
系统 SHALL 提供 `task_retry` 操作：只有 `blocked`（原因为 `crashed`、`node_lost`、`workdir_missing`、`other`）或 `failed` 的任务可以重试；重试结束当前派工并新建派工，沿用原任务的工作目录、分支与 PR。用户总可以重试；supervisor 只能重试本 workspace 中由它的唤醒链派生的任务。

#### Scenario: 重跑崩溃的审查
- **WHEN** 审查任务因执行器崩溃处于 `blocked(crashed)`，supervisor 调用 `task_retry`
- **THEN** 同一审查任务新建派工重新运行，不产生第二个审查任务，合并资格检查不再因"同一 PR 有未结束的审查"而被另一个任务挡住

### Requirement: 恢复提示
因重启、崩溃、节点失联或重试而开始的新派工 MUST 在给 worker 的输入里附恢复提示：说明上一次派工如何结束，要求先核对工作目录、git 历史和 PR 状态，再决定是否重复 push、开 PR 等外部动作。

#### Scenario: 节点重启后继续
- **WHEN** 一个开发任务在 push 之后因节点重启失去租约并被重新派工
- **THEN** 新派工的输入包含恢复提示，worker 不会重复开 PR

### Requirement: 交付物已存在时的完成判定
任务的工作目录丢失或执行器崩溃时，如果任务已报告分支且该分支上有它开出的、仍然打开或已合并的 PR，系统 SHALL 把 PR 作为该任务的交付物，允许以 `ready` 完成而不必重新执行；判定结果写入账本并说明依据。

#### Scenario: PR 已开出后 worktree 被删
- **WHEN** 开发任务已开出 PR #32，随后工作目录被删除
- **THEN** 任务以 `done` 结束，结果引用 PR #32 并说明是依据已存在的 PR 判定的，后续合并请求的资格检查照常进行
