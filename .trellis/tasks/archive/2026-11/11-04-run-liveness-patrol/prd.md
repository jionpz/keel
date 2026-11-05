# 运行巡检：按进展信号判定卡死并干预

## Goal

把「卡死判定」从**总时长墙钟**改为**进展信号 + 定期巡检**：

- 只要 Run 还在产出可观测的进展，就允许它继续跑；`develop` 可以跑到小时级。
- 只有「无进展」才判卡死，并按干预梯度处理。
- 墙钟退回**显式预算 / 无进展信号时的兜底**，不再承担 liveness 语义。
- 巡检同时负责**孤儿 run**：编排进程崩溃后，DB 里留下的 `RUNNING` 不能永久卡住 Task。

一句话：**卡死不是「跑了多久」，而是「多久没有新进展」。**

## Background

现状的结构性缺口：

1. **liveness 只有总时长一个数字**。`wallClockS = deps.wallClockS ?? 180`（`src/control/orchestrator/loop.ts:427`），到点 `interrupt('timeout')`。一个合法跑 10 小时的 `develop` 与一个 hung 的 session 无法区分。
2. **进展信号不可观测**。OMP adapter 虽然声明 `CAP-STREAM`，但实现是等进程结束后把完整 stdout 交给 `parseOmpStream`（`src/execution/adapters/omp.ts:234`）。运行期间控制面看不到任何事件。
3. **超时会丢掉现场**。`interrupt` 后直接返回 `TIMEOUT`，partial stdout 丢弃、`session_ref: null`（`src/execution/adapters/omp.ts:226`）；转移表明确回流是 rematerialize，不实现 session resume（`src/control/transition/table.ts:161`）。
4. **成功路径没有 run 状态围栏**。成功分支 `UPDATE run ... WHERE id=$1` 不带 `status='RUNNING'`；pipeline 在返回成功前就提交了 `ProposalAccepted` + artifact；`keel_commit_artifact` 不检查 run 状态。失败路径反而有 guard（`src/control/orchestrator/loop.ts:802`）。巡检会把这个已有窗口从「进程内超时」扩大到「进程崩溃 + 外部收割」。
5. **人工契约与执行不一致**：`HumanAdapter` 声明 `max_wall_clock_s: null`（`src/execution/adapters/human.ts:70`），但 watchdog 在 pipeline 层无条件挂载（`src/control/proposal/pipeline.ts:156`）。人工接管一旦走同一条路径，也会被 180s 打断。注意：`HumanAdapter` 目前主要出现在 e2e / 测试路径，生产编排尚未接线；本任务的豁免是为接线后仍然成立。

## Users & Scenarios

1. **长开发（10h 级）**：`develop` 持续有文件改动 / 工具调用 / 模型事件，Run 不应被总时长杀死；只在真的没有进展时干预。
2. **静默挂死**：模型进程还在，但长时间没有任何事件；进程内监管在阈值后中断并记录证据。
3. **编排器崩溃**：进程死了，DB 里留下 `RUNNING` run；独立巡检发现 owner 心跳过期，收割并推进 Task。
4. **人工接管**：人可能需要几小时思考 / 操作；不得被自动判卡死。
5. **无 `CAP-STREAM` 的 Harness**：拿不到进展信号，只能退回墙钟兜底，但必须明确标记「liveness 不可用」，不能假装有进展。
6. **收割后的 zombie**：巡检把 run 标成 `TIMEOUT` 后，原进程仍可能返回成功。必须保证它不能提交 artifact、不能把 `TIMEOUT` 覆盖成 `SUCCEEDED`、不能把工作区改动提交到 Task 分支。

## Requirements

### R1 进展信号可观测（Adapter）

- OMP `--mode=json` NDJSON 必须**增量解析**：边读边产出进展事件，不得等进程结束才解析。
- 进展事件至少覆盖：`session` / `agent_start` / `turn_start` / `message_update` / `turn_end` / `agent_end`，以及实测存在的 `tool_execution_start` / `tool_execution_update` / `tool_execution_end`。**无文本的 thinking / 工具阶段也算进展**；`advisor_cost_changed` 这类纯成本通知不算。
- **实时性前提必须先验证**：实现前做 phase 0 spike，给每行 stdout 打时间戳，确认事件在进程运行期间到达，而不是退出时一次性到达。若 OMP 不实时 flush，必须停止本方案并重新评审进展源（session 文件 mtime、工具副作用、进程 CPU/IO 等），不得把「增量解析」当成默认成立。
- 最终 `ParsedRun` 必须与现有整段解析结果一致（文本、usage、sessionRef、nonJsonLines、sawAgentEnd）。
- 不得提前关闭 stdout（SIGPIPE 会让 OMP 丢会话文件，见 `omp.ts` 现有注释）。
- `message_update` 在 adapter 层合并（默认 250ms 一次回调），避免每个 token 触发控制面。
- Adapter **只回调，不写数据库**。

### R2 liveness 存储（Control Plane）

- 新增 `run_liveness` 表，按 `run_id` 一行，记录：`last_progress_at`、`progress_seq`、`last_kind`、`owner_pid`、`owner_heartbeat_at`、`harness_pid`、`harness_pgid`、`harness_started_at`、`stall_reported_at`。
- 只由 `keel_control` 角色写入；迁移必须显式 `GRANT SELECT, INSERT, UPDATE, DELETE ... TO keel_control`（DELETE 仅供巡检 prune 终态行），不得授予 Execution 角色。
- 迁移必须包含 Down migration（删表 / 索引 / 授权），并能在 `pnpm run db:reset` 后重建。
- 写放大受控：进展心跳最多 1 次 / 10s；owner 心跳最多 1 次 / 15s。
- **心跳写路径不得与编排事务抢连接**：独立连接或独立小 pool + 有界队列 + 合并写；DB 写失败只记结构化日志与 `worker_health`，不得让 Run 失败。
- 进程内沉默计时使用**单调时钟**（`performance.now()` 或注入的 monotonic now）；持久化时间戳使用 DB / 注入的 `now`。不得让墙钟跳变影响 liveness 判断。
- `owner_heartbeat_at` 与模型进展无关：它证明「编排进程还活着」，用于区分「模型静默」与「编排器死了」。
- liveness 是**运行遥测**，不是 Fact：事件重放不得依赖它；决策仍以 `RunStalled` 事件为准。
- `run_liveness` 进入终态后保留 7 天用于审计，由巡检定期 prune；不得随 run 数无限增长。

### R3 进程内沉默监管（Stall Supervisor）

- 按 stage 配置**无进展阈值**（silence threshold）；每次进展重置计时。
- 超过阈值 → `interrupt(handle, 'stalled')`，并记录判定证据。
- 墙钟硬上限**独立存在**，只作为显式预算 / 无信号兜底，不再负责 liveness。
- Harness 无 `CAP-STREAM` → 监管禁用，退回墙钟。
- 人工 Harness → 监管与硬上限都默认禁用（除非显式配置）。
- supervisor 必须记录「本次中断是 `stalled` 还是 `timeout`」；`RUN_STALLED` 的映射由控制面负责，adapter 只返回 `TIMEOUT`。

### R4 独立巡检（Patrol）

- 周期扫描（默认 30s）`RUNNING` run 的 liveness；复用现有独立 timer worker 进程的**常驻模式**，不新起常驻服务。单次 drain 不构成巡检。
- 只在 **owner 心跳过期** 时介入，避免与进程内监管重复处理。
- 巡检**不中断活进程的 session**（它没有 `SessionHandle`）；但必须处理**孤儿进程**：
  - 用记录的 `harness_pgid` + `harness_pid` 做 best-effort 清理；
  - 仅当 `ps -o lstart= -p <pid>` 与 `harness_started_at` 匹配（容差 2s）时才发送 `SIGTERM`，5s 后仍在则 `SIGKILL`；
  - 无法验证 / 无法杀时，记录 `orphan_alive=true`，不得静默当作已清理；
  - 清理结果写入 `RunStalled` 事件 payload 与 `worker_health`。
- 巡检必须先幂等 claim（`stall_reported_at` + `SKIP LOCKED`），再把 run 标为 `TIMEOUT`（`error_kind='RUN_STALLED'`，带 `status='RUNNING'` guard），然后通过 `driver.advance` 落 `RunStalled` 事件。
- 巡检必须自身可观测：每轮写 `worker_health`；巡检停止 / 连续报错要能被发现，不能静默失效。
- 部署前提必须写进文档：`keel timer-worker --interval` 需要常驻；healthz / console 读取 `worker_health`，超过 2 个周期未更新即视为异常。

### R5 干预与转移

- 新增 `TransitionEvent: RunStalled { stage }`。
- `T-030` / `T-031` 的 `on` 数组加入 `RunStalled`，复用现有 `stage_attempts` guard：
  - 未达上限 → 同 stage 重试（新 run）；
  - 达到上限 → `S-HUMAN_REVIEW`。
- `InterruptReason` 增加 `'stalled'`；`CloseReason` 增加 `'stalled'`。
- `ERROR_KINDS` 增加 `RUN_STALLED`（`retryable: true`）。
- Run 状态仍用 `TIMEOUT`，由 `error_kind` 区分「无进展」与「超预算」——避免为语义区分扩 `RunStatus` 枚举。
- **映射归属**：`RUN_STALLED` 只能由控制面产生。supervisor 记录 `stalled` 意图后，`runSessionUntilValid` / 编排循环据此返回 `RUN_STALLED`；adapter 不新增 reason 字段，`RunResult` 契约保持不变。
- 事件 payload 必须带证据：`silence_ms`、`last_progress_at`、`last_kind`、`owner_heartbeat_at`、`source: 'supervisor' | 'patrol'`、`orphan_killed: boolean | null`。

### R6 墙钟退回显式预算

- 每个 stage 有独立的硬上限（hard cap），不再全局一个 180s。
- 建议默认值（评审确认后固化）：

| stage | silence | hard cap |
|---|---|---|
| `pm` | 5 min | 30 min |
| `brainstorm` | 10 min | 2 h |
| `critic` | 10 min | 2 h |
| `rfc_draft` | 10 min | 2 h |
| `develop` | 20 min | 12 h |
| `qa` | 10 min | 2 h |
| `review` | 10 min | 2 h |

- `develop` 的 12h 是为了覆盖「有时候跑 10 小时」的合法长任务；超过 12h 视为预算耗尽，而不是卡死。
- **优先级**：显式 `--wall-clock <秒>` 覆盖所有 stage 的 hard cap（逃生阀），并打 warning；未显式指定时使用 stage policy。`KEEL_LIVENESS_MODE=wallclock` 时保持旧行为（全局 `wallClockS`，默认 180）。
- **并发后果**：全局 `DEFAULT_MAX_RUNNING_RUNS = 3`（`src/control/concurrency/limits.ts`）。一个 12h `develop` 占一个槽位，三个长任务即可让系统停止接新活。本任务不改并发模型，但必须在文档中写明；需要更多长任务并发时另立调度任务。
- 阈值常量集中在 `src/control/liveness/policy.ts`，测试可注入；v0.1 不做按环境变量的逐 stage 覆盖。

### R7 人工豁免

- `human` harness 不参与沉默监管，也不设默认硬上限。
- 人工路径只能由 `Cancelled` / `HumanRejected` / 显式超时配置结束。

### R8 可观测性

- `RunStalled` 事件、结构化日志、`worker_health` 三类记录必须能回答：谁判的、依据是什么、下一步做了什么、孤儿进程是否清理。
- 巡检自身健康纳入 `healthz` / 控制台的健康视图（只读展示，不新增配置页）。
- `worker_health` 需要能区分「巡检没跑」与「巡检跑了但没发现异常」。

### R9 边界与可重放

- Execution 不直接写 Fact Plane；liveness 写入由 Control Plane 完成。
- 转移函数保持纯函数；巡检 / 监管只通过 `driver.advance` 产生决策。
- 巡检 claim 必须幂等（`SKIP LOCKED` + `stall_reported_at` + `status='RUNNING'` guard）。
- 删除 `run_liveness` 表内容后，事件流仍能重建 Task 的全过程。
- `run_liveness` 的 `harness_pid` / `harness_pgid` 是清理线索，不是事实来源；不得让任何决策依赖它们。

### R10 兼容与降级

- 迁移是纯增量；旧 run 没有 liveness 行时按「无信号」处理，退回墙钟。
- 提供 `KEEL_LIVENESS_MODE=progress|wallclock` 作为回滚开关；默认 `progress`；非法值启动失败并给出明确文案，不静默回退。
- 无 `CAP-STREAM` 的 adapter 运行时把 `progressSource` 降为 `'none'`，只保留硬上限。
- 不改变现有 `RunStatus`、Artifact schema、Console 读路径。

### R11 Run 状态围栏（Fencing）

> 这是巡检安全性的前置条件，不是可选的加固。

- **成功与 artifact 原子化**：在 pipeline 提交 `ProposalAccepted` + artifact 的同一事务里，先完成 `validateProposal`（只读）；
  校验不通过时**不得触碰 run 状态**。校验通过后，再执行
  `UPDATE run SET status='SUCCEEDED', ended_at=$now WHERE id=$runId AND status='RUNNING'`；
  影响 0 行则事务内不写任何东西，返回围栏失败（按当前 run 状态映射 `RUN_TIMEOUT` / `RUN_CANCELLED`），不得提交 artifact。
- **提交前校验归属**：`proposal.produced_by_run` 必须等于当前 `SessionSpec` 的 `run_id`，且 `proposal.task_id` 必须等于当前 `task_id`；跨 run / 跨 Task 的提案直接拒收。
- **提交前闸门**：阶段专属成功条件（例如 develop 必须真的改过工作区）必须在 `validateProposal` 通过后、run 置 `SUCCEEDED` 之前判定；
  闸门失败不得改变 run 状态。不得把这类判定留到 pipeline 返回之后 —— 那时 run 已成功、artifact 已提交，只能留下假成功。
- **循环侧元数据更新**：成功事务只更新 usage / harness / diff 等元数据，且带 `status='SUCCEEDED'` guard；
  影响 0 行视为围栏失败，不得继续。
- **失败路径幂等**：`failRunAndAdvance` 必须检查 `UPDATE ... WHERE id=$1 AND status='RUNNING'` 的 `rowCount`；
  为 0 时返回 `'advanced'`（run 已由他人终结），不再 emit `RunFailed` / `RunTimeout`，也不再 `driver.advance`。否则巡检收割后，zombie 会再推进一次转移。
- **commitAll 顺序**：只在 run 已成功落入终态后调用；围栏失败时不得提交工作区。
- **测试**：巡检收割后让 fake session 继续返回成功，断言：
  - 没有新 artifact；
  - run 仍为 `TIMEOUT` / `RUN_STALLED`；
  - 没有重复的 `RunStalled` / `RunTimeout` / `RunFailed`；
  - `commitAll` 未被调用；
  - Task 只被推进一次。

### R12 长任务载体

- 本任务不新增常驻执行器，也不实现 detach / 并发 poller。
- 本任务保证的是「单 run 不被误杀 + 编排器崩溃后可被巡检收割」，**不是**「10h 无人值守」。
- 支持的载体：
  - `keel run-task` 放在 tmux / systemd / 其他外部 supervisor 下运行；
  - 或 `keel poller`（注意：`runIssue` 是串行 await，一个长 issue 会阻塞后续轮询）。
- 如果未来需要 detach / 并发执行，另立任务；本任务只把限制写清楚，不假装已经支持。

## Acceptance Criteria

- [ ] phase 0 spike 有真实时间戳证据：`turn_start` / `message_update` 在进程运行期间到达，而不是退出时一次性到达；若否，方案已回到评审而不是继续实现。
- [ ] 增量解析在任意 chunk 切分（含一行被切成两半、多行同 chunk）下，最终 `ParsedRun` 与整段解析完全一致。
- [ ] 一个有持续进展的长 Run 不会因为总时长到达 180s 被杀；`develop` 在 10h 内持续有进展时可继续。
- [ ] 一个无进展 Run 在 stage 阈值后被 `interrupt('stalled')`；产生一条 `RunStalled` 事件，payload 含证据字段。
- [ ] `RunStalled` 未达 `max_stage_attempts` → 创建同 stage 新 run；达到上限 → `S-HUMAN_REVIEW`。
- [ ] 模拟编排器崩溃（owner 心跳停止）后，独立巡检在 ≤ 2 个扫描周期内收割该 run，Task 不再永久停在 `RUNNING`。
- [ ] 巡检重复运行 / 双 worker 并发不会重复投递 `RunStalled`。
- [ ] 巡检收割后 zombie 继续返回成功：artifact、run 状态、Task 转移、工作区提交都没有被覆盖（R11）。
- [ ] `failRunAndAdvance` 在 run 已非 `RUNNING` 时不再 emit / advance。
- [ ] 孤儿进程被清理或明确记录 `orphan_alive=true`；pid 不匹配时不得误杀。
- [ ] `human` harness 不会被沉默监管或默认硬上限打断。
- [ ] 无 `CAP-STREAM` 的 harness 退回墙钟，`RunStalled` 不会被伪造。
- [ ] 删除 / 忽略 `run_liveness` 后，事件流重放仍得到相同的 Task 状态与 `RunStalled` 决策。
- [ ] 迁移包含 GRANT 与 Down；`pnpm run db:reset` 后 `keel_control` 可读写新表，`keel_execution` 不可写。
- [ ] liveness 写失败不影响 Run 结果；`run_liveness` 终态行按 7 天保留并被巡检 prune。
- [ ] `--wall-clock` 显式覆盖 stage hard cap；未指定时使用 stage policy。
- [ ] `onProgress` 只加在执行层 `SessionSpec`；契约层不新增函数字段。
- [ ] `pnpm run check` 全绿；新增 parser、supervisor、patrol、fencing、transition 测试覆盖上述分支。
- [ ] `docs/04-state-machine.md` §6、`docs/05-contracts/harness-adapter.md`、`docs/05-contracts/README.md`、`docs/08-cross-cutting.md`、`docs/adr/0009-*.md` 同步更新。
- [ ] `check:transitions` 通过，且 `docs/04-state-machine.md` 的 event 单元格已手工同步（该脚本不比对 event 列）。

## Out of Scope

- 实现 `checkpoint` / `restore` / session resume（依赖 ADR-0003 落地；本任务只做中断与重试）。
- 成本预算 / 金额熔断（`budget_usd` 仍为 `null`；12h 硬上限是时间兜底，不是成本上限）。
- Agent Pool / 多进程调度 / 分布式租约 / 分池并发（本任务只保证单编排进程 + 独立巡检进程）。
- 新增常驻执行器、`run-task` detach 模式、poller 并发化（见 R12）。
- 控制台 UI 新增巡检配置页。
- 修改 `max_attempts` / `max_dev_attempts` 的现有取值。
- 为每个 stage 提供环境变量级别的细粒度覆盖（v0.1 用常量 + 注入）。
- 把 `max_turns` 做成第二道兜底（当前 adapter 未强制，本任务不改变这一点）。
