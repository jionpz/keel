# 双时间线合并审查与交叉补齐

> 归档型任务：工作已在 [PR #35](https://github.com/jionpz/keel/pull/35) 落地并 CI 全绿。
> 本 prd 是**事后记录**（决策 + 复验凭据 + 刻意 deferred 的遗留），不是待办清单。
> 分支：`cursor/merge-crosscut-fixes-365e` → `main`

## Goal

`e5ee661` 把两条独立演进的时间线合到一起后，**冲突决议正确、`pnpm run check` 全绿**，
但两侧各自的横切不变量（`O2` 事件溯源、`ADR-0003` 注入时钟、`C1`/`C-002` 成本与熔断）
只在自己那条线的写入点上被强制。目标是把这些不变量**交叉补齐到所有写入点**，
并消除合并带来的验收重复，使 `main` 上不存在「一侧有、另一侧无」的横切缺口。

## Background

### 合并本身

`e5ee661` 合并 `origin/main`（v0.1 closeout 线，PR #27：`trace_id` / budget fuse /
concurrency guards）与本地 ingress/timer/CLI 线（GitHub Issue intake、`run-issue`、
反馈显式约束机械核对 4b、`wallClockS` 透传）。冲突决议要点已写在合并 commit 里：

- `emit` 两列都写（`trace_id` + `occurred_at`），签名统一收 `ctx + occurredAt`
- `loop.ts` SUCCEEDED 用注入 `now`（ADR-0003）；`executeClaimedRun` 保留 attempt 幂等键
- N4 CONFLICT 不流转（run 留 `PENDING` 停下）；N3 失败保留 R1 流转语义（T-031 升人工）
- migration `0001_run-running-guards` → `0004`（避免与 `0001_timer` 同号）
- 文档 `ADR-0003` / `ADR-0005` 状态取新，v0.1 实现描述融合

合并后 `e5a03ff` 做了测试适配（`session-pipeline` 补 `{ now: NOW }`；
`concurrency-guards` N3 期望从「失败传播」改为「T-030/T-031 流转」）。

### 审查结论（三份并行审查）

三份独立审查（fable / explore 类）都得出同一结论：

1. **冲突决议本身正确**，无逻辑丢失，`check` 全绿不是假绿；
2. 但合并只保证了「两侧代码都在」，**没有保证「两侧的约束都覆盖对方新增的写入点」**——
   典型形态是新写入点只写 `trace_id` 不写 `occurred_at`，或失败路径完全不走成本核算。

三份审查交集出的明确缺陷分成三类，正好对应 R1–R3。
审查产物本身是会话级的，未入库；结论摘要与逐条落点记录在本文档
及 `.trellis/workspace/jionpz/journal-1.md` Session 2。

## Requirements

### R1 · O2 / ADR-0003 交叉补齐 —— ✅ `ee726c3`

事件写入点与时钟注入的不变量补齐到合并后新增/改动的全部落点：

- `intake` / `synthesize*` / `driver.advance` / `fuse`：**同时**写 `trace_id` 与 `occurred_at`
- `ensureTraceId` 接受可选注入 `now`，用于 `TaskCreated` 这类宿主事件
- 去掉 `markRunFailed` 双写：`failRunAndAdvance` 单独离开 RUNNING
  （`WHERE status='RUNNING'` 守卫；认领后 CONFLICT 仍走 R1 路径）
- harness `limits.wall_clock_s` 跟随 `deps.wallClockS`（CLI 慢模型路径可抬高墙钟）
- `ADR-0003` 文档状态在 `README.md` / `docs/01-overview.md` / `docs/adr/README.md` 对齐
- `src/acceptance/README.md` 表格补全为目录下全部验收文件
- migration `1000000000004` 索引创建改 `IF NOT EXISTS`（承接改名后的升级路径）

### R2 · 失败/超时 run 成本入账 + 同事务熔断 —— ✅ `9ce98a3`（C1 × C-002）

失败路径此前只写 `error_kind` / `error_detail`，已烧掉的各轮 usage 被 pipeline 的
`err` 分支丢弃 —— 最烧钱的场景（R-007 回灌 × T-030 重试）对预算熔断**完全失明**，
每次重试都白烧一整个 run 的预算。

- `pipeline`：`runSessionUntilValid` 返回 `PipelineResult`，失败分支携带已累计 usage
  （open 失败 / 轮次中断 / R-006 耗尽三处出口）；导出 `ZERO_USAGE`
- `loop`：`executeRun` / `executeClaimedRun` 返回 `ExecOutcome`，失败带 usage；
  `failRunAndAdvance` 把 `tokens` / `cost` / `cost_basis` 写回 run 行（**三态口径，
  禁止用 `0` 冒充 unavailable**），并在**同一事务内** `checkBudgetFuse` ——
  与成功路径同一纪律，`FAILED` / `TIMEOUT` / `CANCELLED` 全覆盖
- 确定性 e2e：失败 run 累计超预算 → `FAILED` 行带 cost + `C-002` 熔断且 T-030 不再重试；
  未超预算 → 成本逐 run 独立可见、不误熔断、正常升人工

### R3 · 合并验收去重 —— ✅ `68ce401`

两条合并验收跑同一条昂贵链路（编排器 + 真实 OMP + 真实 GitHub → S-DONE）。

- **保留** `v01-criterion-github.acceptance.test.ts`：断言更严（严格 S-DONE、
  事件流完整重建、`SideEffectApplied` 校验、无遗留 intent），带 fail-fast 权限预检，
  且夹具反馈对目标仓库真实成立
- **删除** `merge.acceptance.test.ts`（08-25 早期版）：终态断言宽松（容忍 S-HUMAN_REVIEW 等），
  夹具反馈（CSV 导出 BOM）对目标仓库不成立；唯一独特断言（PR 幂等复用）
  已由 `github-pr.acceptance.test.ts` 在工具层覆盖，无需迁移
- 同步 `src/acceptance/README.md` 表格与 `08-25-merge-acceptance` 归档 prd 的替代备注

### R4 · 契约级遗留 —— ⏸ deferred（刻意不做）

改动面超出「合并补齐」范围，需独立任务与 ADR/契约变更：

- `ContextBuilt` / `artifact-store.commit` 的 `occurred_at` —— 需扩事件契约
- `ensureTraceId` 省略 `occurredAt` 时的回落分支 —— 保留兼容尚未传 `now` 的旧调用点，
  回落 DB `DEFAULT now()`；清零需先把全部调用点改为注入时钟
- `.trellis/tasks/archive/` 里 `merge.acceptance` 的历史引用 —— 归档快照不改写，
  已在 `08-25-merge-acceptance` 归档 prd 加后记说明替代关系

## Out of Scope

- 重跑 AI 合并验收（`v01-criterion-github` 需真实 token + 远程仓库，由 human 执行）
- durable timer / work queue / 多进程调度（ADR-0003 既有边界）
- 合并 PR 本身 —— 收尾代理不合并，留给 human

## Acceptance Criteria

- [x] R1：`intake` / `synthesize*` / `driver.advance` / `fuse` 全部写 `trace_id` + `occurred_at`
- [x] R1：`markRunFailed` 双写消除，失败离开 RUNNING 只有 `failRunAndAdvance` 一处
- [x] R1：harness `wall_clock_s` 跟随 `deps.wallClockS`；migration `0004` 用 `IF NOT EXISTS`
- [x] R1：`ADR-0003` 文档状态三处对齐；acceptance README 表格与目录一致
- [x] R2：失败/超时/取消 run 写回 `tokens` / `cost` / `cost_basis`（三态口径）
- [x] R2：`failRunAndAdvance` 同事务 `checkBudgetFuse`，超预算挡住 T-030 重试
- [x] R2：确定性 e2e 覆盖「超预算熔断」与「低成本失败仍正常重试」两个方向
- [x] R3：`merge.acceptance.test.ts` 删除，README + 归档 prd 写明替代关系
- [x] `pnpm run check` 全绿 —— **326 passed / 4 skipped**
- [x] CI 对三个 commit 均 success；[PR #35](https://github.com/jionpz/keel/pull/35) ready for review、`mergeStateStatus` CLEAN
- [x] 收尾结论写入 `.trellis/workspace/jionpz/journal-1.md`（`b38b5ef`）
- [ ] human merge PR #35（**不由代理执行**）
- [ ] merge 后 archive 本任务（**不由代理执行**）

## Key Decisions

| 决策 | 理由 |
|---|---|
| 分三批 commit，不合成一个 | 三类缺陷（事件不变量 / 成本核算 / 验收去重）互相独立，回滚粒度和 review 粒度都应独立；每批单独过 CI |
| 失败路径成本用**三态口径**，不用 `0` 冒充 unavailable | `0` 与「未知」在熔断里是两种完全不同的语义；拿 `0` 顶替会让熔断继续失明，只是换了个失明方式 |
| 熔断检查放在 `failRunAndAdvance` **同一事务** | 与成功路径同纪律。分事务会出现「成本已写、熔断未判」的窗口，重试正好从这个窗口穿过 |
| 合并验收保留 `v01-criterion-github`，删掉 `merge.acceptance` | 断言更严 + 夹具对目标仓库真实成立 + 有 fail-fast 权限预检。两条跑同一昂贵链路，留弱的那条只会稀释信号 |
| 唯一独特断言（PR 幂等复用）不迁移 | `github-pr.acceptance.test.ts` 已在工具层覆盖，迁移等于第三份重复 |
| `ensureTraceId` 保留无 `occurredAt` 的回落分支 | 尚有调用点未改注入时钟；强行去掉会把「回落到 DB `DEFAULT now()`」变成运行时缺列 |
| 归档快照里的历史引用不改写 | 归档是当时事实的快照。改写归档 = 伪造历史；正确做法是在归档 prd 加后记 |
| 不 archive 本任务 | PR 未 merge。先 archive 会让 `main` 上出现「已归档但代码不在」的错位 |

## Risks / Deferred

| 项 | 状态 | 说明 |
|---|---|---|
| `ContextBuilt` / `artifact-store.commit` 无 `occurred_at` | deferred（R4） | `O2` 仍有两个已知缺口，需扩契约。不是遗漏，是范围决定 |
| `ensureTraceId` 回落分支 | deferred（R4） | 兼容期存在；回落语义（DB `DEFAULT now()`）已在 `src/fact/trace.ts` 注释写明 |
| 归档快照的 `merge.acceptance` 引用 | 刻意保留 | 已加后记；grep 命中归档路径时属预期 |
| AI 合并验收未重跑 | 由 human 执行 | 需 `KEEL_GITHUB_TOKEN` + `KEEL_TEST_REMOTE_REPO`，确定性 `check` 覆盖不到「模型说了什么」 |
| 失败路径 usage 依赖 adapter 如实上报 | 已知边界 | adapter 不报 usage 时走 `cost_basis` 的 unavailable 态，而不是 `0` |

## Notes

### 审查 agent 结论摘要

- 三份审查一致确认：`e5ee661` 冲突决议正确、`pnpm run check` 全绿、无逻辑丢失
- 三份审查一致指出：合并保证「两侧代码都在」，**不保证「两侧约束覆盖对方的写入点」**
- 交集出的明确缺陷 → R1（事件不变量 / 时钟注入 / 文档与 migration 对齐）、
  R2（失败路径成本与熔断失明）、R3（合并验收重复）
- 审查产物为会话级，未入库；本文档 + journal Session 2 是可检索的结论载体

### PR 与 commit

- PR：[jionpz/keel#35 · fix(merge): 双时间线合并后的 O2 / ADR-0003 交叉补齐](https://github.com/jionpz/keel/pull/35)
  （ready、CI 全绿、`mergeStateStatus` CLEAN）

| commit | 内容 |
|---|---|
| `e5ee661` | Merge `origin/main`（v0.1 closeout PR #27）—— 合并本体，非本任务产出 |
| `e5a03ff` | 合并后测试适配（注入 `now` + N3 流转语义）—— 前置 |
| `ee726c3` | R1 · O2/ADR-0003 交叉补齐（11 files, +115/−69） |
| `9ce98a3` | R2 · 失败/超时 run 成本入账 + 同事务熔断（4 files, +219/−43） |
| `68ce401` | R3 · acceptance 去重，删 `merge.acceptance`（3 files, +15/−250） |
| `b38b5ef` | journal 收尾记录（`.trellis/workspace/jionpz/journal-1.md`） |

### 事实来源

- `docs/08-cross-cutting.md` §「O2 `trace_id` 贯穿 Task 全程」（L162）、
  §「C1 `run` 表记录 tokens/cost/cost_basis」（L227）、§「C3 超预算触发 `C-002`，不静默继续」（L229）
- `docs/adr/0003-workflow-engine.md`（Accepted，注入时钟 / 数据表 + 纯函数转移的边界）
- `src/acceptance/README.md`「分离的真正理由」—— 一个 flaky 测试留在默认 `check` 里会侵蚀 `check` 本身的可信度
