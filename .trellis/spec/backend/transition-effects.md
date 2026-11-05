# 转移表与副作用契约

> 记录**实际**做法。来源：`10-26-run-reentry-wallclock` 任务。
> 数值/算法的上游文档是 `docs/04-state-machine.md` §5；这里是**代码纪律**。

---

## 人工闸门的两个入口

`T-014 / T-015 / T-016`（人工裁决）与 `T-007`（补充澄清）在 2026-11-04 之前**没有任何
生产代码发出对应事件** —— 转移表里有，CLI 里没有。入口补齐在 `src/cli/decide.ts`：

| 命令 | 事件 | 副作用要点 |
|---|---|---|
| `pnpm keel decide … approve` | `HumanApproved` | `CreateBranch` **必须注入 workspace**，否则只记意图、分支并不存在 |
| `pnpm keel decide … reject` | `HumanRejected` | `CleanWorkspace`（T-015）：移除工作树，分支保留 |
| `pnpm keel decide … rework` | `HumanRequestedRework` | `nextRun('brainstorm')` |
| `pnpm keel answer … --text` | `ClarificationReceived` + `feedbackId` | 真写 `task_feedback`；取消澄清 timer；`nextRun('pm')` |

控制台的按钮（`POST /api/tasks/:id/decide|answer`）**只转调这四个函数**，
不实现第二套派发逻辑 —— 页面上点一次和在终端敲一条命令必须产生完全相同的副作用。

三条纪律：

1. **预检在写入之前**。`advance` 对不匹配的事件会如实写 `NoTransition` —— 那是编排该有的记账，
   但对误触的命令来说就是「什么都没做，库里却多了一条」。入口先读 `(status, control_mode)`
   并零写入退出；预检到 advance 之间的竞争仍由 `advance` 的 `advanced:false` 表达。
2. **`control_mode ≠ auto` 时不派发**（`ignoresControlMode: false`）。`paused` 是预算熔断、
   `human` 是人工接管，两者都要求先恢复 —— 而恢复入口（C-003 / C-005 / C-006）尚未提供。
   入口要如实说出这一点，不要让用户以为命令坏了。
3. **`LinkFeedback` 踩在两条路径上**：事件带 `feedbackId` 时真写 `task_feedback` 并发
   `SideEffectApplied`；不带时维持 `recordIntent`。区分它们的是**调用方手上到底有没有 feedback 行**，
   不是「哪种事件」。`T-001` 不经 `applyEffects`（`driver.intake` 自己落事件）。

`feedback` 只能由 `keel_ingress` 写，而 `SET LOCAL ROLE` 是事务级的 —— 所以 `answer` 必然是
两段写：feedback 先落（append-only），control 事务随后完成状态 / 事件 / run / 链接。
framing 成「一个事务」是错的；代价是中途失败会留一条未被引用的 feedback 行，
入口必须在错误里把它的 id 报出来。

## 终态清理：事实先成立，副作用如实记账

`T-015`（`→ S-REJECTED`）与 `T-024`（`→ S-DONE`）都带 `CleanWorkspace`；
`T-027` / `T-040` 的清理语义不变；`T-041`（`→ S-FAILED`）**仍然只保留现场**。
清理只移除 worktree 目录，分支与提交历史留在 git 目录里。

`decide … reject` 的工作区绑定是**按需**的（`cleanupDriverIfNeeded`）：先看
`$KEEL_HOME/worktrees/<taskId>` 是否存在，存在才 `loadTaskWorkspace`（含 fetch）；
不存在就用无绑定 driver，不为一个没开工的任务 clone / fetch。准备失败也不阻断驳回
—— 人的决定不该被网络卡住，此时 `CleanWorkspace` 如实记 `SideEffectIntent`。

`cleanWorkspace` 的两条纪律：

1. **失败不写 `SideEffectApplied`**。`GitWorkspace.remove` 返回 `Result`；
   失败时写 `SideEffectIntent`（`payload.reason` 带原因），返回 `outcome: 'intent'`。
   写成 Applied 会让事件流声称「已清理」而磁盘上还留着工作树 —— 那是在污染
   唯一的事实来源。
2. **失败不回滚终态**。S-DONE / S-REJECTED 是已经成立的事实，清理只是副作用；
   `cleanWorkspace` 不抛异常，`TaskStatusChanged` 照常写入。

## CI 事件必须带来源

`CIPassed` / `CIFailed` 的 `source` 是**必填**字段：`simulated`（注入回调 / CLI 缺省）
或 `github`（`CiGateway` 读真实 Checks / Status）。值落到
`TaskStatusChanged.payload.source`，事件流因此不读代码就能回答
「这次 CI 是真跑的，还是模拟的」。

- 用必填字段而不是默认值：默认值会让「忘了传」悄悄变成「真 CI」。
- 非 CI 事件**不多出** `source` 键（`driver.test.ts` 钉住）。
- CLI 缺省仍是 `--ci passed`；是否改成 `real` 是产品决策，不在副作用层解决。

## 裁决理由：`advance` 的第 4 参

`advance(taskId, event, now, { note })` —— 只有人工命令传。成功转移后在同一事务内写一条
`HumanDecision` 事件（`payload: { decision, note }`），位置在 `TaskStatusChanged` 之后。

- 不塞进 `TaskStatusChanged` 的 payload：状态变更事件只该描述状态变更本身，
  时间线要能把理由单独渲染成一行。
- 不单独开事务写：那会造出「状态变了、理由丢了」的中间态。
- `note` 不进 prompt、不参与 guard —— 它只是给人看的记录。

## `CreateRun` 的 attempt 由副作用决定，键由事件决定

```ts
firstRun(stage) → [{ kind: 'CreateRun', stage, attempt: 'first' }]   // attempt 恒为 1
nextRun(stage)  → [{ kind: 'CreateRun', stage, attempt: 'next' }]    // attempt = 已有 run 数 + 1
```

键是 `${taskId}/${stage}/${attempt}`，`run (idempotency_key)` 上有唯一约束。
**不要**在执行器里给「撞键」加兜底（例如撞了就 +1）：
键必须由事件唯一决定，否则同一事件重放会算出不同的键，造出重复 run；
而且 `SideEffectSkipped` 会不再能区分「重放」与「派发丢失」。

## `firstRun` 只允许用在「一次 Task 生命周期内至多进入一次」的转移

| 转移 | 阶段 | 为什么可以 `first` |
|---|---|---|
| `T-002` | `pm` | `S-NEW` 只由 `T-001`（intake，一次性）进入 |
| `T-003` | `brainstorm` | `S-PM_ANALYZING` 的二次进入走 `T-007` 的 `nextRun(pm)`，没有转移从别处回到它 |
| `T-004` | `rfc_draft` | 理由同 `T-003` |

**返工 / 回炉会再次经过的阶段一律 `nextRun`：**

| 转移 | 阶段 | 二次进入路径 |
|---|---|---|
| `T-010` | `rfc_draft` | `T-016`（人工回炉）→ `S-BRAINSTORM` → 收敛 → 再走一次 T-010 |
| `T-012` | `develop` | `T-019` / `T-022` / `T-025` 返工，`T-014` 人工批准 |
| `T-017` | `qa` | `T-019` QA 返工后开发成功 |
| `T-018` | `review` | `T-022` 评审返工后 QA 通过 |

每处 `nextRun` 都要在 `table.ts` 里写一行注释点明**二次进入路径**，
让后来者不必重推状态图。判断口诀：**这个阶段会不会被同一个 Task 进第二次？**

### 强制手段：白名单 + 双向断言

`src/control/transition/transition.test.ts` 的 `ALLOWED_FIRST_RUN` 列出允许 `firstRun`
的转移 id，实际用 `firstRun` 的转移集合必须与它**完全相等** ——
多一条（有人新写 `firstRun`）红，少一条（有人把白名单项改成 `nextRun` 后忘了删）也红。
断言对象是**转移 id**，不是阶段名：`rfc_draft` 同时出现在 `T-004`（first）与
`T-010`（next），按阶段断言看不出区别。

改这张表时的固定动作：先改 `table.ts`，再跑 `pnpm vitest run src/control/transition`，
然后把任一处 `nextRun` 临时改回 `firstRun` 确认检查**真的会红**，最后还原。
只跑绿不算验证 —— 没有红过的检查可能只是没在检查。

## 撞键必须可归因

`createRun` 的 `ON CONFLICT DO NOTHING` 命中时，除了 `SideEffectSkipped` 还要写
`existing_status`（同键 run 的当前状态）：

| `existing_status` | 含义 | 该做什么 |
|---|---|---|
| `PENDING` / `CLAIMED` / `RUNNING` | 真重放：那次派发还在，本来就没活干 | 什么都不用做 |
| `SUCCEEDED` / `FAILED` / … | **派发丢失**：表里用了 `firstRun` 或 attempt 算错 | 按本节改表；别在事件流里加「已跳过」以外的猜测 |

只记「跳过」会让这两种情况长得一模一样，而它们的处理方式完全相反。
**不加**中止逻辑：状态早在本轮 `advance` 里写过了（见
[database-guidelines](./database-guidelines.md) 的 `asRole` 一节）。

## Task 级 timer 三件套与 TTL 配置（11-05-human-review-ttl）

`timer` 表是**可变状态机**（`pending → fired | cancelled`），不是 append-only。
Task 级 TTL 只有两条：`clarification_ttl`（T-005 起，T-007 取消，T-008 收割）与
`human_review_ttl`（5 条进入 `S-HUMAN_REVIEW` 的转移起，T-014/15/16 取消，T-028 收割）。
`wall_clock` 属于 Run 级（R-009），**不经过**三件套。

| 副作用 | SQL 语义 | 重放安全 |
|---|---|---|
| `StartTimer(kind)` | `INSERT ... ON CONFLICT (task_id, kind) WHERE state='pending' DO NOTHING` | 已有 pending → `SideEffectSkipped` |
| `CancelTimer(kind)` | `UPDATE ... WHERE state='pending'` | 0 行 → `skipped` |
| `ConsumeTimer(kind)` | `UPDATE ... SET state='fired', fired_at=now WHERE state='pending' AND due_at <= now` | 0 行 → `skipped` |

四条纪律：

1. **进入等 TTL 的状态必须武装、离开必须取消。** 漏 `CancelTimer` 的失效不是报错，
   而是下一次进入时新的 `StartTimer` 被部分唯一索引挡成 `skipped` —— 任务静默失去 TTL。
   `T-016`（回炉）尤其容易漏：回炉后会经 `T-010 → T-011 → T-013` 再次进入。
2. **终态转移（`T-040` / `T-041`）取消两类 Task 级 timer**，终态不留 pending 行。
3. **`claimDueTimers` 的 `JOIN task ... status=$state` 是第二道防线**：
   澄清只 claim `S-NEED_CLARIFICATION`、人工裁决只 claim `S-HUMAN_REVIEW`。
   即使取消逻辑出 bug，失效模式也只是「一行不动的数据」，不会每轮被唤醒。
   默认 `kind='clarification_ttl'`，既有调用无需改动；`FOR UPDATE OF t` 只锁 timer 行，
   不锁 task 行（后者属于 advance 的事务）。
4. **纯度不破**：`transition()` 只返回 `StartTimer` / `CancelTimer` / `ConsumeTimer`
   描述，不读 env、不读时钟。`KEEL_HUMAN_REVIEW_TTL_H` 只在 CLI 解析、在
   `effects.ts` 计算落库的 `due_at` 时使用。`EffectContext.humanReviewTtlMs`
   可选字段让测试注入 `null`（关闭）/ 短 TTL，不必改全局常量。

配置解析（`src/shared/timers.ts` 的 `parseHumanReviewTtlHours`）：

| 值 | 行为 |
|---|---|
| 未设置 | 默认 24h |
| 正整数 | 该小时数 |
| `0` | 关闭调度：`StartTimer` 返回 `skipped`，不插行 |
| 负数 / 非整数 / 空串 | 抛错（fail-closed），CLI 在任何数据库动作前转成 `Result` 错误 |

## 常见错误

| 错误 | 后果 |
|---|---|
| 给返工阶段写 `firstRun` | 第二次派发撞键 → 没有 PENDING run。编排器现在会报错（见 [orchestrator-loop](./orchestrator-loop.md)「阶段态没有待执行 run」）；在 2026-10-26 之前它是静默收工，任务停在原状态、退出码 0 |
| 在执行器里给撞键加 +1 兜底 | 重放会造重复 run；`SideEffectSkipped` 失去含义 |
| 白名单只断言「都在允许集里」 | 少一条白名单（有人改成 `nextRun`）不会被发现 |
| 新增副作用时忘了「必须幂等」 | 重放重复开 PR / 重复发通知（`docs/04-state-machine.md` §5.2） |
| 进入等 TTL 的状态忘了 `StartTimer`，或离开忘了 `CancelTimer` | 任务静默失去 TTL / 残留 pending 行；两者都不报错 |
| 在转移表里读 `KEEL_*` 环境变量 | 破坏可重放性；`check:purity` 会红 |
