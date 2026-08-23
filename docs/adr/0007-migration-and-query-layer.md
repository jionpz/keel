# ADR-0007 · 迁移工具与查询层

**Status**: **Accepted**
**Date**: 2026-08-23

## Context

骨架任务把「数据库与迁移」划为 Out of scope，理由是
**迁移工具选型与 `ArtifactStore` 的实现方式耦合** ——
塞进骨架会让一个实现决策被顺手带过。本 ADR 补上这个决策。

约束来自 `docs/03-domain-model.md`：schema 最重要的特性不是表结构，而是
**授权矩阵**（§4）与**不变量**（§3）。`I5` 明确要求靠数据库授权强制。

## Decision

### 迁移：`node-pg-migrate`，迁移文件用**纯 SQL**

### 查询层：raw `pg` + 手写 SQL。**不用 ORM，不用查询构建器**

## Options 与理由

### 迁移

| 选项 | 评价 |
|---|---|
| **`node-pg-migrate`** | 成熟；支持纯 SQL 迁移；自带 advisory lock、applied 追踪、逐迁移事务 |
| 自研 runner | 约 80 行，但要自己处理并发部署时的加锁、已应用追踪、部分失败 |

选库。与 `ADR-0003`（拒绝 Temporal、自研状态机）**不冲突**，两者理由结构不同：

- 那里拒绝 Temporal，是因为它的核心卖点（workflow-as-code）
  **与已有的显式转移表重叠** —— 引入等于同一流程表达两遍
- 这里采用迁移库，是因为它解决的问题（顺序、加锁、追踪、部分失败）
  **没有任何一部分是我们已经有的**，而且这些正是自己写最容易出微妙错误的地方

迁移文件用纯 SQL，而非该库的 JS DSL —— 保证 DDL（含 GRANT）是 schema 的事实来源。

### 查询层

| 理由 | 说明 |
|---|---|
| 方法少 | `ArtifactStore` 只有 7 个方法，抽象层的收益不足以抵消其成本 |
| 事务语义是核心 | 不变量依赖精确的事务边界，抽象层会把它藏起来 |
| **没有 ORM 能建模 GRANT** | 而本 schema 最重要的特性就是授权 |

类型安全的补法不是引入 ORM，而是**漂移检查**：
从 `information_schema` / `pg_constraint` 读实际定义，与 TS 常量比对，不一致则测试失败
（`src/fact/artifact-store.test.ts` 的「schema 与代码的一致性」）。

这是骨架任务 `C1` / `C4` 那套手法的延续：**让漂移成为 CI 失败**，
而不是靠人记得两边一起改。

## Consequences

### 好的

- DDL 是唯一事实来源，包括授权
- 迁移的并发与部分失败问题交给成熟实现
- 漂移检查覆盖了 `task.status` 的 15 个值与 `artifact.kind` 的 7 个值

### 代价

- 手写 SQL 没有编译期字段名检查 —— 靠漂移检查与测试兜底
- 行类型手写，新增列时要记得同步（漂移检查会在忘记时报错）
- `node-pg-migrate` 的 CLI 需要 `DATABASE_URL` 环境变量，
  与应用侧的 `KEEL_DATABASE_URL` 不同名，测试装置中做了转换

### 附带确立的做法

**以 `keel_control` 身份执行一切写入**。这不是可选的谨慎：
该角色对 `artifact` / `event` 只有 SELECT + INSERT，
于是 `I1` / `I2`（只增不改）由数据库而非应用代码保证 ——
即使实现里写错一条 UPDATE，也会被拒绝。
