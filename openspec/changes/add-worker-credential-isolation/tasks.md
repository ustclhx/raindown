# Tasks

前置：add-harness-neutral-coordination 第 3 阶段（任务绑定令牌与 MCP 白名单）已在 main 上。每个阶段独立成 PR；涉及用户本机系统级改动（新建系统用户、sudoers）的步骤必须先得到用户明确同意。

## 1. 实测与清单

- [x] 1.1 实测（只用临时目录与临时 HOME/CODEX_HOME，不改 `~/.codex`、`~/.claude`）：外层 `sandbox-exec` 包裹 Codex（danger-full-access / bypass）、Claude Code（无 bash 沙箱）、bun、git、gh 时能否正常工作；Codex workspace-write/read-only 与 Claude Code bash 沙箱是否有按路径禁止读取的原生配置及其可靠性；结果写入 `docs/executors.md` 的"隔离实测"一节，并据此确定每个适配器 × 沙箱设置的施加层（D1）。验证：文档中有逐项结果与复现命令
- [x] 1.2 core：`IsolationSpec` 类型与受保护/允许资源清单计算（D2），路径 realpath 规范化（不存在的路径按最近已存在祖先规范化），Orca 运行时目录整体拒绝、Orca 本机端口运行时解析，跨进程调试拒绝项；CODEX_HOME 与任务私有目录移到 `run/`（含旧位置迁移）。验证：单元测试覆盖清单内容、符号链接与不存在路径、允许项不在被拒目录内
- [x] 1.3 适配器能力 `credential_isolation`（`seatbelt | native | separate_user | none`，按角色沙箱设置）加入注册信息与中枢投影。验证：节点注册测试与旧节点兼容测试

## 2. kb 读取经中枢

- [x] 2.1 中枢只读路由 kb_search / kb_get / kb_query，只接受任务绑定令牌，按 workspace 可见范围过滤（D3）。验证：与 CLI 同查询结果一致的测试；跨 workspace 条目不返回
- [x] 2.2 任务绑定的 MCP 改走中枢路由；无绑定与唤醒绑定保持本地。验证：任务绑定会话在 raindown-home 不可读时 kb 操作仍成功

## 3. 自检探针

- [x] 3.1 节点自带探针程序与执行（D6）：读取 hub.token、账本、临时伪造的他人令牌、私钥，写 config，连接 Orca 控制套接字，全部失败才通过；同时验证允许资源可用。验证：测试用临时 home 模拟可读与不可读两种结果
- [x] 3.2 探针结果随节点注册上报；`raindown doctor` 与 `raindown hub status` 显示每个执行器的隔离状态与失败项；定期运行与 macOS 版本变化触发。验证：doctor 输出测试

## 4. 外层 seatbelt

- [x] 4.1 由 `IsolationSpec` 生成 SBPL 配置（allow default + 显式 deny + 最窄 allow），写入任务私有目录（0600），内容只来自节点与角色配置。验证：配置生成的快照测试；注入测试（路径中的引号、括号不能改变配置结构）
- [x] 4.2 codex-orca：终端命令以 `sandbox-exec -f <profile>` 启动 Codex（仅 harness 沙箱关闭时）；会话恢复与重新挂接后的新进程同样施加。注意：任务说明 `state/tasks/<id>/spec.md` 只能在沙箱外由外层 shell 读取（`"$(cat …)"` 在 `sandbox-exec` 之前展开），`sandbox-exec` 只包 `codex` 本身。验证：命令构造测试
- [x] 4.3 codex-exec：子进程经 `sandbox-exec` 启动（同上条件）。验证：spawn 参数测试
- [x] 4.4 claude-sdk：经 SDK 的可执行文件或启动钩子包裹 Claude Code 原生进程（同上条件）。施加 seatbelt 时强制关闭 bash 沙箱（覆盖 project settings 中的 `sandbox.enabled`），或探测实际生效的配置后再选择施加层；否则 bash 沙箱在外层 seatbelt 内嵌套失败。验证：启动参数测试
  - 4.1–4.4 的施加由节点级开关 `config/node.yaml` 的 `isolation.enforce` 控制，缺省 false（关闭时启动方式逐字节不变，快照测试锁定）；仅 macOS。
    SBPL 路径内联并严格转义（未用 `-D`），允许项在前、拒绝项在后（拒绝优先，与 `IsolationSpec` 约定一致）；Orca 端口未解析时不生成端口规则。
    `native`（workspace-write / read-only 的 Codex permissions profile）当时**未实现**，留给 5.1：开关打开时这些设置声明为 `none`，不显示为已施加（5.1 已实现）。
    supervisor 唤醒会话（MCP 仍本地读取 raindown-home）不包裹，沙箱设置为 `supervisor-session → none`。说明见 `docs/executors.md`「外层 seatbelt 施加」。
  - 审查第一轮（PR #98）：受保护路径全部祖先目录写拒绝（防改名绕过）；配置移到 worker 读写都被拒绝的 `state/tasks/<任务>/isolation.sb`；
    Orca 端口只读解析（套接字名取 pid + lsof），未解析时探针记为失败；探针新增 `rename.protected_ancestor`、`write.own_profile` 两个必过项，
    施加时按执行器分别运行；未隔离旧终端拒绝重挂接时关闭；`spawnClaudeCodeProcess` 启动失败不崩溃；非 macOS 打开开关时 doctor 提示未施加。
- [x] 4.6 （4.5 的前置）持久化写入（design Risks，PR #98 第二轮审查 N1）：在“写入白名单（默认 `deny file-write*`，放行工作目录、harness 目录、临时目录、缓存目录与主仓库 `.git` 中 worktree 必需的部分）”与“至少对 shell 启动文件、共享 `.git/hooks` 与 `.git/config`、`~/.gitconfig`、`~/.config/git`、用户可写 PATH 目录、`~/.ssh/config` 写拒绝”之间选定方案并实现；探针新增“写 shell 启动文件”一项（只在临时 home 上测试）。验证：darwin 上真实 `sandbox-exec` 的回归测试；Codex 与 Claude Code 在白名单下的工具链冒烟
  - 用户 2026-11-09 选定写入白名单（design D2）。`IsolationSpec` 增加 `allow_write_literals`、`write_carve_outs*`、`allow_write_git*`，
    `allow_write` 改为白名单语义；SBPL 在 `(allow default)` 之后 `(deny file-write*)`，受保护项拒绝仍写在最后。
  - claude-sdk 施加时改用 Raindown 管理的 `CLAUDE_CONFIG_DIR`（`run/executors/claude-sdk/claude-config/`，用户设置与扩展只读链接），
    `CLAUDE_SECURESTORAGE_CONFIG_DIR` 保持原钥匙串条目，`CLAUDE_CODE_TMPDIR` 改到本用户 `TMPDIR`（第一轮审查后改为按任务的目录与任务私有临时目录，见下）。
  - 登记仓库 `.git` 的最小写集合曾由 darwin 上真实 `sandbox-exec` + git 实测确定；第一轮审查后被独立 clone 取代（见下），登记仓库的 `.git` 整体只读。
  - 探针新增必过项 `write.shell_startup`、`write.git_hooks`（只在探针自建的 `run/isolation-probe-<hex>/` 中操作），以及 `write.git_objects`（按角色读写类别）。
  - 新配置 `isolation.extra_write`（绝对路径；不能是受保护路径、持久化位置、用户主目录或其祖先），doctor 显示。
  - PR #99 第一轮审查（用户批准第一步方案：Orca 方案 (b)、codex-exec / claude-sdk 写类角色同样用独立 clone、`dissociate` 缺省 false、known_hosts 记为限制）：
    - H1、H2、M4：施加时写类任务在独立 clone `run/tasks/<任务>/repo`（`git clone --shared`，不硬链接对象）中运行，登记仓库的 `.git` 整体只读；
      clone 的 `.git/config` 由节点写入并记录 sha256（节点每次运行 git 前核对），config、hooks、`info/`、`modules/`、alternates 不可写；
      codex-orca 的 Orca worktree 只作终端宿主，setup 在 clone 中以 worker 的 seatbelt 配置运行；迁移与回滚（取回分支）见 docs。
    - H3、M1：施加时用独立的 CODEX_HOME（第二轮改为按任务），内部白名单；`auth.json` 链接本身拒绝写；节点刷新凭证不可行，登记 Risks。
    - M2：按任务私有的 `tmp/`、`cache/` 与环境变量，共享临时与缓存目录移出白名单；launchd plist 设 `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`。
    - M3：钥匙串只放行 `login.keychain-db` 与 `.sb-*`（claude-sdk）。M5：claude-sdk 配置目录按任务。M6：codex-orca 预置项目信任。
    - L1：`extra_write` 大小写折叠与 NFD，拒绝登记仓库、PATH 目录、Application Support；持久化位置整体拒绝写。L2：随独立 clone 消失。
    - L3：文档与 dev 角色模板写明推送与新建分支的做法。L4：审查元数据存 `state/review-meta/`。L5：`job-creation`、`user-preference-write`、`lsopen`、`appleevent-send`。
    - 探针新增必过项 `write.registered_git`，另有 `write.shared_tmp`。
  - PR #99 第二轮审查：H1 独立 clone 的 `commondir`、`gitdir`、`config.worktree`、`worktrees/` 拒绝写，核对时存在即失败，节点的 git 固定 `GIT_COMMON_DIR`；
    M1 独立 CODEX_HOME 改为按任务（`run/tasks/<任务>/codex-home`）；M2 检出 worker 写过的分支时中和 filter 与 LFS；
    L1 `write.shared_tmp`、`write.git_commondir` 列为必过项；L2 codex-orca 固定 `notify`、`model_provider`；L3 节点往任务目录写文件不跟随符号链接。
  - **留给 4.5 真实验收确认**（不运行真实 harness，未验证）：Codex 在独立 CODEX_HOME 内部白名单下能否正常启动、刷新凭证与使用 `tmp/arg0`；
    Claude Code 在按任务配置目录与 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 下能否取到钥匙串凭证与刷新；预置信任能否消除信任弹窗；
    仓库 setup（`bun install`）在冷的任务缓存下的耗时；husky 等写 `core.hooksPath` 的工具；工具写 `~/Library/Application Support` 等位置的失败（按 docs 排查追加）；
    经 cfprefsd 的偏好设置写入未拦住（Risks）。
- [x] 4.5 真实验收（征得用户同意后在本机执行）：dev 角色跑一个 product-res 任务，worker 内 `cat ~/raindown-home/state/hub.token`、写 `config/policies.yaml`、读其他任务令牌全部失败，`raindown_report` 与 `kb_search` 正常，任务正常完成
  - 试运行发现（2026-11-10）：pnpm 12 的 store 与锁目录（PR #100）；Codex 在外层 seatbelt 内无法启动——独立 CODEX_HOME 内部白名单太窄、
    Security 框架需要写 `<DARWIN_USER_CACHE_DIR>/mds/`。用户决定：CODEX_HOME 整体可写（只保留 `auth.json` 链接与目录改名的拒绝），
    `mds/` 放行并由节点在 harness 前后校验与重置（design D2、Risks）；Codex `tmp/arg0` 硬链接别名被拒只打印 WARNING，保持现状。
  - 验收通过（2026-11-10，PR #101 之后，codex-orca × danger-full-access）：任务 `t-20261110-041013-460319` 在独立 clone 中完成并开 product-res PR #36；
    worker 内读 `hub.token` 失败（退出码 1）；`raindown_report` 与 `kb_search`（经中枢）正常；用户的主检出未被改动；
    `pnpm install` 正常；mds 无重置。三个施加组合（codex-orca、codex-exec × danger-full-access，claude-sdk × bash 沙箱关闭）探针均通过。
    发现：任务以上报 done 结束时，节点经 forceDone 先走完执行结束出口（基线仍被 hold），之后无人校验，基线残留——改为执行器在任务完成或取消时校验并删除。
    未覆盖：claude-sdk 写类任务的真实运行（钥匙串登录、进程组结束）与真实 Orca 下的终端存活检查，随后续使用观察。

## 5. harness 沙箱开启时的隔离

- [x] 5.1 按 1.1 结论：若有可靠的原生读限制，codex-exec / codex-orca（workspace-write、read-only）与 claude-sdk（bash 沙箱）在 Raindown 生成的配置中注入受保护路径的读限制，并纳入探针；若没有，写出独立系统用户方案的实施说明（用户、组、sudoers 规则、harness 凭证、worktree 权限、回滚），提交用户决定，本任务以文档完成
  - Codex 有可靠的原生读限制，实现 `native`：core `codexNativeProfile` 由 `IsolationSpec` 生成 permissions profile（raindown-home 整体 `"deny"`、派工令牌 `"read"`，
    另拒绝该执行器的 CODEX_HOME 与 `auth.json` 源文件，只放行 CODEX_HOME 的 `tmp/`；Orca 运行时目录与套接字在 `network.unix_sockets` 中拒绝；
    角色的 `sandbox_workspace_write.network_access` 映射为 `network.enabled`）。每次启动经 `-c` 以内联表传入（不写共享 `config.toml`，profile 名随机），
    不再传 `-s` 与 `config.sandbox_mode`，改传 `-c default_permissions`；TOML 严格转义并有注入测试。开关关闭时启动命令逐字节不变（快照）。
  - codex-orca 的终端命令、恢复与重新挂接（`orca.json` 记录 `isolation_layer: native`）都覆盖；codex-exec 的 exec 与 resume 都覆盖。
  - 能力声明：开关打开时 `native` 不再降级为 `none`；`enforced` 仍要求探针通过。探针以 `codex sandbox -c <profile> -P <名>` 运行同源 profile，
    先检查 `codex --version`（低于 0.167.0 时失败并提示），读拒绝项为必过项，写类项按 Codex 沙箱语义判定，doctor 显示原因。
  - D4/D5：native 下 codex-orca 的授权弹窗不预检、不自动放行，标注“批准即解除本次命令的隔离”并以 `no_delegate` 上报；codex-exec 固定 `approval_policy="never"`。
  - PR #104 第一轮审查：H1 启动闸门（最近一次探针以 native 通过、同一 codex 可执行文件按真实路径 + mtime 等比较、启动命令改用绝对路径，否则 `isolation_not_applied`）；
    H2 只读例外 lstat 检查（`codex_profile_unsafe_read`）；M3 探针与启动一致（`-c default_permissions`、执行器的 CODEX_HOME、角色网络与配置、`read.codex_home_auth`、
    `write.git_hooks` / `write.git_config` 预期拒绝并在 profile 中收回 `.git` 的 hooks、config 为只读、模拟 home 与改名目录声明为只读、工作目录不在 $TMPDIR，
    网络打开的角色按未施加）；M4 native 下固定 `approvals_reviewer=user`；用户 `~/.codex` 整体拒绝；codex-orca 设置 `escapesIsolation`；
    native 下全部卡住 `no_delegate`；关闭未隔离旧终端失败时 blocked 交给用户；docs 升级说明。
  - claude-sdk 的 bash 沙箱：原生 `denyRead` 只覆盖 Bash，仍声明为 `none`（1.1 结论），需要隔离的角色关闭 bash 沙箱改走 seatbelt。
  - **未验证**（交给真实验收，命令见 `docs/executors.md`「`native`」）：`codex exec` / TUI 只传 `-c default_permissions` 时是否使用该 profile、
    `-c` 内联 profile 能否被正确解析、CODEX_HOME 整体拒绝只放行 `tmp/` 时 arg0 别名（`apply_patch`）是否正常。
- [ ] 5.2 （仅在用户同意独立用户方案后）实现 `separate_user` 施加层与安装/卸载命令。验证：安装命令的 dry-run 测试与真实验收
  - native 可靠，独立系统用户方案暂不需要，待用户决定。

## 6. 角色要求与文档

- [x] 6.1 角色配置 `isolation: required | preferred | off`（默认 preferred）；`required` 不满足时 `blocked(other)` 原因 `isolation_unavailable`，不启动 harness；`preferred` 未隔离时在任务与收件箱标明。验证：派送测试覆盖三种取值
  - 实现：中枢派送时按角色要求筛选节点（`required` 只派给已隔离节点；没有时中枢直接写 `task.blocked(other)`，消息以 `isolation_unavailable：` 开头并列出缺什么，
    状态机新增仅限中枢的 `queued → blocked`）；节点领到租约后按本地角色配置、能力声明与最近一次探针再确认，不满足时不启动 harness（以节点为准）。
    `preferred` 未隔离时 `task.started.unisolated` 记缺什么；收件箱按 节点 × 执行器 × 沙箱设置 聚合，只在评估结果变化时提示。
    只等待在线的已隔离节点（长轮询、活动租约或最近活动在窗口内；中枢启动/唤醒后有宽限）；角色缓存在领取与长轮询派送前刷新，找不到角色时中枢卡住、节点不启动（fail closed）。
    恢复沿用 `task_retry`，不新增轮询。supervisor 唤醒会话与 pr-merge 设 `required` 时角色加载报错（doctor）。说明见 `docs/executors.md`「角色隔离要求」
- [ ] 6.2 文档：`docs/hub-auth.md` 与 `docs/executors.md` 更新信任边界说明（隔离后与隔离前）、升级建议（dev 角色改为 required）、回滚方法；`raindown init` 的角色模板加入 `isolation` 注释
