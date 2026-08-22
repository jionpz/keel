# 完善 Keel 架构框架

## Goal

把 `AI_Engineering_Runtime_Architecture.md` 初稿（22 章）收敛为**决策完备、可落地**的架构框架文档集。

**完成判据（一句话）**：一个没参与过讨论的开发者（或 `trellis-implement` 子 agent）拿到 `docs/`，
能直接开始写阶段一代码，**不需要再自己发明任何 schema、接口签名或状态转移**。

---

## Background

- 2026-08-22 立项，定名 Keel（龙骨）。仓库当前**零代码**，只有初稿 + README + Trellis 脚手架。
- 初稿表达清楚了**想法**（Session inside, State outside；七大原则；分层 Workflow → Agent Role → Runtime Adapter → Harness → Model）。
- 但它是一份 **vision doc，不是 spec**：术语未定义、接口未定义、schema 只有零散示例、选型全是"推荐 A/B/C"而未决策。

---

## Problem — 初稿缺口清单

这份清单是本任务的**工作面**，每条都必须在验收时被关掉，或被显式转为开放问题。

| # | 对应初稿章节 | 现状 | 缺口 |
|---|---|---|---|
| G1 | 全文 | State / Shared State / Checkpoint / Memory / Context / RFC 混用 | 无术语表，同一个词在不同章节指不同东西 |
| G2 | §4 Workflow Engine | 列了 Temporal / Inngest / 自研 三个候选 | **未决策**；"简单状态机"到底要建什么没说 |
| G3 | §5–6 Session Manager | 只给了生命周期状态名 | 无接口；Session 与 Workflow 的**写权限边界**未定义；resume 如何重建上下文未定义 |
| G4 | §7–9 Brainstorm | 给了 PM + Critic 拓扑 | Critic 调用只有一个 JSON 例子，无 schema；PM 请求能力调用的**通用机制**未定义 |
| G5 | §10 Context Builder | 给了三种 Context 的"配料表" | 无接口；无 token 预算与裁剪策略；配料**从哪来**（检索？固定注入？）未定义 |
| G6 | §11 Checkpoint | 一个 JSON 示例 | 无 schema、无触发时机、无版本迁移；**与 State 的关系**未定义 |
| G7 | §12 Policy Engine | 一段 YAML 规则示例 | 无求值语义；facts 从哪来；规则冲突如何裁决；默认允许还是默认拒绝 |
| G8 | §15 State Machine | ASCII 图 | 无形式化转移表；**无失败 / 超时 / 取消 / 回滚路径**；无幂等与重放语义 |
| G9 | §17 Git 集成 | 分支命名 + 一个 JSON | 无冲突处理；无 worktree / 隔离策略；无凭据模型 |
| G10 | §19 模型层 | 分层图 | `ModelProvider` 接口未定义；**与 Harness 的职责重叠未澄清**（多数 Harness 自带模型配置） |
| G11 | — | 缺失 | 无 **RFC schema** —— 而 RFC 是 PM → Developer 的核心交接物 |
| G12 | — | 缺失 | 无安全模型：Agent 执行任意代码、写 git、持有凭据、消费不可信输入 |
| G13 | — | 缺失 | 无可观测性 / 成本 / 审计模型（§20 只在"阶段三"提了名字） |
| G14 | — | 缺失 | 无并发模型：多任务、多 Agent、同一仓库的竞争 |
| G15 | §20 | 三阶段列表 | 无 MVP 验收定义 —— 什么叫"核心闭环跑起来了" |
| G16 | — | 缺失 | 无 **Non-Goals** —— 不做什么、边界在哪 |
| G17 | — | 缺失 | 与既有工具（Trellis / Claude Code / GitHub Actions）的关系未澄清，有重复造轮子风险 |

---

## Scope

### In scope

框架**文档集**（`docs/`）+ ADR + 初稿归档处理。

### Out of scope（并给出理由）

| 项 | 为什么不在本任务 |
|---|---|
| 代码骨架 / 目录结构 / 依赖初始化 | 依赖 ADR-0002（实现语言）被确认。语言未定就 scaffold 是返工。**确认后立即作为下一个任务。** |
| 任何生产实现代码 | 同上 |
| `.trellis/spec/` 填充 | 依赖技术栈确定；属于 `00-bootstrap-guidelines` 任务的范围 |
| UI / Dashboard 设计 | 阶段三关注点，v0.1 无 UI |

---

## Requirements

### R1 · 统一术语（Glossary）

定义并**冻结**核心名词，每词含：一句定义 + 与易混词的区分 + 生命周期归属（谁创建 / 谁写 / 何时销毁）。

至少覆盖：`Task` `Feedback` `RFC` `State` `Checkpoint` `Session` `Run` `Event` `Policy` `Context` `Artifact` `Harness` `Adapter` `Role`。

### R2 · 领域模型与持久化

实体、字段、关系、主键、不变量；逻辑 schema 到可直接写出 DDL 的程度。**每个实体标注"谁有写权限"** —— 这是"State 是事实"原则能否落地的关键。

### R3 · 形式化状态机

- 状态清单（含终态）
- 转移表：`from → event → guard → to → side-effect`
- **失败 / 超时 / 取消 / 人工介入 / 回滚**路径
- 幂等与重放语义

### R4 · 核心契约

至少 5 个接口的**语言中立**签名 + 输入输出 schema + 错误语义：

| 接口 | 为什么它是关键 |
|---|---|
| `HarnessAdapter` | "Harness 可替换"这一核心主张的唯一落点；**必须含 capability 协商**，因为各 Harness 能力不齐 |
| `SessionManager` | "Session 是计算资源"的落点 |
| `ContextBuilder` | "不每次从零读项目"的落点 |
| `PolicyEngine` | "Policy 决定权限"的落点 |
| `ArtifactStore` | State / RFC / Checkpoint 的读写边界 |

每个接口标注 **v0.1 必须实现** vs **可延后**。

### R5 · 结构化产物 schema

`RFC` `Checkpoint` `State` `Event` `CriticReview` `PolicyDecision` 各一份 JSON Schema，**含 version 字段**，各配至少一个真实示例。

### R6 · 端到端流程

至少 3 条，每步标注**读写了哪些产物**、**经过哪些 Policy 判定**、**对应哪条状态转移**：

1. 自动开发闭环（初稿 §13 的 Excel 日期筛选案例）
2. 复杂需求 → 人工接管 → 交还 AI（初稿 §14 + §18）
3. 失败重试 / 回滚（初稿完全没有，但真实系统必然遇到）

### R7 · 跨切面关注点

安全 / 可观测性 / 成本 / 并发，**每项给出 v0.1 的最低要求**，不允许写"以后再说"。

- 安全：凭据模型、代码执行隔离、git 写权限范围、prompt injection（Agent 消费用户反馈这类不可信输入）
- 可观测：trace / span 模型、结构化日志字段、如何回答"这个 Task 到底发生了什么"
- 成本：token / cost 归属到 Task，超预算行为
- 并发：同仓库多任务、锁与隔离

### R8 · 范围与路线

- **Non-Goals**：明确不做什么
- **v0.1 完成判据**：一句可验证的话
- 阶段二 / 三的**触发条件**（不是时间表）

### R9 · ADR

每个重大选型一份，含 `Context / Options / Decision / Consequences / Status`：

| ADR | 主题 |
|---|---|
| 0001 | 采用 ADR 记录架构决策 |
| 0002 | 实现语言与运行时 |
| 0003 | Workflow engine 选型 |
| 0004 | 持久化与 Artifact 存储 |
| 0005 | Harness 支持优先级与 capability 分级 |
| 0006 | Session 恢复策略（checkpoint vs 全量对话） |

`Status: Proposed` 的必须同时进入"开放问题"。

### R10 · 与既有工具的边界

一张"谁负责什么"的表，覆盖 Keel vs Trellis vs Claude Code / 各 Harness vs GitHub Actions。**目的是主动暴露重复造轮子的风险**，而不是回避它。

### R11 · 文档可导航

`docs/README.md` 提供索引 + 建议阅读顺序；初稿保留为归档并标注 `superseded by`。

---

## Constraints

1. **中文写作**，技术术语 / 接口名 / 字段名保留英文。
2. **不得为了完备而虚构外部系统能力**。任何关于 Harness、Workflow engine、模型能力的断言必须有出处，或显式标注 `未验证`。宁可留白，不可编造 —— 整个架构决策建立在这些事实为真之上。
3. **保留初稿**，不删除、不原地重写；归档 + `superseded` 标注。
4. 文档要能被 AI 子 agent 消费：结构化、可寻址、避免长段落散文。

---

## Acceptance Criteria

- [x] `docs/` 形成完整框架文档集，`docs/README.md` 可导航，阅读顺序明确
- [x] 术语表覆盖 ≥14 个核心名词（实际 17）；**全文无术语冲突**（关闭 G1）— 脚本校验通过
- [x] 领域模型可直接写出 DDL；每个实体标注写权限（关闭 G11，部分关闭 G2）
- [x] 状态机转移表完整：**无不可达状态、无非终态死端**，含失败 / 超时 / 取消 / 人工介入路径（关闭 G8）— 脚本校验 15 状态 / 35 显式转移 + 4 通用规则
- [x] 5 个核心接口有语言中立签名与错误语义；`HarnessAdapter` 含 capability 协商（关闭 G3 / G5 / G7 / G10）
- [x] 6 类产物有带 `version` 的 JSON Schema 与真实示例（关闭 G4 / G6）— **实际 8 类**，均通过 JSON 合法性校验
- [x] ≥3 条端到端流程，每步可映射到具体转移与接口调用
- [x] 跨切面 4 项各有 v0.1 最低要求，无"以后再说"（关闭 G9 / G12 / G13 / G14）
- [x] Non-Goals 明确；v0.1 完成判据是一句**可验证**的话（关闭 G15 / G16）
- [x] ≥6 份 ADR，每份 Status 明确（关闭 G2 或转开放问题）
- [x] 工具边界表完成（关闭 G17）
- [x] **所有外部能力断言有出处或标注 `未验证`**（Constraint 2 的可验证形式）
- [x] 初稿归档并标注 superseded，README 指向新文档集

### 验收执行记录

| 检查 | 结果 |
|---|---|
| A · 术语一致性（废弃词未出现在正文） | ✅ PASS |
| B · 缺口 G1–G17 全部有归属 | ✅ PASS |
| C · 引用完整性（S/T/C/R/A/CAP/I 共 78 处） | ✅ PASS —— 0 悬空 |
| D · 8 份 JSON Schema 合法性 | ✅ PASS |
| E · `未验证` 标记显式存在 | ✅ docs 5 处、research 2 处 |
| 状态机完备性（脚本核验） | ✅ 无不可达 / 无死端 / 终态无出边 |

### 超出原计划的产出

| 项 | 来源 |
|---|---|
| `A-StageOutcome` 产物 + schema | Stage 6 流程走查发现转移守卫无数据来源 |
| `HumanAdapter`（人工作为一种 Harness） | Stage 6 流程走查发现人工接管在 Run 模型中无处安放 |

### 未达成项（已如实降级，非静默跳过）

| 项 | 状态 | 处置 |
|---|---|---|
| Harness 接口调研 | ⚠️ 仅完成 Claude Code | 其余标 `未验证`；ADR-0005 保持 Proposed 并移出 v0.1 首批 |
| Workflow engine 候选核实 | ⚠️ 未完成 | ADR-0003 §1 需求推导可信；§2 候选评估标 `未验证`，保持 Proposed |

原因：本次会话推理网关（anyrouter.top）对 WebSearch / WebFetch / 子 agent 派发持续返回 429 / 503。
按 PRD Constraint 2 选择**留白而非编造**。

---

## Open Questions（需 owner 确认，不阻塞本任务产出）

本任务会为每条给出**带论证的推荐**并写入 ADR（Status: Proposed），但最终拍板权在 owner。

| # | 问题 | 本任务的处理方式 | 结果 |
|---|---|---|---|
| Q1 | 实现语言与运行时（TypeScript/Node vs Python vs Go） | ADR-0002 给推荐 + 理由，Proposed | ✅ **已定：TypeScript / Node**（owner 2026-08-22 拍板，ADR-0002 → Accepted） |
| Q2 | Workflow engine：自研状态机 vs Temporal vs Inngest | ADR-0003，由 `research/workflow-engine.md` 支撑 | 🟡 Proposed，待查证 |
| Q3 | 首批支持哪些 Harness、按什么顺序 | ADR-0005，由 `research/harness-interfaces.md` 支撑 | 🟡 Proposed，待调研补全 |
| Q4 | v0.1 是否只支持单仓库单项目 | 在 R8 Non-Goals 中给出推荐边界 | ✅ 是 |
| Q5 | Keel 是否 dogfooding（用 Keel 开发 Keel） | 在 R8 中作为阶段二触发条件讨论 | ✅ 阶段二 |

---

## Notes

- 本任务是 **docs 类型**任务，产出是文档而非代码，但验收标准同样要求可验证。
- 下一个任务（依赖 Q1 确认）：仓库骨架与阶段一代码脚手架。
