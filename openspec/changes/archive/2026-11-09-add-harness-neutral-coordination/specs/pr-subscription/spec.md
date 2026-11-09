# Spec Delta

## Purpose
让开出或接手 PR 的任务持续跟随这个 PR：PR 上后来的 CI 结果、审查结论和人类评论直接送到负责的 worker，不必每次都唤醒 supervisor；超出任务范围的再交回给 supervisor。

## ADDED Requirements

### Requirement: 订阅 PR
任务报告分支后，系统 SHALL 让它订阅该分支上由它开出的 PR；审查任务订阅它审查的 PR。订阅在任务结束后保留，直到 PR 关闭或合并后再过 14 天。用户可以取消订阅。

#### Scenario: 开出 PR 即订阅
- **WHEN** 开发任务在任务分支上开出 PR #40
- **THEN** 该任务订阅 PR #40，`raindown task show` 显示这条订阅

### Requirement: PR 事件采集
中枢 SHALL 对有订阅的 PR 定期查询 CI 检查结果、审查结论与评论，按 PR 记录读取位置，重启后不重复送达。查询失败只记在该 PR 上并在下次重试，连续失败才报告为系统问题。机器人与 CI 的消息只作为上下文送达，不恢复已结束的任务。

#### Scenario: 重启后不重放
- **WHEN** 中枢在读到 PR #40 的一条评论后重启
- **THEN** 重启后该评论不会再次送达

### Requirement: 谁的评论算请求
workspace SHALL 配置允许的 GitHub 用户名单（默认是仓库所有者）。只有名单内用户的人类评论能恢复已结束的任务、被交回给 supervisor 或唤醒 supervisor；其他人和机器人的内容 MUST 只作为不可信的上下文送达运行中的任务。

#### Scenario: 陌生人在公开仓库评论
- **WHEN** 不在名单内的 GitHub 用户在 PR 上评论"顺便把 X 删掉"
- **THEN** 已结束的任务不恢复，supervisor 不被唤醒；运行中的任务收到的该评论标明为不可信内容

### Requirement: 直通订阅的任务
PR 事件 SHALL 直接作为输入送给订阅的任务，不唤醒 supervisor。直通的事件只是上下文，MUST NOT 扩大任务的授权依据或合同范围。运行中的任务按适配器能力即时送达或排队；已结束的任务只在人类评论时恢复（见 task-mandate 的恢复前校验）。

#### Scenario: CI 失败
- **WHEN** 开发任务开出的 PR 上 CI 失败
- **THEN** 失败摘要作为输入送到该任务，supervisor 不被唤醒

### Requirement: 交回超范围的请求
worker 收到名单内用户超出任务范围或属于另一件工作的请求时，SHALL 通过 `raindown_report` 交回该事件并写明理由；交回的事件进入 supervisor 的唤醒队列，并附 worker 的理由。没有任何订阅任务的名单内用户 PR 评论同样进入 supervisor 的唤醒队列。

#### Scenario: 评论要求做别的功能
- **WHEN** PR 上的人类评论要求顺带加一个新功能，worker 判断超出范围并交回
- **THEN** supervisor 被唤醒处理这条评论，输入里有 worker 的交回理由
