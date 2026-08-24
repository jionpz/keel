# 07 · 端到端流程（Flows）

> 满足 PRD `R6`。
> **本章是三平面骨架的证伪测试**（见任务 `design.md` §7）：
> 如果任何一条真实流程跨不过 Context / Proposal 这两座桥，说明骨架有问题，
> 应回改骨架 —— **不是给流程开后门**。
>
> 走查结果与两处骨架修正见 [§4](#4-走查结论)。

记法：每步标注 `[T-*]` 转移、`[读]` / `[写]` 的产物、`[P]` Policy 判定点。

---

## 1. 流程一 · 自动开发闭环

**输入**（初稿 §13 原案例）：

> "导出的 Excel 希望能够按照日期筛选。"

| # | 动作 | 转移 | 产物 |
|---|---|---|---|
| 1 | Ingress 收到反馈，去重后落库 | — | `[写]` `feedback`；Event `FeedbackReceived` |
| 2 | Triage 建 Task | `T-001` | `[写]` `task(S-NEW)`、`task_feedback` |
| 3 | 派发 PM | `T-002` | `[写]` `run(pm, 1)` → `S-PM_ANALYZING` |
| 4 | ContextBuilder 按 PM 配方装填 | — | `[读]` feedback 原文、空 `A-State`、产品规则；Event `ContextBuilt` |
| 5 | SessionManager 开会话（`workspace.untrusted = true`） | — | Adapter 强制隔离宿主配置（`CAP-UNTRUSTED_WORKSPACE`） |
| 6 | PM 判定可做且需要设计 | — | `[写]` `A-State@1`（F1/F2 两条事实）、`A-StageOutcome(pm, actionable, needs_design)` |
| 7 | 守卫读 `verdict=actionable ∧ needs_design` | `T-003` | → `S-BRAINSTORM`，`[写]` `run(brainstorm, 1)` |
| 8 | Brainstorm 提出 A/B/C 三方案，请求架构评审 | — | `[写]` `A-State@2`（candidate_options）、`A-CapabilityRequest(critic_review, blocking)` |
| 9 | Policy 裁决是否受理该能力请求 | `[P]` `capability_request` → allow | `[写]` `A-PolicyDecision`；Event `CapabilityGranted` |
| 10 | 派发 Critic（自环，Task 状态不变） | `T-009` | `[写]` `run(critic, 1)` |
| 11 | Critic 输出评分 | — | `[写]` `A-CriticReview`（A 8.2 / B 7.4 / C 5.1，推荐 A，confidence 0.75） |
| 12 | 评审结果经 Context 回灌 Brainstorm 会话 | — | `[读]` `A-CriticReview`；L2 走 `session_ref` 恢复，L0 走 `rematerialize` |
| 13 | Brainstorm 收敛到方案 A | — | `[写]` `A-State@3`（decision D1）、`A-StageOutcome(brainstorm, converged)` |
| 14 | 起草 RFC | `T-010` | `[写]` `run(rfc_draft, 1)` → `S-RFC_DRAFT` |
| 15 | RFC 定稿，含 `policy_facts` | — | `[写]` `A-RFC@1`：`risk=low, complexity=low, files=4, security=false` |
| 16 | RFC **冻结** | `T-011` | → `S-RFC_READY`（不变量 `I7`） |
| 17 | Policy 求值 | `[P]` `rfc_ready` | 命中 P4（`complexity==low && risk==low`）→ `auto_develop`；`default_applied=false` |
| 18 | 建工作分支（幂等）+ 派发开发 | `T-012` | `[写]` `run(develop, 1)` → `S-DEVELOPING`；分支 `ai/task-<id>` |
| 19 | Developer 实现 | — | `[读]` `A-RFC@1`（**冻结版，经 `getAsOf`**）、开发规范、git 状态、相关代码 |
| 20 | 收集工作区变更 | — | `WorkspaceDiff`：4 个文件；`[写]` `A-StageOutcome(develop, implemented)` |
| 21 | 漂移检测 | `[P]` `post_develop` | `actual=4` vs `estimated=4`，无漂移 → 继续 |
| 22 | 派发 QA | `T-017` | `[写]` `run(qa, 1)` → `S-QA` |
| 23 | QA 通过 | — | `[写]` `A-StageOutcome(qa, pass)` |
| 24 | 派发评审 | `T-018` | `[写]` `run(review, 1)` → `S-REVIEW` |
| 25 | 评审通过 | — | `[写]` `A-StageOutcome(review, pass)` |
| 26 | **创建 PR（幂等：先按 head 分支查已有 PR）** | `T-021` | → `S-PR_OPEN` |
| 27 | CI 通过 | `T-024` | → `S-DONE` ★ |

**桥接检查**：第 4、12、19 步的所有读取均经 Context；
第 6、8、13、15、20、23、25 步的所有写入均经 Proposal。**无旁路。** ✅

### 流程一的实现注记（2026-08-24，issue #21）

上表是理想态。v0.1 实现的 critic 路径有三处与理想态的**载体差异**（语义等价，非缺口）：

- **步骤 8（请求评审）**：单产物执行模型下，Brainstorm 不直接产出
  `A-CapabilityRequest`。它在收敛产物里置 `details.needs_critic=true`，
  Control Plane 读取后**合成** `A-CapabilityRequest` 落库（`loop.ts`
  `synthesizeCapabilityRequest`，幂等：同 `produced_by_run` 只写一次），
  再触发 `CapabilityRequested` 事件。
- **步骤 12（评审回灌）**：不实现 `SessionManager.resume`（契约标 `[可延后]`）。
  回流 = critic 完成（`T-009b`）→ 重新派发 `run(brainstorm, n+1)`，
  新 run 的 Context 经 recipe 的 `critic` section 自动带上最新
  `A-CriticReview`（等价于 L0 的 `rematerialize` 路径）。
- **步骤 21（漂移检测）**：`post_develop` 判定点**未接线**
  （`EvaluatePolicy` 副作用只挂 `rfc_ready` / `capability_request`）。
  P-DRIFT 规则已从 `DEFAULT_RULES` 删除（见 `policy-engine.md` §2.2），
  本步是设计意图，接入对应转移时恢复。

---

## 2. 流程二 · 复杂需求 → 人工接管 → 交还 AI

**输入**（初稿 §14 原案例）：

> "整个权限系统重新设计一下。"

| # | 动作 | 转移 | 产物 |
|---|---|---|---|
| 1–3 | 同流程一，进入 `S-BRAINSTORM` | `T-001` `T-002` `T-003` | — |
| 4 | Critic 架构评审，**置信度低** | `T-009` | `[写]` `A-CriticReview`：`confidence = 0.4` |
| 5 | RFC 定稿 | `T-010` `T-011` | `[写]` `A-RFC@1`：`risk=high, complexity=high, files=60, security=true` → `S-RFC_READY` |
| 6 | **Policy 求值：三条规则同时命中** | `[P]` `rfc_ready` | P1 `risk==high` → `human_review`<br>P2 `files>30` → `architecture_review`<br>P3 `security==true` → `security_review` |
| 7 | 按严格性偏序取最严 | — | `human_review ≻ security_review ≻ architecture_review` → 裁决 `human_review` |
| 8 | 转人工 | `T-013` | → `S-HUMAN_REVIEW`；`[写]` `A-PolicyDecision`（`matched_rules` 三条全记） |
| 9 | 人工审阅 RFC 后批准 | `T-014` | → `S-DEVELOPING`；建分支；`[写]` `run(develop, 1)` |
| 10 | **人工决定自己实现** | `C-003` | `control_mode: auto → human`；取消 AI 的 `run(develop,1)`（`R-010`）<br>`[写]` `run(develop, 2)`，**`harness_id = "human"`** |
| 11 | 人工在**同一分支、同一 RFC** 上开发 | — | 与 AI 完全相同的工作区与交接物 |
| 12 | 人工交还前提交事实（`C-006` 前置条件） | — | `[写]` `A-State@n`（`decided_by = "human:jionpz"`）、`A-StageOutcome(develop, implemented)` |
| 13 | 交还 | `C-006` | `control_mode: human → auto`；`run(develop,2)` → `SUCCEEDED` |
| 14 | AI 接手做 QA | `T-017` | `[写]` `run(qa, 1)` → `S-QA` |
| 15–17 | QA → 评审 → PR → CI | `T-018` `T-021` `T-024` | → `S-DONE` ★ |

### 2.1 这条流程验证了什么

初稿原则七说"人工与 AI 使用同一套工程规范"。第 10–13 步是它**唯一可强制的形式**：

| 人工必须做的 | 与 AI 的对应 |
|---|---|
| 在 `ai/task-<id>` 分支上工作 | 同一分支 |
| 依据冻结的 `A-RFC@1` | 同一交接物 |
| 交还前提交 `A-State` + `A-StageOutcome` | **同一 Proposal 通道** |
| 结果被记为一个 `run`（`harness_id="human"`） | 同一记账单位 |

约束对人和 AI 是同一条：

> **你的工作成果必须落成 Artifact，否则系统当它没发生过。**

---

## 3. 流程三 · 失败重试与回滚

| # | 动作 | 转移 | 说明 |
|---|---|---|---|
| 1 | `S-QA` 中 QA 判定失败 | — | `[写]` `A-StageOutcome(qa, fail, failed_criteria=[AC2])` |
| 2 | `dev_attempts=1 < max=3` → 返工 | `T-019` | → `S-DEVELOPING`，`[写]` `run(develop, 2)`；QA 报告进 Context（返工时为 `required`） |
| 3 | `run(develop,2)` Harness 报协议错误 | `R-008` | Run → `FAILED`，`error_kind=PROTOCOL_ERROR`，`retryable=true` |
| 4 | 通用重试规则 | `T-030` | `attempt=2 < max` → 自环，`[写]` `run(develop, 3)` |
| 5 | `run(develop,3)` 超过 wall-clock | `R-009` | Run → `TIMEOUT`；强制销毁 Session，结算成本 |
| 6 | 重试耗尽 → 升人工 | `T-031` | `attempt=3 ≥ max` → `S-HUMAN_REVIEW`，附全部失败记录 |
| 7 | 人工判断是 RFC 方案有问题 | `T-016` | → `S-BRAINSTORM`，`[写]` `run(brainstorm, 2)` |
| 8 | 产出新方案 | — | `[写]` `A-RFC@2`，`supersedes = A-RFC@1`（**v1 不被改写，仍可查**） |
| 9 | 重新冻结并重新求值 Policy | `T-011` `[P]` `rfc_ready` | facts 已变 → 新的 `A-PolicyDecision` |
| 10 | 代码回滚 | — | **不是状态机的事**：在 `run(develop, 4)` 内用 `git revert` 处理 |

### 3.1 幂等演示

假设第 6 步后控制平面崩溃并重放事件流：

| 副作用 | 重放时的行为 |
|---|---|
| 建分支 | 分支名由 `task_id` 决定 → 已存在 → 复用，记 `SideEffectSkipped` |
| 创建 PR | 按 head 分支查到已有 PR → 复用编号，记 `SideEffectSkipped` |
| 创建 Run | `UNIQUE(idempotency_key)` 命中 → 返回已有 Run，**不启动第二个进程** |
| 提交 Artifact | `UNIQUE(task_id, kind, key, version)` → 天然幂等 |

**没有一个副作用会发生两次。**

### 3.2 预算耗尽（正交路径）

| # | 动作 | 转移 |
|---|---|---|
| 1 | 累计成本超 `task.budget_usd` | `C-002` |
| 2 | `control_mode: auto → paused`，**`status` 不变** | — |
| 3 | 人工提高预算后恢复 | `C-005` → `auto` |
| 4 | 从当前 `status` 原地继续 | — |

status 不变是关键 —— 预算与业务进展无关，改 status 会丢失"当时做到哪了"。

---

## 4. 走查结论

三条流程**均可跨过两座桥，无需给任何一条开后门**。骨架成立。

但走查抓到了**两处上游文档的真实缺口**，均已回改（这正是本章作为证伪测试的价值）：

### 缺口一 · 转移守卫没有数据来源

**发现**：`04-state-machine.md` 的守卫引用了 `verdict=actionable`、`qa_verdict=pass`、
`review_verdict=fail`，但 Stage 4 定义的六类产物中**没有一个存放这些值**。
守卫读的是空气。

**修正**：新增产物 `A-StageOutcome`（[`06-artifacts.md`](./06-artifacts.md) §8）
+ `schemas/stage-outcome.schema.json`。

**为什么它必须独立于 `A-State`**：守卫必须读结构化枚举。
若把 "PM 认为这条反馈可做" 写进 `A-State.decisions[].text`，
守卫就要去解析一句中文 —— 等于把状态机的正确性押在字符串匹配上。

### 缺口二 · 人工接管在 Run 模型里无处安放

**发现**：流程二第 10 步，人工接管并完成开发后交还，
控制平面看到 `S-DEVELOPING` 会**再派发一次 AI 开发** —— 因为它不知道这个阶段已经做完了。

**修正**：**把人工建模成一种 Harness**（`harness_id = "human"`）。
控制平面为人工接管创建一个正常的 `run`，人工交还时提交 `A-StageOutcome` 关闭它。

**为什么这个修正是好的**：它让"人工与 AI 使用同一套规范"从**口号变成机制** ——
人和 AI 走同一个 Run 记账、同一个 Proposal 通道、同一套 attempt 计数。
不需要为人工新增任何并行路径。

> 这两处都不是笔误，而是**只有走完整条流程才会暴露的结构性缺口**。
> 若跳过本章直接开工，它们会在实现到一半时才被发现。

---

**下一篇**：[`08-cross-cutting.md`](./08-cross-cutting.md) —— 安全 / 可观测 / 成本 / 并发。
