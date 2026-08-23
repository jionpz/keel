# Implement — Workflow driver

## Stage 1 · 事实加载器（`src/control/driver/facts.ts`）

- [ ] 1.1 `loadTransitionFacts(client, task_id, event)` —— verdict / needs_design / attempts
- [ ] 1.2 `loadPolicyFacts(client, task_id, point)` —— 从 A-RFC / A-CriticReview / run 聚合
- [ ] 1.3 读不到必需 fact 时**抛错而非用默认值**（静默默认会让 guard 判错）
- [ ] 1.4 测试

## Stage 2 · 副作用执行器（`effects.ts`）

- [ ] 2.1 全部 SideEffect 类型的分支
- [ ] 2.2 `CreateRun` 幂等：UNIQUE(idempotency_key) 命中则复用 + 记 SideEffectSkipped
- [ ] 2.3 通知类幂等：查是否已有对应 SideEffectApplied 事件
- [ ] 2.4 `EvaluatePolicy`：调 PolicyEngine，结果落 A-PolicyDecision
- [ ] 2.5 未落地的记 SideEffectIntent，**不静默跳过**

## Stage 3 · `advance()`（`driver.ts`）

- [ ] 3.1 单事务编排（design.md §2 的七步）
- [ ] 3.2 `matched:false` → 记 NoTransition，返回 ok + advanced:false
- [ ] 3.3 `now` 由参数注入
- [ ] 3.4 事件类型注册表补充：NoTransition / SideEffectApplied / SideEffectIntent

## Stage 4 · 边界规则

- [ ] 4.1 `driver-must-not-touch-execution`：driver ✗→ src/execution
- [ ] 4.2 反例验证

## Stage 5 · 测试 `[核心里程碑]`

- [ ] 5.1 **S-NEW → S-DONE 走通**，事件流可完整重建
- [ ] 5.2 每条 TaskStatusChanged 的 payload 含 T-* ID
- [ ] 5.3 失败路径：QA fail → 返工 → 重试耗尽 → S-HUMAN_REVIEW
- [ ] 5.4 paused 不推进；Cancelled / UnrecoverableError 仍生效
- [ ] 5.5 **同一事件投递两次，副作用只发生一次**
- [ ] 5.6 终态再收事件 → 无转移

## Stage 6 · 收口

- [ ] 6.1 docs 同步（事件类型注册表）
- [ ] 6.2 prd 验收
- [ ] 6.3 commit
