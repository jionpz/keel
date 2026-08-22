# 02 · 术语表（Glossary）

> 满足 PRD `R1`；关闭缺口 `G1`。
> **本文是全部下游文档的地基。** 术语一改，`03`–`09` 全部要改 —— 因此它必须最先冻结。

---

## 0. 为什么需要这一章

初稿最严重的问题不是遗漏，而是**同一个词在不同章节指不同东西**。
最典型的是 `State`：它在 §15 指状态机的枚举位置（`RFC_READY`、`DEVELOPING`），
在 §6、§11 又指共享的事实存储（`confirmed_facts`、`decisions`）。

这两者的 owner、生命周期、写入频率、崩溃语义**完全不同**。用一个词承载，
就意味着任何一次讨论都可能在两个概念之间悄悄滑动 —— 接口也就无法定死。

本章把每个词钉死到：**一句定义 · 与易混词的区分 · 生命周期归属**。

---

## 1. 结构性概念

### Plane（平面）

**定义**：架构的职责域划分，共三个：Control Plane（控制）、Execution Plane（执行）、Fact Plane（事实）。

**区分**：Plane **不是部署单元**，是职责边界。三个平面可以同进程运行，但不许跨界写。

**生命周期**：架构常量，不随运行变化。

**中心不变量**：

> 能在进程崩溃后存活的，只有 Artifact。其余一切都是 Session。

| 平面 | 组件 | 硬约束 |
|---|---|---|
| Control | Workflow Engine、Policy Engine | 绝不直接调用 LLM；必须可确定性重放 |
| Execution | Session Manager、Harness Adapter、Model Provider | 绝不直接写 Fact Plane；只能 emit 提案 |
| Fact | Artifact Store | 只由 Control Plane 写入 |

---

## 2. 工作单元

### Feedback（反馈）

**定义**：系统的原始输入 —— 一条来自用户或外部系统的、**未经解释**的诉求。

**区分**：`Feedback` ≠ `Task`。Feedback 是原材料，Task 是系统决定为它开的工单。
一条 Feedback 可能被判为重复或被拒绝而**永远不产生 Task**；也可能被拆成多个 Task。

**生命周期**：Ingress 创建 → **永不修改** → 永久保留（审计与去重需要）。

> ⚠️ Feedback 是**不可信输入**。它会被送进 LLM 上下文，因此是 prompt injection 的主要入口。
> 见 `08-cross-cutting.md`。

### Task（任务）

**定义**：系统为推进一条或多条 Feedback 而开的工单，**是 Task 级状态机的宿主**。

**区分**：`Task` ≠ `Run`。Task 是"这件事"，Run 是"这次尝试"。

**生命周期**：Control Plane 创建 → Control Plane **独占写** → 到达终态后不再变更（不删除）。

### Run（执行）

**定义**：对某个 Task 的某个 stage 的**一次执行尝试**，是 Run 级状态机的宿主。

**区分**：`Run` ≠ `Session`。
Run 是 Control Plane 的**记账单位**（第几次尝试、成功还是超时）；
Session 是 Execution Plane 的**计算资源**。
一个 Run 通常绑定一个 Session，但 **Run 在 Session 销毁后依然存在** —— 这正是失败可追溯的原因。

**生命周期**：Control Plane 创建 → Control Plane 写 → 终态后不可变。

> Task 与 Run 的两级拆分，是初稿画不出失败路径的根因所在。详见 `04-state-machine.md`。

---

## 3. 执行侧概念

### Session（会话）

**定义**：一个 Agent 的**连续推理上下文**，是临时计算资源。

**区分**：
- `Session` ≠ `Run`（见上）
- `Session` ≠ `Context`：Context 是喂给 Session 的输入，Session 是消费它的进程

**生命周期**：Session Manager 创建 → Execution Plane 持有 →
**崩溃即丢失，且这被认为是正常的** → 显式销毁。

**核心约束**：**Session 不是事实来源。** 它对系统的全部贡献，必须通过 Emit 通道落成 Artifact；
没有 emit 出来的推理成果，在崩溃后就是不存在的。

### Role（角色）

**定义**：Agent 在流程中承担的职能 —— `PM` / `Critic` / `Developer` / `QA` / `Reviewer` / `Architect` / `Security`。

**区分**：`Role` ≠ `Harness` ≠ `Model`。三者正交：

| | 回答的问题 | 例 |
|---|---|---|
| Role | 要干什么 | Developer |
| Harness | 用什么工具干 | Claude Code |
| Model | 用哪个脑子 | 由 Harness 自行配置 |

同一个 Role 可以在不同 Harness 上执行 —— 这正是"Harness 可替换"的含义。

**生命周期**：配置态，不随 Task 变化。

### Harness（执行框架）

**定义**：一个能驱动 LLM 完成编码类工作的**外部程序**（Claude Code、OpenCode、Aider、OpenHands 等）。

**区分**：`Harness` ≠ `Model`。**多数 Harness 自带模型配置** —— 因此 Keel 的 `ModelProvider`
只服务于运行时自身的 LLM 调用（如 Context 摘要），不服务于 Agent 干活。见 `05-contracts/harness-adapter.md`。

**生命周期**：外部系统，**Keel 不管理其生命周期**，只管理对它的一次调用。

### Adapter（适配器）

**定义**：Keel 侧把某个具体 Harness 翻译成 `HarnessAdapter` 契约的代码。

**区分**：一个 Harness 对应一个 Adapter。Adapter 的核心职责之一是**声明 Capability**。

**生命周期**：代码，随 Keel 发布。

### Capability（能力）

**定义**：Adapter 声明的、其底层 Harness 是否支持某项能力的标记，ID 形如 `CAP-RESUME`。

**用途**：Runtime 据此选择执行路径与**降级策略**。这是"Harness 可替换"能否成立的关键 ——
各家 Harness 能力并不齐整，一个扁平接口套所有 Harness 是假的。

**生命周期**：Adapter 静态声明，可在运行时探测校正。

---

## 4. 事实侧概念

### Artifact（产物）

**定义**：Fact Plane 中一条**可寻址、带版本、崩溃后仍存在**的结构化记录。

**区分**：Artifact 是**总称**。以下都是 Artifact 的具体类型：
`A-State`、`A-RFC`、`A-Checkpoint`、`A-Event`、`A-CriticReview`、`A-PolicyDecision`、`A-CapabilityRequest`。

**生命周期**：**只由 Control Plane 写入**。Execution Plane 只能提交 Proposal。

### State（状态事实）· ⚠️ 初稿主要混用点

**定义**：某个 Task 的**当前事实集合** —— 已确认事实、已做决策、未决问题、风险、候选方案。

**区分（本表最重要的一条）**：

> **`State` ≠ `Task.status`。**
> `Task.status` 是状态机的**位置**（一个枚举值，如 `S-RFC_READY`）。
> `State` 是**内容**（我们关于这个 Task 知道些什么）。

初稿中 `State` 一词同时承担这两义。本文档集起，**强制拆分**：

| 概念 | 本文档集的固定写法 | 初稿中的写法 |
|---|---|---|
| 状态机位置 | `Task.status`，值形如 `S-RFC_READY` | "State"、"状态"、§15 状态机图 |
| 事实集合 | `State` / `A-State` | "State"、"Shared State"、§6/§11 的 JSON |

**生命周期**：随 Task 创建 → Control Plane 写 → 与 Task 同寿。

### Checkpoint（检查点）

**定义**：某个 **Session** 在某一时刻的**可恢复摘要**。

**区分**：

> `Checkpoint` 属**执行平面**语义，`State` 属**事实平面**语义。

| | 回答的问题 | owner |
|---|---|---|
| `State` | 关于这个 Task，我们知道什么 | Task |
| `Checkpoint` | 这个会话进行到哪了、怎么接着往下 | Session |

Checkpoint 被 State **引用**，而不是被 State **包含**。
一个 Task 可以有多个 Session，因而有多条互不相关的 Checkpoint 线。

**生命周期**：Session 运行中周期性生成 → Control Plane 提交为 Artifact →
**Session 销毁后仍可用于 resume** → Task 终态后可归档。

### RFC

**定义**：PM 阶段的产出 —— 对"要做什么、怎么做、验收标准"的结构化描述，
是 **PM → Developer 的核心交接物**。

**区分**：`RFC` ≠ `State`。RFC 是**定稿的决议**，State 是**过程中的事实**。
RFC 一旦进入 `S-RFC_READY` 即**冻结**；变更走新版本，不原地改写。

**生命周期**：PM Session emit → Control Plane 校验并提交 → 冻结 → 后续阶段**只读**。

### Event（事件）

**定义**：append-only 日志中的一条**不可变**记录，描述"某时刻发生了什么"。

**区分**：`Event` ≠ Artifact 变更本身。Event 是变更的**记录**；`State` 是 Event 的**投影**。

**生命周期**：只追加，**永不修改、永不删除**。

Event log 同时承担四个职责：审计、确定性重放、可观测性载体、State 投影源。

### Policy（策略）

**定义**：一组规则，输入取自 Fact Plane 的 facts，输出一个 `A-PolicyDecision`。

**区分**：`Policy` ≠ 写在 Prompt 里的指令。
Policy 在 Control Plane **确定性求值**，因此可审计、可重放；Prompt 里的约束做不到这两点。

**默认语义**：**deny**。没有规则命中就走人工，而不是放行。

**生命周期**：配置态，带版本；每次求值都记录所用的 policy version。

---

## 5. 桥接概念

Fact Plane 与 Execution Plane 之间**只有两条通道**，各单向：

```
Fact Plane  ──[ Context ]──▶  Execution Plane      读事实 → 造输入
Fact Plane  ◀──[ Proposal ]──  Execution Plane      产出 → 校验后落盘
```

### Context（上下文）

**定义**：Context Builder 为某个 Session 的**某一轮**构造的输入材料。

**区分**：
- `Context` ≠ `State`：Context 是从 State 等事实**派生**的、面向单次调用的**视图**
- `Context` ≠ `Memory`：**本系统不设独立的 Memory 概念**。长期记忆就是 Fact Plane。
  （初稿 §3 架构图里出现过 "Memory"，本文档集起废弃该词）

**生命周期**：每轮构造 → **用完即弃** → 不是事实来源。
但其**构造参数**会被 Event 记录，以便复现"当时这个 Agent 到底看到了什么"。

### Proposal（提案）/ Emit（提交）

**定义**：Execution Plane 向 Control Plane 提交结构化结果的**唯一通道**。

**区分**：**emit 不等于写入**。提案必须经 Control Plane 校验（schema + policy）后才成为 Artifact。

**生命周期**：Session 产出 → Control Plane 校验 →
接受则成为 Artifact；拒绝则记为 Event 并把拒绝理由反馈给 Session。

> Proposal 机制是"State 是事实"从**原则**变成**机制**的地方。
> 它同时解答了初稿 §8 遗留的问题：PM **不调用** Critic，
> PM emit 一个 `A-CapabilityRequest`，由 Control Plane 查 Policy 后决定是否派发 Critic。
> 初稿里那个特例，在这里只是通用机制的一个实例。

---

## 6. 废弃与更名对照表

初稿中出现、但本文档集**不再使用**的写法：

| 初稿写法 | 出处 | 本文档集的对应写法 | 原因 |
|---|---|---|---|
| `State`（指状态机位置） | §15 | `Task.status` | 与事实集合同名，必须拆分 |
| `Shared State` | §3、§7 | `State`（`A-State`） | "Shared" 暗示多方可写，违反中心不变量 |
| `Memory` | §3 架构图 | 无 —— 长期记忆即 Fact Plane | 引入独立 Memory 会产生第二个事实来源 |
| `Agent`（笼统指代） | 全文 | 按语境拆为 `Role` / `Session` / `Harness` | 一个词混指职能、进程、工具三层 |
| `Agent Runtime` | §3、§19 | `Execution Plane` | 与项目名 "Runtime" 混淆 |

---

## 7. 术语一致性自检

下游文档写作与复核时，逐条检查：

- [ ] 出现 `State` 处，指的是**事实集合**；若指状态机位置，必须写 `Task.status`
- [ ] 出现 `Checkpoint` 处，owner 是 **Session** 而非 Task
- [ ] 出现 `Agent` 处，已按语境替换为 `Role` / `Session` / `Harness`
- [ ] 未出现 `Shared State`、`Memory`、`Agent Runtime`
- [ ] 描述"某平面写某数据"时，未出现 Execution Plane 直接写 Fact Plane

---

**下一篇**：[`03-domain-model.md`](./03-domain-model.md) —— 把这些概念落成实体与表。
