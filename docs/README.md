# Keel 架构框架文档集

> 本文档集把 [`archive/AI_Engineering_Runtime_Architecture.md`](./archive/AI_Engineering_Runtime_Architecture.md)（22 章初稿）
> 收敛为**决策完备、可落地**的架构框架。
>
> **完成判据**：一个没参与过讨论的开发者拿到本文档集，能直接开始写阶段一代码，
> 不需要再自己发明任何 schema、接口签名或状态转移。

---

## 建议阅读顺序

阅读顺序即依赖顺序。**术语必须最先看** —— 初稿最大的混用正在那里。

| # | 文档 | 内容 | 关闭的初稿缺口 |
|---|---|---|---|
| 1 | [`01-overview.md`](./01-overview.md) | 定位、中心不变量、三平面模型、Non-Goals 摘要 | `G16` `G17` |
| 2 | [`02-glossary.md`](./02-glossary.md) | **术语表 + 废弃词对照** | `G1` |
| 3 | [`03-domain-model.md`](./03-domain-model.md) | 实体、逻辑 schema、**写权限矩阵** | `G11` |
| 4 | [`04-state-machine.md`](./04-state-machine.md) | Task 级 + Run 级转移表、幂等与重放 | `G8` |
| 5 | [`06-artifacts.md`](./06-artifacts.md) | 8 类产物的语义与示例 | `G4` `G6` |
| 6 | [`05-contracts/`](./05-contracts/) | 5 个核心接口契约 | `G3` `G5` `G7` `G10` |
| 7 | [`07-flows.md`](./07-flows.md) | 3 条端到端流程（**骨架的证伪测试**） | — |
| 8 | [`08-cross-cutting.md`](./08-cross-cutting.md) | 安全 / 可观测 / 成本 / 并发 | `G9` `G12` `G13` `G14` |
| 9 | [`09-roadmap.md`](./09-roadmap.md) | Non-Goals、v0.1 判据、阶段触发条件 | `G15` `G16` `G17` |
| — | [`adr/`](./adr/) | 6 份架构决策记录 | `G2` |
| — | [`schemas/`](./schemas/) | 8 份机器可读 JSON Schema | — |

**赶时间只读三篇**：`01-overview` → `02-glossary` → `04-state-machine`。

---

## 文档约定

### 可寻址 ID

文中所有引用都可回溯到定义处：

| 前缀 | 含义 | 定义处 | 例 |
|---|---|---|---|
| `S-*` | Task 状态 | `04` §1.1 | `S-RFC_READY` |
| `T-NNN` | Task 级转移 | `04` §2 | `T-012` |
| `C-NNN` | `control_mode` 转移 | `04` §3.1 | `C-002` |
| `R-NNN` | Run 级转移 | `04` §4.2 | `R-007` |
| `A-*` | 产物类型 | `06` §1 | `A-RFC` |
| `CAP-*` | Harness 能力 | `05-contracts/harness-adapter.md` §1.1 | `CAP-RESUME` |
| `I*` | 不变量 | `03` §3 | `I5` |
| `G*` | 初稿缺口 | 任务 `prd.md` | `G8` |
| `ADR-NNNN` | 架构决策 | `adr/` | `ADR-0003` |

### 其他约定

| 约定 | 说明 |
|---|---|
| **语言** | 中文写作；技术术语、接口名、字段名保留英文 |
| **`未验证` 标记** | 任何未经查证的外部系统能力断言都必须带此标记。**宁可留白，不可编造** |
| **接口签名** | 一律语言中立伪代码。实现语言已定为 TypeScript（`ADR-0002`），但契约**刻意保持语言中立** —— 读者不只是 Keel 的代码，还有 Harness 实现者与人工操作者 |
| **方法优先级** | 每个接口方法必须标注 `[v0.1 必须]` 或 `[可延后]`，没有第三种 |

---

## 当前状态与已知空白

| 项 | 状态 |
|---|---|
| 文档集 | ✅ 完成 |
| Harness 接口调研 | ⚠️ **仅 Claude Code 完成**；其余因推理网关持续 429 未完成 |
| `ADR-0002` 实现语言 | ✅ **Accepted — TypeScript / Node** |
| `ADR-0003` Workflow engine | ⚠️ Proposed，待查证 |
| `ADR-0005` Harness 分级 | ⚠️ Proposed，待调研补全 |
| 仓库骨架 | ✅ 完成 —— 四条架构约束已机械化，见下 |
| v0.1 实现 | ✅ 核心闭环已跑通；⚠️ 真实 GitHub PR/CI 集成待接入（需远程仓库与凭据） |

### 文档与代码的一致性是被强制的，不是靠自觉

仓库骨架把四条约束变成了 CI 会失败的东西（`pnpm run check`）：

| 约束 | 强制手段 | 保护的是 |
|---|---|---|
| `C1` | 重新生成后与 `HEAD` 比对 | `docs/schemas/` 是产物类型的唯一事实来源 |
| `C2` | dependency-cruiser | Execution Plane 不得写 Fact Plane（不变量 `I5`） |
| `C3` | dependency-cruiser + 禁用全局扫描 + 确定性测试 | 转移函数必须是纯函数（`ADR-0003`） |
| `C4` | 解析本目录 `04-state-machine.md` 的转移表并与代码比对 | **改了文档不改代码（或反之）会红** |

`C4` 意味着：**修改 `04-state-machine.md` §2 的转移表后，
必须同步 `src/control/transition/table.ts`，否则 CI 不过。**

调研原始记录在 `.trellis/tasks/08-22-keel-architecture-framework/research/`。

---

## 关于初稿

初稿保留在 [`archive/`](./archive/)，**不删除**。

它把"要做什么"表达清楚了 —— 七条原则、Session/State 的分野、
分层可替换的主张，都来自它。本文档集做的是把这些主张**变成可执行的机制**，
而不是取代它们。

初稿中被本文档集**修正**的地方（而非仅仅细化的地方）：

| 初稿 | 修正 | 位置 |
|---|---|---|
| `State` 同时指状态机位置与事实集合 | 拆为 `task.status` 与 `A-State` | `02` §6 |
| 单层状态机，`REWORK` 是一个状态 | 拆为 Task 级 + Run 级；`REWORK` 不再需要 | `04` §0、§1.2 |
| `AUTO_DEVELOP` 是一个状态 | 它是 Policy 裁决结果，是 guard 不是状态 | `04` §1.2 |
| `PAUSE`/`HUMAN_TAKEOVER` 在状态链里 | 提为正交的 `control_mode` 维度 | `04` §3 |
| Model 是 Keel 管理的一层 | Model 归 Harness 管；`ModelProvider` 只服务运行时自用 | `05-contracts/harness-adapter.md` §4 |
| Policy 规则集有未定义的冲突 | 严格性偏序 + 默认 deny | `05-contracts/policy-engine.md` §1.3 |
| 安全/可观测/成本/并发全在"阶段三" | 其中多数前移到 v0.1 强制 | `08` §5 |
