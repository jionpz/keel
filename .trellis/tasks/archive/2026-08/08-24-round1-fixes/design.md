# Round 1 组件专家审查修复 — 技术设计

## 目标

让「契约声称已落地、实现空转或写死」的 14 个点各归其位:空转的实现真正接上数据源,写死的取值换成真实输入,文档与代码分叉处以文档为准(除非文档陈述了不可能的行为)。无 P0;每项独立可 merge。

## 设计原则

1. **缺裁决 = 拒绝,不默认放行**(#1-02)。
2. **T-013 改文档不改守卫**(#1-08)——守卫语义 `decision != auto_develop` 是安全正确的(security_review 也须走人工),文档/guardText 与它对齐。
3. **未接线的判定点删规则,不假装接线**(#1-09)——`EvaluatePolicy` 副作用只挂在 T-011(rfc_ready 一处),其余判定点的规则是「写了但没人读」。
4. **时间一律走注入的 `now`**(#1-04)——Control Plane 不读时钟(ADR-0003)。
5. **真实 git 是唯一改动事实源**(#1-06)——Human 与 OMP 读的是同一个工作区,collectChanges 必须看到同样的脏树。

---

## #1-01 去写死 policy_facts

**现状**:`prompts.ts:64` 提示词末行写死「这是一个低风险、低复杂度、非安全相关的小改动」——等价于预置 `policy_facts=low/low/1/false`。
**方案**:删该行与形状示例中误导性的兜底句,只保留「policy_facts 如实填写」语义。**注意**:`rfc_draft` 形状示例里的 `"policy_facts":{...}` 键名保留(schema 需要它),但取值示例改为中性占位(如 `""` 或移除取值、只留键结构)。
**回归**:`prompts.test.ts` 新增——`promptFor('rfc_draft', rid)` 不含 `low` / `false` / `1` 连写的固定取值;形状仍含 `policy_facts` 键。

## #1-02 capability 裁决接线

**现状**:两处空转——`facts.ts:75` `capability_allowed: true` 恒真(T-009 守卫因此恒过);`validate.ts:90-92` 第 4 步空返回。
**方案**:
- `validate.ts` 第 4 步:对 `capability_request` 类 Proposal 求值 Policy。
  - `ValidateDeps` 加 `policy: PolicyEngine` + `now: () => string`。
  - Proposal kind 来自 schema 集:遍历存在 `policy` 判定点的 kind(当前仅 `capability_request`)→ `deps.policy.evaluate('capability_request', facts, now)`。
  - **缺裁决 / evaluate 失败 → 拒收**(violation `policy:denied`,message 写明「capability_request 未获授权」)。不默认 true。
  - facts:沿用 `loadPolicyFacts(c, taskId, 'capability_request')`(dev_attempts/cost_spent_usd)。
- `facts.ts:73-75`:`capability_allowed` 不再恒 true——改为调用方注入。`loadTransitionFacts` 加 `policy?: PolicyEngine` 与 `now?: string` 依赖(默认缺省时该守卫按 `false` 处理?不——**缺依赖不是放行理由**)。更干净的做法:
  - `loadTransitionFacts` 从 Fact Plane 读最新 `A-PolicyDecision`(kind='policy_decision', key='capability_request');有 → `decision === 'auto_develop'`;无 → `false`(缺裁决拒绝)。
  - 这样 T-009 的守卫读的是**已落库的裁决**,与 driver 副作用链路一致,不引入新依赖。
- 副作用侧:`table.ts` T-009 前需有 `EvaluatePolicy(capability_request)`——因 T-009 是 SELF 回转,在 T-009 的 effects 里加 `EvaluatePolicy, point:'capability_request'` 并在下一次 CapabilityRequested 时守卫读到新裁决。**注意自环时序**:T-009 guard 用旧裁决,effects 写新裁决,下一轮事件生效。这是现状契约(T-009 已定义 `policy=allow` guard)的最小接线。
  - 风险:首次 CapabilityRequested 时无裁决 → 拒绝。v0.1 只有 critic 一个 capability,**暂不默认放行**(符合原则 1);若验收要求首轮放行,走 ADR 放宽。
**回归**:`validate` 测试——capability_request 无裁决 → 拒收;有裁决 auto_develop → 通过;security_related 高 → 拒收。`driver` 测试——T-009 在无裁决时 matched:false。

## #1-03 RunResult.status → ErrorKind 映射

**现状**:`manager.ts:98-99` 一切非 SUCCEEDED → `PROTOCOL_ERROR`(retryable=true),人工撤回被 T-030 白白重试。
**方案**:按 status 映射:
```
SUCCEEDED → 正常
FAILED    → PROTOCOL_ERROR (retryable=true,输出不可解析,可重试)
TIMEOUT   → RUN_TIMEOUT    (retryable=true)
CANCELLED → RUN_CANCELLED  (retryable=false,人工撤回不重试)
```
映射函数放 `manager.ts` 局部,单测锁定。
**回归**:`manager` 测试——CANCELLED → error.kind=RUN_CANCELLED 且 retryable=false;TIMEOUT → RUN_TIMEOUT。

## #1-04 executeRun 用 pending.attempt + deps.now()

**现状**:`loop.ts:242,244` 写死 `attempt: 1` / key 后缀 `/1`;`271` `ended_at=now()` 绕过注入。
**方案**:
- `readPendingRun` 查询补 `attempt` 列(SELECT 已按 attempt DESC 排序);`executeRun` 用它填 `run.attempt` 与 `idempotency_key`(`${taskId}/${stage}/${attempt}`),与 `createRun` 副作用(effects.ts:112-115)生成的 key 一致——**这是同一条 key,必须同构,否则幂等断裂**。
- `ended_at` 改 `deps.now()`。`UPDATE run SET status='SUCCEEDED', ended_at=$2 WHERE id=$1`,参数 `[pending.id, deps.now()]`。
- `executeRun` 签名已收 `deps`(含 `now`),无需改接口。
**回归**:编排测试——第二次 develop 时 run.attempt=2 且 idempotency_key 以 `/2` 结尾(ci-wiring.test.ts:223 已有查询骨架);`ended_at` 等于注入的 now。

## #1-05 OmpAdapter.interrupt 杀子进程

**现状**:`omp.ts:158-163` 只置 `state.aborted=true`,已 spawn 的子进程(`exec()` 里的 `proc`)继续跑。
**方案**:
- `RunState` 加 `proc?: ReturnType<typeof spawn>` 字段;`exec()` 把 `run()` 返回的 proc 存入 state(在 await 前),结束后清空。
- `interrupt()`:置 aborted + `state.proc?.kill('SIGTERM')`(OMP 优雅退出),kill 失败/超时再 `SIGKILL`(不做定时器,直接 SIGTERM→返回,由 awaitResult 的退出码路径收敛)。
- `awaitResult` 已处理 CANCELLED 返回路径(`exec` 里 `state.aborted` 检查),保持。
**回归**:`adapters.test.ts`——spawn fixture(注入 spawnFn 模拟挂起进程)startRun 后 interrupt,断言 fake proc 收到 kill;awaitResult 返回 CANCELLED。

## #1-06 HumanAdapter.collectChanges 读真实 git

**现状**:`human.ts:109-110` 恒返回 `is_dirty:false`。
**方案**:
- 从 `handle` 找 `RunState` → `spec.runSpec.workspace.path`;在该目录执行 `git status --porcelain` + `git diff`(与 omp.ts collectChanges 相同实现)。
- 抽共享:`omp.ts` 的 collectChanges 逻辑提到 `src/execution/adapters/git-diff.ts`,两者复用。OMP 已实现,Human 直接调共享函数。
- 依赖注入:`HumanAdapter` 构造加 `execFn?`(默认 node 的 execFileSync),测试注入 fake git 目录。
**回归**:构造临时 git 仓库(commit 后加改动文件),Human collectChanges → `is_dirty=true` 且 files_changed 含该文件;干净仓库 → false。

## #1-07 TIER_REQUIREMENTS 对齐 ADR-0005

**现状**:`ids.ts:117-127` L1 含 `CAP-STRUCTURED_OUTPUT`,L2 也含——与 `tierOf`(tier.ts:27,STRUCTURED_OUTPUT 正交、不在阶梯)分叉。
**方案**:改 `TIER_REQUIREMENTS`:
```
L0: [CAP-HEADLESS]
L1: [CAP-HEADLESS, CAP-RESUME]
L2: [CAP-HEADLESS, CAP-RESUME, CAP-STREAM, CAP-COST]
```
与 `tierOf` 的判定一致。加一致性测试:对每个 tier,`tierOf(requirements) === tier`。
**回归**:`adapters.test.ts` / `ids.test.ts`——L1 不含 STRUCTURED_OUTPUT;一致性断言。

## #1-08 T-013 guardText 对齐守卫

**现状**:`table.ts:161-162` guard=`decision !== 'auto_develop'`(正确),guardText=`'decision=human_review'`(误导);`docs/04-state-machine.md:97` 同误导。
**方案**:guardText 改 `'decision != auto_develop'`;文档 §2 同步;**不动 guard**(security_review → T-013 语义不变)。
**回归**:现有 `driver.test.ts:378`(security_review → T-013)已覆盖,跑通即证明未收窄;`transition.test.ts` 增 guardText 断言。

## #1-09 删未接线判定点规则

**现状**:`ruleset.ts` DEFAULT_RULES 的 points 覆盖 rfc_ready/post_develop/qa_failed/pre_pr,但 `EvaluatePolicy` 副作用只挂 rfc_ready(T-011)。其余点的规则**写了但永远不执行**。
**方案**:
- DEFAULT_RULES 收缩到已接线判定点 `rfc_ready`:
  - 删 `P-DRIFT`(post_develop)
  - 删 `P5`(qa_failed)
  - `P1`/`P3` 的 points 从 `['rfc_ready','pre_pr']` 收为 `['rfc_ready']`
  - P2/P4 保持(rfc_ready)
- 文档删「C-*/R-* 各有自己的表」表述(在 04-state-machine.md 转移表注记;06-artifacts.md:429-430 的事件-转移映射保留——那是事件归属不是「表」)。
- FACTS_AT 同步:post_develop/qa_failed/pre_pr 的 fact 组保留注册(loadPolicyFacts 仍可为未来接线查询),但规则不引用 → 无行为。
- 注:`capability_request` 已被 #1-02 接线,不属此删。
**回归**:`policy.test.ts` DEFAULT_RULES validate() 通过;删掉 P-DRIFT 后无规则引用 post_develop。

## #1-10 补 git-provider/ci-gateway 契约文档 + Proposal.kind 类型

**现状**:`src/contracts/git-provider.ts`、`ci-gateway.ts` 存在,但 `docs/05-contracts/` 缺对应 md;`types.ts:108` Proposal.kind=`string` 过宽。
**方案**:
- 新写 `docs/05-contracts/git-provider.md`:`GitHubProvider` 契约(ensureBareRepo/ensureWorktree/commitAll/push/headSha/createPullRequest/waitForCi 归口,见 src/fact/git-workspace.ts + github-provider.ts 实际签名),含 I5 边界(执行侧不可写 Fact)。
- 新写 `docs/05-contracts/ci-gateway.md`:`waitForCi` 契约、pending→passed/failed 语义(8885ae2 的「pending 无上报视为通过」规则要写进文档)。
- `types.ts` Proposal.kind:`string` → `ArtifactKind`(generated/schemas 的联合)。`validate.ts` 第 1 步已按 kind 取 validator,收窄后编译期即排除未知 kind。
- 注意 `PersistedArtifactKind = Exclude<ArtifactKind,'event'>`(artifact-store.ts:30)——Proposal 可含 event 吗?Proposal 落库为 artifact(artifact-store 用 PERSISTED),但 schema 集含 event。**保守:用 `ArtifactKind`**(含 event,Proposal 是「提交前」形态);若验收要求事件不落 artifact 用 `PersistedArtifactKind`,二选一在评审定。prd 已列此选项,写进 implement 阶段决策。
**回归**:typecheck;新 md 与 src 契约签名一致(人工/抽查)。

## #1-11 acceptance cleanup 从 env 解析 repo

**现状**:`github-pr.acceptance.test.ts:145` `gh pr close --repo jionpz/keel` 写死。
**方案**:从 `KEEL_TEST_REMOTE_REPO`(已是模块级 `remote`)解析 owner/repo:URL 形如 `https://github.com/<owner>/<repo>[.git]` → 正则提取;解析不到 → throw(同 beforeEach 纪律,不静默)。
**回归**:不清真凭据也能单测——解析函数导出/内联,断言 `https://github.com/jionpz/keel` → `jionpz/keel`、带 `.git` 尾部、带路径变体。

## #1-12 I5 反例补 SELECT artifact/event 与 EXECUTE

**现状**:`invariants.test.ts` 有 INSERT artifact/event 反例;缺 SELECT artifact/event 反例与 `SELECT keel_commit_artifact(...)` 反例。
**方案**:I5 describe 追加:
- `keel_execution` 不能 `SELECT artifact` / `SELECT event`(权限矩阵已禁,反例固化)。
- `keel_execution` 不能 `SELECT keel_commit_artifact(...)`(这是**唯一写 artifact 的通道**,必须确认执行侧不可直接调)。
**回归**:跑 invariants.test.ts,期望 permission denied。

## #1-13 src/fact/index.ts 与 03-domain-model.md 对齐

**现状**:issue 称 fact 层已落地 GRANT / blob / control_mode / cost_basis,但文档仍写骨架期形态。
**方案**:
- 读 `src/fact/index.ts` 实际导出(GRANT 函数、blob 阈值、control_mode、cost_basis 字段)→ 把 `03-domain-model.md` §4 权限矩阵、artifact 存储、run 表字段三处对账改写。
- 对账点:权限矩阵(keel_execution 的 run SELECT 收窄「仅自身 run」是否落地)、`cost_basis` 字段(usage 里)、`control_mode` CHECK、blob 256KB 阈值。
**回归**:文档与代码交叉抽查一致;无编译面。附对账表(文档行 ↔ src 位置)供评审。

## #1-14 C4 guardText 比对 / purity 空文件 / SessionManager 文档 / DDL CHECK

**现状**:
- C4 检查(`check-transition-table.ts`)与 guardText 一致性:XD 断言?现状未见 guardText 比对(即便有也漏了 T-013)。
- `check-purity.ts` skip 后不校验目录为空(空目录=假绿)。
- `session-manager.md` 写满 checkpoint/restore/selectAdapter(非目标)。
- `artifact-store.test.ts` DDL 漂移缺 control_mode / run 枚举 CHECK。
**方案**:
- C4:检查脚本加 guardText≠guard 比对(归一化 `!=`/`!==` 后对比),T-013 改动后通过。位置:`scripts/check-transition-table.ts`。
- purity:skip 逻辑后,若扫描目录下生产 .ts 文件集合为空 → 抛错(防「扫了个寂寞」)。
- SessionManager 文档:`docs/05-contracts/session-manager.md` 未实现部分标 `[可延后]`(checkpoint/restore/selectAdapter),v0.1 路径保持现状。
- DDL:`artifact-store.test.ts` 加 `run.status`(SUCCEEDED/FAILED/TIMEOUT/CANCELLED/PENDING ↔ ERROR_KINDS?不——run.status 是 RunStatus 枚举)与 `task.control_mode` CHECK 一致性测试,对照 `src/shared/ids.ts`。
**回归**:`pnpm run check:purity`(引入故意空目录夹具验证失败)、`artifact-store.test.ts`、`check-transition-table`。

---

## 跨项依赖

- #1-02 依赖 `loadPolicyFacts('capability_request')` 已存在(facts.ts:140)——无阻塞。
- #1-04 与 #1-03 独立,但都动 manager/loop:同批改,回归互相覆盖。
- #1-06 抽 `git-diff.ts` 前,先确认 omp.ts collectChanges 现逻辑可无依赖提取(它用 execFileSync + workspace.path)。
- #1-09 收缩规则后,#1-02 的 capability_request 是唯一新增接线点,两者 ruleset 改动互不冲突。
- 全部 P1 项可单 PR;P2 项(#1-12..#1-14)可在 P1 后合并。

## 不做

- 不重写 Workflow engine(ADR-0003 仍 Proposed)。
- 不实现 SessionManager.checkpoint/restore/selectAdapter。
- 不给 capability_request 默认放行(要放行走 ADR)。
- 不动 C1–C4 门槛(改门槛走 ADR)。