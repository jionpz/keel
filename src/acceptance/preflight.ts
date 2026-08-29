/**
 * 验收前置探针 —— 在起编排器(分钟级、花钱)**之前**确认前置真的具备。
 *
 * 为什么值得单独一个模块(2026-08-27 / 08-28 两次教训):
 *   - 第二轮验收:完整编排无人干预跑了 2 分钟、真实 push 成功之后,才在
 *     CreatePullRequest 上撞出 403 —— 环境 token 能 push 却不能开 PR。
 *     这类失败应该在第 0 秒暴露,而不是第 120 秒。
 *   - 2026-08-28:环境里根本没有 `omp` 可执行文件。缺它时每个 run 都会失败,
 *     编排照跑不误,最后经 T-031 落进 S-HUMAN_REVIEW —— 与 Policy 判高风险
 *     **同一个终态**。测试若只看终态就会判绿(见 issue-e2e 对 T-031 的断言)。
 *
 * 探针都不改变远程状态;失败时抛错并打印怎么补,**不 skip**。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  requireAnthropicApiKeyForBare,
  requireClaudeBinary,
} from '../execution/adapters/claude-code.js'

/** 从 remote URL 解析 `owner/repo` */
export function ownerRepoSlug(remoteUrl: string): string {
  const m = remoteUrl.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (m === null) throw new Error(`无法从 ${remoteUrl} 解析 owner/repo`)
  return `${m[1]}/${m[2]}`
}

/** 探针专用的最小 GitHub 调用。token 只进 Authorization 头,不进 URL / 错误信息 */
async function ghProbe(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<number> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  await res.text() // 读掉 body，释放连接
  return res.status
}

/**
 * 预检 GitHub 凭据:能读目标仓库,且能创建 PR。
 *
 * 探针 2 对一个**不存在的** head 分支发起创建:GitHub 先查授权再做校验,
 * 403 → 没有 PR 写权限;422 → 授权通过、head 校验失败(即权限 OK)。
 * 因为 head 不存在,绝不会真的建出 PR。
 */
export async function preflightGitHub(remoteUrl: string, token: string): Promise<void> {
  const slug = ownerRepoSlug(remoteUrl)

  const repoStatus = await ghProbe(token, `/repos/${slug}`)
  if (repoStatus === 401) {
    throw new Error(
      [
        `GitHub token 无效或已过期（GET /repos/${slug} → 401）。`,
        '若环境里残留过期的 KEEL_GITHUB_TOKEN，它会覆盖 gh 的有效凭据：',
        '  unset KEEL_GITHUB_TOKEN',
        '  export KEEL_GITHUB_TOKEN="$(gh auth token)"   # 或换有效的 fine-grained PAT',
      ].join('\n'),
    )
  }
  if (repoStatus !== 200) {
    throw new Error(
      `token 读不到 ${slug}（GET /repos → HTTP ${repoStatus}）。` +
        'fine-grained PAT 需要把该仓库加进 Repository access。',
    )
  }

  const prStatus = await ghProbe(token, `/repos/${slug}/pulls`, {
    method: 'POST',
    body: {
      title: '[keel-preflight] permission probe',
      head: `ai/keel-preflight-${randomUUID().slice(0, 8)}`,
      base: 'main',
    },
  })
  if (prStatus === 403) {
    throw new Error(
      [
        `token 没有创建 PR 的权限（POST /repos/${slug}/pulls → 403）。`,
        '已知边界：Cursor Cloud Agent 的 GitHub App token（ghs_ 前缀）可以 git push，',
        '但不能开 PR（Resource not accessible by integration）。',
        '需要 fine-grained PAT：Contents Read+Write 且 Pull requests Read+Write，',
        '设为 KEEL_GITHUB_TOKEN 后重跑。',
      ].join('\n'),
    )
  }
  if (prStatus !== 422) {
    throw new Error(
      `PR 写权限探针返回非预期状态（POST /repos/${slug}/pulls → HTTP ${prStatus}）。` +
        '拒绝在权限不明的情况下起编排 —— 请人工核查 token 权限后重跑。',
    )
  }
}

/**
 * 预检推理 harness:`omp` 可执行且能应答 `--version`。
 *
 * 不探网关 key —— 那要真发一次请求(花钱且慢)。缺 key 时 omp 自己会失败,
 * 由 run 的错误信息暴露;这里挡住的是「二进制根本不在」这种一秒可知的情况。
 */
export function preflightOmp(bin = 'omp'): void {
  try {
    execFileSync(bin, ['--version'], { stdio: 'pipe' })
  } catch {
    throw new Error(
      [
        `找不到可用的 \`${bin}\` CLI —— 真实验收需要它来跑六个阶段的推理。`,
        '缺它时每个 run 都会失败，编排会一路重试到 T-031 落进 S-HUMAN_REVIEW，',
        '而那与「Policy 判高风险」是同一个终态 —— 只看终态就会误判为通过。',
        '补法：安装 omp CLI，并设置 OPENCODE_API_KEY 或 DEEPSEEK_API_KEY。',
      ].join('\n'),
    )
  }
}

/**
 * 预检 Claude Code：`claude --version`；untrusted 路径还要 ANTHROPIC_API_KEY
 * （`--bare` 不读 OAuth / 钥匙串）。
 *
 * 缺二进制或缺 key 时抛错，**不 skip**。否则编排会 T-031 升人工，
 * 与 Policy 闸门同终态，只看终态就会假绿。
 */
export function preflightClaude(bin = 'claude'): void {
  const binOk = requireClaudeBinary(bin)
  if (!binOk.ok) {
    throw new Error(binOk.error.detail)
  }
  const key = requireAnthropicApiKeyForBare()
  if (!key.ok) {
    throw new Error(key.error.detail)
  }
}
