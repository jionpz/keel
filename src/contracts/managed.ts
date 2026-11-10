/** JT-01：与旧 Artifact/Task 状态机分离的只读调查协议。 */

import type { ResultWithUsage } from './errors.js'
import type { Context, Usage } from './types.js'

export interface ManagedObservation {
  readonly path: string
  readonly digest: string
  readonly content: string
}

export interface ManagedAnswer {
  readonly question: string
  readonly answer: string
  readonly actor: 'human'
}

export type ManagedStatus =
  | 'READY'
  | 'RUNNING'
  | 'WAITING_TIANWEN'
  | 'WAITING_HUMAN'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
export type ManagedPhase = 'investigate' | 'tianwen'

export interface ManagedTask {
  readonly id: string
  readonly repo_id: string
  readonly package_digest: string
  readonly workspace_path: string
  readonly question: string
  readonly file_index: readonly string[]
  readonly observations: readonly ManagedObservation[]
  readonly answers: readonly ManagedAnswer[]
  readonly status: ManagedStatus
  readonly phase: ManagedPhase
  readonly pending_question_id: string | null
  readonly lease_token: string | null
  readonly attempts: number
  readonly max_attempts: number
  readonly failures: number
  readonly report: unknown
  readonly error: string | null
}

export interface ManagedQuestion {
  readonly id: string
  readonly task_id: string
  readonly question: string
  readonly options: readonly string[]
  readonly status: 'OPEN' | 'WAITING_HUMAN' | 'RESOLVED'
  readonly suggestion: unknown
  readonly answer: string | null
}

export interface ManagedInferenceInput {
  readonly attempt_id: string
  readonly task_id: string
  readonly repo_id: string
  readonly phase: ManagedPhase
  readonly context: Context
  readonly workspace_path: string
}

/** 推理是 Execution Plane 的接缝，Control 只接收结构化候选与真实 usage。 */
export type ManagedInference = (input: ManagedInferenceInput) => Promise<
  ResultWithUsage<{
    readonly value: unknown
    readonly usage: Usage
  }>
>
