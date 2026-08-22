# ADR-0006 · Session 恢复策略

**Status**: Proposed
**Date**: 2026-08-22

## Context

初稿 §11 主张：

> Checkpoint 不应该保存完整对话作为主要恢复机制。
> 完整对话可以作为 Debug / Audit 数据保存，但不是每次恢复都加载。

这个主张的**代价**初稿没有评估。诚实地说：**摘要恢复一定有信息损失。**

## Options

| 选项 | 恢复质量 | token 成本 |
|---|---|---|
| A. 全量对话恢复 | 最高 | 最高，且随轮次线性增长 |
| B. Checkpoint 摘要恢复 | 有损 | 低且**有界** |
| C. 优先用 Harness 原生 resume，不可用时回退到 B | 视 harness 而定 | 最优 |

## Decision（推荐）

**C**，由 `A-Checkpoint.resume_hint.mode` 分派：

| mode | 条件 | 行为 |
|---|---|---|
| `session_ref` | Adapter 声明 `CAP-RESUME` | 交回 Harness 原生 resume，上下文由其自行保持 |
| `rematerialize` | 无 `CAP-RESUME`，或句柄已失效 | ContextBuilder 从 `A-State` + `working_summary` 重建，开新会话 |

**失效自动回退**：`session_ref` 路径报错时**必须**自动降到 `rematerialize` 并记 Event。

## Consequences

### 诚实的质量损失评估

`rematerialize` 路径确实会损失以下内容，**且这些损失无法通过写更好的摘要完全弥补**：

| 丢失的 | 后果 |
|---|---|
| 中间推理链（"为什么排除了 D 方案"） | Agent 可能**重新提出已被否决的方案** |
| 探索过程中的隐性上下文（读过哪些文件、试过哪些命令） | 可能重复已做过的探索，浪费 token |
| 对话的语气与侧重 | 风格漂移，多轮后可能偏离原定方向 |

**缓解**（不是消除）：

1. `A-State.candidate_options[].status = "rejected"` + `A-CriticReview` 明确记录了**已否决方案及理由** ——
   这直接对冲第一条，也是把它们设计成结构化字段而非散文的原因
2. `A-Checkpoint.working_summary` 要求写明 `next_action` 与 `unresolved_questions`
3. 对 `L0` harness 配置**更大的 `budget_tokens`**（`context-builder.md` §4.4）

### 为什么仍然接受这个损失

因为替代方案更糟：

> 若以全量对话为主要恢复机制，则**会话就成了事实来源** ——
> 那正是本架构从第一条不变量起就在避免的东西。
> 会话一旦是事实来源，崩溃就从"多花点 token"变成"数据丢失"。

**这个损失是"Session inside, State outside"的定价，不是它的缺陷。**

### 其他后果

- 完整对话仍**采集并归档**（走 blob，见 ADR-0004），供事后诊断
- 若实践中发现 `rematerialize` 后质量下降显著，
  应对策是**加强 `working_summary` 的结构化程度**，而不是退回全量对话恢复
