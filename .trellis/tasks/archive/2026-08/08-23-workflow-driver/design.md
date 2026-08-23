# Design — Workflow driver

---

## 1. 结构

```
src/control/driver/
├── facts.ts      # 从 Fact Plane 组装 facts（读）
├── effects.ts    # SideEffect 描述 → 真实动作（写，幂等）
├── driver.ts     # advance()：编排上述两者 + transition()
└── *.test.ts
```

**为什么不放进 `src/control/transition/`**：那个目录受纯函数约束，
不得有任何 I/O。驱动器恰恰全是 I/O。分开放，边界规则才能各管各的。

## 2. `advance()` 的事务边界

```
BEGIN (as keel_control)
  1. SELECT task FOR 读取 status / control_mode
  2. loadFacts(task)                     ← 只读 Fact Plane
  3. transition(status, mode, event, facts)   ← 纯函数，无 I/O
  4. 若 matched=false → 记 NoTransition 事件，COMMIT，返回
  5. applyEffects(effects)               ← 幂等
  6. UPDATE task.status
  7. INSERT event TaskStatusChanged（payload 含 transition ID）
COMMIT
```

第 3 步是纯的，第 5–7 步是副作用 —— **顺序不能反**：
必须先算出该做什么，再去做。这正是 `ADR-0003` 把副作用做成"返回值中的描述"的意义。

### 为什么第 7 步在第 6 步之后

不变量 `I4` 要求状态变更必然伴随事件。同事务内两者都写，顺序不影响原子性，
但把事件放最后让它能记录**最终**的 `to` 状态。

## 3. 幂等的落点

**不发明新机制**，复用已有的三处：

| 机制 | 覆盖 |
|---|---|
| `run.idempotency_key` 的 `UNIQUE` | `CreateRun` |
| `artifact` 的 `UNIQUE (task_id, kind, key, version)` | 产物提交 |
| **`(task_id, event_seq)` 判重** | 通知类副作用 |

第三项需要一张轻量的 `side_effect_log` 表？——**不需要**。
`event` 表本身就能承担：施加前先查「是否已有针对该 `(task_id, effect_kind, dedupe_key)` 的
`SideEffectApplied` 事件」。

> 这比新建一张表好：副作用的施加记录**本来就该在事件流里**，
> 否则「这个 Task 到底发生了什么」的答案就散在两个地方。

## 4. `matched: false` 不是错误

`transition()` 可能返回三种不匹配原因：`no_rule` / `control_mode_not_auto` / `guard_failed`。
三者都是**正常的业务状态**，不是故障：

- `paused` 时收到事件 → 不推进，这正是暂停该有的行为
- 终态收到事件 → 不推进
- guard 未过 → 等待条件满足

因此 `advance()` 返回 `Result<AdvanceOutcome>` 且 `ok: true`，
`AdvanceOutcome.advanced: false` + 原因。**只有真正的故障才返回 error。**

如实记一条 `NoTransition` 事件 —— 否则事件流会缺失"系统看到了这个事件但没动"这个事实。

## 5. 未落地副作用的处理

v0.1 不做真实 git / 通知。但**不能静默跳过** ——
那会让事件流声称做过了而实际没有。

做法：记 `SideEffectIntent` 事件，payload 含 `kind` 与参数。
子任务 7 接入真实 git 时，把这些分支换成真实实现即可，事件流语义不变。

## 6. 时间注入

`advance(task_id, event, now)`。`now` 一路传到 `PolicyEngine.evaluate()`。

驱动器目录**加入 `check:purity` 的扫描范围？——不加。**
驱动器必须做 I/O，它不是纯的。但它仍属 Control Plane，因此：

- 加一条边界规则：`driver` 不得依赖 `src/execution`（不调 LLM 的结构性保证）
- `now` 由参数注入，而不是 `new Date()` —— 这条靠**测试**保证，
  不靠扫描（扫描会误伤合法的时间戳格式化）

> 诚实说明：这里的「不读时钟」是靠 code review + 测试保证的，
> 强度低于 transition / policy 那两处的机械检查。
> 若日后发现被违反，再考虑给驱动器加一条更精确的检查。

## 7. 风险

| 风险 | 对策 |
|---|---|
| 事务里做太多事导致锁持有过久 | v0.1 副作用都是本地的；接入 git/网络后必须把它们移出事务（届时改用 outbox） |
| `loadFacts` 读不到某个 fact | 抛错而非当作默认值 —— 静默默认会让 guard 判错 |
| 幂等判重查询本身成为热点 | 加 `(task_id, type)` 索引；v0.1 规模下不成问题 |
