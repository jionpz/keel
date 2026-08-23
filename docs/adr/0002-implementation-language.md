# ADR-0002 · 实现语言与运行时

**Status**: **Accepted**
**Date**: 2026-08-22
**决定人**: jionpz

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
| 用户的 Trellis 工作流本身是 Python | — |

### C. Go

| 优点 | 缺点 |
|---|---|
| 子进程管理与长期运行服务最稳 | **无任何 harness SDK，只能走 CLI 子进程** |
| 单二进制部署 | 生态最弱 |

## Decision

**A · TypeScript / Node。**

三条理由，按权重排序：

1. **同生态**：Adapter 是本项目最重的集成面，多数 harness 是 node 程序，
   同生态能复用其类型定义、错误码与配置格式
2. **契约密度**：`docs/schemas/` 有 8 份 JSON Schema，契约文档有数十个接口签名。
   由 schema 直接生成类型，能让"文档里的 schema"与"代码里的类型"**机械对齐**，
   而不是靠人维护同步 —— 这正是本项目最容易腐化的地方
3. **SDK 可用**：至少 Claude Code 的 SDK 路径可用，不必一开始就退到 CLI 子进程

排除 C：失去全部 SDK 路径的代价，超过其运行时优势。

排除 B 不是因为它不好 —— 本架构的任何设计都不依赖语言，
这正是契约写成语言中立伪代码的原因。Python 在此完全可行，只是权重不及上述三条。

## Consequences

### 必须建立的机制

| # | 内容 | 为什么 |
|---|---|---|
| `L1` | **`docs/schemas/*.json` → TS 类型的生成步骤，纳入 CI** | 这是选 TS 的第 2 条理由的兑现。**不做这一步，选 TS 的主要收益就没了** |
| `L2` | 生成的类型**不手改**，schema 是唯一事实来源 | 手改会立刻产生第二个事实来源，回到腐化的起点 |
| `L3` | 契约文档中的语言中立伪代码翻译成 TS `interface` | 一次性工作，产物在代码里 |
| `L4` | CI 检查：`docs/schemas/` 变更后，生成的类型必须同步提交 | 防止 schema 改了而类型没跟上 |

`L1` 与 `L4` 不是可选的工程洁癖 —— 它们是这条决策**唯一的实质收益**。
若最终没做，那么选 TS 与选任何语言就没有区别了。

### 保持不变的

**契约文档继续用语言中立伪代码，不改写成 TS 语法。**

理由：契约的读者不只是 Keel 的代码 —— 还有 Harness 实现者与人工操作者。
语言中立也让"日后换语言"仍是一个**可换的决定**，而不是推倒重来。
具体 TS `interface` 存在于代码中，由 `L3` 从契约翻译而来。

### 留给骨架任务的选择

Node 版本、包管理器、构建工具、测试框架**不在本 ADR 决定**。
它们是可逆的工程选择，不是架构决策，不值得占一份 ADR。

### 阻塞解除

本 ADR 转 `Accepted` 后，**仓库骨架任务不再被阻塞**。
