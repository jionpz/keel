# Design · 预算熔断与 trace_id

## 1. 成本写回

`loop.ts` `executeRun` 在 `runSessionUntilValid` 返回后，从 session outcome 取 usage（需在 pipeline 或 manager 暴露最后一次 `RunResult.usage`）。

若 pipeline 未返回 usage，扩展 `runSessionUntilValid` 返回值携带 `usage: UsageReport`。

```sql
UPDATE run SET tokens_in=$2, tokens_out=$3, cost_usd=$4, cost_basis=$5, ...
WHERE id=$1
```

## 2. 熔断（C-002）

新函数 `checkBudgetFuse(c, taskId, traceId)` in `control/driver/budget.ts` 或 `orchestrator/budget.ts`:

```
cost_spent = sum(cost_usd) WHERE cost_basis IN ('billed','estimated')
budget = task.budget_usd ?? DEFAULT_TASK_BUDGET_USD
if cost_spent > budget && control_mode === 'auto':
  UPDATE control_mode = 'paused'
  emit ControlModeChanged { transition: 'C-002', from: 'auto', to: 'paused' }
  emit BudgetExceeded { cost_spent_usd, budget_usd }
```

在 `executeRun` 写回成本后、`driver.advance` 前调用。

编排主循环：若 `readState().control_mode === 'paused'` 且非终态，return ok（停在当前 status）—— 与 S-PR_OPEN 无 CI 时行为一致。

## 3. trace_id

**方案（最小迁移）**：不增 DDL。

- `executeRun` / `driver.advance` 路径：从 `task` 首条事件或 lazy：第一次 emit 时若尚无 trace_id，生成并缓存于 `task` 行 meta——**更简单**：在 `seed()` / CreateTask 副作用写 `TaskCreated` 时 payload 含 `trace_id`，后续读 `SELECT payload->>'trace_id' FROM event WHERE type='TaskCreated'`.

更好：**在 effects CreateTask 时生成 trace_id 写入 TaskCreated payload**；新增 `loadTraceId(c, taskId)` 读缓存或首事件。

所有 `emit()` 增加可选 `trace_id` 参数；`ArtifactStore.appendEvent` 调用方传入。

编排器 `runTaskToCompletion` 开头 `loadTraceId`，传入 deps 或 closure。

## 4. 测试策略

- `src/control/driver/budget.test.ts` 或 `src/e2e/budget-fuse.test.ts`：FakeAdapter + 小 budget
- `human-harness.test.ts` 或新测：断言 events 同 trace_id

## 5. 边界

- 不改 `transition/table.ts`（C-* 不在 T 表）
- C4 已有 wall_clock/max_turns —— 不动
