# 阶段二入口验证 · 执行计划

## 顺序（严格）

1. **Review 本 planning 产物** → 用户确认 → `task.py start 08-29-five-run-campaign`（先子后父）
2. `08-29-five-run-campaign` implement → check → archive
3. 若五连超时 ≥2 次：`task.py start 08-29-wallclock-adr`（可与 #2 分析并行）
4. 五连 ≥3/5 成功后：`task.py start 08-29-second-harness`
5. 父任务 AC1–AC4 核对 → archive 父任务
6. `08-29-ingress-poller`：仅当出现「人工 CLI ≥3 次/天」再 start

## 验证命令

```bash
pnpm run check                                    # 每次子任务改代码后
pnpm vitest run --config vitest.acceptance.config.ts src/acceptance/issue-e2e.acceptance.test.ts  # 单跑回归
# 五连 batch（子任务 A 交付物）
pnpm vitest run --config vitest.acceptance.config.ts src/acceptance/five-run.acceptance.test.ts   # 待实现
```

## Review Gates

| 阶段 | Gate |
|---|---|
| 五连 1/5 失败 | 记录 failure_class；Keel bug → 修后再跑；model → 记入 prd 不放宽 Policy |
| 五连 <3/5 | **不 start** second-harness |
| 五连 5/5 | 父 AC1 ✅，可并行墙钟 ADR |
| second-harness 验收 | opt-in，不进默认 check |

## Rollback

- 子任务 implement 偏离 → 回滚该子任务 branch，不影响已 archive 子任务
- 五连 batch 污染远端 → 沿用 `issue-e2e` cleanup（关 Issue/PR/删 ai/* 分支）
