# 仓库骨架与类型管线

## Goal

建立 TypeScript 工程骨架，使 v0.1 可以**对着有类型的契约**开工。

**但骨架的价值不在于"能 build"** —— 那是二十分钟的样板活。它的价值在于：

> **把四条架构约束，从"文档里的规定"变成"CI 会失败的东西"。**

`ADR-0002` 已经写死了一句话：不做 schema → 类型的 CI 校验，选 TypeScript 与选任何语言就没有区别。
本任务兑现它，并把同样的手法用到另外三条约束上。

---

## Background

架构文档集（`docs/`）已完成并通过校验，`ADR-0002` 已 Accepted（TypeScript / Node）。
仓库当前**零代码**。本机：Node v24.14.1、pnpm 10.33.0。

架构本身反复强调一个判断（见 `docs/03-domain-model.md` §3 不变量 `I5` 的注）：

> 只写在文档里的边界，迟早会被一次"临时先这样"绕过。

事实平面的写权限边界因此靠**数据库授权**强制，而不是靠代码自觉。
本任务把同一个思路搬到代码层面。

---

## Problem — 四条会腐化的约束

每一条都已在文档中写明，但目前**没有任何机制阻止它被违反**：

| # | 约束 | 出处 | 不管它会怎样 |
|---|---|---|---|
| `C1` | `docs/schemas/*.json` 是产物类型的**唯一事实来源**，TS 类型由其生成、不手改 | `ADR-0002` L1/L2 | 有人手改生成的类型 → 立刻出现第二个事实来源，schema 从此不可信 |
| `C2` | Execution Plane **不得**写 Fact Plane；两平面之间只有 Context / Proposal 两条单向通道 | 中心不变量、`03` §4 | 某次"先直接读一下库"的临时改动，会让整个"State 是事实"塌掉 |
| `C3` | 状态转移必须是**纯函数**，不得内联 I/O、不得读时钟 | `ADR-0003` Consequences | 可重放性失效；且"日后换 Temporal"从可行路径变成陷阱 |
| `C4` | 代码里的转移表必须与 `docs/04-state-machine.md` 的转移表**一致** | 本任务新增 | 文档与实现各改各的，转移表沦为装饰 |

`C4` 是本任务识别出的**新**约束：架构文档把 31 条 Task 级转移写在 markdown 表里，
代码必然要再写一遍。**两份东西不会自己保持同步。**

---

## Scope

### In scope

| 项 | 说明 |
|---|---|
| 工具链 | 包管理、TS 配置、测试、格式化 / lint、CI |
| **三平面目录结构** | `control/` `fact/` `execution/`，边界由 lint 强制 |
| **schema → 类型生成管线** | 由 8 份 JSON Schema 生成 TS 类型 + 运行时校验器 |
| **契约 TS 接口** | `ADR-0002` L3：把 `docs/05-contracts/` 的伪代码翻译成 `interface` |
| **转移函数骨架** | 纯函数签名 + 完整 Task 级转移表 + 测试 |
| **四条约束的 CI 检查** | 每条都要有一个**会失败**的检查 |

### Out of scope（并给出理由）

| 项 | 为什么不在本任务 |
|---|---|
| 数据库与迁移 | `ADR-0004` 定了**存储设计**，但迁移工具选型与 `ArtifactStore` 的实现方式耦合。塞进骨架会让一个实现决策被顺手带过 —— 留给 v0.1 任务显式决定 |
| 任何 Harness Adapter 实现 | 需要真实调用外部程序，属 v0.1 |
| HTTP server / CLI 入口 | 骨架期没有可暴露的东西 |
| v0.1 业务逻辑 | 定义上不属于骨架 |
| `.trellis/spec/backend` 填充 | 仍应"记录现实而非理想" —— 等有真实代码模式后再写 |

---

## Requirements

### R1 · 工具链可用

`pnpm install` 后，typecheck / test / lint / build 均可运行且通过。
Node 与包管理器版本在仓库中**固定**，不依赖开发者本机恰好装了什么。

### R2 · 三平面目录结构

```
src/
├── control/      # Workflow / Policy / transition —— 决定下一步做什么
├── fact/         # ArtifactStore / event log —— 唯一事实来源
├── execution/    # SessionManager / HarnessAdapter —— 干活
├── contracts/    # 由 docs/05-contracts/ 翻译而来的 interface
├── generated/    # 由 docs/schemas/ 生成 —— 禁止手改
└── shared/
```

目录不只是组织方式，**它承载 `C2`**：`execution/` 不得 import `fact/`。

### R3 · schema → 类型管线（`C1`）

- 由 `docs/schemas/*.schema.json` 生成 `src/generated/`
- 生成物带"请勿手改"的头部标记
- 同一份 schema 同时产出**运行时校验器**（Proposal 校验流水线第 1 步要用）
- 一条命令重新生成；CI 检查生成物与 schema 同步

### R4 · 契约 TS 接口（`ADR-0002` L3）

把 5 份契约文档的语言中立伪代码翻译成 `src/contracts/` 下的 `interface`：
`HarnessAdapter` `SessionManager` `ContextBuilder` `PolicyEngine` `ArtifactStore`。

**仅翻译标注 `[v0.1 必须]` 的方法**；`[可延后]` 的以注释保留位置。

> 契约文档本身**不改写成 TS**（`ADR-0002` Consequences 已定）。
> 这里是**从它翻译出的产物**，不是替代它。

### R5 · 转移表与纯函数（`C3` `C4`）

- `transition()` 实现为纯函数：`(status, control_mode, event, facts) -> (new_status, side_effects[])`
- 转移表覆盖 `docs/04-state-machine.md` 的全部 Task 级转移
- 副作用只作为**返回值中的描述**，不在函数内执行

### R6 · 四条约束各有一个 CI 检查

| 约束 | 检查手段 |
|---|---|
| `C1` | 重新生成后 `git diff --exit-code` |
| `C2` | 依赖边界工具：`execution/` → `fact/` 报错 |
| `C3` | 边界工具限制 transition 模块的可 import 范围（禁 I/O 与时钟） |
| `C4` | 解析 `docs/04-state-machine.md` 的转移表，与代码中的表比对 |

---

## Constraints

1. **依赖最少**：每引入一个依赖都要能说出它解决了哪条约束。骨架期的依赖会活很久。
2. **生成物入库**：生成的类型提交进 git —— 否则 `C1` 的 `git diff` 检查无从谈起。
3. 中文注释与文档；标识符、类型名、字段名用英文。
4. **不得为了让 CI 通过而放宽约束。约束是本任务的产品本身。**

---

## Acceptance Criteria

### 基础

- [ ] `pnpm install && pnpm run check` 在干净克隆上通过
- [ ] `src/` 三平面结构建立，`src/generated/` 带禁改标记
- [ ] 5 份契约的 `[v0.1 必须]` 方法全部有对应 `interface`
- [ ] `transition()` 覆盖 `docs/04-state-machine.md` 的全部 Task 级转移，且有测试

### 核心：约束必须真的会失败

**光说"CI 通过"证明不了任何事** —— 一个什么都不检查的 CI 也会通过。
因此每条约束都必须用**反例**验证：

- [ ] `C1` 反例：手改 `src/generated/` 中一个类型 → CI **失败**
- [ ] `C2` 反例：在 `src/execution/` 中 import `src/fact/` → CI **失败**
- [ ] `C3` 反例：在 transition 模块中 import `node:fs` → CI **失败**
- [ ] `C4` 反例：删掉代码转移表中的一条 `T-*` → CI **失败**
- [ ] 四个反例验证完成后**全部还原**，主干检查为绿

### 文档

- [ ] `docs/` 中与实现有出入的部分已同步
- [ ] 新增依赖在 `design.md` 中有引入理由

---

## Open Questions

| # | 问题 | 处理 |
|---|---|---|
| Q1 | 转移表的事实来源应该是 markdown 还是数据文件？ | 本任务用**双向比对**（`C4`），不改动文档结构。若日后证明比对不够，再考虑反转为"数据文件生成文档" |
| Q2 | 是否需要 monorepo 分包 | v0.1 单包；包管理器选型需保留日后分包的可能 |

---

## Notes

- 后续任务：v0.1 最小闭环（数据库 + ArtifactStore + 第一个 Harness Adapter）
- 本任务完成后，`ADR-0002` 的 L1–L4 应全部落地
