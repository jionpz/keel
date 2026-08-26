# 独立 timer worker 进程 — 执行计划

## 批次

### 批次 1 — reapTimeoutRun + drainAllDueTimers

1. `src/timer/reap.ts`:reapTimeoutRun(标 TIMEOUT(RUNNING guard)+ cancel timer + driver.advance(RunTimeout))。
2. `src/timer/worker.ts`:drainAllDueTimers:
   - 澄清:claimDueTimers → advance(TimerFired) → T-008(ConsumeTimer 置 fired);
   - run 墙钟:查到期 pending 墙钟 + 关联 run → reapTimeoutRun。
3. `src/timer/worker.ts` 加 runForever(interval 常驻,SIGTERM 优雅退出)。
4. typecheck + lint。
5. commit `(issue #26 W1)`。

### 批次 2 — e2e W1-W4

1. `src/e2e/timer-worker.test.ts`:
   - W1:铺 RUNNING run + 到期墙钟 → drain → run TIMEOUT + T-030 重试 run;
   - W2:铺 S-NEED_CLARIFICATION + 到期澄清 → drain → T-008 → ABANDONED + fired;
   - W3:幂等(二次 drain stats 空);
   - W4:run 终态 + pending 墙钟 → 仅 cancel,不误触。
2. `pnpm run check` 全绿;timer-inflight(loop watchdog)回归。
3. commit `(issue #26 W2)`。

### 批次 3 — 脚本示例 + 文档 + 收尾

1. `scripts/timer-worker.ts`:tsx 启动示例(drain once,可加 --interval)。
2. 文档:04-state-machine §6 注明 worker 独立承载;02-glossary 或 roadmap「进程崩溃收割」解债。
3. issue #26 关闭(方案 B + worker 全交付);归档;journal + gbrain。
4. commit `(issue #26 W3)`。

## 验证命令

```bash
pnpm run check
```

## 评审门

- worker 与 loop 竞态:worker 用 RUNNING guard 保守;loop 的 watchdog 原有路径不动。
- 双 worker 竞争:UPDATE ... WHERE RUNNING 保证单收割;timer cancel 幂等。
- reapTimeoutRun 与 loop.failRunAndAdvance 的 RUN_TIMEOUT 分支语义等值——靠 W1 钉住(不重构)。

## 回滚

- 每批独立 commit;revert 单独可回。
- worker 与 loop 竞态若暴露:可给 loop 的 failRunAndAdvance 加 RUNNING guard(下一轮)。