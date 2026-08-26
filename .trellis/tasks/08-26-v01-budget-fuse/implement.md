# Implement · 预算熔断与 trace_id

## 顺序

1. 扩展 pipeline/manager 暴露 `usage` 给 `executeRun`
2. `executeRun` 写回 run 成本字段
3. `loadTraceId` + TaskCreated 生成 trace_id（effects CreateTask 路径）
4. `emit()` / appendEvent 贯穿 trace_id
5. `checkBudgetFuse` + 编排循环 paused 停止
6. 确定性测试
7. 更新父任务 prd C1–C3/O2 勾选
8. `pnpm run check`

## 验证

```bash
GIT_CONFIG_GLOBAL=/dev/null pnpm run check
```

## 纪律

- 禁止 git commit
- 不实现 N2–N4
