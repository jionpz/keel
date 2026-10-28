/**
 * keel 控制台页面 —— 单文件 HTML（内联 CSS / JS，无构建、无外部资源）。
 *
 * 约束：
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
<title>Keel Console</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --text: #1c2024;
    --muted: #6b7280;
    --line: #e3e6ea;
    --accent: #2563eb;
    --stage: #2563eb;
    --gate: #d97706;
    --done: #16a34a;
    --bad: #dc2626;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --panel: #171a21;
      --text: #e6e8eb;
      --muted: #9aa3ad;
      --line: #262b34;
      --accent: #60a5fa;
      --stage: #60a5fa;
      --gate: #fbbf24;
      --done: #4ade80;
      --bad: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  }
  #app { display: grid; grid-template-columns: 320px 1fr; min-height: 100vh; }
  aside {
    border-right: 1px solid var(--line);
    background: var(--panel);
    display: flex; flex-direction: column;
    max-height: 100vh; position: sticky; top: 0;
  }
  aside header { padding: 16px 16px 8px; display: flex; align-items: baseline; gap: 8px; }
  aside h1 { font-size: 18px; margin: 0; letter-spacing: .5px; }
  aside .count { color: var(--muted); font-size: 12px; }
  .toolbar {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 16px 12px; color: var(--muted); font-size: 12px;
  }
  .toolbar button {
    border: 1px solid var(--line); background: transparent; color: var(--text);
    border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px;
  }
  .toolbar button:hover { border-color: var(--accent); color: var(--accent); }
  #task-list { list-style: none; margin: 0; padding: 0 8px 16px; overflow: auto; flex: 1; }
  #task-list li {
    padding: 8px 10px; border-radius: 8px; cursor: pointer;
    border: 1px solid transparent;
  }
  #task-list li:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  #task-list li.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  #task-list .title { display: block; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #task-list .meta { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; margin-top: 2px; }
  main { padding: 20px 24px 60px; overflow: auto; }
  .empty { color: var(--muted); padding: 40px 0; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid currentColor; white-space: nowrap;
  }
  .badge.stage { color: var(--stage); }
  .badge.gate { color: var(--gate); }
  .badge.done { color: var(--done); }
  .badge.bad { color: var(--bad); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; display: inline-block; }
  h2 { font-size: 20px; margin: 0 0 6px; }
  .sub { color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 18px; }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 14px 16px; margin-bottom: 16px;
  }
  .card h3 { font-size: 13px; margin: 0 0 10px; color: var(--muted); font-weight: 600; letter-spacing: .4px; }
  .pipeline { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .pipeline .step {
    font-size: 12px; padding: 4px 8px; border-radius: 6px;
    border: 1px solid var(--line); color: var(--muted);
  }
  .pipeline .step.done { border-color: color-mix(in srgb, var(--done) 40%, var(--line)); color: var(--done); }
  .pipeline .step.current { border-color: var(--accent); color: var(--accent); font-weight: 600; background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .pipeline .arrow { color: var(--muted); font-size: 11px; }
  .next { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .next span { font-size: 12px; color: var(--muted); }
  .next code { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); padding: 2px 6px; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  tr:last-child td { border-bottom: 0; }
  code, .mono { font-family: var(--mono); font-size: 12px; }
  .timeline td.time { white-space: nowrap; color: var(--muted); font-family: var(--mono); font-size: 12px; }
  .timeline td.type { white-space: nowrap; font-weight: 500; }
  .timeline details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
  .timeline pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; color: var(--muted); }
  .muted { color: var(--muted); }
  @media (max-width: 800px) {
    #app { grid-template-columns: 1fr; }
    aside { position: static; max-height: none; border-right: 0; border-bottom: 1px solid var(--line); }
  }
</style>
</head>
<body>
<div id="app">
  <aside>
    <header>
      <h1>Keel</h1>
      <span class="count" id="count"></span>
    </header>
    <div class="toolbar">
      <button id="refresh" type="button">刷新</button>
      <label><input type="checkbox" id="auto" checked /> 自动刷新 5s</label>
      <span id="pulse" class="muted"></span>
    </div>
    <ul id="task-list"></ul>
  </aside>
  <main id="detail">
    <div class="empty">正在加载…</div>
  </main>
</div>
<script>
(function () {
  var state = { tasks: [], meta: null, selectedId: null, timer: null };
  var MAIN_PATH = [
    'S-NEW', 'S-PM_ANALYZING', 'S-BRAINSTORM', 'S-RFC_DRAFT', 'S-RFC_READY',
    'S-DEVELOPING', 'S-QA', 'S-REVIEW', 'S-PR_OPEN', 'S-DONE'
  ];

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString();
  }
  function shortId(id) { return id ? String(id).slice(0, 8) : '—'; }

  function statusKind(status) {
    if (status === 'S-DONE') return 'done';
    if (status === 'S-FAILED' || status === 'S-REJECTED' || status === 'S-ABANDONED') return 'bad';
    if (!state.meta) return 'stage';
    if (state.meta.statuses.stage.indexOf(status) >= 0) return 'stage';
    if (state.meta.statuses.gate.indexOf(status) >= 0) return 'gate';
    return 'stage';
  }
  function badge(status) {
    return '<span class="badge ' + statusKind(status) + '"><span class="dot"></span>' + esc(status) + '</span>';
  }

  function fetchJSON(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
      return r.json();
    });
  }

  function renderTasks() {
    var list = document.getElementById('task-list');
    var html = '';
    for (var i = 0; i < state.tasks.length; i++) {
      var t = state.tasks[i];
      html += '<li data-id="' + esc(t.id) + '" class="' + (t.id === state.selectedId ? 'active' : '') + '">' +
        '<span class="title">' + esc(t.title) + '</span>' +
        '<span class="meta">' + badge(t.status) +
        '<span>' + esc(shortId(t.id)) + '</span>' +
        '<span>' + esc(fmtTime(t.updated_at)) + '</span></span></li>';
    }
    list.innerHTML = html || '<li class="muted">没有任务</li>';
    document.getElementById('count').textContent = state.tasks.length + ' 个任务';
  }

  function renderPipeline(status) {
    var html = '<div class="pipeline">';
    var reached = true;
    var onMain = MAIN_PATH.indexOf(status) >= 0;
    for (var i = 0; i < MAIN_PATH.length; i++) {
      var s = MAIN_PATH[i];
      var cls = 'step';
      if (s === status) cls += ' current';
      else if (reached) cls += ' done';
      if (s === status) reached = false;
      html += '<span class="' + cls + '">' + esc(s) + '</span>';
      if (i < MAIN_PATH.length - 1) html += '<span class="arrow">→</span>';
    }
    html += '</div>';
    if (!onMain) {
      html += '<div class="next"><span>当前不在主路径：</span>' + badge(status) + '</div>';
    }
    var nexts = [];
    if (state.meta) {
      for (var j = 0; j < state.meta.transitions.length; j++) {
        var tr = state.meta.transitions[j];
        if (tr.from === status) nexts.push(tr);
      }
    }
    if (nexts.length) {
      html += '<div class="next"><span>可能的下一次转移：</span>';
      for (var k = 0; k < nexts.length; k++) {
        var n = nexts[k];
        html += '<code title="' + esc(n.guardText) + '">' + esc(n.id) + ' → ' + esc(n.to) +
          ' <span class="muted">(' + esc(n.on.join('/')) + ')</span></code>';
      }
      html += '</div>';
    }
    return html;
  }

  function renderDetail(d) {
    var t = d.task;
    var html = '<h2>' + esc(t.title) + '</h2>';
    html += '<div class="sub">' + badge(t.status) +
      '<span>control_mode: <b>' + esc(t.control_mode) + '</b></span>' +
      '<span>task: <code>' + esc(t.id) + '</code></span>' +
      '<span>repo: <code>' + esc(t.repo) + '</code></span>' +
      '<span>branch: <code>' + esc(t.work_branch) + '</code> → <code>' + esc(t.base_branch || 'main') + '</code></span>' +
      '<span>created: ' + esc(fmtTime(t.created_at)) + '</span>' +
      '<span>updated: ' + esc(fmtTime(t.updated_at)) + '</span>' +
      (t.terminal_at ? '<span>terminal: ' + esc(fmtTime(t.terminal_at)) + '</span>' : '') +
      (t.risk ? '<span>risk: <b>' + esc(t.risk) + '</b></span>' : '') +
      (t.complexity ? '<span>complexity: <b>' + esc(t.complexity) + '</b></span>' : '') +
      '</div>';

    html += '<div class="card"><h3>流程</h3>' + renderPipeline(t.status) + '</div>';

    html += '<div class="card"><h3>Runs (' + d.runs.length + ')</h3>';
    if (d.runs.length === 0) html += '<div class="muted">没有 run</div>';
    else {
      html += '<table><thead><tr><th>stage</th><th>attempt</th><th>status</th><th>harness</th><th>started</th><th>ended</th></tr></thead><tbody>';
      for (var i = 0; i < d.runs.length; i++) {
        var r = d.runs[i];
        html += '<tr><td><code>' + esc(r.stage) + '</code></td><td>' + esc(r.attempt) + '</td><td>' +
          esc(r.status) + (r.error_kind ? ' <span class="muted">(' + esc(r.error_kind) + ')</span>' : '') +
          '</td><td>' + esc(r.harness_id || '—') + '</td><td class="muted">' + esc(fmtTime(r.started_at)) +
          '</td><td class="muted">' + esc(fmtTime(r.ended_at)) + '</td></tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';

    html += '<div class="card"><h3>产物 (' + d.artifacts.length + ')</h3>';
    if (d.artifacts.length === 0) html += '<div class="muted">没有产物</div>';
    else {
      for (var a = 0; a < d.artifacts.length; a++) {
        var art = d.artifacts[a];
        html += '<details><summary><code>' + esc(art.kind) + '</code>' +
          (art.key ? ' <code>' + esc(art.key) + '</code>' : '') +
          ' v' + esc(art.version) + ' <span class="muted">' + esc(fmtTime(art.committed_at)) + '</span></summary>' +
          '<pre class="mono">' + esc(JSON.stringify(art.body, null, 2)) + '</pre></details>';
      }
    }
    html += '</div>';

    html += '<div class="card"><h3>事件 (' + d.events.length + ')</h3>';
    if (d.events.length === 0) html += '<div class="muted">没有事件</div>';
    else {
      html += '<table class="timeline"><thead><tr><th>seq</th><th>时间</th><th>类型</th><th>payload</th></tr></thead><tbody>';
      for (var e = 0; e < d.events.length; e++) {
        var ev = d.events[e];
        html += '<tr><td class="mono">' + esc(ev.seq) + '</td><td class="time">' + esc(fmtTime(ev.occurred_at)) +
          '</td><td class="type">' + esc(ev.type) + '</td><td><details><summary>' +
          esc(JSON.stringify(ev.payload).slice(0, 120)) + '</summary><pre>' +
          esc(JSON.stringify(ev.payload, null, 2)) + '</pre></details></td></tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';

    document.getElementById('detail').innerHTML = html;
  }

  function loadTasks() {
    return fetchJSON('/api/tasks').then(function (data) {
      state.tasks = data.tasks;
      renderTasks();
      return data;
    });
  }

  function loadDetail(id) {
    return fetchJSON('/api/tasks/' + encodeURIComponent(id)).then(function (data) {
      if (state.selectedId !== id) return;
      renderDetail(data);
    }).catch(function (err) {
      if (state.selectedId !== id) return;
      document.getElementById('detail').innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
    });
  }

  function select(id) {
    state.selectedId = id;
    renderTasks();
    document.getElementById('detail').innerHTML = '<div class="empty">加载中…</div>';
    loadDetail(id);
  }

  function refreshAll() {
    var pulse = document.getElementById('pulse');
    pulse.textContent = '…';
    loadTasks().then(function () {
      if (!state.selectedId && state.tasks.length > 0) {
        state.selectedId = state.tasks[0].id;
        renderTasks();
      }
      if (state.selectedId) return loadDetail(state.selectedId);
    }).then(function () {
      pulse.textContent = '刚刚 ' + new Date().toLocaleTimeString();
    }).catch(function (err) {
      pulse.textContent = '失败：' + err.message;
    });
  }

  function setAuto(on) {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (on) state.timer = setInterval(function () {
      if (document.hidden) return;
      refreshAll();
    }, 5000);
  }

  document.getElementById('task-list').addEventListener('click', function (ev) {
    var li = ev.target.closest('li[data-id]');
    if (li) select(li.getAttribute('data-id'));
  });
  document.getElementById('refresh').addEventListener('click', refreshAll);
  document.getElementById('auto').addEventListener('change', function (ev) { setAuto(ev.target.checked); });

  fetchJSON('/api/meta').then(function (meta) {
    state.meta = meta;
    return refreshAll();
  }).catch(function (err) {
    document.getElementById('detail').innerHTML = '<div class="empty">无法连接 keel 控制台：' + esc(err.message) + '</div>';
  });
  setAuto(true);
})();
</script>
</body>
</html>
`
