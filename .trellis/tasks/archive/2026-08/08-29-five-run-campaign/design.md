# 五连稳定性战役 · 设计

## 文件布局

```
src/acceptance/five-run.acceptance.test.ts   # opt-in batch
.trellis/tasks/08-29-five-run-campaign/research/
  five-run-results.jsonl                       # 运行产出
  issue-templates.md                           # 5 个 Issue 正文变体
```

## 复用

| 模块 | 用途 |
|---|---|
| `src/acceptance/preflight.ts` | beforeEach |
| `src/acceptance/issue-e2e.acceptance.test.ts` | gh()、cleanup、AC5-3b 断言模式 |
| `src/cli/run-issue.ts` | 驱动 |

## Batch 流程

```
for run in 1..5:
  registerRepo (once)
  createLabeledIssue(template[run])
  result = runIssue({ ci: 'real', wallClockS: 600 })
  verify transitions + ci_verified
  append JSONL
  cleanup
assert all final_status == S-DONE
```

## 超时

单 run timeout：30min（与 issue-e2e 一致）；整 batch：2.5h vitest timeout。

## 失败早停策略

**不早停** —— 5 次全跑完再汇总，便于统计 failure_class 分布（roadmap 要的是连续 5 成功，但诊断需要全量数据）。

若单次 infra 失败（preflight 红），立即停止 batch（不是 model/policy 问题）。
