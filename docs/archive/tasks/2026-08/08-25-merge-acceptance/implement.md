# 完整编排器合并验收 — 执行计划

## 步骤

### 1. 写合并验收测试

`src/acceptance/merge.acceptance.test.ts`:
- 种子复制 v01(仓库/反馈/Task,测试不写产物);
- deps:worktree 模式 + 真 OMP adapter + `ci: new GitHubProvider({ token: readTokenFromEnv(), pollIntervalMs: 5000, pollTimeoutMs: 300000 })`;
- `runTaskToCompletion(taskId, deps, { maxSteps: 30, ci })`;
- 断言:finalStatus=S-DONE、run 表 develop SUCCEEDED、事件流含 CIPassed/T-024、分支在远程可解析;
- cleanup:关 PR + 删远程分支(ownerRepo 解析,复用 github-pr.acceptance 模式);
- 无凭据 → beforeEach throw(明确失败,不 skip)。

### 2. 运行验收

```bash
export KEEL_GITHUB_TOKEN="$(gh auth token)"
export KEEL_TEST_REMOTE_REPO="https://github.com/jionpz/keel"
KEEL_REQUIRE_OMP=1 pnpm run test:acceptance
```

- filter:先只跑 merge 测试(`-t 合并`),过后再全量 acceptance。

### 3. 验收记录 + 清理

- prd.md 追加:日期/路径/耗时/PR 号/Artifact 结果;
- 确认远程无残留(PR closed、分支删除——cleanup 应处理,人工复核 `gh pr list` + `git ls-remote`)。

## 预期失败点与诊断

| 失败 | 诊断 |
|---|---|
| OMP 会话 3 次提案不合格(R-007) | deepseek 输出波动,重跑或调 prompt;不降 schema |
| waitForCi 超时 | Actions 未触发(workflow 缺失/分支名不匹配),查 repo Actions 页面 |
| push 失败 | remote 无写权限/token 过期 |
| auth 失败(401/403) | KEEL_GITHUB_TOKEN 不是 gh auth token?重生成 |
| CI 永远 pending | Actions-only 仓库空 status 判定(8885ae2 已修)——应在 passed |

## 验证命令

```bash
pnpm run check        # 回归先全绿
pnpm run test:acceptance  # 凭据就绪
```

## 回滚

测试失败不 merge;清理远程残留(PR/branch)即使测试失败也做。