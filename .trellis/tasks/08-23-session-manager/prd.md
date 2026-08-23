# Session Manager 与 Proposal 校验流水线

> 父任务：`08-23-v01-closed-loop`（子任务 5）

## Goal

闭合 v0.1 完成判据的**第三部分：无人干预**。

前四块已经让 Task 能在真实数据库上从 `S-NEW` 走到 `S-DONE`，
但推进所依赖的 `A-StageOutcome` 一直是**测试代码提交的**。
本任务让它由**真实的 OMP session emit** —— 那才叫无人干预。

**里程碑**：真实 OMP session 产出一个提案 → 经五步校验 → 落成 `A-StageOutcome`
→ driver 的守卫读它 → Task 状态推进。全程无人。

---

## Problem

`docs/05-contracts/session-manager.md` 定义了 Proposal 协议，但目前：

| 缺口 | 后果 |
|---|---|
| 校验流水线未实现 | Session 的产出无法落成事实 |
| 平面越界检查未实现 | Session 可以在提案里指挥流程（**中心不变量的漏洞**） |
| `R-007` 回灌未实现 | schema 写错就判整个 Run 失败，比让它改一次贵一个数量级 |
| OMP 无 `CAP-STRUCTURED_OUTPUT` | 必须走 `post_validate`：从自由文本里提取 JSON |

---

## Requirements

### R1 · 五步校验流水线（`docs/05-contracts/session-manager.md` §1.2）

| # | 校验 | 失败 |
|---|---|---|
| 1 | **Schema** —— 按 `kind` 用 ajv 校验 `body` | `SCHEMA_VIOLATION` |
| 2 | **引用完整性** —— `supersedes` 指向当前最新版 | `CONFLICT` |
| 3 | **平面越界** —— `body` 不得含状态机跳转指令 | 拒绝 |
| 4 | **Policy** —— 某些 `kind` 需授权 | `CapabilityDenied` |
| 5 | **提交** —— 落 artifact + 发事件（同事务） | — |

第 3 步是核心：**Session 可以陈述事实，但不能指挥流程。**

### R2 · `post_validate` 提取

OMP 无原生结构化输出。从自由文本中提取 JSON（支持 ```json 围栏与裸 JSON），
提取失败 → `SCHEMA_VIOLATION`，走 `R-007`。

### R3 · `R-007` 回灌

校验失败**不等于** Run 失败：把 `violations` 回灌给 Session 让它改。
只有连续 `max_proposal_retries` 次仍不合格才判 `FAILED`。

### R4 · `SessionManager` 接口

`selectAdapter` / `open` / `advance` / `checkpoint` / `close` 的 `[v0.1 必须]` 实现。
`restore` 的双路径分派实现，但 v0.1 不深测。

---

## Acceptance Criteria

### 基础
- [x] 五步校验实现（第 4 步 Policy 留位置未做空实现假装校验过）
- [x] `post_validate` 能从围栏 / 任意围栏 / 裸 JSON / 嵌套 / 含引号括号的文本中提取
- [x] `R-007` 回灌：第一次不合格 → 回灌具体理由 → 第二次通过；连续失败 → Run FAILED
- [x] `pnpm run check` 为绿（全仓库 131 个测试）

### 核心：平面越界必须被拒
- [x] 提案含 `task_status` / `next_state` / `transition` / `control_mode` → **拒绝**
- [x] 嵌套层级与数组元素里的越权字段同样被抓到
- [x] 拒绝理由说明**为什么**（「Session 可以陈述事实，但不能指挥流程」），不只是「不允许」

### 核心里程碑：无人干预 ✅
- [x] **真实 OMP session 产出 `A-StageOutcome`，提案通过五步校验并落库**
- [x] 产物的 `produced_by_run` 指向那个真实 run，不是测试代码塞的
- [x] driver 读它的 verdict **推进了 Task 状态**（`T-003`/`T-004`）
- [x] 全程无测试代码提交产物

### 反例
- [x] schema 不合格 → 回灌重试；连续失败 → `SCHEMA_VIOLATION` 且**什么都没落库**
- [x] 拒绝被如实记为 `ProposalRejected` 事件

---

## 验收执行记录

**测试**：18 个。全仓库 131 个，`check` exit 0。

### v0.1 判据三部分，现已全部达成

| 部分 | 达成于 |
|---|---|
| 走完 `S-NEW → S-DONE` | Workflow driver 子任务 |
| 事件流能完整重建 | 同上 |
| **无人干预** | **本任务** —— `A-StageOutcome` 由真实 OMP session emit，不再是测试代码提交 |

### 真实调用暴露的一个设计错误

`open()` 里就调了 `adapter.startRun`，而 `advance()` 再调时**被 Run 级幂等键挡住**，
返回的是 `open()` 那次用空 context 起的运行 —— 模型收到的是空提示词。

这暴露了一个语义混淆：**Run 级幂等 ≠ 单次调用的身份**。
R-007 的重试发生在同一个 Run 内，是不同的调用，不该被 Run 级键挡住。

修正：`open()` 只登记不执行；给 Adapter 的键带上轮次（`<key>#turnN`）。

> 这个 bug 单测抓不到 —— 桩 adapter 没有幂等逻辑。**只有真实调用会暴露。**

### 边界规则抓到的放错位置

里程碑测试最初放在 `src/execution/session/`，结果 import `src/fact` 触发
`execution-must-not-write-fact`。规则是对的：该测试**跨三个平面**
（Execution 起会话、Control 校验、Fact 落库），不属于任何单一平面。
移到 `src/e2e/`。

### 实现反过来改了一处契约

`RunResult` 缺 `text` 字段。`post_validate` 模式要从自由文本提取提案，
但 Adapter 没有地方放原始文本 —— 这条降级路径本来是断的。
补 `text: string | null` 并同步文档。**第七处接缝缺口。**

### 两个依赖坑

- `ajv` 默认导出是 draft-07，而我们的 schema 是 draft 2020-12 → 必须用 `Ajv2020`
- `ajv-formats` 是 CJS，在 nodenext ESM 下默认导出被包了两层
