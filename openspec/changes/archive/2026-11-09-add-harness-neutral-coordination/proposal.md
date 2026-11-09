# Proposal

## Why

M1 的真实验收（7.x 两轮）暴露出同一类根因：Raindown 对 worker 状态和授权的判断依赖于具体 harness 的表面行为。
- worker 停下的原因靠读 Codex 终端文字猜（#65：选择题被判成 `other`）；
- harness 自带的放行配置能绕过 Raindown 授权（#66 `approvals_reviewer=auto_review`、用户级 `rules/` 放行 `git push` 与读钥匙串）；
- 在 harness 界面里误触（按 `y`、删 worktree）Raindown 完全无感知，工作目录丢失还被误报成"找不到 gh"；
- 一个审查崩溃后重建审查，旧任务挂在 blocked 让合并被拒（#31），开发任务的 PR 已开出、执行器崩溃后任务卡住、合并请求不合格（#32）；
- 所有派生事件都要唤醒 supervisor，每次约 $0.2–0.5 并占每日上限。

harness 变化很快，Raindown 以后要接入更多 harness。参考 DeepSeek dsh-superagent 原型的若干设计（结构化上报、observe 模式、Mandate、Ticket/Assignment 分离、按等待对象划分阶段、订阅与直通、Inline & Spill 与链式召回），把这些协调机制定义为**与 harness 无关的契约**，各 harness 以适配器实现。

## What Changes

- **结构化上报**：新增 worker 可调用的 Raindown MCP 工具 `raindown_report`（progress / question / ready / blocked / failed / dropped，question 带结构化选项）。卡住原因同时记录来源 `basis: reported | inferred`；终端分类保留为适配器内的兜底，`inferred` 的提问不交给 supervisor 代答。
- **harness 适配器契约**：执行器声明能力（结构化授权请求、中途注入消息、会话恢复、能否加载 Raindown MCP、带外操作检测等）；授权请求识别归各适配器；适配器必须隔离 harness 自带的放行配置（PR #68 对 Codex 的修复按此契约归位）；Raindown 管理的终端可辨识；检测到带外操作（Raindown 未回复而授权已执行、工作目录被删）时记录并通知用户。
- **一个任务多次派工**：任务与派工（attempt）分离，新增重试操作；重跑审查、执行器崩溃后的恢复都在原任务下新建派工，不再新建任务；新派工带重启/恢复提示，要求先核对目录、git 历史与 PR 再重复外部动作。
- **工作目录丢失**：新增卡住原因 `workdir_missing`，不再误报为崩溃或"找不到 gh"；PR 已开出的任务可据 PR 判定完成。
- **授权依据（Mandate）与策略版本**：任务、`policy.decided`、代批/代答记录 policies.yaml 的版本哈希与命中规则；策略变化时向受影响的运行中任务记录通知，恢复已结束任务前按当前策略重新校验。
- **按"在等谁"划分阶段**：任务派生出互斥的阶段（等人授权、等人回答、等人审阅、受阻、排队、工作中、空闲），CLI、收件箱与以后的 Web 端统一使用。
- **supervisor 保留原始指令**：supervisor 建的任务合同带原始用户指令的引用（事件 seq 与原文），supervisor 自己的补充单独标明。
- **observe 模式**：supervisor 代批、代答与自主工作可单独设为 `observe`，只记录"会怎么做"，照常转给用户；用于放开自主权前对照判断质量。
- **任务订阅 PR 与直通**：开出或接手 PR 的任务订阅该 PR；中枢轮询 PR 上的 CI 结果、审查结论与人类评论，直接送给订阅的任务（只作上下文，不带新授权），不再唤醒 supervisor；超出任务范围的由 worker 交回，再进入 supervisor 唤醒。
- **读取指针与链式召回**：注入给 supervisor 与 worker 的对象一律带 id；被截断的内容带总长度与读取指针（对应只读操作）；新增按 seq 读取账本事件的只读操作，使 supervisor 能沿 id 追溯。

## Capabilities

### New Capabilities
- `worker-report`：worker 通过 Raindown MCP 结构化上报状态与提问，以及上报与适配器推断结果的合并规则。
- `harness-adapter`：与 harness 无关的执行器适配器契约：能力声明、授权请求识别、自带配置隔离、Raindown 终端可辨识、带外操作检测。
- `task-assignment`：任务与派工分离、重试、恢复提示、工作目录丢失的处理。
- `task-mandate`：任务的授权依据与策略版本，策略变化通知与恢复前校验。
- `task-stage`：按等待对象派生任务阶段。
- `pr-subscription`：任务订阅 PR、PR 事件直通 worker、超范围交回。
- `context-pointers`：注入内容的 id、截断与读取指针，按 id 追溯的只读操作。

### Modified Capabilities
- `stuck-detection`：卡住原因增加 `workdir_missing`，每个原因记录来源 `basis`。
- `policy-engine`：策略判定记录策略版本哈希。
- `inbox`：条目显示来源 `basis` 与任务阶段；带外操作条目。
- `executor-codex-orca`：Raindown 终端可辨识、带外操作检测、工作目录丢失上报，按适配器契约实现。

另：`supervisor`（由 add-m1-supervisor 引入）增加 observe 模式与原始指令引用；该能力的主 spec 在 add-m1-supervisor 归档后才存在，因此本变更**依赖 add-m1-supervisor 先归档**。

## Impact

- 代码：`packages/core`（任务与派工模型、事件、ops 新增 `task_retry`、`raindown_report`、`event_get`、阶段派生、策略哈希）、`packages/hub`（派工与重试、PR 轮询与直通、策略变化通知、唤醒输入指针）、`packages/node`（适配器能力声明、各执行器的上报合并与带外检测）、`packages/mcp`（worker 可用工具集按身份区分）、`packages/cli`。
- 账本：新增事件类型（派工、上报、带外操作、PR 事件、策略变化），旧事件保持可读；任务投影增加派工列表与阶段。
- 外部：中枢新增对 GitHub 的轮询（用 `gh`，按订阅的 PR 限频），不引入 webhook 与公网暴露。
- 配置：`config/workspaces/<id>.yaml` 的 supervisor 段增加 observe 开关；角色可声明 harness 适配器参数。
- 文档：`docs/executors.md`、`docs/supervisor.md`、新增适配器接入说明。
