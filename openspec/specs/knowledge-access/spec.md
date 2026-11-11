# knowledge-access Specification

## Purpose
规定人和各 harness 访问知识库的统一接口（CLI 与 MCP），以及按写入分级规则执行的写入操作，让 AI 能自由读取和记录，又不会把事实写脏。

## Requirements

### Requirement: 两种接口等价
每个知识访问操作 SHALL 同时以 CLI 子命令（`raindown kb ...`）和 MCP 工具（经由 `raindown mcp`，使用 stdio 传输）的形式提供，二者的输入、输出和权限规则 MUST 一致。MCP 调用方 MUST 声明一个操作者标识（角色名或 harness 名），用于提交记录与权限判断；CLI 默认的操作者是用户本人。

#### Scenario: CLI 与 MCP 结果一致
- **WHEN** 用同一个查询词分别调用 `raindown kb search` 和 MCP 工具 `kb_search`
- **THEN** 两者返回同样的条目，顺序也相同

### Requirement: 机器可读输出
所有 `raindown` CLI 子命令 SHALL 支持 `--json` 参数，输出结构与该操作对应的 MCP 工具返回值一致，并由仓库中的 JSON Schema 描述。退出码 MUST 遵循固定约定：`0` 表示成功，`1` 表示操作失败或校验未通过，`2` 表示用法错误，`3` 表示可重试的错误（比如写锁超时）。

#### Scenario: 脚本调用检索
- **WHEN** 运行 `raindown kb search 干支日 --json`
- **THEN** 标准输出只有一个符合检索结果 schema 的 JSON 文档，退出码为 0

#### Scenario: 写锁超时
- **WHEN** 写锁被长时间占用，此时运行 `raindown kb journal "..." --json`
- **THEN** 退出码为 3，输出的 JSON 中注明这个错误可以重试

### Requirement: 检索
系统 SHALL 提供对 brain 的全文检索，返回条目标识、标题、摘要和匹配片段，按相关度排序。检索 MUST 能正确匹配中文子串。

#### Scenario: 中文检索
- **WHEN** 检索"干支日"
- **THEN** 返回 frontmatter 或正文中包含"干支日"的条目，例如东方站的产品条目

### Requirement: 读取与结构化查询
系统 SHALL 支持按标识读取完整条目，以及按 frontmatter 字段过滤条目，例如 `type=domain owner=ws/xuanxue-saas`。

#### Scenario: 按字段查询
- **WHEN** 查询 `type=data-source owner=ws/xuanxue-saas`
- **THEN** 返回该 workspace 拥有的全部数据源条目

### Requirement: Workspace 简报
系统 SHALL 为指定的 workspace 输出一份简报，内容包括：workspace 描述、项目卡片摘要、所拥有的资源列表、最近 N 条相关 journal，以及可能过时的事实。输出长度 MUST 受一个可配置的字符预算限制，超出时按固定优先级截断，并注明省略了什么。

#### Scenario: 预算截断
- **WHEN** 以较小的预算请求 `ws/xuanxue-saas` 的简报
- **THEN** 输出不超过该预算，末尾注明被省略的部分

### Requirement: 追加 journal
任何操作者 SHALL 能直接追加 journal，无需确认。journal 写入 `brain/journal/<YYYY-MM-DD>.md`，每条记录带时间、操作者、关联的 workspace 和正文。

#### Scenario: agent 记录工作日志
- **WHEN** 操作者 `codex` 为 `ws/product-res` 追加一条 journal
- **THEN** 当天的 journal 文件末尾出现这条记录，并生成一次提交

### Requirement: 随手记
任何操作者 SHALL 能把一段文字写入 `raw/inbox/`，作为一个只追加、不修改的原始资料文件，并附带时间与来源（比如 `cli`、`mcp:claude`）。随手记 MUST NOT 直接写入 brain。

#### Scenario: 用户随手记
- **WHEN** 用户运行 `raindown capture "考虑给东方站加日语"`
- **THEN** `raw/inbox/` 下新增一个包含这段文字和元数据的文件，`brain/` 没有任何变化

### Requirement: 修改提案
AI 操作者对事实类条目（资源、`product`、`project-card`）的新增或修改 SHALL 以提案形式提交，不得直接写入。提案包含目标条目、完整的新内容、理由和出处，存放在 `state/` 下，等待确认。提交时系统 MUST 先校验新内容，校验不通过则拒绝。

#### Scenario: agent 修改域名条目
- **WHEN** 操作者 `claude` 提交提案，把某域名的 `registrar` 改为 `cloudflare`，并附上出处
- **THEN** 系统生成一个待确认的提案，brain 中的该条目暂时不变

### Requirement: 提案确认
用户 SHALL 能列出待确认的提案、查看与当前内容的差异，并逐个或批量接受、拒绝；拒绝时可以附一句理由。接受后系统写入 brain、生成提交、更新 index 与 log；拒绝时提案和理由会被保留，以供日后回顾。

#### Scenario: 批量接受
- **WHEN** 用户运行 `raindown kb proposals accept --all`
- **THEN** 所有待确认的提案依次写入 brain，每个提案对应 `log.md` 中的一条 `apply` 记录

#### Scenario: 目标条目已被改动
- **WHEN** 提案创建之后，目标条目又被用户改动过
- **THEN** 接受该提案时系统报告冲突，不予写入，并提示重新生成提案

### Requirement: AI 写入边界
AI 操作者 MUST NOT 直接修改 `decision` 条目和 `scope: personal` 的条目，也 MUST NOT 修改 `log.md` 中已有的行和 raw 中已有的文件。`runbook` 条目允许 AI 直接写入，但必须附出处，并记入 log。

#### Scenario: AI 试图改决策
- **WHEN** 操作者 `codex` 试图写入一个 `decision` 条目
- **THEN** 操作被拒绝，并返回"决策条目只能由用户写入"

#### Scenario: AI 更新 runbook
- **WHEN** 操作者 `claude` 带出处更新一个 runbook
- **THEN** 修改直接写入并提交，`log.md` 中记录该操作

### Requirement: 依赖中枢的操作
操作注册表 SHALL 包含任务操作：`task_create`、`task_list`、`task_show`、`task_cancel`，CLI 与 MCP 都自动获得对应入口。这些操作通过本机中枢的 API 执行；中枢不可用时 MUST 返回可重试的错误 `hub_unavailable`（CLI 退出码 3），并提示用 `raindown daemon status` 检查。CLI 与无任务绑定的 MCP 会话的知识库操作不依赖中枢，行为不变；任务绑定会话的知识库读取经中枢（见"任务绑定会话经中枢读取"）。

#### Scenario: 中枢未运行时建任务
- **WHEN** 中枢未运行，此时 agent 调用 `task_create`
- **THEN** 返回 `hub_unavailable`，且 `retryable` 为 true

#### Scenario: 中枢未运行时检索知识库
- **WHEN** 中枢未运行，此时未绑定任务的 agent 调用 `kb_search`
- **THEN** 检索照常返回结果

### Requirement: 任务绑定会话经中枢读取
任务绑定的 MCP 会话（使用派工令牌）的只读知识操作（检索、读取、结构化查询）SHALL 经中枢执行，worker 侧进程 MUST NOT 需要直接读取 raindown-home。结果与 CLI、无绑定 MCP 的同名操作一致（输入、输出与排序相同），可见范围不超过该任务所属 workspace 可见的条目。

#### Scenario: 隔离下检索
- **WHEN** 隔离下的 worker 调用 `kb_search`，worker 进程无法读取 raindown-home
- **THEN** 检索结果与用户运行 `raindown kb search` 同一查询词、限于该 workspace 可见条目的结果一致
