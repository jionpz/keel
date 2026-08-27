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
