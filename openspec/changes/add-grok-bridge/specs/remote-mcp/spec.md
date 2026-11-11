# Spec Delta

## Purpose

规定远程 MCP 入口：云端或其他机器上的 AI 智能体（首个是 Grok Bot）如何经私有网络访问 Raindown，以及它们能看到什么、能做什么，使远程接入不扩大用户本人的权限面。

## ADDED Requirements

### Requirement: 独立的远程监听端口
中枢 SHALL 在一个独立的本机回环端口（默认 `127.0.0.1:7478`，可在 `config/hub.yaml` 中配置或关闭）上提供远程 MCP 入口，使用 MCP streamable HTTP 传输，路径为 `/mcp`。该端口 MUST NOT 提供中枢的 `/v1` API、`/ui` 页面或事件流。`config/remote.yaml` 中没有任何有效的远程调用方时，该端口 MUST NOT 监听；调用方增删后，中枢 SHALL 在不重启的情况下开始或停止监听。带 `Tailscale-Funnel-Request` 请求头的请求 MUST 被拒绝（403 `funnel_denied`），`Host` 不在允许列表内的请求 MUST 被拒绝（421），二者都在鉴权之前判定。

#### Scenario: 远程端口不暴露中枢 API
- **WHEN** 向 `127.0.0.1:7478/v1/tasks` 发送带合法远程凭证的请求
- **THEN** 返回 404，不返回任何账本内容

#### Scenario: 没有远程调用方
- **WHEN** `config/remote.yaml` 不存在或为空，此时启动中枢
- **THEN** 7478 端口不被监听，`raindown remote status` 显示"未启用"

#### Scenario: 删除最后一个调用方
- **WHEN** 中枢运行中，用户从 `remote.yaml` 删除唯一的调用方
- **THEN** 数秒内 7478 端口停止监听，不需要重启中枢

#### Scenario: 经 Funnel 到达的请求
- **WHEN** 一个带 `Tailscale-Funnel-Request` 请求头和合法远程凭证的请求到达远程端口
- **THEN** 返回 403 `funnel_denied`，不执行任何工具

### Requirement: 远程调用方配置
每个远程调用方 SHALL 在 `config/remote.yaml` 中定义：`id`（其操作者身份为 `remote:<id>`）、`workspaces`（可访问的 workspace 白名单，默认空，最多 8 个）、`include_global`（默认 false）、`capabilities`（`read`、`propose`、`report` 的子集）、`rate_limit_per_minute`（默认 60），以及接派工所需的 `dispatch`（见 executor-grok-routine）。配置不合法时 MUST 报告文件和字段，并只停用出错的调用方。修改后 MUST 在不重启中枢的情况下生效。

#### Scenario: 单个调用方配置错误
- **WHEN** `remote.yaml` 中有两个调用方，其中一个的 `capabilities` 含未知值 `admin`
- **THEN** 出错的调用方不被加载，`raindown doctor` 报告文件与字段，另一个调用方照常可用

### Requirement: 远程认证
远程 MCP 入口的每个请求 MUST 携带有效凭证，凭证 SHALL 是 actor 为 `remote:<id>`、带 `remote` 标注且未撤销的绑定 token（或在 OAuth 分支下经用户本机确认后签发的、同样绑定 `remote:<id>` 的访问令牌），且 `<id>` 是已加载的远程调用方。请求的操作者身份由凭证决定，请求自报的身份一律忽略。其他凭证（user token、`node:*` token、派工令牌、唤醒令牌）以及缺失、无效或已撤销的凭证 MUST 返回 401。

#### Scenario: 用 user token 访问远程入口
- **WHEN** 用 `state/hub.token` 的值作为 Bearer token 请求远程入口
- **THEN** 返回 401，user token 不能用于远程入口

#### Scenario: 调用方已从配置中删除
- **WHEN** 用户从 `remote.yaml` 中删除 `grok`（另有其他调用方，端口仍在监听），之后 Grok 继续用原来的 token 请求远程入口
- **THEN** 返回 401，不执行任何工具

#### Scenario: OAuth 授权需要用户本人确认
- **WHEN** 远程调用方发起 OAuth 授权
- **THEN** 只有在用户本人于本机 `/ui` 页面上确认（页面显示调用方、授权范围与回调主机）后才签发令牌，令牌绑定的身份为 `remote:<id>`，并出现在 `raindown hub token list` 中、可以撤销

#### Scenario: OAuth 回调地址不在白名单
- **WHEN** 动态客户端注册请求的 redirect_uri 主机不在该调用方的 `oauth.redirect_hosts` 中
- **THEN** 注册被拒绝，不签发任何凭证

### Requirement: 按调用方裁剪工具
远程会话的工具列表 SHALL 只包含其 `capabilities` 允许的操作：`read` 对应 `kb_search`、`kb_get`、`kb_query`、`ws_list`；`propose` 对应 `kb_propose`；`report` 对应 `raindown_report` 与 `task_show`（只限派给该调用方的任务，见 executor-grok-routine）。其余操作——包括 workspace 简报、随手记、写 journal、建任务、列出任务、取消或重试任务、回复任务、代答、处理收件箱、接受或驳回提案、转移资源、读取事件与读取密钥——MUST NOT 对远程调用方开放：工具列表中不出现，直接调用返回 `forbidden`。新增的操作在显式加入映射之前 MUST NOT 对远程调用方开放。远程工具的输入 MUST NOT 含读取本地路径的参数。

#### Scenario: 调用未授权的工具
- **WHEN** 只有 `read` 能力的 `remote:grok` 直接调用 `kb_propose`
- **THEN** 返回 `forbidden`，不产生任何提案

#### Scenario: 远程调用方不能审批
- **WHEN** `remote:grok` 试图调用 `task_reply` 或 `inbox_act`
- **THEN** 工具列表中没有这两个工具；直接调用时返回 `forbidden`

#### Scenario: 随手记不对远程开放
- **WHEN** `remote:grok` 直接调用 `capture`
- **THEN** 返回 `forbidden`，`raw/inbox/` 没有新增文件

### Requirement: 远程提案
远程会话的 `kb_propose` SHALL 只接受 `target`、`content`、`reason`，MUST NOT 接受 `file`。新内容的归属 MUST 全部在调用方白名单内，不能为 global，`scope` 不能是 `personal`，否则返回 `workspace_mismatch`。目标条目已存在但对调用方不可见（白名单外、global 而未允许、或 `scope: personal`）时，提案 SHALL 照常保存并标记目标不可见，返回给调用方的结果与目标不存在时相同；用户接受这类提案 MUST 被拒绝。远程响应 MUST NOT 包含 `base_hash` 或其他能反映目标条目当前内容的字段。

#### Scenario: 用 file 读取中枢文件
- **WHEN** `remote:grok` 调用 `kb_propose`，参数中带 `file: "state/hub.token"`
- **THEN** 输入校验失败，中枢不读取任何文件

#### Scenario: 提案写到白名单外
- **WHEN** 白名单只有 `ws/product-res` 的 `remote:grok` 提交新内容归属 `ws/xuanxue-saas` 的提案
- **THEN** 返回 `workspace_mismatch`，不生成提案

#### Scenario: 目标是不可见的已有条目
- **WHEN** `remote:grok` 对一个已存在、属于 `ws/xuanxue-saas` 的条目路径提交新内容归属 `ws/product-res` 的提案
- **THEN** 调用方得到与新建条目相同形式的结果 `{id, target}`；用户在提案列表中看到"目标对提议者不可见"，接受时被拒绝

### Requirement: 远程会话的可见范围
远程会话的知识读取 SHALL 只返回白名单 workspace 内的条目与 journal 记录；不属于任何 workspace 的条目、`ws/global` 与未标 workspace 的 journal 记录只有在调用方配置了 `include_global: true` 时才返回；`scope: personal` 的条目 MUST NOT 返回给任何远程调用方。过滤 MUST 在检索与读取之前完成，不可见的条目与不存在的条目返回相同的 `not_found`，计数与分页不泄露不可见条目。

#### Scenario: 检索不会越过白名单
- **WHEN** `remote:grok` 的白名单只有 `ws/product-res`，它检索一个只在 `ws/xuanxue-saas` 的条目中出现的词
- **THEN** 结果为空

#### Scenario: 个人条目不外流
- **WHEN** `remote:grok` 检索一个只出现在 `scope: personal` 条目中的词，或按标识读取该条目
- **THEN** 检索结果为空，读取返回 `not_found`

#### Scenario: global 默认不可见
- **WHEN** `include_global` 为 false 的 `remote:grok` 读取一个没有归属 workspace 的条目
- **THEN** 返回 `not_found`

#### Scenario: 未标 workspace 的 journal 记录
- **WHEN** 某天的 journal 有一条标 `ws/product-res` 的记录和一条未标 workspace 的记录，`include_global` 为 false 的 `remote:grok` 读取这一天的 journal
- **THEN** 只返回标 `ws/product-res` 的那条记录

### Requirement: 远程任务查看
远程会话的 `task_show` MUST 带任务 id 与当前派发的 `dispatch_ref`，授权规则与远程上报相同（先核对任务是否派给本调用方，不满足一律 `forbidden`；再核对 `dispatch_ref`，不满足 `not_running`）。返回内容 SHALL 只是远程投影：任务 id、workspace、角色、状态、目标、原始指令、当前派工的回复与输入；MUST NOT 包含事件、其他派工、产物、节点信息或 `dispatch_ref`。

#### Scenario: 查看别人的任务
- **WHEN** `remote:grok` 以任意 `dispatch_ref` 查看一个从未派给它的任务，或一个不存在的任务 id
- **THEN** 两种情况都返回 `forbidden`，响应相同

### Requirement: 远程调用限额
每个远程调用方的全部工具调用 SHALL 受 `rate_limit_per_minute` 限制，超额时返回可重试的 `rate_limited`，不执行工具。

#### Scenario: 调用过快
- **WHEN** `rate_limit_per_minute` 为 60 的 `remote:grok` 在一分钟内发出第 61 次调用
- **THEN** 返回 `rate_limited`，`retryable` 为 true

### Requirement: 远程调用审计
每次通过认证的远程工具调用 SHALL 记入账本 `remote.call` 事件：调用方 id、actor、工具名、涉及的 workspace、结果（成功、被拒、出错、超限）和耗时，不记录输入正文与返回内容。被拒的调用除这条审计事件外不改变任何状态。同一调用方、同一工具在 1 分钟内的成功调用 MAY 合并为一条并附次数；被拒的调用 MUST 逐条记录，同一调用方每分钟超过 20 条时超出部分合并为一条带次数的事件。未通过认证的请求 MUST NOT 入账，只写有速率限制的日志。`raindown remote status` MUST 显示每个调用方的启用状态、最近一次调用的时间、过去 24 小时的调用数与被拒次数。

#### Scenario: 被拒的调用可追溯
- **WHEN** `remote:grok` 调用了一个未授权的工具
- **THEN** 账本中有一条 `remote.call` 事件，结果为 `forbidden`，`raindown remote status` 中被拒次数加一

#### Scenario: 未认证的请求不入账
- **WHEN** 有人用无效 token 连续请求远程入口一千次
- **THEN** 账本没有新增事件，日志中只有有限条数的记录

### Requirement: 发布方式检查
`raindown doctor` SHALL 在启用远程入口时检查 Tailscale 的发布配置：远程端口 MUST 只经 `tailscale serve` 发布到 tailnet 内，MUST NOT 开启 Funnel，中枢的 `/v1` 端口 MUST NOT 被发布。检测到违规时报错并给出修正命令；找不到 `tailscale` 命令时只给出警告。

#### Scenario: 误开了 Funnel
- **WHEN** 用户对远程端口执行了 `tailscale funnel`
- **THEN** `raindown doctor` 报错"远程 MCP 入口被发布到了公网"，并提示 `tailscale funnel reset` 等修正方式

#### Scenario: 中枢 API 被发布
- **WHEN** `tailscale serve` 的代理目标包含 `127.0.0.1:7477`
- **THEN** `raindown doctor` 报错，指出 `/v1` 被发布到了 tailnet
