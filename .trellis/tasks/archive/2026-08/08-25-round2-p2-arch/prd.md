# Round 2 P2 架构一致性组

## Goal

消除 issue #23 剩余架构一致性缺陷:双事实源、死代码、检查语义失实、文档滞后。全部是「结构/一致性」问题,多数轻量。

## Requirements

### R10 · TIER_REQUIREMENTS ↔ tierOf 双事实源

**现状**:`tierOf`(`tier.ts`)内联重实现阶梯;`TIER_REQUIREMENTS`(`ids.ts`)是声明表;`harness-adapter.md` §1.2 是第三份。互证测试单边(只证「表能推出档」,不证「档的要求恰好是表」)。
**修**:`tierOf` 以 `TIER_REQUIREMENTS` 为数据源(消除实现侧派生逻辑):
```ts
export function tierOf(caps: readonly CapabilityId[]): HarnessTier {
  const has = (c) => caps.includes(c)
  if (!has('CAP-HEADLESS')) throw ...
  // 从声明表推导:满足 L2 要求 → L2;满足 L1 → L1;否则 L0
  if (TIER_REQUIREMENTS.L2.every(has)) return 'L2'
  if (TIER_REQUIREMENTS.L1.every(has)) return 'L1'
  return 'L0'
}
```
- 单一事实源:Tier 要求只在 `TIER_REQUIREMENTS` 声明。
- 回归:互证测试补**最小性断言**(去掉任一必需能力必降档)——L2 去 STREAM/COST 降 L1 已有;补 L1 去 RESUME 降 L0。

### R6 · loadPolicyFacts 死代码分支

**现状**:`facts.ts` 的 post_develop/qa_failed/pre_pr 分支(含 actualFilesChanged+files_drift_ratio)不可达——规则集只接 rfc_ready/capability_request,EvaluatePolicy 只挂 T-009/T-011;且注释称 actual 来自 WorkspaceDiff,实际读 stage_outcome.details.files_changed(源不符)。
**修**:
- `loadPolicyFacts` 只保留已接线判定点:rfc_ready / capability_request;删 post_develop / qa_failed / pre_pr 分支与 actualFilesChanged / failedCount / costSpent 的未用部分。
- `FACTS_AT` 同步删未接线点(post_develop/qa_failed/pre_pr)——它们没有求值入口。
- 契约 `policy-engine.md` §2.2 的 P-DRIFT 标注已保留(设计意图),补一句「实现侧加载分支随规则删除」。

### R11 · DDL 漂移测试补 run.stage / harness_tier

**现状**:`artifact-store.test.ts` 漂移块只测 task.status/artifact.kind/task.control_mode/run.status。
**修**:补 `checkValues('run','stage')` ↔ STAGES(长度 7)、`checkValues('run','harness_tier')` ↔ HARNESS_TIERS(长度 3)。

### R12 · check:generated 语义(检测手改 vs 静默覆盖)

**现状**:`check:generated = generate && git diff --exit-code HEAD -- src/generated`——generate 先重写(src/generated 手改被就地抹掉),随后 diff 恒空;唯一失败模式是 schema 变了没提交产物。
**修**:生成**前**先查手改,生成后查同步:
```
( git diff --exit-code HEAD -- src/generated || echo "✗ src/generated 有手改 —— schema 从此不可信" ; exit 1 )
pnpm run generate
git diff --exit-code HEAD -- src/generated || ( echo "✗ schema 变更未提交生成产物" ; exit 1 )
```
- 手改不再被静默抹掉(先红);schema 变更未提交仍红。
- 包到一个小脚本 `scripts/check-generated.sh` 或 package.json inline。

### R13 · blob 存储边界文档真相化

**现状**:blob 是进程内文件系统,不经 DB 角色(SET ROLE 之外);但 fact/index.ts 的「仅 Control 写」表述覆盖 blob。
**修**:`blob.ts` 注释 + `fact/index.ts` 注明:**blob 是进程存储(对象存储语义),不经 DB 授权;I5 的强制边界是 DB 平面,blob 依赖进程文件权限;artifact 表只存引用,引用本身的完整性由 DB 授权保证**。

### S1 · guardText 后向空转(加固)

C4 只前向(文档↔guardText 串),不解析 guard 函数。补:transition.test 对高危守卫(T-013 含逻辑非)加「guardText 与 guard 语义一致」探针——构造使 guardText 断言意义相反的用例,断言按 guard 实际走(已有 security_review→T-013;补:human_review 也走 T-013 的说明性断言)。

### S2 · run.role 无 CHECK

`run.role` 是自由文本(text NOT NULL 无 CHECK)。改 DB 代价高(migration)+ 无实益;**文档明示**:`ids.ts` ROLES 是约定(代码内 roleFor 保证),run.role 不设 CHECK 是有意(描述性字段)。

### S3 · purity GUARDED_DIRS 双清单

脚本与 dep-cruiser 各自声明同一组纯目录。重构共享配置收益低;**文档注明**:新增受纯检查目录需同步两处(check-purity.ts + .dependency-cruiser.cjs)。

### S4 · docs §6「blob 表」

`03-domain-model.md` §6 措辞「blob 表」改「本地文件系统 blob 存储」(ADR-0004 定案)。

## Acceptance Criteria

- [ ] R10:tierOf 从 TIER_REQUIREMENTS 派生;最小性断言(L1 去 RESUME 降 L0)通过
- [ ] R6:loadPolicyFacts 仅 rfc_ready/capability_request;FACTS_AT 同步;契约标注
- [ ] R11:run.stage/harness_tier 漂移测试通过
- [ ] R12:手改 src/generated 时 check:generated 先红(不再静默覆盖)
- [ ] R13/S1-S4:文档真相化完成
- [ ] `pnpm run check` 全绿

## Constraints

- R10 不改 ADR-0005 语义(阶梯内容不变,只变数据来源)。
- R6 删分支不删契约设计意图(P-DRIFT 标注保留)。
- R12 手改检测用「先红」而非「自动修」——失败是提醒,不静默丢弃。
- 不加 migration(R2 不改 DB);S2 用文档。

## Notes

- 复杂任务:design.md + implement.md 后 start。
- R6 的 pre_pr 与 rfc_ready 共享加载——删除 pre_pr 只影响分支条件,不影响 rfc_ready 路径。