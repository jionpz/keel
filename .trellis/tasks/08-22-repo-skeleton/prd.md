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

- [x] `pnpm install && pnpm run check` 在干净克隆上通过（exit 0）
- [x] `src/` 三平面结构建立，`src/generated/` 带禁改标记
- [x] 5 份契约的 `[v0.1 必须]` 方法全部有对应 `interface`（共 22 个方法）
- [x] `transition()` 覆盖 `docs/04-state-machine.md` 的全部 Task 级转移（31 条），15 个测试通过

### 核心：约束必须真的会失败

- [x] `C1` 反例：手改 `src/generated/` 中一个类型 → CI **失败**
- [x] `C2` 反例：在 `src/execution/` 中 import `src/fact/` → CI **失败**
- [x] `C3` 反例：在 transition 模块中 import `node:fs` → CI **失败**
- [x] `C3b` 反例：在 transition 模块中写 `Date.now()` → CI **失败**
- [x] `C4` 反例：删掉代码转移表中的 `T-021` → CI **失败**
- [x] 五个反例验证完成后**全部还原**，主干 `check` 为绿

### 文档

- [x] `docs/` 中与实现有出入的部分已同步（见下「反向修正」）
- [x] 新增依赖在 `design.md` §2 中有引入理由

---

## 验收执行记录

### 反例验证结果

| 约束 | 注入的违规 | 检查命令 | 结果 |
|---|---|---|---|
| `C1` | 在 `ARFC` 中插入 `TAMPERED: number` 并提交 | `check:generated` | ✅ exit 1 |
| `C2` | `src/execution/index.ts` import `../fact/index.js` | `boundaries` | ✅ exit 1 |
| `C3a` | `src/control/transition/index.ts` import `node:fs` | `boundaries` | ✅ exit 1 |
| `C3b` | 同文件写 `export const NOW = Date.now()` | `check:purity` | ✅ exit 1 |
| `C4` | 从 `table.ts` 删除 `T-021` | `check:transitions` | ✅ exit 1 |

还原后 `git status` 干净，`pnpm run check` exit 0。

### ⚠️ 反例验证发现的真实缺陷（`C1`）

**第一次 `C1` 反例没有拦住。** 原因不是注入失败，而是**检查本身写错了**：

```
check:generated = pnpm run generate && git diff --exit-code -- src/generated
```

`git diff`（无 `HEAD`）比较的是**工作区 vs 索引**。而 `check:generated` 会先跑
`generate` 把工作区覆盖回正确内容 —— 于是「篡改了但还没提交」的情形会被自己抹掉，diff 为空。

修正为 `git diff --exit-code HEAD -- src/generated` 后，无论索引处于什么状态，
都能捕获「已落库的生成物 ≠ schema 重新生成的结果」。修正见 commit `ac4624f`。

> **这正是反例验证的价值**：`check:generated` 在主干上一直是绿的，
> 单看 CI 完全正常。若跳过 Stage 8，这个检查会以「看起来在工作」的状态存在很久，
> 直到某次真正的手改被漏过去 —— 而那时没人会想到是检查本身坏了。

### 实现过程中对 `docs/` 的反向修正

实现暴露了四处文档缺陷，均按 Constraint「同步文档而非让代码将就」处理：

| # | 发现 | 修正 |
|---|---|---|
| 1 | `checkpoint` / `stage-outcome` 两份 schema 用 `allOf` + `if/then`，`json-schema-to-typescript` 处理不了，生成出 `{ [k: string]: unknown }` —— **`resume_hint.mode` 这个 L0/L1 降级开关完全无类型** | 改写为 `oneOf` 判别联合。这同时是**更准确的模型**：`session_ref` 模式下 `session_ref` 必填，`rematerialize` 模式下它根本不该存在。同步更新 `docs/06-artifacts.md` §4.1 / §8.1 |
| 2 | `05-contracts/README.md` 的 `ErrorKind` 注册表只有 10 个，但 `artifact-store.md` 用了 `CONFLICT`、`context-builder.md` 用了 `CONTEXT_BUDGET_EXCEEDED` | 补齐为 12 个，并写明 `retryable` 的判断依据 |
| 3 | `04-state-machine.md` §2 写「所有转移隐含 `control_mode = 'auto'`，**`T-9xx` 除外**」，但表中根本没有 `T-9xx` | 更正为 `T-040` / `T-041` |
| 4 | 文档中自环有两种记法：`` `S-BRAINSTORM` ⟲``（T-009）与「同状态 ⟲」（T-030） | `C4` 检查器统一以 ⟲ 标记识别。**这是 C4 检查器第一次运行就抓到的** |

### 超出原计划的产出

| 项 | 原因 |
|---|---|
| `production-must-not-import-tests` 边界规则 | 为让测试文件能 import vitest，`transition-must-be-pure` 需豁免 `.test.ts`。该豁免会开一个口子（把不纯的东西写进 `.test.ts` 再从 `index.ts` 引进来），故补此规则堵住 |

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
