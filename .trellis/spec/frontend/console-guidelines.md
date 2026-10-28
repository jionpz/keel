# 控制台（只读 Web 面板）

> 来源：`10-27-console-and-demo-app` 的第一份真实前端代码（`src/cli/console*.ts`）。
> 在出现第二个 UI 之前，这些约定只覆盖「本地只读观测面」这一类，不要外推成通用前端规范。

## 形态：单文件、零构建、零依赖

- 页面是 `src/cli/console-page.ts` 里的一个模板字符串；没有 React / Vite / CDN。
- 客户端 JS 用字符串拼接，**不要用模板字符串** —— 会和外层模板字符串冲突。
- 新增页面能力时先问：能不能用原生 DOM + `fetch` 完成？能就不要引依赖。

## 只读边界

- 只发 `GET`；写方法一律 `405`。
- 数据库访问只走 `asRole('keel_control')`，并且只发 `SELECT`。
- 只绑定 `127.0.0.1`，不做鉴权 —— 因此**不要**把它暴露到公网。

## 数据口径必须与 CLI 一致

- 页面上的 task / run / event 必须能和 `keel status`、`pnpm run timeline -- <id>` 对上。
- 新增字段时先看 CLI 查询，避免出现两套事实口径。
- 状态集合与主路径来自代码（`src/shared/ids.ts`、`src/control/transition/table.ts`），
  不要在页面里手抄一份状态表。

## 错误纪律

- 不存在的 task → `404`，不返回空对象冒充「没有任务」。
- 数据库不可用 → `503`，并在响应里带连接串提示；页面显示错误，不显示空白。
- 测试注入假 `query` 起真实 http server，不依赖数据库；真实数据由手工对账验证。
