# 完整编排器合并验收(真实 OMP + GitHub)

## Goal

把已分别验证的段**合并跑通一次**:`runTaskToCompletion` + 真实 OMP(全链路 S-NEW→S-DONE)+ 真实 GitWorkspace(push 真实分支)+ 真实 GitHubProvider(建 PR + waitForCi 读真实 Actions)。这是 v0.1 的最终整合验收——每段单测已过,「合起来一次成功」未证。

## Background(现状盘点,2026-08-25)

| 段 | 现状 | 缺口 |
|---|---|---|
| 编排器全链路(真实 OMP) | `v01-criterion.acceptance.test.ts` 走 S-NEW→S-DONE,**CI 注入**(externalCi) | CI 是假的(注入 passed) |
| 真实 PR+CI 工具层 | `github-pr.acceptance.test.ts`:push → 建 PR → 幂等 → waitForCi passed(真实 GitHub) | 不接编排器(独立工具测试) |
| loop `opts.ci` 路径 | `ci-wiring.test.ts` 用 FakeCi 验证过(waitForCi → CIPassed → T-024) | 未用真实 provider 在真实 task 上跑 |

**合并缺口**:v01 的 externalCi 换成 `opts.ci = new GitHubProvider({token, ...})` + 真实 remote + worktree 模式——即 CI 段从注入变真实。其余段(v01 已证)不变。

## Requirements

### R1 · 合并验收测试

新文件 `src/acceptance/merge.acceptance.test.ts`(或扩展 v01):
- 种子与 v01 相同:仓库 + 反馈 + Task,测试不写产物;
- `runTaskToCompletion(taskId, deps, { maxSteps, ci: realGithubProvider })`——CI 用真实 GitHubProvider(KEEL_GITHUB_TOKEN + KEEL_TEST_REMOTE_REPO);
- worktree 模式(loop opts.ci 分支要求);
- 断言:
  - finalStatus=S-DONE(真实 CI 回读 passed);
  - 远程仓库出现 `ai/task-<id>` 分支 + PR(headBranch 可解析);
  - 事件流含 T-024(CIPassed → S-DONE);
  - 清理:关 PR + 删分支(复用 github-pr.acceptance 的 cleanup 模式,ownerRepo 解析);
- 超时:`300_000`(Action ~60s + OMP 会话)。

### R2 · 前置门控

- beforeEach:token + remote 缺失 → **明确失败**(不 skip,README 纪律);
- `KEEL_REQUIRE_OMP` 需开启(真实 OMP 段门控,与 v01 相同?看 v01 是否门控——README 说 acceptance 是显式命令,可能不门控 OMP);
  - 查 v01 是否 `skipIf(!REQUIRE_OMP)`——若 v01 直接跑,则合并测试也直接跑;
- 私有仓库 vs public:repo 是 public(刚查 isPrivate=false)——push 分支会公开。**注意**:验收会真实 push 一个 ai/* 分支到 public repo;可接受?或建议推之前用户确认。风险标注。

### R3 · 验收记录

通过后:按 README 纪律把 日期/路径/耗时 记入本任务 prd.md。

## Acceptance Criteria

- [ ] R1:合并测试全链路一次跑通(finalStatus=S-DONE,真实 PR+CI)
- [ ] R2:无凭据 → 明确失败(不 skip);REQUIRE_OMP 门控与 v01 一致
- [ ] R3:验收记录写入 prd.md(日期/路径/耗时/PR 号)
- [ ] 清理:验证后远程无残留(PR 关、分支删)

## Constraints

- 不改 `check`(验收仍独立命令 test:acceptance)。
- 不加探测性宽松:断言强度与 v01/github-pr 一致。
- 凭据不落文件:KEEL_GITHUB_TOKEN 由调用终端 export(本会话用 `$(gh auth token)` 内联 env,不写仓库)。
- 真实 push 到 public repo 前,与用户确认分支可见性可接受。

## Notes

- 轻量任务,PRD-only 可能够——但含外部依赖(GitHub Actions 真实跑),失败模式多,design.md 记一次「预期失败点与诊断」。
- 之前 2026-08-24 的 github-pr 验收已 push 过 `ai/*` 分支并清理——先例存在。