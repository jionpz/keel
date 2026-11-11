# 项目决定与确定性接纳

> 范围：JT-02B。managed 调查的 `waiting_decision` 已落为 `DecisionRequest`，
> 天问产出 `TianwenProposal`，确定性接纳器决定是否委派；委派后 runtime 自动唤醒任务，
> 无依据或拒绝时进入 `WAITING_HUMAN`。人工答复与纠正都写入决议台账。

## Schema

事实来源是 `docs/schemas/managed/`：

| 文件 | 类型 | 用途 |
|---|---|---|
| `project-decision.schema.json` | `ProjectDecision` | 项目内明确决定、来源、范围、有效期与替代/撤销关系 |
| `decision-request.schema.json` | `DecisionRequest` | 稳定问题 ID、revision、input digest、当前状态与影响范围 |
| `tianwen-proposal.schema.json` | `TianwenProposal` | 天问候选；`claimed_evidence_grade` 不可信 |
| `tianwen-decision.schema.json` | `TianwenDecision` | 天问阶段的模型输出草稿；运行时补 request 身份后才是 Proposal |
| `decision-resolution.schema.json` | `DecisionResolution` | `delegated` / `human_confirmed` / `owner_required` / `denied` 及计算后的等级 |
| `delegation-policy.schema.json` | `DelegationPolicyVersion` | owner 确认的版本化委托规则，含影响/预算/证据/检查限制 |

`pnpm run generate` 生成 `src/generated/managed.ts`；不允许手改生成物。

## 接纳顺序

`src/control/managed/decision-acceptor.ts` 是纯函数，调用方传入时间、可信调用者、
当前项目决定、全部当前策略和控制状态。顺序固定为：

1. request/proposal schema、可信 actor/source 与 UUID；
2. request ID/revision、请求 input digest、提案 digest、过期时间；
3. 项目范围、引用存在性、版本、有效期、撤销/替代状态；
4. 所有当前策略的最严规则、影响/预算/证据/检查限制与任务/预算控制状态；
5. 重算证据等级并生成唯一决议。

不会采信模型自报的 `claimed_evidence_grade`：

- **E3**：只接受 `owner_confirmed`、仍有效、作用域匹配的项目决定；选项 ID 与文案都必须匹配。
- 同一 `decision_key` 存在多条仍有效、作用域匹配但答案不同的决定时一律 `owner_required`。
- **E1**：只接受 owner 确认、仍有效且显式覆盖当前动作、环境、资源与可逆性的策略规则；
  提案必须采用该规则声明的默认选项。不可逆影响一律不能走 E1。
- `approval` 类请求没有执行网关核对动作与环境时一律 `owner_required`；
  作用域要求至少一个受影响资源，空资源列表不再匹配任意策略。
- 策略要求 `required_checks`、`required_evidence` 或预算上限而本切片尚未实现核验时
  `owner_required`，不会静默忽略。
- E2 语义复核、observed fact 引用核验不在本切片；出现时 `owner_required`。

无引用、引用缺失/失效、作用域不匹配或存在未解决冲突时 `owner_required`；
跨项目、digest/revision/request_id 失配、请求过期、伪造 actor/source、暂停/取消、
策略明确 deny 时输出 `denied`。

## 持久模型

迁移：`migrations/1000000000012_decision-ledger.sql`。
v0.1 延续 repo 即项目，`project_id` 使用受管 repo 的稳定 UUID。

| 表 | 关键约束 |
|---|---|
| `managed_project_decision` | `(project_id, decision_key, version)` 唯一；核心列不可 UPDATE；替代/撤销只能经 `SECURITY DEFINER` 函数 |
| `managed_delegation_policy` | `(project_id, policy_id, version)` 唯一；规则 JSON；同样只能经审计函数回填终态 |
| `managed_decision_change` | append-only；记录替代/撤销前后状态、actor、理由和时间 |
| `managed_decision_request` | `(id, revision)` 主键；活跃 question 唯一；项目/任务/决定键/摘要去重；状态迁移受 trigger 约束 |
| `managed_tianwen_proposal` | actor/source 列固定为 `tianwen` / `model_proposal`；payload 不得自带身份 |
| `managed_decision_resolution` | `(request_id, request_revision)` 唯一；必须有答案的处置才带答案；actor 类型与处置强校验 |
| `managed_question_correction` | 已继续任务的纠正只能追加，不改写已 RESOLVED 的问题行 |

request 的 `attempt_id` 指向产生问题的 `managed_attempt`，把决策尝试与调查尝试关联起来。
`src/control/managed/decision-store.ts` 从现有 `managed_question` 映射题目与选项，
不重写 prompt。候选提交与接纳均以 `keel_control` 身份运行；`keel_execution`
对决策台账没有任何读写权限。`keel_control` 只有 request 状态列的直接 UPDATE 权限；
`RESOLVED` 必须有同 revision 决议，身份/输入列不可改。

## 并发语义

接纳在单个 `keel_control` 事务内重新读取当前项目决定与全部当前策略并调用纯函数。
决议插入使用 `UNIQUE (request_id, request_revision)`；只有插入成功的事务能继续更新
request 状态。并发提交同一 revision 时一个成功，其余返回 `CONFLICT`，不会产生第二条决议。
人工答复与 worker 都先锁 task；同一问题只有一个事务能完成状态迁移。

## 人工覆盖与纠正

- 天问委派后任务进入 `READY`，runtime 下一轮自动继续。
- 任务继续前，本机操作员可对原问题给出精确选项答复；store 会创建 `revision + 1`，
  旧 request 标为 `SUPERSEDED`，新 revision 写入 `human_confirmed` 决议。
- 已进入 `RUNNING` 的任务不做隐式改写；必须先暂停/取消，留给后续控制切片。

## 尚未接线

- `recordProjectDecision()` 与 `recordDelegationPolicy()` 目前只允许受信控制入口调用；
  从认证会话核验 owner 身份的项目映射尚未接线。
- `impact` 仍由调查模型声明；JT-02D 的执行网关必须重新核对动作、环境与资源，
  `approval` 在本切片不会自动委派。
- outbox/PR 属 JT-02D，required checks 属 JT-02E；决策接纳器仍按本切片规则拒绝
  带这些要求的自动代答，而 action gateway 独立消费 `required_checks`。
