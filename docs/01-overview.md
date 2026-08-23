# 01 · 总览

> 满足 PRD `R8`（部分）、`R10`。
> **本文最后成稿** —— 它是对已定稿内容的摘要。先写会变成又一份 vision doc。

---

## 1. Keel 是什么

> 让 AI、人工、多个 Agent、多个模型、多个 Harness
> 在**同一套软件研发流程**中长期协作的运行层。

它驱动这样一个闭环：

```
用户反馈 → PM 判断 → Brainstorm → RFC → 开发 → QA → Review → PR → CI → 完成
```

其中每个阶段由一个 LLM Agent 会话执行，而**任何阶段人都可以接管，然后交还**。

Keel **不是**"又一个 Claude Code" —— 它在编排层之上，把 Claude Code 这类工具当作可替换的执行层。

---

## 2. 中心不变量

整个架构由一条不变量推导而来：

> **能在进程崩溃后存活的，只有 Artifact。其余一切都是 Session。**

这条不变量把初稿的口号 "Session inside, State outside" 变成了可执行的判据：
任何一个字段，问一句"它崩溃后还在吗"，就能确定它归谁管。

---

## 3. 三平面模型

由不变量推出三个职责域，**每个平面的定义性特征是它"不许做什么"**：

```
┌─────────────────────────────────────────────────────────┐
│  Control Plane        Workflow Engine · Policy Engine   │
│  决定下一步做什么        ⛔ 绝不直接调用 LLM               │
│                        ⛔ 必须可确定性重放                 │
└────────────┬────────────────────────────────────────────┘
             │ 写
             ▼
┌─────────────────────────────────────────────────────────┐
│  Fact Plane           Artifact Store（State/RFC/…/Event）│
│  唯一事实来源           ⛔ 只由 Control Plane 写入          │
└────┬───────────────────────────────────────────▲────────┘
     │ Context（读事实 → 造输入）                  │ Proposal（产出 → 校验后落盘）
     ▼                                            │
┌─────────────────────────────────────────────────┴───────┐
│  Execution Plane   Session Manager · Harness Adapter    │
│  干活，产生非确定性     ⛔ 绝不直接写 Fact Plane            │
│                      ⛔ 只能 emit 提案                    │
└─────────────────────────────────────────────────────────┘
```

**Fact Plane 与 Execution Plane 之间只有两条通道，各单向**：
`Context` 下行，`Proposal` 上行。没有第三条路。

这个约束不靠代码自觉，而是靠**数据库授权**强制 ——
`keel_execution` 角色对 `artifact` / `event` / `task` 没有写权限
（见 [`03-domain-model.md`](./03-domain-model.md) §4）。

---

## 4. 七条原则如何被落成机制

初稿给了七条原则。本文档集的工作是把每一条从**主张**变成**机制**：

| 初稿原则 | 落成的机制 | 位置 |
|---|---|---|
| 1 · State 是事实 | Execution Plane 无写权限；产出只能走 Proposal 校验流水线 | `03` §4、`05-contracts/session-manager.md` §1 |
| 2 · Session 是计算资源 | `Run` 与 `Session` 分离；Run 在 Session 销毁后仍存在 | `02` §2、`04` §4 |
| 3 · Workflow 决定流程 | 显式转移表；Proposal 校验第 3 步禁止 Session 指定状态跳转 | `04` §2 |
| 4 · Policy 决定权限 | facts 只来自 Fact Plane；默认 deny；严格性偏序裁决冲突 | `05-contracts/policy-engine.md` |
| 5 · Context Builder 决定上下文 | 固定降级顺序；`dropped` 必填；`ContextBuilt` 事件可复现 | `05-contracts/context-builder.md` §4–5 |
| 6 · Harness 是执行层 | capability 分级 + 降级矩阵；L0 也能跑通闭环 | `05-contracts/harness-adapter.md` §2 |
| 7 · 人工与 AI 同一套规范 | **人工被建模为一种 Harness**（`harness_id="human"`），走同一 Run 记账与 Proposal 通道 | `04` §3.2.1、`05-contracts/harness-adapter.md` §5 |

> 第 7 条是本文档集在流程走查中才想清楚的（见 [`07-flows.md`](./07-flows.md) §4）。
> 它也是最容易停留在口号层面的一条 —— 而"人工也是一种 Harness"让它变成了类型系统层面的事实。

---

## 5. 分层

初稿 §19 的分层：

```
Workflow → Agent Role → Runtime Adapter → Harness → Model
```

本文档集的修正（关闭 `G10`）：

```
Workflow → Agent Role → HarnessAdapter → Harness ─┬─▶ Model（Harness 自己管）
                                                   │
                        ModelProvider ─────────────┴─▶ Model（仅 Runtime 自用）
```

**关键差异**：Model **不是** Keel 管理的一层。
多数 Harness 自带模型配置；Keel 的 `ModelProvider` 只服务于运行时自身的小型 LLM 调用
（Context 摘要、事实抽取），与 Agent 干活**不重叠**。

---

## 6. Non-Goals 与工具边界

摘要如下，完整版见 [`09-roadmap.md`](./09-roadmap.md) §2–3。

**Keel 长期不做**：自己实现 coding agent、自己实现模型推理、替代 CI、做通用工作流引擎。

**与周边工具**：

| | 负责 | 与 Keel |
|---|---|---|
| Claude Code / 各 Harness | 单次会话内的推理与代码修改 | Keel 的执行层 |
| Trellis | 单人单仓库的开发会话流程 | 作用域不同，v0.1 并存不整合 |
| CI | 代码验证 | Keel 的外部事实源 |
| git | 版本与隔离 | Keel 的工作区机制 |

---

## 7. v0.1 完成判据

> **一条真实的用户反馈进入系统后，在无人干预的情况下走完 `S-NEW → S-DONE`，
> 产出一个通过 CI 的 PR；且 `readEvents(task_id, 0)` 能完整重建这个 Task 的全过程。**

详见 [`09-roadmap.md`](./09-roadmap.md) §1。

---

## 8. 当前状态

| 项 | 状态 |
|---|---|
| 架构框架文档集 | ✅ 本文档集 |
| 实现语言（ADR-0002） | ✅ **Accepted — TypeScript / Node** |
| Workflow engine（ADR-0003） | ⚠️ Proposed，待查证 |
| Harness 接口调研 | ⏳ 仅完成 Claude Code；其余被网关阻塞 |
| 代码 | ✅ v0.1 核心闭环已跑通；⚠️ 真实 GitHub PR/CI 集成待接入 |

---

**下一篇**：[`02-glossary.md`](./02-glossary.md) —— 先冻结术语，再谈其余。
