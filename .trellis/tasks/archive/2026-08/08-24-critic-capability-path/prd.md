# Critic 能力路径接线 (T-009 capability_request)

## Goal

让「Brainstorm 请求 Critic 评审 → Policy 裁决 → 派发 critic run → 评审回灌 → Brainstorm 收敛」整条路径可运行。Round 1 (#1-02) 已把 `capability_request` 的 Policy 接线(validate 第 4 步 + T-009 guard 现场求值 + EvaluatePolicy 落库),但**缺裁决即拒、无放行规则**,且编排/转移/提示词三处空转 —— 路径整体跑不通。

## Background(现状调查,2026-08-24)

| 层 | 现状 | 缺口 |
|---|---|---|
| 规则 | `DEFAULT_RULES` 无 capability_request 规则 → 裁决恒 `human_review`(default deny) → T-009 永不匹配 | **G4**:缺 P-ALLOW-CRITIC 放行规则 |
| 编排 | `loop.ts` 只有「找 PENDING run → 执行」;无任何代码生成 `CapabilityRequested` 事件;critic run 完成后仍发 `RunSucceeded{stage:'critic'}`,命中 T-010(guard null)直跳 `S-RFC_DRAFT`,评审从未回灌 | **G1**:无 CapabilityRequested 触发、无 critic 完成回流 |
| 转移 | `T-010` `on:['RunSucceeded']` guard null —— 不区分 stage。critic 完成会误触发它 | **G2**:T-010 需限定 `stage==='brainstorm'`;critic 完成需走「回流 brainstorm run(n+1)」 |
| 提示词 | `promptFor('critic')` = 「对候选方案给出评审」+ 输出 `{"verdict":"reviewed"}` —— 与 `A-CriticReview` schema(scale/criteria/scores/recommendation/confidence)完全不符 | **G3**:critic 提示词要模型产出 A-CriticReview 形状 |
| 上下文 | Critic recipe `['role','state']` —— 评审对象是 Brainstorm 的候选方案(A-State 的 candidate_options),基本够用但需确认 | 排查 |

Flow 参照:`docs/07-flows.md` 步骤 8-14。

## Requirements

- **R1 放行规则**:DEFAULT_RULES 加 `P-ALLOW-CRITIC`——`capability_request` 判定点、`facts.capability == 'critic_review'` → `auto_develop`。capability fact 已由 Round 1 注入(driver 从事件、validate 从提案 body)。
- **R2 编排触发**:S-BRAINSTORM 无 PENDING run 时,loop 检查该 task 是否有未受理的 `A-CapabilityRequest`(最新 artifact kind='capability_request'),有则生成 `CapabilityRequested{capability}` 事件推进 T-009。幂等:已受理(存在对应 critic run)不重复触发。
- **R3 转移修正**:
  - `T-010` guard 加 `e.stage === 'brainstorm'`——只有 brainstorm 收敛产物才进 RFC_DRAFT。
  - 新增 `T-009b`:S-BRAINSTORM + `RunSucceeded{stage:'critic'}` → SELF,创建 `run(brainstorm, n+1)`(评审经 Context Builder 带 A-CriticReview 回灌,下一轮 brainstorm 收敛)。
  - 文档 04-state-machine.md §2 同步。
- **R4 提示词**:`promptFor('critic')` 改为要求产出一条符合 `critic_review` schema 的 JSON(带 scale/criteria/scores/recommendation/confidence 示例形状,占位不写死)。`expectedArtifact('critic')` 返回 kind='critic_review'(当前是 stage_outcome —— 也会导致 validate 用错 schema)。
- **R5 端到端验收**:铺 S-BRAINSTORM + 候选方案 + A-CapabilityRequest → runTaskToCompletion(fake adapter 按阶段产 critic_review)→ T-009 → critic run → 回流 brainstorm(带评审)→ 收敛 → T-010(S-BRAINSTORM 语义)→ S-RFC_DRAFT。断言全过程事件流可重建。

## Acceptance Criteria

- [ ] R1:policy.test.ts 覆盖 `capability_request + capability=critic_review → auto_develop`;driver T-009 matched
- [ ] R2:loop 在 S-BRAINSTORM + 未受理 capability_request 时生成 CapabilityRequested;已受理不重复
- [ ] R3:T-010 guard 限定 brainstorm;critic 完成 → 回流 brainstorm(n+1);转移表文档同步(C4 比对含 guardText)
- [ ] R4:promptFor('critic') 产出形状 = critic_review;expectedArtifact('critic') = 'critic_review'
- [ ] R5:端到端 e2e 走通 T-009 全链路,事件流可重建
- [ ] `pnpm run check` 全绿

## Constraints

- 不重写 Workflow engine(ADR-0003 仍 Proposed)。
- 不实现 `SessionManager.checkpoint/restore`——回流用「新 brainstorm run(n+1) + Context 带评审」实现(L2 resume 属 future)。
- 不改 A-CriticReview schema。
- 放行规则只针对 `critic_review` 这一个 capability,不泛化。
- 缺裁决仍拒收(Round 1 决策不变)。

## Notes

- 复杂任务:需补 `design.md` + `implement.md` 后 `task.py start`。
- 关键决策点:#1-09 的「未接线判定点删规则」纪律意味着——**本任务把 capability_request 真正接线**,恢复规则是「接入对应转移时恢复」的正当场景,不是反悔。
- 编排触发(R2)与回流(R3)是 v0.1 同步循环下的最小实现:critic 完成后重新派发 brainstorm run(n+1),评审已落库,新 run 的 Context 自带 A-CriticReview(recipe 的 critic section 已存在)。