# 放宽 auto_develop 放行带

## Goal

低风险的**中等复杂度**改动不再默认落到人工审核；高风险、安全类、大改动仍必须升级。

## Background

- `DEFAULT_ACTION = 'human_review'`（`src/contracts/policy-engine.ts:56`）：无规则命中即人工。
- `rfc_ready` 判定点只有 4 条规则，其中**唯一放行**的是 `P4`：
  `facts.complexity == 'low' && facts.risk == 'low'`（`src/control/policy/ruleset.ts:115`）。
- 于是 `complexity = medium` 的低风险改动既不命中 P4，也不命中任何严格规则，
  直接吃默认 deny → `S-HUMAN_REVIEW`。
- `docs/05-contracts/policy-engine.md` §1.4 已指出：**大量 `default_applied = true`
  是规则覆盖不足的信号**。当前放行带只有一个格子，属于此类。

## Requirements

- **R1** `P4.condition` 改为 `facts.risk == 'low' && facts.complexity != 'high'`。
- **R2** 不改 `DEFAULT_ACTION`，不改 `mostRestrictive` / `ACTION_STRICTNESS` 排序。
  「最严者胜 + 默认 deny」两个安全不变式原样保留。
- **R3** `P1`（`risk == 'high'`）、`P2`（`estimated_files_changed > 30`）、
  `P3`（`security_related == true`）的条件与动作均不变。
- **R4** `risk = low` 且 `complexity = high` 时**不命中任何规则** → 默认 `human_review`
  且 `default_applied = true`（高复杂度仍由默认 deny 兜住）。
- **R5** 在 `ruleset.ts` 的 `P4` 注释里写明放宽理由与边界，避免后来者把它当成笔误改回去。

## Acceptance Criteria

- [ ] `risk=low, complexity=medium, security_related=false, estimated_files_changed=5`
      → `auto_develop`，`default_applied=false`，`matched_rules` 含 `P4`
- [ ] `risk=low, complexity=high, security_related=false` → `human_review`，
      `default_applied=true`，`matched_rules` 为空
- [ ] 低风险安全修复（`risk=low, complexity=low, security_related=true`）
      → 仍为 `security_review`，`matched_rules` 仍为 `['P3','P4']`
- [ ] 高风险 → 仍为 `human_review`（P1 严于 P4）
- [ ] `src/control/policy/policy.test.ts` 全部通过
- [ ] `pnpm run check` 通过

## Constraints

- 只改规则数据与注释，不改求值引擎（`engine.ts` / `expr.ts`）。
- 不新增 fact、不改 `FACTS_AT`。
- 不引入 profile 开关 —— 本次是默认行为调整，profile 留作后续独立决策。

## Out of Scope

- 失败耗尽路径（`T-020` / `T-023` / `T-026` / `T-031`）升人工的逻辑。
- `S-NEED_CLARIFICATION` 的 TTL 行为。
- `capability_request` 的默认 deny。
