# Spec Delta

## MODIFIED Requirements

### Requirement: 本机 HTTP API
中枢 SHALL 只监听本机回环地址（默认 `127.0.0.1:7477`，可配置），提供版本化的 HTTP API（`/v1/...`）。请求与响应体都 MUST 由 JSON Schema 描述，错误响应采用与 CLI `--json` 一致的格式。启用远程入口时，中枢另在一个独立的本机回环端口（默认 `127.0.0.1:7478`）上只提供远程 MCP 入口（见 remote-mcp）；两个端口的路由 MUST NOT 互通。

#### Scenario: 健康检查
- **WHEN** 请求 `GET /v1/health`
- **THEN** 返回 200 与 `{ ok: true, data: { version, uptime, ledger_seq } }`，此接口无需认证

#### Scenario: 本机端口不提供远程入口
- **WHEN** 向 `127.0.0.1:7477/mcp` 发送带合法远程凭证的请求
- **THEN** 返回 404

### Requirement: Token 认证
除健康检查外，所有 API 都 MUST 携带 `Authorization: Bearer <token>`。认证失败返回 401，且不泄露任何账本内容。请求的操作者身份 SHALL 由 token 决定：
- `state/hub.token`（首次启动时生成，权限 0600）是 `user` 的 token；持有者可以用 `X-Raindown-Actor` 声明一个非 `user` 的身份，不声明时身份为 `user`；声明保留身份（含 `node:*` 与 `remote:*`，不区分大小写）时 MUST 返回 403，错误码为 `reserved_actor`；
- `raindown hub token issue <actor>` 签发的 token 绑定一个非 `user` 的操作者，中枢只保存其摘要；使用这类 token 时身份固定为绑定的操作者，`X-Raindown-Actor` 与之不一致时 MUST 返回 403，错误码为 `actor_mismatch`；
- 带 `--remote` 签发的 token 的操作者 MUST 是小写的 `remote:<id>`，`remote:<id>` 也只能带 `--remote` 签发；这类 token 在本机端口的 `/v1` 上 MUST 一律返回 403，错误码为 `remote_not_allowed`，只能用于远程入口；
- 被 `raindown hub token revoke` 撤销的 token MUST 立即失效。

本机的其他身份声明途径（`raindown mcp --actor`、CLI 的 `--actor` 与 `RAINDOWN_ACTOR`）同样 MUST 拒绝 `remote:*`。

#### Scenario: 缺少 token
- **WHEN** 不带 token 请求 `GET /v1/tasks`
- **THEN** 返回 401，错误码为 `unauthorized`

#### Scenario: 绑定 token 冒充用户
- **WHEN** 使用签发给 `node:mac-mini` 的 token 请求，并在请求头中声明 `X-Raindown-Actor: user`
- **THEN** 返回 403，错误码为 `actor_mismatch`，不产生任何事件

#### Scenario: 远程 token 冒充用户
- **WHEN** 使用签发给 `remote:grok` 的 token 请求本机端口，并在请求头中声明 `X-Raindown-Actor: user`
- **THEN** 返回 403，不产生任何事件

#### Scenario: 撤销后失效
- **WHEN** 用户运行 `raindown hub token revoke <id>` 之后，再用该 token 请求 `GET /v1/tasks`
- **THEN** 返回 401，错误码为 `unauthorized`

#### Scenario: 本机 AI 冒充远程调用方
- **WHEN** 持有 `state/hub.token` 的进程声明 `X-Raindown-Actor: Remote:Grok` 请求 `GET /v1/tasks`，或以 `RAINDOWN_ACTOR=remote:grok` 运行 CLI
- **THEN** HTTP 请求返回 403 `reserved_actor`，CLI 以用法错误退出，均不产生任何事件

#### Scenario: remote 标注与身份不符
- **WHEN** 用户运行 `raindown hub token issue grok --remote` 或 `raindown hub token issue remote:grok`（不带 `--remote`）
- **THEN** 签发被拒绝，提示远程 token 的身份必须是 `remote:<id>` 并带 `--remote`
