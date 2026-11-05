# 执行计划：运行巡检

验证命令一律在仓库根执行。每一步都必须先绿再进下一步。
**顺序不是可选的**：phase 0 spike 是门槛；围栏（第 2 步）必须先于巡检落地；否则巡检会放大已有竞态。

## 0. 准备与基线

- [ ] 评审 `prd.md` / `design.md` / `review.md`，确认每 stage 阈值（尤其 `develop` 12h）
- [ ] 确认 `KEEL_LIVENESS_MODE` 的默认值（建议 `progress`）
- [ ] 记基线：`pnpm vitest run src/execution/adapters/adapters.test.ts`
- [ ] 记基线：`pnpm vitest run src/timer/worker.test.ts src/e2e/timer-worker.test.ts`
- [ ] 记基线：`pnpm run test:acceptance`（需要 `KEEL_TEST_REMOTE_REPO` 与可用 OMP；未配置时记录为环境红点，不用 `vitest run <file>` 绕过默认排除）
- [ ] 记基线：`pnpm vitest run src/e2e/session-pipeline.test.ts`
- [ ] 记基线：`pnpm run typecheck`
- [ ] 起测试库：`pnpm run db:reset`（本地 Postgres 可用时）
- [ ] **不要**在本步 `task.py start`；评审通过后再激活

**完成判据**：上述命令在 main 上全绿；任何既有红点先记录，不在本任务顺手修。

## 1. Phase 0：OMP 实时 flush spike（门槛）

- [ ] 写一个一次性脚本 / 测试：spawn `omp --mode=json`，给每行 stdout 打时间戳
- [ ] 断言运行期间能收到 `turn_start` / `message_update` / `turn_end`，而不是退出时一次性收到
- [ ] 记录至少一次真实长任务的到达间隔分布
- [ ] 结论写入 `.trellis/tasks/11-04-run-liveness-patrol/research/flush-spike.md`

**分叉**：

- [ ] 实时到达 → 继续第 2 步
- [ ] 退出时才到达 → **停止本任务**，改用 session 文件 mtime / 工具副作用 / 进程 CPU/IO 等进展源，回到评审
- [ ] 无法判断 → 不进入实现

**回滚点**：spike 是只读实验，不改生产代码。

## 2. Run 状态围栏（Fencing，先于巡检）

- [x] `pipeline.ts` 提交事务（顺序不能错）：
  - [x] 先 `validateProposal`（只读）；校验不通过时不得触碰 run 状态（`asRole` 正常返回也会 COMMIT）
  - [x] 校验通过后校验 `proposal.produced_by_run === spec.runSpec.run.run_id` 且 `proposal.task_id === spec.runSpec.run.task_id`
  - [x] 阶段专属成功条件放在 `PipelineOptions.preCommitGate`：在 `validateProposal` + 归属校验之后、`UPDATE run ... SUCCEEDED` 之前执行；返回错误时 run 仍保持 `RUNNING`
  - [x] 把 `loop.ts` 现有的 develop 空 diff 闸门移进 `preCommitGate`（否则 pipeline 先置 SUCCEEDED，loop 再判失败只能留下假成功）
  - [x] `UPDATE run SET status='SUCCEEDED', ended_at=$now WHERE id=$runId AND status='RUNNING'`
  - [x] `rowCount === 0` → 返回围栏失败错误（按当前状态映射 `RUN_TIMEOUT` / `RUN_CANCELLED`），不插 `ProposalAccepted`、不提交 artifact；不要当成 `violations` 回灌
  - [x] 只有 update 成功后才插事件与 artifact
- [x] `loop.ts` 成功路径：
  - [x] 元数据更新带 `status='SUCCEEDED'` guard，检查 `rowCount`
  - [x] `rowCount === 0` 时不得插入 `WorkspaceDiffCollected`、不得 `commitAll`
  - [x] 围栏成功后才插入 `WorkspaceDiffCollected` 与 `checkBudgetFuse`
- [x] `failRunAndAdvance`：
  - [x] 检查 `UPDATE ... WHERE id=$1 AND status='RUNNING'` 的 `rowCount`
  - [x] 为 0 时返回 `'advanced'`（已由他人终结），不 emit、不 advance；不要因为 `RUN_CANCELLED` 返回 `'stopped-cancelled'`
- [x] 审计 4 个直接调用点：
  - [x] `src/acceptance/session-milestone.acceptance.test.ts:95`
  - [x] `src/e2e/session-pipeline.test.ts:258`
  - [x] `src/e2e/session-pipeline.test.ts:332`
  - [x] `src/e2e/session-pipeline.test.ts:360`
  - [x] 确保都有对应 `RUNNING` run 行 / 测试夹具
- [x] 新增 e2e：patrol 收割后 fake session 继续返回成功
  - [x] 断言没有新 artifact
  - [x] 断言 run 仍为 `TIMEOUT` / `RUN_STALLED`
  - [x] 断言没有重复 `RunStalled` / `RunTimeout` / `RunFailed`（pipeline 层先覆盖「无新增 ProposalAccepted」；重复转移在 8 回归）
  - [x] 断言 `commitAll` 未被调用（pipeline 围栏失败即返回，编排层测试在 8 回归）
  - [x] 断言 Task 只推进一次（同上，8 回归）

验证：`pnpm vitest run src/e2e/session-pipeline.test.ts src/e2e/timer-inflight.test.ts src/control/orchestrator/run-failure.test.ts src/e2e/collect-changes.test.ts`

**回滚点**：围栏是独立改动，可单独回滚；但一旦第 7 步上线，围栏不得回滚。

## 3. 增量 OMP 解析器（纯函数层）

- [x] 在 `src/execution/adapters/omp-parse.ts` 增加 `ProgressKind` / `ProgressEvent`
  - [x] 覆盖 `session` / `agent_start` / `turn_start` / `message_update` / `turn_end` / `agent_end`
  - [x] 覆盖实测存在的 `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
  - [x] `advisor_cost_changed` 不算进展
- [x] 增加 `OmpStreamParser`：
  - [x] 行缓冲：半行不解析，跨 chunk 拼接
  - [x] `push(chunk)` 返回本 chunk 的进展事件
  - [x] `end()` 返回与 `parseOmpStream(full)` 等价的 `ParsedRun`
  - [x] 非 JSON 行、`agent_end`、usage、sessionRef 行为不变
  - [x] 首个事件携带 `pid` / `pgid` / `startedAt`（由 adapter 注入）
- [x] `message_update` 合并：adapter 层最多 250ms 回调一次
- [x] 单测：
  - [x] 一行被切成两半
  - [x] 一个 chunk 含多行
  - [x] 空 chunk / 只有换行 / 尾部无换行
  - [x] 与整段解析逐字段等价
  - [x] 非 JSON 错误行仍进 `nonJsonLines`
  - [x] 进程异常退出时已产生的进展事件不丢

验证：`pnpm vitest run src/execution/adapters/adapters.test.ts`

**回滚点**：只新增 parser，不接线；失败可整体删除。

## 4. Adapter 进展通道（不改调度）

- [x] `onProgress?: (event: ProgressEvent) => void` 加在执行层 `SessionSpec`（`src/execution/session/manager.ts`）
- [x] **不要**把函数字段加到契约层 `src/contracts/session-manager.ts` 的 `SessionSpec`（函数只作为 `startRun` 的第二参数传递，不进可序列化 `RunSpec`）
- [x] OMP adapter 在 `push` 后回调；不写 DB、不关闭 stdout
- [x] Claude adapter 本任务不接（保持现有行为）
- [x] Human adapter 永不调用
- [x] 单测：
  - [x] onProgress 收到 `turn_start` / `message_update` / `turn_end`
  - [x] 首个事件带 pid / pgid / startedAt
  - [x] 进程异常退出时已产生的进展事件不丢
  - [x] 不传 onProgress 时行为与现在一致

验证：`pnpm vitest run src/execution/adapters/adapters.test.ts src/e2e/session-pipeline.test.ts`

**回滚点**：回调未接控制面，调度行为不变；可单独回滚。

## 5. liveness 存储

- [x] 新增 `migrations/1000000000007_run_liveness.sql`：
  - [x] `run_liveness`（含 `harness_pid` / `harness_pgid` / `harness_started_at`）
  - [x] `worker_health`
  - [x] 索引
  - [x] `GRANT SELECT, INSERT, UPDATE, DELETE ON run_liveness TO keel_control`（DELETE 仅用于 prune）
  - [x] Down migration（删索引 / 表 / 授权）
- [x] `src/control/liveness/store.ts`：
  - [x] `recordProgress(runId, kind, now)`：节流 10s，`progress_seq + 1`
  - [x] `heartbeatOwner(runId, pid, now)`：由 supervisor 按 15s 调用
  - [x] `recordHarnessProcess(runId, pid, pgid, startedAt)`：仅首次
  - [x] `markStallReported(runId, now)`：幂等 claim
  - [x] `readStaleCandidates(now, ownerGraceMs, limit)`
  - [x] `pruneTerminal(olderThanDays)`
- [x] 写路径：独立连接 / 小 pool + 有界队列 + 合并写；写失败只记日志，不影响 Run
- [x] 所有写入走 `keel_control`；检查角色授权不放开给 Execution
- [x] 集成测试（需要 DB）：
  - [x] 节流窗口内重复调用不增加 `progress_seq`
  - [x] 节流窗口外正常递增
  - [x] `markStallReported` 第二次返回 0 行
  - [x] 旧 run 无 liveness 行时读取返回空
  - [x] `keel_execution` 写入被拒绝
  - [x] `pruneTerminal` 只删除终态且超过保留期的行

验证：`pnpm run db:reset && pnpm vitest run src/control/liveness`

**回滚点**：新表纯增量，不写库也能回滚代码；Down migration 可完整撤销。

## 6. 进程内 StallSupervisor

- [x] `src/control/liveness/policy.ts`：`LIVENESS_POLICY`（按 `design.md` §4.7）
- [x] `src/control/liveness/supervisor.ts`：
  - [x] `start(handle)` / `noteProgress(event)` / `stop()`
  - [x] 沉默阈值检查（注入单调 `now`，测试用毫秒级）
  - [x] 到阈值 → `sessions.interrupt(handle, 'stalled')`，记录 `interruptedBy='stalled'`
  - [x] owner 心跳定时器（15s）与进展无关；`progressSource='none'` / human 也要续
  - [x] **不另起 hard-cap 定时器**：硬上限继续由既有 DB `wall_clock` timer 负责；supervisor 只用 `hardCapS` 计算 run 创建时的 `wall_clock_s`
  - [x] `progressSource === 'none'` 或 human → 禁用沉默检查
  - [x] `finally` 清理沉默检查与 owner 心跳两个定时器
- [x] 接入 `runSessionUntilValid`：
  - [x] 有进展信号时，用 supervisor 取代现有总时长 watchdog
  - [x] 无进展信号时，保留现有 watchdog
  - [x] 硬上限继续用 `wall_clock` timer / `wallClockS`
  - [x] `advance` 返回 `RUN_TIMEOUT` 时，根据 `interruptedBy` 返回 `RUN_STALLED` 或 `RUN_TIMEOUT`
- [x] 单测：
  - [x] 持续进展 3× 阈值时间仍不中断
  - [x] 静默到阈值立即中断，reason 为 `stalled`
  - [x] 硬上限到点仍由 `wall_clock` 触发 `timeout`（不重复触发）
  - [x] human / 无信号路径不挂沉默检查
  - [x] `RUN_STALLED` 只在 supervisor 记录 `stalled` 时产生

验证：`pnpm vitest run src/control/liveness src/e2e/timer-inflight.test.ts src/e2e/session-pipeline.test.ts`

**回滚点**：`KEEL_LIVENESS_MODE=wallclock` 可禁用 supervisor；现有 watchdog 代码保留。

## 7. 独立 Patrol

- [x] `src/timer/patrol.ts`：
  - [x] 扫描候选（只读，`owner_heartbeat_at` 过期 + `stall_reported_at IS NULL`）
  - [x] 用行内 `silence_ms`（写入自 stage policy）过滤；NULL 跳过，`coalesce(last_progress_at, started_at)` 作基准
  - [x] 幂等 claim（`UPDATE ... WHERE stall_reported_at IS NULL`）
  - [x] 孤儿进程清理：
    - [x] 仅当 `harness_pgid === harness_pid` 时尝试
    - [x] `ps -o lstart=` 与 `harness_started_at` 比对（容差 2s）
    - [x] `SIGTERM` → 5s → `SIGKILL`
    - [x] 结果写 `orphan_killed` / `worker_health`
  - [x] `reapStalledRun`：`status='TIMEOUT'`, `error_kind='RUN_STALLED'`，带 `status='RUNNING'` guard
  - [x] `driver.advance(taskId, { type: 'RunStalled', stage }, now)`
  - [x] 每轮写 `worker_health('patrol', ...)`；异常写 `last_error`
  - [x] 每轮 / 定期 prune 终态 liveness 行（7 天）
- [x] 接入 timer worker 的常驻 drain 循环（默认 30s 一次；可注入短间隔）
- [x] 并发测试：
  - [x] 双 worker 同时 patrol，只产生一条 `RunStalled`
  - [x] run 已终态时 claim / update 均为 0 行
  - [x] owner 心跳新鲜时不介入（由 supervisor 负责）
  - [x] 无 liveness 行的旧 run 不被误判（走墙钟兜底）
  - [x] 孤儿进程被 kill；pid 启动时间不匹配时不 kill
  - [x] 无法 kill 时记录 `orphan_alive`，不静默成功

验证：`pnpm vitest run src/timer src/e2e/timer-worker.test.ts src/e2e/timer-inflight.test.ts`

**回滚点**：patrol 未接 worker 时不产生任何行为；可单独关闭。

## 8. 事件 / 转移 / 错误接入

- [x] `TransitionEvent` 增加 `RunStalled`
- [x] `T-030` / `T-031` 的 `on` 加入 `RunStalled`
- [x] `InterruptReason` / `CloseReason` 增加 `'stalled'`
- [x] `ERROR_KINDS` 增加 `RUN_STALLED`，`RETRYABLE` 为 `true`
- [x] `loop.ts` 映射：`RUN_STALLED → RunStalled`，`RUN_TIMEOUT → RunTimeout`
- [x] `failRunAndAdvance` 的 run 状态映射：`RUN_STALLED` / `RUN_TIMEOUT` → `TIMEOUT`；`RUN_CANCELLED` → `CANCELLED`；其余 → `FAILED`
- [x] `failRunAndAdvance` 的 rowCount guard（第 2 步已加，这里回归）
- [x] 事件 payload 带证据字段（`silence_ms` / `last_progress_at` / `last_kind` / `owner_heartbeat_at` / `source` / `orphan_killed`）
- [x] 测试：
  - [x] 未达 `max_stage_attempts` → 同 stage 新 run
  - [x] 达到上限 → `S-HUMAN_REVIEW`
  - [x] `RunStalled` 与 `RunTimeout` 事件类型可区分
  - [x] `error_kind` 落库为 `RUN_STALLED`
  - [x] run 已终态时不重复 advance

验证：`pnpm vitest run src/control/transition src/control/orchestrator src/timer`

注意：`pnpm run check:transitions` 必须通过；该脚本不比对 event 单元格，需**手工**更新 `docs/04-state-machine.md`。

## 9. 降级、优先级与 human 豁免

- [x] `KEEL_LIVENESS_MODE=progress|wallclock` 解析与校验（非法值拒绝，不静默回退）
  - 启动期校验在 `run-task` / `run-issue` / `poller` / `timer-worker` 四个入口，先于数据库动作。
- [x] 默认 `progress`
- [x] 无 `CAP-STREAM`：`progressSource → 'none'`，只保留硬上限
  - 实现上 `silenceMs: null` 是单一事实源，`progressSourceOf()` 派生只读视图。
- [x] human：`silence` 禁用，`hardCapS: null`
- [x] `--wall-clock` 显式指定时覆盖所有 stage hard cap，并打 warning
- [x] 未指定时使用 `LIVENESS_POLICY`（`runWallClockS` 集中优先级）
- [x] `wallclock` 模式保持旧的全局 `wallClockS`（180s）
- [x] `runTask` 接入共享 `LivenessStore`（progress 模式；run-issue / poller 经它自动生效）
- [x] 测试：
  - [x] human run 超过旧 180s 不被中断
  - [x] wallclock 模式行为与改造前一致
  - [x] 非法 env 值启动失败并给出明确文案
  - [x] `--wall-clock` 覆盖 stage 上限
  - [x] 未指定 `--wall-clock` 时 `develop` 使用 12h

验证：`pnpm vitest run src/control/liveness src/e2e/human-harness.test.ts src/cli`

## 10. 文档与 ADR

- [x] 新增 `docs/adr/0009-liveness-by-progress.md`（先 Proposed；实现验证后改 Accepted）
- [x] 更新 `docs/adr/README.md` 索引
- [x] 更新 `docs/04-state-machine.md` §4 / §6：
  - [x] `RunStalled` 事件
  - [x] 两层检测（supervisor / patrol）
  - [x] 每 stage silence / hard cap 表
  - [x] `TIMEOUT` 状态 + `RUN_STALLED` 的语义说明
  - [x] **手工同步 event 单元格**
- [x] 更新 `docs/05-contracts/harness-adapter.md`：
  - [x] `onProgress` 语义（执行层）
  - [x] `interrupt('stalled')`
  - [x] `CloseReason` 增加 `'stalled'`（落在 `session-manager.md`）
  - [x] 明确 `RunResult` 不变
- [x] 更新 `docs/05-contracts/README.md` 错误矩阵：`RUN_STALLED`
- [x] 更新 `docs/08-cross-cutting.md` §3.4：
  - [x] liveness 与 budget 分离
  - [x] 长任务与全局并发 3 的挤压
- [x] 写明 `timer-worker --interval` 的常驻前提
- [x] 写明 `--wall-clock` 的覆盖语义
- [x] `docs/schemas/` 无事件枚举变更，`pnpm run check:generated` 通过

验证：`pnpm run check:generated`

## 11. 全量验证与验收

- [x] `pnpm run check`（lint / typecheck / boundaries / generated / transitions / purity / test）
  - 结果：55 files / 781 passed，5 skipped。
- [x] `pnpm run db:reset && pnpm vitest run src/e2e`（需要 Postgres）
  - 结果：10 files / 47 passed。
- [x] 长任务不被 180s 误杀
  - 自动化：`human-harness.test.ts`（单调时钟 10h）、`supervisor.test.ts`（3× 阈值持续有进展不中断）。
  - 未跑真实模型 10h —— 该场景的判据是「持续进展」，已由注入时钟覆盖。
- [x] 手工制造静默 → `RunStalled`
  - `session-pipeline.test.ts`：`silenceMs:1` → `interrupt('stalled')` → `TIMEOUT/RUN_STALLED`。
- [x] 杀掉编排进程 → patrol 收割
  - `patrol.test.ts` 的 owner 心跳过期用例 + 真实 CLI 冒烟（见下）。
- [x] 孤儿进程 pgid 清理
  - `patrol.test.ts` 新增真实进程用例：`spawn(detached)` → 真实 `ps -o lstart=` / `kill(-pgid)` → `orphan_killed:true`。
- [x] 收割后 zombie 返回成功的围栏
  - `session-pipeline.test.ts` R11：无 artifact、`ProposalAccepted` 不落、终态不被覆盖。
- [x] 记录一次真实 `RunStalled` 证据
  - 真实 `keel timer-worker` 冒烟：`reaped=1`，run → `TIMEOUT/RUN_STALLED`，
    事件 `RunStalled source=patrol silence_ms=5400375`（90m），随后 T-030 建重试 run。
  - 该值高于 `develop` 的 20m 阈值，说明阈值有充足余量；后续可按 `last_kind` 分布继续校准。
- [x] 更新 `task.json` 状态与分支信息；提交前 review diff
  - 实现提交：`9fd5b87 feat(liveness): 卡死判定从总耗时改为进展信号，补两层巡检`；
    ADR 转 Accepted：`4c7a26a`。
  - 契约沉淀：`.trellis/spec/backend/run-liveness.md`（本任务收尾时补）。

**完成判据**：`pnpm run check` 全绿；上述冒烟场景都有记录；没有为了「跑绿」跳过 e2e。

## 回滚策略

| 阶段 | 回滚动作 |
|---|---|
| 1（spike） | 只读实验，无代码 |
| 2（围栏） | 可单独回滚；**巡检上线后不得回滚** |
| 3–4（parser / 回调） | 删除新增代码，不影响调度 |
| 5（liveness 表） | Down migration；代码不读不写即可 |
| 6（supervisor） | `KEEL_LIVENESS_MODE=wallclock` |
| 7（patrol） | 不接入 timer worker 的常驻 drain 循环 |
| 8（事件 / 转移） | 移除 `RunStalled` 消费；`RUN_STALLED` 保留为未使用 kind 或回滚注册表 |
| 9（默认值） | 调回 `LIVENESS_POLICY` 常量；不改 schema |

## 评审门槛

- 评审 1：PRD + 本计划（尤其每 stage 阈值、`develop` 12h、human 豁免、围栏范围）
- 评审 2：phase 0 spike 结论（实时 / 非实时 / 无法判断）
- 评审 3：第 2 步围栏 + 第 3–5 步 parser / store diff
- 评审 4：第 6–8 步 supervisor / patrol / transition diff
- 评审 5：文档与 ADR；确认后再 `task.py start` / 提交

> 注意：`task.py start` 应在评审 1 通过后执行；评审 2 的分叉若为「非实时」，则回到评审而不是继续。
