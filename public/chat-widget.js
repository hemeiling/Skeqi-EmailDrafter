/* ═══════════════════════════════════════════════════════════════════════════
   The SKQ AI Assistant panel.

   A floating button and a panel, mounted in the shell rather than in any one
   view — Booth Map and Account Research are iframes, so anything inside them
   would disappear when you switch screens, and anything per-view would need
   mounting eight times.

   Responsive by breakpoint, not by measurement:

     ≥1024px   a resizable rail down the right. The page is DOCKED beside it,
               not covered: .app-main gains a right margin the same width, so
               dragging the rail wider narrows the workspace instead of hiding
               it. One custom property drives both, which is why they cannot
               drift apart.
     <1024px   a sheet over the page, 100dvh so the mobile keyboard does not
               push the composer off the bottom of the screen. Not resizable —
               there is nothing to resize it against.

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
  :root {
    --skq-ai-bottom: 20px;
    /* The rail's width, and the gap the page leaves for it. Both derive from
       one value so the panel and the workspace cannot disagree — the reason
       this is a property rather than a number in two places. --skq-ai-dock is
       0 unless the panel is actually docked, so the page reflows only when
       there is something to reflow around. */
    --skq-ai-width: 400px;
    --skq-ai-dock: 0px;
    --skq-ai-gap: 16px;
  }

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
  /* The shell styles every <button> with white-space: nowrap, which is right
     for its toolbar and wrong for a 340px conversation panel: the suggestion
     chips are buttons, so their text ran off the edge and took the panel's
     horizontal scrollbar with it. Overridden here, for this panel only —
     relaxing the global rule would change every toolbar in the application to
     fix one that is not broken. */
  .skq-ai-panel button { white-space: normal; }
  .skq-ai-panel, .skq-ai-panel * { overflow-wrap: anywhere; }
  /* Nothing inside the panel may scroll it sideways. A backstop, not the fix:
     the wrapping above is the fix, and this makes a future regression visible
     as wrapped text rather than as a scrollbar nobody notices. */
  .skq-ai-log { overflow-x: hidden; }
  .skq-ai-panel[data-open="true"] { display: flex; }

  /* Phone and tablet: a sheet over the page. dvh, so an open keyboard shrinks
     the panel rather than hiding its input. */
  @media (max-width: 1023px) {
    .skq-ai-panel {
      inset: 0; width: 100%; height: 100dvh; max-height: 100dvh; border-radius: 0;
    }
  }
  /* Desktop: a rail, clear of the sidebar, and resizable from its left edge. */
  @media (min-width: 1024px) {
    .skq-ai-panel {
      top: var(--skq-ai-gap); right: var(--skq-ai-gap); bottom: var(--skq-ai-bottom);
      width: var(--skq-ai-width);
      /* Belt and braces against overflow: the drag is clamped in JS, and the
         layout refuses to exceed the viewport even if a stored width from a
         wider screen says otherwise. */
      max-width: calc(100vw - (var(--skq-ai-gap) * 2));
      border-radius: 16px; overflow: hidden;
    }
  }

  /* The workspace makes room rather than being covered. Applied to the shell's
     own containers, so it follows the sidebar's existing margin model instead
     of a second, competing set of offsets. */
  body.skq-ai-docked .app-main { margin-right: var(--skq-ai-dock); }
  body.skq-ai-docked #usage-bar { right: var(--skq-ai-dock); }

  /* The shell compacts its top bar below an 860px VIEWPORT. That is the right
     rule and the wrong measure once a docked panel takes 400-650px of that
     viewport away: the workspace can be narrower than 860 on a 1440px screen,
     and the full-size bar then overflows and hides its own controls.

     Same declarations, applied when the WORKSPACE — not the window — is that
     narrow. The class is set from JS because CSS cannot yet ask how wide a
     sibling is; the threshold and the rules are the shell's own. */
  body.skq-ai-tight .app-topbar-title,
  body.skq-ai-tight .app-usage-pill span.pill-label { display: none; }
  .app-main { transition: margin-right .18s ease, margin-left .18s ease; }
  @media (prefers-reduced-motion: reduce) { .app-main { transition: none; } }

  /* The drag handle. Wide enough to hit, quiet enough to ignore — it only
     draws itself on hover, focus or while dragging. */
  .skq-ai-grip {
    position: absolute; left: 0; top: 0; bottom: 0; width: 12px;
    cursor: col-resize; z-index: 2; display: none;
    background: transparent; border: 0; padding: 0;
    touch-action: none;
  }
  @media (min-width: 1024px) { .skq-ai-grip { display: block; } }
  .skq-ai-grip::before {
    content: ''; position: absolute; left: 5px; top: 50%; transform: translateY(-50%);
    width: 2px; height: 36px; border-radius: 2px; background: #CFC6E4;
    opacity: 0; transition: opacity .15s ease;
  }
  .skq-ai-grip:hover::before, .skq-ai-grip:focus-visible::before { opacity: 1; }
  .skq-ai-grip:focus-visible { outline: 2px solid var(--color-primary, #4E2A84); outline-offset: -2px; }
  body.skq-ai-resizing { cursor: col-resize; user-select: none; }
  body.skq-ai-resizing .skq-ai-grip::before { opacity: 1; }
  /* While dragging, the page must not animate after the pointer. */
  body.skq-ai-resizing .app-main { transition: none; }

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

  /* Bottom-aligned, so Send stays put as the textarea grows upward instead of
     stretching into a tall slab beside it. */
  .skq-ai-form {
    flex: none; display: flex; align-items: flex-end; gap: 8px;
    padding: 12px; border-top: 1px solid #E9E5F2; background: #fff;
  }
  .skq-ai-input {
    flex: 1 1 auto;
    /* One line plus padding, and no more, until there is something to show.
       min-height is what the old composer got wrong: a fixed 44px box clipped
       a placeholder that wrapped to two lines at panel width, which reads as a
       rendering bug rather than a hint. The box now starts at exactly one line
       and grows with the content. */
    min-height: 0;
    max-height: var(--skq-ai-composer-max, 160px);
    padding: 11px 13px;
    border: 1px solid #DDD6EC; border-radius: 11px;
    font: inherit; font-size: 0.875rem; line-height: 1.5;
    resize: none;
    /* Switched to auto by the autosize pass once the content passes the cap;
       hidden below it, so no scrollbar flickers on a one-line composer. */
    overflow-y: hidden;
    /* Chinese and mixed CJK/Latin wrap mid-string rather than widening. */
    overflow-wrap: anywhere; word-break: normal;
  }
  :root { --skq-ai-composer-max: 160px; }
  /* Shorter viewports cannot spare 160px: on a phone with the keyboard open
     the log would be reduced to a sliver. */
  @media (max-height: 700px), (max-width: 767px) { :root { --skq-ai-composer-max: 120px; } }
  .skq-ai-input:focus { outline: 2px solid var(--color-primary, #4E2A84); outline-offset: -1px; }
  .skq-ai-send {
    flex: none; min-width: 44px; height: 44px; padding: 0 16px;
    border: 0; border-radius: 11px; cursor: pointer;
    background: var(--color-primary, #4E2A84); color: #fff; font-weight: 600; font-size: 0.85rem;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .skq-ai-send:disabled { opacity: .45; cursor: default; }
  .skq-ai-send .skq-ai-send-icon { display: none; font-size: 1.05rem; line-height: 1; }
  /* Narrow phones: the label goes, the target does not. Squeezing the
     textarea instead would cost a character every time. */
  @media (max-width: 400px) {
    .skq-ai-send { min-width: 44px; width: 44px; padding: 0; }
    .skq-ai-send .skq-ai-send-text { display: none; }
    .skq-ai-send .skq-ai-send-icon { display: inline; }
  }

  /* ── history ──────────────────────────────────────────────────────────────
     A drawer over the conversation rather than a column beside it: the rail is
     340-650px, and a permanent list would leave the chat itself too narrow to
     read. Same element on both breakpoints — on a phone it is simply the whole
     sheet, which is where a full-height list belongs anyway. */
  .skq-ai-drawer {
    position: absolute; inset: 0; z-index: 3; display: none;
    flex-direction: column; background: #fff;
  }
  .skq-ai-drawer[data-open="true"] { display: flex; }
  .skq-ai-drawer-head {
    flex: none; display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; border-bottom: 1px solid #E9E5F2;
  }
  .skq-ai-search {
    flex: 1 1 auto; min-width: 0; height: 40px; padding: 0 12px;
    border: 1px solid #DDD6EC; border-radius: 10px; font: inherit; font-size: 0.85rem;
  }
  .skq-ai-search:focus { outline: 2px solid var(--color-primary, #4E2A84); outline-offset: -1px; }
  .skq-ai-drawer-list { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding: 8px; }

  .skq-ai-thread {
    display: flex; align-items: flex-start; gap: 6px;
    padding: 9px 10px; margin-bottom: 4px; border-radius: 10px; cursor: pointer;
    border: 1px solid transparent;
  }
  .skq-ai-thread:hover { background: #F8F5FD; border-color: #E4DEF2; }
  .skq-ai-thread[data-active="true"] { background: #F4F0FA; border-color: #CFC0EC; }
  .skq-ai-thread-main { flex: 1 1 auto; min-width: 0; }
  .skq-ai-thread-title {
    font-size: 0.84rem; font-weight: 600; color: #2F2545; line-height: 1.35;
    /* Two lines, then an ellipsis: a title is a label, not a paragraph. */
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .skq-ai-thread-meta { font-size: 0.68rem; color: #8B84A0; margin-top: 2px; }
  .skq-ai-thread-snip { font-size: 0.7rem; color: #6B6480; margin-top: 3px; line-height: 1.35;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .skq-ai-thread-acts { flex: none; display: flex; gap: 2px; }
  .skq-ai-tact {
    width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px;
    background: transparent; color: #8B84A0; cursor: pointer; font-size: 0.85rem; line-height: 1;
  }
  .skq-ai-tact:hover { background: #EFE9FA; color: #4E2A84; }
  /* Touch has no hover, so the actions are always present there — a control
     that only appears on hover is a control a phone cannot reach. */
  @media (hover: hover) and (pointer: fine) {
    .skq-ai-thread-acts { opacity: 0; transition: opacity .12s ease; }
    .skq-ai-thread:hover .skq-ai-thread-acts,
    .skq-ai-thread:focus-within .skq-ai-thread-acts { opacity: 1; }
  }

  .skq-ai-headbtn {
    background: rgba(255,255,255,.16); border: 0; color: #fff; cursor: pointer;
    height: 36px; min-width: 36px; padding: 0 10px; border-radius: 9px;
    font-size: 0.78rem; font-weight: 600; display: inline-flex; align-items: center; gap: 5px;
  }
  .skq-ai-headbtn:hover { background: rgba(255,255,255,.28); }
  .skq-ai-headacts { display: flex; align-items: center; gap: 6px; }

  .skq-ai-drawer-empty { padding: 24px 14px; text-align: center; color: #8B84A0; font-size: 0.82rem; }

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
  var history = [];        // {role, content} — what is on screen
  var pageContext = null;  // set by the bridge, or by the shell on view change
  var busy = false;
  var suggestions = [];

  var threadId = null;     // null until the first answer creates one
  var threads = [];
  var searchTimer = null;
  /* Half-written questions, per thread, kept while the panel is open.
     Switching conversations to check something and losing what you had typed
     is the kind of small betrayal that stops people using a feature. The
     unsaved thread parks under the key 'new'. */
  var drafts = {};

  function draftKey() { return threadId == null ? 'new' : String(threadId); }
  function stashDraft() { drafts[draftKey()] = el.input ? el.input.value : ''; }
  function restoreDraft() {
    if (!el.input) return;
    el.input.value = drafts[draftKey()] || '';
    autosize();
  }

  /* ── the rail's width ─────────────────────────────────────────────────────
     One source of truth, clamped in one place. The clamp is a function of the
     viewport rather than a constant, so a width stored on a 2560px monitor
     cannot reopen off-screen on a laptop — it is re-clamped every time it is
     applied, not only when it is dragged. */
  var WIDTH_KEY = 'skq-ai-width';
  var MIN_W = 340;
  var MAX_W = 650;
  var DOCK_BP = 1024;

  function isDesktop() { return window.innerWidth >= DOCK_BP; }

  function widthBounds() {
    /* Three ceilings, lowest wins.

       650px because a chat column wider than that stops being easier to read.
       45% of the viewport, so the workspace always keeps the majority. And the
       room actually left over once the shell's top-bar controls have what they
       need — measured, not assumed, because that width depends on the sidebar
       being collapsed, on which labels the shell has hidden at this breakpoint,
       and on how long the signed-in user's name is.

       That third ceiling is the one that matters: the first draft of this had
       only the other two, and a panel dragged to its "legal" maximum sat on top
       of the profile menu and the AI usage pill. A control you cannot reach is
       not a cosmetic problem. */
    var max = Math.min(MAX_W, Math.round(window.innerWidth * 0.45));

    /* The third ceiling: the room actually left once the shell's own top bar
       has what it needs. Measured, because that depends on whether the sidebar
       is collapsed, which labels this breakpoint has hidden, and how long the
       signed-in user's name is. Only applied while docking — a floating panel
       covers the page by design and is not competing for space. */
    if (hasRoomToDock()) {
      var room = window.innerWidth - sidebarWidth() - topbarNeeds() - 32;
      if (isFinite(room)) max = Math.min(max, room);
    }

    /* The floor still wins if all of that leaves less than a readable panel:
       on a small laptop the honest answer is that the two cannot both fit, and
       a 200px assistant would be useless to everyone. */
    return { min: MIN_W, max: Math.max(MIN_W, max) };
  }

  function clampWidth(px) {
    var b = widthBounds();
    return Math.max(b.min, Math.min(b.max, Math.round(px)));
  }

  function storedWidth() {
    try {
      var v = parseInt(localStorage.getItem(WIDTH_KEY), 10);
      return isFinite(v) && v > 0 ? v : 400;
    } catch (e) { return 400; }   // private mode, blocked storage — never fatal
  }

  var widthPx = 400;

  function applyWidth(px, persist) {
    widthPx = clampWidth(px);
    var root = document.documentElement;
    root.style.setProperty('--skq-ai-width', widthPx + 'px');
    if (el.grip) {
      var b = widthBounds();
      el.grip.setAttribute('aria-valuenow', String(widthPx));
      el.grip.setAttribute('aria-valuemin', String(b.min));
      el.grip.setAttribute('aria-valuemax', String(b.max));
    }
    syncDock();
    if (persist) { try { localStorage.setItem(WIDTH_KEY, String(widthPx)); } catch (e) { /* ignore */ } }
  }

  /**
   * Docks or undocks the workspace.
   *
   * Only when the panel is open AND there is room to dock — below 1024px the
   * panel is a full-screen sheet, and reserving a margin for it would push the
   * page sideways under a panel that already covers it.
   */
  var TIGHT_BP = 860;      // the shell's own compaction threshold

  /** The width the shell's top bar cannot go below, measured from the DOM. */
  function topbarNeeds() {
    var main = document.querySelector('.app-main');
    var topbar = main && main.querySelector('.app-topbar');
    if (!topbar) return 0;
    var cs = getComputedStyle(topbar);
    var gap = parseFloat(cs.columnGap || cs.gap) || 16;
    var need = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    for (var i = 0; i < topbar.children.length; i++) {
      var kid = topbar.children[i];
      // The title and breadcrumb truncate; everything else holds its size.
      if (kid.classList.contains('app-topbar-title')
        || kid.classList.contains('app-breadcrumb')) continue;
      need += kid.scrollWidth + gap;
    }
    return need;
  }

  function sidebarWidth() {
    var main = document.querySelector('.app-main');
    return main ? Math.round(main.getBoundingClientRect().left) : 0;
  }

  /** Is there room for the narrowest useful panel AND the shell's controls? */
  function hasRoomToDock() {
    return window.innerWidth - sidebarWidth() - MIN_W - 32 >= topbarNeeds();
  }

  function syncDock() {
    var open = isDesktop() && el.panel && el.panel.getAttribute('data-open') === 'true';

    /* Docking is only offered when the workspace can still hold the shell's
       controls beside it. Below roughly 1150px it cannot — a 340px panel plus
       a full sidebar plus the top bar simply do not fit on a 1024px screen —
       and the panel goes back to floating above the page, which is how it has
       always behaved. Reflowing the workspace into a width its own toolbar
       overflows would bury the profile menu under the panel and call it a
       feature. Not oscillating on this matters: the decision is made from the
       sidebar's width as it already is, never from a width this function
       would then go on to change. */
    var on = open && hasRoomToDock();
    document.body.classList.toggle('skq-ai-docked', on);
    var dock = on ? widthPx + 32 : 0;
    document.documentElement.style.setProperty('--skq-ai-dock', dock + 'px');

    // What the workspace is actually left with, sidebar included.
    var main = document.querySelector('.app-main');
    var sidebar = main ? Math.round(main.getBoundingClientRect().left) : 0;
    var workspace = window.innerWidth - sidebar - dock;
    document.body.classList.toggle('skq-ai-tight', on && workspace < TIGHT_BP);
  }

  /* ── the composer ─────────────────────────────────────────────────────────
     Grows with its content up to the cap set in CSS, then scrolls inside
     itself. The cap is READ from the stylesheet rather than repeated here:
     it changes with viewport height, and a JS copy would be wrong on exactly
     the screens where it matters. */
  function autosize() {
    var t = el.input;
    if (!t) return;
    var cs = getComputedStyle(t);
    var max = parseFloat(cs.maxHeight);
    if (!isFinite(max)) max = 160;

    /* scrollHeight is content + padding and stops there. `height` under
       border-box also has to cover the border, so assigning one to the other
       leaves the box short by exactly the border width — two pixels, enough to
       shave the descenders off the last line at every size. The old composer
       did this, which is most of why text looked clipped. */
    var borders = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);

    t.style.height = 'auto';
    var needed = t.scrollHeight + borders;
    t.style.height = Math.min(needed, max) + 'px';
    // Only once there is genuinely more than fits, so no scrollbar flickers
    // in and out of a one-line composer as it is typed into.
    t.style.overflowY = needed > max ? 'auto' : 'hidden';
  }

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
    el.newBtn = h('button', 'skq-ai-headbtn');
    el.newBtn.type = 'button';
    el.newBtn.title = 'New chat 新对话';
    el.newBtn.setAttribute('aria-label', 'New chat');
    el.newBtn.innerHTML = '<span aria-hidden="true">＋</span><span>New</span>';
    el.newBtn.addEventListener('click', function () { newThread(true); });

    el.histBtn = h('button', 'skq-ai-headbtn');
    el.histBtn.type = 'button';
    el.histBtn.title = 'Chat history 历史对话';
    el.histBtn.setAttribute('aria-label', 'Chat history');
    el.histBtn.innerHTML = '<span aria-hidden="true">☰</span>';
    el.histBtn.addEventListener('click', function () { toggleDrawer(); });

    el.close = h('button', 'skq-ai-close', '✕');
    el.close.type = 'button';
    el.close.setAttribute('aria-label', 'Close');
    el.close.addEventListener('click', close);

    var acts = h('div', 'skq-ai-headacts');
    acts.appendChild(el.newBtn);
    acts.appendChild(el.histBtn);
    acts.appendChild(el.close);
    head.appendChild(titles);
    head.appendChild(acts);

    el.ctx = h('div', 'skq-ai-ctx');
    el.log = h('div', 'skq-ai-log');
    el.log.setAttribute('role', 'log');
    el.log.setAttribute('aria-live', 'polite');

    el.form = h('form', 'skq-ai-form');
    el.input = h('textarea', 'skq-ai-input');
    el.input.rows = 1;
    /* Short enough to sit on ONE line in the narrowest composer we support —
       a 340px rail, minus the Send button. The previous placeholder wrapped to
       two or three lines inside a one-line box and was cut in half, which
       reads as a rendering bug rather than a hint. The full description still
       greets an empty panel, where there is room for it. */
    el.input.placeholder = 'Ask about booths, companies…';
    el.input.setAttribute('aria-label', 'Ask the assistant');
    el.send = h('button', 'skq-ai-send');
    el.send.type = 'submit';
    el.send.setAttribute('aria-label', 'Send');
    var sendText = h('span', 'skq-ai-send-text', 'Send');
    var sendIcon = h('span', 'skq-ai-send-icon', '↑');
    sendIcon.setAttribute('aria-hidden', 'true');
    el.send.appendChild(sendText);
    el.send.appendChild(sendIcon);

    /* Enter sends, Shift+Enter is a newline — on anything with a real keyboard.
       Keyed to the pointing device rather than to the viewport width, which is
       what it used to test: a 1200px tablet got Enter-to-send it could not use
       comfortably, and a small laptop window lost it for no reason. On a touch
       keyboard Enter stays a newline and Send sends, which is what every phone
       chat app does, including the one this is modelled on. */
    el.input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      e.preventDefault();
      el.form.requestSubmit();
    });
    el.input.addEventListener('input', autosize);
    el.form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });

    el.form.appendChild(el.input);
    el.form.appendChild(el.send);

    /* A real focusable control, not a decorated div: dragging is a pointer
       gesture, and a pointer gesture with no keyboard equivalent is a feature
       some people simply cannot use. Arrows nudge, Home/End jump to the
       bounds. */
    el.grip = h('button', 'skq-ai-grip');
    el.grip.type = 'button';
    el.grip.setAttribute('role', 'separator');
    el.grip.setAttribute('aria-orientation', 'vertical');
    el.grip.setAttribute('aria-label', 'Resize assistant panel');
    el.grip.setAttribute('tabindex', '0');
    attachResize(el.grip);

    /* Named "Chat History", never "my chats": the login gate validates one
       shared credential today, so this history belongs to the workspace and
       everyone signed in sees the same conversations. Calling it private
       would be a promise the authentication cannot keep. */
    el.drawer = h('div', 'skq-ai-drawer');
    el.drawer.setAttribute('role', 'region');
    el.drawer.setAttribute('aria-label', 'Chat history');
    var dhead = h('div', 'skq-ai-drawer-head');
    el.search = h('input', 'skq-ai-search');
    el.search.type = 'search';
    el.search.placeholder = 'Search chats 搜索对话';
    el.search.setAttribute('aria-label', 'Search chat history');
    el.search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadThreads, 220);     // typing is not a query per keystroke
    });
    var dclose = h('button', 'skq-ai-tact', '✕');
    dclose.type = 'button';
    dclose.setAttribute('aria-label', 'Close history');
    dclose.addEventListener('click', function () { toggleDrawer(false); });
    dhead.appendChild(el.search);
    dhead.appendChild(dclose);
    el.list = h('div', 'skq-ai-drawer-list');
    el.drawer.appendChild(dhead);
    el.drawer.appendChild(el.list);

    el.panel.appendChild(el.grip);
    el.panel.appendChild(head);
    el.panel.appendChild(el.drawer);
    el.panel.appendChild(el.ctx);
    el.panel.appendChild(el.log);
    el.panel.appendChild(el.form);

    document.body.appendChild(el.fab);
    document.body.appendChild(el.panel);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || el.panel.getAttribute('data-open') !== 'true') return;
      // The drawer is on top, so it is what Escape means first.
      if (el.drawer.getAttribute('data-open') === 'true') return toggleDrawer(false);
      close();
    });
  }

  /**
   * Drag-to-resize, from the panel's left edge.
   *
   * Width is derived from the pointer's distance to the right edge of the
   * viewport rather than from a delta accumulated across moves, so a dropped
   * frame or a pointer that leaves the window cannot desynchronise the panel
   * from the cursor. Pointer capture keeps the gesture alive over the iframes
   * — Booth Map and Account Research would otherwise swallow the move events
   * the moment the cursor crossed into them.
   */
  function attachResize(grip) {
    var dragging = false;

    function widthFromPointer(clientX) {
      // The rail's right edge sits --skq-ai-gap in from the viewport edge.
      var gap = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--skq-ai-gap')) || 16;
      return (window.innerWidth - gap) - clientX;
    }

    grip.addEventListener('pointerdown', function (e) {
      if (!isDesktop()) return;
      dragging = true;
      document.body.classList.add('skq-ai-resizing');
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
      e.preventDefault();
    });

    grip.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      applyWidth(widthFromPointer(e.clientX), false);
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('skq-ai-resizing');
      try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      applyWidth(widthPx, true);          // persist only once, at the end
    }
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);

    grip.addEventListener('keydown', function (e) {
      if (!isDesktop()) return;
      var b = widthBounds();
      var step = e.shiftKey ? 48 : 16;
      var next = null;
      if (e.key === 'ArrowLeft') next = widthPx + step;     // left edge left = wider
      else if (e.key === 'ArrowRight') next = widthPx - step;
      else if (e.key === 'Home') next = b.min;
      else if (e.key === 'End') next = b.max;
      if (next == null) return;
      e.preventDefault();
      applyWidth(next, true);
    });

    // Double-click restores the default, the usual escape hatch for a
    // splitter dragged somewhere unhelpful.
    grip.addEventListener('dblclick', function () { applyWidth(400, true); });
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
    toggleDrawer(false);
    restoreDraft();
    syncDock();
    autosize();
    setTimeout(function () { el.input.focus(); }, 60);
  }

  function close() {
    stashDraft();            // reopening finds the half-written question intact
    el.panel.setAttribute('data-open', 'false');
    el.fab.hidden = false;
    syncDock();              // give the workspace its width back
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

  function bubble(who, text, sources) {
    var row = h('div', 'skq-ai-msg');
    row.setAttribute('data-who', who);
    var b = h('div', 'skq-ai-bubble', text);
    /* Sources, not function names. "consulted:
       list_companies_by_category, list_companies_by_category, ..." told a
       salesperson nothing they could act on and leaked our internals into the
       conversation. What matters to them is whether the answer came from the
       official exhibitor list or from our own CRM. */
    if (sources && sources.length) {
      b.appendChild(h('div', 'skq-ai-consulted',
        (zh() ? '来源：' : 'Sources: ') + sources.join(' · ')));
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
    autosize();
    bubble('user', text);
    history.push({ role: 'user', content: text });
    setBusy(true);
    var pending = thinking();

    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        /* Only the new question travels once a thread exists — the server
           reads the rest from its own record. The browser's copy is a
           rendering of the conversation, not the record of it. */
        body: JSON.stringify({
          messages: threadId ? [{ role: 'user', content: text }] : history,
          thread_id: threadId,
          pageContext: pageContext,
        }),
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
        /* The question goes back in the composer. Losing what someone typed
           because a provider was briefly unreachable is not an acceptable
           outcome, and retyping it is the only alternative. */
        el.input.value = text;
        autosize();
        return;
      }
      bubble('ai', data.reply, data.sources || []);
      history.push({ role: 'assistant', content: data.reply });
      // The first answer is what creates the conversation, so adopt its id.
      if (data.thread_id) threadId = data.thread_id;
      delete drafts[draftKey()];
    } catch (err) {
      pending.remove();
      bubble('error', zh() ? '网络错误，请重试。' : 'Network error. Please try again.');
      history.pop();
      el.input.value = text;
      autosize();
    } finally {
      setBusy(false);
      el.input.focus();
    }
  }

  /* ── conversations ────────────────────────────────────────────────────────
     The drawer is a view of the server's record, not a second copy of it.
     Nothing here caches a thread body: reopening one fetches it, so a
     conversation continued on a phone reads correctly on a laptop. */

  /* The same mapping the server uses, applied to a reopened conversation —
     stored messages keep the internal names, so history reads the same as a
     live answer without re-asking the server to translate them. */
  var SOURCE_LABELS = {
    get_event_attendance_summary: 'Official Exhibitor Data',
    check_event_attendance: 'Official Exhibitor Data',
    get_booth_occupant: 'Official Exhibitor Data',
    find_available_booths: 'Booth Map',
    list_companies_by_category: 'Booth Map',
    search_companies: 'CRM', get_company_profile: 'CRM', get_company_contacts: 'CRM',
    find_gaps: 'CRM', summarize_account_activity: 'CRM',
    get_account_research: 'Account Research',
    get_communication_history: 'Email Activity', get_latest_draft: 'Email Activity',
  };
  function sourcesFor(names) {
    var out = [];
    (names || []).forEach(function (n) {
      var label = SOURCE_LABELS[n];
      if (label && out.indexOf(label) === -1) out.push(label);
    });
    return out;
  }

  function toggleDrawer(force) {
    var on = force == null ? el.drawer.getAttribute('data-open') !== 'true' : Boolean(force);
    el.drawer.setAttribute('data-open', on ? 'true' : 'false');
    if (on) { loadThreads(); setTimeout(function () { el.search.focus(); }, 50); }
    else { el.input.focus(); }
  }

  function whenLabel(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return zh() ? '刚刚' : 'just now';
    if (mins < 60) return mins + (zh() ? ' 分钟前' : 'm ago');
    if (mins < 60 * 24) return Math.round(mins / 60) + (zh() ? ' 小时前' : 'h ago');
    return d.toLocaleDateString();
  }

  async function loadThreads() {
    var q = (el.search.value || '').trim();
    el.list.textContent = '';
    try {
      var res = await fetch('/api/chat/threads?' + new URLSearchParams(q ? { q: q } : {}));
      var data = await res.json();
      threads = (data && data.threads) || [];
    } catch (e) {
      el.list.appendChild(h('div', 'skq-ai-drawer-empty',
        zh() ? '无法加载历史对话。' : 'Could not load chat history.'));
      return;
    }
    renderThreads(q);
  }

  function renderThreads(q) {
    el.list.textContent = '';
    if (!threads.length) {
      el.list.appendChild(h('div', 'skq-ai-drawer-empty', q
        ? (zh() ? '没有匹配的对话。' : 'No conversations match that.')
        : (zh() ? '还没有历史对话。' : 'No conversations yet.')));
      return;
    }
    threads.forEach(function (t) {
      var row = h('div', 'skq-ai-thread');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      if (String(t.id) === String(threadId)) row.setAttribute('data-active', 'true');

      var main = h('div', 'skq-ai-thread-main');
      main.appendChild(h('div', 'skq-ai-thread-title', t.title || (zh() ? '未命名对话' : 'Untitled chat')));
      main.appendChild(h('div', 'skq-ai-thread-meta',
        whenLabel(t.last_message_at || t.updated_at)
        + ' · ' + (t.message_count || 0) + (zh() ? ' 条' : ' msgs')));
      if (t.snippet) main.appendChild(h('div', 'skq-ai-thread-snip', t.snippet));

      var acts = h('div', 'skq-ai-thread-acts');
      var mk = function (glyph, label, fn) {
        var b = h('button', 'skq-ai-tact', glyph);
        b.type = 'button';
        b.title = label;
        b.setAttribute('aria-label', label + ': ' + (t.title || 'untitled'));
        b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
        return b;
      };
      acts.appendChild(mk('✎', zh() ? '重命名' : 'Rename', function () { renameThread(t); }));
      acts.appendChild(mk('🗄', zh() ? '归档' : 'Archive', function () { archiveThread(t); }));
      acts.appendChild(mk('🗑', zh() ? '删除' : 'Delete', function () { removeThread(t); }));

      row.appendChild(main);
      row.appendChild(acts);
      var go = function () { openThread(t.id); };
      row.addEventListener('click', go);
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
      el.list.appendChild(row);
    });
  }

  async function openThread(id) {
    stashDraft();                       // keep what was typed in the one we are leaving
    try {
      var res = await fetch('/api/chat/threads/' + encodeURIComponent(id));
      if (!res.ok) throw new Error('http ' + res.status);
      var data = await res.json();
      threadId = data.thread.id;
      history = (data.messages || []).map(function (m) {
        return { role: m.role, content: m.content, sources: sourcesFor(m.tools_used) };
      });
      el.log.textContent = '';
      if (!history.length) renderEmpty();
      history.forEach(function (m) {
        bubble(m.role === 'user' ? 'user' : 'ai', m.content, m.sources);
      });
      el.log.scrollTop = el.log.scrollHeight;
      toggleDrawer(false);
      restoreDraft();
    } catch (e) {
      bubble('error', zh() ? '无法打开该对话。' : 'Could not open that conversation.');
      toggleDrawer(false);
    }
  }

  function newThread(focus) {
    stashDraft();
    threadId = null;
    history = [];
    renderEmpty();
    toggleDrawer(false);
    restoreDraft();
    if (focus) setTimeout(function () { el.input.focus(); }, 40);
  }

  async function renameThread(t) {
    var next = window.prompt(zh() ? '重命名对话' : 'Rename conversation', t.title || '');
    if (next == null) return;
    next = next.trim();
    if (!next) return;
    try {
      var res = await fetch('/api/chat/threads/' + encodeURIComponent(t.id), {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: next }),
      });
      if (!res.ok) throw new Error('http ' + res.status);
      t.title = next;
      renderThreads((el.search.value || '').trim());
    } catch (e) { loadThreads(); }
  }

  async function archiveThread(t) {
    try {
      await fetch('/api/chat/threads/' + encodeURIComponent(t.id), {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      });
    } finally {
      // Archiving the conversation on screen leaves you on a fresh one.
      if (String(t.id) === String(threadId)) newThread(false);
      loadThreads();
    }
  }

  async function removeThread(t) {
    var name = t.title || (zh() ? '这个对话' : 'this conversation');
    if (!window.confirm(zh() ? ('删除「' + name + '」？') : ('Delete "' + name + '"?'))) return;
    try {
      await fetch('/api/chat/threads/' + encodeURIComponent(t.id), { method: 'DELETE' });
    } finally {
      if (String(t.id) === String(threadId)) newThread(false);
      loadThreads();
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
    applyWidth(storedWidth(), false);
    measureBottomBar();
    /* Re-clamped on resize, not only on drag: a width chosen on a wide monitor
       has to be brought back inside the bounds of a narrower one, and crossing
       the 1024px breakpoint has to dock or undock the workspace. */
    window.addEventListener('resize', function () { applyWidth(widthPx, false); autosize(); });
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

  window.skqChat = { open: open, close: close, setContext: setContext,
    newThread: newThread, openThread: openThread, toggleHistory: toggleDrawer };
}());
