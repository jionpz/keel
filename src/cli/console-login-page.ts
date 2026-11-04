/**
 * keel 控制台登录页 —— 单文件 HTML（内联 CSS / JS，无构建、无外部资源）。
 *
 * 与 `console-page.ts` 同一套「冷纸 / 墨 / 单一信号色」的调色板，但布局独立：
 * 登录页不加载任何事实数据，也不复用控制台主页面。
 * 改主色时两处一起改（`console-page.ts` 的 :root 与这里的 :root）。
 */

/**
 * 页面模板里的令牌占位符。与控制台主页面共用同一个常量语义：
 * 服务端在 `GET /login` 时把本次进程的随机令牌替换进来，登录 POST 必须带上
 * `X-Keel-Console` 头（见 `console.ts` 的 `writeRejection`）。
 */
export const CONSOLE_LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="keel-console-token" content="__KEEL_CONSOLE_TOKEN__" />
<meta name="robots" content="noindex, nofollow" />
<title>登录 · Keel 工程运行时控制台</title>
<style>
  :root {
    color-scheme: light dark;
    /* 与 console-page.ts 的 :root 保持同一组值。 */
    --paper: #edf0f2;
    --panel: #f8f9fa;
    --panel-2: #ffffff;
    --code-bg: #e8ecef;
    --ink: #12181d;
    --ink-2: #3e4a52;
    --ink-3: #64707a;
    --rule: rgba(18, 24, 29, 0.14);
    --rule-strong: rgba(18, 24, 29, 0.30);
    --hover: rgba(18, 24, 29, 0.04);
    --signal: #a65a00;
    --signal-wash: rgba(166, 90, 0, 0.08);
    --bad: #8e2f2b;
    --grid: rgba(18, 24, 29, 0.045);
    --shadow: rgba(18, 24, 29, 0.38);
    --inset: rgba(255, 255, 255, 0.55);
    --mono: "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    --sans: "Avenir Next", "Avenir", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #10161b;
      --panel: #151c21;
      --panel-2: #1a2228;
      --code-bg: #0c1216;
      --ink: #e7edf1;
      --ink-2: #b3bfc7;
      --ink-3: #7f8c95;
      --rule: rgba(231, 237, 241, 0.13);
      --rule-strong: rgba(231, 237, 241, 0.26);
      --hover: rgba(231, 237, 241, 0.05);
      --signal: #e0a05c;
      --signal-wash: rgba(224, 160, 92, 0.12);
      --bad: #d97a72;
      --grid: rgba(231, 237, 241, 0.04);
      --shadow: rgba(0, 0, 0, 0.62);
      --inset: rgba(255, 255, 255, 0.04);
    }
  }

  * { box-sizing: border-box; }

  html, body { height: 100%; }

  body {
    margin: 0;
    display: grid;
    place-items: center;
    padding: 28px 20px;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  /* 海图底纹：极淡的方格 + 中心信号色晕染。 */
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    background-image:
      linear-gradient(var(--grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 32px 32px;
    -webkit-mask-image: radial-gradient(78% 68% at 50% 42%, #000 28%, transparent 100%);
    mask-image: radial-gradient(78% 68% at 50% 42%, #000 28%, transparent 100%);
  }

  body::after {
    content: "";
    position: fixed;
    left: 0;
    right: 0;
    bottom: -12%;
    height: 58%;
    pointer-events: none;
    background: radial-gradient(52% 58% at 50% 100%, var(--signal-wash), transparent 72%);
  }

  .card {
    position: relative;
    width: 100%;
    max-width: 424px;
    padding: 30px 32px 22px;
    background: var(--panel-2);
    border: 1px solid var(--rule-strong);
    border-radius: 14px;
    box-shadow:
      var(--inset) 0 1px 0 inset,
      0 28px 70px -40px var(--shadow);
    animation: rise 0.42s ease both;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .glyph {
    width: 22px;
    height: 28px;
    flex: none;
    color: var(--ink);
  }

  .brand-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .wordmark {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.28em;
    line-height: 1;
  }

  .tagline {
    font-size: 10.5px;
    letter-spacing: 0.1em;
    color: var(--ink-3);
    text-transform: uppercase;
  }

  h1 {
    margin: 26px 0 6px;
    font-size: 23px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.25;
  }

  .lede {
    margin: 0;
    font-size: 13px;
    line-height: 1.75;
    color: var(--ink-2);
  }

  .field-label {
    display: block;
    margin: 24px 0 8px;
    font-size: 12px;
    letter-spacing: 0.05em;
    color: var(--ink-3);
  }

  .field { position: relative; }

  #password {
    width: 100%;
    height: 46px;
    padding: 0 66px 0 14px;
    border: 1px solid var(--rule-strong);
    border-radius: 9px;
    background: var(--panel);
    color: var(--ink);
    font-family: var(--mono);
    font-size: 15px;
    letter-spacing: 0.08em;
    outline: none;
    transition: border-color 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
  }

  #password:focus {
    border-color: var(--signal);
    background: var(--panel-2);
    box-shadow: 0 0 0 3px var(--signal-wash);
  }

  #password[aria-invalid="true"] { border-color: var(--bad); }

  .reveal {
    position: absolute;
    right: 7px;
    top: 50%;
    transform: translateY(-50%);
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--ink-3);
    font: 12px var(--sans);
    cursor: pointer;
    transition: color 0.14s ease, background 0.14s ease;
  }

  .reveal:hover { color: var(--ink); background: var(--hover); }

  .reveal:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }

  .remember {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 14px 0 0;
    font-size: 12.5px;
    color: var(--ink-2);
    cursor: pointer;
    user-select: none;
  }

  .remember input {
    width: 15px;
    height: 15px;
    margin: 0;
    accent-color: var(--ink);
    cursor: pointer;
  }

  .submit {
    width: 100%;
    height: 46px;
    margin-top: 20px;
    border: 0;
    border-radius: 9px;
    background: var(--ink);
    color: var(--paper);
    font: 600 14px var(--sans);
    letter-spacing: 0.08em;
    cursor: pointer;
    transition: opacity 0.16s ease, transform 0.08s ease;
  }

  .submit:hover:not(:disabled) { opacity: 0.9; }
  .submit:active:not(:disabled) { transform: translateY(1px); }
  .submit:disabled { opacity: 0.55; cursor: progress; }
  .submit:focus-visible { outline: 2px solid var(--signal); outline-offset: 3px; }

  .error {
    display: block;
    min-height: 18px;
    margin: 12px 0 0;
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--bad);
  }

  .foot {
    margin-top: 22px;
    padding-top: 15px;
    border-top: 1px solid var(--rule);
    font-size: 11.5px;
    line-height: 1.8;
    color: var(--ink-3);
  }

  .foot code {
    font-family: var(--mono);
    font-size: 10.8px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--code-bg);
    color: var(--ink-2);
  }

  @keyframes rise {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }

  @keyframes shake {
    10%, 90% { transform: translateX(-1px); }
    20%, 80% { transform: translateX(2px); }
    30%, 50%, 70% { transform: translateX(-3px); }
    40%, 60% { transform: translateX(3px); }
  }

  .card.shake { animation: shake 0.34s ease; }

  @media (prefers-reduced-motion: reduce) {
    .card, .card.shake { animation: none; }
    .submit { transition: none; }
  }

  @media (max-width: 440px) {
    body { padding: 20px 14px; }
    .card { padding: 24px 20px 18px; border-radius: 12px; }
    h1 { font-size: 21px; }
  }
</style>
</head>
<body>
<main class="shell">
  <section class="card" aria-labelledby="login-title">
    <div class="brand">
      <svg class="glyph" viewBox="0 0 14 18" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <path d="M1 2V10.4L4.4 15.8h5.2L13 10.4V6.2" stroke-linejoin="miter"/>
      </svg>
      <div class="brand-text">
        <span class="wordmark">KEEL</span>
        <span class="tagline">AI Engineering Runtime</span>
      </div>
    </div>

    <h1 id="login-title">登录控制台</h1>
    <p class="lede">这是一个受保护的观测面。请输入启动终端提供的访问口令。</p>

    <form id="login-form" novalidate>
      <label class="field-label" for="password">访问口令</label>
      <div class="field">
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          required
          autofocus
          aria-describedby="error"
        />
        <button id="reveal" class="reveal" type="button" aria-pressed="false">显示</button>
      </div>

      <label class="remember" for="remember">
        <input id="remember" name="remember" type="checkbox" />
        保持登录 7 天
      </label>

      <button id="submit" class="submit" type="submit">进入控制台</button>
      <span id="error" class="error" role="alert" aria-live="polite"></span>
    </form>

    <p class="foot">
      口令来自启动 <code>pnpm run console</code> 的终端输出；固定口令可设置
      <code>KEEL_CONSOLE_PASSWORD</code>。<br />
      会话只保存在本次进程内，控制台重启后需要重新登录。
    </p>
  </section>
</main>
<script>
(function () {
  var form = document.getElementById('login-form');
  var input = document.getElementById('password');
  var submit = document.getElementById('submit');
  var error = document.getElementById('error');
  var reveal = document.getElementById('reveal');
  var remember = document.getElementById('remember');
  var meta = document.querySelector('meta[name="keel-console-token"]');
  var token = meta ? meta.getAttribute('content') || '' : '';
  var busy = false;

  function setError(text) {
    error.textContent = text || '';
    input.setAttribute('aria-invalid', text ? 'true' : 'false');
    if (text) {
      form.classList.remove('shake');
      void form.offsetWidth;
      form.classList.add('shake');
    }
  }

  reveal.addEventListener('click', function () {
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    reveal.textContent = show ? '隐藏' : '显示';
    reveal.setAttribute('aria-pressed', show ? 'true' : 'false');
    input.focus();
  });

  input.addEventListener('input', function () {
    if (error.textContent) setError('');
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    var password = input.value;
    if (!password) {
      setError('请输入访问口令');
      input.focus();
      return;
    }

    busy = true;
    submit.disabled = true;
    submit.textContent = '验证中…';
    setError('');

    fetch('/api/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-keel-console': token
      },
      body: JSON.stringify({ password: password, remember: remember.checked })
    }).then(function (res) {
      if (res.ok) {
        window.location.replace('/');
        return;
      }
      return res.json().catch(function () {
        return {};
      }).then(function (body) {
        if (res.status === 429) {
          var wait = res.headers.get('retry-after');
          setError(wait
            ? '尝试过于频繁，请在 ' + wait + ' 秒后重试'
            : '尝试过于频繁，请稍后再试');
          return;
        }
        setError(body && body.error ? body.error : '登录失败（HTTP ' + res.status + '）');
      });
    }).catch(function () {
      setError('无法连接控制台，请确认服务仍在运行');
    }).then(function () {
      busy = false;
      submit.disabled = false;
      submit.textContent = '进入控制台';
    });
  });
})();
</script>
</body>
</html>
`
