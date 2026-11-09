# inbox Specification

## Purpose
把所有需要用户注意的事情汇成一个分级的收件箱，让用户只看一个地方，并且只在真正需要时被打断（PRD 原则 3）。

## Requirements

### Requirement: 条目来源
系统 SHALL 为以下情况自动生成收件箱条目：
- 任务进入 `blocked`，并且策略没有自动处理；
- 有新的待确认修改提案；
- 收到来自 supervisor 的提问事件（由变更 ④ 产生）；
- 每日摘要。

每个条目记录：来源、所属 workspace、级别、标题、正文、可用的操作，以及关联对象（任务 id 或提案 id）。

#### Scenario: 任务卡住生成条目
- **WHEN** 一个 `ws/product-res` 的任务变为 `blocked(question)`，且没有策略可以处理
- **THEN** 收件箱新增一个 Interrupt 条目，关联该任务，可用的操作为"回复"

### Requirement: 默认分级
条目级别 SHALL 按来源与原因确定默认值，用户可以在 `config/inbox.yaml` 中覆盖：
- `awaiting_approval`、`question`、`crashed`、`node_lost`：Interrupt；
- `no_progress`、`other`、待确认提案、supervisor 提问：Decide；
- `auto-report` 策略的执行记录、每日完成情况：Digest。

#### Scenario: 用户调低一类原因
- **WHEN** `inbox.yaml` 把 `no_progress` 设为 Digest
- **THEN** 之后 `no_progress` 的任务只出现在每日摘要中，不单独推送

### Requirement: 自动关闭
底层状态已经不再需要用户时，条目 SHALL 自动关闭并注明原因：任务回到 `running` 或进入终态、提案已被接受或拒绝、提问已被答复。已推送的消息 MUST 同步更新为"已处理"。

#### Scenario: 在电脑上处理后手机消息同步
- **WHEN** 用户在终端用 `raindown task reply` 答复了一个已经推送到 Telegram 的任务
- **THEN** 该条目关闭，Telegram 上的原消息被改为"已处理（来自 CLI）"，按钮消失

### Requirement: 操作
条目上的操作 SHALL 映射到已有的操作：批准、驳回、回复（`task_reply`），接受、拒绝提案（`kb_proposals_accept` / `kb_proposals_reject`），以及忽略（关闭条目，不动底层对象）。经由用户本人渠道发起的操作，以 `user` 身份执行，并记录渠道来源。

#### Scenario: 在手机上接受提案
- **WHEN** 用户在 Telegram 上点击某个提案条目的"接受"
- **THEN** 该提案以 `user` 身份被接受，brain 的 `log.md` 中出现 `apply` 记录，条目关闭

### Requirement: 推送节奏
- **Interrupt**：条目生成后 SHALL 立即推送；处于静默时段（默认 23:00–08:00，可配置）时，顺延到时段结束。
- **Decide**：按配置的时间点合并成一条消息推送（默认 09:00 和 18:00）；待处理的条目超过 N 个（默认 5）时提前推送。
- **Digest**：每天合并成一条摘要，默认 08:30 推送。

#### Scenario: 夜间卡住
- **WHEN** 凌晨 2 点一个任务进入 `blocked(question)`
- **THEN** 条目立即生成，但推送顺延到 08:00

### Requirement: 查询
系统 SHALL 提供 `inbox_list` 操作，按状态、级别、workspace 过滤；提供 `inbox_act` 操作执行条目上的操作。CLI 和 MCP 自动获得对应入口。

#### Scenario: 列出待处理条目
- **WHEN** 用户运行 `raindown inbox`
- **THEN** 以表格列出所有未关闭的条目，按级别和时间排序

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
