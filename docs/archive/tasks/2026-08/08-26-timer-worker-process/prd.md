# 独立 timer worker 进程

## Goal

方案 B 局限:进程崩溃时 in-flight run 无人收割—— executeRun 的 watchdog 是进程内 setTimeout,进程死则丢;run 卡 RUNNING、wall_clock timer 残留 pending。独立 timer worker 定期 drain timer 表,让**到期收割不依赖编排进程存活**。

## Background(现状)

| 面 | 消费路径 | 崩溃后 |
|---|---|---|
| 澄清 timer(Task 级) | loop 的 S-NEED_CLARIFICATION 分支 claim → advance(TimerFired) → T-008(ConsumeTimer 置 fired) | loop 死则澄清永不超时,卡 S-NEED_CLARIFICATION |
| run 墙钟 timer(run 级) | executeRun 进程内 watchdog → interrupt → TIMEOUT | 进程死则 run 卡 RUNNING,timer 残留 pending |
| timer 表 | claimDueTimers(SKIP LOCKED 只锁不标)+ ConsumeTimer(advance 事务内置 fired) | 持久化,可被任何进程 drain |

**worker 价值**:从「loop 进程内收割」升级为「独立进程定期 drain」—— loop 崩后,worker 仍能收割澄清与 run 超时。

## Requirements

### R1 · worker 库函数 drainAllDueTimers

- `src/timer/worker.ts` 导出 `drainAllDueTimers(deps): Promise<ReapStats>`:
  - 收割**两类**到期 timer(事务内,幂等):
    1. **澄清 TTL**(Task 级):`advance(taskId, {type:'TimerFired', timer:'clarification_ttl'})`(T-008 的 ConsumeTimer 置 fired;claim 只锁不标,双进程不双投)。
    2. **run 墙钟**(run 级):查 `timer WHERE kind='wall_clock' AND pending AND due_at<=now` + 关联 run;
       - run 若 RUNNING → UPDATE run SET status='TIMEOUT', ended_at, error_kind='RUN_TIMEOUT' + cancelRunWallClockTimer + `advance(taskId, {type:'RunTimeout', stage})` → T-030/T-031(复用 loop 的 failRunAndAdvance 语义);
       - run 非 RUNNING(已终态)→ 仅 cancelRunWallClockTimer(防残留);
  - `claimDueTimers` 已存在(澄清用),扩展或新增 run 级 claim。
- 幂等:SKIP LOCKED + 先标后发/同事务;重复 drain 不双投。

### R2 · 常驻循环(可选)

- `worker.ts` 加 `runForever(deps, { intervalMs })`:循环 drain + sleep;`SIGTERM` 优雅退出。
- 无 bin(纯库);接入层(未来 CLI/daemon)负责启动。可加 `scripts/timer-worker.ts`(tsx 直接跑)演示。

### R3 · 复用 loop 的收割逻辑

- failRunAndAdvance 是 loop 私有(标 run + advance)。抽共享:`src/timer/reap.ts` 或暴露 loop 导出——**决策**:提炼 `reapTimeoutRun(taskId, runId, stage, driver, now)` 到 timer 域,loop 与 worker 共用(单一实现,防漂移)。

### R4 · 回归

- e2e `src/e2e/timer-worker.test.ts`:
  - W1:铺 RUNNING run + 到期 wall_clock timer(无进程收割,模拟崩溃后)→ drainAllDueTimers → run TIMEOUT + RunTimeout → T-030 建重试 run;
  - W2:澄清 timer 到期 + loop 不在(无 S-NEED_CLARIFICATION 分支处理)→ drain → T-008 → S-ABANDONED,timer fired;
  - W3:幂等:重复 drain 不双投(第二遍无动作);
  - W4:run 已终态 + pending timer → drain 仅 cancelled,不误触 RunTimeout。

## Acceptance Criteria

- [ ] R1:drainAllDueTimers 收割两类(澄清 advance + run 超时标 TIMEOUT + T-030)
- [ ] R2:runForever 常驻循环 + 优雅退出(SIGTERM)
- [ ] R3:reapTimeoutRun 共享(loop failRunAndAdvance 与 worker 同源)
- [ ] R4:e2e W1-W4;`pnpm run check` 全绿

## Constraints

- **不改 timer 表结构**(kind/state/due 已有)。
- 不改 loop 的 failRunAndAdvance 行为(worker 调用共享版,语义一致)。
- 多进程并发安全:SKIP LOCKED 锁定 + ConsumeTimer/标状态事务内;双 worker 竞争安全。
- run 状态机:只对 RUNNING run 标 TIMEOUT;非 RUNNING 仅 cancel timer。
- 不引入 daemon 管理框架(常驻循环是库函数,接入层负责监督)。

## Notes

- 复杂任务:design.md + implement.md 后 start。
- 与方案 A/B 衔接:worker 是它们的「独立进程承载」,不改收割语义。
- 崩溃恢复语义:worker 定期跑 → 到期即收割;at-least-once 由 timer 持久化保证。