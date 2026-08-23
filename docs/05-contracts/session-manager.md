# `SessionManager`

> 满足 PRD `R4`；关闭缺口 `G3`（Session 与 Workflow 的写权限边界未定义、resume 如何重建上下文未定义）。

---

## 0. 这份契约要解决的问题

初稿 §5 给了 Session 的生命周期状态名（`CREATE → RUNNING → CHECKPOINT → PAUSED → RESUMED → COMPLETED → DESTROYED`），
并宣称"Agent Session 是临时计算资源，不应该成为系统事实的唯一来源"。

但它**没有说这条边界靠什么强制**。只写在文档里的边界，迟早会被一次"临时先这样"绕过。

本契约把它变成机制：**Session 没有任何写入事实平面的方法**。
它能做的只有 `emit` 一个 Proposal，由 Control Plane 校验后代为写入。

---

## 1. Proposal 协议 —— 上行的唯一通道

### 1.1 形状

```
Proposal {
  proposal_id:      string
  task_id:          string            // 提案归属的 Task
  kind:             ArtifactKind      // state | rfc | critic_review | capability_request | checkpoint
  key:              string
  body:             object            // 必须符合 kind 对应的 JSON Schema
  supersedes:       ArtifactRef | null
  produced_by_run:  string
}
```

> `task_id` 是**显式字段**，不从 `body` 里读。
> 产物 schema 是严格的（`additionalProperties: false`），body 里塞不进 `task_id`；
> 而提案本来就是**关于某个 Task 的** —— 归属属于信封，不属于内容。
>
> 这一处是实现期发现的。

```
ProposalVerdict {
  accepted:     boolean
  artifact_ref: ArtifactRef | null
  violations:   { path: string, rule: string, message: string }[]
}
```

### 1.2 校验流水线

Control Plane 收到 Proposal 后依次校验，**任一步失败即整体拒绝**：

| # | 校验 | 失败后果 |
|---|---|---|
| 1 | **Schema** —— 按 `kind` 的 `schema_version` 校验 `body` | `SCHEMA_VIOLATION` |
| 2 | **引用完整性** —— `supersedes` 指向的 artifact 存在，且是当前最新版 | 拒绝（并发冲突） |
| 3 | **平面越界** —— `body` 中不得含状态机跳转指令、不得直接指定 `task.status` | 拒绝 |
| 4 | **Policy** —— 某些 `kind` 需授权（如 `capability_request`） | 记 `CapabilityDenied` |
| 5 | **提交** —— 写入 `artifact` + 发 `ArtifactCommitted` 事件（同一事务） | — |

第 3 步是本契约的核心。**Session 可以陈述事实，但不能指挥流程。**
它可以在 `A-State` 里写"方案 A 被选中"，但不能写"把 task.status 改成 DEVELOPING"——
状态推进永远是 Control Plane 依据转移表做的判断。

### 1.3 拒绝不等于失败

校验失败走 `R-007`（见 [`../04-state-machine.md`](../04-state-machine.md) §4.2）：
把 `violations` 回灌给 Session 让它改，而**不是**直接判 Run 失败。

理由：结构化产物写错格式是很常见的，让它改一次比重跑整个阶段便宜一个数量级。
只有连续 `max_proposal_retries` 次仍不合格才走 `R-006` 判 Run `FAILED`。

---

## 2. 接口

### 2.1 `selectAdapter()` `[v0.1 必须]`

```
selectAdapter(role: RoleId, requirements: CapabilityId[]) -> HarnessAdapter | Error
```

按 Role 与所需能力挑选 Adapter。找不到满足**必需**能力的 Adapter 时返回
`CAPABILITY_UNSUPPORTED`；只缺可降级能力时正常返回，由调用方按降级矩阵处理。

> `requirements` 中若含 `CAP-UNTRUSTED_WORKSPACE`，**不允许降级匹配** ——
> 见 [`harness-adapter.md`](./harness-adapter.md) §2.1。

### 2.2 `open()` `[v0.1 必须]`

```
open(spec: SessionSpec) -> SessionHandle | Error

SessionSpec {
  run_id:       string
  role:         RoleId
  adapter:      HarnessAdapter
  context:      Context             // 由 ContextBuilder 产出
  workspace:    WorkspaceSpec
  limits:       { wall_clock_s, budget_usd, max_turns }
  checkpoint_policy: CheckpointPolicy
}
```

### 2.3 `advance()` `[v0.1 必须]`

```
advance(handle: SessionHandle, input: TurnInput) -> TurnOutcome | Error

TurnOutcome {
  proposals:  Proposal[]
  usage:      Usage
  finished:   boolean          // Session 认为本阶段工作已完成
  needs:      CapabilityId[]   // 由 A-CapabilityRequest 提案派生
}
```

### 2.4 `checkpoint()` `[v0.1 必须]`

```
checkpoint(handle: SessionHandle) -> A-Checkpoint | Error
```

产出 `A-Checkpoint`（schema 见 [`../06-artifacts.md`](../06-artifacts.md) §4）。
它同样以 Proposal 形式提交，走同一条校验流水线。

**触发时机**（`CheckpointPolicy`）：

| 触发 | 默认 |
|---|---|
| 每 N 轮 | `N = 3` |
| **发出 `blocking` 的 CapabilityRequest 前** | 必须 |
| `close()` 前 | 必须 |
| 预算达到阈值时 | `80%` |

> 中间两条是必须的：前者因为等待 Critic 期间 Session 可能被回收，
> 后者因为不落 checkpoint 就关闭，等于把这次会话的推理成果扔掉。

### 2.5 `restore()` `[v0.1 必须]` —— resume 如何重建上下文

```
restore(checkpoint: A-Checkpoint, context: Context) -> SessionHandle | Error
```

**两条路径，由 `checkpoint.resume_hint.mode` 决定**：

| mode | 前置 | 行为 |
|---|---|---|
| `session_ref` | Adapter 声明 `CAP-RESUME` | 调 `adapter.resume()`，把句柄交回 Harness，会话历史由 Harness 侧保持 |
| `rematerialize` | 无 `CAP-RESUME`，或句柄已失效 | 调 `adapter.startRun()` 开**新会话**，上下文由 ContextBuilder 从 `A-State` + `checkpoint.working_summary` 重建 |

**失效回退**：若 `session_ref` 路径返回错误（句柄过期、Harness 侧已清理），
**必须自动回退到 `rematerialize`**，并记一条 Event。

> 这条自动回退是"Session inside, State outside"真正的价值兑现处：
> 会话没了不是灾难，因为事实从来就不在会话里。
> 恢复质量的损失评估见 [`../adr/0006-session-recovery.md`](../adr/0006-session-recovery.md)。

### 2.6 `close()` `[v0.1 必须]`

```
close(handle: SessionHandle, reason: CloseReason) -> CloseReport | Error

CloseReason = "completed" | "failed" | "timeout" | "cancelled" | "takeover"
```

`close` 前必须先 `checkpoint()`（`reason = "cancelled"` 的强杀情形除外）。

---

## 3. Session 的能力边界（这是 G3 的正面回答）

| Session 能做 | Session 不能做 |
|---|---|
| 读它被给到的 `Context` | ❌ 直接读 `artifact` / `task` / `feedback` 表 |
| 在工作区里读写代码、跑命令 | ❌ 写任何 Fact Plane 的表 |
| emit Proposal 陈述事实 | ❌ 指定 `task.status` 或触发状态转移 |
| emit `A-CapabilityRequest` 请求能力 | ❌ 直接调用 Critic / 其他 Session |
| 产出 `A-Checkpoint` 描述自身进度 | ❌ 决定自己何时被销毁 |

右列不是靠代码自觉，而是靠：

1. **数据库授权** —— `keel_execution` 角色对 `artifact` / `event` / `task` 无写权限
   （见 [`../03-domain-model.md`](../03-domain-model.md) §4）
2. **校验流水线第 3 步** —— 平面越界检查
3. **没有 API** —— 契约里根本不存在让 Session 写事实的方法

三层里第 1 层是硬的，另两层是纵深防御。
