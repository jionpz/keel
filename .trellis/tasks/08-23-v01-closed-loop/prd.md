# v0.1 最小闭环（父任务）

> 本任务**不直接实现**任何东西。它拥有：源需求、子任务地图、跨子任务的验收标准、最终集成复核。
> 实际交付在各子任务中。

---

## Goal（来自 `docs/09-roadmap.md` §1，逐字不改）

> **一条真实的用户反馈进入系统后，在无人干预的情况下走完 `S-NEW → S-DONE`，
> 产出一个通过 CI 的 PR；且 `readEvents(task_id, 0)` 能完整重建这个 Task 的全过程。**

三个部分缺一不可：

| 部分 | 为什么必须在判据里 |
|---|---|
| 走完 `S-NEW → S-DONE` | 证明状态机完整，不是"跑到 DEVELOPING 就算通了" |
| **无人干预** | 证明 Policy 与自动派发真的在工作，而不是每步都有人点确认 |
| 事件流能完整重建 | 证明 Fact Plane 真的是事实来源。**没有这条，前两条可能是靠副作用蒙对的** |

---

## 前置状态

已完成：

| | |
|---|---|
| 架构文档集 | `docs/` —— 10 篇 + 5 份契约 + 8 份 schema + 6 份 ADR |
| 仓库骨架 | TypeScript / pnpm / vitest / Biome / dependency-cruiser |
| 四条架构约束 | 已机械化为 CI 检查，且经反例验证 |
| 契约 TS 接口 | `src/contracts/` —— 22 个 `[v0.1 必须]` 方法的签名 |
| 转移函数 | `src/control/transition/` —— 31 条转移，纯函数，15 个测试 |

**本机环境**：Node 24.14.1、pnpm 10.33.0、PostgreSQL 16.15（homebrew，运行中）。

---

## 子任务地图

| # | 子任务 | 交付 | 依赖 |
|---|---|---|---|
| 1 | **持久化层与 ArtifactStore** | Postgres schema、迁移、`ArtifactStore` 实现、**不变量由授权与约束强制** | — |
| 2 | Policy Engine 实现 | 表达式求值、严格性偏序、默认 deny、`validate()` | 1 |
| 3 | Context Builder 实现 | 配方、预算与固定降级顺序、`ContextBuilt` 事件 | 1 |
| 4 | Harness Adapter | Claude Code（L2）+ Human（L0） | — |
| 5 | Session Manager 与 Proposal 校验流水线 | 五步校验、checkpoint 策略、`restore` 双路径与失效回退 | 1, 4 |
| 6 | Workflow driver | 转移执行器、durable timer、work queue、幂等落地 | 1 |
| 7 | 工作区与 Git / GitHub 集成 | worktree 隔离、分支、PR（幂等）、CI 状态回读 | — |
| 8 | 端到端集成验证 | 用真实反馈跑通判据 | 全部 |

**顺序建议**：1 → (2, 3, 6 可并行) → 4 → 5 → 7 → 8。

> 父子结构不是依赖系统。上表的顺序是**建议**，具体先后写在各子任务自己的
> `prd.md` / `implement.md` 里。

### 为什么从持久化层开始

三条理由：

1. **一切都经它写**。Proposal 校验、事件流、转移执行都要落盘
2. **不变量 `I5`（Execution 不得写 Fact）必须靠数据库授权强制**，
   这是架构的定义性约束 —— 它应当被**先建**，而不是事后补上。
   骨架里的 dependency-cruiser 规则只是代码层的类比，不是真正的强制
3. 它逼出被刻意推迟的迁移工具选型（骨架任务把它划为 Out of scope 时说明了原因）

---

## 跨子任务验收标准

以下由**父任务**负责，不属于任何单个子任务（勾选与缺口标注：2026-08-26 集成复核，证据见文末）：

- [x] 端到端判据达成（见 Goal）——
  本地闭环 `v01-criterion` 已实测通过（真实 OMP session 驱动全程，CI 由测试注入并显式标记）；
  真实 push / PR / CI 回读由 `github-pr` 实测通过（2026-08-23，见 `github-provider.ts` 中的实测注记）。
  **合并为一次运行**的 `v01-criterion-github.acceptance.test.ts` 代码已就绪，
  执行记录见 `08-26-v01-closeout` 任务 `prd.md`
- [x] `S1`–`S3` 安全：`OmpAdapter` 对 `untrusted` 无能力即拒绝（`CAPABILITY_UNSUPPORTED`，
  `omp.ts` + `adapters.test.ts` 契约拒绝层）；`RunSpec.workspace.untrusted` 是必填布尔、无默认值
  （类型层强制）；Human L0 路径同样显式传 `untrusted: true`（`human-harness.test.ts`）
- [x] `O1`–`O4` 可观测：**已落地**（O2 由 `08-26-v01-budget-fuse` 补齐，2026-08-26）
  - [x] `O1` 事件流完整：每次转移（`TaskStatusChanged`+transition ID）、每次 Proposal
    （`ProposalAccepted`/`ProposalRejected`）、每次 Policy 求值（`PolicyEvaluated`）都有事件
  - [x] `O2` trace_id 贯穿：`ensureTraceId`（`src/fact/trace.ts`）在首条事件生成并固定，
    driver / effects / pipeline / builder / fuse 的所有事件写入统一填入
    （`budget-fuse.test.ts` 断言同一 Task 全部事件 trace_id 相同且非 null）。
    `span_id` 按 PRD 约定 v0.1 保持 null，不强制
  - [x] `O3` `ContextBuilt` 记录 `source_ref` 与 `dropped`（`builder.ts`；`v01-criterion` 断言 §5）
  - [x] `O4` 一条命令导出完整时间线：`pnpm run timeline -- <task_id>`（`scripts/timeline.ts`）
- [x] `C1`–`C4` 成本：**已落地**（C1–C3 由 `08-26-v01-budget-fuse` 补齐，2026-08-26）
  - [x] `C1` 编排循环把全部轮次累计的 usage 写回 run 行（`loop.ts` executeRun +
    `pipeline.ts` PipelineOutcome.usage），三态 `cost_basis` 原样落库，
    null 不用 0 冒充（`budget-fuse.test.ts` 断言写回值与桩上报一致）
  - [x] `C2` 全局默认预算 `DEFAULT_TASK_BUDGET_USD = 10`（`src/control/budget/fuse.ts`），
    `task.budget_usd` 为 null 时生效（`budget-fuse.test.ts` 断言 BudgetExceeded 携带默认值）
  - [x] `C3` 超预算触发 `C-002`：`checkBudgetFuse` 在成本写回同一事务内核算，
    `control_mode → paused` 且 **status 不变**，写 `ControlModeChanged`+`BudgetExceeded`，
    后续 `driver.advance` 因 `control_mode_not_auto` 不再派发（`budget-fuse.test.ts` 全断言）。
    实现落点是编排循环 post-run 而非转移表 —— C-* 与 T-* 是正交维度，转移表未动
  - [x] `C4` 无 `CAP-COST` 的兜底上限：每 Run `wall_clock_s: 180` + `max_turns: 8`（`loop.ts`）；
    `unavailable` 的 Run 不参与金额熔断（`budget-fuse.test.ts` 断言不误触发）
- [ ] `N1`–`N4` 并发：**N1 落地，其余诚实标注**
  - [x] `N1` 每 Task 独立 worktree（`orchestrator-workspace.test.ts` 断言写入互不可见）
  - [ ] `N2` ⚠️ **缺口**：`task.status` 更新在事务内先读后写，但无 `WHERE status=期望值` 条件。
    v0.1 编排是单进程同步、无并发写者，风险受控但未按 §4.2 机械强制
  - [ ] `N3` ⚠️ **部分**：无 `(task_id) WHERE status='RUNNING'` 部分唯一索引；
    行为上由同步循环保证一次只跑一个 run
  - [ ] `N4` ⚠️ **缺口**：并发上限未实现 —— v0.1 无调度器（durable timer / work queue 刻意切出）
- [x] `ADR-0003` 硬约束保持：转移函数仍是纯函数（`check:purity` + dependency-cruiser
  `transition-must-be-pure` 持续为绿；副作用只作为返回值中的描述）
- [x] 骨架建立的四条约束检查**没有被放宽**（`biome.json`/`.dependency-cruiser.cjs`/
  `check:generated`/`check:transitions`/`check:purity` 均未动；`pnpm run check` 全绿）
- [x] `docs/` 与实现的出入已同步（GitHub 集成状态、ADR-0004 → Accepted、
  ADR-0006 保持 Proposed 并写明理由、过时的「子任务 7 未完成」注释 —— 见 `08-26-v01-closeout`）

### 集成复核时必须回答的问题

1. 事件流能否**独立**回答 `docs/08-cross-cutting.md` §2.2 的四个问题？
2. 有没有哪个副作用**不幂等**？（重放一次事件流验证）
3. `HumanAdapter`（`L0`）路径是否真的被执行过？
   —— 若只跑了 Claude Code，降级矩阵在 v0.1 期间等于没被验证（`ADR-0005` 的顾虑）

---

## Non-Goals（继承自 `docs/09-roadmap.md` §2.1）

多项目 / 多租户、UI、Agent Pool、自动合并 PR、自动回滚已合并 PR、
多模型路由、Claude Code 与 Human 之外的 Harness、完整对话的检索分析。

---

## Notes

- 各子任务独立规划、实现、检查、归档
- 本任务在全部子任务完成后做集成复核，然后才算完成

---

## 集成复核（2026-08-26，由 `08-26-v01-closeout` 执行）

### 问题 1：事件流能否独立回答 `docs/08-cross-cutting.md` §2.2 的四个问题？

**能，四问都有确定答案，且全部来自 Fact Plane（不依赖日志检索）：**

| 问题 | 答案来源 | 证据 |
|---|---|---|
| 发生了什么 | `readEvents(task_id, 0)` | `v01-criterion` §4：`TaskStatusChanged` 序列与编排器 steps **逐条相等**；payload 含 `{from, to, transition, event}`，可直接对照转移表核验（如 `{"from":"S-NEW","to":"S-PM_ANALYZING","transition":"T-002","event":"Dispatch"}`）。`pnpm run timeline -- <task_id>` 一条命令导出 |
| 当时看到了什么 | `ContextBuilt` 事件 | payload 含 `context_id`、`sections[].source_ref`（如 `artifact:rfc@1`、`fixed:role/PM`）与必填 `dropped[]`；`v01-criterion` §5 对每个 session 断言 |
| 为什么这么判 | `A-PolicyDecision` | body 含 `facts_snapshot`（求值时的事实快照）与 `matched_rules`（命中规则与严格性偏序结果），`engine.ts` 落库、`v01-criterion` §6 断言 `auto_develop` |
| 按哪版 RFC 做的 | `history(task_id,'rfc','')` | RFC 冻结（`FreezeRfc`）+ 版本链 + `ContextBuilt.sections[].source_ref` 里的 `artifact:rfc@<version>` 指明 Developer/Reviewer 实际看到的版本 |

### 问题 2：有没有哪个副作用不幂等？（重放验证）

**未发现会产生重复外部动作的副作用。** 不是靠推断 —— `effects.test.ts` 的
「幂等重放」describe 块真的重放了一次（确定性单测，在默认 check 中）：

- **提交前崩溃后的重投**（状态拨回事件发生前）：转移再次命中，`CreatePullRequest`
  再次执行但 gateway 幂等复用已有 PR → 事件流恰好 1 条 `SideEffectApplied` +
  1 条 `SideEffectSkipped`，两者指向同一个 `pr_number`，**无第二个 PR**；
- **提交后的重复投递**：转移不命中 → `NoTransition` 事件如实记录「看到了但没动」，
  gateway 零调用。

逐类机制：`CreateRun` 靠 `UNIQUE(idempotency_key)` + `ON CONFLICT DO NOTHING`；
`NotifyHuman`/`AskUser`/`FreezeRfc` 靠事件流判重（`alreadyApplied`）；
`CreateBranch`/`CleanWorkspace` 靠 git 操作本身幂等（分支名 = `f(task_id)`）；
`CreatePullRequest` 靠 push 幂等 + gateway 按 head 分支查已有 PR。

**诚实注记**：v0.1 仅记意图的副作用（`StartTimer`/`CreateTask` 等）重放时会重复写
`SideEffectIntent` 事件 —— 不产生外部动作，只是事件流冗余；真实落地时必须套用同一套判重。

### 问题 3：`HumanAdapter`（L0）路径是否真的被执行过？

**是，且证据在 Fact Plane 而不在测试桩的自述里。** `src/e2e/human-harness.test.ts`
（确定性，在默认 check 中）把 `HumanAdapter` + 同步 `HumanInbox` 放进
`runTaskToCompletion` 跑通 PM 阶段：

- `run` 行记账 `harness_id='human'`、`harness_tier='L0'`、`status='SUCCEEDED'`；
- 人工提交的结论走**与 AI 完全相同**的五步校验落成 `A-StageOutcome`，
  `produced_by_run` 非空，verdict 驱动 `T-004`；
- `ContextBuilt` / `ProposalAccepted` 事件与 AI 路径同构；`workspace.untrusted` 同样显式传入。

**诚实边界**：L0 降级矩阵中「无 `CAP-RESUME` 则每轮重物化」这一条在 v0.1 是**平凡成立**的 ——
编排循环本来就每轮重建上下文，`restore()` 双路径尚未实现（ADR-0006 因此保持 Proposed）。
真正区分 L0/L1 的恢复路径要到 restore 落地后才被执行。

### 复核结论

核心判据的三个部分都有真实证据；跨切面清单中 `O2`（trace_id 贯穿）与
`C1`–`C3`（成本持久化与 `C-002` 熔断）已由 `08-26-v01-budget-fuse` 补齐
（2026-08-26，确定性测试 `src/e2e/budget-fuse.test.ts`）；`N2`–`N4`
（乐观锁/RUNNING 唯一索引/并发上限）仍为**显式缺口**，不假装完成。
合并验收（一次真实运行同时证明三部分 + 真实 PR/CI）的执行记录见
`08-26-v01-closeout/prd.md`。
