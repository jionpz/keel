/**
 * ⚠️ 本文件由 scripts/generate-types.ts 自动生成 —— 请勿手改。
 *
 * 事实来源：docs/schemas/*.schema.json
 * 重新生成：pnpm run generate
 *
 * 手改本文件会立刻产生第二个事实来源，schema 从此不可信。
 * CI 会通过 `pnpm run check:generated` 检测手改（ADR-0002 L2/L4）。
 */

export type ManagedInvestigationResult = ({
outcome: "read_files"
/**
 * @minItems 1
 * @maxItems 8
 */
paths: [string]|[string, string]|[string, string, string]|[string, string, string, string]|[string, string, string, string, string]|[string, string, string, string, string, string]|[string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string]
} | {
outcome: "waiting_decision"
question: string
/**
 * @minItems 2
 * @maxItems 6
 */
options: [string, string]|[string, string, string]|[string, string, string, string]|[string, string, string, string, string]|[string, string, string, string, string, string]
} | {
outcome: "completed"
report: string
/**
 * @minItems 1
 * @maxItems 32
 */
citations: [{
path: string
digest: string
}, ...({
path: string
digest: string
})[]]
})

export interface TianwenSuggestion {
recommendation: string
rationale: string
/**
 * @maxItems 12
 */
missing_information: []|[string]|[string, string]|[string, string, string]|[string, string, string, string]|[string, string, string, string, string]|[string, string, string, string, string, string]|[string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string]
}

export interface JstackInvestigationPackage {
protocol_version: "1.0"
workflow_id: "jstack"
mode: "investigation"
source_commit: string
/**
 * @minItems 1
 * @maxItems 1
 */
stages: ["execute"]
instructions: {
route: string
stages: string
execute: string
}
}

export const MANAGED_SCHEMAS = {"investigation_result": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"ManagedInvestigationResult","oneOf":[{"type":"object","additionalProperties":false,"required":["outcome","paths"],"properties":{"outcome":{"const":"read_files"},"paths":{"type":"array","minItems":1,"maxItems":8,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":512}}}},{"type":"object","additionalProperties":false,"required":["outcome","question","options"],"properties":{"outcome":{"const":"waiting_decision"},"question":{"type":"string","minLength":1,"maxLength":4000},"options":{"type":"array","minItems":2,"maxItems":6,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":1000}}}},{"type":"object","additionalProperties":false,"required":["outcome","report","citations"],"properties":{"outcome":{"const":"completed"},"report":{"type":"string","minLength":1,"maxLength":16000},"citations":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","additionalProperties":false,"required":["path","digest"],"properties":{"path":{"type":"string","minLength":1},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}}}}}}]},
"tianwen_suggestion": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"TianwenSuggestion","type":"object","additionalProperties":false,"required":["recommendation","rationale","missing_information"],"properties":{"recommendation":{"type":"string","minLength":1,"maxLength":4000},"rationale":{"type":"string","minLength":1,"maxLength":4000},"missing_information":{"type":"array","maxItems":12,"items":{"type":"string","minLength":1,"maxLength":1000}}}},
"workflow_package": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"JstackInvestigationPackage","type":"object","additionalProperties":false,"required":["protocol_version","workflow_id","mode","source_commit","stages","instructions"],"properties":{"protocol_version":{"const":"1.0"},"workflow_id":{"const":"jstack"},"mode":{"const":"investigation"},"source_commit":{"type":"string","minLength":1,"maxLength":100},"stages":{"type":"array","minItems":1,"maxItems":1,"items":{"const":"execute"}},"instructions":{"type":"object","additionalProperties":false,"required":["route","stages","execute"],"properties":{"route":{"type":"string","minLength":1,"maxLength":100000},"stages":{"type":"string","minLength":1,"maxLength":50000},"execute":{"type":"string","minLength":1,"maxLength":30000}}}}}} as const
