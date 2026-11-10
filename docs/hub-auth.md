# 中枢鉴权与操作者身份

（add-m1-inbox design D9；hub-daemon spec "Token 认证""只有用户能做的操作"）

## 两种 token

| token | 位置 | 身份 |
|---|---|---|
| user token | `state/hub.token`（0600，首次启动生成） | `user`；可用 `X-Raindown-Actor` 降级为 AI 身份 |
| 绑定 token | `raindown hub token issue <actor>` 签发，`fht_` 前缀 | 固定为签发时绑定的 actor |
| 唤醒绑定 token | 中枢在节点领到 supervisor 唤醒任务时签发，`fwk_` 前缀（见下文"唤醒绑定 token"） | 固定为 `supervisor`，绑定该次唤醒 |

绑定 token 的记录保存在 `state/hub-tokens.json`（0600），每条只有：
`id`（`tok_` + 12 位十六进制）、`actor`、`sha256`（token 的摘要）、`issued_at`、`note`（可选）、
`last_used_at`、`revoked_at`、`remote`（可选）。token 明文只在签发时输出一次，中枢不保存。

- 文件损坏时中枢拒绝启动（`invalid_hub_tokens`），不会静默清空记录。
- 撤销先在内存中生效（立即拒绝），再写盘；签发只有写盘成功才生效，失败时只撤下这一条。
- 最近使用时间在内存中更新，最多每 30 秒、以及中枢停止时落盘。

### 能签发什么

目前只签发两类：

- `node:<id>`：本机以外的节点（变更 ⑤ 起）；
- 带 `--remote` 标注的 token：给变更 ⑤ 的远程入口（例如 Grok Bot）。**它们在本机端口 7477 的 `/v1`
  上一律返回 403 `remote_not_allowed`**，只能用于以后的远程端口。

保留身份不能签发，比较时不区分大小写：`user`、`hub`、`scheduler`、`policy`、`unknown`（`User`、`HUB`
等变体同样拒绝）；`node:` 前缀必须小写并后接合法的节点 id。`supervisor` 只由中枢按唤醒租约签发，
`raindown hub token issue supervisor`（带不带 `--remote`、大小写变体）一律拒绝；`state/hub-tokens.json`
中即使有这样的记录，鉴权时也返回 403 `reserved_actor`。

## 保留身份

| 身份 | 谁能用 |
|---|---|
| `user` | 只有 user token（不声明或声明恰好为 `user`） |
| `hub`、`scheduler`、`policy` | 只由中枢内部写事件时使用 |
| `unknown` | 历史占位，任何人都不能声明 |
| `node:*` | 中枢在节点注册与租约流程中按 `node_id` 设置，或签发给 `node:<id>` 的绑定 token |
| `supervisor` | 只由唤醒绑定 token 认定（add-m1-supervisor D6）；它也是 `kind: supervisor` 角色的保留名 |

user token 降级时不能声明上述任何一个（不区分大小写，包括 `node:*` 与 `supervisor`），否则 403 `reserved_actor`。
`raindown mcp --actor` 拒绝 `supervisor` 之外的这些名字；`raindown mcp --actor supervisor` 仍可启动（claude-sdk 为唤醒任务注入），
但它只有带上唤醒绑定 token（`RAINDOWN_HUB_TOKEN`）时才能访问中枢，用 `state/hub.token` 声明 supervisor 会被拒绝。

## 鉴权判定

| token | `X-Raindown-Actor` | 结果 |
|---|---|---|
| 缺失 / 不认识 / 已撤销 | 任意 | 401 `unauthorized` |
| 任意有效 token | 格式不合法 | 400 `invalid_arguments` |
| user token | 不带、为空或 `user` | `user` |
| user token | 保留身份（不分大小写）或 `node:*` | 403 `reserved_actor` |
| user token | 其他合法身份 | 该 AI 身份（只能降级） |
| 绑定 token | 与绑定身份不一致（包括 `user`） | 403 `actor_mismatch` |
| 绑定 token（remote） | 不带或一致 | 403 `remote_not_allowed` |
| 绑定 token（`node:<id>`） | 不带或一致 | `node:<id>`，限节点权限范围 |
| 绑定 token（身份为 `supervisor`） | 任意 | 403 `reserved_actor` |
| 唤醒绑定 token（有效） | 不带或 `supervisor` | `supervisor`，绑定该次唤醒 |
| 唤醒绑定 token（有效） | 其他（包括 `user`） | 403 `actor_mismatch` |
| 唤醒绑定 token（租约或任务已结束、中枢已重启） | 任意 | 401 `unauthorized` |

摘要比较为常数时间：user token 与每一条绑定记录都比较，不提前退出。

## 身份 × 接口

| 接口 | user | AI（user token 降级） | `node:<id>`（绑定 token） | remote token |
|---|---|---|---|---|
| `GET /v1/health` | ✓（不鉴权） | ✓ | ✓ | ✓ |
| `POST /v1/nodes`（注册）、`POST /v1/leases`（领取） | ✓（本机节点） | 403 `scope_denied` | 仅 `node_id` 为自己 | 403 |
| `POST /v1/leases/:id/renew`、`complete`、`ack-reply` | ✓（本机节点） | 403 `scope_denied` | ✓（凭 lease_token） | 403 |
| `POST /v1/nodes/:id/isolation-notices`（mds 重置，worker-credential-isolation 4.5） | ✓（本机节点） | 403 `scope_denied` | ✓（`:id` 必须是本身份，且只给本节点领取过租约的任务） | 403 |
| `GET /v1/tasks/:id` | ✓ | ✓ | 仅自己持有活动租约的任务 | 403 |
| `POST /v1/policy/check` | ✓（人工调试） | 403 `scope_denied` | 仅自己持有未过期活动租约的任务 | 403 |
| `POST /v1/tasks`（创建任务） | ✓（任意角色） | 仅 `creatable_by` 匹配的角色，否则 403 `role_not_allowed` | 403 `scope_denied` | 403 |
| `GET /v1/tasks`、`POST /v1/tasks/:id/cancel`、`GET /v1/events`、`GET /v1/nodes`、`GET /v1/hub/status` | ✓ | ✓ | 403 `scope_denied` | 403 |
| `GET /v1/inbox` | ✓ | ✓ | 403 `scope_denied` | 403 |
| `POST /v1/inbox/:id/act` | 全部操作 | 仅 dismiss 且条目 `created_by` 为自己；其余 403 `user_only` | 403 `scope_denied` | 403 |
| `POST /v1/briefs`（`brief_update`） | ✓ | 仅经**唤醒绑定 token** 认证的 `supervisor`：只能写绑定的 workspace（否则 403 `workspace_mismatch`），reply 唤醒 403 `reply_only_wake`；没有唤醒绑定的 supervisor（例如 user token 降级声明）403 `scope_denied`；其他身份 403 `role_not_allowed` | 403 `scope_denied` | 403 |
| `GET /v1/briefs/context`（`ws_brief` 的中枢部分） | ✓ | ✓（经唤醒 token 认证的 supervisor 只能读绑定的 workspace，否则 403 `workspace_mismatch`） | 403 `scope_denied` | 403 |
| `POST /v1/supervisor/questions`（`ask_user`）、`POST /v1/task-proposals`（`task_propose`）、`POST /v1/decisions/review`（`decision_review`） | 403 `role_not_allowed`（这三个操作只属于 supervisor；接受 / 驳回提案与答复提问走 `POST /v1/inbox/:id/act`，只有 user） | 仅经**唤醒绑定 token** 认证、非 reply 的 `supervisor`：只能作用于绑定的 workspace（否则 403 `workspace_mismatch`），reply 唤醒 403 `reply_only_wake`，没有唤醒绑定 403 `scope_denied`；`decision_review` 只限本次唤醒关联的决策（否则 403 `not_review_target`）；其他身份 403 `role_not_allowed` | 403 `role_not_allowed` | 403 |
| `POST /v1/merge-requests`（`pr_merge_request`） | 403 `role_not_allowed`（只属于 supervisor；批准 / 驳回合并条目走 `POST /v1/inbox/:id/act`，只有 user） | 仅经**唤醒绑定 token** 认证、非 reply 的 `supervisor`：资格由中枢按账本核对（`merge_not_eligible`），reply 唤醒 403 `reply_only_wake`，没有唤醒绑定 403 `scope_denied`；其他身份 403 `role_not_allowed` | 403 `scope_denied` | 403 |
| `POST /v1/supervisor/respond`（`task_respond`） | 同上，非 supervisor 一律拒绝 | 仅经**唤醒绑定 token** 认证、**且是被分配该委托的 reply 唤醒**的 `supervisor`：核对在 store 同一事务内完成，不满足返回 `not_delegated` / `stale_block` / `invalid_arguments`；非 reply 唤醒与其他身份被拒绝 | 403 `scope_denied` | 403 |
| `POST /v1/supervisor/wake`、`GET /v1/supervisor/status`（`raindown ask`、`raindown supervisor wake\|status`、Telegram `/ask`） | ✓ | 403 `user_only` | 403 `scope_denied` | 403 |
| `POST /v1/tasks/:id/reply` | ✓ | 403 `user_only` | 403 `scope_denied` | 403 |
| `POST /v1/hub/rebuild` | ✓ | 403 `user_only` | 403 `scope_denied` | 403 |
| `/v1/hub/tokens`（签发、列出、撤销） | ✓ | 403 `user_only` | 403 `scope_denied` | 403 |
| `POST /v1/ui/login-code`（`raindown ui` 申请 Web 登录码） | ✓ | 403 `user_only` | 403 `scope_denied` | 403 |
| `POST /v1/kb/search`、`/v1/kb/get`、`/v1/kb/query`（任务绑定的 `kb_search`、`kb_get`、`kb_query`） | 403 `scope_denied` | 403 `scope_denied`（唤醒绑定 token 同样 403 `scope_denied`） | 403 `scope_denied` | 403 |

只接受任务绑定令牌（`fls_`）的接口：`POST /v1/kb/search|get|query`，可见范围按令牌绑定任务的 workspace 计算，见下文"worker 派工绑定凭证"。

remote token 一列的 403 都是 `remote_not_allowed`。

**节点接口的身份要求**：节点协议的写接口（注册、领取、续约、完成、ack-reply）只接受 `user`（本机节点用
`state/hub.token`、不声明身份）与 `node:*`。user token 降级的 AI 身份、绑定给 AI 的 token、唤醒绑定 token 一律
403 `scope_denied`：领取租约会拿到任务合同、租约令牌，领到唤醒任务时还会拿到唤醒绑定 token。唤醒绑定 token
也只在调用方是 `user` 或 `node:<请求体中的 node_id>` 时随租约下发。`inbox_act` 先校验 action，再检查身份与条目的
`created_by`；拒绝时不调用底层操作、不产生事件。via 只接受 cli、web、telegram，省略时为 cli；
CLI 固定传 cli。读取密钥等只有用户能做的接口使用 `userOnly`，在读取请求体、调用服务之前拒绝；
策略检查的节点 scope 需要读取请求体中的 `task_id`，加载策略后在入账前再次校验租约。
策略检查的 `dry_run` 默认 false；user 可传 true 只判定不入账。节点只能省略或传 false，
传 true 返回 400 `invalid_arguments`，不产生事件。CLI 默认 dry run，只有 `--record` 才入账。
所有权限拒绝均不产生事件。任务不存在时，策略检查返回 404 `not_found`。
策略检查中节点上报的环境字段（`push_env_ok`、`gh_env_ok`、`command_cwd`，D15）只在
调用方确为该任务的租约持有者时采信：`node:<id>` 身份持有未过期的活动租约，或请求带的 `lease_token`
与该任务未过期的活动租约匹配（本机节点用 user token 调用，租约令牌只在节点进程内存中）。否则这些字段
视为缺失、不入账，`push_to` / `gh_scope` 条件随之不满足；`lease_token` 本身从不入账。
MCP 层的限制（`raindown mcp` 的 actor 不能是 user 或保留身份、没有读取密钥的工具）保留，作为第一道防线。

## 唤醒绑定 token（add-m1-supervisor D6）

supervisor 的身份与"它是哪一次唤醒"只由中枢认定，**不信任** `raindown mcp --task`、`RAINDOWN_TASK_ID` 或 `X-Raindown-Actor`。

- **签发**：节点领取租约时，如果任务是唤醒任务（以账本中的 `supervisor.wake_started` 为准，不看角色名或 `inputs`），
  中枢签发一个 `fwk_` 开头的 token，随租约响应的可选字段 `lease.wake_token` 下发一次；其他任务不下发，旧节点忽略该字段。
  节点把它作为 `RAINDOWN_HUB_TOKEN` 注入该唤醒的 MCP 环境（tasks 5.3）。
  具体做法：节点把 token 写进 `state/wake/<task>.<lease_id>.token`（目录 0700、文件 0600），只把路径作为
  `RAINDOWN_HUB_TOKEN_FILE` 交给 Raindown MCP 进程（`raindown mcp --actor supervisor --workspace <ws> --task <id>`，reply 唤醒另加
  `--reply-only`）；`HubClient` 优先从这个文件读 token（高于 `RAINDOWN_HUB_TOKEN`），文件读不到时失败、不回退到 user token。
  token 本身不进任何进程的 argv 与 env（Agent SDK 把 MCP 配置以 `--mcp-config` 参数传给 Claude Code，argv 对本机所有用户
  经 `ps` 可见），也不进日志、结果与活动；Claude 会话进程的 env 不含 `RAINDOWN_HUB_TOKEN` 与 `RAINDOWN_HUB_TOKEN_FILE`。
  任务结束（含失败、取消、放弃租约）即删除文件，节点启动时清理残留。没有下发 token 时任务 `failed(wake_token_missing)`；
  supervisor 角色必须是只读配置并设 `read_scope: cwd`（`supervisorRoleProblem`），否则 doctor 报错、中枢不唤醒、执行器
  `failed(supervisor_role_not_read)`；token 文件落在会话可读目录（cwd、任务私有目录）内时 `failed(wake_token_unsafe)`。
  **残余风险**：同一 uid 的进程（包括沙箱外运行的 worker）仍能读这个文件，与 `state/hub.token` 对同 uid 可读属于同一已接受风险；
  supervisor 会话本身因 `read_scope: cwd` 读不到它。改用文件后，在按用户隔离的加固部署（worker 以另一 uid 运行）中，
  其他用户既不能经 `ps` 看到 token，也不能读 0600 的文件。
- **绑定**：身份固定为 `supervisor`，绑定唤醒任务 id、workspace 与这次租约；中枢据此得知调用方是哪个唤醒、origin 是什么
  （instruction、autonomous 或只能回复的 reply）。
- **失效**：每次请求都对照账本重新核对——租约仍是 active 且未过期、属于该唤醒任务，任务未结束（done、failed、cancelled）。
  租约结束（完成、过期、重新排队）或任务结束即失效，得到 401 `unauthorized`。明文不入账本、不落盘，中枢内存中只按 sha256
  保存，**中枢重启后已签发的全部失效**（方向安全：该唤醒之后的 MCP 调用失败，唤醒按普通任务结束或失败）。
- **范围**：只能作用于绑定的 workspace。
  - 建任务：见下文 D5 检查；
  - 取消任务：只能取消本次唤醒自己建的任务（`parent` 为该唤醒且 `created_by = supervisor`），其他 workspace 的任务
    403 `workspace_mismatch`，其余 403 `scope_denied`；
  - 收件箱：只能忽略本 workspace 中自己发起的条目，其他 workspace 403 `workspace_mismatch`；
  - 节点协议接口（注册节点、领取、续约、提交、ack-reply）与策略检查一律 403 `scope_denied`（见上文"节点接口的身份要求"）；
  - 回复任务、处理收件箱条目（接受或驳回提案、批准）、重建、签发 token 等 user-only 接口一律 403 `user_only`；
  - 读接口（任务、事件、收件箱列表等）与其他 AI 身份相同。
- **节点身份被信任**：领到唤醒租约的节点拿到这次唤醒的 token，也就获得了 supervisor 身份。这与节点本来就能以
  `node:*` 身份执行任意任务的信任边界一致（节点属于可信计算基）。
- 日志与账本的脱敏规则识别 `fwk_` 前缀的 token。

## worker 派工绑定凭证（add-harness-neutral-coordination D2）

普通任务领取租约时，中枢另外签发 `fls_` 前缀的 `dispatch_token`。它与节点续约、完成租约使用的
`lease_token` 独立，也与 supervisor 的 `fwk_` 唤醒凭证分开。中枢只保存摘要，绑定合同中的角色、任务、
workspace、lease 与 attempt；`--actor`、`--task` 和环境变量都不能声明或改写这个绑定。

每次 HTTP 请求重新检查当前活动租约、有效期、任务终态与当前 attempt；`task.attempt_ended`、重新派工、
租约释放、清扫器确认过期或任务结束后凭证立即失效。时间暂时超过 expires_at 但租约仍为 active 时，
凭证继续遵循租约状态，允许休眠/卡顿后的续约恢复。中枢重启使先前凭证失效；有效租约下一次续约时，
节点在续约中带 `dispatch_token_sha256`（当前已写入凭证的 SHA-256 前 16 位）。中枢没有该租约的凭证记录，
或指纹与当前记录不一致时，通过 dispatch_token 补发新凭证，节点更新同一 0600 文件后才确认新指纹。
补发响应丢失时，下次续约仍带旧指纹，因而会再次补发；旧凭证仍不可用。明文凭证不写入续约请求。
续约不带指纹（旧节点，或凭证文件尚未写好）而中枢已有该租约的当前凭证时**不轮换**：轮换会让 worker 进行中的 MCP 调用拿到 401。

任务凭证只允许读取本任务详情、向本任务的 `POST /v1/tasks/:id/report` 上报、
`GET /v1/binding` 查询可信绑定（`{kind: "task", task: {actor, task_id, workspace, lease_id, attempt}}`），
以及经 `POST /v1/kb/search`、`/v1/kb/get`、`/v1/kb/query` 读取知识。
绑定查询沿用标准的 `{ok: true, data: ...}` 响应封装；wake 凭证得到 `kind: "wake"` 与其绑定。
任务凭证访问其他任务或调用建任务、回复任务、收件箱操作、密钥与节点协议等接口，一律返回 403 `forbidden`。

### 知识读取经中枢（add-worker-credential-isolation D3）

任务绑定 MCP 的 `kb_search`、`kb_get`、`kb_query` 经中枢执行，worker 侧进程不读取 raindown-home 的 `brain/`、`state/` 与 `config/`
（隔离落地后它们对 worker 不可读）。路由与 CLI 的 `raindown kb search|get|query` 使用同一个 core 实现与同一份输入 schema，
输出结构相同，校验与错误码也相同：

| 接口 | 请求体 | 响应 data |
|---|---|---|
| `POST /v1/kb/search` | `{query, limit?, type?, includeJournal?}`：`query` 最长 500 字，`limit` 1–100（默认 20），`type` 最长 64 字 | 同 `kb_search` |
| `POST /v1/kb/get` | `{id}`：相对 `brain/` 的条目标识，最长 512 字，不能以 `/` 开头，不能含以 `.` 开头的段（含 `.`、`..`）、反斜杠或控制字符 | 同 `kb_get` |
| `POST /v1/kb/query` | `{filters}`：最多 20 条 `key=value`，每条最长 500 字；空条件或格式错误为 `invalid_filter`（与本地一致） | 同 `kb_query` |

这些上限同样出现在 CLI 与 MCP 工具的输入 schema 中（`schemas/operations/kb-*.input.schema.json`）。
**CLI 行为变化**：`raindown kb search --limit` 超过 100，以及 `raindown kb get` 的标识以 `/` 开头、含 `.`/`..` 段、以 `.md` 结尾或含反斜杠时，改为用法错误（退出码 2），此前分别是照常执行与 `not_found`。

- **只接受任务绑定令牌**：user 令牌（含降级为 AI 身份）、绑定令牌（含 `node:*`）、唤醒绑定令牌一律 403 `scope_denied`。
  无绑定与唤醒绑定的 MCP 会话仍在本地读取。令牌每次请求按账本重核，任务结束、租约失效或中枢重启后 401 `unauthorized`。
- **可见范围**由中枢按令牌绑定任务的 workspace 计算，请求中不能声明：本 workspace 加 `ws/global`。
  - 条目归属取 frontmatter 的 `owner` 与 `workspace`（数组展开一层）。两者都没有、且类型不要求 owner 的条目属于 global。
  - 取严：任一归属不在范围内即不可见；无法判定的归属同样不可见——资源类型（domain、service、repo、data-source、account）
    缺少 owner，字段为 null、空串、空数组，或值不是合法的 `ws/<id>`（例如含换行）。
  - 检索索引以 JSON 数组保存归属，检索与字段查询在 SQL 中按可见的编码过滤；`kb/get` 用同一判定。
  - `kb/get` 对不可见的条目返回与不存在相同的 404 `not_found`，不泄露存在性。
  - journal 按记录**正向选择**：任何 `##` 加空白开头的行都开始一段，只保留首行严格匹配 `## HH:MM:SS · 操作者[ · ws/<id>]`
    且未标 workspace 或标了本 workspace 的段；不规范的段整段丢弃，文件头只保留 `# YYYY-MM-DD`。没有可见记录的 journal
    在检索中不返回，`kb/get` 返回 not_found。切段取严：行首（可有缩进）是 `#` 的任何行都开始新段，不规范或缩进的标题不会并入上一条可见记录。
    `kb_journal` 写入时转义正文行首的 `#`，正文无法伪造记录标题；本变更之前写入、正文含类似标题行的旧记录不受转义保护，
    按上述规则切段后至多丢掉其中的内容，不会把它并入别的记录。
  - 检索分批读取（每批至少 50 行、最多 10 批），过滤后取满 `limit`；排序与 CLI 相同。
  - 这比本地读取更严：可见条目的结果、字段与顺序与 CLI 相同，只是少了不可见的条目与记录。
- 参数不合法 400 `invalid_arguments`；请求体先看 Content-Length，再边读边按字节计数，最大 32 KiB。
- MCP 只用派工令牌文件（`RAINDOWN_LEASE_TOKEN_FILE`）访问中枢；没有该文件时返回 `lease_token_required`，不改用其他中枢凭证。
  中枢地址由节点随派工令牌经 `RAINDOWN_HUB_URL` 交给受管 MCP（地址不是凭证；节点自身环境中的同名变量不被子进程继承），
  任务绑定会话因此不读 `config/hub.yaml`；旧节点没有传地址时仍按 `config/hub.yaml` 解析。
  中枢没有该路由（旧中枢对派工令牌访问未知接口返回 403 `forbidden`）时返回 `hub_kb_unsupported`，**不回退到本地读取**
  （回退会让 worker 重新需要读取 raindown-home，隔离失效）。因此升级顺序是**先升级中枢，再升级节点与 CLI**。

节点把 `dispatch_token` 写入 `run/tasks/<task>/dispatch-tokens/<lease>.token`（目录 0700、文件 0600；位于 `state/` 之外，见 `docs/executors.md` 的「`run/` 目录」），
仅通过 `ExecutorContext.leaseTokenFile` 向适配器交付路径，供后续受管 MCP 配置使用；明文不放进 argv、env 或活动日志。
MCP 通过 `RAINDOWN_LEASE_TOKEN_FILE` 读取凭证；节点通用子进程环境移除此变量，适配器仅为受管 MCP 显式设置它。
任务结束、取消或放弃租约后删除文件；持有节点单实例锁的启动清理只删除受管目录内的 token 文件，保留任务产物且不跟随目录符号链接。
codex-orca、codex-exec（含只读角色）与 claude-sdk 均注入任务绑定 MCP；supervisor 唤醒绑定保持独立。
codex-orca 与 codex-exec 的 Codex 进程环境带有 `RAINDOWN_LEASE_TOKEN_FILE`（MCP `env_vars` 透传需要）；模型执行的 shell 命令依赖
Codex 默认 `shell_environment_policy` 排除 `*TOKEN*` 而看不到它，适配器在角色配置之后的 `-c` 层固定该排除项，
角色配置不能重新暴露（见 [executors.md](executors.md#适配器契约)）。claude-sdk 只在 MCP 子进程环境中设置该路径。
日志与账本脱敏识别 `fls_` 前缀。

MCP 启动时以该文件访问绑定查询；显式的 task/workspace 只用于核对，不一致时拒绝启动。任务绑定只列出
`raindown_report`、`task_show`、`event_get`、`kb_search`、`kb_get`、`kb_query`；`task_show` 与 `event_get` 限本任务（`event_get` 另可读取直通给本任务的 PR 事件，即送达输入里的读取指针）。
未绑定会话与 supervisor 唤醒会话沿用原工具清单，不列出 worker 的 raindown_report。

### 上报与节点消费

`raindown_report` 使用共享 `defineOperation` 定义，经中枢验证当前派工身份后写入 `task.reported`。
输入按状态校验：question 必须有一个问题、2–8 个不同标签的选项及对应推荐标签；ready 必须有交付物地址，
当前支持核实 GitHub PR：仓库必须与任务的 repo_snapshot 一致，head 分支必须与 task.branch 一致，且不能是 fork。
任务分支尚未报告时返回 `branch_unknown`；PR 其余核对通过、只有 head 与登记分支不一致时返回 `deliverable_branch_mismatch`（提示中给出登记分支）。两者都提示 worker 不要反复提交 ready、改用 blocked 说明情况；只有创建并拥有任务分支的适配器才报告分支，见 [适配器契约](executors.md#适配器契约)。
交付物最多 5 个，查询失败只返回通用错误，不向 worker 返回 gh 的 stderr 或私有仓库信息，也不写上报事件。
blocked 必须说明 missing/tried，failed/dropped 必须说明 reason。handback 只接受本任务收到过的、名单内人类的 PR 评论（否则 `handback_invalid`），通过后同一事务写 `pr.wake_requested{reason:'handback'}`，进入 supervisor 的 instruction 队列，见 [supervisor.md](supervisor.md) 第 13 节（当前共享 GitHub 身份下不会通过）。
每个租约同时只处理一个上报，超出时返回可重试的 report_busy；请求体最多 32 KiB，每分钟最多 10 次、
每次派工最多 200 次，超额返回可重试的 report_rate_limited。成功次数从账本恢复，失败尝试同样消耗额度，
但失败额度只保留在本次中枢进程内。上报、消费水位和派工有效性均通过索引查询。

报告本身不改变任务状态。续约响应的可选 `report` 返回本派工最近一次未消费的报告（包括 progress），
含 `seq`、`attempt` 与报告字段；续约请求带 `report_seq` 确认消费，写入 `task.report_consumed`，重复确认幂等。
节点停下时合并上报与适配器推断，再以 renew.blocked 或 complete 提交状态；complete 可引用同派工的 `report_seq`，
中枢从账本取回实际内容，拒绝不匹配的 outcome。dropped 引用以 done 结束并标记 `result.dropped`，不进入收件箱或唤醒 supervisor；
failed 引用走 task.failed。报告的自由文本原因保留在 `result.reported_reason`，不改变机器码 `result.reason` 的契约。
报告中的交付物合入节点结果，保留节点已记录的产物。

旧节点没有 basis 的卡住视为 inferred；推断提问直接交用户，授权委托仍按原规则判定。
收件箱保存完整选项标签；Telegram 每选项独占一行，按钮保留短 id 与推荐标记后将标签尾部截成 `…`，总长不超过 60 个 UTF-16 字符。
回调只携带选项索引，从 options_json 取完整标签回复；显示截断不会改变答复。supervisor 输入使用同一结构化问题字段，仍受现有唤醒输入预算限制。

## 建任务的中枢校验（add-m1-supervisor D1、D2、D4、D5、D10）

除下文的 `creatable_by` 外，中枢对所有建任务请求还做以下检查（全部在幂等键查找之前，拒绝时不产生事件）：

- **parent**：合同带 `parent` 时，任务必须存在（否则 422 `parent_not_found`）且与新任务同一 workspace（否则 403 `workspace_mismatch`），
  所有身份（包括 user 与 hub）都检查。
- **保留幂等键**：`supervisor:` 与 `merge:` 前缀（不分大小写）只允许 hub（唤醒任务、merger 任务 `merge:<审查任务>`），`task-proposal:` 只供中枢接受任务提案时内部使用，其他身份 403 `reserved_idempotency_key`。
- **保留能力**：非 hub 身份不能在 `requires` 中声明 `wake`（不分大小写），否则 400 `invalid_arguments`。
- **唤醒任务作为 parent**：只有 hub、user，以及绑定该唤醒的 supervisor 可以；其他身份 403 `parent_required`。
- **hub**：显式跳过 `creatable_by`（角色仍须已定义）。
- **角色有效类别**（D9，按角色配置与合同 `executor` 取更严格者，例如只读角色配 `pr-merge` 执行器按 merge 算；
  非 user 身份建的任务只要带 `verify` 至少按 write 算）：
  `kind: supervisor`（以及名为 supervisor 的角色，不论能否加载）只能由 hub 创建，user 得到 403 `role_not_allowed` 并提示改用
  `raindown supervisor wake`；`kind: merge` 只能由 hub 与 user 创建。
- **origin**（D2）：由中枢计算并写入 `task.created`，之后不变——中枢内部调用方显式给出（接受提案）时用它；`parent` 是唤醒任务时取该唤醒的
  origin（reply 唤醒不传）；`parent` 有 origin 时继承，但 hub、user、supervisor 之外的 AI 身份只在 parent 未结束时继承；
  其他没有 origin。不取自合同或请求中的任何字段。
- **审查目标**（D10）：角色在 workspace `supervisor.reviewer_roles` 中且带 `inputs.review` 的任务，调用方写的 `goal` 被丢弃，
  改为中枢固定模板加 `focus`（模板写明 focus 不改变判定标准）。
- **supervisor 身份**（由唤醒绑定 token 认定）依次检查：
  0. 调用方是 reply 唤醒 → 403 `reply_only_wake`；
  1. 合同 workspace 必须是绑定的 workspace（否则 `workspace_mismatch`）；`parent` 必须就是本次未结束的普通唤醒（否则 403 `parent_required`）；
  2. 目标类别为 write 且唤醒 origin 为 autonomous → 403 `proposal_required`；
  3. 目标类别为 merge 或 supervisor → 403 `role_not_allowed`；
  4. `cwd` 与 `inputs.repo` 必须是绝对路径（或 `~/`）；先像节点一样词法 `resolve`，再 realpath，落在本 workspace 登记仓库内
     （允许子目录）；通过后把规范化路径（登记仓库写法加 realpath 中仓库以下部分）写回合同。两者都没写时 workspace 必须恰好登记一个仓库；
     executor 为 codex-orca 时必须恰好是登记仓库（不允许子目录，与节点一致），其他执行器允许子目录；
     验收步骤的 `cwd` 只能是不含 `..` 的相对路径；否则 403 `repo_not_in_workspace`。节点执行前还须再核对一次（tasks 5.6）；
  5. 上限（`supervisor.limits`）：本次唤醒已建任务数达到 `tasks_per_wake` → 429 `limit_exceeded`；新的写类任务关联的 PR 已有
     `review_rounds` 次 `changes_requested`（只统计 `reviewer_roles` 中 claude-sdk 审查任务的 `result.review.verdict`，链接不分大小写）
     → 429 `review_rounds_exceeded`。关联的 PR 由中枢推出：本次唤醒事件引用的任务涉及的 PR（审查的 `inputs.review.pr`、
     `inputs.pr`、`kind: pr` 产物），加上新合同的 `inputs.pr`。数量、轮数与链深度在写入前的同步段再检查一次，并发请求不能绕过。
- **验收命令**（D5）：非 user 身份（包括 supervisor、user token 降级的 AI 身份）建任务时，合同 `verify` 的每条命令在创建时经策略判定：
  动作为 `tool:Verify` 加命令识别出的动作，scope 为新任务的 workspace 与角色，前缀严格匹配。只有 `auto` / `auto-report` 放行，
  否则 403 `verify_not_allowed`，错误中列出未通过的命令。命令的每个词都必须在白名单内：普通词（含 `--name=` 的值）先按 `,`、`=` 切段，
  每段是可带 `./` 开头的相对路径（各段以字母数字或 `_` 开头和结尾，不含 `..`）；选项只能是 `-x`、`--name`、`--name.sub` 或
  `--name=<普通词>`，单独的 `--` 作分隔符。因此 `-r/tmp/x.js`、`--require=a,/tmp/x.js`、`file:`、`@`、`~`、`%`、glob、空格与绝对路径
  都不放行；选项与值分开写时两个词分别校验。白名单只校验形态、不校验选项含义（见 policies.yaml 模板注释）。
  仓库内指向仓库外的符号链接、以及用仓库内相对路径加载代码，无法在词法上拦截（已接受的风险，见 design D15）。`tool:Verify` 是受保护的工具，`* * auto` 这类通配规则不能放行。
  `policies.yaml` 模板中有注释掉的 `tool:Verify` 白名单；不启用时，supervisor 建的任务不能带 verify。
- **链深度**：user、hub 之外的身份建任务时，新任务的 `parent` 链深度超过 `supervisor.limits.chain_depth`（默认 8）→ 429 `limit_exceeded`。

**已接受的风险**：

- 能读到 `state/hub.token` 的进程就是 user，它把任务挂到唤醒任务或 instruction 链上时，新任务会继承 instruction origin
  （与下文"信任边界"一致）。唤醒绑定 token 不由 `hub.token` 派生，读到 `hub.token` 也不能伪造 supervisor 身份。
- 同理，能读到 `state/hub.token` 的 worker（例如沙箱外运行的 Codex）以 user 身份访问中枢，**也能批准 `merge_request`
  合并条目**（或以 user 身份直接建 merge 类任务）。合并仍要经过中枢的资格核对与 pr-merge 执行器的全部条件核对
  （审查 approve、head 未变、检查全部通过、不是 fork PR），但"用户本人批准"这一道关口对这类进程不成立。
  把 `hub.token` 从执行器可读范围移走留到后续变更。
- supervisor 停用（`supervisor.enabled: false`）后，已生成的合并审批条目仍可由用户批准：批准是用户的决定，
  资格的其余各项照常重新核对；不想合并时请驳回或忽略这些条目。
- 持有 user token 降级或绑定 token 的 AI 身份，可以把任务挂到**任意未结束**的 instruction 任务下（不限于它自己所在的任务）
  并继承 instruction origin；挂到唤醒任务下、或挂到已结束的任务下都不行。根治方案（要求调用方就是 parent 当前租约的执行者）
  记在 design 的 Open Questions。

## 角色创建权限（`creatable_by`）

任务合同的 `role` 决定节点用哪个角色配置执行（`config/roles/<role>.yaml`）。dev 默认跳过 Codex 审批和沙箱，
如果只读的 reviewer / triage 能创建 `role: dev` 的任务，就等于借 dev 提权。所以中枢在**创建任务时**按身份校验角色：

- `user` 永远可以创建任何角色的任务，`creatable_by` 不影响 user；中枢也沿用原来的做法，不替 user 校验角色是否存在
  （`raindown task create` 与 MCP 的 `task_create` 在本机先查角色，未定义时返回 `unknown_role`）。
- 其他身份（实际能到达这个接口的是 user token 降级的 AI 身份）：角色必须已定义且加载成功，否则 422 `unknown_role`
  （语法或字段有错、未能加载的角色文件同样视为未定义，`raindown doctor` 会报出错误）；身份必须匹配该角色的 `creatable_by`，
  否则 403 `role_not_allowed`，信息中写明角色与身份，`details` 为 `{ field: "role", role, actor }`。拒绝时不产生事件。
- `creatable_by` 缺省或为 `[]`：只有 user 可以创建（默认拒绝 AI 与节点）。
- 用户在收件箱批准 AI 的 `task_create`（策略审批）不能覆盖 `creatable_by`；身份不匹配时，中枢仍返回 `role_not_allowed`。
- 模式：精确值（`reviewer`、`agent:claude`、`remote:grok`、`node:n-abc`，区分大小写），`<前缀>:*`（`node:*`、`remote:*`，
  匹配以 `<前缀>:` 开头且后面非空的身份），以及 `*`（任意身份）。写在列表中的 `user` 没有额外作用。
- 校验在幂等键查找之前：被拒绝的身份不能凭幂等键拿到已有任务。
- 生效时机：中枢在每次创建请求时用 core 的 `loadRoles` 重新读取 `config/roles/`（与 workspace 检查一样），
  改完角色文件后下一次请求即生效，不需要重启中枢。

默认模板中 dev 不写（只有 user），只读的 reviewer、triage 为 `["*"]`。

**本机 AI 的实际身份**：claude-sdk、codex-exec 与 codex-orca 执行器均为新启动的 AI 子进程设置
`RAINDOWN_ACTOR=<角色名>`；claude-sdk 另注入 `raindown mcp --actor <角色名>`。所以 reviewer 会话经 MCP 或 Bash 中的 CLI
访问中枢时，身份都是 `reviewer`（triage 等其他角色同理用各自名字），不能通过 CLI 的 `--actor user` 覆盖。
执行器内进程若 unset `RAINDOWN_ACTOR` 或将它改写为 `user`，CLI 会回到 user 身份；这是默认身份，不是强制隔离，见下文“信任边界”。
角色名必须是合法且可声明的 AI 身份；`user` 等保留身份在角色加载时拒绝，doctor 报 error，执行器也会在启动前校验，不会静默替换名字。
codex-orca 通过 Raindown 生成的 Orca 终端启动命令设置环境变量；升级前已启动并被复用的会话需要重新启动才会获得它。
它们**不匹配** `node:*`。只想放开特定身份时写精确名字，例如只允许 reviewer 执行器拆出分诊任务：

```yaml
# config/roles/triage.yaml
creatable_by:
  - reviewer
```

注意：

- `*` 只覆盖能到达本机端口 `/v1/tasks` 的非 user 身份，即 user token 降级的本机 AI 身份。节点 token（`node:<id>`）
  属于可信计算基，只能走节点协议，创建任务一律 403 `scope_denied`；remote token 在本机端口一律 403 `remote_not_allowed`。
  变更 ⑤ 的远程入口另有自己的能力控制，不因为角色写了 `*` 就能创建任务。`node:*`、`remote:*` 模式先保留，供以后的入口使用。
- `raindown init` 不覆盖已有文件，**已存在的角色文件不会自动获得 `creatable_by`**，升级后这些角色只有 user 能创建；
  `raindown doctor` 对字段缺省或为空数组的角色给出“仅 user 可创建”的 info 提示。需要时手动加上，例如 `creatable_by: ["*"]` 或 `["reviewer"]`。
- 定时规则（`schedules.yaml` 与中枢内部规则）目前只写 `schedule.fired`（身份 `hub`）或回调收件箱，不创建任务，
  不经过这项校验。以后若由定时规则创建任务，必须经同一个任务服务，并且明确以哪个身份创建。
- 和其他检查一样，这只约束经中枢创建的任务；能读 `state/hub.token` 的本机同用户进程仍可以 user 身份创建任何角色（见"信任边界"）。

## Web 页面（`/ui`）

（add-m1-inbox 6.1，design D5；inbox-web spec）`/ui` 是与 `/v1` 完全分开的一条鉴权路径：页面用会话 cookie，
`/v1` 只认 `Authorization: Bearer`，**不读 cookie**，所以会话 cookie 拿不到任何 `/v1` 接口。

登录流程：

1. `raindown ui` 用 user token 调用 `POST /v1/ui/login-code`，拿到一次性登录码（32 字节随机数），
   中枢只在内存中保存它的 sha256 摘要，60 秒内有效、只能使用一次（无论成功与否，提交即作废）。
2. `raindown ui` 打开 `http://127.0.0.1:<端口>/ui/login?code=...`（macOS 用 `open`；`--print` 只输出链接）。
3. `/ui/login` 校验登录码，写入会话 cookie `raindown_ui_session`（HttpOnly、SameSite=Strict、Path=/ui、
   Max-Age 7 天），303 跳转到 `/ui`，登录码不留在地址栏与历史记录中。会话同样只在内存中保存摘要；
   **中枢重启后会话全部失效，需要重新运行 `raindown ui`**。

| 接口 | 无会话 | 有效会话 | 额外校验 |
|---|---|---|---|
| `GET /ui` | 401，只提示"请运行 raindown ui 登录"，不含条目 | 页面 | Host |
| `GET /ui/login?code=` | 登录码无效或过期：401 | — | Host |
| `GET /ui/items`（局部刷新片段） | 401 | 片段 | Host |
| `POST /ui/items/:id/act` | 401 | 以 `user`、`via: web` 调用收件箱操作 | Host、Origin |
| `POST /ui/logout` | 303 | 撤销会话并清除 cookie | Host、Origin |
| `GET /ui/static/*`（脚本、样式、图标） | ✓ | ✓ | Host |

- **Host**：必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`，否则 421（防 DNS rebinding）；中枢本身只监听 127.0.0.1。
- **Origin**：写操作必须带 `Origin`，且为 `http://127.0.0.1:<端口>` 或 `http://localhost:<端口>`；缺少或不符时
  403 `origin_denied`，不产生事件。`Sec-Fetch-Site` 存在时必须为 `same-origin`。与 SameSite=Strict 一起防 CSRF。
- 页面的请求体只接受 `action` 与 `text`，不能声明身份或渠道。
- **安全头**（`/ui` 下所有响应）：`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`、
  `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、
  `Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Resource-Policy: same-origin`、`Permissions-Policy`，
  以及 `Cache-Control: no-store`（静态资源为 `no-cache`）。页面没有内联脚本和内联样式；动态文本全部由 Hono JSX 转义，
  标题、正文和输出片段渲染前再做一次密钥脱敏。

## 命令

```sh
raindown hub token issue node:mac-mini --note "书房的 Mac mini"   # 只输出一次 token
raindown hub token issue grok --remote --note "Grok Bot"          # 给变更 ⑤ 的远程入口
raindown hub token list                                           # id、身份、状态、签发时间、最近使用、备注
raindown hub token revoke tok_0123456789ab                        # 立即生效
```

三个命令都经中枢 HTTP 接口执行（中枢需在运行），并且只能由 user 执行。

## 各进程怎么带身份

- **CLI**：读 `state/hub.token`，默认身份 `user`。环境变量 `RAINDOWN_ACTOR` 声明了非 user 身份时，
  **所有命令**（包括走 HubClient 访问中枢的命令）都以该身份执行，`--actor user` 或其他 `--actor`
  不能覆盖它。这只是第一道防线：同一用户的进程可以清掉这个环境变量，信任边界不变（见下文）。
- **本机节点**：读 `state/hub.token`，**不声明身份**；中枢在注册与租约流程中按 `node_id` 记为 `node:<id>`。
- **本机 MCP**：`raindown mcp --actor <name>` 用 `state/hub.token` 并声明该 AI 身份（降级）。
- **用绑定 token 的进程**：设置环境变量 `RAINDOWN_HUB_TOKEN=<token>`；`HubClient` 与节点都会优先用它。
  节点此时声明 `node:<id>`，必须与绑定身份一致。
- **执行器与 worker 子进程**：节点 spawn 执行器、worker 与验收命令时，环境变量一律经
  `executorEnv()`（`packages/node/src/env.ts`，执行器从 `ExecutorContext.env` 拿到同一份），
  其中去掉了 `RAINDOWN_HUB_TOKEN`，任务里运行的代码拿不到节点的凭证。执行器再通过 `executorRoleEnv()`
  校验角色身份并设置 `RAINDOWN_ACTOR`，验收命令也使用合同的角色身份；codex-orca 在终端启动命令中设置它，同时移除 `RAINDOWN_HUB_TOKEN`。
- **中枢内部渠道**（Telegram、Web）：运行在中枢进程内，不经过 `/v1` 的 HTTP 鉴权，直接以 user 写事件并附 `via`。
  Web 页面先经过自己的会话与 Origin 校验（见上文"Web 页面"）。

## 信任边界

**本机上以同一系统用户运行、能读取 `state/hub.token` 的任何进程，都可以获得 `user` 身份。**
目前 worker 与节点以同一 Unix 用户运行，部分角色（如 dev）不启用沙箱，因此能读到 `state/hub.token`（user 令牌）
和其他任务的派工令牌文件。0600 只隔离不同系统用户，不能隔离同一用户的任务。
在 worker 沙箱隔离落地之前，任务绑定的范围是纵深防御，不是硬边界。
例如，直接读取 `hub.token` 并用 curl 携带该 token、且不声明 AI 身份的进程仍是 `user`。
这一点是有意保留的：CLI 本身就靠读这个文件工作，同一用户的进程也能读 age 私钥、改配置。
本设计防的是：

- 远程调用方只能拿到绑定 token：remote token 在本机端口完全不可用，`node:` token 只能走节点协议；
- 绑定 token 泄露后，持有者只能在绑定身份的权限范围内操作，且可以随时撤销；
- 本机 AI 进程误把自己声明成 user 或中枢内部身份（MCP 层与中枢都会拒绝）。

它**不防**本机同一用户下的恶意进程。需要更强的隔离时，应让 AI 进程以不同系统用户运行，
使其读不到 `state/hub.token`。
