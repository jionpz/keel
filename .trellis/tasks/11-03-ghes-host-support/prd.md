# GitHub Enterprise (GHES) host 支持

> 对应 GitHub issue [#69](https://github.com/jionpz/keel/issues/69)，父任务
> `11-03-enterprise-deployment`（issue #70 §1）。P0：其余企业落地项全依赖它。

## Goal

让 `GitHubProvider` 与 URL 解析不再假定 `github.com`，从而支持企业内 GHES 实例
（如 `https://github.example.com`）；同时保证不设新配置时 github.com 行为**逐字节不变**。

## Current Gaps

| # | 位置 | 现状 | 后果 |
|---|---|---|---|
| 1 | `src/fact/github-provider.ts:25` | `API_ROOT = 'https://api.github.com'` 常量 | REST 全部打公网 |
| 2 | `ownerRepo()` 正则 `github\.com[/:]` | 只认 github.com | GHES remote 解析失败，register-repo / 建 PR / 读 issue 全断 |
| 3 | `parseIssueUrl()` 正则 `^https://github\.com/` | 只认 github.com | `ingest-issue` 不吃 GHES issue URL |

## Requirements

- **R1 环境变量**：新增 `KEEL_GITHUB_API_ROOT`，缺省 `https://api.github.com`。
  显式设置时覆盖所有 host 的 API 根地址。
- **R2 URL 解析 host 感知**：支持
  - `https://<host>/owner/repo(.git)`
  - `http://<host>/owner/repo(.git)`（企业内网常见）
  - `git@<host>:owner/repo(.git)`
  - `ssh://git@<host>/owner/repo(.git)`

  host 限定 `github.com` 或 `github.*`（如 `github.example.com`、`github.corp.example`）。
  非 `github.*` 的企业域名（如 `ghe.corp.example`）不在本任务范围：
  放宽到任意 host 会让 GitLab 等地址被误当 GHES，需要单独的显式声明机制。
- **R3 `apiRootForHost(host)`**：`github.com` → `https://api.github.com`；
  其他 host → `https://<host>/api/v3`。作为未设环境变量时的缺省推导。
- **R4 API 路径不变**：GHES REST 与公网同形，`/repos/<slug>/...` 直接可用。
- **R5 owner/repo 校验**：按 GitHub 命名规则（字母、数字、`_`、`.`、`-`），
  拒绝空段、`..`、路径穿越；`.git` 后缀只剥离一次。
- **R6 向后兼容**：不设 `KEEL_GITHUB_API_ROOT` 时，github.com remote 的解析结果、
  请求 URL 与现状完全一致。
- **R7 `ingest-issue` 对 GHES URL 产出正确的 `remoteUrl`**，且 `register-repo` 能用同一 host 注册。

## Acceptance Criteria

- [ ] `KEEL_GITHUB_API_ROOT=https://github.example.com/api/v3` 时，
      `register-repo https://github.example.com/o/r` 成功。
- [ ] `ingest-issue https://github.example.com/o/r/issues/1` 解析成功（host 保留）。
- [ ] 不设环境变量时，github.com 的 `ownerRepo` / `parseIssueUrl` / API 请求 URL 与现状一致。
- [ ] `ownerRepo` / `parseIssueUrl` 各有 GHES host 用例；GitHubProvider stub server
      用例覆盖「按 host 推导 apiRoot」与「环境变量覆盖」两条路径。
- [ ] `pnpm run check` 全绿。

## Constraints

- token 纪律不变：只从环境读，不进 URL / argv / 事件 / 错误信息。
- 不引入新依赖。
- 解析函数保持 `Result<T>` 风格，错误用 `WORKSPACE_ERROR`（与现状一致）。

## Out of Scope

- GitLab / Bitbucket。
- 企业网关的凭据管理（token 仍由部署方注入环境变量）。
- `git-workspace.ts` 的传输认证（属于 §3 子任务）。
