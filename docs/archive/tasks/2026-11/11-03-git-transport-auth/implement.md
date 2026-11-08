# git 传输认证 — 实施计划

## 顺序

1. **凭据纯逻辑**
   - [x] 新建 `src/fact/github-auth.ts`：`readTokenFromEnv`、`authEnvFor`、`redactSecrets`
   - [x] `github-provider.ts` 改为 import + re-export `readTokenFromEnv`
   - [x] 单测：https/ssh/无 token/既有 `GIT_CONFIG_COUNT` 合并

2. **接入 GitWorkspace**
   - [x] `GitWorkspaceOptions.exec` 注入点
   - [x] `ensureGitDir` / `syncBase` / `push` 走统一 `execGit(args, { auth: remoteUrl })`
   - [x] `syncBase` 补 `remoteUrl` 参数并由 `prepareProject` 透传
   - [x] 所有错误出口过 `redactSecrets`

3. **测试**
   - [x] 注入式断言：三个网络调用的 env 含 header，argv 不含 token
   - [x] `commitAll` / `ensureWorktree` 不注入
   - [x] 现有 `git-workspace.test.ts` 真实 git 用例全绿

4. **验收**
   - [x] `pnpm run check`
   - [x] grep 代码与测试产物，确认无 token 字面量
   - [x] （可选，有凭据时）对私有 https 仓库手工跑 clone/fetch/push

## 验证记录

- `pnpm run check`：全绿（43 files / 578 passed / 5 既有 skipped）。
- 定向：`github-auth.test.ts` 15、`git-workspace.test.ts` 33、`github-provider.test.ts` 55。
- 独立复核（`trellis-check`）逐条核对 R1–R6 通过，并补了 3 个安全回归断言
  （每个都做过反例验证：改坏实现 → 变红 → 恢复 → 绿）：
  1. 无 token 时 https remote 不传 env（opts 为 `undefined`，不是空 env）；
  2. 既有 `GIT_CONFIG_KEY_0` 随注入原样保留，认证项追加为第 1 项；
  3. fetch 失败 stderr 里的明文 token 与 base64 被脱敏。
- 复核发现并修复的真实缺口：extraheader 的 key 原先只用 hostname，
  GHES 跑在非默认端口（如 `:8443`）时 git 的 URL 匹配不到，认证静默失效。
  改为取 `new URL(remoteUrl).host`（保留非默认端口、省掉 443/80），补 2 个用例。

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
