# Tasks

> 前置条件：均已在 main 上——hub-auth 的 remote 标注与 `remote_not_allowed`、add-harness-neutral-coordination（`raindown_report`、续约携带上报、适配器能力声明、任务绑定会话）、add-worker-credential-isolation（经中枢的知识读取与 `KbVisibility`、`credential_isolation`、角色 `isolation`）、密钥提供器。
> 依赖与并行：第 1 组是闸门，由用户与协调者完成。1.1（插件已开通）确认之前不开始任何产品代码；1.1 通过后可以开始第 2 组；1.3 定下认证分支与第 4 组是否要做之后，才开始第 3、4 组。第 3 组依赖第 2 组。第 4 组依赖第 3 组。第 5 组最后进行。
> 已在 main 上、本变更不再做：remote token 的签发与在 7477 上的拒绝、7478 作为中枢端口的策略识别、`task.reported` 事件与续约下发、经中枢的知识读取路由、`creatable_by` 的 `remote:*` 模式。

## 1. 实测闸门（用户与协调者一起，不写产品代码）

- [ ] 1.1 用户确认：Grok Bot 的 Tailscale 插件已开通；tailnet 类型（个人还是公司）；在 ACL 中加入 `tag:grokbot → <Mac>:443`，并删除默认的全放行规则（如果公司 tailnet 不允许删，记录现状）
- [ ] 1.2 协调者用一个临时的 echo MCP 服务（只返回固定文本，不接触 raindown-home），经 `tailscale serve` 发布，验证以下各项，并记入 `docs/grok.md`：
  - Grok 自定义 MCP 能否填固定的 Bearer 请求头；不能时，是否支持 OAuth 动态客户端注册、回调主机是什么、从 iPhone 发起授权时用户如何完成确认；
  - Bot 在聊天中能否调用该服务；请求带的 `Host` 是什么（定 `remote.allowed_hosts`）；
  - 由 webhook 触发的 routine 运行中能否调用该服务，Auto Review 是否拦截；
  - webhook 的主机与路径形式（定代码常量）、对 `Idempotency-Key` 的处理、返回体格式（`runUuid`）、429 行为；
  - 工具调用时 Grok 能否按派工正文原样传入 `id` 与 `dispatch_ref` 这类参数。
  验证结束后执行 `tailscale serve reset`
- [ ] 1.3 根据 1.2 的结果在 design 中定下 D4 的分支，以及第 4 组是否要做；有变化时更新 proposal 和 specs

## 2. 身份、可见范围与传输解耦（1.1 通过后开始）

- [ ] 2.1 `remote:` 保留前缀：`REMOTE_ACTOR_RE`（小写）与 `isRemoteActor`（不区分大小写）；`boundActor` / `issueTokenRequest` 要求 `remote:<id>` 与 `--remote` 互为必要；`isDeclarableActor` 拒绝 `remote:*`，覆盖 `X-Raindown-Actor`、`raindown mcp --actor`、CLI `--actor` 与 `RAINDOWN_ACTOR`（`resolveActor`）、角色名；doctor 列出 actor 不是 `remote:<id>` 的旧 remote token 并提示重新签发；更新 hub-auth.md 的保留身份、鉴权判定与命令示例，以及 actor-tokens 测试中用 user token 降级为 `remote:grok` 的用例；验证 hub-daemon 的"本机 AI 冒充远程调用方""remote 标注与身份不符""远程 token 冒充用户"场景
- [ ] 2.2 `KbVisibility` 扩展为 `{workspaces, includeGlobal, excludePersonal}`，任务绑定会话保持原取值并有回归测试；SQL 过滤从 `visibleScopeEncodings` 的子集枚举改为 `json_each` 判定（白名单上限 8 个）；索引新增 `personal` 列，`INDEX_VERSION` 升到 4；`filterJournalBody` 中未标 workspace 的记录按 global 处理；测试 fixture 按 `packages/core/src/schema/entries.ts` 的字段定义构造，覆盖每种条目类型的 `owner` / `workspace` / `scope` 组合（含缺失、数组、`ws/global`、`personal`），不读真实 raindown-home；验证 remote-mcp 的"检索不会越过白名单""个人条目不外流""global 默认不可见""未标 workspace 的 journal 记录"场景
- [ ] 2.3 抽出 `createRaindownMcpServer({ ctx, binding })`，stdio 入口改为使用它，行为不变；支持按绑定替换工具的输入 schema 与输出投影；验证现有 MCP 测试与 CLI/MCP 一致性测试全部通过

## 3. 远程入口

- [ ] 3.1 `config/remote.yaml` 的 schema 与加载（单个调用方出错不影响其他调用方、2 秒刷新、白名单上限、`dispatch.webhook` 主机常量校验）、导出 JSON Schema；`OpBinding` 的 `remote` 绑定、`remoteBindingAllows` 映射表与远程 schema（新增操作默认不开放、远程 schema 不含路径类参数，快照测试）；`ws_list` 按白名单裁剪；验证 remote-mcp 的"单个调用方配置错误""调用未授权的工具""远程调用方不能审批""随手记不对远程开放"场景
- [ ] 3.2 远程 `kb_propose`：去掉 `file`、新内容归属必须在白名单内且非 personal、已有条目不可见时保存并标记 `target_hidden`（提案列表与 diff 显示，接受返回 `remote_target_hidden`）、远程响应只有 `{id, target}`、校验错误只带错误码与字段路径；验证 remote-mcp"远程提案"的全部场景
- [ ] 3.3 中枢的第二个监听端口（随 `remote.yaml` 刷新开关、两个端口路由互不相通）、`Tailscale-Funnel-Request` 拒绝与 `Host` 校验（含 SDK 的 DNS rebinding 保护）、streamable HTTP 无状态传输、远程凭证校验（只接受 `remote:<id>` 的 remote token 且调用方已加载）、每调用方限额（`rate_limited`）、远程会话在中枢内执行 kb 读取；验证 remote-mcp 的"远程端口不暴露中枢 API""没有远程调用方""删除最后一个调用方""经 Funnel 到达的请求""用 user token 访问远程入口""调用方已从配置中删除""调用过快"，hub-daemon 的"本机端口不提供远程入口"，knowledge-access 的"stdio 与远程入口结果一致""请求中声明 workspace"场景
- [ ] 3.4 （仅在 1.3 决定走 OAuth 时）最小 OAuth 2.1：元数据、动态客户端注册（redirect_uri 主机白名单）、授权码加 PKCE、`/ui` 上的本机确认页（显示回调主机，沿用会话、Host、Origin 校验，按 1.2 的结论支持从 iPhone 发起的流程）、令牌作为 remote 绑定记录存摘要并可撤销；验证"OAuth 授权需要用户本人确认""OAuth 回调地址不在白名单"场景，以及 PKCE 校验失败、redirect_uri 不匹配、令牌撤销的测试
- [ ] 3.5 `remote.call` 事件与合并规则（成功按分钟合并、被拒每分钟最多 20 条）、未认证请求只写限速日志、`raindown remote status`、doctor 的 Tailscale 发布检查（注入假的 `tailscale` 二进制，用 fixture 输出）；验证"被拒的调用可追溯""未认证的请求不入账""误开了 Funnel""中枢 API 被发布"场景

## 4. grok-routine 执行器（视 1.3 的结论决定是否做）

- [ ] 4.1 适配器声明 `off_machine`（core schema、旧节点缺省 false、`raindown node list` 显示"外部执行"）；`SANDBOX_SETTINGS` 新增 `off-machine`，`roleSandboxSetting` 对 grok-routine 返回它、施加层 `none`；`requiredIsolationUnsupported` 按执行器名拒绝 grok-routine 的 `required`；`preferred` 下 `task.started` 记 `off_machine` 而非 `unisolated`；更新 executors.md 的能力声明与凭证隔离声明表；验证 harness-adapter 的"本机执行器不接受远程上报"，worker-isolation 的"外部执行的角色要求隔离""外部执行的角色缺省设置"场景
- [ ] 4.2 远程派发：节点协议接口 `POST /v1/leases/:id/remote-dispatch`（只接受持有该租约的节点、只对声明 `off_machine` 的执行器）；中枢核对角色 `remote_client`、生成 `dispatch_ref`（账本只存摘要）、脱敏正文、解密 key、调用 webhook（`Idempotency-Key`、429 与网络错误重试、其他非 2xx 失败）、写 `remote.dispatched`；接管规则与 `remote.dispatch_adopted`；新错误码 `remote_client_invalid`、`workspace_not_allowed`、`dispatch_rejected`、`dispatch_unreachable`、`dispatch_unsupported` 加入错误码表与 JSON Schema，key 缺失沿用 `secret_not_found`；验证 executor-grok-routine 的"白名单外的 workspace""webhook 指向其他主机""成功派发""key 未配置""节点重启后重试"场景（用假的 webhook 服务）
- [ ] 4.3 远程上报与任务查看的核对：先授权（远程派发记录、实时能力与白名单，不满足一律 `forbidden`），后状态（`dispatch_ref` 摘要、`running` 或 off_machine 的 `blocked(no_progress)`，不满足 `not_running`）；之后复用派工令牌上报的写入路径与限额；`task_show` 远程投影；节点在 `blocked(no_progress)` 期间消费终态与提问上报；验证 worker-report 的"远程调用方为本机执行器的任务上报""旧派发的迟到上报"，remote-mcp 的"查看别人的任务"，executor-grok-routine 的"超时后 Grok 才交回结果"场景
- [ ] 4.4 `ready` 交付物支持 `raindown:proposal/<id>`：核对提案 `actor` 为上报者、新内容归属一致、`created_at` 不早于本次派工开始（接管时按原派发时间）、无 `target_hidden`；记录提案状态，合入结果产物 `kind: proposal`；验证 worker-report 的"以提案交付""交付别人的提案"场景
- [ ] 4.5 执行器：派工正文用 core 模板渲染、请求远程派发、等待上报、`no_progress` 卡住、`deliver` 返回 `not_running` 触发重新派发（回复界面提示旧运行结果将被丢弃）、取消；验证 executor-grok-routine 其余场景（假的 webhook 服务与假的远程上报）
- [ ] 4.6 `raindown init` 不自动生成 grok 角色；在 executors.md 增加 `grok-research` 示例与提示词模板（交付说明、只用提案交付、不在聊天里贴密钥、提醒派工正文会发往 xAI）

## 5. 真实环境上线（用户与协调者）

- [ ] 5.1 用户完成：`raindown hub token issue remote:grok --remote --note "Grok Bot"`、写 `config/remote.yaml`（只授权一个 workspace，填 `dispatch`）、`raindown secrets set grok/webhook-key`、`tailscale serve`、在 Grok 中添加连接器。协调者把步骤写入 `docs/grok.md`
- [ ] 5.2 端到端验证：在 Grok 聊天中让 Bot 检索 Raindown 知识库并提交一个提案 → 用户在 Raindown 中看到并处理；建一个 `grok-research` 角色的任务 → Grok 运行 → `raindown_report ready`（交付提案）→ 任务 `done`；`raindown remote status` 显示调用记录；`raindown doctor` 通过
