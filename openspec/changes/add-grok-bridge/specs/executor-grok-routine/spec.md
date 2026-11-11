# Spec Delta

## Purpose

规定 `grok-routine` 执行器：通过 routine webhook 把任务派给 Grok Bot，并由 Grok 经远程 MCP 入口的 `raindown_report` 上报结果，使不在本机运行的云端智能体能像本机执行器一样承接 Raindown 的任务。

## ADDED Requirements

### Requirement: 角色与调用方配置
使用 `grok-routine` 的角色 SHALL 在 `permissions.remote_client` 中引用一个远程调用方。webhook 地址与 key MUST 配置在该调用方的 `dispatch` 中（`config/remote.yaml`），不在角色中：`webhook` MUST 是固定主机下的 routine webhook 地址（主机为代码常量），`key` MUST 是 `secret://` 引用。调用方不存在、没有 `report` 能力或没有 `dispatch` 时，中枢 MUST 拒绝创建该角色的任务（`remote_client_invalid`）；任务所属 workspace 不在该调用方白名单内时 MUST 拒绝创建（`workspace_not_allowed`）。

#### Scenario: 白名单外的 workspace
- **WHEN** `grok-research` 角色引用的调用方白名单只有 `ws/product-res`，用户为 `ws/xuanxue-saas` 创建该角色的任务
- **THEN** 创建失败，错误码为 `workspace_not_allowed`，账本不新增事件

#### Scenario: webhook 指向其他主机
- **WHEN** `remote.yaml` 中 `grok` 的 `dispatch.webhook` 被改成 `https://example.com/hook`
- **THEN** 该调用方加载失败，`raindown doctor` 报告字段，任何请求都不会把 key 发往该地址

### Requirement: 能力声明
`grok-routine` 适配器 SHALL 声明交互能力：`approval_requests: none`、`inject_while_running: false`、`resume_session: false`、`raindown_mcp: false`、`out_of_band_detection: false`、`off_machine: true`；在节点注册的 `task_inputs` 字段中声明 true；按沙箱设置 `off-machine` 声明凭证隔离施加层为 `none`、`enforced: false`。节点 MUST NOT 为它写入派工令牌文件。

#### Scenario: 查看节点
- **WHEN** 节点注册了 `grok-routine`，用户运行 `raindown node list`
- **THEN** 该执行器显示为"外部执行"，隔离施加层为 `none`

### Requirement: 由中枢发出 webhook
每次派工时，节点 SHALL 用 core 的派工模板（恢复提示、待送达输入、原始指令与 supervisor 补充）加角色提示词与固定的交付说明组成正文，经节点协议交给中枢；该请求 MUST 带与任务未过期活动租约匹配的 `lease_token`（或由持有该租约的节点身份发出）。中枢 SHALL 生成本次派发的 `dispatch_ref` 并填入正文，经密钥脱敏后解密 key，向 webhook 发送 `POST`（带 `Idempotency-Key: <任务 id>:<attempt>`，不跟随重定向，响应体有大小上限），并记录远程派发事件。每个租约 MUST 最多派发一次：同一租约的重复请求（含派发仍在进行时）返回同一个结果，不再调用 webhook。webhook key 与 `dispatch_ref` 明文 MUST NOT 出现在节点、账本、活动、结果或日志中（账本只存 `dispatch_ref` 的摘要）。webhook 返回 2xx 时任务保持 `running`；返回 429 或网络错误时重试，仍失败则以 `failed(dispatch_unreachable)` 结束；返回其他非 2xx 时以 `failed(dispatch_rejected)` 结束并记录状态码；key 解密不到时以 `failed(secret_not_found)` 结束，不发出请求。

#### Scenario: 成功派发
- **WHEN** 节点领取一个角色为 `grok-research` 的任务，webhook 返回 200 和一个运行 id
- **THEN** 任务保持 `running`，活动记录中出现"已派发到 Grok，运行 id 为 …"，活动与账本中没有 webhook key 与 `dispatch_ref` 明文

#### Scenario: 只有 user token 的进程请求派发
- **WHEN** 一个读到 `state/hub.token` 的进程以 user 身份调用某个 grok 任务租约的远程派发接口，但没有该租约的 `lease_token`
- **THEN** 请求被拒绝，不调用 webhook，不产生派发事件

#### Scenario: 节点超时后重发派发请求
- **WHEN** 中枢正在为某个租约重试 webhook，节点请求超时后对同一租约再次请求远程派发
- **THEN** webhook 只被调用一轮，两次请求得到同一个结果，账本只有一条派发事件

#### Scenario: key 未配置
- **WHEN** `grok` 的 `dispatch.key` 引用的 `secret://grok/webhook-key` 不存在
- **THEN** 任务以 `failed(secret_not_found)` 结束，不发出任何请求

### Requirement: 经远程上报收回结果
派发后，执行器 SHALL 等待 Grok 经远程入口调用 `raindown_report`，上报按现有的上报与推断合并规则处理：`ready`、`failed`、`dropped` 结束派工；`question`、`blocked` 使任务以 `basis: reported` 卡住；`progress` 计为活动。超过角色 `no_progress_minutes` 没有任何上报时，任务 MUST 以 `blocked(no_progress)`（`basis: inferred`）卡住，节点继续持有租约，说明 Grok 未在时限内上报。卡在 `no_progress` 期间，当前派发的上报 SHALL 仍被接受：终态上报解除卡住并按上报结束派工，`question` 或 `blocked` 上报替换卡住原因。

#### Scenario: Grok 交付提案
- **WHEN** Grok 提交了一个 `ws/product-res` 的提案，然后以本次派发的 `dispatch_ref` 上报 `ready`，交付物为该提案的引用
- **THEN** 任务进入验收或 `done`，结果的产物中有该提案，上报事件的操作者为 `remote:grok`

#### Scenario: 超时未上报
- **WHEN** 派发后超过 `no_progress_minutes` 没有收到任何上报
- **THEN** 任务变为 `blocked(no_progress)`，收件箱生成相应条目，用户可以回复（重新派发）或取消

#### Scenario: 超时后 Grok 才交回结果
- **WHEN** 任务已因无上报卡在 `blocked(no_progress)`，Grok 原来那次运行以当前 `dispatch_ref` 上报 `ready`
- **THEN** 上报被接受，任务解除卡住并按上报完成，结果不丢失

### Requirement: 回复即重新派发
Grok 侧的运行无法续接。任务卡住后收到回复时，执行器 SHALL 以新的派工重新派发，新派发带新的 `dispatch_ref`，回复与恢复提示放在正文开头；之前派发的 `dispatch_ref` 随之失效。

#### Scenario: 回答 Grok 的提问
- **WHEN** Grok 上报 question 后任务为 `blocked(question)`，用户选择了一个选项
- **THEN** 任务重新排队并再次派发给 Grok，正文开头包含用户的答复；旧运行此后的上报返回 `not_running`

### Requirement: 中断后接管
任务因节点重启或掉线卡在 `crashed` 或 `node_lost` 期间，中枢 SHALL 接受并暂存当前派发的上报，不改变任务状态。任务被重试时，如果上一次远程派发未被取代、派发时间在 `no_progress_minutes` 之内或已有暂存的上报、且新派工没有新的回复或待送达输入，中枢 SHALL 把上一次的 `dispatch_ref` 转给新派工，不再调用 webhook，并在新租约的第一次续约中下发暂存的上报；否则重新派发。`task_retry` 的 `reason` MUST NOT 被视为新的输入。

#### Scenario: 节点重启后重试
- **WHEN** Grok 正在运行时节点重启，任务卡在 `crashed`，用户随即 `task_retry`
- **THEN** 不产生新的 webhook 调用，Grok 原来那次运行之后的 `ready` 上报使任务完成

#### Scenario: 中断期间 Grok 已交回结果
- **WHEN** 任务卡在 `node_lost` 期间 Grok 以当前 `dispatch_ref` 上报 `ready`，之后用户 `task_retry` 并附 reason
- **THEN** 上报在卡住期间被接受并暂存；重试不调用 webhook，新派工的第一次续约下发该上报，任务按它完成

### Requirement: 取消
任务被取消时，执行器 SHALL 停止等待并以 `cancelled` 结束；之后到达的上报返回 `not_running`。Grok 侧的运行无法被 Raindown 停止，这一点 MUST 在取消结果中注明。

#### Scenario: 运行中取消
- **WHEN** 用户取消一个已派发给 Grok 的任务
- **THEN** 任务变为 `cancelled`，结果注明"Grok 侧的运行仍可能继续，其上报将被拒绝"
