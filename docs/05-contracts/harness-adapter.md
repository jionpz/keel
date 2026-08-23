# `HarnessAdapter`

> 满足 PRD `R4`；关闭缺口 `G10`（Model 层与 Harness 职责重叠）。
> 事实依据：[`research/harness-interfaces.md`](../../.trellis/tasks/08-22-keel-architecture-framework/research/harness-interfaces.md)

---

## 0. 这份契约要解决的问题

初稿断言 Harness 可替换（原则六），列了 OMP / TRAE / OpenCode / OpenHands 等候选。
但它没有回答一个致命问题：

> **各家 Harness 的能力并不齐整。一个扁平接口套所有 Harness，要么退化到最弱者，要么假装弱者有强者的能力。**

已查证的例子：Claude Code 支持跨进程 session resume（`--resume <session_id>`）、
结构化输出（`--json-schema`）、成本上报、细粒度权限控制。
而其他 Harness 是否具备这些能力，**尚未查证**（网关限流中断，见研究文档的调研状态表）。

本契约的解法是**分级 + 显式降级**：不假装能力齐整，而是让差异变成一等公民。

---

## 1. 能力（Capability）

### 1.1 注册表

| ID | 含义 |
|---|---|
| `CAP-HEADLESS` | 可非交互执行。**这是最低门槛，不具备则无法接入** |
| `CAP-UNTRUSTED_WORKSPACE` | 可在**不执行目标仓库内配置**的模式下运行 |
| `CAP-STRUCTURED_OUTPUT` | 可按给定 schema 产出结构化结果 |
| `CAP-RESUME` | 会话可跨进程恢复，且有持久句柄 |
| `CAP-STREAM` | 提供机器可读的增量事件流 |
| `CAP-COST` | 上报 token / 成本 |
| `CAP-PERMISSION` | 提供工具级权限控制 |
| `CAP-INTERRUPT` | 可优雅中断且保留可恢复状态 |
| `CAP-PROBE` | 运行时自报能力，可用于校正静态声明 |
| `CAP-MODEL_OVERRIDE` | 允许由外部指定模型。**v0.1 不实现** —— 默认假设模型归 Harness 管，见 §4 |

### 1.2 分级

| 级别 | 必备能力 | 它意味着什么 |
|---|---|---|
| `L0` | `CAP-HEADLESS` | 每条降级路径全开 |
| `L1` | L0 + `CAP-RESUME` | 会话可恢复 —— **最大的 token 杠杆** |
| `L2` | L1 + `CAP-STREAM` + `CAP-COST` | 中途可观测、可按预算熔断 |

**不在阶梯内的独立能力**：
`CAP-UNTRUSTED_WORKSPACE`（准入条件）、`CAP-STRUCTURED_OUTPUT`、
`CAP-PERMISSION`、`CAP-INTERRUPT`、`CAP-PROBE`、`CAP-MODEL_OVERRIDE`。

> ⚠️ **阶梯只是给人看的摘要，不参与决策。**
> 真正驱动运行时行为的是 §2 的降级矩阵，它本来就是**按能力逐条**的。
>
> **这一点是被实测纠正过的。** 早先的定义把 `CAP-STRUCTURED_OUTPUT`
> 也放进 L1，结果接入 OMP 时发现：它具备 RESUME / STREAM / COST / PERMISSION，
> 唯独没有原生结构化输出 —— 按旧定义只能标 `L0`，
> 而 `L0` 在降级矩阵里意味着「每轮重新物化上下文」，
> 这对一个**实测 resume 有效、且省两个数量级 token** 的 harness 是完全错误的描述。
>
> 根因：线性阶梯假设能力是**嵌套**的，但它们其实是**正交**的。
> 这个假设在只有一个 harness 时不会暴露，接入第二个就塌了。
> 详见 `research/omp-interface.md` §8。

### 1.3 已知落级

| Harness | 级别 | 依据 |
|---|---|---|
| Claude Code | **L2** | 官方文档：`--resume`、`--json-schema`、`stream-json`、`total_cost_usd`、`--allowedTools` / `--permission-mode` |
| Oh My Pi (OMP) | **L2** | **本机实测**（v17.4.2）：`-p`、`--mode=json` NDJSON、`--resume`（恢复了上下文）、`usage.cost.total`、`--tools` / `--approval-mode` |
| Codex CLI / Aider / OpenCode / OpenHands / Gemini CLI | `未验证` | 网关限流，调研未完成 |
| TRAE | `未验证` | 无本机可验证实例 |

两者的差别不在档次，而在各自的 capability 集合：

| | Claude Code | OMP |
|---|---|---|
| `CAP-STRUCTURED_OUTPUT` | ✅ `--json-schema` | ❌ 需 `post_validate` |
| `CAP-MODEL_OVERRIDE` | 默认不假设 | ✅ `--model` |
| `CAP-UNTRUSTED_WORKSPACE` | ✅ `--bare`（依据官方文档） | ✅ `--no-extensions --no-skills --no-rules`（**已反例验证：不加则仓库内扩展会被加载**） |

> ⚠️ 下游任何设计**不得**假定上表 `未验证` 项的能力。

### 1.4 两段式能力探测

Adapter **静态声明** capability，若具备 `CAP-PROBE` 则在运行时**校正**。

这不是过度设计 —— Claude Code 的 `system/init` 事件已经带 `capabilities[]` 数组，
其官方文档明确建议用它做特性探测**而不是比较版本号**。上游已经这么做了。

规则：

- 静态声明有而运行时探测无 → **以探测为准**，并记一条 `Event`（说明声明过期了）
- 静态声明无而运行时探测有 → **仍以声明为准**。不自动启用未经声明的能力，
  否则 Adapter 的行为会随 Harness 升级而静默改变

---

## 2. 降级矩阵 —— "可替换"的技术兑现

**核心主张**：

> 能力缺失只让闭环**更贵或更粗**，不让它**失效** ——
> 因为事实本来就不在会话里，而在 Fact Plane。

| 缺失能力 | 降级路径 | 代价 | 正确性受损？ |
|---|---|---|---|
| `CAP-RESUME` | `A-Checkpoint.resume_hint.mode = "rematerialize"`，由 ContextBuilder 从 `A-State` + `working_summary` 重建上下文，开新会话 | token 显著上升 | ❌ 不受损 |
| `CAP-STRUCTURED_OUTPUT` | 结果落库前由 Keel 侧校验；不合格走 `R-007` 把错误回灌给 Session | 往返增加，失败率上升 | ❌ 不受损 |
| `CAP-STREAM` | 只在 Run 结束时拿到结果 | 无中途可观测；**无法中途熔断预算** | ❌ 不受损 |
| `CAP-COST` | `usage.cost_basis = "unavailable"`；预算改用 wall-clock 与轮次兜底 | 预算控制变粗 | ❌ 不受损 |
| `CAP-PERMISSION` | 必须在**外层**沙箱隔离（容器 / 独立 worktree / 受限用户） | 运维成本上升 | ❌ 不受损 |
| `CAP-INTERRUPT` | 强杀进程，丢弃当前 turn | 该次 Run 作废重来 | ❌ 不受损 |
| **`CAP-UNTRUSTED_WORKSPACE`** | **无降级路径** | — | ⚠️ **禁止用于不可信仓库** |

### 2.1 为什么最后一行没有降级路径

调研发现（见研究文档 §1.6）：Claude Code 在**不加 `--bare`** 时，
`-p` 会话会执行目标仓库里 `.claude/settings.json` 的 hooks、连接其 `.mcp.json` 的服务器，
官方文档原文是 **"even in a folder you've never trusted"**，且**不显示信任对话框、不显示 per-server 审批**。

Keel 的本职就是把 Harness 指向**任意目标仓库**。
若 Adapter 不强制隔离宿主/仓库配置，目标仓库里一个恶意的 `.claude/settings.json`
就能在 Keel 的执行环境里拿到任意代码执行 —— 全程无提示。

因此：

> **不具备 `CAP-UNTRUSTED_WORKSPACE` 的 Harness，只能用于完全可信的仓库。**
> 这是准入条件，不是可以用"注意一下"绕过的建议。

对 Claude Code 而言，满足该能力的方式是 **Adapter 强制传 `--bare`**，
并把所需上下文显式注入（`--settings` / `--mcp-config` / `--append-system-prompt`）。
副作用是 `--bare` 不读 OAuth 凭据与钥匙串，必须显式提供 API key ——
这恰好与 `repo.credential_ref` 的凭据注入模型吻合。

详见 [`../08-cross-cutting.md`](../08-cross-cutting.md) 安全模型。

---

## 3. 接口

### 3.1 `describe()` `[v0.1 必须]`

```
describe() -> HarnessDescriptor

HarnessDescriptor {
  harness_id:      string
  version:         string
  tier:            "L0" | "L1" | "L2"
  capabilities:    CapabilityId[]
  cost_basis:      "billed" | "estimated" | "unavailable"
  limits: {
    max_input_bytes:  integer | null
    max_wall_clock_s: integer | null
  }
}
```

`cost_basis` 三态是刻意的：Claude Code 的文档明确说明其成本数字是
**client-side estimates，可能与实际账单有出入**。把"估算"与"实际计费"混为一谈，
会让预算控制看起来比实际更精确。见 [`../08-cross-cutting.md`](../08-cross-cutting.md) 成本模型。

### 3.2 `startRun()` `[v0.1 必须]`

```
startRun(spec: RunSpec) -> RunHandle | Error

RunSpec {
  run_id:           string
  idempotency_key:  string          // 见 04-state-machine.md §5
  role:             RoleId          // PM | Critic | Developer | QA | Reviewer
  stage:            StageId

  workspace: {
    path:       string              // Runtime 准备好的工作区
    repo_id:    string
    branch:     string
    untrusted:  boolean             // true 时必须启用 CAP-UNTRUSTED_WORKSPACE
  }

  context:          Context         // 由 ContextBuilder 产出，见 context-builder.md

  output_contract: {
    schema_ref: string              // 期望的 Proposal schema
    mode:       "native" | "post_validate"   // native 需 CAP-STRUCTURED_OUTPUT
  }

  permissions: {
    allowed_tools: string[]
    mode:          "manual" | "auto" | "accept_edits" | "deny_unlisted"
  }

  limits: {
    wall_clock_s: integer
    budget_usd:   number | null
  }
}
```

**契约要求**：

- `workspace.untrusted = true` 而 Adapter 未声明 `CAP-UNTRUSTED_WORKSPACE`
  → 必须返回 `CAPABILITY_UNSUPPORTED`，**不得降级执行**
- `output_contract.mode = "native"` 而无 `CAP-STRUCTURED_OUTPUT`
  → 返回 `CAPABILITY_UNSUPPORTED`；调用方应改用 `post_validate`
- 相同 `idempotency_key` 的重复调用 → 返回已有 `RunHandle`，**不得启动第二个进程**

### 3.3 `awaitResult()` `[v0.1 必须]`

```
awaitResult(handle: RunHandle) -> RunResult | Error

RunResult {
  status:      "SUCCEEDED" | "FAILED" | "TIMEOUT" | "CANCELLED"
  text:        string | null        // 原始文本；post_validate 模式下必须非空
  proposals:   Proposal[]           // 见 session-manager.md
  usage: {
    tokens_in:  integer | null
    tokens_out: integer | null
    cost_usd:   number  | null
    cost_basis: "billed" | "estimated" | "unavailable"
  }
  session_ref: string | null        // 仅 CAP-RESUME 时非空
  error:       Error  | null
}
```

`usage` 全部字段可为 `null` —— 这是 `CAP-COST` 缺失时的诚实表达，
**不允许用 0 或估算值冒充**。`0` 与"不知道"在预算核算里是完全不同的事实。

`text` 在 `post_validate` 模式下**必须非空**：无 `CAP-STRUCTURED_OUTPUT` 的 Harness
只能靠调用方从自由文本中提取提案，Adapter 不带出文本，这条降级路径就断了。

> 这一处是实现期发现的：写 SessionManager 时才发现 `RunResult` 没有地方放原始文本，
> 于是 `post_validate` 无从落地。属于「契约要求的能力在数据结构里没有支撑」——
> 与 `getAsOf` 缺 `committed_at_seq` 是同一类接缝缺口。

### 3.4 `collectChanges()` `[v0.1 必须]`

```
collectChanges(handle: RunHandle) -> WorkspaceDiff | Error

WorkspaceDiff {
  files_changed: { path: string, change: "added"|"modified"|"deleted" }[]
  patch:         string | null       // unified diff
  commits:       string[]            // Harness 自行提交的 commit SHA
  is_dirty:      boolean             // 工作树仍有未提交改动
}
```

**为什么必须有这个方法**：各 Harness 交付结果的方式不同 ——
有的自动 commit（如 Aider 的默认行为 `未验证`），有的留脏工作树
（Claude Code 官方文档**未描述**内置 diff/patch 导出机制 `未验证：是否存在其他方式`）。

Adapter 的职责是**把这种差异吸收掉**，向上统一成 `WorkspaceDiff`。
`estimated_files_changed` 这个 Policy fact 的运行期校验值就来自这里。

### 3.5 `interrupt()` `[v0.1 必须]`

```
interrupt(handle: RunHandle, reason: "cancelled" | "budget" | "takeover") -> void | Error
```

无 `CAP-INTERRUPT` 时降级为强杀进程 —— 该次 Run 作废（`R-010`）。

### 3.6 `dispose()` `[v0.1 必须]`

```
dispose(handle: RunHandle) -> DisposeReport | Error

DisposeReport {
  session_ref_retained: boolean      // 句柄是否仍可用于后续 resume
  workspace_cleaned:    boolean
}
```

**注意**：`dispose` 销毁的是**进程与本地资源**，不必然使 `session_ref` 失效。
对 Claude Code 这类会话由 Harness 侧持久化的实现，
`dispose` 之后 `--resume <session_id>` 仍然可用 —— 这正是 `session_ref_retained` 存在的原因。

### 3.7 `resume()` `[可延后 · 需 CAP-RESUME]`

```
resume(checkpoint: A-Checkpoint, context: Context) -> RunHandle | Error
```

前置条件：`checkpoint.resume_hint.mode == "session_ref"` 且 `session_ref` 非空。
不满足时返回 `CAPABILITY_UNSUPPORTED`，调用方**必须**改走 `rematerialize` 路径（§2）。

### 3.8 `observe()` `[可延后 · 需 CAP-STREAM]`

```
observe(handle: RunHandle) -> AsyncIterator<HarnessEvent>

HarnessEvent {
  kind:      "turn_started" | "tool_call" | "text_delta" | "usage_update" | "retry" | "result"
  at:        timestamp
  payload:   object
}
```

事件流用于：中途可观测、**中途预算熔断**、把 Harness 事件转成 `A-Event`。

无 `CAP-STREAM` 时预算只能在 Run 结束后核算 —— 意味着**超支已经发生**。
这是 `CAP-STREAM` 缺失的真实代价，应在选型时纳入考虑。

---

## 4. `ModelProvider` 与 Harness 的边界 · 关闭 G10

初稿 §19 画了 `Workflow → Agent Role → Runtime Adapter → Harness → Model` 的五层，
暗示 Model 是 Keel 管理的一层。但现实是：**多数 Harness 自带模型配置**。
如果 Keel 也管模型，两者会打架。

本文档的划分：

| | 谁配置模型 | Keel 的角色 |
|---|---|---|
| **Agent 干活**（PM / Developer / QA…） | **Harness 自己** | Keel 只通过 `RunSpec` 传递偏好；Harness 有最终决定权 |
| **Runtime 自身的 LLM 调用**（Context 摘要、事实抽取） | **Keel 的 `ModelProvider`** | Keel 完全掌控 |

因此：

> `ModelProvider` **不服务于 Agent 干活**，只服务于 Keel 自己那几处小型 LLM 调用。
> 它与 `HarnessAdapter` **不重叠**，是两条独立的路径。

若某个 Harness 支持由外部指定模型，则通过一个可选 capability 表达
（`CAP-MODEL_OVERRIDE`，v0.1 不实现）。**默认假设是模型归 Harness 管。**

---

## 5. `HumanAdapter` —— 人工作为一种 Harness

由 [`../07-flows.md`](../07-flows.md) §4 的流程走查得出：人工接管必须能被同一套 Run 模型记账，
否则控制平面在人工做完某阶段后会**再派发一次 AI 执行**。

解法是把人工实现成一个 Adapter：

```
HumanAdapter implements HarnessAdapter {
  harness_id: "human"
  tier:       "L0"
  capabilities: [ CAP-HEADLESS, CAP-UNTRUSTED_WORKSPACE, CAP-INTERRUPT ]
  cost_basis: "unavailable"
}
```

| 方法 | 实现 |
|---|---|
| `startRun` | 通知相关人员，创建一个待办；返回一个等待中的 handle |
| `awaitResult` | 阻塞直至人工通过 UI/CLI 提交 `A-StageOutcome` + `A-State` |
| `collectChanges` | 读工作区 git 状态 —— **与 AI 路径完全相同的实现** |
| `interrupt` | 撤回待办并通知 |
| `dispose` | 清理待办 |
| `resume` | 不支持（无 `CAP-RESUME`） |
| `observe` | 不支持（无 `CAP-STREAM`） |

`CAP-UNTRUSTED_WORKSPACE` 对人工成立的理由与机器不同：
人不会因为仓库里有个 `.mcp.json` 就自动去执行它。

**这个 Adapter 的价值不在于代码量**（它很薄），
而在于它让"人工与 AI 同一套规范"成为**类型系统层面的事实**，
而不是一句需要靠纪律维持的约定。

---

## 6. 实现优先级汇总

| 方法 | 优先级 |
|---|---|
| `describe` | `[v0.1 必须]` |
| `startRun` | `[v0.1 必须]` |
| `awaitResult` | `[v0.1 必须]` |
| `collectChanges` | `[v0.1 必须]` |
| `interrupt` | `[v0.1 必须]` |
| `dispose` | `[v0.1 必须]` |
| `resume` | `[可延后 · CAP-RESUME]` |
| `observe` | `[可延后 · CAP-STREAM]` |

> v0.1 的六个必须方法**不依赖任何可选 capability** ——
> 意味着一个纯 `L0` 的 Harness 也能跑通完整闭环。
> 这就是"Harness 可替换"从主张变成事实的地方。
