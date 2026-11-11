import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { RunSpec } from '../../contracts/harness-adapter.js'
import { ClaudeCodeAdapter } from './claude-code.js'
import { OmpAdapter } from './omp.js'
import { PiAdapter } from './pi.js'

const PI_STREAM = [
  '{"type":"session","version":3,"id":"0199a4c4-0000-7000-8000-000000000001","cwd":"/tmp"}',
  '{"type":"agent_start"}',
  '{"type":"turn_start"}',
  '{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending"}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}',
  '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}',
  '{"type":"agent_end","messages":[],"willRetry":false}',
  '{"type":"agent_settled","aborted":false}',
].join('\n')

const OMP_STREAM =
  '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"ok"}]}]}\n'

const CLAUDE_STREAM =
  '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1"}\n'

function spec(): RunSpec {
  return {
    run: { run_id: 'r1', task_id: 't1', stage: 'develop', role: 'Developer', attempt: 1 },
    idempotency_key: 't1/develop/1',
    workspace: { path: '/tmp', repo_id: 'repo1', branch: 'main', untrusted: true },
    context: {
      context_id: 'c1',
      recipe_id: 'ticket',
      recipe_version: '1',
      sections: [
        {
          id: 's1',
          source_ref: 'fixed:test',
          source_kind: 'fixed',
          priority: 'required',
          content: '回复 ok',
          tokens: 3,
        },
      ],
      total_tokens: 3,
      dropped: [],
    },
    output_contract: { schema_ref: 'ticket', mode: 'post_validate' },
    permissions: { allowed_tools: [], mode: 'deny_unlisted' },
    limits: { wall_clock_s: 30, budget_usd: null, max_turns: 1 },
  }
}

function recordingSpawn(stdout: string): {
  spawnFn: typeof spawn
  calls: { bin: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[]
} {
  const calls: { bin: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = []
  const spawnFn = ((bin: string, args: readonly string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ bin, args: [...args], env: opts?.env })
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      pid: number
    }
    child.pid = 45000
    child.stdout = Readable.from([stdout])
    child.stderr = Readable.from([])
    child.stdout.on('end', () => child.emit('close', 0))
    return child
  }) as unknown as typeof spawn
  return { spawnFn, calls }
}

const ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  HOME: '/tmp/keel-exec-test/home',
  TMPDIR: '/tmp/keel-exec-test/tmp',
}

describe('adapter 显式 env 注入', () => {
  it('Pi spawn 使用 opts.env，而不是宿主 process.env', async () => {
    const { spawnFn, calls } = recordingSpawn(PI_STREAM)
    const adapter = new PiAdapter({ spawnFn, env: ENV, autoSubagents: false })
    const started = await adapter.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await adapter.awaitResult(started.value)
    expect(calls[0]?.env).toEqual(ENV)
    expect(calls[0]?.env?.KEEL_GITHUB_TOKEN).toBeUndefined()
  })

  it('OMP spawn 使用 opts.env，而不是宿主 process.env', async () => {
    const { spawnFn, calls } = recordingSpawn(OMP_STREAM)
    const adapter = new OmpAdapter({ spawnFn, env: ENV, model: 'magpie/auto/deepseek-v4.1-flash' })
    const started = await adapter.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await adapter.awaitResult(started.value)
    expect(calls[0]?.env).toEqual(ENV)
  })

  it('Claude spawn 使用 opts.env，而不是宿主 process.env', async () => {
    const { spawnFn, calls } = recordingSpawn(CLAUDE_STREAM)
    const adapter = new ClaudeCodeAdapter({ spawnFn, env: ENV })
    const started = await adapter.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await adapter.awaitResult(started.value)
    expect(calls[0]?.env).toEqual(ENV)
    expect(calls[0]?.env?.KEEL_GITHUB_TOKEN).toBeUndefined()
  })
})
