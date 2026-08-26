# v0.1 收口：合并验收与父任务关闭

> 父任务：`08-23-v01-closed-loop`
> 范围决策：**A**（2026-08-26）—— 合并验收 + 集成复核 + O4 + Human L0 + 文档同步；**C-002 切出**

## Goal

用**一次真实运行**完成 v0.1 判据的完整证明——一条真实反馈经 `runTaskToCompletion` 无人干预走完 `S-NEW → S-DONE`，产出真实 GitHub PR 且真实 CI 通过，且 `readEvents(task_id, 0)` 完整重建全过程——并据此完成父任务的集成复核与诚实关闭。

## Background

- 9 个子任务均已 completed；父任务仍 `planning`，跨子任务 checklist 全空。
- 判据目前两半拼接：`v01-criterion`（CI 注入）与 `github-pr`（不经编排器）。
- 产品接线已齐：`opts.ci`、`WorkflowDriver.github`、`CreatePullRequest`、`GitHubProvider`（`PullRequestGateway` + `CiGateway`）。
- push 鉴权靠环境 git credential（如 `gh`）；`KEEL_GITHUB_TOKEN` 覆盖 API。

## Requirements

### R1 · 合并验收

新增 `src/acceptance/v01-criterion-github.acceptance.test.ts`（**不改造**现有 `v01-criterion`，保留本地 cheap 回归）：

- seed 使用 `KEEL_TEST_REMOTE_REPO` 克隆裸仓库（先例：`github-pr.acceptance.test.ts`）
- `GitHubProvider` 同时注入 `WorkflowDriver` 第三参与 `opts.ci`；**不用** `externalCi`
- 无人干预走完 `S-NEW → S-DONE`；事件含真实 `SideEffectApplied`（CreatePullRequest）；`T-024` 由真实 `waitForCi='passed'` 驱动
- 缺 `KEEL_GITHUB_TOKEN` / `KEEL_TEST_REMOTE_REPO` 时 beforeEach **明确失败**
- 收尾：关 PR、删远端 `ai/*` 分支
- 保留现有断言：转移序列、`ContextBuilt`、`policy_decision`、develop 分支提交

### R2 · 父任务集成复核

在父任务 `prd.md` 书面回答：

1. `docs/08-cross-cutting.md` §2.2 四问（引用事件 payload）
2. 幂等重放：对已完成 Task 重复触发需幂等的 advance/effect，断言 `SideEffectSkipped`（确定性单测）
3. Human L0 路径结论（由 R4 e2e 证明）

跨子任务 checklist：逐项勾选；**C3（C-002）** 显式标注缺口并链接后续任务 slug `v01-budget-fuse`（仅记录，本任务不建）。

### R3 · O4 时间线导出

`pnpm run timeline -- <task_id>`（tsx 脚本）：stdout 输出该 Task 的完整事件序列（seq、type、payload 摘要），读 `ArtifactStore.readEvents`。

### R4 · Human L0 最小闭环

确定性 e2e：`HumanAdapter` + 同步 `HumanInbox` 桩在编排循环中跑通至少一个阶段（如 PM），断言产物落库且 `produced_by_run` 非空。放在 `src/e2e/`，进 `pnpm run check`。

### R5 · 文档同步

| 位置 | 修正 |
|---|---|
| `docs/01-overview.md` §8 | GitHub 集成已完成 |
| `docs/README.md` 状态表 | GitHub 集成 + ADR-0005 Accepted |
| `src/acceptance/v01-criterion.acceptance.test.ts` 头注释 | 子任务 7 已完成；CI 注入是本地版刻意设计 |
| `src/control/orchestrator/loop.ts` `externalCi` 注释 | 同上 |
| `docs/adr/0004-persistence.md`、`0006-session-recovery.md` | 复核 Status（实现已交付 → Accepted 或写明保持 Proposed 理由） |

### R6 · 收尾

- 归档 `08-23-split-acceptance-tests`（若仍 active）
- 父任务与本任务转 completed 并归档（实现完成后由主会话执行）

## Out of Scope

- `C-002` 预算熔断（后续任务 `v01-budget-fuse`）
- durable timer / work queue
- 连续 5 个真实 Task / CLI 入口
- 第二 Harness、ADR-0003 查证、UI、自动合并 PR

## Acceptance Criteria

- [ ] `v01-criterion-github.acceptance.test.ts` 在凭据齐全时一次跑通 `S-NEW → S-DONE`（真实 PR + CI）——代码就绪，待有凭据环境执行
- [x] 验收记录写入本任务 `prd.md`（实现阶段记录已写；合并验收通过后补 PR 链接）
- [x] 父任务集成复核三问有书面答案；checklist 勾选或显式缺口（C3 → `v01-budget-fuse`）
- [x] 幂等重放确定性单测在 check 中为绿
- [x] `pnpm run timeline -- <task_id>` 输出完整事件序列
- [x] Human L0 e2e 在 check 中为绿
- [x] 文档漂移修复；`pnpm run check` 全绿
- [x] `08-23-split-acceptance-tests` 已归档

## Key Decisions

| 决策 | 选择 | 理由 |
|---|---|---|
| 收口范围 | A | 诚实关父任务且不拖 C-002 新功能 |
| 合并验收落点 | 新文件 | 与 `github-pr` 先例一致；本地版保留 |
| C-002 | 切出 | control_mode 首次实现，牵动转移表 |

## Risks / Deferred

- 合并验收依赖推理网关 + GitHub；LLM 波动可能导致重跑（acceptance 分离已兜底）
- 合并验收耗时长（~3–15 min），不进默认 check

## Notes

- 前置：`gh` 登录 + `KEEL_GITHUB_TOKEN` + `KEEL_TEST_REMOTE_REPO` + OMP
- 子代理禁止 `git commit`；主会话负责提交与 PR

---

## 验收记录

### 2026-08-26 · 实现完成（云环境，Implement 子代理）

- `pnpm run check` **全绿**（lint / typecheck / boundaries / check:generated /
  check:transitions / check:purity / 12 个测试文件，含本次新增的
  `human-harness.test.ts` 与 `effects.test.ts` 幂等重放块）。
- `pnpm run timeline -- <task_id>` 已实测：对 Human L0 e2e 留下的真实 Task 输出
  6 条完整事件（`RunCreated → TaskStatusChanged(T-002) → ContextBuilt →
  ProposalAccepted → RunCreated → TaskStatusChanged(T-004)`）；
  缺参数 / 非 UUID / task 不存在 / 数据库不可用四条失败路径均已反例验证（exit 1 + 可操作信息）。
- **合并验收 `v01-criterion-github.acceptance.test.ts` 代码已就绪但未在本环境执行**：
  本环境无 omp CLI、无推理网关凭据，`gh` 为只读 token（不能建 PR），
  按「明确失败优于假绿」不伪造记录。**待主会话 / 有凭据环境执行**：

  ```bash
  KEEL_GITHUB_TOKEN="$(gh auth token)" \
  KEEL_TEST_REMOTE_REPO=https://github.com/jionpz/keel \
  pnpm run test:acceptance src/acceptance/v01-criterion-github.acceptance.test.ts
  ```

  （注意：pnpm 下不要在文件名前加 `--`，否则 vitest 会把过滤器当作 `--` 后的
  透传参数而跑全部验收文件。缺凭据时本文件已实测**明确失败**而非 skip。）

  通过后在此补记：日期 / 走过的路径 / 耗时 / PR 链接。
