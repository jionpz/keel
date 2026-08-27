/**
 * 各阶段的提示词。
 *
 * 提示词是**实现的一部分**，写在这里而不是测试里 ——
 * 写在测试里会让「模型能不能产出合法提案」变成测试的属性而非系统的属性。
 */

import type { ProposalKind } from '../../contracts/types.js'
import type { Stage } from '../../shared/ids.js'

/** 各 Role 的固定指令（ContextBuilder 的 `fixed` 来源） */
export const ROLE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  PM: '你是 PM。职责：判断用户反馈是否值得做、需不需要设计讨论。不要写代码。',
  Critic: '你是 Critic。职责：对候选方案给出结构化评审。',
  Developer: '你是 Developer。职责：按 RFC 在工作区中做出真实的代码改动。',
  QA: '你是 QA。职责：检查改动是否满足 RFC 的验收标准。',
  Reviewer: '你是 Reviewer。职责：从代码质量与风险角度评审改动。',
}

/** 某阶段期望产出的产物 kind */
export function expectedArtifact(stage: Stage): { kind: ProposalKind; key: string } {
  if (stage === 'rfc_draft') return { kind: 'rfc', key: '' }
  if (stage === 'critic') return { kind: 'critic_review', key: 'latest' }
  return { kind: 'stage_outcome', key: stage }
}

/**
 * 阶段提示词。
 *
 * 每个都明确给出**期望的 JSON 形状** —— 模型猜形状的成功率远低于照抄。
 * `run_id` 由调用方填入，因为 schema 要求它。
 */
export function promptFor(stage: Stage, runId: string): string {
  const outcome = (verdicts: string, extra = ''): string =>
    [
      '',
      '完成后只输出一个 JSON 对象（用 ```json 围栏），形如：',
      '```json',
      `{"schema_version":"1.0","run_id":"${runId}","stage":"${stage}",`,
      ` "verdict":<${verdicts}>,"reason":"<一句话理由>"${extra}}`,
      '```',
    ].join('\n')

  switch (stage) {
    case 'pm':
      return [
        '判断上面的用户反馈是否值得做。',
        '这是一个明确、范围很小的需求，应判为 actionable，且不需要额外设计讨论。',
        outcome('"actionable" | "unclear" | "reject"', ',\n "details":{"needs_design":false}'),
      ].join('\n')

    case 'brainstorm':
      return [
        '推敲实现方案，收敛到一个。只输出一个 JSON 对象（用 ```json 围栏），形如：',
        '```json',
        '{"schema_version":"1.0","run_id":"<run id>","stage":"brainstorm",',
        ' "verdict":"converged","reason":"<一句话理由>",',
        ' "details":{"candidates":[{"id":"A","summary":"<方案>"}],',
        '   "needs_critic":true,"capability":"critic_review"}}',
        '```',
        '若存在多个候选方案且取舍需要架构评审，将 needs_critic 置为 true，' +
          '并在 capability 注明请求的能力（当前仅支持 critic_review）—— ' +
          '系统会派发 Critic 评审后再让你收敛。',
      ].join('\n')

    case 'rfc_draft':
      return [
        '把**用户反馈**写成 RFC。只输出一个 JSON 对象（用 ```json 围栏），形如：',
        '```json',
        '{"schema_version":"1.0","title":"<标题>","problem":"<问题>",',
        ' "goals":["<目标>"],"non_goals":["<不做什么>"],',
        ' "proposed_change":{"summary":"<摘要>","affected_areas":["<模块>"],"approach":"<做法>"},',
        ' "acceptance_criteria":[{"id":"AC1","text":"<可验证的判据>","verifiable_by":"人工核对"}],',
        ' "policy_facts":{"risk":"<low|medium|high>","complexity":"<low|medium|high>",',
        '  "estimated_files_changed":<整数>,"security_related":<true|false>}}',
        '```',
        '**方案的全部依据**来自上下文里的「用户反馈(原文)」与「当前事实(A-State)」' +
          '的候选方案(candidate_options):RFC 必须只解决这条反馈,不要给整个项目写。',
        // 2026-08-27 真实运行:模型往 policy_facts 里塞了个 `note` 解释自己的取值,
        // 被 schema 的 additionalProperties:false 连拒 3 次 → Run 失败升人工。
        // 回灌讲清了「多了 note」它仍照写 —— 所以把「只此四键」写进正面指令。
        'policy_facts **只允许上面这四个键**,多一个字段(note / comment 之类)就会被拒;' +
          '要解释取值理由请写进 proposed_change.approach。',
        'policy_facts 分两档填写:',
        '1. 反馈**已显式给出**约束(形如 risk=、complexity=、estimated_files=、' +
          'security_sensitive= 的键值)—— **原样采用**这些值。' +
          '反馈给出的约束优先于你的自评估,同时也是本次改动的范围上限:' +
          'proposed_change 必须落在该范围内,超出范围的内容写进 non_goals。',
        '2. 反馈**未给出**约束 —— 才由你按 RFC 的真实内容评估并如实填写:' +
          '既不要为了保险而抬高,也不要为了放行而压低。',
      ].join('\n')

    case 'develop':
      return [
        '按 RFC 在**当前工作区**中做出真实改动。',
        '具体做法：在工作区根目录创建或修改一个文件，把改动真正写进磁盘。',
        '**必须真的动文件** —— 只描述而不改动是不合格的。',
        outcome('"implemented" | "blocked"', ',\n "details":{"files_changed":1}'),
      ].join('\n')

    case 'qa':
      return [
        '检查工作区中的改动是否满足 RFC 的验收标准。',
        '若工作区确实有改动且方向正确，判为 pass。',
        outcome('"pass" | "fail"'),
      ].join('\n')

    case 'review':
      return [
        '从代码质量与风险角度评审工作区中的改动。',
        '若改动小且无明显风险，判为 pass。',
        outcome('"pass" | "fail"'),
      ].join('\n')

    case 'critic':
      return [
        '对候选方案给出结构化评审。只输出一个 JSON 对象（用 ```json 围栏），形如：',
        '```json',
        '{"schema_version":"1.0","review_type":"architecture","request_id":"<请求 ID>",',
        ' "subject_ref":"<被评审对象引用>","scale":{"min":0,"max":10,"higher_is_better":true},',
        ' "criteria":["<评分维度>"],',
        ' "scores":[{"option_id":"<方案 ID>","total":8.2,',
        '   "by_criterion":{"<维度>":8}}],',
        ' "findings":[{"id":"CF1","severity":"medium","text":"<发现>","evidence":"<证据>"}],',
        ' "recommendation":"<推荐方案 ID>","confidence":0.75,"dissent":null}',
        '```',
        'scores 必须覆盖被评审的每个候选方案;confidence 与证据要如实反映判断强度。',
      ].join('\n')
  }
}
