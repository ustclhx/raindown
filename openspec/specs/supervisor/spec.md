# supervisor Specification

## Purpose
TBD - created by archiving change add-harness-neutral-coordination. Update Purpose after archive.

## Requirements

### Requirement: observe 模式
workspace 的 supervisor 配置 SHALL 支持把代批、代答和自主工作分别设为 `observe`：supervisor 照常被唤醒并给出判断，判断只记录为"会怎么做"，不送达 worker、不建任务、不提交合并；对应的卡住照常转给用户。`raindown supervisor report` MUST 对比 observe 判断与用户实际回复，给出一致率。

#### Scenario: 代批处于 observe
- **WHEN** 代批设为 observe，一个 `pnpm check` 授权被委托给 supervisor，supervisor 判断批准
- **THEN** 账本记录"会批准"，授权仍推给用户；用户批准后该判断计为一致

### Requirement: 合同保留原始指令
supervisor 创建的任务合同 SHALL 带上引出它的用户指令的引用（事件 seq 与原文，原文过长时截断并带读取指针），supervisor 写的目标与补充要求单独存放并标明来源。worker 与审查者看到的输入 MUST 同时包含两者，并说明以原始指令为准。

#### Scenario: supervisor 扩写了指令
- **WHEN** 用户的一句话指令被 supervisor 扩写成带完成条件的目标
- **THEN** 任务合同同时有原始指令与 supervisor 的扩写，worker 输入中两者分开显示
