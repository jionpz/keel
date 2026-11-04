# 设计：控制台登录鉴权

## 1. 边界

- **只动控制台**。不改数据库 schema、不改读路径（仍 `SELECT` + `keel_control`）、
  不改 `decide.ts` / `answerTask` 的业务语义、不引第三方依赖。
- **零构建**。登录页继续是模板字符串；客户端 JS 用字符串拼接，避免与外层模板冲突。
- **配置走环境变量**。本项目没有配置页，本任务也不新增；口令与监听地址都通过 `KEEL_*`
  环境变量提供，符合 `~/.agents/AGENTS.md` 的「敏感配置走环境变量」。
- **不新增持久化**。会话是进程内存态，重启失效；这是明确的取舍，不是遗漏。

## 2. 模块与契约

### 新文件

| 文件 | 职责 |
|---|---|
| `src/cli/console-auth.ts` | 口令哈希、会话表、限流器、Cookie 解析/序列化、配置解析。纯 Node，无 HTTP |
| `src/cli/console-login-page.ts` | 登录页单文件 HTML（导出 `CONSOLE_LOGIN_HTML`） |
| `src/cli/console-auth.test.ts` | 上述纯逻辑的单元测试 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/cli/console.ts` | 鉴权中间件、`/login`、`POST /api/login`、`POST /api/logout`、`KEEL_CONSOLE_HOST`、安全响应头、`writeRejection` 放宽回环限制 |
| `src/cli/console-page.ts` | 顶栏「退出」按钮；`fetchJSON` 遇 401 跳登录页 |
| `src/cli/console.test.ts` | `withServer` 自动登录；新增鉴权 / 限流 / 退出 / healthz 用例 |

### 核心类型

```ts
// console-auth.ts
export const SESSION_COOKIE = 'keel_console_session'

export interface AuthOptions {
  readonly password: string
  readonly sessionTtlMs?: number      // 默认 12h
  readonly rememberTtlMs?: number     // 默认 7d
  readonly now?: () => number         // 测试注入时钟
  readonly perIpLimit?: number        // 默认 5
  readonly globalLimit?: number       // 默认 20
  readonly windowMs?: number          // 默认 5min
  readonly maxSessions?: number       // 默认 64
}

export type LoginOutcome =
  | { ok: true; token: string; maxAgeSec: number }
  | { ok: false; reason: 'bad-password' }
  | { ok: false; reason: 'rate-limited'; retryAfterSec: number }

export class ConsoleAuth {
  constructor(opts: AuthOptions)
  login(password: string, ip: string, remember: boolean): LoginOutcome
  isValid(cookieHeader: string | undefined): boolean
  logout(cookieHeader: string | undefined): void
  sessionCookie(token: string, maxAgeSec: number, secure: boolean): string
  clearCookie(secure: boolean): string
}

export function resolveConsoleAuth(env: NodeJS.ProcessEnv): {
  password: string
  source: 'env' | 'generated'
}
export function generatePassword(): string
export function parseCookies(header: string | undefined): Map<string, string>
```

```ts
// console.ts
export interface ConsoleDeps {
  readonly query: QueryFn
  readonly act?: ConsoleActions
  readonly token?: string
  readonly auth: AuthOptions          // 新增：必填，测试也必须显式给口令
  readonly boundHost?: string         // 新增：默认 127.0.0.1
}
```

`createConsoleHandler` 的 `auth` 必填 —— 不给默认口令，避免「忘了配 = 无鉴权」的隐性路径。

## 3. 请求生命周期

```
GET /login ──────────────► 已登录? 302 / : 返回登录页(注入 CSRF 令牌)
POST /api/login ─────────► writeRejection → 限流 → 校验口令
                            ├─ 失败: 401 / 429（统一文案）
                            └─ 成功: Set-Cookie + {ok:true}
GET /healthz ────────────► 公开；未登录仅 {ok}，已登录带错误详情
其它路由 ────────────────► 有效会话?
                            ├─ 否: /api/* → 401 JSON；页面 → 302 /login
                            └─ 是: 进入原有路由
POST /api/logout ────────► 删除服务端会话 + 清 Cookie
```

顺序要点：

1. `/api/login`、`/login`、`/healthz` 必须在鉴权闸门**之前**处理，否则无法登录。
2. `/api/logout` 也在闸门**之前**处理：无会话时同样清 Cookie 并返回 `200`（幂等），
   这样过期 / 陈旧 Cookie 也能被清掉；它只删除请求自带的那个会话，不删别人的。
3. 写入口的 `writeRejection` 在鉴权之后仍然执行 —— 它会话之外的 CSRF 防护不因登录而取消。

## 4. 安全分析

| 威胁 | 现状 | 本设计 |
|---|---|---|
| 同网段任何人直接读事实 | 对外监听即全开放 | 所有事实路由要求会话；`/healthz` 只回 `{ok}` |
| 口令爆破 | 无 | 每 IP 5 次 / 5 分钟，全局 20 次 / 5 分钟；429 + Retry-After |
| 时序侧信道 | 无口令 | scrypt 哈希 + `timingSafeEqual`；失败统一文案 |
| 会话窃取（XSS） | — | Cookie `HttpOnly`；页面无外部脚本、CSP 兜底 |
| CSRF | 四道本机校验 | `SameSite=Strict` + Origin/Host 同源 + JSON Content-Type + `X-Keel-Console` |
| DNS rebinding（本机） | Host 必须回环 | 绑定回环时保留该检查 |
| DNS rebinding（对外） | — | 会话 Cookie 绑定目标主机；攻击者域拿不到会话。写入口仍要求 Origin=Host |
| 会话被长期占用 | — | 绝对过期 12h / 7d；退出即删；重启即失效 |
| 口令泄漏到页面 | — | 口令只在服务端 `resolveConsoleAuth` 读取；登录页不注入任何口令信息 |
| `/healthz` 泄露连接串 | 当前未鉴权返回 `connectionString()` | 匿名只回 `{ok}`；详情仅登录后返回 |
| 点击劫持 | 无 | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` |
| 明文传输 | — | 不做 TLS；`KEEL_CONSOLE_SECURE_COOKIE=1` 支持反代 HTTPS 时加 `Secure` |

**明确不防**：拥有同一 OS 账号的人（能读终端、能跑 CLI、能读进程环境）。这不是本设计的
目标 —— 目标是「同网段的其他人 / 顺手打开的浏览器」进不来。

## 5. 配置矩阵

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `KEEL_CONSOLE_PORT` | `4321` | 已有，不变 |
| `KEEL_CONSOLE_HOST` | `127.0.0.1` | 新增；`0.0.0.0` 对外监听 |
| `KEEL_CONSOLE_PASSWORD` | 未设置 | 新增；未设置时每次启动随机生成并打印 |
| `KEEL_CONSOLE_SECURE_COOKIE` | 未设置 | 设为 `1` 时 Cookie 加 `Secure`（反代 HTTPS） |

启动日志（未设口令时）：

```
keel console: http://127.0.0.1:4321
访问口令: k7fq-2mxa-9dtb-h3we  （本次进程随机生成；设置 KEEL_CONSOLE_PASSWORD 可固定）
数据库: postgres://…
```

对外监听时额外打印：

```
⚠ 正在监听非回环地址 0.0.0.0；请确认网络边界，建议由反向代理终止 TLS。
```

## 6. 错误矩阵

| 条件 | HTTP | 响应 |
|---|---|---|
| 未登录访问页面 | 302 | `Location: /login` |
| 未登录访问 `/api/*` | 401 | `{ok:false,error:'未登录'}` |
| `/api/login` 非 POST | 405 | `{ok:false,error:'该端点只接受 POST'}` |
| 登录 Content-Type 非 JSON | 415 | 沿用 `writeRejection` 文案 |
| 登录缺令牌 / Origin 不同源 / Host 非法 | 403 | 沿用 `writeRejection` 文案 |
| 口令错误 | 401 | `{ok:false,error:'口令不正确'}` |
| 触发限流 | 429 | `{ok:false,error:'尝试过于频繁，请稍后再试'}` + `Retry-After` |
| 登录成功 | 200 | `{ok:true}` + `Set-Cookie` |
| 已登录访问 `/login` | 302 | `Location: /` |
| 退出 | 200 | `{ok:true}` + 清 Cookie（无会话也 200） |
| `/healthz` 匿名且 DB 挂 | 503 | `{ok:false}`（无 detail / connection） |
| `/healthz` 已登录且 DB 挂 | 503 | `{ok:false,error,connection}`（保留排障能力） |

## 7. 取舍与被否方案

- **HTTP Basic Auth**：零状态，但没有登录页，也不满足「做得好一点」。否。
- **无状态签名 Cookie**：少一张表，但退出 / 吊销需要密钥轮换；内存表更直观。否。
- **口令哈希写进配置文件**：多一份磁盘状态与权限管理；环境变量已满足「不进文档、不进代码」。
  否。
- **Postgres 存账号**：本任务明确单口令、无多用户，引入迁移与账号管理入口是过度设计。否。
- **登录尝试写审计表**：控制台定位是观测面，审计属于 Fact Plane；进程内计数足够。否。
- **`KEEL_CONSOLE_AUTH=off`**：等于给「忘了配」留后门；测试直接注入 `auth`。否。

## 8. 兼容与回归风险

- **现有测试**：`createConsoleHandler` 的 `auth` 必填会让所有旧用例编译失败 —— 这是有意的，
  强制每个用例显式声明口令。`withServer` 统一登录并注入 Cookie，业务断言不变。
- **页面轮询**：`fetchJSON` 遇 401 跳转；轮询定时器在跳转后随页面卸载消失。
- **hash 路由**：登录页与主页面分离，`#task=…` 在登录后原样保留（`location.replace('/')`
  会丢 hash —— 登录成功统一回 `/`；如需保留，登录页读取 `location.hash` 并拼回）。设计取
  「回 `/`」，因为未登录时本来也不该知道任何 task id。
- **CSP**：主页面只有内联样式/脚本与 `fetch` 同源请求；`default-src 'none'` 需显式放行
  `style-src 'unsafe-inline'`、`script-src 'unsafe-inline'`、`connect-src 'self'`。
  落地后必须实际打开页面确认无控制台报错。

## 9. 漂移风险

- 登录页配色与主页面是两份 CSS 变量。**只允许复制 `:root` 里的调色板**，不复制布局；
  改主色时两处一起改（在登录页头部注释里写明）。
- 新增路由默认受保护：鉴权闸门放在路由分发之前，唯一豁免清单写在一个常量里
  （`PUBLIC_PATHS`），新增豁免必须改那个常量并在测试里断言。
