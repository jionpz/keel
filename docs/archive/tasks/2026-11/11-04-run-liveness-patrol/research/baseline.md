# 基线记录（2026-11-05）

## 环境

- 工作目录：`/Users/jionpz/mycode/keel`
- 分支：`main`
- Postgres：本地运行，测试库 `keel_test`
- OMP：`/Users/jionpz/.bun/bin/omp` v18.11.1

## 命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm run typecheck` | 绿 |
| `pnpm vitest run src/execution/adapters/adapters.test.ts` | 33 passed / 4 skipped |
| `pnpm vitest run src/timer/worker.test.ts src/e2e/timer-worker.test.ts` | 7 passed |
| `pnpm vitest run src/e2e/session-pipeline.test.ts` | 18 passed |
| `DATABASE_URL=postgres://localhost/keel_test pnpm run db:reset` | 绿，7 个迁移全部重建 |
| `pnpm run test:acceptance` | 红，见下 |

## 既有红点（不在本任务顺手修）

`pnpm run test:acceptance` 需要真实环境，当前不可用：

- `v01-criterion-github.acceptance.test.ts` 缺 `KEEL_TEST_REMOTE_REPO`。
- `session-milestone.acceptance.test.ts` 的 OMP 调用退出码 1；与本轮环境探测一致。
- `v01-criterion.acceptance.test.ts` 走到 `S-HUMAN_REVIEW` 而非 `S-DONE`。

注意：`pnpm vitest run src/acceptance/...` 会被默认配置排除（`**/*.acceptance.test.ts`），必须用 `pnpm run test:acceptance`。

## OMP 环境探测

1. **stdin 必须关闭**：直接运行 `omp ... < /dev/null` 才能启动；stdin 保持打开时，OMP 卡在
   `Still starting ... phase: readPipedInput`，即使 `--max-time` 也不会结束。
   这与 `src/execution/adapters/omp.ts` 的 `stdio: ['ignore','pipe','pipe']` 一致。
2. **默认模型不可用**：`deepseek-v4-flash` 经 `zen` provider 返回
   `400 MissingSessionID`。
3. **magpie 默认模型配额耗尽**：`magpie/auto/deepseek-v4.1-flash:high` 返回
   `429 OpenCode Zen Free: Free usage limit reached`。
4. **可用模型**：`magpie/workbuddy-ai/hy3` 能正常完成一次 `-p --mode=json` 调用。

## 对后续步骤的影响

- Phase 0 spike 用 `magpie/workbuddy-ai/hy3`，并在结论里注明这是环境选择，不是代码默认值。
- `DEFAULT_OMP_MODEL = 'deepseek-v4-flash'` 在本环境不可用；本任务不改默认值，验收时需用
  `--model` / `KEEL_MODEL` 覆盖。
- 验收/真机冒烟不能依赖 `pnpm run test:acceptance` 全绿；需要单独记录环境前提。
