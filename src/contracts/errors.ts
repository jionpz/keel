/**
 * 错误语义。
 *
 * 定义处：docs/05-contracts/README.md「错误语义」一节。
 *
 * `retryable` 不是建议 —— 它是 docs/04-state-machine.md 中
 * T-030（重试自环）与 T-031（升人工）的 guard 输入。
 * 把不可重试的错误标成可重试，系统会白白重跑到 max_attempts 才升人工。
 */

import type { Usage } from './types.js'

export const ERROR_KINDS = [
  'HARNESS_UNAVAILABLE',
  'AUTH_FAILED',
  'PROTOCOL_ERROR',
  'SCHEMA_VIOLATION',
  'RUN_TIMEOUT',
  'RUN_STALLED',
  'RUN_CANCELLED',
  'WORKSPACE_ERROR',
  'BUDGET_EXCEEDED',
  'PERMISSION_DENIED',
  'CAPABILITY_UNSUPPORTED',
  'CONFLICT',
  'CONTEXT_BUDGET_EXCEEDED',
  'STAGE_GATE_FAILED',
  'STALE_EVIDENCE',
  'NOT_FOUND',
] as const

export type ErrorKind = (typeof ERROR_KINDS)[number]

/**
 * 每个 kind 是否可重试。
 *
 * 判断依据是「再试一次有没有可能不同」：
 *   凭据失效、越权、预算耗尽、能力不支持 —— 重试永远是同样结果，直接升人工。
 *   进程启动失败、输出解析失败、超时、工作区冲突 —— 有机会。
 */
export const RETRYABLE: Readonly<Record<ErrorKind, boolean>> = {
  /** 二进制缺失、进程启动失败 */
  HARNESS_UNAVAILABLE: true,
  /** 凭据失效 —— 重试无意义 */
  AUTH_FAILED: false,
  /** Harness 输出无法解析 */
  PROTOCOL_ERROR: true,
  /** Proposal 不符合 schema → 走 R-007 回灌 */
  SCHEMA_VIOLATION: true,
  /** 超过 wall-clock */
  RUN_TIMEOUT: true,
  /** 无进展超过 stage 阈值 —— 换个 session 可能继续 */
  RUN_STALLED: true,
  /** 人工取消 / 预算熔断 */
  RUN_CANCELLED: false,
  /** 分支冲突、工作区脏 */
  WORKSPACE_ERROR: true,
  /** 触发 C-002 */
  BUDGET_EXCEEDED: false,
  /** 越权调用被拦 */
  PERMISSION_DENIED: false,
  /** 调了 Adapter 未声明的能力 —— 这是编程错误，不是运行时故障 */
  CAPABILITY_UNSUPPORTED: false,
  /** Artifact 并发写入冲突 —— 重读最新版后可重试 */
  CONFLICT: true,
  /** Context required section 摘要后仍超预算 —— 见 context-builder.md §4.3，直接升人工 */
  CONTEXT_BUDGET_EXCEEDED: false,
  /** 阶段门证据缺失或未通过 —— 补齐证据 / 重做后才能继续 */
  STAGE_GATE_FAILED: false,
  /** 证据绑定的 commit / diff 已过期 —— 必须重新执行或重规划 */
  STALE_EVIDENCE: false,
  /** 查询的产物 / 事件不存在。重试不会让它出现 */
  NOT_FOUND: false,
}

export interface KeelError {
  readonly kind: ErrorKind
  readonly detail: string
  readonly retryable: boolean
  readonly cause?: KeelError
}

export function makeError(kind: ErrorKind, detail: string, cause?: KeelError): KeelError {
  const base = { kind, detail, retryable: RETRYABLE[kind] }
  return cause === undefined ? base : { ...base, cause }
}

export function errorFrom(error: unknown, kind: ErrorKind, fallbackDetail: string): KeelError {
  if (
    error !== null &&
    typeof error === 'object' &&
    'kind' in error &&
    typeof error.kind === 'string' &&
    (ERROR_KINDS as readonly string[]).includes(error.kind) &&
    'detail' in error &&
    typeof error.detail === 'string' &&
    'retryable' in error &&
    typeof error.retryable === 'boolean'
  ) {
    return error as KeelError
  }
  return makeError(kind, error instanceof Error ? error.message : fallbackDetail)
}

/** 契约方法的统一返回：成功值或错误。避免用异常表达可预期的失败。 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KeelError }

/**
 * 失败也带 usage 的结果。
 *
 * 与 `Result<T>` 的唯一差别：失败分支有位置放**已经花掉的钱**。
 * 用于「失败前可能已经真实调用过 Harness」的方法（如 `advance`）——
 * 失败时丢弃 usage 会让最烧钱的场景（超时重试 × T-030 重跑）
 * 对成本核算（C1）与预算熔断（C-002）完全失明。
 */
export type ResultWithUsage<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KeelError; readonly usage: Usage }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T>(error: KeelError): Result<T> {
  return { ok: false, error }
}
