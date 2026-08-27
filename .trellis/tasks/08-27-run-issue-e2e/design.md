# run-issue-e2e — 技术设计

与父任务 `design.md` §2.4（run-task 真实模式 / run-issue）及 §6 验收层一致。

## 改动面

1. `src/cli/run-task.ts`：`--ci real` → `new GitHubProvider()` 传 driver + loop
2. `src/cli/run-issue.ts`：组合 ingest-issue 主体 + run-task 主体；从事件读 pr_url
3. 提取共享主体（避免复制 ingest/run 逻辑）
4. `src/acceptance/issue-e2e.acceptance.test.ts`：opt-in，缺凭据明确失败

## 约束

- 缺省 `--ci` 仍为 `passed`（模拟），避免悄悄打真实 API
- 无 token + `--ci real` → 启动即 AUTH 报错，不进 loop
- 终态 S-HUMAN_REVIEW / S-REJECTED 退出码 0（编排如实完成）
