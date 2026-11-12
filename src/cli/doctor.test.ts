import { describe, expect, it } from 'vitest'
import { ok } from '../contracts/errors.js'
import { evaluateTrial } from '../control/trial.js'
import { DEFAULT_SANDBOX_EXEC } from '../execution/isolation/os-sandbox.js'
import { collectDoctorReport, type DoctorDeps } from './doctor.js'

const NOW = '2026-11-11T00:00:00.000Z'
const MODEL = 'opencode-go/deepseek-v4.1-flash'

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    now: () => NOW,
    env: { KEEL_MODEL: MODEL },
    piModels: () => ({
      providers: {
        magpie: {
          baseUrl: 'http://127.0.0.1:3425/v1',
          models: [{ id: MODEL }],
        },
      },
    }),
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
  it('Pi 按注册模型选择本机 provider，模型 ID 中的斜杠不被误拆', async () => {
    const base = deps({ platform: 'darwin' })
    const authCalls: string[][] = []
    const report = await collectDoctorReport(
      'pi',
      {
        ...base,
        run: (bin, args) => {
          if (bin === 'pi' && args[0] === 'auth') {
            authCalls.push([...args])
            return {
              ok: args[3] === 'magpie',
              output: JSON.stringify({ status: args[3] === 'magpie' ? 'ready' : 'not_ready' }),
            }
          }
          return base.run?.(bin, args) ?? { ok: false, output: '' }
        },
      },
      'ticket',
    )
    expect(report.ok).toBe(true)
    expect(authCalls).toEqual([
      ['auth', 'check', '--provider', 'magpie', '--model', MODEL, '--json', '--no-refresh'],
    ])
    expect(report.harnesses.find((entry) => entry.id === 'pi')?.credentials.status).toBe('ready')
  })

  it('Pi 未注册模型或只有外网 provider 时阻断，不探测猜测出的凭据', async () => {
    for (const models of [
      { providers: {} },
      { providers: { external: { baseUrl: 'https://example.invalid', models: [{ id: MODEL }] } } },
    ]) {
      const report = await collectDoctorReport(
        'pi',
        deps({ platform: 'darwin', piModels: () => models }),
        'ticket',
      )
      expect(report.ok).toBe(false)
      expect(report.blockers.join('\n')).toContain('Pi managed 模型配置不可用')
    }
  })

  it('Linux full 因缺少写执行沙箱被阻断，但仍分别报告读取与凭据状态', async () => {
    const report = await collectDoctorReport('omp', deps())
    expect(report.ok).toBe(false)
    expect(report.scope).toBe('full')
    expect(report.managed_read.supported).toBe(true)
    expect(report.managed_write.supported).toBe(false)
    expect(report.blockers.join('\n')).toContain('managed_write')
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
    expect(report.managed_write.supported).toBe(true)
  })

  it('macOS ticket 范围只要求写沙箱，不把调查读取伪装成受支持', async () => {
    const report = await collectDoctorReport(
      'omp',
      deps({ platform: 'darwin', arch: 'arm64' }),
      'ticket',
    )
    expect(report.ok).toBe(true)
    expect(report.scope).toBe('ticket')
    expect(report.managed_read.supported).toBe(false)
    expect(report.managed_write).toMatchObject({
      supported: true,
      backend: 'macos-sandbox-exec',
    })
    expect(report.blockers).toEqual([])
  })

  it('sandbox-exec 无法启动时 macOS ticket 范围也阻断', async () => {
    const base = deps({ platform: 'darwin', arch: 'arm64' })
    const report = await collectDoctorReport(
      'omp',
      {
        ...base,
        run: (bin, args) => {
          if (bin === DEFAULT_SANDBOX_EXEC) return { ok: false, output: '' }
          return base.run?.(bin, args) ?? { ok: false, output: '' }
        },
      },
      'ticket',
    )
    expect(report.ok).toBe(false)
    expect(report.managed_write.supported).toBe(false)
    expect(report.blockers.join('\n')).toContain('sandbox-exec')
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
