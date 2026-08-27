# 执行计划

1. 读 `prompts.ts` / `prompts.test.ts`、父任务验收记录
2. 改 rfc_draft（必要时 pm）提示词；补确定性测试
3. （可选）rfc policy_facts 与反馈约束冲突时回灌
4. `pnpm run check`
5. 有凭据时：`pnpm vitest run --config vitest.acceptance.config.ts src/acceptance/issue-e2e.acceptance.test.ts`
6. 更新父 `prd.md` 验收表与 AC5 勾选

禁止：改 Policy 规则；git commit（由主会话提交）。
