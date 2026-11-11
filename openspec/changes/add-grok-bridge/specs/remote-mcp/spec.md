# Spec Delta

## Purpose

规定远程 MCP 入口：云端或其他机器上的 AI 智能体（首个是 Grok Bot）如何经私有网络访问 Raindown，以及它们能看到什么、能做什么，使远程接入不扩大用户本人的权限面。

## ADDED Requirements

### Requirement: 独立的远程监听端口
中枢 SHALL 在一个独立的本机回环端口（默认 `127.0.0.1:7478`，可在 `config/hub.yaml` 中配置或关闭）上提供远程 MCP 入口，使用 MCP streamable HTTP 传输，路径为 `/mcp`。该端口 MUST NOT 提供中枢的 `/v1` API、`/ui` 页面或事件流。`config/remote.yaml` 中没有任何有效的远程调用方时，该端口 MUST NOT 监听。

#### Scenario: 远程端口不暴露中枢 API
- **WHEN** 向 `127.0.0.1:7478/v1/tasks` 发送带合法远程凭证的请求
- **THEN** 返回 404，不返回任何账本内容

#### Scenario: 没有远程调用方
- **WHEN** `config/remote.yaml` 不存在或为空，此时启动中枢
- **THEN** 7478 端口不被监听，`raindown remote status` 显示"未启用"

### Requirement: 远程调用方配置
每个远程调用方 SHALL 在 `config/remote.yaml` 中定义：`id`（其操作者身份为 `remote:<id>`）、`workspaces`（可访问的 workspace 白名单，默认空）、`include_global`（默认 false）、`capabilities`（`read`、`propose`、`report` 的子集）。配置不合法时 MUST 报告文件和字段，并只停用出错的调用方。修改后 MUST 在不重启中枢的情况下生效。

#### Scenario: 单个调用方配置错误
- **WHEN** `remote.yaml` 中有两个调用方，其中一个的 `capabilities` 含未知值 `admin`
- **THEN** 出错的调用方不被加载，`raindown doctor` 报告文件与字段，另一个调用方照常可用

### Requirement: 远程认证
远程 MCP 入口的每个请求 MUST 携带有效凭证，凭证 SHALL 是 actor 为 `remote:<id>`、带 `remote` 标注且未撤销的绑定 token（或在 OAuth 分支下经用户本机确认后签发的、同样绑定 `remote:<id>` 的访问令牌），且 `<id>` 是已加载的远程调用方。请求的操作者身份由凭证决定，请求自报的身份一律忽略。其他凭证（user token、`node:*` token、派工令牌、唤醒令牌）以及缺失、无效或已撤销的凭证 MUST 返回 401。

#### Scenario: 用 user token 访问远程入口
- **WHEN** 用 `state/hub.token` 的值作为 Bearer token 请求远程入口
- **THEN** 返回 401，user token 不能用于远程入口

#### Scenario: 调用方已从配置中删除
- **WHEN** 用户从 `remote.yaml` 中删除 `grok`，之后 Grok 继续用原来的 token 请求远程入口
- **THEN** 返回 401，不产生任何写入

#### Scenario: OAuth 授权需要用户本人确认
- **WHEN** 远程调用方发起 OAuth 授权
- **THEN** 只有在用户本人于本机 `/ui` 页面上确认后才签发令牌，令牌绑定的身份为 `remote:<id>`，并出现在 `raindown hub token list` 中、可以撤销

### Requirement: 按调用方裁剪工具
远程会话的工具列表 SHALL 只包含其 `capabilities` 允许的操作：`read` 对应 `kb_search`、`kb_get`、`kb_query`、`ws_list`、`ws_brief`；`propose` 对应 `kb_propose`、`capture`；`report` 对应 `raindown_report` 与 `task_show`（只限当前派给该调用方的任务）。建任务、取消或重试任务、回复任务、代答、处理收件箱、接受或驳回提案、写 journal、转移资源、读取事件与读取密钥 MUST NOT 对远程调用方开放：工具列表中不出现，直接调用返回 `forbidden`。新增的操作在显式加入映射之前 MUST NOT 对远程调用方开放。写入类操作的目标 workspace MUST 在白名单内，否则返回 `workspace_mismatch`。

#### Scenario: 调用未授权的工具
- **WHEN** 只有 `read` 能力的 `remote:grok` 直接调用 `kb_propose`
- **THEN** 返回 `forbidden`，不产生任何写入

#### Scenario: 远程调用方不能审批
- **WHEN** `remote:grok` 试图调用 `task_reply` 或 `inbox_act`
- **THEN** 工具列表中没有这两个工具；直接调用时返回 `forbidden`

#### Scenario: 提案写到白名单外
- **WHEN** 白名单只有 `ws/product-res` 的 `remote:grok` 对 `ws/xuanxue-saas` 的条目调用 `kb_propose`
- **THEN** 返回 `workspace_mismatch`，不生成提案

### Requirement: 远程会话的可见范围
远程会话的知识读取与 workspace 简报 SHALL 只返回白名单 workspace 内的条目与 journal 记录；不属于任何 workspace 的条目与 `ws/global` 只有在调用方配置了 `include_global: true` 时才返回；`scope: personal` 的条目 MUST NOT 返回给任何远程调用方。过滤 MUST 在检索与读取之前完成，不可见的条目与不存在的条目返回相同的 `not_found`，计数与分页不泄露不可见条目。

#### Scenario: 检索不会越过白名单
- **WHEN** `remote:grok` 的白名单只有 `ws/product-res`，它检索一个只在 `ws/xuanxue-saas` 的条目中出现的词
- **THEN** 结果为空

#### Scenario: 个人条目不外流
- **WHEN** `remote:grok` 检索一个只出现在 `scope: personal` 条目中的词，或按标识读取该条目
- **THEN** 检索结果为空，读取返回 `not_found`

#### Scenario: global 默认不可见
- **WHEN** `include_global` 为 false 的 `remote:grok` 读取一个没有归属 workspace 的条目
- **THEN** 返回 `not_found`

### Requirement: 远程调用审计
每次远程工具调用 SHALL 记入账本 `remote.call` 事件：调用方 id、actor、工具名、涉及的 workspace、结果（成功、被拒、出错）和耗时，不记录输入正文与返回内容。同一调用方、同一工具在 1 分钟内的成功调用 MAY 合并为一条并附次数；被拒的调用 MUST 每条单独记录。`raindown remote status` MUST 显示每个调用方的启用状态、最近一次调用的时间、过去 24 小时的调用数与被拒次数。

#### Scenario: 被拒的调用可追溯
- **WHEN** `remote:grok` 调用了一个未授权的工具
- **THEN** 账本中有一条 `remote.call` 事件，结果为 `forbidden`，`raindown remote status` 中被拒次数加一

### Requirement: 发布方式检查
`raindown doctor` SHALL 在启用远程入口时检查 Tailscale 的发布配置：远程端口 MUST 只经 `tailscale serve` 发布到 tailnet 内，MUST NOT 开启 Funnel，中枢的 `/v1` 端口 MUST NOT 被发布。检测到违规时报错并给出修正命令；找不到 `tailscale` 命令时只给出警告。

#### Scenario: 误开了 Funnel
- **WHEN** 用户对远程端口执行了 `tailscale funnel`
- **THEN** `raindown doctor` 报错"远程 MCP 入口被发布到了公网"，并提示 `tailscale funnel reset` 等修正方式

#### Scenario: 中枢 API 被发布
- **WHEN** `tailscale serve` 的代理目标包含 `127.0.0.1:7477`
- **THEN** `raindown doctor` 报错，指出 `/v1` 被发布到了 tailnet
