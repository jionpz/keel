# Round 2 P1 修复 — 技术设计

## 目标

R1:把「run 失败」从编排器异常(return err 中止)降为**正常状态流转**(标 FAILED/TIMEOUT/CANCELLED + emit 失败事件 → T-030 重试 / T-031 升人工)。R2:事件时间统一注入。

## 设计原则

1. **失败是状态,不是异常**。T-030/T-031 转移表已定义失败语义;编排器之前用 `return err` 绕过它们,本任务让 loop 把失败交给 driver 按转移表处理。
2. **T-030 的 guard 输入复用现有语义**。`attemptsOf(stage)` count 全部 run(含 FAILED)——失败 run 标 FAILED 后计数包含它,`nextRun('SAME')` 建的 attempt 自然递增,幂等键 `(task,stage,attempt)` 正确。
3. **RunCancelled 不重试**(R-010)。人工撤回 = 终止语义,标 CANCELLED 不 emit 失败事件,loop 停(等外部/人工)。
4. **事件时间不读时钟**。effects/pipeline 的 emit 与 appendEvent 同纪律,occurred_at 来自注入 now。

## R1 · run 失败面

### 失败分类(executeRun 的错误 → 动作)

| error.kind | run 状态 | 事件 | 转移 |
|---|---|---|---|
| `RUN_TIMEOUT` | TIMEOUT | RunTimeout{stage} | T-030(重试)/ T-031(升人工) |
| `PROTOCOL_ERROR` `SCHEMA_VIOLATION` `WORKSPACE_ERROR` `HARNESS_UNAVAILABLE` 等 retryable | FAILED | RunFailed{stage} | T-030 / T-031 |
| `RUN_CANCELLED` | CANCELLED | 无(或 Cancel 路径) | 不重试,loop 停 |

**执行流**(loop.ts 阶段态分支改造):

```ts
const executed = await executeRun(taskId, pending, deps, ctxBuilder)
if (!executed.ok) {
  const err = executed.error
  const status = err.kind === 'RUN_TIMEOUT' ? 'TIMEOUT' : err.kind === 'RUN_CANCELLED' ? 'CANCELLED' : 'FAILED'
  await asRole('keel_control', c => c.query(
    `UPDATE run SET status=$2, ended_at=$3, error_kind=$4, error_detail=$5 WHERE id=$1`,
    [pending.id, status, deps.now(), err.kind, err.detail],
  ))
  if (status === 'CANCELLED') {
    // 人工撤回:不重试。记录后停(loop 读不到 PENDING,自然 return ok)
    continue  // 下一轮 readPendingRun 无 PENDING → 停
  }
  const event = status === 'TIMEOUT'
    ? ({ type: 'RunTimeout', stage: pending.stage } as const)
    : ({ type: 'RunFailed', stage: pending.stage } as const)
  const adv = await deps.driver.advance(taskId, event, deps.now())
  if (!adv.ok) return err(adv.error)   // 转移本身失败才算编排错误
  steps.push(record(state.status, adv, pending.stage, `${pending.stage} 失败(${err.kind})`))
  continue
}
```

- **T-030 命中**:创建 run(stage, n+1);下一轮 `readPendingRun` 读到新 PENDING → 重试。loop 不 return err,循环继续。
- **T-031 命中**:→ S-HUMAN_REVIEW(关口态);下一轮 `readPendingRun` 无 PENDING → `return ok` 停在人工。NotifyHuman effect 记录人工通知。
- **RunCancelled**:标 CANCELLED,不 emit 失败事件;下一轮无 PENDING → `return ok`。**注意**:run.status 有 CANCELLED,但 Task 级状态机没有 CANCELLED 事件对应——T-040(Cancelled → S-ABANDONED)由外部 `Cancelled` 事件驱动,编排器不自动发。本任务只保证 run 标 CANCELLED 不重试,Task 停在当前状态等外部。

### 幂等与重入安全

- 失败 run 标 FAILED 后,`readPendingRun`(WHERE status='PENDING')不再选中它 → 不会按同幂等键重复执行。
- T-030 建新 run:`createRun` 的 attempt = count(全部 run 含 FAILED)+1 → key 唯一。
- **重试上限**:`MAX_STAGE_ATTEMPTS=3`。attempt 1 失败 → T-030(1<3)→ attempt 2;...attempt 3 失败 → T-030 检查 3<3 false → T-031 升人工。自洽。

### 风险:现有测试

- `ci-wiring.test.ts` 的 `NoSessionAdapter` 在 startRun 抛错(throw):executeRun 会捕获?不——`runSessionUntilValid` 里 `sessions.advance` 调 adapter.startRun,throw 会冒泡为**未捕获异常**,不是 Result err。executeRun 的 `outcome.ok` 判断接不到 throw。**需确认**:NoSessionAdapter 的用途是「CI 接线测试不应再起 session」,测试用 maxSteps=1 提前停,不会走到 executeRun。验证即可。
- `critic-path.test.ts`:fake adapter 全成功,无失败路径,不受影响。
- 新增 e2e:失败 → 重试;失败 → 升人工。

## R2 · occurred_at 统一注入

### effects.ts emit

`emit(c, taskId, type, payload)` 在 EffectContext(有 now)作用域;给 INSERT 加 occurred_at 列,值取 ctx.now。签名加 now 参数(或 context 传入):

```ts
async function emit(c, taskId, type, payload, occurredAt: string): Promise<number> {
  // INSERT INTO event (task_id, type, payload, occurred_at) VALUES ($1,$2,$3::jsonb,$4)
}
```

所有调用点传 `ctx.now`。**但注意**:effects 是副作用执行器,可能在事务中间 emit 多次;occurred_at 都取同一 ctx.now 合理(同一转移内事件同刻)。

### pipeline.ts emit

- ProposalAccepted(105 行)/ ProposalRejected(142 行):INSERT 加 occurred_at。
- **now 来源**:`runSessionUntilValid(sessions, spec, prompt, opts)`——opts 无 now。加 `opts.now?: string`,loop 传入 `deps.now()`。缺省时?**不允许缺省**(重放纪律)——必传;pipeline 无 now 时抛错或拒绝接受?保持现状:opts.now 可选但 loop 必传;若未传则保持 DB now(向后兼容测试)。**决策**:加可选 now,loop 传;测试若未传回落 DB now,但契约行为是「应注入」。更严格:now 必传,更新 3 个调用点(session-pipeline.test/session-milestone/loop)。选严格。

### 回归

- 事件流读回:TaskStatusChanged/ProposalRejected 的 occurred_at == 注入 now(±0 秒)。
- e2e:driver advance 后读 event 的 occurred_at == 测试声明的 NOW 常量。

## 不做

- 不实现 durable timer / work queue(失败面的完整持久化调度是后续子任务;本任务接**同步循环内**的失败流转)。
- 不改 MAX_STAGE_ATTEMPTS 配置化。
- 不实现 T-030 的真正的墙钟延迟重试(同步循环无等待)。
- 不改 run.status 枚举。