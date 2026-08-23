/**
 * ArtifactStore —— Fact Plane 的唯一入口。
 *
 * 定义处：docs/05-contracts/artifact-store.md
 *
 * 它的存在意义不是「封装数据库访问」，而是把
 * **「只有 Control Plane 能写事实」这条不变量收敛到一个可审计的位置**。
 *
 * 因此它的接口是刻意窄的：**没有 update，没有 delete，没有 rawQuery**。
 * 这三个「不提供」比七个「提供」更重要 ——
 * 一个 update() 一旦存在，六个月后一定会有人用它「临时修一下数据」，
 * 而那一刻起 history() 就不再可信了。
 */

import type { AEvent } from '../generated/artifacts.js'
import { ARTIFACT_KINDS, type ArtifactKind } from '../generated/schemas.js'
import type { ArtifactRef } from '../shared/ids.js'
import type { Result } from './errors.js'
import type { Proposal, ProposalVerdict } from './types.js'

/**
 * 实际落 `artifact` 表的 kind。
 *
 * 生成的 `ArtifactKind` 来自 docs/schemas/ 的文件名，含 `event` ——
 * 但 `A-Event` 有**独立的表**（docs/06-artifacts.md §1），不是 artifact 的一种。
 * 这里把它排除掉。
 *
 * DB 的 `CHECK` 取值与本列表的一致性由 schema 漂移测试保证。
 */
export type PersistedArtifactKind = Exclude<ArtifactKind, 'event'>

export const PERSISTED_ARTIFACT_KINDS: readonly PersistedArtifactKind[] = ARTIFACT_KINDS.filter(
  (k): k is PersistedArtifactKind => k !== 'event',
)

export interface Artifact {
  readonly id: string
  readonly task_id: string
  readonly kind: PersistedArtifactKind
  readonly key: string
  readonly version: number
  readonly schema_version: string
  readonly body: unknown
  readonly produced_by_run: string | null
  readonly committed_at: string
  /** 见 docs/03-domain-model.md §2.6：getAsOf() 的支撑列 */
  readonly committed_at_seq: number
  readonly superseded_by: string | null
}

export interface CommitContext {
  /** null = Control Plane 自产 */
  readonly run_id: string | null
  /** 必须已通过 session-manager.md §1.2 的五步校验 */
  readonly verdict: ProposalVerdict
  readonly emit_event: boolean
}

export interface ArtifactStore {
  /**
   * [v0.1 必须] 提交提案为产物。
   *
   * 硬检查两项（业务校验不在这里重复做）：
   *   - supersedes 指向的 artifact 是当前最新版，否则 CONFLICT
   *   - (task_id, kind, key, version) 未被占用，否则 CONFLICT
   *
   * 事务语义：写 artifact + 回填旧行 superseded_by + 写 event
   * **必须在同一事务内**完成（不变量 I4）。任一失败则整体回滚。
   */
  commit(proposal: Proposal, ctx: CommitContext): Promise<Result<ArtifactRef>>

  /** [v0.1 必须] 取指定版本 */
  get(
    task_id: string,
    kind: PersistedArtifactKind,
    key: string,
    version: number,
  ): Promise<Result<Artifact>>

  /** [v0.1 必须] 取当前版本（superseded_by IS NULL 的那条） */
  latest(task_id: string, kind: PersistedArtifactKind, key: string): Promise<Result<Artifact>>

  /**
   * [v0.1 必须] 完整版本链，**含已被取代的版本**。
   * 这是「当时是按哪一版做的」能被回答的原因。
   */
  history(
    task_id: string,
    kind: PersistedArtifactKind,
    key: string,
  ): Promise<Result<readonly Artifact[]>>

  /**
   * [v0.1 必须] 取某个事件序号时刻的版本。
   *
   * 看起来像可延后的便利功能，实际是必须的：
   * ContextBuilder 为 Developer 装填 A-RFC 时，必须取**该 Run 开始时**的那一版，
   * 而不是最新版 —— 否则 Developer 和 Reviewer 会看到不同版本的 RFC。
   */
  getAsOf(
    task_id: string,
    kind: PersistedArtifactKind,
    key: string,
    at_event_seq: number,
  ): Promise<Result<Artifact>>

  /** [v0.1 必须] 追加事件。只增不改（不变量 I1）。返回分配到的全局单调 seq */
  appendEvent(event: AEvent): Promise<Result<number>>

  /** [v0.1 必须] 读事件流。重放与审计的入口，按 seq 升序 */
  readEvents(task_id: string, from_seq: number, limit: number): Promise<Result<readonly AEvent[]>>

  // ── [可延后] ──
  //
  // project(task_id: string, up_to_seq: number): Promise<Result<AState>>
  //     从事件流重建 A-State 投影。v0.1 直接读 latest() 即可。
  //     留给阶段二的「重建 / 校对」能力 —— 用它可检测存储的 A-State 是否已与事件流漂移。
  //
  // 明确**不提供**：update() / delete() / rawQuery()
  //     理由见文件头。
}
