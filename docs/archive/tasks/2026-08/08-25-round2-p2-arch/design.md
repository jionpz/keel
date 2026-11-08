# Round 2 P2 架构一致性组 — 技术设计

## 目标

消除双事实源 / 死代码 / 检查语义失实 / 文档滞后。原则:**单一事实源、只留已接线代码、检查先红不静默、文档说真话**。

## R10 · tierOf 以 TIER_REQUIREMENTS 为数据源

**现状**:tierOf 内联阶梯(has RESUME/STREAM/COST),TIER_REQUIREMENTS 是声明表,互证单边。
**修**:

```ts
import type { CapabilityId, HarnessTier } from '../../shared/ids.js'
import { TIER_REQUIREMENTS } from '../../shared/ids.js'

export function tierOf(caps: readonly CapabilityId[]): HarnessTier {
  const has = (c: CapabilityId): boolean => caps.includes(c)
  if (!has('CAP-HEADLESS')) {
    throw new Error('CAP-HEADLESS 是最低门槛，不具备则无法接入')
  }
  if (TIER_REQUIREMENTS.L2.every(has)) return 'L2'
  if (TIER_REQUIREMENTS.L1.every(has)) return 'L1'
  return 'L0'
}
```

- 阶梯内容唯一来源 = `TIER_REQUIREMENTS`(ids.ts);tier.ts 只做「满足哪档」判断。
- harness-adapter.md §1.2 仍是文档(对人),代码侧双源消除。
- **语义等值验证**:L2=[H,R,STREAM,COST] every → L2;L1=[H,R] → L1;H-only → L0。与旧逻辑一致。

**回归**(adapters.test.ts):
- 已有:OMP→L2、Human→L0、去 COST→L1、缺 STRUCTURED_OUTPUT 不影响。
- 补最小性:L1 要求去 RESUME(`TIER_REQUIREMENTS.L1` 过滤掉 RESUME)→ 应 L0(表与推导互证反方向)。

## R6 · loadPolicyFacts 只留已接线判定点

**现状**:`facts.ts` 支持 rfc_ready(pre_pr 共享)/ qa_failed / capability_request / post_develop;规则集只接 rfc_ready/capability_request。
**修**:
- `if (point === 'rfc_ready' || point === 'pre_pr')` → `if (point === 'rfc_ready')`;删 pre_pr 的 `return {...base, dev_attempts, tests_failed, cost_spent_usd}`(pre_pr 特有)。
- 删 `qa_failed` 分支(never evaluated)。
- 删 `post_develop` 段(含 actualFilesChanged + files_drift_ratio)。
- 检查 unused:failedCount/costSpent 仍被 capability_request 用(dev_attempts/cost_spent_usd);去掉 post_develop 后 actualFilesChanged 若无人用则删。
- `ruleset.ts` FACTS_AT:删 post_develop / qa_failed / pre_pr 条目(无规则无求值入口)。
- `policy-engine.md` §2.2:P-DRIFT 标注补「实现侧加载分支随规则删除,设计意图保留」。

**注意**:pre_pr 是 rfc_ready 的上游版本(PR 前重估)——删除后若未来接 pre_pr 需重写加载。契约已标注,可接受。

## R11 · DDL 漂移补 run.stage / harness_tier

artifact-store.test.ts 漂移块加:

```ts
it('run.stage 的 CHECK 取值与 STAGES 一致', async () => {
  const dbValues = await checkValues('run', 'stage')
  expect(dbValues).toEqual([...STAGES].sort())
  expect(dbValues).toHaveLength(7)
})
it('run.harness_tier 的 CHECK 取值与 HARNESS_TIERS 一致', async () => {
  const dbValues = await checkValues('run', 'harness_tier')
  expect(dbValues).toEqual([...HARNESS_TIERS].sort())
  expect(dbValues).toHaveLength(3)
})
```

import STAGES/HARNESS_TIERS from shared/ids。

## R12 · check:generated 先红防手改

**现状**:`generate && git diff --exit-code HEAD -- src/generated`——generate 先抹手改。
**修**(package.json inline 或脚本):

```sh
# 1. 先查工作树手改(生成前):有手改 → 红
git diff --exit-code HEAD -- src/generated \
  || { echo "✗ src/generated 有手改(会被重生成覆盖)"; exit 1; }
# 2. 重生成
pnpm run generate
# 3. 生成后查(schema 变更未提交产物 → 红)
git diff --exit-code HEAD -- src/generated \
  || { echo "✗ schema 变更未提交生成产物,请提交"; exit 1; }
```

写 `scripts/check-generated.sh`(可执行),package.json `"check:generated": "sh scripts/check-generated.sh"`。

**语义**:手改检测 = 先红(提醒,不静默丢弃);同步检测 = 生成后红(防 schema/产物漂移)。

## R13 · blob 边界文档真相化

- `blob.ts` 头注补:blob 是进程文件系统(内容寻址),不经 DB 角色授权(SET ROLE 之外);I5 的强制边界是 DB 平面,blob 引用完整性由 DB 授权保证,blob 本体由进程文件权限保护。
- `fact/index.ts` 补:blob 存储不经 DB 授权(见 blob.ts)。

## S1-S4(轻量文档/测试加固)

- **S1**:transition.test 补一例——`human_review`(显式裁决非 auto_develop)也走 T-013(与 security_review 同路径),钉住「非 auto_develop 一律人工」的文档语义。
- **S2**:ids.ts ROLES 注释标注「约定,run.role 不设 CHECK 是有意的(描述性字段)」。
- **S3**:check-purity.ts GUARDED_DIRS 注释注明「新增受纯目录需同步 .dependency-cruiser.cjs」。
- **S4**:03-domain-model.md §6「blob 表」→「本地文件系统 blob 存储(ADR-0004)」。

## 不做

- 不加 DB migration(S2 用文档)。
- 不改 ADR-0005 阶梯内容。
- 不实现 pre_pr/post_develop 的接入(契约标注设计意图)。
- 不重构 purity/dep-cruiser 共享配置(S3 文档)。