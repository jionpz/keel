# Critic 能力路径接线 — 技术设计

## 目标

把 `A-CapabilityRequest → Policy 裁决 → run(critic) → A-CriticReview → 回灌 → Brainstorm 收敛` 全部接通。现状四条缺口(G1 编排、G2 转移、G3 提示词、G4 规则),本轮全部闭合。

## 设计原则

1. **回流 = 新 brainstorm run(n+1),不实现 Session resume**。ADR-0003 仍 Proposed,`SessionManager.checkpoint/restore` 不实现(契约已标 `[可延后]`)。v0.1 同步循环下,「评审回灌」= critic run 完成后重新派发 `run(brainstorm, n+1)`,其 Context 由 Context Builder 自动带上 A-CriticReview(recipe 的 `critic` section 已存在,读 latest)。语义等价于 flow 步骤 12 的 rematerialize 路径。
2. **受理标记 = 存在 stage='critic' 的 run**。capability_request 与 critic run 的关联通过 run.stage 表达——T-009 创建 run(critic),即代表受理。幂等判断:该 task 有 `stage='critic'` run 则不再重复触发 CapabilityRequested。
3. **T-010 语义收窄**。`RunSucceeded → S-RFC_DRAFT` 只对 brainstorm 成立;critic 完成走 T-009b 回流。用 guard `e.stage === 'brainstorm'` 区分(事件已带 stage)。
4. **放行规则只开一个口**。`P-ALLOW-CRITIC` 仅 `capability=='critic_review'`,不泛化到 human_input / additional_context。

## 各缺口方案

### G4 · 放行规则(ruleset.ts)

```ts
{
  id: 'P-ALLOW-CRITIC',
  points: ['capability_request'],
  priority: 100,
  condition: "facts.capability == 'critic_review'",
  action: 'auto_develop',
  stop: false,
}
```

- `capability` fact 已在 Round 1 注册(FACT_REGISTRY + FACTS_AT.capability_request),driver 从事件注入,validate 从提案 body 注入。
- priority 100(最低档,与 P4 同级)——最严规则优先,放行规则最弱,易被更严的压过。
- 注:这是 #1-09 纪律的正当恢复场景——当时删规则因其未接线;现在接线完成,规则正式落地。

### G2 · 转移修正(table.ts + docs/04-state-machine.md)

- **T-010**:guard 从 null 改为 `(_f, e) => e.type === 'RunSucceeded' && e.stage === 'brainstorm'`,guardText `stage=brainstorm`。
- **T-009b(新)**:S-BRAINSTORM + `RunSucceeded{stage:'critic'}` → SELF,guard null,effects `[nextRun('brainstorm')]`(创建 brainstorm 的下一轮,评审已落库)。
  - id 编号:文档无预留,用 `T-009b`(T-009 的完成侧);文档 §2 同步加行。
  - **注意自环与 run 计数**:回流后 `attemptsOf(task, 'brainstorm')` = 2(brainstorm 有两次 run:n=1 收敛前请求 critic,n=2 带评审收敛)。MAX_STAGE_ATTEMPTS=3 足够。

**时序**(状态机视角):
```
S-BRAINSTORM --CapabilityRequested--> T-009(SELF, policy=allow) → run(critic,1)
S-BRAINSTORM --RunSucceeded{critic}--> T-009b(SELF) → run(brainstorm,2) [critic_review 在 context]
S-BRAINSTORM --RunSucceeded{brainstorm}--> T-010 → S-RFC_DRAFT
```

### G1 · 编排触发与回流(loop.ts)

**触发点**:循环顶部,`S-BRAINSTORM` 且 `readPendingRun()==null` 时:

```ts
// ── S-BRAINSTORM：检查未受理的能力请求 ──
if (state.status === 'S-BRAINSTORM' && pending === null) {
  const req = await readPendingCapabilityRequest(taskId)   // 最新 A-CapabilityRequest
  const accepted = await hasCriticRun(taskId)              // 存在 stage='critic' run
  if (req !== null && !accepted) {
    const adv = await deps.driver.advance(taskId, { type: 'CapabilityRequested', capability: req }, deps.now())
    if (!adv.ok) return err(adv.error)
    steps.push(record(...))
    continue
  }
}
```

- `readPendingCapabilityRequest(taskId)`:查最新 `artifact kind='capability_request'` 的 `body.capability`;无 → null。
- `hasCriticRun(taskId)`:`SELECT 1 FROM run WHERE task_id=$1 AND stage='critic' LIMIT 1`。
- **如果 policy=deny**:advance 返回 advanced=false(T-009 guard 不过 → NoTransition 已记录)。此时不能死循环——loop 需记录「已尝试反应」并停止(返回当前状态)。避免每次迭代重试同一请求。
  - 方案:loop 检查 capability_request artifact 的 `created_at` 是否已尝试过——最简单:capability_request 受理失败时记录事件 `CapabilityRequestDenied`,loop 查该事件存在则不再重试,返回 ok(停在当前状态)。**或**更简单:policy_ddenied 时 driver 已落 NoTransition 事件;loop 只在「无 NoTransition 记录且无 critic run」时触发。取后者:查询 `event` 中该 run/capability 相关 NoTransition 次数。
  - 简化决策:T-009 guard 不过时 `advance.advanced=false`;loop 直接 `return ok`(停在 S-BRAINSTORM)—— 这不是死循环,因为 loop 只在第 i 次迭代触发一次。**但多轮循环会每轮重试**。最终方案:触发前查该 request 是否已产生 `CapabilityRequested` 事件(`event.type='CapabilityRequested'`)→ 有则不再触发,等人工/外部。该事件由 T-009 的 EvaluatePolicy 写 `policy_decision` artifact;deny 时无 run 创建。判定:存在 `CapabilityRequested` 事件 = 已请求过。
  - **决定**:loop 触发条件 = 有 capability_request artifact 且无任何 `CapabilityRequested` 事件(对该 task)。已请求过(无论 allow/deny)就不再自动重试。allow 时会创建 critic run → 走正常执行;deny 时事件流记录后停在 S-BRAINSTORM,人可介入。

**critic run 完成**:不需要 loop 特判——executeRun 后发 `RunSucceeded{stage: pending.stage=critic}` → 新 T-009b 接住 → 创建 brainstorm(n+1)。下一轮迭代 `readPendingRun` 读到 brainstorm(2),正常执行。

### G3 · 提示词与期望产物(prompts.ts)

- `expectedArtifact('critic')`:从 `stage_outcome` 改 `critic_review`。
- `promptFor('critic')`:要求输出符合 `critic_review` schema 的 JSON 形状示例(review_type/scale/criteria/scores/recommendation/confidence),**占位不写死**:
  - review_type 枚举:`architecture | security | quality | product | feasibility`
  - scale:`{min:1, max:10, higher_is_better:true}`
  - criteria:数组如 `[{"id":"C1","name":"正确性"}]`
  - scores:`[{"criteria_id":"C1","score":8,"evidence":"..."}]`
  - recommendation:`{option_id:"A", reason:"..."}`
  - confidence:0~1
- role:critic 的 ROLE_INSTRUCTIONS 已有('你是 Critic。职责:对候选方案给出结构化评审。')。
- Context:critic recipe `['role','state']` 足够(候选方案在 A-State 的 candidate_options)——若验收发现缺候选方案,补 recipe 'feedback'。

## 测试策略

- **policy.test.ts**:P-ALLOW-CRITIC `capability=critic_review → auto_develop`;`human_input → 仍 deny`(缺规则)。
- **transition.test.ts**:T-010 guard 收窄(`RunSucceeded{stage:'brainstorm'}` 才走;`stage:'critic'` 走 T-009b);T-009b 存在且 SELF。
- **loop e2e**:fake adapter 按阶段产 critic_review → 全链路 T-009 → T-009b → T-010,事件流断言。
- **driver.test.ts**:CapabilityRequested 在 P-ALLOW-CRITIC 下推进。

## 不做

- 不实现 SessionManager.checkpoint/restore/resume 路径(L2 专属)。
- 不改 A-CriticReview schema(契约冻结)。
- 不泛化 capability 白名单(human_input/additional_context 各需独立规则与编排)。
- 不修 context-builder 的 critic recipe(除非 R5 验收抓出缺料)。