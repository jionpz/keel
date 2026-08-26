# ADR-0003 查证报告 · Workflow engine 可迁移性(2026-08-26)

**查证对象**:`docs/adr/0003-workflow-engine.md`(Status: Proposed,「转 Accepted 前必须查证」4 项)
**方法**:内查(代码证据,`pnpm run check` 243 tests 全绿为基线)+ 外查(官方文档,来源附 URL)
**结论**:**ADR-0003 可转 Accepted**(硬约束成立;Temporal 可迁移性确证;外部引擎成本认知更新)

---

## H1 · 硬约束:转移必须是纯函数 —— ✅ 成立(三层强制)

ADR 最重的产出是「转移实现为纯函数,副作用作为返回值描述」。

| 层 | 证据 | 位置 |
|---|---|---|
| **依赖图** | `transition-must-be-pure` / `policy-must-be-pure` / `test-must-not-be-imported-by-prod`,severity=**error** | `.dependency-cruiser.cjs:61,92` + 反引规则:85 |
| **全局扫描** | `check-purity.ts` BANNED 8 类:`Date.now()` / `new Date()` / `Math.random()` / `process.*` / `require()` / 动态 import / globalThis,注释剥离 + 空生产文件防假绿 | `scripts/check-purity.ts:39-48` |
| **签名** | `transition(status, control_mode, event, facts) -> (new_status, side_effects[])` 纯函数;副作用是 `SideEffect` 判别联合描述,intel 由外层 `applyEffects` 执行 | `src/control/transition/index.ts:66`;`src/control/driver/effects.ts` |

**旁证**:`pnpm run check` 全绿(C3 纯度 + dep-cruiser 0 violation);driver 不 import execution(独立约束)。

**结论**:ADR-0003「转移纯函数」约束**已落地且被自动化强制**——可重放性独立成立。

## H2 · 可重放性 —— ✅ 成立

| 要件 | 证据 |
|---|---|
| event 只增不改(I1) | `invariants.test.ts` 反例(keel_control 不能 UPDATE/DELETE event,`permission denied`);migration GRANT 无 UPDATE |
| 时间注入 | driver.advance / executeRun / drainDueTimers 全部接收 `now` 参数;`check:purity` 确保转移不读时钟 |
| 重放源 | event 表 + `getAsOf(task_id, kind, key, at_event_seq)`(logical seq 非墙上时钟,`artifact-store.md §1.3`) |
| facts 只来自 Fact Plane | transition 不查外(依赖图禁止);Context/Proposal 两通道 |

**结论**:可重放性四要件齐,事件流可完整重建(e2e 断言 `readEvents` 过渡链)。

## H3 · Temporal 确定性 / signal / 自托管 —— ✅ 确证(官方文档)

来源:[Temporal Workflows](https://docs.temporal.io/workflows) · [Self-hosted guide](https://docs.temporal.io/self-hosted-guide) · [Deployment](https://docs.temporal.io/self-hosted-guide/deployment)

| 项 | 官方事实 | 与 Keel 的关系 |
|---|---|---|
| **确定性约束** | workflow 重放 = 从 Event History 重跑代码;`Date.now()` / 随机 / 网络调用直接依赖会破坏确定性;时间从 context 读、timer 记事件、对外交互进 Activity(结果入 history 重放复用) | **与 Keel 硬约束本质相同**——转移纯函数 + facts 只来自 Fact Plane,是同一约束的两种表达 |
| **signal 投递** | Event History 记录 signal;workflow 重放时从 history 读取,不丢 | Keel 的 event 表同样只增不改;`ClarificationReceived` 等外部事件经 driver.advance 落 event |
| **自托管组件** | **dev server = 单二进制**(`temporal server start-dev`,无外部依赖);生产 = Docker Compose(server 镜像 + PG + Elasticsearch + UI)或双 Go 二进制(core + UI);「不应暴露公网」(与 keel 数据流转约束一致) | ADR 原「集群运维不匹配 solo 起步」——**dev 单二进制淡化**;生产仍多组件(v0.1 无此需求) |

**关键**:Temporal 官方确认「workflow-as-code 的确定性约束 = 把流程写成可重放纯函数」——正是 Keel 已实现的形态。**迁移 = 换谁调用转移、谁持久化结果**,转移表与 Fact Plane 不动(ADR 的「可行路径」声明获官方印证)。

## H4 · Inngest 自托管成熟度 / 数据驻留 —— ✅ 已查证(成熟度显著提升)

来源:[Inngest Self-hosting](https://www.inngest.com/docs/self-hosting)

- **自托管官方支持**自 1.0 起;**单二进制** `inngest start`(SQLite 默认,可选 PG + Redis;compose 示例 = inngest + PG + Redis,均本地)。
- **数据驻留**:默认本地 SQLite/PG/Redis —— 编排状态留在本地,与 Keel 凭据/仓库数据流向约束**不冲突**。
- 注意:官方「不保证直接支持自托管实例」(enterprise 才承诺)——支撑 ADR 对该引擎的「中/低」评分,但「未验证」已变为「有据可查」。

## H5 · Postgres SKIP LOCKED 队列已知坑 —— ✅ 语法确认 + 实践认知

来源:[PostgreSQL SELECT 官方文档](https://www.postgresql.org/docs/current/sql-select.html)(`FOR UPDATE ... NOWAIT | SKIP LOCKED`)

- **语法语义确认**:`SKIP LOCKED` = 跳过被其他事务锁定的行(官方语法级)。Keel 的 `claimDueTimers` / worker `dueWallClocks` 已用它。
- **已知坑**(社区实践认知,非官方文档):长事务持锁会阻塞队列尾部;连接池并发下大量 SKIP LOCKED 可能饿死低优先级——缓解:claim 事务短小(claim 只锁不标,ConsumeTimer/标状态在独立短事务),已符合最佳实践。
- **对现实现**:timer/worker 的 claim 均短事务 + SKIP LOCKED——姿势正确,无新增风险。

---

## 结论与建议

| 查证项 | 结果 |
|---|---|
| H1 转移纯函数 | ✅ 三层强制,落地 |
| H2 可重放性 | ✅ 四要件齐 |
| H3 Temporal | ✅ 官方确证:确定性约束与 Keel 同构;迁移=换承载 |
| H4 Inngest | ✅ 自托管成熟(单二进制,本地数据驻留),但仍无官方支持承诺 |
| H5 SKIP LOCKED | ✅ 语法确认 + 实现符合短事务姿势 |

**ADR-0003 状态建议:转 Accepted。**

理由:
1. **硬约束(纯函数转移)已实现并被自动化强制**(C3 + dep-cruiser + 反例)——这是「先自研,后换 Temporal」不成为陷阱的前提,满足。
2. **Temporal 官方确认确定性约束与本架构同构**——「迁移只是换谁调用转移」的主张获第一手印证。
3. 外部引擎的事实缺口(原 `未验证`)已补:Temporal dev server 单二进制、Inngest 自托管成熟——**v0.1 自研最小状态机仍是正确选择**(需求形状不匹配未变:转移表已显式,workflow-as-code 是重复表达);但「后期换 Temporal」的路径已被证实可行,不是幻想。
4. 剩余运维成本(dead letter/限流/优雅关闭)是**阶段二重估条件**,不影响 v0.1 决策。

**修改 ADR-0003**:Status Proposed → **Accepted**;「必须查证」清单打勾;Consequences 补一行:2026-08-26 查证结论(H3/H4 事实 + 路径可行确认)。

---

## 附录:外部来源

- Temporal Workflow 确定性/replay:https://docs.temporal.io/workflows
- Temporal self-hosted guide(dev server 单二进制):https://docs.temporal.io/self-hosted-guide
- Temporal deployment(compose 组件 / binaries / 公网警告):https://docs.temporal.io/self-hosted-guide/deployment
- Inngest self-hosting(单二进制 / SQLite / 本地驻留):https://www.inngest.com/docs/self-hosting
- PostgreSQL SELECT(`FOR UPDATE ... SKIP LOCKED`):https://www.postgresql.org/docs/current/sql-select.html