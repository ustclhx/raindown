# Tasks

前置：add-m1-supervisor 完成 7.x 验收并归档；PR #68（隔离用户级 Codex 配置）合并。每个阶段独立成 PR，按顺序合并。

## 1. 基础：适配器能力与今晚的问题

- [x] 1.1 确认投影对未知事件类型的处理（忽略而不是报错），为后续新事件铺路；补测试
- [x] 1.2 `ExecutorPlugin` 增加 `capabilities`（D1），节点注册上报，中枢存入节点投影；现有五个执行器各自声明
- [x] 1.3 新增卡住原因 `workdir_missing`（schema、迁移、收件箱分级默认 interrupt）；节点执行依赖工作目录的命令前检查目录（D6）
- [x] 1.4 codex-orca：`gh pr list` 改在登记仓库目录执行；ENOENT 区分"程序不存在"与"目录不存在"，说明如实
- [x] 1.5 codex-orca 终端标题 `[Raindown] <task id>`（D13）
- [x] 1.6 codex-orca 带外检测：Raindown 未回复而授权被批准/执行 → `task.out_of_band`；终端或目录被删 → `workdir_missing` + 带外事件；收件箱带外条目（inbox spec）
- [x] 1.7 harness 隔离纳入契约文档：`docs/executors.md` 增加"适配器契约"一节（能力、授权请求结构、隔离要求、带外检测），并记录 #68 审查留下的残余风险：项目级 `.codex/`（rules、mcp_servers、hooks、notify）在信任后加载、系统层 `/etc/codex` 与 MDM、`~/.agents/skills` 不在隔离范围
- [x] 1.8 跟进 #68 的残余风险：信任弹窗不再自动按"信任"，或启动前确认 worktree 中没有 `.codex/`；codex-orca 与 codex-exec 写类角色分开 CODEX_HOME；`codex_home_mismatch` 比较规范化路径

## 2. 派工与恢复

- [x] 2.1 `task.attempt_ended` 事件与派工投影（D4）；`raindown task show` 列出派工
- [x] 2.2 `task_retry` 操作（用户与 supervisor 的权限边界按 task-assignment spec）；写入已有的 `task.requeued{reason:'manual'}`
- [x] 2.3 `ctx.recovery` 与恢复提示模板（D5），codex-orca / codex-exec / claude-sdk 适配器各自放置
  - `pushed_sha` 留待第 3 阶段结构化上报通过账本事件提供；当前只采用账本事件与历史结果中的恢复事实，不从临时 activity 推断 PR 或 push。
- [x] 2.4 交付物已存在时的完成判定（D6），只对写类开发任务生效；合并资格检查回归测试
- [x] 2.5 supervisor 角色提示：审查崩溃用 `task_retry` 而不是新建审查任务

## 3. 结构化上报

- [x] 3.1 派工令牌（泛化 wake token，D2）；中枢按令牌识别任务与派工
- [x] 3.2 MCP 服务器按绑定类型裁剪工具集；任务绑定只暴露 raindown_report、只读知识操作、限本任务的 task_show / event_get（event_get 已由 6.1 接入）
- [x] 3.3 `raindown_report` 操作（worker-report spec 全部 Scenario），含 question 选项与推荐项、handback 字段（本 PR 完成中枢接口与结果处理，停下后的节点合并见 3.4）
- [x] 3.4 节点合并上报与推断（D3），`basis` 写入 `task.blocked`；矛盾事件
- [x] 3.5 适配器注入 Raindown MCP：codex-orca / codex-exec 在 Raindown 生成的 CODEX_HOME 配置中注入；claude-sdk 注入任务绑定
- [x] 3.6 `basis: inferred` 的提问不委托 supervisor（delegation 检查）
- [x] 3.7 收件箱条目显示 basis；结构化选项作为回复选项，Telegram 按钮
- [x] 3.8 dev / reviewer 角色提示：要求通过 `raindown_report` 提问与报告完成

## 4. 策略版本与授权依据

- [x] 4.1 策略版本哈希（D7），`policy.decided`、委托、代答记录写入；`raindown hub status` / `raindown doctor` 显示
- [x] 4.2 `policy.changed` 检测（启动与定期检查）
- [x] 4.3 `task.created.mandate` 由中枢计算
- [x] 4.4 受影响任务的策略变化输入；进行中代批委托依赖的规则被删时转交用户
- [x] 4.5 已结束任务恢复前的重新校验（task-mandate spec）

## 5. 阶段

- [x] 5.1 core 纯函数 `taskStage`（D8）与完整的顺序测试
- [x] 5.2 `raindown task list` 显示阶段、`--stage` 过滤与默认排序；`raindown task show`、收件箱条目、`raindown supervisor status` 显示阶段

## 6. 上下文指针与原始指令

- [x] 6.1 `event_get` 只读操作（可见范围检查、遮蔽）
- [x] 6.2 `task_show` 增加 section 与分页；读取指针格式（D12）
- [x] 6.3 唤醒输入降级时附 `chars` 与指针；PR 对象带相关任务
- [x] 6.4 原始指令附加（D9），worker 输入两段式模板；审查任务输入同样带原始指令

## 7. observe 模式

- [x] 7.1 配置 `supervisor.observe`（schema、doctor）
- [x] 7.2 代答/代批 observe：`task.reply_observed` + 转交用户，收件箱附"supervisor 会：……"
- [x] 7.3 autonomous 唤醒的写类动作 observe：`supervisor.observed_action`
- [x] 7.4 `raindown supervisor report`：observe 判断与用户实际回复的一致率，reported / inferred 比例

## 8. PR 订阅与直通

- [x] 8.1 `pr.subscribed` / `pr.unsubscribed` 事件；开发任务与审查任务的自动订阅；`raindown task show` 显示订阅
- [x] 8.2 workspace 配置 `github.watch`（默认关）与 `github.allowed_users`（默认仓库 owner）
- [x] 8.3 中枢 `pr-watcher`：轮询、游标、退避、失败计数（D11）
- [x] 8.4 `task.input_added` 与续约下发；不能中途注入的适配器排队到下一次派工；不可信内容包裹
- [x] 8.5 已结束任务因名单内用户评论恢复（经 4.5 重新校验）
- [x] 8.6 handback 进入 supervisor instruction 队列；无订阅任务的名单内评论进入 supervisor 队列
- [x] 8.7 直通事件不唤醒 supervisor 的回归测试（含 CI 失败、审查 changes_requested）

## 9. 文档与验收

- [x] 9.1 `docs/executors.md`（适配器接入指南）、`docs/supervisor.md`（observe、原始指令、交回）、`docs/prd.md` §19 补充
- [x] 9.2 真实验收：一轮 product-res 任务，worker 用 raindown_report 提问并由 supervisor 代答；PR 上 CI 失败直通 worker 修复；审查崩溃后 task_retry；observe 跑一轮并看一致率
  - 2026-11-07 实测（product-res，dev-claude 临时角色 + claude-sdk）：worker 用 raindown_report 提问（basis: reported）并由 supervisor 代答；无规则命中与含 git.push / pr.create 的授权直接转给用户（Telegram）；ready → branch_unknown → blocked 回退；supervisor 建审查任务并订阅 PR #35，审查 approve；github.watch 采集 check_run 为 pr.event（allowed:false，只作上下文、不唤醒）；`raindown supervisor report` 可运行。
  - 按用户决定以测试覆盖代替的项：CI 失败直通 worker 修复、审查崩溃后 task_retry、observe 代批一致率（本轮没有 supervisor 档位的授权，observe 表为 0）。
