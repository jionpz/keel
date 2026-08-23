# 端到端编排器与最小 Context Builder

> 父任务：`08-23-v01-closed-loop`（子任务 3 + 8 合并）

## Goal

把前五块串成一条真正的闭环，达成 **v0.1 完成判据的完整形态**：

> 一条真实的用户反馈进入系统后，在**无人干预**的情况下走完 `S-NEW → S-DONE`，
> 且 `readEvents(task_id, 0)` 能完整重建全过程。

**当前是分段验证的**：driver 那条 `S-NEW → S-DONE` 用的是测试提交的产物；
无人干预那条只走了 PM 一个阶段。本任务把两者合一。

---

## Problem

已有的五块各自成立，但**没有东西把它们连起来**：

| 已有 | 缺的 |
|---|---|
| driver 能按事件推进状态 | 谁在 Run 被创建后去执行它 |
| SessionManager 能跑真实 session | 谁给它造 Context |
| 校验流水线能落库 | 谁在落库后发出 `RunSucceeded` |
| Policy 能裁决 | — |

缺的是**编排循环**与 **Context Builder**。

---

## Requirements

### R1 · 最小 Context Builder

按 `docs/05-contracts/context-builder.md` 实现 `build()`：

- 按 Role 取配方（PM / Developer / Reviewer 三种，其余复用）
- 从 **Fact Plane** 取料：`A-State`、`A-RFC`（冻结版，用 `getAsOf`）、`A-StageOutcome`
- **`dropped` 必填** —— 被砍掉的必须显式记录
- 每次 build 发一条 `ContextBuilt` 事件，记 `source_ref` 与 `dropped`

v0.1 的预算裁剪按固定降级顺序实现，但**不做摘要**（`derived` 需要 ModelProvider，属阶段二）——
到需要摘要那一步直接丢弃并记 `dropped`，不假装摘要过了。

### R2 · 编排循环

```
loop:
  取一个 PENDING 的 run
  → 造 Context
  → 跑 session（真实 harness）
  → 校验 + 落库
  → 标记 run SUCCEEDED
  → driver.advance(RunSucceeded)
  → 若 Task 到终态则停
```

**时间由外部注入**（Control Plane 不读时钟）。
循环有硬上限（最大步数），防止失控。

### R3 · 各阶段提示词

`pm` / `brainstorm` / `rfc_draft` / `develop` / `qa` / `review` 六个阶段各有提示词，
写在**实现里**而不是测试里。

`develop` 阶段做一次**真实的文件改动**（不是假装）——
否则 `collectChanges` 与后续 QA 都是空转。

---

## Acceptance Criteria

### 基础
- [x] `ContextBuilder.build()` 实现，`dropped` 必填且被记录
- [x] 每次 build 发 `ContextBuilt` 事件，含 `source_ref` 与 `dropped`
- [x] 编排循环实现，有最大步数上限
- [x] `pnpm run check` 为绿

### 核心里程碑：完整的 v0.1 判据 ✅
- [x] **一条真实反馈从 `S-NEW` 走到 `S-DONE`，全程无测试代码提交产物**（70 秒）
- [x] 途中每个阶段的产物都由**真实 OMP session** emit（`produced_by_run` 非空）
- [x] `develop` 阶段产生了**真实的文件改动**（`git status --porcelain` 非空）
- [x] `readEvents` 的转移序列与编排器路径**逐条相等**，起于 `T-002` 终于 `T-024`
- [x] 每个 session 都有 `ContextBuilt` 事件，含 `source_ref` 与 `dropped`

### 诚实性检查
- [x] 测试只铺输入（仓库/反馈/Task），之后不写入任何产物
- [x] 未做的摘要式裁剪如实记为 `dropped`，不假装摘要过了

---

## 验收执行记录

**实际走过的路径**（真实 OMP + deepseek-v4-flash，70 秒）：

```
T-002(派发) → T-004(pm) → T-011(rfc_draft) → T-012(Policy 裁决 auto_develop)
→ T-017(develop) → T-018(qa) → T-021(review) → T-024(外部 CI)
```

注意 PM 判为 `needs_design: false`，因此走 `T-004` 直接起草 RFC 而非 `T-003` 进 brainstorm ——
这是模型自己的判断，不是测试预设的。

### 一处必须说清楚的边界

`S-PR_OPEN → S-DONE` 的 `CIPassed` 由测试注入。

这**不是**编排器自己造活：CI 是 Keel 的**外部事实源**
（`docs/09-roadmap.md` §3），系统本身不产生它。
v0.1 尚无真实 git/CI 接入（子任务 7），测试代其发声，
且注入点在代码里被显式标注为模拟。

除这一处外，`S-NEW → S-PR_OPEN` 的每一步都是真实的。

### 环境相关的一个发现

OMP 对无效工具名**直接报错退出**而非静默忽略。
最初给了 `bash` / `edit` / `ls`，本机 OMP 的可用集只有 `read` / `write` 加一批 MCP 工具。
这是好行为 —— 静默忽略会让 develop 阶段悄悄失去写权限而无人察觉。
已在代码注释中记下：工具名不能凭想象写。

### ContextBuilder 的 v0.1 局限（如实记录）

契约的降级顺序有六步，第 3、5 步是**摘要**，需要 ModelProvider（阶段二）。
本实现到摘要那一步**直接丢弃并记 `dropped`**，不做空实现假装摘要过了。
`required` section 放不下时返回 `CONTEXT_BUDGET_EXCEEDED` 而非静默截断 ——
让 Agent 基于残缺信息跑起来，比不跑更糟。

---

## Out of scope

| 项 | 理由 |
|---|---|
| 真实 git 分支 / PR | 子任务 7；当前记 `SideEffectIntent` |
| durable timer / work queue | 编排循环 v0.1 是同步的；调度属后续 |
| 摘要式裁剪 | 需 ModelProvider，属阶段二 |
