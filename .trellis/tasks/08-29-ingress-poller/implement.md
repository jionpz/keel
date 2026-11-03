# 接入自动化 Poller — 实施计划

> 前置：`11-03-ghes-host-support` 与 `11-03-git-transport-auth` 已合并。
> 2026-11-03 修订：新增仓库级 label 迁移与分页。

## 顺序

1. **迁移与注册入口**
   - [ ] `migrations/1000000000006_repo_issue_label.sql`：加列 + 非空约束
   - [ ] `register-repo --issue-label`：默认 `keel`、已存在时「不传保留 / 传了更新」
   - [ ] 空白值写库前拒绝
   - [ ] 测试：默认值 / 显式值 / 更新 / 空白拒绝

2. **Provider 列表能力**（在 GHES 的 `request(host, path)` 之上）
   - [ ] `ListedIssue` / `IssueList` / `listOpenIssues(remoteUrl, label, opts)`
   - [ ] 过滤 PR、`per_page=100` 分页、`maxPages` 触顶 `truncated`
   - [ ] 按 `number` 同轮去重
   - [ ] `issueUrlFor(parsed, number)` 纯函数
   - [ ] stub server 测试（PR 过滤 / 两页 / 触顶 / label 编码）

3. **轮询核心**
   - [ ] `src/ingress/poller.ts`：`PollerDeps`、`pollOnce`、`runPollerForever`
   - [ ] 按 `repo.issue_label` 扫描；`listIssues(repo)` 读仓库自己的 label
   - [ ] 终态判定复用 `TERMINAL_STATUSES`
   - [ ] 单行 JSON 日志 + `redactSecrets`（来自 `src/fact/github-auth.ts`）
   - [ ] SIGTERM/SIGINT 停止认领

4. **CLI 接入**
   - [ ] `src/cli/poller.ts` 参数解析（无 `--label`；`--interval` 正整数校验）
   - [ ] 复用 `parseCiMode` / `resolveHarness` / `resolveModelForHarness` / `parseWallClock`
   - [ ] `src/cli/index.ts` 注册 `poller`
   - [ ] README 增加部署与运行说明
   - [ ] 帮助文本列出全部参数

5. **测试**
   - [ ] 注入式单测：各仓库 label / 新 / 终态 / 非终态 / 失败隔离 / 信号
   - [ ] `listOpenIssues` stub server 测试
   - [ ] 现有 CLI 测试补 `poller` 路由断言（如已有 CLI 快照模式）

6. **验收**
   - [ ] `pnpm run check`
   - [ ] 本地起 stub GitHub + 真库跑一轮，确认 task 创建与日志
   - [ ] 手工 `SIGTERM` 验证退出路径

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
