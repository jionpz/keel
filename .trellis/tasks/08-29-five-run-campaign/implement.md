# 五连稳定性战役 · 执行清单

- [ ] 1. 写 `research/issue-templates.md`（5 变体）
- [ ] 2. 实现 `five-run.acceptance.test.ts`（从 issue-e2e 提取共享 helper 若重复 >30 行）
- [ ] 3. 本地单跑 run 1 验证（`vitest run ...five-run... -t "run 1"` 若拆分）
- [ ] 4. 全量 5 连（需 OPENCODE + PAT，~15–25min）
- [ ] 5. 结果写入 JSONL + 更新本 prd AC 勾选
- [ ] 6. `pnpm run check`
- [ ] 7. commit + PR

## 环境

```bash
export PATH="$HOME/.local/bin:$PATH"
export KEEL_TEST_REMOTE_REPO=https://github.com/jionpz/keel
# KEEL_GITHUB_TOKEN, OPENCODE_API_KEY 已在 Secret
pnpm vitest run --config vitest.acceptance.config.ts src/acceptance/five-run.acceptance.test.ts
```
