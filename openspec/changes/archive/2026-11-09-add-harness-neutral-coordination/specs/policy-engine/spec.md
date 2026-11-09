# Spec Delta

## ADDED Requirements

### Requirement: 策略版本
系统 SHALL 为每次加载的 `policies.yaml` 计算版本哈希（对规范化后的有效规则计算，注释与空白不影响哈希），并在 `policy.decided`、代回复委托与 supervisor 的代批代答记录中写入该哈希。`raindown hub status` 与 `raindown doctor` MUST 显示当前策略版本。

#### Scenario: 只改了注释
- **WHEN** 用户只修改了 `policies.yaml` 里的注释
- **THEN** 策略版本哈希不变，不产生策略变化事件

#### Scenario: 追溯一次代批
- **WHEN** 用户查看 supervisor 代批 `pnpm check` 的记录
- **THEN** 记录中有当时的策略版本哈希与命中的规则
