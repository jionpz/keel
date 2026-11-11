import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ManagedTicketWorker } from '../control/managed/ticket-runtime.js'
import type { ServiceComponent, ServiceSignalSource } from '../control/service/runtime.js'
import { asOwner, closePool } from '../fact/db.js'
import type { ResidentLock, ResidentRole } from '../fact/resident-lock.js'
import { serveMain } from './service.js'

class FakeSignals implements ServiceSignalSource {
  private readonly handlers = new Map<'SIGTERM' | 'SIGINT', () => void>()

  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void {
    this.handlers.set(signal, handler)
  }

  off(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void {
    if (this.handlers.get(signal) === handler) this.handlers.delete(signal)
  }

  emit(signal: 'SIGTERM' | 'SIGINT'): void {
    this.handlers.get(signal)?.()
  }
}

const worker = {
  harness: 'pi',
  toolInventory: [],
  run: async () => ({ ok: false, error: { kind: 'HARNESS_UNAVAILABLE', detail: 'fixture' } }),
} as unknown as ManagedTicketWorker

beforeEach(async () => {
  await asOwner((c) => c.query('DELETE FROM worker_health'))
})

afterAll(closePool)

describe('serveMain', () => {
  it('以 --no-ingress 启动统一服务，获取两把锁并在信号后释放', async () => {
    const signals = new FakeSignals()
    const roles: ResidentRole[] = []
    const released: ResidentRole[] = []
    const acquireLock = async (role: ResidentRole): Promise<ResidentLock | null> => {
      roles.push(role)
      return {
        role,
        release: async () => {
          released.push(role)
        },
      }
    }
    const components: ServiceComponent[] = [
      {
        name: 'managed',
        intervalMs: 1,
        tick: async () => {
          signals.emit('SIGTERM')
          return { worked: false }
        },
      },
    ]
    const previousExitCode = process.exitCode
    try {
      await serveMain(['--no-ingress', '--harness', 'pi'], {
        acquireLock,
        signals,
        components,
        worker,
        closePool: async () => undefined,
      })
      expect(process.exitCode).toBe(previousExitCode)
    } finally {
      process.exitCode = previousExitCode
    }
    expect(roles).toEqual(['keel-service', 'timer-worker'])
    expect(released.sort()).toEqual(['keel-service', 'timer-worker'])
  })
})
