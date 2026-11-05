# 设计：运行巡检（Liveness by progress）

## 1. 边界与不变量

| 不变量 | 本设计的落点 |
|---|---|
| Execution 不直接写 Fact Plane | Adapter 只调用 `onProgress` 回调；`run_liveness` 由 `keel_control` 写 |
| Control Plane 可确定性重放 | 进展是遥测，不进 event；决策事件是 `RunStalled`，走 `driver.advance` |
| 转移函数是纯函数 | 不新增实时查询；`RunStalled` 复用 `stage_attempts` facts |
| 一个 Task 同时只有一个 RUNNING run | 沿用 `run_one_running_per_task` 部分唯一索引 |
| 人工与 AI 同一套规范，但人工不被机器时限误杀 | `human` harness 默认豁免沉默监管与硬上限 |
| 不新增常驻服务 | 巡检复用现有独立 timer worker 进程的常驻模式 |
| **已收割的 run 不能再写 Fact** | §4.8 围栏：成功状态与 artifact 同事务、失败路径检查 rowCount |

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
| **成功路径无围栏** | `src/control/orchestrator/loop.ts:525`、`src/control/proposal/pipeline.ts:195` | 收割后的 zombie 可提交 artifact、覆盖 `TIMEOUT`、提交工作区 |
| **失败路径不检查影响行数** | `src/control/orchestrator/loop.ts:824` | run 已被收割时仍 emit `RunFailed` / `RunTimeout` 并再次 advance |
| human 契约与执行不一致 | `src/execution/adapters/human.ts:70` vs `src/control/proposal/pipeline.ts:156` | 人工可能被 180s 打断（当前仅测试路径，接线后成立） |

## 3. 为什么必须是两层

一层解决不了两种失败：

| 失败模式 | 谁能干预 | 机制 |
|---|---|---|
| 编排进程活着，模型 / 工具静默 | 只有持有 `SessionHandle` 的编排进程 | 进程内 `StallSupervisor`：`interrupt('stalled')` |
| 编排进程崩溃 / 事件循环被同步阻塞 | 编排进程已不可信 | 独立 `Patrol`：DB 巡检 → 清理孤儿进程 → 标 `TIMEOUT` → `RunStalled` |

**所有权判据**：`run_liveness.owner_heartbeat_at`。

- 编排进程每 15s 续一次 owner 心跳（与模型进展无关）。
- 巡检只在 owner 心跳过期（默认 30s，即 2 个心跳周期）时介入。
- 这样不会出现「监管器刚要 interrupt，巡检同时把 run 标成 TIMEOUT」的双重处理。

> 这不是「用巡检代替进程内监管」，而是「进程内监管负责活进程，巡检负责孤儿 run + 孤儿进程」。

## 4. 组件与契约

### 4.0 Phase 0：实时 flush spike（实现前置门槛）

在写任何 supervisor / patrol 之前，先验证 OMP 是否在运行期间逐行输出：

- spawn `omp --mode=json`，给每行 stdout 打时间戳；
- 断言 `turn_start` / `message_update` / `turn_end` 在进程退出前到达，而不是集中在 `agent_end` 前；
- 记录一次真实长任务的到达间隔分布。

**分叉**：

- 实时到达 → 按本设计继续。
- 退出时一次性到达 → 停止本方案，改用 session 文件 mtime / 工具副作用 / 进程 CPU/IO 等进展源，重新评审后再实现。
- 无法判断 → 不进入实现；不要把「增量解析」当成默认成立。

**spike 结果（2026-11-05）**：实时到达已确认。`turn_start` 在 662ms、`tool_execution_start` 在 3503ms、
`sleep 4` 后 `tool_execution_end` 在 7562ms、`agent_end` 在 9704ms 到达；输出跨度 9166ms，
最大间隔 4059ms（工具执行期间）。详见 `research/flush-spike.md`。同时实测到 `tool_execution_*`
与 `message_update` 的嵌套事件，已纳入 §4.1。

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
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end'

export interface ProgressEvent {
  readonly kind: ProgressKind
  /** 控制面注入的时钟；parser 本身不读系统时钟 */
  readonly at: number
  readonly sessionRef?: string
  /** 仅首个事件携带；用于孤儿进程清理 */
  readonly pid?: number
  readonly pgid?: number
  /** 进程启动时间（ISO），与 pid 一起用于防 PID 复用误杀 */
  readonly startedAt?: string
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
- `message_update` 的嵌套类型（`thinking_*` / `toolcall_*` / `text_*`）都算进展；`tool_execution_*` 也算；
  `advisor_cost_changed` 不算。
- `end()` 必须与现有 `parseOmpStream` 的结果逐字段一致；用同一批真实样本做等价测试。
- 进程异常退出时，已经 `push` 出的进展事件不得丢失；`end()` 仍需返回已解析的 `ParsedRun`。
- **不得**因为引入增量解析而提前 `stdout.destroy()` / 关闭管道。

### 4.2 Adapter → Control 的进展通道

`onProgress` 加在**执行层** `SessionSpec`（`src/execution/session/manager.ts:56`），不是契约层 `src/contracts/session-manager.ts` 的 `SessionSpec`：

```ts
interface SessionProgressSink {
  onProgress?: (event: ProgressEvent) => void
}
```

- 契约层只描述 `CAP-STREAM` 能力，不引入函数字段 / 不可序列化字段。
- OMP adapter 在每个进展事件后调用；Claude adapter 本任务不接（无流式解析）。
- Human adapter 永不调用。
- **Adapter 不写 DB**；回调只把遥测交给控制面。
- `pid` / `pgid` / `startedAt` 只在首个事件携带；控制面把它写入 `run_liveness`，供巡检清理孤儿进程。
- `RunResult` 契约不变；`RUN_STALLED` 不由 adapter 产生（见 §4.6）。

### 4.3 liveness 存储

新增迁移 `migrations/1000000000007_run_liveness.sql`：

```sql
CREATE TABLE run_liveness (
  run_id             uuid PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  last_progress_at   timestamptz,
  progress_seq       bigint NOT NULL DEFAULT 0,
  last_kind          text,
  -- run 创建时确定的沉默阈值；NULL = 不做沉默判定（human / 无进展信号）
  silence_ms         int,
  owner_pid          int,
  owner_heartbeat_at timestamptz,
  harness_pid        int,
  harness_pgid       int,
  harness_started_at timestamptz,
  stall_reported_at  timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX run_liveness_owner_idx ON run_liveness (owner_heartbeat_at);
CREATE INDEX run_liveness_progress_idx ON run_liveness (last_progress_at);

CREATE TABLE worker_health (
  name         text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  last_error   text
);

GRANT SELECT, INSERT, UPDATE, DELETE ON run_liveness TO keel_control;
GRANT SELECT, INSERT, UPDATE ON worker_health TO keel_control;
-- 不授予 keel_execution；DELETE 仅供巡检 prune 终态行
```

Down migration 删除索引、表与授权，保证 `pnpm run db:reset` 可重建。

写入纪律：

- 进展 upsert：`progress_seq = progress_seq + 1`，`last_progress_at = now`，`last_kind = $kind`；节流 10s。
- owner 心跳：只更新 `owner_pid` / `owner_heartbeat_at`；节流 15s。
- 孤儿清理线索：首次进展事件写入 `harness_pid` / `harness_pgid` / `harness_started_at`。
- `silence_ms`：`supervisor.start` 时写一次，值取自本 run 生效的 policy（human / 无进展信号为 NULL）。
  巡检是独立进程，只能从 DB 知道「这个 run 该不该按沉默判定」——若按 stage 重算，
  会把 human run 当成卡死。写入失败只丢遥测，方向是「巡检不介入」，不会误杀。
- `stall_reported_at` 只由巡检 claim 写入。
- **写路径隔离**：使用独立连接或独立小 pool + 有界队列；写失败只记日志 / `worker_health`，不得让 Run 失败，也不得阻塞 stdout 的消费。
- **时钟**：进程内沉默计时用单调时钟；持久化用 DB `now()` 或注入的 `now`。
- **保留**：run 进入终态后保留 7 天，由巡检定期 prune；不要依赖 `ON DELETE CASCADE` 代替清理。
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

1. `start(handle)`：记录 `lastProgressAt = now()`；启动沉默检查定时器（间隔 `min(15s, silenceMs / 4)`）；同时启动 **owner 心跳定时器**（15s），与模型进展无关。
2. `noteProgress(event)`：更新内存 `lastProgressAt`；节流持久化到 `run_liveness`。
3. 每次检查：`now - lastProgressAt >= silenceMs` → `sessions.interrupt(handle, 'stalled')`，`onStall(evidence)`，停止检查。
4. **硬上限不在 supervisor 内重复计时**：继续由既有的 DB `wall_clock` timer 负责（进程崩溃后仍能收割）。supervisor 只消费 `LIVENESS_POLICY.hardCapS` 计算 run 创建时的 `wall_clock_s`，不另起一个 hard-cap 定时器。
5. `progressSource === 'none'` 或 human → 禁用沉默检查；owner 心跳仍要续（证明进程活着），硬上限仍由 `wall_clock` timer 承担（human 为 null 时不挂）。
6. `finally` 中清理沉默检查与 owner 心跳两个定时器，避免进程退出前残留。
7. **记录中断意图**：`interruptedBy: 'stalled' | null`。`runSessionUntilValid` 在拿到 `advance` 的 `RUN_TIMEOUT` 时，根据该意图返回 `RUN_STALLED` 或 `RUN_TIMEOUT`。adapter 不感知、不映射。

**为什么不是 watchdog 改成「无进展重置」就够**：如果没有巡检，编排进程崩溃时没人收割；如果没有进程内监管，巡检又无法中断活进程。两者职责不重叠。

### 4.5 独立 Patrol

`src/timer/patrol.ts`，由现有 timer worker 的**常驻** drain 循环调用（`keel timer-worker --interval`）：

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
       l.owner_heartbeat_at, l.harness_pid, l.harness_pgid,
       l.harness_started_at, l.silence_ms, r.started_at
FROM run_liveness l
JOIN run r ON r.id = l.run_id
WHERE r.status = 'RUNNING'
  AND l.stall_reported_at IS NULL
  AND (l.owner_heartbeat_at IS NULL
       OR l.owner_heartbeat_at < $now - $ownerGrace)
ORDER BY l.last_progress_at NULLS FIRST
LIMIT $limit
```

逐条用**行内** `silence_ms` 判断 `coalesce(last_progress_at, started_at) < now - silence_ms`；
`silence_ms IS NULL` 的 run 直接跳过（human / 无进展信号，不按沉默收割）。命中后：

1. **幂等 claim**：

```sql
UPDATE run_liveness
SET stall_reported_at = $now
WHERE run_id = $1 AND stall_reported_at IS NULL
```

2. **清理孤儿进程**（best-effort）：
   - 仅在 `harness_pid` / `harness_pgid` 存在且 `harness_pgid === harness_pid`（OMP 以 detached 进程组启动）时尝试；
   - 用 `ps -o lstart= -p <pid>` 校验启动时间与 `harness_started_at` 相差 ≤ 2s；不匹配则不杀（防 PID 复用误杀）；
   - 匹配则 `process.kill(-pgid, 'SIGTERM')`，5s 后仍存活则 `SIGKILL`；
   - 结果写入 `orphan_killed: boolean | null` 与 `worker_health.last_error`；
   - 平台不支持 / 无法校验 → 不杀，记录 `orphan_alive: null`，不要假装已清理。

3. **收割（带 RUNNING guard）**：

```sql
UPDATE run
SET status = 'TIMEOUT', error_kind = 'RUN_STALLED', ended_at = $now
WHERE id = $1 AND status = 'RUNNING'
```

4. `driver.advance(taskId, { type: 'RunStalled', stage }, now)`。
5. 写 `worker_health('patrol', now, null)`；异常写 `last_error`，不吞掉。
6. 定期 prune：删除终态 run 的 `run_liveness` 行（保留 7 天）。

**巡检不中断活 session**：它没有 `SessionHandle`；活进程的静默由 supervisor 负责。巡检只处理「owner 心跳已过期」的孤儿 run，并 best-effort 清理孤儿进程。

**围栏依赖**：巡检只把 DB 状态推进到终态；zombie 之后若再尝试提交，必须被 §4.8 的围栏挡住。没有 §4.8，本节不成立。

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
- **映射归属**：
  - supervisor 的 `interruptedBy='stalled'` → `runSessionUntilValid` 返回 `RUN_STALLED`；
  - 其他 `RUN_TIMEOUT`（含 `wall_clock` hard cap）→ `RUN_TIMEOUT`；
  - patrol 直接 `driver.advance(RunStalled)`，不经过 adapter；
  - adapter 的 `RunResult` 仍只有 `TIMEOUT`，不新增 reason。
- `loop.ts` 的结果映射：
  - `RUN_STALLED` → `{ type: 'RunStalled', stage }`，run 状态 `TIMEOUT`；
  - `RUN_TIMEOUT` → `{ type: 'RunTimeout', stage }`。
- **失败路径幂等**：`failRunAndAdvance` 的 `UPDATE ... WHERE id=$1 AND status='RUNNING'` 必须检查 `rowCount`；为 0 时返回 `'advanced'`（run 已由他人终结），不 emit、不 advance，也不能因为 `RUN_CANCELLED` 就返回 `'stopped-cancelled'`。

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
  实现上 `silenceMs: null` 是单一事实源，`progressSourceOf()` 派生出 `'none'`——不另存一份状态，避免两者漂移。
- human → `progressSource: 'none'`, `hardCapS: null`。
- 默认值集中一处；测试注入短值（毫秒级）。
- **优先级**：显式 `--wall-clock` 覆盖所有 stage 硬上限并打 warning；未指定时使用本表。`KEEL_LIVENESS_MODE=wallclock` 时回到旧的全局 `wallClockS`。
- **并发**：全局 `DEFAULT_MAX_RUNNING_RUNS = 3` 不变；12h `develop` 占一个槽位。本任务不实现分池，文档写明后果。

### 4.8 Run 状态围栏（Fencing）

巡检把 run 标成 `TIMEOUT` 后，原进程仍可能继续运行并返回成功。必须在**成功写入 Fact 的同一事务**里完成围栏：

1. **artifact 提交事务**（`pipeline.ts`）：
   - 先执行 `validateProposal`（只读）。**校验不通过时不得触碰 run 状态**——`asRole` 在正常返回时也会 COMMIT，任何提前写入都会被提交。
   - 校验通过后，校验 `proposal.produced_by_run === spec.runSpec.run.run_id` 且 `proposal.task_id === spec.runSpec.run.task_id`；
   - 执行 `UPDATE run SET status='SUCCEEDED', ended_at=$now WHERE id=$runId AND status='RUNNING'`；
   - `rowCount === 0` → 事务内不写任何东西，返回**围栏失败错误**（按当前 run 状态映射 `RUN_TIMEOUT` / `RUN_CANCELLED`），不得插入 `ProposalAccepted`、不得提交 artifact。**不要**把它当成 `violations` 回灌给模型——run 已终态，重试没有意义。
   - 只有 update 成功后才插入事件与 artifact。
2. **提交前闸门**（`PipelineOptions.preCommitGate`）：
   - 阶段专属成功条件（当前只有 develop 空 diff）必须在 `validateProposal` + 归属校验之后、上面的 `UPDATE run ... SUCCEEDED` 之前执行；
   - 闸门返回错误时整个 run 失败，run 仍为 `RUNNING`，由调用方 `failRunAndAdvance` 落终态；
   - **不得**把这类判定留在 pipeline 返回之后：那时 run 已 SUCCEEDED、artifact 已提交，闸门失败只能变成假成功；
   - 现状：`loop.ts` 的 develop 空 diff 检查移入该回调，pipeline 不感知 stage 语义。
3. **循环侧元数据更新**（`loop.ts` 成功路径）：
   - 只更新 usage / harness / tier / cost 等元数据；
   - 带 `WHERE id=$1 AND status='SUCCEEDED'` guard；
   - `rowCount === 0` → 视为围栏失败，不得继续 `commitAll`。
4. **失败路径**（`loop.ts:802`）：
   - `UPDATE ... WHERE id=$1 AND status='RUNNING'` 后检查 `rowCount`；
   - 为 0 → 直接返回，不 emit `RunFailed` / `RunTimeout`，不 `driver.advance`。
5. **`commitAll` 顺序**：
   - 只在 run 已成功落入终态后调用；
   - 围栏失败时不得提交工作区。
6. **测试调用点审计**：
   - `src/acceptance/session-milestone.acceptance.test.ts:95`、`src/e2e/session-pipeline.test.ts:258/332/360` 直接调用 `runSessionUntilValid`；
   - 实现时必须确认这些用例都有对应的 `RUNNING` run 行，或显式提供测试夹具；不得用「跳过围栏」的开关绕过。

**取舍说明**：把 `SUCCEEDED` 的写入从 loop 移到 pipeline 的事务里，会让 pipeline 承担一点 run 生命周期职责。但这是唯一能在「artifact 写入」与「run 终态」之间不留窗口的最小做法；否则巡检可以在两者之间收割，留下「artifact 已提交、run 却 TIMEOUT」的半截事实。

### 4.9 长任务载体与巡检健康

- **载体**：本任务不新增常驻执行器。10h `develop` 的推荐载体是外部 supervisor（tmux / systemd）下的 `keel run-task`；`keel poller` 也可用，但 `runIssue` 是串行 await，一个长 issue 会阻塞后续轮询。PRD 已明确：本任务不承诺 10h 无人值守。
- **巡检常驻**：`keel timer-worker --interval <ms>` 必须常驻；单次 drain 不构成巡检。
- **健康**：`worker_health('patrol', last_seen_at, last_error)`；healthz / console 读取；超过 2 个扫描周期未更新 → 异常。
- **测试**：patrol 的单元 / 集成测试注入短间隔，不依赖真实 30s。

## 5. 数据流

```
OMP stdout (NDJSON)
  └─ OmpStreamParser.push(chunk) ── ProgressEvent[]
       ├─ StallSupervisor.noteProgress()          // 进程内，重置沉默计时
       └─ LivenessStore.recordProgress()          // 独立连接 / 有界队列，节流写 run_liveness
                │
                ├─ 进程活着 + 静默 ≥ threshold
                │     └─ sessions.interrupt('stalled')
                │          └─ supervisor 记录 interruptedBy='stalled'
                │               └─ pipeline 返回 RUN_STALLED
                │                    └─ loop: run TIMEOUT/RUN_STALLED → RunStalled
                │
                └─ owner 心跳过期（编排器崩溃）
                      └─ Patrol claim
                           ├─ best-effort kill 孤儿进程（pgid + 启动时间校验）
                           ├─ run TIMEOUT/RUN_STALLED
                           └─ RunStalled 事件
                                 │
                       T-030 / T-031 ──┤
                          ├─ 未达上限 → 同 stage 新 run
                          └─ 达上限 → S-HUMAN_REVIEW
```

## 6. 关键取舍

1. **进展是遥测，不是 Fact**。每个 token 都落 event 会污染事件流并放大写负载；liveness 只需支撑「是否还在动」的判断。决策仍由 `RunStalled` 事件承载。
2. **复用 `TIMEOUT` 状态，不扩 `RunStatus`**。语义区分交给 `error_kind`；避免 schema / 索引 / 消费方连锁改动。
3. **复用 `T-030` / `T-031`，不新增转移**。重试与升人工的行为相同；事件类型已能区分原因。
4. **巡检不中断活 session，但清理孤儿进程**。活进程由 supervisor 处理；巡检面对的是 owner 已死的孤儿，kill 是防止其继续改工作区 / 烧 token 的必要动作。PID 复用用启动时间校验防误杀。
5. **human 不设默认上限**。人等几小时不是卡死；要限制就显式配置，而不是把机器时限套在人身上。
6. **12h `develop` 硬上限是时间兜底，不是成本控制**。`budget_usd` 仍为 null；成本预算需要单独的任务。
7. **不做 checkpoint / resume**。契约里有，但控制面未接线（ADR-0003 仍 Proposed）；本任务的重试是 rematerialize。
8. **围栏必须与巡检同批落地**。没有 §4.8，巡检会把已有竞态放大成脏 Fact；不允许先上巡检、后补围栏。

## 7. 兼容与回滚

- 迁移纯增量：新表 + 新索引 + GRANT + Down，不改现有列。
- 旧 run 无 liveness 行 → 视为 `progressSource: 'none'`，走墙钟兜底。
- `KEEL_LIVENESS_MODE=wallclock`：禁用 supervisor 与 patrol，退回旧路径；默认 `progress`。
- 无 `CAP-STREAM` 的 adapter 自动降级，不需要改调用方。
- `RunResult` / `RunStatus` / Artifact schema 不变。
- 回滚点：
  1. phase 0 spike + 围栏（不改调度语义，可单独回滚）；
  2. 增量解析 + 进展回调（不影响调度）；
  3. liveness 表 + supervisor；
  4. patrol + `RunStalled` 转移。
  任一步失败可停在前一步；围栏是其他步骤的前置，不得回滚。

## 8. 风险与未决

| 风险 | 处理 |
|---|---|
| OMP 退出时才 flush | phase 0 spike 必须先证明；否则换进展源并重新评审 |
| 长 thinking 期间没有文本事件导致误判 | 用 `turn_start` / `message_update` / `turn_end` 而非纯文本作为进展；阈值按 stage 放大 |
| 心跳写放大 / 抢连接 | 独立连接 + 有界队列 + 合并写；失败只记日志 |
| 巡检自身死掉 | `worker_health` + healthz；连续两轮未更新即异常 |
| 编排进程事件循环被同步阻塞 | owner 心跳会停；巡检按孤儿 run 处理 |
| 孤儿进程继续改工作区 | patrol best-effort kill + 启动时间校验；无法 kill 时记录 `orphan_alive`，不静默 |
| PID 复用误杀 | `ps -o lstart=` 与 `harness_started_at` 比对，容差 2s；不匹配不杀 |
| 12h `develop` 与并发 3 互相挤压 | 文档写明；本任务不改调度；需要更多长任务并发时另立任务 |
| 测试直接调用 pipeline 无 run 行 | 审计 4 个调用点，补夹具；不提供绕过围栏的开关 |
| pipeline 成功与 loop 元数据分两个事务 | 若 loop 元数据事务失败，run 已 `SUCCEEDED` + artifact 已提交，但 usage / diff 未落。记录错误并允许重试元数据；不得回滚已提交 artifact。此窗口远小于原竞态，且不产生脏 Fact。 |
| 默认阈值拍脑袋 | 先按上表落地，记录 `RunStalled` 的真实触发；用数据校准，不在本任务反复调参 |

## 9. 文档同步

- 新增 `docs/adr/0009-liveness-by-progress.md`（Accepted 前先 Proposed）。
- 更新 `docs/04-state-machine.md` §4/§6：Run 状态说明、`RunStalled`、两层检测、每 stage 默认值、event 单元格手工同步。
- 更新 `docs/05-contracts/harness-adapter.md`：`onProgress`（执行层）、`interrupt('stalled')`、`CloseReason`；明确 `RunResult` 不变。
- 更新 `docs/05-contracts/README.md`：`RUN_STALLED` 错误矩阵。
- 更新 `docs/08-cross-cutting.md` §3.4：liveness 与 budget 分离；长任务并发后果。
- 更新 `docs/adr/README.md` 索引。
- 文档写明 `timer-worker --interval` 的常驻前提与 `--wall-clock` 的覆盖语义。
