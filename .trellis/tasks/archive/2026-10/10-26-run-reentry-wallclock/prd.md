# 修 firstRun 重复进入撞幂等键，并给 run-task/run-issue 加 --wall-clock

## Goal

两件与「编排能不能真的把一条 Task 推到终态」直接相关的事：

1. **重复进入的阶段不再静默卡住**：返工 / 回炉重新出 RFC 这些路径回到某个阶段时，
   必须真的派发下一次 Run，而不是撞上 `run(qa,1)` 的幂等键、记一条
   `SideEffectSkipped`、然后整个 Task 停在原地没有任何失败信号。
2. **墙钟上限可以从命令行调**：`wallClockS` 只有 SDK 入口，`keel run-task` 无法指定，
   而真机 develop 实测 166s、默认 180s 只差 14 秒。

## 背景（问题证据）

### A. `firstRun` 在可二次进入的阶段必然撞键

`createRun` 的 attempt 计算（`src/control/driver/effects.ts:185`）：

```ts
const attempt = effect.attempt === 'first' ? 1 : Number(prev.rows[0]?.n ?? 0) + 1
const key = `${ctx.taskId}/${stage}/${attempt}`          // effects.ts:188
// INSERT ... ON CONFLICT (idempotency_key) DO NOTHING   // effects.ts:190
if (ins.rowCount === 0) {                                // effects.ts:197
  await emit(c, ctx, 'SideEffectSkipped', { kind: 'CreateRun', idempotency_key: key }, ctx.now)
  return { kind: 'CreateRun', outcome: 'skipped', detail: `${key} 已存在` }
}
```

`attempt: 'first'` **永远算出 1**。所以只要该阶段已有一次 run，第二次进入就必然
key 冲突 → `ON CONFLICT DO NOTHING` → 只有一条 `SideEffectSkipped` → **没有
`RunCreated`，没有 PENDING run** → 驱动无事可做，Task 停在原状态，
且**没有任何失败事件**。

留空的 `firstRun` 站点（`src/control/transition/table.ts`）与它们的二次进入路径：

| 转移 | 阶段 | 二次进入路径 | 后果 |
|---|---|---|---|
| `T-010` | `rfc_draft` | `S-HUMAN_REVIEW` --T-016--> `S-BRAINSTORM` --T-010--> | 人工判定 RFC 方案有问题要回炉时卡住 |
| `T-012` | `develop` | 同上重新出 RFC → `T-011` → `S-RFC_READY` --T-012--> | 回炉后无法重新开发 |
| `T-017` | `qa` | `S-QA` --T-019--> `S-DEVELOPING` --T-017--> | **QA 判 fail 返工后卡在 `S-QA`** |
| `T-018` | `review` | `S-REVIEW` --T-022--> `S-DEVELOPING` → … --T-018--> | 评审判 fail 返工后卡在 `S-REVIEW` |

其中 T-017 是可复现、且没有人工环节的那条：`docs/07-flows.md` §3 流程三第 2 步
「`dev_attempts=1 < max=3` → 返工」在当前实现下走不完 —— 返工后 develop 成功，
`RunSucceeded` 命中 T-017，`firstRun('qa')` 撞 `run(qa,1)`，Task 停在 `S-QA`。

`docs/04-state-machine.md:102-103` 的产物列写着「创建 `run(qa, 1)`」「创建
`run(review, 1)`」—— **文档与代码一起把「只会有一次」当成了事实**。

### B. `--wall-clock` 没有 CLI 旗标

`RunTaskOptions.wallClockS` 存在（`src/cli/run-task.ts:213`，注释：「默认 180。
验收/慢模型可抬高，不改全局默认」），`runTask` 也把它透传给 `deps`
（`run-task.ts:297`）；`run-issue` 同样（`src/cli/run-issue.ts:39,91`）。
但 `src/cli/index.ts` 的 HELP（第 8、12、31、35 行）与两个命令的 `parseArgs` 分支里
**没有任何 `wall-clock`**，`keel run-task --wall-clock 600` 只会被 `parseArgs` 记进
`flags` 然后丢掉 —— 用户以为设了，实际仍是 180。

## Requirements

### A. 重复进入

- **R1 该用 next 的四处改成 next**：`T-010` / `T-012` / `T-017` / `T-018` 的
  `firstRun(...)` 改为 `nextRun(...)`，使二次进入算出 `attempt = 既有条数 + 1`。
- **R2 不该改的不动**：`T-002`（pm）/ `T-003`（brainstorm）/ `T-004`（rfc_draft）
  保持 `firstRun` —— 它们的派发转移在一个 Task 生命周期内只可能命中一次
  （`S-NEW` 只从 T-001 进入；`S-PM_ANALYZING` 的二次进入走 T-007 的 `nextRun('pm')`，
  不会再命中 T-003/T-004）。**改它们只会让「重复投递」被当成「新派发」。**
- **R3 撞键必须可归因**：`CreateRun` 的键冲突若来自「同键 run 已经终态」，
  那不是重放而是派发丢失 —— `SideEffectSkipped` 里必须带上**既有 run 的状态**，
  让「Task 为什么停在这里」能从事件流直接答出来。同键 run 仍 `PENDING` 时保持
  现行「跳过」语义（那才是真正的重放）。
  **不做**在检测到丢失时中止本次 advance：`asRole` 只在 throw 时 `ROLLBACK`，
  `return err` 仍会 COMMIT（`src/fact/db.ts:53-58`），用它当「撤销」会把已经写下的
  状态更新一起落库 —— 比静默更糟。
- **R4 防复发**：新增一条检查，把「哪些转移允许用 `firstRun`」钉成显式清单；
  以后有人给一个可二次进入的阶段加 `firstRun`，检查必须红，而不是等真机跑到返工才发现。
- **R5 文档同步**：`docs/04-state-machine.md` 里 T-017/T-018（以及 T-010/T-012）
  的产物列不能再写死 `run(x, 1)`；`docs/07-flows.md` 若因此有措辞变化一并改。

### B. 墙钟旗标

- **R6 两个命令都要有**：`keel run-task` 与 `keel run-issue` 支持
  `--wall-clock <秒>`，透传到 `wallClockS`。
- **R7 非法值拒绝**：非数字 / ≤0 / 非整数一律报错退出（沿用 `parseCiMode` /
  `resolveHarness` 的「不静默回退」约定），不许悄悄退回 180。
- **R8 帮助文本同步**：`src/cli/index.ts` 的 `HELP` 与命令内的用法串都要出现该旗标。

## Acceptance Criteria

- [x] **AC1** `T-019` 的既有用例（`src/control/driver/driver.test.ts:319`）继续往后走：
      QA fail → 返工 develop 成功 → 断言**新建了** `run(qa, 2)`，且该次没有
      `CreateRun` 的 `SideEffectSkipped`。
- [x] **AC2** `T-022`（评审判 fail）路径同样能退出 `S-REVIEW` 并新建 `run(review, 2)`。
- [x] **AC3** `T-016`（人工判 RFC 有问题）路径能新建 `run(rfc_draft, 2)`
      并继续到 `S-RFC_READY`，`T-012` 之后新建 `run(develop, 2)`。
- [x] **AC4** 键冲突时 `SideEffectSkipped` 的 payload 带 `existing_status`：
      同键 run 已终态时一眼看出「派发丢失」，仍 PENDING 时看得出「这是重放」。
      `driver.test.ts:393` 那条既有用例保持绿，并补一条终态碰撞的用例。
- [x] **AC5** `firstRun` 白名单检查存在且双向断言（多一条、少一条都红）；
      负对照：给一处可二次进入的转移临时加 `firstRun` → 检查确实变红。
- [x] **AC6** `keel run-task <id> --wall-clock 600` 与 `keel run-issue <url> --wall-clock 600`
      都把 600 传进 `runTask` / `runIssue` 的 `wallClockS`（单元测试断言，不起真进程）。
- [x] **AC7** `--wall-clock 0` / `-5` / `abc` / `1.5` 被拒绝且退出码非 0，报错信息说明期望值。
- [x] **AC8** `pnpm run check` 全绿（含 C4 转移表 ⟷ 文档一致性检查）。

## Non-Goals

- **不动 `createRun` 的键构造**（不把 `first` 改成「撞了就 +1」）。键必须由事件决定：
  在 apply 时按当前计数回退，等于让同一事件在重放时算出不同的键，会造出重复 run；
  而写 `ON CONFLICT` 的 `attempt` 一旦变成「尽力而为」，`SideEffectSkipped` 就不再
  能区分「重放」与「派发丢失」。修的是表，不是执行器。
- **不改默认 180s**。默认值是对「一次 run 该花多久」的声明，调它需要独立证据；
  本次只把上限做成可调。
- 不做 `KEEL_WALL_CLOCK` 环境变量（需求只到命令行；需要时按 `KEEL_HARNESS` 的样式另加）。
- 不处理 `T-030`（`nextRun('SAME')`）的重放语义 —— 它已经按计数走，与本缺陷不同类。
- 不改「没有 PENDING run 时驱动就收工」的循环语义。那是另一条缺陷：
  滞留时 `run-task` 会**正常退出且退出码 0**，把 `S-QA` 当终态报给用户。
  本任务只保证派发不再丢失、丢失可归因；退出语义单独立项。

## Notes / 风险

- R3 只加 payload 字段，不新增事件类型 —— 事件的类型词表是封闭的
  （`src/generated/artifacts.ts:141`），新增一种要走 schema 生成链路，
  而这里要的是「可归因」，不是新语义。
- 改 `T-012` 后，`develop` 的 attempt 完全由「该阶段既有 run 数」决定；
  这与 `T-019` / `T-022` / `T-025` 的既有语义一致，不引入新的计数规则。
