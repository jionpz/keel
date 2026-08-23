# `PolicyEngine`

> 满足 PRD `R4`；关闭缺口 `G7`（无求值语义、facts 来源不明、规则冲突无裁决、默认语义未定）。

---

## 0. 这份契约要解决的问题

初稿 §12 给了一段 YAML：

```yaml
rules:
  - condition: "risk == high"                      → human_review
  - condition: "files_changed > 30"                → architecture_review
  - condition: "security_related == true"          → security_review
  - condition: "complexity == low && risk == low"  → auto_develop
  - condition: "tests_failed >= 3"                 → human_review
```

并说"这比把所有规则写进 Prompt 更可靠"。这个判断是对的，但这段 YAML 本身有一个**未被察觉的缺陷**：

> 一个**低复杂度、低风险的安全修复**会同时命中第 3 条和第 4 条。
> 一条说 `security_review`，一条说 `auto_develop`。**初稿没说谁赢。**

这不是吹毛求疵 —— 安全类小修复恰恰是最常见的情形之一。
按声明顺序取第一条会得到 `security_review`（碰巧对），
按"最后匹配优先"会得到 `auto_develop`（**把安全改动自动放行了**）。
一个未定义的求值顺序，决定了系统是安全的还是危险的。

本契约把这件事定死。

---

## 1. 求值语义

### 1.1 规则形状

```
Rule {
  id:        string
  points:    DecisionPoint[]   // 本规则在哪些判定点参与求值
  priority:  integer          // 数值大的先求值
  condition: Expression
  action:    Action
  stop:      boolean          // true = 命中后不再求值后续规则
}
```

> `points` 是必须的：不同判定点可用的 fact 不同 —— `rfc_ready` 时还没有
> `actual_files_changed`。若不按判定点划分，引用尚不存在的 fact 的规则会
> **抛错**而不是「不命中」。

### 1.2 求值算法

```
evaluate(point, facts):
    matched = []
    for rule in rules(point) sorted by priority desc, id asc:
        if eval(rule.condition, facts):
            matched.append(rule)
            if rule.stop: break

    if matched is empty:
        return decision = DEFAULT_ACTION, default_applied = true

    return decision = most_restrictive(matched.actions), default_applied = false
```

三个要点：

1. **按 `priority` 降序求值**，同 `priority` 按 `id` 升序 —— 保证**完全确定**的求值顺序，
   不依赖 YAML 里的书写顺序（书写顺序会因编辑而意外改变语义）
2. **收集全部命中项**，不是取第一条
3. **取最严格的 action** —— 见 §1.3

### 1.3 冲突裁决：严格性偏序

```
reject  ≻  human_review  ≻  security_review  ≻  architecture_review  ≻  auto_develop
```

多条规则命中时，取偏序中**最严格**的那个。

回到开头的例子：低复杂度安全修复同时命中 `security_review` 与 `auto_develop`，
按偏序取 `security_review`。**安全改动不会因为它简单就被自动放行。**

> 选择"最严格者胜"而不是"优先级最高者胜"，是因为前者的失效模式是**过度谨慎**（多一次人工审），
> 后者的失效模式是**意外放行**。在这个系统里，前一种错误的代价远低于后一种。

`stop: true` 是逃生阀 —— 少数确实需要"命中即终止"的规则（如明确的白名单豁免）可以用它，
但**默认不用**，因为它会让规则集的行为依赖顺序。

### 1.4 默认语义：deny

```
DEFAULT_ACTION = human_review
```

无规则命中时**不放行**，落到人工。

配套要求：`A-PolicyDecision.default_applied` 必须如实记录。
大量 `default_applied = true` 是**规则覆盖不足**的信号 —— 若不记录，
默认 deny 会安静地把系统退化成全人工，而没人察觉哪里出了问题。

---

## 2. Facts 来源 · 关闭 G7 的另一半

**硬约束：facts 只能来自 Fact Plane。**
这是 Policy 求值可重放的前提 —— 若 facts 里混入了实时查询外部系统的结果，
同一次重放就会得到不同裁决。

| Fact | 来源 | 性质 |
|---|---|---|
| `risk` | `A-RFC.policy_facts.risk` | 静态，**随 RFC 冻结** |
| `complexity` | `A-RFC.policy_facts.complexity` | 静态，随 RFC 冻结 |
| `estimated_files_changed` | `A-RFC.policy_facts.estimated_files_changed` | 静态，随 RFC 冻结 |
| `security_related` | `A-RFC.policy_facts.security_related` | 静态，随 RFC 冻结 |
| `critic_confidence` | `A-CriticReview.confidence` | 静态 |
| `dev_attempts` | `run` 表聚合 | **运行期** |
| `tests_failed` | `run` 表聚合（QA stage 失败次数） | 运行期 |
| `cost_spent_usd` | `run` 表聚合 | 运行期 |
| `actual_files_changed` | `WorkspaceDiff.files_changed` 长度 | 运行期 |

### 2.1 静态 fact 与运行期 fact 的分野

- **静态**：随 RFC 冻结 ⇒ 同一 RFC 版本的裁决结果**恒定**
- **运行期**：持续变化 ⇒ 每次求值可能不同

初稿把 `tests_failed >= 3` 和 `risk == high` 写在同一组规则里，
但两者的时间语义完全不同。分开标注后，才能理解为什么
`rfc_ready` 判定点的结果可以缓存，而 `qa_failed` 判定点的不能。

### 2.2 估算漂移检测

RFC 说 `estimated_files_changed: 4`，实际改了 40 —— 这说明 RFC 的判断严重偏离。

**规则**：当 `actual_files_changed` 显著超过 `estimated_files_changed` 时，
必须在 `post_develop` 判定点**重新求值** Policy，而不是沿用 `rfc_ready` 时的裁决。

比值由调用方算好后作为一个**派生 fact** 传入：

```
- id: P-DRIFT
  points: [post_develop]
  priority: 900
  condition: "facts.files_drift_ratio > 3"
  action: architecture_review
```

> **为什么不是 `actual_files_changed > estimated_files_changed * 3`**：
> 受限表达式语言**不支持算术**（见 §5）。
> 与其为这一条规则给语言加乘法，不如把比值算成一个派生 fact ——
> 保持表达式语言最小，正是它可静态分析、可审计的前提。
>
> 这处是实现期发现的：契约原本给的示例规则用了语言本身不支持的语法。

> 初稿没有这条。但"当初判断这是个小改动所以自动放行了，结果它不是"
> 是自动开发系统最典型的失控方式 —— 必须有一个点把它抓住。

---

## 3. 判定点（Decision Point）

Policy 不是随时求值，只在明确的判定点求值：

| `decision_point` | 触发 | 主要 facts |
|---|---|---|
| `rfc_ready` | 转移 `T-011` 后 | 静态 facts + `critic_confidence` |
| `capability_request` | Session emit `A-CapabilityRequest` | `capability`、`dev_attempts` |
| `post_develop` | `run(develop)` 成功后 | `actual_files_changed`（漂移检测） |
| `qa_failed` | QA 判定失败后 | `tests_failed`、`dev_attempts` |
| `pre_pr` | 创建 PR 前 | 全部 |

---

## 4. 接口

### 4.1 `evaluate()` `[v0.1 必须]`

```
evaluate(point: DecisionPoint, facts: FactSet) -> A-PolicyDecision | Error
```

产出 `A-PolicyDecision`（schema 见 [`../06-artifacts.md`](../06-artifacts.md) §7），
其中 `facts_snapshot` 是**输入的完整快照**而非引用 —— 快照才能保证同输入同裁决。

**必须是纯函数**：相同 `(ruleset_version, point, facts)` 永远得到相同结果。
不得读时钟、不得查外部系统、不得调 LLM
（Control Plane 硬约束，见 [`../02-glossary.md`](../02-glossary.md) §1）。

### 4.2 `validate()` `[v0.1 必须]`

```
validate(ruleset: Ruleset) -> ValidationReport | Error

ValidationReport {
  ok:       boolean
  errors:   { rule_id, message }[]
  warnings: { rule_id, message }[]
}
```

规则集在**加载时**校验，不是等到求值才发现问题。至少检查：

| 检查 | 级别 |
|---|---|
| `condition` 语法合法 | error |
| `condition` 引用的 fact 在注册表中存在 | error |
| `action` 在偏序中有定义 | error |
| 同 `priority` 且条件重叠的规则 | warning |
| 存在**永不可能命中**的规则（被前序 `stop: true` 完全遮蔽） | warning |

### 4.3 `explain()` `[可延后]`

```
explain(decision_ref: ArtifactRef) -> Explanation
```

回答"为什么这个 Task 被判为需要人工审"。基于已存的 `A-PolicyDecision` 重建推理链，
不重新求值。

---

## 5. 表达式语言

`condition` 使用一个**受限**表达式语言，**不是**通用脚本：

| 允许 | 不允许 |
|---|---|
| 比较：`== != > >= < <=` | 函数调用 |
| 布尔：`&& \|\| !` | 循环、赋值 |
| 字段访问：`facts.risk` | 外部 I/O |
| 字面量：数字、字符串、布尔 | 正则（v0.1 不支持） |

理由：Policy 求值必须可终止、可静态分析、可审计。
一旦允许通用脚本，`validate()` 的静态检查就失效了，
而且规则会逐渐变成"另一个地方的业务逻辑"——那正是初稿想避免的"把规则写进 Prompt"的另一种形态。
