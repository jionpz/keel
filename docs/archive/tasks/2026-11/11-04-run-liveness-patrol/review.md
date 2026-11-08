# 评审：运行巡检（run-liveness-patrol）

评审对象：`prd.md` / `design.md` / `implement.md`（2026-11-04 版本）
评审方式：对照当前 `main` 的代码、迁移、契约与已有 e2e，不只看文档自洽。

## 结论

**方向正确，但不能按当前版本直接 `task.py start`。**

两层检测（进程内 supervisor + 独立 patrol）、进展遥测与 Fact 分离、复用 `T-030/T-031`、human 豁免，这些判断都成立。但有 **3 个阻断项**必须先并入计划，否则巡检会在真实竞态下写出脏事实；另有 8 个重要缺口需要明确取舍。

## 阻断项

### B1. 成功路径没有 run 状态围栏，巡检会放大一个已有竞态

**证据**：

- 成功路径更新 run 时没有 `status='RUNNING'` guard：

  ```sql
  UPDATE run SET status='SUCCEEDED', ... WHERE id=$1
  ```

  （`src/control/orchestrator/loop.ts`，成功分支）

- Pipeline 在返回成功**之前**就提交了 `ProposalAccepted` + artifact：

  ```sql
  INSERT INTO event (... 'ProposalAccepted' ...)
  ```

  （`src/control/proposal/pipeline.ts` 的提交事务）

- `keel_commit_artifact` 只校验 `supersedes` 和版本唯一性，不校验 run 是否仍为 `RUNNING`
  （`migrations/1000000000000_initial-schema.sql:180`）。

- 失败路径反而有 guard：`failRunAndAdvance` 的 `UPDATE ... WHERE id=$1 AND status='RUNNING'`
  （`src/control/orchestrator/loop.ts:802`）。成功路径没有。

**后果**：patrol 把 run 标成 `TIMEOUT` 后，仍在运行的 zombie session 可以：

1. 在 pipeline 里提交 artifact（此时 run 已是 TIMEOUT）；
2. 用无 guard 的 `UPDATE` 把 run 从 `TIMEOUT` 覆盖成 `SUCCEEDED`；
3. 在 `commitAll` 里把 zombie 的工作区改动提交到 Task 分支。

这不是巡检引入的新 bug，但巡检把窗口从「进程内超时」扩大到「进程崩溃 + 外部收割」，必须一起修。

**必须并入的改动**：

- 成功路径 `UPDATE run ... WHERE id=$1 AND status='RUNNING'`，检查 `rowCount`；为 0 时不得 `commitAll`，返回 `CONFLICT` / `RUN_CANCELLED`。
- Pipeline 的提交事务在插入 `ProposalAccepted` 前校验 `run.id = proposal.produced_by_run AND run.status='RUNNING'`（`FOR SHARE` 或等价检查）；不满足则拒收。
- `commitAll` 只在 run 状态更新成功后执行。
- 新增 e2e：patrol 收割后让 fake session 继续返回成功，断言 artifact / workspace / run 状态都没有被 zombie 覆盖。

**对计划的影响**：PRD 增加「R11 围栏」验收；`design.md` 的「不会写脏 Fact」必须改成「需要新增围栏后才成立」；`implement.md` 增加一步「fencing」。

### B2. OMP 是否实时 flush 未验证，整个进展信号建立在一个假设上

**证据**：

- 研究文档确认 `--mode=json` 是 NDJSON，事件类型包含 `turn_start` / `message_update` / `turn_end`
  （`.trellis/tasks/archive/2026-08/08-23-harness-adapters/research/omp-interface.md` §2）。
- 但研究文档的硬要求是「必须读完整个 stdout 再处理，不得提前关闭管道」
  （同上 §1），当前 `run()` 是完整缓冲（`src/execution/adapters/omp.ts:315`）。
- 没有任何证据证明 OMP 在 stdout 接管道时会**逐行 flush**；如果它在进程退出时才 flush，
  增量解析只能拿到「最后一瞬间的全部事件」，进展信号无效。

**必须并入的改动**：

- 在实现前增加一个 phase 0 spike：spawn `omp --mode=json`，给每行 stdout 打时间戳，
  确认 `turn_start` / `message_update` 在执行期间到达，而不是只在 `agent_end` 前一次性到达。
- 如果 OMP 不实时 flush，本设计需要换进展源（OMP session 文件 mtime、工具副作用、进程 CPU/IO 等），
  不能继续把「增量解析」当作默认方案。这个分叉必须在 `task.py start` 前决定。

### B3. `RUN_STALLED` 的映射位置写错了

**证据**：

- `RunResult` 只有 `status: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED'`
  （`src/contracts/harness-adapter.ts:62`），没有 reason / detail 字段。
- `design.md` 写「adapter 返回 TIMEOUT → RUN_STALLED」，但 adapter 无法表达「这次 TIMEOUT 是 stalled 而不是预算」。
- `HarnessSessionManager` 把 `RunResult.status=TIMEOUT` 固定映射为 `RUN_TIMEOUT`
  （`src/execution/session/manager.ts` 的 `RUN_STATUS_ERROR`）。

**必须并入的改动**：

- 明确由 **Control Plane 的 supervisor** 记录「我调用过 `interrupt('stalled')`」，并在 `runSessionUntilValid`
  返回时把它映射成 `RUN_STALLED`；adapter 契约不新增 reason。
- 或者，如果坚持让 adapter 表达原因，就必须给 `RunResult` 增加 `interrupt_reason`，并同步所有 adapter
  与契约文档。两者选一，不能含糊。
- `CloseReason` / `InterruptReason` 增加 `'stalled'` 仍需要，但它们是可观测性字段，不承担错误映射。

## 重要缺口

### I1. 新表没有 GRANT / Down migration 设计

- `run_liveness`、`worker_health` 需要显式 `GRANT ... TO keel_control`，并写 Down migration。
- 参考 `migrations/1000000000001_timer.sql` 的写法：建表、索引、GRANT、Down 四件套。
- 还要决定 liveness 行的清理策略（终态删除 / 定期 prune），否则表会随 run 数无限增长。

### I2. 心跳写路径会与长事务抢连接，且失败语义未定义

- 进展回调发生在 adapter 的 stdout `data` 事件里；如果直接 `asRole` 写库，会与编排器的事务竞争连接池。
- 需要：独立连接 / 有界队列 / 合并写；DB 写失败只记日志，不得让 Run 失败。
- 进程内沉默计时建议用单调时钟（`performance.now()`），持久化时间戳用 DB / 注入 `now`；
  不要把墙钟跳变带进 liveness 判断。

### I3. 巡检只标 DB，不会杀 zombie 进程

- patrol 没有 `SessionHandle`，无法 `interrupt`；它只能把 run 标成 `TIMEOUT`。
- 编排器崩溃后，OMP 子进程可能被 reparent 继续运行，继续改 worktree、继续烧 token。
- 需要二选一：
  - 记录 `harness_pid` / 进程组，owner 心跳过期后由 patrol 发 `SIGTERM`（注意跨平台与误杀）；
  - 或者重试前强制重置 / 隔离 worktree，并明确「zombie 的改动不会进入新 run」。
- B1 的 fencing 只能阻止 zombie 写 Fact Plane，不能阻止它改工作区。

### I4. 10h 长任务的执行载体没有定义

- `keel run-task` 是一次性进程：终端关掉 / SSH 断开，进程就没了（patrol 能收割，但任务不会继续跑）。
- `keel poller` 是常驻的，但 `runIssue` 是**串行 await**（`src/ingress/poller.ts`），
  一个 10h 的 issue 会阻塞后续所有 issue 的轮询。
- PRD 声称支持 10h `develop`，但没有说明用哪个进程承载。必须在 PRD 里写清楚：
  - 用 `run-task` + 外部 supervisor（tmux/systemd）承载；
  - 还是给 poller 增加并发 / detach；
  - 还是本任务只保证「单 run 不被误杀」，不承诺 10h 无人值守。

### I5. 12h hard cap + 全局并发 3 会互相挤压

- `DEFAULT_MAX_RUNNING_RUNS = 3`（`src/control/concurrency/limits.ts`）。
- 一个 12h `develop` 占一个槽位，三个长任务就能让整个系统停止接新活。
- 这不是本任务要解决的调度问题，但 PRD 必须写明这个后果，避免「支持 10h」被理解成「可以同时跑很多 10h」。

### I6. `--wall-clock` 与每 stage hard cap 的优先级未定义

- 现有 CLI `--wall-clock <秒>` 是一个全局数字；改成每 stage 策略后，它到底是：
  - 覆盖所有 stage 的 hard cap（逃生阀），还是
  - 只覆盖默认值、仍受 stage 上限约束？
- 必须写清楚，否则运维抬 `--wall-clock` 时会得到与预期不同的结果。

### I7. `SessionSpec` 有两个定义

- 契约层 `src/contracts/session-manager.ts` 的 `SessionSpec`（run / adapter / context / workspace / limits / checkpoint_policy）
  与执行层 `src/execution/session/manager.ts` 的 `SessionSpec`（runSpec / adapter / expect）不是同一个类型。
- `onProgress` 要加在哪个上面必须明确。建议加在执行层 `SessionSpec`（pipeline 实际使用），
  契约层只描述能力，不引入函数字段；否则要评估它是否会被序列化 / 跨进程序列化。

### I8. 巡检自身没有启动载体与健康检查

- `src/cli/timer-worker.ts` 确实存在（`keel timer-worker --interval`），所以「复用 timer worker」可行。
- 但 patrol 必须在**常驻模式**下运行；单次 drain 不会持续巡检。
- 需要明确：部署时由谁保证 `timer-worker --interval` 常驻；`worker_health` 如何被 healthz / console 读取；
  巡检停摆如何报警。

## 次要问题

- `check-transition-table.ts` 只比对 id / from / to / guardText，不比对 event 单元格；
  给 `T-030/T-031` 加 `RunStalled` 后要**手工**更新 `docs/04-state-machine.md` 的 event 列。
- `run` 表 `error_kind` 没有 CHECK，新增 `RUN_STALLED` 不需要迁移；但 `docs/05-contracts/README.md` 的错误矩阵要同步。
- `RunStatus` 继续用 `TIMEOUT` 是合理取舍，但要在文档里写清楚「TIMEOUT 不等于预算超时」。
- `max_turns: 8` 目前只是声明、adapter 未强制；与本任务无关，但不要在文档里把它当成第二道兜底。
- `HumanAdapter` 目前主要出现在 e2e / 测试路径，生产编排未接线；human 豁免是对的方向，但当前场景是「未来兼容」，不是「已存在的人工路径」。
- `implement.md` 第 3 步写「纯增量」，但新表需要 GRANT / Down migration，不是零风险；调整措辞。
- `run_stuck_idx` 已存在（`run(status, started_at) WHERE status='RUNNING'`），patrol 的候选查询可以复用它，
  但进展判断仍需要 `run_liveness`。

## 做得好的地方

- 把 liveness 与 budget 分开，避免继续用一个数字承担两种职责。
- 两层检测的职责划分（活进程 vs 孤儿 run）是正确的，`owner_heartbeat_at` 是合适的归属判据。
- 进展只作为遥测、决策仍走 `RunStalled` 事件，符合 Control Plane 可重放的不变量。
- 复用 `T-030/T-031` 而不是新增转移，减少了状态机的表面积。
- human 默认豁免，避免把机器时限套在人身上。

## 建议的下一步

1. 先把 B1（fencing）、B2（flush spike）、B3（映射位置）并入 PRD / design / implement。
2. 再决定 I4（10h 载体）与 I5（并发挤压）是否属于本任务，还是拆成后续任务。
3. 评审通过后再 `task.py start`；不要在 fencing 和 flush 结论未定时开始写 supervisor / patrol。

## 处理结果（2026-11-05）

用户选择「全部并入」。落点如下：

| 发现 | 落点 |
|---|---|
| B1 成功路径无围栏 | `prd.md` R11；`design.md` §4.8；`implement.md` 第 2 步 |
| B2 OMP 实时 flush 未验证 | `prd.md` R1；`design.md` §4.0；`implement.md` 第 1 步（门槛） |
| B3 `RUN_STALLED` 映射位置 | `prd.md` R5；`design.md` §4.6；`implement.md` 第 6 步 |
| I1 GRANT / Down / 保留 | `prd.md` R2；`design.md` §4.3；`implement.md` 第 5 步 |
| I2 心跳写路径 / 时钟 | `prd.md` R2；`design.md` §4.3；`implement.md` 第 5 步 |
| I3 孤儿进程清理 | `prd.md` R4；`design.md` §4.5；`implement.md` 第 7 步 |
| I4 10h 载体 | `prd.md` R12；`design.md` §4.9 |
| I5 并发挤压 | `prd.md` R6；`design.md` §4.7；文档同步 |
| I6 `--wall-clock` 优先级 | `prd.md` R6；`design.md` §4.7；`implement.md` 第 9 步 |
| I7 两个 `SessionSpec` | `prd.md` R1/R2；`design.md` §4.2；`implement.md` 第 4 步 |
| I8 巡检载体 / 健康 | `prd.md` R4/R8；`design.md` §4.9；`implement.md` 第 7 步 |
| 次要问题 | `prd.md` AC；`design.md` §9；`implement.md` 第 8、10 步 |

计划已修订，但**没有改生产代码**，也**没有 `task.py start`**。第 1 步 spike 若证明 OMP 不实时 flush，应回到评审而不是继续实现。
