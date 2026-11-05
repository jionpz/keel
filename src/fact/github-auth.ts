/**
 * GitHub 凭据的纯逻辑 —— token 读取、git http 传输认证注入、错误脱敏。
 *
 * 凭据纪律（docs/08-cross-cutting.md §1.3、任务 design.md §1）：
 *   - token 来源优先级：`KEEL_GITHUB_TOKEN` → `GITHUB_TOKEN` → `gh auth token`；
 *   - 注入只对**单次** git 子进程生效，不写全局/仓库级 git config；
 *   - token 不进 remote URL、不进 argv、不进错误 detail / 事件 payload / 日志。
 *
 * 为什么用 `GIT_CONFIG_COUNT` 而不是 `-c`：
 * `-c http.<host>.extraheader=...` 的值会出现在进程 argv（同机 `ps` 可见），
 * 也会出现在 `execFile` 抛出的错误消息里。环境变量等价、同样只作用于本次调用，
 * 但 token 不经过 argv。
 */

import { execFile } from 'node:child_process'
import { parseRemoteUrl } from './github-remote.js'

/**
 * 从进程环境读 GitHub token（`KEEL_GITHUB_TOKEN` 优先，其次 `GITHUB_TOKEN`）。
 *
 * 返回原值，包括空字符串 —— 与 provider 原有行为一致。空白值由
 * `authEnvFor` 的 `isUsableToken` 过滤，不会生成任何认证 header。
 */
export function readTokenFromEnv(): string | undefined {
  return process.env.KEEL_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN
}

/** 解析器注入点：按 hostname 返回可用 token；无凭据时返回 `undefined`（不抛） */
export type TokenResolver = (host: string) => Promise<string | undefined>

export interface TokenResolveDeps {
  readonly env?: NodeJS.ProcessEnv
  /** 测试注入；缺省真的调用 `gh` */
  readonly runGh?: (host: string) => Promise<string | undefined>
}

const DEFAULT_GITHUB_HOST = 'github.com'
const GH_TIMEOUT_MS = 5_000
/** token 只有几十字节；上限给小值，避免意外的大输出常驻内存 */
const GH_MAX_BUFFER = 64 * 1024

function firstUsableEnvToken(env: NodeJS.ProcessEnv): string | undefined {
  for (const raw of [env.KEEL_GITHUB_TOKEN, env.GITHUB_TOKEN]) {
    if (raw === undefined) continue
    const trimmed = raw.trim()
    if (trimmed !== '') return trimmed
  }
  return undefined
}

/**
 * 调 `gh auth token --hostname <host>` 复用本机登录态。
 *
 * 任何失败都归为 `undefined`：gh 不存在（ENOENT）、未登录、超时、输出空白
 * 对调用方是同一件事。**错误对象与 stderr 不外带** —— 错误文本里可能含凭据，
 * 解析器不把它带进我们的错误链路。
 */
function runGhAuthToken(host: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['auth', 'token', '--hostname', host],
      { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined)
          return
        }
        const token = stdout.trim()
        resolve(token === '' ? undefined : token)
      },
    )
  })
}

/**
 * 解析 GitHub token —— 来源优先级固定：
 *
 * ```
 * 非空 KEEL_GITHUB_TOKEN > 非空 GITHUB_TOKEN > gh auth token --hostname <host>
 * ```
 *
 * 空白值等同未设置（`KEEL_GITHUB_TOKEN=''` 不得遮蔽 `gh` 的登录态）。
 * 纯读函数，**不做进程级缓存**：缓存放在调用方实例上，避免测试互相污染，
 * 也避免「token 轮换后进程仍拿旧值」的歧义。
 */
export async function resolveGitHubToken(
  host: string = DEFAULT_GITHUB_HOST,
  deps: TokenResolveDeps = {},
): Promise<string | undefined> {
  const fromEnv = firstUsableEnvToken(deps.env ?? process.env)
  if (fromEnv !== undefined) return fromEnv

  const runGh = deps.runGh ?? runGhAuthToken
  try {
    const fromGh = await runGh(host)
    if (fromGh === undefined) return undefined
    const trimmed = fromGh.trim()
    return trimmed === '' ? undefined : trimmed
  } catch {
    // gh 缺失 / 超时 / 任何异常一律按「未登录」处理；异常内容可能含凭据，吞掉
    return undefined
  }
}

/** GitHub 接受 `oauth2:<token>` 作为 basic 认证的用户名。 */
function basicCredential(token: string): string {
  return Buffer.from(`oauth2:${token}`).toString('base64')
}

function isUsableToken(token: string | undefined): token is string {
  return token !== undefined && token.trim() !== ''
}

/**
 * 为一次 git 网络调用构造「只对本子进程生效」的 config 环境。
 *
 * 返回空对象的情形（任一即返回 `{}`）：
 *   - 没有 token，或 token 为空白；
 *   - remote 解析失败（让 git 自己报错，不在认证层吞掉解析错误）；
 *   - 非 http(s) remote（ssh / SCP-like 走部署方 ssh key，代码不碰凭据）。
 *
 * 已存在的 `GIT_CONFIG_COUNT` 会**追加**而不是覆盖：操作者可能有自己的
 * `GIT_CONFIG_KEY_*`；把计数重置为 1 会让那些配置静默失效。
 * 非数字的既有值按 0 处理 —— 不继承脏值，但也不替 git 拒绝。
 *
 * `baseEnv` 只用于读取既有计数，默认进程环境；单独暴露是为了测试不污染全局。
 */
export function authEnvFor(
  remoteUrl: string,
  token: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!isUsableToken(token)) return {}

  const trimmed = remoteUrl.trim()
  let scheme: 'http' | 'https'
  if (/^https:\/\//i.test(trimmed)) scheme = 'https'
  else if (/^http:\/\//i.test(trimmed)) scheme = 'http'
  else return {}

  const parsed = parseRemoteUrl(trimmed)
  if (!parsed.ok) return {}

  const start = nextConfigIndex(baseEnv.GIT_CONFIG_COUNT)
  return {
    GIT_CONFIG_COUNT: String(start + 1),
    [`GIT_CONFIG_KEY_${start}`]: `http.${scheme}://${authorityFor(trimmed)}/.extraheader`,
    [`GIT_CONFIG_VALUE_${start}`]: `AUTHORIZATION: basic ${basicCredential(token)}`,
  }
}

/**
 * extraheader 的作用域必须按**实际请求的 authority** 写，不能只用 hostname。
 *
 * git 对 `http.<url>.*` 的匹配规则：省略端口时按 scheme 的默认端口处理
 * （`man git-config` §http.<url>.*：「Omitted port numbers are automatically
 * converted to the correct default for the scheme before matching」）。
 * 所以 `https://host:8443/o/r.git` 的 remote 若写成 `http.https://host/...`，
 * 认证**不会生效**，私有仓库又回到 `could not read Username`。
 *
 * `URL.host` 自带相反方向的便利：默认端口（443/80）会被省掉，
 * 非默认端口会被保留 —— 与 git 的匹配语义正好一致。
 */
function authorityFor(remoteUrl: string): string {
  return new URL(remoteUrl).host
}

function nextConfigIndex(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return 0
  return Number(raw.trim())
}

/**
 * 可能出现在 git 输出里的凭据形态。
 *
 * `GIT_CONFIG_VALUE_*` 里是 base64，而不是明文 token —— 只脱敏明文会漏掉它。
 */
export function gitAuthSecrets(token: string | undefined): readonly string[] {
  if (!isUsableToken(token)) return []
  return [...new Set([token, basicCredential(token)])]
}

/**
 * 把文本里的凭据替换成 `***`。
 *
 * 用 split/join 而不是 `replaceAll(secret, ...)` + 正则：base64 含 `+/=`，
 * 走字符串匹配不需要转义。空 secret 跳过，否则会在每个字符间插入 `***`。
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret === '') continue
    out = out.split(secret).join('***')
  }
  return out
}
