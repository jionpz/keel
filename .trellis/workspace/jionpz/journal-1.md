# Journal - jionpz (Part 1)

> AI development session journal
> Started: 2026-08-22

---

## 2026-08-24 · Round 1 组件专家审查修复(#1-01..#1-14)

任务:`.trellis/tasks/08-24-round1-fixes/`(GitHub issue #21,Base 7b27e03)。

14 项全部落地,11 个 commit,`pnpm run check` 全绿(198 tests)。

- #1-01 `rfc_draft` 提示词去写死 policy_facts → Policy 重新成为决策者
- #1-02 capability_request 真正接线(validate 第 4 步求值 + T-009 guard 现场求值 + capability fact 注入),缺裁决一律拒收
- #1-03 RunResult.status→ErrorKind 表映射(CANCELLED 不再被打成 retryable PROTOCOL_ERROR)
- #1-04 executeRun 用 pending.attempt + deps.now()(幂等键与 createRun 同构)
- #1-05 OmpAdapter.interrupt 持有并 kill 子进程(不再只标 aborted)
- #1-06 Human collectChanges 读真实 git(与 OMP 抽共享 git-diff.ts)
- #1-07 TIER_REQUIREMENTS 对齐 tierOf/ADR-0005(STRUCTURED_OUTPUT 移出阶梯)
- #1-08 T-013 guardText/文档对齐守卫(decision != auto_develop,不收窄)
- #1-09 删未接线判定点规则(P-DRIFT/P5;P1/P3 收窄到 rfc_ready),不假装接线
- #1-10 补 git-provider.md/ci-gateway.md 契约;Proposal.kind→ProposalKind
- #1-11 验收 cleanup 从 KEEL_TEST_REMOTE_REPO 解析(ownerRepo 导出复用)
- #1-12 I5 反例补 SELECT artifact/event + EXECUTE keel_commit_artifact
- #1-13 fact 层与 domain-model 对账(rfc_draft/cost_basis/control_mode/stage_outcome/blob/权限矩阵)
- #1-14 C4 比 guardText;purity 空生产文件必败;SessionManager 文档降级;DDL 补 CHECK

经验沉淀:
- 「未接线判定点删规则不假装接线」→ ruleset.ts 注释 + policy-engine.md §2.2
- 防假绿第二层(skip 后空生产文件必败)→ error-handling.md + check-purity.ts
- C4 双向比对扩到 guardText → 防 T-013 类 guardText 分叉复发

遗留:真实 GitHub 验收(test:acceptance)需 KEEL_GITHUB_TOKEN + KEEL_TEST_REMOTE_REPO,
本轮环境未设,cleanup 逻辑已被 ownerRepo 单测覆盖。


## 2026-08-25 · Round 2 P1 修复(issue #23 R1+R2)

任务:`.trellis/tasks/archive/2026-08/08-25-round2-p1`(已归档)。

- R1 run 失败面:executeRun 失败不再 return err 中止 → failRunAndAdvance
  标 run FAILED/TIMEOUT/CANCELLED + emit RunFailed/RunTimeout →
  T-030(重试,key /n 递增)/T-031(升人工);CANCELLED 不重试(R-010)。
- R2 occurred_at 统一:effects emit + pipeline 注入注入 now,requireNow 缺失抛错。

验证:pnpm run check 211 tests 全绿;issue #23 关闭。

## 2026-08-25 · Round 2 P2 行为正确性组(issue #23)

任务:`.trellis/tasks/archive/2026-08/08-25-round2-p2-behavior`。

- R8 git-diff 分类按工作区列(porcelain XY,Y 为主;AD/MM/?? 正确)
- R9 FAILED→PROTOCOL_ERROR 取舍注释真相化(不新增 ErrorKind)
- R7 interrupt 进程组 SIGTERM + 兜底 SIGKILL(spawn detached)
- R5 critic 活锁上限(≥2 强制收敛)
- R3 capability 来自 details.capability(deny 真正可达)
- R4 guard 拒=停(NoTransition 留痕,不假装成功)

验证:pnpm run check 215 tests 全绿。

## 2026-08-25 · Round 2 P2 架构一致性组(issue #23)

任务:`.trellis/tasks/archive/2026-08/08-25-round2-p2-arch`(已归档)。

- R10 tierOf 以 TIER_REQUIREMENTS 为唯一数据源(消除双事实源)+ 最小性断言
- R6 loadPolicyFacts 删未接线分支 post_develop/qa_failed/pre_pr;FACTS_AT
  只列已接线点;validate 对引用未接线点规则报错(强化 #1-09)
- R11 DDL 漂移补 run.stage ↔ STAGES、run.harness_tier ↔ HARNESS_TIERS
- R12 check:generated 生成前先查手改(不再静默覆盖),脚本化
- R13 blob 边界文档真相化(进程存储不经 DB 授权)
- S1 human_review→T-013;S2 ROLES 注释;S3 purity 双清单纪律;S4 blob 措辞

验证:pnpm run check 219 tests 全绿。Round 2(issue #23)全清。

## 2026-08-25 · durable timer(方案 A,issue #24)

任务:`.trellis/tasks/archive/2026-08/08-25-durable-timer-workqueue`。

- T1 timer 表(I9 CHECK、部分唯一索引、GRANT keel_control arw)+ 常量(澄清 24h)
- T2 StartTimer/CancelTimer/ConsumeTimer 真实落库(T-005/T-007/T-008)
- T3 claimDueTimers(SKIP LOCKED,只锁不标)+ loop S-NEED_CLARIFICATION 空闲收割
- T4 e2e:澄清 TTL 全链路 + 取消 + 幂等
- T5 文档(I9/权限/默认值)

用户收敛规划为方案 A:不造 wall_clock Task 事件、不打断 in-flight run、
不做并发池。验证:pnpm run check 228 tests 全绿。

## 2026-08-25 · 完整编排器合并验收(真实 OMP + 真实 GitHub)

任务:`.trellis/tasks/archive/2026-08/08-25-merge-acceptance`(已归档)。

- 凭据:gh token 内联(不进文件);Actions 启用、ci.yml 触发 ** 分支。
- 真实验收暴露并修复:**brainstorm 方案未物化为 A-State → 下游 rfc_draft
  无方案 → 3 次不合格 T-031**。修复 synthesizeStateFromBrainstorm。
- 验收 4 轮跑通到合法终态(S-HUMAN_REVIEW ×2 + S-NEED_CLARIFICATION +
  S-HUMAN_REVIEW);Policy 对模型如实填 facts 裁决 human 是正当行为。
- 残留发现:rfc_draft 模型倾向写项目级 RFC(keel 整体)而非 feedback 方案
  —— context state section 内容/workspace 干扰待查,不阻塞编排器验收。
- 远程零残留(0 PR / 0 ai/* 分支);S-DONE 段由 github-pr.acceptance +
  ci-wiring 各自覆盖。

## 2026-08-26 · rfc_draft 上下文质量(issue #25)

任务:`.trellis/tasks/archive/2026-08/08-26-rfc-context-quality`(已归档)。

- R1:promptFor('rfc_draft') 明确方案来源=用户反馈+A-State 候选,
  「不要给整个项目写」+ 如实评估不硬凑 low。生效:模型产出 feedback
  对应 RFC(「导出 Excel 支持按日期筛选」)而非项目级。
- R3:builder.test 确定性钉住 rfc_draft context 含 feedback+A-State。
- 波动性结论:模型对同一 feedback 判定(actionable/unclear/风险)有波动,
  验收因此停在不同状态 —— 这不是 Keel 缺陷;编排器机制验证达成,
  模型调度波动是 acceptance 的本质(README 已承认)。
- 确定性:low/low/1/false facts → auto_develop(engine 纯函数)。

## 2026-08-26 · durable timer 方案 B:in-flight 会话收割(issue #26)

任务:`.trellis/tasks/archive/2026-08/08-26-timer-planb-infight`(已归档)。

- B1 InterruptReason 加 timeout;OMP 按 reason 分流 TIMEOUT/CANCELLED
- B2 pipeline wallClockMs watchdog(fire-and-forget interrupt)
- B3 executeRun 产/消费 run 级 wall_clock timer(+migration 索引,成功/失败都取消)
- B4 e2e:挂起 run1→TIMEOUT→T-030 重试 run2 成功;生命周期;幂等
- B5 文档

验证:235 tests 全绿。Keel 侧强制收割 run 超时(不再只靠 harness --max-time)。

## 2026-08-26 · 独立 timer worker 进程(issue #26)

任务:`.trellis/tasks/archive/2026-08/08-26-timer-worker-process`(已归档)。

- W1 reapTimeoutRun(RUNNING guard 标 TIMEOUT + cancel timer + RunTimeout→T-030)
  + drainAllDueTimers(澄清 claim→T-008 + run 墙钟 reap)
- W2 e2e 4 例(崩溃恢复/澄清/幂等/终态仅取消)
- W3 脚本示例 + §6 文档

方案 B 局限(进程崩溃收割)解债:到期收割由独立进程承载,不依赖 loop。
验证:243 tests 全绿。

## 2026-08-26 · ADR-0003 正式查证(转 Accepted)

任务:`.trellis/tasks/archive/2026-08/08-26-adr0003-verification`(已归档)。

- H1 转移纯度:三层强制(dep-cruiser error + check-purity 8 类 + 纯函数签名)成立
- H2 可重放:I1/时间注入/getAsOf seq/Facts-Only 四要件齐
- H3 Temporal 官方:确定性约束与 Keel 同构;dev server 单二进制;迁移=换承载
- H4 Inngest:自托管成熟(单二进制本地驻留),官方不保证支持
- H5 SKIP LOCKED:官方语法确认,实现符合短事务姿势

ADR-0003 Proposed → Accepted(自研决策维持,迁移路径确证)。

## 2026-08-26 · CLI 入口(issue #27)

任务:`.trellis/tasks/archive/2026-08/08-26-cli-entry`(已归档)。

- src/cli/:argv 解析(零依赖)、index(bin)、timer-worker/run-task/status
- package.json bin keel;删 scripts/timer-worker.ts(并入)
- 241/248 tests 全绿;build 产 dist;实测 status/timer-worker 命令通过

v0.1 可用命令行入口:收割/驱动任务/状态查询。


## Session 1: rfc-low-risk-ac5: 反馈显式约束机械核对，AC1/AC2 达成

**Date**: 2026-08-27
**Task**: rfc-low-risk-ac5: 反馈显式约束机械核对，AC1/AC2 达成
**Branch**: `main`

### Summary

新增 feedback-constraints.ts 机械核对反馈显式声明与 RFC policy_facts(4b)，冲突回灌 R-007；提示词改「反馈约束原样采用+只允许四键」；run-issue/run-task 透传 wallClockS；pnpm run check 全绿(303 passed)。AC3 真实 e2e 未跑(opt-in)。

### Main Changes

- feat(proposal): 4b 范围一致性机械核对 + spec
- feat(cli): wallClockS 透传

### Git Commits

| Hash | Message |
|------|---------|
| `0c84a40` | (see git log) |
| `6954c52` | (see git log) |
| `c759eb5` | (see git log) |

### Testing

- [OK] pnpm run check: 28 files / 303 passed + 4 skipped

### Status

[OK] **Completed**

### Next Steps

- AC3: keel run-issue --ci real(需 KEEL_GITHUB_TOKEN, 创建真实 PR)


## Session 2: merge-crosscut-fixes 收尾(PR #35)

**Date**: 2026-08-27
**Branch**: `cursor/merge-crosscut-fixes-365e`

### Summary

三份审查的明确缺陷分三批落地(`ee726c3` O2/ADR-0003 交叉补齐、`9ce98a3` 失败/超时 run 成本入账 + 同事务熔断、`68ce401` 删除重叠的 merge.acceptance)。复验 `pnpm run check` 全绿(326 passed / 4 skipped),CI 对三个 commit 均 success,PR #35 已转 ready for review。
刻意 deferred:`ContextBuilt` / `artifact-store.commit` 的 occurred_at(需扩契约)、`ensureTraceId` 无 now 的回落分支、归档快照里 merge.acceptance 的历史引用。

### Status

[OK] **Completed** —— 待 human merge(收尾代理不合并)


## Session 3: finish-work: merge-crosscut-fixes 归档收尾(PR #35)

**Date**: 2026-08-28
**Task**: finish-work: merge-crosscut-fixes 归档收尾(PR #35)
**Branch**: `cursor/merge-crosscut-fixes-365e`

### Summary

代理代为执行 finish-work 全流程：修正 .trellis/.developer 被写成 --help 导致 active 任务不可见的问题；archive 08-27-merge-crosscut-fixes 到 archive/2026-08/；记录本 session；随后 squash merge PR #35 到 main。merge 排在 archive/journal 之后，使代码与归档在 main 上同一 commit 落地。

### Main Changes

- chore(task): archive 08-27-merge-crosscut-fixes -> .trellis/tasks/archive/2026-08/
- 修正 .trellis/.developer(name=--help -> jionpz)，恢复 record 模式的 active 任务视图

### Git Commits

| Hash | Message |
|------|---------|
| `ee726c3` | (see git log) |
| `9ce98a3` | (see git log) |
| `68ce401` | (see git log) |
| `b38b5ef` | (see git log) |
| `c7cc4c0` | (see git log) |

### Testing

- [OK] 工作树 clean，Step 2 无 dirty 路径需分类
- [OK] CI 对 .trellis/ 单独变更历史上均 success(c7cc4c0 / b38b5ef)

### Status

[OK] **Completed**

### Next Steps

- R4 契约级遗留：ContextBuilt / artifact-store.commit 的 occurred_at 需扩事件契约，独立任务
- ensureTraceId 省略 occurredAt 的回落分支待全部调用点改注入时钟后清零


## Session 4: Claude Code 第二 Harness：接入并收尾

**Date**: 2026-08-29
**Task**: Claude Code 第二 Harness：接入并收尾
**Branch**: `feat/second-harness`

### Summary

实现 ClaudeCodeAdapter，经 --harness / KEEL_HARNESS 切换（缺省仍 omp）。untrusted 强制 --bare。pnpm run check 全绿。未跑 claude-code-e2e（无 ANTHROPIC_API_KEY），不宣称 Harness 可替换已验证。

### Main Changes

- ClaudeCodeAdapter + stream-json 解析 + CLI resolveHarness
- 缺 claude 二进制或缺 ANTHROPIC_API_KEY 在 ingest 前失败，避免 T-031 假绿

### Git Commits

| Hash | Message |
|------|---------|
| `2867719` | (see git log) |

### Testing

- [OK] pnpm run check：404 passed / 5 skipped
- [OK] claude-code-e2e 未跑（无 ANTHROPIC_API_KEY；--bare 不读 OAuth）

### Status

[OK] **Completed**

### Next Steps

- 补 ANTHROPIC_API_KEY 后跑 claude-code-e2e，再决定是否把「可替换」标为已验证
- 父任务 08-29-phase2-entry 仍开放（wallclock-adr / ingress-poller 按需）

## Session 5: 收口 collectChanges + 修 firstRun 撞键 + --wall-clock

**Date**: 2026-10-26
**Tasks**: `10-25-collect-changes-wiring`（归档）、`10-26-run-reentry-wallclock`（归档）
**Branch**: `main`

### Summary

两条任务一起收口。`collectChanges` 接进编排后，真机 claude 跑通到 S-DONE（5 run ≈$0.13），
develop 的 diff 事件与 commitAll 的 commit 对得上。随后修掉 `firstRun` 漏改这一类缺陷：
`T-010`/`T-012`/`T-017`/`T-018` 四处落在可二次进入的位置，返工后重进阶段会算出重键 →
只有 `SideEffectSkipped` → 驱动无 pending run 直接收工，Task 静默停在原状态。
同时给 `run-task` / `run-issue` 补上 `--wall-clock`。

### Main Changes

- 四处 `firstRun` → `nextRun`，每处注释点明二次进入路径
- `ALLOWED_FIRST_RUN` 白名单 + **双向**断言（多/少都红），断言对象是转移 id 不是阶段名
- `SideEffectSkipped` 的 CreateRun payload 加 `existing_status`：PENDING = 真重放，终态 = 派发丢失
- `parseWallClock` + 两个 CLI 入口 + 顶层 HELP；非法值退出码 1，不静默回退 180
- spec 新增 `transition-effects.md`；database-guidelines 补 `asRole` 只在抛错时回滚

### Git Commits

| Hash | Message |
|------|---------|
| `39d93ae` | feat(control): 接上 collectChanges —— develop 后收真实 diff 并喂给 QA/Review |
| `2ca98b3` | fix(control): firstRun 漏改四处 —— 返工后重进 qa/review/rfc_draft/develop 会撞幂等键卡死 |

### Testing

- [OK] `pnpm run check`：35 files / 449 passed, 5 skipped
- [OK] 四组负对照都真的变红（T-017 改回 first / 去 existing_status / 放宽墙钟守卫 / 删 wallClockS 展开），还原后转绿
- [OK] CLI 端到端 `--wall-clock 0|abc|1.5` 退出码 1；`--wall-clock 600` 过闸进 runTask

### Status

[OK] **Completed**

### Next Steps

- driver「无 PENDING run 即收工、退出码 0」是另一条缺陷，单独立项
- R4 契约级遗留：ContextBuilt / artifact-store.commit 的 occurred_at 需扩事件契约
- 未决：`.trellis/.template-hashes.json` 与未跟踪的 `.agents/` `.codex/` `.dsh/` 是否入库

## Session 6: 停止原因可区分 —— 静默收工改成可诊断的报错

**Tasks:** `.trellis/tasks/archive/2026-10/10-26-orchestrator-stop-reasons`

### Summary

`loop.ts` 的「阶段态没有 PENDING run → `return ok`」把设计内等待、派发丢失、进程已死
三件事压成同一个成功返回。上一轮刚被它坑过：firstRun 撞键导致 T-017 派发丢失，任务
静默停在 S-QA，看起来像「QA 自己跑完了」，查了两轮才找到上游。

### Main Changes

- 判据读证据不按状态归类：阶段态 + 无 PENDING run 时看**最近一次 run** ——
  `CANCELLED` 是设计内的停（`ok` + `cancelled`），其余是故障（`err(NOT_FOUND)`）
- 错误 detail 三要素：当前状态 / 最近 run 的 stage·attempt·status（无 run 明说）/
  下一步查 `SideEffectSkipped.existing_status`（PENDING·RUNNING = 真重放，终态 = 派发丢失）
- `RunToCompletionResult.stopReason` **必填**（7 值），六处既有 `ok` 各补原因 ——
  必填是「新增停止路径忘了表态就编译不过」的强制点
- CLI `printRunResult` 多打 `stopped: <reason>（人话）`；`finalStatus:` 行不动
- 只报告不修复：不自动重派 / 不改 control_mode / 不回滚
- spec 新增 `backend/orchestrator-loop.md`；顺带修掉 `effects.ts` 注释里并不存在的 `CLAIMED`

### Git Commits

| Hash | Message |
|------|---------|
| `be15408` | fix(control): 停止必须带原因 —— 阶段态无 PENDING run 不再当「跑完了」 |

### Testing

- [OK] `pnpm run check`：36 files / 460 passed, 5 skipped
- [OK] 负对照 N1：「一律 ok」→ AC1 / AC6 / AC1' 红 3 绿 6；N2 还原 → 9 全绿

### Status

[OK] **Completed**

### Next Steps

- 多 worker 出现时，「RUNNING 在别人手里」与「RUNNING 死在崩溃进程里」要用租约区分
  —— 现在的 RUNNING 判据只在单进程前提下成立（已写进 spec）
- 剩余遗留不变：GitHub-Issue + 真 CI 验收线未验；R4 `occurred_at` 契约；`post_develop` 策略点未接线
- 未决：`.trellis/.template-hashes.json` 与未跟踪的 `.agents/` `.codex/` `.dsh/` 是否入库
