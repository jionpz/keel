# Design — Policy Engine 实现

---

## 1. 为什么自己写解析器，而不是 `eval`

契约 §5 说 `condition` 是「受限表达式语言，不是通用脚本」，理由是
求值必须**可终止、可静态分析、可审计**。

用 `eval` / `new Function` 会同时废掉这三点：

| 目标 | `eval` 为什么做不到 |
|---|---|
| 可静态分析 | `validate()` 无法在加载时检查语法与 fact 引用 —— 只能等运行时炸 |
| 可终止 | 表达式里能写循环 |
| 可审计 | 规则从「一句可读的条件」退化成「一段代码」 |

还有一层：规则文件可能来自配置仓库，而 `eval` 会把它变成**代码注入面**。

自己写解析器的成本是可控的：文法只有比较、布尔、字段访问、字面量、括号，
递归下降约 150 行。

## 2. 文法

```
expr    := or
or      := and ( '||' and )*
and     := cmp ( '&&' cmp )*
cmp     := unary ( ('=='|'!='|'>'|'>='|'<'|'<=') unary )?
unary   := '!' unary | primary
primary := '(' expr ')' | field | number | string | bool
field   := 'facts' '.' IDENT          -- 只允许一层，禁止任意属性链
```

**`field` 只允许 `facts.<ident>`**：不支持 `facts.a.b`，也不支持裸标识符。
这样 `validate()` 能可靠地抽出全部被引用的 fact 名。

## 3. 两遍设计：parse 与 evaluate 分离

```
parse(condition) -> Ast | ParseError        纯语法
collectFields(Ast) -> string[]              validate() 用
evaluate(Ast, facts) -> boolean             求值
```

分离的收益是 `validate()` 只需 parse + collectFields，**不需要造假 facts 去试跑**。

## 4. 求值算法

```ts
const ordered = [...rules].sort((a, b) =>
  b.priority - a.priority || a.id.localeCompare(b.id))
```

排序在代码里显式做，**不依赖数组书写顺序** —— 后者会因编辑而意外改变语义。
这与转移表 `specificity()` 的处理是同一个考虑。

命中后 `mostRestrictive(actions)`（契约层已实现）。

## 5. 纯度

`evaluate()` 不取时钟。`A-PolicyDecision.evaluated_at` 由**调用方传入**。

> 若引擎内部调 `new Date()`，它就不是纯函数了，
> 而 Policy 的可重放性是整个 Fact Plane 可信的前提之一。

`src/control/policy/` 目前不在 `check:purity` 的扫描范围（那只覆盖 transition）。
**本任务把它加进去** —— 同样的约束，同样的强制。

## 6. `validate()` 的五项检查

| 检查 | 实现 |
|---|---|
| 语法 | `parse()` 失败即 error |
| fact 存在 | `collectFields()` ∖ 注册表 ≠ ∅ 即 error |
| action 有定义 | 不在 `ACTION_STRICTNESS` 中即 error |
| 同 priority 条件重叠 | 同 priority 分组内，**条件文本相同**即 warning |
| 被 `stop` 遮蔽 | 同 point 内，某规则之前存在 `stop: true` 且**条件恒真**的规则 → warning |

后两项刻意做成**保守近似**：完整的重叠判定需要 SMT 求解，
不成比例。近似的失效模式是**漏报而非误报**，可接受 ——
写成误报会让人开始忽略 warning。这一点在实现里注明。

## 7. 文件布局

```
src/control/policy/
├── expr.ts          # 解析器 + 求值器（纯）
├── engine.ts        # PolicyEngine 实现
├── ruleset.ts       # 默认规则集 + fact 注册表
└── *.test.ts
```

`src/control/policy` 属 Control Plane，受「绝不直接调用 LLM、必须可确定性重放」约束。

## 8. 风险

| 风险 | 对策 |
|---|---|
| 解析器边界情况（优先级、结合性）写错 | 表驱动测试覆盖各运算符组合 |
| 遮蔽检查误报导致 warning 被忽略 | 保守近似，宁漏勿误；在代码注释中写明局限 |
| 默认规则集与初稿语义不符 | 用初稿 §12 的原文逐条对照，并把那个冲突场景做成测试 |
