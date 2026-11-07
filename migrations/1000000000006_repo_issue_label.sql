-- 仓库级 Issue label：repo.issue_label。
--
-- 事实来源：docs/archive/tasks/2026-11/08-29-ingress-poller/design.md §2。
--
-- `keel poller` 需要按各仓库自己的 label 扫描 open issue。全局 --label 无法表达
-- A/B/C 多项目用不同 label 的场景，所以 label 属于仓库身份，放在 repo 上。
--
-- 可加列 + 默认值：既有行自动回填 'keel'，无需单独的数据迁移。
-- 授权不变：repo 对三个运行时角色仍只有 SELECT；注册 / 改 label 走属主连接。

-- Up Migration

ALTER TABLE repo ADD COLUMN issue_label text NOT NULL DEFAULT 'keel';

-- 只拒绝空白，不限制内容：GitHub label 可以含空格与中文。
-- 空 label 在列表查询里会退化成「列出全部 open issue」，跨过 label 闸门。
ALTER TABLE repo ADD CONSTRAINT repo_issue_label_nonempty
  CHECK (btrim(issue_label) <> '');

-- Down Migration

ALTER TABLE repo DROP CONSTRAINT IF EXISTS repo_issue_label_nonempty;
ALTER TABLE repo DROP COLUMN IF EXISTS issue_label;
