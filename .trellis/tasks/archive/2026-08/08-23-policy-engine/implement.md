# Implement — Policy Engine 实现

---

## Stage 1 · 表达式解析与求值（`src/control/policy/expr.ts`）

- [ ] 1.1 词法：数字、字符串、布尔、标识符、运算符、括号
- [ ] 1.2 递归下降解析，按 design.md §2 的文法
- [ ] 1.3 `collectFields(ast)`：抽出全部 `facts.<ident>`
- [ ] 1.4 `evaluate(ast, facts)`
- [ ] 1.5 测试：各运算符、优先级、结合性、括号；非法语法被拒

**约束**：不用 `eval` / `new Function`。

---

## Stage 2 · Fact 注册表与默认规则集（`ruleset.ts`）

- [ ] 2.1 9 个 fact 的注册表，标注静态 / 运行期（契约 §2）
- [ ] 2.2 初稿 §12 的 5 条规则 + 契约 §2.2 的 `P-DRIFT`
- [ ] 2.3 为每条规则分配 `priority`

---

## Stage 3 · `PolicyEngine` 实现（`engine.ts`）

- [ ] 3.1 `evaluate()`：排序 → 收集全部命中 → `mostRestrictive`
- [ ] 3.2 无命中 → `DEFAULT_ACTION` + `default_applied = true`
- [ ] 3.3 产出 `A-PolicyDecision`，`facts_snapshot` 为完整快照
- [ ] 3.4 `evaluated_at` 由调用方传入，**不在引擎内取时钟**
- [ ] 3.5 `validate()` 五项检查

---

## Stage 4 · 纯度约束扩展到 policy 目录

- [ ] 4.1 `scripts/check-purity.ts` 的扫描范围加入 `src/control/policy`
- [ ] 4.2 `.dependency-cruiser.cjs` 加规则：policy 不得依赖 fact / execution
- [ ] 4.3 反例验证：在 policy 中写 `Date.now()` → `check:purity` 红

---

## Stage 5 · 测试 `[核心验收]`

- [ ] 5.1 **那个冲突**：低复杂度 + 低风险 + 安全相关 → `security_review`
- [ ] 5.2 `matched_rules` 记录两条命中，不是只记胜出的
- [ ] 5.3 无命中 → `human_review` + `default_applied = true`
- [ ] 5.4 **调换规则书写顺序，结果不变**
- [ ] 5.5 重复求值 100 次深相等
- [ ] 5.6 `validate()` 五项检查各配一个会被抓住的坏规则集
- [ ] 5.7 默认规则集通过 `validate()`

---

## Stage 6 · 收口

- [ ] 6.1 `docs/` 同步（若有出入）
- [ ] 6.2 逐条勾 `prd.md` 验收
- [ ] 6.3 commit

---

## 回滚点

纯新增 + 两处检查脚本扩展；`git revert` 单个 commit。
