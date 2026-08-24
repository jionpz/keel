/**
 * 各阶段的提示词。
 *
 * 提示词是**实现的一部分**，写在这里而不是测试里 ——
 * 写在测试里会让「模型能不能产出合法提案」变成测试的属性而非系统的属性。
 */

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
export function expectedArtifact(stage: Stage): { kind: string; key: string } {
  if (stage === 'rfc_draft') return { kind: 'rfc', key: '' }
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
      return ['推敲实现方案，收敛到一个。', outcome('"converged" | "needs_more"')].join('\n')

    case 'rfc_draft':
      return [
        '把方案写成 RFC。只输出一个 JSON 对象（用 ```json 围栏），形如：',
        '```json',
        '{"schema_version":"1.0","title":"<标题>","problem":"<问题>",',
        ' "goals":["<目标>"],"non_goals":["<不做什么>"],',
        ' "proposed_change":{"summary":"<摘要>","affected_areas":["<模块>"],"approach":"<做法>"},',
        ' "acceptance_criteria":[{"id":"AC1","text":"<可验证的判据>","verifiable_by":"人工核对"}],',
        ' "policy_facts":{"risk":"<low|medium|high>","complexity":"<low|medium|high>",',
        '  "estimated_files_changed":<整数>,"security_related":<true|false>}}',
        '```',
        'policy_facts 必须按 RFC 的真实内容填写，不要套用固定取值。',
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
      return ['对候选方案给出评审。', outcome('"reviewed"')].join('\n')
  }
}
