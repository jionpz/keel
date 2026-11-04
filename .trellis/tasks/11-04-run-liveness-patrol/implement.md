# 执行计划：运行巡检

验证命令一律在仓库根执行。每一步都必须先绿再进下一步；第 1–3 步是纯增量，可在不改变现有调度行为的情况下独立落地。

## 0. 准备与基线

- [ ] 评审 `prd.md` / `design.md`，确认每 stage 阈值（尤其 `develop` 12h）
- [ ] 确认 `KEEL_LIVENESS_MODE` 的默认值（建议 `progress`）
- [ ] 记基线：`pnpm vitest run src/execution/adapters/adapters.test.ts`
- [ ] 记基线：`pnpm vitest run src/timer/worker.test.ts src/e2e/timer-worker.test.ts`
- [ ] 记基线：`pnpm run typecheck`
- [ ] 起测试库：`pnpm run db:reset`（本地 Postgres 可用时）
- [ ] **不要**在本步 `task.py start`；评审通过后再激活

**完成判据**：上述命令在 main 上全绿；任何既有红点先记录，不在本任务顺手修。

## 1. 增量 OMP 解析器（纯函数层）

- [ ] 在 `src/execution/adapters/omp-parse.ts` 增加 `ProgressKind` / `ProgressEvent`
- [ ] 增加 `OmpStreamParser`：
  - [ ] 行缓冲：半行不解析，跨 chunk 拼接
  - [ ] `push(chunk)` 返回本 chunk 的进展事件
  - [ ] `end()` 返回与 `parseOmpStream(full)` 等价的 `ParsedRun`
  - [ ] 非 JSON 行、`agent_end`、usage、sessionRef 行为不变
- [ ] `message_update` 合并：adapter 层最多 250ms 回调一次
- [ ] 单测：
  - [ ] 一行被切成两半
  - [ ] 一个 chunk 含多行
  - [ ] 空 chunk / 只有换行 / 尾部无换行
  - [ ] 与整段解析逐字段等价
  - [ ] 非 JSON 错误行仍进 `nonJsonLines`

验证：`pnpm vitest run src/execution/adapters/adapters.test.ts`

**回滚点**：只新增 parser，不接线；失败可整体删除。

## 2. Adapter 进展通道（不改调度）

- [ ] `SessionSpec` / `open` options 增加 `onProgress?: (event: ProgressEvent) => void`
- [ ] OMP adapter 在 `push` 后回调；不写 DB、不关闭 stdout
- [ ] Claude adapter 本任务不接（保持现有行为）
- [ ] Human adapter 永不调用
- [ ] 单测：
  - [ ] onProgress 收到 `turn_start` / `message_update` / `turn_end`
  - [ ] 进程异常退出时已产生的进展事件不丢
  - [ ] 不传 onProgress 时行为与现在一致

验证：`pnpm vitest run src/execution/adapters/adapters.test.ts src/e2e/session-pipeline.test.ts`

**回滚点**：回调未接控制面，调度行为不变；可单独回滚。

## 3. liveness 存储

- [ ] 新增 `migrations/1000000000007_run_liveness.sql`（`run_liveness` + `worker_health` + 索引）
- [ ] `src/control/liveness/store.ts`：
  - [ ] `recordProgress(runId, kind, now)`：节流 10s，`progress_seq + 1`
  - [ ] `heartbeatOwner(runId, pid, now)`：节流 15s
  - [ ] `markStallReported(runId, now)`：幂等 claim
  - [ ] `readStaleCandidates(now, ownerGraceMs, limit)`
- [ ] 所有写入走 `keel_control`；检查角色授权不放开给 Execution
- [ ] 集成测试（需要 DB）：
  - [ ] 节流窗口内重复调用不增加 `progress_seq`
  - [ ] 节流窗口外正常递增
  - [ ] `markStallReported` 第二次返回 0 行
  - [ ] 旧 run 无 liveness 行时读取返回空

验证：`pnpm run db:reset && pnpm vitest run src/control/liveness`

**回滚点**：新表纯增量，不写库也能回滚代码。

## 4. 进程内 StallSupervisor

- [ ] `src/control/liveness/policy.ts`：`LIVENESS_POLICY`（按 `design.md` §4.7）
- [ ] `src/control/liveness/supervisor.ts`：
  - [ ] `start(handle)` / `noteProgress(event)` / `stop()`
  - [ ] 沉默阈值检查（注入 `now`，测试用毫秒级）
  - [ ] 到阈值 → `sessions.interrupt(handle, 'stalled')`
  - [ ] 硬上限独立计时 → `interrupt('timeout')`
  - [ ] `progressSource === 'none'` 或 human → 禁用沉默检查
  - [ ] `finally` 清理定时器
- [ ] 接入 `runSessionUntilValid` / 编排循环：
  - [ ] 有进展信号时，用 supervisor 取代现有总时长 watchdog
  - [ ] 无进展信号时，保留现有 watchdog
  - [ ] 硬上限继续用 `wall_clock` timer / `wallClockS`
- [ ] 单测：
  - [ ] 持续进展 3× 阈值时间仍不中断
  - [ ] 静默到阈值立即中断，reason 为 `stalled`
  - [ ] 硬上限先到 → `timeout`
  - [ ] human / 无信号路径不挂沉默检查

验证：`pnpm vitest run src/control/liveness src/e2e/timer-inflight.test.ts src/e2e/session-pipeline.test.ts`

**回滚点**：`KEEL_LIVENESS_MODE=wallclock` 可禁用 supervisor；现有 watchdog 代码保留。

## 5. 独立 Patrol

- [ ] `src/timer/patrol.ts`：
  - [ ] 扫描候选（只读，`owner_heartbeat_at` 过期 + `stall_reported_at IS NULL`）
  - [ ] 按 stage policy 过滤 `last_progress_at`
  - [ ] 幂等 claim（`UPDATE ... WHERE stall_reported_at IS NULL`）
  - [ ] `reapStalledRun`：`status='TIMEOUT'`, `error_kind='RUN_STALLED'`，带 `status='RUNNING'` guard
  - [ ] `driver.advance(taskId, { type: 'RunStalled', stage }, now)`
  - [ ] 每轮写 `worker_health('patrol', ...)`；异常写 `last_error`
- [ ] 接入 timer worker 的 drain 循环（默认 30s 一次；可注入短间隔）
- [ ] 并发测试：
  - [ ] 双 worker 同时 patrol，只产生一条 `RunStalled`
  - [ ] run 已终态时 claim / update 均为 0 行
  - [ ] owner 心跳新鲜时不介入（由 supervisor 负责）
  - [ ] 无 liveness 行的旧 run 不被误判（走墙钟兜底）

验证：`pnpm vitest run src/timer src/e2e/timer-worker.test.ts src/e2e/timer-inflight.test.ts`

**回滚点**：patrol 未接 worker 时不产生任何行为；可单独关闭。

## 6. 事件 / 转移 / 错误接入

- [ ] `TransitionEvent` 增加 `RunStalled`
- [ ] `T-030` / `T-031` 的 `on` 加入 `RunStalled`
- [ ] `InterruptReason` / `CloseReason` 增加 `'stalled'`
- [ ] `ERROR_KINDS` 增加 `RUN_STALLED`，`RETRYABLE` 为 `true`
- [ ] `loop.ts` 映射：`RUN_STALLED → RunStalled`，`RUN_TIMEOUT → RunTimeout`
- [ ] 事件 payload 带证据字段（`silence_ms` / `last_progress_at` / `last_kind` / `owner_heartbeat_at` / `source`）
- [ ] 测试：
  - [ ] 未达 `max_stage_attempts` → 同 stage 新 run
  - [ ] 达到上限 → `S-HUMAN_REVIEW`
  - [ ] `RunStalled` 与 `RunTimeout` 事件类型可区分
  - [ ] `error_kind` 落库为 `RUN_STALLED`

验证：`pnpm vitest run src/control/transition src/control/orchestrator src/timer`

注意：`pnpm run check:transitions` 必须通过 —— 新增事件类型必须能在转移表中被消费。

## 7. 降级与 human 豁免

- [ ] `KEEL_LIVENESS_MODE=progress|wallclock` 解析与校验（非法值拒绝，不静默回退）
- [ ] 默认 `progress`
- [ ] 无 `CAP-STREAM`：`progressSource → 'none'`，只保留硬上限
- [ ] human：`silence` 禁用，`hardCapS: null`
- [ ] 测试：
  - [ ] human run 超过旧 180s 不被中断
  - [ ] wallclock 模式行为与改造前一致
  - [ ] 非法 env 值启动失败并给出明确文案

验证：`pnpm vitest run src/control/liveness src/e2e/human-harness.test.ts`

## 8. 文档与 ADR

- [ ] 新增 `docs/adr/0009-liveness-by-progress.md`（先 Proposed；实现验证后改 Accepted）
- [ ] 更新 `docs/adr/README.md` 索引
- [ ] 更新 `docs/04-state-machine.md` §4 / §6：
  - [ ] `RunStalled` 事件
  - [ ] 两层检测（supervisor / patrol）
  - [ ] 每 stage silence / hard cap 表
  - [ ] `TIMEOUT` 状态 + `RUN_STALLED` 的语义说明
- [ ] 更新 `docs/05-contracts/harness-adapter.md`：
  - [ ] `onProgress` 语义
  - [ ] `interrupt('stalled')`
  - [ ] `CloseReason` 增加 `'stalled'`
- [ ] 更新 `docs/05-contracts/README.md` 错误矩阵：`RUN_STALLED`
- [ ] 更新 `docs/08-cross-cutting.md` §3.4：liveness 与 budget 分离
- [ ] 若 `docs/schemas/` 无事件枚举变更，不需要 `pnpm run generate`；若改了，跑 `pnpm run generate` 并提交生成物

验证：`pnpm run check:generated`

## 9. 全量验证与验收

- [ ] `pnpm run check`（lint / typecheck / boundaries / generated / transitions / purity / test）
- [ ] `pnpm run db:reset && pnpm vitest run src/e2e`（需要 Postgres）
- [ ] 真机冒烟：用一个会持续产出事件的长任务，确认 180s 后不被杀
- [ ] 手工制造静默（暂停模型进程 / 注入无事件 session），确认阈值后 `RunStalled`
- [ ] 杀掉编排进程，确认 patrol 在 ≤ 2 个扫描周期内收割
- [ ] 记录一次真实 `RunStalled` 的 `silence_ms` / `last_kind`，作为阈值校准依据
- [ ] 更新 `task.json` 状态与分支信息；提交前 review diff

**完成判据**：`pnpm run check` 全绿；上述三个冒烟场景都有记录；没有为了「跑绿」跳过 e2e。

## 回滚策略

| 阶段 | 回滚动作 |
|---|---|
| 1–2（parser / 回调） | 删除新增代码，不影响调度 |
| 3（liveness 表） | 保留表；代码不读不写即可 |
| 4（supervisor） | `KEEL_LIVENESS_MODE=wallclock` |
| 5（patrol） | 不接入 timer worker 的 drain 循环 |
| 6（事件 / 转移） | 移除 `RunStalled` 消费；`RUN_STALLED` 保留为未使用 kind 或回滚注册表 |
| 7（默认值） | 调回 `LIVENESS_POLICY` 常量；不改 schema |

## 评审门槛

- 评审 1：PRD + 本计划（尤其每 stage 阈值、`develop` 12h、human 豁免）
- 评审 2：第 1–3 步完成后的 parser / store diff
- 评审 3：第 4–6 步完成后的 supervisor / patrol / transition diff
- 评审 4：文档与 ADR；确认后再 `task.py start` / 提交
