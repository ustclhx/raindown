# Proposal

## Why

worker（Codex、Claude 等 harness 进程及其子进程）与节点以同一个系统用户运行，不开沙箱的角色（例如当前的 dev，`danger-full-access`）能直接读写 Raindown 的全部状态：`state/hub.token`（user 令牌，等于用户的全部权限）、其他任务的派工令牌与唤醒令牌、账本数据库、`config/policies.yaml`、密钥私钥 `~/.config/sops/age/keys.txt`，还能操作 Orca 的其他终端。add-harness-neutral-coordination 引入的任务绑定令牌因此只是纵深防御：一个被提示注入的 worker 可以绕过 Raindown 的全部授权。随着 PR 直通把公开仓库的评论送进 worker，这个缺口需要关上。

## What Changes

- 定义与 harness 无关的 **worker 隔离契约**：节点为每次派工计算"受保护资源"（Raindown 状态与配置目录、其他任务的私有目录与令牌、密钥私钥、守护进程配置、Raindown 控制通道）与"允许资源"（本任务工作目录、本次派工的令牌文件、harness 运行所需的凭证与目录），由适配器在 harness 进程外层施加 OS 级隔离。
- macOS 上用节点生成的 seatbelt 配置（`sandbox-exec`）包裹 harness 进程；先用实测确定与 harness 自带沙箱（Codex 的 seatbelt、Claude Code 的沙箱）嵌套是否可行，不可行时改用退路方案（见 design）。Linux（landlock / bubblewrap）只在契约中预留，不在本变更实现。
- 任务绑定的 MCP 把知识读取（kb_search / kb_get / kb_query）改为经中枢执行，使 worker 进程无需读取 Raindown 目录。
- 适配器声明新能力 `credential_isolation`；角色可要求隔离（`isolation: required`），要求隔离的角色在无法隔离的节点或执行器上拒绝派工并如实说明。
- `raindown doctor` 与 `hub status` 用探针进程验证隔离生效（在同样的隔离下尝试读取 user 令牌、其他任务令牌、账本与私钥，必须全部失败）。
- 不修改用户本机生产环境（`~/.codex`、`~/.claude`、`~/.config/gh` 等不改写）。
- 不在本变更内：worker 使用独立 GitHub bot 身份（另立变更）；Linux 实现；多用户。

## Capabilities

### New Capabilities
- `worker-isolation`：worker 进程与 Raindown 凭证、状态和控制通道的隔离——受保护资源与允许资源的定义、适配器施加隔离的契约、角色的隔离要求、验证探针与 doctor 报告。

### Modified Capabilities
- `knowledge-access`：任务绑定的 MCP 会话的知识读取改为经中枢执行，worker 侧不再直接读取 raindown-home。

## Impact

- 代码：`packages/node`（隔离配置生成、各适配器包裹 harness 进程：codex-orca 终端命令前缀、codex-exec 子进程、claude-sdk 的 SDK 进程启动）、`packages/mcp`（任务绑定改走中枢）、`packages/hub`（kb 读取路由，限任务绑定令牌）、`packages/core`（隔离契约类型、角色配置 `isolation`、doctor 检查）。
- 依赖：macOS `/usr/bin/sandbox-exec`（系统自带，已标记弃用但仍可用；风险见 design）。
- 角色：现有 `dev`（danger-full-access）等角色在隔离验证通过后默认要求隔离；升级说明列出行为变化。
- 前置：add-harness-neutral-coordination 的第 3 阶段（任务绑定令牌）已在 main 上。
