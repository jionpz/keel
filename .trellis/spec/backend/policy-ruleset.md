# Policy Ruleset（`rfc_ready` 默认规则集）

> 建立于 2026-11-05（任务 `11-05-policy-auto-band`）。记录默认规则集的放行带边界与修改纪律。

## 1. 位置与事实来源

| 关注点 | 文件 |
|---|---|
| 默认规则集 | `src/control/policy/ruleset.ts`（`DEFAULT_RULES` / `DEFAULT_RULESET`） |
| 求值引擎 | `src/control/policy/engine.ts` |
| 受限表达式语言 | `src/control/policy/expr.ts` |
| 契约（语义） | `docs/05-contracts/policy-engine.md` |
| 判定点 facts 装配 | `src/control/driver/facts.ts` |

契约文档只定义**语义**——严格性偏序、默认 deny、facts 来源——**不逐条列默认规则**。
默认规则的唯一事实来源是 `ruleset.ts`，改规则不需要同步契约文档。

## 2. 两个不许动的不变式

1. `DEFAULT_ACTION = 'human_review'`（`src/contracts/policy-engine.ts`）
2. 多规则命中取 `mostRestrictive`：
   `reject ≻ human_review ≻ security_review ≻ architecture_review ≻ auto_develop`

**推论：放宽只能靠扩大放行规则，不能改排序或默认值。**
改默认值会把失效模式从「多一次人工审」翻转成「意外放行」——而后者正是这套设计要避免的那一侧。

## 3. 当前放行带（2026-11-05 起）

`P4 = facts.risk == 'low' && facts.complexity != 'high'` → `auto_develop`

| risk | complexity | security_related | 命中规则 | 裁决 |
|---|---|---|---|---|
| low | low | false | P4 | `auto_develop` |
| low | medium | false | P4 | `auto_develop` |
| low | high | false | 无 | `human_review`（`default_applied=true`） |
| low | any | true | P3 + P4 | `security_review` |
| medium | any | any | 无 | `human_review`（`default_applied=true`） |
| high | any | any | P1 | `human_review` |
| any | any | any，`estimated_files_changed > 30` | P2（+P4） | `architecture_review` |

两处容易误读，都是刻意的：

- **`complexity=high` 没有专门的规则兜底**，靠 `DEFAULT_ACTION` 判人工。所以那一行的 `default_applied` 是 `true`，不是 `false`。
- **`risk != 'low'` 一律不命中 P4**。风险是主判据，复杂度只在 `high` 这一端设上界。

## 4. 版本号纪律

规则内容变了**必须**升 `DEFAULT_RULESET.version`。

契约保证 `(ruleset_version, point, facts, evaluated_at)` 决定裁决结果。
沿用旧版本号会让历史 `A-PolicyDecision.policy_version` 指向另一套规则，可重放性就断了。

## 5. `default_applied` 是覆盖率信号

`default_applied = true` 意味着**没有任何规则覆盖这个格子**，系统退回默认人工。
契约 §1.4 明说：大量 `default_applied = true` 是**规则覆盖不足**的信号，不是正常状态。

2026-11-05 放宽 P4 的直接动因就是：`complexity=medium + risk=low` 这个常见格子没人覆盖，
全部落到默认 deny，于是低风险中等复杂度的改动也要人工。

## 6. 修改前的检查清单

- [ ] 新条件引用的 fact 必须在 `FACTS_AT[point]` 里（否则加载期 `validate()` 报错）
- [ ] 未改 `DEFAULT_ACTION` / `ACTION_STRICTNESS` / `mostRestrictive`
- [ ] 未削弱 P1（高风险管理）/ P2（>30 文件）/ P3（安全）
- [ ] 同时升了 `DEFAULT_RULESET.version`
- [ ] 加了一个「把规则改回旧条件就会红」的回归用例（实际回退跑一遍验证，不要只看代码推演）
- [ ] 跑 `pnpm run check`

## 7. 测试要求

`src/control/policy/policy.test.ts`：

- 每个放行格子至少一个用例，断言 `decision` **+ `default_applied` + `matched_rules`** 三者
- 边界另一侧必须有对应用例（medium 放行 → high 必须人工）
- 严格性偏序用例：安全修复在 `complexity=low` 与 `medium` 下都必须得 `security_review`

只断言 `decision` 是不够的：`auto_develop` 可能来自「命中放行」，也可能（未来）来自改坏的默认值。
`default_applied` 才能区分这两者。

## 8. Wrong vs Correct

### Wrong —— 改默认值来放宽

```ts
// 失效模式从「多审一次」翻转成「意外放行」
export const DEFAULT_ACTION: PolicyAction = 'auto_develop'
```

### Correct —— 保持默认 deny，扩大唯一放行规则

```ts
{
  id: 'P4',
  points: ['rfc_ready'],
  condition: "facts.risk == 'low' && facts.complexity != 'high'",
  action: 'auto_develop',
  stop: false,
}
```

## 9. 已知文档漂移（不要「顺手修正」）

- `docs/06-artifacts.md:317` 的 `A-PolicyDecision` 示例仍写旧条件，
  但该示例带 `policy_version: "2026-08-01"` 与 `evaluated_at: 2026-08-22`，
  是**历史裁决快照**——在 2026-08-01 那套规则下旧条件才是对的。改了会制造假事实。
- `docs/05-contracts/policy-engine.md:16` 引用的是初稿 §12 的 YAML，同属历史陈述。

当前行为的描述在 `docs/07-flows.md` 流程第 17 步——那一处必须跟随规则变化更新。
