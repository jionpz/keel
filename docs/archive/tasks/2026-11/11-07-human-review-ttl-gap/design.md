# Design · 补齐存量 S-HUMAN_REVIEW 的人工裁决 TTL

## 1. 结论

在 `timer-worker` 的每轮 drain 开头增加一次**对账补齐**：
对 `S-HUMAN_REVIEW` 且 `control_mode='auto'`、没有 pending `human_review_ttl` 的任务，
插入一条 `due_at = now + 当前生效 TTL` 的 pending timer。

它是一个兜底，不是第二套进门逻辑：进门转移仍然负责正常武装；
对账只修复「进门时还没这个功能」的存量任务，以及未来任何漏武装的路径。

## 2. 为什么不是迁移 backfill

| 方案 | 问题 |
|---|---|
| 改 0009 的 Up（issue 建议） | `node-pg-migrate` 按文件名记录已应用迁移；已跑过 0009 的库不会重跑。issue 的实测库正是这种，改了也不修。 |
| 新增 0010 SQL backfill | 修复升级时刻的数据，但纯 SQL 读不到 `KEEL_HUMAN_REVIEW_TTL_H`：硬编码 24h 会破坏 `0 = 关闭调度`；自定义 TTL 也会得到错误窗口。 |
| 新增 JS 迁移读 env | 违反 ADR-0007「迁移用纯 SQL」；迁移结果依赖环境，不可重放；还要重复实现一遍 TTL 解析。 |
| **运行期对账（本方案）** | 使用与 `StartTimer` 同源的生效 TTL；`null` 时天然不补；可测、可自愈；不需要改 schema。 |

关键事实：TTL 只有在 `timer-worker` 运行时才有意义（poller 不收割）。
因此把补齐放在 worker 的 drain 里，不改变部署前提。

## 3. 边界与契约

### 3.1 新增函数

`src/timer/arm.ts`

```ts
export async function armMissingHumanReviewTimers(
  now: string,
  ttlMs: number | null,
): Promise<number>
```

- `now`：注入时间（控制平面不读系统时钟）。
- `ttlMs`：生效 TTL 毫秒；`null` = 关闭，直接返回 0。
- 返回实际插入的 pending 行数（用于 `humanReviewArmed`）。

### 3.2 选中条件

```sql
SELECT k.id
FROM task k
WHERE k.status = 'S-HUMAN_REVIEW'
  AND k.control_mode = 'auto'
  AND NOT EXISTS (
    SELECT 1 FROM timer t
    WHERE t.task_id = k.id
      AND t.kind = 'human_review_ttl'
      AND t.state = 'pending'
  )
FOR UPDATE OF k
```

- `control_mode='auto'`：`paused` / `human` 下 T-028 的 `advance` 不会转移
  （所有转移隐含 `control_mode='auto'`），补了只会每轮被 claim 又 skip。
- 只查 pending：`fired` / `cancelled` 行不阻止新的 pending
  （部分唯一索引也只约束 pending）。
- `FOR UPDATE OF k`：与所有改变 `task.status` 的转移串行。

### 3.3 插入

逐任务插入，SQL 与 `StartTimer` 保持一致：

```sql
INSERT INTO timer (id, task_id, run_id, kind, due_at, state)
VALUES ($1, $2, NULL, 'human_review_ttl', $3, 'pending')
ON CONFLICT (task_id, kind) WHERE state = 'pending' DO NOTHING
```

- `id` 用 `randomUUID()`（与 `effects.ts` 的 `StartTimer` 一致，不引入
  `gen_random_uuid()` 的第二套 UUID 来源）。
- `due_at` 对本轮所有补齐行取同一个值：`new Date(new Date(now).getTime() + ttlMs)`。
- `ON CONFLICT` 是第二道防线：即使有并发插入，也不重复、不改已有期限。

### 3.4 接入点

`src/timer/worker.ts` 的 `drainAllDueTimers`：

```ts
const ttlMs =
  deps.humanReviewTtlMs === undefined
    ? TIMER_DURATIONS.human_review_ttl
    : deps.humanReviewTtlMs
stats.humanReviewArmed = await armMissingHumanReviewTimers(deps.now(), ttlMs)
```

在两类 TTL 的 claim 之前执行。补齐行 `due_at = now + TTL`，本轮不会被收割，
不会产生「刚补就到期」的竞态。

`WorkerDeps` 增加可选字段：

```ts
readonly humanReviewTtlMs?: number | null
```

- `undefined` → 默认 24h（与 `WorkflowDriver` / `StartTimer` 的语义一致），
  既有不传该字段的测试与调用方行为不变。
- `null` → 关闭，不补。
- CLI `timer-worker` 把已经解析好的 `humanReviewTtl.value` 同时传给
  `WorkflowDriver` 和 `WorkerDeps`，两处同源，不会各说各话。

### 3.5 可观测

`ReapStats` 增加 `humanReviewArmed: number`。
`keel timer-worker` 的**单次 drain** 统计行在 `humanReviewFired` 后追加
`humanReviewArmed=<n>`。常驻模式当前没有每轮 stats 日志（既有行为），
本次不新增，避免每个 interval 打一行；需要常驻可观测时另立 follow-up。

## 4. 并发与竞态分析

| 竞态 | 结果 |
|---|---|
| 与进入转移（T-013/T-020/T-023/T-026/T-031）并发 | 进入转移先 `UPDATE task.status` 拿行锁；本对账的 `FOR UPDATE OF k` 与它串行。若进入先提交，本对账的 `NOT EXISTS` 能看到已武装的 timer，不重复插；若对账先提交，进入转移的 `StartTimer` 撞 `timer_pending_key` → `skipped`（该任务已有 TTL，语义正确）。 |
| 与离开转移（T-014/T-015/T-016）并发 | 离开转移先改 `task.status`；本对账的 `FOR UPDATE` 要么先锁住 task（离开等待，随后 `CancelTimer` 取消刚补的行），要么等待后按新状态重新求值而不选中。不会留下挡住下一次 `StartTimer` 的 pending 行。 |
| 两个 timer-worker 并发 | 单实例 advisory lock 已排除常驻双跑；即便绕过，`FOR UPDATE` + `ON CONFLICT` 仍保证不重复、不覆盖。 |
| 补齐行在本轮到期 | 不可能：`due_at = now + ttlMs`，`ttlMs > 0`；本轮 claim 的 `due_at <= now` 不命中。 |

## 5. 兼容性

- 不改表结构、不改 `timer.kind` 约束、不改转移表、不改 T-028。
- `WorkerDeps.humanReviewTtlMs` 可选，`undefined` 保持默认 24h；既有测试不传时不崩。
- `ReapStats` 新增字段会让所有构造字面量的地方需要补一行（编译器会指出）。
- 已发布的 0009 保持不动；不新增迁移。

## 6. 回滚

纯代码回滚：移除对账调用即可。已补的 pending 行是合法的 timer 数据，
旧 worker 仍会按原逻辑收割；不会造成数据损坏。若需清理，可按
`kind='human_review_ttl' AND state='pending' AND task_id IN (存量子集)` 精确删除。

## 7. 验证

- 单测（真实 Postgres + `asRole` 真实权限）：
  补齐 / 幂等 / TTL 关闭 / 自定义 TTL / 非目标状态 / 已有 pending 不改动。
- e2e（真实 `drainAllDueTimers`）：补齐 → 改 `due_at` 到过去 → drain →
  T-028 → `S-ABANDONED`，timer `fired`。
- 反例：移除 `armMissingHumanReviewTimers` 调用，对应用例必须变红。
- `pnpm run check`。
