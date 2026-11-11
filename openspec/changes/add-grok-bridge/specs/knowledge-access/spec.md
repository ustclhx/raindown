# Spec Delta

## MODIFIED Requirements

### Requirement: 两种接口等价
每个知识访问操作 SHALL 同时以 CLI 子命令（`raindown kb ...`）和 MCP 工具的形式提供。MCP 工具 SHALL 经由两种传输提供：本机的 `raindown mcp`（stdio）和中枢的远程 MCP 入口（streamable HTTP，见 remote-mcp）。同一个操作在 CLI 和 stdio MCP 上的输入、输出和权限规则 MUST 一致。远程入口只开放部分操作，并且 MAY 使用更窄的输入 schema（例如去掉读取本地文件的参数、要求派发引用）与投影后的输出（例如不返回内容摘要）；在远程 schema 与本机相同的输入上，结果 MUST 与本机在同样可见范围内的结果一致。MCP 调用方 MUST 有一个操作者标识（角色名或 harness 名）用于提交记录与权限判断：stdio 由 `--actor` 声明，远程入口由凭证决定（`remote:<id>`）。CLI 默认的操作者是用户本人。

#### Scenario: CLI 与 MCP 结果一致
- **WHEN** 用同一个查询词分别调用 `raindown kb search` 和 MCP 工具 `kb_search`
- **THEN** 两者返回同样的条目，顺序也相同

#### Scenario: stdio 与远程入口结果一致
- **WHEN** 白名单为 `ws/product-res`、`include_global: true` 的远程调用方，与绑定 `ws/product-res` 任务的本机 worker 用同一个查询词检索，且命中的条目都不是 `scope: personal`
- **THEN** 两者返回同样的条目，顺序也相同

## ADDED Requirements

### Requirement: 远程会话经中枢读取
远程 MCP 会话的只读知识操作（检索、读取、结构化查询）SHALL 在中枢内执行，使用与任务绑定会话相同的 core 实现、输入 schema 与错误码；可见范围由远程调用方配置决定（白名单 workspace、可选的 global、排除 `scope: personal`），请求中 MUST NOT 能声明或扩大可见范围。

#### Scenario: 请求中声明 workspace
- **WHEN** 白名单只有 `ws/product-res` 的远程调用方调用 `kb_query owner=ws/xuanxue-saas`
- **THEN** 结果为空，不返回 `ws/xuanxue-saas` 的条目
