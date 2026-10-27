# 设计 · keel 控制台 + demo APP 全流程演练

## 1. 边界与归属

控制台是 **Fact Plane 的消费者**，不是新平面：

```
src/cli/console.ts        HTTP 服务 + 查询（只读）
src/cli/console-page.ts   单文件 HTML（内联 CSS / JS）
src/control/transition/   只 import 纯数据 TASK_TRANSITIONS 用于画状态机
src/fact/db.ts            复用 asRole / connectionString
```

- 放在 `src/cli` 而不是 `src/fact`：UI 不属于事实层；`src/fact` 反向依赖 UI 会污染事实语义。
- 只读：只发 `SELECT`；不调用 `PgArtifactStore.commit` / `appendEvent`。
- 角色：`asRole('keel_control')`。现有 GRANT 已覆盖 repo / task / run / event / artifact，
  不需要新角色或新迁移。
- 不 import `src/execution`（与现有边界一致）。

## 2. HTTP 服务

`node:http`，默认 `127.0.0.1:4321`，`KEEL_CONSOLE_PORT` 可覆盖。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | HTML 单页 |
| GET | `/api/tasks` | 任务列表 |
| GET | `/api/tasks/:id` | 单任务详情 |
| GET | `/healthz` | 进程与数据库可用性 |

`/api/tasks` 响应：

```json
{
  "tasks": [{
    "id": "...", "title": "...", "status": "S-DONE", "control_mode": "auto",
    "repo": "https://github.com/jionpz/keel-demo-app",
    "created_at": "...", "updated_at": "...", "terminal_at": "..."
  }]
}
```

`/api/tasks/:id` 响应：

```json
{
  "task": { "...": "同上 + base_branch / work_branch / risk / complexity" },
  "runs": [{ "stage": "develop", "attempt": 1, "status": "SUCCEEDED", "harness_id": "claude", "started_at": "...", "ended_at": "..." }],
  "events": [{ "seq": 81, "type": "TaskCreated", "run_id": null, "occurred_at": "...", "payload": {} }],
  "artifacts": [{ "kind": "rfc", "key": "", "version": 1, "committed_at": "...", "body": {} }]
}
```

SQL（全部只读）：

```sql
-- 列表
SELECT t.id, t.title, t.status, t.control_mode, t.created_at, t.updated_at,
       t.terminal_at, r.remote_url AS repo
FROM task t JOIN repo r ON r.id = t.repo_id
ORDER BY t.updated_at DESC;

-- 产物：每个 (kind, key) 取最新版
SELECT DISTINCT ON (kind, key) kind, key, version, committed_at, body
FROM artifact WHERE task_id = $1
ORDER BY kind, key, version DESC;
```

错误纪律（沿用 `backend/error-handling.md`）：
- task 不存在 → `404 {"error":"task not found"}`；
- 数据库不可用 → `503`，页面显示连接串提示，不渲染空数据冒充「没有任务」。

## 3. 页面

单文件，无构建、无 CDN、无新依赖。

布局：
- 左侧：任务列表（状态色点 + 标题 + 状态 + 更新时间），支持按状态过滤。
- 右侧：任务详情
  1. 头部：标题、状态徽章、control_mode、仓库、分支、时间；
  2. 状态机条：按主路径 `S-NEW → … → S-DONE` 渲染，高亮当前状态；
  3. Runs 表：stage / attempt / status / harness / 耗时；
  4. 产物：RFC 与 stage_outcome 可展开；
  5. 事件时间线：seq / 时间 / 类型 / payload（`<details>` 展开原始 JSON）。
- 顶部：自动刷新开关（5s）+ 手动刷新；只影响前端轮询。

字体与配色走系统栈，深浅色跟随 `prefers-color-scheme`；不引入设计系统。

## 4. demo APP

仓库：`jionpz/keel-demo-app`（public，便于 GitHub Actions 免费跑）。

```
package.json            type=module，scripts: start / test
server.mjs              node:http 静态服务（无依赖）
public/index.html       Todo 单页
public/app.js           前端逻辑（纯函数可测）
public/style.css
src/todos.js            增删改查纯函数（被 node:test 覆盖）
test/todos.test.mjs     node --test
.github/workflows/ci.yml  Node 24 + npm test
README.md
```

- 零运行时依赖：`npm test` 用 Node 内置 `node:test`，CI 秒级完成。
- 首个 Issue 需求刻意小：
  「给 Todo 增加按状态筛选（全部 / 未完成 / 已完成），并显示剩余数量」。
  预期 PM 判定 `actionable` + `needs_design=false`，走 `rfc_draft` 快路径；
  RFC 低风险低复杂度 → `auto_develop`。

## 5. 全流程执行

1. `gh repo create jionpz/keel-demo-app --public --source <local> --push`
   → 首次 Actions 为绿（AC5）。
2. `gh issue create --repo jionpz/keel-demo-app ...` → 得到真实 Issue URL。
3. `keel register-repo https://github.com/jionpz/keel-demo-app --default-branch main`。
4. `KEEL_GITHUB_TOKEN="$(gh auth token)" keel run-issue <issue-url> --ci real --harness claude --wall-clock 1800`。
5. 控制台盯事件流；结束后 `pnpm run timeline -- <task_id>` 核对 AC7。

## 6. 风险与回滚

| 风险 | 处置 |
|---|---|
| 模型把 RFC 判成高风险 → 停在 `S-HUMAN_REVIEW` | 如实记录；Issue 文案收紧后重跑一个新 task |
| CI 未在轮询窗口内完成 | 用 `--wall-clock` 抬高；不把「读不到」当 passed |
| git push 凭据 | 依赖全局 `gh auth git-credential`（已确认配置） |
| 端口占用 | `KEEL_CONSOLE_PORT=4322` |
| 控制台误写数据 | 代码审查 + 只用 `asRole('keel_control')`；该角色对事实表只有 SELECT |

回滚：
- 控制台是纯新增文件，删除即可；
- demo 仓库是独立新仓库，失败可保留（证据）或删除（需用户确认）；
- 不改现有 CLI 行为、不改 schema。
