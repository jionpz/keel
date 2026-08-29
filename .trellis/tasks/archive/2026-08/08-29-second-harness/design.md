# 第二个 AI Harness · 设计

## 边界

```
CLI (--harness / KEEL_HARNESS)
  → new OmpAdapter() | new ClaudeCodeAdapter()
  → runTaskToCompletion({ adapter })
Control / Fact 不变
```

今日缺口只在 **CLI 硬编码 OMP**（`run-task.ts`），不在 loop。Fact 无 harness 专用表；`run.harness_id` 已有。

## 输出契约（D2）

MVP 强制 `post_validate`：Control 的 Proposal 校验与 OMP 五连路径同构。
Claude 的 `--json-schema` 留到后续任务，用来测「有 STRUCTURED_OUTPUT 时降级矩阵少走哪几步」。

## 选择面（D3 草案）

| 优先级 | 来源 |
|---|---|
| 1 | CLI `--harness claude` |
| 2 | `KEEL_HARNESS` |
| 3 | 缺省 `omp` |

非法值：启动失败，不静默回退 omp。

## 验收

`src/acceptance/claude-code-e2e.acceptance.test.ts`（opt-in）。
`preflightClaude()`：`claude --version`；缺二进制/缺 key 时明确失败（对标 `preflightOmp`）。
