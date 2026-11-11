# Spec Delta

## Purpose

规定 `grok-routine` 执行器：通过 routine webhook 把任务派给 Grok Bot，并由 Grok 经远程 MCP 入口的 `raindown_report` 上报结果，使不在本机运行的云端智能体能像本机执行器一样承接 Raindown 的任务。

## ADDED Requirements

### Requirement: 角色配置
使用 `grok-routine` 的角色 SHALL 在 `permissions` 中提供 `remote_client`（`config/remote.yaml` 中具备 `report` 能力的调用方 id）、`webhook`（https 地址）与 `key`（`secret://` 引用）。任一项缺失或不合法时角色不被加载，`raindown doctor` 报告文件与字段。任务所属 workspace 不在该调用方白名单内时，中枢 MUST 拒绝创建任务，错误码为 `workspace_not_allowed`。

#### Scenario: 白名单外的 workspace
- **WHEN** `grok-research` 角色绑定的调用方白名单只有 `ws/product-res`，用户为 `ws/xuanxue-saas` 创建该角色的任务
- **THEN** 创建失败，错误码为 `workspace_not_allowed`，账本不新增事件

### Requirement: 能力声明
`grok-routine` 适配器 SHALL 声明：`approval_requests: none`、`inject_while_running: false`、`resume_session: false`、`raindown_mcp: false`、`out_of_band_detection: false`、`off_machine: true`、`task_inputs: true`，并按沙箱设置 `off-machine` 声明凭证隔离施加层为 `none`、`enforced: false`。节点 MUST NOT 为它写入派工令牌文件。

#### Scenario: 查看节点
- **WHEN** 节点注册了 `grok-routine`，用户运行 `raindown node list`
- **THEN** 该执行器显示为"外部执行"，隔离施加层为 `none`

### Requirement: 经 webhook 派发任务
每次派工时，执行器 SHALL 用 core 的派工模板（恢复提示、待送达输入、原始指令与 supervisor 补充）加角色提示词与固定的交付说明（任务 id、本次派工的 `dispatch_ref`、调用 `raindown_report` 的要求）组成正文，经密钥脱敏后向 `webhook` 发送 `POST`，带 `Idempotency-Key: <任务 id>:<attempt>`。webhook key 只在节点内存中解析，MUST NOT 出现在活动、结果或日志中。webhook 返回 2xx 时任务保持 `running`；返回 429 或网络错误时在同一派工内重试，最多 3 次后以 `failed(dispatch_unreachable)` 结束；返回其他非 2xx 时以 `failed(dispatch_rejected)` 结束并记录状态码。

#### Scenario: 成功派发
- **WHEN** 节点领取一个角色为 `grok-research` 的任务，webhook 返回 200 和一个运行 id
- **THEN** 任务保持 `running`，活动记录中出现"已派发到 Grok，运行 id 为 …"，活动中没有 webhook key 与 `dispatch_ref`

#### Scenario: key 未配置
- **WHEN** 角色引用的 `secret://grok/webhook-key` 不存在
- **THEN** 任务以 `failed` 结束，错误码为 `secret_missing`，不发出任何请求

### Requirement: 经远程上报收回结果
派发后，执行器 SHALL 等待 Grok 经远程入口调用 `raindown_report`，上报按现有的上报与推断合并规则处理：`ready`、`failed`、`dropped` 结束派工；`question`、`blocked` 使任务以 `basis: reported` 卡住；`progress` 计为活动。超过角色 `no_progress_minutes` 没有任何上报时，任务 MUST 以 `blocked(no_progress)`（`basis: inferred`）卡住，说明 Grok 未在时限内上报。

#### Scenario: Grok 交付提案
- **WHEN** Grok 提交了一个 `ws/product-res` 的提案，然后以本次派工的 `dispatch_ref` 上报 `ready`，交付物为该提案的引用
- **THEN** 任务进入验收或 `done`，结果的产物中有该提案，上报事件的操作者为 `remote:grok`

#### Scenario: 超时未上报
- **WHEN** 派发后超过 `no_progress_minutes` 没有收到任何上报
- **THEN** 任务变为 `blocked(no_progress)`，收件箱生成相应条目，用户可以重试或取消

### Requirement: 回复与重试即重新派发
Grok 侧的运行无法续接。任务卡住后收到回复，或被重试时，执行器 SHALL 以新的派工重新触发 webhook，新派工带新的 `dispatch_ref`，回复与恢复提示放在正文开头；之前派工的 `dispatch_ref` 随之失效。

#### Scenario: 回答 Grok 的提问
- **WHEN** Grok 上报 question 后任务为 `blocked(question)`，用户选择了一个选项
- **THEN** 任务重新排队并再次派发给 Grok，正文开头包含用户的答复；旧运行此后的上报返回 `not_running`

### Requirement: 取消
任务被取消时，执行器 SHALL 停止等待并以 `cancelled` 结束；之后到达的上报返回 `not_running`。Grok 侧的运行无法被 Raindown 停止，这一点 MUST 在取消结果中注明。

#### Scenario: 运行中取消
- **WHEN** 用户取消一个已派发给 Grok 的任务
- **THEN** 任务变为 `cancelled`，结果注明"Grok 侧的运行仍可能继续，其上报将被拒绝"
