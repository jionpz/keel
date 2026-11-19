import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { HarnessDescriptor } from '../contracts/harness-adapter.js'
import { fixtureStageInput } from '../control/managed/ticket-test-utils.js'
import { OmpAdapter } from './adapters/omp.js'
import { createIsolatedTicketWorker, stageTimeoutsFor } from './isolated-ticket-worker.js'
import { type ModelRouteTable, type ModelRoutingSettings, TIMEOUT_STAGES } from './model-routing.js'
import { ticketWorkerFromAdapter } from './ticket-stage-runner.js'

const DESCRIPTOR: HarnessDescriptor = {
  harness_id: 'omp',
  version: 'fixture',
  tier: 'L0',
  capabilities: [],
  tool_inventory: ['read'],
  cost_basis: 'unavailable',
  limits: { max_input_bytes: null, max_wall_clock_s: null },
}

function routing(omp: ModelRouteTable, pi?: ModelRouteTable): ModelRoutingSettings {
  return {
    profile: 'team-a',
    profiles: { profiles: { 'team-a': { omp, ...(pi === undefined ? {} : { pi }) } } },
    allowlist: [],
  }
}

function maxRunMs(settings: ModelRoutingSettings): number | undefined {
  return createIsolatedTicketWorker({ harness: 'omp', routing: settings, descriptor: DESCRIPTOR })
    .maxRunMs
}

describe('managed 写执行 worker 的阶段上限', () => {
  it('写了 timeout_s 的阶段用配置值，其余阶段保持 900 秒', () => {
    const timeouts = stageTimeoutsFor(
      routing({ stages: { execute: { timeout_s: 1800 }, review: { model: 'm' } } }),
      'omp',
    )
    expect(TIMEOUT_STAGES.map((stage) => [stage, timeouts(stage)])).toEqual([
      ['plan', 900_000],
      ['execute', 1_800_000],
      ['verify', 900_000],
      ['review', 900_000],
      ['land', 900_000],
    ])
  })

  it('没有 profile 时每个阶段都是 900 秒', () => {
    const timeouts = stageTimeoutsFor({ allowlist: [] }, 'omp')
    expect(TIMEOUT_STAGES.map(timeouts)).toEqual([900_000, 900_000, 900_000, 900_000, 900_000])
  })

  it('只读所选 harness 的表，不把别的 harness 的上限串过来', () => {
    const settings = routing(
      { stages: { execute: { timeout_s: 1800 } } },
      { stages: { execute: { timeout_s: 7200 } } },
    )
    expect(stageTimeoutsFor(settings, 'omp')('execute')).toBe(1_800_000)
    expect(stageTimeoutsFor(settings, 'pi')('execute')).toBe(7_200_000)
    expect(maxRunMs(settings)).toBe(1_800_000)
  })

  it('maxRunMs 是各阶段上限里最长的那个，租约由它派生', () => {
    expect(maxRunMs({ allowlist: [] })).toBe(900_000)
    expect(
      maxRunMs(routing({ stages: { execute: { timeout_s: 1800 }, verify: { timeout_s: 3600 } } })),
    ).toBe(3_600_000)
  })

  it('五个阶段都调短时 maxRunMs 仍是 900 秒：天问按缺省上限运行，租约要盖住它', () => {
    const short = Object.fromEntries(TIMEOUT_STAGES.map((stage) => [stage, { timeout_s: 60 }]))
    expect(maxRunMs(routing({ stages: short }))).toBe(900_000)
  })

  it('配置的上限出现在真实 OMP 命令行的 --max-time 上', async () => {
    const calls: string[][] = []
    const spawnFn = ((_bin: string, args: readonly string[]) => {
      calls.push([...args])
      const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable }
      child.stdout = Readable.from([
        '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"{}"}]}]}\n',
      ])
      child.stderr = Readable.from([])
      child.stdout.on('end', () => child.emit('close', 0))
      return child
    }) as unknown as typeof spawn
    const worker = ticketWorkerFromAdapter(
      new OmpAdapter({ spawnFn }),
      stageTimeoutsFor(routing({ stages: { execute: { timeout_s: 1800 } } }), 'omp'),
    )
    expect((await worker.run(fixtureStageInput('execute'))).ok).toBe(true)
    expect((await worker.run(fixtureStageInput('verify'))).ok).toBe(true)
    expect(calls.map((argv) => argv.find((arg) => arg.startsWith('--max-time=')))).toEqual([
      '--max-time=1800',
      '--max-time=900',
    ])
  })
})
