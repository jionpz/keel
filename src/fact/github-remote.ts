/**
 * GitHub remote URL / host 解析 —— 唯一事实源。
 *
 * 为什么单独成模块：`github-auth.ts`(git 传输认证)与 `github-provider.ts`(REST)
 * 都要解析 host，但 provider 又从 auth 引入 `readTokenFromEnv`。
 * 若 parse 留在 provider、auth 反向 import provider，就构成循环依赖
 * (`no-circular` 会红)。把纯 URL 解析下沉到这里，两边都只依赖它。
 *
 * 本文件只做字符串解析，不发请求、不读凭据。
 */

import { err, makeError, ok, type Result } from '../contracts/errors.js'

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const REPO_RE = /^[A-Za-z0-9._-]+$/

/**
 * 接受 github.com 与企业 GHES 的常见域名 `github.*`（如 github.example.com、
 * github.corp.example）。刻意不接受任意 host：本 provider 是 GitHub 专用，
 * 把 gitlab.com 之类当成 GHES 只会把请求打到错误的服务。
 */
export function isGitHubHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'github.com' || (h.startsWith('github.') && !h.startsWith('github.com.'))
}

export interface ParsedRemote {
  readonly host: string
  readonly owner: string
  readonly repo: string
  /** 归一化后的 https remote，用于事件与 repo 查找 */
  readonly remoteUrl: string
}

/**
 * 解析 remote URL —— owner/repo 与 host 的唯一事实源。
 *
 * 支持 https / http / ssh 与 SCP-like（git@host:owner/repo.git）。
 * 不接受 file:// 等本地路径：它们不是 GitHub remote。
 */
export function parseRemoteUrl(remoteUrl: string): Result<ParsedRemote> {
  const trimmed = remoteUrl.trim()
  let host: string
  let path: string

  // SCP-like 语法不会被 new URL() 正确解析，先单独处理
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed)
  if (scp !== null) {
    host = scp[1] as string
    path = scp[2] as string
  } else {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return err(makeError('WORKSPACE_ERROR', `无法解析 remote URL:${remoteUrl}`))
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'ssh:') {
      return err(makeError('WORKSPACE_ERROR', `不支持的 remote 协议:${url.protocol}`))
    }
    host = url.hostname
    path = url.pathname
  }

  if (!isGitHubHost(host)) {
    return err(makeError('WORKSPACE_ERROR', `不是 GitHub host:${host}(${remoteUrl})`))
  }

  const normalized = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  const parts = normalized.split('/')
  if (parts.length !== 2) {
    return err(makeError('WORKSPACE_ERROR', `无法从 remote URL 解析 owner/repo:${remoteUrl}`))
  }
  const owner = parts[0] as string
  const repo = parts[1] as string
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') {
    return err(makeError('WORKSPACE_ERROR', `owner/repo 非法:${owner}/${repo}`))
  }

  const normalizedHost = host.toLowerCase()
  return ok({
    host: normalizedHost,
    owner,
    repo,
    remoteUrl: `https://${normalizedHost}/${owner}/${repo}.git`,
  })
}
