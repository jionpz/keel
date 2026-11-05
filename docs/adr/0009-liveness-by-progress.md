# ADR-0009 · 卡死判定按进展信号，而非总耗时

**Status**: **Proposed** — 实现已落地，待全量验证后转 Accepted
**Date**: 2026-11-05
**Related**: ADR-0008（墙钟语义）；`RunStalled` / `RUN_STALLED`；`T-030` / `T-031`；`11-04-run-liveness-patrol`

## Context

v0.1 的「卡死判定」实际由 `wall_clock` 兼任：run 超过 180s 就 `TIMEOUT`。
它把两个不同问题混成一个数字：

| 问题 | 正确的判据 | 旧机制的回答 |
|---|---|---|
| 这个 run 是不是**还在动**？ | 最近一次进展距今多久 | 已经跑了多久 |
| 这个 run 最多能占多少资源？ | 预算 / 硬上限 | 同一个 180s |

`develop` 合法跑 10 小时是常态（大仓、多次工具调用、测试），
按总耗时判定会把「慢」当成「死」。但单纯调大或删掉上限也不行 ——
进程崩溃后没有人收割，run 会永远停在 `RUNNING`。

因此需要把**进展信号**与**硬上限**拆开，并覆盖两种故障形态：

1. 编排进程还活着，但模型静默（挂起、死循环、事件流断）—— 只能由**进程内**机制发现；
2. 编排进程崩溃 / 被 SIGKILL —— 只能由**进程外**机制发现。

## Options

| 选项 | 机制 | 评价 |
|---|---|---|
| **A. 只调大墙钟** | 改 `wall_clock` 常量 | 最小改动，但「慢」与「死」仍不可区分；调大后崩溃收割更慢 |
| **B. 只做进程内 watchdog（无进展重置）** | 进程内定时器 | 能发现模型静默；进程崩溃后无人收割 |
| **C. 只做进程外巡检** | 独立 worker 扫 DB | 能收割崩溃 run；无法中断**还活着**但已静默的编排进程 |
| **D. 两层：进程内 supervisor + 进程外 patrol** | 两者互补 | 覆盖两种故障；代价是遥测表与阈值校准 |
| E. 交给外部 durable execution（Temporal 等） | 替换编排引擎 | 超出 v0.1 范围；见 ADR-0003 |

## Decision

**D。**

### 1. 进展信号

执行层通过 `startRun(spec, hooks.onProgress)` 上报 `ProgressEvent`
（单调时钟 `at` + `kind`）。这是**遥测，不是 Fact**：

- 控制面只回答「多久没有新进展」，不据此判定业务含义；
- 写失败只记日志 / `worker_health`，绝不让 run 失败，也不阻塞 stdout 消费；
- 重放不建立在这些数据上。

无 `CAP-STREAM` ⇒ `progressSource = 'none'`，只保留硬上限。

### 2. 每 stage 策略

| stage | `silenceMs` | `hardCapS` |
|---|---|---|
| `pm` | 5m | 30m |
| `brainstorm` | 10m | 2h |
| `critic` | 10m | 2h |
| `rfc_draft` | 10m | 2h |
| `develop` | 20m | 12h |
| `qa` | 10m | 2h |
| `review` | 10m | 2h |

- **human**：`silenceMs: null`、`hardCapS: null` —— 等人没有「卡死」概念；
- **显式 `--wall-clock <秒>`**：覆盖所有 stage 硬上限（逃生阀），启动时打 warning；
- **`KEEL_LIVENESS_MODE=wallclock`**：整体退回旧的全局 180s，行为与改造前一致；
  非法值启动失败，不静默回退。

`silenceMs: null` 是「不做沉默判定」的**单一事实源**，`progressSourceOf()`
只派生只读标签，不额外存一份状态。

### 3. 两层检测

| 层 | 位置 | 判据 | 动作 |
|---|---|---|---|
| 进程内 `StallSupervisor` | 编排进程 | `now - lastProgressAt ≥ silenceMs`（单调时钟） | `interrupt('stalled')`；pipeline 映射 `RUN_STALLED` |
| 进程外 `Patrol` | timer worker 常驻 drain | owner 心跳过期（默认 30s）且沉默超过 `run_liveness.silence_ms` | `RUNNING`-guarded UPDATE → `TIMEOUT`/`RUN_STALLED` → `driver.advance(RunStalled)` |

**为什么巡检要读持久化的 `silence_ms` 而不是按 stage 重算**：巡检在另一个进程，
看不到 `isHuman` / `CAP-STREAM`。重算会把 human / 无信号 run 误判成卡死。
`silence_ms IS NULL` 的 run 一律跳过（保守方向：失去遥测 ⇒ 不介入）。

**幂等**：巡检先 `UPDATE run_liveness SET stall_reported_at=... WHERE stall_reported_at IS NULL`
claim，再在事务里 `UPDATE run ... WHERE status='RUNNING'` 并检查 `rowCount`；
并发 worker 只收割一次，已终态的 run 不被重复推进。

**孤儿进程**：只在 `pgid === pid` 且 `ps -o lstart=` 与记录的
`harness_started_at` 相差 ≤ 2s 时 kill；`SIGTERM` → grace → `SIGKILL`。
结果写进 `RunStalled` 的 `orphan_killed: true | false | null`；
杀不掉记 `orphan_alive` 到 `worker_health.last_error`，不静默成功。

### 4. 事件与状态

- 不新增 `RunStatus`：卡死与超时都以 `TIMEOUT` 收尾，后续动作相同；
- `run.error_kind='RUN_STALLED'` 区分归因；
- 新增事件 `RunStalled`，payload 携带证据
  `{ silence_ms, last_progress_at, last_kind, owner_heartbeat_at, source, orphan_killed }`；
- `T-030` / `T-031` 的 `on` 增加 `RunStalled`，与 `RunFailed` / `RunTimeout` 同路。

### 5. 硬上限仍在

`wall_clock` timer 继续承担「总预算兜底」：progress 模式按 stage `hardCapS`，
wallclock 模式按全局 180s。supervisor **不重复计时**，只消费策略表。
harness `--max-time` 仍是单轮双保险（ADR-0008）。

## Consequences

### 正面

- 合法的长 `develop` 不再被 180s 误杀；
- 两种故障形态都有归属：活进程静默由 supervisor，崩溃由 patrol；
- 每次干预都有证据事件，阈值可按真实 `silence_ms` / `last_kind` 校准；
- human 与无 `CAP-STREAM` 的 run 有明确豁免，且巡检不会误杀它们；
- `wallclock` 模式提供整模回退，不需要改 schema。

### 代价与边界

1. **阈值需要校准**：20m 的 `develop` 沉默阈值是起点，不是定论；
   过小会误杀长时间无输出的合法构建，过大会延迟干预。校准依据是
   `RunStalled` 事件里的真实 `silence_ms` / `last_kind`。
2. **遥测可丢**：`run_liveness` 写失败或丢失时，巡检方向是**不介入**，
   最终由硬上限兜底 —— 不会误杀，但干预会变慢。
3. **巡检依赖常驻 worker**：必须运行 `keel timer-worker --interval <ms>`；
   单次 drain 只跑一轮巡检，不会持续扫描。
4. **12h `develop` 会占并发槽位**：全局 3 个槽位之一可能被长期占用；
   v0.1 不做分池/抢占。
5. **孤儿 kill 是保守的**：PID/PGID 无法校验时选择不杀，宁可留下进程记录
   `orphan_alive`，也不冒误杀无关进程的风险。
6. **`wallclock` 模式的 human 仍受 180s 限制**：模式切换是显式选择，
   整体退回旧行为；human 豁免是 `progress` 模式的语义。

## 实现锚点

- `src/control/liveness/policy.ts` — 策略表、模式解析、墙钟优先级
- `src/control/liveness/supervisor.ts` — 进程内沉默监管
- `src/control/liveness/store.ts` — 有界队列遥测（`keel_control` 角色）
- `src/timer/patrol.ts` — 进程外巡检与孤儿清理
- `src/timer/worker.ts` — 常驻 drain 中挂 patrol（仅 progress 模式）
- `src/control/proposal/pipeline.ts` — `interrupt('stalled')` 与 fencing
- `src/control/orchestrator/loop.ts` — `RUN_STALLED` 映射与证据事件
- `migrations/1000000000007_run_liveness.sql` — `run_liveness` / `worker_health`

## 验证

- `src/control/liveness/policy.test.ts` — 策略、模式、优先级、human 豁免
- `src/control/liveness/supervisor.test.ts` — 沉默中断、owner 心跳、无信号降级
- `src/control/liveness/store.test.ts` — 节流、合并写、`silence_ms` 持久化
- `src/timer/patrol.test.ts` — 孤儿收割、幂等、human 跳过、PID 复用防护
- `src/e2e/session-pipeline.test.ts` — `stalled` vs `timeout` 分流
- `src/e2e/human-harness.test.ts` — human 超过旧 180s 不被中断
- `src/e2e/timer-worker.test.ts` — progress 模式挂巡检、wallclock 模式退回旧路径
