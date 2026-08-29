# Issue Intake — GitHub → feedback → T-001 task

父任务：`.trellis/tasks/08-27-github-issue-automation`。完整背景见父 `prd.md` 与 `research/evidence-audit.md`。

## Goal

实现 GitHub Issue 进入 Keel 的真实路径：Issue URL → `feedback(source='github')` → `driver.intake()` 建 S-NEW task（T-001 真实化），并提供 `keel ingest-issue` / `keel register-repo` CLI。

## Requirements

- R1 迁移：`feedback.source` 加 `github`；新建 `keel_ingress` 角色（feedback INSERT+SELECT）
- R2 `GitHubProvider.getIssue` + `parseIssueUrl`（stub 单测）
- R3 `WorkflowDriver.intake()` 单事务真实化 T-001；CreateTask/LinkFeedback 移出 recordIntent
- R4 `keel ingest-issue`：label 闸门（缺省 `keel`）、幂等、零写入拒绝
- R5 `keel register-repo`：按 remote_url 幂等注册 repo

## Acceptance Criteria

- [x] AC1：`keel ingest-issue <url>` 产生 github feedback + S-NEW task，事件含 T-001 且 SideEffectApplied（非 Intent）
- [x] AC2：重复 ingest 同一 Issue 返回既有 taskId，无重复行
- [x] AC3：无 label / label 名不匹配 / PR 型 / closed → 拒绝，feedback 与 task 均零写入
- [x] AC4：ingest 出的 task 不经 seed SQL，`driver.advance(Dispatch)` 走既有 T-002 路径
      （完整 `run-task --ci passed` 需真实 OMP + worktree，属 child 2 的 e2e 覆盖）
- [x] AC7 子集：`pnpm run check` 全绿（269 passed / 4 skipped，2026-08-27）

## Out of Scope（本 child）

- `run-task --ci real`、`keel run-issue`、真实验收（→ child `run-issue-e2e`）
- Webhook、daemon、work queue

## Dependency

无。child `run-issue-e2e` 依赖本任务完成。
