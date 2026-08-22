# ADR-0002 · 实现语言与运行时

**Status**: Proposed ⚠️ **需 owner 拍板**
**Date**: 2026-08-22

> 🚩 **这是当前唯一阻塞"下一个任务"（仓库骨架）的决策。**
> 语言未定就 scaffold 是确定的返工。

## Context

关键判据不是"哪种语言更好"，而是：

> **`HarnessAdapter` 主要通过 SDK 集成，还是通过 CLI 子进程集成？**

这个问题决定了语言的可选范围：

| 集成方式 | 可选语言 | 能力 |
|---|---|---|
| SDK | 仅该 SDK 支持的语言 | 工具审批回调、原生 message 对象、更细的控制 |
| CLI 子进程 | 任意 | 只能拿到 stdout / 退出码 / 信号 |

**已查证事实**：Claude Code 提供 Python 与 TypeScript 两种 Agent SDK，
官方文档称其提供"structured outputs、tool approval callbacks、native message objects"。
其余 Harness 的 SDK 情况 `未验证`。

## Options

### A. TypeScript / Node

| 优点 | 缺点 |
|---|---|
| 多数 coding harness 本身是 node CLI，同生态便于集成 | LLM 周边生态弱于 Python |
| Claude Code 有 TS SDK | — |
| 本架构含大量 schema 与契约，类型系统收益高 | — |
| JSON Schema → TS 类型的工具链成熟，可让 `docs/schemas/` 直接生成类型 | — |

### B. Python

| 优点 | 缺点 |
|---|---|
| LLM 生态最丰富 | 长期运行服务的类型与并发模型弱于 TS |
| Claude Code 有 Python SDK | — |
| **用户的 Trellis 工作流本身是 Python** | — |

### C. Go

| 优点 | 缺点 |
|---|---|
| 子进程管理与长期运行服务最稳 | **无任何 harness SDK，只能走 CLI 子进程** |
| 单二进制部署 | 生态最弱 |

## Decision（推荐，待拍板）

**A · TypeScript / Node。**

三条理由，按权重排序：

1. **同生态**：Adapter 是本项目最重的集成面，多数 harness 是 node 程序，
   同生态能复用其类型定义、错误码与配置格式
2. **契约密度**：`docs/schemas/` 已有 8 份 JSON Schema，契约文档有数十个接口签名。
   由 schema 直接生成类型，能让"文档里的 schema"与"代码里的类型"**机械对齐**，
   而不是靠人维护同步 —— 这正是本项目最容易腐化的地方
3. **SDK 可用**：至少 Claude Code 的 SDK 路径可用，不必一开始就退到 CLI 子进程

**反方意见（诚实记录）**：Python 的理由也很实：用户的 Trellis 是 Python，
LLM 生态更丰富。若 owner 的日常主力是 Python，**B 是完全合理的选择**，
本架构的任何设计都不依赖语言 —— 这正是契约写成语言中立伪代码的原因。

**排除 C**：失去全部 SDK 路径的代价，超过其运行时优势。

## Consequences

- 契约文档中的语言中立伪代码需要一次性翻译成具体语言的接口定义
- 需要建立 `docs/schemas/*.json` → 类型定义的生成步骤，并纳入 CI
- 若选 B，上述两条同样成立，只是目标语言不同
- **本 ADR 转 Accepted 后，立即开下一个任务：仓库骨架**
