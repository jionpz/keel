#!/usr/bin/env node
/**
 * Phase 0 spike：验证 OMP 在 `-p --mode=json` 下是否在运行期间逐行输出事件。
 *
 * 用法：
 *   node .trellis/tasks/11-04-run-liveness-patrol/research/omp-flush-spike.mjs
 *
 * 环境变量：
 *   OMP_BIN    默认 `omp`
 *   OMP_MODEL  默认 `magpie/workbuddy-ai/hy3`（本机可用；不是 Keel 的默认模型）
 *   OMP_PROMPT 默认让模型调用 bash 执行 `sleep 4`，制造一个可观测的静默窗口
 *
 * 只读实验：不改生产代码，不写 Keel 数据库。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bin = process.env.OMP_BIN ?? 'omp'
const model = process.env.OMP_MODEL ?? 'magpie/workbuddy-ai/hy3'
const prompt =
  process.env.OMP_PROMPT ??
  'Use the bash tool to run `sleep 4`, then reply with exactly DONE and nothing else.'
const cwd = mkdtempSync(join(tmpdir(), 'omp-flush-spike-'))

const args = [
  '-p',
  '--mode=json',
  '--model',
  model,
  '--cwd',
  cwd,
  '--no-extensions',
  '--no-skills',
  '--no-rules',
  '--tools=bash',
  '--approval-mode=yolo',
  '--max-time=60',
  prompt,
]

const startedAt = Date.now()
const rows = []
let buffer = ''
let stderr = ''

const child = spawn(bin, args, {
  cwd,
  // 与 src/execution/adapters/omp.ts 一致：stdin 必须关闭，否则 OMP 会等输入
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})

function record(line) {
  if (line.trim() === '') return
  let type = 'non-json'
  let nested = null
  try {
    const event = JSON.parse(line)
    type = typeof event.type === 'string' ? event.type : 'unknown'
    if (event.type === 'message_update' && typeof event.assistantMessageEvent?.type === 'string') {
      nested = event.assistantMessageEvent.type
    }
  } catch {
    // 保留非 JSON 行，方便发现协议变化
  }
  rows.push({ ms: Date.now() - startedAt, type, nested })
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    record(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
  }
})

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8')
})

child.on('error', (error) => {
  console.error(JSON.stringify({ error: error.message }, null, 2))
  process.exitCode = 1
})

child.on('close', (code) => {
  if (buffer.trim() !== '') record(buffer)
  const endedAt = Date.now() - startedAt

  const byType = new Map()
  for (const row of rows) {
    const key = row.nested === null ? row.type : `${row.type}:${row.nested}`
    const entry = byType.get(key) ?? { count: 0, firstMs: row.ms, lastMs: row.ms }
    entry.count += 1
    entry.lastMs = row.ms
    byType.set(key, entry)
  }

  let maxGap = { ms: 0, before: null, after: null }
  for (let index = 1; index < rows.length; index += 1) {
    const gap = rows[index].ms - rows[index - 1].ms
    if (gap > maxGap.ms) {
      maxGap = { ms: gap, before: rows[index - 1].type, after: rows[index].type }
    }
  }

  const turnStart = rows.find((row) => row.type === 'turn_start')
  const agentEnd = rows.find((row) => row.type === 'agent_end')
  const first = rows[0]
  const last = rows.at(-1)

  console.log(
    JSON.stringify(
      {
        bin,
        model,
        cwd,
        exitCode: code,
        endedAtMs: endedAt,
        lineCount: rows.length,
        firstMs: first?.ms ?? null,
        lastMs: last?.ms ?? null,
        turnStartMs: turnStart?.ms ?? null,
        agentEndMs: agentEnd?.ms ?? null,
        // 关键判据：turn_start 是否显著早于进程结束
        turnStartBeforeExitMs: turnStart === undefined ? null : endedAt - turnStart.ms,
        outputSpanMs: first === undefined || last === undefined ? null : last.ms - first.ms,
        maxGap,
        byType: Object.fromEntries(byType),
        stderrTail: stderr.slice(-2000),
      },
      null,
      2,
    ),
  )
})
