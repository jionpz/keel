# 编排循环约定

> 记录**实际**做法。来源：`10-26-orchestrator-stop-reasons` 任务。
> 循环本体在 `src/control/orchestrator/loop.ts`。

---

## 停止必须带原因

`runTaskToCompletion` 的所有成功返回都带 `stopReason`（**必填**）：

| `stopReason` | 条件 |
|---|---|
| `terminal` | 终态 |
| `paused` | `control_mode ≠ auto`（预算熔断 C-002 / 人工接管），恢复 C-005 可续 |
| `awaiting-clarification` | 澄清态、TTL 未到期 |
| `awaiting-external-ci` | `S-PR_OPEN` 且未注入 CI |
| `awaiting-human` | `S-HUMAN_REVIEW` 等人审批 |
| `capability-denied` | 能力请求被守卫拒（R4） |
| `cancelled` | 最近一次 run 被人工撤回（R-010） |

新增停止路径必须表态 —— 字段必填就是用来让「忘了想清楚」编译不过的。
CLI 把 `finalStatus`（走到哪）与 `stopReason`（为什么停）分行打印：
只有前者时，「卡住」和「等人」在输出里长得一模一样。

## 阶段态没有待执行 run：先判证据，再判故障

```
阶段态 + PENDING run 为 null
  ├─ 最近一次 run CANCELLED        → ok · cancelled（设计内等待）
  └─ 其余（SUCCEEDED/FAILED/TIMEOUT/RUNNING/无 run） → err · NOT_FOUND（卡住）
```

**不要按状态归类**（「阶段态没 run 就是卡住」）：人工撤回同样会让阶段态没有待执行 run。
判据读的是**最近一次 run 的状态**，见 `readLatestRun`。

`err` 的 `detail` 必须同时给出：当前状态、最近一次 run 的 `stage/attempt/status`
（无 run 时明说）、下一步查什么（`SideEffectSkipped.existing_status`：
`PENDING`/`RUNNING` = 真重放，终态 = 派发丢失）。

kind 用 `NOT_FOUND`（`retryable=false`），不新增 kind：本错误从不落 `run.error_kind`，
而新增 kind 要同步 `ERROR_KINDS` / `RETRYABLE` / `docs/05-contracts/README.md` 三处。
同尺度先例见 `src/execution/session/manager.ts` 对 `CANCELLED` 的处理。

## 单进程前提（`RUNNING` 判定的边界）

「最近一次 run 仍 `RUNNING` 且没有 PENDING run ⇒ 卡住」只在**单进程同步编排**下成立。
将来出现多 worker 时，「RUNNING 在别人手里」与「RUNNING 死在崩溃进程里」需要
租约 / 心跳才分得开 —— 那时这条判据要改成读租约，而不是继续看状态。

## 只报告，不修复

判出卡住之后：不自动重派 run、不改 `control_mode`、不回滚状态、不猜要不要再来一次。
恢复属于策略（和人的判断），不属于编排器。错误文本的最后一句话要说明这一点，
否则运维会以为「重启一下它自己会续」。

## 常见错误

| 错误 | 后果 |
|---|---|
| 阶段态无 PENDING run 直接 `return ok` | 派发丢失以「退出码 0、跑完了」的样子出现（2026-10-26 的 `firstRun` 撞键 bug 就是这样藏了两轮） |
| 按状态归类判卡住 | 人工撤回（`CANCELLED`）被误报成故障，退出码 1 制造噪音 |
| 判出卡住后自动重派 | 幂等键撞车的原因没修，重派只会再丢一次；且把策略塞进编排器 |
| `detail` 只说「没有待执行的 run」 | 定位成本原封不动转给下一个人 |
