# 项目页重构 — 技术设计

## 1. 信息架构

### 侧栏项目项(2 行)

```
local/keel-demo-repo                2 待处理
5 个任务 · 2 运行 · 1 完成 · 10-25 14:19
```

- 第一行:项目短名 + 待处理徽章(仅当 `needsYou > 0`)。
- 第二行:任务数 + 非零状态计数 + 最近更新(分钟精度)。
- 完整仓库 URL 进 `title`;provider 不再常驻(短名已区分 `owner/repo` 与 `local/name`)。
- 排序:`needsYou` 降序 → `lastUpdated` 降序。
  `needsYou` 只数「能直接进决策页」的两个状态,不数与自动化等待的闸门态。

### 项目详情

```
项目名
2 个任务需要你处理,2 个在跑
5 个任务 · 21 轮 · 累计 $1.68 · 最近更新 10-25 14:19

[全部 5] [运行中 2] [待介入 2] [已完成 1] [异常 0]        显示 5 / 5
────────────────────────────────────────────
需要你处理  2        点任务直接进入决策页
  人工介入  demo3: README Usage 小节   更新 11-04 14:19   去决策 →
  人工介入  demo2: README Usage 小节   更新 10-25 18:09   去决策 →
进行中  2
  质量验证  Demo: 在 README 增加 …     更新 10-25 18:02
  PM 分析   Demo: 在 README 增加 …     更新 10-25 17:59
等待中  0
已收尾  1
  已完成    demo4: README Usage 小节   更新 10-25 22:47
```

- 分组顺序固定:`needs` → `stage` → `waiting` → `terminal`;空组整组不渲染。
- 组内排序:`bad` 先于 `done`,同状态按 `updated_at` 降序。
- 行 = 状态徽章 + 标题 + 更新时间 + (仅 needs 组)行动提示。
- 行动提示文案:
  - `S-HUMAN_REVIEW` → `去决策 →`
  - `S-NEED_CLARIFICATION` → `去回答 →`
- 点击行仍走现有 `select(taskId)`;它会重置 `tabChosen`,闸门任务自动落决策 Tab。
  **不新增路由、不复制决策逻辑。**

## 2. 分组契约(唯一判定处)

```js
function projectGroupOf(status) {
  if (isGateStatus(status)) return 'needs';        // S-HUMAN_REVIEW / S-NEED_CLARIFICATION
  if (statusKind(status) === 'stage') return 'stage';
  if (statusKind(status) === 'gate') return 'waiting'; // S-NEW / S-RFC_READY / S-PR_OPEN
  return 'terminal';                               // done + bad
}
```

- `statusKind` / `isGateStatus` 已是页面内既有函数,状态集合来自 `/api/meta`;
  不新增第三份状态表。
- 「需要你处理」与筛选 chip 的「待介入」口径不同:
  - 待处理 = 可立即决策(needs 组);
  - 待介入 = 所有闸门态(needs + waiting)。
  两者标签不同、含义不同,并在分组标题上写明,避免用户以为 chip 撒谎。

## 3. 计数与筛选

- 页面级计数只保留两处:分组标题的计数 + 筛选 chip 的计数。
- 筛选 chip 从 `#status-filters` 复制到项目视图的 `.proj-filters`(同一 `data-cat`),
  项目模式下隐藏侧栏 `#status-filters`;任务模式行为不变。
- 项目视图内的 chip 在每次渲染时按 `statusCounts(p.tasks)` 现算并标记 active;
  不依赖 `renderFilterCounts()` 的全局刷新。
- 点击 `.proj-filters .filter-pill` 由 `#detail` 的委托监听处理:
  更新 `state.statusCat` 后重绘项目视图。
- 筛选仍不进 URL Hash(临时视图态),但切项目 / 5s 轮询不丢。

## 4. 数据流

```
GET /api/tasks → state.tasks
  → groupByRepo(tasks)             # 增加 needsYou 与 attention-first 排序
  → renderProjects()               # 侧栏 2 行 + 概览项目块同款结构
  → renderProjectView()            # 一句话现状 + 分组列表
```

- 不新增请求;`needsYou` 在 `groupByRepo` 里随聚合一次算出。
- `renderOverviewProjects()` 复用同一行结构,只保留 name / 待处理徽章 / 摘要行。

## 5. 取舍

- **删掉状态分布条**:它与分组计数表达同一事实;项目通常只有几十个任务,
  形状不提供额外决策信息。若未来项目规模大到需要趋势,再单做时间趋势而非状态占比。
- **删掉单任务分支与成本**:分支是执行细节,成本在头部有累计;
  核对单任务时进任务详情,那里本来就有完整事实。
- **侧栏不显示成本**:项目列表用于「找项目」,不是对账;成本留在项目详情。
- **待处理徽章只数两个决策态**:它回答「有没有事等我」,必须精确;
  自动等待中的闸门态放到「等待中」组,避免把系统等待误报成人的待办。

## 6. 兼容与回归面

- URL Hash 不变:`#mode=projects&repo=<url>` 仍可直达;模式切换、轮询逻辑不变。
- 任务模式、概览模式的侧栏结构不变(概览项目块的行结构同步调整)。
- `console.test.ts` 新增结构断言:页面字符串包含 `项目` / `需要你处理` /
  `proj-filters` / `needsYou` 等关键片段,防止重构把入口删掉。
- 窄屏:`@media (max-width: 1024px)` 只做行内换行与 CTA 收起,
  覆盖规则继续放在文件末尾。

## 7. 可访问性

- 分组标题用 `<h3>`;行用 `<li>` + `data-task-id`,保持现有委托点击。
- 行动提示是文本而非只有颜色;待处理徽章同时有文字与颜色。
- 颜色对比沿用现有 token,不新增颜色。

## 8. 验证

- `pnpm run lint` / `typecheck` / `test`(至少 `src/cli/console.test.ts`)。
- 本地 `pnpm run console` 打开 `#mode=projects`:
  - 有待处理任务时首屏第一组可见,点击直达决策 Tab;
  - 切换 chip 后行数与 chip 计数一致;
  - 1024px 与 900px 下不横向溢出。
