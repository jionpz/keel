# GitHub token 来源与启动期校验

> 父任务 `11-05-run-reliability-remaining`，issue #73 第 3 项。

## Goal

让 token 的获取方式有明确优先级，并且**缺失时在启动就失败**，
而不是跑到 clone / push / API 调用才报 `could not read Username`。

## Background

- 现在只认 `KEEL_GITHUB_TOKEN`；不复用 `gh` 的登录态。
- 需要 GitHub 访问的入口：`poller`、`run-issue`、`register-repo`、以及运行期的 git 传输。
- 失败发生在流程中段，前面的 ingest / 驱动已经产生写入。

## Requirements

- **R1 来源优先级**：`KEEL_GITHUB_TOKEN` > `gh auth token`（GHES 需按 host：
  `gh auth token --hostname <host>`）> 明确报错。
- **R2 启动期校验**：需要 GitHub 访问的入口在进入驱动前解析 token；
  缺失即退出（非 0），文案给出可执行修复命令（`export ...` 或 `gh auth login`）。
- **R3 token 纪律不变**：不进 argv、不进日志、不进错误 detail、不进事件表。
- **R4 不新增依赖**：调用本机 `gh` CLI，不引入 SDK；`gh` 不存在时按「未登录」处理。
- **R5 不误伤纯本地命令**：不需要 GitHub 的命令不强制 token。

## Acceptance Criteria

- [ ] 未设 `KEEL_GITHUB_TOKEN`、`gh` 已登录：按 host 取到 token 并正常驱动。
- [ ] 未设 `KEEL_GITHUB_TOKEN`、`gh` 未登录：启动即失败，文案给出修复命令。
- [ ] 设了 `KEEL_GITHUB_TOKEN`：行为与现在完全一致，不再调用 `gh`。
- [ ] 事件表 / 日志 / 错误 detail / git argv 中 grep 不到 token。
- [ ] `pnpm run check` 全绿。

## Out of Scope

- 其他托管平台的 token。
- OAuth device flow 的自研实现（只调用 `gh` CLI）。
- token 加密存储 / 轮换。
