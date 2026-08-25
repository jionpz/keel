# durable timer / work queue — 技术设计

## 目标

把 clarification TTL 从 `recordIntent` 做成真实机制:T-005 落库 → 空闲 loop claim 到期 → `advance(TimerFired)` + `ConsumeTimer` 同事务 → T-008 `S-ABANDONED`。

**方案 A(已决)**:同步单循环只收割**已停住**的 task。Run 墙钟继续信 harness `--max-time` / `RUN_TIMEOUT`。不做并发池、不做 in-flight 双保险。

## 已决四条

1. **两层事件**:`TimerFired` 仅 Task 平面、仅 `clarification_ttl` → T-008。R-009 的 Task 入口是 `RunTimeout`,由既有 `failRunAndAdvance` 在 adapter 报 `RUN_TIMEOUT` 时发出。禁止 `driver.advance({ type:'TimerFired', timer:'wall_clock' })`。
2. **v0.1 收割 = A**:`executeRun` 一旦 `await` 会话,本进程无法 drain 该 run。因此本轮 **不创建** `kind='wall_clock'` 行,也 **不** `Promise.race` 打断会话。
3. **fired ⊆ T-008 事务**:`claimDueTimers` 只锁定/列出仍 `pending` 的到期行。`ConsumeTimer` 在 `WorkflowDriver.advance` 同一 `asRole` 事务里 `pending → fired`。先标 fired 再事务外 advance 会在崩溃后永久卡死 `S-NEED_CLARIFICATION`。
4. **CancelTimer**:T-007(`ClarificationReceived`)必须取消 pending `clarification_ttl`,否则后续 claim 会误走 T-008。

## 设计原则

1. timer 是 Fact 平面**可变状态机**:pending → fired | cancelled。不是 append-only。
2. worker 是拉模式:`claimDueTimers(now)`。不启守护、不承诺毫秒精度。
3. 到期是外部事件源:语义对齐 `S-PR_OPEN` + `externalCi`,但是澄清态专用,不是第三条万能 `externalEvent`。
4. 时间注入:`due_at = ctx.now + duration`;claim 用 `due_at <= deps.now()`。Control Plane 不读系统时钟。

## 数据结构

### timer 表(migration 1000000000001)

```sql
CREATE TABLE timer (
  id         uuid PRIMARY KEY,
  task_id    uuid NOT NULL REFERENCES task(id),
  run_id     uuid REFERENCES run(id),  -- 预留;本轮 INSERT 恒 NULL
  kind       text NOT NULL CHECK (kind IN ('clarification_ttl', 'wall_clock')),
  due_at     timestamptz NOT NULL,
  state      text NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending','fired','cancelled')),
  fired_at   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timer_fired_at_i9 CHECK (state <> 'fired' OR fired_at IS NOT NULL)
);
CREATE UNIQUE INDEX timer_pending_key ON timer (task_id, kind) WHERE state = 'pending';
CREATE INDEX timer_due_idx ON timer (due_at) WHERE state = 'pending';

GRANT SELECT, INSERT, UPDATE ON timer TO keel_control;
```

`kind` 含 `wall_clock` 以免下阶段再迁一次;本轮无生产者。

### 期限常量(`src/shared/timers.ts`)

```ts
export type TimerKind = 'clarification_ttl' | 'wall_clock'

export const TIMER_DURATIONS = {
  clarification_ttl: 24 * 3600 * 1000, // 24h;文档 §6 从「待定」改为该值
} as const
```

不提供 `TIMER_DURATIONS.wall_clock`,避免被误当成 R-009 来源。期限来源仍是 `RunSpec.limits.wall_clock_s`(harness)。

## StartTimer / CancelTimer / ConsumeTimer

`SideEffect` 增补:

```ts
| { readonly kind: 'StartTimer'; readonly timer: 'clarification_ttl' }
| { readonly kind: 'CancelTimer'; readonly timer: 'clarification_ttl' }
| { readonly kind: 'ConsumeTimer'; readonly timer: 'clarification_ttl' }
```

- **T-005**:已有 `StartTimer`。`INSERT … ON CONFLICT (task_id, kind) WHERE state = 'pending' DO NOTHING`。
- **T-007**:加 `CancelTimer`。`UPDATE timer SET state='cancelled' WHERE task_id=$1 AND kind='clarification_ttl' AND state='pending'`。0 行 → skipped(已 fired/已无)。
- **T-008**:`on: ['TimerFired']`,`guard: (f, e) => e.type==='TimerFired' && e.timer==='clarification_ttl'`,`effects: [{ kind:'ConsumeTimer', timer:'clarification_ttl' }]`。
  `ConsumeTimer`:`UPDATE … SET state='fired', fired_at=ctx.now WHERE task_id AND kind AND state='pending' AND due_at <= ctx.now`。0 行 → skipped(重放或未到期误投)。

`StartTimer` 的 `timer` 字段收窄为字面量,不再用 `string`。

## claimDueTimers

```ts
export interface DueTimer { id: string; taskId: string; kind: 'clarification_ttl' }

/** 列出到期 pending,不改 state。FOR UPDATE SKIP LOCKED 防并发双投。 */
export async function claimDueTimers(
  deps: { now: () => string },
  opts?: { taskId?: string; limit?: number },
): Promise<DueTimer[]>
```

过滤 `kind='clarification_ttl'`。调用方对匹配当前 task 的行调用 `driver.advance({ type:'TimerFired', timer:'clarification_ttl' }, now)`。

若 advance 未匹配(task 已离开 `S-NEED_CLARIFICATION`):不 Consume,行仍 pending —— 随后应被 T-007 取消,或下一次 claim 仍看到。loop 只在 `status === 'S-NEED_CLARIFICATION'` 时 claim 本 task,避免误投。

## 编排循环

当前:无 PENDING → `return ok(当前状态)`,`S-NEED_CLARIFICATION` 会永远停在第一次进入。

改为(仅该状态,对齐 PR_OPEN):

```
if (state.status === 'S-NEED_CLARIFICATION') {
  const due = await claimDueTimers(deps, { taskId, limit: 1 })
  if (due.length > 0) {
    advance(TimerFired clarification_ttl)
    continue
  }
  if (opts.clarification !== undefined) {
    // 测试注入 ClarificationReceived;生产可暂不传 → 停
    ...
  }
  return ok({ finalStatus: 'S-NEED_CLARIFICATION', steps })
}
```

然后才是「阶段态找 PENDING」。优先级:**PENDING run > 澄清 TTL > 停**。`opts.ci` / `externalCi` 仍只在 `S-PR_OPEN`。不新增笼统 `externalEvent` 以免与 CI 抢事件。

## R-009(本轮不改生产者)

既有路径保持:

`executeRun` 会话失败 `kind==='RUN_TIMEOUT'` → `failRunAndAdvance` 标 run `TIMEOUT` + `advance(RunTimeout)` → T-030/T-031。

本轮可选加固(小、与 timer 无关):`UPDATE run SET status='SUCCEEDED' … WHERE id=$1 AND status='RUNNING'`。无 timer 竞态时 rowCount 仍为 1,不改变成功语义。不作为 R-009 新能力验收。

方案 B(另任务):`executeRun` 内 `Promise.race(会话, due)` 或独立进程 interrupt。

## 测试

- **e2e clarification**:unclear → `S-NEED_CLARIFICATION` → `now()` 拨到 `due_at` 之后再进 loop → T-008 → `S-ABANDONED`;timer `fired`。
- **取消**:澄清态注入 `ClarificationReceived` → T-007,timer `cancelled`;再把 now 拨过 due,claim 为空,不 ABANDONED。
- **幂等**:同一到期行 advance 两次,第二次 ConsumeTimer skipped,状态仍 `S-ABANDONED`。
- **回归**:既有 `run-failure.test.ts` adapter TIMEOUT 路径不动。

## 不做

- 多 task 并发池。
- 长驻 timer 守护进程。
- 本轮插入/drain `wall_clock`。
- 用 timer 打断 in-flight session。
- Temporal(ADR-0003)。
- 到期精度承诺。
- Task 事件联合加入 `wall_clock`(留给方案 B,且 B 也应先走 Run 平面再 `RunTimeout`)。
