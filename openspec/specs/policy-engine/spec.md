# policy-engine Specification

## Purpose
用"范围 × 动作 × 档位"的统一模型，决定执行器的审批请求由谁来答复，让用户只处理自己真正关心的那部分（PRD §10）。

## Requirements

### Requirement: 策略配置
策略 SHALL 写在 `config/policies.yaml` 中，每条规则包括：
- `scope`：`ws/<id>`、角色名或 `*`；
- `action`：动作 id，支持通配符，例如 `tool:Bash`、`git.push`、`pr.create`；
- `level`：`notify`、`draft-approve`、`auto-report`、`auto` 之一；
- `when`：可选条件，例如命令前缀、文件路径通配。

配置不合法时 MUST 拒绝加载该条规则并报告，其余规则照常生效。

#### Scenario: 一条规则写错
- **WHEN** `policies.yaml` 中有一条规则的 level 是 `always`
- **THEN** 该规则不生效，`raindown hub status` 报告该错误，其他规则正常工作

### Requirement: 动作识别
执行器的审批请求 SHALL 被映射成一个或多个动作 id：
- 工具调用映射为 `tool:<工具名>`；
- Bash 或 Codex 的命令再按前缀映射为更具体的动作，例如 `git push` 映射为 `git.push`，`gh pr create` 映射为 `pr.create`，`gh pr merge` 映射为 `pr.merge`，`wrangler deploy` 映射为 `deploy`。

映射表 SHALL 可以扩展。

#### Scenario: 命令映射
- **WHEN** Claude 请求执行 `git push origin feat-x`
- **THEN** 该请求被识别为 `tool:Bash` 与 `git.push`

### Requirement: 判定顺序
对一个请求，系统 SHALL 选出所有匹配的规则，取最具体的一条：
1. scope 为具体 workspace 的，优先于角色，角色优先于 `*`；
2. 同一层级内，具体的 action 优先于通配符；
3. 仍然并列时，取更保守的档位。

没有任何规则匹配时，请求交给用户。判定结果 MUST 记入 `policy.decided` 事件，包括请求、命中的规则和结果。

#### Scenario: 具体规则优先
- **WHEN** 有两条规则 `scope: * action: git.push level: auto` 和 `scope: ws/xuanxue-saas action: git.push level: draft-approve`，此时 xuanxue-saas 的任务请求 `git push`
- **THEN** 判定为 `draft-approve`，生成收件箱条目等待用户

### Requirement: 档位行为
各档位 SHALL 按以下方式处理命中的请求：
- `auto`：系统以 `policy` 身份直接批准，不生成条目；
- `auto-report`：直接批准，并生成一条 Digest 条目；
- `draft-approve`：生成 Decide 级别以上的条目，等用户批准或驳回；
- `notify`：同 `draft-approve`，但条目级别为 Interrupt。

#### Scenario: 自动放行并汇报
- **WHEN** 一条 `auto-report` 规则命中了 `pr.create`
- **THEN** 该请求被立即批准，任务不进入 `blocked`，当天的每日摘要中出现这次操作

### Requirement: 不可自动放行的动作
`pr.merge`、`deploy`、`secrets`、`shell.opaque`、策略文件的修改（`policy.edit`）、raindown-home `config/` 下任何文件的修改（`config.edit`），以及 raindown MCP 中会扩大权限的操作（`task.create`、`task.cancel`、`task.reply`、`proposal.decide`、`resource.transfer`），在用户没有显式配置时 SHALL 一律交给用户；即使命中了 `scope: *` 或通配 action 的 `auto` 规则，也 MUST 只有 scope 为具体 workspace 或角色、且 action 不含通配符的规则才能自动放行它们。

请求涉及受保护的工具时——Codex 越出沙箱的命令（`tool:CodexCommand`）、所有 MCP 工具（`tool:mcp__*`）、外发工具（`tool:WebFetch`、`tool:WebSearch`）、派生子 agent（`tool:Task`）——参与判定的每个动作 MUST 只由 action 不含通配符的规则自动放行；`*`、`tool:*`、`tool:mcp__*` 这类通配规则最多判为 `draft-approve`。

经 Bash 调用 raindown CLI 完成同样的操作时 MUST 识别为同样的动作，raindown 的管理命令（hub、policy、daemon 等）识别为受保护的 `raindown.admin`；命令直接访问中枢端口时 MUST 按无法确定处理。

识别策略或配置文件时 MUST 不区分大小写；命令中出现 glob、变量展开或命令替换且涉及 `config` 或 `polic` 时，MUST 按无法确定处理（视为可能修改策略与配置）；节点 MUST 把路径解析符号链接后的真实位置与原路径一并送去判定。

#### Scenario: 通配规则不能放行合并
- **WHEN** 只有一条 `scope: * action: * level: auto` 规则，此时某任务请求 `gh pr merge`
- **THEN** 请求交给用户，收件箱生成条目

#### Scenario: 通配规则不能放行受保护的工具
- **WHEN** 只有一条 `scope: dev action: tool:* level: auto` 规则，此时 dev 角色的 Claude 调用 `mcp__raindown__task_create`，或 Codex 请求越出沙箱执行 `rm -rf ~`
- **THEN** 两个请求都交给用户；改为显式规则 `scope: dev action: task.create level: auto` 或 `scope: ws/a action: tool:CodexCommand level: auto` 后，对应请求才可自动放行

#### Scenario: 策略文件的变体写法
- **WHEN** 只有 `scope: * action: tool:* level: auto` 规则，请求的命令为 `sed -i … ~/raindown-home/config/polic*.yaml`，或写入 `~/raindown-home/CONFIG/Policies.yaml`，或编辑一个指向策略文件的符号链接
- **THEN** 请求被识别为 `policy.edit`，交给用户

### Requirement: 项目改名期间的策略兼容
加载策略 SHALL 将 `tool:mcp__flow__<操作>` 规范化为 `tool:mcp__raindown__<操作>`，将 `flow.admin` 规范化为 `raindown.admin`；保留规则档位和原始索引，并在 hub status 与 doctor 中报告迁移 warning，不作为无效规则排除。受保护命令识别 SHALL 将 raindown 与 flow 两个可执行前缀视为同一动作；新旧 home 的配置路径同样受保护。

#### Scenario: 旧 MCP 限制继续生效
- **WHEN** 旧工具名规则要求人工处理 task_create，调用新 `mcp__raindown__task_create`
- **THEN** 规则继续拦住自动放行，并报告旧名迁移 warning

#### Scenario: 别名不能绕过受保护动作
- **WHEN** 执行 `raindown secrets get` 或 `flow secrets get`，或两种前缀的 hub 管理命令
- **THEN** 分别识别为相同的 secrets 或 raindown.admin 动作

### Requirement: 策略版本
系统 SHALL 为每次加载的 `policies.yaml` 计算版本哈希（对规范化后的有效规则计算，注释与空白不影响哈希），并在 `policy.decided`、代回复委托与 supervisor 的代批代答记录中写入该哈希。`raindown hub status` 与 `raindown doctor` MUST 显示当前策略版本。

#### Scenario: 只改了注释
- **WHEN** 用户只修改了 `policies.yaml` 里的注释
- **THEN** 策略版本哈希不变，不产生策略变化事件

#### Scenario: 追溯一次代批
- **WHEN** 用户查看 supervisor 代批 `pnpm check` 的记录
- **THEN** 记录中有当时的策略版本哈希与命中的规则
