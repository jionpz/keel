# durable timer 方案 B — 执行计划

## 批次

### 批次 1 — R2(InterruptReason + OMP timeout)

1. `harness-adapter.ts`:InterruptReason 加 'timeout'。
2. `omp.ts`:
   - RunState 加 `timeout: boolean`;
   - interrupt 按 reason 置 `state.timeout = reason === 'timeout'`;
   - exec() aborted 分支:timeout ? 'TIMEOUT' : 'CANCELLED'。
3. `adapters.test.ts`:interrupt('timeout') → awaitResult TIMEOUT;interrupt('cancelled') → CANCELLED(扩展现有)。
4. commit `(issue #26 B1)`。

### 批次 2 — R3(pipeline 墙钟打断)

1. `pipeline.ts`:
   - PipelineOptions 加 `wallClockMs?: number`;
   - open 后设 watchdog;finally clear;打断 = interrupt(handle,'timeout') fire-and-forget。
2. 单测:session-pipeline 加用例——wallClockMs 很短 + fake adapter 挂起 → RUN_TIMEOUT err。
3. commit `(issue #26 B2)`。

### 批次 3 — R1+R4(executeRun timer 产/消费)

1. 新索引 migration:`timer_run_pending_key (run_id, kind) WHERE pending AND run_id IS NOT NULL`。
2. `loop.ts` executeRun:
   - 启动前插 wall_clock timer(due=now+wall_clock_s);
   - pipeline 传 wallClockMs(从 limits.wall_clock_s);
   - 成功/失败路径 cancelRunWallClock(置 cancelled)。
3. commit `(issue #26 B3)`。

### 批次 4 — R5 e2e + 全量

1. `src/e2e/timer-inflight.test.ts`:
   - C1 挂起 adapter + 短 wallClockMs → RUN_TIMEOUT → run TIMEOUT → T-030 重试;
   - C2 成功 run 后墙钟 timer cancelled,claim 空;
   - C3 幂等:同一 run 无双 timer。
2. `pnpm run check` 全绿;既有 timer/run-failure 回归。
3. commit `(issue #26 B4)`。

### 批次 5 — 文档 + 收尾

1. `04-state-machine.md` §6/§5.2:run 级墙钟 timer(方案 B)标注;InterruptReason timeout 语义。
2. issue #26 关闭;归档;journal + gbrain。

## 验证命令

```bash
pnpm run db:migrate   # 新索引
pnpm run check
```

## 评审门

- R3 的 watchdog 与 R-007 重试竞争:打断后 advance 返 RUN_TIMEOUT err,循环退出,无锁死(design 已析)。
- 进程崩溃时 in-flight run 无人收割 —— 方案 B 局限,文档标注 future(独立 timer worker 进程)。
- limits.wall_clock_s 恒 180(loop 写死)—— 不变,方案 B 用现值。

## 回滚

- 每批独立 commit;revert 可单独回。
- B2 的 watchdog 若破坏 R-007:默认不设 wallClockMs(向后兼容),executeRun 显式传。