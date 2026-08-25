# Round 2 P2 架构一致性组 — 执行计划

## 批次

### 批次 1 — R10(tierOf 单一事实源)+ R11(DDL 漂移)

1. `tier.ts`:tierOf 改用 TIER_REQUIREMENTS.every 推导。
2. `adapters.test.ts`:补最小性断言(L1 去 RESUME → L0)。
3. `artifact-store.test.ts`:补 run.stage ↔ STAGES、run.harness_tier ↔ HARNESS_TIERS。
4. `pnpm run check`;commit `(issue #23 R10 R11)`。

### 批次 2 — R6(死代码清理)+ 契约标注

1. `facts.ts`:
   - rfc_ready 分支去 pre_pr 共享;
   - 删 qa_failed 分支、post_develop 段、actualFilesChanged(若无人用);
   - 确认 failedCount/costSpent 仍被 capability_request 用。
2. `ruleset.ts` FACTS_AT:删 post_develop/qa_failed/pre_pr。
3. `policy-engine.md` §2.2:补「加载分支随规则删除」。
4. typecheck + policy/driver 测试;`pnpm run check`;commit `(issue #23 R6)`。

### 批次 3 — R12(check:generated 先红)+ R13(blob 边界)

1. `scripts/check-generated.sh`:生成前查手改(红)→ generate → 生成后查同步(红)。
2. `package.json` check:generated 指到脚本。
3. `blob.ts` + `fact/index.ts` 注释补边界。
4. 验证:故意改 src/generated 手改 → check:generated 红(证明生效后还原)。
5. `pnpm run check`;commit `(issue #23 R12 R13)`。

### 批次 4 — S1-S4(轻量)

S1 transition.test 补 human_review→T-013 用例;S2 ids.ts ROLES 注释;S3 check-purity GUARDED_DIRS 注释;S4 03-domain-model §6 措辞。
`pnpm run check`;commit `(issue #23 S1-S4)`。

### 批次 5 — 全量验证 + 收尾

1. `pnpm run check` 全绿。
2. issue #23 comment(架构组完成,Round 2 全清)。
3. 归档;journal + gbrain。

## 验证命令

```bash
pnpm run check
```

## 评审门

- R6 删 post_develop 后:policy.test 的 post_develop 用例(#1-09 改的「未接线→默认」)依赖引擎默认行为,不受 facts.ts 删除影响(它直接 evaluate 不 loadPolicyFacts)——确认。
- R12 脚本在 Windows 无 sh?项目 darwin/linux,OK。
- R10 的 TIER_REQUIREMENTS 导入 tier.ts:shared↔execution 依赖方向(execution→shared 允许)。

## 回滚

- 每批独立 commit;回滚 = revert 单 commit。
- R6 若 policy.test 崩:保留 post_develop 分支但加「不可达」标注。