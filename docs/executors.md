# 执行器与角色

节点按任务合同的 `executor` 选择执行器，按 `role` 读取 `$RAINDOWN_HOME/config/roles/<name>.yaml`。
`raindown init` 补齐下面的三个默认角色，以及 ④ 新增的 `supervisor`（AI 主管，见 [supervisor.md](supervisor.md)）、`pr-reviewer`（只读 PR 审查，claude-sdk）、`merger`（合并，pr-merge 执行器）和同名提示词文件，已有文件不覆盖。

| 执行器 | 默认角色 | 适用场景 | 依赖与交互 |
| --- | --- | --- | --- |
| `codex-orca` | `dev` | 交互式的长开发任务，在独立 worktree 中修改、提交、推送并开 PR | Codex CLI、Orca CLI 和正在运行的 Orca 应用；用 gh 检查 PR；提问或审批时保持终端和租约 |
| `claude-sdk` | `reviewer` | 审查等无头任务，不需要盯着终端 | Claude Agent SDK、SDK 随包安装的原生 claude CLI 和 Claude 凭证；需要审批时挂起等待 |
| `codex-exec` | `triage` | 在只读沙箱中收集证据、做分诊 | Codex CLI 的 `exec --json` 和 `exec resume`；提问后结束一轮，回复后恢复同一会话 |
| `pr-merge` | `merger` | 合并已审查通过的 PR 并等待主分支流水线；不调用模型，只由中枢（或 user）创建 | gh；只能在本机节点运行，见下文「merger：pr-merge」 |

中枢和节点需要运行；前台命令分别是 `raindown hub start`、`raindown node start`，各占一个终端。
常驻方式见 [守护进程](daemon.md)。Orca 模式的仓库必须登记在合同所属 workspace 的 `repos` 中，
并已导入 Orca；节点还需要能访问远端仓库的 git、gh 环境。PR 只经 merger 角色（pr-merge 执行器）在核对资格后合并；Raindown 不清理 worker 的 worktree。

## 适配器契约

本节是接入新 harness 的指南（变更 add-harness-neutral-coordination，规范见其 `specs/harness-adapter`、`specs/worker-report`）。
每个 harness 的差异都封装在执行器适配器里；core 的类型、事件与操作不出现任何 harness 专有概念。
下文描述的是 main 上的实际实现。现有适配器的隔离范围和未解决的边界见下文「Codex 配置隔离」与「安全边界」，
不能把契约当作所有边界都已实现的声明。

### 插件接口

适配器实现 `packages/node/src/executor.ts` 的 `ExecutorPlugin`，节点的通用循环只调用这些方法：

| 成员 | 作用 |
| --- | --- |
| `type`、`mode` | 执行器类型（与合同 `executor` 一致）、`interactive` 或 `headless` |
| `adapterCapabilities` | 能力声明，见下一小节 |
| `taskInputs` | 是否把派工的 `ctx.inputs` 放进输入并由节点确认（缺省 true），见「PR 输入送达」 |
| `run(contract, ctx)` | 启动 worker，返回活动流、最终结果 `done`、`cancel`，可选 `deliver`（送达回复）、`inject`（运行中注入输入）、`bindBlocked` |
| `classify(snapshot)` | 从末尾输出等快照判定卡住原因；无法识别时返回 null |
| `prepare` | 节点启动、领取任务前清理上次残留 |

适配器经活动流报告两种状态信号：`data.idle === true`（worker 停下，可附 `data.hint`）与 `data.resumed === true`（worker 未经回复自行恢复）。
长时间无活动（`no_progress`）、进程意外退出（`crashed`）与超时由节点统一判定。
启动子进程必须使用 `ctx.env`（已去掉中枢凭证），不能直接传 `process.env`。

### 能力声明

适配器在节点注册时随 `type`、`mode` 上报五项交互能力与凭证隔离声明，中枢存入节点投影；旧节点没有上报时按最保守的取值处理，不按执行器类型名推断。

| 能力 | 取值与含义 | 当前谁读取、做什么 |
| --- | --- | --- |
| `approval_requests` | `structured`：由 SDK 或协议拿到授权请求；`inferred`：由适配器从输出推断；`none`：没有授权请求通道 | 只入账、展示；不改变中枢行为 |
| `inject_while_running` | 能否在当前运行中注入消息 | 中枢：为 true 时 PR 输入经续约下发给运行中的 worker，否则排队到下一次派工 |
| `resume_session` | 进程结束后能否继续同一个 harness 会话；重新挂接存活终端不算恢复 | 只入账、展示 |
| `raindown_mcp` | 是否加载任务绑定的 Raindown MCP，能否调用 `raindown_report`；只加载知识库 MCP 不算 | 节点：派工令牌文件写入失败时，声明为 true 的适配器以 `failed(lease_token_write_failed)` 结束本次派工，其余只记警告 |
| `out_of_band_detection` | 能否发现绕过 Raindown 的批准，以及会话、工作目录被外部移除 | 只入账、展示 |
| `credential_isolation` | `{layers, enforced}`：按角色沙箱设置声明的施加层（`seatbelt`、`native`、`separate_user`、`none`），以及当前是否已真正施加。见下文「凭证隔离声明」 | 只入账、展示（`raindown node list`）；后续用于 `isolation: required` 的派送 |

另一个注册字段 `task_inputs` 声明执行器会处理派工输入；中枢只对声明了它的执行器随派工下发 PR 输入，旧节点不声明，输入保持待送达。

中枢的交互方式只依赖声明与账本中的事实，不维护按执行器类型名区分的分支。目前中枢读取的只有 `inject_while_running` 与 `task_inputs`；
其余三项是如实的自我描述，供展示、验收与后续使用。声明不支持的能力，不能靠假定 harness 行为补足。
supervisor 是否代答提问看的是卡住的 `basis`（见下文「上报与推断的合并」），不是 `approval_requests`。

现有适配器的声明：

| 执行器 | approval_requests | inject_while_running | resume_session | raindown_mcp | out_of_band_detection | task_inputs |
| --- | --- | --- | --- | --- | --- | --- |
| `codex-orca` | inferred | false | false | true | true | true |
| `codex-exec` | none | false | true | true | false | true |
| `claude-sdk` | structured | true | true | true | false | true |
| `pr-merge` | none | false | false | false | false | false |
| `fake` | structured | true | true | false | false | true |

### 凭证隔离声明

`credential_isolation`（add-worker-credential-isolation 1.3）按角色的沙箱设置分别声明施加层，取值见 design D1：

| 执行器 | 沙箱设置（`roleSandboxSetting`） | 声明的施加层 |
| --- | --- | --- |
| `codex-orca`、`codex-exec` | `danger-full-access`（含 bypass） | `seatbelt` |
| `codex-orca`、`codex-exec` | `workspace-write`、`read-only` | `native` |
| `claude-sdk` | `bash-sandbox-off`（Raindown 目前不开启 bash 沙箱） | `seatbelt` |
| `claude-sdk` | `bash-sandbox-on` | `none` |
| `pr-merge` | `in-node` | `none` |
| `fake` | — | `none` |

- 角色的沙箱设置由 core 的 `roleSandboxSetting` 从角色配置推出：codex-exec 取 `permissions.sandbox`（缺省 read-only）；
  codex-orca 取 `permissions.sandbox`，其次 `permissions.config.sandbox_mode`，都没有时无法确定，按 `none` 处理。
  表中没有列出的设置同样按 `none`。查询用 `credentialIsolationFor`。
- **开关 `isolation.enforce`（`config/node.yaml`，缺省 false）关闭时全部适配器都是 `enforced: false`**：只声明将要支持的施加层，不施加任何隔离。
  开关打开（仅 macOS）后，codex-orca、codex-exec、claude-sdk 上报 `enforced: true`，并且**只保留已实现的施加层**：
  `seatbelt` 原样保留，尚未实现的 `native`（Codex permissions profile，tasks 5.1）改报 `none`，未实现的施加层不能显示为已施加。
  见下文「外层 seatbelt 施加」。
  `raindown node list` 在每个执行器后标出“仅声明，未施加”，不能读成已隔离。自检结果随注册另行上报（见下文「隔离自检探针」）；
  `credentialIsolationFor` 给出的 `enforced` 只有在适配器声明已施加、施加层不是 `none`、且该执行器 × 沙箱设置最近一次探针全部通过时才为 true。
- 旧节点不上报时投影中没有该字段，显示“未上报（按 none 处理）”，不影响派工。注册时沙箱设置的键与施加层都只校验格式：
  较新节点上报的未知施加层（例如将来的新取值）照常入账，`node list` 标为“未知，按 none”，`credentialIsolationFor` 按 `none` 处理，
  不会被当作已支持的隔离；格式不合法（非小写标识）返回 400。读取账本与投影时不合法字段逐项降级。
- `config.sandbox_mode` 的值按 TOML 解析，带引号（`'"danger-full-access"'`）时去掉引号再比较。codex-orca 经
  `config.profile` / `config.default_permissions` 间接指定沙箱、或没有任何沙箱设置时无法确定，按 `none` 处理，
  `raindown doctor` 对这类角色给出 info 提示与原因。

### 授权请求

适配器把原生授权请求转换成统一的 `PrecheckRequest`（`packages/node/src/precheck.ts`）：工具 `tool`、命令 `command`、路径 `paths`、
命令实际执行目录 `cwd`、`workdirTrusted`（只有适配器能可靠确定执行目录时才为 true），以及理由 `reason`（只随卡住上报，不送去判定）。
策略判定、supervisor 代批与推送只消费这个结构，不解析 harness 的原始输出；SDK 型和终端型适配器对同一个 `pnpm check` 应产生相同的结构，命中同一条规则。

流程：

1. 适配器在把请求交给人之前调用 `ctx.precheck`，节点向中枢 `POST /v1/policy/check`。只有明确、合法的 `auto` / `auto-report` 才在本地放行；网络错误、超时、响应不合规一律按需要人处理。
2. 其余档位上报 `blocked(awaiting_approval)`。档位为 `supervisor` 时，适配器把中枢返回的 `decision_id` 放进 idle 信号的 `hint.decision_id`；节点只认本租约最近一次预检的判定，随卡住上报节点自己记录的请求文本（`request{tool, command, paths, reason}`），不采信适配器的说法。
3. 续约确认卡住事件后，节点调用 `bindBlocked({seq, request_id})`，把账本里的卡住与适配器本地的请求 id 对应起来；回复按它送达原请求。
4. 送达批准前，适配器重新读取实时的待批请求并调用 `ctx.confirmApproval`；返回 false 时不得放行，`deliver` 返回 `dropped`，节点以 `no_delegate` 重新上报卡住。
5. `deliver` 必须按 `reply_id` 幂等；worker 已不在时返回 `not_running`，中枢让任务带着回复重新排队。

`workdirTrusted` 为 true 时节点才计算并上报 `command_cwd`、`push_env_ok`、`gh_env_ok`，带 `push_to` / `gh_scope` 条件的规则才可能命中。
codex-orca 拿不到 Codex 提权命令的实际目录，claude-sdk 的 Bash 会在调用之间保留 cwd，二者都不设置，所以推送与开 PR 目前不会委托给 supervisor。

### 上报与推断的合并

每次卡住都带 `basis`：`reported` 表示 worker 经 `raindown_report` 主动上报，`inferred` 表示由适配器的观察（`classify`、idle 信号、节点的无进展与崩溃判定）得出。
`inferred` 不等于"终端推断"：claude-sdk 的授权卡住来自 SDK 的结构化回调，但不是 worker 上报的，同样记为 `inferred`。
旧节点没有 `basis` 的卡住视为 `inferred`。

节点在续约中缓存最近一次未消费的上报。适配器报告 idle 时，question/blocked 上报优先，卡住来源为 `basis: reported`，
问题、选项、推荐项与 missing/tried 原样保留；没有可用上报时调用适配器分类并标为 `basis: inferred`。
任务已经 blocked（含推断判定期间）或在验收时到达的非终态上报针对的是当前这一轮：节点随下一次续约以 `report_seq`
立即确认消费，不缓存、不启动两分钟计时；worker 从 blocked 恢复运行时，节点丢弃并确认消费仍未使用的旧上报，
它不会在恢复后以旧问题再次转 blocked，也不会接管之后真正的 idle。
question/blocked 上报后 harness 仍忙超过两分钟时，也进入 reported blocked，并写 `task.report_conflict`；
progress 与超过阈值的空闲观察矛盾时，按适配器观察处理并记录冲突。ready/failed/dropped 直接结束派工，
其中 dropped 为带标记的 done；节点按 report_seq 确认消费，重试不重复生效。

`basis` 的用途：只有 `reported` 的提问会委托给 supervisor 代答，推断出的提问直接交给用户；授权委托另按策略档位判定（见 [supervisor.md](supervisor.md) 第 8 节）。
收件箱与 Telegram 显示来源，结构化选项成为回复按钮；`raindown supervisor report` 按执行器统计两种来源的比例，用来决定何时淘汰终端分类兜底。

### 隔离要求

适配器必须隔离 harness 的用户级及全局自动放行规则、自动审批器、hooks、额外 MCP 服务器与项目信任记录，
不得让这些配置削弱 Raindown 的授权。需要的配置只能来自角色配置与 Raindown 生成的配置。
登录凭证可通过符号链接共享，适配器不读取、复制或输出凭证内容。可见会话应有统一标识和任务 id，
例如 Orca 终端标题 `[Raindown] <task id>`，让用户能区分自己的会话和受管 worker。

现有实现：

- Codex（codex-orca、codex-exec 全部角色）：使用 Raindown 管理的 `CODEX_HOME`，每次启动覆盖 `config.toml`、清除 `rules/` 与扩展，只共享 `auth.json` 链接，见下文「Codex 配置隔离」。
- Codex 项目层：信任项目会加载其 `.codex/`（rules、mcp_servers、hooks、notify），所以 codex-orca 在启动、恢复、终端创建后、轮询及发送输入前都检查 worktree 中没有 `.codex`，发现即 `blocked(other)`（`project_codex_config`），只在确认不存在时才自动确认信任弹窗；同一仓库多个 worktree 共享信任状态等残余窗口见下文。
- Claude（claude-sdk）：只读角色、审查与 supervisor 会话 `settingSources: []`、`strictMcpConfig: true`、关闭 claude.ai connector；reviewer 模板同样不加载项目设置，见下文 reviewer 与 pr-reviewer 小节。
- 仍未隔离：系统层 `/etc/codex` 与 MDM、`~/.agents/skills`、项目级 `.agents/`。

### 带外检测

声明 `out_of_band_detection` 的适配器应关联待处理的请求与任务：Raindown 未送达回复而授权已执行或消失，
或工作目录、会话被外部删除或关闭时，经续约上报带外信号，中枢写 `task.out_of_band` 并在收件箱生成 Interrupt 条目。

- 带外批准：`approval_outside_raindown`（带命令文本），中枢同时以 `handled_externally` 关闭该任务待处理的授权条目，条目标题"授权在 Raindown 之外被批准"。
- 外部移除：`session_removed`，条目标题"工作目录或会话被删除"；目录丢失另报 `blocked(workdir_missing)`。节点在运行验收命令前发现工作目录不存在时也按此上报，不限于声明了该能力的适配器。

检测不撤销已执行的动作，也不把它补记为 Raindown 批准；任务按实际状态继续运行或卡住。
终端型适配器只应依据明确的批准/执行信号判定，不将输出暂时变化或请求暂时不可见直接当作授权完成。
codex-orca 在 `gh pr list` 等查询中改在登记仓库目录执行，worktree 丢失不影响 PR 查询；命令不存在与目录不存在分别如实说明。

### 派工令牌与任务绑定工具

加载 Raindown MCP 的 worker 必须绑定当前任务与派工（与 supervisor 的唤醒绑定是两套凭证，不能互相套用）：

- 中枢在派工时签发 `fls_` 前缀的派工令牌（与节点续约用的 `lease_token` 分离），只存在中枢内存、不入账本；中枢重启后全部失效，节点续约时补发。每次请求都重新核对租约仍有效、任务未结束、派工次数与角色一致、本次派工没有结束。
- 节点把令牌写入 `run/tasks/<task>/dispatch-tokens/<lease>.token`（各级目录 0700、文件 0600，原子替换），派工结束即删除。适配器只拿到 `ctx.leaseTokenFile` 路径。
- MCP 启动命令为 `raindown mcp --actor <role> --task <id>`，经 `RAINDOWN_LEASE_TOKEN_FILE` 传文件路径，不传凭证明文。MCP 启动时向中枢查询绑定；命令行的 task/workspace 只用于核对，不一致时拒绝启动。
- Codex 由 worker 进程环境向 MCP 透传路径（见下文「Codex 进程环境中的凭证路径」）；Claude 只在 MCP 子进程环境中设置路径。

任务绑定的 MCP 只列出六个工具（`taskBindingAllows`，`packages/core/src/ops/binding.ts`）：`raindown_report`、`task_show`、`event_get`、
`kb_search`、`kb_get`、`kb_query`。`task_show` 与 `raindown_report` 只能针对本任务；`event_get` 由中枢限制为本任务、同 workspace 的事件，
以及直通给本任务的 PR 事件，越界与不存在都返回 `not_found`。observe 判断、未执行的自主动作与 `inbox.*` 事件对 worker 不可见。
没有 `task_create`、`task_reply`、知识写入或其他写类工具；未绑定的 CLI 会话和 supervisor 唤醒会话沿用各自的工具清单，不列出 `raindown_report`。
工具全名带 `mcp__raindown__` 前缀。

审批：Codex 的 Raindown 服务器设 `default_tools_approval_mode = "approve"`，整体免审批；claude-sdk 的 worker 会话自动放行
`raindown_report`、`task_show`、`kb_search`、`kb_get`、`kb_query`，`event_get` 对只读角色按绑定放行、对写类角色仍经审批。
这些只覆盖任务绑定 MCP 暴露的工具，不放行 shell 或其他授权动作。

**Codex 进程环境中的凭证路径。** codex-orca 与 codex-exec 的 Codex 进程环境带有 `RAINDOWN_LEASE_TOKEN_FILE`：
MCP 配置的 `env_vars` 只能从 Codex 自身环境透传。模型执行的 shell 命令看不到它，依赖的是 Codex
`shell_environment_policy` 的默认排除项（`*KEY*`、`*SECRET*`、`*TOKEN*`）。为防止角色配置用
`ignore_default_excludes = true` 或改写 `exclude` 把它重新暴露，适配器在角色配置之后追加
`-c shell_environment_policy.ignore_default_excludes=false` 与 `-c shell_environment_policy.exclude=[…]`：
固定排除项为上述三项加 `RAINDOWN_LEASE_TOKEN_FILE`，角色自己的 `exclude`（可解析的字符串数组）合并保留。

### 结构化上报：`raindown_report`

worker 用 `raindown_report{status, summary, …}` 告诉 Raindown 自己的状态；角色提示（dev、reviewer 模板与 claude-sdk 追加的约定）要求优先用它提问和报告完成。

| status | 必填字段 | 节点如何处理 |
| --- | --- | --- |
| `progress` | — | 只记录；与空闲观察矛盾时按观察处理并记冲突 |
| `question` | `question`、2–8 个 `options{label, description}`（标签不重复）、`recommended`（必须是某个标签） | worker 停下时转 `blocked(question)`，`basis: reported` |
| `blocked` | `missing`、`tried` | 转 `blocked(other)`，`basis: reported` |
| `ready` | `deliverables`（1–5 个 PR 地址） | 结束派工；交付物合入结果 |
| `failed` | `reason` | 以 `failed(worker_failed)` 结束，原因记入 `result.reported_reason` |
| `dropped` | `reason` | 以带 `result.dropped` 标记的 done 结束，不进收件箱、不唤醒 supervisor |

- 只接受当前有效派工的令牌，调用者身份始终取自令牌。上报本身不改变任务状态，由节点消费后经续约或完成协议提交。
- `ready` 的交付物由中枢用 `gh pr view` 核实：仓库与任务的 `repo_snapshot` 一致、head 分支等于登记的任务分支、不是 fork。
  缺少任务分支返回 `branch_unknown`，只有分支不一致返回 `deliverable_branch_mismatch`；其他失败只返回通用的 `deliverable_check_failed`，不泄露 gh 的诊断。
- 限额：请求体 32 KiB；每个派工同时只处理一个上报（`report_busy`）、每分钟 10 次、每次派工 200 次（`report_rate_limited`），都可重试。
- `handback{pr_event_seq, reason}`：把一条名单内人类的 PR 评论交回 supervisor，见 [supervisor.md](supervisor.md) 第 13 节。当前共享 GitHub 身份下没有评论满足条件，交回一律返回 `handback_invalid`。

协议细节（消费水位、`task.report_consumed`、complete 引用 `report_seq`）见 [hub-auth.md](hub-auth.md) 的「上报与节点消费」。

### 分支归属

**只有创建并拥有任务分支的适配器报告分支。** 适配器只能报告自己为本任务创建的分支：codex-orca 在创建 worktree 与专用分支后、
启动 worker 前等待 `ctx.reportBranch({branch, worktree, repo})`，供节点采集仓库快照并经续约写入 `task.branch_reported`。
codex-exec 与 claude-sdk 在给定工作目录中运行、不创建分支，当前分支通常是 `main` 或用户自己的检出，**不报告分支**；
中枢只接受拥有分支的执行器（当前为 codex-orca）写入 `task.branch_reported`，新适配器只有在自己创建分支时才能加入。

策略含义：任务分支一经记录不可改写，并且是 `push_to: task_branch` 与 `gh_scope --head` 放行推送、开 PR 的依据，
也是交付物核对、"交付物已存在"判定、PR 订阅与合并资格的依据。若把用户检出的无关分支（甚至默认分支）当作任务分支，
worker 就能向它推送或以它开 PR；worker 新建分支开出的 PR 又因 head 不一致永远无法 `ready`。因此宁可留空：
`ready` 的交付物核对在缺少任务分支时返回 `branch_unknown`，PR 不是从登记分支开出时返回 `deliverable_branch_mismatch`
（提示中给出登记分支）；两种情况下 worker 都不应反复提交 ready，应改用 `blocked` 写明分支情况与已尝试的办法。
detached HEAD 或其他无法确定分支的情况同样不伪造报告，也不能用任务 id 代替。

**交付物已存在。** 写类开发任务卡在 `crashed` 或 `workdir_missing` 时，中枢在**登记仓库**中查询任务分支上的 PR：
同仓库、非 fork、head 为任务分支、非草稿的 OPEN 或 MERGED，并且创建于首次派工之后或已由本任务记录。找到时以 `task.done`
结束任务（`completed_via: existing_pr`），否则保持 blocked 等待重试或取消。唤醒、审查与合并任务不适用；之后仍要经过审查与合并资格检查。

### 恢复提示

任务在中断后重新派工（租约过期、节点失联、`crashed`/`node_lost` 卡住后重试）、经 `task_retry` 主动重试，或已结束任务因 PR 评论恢复（`task.requeued`）时，中枢在派工中附
`ctx.recovery = {previous_end{attempt, reason, ended_at?, last_report?, blocked_reason?, message?}, reported_branch?, prs[]}`。
普通的提问回复沿用原任务输入，不附恢复提示。`prs` 只取账本中本任务结果里的 PR，不采信临时活动或终端文字；设计中的 `pushed_sha` 尚未提供。

适配器调用 core 的 `renderRecoveryPrompt` 原样放在派工输入最前面，不自行改写：模板说明这是同一任务的新一次派工，
把事实放进转义过的 `<untrusted-recovery-facts>` 数据块，并要求 worker 先核对工作目录、git 历史、远端推送与 PR 的实际状态，
不重复 push、不重复开 PR；工作目录丢失时说明情况并停下，不静默新建目录。
codex-orca 新终端写进任务说明，重挂接存活终端时随恢复提示敲入；codex-exec 与 claude-sdk 放在首条输入的开头。

### PR 输入送达

PR 直通的内容（见 [supervisor.md](supervisor.md) 第 13 节）由中枢统一渲染为 `<untrusted-pr-event>` 数据块，适配器不得改写或解包：

- `inject_while_running: true` 的适配器实现 `inject(input)`，按 `input_seq` 幂等，返回 `delivered`（节点下一次续约确认 `task.input_delivered`）、
  `not_now`（例如正停在授权弹窗，中枢下一次续约再给）或 `not_running`（留到下一次派工）。注入不解除 blocked，也不能当作授权回复；任务卡住期间中枢扣留输入。
- 其他适配器从 `ctx.inputs` 取任务未运行期间到达的输入，用 `renderTaskInputs` 放在派工输入开头、恢复提示之后；节点确认后才记为送达。
- codex-orca 只在"回合结束后的普通空闲输入框、且尚未上报停下"的极短窗口里能安全敲入文字，因此如实声明不支持运行中注入；
  新终端从任务说明读取派工输入，重挂接已有终端时随恢复提示送入。它任何敲入文字的送达（恢复提示、文字回复、派工输入）都要求终端最后几行是 Codex 输入框，
  最后一行是 shell 提示符时不发送任何按键。

### 原始指令与 worker 输入

所有适配器用 core 的 `renderWorkerTaskPrompt` 生成任务来源部分，分两段："用户原始指令（以此为准）"放中枢附加的
`origin_instruction`，"supervisor 的补充"放 `goal`；两段都是转义过的数据块，没有原始指令时明确写出。
原文被截断时，读取指针改写为本任务的 `task_show section=instruction`，worker 经任务绑定工具读取全文。规则见 [supervisor.md](supervisor.md) 第 2 节。

### 新 harness 接入清单

1. 实现 `ExecutorPlugin`，按真实行为声明五项能力与 `task_inputs`；验证节点注册、中枢按声明选择送达方式，并覆盖不能注入、不能恢复等声明的限制。
2. 将原生授权转换为 `PrecheckRequest`，先预检再上报；验证相同请求命中相同策略，批准、拒绝和文字回复经 `bindBlocked` 送达原请求，`confirmApproval` 拒收时不放行。
3. 盘点用户、项目、系统配置及扩展加载来源，隔离规则、审批器、hooks、MCP 和信任记录；用临时凭证路径验证符号链接，不读取真实凭证。
4. 声明 `raindown_mcp` 时注入任务绑定 MCP，只传令牌文件路径，确认 worker 的 shell 看不到该路径，工具清单只有上述六个；在角色提示中要求用 `raindown_report`。
5. 只在自己创建分支时调用 `reportBranch`；把 `ctx.recovery` 与 `ctx.inputs` 用 core 模板放在输入开头。
6. 验证会话标识、恢复身份、目录丢失与带外操作；支持检测时，检查事件关联和用户通知，以及任务按实际状态恢复或卡住。
7. 记录已验证版本、真实 harness 证据与尚未覆盖的边界；若加载来源尚无法隔离，应明确限制，不能宣称完整满足隔离契约。

## Codex 配置隔离

Raindown 启动的所有 Codex worker（`codex-orca` 和 `codex-exec` 的全部角色）都显式使用 Raindown 管理的 `CODEX_HOME`，
不加载用户 Codex 目录中的配置、放行规则、MCP 服务器、hooks、notify、项目信任表和全局 `AGENTS.md`。
用户级的模型、provider 等设置也不会继承；角色需要的设置写在 `permissions.config`（经 `-c` 传入），
模型与推理强度也可以用角色的 `model` / `effort`。

- 有效类别为 read 的 `codex-exec`：`<raindown-home>/run/executors/codex-exec/codex-read-home/`；
- `codex-orca`：`<raindown-home>/run/executors/codex-orca/codex-home/`；
- 其他 `codex-exec`（写类角色）：`<raindown-home>/run/executors/codex-exec/codex-home/`。

#### `run/` 目录

worker 需要访问的节点运行目录放在 raindown-home 下的 `run/`，与 `state/` 分开，使隔离可以整体拒绝 `state/`
（add-worker-credential-isolation D2；被拒目录内放行单个路径还需要逐级祖先元数据规则，见「隔离实测」）：

- `run/executors/<执行器>/<harness 子目录>/`：执行器级的 harness 目录，目前是上面的 CODEX_HOME；
- `run/tasks/<任务>/dispatch-tokens/<租约>.token`：任务私有目录中的派工令牌；
- `run/tasks/<任务>/review/<node-id>/`：claude-sdk 审查任务的私有目录（`worktree/`、`pr.diff`、`meta.json`）。

各级目录 0700。任务结束、审查清理与节点启动清理后，变空的 `run/tasks/<任务>/` 被删除（只用 rmdir，不递归删除内容）。
节点自己的任务状态（任务说明 `spec.md`、`orca.json`）、唤醒令牌、日志与锁仍在 `state/`。

隔离清单（core 的 `computeIsolationSpec`）对 raindown-home 整体拒绝、只保留 `run/`（覆盖 `state/`、`config/`、`brain/`、`raw/`、
根目录文件与将来新增的子目录），再在 `run/executors/` 只保留本执行器、在 `run/executors/<执行器>/` 只保留本次的 harness 子目录
（codex-exec 的读角色 `codex-read-home` 与写角色 `codex-home` 互相读不到）、在 `run/tasks/` 只保留本任务。
保留目录必须是真实的直接子目录，是符号链接时报错（`isolation_keep_symlink`），任务 id、执行器名必须是单个安全的路径段。
存在的遗留数据目录（`FLOW_HOME`、`RAINDOWN_HOME`、`~/flow-home`、`~/raindown-home` 中不是本 home 的那些）一并拒绝。
age 私钥目录（`~/.config/sops/age/`）若被配置成用户主目录或其上级，返回 `isolation_age_key_dir_too_broad`，需要把私钥放进单独目录。
只读语义显式写成写拒绝：派工令牌、`access: read` 的 harness 目录，以及只读角色的工作目录。
共用同一 CODEX_HOME 的 codex-orca 任务之间会话记录仍可读，属于 design Risks 中登记的已知残留。

codex-orca 的终端命令以 `"$(cat state/tasks/<id>/spec.md)"` 把任务说明作为第一条消息传入。施加外层 seatbelt 时（tasks 4.2），
spec.md 只能由沙箱外的外层 shell 读取，`sandbox-exec` 只包裹 `codex` 本身；`state/` 下的路径不能出现在 worker 的允许清单里，
`computeIsolationSpec` 对位于 `state/` 下的工作目录返回 `isolation_allow_in_deny`。

升级迁移：节点启动时（持有节点锁之后）把旧位置 `state/codex-orca-home`、`state/codex-exec-home`、`state/codex-read-home`
在同一文件系统内 rename 到新位置，并在旧位置留下指向新位置的符号链接，升级前启动的存活 Codex 终端因此仍可用、仍能按真实路径重挂接。
迁移幂等：旧位置已是链接或不存在时跳过。新旧位置同时存在或 rename 失败（例如跨文件系统）时，记警告并继续使用旧位置，登录状态与会话不丢失；
修复后下次启动再迁移。旧位置的派工令牌不迁移：节点重启后所有租约凭证都已失效，启动清理同时清理 `run/tasks/` 与 `state/tasks/` 中的令牌文件。
确认没有使用旧路径的存活终端后，可以删除 `state/` 下这三个链接。审查目录不迁移：启动清理同时清理旧位置 `state/review/<node-id>/` 的残留。

降级（回到不认识 `run/` 的旧版本）：先停止节点并关闭仍在运行的 Codex 终端，然后对三个目录分别删除旧位置的链接、把目录移回去，例如
`rm state/codex-orca-home && mv run/executors/codex-orca/codex-home state/codex-orca-home`
（`codex-exec-home` 对应 `run/executors/codex-exec/codex-home`，`codex-read-home` 对应 `run/executors/codex-exec/codex-read-home`）。
`run/tasks/` 中只有派工令牌与审查残留，旧版本启动时不会使用，可以直接删除。

目录按执行器及只读用途固定，保留会话记录供 `exec resume <session id>` 和 Orca 终端重挂接使用，
无需按任务清理会话目录，同时减少不同适配器之间的配置污染。并发任务由 Codex 的会话 id 区分，
无需为每个角色复制目录。旧的 `codex-work-home` 不再使用，也不自动迁移其中的会话。
Orca 在任务状态中记录启动时的隔离目录，只重挂接使用同一隔离目录的终端（比较规范化后的路径）；
升级前的存活终端若缺少该记录或仍使用旧目录，以 `failed(codex_home_mismatch)` 拒绝接管，
需要先关闭旧终端后重试。codex-exec 恢复旧目录中的会话时，若明确报告该会话不存在、且尚无执行事件，
会在同一次派工内使用原任务提示（角色、目标、上下文）和用户回复新建一次会话；其他错误不自动重试。
升级后确认没有仍使用旧目录的存活终端或进程时，可以删除 `state/codex-work-home`；不会自动迁移或删除旧会话。
若旧目录的 `auth.json` 已被刷新为普通文件，先按下文确认并合并凭证，再删除目录。
句柄失效后的替换终端还须匹配已记录的 pty/incarnation 身份；
缺少原身份时持续重试，交给节点的无进展检测处理，避免误接用户另开的 Codex。用户目录中的旧会话不会复制到隔离目录。

每次启动前，Raindown 原子覆盖隔离目录中的 `config.toml`（基础文件只有注释，不含用户 MCP、notify、hooks、信任记录或 `auto_review`），
并清除其中的 `rules/` 和 Raindown 不生成的扩展。清除而非保留的原因是：这里属于 Raindown 的运行状态，
上次任务积累的“总是允许”规则不能授权下个任务。`approvals_reviewer=user` 的命令行默认行为保持不变，
角色显式配置仍优先。

`codex-home.ts` 为每次启动生成独立的 `-c mcp_servers.raindown=...` 配置层，只配置一个任务绑定的 Raindown MCP。
任务 id、角色与凭证路径不写入共享 `config.toml`，避免并发任务覆盖彼此的绑定，原 CODEX_HOME 会话目录仍可恢复。
codex-orca 重新挂接存活终端时还核对启动时的派工凭证路径；新派工路径不同或旧记录没有绑定时，
先关闭已核实身份的旧终端，再保留原 worktree 与分支启动 worker，避免继续使用已失效的旧派工 MCP。
`codex-read-home` 同样注入：只读 worker 也需要提问、说明受阻或报告无需处理；任务绑定工具集不授予知识写入或建任务权限。
该服务器设置 `default_tools_approval_mode = "approve"`，防止上报再次触发 Codex MCP 审批；
不修改其他工具、shell 的 approval_policy、approvals_reviewer 或沙箱配置。配置语义见官方 [MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)。

唯一共享的用户文件是 `auth.json`：来源取节点/worker 环境的 `CODEX_HOME`，缺省 `~/.codex`。
Raindown 通过临时符号链接加 rename 原子替换，避免并发启动时短暂丢失链接；不读取、复制或输出凭证内容。
源目录没有 `auth.json` 时不创建链接，也不回退加载用户配置。Codex 原地刷新凭证可能写回源文件；
若它将隔离目录中的链接替换成普通文件，Raindown 保留该文件并报 `codex_home_failed`，提示确认合并凭证后再删除。
用户 `CODEX_HOME` 指向隔离目录（含真实路径相同的别名），或隔离目录本身是符号链接时同样拒绝启动，避免改写用户目录。

Codex 0.166.0 实测（2026-11-06，全部使用临时 HOME、CODEX_HOME 和 git 仓库，无真实凭证或模型请求）：
通过 `codex app-server --stdio` 的 `config/read`（`includeLayers: true`）、`thread/start`，
以及 `RUST_LOG=codex_core::exec_policy=debug` 观察实际配置层和规则加载路径；
用临时无效规则产生带文件路径的解析警告来定位来源，另用有效规则确认隔离目录本身的规则仍会加载。
`execpolicy check --rules <路径>` 只检查显式文件，不用于证明自动加载来源。

| 临时环境条件 | 项目配置 | 实际加载规则 |
| --- | --- | --- |
| 原模拟用户 CODEX_HOME，项目未受信任 | 禁用 | 模拟用户 `rules/` |
| 改用隔离 CODEX_HOME，项目未受信任或无信任记录 | 禁用 | 0 个文件 |
| 隔离 CODEX_HOME，项目受信任 | 生效 | 项目 `.codex/rules/` |
| 隔离 CODEX_HOME 自身残留规则，项目未受信任 | 禁用 | 隔离目录 `rules/` 仍生效，故每次启动必须清理 |
| linked worktree，仅信任主仓库 | worktree 配置生效 | worktree 的 `.codex/rules/` 也加载 |

真实 TUI 中，首次信任弹窗默认选中 `Trust and continue`；按 Enter 后，同一个进程改用项目配置的模型，
在隔离 config 写入 canonical 仓库路径的 trust 记录，并报告项目规则文件的解析警告。
因此 **codex-orca 自动确认信任会激活项目配置和规则**，即使启动前清空了隔离目录的信任表。
这是 #68 审查留下的项目层风险：信任后，项目 `.codex/` 中的 `rules`、`mcp_servers`、`hooks`、`notify`
可能影响授权或执行额外程序，不能仅靠隔离用户配置防止。

本次在 Codex 0.167.0 复测（2026-11-06）：临时 HOME、CODEX_HOME、RAINDOWN_HOME 与 git 仓库，
使用手写的非秘密占位 API key，不读取真实凭证、不提交模型请求。项目配置只设置探针模型，另放一个无效 rules 文件。
以 `codex --no-alt-screen -C <临时仓库> -a on-request -s workspace-write` 启动，弹窗仅提供
`Trust and continue` 与 `Back to Agent Command Center`；Esc 返回空的任务中心，没有不信任/只读继续 worker 的选项。
重新启动后按 Enter，同进程显示探针模型，F2 警告指向项目 `.codex/rules/`，隔离 config 中写入 canonical 仓库信任路径。
因此不采用方案 A；方案 B 在任何信任交互前拒绝已有项目配置，且不依赖当前版本是否展示或能识别信任弹窗。
0.167 的返回选项与旧 fixture 不同；现已按实测完整布局补充识别（标题、问句、两个选项及匹配页脚），未知布局仍交用户处理。

本次采用检查方案（B）：codex-orca 启动及恢复前要求 worktree 中有普通文件或目录形式的 `.git`，
缺失或无法确认时以 `blocked(other)`（`worktree_git_missing`）说明原因，不启动 Codex，避免它向上加载祖先仓库配置。
每次启动、恢复、终端创建后、监控轮询及发送输入前，都以 lstat 检查 `.codex`；发现目录、文件或悬空链接，
或无法确认其不存在时，以 `blocked(other)`（`project_codex_config`）说明原因，并关闭本次已接管的终端。
运行中出现配置后，停止自动信任、策略预检与批准；预检/批准复核期间出现配置也不能发送按键。
只有未发现 `.codex/` 时才自动信任；向信任弹窗发送 Enter 前仍复查，不读取或删除项目配置内容。
重新挂接后终端仍停在信任弹窗时，拒绝把用户回复和 Enter 送入弹窗，避免回复意外成为信任确认。

残余窗口：同一仓库的多个 worktree 共享信任状态；A 的信任可能让 B 跳过弹窗。
创建终端后复查可以发现此时已出现的配置，但不能撤销 Codex 在启动与复查之间已经加载的配置或执行的 hooks。
运行中轮询的默认间隔为 30 秒，配置出现到下一次检查之间仍有窗口；发送前复查也不消除最后一次检查与使用之间的竞态。
这些检查不能阻止同一用户或 worker 随后创建、替换文件。未验证外部修改规则后当前线程会自动热重载，不能据此作此断言。

以下来源仍未隔离，属于后续工作：

- 系统层 `/etc/codex` 与 MDM：系统策略不受 `CODEX_HOME` 控制，可能改变权限或配置。
  处理它们需要部署侧管理权限，本次不由适配器改动，也不能据此声称全局配置已完全隔离。
- `~/.agents/skills`：可能引入用户指令或脚本，不随 `CODEX_HOME` 隔离。
  需要独立的 skills 发现与执行隔离方案，本次不扩大到该范围。
- 项目级 `.agents/`（`skills` 与 `plugins/marketplace.json`）未检查：skills 可引入指令及脚本，但执行权限仍由角色的审批与沙箱设置决定；marketplace 只是插件发现清单，项目启用配置仍在已检查的 `.codex/config.toml`，因此直接通过配置绕过授权的影响有限。仍存在提示注入等风险，不能视为已隔离。来源见官方 [skills](https://learn.chatgpt.com/docs/build-skills) 与 [项目插件启用配置](https://developers.openai.com/plugins/build/plugins#enable-or-disable-a-plugin-for-a-repo)。

这些措施隔离配置继承，不是操作系统沙箱；同一系统用户下的文件改写、检查与使用之间的并发竞态（TOCTOU），
以及具备文件和命令权限的 worker 自行写入配置，仍受现有权限与部署边界约束。
官方行为说明见 [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic) 和
[Rules](https://learn.chatgpt.com/docs/agent-configuration/rules)；升级 Codex 后应复测。

## doctor 检查

在**节点实际使用的环境**中运行：

```sh
raindown doctor
raindown doctor --json
```

| 检查标识 | 检查内容 |
| --- | --- |
| `tool.codex` | PATH 中的可执行文件、`codex --version` 的退出码与版本；最低验证版本 `0.164.0` |
| `tool.orca` | PATH 中的可执行文件、`orca --version` 的退出码与版本；最低验证版本 `1.4.218` |
| `orca.app` | `orca terminal list --json` 返回成功信封和 terminals 数组；失败时提示启动 Orca 应用 |
| `tool.claude-sdk` | 能 import `@anthropic-ai/claude-agent-sdk`、存在 query 导出、包版本可解析；从 `@raindown/node` 的 package.json 位置解析 SDK，并读取其中声明的期望版本 |
| `tool.claude` | SDK 默认使用的当前平台原生 CLI 文件存在且可执行；PATH 上另装的 claude 不会替代缺失的 SDK 原生包 |
| `claude.credentials` | `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN` 之一非空，或 Claude 配置目录下存在 `.credentials.json` |
| `role.<name>.creatable_by` | 角色的 `creatable_by` 缺省或为 `[]` 时给 info 提示：仅 user 可创建该角色的任务（见下文） |
| `isolation.<节点>.<执行器>.<沙箱设置>` | 经中枢读取各节点上报的隔离自检结果：不通过为 warning，未探测为 info，中枢不可用时给一条 `isolation.probe` info（见「隔离自检探针」） |

Claude 配置目录取 `CLAUDE_CONFIG_DIR`，否则取用户目录的 `.claude`。凭证只查存在性，
不读取文件内容、不输出变量值、不运行 claude、不发起 API 调用；不能确认过期、权限或订阅额度。
macOS 登录可能仅在 Keychain 中：没有上述来源、但存在系统 security 命令时，报告 warning、请人工确认，
不访问 Keychain 凭证。其他平台缺少来源时按依赖缺失处理。

严重度按已成功加载的角色计算，消息会列出引用角色：

- 被引用的执行器缺少依赖、版本命令失败或输出无法解析：`error`，doctor 退出码 1；
- Codex / Orca 低于最低验证版本：`warning`，建议升级，不单独导致非零退出；这一下限来自现有实测 fixture，不代表历史版本一定不可用；
- 没有角色引用的执行器：`info` 并跳过探测；Codex 被 `codex-orca` 或 `codex-exec` 任一角色引用就需要检查；
- 角色的 `creatable_by` 缺省或为空数组：`info`，不影响退出码；
- 原有的目录、git、gitleaks、角色配置错误仍为 `error`。只有 info / warning 时退出码为 0。

`raindown init` 默认生成三个真实角色，所以刚初始化的环境会要求全部依赖。
仅用 fake 的测试环境可以移除临时目录中的默认角色 YAML，改为 fake 角色。
每条外部探测命令有 10 秒超时；测试通过注入命令执行、二进制查找与 SDK 探测来运行，不依赖 CI 安装这些工具。

## 谁能创建该角色的任务：`creatable_by`

角色 YAML 可选字段 `creatable_by` 列出除 `user` 之外允许创建该角色任务的身份，中枢在创建任务时校验
（规则、错误码和生效时机见 [中枢鉴权的角色创建权限](hub-auth.md#角色创建权限creatable_by)）：

```yaml
creatable_by:
  - reviewer        # 精确值：reviewer 执行器（raindown mcp --actor reviewer）的身份
  - "agent:claude"  # 精确值
# - "*"            # 任意非 user 身份
```

- `user` 永远可以创建；字段缺省时只有 `user` 可以创建，AI 和节点会得到 403 `role_not_allowed`。
- 默认模板：dev 只列 `supervisor`（除 user 外只有 supervisor 能派发开发任务，其他 AI 与节点不能借 dev 跳过审批和沙箱；
  升级前生成的 dev.yaml 需手动补上，见 [supervisor.md](supervisor.md) 第 12 节）；reviewer、triage 为 `["*"]`，
  任何非 user 身份都可以拆出审查、分诊子任务。
- 本机 AI 的身份由执行器设置的 `RAINDOWN_ACTOR=<角色名>` 声明（受管 MCP 同样以 `--actor <角色名>` 启动）：reviewer 执行器的身份是 `reviewer`，不是 `node:*`。
  要只放开某个执行器，写它的角色名，例如 `creatable_by: [reviewer]`。
  任务绑定的 MCP 不提供 `task_create`（见上文「派工令牌与任务绑定工具」），worker 不能经受管 MCP 建任务；
  `creatable_by` 约束的是 supervisor，以及经 CLI 或未绑定 MCP 声明 AI 身份的调用方。
- 节点 token 和 remote token 在本机端口都不能创建任务（`scope_denied`、`remote_not_allowed`），`*` 不会放开它们。
- `raindown init` 不覆盖已有角色文件，升级前创建的 reviewer、triage 没有这个字段（只有 user 能创建），
  需要时手动补上；`raindown doctor` 会对缺少字段的角色给出 info 提示（不是错误，不影响退出码）。
- 给高权限角色（例如跳过审批的 dev）加 `creatable_by` 等于允许这些身份间接取得该权限，应和 `permissions` 一起审查。

## 默认角色

### dev：codex-orca

`config/roles/dev.yaml`（提示词来自同目录 `dev.md`）：

```yaml
# creatable_by 只列 supervisor：除 user 外只有 supervisor 能创建 dev 任务（其他 AI 与节点不能借 dev 提权）。
name: dev
executor: codex-orca
model: gpt-6.1-sol
effort: high
prompt: dev.md
creatable_by:
  - supervisor
permissions:
  approval: never
  sandbox: danger-full-access
```

`approval` 对应 Codex 的 `-a` 审批模式，`sandbox` 对应 `-s` 沙箱模式。
这两个默认值组合会变成 `--dangerously-bypass-approvals-and-sandbox`，沿用用户原来的脚本做法。
`permissions.config` 是额外的 Codex `-c key=value`，值支持字符串、数字和布尔值。
它会影响 Codex 的实际权限和行为，应与审批、沙箱字段一起审查。
`approval` 未设置或不为 `never` 时，Raindown 在角色未显式配置 reviewer 的情况下默认传入 `-c approvals_reviewer=user`，
确保授权请求交给 Raindown；用户级 `auto_review` 也通过隔离目录排除。
未传 `-a` 时，Codex 使用隔离环境及角色 `permissions.config` 中的审批策略。
角色的 `permissions.config.approvals_reviewer` 可覆盖这个默认值；Raindown 不修改用户的 Codex 配置文件。
Codex profile（`profile=...` 或 `-p`）中的同名设置可能覆盖顶层 `-c`，该优先级尚未验证。

收紧权限时可以另建临时角色 `dev-approval.yaml`，并复制一份 dev 提示词或继续引用 `dev.md`：

```yaml
name: dev-approval
executor: codex-orca
model: gpt-6.1-sol
effort: high
prompt: dev.md
permissions:
  approval: on-request
  sandbox: workspace-write
```

该示例默认即使用 `approvals_reviewer=user`；仅在需要显式覆盖默认值时配置 `permissions.config.approvals_reviewer`。

### reviewer：claude-sdk

```yaml
name: reviewer
executor: claude-sdk
model: claude-opus-5-5
prompt: reviewer.md
creatable_by:
  - "*"
permissions:
  permissionMode: default
  setting_sources: []
  allowedTools:
    - Read
    - Glob
    - Grep
    - "Bash(gh pr comment:*)"
    - "Bash(gh pr review:*)"
  disallowedTools:
    - NotebookEdit
  writable_paths:
    - "docs/**/*.md"
    - "docs/**/*.mdx"
    - "docs/**/*.txt"
    - "docs/**/*.png"
    - "docs/**/*.svg"
    - "docs/**/*.jpg"
    - "docs/**/*.jpeg"
    - "docs/**/*.gif"
    - "docs/**/*.webp"
    - "**/*.md"
    - "**/*.mdx"
```

- `permissionMode` 默认 `default`：未被 SDK 权限规则直接放行的调用进入 `canUseTool`。
  节点先做 Raindown 策略预检，需要人决定时报告 `blocked(awaiting_approval)`，等待回复；
  `auto` 可能由 SDK 自动放行，`bypassPermissions` 跳过 SDK 权限审批，只有明确理解后才显式设置。
- `setting_sources` 传给 SDK 的 `settingSources`，可选 `user`、`project`、`local`，缺省为 `['project']`。
  reviewer 特意使用 `[]`：被审查仓库的 `.claude/settings.json` 可能包含直接执行命令的 hooks，
  或在 Raindown 审批前就生效的 `permissions.allow`。不加载项目设置才能避免这些规则影响审查权限。
  不含 `project` 时，Raindown 将 cwd 下 `CLAUDE.md`、`AGENTS.md` 作为限长、脱敏的纯文本追加到提示词。
- `allowedTools` 是 SDK 的免询问工具规则，`disallowedTools` 禁用指定工具，reviewer 保留 `NotebookEdit` 禁令。
- `writable_paths` 仅适用于 `claude-sdk`；其他执行器（包括 `codex-orca`、`codex-exec`）配置它会报配置错误。
  它是 Raindown 的文件工具路径白名单，适用于 `Write`、`Edit`、`MultiEdit`；`NotebookEdit` 始终拒绝。
  路径相对合同 cwd，支持 `*`（不跨目录）、`**`（跨目录）、`?`（单字符），不支持花括号扩展，其余字符按字面匹配；默认模板已按扩展名展开。
  默认 reviewer 可直接写 `docs/` 下的 md、mdx、txt、png、svg、jpg、jpeg、gif、webp，
  以及任意目录（含根目录）的 `*.md`、`*.mdx`。
  原始路径与解析符号链接后的真实路径都必须匹配；允许 cwd 内绝对路径，拒绝任何 `..` 路径段、以 `~` 开头或首尾有空白的路径、
  cwd 外路径及无法确认真实位置的路径。新文件校验最近的已存在祖先。
  不论白名单如何配置，任何隐藏路径段（以 `.` 开头）和任意层级的 `CLAUDE.md`、`CLAUDE.local.md`、
  `AGENT.md`、`AGENTS.md`、`AGENTS.override.md`、`CONVENTIONS.md`、`GEMINI.md`、`copilot-instructions.md` 都硬性禁写。
  每个路径段在比较隐藏名称和指令文件名前，先做 `normalize('NFKC').toUpperCase().toLowerCase()`，
  防止 `AGENTſ.md`、`copilot-instructionſ.md`、全角字符等 Unicode 折叠变体绕过；实际写入路径保持原样，中文文档名仍允许。
  这也适用于符号链接目标，避免不可信 PR 诱导 reviewer 改写后续开发代理会加载的指令或命令。
  白名单以外的文件写入直接拒绝，不走 Raindown 策略预检或用户审批；`[]` 禁止所有文件工具写入。
  字段缺省不新增写入授权，沿用旧角色的 SDK 权限和 Raindown 审批行为；已有 reviewer 的 Edit/Write 禁令仍然生效。
- `canUseTool` 负责文件工具的直接放行或拒绝；同一校验也安装在 SDK `PreToolUse` hook 中，
  避免 `allowedTools`、权限模式或会话批准提前放行而跳过边界。SDK 的显式禁用规则仍生效。
  `PreToolUse` 省略 matcher，匹配所有工具：非 `mcp__` 前缀的未知工具只要输入包含 `file_path`、`notebook_path` 或 `path`，
  就直接拒绝，即使字段值不合法；已处理的文件写工具按白名单判定，已知只读工具仍走 SDK 原权限流程。
  只读清单按 SDK 0.3.310 内置名称列为 Read、Glob、Grep、LSP、ListMcpResourcesTool、ReadMcpResourceTool、
  ReadMcpResourceDirTool（当前 SDK 无 LS）。MCP 的 path 可能是资源标识，故不套用这个未知文件工具兜底，
  保留既有允许规则、Raindown 策略和用户审批；这不意味着自动放行 MCP 调用。
  只在成功的 `PostToolUse` 后，将文件绝对路径去重列入 result 的 `artifacts`（`kind: file`）；
  仅获授权、被拒绝或执行失败的调用不算产物，不统计 Bash 或其他工具的写入。
- `read_scope: cwd`（add-m1-supervisor D6）仅适用于 `claude-sdk`；其他执行器配置它会报配置错误，取值目前只有 `cwd`。
  设置后同一个省略 matcher 的 `PreToolUse` hook 覆盖全部工具（`canUseTool` 中也做同样的兜底，检查出错一律拒绝），
  与 `writable_paths` 共用路径判定（`packages/node/src/claude-path-scope.ts`），用于防止读取
  `state/hub.token`、密钥存储、`~/.config/gh`、`~/.ssh` 后经任务目标外传：
  - 只认白名单工具并按字段白名单校验：Read、NotebookRead、Glob、Grep、Edit、MultiEdit、Write、NotebookEdit、TodoWrite、ToolSearch、
    WaitForMcpServers（只有服务器名列表 `servers`，按不涉及路径的值放行）；只产生输出的 StructuredOutput 只在会话配置了
    结构化输出（审查任务的 `outputFormat`）时放行，否则拒绝；带白名单外字段（包括 `FILE_PATH`、`filePath` 之类的变体）即拒绝。
    其他工具一律拒绝，包括 Bash、PowerShell、Monitor、Agent、WebFetch、WebSearch、LSP、Skill、MCP 资源工具和非 Raindown 的 MCP 工具；
  - 路径字段只能落在合同 cwd（相对路径相对它解析，cwd 自身可读）或节点注入的任务私有目录（只按绝对路径匹配）内；
    拒绝以 `~` 开头（CLI 会展开为 home）、首尾有空白、含 `..` 段或 NUL、以 `.` 开头的路径段（按 NFKC 折叠比较）、越界，
    以及逐段解析后越界或落到隐藏段的符号链接；Read、NotebookRead 和 Glob/Grep 的 `path` 必须已存在。
    通过后用不带 `permissionDecision` 的 `updatedInput` 把路径改写为校验过的真实绝对路径（CLI 2.1.310 在没有决定时
    只替换输入、权限流程照常继续），确保 CLI 使用的就是检查过的路径；
  - Glob/Grep 未给 `path` 时显式补上合同 cwd 的真实路径；
  - Glob 的 `pattern`、Grep 的 `glob` 不得为绝对路径或以 `~` 开头，不得含 `..`、反斜杠或字符类 `[...]`；
    按空白拆开的每个片段中，任何段及花括号、括号分支都不得以 `.`、`/`、`?` 开头；
  - 隐藏条目：CLI 的 Grep 固定带 `--hidden`。Raindown 在 `glob` 末尾追加 `!.*`；CLI 按空白（以及不含成对花括号时按逗号）
    把 `glob` 拆成多个 `--glob`，之后只再追加排除规则，而 rg 的 override 以最后命中的一条为准，因此用户片段不能覆盖这条排除。
    开启 `.github` 选项并在 cwd 根下搜索时，再追加 `/.github` 放回根下的 `.github`（没有正向片段时先补 `*`）。
    Glob 默认带 `--hidden --no-ignore`，Raindown 为会话设置 `CLAUDE_CODE_GLOB_HIDDEN=false`、`CLAUDE_CODE_GLOB_NO_IGNORE=false`；
  - hook 收到的会话 cwd 与合同 cwd 的真实路径不一致时，拒绝全部非 Raindown 工具；
  - Raindown MCP 工具不受影响，条件是工具名为 `mcp__raindown__*`，且 SDK 提供的 MCP 来源名为 `raindown`、`source` 为 `dynamic`
    （执行器经 `--mcp-config` 注入的进程服务器）或 `sdk`；缺少来源信息时不豁免，`canUseTool` 也按同样的规则核对。
  读边界只拒绝或改写，从不放行：通过检查的调用仍走 SDK 权限、Raindown 策略与审批；同时设置 `writable_paths` 时先判读边界，再按写白名单放行或拒绝。
  审查任务可由节点通过 `ExecutorContext.readScope` 注入私有目录，并打开 `allowDotGithub` 允许读 cwd 根下的 `.github/`（其中的隐藏段仍拒绝），默认关闭。
  残余风险（以 CLI 2.1.310 的实现为依据，未运行真实 Claude）：
  - Glob 的 `pattern` 本身作为 rg 的正向 `--glob` 传入，正向 override 优先于隐藏过滤，所以 `**/*` 这类模式仍可能列出 cwd 内隐藏文件的**名称**
    （读取其内容会被拒绝）；
  - `/.github` 按 rg 的锚定语义相对搜索根匹配，依赖 CLI 运行 rg 时的工作目录就是搜索根；若不是，`.github` 可能搜不到（只会更严），
    这一残余依赖保留，未改为绝对锚定；
  - 检查之后同一用户的其他进程仍可能并发替换文件或符号链接；这同样不是操作系统级隔离。
- reviewer 可以评论和提交 PR review，但其他 Bash 调用仍沿用策略预检与审批；不要用 Bash 或其他工具绕过文件白名单。
  这不是操作系统级文件隔离，任意命令、MCP 工具和外部进程的间接写入仍应结合沙箱与授权范围约束。
- 可选 `maxTurns` 限制轮次；`approval_timeout_minutes` 默认 1440（24 小时），超过后任务以 `approval_timeout` 失败。

`raindown init` 不覆盖已有 `reviewer.yaml` 或 `reviewer.md`。已有用户需要手动更新：上面的完整 YAML
可以直接复制为角色文件；也可以在现有 `permissions` 中移除 `disallowedTools` 的 Edit、Write，并合并：

```yaml
permissions:
  permissionMode: default
  setting_sources: []
  disallowedTools:
    - NotebookEdit
  writable_paths:
    - "docs/**/*.md"
    - "docs/**/*.mdx"
    - "docs/**/*.txt"
    - "docs/**/*.png"
    - "docs/**/*.svg"
    - "docs/**/*.jpg"
    - "docs/**/*.jpeg"
    - "docs/**/*.gif"
    - "docs/**/*.webp"
    - "**/*.md"
    - "**/*.mdx"
```

保留原有 `allowedTools`。同时把 `reviewer.md` 更新为：可以新建或修改上述文档文件，不改代码，
不要通过 Bash 或其他工具绕过限制；除非合同明确要求，否则不提交、不推送；不合并 PR；
结论写在最终回复里，并列出本次写过的文件。

SDK 0.3.310（随包 Claude Code 2.1.310）的本地 `sdk.d.ts` 将两组工具规则声明为 `string[]`，
`README.md` 未详细定义路径匹配。官方[权限规则文档](https://code.claude.com/docs/en/permissions#read-and-edit)
说明 `Edit(path)` 覆盖所有内置文件编辑工具（包括 Write、NotebookEdit 和旧 MultiEdit）；
`Write(path)`、`NotebookEdit(path)`、`MultiEdit(path)` 规则会被接受但不匹配。
原生允许规则也不能表达白名单之外一律拒绝的补集，因此使用 Raindown 的 `writable_paths`，不生成 SDK 路径允许规则。
官方 [SDK 权限流程](https://code.claude.com/docs/en/agent-sdk/permissions#how-permissions-are-evaluated)
说明 hooks 先于权限模式和允许规则，而 `canUseTool` 仅处理前序未决定的请求。
全工具 hook 使用省略 matcher 的写法：本地 SDK 0.3.310 的 `sdk.d.ts` 中 `HookCallbackMatcher.matcher?: string`
为可选字段，`Options.hooks` 的 PreToolUse 示例也没有 matcher；官方 [SDK hooks 文档](https://code.claude.com/docs/en/agent-sdk/hooks#matchers)
明确说明，无 matcher 的 hook 会接收该类型的每个事件。因此不依赖 `.*` 正则来表达全工具匹配。
以上由类型定义和文档确认，未运行真实 Claude 或调用模型 API。

执行器自动注入任务绑定的 `raindown mcp --actor reviewer --task <id>`（其他角色用各自名字），工具清单与放行规则见上文
「派工令牌与任务绑定工具」：worker 会话只有 `raindown_report`、`task_show`、`event_get`、`kb_search`、`kb_get`、`kb_query`，
没有知识写入、`task_create`、`task_cancel`、`task_reply` 等写类工具。

supervisor 唤醒会话使用唤醒绑定，自动放行的 Raindown 工具为 `kb_search`、`kb_get`、`kb_query`、`kb_journal`、`capture`、`kb_propose`、
`ws_brief`、`brief_update`、`task_list`、`task_show`、`event_get`，以及 supervisor 专用的 `ask_user`、`task_propose`、`decision_review`、
`patrol_report`、`task_respond`；`task_create`、`pr_merge_request` 仍走策略。这些写入受 AI 写入边界限制，提交提案不等于接受提案；
`brief_update` 只写 supervisor 自己的简报笔记，身份、workspace 与 `base_hash` 由中枢核对。不要用宽泛的 allowedTools 绕过这层审批。
`task_reply` 另有用户身份限制：AI 不能代替用户批准自己。

### pr-reviewer：审查准备与结构化输出（add-m1-supervisor D10）

模板见 `raindown init` 生成的 `pr-reviewer.yaml`：`kind: read`、`setting_sources: []`、`read_scope: cwd`，没有 Bash 与写工具。
合同带 `inputs.review = {pr, focus?}` 时，claude-sdk 执行器先读节点上的 workspace 配置（读不到该 workspace 时
`failed(review_prep_failed)`，不当作普通任务运行）。角色属于 `supervisor.reviewer_roles`（默认 `[pr-reviewer]`）时，
会话前由确定性代码完成准备，模型不参与：

0. **审查角色必须是只读配置（fail-closed）**：执行器为 claude-sdk、有效类别为 read、`setting_sources` 显式为 `[]`、
   `read_scope: cwd`，任一不满足即 `failed(review_role_not_read)`，不检出 PR、不启动会话。`raindown doctor` 对
   `reviewer_roles` 中不满足的已有角色报 error（例如把默认 reviewer 加进去）；
1. 合同 cwd（或 `inputs.repo`）必须是本 workspace 登记的仓库；PR 链接的 host/owner/repo 必须等于该仓库 `remote.origin.url`
   配置原值解析出的仓库（不经 insteadOf 改写，必须恰好一个地址），否则任务启动前 `failed(repo_not_in_workspace)`。
   只认 `https://host/owner/repo`、`ssh://[user@]host/owner/repo`、`[user@]host:owner/repo` 三种形式，host 必须与 PR 链接的
   host 相同：**`~/.ssh/config` 中的主机别名（例如 `git@github-work:owner/repo`）会被判为 `repo_not_in_workspace`**，
   需要把 origin 改成真实主机名；
2. `gh pr view <链接>` 读取 PR，核对编号与链接（大小写不敏感），fork PR（`isCrossRepository`）一律 `failed(repo_not_in_workspace)`，记录当前 `headRefOid`；`gh pr diff` 写入任务私有目录的 `pr.diff`；
3. `git fetch origin +pull/<n>/head:refs/raindown/review/<task-id>`（任务专用 ref，不依赖 FETCH_HEAD），该 ref 必须等于记录的
   head（准备期间有新提交时 `failed(head_moved)`），再 `git worktree add --detach` 检出到任务私有目录下的 `worktree/` 作为会话 cwd；
4. 检出时不运行任何由配置驱动的程序：`-c core.hooksPath=/dev/null`、`-c core.fsmonitor=false`，并对
   `git config --get-regexp '^filter\.'` 列出的每个 filter driver 加 `-c filter.<名>.smudge= -c filter.<名>.clean=
   -c filter.<名>.process= -c filter.<名>.required=false`（PR 的 `.gitattributes` 引用它们时原样检出）；对配置了
   `textconv` 或 `command` 的每个 diff driver 加 `-c diff.<名>.textconv= -c diff.<名>.command=`，并加 `-c diff.external=`
   （实测 git 对这些空值会报 `cannot run :` 而不执行任何程序，相关 diff 失败而不是运行配置里的命令）；环境设
   `GIT_LFS_SKIP_SMUDGE=1`。会话环境用 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` 注入同样的覆盖
   （接在已有条目之后）与 `GIT_LFS_SKIP_SMUDGE=1`，Claude Code 自己运行的 `git status` 等也不会触发它们；
5. 会话无条件 `settingSources: []`、`strictMcpConfig: true`（只用注入的 Raindown MCP），并设 `ENABLE_CLAUDEAI_MCP_SERVERS=false`
   关闭 claude.ai connector；`read_scope` 允许 worktree（含根下 `.github/`）与私有目录；首条消息写明 PR、head 与 diff 路径；
   项目约定（CLAUDE.md / AGENTS.md）从登记仓库读取，不从 PR 的检出读取，PR 不能借此改写系统提示词；
6. SDK `outputFormat: {type: 'json_schema'}`（schema 即 `schemas/tasks/review-output.schema.json`），`StructuredOutput`
   直接放行、不进审批。结果的 `verdict`、`blocking`、`notes` 取自结构化输出并按 zod 再校验（approve 时 blocking 必须为空，
   不允许多余字段），`reviewed_sha` 由执行器填入第 2 步记录的 head；结构化输出缺失、不合规或 `error_max_structured_output_retries`
   → `failed(review_output_invalid)`。`summary` 仍是最后一段文字（没有文字时由结论生成）；
7. 任务结束（任何结果）后移除 worktree、任务专用 ref 与私有目录；节点启动时清理本节点残留的私有目录并 `git worktree prune`。
   私有目录为 `<raindown-home>/run/tasks/<task-id>/review/<node-id>/`（位于 `state/` 之外，见「`run/` 目录」）；
   启动清理同时清理旧位置 `state/review/<node-id>/` 的残留。

审查任务恢复执行（回复后重新排队）时不恢复旧会话：旧会话可能看过另一个 head，回复附在新的任务说明之后，重新准备。
不在 `reviewer_roles` 中的角色即使带 `inputs.review` 也按普通任务运行，不做准备。中枢入账时，结果不是 done、合同没有
`inputs.review` 或执行器不是 claude-sdk 的任务提交的 `result.review` 一律丢弃；采信时（合并请求、pr-merge 再次核对）统一用 core 的
`trustedReview` / `reviewApproves` / `latestTrustedReview` 判断：同一 workspace、执行器 claude-sdk、角色在 `reviewer_roles` 中、
已 done、`inputs.review.pr` 等于该 PR，并且是该 PR 最新一次可信审查。

### 有效类别为 read 的角色由执行器强制只读（tasks 5.7）

有效类别（D9，doctor 显示）只是配置层判断，执行器另外强制：

- claude-sdk：SDK `tools` 选项只提供 Read、Grep、Glob、ToolSearch、WaitForMcpServers（Raindown MCP 不受 `tools` 影响）；
  `allowedTools` 只保留 `readRoleMayUse` 为真的条目（规则取括号前的工具名），写工具、Bash 与 `mcp__raindown__task_create` 之类的
  MCP 写操作即使写在 `allowedTools` 中也被滤掉；始终安装（不论有没有 `read_scope`）省略 matcher 的 PreToolUse 钩子，对
  `readRoleMayUse` 为假的调用直接拒绝；`canUseTool` 同样拒绝、不做策略预检、不进审批。允许的 Raindown 工具只有自动放行清单中的那些；
  StructuredOutput 只在配置了结构化输出时可用。会话设 `strictMcpConfig: true` 与 `ENABLE_CLAUDEAI_MCP_SERVERS=false`：
  不加载 `.mcp.json`、用户设置、插件中的 MCP 服务器与 claude.ai connector。
- codex-exec：继续使用只读目录（`run/executors/codex-exec/codex-read-home`）和只读沙箱；完整的配置隔离、凭证链接与恢复约定见上文「Codex 配置隔离」。
  只读角色需要的 `permissions.config` 只允许 `model`、`model_reasoning_effort`，否则推断为 write；
  写类角色也隔离，改用 `run/executors/codex-exec/codex-home`。`codexExecPermissions` 可用的键与 core 的
  `CODEX_EXEC_KNOWN_PERMISSION_KEYS` 由防漂移测试保持一致。
  - **为什么不用 `-c`（Codex 0.164.0 实测，2026-10-26）**：在临时 `CODEX_HOME` 的 `config.toml` 中配置
    `[mcp_servers.userfoo] command = "/bin/sh", args = ["-c", "touch <标记>"]` 与一个指向 `http://127.0.0.1:1/v1` 的 provider，
    在临时 git 仓库中运行 `codex -c 'mcp_servers={}' -c 'notify=[]' exec --skip-git-repo-check -s read-only --json "say hi"`，
    标记文件照样出现（`codex -c 'mcp_servers={}' mcp list` 也仍列出 userfoo）：`-c` 对表是合并而不是替换。
    同样条件下 `-c mcp_servers.<名>.enabled=false` 能阻止该服务器启动，但需要预先知道所有服务器名；
    隔离的 CODEX_HOME 中没有项目信任记录时，项目级 `.codex/config.toml` 中的服务器不启动，加上信任记录后会启动。
    **升级 Codex 后需要按上述命令复测**这两项行为。

### triage：codex-exec

```yaml
name: triage
executor: codex-exec
prompt: triage.md
creatable_by:
  - "*"
permissions:
  sandbox: read-only
```

`sandbox` 可取 `read-only`（缺省）、`workspace-write`、`danger-full-access`，控制初始执行与恢复执行的 Codex 沙箱。
此执行器没有交互审批通道；分诊角色保持只读。也支持标量形式的 `permissions.config`。
最后一条代理消息若是提问，任务进入 `blocked(question)`；用户文字回复后重新排队，带会话 id 用 exec resume 继续。

### merger：pr-merge（add-m1-supervisor D10 第 5 步）

```yaml
name: merger
kind: merge
executor: pr-merge
prompt: merger.md
no_progress_minutes: 35
```

pr-merge 执行器**不调用任何模型**，合同的 `inputs.merge = {pr, review_task}` 由中枢填写；执行器重新读取全部事实，
任何一项不满足或无法确认都以 `failed(<原因码>)` 结束、不合并：

| 核对 | 原因码 |
| --- | --- |
| `inputs.merge` 合法 | `invalid_inputs` |
| cwd 是本 workspace 登记仓库；PR 链接的仓库等于 `remote.origin.url`，也等于开出 PR 的任务在 worker 启动前采集的 `repo_snapshot.remote_url`；GraphQL 报告的仓库一致 | `repo_not_in_workspace` |
| 读到 workspace 配置；本任务由 hub 或 user 创建、origin 为 instruction、`parent` 是审查任务、中枢记录的 `inputs.merge` 与合同一致 | `merge_not_eligible` |
| 审查任务：同一 workspace、claude-sdk、角色在 `reviewer_roles`、done、`inputs.review.pr` 等于该 PR、结论 approve，且是该 PR **最新一次**可信审查 | `review_not_approved` |
| 同一 PR 没有未结束（queued / running / verifying / blocked）的审查任务 | `review_not_approved` |
| 中枢不可达（可重试错误） | `merge_unverifiable`（摘要写明"未合并，中枢不可达，可重试"） |
| 合同 `timeout_s` 不小于 2400（40 分钟） | `timeout_too_short` |
| PR 快照读取成功、编号与链接（大小写不敏感）一致 | `pr_unverifiable` |
| 不是 fork PR（`isCrossRepository == false`） | `repo_not_in_workspace` |
| PR 的 head 分支等于 `inputs.merge.branch`（合并前重读时再核对一次） | `head_branch_mismatch` |
| PR 为 OPEN | `pr_not_open` |
| base 为仓库默认分支 | `base_not_default` |
| 目标分支没有启用合并队列 | `merge_queue_unsupported` |
| 当前 head 等于 `reviewed_sha`，快照中的检查就是这个提交的；读完检查、合并前再读一次 head 仍相等 | `head_moved` |
| 不是草稿且 `mergeable = MERGEABLE`（`UNKNOWN` 时每 5 秒重读，最多 3 次） | `not_mergeable` |
| 至少一项检查且全部 `pass`（`skipping` 不算失败，但不计入"至少一项"；结论为 SKIPPED 与 NEUTRAL 的检查都归为 `skipping`），没有进行中的；检查超过 100 项无法确认时判失败；`supervisor.allow_no_checks: true` 时允许没有检查 | `checks_not_green` |

PR 状态与检查来自**同一次** GraphQL 读取（`gh api graphql`：`headRefOid`、`mergeable`、`isMergeQueueEnabled`、
`autoMergeRequest` 与最新提交的 `statusCheckRollup`），不会出现"读检查之后 head 变了"的错位；合并前再读一次 head，
合并命令本身也带 `--match-head-commit`。`mergeStateStatus`（BLOCKED、BEHIND、UNSTABLE 等）只读取并记在活动里，
不作为判定依据。检查的判定完全 fail-closed：head 提交上 rollup 返回的每一条 CheckRun 与 StatusContext 都单独计入，只要有一条不是
pass / skipping 就不合并（进行中为 pending，其余为失败，都是 `checks_not_green`）。不按名称合并"较新的成功覆盖较早的失败"：
同一 workflow 中同名的不同 job（例如固定 name 的 matrix 分支）无法与重跑可靠区分，合并会把失败或进行中的检查遮住。
唯一的去重是同一个 check run id（`databaseId`）重复出现时只算一次。
**有意的后果**：flaky 检查重跑成功后，旧的失败记录仍在 rollup 中，pr-merge 不会合并；需要推一个新提交重新触发检查，
或由用户手动合并。**分支保护应把关键检查设为 required**：pr-merge 只能看到读取时已存在的检查，
之后才创建的检查不在核对范围内。

通过后执行 `gh pr merge <链接> --<merge_method> --match-head-commit <reviewed_sha>`（`supervisor.merge_method`，默认 squash）。
不带 `--auto`、分支没有合并队列时 gh 不会改为启用自动合并（gh 只在合并队列分支上这样做，这类分支已在合并前拒绝）；为防万一，
合并后 PR 仍为 OPEN、且出现了合并前没有的自动合并请求时，执行器用 `--disable-auto` 关掉它（别人事先设置的不动）。
合并后必须读到 MERGED、合并提交与 `headRefOid == reviewed_sha`，否则 `failed(merge_failed)`；一直读不回状态时
`failed(merge_unverified)`，摘要写明 PR 可能已合并、需要人工确认。

合并后用 `gh run list -R <host/owner/repo> --commit <合并提交> --branch <默认分支>` 轮询（默认每 15 秒，不超过 2 分钟），
只计 `push` 与 `workflow_run` 事件的 run；每次轮询都上报一条活动（心跳），节点不会把等待判为无进展（merger 模板另设
`no_progress_minutes: 35`）。全部结束且结论都是 success / skipped / neutral，并在下一次查询中没有新出现的 run → `done`，
结果附 run 链接；有其他结论 → `failed(pipeline_failed)`，其中 cancelled 的 run 附说明（可能是被同一并发组中更新的提交取代，
请确认默认分支最新提交的流水线）；30 分钟仍未结束 → `failed(pipeline_timeout)`，附 run 链接；合并后 2 分钟内一直没有任何 run →
`done`，注明未发现发布流水线（查询失败不算"没有 run"）。合并后被取消时，cancelled 的结果带合并提交与 artifacts。

**谁建 merger**（D10 第 4 步，tasks 4.8）：supervisor 不能直接建（`task_create` 返回 `role_not_allowed`），只能调用
`pr_merge_request{pr, review_task}`。中枢按账本核对资格，任一项拿不准即 403 `merge_not_eligible`（`details.reasons` 列出原因）：
PR 是本 workspace 内某个已 done、origin 为 instruction、有效类别恰为 write、上报过任务分支的任务的 `kind: pr` 产物（唤醒、审查、合并任务的产物不算）；
PR 的 owner/repo 等于开出 PR 的任务在 worker 启动前采集的 `repo_snapshot.remote_url` 的仓库（worker 可能改写 remote，只认快照），且等于登记仓库当前 `remote.origin.url` 的仓库；
`review_task` 同 workspace、角色在 `reviewer_roles`、执行器 claude-sdk、done、审查同一 PR、结论 approve，且是该 PR 最新一次可信审查；
同一 PR 没有未结束的审查任务；该审查的合并请求没有被驳回过（`rejected_before`）；merger 的工作目录能唯一确定为登记仓库；有且只有一个有效类别为 merge、执行器为 pr-merge 的角色。
通过后 `supervisor.auto_merge: true` 且请求来自 instruction 唤醒时中枢以 hub 直接建 merger；否则（含 autonomous 唤醒）生成
`merge_request` 收件箱条目，只有用户能批准（再核对一次资格，`merge_request.approved`、merger 的创建与条目关闭在同一事务中写入）
或驳回（写 `merge_request.rejected`，按请求所在唤醒的 origin 唤醒 supervisor）。supervisor 停用后旧条目仍可批准。
merger 合同：`parent` 为审查任务、origin 取自开出 PR 的任务（instruction）、`inputs.merge = {pr, review_task, branch}`（`branch`
取自该任务投影的任务分支）、`timeout_s` 3600、
幂等键 `merge:<审查任务>`（同一次审查最多一个 merger；要重试合并需要重新审查）。合并审批条目不轮询 PR 状态。

**timeout_s**：merger 合同的 `timeout_s` 不得小于 2400 秒（40 分钟：核对与合并之外还要等最长 30 分钟的流水线），
否则执行器在合并前以 `timeout_too_short` 失败；角色文件不支持 `timeout_s`，由创建 merger 任务的中枢保证（缺省 3600）。

**pr-merge 只能在本机节点上运行**：远程节点、以及用绑定 token（`RAINDOWN_HUB_TOKEN`，`node:<id>` 身份）运行的节点读不到审查任务与
任务列表，核对必然失败（`merge_not_eligible` / `review_not_approved`），不能执行合并。

审查任务与任务列表（`status=done` 的可信审查，以及各未结束状态的同 PR 审查）经中枢 `GET /v1/tasks/:id`、`GET /v1/tasks`
读取。执行器自己按 raindown-home 构造中枢客户端，不声明 `X-Raindown-Actor`：本机节点以 user token 访问，身份为 user
（与 G5 "节点接口只允许 user 与 node:*" 的要求一致；这两个是任务接口，不是节点协议接口）；用绑定 token
（`RAINDOWN_HUB_TOKEN`，`node:<id>` 身份）运行的节点读不到它们，按核对失败处理。pr-merge 应在本机节点上运行。

gh 版本：按已验证的 gh 2.102.0 要求（需要 `gh api graphql --hostname`、`gh pr merge --match-head-commit`、
`gh run list --commit`、`gh pr view --json autoMergeRequest`）；更早的版本未测试，`raindown doctor` 不检查 gh 版本。

## 安全边界

以 [policy README 的“信任边界与局限”](../packages/core/src/policy/README.md#信任边界与局限) 为准：
节点属于可信计算基，中枢判定之后由节点实际放行。Bash / CodexCommand 的静态识别只能尽力识别常见写法；
宽泛的 Bash 自动放行实质上允许任意代码，真正的边界应放在沙箱、工具权限和文件系统/网络隔离上。

默认 dev 会跳过 Codex 审批和沙箱，可以以节点的系统用户权限执行命令、读写文件和访问网络，
不会保证每个危险动作都经过 Raindown。只给可信仓库和已授权任务使用，收紧时使用上面的临时角色。
同一系统用户下能读取中枢 user token 的进程还可以取得用户身份，见 [中枢鉴权的信任边界](hub-auth.md#信任边界)。
角色、workspace 和 policies 配置本身也属于提权面。

reviewer 直接在合同 cwd 中写文档，通常就是用户的主检出；不会自动创建独立 worktree，写入会让工作区变脏。
审查报告类任务建议明确写到 `docs/reviews/` 等目录，合同中说明是否允许提交和推送。
默认提示词要求不改代码、不提交、不推送（合同明确要求提交或推送时除外），并在最终回复列出写过的文件。
`docs/` 只默认放行上述文档及图片扩展名；目录外只允许 `.md`、`.mdx`，隐藏路径和代理指令文件仍禁止。
文档目录也可能包含会执行代码的配置，例如 `docs/conf.py`、`docs/.vitepress/config.ts`，不能因它位于 docs 下就信任。
默认白名单不放行这些配置，角色提示词仍要求内容属于文档。
指令文件清单是尽力而为的防护，不能完整识别所有代理输入：代理可能经 `@引用` 间接读取普通文档作为指令。
敏感仓库可将白名单收窄到 `docs/**` 范围内，保留 docs 下逐项展开的文档及图片规则，移除跨目录的 `**/*.md`、`**/*.mdx`；
这样仍保留扩展名限制，不会重新放行 `docs/conf.py` 等可执行配置。
路径校验不隔离同一用户下其他进程，无法阻止其他进程在校验后并发替换文件或符号链接。

## 从 orca-codex 脚本迁移

原来的 `~/.claude/scripts/orca-codex/dispatch-codex.sh` 负责建 worktree、写任务说明和启动 Codex，
`watch-codex.sh` 负责读终端、发现停止后手工处理。迁移后对应为：

| 原来的步骤 | Raindown 对应 |
| --- | --- |
| dispatch-codex.sh 手工派发 | `raindown task create --file <合同>`；节点按 dev 角色建 worktree、渲染说明并启动 Codex |
| watch-codex.sh 循环读终端 | 节点默认每 30 秒轮询；连续两次无忙碌标记后判断 PR、审批、提问等状态 |
| 人工看终端是否完成 | `raindown task show <id>` 查看合同、结果、PR 产物、验收与事件；任务说明保存在 `state/tasks/<id>/spec.md` |
| 人工向终端回答 | `raindown task reply <id> "用方案 A"`，或 `--approve` / `--deny` |
| 分散查看卡住的 worker | `raindown inbox` 集中查看待处理条目 |

迁移步骤：

1. 在选定的 RAINDOWN_HOME 初始化角色；确认 `config/workspaces/product-res.yaml` 的 `repos` 包含实际仓库绝对路径，
   仓库也已导入 Orca。启动 Orca 应用、中枢和节点，再运行 doctor。
2. 将原来传给脚本的说明保存为 `contract.json`。下面是 dev 合同的最小结构，目标应明确范围与完成条件：

```json
{
  "goal": "只修正 README.md 的一处模板残留，提交并开 PR，不合并。",
  "workspace": "ws/product-res",
  "role": "dev",
  "executor": "codex-orca"
}
```

3. 运行 `raindown task create --file contract.json`，记下返回的任务 id。
   三种执行器共用合同工作目录规则：显式 `cwd` 优先；否则使用属于该 workspace repos 的 `inputs.repo`；
   两者都没有时，取 workspace 唯一仓库。没有仓库或有多个仓库时必须写 `cwd` 或 `inputs.repo`，
   否则任务以 `failed`（`repo_not_in_workspace`）结束，不再回退到 raindown-home。
   合同 `cwd` 必须是绝对路径，允许 `~/` 开头并由节点展开；相对路径在合同校验时拒绝。codex-orca 仍以 `inputs.repo`（其次 `cwd`）选择基础仓库并校验归属，再创建 worktree。
   可加 `inputs.scope: ["README.md"]` 明确修改范围，`context` 引用知识，
   `verify: [{"cmd":["bun","test"]}]` 指定验收命令（应换成该仓库实际的检查）。
   verify 是 argv，不经过 shell；有验收命令时成功后先进入 verifying，全部通过才 done。
   验收目录依次取单条 verify 的 `cwd`、执行器返回的工作目录（codex-orca 的 worktree）、上述合同工作目录。
   策略预检的相对路径也按上述合同工作目录解析。
   合同 `executor` 是必填字段且优先于角色值，换角色时应一起检查。
4. 用返回的 id 替换下面的 `<id>`。仅 blocked 任务能回复；提问必须用文字，批准不能附带文字，拒绝可以附理由：

```sh
raindown task show <id>
raindown inbox
raindown task reply <id> "用方案 A"
raindown task reply <id> --approve
raindown task reply <id> --deny "不要推送，先补测试"
```

交互式执行器在下一次续约送达回复并恢复运行；codex-exec 会重新排队恢复会话。
原脚本可以保留，但不要同时监控或向同一个任务发送输入。确认流程可用后，用户再自行更新个人派发约定；
Raindown 不调用、不修改 `~/.claude/scripts` 或个人 CLAUDE.md。

## 临时环境验证命令

在仓库根目录、有 bun / git / gitleaks 的环境中，下面的冒烟流程只使用 fake 执行器，
不运行 Codex、Orca 或 Claude，不访问个人 `.codex` / `.claude`；不安装或调整 launchd 服务。
`raindown` 函数指向当前 checkout 的 CLI。doctor 仍会只读检查已安装的 Raindown plist 路径。
端口 17477 需要空闲；两个后台 PID 只用于停止本次启动的前台进程。

```sh
RAINDOWN_DEMO_DIR="$(mktemp -d)"
export RAINDOWN_HOME="$RAINDOWN_DEMO_DIR/home"
raindown() { bun packages/cli/src/main.ts "$@"; }
raindown init
rm "$RAINDOWN_HOME/config/roles/dev.yaml" "$RAINDOWN_HOME/config/roles/reviewer.yaml" "$RAINDOWN_HOME/config/roles/triage.yaml"
cat > "$RAINDOWN_HOME/config/roles/demo.yaml" <<'YAML'
name: demo
executor: fake
prompt: 临时验证，不调用真实执行器
YAML
cat > "$RAINDOWN_HOME/config/workspaces/demo.yaml" <<'YAML'
id: demo
kind: product
name: 演示
description: 临时验证
repos: []
YAML
printf 'port: 17477\nlease_ttl_s: 5\n' > "$RAINDOWN_HOME/config/hub.yaml"
raindown doctor
raindown doctor --json
bun packages/cli/src/main.ts hub start > "$RAINDOWN_DEMO_DIR/hub.log" 2>&1 &
RAINDOWN_DEMO_HUB_PID=$!
until raindown hub status >/dev/null 2>&1; do sleep 0.1; done
bun packages/cli/src/main.ts node start > "$RAINDOWN_DEMO_DIR/node.log" 2>&1 &
RAINDOWN_DEMO_NODE_PID=$!
cat > "$RAINDOWN_DEMO_DIR/contract.json" <<'JSON'
{
  "goal": "验证提问后回复的流程",
  "workspace": "ws/demo",
  "role": "demo",
  "executor": "fake",
  "inputs": {
    "fake": {
      "outcome": "blocked",
      "blocked_reason": "question",
      "message": "使用方案 A 吗？",
      "resume": { "message": "已按方案 A 完成" }
    }
  }
}
JSON
raindown task create --file "$RAINDOWN_DEMO_DIR/contract.json" --json > "$RAINDOWN_DEMO_DIR/task.json"
RAINDOWN_DEMO_TASK_ID="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).data.task.id)' "$RAINDOWN_DEMO_DIR/task.json")"
until raindown task show "$RAINDOWN_DEMO_TASK_ID" --json | bun -e 'process.exit((await Bun.stdin.json()).data.task.status === "blocked" ? 0 : 1)'; do sleep 0.1; done
raindown task show "$RAINDOWN_DEMO_TASK_ID"
raindown inbox
raindown task reply "$RAINDOWN_DEMO_TASK_ID" "用方案 A"
until raindown task show "$RAINDOWN_DEMO_TASK_ID" --json | bun -e 'process.exit((await Bun.stdin.json()).data.task.status === "done" ? 0 : 1)'; do sleep 0.1; done
raindown task show "$RAINDOWN_DEMO_TASK_ID"
kill "$RAINDOWN_DEMO_NODE_PID" "$RAINDOWN_DEMO_HUB_PID"
wait "$RAINDOWN_DEMO_NODE_PID" "$RAINDOWN_DEMO_HUB_PID"
```

成功时 doctor 退出 0，真实执行器检查为 info；create 返回 queued，随后 blocked(question)，
文字回复后重新排队，最终 done，摘要为“已按方案 A 完成”。重新领取可能需等待一次默认 30 秒长轮询。
临时目录保留供检查日志。
执行完后应在新的终端继续日常工作，避免沿用本次导出的临时 RAINDOWN_HOME。

## 真实环境验证（add-m1-executors 任务 6.1、6.2）

7.1 只完成 doctor 和 fake 冒烟，不能代表 6.1、6.2；两者已于 2026-10-26 在真实 harness 上完成，见下方实测记录。真实验证要另外记录任务 id、版本、PR、
信任提示与授权请求片段、回复和最终验收结果；不要把 fake 的结果当作真实 harness 的证据。

### 2026-10-26 实测记录

环境：codex-cli 0.164.0、Orca 1.4.218、Claude Code 2.1.310（Agent SDK 0.3.310）；单节点、`concurrency: 1`；
workspace `ws/product-res`。四个任务都由 user 创建，最终全部 `done`。

| 任务 | 角色 / 执行器 | 过程 | 结果 |
| --- | --- | --- | --- |
| 6.1 `t-20261026-042354-7f36df` | dev / codex-orca | 自动建 worktree 与分支 `ustclhx/t-…-7f36df` → Codex 修改 README、跑 `pnpm check` → 开 PR，约 2 分钟 | product-res PR #28，`done` |
| 6.2 `t-20261026-042354-690b74` | dev-approval（临时角色，`approval: on-request`、`approvals_reviewer: user`）/ codex-orca | ① 授权请求：沙箱内 `pnpm check` 不能监听 127.0.0.1，请求越出沙箱重跑（seq 101）→ `--approve`；② 提问：`pnpm test:create-project` 有 1 项既有失败，问 A/B（seq 108）→ 文字回复选 A；③ 授权请求：沙箱内连不上 api.github.com，请求越出沙箱执行 `gh pr create`（seq 115）→ `--approve` | product-res PR #29，`done` |
| 6.2 `t-20261026-042608-f7fe9d` | reviewer / claude-sdk | ① canUseTool 审批 `gh pr view 28 … && gh pr diff 28`（seq 126）→ `--approve`；② 审批 `git fetch … pull/28/head:pr28; …`（seq 134）→ 文字回复"不要 fetch 或建本地分支"，会话按回复改用已有 diff 完成；两次卡住同一 SDK 会话 | 审查结论"修改后再合并"，`done`，约 0.39 美元 |
| 6.2 `t-20261026-082121-5e127c` | triage / codex-exec（`sandbox: read-only`） | 最后一条消息被识别为提问（seq 145）→ 文字回复 → `task.requeued_with_reply`，第二次尝试以 `exec resume` 恢复同一会话 `01a1774c-…` | 分诊结论，`done`，attempt 2 |

结论：codex-orca 的授权请求与提问识别、审批送达，claude-sdk 的审批挂起与恢复（批准和文字回复两种），
codex-exec 的提问与 resume，均在真实 harness 上走通。挂起中的任务（codex-orca、claude-sdk）在节点下一次续约时收到回复；codex-exec 没有挂起的进程，回复后重新排队并以 resume 恢复。

未覆盖与发现：

- **信任提示没有出现**：当时 worker 仍加载用户的 Codex 配置，本机已信任 home 目录，新 worktree 不弹信任提示，6.1 没有覆盖信任提示的自动处理。
  PR #68 之后 worker 使用隔离的 CODEX_HOME，信任弹窗的真实 TUI 行为见上文「Codex 配置隔离」中的 0.166 / 0.167 实测。
- **卡住的任务占住并发槽**：`concurrency: 1` 时，690b74 等用户批准期间，reviewer 任务排队约 2 小时 40 分钟。
  ④ `add-m1-supervisor` 的预留执行槽（D12）处理这个问题。
- **默认 reviewer 在用户主检出里跑 shell**：它请求 `git fetch … :pr28`，会在用户的仓库里留下本地分支。
  ④ 的 pr-reviewer 改由节点准备私有临时 worktree，角色本身没有 shell（D10）。
- **Codex 沙箱内的常见越界**：本地端口监听（测试）和访问 GitHub API（开 PR）都需要越出沙箱，
  使用 `on-request` 的 dev-approval 任务因此出现了两次授权请求。④ 的代回复（D15，见 PR #43）把这类白名单内的请求交给 supervisor。
- 6.2 的提问暴露出 product-res 自身的既有测试失败（`scripts/create-project.test.mjs` 期望值），与 Raindown 无关，
  triage 的建议是修正测试期望。

临时角色 `dev-approval` 在验证后已从 `config/roles/` 删除，未提交到 config 仓库。

当时的本机环境：`~/.codex/config.toml` 信任了 home 目录，并启用了 `approvals_reviewer = "auto_review"`；
worker 加载用户配置，所以新 worktree 不一定出现信任提示，`on-request` 角色也可能由 Codex 自审批准授权请求。
PR #68 起受管 worker 不再加载用户 Codex 配置（见「Codex 配置隔离」），这两点不再影响它们；当时的记录也不能用来证明信任提示处理或审批送达已被覆盖。6.2 验收时另建了上面的 dev-approval 角色，
当时在 `permissions.config` 中显式设 `approvals_reviewer: user`；现在 Raindown 默认即设为 `user`，显式设置仅用于覆盖默认值。
验证审批送达时仍需选择确实需要越出沙箱的操作，再用 task reply 的 approve 走完闭环。
不要为此修改个人 Codex 配置或取消现有 home 信任。

reviewer 的 canUseTool 审批需要选择不在 allowedTools 中、也未被 Raindown 策略自动放行的工具请求；
triage 则需先得到一条真实提问，再用文字回复验证 exec resume。Codex TUI 文本会随版本变化，
识别问题应附脱敏的终端片段，更新 fixture 后再验证。

## 外层 seatbelt 施加（worker-credential-isolation 4.1–4.4）

本阶段实现施加能力，**缺省不施加**。真实开启（tasks 4.5）需要用户同意后在本机执行。

### 开关

```yaml
# config/node.yaml
isolation:
  enforce: false   # 缺省；true 时（仅 macOS）施加外层 seatbelt
```

- 关闭（缺省或不写）：codex-orca 的终端命令、codex-exec 的 spawn 参数、claude-sdk 的 SDK 选项与之前**逐字节一致**
  （快照测试 `codex-orca-executor.test.ts`「外层 seatbelt」与各适配器的“开关关闭”测试锁定），能力声明仍是 `enforced: false`，探针以恒等包裹运行。
- 打开：只在 macOS 上生效（`process.platform === 'darwin'`）；其他平台上开关不起作用，`raindown node start` 打印一行提示，声明与启动都不变。
  改动后重启节点生效。
- 由 `raindown node start` 读取并传给三个执行器与探针（`SeatbeltOptions`）；`pr-merge` 在节点内执行，不涉及。

### 配置生成（4.1）

- 节点为每次 harness 启动重新计算隔离清单（`computeIsolationSpec`，路径已 realpath），用 core 的 `renderSeatbeltProfile` 生成 SBPL，
  原子替换写入任务私有目录 `run/tasks/<任务>/isolation.sb`（0600，不跟随已有的同名链接）。内容只来自节点与角色配置。
  `sandbox-exec` 只在启动时读取配置：执行结束、节点启动清理时删除。
- 结构：`(version 1)(allow default)`，之后依次是：
  1. 最窄允许项（工作目录、派工令牌、harness 目录、中枢端口）；
  2. `deny_read` → `(deny file-read* (subpath …))`，`deny_write` → `(deny file-write* (subpath …))`；
  3. `deny_children_except` → `(deny file-read* file-write* (require-all (subpath <dir>) (require-not (literal <dir>)) (require-not (subpath <keep>))))`；
  4. Orca 运行时目录 → `(deny network-outbound (remote unix-socket (subpath …)))`；已解析的 Orca 端口 → `(deny network-outbound (remote ip "*:<端口>"))`；
     **其他本机端口不拒绝**；
  5. `(deny mach-priv-task-port (target others))`、`(deny mach-task-name (target others))`。
- **允许项写在拒绝项之前（拒绝优先）**，与 `IsolationSpec` 的约定一致：`computeIsolationSpec` 已保证允许项不落在任何读拒绝目录内，
  在 `allow default` 下允许项只作记录；而只读语义（派工令牌、令牌目录、只读工作目录）以写拒绝表示，写在最后才能保证它们即使位于可写目录内也不可写。
- 路径一律内联为 SBPL 字符串字面量，严格转义 `\` 与 `"`；路径含控制字符（C0、DEL、C1，含 NUL、换行、回车、制表符）或不是绝对路径时返回
  `isolation_profile_invalid_path`、不生成配置；端口与操作名同样校验。没有过滤器的规则（会拒绝全部操作）从不生成。
  没有改用 `sandbox-exec -D KEY=VALUE` + `(param …)`：配置文件因此自包含，探针与 worker 共用同一份文件与同一条命令前缀，
  codex-orca 的终端命令也不必为每个参数再做 shell 引号；转义只涉及两个字符，由注入测试（引号、括号、反斜杠、`)(allow default`）
  与 macOS 上的实测（路径含 `we"ird) (allow default\x` 时 `sandbox-exec -f … /bin/cat` 仍然拒绝受保护文件）覆盖。
- Orca 端口：`raindown node start` 目前没有提供端口解析，所以不生成端口规则，探针与 doctor 如实显示 `connect.orca_port` 跳过（“Orca 端口未解析”）。
- 测试：`packages/core/test/isolation-sbpl.test.ts`（快照、注入、控制字符；macOS 上用 `/usr/bin/sandbox-exec -f <生成的配置> /bin/cat`
  对临时目录中伪造的受保护文件实测拒绝、允许文件可读；Linux CI 跳过实测部分）。

### 各适配器的包裹方式

| 执行器 | 施加条件（开关打开且） | 包裹方式 |
| --- | --- | --- |
| codex-orca（4.2） | 角色沙箱设置为 `danger-full-access`（含 bypass） | 终端命令 `cd <worktree> && exec env -u … <赋值…> /usr/bin/sandbox-exec -f <配置> codex … "$(cat state/tasks/<id>/spec.md)"`：`sandbox-exec` 只包住 `codex`，任务说明由沙箱外的外层 shell 读取 |
| codex-exec（4.3） | 角色 `permissions.sandbox` 为 `danger-full-access` | `spawn('/usr/bin/sandbox-exec', ['-f', <配置>, 'codex', 'exec', …])`，进程组与取消不变 |
| claude-sdk（4.4） | 角色沙箱设置为 `bash-sandbox-off`（当前全部 claude-sdk 角色），且不是 supervisor 唤醒会话 | SDK 的 `spawnClaudeCodeProcess` 以 `sandbox-exec -f <配置> <SDK 给出的命令> …` 启动 Claude Code 原生进程，stderr 转交 `stderr` 回调；同时传 `sandbox: { enabled: false }`（flag settings 层，优先于 project / user 设置）强制关闭 bash 沙箱，否则嵌套失败（退出码 71） |

- 隔离清单的输入：工作目录（codex-orca 为任务 worktree，codex-exec 为合同工作目录，claude-sdk 为会话工作目录，审查会话为审查 worktree）、
  读写类别（有效类别 read 时工作目录只读）、本次派工令牌、中枢端口（取自 `RAINDOWN_HUB_URL`），codex 还放行本执行器的 CODEX_HOME。
- **任何一步失败都不启动 harness**，任务以 `failed` 结束并带原错误码：没有中枢地址 `isolation_hub_url_missing`，
  允许路径落在受保护目录内 `isolation_allow_in_deny`（例如工作目录在遗留 home 内、CODEX_HOME 迁移失败仍在 `state/` 下），
  派工令牌不在任务私有目录 `isolation_token_outside_task_dir`，配置不合法 `isolation_profile_*`，写入失败 `isolation_profile_write_failed`。
  这不会静默降级为未隔离运行。
- codex-orca 的恢复与重新挂接：`state/tasks/<id>/orca.json` 记录终端启动时的施加层（`isolation_layer: seatbelt`，开关关闭时不写这个键）。
  开关打开时，会话恢复、派工绑定变化后重启等**新起的终端同样施加**；记录中没有施加层的存活终端（升级前或开关打开前启动，包括仍在旧
  CODEX_HOME 链接路径上的）不重新挂接，任务以 `failed`、原因 `isolation_not_applied` 结束，提示先关闭旧终端。已施加的终端照常重挂接。
- supervisor 唤醒会话不包裹：唤醒绑定的 MCP 按设计（tasks 2.2）仍在本地读取 raindown-home，唤醒令牌在 `state/wake/`，整体拒绝会使其无法工作。
  supervisor 角色是只读配置，属于协调者；这一边界在 6.1 的角色要求中需要单独处理。

### `native`（Codex permissions profile）

本阶段**没有实现**，留给 tasks 5.1：开关打开时 codex-orca、codex-exec 的 `workspace-write`、`read-only` 设置声明为 `none`，
启动方式不变（不能套外层 seatbelt：harness 自带沙箱在其内嵌套会失败），探针不探测这些组合，doctor 显示“施加层为 none，不探测”。

### 已知边界

- 外层 seatbelt 下同一执行器的 harness 凭证（CODEX_HOME 中链接到 `~/.codex/auth.json` 的登录凭证、`~/.claude`）与其他任务的会话记录仍可读（design D2、Risks）。
- 同一用户的进程环境变量可读、可以互相发信号，seatbelt 拦不住（见「隔离实测」第 6 点）。
- worker 内的 `raindown mcp` 进程同样在沙箱内：`raindown` 可执行文件、bun 与 Raindown 仓库必须位于 raindown-home 之外，否则任务绑定的 MCP 无法启动（4.5 验收时确认）。

### 回滚

把 `config/node.yaml` 的 `isolation.enforce` 改回 `false`（或删掉 `isolation` 一节）并重启节点：之后新起的 harness 不再包裹，
能力声明回到 `enforced: false`，探针回到恒等包裹。已在 seatbelt 内运行的 codex-orca 终端继续在其中运行，开关关闭时仍可重新挂接。

### 部署到真实节点后（开关关闭）

不需要改任何配置。harness 的启动方式、能力声明与探针结果都与之前相同；`node.yaml` 只多了一个可选字段（不写即为 `false`）；
任务结束与节点启动时多一次删除 `run/tasks/<任务>/isolation.sb` 的尝试（文件不存在时什么也不做）。doctor 的修复提示措辞改为说明开关。

## 隔离自检探针（worker-credential-isolation 3.1–3.2）

节点自带探针程序（`packages/node/src/isolation-probe/`），用来证明隔离是否真的生效（design D6）。
开关 `isolation.enforce` 关闭时（缺省）**适配器不施加任何隔离**，探针实际以 `none` 方式运行，
受保护项可读，结果是“不通过”。这是要如实上报的状态，不是故障。开关打开后，施加层为 `seatbelt` 的目标以与 worker 相同的配置运行（见「外层 seatbelt 施加」）。

### 运行方式

- 入口：`runIsolationProbe`（节点进程内）为每个执行器 × 沙箱设置（声明的施加层不是 `none`）计算隔离清单（`computeIsolationSpec`），
  推导探针清单（core 的 `buildProbePlan`），再启动子进程 `child.ts` 逐项尝试。子进程在节点进程之外、以探针的临时工作目录为 cwd 运行，
  清单经 stdin 传入，结果经 stdout 返回，环境变量只传 `PATH` 与 `HOME`。
- 同一实际施加层（`applied_layer`）的组合每轮只真正运行一次（受保护文件每轮每个施加层只打开一次），结果复用到同层的其他执行器 × 沙箱设置；
  复用时只按各自的读写类别重新设定 `write.workdir` 的预期。开关关闭时全部是 `none`，所以每轮只运行一次。
- 子进程按与 worker 相同的包裹方式启动：接口接受一个“启动包装”（`launchWrapper(target, argv, { home, taskId, spec })`），
  开关关闭时为恒等；打开时 `raindown node start` 传入 `seatbeltProbeLaunchWrapper`：实际施加层为 `seatbelt` 的目标用与 worker
  相同的生成函数（`renderSeatbeltProfile` + `writeSeatbeltLaunch`）把配置写到探针临时任务目录的 `isolation.sb`，
  以 `/usr/bin/sandbox-exec -f <配置>` 启动探针子进程，配置随临时任务目录删除。
- 运行前在 `run/tasks/isolation-probe-other-<hex>/dispatch-tokens/` 造一个内容明显为假的“他人任务”令牌，
  在 `run/tasks/isolation-probe-self-<hex>/` 造“本任务”令牌，在系统临时目录建工作目录；结束后全部删除
  （中断残留由下次运行与节点启动清理删除；节点启动时还会删除 `config/` 下名字精确为 `.raindown-isolation-probe-<16 位十六进制>` 的残留普通文件）。
- 运行时机：节点启动时（首次注册之前）、每 6 小时、macOS 版本（`sw_vers -productVersion`，每小时检查一次）与上次探针不同时。
  只有 `raindown node start` 开启探针；`startNode` 缺省不运行（测试不触碰真实用户目录）。

### 项目清单

| 项 | 预期 | 做法 |
| --- | --- | --- |
| `read.hub_token` | 拒绝 | 打开 `state/hub.token` 并读取最多 1 字节 |
| `read.ledger_db` | 拒绝 | 同上，`state/raindown.db` |
| `read.other_task_token` | 拒绝 | 同上，临时伪造的他人任务令牌 |
| `read.age_key` | 拒绝 | 同上，age 私钥文件（默认 `~/.config/sops/age/keys.txt`） |
| `read.hub_token_via_symlink` | 拒绝 | 在工作目录建指向 hub.token 的符号链接再读取（验证 realpath 规范化），用后删除 |
| `write.config` | 拒绝 | 在 `config/` 下独占新建探针文件；新建成功即记为“可写”，随后立即删除，删除失败时在说明中写出残留路径 |
| `connect.orca_socket.<n>` | 拒绝 | 对 Orca 运行时目录（及 `daemon/`）中的 unix 套接字只 `connect`，不发送任何数据；没有套接字时为“跳过” |
| `connect.orca_port.<端口>` | 拒绝 | 对解析出的 Orca 本机端口只建立 TCP 连接后立即关闭；端口未解析时为“跳过” |
| `debug.process` | 拒绝 | **未验证**，原因见下 |
| `write.workdir` | 可写（只读角色为拒绝） | 在工作目录独占新建文件后删除 |
| `read.own_task_token` | 可读 | 读取本任务令牌 |
| `connect.hub` | 可连 | `GET /v1/health`（无鉴权） |

- **探针绝不读出受保护文件的内容**：只判断打开/读取是否成功，读取最多 1 字节，字节立即清零丢弃，不记录、不上报、不打印；
  结果只含项名、路径、预期、实际与错误码（`EACCES`、`EPERM` 等），不含错误消息正文。测试用带特征字符串的假文件断言输出中不出现内容。
- 判定：`EACCES`/`EPERM`/`EROFS` 为拒绝；`ENOENT` 为跳过（目标不存在，无法验证）；连接得到 `ECONNREFUSED` 记为拒绝并注明歧义
  （seatbelt 拒绝 unix 连接时 bun 报的也是 `ECONNREFUSED`，与失效套接字、无人监听的端口无法区分）；其他错误为失败。
- **通过**：没有不符合预期的项、没有运行错误，并且核心受保护项 `read.hub_token`、`read.ledger_db`、`read.other_task_token`、`write.config`
  全部出现且确实被拒绝。跳过与未验证不计入通过或失败，但会显示（核心项被跳过同样不能通过）。
- `ok` 与 `passed` 由中枢按预期与实际重新计算后才写入（deny/allow 为 `actual === expected`，skipped/unverified 为 null，error 为 false），节点上报的值不用。
- 探针运行本身抛错时，节点改为上报每个目标都带 `probe_failed` 错误的不通过结果，不继续上报之前的结果。
- 跨进程调试为什么未验证：不需要 sudo、不触碰真实进程的检查都区分不了“隔离生效”与“系统本来就不允许”——`task_for_pid` 需要调试授权，
  未授权的探针进程无论是否隔离都会失败；探针能起的 `/bin/sleep`、bun 都是平台或加固二进制，本来就拒绝 attach。
  探针不 attach 任何进程；seatbelt 配置（4.1）显式拒绝 `mach-priv-task-port`、`mach-task-name`，由配置生成测试覆盖。
- 隔离清单无法计算时（例如遗留 home 是工作目录的祖先，错误 `isolation_allow_in_deny` 写明遗留 home 及其来源变量），该运行记为不通过并带原因。

### 上报与显示

- 结果随节点注册上报（注册请求的可选字段 `isolation_probe`：运行时间、macOS 版本、每个执行器 × 沙箱设置的 `{item, target, expected, actual, ok, detail}`）。
  中枢投影保存最近一次结果；从未上报过的节点（旧节点）显示“未探测”。不带结果的注册（节点重启后探针尚未完成等）沿用之前的结果，
  使“通过 → 不通过”的比较不被打断。旧中枢不认识该字段时，节点告警一次并改为不带结果注册。
- `enforced` 还要求结果不超过 12 小时（`PROBE_MAX_AGE_MS`）：过期结果不算已施加。
- `raindown node list` 与 `raindown doctor`（经中枢读取节点列表汇总）显示每个执行器 × 沙箱设置：声明的施加层、是否已施加、
  最近探针时间与 macOS 版本、失败项（项名与路径）、跳过项与原因、未验证项与原因。
- 探针从通过变为不通过时，中枢写一条 Digest 级收件箱条目（来源 `isolation`）；结果未变化、首次就不通过或从未探测变为不通过都不写。

### 解读 doctor 输出

```text
[warn] 隔离 n-mac-abc123 codex-orca × danger-full-access：声明 seatbelt，未施加；最近探针 2026-11-09T08:00:00.000Z，macOS 15.1（实际以 none 运行）：不通过
         失败 read.hub_token（~/raindown-home/state/hub.token）：预期拒绝，实际 allow
         跳过 connect.orca_port：Orca 端口未解析：没有提供 Orca 端口解析
         未验证 debug.process：…
       修复：适配器尚未施加隔离（config/node.yaml 的 isolation.enforce 为 false、不在 macOS 上或该施加层尚未实现），探针如实报告受保护项可访问
```

- `[warn] … 不通过`：开关关闭时的预期结果（未施加）；实际以 `seatbelt` 运行仍不通过则说明隔离失效（例如 macOS 更新），
  修复提示随之改为“已施加隔离但探针不通过”，不影响退出码。
- `[info] … 未探测`：节点是旧版本或刚启动尚未上报；`[info] … 施加层为 none，不探测`：该沙箱设置不提供隔离。
- `[ok] … 通过`：只有声明已施加且全部通过时才显示“已施加”。
- `[info] 无法从中枢读取节点的隔离自检结果`：中枢未运行，doctor 不能汇总。

### 部署到真实节点后的行为

升级并重启节点后，探针会在用户真实的 raindown-home 上运行：尝试打开真实的 `state/hub.token`、`state/raindown.db`、
`~/.config/sops/age/keys.txt`（只判断能否打开，读取最多 1 字节且立即丢弃，不读出内容），在 `config/` 下尝试新建并立即删除一个
`.raindown-isolation-probe-*` 文件，对 `~/Library/Application Support/orca/` 中的 unix 套接字只建立连接后立即关闭（不发送数据），
`GET` 中枢的 `/v1/health`。开关关闭（缺省）时没有施加隔离，结果会是“不通过”，doctor 显示 warning，不触发收件箱通知（没有“通过”的上一次）。

## 隔离实测（worker-credential-isolation 1.1）

2026-11-07 在本机实测，服务于 `openspec/changes/add-worker-credential-isolation` 的 D1、D2、D4、D6。全程不调用模型。
只用临时目录与临时 `HOME`、`CODEX_HOME`、`RAINDOWN_HOME`、`CLAUDE_CONFIG_DIR`，受保护文件都是伪造的（内容如 `FAKE-HUB-TOKEN-not-a-secret`）。
只读取了 Orca 运行时的元数据（`orca status --json`、`lsof`），没有连接或操作它。
外层 seatbelt 配置样例见 [`worker-isolation.sb`](worker-isolation.sb)。配置本身不含路径，路径全部经 `sandbox-exec -D` 传入。

环境：macOS 15.1（24B2083，Darwin 24.1.0）、codex-cli 0.167.0、Claude Code 2.1.310（Agent SDK 0.3.310 自带的原生二进制）、
bun 1.4.2、gh 2.102.0、git 2.39.5（Apple Git-154）、Orca 1.4.218。

下文的 `$P` 指 `/usr/bin/sandbox-exec -f docs/worker-isolation.sb -D RD_STATE=… -D …`，参数与样例头部注释一致。
`$R` 指临时 raindown-home 的 realpath。

### 1. 嵌套：harness 自带沙箱不能放进外层 seatbelt

| 命令 | 无外层 | 外层 `(allow default)` 或隔离配置内 |
| --- | --- | --- |
| `codex sandbox -P :read-only -- /bin/echo hi` | 0，`hi` | 71，`sandbox-exec: sandbox_apply: Operation not permitted` |
| `codex sandbox -P :workspace -- …`（以及 `-c sandbox_mode="workspace-write"`） | 0 | 71，同上 |
| `codex sandbox -P :danger-full-access -- …` | 0 | 0（这个模式不调用 `sandbox-exec`） |
| `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` | 0 | 71，同上 |

- 结论：Codex 的 read-only 与 workspace-write 都在外层 seatbelt 内失败，失败时命令根本不执行，不会降级为无沙箱运行。
  danger-full-access 与 bypass 不经 seatbelt，可以放进外层。
- codex-cli 0.167.0 已经没有 `codex sandbox macos` 子命令和 `--full-auto` 选项，改用 `codex sandbox [-P <profile> | -c sandbox_mode=…] -- <cmd>`。
- `codex exec` 的会话内命令遇到 71 时，是否会请求越出沙箱重试，需要调用模型才能验证，**未验证**。
- Claude Code 的 bash 沙箱：不调用模型无法触发 Bash 工具，**未直接验证**。它在 macOS 上同样经 `sandbox-exec` 执行命令，
  由上面的内核行为推断：在外层 seatbelt 内会以同样方式失败。
  `claude sandbox status` 在外层 seatbelt 内仍报告 `enabled: true`、`unavailableReason: null`，它不探测能否嵌套，不能用来发现这个问题。

### 2. 外层 seatbelt 下的受保护资源与工具链

复现：`$P cat $R/state/hub.token`。其余各项同理，把命令换掉即可。用 `docs/worker-isolation.sb` 整体复测，22 项全部符合预期。

| 类别 | 操作 | 结果 |
| --- | --- | --- |
| 拒绝 | 读 `state/hub.token`、`state/ledger.db`、他人派工令牌、本任务目录内的其他文件；`ls state/` | `Operation not permitted` |
| 拒绝 | 写或新建 `config/` 下的文件；`mv config config2` | `Operation not permitted` |
| 拒绝 | 读 `~/.config/sops/age/keys.txt`，读 Orca 目录内的 token，写 `~/Library/LaunchAgents/x.plist` | `Operation not permitted` |
| 拒绝 | 经符号链接、硬链接、`cp` 间接读 hub.token；`bun -e readFileSync(hub.token)` | 全部失败 |
| 放行 | `cat` 或 `bun` 读本任务派工令牌（deny 目录内 allow 单个文件） | 成功 |
| 放行 | 写本任务派工令牌（只放行了读） | 失败（符合预期） |
| 工具链 | `codex --version`、`codex exec --help`、`codex features list`（CODEX_HOME 在 `state/` 下并已放行） | 成功 |
| 工具链 | Claude Code 原生二进制 `--version`、`bun --version`、`gh --version`、工作目录内 `git init` 与 `commit` | 成功 |

规则优先级（两份只含 `(allow default)`、一条 deny、一条 allow 的配置，只调换后两条的顺序作对照）：

- SBPL 按出现顺序求值，同一操作**后写的规则优先**。`deny subpath state` 写在前、`allow literal <token>` 写在后时，令牌可读。
  顺序反过来时，令牌也读不到。D2 的“后者优先、允许项写得最窄”可以直接落地。
- **被拒目录内的放行路径还需要祖先目录的元数据。** 只放行文件本身时，`cat`、`stat` 和 `bun` 的 `realpathSync` 都成功，
  但 libc `realpath()` 会失败（`/bin/realpath`、Rust 的 `canonicalize`）。Codex 因此报错退出：
  `failed to canonicalize CODEX_HOME`。补上 `(allow file-read-metadata (literal <每一级祖先目录>))` 之后恢复正常，
  `ls state/` 仍然失败，所以只泄露“目录存在”和时间戳。

realpath 的影响：

| 规则中的路径 | 访问路径 | 结果 |
| --- | --- | --- |
| `/private/tmp/…/state`（realpath） | `/tmp/…/state/hub.token` 或 `/private/…` | 拒绝 |
| `/tmp/…/state`（经符号链接） | 任一写法 | **放行**（规则不匹配） |
| `$TMPDIR` 原样（`/var/folders/…`） | `/var/folders/…` | **放行** |
| `/private/var/folders/…` | `/var/folders/…` | 拒绝 |
| 指向 raindown-home 的符号链接路径 | 符号链接路径或真实路径 | **放行** |
| 真实路径 | 符号链接路径 | 拒绝 |

- seatbelt 按解析后的真实路径匹配。规则写了未规范化的路径，会**静默失效（放行）**。
  所以 D1 要求的 realpath 规范化是正确性前提，探针必须覆盖这一点。
- 用 `-D` 传参时，路径中的 `"`、`)`、`(` 按字面量处理（测试路径 `we"ird) (allow default`），不会改变配置结构。
  4.1 生成配置时建议优先用参数；若改为内联字符串，必须做转义测试。

### 3. Unix 套接字与本机端口

用 bun 在 `$TMPDIR` 下模拟两个 unix 套接字（orca.sock、other.sock）和两个本机 TCP 端口（中枢端口与其他端口）。

| 配置 | `nc -U orca.sock` | `nc -U other.sock` | 中枢端口 | 其他本机端口 |
| --- | --- | --- | --- | --- |
| `(deny network-outbound (remote unix-socket (path-literal <sock>)))` + `(deny network-outbound (remote ip "localhost:*"))` + `(allow … "localhost:<hub>")` | 拒绝（bun 报 `ECONNREFUSED`） | 成功 | 成功 | 拒绝 |
| 只写 `(deny file-read* file-write* (subpath <sockdir>))` | **成功** | 成功 | 成功 | 成功 |
| `(deny network-outbound (remote unix-socket (subpath <sockdir>)))` | 拒绝 | 拒绝 | 成功 | 成功 |

- 可以按路径（`path-literal`）或目录（`subpath`）拒绝 unix 套接字连接，同时放行本机 TCP 端口。也可以只放行中枢一个端口。
- **文件规则拦不住 `connect()`**，必须单独写 network 规则。
- 经 `/var` 路径或指向套接字的符号链接去连接，同样被拒绝（按真实路径匹配）。
- 真实 Orca 运行时的控制通道（只读查看，未连接）：
  - `orca status --json` **不输出**控制通道路径，只有 `runtimeId`、`app.pid` 等字段；
  - `lsof` 显示 app 进程监听 `~/Library/Application Support/orca/o-<app pid>-<runtimeId 前 4 位>.sock`；
  - 守护进程使用 `~/Library/Application Support/orca/daemon/daemon-v<N>.sock`，同目录还有 `daemon-v<N>.token`，路径出现在 argv 中；
  - app 进程另外监听本机 TCP 端口（实测 `localhost:60211` 和 `*:10129`），用途未查。
  - 建议：D2 不再“由 `orca status` 解析套接字”，改为对整个 `~/Library/Application Support/orca/` 同时拒绝文件读写与 unix 连接，
    并对本机 TCP 只放行中枢端口。

### 4. harness 原生的按路径读限制

**Codex：有，并且可靠（只覆盖沙箱内执行的命令）。** 0.167.0 支持 permissions profile（[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)）。
在临时 `CODEX_HOME/config.toml` 中写入：

```toml
[permissions.rd]
extends = ":workspace"            # 只读角色用 ":read-only"

[permissions.rd.filesystem]
"<raindown-home>/state" = "deny"
"<raindown-home>/config" = "deny"
"<home>/.config/sops/age" = "deny"
"<raindown-home>/state/tasks/<task>/dispatch.token" = "read"

[permissions.rd.network.unix_sockets]
"<orca 套接字>" = "deny"
```

| 命令（`cd <work>`） | 结果 |
| --- | --- |
| `codex sandbox -P rd -- cat <state>/hub.token`；`ls <state>`；读 config、age 私钥、他人令牌 | 全部 `Operation not permitted` |
| `codex sandbox -P rd -- cat <本任务令牌>`（deny 目录内 `"read"` 单个文件） | 成功 |
| `-P rd` 下写工作目录 / 写 config | 成功 / 失败 |
| profile 中写 `/tmp/…`（非 realpath） | 仍然拒绝：Codex 自己会规范化路径 |
| 在 `-P rd` 之外再加 `-c sandbox_mode="workspace-write"`；或用 `-c default_permissions="rd"` 代替 `-P` | 仍然拒绝 |
| 不用 profile：`-P :workspace` 或 `-c sandbox_mode="workspace-write"` | **可读 hub.token**（印证 design：workspace-write 不限制读） |
| `-P :workspace` 与 `-P rd` 下 `nc -U` 任意套接字 | 拒绝（默认不允许 unix 套接字）；`:danger-full-access` 下成功 |
| `-P :workspace` 下读 `$CODEX_HOME/config.toml` | 可读：Codex 不会自动保护自己的目录 |

局限：

- profile 只约束 Codex 在沙箱内执行的命令。以下几类不受约束：
  - Codex 进程本身及其内置工具；
  - MCP 服务器进程（任务绑定的 raindown MCP 是可信代码）；
  - 经审批**越出沙箱**执行的命令（on-request 角色）。
    `required` 角色的审批（包括 supervisor 代回复，D15）必须把越出沙箱视为解除隔离。
- 两个执行器目前都用 `-s <mode>`（codex-orca 见 `executor.ts`，codex-exec 见 `codex-exec.ts`）。
  官方文档要求 `default_permissions` 不与 `sandbox_mode` 混用。`codex exec -s workspace-write -c default_permissions=…` 的实际优先级
  需要调用模型才能在会话里验证，**未验证**。建议 5.1 改为不传 `-s`，只传 `-c default_permissions="<生成的 profile>"`，并保留探针。
- 文档注明 deny 的 glob 在部分平台上于沙箱启动前展开。建议只用具体目录（`subpath` 语义），不用 glob。
- 好处：Codex 进程本身不在沙箱内，所以 profile 可以额外 deny 共享的 `CODEX_HOME/sessions`、`auth.json` 以及它链接到的源文件，
  命令读不到，harness 照常工作。外层 seatbelt 做不到这一点，见第 7 点。

**Claude Code：有 OS 级配置，但只覆盖 Bash 工具，不能单独作为 `required` 的依据。** SDK 0.3.310 的 `Options.sandbox`
（`SandboxSettings`，`sdk.d.ts`）提供以下设置：

- `filesystem.denyRead`、`filesystem.allowRead`：后者在 denyRead 区域内重新放行，并优先于 denyRead；
- `filesystem.denyWrite`、`filesystem.allowWrite`；
- `network.allowUnixSockets`（macOS 按路径，默认阻止 unix 套接字）；
- `allowUnsandboxedCommands`（设为 `false` 时忽略 `dangerouslyDisableSandbox`）；
- `failIfUnavailable`（SDK 设置 `enabled: true` 时默认为 `true`）；
- `credentials.files[].mode: deny`（macOS 上 `mask` 退化为 `deny`）。

类型注释写明，这些限制作用于“sandboxed commands”，也就是 Bash 工具。Read、Grep、Glob、Edit 等工具运行在 harness 进程内，
只受 `Read(…)`、`Edit(…)` 权限规则约束，属于工具级限制。hooks 和 MCP 服务器不在沙箱内；`excludedCommands` 也在沙箱外运行。
不调用模型时能验证到的程度：SDK 会把 `sandbox` 选项序列化为 `--settings '{"sandbox":{…,"failIfUnavailable":true}}'`
（见第 5 点的截获结果）；`claude --settings … sandbox status` 能读出 `enabled: true`、`strictMode`。
Bash 命令实际被拒绝，需要调用模型才能验证，**未验证**。`enableWeakerNestedSandbox` 只对 Linux 有效。

### 5. claude-sdk 的包裹点

SDK 0.3.310 有三个相关选项：

- `pathToClaudeCodeExecutable`：替换可执行文件；
- `executable` / `executableArgs`：只用于 JS 运行时，对原生二进制无意义；
- `spawnClaudeCodeProcess(options: SpawnOptions) => SpawnedProcess`：自定义启动。
  `SpawnOptions` 含 `command`、`args`、`cwd`、`env`、`signal`；`ChildProcess` 本身满足 `SpawnedProcess`。

实测：`spawnClaudeCodeProcess` 返回一个立即退出的假进程，不启动 Claude Code，因此不发出请求。截获的 `command` 是
`…/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`（原生二进制），`args` 为
`--output-format stream-json --verbose --input-format stream-json [--settings …]`。
把截获的 `command` 用 `$P <command> --version` 在隔离配置内启动，成功（`2.1.310 (Claude Code)`）。可行写法：

```ts
spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) =>
  spawn('/usr/bin/sandbox-exec', ['-f', profilePath, ...profileParams, command, ...args], {
    cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'],
  }),
```

- 这样包裹后，Read、Grep 等进程内工具、hooks、MCP 子进程都继承外层 seatbelt，覆盖面比 Claude 的 bash 沙箱更完整。
- 前提：此时不能同时开启 Claude 的 bash 沙箱（否则嵌套失败）。Raindown 目前的 claude-sdk 没有传 `sandbox` 选项，即 bash 沙箱关闭。
- 不建议用 `pathToClaudeCodeExecutable` 指向包装脚本：配置路径需要按任务变化，`spawnClaudeCodeProcess` 更直接，也便于测试 argv。
- 注意 harness 自己的凭证路径：CLAUDE_CONFIG_DIR 和 macOS 钥匙串（OAuth 凭证）需要保持可用。钥匙串经 mach 服务访问，
  `allow default` 不拦截；worker 内的 `security` 命令能否取出凭证，本次没有在真实钥匙串上验证。

### 6. 跨进程调试与观察（同一用户）

目标都是本次临时启动的进程：`/bin/sleep` 是 Apple 平台二进制；另外编译了一个 ad-hoc 签名、没有 hardened runtime 的 C 程序，
模拟未加固的节点进程。

| 操作（在外层 seatbelt 内执行） | `(allow default)` | 追加 `(deny mach-priv-task-port (target others))`、`(deny mach-task-name (target others))` |
| --- | --- | --- |
| `lldb -p <未加固进程>` | **attach 成功**（进程被 SIGSTOP） | `Not allowed to attach to process` |
| `lldb -p /bin/sleep`；`dtrace -p` | 失败（平台二进制或 hardened；DTrace 受 SIP 限制） | 失败 |
| `sysctl KERN_PROCARGS2` 读目标进程的 argv 和**环境变量** | **可读** | **仍可读**；`process-info*`、`sysctl-read` 规则都拦不住 |
| `kill -TERM <目标>` | 成功 | `(deny signal (target others))` 也拦不住；只有不带过滤的 `(deny signal)` 能拦，但同时禁止向自己的子进程发信号 |
| `/bin/ps` | `execvp … Operation not permitted`（setuid 程序不能在沙箱内执行） | 同左 |

- 结论：design 的“seatbelt 默认拒绝跨进程调试”**不成立**。在 `allow default` 下，worker 可以调试同一用户的未加固进程，
  必须显式加入上表的两条 mach 规则（样例已包含）。bun、Codex 等 hardened 二进制本来就拒绝 attach。
- 拦不住的部分：worker 仍能读取同一用户其他进程启动时的环境变量，也能向它们发信号。
  所以凭证不能放在长期运行的同用户进程的环境变量里（例如以 `RAINDOWN_HUB_TOKEN` 启动的节点），应改用 0600 文件加 deny 规则。
  “worker 能杀掉节点”是外层 seatbelt 无法消除的边界，只有独立系统用户能解决。

### 7. 其他发现

- **CODEX_HOME 位于 `state/` 下**（`state/codex-orca-home`、`state/codex-exec-home`、`state/codex-read-home`）。
  外层 seatbelt 整体 deny `state/` 时，必须放行该目录及其祖先元数据，否则 Codex 无法启动。
  放行后，worker 能读到同一执行器其他任务的会话记录（实测读到了伪造的 `sessions/other-task/rollout.jsonl`），
  也能经 `auth.json` 链接读到 Codex 登录凭证。harness 和它执行的命令在同一个沙箱里，外层 seatbelt 无法区分两者。
- 派工令牌同样位于被拒目录内，需要逐级的祖先元数据规则。把 CODEX_HOME 与任务私有目录移出 `state/`，配置会简单很多。
- 后续：1.2 已把 CODEX_HOME 与派工令牌移到 `run/`（见「`run/` 目录」），上文实测时的路径是迁移前的布局。

### 施加层建议（D1：适配器 × 沙箱设置）

| 适配器 | 沙箱设置 | `credential_isolation` | 方式 | 备注 |
| --- | --- | --- | --- | --- |
| codex-orca | danger-full-access / bypass（默认 dev） | `seatbelt` | 终端命令改为 `cd … && exec /usr/bin/sandbox-exec -f <profile> -D … env … codex …` | 需要放行 CODEX_HOME 及其祖先元数据；同一执行器的会话记录与 `auth.json` 仍可读（见第 7 点） |
| codex-orca | workspace-write / read-only | `native` | 生成的 profile 中 `[permissions.<name>.filesystem]` 写 deny；不传 `-s`，改传 `-c default_permissions=…` | 越出沙箱的审批即解除隔离；`-s` 与 profile 的组合未验证 |
| codex-exec | danger-full-access | `seatbelt` | `spawn('/usr/bin/sandbox-exec', ['-f', profile, …, 'codex', …])` | 同 codex-orca |
| codex-exec | workspace-write / read-only（默认 read-only） | `native` | 同 codex-orca | 同上 |
| claude-sdk | bash 沙箱关闭（当前默认） | `seatbelt` | `spawnClaudeCodeProcess` 包裹 `sandbox-exec` | 覆盖进程内工具、hooks、MCP |
| claude-sdk | bash 沙箱开启 | `none` | 不提供 | 原生 denyRead 只覆盖 Bash，Read 等工具靠权限规则，不足以支撑 `required`；建议这类角色关闭 bash 沙箱，改走 `seatbelt` |
| pr-merge | 节点内执行，不启动 harness | `none` | 不适用 | 节点属于可信计算基 |

`separate_user` 目前不需要作为默认施加层。它只在以下几种边界不可接受时才有必要，届时按 5.1 写出方案，交给用户决定：

- 同用户读取进程环境变量、发信号；
- 外层 seatbelt 下的 harness 凭证与共享会话可读；
- Codex 越出沙箱审批。

### design 需要修订的地方

1. D1：Codex 有可靠的原生读限制（permissions profile 的 `"deny"` / `"read"`），可以声明为 `native`；
   Claude Code 的原生限制只覆盖 Bash，claude-sdk 开启 bash 沙箱时声明为 `none`。
2. D2 的 Orca 控制套接字：`orca status` 不输出其路径。改为对 `~/Library/Application Support/orca/` 整体拒绝文件读写与 unix 连接，
   并对本机 TCP 只放行中枢端口（Orca 另有本机 TCP 监听端口）。
3. D2 的允许清单：放行位于被拒目录内的路径时，要为每一级祖先目录生成 `file-read-metadata` 规则；
   或者把 CODEX_HOME、任务私有目录移出 `state/`（推荐）。另外写明，同一执行器的 Codex 会话记录在外层 seatbelt 下仍可读。
4. D1 的 realpath 要求由“规范化”升级为正确性前提：未规范化的规则静默放行。D6 的探针应包含经符号链接路径访问受保护文件这一项。
5. Risks 中的“seatbelt 默认拒绝跨进程调试”不成立。配置需要显式加入 `mach-priv-task-port` 和 `mach-task-name` 拒绝规则。
   同时补充两条拦不住的边界：同用户进程的环境变量可读、可以发信号；并要求节点凭证不经环境变量传递。
6. D4/D5：采用 `native` 的 Codex 角色，审批越出沙箱即解除隔离。`required` 角色的授权请求（包括 supervisor 代回复）需要单独标注或拒绝。
