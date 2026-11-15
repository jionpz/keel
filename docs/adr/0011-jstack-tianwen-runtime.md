# ADR-0011 · jstack 为主工作流，天问作为项目用户代表

**Status**: Accepted — 用户已确认产品方向与职责边界；JT-01～JT-06 的实现已合入 `main`，
JT-07 就绪工具已实现，但真实 7 天试运行、独立评测与生产准入仍未完成。
**Date**: 2026-11-10
**Related**: ADR-0003、0004、0006、0010；[完整方案](../plans/jstack-tianwen/README.md)。

## Context

用户的多个项目已经使用 jstack，并指定它作为长期核心工作流。Keel 产品需要后台自动运行，减少人工介入；原本交给人的任何问题先经过“天问”，由它依据项目历史决定和明确授权代表用户回答，解决不了再上报。

ADR-0010 只规定开发 Keel 时使用 jstack，没有实现 Keel 在产品运行期使用它。当前固定状态机和简化阶段提示词不能完整承载 jstack 的路线、ticket 与门禁。jstack 当前也没有统一的 DecisionProvider，must-stop 仍明确要求真实用户。

单纯定期把全部历史写成系统提示词会丢失适用条件、混淆项目、固化推断，并将过期答案误作授权；把天问输出记成 HumanApproved 则破坏审计和权限语义。

## Options

| 方案 | 收益 | 代价 |
|---|---|---|
| 现有 Keel 阶段内调用完整 route | 接入快 | 两套编排重复验证/评审/开 PR；内部状态不可恢复 |
| 为每个 Keel 旧阶段替换 jstack 提示词 | 可渐进试验 | 无完整路线、问题协议或门禁，无法满足本次生产目标 |
| jstack 发布工作流契约，Keel 持久运行，天问统一代决 | 方法和运行职责清晰，支持后台恢复与项目代表 | 需同时改 jstack/Keel 的协议、门禁、持久模型和验收 |

## Decision

采用第三项，具体约束如下。Accepted 表示方向已采用，不表示生产准入已完成：

1. jstack 是工作流的定义源，Keel 是持久运行层；新任务固定工作流包、路线、提供者和门禁版本。
2. 所有系统生成的人工请求先进入天问。天问可以在明确项目授权内直接代答/代批；需要新授权或仍缺依据时，整理建议交给用户。
3. 天问与 Harness 同属 Execution Plane，只提案；确定性接纳和动作许可属于 Control Plane。不能通过提示词、历史实例或模型确信扩权。
4. 长期记忆采用项目级原始决策记录、版本化摘要与按需少量原文检索；固定角色提示词不被自动摘要改写。
5. 真实人工、委托决定、推断、临时默认、工具观察分开记账；用户未纠正不算确认。
6. jstack 的 managed 模式正式扩展 must-stop：暂停动作并获取有效处置；对必须 owner 的请求，天问准备后升级。不能把现有规则偷偷解释为 AI 等于真人。
7. 等待异步持久化，答复自动恢复；独立节点继续；失效、撤销、并发、外部副作用和灾后恢复都有明确语义。
8. 原有 `legacy-v01` 任务保留原驱动；新增模型与新流程通过 expand–contract 交付，不自动改造已运行任务。

## 当前实现进度

以下是 2026-11-15 的独立实现快照，用于区分“决策已采用”和“生产验收已完成”；
它不改变本 ADR 的原始约束，也不把历史验证结果升级为全局支持声明。

| 切片 | 当前仓库中的实现锚点 | 证据边界 |
|---|---|---|
| JT-01 / JT-02 | `src/control/managed/runtime.ts`、`runtime-decision.test.ts` 实现只读调查、DecisionRequest、天问 proposal 与答复唤醒；`ticket-runtime.ts`、`ticket-protocol.ts` 实现固定 ticket 包和四阶段门禁 | 调查链仍是影子模式；固定包、阶段与决策路径已有确定性测试，不能据此声称所有 Harness 原生验收通过 |
| JT-02D / 02E / JT-05 | `action-gateway.ts` 重验授权、工作树、SHA 与 diff 后执行受控 push/PR；`check-gateway.ts` 只接受准确 PR head 的显式 required-check success；`action-gateway.test.ts`、`check-gateway.test.ts` 覆盖撤销、暂停、幂等与旧 SHA 拒绝 | `PR_READY` 仅表示 required checks 已通过，不表示 PR 已 merge；自动 merge/部署不在当前路径 |
| JT-03 | `memory-protocol.ts` 与 `memory-store.ts` 实现项目隔离、版本化摘要、epoch/水位失效、增量检索、回滚与人工答案提升 | 当前检索为关键词/子串与受控扩展，不是语义检索；跨项目记忆和自动扩权不在范围 |
| JT-04 | `route-protocol.ts`、`workflow-runtime.ts` 实现 XS/S/M/L/XL route 包、依赖图、scope、节点调度、证据复用与 archive | 有限多 ticket 实测不等于 XL、所有 provider 或生产故障场景均已验收 |
| JT-06 / JT-07 | `keel serve`、备份恢复、`doctor` 支持矩阵与试运行账本是当前实现的一部分，详见 [实施进度](../plans/jstack-tianwen/implementation.md) | 尚无生产部署；完整试运行门槛、独立评测、原生 Claude、Pi 完整原生协议与生产恢复演练仍未完成 |

当前最可靠的总体证据是
[实施进度](../plans/jstack-tianwen/implementation.md)；GitHub issue 的具体状态以
tracker 为准。代码与测试通过只证明对应切片可重复验证，**不构成生产验收通过**。

## Consequences

- 用户可以把决策习惯与项目约束一次传达、持续纠正，同类问题无需重复答。
- jstack 的流程升级有单一来源；进行中任务可固定版本，恢复时不重跑一套新流程。
- 需要可验证的来源、有效性和范围，比只加一个 Agent/提示词的实现成本高。
- 真实用户仍是授权范围与未确定重要取舍的最终来源；天问不会自行生成这些授权。
- 日志/记忆持久化扩大了敏感信息保存范围，需要脱敏、保留策略与备份恢复演练。
- 现有 Keel 单进程语义、人工事件和 ContextBuilder 都要扩展；现有 jstack 所支持的 harness 不自动视作具备 managed 能力。

## Verification

采用[交付与准入](../plans/jstack-tianwen/delivery.md)及[验收场景](../plans/jstack-tianwen/acceptance.md)。
本 ADR 的采用不替代各切片验收，也不授予生产动作权限；当前实现进度与未验项以上文
“当前实现进度”为准。代码合入、确定性测试和有限真实证据均不等于生产准入通过。
