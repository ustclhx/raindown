# Proposal

## Why

用户在用 Grok Bot：SpaceXAI 的常驻 AI 智能体，每个 Bot 有自己的云端电脑，能跑定时任务（routine），有 iPhone 端。用户希望它也能成为 Raindown 的一个"干活的 AI"，与 Codex、Claude 并列：能查 Raindown 的知识库，能接 Raindown 派的活，干完把结果交回来。

2026-10-25 的调研结论（详见 design 的 Context）：
- Grok Bot 不能连本机或 localhost 上的 MCP，只能连远程 MCP（streamable HTTP / SSE）。Cursor 的官方 Tailscale 插件（2026-10-12 合入，灰度开放）让 Bot 以 `tag:grokbot` 设备加入用户的 tailnet，由 Cursor 后端经 tailnet 连接 MCP。
- 外部系统没有 API 往 Bot 的对话里发消息；但 routine 可以由 webhook 触发（`POST` 加 Bearer key），结果写进 Bot 的聊天。

Grok Bot 运行在第三方云上，提示词和数据会发送给 xAI 及其模型提供商。因此本变更的前提是：**Grok 只能以远程 AI 身份接入，只能读被授权的 workspace、写提案、为派给它的任务上报，永远不能代用户审批或回复任务**。

自 PR #18（2026-10-24）以来，main 已经落地了本变更需要的大部分地基，本次按当前 main 重写计划，只保留仍缺的部分：
- 中枢鉴权（[hub-auth.md](../../../docs/hub-auth.md)）：`raindown hub token issue <actor> --remote` 已能签发带 `remote` 标注的绑定 token，且在本机端口 7477 的 `/v1` 上一律 403 `remote_not_allowed`；策略已把 7478 视为中枢端口。
- add-harness-neutral-coordination：结构化上报 `raindown_report`、`task.reported` 事件、续约响应携带未消费上报、适配器能力声明、任务绑定的 MCP 会话。本变更**不再新增 `task_report`**，改为复用 `raindown_report`。
- add-worker-credential-isolation：任务绑定会话的知识读取已经经中枢执行，并有按 workspace 计算的可见范围（`KbVisibility`、`entryScopes`）；适配器声明 `credential_isolation`；角色 `isolation: required | preferred | off`。

## What Changes

- **远程身份命名空间**：远程调用方的 actor 固定为 `remote:<调用方 id>`（例如 `remote:grok`），与 `node:*` 一样成为保留前缀（不区分大小写）：只有带 `remote` 标注、且 actor 为小写 `remote:<id>` 的绑定 token 能得到它；user token 降级、`raindown mcp --actor`、CLI 的 `--actor` 与 `RAINDOWN_ACTOR` 都不能声明 `remote:*`。`--remote` 不再接受其他形式的 actor。
- **远程 MCP 入口**：中枢新增一个独立的本机监听端口（默认 `127.0.0.1:7478`），只提供 MCP（streamable HTTP，路径 `/mcp`），不暴露 `/v1` API、Web 页面和事件流。用户用 `tailscale serve` 把它发布到 tailnet 内，绝不使用 Funnel；带 Funnel 请求头的请求一律拒绝，`Host` 受限。没有远程调用方时不监听，随配置增删开关。
- **远程调用方（remote client）**：`config/remote.yaml` 定义每个远程调用方的 `id`、workspace 白名单、是否包含 global、能力集合（`read`、`propose`、`report`）、每分钟调用上限，以及接派工用的 `dispatch`（webhook 地址与 `secret://` key）。远程会话是继任务绑定（`task`）、唤醒绑定（`wake`）之后的第三种 MCP 会话绑定（`remote`），工具按能力白名单裁剪：`read` 只有 `kb_search`、`kb_get`、`kb_query`、`ws_list`；`propose` 只有 `kb_propose`（远程 schema 去掉 `file`，归属必须在白名单内，不透露目标是否存在）；`report` 为 `raindown_report` 与受限的 `task_show`。`ws_brief`、`capture`、`kb_journal` 不开放。知识读取复用中枢已有的按 workspace 可见范围，扩展为"多个 workspace + 可选 global + 排除 `scope: personal`"，未标 workspace 的 journal 记录按 global 处理。
- **认证方式**：优先使用固定 Bearer token（即上面的 remote token）。Grok 的自定义 MCP 如果不支持固定请求头，就在远程端口上实现最小的 OAuth 2.1 授权（授权码 + PKCE + 动态客户端注册，redirect_uri 白名单），由用户在本机 `/ui` 页面确认授权，签发的访问令牌同样绑定 `remote:<id>`。实际采用哪一种，由第 1 组的实测决定。
- **派活给 Grok**：新增执行器 `grok-routine`。节点用 core 已有的模板渲染派工正文（原始指令、supervisor 补充、恢复提示、待送达输入），经新的节点协议接口交给中枢；**中枢**生成本次派发的 `dispatch_ref`、脱敏、解密 webhook key 并调用 routine webhook（key 只在中枢内存，webhook 主机固定）。Grok 经远程入口调用 `raindown_report` 上报；中枢先核对授权（任务确实派给了本调用方，否则一律 `forbidden`），再核对 `dispatch_ref` 与任务状态，之后按现有流程入账、由节点经续约消费。无上报超时进入 `blocked(no_progress)` 时仍接受当前派发的迟到结果；节点重启后的重试接管原派发，不重复触发 Grok。
- **适配器声明**：能力声明新增 `off_machine`（harness 不在节点本机运行）。`grok-routine` 声明 `off_machine: true`、`raindown_mcp: false`（不加载本机任务绑定 MCP）、`credential_isolation` 一律为 `none`（沙箱设置 `off-machine`，没有本机 worker 进程可隔离）。`isolation: required` 的角色不能使用 grok-routine（角色加载按执行器名报错，fail closed）；`preferred` 下不标注"未隔离"，改标"外部执行"。
- **交付物**：`raindown_report ready` 的交付物在 GitHub PR 之外，新增知识库提案引用（`raindown:proposal/<id>`），中枢核对提案的 `actor` 是上报者、在本次派工期间提交、属于任务的 workspace。调研类任务以提案作为交付物。
- **审计与可见性**：通过认证的远程调用全部入账（`remote.call`：调用方、工具、workspace、结果；被拒调用有每分钟上限），未认证的请求只写有速率限制的日志；`raindown remote status` 显示每个远程调用方最近的调用和被拒次数；`raindown doctor` 检查 `tailscale serve` 只发布了远程端口，且没有开启 Funnel。
- **不在本次范围**：Grok 的聊天消息转发到 Raindown 收件箱（PRD §14 第 1 项的"聊天入口"仍待定）；Grok 写随手记、journal 或读 workspace 简报；Grok 在用户 Mac 上执行命令；其他云端智能体的适配（远程调用方与 `off_machine` 按通用设计，以后可复用）；多节点（`node:<id>` 远程节点另行规划）。

## Capabilities

### New Capabilities
- `remote-mcp`：远程 MCP 入口的监听方式、认证、远程调用方配置（workspace 白名单、能力）、远程会话的工具与可见范围、审计与发布检查。
- `executor-grok-routine`：通过 routine webhook 把任务派给 Grok Bot，并经远程入口的 `raindown_report` 收回结果的执行器行为。

### Modified Capabilities
- `hub-daemon`：第二个监听端口；`remote:*` 保留身份与 remote token 的签发、使用规则。
- `knowledge-access`：MCP 工具经第三种传输（远程入口）提供；远程会话的知识读取经中枢、可见范围由调用方配置决定。
- `worker-report`：上报身份可以来自绑定该派工的远程调用方；`ready` 的交付物可以是知识库提案。
- `harness-adapter`：能力声明新增 `off_machine`。
- `worker-isolation`：off_machine 执行器的隔离声明与 `isolation: required` 的关系。

## Impact

- **代码**：`packages/hub`（第二个监听端口、MCP over HTTP、远程凭证与可选的 OAuth 端点、远程派发接口与 webhook 调用、远程上报核对、`remote.call` 审计）、`packages/mcp`（抽出与传输无关的工具注册，供 stdio 与 HTTP 共用）、`packages/node`（`grok-routine` 执行器）、`packages/core`（`config/remote.yaml` schema、`remote` 绑定与远程 schema、`KbVisibility` 扩展与索引版本 4、`remote:*` 保留身份、`off_machine` 声明与 `off-machine` 沙箱设置、提案交付物与 `target_hidden`、doctor 检查）。
- **依赖**：`@modelcontextprotocol/sdk` 已有，使用其 streamable HTTP 服务端传输；不新增依赖。
- **前置条件**：均已在 main 上（hub-auth 的 remote 标注、add-harness-neutral-coordination、add-worker-credential-isolation、密钥提供器）。密钥只能由中枢解密、引用扫描只覆盖 `config/*.yaml`，所以 webhook key 配在 `config/remote.yaml`、由中枢发出 webhook；不需要改密钥提供器。
- **行为变化**：此前允许的 user token 降级为 `remote:*` 身份（以及 `creatable_by` 中 `remote:*` 对这类降级身份的匹配）改为 403 `reserved_actor`；已签发的 actor 不是 `remote:<id>` 的 remote token 不能用于远程入口，doctor 提示重新签发。
- **用户需要做的**：确认账号已开通 Grok Bot 的 Tailscale 插件；在 tailnet ACL 中只放行 `tag:grokbot → <Mac>:443`；在 Mac 上运行 `tailscale serve`；在 Grok 里添加 Raindown 的 MCP 连接器；为要派活的 Bot 建一个 routine 并拿到 webhook key。
- **数据外流**：Grok 读到的知识条目、以及派工正文（任务目标、原始指令、恢复提示、回复）会发送到 xAI。workspace 白名单默认为空，用户需要显式授权；`scope: personal` 的条目一律不外发，但写进指令或回复里的个人内容会原样发出。
