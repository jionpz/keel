# rfc_draft 服从低风险约束以关闭 AC5

父任务：`.trellis/tasks/08-27-github-issue-automation`（AC5 未关）。

## Goal

让**明确声明为文档-only / low-risk**的 GitHub Issue，经 `keel run-issue --ci real` 后能到达 **S-DONE** 并产出通过 CI 的真实 PR（关闭父 AC5）。

根因（已核验两次）：`rfc_draft` 产出的 `policy_facts` 自报 `risk/complexity=high`，命中 Policy P1 → `S-HUMAN_REVIEW`。Issue 正文已要求 low/low/1，模型未服从。**禁止放宽 Policy**。

## Requirements

- R1 修订 `rfc_draft`（及必要时 `pm`）提示词：当用户反馈**显式给出** risk/complexity/files/security 约束时，RFC 的 `policy_facts` **必须原样采用**；仅在反馈未给出时才自主评估。删除或改写「不要硬凑 low」中会鼓励抬高风险的表述。
- R2 确定性测试：给定「只改 README、risk=low…」类反馈文本，断言 rfc prompt 文本含服从约束的指令；若有可测的 post_validate/heuristic，对明显违反反馈约束的 policy_facts 拒收并回灌（可选，若实现成本低）。
- R3 不改 `DEFAULT_RULES` / 严格性偏序。
- R4 opt-in：再跑仅 `issue-e2e`；目标 S-DONE + PR；若仍 HUMAN_REVIEW，诚实记录，不伪造。

## Acceptance Criteria

- [ ] AC1：提示词明确「反馈给出的 policy 约束优先于模型自评估」
- [ ] AC2：`pnpm run check` 全绿
- [ ] AC3：`issue-e2e` 至少一次到达 S-DONE + 真实 PR（或诚实记录第三次失败与新证据）

## Out of Scope

- 放宽 Policy P1–P4
- Webhook / daemon / work queue
- 自动 merge
