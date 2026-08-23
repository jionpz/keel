# Harness Adapter：OMP 与 Human

> 父任务：`08-23-v01-closed-loop`（子任务 4）
> 依据：`research/omp-interface.md`（本机实测）、`ADR-0005`（2026-08-23 修订）

## Goal

实现两个 Adapter，让 v0.1 判据的第三部分「**无人干预**」成为可能：

| Adapter | 级别 | 作用 |
|---|---|---|
| `OmpAdapter` | `L2` | 真实 AI 执行层。本机已实测其全部关键能力 |
| `HumanAdapter` | `L0` | 人工作为一种 Harness（`docs/05-contracts/harness-adapter.md` §5） |

**首批必须包含一个 `L0`**：只有 `L2` 的话，降级路径在 v0.1 期间完全不会被执行 ——
等接入第一个弱 harness 时才会发现降级逻辑从没跑通过（`ADR-0005`）。

---

## Background

`research/omp-interface.md` 已实测确认 OMP 具备
`CAP-HEADLESS` / `CAP-STREAM` / `CAP-RESUME` / `CAP-COST` / `CAP-PERMISSION` / `CAP-MODEL_OVERRIDE`，
**不具备**原生结构化输出。判为 `L2`。

`ADR-0005` 据此修订：OMP 进入 v0.1 首批，且 L0/L1/L2 分级已被证伪并修正。

---

## Problem — 实测暴露的三个必须处理的事实

| # | 事实 | 不处理会怎样 |
|---|---|---|
| P1 | **提前关闭 stdout 会让 omp 收到 SIGPIPE，在写会话文件前死掉** | 后续 `--resume` 报 not found —— resume 能力形同虚设。实测踩到过两次 |
| P2 | **content block 可能是 `thinking` 而非 `text`** | 假设 `content[0].type === 'text'` 会直接崩。实测踩到过 |
| P3 | **OMP 无原生结构化输出** | Proposal 必须走 `post_validate` 路径，不能用 `native` |

---

## Requirements

### R1 · `OmpAdapter`

实现 `HarnessAdapter` 的 6 个 `[v0.1 必须]` 方法。

**argv 构造**（`RunSpec` → 命令行）：

| RunSpec 字段 | omp 参数 |
|---|---|
| — | `-p --mode=json`（固定） |
| `workspace.path` | `--cwd` |
| `workspace.untrusted = true` | `--no-extensions --no-skills --no-rules` |
| `permissions.allowed_tools` | `--tools=<list>`；空则 `--no-tools` |
| `permissions.mode` | `--approval-mode` |
| `limits.wall_clock_s` | `--max-time` |
| 模型 | `--model`（`CAP-MODEL_OVERRIDE`） |
| resume | `--resume <session_ref>` |

**必须**：stdin 关闭（`< /dev/null`）；**完整读完 stdout 再处理**（P1）。

### R2 · NDJSON 事件流解析

按实测到的事件类型解析，产出 `RunResult`：

- `session` → `session_ref`
- `message_end` / `agent_end` → 文本、`usage`
- `message_update` → 增量（`CAP-STREAM` 的 `observe()` 用，v0.1 可延后）

**必须**遍历全部 content block 并按 `type` 分派（P2）。

`usage.cost.total` 映射到 `RunResult.usage.cost_usd`，
`cost_basis` 报 **`estimated`** —— 口径未经确认，宁可保守。

### R3 · `HumanAdapter`（`L0`）

`startRun` 记录待办、`awaitResult` 等人提交、`collectChanges` 读 git 状态。
v0.1 的「等人」用一个可注入的 `HumanInbox` 抽象，测试中同步返回。

### R4 · 能力协商与降级

- `describe()` 返回真实的 capability 集合
- **tier 由 capability 集合推导**，不是硬编码（`ADR-0005` 修订后阶梯不参与决策）
- `workspace.untrusted = true` 而未声明 `CAP-UNTRUSTED_WORKSPACE` → 返回 `CAPABILITY_UNSUPPORTED`，**不得降级执行**
- `output_contract.mode = 'native'` 而无 `CAP-STRUCTURED_OUTPUT` → `CAPABILITY_UNSUPPORTED`

### R5 · 幂等

相同 `idempotency_key` 的重复 `startRun` 不得启动第二个进程。

---

## Constraints

1. Adapter 属 **Execution Plane**：不得 import `src/fact`（边界规则已在）
2. 真实集成测试用 `deepseek-v4-flash`（用户已授权花费）
3. 中文注释；标识符英文

---

## Acceptance Criteria

### 基础

- [x] `OmpAdapter` 6 个方法实现；`describe()` 的 capability 与实测一致
- [x] tier 由 capability 推导（去掉 `CAP-COST` → L2 降为 L1，有测试锁住）
- [x] `HumanAdapter` 实现，tier 为 `L0`
- [x] `pnpm run check` 为绿（全仓库 113 个测试）

### 核心：真实跑通

- [x] **真实调用 omp + deepseek-v4-flash 完成一次 `startRun` → `awaitResult`**（3.3s）
- [x] `RunResult.usage.cost_usd` 非空且 `cost_basis === 'estimated'`
- [x] `session_ref` 非空且形如 UUID
- [x] 真实 resume 已在调研阶段验证（记 4271 → resume 后答对），
      并已量化收益（input token 39,651 → 208）
- [x] `collectChanges()` 实现（git status/diff）

### 核心：`CAP-UNTRUSTED_WORKSPACE` 的反例验证

> 上一轮只确认了开关**存在**，没验证隔离**有效**。
> 按本项目纪律，未经反例验证的约束等同于没有约束。

- [x] 在临时仓库里放一个会留下痕迹的 OMP 扩展
- [x] **不加**隔离开关运行 → **痕迹出现**（证明扩展确实会被加载）
- [x] **加上**隔离开关运行 → 痕迹**不出现**
- [x] 两次结果不同 → `CAP-UNTRUSTED_WORKSPACE` 对 OMP 成立，从 🟡 升为 ✅

### 契约拒绝

- [x] `untrusted = true` + 未声明该能力 → `CAPABILITY_UNSUPPORTED`（不降级）
- [x] `mode = 'native'` + 无 `CAP-STRUCTURED_OUTPUT` → `CAPABILITY_UNSUPPORTED`（OMP 与 Human 都拒绝）
- [x] 相同 `idempotency_key` 重复调用 → 不启动第二个进程

### 回归保护（针对实测踩到的坑）

- [x] 解析器能正确处理含 `thinking` block 的响应 —— 用**真实抓到的事件流样本**测（P2）
- [x] 「必须读完整个流」写进 `run()` 的注释，并说明踩坑经过（P1）

---

## 验收执行记录

**测试**：23 个（解析 5 + tier 5 + argv 5 + 契约拒绝 2 + Human 2 + 真实集成 3 + 隔离反例 1）。
全仓库 113 个，`check` exit 0。

### 隔离反例的结果值得单独记

| 运行 | 痕迹 |
|---|---|
| 不加隔离开关 | ✅ 仓库内扩展**被加载了** |
| 加 `--no-extensions --no-skills --no-rules` | ❌ 不加载 |

**这证明威胁是真的**：在一个含 `.omp/extensions/` 的仓库里跑一次 omp，
就等于执行了该仓库作者写的代码 —— 与 Claude Code 的 `--bare` 是同一类问题。
而 Keel 的本职正是把 harness 指向**任意目标仓库**。

实验已固化为 CI 测试，OMP 未来若改变行为会立刻红。

### 未做的与为什么

| 项 | 原因 |
|---|---|
| `ClaudeCodeAdapter` | 本机有 `claude`，但单次调用成本远高于 deepseek-flash，且 OMP 已足以检验契约。列为后续 |
| `resume()` / `observe()` 方法 | 契约标注 `[可延后]`。`--resume` 的**能力**已在调研阶段实测验证 |
| `CAP-INTERRUPT` | 未实测。当前 `interrupt()` 只标记后由 `awaitResult` 返回 CANCELLED，未持有子进程引用做真正的中断 —— **能力集里没有声明它**，与实现一致 |

---

## Out of scope

| 项 | 去向 |
|---|---|
| `resume()` / `observe()` 方法 | 契约标注 `[可延后]`；但 `--resume` 的**能力**本任务要验证 |
| Session Manager 与 Proposal 校验流水线 | 子任务 5 |
| ClaudeCodeAdapter | 本机虽有 `claude`，但一次调用成本远高于 deepseek-flash；且 OMP 已足以检验契约。列为后续 |
