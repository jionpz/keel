-- 本地项目绑定：repo.local_path。
--
-- 事实来源：.trellis/tasks/10-27-local-project-binding/design.md §2/§3。
--
-- `local_path` 让一个 repo 绑定用户已有的本地检出口。它在语义上属于
-- 「这个远程仓库在我机器上的哪个副本」，是仓库身份的一部分，所以放在 repo 上，
-- 而不是新增 project 表（v0.1 单仓库单项目）。
--
-- 授权不变：repo 对 keel_control / keel_execution / keel_ingress 仍只有 SELECT；
-- 绑定是管理操作，写入走属主连接（与 register-repo 一致）。

-- Up Migration

ALTER TABLE repo ADD COLUMN local_path text;

-- 第二道防线：规范化由应用层（canonicalizeDir）负责，数据库只拦住
-- 「明显不是绝对路径」的写入。数据库无法做 realpath，所以不能只靠这里。
ALTER TABLE repo ADD CONSTRAINT repo_local_path_absolute
  CHECK (local_path IS NULL OR local_path LIKE '/%');

-- 一个本地目录只能绑定一个 repo：同一工作树被两个项目同时认领时，
-- 两个 Task 会在用户背后互相干扰，且「谁改的」无法归因。
-- 部分索引：managed 模式（local_path IS NULL）不参与唯一性。
CREATE UNIQUE INDEX repo_local_path_unique
  ON repo (local_path) WHERE local_path IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS repo_local_path_unique;
ALTER TABLE repo DROP CONSTRAINT IF EXISTS repo_local_path_absolute;
ALTER TABLE repo DROP COLUMN IF EXISTS local_path;
