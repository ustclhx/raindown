# Design

## Context

动机见 proposal.md。与设计相关的现状：
- 节点与所有 worker 以同一系统用户运行。`state/hub.token` 等文件是 0600，但同用户进程都能读。
- 三类 harness 进程的启动方式不同：
  - codex-orca：节点通过 Orca 在终端里执行一条 `cd … && exec env … codex …` 命令，进程属于 Orca 的 PTY。
  - codex-exec：节点直接 spawn `codex exec`。
  - claude-sdk：节点经 Agent SDK 启动 Claude Code 原生进程。
- harness 自带沙箱也用 macOS seatbelt：Codex 在 workspace-write / read-only 下每条命令都经 `sandbox-exec` 执行，Claude Code 的 bash 沙箱同理。
- **已实测**：在 seatbelt 内再调用 `sandbox-exec` 会失败（`sandbox_apply: Operation not permitted`，退出码 71）。所以外层 seatbelt 与 harness 自带沙箱不能嵌套。
- Codex 的 workspace-write 沙箱默认只限制写，不限制读，因此开了沙箱的角色同样能读到 `hub.token`。但 1.1 实测发现 Codex 的 permissions profile（`[permissions.<name>.filesystem]` 中的 `"deny"`）可以按路径拒绝读取，且可靠（见 `docs/executors.md`“隔离实测”）。
- Claude Code 的 bash 沙箱 `denyRead` 只作用于 Bash 工具，Read、Grep 等进程内工具不受它约束。
- 任务绑定的 MCP（PR #81/#84）在 worker 侧进程里本地读取 raindown-home 来执行 kb 操作。
- 密钥私钥位于 `~/.config/sops/age/keys.txt`，拿到它就能解密 `config/secrets.sops.yaml`。

## Goals / Non-Goals

**Goals:**
- 受保护资源对 worker 不可读写，覆盖所有角色，不论 harness 自带沙箱开不开。
- 机制落在适配器契约里，与 harness 无关：节点生成隔离描述，适配器选择施加方式。
- 有可重复运行的探针证明隔离生效，失败时不静默降级。

**Non-Goals:**
- 不防御已经拿到内核或用户凭证（登录密码、sudo）的攻击者。
- 不在本变更中实现 Linux。
- 不处理 GitHub 身份共享（另立变更），也不限制 worker 的外网访问。

## Decisions

### D1. 统一的隔离描述，适配器选择施加层
节点为每次派工生成 `IsolationSpec{deny_read[], deny_write[], allow_read[], allow_write[], allow_unix_sockets[], allow_local_ports[]}`。路径一律规范化为 realpath，这是正确性前提而不只是整洁：seatbelt 按真实路径匹配，未规范化的规则（例如 `/var/…` 而真实路径是 `/private/var/…`）会静默不生效。规范化在生成配置时做，不存在的路径按其最近的已存在祖先规范化后拼回。适配器把它落到三种施加层之一：
- **外层 seatbelt**：用于 harness 自带 OS 沙箱关闭的情况（danger-full-access、bypass）。节点生成 SBPL 配置，用 `sandbox-exec -f` 启动 harness。配置以 `allow default` 为基础，显式 deny 受保护资源，避免误伤 harness 的正常运行。
- **harness 原生的读限制**：用于 harness 自带沙箱开启、无法嵌套的情况。1.1 实测结论：
  - Codex 支持：Raindown 在其管理的 CODEX_HOME 中生成 permissions profile，受保护路径写 `"deny"`，启动时不传 `-s`，改传 `-c default_permissions=<name>`。声明为 `native`。
  - Claude Code 不支持可靠的原生读限制（`denyRead` 只覆盖 Bash）。claude-sdk 开启 bash 沙箱时声明为 `none`；需要隔离的角色应关闭 bash 沙箱，改由外层 seatbelt 施加。
- **独立系统用户**：最稳妥的退路，与 harness 沙箱完全正交。worker 以专用用户运行，受保护资源仍由主用户持有（0700）。代价有三：需要用户批准系统级改动（新建用户、sudoers 规则）；harness 凭证需要为该用户单独登录或经 Raindown 注入；worktree 需要共享组权限。只在前两层都不可行时启用，并且需要用户在实施时明确同意。
- 适配器能力 `credential_isolation` 取值为 `seatbelt | native | separate_user | none`，按角色的沙箱设置分别声明。中枢按能力派送。按 1.1 的结论：

  | 适配器 | 沙箱设置 | 施加层 |
  | --- | --- | --- |
  | codex-orca、codex-exec | danger-full-access / bypass | `seatbelt` |
  | codex-orca、codex-exec | workspace-write / read-only | `native` |
  | claude-sdk | bash 沙箱关闭 | `seatbelt`（经 SDK 的 `spawnClaudeCodeProcess` 包裹 `sandbox-exec`） |
  | claude-sdk | bash 沙箱开启 | `none` |
  | pr-merge | 节点内执行 | `none`（节点属于可信计算基） |

- `native` 的边界：Codex 越出沙箱的审批（例如批准一条 danger 命令）会让那条命令脱离隔离。见 D5。
- 备选：所有角色都关掉 harness 沙箱，由外层 seatbelt 同时承担 workspace-write 语义。否决：Codex 的授权弹窗（Raindown 的授权流程依赖它）取决于自身沙箱模式，关掉沙箱会改变授权语义。

### D2. 受保护资源清单由节点集中计算
节点在 core 中维护受保护资源清单：
- raindown-home 下的 `state/`、`config/`；
- 密钥私钥目录；
- `~/Library/LaunchAgents`；
- Orca 运行时目录 `~/Library/Application Support/orca/` 整体：拒绝文件读写与其中 unix 套接字的连接。1.1 实测 `orca status` 不输出控制套接字路径，所以不按单个套接字解析，而是整个目录拒绝；Orca 另有本机 TCP 监听端口，由节点在运行时解析（例如从该目录中的运行时文件或 Orca 进程的监听端口）并拒绝；
- 节点自己的锁文件与日志；
- 跨进程调试：显式拒绝 `mach-priv-task-port` 与 `mach-task-name`。1.1 实测 seatbelt 在 `allow default` 下默认允许 attach 同用户进程，不会自动拒绝。

允许资源包括：
- 本任务工作目录；
- 本任务私有目录中的派工令牌文件；
- 适配器声明的 harness 目录，例如 Raindown 管理的 CODEX_HOME，以及 Codex/Claude 登录所需的路径；
- 中枢监听的本机端口；其余本机端口不默认拒绝（worker 自己起的 dev server、测试服务器需要可用），只拒绝上面解析出的 Orca 端口等已知控制端口。

seatbelt 的规则后者优先，允许项写得最窄（具体文件，而不是整个私有目录）。

允许项不应位于被拒目录之内：在被拒目录里放行一个文件，需要为它的每一级祖先目录额外生成 `file-read-metadata` 规则，否则 harness 无法解析路径。因此把 Raindown 管理的 CODEX_HOME 与任务私有目录（派工令牌文件所在处）移出 `state/`，放在 raindown-home 下单独的 `run/` 目录（按执行器、按任务分子目录，0700），`state/` 与 `config/` 保持整体拒绝。迁移时节点在启动时把旧位置的 CODEX_HOME 移到新位置。

已知残留：同一执行器下其他任务的 Codex 会话记录与 harness 登录凭证（例如 CODEX_HOME 中的 `auth.json`）在外层 seatbelt 下仍可读，因为 harness 自身需要它们。按任务分 CODEX_HOME 之前，这一边界写入文档。

### D3. 任务绑定的 kb 读取改经中枢
中枢新增只读路由，只接受任务绑定令牌，执行 kb_search / kb_get / kb_query。任务绑定的 MCP 改为调用这些路由。可见范围按 knowledge-access 现有规则计算该任务所属 workspace 可见的条目：本 workspace 加 global，其他 workspace 拥有的条目不返回，这比现在本地读取更严。这样 worker 侧进程无需读取 raindown-home，D2 可以整体 deny raindown-home 下的 `state/` 与 `config/`，`brain/` 也可以一并 deny。

### D4. 控制通道
- 中枢访问只允许本机端口，凭证只有派工令牌。
- Orca 运行时目录与其本机端口在受保护清单内：worker 不能操作其他终端，也不能批准自己的弹窗。codex-orca 的 harness 运行在 Orca 终端里，这不需要访问控制通道。
- 节点的凭证（例如 `RAINDOWN_HUB_TOKEN`）MUST NOT 经环境变量传给 harness，节点进程自身也不应把 user 令牌放在环境变量里：同用户进程可以读取其他进程的环境变量（`ps eww`），seatbelt 拦不住。
- `launchctl`：不单独拦截，因为 plist 目录不可写，无法安装持久服务。

### D5. 角色的隔离要求与默认值
- `isolation` 默认 `preferred`。任务 1.1 的实测通过后，升级说明建议把 dev 类角色改为 `required`。之后的版本在 doctor 通过时把写类角色的默认值改为 `required`。
- `required` 不满足时，任务以 `blocked(other)` 并带原因 `isolation_unavailable` 停下，不启动 harness。
- 施加层为 `native` 的 `required` 角色：越出 harness 沙箱的授权请求会让该命令脱离隔离。这类请求在收件箱与 supervisor 代回复输入中标注“批准将脱离隔离”，supervisor 不得代批，只能转给用户。

### D6. 自检探针
探针与 worker 走同一个施加层，运行节点自带的检查程序，逐项尝试：
- 读取 hub.token、账本数据库、他人任务令牌（临时造一个）和私钥，以及经符号链接路径读取同一受保护文件（验证 realpath 规范化）；
- 写入 config；
- 连接 Orca 控制套接字。

全部失败才算通过；同时确认工作目录可写、派工令牌可读、中枢端口可连。
- 运行时机：节点启动时、每 6 小时一次，以及 macOS 版本变化后。
- 结果随节点注册上报，`doctor` 与 `hub status` 读取。

## Risks / Trade-offs

- [`sandbox-exec` 已被 Apple 标记弃用] → 继续可用，且 Codex、Claude Code 自身都依赖它。探针定期验证。一旦失效，`required` 角色停止派工而不是静默放行。
- [外层 seatbelt 的 deny 规则遗漏新增的敏感文件] → 以目录为单位 deny（`state/`、`config/` 整体），只开放具体文件。新增敏感位置要求同时更新清单与探针。
- [harness 原生读限制不存在或不可靠] → 回退到独立系统用户，需要用户批准，在任务 1.1 后决定。
- [隔离破坏 harness 的正常功能，比如读取全局 git 配置、凭证助手] → 允许清单中显式列出 harness 需要的路径。各适配器跑一次真实任务作为验收。
- [同用户仍能通过 ptrace 或调试接口观察节点进程] → seatbelt 在 `allow default` 下不会默认拒绝，配置中显式拒绝 `mach-priv-task-port` 与 `mach-task-name`，探针覆盖。独立用户方案天然隔离。
- [同用户进程的环境变量可读、可以互相发信号，seatbelt 拦不住] → 节点凭证不经环境变量传递（D4）；信号只能让任务失败，不能提权。在文档中写明边界。
- [外层 seatbelt 下同一执行器的 harness 凭证与其他任务的会话记录可读] → 写入文档；按任务分 CODEX_HOME 留待后续。
- [`allow default` 下 worker 能写入之后在沙箱外执行的文件，借此脱离隔离（PR #98 第二轮审查 N1）] 例如：
  - shell 启动文件 `~/.zshenv`、`~/.zshrc`、`~/.zprofile`、`~/.bash*`（codex-orca 的外层 shell 与用户自己的终端都会执行）；
  - 登记仓库共享的 `.git/hooks/*` 与 `.git/config`（Orca、用户在沙箱外运行 git 时执行 hook 或读取 `core.fsmonitor`、`core.hooksPath` 等）；
  - `~/.gitconfig`、`~/.config/git/`；
  - 用户可写的 PATH 目录（`~/.bun/bin`、`~/.local/bin`、`/opt/homebrew/bin` 中可写的部分）；
  - `~/.ssh/config`；
  - `~/Library/LaunchAgents`（已拒绝）。

  → 真实开启（4.5）之前由 4.6 解决，二选一：写入白名单（默认 `deny file-write*`，只放行工作目录、harness 目录、临时目录、缓存目录与主仓库 `.git`
  中 worktree 必需的部分），或至少对上述持久化位置写拒绝；探针增加“写 shell 启动文件”一项（只在临时 home 上测试）。

## Migration Plan

1. 先合并 D3（kb 经中枢）与探针（不施加隔离，只报告），观察一周。
2. 外层 seatbelt 以 `preferred` 对 danger-full-access 角色启用。验收通过后，dev 角色改为 `required`。
3. 根据任务 1.1 的结论启用 harness 原生读限制，或者提出独立用户方案并请用户批准。
4. 回滚：角色改回 `isolation: off` 即恢复旧行为。D3 的路由保留，不影响旧节点（旧节点继续本地读取）。

## Open Questions

- 探针的运行周期与失败通知方式（Interrupt 还是 Digest），以真实运行中的误报情况为准。
