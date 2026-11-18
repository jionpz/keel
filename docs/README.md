# Keel 文档导航与权威来源

> **这里是导航，不是第二套规范。** 当前产品主线是 **jstack managed**；`legacy-v01` 仍保留兼容和验收契约。阅读前先确认所改的是哪条路径。

## 最短阅读路径

- **理解产品**：[总览](./01-overview.md) → [术语](./02-glossary.md) → [当前 managed 状态机](./managed-state-machine.md)。
- **实施变更**：先读根目录 [AGENTS.md](../AGENTS.md)，再按模块查看 [后端规范](./spec/backend/index.md) 或 [控制台规范](./spec/frontend/index.md)，以及相应测试。
- **排查安全 / 准备上线**：[执行隔离](./spec/backend/executor-isolation.md)、[决策接纳](./spec/backend/decision-acceptance.md)、[动作网关](./spec/backend/action-gateway.md)、[服务与恢复](./spec/backend/service-runtime.md)、[试运行准入](./spec/backend/trial-readiness.md)。

## 两条产品路径，不得混用

| 路径 | 使用场景 | 状态与完成条件 |
|---|---|---|
| **jstack managed（当前）** | 新 workflow/ticket、天问决策和持久调度 | [managed-state-machine.md](./managed-state-machine.md)：`branch_ready` / `pr_ready` 与全部节点 archive 后的 workflow `DONE`；**不自动 merge 或部署** |
| **legacy-v01（兼容）** | 既有 Task/Run、旧接口和历史回归 | [04-state-machine.md](./04-state-machine.md) 的 `S-*` / `T-*` / `C-*`、[03-domain-model.md](./03-domain-model.md)、[05-contracts/](./05-contracts/)、[06-artifacts.md](./06-artifacts.md)、[07-flows.md](./07-flows.md)、[08-cross-cutting.md](./08-cross-cutting.md)、[09-roadmap.md](./09-roadmap.md)。这些**不定义 managed** |

特别保留 `04-state-machine.md` 原路径：`scripts/check-transition-table.ts` 直接解析它的 legacy 转移表（C4），不是可以随意重命名的纯说明文档。

## 一个事实，一个权威定义

| 问题 | 权威来源 | 其他文档的职责 |
|---|---|---|
| jstack 阶段、provider、门禁 | 任务绑定的 jstack **固定工作流包**及其来源版本 | [ADR-0011](./adr/0011-jstack-tianwen-runtime.md)、[工作流路由](./spec/backend/workflow-routing.md) 解释接入边界，不复制第二份阶段表 |
| managed 的业务状态和完成语义 | [managed 状态机](./managed-state-machine.md) 对照 `src/control/`、相关测试与持久表 | 总览只给概念，不重复枚举转移 |
| 消息/产物的结构 | [JSON Schema](./schemas/)；`scripts/generate-types.ts` 生成代码类型 | 不手工维护一份相同的 TypeScript 类型表（C1） |
| 数据库表、角色与写权限 | `migrations/` 中实际 SQL 和相应集成测试 | [数据库规范](./spec/backend/database-guidelines.md) 解释原因，旧 [03](./03-domain-model.md) 只代表 legacy 设计 |
| 错误种类与可重试性 | `src/contracts/errors.ts` 的 `ERROR_KINDS` / `RETRYABLE` | [错误处理](./spec/backend/error-handling.md) 解释策略；[legacy 契约](./05-contracts/README.md) 的表是语义说明 |
| 隔离、授权和远程副作用 | `migrations/`、运行时代码及负例/恢复测试 | [执行隔离](./spec/backend/executor-isolation.md)、[动作网关](./spec/backend/action-gateway.md)、[ADR-0014](./adr/0014-managed-private-git.md) 保留不可省的安全依据 |
| 为什么选择此架构 | [ADR 索引](./adr/) 中已记录的决策和证据 | 当前规范不要把设计理由再次写成第二份决策 |
| 实际进度与未完成项 | GitHub [总跟踪 #85](https://github.com/jionpz/keel/issues/85)、[JT-07 #95](https://github.com/jionpz/keel/issues/95) 和真实验收 | [方案目录](./plans/jstack-tianwen/README.md) 保留目标；[实施证据](./plans/jstack-tianwen/implementation.md) 保留已验证过程，不充当实时看板 |

## 文档分层

- **当前规范**：[managed 状态机](./managed-state-machine.md)、[后端](./spec/backend/index.md)、[前端/控制台](./spec/frontend/index.md)。只记录已落地的行为、可检查的限制和相应测试。
- **契约与决策**：[schemas/](./schemas/)、[adr/](./adr/)，以及上述受 CI 依赖的 legacy 转移表。改动必须同步生成物/代码与测试。
- **目标与验收**：[jstack + 天问方案](./plans/jstack-tianwen/README.md) 及其 [目标契约](./plans/jstack-tianwen/contracts.md)、[验收场景](./plans/jstack-tianwen/acceptance.md)、[交付规划](./plans/jstack-tianwen/delivery.md)。计划不等于已实现 API。
- **历史证据**：[archive/](./archive/) 的初稿、任务日志、试验记录；不作为新 managed 功能的设计源。已决定的理由留在 ADR，未通过的证据不得抹掉。

## 修改纪律

1. 先确定**事实归属**：改 schema 就改生成和调用方；改数据库权限就改 SQL/测试；改运行行为就改实现与对应规范；改历史决策用新 ADR，不擦写旧因果。
2. **禁止空白模板**或以“将来会有 React/日志框架”为依据编写规范。新增文件要回答一个当前存在、无法由其他事实源明确回答的问题。
3. 只保留**一个进度入口**：计划文档不维护第二套「现在已完成到哪」列表。检查 [#85](https://github.com/jionpz/keel/issues/85) 和 [#95](https://github.com/jionpz/keel/issues/95) 的开放项。
4. 文档与代码注释用中文；技术标识符保留英文。外部能力未经验证必须写 `未验证`。架构文档的可寻址 ID 与证据约定见 [架构文档约定](./spec/guides/architecture-doc-conventions.md)。
5. 提交前运行 `pnpm run check`：C1 schema 同步、C2/C3 架构边界、C4 legacy 转移表一致性，以及测试。仅仅文档排版变化也不得让转移表解析出 0 行并“通过”。

**生产边界**：`doctor` 和 `trial-*` 工具已存在，**不等于**正式生产准入。完整范围的平台隔离支持、连续 7 天真实试运行和独立评测仍需以当前验收证据确认，不能凭本文宣布完成。
