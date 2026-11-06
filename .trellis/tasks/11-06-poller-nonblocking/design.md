# 设计：poller 扫描与驱动解耦

> 对应 `prd.md`。目标是让轮询节奏不再由最慢的 run 决定，同时保持单实例、幂等与可诊断性。

## 1. 现状与问题

```
runPollerForever
  └─ pollOnce
       ├─ scan repos / issues
       └─ for each issue: await deps.runIssue(...)   ← 阻塞点，直到 run 到 stop point
  └─ sleep(interval)
```

后果：

- 同轮其余 issue 必须等前一个 run 结束；
- 下一轮扫描必须等本轮所有驱动结束，`--interval` 失去意义；
- 全局 3 个 RUNNING 槽位实际只用上 1 个。

## 2. 目标结构

```
runPollerForever
  ├─ scanOnce(deps)                 ← 只扫描，返回 DriveRequest[]，立即返回
  ├─ scheduler.schedule(req) × N    ← 有界并发，跨轮共享 in-flight 集合
  ├─ log(poll round)                ← scheduled / deferred / inFlight
  ├─ sleep(interval)                ← 与驱动时长无关
  └─ on SIGTERM: stop scheduling → scheduler.drain() → exit
```

### 2.1 为什么不选另外两种

| 方案 | 结论 | 理由 |
|---|---|---|
| 轮内并发、仍 await 全部 | 否决 | 轮次仍被最慢 run 卡住，`--interval` 依旧失效；只解决同轮排队 |
| 无界后台驱动 | 否决 | 超过 N4 的驱动会在 claim 时反复 `CONFLICT`，日志噪音且没有收益 |
| 内存工作队列 | 否决 | 队列会成为第二份待办状态，与「每轮重扫 + feedback 唯一键」的幂等来源冲突 |
| **扫描/驱动解耦 + 在途集合** | 采用 | 最小机制：不新增状态存储，只把「正在驱动」这一瞬态放进内存 |

## 3. 模块与契约

### 3.1 扫描：`scanOnce`

```ts
interface ScanStats {
  repos: number
  scanned: number
  skipped: number       // 终态 task + 本轮重复 external_ref
  errors: number        // repo 级扫描失败
  truncated: boolean
}

interface DriveRequest {
  externalRef: string   // owner/repo#n，调度器去重键
  input: PollIssueInput
}

interface ScanRoundResult {
  stats: ScanStats
  drives: readonly DriveRequest[]
  stopped: boolean
}

async function scanOnce(deps: PollerDeps, opts?: PollOnceOptions): Promise<ScanRoundResult>
```

- 保持现有扫描顺序：repo（`created_at, id`）→ issue 列表顺序。
- 保持现有 `shouldStop` 检查点（每个 repo、每个 issue 之前）。
- 保持现有 `repo_error` 日志与脱敏。
- **不调用** `runIssue`，不做终态之外的状态推断。

### 3.2 调度器：`createDriveScheduler`

```ts
type ScheduleOutcome = 'scheduled' | 'in_flight' | 'at_capacity' | 'stopped'

interface DriveScheduler {
  schedule(req: DriveRequest): ScheduleOutcome
  readonly inFlight: number
  drain(): Promise<void>
  takeFatal(): unknown
}

function createDriveScheduler(
  deps: PollerDeps,
  opts: { concurrency: number; shouldStop?: () => boolean; onFatal?: () => void },
): DriveScheduler
```

行为：

- `inFlight: Set<externalRef>`，同时作为「正在跑」的计数上限来源。
- `schedule`：
  1. `shouldStop()` → `'stopped'`（不启动新驱动）；
  2. ref 已在 `inFlight` → `'in_flight'`；
  3. `inFlight.size >= concurrency` → `'at_capacity'`；
  4. 否则加入集合并启动 `deps.runIssue(input)`（不 await）。
- 驱动完成：
  - `ok` → `log({ event: 'issue_driven', ref, created })`；
  - `err` → `log({ event: 'issue_error', ref, kind, detail })`，detail 走现有 `safeDetail`；
  - 抛异常 → 记录首个 fatal（后续 fatal 只保留第一个），`onFatal()`（请求停止），
    不再启动新驱动。
- `drain()`：等待 `inFlight` 清空；空集合时立即 resolve。
- `takeFatal()`：取出并清空 fatal，供常驻循环抛出。

**并发安全**：调度器只做进程内节流；真正的并发事实仍由 `claimRunForExecution`
（N3 乐观锁 + N4 全局上限 + `run_one_running_per_task` 唯一索引）保证。调度器不读数据库。

### 3.3 常驻循环：`runPollerForever`

```ts
interface RunPollerForeverOptions {
  intervalMs?: number
  signals?: PollerSignalSource
  sleep?: (ms: number, stop: StopToken) => Promise<void>
  stopToken?: StopToken
  concurrency?: number   // 缺省 DEFAULT_DRIVE_CONCURRENCY = 3
}
```

流程：

```
while (!stop.requested):
  round = scanOnce(shouldStop)
  for req of round.drives:
    if stop.requested: break
    switch scheduler.schedule(req):
      'scheduled'  → scheduled += 1
      'at_capacity'→ deferred += 1
      _            → skipped += 1
  log({ event:'poll', ...round.stats, scheduled, deferred, inFlight, stopped })
  if stop.requested: break
  await sleep(intervalMs, stop)

finally: 反注册信号; await scheduler.drain()
fatal = scheduler.takeFatal(); if (fatal) throw fatal
log({ event:'poller', state:'stopped' })
```

- fatal 通过 `onFatal` 请求停止，能立刻叫醒 `interruptibleSleep`；在途驱动收尾后抛出。
- `drain()` 放在 `finally`：即使扫描/日志抛错，也不留下未收尾的驱动 promise。

### 3.4 兼容层：`pollOnce`

`pollOnce` 改为「`scanOnce` + 顺序 await」：

```ts
const scan = await scanOnce(deps, opts)
for (const req of scan.drives) {
  if (opts.shouldStop?.()) { stopped = true; break }
  const driven = await deps.runIssue(req.input)
  ...aggregate driven / ingested / errors...
}
log({ event: 'poll', ...stats, stopped })
```

这样既有 12 个行为测试（label 透传、终态跳过、失败隔离、脱敏、轮内去重、停止信号）全部继续有效，
同时把扫描逻辑收敛到一处。

### 3.5 CLI：`src/cli/poller.ts`

- 新 flag：`--concurrency <n>`。
- `parseConcurrency(raw)`：
  - 省略 → `DEFAULT_MAX_RUNNING_RUNS`（3）；
  - 正整数且 `<= DEFAULT_MAX_RUNNING_RUNS` → 通过；
  - 其他 → `CAPABILITY_UNSUPPORTED`，文案说明全局上限与调整方式。
- 从 `../control/concurrency/limits.js` 引入 `DEFAULT_MAX_RUNNING_RUNS` 作为唯一事实来源；
  传给 `runPollerForever({ concurrency })`。
- HELP 增加一行；不新增环境变量。

## 4. 日志契约

| event | 字段 | 说明 |
|---|---|---|
| `poll`（常驻） | `repos, scanned, skipped, errors, truncated, scheduled, deferred, inFlight, stopped` | 每轮扫描一行；`scheduled` 为本轮启动的驱动数，不再承诺完成数 |
| `poll`（`pollOnce`） | 原字段 `repos, scanned, ingested, driven, skipped, errors, truncated, stopped` | 兼容保留 |
| `issue_driven` | `ref, created` | 每个驱动成功一行 |
| `issue_error` | `ref, kind, detail` | 驱动失败；detail 脱敏 |
| `repo_error` | `repo, label, kind, detail` | 扫描失败；不变 |
| `poller` | `state: 'stopped'` | 仅正常退出打印；fatal 退出不打印，直接抛出 |

## 5. 错误矩阵

| 条件 | 结果 |
|---|---|
| 单 issue 驱动返回 `err` | `issue_error`，`issue_error` 计数？不新增全局计数；不影响其它在途驱动 |
| 单 repo 列出失败 | 现有 `repo_error`，继续下一个 repo |
| 驱动抛异常 | 记 fatal → 请求停止 → 等在途收尾 → 抛出 |
| 调度时已达并发上限 | `deferred += 1`，下一轮重扫 |
| 同一 ref 已在途 | `in_flight`，计入 `skipped`，不重复驱动 |
| SIGTERM 在扫描中 | 当前 repo/issue 后停止收集；已开始的驱动继续 |
| SIGTERM 在 sleep 中 | `interruptibleSleep` 立即返回；进入 drain |
| 非法 `--concurrency` | 启动期拒绝，退出码 1，零副作用 |

## 6. 兼容性与回滚

- `pollOnce`、`StopToken`、`interruptibleSleep` 的公开签名不变；仅新增导出。
- 常驻路径的 `poll` 日志字段变化已在 README 与 spec 中同步，属于行为契约变更。
- 单提交即可回滚：回滚后 `runPollerForever` 回到顺序 `pollOnce`，不涉及数据库迁移。
- 无 schema / migration 变更。

## 7. 验证策略

- 单测（不碰数据库）：
  - `scanOnce` 经 `pollOnce` 既有 12 例覆盖；
  - 调度器：并发上限、in-flight 去重、drain、fatal；
  - 常驻循环：慢驱动不阻塞后续轮扫描、SIGTERM 不调度且 drain、失败隔离、fatal 抛出；
- CLI 单测：`parseConcurrency` 拒绝矩阵、缺省值、透传；
- 全量：`pnpm run check`（63+ 文件，924+ 用例）。
- 反例验证：逐条回退关键修复，确认对应测试先红后绿。
