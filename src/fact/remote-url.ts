/** 归一化 remote URL —— 比对时忽略末尾 `/` 与 `.git` 后缀 */
export function normalizeRemoteUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\.git$/i, '')
}
