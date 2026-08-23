# 持久化层与 ArtifactStore

> 父任务：`08-23-v01-closed-loop`

## Goal

把 `docs/03-domain-model.md` 的逻辑 schema 变成可运行的 Postgres schema，
并实现 `ArtifactStore` 的 7 个 `[v0.1 必须]` 方法。

**但本任务真正的产品是不变量的强制**：

> `docs/03-domain-model.md` §3 写了 8 条不变量，并明确指出
> **`I5` 必须靠数据库授权强制，而不是靠约定** ——
> 「只写在文档里的边界，迟早会被一次『临时先这样』绕过」。
>
> 骨架任务用 dependency-cruiser 做了代码层的类比。**本任务要建真正的那道。**

---

## Background

已完成：架构文档集、仓库骨架（四条约束已机械化）、契约 TS 接口、转移函数。
本机：PostgreSQL 16.15（homebrew，运行中）、Node 24.14.1、pnpm 10.33.0。

`ADR-0004` 已决定存储设计：单张多态 `artifact` 表 + 阈值切分的 blob 存储。
**迁移工具选型**被骨架任务刻意推迟至此（理由：它与 `ArtifactStore` 的实现方式耦合）。

---

## Problem — 八条不变量目前一条都没有强制

| ID | 不变量 | 文档要求的强制手段 | 现状 |
|---|---|---|---|
| `I1` | `event` 只增不改 | DB 授权：不授予 UPDATE / DELETE | ❌ 无 |
| `I2` | `artifact` 只增不改 | 同上 | ❌ 无 |
| `I3` | 同一 `idempotency_key` 的副作用至多一次 | `UNIQUE` 约束 | ❌ 无 |
| `I4` | `task.status` 每次变更必然伴随一条 `event` | 同一事务内写入 | ❌ 无 |
| `I5` | **Execution Plane 不得写 Fact Plane** | **DB 角色授权** | ❌ 无（仅代码层类比） |
| `I6` | `feedback` 永不修改 | DB 授权：只 INSERT / SELECT | ❌ 无 |
| `I7` | 进入 `S-RFC_READY` 后 RFC 冻结 | 应用层校验 + `superseded_by` 链 | ❌ 无 |
| `I8` | 终态 Task 不再变更 | 触发器 | ❌ 无 |

---

## Scope

### In scope

| 项 | 说明 |
|---|---|
| 迁移机制 | 工具选型 + 首个迁移 |
| Schema | 7 张表（`repo` `feedback` `task` `task_feedback` `run` `artifact` `event`）+ 索引 |
| **两个数据库角色** | `keel_control` / `keel_execution` + GRANT，落地 `I5` |
| 约束与触发器 | `I1`–`I4`、`I6`、`I8` 的 DB 层强制 |
| `ArtifactStore` 实现 | 7 个 `[v0.1 必须]` 方法 |
| blob 存储 | 内容寻址本地 FS，接口按对象存储语义设计（`ADR-0004`） |
| **不变量反例验证** | 每条不变量都要有一个「尝试违反 → 被拒绝」的测试 |
| CI | Postgres service + 迁移 + 测试 |

### Out of scope

| 项 | 理由 |
|---|---|
| 转移执行器 / timer / work queue | 子任务 6 |
| Proposal 五步校验流水线 | 子任务 5（本任务只提供 `commit()` 的落盘部分与两项硬检查） |
| Policy / Context Builder | 子任务 2 / 3 |
| `project()` 投影 | 契约标注 `[可延后]` |

---

## Requirements

### R1 · 迁移机制

- 选型并写入 ADR（这是被骨架任务推迟的决策）
- 一条命令建库 / 迁移 / 回滚
- 迁移可重复执行且幂等

### R2 · Schema

按 `docs/03-domain-model.md` §2 实现 7 张表，字段、类型、主外键、`CHECK` 与其一致。
`task.status` 的枚举取值必须与 `src/shared/ids.ts` 的 15 个状态一致。

### R3 · 角色与授权 —— 本任务的核心

按 `docs/03-domain-model.md` §4 的写权限矩阵建两个角色并 GRANT。

**矩阵中不存在「Execution Plane 可写 Fact Plane」的格子。**
这不是疏漏，是本架构的定义性约束。

`keel_execution` 对 `feedback` / `task` 也**没有直接读权限** ——
它看到的一切都经由 Context Builder。

### R4 · 不变量的 DB 层强制

| ID | 手段 |
|---|---|
| `I1` `I2` `I6` | 不授予 UPDATE / DELETE |
| `I3` | `UNIQUE (idempotency_key)` |
| `I4` | `ArtifactStore` 在同一事务内写；并由测试验证 |
| `I8` | 触发器：`terminal_at IS NOT NULL` 时禁止 UPDATE |

`I7`（RFC 冻结）属应用层，在子任务 5 落地；本任务只提供 `superseded_by` 链。

### R5 · `ArtifactStore` 实现

`commit` / `get` / `latest` / `history` / `getAsOf` / `appendEvent` / `readEvents`。

`commit()` 的两项硬检查（`docs/05-contracts/artifact-store.md` §1.1）：
`supersedes` 必须指向当前最新版；`(task_id, kind, key, version)` 未被占用。
违反返回 `CONFLICT`。

事务语义：写 artifact + 回填旧行 `superseded_by` + 写 event **必须同一事务**。

### R6 · blob 存储

`body` > 256 KB 时落 blob，`body` 只存 `{"$ref": "blob://<hash>", ...}`（`ADR-0004`）。
内容寻址；接口按对象存储语义（`put(bytes) -> hash` / `get(hash) -> bytes`），
以便日后换 S3 兼容存储时不改调用方。

**一致性**：先写 blob 再写 artifact。孤儿 blob 由后台清理；
**反过来会产生悬空引用，不可接受**。

---

## Constraints

1. **DDL 是 schema 的事实来源**，包括 GRANT —— 没有任何 TS ORM 能忠实建模授权。
2. 依赖最少；每个新依赖要能说出它解决了哪条约束。
3. 不得为了让测试通过而放宽授权。**授权是本任务的产品本身。**
4. 中文注释；标识符英文。

---

## Acceptance Criteria

### 基础

- [x] 一条命令完成迁移；重复执行幂等（`pnpm run db:migrate`）
- [x] 7 张表与 `docs/03-domain-model.md` §2 一致
- [x] `task.status` 的 `CHECK` 取值与 `src/shared/ids.ts` 的 15 个状态一致（有漂移测试比对）
- [x] `ArtifactStore` 7 个方法实现并有测试
- [x] blob 阈值切分工作，>256KB 走 blob 且 artifact 中只留引用
- [x] `pnpm run check` 为绿；骨架的四条约束检查未被放宽

### 核心：不变量必须真的拒绝

- [x] `I1` `keel_control` UPDATE `event` → 被拒
- [x] `I1` `keel_control` DELETE `event` → 被拒
- [x] `I2` UPDATE / DELETE `artifact` → 被拒
- [x] `I3` 重复 `idempotency_key` → 被拒
- [x] `I5` **`keel_execution` INSERT `artifact` → 被拒**
- [x] `I5` `keel_execution` INSERT `event` → 被拒
- [x] `I5` `keel_execution` SELECT `task` / `feedback` → 被拒
- [x] `I6` UPDATE / DELETE `feedback` → 被拒
- [x] `I8` UPDATE 已终结的 `task` → 被拒
- [x] `commit()` 的 `supersedes` 指向非最新版 → 返回 `CONFLICT`
- [x] `commit()` 事务性：CONFLICT 时 artifact 与 event 都不落盘

### 文档

- [x] 迁移工具选型写入 `ADR-0007`
- [x] `docs/` 与实现的出入已同步

---

## 验收执行记录

**测试**：47 个通过（15 转移 + 20 不变量 + 12 store/blob/漂移），`pnpm run check` exit 0。

### 反例的反例

不只跑了不变量测试，还验证了**这些测试真的会在授权被放宽时失败**：

故意执行 `GRANT INSERT ON artifact TO keel_execution` 后，
`I5` 测试立刻变红并报「期望被数据库拒绝，但操作成功了」；`REVOKE` 后恢复绿。

> 这一步不可省。**一条写错的 GRANT 和一条正确的 GRANT，日常表现完全一样。**

### 实现反过来改了三处

| # | 发现 | 修正 |
|---|---|---|
| 1 | **`getAsOf()` 在原 schema 下无法实现** —— `artifact` 表只有 `committed_at` 时间戳，没有任何字段关联事件序号。用时间戳近似是错的：`event.seq` 是全局单调的逻辑序，`committed_at` 是墙上时钟，并发下不一致，而重放依赖 seq | 增加 `committed_at_seq` 列并同步回 `docs/03-domain-model.md` §2.6 |
| 2 | `ErrorKind` 注册表没有适合「查不到产物」的 kind | 补 `NOT_FOUND`（不可重试），同步 `docs/05-contracts/README.md` |
| 3 | 生成的 `ArtifactKind` 含 `event`，但 `A-Event` 有独立的表、不是 artifact 的一种 | 引入 `PersistedArtifactKind = Exclude<ArtifactKind,'event'>`，并加漂移测试比对 DB 的 `CHECK` 取值 |

### 设计上的一个真矛盾

`I2` 要求 `artifact` 只增不改（不授予 UPDATE），但回填 `superseded_by` 需要 UPDATE。

解法：`SECURITY DEFINER` 函数 `keel_commit_artifact`。
函数属主有 UPDATE 权限，调用者没有 —— 唯一能改 `superseded_by` 的路径就是这个函数，
而它只做「插入新版 + 回填旧版」一件事。
这比「授予 UPDATE 然后指望大家只用来回填」强得多。

### 踩到的测试隔离问题

`ArtifactStore` 测试单独跑全过，与不变量测试**合起来跑就挂**。
原因是两个文件并行执行、共享同一个 Postgres，各自在 `beforeEach` 里 `TRUNCATE`，
互相清掉了对方刚铺好的数据。

修正：`fileParallelism: false`，并在配置里写明原因与替代方案（per-file schema）。

---

## Open Questions

| # | 问题 | 处理 |
|---|---|---|
| Q1 | 迁移工具：现成库 vs 自研 runner | 见 `design.md`，写入 ADR-0007 |
| Q2 | 查询层：raw SQL vs 查询构建器 vs ORM | 见 `design.md` |
| Q3 | 测试库如何隔离 | 见 `design.md` |
