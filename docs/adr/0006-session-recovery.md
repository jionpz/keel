# ADR-0006 · Session 恢复策略

**Status**: Proposed（2026-08-26 复核后**保持** Proposed，理由见下）
**Date**: 2026-08-22

> 2026-08-26 复核：v0.1 交付了本 ADR 的**前置能力**，但没有交付**决策本体**，
> 按「未实现的决策不得标 Accepted」的纪律保持 Proposed：
>
> - 已交付：`session_ref` 的采集与保留（OmpAdapter 的 `dispose` 不销毁会话，
>   `--resume` 实测有效，见下方 2026-08-23 补充）；
> - 未交付：由 `A-Checkpoint.resume_hint.mode` 分派的 restore 双路径，
>   以及 `session_ref` 失效时自动回退 `rematerialize` 并记 Event。
>   `HarnessSessionManager` 尚无 `restore()`（v0.1 每轮都是完整的 Adapter 调用，
>   见 `src/execution/session/manager.ts` 的注释）。
>
> 待恢复路径真实落地并经反例验证（故意作废 session_ref 观察回退）后转 Accepted。

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


## 2026-08-23 补充：原生 resume 的收益已被量化

本机 OMP 实测（`research/omp-interface.md` §3）：

| | `input` tokens |
|---|---|
| 首轮（全量上下文） | 39,651 |
| `--resume` 后同一会话 | **208** |

即**约两个数量级**的差距。

这为选项 C（优先用原生 resume，不可用时回退摘要）提供了实测支撑：
`session_ref` 路径与 `rematerialize` 路径的成本差异不是理论推测，是可测量的。

同时也说明 `docs/05-contracts/harness-adapter.md` §2 那句
「能力缺失只让闭环**更贵**，不让它**失效**」中的「更贵」是认真的 ——
量级足以影响是否值得为某个 harness 实现 resume 支持。

---

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
