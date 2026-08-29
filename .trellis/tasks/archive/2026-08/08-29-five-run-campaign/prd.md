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

- [x] AC1：5/5 到达 `S-DONE`
- [x] AC2：5/5 `ci_verified=true`（GitHub API 核对 check-run success）
- [x] AC3：`five-run-results.jsonl` 5 行完整，无缺失字段
- [x] AC4：抽样 `68eb4965-9aca-4940-a586-d5f8a8f83beb`：`keel status --events` 重建到 S-DONE；ContextBuilt 含 `source_ref` / `dropped`
- [x] AC5：`pnpm run check` 全绿（339 passed / 4 skipped）；五连为 opt-in

## 验收记录

### 第一次（2026-08-29 02:05，失败于 run 4）

| Run | 结果 |
|---|---|
| 1–3 | S-DONE + ci_verified（228s / 351s / 298s） |
| 4 | ingest 拒绝：Issue #53 REST 当时 `labels=[]`（`gh create --label` 后短暂不一致） |
| 5 | 未跑 |

修复：`createLabeledIssue` 等到 `GitHubProvider.getIssue` 看见 `keel`（commit `cfca381`）。

### 第二次（2026-08-29 02:22–02:43，**5/5 通过**，总墙钟 ~1244s）

| Run | Issue | PR | 耗时 | 路径要点 |
|---|---|---|---|---|
| 1 | #54 | #55 | 341s | T-030×2 后仍到 T-024 |
| 2 | #56 | #57 | 180s | 直达 T-024 |
| 3 | #58 | #59 | 182s | 直达 T-024 |
| 4 | #60 | #61 | 248s | T-030×1 后到 T-024 |
| 5 | #62 | #63 | 273s | 直达 T-024 |

JSONL：`research/five-run-results.jsonl`。全部 `human_intervention=false`，`failure_class=null`。

AC4 抽样 run 5：`keel status` 显示 S-DONE [auto]，事件含 ContextBuilt（`dropped:[]`，sections 带 source_ref）。

## Out of Scope

- 改 Policy 规则
- 非文档类 Issue（留给 dogfooding 阶段）
- 合并进默认 CI

## Dependency

无。凭据齐备即可 start。
