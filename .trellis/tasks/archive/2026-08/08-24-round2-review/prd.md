# Round 2 组件专家审查

## Goal

对 `be9887e`(HEAD:Round 1 #1-01..#1-14 + Critic 路径 #1-15 + appendEvent #20 全部落地后)做新一轮组件专家审查,产出分级发现报告(P0 必须修 / P1 高优先 / P2 应修)。参照 #22 模式:Contracts / Fact / Control / Execution / Shared-Infra 五席并行,主会话对 major 项对源码复核。**审查不修改代码**。

## 审查基线

- Review commit: `be9887e`(origin/main HEAD)
- 前置状态:`pnpm run check` 208 tests 全绿;C1-C4 门禁过;C4 32 条含 guardText
- 上一轮已修:契约-实现对齐(提示词/capability/interrupt/dirty tree/tier/guardText)、未接线规则删除、I5 反例、契约文档补齐、appendEvent 签名

## 审查方法

分层递进:
1. **五席并行**:子代理按平面分工,读源码 + 契约文档,找「契约声称已落地、实现空转或写死」类问题(上一轮主战场)+ 本轮新增处的回归风险。
2. **主会话复核**:汇总后对 major(疑似 P0/P1)逐条对源码二次确认;不把实现偏好标成严重级。
3. **分级**:P0 中心不变量被打破;P1 契约-实现分叉 / 行为错误;P2 文档滞后 / 加固缺口。

## 审查焦点(本轮重点)

- Round 1 修复的正确性回归:capability 裁决链(validate 第 4 步 + T-009 guard + P-ALLOW-CRITIC 新接线是否引入漏洞)、T-009b 回流的幂等性与状态一致性、critic 路径需求_critic 标志的健壮性(模型说 needs_critic=true 但产出 stage_outcome 形状?)
- 新契约边界:git-provider/ci-gateway 文档与实现一致性;ProposalKind 收窄后的事件流完整性
-  синтез capability_request 的防重/审计(loop.synthesizeCapabilityRequest)
- appendEvent Omit seq 后的 I1 不变式仍在?
- P-DRIFT 删除后的 post_develop 判定点:loadPolicyFacts 仍有该分支(FACTS_AT 保留)——死代码 or 复活风险?
- 编排器同步循环的限制在文档里诚实呈现?

## 输出契约

一份审查报告,格式与 #22 一致:
```
## P0(若有)—— 必须立即修复
## P1 —— 高优先级(逐条:位置/问题/影响/建议/证据)
## P2 —— 应修,不挡主路径
## 钉住的不变量(本轮确认未破)
```

每条发现必须:位置(文件:行)、问题(事实)、影响、建议(可执行)、证据(源码/测试/命令输出)。

## Acceptance Criteria

- [ ] 五席 × 各 ≥3 条候选发现(或明确「该席无问题」+ 抽查证据)
- [ ] 主会话对全部 major(≥P1)对源码复核,确认真实性
- [ ] 最终报告包含 P0/P1/P2 分级 + 钉住不变量清单
- [ ] 报告产出为 issue(参照 #22 格式),后续可派生行动项
- [ ] 审查期间不修改 src/ 代码(允许添加审查过程记录文件)

## Constraints

- 不修改代码——审查产出是报告,修复另开任务。
- 不放宽 C1-C4;不重写 Workflow engine;不实现 SessionManager 全套。
- 分级纪律:未经源码确认的疑点不得标 P1;实现偏好(能跑但风格不同)标 P2 或 suggested。

## Notes

- 本任务产出单一交付物(审查报告),无需 design/implement——审查流程即执行。
- 与 #22 的区别:基线是修复后的代码,重点验证修复正确性 + 新增处风险,而非重复旧发现。
- 五席分工:
  - Contracts:src/contracts/ + docs/05-contracts/ + generated;
  - Fact:src/fact/ + migrations/ + 权限/不变式;
  - Control:src/control/(transition/policy/driver/orchestrator/proposal/context);
  - Execution:src/execution/(adapters/session);
  - Shared-Infra:src/shared/ + scripts/(C1-C4 检查器)+ package/配置。