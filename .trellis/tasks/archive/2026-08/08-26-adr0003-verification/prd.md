# ADR-0003 正式查证:Temporal 可迁移性

## Goal

ADR-0003(Workflow engine 选型)仍是 **Proposed**,「转 Accepted 前必须查证」列了 4 项。本任务逐条对现实现验证,产出查证报告,据此给 ADR-0003 结论(转 Accepted / 修改 / 驳回)。

**纯查证任务**:不修改代码(除报告文档);产出是 ADR 状态决策依据。

## 待查证项(ADR-0003 原文)

### H1 · 硬约束:转移必须是纯函数(内查,代码可验证)

ADR 最重声明:状态转移实现为纯函数,不内联 I/O、不读时钟、不直接执行副作用;副作用只能作为返回值**描述**。
**对现实现验证**:
- `transition(status, control_mode, event, facts)` 签名(transition/index.ts + table.ts)是否纯;
- `.dependency-cruiser.cjs` transition-must-be-pure / policy-must-be-pure 规则 + `scripts/check-purity.ts`(Date.now 等)是否真拦;
- 反例测试(transitions 纯度)是否存在并红;
- driver 的副作用执行器(applyEffects)是否与转移分离(ADR-0003 的「描述→外层执行」)。

### H2 · 可重放性(内查)

- event 只增不改(I1)、`getAsOf` 用 committed_at_seq、facts 只来自 Fact Plane(transition 不查外);
- 时间注入(now 参数)贯穿 driver/loop;
- 是否有实测重放(事件流重建测试)。

### H3 · Temporal 确定性约束 / signal / 自托管(外查,web)

- Temporal 确定性 workflow 约束的确切范围(纯函数、无时钟/随机/无 I/O 于 workflow 代码);
- signal 投递保证(至少一次?at-least-once?丢失?);
- 自托管最小组件数(Temporal server 的 docker compose 构成:frontend/history/matching/worker 等)。

### H4 · Inngest 自托管成熟度与数据驻留(外查,web)

- Inngest 自托管方案(并非纯托管?)成熟度、本地运行组件;
- 数据驻留边界(编排状态是否留在本地,与凭据/仓库数据流向约束的冲突)。

### H5 · Postgres SKIP LOCKED 队列已知坑(外查 + 内查)

- 已知坑:长事务持锁、连接池饥饿、死信/重试列;
- 对现实现:timer/run 的 SKIP LOCKED 使用(claimDueTimers)、连接池配置。

## 输出契约

`docs/adr/0003` 同目录或 task 目录产出一份查证报告:
```
## H1-H5 逐条结论
- 每条:结论(成立/部分成立/不成立)+ 证据(代码位置 / 外部来源 URL)+ 风险
## 硬约束的自动化强制清单(C3/dep-cruiser/反例)现状
## ADR-0003 状态建议:转 Accepted | 修改后 Accepted | 驳回(理由)
```

## Acceptance Criteria

- [ ] H1:转移纯度用代码证据(签名/规则/反例)验证,结论明确
- [ ] H2:可重放性用事件流/时间注入代码验证
- [ ] H3-H5:外查各 ≥1 个权威来源(Temporal 官方 docs / Inngest docs / Postgres 社区),结论有据
- [ ] 报告产出;ADR-0003 状态建议明确
- [ ] `pnpm run check` 仍全绿(如无代码改动,纯文档)

## Constraints

- **不修改行为代码**——查证不改 transition/driver/timer;仅产出报告文档。
- 外查必须带来源链接(web_search + read 官方文档),不凭训练记忆下结论。
- ADR 状态建议基于证据;若证据不足(如 Inngest 未查证),如实标「未验证」并给后续条件。

## Notes

- 轻量任务,PRD 为主;核心交付是报告 + ADR 状态建议。
- 与代码的接缝:H1/H2 用 `pnpm run check` 全绿 + 反例测试即证据;不跑真实命令复核用户已报告的事。