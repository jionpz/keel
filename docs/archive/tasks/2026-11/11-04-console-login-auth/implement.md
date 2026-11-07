# 执行计划：控制台登录鉴权

验证命令一律在仓库根执行。每个阶段结束都要能跑绿再进下一步。

## 0. 准备

- [ ] `python3 ./.trellis/scripts/task.py start 11-04-console-login-auth`（状态 → in_progress）
- [ ] 记基线：`pnpm vitest run src/cli/console.test.ts` 全绿
- [ ] 记基线：`pnpm run console` 能打开主页面（无 DB 也应能渲染骨架）

## 1. `console-auth.ts`（纯逻辑，先写测试）

- [ ] `SESSION_COOKIE = 'keel_console_session'`
- [ ] `generatePassword()`：4 组 × 4 位，去除易混字符（`0/o/1/l/i`），返回 `xxxx-xxxx-xxxx-xxxx`
- [ ] `resolveConsoleAuth(env)`：`KEEL_CONSOLE_PASSWORD` 非空 → `{source:'env'}`；
      否则生成 → `{source:'generated'}`
- [ ] `ConsoleAuth`：构造时 `scryptSync(password, salt, 32)`；比较用 `timingSafeEqual`
- [ ] 会话：`randomBytes(32).toString('base64url')`，内存表存 `sha256(token)` → `expiresAt`；
      `isValid` 解析 Cookie → 查表 → 过期即删；容量上限 64，超出淘汰最早过期
- [ ] 限流：`Map<ip, {count, resetAt}>` + 全局键；窗口滚动重置；成功清零该 IP
- [ ] Cookie：`Path=/; HttpOnly; SameSite=Strict; Max-Age=…`，`secure` 时追加 `Secure`
- [ ] `parseCookies` 容错：空、缺 `=`、非法百分号编码都不抛

验证：`pnpm vitest run src/cli/console-auth.test.ts`

## 2. `console-login-page.ts`

- [ ] 导出 `CONSOLE_LOGIN_HTML`，继续复用 `CONSOLE_TOKEN_PLACEHOLDER`
- [ ] 视觉：冷纸 / 墨 / 单一信号色；卡片居中；明暗主题；`prefers-reduced-motion` 降级
- [ ] 表单：口令输入（显示/隐藏）、保持登录 7 天、提交 busy 态、错误 `role="alert"`
- [ ] 客户端：`POST /api/login`，带 `content-type: application/json` 与 `x-keel-console`；
      200 → `location.replace('/')`；401 → 「口令不正确」；429 → 显示剩余秒数
- [ ] 页面不引用任何事实数据，不加载外部资源

验证：`grep -c "http" src/cli/console-login-page.ts` 只应命中注释/无外链（人工确认）

## 3. `console.ts` 接线

- [ ] `ConsoleDeps.auth: AuthOptions` 必填 + `boundHost?: string`
- [ ] `PUBLIC_PATHS` 常量：`/login`、`/api/login`、`/healthz`；其余先过会话闸门
- [ ] `GET /login`：有效会话 → `302 /`；否则返回登录页（注入令牌）
- [ ] `POST /api/login`：`writeRejection` → `auth.login` → `Set-Cookie` / 401 / 429
- [ ] `POST /api/logout`：`writeRejection` → `auth.logout` → 清 Cookie → `{ok:true}`
- [ ] `GET /healthz`：公开；匿名只回 `{ok}`；已登录保留 `error` 与 `connection`
- [ ] 页面路由未登录 → `302 /login`；`/api/*` 未登录 → `401`
- [ ] `writeRejection`：绑定回环时仍要求 Host 回环；`Origin` 存在时要求与 `Host` 同源
- [ ] 安全头：`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、
      `Content-Security-Policy`（放行 inline style/script 与 `connect-src 'self'`）
- [ ] `KEEL_CONSOLE_HOST` 解析与校验；`startConsole` 用它 listen；非回环打印警告
- [ ] 启动日志：口令来源（环境变量 / 随机生成并打印）；`--help` 增补四个环境变量

验证：`pnpm run typecheck` + 手工 `KEEL_CONSOLE_HOST=127.0.0.1 pnpm run console`

## 4. 主页面收尾

- [ ] `console-page.ts` 顶栏加「退出」按钮，`POST /api/logout` 后 `location.replace('/login')`
- [ ] `fetchJSON`：`r.status === 401` → `location.replace('/login')`，不再抛普通错误
- [ ] 令牌读取沿用 `<meta name="keel-console-token">`

验证：登录后点退出 → 回登录页；再访问 `/` 仍需登录

## 5. 测试改造

- [ ] `console.test.ts` 的 `withServer`：用固定口令登录一次，把 `set-cookie` 的
      `name=value` 注入后续请求；业务断言不改
- [ ] 新增用例：未登录 302 / 401、登录页 200、错误口令 401、连续失败 429、
      正确口令 Set-Cookie 标志、退出后 401、已登录访问 `/login` 302、
      `/healthz` 匿名无 detail
- [ ] `console-auth.test.ts`：哈希、12h/7d 过期（假时钟）、限流窗口重置、Cookie 解析容错

验证：`pnpm vitest run src/cli/console.test.ts src/cli/console-auth.test.ts`

## 6. 文档与全量检查

- [ ] `.trellis/spec/frontend/console-guidelines.md` 增补「鉴权」一节：
      公开路径清单、Cookie 标志、限流、写入口不降级、新增路由默认受保护
- [ ] `README.md` 的本地部署段落补 `KEEL_CONSOLE_HOST` / `KEEL_CONSOLE_PASSWORD`
- [ ] `pnpm run check` 全绿
- [ ] 浏览器实测：登录页明/暗主题、Tab + Enter、错误态、登录后主页面、退出
- [ ] `KEEL_CONSOLE_HOST=0.0.0.0` 起一次，用本机非回环地址访问，确认未登录被挡

## 7. 收尾

- [ ] 更新任务 `prd.md` 的验收勾选
- [ ] 提交（commit message 说明鉴权模型与公开路径）
- [ ] 归档任务

## 回滚点

- 第 1–2 步是新增文件，单独回滚不影响现有控制台。
- 第 3 步是唯一的行为切换点：若出问题，`git revert` 该提交即可回到「无鉴权 + 本机绑定」。
- 不涉及数据库迁移，无数据回滚。
