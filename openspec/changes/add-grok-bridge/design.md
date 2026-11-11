# Design

## Context

**调研结论**（2026-10-25，来源见 PR #18 的讨论记录和 Cursor 文档 `docs/grok-bot/{security,private-networks,computers,settings}.md`、`help/grok-bot/{routines,plans,mobile,secrets}.md`、cursor/plugins#533、#774；本次刷新没有重新调研，第 1 组实测前以此为准）：
- **MCP 连接从哪里发起**：Grok Bot 的远程 MCP 连接由 Cursor 后端发起，不经过 Bot 的云电脑。命令型（stdio）MCP 可以跑在云电脑上，但云电脑连不到用户 Mac 的回环地址。
- **Tailscale 插件**：官方插件让 Bot 以 `tag:grokbot` 设备加入用户的 tailnet，只能访问 ACL 授权的主机和端口。它只用于出站方向的 MCP，目前按开关灰度开放。在云电脑上自己装 tailscaled 也能连通，但每次更新、恢复或重置都会被清掉（#774），不作为方案。
- **传输与认证**：远程 MCP 支持 streamable HTTP 和 SSE；认证以 OAuth（含动态客户端注册）为主。能否填固定的 Bearer 请求头，尚未确认。
- **反方向**：Raindown 只能单向触发 Grok。routine 可以由 webhook 触发：`POST https://api2.cursor.sh/automations/webhook/<id>`，带 `Authorization: Bearer <key>`，正文为 JSON；返回 200 和 `runUuid`，只表示已开始运行，结果写进 Bot 的聊天。没有接口可以往已有对话里发消息。每小时总计最多运行 300 次。
- **文档矛盾**：由 webhook 或 routine 发起的运行能不能用 tailnet MCP，两处官方材料说法相反，必须实测。

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
- 中枢进程内再起一个 Hono 应用，监听 `127.0.0.1:7478`（`config/hub.yaml` 的 `remote.port`，可关闭），只挂 `/mcp`，以及 OAuth 方案下的 `/.well-known/oauth-*`、`/oauth/*`。用户用 `tailscale serve --bg --https=443 http://127.0.0.1:7478` 发布，tailnet 里只看得到这个端口。
- **随配置开关**：`config/remote.yaml` 刷新（2 秒有效期，与角色缓存一致）后，有至少一个有效调用方而端口未监听时开始监听；一个也没有时关闭监听，正在处理的请求以 401 结束。中枢启动时同理。
- **请求入口检查**（在鉴权之前）：带 `Tailscale-Funnel-Request` 头的请求一律 403 `funnel_denied`（纵深防御，即使 Funnel 被误开也不服务）；`Host` 必须是配置的 tailnet 主机名（`config/hub.yaml` 的 `remote.allowed_hosts`）或 `127.0.0.1:<端口>`，否则 421；MCP SDK 传输层同时打开 DNS rebinding 保护并设同样的 `allowedHosts`。
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

### D4 认证：先用 Bearer，OAuth 作为条件分支
- **Bearer**：即 D3 的 remote token，用户把它填进 Grok 的 MCP 连接器的固定请求头。
- **OAuth**：仅在第 1 组验证出 Grok 不支持固定请求头时实现，做成最小的 OAuth 2.1 授权服务器：
  - **授权方式**：动态客户端注册（RFC 7591）、授权码加 PKCE（S256）、`/.well-known/oauth-authorization-server` 和 `oauth-protected-resource` 元数据，都挂在远程端口。
  - **redirect_uri 白名单**：动态注册只接受调用方配置 `oauth.redirect_hosts`（Grok 为第 1 组实测得到的 Cursor 回调主机）下的 https 地址，其他一律拒绝注册。
  - **用户确认**：授权页挂在本机 7477 的 `/ui` 上，沿用 `/ui` 的会话、Host 与 Origin 校验。用户必须已经用 `raindown ui` 登录，才能看到"允许 remote:grok 访问 product-res（只读、提案、上报），授权后跳转到 <redirect 主机>"并点确认。授权请求从远程端口发起，确认只能在本机完成；远程端口上的授权端点只负责跳转与换取令牌。授权从 iPhone 上的 Grok 发起时，用户需要在 Mac 上确认（例如授权页给出短码，在 Mac 的 `/ui` 中输入确认）；具体流程依第 1 组实测再定。
  - **令牌**：访问令牌有效期 1 小时，刷新令牌有效期 30 天；作为 remote 标注的绑定记录存进 `state/hub-tokens.json`（只存摘要），`raindown hub token list` 可见、`revoke` 可撤销。
- **为什么不直接上 OAuth**：OAuth 要实现的东西多，也多出不少安全面。如果 Bearer 可用，没必要承担这份成本。

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
        webhook: https://api2.cursor.sh/automations/webhook/<id>
        key: secret://grok/webhook-key
      oauth:                       # 只在 D4 走 OAuth 分支时需要
        redirect_hosts: [<第 1 组实测得到的回调主机>]
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
- **webhook 主机固定**：`dispatch.kind: grok-routine` 时 `webhook` 必须是 `https://api2.cursor.sh/automations/webhook/<id>` 形式（主机写在代码常量里，由第 1 组实测确认），否则调用方加载失败。误改配置不会把 key 发到任意主机。
- **派发由中枢发出**：节点领取任务后，适配器按顺序拼出派工正文：恢复提示（`renderRecoveryPrompt`）、待送达输入（`renderTaskInputs`）、任务来源（`renderWorkerTaskPrompt`）、角色提示词，以及固定的交付说明（任务 id、`dispatch_ref` 占位、调用 `raindown_report` 的要求、调研结论用 `kb_propose` 提交并以 `ready` 交付提案）。节点经新的节点协议接口 `POST /v1/leases/:id/remote-dispatch {body, lease_token}` 交给中枢。租约接口对 user token 也开放（本机节点就用它），所以这里与其他依赖租约的字段一样，**必须带与该任务未过期活动租约匹配的 `lease_token`**（或由持有该租约的 `node:<id>` 调用），只拿到 `state/hub.token` 的进程不能借此触发 webhook；`lease_token` 不入账。中枢核对租约与角色的 `remote_client`，生成 `dispatch_ref` 填入正文，按已知密钥值与 gitleaks 规则脱敏，解密 key，向 webhook 发出 `POST`（带 `Idempotency-Key: <task id>:<attempt>`），写 `remote.dispatched{task, attempt, client, dispatch_ref_sha256, run_id, status}` 事件，向节点返回结果（不含 `dispatch_ref`）。key 与 `dispatch_ref` 明文都不进账本、活动与日志，节点也拿不到它们。
- **幂等**：每个租约（即每个 attempt）最多一次远程派发。中枢按 `(task, attempt)` 记录派发；同一租约再次请求时不再调用 webhook，直接返回已有结果——派发仍在进行（中枢在请求内退避重试，节点可能超时后重发）时等待同一个进行中的派发完成后返回同一结果。webhook 的 `Idempotency-Key` 只是额外的一层。
- **出站请求**：`fetch` 设 `redirect: 'error'`（不跟随跳转，避免 key 随跳转发往别处）、总超时 30 秒，响应体最多读取 64 KiB，超出按 `dispatch_rejected` 处理；只解析其中的运行 id。
- **结果**：webhook 返回 2xx 时活动记"已派发到 Grok，运行 id 为 …"；非 2xx（429 除外）以 `failed(dispatch_rejected)` 结束并记录状态码；网络错误与 429 由中枢在同一请求内重试（最多 3 次、指数退避），仍失败返回可重试错误，节点在本派工内再试一次后以 `failed(dispatch_unreachable)` 结束；key 解密不到时以 `failed(secret_not_found)` 结束，不发出请求。
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

### D11 发布检查
- `raindown doctor` 在启用远程入口时运行 `tailscale serve status --json`，检查三点：只有远程端口被代理；`AllowFunnel` 为空；7477 没有出现在任何代理目标中。
- 找不到 `tailscale` 命令时，只给出警告。测试注入假的 `tailscale` 二进制与 fixture 输出。

## Risks / Trade-offs

- **[风险] 数据发到 xAI。** 对策：workspace 白名单默认为空，global 默认不可见；个人条目一律不外发；派工正文经密钥脱敏。但派工正文中的目标、用户原始指令、恢复提示与回复是原样发出的，其中如果有个人内容同样会到 xAI——`scope: personal` 只约束知识条目，管不到用户自己写进指令的话。这一点写进 `docs/grok.md` 与 grok 角色提示，用户建 grok 角色任务时自行判断。
- **[风险] 中枢进程处理远程输入。** 远程会话的操作在能读全部状态的中枢进程内执行，任何"按路径读本地文件"的参数都会变成任意文件读取。对策：远程映射表逐个给出远程 schema（D2、D5），新增操作默认不开放，映射表有快照测试，审查清单写明"远程 schema 不得含路径类参数"。
- **[风险] Grok 被提示注入，滥用它有的权限。** 对策：写入只能走提案，必须经用户接受才生效；不开放 `capture` 与 journal，避免把未确认的内容写进会被本机 AI 读取的 raw 与 brain；上报只能针对派给它的当前派工；最坏情况是交回一份质量差的结果，或在提问里诱导用户（与本机 worker 的提问风险相同）。
- **[风险] Tailscale 插件或 webhook 行为变化**（灰度功能，文档有矛盾）。对策：第 1 组先在用户账号里实测，结论写进 `docs/grok.md`；webhook 的非 2xx 返回和超时都按失败或卡住处理，不会把任务卡死。
- **[风险] remote token 泄露。** 持有者只能在该调用方的白名单和能力内操作，并受每分钟限额约束；`raindown hub token revoke` 立即生效；tailnet ACL 只放行 `tag:grokbot`，tailnet 外拿到 token 也连不到远程端口。
- **[风险] 路径引用。** `kb_propose` 不再透露目标是否存在与可见（D5），但白名单内条目的正文里可能引用其他条目的路径；这是白名单内内容本身的属性，不另做处理。
- **[权衡] `remote:*` 改为保留前缀是行为变化。** 本机 AI 以前可以降级声明 `remote:grok`（只在测试里用到），之后被拒绝。换来的是审计与 `creatable_by` 中的远程身份可信。
- **[权衡] webhook 由中枢发出。** 中枢多了一个对外 HTTP 调用；换来的是 key 不离开中枢内存、复用中枢已有的密钥扫描与脱敏，节点不需要密钥。
- **[权衡] 远程入口放在中枢进程内，中枢重启时 Grok 的调用会失败。** MCP 客户端会重试；`dispatch_ref` 按摘要入账，重启后仍能核对。
- **[权衡] 无状态 HTTP 模式不支持服务端主动推送。** Raindown 的工具都是一问一答，用不到推送。

## Migration Plan

- 默认不启用：没有 `config/remote.yaml`，就不监听远程端口，对现有用户没有影响。`remote:*` 保留前缀是唯一的行为变化；索引版本升到 4，首次启动自动重建。
- **上线顺序**：实测（第 1 组）→ 身份与可见范围（第 2 组）→ 远程入口（第 3 组）→ 用户在 tailnet ACL 和 `tailscale serve` 中完成配置、在 Grok 中添加连接器 → `grok-routine` 执行器（第 4 组）。
- 先升级中枢，再升级节点：旧中枢没有 `remote-dispatch` 接口，grok-routine 派工以 `failed(dispatch_unsupported)` 结束，不会误判。
- **回滚**：删除 `config/remote.yaml` 中对应的调用方，并撤销其 token；在 Tailscale 中执行 `tailscale serve reset`。

## Open Questions

- 用户账号是否已开通 Tailscale 插件；用户的 tailnet 是个人的还是公司的。
- Grok 自定义 MCP 能否填固定请求头。这决定 D4 走哪个分支；走 OAuth 时，从 iPhone 发起的授权如何在 Mac 上确认。
- 由 webhook 触发的运行能否调用 tailnet MCP。如果不能，`grok-routine` 只能退而要求 Grok 把结果写在聊天里，由用户手动转交。那样它就不再是一个能自动化的执行器，需要重新评估第 4 组是否要做。
- Grok 的 Auto Review 会不会拦下 webhook 运行中调用 MCP 的动作。
- 任务绑定（本机 worker）会话的可见范围是否也应排除 `scope: personal`。本变更只对远程会话排除，本机是否跟进留给用户决定。
- 远程调用方是否需要 `task_list`、`ws_brief` 或随手记的安全形式。本变更都不开放。
