# 接入自动化 Poller · 执行清单

**Gate**：父任务 prd 触发条件满足后再 `task.py start`。

1. [ ] `src/cli/poller.ts` + 注册到 index
2. [ ] 集成测试（mock gh / stub ingest）
3. [ ] 文档 `docs/` 或 README 一节
4. [ ] 手动 1h soaks test 记录到 prd
5. [ ] `pnpm run check` → PR
