# GitHub Issue 回写与澄清

## 授权与入口

本协议覆盖 legacy Task。管理员通过
`pnpm keel register-repo <remote> --issue-writeback off|comment|comment_and_close`
设置仓库开关；默认 `off`，重复注册不传此参数时保留已有值。
`off` 不入回写队列，也不调用评论或关闭 API。执行中的 managed 工作流不消费此开关。

`IssueGateway` 只描述创建评论、关闭 Issue、分页读取评论与当前凭据身份。
`GitHubProvider` 负责实现，复用既有 host、GHES API root、token 解析与错误映射，
请求有超时；凭据不进入正文、事件或日志。

## 节点与标记

driver 在状态转移事务内将评论意图写入 `issue_delivery`，由 poller 每轮维护发送。
仅处理关联 `source=github` 的原始 Issue Feedback，按来源引用逐个回写。

- `accepted`：PM 接受，包含 Task ID。
- `clarification_requested`：PM 不明确，列出 1–5 个问题，提示直接回复 Issue。
- `rejected`：拒收分类、理由与证据；提示仍复现时附截图重开。
- `human_review`：翻译策略要求或阶段重试耗尽原因。
- `pr_opened`：真实 PR 创建或幂等复用后才发送，包含 PR 链接。
- `ci_passed`：仅真实 GitHub CI，说明等待合并；模拟 CI 不外发成功消息。
- `merged`：仅真实 GitHub 合并观测，Task 已完成；模拟合并不外发消息。
- `abandoned`：澄清/人工评审超时或 PR 未合并关闭。Issue 已关闭的 T-040 不评论。

末行固定为：

```text
<!-- keel:v1 event=<event> task=<taskId> state=<S-...> -->
```

字段与枚举是外部消费契约，破坏性变更需升 `v2`。
前一行带单次投递标识 `<!-- keel:delivery=<dedupe_key> -->`。

## 幂等与失败

`dedupe_key` 包含 task、事件、转移序号和来源 Issue。并发发送锁投递行，
成功前先查已有评论；只接受当前凭据身份发布的同一投递标记。
网络结果丢失时，通过远端标记恢复，不盲目重发。评论分页被截断时拒绝发送并留证。

发送失败不回滚 Task 状态；记录 `SideEffectFailed` 的错误种类与可用 HTTP 状态码。
默认最多 5 次，下一轮重试；发送成功记录 `SideEffectApplied`。
评论与关闭分开保存回执，关闭失败不重发评论。
每次投递重新读取开关，改回 `off` 后不继续发送。
`comment` 不关单；`comment_and_close` 仅将拒收 Issue 以 `not_planned` 关闭。
本协议不自动合并或部署。

## 澄清收答

仅处理自动模式、`S-NEED_CLARIFICATION` 且问题评论已成功投递的任务。
读取本轮问题之后的新评论，排除当前 token 账号以及含 Keel 标记的评论；
旧评论、空正文不作为答复。使用同一账号发问和答复时，答复会被自答过滤，
此时可用现有 `keel answer` 或控制台入口。

以 `keel_ingress` 插入不可变 Feedback：
`source=github`、`external_ref=owner/repo#n/comment/<commentId>`。
同轮多条答复分别入库，经 task 行锁与 current run 检查关联，再以
`ClarificationReceived` 进入既有 T-007。重复读取不重复入库，后续编辑不覆盖首次事实。
人工 `keel answer` 入口保留。
PM 与策略事实校验共用反馈窗口：原始需求和最近 9 条答复，按时间顺序呈现。
超出窗口时在上下文与 `ContextBuilt.diagnostics` 标明省略数量，避免后续多轮答复被旧反馈挤掉。

## PM 产物版本

新 PM 提示词输出 A-StageOutcome `schema_version=1.1`：
`unclear` 必须给出 1–5 个非空 `questions`；
`reject` 必须给出 `reject_kind` 与 `evidence`，
`duplicate|already_fixed` 的证据数组至少一项。
旧 `1.0` 产物仍合法，历史事实不迁写。
类型和校验器均由 `docs/schemas/stage-outcome.schema.json` 生成。

PM 只将仓库信号当作只读线索。证据不足不得断言已修复；
继续 `actionable` 并要求后续 RFC 核对风险，或提出明确问题。
