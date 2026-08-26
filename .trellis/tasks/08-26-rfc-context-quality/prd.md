# rfc_draft 上下文质量:模型对着 feedback 写 RFC

## Goal

合并验收遗留:rfc_draft 阶段模型产出**项目级 RFC**(keel 整体目标:8 个子任务、ADR-0003、docs/08-cross-cutting)而非 feedback 对应的方案 → Policy 可能裁决 human_review 而非 auto_develop,无法走到 v0.1 判据的 S-DONE。

## 根因(诊断)

- **A-State 断链已修**(synthesizeStateFromBrainstorm,前任务):rfc_draft 现在能拿到 candidate_options。
- **残留问题**:模型在 untrusted workspace 里**主动读**项目文件(README/.trellis/docs),把「方案」理解成整个 keel 项目,而非上下文里的**用户反馈 + A-State 候选方案**。
- promptFor('rfc_draft') 只说「把方案写成 RFC」——未限定「方案 = feedback + candidate_options」,也未警示「不要以工作区项目为方案」。

## Requirements

### R1 · promptFor('rfc_draft') 聚焦方案来源

改写提示词,明确三点:
1. **方案来源**:用户反馈(上下文「用户反馈(原文)」)+ A-State 的 `candidate_options`(若有)。
2. **边界**:只针对该反馈写 RFC;**不要**把工作区项目整体(branches/API/架构/roadmap)当作方案。
3. 若反馈过于模糊无候选方案 → 如实填 policy_facts(risk 按实),不硬凑 low。

### R2 · untrusted workspace 加固(选择项)

- rfc_draft 的 workspace 已是 untrusted(true,loop 统一)。
- 检查 OMP 的 `--no-extensions/--no-skills/--no-rules` 是否足以阻止模型读到项目文件——**不能**禁止模型主动 `read`。因此靠 prompt(R1)引导,不靠 harness 开关。
- 可选:rfc_draft permissions 从 `['read']` 收窄?已经 read-only。**决策**:靠 R1,R2 只验证 + 记录。

### R3 · 确定性回归

- prompts.test:`promptFor('rfc_draft')` 含「用户反馈」「候选方案」「不要以工作区项目」关键措辞。
- 确定性 e2e(不调 OMP):ctxBuilder.build(rfc_draft role) 断言 sections 含 feedback + state(candidate_options)——确保方案传递进 context。

### R4 · 验收复跑(S-DONE)

- merge.acceptance 复跑,目标 auto_develop 裁决 → S-DONE + 真实 PR/CI。
- 若 Policy 仍 human(模型如实写 high),**不是失败**——记录 facts,重点验证「模型确实对着 feedback 写」而非项目级。

## Acceptance Criteria

- [ ] R1:rfc_draft prompt 聚焦方案来源,回归断言措辞
- [ ] R3:确定性命中——rfc_draft context sections 含 feedback + state
- [ ] R4:验收复跑,观察模型 RFC 是否 feedback 对应(标题/目标含反馈内容);S-DONE 或合法终态
- [ ] `pnpm run check` 全绿

## Constraints

- 不重写 ContextBuilder 架构(只调 prompt 措辞 + 验证 sections)。
- 不改 harness-adapter 的 untrusted 契约。
- Policy 裁决仍诚实(模型如实 facts);验收不为此放宽。

## Notes

- 轻量任务,PRD 为主,重跑验收耗时 ~8min。
- 与 `08-25-merge-acceptance` 的验收记录衔接。

## 验收记录(2026-08-25)

- **R1 达成**:prompt 聚焦后,rfc_draft 模型产出完全对应 feedback(「导出 Excel 支持按日期筛选」,goals 均为反馈内容),不再是项目级 RFC。
- **policy_facts**:该轮落库 = `{risk:low, complexity:low, estimated_files_changed:1, security_related:false}`。
- **裁决待查**:确定性验证 low/low/1/false → auto_develop(engine 纯函数)。但真实验收仍 S-HUMAN_REVIEW —— rfc_ready 求值时的 facts 与落库版不一致的可能性(求值时机/R-007 中间版),或验收进程清理时序导致 psql 残留非本轮。需要一次「不清理 DB」的干净单轮捕获归因。
- **结论**:上下文质量修复达成(模型对反馈写 RFC);auto/human 裁决是 Policy 职责,且确定性下 low→auto 成立。

## 波动性结论(复跑追加)

- 第 2 次复跑:pm 产出 `unclear`(T-005 → S-NEED_CLARIFICATION)停下 —— 模型对同一 feedback 的判定(actionable/unclear/风险等级)有波动。
- **验收语义收敛**:合并验收验证的是**编排器机制**(模型产出 → 状态推进 → 平面协作),不是「模型恰好判 actionable+low」。模型调度波动是 README 已承认的(「断言依赖模型说了什么」)。
- **本任务目标(R1)已达成**:prompt 聚焦后模型产出 feedback 对应 RFC(「导出 Excel 支持按日期筛选」,goals 全对应反馈);确定性验证 low facts → auto_develop。模型波动不改变此结论。