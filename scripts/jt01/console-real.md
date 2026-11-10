# 真实控制台人工决策验收（JT-01 / #89）

> 本文档是待运行步骤，不是验收结果。fixture 只写入一条测试快照，不声称完整重放历史。

## 边界

- 只允许 `KEEL_DATABASE_URL` 指向 `localhost` / `127.0.0.1` / `::1` 上的 `keel_jt01_console_*` 专用库；拒绝 query/hash、`keel_dev`、`keel_test` 和非专用库。
- 脚本只新增自己的样本，不 `TRUNCATE`、不 `DELETE`、不修改已有行；重复执行会新增另一个 `external_ref` 唯一的样本。
- 不创建天问用户授权，不代替天问自动答复，不 push、不建 PR。本验收只覆盖人工闸门的真实登录与真实裁决。
- 样本 `repo.remote_url` 指向本工作树；批准时 T-014 会创建 `.keel/repos/<repo_id>.git` 与 `.keel/worktrees/<task_id>/`，验证完成前不要删除。

## 前置

在 `/Users/jionpz/mycode/keel-jstack-delivery` 执行。需要 Node 24、pnpm、PostgreSQL 16、git。

```bash
cd /Users/jionpz/mycode/keel-jstack-delivery
DB=keel_jt01_console_20261110
export KEEL_DATABASE_URL="postgres://localhost/$DB"
export DATABASE_URL="$KEEL_DATABASE_URL"
createdb "$DB"
pnpm run db:migrate
```

`createdb` 只创建新库；同名库已存在时换一个 `keel_jt01_console_*` 名称，不要重建或清空旧库。迁移读 `DATABASE_URL`，控制台与 fixture 读 `KEEL_DATABASE_URL`。

## 创建样本

```bash
pnpm exec tsx scripts/jt01/console-fixture.ts
```

成功时输出 `database=...`、`task_id=<uuid>`、`repo_id=<uuid>`、`work_branch=ai/task-<8 hex>`、`sample_ref=jt01-console:<uuid>`。运行时校验数据库名、`current_database()` 与 8 张核心表；任一不符即失败。记下 `TASK_ID`。

快照内容：
- `task.status = S-HUMAN_REVIEW`，`control_mode = auto`，关联一条 `feedback(source=manual)`。
- 5 个 Run：`rfc_draft#1` 仅作为 artifact 的最小引用，`develop#1` 成功，`qa#1`～`qa#3` 以 `PROTOCOL_ERROR` 失败。usage 与 cost 为 null，`cost_basis=unavailable`。
- 1 个 `rfc` v1 artifact（完整 RFC shape）、1 条 `WorkspaceDiffCollected`（unified patch、1 个文件）、最终 `T-031 S-QA -> S-HUMAN_REVIEW` 状态事件。
- 1 个 `human_review_ttl` pending timer。没有 pm / brainstorm / 中间状态历史，这是测试快照。

## 启动控制台

保持同一组环境变量，另开终端：

```bash
export KEEL_HOME="$PWD/.keel"
export KEEL_CONSOLE_PORT=4322
export KEEL_CONSOLE_PASSWORD='jt01-console-local'
pnpm run console
```

预期包含 `keel console: http://127.0.0.1:4322`；不要使用 `0.0.0.0`。

## 浏览器验证

1. 打开 `http://127.0.0.1:4322/login`，在 `#password` 填写 `jt01-console-local`，点击 `#submit`。
2. 点击 `li.task-item[data-id="<TASK_ID>"]`，确认 `.decision-page` 可见，状态为 `S-HUMAN_REVIEW`。
3. 决策页应显示「为什么停在这里」为 `qa #3` 失败后升人工，「证据」含 QA 3 轮轨迹（最后一轮 `FAILED` / `PROTOCOL_ERROR`），并显示工作分支、`RFC v1《Excel 导出支持日期区间筛选》`、1 个文件。
4. 展开「查看方案核心要点」的 `details`，确认 goals 与 AC1 / AC2；展开「查看改动的 1 个文件清单」，确认 `src/export/date-range.ts` 与 `+3` / `-1`。
5. 点击 `data-goto="diff"`，确认 `.diff-block` 含 `+` / `-` 行与 `date-range.ts`；回到 `data-tab="decision"`。
6. 在 `textarea[data-note-for="approve"]` 填写理由，点击 `button[data-act="approve"]`，抓取 `POST /api/tasks/<TASK_ID>/decide`：期望 200，JSON 含 `"ok": true`、`"from": "S-HUMAN_REVIEW"`、`"to": "S-DEVELOPING"`。
7. 约 600ms 后自动刷新，状态变为「开发中」，决策 Tab 消失，出现 `develop #2 PENDING`。若返回 `base_missing` / `fetch_failed` / `worktree_failed`，按失败报告，不要当作通过。

## 批准前 SQL

```bash
psql "$KEEL_DATABASE_URL" -c "SELECT current_database();"
psql "$KEEL_DATABASE_URL" -c "SELECT status, control_mode, work_branch, terminal_at FROM task WHERE id = '<TASK_ID>';"
psql "$KEEL_DATABASE_URL" -c "SELECT stage, attempt, status, error_kind FROM run WHERE task_id = '<TASK_ID>' ORDER BY started_at, stage, attempt;"
psql "$KEEL_DATABASE_URL" -c "SELECT kind, version, body->>'title' AS title FROM artifact WHERE task_id = '<TASK_ID>';"
psql "$KEEL_DATABASE_URL" -c "SELECT kind, state, fired_at FROM timer WHERE task_id = '<TASK_ID>';"
```

预期：`S-HUMAN_REVIEW`、`auto`、`terminal_at IS NULL`；5 个 Run；1 条 `rfc` v1；`human_review_ttl` 为 `pending` 且 `fired_at IS NULL`。

## 批准后 SQL

批准后必须另开查询：

```bash
psql "$KEEL_DATABASE_URL" -c "SELECT status, control_mode, terminal_at, updated_at FROM task WHERE id = '<TASK_ID>';"
psql "$KEEL_DATABASE_URL" -c "SELECT stage, attempt, status, idempotency_key FROM run WHERE task_id = '<TASK_ID>' ORDER BY started_at;"
psql "$KEEL_DATABASE_URL" -c "SELECT kind, state, fired_at FROM timer WHERE task_id = '<TASK_ID>';"
psql "$KEEL_DATABASE_URL" -c "SELECT type, payload->>'transition' AS transition, payload->>'from' AS from_status, payload->>'to' AS to_status FROM event WHERE task_id = '<TASK_ID>' ORDER BY seq DESC LIMIT 6;"
psql "$KEEL_DATABASE_URL" -c "SELECT type, payload->>'kind' AS kind, payload->>'branch' AS branch FROM event WHERE task_id = '<TASK_ID>' AND type IN ('SideEffectApplied','SideEffectIntent') AND payload->>'kind' = 'CreateBranch' ORDER BY seq DESC LIMIT 1;"
```

预期：`S-DEVELOPING`、`terminal_at IS NULL`、`updated_at` 晚于批准前；新增 `develop#2 PENDING`；`human_review_ttl` 为 `cancelled`；存在 `T-014 S-HUMAN_REVIEW -> S-DEVELOPING`；存在 `SideEffectApplied` 且 `branch=ai/task-<8 hex>`。

## 成功判据

- 真实登录与决策页渲染通过，RFC / diff 可展开。
- `POST /decide` 返回 200 且 `from/to` 正确。
- 数据库状态、`develop#2`、ttl、`T-014`、`SideEffectApplied CreateBranch` 均符合上节。
- 批准前样本保持 `S-HUMAN_REVIEW`，且没有修改其他样本行。

## 未覆盖
- 未创建或验证天问用户授权，也未验证 S-NEED_CLARIFICATION 的答复路径。
- 未声称 `pnpm run check`、迁移或浏览器步骤已经执行；本文件只是待运行步骤。
