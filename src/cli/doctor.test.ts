import { describe, expect, it } from 'vitest'
import { ok } from '../contracts/errors.js'
import { evaluateTrial } from '../control/trial.js'
import { collectDoctorReport, type DoctorDeps } from './doctor.js'

const NOW = '2026-11-11T00:00:00.000Z'
const MODEL = 'opencode-go/deepseek-v4.1-flash'

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    now: () => NOW,
    env: { KEEL_MODEL: MODEL },
    platform: 'linux',
    arch: 'arm64',
    nodeVersion: 'v24.14.1',
    database: async () => ({
      status: 'ready',
      worker_health_ready: true,
      trial_schema_ready: true,
      detail: null,
    }),
    githubToken: async () => 'token-is-not-in-report',
    trial: async () =>
      ok(
        evaluateTrial({
          observed_at: NOW,
          trial: null,
          metrics: {
            delegated_decisions: 0,
            human_confirmed_decisions: 0,
            owner_required_decisions: 0,
            denied_decisions: 0,
            completed_tasks: 0,
            open_questions: 0,
            uncertain_actions: 0,
            dead_letter_actions: 0,
            by_project: [],
          },
        }),
      ),
    run: (bin, args) => {
      if (args[0] === '--version') return { ok: true, output: `${bin} 1.2.3\n` }
      if (bin === 'claude' && args[0] === 'auth') {
        return { ok: true, output: '{"loggedIn":true}' }
      }
      if (bin === 'pi' && args[0] === 'auth') {
        return { ok: true, output: '{"status":"ready"}' }
      }
      if (bin === 'omp' && args[0] === 'models') {
        return {
          ok: true,
          output: JSON.stringify({
            models: [{ selector: MODEL }],
          }),
        }
      }
      return { ok: true, output: 'git version 2.50.0' }
    },
    ...over,
  }
}

describe('JT-07 doctor', () => {
  it('Linux + OMP 给出可运行矩阵，但不把未知 OMP 凭据冒充已验证', async () => {
    const report = await collectDoctorReport('omp', deps())
    expect(report.ok).toBe(true)
    expect(report.managed_read.supported).toBe(true)
    expect(report.github.credential).toBe('available')
    const omp = report.harnesses.find((harness) => harness.id === 'omp')
    expect(omp?.verification).toBe('native-live')
    expect(omp?.credentials.status).toBe('unknown')
    expect(report.warnings.join('\n')).toContain('凭据未验证')
    expect(JSON.stringify(report)).not.toContain('token-is-not-in-report')
  })

  it('macOS 明确阻断 managed 受控读取，不靠单元测试冒充平台能力', async () => {
    const report = await collectDoctorReport('omp', deps({ platform: 'darwin', arch: 'arm64' }))
    expect(report.ok).toBe(false)
    expect(report.blockers.join('\n')).toContain('/proc/self/fd')
  })

  it('Claude 没有原生 live 证据时保持 blocked', async () => {
    const report = await collectDoctorReport('claude', deps())
    expect(report.ok).toBe(false)
    expect(report.blockers.join('\n')).toContain('原生 live 验收')
    const claude = report.harnesses.find((harness) => harness.id === 'claude')
    expect(claude?.verification).toBe('deterministic-only')
    expect(claude?.credentials.status).toBe('ready')
  })

  it('已停止的试运行明确提示重新开始，不误报为样本不足', async () => {
    const report = await collectDoctorReport(
      'omp',
      deps({
        trial: async () =>
          ok(
            evaluateTrial({
              observed_at: NOW,
              trial: {
                id: 'trial-1',
                started_at: '2026-11-01T00:00:00.000Z',
                ended_at: '2026-11-08T00:00:00.000Z',
                stop_reason: 'owner stopped',
                note: null,
                project_ids: ['p1', 'p2'],
              },
              metrics: {
                delegated_decisions: 30,
                human_confirmed_decisions: 0,
                owner_required_decisions: 0,
                denied_decisions: 0,
                completed_tasks: 5,
                open_questions: 0,
                uncertain_actions: 0,
                dead_letter_actions: 0,
                by_project: [],
              },
            }),
          ),
      }),
    )
    expect(report.warnings.join('\n')).toContain('已停止')
  })

  it('Pi 凭据缺失与 GitHub 凭据缺失都进入明确 blocker', async () => {
    const report = await collectDoctorReport(
      'pi',
      deps({
        env: { KEEL_MODEL: MODEL },
        githubToken: async () => undefined,
        run: (bin, args) => {
          if (args[0] === '--version') return { ok: true, output: `${bin} 1.2.3\n` }
          if (bin === 'pi' && args[0] === 'auth') {
            return { ok: true, output: '{"status":"not_ready"}' }
          }
          if (bin === 'omp' && args[0] === 'models') {
            return { ok: true, output: '{"models":[]}' }
          }
          return { ok: true, output: '' }
        },
      }),
    )
    expect(report.ok).toBe(false)
    expect(report.blockers.join('\n')).toContain('Pi')
    expect(report.blockers.join('\n')).toContain('GitHub 凭据')
  })

  it('数据库未就绪时不读取试运行，也不把空数据解释成健康', async () => {
    const report = await collectDoctorReport(
      'omp',
      deps({
        database: async () => ({
          status: 'unavailable',
          worker_health_ready: false,
          trial_schema_ready: false,
          detail: 'postgres://secret@example/db connection refused',
        }),
        trial: async () => {
          throw new Error('不应读取试运行')
        },
      }),
    )
    expect(report.ok).toBe(false)
    expect(report.trial).toBeNull()
    expect(report.database.detail).toBe('postgres://*** connection refused')
  })
})
