# Spec Delta

## ADDED Requirements

### Requirement: 任务绑定会话经中枢读取
任务绑定的 MCP 会话（使用派工令牌）的只读知识操作（检索、读取、结构化查询）SHALL 经中枢执行，worker 侧进程 MUST NOT 需要直接读取 raindown-home。结果与 CLI、无绑定 MCP 的同名操作一致（输入、输出与排序相同），可见范围不超过该任务所属 workspace 可见的条目。

#### Scenario: 隔离下检索
- **WHEN** 隔离下的 worker 调用 `kb_search`，worker 进程无法读取 raindown-home
- **THEN** 检索结果与用户运行 `raindown kb search` 同一查询词的结果一致
