# 转移表与副作用契约

> 记录**实际**做法。来源：`10-26-run-reentry-wallclock` 任务。
> 数值/算法的上游文档是 `docs/04-state-machine.md` §5；这里是**代码纪律**。

---

## `CreateRun` 的 attempt 由副作用决定，键由事件决定

```ts
firstRun(stage) → [{ kind: 'CreateRun', stage, attempt: 'first' }]   // attempt 恒为 1
nextRun(stage)  → [{ kind: 'CreateRun', stage, attempt: 'next' }]    // attempt = 已有 run 数 + 1
```

键是 `${taskId}/${stage}/${attempt}`，`run (idempotency_key)` 上有唯一约束。
**不要**在执行器里给「撞键」加兜底（例如撞了就 +1）：
键必须由事件唯一决定，否则同一事件重放会算出不同的键，造出重复 run；
而且 `SideEffectSkipped` 会不再能区分「重放」与「派发丢失」。

## `firstRun` 只允许用在「一次 Task 生命周期内至多进入一次」的转移

| 转移 | 阶段 | 为什么可以 `first` |
|---|---|---|
| `T-002` | `pm` | `S-NEW` 只由 `T-001`（intake，一次性）进入 |
| `T-003` | `brainstorm` | `S-PM_ANALYZING` 的二次进入走 `T-007` 的 `nextRun(pm)`，没有转移从别处回到它 |
| `T-004` | `rfc_draft` | 理由同 `T-003` |

**返工 / 回炉会再次经过的阶段一律 `nextRun`：**

| 转移 | 阶段 | 二次进入路径 |
|---|---|---|
| `T-010` | `rfc_draft` | `T-016`（人工回炉）→ `S-BRAINSTORM` → 收敛 → 再走一次 T-010 |
| `T-012` | `develop` | `T-019` / `T-022` / `T-025` 返工，`T-014` 人工批准 |
| `T-017` | `qa` | `T-019` QA 返工后开发成功 |
| `T-018` | `review` | `T-022` 评审返工后 QA 通过 |

每处 `nextRun` 都要在 `table.ts` 里写一行注释点明**二次进入路径**，
让后来者不必重推状态图。判断口诀：**这个阶段会不会被同一个 Task 进第二次？**

### 强制手段：白名单 + 双向断言

`src/control/transition/transition.test.ts` 的 `ALLOWED_FIRST_RUN` 列出允许 `firstRun`
的转移 id，实际用 `firstRun` 的转移集合必须与它**完全相等** ——
多一条（有人新写 `firstRun`）红，少一条（有人把白名单项改成 `nextRun` 后忘了删）也红。
断言对象是**转移 id**，不是阶段名：`rfc_draft` 同时出现在 `T-004`（first）与
`T-010`（next），按阶段断言看不出区别。

改这张表时的固定动作：先改 `table.ts`，再跑 `pnpm vitest run src/control/transition`，
然后把任一处 `nextRun` 临时改回 `firstRun` 确认检查**真的会红**，最后还原。
只跑绿不算验证 —— 没有红过的检查可能只是没在检查。

## 撞键必须可归因

`createRun` 的 `ON CONFLICT DO NOTHING` 命中时，除了 `SideEffectSkipped` 还要写
`existing_status`（同键 run 的当前状态）：

| `existing_status` | 含义 | 该做什么 |
|---|---|---|
| `PENDING` / `CLAIMED` / `RUNNING` | 真重放：那次派发还在，本来就没活干 | 什么都不用做 |
| `SUCCEEDED` / `FAILED` / … | **派发丢失**：表里用了 `firstRun` 或 attempt 算错 | 按本节改表；别在事件流里加「已跳过」以外的猜测 |

只记「跳过」会让这两种情况长得一模一样，而它们的处理方式完全相反。
**不加**中止逻辑：状态早在本轮 `advance` 里写过了（见
[database-guidelines](./database-guidelines.md) 的 `asRole` 一节）。

## 常见错误

| 错误 | 后果 |
|---|---|
| 给返工阶段写 `firstRun` | 第二次派发撞键 → 没有 PENDING run → 驱动「无活可干」收工，任务静默停在原状态 |
| 在执行器里给撞键加 +1 兜底 | 重放会造重复 run；`SideEffectSkipped` 失去含义 |
| 白名单只断言「都在允许集里」 | 少一条白名单（有人改成 `nextRun`）不会被发现 |
| 新增副作用时忘了「必须幂等」 | 重放重复开 PR / 重复发通知（`docs/04-state-machine.md` §5.2） |
