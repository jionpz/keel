# v0.1 预算熔断与可观测补口

> 父任务：`08-23-v01-closed-loop`
> 前置：`08-26-v01-closeout` 集成复核标注的缺口

## Goal

补齐父任务跨切面清单中 **C1–C3（成本）** 与 **O2（trace_id）** 的真实落地，使无人干预闭环在超预算时**不静默继续**（`C-002` → `control_mode=paused`，`status` 不变）。

## Background

- `costSpent()` 已从 `run.cost_usd` 聚合（`facts.ts`），但编排循环**未把 Harness usage 写回 run 行** → 聚合恒为 0。
- `C-002` / `BudgetExceeded` / `ControlModeChanged` 在 schema 与文档中存在，**代码无触发路径**。
- `event.trace_id` 列与 `appendEvent` 参数存在，编排路径写事件时**未填入**（全 null）。

## Requirements

### R1 · 成本写回（C1）

run 成功结束后，把 `RunResult.usage` 写入 `run` 行：`tokens_in`、`tokens_out`、`cost_usd`、`cost_basis`（与 `contracts/types.ts` 三态一致）。Human/OMP 路径均覆盖。

### R2 · 预算上限（C2）

- Task 创建时若 `budget_usd` 为 null，使用**全局默认**（常量，如 `DEFAULT_TASK_BUDGET_USD = 10`，写在 `shared/` 或 `control/` 一处，文档注释指向 `08-cross-cutting.md` §3.2）。
- seed / 测试可显式设 `budget_usd` 以控制熔断。

### R3 · 超预算熔断（C3）

每次 run 成本写回后：

1. 聚合 `sum(run.cost_usd)`（`billed`/`estimated` 计入；`unavailable` 的 run **不计入金额熔断**，仍受 C4 wall_clock/max_turns 约束——诚实标注）
2. 若 `cost_spent > budget_usd` 且 `control_mode='auto'`：
   - `UPDATE task SET control_mode='paused'`（**不改 status**）
   - 写 `ControlModeChanged`（`C-002`，from/to/mode）
   - 写 `BudgetExceeded`（含 `cost_spent_usd`、`budget_usd`）
3. 后续 `driver.advance` 因 `control_mode_not_auto` 不再派发（已有机制）；编排循环应识别 paused 并**正常停止**（返回当前 status，非 error）

### R4 · trace_id 贯穿（O2）

- Task 创建时生成 `trace_id`（uuid），存 `task` 表新列 **或** 第一条 `TaskCreated` 事件 payload——**优先复用现有 schema**：若 `task` 表无列，则在内存/第一次事件时生成并**贯穿该 Task 所有后续 event**（含 `effects.emit`、`ArtifactStore.appendEvent`）。
- 实现最小路径：编排器/driver 持有 `traceId`，传给所有 `INSERT INTO event`。
- `span_id`：v0.1 可为 null 或 run_id——不强制。

### R5 · 确定性测试

- 超预算熔断 e2e/单测：注入 FakeAdapter 返回 `cost_usd`，小 budget → paused + 事件对
- trace_id 非 null 断言（至少一条 e2e）
- 现有 check 全绿

## Out of Scope

- N2–N4 乐观锁 / RUNNING 唯一索引 / 并发调度
- 合并验收重跑（仍属 closeout）
- 成本报表、OpenTelemetry 导出

## Acceptance Criteria

- [x] run 成功后 `run.cost_usd` / `cost_basis` 与 Harness 上报一致（单测或 e2e）
- [x] 超预算后 `control_mode='paused'`，`status` 不变；事件含 `ControlModeChanged`+`BudgetExceeded`
- [x] 熔断后编排不再派发新 run（确定性测试）
- [x] 同一 Task 所有新事件的 `trace_id` 相同且非 null
- [x] 父任务 prd 中 C1–C3、O2 可勾选（或更新 closeout 父任务引用）
- [x] `pnpm run check` 全绿

## Key Decisions

| 项 | 选择 |
|---|---|
| C-002 落点 | 编排循环 post-run（非纯 transition 表） |
| 默认预算 | 常量 10 USD，可测 |
| unavailable 成本 | 不参与金额熔断 |

---

## 验收记录（2026-08-27，确定性验收）

`GIT_CONFIG_GLOBAL=/dev/null pnpm run check` **全绿**：lint / typecheck / boundaries /
check:generated / check:transitions（31 条）/ check:purity 全部通过，
**Tests 170 passed | 4 skipped（14 个文件）**。4 个 skipped 均为
`KEEL_REQUIRE_OMP=1` 门控的真实 OMP 集成层（`adapters.test.ts` 第 3 层），
属 AI 验收范畴 —— **AI / acceptance 验收 deferred，由用户稍后用真实 LLM 自行执行**
（含 `test:acceptance` 入口的 `v01-criterion-github.acceptance.test.ts` 合并验收）。

逐条证据（全部来自确定性测试 `src/e2e/budget-fuse.test.ts`，在默认 check 中）：

| AC | 证据 |
|---|---|
| C1 写回一致 | `loop.ts` executeRun 在 `UPDATE run SET ... tokens_in/tokens_out/cost_usd/cost_basis` 后同事务调 `checkBudgetFuse`；测试断言写回值与桩上报逐项相等（120/80/5/`estimated`），`unavailable` 时 `cost_usd` 保持 null（「禁止用 0 冒充」有专门断言） |
| C-002 语义 | `fuse.ts` 只 `UPDATE control_mode='paused'` 不触 status；测试断言 `control_mode='paused'` 且 `status='S-PM_ANALYZING'` 不变，事件对 `ControlModeChanged{transition:'C-002',from:'auto',to:'paused'}` + `BudgetExceeded{cost_spent_usd:5,budget_usd:1}` 齐备 |
| 熔断后不派发 | 测试断言 `NoTransition{reason:'control_mode_not_auto'}` 事件存在、全 Task 恰 1 个 run、0 个 PENDING；`runTaskToCompletion` 返回 ok（正常停止而非 error） |
| trace_id 贯穿 | `ensureTraceId`（`src/fact/trace.ts`）首条事件生成并固定；测试断言该 Task 全部事件（>3 条）trace_id 去重后恰 1 个且非 null |
| 父任务勾选 | `08-23-v01-closed-loop/prd.md` C1–C4、O1–O4 已勾选并注明由本任务补齐（2026-08-26） |
| check 全绿 | 见上，2026-08-27 实测 exit 0 |

另核对：C2 默认预算测试断言 `BudgetExceeded.budget_usd === DEFAULT_TASK_BUDGET_USD`
（task 行 `budget_usd` 为 null 时）；熔断与成本写回在**同一事务**内
（`asRole('keel_control')` 块，崩溃不留「已入账未熔断」窗口）。
