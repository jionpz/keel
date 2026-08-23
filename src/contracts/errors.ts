/**
 * 错误语义。
 *
 * 定义处：docs/05-contracts/README.md「错误语义」一节。
 *
 * `retryable` 不是建议 —— 它是 docs/04-state-machine.md 中
 * T-030（重试自环）与 T-031（升人工）的 guard 输入。
 * 把不可重试的错误标成可重试，系统会白白重跑到 max_attempts 才升人工。
 */

export const ERROR_KINDS = [
  'HARNESS_UNAVAILABLE',
  'AUTH_FAILED',
  'PROTOCOL_ERROR',
  'SCHEMA_VIOLATION',
  'RUN_TIMEOUT',
  'RUN_CANCELLED',
  'WORKSPACE_ERROR',
  'BUDGET_EXCEEDED',
  'PERMISSION_DENIED',
  'CAPABILITY_UNSUPPORTED',
  'CONFLICT',
  'CONTEXT_BUDGET_EXCEEDED',
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

/** 契约方法的统一返回：成功值或错误。避免用异常表达可预期的失败。 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KeelError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T>(error: KeelError): Result<T> {
  return { ok: false, error }
}
