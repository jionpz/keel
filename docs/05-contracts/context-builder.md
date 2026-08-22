# `ContextBuilder`

> 满足 PRD `R4`；关闭缺口 `G5`（无接口、无 token 预算与裁剪策略、配料来源未定义）。

---

## 0. 这份契约要解决的问题

初稿 §10 给了三个 Role 的 Context "配料表"（PM Context = 用户反馈 + 历史类似问题 + 产品规则 + …），
并说"这样可以显著降低 Token"。

但它没回答三个问题：

1. **配料从哪来？** "历史类似问题"是检索出来的还是固定的？检索用什么条件？
2. **超预算怎么办？** 配料表列了六项，全塞进去超了上下文窗口，砍哪个？
3. **事后怎么复现？** 出了问题要回答"这个 Agent 当时到底看到了什么"，靠什么？

第 3 个问题最要命：如果 Context 是每次即兴拼装的，那么"为什么它当时做了这个判断"
就永远无法复盘 —— 而这恰恰是事故复盘最需要的信息。

---

## 1. 接口

### 1.1 `build()` `[v0.1 必须]`

```
build(request: ContextRequest) -> Context | Error

ContextRequest {
  task_id:       string
  run_id:        string
  role:          RoleId
  stage:         StageId
  budget_tokens: integer
  resume_mode:   "fresh" | "rematerialize"
}
```

```
Context {
  context_id:    string            // 可寻址，写入 Event 供复现
  recipe_id:     string            // 用了哪个配方
  recipe_version:string
  sections:      ContextSection[]
  total_tokens:  integer
  dropped:       DroppedSection[]  // 因预算被砍掉的
}

ContextSection {
  id:         string
  source_ref: string        // 溯源：artifact:state@3 / file:src/x.ts / retrieval:q=...
  priority:   "required" | "high" | "normal" | "low"
  content:    string
  tokens:     integer
}

DroppedSection {
  id:       string
  reason:   "budget" | "unavailable" | "policy"
  tokens_would_have_been: integer
}
```

**`dropped` 是必填而非可选**。被砍掉的东西必须显式记录 ——
否则"预算不够所以没给它看 RFC"这种事会静默发生，而复盘时看起来像 Agent 无缘无故做错了判断。

### 1.2 `estimate()` `[可延后]`

```
estimate(request: ContextRequest) -> { total_tokens, by_section } | Error
```

不实际取内容，只估算体积。用于派发前预判是否会触发大量裁剪。

---

## 2. 配料来源 —— 每一项都必须标注来源类型

| 来源类型 | 含义 | 可复现性 |
|---|---|---|
| `fixed` | 静态配置（项目规范、Role 指令） | ✅ 完全 |
| `artifact` | Fact Plane 的产物，按 ref 精确取 | ✅ 完全 |
| `workspace` | 工作区文件 / git 状态 | ✅ 按 commit SHA |
| `retrieval` | **检索得到**（历史类似 Task、相关代码） | ⚠️ 需记录检索参数 |
| `derived` | 由 `ModelProvider` 摘要生成 | ⚠️ 需记录模型与输入 |

**规则**：`retrieval` 与 `derived` 类型的 section，
其 `source_ref` **必须包含足以复现的完整参数**（查询串、top-k、模型 id、输入 hash）。

> 这是本契约里唯一一处允许非确定性的地方，因此必须被最严格地记录。
> 否则整个 Fact Plane 的可重放性会从这里漏掉。

---

## 3. 配方（Recipe）

配方 = Role → section 清单 + 优先级。带版本，存为配置。

### 3.1 PM

| section | 来源 | 优先级 |
|---|---|---|
| Role 指令 | `fixed` | `required` |
| 用户反馈原文 | `artifact`（feedback） | `required` |
| 当前 `A-State` | `artifact` | `required` |
| 产品规则 / 架构规范 | `fixed` | `high` |
| 最近的 `A-CriticReview` | `artifact` | `high` |
| 历史类似 Task 摘要 | `retrieval` | `normal` |
| Checkpoint `working_summary` | `artifact` | `high`（仅 `rematerialize`） |

### 3.2 Developer

| section | 来源 | 优先级 |
|---|---|---|
| Role 指令 | `fixed` | `required` |
| **`A-RFC`（冻结版）** | `artifact` | `required` |
| 开发规范 / 测试要求 | `fixed` | `required` |
| git 状态与当前分支 diff | `workspace` | `high` |
| 相关代码 | `retrieval` | `high` |
| 上一次失败的 QA 报告 / 评审意见 | `artifact` | `high`（返工时 `required`） |
| `A-State` 的 decisions 与 risks | `artifact` | `normal` |

### 3.3 Reviewer

| section | 来源 | 优先级 |
|---|---|---|
| Role 指令 | `fixed` | `required` |
| `A-RFC` | `artifact` | `required` |
| **git diff** | `workspace` | `required` |
| 测试结果 | `artifact` | `required` |
| 架构规则 / 风险策略 | `fixed` | `high` |
| `A-State` 的 risks | `artifact` | `normal` |

> 注意 Developer 与 Reviewer 都把 `A-RFC` 标为 `required` ——
> RFC 是冻结的交接物，两边看到的必须是**同一个版本**。
> 若 RFC 已被 supersede，Context 必须取 Run 开始时的那一版，而不是最新版。

---

## 4. 预算与裁剪 · 关闭 G5 的核心

### 4.1 装填顺序

按优先级降序装填，同级按配方声明顺序：

```
required → high → normal → low
```

### 4.2 超预算时的降级顺序

**固定顺序，不允许实现自行发挥**：

1. 丢弃全部 `low`
2. 丢弃全部 `normal`
3. 对 `high` 做**摘要**（`derived`），而非直接丢弃
4. 对 `high` 摘要后仍超 → 丢弃 `high`
5. 对 `required` 做摘要
6. **`required` 摘要后仍超 → 返回 Error，不得静默截断**

### 4.3 第 6 条为什么是 Error

因为 `required` 被截断意味着 Agent 拿不到完成任务的最低必要信息。
此时**让它跑起来比不跑更糟** —— 它会产出一个看似合理、实则基于残缺信息的结果，
而这个结果会经 Proposal 落成事实。

宁可返回 `CONTEXT_BUDGET_EXCEEDED` 走 `T-031` 升人工。

### 4.4 `rematerialize` 模式的额外预算

当 `resume_mode = "rematerialize"`（Harness 无 `CAP-RESUME`）时，
需额外装填 `checkpoint.working_summary` 与更多 `A-State` 历史。

这就是降级矩阵中"token 显著上升"的具体来源。
调用方应为此模式配置**更大的 `budget_tokens`**，而不是让它去挤压 `required` section。

---

## 5. 可复现性要求

每次 `build()` 必须发一条 Event，记录：

```
{
  type: "ContextBuilt",
  payload: {
    context_id, recipe_id, recipe_version,
    sections: [{ id, source_ref, tokens, priority }],
    dropped:  [{ id, reason, tokens_would_have_been }],
    total_tokens, budget_tokens
  }
}
```

**不记录 `content` 本身**（体积过大），但 `source_ref` 足以重新取回内容。

> 这条 Event 是"这个 Agent 当时到底看到了什么"的唯一可靠答案。
> 没有它，事故复盘只能靠猜。
