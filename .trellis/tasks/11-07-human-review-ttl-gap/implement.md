# Implement · 补齐存量 S-HUMAN_REVIEW 的人工裁决 TTL

> 产物顺序：先函数与单测，再接 worker，再 CLI/日志，再 e2e，最后 spec。
> 每步都有可独立验证的检查点；失败可回退到上一步的提交。

## Step 1 · 新增对账函数与单测

- [ ] 新建 `src/timer/arm.ts`：
  - `armMissingHumanReviewTimers(now: string, ttlMs: number | null): Promise<number>`
  - `ttlMs === null` 直接返回 0（不连库）。
  - `asRole('keel_control')` 内：`SELECT ... FOR UPDATE OF k` 选中缺失任务，
    逐条 `INSERT ... ON CONFLICT (task_id, kind) WHERE state='pending' DO NOTHING`。
  - `due_at` 用 `now + ttlMs`；`id` 用 `randomUUID()`。
  - 返回实际插入行数。
- [ ] 新建 `src/timer/arm.test.ts`（真实 Postgres）：
  - 铺 `S-HUMAN_REVIEW` + 无 timer → 24h → 1 行，`due_at` 正确。
  - 二次调用 → 0 行，`due_at` 不变。
  - `ttlMs = null` → 0 行，无 timer。
  - 自定义 1h → `due_at = now + 1h`。
  - `S-PM_ANALYZING` → 0 行。
  - `S-HUMAN_REVIEW` + `control_mode='paused'` → 0 行。
  - 已有 pending 行（不同 due_at）→ 不覆盖。
  - 已有 `cancelled` 行 → 补一条新的 pending（部分唯一索引只约束 pending）。
- [ ] 检查点：`pnpm vitest run src/timer/arm.test.ts` 全绿。
- [ ] 反例：把 `NOT EXISTS` 与 `ON CONFLICT` **两道防线都去掉**再跑，幂等用例必须变红；
      只去掉 `NOT EXISTS` 时 `ON CONFLICT` 仍会兜住，不会变红——这是设计里的第二道防线，不是测试失效。还原。

## Step 2 · 接入 `drainAllDueTimers`

- [ ] `src/timer/worker.ts`：
  - `ReapStats` 增加 `humanReviewArmed: number`，初始化 0。
  - `WorkerDeps` 增加 `readonly humanReviewTtlMs?: number | null`。
  - `drainAllDueTimers` 开头按 §3.4 计算生效 TTL 并调用对账，写入 stats。
- [ ] 更新所有 `ReapStats` 字面量：
  - `src/timer/worker.test.ts` 的 `ZERO`
  - `src/cli/timer-worker.test.ts` 的 `STATS`
- [ ] 检查点：`pnpm run typecheck` 通过；`pnpm vitest run src/timer src/e2e/timer-worker.test.ts` 全绿。

## Step 3 · CLI 接线与日志

- [ ] `src/cli/timer-worker.ts`：
  - `WorkerDeps` 传 `humanReviewTtlMs: humanReviewTtl.value`（与 driver 同源）。
  - **单次 drain** 的日志行在 `humanReviewFired` 后追加
    `humanReviewArmed=${stats.humanReviewArmed}`；常驻模式沿用现状，不新增每轮日志。
- [ ] `src/cli/timer-worker.test.ts`：
  - `STATS` 补字段。
  - 「单次模式」用例断言日志包含 `humanReviewArmed=0`（或注入非零 stats 断言非零）。
- [ ] 检查点：`pnpm vitest run src/cli/timer-worker.test.ts` 全绿。

## Step 4 · e2e：存量任务最终能被 T-028 收割

- [ ] `src/e2e/timer-worker.test.ts` 增加 W8：
  - 铺 `S-HUMAN_REVIEW` + 无 timer。
  - `drainAllDueTimers({ driver, now, humanReviewTtlMs: 24h })` →
    `stats.humanReviewArmed = 1`，timer pending，`due_at = NOW + 24h`。
  - 再 drain → `humanReviewArmed = 0`（幂等）。
  - 把 `due_at` 改到过去，再 drain → `humanReviewFired = 1`，
    `task.status = 'S-ABANDONED'`，timer `state='fired'`。
- [ ] 检查点：`pnpm vitest run src/e2e/timer-worker.test.ts` 全绿。
- [ ] 反例：注释掉 `drainAllDueTimers` 里的对账调用，W8 必须先红；还原。

## Step 5 · Spec 更新

- [ ] `.trellis/spec/backend/transition-effects.md` 的 Task 级 timer 章节：
  - 增加「timer-worker 每轮对账补齐缺失的 human_review_ttl（#75）」一条，
    写明 `control_mode='auto'`、`FOR UPDATE OF task`、TTL=null 不补、
    已有 pending 不改 `due_at`。
- [ ] `docs/04-state-machine.md` §6（若 timer 表中列出 human_review_ttl 的武装/收割路径）
  补一句「存量与漏武装由 timer-worker 对账兜底」，避免文档只描述进门武装。

## Step 6 · 全量验证与提交

- [ ] `pnpm run check` 全绿。
- [ ] 反例汇总：至少 W8 / arm 幂等两处先红后绿已实测。
- [ ] `git diff` review：只改 timer 对账、stats、CLI 日志、测试、spec/docs。
- [ ] commit（Phase 3.4）：一个 commit，message 说明修复 #75；不 push。

## 回滚点

| 回滚到 | 动作 |
|---|---|
| Step 1 之前 | 删除 `src/timer/arm.ts` / `arm.test.ts`，无其它改动 |
| Step 2 之后 | 移除 `drainAllDueTimers` 的对账调用与 `WorkerDeps` 字段，保留独立函数也无害 |
| Step 3 之后 | 回退 CLI 的字段传递与日志；driver 的 TTL 配置不受影响 |
| Step 5 之后 | spec 是追加说明，回退不影响运行代码 |

## 验证命令

```bash
pnpm vitest run src/timer/arm.test.ts
pnpm vitest run src/e2e/timer-worker.test.ts
pnpm vitest run src/cli/timer-worker.test.ts
pnpm run typecheck
pnpm run check
```
