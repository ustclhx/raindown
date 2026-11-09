# Design

## Context

动机见 proposal.md。与设计相关的现状（以 main a60ec7a 与 PR #68 为准）：
- 执行器插件接口（`packages/node/src/executor.ts`）只有 `type`、`mode`、`requires`、`run`、`classify?`；节点注册只上报 `{type, mode}`。停下判定由节点调用 `executor.classify(StuckSnapshot)` 从终端末尾 40 行推断，提问的选项被拍平成文字。
- 没有 worker 可用的上报工具；Raindown MCP 不按身份过滤操作，codex-orca 的 worker 过去是经用户级 Codex 配置以 `--actor codex` 接入的（PR #68 隔离后不再接入）。
- 任务只有 `attempt` 计数；`task.requeued{reason:'manual'}` 已在 schema 中但没有写入方，没有重试操作。
- 策略每次判定都重新读 `policies.yaml`，不计算版本；`policy.decided` 记录命中规则内容。
- supervisor 唤醒输入有三级降级（`scheduler.ts` `wakeEvents`），降级后只剩 seq，没有读取指针，也没有按 seq 读事件的操作。supervisor 建的任务合同只有它写的 goal。
- 中枢不读取 PR 上的 CI、审查与评论；只有 pr-merge 在合并时按需读 CI。
- 账本是只追加的事件表加投影，重启时重放；新增状态都应表现为事件。

## Goals / Non-Goals

**Goals:**
- 契约层（core 中的类型、事件、操作）不出现任何 harness 专有概念；Codex/Claude 的差异只存在于各自适配器内。
- 所有新增状态都是账本事件与投影，可重放、可审计。
- 默认行为对现有配置兼容：未声明新能力的执行器按今天的方式工作。

**Non-Goals:**
- 不淘汰终端分类（保留为 codex-orca 的兜底，以后视情况再定）。
- 不引入 GitHub webhook 与任何公网入口（4.10 的暴露前提仍待用户决定）。
- 不做 Web 面板（阶段派生为它准备数据，界面另立变更）。
- 不改变合并资格与 pr-merge 的强制核对；直通与订阅不带来任何新授权。

## Decisions

### D1. 适配器能力作为注册信息的一部分
`ExecutorPlugin` 增加 `capabilities`：`approval_requests: structured | inferred | none`、`inject_while_running`、`resume_session`、`raindown_mcp`、`out_of_band_detection`。节点注册把它连同 `type`、`mode` 上报，中枢存入节点投影；中枢的派送、直通与代答限制只读能力，不读 `type`。
- 备选：在中枢按执行器类型名维护能力表。否决：新 harness 接入要改中枢，违背"适配器自描述"。

### D2. worker 的 Raindown MCP 绑定沿用唤醒令牌机制
节点为每次派工生成一次性的派工令牌文件（与 supervisor 的 wake token 同一机制，`wake-token.ts` 泛化为 lease token），适配器在 Raindown 生成的 harness 配置里注入 `raindown mcp --actor <role> --task <id>`，并通过环境变量传令牌文件路径。中枢仅凭令牌确定"哪个任务的哪次派工"，令牌随派工结束失效。
- MCP 服务器按绑定类型裁剪工具集：任务绑定只暴露 `raindown_report`、只读知识操作（kb_search/get/query）、`task_show`（限本任务）、`event_get`（限本任务）。今天"所有操作对所有调用方可见"的行为只保留给无绑定的 CLI 会话。
- 备选：worker 用 CLI 调 `raindown report`。否决：CLI 无法可信地确定调用者属于哪个任务。

### D3. 上报与推断的合并在节点完成
节点在派工期间缓存最近一次未消费的上报。worker 停下（适配器发出 idle 信号）时：有未消费的上报则用上报生成 `BlockedSignal{basis:'reported'}`，否则调用 `classify` 得到 `basis:'inferred'`。上报 `question`/`blocked` 后若 harness 仍在忙超过 2 分钟，节点也以上报为准进入 blocked，并记录矛盾事件。`dropped`/`ready`/`failed` 由节点直接结束派工。
- 选项与推荐项存入 `task.blocked.question{text, options[], recommended}`；收件箱、Telegram 按钮、supervisor 输入都从这里取。

### D4. 派工是投影，不是新表
派工由已有事件折叠：`task.started{attempt}` 开始一次派工；新增 `task.attempt_ended{attempt, reason, last_report}` 结束它（由节点在 outcome 时、中枢在租约过期/重试时写入）。`task_retry` 写 `task.attempt_ended{reason:'retry'}` + 已有的 `task.requeued{reason:'manual'}`，下一次派工带 `ctx.recovery`（上一次如何结束）。
- 重试沿用工作目录：codex-orca 已用 `state/tasks/<id>/orca.json` 记住 worktree，目录不存在时适配器按 D6 处理，不静默新建。
- 备选：新建子任务并把旧任务标为被替代。否决：仍会出现两个审查任务并存的问题，且合并资格要跨任务判断。

### D5. 恢复提示是固定文本加结构化事实
`ctx.recovery = {previous_end, reported_branch?, prs[], pushed_sha?}`，适配器把它渲染成提示放在派工输入开头。文本由 core 提供统一模板，适配器只负责放置位置。

### D6. 工作目录丢失与"交付物已存在"
- 节点在执行依赖工作目录的命令前先检查目录存在；不存在时适配器上报 `blocked(workdir_missing)`。`gh pr list` 改为在**登记仓库目录**而不是 worktree 中执行，worktree 丢失不影响 PR 查询。
- 中枢收到 `workdir_missing` 或 `crashed` 时，若任务已报告分支且该分支有它开出的 open/merged PR，写 `task.done{result.completed_via:'existing_pr', prs}`；否则保持 blocked 等待重试或取消。是否自动判定由角色类别决定：只对写类开发任务生效，审查与合并任务不适用。

### D7. 策略版本与授权依据
- 版本 = 对"有效规则数组"做规范化 JSON 后的 sha256 前 12 位，注释与无效规则不参与。中枢每次加载策略时计算；与上一次不同就写 `policy.changed{from, to, added, removed}`。为保证不依赖"恰好有一次判定"，中枢启动时与每 60 秒检查一次文件 mtime。
- `task.created` 增加 `mandate{created_by, origin, wake_task?, instruction_seq?, policy_version, matched_rules?}`，由中枢计算，调用方不能传入。
- 受影响任务 = `mandate.matched_rules` 或进行中委托的 `policy.decided.matched_rules` 中含被删除/修改规则的任务。进行中的代批委托依赖的规则被删除时，委托以 `reply_escalated{reason:'policy_changed'}` 转给用户。

### D8. 阶段是 core 中的纯函数
`taskStage(view, delegation)` 按 spec 顺序返回阶段；CLI、收件箱、supervisor status 都调用它。不入库、不缓存。

### D9. 原始指令由中枢附加
supervisor 调 `task_create` 时，中枢从当前唤醒的事件中找 `user.instruction`：只有一条时自动附加 `origin_instruction{seq, text}`；多条时要求调用方传 `instruction_seq` 且必须属于本次唤醒；autonomous 唤醒没有原始指令。原文超过 4000 字时截断并带读取指针（`event_get`）。worker 输入模板分两段："用户原始指令（以此为准）"与"supervisor 的补充"。
- 备选：让 supervisor 自己把原话抄进 goal。否决：可被改写，无法核对。

### D10. observe 模式落在委托与建任务的出口
配置 `supervisor.observe: { replies, approvals, autonomous }`（均默认 false）。
- 代答/代批：`task_respond` 在 observe 下写 `task.reply_observed{decision, reason}`，随后以 `reply_escalated{reason:'observe'}` 转给用户，收件箱条目附"supervisor 会：……"。用户实际回复后，`raindown supervisor report` 按委托把 observe 判断与用户回复比对。
- 自主工作：autonomous 唤醒的 `task_create`/`task_propose`/`pr_merge_request` 在 observe 下只写 `supervisor.observed_action`，不执行。

### D11. PR 订阅与采集
- 订阅是事件：`pr.subscribed{task_id, pr, role}`、`pr.unsubscribed`。开发任务在 `task.branch_reported` 后由节点发现 PR 时订阅；审查任务创建时订阅。
- 采集在中枢的 `pr-watcher`：对"有活跃订阅"的 PR 每 2 分钟用 `gh api` 读取 check runs、reviews、issue comments 与 review comments，以各自的 `updated_at`/id 作游标，写 `pr.event{pr, kind, actor, actor_kind: human|bot, allowed, text, url, cursor}`。连续 3 次失败才报告系统问题。用中枢所在机器的 `gh` 登录，只读查询。
- **谁的评论算请求**：workspace 配置 `github.allowed_users`（默认仓库 owner）。只有 allowed 的人类评论能恢复已结束任务或进入 supervisor 唤醒；其他人与机器人的内容只作为上下文送达运行中的任务，且在 worker 输入中以不可信数据包裹。这是公开仓库下防止外部评论驱动工作的关键约束。
- 送达：新增 `task.input_added{source:'pr', pr_event_seq}`，经续约下发（与回复同一通道但不解除 blocked）；执行器不能中途注入时排队到下一次派工。已结束任务在 allowed 人类评论到达且通过 task-mandate 的重新校验后，以 `task.requeued{reason:'input'}` 恢复为新派工。
- 交回：`raindown_report` 增加 `handback{pr_event_seq, reason}`，中枢把该 PR 事件放入 supervisor 的 instruction 队列（origin 为 instruction：只有 allowed 用户的评论能被交回，等同用户指令）。

### D12. 读取指针
指针格式 `{read: {op, args}}`，例如 `{op:'task_show', args:{id, section:'tail', offset:0}}`、`{op:'event_get', args:{seq}}`。`task_show` 增加 `section` 与分页参数；新增 `event_get`（按可见范围检查）。唤醒输入的三级降级在省略字段时一律附 `chars` 与指针。PR 对象由中枢组装：`{pr, url, tasks:[{id, role, status}]}`。

### D13. codex-orca 的带外检测与终端标题
- 标题 `[Raindown] <task id>`，在 `terminalCreate` 时设置。
- 带外批准：节点记录当前 pending 授权的命令文本；若之后终端出现批准提示行或该命令的执行行，而没有对应的 Raindown 回复送达，则写 `task.out_of_band{kind:'approval_outside_raindown', command}` 并按已执行处理。
- 终端/工作目录被删除：terminal read 返回不存在或目录检查失败 → `workdir_missing`，并写 `task.out_of_band{kind:'session_removed'}`。
- 隔离用户级 Codex 配置由 PR #68 实现（Raindown 管理的 CODEX_HOME），本变更只把它纳入 harness-adapter 契约与文档，并在其生成的配置中按 D2 注入任务绑定的 Raindown MCP。

## Risks / Trade-offs

- [worker 不调用 `raindown_report`] → 终端分类兜底仍在；角色提示要求上报，`raindown supervisor report` 统计 reported/inferred 比例，用数据决定何时淘汰兜底。
- [PR 轮询的 API 配额与延迟] → 只轮询有活跃订阅的 PR，2 分钟间隔并在连续无变化时退避到 10 分钟；直通延迟可接受（不追求实时）。
- [外部评论驱动工作] → `github.allowed_users` 白名单；非白名单内容不恢复任务、不唤醒 supervisor、以不可信数据送达。
- [策略哈希误报变化] → 只对规范化后的有效规则计算；增加测试锁定"注释/顺序不影响"的范围（顺序变化视为变化，因为规则匹配与顺序有关）。
- [派工令牌泄漏给 worker 的子进程] → 令牌只授予本任务的受限工具集，派工结束即失效；与 wake token 同样做 0600 文件权限与环境变量去除。
- [带外检测误判] → 只在有 pending 授权且终端出现明确的批准/执行行时判定；误判的代价是多一条 Interrupt 条目，不会放行任何动作。
- [自动"交付物已存在"判定把半成品当完成] → 只对写类开发任务、且 PR 由该任务分支开出时生效；之后仍要经过审查与合并资格检查。

## Migration Plan

1. 前置：add-m1-supervisor 完成 7.x 验收并归档，`supervisor`、`pr-acceptance` 等能力进入主 spec；PR #68 合并。
2. 按 tasks.md 的阶段顺序合并，每个阶段独立可用；新事件类型旧投影忽略未知类型的行为需先确认（任务 1.1）。
3. 配置项全部可选、默认关闭新行为（observe、PR 订阅采集需显式打开 `github.watch: true`），用户逐项打开。
4. 回滚：关闭对应配置即可退回旧行为；新事件保留在账本中不影响旧逻辑。

## Open Questions

- PR 轮询间隔与退避参数的最终取值，以真实使用后的 API 用量为准。
- Telegram 结构化选项按钮在选项文字很长时的截断方式。
