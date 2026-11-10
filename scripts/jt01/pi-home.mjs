#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const PROVIDER = 'magpie'
const BASE_URL = 'http://127.0.0.1:3425/v1'
const MODEL_ID = 'opencode-go/deepseek-v4.1-flash'
const USAGE = '用法：pi-home.mjs <尚不存在的绝对输出目录>'

function fail(message) {
  console.error(`jt01-pi-home: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
if (args.length !== 1 || !isAbsolute(args[0])) fail(USAGE)

const home = resolve(args[0])
if (home === '/' || existsSync(home)) fail(`输出目录必须尚不存在：${home}`)

const agentDir = join(home, '.pi', 'agent')
mkdirSync(agentDir, { recursive: true, mode: 0o700 })
for (const dir of [home, join(home, '.pi'), agentDir]) chmodSync(dir, 0o700)

const models = {
  providers: {
    [PROVIDER]: {
      baseUrl: BASE_URL,
      api: 'openai-completions',
      apiKey: 'jt01-placeholder',
      models: [
        {
          id: MODEL_ID,
          name: MODEL_ID,
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262144,
          maxTokens: 32768,
        },
      ],
    },
  },
}

const settings = {
  defaultProvider: PROVIDER,
  defaultModel: MODEL_ID,
  defaultThinkingLevel: 'max',
}

writeFileSync(join(agentDir, 'models.json'), `${JSON.stringify(models, null, 2)}\n`, {
  mode: 0o600,
})
writeFileSync(join(agentDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, {
  mode: 0o600,
})

console.log(home)
