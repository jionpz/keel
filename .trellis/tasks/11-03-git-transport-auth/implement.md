# git 传输认证 — 实施计划

## 顺序

1. **凭据纯逻辑**
   - [ ] 新建 `src/fact/github-auth.ts`：`readTokenFromEnv`、`authEnvFor`、`redactSecrets`
   - [ ] `github-provider.ts` 改为 import + re-export `readTokenFromEnv`
   - [ ] 单测：https/ssh/无 token/既有 `GIT_CONFIG_COUNT` 合并

2. **接入 GitWorkspace**
   - [ ] `GitWorkspaceOptions.exec` 注入点
   - [ ] `ensureGitDir` / `syncBase` / `push` 走统一 `execGit(args, { auth: remoteUrl })`
   - [ ] `syncBase` 补 `remoteUrl` 参数并由 `prepareProject` 透传
   - [ ] 所有错误出口过 `redactSecrets`

3. **测试**
   - [ ] 注入式断言：三个网络调用的 env 含 header，argv 不含 token
   - [ ] `commitAll` / `ensureWorktree` 不注入
   - [ ] 现有 `git-workspace.test.ts` 真实 git 用例全绿

4. **验收**
   - [ ] `pnpm run check`
   - [ ] grep 代码与测试产物，确认无 token 字面量
   - [ ] （可选，有凭据时）对私有 https 仓库手工跑 clone/fetch/push

## 验证命令

```bash
pnpm run check
pnpm vitest run src/fact/git-workspace.test.ts src/fact/github-auth.test.ts
```

## 审阅门

- 只允许一个 host 解析实现（复用 `parseRemoteUrl`）。
- 不允许把 token 作为 `-c` 参数或 URL userinfo 传。
- 错误清洗必须覆盖 clone/fetch/push 三个出口。

## 回滚点

- 第 1 步纯新增模块，可独立提交。
- 第 2 步接入后可整体 revert；无数据库变更。
