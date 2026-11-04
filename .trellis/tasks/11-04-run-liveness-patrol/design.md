# 设计：运行巡检（Liveness by progress）

## 1. 边界与不变量

| 不变量 | 本设计的落点 |
|---|---|
| Execution 不直接写 Fact Plane | Adapter 只调用 `onProgress` 回调；`run_liveness` 由 `keel_control` 写 |
| Control Plane 可确定性重放 | 进展是遥测，不进 event；决策事件是 `RunStalled`，走 `driver.advance` |
| 转移函数是纯函数 | 不新增实时查询；`RunStalled` 复用 `stage_attempts` facts |
| 一个 Task 同时只有一个 RUNNING run | 沿用 `run_one_running_per_task` 部分唯一索引 |
| 人工与 AI 同一套规范，但人工不被机器时限误杀 | `human` harness 默认豁免沉默监管与硬上限 |
| 不新增常驻服务 | 巡检复用现有独立 timer worker 进程 |

**关键语义划分**：

- **liveness**：是否还在产出进展 → 沉默监管 / 巡检。
- **budget**：允许跑多久、花多少 → 每 stage 硬上限（本任务）/ 成本预算（后续）。

两者不再共用一个数字。

## 2. 现状缺口

| 缺口 | 代码锚点 | 后果 |
|---|---|---|
| 总时长是唯一 liveness 信号 | `src/control/orchestrator/loop.ts:427` | 长任务被误杀；hung 与长跑不可区分 |
| OMP 流是「假流式」 | `src/execution/adapters/omp.ts:234` | 运行期间控制面看不到任何事件 |
| 超时丢弃 partial output / session | `src/execution/adapters/omp.ts:226` | 重试只能从零开始 |
| 没有 session resume | `src/control/transition/table.ts:161` | 重试成本高，长任务尤其明显 |
| 没有心跳 / liveness 表 | `migrations/` 无相关表 | 巡检没有判据 |
| human 契约与执行不一致 | `src/execution/adapters/human.ts:70` vs `src/control/proposal/pipeline.ts:156` | 人工可能被 180s 打断 |

## 3. 为什么必须是两层

一层解决不了两种失败：

| 失败模式 | 谁能干预 | 机制 |
|---|---|---|
| 编排进程活着，模型 / 工具静默 | 只有持有 `SessionHandle` 的编排进程 | 进程内 `StallSupervisor`：`interrupt('stalled')` |
| 编排进程崩溃 / 事件循环被同步阻塞 | 编排进程已不可信 | 独立 `Patrol`：DB 巡检 → 标 `TIMEOUT` → `RunStalled` |

**所有权判据**：`run_liveness.owner_heartbeat_at`。

- 编排进程每 15s 续一次 owner 心跳（与模型进展无关）。
- 巡检只在 owner 心跳过期（默认 30s，即 2 个心跳周期）时介入。
- 这样不会出现「监管器刚要 interrupt，巡检同时把 run 标成 TIMEOUT」的双重处理。

> 这不是「用巡检代替进程内监管」，而是「进程内监管负责活进程，巡检负责孤儿 run」。

## 4. 组件与契约

### 4.1 增量 OMP 解析器

`src/execution/adapters/omp-parse.ts` 增加有状态解析器，保留现有纯函数作为最终结果：

```ts
export type ProgressKind =
  | 'session'
  | 'agent_start'
  | 'turn_start'
  | 'message_update'
  | 'turn_end'
  | 'agent_end'

export interface ProgressEvent {
  readonly kind: ProgressKind
  /** 控制面注入的时钟；parser 本身不读系统时钟 */
  readonly at: number
  readonly sessionRef?: string
}

export class OmpStreamParser {
  /** 只消费完整行；返回本 chunk 产生的进展事件 */
  push(chunk: string): ProgressEvent[]
  /** 冲刷残留行，返回与 parseOmpStream(fullStdout) 等价的 ParsedRun */
  end(): ParsedRun
}
```

实现要点：

- 维护行缓冲；`\n` 之前不解析，避免半行 JSON。
- 非 JSON 行继续进 `nonJsonLines`，不因流式化丢失错误信息。
- `message_update` 在 adapter 层合并（默认 250ms 一次回调），避免每个 token 触发控制面。
- `end()` 必须与现有 `parseOmpStream` 的结果逐字段一致；用同一批真实样本做等价测试。

### 4.2 Adapter → Control 的进展通道

在 `SessionSpec`（或 `open` 的 options）增加可选回调：

```ts
interface SessionProgressSink {
  onProgress?: (event: ProgressEvent) => void
}
```

- OMP adapter 在每个进展事件后调用；Claude adapter 本任务不接（无流式解析）。
- Human adapter 永不调用。
- **Adapter 不写 DB**；回调只把遥测交给控制面。

### 4.3 liveness 存储

新增迁移 `migrations/1000000000007_run_liveness.sql`：

```sql
CREATE TABLE run_liveness (
  run_id             uuid PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  last_progress_at   timestamptz,
  progress_seq       bigint NOT NULL DEFAULT 0,
  last_kind          text,
  owner_pid          int,
  owner_heartbeat_at timestamptz,
  stall_reported_at  timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX run_liveness_owner_idx ON run_liveness (owner_heartbeat_at);
CREATE INDEX run_liveness_progress_idx ON run_liveness (last_progress_at);

CREATE TABLE worker_health (
  name        text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  last_error  text
);
```

写入纪律：

- 进展 upsert：`progress_seq = progress_seq + 1`，`last_progress_at = now`，`last_kind = $kind`；节流 10s。
- owner 心跳：只更新 `owner_pid` / `owner_heartbeat_at`；节流 15s。
- `stall_reported_at` 只由巡检 claim 写入。
- 所有写入走 `keel_control`；`run_liveness` 不授予 Execution 角色。

### 4.4 进程内 StallSupervisor

`src/control/liveness/supervisor.ts`：

```ts
interface LivenessPolicy {
  readonly silenceMs: number
  readonly hardCapS: number | null   // null = 无硬上限（human）
  readonly progressSource: 'stream' | 'none'
}

interface StallSupervisorDeps {
  readonly sessions: SessionManager
  readonly policy: LivenessPolicy
  readonly now: () => number
  readonly onProgress: (event: ProgressEvent) => void
  readonly onStall: (evidence: StallEvidence) => void
}
```

行为：

1. `start(handle)`：记录 `lastProgressAt = now()`；启动检查定时器（间隔 `min(15s, silenceMs / 4)`）。
2. `noteProgress(event)`：更新内存 `lastProgressAt`；节流持久化到 `run_liveness`。
3. 每次检查：`now - lastProgressAt >= silenceMs` → `sessions.interrupt(handle, 'stalled')`，`onStall(evidence)`，停止检查。
4. 硬上限独立计时：到达 `hardCapS` → `interrupt(handle, 'timeout')`，走原有 `RunTimeout` 语义。
5. `progressSource === 'none'` 或 human → 禁用沉默检查；只保留硬上限（human 为 null）。
6. `finally` 中清理定时器，避免进程退出前残留。

**为什么不是 watchdog 改成「无进展重置」就够**：如果没有巡检，编排进程崩溃时没人收割；如果没有进程内监管，巡检又无法中断活进程。两者职责不重叠。

### 4.5 独立 Patrol

`src/timer/patrol.ts`，由现有 timer worker 的 drain 循环调用（或独立循环）：

```ts
interface PatrolDeps {
  readonly driver: WorkflowDriver
  readonly now: () => string
  readonly ownerGraceMs: number      // 默认 30_000
  readonly scanLimit: number         // 默认 50
}

export async function patrolStalledRuns(deps: PatrolDeps): Promise<PatrolStats>
```

扫描（候选集只读）：

```sql
SELECT l.run_id, r.task_id, r.stage, l.last_progress_at, l.last_kind,
       l.owner_heartbeat_at, r.started_at
FROM run_liveness l
JOIN run r ON r.id = l.run_id
WHERE r.status = 'RUNNING'
  AND l.stall_reported_at IS NULL
  AND (l.owner_heartbeat_at IS NULL
       OR l.owner_heartbeat_at < $now - $ownerGrace)
ORDER BY l.last_progress_at NULLS FIRST
LIMIT $limit
```

逐条用 stage policy 判断 `coalesce(last_progress_at, started_at) < now - silenceMs`；命中后：

1. 幂等 claim：

```sql
UPDATE run_liveness
SET stall_reported_at = $now
WHERE run_id = $1 AND stall_reported_at IS NULL
```

2. 收割（带 RUNNING guard，沿用 `reapTimeoutRun` 模式）：

```sql
UPDATE run
SET status = 'TIMEOUT', error_kind = 'RUN_STALLED', finished_at = $now
WHERE id = $1 AND status = 'RUNNING'
```

3. `driver.advance(taskId, { type: 'RunStalled', stage }, now)`。
4. 写 `worker_health('patrol', now, null)`；异常写 `last_error`，不吞掉。

**不直接 kill**：巡检可能面对一个仍然活着的进程（例如事件循环短暂阻塞）。它只把 DB 状态推进到终态；进程恢复后若再尝试提交，会撞到 `status='RUNNING'` guard / 幂等键，不会写脏 Fact。

### 4.6 事件、转移与错误

```ts
// src/control/transition/types.ts
| { readonly type: 'RunStalled'; readonly stage: Stage }
```

- `T-030` / `T-031` 的 `on` 加入 `'RunStalled'`；guard 不变：
  - `stage_attempts < max_stage_attempts` → `SELF` + `nextRun('SAME')`
  - `stage_attempts >= max_stage_attempts` → `S-HUMAN_REVIEW`
- 不新增转移 ID：事件类型已能区分「失败 / 超预算 / 无进展」，转移行为相同。
- `InterruptReason` 增加 `'stalled'`；`CloseReason` 增加 `'stalled'`。
- `ERROR_KINDS` 增加 `RUN_STALLED`，`retryable: true`；docs 错误矩阵同步。
- Run 状态继续用 `TIMEOUT`：新增 `STALLED` 会牵动 schema / 索引 / 所有消费方，收益只是语义标签；`error_kind` 已足够区分。
- `loop.ts` 的结果映射：
  - `RUN_STALLED` → `{ type: 'RunStalled', stage }`
  - `RUN_TIMEOUT` → `{ type: 'RunTimeout', stage }`

### 4.7 每 stage 策略

`src/control/liveness/policy.ts`：

```ts
export const LIVENESS_POLICY: Record<Stage, LivenessPolicy> = {
  pm:         { silenceMs: 5 * 60_000,  hardCapS: 30 * 60,       progressSource: 'stream' },
  brainstorm: { silenceMs: 10 * 60_000, hardCapS: 2 * 3600,      progressSource: 'stream' },
  critic:     { silenceMs: 10 * 60_000, hardCapS: 2 * 3600,      progressSource: 'stream' },
  rfc_draft:  { silenceMs: 10 * 60_000, hardCapS: 2 * 3600,      progressSource: 'stream' },
  develop:    { silenceMs: 20 * 60_000, hardCapS: 12 * 3600,     progressSource: 'stream' },
  qa:         { silenceMs: 10 * 60_000, hardCapS: 2 * 3600,      progressSource: 'stream' },
  review:     { silenceMs: 10 * 60_000, hardCapS: 2 * 3600,      progressSource: 'stream' },
}
```

- 无 `CAP-STREAM` → 运行时把 `progressSource` 降为 `'none'`；只保留 `hardCapS`。
- human → `progressSource: 'none'`, `hardCapS: null`。
- 默认值集中一处；测试注入短值（毫秒级）。

## 5. 数据流

```
OMP stdout (NDJSON)
  └─ OmpStreamParser.push(chunk) ── ProgressEvent[]
       ├─ StallSupervisor.noteProgress()          // 进程内，重置沉默计时
       └─ LivenessStore.recordProgress()          // 节流写 run_liveness
                │
                ├─ 进程活着 + 静默 ≥ threshold
                │     └─ sessions.interrupt('stalled')
                │          └─ adapter 返回 TIMEOUT → RUN_STALLED → RunStalled 事件
                │
                └─ owner 心跳过期（编排器崩溃）
                      └─ Patrol claim → run TIMEOUT/RUN_STALLED → RunStalled 事件
                                                          │
                                        T-030 / T-031 ────┤
                                           ├─ 未达上限 → 同 stage 新 run
                                           └─ 达上限 → S-HUMAN_REVIEW
```

## 6. 关键取舍

1. **进展是遥测，不是 Fact**。每个 token 都落 event 会污染事件流并放大写负载；liveness 只需支撑「是否还在动」的判断。决策仍由 `RunStalled` 事件承载。
2. **复用 `TIMEOUT` 状态，不扩 `RunStatus`**。语义区分交给 `error_kind`；避免 schema / 索引 / 消费方连锁改动。
3. **复用 `T-030` / `T-031`，不新增转移**。重试与升人工的行为相同；事件类型已能区分原因。
4. **巡检不 kill**。它没有 `SessionHandle`；杀进程必须由持有句柄的编排进程做。巡检只负责孤儿 run。
5. **human 不设默认上限**。人等几小时不是卡死；要限制就显式配置，而不是把机器时限套在人身上。
6. **12h `develop` 硬上限是时间兜底，不是成本控制**。`budget_usd` 仍为 null；成本预算需要单独的任务。
7. **不做 checkpoint / resume**。契约里有，但控制面未接线（ADR-0003 仍 Proposed）；本任务的重试是 rematerialize。

## 7. 兼容与回滚

- 迁移纯增量：新表 + 新索引，不改现有列。
- 旧 run 无 liveness 行 → 视为 `progressSource: 'none'`，走墙钟兜底。
- `KEEL_LIVENESS_MODE=wallclock`：禁用 supervisor 与 patrol，退回旧路径；默认 `progress`。
- 无 `CAP-STREAM` 的 adapter 自动降级，不需要改调用方。
- 回滚点：
  1. 只上增量解析 + 进展回调（不影响调度）；
  2. 再上 liveness 表 + supervisor；
  3. 最后上 patrol + `RunStalled` 转移。
  任一步失败可停在前一步，不需要回滚数据库。

## 8. 风险与未决

| 风险 | 处理 |
|---|---|
| 长 thinking 期间没有文本事件导致误判 | 用 `turn_start` / `message_update` / `turn_end` 而非纯文本作为进展；阈值按 stage 放大 |
| 心跳写放大 | 进展 10s / owner 15s 节流；adapter 层再合并 `message_update` |
| 巡检自身死掉 | `worker_health` + healthz 展示；连续两轮未更新即视为异常 |
| 编排进程事件循环被同步阻塞 | owner 心跳会停；巡检按孤儿 run 处理 |
| 12h `develop` 成本不可控 | 明确标注为时间兜底；成本预算另立任务；先观察真实分布再调 |
| 多编排进程竞争 | 本任务只保证单编排进程；`owner_pid` / 心跳为未来租约留了字段，但不实现分布式租约 |
| 默认阈值拍脑袋 | 先按上表落地，记录 `RunStalled` 的真实触发；用数据校准，不在本任务反复调参 |

## 9. 文档同步

- 新增 `docs/adr/0009-liveness-by-progress.md`（Accepted 前先 Proposed）。
- 更新 `docs/04-state-machine.md` §4/§6：Run 状态说明、`RunStalled`、两层检测、每 stage 默认值。
- 更新 `docs/05-contracts/harness-adapter.md`：`onProgress`、`interrupt('stalled')`、`CloseReason`。
- 更新 `docs/05-contracts/README.md`：`RUN_STALLED` 错误矩阵。
- 更新 `docs/08-cross-cutting.md` §3.4：liveness 与 budget 分离。
- 更新 `docs/adr/README.md` 索引。
