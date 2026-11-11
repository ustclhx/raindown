# Raindown 产品定义（PRD）v0.7

> 状态：讨论定稿草案 · 2026-10-24
> 项目正式名为 **Raindown**，标识符为 `raindown`。
> 本文是后续 OpenSpec proposal 的输入。标记为【待定】的条目尚未讨论。

---

## 1. 定位

Raindown 是一个**个人 AI 运营中心**。它把不同的模型和 harness 串联起来，让已经上线的东西自己运转：

- 现有服务的维护与迭代；
- 数据与运行监控；
- 热点发现；
- 社交媒体运营。

从 0 到 1 的开发不在范围内，那部分由用户在终端自己完成。

**目标**：让人和 AI、AI 和 AI 的协同更高效，解放用户的注意力。整个工作要可靠，并且像水一样自然流动。

**用户**：只给用户自己使用，不考虑多租户。如果好用，开源后供他人自行部署。

**评判标准**：以用户体感为准，看效率是否提升，不设硬性量化指标。

---

## 2. 设计原则

1. **状态在系统里，不在会话里。** Agent 是无状态的临时工：从共享事实读取上下文，干完把结果写回。
2. **任务就是合同。** AI 之间默认只通过任务账本交接，交接靠格式说清楚，不靠对话来回确认。
3. **注意力是最稀缺的资源。** 用户只看一个收件箱，分三级：
   - Interrupt：立即推送；
   - Decide：攒成一批，异步处理；
   - Digest：每日摘要。
4. **没有验证就不算完成。** 每个任务都带一个机器可以检查的完成条件。
5. **信任由用户配置。** 平台不预设哪些事必须审批，只提供机制：策略、审批关卡、审计、演练模式（dry-run）。
6. **内核做减法，插件做加法。** 内核只认识通用对象，业务能力通过配置和插件扩展。

---

## 3. 概念分层

| 层 | 内容 | 形态 |
|---|---|---|
| **内核** | 7 个一等对象（见 §4），以及调度、监督、验收、策略、收件箱 | 固定、精简 |
| **配置**（可插拔，不算插件） | Role、Workflow、Skill、Policy | YAML 或 Markdown 文件，git 版本化。文件是真相来源，工作台只是编辑器 |
| **插件**（代码） | **能力插件**：平台接入、数据源，比如 X、Cloudflare、GitHub、Plausible、Stripe、Grafana<br>**执行器插件**：各 harness 的适配器，比如 Claude Code、Codex、pi、oh-my-pi、Grok Bot | TS 模块。插件可以声明动作、事件、工具、指标，也可以给工作台增加视图 |

运维、热点、迭代、社媒都是**可配置的工作流**，不是插件。

---

## 4. 一等对象

| 对象 | 说明 |
|---|---|
| **Workspace** | 容器，分全局、职能、产品三级（§5） |
| **Event** | 发生了什么：告警、PR、新文章、定时触发、指标越过阈值等 |
| **Metric** | 关键指标的时间序列、阈值和趋势（§9） |
| **Task** | 一件可以验收的工作。状态：`queued / running / blocked / done / failed`。`blocked` 是一等状态，进入后自动进收件箱 |
| **Role** | 角色：提示词，加上 harness 和模型的绑定，二者解耦，可以随时换引擎 |
| **Knowledge** | 知识条目（§8）。其中的 **Decision** 是一种特殊类型：带预期效果、衡量指标和回看日期 |
| **Inbox item** | 需要用户注意的事，分 Interrupt、Decide、Digest 三级 |

待发布的内容、内容日历都不是独立对象：内容就是一种 Task，日历是视图。

---

## 5. Workspace 结构

```
全局层（轻量）
 ├─ 全局收件箱、全局知识
 ├─ 参谋长（只做跨 workspace 的汇总与分发）
 └─ 知识管理员（全局唯一，负责知识的串行合入）
职能 workspace（横跨产品，例如社媒、热点）── 只提任务、不执行
产品 workspace（每个产品一个）              ── 负责实际执行
```

- 每个 workspace 配一个独立的 **supervisor**。
- **资源单一归属**：
  - 每个资源（域名、仓库、社交账号、数据源）只归一个 workspace；
  - 其他 workspace 可以订阅它的事件，或向它的主人提交任务请求，但不能直接操作。
- **归属可以更改**：
  - 资源的 frontmatter 里有一个 `owner` 字段，改动后由内核负责迁移正在进行的任务、事件订阅和审计记录；
  - 社交账号归哪个 workspace 先做成配置项，暂不预设。

---

## 6. 核心闭环

```
数据 ─▶ 洞察 ─▶ 提案 ─▶ 人的决策 ─▶ 任务 ─▶ 验收
 ▲    (supervisor (Inbox:           (分派给  │
 │     巡检/分析)  Decide)           角色)   │
 └───────────────── 效果回看 ◀───────────────┘
```

- 以数据驱动和人的决策驱动为主，supervisor 的巡检负责持续注入新发现。
- 巡检发现的问题**以提案形式提出**，不自行执行。
- 每个通过审批的提案都记录预期效果、衡量指标和回看日期，生成一个 Decision。
- 到期后 supervisor 自动回看，结论写回 `decisions/`。

---

## 7. Agent 协作

### 7.1 Supervisor

- 每次唤醒都是一个**新会话**，靠 **workspace 简报**恢复记忆。简报包含当前状态、进行中的事、近期决策和关注点。干完活后更新简报。
- supervisor 本身也是一个被内核监督、可以重启的 worker。
- 【待定】各 workspace 的巡检频率和预算上限（token 和费用）。

### 7.2 内核与总管的混合分工

- **内核**负责"必须发生的事"：调度、心跳、超时、重试、验收、通知、策略执行。
- **Supervisor** 负责"该做什么"：拆分任务、路由、写交接说明、提出提案。

### 7.3 协作方式

- 默认走账本交接。
- 少数场景（比如代码审查的来回）允许开**有限轮次**的直接对话。

### 7.4 卡住检测

- 内核通过心跳和输出尾部判断 worker 是否停止，不依赖 TUI 的 idle 事件（已知不可靠）。
- worker 停止后，如果没有产出也没有完成，就标记为 `blocked`，并在收件箱生成一条 Interrupt 或 Decide。

### 7.5 执行器

每个 harness 包成统一合同：`run(spec, cwd, budget) → 事件流 + result.json`。

| Harness | 定位（可配置） |
|---|---|
| Claude Code | 代码审查、复杂开发、设计相关工作 |
| Codex（经由 Orca） | 简单改动、部署、浏览器操作 |
| pi / oh-my-pi | 轻量分诊、常驻值守 |
| Grok Bot（xAI 官方） | 读取 X：时间线、提及、搜索、趋势 |

模型和供应商的切换走统一网关（比如 LiteLLM），费用统一记账。

---

## 8. 知识库

### 8.1 形态

- **主库**：一个 git 仓库，内容是 Markdown 加 frontmatter，数据库只做索引。
- **raw 层**：一个独立的 git 仓库，只追加，不修改；大文件可以用 git LFS。
- **镜像**：Obsidian 直接打开主库；Notion 可做单向镜像，以后再定。

### 8.2 知识模型：LLM Wiki 加 RAG

参考 Karpathy 提出的 LLM Wiki 模式，分三层：

- **Raw**：随手记、热点文章、harness 记忆上行、事故记录、过往帖子。
- **Wiki**：由 LLM 编译和维护，内容包括资源、产品、runbook、决策、概念和个人知识。
- **Schema**：知识库的 AGENTS.md，加上各类条目的 frontmatter 规范。

对应三个操作：

| 操作 | 说明 |
|---|---|
| **Ingest** | 事件触发的工作流。由全局知识管理员串行合入，并更新 index 和 log |
| **Query** | 按 §8.5 的检索链路作答；有价值的答案写回 wiki |
| **Lint** | 定期巡检：矛盾、过时内容、没有出处的内容、孤立页面、缺失链接 |

总体原则是**编译热知识，检索冷知识**：
- 高频、高价值的知识编译进 wiki；
- 长尾内容留在 raw，用 RAG 检索；
- raw 里的内容被反复命中，或者基于它的回答被用户标为有用时，自动提升，编译进 wiki。

### 8.3 资源注册表

资源以 Markdown 文件的形式存在知识库里，例如：

```yaml
# resources/domains/a.com.md
type: domain
owner: ws/product-a
registrar: cloudflare
expires: 2027-03-01
monitors: [gatus:a-home]
last_verified: 2026-10-20
```

### 8.4 写入分级

| 内容 | 谁能写 | 方式 |
|---|---|---|
| journal（工作日志） | AI | 直接写 |
| 资源和事实 | AI 提议 | 进入暂存区，去重后成批交给用户确认；能被插件自动核实的直接写 |
| Decision | 用户批准提案时自动生成 | 回看结果由 AI 追加 |
| runbook | AI | 直接写，变更摘要进 Digest |
| 个人知识 | 用户；AI 可以协助记录 | 来自随手记 |

其他规则：

- **出处**：事实类条目必须引用 raw 里的原始出处；个人笔记和用户的判断不需要。
- **敏感度**：个人知识对 AI 可见。**密钥不进库**，知识库仓库强制做密钥扫描（比如 gitleaks），库里只存密钥的引用。
- **随手记入口**：Grok Bot 或其他聊天通道、工作台、桌面快捷键、CLI 都能写入，内容先进 `raw/inbox/`，再由 ingest 分类。
- **项目知识**：留在各项目自己的仓库里。主库为每个项目维护一张卡片，包含指针、自动摘要和关键事实摘录。
- **知识腐烂**：条目带 `last_verified` 字段，能通过插件核实的自动核实，过期又核实不了的在 Digest 里提醒。

### 8.5 获取上下文的四级链路

1. **推送**：任务启动时注入 workspace 简报和少量相关条目，控制在固定 token 预算内；
2. **导航**：index 和链接，加上 frontmatter 结构化查询；
3. **混合检索**：在 wiki 上做 BM25 + 向量 + rerank，比如用 qmd；
4. **RAG**：前面都找不到时，在 raw 上检索，答案必须引用原文。

### 8.6 Harness 记忆同步

- **上行**：各 harness 新增的记忆先进暂存区，再分类处理：
  - 共享事实：合入主库；
  - harness 自身的习惯：留在 harness 本地，主库只建索引。
- **下行**：主库自动生成各项目 AGENTS.md / CLAUDE.md 里的一个受管区块，其余部分不动。
- **冲突时**：共享事实以主库为准，harness 本地习惯以 harness 为准。

---

## 9. 数据层（"中"档）

- 平台只保存用户关心的关键指标的时间序列，存储用 SQLite 或 DuckDB，支持阈值、趋势和对比。
- 数据通过能力插件接入。MVP 首批来源是各产品的 `/api/health` 和 Cloudflare（含 Web Analytics）；Sentry、Stripe 等到产品实际启用后再接，以后再接 Grafana/Prometheus、Plausible 和社媒平台的统计数据。
- 明细数据仍然在原系统的面板里看。

---

## 10. 策略与审批

统一的策略模型：**范围 × 动作 × 档位**。

```yaml
policy:
  - scope: ws/personal-x
    action: social.reply          # 动作由插件声明
    level: draft-approve          # notify | draft-approve | auto-report | auto
    when: {sentiment: negative}
```

- **审批链**：
  1. 先看用户的显式策略；
  2. 没配置的动作，交给所用 harness 自带的自动审批；
  3. 自动审批不通过，就升级给人，进入收件箱。
- **预设**：平台提供几套预设（保守、放手等）。
- **审批卡片**包含：
  - 做什么、为什么做；
  - 风险，以及能否回滚；
  - 预期效果和回看日期；
  - 依据：引用的数据和知识；
  - 三个按钮：批准、驳回（附一句理由）、修改后批准。

  驳回理由回流到知识库。

---

## 11. 首批工作流

### 11.1 运维与监控

- 探测用现成工具：Gatus 或 Uptime Kuma 做 HTTP、证书和 DNS 检查，外加域名到期检查。
- 告警进来后，先读资源条目和对应 runbook 做分诊，结果分三类：误报、可以自愈、需要用户出手。
- 事故结束后自动补充 runbook。

### 11.2 迭代

- 对已有产品，提案通过后拆成任务，每个任务一个 worktree，由对应角色执行。
- 审查后合并，Verifier 再检查**主干部署**是否成功。
- 沿用 OpenSpec 流程，以及已有的 Orca / Codex 调度经验。

### 11.3 热点发现

- 来源：RSSHub、Miniflux 或 FreshRSS、HN、GitHub Trending、changedetection.io，以及 Grok Bot 读取的 X 内容。
- 打分时结合 `sources/` 里的权重和用户当前在做的产品，排序标准是"跟我有什么关系"，不只是热度。
- 产出：每日 Digest、研究类任务、挂到对应产品的 backlog。
- 长尾文章进入 raw，供 RAG 检索。

### 11.4 社媒运营

- **平台**：先接 X，其他平台以能力插件的形式陆续接入。
- **账号**：以个人号为主，每个账号的目标可以配置。
- **X 的接入方式**：
  - 读取（时间线、提及、搜索、趋势）由 Grok Bot 负责；
  - 发帖和回复由 X 能力插件直接调 X API。按公开资料，Grok Bot 的 X 连接器是只读的。
- **内容来源**（首批全部支持）：
  - 发版和更新记录；
  - 热点；
  - 知识库里的决策和经验；
  - 指标里程碑；
  - 随手记。
- **自主程度**：发布和互动（评论、私信、提及）都分档，由策略配置。
- **风格**：导入用户过去的帖子，编译出每个账号的风格指南；用户修改草稿的差异持续回流，修正风格指南。
- **数据回流**：每条内容的数据写入 Metric，每周做一次内容复盘；内容实验按 Decision 管理。
- **其他平台**：没有开放 API 的平台走"半自动"，系统准备好内容，由用户点发布。具体方案以后讨论。

---

## 12. 工作台

**形态**：Web 是核心；桌面端是辅助；碎片时间用聊天。

**使用场景**：

| 场景 | 时长 | 做什么 |
|---|---|---|
| 早上巡视 | 约 5 分钟 | 看全局健康，处理待决策事项 |
| 碎片时间 | 约 30 秒 | 在手机或聊天里批审批、记随手记 |
| 专注处理 | 半小时以上 | 进入 workspace，看数据，和 supervisor 讨论 |

**第一屏**："需要我的"（收件箱，三级，可批量处理）和"全局健康"（各 workspace 的红黄绿灯和关键指标）。

**候选视图**，按实际效果调整：
- Agent 运行板
- 事件时间线
- Workspace 页
- 指标面板
- 知识浏览
- 决策日志
- 成本与预算
- 配置
- 插件视图

**对话**：
- 每个 workspace 页面对接该 workspace 的 supervisor；
- 全局页面对接参谋长；
- 聊天通道的消息路由到同一个对象，两边共享上下文。

**Agent 观察与接管**：工作台可以实时查看 agent 的输出流；需要接管时，一键跳到 Orca 或终端打开对应会话。

**桌面端**负责：
- 系统通知；
- 菜单栏状态灯；
- 全局快捷键随手记；
- 内置节点守护进程（守护进程也可以单独部署）。

---

## 13. 部署拓扑：中枢加节点

- **常驻服务器是中枢**：保存账本、知识库和 raw 的 git 远端，运行调度器和 supervisor，24 小时在线。状态只存在中枢。
- **Mac 和其他机器是节点**：各自声明能力，比如"有某仓库的本地环境"、"有浏览器"、"有登录态"。任务按能力派到对应节点，节点离线时这类任务排队等待。
- 【待定】服务器的具体配置以后再定。

---

## 14. 待定与未覆盖

1. **Grok Bot 作为聊天入口**：需要实测 Grok Bot 能否调用外部工具或 webhook，把消息转给 Raindown。如果不能，聊天入口要另选通道（比如 Telegram），Grok Bot 只做 X 的读取执行器。
2. **X API**：Grok Bot 连接 X 时会创建开发者账号，需要实测这个账号能否复用，以及 X API 的费用档位。
3. **平台自身的可靠性**：谁来监控这个监控系统（外部心跳，比如 healthchecks.io）；账本和知识库的备份与恢复。
4. **安全**：密钥方案已定（§18）；节点和中枢之间的认证待定。
5. **预算**：已定，不做预算上限（harness 都走订阅），只记录费用供查看。
6. **技术选型**：已定（§17）；开源许可证待定，倾向 Apache-2.0。
7. **MVP 范围与里程碑**：已定（§16）。
8. **项目正式名称：Raindown（已定）。**

---

## 15. 可参考或依赖的开源组件

| 领域 | 组件 |
|---|---|
| 协议 | MCP、ACP（Agent Client Protocol） |
| Harness SDK | Claude Agent SDK、Codex SDK、pi-mono |
| 知识库 | Obsidian、qmd、gitleaks；社区的 LLM Wiki 实现（如 Astro-Han/karpathy-llm-wiki）可作为提示词参考 |
| 监控 | Gatus、Uptime Kuma、Beszel、healthchecks.io |
| 信息源 | RSSHub、Miniflux、changedetection.io、Firecrawl |
| 通知 | Telegram Bot（首选）、ntfy、Apprise |
| 网关与观测 | LiteLLM、Langfuse |
| 社媒发布 | Postiz（可作为发布层的参考） |
| Agent 任务板参考 | beads、Backlog.md、Vibe Kanban |

---

## 16. MVP 范围与里程碑

**原则**：纵向打通一条线：产品 workspace 的运维。用它把核心闭环完整跑通一次，同时尽快让用户感受到注意力被解放。

**首批 workspace**：

| Workspace | 资源 | 阶段 |
|---|---|---|
| `product-res` | 选品工作台。product.ezarouter.cc；自托管 Docker Compose（web、jobs，镜像来自 GHCR），不走 Workers；数据源目前只有 `/api/health` | 内测 |
| `xuanxue-saas` | arcanumber.com（西方站）、ganjiday.com（东方站），同一个 Worker 按 Host 区分；Neon、Turnstile、Google OAuth、Cloudflare Web Analytics。**暂未开启支付，不使用 Sentry** | 已上线 v0.1.1，未收费 |

**里程碑**：

| 阶段 | 内容 | 体感目标 |
|---|---|---|
| **M0 地基** | monorepo 脚手架；`~/raindown-home` 布局；brain 和 raw 仓库及 schema；资源注册表（录入两个产品）；知识库 MCP server；AGENTS.md 受管区块；密钥扫描 | 所有 harness 共享同一份背景 |
| **M1 内核 v0** | 账本、事件、调度；执行器插件：Claude Code、Codex（经 Orca）；卡住检测；supervisor 和 workspace 简报；最小策略引擎；sops + age 密钥提供器；收件箱（Telegram Bot，加 Web 版"需要我的"） | 不用再盯 Codex 终端 |
| **M2 运维闭环** | 能力插件：Gatus、Cloudflare、域名到期（Sentry、Stripe 待产品启用后再接）；Metric；运维分诊工作流；runbook 回写；Decision 和回看；Web 版"全局健康" | 不用再手动查看网站状态 |
| M3 | 知识 ingest 和 lint；随手记；热点雷达 | |
| M4 | 社媒（X） | |
| M5 | 完整迭代工作流、桌面端、插件视图、职能 workspace、参谋长、更多平台 | |

**MVP = M0 到 M2。** 完成标准：连续一周不用手动查看网站，也不用盯 Codex 终端。

**部署**：
- MVP 在 Mac 上单机运行，但中枢和节点从一开始就分成两个进程；服务器到位后再迁移中枢。
- Gatus 部署在常驻环境（小服务器或免费托管），即使 Mac 离线，也直接通过 Telegram 兜底告警（Gatus 自带 Telegram 告警）。

**MVP 不做**：
- 桌面端：用 Web 的 PWA 加 Telegram 代替；
- 职能 workspace 和参谋长；
- 插件视图、Notion 镜像、ACP；
- 多节点部署。

---

## 17. 技术选型

| 层 | 选型 |
|---|---|
| 语言与运行时 | TypeScript + Bun（保持与 Node 兼容）。为以后改用 Rust 预留接口，见下方"语言演进" |
| 仓库结构 | monorepo：`packages/kernel`、`packages/sdk`、`packages/web`、`packages/cli`、`plugins/*` |
| 存储 | SQLite（WAL 模式）+ Drizzle ORM；账本采用"只追加事件 + 投影表"；Metric 先存 SQLite |
| 持久化执行 | 自己实现：任务表 + 租约 + 心跳 + 重试；接口可替换 |
| 事件总线 | 进程内事件 + SQLite outbox |
| API | Hono + zod + SSE |
| Web | React + Vite + TanStack Router/Query + Tailwind + shadcn/ui，做成 PWA |
| 插件 | TS 模块，manifest 由 zod 校验；MVP 阶段在主进程里加载 |
| 执行器 | Claude Agent SDK（用 `canUseTool` 接入策略引擎）；`codex exec --json` 或 Codex SDK，交互场景走 Orca CLI；pi / oh-my-pi 的 SDK 或 RPC |
| Raindown MCP server | 向所有 harness 暴露知识库检索、提交任务、写 journal、提问用户等能力 |
| 直接调用模型 | Vercel AI SDK，费用记进账本 |
| 知识库 | Markdown + frontmatter（zod 校验）；qmd 检索；frontmatter 索引进 SQLite |
| 通知 | Telegram Bot，加 Web 收件箱 |
| 平台自身监控 | healthchecks.io 外部心跳；日志用 pino |

**语言演进**：
- 用户看重可靠性、资源占用和分发体验，同时也在学习 Rust。MVP 使用 TS；所有跨组件的契约都保持与语言无关：
  - 磁盘格式和配置用 JSON Schema 描述；
  - CLI 统一支持 `--json` 并有固定的退出码；
  - MCP 工具、插件协议，以及节点与中枢之间的协议，都用 JSON Schema 描述。
- 以后最可能先改成 Rust 的组件是**节点守护进程**：它要常驻多台机器，职责又很窄。开源以后，再评估把内核核心迁过去，换成"Rust 内核 + TS 插件宿主"的结构。

**用户数据目录布局**：

```
~/raindown-home/
  ├─ config/        # 角色、工作流、策略、插件配置，以及 sops 加密的密钥（git）
  ├─ brain/         # 主知识库（git）
  ├─ raw/           # 原始资料（git，大文件用 LFS）
  └─ state/raindown.db  # 账本（不进 git，定期备份）
```

---

## 18. 密钥方案

**工具**：默认使用 **sops + age**。以后可以通过 SecretProvider 接口补充 1Password 等其他提供器。

**原则**：

1. **配置里只存引用**，比如 `secret://cloudflare/zone-ezarouter`，由 SecretProvider 在运行时解析。
2. **Agent 碰不到明文**。密钥只在插件动作执行时注入；必须通过环境变量注入给 harness 时，只给这个任务需要的最小集合。
3. **最小权限的 token**。Raindown 自己使用的凭据单独申请只读或限定范围的版本，比如 Stripe restricted key 和按 zone 限定的 Cloudflare token，不复用部署用的主密钥。
4. **输出脱敏**。账本、journal、日志写入前，先匹配已知密钥值，再做 gitleaks 扫描。
5. **两类密钥分开管理**。Raindown 自己的凭据由 Raindown 管理；产品部署用的密钥（wrangler secrets、`.env.production-*`）仍由各产品自己的流程管理。Raindown 的 agent 执行任务时不得读取这些文件：worktree 不复制它们，harness 也禁止读取这类路径。

**age 私钥必须离线备份。** 私钥丢失意味着所有密钥都丢失。

---

## 19. M1 内核设计（2026-10-24 确认）

1. **进程形态**：中枢 `raindownd` 是 launchd 托管的守护进程，带外部心跳。节点是独立进程，用"租约 + long-poll"**主动向中枢拉取任务**。中枢和节点之间用 HTTP + JSON 通信，带 token 认证，协议用 JSON Schema 定义。
2. **账本**：只追加事件，任务、收件箱等由事件投影得到。任务状态为 `queued → running → verifying → done / failed / blocked / cancelled`。任务是一份合同（目标、上下文引用、workspace、角色、工作目录、验收命令、策略），结束时产出 `result.json`。
3. **执行器**：
   - **交互模式**：Codex 经由 Orca 运行，把现有的 dispatch 和 watch 脚本插件化，用于长时间的开发任务；
   - **无头模式**：Claude 用 Agent SDK，`canUseTool` 接入策略引擎；Codex 用 `codex exec --json`；用于分诊、审查这类短任务。
4. **卡住检测**：执行器持续上报活动信号，内核据此区分卡住的原因：等审批、提问、无输出、崩溃。卡住后任务转为 `blocked`，收件箱生成一条附带终端末尾输出的消息；用户的回复会被送回 worker。
5. **Supervisor**：每个 workspace 一个，被事件、任务结束或卡住、定时巡检唤醒。每次唤醒都是新会话，靠 workspace 简报恢复记忆。它只能通过 MCP 工具行动：建任务、提提案、问用户、写 journal。M1 的巡检是每天一次，输出报告。
6. **收件箱**：分 Interrupt、Decide、Digest 三级，推送渠道做成插件。
   - **首个渠道是 Telegram Bot**：Raindown 主动向 Telegram 拉取消息（long polling），中枢不需要被公网访问；
   - 通知里用内联按钮完成审批，回复消息就是给 worker 的答复；
   - 只接受用户本人的 chat id。

   ntfy 暂不采用。Web 端只做"需要我的"一页。
7. **开发任务的验收**：每个任务一个 worktree，走 PR 流程。验收顺序是 CI 通过 → Claude 审查 → 合并 → 确认 main 上的发布流水线成功。
8. **拆成 4 个变更**：
   - ① 账本、守护进程、节点协议；
   - ② 执行器和卡住检测；
   - ③ 收件箱、Telegram、Web 页、策略，以及 sops 密钥（Telegram token 是第一个需要保管的密钥，所以密钥提供器提前到 ③）；
   - ④ supervisor。

   ② 和 ③ 依赖 ①，④ 依赖 ② 和 ③。

   2026-10-25 追加 ⑤ Grok Bot 接入（`add-grok-bridge`，2026-11-11 按当前 main 更新）：Grok 经 Tailscale 官方插件访问中枢的远程 MCP 入口（独立端口，只经 `tailscale serve` 发布到 tailnet，不用 Funnel），身份固定为 `remote:grok`，只能读白名单 workspace、写提案、为派给它的任务上报；Raindown 经 routine webhook 向 Grok 派活，Grok 用 `raindown_report` 交回结果。Grok 不在本机运行，没有本机 worker 进程可隔离，不能用于 `isolation: required` 的角色。⑤ 依赖 ②、③、add-harness-neutral-coordination 与 add-worker-credential-isolation（均已合并）。

   **M1 验收场景**：用户在 Telegram 给 product-res 下一条指令 → supervisor 拆成任务 → Codex 在 worktree 中执行 → 卡住时用户收到推送并回复，worker 继续 → 提 PR → Claude 审查 → 合并 → 验证 main 的发布流水线 → 写 journal。整个过程中用户只操作两次手机。

9. **harness 无关的协调模型**（变更 add-harness-neutral-coordination，2026-11 合并）。中枢与 core 只认与 harness 无关的契约，Codex、Claude 等的差异全部封装在执行器适配器里：
   - **适配器自描述**：注册时声明能力（授权请求的识别方式、能否中途注入、能否恢复会话、是否加载 Raindown MCP、能否检测带外操作）。中枢按声明选择交互方式，不按执行器类型名分支。适配器还负责把授权请求转成统一结构、隔离 harness 自带的放行配置，并发现绕过 Raindown 的操作。
   - **worker 主动上报**：每次派工签发只授予本任务的派工令牌，worker 经受限的 Raindown MCP 调用 `raindown_report`，上报进展、带选项的提问、受阻、交付或放弃。节点把上报与适配器的推断合并，卡住记录来源（`reported` / `inferred`），只有 worker 上报的提问才委托 supervisor 代答。终端分类保留为兜底。
   - **派工与恢复**：任务可多次派工，重试作用于原任务而不是另建任务。新派工带结构化的恢复提示；写类开发任务的交付物已存在时，由中枢直接判定完成。
   - **授权依据**：策略有版本，任务创建时由中枢固化授权依据（mandate）；策略变化会通知受影响的任务，依赖被删规则的代批转交用户。
   - **用户原话直达 worker**：supervisor 建任务时，中枢附加用户的原始指令，worker 输入分"原始指令（以此为准）"与"supervisor 的补充"两段。
   - **observe 模式**：代答、代批、自主工作可以逐项只记录不执行，用一致率决定何时放开。
   - **PR 订阅与直通**：PR 上的 CI、审查与评论由中枢轮询入账，作为不可信上下文直接送到负责的 worker，不唤醒 supervisor。worker 目前与用户共用 GitHub 身份，所以评论恢复任务、交回 supervisor 暂不生效。
   - **阶段**：由账本派生"在等谁"，CLI、收件箱与 supervisor 状态的说法统一。

   接入新 harness 见 [executors.md 的适配器契约](executors.md#适配器契约)，supervisor 侧的行为见 [supervisor.md](supervisor.md) 第 2、3、8、13、14 节。
