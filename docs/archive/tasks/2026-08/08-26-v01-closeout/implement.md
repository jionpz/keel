# Implement · v0.1 收口

## 执行顺序

1. **幂等重放单测**（确定性，先绿）—— `src/control/driver/effects.test.ts` 或新 e2e
2. **Human L0 e2e** —— `src/e2e/human-harness.test.ts`
3. **O4 timeline 脚本** —— `scripts/timeline.ts` + `package.json` `"timeline": "tsx scripts/timeline.ts"`
4. **合并验收** —— `src/acceptance/v01-criterion-github.acceptance.test.ts`
5. **文档同步** —— overview、docs README、过时注释、ADR status
6. **父任务集成复核** —— 更新 `08-23-v01-closed-loop/prd.md` checklist + 三问答案
7. **验证** —— `pnpm run check` 必须全绿；有凭据时 `pnpm run test:acceptance`（至少跑新文件若可能）

## 验证命令

```bash
pnpm run check
pnpm run timeline -- <uuid-from-e2e-test>
# 有凭据时：
KEEL_GITHUB_TOKEN="$(gh auth token)" KEEL_TEST_REMOTE_REPO=https://github.com/jionpz/keel pnpm run test:acceptance -- src/acceptance/v01-criterion-github.acceptance.test.ts
```

## 风险文件

| 文件 | 风险 |
|---|---|
| `v01-criterion-github.acceptance.test.ts` | 远程污染、超时、LLM 波动 |
| `08-23-v01-closed-loop/prd.md` | 勾选须与证据一致 |
| ADR status | 须与实现一致，不能为绿而绿 |

## 回滚

- 新 acceptance 文件可独立删除
- timeline 脚本可独立删除
- 文档改动可 revert 单文件

## 子代理纪律

- **禁止** `git commit` / `git push`
- 缺 GitHub 凭据时合并验收写代码但不强求本地跑通；check 必须绿
- 不实现 C-002
