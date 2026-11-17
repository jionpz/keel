-- Up Migration
-- 可选配置：NULL 保持旧身份、header、正文与关闭签名的行为；授权矩阵不变。
ALTER TABLE repo
  ADD COLUMN commit_author text,
  ADD COLUMN commit_message_template text,
  ADD COLUMN commit_message_check text,
  ADD COLUMN commit_types text[],
  ADD COLUMN commit_scopes text[],
  ADD CONSTRAINT repo_commit_author_valid CHECK (
    commit_author IS NULL OR (length(commit_author) <= 320 AND
      commit_author ~ '^[^<>\r\n]+ <[^<>[:space:]@]+@[^<>[:space:]@]+>$')
  ),
  ADD CONSTRAINT repo_commit_template_valid CHECK (
    commit_message_template IS NULL OR (length(commit_message_template) BETWEEN 1 AND 100
      AND commit_message_template !~ '[\r\n]'
      AND commit_types IS NOT NULL AND commit_scopes IS NOT NULL)
  ),
  ADD CONSTRAINT repo_commit_check_valid CHECK (
    commit_message_check IS NULL OR length(commit_message_check) BETWEEN 1 AND 1000
  ),
  ADD CONSTRAINT repo_commit_types_valid CHECK (
    commit_types IS NULL OR (cardinality(commit_types) > 0 AND array_position(commit_types, NULL) IS NULL)
  ),
  ADD CONSTRAINT repo_commit_scopes_valid CHECK (
    commit_scopes IS NULL OR (cardinality(commit_scopes) > 0 AND array_position(commit_scopes, NULL) IS NULL)
  );

-- Down Migration
ALTER TABLE repo
  DROP COLUMN commit_scopes,
  DROP COLUMN commit_types,
  DROP COLUMN commit_message_check,
  DROP COLUMN commit_message_template,
  DROP COLUMN commit_author;
