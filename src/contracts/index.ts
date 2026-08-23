/**
 * 契约层汇出。
 *
 * 这些接口由 docs/05-contracts/ 的语言中立伪代码翻译而来（ADR-0002 L3）。
 * 契约文档本身**不改写成 TS** —— 它的读者不只是 Keel 的代码，
 * 还有 Harness 实现者与人工操作者。
 *
 * 产物形状一律来自 src/generated/（由 docs/schemas/ 生成），
 * 本层**不重复定义任何产物形状**。
 */

export * from './artifact-store.js'
export * from './context-builder.js'
export * from './errors.js'
export * from './harness-adapter.js'
export * from './policy-engine.js'
export * from './session-manager.js'
export * from './types.js'
