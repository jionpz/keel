# ADR-0004 · 持久化与 Artifact 存储

**Status**: **Accepted**（2026-08-26 复核）
**Date**: 2026-08-22

> 2026-08-26 复核：本 ADR 的决策已按原样落地并被测试与授权约束持续验证 ——
> `src/fact/artifact-store.ts`（单表多态 + `keel_commit_artifact`）、
> `src/fact/blob.ts`（256 KB 阈值、内容寻址、**先 blob 后 artifact** 的写序）。
> 实现与推荐方案无出入，故转为 Accepted。

## Context

`03-domain-model.md` 已确定 `artifact` 为**单张多态表**（`kind` + `body JSONB`），
理由是统一寻址、统一版本语义、**单一写入路径**（便于用授权钉死不变量 `I5`）。

遗留问题：大对象怎么办？

| 对象 | 典型体积 |
|---|---|
| `A-State` / `A-RFC` / `A-StageOutcome` | KB 级 |
| 完整对话记录 | **MB 级** |
| 大规模 diff / 测试日志 | MB 级 |

把 MB 级对象放进热表的 JSONB，会让每次 `latest()` 查询都被无关的大字段拖累。

初稿 §11 已给出方向："完整对话可以作为 Debug / Audit 数据保存，但不是每次恢复都加载。"

## Options

| 选项 | 评价 |
|---|---|
| A. 全部进 Postgres JSONB | 简单，但热路径被大对象拖累 |
| B. Postgres + 外部对象存储，`artifact` 只存引用 | 热路径干净，多一个组件 |
| C. Postgres + **本地文件系统**（v0.1），预留对象存储接口 | 无新组件，路径可平滑替换 |

## Decision

**C**，阈值切分：

| 条件 | 存储 |
|---|---|
| `body` ≤ **256 KB** | 直接进 `artifact.body` |
| `body` > 256 KB | 落 blob 存储，`body` 只存 `{ "$ref": "blob://<hash>", "size": N, "preview": "..." }` |

完整对话记录**一律**走 blob，**不进** `artifact` 表 —— 它只有审计价值，不在任何热路径上。

blob 存储 v0.1 用本地文件系统（内容寻址，路径 = hash），
接口按对象存储的语义设计（`put(bytes) -> hash` / `get(hash) -> bytes`），
以便日后替换为 S3 兼容存储时**不改调用方**。

## Consequences

- ✅ 热路径查询不被大对象拖累
- ✅ 内容寻址天然去重（同一份 diff 只存一次）
- ⚠️ blob 与 Postgres 的**一致性需要处理**：先写 blob 再写 artifact，
  孤儿 blob 由后台清理 —— **反过来会产生悬空引用，不可接受**
- ⚠️ 备份需覆盖两处；文档必须写明
- v0.1 单机部署下 blob 目录与数据库同机，多机部署时必须先替换为共享存储
