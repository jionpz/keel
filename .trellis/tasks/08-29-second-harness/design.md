# 第二个 AI Harness · 设计

## 边界

```
Control (orchestrator) ──RunSpec──▶ HarnessAdapter
                                      ├─ OmpAdapter (existing)
                                      └─ ClaudeCodeAdapter (new)
```

Fact Plane 无 harness 特定表；`run.harness_id` 已有。

## MVP 接口

参照 `src/execution/adapters/omp.ts` + `docs/05-contracts/harness-adapter.md`。

Claude Code 关键差异（待 research 确认）：
- `--bare` 等价 untrusted workspace
- 可能有 native structured output → v0.1 仍走 post_validate 保持一致

## Harness 选择（最小方案）

`KEEL_HARNESS=omp|claude` 环境变量，CLI 传入 `WorkflowDriver` deps。

## 验收

新文件 `src/acceptance/claude-code-e2e.acceptance.test.ts`（opt-in，复制 issue-e2e 结构）。
