# Design — Session Manager

## 1. 结构

```
src/execution/session/
├── validate.ts    # 五步校验（纯 + 一次 DB 读）
├── extract.ts     # post_validate：自由文本 → JSON（纯函数）
├── manager.ts     # SessionManager 实现
└── *.test.ts
```

## 2. 平面越界检查怎么做

**黑名单而非白名单**：schema 已经用 `additionalProperties: false` 卡死了形状，
越界检查针对的是「形状合法但语义越权」——即提案里出现指挥流程的字段。

禁用键名（出现在 body 任意层级即拒绝）：
`task_status` `next_state` `next_status` `transition` `advance_to` `force_status`

> 为什么是黑名单：schema 白名单已经在第 1 步做了。
> 这一步防的是**将来某个 schema 放宽后**溜进来的越权字段 ——
> 它是纵深防御的第二层，不是第一层。

## 3. `post_validate` 的提取策略

按优先级尝试：
1. ` ```json ... ``` ` 围栏
2. 任意 ` ``` ... ``` ` 围栏
3. 首个 `{` 到末个 `}` 的平衡子串

三种都失败 → `SCHEMA_VIOLATION`，理由写明「未能从输出中提取 JSON」。

**不做正则暴力匹配** —— 那会在嵌套 JSON 上悄悄取错，
而取错的后果是「校验通过但内容是错的」，比提取失败更糟。

## 4. R-007 回灌的形状

`advance()` 内循环：

```
for attempt in 1..max_proposal_retries:
    outcome = adapter 执行
    verdicts = 校验(outcome.proposals)
    if 全部通过: 提交并返回
    把 violations 拼成人类可读的反馈，作为下一轮 TurnInput
判定 Run FAILED
```

回灌文本要**具体**：哪个字段、违反了什么规则、期望是什么。
只说「格式错误」等于让模型猜。

## 5. 里程碑测试怎么保证「无人干预」

关键是**测试代码不得提交任何产物**。测试只负责：
1. 建 Task
2. 让 SessionManager 跑一个真实 OMP session
3. 断言 `A-StageOutcome` 出现在库里、且是 `produced_by_run` 指向该 run 的
4. 调 driver.advance，断言状态推进

若测试里出现 `store.commit(stage_outcome)`，就不算无人干预。

## 6. 风险

| 风险 | 对策 |
|---|---|
| deepseek 不稳定产出合法 JSON | 这正是 R-007 存在的理由；测试允许重试，但**不允许测试代码代劳** |
| 提示词工程影响结果 | 提示词是实现的一部分，写在代码里而非测试里 |
