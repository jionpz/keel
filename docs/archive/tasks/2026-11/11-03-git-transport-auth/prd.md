# git 传输认证

> 对应 GitHub issue [#70](https://github.com/jionpz/keel/issues/70) §3，父任务
> `11-03-enterprise-deployment`。依赖 GHES 子任务的 host 解析。

## Goal

`src/fact/git-workspace.ts` 的 clone / fetch / push 目前裸跑 `git`，私有仓库直接
`could not read Username` 失败。让它们在存在 `KEEL_GITHUB_TOKEN` / `GITHUB_TOKEN`
时能访问私有 https remote，同时保证 token 不进 remote URL、不进全局 git config、
不进错误信息。

## Requirements

- **R1 https 注入**：remote 是 `https:` 且有 token 时，clone / fetch / push 都携带
  `http.<scheme>://<host>/.extraheader`，值为 `AUTHORIZATION: basic <base64>`。
- **R2 ssh 不注入**：`git@host:owner/repo` / `ssh://` 一律走部署方 ssh key，
  代码不碰凭据。
- **R3 token 三条纪律**：
  - 不进 remote URL；
  - 不进全局 / 仓库级 git config（只对单次子进程生效）；
  - 不进错误 detail、事件 payload、日志。
- **R4 无 token 行为不变**：不设 token 时 argv / env / 结果与现状一致。
- **R5 host 解析单源**：只复用 GHES 子任务的 `parseRemoteUrl`，不写第二套正则。
- **R6 用户既有 git 配置不丢**：若环境中已有 `GIT_CONFIG_COUNT`，注入时追加而不是覆盖。

## Acceptance Criteria

- [x] 私有 https remote 在 `KEEL_GITHUB_TOKEN` 下 clone / fetch / push 成功
      （用本地 https 认证 stub 或注入式单测证明注入生效）。
- [x] ssh remote 不产生任何 extraheader。
- [x] 事件表 / 日志 / 错误 detail 中 grep 不到 token 或它的 base64。
- [x] `GIT_CONFIG_COUNT` 已存在时，原有配置项保留。
- [x] `pnpm run check` 全绿。

## 验收记录

- `pnpm run check` 全绿；注入生效、token 不进 argv、不进错误 detail 均有断言与反例验证。
- **未覆盖（如实记录）**：
  1. 无私有仓库凭据，未对真实私有 https 仓库跑 clone/fetch/push；AC 第 1 条由注入式单测证明。
  2. `push` 失败 detail 仍会原样带 `remoteUrl`；若注册 URL 自带 userinfo 会出现在 detail 里
     （环境 token 不受影响）。这是接入认证前就有的行为，未在本任务改动。
  3. REST 侧非默认端口仍需 `KEEL_GITHUB_API_ROOT` 覆盖；本任务只让 git 传输认证支持端口。

## Constraints

- 不引入新依赖。
- 不改动 `commitAll` 的身份/签名钉死逻辑（见 `spec/backend/git-workspace.md`）。
- 认证失败仍映射为 `WORKSPACE_ERROR`（现状），不新增 ErrorKind。

## Out of Scope

- ssh key 管理、credential helper 配置。
- GitHub App / installation token 的自动刷新。
- CI 侧（GitHubProvider）的认证 —— 已由 `KEEL_GITHUB_TOKEN` 覆盖。
