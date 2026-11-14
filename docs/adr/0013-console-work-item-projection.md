# ADR-0013 · 控制台用唯一 WorkItem 投影，底层事实保持分离

**Status**: **Accepted** — 2026-11-14，按消融实验结果落地
**Date**: 2026-11-14
**Related**: `src/cli/console-page.ts`、`src/cli/console.test.ts`、
`docs/spec/frontend/console-guidelines.md`

## Context

控制台同时读取三类业务记录：

1. repo 注册表，定义项目身份；
2. legacy task，使用 `S-*` 状态机；
3. managed workflow 与 ticket，使用 jstack 的调度、ticket 和决策状态。

它们的事实不变量不同，数据库和 API 不能合并。问题出在客户端：页面曾同时维护
`state.tasks`、`state.workflows`、`taskRecords()`、`projectRecords()`、
`groupByRepo()`、`repository_only`、`managed_ticket`、`managed_workflow` 等中间形状，
导致任务、项目和状态栏可能采用不同口径，也让每个渲染点重复判断记录来源。

## Options

| 选项 | 机制 | 评价 |
|---|---|---|
| **A. 底层分离，客户端单一投影** | repo 先建 Project；task、ticket、零 ticket workflow 统一成 `WorkItem`；类型用 `item_type` | 保留各状态机事实，删除客户端重复形状；改动集中在一个适配器 |
| B. 合并数据库或新增通用 API | 把 task、ticket、workflow 写进统一表或端点 | 混淆不同状态机和事务边界；为展示需求扩大持久化与公共接口 |
| C. 保留多套记录与兼容布尔 | 在现有投影上继续加转换 | 每个状态、计数和点击路径仍要维护多份判断，无法证明口径一致 |

## Decision

采用 A。

- `Project` 的身份只来自 repo；空项目是 `items=[]`，不再生成伪 task。
- 客户端唯一工作项入口是 `workItems()`，输出 `item_type=task|ticket|workflow`。
- 有 ticket 的 workflow 只展开 ticket；零 ticket 的 workflow 保留一条
  `item_type=workflow` 的规划项。
- 任务列表、项目聚合、概览进行中、项目卡片和状态栏全部消费 `workItems()`。
- 分类只在 `recordKind / recordNeedsHuman / recordBadge` 中按 `item_type` 完成；
  删除 `managed_ticket`、`managed_workflow`、`repository_only` 布尔分支。
- `node_count` 按 workflow id 去重；同一 workflow 的多条 ticket 不重复累计图节点。
- 未登记到 repo 注册表的历史 workflow 仍创建项目，避免静默丢失。

数据库 schema、`/api/tasks`、`/api/workflows` 和两个状态机均不变。

## Ablation results

| 消融 | 结果 | 保留/删除 |
|---|---|---|
| 删除 `taskRecords()` / `projectRecords()` 双投影 | 单测证明任务、项目、状态栏计数来自同一 `workItems()` | 删除 |
| 删除 `repository_only` 伪记录 | 空 repo 仍显示 0 项，项目页与下拉都不消失 | 删除 |
| 用 `item_type` 替换两个 `managed_*` 布尔 | ticket 跳 workflow、task 跳详情；分类与待办结果不变 | 替换 |
| 删除零 ticket workflow 回退 | ROUTING / READY 等尚未物化图的调度事实从工作项视图消失 | 保留回退 |
| 删除 workflow 节点去重 | 两 ticket 的 2 节点 workflow 被累计成 4 | 保留去重 |
| 只展示 repo 内工作项 | 未注册仓库的历史 workflow 被静默隐藏 | 保留 orphan 项目 |

## Consequences

### 正面

- 任务、项目、状态栏和概览只有一套计数与分类口径。
- 新增记录来源只需扩展一个投影和集中分类器，不再增加布尔分支。
- 空项目、规划中 workflow、真实 ticket 和异常旧数据都有明确行为。

### 代价与边界

- 页面中的“任务”是用户可见的工作项集合，不代表底层只有一种状态机。
- workflow 同时出现在工作流容器视图和工作项回退视图中；前者展示图，后者只在零 ticket
  时代表尚未可展开的规划工作项，二者不是两份事实。
- 现有 HTTP 响应字段保持原样；若未来新增第四种工作项，必须先扩展 `item_type` 消融矩阵。

## 验证

- `pnpm vitest run src/cli/console.test.ts`
- `pnpm run check`
- 回归矩阵覆盖：空 repo、legacy-only、ticket-backed workflow、零 ticket workflow、
  ticket 多状态、同一 workflow 多 ticket、未注册 repo 的 orphan workflow。
