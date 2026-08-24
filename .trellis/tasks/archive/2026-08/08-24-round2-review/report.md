**Review commit**: `be9887e`(Round 1 #1-01..#1-14 + Critic 路径 #1-15 + appendEvent #20 全部落地后)
**Review 日期**: 2026-08-24
**Review 团队**: Contracts / Fact / Control / Execution / Shared-Infra(五席并行 + 主会话对 major 对源码复核)
**状态**: 待处理(P0×0,P1×2,P2×11,suggested×4)
**基线验证**: `pnpm run check` 208 tests 全绿;C1-C4 通过;C4 32 条含 guardText

---

## 执行摘要

第 1 轮的修复(契约-实现对齐)总体成立:C1-C4 门禁全绿、I5/I1/I4 未破、capability 裁决链与 critic 路径能跑通。问题不在「修复没生效」,而在**修复引入了新的契约空转面 + 两组本轮新发现的加载面缺口**:

- **run 失败面无事件生产者**:编排器对 run 失败直接 `return err` 中止,run 卡 PENDING,`T-030/T-031` 死转移(重)
- **occurred_at 注入只在 appendEvent 路径生效**:生产事件(effects/pipeline)直接 INSERT 回落 DB now(),破坏「重放不读时钟」纪律

---

## P0 — 必须立即修复

无。中心不变量 I5 / I1 / I4 / I2 未被代码打破(五席各自确认 + 主会话抽查)。

---

## P1 — 高优先级

### R1. run 失败面无 RunFailed/RunTimeout 事件生产者,失败 run 卡 PENDING

**位置**: `src/control/orchestrator/loop.ts:189`(`return err(executed.error)`)+ `pipeline.ts:150-157`(R-006)

**问题**: `executeRun` 只在成功时 `UPDATE run SET status='SUCCEEDED'`;任何失败面(R-006 连续提案不合格、adapter 非 SUCCEEDED、session 错误)都 `return err` 直接中止 runTaskToCompletion,**run 行保持 PENDING**。全仓 grep:`UPDATE run SET status` 只有 SUCCEEDED 一处;`RunFailed`/`RunTimeout` 事件无生产侧触发(仅转移表/facts/单测引用)。

**影响**: 「阶段失败 → T-030 重试 → T-031 升人工」在编排层空转。失败 run 不标 FAILED、不重试、不升级;重入按同幂等键 `(task,stage,attempt)` 重复执行同一 run(Run 级幂等因此失效)。R-006 契约「连续失败判 Run FAILED」未兑现。

**建议**: executeRun 失败路径按 R-006 标 run FAILED + emit `RunFailed{stage}`,让 T-030/T-031 有触发入口;或明确标注「失败面属 durable timer / work queue 子任务,当前同步循环人为中止并返回 err」。主会话评估:完整重试循环 = 持久化调度子任务本身;**最小止血 = 失败时把 PENDING 标 FAILED**,避免状态污染与重入重复执行。

**证据**: grep `UPDATE run SET status` → 仅 loop.ts SUCCEEDED;pipeline R-006 `return err(SCHEMA_VIOLATION)` 无 run 状态写。

### R2. occurred_at 注入只在 appendEvent 生效,生产事件回落 DB now()

**位置**: `src/fact/artifact-store.ts:192-208`(appendEvent 已注入)vs `src/control/driver/effects.ts:66`、`src/control/proposal/pipeline.ts:105,142`(直接 INSERT)

**问题**: #22 P2-20 把 appendEvent 改为 `Omit<AEvent,'seq'>` 且注入 occurred_at(重放不读时钟,ADR-0003)。但**生产事件的生产者(effects 副作用、pipeline 的 ProposalAccepted/Rejected)都是直接 `INSERT INTO event` 不走 appendEvent、不注入 occurred_at** —— 回落 DB `DEFAULT now()`。

**影响**: 契约文档(artifact-store.md §1.4)声明「occurred_at 由调用方注入」,生产行为却是 DB 时钟。事件时间作为重放依据被破坏;`check:purity` 只管 transition/policy 的纯度,管不到这条路径。

**建议**: effects/pipeline 的 emit 统一走注入的 now(从 EffectContext/调用方取),或抽共享 emit helper 强制走同一路径。回归:事件流中 TaskStatusChanged 的 occurred_at 等于注入 now。

**证据**: effects.ts:66 `INSERT INTO event (task_id, type, payload)` 无 occurred_at;pipeline.ts 同;appendEvent(artifact-store.ts)有而生产路径无。

---

## P2 — 应修,不挡主路径

### R3. capability 裁决链对合成路径是装饰性的(Control 席)

**位置**: `loop.ts:195-198` + `ruleset.ts` P-ALLOW-CRITIC + `validate.ts` POLICY_POINTS

合成 A-CapabilityRequest 与事件的 `capability` **硬编码 `'critic_review'`**,必中 P-ALLOW-CRITIC → T-009 guard 恒真;validate 第 4 步的 capability_request 分支无任何触发源(expectedArtifact 无该 kind)→ 双层接线都不能拒绝。Policy 对合成路径无否决能力,与 #1-02「缺裁决即拒」意图不符。建议:从 brainstorm 产物`details.capability` 按键确判(保留 deny 可能),或文档注明「合成路径自动通过,Policy 仅对 Session 直提有效」。

### R4. 编排器把 guard 未过(matched:false)当成功(Control 席)

**位置**: `driver.ts:189-208` + `loop.ts:112-118`

`advance` 未匹配返回 `ok{advanced:false}`,loop 不拦截,记一步后 `readPendingRun` 无 PENDING → `return ok`——capability 被拒时**误报成功**且无拒绝留痕(无 policy_decision、无拒绝原因事件)。建议:loop 区分 matched/未匹配,被拒应明确终止/升人工并落 policy-denied 记录。

### R5. brainstorm↔critic 活锁无收敛保护(Control 席)

**位置**: `table.ts` T-009/T-009b + `loop.ts`

模型连续 `needs_critic=true` 时每轮 brainstorm→critic 耗 2 步,循环至 maxSteps(20)以 RUN_TIMEOUT 中止。无 critic 轮次上限/强制收敛防护。建议:critic 次数上限(≥2 强制走 T-010),Control 硬防护不依赖模型自控。

### R6. loadPolicyFacts 的 post_develop/qa_failed 分支不可达死代码(Control 席)

**位置**: `facts.ts:150-190` + `ruleset.ts` FACTS_AT

规则集只有 rfc_ready/capability_request 有规则,EvaluatePolicy 仅 T-009/T-011 挂载 → post_develop/qa_failed/pre_pr 求值入口为零,~50 行查询(含 actualFilesChanged+files_drift_ratio)永不可达;且注释称 actual 来自 WorkspaceDiff,实际读 stage_outcome.details.files_changed,**源不符**。建议:删不可达分支或加「仅在存在 EvaluatePolicy 效果的判定点加载」校验;修正 actual 源注释。

### R7. OMP interrupt 无 SIGKILL 兜底,spawn 未建进程组(Execution 席)

**位置**: `omp.ts interrupt/exec`

interrupt 只 SIGTERM,不设超时后 SIGKILL;spawn 未 `detached` 建进程组 → omp 的子进程可能逃逸继续跑。建议:SIGTERM 后兜底 SIGKILL(或 allowTimeout 参数),spawn 建进程组以便整组终止。

### R8. git-diff change 分类与 porcelain 语义分叉(Execution 席)

**位置**: `git-diff.ts`

porcelain 首两字符含暂存/未暂存双状态(如 `MM`),实现 `code.includes('D')` 判断会误分类(`AD` 等)。建议:用第二列或 m 优先规则精确分类。

### R9. FAILED → PROTOCOL_ERROR 标签语义不符(Execution 席 + 主会话复核)

**位置**: `manager.ts:58` RUN_STATUS_ERROR

FAILED 是运行失败,PROTOCOL_ERROR 是「输出无法解析」——映射后 retryable 归因误导(#1-03 本想区分语义,FAILED 仍被压平)。建议:按 #22 P1-3 原建议,FAILED 保留 Adapter 返回的既有 KeelError(有则透传)。

### R10. TIER_REQUIREMENTS ↔ tierOf 双事实源,互证测试单边(Shared 席)

**位置**: `tier.ts:27-40` + `ids.ts:116-121` + `adapters.test.ts:127-134`

tierOf 内联重实现阶梯(不从 TIER_REQUIREMENTS 派生),互证测试只证「表能推出档」,不证「档的要求恰好是表」——往 L1 误加 CAP-STREAM 测试仍绿。建议:tierOf 以 TIER_REQUIREMENTS 为数据源,或补最小性断言(去掉任一必需能力必降档)。

### R11. DDL 漂移测试缺 run.stage / run.harness_tier(Shared 席)

**位置**: `artifact-store.test.ts` 漂移块 + migration

漂移测试只覆盖 task.status/artifact.kind/task.control_mode/run.status;**run.stage(本轮 critic 新增,CHECK 7 值)与 run.harness_tier 未测**。建议:补 checkValues('run','stage') ↔ STAGES、checkValues('run','harness_tier') ↔ HARNESS_TIERS。

### R12. check:generated 声称检测手改,实为静默覆盖(Shared 席)

**位置**: `package.json`(check:generated)+ `generate-types.ts`

`generate && git diff --exit-code HEAD -- src/generated` 中 generate 先重写(手改被就地抹掉),随后 diff 恒空 → 永远绿;只防「schema 变了没重生成」,不防手改。建议:先 diff 判定再 generate,或把 HEADER「检测手改」改称「重生成并丢弃手改」。

### R13. blob 读写以属主身份在 SET ROLE 之外(Factory 席 P2)

**位置**: `blob.ts` + `artifact-store.ts`

blob 文件读写以属主(非 keel_control 角色)身份执行,文件顶部纪律陈述「仅 Control 写」对 blob 落空。建议:文档澄清 blob 是进程内内容寻址(非 DB 权限面),或显式角色化。

---

## suggested — 可选

- **S1** C4 guardText 只前向同步(文档↔guardText 串),不解析 guard 函数——T-013 类「改守卫忘改 guardText」复发不可检。高危守卫补专项测试(构造使 guardText 断言意义相反的用例)。
- **S2** run.role 无 CHECK、无漂移绑定;ids 有 ROLES。与 run.stage/tier 一并决定(加 CHECK 或明示自由文本)。
- **S3** purity GUARDED_DIRS 与 dep-cruiser 纯规则目录双清单手动同步。
- **S4** docs §6 误称 blob「表」(实为本地文件系统),domain-model §4 run 权限行已改但 §6 措辞残留。

---

## 钉住的不变量(五席 + 主会话确认未破)

| 不变量 | 证据 |
|---|---|
| I5 execution ↛ fact | 迁移 GRANT + cruiser execution-must-not-write-fact 未放宽;新 critic 路径属 Control 合法读写 |
| I1/I4 事件只增不改、状态变更必伴随事件 | driver 单事务;T-009/T-009b 各落 TaskStatusChanged |
| T-010/T-009b guard 精确判别,无死转移 | C4 32 条含 guardText 通过 |
| C1-C4 全绿 | check:generated / transitions(guardText)/ purity 二阶 / boundaries 0 violation |
| Policy 严格性偏序 + 默认 deny | engine.ts 健全,无发现 |

---

## 参考

- 五席输出:`agent://Review{Contracts,Fact,Control,Execution,Shared}`
- 上轮:`issue #21`(行动项清单、2026-08-24 关闭)、`issue #22`(首轮报告、2026-08-24 关闭)
- 任务:`.trellis/tasks/archive/2026-08/{08-24-round1-fixes,08-24-critic-capability-path}` + `08-24-round2-review`(本报告)
- 文档:`docs/04-state-machine.md` / `05-contracts/*` / `07-flows.md`(critic 注记)