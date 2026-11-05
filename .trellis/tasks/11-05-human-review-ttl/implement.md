# 实施计划：`S-HUMAN_REVIEW` 超时自动收尾

> 顺序是有意的：先扩类型（编译器会列出所有必须改的 switch / 联合），
> 再改数据（迁移、转移表），最后接线（effects / drain / CLI）。
> 反过来做会在中途积累大量类型错误，掩盖真正的遗漏。

## 0. 前置

- [ ] 读 `docs/04-state-machine.md` §2（转移表）与 §6（定时器）
- [ ] 读 `src/timer/*`、`src/shared/timers.ts`、`src/control/transition/{types,table}.ts`、`src/control/driver/effects.ts`
- [ ] 确认工作区干净（`git status --porcelain` 为空）

## 1. 类型扩展

- [ ] `src/control/transition/types.ts`
  - `TransitionEvent.TimerFired.timer` → `'clarification_ttl' | 'human_review_ttl'`
  - `SideEffect` 的 `StartTimer` / `CancelTimer` / `ConsumeTimer` 三处 `.timer` 同步扩成同一联合
- [ ] `src/shared/timers.ts`
  - `TIMER_DURATIONS.human_review_ttl = 24 * 3600 * 1000`
  - 新增 `parseHumanReviewTtlHours(raw: string | undefined): number | null`（纯函数，非法抛错）
- [ ] `pnpm run typecheck` —— 此时应把所有需要处理新 kind 的位置暴露出来

## 2. 迁移

- [ ] 新建 `migrations/1000000000009_human_review_ttl.sql`，按 `design.md` §6 写
      Up / Down（Down 先 `DELETE FROM timer WHERE kind='human_review_ttl'` 再加回窄约束）
- [ ] `DATABASE_URL=... pnpm run db:migrate` 跑一次，确认约束真的变了
      （`\d timer` 或 `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='timer_kind_check'`）

## 3. 转移表

- [ ] `src/control/transition/table.ts`
  - `T-013` / `T-020` / `T-023` / `T-026` / `T-031` 的 effects 末尾追加
        `{ kind: 'StartTimer', timer: 'human_review_ttl' }`
  - 新增 `T-028`（紧跟在 `T-016` 之后），与 `T-008` 同构
  - `T-014` / `T-015` / `T-016` 追加 `CancelTimer('human_review_ttl')`
  - `T-040` / `T-041` 各追加**两个** `CancelTimer`（澄清 + 人工裁决）
- [ ] `docs/04-state-machine.md` §2 同步：新增 `T-028` 行，`T-040/T-041` 的 side-effect 列补取消动作
- [ ] `docs/04-state-machine.md` §6 定时器说明补 `human_review_ttl`
- [ ] `pnpm run check:transitions` 必须绿（C4）

## 4. 副作用执行

- [ ] `src/control/driver/effects.ts`
  - `EffectContext` 加可选 `humanReviewTtlMs?: number | null`
  - `startTimer` 按 `design.md` §4.1 解析 duration；`null` → `outcome: 'skipped'`
  - 不要改 `cancelTimer` / `consumeTimer` 的 SQL —— 它们已经按 `kind` 参数化
- [ ] `src/control/driver/driver.ts`：`WorkflowDriver` 构造参数新增可选 `humanReviewTtlMs`，
      透传进 `EffectContext`

## 5. 配置穿透

- [ ] 四个 CLI 入口解析一次并传入 driver：
      `src/cli/run-task.ts` / `run-issue.ts` / `timer-worker.ts` / `decide.ts`
- [ ] 非法值在启动期抛错（fail-closed），错误信息要指出是哪个环境变量、收到了什么

## 6. 收割

- [ ] `src/timer/drain.ts`
  - `ClaimOptions` 加 `kind?: TimerKind`（默认 `clarification_ttl`，保持既有调用不变）
  - SQL 加 `JOIN task` 限定 `task.status`（澄清 → `S-NEED_CLARIFICATION`，
        人工裁决 → `S-HUMAN_REVIEW`）
  - `DueTimer.kind` 类型跟随参数
- [ ] `src/timer/worker.ts`：新增 `human_review` 分支，`ReapStats` 加 `humanReviewFired`
- [ ] `src/control/orchestrator/loop.ts`：`S-HUMAN_REVIEW` 分支先 claim 到期 timer，
      到期则 `advance(TimerFired)` 并 `continue`，否则保持 `stopReason: 'awaiting-human'`

## 7. 测试

- [ ] `src/timer/*.test.ts` 或新建：TTL 到期推进 `S-ABANDONED` 且 timer 变 `fired`
- [ ] 转移表单测：`T-013/T-020/T-023/T-026/T-031` 的 effects 含 `StartTimer(human_review_ttl)`
- [ ] `T-014/T-015/T-016` 的 effects 含 `CancelTimer(human_review_ttl)`
- [ ] `T-040/T-041` 的 effects 含两个 `CancelTimer`
- [ ] 关闭开关：`humanReviewTtlMs = null` 时 `StartTimer` 返回 `skipped`，timer 表无新行
- [ ] 回炉后重进：`S-HUMAN_REVIEW → T-016 → … → T-013` 能重新武装一个 pending timer
      （防「旧 pending 行挡住新 StartTimer」的回归用例）
- [ ] 配置解析：`undefined → 24`、`'0' → null`、`'abc' / '-1' → throw`
- [ ] 反例验证：把 `T-028` 删掉，到期收割用例必须变红（证明测试真的在测这条路径）

## 8. 验证

```bash
pnpm run check                 # lint / typecheck / boundaries / generated / transitions / purity / test
pnpm exec vitest run src/timer src/control/transition src/control/driver
```

- [ ] `check` exit 0
- [ ] 已知无关的 skip（真实 harness 凭据用例）保持 skip，不要为了绿去删
- [ ] 不接受「只跑了局部测试就说完成」

## 9. 提交前

- [ ] `git status` 只含本任务文件
- [ ] 迁移文件已 `git add`（漏提交会让部署端 schema 落后于代码）
- [ ] 3.3 spec 更新：把「timer 三件套 + TTL 配置」写进 `.trellis/spec/backend/`
