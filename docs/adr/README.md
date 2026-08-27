# 架构决策记录（ADR）

每份 ADR 记录一个不可轻易推翻的选型，含 `Context / Options / Decision / Consequences / Status`。

## 索引

| ADR | 主题 | Status |
|---|---|---|
| [0001](./0001-record-architecture-decisions.md) | 采用 ADR 记录架构决策 | **Accepted** |
| [0002](./0002-implementation-language.md) | 实现语言与运行时 | **Accepted** — TypeScript / Node |
| [0003](./0003-workflow-engine.md) | Workflow engine 选型 | **Proposed** ⚠️ |
| [0004](./0004-persistence.md) | 持久化与 Artifact 存储 | **Accepted** — 实现已交付并验证（2026-08-26 复核） |
| [0005](./0005-harness-support-tiers.md) | Harness 支持优先级与 capability 分级 | **Accepted** — Claude Code + OMP 首批（2026-08-23 修订） |
| [0006](./0006-session-recovery.md) | Session 恢复策略 | **Proposed** — restore 双路径未实现，刻意不转 Accepted（2026-08-26 复核） |
| [0007](./0007-migration-and-query-layer.md) | 迁移工具与查询层 | **Accepted** — node-pg-migrate + raw pg |

## Status 语义

| Status | 含义 |
|---|---|
| `Proposed` | 已论证并给出推荐，**但未经 owner 拍板**。可指导开工，不可当作定论 |
| `Accepted` | 已拍板。推翻需要新的 ADR |
| `Superseded by NNNN` | 被后续决策取代，**保留不删** |

⚠️ 标记表示该 ADR 依赖的外部事实**尚未查证完成**（本次会话推理网关持续 429）。
待查证清单见各 ADR 的 Consequences 与
`.trellis/tasks/08-22-keel-architecture-framework/research/`。
