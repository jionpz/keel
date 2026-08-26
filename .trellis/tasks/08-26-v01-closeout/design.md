# Design · v0.1 收口

## 1. 合并验收架构

```
seed(remote repo clone)
  → runTaskToCompletion(taskId, {
       driver: WorkflowDriver(policy, { git, repoId, baseBranch }, githubProvider),
       adapter: OmpAdapter,
       workspace: { mode: 'worktree', git, repoId, baseBranch },
       ...
     }, { ci: githubProvider })   // 不用 externalCi
  → assert S-DONE + SideEffectApplied(CreatePullRequest) + T-024 + readEvents 一致
  → cleanup: close PR, delete remote branch
```

**不变量**：CI 仍是外部事实源；区别是 gateway 读真实 GitHub Checks，而非测试回调。

**与 `github-pr.acceptance.test.ts` 的分工**：

| 测试 | 验证 |
|---|---|
| `github-pr` | GitWorkspace + GitHubProvider 原子能力 |
| `v01-criterion-github` | 编排器全链路 + 事件重建 |

## 2. O4 时间线脚本

- 路径：`scripts/timeline.ts`
- 依赖：`PgArtifactStore.readEvents(taskId, 0, limit)`
- 输出：JSON lines 或表格化 stdout（seq, type, created_at, payload 关键字段）
- 缺 task_id 或非 UUID → exit 1 + 用法说明
- 需 Postgres（与现有测试相同）；无 DB 时明确失败

## 3. Human L0 e2e

- 路径：`src/e2e/human-harness.test.ts`
- `HumanInbox` 同步桩：`notify` 记录 spec；`await` 立即返回合法 `stage_outcome` JSON（PM 阶段）
- `runTaskToCompletion` 或 `executeRun` 单步：只跑 PM 一个 PENDING run 后 advance
- 断言：`artifact` 有 `stage_outcome` 且 `produced_by_run` 非空；`harness_id='human'`

## 4. 幂等重放单测

- 路径：`src/control/driver/effects.test.ts` 扩展，或 `src/e2e/idempotency-replay.test.ts`
- 场景：Task 已在 `S-PR_OPEN` 且 PR 已创建 → 再次 `RunSucceeded(review)` 或重复 CreatePullRequest effect → `SideEffectSkipped` + 无 duplicate PR
- 沿用现有 `FakeGateway` 模式（`effects.test.ts`）

## 5. 文档与 ADR

- ADR-0004：Postgres + ArtifactStore 已交付 → **Accepted**
- ADR-0006：Session restore 双路径已在 session-manager 实现 → **Accepted**（若代码与 ADR 一致）；否则保持 Proposed 并写理由

## 6. 边界

- 不改 `transition/table.ts`（C-002 不在范围）
- 不放宽四条架构约束
- acceptance 测试不进默认 check
