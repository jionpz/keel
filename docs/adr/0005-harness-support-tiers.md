# ADR-0005 · Harness 支持优先级与 capability 分级

**Status**: **Accepted**（2026-08-23 修订）
**Supersedes**: 本 ADR 的初版把 OMP 移出首批，理由是接口无法查证。该理由已被本机实测推翻。
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

## 2026-08-23 修订：OMP 实测后的两处改动

### 改动一：OMP 进入 v0.1 首批

初版把 OMP 移出首批，理由是「在无法查证其接口的情况下，任何 Adapter 设计都是虚构」。
**该理由已不成立** —— 本机 omp v17.4.2 实测确认（`research/omp-interface.md`）：

| 能力 | 证据 |
|---|---|
| `CAP-HEADLESS` | `-p` |
| `CAP-STREAM` | `--mode=json` NDJSON 事件流 |
| `CAP-RESUME` | `--resume`，**实测恢复了上一轮上下文**（input token 39,651 → 208） |
| `CAP-COST` | `usage.cost.total`，算好的美元金额 |
| `CAP-PERMISSION` | `--tools` / `--approval-mode` |
| `CAP-MODEL_OVERRIDE` | `--model` |

OMP 判为 **L2**，与 Claude Code 并列进入首批。

**额外收益**：初版曾担心「首批只有一个真实 AI harness，
『可替换』这一主张在 v0.1 未被充分证伪」。两个真实 harness 才能真正检验 Adapter 契约 ——
而它已经检验出问题了，见改动二。

TRAE 仍无本机可验证实例，**保持 `未验证`，留在首批之外**。

### 改动二：L0/L1/L2 的定义被证伪并修正

OMP 具备 RESUME / STREAM / COST / PERMISSION，**唯独没有原生结构化输出**。
按初版定义（`L1 = L0 + CAP-RESUME + CAP-STRUCTURED_OUTPUT`），
它连 L1 都够不上、只能标 `L0` ——
而 `L0` 在降级矩阵里意味着「每轮从 Artifact 重新物化上下文」，
这对一个 resume 省两个数量级 token 的 harness 是**完全错误的描述**。

**根因**：线性阶梯假设能力是**嵌套**的，实际它们是**正交**的。
这个假设在只有一个 harness（Claude Code 恰好全都有）时不会暴露。

**修正**（已同步 `docs/05-contracts/harness-adapter.md` §1.2）：

```
L0 = CAP-HEADLESS
L1 = L0 + CAP-RESUME                  会话可恢复
L2 = L1 + CAP-STREAM + CAP-COST       中途可观测、可熔断
```

`CAP-STRUCTURED_OUTPUT` / `CAP-PERMISSION` 移出阶梯，
与 `CAP-UNTRUSTED_WORKSPACE` 一样作为独立能力。

**并且明确：阶梯只是给人看的摘要，不参与决策。**
驱动运行时行为的是降级矩阵，它本来就是按能力逐条的。

> 这条修正验证了初版留下的判断是对的 ——
> 「首批必须包含一个非 L2 的 harness，否则降级路径在 v0.1 期间完全不被执行」。
> 实际发生的更进一步：**第二个 harness 直接证伪了分级模型本身。**

---

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
