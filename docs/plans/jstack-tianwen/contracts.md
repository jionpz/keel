# 决策协议、持久模型与一致性

**状态**：目标契约，尚未实现。字段名、状态和接口均为方案约定，不是当前 API。适用范围与运行方式见[主方案](./README.md)。

## 1. jstack managed 协议

生产入口需要管理员登记项目与可信 jstack 工作流包。包来源可以是指定 jstack commit 或经校验的项目安装锁；目标仓库自行修改 `.jstack/config.json` 不会扩大授权。配置与包均经过校验后由 Control Plane 固定。

```text
WorkflowPackage {
  protocol_version, workflow_id: "jstack", package_version,
  source_commit, content_digest,
  stage_catalog[], route_rules_ref, providers[], gates[],
  decision_protocol_version, must_stop_rules[], result_schemas[],
  dependency_manifest, supported_capabilities[]
}

WorkflowBinding {
  task_id, project_id, package_digest, repo_config_digest,
  base_commit, graph_version, completion_target
}
```

`content_digest` 覆盖内容而非仅版本号，包括 provider 的脚本/技能依赖；缺文件、摘要不符、未知 gate 类型或协议主版本不兼容时拒绝认领任务。不从插件缓存中自动挑“最新版本”继续旧任务。

stage catalog 与路线只有 jstack 一个定义源。Keel 运行固定包导出的路线提案并校验任务图：无环、依赖完整、必需门禁存在、provider 与能力匹配、ticket 范围不越权。路由结果作为 Artifact 提交，后续重放不重新问 LLM 决定原路线。

阶段最小结果：

```text
StageResult {
  node_id, attempt_id, input_digest, graph_version,
  outcome: completed | waiting_decision | retryable_failure | failed,
  artifact_refs[], evidence_refs[],
  decision_request_refs[], effect_intents[], usage
}
```

完成只由门禁判定。输出 `completed` 但缺真实 verify/review/CI 证据时仍不完成。`effect_intents` 只能描述当前授权范围内的候选动作；接受提案不自动赋予执行权。

## 2. 所有提问统一经过天问

目标接口是 `DecisionProvider`，不是通知提供者。签名采用语言中立形式：

```text
requestDecision(request, authenticated_caller) -> request_id, revision, status
readDecision(request_id, after_revision?) -> request + resolution?
subscribeDecision(request_id) -> durable wakeup reference
submitTianwenProposal(request_id, revision, proposal) -> accepted | rejected
submitHumanDecision(request_id, revision, choice, rationale, authenticated_owner)
overrideDecision(request_id, expected_revision, new_choice, rationale, authenticated_owner)
cancelDecision(request_id, expected_revision, reason)
```

会话内 AskUser、provider 的澄清与签字、hook/扩展的审批都适配到同一协议。Harness 不支持受控提问/暂停和受限工具执行时，不纳入 managed 首发支持范围。终端打印一句“需要用户”不算请求已持久化。

所有系统发起的人工请求只有经过 `TianwenAttemptStarted`，且接纳器给出升级原因后，才能发出 `HumanAttentionRequested`。Tianwen 不可用时仍记录 attempt 失败，不伪称已经分析。用户主动发出的停止、撤销和纠正属于控制输入，立即处理，不被天问队列阻挡。

### 2.1 DecisionRequest

```text
DecisionRequest {
  schema_version, id, revision, idempotency_key,
  project_id, repo_id, task_id, node_id, attempt_id,
  kind: clarification | preference | design | approval | recovery | budget,
  question, options[{id, text}], suggested_option?,
  constraints[], missing_information[],
  impact: {environment, reversibility, affected_resources[]},
  action_intent_ref?, evidence_refs[], blocking_nodes[],
  input_digest, workflow_digest, observed_memory_epoch,
  expires_at?, created_at
}
```

`approval` 的资源、动作类别和实际环境由执行网关核对，不能由 LLM 把生产删除标为低风险偏好而绕过检查。未知动作类别默认不得执行，天问负责形成补充授权的建议。

问题可以是自由文本，但回答必须指向选项或符合声明的 answer schema；不接受无法解析的“看着办”。`expires_at` 到期仅失效本次问题或行动窗口，不代表批准；是否取消任务另有显式策略。

### 2.2 TianwenProposal 与接纳结果

```text
TianwenProposal {
  request_id, request_revision, input_digest,
  recommendation: answer | approve | reject | defer,
  answer, rationale, evidence_grade: E0 | E1 | E2 | E3,
  basis_refs[], observed_fact_refs[], assumptions[], alternatives[],
  policy_refs[], capsule_version, memory_watermark, memory_epoch,
  unresolved_conflicts[], missing_authority[],
  validation_plan?, rollback_plan?, model_profile_version, usage
}

DecisionResolution {
  id, request_id, request_revision,
  disposition: delegated | owner_required | denied,
  answer?, rationale, basis_refs[],
  actor: {type: tianwen | human | policy, authenticated_id},
  authority_refs[], validity_conditions[],
  memory_epoch, delegation_epoch, context_digest, resolved_at
}
```

`actor`、权限、来源等级和接纳状态由可信服务填写，不采信模型自报。`owner_required` 必须带可操作缺口、推荐项及已查证材料。用户无需重读完整历史，也不需要重复告诉天问已经知道的事实。

天问可以在一次回复里建议修复环境或缩小方案；不得在问题不能解决时偷偷改变任务目标。对基础设施持续故障，升级原因必须标明是故障，不能伪装成用户需要做产品选择。

### 2.3 确定性的接纳检查

顺序固定：schema/调用者身份 → request revision/input digest → 项目与来源完整性 → 决定有效性/冲突 → 授权条件 → 证据门槛/复核 → 预算/任务控制状态 → 持久化结果。

E3/E2/E1 是判据，不直接信任模型声称的等级。接纳器核对引用存在、未撤销、作用域匹配和确定性条件；需要语义判断的适用性/冲突审查由独立 Execution Run 产出结构化证据。未完成所需审查不降低门槛放行。

有限重试解决格式错误与暂时缺证据；不能无限询问多个模型直到出现一个赞成答案。记录被否定的候选和原因，避免后续节点重新提交相同假设。

## 3. 项目授权

```text
DelegationPolicyVersion {
  policy_id, version, project_id, approved_by_owner, approved_at,
  valid_from, valid_until?, supersedes?,
  rules[{
    id, decision_kinds[], actions[], resource_selectors[], environments[],
    reversibility?, impact_limits, budget_limits,
    required_evidence[], required_checks[],
    mode: delegated | owner_required | deny
  }]
}
```

策略采用确定性、受限表达式，不执行任意代码。冲突取更严格的处置；无覆盖时新授权请求为 `owner_required`，普通可逆选择可由明确的默认选择规则覆盖。天问不能修改策略、替策略制定者签名、延长有效期或自行调整费用上限。

用户对单次问题的批准默认只覆盖该请求及动作参数。如用户明确选择“今后本项目同类问题也采用”，生成持久规则候选，展示范围/有效期/例外，用户确认后发布新版本。这是一次授权设置，不是每个后续请求重复审批。

对每个动作签发 `ExecutionPermit`：

```text
ExecutionPermit {
  id, action_intent_id, resolution_id, project_id,
  action, target_digest, expected_sha?, environment,
  delegation_version, delegation_epoch, decision_epoch,
  fencing_token, expires_at, idempotency_key
}
```

许可在可信网关中验证，不作为模型可自行生成的 JSON 令牌。适用策略/决定已撤销、SHA/参数变化、暂停/取消或预算超界时，已有许可不得开始新的动作。审批与实际执行相隔较久时重新核对当前事实。

## 4. 持久数据模型

这是逻辑模型；实施时迁移、JSON Schema、生成类型、SQL 授权和读写路径必须一起交付。

| 实体 | 关键字段 / 约束 |
|---|---|
| project / project_repo | project 属于 owner；repo 映射由管理员登记；请求不能自行改归属 |
| workflow_package | digest PK，schema/protocol/version、原始包或 blob 引用；不可变、内容校验 |
| workflow_instance / graph_version | task 唯一绑定、包摘要、路线与依赖、输入版本、完成目标 |
| stage_instance / stage_attempt | 节点/attempt 唯一，状态、输入摘要、租约、checkpoint；沿用 Task/Run 分离 |
| decision_request | ID/revision、项目、节点、输入摘要、状态、当前候选/最终 resolution 引用 |
| decision_attempt | 问题修订/attempt 唯一；天问执行结果、预算、模型、来源材料、失败原因 |
| decision_record | 不可变结论、理由、来源等级、适用条件、basis refs、决定者、来源请求 |
| decision_change | append-only 的 supersede/revoke/conflict/owner-correction 事件；形成有效记录投影 |
| project_memory_head | 当前 epoch、摘要指针；事务更新；供缓存一致性检查 |
| project_capsule_version | 项目/版本唯一，摘要内容、源记录列表/水位、构建器版本、模型、评测结果 |
| delegation_policy_version | 不可变授权版本、owner 身份、有效期与范围；另有 active head/撤销 epoch |
| action_intent / action_outbox | 动作摘要、目标、决议、许可、幂等键、状态、远程关联 ID 与结果 |
| event | 保存事实与投影变更；沿用 trace_id，全链关联任务/节点/问题/动作 |

项目决定、委托授权、工作流方案和运行时 PolicyDecision 必须区分；不能把“流程允许进入开发”当成“用户偏好这个产品方案”。任务内 A-State 可引用项目决定，不能反过来直接提升为项目级权威。

原始事实和授权只由 Control Plane 通过受限角色写入；Execution 只接收 Context、提交 Proposal。投影可更新，原始事件/决定版本只增不改。新 GRANT 应按实际方法最小化，禁止为方便直接赋予 Execution 读写整个事实库的权限。

权限制定者身份从本机 owner 入口取得，不接受 HTTP body 或模型输出传来的 `approved_by_owner`。单 owner 多项目也必须校验项目映射与作用域；Keel 不做多租户，不预留共享租户入口。

## 5. 状态、去重与竞态

### 5.1 请求级状态与尝试分离

| 当前 | 事件 / 条件 | 后续 |
|---|---|---|
| OPEN | 天问 attempt 认领成功 | PROCESSING |
| PROCESSING | 接纳器接受可代决/拒绝结果 | RESOLVED（包含明确拒绝） |
| PROCESSING | 证据/授权不足，或有界恢复耗尽 | WAITING_HUMAN，先保存建议/失败原因 |
| PROCESSING | 可重试技术错误且仍有预算 | OPEN（退避后创建下次 attempt） |
| WAITING_HUMAN | 合法用户答复且版本匹配 | RESOLVED |
| 任意活动状态 | 输入/前置决定发生实质变化 | 当前修订 SUPERSEDED；新修订 OPEN |
| 任意活动状态 | 任务取消 | CANCELLED |

只有一个 request revision 可处于当前状态。`RESOLVED` 不等于动作执行成功；动作有独立状态。人工主动覆盖已答问题时发布新修订和替代关系，保留原结果，并使旧动作许可失效。

### 5.2 唯一性与并发

- 请求重试键为 `project + task + node + question_slot + input_digest`，数据库唯一约束兜底。摘要相似不是去重依据；同一句话处于不同环境/资源/选项时不能共用批准。
- 同请求候选用 revision CAS 接纳；同修订最多一条最终决议。租约 fencing token 过期的 worker 不能写入结果。
- 人工覆盖高于天问候选：事务更新请求修订/决定有效性/epoch，再写恢复或阻断 outbox。天问即使后返回也因版本失配被拒。
- 若天问已经接纳、动作尚未执行，人工覆盖撤销其许可；若远程动作已发出，回查并决定补偿，不能声称已自动撤销。
- 答复提交、节点解除阻塞、恢复 outbox 在同一事务；worker 崩溃不会留下“已回答却永远不恢复”的缝隙。
- 同一相同问题的多个等待节点可订阅已确认且仍适用的结果；单次动作授权不可扩展到未声明的动作。

### 5.3 外部副作用状态

`pending → leased → executing → succeeded | failed | uncertain`。认领和 fence 只防内部重复提交；不能保证外部服务执行一次。

PR/Issue 等先按稳定关联标识查已有对象再创建；CI 校验 target SHA 和 required checks；部署/迁移使用平台幂等键和执行记录。外部不支持幂等或回查时，崩溃后的 `executing` 必须转 `uncertain`，禁止盲重试。不同风险动作有自己的补偿规则。

## 6. 上下文与记忆一致性

ContextBuilder 新增 Tianwen 配方：固定职责、当前任务、项目授权摘要、项目摘要、摘要后相关增量、按需检索原文、工具查证结果、最近失败与冲突。所有来源都带不可变引用或已持久化的观察快照，`ContextBuilt` 能还原当时材料。

摘要版本本身不可变，但决定有效性和授权必须读当前 epoch。生成答案时记录 epoch，提交与执行时再校验；发现变化时只重算受影响问题。当前版本引用完整但关键记录已撤销时，不得因摘要哈希正确而继续使用。

候选摘要必须从原始记录或有完整源引用的增量生成，记录未决冲突和未纳入条目。发布 CAS 校验源水位；有并发新决定时保留增量覆盖，不谎称摘要已覆盖它。回滚只回滚读模型，不回滚撤销与新授权限制。

事实可变时（如数据库配置、线上版本、CI），保存观察时间、目标版本与失效条件。跨项目数据和凭据在进入模型、日志、全文索引前过滤/脱敏。长期记忆不能包含原始密钥或依靠模型输出自行隐藏秘密。

## 7. 默认边界与失败处理

建议初始值：每问题最多 3 次模型调用（含格式重试和复核），总墙钟 180 秒；允许 1 次按主题扩展检索，通常最多 8 条原始记录。成本上限为项目必配值；缺成本上报时仍以 token/轮数/墙钟兜底，不将未知成本当 0。

模型超时/无效输出 → 有界重试；模型服务长期不可用 → 天问失败事件 + 运维/人工队列；数据库/授权服务不可用 → 停止接纳与执行新动作；不能靠缓存批准。只有相关项目的记忆不完整时，其他项目继续。

`WAITING_HUMAN` 默认无限期保存，按用户配置提醒；提醒也去重/合批。关闭原 Issue、任务取消或授权窗口结束的处理必须显式记录；不因用户沉默生成偏好或持久授权。

## 8. 必须扩展的实际代码边界

| 仓库 | 现有入口 | 待实现接口 |
|---|---|---|
| jstack | `src/flow/skills/route/` 与阶段/技能调用 | 工作流导出、managed 模式、结构化决策请求/恢复 |
| jstack | `src/flow/hooks/`、`src/flow/extensions/`、harness adapters | 必停动作转持久审批、消费受控处置、缺能力拒绝 |
| jstack | `jstack` 构建/安装与项目 config | 协议字段校验、export/build/lock/doctor 兼容校验；生成 plugins 不手改 |
| Keel | `src/contracts/`、`docs/schemas/`、`migrations/` | Request/Resolution/Delegation/Capsule/Workflow schemas、表/授权/类型 |
| Keel | `src/control/`、`src/execution/` | 纯接纳策略、天问角色与模型路由、工作流驱动、阶段租约 |
| Keel | `src/control/context/`、`src/fact/` | 项目记忆、增量/全文检索、可还原 Context、摘要发布 |
| Keel | `src/cli/decide.ts`、control mode、console | 自动/人工来源分离、控制权限、覆盖与恢复、问题队列 |
| Keel | ingress/poller、timer、GitHub/外部网关 | daemon、outbox、答复唤醒、故障恢复、行动许可 |

以上是改动边界，不是声称已有接口。实现中如果发现需要修改 public schema/权限或当前状态机，必须把迁移和兼容策略与相应测试一起评审。
