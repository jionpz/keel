# Round 2 P1 修复:run 失败面 + occurred_at 统一

## Goal

修复 issue #23 的两个 P1:
- **R1**:run 失败面打通 —— executeRun 失败不再 `return err` 中止,而是标 run FAILED + emit RunFailed/RunTimeout 事件,让 T-030(重试)/T-031(升人工)真正可触发;失败 run 脱离 PENDING,重入不再按同幂等键重复执行。
- **R2**:occurred_at 统一注入 —— effects/pipeline 的事件 INSERT 与 appendEvent 同纪律,事件时间来自注入 now,不回落 DB now()。

## Background(现状,issue #23 R1/R2)

| 面 | 现状 | 缺口 |
|---|---|---|
| executeRun 失败 | `loop.ts:189` `return err(executed.error)` 直接中止 runTaskToCompletion | run 保持 PENDING;T-030/T-031 死转移;重入按同幂等键重复执行;R-006「判 Run FAILED」未兑现 |
| 失败事件 | 全仓无生产侧 `RunFailed`/`RunTimeout` 事件;只有转移表/facts/单测引用 | 编排器不产生失败事件 |
| occurred_at | `appendEvent` 已注入(artifact-store.ts);但 `effects.ts:66`、`pipeline.ts:105,142` 直接 `INSERT INTO event` 无 occurred_at → 回落 DB now() | 契约声明（artifact-store.md §1.4）与生产行为分叉;重放依据被破坏 |

## Requirements

### R1 · run 失败面接通

- **R1a** `executeRun` 失败路径(原 `return err`):按失败类型把 run 标 FAILED,并 emit `RunFailed`/`RunTimeout` 事件,再 `driver.advance(taskId, {type:'RunFailed'|'RunTimeout', stage}, now)`。
  - 失败类型映射:error.kind `RUN_TIMEOUT` → RunTimeout;`RUN_CANCELLED` → 不入 T-030/T-031(人工撤回,不重试——R-010 语义);其余(RUN_TIMEOUT/PROTOCOL_ERROR/SCHEMA_VIOLATION 等)→ RunFailed。
  - 标 FAILED:`UPDATE run SET status='FAILED', ended_at=$2, error_kind=$3, error_detail=$4 WHERE id=$1`。
  - **T-030 的 guard 输入**:`stage_attempts = attemptsOf(stage)` count 全部 run(含 FAILED)——失败 run 标 FAILED 后 count 含它,attempt 自然递增,`nextRun('SAME')` 建 run(stage, n+1) 幂等键正确。
- **R1b** `driver.advance(RunFailed)` 后:
  - T-030 命中(attempt < max)→ 建新 run(stage, n+1),loop 继续循环读取执行;
  - T-031 命中(attempt ≥ max)→ S-HUMAN_REVIEW(关口态,无 PENDING)→ loop `return ok` 停在人工。
  - **不 return err 中止**:失败是正常流程(T-030/T-031 转移处理),不是编排器异常。
- **R1c** RunCancelled:人工撤回 → `RUN_CANCELLED` 不可重试,不能走 T-030。标 FAILED(或 CANCELLED?看 run.status 枚举——没有 CANCELLED,只有 FAILED/TIMEOUT)后 **不 advance 失败事件**(或走 T-040 取消路径)。与文档 §4 对照:run.status 枚举 `PENDING/RUNNING/SUCCEEDED/FAILED/TIMEOUT/CANCELLED`——**有 CANCELLED**。标 CANCELLED,不 emit 失败事件,loop 停(等人工/外部)。
- **R1d 回归**:
  - e2e:fake adapter 产非法提案(连续 3 次)→ R-006 → RunFailed → T-030(attempt 1<3)→ 新 run 重试 → 成功;或连续 3 次 → T-031 → S-HUMAN_REVIEW。
  - 断言:run 不再卡 PENDING;重试 run 的 idempotency_key 以 /2 结尾;事件流含 RunFailed。
  - 现有测试:`ci-wiring` 的 NoSessionAdapter throw——executeRun 现在把它当失败处理,需确认不破坏(它用 maxSteps=1 提前停)。

### R2 · occurred_at 统一注入

- **R2a** 抽共享 emit helper(或统一走 appendEvent):`effects.ts`/`pipeline.ts` 的 `INSERT INTO event` 改为注入 occurred_at。最简:给两个 INSERT 加 `occurred_at` 列,值取自注入的 now。
  - effects 的 emit:`EffectContext.now` 已有。
  - pipeline 的 emit:runSessionUntilValid 无 now 参数——需从 opts 透传或保持 DB now?pipeline 是 Control 平面,应注入。
- **R2b 回归**:事件流 `TaskStatusChanged`/`ProposalRejected` 的 occurred_at == 注入 now(非暧昧的 DB 时钟)。测试:读回事件比 occurred_at。

## Acceptance Criteria

- [ ] R1a:executeRun 失败标 FAILED/TIMEOUT/CANCELLED + emit 失败事件;不再 return err 中止
- [ ] R1b:T-030 重试链走通(新 run attempt=n+1);T-031 → S-HUMAN_REVIEW
- [ ] R1c:RunCancelled 不重试,标 CANCELLED
- [ ] R1d:e2e 覆盖 R-006 → T-030 重试成功 + 连续失败 → T-031 升人工;run 无 PENDING 残留
- [ ] R2a:effects/pipeline 事件注入 occurred_at
- [ ] R2b:事件 occurred_at == 注入 now 回归
- [ ] `pnpm run check` 全绿

## Constraints

- 不重写 Workflow engine(ADR-0003 仍 Proposed)。
- 不实现 durable timer / work queue 全套;本任务只接**同步循环内的失败面**。
- 阶段重试上限沿用 `MAX_STAGE_ATTEMPTS=3`,不新增配置。
- RunCancelled 语义:人工撤回不重试(R-010),与 RUN_CANCELLED retryable=false 一致。
- 不改变 run.status 枚举(已有 CANCELLED)。

## Notes

- 复杂任务:需补 `design.md` + `implement.md` 后 `task.py start`。
- T-030 的 guard 输入依赖 attemptsOf 的「count 全部 run」语义——失败 run 标 FAILED 后计数正确;这是现有语义的复用,不改 facts.ts。
- executeRun 失败后能拿到 run_id(pending.id)与 error,足够标状态 + 发事件;driver.advance 失败事件即可驱动转移,loop 不需要额外逻辑判断。