# 接入自动化 Poller — 实施计划

> 前置：`11-03-ghes-host-support` 与 `11-03-git-transport-auth` 已合并。
> 2026-11-03 修订：新增仓库级 label 迁移与分页。

## 顺序

1. **迁移与注册入口**
   - [x] `migrations/1000000000006_repo_issue_label.sql`：加列 + 非空约束
   - [x] `register-repo --issue-label`：默认 `keel`、已存在时「不传保留 / 传了更新」
   - [x] 空白值写库前拒绝
   - [x] 测试：默认值 / 显式值 / 更新 / 空白拒绝

2. **Provider 列表能力**（在 GHES 的 `request(host, path)` 之上）
   - [x] `ListedIssue` / `IssueList` / `listOpenIssues(remoteUrl, label, opts)`
   - [x] 过滤 PR、`per_page=100` 分页、`maxPages` 触顶 `truncated`
   - [x] 按 `number` 同轮去重
   - [x] `issueUrlFor(parsed, number)` 纯函数
   - [x] stub server 测试（PR 过滤 / 两页 / 触顶 / label 编码）

3. **轮询核心**
   - [x] `src/ingress/poller.ts`：`PollerDeps`、`pollOnce`、`runPollerForever`
   - [x] 按 `repo.issue_label` 扫描；`listIssues(repo)` 读仓库自己的 label
   - [x] 终态判定复用 `TERMINAL_STATUSES`
   - [x] 单行 JSON 日志 + `redactSecrets`（来自 `src/fact/github-auth.ts`）
   - [x] SIGTERM/SIGINT 停止认领

4. **CLI 接入**
   - [x] `src/cli/poller.ts` 参数解析（无 `--label`；`--interval` 正整数校验）
   - [x] 复用 `parseCiMode` / `resolveHarness` / `resolveModelForHarness` / `parseWallClock`
   - [x] `src/cli/index.ts` 注册 `poller`
   - [x] README 增加部署与运行说明
   - [x] 帮助文本列出全部参数

5. **测试**
   - [x] 注入式单测：各仓库 label / 新 / 终态 / 非终态 / 失败隔离 / 信号
   - [x] `listOpenIssues` stub server 测试
   - [x] 现有 CLI 测试补 `poller` 路由断言（如已有 CLI 快照模式）

6. **验收**
   - [x] `pnpm run check`
   - [ ] 本地起 stub GitHub + 真库跑一轮，确认 task 创建与日志
   - [ ] 手工 `SIGTERM` 验证退出路径

## 验证记录

- `pnpm run check`：全绿（45 files / 629 passed / 5 existing skipped）。
- 定向：`src/ingress/poller.test.ts` 17、`src/cli/poller.test.ts` 12、
  `github-provider.test.ts` +9、`register-repo.test.ts` +7、`cli.test.ts` +3。
- 独立复核逐条核对 R1–R9，修掉 5 个真实缺陷（每个都有反例验证或实测）：
  1. `interruptibleSleep` 每轮在永不 settle 的 promise 上挂 `.then`，实测 707 个未结算订阅；
     改为 `StopToken` 订阅制，`listenerCount` 可观测且 50 轮后为 0。
  2. 两条 repo 行指向同一 remote 时同轮重复驱动；`pollOnce` 按 `external_ref` 轮内去重。
  3. 共享 `argv.ts` 的空白语义变化导致 `--default-branch '   '` 会把空白写进库；
     统一为「省略 → main，空白 / 只写标志 → 拒绝」，并修掉纯数字分支名被换成 main 的同类问题。
  4. `keel poller --label x` 曾被静默忽略；现在明确拒绝并指向 `repo.issue_label`。
  5. 日志里 `repo.remote_url` 若自带 userinfo 会绕过 `redactSecrets`；补 `stripUserinfo`。
- 迁移实测：`keel_test` 上 down/up 一轮，列与约束 `repo_issue_label_nonempty` 均正确还原。

## 验证命令

```bash
pnpm run check
pnpm vitest run src/cli/poller.test.ts src/fact/github-provider.test.ts
```

## 审阅门

- 不得在 poller 内重写 ingest / runTask。
- 不得引入 HTTP server 或并发队列。
- 终态集合必须来自 `src/shared/ids.ts`。
- label 只能从 `repo.issue_label` 读取，不得再设全局 `--label`。
- 日志不得包含 token、issue body。

## 回滚点

- 迁移是**可加列**：回滚代码后列可保留（默认值不影响旧逻辑）；
  需要彻底回滚时单独执行 down（删除列会丢失各仓库 label 配置）。
- Provider 能力可独立提交。
- CLI 子命令未注册前，轮询核心可独立测试；注册后可整体 revert。
