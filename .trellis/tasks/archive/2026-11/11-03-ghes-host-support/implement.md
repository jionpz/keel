# GHES host 支持 — 实施计划

## 顺序

1. **解析层**（纯函数，先测后用）
   - [x] 新增 `ParsedRemote` 与 `parseRemoteUrl`
   - [x] `ownerRepo` 改为委托 `parseRemoteUrl`，签名不变
   - [x] `parseIssueUrl` 复用同一 host/owner/repo 规则
   - [x] 新增 `apiRootForHost`
   - [x] 表驱动单测：github.com / GHES / ssh / 非法输入

2. **Provider**
   - [x] `request(host, path)`；`rootFor(host)` 实现三级优先级
   - [x] `findExistingPr` / `combinedStatus` 增加 host 参数
   - [x] `createPullRequest` / `waitForCi` / `getIssue` 先解析再请求
   - [x] `KEEL_GITHUB_API_ROOT` 空白/非法 → 每次请求返回 `WORKSPACE_ERROR`

3. **测试**
   - [x] stub server：GHES host 推导 `/api/v3`
   - [x] stub server：`KEEL_GITHUB_API_ROOT` 覆盖
   - [x] stub server：空白环境变量拒绝且不发请求
   - [x] 现有 `apiRoot` 注入用例保持全绿（回归基线）

4. **验收**
   - [x] `pnpm run check`
   - [x] 手工/脚本核对：不设环境变量时 github.com 请求 URL 与改动前一致

## 验证记录

- `pnpm vitest run src/fact/github-provider.test.ts`：55 passed（55 用例）。
- `pnpm run check`：全绿（42 files / 556 passed / 5 skipped）。
- 独立复核（`trellis-check`）逐条核对 R1–R7，未发现实现缺陷。

## 验证命令

```bash
pnpm run check
pnpm vitest run src/fact/github-provider.test.ts
```

## 审阅门

- 解析函数必须只有一份实现；`register-repo` 不应出现第二套 host 正则。
- 空白 `KEEL_GITHUB_API_ROOT` 的拒绝路径必须有测试，不能只写在注释里。
- 不允许改动 `Result` / 错误 kind 的既有语义。

## 回滚点

- 第 1 步完成后可独立提交（纯函数 + 测试）。
- 第 2 步完成后整体可回滚；无数据库变更。
