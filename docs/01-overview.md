# 01 · 总览

> 当前主路径为 jstack managed，定义源与运行职责见 ADR-0011。
> 本文中的旧 PM/RFC 闭环仅解释 `legacy-v01`，不定义 managed 的阶段或完成条件。

---

## 1. Keel 是什么

> 让 AI、人工、多个 Agent、多个模型、多个 Harness
> 在**同一套软件研发流程**中长期协作的运行层。

当前产品由 jstack 定义路线、ticket、provider、工具策略和门禁，由 Keel 持久推进：

```
需求 → route/依赖图 → ticket(execute → verify → review → land) → 受控网关 → archive
```

`branch_ready` 交付本地分支与准确 commit；`pr_ready` 要求受控 push/PR 和准确 head 的
required checks 成功。工作流全部节点 archive 才到 `DONE`，不自动 merge 或部署。
天问先处理持久决策请求，确定性接纳器依据有效证据和委托决定是否继续或升级人工。
详细状态与失败路径见 [managed 状态机](./managed-state-machine.md)。

以下是保留旧任务和审计的 `legacy-v01` 闭环：

```
用户反馈 → PM 判断 → Brainstorm → RFC → 开发 → QA → Review → PR → CI → 完成
```

其中推理阶段由 Harness 会话执行；驾驶权控制与接管交还属于旧 Task 的独立维度。
managed 使用 ticket 控制代次、租约与 DecisionRequest，不复用旧 `control_mode`。

Keel **不是**"又一个 Claude Code" —— 它在编排层之上，把 Claude Code 这类工具当作可替换的执行层。

---

## 2. 中心不变量

整个架构由一条不变量推导而来：

> **事实必须持久化；Session 只是临时计算资源，不是事实来源。**

旧路径的事实存于 task/run/artifact/event；managed 还包括固定包、图、阶段证据、
决策台账、outbox 与 permit 等持久记录。`artifact` 表不是这些记录的统称，
不能因为某条事实不在该表就把它当作 Session 数据。

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
| jstack | 路线、阶段、provider、工具策略与门禁定义 | Keel 消费内容寻址固定包；工程会话也按同一流程工作 |
| Trellis | 历史开发会话流程 | 已退役，见 [ADR-0010](./adr/0010-workflow-jstack.md) |
| CI | 代码验证 | Keel 的外部事实源 |
| git | 版本与隔离 | Keel 的工作区机制 |

---

## 7. 历史 v0.1 完成判据

> **一条真实的用户反馈进入系统后，在无人干预的情况下走完 `S-NEW → S-DONE`，
> 产出一个已合并的 PR；且 `readEvents(task_id, 0)` 能完整重建这个 Task 的全过程。**

当前 legacy 的 `S-DONE` 以真实 PR merge 为准（ADR-0012），CI 通过只在
`S-PR_OPEN` 自环。历史验收发生时的完成条件不替代现行条件。
managed 的 `DONE` 是其固定 completion target 下全部节点归档，不能等同旧 `S-DONE`。

---

## 8. 当前状态

| 项 | 状态 |
|---|---|
| 架构框架文档集 | ✅ 本文档集 |
| 实现语言（ADR-0002） | ✅ **Accepted — TypeScript / Node** |
| Workflow engine（ADR-0003） | ✅ **Accepted**（2026-08-26 查证通过） |
| Harness 接口调研 | ⏳ 完成 Claude Code 与 OMP（见 ADR-0005 修订）；其余属阶段二 |
| 代码 | ✅ v0.1 核心闭环已跑通；✅ 真实 GitHub PR/CI 已接入（`GitHubProvider` + 编排器 `opts.ci`，验收见 `src/acceptance/`） |
| 当前 managed 主路径 | JT-01～JT-06 已实现；JT-07 readiness 已实现，真实持续试运行与生产准入未完成；见 [实施进度](./plans/jstack-tianwen/implementation.md) |

---

**下一篇**：[`02-glossary.md`](./02-glossary.md) —— 先冻结术语，再谈其余。
