# 当前 managed 状态机与职责边界

本页描述 jstack managed 产品路径。工程会话入口是 `flow:route`；产品运行时消费
jstack 导出的固定包，两者共用工作流定义，但不共用会话状态。旧
[`04-state-machine.md`](./04-state-machine.md) 只定义 `legacy-v01`。

## 定义源与不变量

- jstack 定义路线、provider、门禁和工具策略；Keel 校验固定包、持久化事实并调度。
- Execution 只提交结构化结果；Control 决定接纳、状态变化和受控副作用。
- Task/Run 属于 legacy；Workflow/Ticket/Stage 属于 managed，不能按状态名字互转。
- `branch_ready` 交付本地 commit；`pr_ready` 交付准确 head 的 required checks 成功。
  `PR_READY` 不等于 merge，workflow `DONE` 不等于 legacy `S-DONE`。
- workflow 只有全部当前图节点 `ARCHIVED` 才到 `DONE`。取消、失败和缺证据都不算成功。
- `workflow-cancel` 是 workflow 的显式取消与所有权释放入口；节点取消也可使父流程
  汇总为 `CANCELLED`，但不会自动释放其他节点的 claim。终态不可 `workflow-retry`。
- 包版本由创建时的 digest 固定。更新工程侧 jstack 不替换进行中任务的包。
  新基线或新固定包必须新建 workflow；已执行的图不能 replan，旧证据不能跨
  workflow 复用。

协议枚举见 `src/contracts/managed.ts`，数据库约束见 `migrations/`；以下列出各自的
宿主与执行入口。相同的 `READY`、`FAILED` 等名称不表示相同的生命周期。

## Workflow 与图节点

| 宿主 | 状态集合 | 状态写入与验证入口 |
|---|---|---|
| `managed_workflow` | `ROUTING`、`READY`、`RUNNING`、`WAITING_HUMAN`、`WAITING_GATEWAY`、`PR_READY`、`PAUSED`、`DONE`、`FAILED`、`CANCELLED` | `workflow-store.ts` 认领/租约；`workflow-runtime.ts` 规划、推进、汇总；`workflow-runtime.test.ts` 真实 DB/git 回归 |
| `managed_workflow_graph` | `COMMITTED`、`SUPERSEDED` | `commitManagedWorkflowPlan`；已物化节点的图不可替换 |
| `managed_workflow_node` | `PENDING`、`READY`、`RUNNING`、`WAITING_HUMAN`、`WAITING_GATEWAY`、`PR_READY`、`ARCHIVED`、`FAILED`、`CANCELLED` | `nodeStatusForTicket`、节点同步、依赖物化和 archive |
| `managed_workflow_evidence` | `VALID`、`INVALIDATED` | `recordWorkflowStageEvidence`、`invalidateNodeEvidence`；失效证据不能用于复用或归档 |

workflow 的 `PR_READY` 与节点的 `RUNNING` 仍在持久协议枚举中，但当前汇总器不写
workflow `PR_READY`，ticket 的执行状态按现有节点映射处理。枚举存在不代表有独立
运行阶段；删除持久协议值需要单独评估存量与迁移。

调度先同步 ticket 事实，再选依赖前沿。`WAITING_HUMAN` 的 ticket 恢复为 `READY` 后，
不能因旧节点状态继续等待；旧节点 `PR_READY` 也不能盖住 ticket 的暂停或失败。
已归档/取消的节点不再回退；`FAILED` 节点只允许显式重试或已恢复 ticket 将其转回
`READY`，遵守数据库触发器。

每次推进期间持有 workflow lease。内联执行 ticket 阶段后还可能继续调用天问，
外层 workflow 以持有的 token 每 30 秒续约，不延长 ticket 自己的阶段租约；续约只能
延长仍有效的认领，不得复活过期/被替换的 token。内层完成后若续约失败，
直接返回 `CONFLICT`，不写回一个伪造的成功终态。worker 崩溃时续约停止，
原租约自然到期后再由其他 worker 认领。结算必须验证相同 token 与未过期租约；验证失败
返回 `CONFLICT`，不能把尚未落库的状态作为成功结果。状态结算记录
`ManagedWorkflowStatusChanged`，归档失败记录 `ManagedWorkflowArchiveFailed`。

汇总按以下顺序求值，前面的条件优先：

1. 当前图全部节点 `ARCHIVED` → `DONE`。
2. 存在可运行节点或依赖满足的未物化节点 → `READY`。
3. 存在等人工节点 → `WAITING_HUMAN`；存在等网关节点 → `WAITING_GATEWAY`。
4. 存在失败节点 → `PAUSED` 并保留错误。
5. 剩余节点包含取消 → `CANCELLED`；其他无进展情况 → `PAUSED`，保留阻塞原因。

一个节点等人、失败或取消不阻塞其他独立节点；依赖未满足的节点保持 `PENDING`。
没有节点的已提交图不能被解释为完成。

`workflow-cancel` 必须携带当前准确 `graph_version`。workflow 或任一 ticket 为
`RUNNING`，或未归档节点仍有 `EXECUTING` / `UNCERTAIN` / `SUCCEEDED` 外部动作时，
取消整体拒绝。只在静止边界把 workflow 置为 `CANCELLED`，取消非终态 ticket 与
待答 decision，递增 `control_generation`、清空 lease、阻断 `PENDING` / `LEASED`
outbox 并撤销 `VALID` permit。详细约束见
[workflow-routing](./spec/backend/workflow-routing.md#6-取消与静止边界)。

## Ticket 与阶段

| 宿主 | 状态集合 | 边界 |
|---|---|---|
| `managed_ticket_task` | `READY`、`RUNNING`、`WAITING_HUMAN`、`WAITING_GATEWAY`、`PAUSED`、`PR_OPENED`、`CHECKING`、`PR_READY`、`PR_CHECKS_FAILED`、`DONE`、`FAILED`、`CANCELLED` | `ticket-runtime.ts` / `ticket-store.ts` 管阶段；control/decision/action/check 模块只写各自职责下的转移 |
| `managed_ticket_stage` | `RUNNING`、`SUCCEEDED`、`REUSED`、`REWORK`、`FAILED`、`MUST_STOP` | 一行是一次尝试；结束后不可改写；失败产物只供诊断 |

阶段固定为 `execute → verify → review → land`。首次 check 未通过时，`verify` 记录
失败并回到 `READY/verify`，在相同提交、固定包和工作区上实跑一次。Keel 核对干净的
工作区和已有成功的 `execute` 证据。重验通过后进入 `review`。再次失败时，有返工
预算的 ticket 进入 `WAITING_HUMAN`，等待绑定该次失败的定向返工决议。普通暂停恢复
和重复批准都保留已用额度。权限或协议错误直接暂停，暂时的执行基础设施故障另有一次
原阶段重试。重验缺少任一原失败命令的结果时暂停。

`review` 有 open finding 时回 `execute`。`verify` 失败须有符合
[恢复策略](spec/backend/ticket-execution.md#4-阶段门禁)的证据才能回 `execute`。
review 回退和接纳的实际代码修复共用三轮上限。同一提交最多派发一次定向返工。
失败证据留在阶段记录，相关尝试收到脱敏、限长的摘录。新提交会改变 verify 和 review
的证据绑定。升级前记录为 `REWORK` 的 verify 回退继续沿用原有恢复规则。
managed XS/S 同样经过 review。

暂停/取消递增 `control_generation`，撤销未开始动作的 permit 并阻断 outbox；已开始
执行的外部动作必须回查，不能把本地暂停声称为外部副作用撤销。
人工恢复只接受可恢复状态，终态不复活；archive 修复后的重试可以只重试完成门，
不改写已完成的 ticket、不重跑四阶段，也不消耗新的执行尝试预算。

`execute` 的恢复决定被接纳后，可继续暂停时记录的干净提交。恢复必须绑定同一
stage 的决议版本，并重新核对原 HEAD、分支、diff、scope 与证据摘要；记录
`ManagedTicketDecisionRecovery` 后重新执行，原 `MUST_STOP`/`FAILED` 不变，后续
verify/review 门禁照常执行。恢复决定的控制代次和当前授权仍须有效；未改变现场的
可重试 Harness 错误不丢失恢复点。普通偏好决定不能授权工作区漂移，详见
[ticket-execution.md](spec/backend/ticket-execution.md)。
带请求动作而暂停的 recovery 还须同请求精确版本的人工一次批准，不能用委托
代替；真正 `MUST_STOP` 不走普通恢复。人工覆盖理由随台账决议下发到阶段上下文。

workflow 取消保留 `ARCHIVED` 节点及 claim；`FAILED` 节点和 `DONE` / `FAILED` /
`CANCELLED` ticket 保留原状态，其余未归档节点取消并释放本 workflow 持有的
`ACTIVE` claim。历史 stage、graph、evidence、worktree 全部保留；同一成功取消可
幂等重试，且不得释放新 owner 的 claim。

## Archive 是完成门

archive 要求 ticket 达到其固定目标：`branch_ready` 必须为 `DONE`，
`pr_ready` 必须为 `PR_READY`。不能把等待 push/PR 当作 branch 交付完成。

归档事务锁定 ticket 和节点，然后核对：

- 工作树干净，当前 HEAD 精确等于 handoff 的 40 位 SHA。
- 当前 baseline..HEAD diff 等于 handoff。
- 每个阶段的最新尝试为 `SUCCEEDED` / `REUSED`，输出 commit、包与门禁摘要匹配。
- 对应 workflow 证据仍为 `VALID`，绑定当前图、stage、head、diff 与证据摘要。
- `pr_ready` 的 check gate 为 `READY`，head 与 handoff 相同，证据摘要有效。

失败时节点记为 `FAILED` 并保留具体原因；没有其他可推进节点时 workflow 为
`PAUSED`。后续轮次不反复尝试失败的 archive；修复后通过 `workflow-retry` 显式重试。
archive 留存证据，不自动关闭远端 Issue。legacy Issue 回写属于另一条受控路径。

## 决策与记忆

| 宿主 | 生命周期与入口 |
|---|---|
| `managed_decision_request` | `OPEN` → `PROCESSING` → `WAITING_HUMAN` / `RESOLVED`；可取消为 `CANCELLED`，旧 revision 被新 revision 取代为 `SUPERSEDED`；见 `decision-store.ts` |
| `managed_decision_resolution` | revision 下唯一决议，保留真实人工与委托来源；天问 proposal 经 `decision-acceptor.ts` 接纳，不伪装成 HumanApproved |
| `managed_project_decision` / `managed_delegation_policy` | 通过版本、适用范围、撤销和替代字段判定有效性，不能只看最新版本号；见 `decision-acceptance.md` |
| `managed_project_memory_summary` | `DRAFT`、`ACTIVE`、`SUPERSEDED`、`ROLLED_BACK`、`REJECTED`；由有效项目决定重建，epoch/水位改变使旧视图失效；见 `memory-store.ts` |

`WAITING_HUMAN` 是持久等待，不是进程存活承诺；答复必须携带 request id 和 revision。
“批准继续”不等于生产动作许可，动作网关仍重新检验有效授权和当前证据。

## 外部动作与 required checks

| 宿主 | 状态集合 | 边界 |
|---|---|---|
| `managed_action_outbox` | `PENDING`、`LEASED`、`EXECUTING`、`SUCCEEDED`、`FAILED`、`BLOCKED`、`UNCERTAIN` | `action-store.ts` / `action-gateway.ts`；执行后失联进入 `UNCERTAIN`，先回查远端再重试 |
| `managed_execution_permit` | `VALID`、`CONSUMED`、`REVOKED`、`EXPIRED` | 精确绑定动作、资源、SHA、diff、授权和控制代次；一次性消费 |
| `managed_check_target` | `PENDING`、`CHECKING`、`READY`、`FAILED` | `check-store.ts` / `check-gateway.ts`；只读外部 checks，不能把缺失/旧 SHA 当成功 |

action 成功只使 ticket 进入 `PR_OPENED`；check gateway 才能推进
`CHECKING → PR_READY`。执行进程、租约、outbox、PR 和 CI 各有独立状态，不能从其中
一个推断另一个成功。

## 调查影子路径与保留边界

JT-01 调查仍有独立的 `managed_task` 与 `managed_question`：

- task 为 `READY`、`RUNNING`、`WAITING_TIANWEN`、`WAITING_HUMAN`、`DONE`、
  `FAILED`、`CANCELLED`，phase 为 `investigate` / `tianwen`。
- question 为 `OPEN`、`WAITING_HUMAN`、`RESOLVED`，由 `runtime.ts` / `store.ts`
  推进；调查 `DONE` 只表示报告完成，不代表 ticket 代码已交付。
- 调查决策只走 DecisionRequest 台账；缺台账的旧天问结算明确失败
  `DECISION_REQUEST_MISSING`，人工答复拒绝。历史建议和问题保留查询，不再运行旧建议协议。
- `managed_issue_claim` 的 `ACTIVE` / `RELEASED` 表示 issue 所有权，不是执行完成态。
- service 角色健康、trial 窗口与备份恢复各有生命周期，分别见
  [service-runtime](./spec/backend/service-runtime.md) 和
  [trial-readiness](./spec/backend/trial-readiness.md)。

旧 `run-task`、`run-issue`、`ingest-issue` 和 poller 仍是显式 legacy 入口；
`managed workflow-*` / `ticket-*` 是 managed 入口。目前不存在把旧入口静默升级为
managed 的路由，不能把旧命令执行结果当作当前 jstack 产品链路验收。

## 验证范围

`pnpm run check` 的 C4 比对 legacy Task 与驾驶权表，managed 则由实际 DB/git 的
runtime、decision、action、check、memory 测试验证。本页不是一个已覆盖所有状态
的机器可读转移表，不能声称 C4 已证明全部 managed 转移一致。

2026-11-15 工程核对基准为 jstack `main` 的 `20a8a3e`。真实多 Harness、连续试运行与
生产准入的证据边界仍以 [实施进度](./plans/jstack-tianwen/implementation.md) 为准。
