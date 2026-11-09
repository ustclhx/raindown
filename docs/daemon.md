# 守护进程（launchd）

中枢（`dev.raindown.hub`）和节点（`dev.raindown.node`）以 macOS LaunchAgent 常驻：登录后自动启动，崩溃后由 launchd 拉起（`KeepAlive`，`ThrottleInterval` 5 秒）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `raindown daemon install` | 写入 `~/Library/LaunchAgents/dev.raindown.{hub,node}.plist`，用 launchctl 加载，等待中枢健康检查通过 |
| `raindown daemon status` | 两个服务的加载状态与 PID、plist 中 bun 与入口路径是否仍有效、中枢健康、最近一次账本备份 |
| `raindown daemon uninstall` | 卸载并删除两个 plist；账本与 `state/` 不受影响 |

日志：`$RAINDOWN_HOME/state/logs/{hub,node}.log`，按大小轮转。

plist 里写的是安装时 bun 与 `packages/cli/src/main.ts` 的绝对路径。仓库移动或 bun 重装后，`raindown daemon status` 和 `raindown doctor` 会报路径失效，重新运行 `raindown daemon install` 即可。

## 节点配置（`config/node.yaml`）

字段：`capabilities`、`concurrency`（默认 1）、`hub_url`，以及 ④ 新增的 `reserved`：

```yaml
reserved:
  supervisor: 1   # 只给普通 supervisor 唤醒的预留槽，默认 1
  reply: 1        # 只给代回复（reply）唤醒的预留槽，默认 1
```

**升级注意**：`node.yaml` 是严格校验的，未知字段会让读取失败。写入 `reserved` 之后，**旧版本的节点二进制会因为不认识该字段而读取失败、无法启动**。先升级节点（与中枢）再写 `reserved`；回滚到旧版本前先删掉这一节。不写时取默认值，新旧版本都能读。

worker 凭证隔离开关（add-worker-credential-isolation 4.1–4.4，缺省关闭）：

```yaml
isolation:
  enforce: false  # true 时（仅 macOS）以 sandbox-exec 包裹 danger-full-access / bypass 的 Codex 与 claude-sdk worker
```

改动后重启节点生效；改回 `false`（或删掉这一节）即回滚。和 `reserved` 一样，旧版本节点不认识 `isolation`，回滚到旧版本前先删掉这一节。
施加方式、失败时的行为与真实开启前的检查见 [executors.md](executors.md#外层-seatbelt-施加worker-credential-isolation-4144)。

同理，旧节点会 strict 解析策略检查响应中的 `matched_rules[].rule`：升级节点之后，才能在 `policies.yaml` 中写带新条件（`when.push_to`、`when.gh_scope`）的规则，见 `packages/core/src/policy/README.md`。

## 任务重试的升级与回滚限制

**任何一次任务重试（包括它生成的收件箱通知）之后，都不能沿用当前账本回滚到旧中枢与旧客户端**。这是账本格式与语义的单向迁移：旧版 `task.requeued` 的 `strictObject` 不认识新增的 `requested_by` / `retry_reason` 字段；旧版 `inbox.item_created` 的 `source` 枚举不认识 `task_retry`，旧 CLI 列收件箱也可能解析失败。此外，`failed → queued` 转换及后续 `task.started` 在旧状态机中不合法，重建会以 `ledger_inconsistent` 中止。保留当前 SQLite 投影、暂时不运行 `raindown hub rebuild` 并不能使旧版本兼容这份账本。

使用任务重试前，先停止中枢与节点并备份账本，再启动新版本；使用该账本的客户端也须升级。需要退回旧版本时，必须停止服务并使用升级前的备份，不能继续使用已经发生任何任务重试或包含其收件箱通知的账本；升级后产生的记录不会包含在该备份中。

## 任务阶段：CLI 必须与中枢同步升级

**本版本起 CLI 必须与中枢同步升级（收件箱条目新增 `task_stage` 字段）**。中枢在读取收件箱时为关联任务的条目附加派生阶段 `task_stage`；旧 CLI 的收件箱条目是严格校验的，不认识该字段，对新中枢执行 `raindown inbox` 会解析失败。CLI 与中枢在同一台机器上使用同一份代码，升级时一起更新即可；协议形状不为旧 CLI 做兼容。`task_stage` 只在读取时派生，不写入账本，回滚中枢后不留痕迹。

## 本机验收记录（2026-10-24，add-m1-ledger-daemon 7.2）

环境：macOS 15.1（Darwin 24.1.0），bun 位于 `~/.bun/bin/bun`，`RAINDOWN_HOME=~/raindown-home`。

1. `raindown daemon install`：返回 `ok`，中枢健康检查通过（`ledger_seq: 2`），安装前自动做了一次账本备份。
2. 安装后约 4 秒运行 `raindown daemon status`：中枢已加载，节点显示"未加载"，退出码 1。节点日志显示它比中枢先启动，此时 `state/hub.token` 还不存在，于是以可重试错误 `hub_token_missing` 退出；5 秒后 launchd 重新拉起，节点注册成功。之后 `status` 正常。
3. `kill -9 <中枢 PID>`：1 秒内 launchd 拉起新进程（PID 78285 → 78730），`/v1/health` 恢复，`raindown daemon status` 退出码 0，账本序号连续。
4. 节点在中枢重启期间记录一次 `领取任务失败，稍后重试 hub_unavailable`，随后自动恢复，`raindown node list` 的最近活动时间继续更新。
5. `kill -9 <节点 PID>`：launchd 拉起新节点（PID 78408 → 79041），`raindown daemon status` 退出码 0。

结论：两个服务都能在被强杀后自动恢复，账本完整。

## 已知小问题

- 安装后的头几秒，节点可能因为中枢尚未写出 token 而退出一次，要等 launchd 重试才恢复，所以这段时间内 `raindown daemon status` 可能短暂报 `daemon_unhealthy`。可以改成节点在启动时等待 token 出现。


## 从 Flow 迁移

升级只更名与增加兼容入口，不会自动移动用户数据或改写已有账本事件。已签发 token 的 `fht_` / `fwk_` 前缀保持不变。

1. **停服务**：在旧安装下运行 `flow daemon uninstall`（或停止手动启动的中枢和节点）。确认两个进程都已退出，再处理 SQLite 文件，避免 WAL 中的数据丢失。
2. **移动 home**：将 `~/flow-home` 移到 `~/raindown-home`。也可以暂时保留旧目录；解析顺序为 `RAINDOWN_HOME` → `FLOW_HOME` → 默认目录。如果新默认目录不存在而旧默认目录存在，系统继续使用旧目录，`raindown doctor` 会显示来源与迁移提示。环境变量的空串视为未设置。
3. **改名账本**：在停服务后，将 home 下的 `state/flow.db` 改为 `state/raindown.db`，存在的 `state/flow.db-wal` 与 `state/flow.db-shm` 也分别改为 `state/raindown.db-wal` 与 `state/raindown.db-shm`。没有对应文件时跳过。中枢发现仅有旧账本时会拒绝启动并提示步骤，不会自动创建空账本代替它。旧 `flow-*.db` 备份继续参与列出和轮转，新备份使用 `raindown-*.db`。
4. **更新配置和策略**：将环境变量 `FLOW_*` 改为 `RAINDOWN_*`，MCP 服务器键 `flow` 改为 `raindown`，工具名 `mcp__flow__<工具>` 改为 `mcp__raindown__<工具>`，策略动作 `flow.admin` 改为 `raindown.admin`。旧策略名加载时会规范化并给出 warning，拒绝规则继续生效。`hub status` 与 `doctor` 可检查剩余旧规则。身份变量是例外：两套 actor 中任一个非 user 都会保留限制，两个不同的非 user 身份会报用法错误。
5. **重新安装 daemon**：运行 `raindown daemon install`。它会先 bootout 并删除检测到的旧 `dev.flow.hub` / `dev.flow.node` plist，再安装 `dev.raindown.hub` / `dev.raindown.node`，输出旧服务清理结果。`status` / `uninstall` 同时识别旧标签。
6. **重新链接全局 CLI**：在仓库执行 `bun install`，然后在 `packages/cli` 执行 `bun link`。后续调用使用 `raindown`；过渡期 `flow` 仍指向同一入口，只在 stderr 输出一行改名提示，stdout 与退出码保持不变。最后运行 `raindown doctor` 和 `raindown daemon status`。

兼容期内，普通环境变量优先读取新名、缺省回退旧名；节点会同时传递两套身份与任务变量给子进程。HTTP 客户端只发送 `X-Raindown-Actor`，中枢仍接受 `X-Flow-Actor`；同时提供两个不同值时返回 400。`agents sync` 会用新受管标记原位替换 `flow-managed` 旧区块。
