# 06 · 结构化产物（Artifacts）

> 满足 PRD `R5`；关闭缺口 `G4`（Critic 调用无 schema）、`G6`（Checkpoint 无 schema、与 State 关系不明）。
> 机器可读的 schema 文件在 [`../docs/schemas/`](./schemas/)，本文讲**语义**与**为什么这样设计**。

---

## 0. 通用约定

所有产物存于 `artifact` 表（见 [`03-domain-model.md`](./03-domain-model.md) §2.6），
`body` 为 JSONB。每个 `body` **必须**含 `schema_version`。

| 约定 | 规则 |
|---|---|
| 版本 | `schema_version` 形如 `"1.0"`。破坏性变更升主版本，且必须配迁移说明 |
| 不可变 | 产物只增不改。"修改" = 插入新 `version` + 回填旧行 `superseded_by`（不变量 `I2`） |
| 写入方 | **只有 Control Plane**。Execution Plane 通过 Proposal 提交（不变量 `I5`） |
| 校验时机 | Proposal 提交时按 `schema_version` 对应的 JSON Schema 校验；不过则走 `R-007` 回灌 |

本章示例统一使用初稿 §13 的真实案例：

> 用户反馈："导出的 Excel 希望能够按照日期筛选。"

---

## 1. 产物总览

| ID | `kind` | `key` | owner | 生命周期 |
|---|---|---|---|---|
| `A-State` | `state` | `''` | Task | 与 Task 同寿，持续追加版本 |
| `A-RFC` | `rfc` | `''` | Task | `S-RFC_READY` 时冻结 |
| `A-Checkpoint` | `checkpoint` | `run_id` | **Session** | Session 销毁后仍可用于 resume |
| `A-StageOutcome` | `stage_outcome` | `run_id` | Run | 一次性，**状态机守卫的唯一输入源** |
| `A-CriticReview` | `critic_review` | `request_id` | Run | 一次性，不更新 |
| `A-PolicyDecision` | `policy_decision` | `decision_point` | Task | 一次性，不更新 |
| `A-CapabilityRequest` | `capability_request` | `request_id` | Run | 一次性，被受理后引用其结果 |
| `A-Event` | —（独立 `event` 表） | — | 全局 | 只增不改，永久 |

---

## 2. `A-State` —— Task 的事实集合

**回答的问题**：关于这个 Task，我们目前知道什么？

> ⚠️ 再次强调：`A-State` **不是** `task.status`。
> 前者是内容，后者是状态机位置。初稿把两者叫同一个名字，见 [`02-glossary.md`](./02-glossary.md) §6。

```json
{
  "schema_version": "1.0",
  "current_goal": "让导出的 Excel 支持按日期区间筛选",
  "context_summary": "反馈来自 3 位企业用户；现有导出走 ExportService.buildWorkbook()，无筛选参数",
  "confirmed_facts": [
    { "id": "F1", "text": "现有导出接口无任何筛选参数", "source": "run:pm#1", "confidence": 1.0 },
    { "id": "F2", "text": "导出数据源已有 created_at 索引", "source": "run:pm#1", "confidence": 0.9 }
  ],
  "candidate_options": [
    { "id": "A", "summary": "在现有导出接口上加日期参数", "pros": ["改动小"], "cons": ["接口参数继续膨胀"], "status": "recommended" },
    { "id": "B", "summary": "新建 Export Service", "pros": ["长期可扩展"], "cons": ["改动范围大"], "status": "rejected" },
    { "id": "C", "summary": "在 SQL 层加过滤", "pros": ["最快"], "cons": ["扩展性差"], "status": "rejected" }
  ],
  "decisions": [
    { "id": "D1", "text": "采用方案 A", "rationale": "Critic 评分最高且改动面最小", "decided_at": "2026-08-22T10:14:00Z", "decided_by": "run:brainstorm#1" }
  ],
  "open_questions": [
    { "id": "Q1", "text": "日期区间是否需要支持时区", "blocking": false }
  ],
  "risks": [
    { "id": "R1", "text": "导出量大时日期过滤可能超时", "severity": "medium", "mitigation": "加分页与超时保护" }
  ]
}
```

**设计要点**：

- 每条 fact / decision 都带 **`source`** 或 **`decided_by`**，指向产生它的 Run。
  没有溯源的事实无法审计，也无法在事后判断"这个结论当时凭什么下的"。
- `decided_by` 的取值可以是 `run:*`，**也可以是人**（如 `human:jionpz`）。
  人工接管期间的决策走同一个字段 —— 这是"人工与 AI 同一套规范"的具体体现（见 `04-state-machine.md` §3.2）。
- `open_questions[].blocking` 决定 PM 是否还能继续推进。

---

## 3. `A-RFC` —— PM → Developer 的交接物 · 关闭 G11

**回答的问题**：要做什么、怎么做、做完怎么算数？

```json
{
  "schema_version": "1.0",
  "title": "Excel 导出支持日期区间筛选",
  "problem": "企业用户导出全量数据后需自行在 Excel 中筛选日期，数据量大时不可用",
  "goals": ["导出接口支持 date_from / date_to 参数"],
  "non_goals": ["不改动导出文件格式", "不支持除日期外的其他筛选维度"],
  "proposed_change": {
    "summary": "在 ExportService.buildWorkbook() 增加可选日期区间参数，透传至查询层",
    "affected_areas": ["ExportService", "导出 API 路由", "导出查询构造"],
    "approach": "新增可选参数，缺省行为与现状完全一致，保证向后兼容"
  },
  "alternatives_considered": [
    { "id": "B", "summary": "新建 Export Service", "why_not": "改动范围远超需求，Critic 评分 7.4" },
    { "id": "C", "summary": "直接在 SQL 层过滤", "why_not": "未来扩展性差，Critic 评分 5.1" }
  ],
  "acceptance_criteria": [
    { "id": "AC1", "text": "传入 date_from/date_to 时，导出仅含该区间数据", "verifiable_by": "集成测试" },
    { "id": "AC2", "text": "不传参数时，导出结果与改动前逐字节一致", "verifiable_by": "回归测试" }
  ],
  "test_plan": ["为 AC1/AC2 各加集成测试", "补充空区间与反序区间的边界用例"],
  "rollback_plan": "参数为可选且缺省行为不变，回滚 = revert 单个 commit",

  "policy_facts": {
    "risk": "low",
    "complexity": "low",
    "estimated_files_changed": 4,
    "security_related": false
  }
}
```

### 3.1 `policy_facts` 为什么在这里 · 关闭 G7 的一半

初稿 §12 的 Policy 规则引用了 `risk`、`files_changed`、`security_related`、`complexity`：

```yaml
- condition: "risk == high"              → human_review
- condition: "files_changed > 30"        → architecture_review
- condition: "security_related == true"  → security_review
- condition: "complexity == low && risk == low" → auto_develop
```

但初稿**从没说这些字段从哪来**。它们的产地就是 RFC ——
PM 在收敛方案时本来就要做这些判断，只是初稿没把它落成字段。

把它们**显式聚在 `policy_facts` 下**，好处是：

1. Policy 的输入来源单一且可追溯（不是散落在各处被临时拼凑）
2. `A-PolicyDecision` 可以完整快照这个对象，从而**可重放**
3. RFC 冻结 ⇒ policy_facts 冻结 ⇒ 同一 RFC 版本的 Policy 判定结果**恒定**

> `tests_failed`（初稿的第 5 条规则）**不在** `policy_facts` 里 ——
> 它是运行期事实，来自 `run` 表的失败计数，在 `04-state-machine.md` 的 `T-019`/`T-030` 中作为 guard 使用。
> 静态事实与运行期事实分开，是因为前者随 RFC 冻结，后者持续变化。

### 3.2 冻结语义

Task 进入 `S-RFC_READY`（转移 `T-011`）时，当前 version 的 RFC 冻结（不变量 `I7`）。
变更走新 version + `superseded_by`，**不原地改写** ——
因为 Developer 已据此开工，改写会让"当时按什么做的"这个事实永久消失。

---

## 4. `A-Checkpoint` —— Session 的可恢复摘要 · 关闭 G6

**回答的问题**：这个会话进行到哪了？怎么接着往下？

```json
{
  "schema_version": "1.0",
  "run_id": "8f3a...",
  "harness_id": "claude-code",
  "harness_tier": "L2",
  "turn_index": 6,
  "progress": "6/10",
  "current_goal": "收敛到不超过 3 个候选方案",
  "next_action": "continue_brainstorm",
  "working_summary": "已确认导出接口无筛选参数；A/B/C 三方案已提出，等待 Critic 评审",
  "emitted_artifacts": ["artifact:state@3", "artifact:capability_request@1"],
  "unresolved_questions": ["日期区间是否需要支持时区"],
  "resume_hint": {
    "mode": "session_ref",
    "session_ref": "sess_01H..."
  }
}
```

### 4.1 `resume_hint` —— L0/L1 降级的开关

它是一个**按 `mode` 判别的联合**，而不是"一个 mode 字段 + 两个可空字段"：

| `mode` | 适用 | 必需字段 | 恢复方式 |
|---|---|---|---|
| `session_ref` | Adapter 声明 `CAP-RESUME` | `session_ref` | 把句柄交回 Harness（如 `claude --resume <id>`），会话上下文由 Harness 侧保持 |
| `rematerialize` | **无** `CAP-RESUME`，或句柄已失效 | `rematerialize_from` | 由 Context Builder 从 `A-State` + 本 Checkpoint 的 `working_summary` **重新构造**上下文，开新会话 |

> 建模为判别联合是刻意的：两种模式**所需的数据不同**。
> 若写成"mode + 两个可空字段"，就会出现 `mode: "session_ref"` 而 `session_ref` 为空这种
> 无意义但类型合法的状态。判别联合让它在 schema 层面就无法表达。
>
> 这也让生成的 TS 类型可被收窄 —— 见 `ADR-0002` L1。

这是"Harness 可替换"能否成立的技术核心：

> 无法 resume 的 Harness **不会**让闭环失效，只会让它**更贵** ——
> 每次恢复要重新物化上下文，多花 token，但**正确性不降级**，
> 因为事实本来就不在会话里，而在 Fact Plane。

这正是"Session inside, State outside"在工程上的兑现方式。

### 4.2 与 `A-State` 的区别（这是 G6 的正面回答）

| | `A-State` | `A-Checkpoint` |
|---|---|---|
| 回答 | 关于 Task 我们知道什么 | 这个会话进行到哪了 |
| owner | Task | **Session** |
| 数量 | 一个 Task 一条主线 | 一个 Task 可有多条（每个 Run 一条） |
| Task 终结后 | 是 Task 的最终事实 | 只有归档价值 |
| 丢失的后果 | **事实丢失，不可接受** | 只是要重新物化上下文，**可接受** |

最后一行是判断依据：**丢了会导致事实消失的，放 `A-State`；丢了只是费点 token 的，放 `A-Checkpoint`。**

> 初稿 §11 说"完整对话可以作为 Debug / Audit 数据保存，但不是每次恢复都加载"——
> 这个主张本文档采纳，其代价（摘要恢复的质量损失）在 `adr/0006` 中评估。

---

## 5. `A-CriticReview` —— 结构化评审 · 关闭 G4

初稿 §8 给了一个 Critic 输出的 JSON 例子，但 `scores` 是三个裸数字，
**没有量表、没有评分维度、没有置信度** —— 无法判断 8.2 和 7.4 的差距是否显著。

```json
{
  "schema_version": "1.0",
  "review_type": "architecture",
  "request_id": "creq_01",
  "subject_ref": "artifact:state@2",
  "scale": { "min": 0, "max": 10, "higher_is_better": true },
  "criteria": ["改动范围", "长期可扩展性", "回归风险", "实现成本"],
  "scores": [
    { "option_id": "A", "total": 8.2, "by_criterion": { "改动范围": 9, "长期可扩展性": 7, "回归风险": 9, "实现成本": 8 } },
    { "option_id": "B", "total": 7.4, "by_criterion": { "改动范围": 5, "长期可扩展性": 9, "回归风险": 7, "实现成本": 6 } },
    { "option_id": "C", "total": 5.1, "by_criterion": { "改动范围": 8, "长期可扩展性": 3, "回归风险": 5, "实现成本": 9 } }
  ],
  "findings": [
    { "id": "CF1", "severity": "medium", "text": "B 改动范围较大", "evidence": "涉及 3 个模块的接口变更" },
    { "id": "CF2", "severity": "high", "text": "C 未来扩展性较差", "evidence": "过滤逻辑下沉 SQL 后，新增维度需改动查询构造" }
  ],
  "recommendation": "A",
  "confidence": 0.75,
  "dissent": null
}
```

**相对初稿的补强**：

| 字段 | 为什么必须有 |
|---|---|
| `scale` + `criteria` | 没有量表的分数无法比较，也无法跨 Critic 复现 |
| `by_criterion` | 只有总分时，PM 无法知道差距出在哪个维度 |
| `confidence` | 低置信度的推荐不应触发自动推进 —— 它是 Policy 的输入 |
| `evidence` | 无证据的 finding 无法核实，等同于意见 |
| `dissent` | 多 Critic 时记录分歧。**分歧本身是信号**，不应被平均掉 |

---

## 6. `A-CapabilityRequest` —— PM 请求能力调用的通用机制 · 关闭 G4 的另一半

初稿 §8 展示 PM 产生一个 `{"type": "request_review", ...}`，Runtime 据 Policy 决定是否调 Critic。
但那只是**一个特例**，没有说明通用机制。本产物把它一般化：

```json
{
  "schema_version": "1.0",
  "request_id": "creq_01",
  "requested_by_run": "run:brainstorm#1",
  "capability": "critic_review",
  "params": {
    "review_type": "architecture",
    "subject_ref": "artifact:state@2",
    "options": ["A", "B", "C"]
  },
  "rationale": "存在 3 个候选方案，需要架构视角裁决",
  "blocking": true
}
```

**关键语义**：

> Session **不调用**任何能力。它 emit 一个 `A-CapabilityRequest`，
> 由 Control Plane 查 Policy 决定是否受理、派发给谁。

受理后：Control Plane 创建对应的 Run（如 `run(critic, n)`，转移 `T-009`），
结果落成 `A-CriticReview`，再由 Context Builder 在下一轮喂回原 Session。

`blocking: true` 表示原 Session 应等待结果；`false` 表示可继续推进，结果到了再并入。

`capability` 的取值构成一个**注册表**，v0.1 至少包含：

| capability | 说明 |
|---|---|
| `critic_review` | 请求 Critic 评审 |
| `human_input` | 请求人工输入（触发 `S-NEED_CLARIFICATION` 或通知） |
| `additional_context` | 请求 Context Builder 补充特定资料 |

> 这个机制的价值在于：**新增一种能力不需要改 Session 的实现**，
> 只需在注册表加一项 + 在 Policy 加一条规则。PM 不需要知道 Critic 是怎么实现的（初稿 §8 的原意）。

---

## 7. `A-PolicyDecision` —— 可重放的裁决记录 · 关闭 G7

```json
{
  "schema_version": "1.0",
  "decision_point": "rfc_ready",
  "policy_version": "2026-08-01",
  "evaluated_at": "2026-08-22T10:31:00Z",
  "facts_snapshot": {
    "risk": "low",
    "complexity": "low",
    "estimated_files_changed": 4,
    "security_related": false,
    "critic_confidence": 0.75,
    "dev_attempts": 0
  },
  "matched_rules": [
    { "id": "P4", "condition": "complexity == low && risk == low", "action": "auto_develop" }
  ],
  "decision": "auto_develop",
  "reason": "复杂度与风险均为 low，且无安全相关改动",
  "default_applied": false
}
```

**三个关键设计**：

1. **`facts_snapshot` 是求值时输入的完整快照**，不是引用。
   引用会随时间变化，快照才能保证"同样的输入永远得到同样的裁决" —— 重放的前提。

2. **`default_applied`** 显式记录"是否因无规则命中而走了默认"。
   Policy 默认语义是 **deny**（落到人工）。把它记下来，才能发现"大量 Task 走默认"这种规则覆盖不足的信号 ——
   否则默认 deny 会安静地把系统退化成全人工，而没人察觉。

3. **`matched_rules` 是数组**：多条规则可能同时命中。冲突裁决规则见
   [`05-contracts/policy-engine.md`](./05-contracts/policy-engine.md)。

---

## 8. `A-StageOutcome` —— 阶段结论

**回答的问题**：这个阶段跑完，结论是什么？

> 🔎 **本产物是 `07-flows.md` 的流程走查抓出来的缺口。**
> [`04-state-machine.md`](./04-state-machine.md) 的转移守卫引用了
> `verdict=actionable`、`qa_verdict=pass`、`review_verdict=fail` 等值，
> 但在走查之前，这些值**没有任何定义好的存放位置** —— 守卫读的是空气。
> 详见 [`07-flows.md`](./07-flows.md) §4。

```json
{
  "schema_version": "1.0",
  "run_id": "8f3a...",
  "stage": "qa",
  "verdict": "fail",
  "reason": "AC2 回归测试未通过：不传参数时导出结果与改动前不一致",
  "details": {
    "failed_criteria": ["AC2"],
    "test_report_ref": "artifact:state@7"
  }
}
```

### 8.1 各阶段的 `verdict` 取值

本产物建模为**按 `stage` 判别的联合** —— 每个阶段有自己的 `verdict` 取值集合，
而不是一个所有阶段共用的大枚举。这样守卫在类型层面就能被收窄：
拿到一个 `stage === 'qa'` 的结论，`verdict` 只可能是 `pass` 或 `fail`。

| `stage` | 允许的 `verdict` | 被哪条转移读取 |
|---|---|---|
| `pm` | `actionable` \| `unclear` \| `reject` | `T-003` `T-004` `T-005` `T-006` |
| `brainstorm` | `converged` \| `needs_more` | `T-010` |
| `rfc_draft` | `drafted` | `T-011` |
| `critic` | `reviewed` | `T-009` |
| `develop` | `implemented` \| `blocked` | `T-017` |
| `qa` / `review` | `pass` \| `fail` | `T-018`–`T-023` |

`pm` 阶段的 `details.needs_design`（布尔）区分 `T-003`（走 brainstorm）与 `T-004`（直接起草 RFC）。

`qa` 与 `review` 的结论形状相同，故在 schema 中合为一支（`VerificationOutcome`）。

### 8.2 为什么它是独立产物而不是塞进 `A-State`

因为**守卫必须读结构化枚举，不能读自由文本**。

如果把 "PM 认为这条反馈可做" 写进 `A-State.decisions[].text`，
转移守卫就得去解析一句中文 —— 那等于把状态机的正确性押在字符串匹配上。

`A-StageOutcome` 与 `A-State` 的分工：

| | 内容 | 消费者 |
|---|---|---|
| `A-State` | 我们知道什么（事实、决策、风险） | 下一个 Session（经 Context） |
| `A-StageOutcome` | 这一阶段的结论是什么（枚举） | **状态机守卫** |

### 8.3 人工产出同样走这个产物

人工接管完成某阶段后，交还前必须提交一条 `A-StageOutcome`
（见 [`04-state-machine.md`](./04-state-machine.md) §3.2）。
此时 `run_id` 指向一个 `harness_id = "human"` 的 Run —— 人工在模型里就是另一种 Harness。

---

## 9. `A-Event` —— 事件信封

存于独立的 `event` 表（见 `03-domain-model.md` §2.8），不在 `artifact` 表。

```json
{
  "schema_version": "1.0",
  "seq": 10247,
  "task_id": "3c1f...",
  "run_id": "8f3a...",
  "type": "TaskStatusChanged",
  "payload": { "from": "S-RFC_READY", "to": "S-DEVELOPING", "transition": "T-012" },
  "trace_id": "4bf92f...",
  "span_id": "00f067...",
  "occurred_at": "2026-08-22T10:31:02Z"
}
```

### 9.1 事件类型注册表（v0.1）

| 类型 | 触发处 |
|---|---|
| `FeedbackReceived` | Ingress |
| `TaskCreated` | `T-001` |
| `TaskStatusChanged` | 所有 `T-*` |
| `ControlModeChanged` | 所有 `C-*` |
| `RunCreated` / `RunStatusChanged` | 所有 `R-*` |
| `ProposalSubmitted` / `ProposalAccepted` / `ProposalRejected` | Emit 通道 |
| `ArtifactCommitted` | Artifact Store |
| `PolicyEvaluated` | Policy Engine |
| `CapabilityRequested` / `CapabilityGranted` / `CapabilityDenied` | Control Plane |
| `SideEffectSkipped` | 幂等命中（`04-state-machine.md` §5.3） |
| `SideEffectApplied` | 副作用已施加。**通知类副作用的幂等判重依据** |
| `SideEffectIntent` | 副作用**尚未落地**，只记录意图（如 v0.1 的 git 操作）。<br>刻意不静默跳过 —— 否则事件流会声称做过了而实际没有 |
| `NoTransition` | 收到事件但当前状态下无转移（暂停中、终态、guard 未过）。<br>记录它是为了保留"系统看到了这个事件但没动"这个事实 |
| `BudgetExceeded` | 成本核算 |
| `HumanAction` | 人工操作（含接管、交还、审批） |

> `payload` 中记录 `transition` ID（如 `T-012`），使事件流可直接对照转移表核验 ——
> 这是"这个 Task 到底发生了什么"能被机械回答的原因。

---

## 10. Schema 文件清单

机器可读版本在 [`./schemas/`](./schemas/)：

| 文件 | 对应 |
|---|---|
| `state.schema.json` | `A-State` |
| `rfc.schema.json` | `A-RFC` |
| `checkpoint.schema.json` | `A-Checkpoint` |
| `critic-review.schema.json` | `A-CriticReview` |
| `capability-request.schema.json` | `A-CapabilityRequest` |
| `policy-decision.schema.json` | `A-PolicyDecision` |
| `stage-outcome.schema.json` | `A-StageOutcome` |
| `event.schema.json` | `A-Event` |

---

**下一篇**：[`05-contracts/`](./05-contracts/) —— 读写这些产物的接口契约。
