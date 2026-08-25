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
