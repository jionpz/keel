# Workflow driver：转移执行器

> 父任务：`08-23-v01-closed-loop`（子任务 6）

## Goal

把已有的三块接起来，让 Task **真正能在数据库上推进**：

```
事件 → 从 Fact Plane 加载 facts → transition()（纯函数）
     → 幂等施加副作用 → 与事件同事务落盘
```

**里程碑**：一条 Task 在真实 Postgres 上从 `S-NEW` 走到 `S-DONE`，
且 `readEvents(task_id, 0)` 能完整重建全过程。

这是 v0.1 完成判据的**前两个部分**（走完状态机 + 事件流可重建）；
第三部分「无人干预」需要 Harness 接入后才完整。

---

## Background

已完成且可用：

| | |
|---|---|
| `transition()` | 31 条转移，纯函数，返回**副作用描述**而不执行它们 |
| `ArtifactStore` | 7 个方法，写入以 `keel_control` 身份 |
| `PolicyEngine` | 严格性偏序裁决，纯函数 |
| DB | 7 张表 + 授权矩阵 + `I1`–`I8` 强制 |

**缺的正是中间那层**：谁来读事件、谁来喂 facts、谁来把「副作用描述」变成真实副作用。

---

## Problem

`transition()` 刻意只返回 `SideEffect[]` 的**描述**（`ADR-0003` 硬约束）。
这让它可重放，但也意味着**必须有人去执行这些描述** —— 而这个执行必须：

| 要求 | 出处 | 不做会怎样 |
|---|---|---|
| **幂等** | `04-state-machine.md` §5 | 事件 at-least-once，一次重放就重复开 PR |
| 与状态变更**同事务** | 不变量 `I4` | 状态变了但事件没写，事件流不再能重建真相 |
| facts 只来自 **Fact Plane** | `05-contracts/policy-engine.md` §2 | Policy 失去可重放性 |
| 控制平面**不调 LLM**、不读时钟 | 三平面硬约束 | 重放得到不同结果 |

---

## Requirements

### R1 · 事实加载器

从 Fact Plane 组装 `TransitionFacts` 与 `FactSet`：

| 来源 | 提供的 fact |
|---|---|
| `A-StageOutcome`（最新） | `verdict`、`needs_design` |
| `run` 表聚合 | `dev_attempts`、`stage_attempts`、`tests_failed` |
| `A-RFC.policy_facts` | `risk` `complexity` `estimated_files_changed` `security_related` |
| `A-CriticReview` | `critic_confidence` |
| 配置 | `max_dev_attempts`、`max_stage_attempts` |

**只读 Fact Plane，不读别处。**

### R2 · 副作用执行器

把 `SideEffect` 描述变成真实动作，**每个都幂等**：

| SideEffect | 幂等方式 |
|---|---|
| `CreateRun` | `UNIQUE (idempotency_key)`，命中则复用并记 `SideEffectSkipped` |
| `CreateTask` / `LinkFeedback` | 主键 / 联合主键 |
| `CreateBranch` / `CreatePullRequest` | v0.1 **记录意图**，真实 git 操作属子任务 7 |
| `NotifyHuman` / `AskUser` | 以 `(task_id, event_seq)` 去重 |
| `EvaluatePolicy` | 调 `PolicyEngine`，结果落 `A-PolicyDecision` |
| `FreezeRfc` | 幂等：已冻结则跳过 |
| `StartTimer` / `CancelRun` / `CleanWorkspace` / `PreserveWorkspace` / `MaybeAutoMerge` / `RecordReason` | v0.1 记录意图 |

> 未落地的副作用**必须显式记录为意图事件**，不能静默跳过 ——
> 否则事件流会声称「做过了」而实际没有。

### R3 · 驱动器 `advance()`

```
advance(task_id, event) -> Result<AdvanceOutcome>
```

一次事务内完成：读状态 → 加载 facts → `transition()` → 施加副作用 →
更新 `task.status` → 写 `TaskStatusChanged` 事件（含 `transition` ID）。

`transition()` 返回 `matched: false` 时**不是错误**，是"这个事件在当前状态下无事发生"，
如实记录并返回。

### R4 · 时间由外部注入

控制平面不读时钟。`advance()` 接受一个 `now: string` 参数，
传给 `PolicyEngine.evaluate()` 与事件时间戳。

### R5 · 重放安全

同一事件重复投递不得产生第二次副作用。
以 `(task_id, event_seq)` 或 `idempotency_key` 判重。

---

## Constraints

1. 驱动器属 **Control Plane**：不调 LLM、不读时钟、facts 只来自 Fact Plane
2. 所有写入以 `keel_control` 身份
3. `transition()` 保持纯 —— 驱动器不得把 I/O 塞回去
4. 中文注释；标识符英文

---

## Acceptance Criteria

### 基础

- [x] `advance()` 实现，单事务，状态变更与事件同时落盘
- [x] 事实加载器只读 Fact Plane
- [x] 全部 `SideEffect` 类型有处理分支；未落地的记录为 `SideEffectIntent`
- [x] `pnpm run check` 为绿

### 核心里程碑

- [x] **一条 Task 在真实 Postgres 上从 `S-NEW` 走到 `S-DONE`**
- [x] 走过的转移为 `T-002 → T-003 → T-010 → T-011 → T-012 → T-017 → T-018 → T-021 → T-024`，
      与 `docs/04-state-machine.md` 一致
- [x] `readEvents(task_id, 0)` 的 `TaskStatusChanged` 序列**与实际路径逐条相等**
- [x] 每条 `TaskStatusChanged` 的 payload 含 `T-*` ID、`from`、`to`
- [x] 失败路径：QA fail → `T-019` 返工；Run 反复失败 → `T-031` 升人工
- [x] `paused` 不推进且记 `NoTransition`；`Cancelled` 仍走 `T-040`

### 反例验证

- [x] 同一事件投递两次，**run 数量不增**
- [x] 幂等键命中时记 `SideEffectSkipped`
- [x] 终态 Task 再收事件 → 无转移，状态不变
- [x] driver import `src/execution` → `boundaries` 红（已实测 exit 1）

---

## 验收执行记录

**测试**：10 个（里程碑 1 + 失败路径 2 + control_mode 2 + 幂等 3 + 意图 1 + 安全 1）。
全仓库 90 个，`check` exit 0。

### 里程碑达成情况

v0.1 完成判据三部分：

| 部分 | 状态 |
|---|---|
| 走完 `S-NEW → S-DONE` | ✅ 本任务达成 |
| 事件流能完整重建全过程 | ✅ 本任务达成 |
| **无人干预** | ⏳ 需 Harness 接入（子任务 4/5）—— 当前测试中 `A-StageOutcome` 由测试代码提交，真实系统中应由 Session emit |

### 一个顺带验证到的东西

`docs/07-flows.md` 流程一（Excel 日期筛选）的九步转移，
现在**在真实数据库上被逐条走过并断言**。当初写在文档里的那条路径是对的。

同时验证了安全路径：低复杂度的安全修复在 `rfc_ready` 被裁为 `security_review`，
于是走 `T-013` 转人工而不是 `T-012` 自动开发 —— Policy Engine 与状态机接通无误。

### 实现反过来改了一处契约

`Proposal` 缺 `task_id` 字段。我的 `ArtifactStore` 实现只好从 `body.task_id` 偷读，
但产物 schema 是严格的（`additionalProperties: false`），body 里根本塞不进这个字段 ——
写测试时立刻撞上。

改为显式字段并同步 `docs/05-contracts/session-manager.md`：
**归属属于信封，不属于内容**。

> 这是同类缺口的第六处。它们的共同特征仍是：单看任一文档自洽，问题在接缝处。

### 一处诚实的强度说明

`transition` 与 `policy` 的纯度由机械检查保证（`check:purity` + 依赖边界）。
**driver 的「不读时钟」只靠 code review 与测试保证** —— 它必须做 I/O，
无法用同一套扫描覆盖（会误伤合法的时间戳格式化）。
`now` 由参数注入这一点写在契约与实现注释里，但没有机械强制。
若日后发现被违反，再考虑加更精确的检查。

---

## Out of scope

| 项 | 去向 |
|---|---|
| durable timer / work queue | 拆为独立子任务（它们是「何时跑」，不是「跑什么」） |
| 真实 git / GitHub 操作 | 子任务 7 |
| Session 派发与 Harness 调用 | 子任务 4 / 5 —— 本任务的 `CreateRun` 只建记录，不启动会话 |
