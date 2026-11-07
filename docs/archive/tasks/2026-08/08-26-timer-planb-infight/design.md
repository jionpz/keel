# durable timer 方案 B — 技术设计

## 目标

in-flight run 由 Keel 强制收割:executeRun 产 run 级墙钟 timer,pipeline 墙钟打断,InterruptReason='timeout' → TIMEOUT → T-030/T-031。不依赖 harness 是否报超时。

## 设计原则

1. **reap 归执行器,裁决归 Control**:打断是执行层动作(setTimeout + interrupt,非控制面重放);run 状态 TIMEOUT + T-030 由既有 Control 失败面处理。
2. **timeout ≠ cancelled**:InterruptReason 加 'timeout' → OMP awaitResult 返 TIMEOUT(R-009,可重试)vs CANCELLED(R-010,人工)。manager 映射 RUN_TIMEOUT/RUN_CANCELLED 已是正确。
3. **run 级 timer 生命周期**:executeRun 启动产 → run 终态(任意)置 cancelled,防误触发。
4. **幂等**:run 级墙钟唯一键 (run_id, kind);同一 run 不会双 timer。

## 时序

```
executeRun
  ├─ INSERT timer(wall_clock, run_id, due=now+wall_clock_s)   [R1]
  ├─ runSessionUntilValid({ ..., wallClockMs: wall_clock_s*1000 })
  │    ├─ open(handle) → 设 setTimeout(wallClockMs)
  │    ├─ turn1: advance(handle) ... [会话进行中]
  │    ├─ ⏰ timer 到期 → sessions.interrupt(handle, 'timeout')
  │    │     └─ OMP: aborted=true, timeout=true; kill 组(SIGTERM→SIGKILL)
  │    ├─ advance 返回 (adapter awaitResult 看到 aborted+timeout)
  │    │     └─ OMP awaitResult → status='TIMEOUT' (timeout=true)
  │    │     └─ manager → err(RUN_TIMEOUT)
  │    ├─ pipeline: 清 timer; return err(RUN_TIMEOUT)
  │    └─ executeRun: outcome.ok=false, err.kind=RUN_TIMEOUT
  ├─ [成功路径] run=SUCCEEDED + 置 wall_clock timer cancelled
  ├─ [失败路径] err 返回 → failRunAndAdvance
  │     └─ RUN_TIMEOUT → 标 run TIMEOUT + emit RunTimeout → T-030/T-031
  └─ (run 已终态) 若 timer 仍 pending → cancelled(双保险:成功/失败路径都做)
```

## OMP awaitResult 的 timeout 分支

```ts
// omp.ts exec() 尾部(aborted 检查处)
if (state.aborted) {
  return ok({
    status: state.timeout ? 'TIMEOUT' : 'CANCELLED',
    ...
  })
}
```

state 加 `timeout: boolean`(interrupt 时按 reason 置)。

## manager 映射(无需改)

RUN_STATUS_ERROR 已有 `TIMEOUT: 'RUN_TIMEOUT'`。interrupt('timeout')→ awaitResult TIMEOUT → RUN_TIMEOUT(retryable=true)→ failRunAndAdvance 重试路径。

## pipeline 墙钟打断

```ts
// PipelineOptions
readonly wallClockMs?: number

// runSessionUntilValid 内(open 之后)
let watchdog: ReturnType<typeof setTimeout> | null = null
if (opts.wallClockMs !== undefined && opts.wallClockMs > 0) {
  watchdog = setTimeout(() => {
    // fire-and-forget:interrupt 异步,pipeline 不 await
    void sessions.interrupt(handle, 'timeout')
  }, opts.wallClockMs)
}
try {
  for (attempt...) { ... }  // 每次 turn 前检查 watchdog 是否已触发?——
  // 打断后 advance 返回 err,pipeline return;watchdog 只触发一次
} finally {
  if (watchdog) clearTimeout(watchdog)
}
```

**细节**:
- watchdog 全程总墙钟(非每 turn);触发后 interrupt → advance 返回 RUN_TIMEOUT err → 循环退出 → return err。
- 竞争:turn 正常完成(advance 返回 SUCCEEDED)与 watchdog 几乎同时——interrupt 幂等(已返回的 run 无状态),advance 已成功则不受影响;watchdog 在 finally clear。
- extract_error 循环:watchdog 中断后 extract_error 分支仍可能继续?——interrupt 后 aborted,awaitResult 返 TIMEOUT,advance 返回 err 而非 extract_error 分支,循环 break。安全。

## executeRun 接线

```ts
// loop.ts executeRun
const outcome = await runSessionUntilValid(deps.sessions, {
  ...,
  limits: { wall_clock_s: 180, ... },   // 已有
}, prompt, {
  policy: deps.driver.policyEngine,
  now: deps.now(),
  wallClockMs: 180 * 1000,               // 从 limits 取
})

// 成功:置 wall_clock timer cancelled(防残留)
await cancelRunWallClock(taskId, pending.id)

// 失败(retry等):failRunAndAdvance 处理(RUN_TIMEOUT→TIMEOUT→T-030)
// 失败后也置 cancelled —— 双保险
```

`cancelRunWallClock`:UPDATE timer SET state='cancelled' WHERE run_id=$1 AND kind='wall_clock' AND state='pending'。

## run 级 timer 幂等键

- 现有部分唯一索引:Task 级 `(task_id, kind) WHERE pending`。
- run 级墙钟:`(run_id, kind) WHERE pending`?两个索引冲突?——不同列。**决策**:加 `CREATE UNIQUE INDEX timer_run_pending_key ON timer (run_id, kind) WHERE state='pending' AND run_id IS NOT NULL`。Task 级澄清 timer(run_id NULL)不受影响。

## 测试

- **e2e(确定性,fake 挂起 adapter)**:新 `src/e2e/timer-inflight.test.ts`
  - C1:adapter 永不 awaitResult(挂起),wallClockMs=50 → RUN_TIMEOUT → run TIMEOUT → T-030 建重试 run;
  - C2:成功 run 后墙钟 timer 置 cancelled,claim 空;
  - C3:OMP interrupt('timeout') 单测(已有 interrupt 测试扩展:timeout reason → awaitResult TIMEOUT)。
- 既有 run-failure TIMEOUT(harness 报超时)路径不受影响。

## 不做

- 不做独立进程 watchdog(进程内 setTimeout 够;进程崩溃靠 at-least-once 重投 + timer 持久化)。—— 注:若进程崩,in-flight run 无人收割(方案 B 局限,标注 future:独立 timer worker 进程)。
- 不改 InterruptReason 现有语义。
- 不做多 task 并发。