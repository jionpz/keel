# 执行计划 · 编排停止原因可区分

> 目标文件集中：`src/control/orchestrator/loop.ts` + 两个 CLI 入口 + 测试。
> 不动转移表、不动 `failRunAndAdvance` 的重试判定、不新增事件类型。

## 步骤

### 1. 类型 + 六处 `stopReason`

`src/control/orchestrator/loop.ts`

1. 新增并导出 `StopReason`（取值见 `design.md` §3）。
2. `RunToCompletionResult` 加 `readonly stopReason: StopReason`（**必填**）。
3. 六个既有 `return ok({ finalStatus, steps })` 各补 `stopReason`：
   `terminal` / `paused` / `awaiting-clarification` / `awaiting-external-ci` /
   `capability-denied` / 阶段态分支见步骤 2。

**验证**：

```bash
pnpm run typecheck
```

### 2. 阶段态判据（本任务的核心）

`loop.ts` 阶段态分支（`const pending = await readPendingRun(...)` 之后）：

1. `isStageStatus(state.status)` 时读**最近一次 run**（`ORDER BY started_at/attempt` 取一行，
   `SELECT stage, attempt, status`），按 `design.md` §2 判定：
   - `CANCELLED` → `ok` + `stopReason='cancelled'`
   - 其余（含无 run）→ `err(makeError('NOT_FOUND', …))`，detail 必含：
     当前状态、最近 run 的 `stage/attempt/status`（无 run 时明说）、
     以及「查 `SideEffectSkipped` 的 `existing_status`」这句下一步提示
2. 非 stage status（只可能是 `S-HUMAN_REVIEW`）→ `ok` + `stopReason='awaiting-human'`。
   用 `switch` 穷举 `GATE_STATUSES`，其余情况（理论上不可达）给出显式分支而不是静默 `ok`。

**验证**：

```bash
pnpm vitest run src/control/orchestrator
```

**负对照（必做，做完立刻还原）**：把判据改成「一律 `ok`」，AC1 / AC6 必须变红；
还原后再跑必须绿。结果记进本文件末尾。

### 3. 单元 / 端到端测试

- `src/control/orchestrator/` 新文件（如 `stop-reasons.test.ts`）：
  - **AC1**：种 `task.status='S-QA'` + 一条 `SUCCEEDED` 的 `run(qa,1)`、无 PENDING →
    `runTaskToCompletion` 返回 `err`，detail 含 `S-QA` 与 `qa/1/SUCCEEDED`
  - **AC6**：同装置但 run 状态 `RUNNING` → `err`，detail 点名 RUNNING
  - **AC1'**：该 task 根本没有 run（阶段态）→ `err`
  - **AC2**：`CANCELLED` → `ok` + `stopReason='cancelled'`
- 扩展既有用例断言 `stopReason`：
  - `src/control/orchestrator/run-failure.test.ts` 用例 C（CANCELLED）
  - `src/cli/run-task.test.ts:170`（`S-HUMAN_REVIEW` → `awaiting-human`）
  - `src/e2e/budget-fuse.test.ts`（`S-PM_ANALYZING` + `control_mode≠auto` → `paused`）
  - `src/control/orchestrator/critic-path.test.ts`（capability 被拒 → `capability-denied`）
  - `src/e2e/timer.test.ts`（澄清 TTL 未到期 → `awaiting-clarification`）

**验证**：

```bash
pnpm vitest run src/control/orchestrator src/e2e src/cli
```

### 4. CLI 话术 + 退出码

`src/cli/run-task.ts` 的 `printRunResult`：加一行 `stopped: <reason>（<中文说明>）`，
`finalStatus:` 行保持不动。`run-issue.ts` 复用同一函数，无需另改。

**验证**：

```bash
pnpm vitest run src/cli
```

**REVIEW GATE 2**：`keel run-task` 对合法停仍退出码 0；对故障退出码 1 且输出里
能看到状态 + 最近 run + 下一步提示。

### 5. 文档与 spec 同步

- 新增 `.trellis/spec/backend/orchestrator-loop.md`：停止原因判据、合法停清单、
  **单进程前提**（`RUNNING` 判定的适用边界）、「只报告不修复」。
- `docs/` 目前没有描述这条循环停止语义的段落（已 grep 确认），所以不动 docs；
  只需改 `.trellis/spec/backend/transition-effects.md` 的「常见错误」表 ——
  那里仍写着「驱动『无活可干』收工，任务静默停在原状态」，本任务之后该现象会变成报错。
- `.trellis/spec/backend/index.md` 登记新文件。

**验证**：

```bash
pnpm run check:transitions   # 确认没碰转移表
```

### 6. 全量门槛

```bash
pnpm run check
```

---

## 回滚

| 范围 | 做法 | 残留 |
|---|---|---|
| 全部 | `git revert <commit>` | 无（无 schema / 无迁移 / 无新事件类型） |
| 仅 CLI 话术 | 撤 `printRunResult` 那一行 | 无 |

## 不做

- 不新增 `ErrorKind`（`design.md` §4）
- 不自动重派 / 不自动改 `control_mode`（`prd.md` R7）
- 不改 `T-030` / `T-031` / `retryable`
- 不做多进程租约（`prd.md` Non-Goals）

## 负对照记录

| # | 做了什么（临时改动） | 预期 | 实际 |
|---|---|---|---|
| N1 | 把阶段态判据整体改回 `return ok({ finalStatus: state.status, steps, stopReason: 'terminal' })`（即「没有 PENDING run 就收工」） | AC1 / AC6 / AC1' 三条变红，其余 6 条仍绿 | ✅ 红 3 绿 6（`stop-reasons.test.ts`：`SUCCEEDED` / `RUNNING` / 无 run 三条失败，detail 断言拿不到 error） |
| N2 | 还原 N1 后重跑 | 9 条全绿 | ✅ 9 passed |

N1 的红是**断言真的在断言**：三条失败都停在 `expect(r.ok).toBe(false)`，
不是被别的错误掩盖。若不改回 `ok` 只是删掉判据，TypeScript 会因为 `stopReason` 必填
先拦住 —— 这层编译期防线的存在本身也是 `stopReason` 设为必填的理由。

补充：整轮 `pnpm run check` 前 Biome 报 `loop.ts` import 未排序（新增的
`isStageStatus` 插错位置），`biome check --write` 后全绿 —— 已含在最终提交里。

