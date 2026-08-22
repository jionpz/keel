# ADR-0005 · Harness 支持优先级与 capability 分级

**Status**: Proposed ⚠️ **调研未完成**
**Date**: 2026-08-22
**依据**: `.trellis/tasks/08-22-keel-architecture-framework/research/harness-interfaces.md`

## Context

初稿把 OMP / TRAE / OpenCode / OpenHands 等并列为可替换的执行层，
隐含假设是它们能力相当。**这个假设未经验证。**

本次调研因推理网关持续 429 **只完成了一家**：

| Harness | 结果 |
|---|---|
| Claude Code | ✅ **L2** —— resume / 结构化输出 / 事件流 / 成本 / 权限控制全部具备 |
| Codex CLI、Aider、OpenCode、OpenHands、Gemini CLI | ⏳ `未验证` |
| **OMP、TRAE** | ⏳ `未验证`，且**公开资料是否存在尚未确认** |

## Decision（推荐）

### v0.1 首批支持

| Harness | 级别 | 理由 |
|---|---|---|
| **Claude Code** | `L2` | 唯一已完整查证的 |
| **HumanAdapter** | `L0` | 人工作为一种 Harness（见 `docs/05-contracts/harness-adapter.md` §5） |

### 刻意的选择：首批必须包含一个 L0

只支持 Claude Code（L2）会让降级路径**在 v0.1 期间完全不被执行** ——
那么等到接入第一个 L0 harness 时，才会发现降级逻辑从没真正跑通过。

`HumanAdapter` 恰好是 `L0`（无 resume、无结构化输出、无成本上报），
因此它**顺带就是降级路径的持续验证**。这不是巧合带来的便利，而是选它进首批的理由之一。

### OMP / TRAE 移出 v0.1

不是因为它们不好，而是**在无法查证其接口的情况下，任何 Adapter 设计都是虚构**。
按 PRD Constraint 2：宁可留白，不可编造。

## Consequences

- ✅ v0.1 同时覆盖 `L2` 与 `L0`，降级矩阵从第一天起就被真实执行
- ⚠️ 首批只有一个真实 AI harness，"可替换"这一主张在 v0.1 **未被充分证伪**。
  第二个 AI harness 接入是阶段二的**首要验证目标**（见 `docs/09-roadmap.md`）
- ⚠️ 若查证后发现多数 harness 达不到 `L1`，
  则 `rematerialize` 降级路径从"退路"升级为"主路径"，
  `ContextBuilder` 的预算设计需要相应加强
- 调研恢复后应重新评估本 ADR
