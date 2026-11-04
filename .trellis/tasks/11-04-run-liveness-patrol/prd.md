# 运行巡检：按进展信号判定卡死并干预

## Goal

把「卡死判定」从**总时长墙钟**改为**进展信号 + 定期巡检**：

- 只要 Run 还在产出可观测的进展，就允许它继续跑；`develop` 可以跑到小时级。
- 只有「无进展」才判卡死，并按干预梯度处理。
- 墙钟退回**显式预算 / 无进展信号时的兜底**，不再承担 liveness 语义。

一句话：**卡死不是「跑了多久」，而是「多久没有新进展」。**

## Background

现状的三处结构性缺口：

1. **liveness 只有总时长一个数字**。`wallClockS = deps.wallClockS ?? 180`（`src/control/orchestrator/loop.ts:427`），到点 `interrupt('timeout')`。一个合法跑 10 小时的 `develop` 与一个 hung 的 session 无法区分。
2. **进展信号不可观测**。OMP adapter 虽然声明 `CAP-STREAM`，但实现是等进程结束后把完整 stdout 交给 `parseOmpStream`（`src/execution/adapters/omp.ts:234`）。运行期间控制面看不到任何事件。
3. **超时会丢掉现场**。`interrupt` 后直接返回 `TIMEOUT`，partial stdout 丢弃、`session_ref: null`（`src/execution/adapters/omp.ts:226`）；转移表明确回流是 rematerialize，不实现 session resume（`src/control/transition/table.ts:161`）。

同时存在一个契约不一致：`HumanAdapter` 声明 `max_wall_clock_s: null`（`src/execution/adapters/human.ts:70`），但 watchdog 在 pipeline 层无条件挂载（`src/control/proposal/pipeline.ts:156`）。人工接管一旦走同一条路径，也会被 180s 打断。

## Users & Scenarios

1. **长开发（10h 级）**：`develop` 持续有文件改动 / 工具调用 / 模型事件，Run 不应被总时长杀死；只在真的没有进展时干预。
2. **静默挂死**：模型进程还在，但长时间没有任何事件；进程内监管在阈值后中断并记录证据。
3. **编排器崩溃**：进程死了，DB 里留下 `RUNNING` run；独立巡检发现 owner 心跳过期，收割并推进 Task。
4. **人工接管**：人可能需要几小时思考 / 操作；不得被自动判卡死。
5. **无 `CAP-STREAM` 的 Harness**：拿不到进展信号，只能退回墙钟兜底，但必须明确标记「liveness 不可用」，不能假装有进展。

## Requirements

### R1 进展信号可观测（Adapter）

- OMP `--mode=json` NDJSON 必须**增量解析**：边读边产出进展事件，不得等进程结束才解析。
- 进展事件至少覆盖：`session` / `agent_start` / `turn_start` / `message_update` / `turn_end` / `agent_end`。**无文本的 thinking / 工具阶段也算进展**。
- 最终 `ParsedRun` 必须与现有整段解析结果一致（文本、usage、sessionRef、nonJsonLines、sawAgentEnd）。
- 不得提前关闭 stdout（SIGPIPE 会让 OMP 丢会话文件，见 `omp.ts` 现有注释）。
- Adapter **只回调，不写数据库**。

### R2 liveness 存储（Control Plane）

- 新增 `run_liveness` 表，按 `run_id` 一行，记录：`last_progress_at`、`progress_seq`、`last_kind`、`owner_pid`、`owner_heartbeat_at`、`stall_reported_at`。
- 只由 `keel_control` 角色写入；Adapter / Execution 不得直接写。
- 写放大受控：进展心跳最多 1 次 / 10s；owner 心跳最多 1 次 / 15s。
- `owner_heartbeat_at` 与模型进展无关：它证明「编排进程还活着」，用于区分「模型静默」与「编排器死了」。
- liveness 是**运行遥测**，不是 Fact：事件重放不得依赖它；决策仍以 `RunStalled` 事件为准。

### R3 进程内沉默监管（Stall Supervisor）

- 按 stage 配置**无进展阈值**（silence threshold）；每次进展重置计时。
- 超过阈值 → `interrupt(handle, 'stalled')`，并记录判定证据。
- 墙钟硬上限**独立存在**，只作为显式预算 / 无信号兜底，不再负责 liveness。
- Harness 无 `CAP-STREAM` → 监管禁用，退回墙钟。
- 人工 Harness → 监管与硬上限都默认禁用（除非显式配置）。

### R4 独立巡检（Patrol）

- 周期扫描（默认 30s）`RUNNING` run 的 liveness；复用现有独立 timer worker 进程，不新起常驻服务。
- 只在 **owner 心跳过期** 时介入，避免与进程内监管重复处理。
- 巡检**不直接 kill 进程**：先幂等 claim，再把 run 标为 `TIMEOUT`（`error_kind='RUN_STALLED'`），然后通过 `driver.advance` 落 `RunStalled` 事件。
- 巡检必须自身可观测：每轮写 `worker_health`；巡检停止 / 连续报错要能被发现，不能静默失效。

### R5 干预与转移

- 新增 `TransitionEvent: RunStalled { stage }`。
- `T-030` / `T-031` 的 `on` 数组加入 `RunStalled`，复用现有 `stage_attempts` guard：
  - 未达上限 → 同 stage 重试（新 run）；
  - 达到上限 → `S-HUMAN_REVIEW`。
- `InterruptReason` 增加 `'stalled'`；`CloseReason` 增加 `'stalled'`。
- `ERROR_KINDS` 增加 `RUN_STALLED`（`retryable: true`）。
- Run 状态仍用 `TIMEOUT`，由 `error_kind` 区分「无进展」与「超预算」——避免为语义区分扩 `RunStatus` 枚举。
- 事件 payload 必须带证据：`silence_ms`、`last_progress_at`、`last_kind`、`owner_heartbeat_at`、`source: 'supervisor' | 'patrol'`。

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
- 阈值常量集中在 `src/control/liveness/policy.ts`，测试可注入；v0.1 不做按环境变量的逐 stage 覆盖。

### R7 人工豁免

- `human` harness 不参与沉默监管，也不设默认硬上限。
- 人工路径只能由 `Cancelled` / `HumanRejected` / 显式超时配置结束。

### R8 可观测性

- `RunStalled` 事件、结构化日志、`worker_health` 三类记录必须能回答：谁判的、依据是什么、下一步做了什么。
- 巡检自身健康纳入 `healthz` / 控制台的健康视图（只读展示，不新增配置页）。

### R9 边界与可重放

- Execution 不直接写 Fact Plane；liveness 写入由 Control Plane 完成。
- 转移函数保持纯函数；巡检 / 监管只通过 `driver.advance` 产生决策。
- 巡检 claim 必须幂等（`SKIP LOCKED` + `stall_reported_at` + `status='RUNNING'` guard）。
- 删除 `run_liveness` 表内容后，事件流仍能重建 Task 的全过程。

### R10 兼容与降级

- 迁移是纯增量；旧 run 没有 liveness 行时按「无信号」处理，退回墙钟。
- 提供 `KEEL_LIVENESS_MODE=progress|wallclock` 作为回滚开关；默认 `progress`。
- 不改变现有 `RunStatus`、Artifact schema、Console 读路径。

## Acceptance Criteria

- [ ] 增量解析在任意 chunk 切分（含一行被切成两半、多行同 chunk）下，最终 `ParsedRun` 与整段解析完全一致。
- [ ] 一个有持续进展的长 Run 不会因为总时长到达 180s 被杀；`develop` 在 10h 内持续有进展时可继续。
- [ ] 一个无进展 Run 在 stage 阈值后被 `interrupt('stalled')`；产生一条 `RunStalled` 事件，payload 含证据字段。
- [ ] `RunStalled` 未达 `max_stage_attempts` → 创建同 stage 新 run；达到上限 → `S-HUMAN_REVIEW`。
- [ ] 模拟编排器崩溃（owner 心跳停止）后，独立巡检在 ≤ 2 个扫描周期内收割该 run，Task 不再永久停在 `RUNNING`。
- [ ] 巡检重复运行 / 双 worker 并发不会重复投递 `RunStalled`。
- [ ] `human` harness 不会被沉默监管或默认硬上限打断。
- [ ] 无 `CAP-STREAM` 的 harness 退回墙钟，`RunStalled` 不会被伪造。
- [ ] 删除 / 忽略 `run_liveness` 后，事件流重放仍得到相同的 Task 状态与 `RunStalled` 决策。
- [ ] `pnpm run check` 全绿；新增 parser、supervisor、patrol、transition 测试覆盖上述分支。
- [ ] `docs/04-state-machine.md` §6、`docs/05-contracts/harness-adapter.md`、`docs/05-contracts/README.md`、`docs/adr/0009-*.md` 同步更新。

## Out of Scope

- 实现 `checkpoint` / `restore` / session resume（依赖 ADR-0003 落地；本任务只做中断与重试）。
- 成本预算 / 金额熔断（`budget_usd` 仍为 `null`；12h 硬上限是时间兜底，不是成本上限）。
- Agent Pool / 多进程调度 / 分布式租约（本任务只保证单编排进程 + 独立巡检进程）。
- 控制台 UI 新增巡检配置页。
- 修改 `max_attempts` / `max_dev_attempts` 的现有取值。
- 为每个 stage 提供环境变量级别的细粒度覆盖（v0.1 用常量 + 注入）。
