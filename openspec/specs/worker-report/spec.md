# worker-report Specification

## Purpose
让 worker 通过 Raindown 自己的 MCP 工具结构化地说明当前状态和需要人决定的问题，不再只能由适配器从 harness 的输出里推断；并规定上报与推断结果如何合并。

## Requirements

### Requirement: 上报工具
系统 SHALL 提供 worker 可调用的 `raindown_report` 操作，输入为状态之一：`progress`、`question`、`ready`、`blocked`、`failed`、`dropped`，以及一句话摘要。调用者身份 MUST 绑定到当前持有租约的任务与派工，不能为其他任务上报；任务不在运行中时返回 `not_running`。

#### Scenario: 为别的任务上报
- **WHEN** 任务 A 的 worker 以任务 B 的 id 调用 `raindown_report`
- **THEN** 返回 `forbidden`，账本不新增事件

#### Scenario: 普通进展
- **WHEN** worker 调用 `raindown_report progress "已完成数据层改动"`
- **THEN** 账本记录一条上报事件，任务保持 `running`，不唤醒 supervisor，不产生收件箱条目

### Requirement: 结构化提问
`question` 上报 MUST 带一个具体问题，可以带 2–8 个选项（每个选项有简短标签与说明）和推荐选项。系统 SHALL 把任务转为 `blocked(question)`，原样保存问题与选项，送给 supervisor 或用户的内容来自这些字段而不是终端文字。一次上报只允许一个问题。

#### Scenario: 带选项的提问
- **WHEN** worker 上报 question，问题为"标题用哪个"，选项 A、B，推荐 A
- **THEN** 任务为 `blocked(question)`，收件箱条目与 supervisor 唤醒输入中的选项与上报一致，并标明推荐项

### Requirement: 完成、受阻与无需处理
`ready` 表示交付物已就绪可以审阅，MUST 附交付物引用（如 PR 地址）时由系统核对其存在；`blocked` MUST 写明缺少的前提与已尝试的办法；`failed` 表示无法完成；`dropped` 表示经核实无需处理。`dropped` 的任务以 `done` 结束且不推送通知。

#### Scenario: 无需处理
- **WHEN** worker 核实问题无法复现后上报 `dropped`
- **THEN** 任务以 `done` 结束，结果标记为 dropped，不产生收件箱条目

### Requirement: 上报与推断的合并
每次卡住都 MUST 记录来源 `basis`：worker 上报为 `reported`，适配器推断为 `inferred`。worker 停下前已有未处理的上报时以上报为准；没有上报时由适配器推断。上报的状态与适配器观察矛盾时（例如上报 `progress` 但 harness 已空闲超过阈值），系统 SHALL 记录矛盾并按适配器的观察处理。

#### Scenario: 停下但没有上报
- **WHEN** worker 终端空闲且未调用 `raindown_report`
- **THEN** 适配器的推断结果生效，卡住记录 `basis: inferred`

### Requirement: 推断的提问不交给 supervisor 代答
`basis: inferred` 的 `question` MUST NOT 委托给 supervisor 代答，直接转给用户；授权请求不受此限制（它们来自适配器的结构化识别，见 harness-adapter）。

#### Scenario: 终端里猜出来的提问
- **WHEN** 适配器从终端文字推断出一个 question，且该 workspace 开启了代回复
- **THEN** 不产生代回复委托，收件箱条目直接给用户
