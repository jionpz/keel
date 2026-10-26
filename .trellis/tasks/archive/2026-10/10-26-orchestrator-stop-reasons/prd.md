# PRD · 编排停止原因可区分：无 PENDING run 不再静默当成功

## 问题

`src/control/orchestrator/loop.ts:229-232`：

```ts
const pending = await readPendingRun(taskId)
if (pending === null) {
  return ok({ finalStatus: state.status, steps })
}
```

这一行的意思是「没有待执行的 run，那就收工」，但它把**三件完全不同的事**压成同一个
`ok`：

1. **设计内的等待**：`S-HUMAN_REVIEW` 等人批、`S-NEED_CLARIFICATION` 等人答、
   `S-PR_OPEN` 等 CI、`control_mode ≠ auto` 暂停、capability 被拒、人工撤回（R-010，
   最近一次 run 被标 `CANCELLED`）；
2. **派发丢失**：阶段态本该有 run，但上一轮转移没有建出来；
3. **进程已死**：上一轮 run 停在 `RUNNING`，没人再推进它。

第 2、3 种是故障，但它们和第 1 种长得一样：`keel run-task` 退出码 **0**、
`finalStatus` 报一个中间状态（如 `S-QA`），然后打一句「未到 S-DONE，以下是现状」。

**真实代价**：`10-26-run-reentry-wallclock` 修的 `firstRun` 撞键 bug 正是被这层兜住的 ——
`T-017` 派发丢失后任务静默停在 `S-QA`，看起来像「QA 自己跑完了」。实际的错误
（`SideEffectSkipped` + `existing_status='SUCCEEDED'`）在事件流里躺着，但命令输出
一个字都没提，于是先被归因成「QA 太严」，查了两轮才找到上游两跳。

## 目标

1. **故障不许静默**：阶段态没有待执行 run、且不是因为人工撤回时，明确报错并退出码非 0，
   错误文本要能直接回答「停在哪个状态、最近一次 run 什么状态、下一步查什么」。
2. **合法的停要如实说明**：仍然是成功（退出码 0），但结果里带得出**停止原因**，
   命令输出说人话，而不是笼统的「未到 S-DONE」。

## 需求

- **R1 判据用证据，不用状态分类**：只看「当前状态是阶段态」不够 —— 人工撤回
  （`CANCELLED`）也会让阶段态没有待执行 run，而那是设计内的停。判据必须读最近一次
  run 的状态。
- **R2 合法停清单**（全部保持 `ok`）：终态 / `control_mode ≠ auto` / 澄清态等待 /
  `S-RFC_READY` 无裁决（既有报错不变）/ `S-PR_OPEN` 等 CI / `S-HUMAN_REVIEW` 等人 /
  capability 被拒 / 最近一次 run `CANCELLED`。
- **R3 故障判据**：阶段态 + 无 PENDING run + 最近一次 run 是
  `SUCCEEDED` / `FAILED` / `TIMEOUT`（说明转移本该建下一轮却没建），或者根本没有
  run，或者最近一次 run 仍是 `RUNNING`（说明没人推进）。
- **R4 错误可诊断**：`detail` 至少含当前状态、最近一次 run 的 `stage/attempt/status`，
  并指向「查 `SideEffectSkipped` 的 `existing_status`」这条下一步。
- **R5 结果带停止原因**：`RunToCompletionResult` 增加 `stopReason`，`ok` 的每条路径
  各自填自己的原因；CLI 据此打印，不再一律说「未到 S-DONE」。
- **R6 退出码**：故障 → 1；合法停 → 0（这是本任务唯一要改的对外行为）。
- **R7 只报告，不自动恢复**：不自动重派 run、不改 `control_mode`、不回滚状态。
  猜「要不要再来一次」属于策略，不属于编排器的职责。
- **R8 不新增事件类型**：事件类型词表是封闭的（`src/generated/artifacts.ts`）。
  停止原因是**编排器观察**，不是事实平面的事实。
- **R9 不动 run 级重试语义**：`T-030` / `T-031` / `failRunAndAdvance` 的判定与
  `retryable` 都不改。

## Acceptance Criteria

- [x] **AC1** 阶段态 + 最近 run `SUCCEEDED` + 无 PENDING run → 返回错误（退出码非 0
      的那条路径），detail 含当前状态与最近 run 的三元组
      —— `stop-reasons.test.ts`
- [x] **AC2** 阶段态 + 最近 run `CANCELLED` + 无 PENDING run → `ok` 且
      `stopReason='cancelled'`（`run-failure.test.ts` 用例 C 保持绿，并断言新字段）
      —— `stop-reasons.test.ts` + `run-failure.test.ts` 用例 C
- [x] **AC3** `S-HUMAN_REVIEW` + 无 PENDING run → `ok` + `stopReason='awaiting-human'` —— `stop-reasons.test.ts` + `run-task.test.ts` S-HUMAN_REVIEW
- [x] **AC4** `S-PR_OPEN` + 没配 CI 回调 → `ok` + `stopReason='awaiting-external-ci'` —— `stop-reasons.test.ts`
- [x] **AC5** `control_mode ≠ auto` → `ok` + `stopReason='paused'` —— `stop-reasons.test.ts` + `budget-fuse.test.ts`（2 处）
- [x] **AC6** 阶段态 + 最近 run `RUNNING` + 无 PENDING run → 错误，detail 点名 —— `stop-reasons.test.ts` · RUNNING → 报错
      「run 仍在 RUNNING」
- [x] **AC7** `keel run-task`：故障退出码 1、合法停退出码 0；合法停时打印停止原因 —— `run-task.test.ts`「停止原因 · CLI 输出与退出码」
- [x] **AC8** `pnpm run check` 全绿 —— 36 files / 460 passed / 5 skipped
- [x] **AC9** 负对照：把 R3 判据改成「一律 `ok`」，AC1 / AC6 必须变红；还原后转绿 —— 见 implement.md 负对照记录 N1 / N2

## Non-Goals

- **不做多进程认领仲裁**：`RUNNING` 判定在「单进程同步编排」前提下成立。将来出现
  多 worker 时，「RUNNING 在别人手里」与「RUNNING 死在崩溃进程里」需要租约/心跳才分得开，
  那是独立任务。
- **不自动重派**（R7）。
- **不改 `S-RFC_READY` 无 `A-PolicyDecision` 的既有报错**（已经是错误，语义正确）。
- **不改 CLI 的 `--ci` / `--wall-clock` 等旗标行为**。
- **不追求「所有停止原因都有稳定枚举值」**：只覆盖本任务判据涉及的路径，新增分支时
  补一个值即可；不做插件式扩展。

## Notes / 风险

- `stopReason` 是**新增可选字段**的向后兼容改动；消费方不读它也不会坏。
- 新增错误 kind（若采用）要同步 `RETRYABLE` 与 `error-handling` spec —— 见 `design.md` §4
  对「复用 `NOT_FOUND` 还是新增 `STALLED`」的取舍。
- 阶段态里 `RUNNING` 属于「异常」这一判断，与 `docs/08-cross-cutting.md`
  的 N3/N4 并发守卫同源：单进程里不该有别人持有；判定写进 spec 时要带上这个前提。
