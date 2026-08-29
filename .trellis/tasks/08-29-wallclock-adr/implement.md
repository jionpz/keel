# R-009 墙钟语义 · 执行清单

1. [ ] 读五连 JSONL，统计 `failure_class=timeout` 次数
2. [ ] 若 ≥2：起草 `docs/adr/0008-wall-clock-semantics.md`
3. [ ] 评审选项 A/B/C（见 design.md）
4. [ ] 若改代码：反例测试 + issue-e2e 或五连单跑对比
5. [ ] `pnpm run check` → PR

未触发时可归档为「ADR Proposed + 观察」，不阻塞父任务。
