# 控制台登录鉴权：口令登录与会话控制

## Goal

控制台从「只绑本机、无鉴权」变成「**默认仍需登录**」，并允许在受控网络内对外提供服务。
登录页必须和现有控制台的视觉语言一致，不是临时拼出来的表单。

一句话：**没登录的人，连事实的一行都读不到。**

## Background

- 现状：`src/cli/console.ts` 只绑定 `127.0.0.1`，全部读接口无鉴权；写入口靠四道
  本机校验（Host 回环 / Origin 回环 / JSON Content-Type / 进程随机令牌）。
- 需求：不能每个人都能进去；默认仍本机，但可以通过配置对外提供服务。
- 约束：单文件页面、零构建、零第三方依赖（`.trellis/spec/frontend/console-guidelines.md`）；
  读路径仍只发 `SELECT`、仍走 `keel_control` 角色。
- 配置入口：本项目没有配置页，也不在本任务新增配置页；登录口令与监听地址走环境变量，
  与项目现有 `KEEL_*` 约定一致。

## Users & Scenarios

1. **项目所有者（本机）**：`pnpm run console` → 终端打印访问口令 → 浏览器打开
   `http://127.0.0.1:4321` → 登录后看到控制台。
2. **值班人 / 协作者（局域网）**：启动时设 `KEEL_CONSOLE_HOST=0.0.0.0`、
   `KEEL_CONSOLE_PASSWORD=<口令>` → 同网段浏览器访问 → 登录后使用。
3. **长期挂机**：登录时勾选「保持登录 7 天」；需要离开时点「退出」，当前会话立即失效。
4. **会话过期**：页面轮询收到 `401` 时自动回到登录页，不留下半截界面。

## Requirements

### R1 强制登录

- 除 `/login`、`POST /api/login`、`/healthz` 外，**所有路由**（页面、`/api/*`、写入口）
  都要求有效会话。
- 未登录访问页面 → `302 /login`；未登录访问 API → `401` JSON。
- 已登录访问 `/login` → `302 /`。

### R2 口令来源

- `KEEL_CONSOLE_PASSWORD` 优先；只在服务端读取，不下发到页面、不写日志、不进事件。
- 未设置时：每次进程启动生成一个随机口令（足够熵），**打印到启动终端**，本次进程有效。
  不因为「没配环境变量」而拒绝启动，避免把现有用法变成硬失败。
- 口令在进程内以 scrypt 哈希保存，比较使用常量时间算法。

### R3 会话

- 登录成功签发 `keel_console_session` Cookie：`HttpOnly`、`SameSite=Strict`、`Path=/`；
  经 HTTPS（显式配置或反代 `X-Forwarded-Proto: https`）时加 `Secure`。
- 服务端内存会话表：默认 12 小时绝对过期；勾选「保持登录」为 7 天。
- 退出登录（`POST /api/logout`）删除服务端会话并清 Cookie。
- 进程重启后旧会话全部失效（内存态，明确接受）。

### R4 防爆破

- 登录失败按来源 IP 固定窗口限流（5 次 / 5 分钟），并设全局上限（20 次 / 5 分钟）。
- 超限返回 `429` + `Retry-After`。
- 失败文案统一为「口令不正确」，不区分口令错误与其它原因。
- 成功登录清零该 IP 的失败计数。

### R5 登录页

- 单文件 HTML、内联 CSS / JS、无外部资源、无构建。
- 与现有控制台同一套「冷纸 / 墨 / 单一信号色」配色，支持明暗主题。
- 具备：品牌标识、标题、口令输入（可显示/隐藏）、提交按钮的 busy / 成功 / 失败态、
  `aria-live` 错误区、键盘可完成登录、`prefers-reduced-motion` 降级。
- 页面不包含任何事实数据，也不引用控制台主页面。

### R6 监听地址

- `KEEL_CONSOLE_HOST` 默认 `127.0.0.1`；设为 `0.0.0.0` 或其它地址时对外监听。
- 非回环监听时，启动日志打印明确警告（建议反向代理 TLS），并说明口令来源。
- 对外监听不改变鉴权要求：未登录仍然读不到任何事实。

### R7 写入口不降级

- 保留 `Content-Type: application/json` 与 `X-Keel-Console` 令牌校验。
- `Origin` 存在时必须与请求 `Host` 同源；绑定回环时仍要求 `Host` 是回环地址
  （保留 DNS rebinding 防护）。
- 会话校验在写入口之前执行；未登录一律 `401`。

### R8 现有能力零回归

- 概览 / 任务 / 项目三种视图、5s 轮询、URL hash 路由、人工闸门决策页行为不变。
- `/healthz` 保持公开探活，但**只返回 `{ok}`**；错误详情与数据库连接串只对已登录请求返回
  （当前实现会把 `connectionString()` 直接回给未鉴权请求，属于本次一并修掉的泄露）。

### R9 页面 401 处理

- 控制台页面的统一 `fetchJSON` 在收到 `401` 时跳转 `/login`，不做半截渲染。
- 顶栏新增「退出」按钮，调用 `POST /api/logout` 后回到登录页。

## Acceptance Criteria

- [x] 未登录 `GET /` → `302` 到 `/login`；`GET /api/tasks` → `401`。
- [x] 错误口令 → `401`；同一 IP 连续 5 次失败 → `429` 且带 `Retry-After`。
- [x] 正确口令 → `Set-Cookie` 含 `HttpOnly`、`SameSite=Strict`；随后 `GET /` 与
      `/api/tasks`、`/api/stats`、`/api/meta` 均 `200`。
- [x] 「保持登录」会话语义为 7 天；未勾选为 12 小时（由单元测试断言）。
- [x] 退出后旧 Cookie 再访问 API → `401`；进程重启后旧 Cookie 同样 `401`。
- [x] `KEEL_CONSOLE_HOST=0.0.0.0` 时可从非回环地址连上，但未登录仍被挡。
- [x] `/healthz` 未登录只返回 `{ok:true|false}`，不含连接串。
- [x] 登录页在明/暗主题下可读；Tab + Enter 可提交；错误信息可被读屏播报。
- [x] `pnpm run check` 全绿（lint / typecheck / boundaries / generated / transitions /
      purity / test）。
- [x] 现有 console 测试全部通过；新增 auth 单测覆盖哈希、会话过期、限流窗口、Cookie 解析。

## Out of Scope

- 多用户、角色、RBAC、审计「谁点的」。
- GitHub OAuth / SSO / LDAP。
- TLS 终止与证书管理（建议反向代理）。
- 账号管理页 / 控制台配置页。
- 会话持久化到 Postgres（本任务明确接受重启失效）。
- 多进程 / 多副本会话共享。
