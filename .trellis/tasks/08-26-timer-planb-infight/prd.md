# durable timer 方案 B:in-flight 会话收割

## Goal

方案 A 只收割已停住的 task(澄清 TTL)。方案 B 让 Keel 在 **in-flight run 执行中**也能按墙钟超时强制收割:run 级 timer(wall_clock)到期 → interrupt 会话 → 标 TIMEOUT → T-030/T-031。不再只依赖 harness `--max-time` 兜底。

## Background(方案 A 状态 + 方案 B 缺口)

| 面 | 现状 | 缺口 |
|---|---|---|
| run 墙钟超时 | 只靠 harness `--max-time`(omp)→ adapter 报 `RUN_TIMEOUT` → failRunAndAdvance → T-030 | Keel 侧无强制收割:harness 不报超时则 run 卡 RUNNING 直到 executeRun 返回 |
| timer 表 | 有 `kind` 含 `wall_clock`(预留),但**无生产者** | 方案 B 需 run 级 timer 行 |
| interrupt | OMP interrupt 已实现(SIGTERM→SIGKILL,进程组);InterruptReason='cancelled'/'budget'/'takeover' | 无 'timeout' 语义,TIMEOUT ≠ CANCELLED(R-009 vs R-010) |
| runSessionUntilValid | 打开 handle 后循环 advance,单一 await | 无墙钟打断点 |

**方案 B = run 级 timer 生产者 + pipeline 墙钟打断 + InterruptReason='timeout' + TIMEOUT 收割接线**。

## Requirements

### R1 · run 级 timer 生产者(executeRun)

- executeRun 启动会话前,若 `limits.wall_clock_s > 0`,INSERT timer(wall_clock, run_id, due_at=now+wall_clock_s)。
- 幂等:部分唯一索引 (task_id, kind) WHERE pending —— 但 run 级应按 run_id?设计:wall_clock timer 的幂等键 = (run_id, kind)(一个 run 一个墙钟)。**决策**:部分唯一索引改为 (run_id, kind) WHERE pending(或 (task_id, kind, run_id))——run 级唯一。
- 本轮**不**在 T-005 类 Task 转移上插 wall_clock(那是澄清 TTL 的领域);wall_clock 只由 executeRun 造。

### R2 · InterruptReason 加 'timeout'

- `harness-adapter.ts`:`InterruptReason = 'cancelled' | 'budget' | 'takeover' | 'timeout'`。
- OMP interrupt:reason==='timeout' → `state.aborted=true` + 标记 `state.timeout=true`;awaitResult 检查:aborted && timeout → status='TIMEOUT';aborted && !timeout → 'CANCELLED'。
- manager RUN_STATUS_ERROR:TIMEOUT → RUN_TIMEOUT(已有)。CANCELLED → RUN_CANCELLED(已有)。
- 语义:R-009(timer 超时)→ TIMEOUT → T-030 重试;R-010(人工/预算)→ CANCELLED 不重试。

### R3 · pipeline 墙钟打断

- `runSessionUntilValid` opts 加 `wallClockMs?: number`:
  - 打开 handle 后设 setTimeout(wallClockMs, () => void sessions.interrupt(handle, 'timeout'));
  - 每次 turn 前重置/只设一次(总墙钟);try/finally 清除;
  - 会话被打断后 advance 返回 err(RUN_TIMEOUT)→ pipeline return err → 走现有失败路径。
- 注:interrupt 是异步,setTimeout 回调里 fire-and-forget(不 await);handle 在作用域。
- 幂等:pipeline 的 R-007 循环内,超时后 interrupt 立即,后续 turn 不再发。

### R4 · executeRun 接线 + run 状态

- executeRun 传 `wallClockMs: spec.limits.wall_clock_s * 1000` 给 pipeline。
- interrupt 后 pipeline 返回 err(RUN_TIMEOUT)→ executeRun return err(err.kind='RUN_TIMEOUT')。
- 外层 failRunAndAdvance:RUN_TIMEOUT → 标 run TIMEOUT + emit RunTimeout → T-030/T-031(已有,R1 修复)。
- **run 级 timer 消费**:run 终结(SUCCEEDED/FAILED/TIMEOUT)后,timer(wall_clock) 应置 cancelled(防后续 drain 误触发)——executeRun 成功/失败路径置 cancelled,pending 墙钟不残留。

### R5 · 回归

- e2e(确定性,fake adapter 可挂起):
  - C:fake adapter 永不返回(挂起),wallClockMs 很短 → pipeline 打断 → RUN_TIMEOUT → run TIMEOUT → T-030 重试;
  - 幂等:run 成功后墙钟 timer 置 cancelled,claim 不返回;
  - 既有:run-failure TIMEOUT 路径(harness 报超时)仍绿。

## Acceptance Criteria

- [ ] R1:executeRun 产 run 级 wall_clock timer;run 终态后 cancelled
- [ ] R2:InterruptReason 含 timeout;OMP interrupt(timeout)→ TIMEOUT(非 CANCELLED)
- [ ] R3:pipeline 墙钟打断;超时 → RUN_TIMEOUT 失败路径
- [ ] R4:被打断 run 标 TIMEOUT → T-030 重试;墙钟 timer 不残留
- [ ] R5:挂起 adapter e2e + 幂等 + 既有回归;`pnpm run check` 全绿

## Constraints

- 不改 InterruptReason 现有三值语义(cancelled/budget/takeover 仍 CANCELLED)。
- 不引入长驻守护(executeRun 内 timer 是进程内 setTimeout)。
- run 级 timer 幂等键独立(run_id, kind),与 Task 级 (task_id, kind) 不冲突。
- 时间注入:due/fired 用 deps.now();setTimeout 是执行层(非控制面重放),仅触发打断。
- 不做多 task 并发(roadmap Non-Goal)。

## Notes

- 复杂任务:design.md + implement.md 后 start。
- 与方案 A(clear TTL)并存:Task 级澄清 timer(cancellable by T-007)vs run 级墙钟 timer(执行期自动)。
- 关键风险:pipeline 的 setTimeout 打断与 R-007 重试竞争(打断后不再发 turn);lease/幂等确认。