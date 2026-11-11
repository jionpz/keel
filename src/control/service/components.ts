/** JT-06 内置服务角色：决策、执行、摘要、巡检、outbox 与 checks。 */

import type { ManagedInference } from '../../contracts/managed.js'
import { asRole } from '../../fact/db.js'
import type { WorkerDeps } from '../../timer/worker.js'
import { drainAllDueTimers } from '../../timer/worker.js'
import {
  type ManagedActionGatewayDeps,
  reconcileUncertainActions,
  runActionGatewayOnce,
} from '../managed/action-gateway.js'
import { type ManagedCheckGatewayDeps, runCheckGatewayOnce } from '../managed/check-gateway.js'
import { createProjectMemorySummary } from '../managed/memory-store.js'
import { tickManaged } from '../managed/runtime.js'
import type { ManagedTicketWorker } from '../managed/ticket-runtime.js'
import { tickManagedTicket } from '../managed/ticket-runtime.js'
import { tickPendingTicketTianwen } from '../managed/ticket-tianwen.js'
import { tickManagedWorkflow } from '../managed/workflow-runtime.js'
import type { ServiceComponent, ServiceComponentContext, ServiceTickResult } from './runtime.js'

export interface ManagedComponentOptions {
  readonly worker: ManagedTicketWorker
  readonly infer: ManagedInference
  readonly taskId?: string
  readonly ticketTaskId?: string
  readonly workflowId?: string
}

/**
 * managed 组件先处理天问，再交替领取 ticket / workflow。
 *
 * 交替是进程内公平性；数据库侧 claim 还按项目取最久未推进的一条，
 * 防止一个项目长期占满所有机会。某个角色空闲时立即尝试另一个。
 */
export function createManagedComponent(options: ManagedComponentOptions): ServiceComponent {
  let next: 'ticket' | 'workflow' = 'ticket'
  return {
    name: 'managed',
    intervalMs: 1_000,
    async tick(context): Promise<ServiceTickResult> {
      await context.heartbeat({ phase: 'managed', next })
      if (options.worker.decide !== undefined) {
        const pending = await tickPendingTicketTianwen(options.worker.decide, options.ticketTaskId)
        if (!pending.ok) throw pending.error
        if (pending.value !== null) {
          return {
            worked: true,
            checkpoint: {
              phase: 'decision',
              task_id: pending.value.taskId,
              request_id: pending.value.requestId,
              status: pending.value.status,
            },
          }
        }
      }

      const investigation = await tickManaged(options.infer, options.taskId)
      if (!investigation.ok) throw investigation.error
      if (investigation.value !== null) {
        return {
          worked: true,
          checkpoint: {
            phase: 'investigation',
            task_id: investigation.value.taskId,
            status: investigation.value.status,
          },
        }
      }

      const order: readonly ('ticket' | 'workflow')[] = [
        next,
        next === 'ticket' ? 'workflow' : 'ticket',
      ]
      for (const kind of order) {
        if (kind === 'ticket') {
          const ticket = await tickManagedTicket(options.worker, options.ticketTaskId)
          if (!ticket.ok) throw ticket.error
          if (ticket.value !== null) {
            next = 'workflow'
            return {
              worked: true,
              checkpoint: {
                phase: 'ticket',
                task_id: ticket.value.taskId,
                stage: ticket.value.stage,
                status: ticket.value.status,
              },
            }
          }
        } else {
          const workflow = await tickManagedWorkflow(options.worker, options.workflowId)
          if (!workflow.ok) throw workflow.error
          if (workflow.value !== null) {
            next = 'ticket'
            return {
              worked: true,
              checkpoint: {
                phase: 'workflow',
                workflow_id: workflow.value.workflowId,
                status: workflow.value.status,
                action: workflow.value.action,
              },
            }
          }
        }
      }
      return { worked: false, checkpoint: { phase: 'idle', next } }
    },
  }
}

interface StaleMemoryProject {
  readonly project_id: string
  readonly latest_seq: string | number
  readonly epoch: string | number
}

async function listStaleMemoryProjects(limit: number): Promise<readonly StaleMemoryProject[]> {
  return asRole('keel_control', async (c) => {
    const result = await c.query<StaleMemoryProject>(
      `WITH project_heads AS (
         SELECT r.id AS project_id,
                COALESCE(s.epoch,0) AS epoch,
                s.active_summary_id,
                COALESCE((
                  SELECT max(c.seq) FROM managed_decision_change c
                  WHERE c.project_id=r.id
                ),0) AS latest_seq
         FROM repo r
         LEFT JOIN managed_project_memory_state s ON s.project_id=r.id
         WHERE EXISTS (
           SELECT 1 FROM managed_project_decision d WHERE d.project_id=r.id
         )
       ), stale AS (
         SELECT p.*, a.covered_change_seq, a.memory_epoch
         FROM project_heads p
         LEFT JOIN managed_project_memory_summary a ON a.id=p.active_summary_id
         WHERE p.active_summary_id IS NULL
            OR a.covered_change_seq < p.latest_seq
            OR a.memory_epoch < p.epoch
       )
       SELECT st.project_id,st.latest_seq,st.epoch
       FROM stale st
       WHERE NOT EXISTS (
         SELECT 1 FROM managed_project_memory_summary d
         WHERE d.project_id=st.project_id
           AND d.status='DRAFT'
           AND d.memory_epoch=st.epoch
           AND d.covered_change_seq >= st.latest_seq
       )
       ORDER BY st.latest_seq DESC,st.project_id
       LIMIT $1`,
      [limit],
    )
    return result.rows
  })
}

/**
 * 摘要组件只生成 DRAFT，不自动发布。
 *
 * 发布/回滚仍需要 owner 的显式命令与回归集；后台自动替换可信摘要会扩大
 * “模型输出被当成事实”的风险。生成失败时保留现有 ACTIVE 摘要与增量检索。
 */
export function createMemoryComponent(
  options: { readonly generatedBy?: string; readonly batchSize?: number } = {},
): ServiceComponent {
  const generatedBy = options.generatedBy ?? 'keel-service'
  const batchSize = options.batchSize ?? 2
  return {
    name: 'memory',
    intervalMs: 30_000,
    async tick(context): Promise<ServiceTickResult> {
      const now = context.now()
      const stale = await listStaleMemoryProjects(batchSize)
      const created: string[] = []
      for (const project of stale) {
        const summary = await createProjectMemorySummary({
          project_id: project.project_id,
          generated_by: generatedBy,
          now,
        })
        if (!summary.ok) throw summary.error
        created.push(summary.value.id)
      }
      return {
        worked: created.length > 0,
        checkpoint: {
          phase: 'summary',
          stale_projects: stale.length,
          drafts_created: created.length,
          ...(created.length === 0 ? {} : { draft_ids: created }),
        },
      }
    },
  }
}

/**
 * 巡检组件复用 timer-worker 的 drain 与 progress 模式下的孤儿巡检。
 * 它不接管 legacy task 状态机的决策，只收割已到期 timer/停滞 run。
 */
export function createMaintenanceComponent(options: {
  readonly workerDeps: WorkerDeps
  readonly intervalMs?: number
}): ServiceComponent {
  return {
    name: 'maintenance',
    intervalMs: options.intervalMs ?? 5_000,
    async tick(_context): Promise<ServiceTickResult> {
      const stats = await drainAllDueTimers(options.workerDeps)
      // progress 模式下 drainAllDueTimers 已经执行巡检；这里不能再跑一次，
      // 否则同一轮会重复收割并放大日志与竞争。
      const patrol = stats.patrol
      const worked =
        stats.clarificationFired +
          stats.humanReviewFired +
          stats.humanReviewArmed +
          stats.runTimeout +
          patrol.reaped +
          patrol.orphansKilled >
        0
      if (patrol.error !== null) throw new Error(patrol.error)
      return {
        worked,
        checkpoint: {
          phase: 'maintenance',
          clarification_fired: stats.clarificationFired,
          human_review_fired: stats.humanReviewFired,
          human_review_armed: stats.humanReviewArmed,
          run_timeout: stats.runTimeout,
          patrol_reaped: patrol.reaped,
          patrol_orphans_killed: patrol.orphansKilled,
        },
      }
    },
  }
}

export function createOutboxComponent(options: {
  readonly deps: ManagedActionGatewayDeps
  readonly intervalMs?: number
  readonly reconcileIntervalMs?: number
}): ServiceComponent {
  let lastReconcileAt = 0
  const reconcileIntervalMs = options.reconcileIntervalMs ?? 60_000
  return {
    name: 'outbox',
    intervalMs: options.intervalMs ?? 2_000,
    async tick(context): Promise<ServiceTickResult> {
      const now = Date.parse(context.now())
      let reconciled = 0
      if (now - lastReconcileAt >= reconcileIntervalMs) {
        const result = await reconcileUncertainActions(options.deps)
        if (!result.ok) throw result.error
        reconciled = result.value.length
        lastReconcileAt = now
      }
      const action = await runActionGatewayOnce(options.deps)
      if (!action.ok) throw action.error
      return {
        worked: action.value !== null || reconciled > 0,
        checkpoint: {
          phase: 'outbox',
          reconciled,
          ...(action.value === null
            ? {}
            : {
                outbox_id: action.value.outboxId,
                task_id: action.value.taskId,
                status: action.value.status,
              }),
        },
      }
    },
  }
}

export function createChecksComponent(options: {
  readonly deps: ManagedCheckGatewayDeps
  readonly intervalMs?: number
}): ServiceComponent {
  return {
    name: 'checks',
    intervalMs: options.intervalMs ?? 10_000,
    async tick(): Promise<ServiceTickResult> {
      const result = await runCheckGatewayOnce(options.deps)
      if (!result.ok) throw result.error
      return {
        worked: result.value !== null,
        checkpoint: {
          phase: 'checks',
          ...(result.value === null
            ? {}
            : {
                target_id: result.value.targetId,
                task_id: result.value.taskId,
                status: result.value.status,
              }),
        },
      }
    },
  }
}

export async function tickServiceComponent(
  component: ServiceComponent,
  context: ServiceComponentContext,
): Promise<ServiceTickResult> {
  if (component.tick === undefined) throw new Error(`组件 ${component.name} 不是 tick 模式`)
  return component.tick(context)
}
