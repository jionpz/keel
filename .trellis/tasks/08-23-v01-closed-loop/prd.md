# v0.1 最小闭环（父任务）

> 本任务**不直接实现**任何东西。它拥有：源需求、子任务地图、跨子任务的验收标准、最终集成复核。
> 实际交付在各子任务中。

---

## Goal（来自 `docs/09-roadmap.md` §1，逐字不改）

> **一条真实的用户反馈进入系统后，在无人干预的情况下走完 `S-NEW → S-DONE`，
> 产出一个通过 CI 的 PR；且 `readEvents(task_id, 0)` 能完整重建这个 Task 的全过程。**

三个部分缺一不可：

| 部分 | 为什么必须在判据里 |
|---|---|
| 走完 `S-NEW → S-DONE` | 证明状态机完整，不是"跑到 DEVELOPING 就算通了" |
| **无人干预** | 证明 Policy 与自动派发真的在工作，而不是每步都有人点确认 |
| 事件流能完整重建 | 证明 Fact Plane 真的是事实来源。**没有这条，前两条可能是靠副作用蒙对的** |

---

## 前置状态

已完成：

| | |
|---|---|
| 架构文档集 | `docs/` —— 10 篇 + 5 份契约 + 8 份 schema + 6 份 ADR |
| 仓库骨架 | TypeScript / pnpm / vitest / Biome / dependency-cruiser |
| 四条架构约束 | 已机械化为 CI 检查，且经反例验证 |
| 契约 TS 接口 | `src/contracts/` —— 22 个 `[v0.1 必须]` 方法的签名 |
| 转移函数 | `src/control/transition/` —— 31 条转移，纯函数，15 个测试 |

**本机环境**：Node 24.14.1、pnpm 10.33.0、PostgreSQL 16.15（homebrew，运行中）。

---

## 子任务地图

| # | 子任务 | 交付 | 依赖 |
|---|---|---|---|
| 1 | **持久化层与 ArtifactStore** | Postgres schema、迁移、`ArtifactStore` 实现、**不变量由授权与约束强制** | — |
| 2 | Policy Engine 实现 | 表达式求值、严格性偏序、默认 deny、`validate()` | 1 |
| 3 | Context Builder 实现 | 配方、预算与固定降级顺序、`ContextBuilt` 事件 | 1 |
| 4 | Harness Adapter | Claude Code（L2）+ Human（L0） | — |
| 5 | Session Manager 与 Proposal 校验流水线 | 五步校验、checkpoint 策略、`restore` 双路径与失效回退 | 1, 4 |
| 6 | Workflow driver | 转移执行器、durable timer、work queue、幂等落地 | 1 |
| 7 | 工作区与 Git / GitHub 集成 | worktree 隔离、分支、PR（幂等）、CI 状态回读 | — |
| 8 | 端到端集成验证 | 用真实反馈跑通判据 | 全部 |

**顺序建议**：1 → (2, 3, 6 可并行) → 4 → 5 → 7 → 8。

> 父子结构不是依赖系统。上表的顺序是**建议**，具体先后写在各子任务自己的
> `prd.md` / `implement.md` 里。

### 为什么从持久化层开始

三条理由：

1. **一切都经它写**。Proposal 校验、事件流、转移执行都要落盘
2. **不变量 `I5`（Execution 不得写 Fact）必须靠数据库授权强制**，
   这是架构的定义性约束 —— 它应当被**先建**，而不是事后补上。
   骨架里的 dependency-cruiser 规则只是代码层的类比，不是真正的强制
3. 它逼出被刻意推迟的迁移工具选型（骨架任务把它划为 Out of scope 时说明了原因）

---

## 跨子任务验收标准

以下由**父任务**负责，不属于任何单个子任务：

- [ ] 端到端判据达成（见 Goal）
- [ ] `docs/08-cross-cutting.md` 的 v0.1 最低要求全部落地：
  - [ ] `S1`–`S3` 安全：Adapter 强制 `CAP-UNTRUSTED_WORKSPACE`；`workspace.untrusted` 无默认值
  - [ ] `O1`–`O4` 可观测：事件流完整、`trace_id` 贯穿、`ContextBuilt` 记录 `source_ref` 与 `dropped`
  - [ ] `C1`–`C4` 成本：`cost_basis` 三态、超预算触发 `C-002`
  - [ ] `N1`–`N4` 并发：每 Task 独立 worktree、乐观锁、单 Task 至多一个 `RUNNING` Run
- [ ] `ADR-0003` 硬约束保持：转移函数仍是纯函数（骨架的 `C3` 检查持续为绿）
- [ ] 骨架建立的四条约束检查**没有被放宽**（改约束要走 ADR）
- [ ] `docs/` 与实现的出入已同步（同步文档，不让代码将就）

### 集成复核时必须回答的问题

1. 事件流能否**独立**回答 `docs/08-cross-cutting.md` §2.2 的四个问题？
2. 有没有哪个副作用**不幂等**？（重放一次事件流验证）
3. `HumanAdapter`（`L0`）路径是否真的被执行过？
   —— 若只跑了 Claude Code，降级矩阵在 v0.1 期间等于没被验证（`ADR-0005` 的顾虑）

---

## Non-Goals（继承自 `docs/09-roadmap.md` §2.1）

多项目 / 多租户、UI、Agent Pool、自动合并 PR、自动回滚已合并 PR、
多模型路由、Claude Code 与 Human 之外的 Harness、完整对话的检索分析。

---

## Notes

- 各子任务独立规划、实现、检查、归档
- 本任务在全部子任务完成后做集成复核，然后才算完成
