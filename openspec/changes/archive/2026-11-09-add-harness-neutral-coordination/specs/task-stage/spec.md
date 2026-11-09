# Spec Delta

## Purpose
用"任务现在在等谁、等什么"的统一阶段回答用户最关心的问题，让 CLI、收件箱与以后的 Web 端对同一事实给出同一说法。

## ADDED Requirements

### Requirement: 阶段派生
系统 SHALL 由账本事实为每个未结束的任务派生唯一的阶段，按以下顺序取第一条满足的：
1. 等人授权：`blocked(awaiting_approval)` 且未委托或委托已转交用户；
2. 等人回答：`blocked(question)` 且未委托或委托已转交用户；
3. 等 supervisor：卡住且有进行中的代回复委托；
4. 等人审阅：最新上报为 `ready` 且有待审交付物；
5. 受阻：其他原因的 `blocked`，且此后没有用户或 supervisor 的回复；
6. 排队：`queued`，或没有进行中的派工；
7. 空闲：派工已结束且有订阅等待新事件；
8. 工作中：其他。

阶段 MUST 只由账本派生，不另存状态。

#### Scenario: 委托中的授权
- **WHEN** 一个任务 `blocked(awaiting_approval)` 且已委托给 supervisor、尚未超时
- **THEN** 阶段为"等 supervisor"，而不是"等人授权"

### Requirement: 阶段的展示
`raindown task list`、`raindown task show`、收件箱条目与 `raindown supervisor status` SHALL 显示阶段名称；`raindown task list` MUST 支持按阶段过滤，并默认把"等人……"的任务排在最前。

#### Scenario: 只看等我的任务
- **WHEN** 用户执行 `raindown task list --stage waiting-human`
- **THEN** 只列出阶段为等人授权、等人回答或等人审阅的任务
