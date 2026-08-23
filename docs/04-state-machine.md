# 04 · 状态机（State Machine）

> 满足 PRD `R3`；关闭缺口 `G8`（无形式化转移表、无失败/超时/取消/回滚路径、无幂等语义）。

---

## 0. 初稿为什么画不出失败路径

初稿 §15 的状态图里，`QA` 失败会走到 `REWORK`。但 `REWORK` 之后呢？回到 `DEVELOPING`。
那这次失败的记录去哪了？第二次 QA 又失败呢？第三次呢？

问题的根源是：**初稿只有一层状态机**，它同时试图表达两件事 ——

- 业务进展到哪了（长生命周期）
- 这次执行成功了吗（短生命周期，可重复）

一层装不下两件事，于是"失败"没有位置放，只能新造一个 `REWORK` 状态搪塞过去。

本章拆成两级：

| 级别 | 宿主 | 回答 | 生命周期 |
|---|---|---|---|
| **Task 级** `S-*` | `task.status` | 业务走到哪个阶段/关口 | 长 |
| **Run 级** | `run.status` | 这一次尝试的结果 | 短，可多次 |

拆开之后，重试是免费的：Task 停在 `S-DEVELOPING` 不动，
底下 Run #1 `FAILED`、Run #2 `RUNNING`。
`REWORK` 状态因此**不再需要** —— 返工就是同一阶段的下一次 Run。

再把"人工接管"提出来做**正交维度**（§3），状态数就不会爆炸。

---

## 1. Task 级状态

### 1.1 状态清单

**阶段态**（有 Run 在跑）：

| ID | 含义 |
|---|---|
| `S-PM_ANALYZING` | PM 正在判断这条反馈要不要做、怎么做 |
| `S-BRAINSTORM` | PM 与 Critic 循环推敲方案 |
| `S-RFC_DRAFT` | 起草 RFC |
| `S-DEVELOPING` | 开发 |
| `S-QA` | 测试 |
| `S-REVIEW` | 代码评审 |

**关口态**（无 Run，等条件或等人）：

| ID | 含义 |
|---|---|
| `S-NEW` | 初态。Task 已创建，尚未派发 |
| `S-NEED_CLARIFICATION` | 等用户澄清 |
| `S-RFC_READY` | RFC 已冻结，等 Policy 裁决 |
| `S-HUMAN_REVIEW` | 等人工裁决 |
| `S-PR_OPEN` | PR 已开，等 CI / 等合并 |

**终态**：

| ID | 含义 |
|---|---|
| `S-DONE` | 完成 |
| `S-REJECTED` | 判定不做（PM 判定或人工否决） |
| `S-ABANDONED` | 放弃（超时未澄清 / 人工取消 / PR 被关） |
| `S-FAILED` | 不可恢复失败 |

### 1.2 初稿中被移除的两个"状态"

| 初稿的写法 | 本章的处理 | 原因 |
|---|---|---|
| `AUTO_DEVELOP` | **不是状态，是 guard** | 它是 Policy 裁决的结果，用来决定 `S-RFC_READY` 往哪走，本身不是任务所处的位置 |
| `REWORK` | **不是状态，是下一次 Run** | 两级拆分后返工天然由 `attempt + 1` 表达 |

---

## 2. Task 级转移表

记法：`guard` 为真才可转移；`side-effect` 与状态变更**在同一事务内**完成（不变量 `I4`）。
所有转移隐含前置条件 **`control_mode = 'auto'`**（见 §3），
**`T-040`（取消）与 `T-041`（不可恢复错误）除外** —— 这两条无论谁在驾驶都必须生效。

| ID | from | event | guard | to | side-effect |
|---|---|---|---|---|---|
| `T-001` | ∅ | `FeedbackTriaged` | — | `S-NEW` | 创建 task；关联 feedback |
| `T-002` | `S-NEW` | `Dispatch` | — | `S-PM_ANALYZING` | 创建 `run(pm, 1)` |
| `T-003` | `S-PM_ANALYZING` | `RunSucceeded` | `verdict=actionable ∧ needs_design` | `S-BRAINSTORM` | 创建 `run(brainstorm, 1)` |
| `T-004` | `S-PM_ANALYZING` | `RunSucceeded` | `verdict=actionable ∧ ¬needs_design` | `S-RFC_DRAFT` | 创建 `run(rfc_draft, 1)` |
| `T-005` | `S-PM_ANALYZING` | `RunSucceeded` | `verdict=unclear` | `S-NEED_CLARIFICATION` | 向用户发问；启动 `clarification_ttl` 定时器 |
| `T-006` | `S-PM_ANALYZING` | `RunSucceeded` | `verdict=reject` | `S-REJECTED` ★ | 记录理由 |
| `T-007` | `S-NEED_CLARIFICATION` | `ClarificationReceived` | — | `S-PM_ANALYZING` | 关联新 feedback；创建 `run(pm, n+1)` |
| `T-008` | `S-NEED_CLARIFICATION` | `TimerFired(clarification_ttl)` | — | `S-ABANDONED` ★ | — |
| `T-009` | `S-BRAINSTORM` | `CapabilityRequested(critic)` | `policy=allow` | `S-BRAINSTORM` ⟲ | 创建 `run(critic, n)`；结果写回 `A-CriticReview` |
| `T-010` | `S-BRAINSTORM` | `RunSucceeded` | — | `S-RFC_DRAFT` | 创建 `run(rfc_draft, 1)` |
| `T-011` | `S-RFC_DRAFT` | `ArtifactCommitted(rfc)` | — | `S-RFC_READY` | **冻结 RFC**（不变量 `I7`）；触发 Policy 求值 |
| `T-012` | `S-RFC_READY` | `PolicyEvaluated` | `decision=auto_develop` | `S-DEVELOPING` | 建工作分支（幂等）；创建 `run(develop, 1)` |
| `T-013` | `S-RFC_READY` | `PolicyEvaluated` | `decision=human_review` | `S-HUMAN_REVIEW` | 通知人工 |
| `T-014` | `S-HUMAN_REVIEW` | `HumanApproved` | — | `S-DEVELOPING` | 建工作分支（幂等）；创建 `run(develop, n+1)` |
| `T-015` | `S-HUMAN_REVIEW` | `HumanRejected` | — | `S-REJECTED` ★ | — |
| `T-016` | `S-HUMAN_REVIEW` | `HumanRequestedRework` | — | `S-BRAINSTORM` | 创建 `run(brainstorm, n+1)` |
| `T-017` | `S-DEVELOPING` | `RunSucceeded` | — | `S-QA` | 创建 `run(qa, 1)` |
| `T-018` | `S-QA` | `RunSucceeded` | `qa_verdict=pass` | `S-REVIEW` | 创建 `run(review, 1)` |
| `T-019` | `S-QA` | `RunSucceeded` | `qa_verdict=fail ∧ dev_attempts < max` | `S-DEVELOPING` | 创建 `run(develop, n+1)`，附 QA 报告 |
| `T-020` | `S-QA` | `RunSucceeded` | `qa_verdict=fail ∧ dev_attempts ≥ max` | `S-HUMAN_REVIEW` | 通知人工 |
| `T-021` | `S-REVIEW` | `RunSucceeded` | `review_verdict=pass` | `S-PR_OPEN` | **创建 PR（幂等）** |
| `T-022` | `S-REVIEW` | `RunSucceeded` | `review_verdict=fail ∧ dev_attempts < max` | `S-DEVELOPING` | 创建 `run(develop, n+1)`，附评审意见 |
| `T-023` | `S-REVIEW` | `RunSucceeded` | `review_verdict=fail ∧ dev_attempts ≥ max` | `S-HUMAN_REVIEW` | 通知人工 |
| `T-024` | `S-PR_OPEN` | `CIPassed` | — | `S-DONE` ★ | 按配置可自动 merge |
| `T-025` | `S-PR_OPEN` | `CIFailed` | `dev_attempts < max` | `S-DEVELOPING` | 创建 `run(develop, n+1)`，附 CI 日志 |
| `T-026` | `S-PR_OPEN` | `CIFailed` | `dev_attempts ≥ max` | `S-HUMAN_REVIEW` | 通知人工 |
| `T-027` | `S-PR_OPEN` | `PRClosed` | — | `S-ABANDONED` ★ | 清理工作区 |

### 2.1 通用规则（适用于全部**阶段态**）

阶段态 = `{S-PM_ANALYZING, S-BRAINSTORM, S-RFC_DRAFT, S-DEVELOPING, S-QA, S-REVIEW}`。
这两条避免为每个阶段重复写六遍失败分支：

| ID | from | event | guard | to | side-effect |
|---|---|---|---|---|---|
| `T-030` | 任一阶段态 | `RunFailed` \| `RunTimeout` | `attempt < max_attempts(stage)` | 同状态 ⟲ | 创建 `run(stage, n+1)`，附失败原因 |
| `T-031` | 任一阶段态 | `RunFailed` \| `RunTimeout` | `attempt ≥ max_attempts(stage)` | `S-HUMAN_REVIEW` | 通知人工，附全部失败记录 |

> `RunTimeout` 与 `RunCancelled` 是 **Run 级**的区分。在 Task 级，
> 超时与失败走同一条路 —— Task 只关心"这次没成"，原因留在 `run.error_kind`。

### 2.2 通用规则（适用于全部**非终态**）

| ID | from | event | guard | to | side-effect |
|---|---|---|---|---|---|
| `T-040` | 任一非终态 | `Cancelled` | — | `S-ABANDONED` ★ | 取消在跑的 Run；销毁 Session；清理工作区 |
| `T-041` | 任一非终态 | `UnrecoverableError` | — | `S-FAILED` ★ | 保留现场供诊断；**不清理工作区** |

`UnrecoverableError` 的判定标准是**窄**的，仅限：schema 迁移不兼容、
凭据永久失效、目标仓库不存在。**其余一切都应走重试或人工**，
否则系统会用 `S-FAILED` 掩盖本可恢复的问题。

### 2.3 回滚

本状态机**没有"回滚"状态** —— 回滚是 side-effect，不是位置。

| 场景 | 处理 |
|---|---|
| 代码要回滚 | 工作分支上 `git revert`，作为下一次 `run(develop, n+1)` 的一部分 |
| RFC 要推翻 | `T-016` 回到 `S-BRAINSTORM`，产出新 version 的 RFC（旧版经 `superseded_by` 保留） |
| 已合并的 PR 要回滚 | **超出 Task 生命周期** —— 开一个新 Task，其 feedback 为"回滚 X" |

最后一条是刻意的：已完成的 Task 是终态，不复活。
让终态可复活会让"这个 Task 到底做了什么"永远没有确定答案。

### 2.4 完备性自检

**可达性** —— 每个状态至少有一条入边：

| 状态 | 入边 |
|---|---|
| `S-NEW` | `T-001`（初态） |
| `S-PM_ANALYZING` | `T-002` `T-007` `T-030` |
| `S-NEED_CLARIFICATION` | `T-005` |
| `S-BRAINSTORM` | `T-003` `T-016` `T-030` |
| `S-RFC_DRAFT` | `T-004` `T-010` `T-030` |
| `S-RFC_READY` | `T-011` |
| `S-HUMAN_REVIEW` | `T-013` `T-020` `T-023` `T-026` `T-031` |
| `S-DEVELOPING` | `T-012` `T-014` `T-019` `T-022` `T-025` `T-030` |
| `S-QA` | `T-017` `T-030` |
| `S-REVIEW` | `T-018` `T-030` |
| `S-PR_OPEN` | `T-021` |
| `S-DONE` | `T-024` |
| `S-REJECTED` | `T-006` `T-015` |
| `S-ABANDONED` | `T-008` `T-027` `T-040` |
| `S-FAILED` | `T-041` |

✅ 无不可达状态。

**出边** —— 每个非终态至少有一条出边：

| 状态 | 出边 |
|---|---|
| `S-NEW` | `T-002` `T-040` `T-041` |
| `S-PM_ANALYZING` | `T-003`–`T-006` `T-030` `T-031` `T-040` `T-041` |
| `S-NEED_CLARIFICATION` | `T-007` `T-008` `T-040` `T-041` |
| `S-BRAINSTORM` | `T-009` `T-010` `T-030` `T-031` `T-040` `T-041` |
| `S-RFC_DRAFT` | `T-011` `T-030` `T-031` `T-040` `T-041` |
| `S-RFC_READY` | `T-012` `T-013` `T-040` `T-041` |
| `S-HUMAN_REVIEW` | `T-014` `T-015` `T-016` `T-040` `T-041` |
| `S-DEVELOPING` | `T-017` `T-030` `T-031` `T-040` `T-041` |
| `S-QA` | `T-018`–`T-020` `T-030` `T-031` `T-040` `T-041` |
| `S-REVIEW` | `T-021`–`T-023` `T-030` `T-031` `T-040` `T-041` |
| `S-PR_OPEN` | `T-024`–`T-027` `T-040` `T-041` |

✅ 无非终态死端。四个终态 `S-DONE` / `S-REJECTED` / `S-ABANDONED` / `S-FAILED` 无出边（符合定义）。

---

## 3. `control_mode` —— 与状态正交的驾驶权维度

初稿 §18 说"任何阶段都可以 PAUSE → HUMAN_TAKEOVER → RESUME"。
如果把它做成状态链里的状态，**每个状态都要配一个暂停孪生态**，状态数直接翻倍。

它其实是一个**正交维度**：

```
task.status        业务走到哪    ──┐
                                   ├──▶  两者独立演进
task.control_mode  谁在驾驶     ──┘
```

| 值 | 含义 | Control Plane 的行为 |
|---|---|---|
| `auto` | AI 自动推进 | 正常派发 Run |
| `paused` | 暂停 | **不派发新 Run**；已在跑的 Run 继续到自然结束 |
| `human` | 人工接管中 | 不派发；人在同一分支、同一 RFC 上工作 |

### 3.1 `control_mode` 转移表

| ID | from | event | to | side-effect |
|---|---|---|---|---|
| `C-001` | `auto` | `HumanPause` | `paused` | — |
| `C-002` | `auto` | `BudgetExceeded` | `paused` | 通知；**status 不变** |
| `C-003` | `auto` | `HumanTakeover` | `human` | 取消在跑 Run（`R-008`） |
| `C-004` | `paused` | `HumanTakeover` | `human` | — |
| `C-005` | `paused` | `HumanResume` | `auto` | 从当前 `status` 继续派发 |
| `C-006` | `human` | `HumanHandback` | `auto` | **前置条件见 §3.2** |

> `BudgetExceeded` 走 `control_mode` 而**不改 status**，是刻意的：
> 预算耗尽与业务进展无关。改 status 会丢失"当时做到哪了"这个事实。

### 3.2 人工交还的前置条件

`C-006`（human → auto）**必须**满足：

> 人工在交还前，已提交一条 `A-State` 更新（说明这段时间做了什么、改了什么决策、留下什么未决问题），
> 以及**若人工完成了某个阶段**，一条对应的 `A-StageOutcome`。

否则会出两种问题：

1. 不提交 `A-State` → AI 接手时看到的事实还停留在接管前，会基于过时事实继续干活
2. 不提交 `A-StageOutcome` → 控制平面不知道该阶段已完成，会**再派发一次 AI 执行**

### 3.2.1 人工被建模为一种 Harness

为了让第 2 点自然成立，人工接管时控制平面**创建一个正常的 `run`**，
其 `harness_id = "human"`：

| | AI 执行 | 人工执行 |
|---|---|---|
| 记账单位 | `run(stage, n)` | `run(stage, n)`，`harness_id="human"` |
| 产出通道 | Proposal | **同一个** Proposal |
| 阶段结论 | `A-StageOutcome` | **同一个** `A-StageOutcome` |
| attempt 计数 | 计入 | **同样计入** |

于是不需要为人工新增任何并行路径 —— `T-017`（develop 成功 → QA）
对人做完的开发和 AI 做完的开发**是同一条转移**。

> 这一设计是 [`07-flows.md`](./07-flows.md) §4 的流程走查逼出来的，
> 也是"人工与 AI 使用同一套工程规范"（初稿原则七）**唯一可强制的形式**：
> 人和 AI 受同一条约束 —— **你的工作成果必须落成 Artifact，否则系统当它没发生过**。

---

## 4. Run 级状态机

### 4.1 状态

| 状态 | 终态 | 含义 |
|---|---|---|
| `PENDING` | | 已创建，尚未启动 Session |
| `RUNNING` | | Session 已启动 |
| `SUCCEEDED` | ★ | Proposal 通过校验并提交 |
| `FAILED` | ★ | Harness 报错，或 Proposal 反复校验失败 |
| `TIMEOUT` | ★ | 超过该 stage 的 wall-clock 上限 |
| `CANCELLED` | ★ | 被人工接管、Task 取消或预算耗尽中止 |

### 4.2 转移表

| ID | from | event | guard | to | side-effect |
|---|---|---|---|---|---|
| `R-001` | ∅ | `RunCreated` | — | `PENDING` | 分配 `idempotency_key` |
| `R-002` | `PENDING` | `SessionStarted` | — | `RUNNING` | 记录 `session_ref`、`harness_tier` |
| `R-003` | `PENDING` | `SessionStartFailed` | — | `FAILED` ★ | 记 `error_kind` |
| `R-004` | `PENDING` | `Cancelled` | — | `CANCELLED` ★ | — |
| `R-005` | `RUNNING` | `ProposalAccepted` | — | `SUCCEEDED` ★ | 提交 Artifact；销毁 Session；结算成本 |
| `R-006` | `RUNNING` | `ProposalRejected` | `retries ≥ max` | `FAILED` ★ | 记录全部拒绝理由 |
| `R-007` | `RUNNING` | `ProposalRejected` | `retries < max` | `RUNNING` ⟲ | 把拒绝理由回灌给 Session |
| `R-008` | `RUNNING` | `HarnessError` | — | `FAILED` ★ | 销毁 Session；结算成本 |
| `R-009` | `RUNNING` | `TimerFired(wall_clock)` | — | `TIMEOUT` ★ | 强制销毁 Session；结算成本 |
| `R-010` | `RUNNING` | `Cancelled` | — | `CANCELLED` ★ | 强制销毁 Session；结算成本 |

**所有终态的共同 side-effect**：
销毁 Session → 若 Adapter 声明 `CAP-RESUME` 则落 `A-Checkpoint` → 结算 `cost_usd` / `tokens_*` → 发 Event。

> `R-007` 是 Proposal 机制的关键一环：校验失败**不等于** Run 失败。
> 结构化产物写错了，先把错误告诉 Session 让它改 —— 这比直接判死重跑整个阶段便宜得多。

---

## 5. 幂等与重放语义

事件投递是 **at-least-once**，控制平面可能重放事件流。
因此：**每个副作用都必须幂等，否则一次重放就会重复开 PR。**

### 5.1 幂等键

```
idempotency_key = hash(task_id, stage, attempt)
```

由 `run` 表的 `UNIQUE (idempotency_key)` 强制（不变量 `I3`）。

### 5.2 必须幂等的副作用

| 副作用 | 幂等实现方式 |
|---|---|
| 创建工作分支 | 先查分支是否存在；存在即复用（分支名由 `task_id` 决定，非随机） |
| push 提交 | 以 commit SHA 判重；相同内容不重复 push |
| **创建 PR** | 先按 `head` 分支查已有 PR；存在即复用其编号 |
| 创建 Session | 以 `idempotency_key` 查 `run`；已有 `session_ref` 即复用（需 `CAP-RESUME`） |
| 发通知 | 以 `(task_id, event_seq)` 去重 |
| 提交 Artifact | `UNIQUE (task_id, kind, key, version)` 天然幂等 |

### 5.3 重放规则

| 规则 | 说明 |
|---|---|
| **重放不得重新执行副作用** | 重放只重建投影（如 `A-State`），不调外部系统 |
| 副作用执行前先查幂等键 | 命中即跳过，并记一条 `SideEffectSkipped` 事件 |
| 控制平面必须确定性 | 不得在转移判定中使用 `now()`、随机数、或直接调 LLM。时间来自 event 的 `occurred_at`（`02-glossary.md`：Control Plane 硬约束） |
| 非确定性只允许在 Run 内 | LLM 调用一律发生在 Execution Plane，其结果经 Proposal 落成 Artifact 后才对控制平面可见 |

> 最后两条是本架构能被任何 durable execution 引擎（Temporal 等）承载的前提。
> 若控制平面里混入了 LLM 调用，重放就会得到不同结果，整个事实平面失去意义。
> 具体引擎选型见 `adr/0003`。

---

## 6. 超时配置

| 计时器 | 作用域 | 到期事件 | 默认值 |
|---|---|---|---|
| `wall_clock(stage)` | Run | `RunTimeout` → `R-009` | 按 stage 配置 |
| `clarification_ttl` | Task | `TimerFired` → `T-008` | 待定，见 `09-roadmap.md` |
| `human_review_ttl` | Task | 仅通知升级，**不自动转移** | 待定 |

> `human_review_ttl` 刻意**不触发状态转移**。等人这件事没有超时兜底 ——
> 自动放弃一个等人审的 Task，比让它一直等着更糟。

---

**下一篇**：[`06-artifacts.md`](./06-artifacts.md) —— 转移表中出现的 `A-*` 产物的具体 schema。
