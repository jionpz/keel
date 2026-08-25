#!/bin/sh
# C1 检查：src/generated 与 docs/schemas 及 HEAD 的一致性。
#
# R12(issue #23)：旧的 check:generated = `generate && git diff --exit-code HEAD`——
# generate 先重写 src/generated(手改被就地抹掉),随后 diff 恒空,「检测手改」
# 实为「静默覆盖手改」。现在：
#   1. 生成**前**先查手改 —— 有手改立即红(提醒,不静默丢弃);
#   2. 重生成;
#   3. 生成后查同步 —— schema 变更未提交生成产物时红。
set -e

echo "── 1/3 检查 src/generated 是否有手改(生成前)──"
if ! git diff --exit-code HEAD -- src/generated >/dev/null 2>&1; then
  echo "✗ src/generated 有未提交手改 —— 重生成会覆盖它们。"
  echo "  请先 git checkout -- src/generated 还原(或确认这是 schema 变更产生的产物)。"
  exit 1
fi
echo "✓ 无手改"

echo "── 2/3 由 docs/schemas 重生成 ──"
pnpm run generate

echo "── 3/3 检查生成产物与 HEAD 同步 ──"
if ! git diff --exit-code HEAD -- src/generated >/dev/null 2>&1; then
  echo "✗ schema 变更未提交生成产物 —— 请提交 src/generated(ADR-0002 要求产物入库)。"
  exit 1
fi
echo "✓ C1 一致"