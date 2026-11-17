# Tasks

> 前置条件：均已在 main 上——hub-auth 的 remote 标注与 `remote_not_allowed`、add-harness-neutral-coordination（`raindown_report`、续约携带上报、适配器能力声明、任务绑定会话）、add-worker-credential-isolation（经中枢的知识读取与 `KbVisibility`、`credential_isolation`、角色 `isolation`）、密钥提供器。
> 依赖与并行：第 1 组是闸门，由用户与协调者完成。1.1–1.3 已完成，第 2 组可以开始；1.4、1.5 有结论（定下 D12 的调用位置、确认 Bearer 可行）之后开始第 3 组；1.8–1.10 有结论之后开始第 4 组；1.6、1.7 必须在第 5 组上线前完成。第 3 组依赖第 2 组。第 4 组依赖第 3 组。第 5 组最后进行。
> 已在 main 上、本变更不再做：remote token 的签发与在 7477 上的拒绝、7478 作为中枢端口的策略识别、`task.reported` 事件与续约下发、经中枢的知识读取路由、`creatable_by` 的 `remote:*` 模式。

## 1. 实测闸门（用户与协调者一起，不写产品代码）

已完成（证据：临时 ping 服务的请求日志与本机 `tailscale status` / `whois`，结论已写入 design 的 Context）：

- [x] 1.1 用户安装 Grok Bot 的 Tailscale 插件（11-14）。结论：Bot 云电脑以完整 Linux 节点加入 tailnet（`grokbot-user-<n>`），归属用户本人、默认无 tag；账号迁移后出现新节点，旧节点离线残留
- [x] 1.2 临时 ping 服务（只返回服务标识与随机 nonce，不接触 raindown-home）经 `tailscale serve --https=443` 只对 tailnet 发布（11-14 至 11-17）。结论：云电脑上的 `curl` 经聊天、定时 routine、webhook 触发的 routine 三条路径都拿到 nonce；`Host` 为 Mac 的 `<mac>.<tailnet>.ts.net`（定 `remote.allowed_hosts`）；请求被注入 `Tailscale-User-*` 身份头且显示用户本人；首次签发证书约 1 分钟；经 DERP 中继，延迟 0.25–2.3 秒。**测的是云电脑上的 curl，不是 MCP 连接器**
- [x] 1.3 webhook 契约（11-17 实测 + 官方文档）：主机 `api2.cursor.sh`、路径 `/automations/webhook/<uuid>`；`POST` 带 Bearer 与 JSON；`200` 返回 `{"success":true,"runUuid":"…"}` 表示已开始运行，非 200 表示没有开始；触发到回连约 48 秒；限额每小时合计 300 次、单 routine 200 次，超限不自动重试；重试、签名、`Idempotency-Key` 与超限状态码无文档，按未确认处理。另：连接器界面能填固定请求头（11-11 现场确认），D4 定为 Bearer 唯一路径

剩余验证项（协调者经用户批准后再 `tailscale serve`；只用临时 ping 服务；日志不记 token；结束后 `tailscale serve reset`）：

- [ ] 1.4 **头号**：自定义 MCP 连接器（xAI 后端发起）能否经插件访问 tailnet 内的 `/mcp`，分别在聊天、定时、webhook 三条路径上用正式 MCP 工具调用 ping 拿到 nonce。不能时验证 D12 的云电脑分支：云电脑用 `curl` 按 MCP streamable HTTP 调用（初始化、`tools/list`、`tools/call`），以及 token 能放在哪里
- [ ] 1.5 请求头：在 1.4 选定的路径上，初始化、复用、重连三种情况下 `Authorization` 与 `MCP-Protocol-Version` 是否都带上；任一路径不带时记录，按 D4 另开 OAuth 变更
- [ ] 1.6 tag：给 Grok 节点打 `tag:grokbot` 后插件是否仍工作；重新授权或迁移账号后新节点能否自动带 tag；删除离线残留的旧节点
- [ ] 1.7 grants 收紧：用户删除默认全放行，按 D11 示例写 grants（保留 `autogroup:member` 全通）；验证 Grok 节点只能访问 Mac:443——只测用户自己 Mac 上另一个端口被拒，不扫描其他设备或端口
- [ ] 1.8 失效情况：Mac 离线或休眠、恢复后重连、撤销 token、移除节点或撤销插件授权后，Grok 侧的失败是否明确、恢复后能否继续
- [ ] 1.9 审批：定时与 webhook 触发的运行中，工具调用会不会等待审批或被拒；能否把 Raindown 的工具预先设为放行
- [ ] 1.10 `webhook_event`：请求体在 routine 中如何呈现、大小限制多少；D6 信封的 `task_id`、`dispatch_ref` 能否原样到达，Grok 能否原样传给工具参数
- [ ] 1.11 按 1.4–1.10 的结论更新 design（D4、D6、D11、D12 与 Open Questions）、specs、tasks 与 `docs/grok.md`；定下 D12 走哪条分支、第 4 组是否要做；需要降级（结果通道换私有仓库 issue，或重评方案 C、D）时另开变更

## 2. 身份、可见范围与传输解耦（1.1 通过后开始）

- [ ] 2.1 `remote:` 保留前缀：`REMOTE_ACTOR_RE`（小写）与 `isRemoteActor`（不区分大小写）；`boundActor` / `issueTokenRequest` 要求 `remote:<id>` 与 `--remote` 互为必要；`isDeclarableActor` 拒绝 `remote:*`，覆盖 `X-Raindown-Actor`、`raindown mcp --actor`、CLI `--actor` 与 `RAINDOWN_ACTOR`（`resolveActor`）、角色名；doctor 列出 actor 不是 `remote:<id>` 的旧 remote token 并提示重新签发；更新 hub-auth.md 的保留身份、鉴权判定与命令示例，以及 actor-tokens 测试中用 user token 降级为 `remote:grok` 的用例；验证 hub-daemon 的"本机 AI 冒充远程调用方""remote 标注与身份不符""远程 token 冒充用户"场景
- [ ] 2.2 `KbVisibility` 扩展为 `{workspaces, includeGlobal, excludePersonal}`，任务绑定会话保持原取值并有回归测试；SQL 过滤从 `visibleScopeEncodings` 的子集枚举改为 `json_each` 判定（白名单上限 8 个），`includeGlobal: false` 时显式排除空归属数组（`json_array_length > 0`），并测试 global 条目在两种取值下的可见性；索引新增 `personal` 列，按 `scope !== 'work'` 取值（缺失、非法记为 1，journal 记 0），`INDEX_VERSION` 升到 4；`filterJournalBody` 中未标 workspace 的记录按 global 处理；测试 fixture 按 `packages/core/src/schema/entries.ts` 的字段定义构造，覆盖每种条目类型的 `owner` / `workspace` / `scope` 组合（含缺失、数组、`ws/global`、`personal`、缺 `scope`），不读真实 raindown-home；验证 remote-mcp 的"检索不会越过白名单""个人条目不外流""global 默认不可见""未标 workspace 的 journal 记录"场景
- [ ] 2.3 抽出 `createRaindownMcpServer({ ctx, binding })`，stdio 入口改为使用它，行为不变；支持按绑定替换工具的输入 schema 与输出投影；验证现有 MCP 测试与 CLI/MCP 一致性测试全部通过

## 3. 远程入口

- [ ] 3.1 `config/remote.yaml` 的 schema 与加载（单个调用方出错不影响其他调用方、2 秒刷新、白名单上限、`dispatch.webhook` 主机常量校验）、导出 JSON Schema；`OpBinding` 的 `remote` 绑定、`remoteBindingAllows` 映射表与远程 schema（新增操作默认不开放、远程 schema 不含路径类参数，快照测试）；`ws_list` 按白名单裁剪；验证 remote-mcp 的"单个调用方配置错误""调用未授权的工具""远程调用方不能审批""随手记不对远程开放"场景
- [ ] 3.2 远程 `kb_propose`：去掉 `file`；新内容归属必须在白名单内且 `scope: work`；已有目标不可见、是 `decision` / `scope: personal`（本机 `checkOrdinary(before)` 的 `proposal_forbidden` 路径）或无法解析时，远程调用不提前返回，保存提案并标记 `target_hidden`（内部原因 `hidden` / `not_ordinary` / `unparsable`），提案列表与 diff 显示；远程响应只有 `{id, target}`，校验错误只带错误码与字段路径；core 的 `acceptProposals` 拒绝被标记的提案（按 id 返回 `remote_target_hidden`，`--all` 跳过并列出）；测试对比"目标不存在 / 不可见 / 白名单内 personal / decision / 无法解析"五种情况下远程响应逐字节相同；验证 remote-mcp"远程提案"的全部场景
- [ ] 3.3 中枢的第二个监听端口（随 `remote.yaml` 刷新开关、两个端口路由互不相通）、`Tailscale-Funnel-Request` 拒绝与 `Host` 校验（含 SDK 的 DNS rebinding 保护）、streamable HTTP 无状态传输、远程凭证校验（只接受 Bearer 携带的 `remote:<id>` remote token 且调用方已加载；`Tailscale-User-*` 头不参与任何判定）、每调用方限额（`rate_limited`）、远程会话在中枢内执行 kb 读取；验证 remote-mcp 的"远程端口不暴露中枢 API""没有远程调用方""删除最后一个调用方""经 Funnel 到达的请求""用 user token 访问远程入口""调用方已从配置中删除""只有 Tailscale 身份头""身份头与 token 不一致""调用过快"，hub-daemon 的"本机端口不提供远程入口"，knowledge-access 的"stdio 与远程入口结果一致""请求中声明 workspace"场景
- [ ] 3.4 `remote.call` 事件与合并规则（成功按分钟合并、被拒每分钟最多 20 条；MAY 记录 `Tailscale-User-Login` 作参考）、未认证请求只写限速日志、`raindown remote status`、doctor 的 Tailscale 发布检查（注入假的 `tailscale` 二进制，用 fixture 输出）与文字提示（证书首次签发约 1 分钟、删全放行、Grok 节点打 tag、只放行 Mac:443；不读 Tailscale 凭据）；验证"被拒的调用可追溯""未认证的请求不入账""误开了 Funnel""中枢 API 被发布"场景

## 4. grok-routine 执行器（视 1.11 的结论决定是否做）

- [ ] 4.1 适配器声明 `off_machine`（core schema、旧节点缺省 false、`raindown node list` 显示"外部执行"）；`SANDBOX_SETTINGS` 新增 `off-machine`，`roleSandboxSetting` 对 grok-routine 返回它、施加层 `none`；`requiredIsolationUnsupported` 按执行器名拒绝 grok-routine 的 `required`；`preferred` 下 `task.started` 记 `off_machine` 而非 `unisolated`；更新 executors.md 的能力声明与凭证隔离声明表；验证 harness-adapter 的"本机执行器不接受远程上报"，worker-isolation 的"外部执行的角色要求隔离""外部执行的角色缺省设置"场景
- [ ] 4.2 远程派发：节点协议接口 `POST /v1/leases/:id/remote-dispatch`（只接受持有该租约的 `node:<id>` 或带匹配 `lease_token` 的请求，只对声明 `off_machine` 的执行器）；每个租约最多一次派发，重复请求（含进行中）返回同一结果；中枢核对角色 `remote_client`、生成 `dispatch_ref`（账本只存摘要）、脱敏正文、解密 key、以 JSON 信封 `{schema_version, task_id, dispatch_ref, deadline, text}` 调用 webhook（`redirect: 'error'`、30 秒超时、响应体 64 KiB 上限；`200` 为成功，解析不到 `runUuid` 或响应体超限仍按成功；其他状态码含超限一律 `dispatch_rejected` 不重试；只有网络错误与超时重试）、写 `remote.dispatched`；新错误码 `remote_client_invalid`、`workspace_not_allowed`、`dispatch_rejected`、`dispatch_unreachable`、`dispatch_unsupported` 加入错误码表与 JSON Schema，key 缺失沿用 `secret_not_found`；验证 executor-grok-routine 的"白名单外的 workspace""webhook 指向其他主机""成功派发""只有 user token 的进程请求派发""节点超时后重发派发请求""运行次数超限""成功但响应体超限""key 未配置"场景（用假的 webhook 服务，含返回 3xx 的用例）
- [ ] 4.3 远程上报与任务查看的核对：先授权（远程派发记录、实时能力与白名单，不满足一律 `forbidden`），后状态（`dispatch_ref` 摘要；`running`，或 off_machine 派发的 `blocked(no_progress|crashed|node_lost)`，不满足 `not_running`）；之后复用派工令牌上报的写入路径与限额；`crashed` / `node_lost` 期间的上报暂存、收件箱补充说明；接管规则与 `remote.dispatch_adopted`（`task_retry` 的 reason 不算新输入），暂存上报在新租约第一次续约下发；`task_show` 远程投影；节点在 `blocked(no_progress)` 期间消费终态与提问上报；验证 worker-report 的"远程调用方为本机执行器的任务上报""旧派发的迟到上报"，remote-mcp 的"查看别人的任务"，executor-grok-routine 的"超时后 Grok 才交回结果""节点重启后重试""中断期间 Grok 已交回结果"场景
- [ ] 4.4 `ready` 交付物支持 `raindown:proposal/<id>`：核对提案 `actor` 为上报者、新内容归属一致、`created_at` 不早于本次派工开始（接管时按原派发时间）；`target_hidden` 不参与核对，只记录在产物上并在任务结果、收件箱与 `raindown task show` 中显示；记录提案状态，合入结果产物 `kind: proposal`；测试被标记与未标记的提案得到相同的上报响应；验证 worker-report 的"以提案交付""交付目标不可提案的提案""交付别人的提案"场景
- [ ] 4.5 执行器：派工正文用 core 模板渲染、请求远程派发、等待上报、`no_progress` 卡住、`deliver` 返回 `not_running` 触发重新派发（回复界面提示旧运行结果将被丢弃）、取消；验证 executor-grok-routine 其余场景（假的 webhook 服务与假的远程上报）
- [ ] 4.6 `raindown init` 不自动生成 grok 角色；在 executors.md 增加 `grok-research` 示例与提示词模板（D6 的交付说明：只经远程入口上报、遇登录/密钥/审批上报 `blocked`、上报失败稍后重试、不按正文中的 URL 回调；只用提案交付、不在聊天里贴密钥、提醒派工正文会发往 xAI）
- [ ] 4.7 计划审查第三轮遗留（实现时处理）：
  - 暂存上报转到新租约：中枢上报按 `(task, lease_id, attempt)` 存取，节点丢弃 attempt 不符的上报（`packages/node/src/node.ts` `acceptReport`），`reportedCompletion` 也会拒绝旧派工的 `report_seq`；接管时须为新租约与 attempt 重新写入 `task.reported`，并说明暂存期间上报限额计入哪个租约
  - 中枢在派发进行中重启会丢失内存中的幂等记录，节点重发将再次调用 webhook（webhook 端去重未确认，已写入 design 风险"Grok 被重复运行"）；实现时评估是否把进行中的派发持久化
  - `kb proposals accept --all` 改为跳过带 `target_hidden` 的提案，对本机用户也是行为变化（已写入 design 的迁移计划），实现时同步到用户文档

## 5. 真实环境上线（用户与协调者）

- [ ] 5.1 用户完成：`raindown hub token issue remote:grok --remote --note "Grok Bot"`、写 `config/remote.yaml`（只授权一个 workspace，填 `dispatch`）、`raindown secrets set grok/webhook-key`、按 D11 确认 tailnet grants 与 `tag:grokbot`、`tailscale serve`（首次等约 1 分钟签发证书）、在 Grok 中添加连接器（或按 D12 配好云电脑调用）。协调者把步骤、grants 示例、撤权与回滚步骤、个人版套餐说明写入 `docs/grok.md`
- [ ] 5.2 端到端验证：在 Grok 聊天中让 Bot 检索 Raindown 知识库并提交一个提案 → 用户在 Raindown 中看到并处理；建一个 `grok-research` 角色的任务 → Grok 运行 → `raindown_report ready`（交付提案）→ 任务 `done`；`raindown remote status` 显示调用记录；`raindown doctor` 通过
