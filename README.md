# Keel — AI Engineering Runtime

> 龙骨：船的主心骨。承载状态 / 工作流 / 会话三层架构的基调。

**一句话**：让 AI、人工、多个 Agent、多个模型、多个 Harness 在同一套软件研发流程中长期协作的运行层。

## 定位

- 不是"又一个 Claude Code"——是编排层之上的 Runtime
- **Session inside, State outside**：Agent 会话是临时计算资源，结构化 State / RFC / Checkpoint 才是事实来源
- 人工与 AI 使用同一套工程规范，可随时 PAUSE → HUMAN_TAKEOVER → RESUME

## 立项文档

- `AI_Engineering_Runtime_Architecture.md` — 完整架构设计（22 章，源文档，2026-08-22 立项归档）

## 核心原则

1. State 是事实（对话不是）
2. Session 是计算资源（可创建/暂停/恢复/销毁）
3. Workflow 决定流程（Agent 不自作主张）
4. Policy 决定权限（自动 vs 人工审核）
5. Context Builder 决定上下文（不每次从零读项目）
6. Harness 是执行层（OMP / TRAE / OpenCode 可替换）
7. 人工与 AI 同一套规范

## 分层架构

```
Workflow → Agent Role → Runtime Adapter → Harness → Model
```

## 规划

- 阶段一：核心闭环 — API/Event → 简单 Workflow 状态机 → Session Manager → PostgreSQL → Harness → GitHub
- 阶段二：Checkpoint / Context Builder / Policy Engine / Critic / QA
- 阶段三：Temporal / 多项目调度 / Agent Pool / Observability / Cost Tracking

## 状态

**立项**（2026-08-22）。下一步：阶段一最小闭环设计。