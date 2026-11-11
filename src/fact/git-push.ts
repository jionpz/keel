import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type {
  GitPushGateway,
  GitPushInput,
  GitPushInspectInput,
  GitPushInspectResult,
  GitPushResult,
} from '../contracts/git-push.js'
import { authEnvFor, gitAuthSecrets, redactSecrets, resolveGitHubToken } from './github-auth.js'
import { parseRemoteUrl } from './github-remote.js'

const run = promisify(execFile)
const BRANCH = /^ai\/[A-Za-z0-9._/-]+$/

function validBranch(branch: string): boolean {
  return (
    BRANCH.test(branch) &&
    branch.length <= 300 &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.startsWith('ai//') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.endsWith('.lock')
  )
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? homedir(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    GIT_ASKPASS_REQUIRE: 'never',
    LANG: 'C',
    LC_ALL: 'C',
  }
}

function gitEnv(remoteUrl: string, token: string | undefined): NodeJS.ProcessEnv {
  const env = baseEnv()
  return { ...env, ...authEnvFor(remoteUrl, token, env) }
}

function failure(error: unknown, token: string | undefined, fallback: string): Result<never> {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
  const text = redactSecrets(raw, gitAuthSecrets(token)).slice(0, 2000)
  if (/authentication failed|could not read username|terminal prompts disabled/i.test(text))
    return err(makeError('AUTH_FAILED', `git 认证失败：${text}`))
  if (/permission denied|not authorized|access denied/i.test(text))
    return err(makeError('PERMISSION_DENIED', `git 推送被拒绝：${text}`))
  return err(makeError('HARNESS_UNAVAILABLE', `git 命令失败：${text}`))
}

async function lsRemote(
  input: GitPushInspectInput,
  token: string | undefined,
): Promise<Result<GitPushInspectResult>> {
  if (!validBranch(input.headBranch))
    return err(makeError('SCHEMA_VIOLATION', `不允许的 head 分支：${input.headBranch}`))
  let stdout: string
  try {
    const result = await run(
      'git',
      [
        '-C',
        input.worktreePath,
        '-c',
        'credential.helper=',
        'ls-remote',
        '--heads',
        input.remoteUrl,
        `refs/heads/${input.headBranch}`,
      ],
      {
        encoding: 'utf8',
        env: gitEnv(input.remoteUrl, token),
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      },
    )
    stdout = result.stdout
  } catch (error) {
    return failure(error, token, 'git ls-remote 失败')
  }
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.endsWith(`refs/heads/${input.headBranch}`))
  if (line === undefined) return ok({ state: 'absent', headSha: null })
  const sha = line.split(/\s+/)[0] ?? ''
  if (!/^[a-f0-9]{40}$/.test(sha))
    return err(makeError('PROTOCOL_ERROR', `远端分支摘要无效：${sha}`))
  return ok({ state: 'present', headSha: sha })
}

export class GitCliPushGateway implements GitPushGateway {
  private readonly fixedToken: string | null | undefined

  constructor(token?: string | null) {
    this.fixedToken = token
  }

  private async tokenFor(remoteUrl: string): Promise<string | undefined> {
    if (this.fixedToken !== undefined) return this.fixedToken ?? undefined
    const parsed = parseRemoteUrl(remoteUrl)
    if (!parsed.ok) return undefined
    return resolveGitHubToken(parsed.value.host)
  }

  async inspect(input: GitPushInspectInput): Promise<Result<GitPushInspectResult>> {
    return lsRemote(input, await this.tokenFor(input.remoteUrl))
  }

  async push(input: GitPushInput): Promise<Result<GitPushResult>> {
    if (!/^[a-f0-9]{40}$/.test(input.headSha))
      return err(makeError('SCHEMA_VIOLATION', `head SHA 必须是完整 40 位：${input.headSha}`))
    if (!validBranch(input.headBranch))
      return err(makeError('SCHEMA_VIOLATION', `不允许的 head 分支：${input.headBranch}`))
    const token = await this.tokenFor(input.remoteUrl)
    const before = await lsRemote(input, token)
    if (!before.ok) return before
    if (before.value.state === 'present' && before.value.headSha === input.headSha)
      return ok({ headSha: input.headSha, created: false })
    if (before.value.state === 'present')
      return err(
        makeError(
          'CONFLICT',
          `远端分支 ${input.headBranch} 已存在且指向 ${before.value.headSha ?? '未知 SHA'}，拒绝覆盖`,
        ),
      )
    try {
      await run(
        'git',
        [
          '-C',
          input.worktreePath,
          '-c',
          'credential.helper=',
          'push',
          input.remoteUrl,
          `${input.headSha}:refs/heads/${input.headBranch}`,
        ],
        {
          encoding: 'utf8',
          env: gitEnv(input.remoteUrl, token),
          maxBuffer: 8 * 1024 * 1024,
          timeout: 120_000,
        },
      )
    } catch (error) {
      return failure(error, token, 'git push 失败')
    }
    const after = await lsRemote(input, token)
    if (!after.ok) return after
    if (after.value.state !== 'present' || after.value.headSha !== input.headSha)
      return err(
        makeError(
          'HARNESS_UNAVAILABLE',
          `push 后远端分支 ${input.headBranch} 未指向 ${input.headSha}，结果不确定`,
        ),
      )
    return ok({ headSha: input.headSha, created: true })
  }
}
