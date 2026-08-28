# Implement · 合并交叉补齐（执行记录）

> 已执行完毕，保留为记录。三批**顺序**落地，每批单独提交并单独过 CI ——
> 三类缺陷互相独立，回滚与 review 粒度都应独立。

## 前置

合并后测试适配已在 `e5a03ff` 完成（`session-pipeline` 补 `{ now: NOW }`、
`concurrency-guards` N3 改为期望 T-030/T-031 流转）。三批修复以此为基线。

## 批次 1 · O2 / ADR-0003 交叉补齐 → `ee726c3`

1. `src/fact/trace.ts`：`ensureTraceId` 加可选注入 `now`，`TaskCreated` 宿主事件写 `occurred_at`
2. 事件写入点补 `trace_id` + `occurred_at`：`src/control/proposal/pipeline.ts`（intake / synthesize\*）、
   `src/control/driver/driver.ts`（advance）、`src/control/budget/fuse.ts`
3. `src/control/orchestrator/loop.ts`：删 `markRunFailed` 双写，失败离开 RUNNING 收归
   `failRunAndAdvance`（`WHERE status='RUNNING'`）；`limits.wall_clock_s` 跟随 `deps.wallClockS`
4. `migrations/1000000000004_run-running-guards.sql`：索引创建改 `IF NOT EXISTS`
5. 文档对齐：`README.md`、`docs/01-overview.md`、`docs/adr/README.md` 的 ADR-0003 状态；
   `src/acceptance/README.md` 表格补全
6. `src/control/driver/driver.test.ts` 补断言

## 批次 2 · 失败路径成本入账 + 同事务熔断 → `9ce98a3`（C1 × C-002）

1. `src/control/proposal/pipeline.ts`：`runSessionUntilValid` 返回 `PipelineResult`，
   三处失败出口（open 失败 / 轮次中断 / R-006 耗尽）携带已累计 usage；导出 `ZERO_USAGE`
2. `src/control/proposal/index.ts`：导出面跟随
3. `src/control/orchestrator/loop.ts`：`executeRun` / `executeClaimedRun` 返回 `ExecOutcome`；
   `failRunAndAdvance` 写回 `tokens` / `cost` / `cost_basis`（三态，禁止 `0` 冒充 unavailable）
   并在**同一事务**内 `checkBudgetFuse`
4. `src/e2e/budget-fuse.test.ts`：两个方向的确定性断言 —— 超预算熔断挡住 T-030；
   低成本失败仍逐 run 独立计费、不误熔断、正常升人工

## 批次 3 · 合并验收去重 → `68ce401`

1. 删除 `src/acceptance/merge.acceptance.test.ts`
2. `src/acceptance/README.md`：表格去掉该行，合并验收唯一入口指向 `v01-criterion-github`
3. `.trellis/tasks/archive/2026-08/08-25-merge-acceptance/prd.md`：加后记说明替代关系
   （归档快照本体不改写）

## 批次 4 · 收尾记录 → `b38b5ef`

`.trellis/workspace/jionpz/journal-1.md` Session 2：三批复验结论、CI 状态、
刻意 deferred 的三项遗留。

## 验证命令

```bash
GIT_CONFIG_GLOBAL=/dev/null pnpm run check   # → 326 passed / 4 skipped
gh pr checks 35                              # → check pass ×2
gh pr view 35 --json state,mergeStateStatus,isDraft
```

验收测试（`pnpm run test:acceptance`）需真实 token 与远程仓库，**本次未重跑**，由 human 执行。

## 纪律

- 代理不 merge PR、不 archive 任务
- 每批提交前跑一次完整 `check`，不靠 CI 兜底
