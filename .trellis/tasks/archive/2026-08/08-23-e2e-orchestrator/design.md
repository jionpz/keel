# Design — 端到端编排器

## 1. 结构

```
src/control/context/builder.ts    # ContextBuilder（Control Plane，读 Fact）
src/control/orchestrator/loop.ts  # 编排循环
src/control/orchestrator/prompts.ts # 各阶段提示词
```

编排器放 Control Plane：它决定「下一步做什么」，
真正的 LLM 调用在 Adapter 里（与 `proposal/pipeline.ts` 同理）。

## 2. ContextBuilder 的 v0.1 边界

契约要求的降级顺序有六步，其中第 3、5 步是**摘要**。
摘要需要 `ModelProvider`（运行时自己的 LLM 调用），属阶段二。

**v0.1 的做法**：到摘要那一步直接丢弃并记 `dropped`，
**不做空实现假装摘要过了**。`dropped[].reason` 用 `budget`。

> 这与本项目一贯的纪律一致：没做的事要在数据里如实体现，
> 而不是让下游以为做过了。

## 3. 编排循环为什么是同步的

v0.1 不引入 work queue（`ADR-0003` 把 durable timer 与队列列为「引擎唯一能补的两样」，
但那是调度层，属后续子任务）。

本任务的循环是：**给定一个 Task，把它推到终态或推不动为止**。
它证明的是「各块能串起来」，不是「调度器可靠」。这两件事应分开验证。

## 4. develop 阶段必须做真实改动

否则 `collectChanges` 返回空、QA 无从判断，整条链是空转的 ——
那样即使测试绿了也证明不了闭环。

做法：提示词要求它在工作区里**真实地**加一个文件或改一行，
然后才输出 `A-StageOutcome`。测试断言 `git status` 非空。

## 5. 风险

| 风险 | 对策 |
|---|---|
| 六个阶段 × 真实调用 → 慢且贵 | 用 deepseek-flash；提示词尽量短；单个里程碑测试 |
| 某阶段模型产不出合法提案 | R-007 已有重试；仍失败则**如实失败**，不放宽 schema |
| 循环失控 | 硬上限（最大步数） |
