# 项目页重构 — 实施计划

## 顺序

1. **格式化辅助**
   - [x] `fmtCostShort`:项目级成本按 2 位小数(< $0.01 仍保留 4 位)
   - [x] `fmtListTime`:MM-DD HH:mm(列表不再显示秒)

2. **聚合与排序**
   - [x] `groupByRepo` 增加 `needsYou`(仅 `isGateStatus`)
   - [x] 排序改为 `needsYou` 降序 → `lastUpdated` 降序
   - [x] `projectGroupOf(status)` 新增,作为分组唯一判定

3. **侧栏项目项**
   - [x] `renderProjects` 输出 2 行结构:名字 + 待处理徽章 / 摘要行
   - [x] 完整 URL 进 `title`;移除 provider、完整 URL、成本、秒级时间
   - [x] `renderOverviewProjects` 复用同款两行结构与徽章

4. **项目详情**
   - [x] 头部:标题 + 一句话现状 + 累计元信息行;删除 6 块指标带
   - [x] 删除状态分布图与相关 CSS
   - [x] 任务列表改为分组列表(needs / stage / waiting / terminal)
   - [x] needs 组行内给 `去决策 →` / `去回答 →`;点击仍走 `select()`
   - [x] 列表列收敛为:状态 / 标题 / 更新时间(+ 行动提示)
   - [x] 空项目、筛选无命中给单行空态

5. **筛选归位**
   - [x] 项目视图渲染 `.proj-filters`(全部/运行中/待介入/已完成/异常 + 计数)
   - [x] 项目模式下 `applyModeChrome` 隐藏侧栏 `#status-filters`
   - [x] `#detail` 委托监听处理 `.filter-pill[data-cat]`
   - [x] chip 计数与筛后行数一致;切项目 / 轮询不丢筛选

6. **样式**
   - [x] 删除 `.proj-stats` / `.proj-stat*` / `.proj-dist*` / `.proj-table*` / `.proj-budget-bar`
   - [x] 新增 `.proj-summary` / `.proj-meta` / `.proj-group*` / `.proj-row*` / `.proj-attention`
   - [x] 1024px / 900px 断点:CTA 收起、行内换行、不横向溢出
   - [x] 暗色模式只用现有 token

7. **测试与规范**
   - [x] `console.test.ts` 增加关键结构断言
   - [x] 更新 `.trellis/spec/frontend/console-guidelines.md` 的项目视图章节
   - [x] `pnpm run lint && pnpm run typecheck && pnpm test`

## 验证命令

```bash
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run console   # 本地打开 #mode=projects 验收
```

## 回滚点

- 改动集中在 `src/cli/console-page.ts` 与规范文档;
  回滚 = 还原该文件,不涉及数据、迁移或接口。
- 若分组结构验收不通过,可先保留头部一句话 + 侧栏瘦身,单独回退分组列表。

## 验收清单

- [x] 首屏第一组是「需要你处理」,点击直达决策 Tab
- [x] 无待处理时,第一组不渲染,头部明确说「没有进行中的任务」
- [x] 项目模式侧栏无状态 chip;列表上方 chip 生效且计数一致
- [x] 侧栏项目项 2 行,待处理项目排前
- [x] 列表无分支、无单任务成本、时间无秒
- [x] `pnpm run check` 全绿
