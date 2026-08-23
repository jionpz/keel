# Implement — GitHub PR / CI 集成

## Stage 1 · 接口与类型
- [ ] 1.1 新增 `src/contracts/git-provider.ts`：`PullRequestGateway`
- [ ] 1.2 新增 `src/contracts/ci-gateway.ts`：`CiGateway`
- [ ] 1.3 `EffectContext` 增加可选 `github`
- [ ] 1.4 `RunOptions` 增加可选 `ci`，保留 `externalCi` 兼容

## Stage 2 · GitWorkspace push
- [ ] 2.1 `GitWorkspace.push(repoId, taskId, remoteUrl)` 实现
- [ ] 2.2 分支名必须 `ai/*`，拒绝 push 其他分支
- [ ] 2.3 不用 `--force`；以 SHA 判重
- [ ] 2.4 单测：本地 bare repo + 本地 remote，验证 push 与幂等

## Stage 3 · GitHubProvider
- [ ] 3.1 实现 `GitHubProvider`（REST + 可选 `gh`）
- [ ] 3.2 `createPullRequest`：先查已有 PR，再创建
- [ ] 3.3 `waitForCi`：轮询 check-runs / status，返回 passed/failed
- [ ] 3.4 错误映射：`AUTH_FAILED`、`NOT_FOUND`、`RATE_LIMITED`
- [ ] 3.5 单测：stub HTTP server 模拟 GitHub API

## Stage 4 · 副作用执行器
- [ ] 4.1 `CreatePullRequest` 分支接真实 provider
- [ ] 4.2 无 provider 时保持 `SideEffectIntent`
- [ ] 4.3 事件 payload 含 `pr_url` / `pr_number` / `head_sha`，不含凭据
- [ ] 4.4 单测：幂等复用、失败回滚、无 provider 退回

## Stage 5 · 编排器 CI 接线
- [ ] 5.1 `S-PR_OPEN` 使用 `ci.waitForCi`
- [ ] 5.2 保留 `externalCi` 作为测试/本地兼容路径
- [ ] 5.3 单测：fake CiGateway 驱动 `T-024` / `T-025`

## Stage 6 · 验收与文档
- [ ] 6.1 更新 `src/acceptance/` 或新增真实 GitHub 验收测试（可选运行）
- [ ] 6.2 更新 README / docs 状态
- [ ] 6.3 在正常环境跑 `pnpm run check`
- [ ] 6.4 在提供远程与凭据后跑 `pnpm run test:acceptance` 并记录
- [ ] 6.5 本任务 `prd.md` 写验收记录
