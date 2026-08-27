# run-issue 全真实闭环

父任务：`.trellis/tasks/08-27-github-issue-automation`。依赖：子任务 `08-27-issue-intake` 完成（AC1–AC4）。

## Goal

把 ingest 出的 task 接到真实 GitHub PR/CI：`run-task --ci real` 接线 + `keel run-issue` 组合命令 + opt-in 真实验收，闭合 AC5–AC7。

## Requirements

- R7 `run-task --ci real`：构造 GitHubProvider，传 WorkflowDriver 第三参 + `opts.ci`；无 token 启动即报错；`--ci passed|failed` 不变
- R8 `keel run-issue <url>`：ingest + run-task；打印终态与 PR URL；非 S-DONE（如 S-HUMAN_REVIEW）如实报告，退出码 0
- R9 opt-in 真实验收：带 label 的真实 Issue → run-issue --ci real → S-DONE + 真实 PR + CI + 事件流 T-001→T-024

## Acceptance Criteria

- [ ] AC5：`keel run-issue <url> --ci real` 在测试仓库到达 S-DONE，真实 PR + CI passed，输出 PR URL；事件流 T-001 起 T-024 终
- [ ] AC6：Policy 高风险 Issue 停在 S-HUMAN_REVIEW，run-issue 如实报告（不伪造成功）
- [ ] AC7：`pnpm run check` 全绿；opt-in `test:acceptance` 至少跑通一次（模型波动按诚实失败记录）

## Out of Scope

- Webhook / daemon / work queue（Phase 3）
- 改 Policy 放宽高风险路径
- Issue 评论回灌 / 自动 merge

## Dependency

**阻塞依赖**：`08-27-issue-intake` 必须先完成（migration、intake、ingest-issue CLI）。本任务不重做 intake。
