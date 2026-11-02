# 接入自动化 Poller — 实施计划

## 顺序

1. **Provider 列表能力**
   - [ ] `ListedIssue` + `GitHubProvider.listOpenIssues(remoteUrl, label)`
   - [ ] 过滤 PR、单页 100、复用 host 解析
   - [ ] stub server 单测

2. **轮询核心**
   - [ ] `poller-core.ts`：`PollerDeps`、`pollOnce`、`runPollerForever`
   - [ ] 终态判定复用 `TERMINAL_STATUSES`
   - [ ] 单行 JSON 日志 + `redactSecrets`
   - [ ] SIGTERM/SIGINT 停止认领

3. **CLI 接入**
   - [ ] `src/cli/poller.ts` 参数解析（复用 run-issue 的解析函数）
   - [ ] `src/cli/index.ts` 注册 `poller`
   - [ ] README 增加部署与运行说明
   - [ ] 帮助文本列出全部参数

4. **测试**
   - [ ] 注入式单测：新/终态/非终态/失败隔离/信号
   - [ ] `listOpenIssues` stub server 测试
   - [ ] 现有 CLI 测试补 `poller` 路由断言（如已有 CLI 快照模式）

5. **验收**
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
- 日志不得包含 token、issue body。

## 回滚点

- Provider 能力可独立提交。
- CLI 子命令未注册前，轮询核心可独立测试；注册后可整体 revert。
- 无数据库迁移。
