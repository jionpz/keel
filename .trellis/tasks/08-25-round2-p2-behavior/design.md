# Round 2 P2 行为正确性组 — 技术设计

## 目标

六项 P2 行为缺陷各归其位。共同原则:行为边界正确(不依赖模型自控)、拒绝留痕(不假装成功)、分类真相化(不做错的分类)、终止可依(不无限循环)。

## R5 · brainstorm↔critic 活锁上限

**现状**:T-009(brainstorm→critic)/ T-009b(critic→brainstorm)都是 SELF+nextRun;模型连续 needs_critic=true → 循环至 maxSteps RUN_TIMEOUT。

**修**:critic 最多请求 2 次。`brainstormNeedsCritic` 增加守卫:

```ts
async function brainstormNeedsCritic(taskId: string): Promise<boolean> {
  // 原逻辑
  const body = ...
  const wantsCritic = body?.verdict === 'converged' && body.details?.needs_critic === true
  if (!wantsCritic) return false

  // 活锁上限:critic run 已 ≥2 次 → 强制收敛(第 2 回流后必须走 T-010)
  const r = await asRole('keel_control', (c) =>
    c.query<{ n: string }>(`SELECT count(*) AS n FROM run WHERE task_id=$1 AND stage='critic'`, [taskId]),
  )
  return Number(r.rows[0]?.n ?? 0) < 2
}
```

**语义**:brainstorm(1) 请求 → critic(1) → 回流 brainstorm(2) 请求 → critic(2) → 回流 brainstorm(3) 请求 → **count=2 ≥ 2 → 强制 false** → 走 T-010 → S-RFC_DRAFT。上限 2 次评审,防无限循环,不依赖模型。

## R3 · capability 从 details.capability 确判

**现状**:loop 硬编码 `'critic_review'`(合成 body + 事件),P-ALLOW-CRITIC 恒命中,deny 永不发生。

**修**:capability 值来自 brainstorm 产物 `details.capability`(模型声明):

```ts
if (pending.stage === 'brainstorm') {
  const wants = await brainstormNeedsCritic(taskId)
  if (wants) {
    const capability = await brainstormRequestedCapability(taskId)  // details.capability ?? 'critic_review'
    await synthesizeCapabilityRequest(taskId, pending.id, capability)
    const adv = await deps.driver.advance(taskId, { type: 'CapabilityRequested', capability }, deps.now())
    ...
  }
}
```

`brainstormRequestedCapability` 读 latest stage_outcome 的 `details.capability`,缺省 `'critic_review'`(向后兼容现有提示词——但提示词会加字段说明)。

**提示词**:`prompts.ts` brainstorm 加 `"details":{"needs_critic":true,"capability":"critic_review"}` 示例 + 说明「请求评审时在 capability 注明能力名(当前支持 critic_review)」。

**效果**:模型 `details.capability='other'` → 事件 capability='other' → P-ALLOW-CRITIC 不命中(`=='critic_review'`)→ 默认 deny → T-009 guard false → NoTransition(留痕)→ R4 拦截停。**deny 真正可达了**。

## R4 · guard 未过 = 停,不假装成功

**现状**:CapabilityRequested 的 advance 返回 ok{advanced:false}(NoTransition 已落库),loop `if(!adv.ok)` 不拦截 → 记录 → 无 PENDING → ok 收尾(误报成功)。

**修**:检查 advanced:

```ts
if (!adv.ok) return err(adv.error)
if (!adv.value.advanced) {
  // capability 被拒(缺规则/deny):NoTransition 已留痕,停 —— 需要人工/外部
  steps.push(record(state.status, adv, 'critic', `capability ${capability} 被拒`))
  return ok({ finalStatus: state.status, steps })
}
steps.push(record(...))
continue
```

**语义**:deny 时 loop 返回当前状态(停在 S-BRAINSTORM),不伪造成功。NoTransition 事件记录「看到了但没动」= 诚实留痕。R-007 回灌不适用(那是提案校验,这是转移 guard)。

## R9 · FAILED 标签真相化(纯文档)

**现状**:`RUN_STATUS_ERROR.FAILED='PROTOCOL_ERROR'` —— 语义压平。
**修**:不改代码行为(FAILED 无更贴切 kind,新增 ErrorKind 改动面大+收益低);补:
1. `manager.ts` RUN_STATUS_ERROR 注释:FAILED→PROTOCOL_ERROR 的取舍(Adapter 未细分运行失败类型,PROTOCOL_ERROR 是「运行终止但可重试」的通配;TIMEOUT/CANCELLED 有专门 kind)。
2. `harness-adapter.ts` RunResult.status 注释:FAILED = 「运行开始后以非超时/非取消方式终止」,与 TIMEOUT(墙钟超限)、CANCELLED(主动中断)语义区分。

## R8 · git-diff 分类按工作区列

**现状**:`code.includes('D')` 对 `AD`(暂存新增+工作区删除)误判 deleted,`MM` 等双状态误判。
**修**:porcelain `XY` 两列,X=暂存,Y=工作区;**以 Y(工作区)列为主**,未跟踪(`??`/`!!`)看 X 列:

```ts
const isUntracked = l.startsWith('??') || l.startsWith('!!')
const y = l[1] ?? l[0]           // 工作区状态(未跟踪时两列都是 ?)
const x = l[0]
let change: 'added' | 'modified' | 'deleted'
if (isUntracked) change = 'added'
else if (y === 'D' || (y === ' ' && x === 'D')) change = 'deleted'
else if (y === 'M' || y === 'A' || y === 'R' || y === 'C') change = 'modified'  // R/C 视作 modified
else if (x === 'A' && y === ' ') change = 'added'   // 已暂存新增
else change = 'modified'
```

**回归**:git-diff.test.ts 补用例——构造 `AD`(git add 后删文件)、`MM`(add 后再改)、`??`(未跟踪)→ 断言分类正确。

## R7 · interrupt SIGKILL 兜底 + 进程组

**现状**:interrupt 只 SIGTERM;run() 的 spawn 无 detached → omp 子进程逃逸。

**修**:
1. `run()` spawn 加 `detached: true`(建进程组,pid = 组 leader)。
2. `interrupt`:
```ts
state.aborted = true
const proc = state.proc
if (proc !== null) {
  try { process.kill(-proc.pid as number, 'SIGTERM') } catch { /* 进程可能已退出 */ }
  // 兜底:2s 后仍存活则 SIGKILL
  const timer = setTimeout(() => {
    try { process.kill(-(proc.pid as number), 'SIGKILL') } catch { /* 已退出 */ }
  }, 2000)
  timer.unref()
}
```

**注意**:detached:true 使子进程成为新进程组 leader;`kill(-pid)` 杀整组。fixture 测试的 fake proc 需模拟 kill 调用(现有 interrupt 测试断言 SIGTERM——补 SIGKILL 兜底断言:超时后调用 SIGKILL)。**测试**:用 fake timers 或缩短超时(注入)验证。

## 不做

- 不新增 ErrorKind(R9)。
- 不改 P-ALLOW-CRITIC(deny 语义)。
- 不实现 durable timer(活锁上限用同步计数)。
- 不处理架构一致性组(TIER 双源/DDL 漂移/check:generated 等)。