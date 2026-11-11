# Spec Delta

## MODIFIED Requirements

### Requirement: 上报工具
系统 SHALL 提供 worker 可调用的 `raindown_report` 操作，输入为状态之一：`progress`、`question`、`ready`、`blocked`、`failed`、`dropped`，以及一句话摘要。调用者身份 MUST 绑定到当前持有租约的任务与派工，不能为其他任务上报；任务不在运行中时返回 `not_running`。绑定有两种来源：
- 本机 worker 使用本次派工的派工令牌；
- 不在本机运行的 harness（适配器声明 `off_machine: true`）经远程入口上报，调用方 MUST 是任务角色在派工时绑定的远程调用方，并 MUST 带上本次派工的 `dispatch_ref`；`dispatch_ref` 不是当前派工的引用时返回 `not_running`。

两种来源的上报使用同一套输入校验、限额与事件，上报事件的操作者为实际调用方。

#### Scenario: 为别的任务上报
- **WHEN** 任务 A 的 worker 以任务 B 的 id 调用 `raindown_report`
- **THEN** 返回 `forbidden`，账本不新增事件

#### Scenario: 普通进展
- **WHEN** worker 调用 `raindown_report progress "已完成数据层改动"`
- **THEN** 账本记录一条上报事件，任务保持 `running`，不唤醒 supervisor，不产生收件箱条目

#### Scenario: 远程调用方为本机执行器的任务上报
- **WHEN** `remote:grok` 对一个由 `codex-orca` 执行的任务调用 `raindown_report`
- **THEN** 返回 `forbidden`，任务状态不变，账本不新增上报事件

#### Scenario: 旧派工的迟到上报
- **WHEN** 任务已因回复重新派发给 Grok，旧运行以旧的 `dispatch_ref` 上报 `ready`
- **THEN** 返回 `not_running`，当前派工不受影响

### Requirement: 完成、受阻与无需处理
`ready` 表示交付物已就绪可以审阅，MUST 附 1–5 个交付物引用，由系统核对：GitHub PR 地址按任务登记的仓库与分支核对；知识库提案引用（`raindown:proposal/<id>`）核对提案存在、由上报者在本次派工期间提交、属于任务的 workspace。`blocked` MUST 写明缺少的前提与已尝试的办法；`failed` 表示无法完成；`dropped` 表示经核实无需处理。`dropped` 的任务以 `done` 结束且不推送通知。

#### Scenario: 无需处理
- **WHEN** worker 核实问题无法复现后上报 `dropped`
- **THEN** 任务以 `done` 结束，结果标记为 dropped，不产生收件箱条目

#### Scenario: 以提案交付
- **WHEN** 调研任务的 worker 在本次派工中提交了一个本 workspace 的提案，然后上报 `ready`，交付物为该提案引用
- **THEN** 核对通过，提案作为产物合入任务结果

#### Scenario: 交付别人的提案
- **WHEN** worker 上报 `ready`，交付物引用一个由用户或其他身份提交的提案
- **THEN** 返回 `deliverable_check_failed`，账本不新增上报事件
