import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractKeywords, GitHubRepoSignals } from './github-repo-signals.js'

const REMOTE = 'https://github.com/acme/widget.git'
const SHA_FIX = 'a'.repeat(40)
const SHA_OTHER = 'b'.repeat(40)

let server: Server
let baseUrl: string
let requests: string[]

type Handler = (url: URL) => { status: number; json: unknown }
let handler: Handler

beforeEach(async () => {
  requests = []
  handler = () => ({ status: 500, json: { message: 'no handler' } })
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    requests.push(url.pathname + url.search)
    const out = handler(url)
    res.writeHead(out.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out.json))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function source(): GitHubRepoSignals {
  return new GitHubRepoSignals({ apiRoot: baseUrl, token: 'test-token' })
}

function query(over: Record<string, unknown> = {}) {
  return {
    remoteUrl: REMOTE,
    defaultBranch: 'main',
    issueNumber: 133,
    issueTitle: '下拉数据源错误',
    issueBody: '导出 CSV 时下拉数据源为空，文件 src/ui/select.ts。',
    sinceDays: 14,
    now: '2026-11-12T12:00:00Z',
    maxCommits: 30,
    maxIssues: 10,
    maxPullRequests: 10,
    ...over,
  }
}

describe('GitHubRepoSignals', () => {
  it('按关键词过滤最近提交，并区分相关 issue/PR 与明确引用本 issue 的项', async () => {
    handler = (url) => {
      if (url.pathname === '/repos/acme/widget/commits') {
        return {
          status: 200,
          json: [
            {
              sha: SHA_FIX,
              html_url: `https://github.com/acme/widget/commit/${SHA_FIX}`,
              commit: {
                message: 'fix: 修正下拉数据源为空\n\nCloses #133',
                author: { date: '2026-11-10T08:00:00Z' },
              },
            },
            {
              sha: SHA_OTHER,
              html_url: `https://github.com/acme/widget/commit/${SHA_OTHER}`,
              commit: {
                message: 'chore: release 1.2.3',
                author: { date: '2026-11-09T08:00:00Z' },
              },
            },
          ],
        }
      }
      if (url.pathname === '/search/issues') {
        const q = url.searchParams.get('q') ?? ''
        if (q.includes('is:issue')) {
          return {
            status: 200,
            json: {
              items: [
                {
                  number: 120,
                  title: '下拉数据源错误',
                  state: 'closed',
                  html_url: 'https://github.com/acme/widget/issues/120',
                },
                {
                  number: 121,
                  title: '完全无关',
                  state: 'closed',
                  html_url: 'https://github.com/acme/widget/issues/121',
                },
              ],
            },
          }
        }
        if (q.includes('is:pr')) {
          return {
            status: 200,
            json: {
              items: [
                {
                  number: 45,
                  title: '修复下拉数据源',
                  state: 'closed',
                  html_url: 'https://github.com/acme/widget/pull/45',
                  pull_request: { merged_at: '2026-11-08T00:00:00Z' },
                },
              ],
            },
          }
        }
        return {
          status: 200,
          json: {
            items: [
              {
                number: 46,
                title: '后续修复 (#133)',
                state: 'closed',
                html_url: 'https://github.com/acme/widget/pull/46',
                pull_request: { merged_at: '2026-11-11T00:00:00Z' },
              },
              {
                number: 47,
                title: '另一个仓库的修复',
                body: 'Refs other/widget#133',
                state: 'closed',
                html_url: 'https://github.com/acme/widget/pull/47',
                pull_request: { merged_at: '2026-11-11T00:00:00Z' },
              },
            ],
          },
        }
      }
      return { status: 500, json: {} }
    }

    const r = await source().load(query())
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return
    expect(r.value.commits.map((commit) => commit.sha)).toEqual([SHA_FIX])
    expect(r.value.issues).toHaveLength(1)
    expect(r.value.issues[0]).toMatchObject({ number: 120, state: 'closed' })
    expect(r.value.pullRequests[0]).toMatchObject({ number: 45, merged: true })
    expect(r.value.referencedCommits.map((commit) => commit.sha)).toEqual([SHA_FIX])
    expect(r.value.referencedPullRequests[0]).toMatchObject({ number: 46, merged: true })
    expect(r.value.referencedPullRequests).toHaveLength(1)

    const commitRequest = requests.find((url) => url.startsWith('/repos/acme/widget/commits'))
    expect(commitRequest).toContain('sha=main')
    expect(commitRequest).toContain('since=2026-10-29T12%3A00%3A00.000Z')
    const issueSearch = requests
      .filter((url) => url.startsWith('/search/issues'))
      .map((url) => new URL(url, baseUrl).searchParams.get('q') ?? '')
      .find((q) => q.includes('is:issue'))
    expect(issueSearch).toContain('in:title')
    expect(issueSearch).toContain('"下拉数据源"')
  })

  it('上限在过滤后生效 —— 不会因为搜索返回更多就突破 max', async () => {
    handler = (url) => {
      if (url.pathname === '/repos/acme/widget/commits') {
        return {
          status: 200,
          json: [
            {
              sha: SHA_FIX,
              html_url: `https://github.com/acme/widget/commit/${SHA_FIX}`,
              commit: {
                message: 'fix: 下拉数据源错误',
                author: { date: '2026-11-10T08:00:00Z' },
              },
            },
            {
              sha: SHA_OTHER,
              html_url: `https://github.com/acme/widget/commit/${SHA_OTHER}`,
              commit: {
                message: 'fix: 下拉数据源错误 again',
                author: { date: '2026-11-09T08:00:00Z' },
              },
            },
          ],
        }
      }
      const q = url.searchParams.get('q') ?? ''
      if (q.includes('is:issue'))
        return {
          status: 200,
          json: {
            items: [1, 2].map((number) => ({
              number,
              title: '下拉数据源错误',
              state: 'closed',
              html_url: `https://github.com/acme/widget/issues/${number}`,
            })),
          },
        }
      if (q.includes('is:pr'))
        return {
          status: 200,
          json: {
            items: [1, 2].map((number) => ({
              number,
              title: '修复下拉数据源',
              state: 'closed',
              html_url: `https://github.com/acme/widget/pull/${number}`,
              pull_request: { merged_at: '2026-11-10T00:00:00Z' },
            })),
          },
        }
      return {
        status: 200,
        json: {
          items: [1, 2].map((number) => ({
            number,
            title: '后续修复 (#133)',
            state: 'closed',
            html_url: `https://github.com/acme/widget/pull/${number}`,
            pull_request: { merged_at: '2026-11-10T00:00:00Z' },
          })),
        },
      }
    }

    const r = await source().load(query({ maxCommits: 1, maxIssues: 1, maxPullRequests: 1 }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.commits).toHaveLength(1)
    expect(r.value.issues).toHaveLength(1)
    expect(r.value.pullRequests).toHaveLength(1)
    expect(r.value.referencedPullRequests).toHaveLength(1)
  })

  it('GitHub 403 → AUTH_FAILED，由调用方降级；错误不含 token', async () => {
    handler = () => ({ status: 403, json: { message: 'forbidden' } })
    const r = await source().load(query())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('AUTH_FAILED')
    expect(r.error.detail).not.toContain('test-token')
  })
})

describe('extractKeywords', () => {
  it('中文长句能抽出可命中「修复下拉数据源」的 n-gram', () => {
    const keywords = extractKeywords('导出 CSV 时下拉数据源错误')
    expect(keywords).toContain('下拉数据源')
    expect(keywords).toContain('csv')
  })

  it('英文停用词不会变成过滤条件', () => {
    const keywords = extractKeywords('Error when export CSV with issue')
    expect(keywords).toContain('export')
    expect(keywords).not.toContain('error')
    expect(keywords).not.toContain('issue')
  })
})
