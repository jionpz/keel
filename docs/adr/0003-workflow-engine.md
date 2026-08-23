# ADR-0003 · Workflow engine 选型

**Status**: Proposed ⚠️ **依赖未完成的查证**
**Date**: 2026-08-22
**依据**: `.trellis/tasks/08-22-keel-architecture-framework/research/workflow-engine.md`

## Context

初稿 §4 列了 Temporal / Inngest / 自研三个候选，未决策，并提出
"前期自研一个简单 State Machine，后期换 Temporal"。

关键观察（来自需求推导，**不依赖外部查证**）：

> 本架构的状态机是**数据表 + 纯函数转移**，不是**代码流程**。
> 而 durable execution 引擎的核心卖点恰是"把流程写成普通代码而自动获得持久性"。
> 两者**部分重叠**，不是互补。

逐条核对后，引擎能提供而本架构还缺的只有两样：

| 还缺 | Postgres 上的成本 |
|---|---|
| durable timer | 一张表 + 轮询循环，约 100 行 |
| 可靠 work queue | 一张表 + `SKIP LOCKED` + 重试列，约 150 行 |

幂等、崩溃恢复、确定性重放、无限期等待人工 —— **已由数据模型解决**
（`UNIQUE(idempotency_key)`、`event` 表、Fact-Plane-only facts、`S-HUMAN_REVIEW` 是普通状态）。

## Options

| 选项 | 匹配度 | 备注 |
|---|---|---|
| **自研最小状态机驱动** | 高 | 只补 timer + queue |
| Temporal | 中 | 确定性约束与本架构一致，但本架构已自行满足；workflow-as-code 与转移表重叠；集群运维不匹配 solo 起步 `未验证` |
| Inngest | 低 | 托管为主 ⇒ 编排状态出本地，与凭据/内部仓库的数据流向约束冲突 `未验证` |
| Restate / DBOS / Hatchet | — | 完全未查证，不进入 v0.1 候选 |

## Decision（推荐，待查证后拍板）

**v0.1 自研最小状态机驱动**（Postgres + durable timer + `SKIP LOCKED` 队列）。

这不是"能力不足先凑合"，而是**需求形状不匹配**：
为一个已经把流程建模成显式转移表的系统引入 workflow-as-code 引擎，
等于同一个流程被表达两遍。

## Consequences

### 🔒 硬约束（本 ADR 最重要的产出）

> **状态转移必须实现为纯函数：**
> ```
> transition(status, control_mode, event, facts) -> (new_status, side_effects[])
> ```
> **不得内联 I/O、不得读时钟、不得直接执行副作用。**
> 副作用只能作为返回值中的**描述**，由外层执行器实施。

这条约束同时服务两个目的：

1. **可重放**（`04-state-machine.md` §5.3 的要求）—— 独立成立，不是为迁移额外付出的成本
2. **迁移不成为陷阱** —— 见下

### 「先自研，后换 Temporal」是路径还是陷阱？

**取决于上述约束是否被遵守：**

| | 结果 |
|---|---|
| 转移写成命令式代码流程 | ❌ **陷阱** —— 迁移 = 重写，前期投入基本作废 |
| 转移保持纯函数 | ✅ **可行路径** —— 迁移只是换掉"谁调用它、谁持久化结果"；Temporal workflow 可作为薄壳，转移表与 Fact Plane 完全不动 |

### 其他后果

- ⚠️ 并发 worker 增多后，自建队列的运维细节（死信、限流、优雅关闭）会**持续**消耗时间。
  §Context 中"250 行"的估算**只覆盖 v0.1 单进程场景**，不是生产级队列的总成本
- 需要一个 timer 轮询循环，其自身的存活也需要监控
- 阶段二重估触发条件见 `docs/09-roadmap.md`

### 转 Accepted 前必须查证

- [ ] Temporal 确定性约束的具体范围、signal 投递保证、自托管最小组件数
- [ ] Inngest 自托管方案的成熟度与数据驻留边界
- [ ] Postgres `SKIP LOCKED` 队列的已知坑（长事务、连接池饥饿）
