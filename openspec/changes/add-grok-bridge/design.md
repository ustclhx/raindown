# Design

## Context

**调研与实测**（2026-11-11 调研取代 10-25 的结论；11-14 在 Mac 上自测发布链路，11-17 在用户账号中由 Grok 发起实测；证据为临时 ping 服务的请求日志、supervisor 本机的时间戳与 `tailscale status` / `whois`）。证据等级：**实测**、**现场确认**（在产品界面上看到）、**官方陈述**（文档或官方论坛）、**待验证**。

涉及三个分开的位置：Bot 的云电脑（Linux 沙箱，能跑 `curl`）、远程 MCP 连接器的后端（xAI 侧，发起自定义 MCP 调用）、用户的 Mac（中枢所在）。"云电脑能进 tailnet"不等于"连接器后端能进"。

- **网络**：
  - 官方 Tailscale 插件 11-09 正式发布，经 OAuth apps 授权（官方陈述）。在云电脑上自己装 tailscaled 每次更新、恢复或重置都会被清掉（cursor/plugins#774），不作为方案。
  - Bot 的云电脑以完整 Linux 节点加入用户的 tailnet，节点名形如 `grokbot-user-<n>`，**归属用户本人、默认没有 tag**；用户迁移过一次 Grok Bot 账号后出现了新节点（IP 也变了），旧节点离线残留（实测）。
  - Mac 用 `tailscale serve --https=443 http://127.0.0.1:<port>`（只对 tailnet）发布的测试服务，云电脑上的 `curl/8.14.1` 经**聊天、定时 routine、webhook 触发的 routine** 三条路径都访问成功并拿到 nonce，来源为 Grok 节点的 tailnet IP，`Host` 为 Mac 的 `<mac>.<tailnet>.ts.net`（实测，11-17）。这些请求都是不带 `Authorization`、没有请求体的 `GET`；带认证头的 `POST` 与 SSE 响应能否原样经过 `serve` 待验证（1.4）。
  - **自定义 MCP 连接器的调用来自 xAI 后端，后端是否在 tailnet 内仍待验证**（第 1 组头号剩余项）。
  - `tailscale serve` 会给转发的请求注入 `Tailscale-User-Login`、`Tailscale-User-Name` 等身份头；因 Grok 节点归属用户本人，这些头显示的是用户本人（实测，11-14 本机自测与 11-17）。
  - 首次发布 HTTPS 时证书签发约 1 分钟，期间 TLS 握手挂起（实测，11-14）。Mac 与 Grok 节点之间经 DERP 中继、未直连，延迟 0.25–2.3 秒（实测，11-17）。
- **MCP 传输与认证**：远程 MCP 支持 streamable HTTP 和 SSE；连接器界面有固定请求头的填写项（现场确认，11-11）；连接器实际是否发送、初始化/复用/重连时是否都带上待验证（1.5）；官方论坛 11-06 称已修复复用会话时漏发协议版本头的问题（官方陈述）。OAuth 支持预注册的客户端 id 与 scopes（官方陈述）。
- **反方向（webhook）**（官方陈述来自 docs.x.ai/grok-bot/skills-routines-and-automations）：
  - `POST https://api2.cursor.sh/automations/webhook/<uuid>`，`Authorization: Bearer <key>`，`Content-Type: application/json`，请求体可选（官方陈述；11-17 按此调用成功）。
  - `200` 返回 `{"success":true,"runUuid":"…"}`，触发后 routine 回连了 Mac（实测，11-17；从触发到回连约 48 秒，依据 supervisor 本机时间戳，不在请求日志里）。`200` 只表示已接受、已开始运行（官方陈述）。
  - 非 200 表示没有开始运行（官方陈述，未实测）。D6 对非 200 不重试，依据的就是这条官方陈述。
  - 限额：所有 routine 合计每小时 300 次、单个 routine 每小时 200 次；超限报 `Automation run rate limit exceeded`，不自动重试（均为官方陈述，未实测）。
  - 文档没有描述 webhook 的自动重试、签名、`Idempotency-Key`，也没有给出超限时的状态码——这些按**未确认**处理，设计不依赖它们。请求体在 routine 中如何呈现（`webhook_event`）与大小限制待验证。
  - 没有接口可以往已有对话里发消息，也没有"运行结束后回调任意 URL"的原生保证。
- **出口 IP**：没有稳定的出口 IP 列表，账号迁移也会换 IP。不做 IP 或主机名白名单。

**Raindown 现状**（main，2026-11-11）：
- **MCP**：只有 stdio（`packages/mcp/src/server.ts`），工具由 core 的 `operations` 生成。会话有三种情形：无绑定（本地执行）、唤醒绑定（`fwk_`，supervisor）、任务绑定（`fls_`，只列 `raindown_report`、`task_show`、`event_get`、`kb_search`、`kb_get`、`kb_query`，见 `taskBindingAllows`）。`OpBinding.kind` 目前是 `task | wake`。
- **知识读取经中枢**：`POST /v1/kb/search|get|query` 只接受任务绑定令牌，可见范围为"任务的 workspace + `ws/global`"（`packages/core/src/search/visibility.ts` 的 `KbVisibility{workspace}`、`entryScopes`；journal 按记录正向选择；不可见即 `not_found`）。目前**不排除** `scope: personal`。
- **鉴权**：`state/hub-tokens.json` 的记录已有 `remote` 标注；`raindown hub token issue <actor> --remote` 可签发（actor 只需是非保留的合法身份，例如 `grok`）；remote token 在 7477 的 `/v1` 上一律 403 `remote_not_allowed`。`creatable_by` 支持 `remote:*` 模式，但 `remote:` 目前**不是**保留前缀，user token 可以降级声明 `remote:grok`。策略把 7477、7478 都视为中枢端口（`DEFAULT_HUB_PORTS`）。
- **上报**：`raindown_report`（`progress | question | ready | blocked | failed | dropped`）经 `POST /v1/tasks/:id/report` 写 `task.reported`，只认当前派工的 `fls_` 令牌；续约响应带最近一次未消费的上报，节点合并后经续约或完成提交。`ready` 的交付物只支持 GitHub PR，由中枢按 `repo_snapshot` 与任务分支核对。
- **适配器契约**：注册时声明 `approval_requests`、`inject_while_running`、`resume_session`、`raindown_mcp`、`out_of_band_detection`、`credential_isolation{layers, enforced}`；中枢只读 `inject_while_running` 与 `task_inputs`，不按执行器类型名分支。`isolation: required` 只派给已隔离的节点；`supervisor-session` 与 `in-node`（pr-merge）设为 `required` 时角色加载失败。
- **密钥**：`secret://` 只由中枢解密（`packages/hub/src/secrets/service.ts`），明文只在中枢内存；引用扫描覆盖 `config/*.yaml`，不含 `config/roles/`；节点的脱敏器没有密钥值列表。
- **派工输入模板**：`renderWorkerTaskPrompt`（原始指令 / supervisor 补充）、`renderRecoveryPrompt`、`renderTaskInputs`，适配器原样使用。

## Goals / Non-Goals

**Goals:**
- Grok 能按授权范围查知识库、写提案、为派给它的任务上报。
- Raindown 能把一类任务（调研、整理、需要浏览器的工作）派给 Grok，并像其他执行器一样跟踪结果、卡住、重试。
- 远程接入不扩大权限面：Grok 拿不到 `user` 或本机 AI 身份，看不到白名单之外的 workspace 和个人条目，中枢 `/v1` 不暴露到 tailnet。
- 尽量复用 main 上已有的机制（绑定 token、会话绑定、经中枢的知识读取、`raindown_report`、适配器声明），不另起一套。
- 设计对"远程调用方""不在本机运行的 harness"通用，不写死 Grok。

**Non-Goals:**
- Grok 聊天内容同步到 Raindown，或 Raindown 收件箱推送到 Grok。
- Grok 在用户 Mac 上执行命令、开 PR。
- 多用户、公网访问、远程节点（`node:<id>`）。

## Decisions

### D1 远程入口是中枢内的第二个监听端口
- 中枢进程内再起一个 Hono 应用，监听 `127.0.0.1:7478`（`config/hub.yaml` 的 `remote.port`，可关闭），只挂 `/mcp`。用户用 `tailscale serve --bg --https=443 http://127.0.0.1:7478` 发布，tailnet 里只看得到这个端口。
- **随配置开关**：`config/remote.yaml` 刷新（2 秒有效期，与角色缓存一致）后，有至少一个有效调用方而端口未监听时开始监听；一个也没有时关闭监听，正在处理的请求以 401 结束。中枢启动时同理。
- **请求入口检查**（在鉴权之前）：带 `Tailscale-Funnel-Request` 头的请求一律 403 `funnel_denied`（纵深防御，即使 Funnel 被误开也不服务）；`Host` 必须是配置的 tailnet 主机名（`config/hub.yaml` 的 `remote.allowed_hosts`，即 Mac 的 `<mac>.<tailnet>.ts.net`，11-17 实测 `tailscale serve` 转发时保留这个 `Host`）或 `127.0.0.1:<端口>`，否则 421；MCP SDK 传输层同时打开 DNS rebinding 保护并设同样的 `allowedHosts`。
- **不信任 Tailscale 身份头**：`tailscale serve` 注入的 `Tailscale-User-*` 头反映的是节点归属者，Grok 节点归属用户本人，头里就是用户本人。中枢完全忽略这些头：不用于认证、授权、操作者身份，也不写入审计或日志；操作者只由 D3 的 token 决定。另一个理由：本机任何进程直接请求 `127.0.0.1:7478` 都能伪造这些头和 tailnet 的 `Host`，所以它们本来就不可信。测试覆盖伪造的 `Tailscale-User-*` 头不改变任何结果。
- **为什么放在中枢内**：凭证校验、可见范围、审计入账、远程派发与上报的核对本来就在中枢；中枢本来就持有 raindown-home 与解密后的密钥，远程会话的操作在中枢进程内执行，不需要额外进程。代价是远程输入在一个能读全部状态的进程里被处理，所以远程会话可用的操作必须逐个审查输入（见 D5：去掉一切读本地文件的参数）。
- **备选**：在 7477 上加 `/mcp` 路径，再用 `tailscale serve` 只代理这个路径。没有采用：路径级代理一旦配错，`/v1` 就会暴露；分端口的隔离更直观，也便于 doctor 检查。7478 早已被策略当作中枢端口识别，worker 命令直接访问它会按 `shell.opaque` 处理。

### D2 MCP 服务端与传输解耦
- 把 `packages/mcp` 中"由 operations 生成工具、按绑定裁剪、调用、渲染结果"的部分抽成 `createRaindownMcpServer({ ctx, binding })`。stdio 入口和 HTTP 入口共用它。
- HTTP 入口使用 SDK 的 Web 标准 streamable HTTP 服务端传输，以无状态模式运行，每个请求按凭证建立 `remote` 绑定并新建 server 实例，便于和 Hono 集成，也不必维护会话。
- 远程会话的工具**输入 schema 可以比本机更窄**（`kb_propose` 没有 `file`；`raindown_report`、`task_show` 必须带 `id` 与 `dispatch_ref`），**输出可以是投影**（`kb_propose` 不返回 `base_hash`；`task_show` 只返回远程投影）。远程 schema 由远程映射表给出并导出到 `schemas/`。除此之外工具的行为与本机一致。
- **一致性测试**：把现有的 CLI 与 MCP 一致性测试扩展到 HTTP 传输，对远程 schema 与本机相同的工具（`kb_search`、`kb_get`、`kb_query`）比较结果。

### D3 远程身份与凭证（复用绑定 token）
- 远程调用方的 actor 固定为 `remote:<id>`，`<id>` 与 `config/remote.yaml` 中的调用方 id 一致，只允许小写（与 `NODE_ACTOR_RE` 同样写成 `REMOTE_ACTOR_RE`）。`remote:` 成为与 `node:` 同级的保留前缀，比较不区分大小写：
  - `raindown hub token issue remote:grok --remote` 签发；`--remote` 只接受 `remote:<id>`，`remote:<id>` 也必须带 `--remote`（`issueTokenRequest` 的 refine 与 `boundActor` 一起改）；
  - 新增与 `isNodeActor` 并列的 `isRemoteActor`，`isDeclarableActor` 拒绝 `remote:*`。因此 user token 用 `X-Raindown-Actor` 声明 → 403 `reserved_actor`；`raindown mcp --actor remote:*` 拒绝启动；CLI 的 `--actor` 与 `RAINDOWN_ACTOR`（`resolveActor`）声明 `remote:*` → 用法错误 `reserved_actor`；角色名不能以 `remote:` 开头；
  - 这样账本、审计与 `creatable_by` 中出现的 `remote:*` 只可能来自真正的远程凭证，本机 AI 不能冒充 Grok。
- 远程入口只接受 actor 为 `remote:<id>`、带 `remote` 标注、未撤销、且 `<id>` 是已加载调用方的 token；user token、`node:*` token、`fls_` / `fwk_` 令牌一律 401。7477 上 remote token 的行为不变（403 `remote_not_allowed`）。
- 已签发的、actor 不是 `remote:<id>` 的 remote token（例如按旧文档签发的 `grok`）在远程入口得到 401；`raindown doctor` 列出这类记录，提示撤销并重新签发。
- **为什么不另做凭证**：hub-auth 的绑定 token 已经提供签发一次、只存摘要、立即撤销、最近使用时间；远程入口只需要在它上面加"属于哪个调用方"的判定。

### D4 认证：Bearer 是唯一路径
- 认证只用 D3 的 remote token，以 `Authorization: Bearer` 携带：走连接器时填进 Grok MCP 连接器的固定请求头（连接器界面可填固定请求头，现场确认；实际是否在初始化/复用/重连时发送待 1.5 验证；无状态模式下漏发即每次 401，届时按下面的备用条件处理）；走 D12 的云电脑路径时由云电脑上的调用方带上。本变更不实现 OAuth，远程端口不挂 `/.well-known/oauth-*`、`/oauth/*`。
- **OAuth 只是备用条件**：第 1 组实测发现某条调用路径（初始化、复用或重连）不带请求头时，另开变更做 OAuth，用预注册客户端（固定 client id 与 scopes），不做动态客户端注册；回调地址按那时的实测填写，不预先写死。
- **为什么**：动态注册、短码确认、在 Mac 上确认 iPhone 发起的授权等都会多出安全面；连接器已有固定请求头的填写项，D2 的无状态模式让每个请求独立认证，漏发会表现为明确的 401，不会出现部分请求以错误身份通过的情况。

### D5 远程调用方、`remote` 绑定与可见范围
- `config/remote.yaml`：

  ```yaml
  clients:
    - id: grok                     # actor 为 remote:grok
      workspaces: [ws/product-res] # 白名单，默认空，最多 8 个
      include_global: false        # 是否可见 ws/global、无归属条目与未标 workspace 的 journal 记录，默认 false
      capabilities: [read, propose, report]
      rate_limit_per_minute: 60    # 本调用方全部工具调用的上限，默认 60
      dispatch:                    # 有 report 能力、要接派工的调用方才需要；见 D6
        kind: grok-routine
        webhook: https://api2.cursor.sh/automations/webhook/<uuid>
        key: secret://grok/webhook-key
  ```

  单个调用方出错只停用该调用方并报告文件与字段；`remote.yaml` 与 roles、policies 一样是提权面，由用户维护（AI 不得经 MCP 修改 config，现有规则已覆盖）。它位于 `config/` 顶层，中枢的密钥引用扫描（`config/*.yaml`）已覆盖它。
- **会话绑定**：`OpBinding` 新增 `kind: 'remote'`，携带 `client`、`workspaces`、`includeGlobal`、`capabilities`，由中枢按凭证建立，请求中的任何字段都不能声明或改写。`applyBinding` 对 `remote` 绑定按 `remoteBindingAllows` 白名单放行，其余返回 `forbidden`。
- **能力到操作的映射**（core 常量，有快照测试；新增操作默认不开放）：

  | 能力 | 操作 | 约束 |
  |---|---|---|
  | `read` | `kb_search`、`kb_get`、`kb_query`、`ws_list` | 可见范围见下；`ws_list` 只列白名单内的 workspace |
  | `propose` | `kb_propose` | 远程 schema 没有 `file`；归属与返回见下 |
  | `report` | `raindown_report`、`task_show` | 只能作用于派给本调用方的任务（D7）；`task_show` 必须带当前 `dispatch_ref`，只返回远程投影 |

  不开放：
  - `ws_brief`：supervisor 启用时中枢会附加进行中任务的目标、收件箱标题、代回复记录等中枢数据（`hubBriefSections`），按 owner/workspace 过滤也不排除个人条目，并且会取写锁跑 `validateBrain`。远程需要时以后另设安全投影。
  - `capture`：没有目标 workspace，直接追加到 `raw/inbox/`、无需确认，会成为向更高权限的本机 AI（ingest、supervisor）投毒的通道。
  - `kb_journal`（直接写入 brain）、`task_create`、`task_list`、`task_cancel`、`task_retry`、`task_reply`、`task_respond`、`inbox_*`、`kb_proposals_*`、`resource_transfer`、`event_get`、supervisor 专用操作、读取密钥。
  
  不开放的工具不出现在列表中，直接调用返回 `forbidden`。
- **`kb_propose` 的远程约束**：
  - 输入只有 `target`、`content`、`reason`；没有 `file`（中枢进程能读全部状态，`file` 会让远程调用方读到 `state/hub.token` 等任意文件）。
  - **新内容**的归属（`entryScopes(新 frontmatter)`）必须全部落在白名单 workspace 内，不能为空（global）、不能含 `ws/global`，`scope` 不能是 `personal`；否则 `workspace_mismatch`。
  - **已有条目**的状态在提交时**不向调用方透露**：目标存在且属于以下任一情形——对该调用方不可见（归属在白名单外、global 而 `include_global: false`、`scope` 不是 `work`）、是 `decision` 或 `scope: personal` 条目（本机 `createProposal` 对这两类以 `checkOrdinary(before)` 提前返回 `proposal_forbidden`）、frontmatter 解析失败——时，远程调用**不提前返回**，提案照常保存，标记 `target_hidden: true` 并在内部记录原因（`hidden`、`not_ordinary`、`unparsable`，只给用户看）。`raindown kb proposals list|diff` 向用户显示"目标对提议者不可见或不可提案"。这样提交结果只取决于调用方自己写的内容，与目标是否存在、是什么类型无关，不形成存在性预言机。本机调用方的行为不变（仍然 `proposal_forbidden`）。
  - **接受被标记的提案**：拒绝在 core 的 `acceptProposals` 中执行，不只在 CLI：按 id 接受时返回 `remote_target_hidden`；`accept --all` 跳过被标记的提案、照常接受其余提案，并在结果中列出跳过的 id 与原因（不让一条被标记的提案拖垮整批）。被标记的提案只能拒绝。
  - 远程响应只返回 `{id, target}`，不返回 `base_hash`；校验失败只返回错误码与字段路径，不带含其他 workspace 名称的说明文字。
- **可见范围**：`KbVisibility` 从 `{workspace}` 扩展为 `{workspaces, includeGlobal, excludePersonal}`；任务绑定会话取 `{[任务 workspace], true, false}`（行为不变），远程会话取 `{白名单, include_global, true}`。
  - 条目：归属判定沿用 `entryScopes` 的取严规则（任一归属不可见即不可见；无法判定即不可见）；`includeGlobal: false` 时空归属与 `ws/global` 不可见；`excludePersonal` 时只有 frontmatter `scope` 恰好为 `work` 的条目可见（`scope` 是 `baseShape` 的必填字段；缺失、非法或 `personal` 都按个人条目处理，取严）。
  - journal：`filterJournalBody` 中**未标 workspace 的记录视为 global**，只在 `includeGlobal` 时保留（任务绑定会话恒为 true，行为不变）。
  - **SQL 实现**：现在的 `visibleScopeEncodings` 按可见集合枚举全部子集，是 2^N 个绑定参数，不适合多 workspace。改为在 SQL 中用 `json_each(e.scope)` 判断"每个归属都在可见集合内"（可见集合作为一个 JSON 参数传入）；白名单上限 8 个。注意空数组（global 条目）对"每个都在集合内"恒为真：`includeGlobal: false` 时必须另加 `json_array_length(e.scope) > 0` 显式排除，并有测试覆盖。个人条目需要新增索引列 `personal`（0/1），按 `scope !== 'work'` 取值（缺失或非法记为 1，fail closed；journal 不适用，记 0），`INDEX_VERSION` 升到 4（首次启动重建索引）。过滤在 SQL 层与读取前完成，不在返回后裁剪，避免分页和计数泄露；不可见条目与不存在同为 `not_found`。
- **实现路径**：远程会话的 `kb_*` 在中枢进程内调用与 `/v1/kb/*` 路由相同的 core 实现，只是可见范围来自远程绑定，不经过 HTTP 再走一遍 `/v1`。
- **限额**：每个调用方全部工具调用按 `rate_limit_per_minute` 限流，超额返回可重试的 `rate_limited`；`raindown_report` 另受现有的每派工限额约束。

### D6 grok-routine 执行器：节点渲染，中枢发出 webhook
- **适配器声明**（交互能力）：

  | approval_requests | inject_while_running | resume_session | raindown_mcp | out_of_band_detection | off_machine |
  | --- | --- | --- | --- | --- | --- |
  | none | false | false | false | false | true |

  另在节点注册的 `task_inputs` 字段（它不属于 `adapterCapabilities`）声明 true。`raindown_mcp: false`：它不加载本机的任务绑定 MCP，节点也不为它写派工令牌文件；上报经远程入口完成（D7）。`credential_isolation` 见 D8。
- **角色只引用调用方**：

  ```yaml
  name: grok-research
  executor: grok-routine
  prompt: grok-research.md
  no_progress_minutes: 60
  permissions:
    remote_client: grok   # 必须是 remote.yaml 中具备 report 能力、配置了 dispatch 的调用方
  ```

  webhook 地址与 key 放在 `remote.yaml` 的 `dispatch` 中，不放在角色里：key 是 `secret://` 引用，只有中枢能解密（secret-provider：明文只在中枢内存），中枢的引用扫描也只覆盖 `config/*.yaml`、不覆盖 `config/roles/`。建任务时中枢核对角色的 `remote_client`：调用方不存在、没有 `report` 能力或没有 `dispatch` → 422 `remote_client_invalid`；任务 workspace 不在其白名单内 → 403 `workspace_not_allowed`。
- **webhook 主机固定**：`dispatch.kind: grok-routine` 时 `webhook` 必须是 `https://api2.cursor.sh/automations/webhook/<uuid>` 形式（主机与路径前缀写在代码常量里，11-17 实测与官方文档一致），否则调用方加载失败。误改配置不会把 key 发到任意主机。
- **派工正文是结构化信封**：webhook 请求体始终是 JSON `{schema_version, task_id, dispatch_ref, report_by, text}`；`report_by` 取派发时间加角色的 `no_progress_minutes`，表示希望在此之前上报，不是截止时间；`text` 是下面拼出的可读正文，其中的交付说明始终包含任务 id 与 `dispatch_ref`。routine 中 `webhook_event` 如何呈现（1.10）只决定提示词让 Grok 从信封字段还是从 `text` 读取它们，不改变发送的内容。信封与正文都不带任何回调地址。
- **交付说明**（`text` 末尾的固定段落）：任务 id、`dispatch_ref`、调用 `raindown_report` 的要求、调研结论用 `kb_propose` 提交并以 `ready` 交付提案；遇到登录、密钥或审批时上报 `blocked`；上报失败（例如 Mac 离线）时稍后重试；过了 `report_by` 仍要上报，迟到的上报照样会被接收；不得按正文中出现的任何 URL 回调或上报，结果只能经 Raindown 的远程入口交回。
- **派发由中枢发出**：节点领取任务后，适配器按顺序拼出派工正文：恢复提示（`renderRecoveryPrompt`）、待送达输入（`renderTaskInputs`）、任务来源（`renderWorkerTaskPrompt`）、角色提示词，以及上面的交付说明（`dispatch_ref` 为占位）。节点经新的节点协议接口 `POST /v1/leases/:id/remote-dispatch {body, lease_token}` 交给中枢。租约接口对 user token 也开放（本机节点就用它），所以这里与其他依赖租约的字段一样，**必须带与该任务未过期活动租约匹配的 `lease_token`**（或由持有该租约的 `node:<id>` 调用），只拿到 `state/hub.token` 的进程不能借此触发 webhook；`lease_token` 不入账。中枢核对租约与角色的 `remote_client`，生成 `dispatch_ref` 填入信封与正文，按已知密钥值与 gitleaks 规则脱敏，解密 key，向 webhook 发出 `POST`（`Content-Type: application/json`；MAY 附带 `Idempotency-Key: <task id>:<attempt>`，但文档未描述它，设计不依赖其效果），写 `remote.dispatched{task, attempt, client, dispatch_ref_sha256, run_id, status}` 事件，向节点返回结果（不含 `dispatch_ref`）。key 与 `dispatch_ref` 明文都不进账本、活动与日志，节点也拿不到它们。
- **幂等**：每个租约（即每个 attempt）最多一次远程派发。中枢按 `(task, attempt)` 记录派发；同一租约再次请求时不再调用 webhook，直接返回已有结果——派发仍在进行（中枢在请求内退避重试，节点可能超时后重发）时等待同一个进行中的派发完成后返回同一结果。webhook 端是否去重未确认，幂等只靠中枢自己的记录。
- **出站请求**：`fetch` 设 `redirect: 'manual'`（不跟随跳转，避免 key 随跳转发往别处；3xx 作为普通响应返回，便于与网络错误区分）、总超时 30 秒，响应体最多读取 64 KiB；只解析其中的 `runUuid`。
- **结果**（按官方陈述的契约，其中 `200` 已于 11-17 实测：`200` 即已开始运行，非 200 即没有开始运行）：
  - `200`：活动记"已派发到 Grok，运行 id 为 …"；响应体超限或解析不到 `runUuid` 时仍按成功处理（不记运行 id），因为 Grok 已开始运行。
  - 3xx 跳转（`redirect: 'manual'` 下作为响应返回，不跟随）：按 `dispatch_rejected` 处理，不重试——跳转说明地址或服务变了，不是暂时性故障；与网络错误区分开，不归入 `dispatch_unreachable`。
  - 其他状态码：以 `failed(dispatch_rejected)` 结束，记录状态码与错误文本的前 200 字符（脱敏后）。超限（`Automation run rate limit exceeded`，状态码未确认）也归入此类，不在请求内重试——限额按小时计，秒级重试没有意义；活动写明"Grok 运行次数超限，稍后重试任务"。
  - 网络错误或超时（不知道是否已开始运行）：中枢在同一请求内重试（最多 3 次、指数退避），仍失败返回可重试错误，节点在本派工内再试一次后以 `failed(dispatch_unreachable)` 结束。这种重试可能让 Grok 重复运行，见风险。
  - key 解密不到时以 `failed(secret_not_found)` 结束，不发出请求。
- **dispatch_ref**：中枢在每次远程派发时生成的不透明随机串，只经 webhook 正文给 Grok。它不是凭证（必须配合该调用方自己的 token 才有意义），但仍按秘密对待：账本只存 SHA-256，`task_show`、事件、活动、`raindown task show` 一律不出现它；中枢按摘要核对，重启后照样可用。
- **等待与消费**：派发后适配器不产生观察；Grok 的上报照常经续约下发给节点，由节点的合并逻辑处理——`ready` / `failed` / `dropped` 结束派工；`question` / `blocked` 时适配器随即报告 idle，任务以 `basis: reported` 卡住；`progress` 视为活动。
- **长时间没有上报**：超过角色的 `no_progress_minutes` 没有上报时，节点照常判定 `blocked(no_progress)`（`basis: inferred`），消息写明"Grok 在 N 分钟内没有上报"，节点继续持有租约。`no_progress` 不在 `RETRYABLE_BLOCKED_REASONS` 中，`task_retry` 对持有租约的任务返回 `lease_active`，所以此时用户能做的只有回复或取消。为了不丢 Grok 迟到的结果：**off_machine 派工在 `blocked(no_progress)` 期间仍接受当前 `dispatch_ref` 的上报**（中枢只对这一组合放宽"必须 running"）；节点收到 `ready` / `failed` / `dropped` 后先写 `task.unblocked` 再按上报结束派工，收到 `question` / `blocked` 则把卡住换成上报的内容（`basis: reported`），`progress` 只记录、不解除卡住。
- **回复即重新派发**：Grok 侧的运行无法续接（`resume_session: false`），`deliver` 一律返回 `not_running`，中枢让任务带着回复重新排队；新派工生成新的 `dispatch_ref` 并重新派发，回复与恢复提示放在正文开头，旧 `dispatch_ref` 随之失效。对 `blocked(no_progress)` 的回复同样如此，回复界面提示"回复会重新派发给 Grok，旧运行的结果将被丢弃"。
- **中断期间暂存上报**：节点重启或掉线使任务进入 `blocked(crashed)` / `blocked(node_lost)` 时，Grok 的运行并没有停。off_machine 派工在这两种卡住期间同样接受当前 `dispatch_ref` 的上报（D7 第 2 步），中枢把它作为该派发的未消费上报保存，不改变任务状态；收件箱条目补一句"Grok 已交回结果，重试即可完成"。
- **中断后接管，不重复派发**：用户 `task_retry` 产生新派工。适配器请求远程派发时，如果上一次远程派发（同一任务、同一调用方）满足：没有被新的派发取代、派发时间在 `no_progress_minutes` 之内或已有暂存的上报、且这次派工没有新的回复或待送达输入，中枢不再调用 webhook，而是把上一次的 `dispatch_ref` 转给新派工（写 `remote.dispatch_adopted`）；已暂存的上报在新租约的第一次续约中下发，节点按常规合并（终态上报直接结束派工），Grok 之后的上报照常生效。`task_retry` 的 `reason` 只是说明重试依据，**不算新的输入**，不触发重新派发；用户要给 Grok 新信息时应当回复，回复一律重新派发。不满足接管条件时才重新触发 webhook。
- **取消**：任务被取消时适配器停止等待并以 `cancelled` 结束；Grok 侧的运行无法被 Raindown 停止，结果中注明"Grok 侧的运行仍可能继续，其上报将被拒绝"。

### D7 远程上报的核对：先授权，后状态
- 远程会话调用 `raindown_report` 与 `task_show` 必须带 `id` 与 `dispatch_ref`（远程 schema 中必填；任务绑定会话不变）。中枢按以下顺序核对，前一步不通过即返回：
  1. **授权**：账本中存在该任务派给本调用方的 `remote.dispatched`（或 `remote.dispatch_adopted`）记录，且调用方仍具备 `report` 能力、任务 workspace 仍在其白名单内。不满足——包括任务不存在、从未派给本调用方、派给的是本机执行器——一律返回同一个 `forbidden`，不区分原因，远程调用方无法借此探测任务是否存在或处于什么状态。
  2. **派工与状态**：`dispatch_ref` 的摘要等于该任务当前派工的远程派发记录，任务处于 `running`，或处于 `blocked(no_progress)`、`blocked(crashed)`、`blocked(node_lost)` 且该派发来自声明 `off_machine: true` 的执行器（D6；后两种只暂存，等重试接管）。不满足返回 `not_running`（只会发生在本调用方自己的任务上）。
- 核对通过后与派工令牌的上报走同一条写入路径：同样的输入校验、限额（每派工同时一个、每分钟 10 次、每派工 200 次）、`task.reported` 事件（操作者为 `remote:<id>`）、续约下发与 `report_seq` 消费。
- `task_show` 的远程投影只含：任务 id、workspace、角色、状态（含卡住原因）、目标、原始指令、当前派工的回复与输入；不含事件、其他派工、产物、节点信息与 `dispatch_ref`。
- 判定依据是派发记录与适配器声明，不按执行器类型名 `grok-routine` 分支，以后其他 off_machine 执行器可以复用。

### D8 隔离：没有本机 worker 进程
- worker-isolation 防的是"本机 worker 进程读到 Raindown 的状态、令牌与私钥"。grok-routine 在节点内只做模板渲染并请求中枢派发，harness 运行在 xAI 的云上，本机没有可施加 seatbelt 或 native 的进程；Grok 能触达 Raindown 的唯一途径是远程入口，其权限面由 remote token 与 `remote.yaml` 的能力决定。
- 因此 `SANDBOX_SETTINGS` 新增 `off-machine`，`roleSandboxSetting` 对 grok-routine 返回它；适配器声明 `credential_isolation: {layers: {off-machine: none}, enforced: false}`，**如实为 none**，不新增施加层取值，也不让探针为它运行。
- **与 `isolation` 的关系**：
  - `required`：角色加载失败，`raindown doctor` 报错"执行器 grok-routine 在本机之外运行，不支持隔离"，该角色的任务无法创建（fail closed）。角色加载是静态检查，看不到节点运行时的 `off_machine` 声明，所以与 pr-merge、supervisor-session 一样在 `requiredIsolationUnsupported` 中**按执行器名**判定（这是"不按类型名分支"的已有例外，只用于配置校验）。不允许"把 required 理解为已满足"，以免读到 required 的人误以为有本机隔离。
  - `preferred`（缺省）：不标注"未隔离"、不产生 `unisolated` 收件箱提示；`task.started` 改记 `off_machine: true`，任务与收件箱显示"外部执行（Grok）"。
  - `off`：不检查、不标注。

### D9 交付物：知识库提案
- `raindown_report ready` 的 `deliverables` 在 GitHub PR 之外接受 `raindown:proposal/<id>`。中枢核对：提案存在、提案记录的 `actor` 为上报者（远程调用方为 `remote:<id>`，本机 worker 为其角色身份）、新内容的归属属于任务的 workspace、`created_at` 不早于本次派工开始（接管的派发按原派发时间）。不满足返回 `deliverable_check_failed`，不泄露提案内容。
- **`target_hidden` 不参与核对**：被标记的提案与普通提案一样通过核对、合入产物，产物上带 `target_hidden` 标记（只在用户可见的任务结果、收件箱与 `raindown task show` 中显示"目标对提议者不可见或不可提案，只能拒绝"）。上报结果对 Grok 完全相同，因此 Grok 无法用"提案 + ready"探测某个路径是否是不可见的已有条目。远程 `task_show` 的投影本来就不含产物。
- 提案此时可以是待确认、已接受或已拒绝（用户可能在 `ready` 之前就处理了它）；交付物记录提案当时的状态，已拒绝的在任务结果中标明。
- 一个上报中 PR 与提案可以混用，总数仍不超过 5。提案引用合入任务结果的产物列表（`kind: proposal`）。
- 只有一段文字结论、没有可交付物的调研，Grok 把结论写进 summary（受 `PROTOCOL_MESSAGE_MAX` 限制），或用 `kb_propose` 提交一条新条目后交付。

### D10 审计
- 每次**已通过认证**的远程工具调用写一条 `remote.call` 事件，记录调用方、actor、工具、涉及的 workspace、结果（`ok`、`forbidden`、`error`、`rate_limited`）和耗时，不记正文与检索结果。被拒的调用不改变任何状态，只写这条审计事件；这是 hub-auth"权限拒绝不产生事件"的明确例外，仅限远程入口。
- 同一调用方、同一工具在 1 分钟内的成功调用合并成一条，附带次数；被拒的调用每条单独记，但同一调用方每分钟最多 20 条，超出部分合并为一条带次数的事件，防止账本被刷爆。
- 未通过认证的请求（401、421、`funnel_denied`）**不入账**，只写日志，日志每分钟最多 10 条。
- `raindown remote status` 从投影读取：每个调用方的启用状态、监听状态、最近一次调用、过去 24 小时调用数与被拒次数、token 最近使用时间、最近一次远程派发。

### D11 发布与 tailnet 访问策略
- **发布检查**：`raindown doctor` 在启用远程入口时运行 `tailscale serve status --json`，检查三点：只有远程端口被代理；`AllowFunnel` 为空；7477 没有出现在任何代理目标中。找不到 `tailscale` 命令时，只给出警告。测试注入假的 `tailscale` 二进制与 fixture 输出。
- **访问策略按 tag，不按 IP 或主机名**：Grok 的 IP 不可控（账号迁移会换节点和 IP），所以不绑定 Grok 的 IP 或节点名；身份只认 Raindown 的 token。tailnet 策略用 grants，示例（写进 `docs/grok.md`）：

  ```json
  {
    "tagOwners": { "tag:grokbot": ["autogroup:admin"] },
    "hosts": { "mac": "<Mac 的 tailnet IP>" },
    "grants": [
      { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },
      { "src": ["tag:grokbot"], "dst": ["mac"], "ip": ["tcp:443"] }
    ]
  }
  ```

  - **先删默认的全放行规则**（`src: ["*"]` 到 `dst: ["*"]`）：新加的窄规则不会覆盖已有的全放行。
  - **保留 `autogroup:member` 全通**，以免改策略时把用户自己的设备锁在外面。
  - **Grok 节点必须打 `tag:grokbot`**：它默认归属用户本人、没有 tag，会命中 `autogroup:member` 全通规则，能访问用户的全部设备。打 tag 后节点不再归属用户，只受第二条 grant 约束。迁移残留的旧节点同样归属用户，要在管理台删除。打 tag 后插件是否仍工作、新节点能否自动带 tag，第 1 组待验证。
  - grants 按源、目标、端口限定不需要付费；按设备状态区分才是付费功能（官方陈述）。
- **doctor 的文字提示**（唯一出处，spec 与 tasks 引用这里）：中枢不持有、也不读取用户的 Tailscale API 凭据，所以 doctor 不校验 tailnet 策略，只在启用远程入口时输出：① 删除默认全放行；② Grok 节点打 `tag:grokbot`，删除残留旧节点；③ grants 只放行 `tag:grokbot → Mac:443`；④ 首次发布 HTTPS 时证书签发约 1 分钟，期间 TLS 握手挂起，等一分钟再测试。`docs/grok.md` 用同样的内容。
- **撤权**：在 Tailscale 管理台移除 Grok 节点或撤销插件授权，Grok 立即连不到远程入口；与 `raindown hub token revoke` 一起写进回滚步骤。

### D12 远程调用从哪里发起，以及降级路径
- **首选：连接器**。Grok 的自定义 MCP 连接器直连 `https://<mac>.<tailnet>.ts.net/mcp`，Bearer 填在连接器的固定请求头里。前提是连接器后端（xAI 侧）能经插件进入 tailnet，这是第 1 组的头号验证项。
- **分支：云电脑调用**。如果连接器后端到不了 tailnet，而云电脑能（11-17 已实测三条路径都能），远程工具改由 Bot 云电脑上的 `curl` 按 MCP streamable HTTP 调用同一个 `/mcp`（或用等价的薄客户端，作为 Grok 的 skill 提供）。中枢侧不变：同一个端口、同一种 Bearer 认证、同一套工具与可见范围。不同的是 token 要放在云电脑可读的位置（Grok 的密钥设置，具体方式待验证），更容易被提示注入读出来；对策仍是能力白名单、限额与随时撤销。哪条分支由第 1 组结论决定，现在不定死。
- **降级：结果通道换成私有仓库 issue**（另开变更，本次不实现）。条件：后台运行（定时或 webhook 触发）既不能经连接器也不能经云电脑到达远程入口，而聊天能。届时知识读取继续走远程入口；结果由 Grok 用内置 GitHub 工具在专用私有仓库写 issue 或评论，中枢拉取，核对作者、`task_id`、`dispatch_ref` 摘要与格式，重复的不重复入账；派工仍由中枢发 webhook。这会给"结果只能经远程入口交回"开第二个入口，需要单独审查。
- **聊天也不通**：整体重评调研中的方案 C、D（另开变更）。

## Risks / Trade-offs

- **[风险] 数据发到 xAI。** 对策：workspace 白名单默认为空，global 默认不可见；个人条目一律不外发；派工正文经密钥脱敏。但派工正文中的目标、用户原始指令、恢复提示与回复是原样发出的，其中如果有个人内容同样会到 xAI——`scope: personal` 只约束知识条目，管不到用户自己写进指令的话。这一点写进 `docs/grok.md` 与 grok 角色提示，用户建 grok 角色任务时自行判断。
- **[风险] 中枢进程处理远程输入。** 远程会话的操作在能读全部状态的中枢进程内执行，任何"按路径读本地文件"的参数都会变成任意文件读取。对策：远程映射表逐个给出远程 schema（D2、D5），新增操作默认不开放，映射表有快照测试，审查清单写明"远程 schema 不得含路径类参数"。
- **[风险] Grok 被提示注入，滥用它有的权限。** 对策：写入只能走提案，必须经用户接受才生效；不开放 `capture` 与 journal，避免把未确认的内容写进会被本机 AI 读取的 raw 与 brain；上报只能针对派给它的当前派工；最坏情况是交回一份质量差的结果，或在提问里诱导用户（与本机 worker 的提问风险相同）。
- **[风险] Tailscale 插件或 webhook 行为变化**（新发布的功能，webhook 的重试、签名、超限状态码都没有文档）。对策：第 1 组在用户账号里实测，结论写进 `docs/grok.md`；webhook 的非 200 返回和超时都按失败或卡住处理，不会把任务卡死。
- **[风险] Grok 被重复运行。** webhook 端是否按 `Idempotency-Key` 去重未确认。网络错误后的重试、以及中枢在派发进行中重启（内存中的幂等记录丢失，节点重发）都可能让 Grok 多跑一次。后果是多耗一次运行额度、可能多出一份提案；多出的运行拿到的是同一个或已失效的 `dispatch_ref`，上报照常按 D7 核对，不会写错任务。
- **[风险] Grok 节点默认归属用户本人。** 没打 tag 时它命中 `autogroup:member` 全通规则，能访问用户 tailnet 里的全部设备；`Tailscale-User-*` 身份头也显示为用户本人。对策：打 `tag:grokbot` 是上线前提（D11），身份头一律忽略（D1）。如果打 tag 后插件不能工作，网络层就无法隔离，需要用户决定是否继续。
- **[风险] remote token 泄露。** 持有者只能在该调用方的白名单和能力内操作，并受每分钟限额约束；`raindown hub token revoke` 立即生效；tailnet 策略只放行 `tag:grokbot → Mac:443`（前提：1.6/1.7 通过；在此之前未打 tag 的 Grok 节点能访问用户的全部设备），tailnet 外拿到 token 也连不到远程端口。走 D12 云电脑分支时 token 放在云电脑上，暴露面更大。
- **[风险] Mac 离线或休眠。** Grok 的调用与上报会失败（经 DERP 中继本来就有 0.25–2.3 秒延迟）。交付说明要求 Grok 稍后重试上报；迟到的上报按 D6、D7 仍可接收；一直没有上报时由 `no_progress` 兜底。
- **[风险] 后台运行卡在审批。** 定时或 webhook 触发的运行中，工具调用可能等待用户审批或被拒。第 1 组验证能否把 Raindown 的工具预先设为放行；不能时任务由 `no_progress` 兜底，并写进 `docs/grok.md`。
- **[风险] 不做 IP 白名单。** Grok 没有稳定的出口 IP，账号迁移也会换 IP；身份只靠 tailnet 的 tag 与 Raindown token。
- **[风险] Tailscale 套餐。** 先用免费个人版（限非商业用途）；产品有收入后换商用套餐。
- **[风险] 路径引用。** `kb_propose` 不再透露目标是否存在与可见（D5），但白名单内条目的正文里可能引用其他条目的路径；这是白名单内内容本身的属性，不另做处理。
- **[权衡] `remote:*` 改为保留前缀是行为变化。** 本机 AI 以前可以降级声明 `remote:grok`（只在测试里用到），之后被拒绝。换来的是审计与 `creatable_by` 中的远程身份可信。
- **[权衡] webhook 由中枢发出。** 中枢多了一个对外 HTTP 调用；换来的是 key 不离开中枢内存、复用中枢已有的密钥扫描与脱敏，节点不需要密钥。
- **[权衡] 远程入口放在中枢进程内，中枢重启时 Grok 的调用会失败。** MCP 客户端会重试；`dispatch_ref` 按摘要入账，重启后仍能核对。
- **[权衡] 无状态 HTTP 模式不支持服务端主动推送。** Raindown 的工具都是一问一答，用不到推送。

## Migration Plan

- 默认不启用：没有 `config/remote.yaml`，就不监听远程端口，对现有用户没有影响。`remote:*` 保留前缀是唯一的行为变化；索引版本升到 4，首次启动自动重建。
- **上线顺序**：实测（第 1 组）→ 身份与可见范围（第 2 组）→ 远程入口（第 3 组）→ 用户在 tailnet 策略和 `tailscale serve` 中完成配置、在 Grok 中添加连接器（或按 D12 配好云电脑调用）→ `grok-routine` 执行器（第 4 组）。
- 先升级中枢，再升级节点：旧中枢没有 `remote-dispatch` 接口，grok-routine 派工以 `failed(dispatch_unsupported)` 结束，不会误判。
- `kb proposals accept --all` 改为跳过带 `target_hidden` 的提案，对本机用户也是行为变化，写进迁移说明。
- **回滚**：删除 `config/remote.yaml` 中对应的调用方，并撤销其 token；在 Tailscale 中执行 `tailscale serve reset`；在 Tailscale 管理台移除 Grok 节点或撤销插件授权。

## Open Questions

以下由第 1 组的剩余验证项回答（tasks 1.4–1.10），结论回写本文件：
- 连接器后端能否进 tailnet，决定 D12 走连接器还是云电脑调用。
- 初始化、复用、重连时请求头是否都带上；某条路径不带时另开 OAuth 变更（D4）。
- Grok 节点打 tag 后插件是否仍工作，新节点能否自动带 tag（D11）。
- 后台运行中工具调用会不会卡在审批；`webhook_event` 在 routine 中如何呈现、大小限制多少（D6 的信封字段能否原样到达）。

其他：
- 任务绑定（本机 worker）会话的可见范围是否也应排除 `scope: personal`。本变更只对远程会话排除，本机是否跟进留给用户决定。
- 远程调用方是否需要 `task_list`、`ws_brief` 或随手记的安全形式。本变更都不开放。
