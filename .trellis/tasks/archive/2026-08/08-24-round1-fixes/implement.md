# Round 1 组件专家审查修复 — 执行计划

## 执行顺序与批次

P1 每项单 PR、可独立 merge;P2 收尾批次。先 #1-01(最小、零风险,立即释放 Policy 决策权)。

### 批次 1 — #1-01(单文件,先行)

1. `src/control/orchestrator/prompts.ts:64` 删写死行,形状示例只留 `policy_facts` 键结构、中性占位。
2. `src/control/orchestrator/prompts.test.ts`:新增回归——输出不含 `low`/`false`/`1` 连写固定取值,仍含 `policy_facts` 键。
3. 验证:`pnpm run check`。
4. Commit footer:`(issue #21 #1-01)`。

### 批次 2 — #1-03 + #1-04(同批,共享 manager/loop 回归)

1. `src/execution/session/manager.ts:98-99`:status→ErrorKind 映射(FAILED→PROTOCOL_ERROR / TIMEOUT→RUN_TIMEOUT / CANCELLED→RUN_CANCELLED),映射函数局部化。
2. `src/control/orchestrator/loop.ts`:
   - `readPendingRun` SELECT 加 `attempt`;
   - `executeRun` 用 `pending.attempt` 填 run.attempt 与 idempotency_key(`${taskId}/${stage}/${attempt}`);
   - `ended_at` 用 `deps.now()`。
3. 回归:`manager.test.ts`(CANCELLED→RUN_CANCELLED 且 retryable=false;TIMEOUT→RUN_TIMEOUT);`ci-wiring.test.ts`(第二次 develop attempt=2、key 以 /2 结尾);编排测试 ended_at=注入 now。
4. `pnpm run check`。
5. Commit footer:`(issue #21 #1-03 #1-04)`。

### 批次 3 — #1-05(独立)

1. `RunState.proc` 字段;`exec()` 存入;`interrupt()` aborted + `proc.kill('SIGTERM')`;结束清空。
2. `src/execution/adapters/adapters.test.ts`:注入挂起 spawn fixture,interrupt → fake proc 收 kill,awaitResult 返 CANCELLED。
3. `pnpm run check`。
4. Commit footer:`(issue #21 #1-05)`。

### 批次 4 — #1-06(独立,抽共享)

1. 抽 `src/execution/adapters/git-diff.ts`(从 omp.ts collectChanges 提取,execFileSync + workspace.path)。
2. human.ts collectChanges 改调共享函数;`HumanAdapter` 构造加 `execFn?` 注入。
3. 回归:临时 git 仓库脏/净两态;`pnpm run check`。
4. Commit footer:`(issue #21 #1-06)`。

### 批次 5 — #1-07 + #1-08(独立小改)

1. `ids.ts` TIER_REQUIREMENTS 对齐 tierOf(L1 去 STRUCTURED_OUTPUT,L2 含 STREAM+COST);一致性测试。
2. `table.ts:162` guardText → `'decision != auto_develop'`;`docs/04-state-machine.md` §2 同步;`transition.test.ts` 加 guardText 断言;确认 `driver.test.ts:378`(security_review→T-013)仍绿。
3. `pnpm run check`。
4. Commit footer:`(issue #21 #1-07 #1-08)`。

### 批次 6 — #1-02(capability 接线,最小改动)

1. `validate.ts`:第 4 步对 capability_request Proposal 求值;`ValidateDeps` 加 `policy`+`now`;缺裁决拒收。
2. `facts.ts`:`capability_allowed` 改为读最新 `A-PolicyDecision`(key='capability_request',decision==='auto_develop'),无 → false。
3. `table.ts` T-009 effects 加 `EvaluatePolicy('capability_request')`(自环时序:本轮守卫读旧裁决,effects 写新裁决,下轮生效)。
4. 回归:validate 无裁决拒收/有裁决通过;driver T-009 无裁决 matched:false。
5. `pnpm run check`。
6. Commit footer:`(issue #21 #1-02)`。**评审点**:首轮 capability 无裁决即拒——若验收要首轮放行,需 ADR。

### 批次 7 — #1-09(删未接线规则)

1. `ruleset.ts`:删 P-DRIFT、P5;P1/P3 points 收为 rfc_ready。
2. 文档同步(04-state-machine.md 转移表注记;核对 06-artifacts.md:429-430 表述)。
3. 回归:`policy.test.ts` DEFAULT_RULES validate() 仍过;无引用 post_develop/qa_failed 的规则。
4. `pnpm run check`。
5. Commit footer:`(issue #21 #1-09)`。

### 批次 8 — #1-10(文档 + 类型,评审决策点)

1. 新写 `docs/05-contracts/git-provider.md`、`ci-gateway.md`(按 src 实际签名;ci-gateway 含 pending→passed 语义)。
2. `types.ts` Proposal.kind:`string` → `ArtifactKind`。**决策点**:若评审要求事件不落 artifact,改 `PersistedArtifactKind`(artifact-store.ts:30 已有);默认选 `ArtifactKind`(Proposal 是提交前形态)。
3. typecheck + 文档-契约抽查。
4. Commit footer:`(issue #21 #1-10)`。

### 批次 9 — #1-11(验收)

1. `github-pr.acceptance.test.ts:145`:从 `remote`(KEEL_TEST_REMOTE_REPO)正则解析 owner/repo;解析失败 throw。
2. 回归:解析函数单测(裸 URL / 带 .git / 带路径);`test:acceptance` 有凭据才跑。
3. Commit footer:`(issue #21 #1-11)`。

### 批次 10 — P2 收尾(#1-12..#1-14)

1. #1-12:`invariants.test.ts` I5 补 SELECT artifact/event + `SELECT keel_commit_artifact(...)` 反例。
2. #1-13:对账 `src/fact/index.ts` 实况 ↔ `03-domain-model.md` §4/artifact/run 字段,改文档 + 附对账表。
3. #1-14:
   - `scripts/check-transition-table.ts` 加 guardText↔guard 比对(归一化后对比);
   - `check-purity.ts` skip 后扫描目录生产 .ts 为空 → 抛错;
   - `session-manager.md` 未实现部分标 `[可延后]`;
   - `artifact-store.test.ts` 加 run.status / task.control_mode CHECK 一致性。
4. `pnpm run check`。
5. Commit footer:`(issue #21 #1-12 #1-13 #1-14)`。

## 验证命令

每批次后(或合并批次后):
```bash
pnpm run check
# lint → typecheck → boundaries → check:generated → check:transitions → check:purity → test
```
`pnpm run test:acceptance` 单独跑(凭据:KEEL_GITHUB_TOKEN + KEEL_TEST_REMOTE_REPO)。

## 评审门

- 批次 6(#1-02)前:确认 capability 首轮「缺裁决即拒」是否符合验收(否则走 ADR 放宽)。
- 批次 8(#1-10):`ArtifactKind` vs `PersistedArtifactKind` 选择。
- 每批 commit footer 必须带 `(issue #21 #1-xx)`。

## 回滚

- 每批独立 commit + PR;回滚 = revert 单 PR。
- #1-02 若评审否决:revert 批次 6,validate 第 4 步回到「记录意图不假装校验」(现状注释语义)。

## 验收核对(对 prd.md 14 项)

| 项 | 交付物 | 验收 |
|---|---|---|
| #1-01 | prompts.ts + 回归 | 输出无写死取值 |
| #1-02 | validate/facts/table + 回归 | 缺裁决拒收,不默认 true |
| #1-03 | manager 映射 + 回归 | CANCELLED retryable=false |
| #1-04 | loop pending.attempt + now | 第二次 develop key /2 |
| #1-05 | RunState.proc + interrupt | fake proc 收 kill |
| #1-06 | git-diff 共享 + human 接入 | 脏树 is_dirty=true |
| #1-07 | ids TIER_REQUIREMENTS | 与 tierOf 一致 |
| #1-08 | guardText + 文档 | security_review→T-013 仍过 |
| #1-09 | ruleset 收缩 + 文档 | 无未接线规则 |
| #1-10 | 两 md + kind 类型 | typecheck + 文档对照 |
| #1-11 | 解析函数 + 回归 | 无写死字面量 |
| #1-12 | invariants 反例 | permission denied |
| #1-13 | domain-model 对账 | 文档=代码实况 |
| #1-14 | 四个小项 | check 全绿 |