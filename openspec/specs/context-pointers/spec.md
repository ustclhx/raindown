# context-pointers Specification

## Purpose
把注入给 supervisor 与 worker 的上下文当作缓存：马上要用的内容直接给出，其余只给 id、摘要与读取指针；每个对象都带相关对象的 id，使每次全新启动的 supervisor 能沿 id 追溯早期工作。

## Requirements

### Requirement: 截断带读取指针
注入给 supervisor 唤醒或 worker 输入的任何被截断或省略的内容，SHALL 附原始长度和读取指针；读取指针 MUST 对应一个调用方有权使用的只读操作及其参数，按指针读取得到被省略的完整内容（受该操作自身的分页限制）。

#### Scenario: 唤醒输入超出预算
- **WHEN** 一次唤醒的事件超出字符预算，某条卡住事件的终端片段被省略
- **THEN** 该事件带有片段原长和读取指针，supervisor 用指针读到完整片段

### Requirement: 对象带相关 id
注入的任务、派工、事件、收件箱条目与 PR SHALL 带相关对象的 id：任务带父任务、派工、开出或审查的 PR、授权依据中的用户指令；PR 带订阅它的任务与审查任务。

#### Scenario: 找到同一 PR 的旧审查
- **WHEN** supervisor 收到 PR #31 的审查完成事件
- **THEN** 事件中的 PR 对象列出所有审查过它的任务及状态，supervisor 能看出还有一个卡住的旧审查

### Requirement: 按 id 读取账本事件
系统 SHALL 提供只读操作 `event_get`，按 seq 读取一条账本事件；调用方只能读取自己可见范围内的事件（supervisor 限本 workspace，worker 限本任务）。事件中的疑似密钥内容按现有规则遮蔽。

#### Scenario: 越界读取
- **WHEN** product-res 的 supervisor 读取属于另一个 workspace 的事件
- **THEN** 返回 `forbidden`
