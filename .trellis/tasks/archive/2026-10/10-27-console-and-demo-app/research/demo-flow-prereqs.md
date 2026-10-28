# 研究 · 真实 Issue 闭环的前置条件

## 本机环境（2026-10-27 实测）

| 项 | 状态 |
|---|---|
| Node | v24.14.1（`.nvmrc` = 24） |
| pnpm | 10.33.0 |
| Postgres | 16.15，`pg_isready` 通过；库 `keel_dev` 已迁移 |
| `keel_dev` | 7 tasks / 23 runs / 109 events |
| gh | 已登录 `jionpz`，token 类型 `gho_` |
| claude harness | `claude` 在 PATH；demo4 用它跑通过 5 个 run |
| omp harness | `/Users/jionpz/.bun/bin/omp` |
| git 凭据 | `credential.helper = !/opt/homebrew/bin/gh auth git-credential`（全局） |

## 真实闭环需要的凭据与参数

- `KEEL_GITHUB_TOKEN`：`gh auth token` 可直接提供；`GitHubProvider` 只从
  `KEEL_GITHUB_TOKEN` / `GITHUB_TOKEN` 读。
- `--ci real`：真实创建 PR 并回读 Actions check；`--ci passed` 是替身，不满足 PRD AC6。
- git push 依赖全局 credential helper，已确认配置；`ensureBareRepo` 直接 clone
  `https://github.com/...`。
- `--harness claude`：`requireClaudeReady()` 会先探测凭据与二进制，缺了会在 ingest 前失败，
  不会留下半截 task。

## 上一次 demo 与这次的区别

- 2026-10-25 demo4 用的是 `file:///tmp/keel-demo-repo`：没有真实 PR，
  事件里是 `SideEffectIntent(CreatePullRequest)` 占位，T-024 由 `--ci passed` 触发。
- 本次必须看到真实的 `CreatePullRequest` 副作用 + 真实 Actions 回读，才算闭环。

## demo 仓库要求

- 必须自带 GitHub Actions（`.github/workflows/ci.yml`），且首次 push 为绿。
- 测试必须零依赖、秒级（`node --test`），否则 CI 回读延迟会拖垮整轮。
- Issue 文案要小：PM 判 `actionable`，且不带设计分支（`needs_design=false`）走 rfc_draft 快路径。

## 观察点

- 控制台 + `keel status <id>` + `pnpm run timeline -- <id>` 三处口径一致。
- 终态 `S-DONE` 之前应依次看到：`CreateBranch`、`WorkspaceDiffCollected`、
  `ProposalAccepted(qa/review)`、`SideEffectApplied(CreatePullRequest)`、`TaskStatusChanged(T-024)`。
