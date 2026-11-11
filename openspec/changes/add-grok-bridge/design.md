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
- **派工输入模板**：`renderWorkerTaskPrompt`（原始指令 / supervisor 补充）、`renderRecoveryPrompt`、`renderTaskInputs`，适配器原样使用。

## Goals / Non-Goals

**Goals:**
- Grok 能按授权范围查知识库、写提案和随手记、为派给它的任务上报。
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
- `config/remote.yaml` 不存在或没有有效的调用方时不监听。
- **为什么放在中枢内**：凭证校验、可见范围、审计入账、远程上报与派工的核对本来就在中枢；另起进程还得再处理一套鉴权和单实例问题。中枢本来就持有 raindown-home，远程会话的操作在中枢进程内执行，不需要额外进程读 raindown-home。
- **备选**：在 7477 上加 `/mcp` 路径，再用 `tailscale serve` 只代理这个路径。没有采用：路径级代理一旦配错，`/v1` 就会暴露；分端口的隔离更直观，也便于 doctor 检查。7478 早已被策略当作中枢端口识别，worker 命令直接访问它会按 `shell.opaque` 处理。

### D2 MCP 服务端与传输解耦
- 把 `packages/mcp` 中"由 operations 生成工具、按绑定裁剪、调用、渲染结果"的部分抽成 `createRaindownMcpServer({ ctx, binding })`。stdio 入口和 HTTP 入口共用它。
- HTTP 入口使用 SDK 的 Web 标准 streamable HTTP 服务端传输，以无状态模式运行，每个请求按凭证建立 `remote` 绑定并新建 server 实例，便于和 Hono 集成，也不必维护会话。
- **一致性测试**：把现有的 CLI 与 MCP 一致性测试扩展到 HTTP 传输。

### D3 远程身份与凭证（复用绑定 token）
- 远程调用方的 actor 固定为 `remote:<id>`，`<id>` 与 `config/remote.yaml` 中的调用方 id 一致。`remote:` 成为与 `node:` 同级的保留前缀：
  - `raindown hub token issue remote:grok --remote` 签发；`--remote` 只接受 `remote:<id>`，`remote:<id>` 也必须带 `--remote`；
  - user token 用 `X-Raindown-Actor` 声明 `remote:*` → 403 `reserved_actor`；`raindown mcp --actor remote:*` 拒绝启动；角色名不能以 `remote:` 开头（本来就不是合法角色名，补测试）。
  - 这样账本、审计与 `creatable_by` 中出现的 `remote:*` 只可能来自真正的远程凭证，本机 AI 不能冒充 Grok。
- 远程入口只接受 actor 为 `remote:<id>`、带 `remote` 标注、未撤销、且 `<id>` 是已加载调用方的 token；user token、`node:*` token、`fls_` / `fwk_` 令牌一律 401。7477 上 remote token 的行为不变（403 `remote_not_allowed`）。
- 已签发的、actor 不是 `remote:<id>` 的 remote token（例如按旧文档签发的 `grok`）在远程入口得到 401；`raindown doctor` 列出这类记录，提示撤销并重新签发。
- **为什么不另做凭证**：hub-auth 的绑定 token 已经提供签发一次、只存摘要、立即撤销、最近使用时间；远程入口只需要在它上面加"属于哪个调用方"的判定。

### D4 认证：先用 Bearer，OAuth 作为条件分支
- **Bearer**：即 D3 的 remote token，用户把它填进 Grok 的 MCP 连接器的固定请求头。
- **OAuth**：仅在第 1 组验证出 Grok 不支持固定请求头时实现，做成最小的 OAuth 2.1 授权服务器：
  - **授权方式**：动态客户端注册（RFC 7591）、授权码加 PKCE（S256）、`/.well-known/oauth-authorization-server` 和 `oauth-protected-resource` 元数据，都挂在远程端口。
  - **用户确认**：授权页挂在本机 7477 的 `/ui` 上，沿用 `/ui` 的会话、Host 与 Origin 校验。用户必须已经用 `raindown ui` 登录，才能看到"允许 remote:grok 访问 product-res（只读、提案、上报）"并点确认。授权请求从远程端口发起，确认只能在本机完成；远程端口上的授权端点只负责跳转与换取令牌。
  - **令牌**：访问令牌有效期 1 小时，刷新令牌有效期 30 天；作为 remote 标注的绑定记录存进 `state/hub-tokens.json`（只存摘要），`raindown hub token list` 可见、`revoke` 可撤销。
- **为什么不直接上 OAuth**：OAuth 要实现的东西多，也多出不少安全面。如果 Bearer 可用，没必要承担这份成本。

### D5 远程调用方、`remote` 绑定与可见范围
- `config/remote.yaml`：

  ```yaml
  clients:
    - id: grok                     # actor 为 remote:grok
      workspaces: [ws/product-res] # 白名单，默认空
      include_global: false        # 是否可见 ws/global 与无归属条目，默认 false
      capabilities: [read, propose, report]
  ```

  单个调用方出错只停用该调用方并报告文件与字段；`remote.yaml` 与 roles、policies 一样是提权面，由用户维护（AI 不得经 MCP 修改 config，现有规则已覆盖）。中枢按 2 秒有效期刷新，与角色缓存一致。
- **会话绑定**：`OpBinding` 新增 `kind: 'remote'`，携带 `client`、`workspaces`、`includeGlobal`、`capabilities`，由中枢按凭证建立，请求中的任何字段都不能声明或改写。`applyBinding` 对 `remote` 绑定按 `remoteBindingAllows` 白名单放行，其余返回 `forbidden`。
- **能力到操作的映射**（core 常量，有快照测试；新增操作默认不开放）：

  | 能力 | 操作 | 约束 |
  |---|---|---|
  | `read` | `kb_search`、`kb_get`、`kb_query`、`ws_list`、`ws_brief` | 可见范围见下；`ws_list` 只列白名单内的 workspace；`ws_brief` 只接受白名单内的 workspace |
  | `propose` | `kb_propose`、`capture` | 目标 workspace 必须在白名单内（`workspace_mismatch`）；`capture` 的来源记为 `mcp:remote:<id>` |
  | `report` | `raindown_report`、`task_show` | 只能作用于当前派给本调用方的任务（D7）；`task_show` 只返回该任务 |

  不开放：`task_create`、`task_list`、`task_cancel`、`task_retry`、`task_reply`、`task_respond`、`inbox_*`、`kb_journal`（直接写入、无需确认）、`kb_proposals_accept|reject`、`resource_transfer`、`event_get`、supervisor 专用操作、读取密钥。工具列表中不出现，直接调用返回 `forbidden`。
- **可见范围**：`KbVisibility` 从 `{workspace}` 扩展为 `{workspaces, includeGlobal, excludePersonal}`；任务绑定会话取 `{[任务 workspace], true, false}`（行为不变），远程会话取 `{白名单, include_global, true}`。归属判定沿用 `entryScopes` 的取严规则（任一归属不可见即不可见；无法判定即不可见）；`includeGlobal: false` 时 global 条目（空归属）与 `ws/global` 不可见；`excludePersonal` 时 frontmatter `scope: personal` 的条目一律不可见，journal 不受影响（journal 没有 scope）。过滤在 SQL 层与读取前完成，不在返回后裁剪，避免分页和计数泄露；不可见条目与不存在同为 `not_found`。
- **实现路径**：远程会话的 `kb_*` 在中枢进程内调用与 `/v1/kb/*` 路由相同的 core 实现，只是可见范围来自远程绑定，不经过 HTTP 再走一遍 `/v1`。

### D6 grok-routine 执行器：派发后等待上报
- **适配器声明**：

  | approval_requests | inject_while_running | resume_session | raindown_mcp | out_of_band_detection | off_machine | task_inputs |
  | --- | --- | --- | --- | --- | --- | --- |
  | none | false | false | false | false | true | true |

  `raindown_mcp: false`：它不加载本机的任务绑定 MCP，节点也不为它写派工令牌文件；上报经远程入口完成（D7）。`credential_isolation` 见 D8。
- **角色示例**：

  ```yaml
  name: grok-research
  executor: grok-routine
  prompt: grok-research.md
  no_progress_minutes: 60
  permissions:
    remote_client: grok                 # 必须是 remote.yaml 中具备 report 能力的调用方
    webhook: https://api2.cursor.sh/automations/webhook/<id>
    key: secret://grok/webhook-key
  ```

  角色加载时校验 `remote_client` 存在且有 `report` 能力、任务 workspace 在其白名单内（建任务时由中枢再查一次，不满足 403 `workspace_not_allowed`）、`webhook` 为 https；`key` 必须是 `secret://` 引用。
- **派发**：节点领取任务后，适配器按顺序拼出派工正文：恢复提示（`renderRecoveryPrompt`）、待送达输入（`renderTaskInputs`）、任务来源（`renderWorkerTaskPrompt`）、角色提示词，以及固定的交付说明："完成后调用 Raindown MCP 的 `raindown_report`，`id` 为 …，`dispatch_ref` 为 …；调研结论用 `kb_propose` 提交，以 `ready` 交付提案"。正文经密钥脱敏后 POST 到 webhook，带 `Idempotency-Key: <task id>:<attempt>`（webhook 是否认这个头以实测为准）。
- **dispatch_ref**：中枢在每次派工时生成的不透明随机串（不是凭证，泄露也只能配合该调用方自己的 token 使用），随租约下发、写入本次派工记录；节点不在活动中输出它。
- **结果**：webhook 返回 2xx 时记录活动"已派发到 Grok，运行 id 为 …"；非 2xx（429 除外）以 `failed(dispatch_rejected)` 结束并记录状态码；网络错误与 429 按可重试处理（同一派工内最多重试 3 次，之后 `failed(dispatch_unreachable)`）。
- **等待与消费**：派发后适配器不产生观察；Grok 的上报照常经续约下发给节点，由节点的合并逻辑处理——`ready` / `failed` / `dropped` 结束派工；`question` / `blocked` 时适配器随即报告 idle，任务以 `basis: reported` 卡住；`progress` 视为活动。没有任何上报超过角色的 `no_progress_minutes` 时，节点照常判定 `blocked(no_progress)`（`basis: inferred`），消息写明"Grok 在 N 分钟内没有上报"。
- **回复与重试**：Grok 侧的运行无法续接（`resume_session: false`），`deliver` 一律返回 `not_running`，中枢让任务带着回复重新排队；新派工生成新的 `dispatch_ref` 并重新触发 webhook，回复与恢复提示放在正文开头。`task_retry` 同理。
- **取消**：任务被取消时适配器停止等待并以 `cancelled` 结束；Grok 侧的运行无法被 Raindown 停止，结果中注明"Grok 侧的运行仍可能继续，其上报将被拒绝"。
- **为什么不用 `report_timeout` 直接失败**：PR #18 让超时直接 `failed(report_timeout)`。现在已有统一的 `no_progress` 卡住与重试机制，卡住后用户可以重试或取消，无需为一个执行器再加一条失败路径。

### D7 远程上报的核对
- 远程会话调用 `raindown_report` 必须带 `id` 与 `dispatch_ref`（远程会话的输入 schema 中二者必填；任务绑定会话不变）。中枢在写入 `task.reported` 前核对：
  1. 任务处于 `running`，有活动租约，`dispatch_ref` 等于当前派工的引用（旧派工的迟到上报 → `not_running`）；
  2. 当前派工的执行器在节点注册中声明 `off_machine: true`，且任务角色的 `permissions.remote_client` 等于调用方 id（按派工时固化的值，不读实时配置）→ 否则 `forbidden`；
  3. 调用方仍具备 `report` 能力、任务 workspace 仍在白名单内（实时配置）→ 否则 `forbidden`。
- 核对通过后与派工令牌的上报走同一条写入路径：同样的输入校验、限额（每派工同时一个、每分钟 10 次、每派工 200 次）、`task.reported` 事件（操作者为 `remote:<id>`）、续约下发与 `report_seq` 消费。
- 判定依据是适配器声明与派工记录，不按执行器类型名 `grok-routine` 分支，以后其他 off_machine 执行器可以复用。

### D8 隔离：没有本机 worker 进程
- worker-isolation 防的是"本机 worker 进程读到 Raindown 的状态、令牌与私钥"。grok-routine 在节点内只发一个 HTTP 请求，harness 运行在 xAI 的云上，本机没有可施加 seatbelt 或 native 的进程；Grok 能触达 Raindown 的唯一途径是远程入口，其权限面由 remote token 与 `remote.yaml` 的能力决定。
- 因此 grok-routine 按沙箱设置 `off-machine` 声明 `credential_isolation: {layers: {off-machine: none}, enforced: false}`，**如实为 none**，不新增施加层取值，也不让探针为它运行。
- **与 `isolation` 的关系**：
  - `required`：与 `supervisor-session`、`in-node` 一样，角色加载失败，`raindown doctor` 报错"off_machine 执行器不支持隔离"，该角色的任务无法创建（fail closed）。不允许"把 required 理解为已满足"，以免读到 required 的人误以为有本机隔离。
  - `preferred`（缺省）：不标注"未隔离"、不产生 `unisolated` 收件箱提示；`task.started` 改记 `off_machine: true`，任务与收件箱显示"外部执行（Grok）"。
  - `off`：不检查、不标注。
- 节点侧：grok-routine 的适配器进程本身属于节点（可信计算基），webhook key 只在节点内存中解析，不写入任何文件、活动或结果。

### D9 交付物：知识库提案
- `raindown_report ready` 的 `deliverables` 在 GitHub PR 之外接受 `raindown:proposal/<id>`。中枢核对：提案存在、`created_by` 为上报者（远程调用方为 `remote:<id>`，本机 worker 为其角色身份）、目标属于任务的 workspace、创建时间不早于本次派工开始。不满足返回 `deliverable_check_failed`，不泄露提案内容。
- 一个上报中 PR 与提案可以混用，总数仍不超过 5。提案引用合入任务结果的产物列表（`kind: proposal`）。
- 只是一段文字结论、没有可交付物的调研，Grok 以 `kb_propose` 或 `capture` 记录后再交付；`capture` 不能作为交付物（它不经确认、没有作者核对），只能写进 summary。

### D10 审计
- 每次远程工具调用写一条 `remote.call` 事件，记录调用方、actor、工具、涉及的 workspace、结果（`ok`、`forbidden`、`error`）和耗时，不记正文与检索结果。
- 同一调用方、同一工具在 1 分钟内的成功调用合并成一条，附带次数；被拒的调用每条都单独记（拒绝本身不改变状态，只写审计事件；这是 hub-auth"权限拒绝不产生事件"的明确例外，仅限远程入口）。
- `raindown remote status` 从投影读取：每个调用方的启用状态、最近一次调用、过去 24 小时调用数与被拒次数、token 最近使用时间。

### D11 发布检查
- `raindown doctor` 在启用远程入口时运行 `tailscale serve status --json`，检查三点：只有远程端口被代理；`AllowFunnel` 为空；7477 没有出现在任何代理目标中。
- 找不到 `tailscale` 命令时，只给出警告。测试注入假的 `tailscale` 二进制与 fixture 输出。

## Risks / Trade-offs

- **[风险] 数据发到 xAI。** 对策：workspace 白名单默认为空，global 默认不可见；个人条目一律不外发；派工正文经密钥脱敏；`raindown remote status` 可以随时查看 Grok 用了哪些工具和 workspace。派工正文中的原始指令与恢复提示会发给 xAI，这一点写进 `docs/grok.md`，用户建 grok 角色任务时自行判断。
- **[风险] Grok 被提示注入，滥用它有的权限。** 对策：写入只能走提案，必须经用户接受才生效；上报只能针对派给它的当前派工；最坏情况是交回一份质量差的结果，或在提问里诱导用户（与本机 worker 的提问风险相同，推断的提问不交给 supervisor 代答，`reported` 的提问照常可委托）。
- **[风险] Tailscale 插件或 webhook 行为变化**（灰度功能，文档有矛盾）。对策：第 1 组先在用户账号里实测，结论写进 `docs/grok.md`；执行器对 webhook 的非 2xx 返回和超时都按失败或卡住处理，不会把任务卡死。
- **[风险] remote token 泄露。** 持有者只能在该调用方的白名单和能力内操作；`raindown hub token revoke` 立即生效；tailnet ACL 只放行 `tag:grokbot`，tailnet 外拿到 token 也连不到远程端口。
- **[权衡] `remote:*` 改为保留前缀是行为变化。** 本机 AI 以前可以降级声明 `remote:grok`（只在测试里用到），之后被拒绝。换来的是审计与 `creatable_by` 中的远程身份可信。
- **[权衡] 远程入口放在中枢进程内，中枢重启时 Grok 的调用会失败。** MCP 客户端会重试，这个代价可以接受。
- **[权衡] 无状态 HTTP 模式不支持服务端主动推送。** Raindown 的工具都是一问一答，用不到推送。

## Migration Plan

- 默认不启用：没有 `config/remote.yaml`，就不监听远程端口，对现有用户没有影响。`remote:*` 保留前缀与提案交付物对现有流程只有上文"行为变化"一处影响。
- **上线顺序**：实测（第 1 组）→ 身份与可见范围（第 2 组）→ 远程入口（第 3 组）→ 用户在 tailnet ACL 和 `tailscale serve` 中完成配置、在 Grok 中添加连接器 → `grok-routine` 执行器（第 4 组）。
- 先升级中枢，再升级节点：旧中枢不认 `off_machine` 与 `dispatch_ref`，远程上报一律被拒，不会误判。
- **回滚**：删除 `config/remote.yaml` 中对应的调用方，并撤销其 token；在 Tailscale 中执行 `tailscale serve reset`。

## Open Questions

- 用户账号是否已开通 Tailscale 插件；用户的 tailnet 是个人的还是公司的。
- Grok 自定义 MCP 能否填固定请求头。这决定 D4 走哪个分支。
- 由 webhook 触发的运行能否调用 tailnet MCP。如果不能，`grok-routine` 只能退而要求 Grok 把结果写在聊天里，由用户手动转交。那样它就不再是一个能自动化的执行器，需要重新评估第 4 组是否要做。
- Grok 的 Auto Review 会不会拦下 webhook 运行中调用 MCP 的动作。
- 任务绑定（本机 worker）会话的可见范围是否也应排除 `scope: personal`。本变更只对远程会话排除，本机是否跟进留给用户决定。
- 远程调用方是否需要 `task_list`（限白名单 workspace）。本变更不开放，只给当前派给它的任务的 `task_show`。
