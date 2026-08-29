# 五连稳定性战役

父任务：`.trellis/tasks/08-29-phase2-entry`。

## Goal

用 **5 次**标准化低风险真实 Issue 跑 `keel run-issue --ci real`，证明 v0.1 闭环在重复运行下稳定，闭合 `docs/09-roadmap.md` §4.1 触发条件 #2。

## Background

- AC5 第七次单次成功（~140s，T-001→T-024，真实 CI）—— **一次成功可能是运气**
- 环境凭据已验证：ghp_ PAT + OPENCODE + omp + preflight
- 复用 `issue-e2e` 的 Issue 模板与 cleanup 纪律

## Requirements

- R1 **Batch runner**：opt-in acceptance（不进 `pnpm run check`），顺序跑 5 次，每次新建 Issue
- R2 **Issue 模板**：5 变体，均为文档-only、low/low/1、禁止改代码（同 `issue-e2e` ISSUE_BODY 精神）
- R3 **结果 JSONL**：写入 `{TASK_DIR}/research/five-run-results.jsonl`，字段见父 `design.md`
- R4 **每次验证**：preflight + AC5-3b（head SHA 上真实 check success）
- R5 **失败纪律**：不 skip；`human_intervention` 必须 false；Policy 拦截记 `failure_class=policy`
- R6 **cleanup**：每次 finally 关 Issue/PR/删分支（复用 issue-e2e 模式）

## Acceptance Criteria

- [ ] AC1：5/5 到达 `S-DONE`
- [ ] AC2：5/5 `ci_verified=true`（GitHub API 核对 check-run success）
- [ ] AC3：`five-run-results.jsonl` 5 行完整，无缺失字段
- [ ] AC4：抽样 1 个 task_id：`keel status --events` 可重建；ContextBuilt 含 source_ref
- [ ] AC5：`pnpm run check` 全绿（含 batch 测试本身，但不跑 5 连在 check 里—— batch 是 opt-in）

## Out of Scope

- 改 Policy 规则
- 非文档类 Issue（留给 dogfooding 阶段）
- 合并进默认 CI

## Dependency

无。凭据齐备即可 start。
