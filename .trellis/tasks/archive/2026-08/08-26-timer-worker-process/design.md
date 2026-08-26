# 独立 timer worker 进程 — 技术设计

## 目标

到期收割从「loop 进程内」升级为「独立进程定期 drain」。loop 崩溃后,worker 仍能:澄清 TTL → T-008;run 墙钟 → TIMEOUT → T-030/T-031。

## 设计原则

1. **收割语义不变,承载变**:方案 A/B 的收割规则(claim 只锁不标、ConsumeTimer/标状态事务内、RUNNING 才标 TIMEOUT)原样复用;worker 只是另一个执行方。
2. **worker 与 loop 并发安全**:SKIP LOCKED + 先标后发同事务;两者抢同一 timer 时,后到者看到状态已变 → 跳过。
3. **run 状态机守卫**:只对 `RUNNING` run 标 TIMEOUT;非 RUNNING(已终态/新 PENDING)仅 cancel timer。
4. **不重构已验证的 failRunAndAdvance**:worker 独立实现 reapTimeoutRun,语义等值靠 e2e 钉住。

## 数据结构(reuse)

- timer 表:已有(kind=clarification_ttl|wall_clock,state pending|fired|cancelled,due_at,run_id)。
- run 表:status RUNNING 判定。
- 无需 migration。

## drainAllDueTimers(`src/timer/worker.ts`)

```ts
export interface ReapStats {
  clarificationFired: number
  runTimeout: number
  skipped: number
}

export async function drainAllDueTimers(deps: {
  driver: WorkflowDriver
  now: () => string
}): Promise<ReapStats>
```

### 1) 澄清 TTL

```ts
const due = await claimDueTimers(deps.now(), { limit: 50 })  // 已有:只列不标
for (const t of due) {
  const adv = await deps.driver.advance(t.taskId, { type: 'TimerFired', timer: 'clarification_ttl' }, deps.now())
  // T-008 effects ConsumeTimer 置 fired(advance 事务内)
  // 若 adv.advanced=false(task 已离开澄清态)→ 不 Consume,timer 仍 pending;
  //   但 claim 已返回过它 —— 幂等靠 SKIP LOCKED:下次 drain 仍能 claim,
  //   但 advance 不匹配 → 不 Consume → 不重复。定期清理由 T-007 CancelTimer 负责。
}
```

### 2) run 墙钟

```ts
// 查到期 run 级 pending 墙钟 + 关联 run
const r = await asRole('keel_control', c => c.query(
  `SELECT t.id AS timer_id, t.task_id, t.run_id, r.stage
   FROM timer t JOIN run r ON r.id = t.run_id
   WHERE t.kind='wall_clock' AND t.state='pending' AND t.due_at <= $1
   FOR UPDATE SKIP LOCKED`, [deps.now()]))
for (const row of r.rows) {
  // 事务内:标 run TIMEOUT(仅 RUNNING)+ cancel timer + emit RunTimeout(经 driver)
  await reapTimeoutRun(row.task_id, row.stage, row.run_id, deps.driver, deps.now())
}
```

## reapTimeoutRun(`src/timer/reap.ts`,worker 域)

```ts
/** 收割 in-flight run 超时:标 TIMEOUT(RUNNING 才标)+ 发 RunTimeout → T-030/T-031。
 *  与 loop.failRunAndAdvance 的 RUN_TIMEOUT 分支语义等值(worker 独立实现)。 */
export async function reapTimeoutRun(
  taskId: string,
  stage: Stage,
  runId: string,
  driver: WorkflowDriver,
  now: string,
): Promise<'timeout' | 'skipped-not-running'> {
  return asRole('keel_control', async (c) => {
    // 只对 RUNNING run 标 TIMEOUT;否则仅清理 timer
    const up = await c.query(
      `UPDATE run SET status='TIMEOUT', ended_at=$2, error_kind='RUN_TIMEOUT', error_detail='timer worker 收割'
       WHERE id=$1 AND status='RUNNING'`, [runId, now])
    await c.query(
      `UPDATE timer SET state='cancelled' WHERE run_id=$1 AND kind='wall_clock' AND state='pending'`, [runId])
    if (up.rowCount === 0) return 'skipped-not-running'
    return 'timeout'
  }).then(async (kind) => {
    if (kind === 'skipped-not-running') return kind
    // 标 TIMEOUT 成功 → 发 RunTimeout → T-030 重试 / T-031 升人工
    const adv = await driver.advance(taskId, { type: 'RunTimeout', stage }, now)
    if (!adv.ok) throw new Error(`RunTimeout advance 失败:${adv.error.detail}`)
    return 'timeout'
  })
}
```

**并发安全**:两个 worker 同抢一 run——`UPDATE ... WHERE status='RUNNING'` 保证只有一个 rowCount=1;另一个 rowCount=0 → skipped(不发 RunTimeout)。timer cancel 幂等(都置 cancelled)。

**loop 并发**:loop 的 executeRun 正在跑(run RUNNING,watchdog 未触发),worker 先到 → 标 TIMEOUT + RunTimeout → T-030 建重试 run(run_id 不同)。原 executeRun 的 watchdog 后续 interrupt 旧 run(已 TIMEOUT,state 已终态)→ interrupt 幂等/NoTransition,不破坏。竞态窗口:watchdog 与 worker 几乎同时——两者都标 TIMEOUT?watchdog 走 failRunAndAdvance(UPDATE ... no RUNNING guard)→ 可能覆盖;worker 已有 RUNNING guard。**决策**:worker 用 RUNNING guard(保守),loop 的 failRunAndAdvance 保持原样(R-009 已验证)。竞态双标 TIMEOUT 无害(同终态,事件可能多一条 RunTimeout → T-030 幂等键防重复 run)。

## runForever(`worker.ts`)

```ts
export async function runForever(deps, opts: { intervalMs?: number } = {}) {
  const intervalMs = opts.intervalMs ?? 5_000
  const stop = new Promise<void>((r) => process.once('SIGTERM', () => r()))
  while (true) {
    await drainAllDueTimers(deps)
    // 可竞态:interval 计时 vs signal —— SIGTERM 后尽快退出
    const timer = setTimeout(() => {}, intervalMs)
    const sig = Promise.race([stop, new Promise<void>(r => setTimeout(r, intervalMs))])
    await sig
    clearTimeout(timer)
  }
}
```

SIGTERM → 退出循环(优雅)。无 bin;提供 `scripts/timer-worker.ts`(tsx 跑)作启动示例,接入层未来接 daemon。

## 测试

- **e2e `src/e2e/timer-worker.test.ts`**:
  - W1:铺 RUNNING run + 到期墙钟 timer(不跑 loop,模拟崩溃后)→ drainAllDueTimers → run TIMEOUT + RunTimeout → T-030 建重试 run;
  - W2:铺 S-NEED_CLARIFICATION + 到期澄清 timer → drain → T-008 → S-ABANDONED,fired;
  - W3:幂等:再 drain 二次,无新增动作(stats 0/0);
  - W4:run 终态(SUCCEEDED) + pending 墙钟 → drain 仅 cancel,不误触 RunTimeout。
- 回归:loop 的 watchdog 收割 e2e(timer-inflight)仍绿(worker 不改 loop 路径)。

## 不做

- 不重构 loop.failRunAndAdvance(独立 worker 实现,等值靠测试)。
- 不引入 daemon 监督框架(库函数 + tsx 示例)。
- 不做多进程 worker 池上限(单 worker 周期 drain,够 v0.1)。
- 不改 timer/run 表结构。