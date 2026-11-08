# 设计：`S-HUMAN_REVIEW` 超时自动收尾

## 1. 核心决策

**复用 `clarification_ttl` 那一整套机制，不新造定时器抽象。**

已有的三层结构原样沿用：

```
转移表声明副作用 (StartTimer / CancelTimer / ConsumeTimer)
        ↓
effects.ts 执行（同一事务，幂等）
        ↓
timer 表（pending → fired | cancelled，部分唯一索引保证同 (task_id,kind) 至多一个 pending）
        ↓
drain 收割（SKIP LOCKED 只锁不标）→ advance(TimerFired) → 新转移 ConsumeTimer
```

新增的只是 `TimerKind` 的一个取值、一条转移、以及配置解析。**没有新表、没有新状态、
没有新的收割器。**

## 2. 类型扩展（一处定义，四处受益）

`src/control/transition/types.ts`：

```ts
// 出现在转移表里的 timer（wall_clock 不在其中）
type TransitionTimerKind = 'clarification_ttl' | 'human_review_ttl'
```

需要同步的四处：

| 位置 | 扩成 |
|---|---|
| `TransitionEvent.TimerFired.timer` | `'clarification_ttl' \| 'human_review_ttl'` |
| `SideEffect.StartTimer.timer` | 同上 |
| `SideEffect.CancelTimer.timer` | 同上 |
| `SideEffect.ConsumeTimer.timer` | 同上 |

`src/shared/timers.ts` 的 `TimerKind` 同时保留 `wall_clock`，`TIMER_DURATIONS` 增加
`human_review_ttl: 24 * 3600 * 1000`。

## 3. 转移表改动

### 3.1 入边（追加 `StartTimer`）

`T-013` / `T-020` / `T-023` / `T-026` / `T-031` —— 全部 `to: 'S-HUMAN_REVIEW'`，
在既有 effects 末尾追加：

```ts
{ kind: 'StartTimer', timer: 'human_review_ttl' }
```

不把这五条合并成一条通用规则：它们的 from 与 guard 各不相同，合并会牺牲可读性；
`StartTimer` 本身幂等（`ON CONFLICT DO NOTHING`），重复声明无副作用。

### 3.2 新增 `T-028`

```ts
{
  id: 'T-028',
  from: 'S-HUMAN_REVIEW',
  on: ['TimerFired'],
  guard: (_f, e) => e.type === 'TimerFired' && e.timer === 'human_review_ttl',
  guardText: 'timer=human_review_ttl',
  to: 'S-ABANDONED',
  effects: [{ kind: 'ConsumeTimer', timer: 'human_review_ttl' }],
  ignoresControlMode: false,
}
```

与 `T-008` 完全同构。放在 `T-016` 之后，保持「同一 from 的转移聚在一起」的排版习惯。

### 3.3 出边（追加 `CancelTimer`）

- `T-014` / `T-015` / `T-016` 追加 `CancelTimer('human_review_ttl')`
- `T-040` / `T-041` 追加 **两个** `CancelTimer`（`clarification_ttl` + `human_review_ttl`）

> `T-040/T-041` 这一条不是可选项。没有它，任务从 `S-HUMAN_REVIEW` 被取消后
> 会留下 pending 行，`timer_due_idx` 每轮都会扫到它，`advance` 又因为状态不匹配
> 而无法 `ConsumeTimer` —— 变成永久噪音。`clarification_ttl` 现在就有这个泄漏，
> 顺手一起修。

**为什么 `T-016` 必须取消**：回炉后任务会经 `T-011 → T-013` 再次进入 `S-HUMAN_REVIEW`。
旧 pending 行还在的话，新的 `StartTimer` 会被部分唯一索引挡成 `skipped`，
任务静默失去 TTL —— 这种失败不会报错，只会表现为"超时没生效"。

## 4. 配置解析

`KEEL_HUMAN_REVIEW_TTL_H`：

| 值 | 行为 |
|---|---|
| 未设置 | 默认 24 小时 |
| 正整数 | 该小时数 |
| `0` | **关闭**：`StartTimer` 返回 `skipped`，不插行 |
| 负数 / 非数字 / 空串 | 启动期抛错（fail-closed） |

**为什么是进程级而不是 per-task**：per-task 要加 `task` 列 + 迁移 + 控制台入口，
换来的只是少数任务自定 TTL。v1 先不做，PRD 已列为 Out of Scope。

解析放在 `src/shared/timers.ts`，纯函数：

```ts
export function parseHumanReviewTtlHours(raw: string | undefined): number | null
// undefined → 24；'0' → null（关闭）；非法 → throw
```

> **纯度不破**：`transition()` 仍然只返回 `StartTimer` 描述，不读 env。
> env 只在 `effects.ts` 算 `due_at` 时使用，`due_at` 是**落库的数据**，
> 不是转移函数的结果。已提交的转移重放时不会重算 effects。

### 4.1 穿透路径

```
CLI 入口（run-task / run-issue / timer-worker / decide）
  → parseHumanReviewTtlHours(process.env.KEEL_HUMAN_REVIEW_TTL_H)
  → new WorkflowDriver({ ..., humanReviewTtlMs })
  → EffectContext.humanReviewTtlMs（可选字段，未传 = 默认常量）
  → startTimer()
```

`EffectContext` 加一个可选字段而不是改 `TIMER_DURATIONS` 的读法，
是为了让测试可以注入 `0` / 短 TTL，而不必改全局常量。

`startTimer` 里：

```ts
const durationMs =
  effect.timer === 'human_review_ttl'
    ? (ctx.humanReviewTtlMs === undefined ? TIMER_DURATIONS.human_review_ttl : ctx.humanReviewTtlMs)
    : TIMER_DURATIONS[effect.timer]

if (durationMs === null) {
  return { kind: 'StartTimer', outcome: 'skipped', detail: 'human_review_ttl 已关闭' }
}
```

## 5. 收割路径

两条，都要改：

### 5.1 独立 worker（`src/timer/worker.ts`）

`claimDueTimers` 增加 `kind` 参数（默认 `clarification_ttl`，保持既有调用兼容）。
新增 `human_review` 分支，与澄清分支并列：

```ts
claimDueTimers(now, { kind: 'human_review_ttl' })
  → advance(taskId, { type: 'TimerFired', timer: 'human_review_ttl' })
  → T-028 的 ConsumeTimer 置 fired
```

### 5.2 进程内 loop（`src/control/orchestrator/loop.ts`）

在 `S-HUMAN_REVIEW` 的等待分支里，先 claim 本 task 的到期 `human_review_ttl`：

- 有到期行 → `advance(TimerFired)` → 推进一步，`continue`
- 无 → `return { stopReason: 'awaiting-human' }`（现状）

### 5.3 claim 的过滤条件

`claimDueTimers` 的 SQL 加 `JOIN task ON task.id = timer.task_id AND task.status = $state`
（澄清查 `S-NEED_CLARIFICATION`，人工裁决查 `S-HUMAN_REVIEW`）。

这样状态不匹配的残留行永远不会被 claim，即使 `T-040/T-041` 的取消逻辑出 bug，
失效模式也只是"留一行不动的数据"，而不是"每轮醒来一次"。

## 6. 迁移

`migrations/1000000000009_human_review_ttl.sql`：

```sql
-- Up Migration
ALTER TABLE timer DROP CONSTRAINT IF EXISTS timer_kind_check;
ALTER TABLE timer ADD CONSTRAINT timer_kind_check
  CHECK (kind IN ('clarification_ttl', 'wall_clock', 'human_review_ttl'));

-- Down Migration
-- 回滚前置：先确保没有 human_review_ttl 行，否则约束加不回去
DELETE FROM timer WHERE kind = 'human_review_ttl';
ALTER TABLE timer DROP CONSTRAINT IF EXISTS timer_kind_check;
ALTER TABLE timer ADD CONSTRAINT timer_kind_check
  CHECK (kind IN ('clarification_ttl', 'wall_clock'));
```

> Down 里先删行是刻意的：直接加回窄约束会因存量行而失败。
> timer 是可变状态机，删历史行不破坏 `event` 的 append-only 事实。

## 7. 幂等 / 并发 / 重放

| 场景 | 保障 |
|---|---|
| 双 worker 同时 drain | `claimDueTimers` 用 `FOR UPDATE SKIP LOCKED`，只有一方拿到行 |
| `StartTimer` 重放 | `ON CONFLICT (task_id, kind) WHERE state='pending' DO NOTHING` → `skipped` |
| `CancelTimer` 重放 | 0 行更新 → `skipped`，已 fired 的由 `T-028` 吃掉 |
| `ConsumeTimer` 重放 | `AND due_at <= now` 限定，已 fired 的 0 行 → `skipped` |
| advance 事务失败 | timer 仍未 fired（`pending`），下轮可重投 |

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 误弃一个本可一键继续的任务 | 默认 24h 足够长；`KEEL_HUMAN_REVIEW_TTL_H=0` 可整体关闭 |
| TTL 到期后证据丢失 | 不走 `CleanWorkspace`（`T-028` 只 `ConsumeTimer`），分支与提交历史保留 |
| 新增 kind 影响既有澄清路径 | `claimDueTimers` 默认值不变；clarification 分支逻辑零改动 |
| 文档/代码转移表分叉 | `check:transitions` 强制双向比对，CI 会红 |

**回滚**：把 `human_review_ttl` 从四条 union 里删掉 + 移除 `T-028` + 回滚迁移。
已 fire 的 timer 行保留，不影响 `event` 重放。

## 9. 不做的事

- 不自动 `approve` / `reject` / `rework` —— 超时只放弃，不替人裁决
- 不加 per-task TTL 列
- 不改 `S-HUMAN_REVIEW` 的状态语义
- 不动 `capability_request` 的默认 deny
