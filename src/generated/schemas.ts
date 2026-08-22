/**
 * ⚠️ 本文件由 scripts/generate-types.ts 自动生成 —— 请勿手改。
 *
 * 事实来源：docs/schemas/*.schema.json
 * 重新生成：pnpm run generate
 *
 * 手改本文件会立刻产生第二个事实来源，schema 从此不可信。
 * CI 会通过 `pnpm run check:generated` 检测手改（ADR-0002 L2/L4）。
 */

/** 全部产物 schema，按 artifact kind 索引。供 ajv 运行时编译。 */
export const SCHEMAS = {
  "capability_request": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://keel.dev/schemas/capability-request.schema.json",
    "title": "A-CapabilityRequest",
    "description": "Session 请求能力调用的通用机制。Session 不直接调用任何能力，只 emit 本产物由 Control Plane 裁决派发。",
    "type": "object",
    "required": [
      "schema_version",
      "request_id",
      "requested_by_run",
      "capability",
      "rationale",
      "blocking"
    ],
    "additionalProperties": false,
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "request_id": {
        "type": "string"
      },
      "requested_by_run": {
        "type": "string"
      },
      "capability": {
        "enum": [
          "critic_review",
          "human_input",
          "additional_context"
        ],
        "description": "v0.1 注册表。新增能力只需扩这里 + 加一条 Policy 规则，无需改 Session 实现。"
      },
      "params": {
        "type": "object"
      },
      "rationale": {
        "type": "string"
      },
      "blocking": {
        "type": "boolean",
        "description": "true = 原 Session 等待结果；false = 可继续推进"
      }
    }
  },
  "checkpoint": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://keel.dev/schemas/checkpoint.schema.json",
    "title": "A-Checkpoint",
    "description": "某个 Session 的可恢复摘要。owner 是 Session 而非 Task。丢失只增加 token 成本，不损失事实。",
    "type": "object",
    "required": [
      "schema_version",
      "run_id",
      "harness_id",
      "turn_index",
      "next_action",
      "working_summary",
      "resume_hint"
    ],
    "additionalProperties": false,
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "run_id": {
        "type": "string"
      },
      "harness_id": {
        "type": "string"
      },
      "harness_tier": {
        "enum": [
          "L0",
          "L1",
          "L2"
        ]
      },
      "turn_index": {
        "type": "integer",
        "minimum": 0
      },
      "progress": {
        "type": "string",
        "description": "人类可读进度，如 6/10"
      },
      "current_goal": {
        "type": "string"
      },
      "next_action": {
        "type": "string"
      },
      "working_summary": {
        "type": "string",
        "description": "rematerialize 降级路径的主要输入。无 CAP-RESUME 时靠它重建上下文。"
      },
      "emitted_artifacts": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "unresolved_questions": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "resume_hint": {
        "description": "L0/L1 降级开关。判别字段为 mode —— 两种模式所需的数据不同，故建模为判别联合而非可空字段。",
        "oneOf": [
          {
            "title": "ResumeBySessionRef",
            "description": "Adapter 声明 CAP-RESUME：把句柄交回 Harness，会话上下文由其自行保持。",
            "type": "object",
            "required": [
              "mode",
              "session_ref"
            ],
            "additionalProperties": false,
            "properties": {
              "mode": {
                "const": "session_ref"
              },
              "session_ref": {
                "type": "string",
                "minLength": 1
              }
            }
          },
          {
            "title": "ResumeByRematerialize",
            "description": "无 CAP-RESUME 或句柄已失效：由 ContextBuilder 从 A-State + working_summary 重建，开新会话。",
            "type": "object",
            "required": [
              "mode",
              "rematerialize_from"
            ],
            "additionalProperties": false,
            "properties": {
              "mode": {
                "const": "rematerialize"
              },
              "rematerialize_from": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "重新物化所依据的 artifact 引用"
              }
            }
          }
        ]
      }
    }
  },
  "critic_review": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://keel.dev/schemas/critic-review.schema.json",
    "title": "A-CriticReview",
    "description": "结构化评审结果。相对初稿 §8 补齐了量表、评分维度、证据与置信度。",
    "type": "object",
    "required": [
      "schema_version",
      "review_type",
      "request_id",
      "subject_ref",
      "scale",
      "criteria",
      "scores",
      "recommendation",
      "confidence"
    ],
    "additionalProperties": false,
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "review_type": {
        "enum": [
          "architecture",
          "security",
          "quality",
          "product",
          "feasibility"
        ]
      },
      "request_id": {
        "type": "string"
      },
      "subject_ref": {
        "type": "string",
        "description": "被评审对象的 artifact 引用"
      },
      "scale": {
        "type": "object",
        "description": "没有量表的分数无法跨 Critic 比较或复现",
        "required": [
          "min",
          "max",
          "higher_is_better"
        ],
        "additionalProperties": false,
        "properties": {
          "min": {
            "type": "number"
          },
          "max": {
            "type": "number"
          },
          "higher_is_better": {
            "type": "boolean"
          }
        }
      },
      "criteria": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "string"
        }
      },
      "scores": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "option_id",
            "total"
          ],
          "additionalProperties": false,
          "properties": {
            "option_id": {
              "type": "string"
            },
            "total": {
              "type": "number"
            },
            "by_criterion": {
              "type": "object",
              "additionalProperties": {
                "type": "number"
              }
            }
          }
        }
      },
      "findings": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "severity",
            "text",
            "evidence"
          ],
          "additionalProperties": false,
          "properties": {
            "id": {
              "type": "string"
            },
            "severity": {
              "enum": [
                "low",
                "medium",
                "high"
              ]
            },
            "text": {
              "type": "string"
            },
            "evidence": {
              "type": "string",
              "description": "无证据的 finding 等同于意见，故为必填"
            }
          }
        }
      },
      "recommendation": {
        "type": "string"
      },
      "confidence": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "description": "低置信度的推荐不应触发自动推进；它是 Policy 的输入"
      },
      "dissent": {
        "type": [
          "string",
          "null"
        ],
        "description": "多 Critic 时的分歧记录。分歧本身是信号，不应被平均掉。"
      }
    }
  },
  "event": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://keel.dev/schemas/event.schema.json",
    "title": "A-Event",
    "description": "append-only 事件信封。存于独立 event 表，只增不改。",
    "type": "object",
    "required": [
      "schema_version",
      "seq",
      "task_id",
      "type",
      "occurred_at"
    ],
    "additionalProperties": false,
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "seq": {
        "type": "integer",
        "description": "全局单调，排序与重放游标"
      },
      "task_id": {
        "type": "string"
      },
      "run_id": {
        "type": [
          "string",
          "null"
        ]
      },
      "type": {
        "enum": [
          "FeedbackReceived",
          "TaskCreated",
          "TaskStatusChanged",
          "ControlModeChanged",
          "RunCreated",
          "RunStatusChanged",
          "ProposalSubmitted",
          "ProposalAccepted",
          "ProposalRejected",
          "ArtifactCommitted",
          "PolicyEvaluated",
          "CapabilityRequested",
          "CapabilityGranted",
          "CapabilityDenied",
          "SideEffectSkipped",
          "BudgetExceeded",
          "HumanAction"
        ]
      },
      "payload": {
        "type": "object",
        "description": "状态转移类事件应在 payload 中记录 transition ID（如 T-012），使事件流可直接对照转移表核验"
      },
      "trace_id": {
        "type": [
          "string",
          "null"
        ]
      },
      "span_id": {
        "type": [
          "string",
          "null"
        ]
      },
      "occurred_at": {
        "type": "string",
        "format": "date-time"
      }
    }
  },
  "policy_decision": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://keel.dev/schemas/policy-decision.schema.json",
    "title": "A-PolicyDecision",
    "description": "可重放的裁决记录。facts_snapshot 是完整快照而非引用，这是可重放的前提。",
    "type": "object",
    "required": [
      "schema_version",
      "decision_point",
      "policy_version",
      "evaluated_at",
      "facts_snapshot",
      "matched_rules",
      "decision",
      "reason",
      "default_applied"
    ],
    "additionalProperties": false,
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "decision_point": {
        "type": "string",
        "description": "在哪个判定点求值，如 rfc_ready"
      },
      "policy_version": {
        "type": "string"
      },
      "evaluated_at": {
        "type": "string",
        "format": "date-time"
      },
      "facts_snapshot": {
        "type": "object",
        "description": "求值时输入的完整快照。用引用会随时间变化，快照才能保证同输入同裁决。"
      },
      "matched_rules": {
        "type": "array",
        "description": "数组：多条规则可能同时命中，冲突裁决规则见 policy-engine.md",
        "items": {
          "type": "object",
          "required": [
            "id",
            "condition",
            "action"
          ],
          "additionalProperties": false,
          "properties": {
            "id": {
              "type": "string"
            },
            "condition": {
              "type": "string"
            },
            "action": {
              "type": "string"
            }
          }
        }
      },
      "decision": {
        "type": "string"
      },
      "reason": {
        "type": "string"
      },
      "default_applied": {
        "type": "boolean",
        "description": "true = 无规则命中，走了默认 deny。大量 true 是规则覆盖不足的信号。"
      }
    }
  },
  "rfc": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://keel.dev/schemas/rfc.schema.json",
    "title": "A-RFC",
    "description": "PM -> Developer 的核心交接物。进入 S-RFC_READY 后冻结。",
    "type": "object",
    "required": [
      "schema_version",
      "title",
      "problem",
      "goals",
      "non_goals",
      "proposed_change",
      "acceptance_criteria",
      "policy_facts"
    ],
    "additionalProperties": false,
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "title": {
        "type": "string"
      },
      "problem": {
        "type": "string"
      },
      "goals": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "string"
        }
      },
      "non_goals": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "proposed_change": {
        "type": "object",
        "required": [
          "summary",
          "affected_areas",
          "approach"
        ],
        "additionalProperties": false,
        "properties": {
          "summary": {
            "type": "string"
          },
          "affected_areas": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "approach": {
            "type": "string"
          }
        }
      },
      "alternatives_considered": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "summary",
            "why_not"
          ],
          "additionalProperties": false,
          "properties": {
            "id": {
              "type": "string"
            },
            "summary": {
              "type": "string"
            },
            "why_not": {
              "type": "string"
            }
          }
        }
      },
      "acceptance_criteria": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "required": [
            "id",
            "text",
            "verifiable_by"
          ],
          "additionalProperties": false,
          "properties": {
            "id": {
              "type": "string"
            },
            "text": {
              "type": "string"
            },
            "verifiable_by": {
              "type": "string",
              "description": "如何验证：集成测试 / 回归测试 / 人工核对"
            }
          }
        }
      },
      "test_plan": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "rollback_plan": {
        "type": "string"
      },
      "policy_facts": {
        "type": "object",
        "description": "Policy Engine 的静态输入。随 RFC 一同冻结，故同一 RFC 版本的裁决结果恒定。",
        "required": [
          "risk",
          "complexity",
          "estimated_files_changed",
          "security_related"
        ],
        "additionalProperties": false,
        "properties": {
          "risk": {
            "enum": [
              "low",
              "medium",
              "high"
            ]
          },
          "complexity": {
            "enum": [
              "low",
              "medium",
              "high"
            ]
          },
          "estimated_files_changed": {
            "type": "integer",
            "minimum": 0
          },
          "security_related": {
            "type": "boolean"
          }
        }
      }
    }
  },
  "stage_outcome": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://keel.dev/schemas/stage-outcome.schema.json",
    "title": "A-StageOutcome",
    "description": "某阶段的结构化结论。状态机转移守卫的唯一输入源 —— 守卫必须读枚举，不能解析自由文本。建模为按 stage 判别的联合，使守卫在类型层面就能被收窄。",
    "oneOf": [
      {
        "title": "PmOutcome",
        "type": "object",
        "required": [
          "schema_version",
          "run_id",
          "stage",
          "verdict",
          "reason"
        ],
        "additionalProperties": false,
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "run_id": {
            "type": "string"
          },
          "stage": {
            "const": "pm"
          },
          "verdict": {
            "enum": [
              "actionable",
              "unclear",
              "reject"
            ]
          },
          "reason": {
            "type": "string"
          },
          "details": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "needs_design": {
                "type": "boolean",
                "description": "区分 T-003（走 brainstorm）与 T-004（直接起草 RFC）"
              }
            }
          }
        }
      },
      {
        "title": "BrainstormOutcome",
        "type": "object",
        "required": [
          "schema_version",
          "run_id",
          "stage",
          "verdict",
          "reason"
        ],
        "additionalProperties": false,
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "run_id": {
            "type": "string"
          },
          "stage": {
            "const": "brainstorm"
          },
          "verdict": {
            "enum": [
              "converged",
              "needs_more"
            ]
          },
          "reason": {
            "type": "string"
          },
          "details": {
            "type": "object"
          }
        }
      },
      {
        "title": "RfcDraftOutcome",
        "type": "object",
        "required": [
          "schema_version",
          "run_id",
          "stage",
          "verdict",
          "reason"
        ],
        "additionalProperties": false,
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "run_id": {
            "type": "string"
          },
          "stage": {
            "const": "rfc_draft"
          },
          "verdict": {
            "const": "drafted"
          },
          "reason": {
            "type": "string"
          },
          "details": {
            "type": "object"
          }
        }
      },
      {
        "title": "CriticOutcome",
        "type": "object",
        "required": [
          "schema_version",
          "run_id",
          "stage",
          "verdict",
          "reason"
        ],
        "additionalProperties": false,
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "run_id": {
            "type": "string"
          },
          "stage": {
            "const": "critic"
          },
          "verdict": {
            "const": "reviewed"
          },
          "reason": {
            "type": "string"
          },
          "details": {
            "type": "object"
          }
        }
      },
      {
        "title": "DevelopOutcome",
        "type": "object",
        "required": [
          "schema_version",
          "run_id",
          "stage",
          "verdict",
          "reason"
        ],
        "additionalProperties": false,
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "run_id": {
            "type": "string"
          },
          "stage": {
            "const": "develop"
          },
          "verdict": {
            "enum": [
              "implemented",
              "blocked"
            ]
          },
          "reason": {
            "type": "string"
          },
          "details": {
            "type": "object"
          }
        }
      },
      {
        "title": "VerificationOutcome",
        "description": "QA 与 Review 的结论形状相同（pass / fail），故合为一支。",
        "type": "object",
        "required": [
          "schema_version",
          "run_id",
          "stage",
          "verdict",
          "reason"
        ],
        "additionalProperties": false,
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "run_id": {
            "type": "string"
          },
          "stage": {
            "enum": [
              "qa",
              "review"
            ]
          },
          "verdict": {
            "enum": [
              "pass",
              "fail"
            ]
          },
          "reason": {
            "type": "string"
          },
          "details": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "failed_criteria": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "report_ref": {
                "type": "string"
              }
            }
          }
        }
      }
    ]
  },
  "state": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://keel.dev/schemas/state.schema.json",
    "title": "A-State",
    "description": "某个 Task 的当前事实集合。注意：这不是 task.status（状态机位置）。",
    "type": "object",
    "required": [
      "schema_version",
      "current_goal",
      "confirmed_facts",
      "decisions",
      "open_questions",
      "risks"
    ],
    "additionalProperties": false,
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "current_goal": {
        "type": "string"
      },
      "context_summary": {
        "type": "string"
      },
      "confirmed_facts": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "text",
            "source"
          ],
          "additionalProperties": false,
          "properties": {
            "id": {
              "type": "string"
            },
            "text": {
              "type": "string"
            },
            "source": {
              "type": "string",
              "description": "溯源：run:<stage>#<attempt> 或 human:<who>"
            },
            "confidence": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            }
          }
        }
      },
      "candidate_options": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "summary",
            "status"
          ],
          "additionalProperties": false,
          "properties": {
            "id": {
              "type": "string"
            },
            "summary": {
              "type": "string"
            },
            "pros": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "cons": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "status": {
              "enum": [
                "open",
                "recommended",
                "accepted",
                "rejected"
              ]
            }
          }
        }
      },
      "decisions": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "text",
            "rationale",
            "decided_at",
            "decided_by"
          ],
          "additionalProperties": false,
          "properties": {
            "id": {
              "type": "string"
            },
            "text": {
              "type": "string"
            },
            "rationale": {
              "type": "string"
            },
            "decided_at": {
              "type": "string",
              "format": "date-time"
            },
            "decided_by": {
              "type": "string",
              "description": "run:<stage>#<attempt> 或 human:<who>"
            }
          }
        }
      },
      "open_questions": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "text",
            "blocking"
          ],
          "additionalProperties": false,
          "properties": {
            "id": {
              "type": "string"
            },
            "text": {
              "type": "string"
            },
            "blocking": {
              "type": "boolean"
            }
          }
        }
      },
      "risks": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "text",
            "severity"
          ],
          "additionalProperties": false,
          "properties": {
            "id": {
              "type": "string"
            },
            "text": {
              "type": "string"
            },
            "severity": {
              "enum": [
                "low",
                "medium",
                "high"
              ]
            },
            "mitigation": {
              "type": "string"
            }
          }
        }
      }
    }
  },
} as const

/** artifact kind 的联合类型，与 docs/06-artifacts.md §1 一致 */
export type ArtifactKind = keyof typeof SCHEMAS

/** 全部 kind 的运行时清单 */
export const ARTIFACT_KINDS = Object.keys(SCHEMAS) as ArtifactKind[]
