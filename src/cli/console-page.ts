/**
 * keel 控制台页面 —— 单文件 HTML（内联 CSS / JS，无构建、无外部资源）。
 *
 * 约束（.trellis/spec/frontend/console-guidelines.md）：
 *  - 只读：页面只发 GET，不发写请求；
 *  - 无依赖：不引 CDN、不引框架（docs/09-roadmap.md 把 UI 定义为消费者，
 *    本页也刻意保持「删掉不影响任何事实」的形态）；
 *  - 客户端 JS 用字符串拼接而非模板字符串 —— 避免与外层模板字符串冲突。
 */

export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Keel Console · AI Engineering Runtime Observatory</title>
<style>
  :root {
    color-scheme: light dark;
    /* macOS 系统色板：窗口 / 侧栏 / 内容面用同一套中性灰，强调色只出现在选中与运行态 */
    --bg: #f5f5f7;
    --bg-elev: #f2f2f4;
    --panel: #ffffff;
    --panel-alt: #f7f7f9;
    --code-bg: #f2f2f5;
    --text: #1d1d1f;
    --text-sec: #48484a;
    --muted: #86868b;
    --line: rgba(0, 0, 0, 0.085);
    --line-strong: rgba(0, 0, 0, 0.16);
    --accent: #0a7aff;
    --accent-soft: rgba(10, 122, 255, 0.10);
    --stage: #0a7aff;
    --stage-soft: rgba(10, 122, 255, 0.10);
    --gate: #c93400;
    --gate-soft: rgba(255, 149, 0, 0.14);
    --done: #1d7d36;
    --done-soft: rgba(52, 199, 89, 0.14);
    --bad: #d70015;
    --bad-soft: rgba(255, 59, 48, 0.12);
    --purple: #5e5ce6;
    --purple-soft: rgba(94, 92, 230, 0.12);
    --diff-add-bg: rgba(52, 199, 89, 0.14);
    --diff-add-text: #196c30;
    --diff-del-bg: rgba(255, 59, 48, 0.12);
    --diff-del-text: #a80012;
    --diff-hunk-bg: rgba(10, 122, 255, 0.08);
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #161618;
      --bg-elev: #1d1d1f;
      --panel: #1c1c1e;
      --panel-alt: #2c2c2e;
      --code-bg: #111113;
      --text: #f5f5f7;
      --text-sec: #c7c7cc;
      --muted: #8e8e93;
      --line: rgba(255, 255, 255, 0.10);
      --line-strong: rgba(255, 255, 255, 0.20);
      --accent: #0a84ff;
      --accent-soft: rgba(10, 132, 255, 0.18);
      --stage: #0a84ff;
      --stage-soft: rgba(10, 132, 255, 0.18);
      --gate: #ff9f0a;
      --gate-soft: rgba(255, 159, 10, 0.16);
      --done: #30d158;
      --done-soft: rgba(48, 209, 88, 0.16);
      --bad: #ff453a;
      --bad-soft: rgba(255, 69, 58, 0.16);
      --purple: #bf5af2;
      --purple-soft: rgba(191, 90, 242, 0.16);
      --diff-add-bg: rgba(48, 209, 88, 0.16);
      --diff-add-text: #7ee2a0;
      --diff-del-bg: rgba(255, 69, 58, 0.16);
      --diff-del-text: #ffa8a2;
      --diff-hunk-bg: rgba(10, 132, 255, 0.12);
    }
  }

  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #161618;
    --bg-elev: #1d1d1f;
    --panel: #1c1c1e;
    --panel-alt: #2c2c2e;
    --code-bg: #111113;
    --text: #f5f5f7;
    --text-sec: #c7c7cc;
    --muted: #8e8e93;
    --line: rgba(255, 255, 255, 0.10);
    --line-strong: rgba(255, 255, 255, 0.20);
    --accent: #0a84ff;
    --accent-soft: rgba(10, 132, 255, 0.18);
    --stage: #0a84ff;
    --stage-soft: rgba(10, 132, 255, 0.18);
    --gate: #ff9f0a;
    --gate-soft: rgba(255, 159, 10, 0.16);
    --done: #30d158;
    --done-soft: rgba(48, 209, 88, 0.16);
    --bad: #ff453a;
    --bad-soft: rgba(255, 69, 58, 0.16);
    --purple: #bf5af2;
    --purple-soft: rgba(191, 90, 242, 0.16);
    --diff-add-bg: rgba(48, 209, 88, 0.16);
    --diff-add-text: #7ee2a0;
    --diff-del-bg: rgba(255, 69, 58, 0.16);
    --diff-del-text: #ffa8a2;
    --diff-hunk-bg: rgba(10, 132, 255, 0.12);
  }

  :root[data-theme="light"] {
    color-scheme: light;
  }

  * { box-sizing: border-box; }
  /* 下面大量布局用 display:flex/grid，会盖掉 [hidden] 的 UA 样式，必须显式压一层 */
  [hidden] { display: none !important; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 13px/1.45 var(--sans);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, pre, .mono { font-family: var(--mono); font-size: 11.5px; }
  .num, .stat-value, .pill-n, .mode-count, .tab-count { font-variant-numeric: tabular-nums; }

  /* ─── Layout Shell ─── */
  #app {
    display: grid;
    grid-template-columns: 288px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) 26px;
    height: 100vh;
    overflow: hidden;
  }

  /* ─── Sidebar (Task Explorer) ─── */
  aside {
    border-right: 1px solid var(--line);
    background: var(--bg-elev);
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    user-select: none;
    grid-row: 1;
  }

  .brand-bar {
    height: 44px;
    padding: 0 12px 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: 0 0 auto;
  }
  .brand-left {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  /* 单色应用图标，避免渐变图标那种装饰感 */
  .brand-logo {
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: var(--text);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--bg-elev);
    font-weight: 700;
    font-size: 12px;
    letter-spacing: -0.2px;
  }
  .brand-title {
    display: flex;
    align-items: baseline;
    gap: 7px;
    min-width: 0;
  }
  .brand-title h1 {
    font-size: 13px;
    font-weight: 600;
    margin: 0;
    letter-spacing: -0.1px;
  }
  .brand-sub {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .brand-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
  }

  .icon-btn {
    border: 0;
    background: transparent;
    color: var(--text-sec);
    border-radius: 5px;
    padding: 3px 7px;
    cursor: pointer;
    font-size: 11.5px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: background 0.12s;
  }
  .icon-btn:hover {
    color: var(--text);
    background: rgba(128, 128, 128, 0.14);
  }
  .icon-btn:active { background: rgba(128, 128, 128, 0.22); }

  /* ─── 视图导航（macOS 侧栏式） ─── */
  .mode-switch {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 2px 8px 8px;
    flex: 0 0 auto;
  }
  .mode-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border-radius: 6px;
    border: 0;
    background: transparent;
    color: var(--text-sec);
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .mode-btn svg { flex: 0 0 auto; opacity: 0.75; }
  .mode-btn:hover { color: var(--text); background: rgba(128, 128, 128, 0.12); }
  .mode-btn.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .mode-btn.active svg { opacity: 1; }
  .mode-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mode-count {
    font-size: 11.5px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .mode-btn.active .mode-count { color: var(--accent); opacity: 0.8; }

  /* ─── Sidebar Search & Filter Bar ─── */
  .explorer-controls {
    padding: 0 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 0 0 auto;
  }
  .search-box {
    position: relative;
    display: flex;
    align-items: center;
  }
  .search-box input {
    width: 100%;
    height: 26px;
    padding: 0 24px 0 24px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: rgba(128, 128, 128, 0.12);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    outline: none;
    transition: background 0.12s, border-color 0.12s, box-shadow 0.12s;
  }
  .search-box input::placeholder { color: var(--muted); }
  .search-box input:focus {
    background: var(--panel);
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .search-icon {
    position: absolute;
    left: 7px;
    color: var(--muted);
    pointer-events: none;
    display: inline-flex;
  }
  .search-clear {
    position: absolute;
    right: 5px;
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 11px;
    padding: 2px 3px;
    display: none;
  }
  .search-clear:hover { color: var(--text); }
  .filter-pills {
    display: flex;
    gap: 1px;
    flex-wrap: wrap;
  }
  /* 项目筛选：仓库可能很多，用下拉而不是 chip，避免侧栏被撑散 */
  .repo-filter {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 2px;
  }
  .repo-filter label {
    font-size: 11.5px;
    color: var(--muted);
    flex: 0 0 auto;
  }
  .repo-select {
    flex: 1 1 auto;
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border-radius: 5px;
    border: 1px solid transparent;
    background: rgba(128, 128, 128, 0.10);
    color: var(--text-sec);
    font: inherit;
    font-size: 11.5px;
    outline: none;
    cursor: pointer;
  }
  .repo-select:focus { border-color: var(--accent); background: var(--panel); }
  .repo-select.active { color: var(--accent); font-weight: 600; }
  .filter-pill {
    border: 0;
    background: transparent;
    color: var(--muted);
    border-radius: 5px;
    padding: 2px 7px;
    font-size: 11.5px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .filter-pill:hover { color: var(--text); background: rgba(128, 128, 128, 0.12); }
  .filter-pill.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  /* 计数并入筛选 chip（原来那排 KPI 方块和它们是同一件事，占了两行高度） */
  .filter-pill .pill-n {
    font-size: 11px;
    opacity: 0.7;
    margin-left: 3px;
  }
  .filter-pill.active .pill-n { opacity: 1; }

  /* ─── 底部状态栏（VS Code 式，贯穿两栏） ─── */
  .statusbar {
    grid-column: 1 / -1;
    grid-row: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 12px;
    border-top: 1px solid var(--line);
    background: var(--bg-elev);
    font-size: 11px;
    color: var(--muted);
    user-select: none;
  }
  .statusbar-left,
  .statusbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .statusbar .sb-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .statusbar .sb-sep {
    width: 1px;
    height: 12px;
    background: var(--line-strong);
    opacity: 0.6;
  }
  .statusbar label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .statusbar input[type="checkbox"] {
    appearance: none;
    width: 11px;
    height: 11px;
    margin: 0;
    border-radius: 3px;
    border: 1px solid var(--line-strong);
    background: transparent;
    cursor: pointer;
    position: relative;
  }
  .statusbar input[type="checkbox"]:checked {
    background: var(--accent);
    border-color: var(--accent);
  }
  .statusbar input[type="checkbox"]:checked::after {
    content: "";
    position: absolute;
    left: 2.5px;
    top: 0.5px;
    width: 3px;
    height: 6px;
    border: solid #fff;
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
  }
  .health-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--done);
    display: inline-block;
    flex: 0 0 auto;
  }
  .health-dot.err { background: var(--bad); }
  .sb-live { color: var(--text-sec); font-variant-numeric: tabular-nums; }
  .sb-live b { font-weight: 600; }
  .sb-live.run b { color: var(--stage); }
  .sb-live.wait b { color: var(--gate); }

  /* ─── Task List ─── */
  #task-list {
    list-style: none;
    margin: 0;
    padding: 0 6px 8px;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  #task-list li.task-item {
    padding: 5px 8px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    transition: background 0.1s;
  }
  #task-list li.task-item:hover { background: rgba(128, 128, 128, 0.10); }
  #task-list li.task-item.active { background: var(--accent-soft); }
  #task-list li.task-item.active .task-title { color: var(--accent); }

  /* 状态只用一个圆点表达；中文短名放在第二行，机器码留给详情页 */
  .task-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-top: 6px;
    flex: 0 0 auto;
    background: var(--muted);
  }
  .task-dot.stage { background: var(--stage); }
  .task-dot.gate { background: var(--gate); }
  .task-dot.done { background: var(--done); }
  .task-dot.bad { background: var(--bad); }
  .task-body { min-width: 0; flex: 1 1 auto; }
  .task-title-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .task-title {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
  }
  .task-id {
    font-size: 10.5px;
    color: var(--muted);
    font-family: var(--mono);
    flex: 0 0 auto;
  }
  .task-sub {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 1px;
    font-size: 11px;
    color: var(--muted);
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }
  .task-sub .task-status { flex: 0 0 auto; }
  .task-sub .task-status.stage { color: var(--stage); }
  .task-sub .task-status.gate { color: var(--gate); }
  .task-sub .task-status.done { color: var(--done); }
  .task-sub .task-status.bad { color: var(--bad); }
  .task-sub .task-mode { flex: 0 0 auto; color: var(--gate); }
  .task-sub .task-repo {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 0 1 auto;
  }
  .task-sub .task-time { flex: 0 0 auto; margin-left: auto; }

  /* ─── Project List（项目模式侧栏） ─── */
  #project-list {
    list-style: none;
    margin: 0;
    padding: 0 6px 8px;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  #project-list li.proj-item {
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s;
  }
  #project-list li.proj-item:hover { background: rgba(128, 128, 128, 0.10); }
  #project-list li.proj-item.active { background: var(--accent-soft); }
  #project-list li.proj-item.active .proj-item-name > span:first-child { color: var(--accent); }
  .proj-item-name {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-weight: 500;
    font-size: 12.5px;
    color: var(--text);
    margin-bottom: 1px;
    min-width: 0;
  }
  .proj-item-name > span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .proj-item-url {
    font-size: 10.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    margin-bottom: 2px;
  }
  .proj-item-counts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 1px;
    font-variant-numeric: tabular-nums;
  }
  .proj-count { font-size: 11px; font-weight: 500; color: var(--muted); }
  .proj-count.stage { color: var(--stage); }
  .proj-count.gate { color: var(--gate); }
  .proj-count.done { color: var(--done); }
  .proj-count.bad { color: var(--bad); }
  .proj-item-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
  }

  /* ─── Project Overview（项目模式主区） ─── */
  .proj-url {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    word-break: break-all;
  }
  /* 项目指标与任务详情共用一条发丝指标带，不再摆一排圆角卡片 */
  .proj-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    margin: 0 0 2px;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }
  .proj-stat {
    flex: 1 1 132px;
    border: 0;
    background: transparent;
    border-radius: 0;
    padding: 10px 14px 10px 0;
    margin-right: 14px;
  }
  .proj-stat + .proj-stat {
    border-left: 1px solid var(--line);
    padding-left: 14px;
  }
  .proj-stat-lbl {
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0;
    text-transform: none;
  }
  .proj-stat-val {
    font-family: var(--sans);
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.2px;
    margin-top: 2px;
  }
  .proj-stat-sub {
    font-size: 11.5px;
    color: var(--muted);
    margin-top: 2px;
  }
  .proj-stat.stage .proj-stat-val { color: var(--stage); }
  .proj-stat.gate .proj-stat-val { color: var(--gate); }
  .proj-stat.done .proj-stat-val { color: var(--done); }
  .proj-stat.bad .proj-stat-val { color: var(--bad); }
  /* 状态分布：一条堆叠条 + 图例，比四个方块更能看出项目的形状 */
  .proj-dist {
    display: flex;
    height: 10px;
    border-radius: 6px;
    overflow: hidden;
    background: rgba(128, 128, 128, 0.14);
    margin: 10px 0 8px;
  }
  .proj-dist i {
    display: block;
    height: 100%;
  }
  .proj-dist i.stage { background: var(--stage); }
  .proj-dist i.gate { background: var(--gate); }
  .proj-dist i.done { background: var(--done); }
  .proj-dist i.bad { background: var(--bad); }
  .proj-dist-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 12px;
    color: var(--text-sec);
  }
  .proj-dist-legend .lg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .proj-dist-legend .sw {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    display: inline-block;
  }
  .proj-table-wrap {
    overflow-x: auto;
  }
  .proj-table {
    width: 100%;
    min-width: 560px;
    border-collapse: collapse;
    font-size: 12.5px;
  }
  .proj-table th {
    text-align: left;
    font-weight: 600;
    font-size: 11.5px;
    color: var(--muted);
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  .proj-table td {
    padding: 9px 10px;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }
  .proj-table tbody tr {
    cursor: pointer;
    transition: background 0.12s;
  }
  .proj-table tbody tr:hover { background: var(--panel-alt); }
  .proj-table tbody tr.proj-empty,
  .proj-table tbody tr.proj-empty:hover {
    cursor: default;
    background: none;
  }
  .proj-table .proj-empty {
    padding: 22px 10px;
    text-align: center;
    color: var(--muted);
    font-size: 12.5px;
  }
  .proj-table .ct-title {
    font-weight: 600;
    color: var(--text);
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .proj-table .ct-num {
    font-family: var(--mono);
    color: var(--text-sec);
    white-space: nowrap;
  }
  .proj-budget-bar {
    height: 6px;
    border-radius: 4px;
    background: rgba(128, 128, 128, 0.16);
    overflow: hidden;
    margin-top: 6px;
  }
  .proj-budget-bar i {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .proj-budget-bar.over i { background: var(--bad); }

  /* ─── 概览（Overview） ─── */
  .ov-periods {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    padding: 1px;
    border-radius: 6px;
    background: rgba(128, 128, 128, 0.10);
  }
  .ov-period {
    border: 0;
    background: transparent;
    color: var(--text-sec);
    font: inherit;
    font-size: 11.5px;
    padding: 2px 9px;
    border-radius: 5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .ov-period:hover { color: var(--text); }
  .ov-period.active {
    background: var(--panel);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 0 0 1px var(--line), 0 1px 2px rgba(0, 0, 0, 0.06);
  }
  .ov-head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .ov-head-title {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .ov-head-title h2 {
    font-size: 17px;
    font-weight: 600;
    margin: 0;
    letter-spacing: -0.2px;
  }

  /* 一句话摘要：概览的主角，一行说完这段时间发生了什么 */
  .ov-digest {
    font-size: 15px;
    line-height: 1.6;
    color: var(--text);
    margin: 2px 0 14px;
    max-width: 72ch;
  }
  .ov-digest .ov-when { color: var(--muted); }
  .ov-digest b { font-weight: 600; font-variant-numeric: tabular-nums; }
  .ov-digest .bad { color: var(--bad); }
  .ov-digest .done { color: var(--done); }

  .ov-cum {
    font-size: 11.5px;
    color: var(--muted);
    margin: 8px 0 0;
    font-variant-numeric: tabular-nums;
  }

  /* 14 天活动条：一列 = 一天，成功在下、失败在上，点一天就切到那天的口径 */
  .ov-strip {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    padding: 6px 0 2px;
  }
  .ov-day {
    flex: 1 1 0;
    min-width: 0;
    border: 0;
    background: transparent;
    padding: 2px 0 0;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    font: inherit;
  }
  .ov-day:hover { background: rgba(128, 128, 128, 0.10); }
  .ov-day.in-range { background: rgba(128, 128, 128, 0.08); }
  .ov-day.active { background: var(--accent-soft); }
  .ov-day.active .ov-day-label { color: var(--accent); font-weight: 600; }
  .ov-col {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    width: 100%;
    max-width: 22px;
    height: 46px;
    gap: 1px;
  }
  .ov-col i {
    display: block;
    width: 100%;
    border-radius: 2px;
    min-height: 0;
  }
  .ov-col i.ok { background: var(--stage); opacity: 0.9; }
  .ov-col i.bad { background: var(--bad); opacity: 0.85; }
  .ov-col i.zero { background: rgba(128, 128, 128, 0.18); height: 2px !important; }
  .ov-day-label {
    font-size: 9.5px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .ov-strip-legend {
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: var(--muted);
  }
  .ov-strip-legend span { display: inline-flex; align-items: center; gap: 4px; }
  .ov-strip-legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }

  /* 进行中任务：一行一个任务，右侧 10 段阶梯表示走到哪一步 */
  .ov-tasks, .ov-projects {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .ov-task {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 8px;
    margin: 0 -8px;
    border-radius: 6px;
    border-bottom: 1px solid var(--line);
    cursor: pointer;
    transition: background 0.1s;
  }
  .ov-task:last-child { border-bottom: 0; }
  .ov-task:hover { background: rgba(128, 128, 128, 0.08); }
  .ov-task-main { flex: 1 1 auto; min-width: 0; }
  .ov-task-title {
    display: block;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ov-task-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 1px;
    font-size: 11px;
    color: var(--muted);
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }
  .ov-task-meta .task-repo {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ov-task-meta .task-status.stage { color: var(--stage); }
  .ov-task-meta .task-status.gate { color: var(--gate); }
  .ov-task-meta .task-status.done { color: var(--done); }
  .ov-task-meta .task-status.bad { color: var(--bad); }
  .ov-task-meta .ov-when { margin-left: auto; flex: 0 0 auto; }
  .ladder {
    list-style: none;
    display: flex;
    gap: 3px;
    margin: 0;
    padding: 0;
    flex: 0 0 auto;
  }
  .ladder li {
    width: 9px;
    height: 5px;
    border-radius: 1.5px;
    background: rgba(128, 128, 128, 0.20);
  }
  .ladder li.done { background: var(--stage); opacity: 0.5; }
  .ladder li.cur { background: var(--stage); }
  .ladder.gate li.cur { background: var(--gate); }
  .ladder.bad li.done { background: var(--bad); opacity: 0.5; }
  .ladder.bad li.cur { background: var(--bad); }
  .ladder.done li.done { background: var(--done); opacity: 0.75; }

  /* 项目行：名字 + 状态计数 + 体量，一行读一个项目 */
  .ov-proj {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 2px 12px;
    padding: 8px;
    margin: 0 -8px;
    border-radius: 6px;
    border-bottom: 1px solid var(--line);
    cursor: pointer;
    transition: background 0.1s;
  }
  .ov-proj:last-child { border-bottom: 0; }
  .ov-proj:hover { background: rgba(128, 128, 128, 0.08); }
  .ov-proj-name {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ov-proj-counts {
    display: flex;
    gap: 10px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .ov-proj-foot {
    grid-column: 1 / -1;
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  /* 统计还没到位时的占位，不要让页面跳一下空白 */
  .ov-skeleton {
    height: 12px;
    border-radius: 3px;
    background: rgba(128, 128, 128, 0.12);
    margin: 10px 0;
    width: 40%;
  }

  /* 窄屏优先保住状态/标题/成本/时间，分支在任务模式里仍能看 */
  @media (max-width: 1280px) {
    #app { grid-template-columns: 288px minmax(0, 1fr); }
    .proj-table { min-width: 0; }
    .proj-table .ct-title { max-width: 240px; }
    .proj-table th:nth-child(3), .proj-table td:nth-child(3) { display: none; }
  }

  /* ─── Main Detail Area ─── */
  main#detail {
    height: 100%;
    overflow-y: auto;
    background: var(--panel);
    position: relative;
  }
  .view { min-height: 100%; display: flex; flex-direction: column; }
  .view-head {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    padding: 10px 22px 11px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 0 0 auto;
  }
  .view-body { padding: 18px 22px 72px; }

  .empty {
    color: var(--muted);
    padding: 64px 20px;
    text-align: center;
    font-size: 13px;
  }

  /* ─── Badges & Pills ─── */
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    font-weight: 600;
    font-family: var(--mono);
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .badge.stage { color: var(--stage); background: var(--stage-soft); }
  .badge.gate { color: var(--gate); background: var(--gate-soft); }
  .badge.done { color: var(--done); background: var(--done-soft); }
  .badge.bad { color: var(--bad); background: var(--bad-soft); }
  .badge.neutral { color: var(--muted); background: var(--panel-alt); }
  .badge.purple { color: var(--purple); background: var(--purple-soft); }
  /* 人话在前、机器码在后：中文短名常驻，编号降为次要视觉层级 */
  .badge-zh {
    font-family: var(--sans);
    font-size: 12px;
    letter-spacing: 0.2px;
  }
  .badge-code {
    font-size: 10.5px;
    font-weight: 500;
    opacity: 0.72;
    letter-spacing: -0.2px;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    display: inline-block;
  }
  @keyframes pulse-ring {
    0% { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
    70% { box-shadow: 0 0 0 5px transparent; opacity: 0.85; }
    100% { box-shadow: 0 0 0 0 transparent; opacity: 1; }
  }
  .badge.stage .dot, .badge.gate .dot {
    animation: pulse-ring 2s infinite;
  }

  .mode-pill {
    font-size: 11px;
    font-family: var(--mono);
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--line);
    color: var(--text-sec);
    background: var(--panel-alt);
  }
  .mode-pill.human, .mode-pill.paused {
    border-color: var(--gate);
    color: var(--gate);
    background: var(--gate-soft);
  }
  /* 驾驶模式用中文标签，机器码留在 title 里 —— 头部不该出现 control_mode: auto 这种半成品 */
  .mode-pill.drive {
    font-family: var(--sans);
    font-size: 11.5px;
  }

  /* ─── Cockpit Header（详情页常驻头） ─── */
  .cockpit-top-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
  }
  .cockpit-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .cockpit-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-wrap: wrap;
  }
  .copy-btn {
    border: 0;
    background: transparent;
    color: var(--muted);
    border-radius: 5px;
    padding: 3px 7px;
    font-size: 11px;
    font-family: var(--sans);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: background 0.12s, color 0.12s;
  }
  .copy-btn:hover {
    color: var(--text);
    background: rgba(128, 128, 128, 0.12);
  }
  .copy-btn.copied { color: var(--done); }

  /* 人工闸门：只读提示条 —— 命令可复制，页面不发写请求 */
  .human-callout {
    border: 1px solid var(--line-strong);
    border-left: 2px solid var(--gate);
    background: var(--gate-soft);
    padding: 10px 12px;
    margin: 2px 0 14px;
    display: grid;
    gap: 6px;
  }
  .human-callout-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }
  .human-callout-hint {
    font-size: 11px;
    font-weight: 400;
    color: var(--muted);
  }
  .human-callout-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .human-callout-what {
    flex: 0 0 56px;
    font-size: 11.5px;
    color: var(--text-sec);
  }
  .human-callout-cmd {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text);
    background: var(--code-bg);
    padding: 3px 6px;
    border-radius: 4px;
    white-space: nowrap;
    overflow-x: auto;
    min-width: 0;
  }

  .cockpit-title {
    font-size: 17px;
    font-weight: 600;
    margin: 0;
    line-height: 1.3;
    letter-spacing: -0.2px;
    color: var(--text);
    padding-right: 12px;
  }
  .cockpit-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 14px;
    font-size: 11.5px;
    color: var(--muted);
    padding-bottom: 0;
    border-bottom: 0;
  }
  .cockpit-meta code { font-size: 11px; }
  .cockpit-meta-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .pr-link-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--done-soft);
    color: var(--done);
    border: 0;
    padding: 1px 7px;
    border-radius: 4px;
    font-weight: 600;
    font-size: 11.5px;
  }
  .pr-link-pill:hover { text-decoration: none; filter: brightness(0.95); }

  .summary-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    margin: 14px 0 2px;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }
  .stat-box {
    flex: 1 1 132px;
    background: transparent;
    border: 0;
    border-radius: 0;
    padding: 10px 14px 10px 0;
    margin-right: 14px;
  }
  .stat-box + .stat-box {
    border-left: 1px solid var(--line);
    padding-left: 14px;
    margin-right: 14px;
  }
  .stat-label {
    font-size: 11px;
    color: var(--muted);
    text-transform: none;
    letter-spacing: 0;
    margin-bottom: 2px;
  }
  .stat-value {
    font-size: 16px;
    font-weight: 600;
    font-family: var(--sans);
    letter-spacing: -0.2px;
    color: var(--text);
  }
  .stat-sub {
    font-size: 11px;
    color: var(--muted);
    margin-top: 1px;
    font-family: var(--sans);
  }

  /* ─── Cards → 分组区块（发丝分隔，不做卡片堆） ─── */
  .card {
    border-top: 1px solid var(--line);
    padding: 14px 0 2px;
    margin: 0 0 4px;
    background: transparent;
  }
  .view-body > .card:first-child,
  #tab-content > .card:first-child { border-top: 0; padding-top: 2px; }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .card h3 {
    font-size: 12.5px;
    margin: 0;
    color: var(--text);
    font-weight: 600;
    letter-spacing: 0;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .legend-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 11.5px;
    color: var(--muted);
    flex-wrap: wrap;
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .legend-swatch {
    width: 9px;
    height: 9px;
    border-radius: 3px;
    display: inline-block;
  }

  /* ─── State Machine Trajectory ─── */
  .pipeline-scroll {
    overflow-x: auto;
    padding-bottom: 2px;
  }
  .pipeline {
    display: flex;
    align-items: stretch;
    gap: 4px;
    width: 100%;
  }
  .pipeline .step {
    flex: 1 1 0;
    min-width: 84px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 4px;
    padding: 8px 9px 10px;
    border-radius: 7px;
    border: 1px solid var(--line);
    background: var(--panel-alt);
    color: var(--muted);
    position: relative;
    overflow: hidden;
    transition: all 0.15s;
  }
  /* 停留时长条：节点内按最长阶段归一，让耗时成为可见的比例 */
  .pipeline .step-bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(128, 128, 128, 0.12);
  }
  .pipeline .step-bar i {
    display: block;
    height: 100%;
    background: currentColor;
    opacity: 0.55;
  }
  .pipeline .step-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 3px;
  }
  .pipeline .step-name {
    font-family: var(--sans);
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pipeline .step-meta {
    font-size: 11.5px;
    font-weight: 600;
    font-family: var(--mono);
    opacity: 0.95;
    white-space: nowrap;
  }
  .pipeline .step.current .step-meta {
    font-weight: 700;
  }
  .pipeline .step.done {
    border-color: rgba(16, 185, 129, 0.45);
    background: var(--done-soft);
    color: var(--done);
  }
  .pipeline .step.current {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .pipeline .step.current.done-term {
    border-color: var(--done);
    background: var(--done-soft);
    color: var(--done);
    box-shadow: 0 0 0 2px var(--done-soft);
  }
  .pipeline .step.skipped {
    border-style: dashed;
    border-color: var(--line-strong);
    background: transparent;
    color: var(--muted);
    opacity: 0.65;
  }
  /* 偏离主路径时，标出「从哪个阶段分出」，让轨道与下方分支说明连起来 */
  .pipeline .step.departed {
    border-color: rgba(245, 158, 11, 0.55);
    border-style: dashed;
    background: var(--gate-soft);
    color: var(--text-sec);
  }
  .branch-dwell {
    margin-left: auto;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
  }
  .pipeline .arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 10px;
    opacity: 0.55;
    flex: 0 0 auto;
  }

  .branch-callout {
    margin-top: 12px;
    padding: 11px 14px;
    border-radius: 8px;
    border: 1px solid rgba(245, 158, 11, 0.45);
    background: var(--gate-soft);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .branch-callout.bad {
    border-color: rgba(244, 63, 94, 0.45);
    background: var(--bad-soft);
  }
  .branch-callout-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12.5px;
    font-weight: 600;
  }
  .branch-callout-reason {
    font-size: 12px;
    color: var(--text-sec);
  }

  .next-transitions {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .next-label {
    font-size: 11.5px;
    color: var(--muted);
    font-weight: 600;
  }
  .tr-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: var(--panel-alt);
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-sec);
  }
  .tr-chip .tr-code { color: var(--accent); font-weight: 600; }
  .tr-chip .tr-guard {
    color: var(--muted);
    font-size: 10.5px;
    border-left: 1px solid var(--line);
    padding-left: 5px;
  }

  /* ─── 一句话现状 ─── */
  .status-summary {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 2px 0 4px;
    padding: 9px 12px;
    border: 0;
    border-left: 2px solid var(--accent);
    border-radius: 0;
    background: var(--accent-soft);
  }
  .status-summary.term {
    border-left-color: var(--done);
  }
  .status-summary.bad {
    border-left-color: var(--bad);
  }
  .status-summary .ss-tag {
    flex: 0 0 auto;
    margin-top: 2px;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--accent);
    border: 0;
    border-radius: 0;
    padding: 0;
    opacity: 0.9;
    letter-spacing: 0.2px;
  }
  .status-summary.term .ss-tag { color: var(--done); }
  .status-summary.bad .ss-tag { color: var(--bad); }
  .status-summary p {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.65;
    color: var(--text);
  }
  .status-summary .ss-next {
    color: var(--text-sec);
  }

  /* ─── 术语表 ─── */
  .glossary-panel {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px dashed var(--line);
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 8px 20px;
  }
  .glossary-panel[hidden] { display: none; }
  .gloss-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--text-sec);
  }
  .gloss-term {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-weight: 700;
    font-size: 11.5px;
    color: var(--accent);
  }

  /* ─── Workspace Tabs ─── */
  .tabs-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 16px;
    overflow-x: auto;
  }
  .tab-btn {
    border: 0;
    border-bottom: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    padding: 9px 10px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
    transition: all 0.15s;
  }
  .tab-btn:hover { color: var(--text); }
  .tab-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .tab-count {
    font-size: 11px;
    padding: 0;
    border-radius: 0;
    background: transparent;
    border: 0;
    color: var(--muted);
  }
  .tab-btn.active .tab-count {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
  }

  /* ─── Overview & Structured Artifacts ─── */
  .feedback-body {
    background: var(--panel-alt);
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    padding: 12px 14px;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 13.5px;
    line-height: 1.65;
    max-width: 78ch;
    /* 需求正文可能很长，超过一屏就自己滚，别把后面的评审结论挤到看不见 */
    max-height: 520px;
    overflow: auto;
    color: var(--text);
  }
  .outcomes-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    align-items: start;
    gap: 10px;
  }
  .outcome-card {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .outcome-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .outcome-stage {
    font-family: var(--mono);
    font-weight: 600;
    font-size: 12.5px;
    color: var(--text);
  }
  .outcome-reason {
    font-size: 13px;
    color: var(--text-sec);
    line-height: 1.6;
  }

  .rfc-section {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--line);
  }
  .rfc-section:first-child {
    margin-top: 0;
    padding-top: 0;
    border-top: 0;
  }
  .rfc-sec-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    margin: 0 0 8px;
  }
  .rfc-two-col {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
  }
  .rfc-list {
    margin: 0;
    padding-left: 18px;
    color: var(--text-sec);
    font-size: 13.5px;
    line-height: 1.65;
  }
  .rfc-list li { margin-bottom: 4px; }
  .file-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .file-tag {
    font-family: var(--mono);
    font-size: 11.5px;
    padding: 2px 8px;
    border-radius: 5px;
    background: var(--code-bg);
    border: 1px solid var(--line);
    color: var(--accent);
  }
  .ac-table th, .ac-table td {
    padding: 8px 10px;
  }
  .ac-id {
    font-family: var(--mono);
    font-weight: 700;
    color: var(--accent);
    white-space: nowrap;
  }

  .facts-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .fact-chip {
    font-family: var(--mono);
    font-size: 11.5px;
    padding: 3px 8px;
    border-radius: 6px;
    background: var(--panel-alt);
    border: 1px solid var(--line);
    color: var(--text-sec);
  }

  /* ─── Runs & Context Builder ─── */
  .run-card {
    background: transparent;
    border: 0;
    border-top: 1px solid var(--line);
    border-radius: 0;
    padding: 12px 0;
    margin-bottom: 0;
  }
  .run-card:first-child { border-top: 0; padding-top: 2px; }
  .run-card:last-child { margin-bottom: 0; }
  .run-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 10px;
  }
  .run-card-left {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .run-stage-badge {
    font-family: var(--mono);
    font-weight: 700;
    font-size: 13px;
    color: var(--text);
  }
  .run-metrics-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 18px;
    font-size: 12px;
    color: var(--muted);
    font-family: var(--mono);
    padding: 8px 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 7px;
  }
  .ctx-box {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: 7px;
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .ctx-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11.5px;
    margin-bottom: 6px;
    color: var(--text-sec);
  }
  .progress-track {
    height: 7px;
    border-radius: 999px;
    background: var(--panel-alt);
    border: 1px solid var(--line);
    overflow: hidden;
    margin-bottom: 8px;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
  }
  .ctx-sections {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .ctx-sec-pill {
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 5px;
    background: var(--panel-alt);
    border: 1px solid var(--line);
    color: var(--text-sec);
  }

  /* ─── Git Diff Viewer ─── */
  .diff-file-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 14px;
  }
  .diff-file-pill {
    font-family: var(--mono);
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px;
    background: var(--panel-alt);
    border: 1px solid var(--line);
    color: var(--text-sec);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .diff-file-pill:hover { border-color: var(--accent); color: var(--accent); }
  .diff-add-stat { color: var(--done); font-weight: 600; }
  .diff-del-stat { color: var(--bad); font-weight: 600; }

  .diff-block {
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 14px;
    background: var(--code-bg);
  }
  .diff-block-header {
    padding: 8px 12px;
    background: var(--panel-alt);
    border-bottom: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .diff-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.45;
  }
  .diff-table td {
    padding: 1px 8px;
    border: 0;
    vertical-align: top;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .diff-table td.ln {
    width: 44px;
    min-width: 44px;
    text-align: right;
    color: var(--muted);
    user-select: none;
    opacity: 0.65;
    border-right: 1px solid var(--line);
    padding: 1px 6px;
  }
  .diff-table tr.diff-hunk td {
    background: var(--diff-hunk-bg);
    color: var(--stage);
    font-weight: 600;
    padding: 3px 8px;
  }
  .diff-table tr.diff-add td {
    background: var(--diff-add-bg);
    color: var(--diff-add-text);
  }
  .diff-table tr.diff-del td {
    background: var(--diff-del-bg);
    color: var(--diff-del-text);
  }

  /* ─── Tables & Event Timeline ─── */
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 11.5px; }
  tr:last-child td { border-bottom: 0; }

  .timeline-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--line);
  }
  .timeline-filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .timeline-select, .timeline-search {
    padding: 4px 9px;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: var(--panel-alt);
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }

  .timeline td.seq { width: 52px; font-family: var(--mono); color: var(--muted); font-weight: 600; }
  .timeline td.time { width: 145px; white-space: nowrap; color: var(--muted); font-family: var(--mono); font-size: 11.5px; }
  .timeline td.type { width: 185px; white-space: nowrap; }
  .timeline td.run-col { width: 90px; white-space: nowrap; font-family: var(--mono); }
  .ev-summary {
    font-size: 12.5px;
    color: var(--text);
    margin-bottom: 3px;
    font-weight: 500;
  }
  details summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 12px;
    user-select: none;
  }
  details summary:hover { color: var(--accent); }
  details pre {
    margin: 6px 0 0;
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--code-bg);
    border: 1px solid var(--line);
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-sec);
    max-height: 420px;
    overflow: auto;
  }

  .muted { color: var(--muted); }

  /* 窄屏收口放在全部组件规则之后 —— 同样的选择器只有写在后边才盖得住基础样式 */
  @media (max-width: 1024px) {
    .ov-task .ladder { display: none; }
    /* 把宽度还给详情区：侧栏收窄，指标条不落单块，状态机轨迹压到一屏 */
    #app { grid-template-columns: 260px minmax(0, 1fr); }
    .stat-box { flex: 1 1 96px; margin-right: 10px; padding-right: 10px; }
    .stat-box + .stat-box { padding-left: 10px; margin-right: 10px; }
    .stat-value { font-size: 15px; }
    /* 窄屏去掉阶段之间的箭头，10 段主路径才能一屏读完，不必横向滚动 */
    .pipeline .arrow { display: none; }
    .pipeline .step { min-width: 64px; padding: 7px 6px 9px; }
    .pipeline .step-name { font-size: 11px; }
  }

  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
  }

  @media (max-width: 900px) {
    #app { grid-template-columns: 1fr; height: auto; overflow: visible; }
    aside { height: auto; max-height: 48vh; border-right: 0; border-bottom: 1px solid var(--line); }
    main#detail { height: auto; overflow: visible; padding: 16px; }
  }
</style>
</head>
<body>
<div id="app">
  <aside>
    <div class="brand-bar">
      <div class="brand-left">
        <div class="brand-logo" aria-hidden="true">K</div>
        <div class="brand-title">
          <h1>Keel</h1>
          <span class="brand-sub" id="count">加载中…</span>
        </div>
      </div>
      <div class="brand-actions">
        <button id="theme-btn" class="icon-btn" type="button" title="切换明/暗主题">主题</button>
        <button id="refresh" class="icon-btn" type="button" title="立即刷新数据">刷新</button>
      </div>
    </div>

    <div class="mode-switch" id="mode-switch" role="tablist" aria-label="视图模式">
      <button type="button" class="mode-btn" data-mode="overview" role="tab" aria-selected="false">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="1.8" y="1.8" width="5.2" height="5.2" rx="1.2"/><rect x="9" y="1.8" width="5.2" height="5.2" rx="1.2"/><rect x="1.8" y="9" width="5.2" height="5.2" rx="1.2"/><rect x="9" y="9" width="5.2" height="5.2" rx="1.2"/></svg>
        <span class="mode-label">概览</span><span class="mode-count" id="mode-count-overview">0</span>
      </button>
      <button type="button" class="mode-btn active" data-mode="tasks" role="tab" aria-selected="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h8" stroke-linecap="round"/></svg>
        <span class="mode-label">任务</span><span class="mode-count" id="mode-count-tasks">0</span>
      </button>
      <button type="button" class="mode-btn" data-mode="projects" role="tab" aria-selected="false">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1.8 4.2c0-.7.6-1.2 1.2-1.2h3l1.3 1.5h5.7c.7 0 1.2.6 1.2 1.2v5.9c0 .7-.6 1.2-1.2 1.2H3c-.7 0-1.2-.6-1.2-1.2V4.2z" stroke-linejoin="round"/></svg>
        <span class="mode-label">项目</span><span class="mode-count" id="mode-count-projects">0</span>
      </button>
    </div>

    <div class="explorer-controls" id="explorer-controls">
      <div class="search-box">
        <span class="search-icon" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="6.8" cy="6.8" r="4.4"/><path d="M10.2 10.2l3.2 3.2" stroke-linecap="round"/></svg></span>
        <input id="task-search" type="text" placeholder="搜索任务标题、ID、仓库、分支…" autocomplete="off" />
        <button id="search-clear" class="search-clear" type="button" title="清空搜索">✕</button>
      </div>
      <div class="repo-filter" id="repo-filter-row">
        <label for="repo-filter">项目</label>
        <select id="repo-filter" class="repo-select"></select>
      </div>
      <div class="filter-pills" id="status-filters">
        <button type="button" class="filter-pill active" data-cat="all" data-label="全部">全部</button>
        <button type="button" class="filter-pill" data-cat="stage" data-label="运行中">运行中</button>
        <button type="button" class="filter-pill" data-cat="gate" data-label="待介入">待介入</button>
        <button type="button" class="filter-pill" data-cat="done" data-label="已完成">已完成</button>
        <button type="button" class="filter-pill" data-cat="bad" data-label="异常">异常</button>
      </div>
    </div>

    <ul id="task-list"></ul>
    <ul id="project-list" hidden></ul>
  </aside>

  <main id="detail">
    <div class="empty">正在连接 Keel Fact Plane…</div>
  </main>

  <div class="statusbar" id="statusbar">
    <div class="statusbar-left">
      <span class="sb-item"><span class="health-dot" id="health-dot"></span><span id="sb-health">已连接</span></span>
      <span class="sb-sep"></span>
      <span class="sb-item sb-live run"><b id="sb-running">0</b> 运行中</span>
      <span class="sb-item sb-live wait"><b id="sb-waiting">0</b> 待介入</span>
      <span class="sb-item" id="sb-done">0 已完成</span>
    </div>
    <div class="statusbar-right">
      <label><input type="checkbox" id="auto" checked /> 自动刷新 5s</label>
      <span class="sb-sep"></span>
      <span class="sb-item" id="pulse"></span>
      <span class="sb-sep"></span>
      <span class="sb-item">只读</span>
    </div>
  </div>
</div>
<script>
(function () {
  var MAIN_PATH = [
    'S-NEW', 'S-PM_ANALYZING', 'S-BRAINSTORM', 'S-RFC_DRAFT', 'S-RFC_READY',
    'S-DEVELOPING', 'S-QA', 'S-REVIEW', 'S-PR_OPEN', 'S-DONE'
  ];

  var STAGE_ORDER = ['pm', 'brainstorm', 'critic', 'rfc_draft', 'develop', 'qa', 'review'];

  // 关口态没有 Run 在跑，补一句「在等什么」，让人不用反查状态机文档。
  var STATUS_HINTS = {
    'S-NEW': '已创建，等待调度派发',
    'S-NEED_CLARIFICATION': '等待补充需求澄清',
    'S-RFC_READY': 'RFC 已就绪，等待策略裁决或派发',
    'S-HUMAN_REVIEW': '等待人工复核',
    'S-PR_OPEN': 'PR 已创建，等待合并或关闭'
  };

  var GLOSSARY = [
    ['S-*', '任务级状态。阶段态有 Run 在跑；关口态无 Run，等人或等条件；终态无出边。'],
    ['T-*', '状态机转移规则编号，定义在 src/control/transition/table.ts，与 docs/04-state-machine.md 一致。'],
    ['Guard', '转移守卫条件，来自结构化的阶段评审结论；满足才会发生该转移。'],
    ['I8', '不变量 I8：终态一经写入，不可再变更。'],
    ['Run', '一次阶段执行，相当于一次 Agent 会话；会话销毁后，Run 记录仍留在 Fact Plane。'],
    ['Recipe / 预算水位', '每次 Run 的上下文配方，以及已用 / 上限的 token 预算。'],
    ['Harness · L2', '执行该 Run 的 harness 与其能力等级（L0–L2），能力不足时显式降级。'],
    ['产物 / 事件', 'Fact Plane 的 artifact 与 append-only event；页面上的数字都可由 readEvents 重建。'],
    ['control_mode', '谁在驾驶：auto / paused / human，与任务状态正交。']
  ];

  var state = {
    tasks: [],
    meta: null,
    // 默认落点：概览先回答「最近怎么样」，再往里点任务 / 项目
    mode: 'overview',
    selectedRepo: null,
    repoFilter: 'all',
    selectedId: null,
    detail: null,
    activeTab: 'overview',
    searchQuery: '',
    statusCat: 'all',
    eventCat: 'all',
    eventRunFilter: 'all',
    eventSearch: '',
    selectedDiffIdx: 0,
    expandedIds: {},
    glossaryOpen: false,
    tasksSig: '',
    detailSig: '',
    stats: null,
    statsSig: '',
    statsError: false,
    // 概览默认落在「昨天」：最常见的问题是「昨天跑了什么」
    overviewPeriod: 'yesterday',
    timer: null,
    theme: localStorage.getItem('keel-theme') || 'auto'
  };

  function applyTheme(t) {
    state.theme = t;
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('keel-theme', t);
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.removeItem('keel-theme');
    }
    var btn = document.getElementById('theme-btn');
    if (btn) {
      var label = t === 'dark' ? '暗色' : (t === 'light' ? '亮色' : '自动');
      btn.textContent = label;
    }
  }

  function cycleTheme() {
    var next = state.theme === 'auto' ? 'dark' : (state.theme === 'dark' ? 'light' : 'auto');
    applyTheme(next);
  }

  function parseHash() {
    var h = (window.location.hash || '').replace(/^#/, '');
    if (!h) return;
    var parts = h.split('&');
    var explicitMode = '';
    var hasTask = false;
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      var k = decodeURIComponent(kv[0] || '');
      var v = decodeURIComponent(kv[1] || '');
      if (k === 'task' && v) { state.selectedId = v; hasTask = true; }
      if (k === 'mode' && (v === 'tasks' || v === 'projects' || v === 'overview')) explicitMode = v;
      if (k === 'repo' && v) state.selectedRepo = v;
      if (k === 'tab' && (v === 'overview' || v === 'runs' || v === 'diff' || v === 'timeline')) {
        state.activeTab = v;
      }
    }
    // 只有 task 键的链接回落到任务模式，否则从项目模式点任务会两边都不对
    if (explicitMode) state.mode = explicitMode;
    else if (hasTask) state.mode = 'tasks';
  }

  function syncHash() {
    var nextHash;
    if (state.mode === 'overview') {
      nextHash = '#mode=overview';
    } else if (state.mode === 'projects') {
      nextHash = '#mode=projects' + (state.selectedRepo ? '&repo=' + encodeURIComponent(state.selectedRepo) : '');
    } else if (state.selectedId) {
      nextHash = '#task=' + encodeURIComponent(state.selectedId) + '&tab=' + encodeURIComponent(state.activeTab);
    } else {
      return;
    }
    if (window.location.hash !== nextHash) {
      try {
        window.history.replaceState(null, '', nextHash);
      } catch (_e) {}
    }
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  function fmtShortTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var hh = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    var ss = String(d.getSeconds()).padStart(2, '0');
    return mm + '-' + dd + ' ' + hh + ':' + mi + ':' + ss;
  }

  function fmtDurationMs(ms) {
    if (ms == null || isNaN(ms) || ms < 0) return '—';
    if (ms < 1000) return Math.round(ms) + 'ms';
    var sec = ms / 1000;
    if (sec < 60) return sec.toFixed(1) + 's';
    var m = Math.floor(sec / 60);
    var s = Math.round(sec % 60);
    if (m < 60) return m + 'm ' + s + 's';
    var h = Math.floor(m / 60);
    var remM = m % 60;
    // 停留时间会横跨数天，继续用小时会让「205h 12m」这种数字失去直觉
    var d = Math.floor(h / 24);
    if (d >= 2) return d + '天 ' + (h % 24) + 'h';
    return h + 'h ' + remM + 'm';
  }

  function calcDuration(startIso, endIso) {
    if (!startIso) return '—';
    var s = new Date(startIso).getTime();
    var e = endIso ? new Date(endIso).getTime() : Date.now();
    if (isNaN(s) || isNaN(e)) return '—';
    return fmtDurationMs(Math.max(0, e - s));
  }

  function fmtNum(n) {
    var num = Number(n);
    if (n == null || n === '' || isNaN(num)) return '0';
    return num.toLocaleString('en-US');
  }

  function fmtCost(usd) {
    var num = Number(usd);
    if (usd == null || usd === '' || isNaN(num) || num === 0) return '$0.00';
    if (num < 0.01) return '$' + num.toFixed(4);
    return '$' + num.toFixed(4);
  }

  function shortId(id) {
    return id ? String(id).slice(0, 8) : '—';
  }

  function shortRepo(url) {
    if (!url) return '—';
    var s = String(url).replace(/\\.git$/, '');
    var gh = s.match(/github\\.com[:/]([^/]+\\/[^/]+)$/i);
    if (gh && gh[1]) return gh[1];
    var fileM = s.match(/file:\\/\\/\\/.*\\/([^/]+)$/);
    if (fileM && fileM[1]) return 'local/' + fileM[1];
    return s.length > 32 ? '…' + s.slice(-30) : s;
  }

  function statusKind(status) {
    if (status === 'S-DONE') return 'done';
    if (status === 'S-FAILED' || status === 'S-REJECTED' || status === 'S-ABANDONED') return 'bad';
    if (!state.meta) {
      if (status === 'S-HUMAN_REVIEW' || status === 'S-NEED_CLARIFICATION' || status === 'S-NEW' || status === 'S-RFC_READY' || status === 'S-PR_OPEN') return 'gate';
      return 'stage';
    }
    if (state.meta.statuses.gate.indexOf(status) >= 0) return 'gate';
    if (state.meta.statuses.stage.indexOf(status) >= 0) return 'stage';
    return 'stage';
  }

  function statusLabel(status) {
    var m = state.meta && state.meta.statusLabels;
    return (m && m[status]) || '';
  }

  function eventLabel(ev) {
    var m = state.meta && state.meta.eventLabels;
    return (m && m[ev]) || ev;
  }

  function badge(status, compact) {
    var zh = statusLabel(status);
    var body = zh
      ? '<span class="badge-zh">' + esc(zh) + '</span>' + (compact ? '' : '<span class="badge-code">' + esc(status) + '</span>')
      : '<span class="badge-code">' + esc(status) + '</span>';
    return '<span class="badge ' + statusKind(status) + '" title="' + esc(status) + '">' +
      '<span class="dot"></span>' + body + '</span>';
  }

  function runStatusBadge(st) {
    var k = 'neutral';
    if (st === 'SUCCEEDED' || st === ' pass' || st === 'pass' || st === 'actionable' || st === 'implemented') k = 'done';
    else if (st === 'RUNNING' || st === 'PENDING') k = 'stage';
    else if (st === 'FAILED' || st === 'TIMEOUT' || st === 'fail' || st === 'reject' || st === 'blocked') k = 'bad';
    else if (st === 'CANCELLED' || st === 'unclear' || st === 'needs_more') k = 'gate';
    return '<span class="badge ' + k + '">' + esc(st) + '</span>';
  }

  function fetchJSON(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
      return r.json();
    });
  }

  function captureExpandedState() {
    var detailEl = document.getElementById('detail');
    if (!detailEl) return;
    var nodes = detailEl.querySelectorAll('details[data-expand-id]');
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute('data-expand-id');
      if (id) {
        if (nodes[i].open) state.expandedIds[id] = true;
        else delete state.expandedIds[id];
      }
    }
  }

  function restoreExpandedState(scrollTop) {
    var detailEl = document.getElementById('detail');
    if (!detailEl) return;
    var nodes = detailEl.querySelectorAll('details[data-expand-id]');
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute('data-expand-id');
      if (id && state.expandedIds[id]) {
        nodes[i].open = true;
      }
    }
    if (typeof scrollTop === 'number' && scrollTop > 0) {
      detailEl.scrollTop = scrollTop;
    }
  }

  function statusCounts(tasks) {
    var c = { all: tasks.length, stage: 0, gate: 0, done: 0, bad: 0 };
    for (var i = 0; i < tasks.length; i++) {
      var k = statusKind(tasks[i].status);
      if (c[k] != null) c[k]++;
    }
    return c;
  }

  /**
   * 筛选的计数口径：
   *   - 任务模式：跟随「项目」下拉；选中某个项目时只数该项目的任务；
   *   - 项目模式：只数当前项目的任务（状态 chip 筛的是项目内的任务表）。
   * 两种模式共用同一排 chip，计数必须和「点下去还能剩几条」一致，否则 chip 会撒谎。
   */
  function filterScopeTasks() {
    if (state.mode === 'projects') {
      var p = findProject(state.selectedRepo);
      return p ? p.tasks : [];
    }
    if (state.repoFilter === 'all') return state.tasks;
    var out = [];
    for (var i = 0; i < state.tasks.length; i++) {
      var t = state.tasks[i];
      if (String(t.repo || t.repo_id || 'unknown') === state.repoFilter) out.push(t);
    }
    return out;
  }

  /** 计数直接长在筛选 chip 上 —— 与原来那排 KPI 方块是同一件事，没必要占两行。 */
  function renderFilterCounts() {
    var counts = statusCounts(filterScopeTasks());
    var pills = document.querySelectorAll('#status-filters .filter-pill');
    for (var p = 0; p < pills.length; p++) {
      var cat = pills[p].getAttribute('data-cat') || 'all';
      var label = pills[p].getAttribute('data-label') || '';
      pills[p].classList.toggle('active', cat === state.statusCat);
      pills[p].innerHTML = esc(label) + '<span class="pill-n">' + (counts[cat] || 0) + '</span>';
    }
    var mt = document.getElementById('mode-count-tasks');
    if (mt) mt.textContent = String(state.tasks.length);
    var mp = document.getElementById('mode-count-projects');
    if (mp) mp.textContent = String(groupByRepo(state.tasks).length);
  }

  /**
   * 项目下拉：仓库可能很多，用 select 而不是再排一排 chip。
   * 选项只在项目集合或计数变化时重建 —— 5s 轮询不应该把用户正在操作的下拉框重置掉。
   */
  function renderRepoFilter() {
    var sel = document.getElementById('repo-filter');
    if (!sel) return;
    var projects = groupByRepo(state.tasks);
    var sig = 'all:' + state.tasks.length;
    for (var i = 0; i < projects.length; i++) sig += '|' + projects[i].id + ':' + projects[i].counts.all;
    if (state.repoFilter !== 'all') {
      var known = false;
      for (var j = 0; j < projects.length; j++) {
        if (projects[j].id === state.repoFilter) { known = true; break; }
      }
      if (!known) state.repoFilter = 'all';
    }
    if (sel.getAttribute('data-sig') !== sig) {
      var html = '<option value="all">全部项目（' + state.tasks.length + '）</option>';
      for (var k = 0; k < projects.length; k++) {
        html += '<option value="' + esc(projects[k].id) + '">' +
          esc(shortRepo(projects[k].repo)) + '（' + projects[k].counts.all + '）</option>';
      }
      sel.innerHTML = html;
      sel.setAttribute('data-sig', sig);
    }
    sel.value = state.repoFilter;
    sel.classList.toggle('active', state.repoFilter !== 'all');
    sel.title = state.repoFilter === 'all' ? '' : state.repoFilter;
  }

  function getFilteredTasks() {
    var q = state.searchQuery.trim().toLowerCase();
    var out = [];
    for (var i = 0; i < state.tasks.length; i++) {
      var t = state.tasks[i];
      if (state.repoFilter !== 'all' &&
          String(t.repo || t.repo_id || 'unknown') !== state.repoFilter) continue;
      if (state.statusCat !== 'all' && statusKind(t.status) !== state.statusCat) continue;
      if (q) {
        var hay = ((t.title || '') + ' ' + (t.id || '') + ' ' + (t.status || '') + ' ' + (t.repo || '') + ' ' + (t.work_branch || '')).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      out.push(t);
    }
    return out;
  }

  function renderTasks() {
    renderRepoFilter();
    renderFilterCounts();
    var clearBtn = document.getElementById('search-clear');
    if (clearBtn) clearBtn.style.display = state.searchQuery ? 'block' : 'none';

    var filtered = state.mode === 'overview' ? state.tasks : getFilteredTasks();
    var list = document.getElementById('task-list');
    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var t = filtered[i];
      var isAct = t.id === state.selectedId;
      var runCount = t.run_count != null ? Number(t.run_count) : null;
      var costNum = t.total_cost_usd != null ? Number(t.total_cost_usd) : 0;
      var cat = statusKind(t.status);
      var zh = statusLabel(t.status) || t.status;
      html += '<li data-id="' + esc(t.id) + '" class="task-item' + (isAct ? ' active' : '') + '">' +
        '<span class="task-dot ' + cat + '" title="' + esc(t.status) + '"></span>' +
        '<div class="task-body">' +
          '<div class="task-title-row">' +
            '<span class="task-title" title="' + esc(t.title) + '">' + esc(t.title) + '</span>' +
            '<span class="task-id">' + esc(shortId(t.id)) + '</span>' +
          '</div>' +
          '<div class="task-sub">' +
            '<span class="task-status ' + cat + '">' + esc(zh) + '</span>' +
            (t.control_mode && t.control_mode !== 'auto'
              ? '<span class="task-mode">' + (t.control_mode === 'paused' ? '已暂停' : '人工') + '</span>' : '') +
            '<span class="task-repo" title="' + esc(t.repo) + '">' + esc(shortRepo(t.repo)) + '</span>' +
            '<span class="task-time">' +
              (runCount ? runCount + ' 轮 · ' : '') +
              (costNum > 0 ? fmtCost(costNum) + ' · ' : '') +
              esc(fmtShortTime(t.updated_at)) +
            '</span>' +
          '</div>' +
        '</div>' +
      '</li>';
    }
    list.innerHTML = html || '<li class="empty" style="padding:24px 12px">没有匹配的任务</li>';
    var scopeTotal = filterScopeTasks().length;
    document.getElementById('count').textContent =
      (filtered.length === scopeTotal ? scopeTotal + ' 个任务' : filtered.length + ' / ' + scopeTotal + ' 个任务');
  }

  /**
   * 项目 = 仓库地址。repo 行本身没有唯一约束（同一 remote_url 可能有多行），
   * 所以按可读的仓库地址归组，而不是按 repo_id —— 否则侧栏会出现两个同名项目。
   */
  function groupByRepo(tasks) {
    var order = [];
    var map = {};
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var key = String(t.repo || t.repo_id || 'unknown');
      var g = map[key];
      if (!g) {
        g = map[key] = {
          id: key,
          repo: t.repo || '',
          provider: t.repo_provider || '',
          tasks: [],
          counts: { all: 0, stage: 0, gate: 0, done: 0, bad: 0 },
          runs: 0,
          cost: 0,
          budget: 0,
          lastUpdated: ''
        };
        order.push(g);
      }
      g.tasks.push(t);
      g.counts.all++;
      var k = statusKind(t.status);
      if (g.counts[k] != null) g.counts[k]++;
      g.runs += Number(t.run_count || 0);
      g.cost += Number(t.total_cost_usd || 0);
      g.budget += Number(t.budget_usd || 0);
      if (!g.lastUpdated || String(t.updated_at || '') > g.lastUpdated) g.lastUpdated = t.updated_at || '';
      if (!g.repo && t.repo) g.repo = t.repo;
    }
    order.sort(function (a, b) {
      return String(b.lastUpdated).localeCompare(String(a.lastUpdated));
    });
    for (var j = 0; j < order.length; j++) {
      order[j].tasks.sort(function (a, b) {
        return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
      });
    }
    return order;
  }

  function getFilteredProjects(projects) {
    var q = state.searchQuery.trim().toLowerCase();
    if (!q) return projects;
    var out = [];
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      var hay = (p.repo + ' ' + shortRepo(p.repo) + ' ' + p.provider).toLowerCase();
      if (hay.indexOf(q) >= 0) out.push(p);
    }
    return out;
  }

  function findProject(id) {
    var projects = groupByRepo(state.tasks);
    for (var i = 0; i < projects.length; i++) {
      if (projects[i].id === id) return projects[i];
    }
    return projects.length > 0 ? projects[0] : null;
  }

  function renderProjects() {
    var all = groupByRepo(state.tasks);
    var projects = getFilteredProjects(all);
    var selectedVisible = false;
    for (var v = 0; v < projects.length; v++) {
      if (projects[v].id === state.selectedRepo) { selectedVisible = true; break; }
    }
    if (!selectedVisible) state.selectedRepo = projects.length > 0 ? projects[0].id : null;
    // 计数要在选中项落定之后再算：项目模式下的状态 chip 数的是当前项目的任务
    renderFilterCounts();
    var list = document.getElementById('project-list');
    var html = '';
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      var chips = '';
      if (p.counts.stage > 0) chips += '<span class="proj-count stage">运行 ' + p.counts.stage + '</span>';
      if (p.counts.gate > 0) chips += '<span class="proj-count gate">待介入 ' + p.counts.gate + '</span>';
      if (p.counts.done > 0) chips += '<span class="proj-count done">完成 ' + p.counts.done + '</span>';
      if (p.counts.bad > 0) chips += '<span class="proj-count bad">异常 ' + p.counts.bad + '</span>';
      html += '<li class="proj-item' + (p.id === state.selectedRepo ? ' active' : '') + '" data-repo-id="' + esc(p.id) + '">' +
        '<div class="proj-item-name">' +
          '<span>' + esc(shortRepo(p.repo)) + '</span>' +
          (p.provider ? '<span class="mode-pill">' + esc(p.provider) + '</span>' : '') +
        '</div>' +
        '<div class="proj-item-url" title="' + esc(p.repo) + '">' + esc(p.repo) + '</div>' +
        '<div class="proj-item-counts">' + chips + '</div>' +
        '<div class="proj-item-foot">' +
          '<span>' + p.counts.all + ' 个任务 · ' + p.runs + ' 轮</span>' +
          '<span>' + (p.cost > 0 ? fmtCost(p.cost) + ' · ' : '') + esc(fmtShortTime(p.lastUpdated)) + '</span>' +
        '</div>' +
      '</li>';
    }
    list.innerHTML = html || '<li class="empty" style="padding:24px 12px">没有匹配的项目</li>';
    var clearBtn = document.getElementById('search-clear');
    if (clearBtn) clearBtn.style.display = state.searchQuery ? 'block' : 'none';
    document.getElementById('count').textContent =
      (projects.length === all.length ? all.length + ' 个项目' : projects.length + ' / ' + all.length + ' 个项目');
    if (state.mode === 'projects') renderProjectView();
  }

  function renderProjectView() {
    var detailEl = document.getElementById('detail');
    var p = findProject(state.selectedRepo);
    if (!p) {
      detailEl.innerHTML = '<div class="empty">还没有任何项目 —— 任务创建后会按仓库归组。</div>';
      return;
    }
    state.selectedRepo = p.id;
    var c = p.counts;
    var pct = function (n) { return c.all > 0 ? Math.round((n / c.all) * 100) : 0; };
    var dist = '';
    var legend = '';
    var kinds = [['stage', '运行中'], ['gate', '待介入'], ['done', '已完成'], ['bad', '异常终态']];
    for (var i = 0; i < kinds.length; i++) {
      var kk = kinds[i][0];
      if (c[kk] > 0) {
        dist += '<i class="' + kk + '" style="width:' + pct(c[kk]) + '%"></i>';
        legend += '<span class="lg"><span class="sw" style="background:var(--' + kk + ')"></span>' +
          kinds[i][1] + ' <b class="mono">' + c[kk] + '</b></span>';
      }
    }

    var visible = [];
    for (var vi = 0; vi < p.tasks.length; vi++) {
      if (state.statusCat !== 'all' && statusKind(p.tasks[vi].status) !== state.statusCat) continue;
      visible.push(p.tasks[vi]);
    }
    var tableHint = state.statusCat === 'all'
      ? '点击行进入任务模式'
      : '显示 ' + visible.length + ' / ' + p.tasks.length + ' 个任务 · 状态筛选生效中';
    var html = '<div class="view">' +
      '<div class="view-head">' +
        '<div class="cockpit-top-row">' +
          '<div class="cockpit-badges">' +
            '<span class="badge stage"><span class="dot"></span>项目</span>' +
            (p.provider ? '<span class="mode-pill">' + esc(p.provider) + '</span>' : '') +
            '<span class="mode-pill">' + c.all + ' 个任务</span>' +
          '</div>' +
        '</div>' +
        '<h2 class="cockpit-title">' + esc(shortRepo(p.repo)) + '</h2>' +
        '<div class="proj-url">' + esc(p.repo || '—') + '</div>' +
      '</div>' +
      '<div class="view-body">' +
        '<div class="proj-stats">' +
          '<div class="proj-stat"><div class="proj-stat-lbl">任务</div><div class="proj-stat-val">' + c.all + '</div>' +
            '<div class="proj-stat-sub">' + (c.stage + c.gate) + ' 个未完成</div></div>' +
          '<div class="proj-stat stage"><div class="proj-stat-lbl">运行中</div><div class="proj-stat-val">' + c.stage + '</div>' +
            '<div class="proj-stat-sub">阶段态有 Run 在跑</div></div>' +
          '<div class="proj-stat gate"><div class="proj-stat-lbl">待介入</div><div class="proj-stat-val">' + c.gate + '</div>' +
            '<div class="proj-stat-sub">等人或等条件</div></div>' +
          '<div class="proj-stat done"><div class="proj-stat-lbl">已完成</div><div class="proj-stat-val">' + c.done + '</div>' +
            '<div class="proj-stat-sub">终态不可再变更（I8）</div></div>' +
          (c.bad > 0 ? '<div class="proj-stat bad"><div class="proj-stat-lbl">异常终态</div><div class="proj-stat-val">' + c.bad + '</div>' +
            '<div class="proj-stat-sub">失败 / 驳回 / 放弃</div></div>' : '') +
          '<div class="proj-stat"><div class="proj-stat-lbl">Run 轮次</div><div class="proj-stat-val">' + p.runs + '</div>' +
            '<div class="proj-stat-sub">跨 ' + c.all + ' 个任务</div></div>' +
          '<div class="proj-stat"><div class="proj-stat-lbl">累计成本</div><div class="proj-stat-val">' + fmtCost(p.cost) + '</div>' +
            '<div class="proj-stat-sub">' + (p.budget > 0 ? '预算 ' + fmtCost(p.budget) : '未设预算') + '</div>' +
            (p.budget > 0 ? '<div class="proj-budget-bar' + (p.cost > p.budget ? ' over' : '') + '">' +
              '<i style="width:' + Math.min(100, Math.round((p.cost / p.budget) * 100)) + '%"></i></div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-header"><h3>状态分布</h3><span class="muted">按任务当前状态</span></div>' +
          '<div class="proj-dist">' + dist + '</div>' +
          '<div class="proj-dist-legend">' + legend + '</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-header"><h3>项目任务</h3><span class="muted">' + esc(tableHint) + '</span></div>' +
          '<div class="proj-table-wrap"><table class="proj-table"><thead><tr>' +
            '<th>状态</th><th>标题</th><th>分支</th><th>轮次</th><th>成本</th><th>更新</th>' +
          '</tr></thead><tbody>';
    for (var j = 0; j < visible.length; j++) {
      var t = visible[j];
      html += '<tr data-task-id="' + esc(t.id) + '">' +
        '<td>' + badge(t.status, true) + '</td>' +
        '<td><div class="ct-title" title="' + esc(t.title) + '">' + esc(t.title) + '</div></td>' +
        '<td class="ct-num">' + esc(t.work_branch || '—') + '</td>' +
        '<td class="ct-num">' + Number(t.run_count || 0) + '</td>' +
        '<td class="ct-num">' + (Number(t.total_cost_usd || 0) > 0 ? fmtCost(Number(t.total_cost_usd)) : '—') + '</td>' +
        '<td class="ct-num">' + esc(fmtShortTime(t.updated_at)) + '</td>' +
      '</tr>';
    }
    if (visible.length === 0) {
      html += '<tr class="proj-empty"><td colspan="6">' +
        (p.tasks.length === 0 ? '这个项目还没有任务' : '当前状态筛选下没有任务') + '</td></tr>';
    }
    html += '</tbody></table></div></div>' +
      '</div></div>';
    detailEl.innerHTML = html;
    syncHash();
  }

  /** 两种模式共用同一个侧栏骨架：只切换可见容器与按钮态。 */
  function applyModeChrome() {
    var mode = state.mode;
    var buttons = document.querySelectorAll('#mode-switch .mode-btn');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-mode') === mode;
      buttons[i].classList.toggle('active', on);
      buttons[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var isProjects = mode === 'projects';
    var isOverview = mode === 'overview';
    document.getElementById('task-list').hidden = isProjects;
    document.getElementById('project-list').hidden = !isProjects;
    // 概览看的是全量，搜索/筛选在这里没有作用对象，整块收起来
    var controls = document.getElementById('explorer-controls');
    if (controls) controls.hidden = isOverview;
    // 项目下拉只属于任务模式；状态 chip 在项目模式下筛的是项目内的任务表
    var row = document.getElementById('repo-filter-row');
    if (row) row.hidden = isProjects || isOverview;
    var filters = document.getElementById('status-filters');
    if (filters) filters.hidden = isOverview;
    var search = document.getElementById('task-search');
    if (search) {
      search.placeholder = isProjects ? '搜索项目名或仓库地址…' : '搜索任务标题、ID、仓库、分支…';
      search.value = state.searchQuery;
    }
  }

  // ─── 概览：统计口径与渲染 ───

  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /** '2026-11-02' → '11 月 2 日 周一' */
  function fmtDayCN(date) {
    if (!date) return '—';
    var d = new Date(date + 'T00:00:00');
    if (isNaN(d.getTime())) return String(date);
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + WEEKDAYS[d.getDay()];
  }

  /** '2026-11-02' → '11/02'，活动条下的短标签 */
  function fmtDayShort(date) {
    var parts = String(date || '').split('-');
    return parts.length === 3 ? parts[1] + '/' + parts[2] : String(date || '');
  }

  function statsDays() {
    return (state.stats && state.stats.days) || [];
  }

  function sumDays(days) {
    var s = { runs: 0, runs_ok: 0, runs_failed: 0, tasks_done: 0, tasks_failed: 0, issues_solved: 0, cost: 0 };
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      s.runs += Number(d.runs || 0);
      s.runs_ok += Number(d.runs_ok || 0);
      s.runs_failed += Number(d.runs_failed || 0);
      s.tasks_done += Number(d.tasks_done || 0);
      s.tasks_failed += Number(d.tasks_failed || 0);
      s.issues_solved += Number(d.issues_solved || 0);
      s.cost += Number(d.cost_usd || 0);
    }
    return s;
  }

  /** 当前口径对应的天：today / yesterday / 7d / 14d / date:YYYY-MM-DD */
  function overviewPeriodDays() {
    var days = statsDays();
    var p = state.overviewPeriod;
    if (p === 'today') return days.slice(-1);
    if (p === '7d') return days.slice(-7);
    if (p === '14d') return days;
    if (p.indexOf('date:') === 0) {
      var want = p.slice(5);
      var out = [];
      for (var i = 0; i < days.length; i++) if (days[i].date === want) out.push(days[i]);
      return out;
    }
    return days.length >= 2 ? days.slice(-2, -1) : [];
  }

  function overviewPeriodName() {
    var p = state.overviewPeriod;
    if (p === 'today') return '今天';
    if (p === '7d') return '近 7 天';
    if (p === '14d') return '近 14 天';
    if (p.indexOf('date:') === 0) return fmtDayCN(p.slice(5));
    return '昨天';
  }

  /** 摘要开头带日期：昨天 11 月 2 日周一，…；区间则给起止 */
  function overviewPeriodLong() {
    var days = overviewPeriodDays();
    var name = overviewPeriodName();
    var p = state.overviewPeriod;
    if (p === 'today' || p === 'yesterday') {
      return days.length > 0 ? name + ' ' + fmtDayCN(days[0].date) : name;
    }
    if (p === '7d' || p === '14d') {
      if (days.length === 0) return name;
      return name + '（' + fmtDayCN(days[0].date) + ' 至 ' + fmtDayCN(days[days.length - 1].date) + '）';
    }
    return name;
  }

  function statBox(label, value, sub) {
    return '<div class="stat-box"><div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">' + value + '</div>' +
      '<div class="stat-sub">' + esc(sub) + '</div></div>';
  }

  function renderDigest(s) {
    var pieces = [];
    if (s.runs > 0) {
      var t = '跑了 <b>' + s.runs + '</b> 次';
      if (s.runs_failed > 0) {
        t += '（<b>' + s.runs_ok + '</b> 成功，<b class="bad">' + s.runs_failed + '</b> 失败）';
      } else {
        t += '，全部成功';
      }
      pieces.push(t);
    }
    if (s.tasks_done > 0) pieces.push('完成 <b class="done">' + s.tasks_done + '</b> 个任务');
    if (s.tasks_failed > 0) pieces.push('<b class="bad">' + s.tasks_failed + '</b> 个任务失败');
    if (s.issues_solved > 0) pieces.push('<b>' + s.issues_solved + '</b> 个问题闭环');
    var body = pieces.length > 0 ? pieces.join('，') + '。' : '没有运行记录，也没有任务完成。';
    // 空白的一天最需要一句指向：最近一次运行在哪天
    if (pieces.length === 0) {
      var all = statsDays();
      for (var i = all.length - 1; i >= 0; i--) {
        if (Number(all[i].runs || 0) > 0) {
          body += '最近一次运行在 ' + fmtDayCN(all[i].date) + '。';
          break;
        }
      }
    }
    return '<span class="ov-when">' + esc(overviewPeriodLong()) + '</span>，' + body;
  }

  function renderOverviewMetrics(s) {
    var html = '<div class="summary-grid">' +
      statBox('运行次数', String(s.runs), s.runs > 0 ? s.runs_ok + ' 成功 · ' + s.runs_failed + ' 失败' : '这段时间没有 Run') +
      statBox('完成任务', String(s.tasks_done), s.tasks_failed > 0 ? s.tasks_failed + ' 个失败 / 驳回 / 放弃' : '全部走到 S-DONE') +
      statBox('问题闭环', String(s.issues_solved), '完成任务的关联 feedback 去重数') +
      statBox('成本', fmtCost(s.cost), s.runs > 0 ? '平均每次 ' + fmtCost(s.cost / s.runs) : '—') +
    '</div>';
    var totals = (state.stats && state.stats.totals) || null;
    if (totals) {
      html += '<p class="ov-cum">累计 ' + (totals.tasks || 0) + ' 个任务，其中 ' + (totals.tasks_done || 0) +
        ' 个已完成；共 ' + (totals.runs || 0) + ' 次运行，花费 ' + fmtCost(totals.cost_usd) + '。</p>';
    }
    return html;
  }

  function isPeriodDay(date, idx, total) {
    var p = state.overviewPeriod;
    if (p === 'today') return idx === total - 1;
    if (p === 'yesterday') return idx === total - 2;
    if (p === '7d') return idx >= total - 7;
    if (p === '14d') return true;
    if (p.indexOf('date:') === 0) return p.slice(5) === date;
    return false;
  }

  function renderOverviewStrip() {
    var days = statsDays();
    if (days.length === 0) return '';
    var max = 1;
    for (var m = 0; m < days.length; m++) max = Math.max(max, Number(days[m].runs || 0));
    var html = '<div class="card">' +
      '<div class="card-header"><h3>近 14 天运行</h3>' +
        '<div class="ov-strip-legend">' +
          '<span><i style="background:var(--stage)"></i>成功</span>' +
          '<span><i style="background:var(--bad)"></i>失败</span>' +
        '</div>' +
      '</div>' +
      '<div class="ov-strip">';
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      var runs = Number(d.runs || 0);
      var ok = Number(d.runs_ok || 0);
      var bad = Number(d.runs_failed || 0);
      var inRange = isPeriodDay(d.date, i, days.length);
      var single = state.overviewPeriod === 'today' || state.overviewPeriod === 'yesterday' || state.overviewPeriod.indexOf('date:') === 0;
      var title = fmtDayCN(d.date) + '：' + runs + ' 次运行（' + ok + ' 成功，' + bad + ' 失败），完成 ' +
        Number(d.tasks_done || 0) + ' 个任务，' + Number(d.issues_solved || 0) + ' 个问题闭环';
      html += '<button type="button" class="ov-day' + (single && inRange ? ' active' : '') + (inRange ? ' in-range' : '') +
          '" data-date="' + esc(d.date) + '" title="' + esc(title) + '">' +
        '<span class="ov-col">' +
          (bad > 0 ? '<i class="bad" style="height:' + Math.max(3, Math.round((bad / max) * 100)) + '%"></i>' : '') +
          (ok > 0 ? '<i class="ok" style="height:' + Math.max(3, Math.round((ok / max) * 100)) + '%"></i>' : '') +
          (runs === 0 ? '<i class="zero"></i>' : '') +
        '</span>' +
        '<span class="ov-day-label">' + esc(fmtDayShort(d.date)) + '</span>' +
      '</button>';
    }
    html += '</div></div>';
    return html;
  }

  /** 主路径站位：10 段阶梯，走到哪一段一眼可见 */
  function stageIndex(status) {
    var i = MAIN_PATH.indexOf(status);
    if (i >= 0) return i;
    if (status === 'S-NEED_CLARIFICATION') return 1;
    if (status === 'S-HUMAN_REVIEW') return 8;
    if (status === 'S-DONE') return MAIN_PATH.length - 1;
    return 0;
  }

  function ladderHtml(status) {
    var idx = stageIndex(status);
    var kind = statusKind(status);
    var html = '<ol class="ladder ' + kind + '" title="主路径第 ' + (idx + 1) + ' / ' + MAIN_PATH.length + ' 段">';
    for (var i = 0; i < MAIN_PATH.length; i++) {
      var cls = '';
      if (kind === 'done') cls = 'done';
      else if (i < idx) cls = 'done';
      else if (i === idx) cls = 'cur';
      html += '<li class="' + cls + '"></li>';
    }
    return html + '</ol>';
  }

  function renderInFlight() {
    var rows = [];
    for (var i = 0; i < state.tasks.length; i++) {
      var k = statusKind(state.tasks[i].status);
      if (k === 'stage' || k === 'gate') rows.push(state.tasks[i]);
    }
    var html = '<div class="card">' +
      '<div class="card-header"><h3>进行中</h3><span class="muted">' +
        (rows.length > 0 ? rows.length + ' 个任务未到终态' : '全部任务都已到终态') + '</span></div>';
    if (rows.length === 0) {
      html += '<p class="muted" style="margin:4px 0 8px">当前没有进行中的任务。</p>';
    } else {
      html += '<ul class="ov-tasks">';
      for (var j = 0; j < rows.length; j++) {
        var t = rows[j];
        var cat = statusKind(t.status);
        html += '<li class="ov-task" data-task-id="' + esc(t.id) + '">' +
          '<div class="ov-task-main">' +
            '<span class="ov-task-title" title="' + esc(t.title) + '">' + esc(t.title) + '</span>' +
            '<span class="ov-task-meta">' +
              '<span class="task-status ' + cat + '">' + esc(statusLabel(t.status) || t.status) + '</span>' +
              '<span class="task-repo" title="' + esc(t.repo) + '">' + esc(shortRepo(t.repo)) + '</span>' +
              '<span class="ov-when">' +
                (t.control_mode === 'paused' ? '已暂停，' : '') +
                '更新 ' + esc(fmtShortTime(t.updated_at)) +
              '</span>' +
            '</span>' +
          '</div>' +
          ladderHtml(t.status) +
        '</li>';
      }
      html += '</ul>';
    }
    return html + '</div>';
  }

  function renderOverviewProjects() {
    var projects = groupByRepo(state.tasks);
    var html = '<div class="card">' +
      '<div class="card-header"><h3>项目</h3><span class="muted">' +
        (projects.length > 0 ? projects.length + ' 个项目，点击进入项目视图' : '还没有项目') + '</span></div>';
    if (projects.length === 0) return html + '</div>';
    html += '<ul class="ov-projects">';
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      html += '<li class="ov-proj" data-repo-id="' + esc(p.id) + '">' +
        '<span class="ov-proj-name" title="' + esc(p.repo) + '">' + esc(shortRepo(p.repo)) + '</span>' +
        '<span class="ov-proj-counts">' +
          (p.counts.stage > 0 ? '<span class="proj-count stage">运行 ' + p.counts.stage + '</span>' : '') +
          (p.counts.gate > 0 ? '<span class="proj-count gate">待介入 ' + p.counts.gate + '</span>' : '') +
          '<span class="proj-count done">完成 ' + p.counts.done + '</span>' +
          (p.counts.bad > 0 ? '<span class="proj-count bad">异常 ' + p.counts.bad + '</span>' : '') +
        '</span>' +
        '<span class="ov-proj-foot">' + p.counts.all + ' 个任务，' + p.runs + ' 轮，' +
          (p.cost > 0 ? fmtCost(p.cost) + '，' : '') + '最近更新 ' + esc(fmtShortTime(p.lastUpdated)) + '</span>' +
      '</li>';
    }
    html += '</ul></div>';
    return html;
  }

  function renderOverview() {
    var detailEl = document.getElementById('detail');
    if (!state.stats) {
      var pending = state.statsError
        ? '<div class="empty">统计不可用：数据库连接失败，任务列表与详情不受影响。</div>'
        : '<div class="ov-skeleton"></div><div class="ov-skeleton"></div>';
      detailEl.innerHTML = '<div class="view"><div class="view-head"><h2 class="cockpit-title" style="margin:0">概览</h2></div>' +
        '<div class="view-body">' + pending + '</div></div>';
      return;
    }
    var s = sumDays(overviewPeriodDays());
    var periods = [['today', '今天'], ['yesterday', '昨天'], ['7d', '近 7 天'], ['14d', '近 14 天']];
    var periodHtml = '<div class="ov-periods" id="ov-periods">';
    for (var i = 0; i < periods.length; i++) {
      periodHtml += '<button type="button" class="ov-period' +
        (state.overviewPeriod === periods[i][0] ? ' active' : '') +
        '" data-period="' + periods[i][0] + '">' + periods[i][1] + '</button>';
    }
    periodHtml += '</div>';

    var html = '<div class="view">' +
      '<div class="view-head">' +
        '<div class="ov-head-row">' +
          '<h2 class="cockpit-title" style="margin:0">概览</h2>' +
          periodHtml +
        '</div>' +
      '</div>' +
      '<div class="view-body">' +
        '<p class="ov-digest">' + renderDigest(s) + '</p>' +
        renderOverviewMetrics(s) +
        renderOverviewStrip() +
        renderInFlight() +
        renderOverviewProjects() +
      '</div></div>';
    detailEl.innerHTML = html;
    syncHash();
  }

  /** 底部状态栏：运行中 / 待介入 / 已完成，来自任务列表，和侧栏同一口径 */
  function updateStatusbar() {
    var c = statusCounts(state.tasks);
    var runEl = document.getElementById('sb-running');
    if (runEl) runEl.textContent = String(c.stage);
    var waitEl = document.getElementById('sb-waiting');
    if (waitEl) waitEl.textContent = String(c.gate);
    var doneEl = document.getElementById('sb-done');
    if (doneEl) doneEl.textContent = c.done + ' 已完成';
    var ovEl = document.getElementById('mode-count-overview');
    if (ovEl) ovEl.textContent = String(c.stage + c.gate);
    var health = document.getElementById('sb-health');
    var dot = document.getElementById('health-dot');
    if (health && dot && !dot.classList.contains('err')) health.textContent = '已连接';
    if (health && dot && dot.classList.contains('err')) health.textContent = '连接异常';
  }

  function loadStats(silent) {
    return fetchJSON('/api/stats').then(function (data) {
      var days = data.days || [];
      var parts = [];
      for (var i = 0; i < days.length; i++) {
        var d = days[i];
        parts.push([d.date, d.runs, d.runs_ok, d.runs_failed, d.tasks_done, d.tasks_failed, d.issues_solved, d.cost_usd].join(':'));
      }
      var t = data.totals || {};
      var sig = parts.join('|') + '#' + t.tasks + ':' + t.tasks_done + ':' + t.runs + ':' + t.cost_usd;
      var changed = sig !== state.statsSig;
      state.stats = data;
      state.statsSig = sig;
      state.statsError = false;
      return changed;
    }).catch(function () {
      // 统计失败不拖垮控制台：任务与详情仍可用，概览给一句可诊断的说明
      state.statsError = true;
      return false;
    });
  }

  function setMode(mode) {
    state.mode = mode;
    applyModeChrome();
    if (mode === 'projects') {
      if (state.selectedRepo == null) {
        var projects = groupByRepo(state.tasks);
        if (projects.length > 0) state.selectedRepo = projects[0].id;
      }
      renderProjects();
    } else if (mode === 'overview') {
      // 侧栏仍列全部任务：概览负责「现在怎么样」，点任务直接进任务模式看细节
      renderTasks();
      renderOverview();
      loadStats(false).then(function () {
        if (state.mode === 'overview') renderOverview();
      });
    } else {
      renderTasks();
      if (state.selectedId) {
        document.getElementById('detail').innerHTML = '<div class="empty">正在加载任务事实数据…</div>';
        loadDetail(state.selectedId, false);
      } else if (state.tasks.length > 0) {
        select(state.tasks[0].id);
      }
    }
    syncHash();
  }

  function analyzeTrajectory(task, events) {
    var visited = {};
    var transitionsByTo = {};
    var durationByState = {};
    var statusEvents = [];
    var evs = events || [];
    for (var i = 0; i < evs.length; i++) {
      if (evs[i].type === 'TaskStatusChanged' && evs[i].payload) {
        statusEvents.push(evs[i]);
      }
    }

    var hasStatusEvents = statusEvents.length > 0;
    var lastStatusEvent = null;
    for (var j = 0; j < statusEvents.length; j++) {
      var sev = statusEvents[j];
      var p = sev.payload || {};
      if (p.from) visited[p.from] = true;
      if (p.to) {
        visited[p.to] = true;
        transitionsByTo[p.to] = p.transition || '';
      }
      if (j > 0 && p.from) {
        var prevTime = new Date(statusEvents[j - 1].occurred_at).getTime();
        var curTime = new Date(sev.occurred_at).getTime();
        if (!isNaN(prevTime) && !isNaN(curTime) && curTime >= prevTime) {
          durationByState[p.from] = (durationByState[p.from] || 0) + (curTime - prevTime);
        }
      }
      lastStatusEvent = sev;
    }

    var currentSince = null;
    if (task && task.status) {
      visited[task.status] = true;
      // 当前状态的进入时刻：用于在轨道上显示「已停留多久」。
      for (var q = statusEvents.length - 1; q >= 0; q--) {
        var pq = statusEvents[q].payload || {};
        if (pq.to === task.status) {
          currentSince = statusEvents[q].occurred_at;
          break;
        }
      }
    }

    // Fallback when no TaskStatusChanged events exist (e.g. unit test mocks)
    if (!hasStatusEvents && task && task.status) {
      var curMainIdx = MAIN_PATH.indexOf(task.status);
      if (curMainIdx >= 0) {
        for (var m = 0; m <= curMainIdx; m++) visited[MAIN_PATH[m]] = true;
      }
    }

    // Find highest index in MAIN_PATH that was visited
    var maxVisitedMainIdx = -1;
    for (var k = 0; k < MAIN_PATH.length; k++) {
      if (visited[MAIN_PATH[k]]) maxVisitedMainIdx = k;
    }

    return {
      visited: visited,
      transitionsByTo: transitionsByTo,
      durationByState: durationByState,
      maxVisitedMainIdx: maxVisitedMainIdx,
      lastStatusEvent: lastStatusEvent,
      currentSince: currentSince
    };
  }

  function findGateOrFailureReason(d, lastSev) {
    var runs = d.runs || [];
    if (lastSev && (lastSev.event === 'RunTimeout' || lastSev.event === 'RunFailed')) {
      for (var r0 = runs.length - 1; r0 >= 0; r0--) {
        if (runs[r0].status === 'FAILED' || runs[r0].status === 'TIMEOUT' || runs[r0].error_kind) {
          var rk = runs[r0];
          return '执行异常升级人工 (T-031)：Run ' + rk.stage + ' #' + rk.attempt + ' 状态为 ' + rk.status +
            (rk.error_kind ? ' (' + rk.error_kind + ')' : '') +
            (rk.error_detail ? ' — ' + rk.error_detail : '');
        }
      }
      return '阶段执行超时或失败达最大重试上限 (' + lastSev.event + ')，触发 T-031 转入人工复核。';
    }
    var evs = d.events || [];
    for (var i = evs.length - 1; i >= 0; i--) {
      var ev = evs[i];
      var p = ev.payload || {};
      if (ev.type === 'PolicyEvaluated' && p.decision && p.decision !== 'auto_develop') {
        return '策略门禁拦截 (' + p.point + ' → ' + p.decision + ')' + (p.reason ? '：' + p.reason : '');
      }
      if (ev.type === 'UnrecoverableError' || ev.type === 'BudgetExceeded') {
        return ev.type + '：' + JSON.stringify(p);
      }
    }
    var arts = d.artifacts || [];
    for (var a = 0; a < arts.length; a++) {
      if (arts[a].kind === 'policy_decision' && arts[a].body && arts[a].body.decision !== 'auto_develop') {
        return 'Policy 裁决：' + (arts[a].body.reason || '') + ' (decision=' + arts[a].body.decision + ')';
      }
    }
    for (var r = runs.length - 1; r >= 0; r--) {
      if (runs[r].error_kind || runs[r].error_detail || runs[r].status === 'FAILED' || runs[r].status === 'TIMEOUT') {
        return 'Run ' + runs[r].stage + ' #' + runs[r].attempt + ' 异常：' + (runs[r].error_kind || runs[r].status) + ' ' + (runs[r].error_detail || '');
      }
    }
    return '';
  }

  /**
   * 停留时长条的比例：按当前任务里最长阶段归一。
   * 用对数刻度 —— 阶段耗时横跨毫秒到数天（例如人工等待），线性刻度会把短阶段全压成 0。
   * 有耗时的最小值 3%，让「很短但不是零」的阶段仍然可见。
   */
  function durationPct(ms, maxMs) {
    if (ms == null || ms <= 0 || maxMs <= 0) return 0;
    var pct = Math.round((Math.log10(ms / 1000 + 1) / Math.log10(maxMs / 1000 + 1)) * 100);
    return Math.max(3, Math.min(100, pct));
  }

  function renderPipeline(d) {
    var status = d.task.status;
    var traj = analyzeTrajectory(d.task, d.events);
    var onMain = MAIN_PATH.indexOf(status) >= 0;
    var kind = statusKind(status);

    // 终态不再累计「已停留」，否则会显示成完成后的天数。
    var localNow = Date.now();
    var currentDur = null;
    if (traj.currentSince && kind !== 'done' && kind !== 'bad') {
      var sinceMs = new Date(traj.currentSince).getTime();
      if (!isNaN(sinceMs) && localNow >= sinceMs) currentDur = localNow - sinceMs;
    }

    var maxDur = currentDur || 0;
    var keys = Object.keys(traj.durationByState);
    for (var m = 0; m < keys.length; m++) {
      if (traj.durationByState[keys[m]] > maxDur) maxDur = traj.durationByState[keys[m]];
    }

    // 偏离主路径时，出发节点要标出来 —— 否则轨道上看起来像是正常停在该阶段
    var departFrom = '';
    if (!onMain && traj.lastStatusEvent) departFrom = (traj.lastStatusEvent.payload || {}).from || '';

    var html = '<div class="pipeline-scroll"><div class="pipeline">';
    for (var i = 0; i < MAIN_PATH.length; i++) {
      var s = MAIN_PATH[i];
      var shortName = s.replace(/^S-/, '');
      var label = statusLabel(s) || shortName;
      var trId = traj.transitionsByTo[s] || '';
      var cls = 'step';
      var metaText = '待到达';
      var dur = null;
      if (s === status) {
        cls += ' current' + (s === 'S-DONE' ? ' done-term' : '');
        dur = currentDur;
        metaText = s === 'S-DONE' ? '✓ 已完成' : (currentDur != null ? '● ' + fmtDurationMs(currentDur) : '● 进行中');
      } else if (traj.visited[s]) {
        cls += ' done';
        dur = traj.durationByState[s] != null ? traj.durationByState[s] : null;
        metaText = '✓ ' + (dur != null ? fmtDurationMs(dur) : '已通过');
      } else if (i < traj.maxVisitedMainIdx) {
        cls += ' skipped';
        metaText = '↷ 已跳过';
      }
      if (s === departFrom) {
        cls += ' departed';
        metaText = dur != null ? '↗ ' + fmtDurationMs(dur) : '↗ 分出';
      }

      var pct = durationPct(dur, maxDur);
      var title = s + (label !== shortName ? ' · ' + label : '') + (trId ? '（由 ' + trId + ' 转入）' : '');
      if (s === departFrom) title += '（由此分出至 ' + (statusLabel(status) || status) + '）';
      var sinceAttr = (s === status && currentDur != null && traj.currentSince)
        ? ' data-since="' + esc(traj.currentSince) + '"'
        : '';
      var prefixAttr = (s === status && dur != null) ? ' data-prefix="● "' : '';
      html += '<div class="' + cls + '"' + sinceAttr + ' title="' + esc(title) + '">' +
        '<span class="step-name">' + esc(label) + '</span>' +
        '<div class="step-foot">' +
          '<span class="step-meta"' + prefixAttr + '>' + esc(metaText) + '</span>' +
        '</div>' +
        (pct > 0 ? '<span class="step-bar"><i style="width:' + pct + '%"></i></span>' : '') +
      '</div>';

      if (i < MAIN_PATH.length - 1) {
        html += '<div class="arrow">→</div>';
      }
    }
    html += '</div></div>';

    if (!onMain) {
      var isBad = statusKind(status) === 'bad';
      var lastSev = traj.lastStatusEvent ? (traj.lastStatusEvent.payload || {}) : {};
      var fromNode = lastSev.from || '主路径';
      var viaTr = lastSev.transition ? ' (' + lastSev.transition + ' · ' + (lastSev.event || '') + ')' : '';
      var reason = findGateOrFailureReason(d, lastSev);
      var dwellHtml = currentDur != null
        ? '<span class="branch-dwell" data-prefix="已停留 ">已停留 ' + esc(fmtDurationMs(currentDur)) + '</span>'
        : '';
      var sinceAttr = (currentDur != null && traj.currentSince)
        ? ' data-since="' + esc(traj.currentSince) + '"'
        : '';
      html += '<div class="branch-callout' + (isBad ? ' bad' : '') + '"' + sinceAttr + '>' +
        '<div class="branch-callout-head">' +
          '<span>当前偏离主路径，停驻于分支状态：</span>' +
          '<span class="mono">' + esc(fromNode) + esc(viaTr) + ' → </span>' +
          badge(status) +
          dwellHtml +
        '</div>' +
        (reason ? '<div class="branch-callout-reason">' + esc(reason) + '</div>' : '') +
      '</div>';
    }

    var directNexts = [];
    if (state.meta && state.meta.transitions) {
      for (var j = 0; j < state.meta.transitions.length; j++) {
        var tr = state.meta.transitions[j];
        if (tr.from === status) directNexts.push(tr);
      }
    }
    if (directNexts.length > 0) {
      html += '<div class="next-transitions"><span class="next-label">可能的下一次转移：</span>';
      for (var k = 0; k < directNexts.length; k++) {
        var n = directNexts[k];
        var targetLabel = n.to === 'SELF' ? status + ' (自环)' : n.to;
        html += '<span class="tr-chip" title="守卫条件: ' + esc(n.guardText) + '">' +
          '<span class="tr-code">' + esc(n.id) + '</span>' +
          '<span>→ ' + esc(targetLabel) + '</span>' +
          '<span class="muted">on ' + esc((n.on || []).join('/')) + '</span>' +
          (n.guardText && n.guardText !== '—' ? '<span class="tr-guard">[' + esc(n.guardText) + ']</span>' : '') +
        '</span>';
      }
      html += '</div>';
    }
    return html;
  }

  /**
   * 当前阶段的「已停留」只跟时间走，不跟数据走：
   * 无感刷新在 detailSig 不变时不会重绘，这里按轮询节拍单独更新文本，避免时长冻结。
   */
  function tickElapsed() {
    var els = document.querySelectorAll('[data-since]');
    var now = Date.now();
    for (var i = 0; i < els.length; i++) {
      var since = new Date(els[i].getAttribute('data-since')).getTime();
      if (isNaN(since)) continue;
      var target = els[i].querySelector('.step-meta') || els[i].querySelector('.branch-dwell');
      if (!target) continue;
      var prefix = target.getAttribute('data-prefix') || '';
      target.textContent = prefix + fmtDurationMs(now - since);
    }
  }

  function extractPrInfo(events) {
    var evs = events || [];
    for (var i = evs.length - 1; i >= 0; i--) {
      var ev = evs[i];
      var p = ev.payload || {};
      if ((ev.type === 'SideEffectApplied' || ev.type === 'SideEffectIntent') && p.kind === 'CreatePullRequest' && p.pr_url) {
        return { url: p.pr_url, number: p.pr_number, branch: p.head_branch };
      }
    }
    return null;
  }

  function extractDiffEvents(events) {
    var out = [];
    var evs = events || [];
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      if (ev.type === 'WorkspaceDiffCollected' && ev.payload && (ev.payload.patch || (ev.payload.files_changed && ev.payload.files_changed.length > 0))) {
        out.push(ev);
      }
    }
    return out;
  }

  function formatExternalRefLink(ref, repoUrl) {
    if (!ref) return '—';
    var s = String(ref);
    if (/^https?:\\/\\//i.test(s)) {
      return '<a href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">' + esc(s) + ' ↗</a>';
    }
    var m = s.match(/^([^/]+\\/[^#]+)#(\\d+)$/);
    if (m) {
      return '<a href="https://github.com/' + esc(m[1]) + '/issues/' + esc(m[2]) + '" target="_blank" rel="noopener noreferrer">' + esc(s) + ' ↗</a>';
    }
    return '<code>' + esc(s) + '</code>';
  }

  function getLatestArtifacts(artifacts) {
    var latest = [];
    var byGroup = {};
    var arts = artifacts || [];
    for (var i = 0; i < arts.length; i++) {
      var a = arts[i];
      var gKey = (a.kind || '') + '::' + (a.key || '');
      if (!byGroup[gKey]) byGroup[gKey] = [];
      byGroup[gKey].push(a);
    }
    var keys = Object.keys(byGroup);
    for (var k = 0; k < keys.length; k++) {
      var list = byGroup[keys[k]];
      list.sort(function (x, y) { return (Number(y.version) || 0) - (Number(x.version) || 0); });
      var active = list[0];
      for (var j = 0; j < list.length; j++) {
        if (!list[j].superseded_by) { active = list[j]; break; }
      }
      latest.push({ latest: active, history: list });
    }
    return latest;
  }

  /** 人工介入的简短停驻原因 —— 详情由下方「偏离主路径」调用带完整给出。 */
  function shortStatusReason(traj, status) {
    if (status !== 'S-HUMAN_REVIEW') return '';
    var last = traj && traj.lastStatusEvent ? (traj.lastStatusEvent.payload || {}) : {};
    if (last.event === 'RunTimeout') return 'Run 超时后升级人工';
    if (last.event === 'RunFailed') return 'Run 失败后升级人工';
    if (last.transition === 'T-031') return '执行异常升级人工';
    return '等待人工复核';
  }

  /**
   * 一句话现状：现在在哪、在等什么、下一步能做什么。
   * 全部由确定性数据推导，不调用模型、不写死单条任务的文案。
   */
  function renderStatusSummary(d) {
    var t = d.task;
    var status = t.status;
    var traj = analyzeTrajectory(t, d.events || []);
    var kind = statusKind(status);
    var label = statusLabel(status) || status;
    var isTerm = kind === 'done' || kind === 'bad';
    var text;

    if (isTerm) {
      text = '<b>' + esc(label) + '</b> · 终态不可再变更（I8）。全程 ' +
        (d.runs || []).length + ' 个 Run · ' + (d.artifacts || []).length + ' 个产物 · ' + (d.events || []).length + ' 个事件。';
    } else {
      var hint = shortStatusReason(traj, status) || STATUS_HINTS[status] || '';
      text = '<b>' + esc(label) + '</b>' + (hint ? '：' + esc(hint) : '');

      var nexts = [];
      var allTr = (state.meta && state.meta.transitions) || [];
      for (var i = 0; i < allTr.length; i++) {
        if (allTr[i].from === status) nexts.push(allTr[i]);
      }
      if (nexts.length > 0) {
        var opts = [];
        for (var j = 0; j < nexts.length && j < 3; j++) {
          var n = nexts[j];
          // 自环转移（T-009 / T-030 等）用当前状态名 + 标注，避免直接显示裸 SELF。
          var toLabel = n.to === 'SELF'
            ? (statusLabel(status) || status) + '（自环）'
            : (statusLabel(n.to) || n.to);
          opts.push(n.id + ' ' + (n.on || []).map(eventLabel).join(' / ') + ' → ' + toLabel);
        }
        text += '<span class="ss-next"> · 下一步：' + esc(opts.join('；') + (nexts.length > 3 ? ' 等' : '')) + '</span>';
      } else {
        text += '<span class="ss-next"> · 当前状态没有可用的下一次转移。</span>';
      }
    }

    return '<div class="status-summary' + (isTerm ? ' term' : '') + (kind === 'bad' ? ' bad' : '') + '">' +
      '<span class="ss-tag">现状</span><p>' + text + '</p></div>';
  }

  /**
   * 人工闸门提示条。
   *
   * 只回答两件事：现在为什么停住了、在本机终端敲什么。命令由页面拼好给复制，
   * 控制台**不发任何写请求** —— 写操作只有 CLI 一条路径（见 spec/frontend/console-guidelines）。
   */
  function renderHumanCallout(t) {
    var status = t.status;
    if (status !== 'S-HUMAN_REVIEW' && status !== 'S-NEED_CLARIFICATION') return '';

    var rows = [];
    if (status === 'S-HUMAN_REVIEW') {
      rows.push(['批准', 'keel decide ' + t.id + ' approve']);
      rows.push(['驳回', 'keel decide ' + t.id + ' reject --note "…"']);
      rows.push(['返工', 'keel decide ' + t.id + ' rework']);
    } else {
      rows.push(['补充澄清', 'keel answer ' + t.id + ' --text "…"']);
    }

    var body = '';
    for (var i = 0; i < rows.length; i++) {
      body += '<div class="human-callout-row">' +
        '<span class="human-callout-what">' + esc(rows[i][0]) + '</span>' +
        '<code class="human-callout-cmd">' + esc(rows[i][1]) + '</code>' +
        '<button type="button" class="copy-btn" data-copy="' + esc(rows[i][1]) + '" title="复制命令">复制</button>' +
        '</div>';
    }

    var head = status === 'S-HUMAN_REVIEW'
      ? '需要人工：任务停在人工评审，等一次裁决'
      : '需要人工：任务在等澄清答复，超时会自动放弃';

    return '<div class="human-callout">' +
      '<div class="human-callout-head">' + esc(head) +
        '<span class="human-callout-hint">控制台只读，命令在本机终端执行</span>' +
      '</div>' + body + '</div>';
  }

  function renderGlossary() {
    var html = '';
    for (var i = 0; i < GLOSSARY.length; i++) {
      html += '<div class="gloss-item">' +
        '<span class="gloss-term">' + esc(GLOSSARY[i][0]) + '</span>' +
        '<span>' + esc(GLOSSARY[i][1]) + '</span>' +
      '</div>';
    }
    return html;
  }

  function renderCockpitHeader(d) {
    var t = d.task;
    var runs = d.runs || [];
    var events = d.events || [];
    var artifacts = d.artifacts || [];
    var pr = extractPrInfo(events);

    var totalTokensIn = 0, totalTokensOut = 0, totalCost = 0;
    var succRuns = 0, failRuns = 0;
    var costBasis = '';
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      totalTokensIn += Number(r.tokens_in) || 0;
      totalTokensOut += Number(r.tokens_out) || 0;
      totalCost += Number(r.cost_usd) || 0;
      if (r.cost_basis && !costBasis) costBasis = r.cost_basis;
      if (r.status === 'SUCCEEDED') succRuns++;
      else if (r.status === 'FAILED' || r.status === 'TIMEOUT') failRuns++;
    }

    var repoHtml = /^https?:\\/\\//i.test(t.repo || '')
      ? '<a href="' + esc(t.repo) + '" target="_blank" rel="noopener noreferrer"><code>' + esc(t.repo) + '</code> ↗</a>'
      : '<code>' + esc(t.repo || '—') + '</code>';

    var controlMode = t.control_mode || 'auto';
    var controlLabel = controlMode === 'paused' ? '已暂停' : (controlMode === 'human' ? '人工驾驶' : '自动执行');

    var html = '<div class="view">' +
      '<div class="view-head">' +
      '<div class="cockpit-top-row">' +
        '<div class="cockpit-badges">' +
          badge(t.status) +
          '<span class="mode-pill drive ' + esc(controlMode) + '" title="control_mode: ' + esc(controlMode) + '">' + controlLabel + '</span>' +
          (t.risk ? '<span class="badge ' + (t.risk === 'high' ? 'bad' : (t.risk === 'medium' ? 'gate' : 'done')) + '">risk: ' + esc(t.risk) + '</span>' : '') +
          (t.complexity ? '<span class="badge neutral">complexity: ' + esc(t.complexity) + '</span>' : '') +
          (pr ? '<a class="pr-link-pill" href="' + esc(pr.url) + '" target="_blank" rel="noopener noreferrer">PR #' + esc(pr.number || '') + ' ↗</a>' : '') +
        '</div>' +
        '<div class="cockpit-actions">' +
          '<button type="button" class="copy-btn" data-copy="' + esc(t.id) + '" title="复制 Task UUID">复制 ID: ' + esc(shortId(t.id)) + '</button>' +
          '<button type="button" class="copy-btn" data-copy="keel status ' + esc(t.id) + '" title="复制 CLI 状态查询命令">复制 keel status</button>' +
          '<button type="button" class="copy-btn" data-copy="pnpm run timeline -- ' + esc(t.id) + '" title="复制完整时间线导出命令">复制 timeline 命令</button>' +
          '<button type="button" class="copy-btn" id="glossary-btn" aria-expanded="' + (state.glossaryOpen ? 'true' : 'false') + '" title="查看状态码、转移编号与核心术语的说明">术语表</button>' +
        '</div>' +
      '</div>' +
      '<h2 class="cockpit-title">' + esc(t.title) + '</h2>' +
      '<div class="cockpit-meta">' +
        '<span class="cockpit-meta-item">' + repoHtml + '</span>' +
        '<span class="cockpit-meta-item">分支: <code>' + esc(t.work_branch || '—') + '</code> → <code>' + esc(t.base_branch || 'main') + '</code></span>' +
        '<span class="cockpit-meta-item">创建: ' + esc(fmtTime(t.created_at)) + '</span>' +
        '<span class="cockpit-meta-item">更新: ' + esc(fmtTime(t.updated_at)) + '</span>' +
        (t.terminal_at ? '<span class="cockpit-meta-item">终态: ' + esc(fmtTime(t.terminal_at)) + '</span>' : '') +
      '</div>' +
      '</div>' +
      '<div class="view-body">' +
      renderStatusSummary(d) +
      renderHumanCallout(t) +
      '<div class="summary-grid">' +
        '<div class="stat-box">' +
          '<div class="stat-label">总历时 (Duration)</div>' +
          '<div class="stat-value">' + esc(calcDuration(t.created_at, t.terminal_at || t.updated_at)) + '</div>' +
          '<div class="stat-sub">' + (t.terminal_at ? '已达不可变终态 (I8)' : '非终态 · 持续追踪中') + '</div>' +
        '</div>' +
        '<div class="stat-box">' +
          '<div class="stat-label">Run 执行轮次</div>' +
          '<div class="stat-value">' + runs.length + ' <span style="font-size:12px;font-weight:500" class="muted">次</span></div>' +
          '<div class="stat-sub">' + succRuns + ' 成功' + (failRuns > 0 ? ' · ' + failRuns + ' 失败' : '') + '</div>' +
        '</div>' +
        '<div class="stat-box">' +
          '<div class="stat-label">Token 消耗 (In / Out)</div>' +
          '<div class="stat-value">' + fmtNum(totalTokensIn + totalTokensOut) + '</div>' +
          '<div class="stat-sub">入 ' + fmtNum(totalTokensIn) + ' · 出 ' + fmtNum(totalTokensOut) + '</div>' +
        '</div>' +
        '<div class="stat-box">' +
          '<div class="stat-label">累计成本 (Cost USD)</div>' +
          '<div class="stat-value">' + fmtCost(totalCost) + '</div>' +
          '<div class="stat-sub">口径: ' + esc(costBasis || (totalCost > 0 ? 'estimated' : '—')) + (t.budget_usd ? ' / 预算 $' + esc(t.budget_usd) : '') + '</div>' +
        '</div>' +
        '<div class="stat-box">' +
          '<div class="stat-label">Fact Plane 沉淀</div>' +
          '<div class="stat-value">' + artifacts.length + ' 产物 · ' + events.length + ' 事件</div>' +
          '<div class="stat-sub">可由 readEvents 完整重建</div>' +
        '</div>' +
      '</div>' +
      '<div class="glossary-panel" id="glossary-panel"' + (state.glossaryOpen ? '' : ' hidden') + '>' +
        renderGlossary() +
      '</div>';
    return html;
  }

  function renderRfcBody(art, historyCount) {
    var b = art.body || {};
    var goals = Array.isArray(b.goals) ? b.goals : [];
    var nonGoals = Array.isArray(b.non_goals) ? b.non_goals : [];
    var acs = Array.isArray(b.acceptance_criteria) ? b.acceptance_criteria : [];
    var pc = b.proposed_change || {};
    var areas = Array.isArray(pc.affected_areas) ? pc.affected_areas : [];
    var pf = b.policy_facts || {};

    var html = '<div class="card">' +
      '<div class="card-header">' +
        '<h3>RFC 工程规格书 · ' + esc(b.title || art.key || 'RFC') + ' <span class="badge purple">v' + esc(art.version) + (historyCount > 1 ? ' / 共' + historyCount + '版' : '') + '</span></h3>' +
        '<span class="muted mono">' + esc(fmtTime(art.committed_at)) + '</span>' +
      '</div>';

    if (b.problem) {
      html += '<div class="rfc-section">' +
        '<h4 class="rfc-sec-title">问题描述 (Problem Statement)</h4>' +
        '<div style="color:var(--text-sec);font-size:13.5px;line-height:1.7">' + esc(b.problem) + '</div>' +
      '</div>';
    }

    if (goals.length > 0 || nonGoals.length > 0) {
      html += '<div class="rfc-section"><div class="rfc-two-col">';
      if (goals.length > 0) {
        html += '<div><h4 class="rfc-sec-title">目标 (Goals · ' + goals.length + ')</h4><ul class="rfc-list">';
        for (var g = 0; g < goals.length; g++) html += '<li>' + esc(goals[g]) + '</li>';
        html += '</ul></div>';
      }
      if (nonGoals.length > 0) {
        html += '<div><h4 class="rfc-sec-title">非目标 (Non-Goals · ' + nonGoals.length + ')</h4><ul class="rfc-list">';
        for (var ng = 0; ng < nonGoals.length; ng++) html += '<li>' + esc(nonGoals[ng]) + '</li>';
        html += '</ul></div>';
      }
      html += '</div></div>';
    }

    if (pc.summary || pc.approach || areas.length > 0) {
      html += '<div class="rfc-section">' +
        '<h4 class="rfc-sec-title">拟议方案 (Proposed Change)</h4>' +
        (pc.summary ? '<div style="font-weight:600;margin-bottom:6px">' + esc(pc.summary) + '</div>' : '') +
        (pc.approach ? '<div style="white-space:pre-wrap;color:var(--text-sec);font-size:13.5px;line-height:1.7">' + esc(pc.approach) + '</div>' : '');
      if (areas.length > 0) {
        html += '<div class="file-tags">';
        for (var fa = 0; fa < areas.length; fa++) {
          html += '<span class="file-tag">' + esc(areas[fa]) + '</span>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    if (acs.length > 0) {
      html += '<div class="rfc-section">' +
        '<h4 class="rfc-sec-title">验收标准 (Acceptance Criteria · ' + acs.length + ')</h4>' +
        '<table class="ac-table"><thead><tr><th>ID</th><th>验收判据</th><th>验证方式</th></tr></thead><tbody>';
      for (var c = 0; c < acs.length; c++) {
        var ac = acs[c] || {};
        html += '<tr><td class="ac-id">' + esc(ac.id || ('AC' + (c + 1))) + '</td>' +
          '<td>' + esc(ac.text || '') + '</td>' +
          '<td><span class="badge neutral">' + esc(ac.verifiable_by || '—') + '</span></td></tr>';
      }
      html += '</tbody></table></div>';
    }

    if (pf && (pf.risk || pf.complexity || pf.estimated_files_changed != null)) {
      html += '<div class="rfc-section">' +
        '<h4 class="rfc-sec-title">策略事实声明 (Policy Facts)</h4>' +
        '<div class="facts-chips">' +
          '<span class="fact-chip">risk: <b>' + esc(pf.risk || '—') + '</b></span>' +
          '<span class="fact-chip">complexity: <b>' + esc(pf.complexity || '—') + '</b></span>' +
          '<span class="fact-chip">estimated_files: <b>' + esc(pf.estimated_files_changed) + '</b></span>' +
          '<span class="fact-chip">security_related: <b>' + esc(String(!!pf.security_related)) + '</b></span>' +
        '</div>' +
      '</div>';
    }

    html += '<div class="rfc-section">' +
      '<details data-expand-id="art-raw-rfc-' + esc(art.version) + '">' +
        '<summary>查看 RFC 原始 JSON (schema v' + esc(art.schema_version || '1.0') + ')</summary>' +
        '<pre class="mono">' + esc(JSON.stringify(b, null, 2)) + '</pre>' +
      '</details>' +
    '</div></div>';
    return html;
  }

  function renderPolicyDecisionCard(art) {
    var b = art.body || {};
    var rules = Array.isArray(b.matched_rules) ? b.matched_rules : [];
    var snap = b.facts_snapshot || {};
    var snapKeys = Object.keys(snap);
    var isAuto = b.decision === 'auto_develop' || b.decision === 'allow';

    var html = '<div class="card">' +
      '<div class="card-header">' +
        '<h3>策略引擎裁决 · ' + esc(b.decision_point || art.key || 'policy') + '</h3>' +
        '<span class="badge ' + (isAuto ? 'done' : 'gate') + '">' + esc(b.decision || '—') + '</span>' +
      '</div>' +
      '<div style="margin-bottom:8px;font-size:13px"><b>裁决理由：</b>' + esc(b.reason || '—') +
        (b.default_applied ? ' <span class="badge gate">默认兜底规则生效</span>' : '') +
      '</div>';

    if (rules.length > 0) {
      html += '<div class="facts-chips" style="margin-bottom:8px">';
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        html += '<span class="fact-chip">规则 <b>' + esc(r.id) + '</b> → <code>' + esc(r.action) + '</code> <span class="muted">(' + esc(r.condition) + ')</span></span>';
      }
      html += '</div>';
    }

    if (snapKeys.length > 0) {
      html += '<div class="facts-chips">';
      for (var k = 0; k < snapKeys.length; k++) {
        var key = snapKeys[k];
        html += '<span class="fact-chip">' + esc(key) + ': <b>' + esc(JSON.stringify(snap[key])) + '</b></span>';
      }
      html += '</div>';
    }

    html += '<div style="margin-top:10px">' +
      '<details data-expand-id="art-raw-policy-' + esc(art.key) + '-' + esc(art.version) + '">' +
        '<summary>查看 Policy Decision 原始 JSON</summary>' +
        '<pre class="mono">' + esc(JSON.stringify(b, null, 2)) + '</pre>' +
      '</details>' +
    '</div></div>';
    return html;
  }

  function renderOverviewTab(d) {
    var html = '';
    var feedbacks = d.feedbacks || [];
    var groups = getLatestArtifacts(d.artifacts || []);

    // 1. Feedback Origin
    html += '<div class="card">' +
      '<div class="card-header">' +
        '<h3>需求起源 · ' + feedbacks.length + '</h3>' +
        (feedbacks.length > 0 ? '<span class="badge stage">source: ' + esc(feedbacks[0].source) + '</span>' : '') +
      '</div>';
    if (feedbacks.length === 0) {
      html += '<div class="muted">该任务未关联 feedback 表记录（可能由内部测试直接创建）。</div>';
    } else {
      for (var f = 0; f < feedbacks.length; f++) {
        var fb = feedbacks[f];
        html += '<div style="margin-bottom:' + (f < feedbacks.length - 1 ? '12px' : '0') + '">' +
          '<div class="cockpit-meta" style="border-bottom:0;padding-bottom:6px">' +
            '<span>外部引用: ' + formatExternalRefLink(fb.external_ref, d.task.repo) + '</span>' +
            '<span>接收时间: ' + esc(fmtTime(fb.received_at)) + '</span>' +
            '<span>Feedback ID: <code>' + esc(shortId(fb.id)) + '</code></span>' +
          '</div>' +
          '<div class="feedback-body">' + esc(fb.body) + '</div>' +
        '</div>';
      }
    }
    html += '</div>';

    // Separate artifacts by kind
    var outcomes = [];
    var policies = [];
    var rfcs = [];
    var others = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var kind = g.latest.kind;
      if (kind === 'stage_outcome') outcomes.push(g);
      else if (kind === 'policy_decision') policies.push(g);
      else if (kind === 'rfc') rfcs.push(g);
      else others.push(g);
    }

    outcomes.sort(function (a, b) {
      var sa = (a.latest.body && a.latest.body.stage) || a.latest.key || '';
      var sb = (b.latest.body && b.latest.body.stage) || b.latest.key || '';
      var ia = STAGE_ORDER.indexOf(sa);
      var ib = STAGE_ORDER.indexOf(sb);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    // 2. Stage Outcomes
    html += '<div class="card">' +
      '<div class="card-header">' +
        '<h3>阶段评审结论 · ' + outcomes.length + '</h3>' +
        '<span class="muted" style="font-size:12px">状态机转移守卫 (Guard) 的结构化输入源</span>' +
      '</div>';
    if (outcomes.length === 0) {
      html += '<div class="muted">暂无阶段结论产物。</div>';
    } else {
      html += '<div class="outcomes-grid">';
      for (var o = 0; o < outcomes.length; o++) {
        var oa = outcomes[o].latest;
        var ob = oa.body || {};
        var stg = ob.stage || oa.key || 'stage';
        html += '<div class="outcome-card">' +
          '<div class="outcome-head">' +
            '<span class="outcome-stage">' + esc(stg) + '</span>' +
            runStatusBadge(ob.verdict || '—') +
          '</div>' +
          '<div class="outcome-reason">' + esc(ob.reason || '—') + '</div>' +
          '<details data-expand-id="outcome-raw-' + esc(stg) + '-' + esc(oa.version) + '">' +
            '<summary>v' + esc(oa.version) + ' · ' + esc(fmtShortTime(oa.committed_at)) + ' · JSON</summary>' +
            '<pre class="mono">' + esc(JSON.stringify(ob, null, 2)) + '</pre>' +
          '</details>' +
        '</div>';
      }
      html += '</div>';
    }
    html += '</div>';

    // 3. Policy Decisions
    for (var p = 0; p < policies.length; p++) {
      html += renderPolicyDecisionCard(policies[p].latest);
    }

    // 4. RFCs
    for (var r = 0; r < rfcs.length; r++) {
      html += renderRfcBody(rfcs[r].latest, rfcs[r].history.length);
    }

    // 5. Other Artifacts (state, checkpoint, critic_review, capability_request)
    if (others.length > 0) {
      html += '<div class="card"><div class="card-header"><h3>其他结构化产物 · ' + others.length + '</h3></div>';
      for (var x = 0; x < others.length; x++) {
        var xa = others[x].latest;
        html += '<details data-expand-id="art-other-' + esc(xa.kind) + '-' + esc(xa.key) + '" style="margin-bottom:8px">' +
          '<summary><code>' + esc(xa.kind) + '</code>' + (xa.key ? ' · <code>' + esc(xa.key) + '</code>' : '') +
          ' v' + esc(xa.version) + ' <span class="muted">(' + esc(fmtTime(xa.committed_at)) + ')</span></summary>' +
          '<pre class="mono">' + esc(JSON.stringify(xa.body, null, 2)) + '</pre>' +
        '</details>';
      }
      html += '</div>';
    }

    return html;
  }

  function renderRunsTab(d) {
    var runs = d.runs || [];
    var events = d.events || [];
    var timers = d.timers || [];

    var ctxByRun = {};
    var diffByRun = {};
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.run_id && ev.type === 'ContextBuilt') ctxByRun[ev.run_id] = ev.payload;
      if (ev.run_id && ev.type === 'WorkspaceDiffCollected') diffByRun[ev.run_id] = ev.payload;
    }

    var html = '<div class="card">' +
      '<div class="card-header">' +
        '<h3>执行轮次与上下文组装 · ' + runs.length + '</h3>' +
        '<span class="muted" style="font-size:12px">Session 销毁后 Run 记录与 Context 快照永久留存于 Fact Plane</span>' +
      '</div>';

    if (runs.length === 0) {
      html += '<div class="muted">该任务尚未派发任何 Run。</div></div>';
      return html;
    }

    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var tokIn = Number(run.tokens_in) || 0;
      var tokOut = Number(run.tokens_out) || 0;
      var ctx = run.id ? ctxByRun[run.id] : null;
      var diff = run.id ? diffByRun[run.id] : null;

      html += '<div class="run-card">' +
        '<div class="run-card-head">' +
          '<div class="run-card-left">' +
            '<span class="run-stage-badge">' + esc(run.stage) + ' #' + esc(run.attempt) + '</span>' +
            '<span class="badge neutral">Role: ' + esc(run.role || '—') + '</span>' +
            runStatusBadge(run.status) +
            '<span class="badge purple">Harness: ' + esc(run.harness_id || '—') + (run.harness_tier ? ' · ' + esc(run.harness_tier) : '') + '</span>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            (run.id ? '<button type="button" class="copy-btn filter-run-btn" data-run-id="' + esc(run.id) + '">查看此 Run 事件</button>' : '') +
          '</div>' +
        '</div>' +
        '<div class="run-metrics-row">' +
          '<span>耗时: <b>' + esc(calcDuration(run.started_at, run.ended_at)) + '</b></span>' +
          '<span>Tokens: <b>' + fmtNum(tokIn + tokOut) + '</b> (入 ' + fmtNum(tokIn) + ' / 出 ' + fmtNum(tokOut) + ')</span>' +
          '<span>成本: <b>' + fmtCost(run.cost_usd) + '</b>' + (run.cost_basis ? ' (' + esc(run.cost_basis) + ')' : '') + '</span>' +
          '<span>开始: ' + esc(fmtShortTime(run.started_at)) + '</span>' +
          '<span>结束: ' + esc(fmtShortTime(run.ended_at)) + '</span>' +
          (run.id ? '<span>Run ID: <code>' + esc(shortId(run.id)) + '</code></span>' : '') +
        '</div>';

      if (run.error_kind || run.error_detail) {
        html += '<div class="branch-callout bad" style="margin-top:8px">' +
          '<div class="branch-callout-head">错误类型: <code>' + esc(run.error_kind || 'ERROR') + '</code></div>' +
          (run.error_detail ? '<div class="branch-callout-reason mono">' + esc(run.error_detail) + '</div>' : '') +
        '</div>';
      }

      if (ctx) {
        var usedTok = Number(ctx.total_tokens) || 0;
        var budTok = Number(ctx.budget_tokens) || 40000;
        var pct = budTok > 0 ? Math.min(100, Math.max(1, (usedTok / budTok) * 100)) : 0;
        var secs = Array.isArray(ctx.sections) ? ctx.sections : [];
        var dropped = Array.isArray(ctx.dropped) ? ctx.dropped : [];
        html += '<div class="ctx-box">' +
          '<div class="ctx-head">' +
            '<span><b>ContextBuilder</b> · Recipe <code>' + esc(ctx.recipe_id || run.role || '—') + '</code> (v' + esc(ctx.recipe_version || '1') + ')</span>' +
            '<span class="mono">预算水位: <b>' + fmtNum(usedTok) + '</b> / ' + fmtNum(budTok) + ' tokens (' + pct.toFixed(1) + '%)</span>' +
          '</div>' +
          '<div class="progress-track"><div class="progress-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
          '<div class="ctx-sections">';
        for (var s = 0; s < secs.length; s++) {
          var sec = secs[s];
          html += '<span class="ctx-sec-pill"><b>' + esc(sec.id) + '</b> · ' + fmtNum(sec.tokens) + ' tok · <span class="muted">' + esc(sec.source_ref) + '</span></span>';
        }
        if (dropped.length > 0) {
          html += '<span class="badge bad">已裁剪丢弃: ' + dropped.length + ' 项</span>';
        }
        html += '</div></div>';
      }

      if (diff && diff.files_changed && diff.files_changed.length > 0) {
        html += '<div style="margin-top:8px;font-size:12px" class="mono muted">' +
          '产生工作区代码变更: <b>' + diff.files_changed.length + ' 个文件</b> (' + fmtNum(diff.patch_chars) + ' chars) — 可在「代码变更」Tab 查看完整 Diff' +
        '</div>';
      }

      html += '</div>';
    }
    html += '</div>';

    if (timers.length > 0) {
      html += '<div class="card"><div class="card-header"><h3>持久化定时器 · ' + timers.length + '</h3></div>' +
        '<table><thead><tr><th>类型 (Kind)</th><th>状态 (State)</th><th>关联 Run</th><th>到期时间 (Due)</th><th>触发时间 (Fired)</th></tr></thead><tbody>';
      for (var t = 0; t < timers.length; t++) {
        var tm = timers[t];
        html += '<tr><td><code>' + esc(tm.kind) + '</code></td>' +
          '<td>' + runStatusBadge(tm.state) + '</td>' +
          '<td class="mono">' + esc(shortId(tm.run_id)) + '</td>' +
          '<td class="mono muted">' + esc(fmtTime(tm.due_at)) + '</td>' +
          '<td class="mono muted">' + esc(fmtTime(tm.fired_at)) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }

    return html;
  }

  function parseUnifiedDiff(patch) {
    if (!patch) return [];
    var lines = String(patch).split('\\n');
    var files = [];
    var cur = null;
    var oldLn = 0, newLn = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('diff --git ') === 0) {
        if (cur) files.push(cur);
        var m = line.match(/^diff --git a\\/(.*?) b\\/(.*)$/);
        var fileName = m ? m[2] : line.slice(11);
        cur = { file: fileName, added: 0, removed: 0, rows: [] };
        oldLn = 0; newLn = 0;
        continue;
      }
      if (!cur) {
        cur = { file: 'patch', added: 0, removed: 0, rows: [] };
      }
      if (line.indexOf('index ') === 0 || line.indexOf('--- ') === 0 || line.indexOf('+++ ') === 0 || line.indexOf('new file mode') === 0 || line.indexOf('deleted file mode') === 0) {
        continue;
      }
      if (line.indexOf('@@') === 0) {
        var hm = line.match(/@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);
        if (hm) {
          oldLn = parseInt(hm[1], 10);
          newLn = parseInt(hm[2], 10);
        }
        cur.rows.push({ kind: 'hunk', oldNo: '', newNo: '', text: line });
        continue;
      }
      var ch = line.charAt(0);
      if (ch === '+') {
        cur.added++;
        cur.rows.push({ kind: 'add', oldNo: '', newNo: newLn++, text: line });
      } else if (ch === '-') {
        cur.removed++;
        cur.rows.push({ kind: 'del', oldNo: oldLn++, newNo: '', text: line });
      } else {
        cur.rows.push({ kind: 'ctx', oldNo: oldLn ? oldLn++ : '', newNo: newLn ? newLn++ : '', text: line });
      }
    }
    if (cur) files.push(cur);
    return files;
  }

  function renderDiffTab(d) {
    var diffEvents = extractDiffEvents(d.events || []);
    var html = '<div class="card">' +
      '<div class="card-header">' +
        '<h3>工作区代码变更 · ' + diffEvents.length + '</h3>' +
        '<span class="muted" style="font-size:12px">由 collectChanges 采集并持久化于事件流</span>' +
      '</div>';

    if (diffEvents.length === 0) {
      html += '<div class="muted">该任务尚未产生任何工作区代码变更（或尚未进入 develop 阶段）。</div></div>';
      return html;
    }

    var idx = state.selectedDiffIdx;
    if (idx < 0 || idx >= diffEvents.length) idx = diffEvents.length - 1;
    var activeEv = diffEvents[idx];
    var p = activeEv.payload || {};
    var parsedFiles = parseUnifiedDiff(p.patch || '');
    var totalAdd = 0, totalDel = 0;
    for (var f = 0; f < parsedFiles.length; f++) {
      totalAdd += parsedFiles[f].added;
      totalDel += parsedFiles[f].removed;
    }

    if (diffEvents.length > 1) {
      html += '<div class="filter-pills" style="margin-bottom:12px">';
      for (var dIdx = 0; dIdx < diffEvents.length; dIdx++) {
        var dev = diffEvents[dIdx];
        var dp = dev.payload || {};
        html += '<button type="button" class="filter-pill diff-sel-btn' + (dIdx === idx ? ' active' : '') + '" data-diff-idx="' + dIdx + '">' +
          esc((dp.stage || 'run') + ' #' + (dp.attempt || 1) + ' (seq #' + dev.seq + ')') +
        '</button>';
      }
      html += '</div>';
    }

    html += '<div class="run-metrics-row" style="margin-bottom:12px">' +
      '<span>阶段: <b>' + esc(p.stage || 'develop') + ' #' + esc(p.attempt || 1) + '</b> (事件 #' + esc(activeEv.seq) + ')</span>' +
      '<span>变更文件: <b>' + parsedFiles.length + '</b> 个</span>' +
      '<span class="diff-add-stat">+' + totalAdd + ' 行新增</span>' +
      '<span class="diff-del-stat">-' + totalDel + ' 行删除</span>' +
      (p.patch_truncated ? '<span class="badge gate">Patch 已截断</span>' : '') +
      (p.patch ? '<button type="button" class="copy-btn" data-copy-patch="1">复制完整 Patch</button>' : '') +
    '</div>';

    if (parsedFiles.length > 0) {
      html += '<div class="diff-file-nav">';
      for (var n = 0; n < parsedFiles.length; n++) {
        var pf = parsedFiles[n];
        html += '<a class="diff-file-pill" href="#diff-file-' + n + '">' +
          '<span>' + esc(pf.file) + '</span>' +
          '<span class="diff-add-stat">+' + pf.added + '</span>' +
          '<span class="diff-del-stat">-' + pf.removed + '</span>' +
        '</a>';
      }
      html += '</div>';
    }

    for (var b = 0; b < parsedFiles.length; b++) {
      var fileObj = parsedFiles[b];
      html += '<div class="diff-block" id="diff-file-' + b + '">' +
        '<div class="diff-block-header">' +
          '<span>' + esc(fileObj.file) + '</span>' +
          '<span><span class="diff-add-stat">+' + fileObj.added + '</span> / <span class="diff-del-stat">-' + fileObj.removed + '</span></span>' +
        '</div>' +
        '<div style="overflow-x:auto"><table class="diff-table"><tbody>';
      for (var r = 0; r < fileObj.rows.length; r++) {
        var row = fileObj.rows[r];
        var trCls = row.kind === 'add' ? 'diff-add' : (row.kind === 'del' ? 'diff-del' : (row.kind === 'hunk' ? 'diff-hunk' : ''));
        html += '<tr class="' + trCls + '">' +
          '<td class="ln">' + esc(row.oldNo) + '</td>' +
          '<td class="ln">' + esc(row.newNo) + '</td>' +
          '<td>' + esc(row.text) + '</td>' +
        '</tr>';
      }
      html += '</tbody></table></div></div>';
    }
    html += '</div>';
    return html;
  }

  function eventCategory(type) {
    if (type === 'TaskCreated' || type === 'TaskStatusChanged' || type === 'ControlModeChanged' || type === 'HumanAction' || type === 'NoTransition') return 'state';
    if (type === 'RunCreated' || type === 'RunStatusChanged' || type === 'WorkspaceDiffCollected') return 'run';
    if (type === 'ContextBuilt' || type === 'ProposalSubmitted' || type === 'ProposalAccepted' || type === 'ProposalRejected' || type === 'ArtifactCommitted') return 'context';
    return 'effect';
  }

  function eventTypeBadge(type) {
    var cat = eventCategory(type);
    var cls = cat === 'state' ? 'stage' : (cat === 'run' ? 'purple' : (cat === 'context' ? 'done' : 'gate'));
    if (type === 'ProposalRejected' || type === 'BudgetExceeded') cls = 'bad';
    return '<span class="badge ' + cls + '">' + esc(type) + '</span>';
  }

  function summarizeEvent(ev) {
    var p = ev.payload || {};
    var t = ev.type;
    if (t === 'TaskStatusChanged') {
      return (p.transition ? '[' + p.transition + '] ' : '') + (p.from || '∅') + ' → ' + (p.to || '?') + (p.event ? ' (触发: ' + p.event + ')' : '');
    }
    if (t === 'RunCreated') {
      return '创建 Run: ' + (p.stage || '') + ' #' + (p.attempt || 1) + (p.idempotency_key ? ' (' + p.idempotency_key + ')' : '');
    }
    if (t === 'ContextBuilt') {
      var secCnt = Array.isArray(p.sections) ? p.sections.length : 0;
      return 'Recipe ' + (p.recipe_id || '') + ': ' + fmtNum(p.total_tokens) + ' / ' + fmtNum(p.budget_tokens) + ' tokens (' + secCnt + ' sections)';
    }
    if (t === 'ProposalAccepted' || t === 'ProposalSubmitted' || t === 'ProposalRejected') {
      return '产物提案: kind=' + (p.kind || '') + (p.key ? ' key=' + p.key : '') + (p.attempt ? ' (attempt #' + p.attempt + ')' : '');
    }
    if (t === 'WorkspaceDiffCollected') {
      var fCnt = Array.isArray(p.files_changed) ? p.files_changed.length : 0;
      return '阶段 ' + (p.stage || '') + ' #' + (p.attempt || 1) + ': ' + fCnt + ' 个文件变更 (' + fmtNum(p.patch_chars || 0) + ' chars)';
    }
    if (t === 'PolicyEvaluated') {
      return '判定点 ' + (p.point || '') + ' → 决策: ' + (p.decision || '');
    }
    if (t === 'SideEffectApplied' || t === 'SideEffectIntent') {
      if (p.kind === 'CreatePullRequest') return p.kind + ': PR #' + (p.pr_number || '') + ' (' + (p.pr_url || '') + ')';
      if (p.kind === 'CreateBranch') return p.kind + ': ' + (p.branch || '');
      return (p.kind || t) + (p.transition ? ' [' + p.transition + ']' : '');
    }
    if (t === 'TaskCreated') {
      return '初始化任务 (trace_id: ' + shortId(p.trace_id) + ')';
    }
    var raw = JSON.stringify(p);
    return raw.length > 110 ? raw.slice(0, 110) + '…' : raw;
  }

  function renderTimelineTab(d) {
    var events = d.events || [];
    var runs = d.runs || [];
    var runLabelById = {};
    for (var r = 0; r < runs.length; r++) {
      if (runs[r].id) runLabelById[runs[r].id] = runs[r].stage + ' #' + runs[r].attempt;
    }

    var q = state.eventSearch.trim().toLowerCase();
    var filtered = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (state.eventCat !== 'all' && eventCategory(ev.type) !== state.eventCat) continue;
      if (state.eventRunFilter !== 'all' && String(ev.run_id || '') !== state.eventRunFilter) continue;
      if (q) {
        var hay = (String(ev.seq) + ' ' + (ev.type || '') + ' ' + JSON.stringify(ev.payload || {})).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      filtered.push(ev);
    }

    var html = '<div class="card">' +
      '<div class="card-header">' +
        '<h3>事实事件时间线 · ' + filtered.length + ' / ' + events.length + '</h3>' +
        '<div style="display:flex;gap:6px">' +
          '<button type="button" class="copy-btn" id="expand-all-events">全部展开 JSON</button>' +
          '<button type="button" class="copy-btn" id="collapse-all-events">全部收起</button>' +
        '</div>' +
      '</div>' +
      '<div class="timeline-toolbar">' +
        '<div class="timeline-filters">' +
          '<button type="button" class="filter-pill ev-cat-btn' + (state.eventCat === 'all' ? ' active' : '') + '" data-ev-cat="all">全部</button>' +
          '<button type="button" class="filter-pill ev-cat-btn' + (state.eventCat === 'state' ? ' active' : '') + '" data-ev-cat="state">状态流转</button>' +
          '<button type="button" class="filter-pill ev-cat-btn' + (state.eventCat === 'run' ? ' active' : '') + '" data-ev-cat="run">Run 生命周期</button>' +
          '<button type="button" class="filter-pill ev-cat-btn' + (state.eventCat === 'context' ? ' active' : '') + '" data-ev-cat="context">上下文与提案</button>' +
          '<button type="button" class="filter-pill ev-cat-btn' + (state.eventCat === 'effect' ? ' active' : '') + '" data-ev-cat="effect">副作用与策略</button>' +
        '</div>' +
        '<div class="timeline-filters">' +
          '<select id="ev-run-select" class="timeline-select">' +
            '<option value="all">所有关联 Run</option>';

    for (var rl = 0; rl < runs.length; rl++) {
      var rn = runs[rl];
      if (!rn.id) continue;
      html += '<option value="' + esc(rn.id) + '"' + (state.eventRunFilter === rn.id ? ' selected' : '') + '>' +
        esc(rn.stage + ' #' + rn.attempt + ' (' + shortId(rn.id) + ')') + '</option>';
    }

    html += '</select>' +
          '<input id="ev-search-input" class="timeline-search" type="text" placeholder="搜索事件或 payload…" value="' + esc(state.eventSearch) + '" />' +
        '</div>' +
      '</div>';

    if (filtered.length === 0) {
      html += '<div class="muted" style="padding:20px 0;text-align:center">没有匹配的事件记录。</div></div>';
      return html;
    }

    html += '<table class="timeline"><thead><tr><th>Seq</th><th>时间</th><th>事件类型</th><th>关联 Run</th><th>事件摘要与 Payload</th></tr></thead><tbody>';
    for (var e = 0; e < filtered.length; e++) {
      var item = filtered[e];
      var runTag = item.run_id ? (runLabelById[item.run_id] || shortId(item.run_id)) : '—';
      var expId = 'ev-payload-' + item.seq;
      var isOpen = !!state.expandedIds[expId];
      html += '<tr>' +
        '<td class="seq">#' + esc(item.seq) + '</td>' +
        '<td class="time">' + esc(fmtShortTime(item.occurred_at)) + '</td>' +
        '<td class="type">' + eventTypeBadge(item.type) + '</td>' +
        '<td class="run-col">' + (item.run_id ? '<code>' + esc(runTag) + '</code>' : '<span class="muted">—</span>') + '</td>' +
        '<td>' +
          '<div class="ev-summary">' + esc(summarizeEvent(item)) + '</div>' +
          '<details data-expand-id="' + esc(expId) + '"' + (isOpen ? ' open' : '') + '>' +
            '<summary>查看 JSON Payload</summary>' +
            '<pre class="mono">' + esc(JSON.stringify(item.payload, null, 2)) + '</pre>' +
          '</details>' +
        '</td>' +
      '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  function renderDetail(d, preserveScroll) {
    state.detail = d;
    var detailEl = document.getElementById('detail');
    var prevScroll = preserveScroll && detailEl ? detailEl.scrollTop : 0;
    if (preserveScroll) captureExpandedState();

    var diffEvents = extractDiffEvents(d.events || []);
    var diffFileCount = 0;
    if (diffEvents.length > 0) {
      var lastDiff = diffEvents[diffEvents.length - 1].payload || {};
      diffFileCount = Array.isArray(lastDiff.files_changed) ? lastDiff.files_changed.length : parseUnifiedDiff(lastDiff.patch || '').length;
    }

    var html = renderCockpitHeader(d);

    html += '<div class="card">' +
      '<div class="card-header">' +
        '<h3>状态机轨迹</h3>' +
        '<div class="legend-bar">' +
          '<span class="legend-item"><span class="legend-swatch" style="background:var(--done)"></span>已实际通过</span>' +
          '<span class="legend-item"><span class="legend-swatch" style="background:var(--accent)"></span>当前所处状态</span>' +
          '<span class="legend-item"><span class="legend-swatch" style="border:1px dashed var(--muted)"></span>已跳过分支</span>' +
          '<span class="legend-item"><span class="legend-swatch" style="background:var(--line)"></span>未到达</span>' +
        '</div>' +
      '</div>' +
      renderPipeline(d) +
    '</div>';

    var tab = state.activeTab;
    html += '<div class="tabs-bar" role="tablist">' +
      '<button type="button" class="tab-btn' + (tab === 'overview' ? ' active' : '') + '" data-tab="overview">概览与方案 <span class="tab-count">' + (d.artifacts || []).length + '</span></button>' +
      '<button type="button" class="tab-btn' + (tab === 'runs' ? ' active' : '') + '" data-tab="runs">执行与上下文 <span class="tab-count">' + (d.runs || []).length + '</span></button>' +
      '<button type="button" class="tab-btn' + (tab === 'diff' ? ' active' : '') + '" data-tab="diff">代码变更 <span class="tab-count">' + diffFileCount + '</span></button>' +
      '<button type="button" class="tab-btn' + (tab === 'timeline' ? ' active' : '') + '" data-tab="timeline">事件时间线 <span class="tab-count">' + (d.events || []).length + '</span></button>' +
    '</div>';

    html += '<div id="tab-content">';
    if (tab === 'overview') html += renderOverviewTab(d);
    else if (tab === 'runs') html += renderRunsTab(d);
    else if (tab === 'diff') html += renderDiffTab(d);
    else html += renderTimelineTab(d);
    html += '</div>';
    html += '</div></div>'; // .view-body + .view

    detailEl.innerHTML = html;
    restoreExpandedState(prevScroll);
    syncHash();
  }

  function computeTasksSig(tasks) {
    var parts = [];
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      parts.push(t.id + ':' + t.status + ':' + t.updated_at + ':' + (t.run_count || 0) + ':' + (t.event_count || 0));
    }
    return parts.join('|');
  }

  function computeDetailSig(d) {
    var t = d.task || {};
    var evs = d.events || [];
    var lastSeq = evs.length > 0 ? evs[evs.length - 1].seq : 0;
    var runs = d.runs || [];
    var runStatuses = [];
    for (var i = 0; i < runs.length; i++) runStatuses.push(runs[i].status);
    return [t.id, t.status, t.control_mode, t.updated_at, runs.length, runStatuses.join(','), lastSeq, (d.artifacts || []).length].join('|');
  }

  function loadTasks(silent) {
    return fetchJSON('/api/tasks').then(function (data) {
      var nextTasks = data.tasks || [];
      var sig = computeTasksSig(nextTasks);
      state.tasks = nextTasks;
      if (!silent || sig !== state.tasksSig) {
        state.tasksSig = sig;
        if (state.mode === 'projects') {
          renderProjects();
        } else {
          renderTasks();
        }
      }
      var dot = document.getElementById('health-dot');
      if (dot) dot.classList.remove('err');
      updateStatusbar();
      return data;
    });
  }

  function loadDetail(id, silent) {
    return fetchJSON('/api/tasks/' + encodeURIComponent(id)).then(function (data) {
      if (state.selectedId !== id) return;
      var sig = computeDetailSig(data);
      if (silent && sig === state.detailSig) {
        return;
      }
      state.detailSig = sig;
      renderDetail(data, !!silent);
    }).catch(function (err) {
      if (state.selectedId !== id) return;
      document.getElementById('detail').innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
    });
  }

  function select(id) {
    if (state.selectedId !== id) {
      state.selectedId = id;
      state.detailSig = '';
      state.eventRunFilter = 'all';
      state.selectedDiffIdx = 0;
    }
    if (state.mode !== 'tasks') {
      setMode('tasks');
      return;
    }
    renderTasks();
    syncHash();
    document.getElementById('detail').innerHTML = '<div class="empty">正在加载任务事实数据…</div>';
    loadDetail(id, false);
  }

  function refreshAll(silent) {
    var pulse = document.getElementById('pulse');
    if (!silent) pulse.textContent = '同步中…';
    var prevTasksSig = state.tasksSig;
    return loadTasks(!!silent).then(function () {
      if (state.mode === 'overview') {
        return loadStats(!!silent).then(function (statsChanged) {
          if (!silent || statsChanged || state.tasksSig !== prevTasksSig) renderOverview();
        });
      }
      if (state.mode === 'projects') {
        var projects = groupByRepo(state.tasks);
        var stillThere = false;
        for (var i = 0; i < projects.length; i++) {
          if (projects[i].id === state.selectedRepo) { stillThere = true; break; }
        }
        if (!stillThere) state.selectedRepo = projects.length > 0 ? projects[0].id : null;
        renderProjects();
        return;
      }
      if (!state.selectedId && state.tasks.length > 0) {
        state.selectedId = state.tasks[0].id;
        renderTasks();
      } else if (state.selectedId) {
        var exists = false;
        for (var j = 0; j < state.tasks.length; j++) {
          if (state.tasks[j].id === state.selectedId) { exists = true; break; }
        }
        if (!exists && state.tasks.length > 0) {
          state.selectedId = state.tasks[0].id;
          renderTasks();
        }
      }
      if (state.selectedId) return loadDetail(state.selectedId, !!silent);
    }).then(function () {
      pulse.textContent = '已同步 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }).catch(function (err) {
      var dot = document.getElementById('health-dot');
      if (dot) dot.classList.add('err');
      pulse.textContent = '异常：' + err.message;
    });
  }

  function setAuto(on) {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (on) state.timer = setInterval(function () {
      if (document.hidden) return;
      refreshAll(true);
      tickElapsed();
    }, 5000);
  }

  function copyText(text, btnEl) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () {
      if (!btnEl) return;
      var orig = btnEl.textContent;
      btnEl.classList.add('copied');
      btnEl.textContent = '✓ 已复制';
      setTimeout(function () {
        btnEl.classList.remove('copied');
        btnEl.textContent = orig;
      }, 1400);
    }).catch(function () {});
  }

  // ─── Event Listeners ───
  document.getElementById('mode-switch').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.mode-btn[data-mode]');
    if (btn) {
      var next = btn.getAttribute('data-mode');
      if (next !== state.mode) setMode(next);
    }
  });

  document.getElementById('project-list').addEventListener('click', function (ev) {
    var li = ev.target.closest('li[data-repo-id]');
    if (li) {
      state.selectedRepo = li.getAttribute('data-repo-id');
      renderProjects();
      syncHash();
    }
  });

  document.getElementById('detail').addEventListener('click', function (ev) {
    // 概览的三种交互：切口径、点某一天、点项目
    var periodBtn = ev.target.closest('.ov-period[data-period]');
    if (periodBtn) {
      state.overviewPeriod = periodBtn.getAttribute('data-period') || 'yesterday';
      renderOverview();
      return;
    }
    var dayBtn = ev.target.closest('.ov-day[data-date]');
    if (dayBtn) {
      state.overviewPeriod = 'date:' + dayBtn.getAttribute('data-date');
      renderOverview();
      return;
    }
    var projRow = ev.target.closest('.ov-proj[data-repo-id]');
    if (projRow) {
      state.selectedRepo = projRow.getAttribute('data-repo-id');
      state.statusCat = 'all';
      setMode('projects');
      return;
    }
    var taskRow = ev.target.closest('[data-task-id]');
    if (taskRow) select(taskRow.getAttribute('data-task-id'));
  });

  document.getElementById('task-list').addEventListener('click', function (ev) {
    var li = ev.target.closest('li[data-id]');
    if (li) select(li.getAttribute('data-id'));
  });

  document.getElementById('status-filters').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.filter-pill[data-cat]');
    if (btn) {
      state.statusCat = btn.getAttribute('data-cat') || 'all';
      // 项目模式下 chip 筛的是项目任务表，不能去重绘任务侧栏
      if (state.mode === 'projects') renderProjects();
      else renderTasks();
    }
  });

  document.getElementById('repo-filter').addEventListener('change', function (ev) {
    state.repoFilter = ev.target.value || 'all';
    if (state.mode === 'tasks') renderTasks();
  });

  document.getElementById('task-search').addEventListener('input', function (ev) {
    state.searchQuery = ev.target.value || '';
    if (state.mode === 'projects') renderProjects();
    else renderTasks();
  });

  document.getElementById('search-clear').addEventListener('click', function () {
    state.searchQuery = '';
    var inp = document.getElementById('task-search');
    if (inp) inp.value = '';
    if (state.mode === 'projects') renderProjects();
    else renderTasks();
  });

  document.getElementById('theme-btn').addEventListener('click', cycleTheme);
  document.getElementById('refresh').addEventListener('click', function () { refreshAll(false); });
  document.getElementById('auto').addEventListener('change', function (ev) { setAuto(ev.target.checked); });

  var detailRoot = document.getElementById('detail');
  detailRoot.addEventListener('toggle', function (ev) {
    var det = ev.target;
    if (det && det.tagName === 'DETAILS') {
      var expId = det.getAttribute('data-expand-id');
      if (expId) {
        if (det.open) state.expandedIds[expId] = true;
        else delete state.expandedIds[expId];
      }
    }
  }, true);

  detailRoot.addEventListener('click', function (ev) {
    var tabBtn = ev.target.closest('.tab-btn[data-tab]');
    if (tabBtn && state.detail) {
      state.activeTab = tabBtn.getAttribute('data-tab') || 'overview';
      renderDetail(state.detail, false);
      return;
    }

    var glossaryBtn = ev.target.closest('#glossary-btn');
    if (glossaryBtn) {
      state.glossaryOpen = !state.glossaryOpen;
      var gPanel = document.getElementById('glossary-panel');
      if (gPanel) gPanel.hidden = !state.glossaryOpen;
      glossaryBtn.setAttribute('aria-expanded', state.glossaryOpen ? 'true' : 'false');
      return;
    }

    var copyBtn = ev.target.closest('.copy-btn[data-copy]');
    if (copyBtn) {
      copyText(copyBtn.getAttribute('data-copy') || '', copyBtn);
      return;
    }

    var patchBtn = ev.target.closest('.copy-btn[data-copy-patch]');
    if (patchBtn && state.detail) {
      var diffs = extractDiffEvents(state.detail.events || []);
      var idx = state.selectedDiffIdx;
      if (idx < 0 || idx >= diffs.length) idx = diffs.length - 1;
      if (diffs[idx] && diffs[idx].payload && diffs[idx].payload.patch) {
        copyText(diffs[idx].payload.patch, patchBtn);
      }
      return;
    }

    var runFilterBtn = ev.target.closest('.filter-run-btn[data-run-id]');
    if (runFilterBtn && state.detail) {
      state.eventRunFilter = runFilterBtn.getAttribute('data-run-id') || 'all';
      state.activeTab = 'timeline';
      renderDetail(state.detail, false);
      return;
    }

    var diffSelBtn = ev.target.closest('.diff-sel-btn[data-diff-idx]');
    if (diffSelBtn && state.detail) {
      state.selectedDiffIdx = parseInt(diffSelBtn.getAttribute('data-diff-idx') || '0', 10);
      renderDetail(state.detail, true);
      return;
    }

    var evCatBtn = ev.target.closest('.ev-cat-btn[data-ev-cat]');
    if (evCatBtn && state.detail) {
      state.eventCat = evCatBtn.getAttribute('data-ev-cat') || 'all';
      renderDetail(state.detail, true);
      return;
    }

    if (ev.target.id === 'expand-all-events' && state.detail) {
      var evs = state.detail.events || [];
      for (var i = 0; i < evs.length; i++) state.expandedIds['ev-payload-' + evs[i].seq] = true;
      renderDetail(state.detail, true);
      return;
    }

    if (ev.target.id === 'collapse-all-events' && state.detail) {
      var allEvs = state.detail.events || [];
      for (var j = 0; j < allEvs.length; j++) delete state.expandedIds['ev-payload-' + allEvs[j].seq];
      renderDetail(state.detail, true);
      return;
    }
  });

  detailRoot.addEventListener('change', function (ev) {
    if (ev.target && ev.target.id === 'ev-run-select' && state.detail) {
      state.eventRunFilter = ev.target.value || 'all';
      renderDetail(state.detail, true);
    }
  });

  detailRoot.addEventListener('input', function (ev) {
    if (ev.target && ev.target.id === 'ev-search-input' && state.detail) {
      var val = ev.target.value || '';
      var pos = ev.target.selectionStart || val.length;
      state.eventSearch = val;
      renderDetail(state.detail, true);
      var newInp = document.getElementById('ev-search-input');
      if (newInp) {
        newInp.focus();
        try { newInp.setSelectionRange(pos, pos); } catch (_e) {}
      }
    }
  });

  window.addEventListener('hashchange', function () {
    var prevId = state.selectedId;
    var prevTab = state.activeTab;
    var prevMode = state.mode;
    var prevRepo = state.selectedRepo;
    parseHash();
    if (state.mode !== prevMode) {
      setMode(state.mode);
    } else if (state.mode === 'projects' && state.selectedRepo !== prevRepo) {
      renderProjects();
      renderProjectView();
    } else if (state.selectedId && state.selectedId !== prevId) {
      select(state.selectedId);
    } else if (state.activeTab !== prevTab && state.detail) {
      renderDetail(state.detail, false);
    }
  });

  applyTheme(state.theme);
  parseHash();
  applyModeChrome();

  fetchJSON('/api/meta').then(function (meta) {
    state.meta = meta;
    return refreshAll(false);
  }).catch(function (err) {
    var dot = document.getElementById('health-dot');
    if (dot) dot.classList.add('err');
    document.getElementById('detail').innerHTML = '<div class="empty">无法连接 keel 控制台：' + esc(err.message) + '</div>';
  });
  setAuto(true);
})();
</script>
</body>
</html>
`
