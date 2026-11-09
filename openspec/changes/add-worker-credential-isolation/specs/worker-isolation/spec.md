# Spec Delta

## Purpose
让 worker 进程只能接触完成本次派工所需的资源：本任务的工作目录、本次派工的令牌和 harness 自身运行所需的凭证；读不到 user 令牌、其他任务的令牌、Raindown 的状态与配置、密钥私钥，也不能操作 Raindown 的控制通道。隔离由节点在 harness 进程外层施加，与具体 harness 无关。

## ADDED Requirements

### Requirement: 受保护资源
系统 SHALL 为每次派工确定受保护资源，至少包括：
- raindown-home 的 `state/`（含 user 令牌、账本数据库、唤醒令牌、其他任务的私有目录与派工令牌）与 `config/`（含策略、角色、workspace、渠道配置与加密密钥文件）；
- 密钥私钥文件；
- 守护进程的安装配置（launchd plist 所在目录）；
- Raindown 的控制通道：除本次派工令牌之外的中枢访问凭证，以及节点用来操作 harness 会话的通道（例如 Orca 的控制接口）。

worker 进程及其所有子进程 MUST NOT 能读取或修改受保护资源。

#### Scenario: 不开沙箱的开发 worker 读取 user 令牌
- **WHEN** 一个角色为 danger-full-access 的开发 worker 执行 `cat ~/raindown-home/state/hub.token`
- **THEN** 读取失败，令牌内容不出现在 worker 的输出中

#### Scenario: worker 修改策略
- **WHEN** worker 尝试写入 `~/raindown-home/config/policies.yaml`
- **THEN** 写入失败，策略文件不变

#### Scenario: worker 读取另一个任务的派工令牌
- **WHEN** 任务 A 的 worker 读取任务 B 私有目录中的派工令牌文件
- **THEN** 读取失败

### Requirement: 允许资源
隔离 SHALL 允许 worker 访问：本任务的工作目录（按角色的读写类别读或写）、本任务私有目录中本次派工的令牌文件（只读）、harness 运行所需的凭证与配置目录（由适配器声明，例如 Raindown 管理的 CODEX_HOME）、系统运行所需的公共路径，以及访问中枢的本机网络端口。worker 持有的中枢凭证 MUST 只有本次派工令牌。

#### Scenario: worker 正常上报
- **WHEN** 隔离下的 worker 通过 Raindown MCP 调用 `raindown_report progress`
- **THEN** 上报成功，任务保持 running

### Requirement: 写入白名单
施加外层隔离时，worker 的写入 SHALL 默认拒绝，只放行：写类角色的工作目录（本任务独立的 git clone）、本任务私有目录（含按任务私有的临时与缓存目录）、适配器声明的 harness 可写目录（其中会被 harness 加载或执行的配置与扩展除外；与没有外层隔离的设置不共享）、所需的设备文件，另加节点配置 `isolation.extra_write` 中显式追加的目录。登记仓库的 `.git` 对 worker MUST 整体只读；写类任务的独立 clone 由节点在沙箱外建立，不与登记仓库共享对象文件（不硬链接）或 commondir，其 `.git/config`、hooks、`info/`、子模块与 alternates MUST NOT 可写。共享的临时与缓存目录，以及之后会在沙箱外被执行或加载的位置 MUST NOT 可写，包括 shell 启动文件、`~/.gitconfig` 与 `~/.config/git/`、`~/.ssh/`、用户可写的 PATH 目录。白名单 MUST NOT 重新放开任何受保护资源；`isolation.extra_write` 只接受绝对路径，不能与受保护路径、持久化位置、登记仓库、PATH 中的目录、`~/Library/Application Support`、用户主目录互相包含。

#### Scenario: worker 写 shell 启动文件
- **WHEN** 隔离下的 worker 执行 `echo 'curl … | sh' >> ~/.zshenv`
- **THEN** 写入失败，文件不变

#### Scenario: worker 写登记仓库的 hooks
- **WHEN** 隔离下的 worker 写入登记仓库的 `.git/hooks/post-checkout`、`.git/config`、已有对象或 refs，或写入本任务 clone 的 `.git/config`、hooks
- **THEN** 写入失败；同一 worker 在本任务的 clone 中 commit、建分支、fetch、merge、rebase 照常成功

#### Scenario: 隔离自检覆盖持久化写入
- **WHEN** 节点运行隔离探针
- **THEN** 探针在自建的临时 home 中写模拟的 shell 启动文件、在自建的临时仓库中写 `.git/hooks/`，两者都被拒绝才算通过

### Requirement: 适配器施加隔离
声明 `credential_isolation` 能力的执行器适配器 SHALL 在启动 harness 进程（含会话恢复与重新挂接后的新进程）时施加隔离，隔离覆盖该进程派生的全部子进程；harness 自带的沙箱设置不得削弱这一隔离。隔离配置由节点生成，内容只来自节点与角色配置，不来自 worker 或任务输入。

#### Scenario: 恢复会话
- **WHEN** 节点重启后为同一任务重新启动 harness 进程
- **THEN** 新进程同样处于隔离中

### Requirement: 角色的隔离要求
角色配置 SHALL 支持 `isolation: required | preferred | off`。`required` 的角色只派给声明 `credential_isolation` 且隔离自检通过的执行器与节点；无法满足时任务以明确原因卡住或拒绝派工，MUST NOT 在无隔离的情况下运行。`preferred` 在无法隔离时运行并在任务与收件箱中标明"未隔离"。

#### Scenario: 隔离不可用
- **WHEN** 一个 `isolation: required` 的开发任务被派到隔离自检失败的节点
- **THEN** 任务不启动 harness，卡住原因写明隔离不可用及自检失败项

### Requirement: 隔离自检
节点 SHALL 在启动时与定期运行隔离探针：在与 worker 相同的隔离下尝试读取 user 令牌、账本数据库、其他任务的令牌与密钥私钥，并尝试写入配置目录，全部失败才算自检通过；同时确认允许资源可用。`raindown doctor` 与 `raindown hub status` MUST 显示每个执行器的隔离状态与失败项。

#### Scenario: 隔离被破坏
- **WHEN** 系统更新导致隔离配置不再生效，探针读到了 user 令牌
- **THEN** 自检失败，doctor 报告失败项，`required` 的角色停止派工并通知用户
