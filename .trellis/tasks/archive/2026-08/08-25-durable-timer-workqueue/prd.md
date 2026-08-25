# durable timer / work queue

## Goal

v0.1 欠款:澄清 TTL 定时器从未落地,`TimerFired` 无生产者,`S-NEED_CLARIFICATION` 永不进 `S-ABANDONED`(T-008)。

**本轮范围**:持久化 timer + clarification 到期触发 + 与同步 loop 空闲等待接线。**不做**:多 task 并发调度;用 timer **打断**正在 `await` 的 run(方案 B,另议)。

## 已决(2026-08-25)

采用方案 **A**:

1. **事件分层**:Task 事件 `TimerFired` 只服务 T-008(`clarification_ttl`)。Run 墙钟超时走既有 adapter/`--max-time` → `RUN_TIMEOUT` → `failRunAndAdvance` → `RunTimeout`(T-030/T-031)。不把 `TimerFired(wall_clock)` 喂给 `driver.advance`。
2. **收割模型**:clarification 在 loop **无 PENDING** 时 drain/claim;wall_clock **不**作为 in-flight 双保险(同步 `executeRun` 挡着 drain)。
3. **原子性**:先 claim 仍 pending,`ConsumeTimer` 在 T-008 的 `advance` 事务内标 fired。禁止「事务外先 UPDATE fired 再 advance」。
4. **取消**:T-007 挂 `CancelTimer`;本轮不创建 wall_clock 行,故无 run 终态取消路径。

## Background

| 现状 | 缺口 |
|---|---|
| `StartTimer` effect `table.ts`(T-005,clarification_ttl)→ `effects.ts` recordIntent | 定时器从未落地;clarification 永不超时 → S-NEED_CLARIFICATION 卡死 |
| `runTaskToCompletion` 无 PENDING 时直接 return(含 S-NEED_CLARIFICATION) | 即使 timer 落库,同一次循环也不会等到 TimerFired |
| adapter `--max-time` + `failRunAndAdvance(RUN_TIMEOUT)` 已存在 | R-009 的 Task 侧入口已有;缺的是 clarification 生产者,不是再造一条 wall_clock Task 事件 |

**为什么这是正确性欠款而非优化**:没有 timer,`S-NEED_CLARIFICATION` 永不进 `S-ABANDONED`(T-008)。并发调度与 in-flight 强制收割是优化/下一阶段。

## Requirements

### R1 · 持久化 timer 表

新表 `timer`:
- `id` uuid PK, `task_id` uuid FK, `run_id` uuid NULL(预留给 wall_clock,本轮始终 NULL),
- `kind` text: `clarification_ttl` | `wall_clock`(CHECK;本轮只插入 `clarification_ttl`),
- `due_at` timestamptz(到期时间 = 注入 now + 期限),
- `state` text: `pending` | `fired` | `cancelled`,
- `fired_at` timestamptz NULL, `created_at` / `updated_at`。
- CHECK:`state='fired'` ⇒ `fired_at IS NOT NULL`(I9)。
- GRANT:`keel_control` 对 timer 有 SELECT/INSERT/UPDATE。

migration 新文件(既有 1000000000000,补 1000000000001)。

### R2 · StartTimer / CancelTimer 落库

- `effects.ts` StartTimer:INSERT pending,`due_at = ctx.now + TIMER_DURATIONS.clarification_ttl`(24h,文档标注)。
- 幂等:部分唯一索引 `(task_id, kind) WHERE state='pending'`;`ON CONFLICT (task_id, kind) WHERE state = 'pending' DO NOTHING`。
- T-007 挂 `CancelTimer`:将该 task 上 pending 的 `clarification_ttl` 置 `cancelled`。
- 本轮 **不**从 `executeRun` / StartTimer 插入 `wall_clock`。

### R3 · claim + ConsumeTimer(不是先 fired 再 emit)

- Task `TimerFired` **保持** `timer: 'clarification_ttl'`(不扩展 wall_clock 到 Task 事件)。
- T-008:`on TimerFired` + guard `event.timer === 'clarification_ttl'`;effects 含 `ConsumeTimer`。
- `claimDueTimers(now)`:SELECT … `FOR UPDATE SKIP LOCKED` 到期 pending,**不**改 state;返回候选。
- `driver.advance(TimerFired)` 与 `ConsumeTimer`(pending→fired)同事务(I4)。崩溃则仍 pending,可重投。
- 库函数即可;不启动长驻守护进程。调用方:loop 在 `S-NEED_CLARIFICATION` 且无 PENDING 时 claim 本 task。

### R4 · 编排循环接线

- `S-NEED_CLARIFICATION` 对齐 `S-PR_OPEN` 的空闲等待:无 PENDING 时 claim 本 task 的到期 clarification timer → `advance(TimerFired)` → T-008。
- 未到期且无外部 `ClarificationReceived` 注入 → 停在该状态(调用方可稍后用已过 due 的注入 now 再进 loop)。
- 优先级:有 PENDING run 先执行;CI 路径仍只服务 `S-PR_OPEN`;timer 只在澄清空闲时问。
- R-009:本轮验收 = 既有 `run-failure` / adapter TIMEOUT 路径仍绿,不新增 timer 收割。

### R5 · 回归

- e2e:T-005 → S-NEED_CLARIFICATION → 注入 now≥due → claim → TimerFired → T-008 → S-ABANDONED。
- 幂等:T-008 成功后 timer 为 fired;再次 claim 不返回;重放 ConsumeTimer skipped。
- T-007:pending clarification_ttl 被 cancelled,随后 claim 不得再弃单。
- 既有 run-failure(adapter TIMEOUT → T-030)仍绿。

## Acceptance Criteria

- [ ] R1:migration timer 表;CHECK kind/state/I9;GRANT keel_control
- [ ] R2:StartTimer 落库(due_at 注入);同 kind pending 幂等;T-007 CancelTimer
- [ ] R3:claimDueTimers 不预先 fired;ConsumeTimer 在 advance 事务内;T-008 有 kind 守卫
- [ ] R4:S-NEED_CLARIFICATION 空闲可走 T-008;不把 TimerFired(wall_clock) 送进 Task 转移;不在 executeRun 插 wall_clock
- [ ] R5:clarification e2e + 取消 + 幂等;既有 TIMEOUT 失败面回归;`pnpm run check` 全绿

## Constraints

- **不做多 task 并发调度**(roadmap Non-Goal)。
- **不**用 timer 打断 in-flight `executeRun`(方案 B)。
- 不启动长驻守护进程。
- 不承诺到期精度(调用方决定何时带着已推进的 now 再进 loop)。
- timer 表是可变状态机,不是 append-only。
- 不把 `wall_clock` 写进 Task `TransitionEvent`(避免与 T-008 混淆)。

## Notes

- 标题沿用目录名;本轮交付是 durable **timer**,不是 work queue。
- 复杂任务:design.md + implement.md 收口后 start。
- 分批可独立合并。
