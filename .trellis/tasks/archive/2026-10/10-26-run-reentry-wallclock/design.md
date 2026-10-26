# 设计 · firstRun 重复进入 + --wall-clock

## 1. 不变量

1. **Run 的幂等键由事件决定，不由「当前计数」碰运气**：
   `(task_id, stage, attempt)` 一旦写下就不能因为重放而变成另一个键。
2. **`SideEffectSkipped` 只表示「这件事已经做过了」**，不表示「这件事做不了」。
   两者混在一起，一次派发丢失就会伪装成一次成功重放。
3. **阶段在一次 Task 生命周期里能不能二次进入，是表的结构属性，不是执行器的判断**。

## 2. 方案对比：改表 还是 改执行器

| | 改 `createRun`（撞了就 `count+1`） | **改转移表（本文选定）** |
|---|---|---|
| 幂等键稳定性 | ❌ 重放时计数已变 → 算出新键 → 造出第二个 run | ✅ 键仍由「既有条数 +1」在**同一事务**内算出，回滚即复原 |
| `SideEffectSkipped` 的语义 | 被稀释成「尽力而为」 | 保持「已做过」 |
| 能修掉哪一类 | 掩盖全部撞键（包括真的重放） | 只修「表写错」这一因 |
| 复发防线 | 无（错了也不报） | 白名单检查在 CI 期变红 |

决策依据是**不变量 2**：执行器如果自己猜「撞了大概是想再派一次」，那它就没有信息
再区分「重放」与「丢失」。这个判别信息只在表里（该转移能不能二次命中），
所以修表。

## 3. 逐处判定

`attempt` 的唯一算法在 `src/control/driver/effects.ts:185`：

```ts
const attempt = effect.attempt === 'first' ? 1 : Number(prev.rows[0]?.n ?? 0) + 1
```

`'first'` 恒等于 1 ⇒ **只有「该转移在一个 Task 里至多命中一次」时它才成立**。
下面逐条核对该转移的 `to` 状态能否被再次进入。

| 转移 | 阶段 | 二次进入路径 | 判定 |
|---|---|---|---|
| `T-002` | pm | `S-NEW` 仅由 `T-001`（intake，一次性）进入 | ✅ 留 `first` |
| `T-003` | brainstorm | `S-PM_ANALYZING` 的二次进入走 `T-007` 的 `nextRun('pm')`；而 `T-003` 只在 pm 成功后命中一次 —— 没有任何转移从 `S-BRAINSTORM` 回到 `S-PM_ANALYZING` | ✅ 留 `first` |
| `T-004` | rfc_draft | 同上，`S-PM_ANALYZING` 不可再回 | ✅ 留 `first` |
| `T-010` | rfc_draft | `S-HUMAN_REVIEW` --T-016--> `S-BRAINSTORM` --T-010--> | ❌ 改 `next` |
| `T-012` | develop | 同上重新出 RFC → `T-011` → `S-RFC_READY` --T-012--> | ❌ 改 `next` |
| `T-017` | qa | `S-QA` --T-019--> `S-DEVELOPING` --T-017--> | ❌ 改 `next` |
| `T-018` | review | `S-REVIEW` --T-022--> `S-DEVELOPING` → … --T-018--> | ❌ 改 `next` |

对照：`T-014`（人工批准开发）与 `T-019` / `T-022` / `T-025` / `T-030` 已经在用
`nextRun` —— 本任务不是引入新规则，而是把四处漏掉的补上。

## 4. R3：撞键时把「既有 run 的状态」写进事件

`createRun` 的冲突分支（`effects.ts:197-200`）目前只记 `idempotency_key`。
改为先查同键 run 的状态，再落事件：

```ts
if (ins.rowCount === 0) {
  const existing = await c.query<{ status: string }>(
    'SELECT status FROM run WHERE idempotency_key = $1', [key],
  )
  await emit(c, ctx, 'SideEffectSkipped',
    { kind: 'CreateRun', idempotency_key: key, existing_status: existing.rows[0]?.status ?? null },
    ctx.now)
  ...
}
```

读法立刻变成：

| `existing_status` | 含义 |
|---|---|
| `PENDING` / `CLAIMED` / `RUNNING` | 真重放 —— 那次派发还在，无事可做（正常） |
| `SUCCEEDED` / `FAILED` / `TIMEOUT` / `CANCELLED` | **派发丢失** —— 键说「这个阶段这一轮已经跑完」，而有人又要派一次 |

payload 只加字段，**不新增事件类型**：类型词表是封闭的
（`src/generated/artifacts.ts:141`，由 schema 生成），而这里没有新语义。

### 为什么不在这里中止

`asRole` 只在 **throw** 时 `ROLLBACK`，`return err(...)` 仍会 `COMMIT`
（`src/fact/db.ts:50-58`）。而 `advance` 是**先 UPDATE task.status、再 applyEffects**
（`driver.ts:279` → `driver.ts:314`）。所以「检测到丢失就 `return err`」
会把状态更新一并提交 —— Task 前进到 `S-QA` 却没有 run，比滞留更难查。
真要中止只能 throw，而那是把 Result API 变成异常 API，代价大于收益。

> 这条事实（err 不回滚）目前没有任何 spec 记录，属 Phase 3.3 的 spec 候选。

## 5. R4：`firstRun` 白名单检查

放在 `src/control/transition/transition.test.ts`（已有表结构测试）：

```ts
const ALLOWED_FIRST_RUN = {
  'T-002': 'S-NEW 仅由 intake 进入，pm 派发只可能一次',
  'T-003': 'S-PM_ANALYZING 不可回，brainstorm 派发只可能一次',
  'T-004': '同上，rfc_draft 首派只可能一次',
} as const
```

断言**双向**：表里每一处 `attempt === 'first'` 的转移 id 集合 === 白名单键集合。
多一条（有人加了新的 `firstRun`）红，少一条（改回 next 却没删）也红 ——
后者是刻意的：白名单少了它就说明「理由」还挂着，该删的是理由本身。

**负对照**（写进 `implement.md` 的验收步骤，不留在代码里）：临时给 `T-017`
改回 `firstRun('qa')` → 检查必须红。

选择「白名单 + 理由」而不是「静态可达性分析」：后者要处理 `ANY_STAGE` 自环（T-030）
与 `SELF` 自环（T-009），判断逻辑本身就容易出错，而且失败了也说不清是哪条路径；
白名单的失败信息直接指向「你新加了一处 firstRun，请说明为什么它只可能命中一次」。

## 6. B 部分：`--wall-clock`

### 解析形状

仿 `parseCiMode`（`run-task.ts:40`）：返回 `Result<number>`，错误 kind 用
`CAPABILITY_UNSUPPORTED`（与 `--ci` / `--harness` 的既有约定一致），
`detail` 说明「只接受正整数秒，收到 X；不会静默回退到 180」。

```ts
export function parseWallClock(raw: unknown): Result<number | undefined>
// 省略 → ok(undefined)（交给下游默认 180）
// 非数字 / <=0 / 非整数 → err(...)
```

`parseArgs` 会把 `--wall-clock 600` 解析成 `number`（`argv.ts:44` 的 `parseValue`），
把 `--wall-clock abc` 解析成 `string` —— 所以两路都要判。

### 透传

| 层 | 现状 | 改动 |
|---|---|---|
| `index.ts` HELP | 无 | 两个命令各加 `[--wall-clock S]` |
| `runTaskMain` / `runIssueMain` | 无 | 解析 + 校验 + 错误退出 1 |
| `RunTaskOptions.wallClockS` | 已有 | 不动 |
| `runTask` → `deps.wallClockS` | 已有（`run-task.ts:297`） | 不动 |
| `run-issue` | 已有（`run-issue.ts:91`） | 不动 |

即：**只有入口缺，管道本来就通** —— 这也是为什么这一项很小。

## 7. 类型变化

| 位置 | 变化 | 影响面 |
|---|---|---|
| `AppliedEffect['outcome']` | 不变 | — |
| `SideEffectSkipped` 的 `CreateRun` payload | +`existing_status: string \| null` | 读事件的测试需容忍新字段（forward-compat，无需改） |
| `parseWallClock` | 新增导出 | `run-task.test.ts` / `run-issue.test.ts` |
| 转移表 4 行 effects | `firstRun` → `nextRun` | 表结构测试 + 文档产物列 |

## 8. 兼容与回滚

- **数据库**：无 schema 变更、无迁移。
- **已跑过的 Task**：不受影响 —— attempt 仍从「该阶段既有 run 数 +1」算，
  历史数据里 `run(qa,1)` 之后新派发自然是 `qa,2`。
- **回滚**：单个 `git revert` 即可，无残留状态。
- **不兼容点**：无。CLI 新旗标可选，缺省行为与现在完全一致。

## 9. 验证

| AC | 测试锚点 |
|---|---|
| AC1 | `driver.test.ts` 扩 T-019 用例：继续 `RunSucceeded(develop)` → `run(qa,2)` 存在 |
| AC2 | 新增 T-022 用例：`run(review,2)` |
| AC3 | 新增 T-016 用例：`run(rfc_draft,2)` + `run(develop,2)` |
| AC4 | `effects.test.ts`：终态碰撞 → `existing_status` 为终态；PENDING → 仍为 PENDING |
| AC5 | `transition.test.ts` 白名单双向断言（+ 手工负对照） |
| AC6/AC7 | `run-task.test.ts` / `run-issue.test.ts`：600 透传、四种非法值拒绝 |
| AC8 | `pnpm run check` |
