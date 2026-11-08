# Design — 完善 Keel 架构框架

> 本文是**本任务的技术设计**：产出什么文档集、按什么概念骨架组织、执行期要拍哪些板。
> 它不是 Keel 的架构文档本身 —— 那是本任务的**产出**（`docs/`）。

---

## 1. 设计目标

初稿的根本问题不是"写得少"，而是**没有不变量**。

它列了 Workflow Engine / Session Manager / Context Builder / Policy Engine / Harness 五个模块，
但从没说清"什么东西绝对不能跨过哪条线"。没有不变量，模块边界就是软的，
于是每个模块的职责都可以被下一个人重新解释 —— 这正是它读起来像 vision doc 的原因。

所以本任务的核心设计动作只有一个：

> **先立不变量，再由不变量推出模块边界，最后才写接口。**

---

## 2. 概念骨架（本任务最重要的设计产出）

### 2.1 中心不变量

> **能在进程崩溃后存活的，只有 Artifact。其余一切都是 Session。**

这条不变量把初稿的口号 "Session inside, State outside" 从一句话变成了可执行的判据：
任何一个字段，问一句"它崩溃后还在吗"，就能确定它归谁管。

### 2.2 三平面模型

由不变量直接推出三个平面，**每个平面有明确的"不许做什么"**：

| 平面 | 组件 | 职责 | 硬约束（不许做什么） |
|---|---|---|---|
| **Control Plane**<br>控制平面 | Workflow Engine、Policy Engine | 决定下一步做什么；推进 Task 状态；提交 Artifact | **绝不直接调用 LLM**。必须可确定性重放。 |
| **Execution Plane**<br>执行平面 | Session Manager、Harness Adapter、Model Provider | 干活；产生非确定性结果 | **绝不直接写事实平面**。只能 emit 提案。 |
| **Fact Plane**<br>事实平面 | Artifact Store（State / RFC / Checkpoint / Event） | 唯一事实来源 | **只由控制平面写入**。append-mostly、带版本、可寻址。 |

两个平面之间的桥各有一个方向：

```
Fact Plane  ──[ Context Builder ]──▶  Execution Plane     (读事实 → 造上下文)
Fact Plane  ◀──[ Emit Protocol  ]──   Execution Plane     (提案 → 控制平面校验后落盘)
```

**Context Builder 是唯一的下行桥，Emit Protocol 是唯一的上行桥。** 没有第三条路。

### 2.3 这个骨架顺手关掉的初稿缺口

这不是巧合 —— 缺口之所以存在，就是因为缺了这条不变量。

| 缺口 | 骨架给出的答案 |
|---|---|
| **G3** Session 写权限边界未定义 | Session 永不直接写事实平面；它 **emit 结构化提案**，由控制平面校验后提交。"State 是事实"从原则变成了机制。 |
| **G6** Checkpoint 与 State 关系未定义 | **不同平面、不同 owner**。`State` 属事实平面，控制平面所有，描述 Task；`Checkpoint` 属执行平面，Session 所有，描述"这个会话进行到哪了"，被事实平面**引用**而非包含。 |
| **G4** PM 如何调用 Critic 缺通用机制 | PM **不调用** Critic。PM emit 一个 `capability_request` 提案；控制平面查 Policy，决定是否受理并派发 Critic。初稿里 §8 那个特例，在这里是通用机制的一个实例。 |
| **G10** Model 层与 Harness 职责重叠 | **Harness 自带模型配置，除非它声明了让渡该能力的 capability flag。** `ModelProvider` 只服务于**运行时自己的** LLM 调用（Context Builder 摘要、Policy 事实抽取），不服务于 Agent 干活。两者不重叠。 |
| **G7** Policy 求值语义未定义 | Policy 只在**控制平面**求值，输入只能来自**事实平面**（因此可重放、可审计）。默认 **deny**：没有规则命中就走人工。 |

### 2.4 两级状态机（初稿没有失败路径的根因）

初稿把 Task 状态和"一次执行尝试"的状态混为一谈，所以画不出失败路径 ——
一旦 QA 失败，你不知道该退回哪个状态，因为"失败"本身没有位置放。

拆成两级即可自洽：

| 级别 | 状态举例 | 语义 |
|---|---|---|
| **Task 级** | `NEW` `PM_ANALYZING` `BRAINSTORM` `RFC_READY` `DEVELOPING` `QA` `REVIEW` `DONE` … | 业务进展到哪了。长生命周期。 |
| **Run 级** | `PENDING` `RUNNING` `SUCCEEDED` `FAILED` `TIMEOUT` `CANCELLED` | **一次**阶段执行尝试。短生命周期，可多次。 |

好处是重试免费：Task 停在 `DEVELOPING` 不动，底下 Run #1 `FAILED`、Run #2 `RUNNING`。
Task 级转移表因此只需描述业务推进，失败/超时/取消全落在 Run 级，两张表都能保持小而完备。

### 2.5 Harness 能力分级（"可替换"能否成立的关键）

初稿断言 Harness 可替换，但各家 Harness 能力差异很大（是否支持 resume、是否有结构化输出、是否报成本）。
**一个扁平接口套所有 Harness 是假的** —— 要么接口退化到最弱者，要么强行假装弱者有强者的能力。

设计取法：**分级契约 + 显式降级**。

| 级别 | 能力 | 运行时如何应对 |
|---|---|---|
| `L0` | 一次性执行，纯文本输出，无 resume | 每轮从 Artifact **重新物化**上下文。多花 token，但**正确性不降级**。 |
| `L1` | L0 + 可恢复会话（有持久 session handle） | 走 Checkpoint + resume，省 token |
| `L2` | L1 + 结构化事件流 + 权限控制 + 成本上报 | 可做细粒度观测、预算中断、工具级管控 |

Adapter 必须**声明** capability flags，运行时按声明选择路径。
这样"可替换"才是真的：L0 harness 也能跑通完整闭环，只是更贵。

> 各 Harness 实际落在哪一级，由 `research/harness-interfaces-{a,b}.md` 的查证结果确定，
> 不在本设计中预设。

### 2.6 Event log 作为骨干

事实平面以 **append-only Event log** 为骨干：

- **审计**：回答"这个 Task 到底发生了什么"
- **重放**：控制平面的确定性重放源
- **观测**：trace/span 的天然载体
- **投影**：`State` 是 Event 的投影；状态变更必然伴随 Event

推论：**每个副作用都需要幂等键**，取自 `(task_id, stage, attempt)`。
否则一次重放就会重复建分支、重复开 PR。这是 G8"无幂等语义"的落点。

---

## 3. 产出文档集结构

```
docs/
├── README.md                      # 索引 + 阅读顺序 + 文档约定
├── 01-overview.md                 # 定位 / 目标 / Non-Goals / 三平面模型 / 工具边界表   (R8 部分, R10)
├── 02-glossary.md                 # 术语表                                            (R1)
├── 03-domain-model.md             # 实体 / 关系 / 逻辑 schema / 写权限矩阵              (R2)
├── 04-state-machine.md            # Task 级 + Run 级状态机与转移表                     (R3)
├── 05-contracts/
│   ├── README.md                  # 契约总览 + 版本与兼容策略
│   ├── harness-adapter.md         # 含 capability 分级与降级规则                       (R4)
│   ├── session-manager.md
│   ├── context-builder.md
│   ├── policy-engine.md
│   └── artifact-store.md
├── 06-artifacts.md                # 6 类产物的语义 + 示例                              (R5)
├── 07-flows.md                    # 3 条端到端流程                                     (R6)
├── 08-cross-cutting.md            # 安全 / 可观测 / 成本 / 并发                        (R7)
├── 09-roadmap.md                  # v0.1 判据 + 阶段触发条件                           (R8)
├── schemas/                       # 真实 JSON Schema 文件（可被 CI 校验）
│   └── *.schema.json
├── adr/
│   ├── README.md
│   └── 0001..0006-*.md                                                              (R9)
└── archive/
    └── AI_Engineering_Runtime_Architecture.md   # 初稿归档 + superseded 标注           (R11)
```

### 结构决策与理由

| 决策 | 理由 |
|---|---|
| 契约拆成目录而非单文件 | Trellis 子 agent 注入有 32KB/文件上限；拆分保证每份契约都能被完整注入。且各契约演进速度不同。 |
| Schema 落成真实 `.json` 文件 | 可被 CI 校验、可被代码直接引用。md 只讲语义与示例，避免"文档里的 schema 和代码里的 schema 漂移"。 |
| 初稿移入 `docs/archive/` 而非删除 | PRD Constraint 3。同时仓库根目录清爽，README 指向新文档集。 |
| 编号前缀 `01-`..`09-` | 阅读顺序即依赖顺序，见 §4。 |

---

## 4. 文档间依赖顺序（决定执行顺序）

```
02-glossary  ──▶  03-domain-model  ──▶  04-state-machine  ──▶  05-contracts  ──▶  07-flows
     │                   │                                          │                 ▲
     │                   └──────────▶  06-artifacts  ───────────────┘                 │
     │                                                                                │
     └──────────────────────────────────────────────────────────────────────────────┘
                                    08-cross-cutting、09-roadmap、adr/ 可并行
                                    01-overview 最后写（它是全局摘要）
```

**关键约束**：术语必须最先冻结。术语一改，下游全部要改。
`01-overview` 最后写，因为它是对已定稿内容的摘要 —— 先写会变成又一份 vision doc。

---

## 5. 文档约定（保证可寻址、可被 AI 消费）

| 约定 | 形式 | 例 |
|---|---|---|
| 状态 ID | `S-<NAME>` | `S-RFC_READY` |
| 转移 ID | `T-<NNN>` | `T-014` |
| 能力 ID | `CAP-<NAME>` | `CAP-RESUME` |
| 契约 ID | `C-<Interface>.<method>` | `C-HarnessAdapter.startRun` |
| 产物 ID | `A-<Name>` | `A-RFC` |
| ADR | `ADR-<NNNN>` | `ADR-0003` |
| 需求回溯 | 每份文档头部标注它满足 PRD 的哪条 `R*`、关闭哪条 `G*` | `> 满足 R3；关闭 G8` |
| 未验证断言 | 行内标注 | `未验证` |
| 接口签名 | 语言中立伪代码 + JSON Schema，**不用任何具体语言的语法** | 因 ADR-0002 未定 |

---

## 6. 执行期必须拍板的设计决策

以下不是"待办"，是**必须在执行期做出并写进 ADR 的判断**。
每条都给推荐 + 理由，Status 一律先 `Proposed`，拍板权归 owner。

| ADR | 决策 | 输入依据 | 判断要点 |
|---|---|---|---|
| 0002 | 实现语言与运行时 | —— | 多数 Harness 是 node CLI；但 Trellis 是 Python。**取决于 Adapter 主要是子进程管理还是 SDK 集成** |
| 0003 | Workflow engine | `research/workflow-engine.md` | 核心问题：初稿说的"先自研后换 Temporal"到底是路径还是陷阱。研究结论直接决定这条。 |
| 0004 | 持久化与 Artifact 存储 | —— | Postgres 单库 vs Postgres + 对象存储（大产物如完整对话）。与 §2.6 Event log 设计耦合。 |
| 0005 | Harness 支持优先级与分级 | `research/harness-interfaces-*.md` | 首批支持谁，各自落在 L0/L1/L2 哪级。若查证发现多数 Harness 达不到 L1，§2.5 的降级设计就是必需而非可选。 |
| 0006 | Session 恢复策略 | 同上 | Checkpoint 摘要恢复 vs 全量对话恢复。初稿主张前者，需给出**质量损失**的诚实评估。 |

---

## 7. 风险与对策

| 风险 | 迹象 | 对策 |
|---|---|---|
| **研究查不到权威资料**（尤其 OMP / TRAE） | agent 报告找不到来源 | 标 `未验证`，并把该 Harness 移出 v0.1 首批支持范围。**不允许靠猜补齐** —— PRD Constraint 2。 |
| **文档写成又一份 vision doc** | 出现"应该"、"建议"、"未来可以"而无具体签名 | 验收标准逐条勾；R4/R5 要求可直接写出代码的具体度 |
| **过度设计**：为 v0.1 用不到的能力写契约 | 契约里出现阶段三才需要的方法 | 每个接口方法强制标注 `v0.1 必须` / `可延后` |
| **术语后期返工** | 写到 05 时发现 02 的词不够用 | 接受一次回改，但必须回改 `02-glossary` 而非就地另起一词；验收时全文查术语一致性 |
| **三平面模型本身是错的** | 写 07-flows 时发现某个真实流程跨不过桥 | 这正是 07-flows 放在契约之后的原因 —— 它是骨架的**证伪测试**。跨不过就回改骨架，不要给流程开后门。 |

---

## 8. 兼容与回滚

- **纯新增**：只新建 `docs/`，移动一个初稿文件，改 `README.md` 指向。无代码，无破坏性变更。
- **回滚**：`git revert` 单个 commit 即可完全恢复。初稿内容因归档而不丢。
- **后续演进**：契约与 schema 带 `version` 字段；破坏性变更走新 ADR + version bump，不原地改写。
