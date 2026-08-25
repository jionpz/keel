# durable timer / work queue — 执行计划

方案 A 已决:本轮只接通 clarification TTL。不要做 executeRun 插 wall_clock,不要把 TimerFired(wall_clock) 送进 Task 转移。

## 批次

### 批次 1 — 表 + 常量 + T-008 守卫类型

1. `migrations/1000000000001_timer.sql`:表、I9 CHECK、部分唯一索引、due 索引、`GRANT SELECT, INSERT, UPDATE ON timer TO keel_control`。
2. `src/shared/timers.ts`:`clarification_ttl` 期限常量(24h)。不要写 wall_clock 默认毫秒。
3. `types.ts`:StartTimer 的 `timer` 收窄为 `'clarification_ttl'`;T-008 文档/guard 文本对齐。TimerFired **不**加 `wall_clock`。
4. `pnpm run db:migrate` + 表结构/授权测试。
5. commit `(issue #24 T1)`。

### 批次 2 — StartTimer / CancelTimer / ConsumeTimer

1. `effects.ts`:StartTimer 真实 INSERT(`ON CONFLICT (task_id, kind) WHERE state = 'pending' DO NOTHING`);CancelTimer;ConsumeTimer。
2. `table.ts`:T-007 挂 CancelTimer;T-008 挂 ConsumeTimer + guard `timer === 'clarification_ttl'`(C4 文档同步)。
3. 单测:落库/幂等/取消/Consume 0 行 skipped;transition 表测试。
4. commit `(issue #24 T2)`。

### 批次 3 — claim + loop 澄清空闲

1. `src/timer/drain.ts`(或 `claim.ts`):`claimDueTimers` — SELECT FOR UPDATE SKIP LOCKED,**不** UPDATE fired。
2. `loop.ts`:`S-NEED_CLARIFICATION` 分支(放在找 PENDING 之前或「无 PENDING 且该状态」):claim 本 task → `advance(TimerFired)`。可选 `opts.clarification` 仅测 T-007。
3. 不要加通用 `externalEvent`;不要在 `executeRun` 插 timer。
4. 可选:`SUCCEEDED` 的 UPDATE 加 `WHERE status='RUNNING'`(防御,非本轮验收点)。
5. commit `(issue #24 T3)`。

### 批次 4 — e2e

1. `src/e2e/timer.test.ts`(或 orchestrator 测试):
   - unclear → 拨 now → T-008 → ABANDONED + fired;
   - ClarificationReceived → cancelled,拨 now 不弃单;
   - Consume 幂等。
2. 确认 `run-failure.test.ts` 仍绿(不插 wall_clock,不受影响)。
3. commit `(issue #24 T4)`。

### 批次 5 — 全量 + 文档

1. `pnpm run check` 全绿。
2. `docs/04-state-machine.md` §6:`clarification_ttl` 默认 24h;注明 wall_clock 仍由 harness limits 产生 `RunTimeout`,本轮无 timer 行。§5.2 可补 StartTimer/CancelTimer/ConsumeTimer 幂等。I9。
3. issue #24 关闭;归档。
4. commit `(issue #24 T5)`。

## 验证命令

```bash
pnpm run db:migrate   # 需本地 PG
pnpm run check
```

## 评审门(已关闭)

- ~~executeRun 插 timer vs StartTimer~~ → 本轮只有 Task StartTimer(clarification)。
- ~~TimerFired(wall_clock) 进 loop~~ → 不做。
- externalCi / ci / 澄清 TTL:CI 只服务 `S-PR_OPEN`;TTL 只服务 `S-NEED_CLARIFICATION`;有 PENDING 先跑 run。
- ConsumeTimer 必须在 `advance` 事务内,claim 不得预先 fired。

## 回滚

- 每批独立 commit;回滚 = revert。
- T1 已 migrate 则 `pnpm run db:reset` 或补 down。
