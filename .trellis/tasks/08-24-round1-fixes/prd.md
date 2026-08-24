# Round 1 组件专家审查修复 (P1+P2)

## Goal

修复 GitHub issue #21(唯一事实源)列出的 14 项「契约声称已落地、实现空转或写死」问题。无 P0;P1 项可单独 merge;先 #1-01。本轮不实现 C-*/R-* 表、不补整套 SessionManager、不重写 Workflow engine。

Base commit: `7b27e03`(origin/main HEAD)。

## Requirements

### P1(契约与实现对齐)

- **#1-01** `rfc_draft` 提示词不得预置/暗示 `policy_facts` 的具体取值——Policy 是决策者,模型如实填写。
  - 位置:`src/control/orchestrator/prompts.ts` rfc_draft 分支("policy_facts 要如实填写:这是一个低风险、低复杂度、非安全相关的小改动。")
  - 回归:`promptFor('rfc_draft')` 输出不含写死取值。
- **#1-02** `capability_allowed` 读 Policy 求值;validate 第 4 步求值。缺裁决不得默认 true。
  - 位置:`src/control/driver/facts.ts`(`capability_allowed: true`)、`src/control/proposal/validate.ts` 第 4 步(空返回)。
  - 回归:validate 第 4 步对 capability_request 真正调 Policy;无裁决时拒绝。
- **#1-03** `advance` 按 `RunResult.status` 映射 ErrorKind:`CANCELLED`→`RUN_CANCELLED`、`TIMEOUT`→`RUN_TIMEOUT`;禁止一律 `PROTOCOL_ERROR`。
  - 位置:`src/execution/session/manager.ts`(非 SUCCEEDED → PROTOCOL_ERROR)。
  - 回归:人工撤回(CANCELLED)`retryable=false`,不走 T-030 重试。
- **#1-04** `executeRun` 用 `pending.attempt` 而非写死 `1`;`ended_at` 走 `deps.now()` 而非 `now()`。
  - 位置:`src/control/orchestrator/loop.ts`(attempt: 1、idempotency_key `${taskId}/${pending.stage}/1`、`ended_at=now()`)。
  - 回归:第二次 develop 的 idempotency key 以 `/${n}` 结尾且 `n>1`;ended_at 可注入。
- **#1-05** `OmpAdapter.interrupt` 持有并杀掉子进程,而非只标 `aborted`。
  - 位置:`src/execution/adapters/omp.ts` interrupt。
  - 回归:可挂起的 spawn fixture 能被 interrupt 终止。
- **#1-06** `HumanAdapter.collectChanges` 读真实 git 脏树,而非恒空。可与 omp 抽共享 git-diff。
  - 位置:`src/execution/adapters/human.ts` collectChanges。
  - 回归:worktree 有改动时 `is_dirty=true` 且 `files_changed` 非空。
- **#1-07** `TIER_REQUIREMENTS` 对齐 ADR-0005 / `tierOf`。L1=`HEADLESS+RESUME`;STRUCTURED_OUTPUT 移出阶梯;或删除未用常量。
  - 位置:`src/shared/ids.ts` TIER_REQUIREMENTS。
- **#1-08** T-013 改文档/guardText,不收窄守卫。guard 保持 `decision !== 'auto_develop'`;guardText 改成 `decision != auto_develop`。不能只认 `human_review`(会弄坏 `security_review` → T-013,`driver.test.ts:378`)。
  - 位置:`src/control/transition/table.ts` T-013 guardText;`docs/04-state-machine.md`。
  - 回归:security_review 仍走 T-013 → S-HUMAN_REVIEW。
- **#1-09** 删「C-*/R-* 各有自己的表」的表述;未接线判定点从 `DEFAULT_RULES` 删除(或真正挂 EvaluatePolicy)。本轮默认删规则。
  - 位置:`src/control/policy/ruleset.ts` DEFAULT_RULES;相关文档。
- **#1-10** 补 `git-provider.md` / `ci-gateway.md` 契约文档;`Proposal.kind` 改为 `ArtifactKind` 或 `PersistedArtifactKind`。
- **#1-11** 验收 cleanup 从 `KEEL_TEST_REMOTE_REPO` 解析 repo,禁止写死默认 owner/repo 字面量。
  - 位置:`src/acceptance/github-pr.acceptance.test.ts` cleanup(`gh pr close --repo jionpz/keel`)。
  - 回归:凭据可用时 cleanup 用环境变量解析的 repo。

### P2(文档/一致性)

- **#1-12** I5 反例补 `SELECT artifact/event` 与 `EXECUTE keel_commit_artifact`。
- **#1-13** `src/fact/index.ts` 与 `03-domain-model.md` 对齐已落地的 GRANT / blob / `control_mode` / `cost_basis`。
- **#1-14** C4 比 `guardText`;purity skip test 后生产文件为空则失败;SessionManager 文档降级为 `[可延后]`;DDL CHECK 漂移测试补 `control_mode` / run 枚举。

## Acceptance Criteria

总门:`pnpm run check`(lint → typecheck → boundaries → check:generated → check:transitions → check:purity → test)全绿;`test:acceptance` 不进默认 check,凭据可用时单独跑。

- [ ] #1-01:promptFor('rfc_draft') 不含写死 policy_facts 取值;针对性回归通过
- [ ] #1-02:capability_allowed 由 Policy 裁决;validate 第 4 步求值;缺裁决默认拒绝
- [ ] #1-03:advance 按 status 映射 RUN_CANCELLED/RUN_TIMEOUT;CANCELLED 不 retryable
- [ ] #1-04:executeRun 用 pending.attempt;ended_at 走 deps.now();回归 n>1
- [ ] #1-05:interrupt 杀子进程;spawn fixture 可被挂起/终止
- [ ] #1-06:human collectChanges 读 git 脏树;is_dirty 反映真实改动
- [ ] #1-07:TIER_REQUIREMENTS 与 ADR-0005/tierOf 一致(或用例覆盖)
- [ ] #1-08:guardText/文档改为 `decision != auto_develop`;security_review → T-013 回归通过
- [ ] #1-09:未接线判定点从 DEFAULT_RULES 删除;文档同步
- [ ] #1-10:git-provider.md / ci-gateway.md 落地;Proposal.kind 类型收紧
- [ ] #1-11:cleanup 从 KEEL_TEST_REMOTE_REPO 解析 repo,无写死字面量
- [ ] #1-12:I5 反例覆盖 SELECT artifact/event 与 EXECUTE keel_commit_artifact
- [ ] #1-13:fact 层与 domain-model 文档对齐 GRANT/blob/control_mode/cost_basis
- [ ] #1-14:C4 guardText 比对;purity skip 后空生产文件必失败;SessionManager 文档降级;DDL CHECK 覆盖补齐

## Constraints

- 不重写 Workflow engine(ADR-0003 仍 Proposed)。
- 不接入除 OMP / human 以外的 Harness。
- 不实现 `SessionManager.checkpoint/restore/selectAdapter`。
- 不把 I5 从 DB 授权改成只靠类型系统。
- T-013 改文档不改守卫。
- 放宽 C1–C4 需走 ADR。
- PR / commit footer 写 `(issue #1 #1-xx)`。

## Notes

- 关键决策:无 P0,先合 #1-01;未接线判定点默认删规则,不假装接线。
- 证据文档 `../260824-keel-round1-component-review/issue.md` 不在本机;issue #21 正文为唯一需求源,已对照源码逐项核实。
- 复杂任务:需补 `design.md` + `implement.md` 后再 `task.py start`。