# Policy Engine 实现

> 父任务：`08-23-v01-closed-loop`（子任务 2）

## Goal

实现 `PolicyEngine` 契约的两个 `[v0.1 必须]` 方法：`evaluate()` 与 `validate()`。

**本任务存在的直接原因**是初稿 §12 那组 YAML 规则里藏着的一个缺陷：

> 一个**低复杂度、低风险的安全修复**会同时命中
> `security_related == true → security_review` 和
> `complexity == low && risk == low → auto_develop` 两条规则，
> **而初稿从没说过谁赢。**
>
> 按声明顺序取第一条碰巧对；按"最后匹配优先"就把**安全改动自动放行了**。
> 一个未定义的求值顺序，决定了系统是安全的还是危险的。

契约（`docs/05-contracts/policy-engine.md`）已经给出解法：
**严格性偏序 + 默认 deny + 完全确定的求值顺序**。本任务把它变成代码。

---

## Background

已完成：架构文档集、骨架（四条约束机械化）、契约 TS 接口、转移函数、持久化层。

`src/contracts/policy-engine.ts` 已有 `ACTION_STRICTNESS`、`DEFAULT_ACTION`、
`mostRestrictive()` —— 契约层的语义常量已在，缺的是求值器本身。

---

## Requirements

### R1 · 受限表达式求值器

按 `docs/05-contracts/policy-engine.md` §5，**不是通用脚本**：

| 允许 | 不允许 |
|---|---|
| 比较 `== != > >= < <=` | 函数调用 |
| 布尔 `&& \|\| !` | 循环、赋值 |
| 字段访问 `facts.risk` | 外部 I/O |
| 字面量：数字、字符串、布尔 | 正则（v0.1） |
| 括号 | 任意属性链 |

**禁止用 `eval` / `new Function` 实现。** 那会让"受限"变成一句空话，
且引入代码注入面 —— facts 虽来自 Fact Plane，但规则文件可能来自配置仓库。

### R2 · 求值算法

```
按 priority 降序、同 priority 按 id 升序遍历
  条件为真 → 收集；rule.stop 则中断
无命中 → DEFAULT_ACTION，default_applied = true
有命中 → 取偏序中最严格的 action
```

三个要点各有理由：

| 要点 | 理由 |
|---|---|
| 按 `priority`/`id` 排序而非书写顺序 | 书写顺序会因编辑而**意外改变语义** |
| 收集**全部**命中而非取第一条 | 否则 `matched_rules` 无法如实记录 |
| 取**最严**而非最高优先级 | 前者的失效模式是过度谨慎，后者是**意外放行** |

### R3 · 纯函数

相同 `(ruleset, point, facts)` 永远得到相同结果。
不读时钟、不查外部、不调 LLM（Control Plane 硬约束）。

> `evaluated_at` 由**调用方传入**，不在引擎内取 —— 否则引擎就不纯了。

### R4 · `validate()` 加载时校验

至少五项（`docs/05-contracts/policy-engine.md` §4.2）：

| 检查 | 级别 |
|---|---|
| `condition` 语法合法 | error |
| 引用的 fact 在注册表中存在 | error |
| `action` 在偏序中有定义 | error |
| 同 `priority` 且条件重叠 | warning |
| 被前序 `stop: true` 完全遮蔽的规则 | warning |

### R5 · 产出可重放的 `A-PolicyDecision`

`facts_snapshot` 是**输入的完整快照**而非引用 —— 快照才能保证同输入同裁决。
`default_applied` 如实记录。

### R6 · Fact 注册表

`docs/05-contracts/policy-engine.md` §2 的 9 个 fact，
区分**静态**（随 RFC 冻结）与**运行期**（持续变化）。

### R7 · 默认规则集

把初稿 §12 的 5 条规则 + 契约 §2.2 的漂移检测规则 `P-DRIFT` 落成配置，
并通过 `validate()`。

---

## Constraints

1. 不用 `eval` / `new Function`（见 R1）
2. 引擎本身不依赖数据库 —— facts 由调用方从 Fact Plane 取好传入
3. 中文注释；标识符英文

---

## Acceptance Criteria

### 基础

- [x] 表达式求值器支持 R1 的全部允许语法，拒绝全部不允许语法（8 个反例）
- [x] `evaluate()` 产出符合 `A-PolicyDecision` schema 的结果
- [x] `validate()` 五项检查全部实现（实际六项，多一项判定点可用性）
- [x] 默认规则集通过 `validate()`
- [x] `pnpm run check` 为绿（80 个测试）

### 核心：那个冲突必须被正确裁决

- [x] **低复杂度 + 低风险 + 安全相关 → `security_review`，不是 `auto_develop`**
- [x] `matched_rules` 如实记录 `P3` 与 `P4` 两条，而不是只记胜出的
- [x] 无规则命中 → `human_review` 且 `default_applied = true`
- [x] **把规则数组整个反转，裁决结果与命中集合不变**
- [x] 相同输入重复求值 100 次，结果深相等
- [x] `facts_snapshot` 是快照 —— 事后改入参不影响已产出的裁决
- [x] `check:purity` 与 `policy-must-be-pure` 边界规则已覆盖该目录

### 反例验证

- [x] 语法错误的 `condition` → error
- [x] 引用未注册的 fact → error
- [x] **引用在该判定点不可用的 fact → error**
- [x] 未定义的 `action` → error
- [x] `points` 为空 → error
- [x] 同 priority 条件相同 → warning
- [x] 被恒真 `stop` 规则遮蔽 → warning
- [x] policy 中写 `Date.now()` → `check:purity` 红（exit 1，已实测）
- [x] policy 中 import `node:fs` → `boundaries` 红（exit 1，已实测）

---

## 验收执行记录

**测试**：33 个（表达式 15 + 裁决 8 + validate 8 + 其他 2）。全仓库 80 个，`check` exit 0。

### 实现反过来改了两处契约

| # | 发现 | 修正 |
|---|---|---|
| 1 | **契约给的漂移规则 `actual_files_changed > estimated_files_changed * 3` 用了语言不支持的语法** —— 受限表达式（§5）只允许比较、布尔、字段、字面量，没有算术 | 改为派生 fact `files_drift_ratio`，规则写 `facts.files_drift_ratio > 3`。**保持表达式语言最小，正是它可静态分析、可审计的前提** |
| 2 | `Rule` 没有 `points` 字段，但 `evaluate(point, facts)` 需要按判定点选规则 —— 否则 `rfc_ready` 求值时，引用运行期 fact 的规则会因「fact 未提供」**抛错**而不是不命中 | `Rule` 增加 `points`，并在 `validate()` 中加一项「fact 在该判定点是否可用」的检查 |

两处都同步回 `docs/05-contracts/policy-engine.md`。

### 刻意的设计选择

**不用 `eval` / `new Function`。** 契约要求求值可终止、可静态分析、可审计，
而 `eval` 会同时废掉这三点，还把规则文件变成代码注入面。
自己写递归下降解析器约 200 行，换来 `validate()` 能在**加载时**发现语法错误与坏的 fact 引用。

**引用未提供的 fact 时抛错，而不是静默当作 false。**
静默当 false 会让规则「不命中」—— 等于悄悄放行。

**`validate()` 的两项 warning 是保守近似**（条件文本相同 / 恒真 stop 遮蔽）。
完整判定需要 SMT 求解，不成比例。失效模式选**漏报而非误报** ——
误报会让人开始忽略 warning，那比漏报更糟。这一点写在代码注释里。

---

## Out of scope

| 项 | 理由 |
|---|---|
| `explain()` | 契约标注 `[可延后]` |
| 把裁决结果写入 `artifact` 表 | 属子任务 6（Workflow driver）的编排职责 |
| facts 的采集 | 引擎只消费传入的 facts；采集属调用方 |
