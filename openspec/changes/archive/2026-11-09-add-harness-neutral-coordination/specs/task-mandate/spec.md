# Spec Delta

## Purpose
记录每个任务"凭什么做、按哪一版规则做"，使策略变化可以追溯、通知受影响的工作，并在恢复已结束的工作前重新确认授权仍然成立。

## ADDED Requirements

### Requirement: 授权依据
任务创建时 SHALL 在 `task.created` 中固化授权依据：创建者身份与来源（用户、supervisor 的哪次唤醒、哪条用户指令）、当时 `policies.yaml` 的版本哈希，以及建任务时命中的策略规则。授权依据创建后 MUST NOT 修改。

#### Scenario: 追溯一个任务的依据
- **WHEN** 用户查看一个由 supervisor 创建的任务
- **THEN** 能看到它来自哪次唤醒、哪条用户指令，以及创建时的策略版本

### Requirement: 策略变化通知
`policies.yaml` 的版本哈希变化时，系统 SHALL 为每个运行中或卡住、且授权依据或进行中的代批依赖的规则已改变或删除的任务记录一条策略变化事件，并把变化摘要作为输入送给该任务；不受影响的任务不通知。策略变化 MUST NOT 自动取消任务。

#### Scenario: 删除了一条代批规则
- **WHEN** 用户删除了 `pnpm check` 的 supervisor 代批规则，此时有一个任务的该类授权正由 supervisor 代批
- **THEN** 该代批转交用户，任务收到策略变化输入，其他任务不受影响

### Requirement: 恢复前重新校验
已结束的任务因新输入（例如 PR 上的人类评论）恢复前，系统 MUST 按当前策略重新校验：创建者为 supervisor 时 workspace 的 supervisor 仍启用且该任务角色仍允许 supervisor 创建；不满足时任务保持结束，输入改为唤醒 supervisor 或进入收件箱。

#### Scenario: supervisor 已被关闭
- **WHEN** 一个由 supervisor 创建且已结束的任务的 PR 上出现人类评论，而该 workspace 的 supervisor 已关闭
- **THEN** 任务不恢复，评论作为收件箱条目给用户
