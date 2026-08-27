# run-issue-e2e — 执行计划

依赖：`08-27-issue-intake` 已绿。父 implement.md Phase 2（步骤 5–7）。

## 步骤

1. `run-task.ts`：`--ci real` 接线 GitHubProvider；无 token 启动报错；补测试
2. 提取 ingest / run-task 共享主体；新增 `run-issue.ts`；注册 CLI + HELP + cli.test
3. `src/acceptance/issue-e2e.acceptance.test.ts` + README 说明
4. `pnpm run check` 全绿；有凭据时跑 `test:acceptance`

## 状态（2026-08-27）

- [x] 步骤 1–3 完成
- [x] `pnpm run check` 全绿（27 文件 / 285 通过 / 4 skipped）
- [x] opt-in 真实验收跑通两次（第二次仅 `issue-e2e`，580s）
- [ ] AC5：两次均停在 S-HUMAN_REVIEW —— 模型自报 `policy_facts` high/high 命中 P1，
      非代码缺陷；按诚实失败纪律记录于父 `prd.md` 验收记录，不放宽 Policy

禁止：git commit。完成后报告。
