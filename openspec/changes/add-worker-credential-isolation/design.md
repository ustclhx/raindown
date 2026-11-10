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
节点为每次派工生成 `IsolationSpec{deny_read[], deny_write[], allow_read[], allow_write[], allow_unix_sockets[], allow_local_ports[]}`。写入是白名单（4.6，见 D2）：`allow_write`（子树）、`allow_write_literals`（单个文件）与 `allow_write_regex` 就是全部可写位置，`write_carve_outs*` 在其中再挖掉登记仓库的 git 目录与 harness 配置，`allow_write_git` 再放行本任务独立 clone 的 `.git`；`deny_*` 受保护项与 `deny_write_except`（持久化位置）最后写入，白名单不能重新放开它们。路径一律规范化为 realpath，这是正确性前提而不只是整洁：seatbelt 按真实路径匹配，未规范化的规则（例如 `/var/…` 而真实路径是 `/private/var/…`）会静默不生效。规范化在生成配置时做，不存在的路径按其最近的已存在祖先规范化后拼回。适配器把它落到三种施加层之一：
- **外层 seatbelt**：用于 harness 自带 OS 沙箱关闭的情况（danger-full-access、bypass）。节点生成 SBPL 配置，用 `sandbox-exec -f` 启动 harness。配置以 `allow default` 为基础（读、网络、进程等不改变），紧接着 `(deny file-write*)` 把写入改为白名单（4.6），显式 deny 受保护资源。
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

**写入白名单（4.6，用户 2026-11-09 决定；PR #99 第一轮审查后修订）。** 读取保持 `allow default` 加显式拒绝。写入默认拒绝，只放行以下位置（全部 realpath，按适配器与角色计算）：
- **工作目录**：写类角色是本任务的**独立 clone** `run/tasks/<任务>/repo/`（见下）；只读角色的工作目录仍以写拒绝表示。
- **本任务私有目录** `run/tasks/<任务>/`：其中有按任务私有的 `tmp/` 与 `cache/`。worker 的 `TMPDIR` 与 bun、npm、pnpm、Playwright、corepack、pre-commit、go、pip、uv 的缓存环境变量都指到这里，执行结束（codex-orca 为任务完成或取消）时删除。派工令牌与 `dispatch-tokens/` 仍写拒绝。
- **适配器声明的 harness 可写目录**：
  - codex 使用施加时专用、**按任务**的独立 CODEX_HOME `run/tasks/<任务>/codex-home/`（审查第二轮 M1），与无外层 seatbelt 的设置及其他任务都不共享。目录**整体可写**（4.5 实测后用户 2026-11-10 决定：之前的内部白名单使 Codex 写 `installation_id`、`thread-writer-locks/` 等失败，TUI 启动即退出）：该目录只被本任务沙箱内的 Codex 读取，worker 写入的内容只影响本任务，仍在沙箱内执行。只保留两项拒绝：`auth.json` 链接本身拒绝写（链接目标这一个文件可写），`codex-home` 目录本身不能改名。
- **macOS Security 缓存 `mds/`**（4.5 实测，用户 2026-11-10 决定方案 1）：Codex 校验登录时 Security 框架以写方式打开 `<DARWIN_USER_CACHE_DIR>/mds/` 下的 `mds.lock`、`mdsDirectory.db`、`mdsObject.db`。节点用 `getconf DARWIN_USER_CACHE_DIR` 解析并 realpath，只接受 `/private/var/folders/` 下的路径（失败则不放行，doctor 提示）；放行 `mds/` 子树（`mds` 目录节点本身拒绝写），对所有施加外层 seatbelt 的执行器生效。`mds/` 中只能新建普通文件（审查第一轮）。节点每次启动 harness 前先与全部已有基线比较并重置，再把 `mds/` 下各条目的 sha256 记到 worker 不可写的 `state/tasks/<任务>/mds-baseline.json`；harness 每次结束（正常结束、崩溃、取消、阻塞；codex-orca 为终端结束）后比较，有变化、新增、非普通或过大（8 MB 以上，不读取）的条目删除（不跟随链接，macOS 自动重建），经 `POST /v1/nodes/:id/isolation-notices`（不依赖租约）写任务事件与 Digest 收件箱条目（只列文件名）；节点启动时校验残留基线。
  - claude-sdk 使用按任务的 Claude Code 配置目录 `run/tasks/<任务>/claude-config/`（`CLAUDE_CONFIG_DIR`），其中 `settings*.json`、`commands|agents|skills|hooks|plugins|rules|output-styles`、`CLAUDE.md` 等不可写；另放行登录钥匙串文件 `login.keychain-db` 及其 `.sb-*` 临时文件（OAuth 刷新）。
  - 用户自己的 `~/.claude`、`~/.claude.json` 不可写：其中的 shell 快照、项目记忆、MCP 与 hooks 配置会被用户自己（沙箱外）的 Claude Code 加载或执行。
- **设备文件**：`/dev/null`、`/dev/tty`、`/dev/ttys<N>`、`/dev/fd/` 等。
- **pnpm 12 的锁目录**（4.5 实测）：`/private/tmp/pnpm-(dir|store-operation|verify-deps-install)-locks-<uid>` 及其内容（正则，uid 取 `process.getuid()`）。pnpm 12 把它们写死在 `/private/tmp` 下、不随 `TMPDIR` 变化；`/private/tmp` 其余位置仍拒绝。pnpm 12 只认 `pnpm_config_store_dir`、`pnpm_config_cache_dir`，因此环境中另外注入这两项。
- **追加**：节点配置 `isolation.extra_write` 显式追加的目录。只接受绝对路径，比较时大小写折叠并做 NFD；不能与以下位置互相包含：受保护路径、持久化位置、登记仓库、`PATH` 中的目录、`~/Library/Application Support`、用户主目录。

共享的临时与缓存目录（`/private/tmp`、`TMPDIR` 及其 `C/`、`~/.cache`、`~/Library/Caches`、`~/.bun/install/cache`、`~/.npm/_cacache`、pnpm store）**不放行**：其中的内容会被之后沙箱外的安装与运行直接使用（审查第一轮 M2）。

**独立 clone（第一步方案，审查第一轮 H1、H2、M4）。** 写类角色不再与登记仓库共享 commondir。
- 节点在沙箱外 `git clone --shared --no-checkout`：对象经 alternates 只读引用登记仓库，不用会硬链接对象的 `--local`。`isolation.dissociate` 打开时改为完整复制。
- `origin` 指向登记仓库的远端，worker 直接推送。
- 节点写入 `.git/config`（任务分支的上游、`push.default=current`、`core.logAllRefUpdates=false`），并在 `state/` 下记录其 sha256。
- 全部登记仓库的 `.git` 对 worker 整体只读。clone 的 `.git` 可写，但 `config`、`hooks/`、`info/`、`modules/`、`objects/info/alternates`，以及 `commondir`、`gitdir`、`config.worktree`、`worktrees/` 除外（审查第二轮 H1）。
- 节点在沙箱外对 clone 运行 git 时固定 `GIT_DIR` 与 `GIT_COMMON_DIR`；核对时这些指针文件存在即失败。检出 worker 写过的分支时中和 filter、diff driver 并跳过 LFS smudge（审查第二轮 M2）。
- 节点在 clone 中只做只读的安全 git，每次运行前核对 config 的 sha256。
- codex-orca 的 Orca worktree 只作终端宿主（`--setup skip`），setup 在 clone 中、以 worker 的 seatbelt 配置运行。
- 迁移：旧布局的任务从登记仓库中的同名分支建立 clone。回滚：先把任务分支快进取回登记仓库，不能快进时取到 `raindown/recovered/<任务>`，再删除 clone。

**持久化位置与外部启动。** 持久化位置（shell 启动文件、`~/.gitconfig`、`~/.ssh`、`~/.local/bin` 等）在白名单之后整体拒绝写，作为纵深防御。另加 `(deny job-creation)`、`(deny user-preference-write)`、`(deny lsopen)`、`(deny appleevent-send)`。

**不变量（审查第二轮 L3）：节点往任务私有目录（worker 可写）写文件，一律不跟随符号链接**——在同一目录以 `O_CREAT|O_EXCL` 写临时文件再 rename；新建目录后用 `lstat` 确认不是符号链接。

SBPL 中的顺序：
1. `(allow default)`
2. `(deny file-write*)`
3. 白名单放行
4. 白名单内再挖掉：登记仓库与工作目录所属仓库的 git 目录、`.git` 指针文件、harness 配置
5. 放行独立 clone 的 `.git`
6. 受保护项拒绝
7. 持久化位置拒绝
8. 受保护路径与挖掉位置的祖先目录 literal 写拒绝
9. 控制通道、调试、派生任务等拒绝

后写的规则优先，所以白名单不能重新放开受保护项。

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

  → 4.6 已采用写入白名单（用户 2026-11-09 决定，见 D2）：上述位置都不在白名单内；探针新增必过项 `write.shell_startup`
  （探针自建临时 home 中的模拟 `.zshenv`）、`write.git_hooks`（独立 clone 形状的探针工作目录的 `.git/hooks/`）与 `write.registered_git`（模拟登记仓库的 `.git`）。
- [写白名单内仍可被利用的位置（4.6 与审查第一轮后的残留）]
  - **auth.json**：worker 可以经链接改写用户的 `~/.codex/auth.json`（换成攻击者账号的凭证）。Codex 在进程内刷新凭证且刷新令牌会轮换，改由节点刷新目前不可行。
  - **登录钥匙串**：claude-sdk 下 worker 可以损坏或替换 `login.keychain-db`。
  - **pnpm 锁目录**：`/private/tmp/pnpm-*-locks-<uid>` 与沙箱外的 pnpm 共用。锁文件名可由 store 路径推算（`store-operation-locks-<uid>/sha256(<storeDir>/v11).lock` 等），worker 可以在其中预埋文件、符号链接或硬链接，或把锁目录换成符号链接。pnpm 12.8.1 实测拒绝符号链接与非本人普通文件的锁、拒绝非真实目录的锁目录，不经链接写入或截断目标；后果只是沙箱外的 pnpm 等待或失败（拒绝服务），持续到删除 `/private/tmp/pnpm-*-locks-<uid>` 中的异常条目为止。不能借此写文件或执行代码，记为低风险并接受。
  - **偏好设置**：经 cfprefsd 的偏好设置写入拦不住，例如终端应用的启动命令（`user-preference-write` 实测无效）；拒绝 cfprefsd 的 mach-lookup 可能影响 `security`，未验证。
  - **会话记录与本任务的 Codex 配置**：独立 CODEX_HOME（整体可写）与按任务的 Claude 配置目录中的会话记录可被改写（提示注入，不是命令执行）；独立 CODEX_HOME 中的 `config.toml`、`.env` 等也可被改写，但该目录只被本任务沙箱内的 Codex 读取，影响限于本任务且仍在沙箱内。
  - **mds**：`<DARWIN_USER_CACHE_DIR>/mds/` 与沙箱外所有使用 Security 框架的进程共用。经符号链接、目录、FIFO 让沙箱外进程写到 `mds/` 之外的途径由 `(deny file-write-create … (require-not (vnode-type REGULAR-FILE)))` 关闭（PR #101 审查第一轮）；残留的是 worker 在 harness 运行期间改写其中普通文件的内容（例如篡改数据库），沙箱外进程会读到，影响未完全排除。节点在每次启动 harness 前与全部已有基线比较、结束后按基线校验，有变化即重置并通知；codex-orca 终端在阻塞期间继续运行时基线保留到终端结束，期间其他任务启动前的比较同样覆盖它。沙箱外进程同时合法更新也会触发重置，重置也可能删除其他同时运行的任务或沙箱外进程正在写入的文件，macOS 会重建它们。重置后各基线把这些条目标记为已重置，重建的文件被采纳、不再反复重置（审查第二轮）；终端已不存在的 hold 基线在节点启动或下次启动新终端时做最后一次校验并删除。
  - **Codex 项目配置**：预置信任后，Codex 会加载 clone 内的 `.codex/config.toml`。`notify`、`model_provider` 用命令行固定，`.codex/` 出现即停下，但 `model_providers` 表、`mcp_servers` 等覆盖不了的项，在出现到下一次检查之间可能生效；它们只在外层 seatbelt 内生效（审查第二轮 L2）。
  - **手动运行 git**：用户在任务 clone 中手动运行 git 时，git 会跟随 worker 预埋在 `.git` 中的符号链接写入（例如 `COMMIT_EDITMSG`、已有的 reflog）。
  → 写入文档；4.5 验收后按实际情况决定是否进一步收紧。
- [写白名单误伤 harness 或工具链]
  - **工具写不了自己的目录**：例如写 `~/Library/Application Support/<工具>`。
  - **git 写配置失败**：设置其他分支的上游、husky 写 `core.hooksPath`。
  - **冷缓存**：按任务的冷缓存使安装变慢。
  - **SSH known_hosts**：首次连接新的 SSH 主机时 `known_hosts` 不可写（不预置，记为限制）。
  → 4.5 验收时，优先用环境变量把工具缓存指到任务私有目录，或用 `isolation.extra_write` 追加具体子目录；`.git/config` 与 harness 配置不放行。

## Migration Plan

1. 先合并 D3（kb 经中枢）与探针（不施加隔离，只报告），观察一周。
2. 外层 seatbelt 以 `preferred` 对 danger-full-access 角色启用。验收通过后，dev 角色改为 `required`。
3. 根据任务 1.1 的结论启用 harness 原生读限制，或者提出独立用户方案并请用户批准。
4. 回滚：角色改回 `isolation: off` 即恢复旧行为。D3 的路由保留，不影响旧节点（旧节点继续本地读取）。

## Open Questions

- 探针的运行周期与失败通知方式（Interrupt 还是 Digest），以真实运行中的误报情况为准。
