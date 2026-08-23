/* ═══════════════════════════════════════════════════════════════════════════
   The SKQ AI Assistant panel.

   A floating button and a panel, mounted in the shell rather than in any one
   view — Booth Map and Account Research are iframes, so anything inside them
   would disappear when you switch screens, and anything per-view would need
   mounting eight times.

   Responsive by breakpoint, not by measurement:

     ≥1024px   a 400px rail down the right, page still readable beside it
     <1024px   a sheet over the page, 100dvh so the mobile keyboard does not
               push the composer off the bottom of the screen

   `dvh` rather than `vh` is the whole trick on phones: `100vh` is the viewport
   with the URL bar hidden, so a `vh`-sized panel puts its input under the
   keyboard the moment one opens.

   Talks to POST /api/chat. Knows nothing about models, providers or keys.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var STYLE = `
  /* --skq-ai-bottom clears the fixed #usage-bar at the foot of the shell.
     Measured at runtime rather than hardcoded: the bar wraps to two or three
     rows on a phone, so any constant is wrong at some width. Falls back to a
     plain margin where the bar does not exist. */
  :root { --skq-ai-bottom: 20px; }

  .skq-ai-fab {
    position: fixed; right: 20px; bottom: var(--skq-ai-bottom); z-index: 900;
    display: flex; align-items: center; gap: 8px;
    /* 44px is the smallest comfortable touch target; the pill is taller. */
    min-height: 48px; padding: 0 18px;
    border: 0; border-radius: 999px; cursor: pointer;
    background: var(--color-primary, #4E2A84); color: #fff;
    font-size: 0.9rem; font-weight: 600; letter-spacing: .01em;
    box-shadow: 0 6px 20px rgba(78,42,132,.32);
    transition: transform .15s ease, box-shadow .15s ease;
  }
  .skq-ai-fab:hover { transform: translateY(-1px); box-shadow: 0 8px 26px rgba(78,42,132,.4); }
  .skq-ai-fab:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
  .skq-ai-fab[hidden] { display: none; }

  .skq-ai-panel {
    position: fixed; z-index: 950; display: none;
    flex-direction: column; background: #fff;
    box-shadow: 0 10px 40px rgba(16,12,32,.28);
  }
  .skq-ai-panel[data-open="true"] { display: flex; }

  /* Phone and tablet: a sheet over the page. dvh, so an open keyboard shrinks
     the panel rather than hiding its input. */
  @media (max-width: 1023px) {
    .skq-ai-panel {
      inset: 0; width: 100%; height: 100dvh; max-height: 100dvh; border-radius: 0;
    }
  }
  /* Desktop: a rail, clear of the sidebar. */
  @media (min-width: 1024px) {
    .skq-ai-panel {
      top: 16px; right: 16px; bottom: var(--skq-ai-bottom);
      width: 400px; max-width: calc(100vw - 32px);
      border-radius: 16px; overflow: hidden;
    }
  }

  .skq-ai-head {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 14px 16px; background: var(--color-primary, #4E2A84); color: #fff; flex: none;
  }
  .skq-ai-title { font-size: 0.95rem; font-weight: 600; }
  .skq-ai-sub { font-size: 0.72rem; opacity: .78; margin-top: 1px; }
  .skq-ai-close {
    background: rgba(255,255,255,.16); border: 0; color: #fff; cursor: pointer;
    width: 44px; height: 44px; border-radius: 10px; font-size: 1.1rem; line-height: 1;
  }
  .skq-ai-close:hover { background: rgba(255,255,255,.28); }

  .skq-ai-ctx {
    flex: none; padding: 7px 16px; font-size: 0.74rem;
    background: #F4F0FA; color: #4E2A84; border-bottom: 1px solid #E7DFF5;
    display: none; align-items: center; gap: 6px;
  }
  .skq-ai-ctx[data-on="true"] { display: flex; }

  .skq-ai-log { flex: 1 1 auto; overflow-y: auto; padding: 16px; background: #FBFAFD; }
  .skq-ai-msg { margin-bottom: 14px; display: flex; }
  .skq-ai-msg[data-who="user"] { justify-content: flex-end; }
  .skq-ai-bubble {
    max-width: 86%; padding: 10px 13px; border-radius: 14px;
    font-size: 0.875rem; line-height: 1.5;
    /* Long booth lists and URLs must wrap, not widen the panel. */
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .skq-ai-msg[data-who="user"] .skq-ai-bubble { background: var(--color-primary, #4E2A84); color: #fff; border-bottom-right-radius: 5px; }
  .skq-ai-msg[data-who="ai"] .skq-ai-bubble { background: #fff; border: 1px solid #E9E5F2; border-bottom-left-radius: 5px; }
  .skq-ai-msg[data-who="error"] .skq-ai-bubble { background: #FEF2F2; border: 1px solid #FCA5A5; color: #991B1B; }

  .skq-ai-consulted { font-size: 0.68rem; color: #8B84A0; margin-top: 5px; }

  .skq-ai-empty { padding: 6px 2px; }
  .skq-ai-empty p { font-size: 0.85rem; color: #6B6480; margin: 0 0 12px; line-height: 1.5; }
  .skq-ai-chip {
    display: block; width: 100%; text-align: left; margin-bottom: 8px;
    padding: 11px 13px; min-height: 44px;
    background: #fff; border: 1px solid #E4DEF2; border-radius: 11px;
    font-size: 0.82rem; color: #3D2A5C; cursor: pointer; line-height: 1.4;
  }
  .skq-ai-chip:hover { border-color: var(--color-primary, #4E2A84); background: #F8F5FD; }

  .skq-ai-form { flex: none; display: flex; gap: 8px; padding: 12px; border-top: 1px solid #E9E5F2; background: #fff; }
  .skq-ai-input {
    flex: 1; min-height: 44px; max-height: 120px; padding: 11px 13px;
    border: 1px solid #DDD6EC; border-radius: 11px; font: inherit; font-size: 0.875rem;
    resize: none; line-height: 1.4;
  }
  .skq-ai-input:focus { outline: 2px solid var(--color-primary, #4E2A84); outline-offset: -1px; }
  .skq-ai-send {
    flex: none; min-width: 44px; min-height: 44px; padding: 0 16px;
    border: 0; border-radius: 11px; cursor: pointer;
    background: var(--color-primary, #4E2A84); color: #fff; font-weight: 600; font-size: 0.85rem;
  }
  .skq-ai-send:disabled { opacity: .45; cursor: default; }

  .skq-ai-dots span {
    display: inline-block; width: 6px; height: 6px; margin-right: 3px; border-radius: 50%;
    background: #B7AECD; animation: skq-ai-blink 1.2s infinite;
  }
  .skq-ai-dots span:nth-child(2) { animation-delay: .2s; }
  .skq-ai-dots span:nth-child(3) { animation-delay: .4s; }
  @keyframes skq-ai-blink { 0%,80%,100% { opacity:.3 } 40% { opacity:1 } }
  @media (prefers-reduced-motion: reduce) { .skq-ai-dots span { animation: none; } }
  `;

  var el = {};
  var history = [];        // {role, content} — what the server is sent
  var pageContext = null;  // set by the bridge, or by the shell on view change
  var busy = false;
  var suggestions = [];

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function zh() {
    return (document.documentElement.lang || '').indexOf('zh') === 0
      || document.body.classList.contains('lang-zh');
  }

  function build() {
    var style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    el.fab = h('button', 'skq-ai-fab');
    el.fab.type = 'button';
    el.fab.setAttribute('aria-label', 'SKQ AI Assistant');
    /* Bilingual, like the rest of the shell's navigation — the sidebar reads
       "Booth map 展会地图", so an English-only control would be the odd one. */
    el.fab.innerHTML = '<span aria-hidden="true">✨</span>'
      + '<span>AI Assistant</span>'
      + '<span style="opacity:.72;font-weight:500">AI 助手</span>';
    el.fab.hidden = true;                       // shown once the API says it is available
    el.fab.addEventListener('click', open);

    el.panel = h('div', 'skq-ai-panel');
    el.panel.setAttribute('role', 'dialog');
    el.panel.setAttribute('aria-label', 'SKQ AI Assistant');
    el.panel.setAttribute('aria-modal', 'false');

    var head = h('div', 'skq-ai-head');
    var titles = h('div');
    titles.appendChild(h('div', 'skq-ai-title', 'SKQ AI Assistant'));
    titles.appendChild(h('div', 'skq-ai-sub', '展会 · CRM · 研究 · 邮件'));
    el.close = h('button', 'skq-ai-close', '✕');
    el.close.type = 'button';
    el.close.setAttribute('aria-label', 'Close');
    el.close.addEventListener('click', close);
    head.appendChild(titles);
    head.appendChild(el.close);

    el.ctx = h('div', 'skq-ai-ctx');
    el.log = h('div', 'skq-ai-log');
    el.log.setAttribute('role', 'log');
    el.log.setAttribute('aria-live', 'polite');

    el.form = h('form', 'skq-ai-form');
    el.input = h('textarea', 'skq-ai-input');
    el.input.rows = 1;
    /* The full prompt is three lines in a 375px composer and gets clipped
       mid-word, which reads as a bug rather than a hint. The long form is
       still on the empty state above it, where there is room for it. */
    el.input.placeholder = matchMedia('(max-width: 767px)').matches
      ? 'Ask about companies, booths, contacts…'
      : 'Ask about companies, booths, contacts, research, or email activity…';
    el.input.setAttribute('aria-label', 'Ask the assistant');
    el.send = h('button', 'skq-ai-send', 'Send');
    el.send.type = 'submit';

    // Enter sends, Shift+Enter is a newline — but never on a touch keyboard,
    // where Enter is how you get a new line and there is a Send button.
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(max-width: 1023px)').matches) {
        e.preventDefault();
        el.form.requestSubmit();
      }
    });
    el.input.addEventListener('input', function () {
      el.input.style.height = 'auto';
      el.input.style.height = Math.min(el.input.scrollHeight, 120) + 'px';
    });
    el.form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });

    el.form.appendChild(el.input);
    el.form.appendChild(el.send);
    el.panel.appendChild(head);
    el.panel.appendChild(el.ctx);
    el.panel.appendChild(el.log);
    el.panel.appendChild(el.form);

    document.body.appendChild(el.fab);
    document.body.appendChild(el.panel);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && el.panel.getAttribute('data-open') === 'true') close();
    });
  }

  /**
   * Keeps the button clear of the shell's fixed status bar.
   *
   * A screenshot is what caught this: at bottom:20px the button sat on top of
   * #usage-bar and covered its "Reset session" control. Hit-testing had passed
   * — the button wins the z-fight, which is exactly why it was hiding another
   * control rather than being hidden by one.
   */
  function measureBottomBar() {
    var bar = document.getElementById('usage-bar');
    var clearance = 20;
    if (bar) {
      var r = bar.getBoundingClientRect();
      // Only counts when it is actually pinned to the bottom of the viewport.
      if (r.height > 0 && r.bottom >= window.innerHeight - 2) clearance = Math.round(r.height) + 16;
    }
    document.documentElement.style.setProperty('--skq-ai-bottom', clearance + 'px');
  }

  function open() {
    el.panel.setAttribute('data-open', 'true');
    el.fab.hidden = true;
    if (!history.length) renderEmpty();
    setTimeout(function () { el.input.focus(); }, 60);
  }

  function close() {
    el.panel.setAttribute('data-open', 'false');
    el.fab.hidden = false;
  }

  function renderEmpty() {
    el.log.textContent = '';
    var wrap = h('div', 'skq-ai-empty');
    wrap.appendChild(h('p', null, zh()
      ? '询问展位、公司、联系人、账户研究或邮件记录。'
      : 'Ask about booths, companies, contacts, Account Research or email activity.'));
    suggestions.forEach(function (s) {
      var b = h('button', 'skq-ai-chip', zh() ? s.zh : s.en);
      b.type = 'button';
      b.addEventListener('click', function () { el.input.value = zh() ? s.zh : s.en; submit(); });
      wrap.appendChild(b);
    });
    el.log.appendChild(wrap);
  }

  function bubble(who, text, consulted) {
    var row = h('div', 'skq-ai-msg');
    row.setAttribute('data-who', who);
    var b = h('div', 'skq-ai-bubble', text);
    if (consulted && consulted.length) {
      b.appendChild(h('div', 'skq-ai-consulted',
        (zh() ? '查询：' : 'consulted: ') + consulted.join(', ')));
    }
    row.appendChild(b);
    el.log.appendChild(row);
    el.log.scrollTop = el.log.scrollHeight;
    return row;
  }

  function thinking() {
    var row = h('div', 'skq-ai-msg');
    row.setAttribute('data-who', 'ai');
    var b = h('div', 'skq-ai-bubble');
    var dots = h('span', 'skq-ai-dots');
    dots.innerHTML = '<span></span><span></span><span></span>';
    b.appendChild(dots);
    row.appendChild(b);
    el.log.appendChild(row);
    el.log.scrollTop = el.log.scrollHeight;
    return row;
  }

  function setBusy(on) {
    busy = on;
    el.send.disabled = on;
    el.input.disabled = on;
  }

  async function submit() {
    var text = (el.input.value || '').trim();
    if (!text || busy) return;

    if (!history.length) el.log.textContent = '';
    el.input.value = '';
    el.input.style.height = 'auto';
    bubble('user', text);
    history.push({ role: 'user', content: text });
    setBusy(true);
    var pending = thinking();

    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history, pageContext: pageContext }),
      });
      var data = await res.json().catch(function () { return null; });
      pending.remove();

      if (!res.ok || !data || !data.reply) {
        /* Never a permanent spinner, and never a fabricated answer: the panel
           says what failed and leaves the question in the log so it can be
           asked again. */
        bubble('error', (data && data.error)
          || (zh() ? '暂时无法回答，请稍后再试。' : 'The assistant could not answer that. Please try again.'));
        history.pop();
        return;
      }
      bubble('ai', data.reply, data.consulted);
      history.push({ role: 'assistant', content: data.reply });
    } catch (err) {
      pending.remove();
      bubble('error', zh() ? '网络错误，请重试。' : 'Network error. Please try again.');
      history.pop();
    } finally {
      setBusy(false);
      el.input.focus();
    }
  }

  /** What the assistant knows about the current screen, shown so it is not a secret. */
  function setContext(ctx) {
    pageContext = ctx;
    if (!ctx) { el.ctx.setAttribute('data-on', 'false'); return; }
    var bits = [];
    if (ctx.companyName) bits.push(ctx.companyName);
    if (ctx.boothNumber) bits.push((zh() ? '展位 ' : 'Booth ') + ctx.boothNumber);
    if (!bits.length && ctx.view) bits.push(ctx.view);
    if (!bits.length) { el.ctx.setAttribute('data-on', 'false'); return; }
    el.ctx.textContent = (zh() ? '当前：' : 'Context: ') + bits.join(' · ');
    el.ctx.setAttribute('data-on', 'true');
  }

  async function init() {
    if (document.getElementById('skq-ai-mounted')) return;
    var marker = h('div');
    marker.id = 'skq-ai-mounted';
    marker.style.display = 'none';
    document.body.appendChild(marker);

    build();
    measureBottomBar();
    // The bar rewraps as the viewport changes, and its contents change as
    // usage accrues, so this is re-measured rather than read once.
    window.addEventListener('resize', measureBottomBar);
    if (window.ResizeObserver) {
      var bar = document.getElementById('usage-bar');
      if (bar) new ResizeObserver(measureBottomBar).observe(bar);
    }

    try {
      var res = await fetch('/api/chat/config');
      var cfg = await res.json();
      if (!cfg || !cfg.available) return;      // not configured: no button at all
      suggestions = cfg.suggestions || [];
      el.fab.hidden = false;
    } catch (e) {
      // A failed config call means no assistant, not a broken button.
      return;
    }

    // Context from the iframes, through the shared bridge.
    if (window.skqBridge) {
      window.skqBridge.receive(function (type, payload) {
        setContext(type === 'clear' ? null : payload);
      });
    }

    window.skqSetChatContext = setContext;     // the shell sets view context directly
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.skqChat = { open: open, close: close, setContext: setContext };
}());
