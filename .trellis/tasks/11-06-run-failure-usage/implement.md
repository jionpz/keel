# 执行计划 · 失败与超时 run 入账 token 消耗

> 设计见 `design.md`。按顺序执行；每步有独立验证点。

## 1. 契约层

- [x] `src/contracts/errors.ts`：新增 `ResultWithUsage<T>`（`import type { Usage }`）
- [x] `src/contracts/types.ts`：新增 `ZERO_USAGE`（从 `pipeline.ts` 上移的唯一定义）
- [x] `src/contracts/session-manager.ts`：`advance` 返回 `Promise<ResultWithUsage<TurnOutcome>>`
- [x] `src/control/proposal/pipeline.ts`：改为 re-export `ZERO_USAGE`
- 验证：`pnpm run typecheck`（此时 manager 尚未改，应报类型错 —— 记录预期错误）

## 2. SessionManager

- [x] `src/execution/session/manager.ts`：非 SUCCEEDED 分支返回 `{ok:false, error, usage: res.value.usage}`；
  其余错误路径带 `ZERO_USAGE`
- [x] `src/execution/session/manager.test.ts`：fake adapter 支持注入 usage；新增「TIMEOUT 失败分支带 usage」
- 验证：`pnpm vitest run src/execution/session/manager.test.ts`

## 3. omp Adapter

- [x] `src/execution/adapters/omp.ts`：abort 分支 usage 改为 `parser.end().usage`
- [x] `src/execution/adapters/adapters.test.ts`：新增中断前已出现 usage 的用例 + 未出现 usage 保持 null
- 验证：`pnpm vitest run src/execution/adapters/adapters.test.ts`

## 4. claude 解析器与 Adapter

- [x] `src/execution/adapters/claude-code-parse.ts`：新增 `partialUsage`（按 message.id 去重求和）
- [x] `src/execution/adapters/claude-code.ts`：abort 分支用 result 聚合并集或 partialUsage
- [x] `src/execution/adapters/claude-code.test.ts`：解析器去重求和；abort 两条路径（有 / 无 result）
- 验证：`pnpm vitest run src/execution/adapters/claude-code.test.ts`

## 5. Pipeline 累加

- [x] `src/control/proposal/pipeline.ts`：两条失败返回都 `addUsage(usage, turn.usage)`
- [x] `src/control/orchestrator/run-failure.test.ts`：用例 F（stalled→TIMEOUT）让 fake adapter 上报 usage，
  断言 run 行 `tokens_in` / `tokens_out` 非空
- 验证：`pnpm vitest run src/control/orchestrator/run-failure.test.ts`

## 6. 反例验证（先红后绿）

- [x] 回退 manager 的 usage 传递 → manager 测试红
- [x] 回退 omp abort 的 parser usage → omp 测试红
- [x] 回退 claude 的 partialUsage → claude 测试红
- [x] 回退 pipeline 的 addUsage → run-failure 用例 F 红
- [x] 全部恢复后 `pnpm run check`

## 7. 文档与收尾

- [x] `docs/05-contracts/session-manager.md`：`advance()` 失败分支带 usage
- [x] `docs/05-contracts/harness-adapter.md`：`awaitResult()` 非 SUCCEEDED 的 usage 语义
- [x] `.trellis/spec/backend/harness-adapter.md`：adapter 上报纪律（见过就报，没见就 null）
- [x] `pnpm run check` 全绿后提交；Trellis 归档；journal / gbrain state 更新

## 校验命令

```bash
pnpm run typecheck
pnpm vitest run src/execution/session/manager.test.ts src/execution/adapters
pnpm vitest run src/control/orchestrator/run-failure.test.ts
pnpm run check
```

## 回滚点

- 第 1 步后：契约编译未通过，直接 revert 本次改动即可。
- 第 5 步后：功能完整；单个 `git revert` 回到改动前，无 DB 迁移需要撤销。
