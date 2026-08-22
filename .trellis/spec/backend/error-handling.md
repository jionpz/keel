# 错误处理

> 记录**实际**做法。来源：`08-22-repo-skeleton` 任务，`src/contracts/errors.ts`。

---

## 用 `Result<T>` 表达可预期的失败，不用异常

```ts
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KeelError }
```

契约方法一律返回 `Result<T>`。

理由：可预期的失败（凭据失效、超时、schema 不合格）是**业务流程的一部分** ——
它们要进 `run.error_kind`、要作为状态机 guard 的输入。
用异常表达会让这些信息在调用栈里丢失类型。

异常只留给**编程错误**：不变量被破坏、不可能到达的分支。

---

## `ErrorKind` 是封闭注册表

12 个 kind，定义在 `src/contracts/errors.ts`，与
`docs/05-contracts/README.md` 的表格一致。**新增 kind 要同时改两处。**

## `retryable` 不是建议

它是 `docs/04-state-machine.md` 中 `T-030`（重试自环）与 `T-031`（升人工）的
**guard 输入**。标错的后果是实打实的：

- 把不可重试的标成可重试 → 系统白白重跑到 `max_attempts` 才升人工
- 反过来 → 一次偶发失败直接惊动人

判断依据是**「再试一次有没有可能不同」**：

| 不可重试 | 可重试 |
|---|---|
| `AUTH_FAILED` 凭据失效 | `HARNESS_UNAVAILABLE` 进程启动失败 |
| `PERMISSION_DENIED` 越权 | `PROTOCOL_ERROR` 输出解析失败 |
| `BUDGET_EXCEEDED` 预算耗尽 | `RUN_TIMEOUT` 超时 |
| `CAPABILITY_UNSUPPORTED` 能力不支持 | `WORKSPACE_ERROR` 工作区冲突 |
| `RUN_CANCELLED` 人工取消 | `SCHEMA_VIOLATION` 提案格式不合格 |
| `CONTEXT_BUDGET_EXCEEDED` 上下文放不下 | `CONFLICT` 并发写入冲突 |

`CAPABILITY_UNSUPPORTED` 值得单说：它表示**调了 Adapter 未声明的能力**，
这是编程错误而非运行时故障 —— 重试永远是同样结果。

---

## 校验失败 ≠ 执行失败

Proposal 不符合 schema 时走 `R-007`：把 `violations` **回灌给 Session 让它改**，
而不是直接判 Run 失败。只有连续 `max_proposal_retries` 次仍不合格才走 `R-006`。

理由：结构化产物写错格式很常见，让它改一次比重跑整个阶段便宜一个数量级。

---

## 检查脚本的失败输出

`scripts/` 下的检查脚本失败时必须给出**可操作**的信息，不只是 exit 1：

- 违规的具体位置（文件 : 行号）
- **为什么**这是违规（引用到对应的文档章节）
- 怎么修

参见 `scripts/check-purity.ts` 与 `scripts/check-transition-table.ts`。

## 防假绿

检查脚本必须区分「没有违规」与「没检查到东西」：

```ts
if (files.length === 0) {
  console.error('✗ 扫描到 0 个文件 —— 拒绝以「无违规」通过')
  process.exit(1)
}
```

`check-transition-table.ts` 同理：从 markdown 解析到 0 行即报错。
否则一次文档排版改动会让检查静默失效，而 CI 依然是绿的。

> 这不是假想的风险。本项目的 `check:generated` 就曾因为
> 比较基准写错（用了工作区 vs 索引而非 vs `HEAD`）而**一直是绿的却拦不住手改**，
> 是 Stage 8 的反例验证抓出来的。
> **未经反例验证的检查，等同于没有检查。**
