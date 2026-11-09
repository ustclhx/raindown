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
    `native`（workspace-write / read-only 的 Codex permissions profile）**未实现**，留给 5.1：开关打开时这些设置声明为 `none`，不显示为已施加。
    supervisor 唤醒会话（MCP 仍本地读取 raindown-home）不包裹，沙箱设置为 `supervisor-session → none`。说明见 `docs/executors.md`「外层 seatbelt 施加」。
  - 审查第一轮（PR #98）：受保护路径全部祖先目录写拒绝（防改名绕过）；配置移到 worker 读写都被拒绝的 `state/tasks/<任务>/isolation.sb`；
    Orca 端口只读解析（套接字名取 pid + lsof），未解析时探针记为失败；探针新增 `rename.protected_ancestor`、`write.own_profile` 两个必过项，
    施加时按执行器分别运行；未隔离旧终端拒绝重挂接时关闭；`spawnClaudeCodeProcess` 启动失败不崩溃；非 macOS 打开开关时 doctor 提示未施加。
- [ ] 4.5 真实验收（征得用户同意后在本机执行）：dev 角色跑一个 product-res 任务，worker 内 `cat ~/raindown-home/state/hub.token`、写 `config/policies.yaml`、读其他任务令牌全部失败，`raindown_report` 与 `kb_search` 正常，任务正常完成

## 5. harness 沙箱开启时的隔离

- [ ] 5.1 按 1.1 结论：若有可靠的原生读限制，codex-exec / codex-orca（workspace-write、read-only）与 claude-sdk（bash 沙箱）在 Raindown 生成的配置中注入受保护路径的读限制，并纳入探针；若没有，写出独立系统用户方案的实施说明（用户、组、sudoers 规则、harness 凭证、worktree 权限、回滚），提交用户决定，本任务以文档完成
- [ ] 5.2 （仅在用户同意独立用户方案后）实现 `separate_user` 施加层与安装/卸载命令。验证：安装命令的 dry-run 测试与真实验收

## 6. 角色要求与文档

- [ ] 6.1 角色配置 `isolation: required | preferred | off`（默认 preferred）；`required` 不满足时 `blocked(other)` 原因 `isolation_unavailable`，不启动 harness；`preferred` 未隔离时在任务与收件箱标明。验证：派送测试覆盖三种取值
- [ ] 6.2 文档：`docs/hub-auth.md` 与 `docs/executors.md` 更新信任边界说明（隔离后与隔离前）、升级建议（dev 角色改为 required）、回滚方法；`raindown init` 的角色模板加入 `isolation` 注释
