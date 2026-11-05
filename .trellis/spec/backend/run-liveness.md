# 运行 liveness 与巡检约定

> 记录**实际**做法。来源：`11-04-run-liveness-patrol`。
> 代码：`src/control/liveness/`、`src/timer/patrol.ts`，
> 迁移：`migrations/1000000000007_run_liveness.sql`。

---

## 判据：卡死是「没有新进展」，不是「跑了多久」

两个数字必须分开：

| 概念 | 字段 | 语义 |
|---|---|---|
| 沉默阈值 | `silenceMs` | 多久没有新进展才算卡死 |
| 硬上限 | `hardCapS` | 显式预算；不是 liveness 判据 |

阈值集中在 `src/control/liveness/policy.ts` 的 `LIVENESS_POLICY`，
改阈值只改这一处。`develop` 给到 20min 沉默 / 12h 硬上限，
是为了覆盖合法的 10h 级长任务——**不要把硬上限当卡死判据**。

两类豁免写在 `policyFor()` 里，不要在调用点各自判断：

- `human` → `HUMAN_POLICY`（`silenceMs` / `hardCapS` 都是 `null`）
- 无 `CAP-STREAM` 的 harness → `withoutProgressSignal()`，只保留 `hardCapS`

## 存储：liveness 是遥测，不是 Fact

`run_liveness` / `worker_health` 只授 `keel_control`，**刻意不授予 `keel_execution`**：
进展回调由 Control Plane 落库，Execution 不写事实。

写入纪律（`LivenessStore`）：

- 独立小 pool（`max: 2`）+ 有界队列（1000）+ 合并写，不跟编排事务抢连接
- 进展心跳最多 1 次 / 10s；owner 心跳 1 次 / 15s
- 写失败只走 `onError`，**绝不让 Run 失败**
- 队列满时丢最旧的遥测，Run 不能被遥测阻塞

`silence_ms` 按 **run 创建时**固化到行里，巡检按这一列判定，
**不按 stage 重算**——否则会把豁免的 human run 当卡死。
没有 liveness 行的旧 run 视为「无信号」，走既有墙钟兜底。

删除 `run_liveness` 后事件流必须仍能重建 Task 状态；决策以
`RunStalled` 事件为准，不以遥测为准。

## 进程内监管（StallSupervisor）

只回答「这个 Run 多久没有新进展」，不负责总时长，也不负责编排进程已死。

- 每次 `ProgressEvent` 重置计时；检查间隔默认 `min(15s, silenceMs / 4)`
- 超过阈值 → `interrupt(handle, 'stalled')`，证据带
  `silenceMs` / `lastProgressAt` / `lastKind` / `ownerHeartbeatAt` / `source: 'supervisor'`
- 无文本的 thinking / 工具阶段也算进展——判据是事件，不是文本

## 独立巡检（Patrol）

由 **timer worker 的常驻 drain 循环**调用，不新起常驻服务。

判据与顺序：

```
owner 心跳过期（≠ 进展过期）
  → 按行的 silence_ms 判无进展
  → 幂等 claim（status='RUNNING' + stall_reported_at）
  → best-effort 清孤儿进程组
  → run 标 TIMEOUT / error_kind='RUN_STALLED'
  → driver.advance(RunStalled)
```

两处刻意的保守：

- `silence_ms IS NULL` 的 run 不按沉默收割（human / 无进展信号）
- 没有 liveness 行的 run 不进入候选（旧 run 走墙钟）

清理孤儿前必须核对进程身份：`kill(pid, 0)` + `ps -o lstart=` 启动时间
（容差 2s）；身份不符**不杀**，也不假装已清理。先 SIGTERM 进程组，
宽限期后再 SIGKILL。

巡检自身可观测：每轮写 `worker_health('patrol', ...)`；失败写进
`PatrolStats` 而不是抛异常——抛出去会让常驻循环整轮退出。

## 围栏（fencing）：被收割的 run 不得再写成功事实

这是巡检能安全上线的前提，改动成功/失败路径时不要拆掉：

| 路径 | 守卫 | 0 行的后果 |
|---|---|---|
| 成功元数据 | `UPDATE run ... WHERE id=$1 AND status='SUCCEEDED'` | 不 `commitAll`，返回 `PROTOCOL_ERROR` |
| 失败/超时结算 | `UPDATE run ... WHERE id=$1 AND status='RUNNING'` | 不重复 emit `RunTimeout` / `RunFailed` |

成功路径的 `SUCCEEDED` 由 pipeline 在**提交 artifact 的同一事务**里置位；
loop 只写元数据。不要把这两步拆成两个事务。

## 事件、转移与错误

- `TransitionEvent: RunStalled { stage }`，进 `T-030` / `T-031` 的 `on`，
  复用现有 `stage_attempts` guard：未达上限同 stage 重试，达到上限进 `S-HUMAN_REVIEW`
- `InterruptReason` / `CloseReason` 增加 `'stalled'`
- `ERROR_KINDS` 增加 `RUN_STALLED`（`retryable: true`）
- Run 状态仍是 `TIMEOUT`，靠 `error_kind` 区分「无进展」与「超预算」——
  不要为此扩 `RunStatus`

## 降级开关

`KEEL_LIVENESS_MODE=progress|wallclock`，默认 `progress`。
非法值在启动时拒绝（`run-task` / `timer-worker` 都会校验），
不要留到第一轮 drain 才报错。回滚到 `wallclock` 即恢复旧行为。

## 测试点

- 阈值 / 时钟必须可注入；不要用真实 `setTimeout` 等 20 分钟
- parser 用任意 chunk 切分（一行切两半、多行同 chunk）钉住增量与整段一致
- patrol 的孤儿清理要用真实进程用例（`spawn(detached)` + 真实 `kill`）
- 围栏用 e2e 钉住：巡检收割后 zombie 返回成功不得落 artifact / 覆盖终态
