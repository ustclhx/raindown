# Spec Delta

## ADDED Requirements

### Requirement: 条目标明来源与阶段
来自任务卡住的条目 SHALL 显示卡住的来源 `basis`（worker 上报或推断）与任务当前阶段；推断出的提问 MUST 标明"由终端推断"，提醒用户核对原始输出。结构化提问的选项 SHALL 作为条目的回复选项给出，Telegram 上以按钮呈现。

#### Scenario: 结构化提问推到手机
- **WHEN** worker 上报带 A、B 两个选项的提问且转给用户
- **THEN** Telegram 消息带 A、B 两个按钮，点按即回复对应选项

### Requirement: 带外操作条目
适配器记录的带外操作 SHALL 产生 Interrupt 级条目，说明发生了什么（例如"授权在 Raindown 之外被批准""工作目录被删除"）、涉及的任务与命令；用户可以确认（dismiss）或据此取消任务。

#### Scenario: 误触批准
- **WHEN** 用户在 harness 界面里误触批准了一个 Raindown 正在等待处理的授权
- **THEN** 收件箱出现带外操作条目，原来的授权条目以"已在外部处理"关闭
