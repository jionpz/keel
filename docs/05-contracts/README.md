# 05 · 核心契约（Contracts）

> 满足 PRD `R4`；关闭缺口 `G3` `G5` `G7` `G10`。

---

## 契约清单

| 契约 | 落地的原则 | 文档 |
|---|---|---|
| `HarnessAdapter` | Harness 是执行层，可替换 | [`harness-adapter.md`](./harness-adapter.md) |
| `SessionManager` | Session 是计算资源 | [`session-manager.md`](./session-manager.md) |
| `ContextBuilder` | 不让 Agent 每次从零读项目 | [`context-builder.md`](./context-builder.md) |
| `PolicyEngine` | Policy 决定权限 | [`policy-engine.md`](./policy-engine.md) |
| `ArtifactStore` | State 是事实 | [`artifact-store.md`](./artifact-store.md) |

---

## 通用约定

### 语言中立

所有签名以**伪代码**书写，不使用任何具体语言的语法。

实现语言已定为 **TypeScript / Node**（[`ADR-0002`](../adr/0002-implementation-language.md)），
但契约**刻意保持语言中立**，原因有二：

1. 契约的读者不只是 Keel 的代码 —— 还有 Harness 实现者与人工操作者
2. 语言中立让"日后换语言"仍是一个**可换的决定**，而不是推倒重来

具体的 TS `interface` 存在于代码中，由本目录的伪代码翻译而来；
产物类型则由 [`../schemas/`](../schemas/) 的 JSON Schema **自动生成**，不手写、不手改。

记法：

```
methodName(param: Type, ...) -> ReturnType | Error
```

### 每个方法都必须标注实现优先级

| 标注 | 含义 |
|---|---|
| `[v0.1 必须]` | 阶段一闭环跑不通就是因为它没实现 |
| `[可延后]` | 阶段二/三，或仅特定 capability 下需要 |

**没有第三种标注。** 这是防止契约膨胀成"把未来所有想得到的方法都先列出来"的硬约束。

### 错误语义

所有方法返回值可以是错误。错误统一形状：

```
Error {
  kind:      ErrorKind      // 见下表
  detail:    string
  retryable: boolean        // 决定走 T-030（重试）还是 T-031（升人工）
  cause:     Error | null
}
```

`ErrorKind` 注册表：

| kind | `retryable` | 典型来源 |
|---|---|---|
| `HARNESS_UNAVAILABLE` | ✅ | 二进制缺失、进程启动失败 |
| `AUTH_FAILED` | ❌ | 凭据失效 —— 重试无意义 |
| `PROTOCOL_ERROR` | ✅ | Harness 输出无法解析 |
| `SCHEMA_VIOLATION` | ✅ | Proposal 不符合 schema → 走 `R-007` 回灌 |
| `RUN_TIMEOUT` | ✅ | 超过 wall-clock |
| `RUN_CANCELLED` | ❌ | 人工取消 / 预算熔断 |
| `WORKSPACE_ERROR` | ✅ | 分支冲突、工作区脏 |
| `BUDGET_EXCEEDED` | ❌ | 触发 `C-002` |
| `PERMISSION_DENIED` | ❌ | 越权调用被拦 |
| `CAPABILITY_UNSUPPORTED` | ❌ | 调了 Adapter 未声明的能力 —— **这是编程错误，不是运行时故障** |

> `retryable` 不是建议，是 `04-state-machine.md` 中 `T-030` / `T-031` 的 guard 输入。
> 把不可重试的错误标成可重试，系统会白白重跑到 `max_attempts` 才升人工。

### 版本与兼容

- 契约随文档集演进，破坏性变更走新 ADR
- 产物 schema 独立版本化（`schema_version`），与契约版本解耦 ——
  因为 schema 的消费者（Harness、人工）比契约的消费者（Keel 内部代码）多得多，
  两者演进节奏必然不同

---

## 契约之间的关系

```
                 ┌──────────────────┐
                 │  Control Plane   │
                 └────────┬─────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
  PolicyEngine     ArtifactStore      SessionManager
   （裁决）          （事实读写）        （会话生命周期）
                          │                 │
                          │                 ▼
                          │          HarnessAdapter
                          │            （执行）
                          │                 │
                          └──▶ ContextBuilder ──┘
                              （事实 → 上下文）
```

**注意方向**：`ContextBuilder` 读 `ArtifactStore`，产出喂给 `HarnessAdapter`。
反向没有箭头 —— `HarnessAdapter` **不能**读 `ArtifactStore`（不变量 `I5`）。
它的产出只能经 `SessionManager` 的 Emit 通道回到 Control Plane。
