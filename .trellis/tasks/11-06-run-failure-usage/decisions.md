# 决策记录（追加）

## 2026-11-06 · 审查补强（trellis-check）

- **pipeline 通用失败分支必须单独锚定**：用例 F 走的是 `RUN_STALLED` 分支，
  覆盖不到通用失败返回。改用例 C（CANCELLED，supervisor 为 null）带 usage，
  并把 pipeline 的 `spent` 回退验证为两条都红。
- **claude `assistant.usage` 可能是可 JSON 的 `null`**：`null !== undefined`，
  入 Map 后在求和时 TypeError。加 `typeof === 'object' && !== null` 防护
  —— CLI 输出不可信，不能把「应返回 TIMEOUT」变成异常。
- **result 存在但用量全空时回退 partialUsage**：避免丢掉已见到的 assistant 用量；
  仅当 `tokens_in` / `tokens_out` / `cost_usd` 三项全 null 时才回退（无重复计数风险）。
- **`vitest.shared.ts` 排除 `.claude/worktrees/**`**：与本任务无关的既有隐患
  （worktree 在仓库内会让 check 跑另一分支的测试），按审查建议**单独提交**。
