/* Apollo Leadership Contact Search — frontend logic.
   Faithfully ported from the original EmailDrafter app.js, with API routes
   updated to the /api/* prefix, plus the new Scan Business Card modal.

   Note: there is intentionally no API key configuration UI here. Apollo and
   Claude keys are loaded on the backend only, from a local .env file (see
   config.js) -- they are never entered, displayed, or editable in the
   browser. Every Apollo/Claude call happens server-side. */

/* ── State ── */
let _currentContacts = [];
let _currentCompanies = [];
let _csvCompanies = [];
let _filteredCsvIndices = [];
let _sender = { name: "", title: "", company: "" };

/* ── Application shell: sidebar nav / view switching / collapse persistence ── */

// Breadcrumb labels follow the sidebar's Chinese naming so the two never
// disagree; the English name is kept alongside for the nav item's tooltip.
const APP_VIEW_LABELS = { home: "首页概览", search: "AI 邮件起草", "booth-map": "展会地图", crm: "CRM 管理", intelligence: "客户情报", "account-research": "账户研究报告", "ai-usage": "数据分析", settings: "设置中心" };

// The Booth Map and Account Report tabs are ported standalone apps rendered in
// iframes. Load each on first open rather than on page load — the map is a
// 565 KB single file and the report tab pulls in four export libraries.
function ensureFrameLoaded(id, src) {
  const f = document.getElementById(id);
  if (f && !f.getAttribute("src")) f.setAttribute("src", src);
}

function showView(name) {
  if (!APP_VIEW_LABELS[name]) return;
  document.querySelectorAll("[data-view]").forEach((el) => {
    el.classList.toggle("view-hidden", el.dataset.view !== name);
  });
  document.querySelectorAll(".app-nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.navView === name);
  });
  document.getElementById("app-breadcrumb-current").textContent = APP_VIEW_LABELS[name];
  // The CRM list view gets the full window; form-shaped views keep the
  // narrower reading column.
  document.body.classList.toggle("view-wide", name === "crm");
  /* The assistant is told which screen is open. Booth Map and Account Research
     refine this further from inside their iframes, via skq-bridge. */
  if (window.skqSetChatContext) {
    try { window.skqSetChatContext(name ? { view: name } : null); } catch (e) { /* widget absent */ }
  }
  if (name === "booth-map") ensureFrameLoaded("bm-frame", "/booth-map/");
  if (name === "account-research") ensureFrameLoaded("ar-frame", "/account-research/");
  if (name === "home") loadDashboard();
  /* Fetching belongs to the view, not to one button that opens it. The
     dashboard was loaded only by the sidebar nav item's own click handler,
     so the three other ways in — the top-bar usage pill, the sidebar token
     meter's "查看详情", the home panel's "查看全部" — showed the view's
     initial markup and never sent a request: a spinner with nothing behind
     it, no network entry and no console error to explain it.

     Deferred one microtask for the reason documented at the init block:
     showView() runs during that block, while `_aiuFeatureFilter` and the
     other module-level `let`s loadAiUsage() reads are still in the temporal
     dead zone several thousand lines below. */
  if (name === "ai-usage") queueMicrotask(loadAiUsage);
  if (name === "crm") initCrmCategoryFilter();
  try { localStorage.setItem("app_active_view", name); } catch (e) { /* ignore (private browsing, etc.) */ }
}

function initAppShell() {
  document.querySelectorAll(".app-nav-item").forEach((item) => {
    item.addEventListener("click", () => showView(item.dataset.navView));
  });

  /* The logo and product name are global Home controls, as in Salesforce,
     HubSpot, Microsoft 365 and Jira. Both are keyboard-operable because
     role="button" promises that: a screen-reader user told "button" and
     given nothing on Enter is worse served than one told nothing at all.

     Views are hidden rather than torn down, and filter state lives in JS,
     so leaving the CRM and coming back preserves the search, filters,
     selection, paging and open tab exactly as they were. */
  const goHome = () => showView("home");
  ["app-brand-home", "app-title-home"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", goHome);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); }
    });
  });
  // Dashboard cards and "查看全部" links are navigation too.
  document.querySelectorAll("[data-goto]").forEach((el) => {
    el.addEventListener("click", () => showView(el.dataset.goto));
  });

  let savedView = "home";
  try { savedView = localStorage.getItem("app_active_view") || "home"; } catch (e) { /* ignore */ }
  showView(APP_VIEW_LABELS[savedView] ? savedView : "home");

  const collapseBtn = document.getElementById("app-sidebar-collapse-btn");
  const collapseIcon = document.getElementById("app-sidebar-collapse-icon");
  function applyCollapsed(collapsed) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    collapseIcon.textContent = collapsed ? "▶" : "◀";
  }
  let savedCollapsed = false;
  try { savedCollapsed = localStorage.getItem("app_sidebar_collapsed") === "true"; } catch (e) { /* ignore */ }
  applyCollapsed(savedCollapsed);
  function toggleCollapsed() {
    const collapsed = !document.body.classList.contains("sidebar-collapsed");
    applyCollapsed(collapsed);
    try { localStorage.setItem("app_sidebar_collapsed", String(collapsed)); } catch (e) { /* ignore */ }
  }
  collapseBtn.addEventListener("click", toggleCollapsed);
  // The top-bar hamburger drives the same state as the footer button.
  document.getElementById("app-menu-btn").addEventListener("click", toggleCollapsed);

  // Both the top-bar pill and the sidebar meter open the usage dashboard.
  // The meter is visible on every screen, so it loads on every screen.
  loadTokenMeter();
  document.getElementById("app-usage-pill").addEventListener("click", () => showView("ai-usage"));
  document.getElementById("app-token-link").addEventListener("click", () => showView("ai-usage"));
  document.getElementById("app-help-btn").addEventListener("click", () => showView("settings"));

  // User-profile menu in the top bar mirrors the sender-profile name/company
  // (already tracked in `_sender`) rather than introducing a separate concept.
  document.getElementById("app-user-menu").addEventListener("click", () => showView("settings"));
}

/* ══════════════════════════════════════════════════════════════════════
   首页概览 · dashboard data
   Every figure is read from a live endpoint. A source that fails or has
   no rows renders "—" / an empty-state line rather than a made-up value.
   ══════════════════════════════════════════════════════════════════════ */

const nf = new Intl.NumberFormat("en-US");
// Deterministic tint per name so the same company keeps the same chip colour.
const DASH_TINTS = ["tint-purple", "tint-blue", "tint-green", "tint-amber", "tint-red"];
function tintFor(s) {
  let h = 0;
  for (let i = 0; i < (s || "").length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return DASH_TINTS[h % DASH_TINTS.length];
}
function initialsOf(s) {
  const parts = String(s || "?").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]).toUpperCase();
}
function relTime(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d)) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  if (mins < 1440) return `${Math.round(mins / 60)} 小时前`;
  if (mins < 10080) return `${Math.round(mins / 1440)} 天前`;
  return d.toLocaleDateString("zh-CN");
}
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}
function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
}
function renderRows(containerId, rows, emptyMsg) {
  const box = document.getElementById(containerId);
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = `<div class="dash-empty">${emptyMsg}</div>`;
    return;
  }
  box.innerHTML = rows.map((r) => `
    <div class="dash-row"${r.goto ? ` data-goto="${r.goto}" style="cursor:pointer"` : ""}>
      <span class="dash-row-avatar ${r.tint}">${escapeHtml(r.initials)}</span>
      <span class="dash-row-body">
        <span class="dash-row-title">${escapeHtml(r.title)}</span>
        <span class="dash-row-meta">${escapeHtml(r.meta)}</span>
      </span>
      ${r.badge ? `<span class="dash-badge ${r.badgeTint}">${escapeHtml(r.badge)}</span>` : ""}
    </div>`).join("");
  box.querySelectorAll("[data-goto]").forEach((el) =>
    el.addEventListener("click", () => showView(el.dataset.goto)));
}

/* The sidebar token meter renders on every screen, but its only loader used
   to be loadDashboard() — which showView() runs for the "home" view alone.
   Open the app on any other view and the meter sat on its markup default of "读取中…"
   forever, having never been asked to load anything. Global chrome needs a
   load of its own, independent of which view happens to be open. */
/* The meter and the home dashboard both want this month's usage, and both
   start at page load, so fetching it twice was two identical round trips for
   one number. One shared in-flight promise instead: whoever asks first
   issues the request, the second gets the same answer. */
let _monthUsagePromise = null;
function monthUsage(force) {
  if (force) _monthUsagePromise = null;
  if (!_monthUsagePromise) {
    _monthUsagePromise = fetchWithTimeout("/api/ai-usage?period=month")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return _monthUsagePromise;
}

async function loadTokenMeter(force) {
  // renderTokenMeter(null) prints "读取失败", which is honest. Anything is
  // better than a spinner that never resolves.
  renderTokenMeter(await monthUsage(force));
}

let _dashLoaded = false;
async function loadDashboard(force) {
  if (_dashLoaded && !force) return;
  _dashLoaded = true;
  setText("dash-user", senderDisplayName() || _connectedEmail || "同事");

  // Each source is independent — one failing must not blank the others.
  const [companies, contacts, reports, usage] = await Promise.all([
    getJSON("/api/companies").catch(() => null),
    getJSON("/api/contacts").catch(() => null),
    getJSON("/account-research/api/reports").catch(() => null),
    monthUsage(),
  ]);

  const cList = (companies && companies.companies) || [];
  const pList = (contacts && contacts.contacts) || [];
  const rList = (reports && reports.reports) || [];

  setText("dash-companies", companies ? nf.format(cList.length) : "—");
  setText("dash-contacts", contacts ? nf.format(pList.length) : "—");
  setText("dash-reports", reports ? nf.format(rList.length) : "—");
  setText("dash-drafts", contacts
    ? nf.format(pList.reduce((n, c) => n + (Number(c.draft_count) || 0), 0)) : "—");

  const k = usage && usage.kpis;
  setText("dash-calls", k ? nf.format(Number(k.requests) || 0) : "—");
  setText("dash-cost", k ? `$${(Number(k.cost_usd) || 0).toFixed(2)}` : "—");

  // ── Recent reports ──
  // NOTE: /account-research/api/reports aliases its columns to camelCase
  // (createdAt, companyName, targetZh) — not the snake_case used elsewhere.
  renderRows("dash-recent-reports", rList.slice(0, 4).map((r) => {
    const name = r.companyName || r.target || "未命名";
    return {
      initials: initialsOf(name), tint: tintFor(name),
      title: r.targetZh ? `${name} · ${r.targetZh}` : name,
      meta: [relTime(r.createdAt), r.seller].filter(Boolean).join(" · "),
      badge: `v${r.version || 1}`, badgeTint: "tint-purple", goto: "account-research",
    };
  }), "还没有生成过报告");

  // ── Recent contacts (newest first) ──
  const recent = pList
    .filter((c) => c.created_at)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 4);
  renderRows("dash-recent-contacts", recent.map((c) => ({
    initials: initialsOf(c.full_name), tint: tintFor(c.company || c.full_name),
    title: c.full_name || "(无姓名)",
    meta: [c.company, c.job_title].filter(Boolean).join(" · ") || relTime(c.created_at),
    badge: Number(c.draft_count) ? `${c.draft_count} 稿` : "",
    badgeTint: "tint-green", goto: "crm",
  })), "还没有联系人");

  // ── Recent AI activity, by feature ──
  const FEATURE_ZH = {
    company_research: ["公司研究", "🏢"], email_draft: ["邮件起草", "✉️"],
    contact_intel: ["联系人情报", "🧭"], product_match: ["产品匹配", "🔗"],
    attachment_rec: ["附件推荐", "📎"], email_classify: ["邮件分类", "🏷️"],
    account_research: ["账户研究", "📄"], other: ["其他", "•"],
  };
  const feats = (usage && usage.by_feature) || [];
  renderRows("dash-recent-ai", feats.slice(0, 4).map((f) => {
    const [zh, icon] = FEATURE_ZH[f.feature] || [f.feature, "•"];
    const reuses = Number(f.reuses) || 0;
    return {
      // An emoji reads better than two CJK glyphs squeezed into a 30px chip.
      initials: icon, tint: tintFor(f.feature),
      title: zh,
      meta: `${nf.format(Number(f.requests) || 0)} 次 · ${nf.format(Number(f.total_tokens) || 0)} tok`
            + (reuses ? ` · 复用 ${reuses}` : ""),
      badge: `$${(Number(f.cost_usd) || 0).toFixed(2)}`,
      badgeTint: "tint-grey", goto: "ai-usage",
    };
  }), "本月还没有 AI 调用");

  renderTokenMeter(usage);
}

// Sidebar token meter. With no monthly budget configured the ring stays empty
// and the card reports raw usage — it must never imply a cap that isn't set.
function renderTokenMeter(usage) {
  const ring = document.getElementById("app-token-ring");
  const st = usage && usage.budget_status;
  const cap = usage && usage.budget && Number(usage.budget.monthly_token_budget) || 0;
  const used = st ? Number(st.month_tokens) || 0 : (usage && usage.kpis ? Number(usage.kpis.total_tokens) || 0 : 0);

  if (!usage) {
    setText("app-token-pct", "—");
    setText("app-token-used", "读取失败");
    setText("app-token-meta", "无法获取用量");
    return;
  }
  if (cap > 0) {
    const pct = Math.min(100, Math.round((used / cap) * 100));
    if (ring) ring.style.setProperty("--pct", pct + "%");
    setText("app-token-pct", pct + "%");
    setText("app-token-used", `${nf.format(used)} / ${nf.format(cap)}`);
    setText("app-token-meta", `剩余额度 ${nf.format(Math.max(0, cap - used))}`);
  } else {
    if (ring) ring.style.setProperty("--pct", "0%");
    setText("app-token-pct", "∞");
    setText("app-token-used", `${nf.format(used)} Tokens`);
    setText("app-token-meta", "本月已用 · 未设上限");
  }
}

// Connected mailbox identity (from /api/email/status); "" until connected.
let _connectedEmail = "";
let _connectedName = "";
// The resolved sender display: connected account name → profile name → "".
function senderDisplayName() { return (_connectedName || (_sender && _sender.name) || "").trim(); }
function updateUserMenuFromSender() {
  const name = senderDisplayName();
  // Identity = display name + connected mailbox, e.g. "Linglu Xie <info@rosalytics.com>".
  // No name configured ⇒ show the email alone (never a placeholder name).
  const label = name
    ? (_connectedEmail ? `${name} <${_connectedEmail}>` : name)
    : (_connectedEmail || "Your Profile");
  document.getElementById("app-user-menu-name").textContent = label;
  document.getElementById("app-user-avatar").textContent = name ? name.trim()[0].toUpperCase() : (_connectedEmail ? _connectedEmail[0].toUpperCase() : "U");
  // The dashboard greeting renders before /api/email/status resolves, so keep
  // it in step with the identity rather than leaving the initial fallback.
  const greet = document.getElementById("dash-user");
  if (greet) greet.textContent = name || _connectedEmail || "同事";
}

/* ── Modal open/close: single helper for every .modal-overlay, replacing
   the ~30 hand-written classList.add/remove("open") call sites that had
   accumulated across each feature added this session. ── */
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("open");
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("open");
}

/* ── Sender profile ── */

async function loadSenderProfile() {
  try {
    const r = await fetch("/api/settings/sender");
    const d = await r.json();
    if (d.ok) {
      _sender = d.sender;
      document.getElementById("sender-name").value = _sender.name || "";
      document.getElementById("sender-title").value = _sender.title || "";
      document.getElementById("sender-company").value = _sender.company || "";
      const ph = document.getElementById("sender-phone"); if (ph) ph.value = _sender.phone || "";
      const wb = document.getElementById("sender-website"); if (wb) wb.value = _sender.website || "";
      // Read-only: the address always follows the connected mailbox.
      const em = document.getElementById("sender-email-display");
      if (em) em.value = _sender.email || "(connect a mailbox in My Email Account)";
      updateUserMenuFromSender();
    }
  } catch (e) { /* silent */ }
}

let _senderSaveTimeout = null;
function saveSender() {
  _sender.name    = document.getElementById("sender-name").value.trim();
  _sender.title   = document.getElementById("sender-title").value.trim();
  _sender.company = document.getElementById("sender-company").value.trim();
  _sender.phone   = document.getElementById("sender-phone")?.value.trim() || "";
  _sender.website = document.getElementById("sender-website")?.value.trim() || "";
  updateUserMenuFromSender();
  clearTimeout(_senderSaveTimeout);
  _senderSaveTimeout = setTimeout(() => {
    fetch("/api/settings/sender", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_sender),
    }).catch(() => {});
  }, 400);
}
["sender-name", "sender-title", "sender-company", "sender-phone", "sender-website"].forEach(id => {
  document.getElementById(id)?.addEventListener("input", saveSender);
});

/* ── CSV / Excel Upload ── */

const uploadZone = document.getElementById("upload-zone");
uploadZone.addEventListener("click", () => document.getElementById("csv-file").click());
uploadZone.addEventListener("dragover", e => { e.preventDefault(); uploadZone.classList.add("drag-over"); });
uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("drag-over"));
uploadZone.addEventListener("drop", handleDrop);
document.getElementById("csv-file").addEventListener("change", function () { handleFileSelect(this); });

function handleDrop(e) {
  e.preventDefault();
  uploadZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) uploadCompanyFile(file);
}

function handleFileSelect(input) {
  if (input.files[0]) uploadCompanyFile(input.files[0]);
}

async function uploadCompanyFile(file) {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx") && !lower.endsWith(".xls") && file.type !== "text/csv") {
    showMessage("Please upload a .csv or .xlsx file.", "warn"); return;
  }
  const zone = document.getElementById("upload-zone");
  zone.innerHTML = '<span class="spinner"></span> Parsing file…';

  const form = new FormData();
  form.append("file", file);
  try {
    const r = await fetch("/api/companies/upload", { method: "POST", body: form });
    const d = await r.json();
    if (!r.ok || d.error) {
      showMessage(d.error || "Upload failed.", "error");
      resetUploadZone();
      return;
    }
    _csvCompanies = d.companies || [];
    showMessage(`Loaded ${d.total} companies from "${escapeHtml(file.name)}".`, "info");
    renderCsvTable(_csvCompanies);
    zone.innerHTML = `
      <input type="file" id="csv-file" accept=".csv,.xlsx,.xls,text/csv">
      <div class="upload-icon">✅</div>
      <div><strong>${escapeHtml(file.name)}</strong> — ${d.total} companies loaded</div>
      <div class="upload-hint"><a href="#" id="upload-different-link">Upload a different file</a></div>`;
    document.getElementById("csv-file").addEventListener("change", function () { handleFileSelect(this); });
    document.getElementById("upload-different-link").addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("csv-file").click();
    });
  } catch (e) {
    showMessage("Upload error: " + e.message, "error");
    resetUploadZone();
  }
}

function resetUploadZone() {
  document.getElementById("upload-zone").innerHTML = `
    <input type="file" id="csv-file" accept=".csv,.xlsx,.xls,text/csv">
    <div class="upload-icon">📋</div>
    <div><strong>Click to browse</strong> or drag-and-drop your CSV/Excel file here</div>
    <div class="upload-hint">Expects columns: <code>英文名</code> (required), <code>优先级</code>, <code>参与机会</code>, <code>联系建议</code>, etc.</div>`;
  document.getElementById("csv-file").addEventListener("change", function () { handleFileSelect(this); });
}

function renderCsvTable(companies, indicesToShow) {
  const panel = document.getElementById("csv-panel");
  const tbody = document.getElementById("csv-tbody");
  const indices = indicesToShow || companies.map((_, i) => i);
  _filteredCsvIndices = indices;

  document.getElementById("csv-count").textContent =
    `${indices.length} of ${companies.length} companies shown — select to search`;

  tbody.innerHTML = indices.map(i => {
    const c = companies[i];
    const stars = c.priority > 0
      ? "⭐".repeat(c.priority)
      : '<span class="priority-0">—</span>';
    return `<tr data-csv-idx="${i}">
      <td class="col-check"><input type="checkbox" class="csv-check" data-idx="${i}" checked></td>
      <td class="col-booth" style="color:#888">${escapeHtml(c.booth)}</td>
      <td class="col-prio"><span class="priority-stars">${stars}</span></td>
      <td><strong>${escapeHtml(c.english_name)}</strong></td>
      <td style="color:#555">${escapeHtml(c.chinese_name)}</td>
      <td style="font-size:0.78rem">${escapeHtml(c.industry)}</td>
      <td class="col-opp">
        <div class="opp-text" title="${escapeHtml(c.opportunity)}">${escapeHtml(c.opportunity) || '—'}</div>
      </td>
      <td>
        <div class="tip-text">${escapeHtml(c.contact_tip) || '—'}</div>
      </td>
    </tr>`;
  }).join("");

  panel.style.display = "block";
}

document.getElementById("filter-3star").addEventListener("click", () => filterCsvByPriority(3));
document.getElementById("filter-2star").addEventListener("click", () => filterCsvByPriority(2));
document.getElementById("filter-all").addEventListener("click", () => filterCsvByPriority(0));
document.getElementById("csv-select-all").addEventListener("change", function () { toggleCsvSelectAll(this); });
document.getElementById("csv-filter-input").addEventListener("input", function () { filterCsvByText(this.value); });

function filterCsvByPriority(minStars) {
  const indices = _csvCompanies
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.priority >= minStars)
    .map(({ i }) => i);
  renderCsvTable(_csvCompanies, indices);
}

function filterCsvByText(term) {
  const t = term.trim().toLowerCase();
  if (!t) { renderCsvTable(_csvCompanies); return; }
  const indices = _csvCompanies
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => [c.english_name, c.chinese_name, c.industry, c.booth].some(v => (v || "").toLowerCase().includes(t)))
    .map(({ i }) => i);
  renderCsvTable(_csvCompanies, indices);
}

function toggleCsvSelectAll(cb) {
  document.querySelectorAll(".csv-check").forEach(c => c.checked = cb.checked);
}

function getSelectedCsvCompanies() {
  const result = [];
  document.querySelectorAll(".csv-check:checked").forEach(cb => {
    const idx = Number(cb.dataset.idx);
    if (_csvCompanies[idx]) result.push(_csvCompanies[idx]);
  });
  return result;
}

/* ── Batch search from company list ── */

document.getElementById("csv-search-btn").addEventListener("click", searchFromCsv);

async function searchFromCsv() {
  const selected = getSelectedCsvCompanies();
  if (!selected.length) { showMessage("Select at least one company using the checkboxes.", "warn"); return; }

  const btn = document.getElementById("csv-search-btn");
  btn.disabled = true; btn.textContent = "Searching…";

  clearMessages();
  _currentContacts = [];
  _currentCompanies = [];
  document.getElementById("results").innerHTML = "";
  document.getElementById("export-bar").style.display = "none";
  document.getElementById("pagination").innerHTML = "";

  const prog = document.getElementById("batch-progress");
  const fill = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");
  prog.style.display = "block";

  const total = selected.length;
  let done = 0;
  const allMessages = [];
  const allSummaries = [];
  const forceRefresh = document.getElementById("force-refresh")?.checked || false;

  for (const company of selected) {
    label.textContent = `Searching ${done + 1} / ${total}: ${company.english_name}…`;
    fill.style.width = Math.round((done / total) * 100) + "%";
    try {
      const r = await fetch("/api/leads/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companies: company.english_name, force: forceRefresh, ...getSearchSettingsPayload() }),
      });
      const d = await r.json();
      if (d.error) {
        allMessages.push(`${company.english_name}: ${d.error}`);
      } else {
        _currentContacts.push(...(d.contacts || []));
        _currentCompanies.push(...(d.companies || [company.english_name]));
        (d.messages || []).forEach(m => allMessages.push(m));
        (d.summaries || []).forEach(s => allSummaries.push(s));
      }
    } catch (e) {
      allMessages.push(`${company.english_name}: network error — ${e.message}`);
    }
    done++;
  }

  fill.style.width = "100%";
  label.textContent = `Done — searched ${total} companies.`;
  setTimeout(() => { prog.style.display = "none"; }, 2000);

  allMessages.forEach(m => showMessage(m, "warn"));
  renderSearchSummary(allSummaries);

  if (_currentContacts.length === 0) {
    showMessage(`No matching leadership contacts found across ${total} companies. Try broader search terms or check your Apollo plan tier.`, "info");
    btn.disabled = false; btn.textContent = "Search Selected";
    refreshUsage();
  } else {
    renderContacts(_currentContacts, _currentCompanies.join(", "));
    renderExportBar(_currentCompanies[0]);
    btn.disabled = false; btn.textContent = "Search Selected";
    await autoProcessContacts();
  }
}

/* ── Search settings: user-controlled Apollo limits + department targeting ──
   Never fetch an unbounded number of Apollo contacts -- the user controls
   how many, per company and overall. */

let _searchDepartmentOptions = [];

function renderSearchSettingsDepartmentCheckboxes() {
  const el = document.getElementById("search-dept-checkboxes");
  if (!el) return;
  _searchDepartmentOptions = _departmentOptions;
  el.innerHTML = _searchDepartmentOptions.map((d) => `
    <label><input type="checkbox" class="search-dept-check" value="${escapeAttr(d.key)}"> ${escapeHtml(d.label)}</label>
  `).join("");
}

function getSearchSettingsPayload() {
  const perCompanyLimit = Number(document.getElementById("search-per-company-limit").value) || 25;
  const maxTotal = Number(document.getElementById("search-max-total").value) || 100;
  const departments = [];
  document.querySelectorAll(".search-dept-check:checked").forEach((cb) => departments.push(cb.value));
  return { perCompanyLimit, maxTotal, departments };
}

/* ── Manual search ── */

document.getElementById("company-input").addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
document.getElementById("search-btn").addEventListener("click", () => doSearch());

async function doSearch() {
  const company = document.getElementById("company-input").value.trim();
  if (!company) { showMessage("Please enter a company name.", "warn"); return; }

  const btn = document.getElementById("search-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Searching…';
  clearMessages();
  document.getElementById("results").innerHTML = "";
  document.getElementById("export-bar").style.display = "none";
  document.getElementById("pagination").innerHTML = "";

  try {
    // Either entry point may set this: the Find-contacts modal (CRM view)
    // or the CSV panel's own checkbox (AI 邮件起草 view).
    const forceRefresh = document.getElementById("crm-force-refresh")?.checked
      || document.getElementById("force-refresh")?.checked || false;
    const r = await fetch("/api/leads/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companies: company, force: forceRefresh, ...getSearchSettingsPayload() }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { showMessage(d.error || "Search failed.", "error"); return; }

    _currentContacts = d.contacts || [];
    _currentCompanies = d.companies || [company];

    (d.messages || []).forEach(m => showMessage(m, "warn"));
    renderSearchSummary(d.summaries);

    // Populate the inline Company Intelligence sub-tabs for the searched companies
    // (DB-first: this only loads saved intelligence, it does not call the AI).
    crmIntelFromSearch(company.split(",").map((s) => s.trim()).filter(Boolean));

    if (d.orgs && d.orgs.length > 0) {
      renderOrgFallback(d.orgs);
    } else if (_currentContacts.length === 0) {
      showMessage("No matching leadership contacts found. Try a different company name or check your Apollo plan.", "info");
    } else {
      renderContacts(_currentContacts, company);
      renderExportBar(company);
      btn.disabled = false; btn.textContent = "Search";
      refreshUsage();
      await autoProcessContacts();
      return;
    }
  } catch (e) {
    showMessage("Network error: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Search";
    refreshUsage();
  }
}

/* ── Render helpers ── */

function renderContacts(contacts, companyLabel) {
  const resultsEl = document.getElementById("results");
  if (!contacts.length) {
    resultsEl.innerHTML = `
      <div class="table-empty-state" data-no-i18n>
        <div class="tes-icon">🔍</div>
        <div class="tes-title">No leadership contacts found</div>
        <div class="tes-hint">Try a different company name, or widen your target departments in Search Settings.</div>
      </div>`;
    return;
  }
  const header = `
    <div class="results-header">
      <div class="results-count">${contacts.length} leadership contact${contacts.length !== 1 ? "s" : ""} found</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <label style="font-size:0.8rem;color:#555;cursor:pointer">
          <input type="checkbox" id="select-all"> Select all
        </label>
        <button class="btn-sm btn-ghost export-selected-btn" data-fmt="xlsx">Excel</button>
        <button class="btn-sm btn-ghost export-selected-btn" data-fmt="csv">CSV</button>
        <button class="btn-sm btn-ghost export-selected-btn" data-fmt="json">JSON</button>
        <button class="btn-sm btn-ghost export-selected-btn" data-fmt="crm">CRM CSV</button>
      </div>
    </div>`;

  const rows = contacts.map((c, i) => {
    const conf = Number(c.confidence) || 0;
    const confClass = conf >= 80 ? "" : conf >= 60 ? "med" : "low";
    const badgeClass = {
      "Executive Sponsor":    "badge-dm",
      "Economic Buyer":       "badge-eb",
      "Technical Evaluator":  "badge-ti",
      "Line Champion":        "badge-ch",
    }[c.relevance] || "badge-dm";
    const sourceBadge = c.source ? `<span class="badge badge-source" style="margin-left:6px;">${escapeHtml(c.source)}</span>` : "";
    let emailCell;
    if (c.email && !c.email.startsWith("(email")) {
      emailCell = `<span id="email-cell-${i}">${escapeHtml(c.email)}</span>`;
    } else if (c.has_email) {
      emailCell = `<span id="email-cell-${i}" class="email-note">(available) <button class="btn-sm btn-reveal reveal-btn" data-idx="${i}">Reveal</button></span>`;
    } else {
      emailCell = `<span id="email-cell-${i}">${c.email ? escapeHtml(c.email) : "N/A"}</span>`;
    }
    const linkedinCell = c.linkedin
      ? `<a class="linkedin-link" href="${escapeHtml(c.linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a>`
      : "—";
    return `<tr data-idx="${i}">
      <td><input type="checkbox" class="row-check" data-idx="${i}"></td>
      <td>${escapeHtml(c.name)}${sourceBadge}</td>
      <td>${escapeHtml(c.title)}</td>
      <td>${escapeHtml(c.department)}</td>
      <td>${escapeHtml(c.company)}</td>
      <td>${emailCell}</td>
      <td>${linkedinCell}</td>
      <td>
        <div class="confidence-bar">
          <div class="conf-track"><div class="conf-fill ${confClass}" style="width:${conf}%"></div></div>
          <span class="conf-num">${conf}</span>
        </div>
      </td>
      <td><span class="badge ${badgeClass}">${escapeHtml(c.relevance)}</span></td>
      <td>${escapeHtml(c.location)}</td>
      <td id="draft-action-${i}">${c.draft_subject
        ? `<button class="btn-sm btn-saved view-draft-btn" data-idx="${i}">View Draft</button>`
        : `<button class="btn-sm btn-primary draft-email-btn" data-idx="${i}">Draft Email</button>`}</td>
    </tr>`;
  }).join("");

  resultsEl.innerHTML = header + `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:32px"></th>
            <th>Name</th><th>Title</th><th>Department</th><th>Company</th>
            <th>Email</th><th>LinkedIn</th><th>Confidence</th><th>Relevance</th>
            <th>Location</th><th>Action</th>
          </tr>
        </thead>
        <tbody data-no-i18n>${rows}</tbody>
      </table>
    </div>`;

  document.getElementById("select-all").addEventListener("change", function () { toggleSelectAll(this); });
  resultsEl.querySelectorAll(".export-selected-btn").forEach(btn => {
    btn.addEventListener("click", () => exportSelected(btn.dataset.fmt));
  });
  resultsEl.querySelectorAll(".draft-email-btn, .view-draft-btn").forEach(btn => {
    btn.addEventListener("click", () => openEmailDraft(Number(btn.dataset.idx)));
  });
  resultsEl.querySelectorAll(".reveal-btn").forEach(btn => {
    btn.addEventListener("click", () => revealEmail(Number(btn.dataset.idx)));
  });
}

function renderOrgFallback(orgs) {
  const rows = orgs.map(o => `<tr>
    <td>${escapeHtml(o.name)}</td><td>${escapeHtml(o.domain)}</td>
    <td>${escapeHtml(o.industry)}</td><td>${escapeHtml(o.founded)}</td>
    <td>${escapeHtml(o.employees)}</td>
  </tr>`).join("");
  document.getElementById("results").innerHTML = `
    <div class="table-wrap">
      <table class="org-table">
        <thead><tr><th>Organization</th><th>Domain</th><th>Industry</th><th>Founded</th><th>Employees (est.)</th></tr></thead>
        <tbody data-no-i18n>${rows}</tbody>
      </table>
    </div>`;
}

function renderExportBar(company) {
  const bar = document.getElementById("export-bar");
  const enc = encodeURIComponent(company);
  document.getElementById("export-buttons").innerHTML = `
    <span style="font-size:12px;color:#555">Full report:</span>
    <a href="/api/export?company=${enc}&format=xlsx">Excel ↓</a>
    <a href="/api/export?company=${enc}&format=json">JSON</a>
    <a href="/api/export?company=${enc}&format=xml">XML</a>
    <a href="/api/export?company=${enc}&format=csv">CSV</a>
    <a href="/api/export-csv?company=${enc}">CRM CSV</a>
    <span class="export-sep">|</span>
    <span style="font-size:12px;color:#555">Selected:</span>
    <button class="export-selected-btn" data-fmt="xlsx">Excel</button>
    <button class="export-selected-btn" data-fmt="csv">CSV</button>
    <button class="export-selected-btn" data-fmt="json">JSON</button>
    <button class="export-selected-btn" data-fmt="crm">CRM CSV</button>`;
  bar.style.display = "block";
  document.getElementById("export-buttons").querySelectorAll(".export-selected-btn").forEach(btn => {
    btn.addEventListener("click", () => exportSelected(btn.dataset.fmt));
  });
}

/* ── Select-all ── */

function toggleSelectAll(cb) {
  document.querySelectorAll(".row-check").forEach(c => c.checked = cb.checked);
}

function getSelectedContacts() {
  const indices = [];
  document.querySelectorAll(".row-check:checked").forEach(cb => indices.push(Number(cb.dataset.idx)));
  return indices.length > 0 ? indices.map(i => _currentContacts[i]) : null;
}

/* ── Export ── */

const CRM_FIELDS = ["name", "title", "company", "department", "email", "linkedin", "confidence", "relevance", "location"];

/* ══════════════════════════════════════════════════════════════════════
   Email reveal · 邮箱补全

   Apollo returns "(email available via Apollo, not returned in payload)"
   instead of an address, so an export made straight from search results is
   full of placeholders and a salesperson has to go back to Apollo and click
   Reveal on every row. This resolves them first, once, and stores the
   result — so every later use (export, drafting, sending, contact detail)
   reads a real address from our own database.

   Cost control, in order:
     · a contact that already has an email is skipped entirely;
     · one Apollo confirmed has none (not_available) is never asked again;
     · the server checks the stored apollo_raw_json before spending a
       request, so many reveals cost nothing.
   Concurrency is capped so a 300-row export doesn't open 300 sockets.
   ══════════════════════════════════════════════════════════════════════ */

const REVEAL_CONCURRENCY = 5;

/* Which contacts a reveal pass should even attempt. This used to return true
   for any contact lacking an address, including ones with no Apollo id —
   which meant the batch made a request per row to be told "nothing to do".
   Rows Apollo cannot help with are now excluded before the pass starts. */
function contactNeedsReveal(c) {
  const email = String(c.email || "");
  const hasReal = email && !email.startsWith("(") && !email.includes("N/A");
  if (hasReal) return false;                                     // free: already stored
  if (c.email_lookup_status === "not_available") return false;   // already answered
  if (!(c.contact_id || c.id)) return false;
  // An Apollo id, or a saved payload that may already contain the address.
  return Boolean(c.apollo_person_id || c.apollo_raw_json);
}

/* Reveals what's missing, reporting progress. Returns a map of
   contactId -> email ('' when Apollo has none) plus tallies for the report. */
async function revealEmailsForContacts(contacts, onProgress) {
  const pending = (contacts || []).filter(contactNeedsReveal);
  const result = { emails: {}, revealed: 0, unavailable: 0, failed: 0, skipped: (contacts || []).length - pending.length };
  if (!pending.length) { if (onProgress) onProgress(0, 0); return result; }

  let done = 0;
  if (onProgress) onProgress(0, pending.length);

  const queue = pending.slice();
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift();
      const id = c.contact_id || c.id;
      try {
        const r = await fetch(`/api/contacts/${id}/enrich-email`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          // The caller has already shown the cost and had it accepted.
          body: JSON.stringify({ allowApollo: true }),
        });
        const d = await r.json();
        const email = d && d.email && !String(d.email).startsWith("(") ? d.email : "";
        result.emails[id] = email;
        if (email) result.revealed++; else result.unavailable++;
        if (d && d.creditsUsed) result.credits = (result.credits || 0) + d.creditsUsed;
      } catch (e) {
        result.failed++;
      }
      done++;
      if (onProgress) onProgress(done, pending.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(REVEAL_CONCURRENCY, pending.length) }, worker));
  return result;
}

/* Small modal-less progress line, shown over the page while revealing. */
function revealProgressUi() {
  let el = document.getElementById("reveal-progress");
  if (!el) {
    el = document.createElement("div");
    el.id = "reveal-progress";
    el.className = "reveal-progress";
    document.body.appendChild(el);
  }
  return {
    show(done, total) {
      el.hidden = false;
      el.innerHTML = `<span class="spinner"></span>
        <span>Revealing emails 正在补全邮箱… <b>${done} / ${total}</b></span>`;
    },
    hide() { el.hidden = true; },
  };
}

/* Reveal, then apply the results onto the in-memory rows so whatever is
   exported or drafted carries the real address rather than a placeholder. */
/* Called before an export or a draft, where a missing address makes the
   output useless. Asks the server what the batch would actually cost, then
   asks the user — because "some of these need a paid reveal" is a decision,
   not an implementation detail. Returns a result with `cancelled` when the
   user declines, so callers can stop rather than ship a half-empty file.

   Addresses already in the CRM — uploads, cards, manual entries, Apollo
   search hits — are used without asking and without charge; they are
   reported as `alreadyStored` so the user can see the paid figure is only
   about the remainder. */
async function revealBeforeUse(contacts, purposeEn = "continue", purposeCn = "继续") {
  const ids = (contacts || []).map((c) => c.contact_id || c.id).filter(Boolean);
  let plan = null;
  try {
    const r = await fetch("/api/contacts/reveal-estimate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    plan = await r.json();
  } catch (e) {
    console.error("reveal-estimate:", e);
  }

  if (plan && plan.estimatedCredits > 0) {
    const ok = await confirmReveal(
      `${plan.needsApollo} of ${plan.total} selected contacts need an Apollo reveal to ${purposeEn}.`
      + `\n${plan.alreadyStored} already have an address stored`
      + `${plan.freeFromPayload ? `, ${plan.freeFromPayload} can be read free from data already saved` : ""}`
      + `${plan.noApolloId ? `, ${plan.noApolloId} cannot be revealed` : ""}.`,
      `${plan.total} 位联系人中有 ${plan.needsApollo} 位需要 Apollo 揭示才能${purposeCn}；`
      + `${plan.alreadyStored} 位已有邮箱`
      + `${plan.freeFromPayload ? `，${plan.freeFromPayload} 位可从已保存数据免费读取` : ""}。`,
      plan.estimatedCredits
    );
    if (!ok) return { emails: {}, revealed: 0, unavailable: 0, failed: 0, skipped: 0, cancelled: true };
  }

  const ui = revealProgressUi();
  const res = await revealEmailsForContacts(contacts, (d, t) => { if (t) ui.show(d, t); });
  ui.hide();
  res.plan = plan;
  (contacts || []).forEach((c) => {
    const id = c.contact_id || c.id;
    if (id in res.emails) {
      c.email = res.emails[id] || "";
      c.email_lookup_status = res.emails[id] ? "found" : "not_available";
    }
  });
  return res;
}

async function exportSelected(fmt) {
  const selected = getSelectedContacts();
  if (!selected) { showMessage("Select at least one contact using the checkboxes.", "warn"); return; }

  // Resolve addresses BEFORE building the file: an export full of
  // "(email available via Apollo…)" costs the user a manual pass through
  // Apollo, which is the whole point of exporting.
  const rev = await revealBeforeUse(selected, "include in the export", "包含在导出中");
  if (rev.cancelled) {
    // Declining the charge cancels the export rather than silently shipping
    // a file full of "Email not available".
    showMessage("Export cancelled — no Apollo credits were used. 已取消导出，未消耗额度。", "info");
    return;
  }
  if (rev.revealed || rev.unavailable || rev.failed) {
    showMessage(
      `Email reveal: ${rev.revealed} revealed, ${rev.unavailable} unavailable from Apollo`
      + `${rev.failed ? `, ${rev.failed} failed` : ""}`
      + `${rev.skipped ? `, ${rev.skipped} already had an address` : ""}. 邮箱补全完成。`,
      rev.failed ? "warn" : "info");
  }

  if (fmt === "xlsx") {
    await downloadPostBlob("/api/export-xlsx", { contacts: selected }, "selected_contacts.xlsx");
    return;
  }
  const hasDrafts = selected.some(c => c.draft_subject);
  const draftCols = hasDrafts ? ["draft_subject", "draft_body", "draft_followup", "draft_rationale"] : [];
  // Provenance travels with the data: a spreadsheet that says an address
  // came from an upload versus an Apollo reveal is auditable later, when
  // nobody remembers which rows cost credits.
  const provCols = ["email_source", "source", "company_source"];
  let content;
  if (fmt === "json") {
    content = JSON.stringify(selected, null, 2);
    downloadFile(content, "selected_contacts.json", "application/json");
  } else if (fmt === "crm") {
    content = toCsvString(selected, [...CRM_FIELDS, ...provCols, ...draftCols]);
    downloadFile(content, "selected_crm.csv", "text/csv");
  } else {
    content = toCsvString(selected, [...CRM_FIELDS, ...provCols, ...draftCols]);
    downloadFile(content, "selected_contacts.csv", "text/csv");
  }
}

async function downloadPostBlob(url, body, filename) {
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) { showMessage("Export failed: " + r.statusText, "error"); return; }
    const blob = await r.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  } catch (e) { showMessage("Export error: " + e.message, "error"); }
}

/* Cell values for the browser-built exports.

   There are two CSV paths in this app — this one, which downloads a file the
   browser assembles, and export.js on the server. They must agree, or the
   same selection exports differently depending on which button produced it:
   a raw "apollo_enrichment" here and "Apollo enrichment" there, a blank email
   here and "Email not available" there. */
function exportCellValue(c, field) {
  const v = c[field];
  if (field === "email") {
    const e = String(v == null ? "" : v).trim();
    if (!e || e.startsWith("(") || e.includes("N/A") || e.toLowerCase().includes("available via apollo")) {
      return "Email not available 邮箱不可用";
    }
    return e;
  }
  if (field === "email_source") return EMAIL_SOURCE_LABELS[c.email_source || (c.email ? "legacy" : "none")] || "";
  if (field === "source") return SOURCE_LABELS[v] || v || "";
  if (field === "company_source") return COMPANY_SOURCE_LABELS[v] || v || "";
  return v;
}

function toCsvString(contacts, fields) {
  const esc = v => {
    const s = String(v == null ? "" : v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [fields.join(","), ...contacts.map(c => fields.map(f => esc(exportCellValue(c, f))).join(","))].join("\r\n");
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── Email drafting modal: real editor + status/version/activity workflow ──
   _modalContact: the recipient the modal is open for.
   _modalComm: the live communications row being edited (null for the
   read-only historical-timeline preview path, which still uses the old
   simple renderDraft()).
   _modalCategories: Draft Library data -- one entry per outreach category
   (from claude.js's DRAFT_MODES), each independently generated/edited/
   deleted. _modalSelectedMode: which category is currently shown.
   _modalRefreshFn: called after any lifecycle action so the underlying
   table (CRM or search-results) re-syncs from the server instead of being
   hand-patched.
   _modalDirty: true once any editable field has changed since the last save. */

let _modalContact = null;
let _modalComm = null;
let _modalCategories = [];
let _modalSelectedMode = "cold_outreach";
let _modalRefreshFn = null;
let _modalDirty = false;

// Add Existing Email (manual import) sub-dialog state
let _aeeFiles = [];
let _aeeLibraryIds = [];

// Attachment Library dialog state -- _libraryPickerCallback set = picker
// mode (checkbox-select, applied on close); null = full management mode.
let _libraryItems = [];
let _libraryPickerCallback = null;
let _libraryPickerSelected = new Set();
let _libraryVersionsKey = null;

function effectiveDraftStatus(comm) {
  if (comm.deleted_at) return "trash";
  if (comm.archived_at) return "archived";
  return comm.status || "draft";
}

async function openEmailDraft(idx) {
  await openDraftModalForContact(_currentContacts[idx], null);
}

// Single entry point for opening the draft modal for any contact, from
// anywhere (CRM table, search-results table, bulk flows). Loads the Draft
// Library (one independent draft per outreach category) and selects
// whichever category already has content, defaulting to Cold Outreach.
async function openDraftModalForContact(contact, refreshFn, options = {}) {
  if (!contact) return;
  _modalContact = contact;
  _modalComm = null;
  _modalCategories = [];
  _modalDirty = false;
  _modalRefreshFn = refreshFn || null;
  document.getElementById("modal-title").textContent = `Draft email to ${contact.name}`;
  document.getElementById("modal-contact-info").textContent =
    `${contact.title || ""} · ${contact.company || ""} · ${contact.department || ""}`;
  document.getElementById("modal-extra-instructions").value = "";
  document.getElementById("modal-extra-instructions").oninput = refreshPromptInspectorSoon;
  // Re-rendered per open so it reflects options changed elsewhere (e.g. in
  // the bulk bar) since this modal was last shown.
  renderDraftOptions(document.getElementById("modal-draft-options"), "modal", refreshPromptInspectorSoon);
  openModal("email-modal");
  loadModalIntel(contact); // saved company intelligence + tags used in generation (no AI)
  loadEmailSendStatus();    // show the "sending not configured yet" banner if applicable
  document.getElementById("modal-body").innerHTML = `<div style="text-align:center;padding:32px 0;"><span class="spinner"></span> Loading…</div>`;
  document.getElementById("draft-library-list").innerHTML = "";
  resetImportedEmailsPanel();

  if (!contact.contact_id) {
    // Ephemeral contact (not yet saved) -- no per-category library to load, just draft directly.
    document.getElementById("draft-library-section").style.display = "none";
    document.getElementById("imported-emails-toggle").style.display = "none";
    _modalSelectedMode = "cold_outreach";
    await requestDraft(contact, _modalSelectedMode, "", Boolean(options.forceRegenerateOnOpen));
    return;
  }
  document.getElementById("draft-library-section").style.display = "";
  document.getElementById("imported-emails-toggle").style.display = "";

  await loadDraftLibrary(contact.contact_id);
  const preferredMode = options.forceRegenerateOnOpen
    ? _modalSelectedMode
    : (_modalCategories.find((c) => c.exists) || _modalCategories[0] || { mode: "cold_outreach" }).mode;
  await selectDraftCategory(preferredMode, { forceRegenerateOnOpen: options.forceRegenerateOnOpen });
}

async function loadDraftLibrary(contactId) {
  try {
    const r = await fetch(`/api/contacts/${contactId}/draft-categories`);
    const d = await r.json();
    _modalCategories = d.categories || [];
  } catch (e) {
    _modalCategories = [];
  }
  renderDraftLibrary();
}

function renderDraftLibrary() {
  const el = document.getElementById("draft-library-list");
  if (!el) return;
  el.innerHTML = _modalCategories.map((c) => `
    <div class="draft-library-item${c.mode === _modalSelectedMode ? ' active' : ''}" data-mode="${escapeAttr(c.mode)}">
      <span class="draft-library-check ${c.exists ? 'exists' : 'missing'}">${c.exists ? '✓' : '○'}</span>
      <span class="draft-library-name">${escapeHtml(c.label)}</span>
      <span class="draft-library-status">${c.exists ? escapeHtml(DRAFT_STATUS_LABELS[c.status] || c.status) : 'Not Generated'}</span>
    </div>`).join("");
  el.querySelectorAll(".draft-library-item").forEach((item) => {
    item.addEventListener("click", () => selectDraftCategory(item.dataset.mode));
  });
}

// Selecting a category loads its existing draft, or shows a "not generated
// yet" placeholder with a Generate button -- never auto-generates.
async function selectDraftCategory(mode, options = {}) {
  _modalSelectedMode = mode;
  _modalDirty = false;
  renderDraftLibrary();
  resetImportedEmailsPanel();

  const category = _modalCategories.find((c) => c.mode === mode);
  const genBtn = document.getElementById("modal-generate-btn");

  if (options.forceRegenerateOnOpen) {
    genBtn.textContent = "Regenerate Draft";
    await requestDraft(_modalContact, mode, document.getElementById("modal-extra-instructions").value.trim(), true);
    return;
  }

  if (category && category.exists) {
    genBtn.textContent = "Regenerate Draft";
    document.getElementById("modal-body").innerHTML = `<div style="text-align:center;padding:32px 0;"><span class="spinner"></span> Loading…</div>`;
    try {
      const r = await fetch(`/api/contacts/${_modalContact.contact_id}/current-draft?mode=${encodeURIComponent(mode)}`);
      const d = await r.json();
      if (d.ok && d.draft) {
        _modalComm = d.draft;
        renderDraftEditor(_modalComm, _modalContact);
        return;
      }
    } catch (e) { /* fall through to the "not generated" placeholder */ }
  }

  genBtn.textContent = "Generate Draft";
  _modalComm = null;
  const label = (category && category.label) || mode;
  document.getElementById("modal-body").innerHTML = `
    <div style="text-align:center;padding:32px 0;color:#6b7280;">
      No draft yet for <strong>${escapeHtml(label)}</strong>.<br>
      <span style="font-size:0.82rem;">Add any additional instructions above, then click "Generate Draft".</span>
    </div>`;
}

async function requestDraft(contact, mode, extraInstructions, regenerate) {
  const dedupKey = `draft:${contact.contact_id || contact.company}:${mode}:${regenerate ? "regen" : "gen"}`;
  if (_aiInFlight.has(dedupKey)) return;        // dedup: ignore duplicate submits
  _aiInFlight.add(dedupKey);
  document.getElementById("modal-body").innerHTML = `
    <div style="text-align:center;padding:32px 0;">
      <span class="spinner"></span> ${regenerate ? "Regenerating" : "Generating"} email draft with Claude…
    </div>`;
  try {
    const r = await fetch("/api/draft-email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact, sender: _sender, contactId: contact.contact_id, companyKey: contact.company,
        mode, extraInstructions, regenerate: Boolean(regenerate),
        includeTagIds: getModalIncludeTagIds(),
        options: currentDraftOptions(),
        skqSelected: getModalSkqSelection(),
        promptSections: currentPromptSections(),
      }),
    });
    const d = await r.json();
    if (!r.ok || d.error) {
      document.getElementById("modal-body").innerHTML =
        `<div class="msg-error">${escapeHtml(d.error || "Draft failed")}${d.details ? " — " + escapeHtml(d.details) : ""}</div>`;
      refreshUsage();
      return;
    }
    if (d.reused) showMessage(`Loaded saved draft — AI call avoided (~${fmtTokens(d.saved_input)} in / ${fmtTokens(d.saved_output)} out tokens saved).`, "info");
    else if (d.tags_used) showMessage(`Draft generated using ${d.tags_used} confirmed company tag${d.tags_used === 1 ? "" : "s"}.`, "info");
    _modalComm = {
      id: d.id, contact_id: contact.contact_id, subject: d.subject, body: d.body,
      followup_text: d.followup, rationale: d.rationale, to_email: d.to_email || contact.email || "",
      cc: d.cc || "", bcc: d.bcc || "", notes: d.notes || "", status: d.status || "draft",
      source: d.source || "email_draft", created_at: d.created_at, updated_at: d.updated_at,
      deleted_at: null, archived_at: null, claude_configured: d.claude_configured,
    };
    _modalDirty = false;
    renderDraftEditor(_modalComm, contact);
    if (contact.contact_id) await loadDraftLibrary(contact.contact_id);
    if (_modalRefreshFn) _modalRefreshFn();
    refreshUsage();
  } catch (e) {
    document.getElementById("modal-body").innerHTML =
      `<div class="msg-error">Network error: ${escapeHtml(e.message)}</div>`;
  } finally {
    _aiInFlight.delete(dedupKey);
  }
}

// Generate (no draft yet for this category) / Regenerate (one already
// exists) -- always calls Claude fresh and always creates a NEW version in
// this category's chain (see the per-mode version scoping in db.js), so the
// previous version is never overwritten -- it's one click away in Version
// History if the regeneration isn't wanted.
document.getElementById("modal-generate-btn").addEventListener("click", () => {
  if (!_modalContact) return;
  const extra = document.getElementById("modal-extra-instructions").value.trim();
  const category = _modalCategories.find((c) => c.mode === _modalSelectedMode);
  requestDraft(_modalContact, _modalSelectedMode, extra, Boolean(category && category.exists));
});

let _draftModesCache = [];

async function loadDraftModes() {
  try {
    const r = await fetch("/api/draft-modes");
    const d = await r.json();
    _draftModesCache = d.modes || [];
    const optionsHtml = _draftModesCache.map(m => `<option value="${m.value}">${escapeHtml(m.label)}</option>`).join("");
    document.getElementById("crm-mode-select").innerHTML = optionsHtml;
    document.getElementById("aee-mode").innerHTML = optionsHtml;
  } catch (e) { /* silent */ }
}

/* ══════════════════════════════════════════════════════════════════════
   Draft options — length · tone · language · call to action

   Four controls, one component, rendered wherever a draft is generated
   (the contact modal and the bulk bar) so the two can never offer
   different choices. The catalogue is fetched from /api/draft-options
   rather than duplicated here: the word ranges shown to the user are the
   same ones the prompt asks for.

   Presentation is a segmented control rather than radios or a dropdown.
   Length is an ordered scale of five, which segments express directly —
   the options are all visible, comparable at a glance, and one click
   apart. A dropdown would hide four of five behind a click and lose the
   sense of a scale; radios would cost five rows of vertical space in a
   modal that is already long.

   Everything except length sits behind a summary line, because most
   drafts are generated without touching them. The summary always states
   the full current setting, so nothing is silently in effect.
   ══════════════════════════════════════════════════════════════════════ */

const DRAFT_OPTS_KEY = "draft_options_v1";
let _draftOptionsCatalog = null;

function defaultDraftOptions() {
  // modelId null = "whatever the server says is default" (Qwen 3.6 Flash).
  // Storing null rather than the id keeps the default following the server
  // if it ever changes, instead of pinning whatever it was on first visit.
  return { length: "medium", customWords: 150, tone: "professional", language: "english", cta: "auto", modelId: null };
}

// Last-used options persist: a team with a house style sets them once.
function getSavedDraftOptions() {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_OPTS_KEY) || "{}");
    return { ...defaultDraftOptions(), ...raw };
  } catch { return defaultDraftOptions(); }
}
function saveDraftOptions(o) {
  try { localStorage.setItem(DRAFT_OPTS_KEY, JSON.stringify(o)); } catch { /* ignore */ }
}

async function loadDraftOptionsCatalog() {
  if (_draftOptionsCatalog) return _draftOptionsCatalog;
  try {
    _draftOptionsCatalog = await getJSON("/api/draft-options");
  } catch (e) {
    _draftOptionsCatalog = { lengths: [], tones: [], languages: [], ctas: [], models: [], defaultModel: null };
  }
  return _draftOptionsCatalog;
}

function draftOptionsSummary(o, cat) {
  const find = (list, v) => (list || []).find((x) => x.value === v);
  const len = find(cat.lengths, o.length);
  const lenLabel = o.length === "custom" ? `${o.customWords} words` : (len ? len.label : o.length);
  return [lenLabel, (find(cat.tones, o.tone) || {}).label, (find(cat.languages, o.language) || {}).label,
    o.cta !== "auto" ? (find(cat.ctas, o.cta) || {}).label : null].filter(Boolean).join(" · ");
}

/* Renders the control into `container`. `scope` prefixes the element ids so
   the modal and bulk-bar copies can coexist. onChange fires on every edit. */
async function renderDraftOptions(container, scope, onChange) {
  if (!container) return;
  const cat = await loadDraftOptionsCatalog();
  const o = getSavedDraftOptions();
  /* A saved choice can outlive its provider — a key gets removed and the
     stored id no longer appears in the catalogue. Fall back to the server's
     default rather than rendering a selector with nothing selected. */
  const modelId = (cat.models || []).some((m) => m.value === o.modelId)
    ? o.modelId : (cat.defaultModel || (cat.models && cat.models[0] && cat.models[0].value) || null);

  const seg = (name, list, current) => list.map((x) =>
    `<button type="button" class="do-seg${x.value === current ? " active" : ""}"
       data-do-field="${name}" data-do-value="${x.value}"
       ${x.words ? `title="${x.words[0]}–${x.words[1]} words${x.hint ? " · " + escapeHtml(x.hint) : ""}"` : ""}
     >${escapeHtml(x.label)}</button>`).join("");

  container.innerHTML = `
    <div class="do-row">
      <label class="do-label">Length</label>
      <div class="do-segs" role="group" aria-label="Email length">${seg("length", cat.lengths, o.length)}</div>
      <input type="number" class="do-custom" id="${scope}-do-custom" min="30" max="600" step="10"
             value="${o.customWords}" aria-label="Custom word count"
             ${o.length === "custom" ? "" : "hidden"}>
      <span class="do-hint" id="${scope}-do-hint"></span>
    </div>
    ${(cat.models || []).length > 1 ? `<div class="do-row">
      <label class="do-label">AI model</label>
      <select class="do-select" id="${scope}-do-model" aria-label="AI model">
        ${cat.models.map((m) => `<option value="${escapeAttr(m.value)}" ${m.value === modelId ? "selected" : ""}>${escapeHtml(m.label)}</option>`).join("")}
      </select>
    </div>` : ""}
    <details class="do-more" id="${scope}-do-more">
      <summary><span class="do-more-label">Tone, language &amp; call to action</span>
        <span class="do-summary" id="${scope}-do-summary"></span></summary>
      <div class="do-more-body">
        <div class="do-row"><label class="do-label">Tone</label>
          <div class="do-segs" role="group" aria-label="Tone">${seg("tone", cat.tones, o.tone)}</div></div>
        <div class="do-row"><label class="do-label">Language</label>
          <div class="do-segs" role="group" aria-label="Language">${seg("language", cat.languages, o.language)}</div></div>
        <div class="do-row"><label class="do-label">Call to action</label>
          <select class="do-select" id="${scope}-do-cta" aria-label="Call to action">
            ${cat.ctas.map((c) => `<option value="${c.value}" ${c.value === o.cta ? "selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
          </select></div>
      </div>
    </details>`;

  const state = { ...o, modelId };
  const paint = () => {
    container.querySelectorAll("[data-do-field]").forEach((b) => {
      b.classList.toggle("active", state[b.dataset.doField] === b.dataset.doValue);
    });
    const custom = container.querySelector(`#${scope}-do-custom`);
    if (custom) custom.hidden = state.length !== "custom";
    const chosen = (cat.lengths || []).find((l) => l.value === state.length);
    const hint = container.querySelector(`#${scope}-do-hint`);
    if (hint) {
      hint.textContent = state.length === "custom"
        ? `≈ ${state.customWords} words`
        : (chosen && chosen.words ? `${chosen.words[0]}–${chosen.words[1]} words · ${chosen.hint}` : "");
    }
    const sum = container.querySelector(`#${scope}-do-summary`);
    if (sum) sum.textContent = draftOptionsSummary(state, cat);
    saveDraftOptions(state);
    if (onChange) onChange({ ...state });
  };

  container.querySelectorAll("[data-do-field]").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault();
    state[b.dataset.doField] = b.dataset.doValue;
    paint();
    if (b.dataset.doField === "length" && b.dataset.doValue === "custom") {
      container.querySelector(`#${scope}-do-custom`)?.focus();
    }
  }));
  container.querySelector(`#${scope}-do-custom`)?.addEventListener("input", (e) => {
    state.customWords = Math.max(30, Math.min(600, Number(e.target.value) || 150));
    paint();
  });
  container.querySelector(`#${scope}-do-cta`)?.addEventListener("change", (e) => {
    state.cta = e.target.value; paint();
  });
  container.querySelector(`#${scope}-do-model`)?.addEventListener("change", (e) => {
    state.modelId = e.target.value; paint();
  });

  paint();
  return state;
}

// What the draft endpoints should be sent. Reads saved state, so it is
// correct even if the control was never rendered in this session.
function currentDraftOptions() {
  const o = getSavedDraftOptions();
  return { length: o.length, customWords: o.customWords, tone: o.tone, language: o.language, cta: o.cta,
    // Omitted when unset, so the server applies its own default rather than
    // the browser asserting one.
    modelId: o.modelId || undefined };
}

const DRAFT_STATUS_LABELS = { draft: "Draft", ready_for_review: "Ready for Review", approved: "Approved", archived: "Archived", trash: "Trash" };
const DRAFT_SOURCE_LABELS = { email_draft: "AI Generated", manual_edit: "Manual", manual: "Manual", manual_entry: "Manually Imported", duplicated: "Duplicated", follow_up: "Follow-Up", apollo_search: "AI Generated" };

const DRAFT_ACTION_BAR = {
  draft: [["save", "Save Draft", "btn-orange"], ["ready", "Mark Ready for Review", "btn-ghost"], ["duplicate", "Duplicate", "btn-ghost"], ["trash", "Delete", "btn-danger"]],
  ready_for_review: [["save", "Save Changes", "btn-orange"], ["approve", "Approve", "btn-saved"], ["return_to_draft", "Return to Draft", "btn-ghost"], ["trash", "Delete", "btn-danger"]],
  approved: [["return_to_draft", "Return to Draft", "btn-ghost"], ["archive", "Archive", "btn-ghost"], ["duplicate", "Duplicate", "btn-ghost"], ["followup", "Create Follow-Up", "btn-ghost"]],
  archived: [["restore", "Restore", "btn-saved"], ["duplicate", "Duplicate", "btn-ghost"]],
  trash: [["restore", "Restore", "btn-saved"]],
};

// Combined status: the send/delivery state wins over the editorial status once a
// send has been attempted, so the badge reflects Draft→Queued→Sending→Sent/Failed.
const DELIVERY_STATUS_LABELS = {
  queued: "Queued", sending: "Sending", sent: "Sent", delivered: "Delivered",
  opened: "Opened", clicked: "Clicked", replied: "Replied", bounced: "Bounced", failed: "Failed",
};
const DELIVERY_STATUS_CLS = {
  queued: "amber", sending: "blue", sent: "green", delivered: "green",
  opened: "green", clicked: "green", replied: "green", bounced: "red", failed: "red",
};
function draftStatusBadgeHtml(comm) {
  const ds = comm.delivery_status;
  if (ds && DELIVERY_STATUS_LABELS[ds]) {
    return `<span class="draft-status-badge del-${DELIVERY_STATUS_CLS[ds]}">${DELIVERY_STATUS_LABELS[ds]}</span>`;
  }
  const status = effectiveDraftStatus(comm);
  return `<span class="draft-status-badge status-${status}">${DRAFT_STATUS_LABELS[status] || status}</span>`;
}

function renderDraftEditor(comm, contact) {
  const status = effectiveDraftStatus(comm);
  const note = comm.claude_configured === false
    ? `<div class="draft-note">⚠ Claude key not set — this is a template stub. Add a Claude key in the Config section for AI-generated drafts.</div>`
    : "";
  // Sender identity: connected account name → profile name → email only. Never
  // a placeholder. If no mailbox is connected, say so.
  const fromName = senderDisplayName();
  // _connectedEmail is filled by loadEmailSendStatus(), which may not have
  // returned yet when the editor first renders — so a connected mailbox was
  // being reported as "not connected". The sender profile carries the same
  // address (it is read from the connected account server-side), so use it
  // as the fallback before claiming there is no mailbox.
  const fromEmail = _connectedEmail || (_sender && _sender.email) || "";
  const fromLine = fromEmail
    ? (fromName
        ? `${escapeHtml(fromName)} <span class="compose-from-email">&lt;${escapeHtml(fromEmail)}&gt;</span>`
        : `<span class="compose-from-email">${escapeHtml(fromEmail)}</span>`)
    : `<span class="compose-from-warn">Mailbox not connected — set it up in Settings</span>`;

  document.getElementById("modal-body").innerHTML = `
    ${note}
    <div class="draft-meta-row">
      <div>
        ${draftStatusBadgeHtml(comm)}
        <span class="draft-meta-text" style="margin-left:8px;">Source: ${DRAFT_SOURCE_LABELS[comm.source] || comm.source || "AI Generated"}</span>
      </div>
      <div class="draft-meta-text">
        <span id="draft-autosave-status" class="autosave-status"></span>
        ${comm.created_at ? ` · Created ${new Date(comm.created_at).toLocaleString()}` : ""}
      </div>
    </div>

    <!-- Modern compose header -->
    <div class="compose-header">
      <div class="compose-row"><label>From</label><div class="compose-from">${fromLine}</div></div>
      <div class="compose-row"><label>To</label>
        <div class="chip-input" id="chips-to"></div>
        <input type="hidden" id="draft-field-to" value="${escapeAttr(comm.to_email || "")}">
      </div>
      <div class="compose-row"><label>Cc</label>
        <div class="chip-input" id="chips-cc"></div>
        <input type="hidden" id="draft-field-cc" value="${escapeAttr(comm.cc || "")}">
      </div>
      <div class="compose-row"><label>Bcc</label>
        <div class="chip-input" id="chips-bcc"></div>
        <input type="hidden" id="draft-field-bcc" value="${escapeAttr(comm.bcc || "")}">
      </div>
      <div class="compose-row"><label>Subject</label>
        <input class="compose-subject" id="draft-field-subject" value="${escapeAttr(comm.subject || "")}" placeholder="Subject">
      </div>
    </div>

    <div class="draft-section">
      <!-- Separates the envelope from the message, so a missing greeting or
           signature is obvious at a glance. -->
      <div class="compose-divider"></div>
      <textarea class="draft-field draft-body" id="draft-field-body" rows="16" placeholder="Write your email…">${escapeHtml(comm.body || "")}</textarea>
    </div>

    <div class="draft-section">
      <div class="draft-label">Attachments</div>
      <div id="draft-attachment-chips"></div>
      <button class="btn-sm btn-ghost" id="draft-add-attachment-btn" style="margin-top:6px;">+ Upload</button>
      <button class="btn-sm btn-ghost" id="draft-attach-from-library-btn" style="margin-top:6px;">+ Choose Library</button>
    </div>

    <details class="em-advanced" style="margin-top:8px;">
      <summary>⚙️ Follow-up template, rationale &amp; internal notes</summary>
      <div class="draft-section"><div class="draft-label">Follow-up Template</div>
        <textarea class="draft-field" id="draft-field-followup" rows="3">${escapeHtml(comm.followup_text || comm.followup || "")}</textarea></div>
      <div class="draft-section"><div class="draft-label">Why This Contact</div>
        <div class="draft-value">${escapeHtml(comm.rationale || "")}</div></div>
      <div class="draft-section"><div class="draft-label">Internal Notes</div>
        <textarea class="draft-field" id="draft-field-notes" rows="2" placeholder="Notes only your team can see">${escapeHtml(comm.notes || "")}</textarea></div>
    </details>

    <div class="draft-collapsible-header" id="draft-versions-toggle">Version History <span>▾</span></div>
    <div class="draft-collapsible-body" id="draft-versions-body"></div>
    <div class="draft-collapsible-header" id="draft-activity-toggle">Activity <span>▾</span></div>
    <div class="draft-collapsible-body" id="draft-activity-body"></div>

    <div class="modal-actions" id="draft-lifecycle-actions" style="margin-bottom:4px;"></div>
    <div class="modal-actions" style="font-size:0.8rem;">
      <button class="btn-sm copy-btn" id="copy-all-btn">Copy</button>
      <button class="btn-sm btn-ghost" id="export-draft-txt-btn">.txt</button>
      <button class="btn-sm btn-ghost" id="export-draft-json-btn">.json</button>
    </div>

    <!-- Sticky action bar -->
    <div class="draft-actionbar" id="draft-actionbar">
      <button class="ab-btn ab-ghost" id="ab-cancel">Cancel</button>
      <button class="ab-btn ab-ghost" id="ab-save">Save Draft</button>
      <button class="ab-btn ab-ghost" id="ab-preview">Preview</button>
      <button class="ab-btn ab-ghost" id="ab-sendtest">Send Test</button>
      <button class="ab-btn ab-ghost" id="ab-schedule">Schedule ▾</button>
      <span class="ab-spacer"></span>
      <button class="ab-btn ab-send" id="ab-send">Send Email</button>
    </div>`;

  const fullText = `Subject: ${comm.subject}\n\n${comm.body}\n\n---\nFollow-up: ${comm.followup_text || comm.followup}\n\nRationale: ${comm.rationale}`;
  document.getElementById("copy-all-btn").addEventListener("click", () => copyDraft(fullText));
  document.getElementById("export-draft-txt-btn").addEventListener("click", () => exportDraftText(fullText, contact.name));
  document.getElementById("export-draft-json-btn").addEventListener("click", () => exportDraftJson(JSON.stringify(comm), contact.name));

  // Recipient chips (To / Cc / Bcc) sync into the hidden inputs.
  setupChipInput("chips-to", "draft-field-to", "recipient@example.com");
  setupChipInput("chips-cc", "draft-field-cc", "cc@example.com");
  setupChipInput("chips-bcc", "draft-field-bcc", "bcc@example.com");

  // Any edit → dirty + debounced autosave.
  document.querySelectorAll("#modal-body .draft-field, #draft-field-subject").forEach((el) =>
    el.addEventListener("input", () => { _modalDirty = true; scheduleAutosave(); }));

  renderDraftActionBar(status);
  wireDraftActionBar(comm);
  loadAttachmentChips(comm.id, "draft-attachment-chips");
  document.getElementById("draft-add-attachment-btn").addEventListener("click", () => uploadOneOffAttachmentsTo(comm.id, "draft-attachment-chips"));
  document.getElementById("draft-attach-from-library-btn").addEventListener("click", () => attachFromLibraryTo(comm.id, "draft-attachment-chips"));

  document.getElementById("draft-versions-toggle").addEventListener("click", () =>
    toggleDraftCollapsible("draft-versions-body", () => loadDraftVersionsPanel(contact.contact_id)));
  document.getElementById("draft-activity-toggle").addEventListener("click", () =>
    toggleDraftCollapsible("draft-activity-body", () => loadDraftActivityPanel(contact.contact_id)));
}

// ── Recipient chips ────────────────────────────────────────────────────────
// A lightweight Outlook-style chip input backed by a hidden comma-joined value
// (so collectDraftFieldValues() keeps working unchanged).
function setupChipInput(containerId, hiddenId, placeholder) {
  const box = document.getElementById(containerId);
  const hidden = document.getElementById(hiddenId);
  if (!box || !hidden) return;
  let values = (hidden.value || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sync = () => { hidden.value = values.join(", "); _modalDirty = true; scheduleAutosave(); };
  const render = () => {
    box.innerHTML = values.map((v, i) =>
      `<span class="chip">${escapeHtml(v)}<a href="#" data-i="${i}" class="chip-x">✕</a></span>`).join("") +
      `<input type="text" class="chip-entry" placeholder="${values.length ? "" : escapeHtml(placeholder)}">`;
    const input = box.querySelector(".chip-entry");
    box.querySelectorAll(".chip-x").forEach((x) => x.addEventListener("click", (e) => {
      e.preventDefault(); values.splice(Number(x.dataset.i), 1); render(); sync();
    }));
    const commit = () => { const t = input.value.trim().replace(/[,;]$/, "").trim(); if (t) { values.push(t); input.value = ""; render(); sync(); box.querySelector(".chip-entry").focus(); } };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "," || e.key === ";") { e.preventDefault(); commit(); }
      else if (e.key === "Backspace" && !input.value && values.length) { values.pop(); render(); sync(); box.querySelector(".chip-entry").focus(); }
    });
    input.addEventListener("blur", commit);
  };
  render();
}

// ── Autosave ────────────────────────────────────────────────────────────────
let _autosaveTimer = null;
function setAutosaveStatus(state) {
  const el = document.getElementById("draft-autosave-status");
  if (!el) return;
  if (state === "saving") { el.textContent = "Saving…"; el.style.color = "#6b7280"; }
  else if (state === "saved") { el.textContent = "Saved just now"; el.style.color = "#047857"; }
  else if (state === "failed") { el.textContent = "Save failed"; el.style.color = "#b91c1c"; }
  else el.textContent = "";
}
function scheduleAutosave() {
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => { autosaveDraft(); }, 1400);
}
async function autosaveDraft() {
  if (!_modalComm || !_modalDirty) return;
  setAutosaveStatus("saving");
  try {
    const r = await fetch(`/api/communications/${_modalComm.id}/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...collectDraftFieldValues(), asNewVersion: false }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "Save failed");
    _modalComm = d.communication; _modalDirty = false;
    setAutosaveStatus("saved");
  } catch (e) { setAutosaveStatus("failed"); }
}

// ── Sticky action bar wiring ────────────────────────────────────────────────
function wireDraftActionBar(comm) {
  const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener("click", fn); };
  on("ab-cancel", () => closeModal("email-modal"));
  on("ab-save", () => saveCurrentDraft(false));
  on("ab-preview", () => openDraftPreview());
  on("ab-sendtest", () => sendDraftTest());
  on("ab-schedule", () => scheduleDraftSend());
  on("ab-send", () => sendDraftEmail());
}

async function sendDraftTest() {
  const btn = document.getElementById("ab-sendtest"); const orig = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  try {
    const d = await (await fetch("/api/email/account/send-test", { method: "POST" })).json();
    if (d.error) showMessage("Send Test failed: " + (d.message || d.error), "error");
    else showMessage("✅ Test email sent to your own mailbox.", "info");
  } catch (e) { showMessage("Send Test failed: " + e.message, "error"); }
  finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}

function openDraftPreview() {
  const v = collectDraftFieldValues();
  const to = v.to_email || "(no recipient)";
  const from = _connectedEmail
    ? (senderDisplayName() ? `${senderDisplayName()} <${_connectedEmail}>` : _connectedEmail)
    : "(mailbox not connected)";
  const bodyHtml = escapeHtml(v.body || "").replace(/\n/g, "<br>");
  const el = document.getElementById("draft-preview-body");
  if (!el) return;
  el.innerHTML = `
    <div class="preview-email">
      <div class="preview-line"><span>From</span><b>${escapeHtml(from)}</b></div>
      <div class="preview-line"><span>To</span><b>${escapeHtml(to)}</b></div>
      ${v.cc ? `<div class="preview-line"><span>Cc</span><b>${escapeHtml(v.cc)}</b></div>` : ""}
      <div class="preview-line"><span>Subject</span><b>${escapeHtml(v.subject || "(no subject)")}</b></div>
      <hr>
      <div class="preview-message">${bodyHtml || "<em>(empty body)</em>"}</div>
    </div>`;
  const modal = document.getElementById("draft-preview-modal");
  if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
  openModal("draft-preview-modal");
}

function scheduleDraftSend() {
  const when = prompt("Schedule send for (YYYY-MM-DD HH:MM, your local time):");
  if (!when) return;
  const dt = new Date(when.replace(" ", "T"));
  if (isNaN(dt.getTime())) return showMessage("Couldn't understand that date/time.", "error");
  fetch(`/api/communications/${_modalComm.id}/schedule`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scheduled_at: dt.toISOString() }),
  }).then((r) => r.json()).then((d) => {
    if (d.error) return showMessage(d.error, "error");
    _modalComm = d.communication || _modalComm;
    showMessage("📅 Queued for " + dt.toLocaleString() + ". (Auto-dispatch of scheduled sends is a later phase.)", "info");
    renderDraftEditor(_modalComm, _modalContact);
  }).catch((e) => showMessage("Schedule failed: " + e.message, "error"));
}

async function sendDraftEmail() {
  if (!_modalComm) return;
  const v = collectDraftFieldValues();
  if (!v.to_email) return showMessage("Add a recipient before sending.", "error");
  // Confirmation dialog.
  const from = _connectedEmail
    ? (senderDisplayName() ? `${senderDisplayName()} <${_connectedEmail}>` : _connectedEmail)
    : "(mailbox not connected)";
  if (!confirm(`Send this email now?\n\nFrom: ${from}\nTo: ${v.to_email}\nSubject: ${v.subject || "(no subject)"}`)) return;
  const btn = document.getElementById("ab-send"); const orig = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  try {
    const r = await fetch(`/api/communications/${_modalComm.id}/send`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(v),
    });
    const d = await r.json();
    if (!r.ok || d.error) {
      if (d.communication) { _modalComm = d.communication; renderDraftEditor(_modalComm, _modalContact); }
      showMessage("❌ Send failed: " + (d.message || d.error), "error");
      return;
    }
    _modalComm = d.communication || _modalComm;
    _modalDirty = false;
    showMessage("✅ Email sent to " + v.to_email + ".", "info");
    renderDraftEditor(_modalComm, _modalContact);
    if (_modalContact && _modalContact.contact_id) await loadDraftLibrary(_modalContact.contact_id);
    if (_modalRefreshFn) _modalRefreshFn();
  } catch (e) { showMessage("Send failed: " + e.message, "error"); }
  finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}

// ── Attachment chips: shared rendering for any communication (draft or imported email) ──

function renderAttachmentChips(attachments, containerEl, { onRemove } = {}) {
  if (!attachments || !attachments.length) {
    containerEl.innerHTML = `<span style="font-size:0.8rem;color:#9ca3af;">No attachments.</span>`;
    return;
  }
  containerEl.innerHTML = attachments.map((a) => `
    <span class="draft-library-item" style="display:inline-flex;width:auto;margin:0 6px 6px 0;">
      <a href="/api/attachments/${a.id}/download" target="_blank" rel="noopener">${escapeHtml(a.original_filename)}</a>
      ${onRemove ? `<a href="#" class="remove-attachment-chip" data-id="${a.id}" style="color:#dc2626;margin-left:6px;">✕</a>` : ""}
    </span>`).join("");
  if (onRemove) {
    containerEl.querySelectorAll(".remove-attachment-chip").forEach((el) => {
      el.addEventListener("click", (e) => { e.preventDefault(); onRemove(Number(el.dataset.id)); });
    });
  }
}

async function loadAttachmentChips(communicationId, containerId) {
  const el = document.getElementById(containerId);
  if (!el || !communicationId) return;
  try {
    const r = await fetch(`/api/communications/${communicationId}/attachments`);
    const d = await r.json();
    renderAttachmentChips(d.attachments || [], el, {
      onRemove: async (attachmentId) => {
        await fetch(`/api/communications/${communicationId}/attachments/${attachmentId}`, { method: "DELETE" });
        loadAttachmentChips(communicationId, containerId);
      },
    });
  } catch (e) { /* silent */ }
}

// Native multi-file picker -> upload as one-off attachments on an existing communication.
function uploadOneOffAttachmentsTo(communicationId, refreshContainerId) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    await fetch(`/api/communications/${communicationId}/attachments`, { method: "POST", body: form });
    loadAttachmentChips(communicationId, refreshContainerId);
  });
  input.click();
}

// Opens the Attachment Library in picker mode -> link an existing library file to a communication.
function attachFromLibraryTo(communicationId, refreshContainerId) {
  openLibraryPicker(async (attachmentIds) => {
    if (!attachmentIds.length) return;
    const form = new FormData();
    form.append("libraryAttachmentIds", JSON.stringify(attachmentIds));
    await fetch(`/api/communications/${communicationId}/attachments`, { method: "POST", body: form });
    loadAttachmentChips(communicationId, refreshContainerId);
  });
}

// ── Attachment Library dialog: shared between full management and a
// checkbox picker mode (opened from "+ From Library" buttons elsewhere). ──

function openLibraryPicker(onApply) {
  _libraryPickerCallback = onApply;
  _libraryPickerSelected = new Set();
  document.getElementById("attachment-library-title").textContent = "Pick Attachments";
  document.getElementById("al-picker-actions").style.display = "";
  document.getElementById("al-manage-only-section").style.display = "none";
  document.getElementById("al-versions-panel").style.display = "none";
  openModal("attachment-library-modal");
  loadLibraryList();
}

function openAttachmentLibraryManager() {
  _libraryPickerCallback = null;
  _libraryPickerSelected = new Set();
  document.getElementById("attachment-library-title").textContent = "Attachment Library";
  document.getElementById("al-picker-actions").style.display = "none";
  document.getElementById("al-manage-only-section").style.display = "";
  document.getElementById("al-versions-panel").style.display = "none";
  openModal("attachment-library-modal");
  loadLibraryList();
}

async function loadLibraryList() {
  const search = document.getElementById("al-search").value.trim();
  const category = document.getElementById("al-category-filter").value;
  const favoritesOnly = document.getElementById("al-favorites-toggle").dataset.active === "true";
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (category) params.set("category", category);
  if (favoritesOnly) params.set("favorite", "true");
  try {
    const r = await fetch(`/api/attachment-library?${params.toString()}`);
    const d = await r.json();
    _libraryItems = d.items || [];
  } catch (e) { _libraryItems = []; }
  renderLibraryList();
}

function renderLibraryList() {
  const el = document.getElementById("al-list");
  if (!_libraryItems.length) {
    el.innerHTML = `<div style="color:#9ca3af;font-size:0.85rem;padding:8px 0;">No library items yet.</div>`;
    return;
  }
  el.innerHTML = _libraryItems.map((item) => `
    <div class="draft-library-item" data-key="${escapeAttr(item.library_key)}">
      ${_libraryPickerCallback
        ? `<input type="checkbox" class="al-pick-checkbox" data-id="${item.id}" ${_libraryPickerSelected.has(item.id) ? "checked" : ""}>`
        : `<span class="draft-library-check exists al-favorite-star" data-key="${escapeAttr(item.library_key)}" style="cursor:pointer;">${item.is_favorite ? "★" : "☆"}</span>`}
      <span class="draft-library-name">${escapeHtml(item.library_name)}</span>
      <span class="draft-library-status">${escapeHtml(item.library_category || "")} · v${item.version}</span>
    </div>`).join("");

  el.querySelectorAll(".al-pick-checkbox").forEach((cb) => {
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = Number(cb.dataset.id);
      if (cb.checked) _libraryPickerSelected.add(id); else _libraryPickerSelected.delete(id);
    });
  });
  if (_libraryPickerCallback) return;

  el.querySelectorAll(".al-favorite-star").forEach((star) => {
    star.addEventListener("click", async (e) => {
      e.stopPropagation();
      const item = _libraryItems.find((i) => i.library_key === star.dataset.key);
      if (item) await fetch(`/api/attachment-library/${item.id}/favorite`, { method: "POST" });
      loadLibraryList();
    });
  });
  el.querySelectorAll(".draft-library-item").forEach((row) => {
    row.addEventListener("click", () => openLibraryVersions(row.dataset.key));
  });
}

async function openLibraryVersions(libraryKey) {
  _libraryVersionsKey = libraryKey;
  const item = _libraryItems.find((i) => i.library_key === libraryKey);
  document.getElementById("al-versions-name").textContent = item ? item.library_name : "";
  document.getElementById("al-versions-panel").style.display = "";
  try {
    const r = await fetch(`/api/attachment-library/${encodeURIComponent(libraryKey)}/versions`);
    const d = await r.json();
    document.getElementById("al-versions-list").innerHTML = (d.versions || []).map((v) => `
      <div class="draft-version-item">
        <span>Version ${v.version} — <a href="/api/attachments/${v.id}/download" target="_blank" rel="noopener">${escapeHtml(v.original_filename)}</a></span>
        <span class="draft-activity-time">${new Date(v.created_at).toLocaleString()}</span>
      </div>`).join("") || `<div class="draft-activity-time">No versions.</div>`;
  } catch (e) { /* silent */ }
}

document.getElementById("attachment-library-close").addEventListener("click", () => {
  closeModal("attachment-library-modal");
});
document.getElementById("al-search").addEventListener("input", () => loadLibraryList());
document.getElementById("al-category-filter").addEventListener("change", () => loadLibraryList());
document.getElementById("al-favorites-toggle").addEventListener("click", () => {
  const btn = document.getElementById("al-favorites-toggle");
  const active = btn.dataset.active === "true";
  btn.dataset.active = String(!active);
  btn.textContent = !active ? "★ Favorites Only" : "☆ Favorites Only";
  loadLibraryList();
});
document.getElementById("al-apply-picker-btn").addEventListener("click", () => {
  const cb = _libraryPickerCallback;
  const ids = Array.from(_libraryPickerSelected);
  closeModal("attachment-library-modal");
  if (cb) cb(ids);
});
document.getElementById("al-upload-btn").addEventListener("click", async () => {
  const fileInput = document.getElementById("al-new-file");
  const file = fileInput.files && fileInput.files[0];
  if (!file) { showMessage("Choose a file first.", "error"); return; }
  const form = new FormData();
  form.append("file", file);
  form.append("name", document.getElementById("al-new-name").value.trim() || file.name);
  form.append("category", document.getElementById("al-new-category").value);
  await fetch("/api/attachment-library", { method: "POST", body: form });
  document.getElementById("al-new-name").value = "";
  fileInput.value = "";
  loadLibraryList();
});
document.getElementById("al-replace-btn").addEventListener("click", async () => {
  const fileInput = document.getElementById("al-replace-file");
  const file = fileInput.files && fileInput.files[0];
  if (!file || !_libraryVersionsKey) { showMessage("Choose a file first.", "error"); return; }
  const form = new FormData();
  form.append("file", file);
  await fetch(`/api/attachment-library/${encodeURIComponent(_libraryVersionsKey)}/replace`, { method: "POST", body: form });
  fileInput.value = "";
  loadLibraryList();
  openLibraryVersions(_libraryVersionsKey);
});
document.getElementById("al-delete-item-btn").addEventListener("click", async () => {
  if (!_libraryVersionsKey) return;
  if (!confirm("Delete this library item and all its versions?")) return;
  await fetch(`/api/attachment-library/${encodeURIComponent(_libraryVersionsKey)}`, { method: "DELETE" });
  document.getElementById("al-versions-panel").style.display = "none";
  loadLibraryList();
});
document.getElementById("modal-manage-library-btn").addEventListener("click", () => openAttachmentLibraryManager());

function toggleDraftCollapsible(bodyId, onOpenLoad) {
  const body = document.getElementById(bodyId);
  const wasOpen = body.classList.contains("open");
  body.classList.toggle("open");
  if (!wasOpen && onOpenLoad) onOpenLoad();
}

function renderDraftActionBar(status) {
  const el = document.getElementById("draft-lifecycle-actions");
  if (!el) return;
  const buttons = DRAFT_ACTION_BAR[status] || DRAFT_ACTION_BAR.draft;
  el.innerHTML = buttons.map(([action, label, cls]) => `<button class="btn-sm ${cls}" data-action="${action}">${label}</button>`).join("");
  el.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", () => handleDraftAction(btn.dataset.action)));
}

function collectDraftFieldValues() {
  return {
    to_email: document.getElementById("draft-field-to").value.trim(),
    cc: document.getElementById("draft-field-cc").value.trim(),
    bcc: document.getElementById("draft-field-bcc").value.trim(),
    subject: document.getElementById("draft-field-subject").value,
    body: document.getElementById("draft-field-body").value,
    followup_text: document.getElementById("draft-field-followup").value,
    notes: document.getElementById("draft-field-notes").value,
  };
}

async function saveCurrentDraft(asNewVersion) {
  if (!_modalComm) return;
  try {
    const r = await fetch(`/api/communications/${_modalComm.id}/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...collectDraftFieldValues(), asNewVersion: Boolean(asNewVersion) }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "Save failed");
    _modalComm = d.communication;
    _modalDirty = false;
    renderDraftEditor(_modalComm, _modalContact);
    showMessage(asNewVersion ? "Saved as a new version." : "Draft saved.", "info");
    if (_modalContact.contact_id) await loadDraftLibrary(_modalContact.contact_id);
    if (_modalRefreshFn) _modalRefreshFn();
  } catch (e) {
    showMessage(`Save failed: ${e.message}`, "error");
  }
}

async function handleDraftAction(action) {
  if (!_modalComm) return;
  const id = _modalComm.id;
  if (action === "save") return saveCurrentDraft(false);
  if (action === "duplicate") {
    try {
      const r = await fetch(`/api/communications/${id}/duplicate`, { method: "POST" });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "Duplicate failed");
      showMessage("Draft duplicated.", "info");
      if (_modalContact.contact_id) await loadDraftLibrary(_modalContact.contact_id);
      if (_modalRefreshFn) _modalRefreshFn();
    } catch (e) { showMessage(`Duplicate failed: ${e.message}`, "error"); }
    return;
  }
  if (action === "followup") {
    try {
      const r = await fetch(`/api/communications/${id}/follow-up`, { method: "POST" });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "Follow-up failed");
      showMessage("Follow-up draft created.", "info");
      if (_modalContact.contact_id) await loadDraftLibrary(_modalContact.contact_id);
      if (_modalRefreshFn) _modalRefreshFn();
    } catch (e) { showMessage(`Follow-up failed: ${e.message}`, "error"); }
    return;
  }

  const endpointByAction = {
    ready: { url: `/api/communications/${id}/status`, body: { status: "ready_for_review" } },
    approve: { url: `/api/communications/${id}/status`, body: { status: "approved" } },
    return_to_draft: { url: `/api/communications/${id}/status`, body: { status: "draft" } },
    archive: { url: `/api/communications/${id}/archive` },
    trash: { url: `/api/communications/${id}/trash` },
    restore: { url: `/api/communications/${id}/restore` },
  };
  const cfg = endpointByAction[action];
  if (!cfg) return;
  try {
    const r = await fetch(cfg.url, {
      method: "POST",
      headers: cfg.body ? { "Content-Type": "application/json" } : undefined,
      body: cfg.body ? JSON.stringify(cfg.body) : undefined,
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "Action failed");
    _modalComm = d.communication;
    renderDraftEditor(_modalComm, _modalContact);
    if (_modalContact.contact_id) await loadDraftLibrary(_modalContact.contact_id);
    if (_modalRefreshFn) _modalRefreshFn();
  } catch (e) {
    showMessage(`Action failed: ${e.message}`, "error");
  }
}

function draftSourceLabel(source) { return DRAFT_SOURCE_LABELS[source] || source || "Unknown"; }

async function loadDraftVersionsPanel(contactId) {
  const body = document.getElementById("draft-versions-body");
  if (!body || !contactId) return;
  try {
    const r = await fetch(`/api/contacts/${contactId}/draft-versions?mode=${encodeURIComponent(_modalSelectedMode)}`);
    const d = await r.json();
    const versions = d.versions || [];
    body.innerHTML = versions.length
      ? versions.map((v) => `
        <div class="draft-version-item" data-id="${v.id}">
          <span>Version ${v.version} — ${escapeHtml(draftSourceLabel(v.source))}${_modalComm && v.id === _modalComm.id ? " (current)" : ""}</span>
          <span class="draft-activity-time">${new Date(v.created_at).toLocaleString()}</span>
        </div>`).join("")
      : `<div class="draft-activity-time">No versions yet.</div>`;
    body.querySelectorAll(".draft-version-item").forEach((el) => {
      el.addEventListener("click", () => {
        const version = versions.find((v) => v.id === Number(el.dataset.id));
        if (!version || (_modalComm && version.id === _modalComm.id)) return;
        if (confirm(`Restore Version ${version.version}? This saves it as a new version -- nothing is lost.`)) restoreDraftVersion(version);
      });
    });
  } catch (e) { /* silent */ }
}

async function restoreDraftVersion(version) {
  if (!_modalComm) return;
  try {
    const r = await fetch(`/api/communications/${_modalComm.id}/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: version.subject, body: version.body, followup_text: version.followup_text,
        to_email: version.to_email, cc: version.cc, bcc: version.bcc, notes: version.notes,
        asNewVersion: true,
      }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "Restore failed");
    _modalComm = d.communication;
    renderDraftEditor(_modalComm, _modalContact);
    showMessage(`Restored Version ${version.version} as a new version.`, "info");
    if (_modalContact.contact_id) await loadDraftLibrary(_modalContact.contact_id);
    if (_modalRefreshFn) _modalRefreshFn();
  } catch (e) {
    showMessage(`Restore failed: ${e.message}`, "error");
  }
}

async function loadDraftActivityPanel(contactId) {
  const body = document.getElementById("draft-activity-body");
  if (!body || !contactId) return;
  try {
    const r = await fetch(`/api/contacts/${contactId}/activity`);
    const d = await r.json();
    const items = d.activity || [];
    body.innerHTML = items.length
      ? items.map((a) => `<div class="draft-activity-item"><span class="draft-activity-time">${new Date(a.created_at).toLocaleString()}</span> — ${escapeHtml(a.description || a.activity_type)}</div>`).join("")
      : `<div class="draft-activity-time">No activity yet.</div>`;
  } catch (e) { /* silent */ }
}

// ── Sent / Imported Emails panel: manually-logged emails for the selected category ──

function resetImportedEmailsPanel() {
  const toggle = document.getElementById("imported-emails-toggle");
  const body = document.getElementById("imported-emails-body");
  if (toggle) toggle.classList.remove("open");
  if (body) body.classList.remove("open");
  const list = document.getElementById("cd-imported-list");
  if (list) list.innerHTML = "";
  const pane = document.getElementById("cd-thread-pane");
  if (pane) pane.innerHTML = "";
}

async function loadImportedEmailsPanel(contactId, mode) {
  const body = document.getElementById("cd-imported-list") || document.getElementById("imported-emails-body");
  if (!body || !contactId) return;
  try {
    const r = await fetch(`/api/contacts/${contactId}/imported-emails?mode=${encodeURIComponent(mode)}`);
    const d = await r.json();
    renderImportedEmailsList(d.emails || [], body);
  } catch (e) { /* silent */ }
}

function renderImportedEmailsList(emails, body) {
  if (!emails.length) {
    body.innerHTML = `<div class="draft-activity-time">No manually-logged emails in this category yet.</div>`;
    return;
  }
  body.innerHTML = emails.map((e) => `
    <div class="draft-version-item" style="flex-direction:column;align-items:stretch;" data-id="${e.id}">
      <div style="display:flex;justify-content:space-between;">
        <strong>${escapeHtml(e.subject || "(no subject)")}</strong>
        <span class="draft-activity-time">${e.sent_at ? new Date(e.sent_at).toLocaleDateString() : ""}</span>
      </div>
      <div style="font-size:0.82rem;color:#555;margin:4px 0;">To: ${escapeHtml(e.to_email || "")} · <span class="draft-status-badge status-approved">Manually Imported</span></div>
      <div class="ie-attachment-chips" id="ie-chips-${e.id}"></div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn-sm btn-ghost ie-edit-btn" data-id="${e.id}">Edit</button>
        <button class="btn-sm btn-ghost ie-template-btn" data-id="${e.id}">Use as Template</button>
        <button class="btn-sm btn-danger ie-delete-btn" data-id="${e.id}">Delete</button>
      </div>
    </div>`).join("");

  emails.forEach((e) => renderAttachmentChips(e.attachments, document.getElementById(`ie-chips-${e.id}`)));

  body.querySelectorAll(".ie-edit-btn").forEach((btn) => btn.addEventListener("click", () => editImportedEmail(Number(btn.dataset.id), emails)));
  body.querySelectorAll(".ie-delete-btn").forEach((btn) => btn.addEventListener("click", () => deleteImportedEmail(Number(btn.dataset.id))));
  body.querySelectorAll(".ie-template-btn").forEach((btn) => btn.addEventListener("click", () => useImportedEmailAsTemplate(Number(btn.dataset.id))));
}

async function editImportedEmail(id, emails) {
  const email = emails.find((e) => e.id === id);
  if (!email) return;
  const subject = prompt("Subject:", email.subject || "");
  if (subject === null) return;
  const body = prompt("Body:", email.body || "");
  if (body === null) return;
  await fetch(`/api/communications/${id}/imported-email`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, body }),
  });
  loadImportedEmailsPanel(_modalContact.contact_id, _modalSelectedMode);
}

async function deleteImportedEmail(id) {
  if (!confirm("Delete this logged email? This cannot be undone.")) return;
  await fetch(`/api/communications/${id}`, { method: "DELETE" });
  loadImportedEmailsPanel(_modalContact.contact_id, _modalSelectedMode);
}

async function useImportedEmailAsTemplate(id) {
  try {
    const r = await fetch(`/api/communications/${id}/duplicate`, { method: "POST" });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "Failed to use as template");
    showMessage("Created a new editable draft from this email.", "info");
    await loadDraftLibrary(_modalContact.contact_id);
    await selectDraftCategory(_modalSelectedMode);
    if (_modalRefreshFn) _modalRefreshFn();
  } catch (e) { showMessage(`Use as Template failed: ${e.message}`, "error"); }
}

document.getElementById("imported-emails-toggle").addEventListener("click", () =>
  toggleDraftCollapsible("imported-emails-body", () => loadImportedEmailsPanel(_modalContact.contact_id, _modalSelectedMode)));

// ── Add Existing Email (manual entry) sub-dialog ──

function openAddExistingEmailModal() {
  if (!_modalContact || !_modalContact.contact_id) return;
  _aeeFiles = [];
  _aeeLibraryIds = [];
  document.getElementById("aee-mode").value = _modalSelectedMode;
  document.getElementById("aee-to-email").value = _modalContact.email || "";
  document.getElementById("aee-sent-at").value = new Date().toISOString().slice(0, 10);
  document.getElementById("aee-subject").value = "";
  document.getElementById("aee-body").value = "";
  document.getElementById("aee-notes").value = "";
  document.getElementById("aee-error").style.display = "none";
  renderAeeAttachmentChips();
  openModal("add-existing-email-modal");
}

function closeAddExistingEmailModal() {
  closeModal("add-existing-email-modal");
}

function renderAeeAttachmentChips() {
  const el = document.getElementById("aee-attachment-chips");
  const fileChips = _aeeFiles.map((f, i) => `
    <span class="draft-library-item" style="display:inline-flex;width:auto;margin:0 6px 6px 0;">
      ${escapeHtml(f.name)} <a href="#" class="aee-remove-file" data-idx="${i}" style="color:#dc2626;margin-left:6px;">✕</a>
    </span>`).join("");
  const libraryChips = _aeeLibraryIds.map((id) => `
    <span class="draft-library-item" style="display:inline-flex;width:auto;margin:0 6px 6px 0;">
      Library #${id} <a href="#" class="aee-remove-lib" data-id="${id}" style="color:#dc2626;margin-left:6px;">✕</a>
    </span>`).join("");
  el.innerHTML = fileChips + libraryChips || `<span style="font-size:0.8rem;color:#9ca3af;">No attachments yet.</span>`;
  el.querySelectorAll(".aee-remove-file").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault(); _aeeFiles.splice(Number(a.dataset.idx), 1); renderAeeAttachmentChips();
  }));
  el.querySelectorAll(".aee-remove-lib").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault(); _aeeLibraryIds = _aeeLibraryIds.filter((id) => id !== Number(a.dataset.id)); renderAeeAttachmentChips();
  }));
}

const aeeUploadZone = document.getElementById("aee-upload-zone");
const aeeFileInput = document.getElementById("aee-file-input");
aeeUploadZone.addEventListener("click", () => aeeFileInput.click());
aeeUploadZone.addEventListener("dragover", (e) => { e.preventDefault(); aeeUploadZone.classList.add("drag-over"); });
aeeUploadZone.addEventListener("dragleave", () => aeeUploadZone.classList.remove("drag-over"));
aeeUploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  aeeUploadZone.classList.remove("drag-over");
  _aeeFiles = _aeeFiles.concat(Array.from(e.dataTransfer.files || []));
  renderAeeAttachmentChips();
});
aeeFileInput.addEventListener("change", () => {
  _aeeFiles = _aeeFiles.concat(Array.from(aeeFileInput.files || []));
  renderAeeAttachmentChips();
});

document.getElementById("modal-add-existing-email-btn").addEventListener("click", openAddExistingEmailModal);
document.getElementById("add-existing-email-close").addEventListener("click", closeAddExistingEmailModal);
document.getElementById("aee-cancel-btn").addEventListener("click", closeAddExistingEmailModal);
document.getElementById("aee-attach-from-library-btn").addEventListener("click", () => {
  openLibraryPicker((ids) => {
    ids.forEach((id) => { if (!_aeeLibraryIds.includes(id)) _aeeLibraryIds.push(id); });
    renderAeeAttachmentChips();
  });
});

document.getElementById("aee-save-btn").addEventListener("click", async () => {
  clearInlineError("aee-error");
  const subject = document.getElementById("aee-subject").value.trim();
  const body = document.getElementById("aee-body").value.trim();
  if (!subject && !body) {
    showInlineError("aee-error", "Enter at least a subject or body.");
    return;
  }
  const form = new FormData();
  form.append("mode", document.getElementById("aee-mode").value);
  form.append("subject", subject);
  form.append("body", body);
  form.append("toEmail", document.getElementById("aee-to-email").value.trim());
  form.append("sentAt", document.getElementById("aee-sent-at").value);
  form.append("notes", document.getElementById("aee-notes").value.trim());
  form.append("libraryAttachmentIds", JSON.stringify(_aeeLibraryIds));
  _aeeFiles.forEach((f) => form.append("attachments", f));

  try {
    const r = await fetch(`/api/contacts/${_modalContact.contact_id}/imported-emails`, { method: "POST", body: form });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "Save failed");
    closeAddExistingEmailModal();
    showMessage("Email logged.", "info");
    await loadDraftLibrary(_modalContact.contact_id);
    if (document.getElementById("imported-emails-body").classList.contains("open")) {
      loadImportedEmailsPanel(_modalContact.contact_id, _modalSelectedMode);
    }
    if (_modalRefreshFn) _modalRefreshFn();
  } catch (e) {
    showInlineError("aee-error", e.message);
  }
});

// Simple read-only preview, used only by the contact-detail timeline's
// "View" button for arbitrary past interactions (not necessarily the live
// editable draft) -- keeps that lightweight rather than routing every
// historical timeline entry through the full lifecycle editor.
function renderDraft(d, contact) {
  const note = d.claude_configured === false
    ? `<div class="draft-note">⚠ Claude key not set — this is a template stub. Add a Claude key in the Config section for AI-generated drafts.</div>`
    : "";
  const fullText = `Subject: ${d.subject}\n\n${d.body}\n\n---\nFollow-up: ${d.followup}\n\nRationale: ${d.rationale}`;
  document.getElementById("modal-body").innerHTML = `
    ${note}
    <div class="draft-section">
      <div class="draft-label">Subject Line</div>
      <div class="draft-value">${escapeHtml(d.subject || "")}</div>
    </div>
    <div class="draft-section">
      <div class="draft-label">Email Body</div>
      <div class="draft-value">${escapeHtml(d.body || "")}</div>
    </div>
    <div class="draft-section">
      <div class="draft-label">Follow-up Template</div>
      <div class="draft-value">${escapeHtml(d.followup || "")}</div>
    </div>
    <div class="draft-section">
      <div class="draft-label">Why This Contact</div>
      <div class="draft-value">${escapeHtml(d.rationale || "")}</div>
    </div>
    <div class="modal-actions">
      <button class="btn-sm copy-btn" id="copy-all-btn">Copy Full Draft</button>
      <button class="btn-sm btn-ghost" id="export-draft-txt-btn">Export .txt</button>
      <button class="btn-sm btn-ghost" id="export-draft-json-btn">Export JSON</button>
    </div>`;

  document.getElementById("copy-all-btn").addEventListener("click", () => copyDraft(fullText));
  document.getElementById("export-draft-txt-btn").addEventListener("click", () => exportDraftText(fullText, contact.name));
  document.getElementById("export-draft-json-btn").addEventListener("click", () => exportDraftJson(JSON.stringify(d), contact.name));
}

function copyDraft(text) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById("copy-all-btn");
    if (btn) { btn.textContent = "Copied!"; btn.classList.add("copied"); }
    setTimeout(() => { if (btn) { btn.textContent = "Copy Full Draft"; btn.classList.remove("copied"); } }, 2000);
  }).catch(() => showMessage("Copy failed — please select and copy manually.", "error"));
}

function exportDraftText(text, name) {
  downloadFile(text, (name || "draft").replace(/\s+/g, "_") + "_email.txt", "text/plain");
}

function exportDraftJson(jsonStr, name) {
  try {
    const obj = JSON.parse(jsonStr);
    downloadFile(JSON.stringify(obj, null, 2), (name || "draft").replace(/\s+/g, "_") + "_email.json", "application/json");
  } catch (e) { showMessage("JSON export error: " + e.message, "error"); }
}

// Closing with unsaved changes prompts to save/discard rather than silently
// dropping edits.
function closeEmailModal(force) {
  if (_modalDirty && _modalComm && !force) {
    openModal("unsaved-changes-modal");
    return;
  }
  closeModal("email-modal");
}
document.getElementById("email-modal-close").addEventListener("click", () => closeEmailModal());
document.getElementById("email-modal").addEventListener("click", e => {
  if (e.target === document.getElementById("email-modal")) closeEmailModal();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeEmailModal();
    closeScanModal();
  }
});

document.getElementById("unsaved-cancel-btn").addEventListener("click", () => {
  closeModal("unsaved-changes-modal");
});
document.getElementById("unsaved-discard-btn").addEventListener("click", () => {
  _modalDirty = false;
  closeModal("unsaved-changes-modal");
  closeEmailModal(true);
});
document.getElementById("unsaved-save-btn").addEventListener("click", async () => {
  closeModal("unsaved-changes-modal");
  await saveCurrentDraft(false);
  closeEmailModal(true);
});

/* ── Auto-process: reveal emails for just-searched contacts, then hand off
   to the CRM for review/select/draft. Drafting is never triggered here --
   it's an explicit action from "Draft Emails for Selected" after the user
   has reviewed and filtered, even when several companies were searched at once. ── */

async function autoProcessContacts() {
  const total = _currentContacts.length;
  if (!total) return;

  const prog  = document.getElementById("batch-progress");
  const fill  = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");
  prog.style.display = "block";

  // Enrich contacts that have an Apollo ID, no email, and haven't been checked yet.
  // This is a data lookup (not an LLM call), so it's safe to do automatically.
  const revealable = _currentContacts
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.contact_id && c.apollo_id && !c.email
      && c.email_lookup_status !== 'not_available');

  for (let r = 0; r < revealable.length; r++) {
    const { c, i } = revealable[r];
    label.textContent = `Enriching emails… ${r + 1} / ${revealable.length}`;
    fill.style.width = Math.round(((r + 1) / (revealable.length || 1)) * 100) + "%";
    try {
      const resp = await fetch(`/api/contacts/${c.contact_id}/enrich-email`, {
        method: "POST", headers: { "Content-Type": "application/json" },
      });
      const d = await resp.json();
      if (d.email && !d.email.startsWith("(")) {
        _currentContacts[i].email = d.email;
        _currentContacts[i].email_lookup_status = 'found';
      } else {
        _currentContacts[i].email_lookup_status = d.email_lookup_status || 'not_available';
      }
    } catch (e) { /* skip */ }
  }

  fill.style.width = "100%";
  renderContacts(_currentContacts, _currentCompanies.join(", "));
  renderExportBar(_currentCompanies[0]);
  label.textContent = `Saved ${total} contact${total !== 1 ? "s" : ""} to your CRM — review, filter, and select below to draft emails.`;
  setTimeout(() => { prog.style.display = "none"; }, 4000);
  refreshUsage();

  await focusCrmOnAccounts(_currentCompanies);
}

// After a search, bring the just-saved contacts into view in the CRM
// section instead of leaving the user to hunt for them: refresh the
// Browse-by-Company options (so the new/updated account shows up), pre-select
// the searched company name(s) there, and scroll to the CRM section. Reuses
// the multi-select filter infrastructure rather than building a separate
// hand-off mechanism.
async function focusCrmOnAccounts(names) {
  if (!names || !names.length) return;
  await loadBrowseSelectors();
  if (typeof accountSelect !== "undefined" && accountSelect) accountSelect.selectByKeys(names);
  // The search ran in the Find-contacts modal; its job is done, so hand the
  // screen back to the list the results just landed in.
  if (typeof closeCrmDiscoverModal === "function") closeCrmDiscoverModal();
  const crmSection = document.getElementById("crm-toggle");
  if (crmSection) crmSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ── Email reveal ── */

async function revealEmail(idx) {
  const contact = _currentContacts[idx];
  if (!contact) return;
  const cell = document.getElementById(`email-cell-${idx}`);
  if (!contact.apollo_id && !contact.contact_id) {
    if (cell) cell.innerHTML = `<span class="email-note">No Apollo ID — cannot reveal</span>`;
    return;
  }
  if (cell) cell.innerHTML = '<span class="spinner"></span> Revealing…';
  try {
    let d;
    if (contact.contact_id) {
      const r = await fetch(`/api/contacts/${contact.contact_id}/enrich-email`, {
        method: "POST", headers: { "Content-Type": "application/json" },
      });
      d = await r.json();
    } else {
      const r = await fetch("/api/reveal-email", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apollo_id: contact.apollo_id }),
      });
      d = await r.json();
    }
    if (d.error) {
      if (cell) cell.innerHTML = `<span class="email-note">Error: ${escapeHtml(d.error)}</span>`;
      return;
    }
    const email = d.email || "(not returned by Apollo)";
    _currentContacts[idx].email = email;
    if (cell) {
      cell.className = email.startsWith("(") ? "email-note" : "";
      cell.innerHTML = escapeHtml(email);
    }
    refreshUsage();
  } catch (e) {
    if (cell) cell.innerHTML = `<span class="email-note">Error: ${escapeHtml(e.message)}</span>`;
  }
}

/* ── Messages ── */

function showMessage(text, type = "info") {
  if (typeof text === "string" && text.startsWith("CACHE:")) {
    const parts = text.split(":");
    const company  = parts[1] || "";
    const count    = parts[2] || "?";
    const savedAt  = parts.slice(3).join(":") || "previously";
    const div = document.createElement("div");
    div.className = "msg-cache";
    div.innerHTML = `<strong>${escapeHtml(company)}</strong>: loaded ${escapeHtml(count)} contact(s) from local database (saved ${escapeHtml(savedAt)}) — no Apollo credits used.`;
    document.getElementById("messages").appendChild(div);
    return;
  }
  const div = document.createElement("div");
  div.className = "msg-" + type;
  div.textContent = text;
  document.getElementById("messages").appendChild(div);
}

function clearMessages() { document.getElementById("messages").innerHTML = ""; }

// Inline, modal-scoped error banner -- reuses the same .msg-error look as
// showMessage(), but rendered inside the modal itself (a global #messages
// banner would be hidden behind the modal overlay while it's open).
function showInlineError(elId, text) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.style.display = "";
}
function clearInlineError(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = "";
  el.style.display = "none";
}

// Renders a "Search completed" panel per company after a fresh Apollo search
// (not shown for cache hits, which already get their own CACHE: message --
// found/imported/duplicate counts aren't meaningful for "loaded what we had").
function renderSearchSummary(summaries) {
  if (!summaries || !summaries.length) return;
  const container = document.getElementById("messages");
  summaries.forEach((s) => {
    const div = document.createElement("div");
    div.className = "msg-summary";
    const deptLine = s.departments && s.departments.length
      ? `Departments searched: ${s.departments.map((d) => `✓ ${escapeHtml(d)}`).join(" ")}`
      : "Departments searched: (default executive + specialist set)";
    // Report the account's before/after, not just this batch: the useful
    // question after a top-up is "how many do I have now", and "already in
    // CRM" has to read as preserved rather than discarded.
    const alreadyHeld = Number(s.alreadyHeldCount) || 0;
    div.innerHTML = `
      <div class="msg-summary-title">Search completed — ${escapeHtml(s.company)}${s.forced ? " (full refresh)" : ""}</div>
      <div class="msg-summary-row">${deptLine}</div>
      <div class="msg-summary-stats">
        <span>Returned by Apollo: <b>${s.foundCount}</b></span>
        <span>Already in CRM (kept as-is): <b>${alreadyHeld}</b></span>
        <span>Newly imported: <b>${s.importedCount}</b></span>
        ${s.totalCount !== undefined ? `<span>Total for this company: <b>${s.totalCount}</b>${s.target ? ` / ${s.target} requested` : ""}</span>` : ""}
      </div>`;
    container.appendChild(div);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}

/* ── Usage bar ── */

function fmtTokens(n) { return Number(n || 0).toLocaleString(); }

async function refreshUsage() {
  try {
    const r = await fetch("/api/usage");
    const d = await r.json();
    const ai = d.ai || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("u-apollo-people", d.apollo_people_calls);
    set("u-apollo-org", d.apollo_org_calls);
    set("u-ai-company", ai.company_analyses || 0);
    set("u-ai-contact", ai.contact_analyses || 0);
    set("u-ai-product", ai.product_matches || 0);
    set("u-claude-calls", ai.drafts || 0);
    set("u-claude-in", fmtTokens(ai.input_tokens));
    set("u-claude-out", fmtTokens(ai.output_tokens));
    set("u-total", fmtTokens(ai.total_tokens));
    set("u-cost", "$" + Number(ai.cost_usd || 0).toFixed(4));
    set("u-saved-tokens", fmtTokens(ai.saved_total));
    set("u-saved-cost", "$" + Number(ai.saved_cost_usd || 0).toFixed(2));
  } catch (e) { /* silent */ }
}

document.getElementById("usage-reset-btn").addEventListener("click", async () => {
  await fetch("/api/usage/reset", { method: "POST" });
  refreshUsage();
});
document.getElementById("usage-details-btn").addEventListener("click", () => showView("ai-usage"));
document.getElementById("ai-usage-close").addEventListener("click", () => closeModal("ai-usage-modal"));
document.getElementById("draft-preview-close").addEventListener("click", () => closeModal("draft-preview-modal"));
document.getElementById("ai-usage-modal").addEventListener("click", (e) => {
  if (e.target === document.getElementById("ai-usage-modal")) closeModal("ai-usage-modal");
});

/* ── Detailed AI Usage & Budget modal ── */
const AI_FEATURE_LABELS = {
  company_research: "Company research", email_draft: "Email drafts", contact_intel: "Contact intelligence",
  product_match: "Product matching", attachment_rec: "Attachment recs", email_classify: "Email classify", other: "Other",
};

async function openAiUsageModal() {
  openModal("ai-usage-modal");
  const body = document.getElementById("ai-usage-body");
  body.innerHTML = '<div style="text-align:center;padding:24px 0;"><span class="spinner"></span> Loading…</div>';
  try {
    const r = await fetch("/api/ai-usage?period=all");
    const d = await r.json();
    if (!d.ok) { body.innerHTML = `<div class="msg-error">${escapeHtml(d.error || "Failed")}</div>`; return; }
    renderAiUsage(d);
  } catch (e) { body.innerHTML = `<div class="msg-error">${escapeHtml(e.message)}</div>`; }
}

function aiTotalsCard(title, t) {
  return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;">
      <div style="font-size:0.72rem;color:#6b7280;text-transform:uppercase;letter-spacing:.03em;">${escapeHtml(title)}</div>
      <div style="font-size:1.05rem;font-weight:700;color:#111827;margin-top:2px;">${fmtTokens(t.total_tokens)} <span style="font-size:0.72rem;font-weight:400;color:#9ca3af;">tokens</span></div>
      <div style="font-size:0.74rem;color:#6b7280;">${fmtTokens(t.input_tokens)} in / ${fmtTokens(t.output_tokens)} out · $${Number(t.cost_usd).toFixed(2)}</div>
      <div style="font-size:0.74rem;color:#059669;">Saved ${fmtTokens(t.saved_total)} ($${Number(t.saved_cost_usd).toFixed(2)})</div>
    </div>`;
}

function renderAiUsage(d) {
  const body = document.getElementById("ai-usage-body");
  const s = d.session || {};
  const bs = d.budget_status || {};
  const b = d.budget || {};

  let html = `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px;">
      ${aiTotalsCard("Session", { total_tokens: s.total_tokens, input_tokens: s.input_tokens, output_tokens: s.output_tokens, cost_usd: s.cost_usd, saved_total: s.saved_total, saved_cost_usd: s.saved_cost_usd })}
      ${aiTotalsCard("Today", d.today)}
      ${aiTotalsCard("This month", d.month)}
      ${aiTotalsCard("All time", d.all)}
    </div>`;

  // Budget status
  if (b.daily_token_budget || b.monthly_token_budget) {
    const bar = (pct, over, warn) => `<span style="color:${over ? '#dc2626' : warn ? '#0C579A' : '#059669'};font-weight:600;">${pct}%</span>`;
    html += `<div style="font-size:0.78rem;color:#374151;margin-bottom:12px;">Budget used —
        ${b.daily_token_budget ? `Daily: ${bar(bs.daily_pct, bs.daily_over, bs.daily_warn)} of ${fmtTokens(b.daily_token_budget)}` : ""}
        ${b.daily_token_budget && b.monthly_token_budget ? " · " : ""}
        ${b.monthly_token_budget ? `Monthly: ${bar(bs.monthly_pct, bs.monthly_over, bs.monthly_warn)} of ${fmtTokens(b.monthly_token_budget)}` : ""}
      </div>`;
  }

  // By feature (all-time)
  html += `<h3 style="font-size:0.86rem;margin:6px 0 6px;">By feature (all time)</h3>
    <table class="intel-matrix-table" style="margin-bottom:14px;"><thead><tr>
      <th>Feature</th><th>AI calls</th><th>Reuses</th><th>Tokens</th><th>Cost</th><th>Saved</th></tr></thead><tbody>`;
  (d.by_feature || []).forEach((f) => {
    html += `<tr><td>${escapeHtml(AI_FEATURE_LABELS[f.feature] || f.feature)}</td>
      <td>${f.new_calls}</td><td>${f.reuses}</td>
      <td>${fmtTokens((f.input_tokens || 0) + (f.output_tokens || 0))}</td>
      <td>$${Number(f.cost_usd).toFixed(2)}</td>
      <td style="color:#059669;">${fmtTokens(f.saved_total)} ($${Number(f.saved_cost_usd).toFixed(2)})</td></tr>`;
  });
  if (!(d.by_feature || []).length) html += `<tr><td colspan="6" style="color:#9ca3af;">No AI usage recorded yet.</td></tr>`;
  html += `</tbody></table>`;

  // By company (top spenders)
  html += `<h3 style="font-size:0.86rem;margin:6px 0 6px;">Top companies by cost (all time)</h3>
    <table class="intel-matrix-table" style="margin-bottom:14px;"><thead><tr>
      <th>Company</th><th>AI calls</th><th>Reuses</th><th>Tokens</th><th>Cost</th><th>Saved</th></tr></thead><tbody>`;
  (d.by_company || []).forEach((c) => {
    html += `<tr><td>${escapeHtml(c.company_name || ("#" + c.company_id))}</td>
      <td>${c.new_calls}</td><td>${c.reuses}</td><td>${fmtTokens(c.total_tokens)}</td>
      <td>$${Number(c.cost_usd).toFixed(2)}</td>
      <td style="color:#059669;">${fmtTokens(c.saved_total)} ($${Number(c.saved_cost_usd).toFixed(2)})</td></tr>`;
  });
  if (!(d.by_company || []).length) html += `<tr><td colspan="6" style="color:#9ca3af;">No per-company usage yet.</td></tr>`;
  html += `</tbody></table>`;

  // Budget config form
  html += `<h3 style="font-size:0.86rem;margin:10px 0 6px;">Budgets & limits</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:0.8rem;">
      <label>Daily token budget (0 = off)<input type="number" id="aib-daily" value="${b.daily_token_budget || 0}" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;"></label>
      <label>Monthly token budget (0 = off)<input type="number" id="aib-monthly" value="${b.monthly_token_budget || 0}" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;"></label>
      <label>Warning threshold (%)<input type="number" id="aib-warn" value="${b.warn_threshold_pct || 80}" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;"></label>
      <label>Max tokens per request (0 = default)<input type="number" id="aib-maxreq" value="${b.max_tokens_per_request || 0}" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;"></label>
      <label style="grid-column:1/3;"><input type="checkbox" id="aib-autooff" ${b.auto_refresh_disabled ? "checked" : ""}> Disable automatic AI refreshes (all AI runs require an explicit click)</label>
    </div>
    <button class="btn-sm btn-orange" id="aib-save" style="margin-top:10px;">Save budgets</button>`;

  body.innerHTML = html;
  document.getElementById("aib-save").addEventListener("click", saveAiBudget);
}

async function saveAiBudget() {
  const payload = {
    daily_token_budget: document.getElementById("aib-daily").value,
    monthly_token_budget: document.getElementById("aib-monthly").value,
    warn_threshold_pct: document.getElementById("aib-warn").value,
    max_tokens_per_request: document.getElementById("aib-maxreq").value,
    auto_refresh_disabled: document.getElementById("aib-autooff").checked,
  };
  try {
    const r = await fetch("/api/ai-usage/budget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (d.ok) { showMessage("Budgets saved.", "info"); openAiUsageModal(); }
    else showMessage(d.error || "Failed to save budgets", "error");
  } catch (e) { showMessage("Save failed: " + e.message, "error"); }
}

/* =======================================================================
   Scan Business Card modal
   ======================================================================= */

const scanModal = document.getElementById("scan-modal");
const scanFileInput = document.getElementById("scan-file-input");
const scanBtn = document.getElementById("scan-btn");
const scanRetakeBtn = document.getElementById("scan-retake-btn");
const scanViewfinder = document.getElementById("viewfinder");
const scanPlaceholder = document.getElementById("scan-placeholder");
const scanPreview = document.getElementById("scan-preview");
const scanStatusLine = document.getElementById("scan-status-line");
const scanReviewForm = document.getElementById("scan-review-form");
const scanSaveBtn = document.getElementById("scan-save-btn");
const scanEnrichBadge = document.getElementById("scan-enrich-badge");
const matchedContactBanner = document.getElementById("matched-contact-banner");
const scanRawToggle = document.getElementById("scan-raw-toggle");
const scanRawText = document.getElementById("scan-raw-text");

const sfFields = ["name", "title", "company", "phone", "email", "website", "linkedin", "address", "notes"];
const sfEls = Object.fromEntries(sfFields.map(f => [f, document.getElementById("sf_" + f)]));

let _scanApolloRaw = null;
let _scanApolloPersonId = "";
let _scanMatchedContactId = null;
let _scanImageData = null;
let _scanOcrText = "";

document.getElementById("open-scan-modal-btn").addEventListener("click", () => {
  openModal("scan-modal");
});
document.getElementById("scan-modal-close").addEventListener("click", closeScanModal);
scanModal.addEventListener("click", e => { if (e.target === scanModal) closeScanModal(); });

function closeScanModal() {
  closeModal("scan-modal");
  resetScanCapture();
}

scanBtn.addEventListener("click", () => scanFileInput.click());
scanRetakeBtn.addEventListener("click", resetScanCapture);

scanRawToggle.addEventListener("click", () => {
  scanRawText.classList.toggle("visible");
  scanRawToggle.textContent = scanRawText.classList.contains("visible") ? "hide raw scanned text" : "show raw scanned text";
});

scanFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const dataUrl = await fileToDataUrl(file);
  _scanImageData = dataUrl;

  scanPlaceholder.style.display = "none";
  scanPreview.style.display = "block";
  scanPreview.src = dataUrl;
  scanRetakeBtn.style.display = "inline-block";

  await runCardScan(dataUrl);
});

async function runCardScan(dataUrl) {
  scanViewfinder.classList.add("scanning");
  scanStatusLine.textContent = "Reading card…";
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning…";
  scanReviewForm.classList.remove("visible");

  try {
    const res = await fetch("/api/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Scan failed");

    _scanOcrText = data._ocrTextForCard || "";
    populateScanForm(data.fields);
    _scanApolloRaw = data.apolloRaw || null;
    _scanApolloPersonId = data.apolloPersonId || "";
    _scanMatchedContactId = data.matchedContactId || null;

    matchedContactBanner.style.display = _scanMatchedContactId ? "block" : "none";

    if (data.enriched) {
      scanEnrichBadge.style.display = "inline-block";
      if (data.enrichedFromSavedContact) scanEnrichBadge.textContent = "enriched from saved contact";
      else if (data.enrichedFromCache) scanEnrichBadge.textContent = "enriched via Apollo (cached)";
      else scanEnrichBadge.textContent = "enriched via Apollo";
    } else {
      scanEnrichBadge.style.display = "none";
    }

    scanStatusLine.textContent = "Scan complete — check the details below.";
    scanReviewForm.classList.add("visible");
  } catch (e) {
    scanStatusLine.textContent = "Could not read that card. Try again or enter details manually.";
    populateScanForm({});
    scanReviewForm.classList.add("visible");
  } finally {
    scanViewfinder.classList.remove("scanning");
    scanBtn.disabled = false;
    scanBtn.textContent = "Scan a card";
  }
}

function populateScanForm(f) {
  sfEls.name.value = f.full_name || "";
  sfEls.title.value = f.job_title || "";
  sfEls.company.value = f.company || "";
  sfEls.phone.value = f.phone || "";
  sfEls.email.value = f.email || "";
  sfEls.website.value = f.website || "";
  sfEls.linkedin.value = f.linkedin_url || "";
  sfEls.address.value = f.address || "";
  sfEls.notes.value = "";
  scanRawText.textContent = _scanOcrText || "(no text found)";
  scanRawText.classList.remove("visible");
  scanRawToggle.textContent = "show raw scanned text";
}

function getScanContext() {
  return {
    event: document.getElementById("ctx-event").value.trim(),
    booth_number: document.getElementById("ctx-booth").value.trim(),
    meeting_date: document.getElementById("ctx-date").value.trim(),
    assigned_salesperson: document.getElementById("ctx-salesperson").value.trim(),
  };
}

scanSaveBtn.addEventListener("click", async () => {
  const ctx = getScanContext();
  const payload = {
    full_name: sfEls.name.value.trim(),
    job_title: sfEls.title.value.trim(),
    company: sfEls.company.value.trim(),
    phone: sfEls.phone.value.trim(),
    email: sfEls.email.value.trim(),
    website: sfEls.website.value.trim(),
    linkedin_url: sfEls.linkedin.value.trim(),
    address: sfEls.address.value.trim(),
    notes: sfEls.notes.value.trim(),
    raw_text: scanRawText.textContent,
    apollo_person_id: _scanApolloPersonId || "",
    apollo_raw_json: _scanApolloRaw ? JSON.stringify(_scanApolloRaw) : "",
    source: "business_card",
    _cardImage: _scanImageData || "",
    _cardOcrText: _scanOcrText || "",
    event_name: ctx.event,
    booth_number: ctx.booth_number,
    meeting_date: ctx.meeting_date,
    assigned_salesperson: ctx.assigned_salesperson,
  };

  scanSaveBtn.disabled = true;
  scanSaveBtn.textContent = "Saving…";
  try {
    const res = await fetch("/api/contacts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Save failed");

    showMessage(data.updated ? "Existing contact updated from scanned card." : "Contact saved from scanned card.", "info");
    closeScanModal();
  } catch (e) {
    showMessage("Could not save contact: " + e.message, "error");
  } finally {
    scanSaveBtn.disabled = false;
    scanSaveBtn.textContent = "Save to database";
  }
});

function resetScanCapture() {
  _scanImageData = null;
  _scanApolloRaw = null;
  _scanApolloPersonId = "";
  _scanMatchedContactId = null;
  _scanOcrText = "";
  scanFileInput.value = "";
  scanPreview.style.display = "none";
  scanPlaceholder.style.display = "block";
  scanRetakeBtn.style.display = "none";
  scanReviewForm.classList.remove("visible");
  matchedContactBanner.style.display = "none";
  scanStatusLine.textContent = "";

  _batchFiles = [];
  if (typeof renderBatchFileList === "function") renderBatchFileList();
  if (batchResultsEl) batchResultsEl.innerHTML = "";
  if (batchProgressWrap) batchProgressWrap.style.display = "none";
  if (batchFileInput) batchFileInput.value = "";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ── Single / Batch mode toggle ── */

const modeSingleBtn = document.getElementById("mode-single-btn");
const modeBatchBtn = document.getElementById("mode-batch-btn");
const singleScanPanel = document.getElementById("single-scan-panel");
const batchScanPanel = document.getElementById("batch-scan-panel");

function setScanMode(mode) {
  const isSingle = mode === "single";
  singleScanPanel.style.display = isSingle ? "block" : "none";
  batchScanPanel.style.display = isSingle ? "none" : "block";
  modeSingleBtn.style.background = isSingle ? "#4E2A84" : "#fff";
  modeSingleBtn.style.color = isSingle ? "#fff" : "#555";
  modeBatchBtn.style.background = isSingle ? "#fff" : "#4E2A84";
  modeBatchBtn.style.color = isSingle ? "#555" : "#fff";
}
modeSingleBtn.addEventListener("click", () => setScanMode("single"));
modeBatchBtn.addEventListener("click", () => setScanMode("batch"));

/* ── Batch upload: file selection (click, drag-drop, multi-select) ── */

const batchUploadZone = document.getElementById("batch-upload-zone");
const batchFileInput = document.getElementById("batch-file-input");
const batchFileList = document.getElementById("batch-file-list");
const batchProcessBtn = document.getElementById("batch-process-btn");
const batchProgressWrap = document.getElementById("batch-progress-wrap");
const batchProgressLabel = document.getElementById("batch-progress-label");
const batchProgressFill = document.getElementById("batch-progress-fill");
const batchResultsEl = document.getElementById("batch-results");

let _batchFiles = [];

batchUploadZone.addEventListener("click", () => batchFileInput.click());
batchUploadZone.addEventListener("dragover", (e) => { e.preventDefault(); batchUploadZone.classList.add("drag-over"); });
batchUploadZone.addEventListener("dragleave", () => batchUploadZone.classList.remove("drag-over"));
batchUploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  batchUploadZone.classList.remove("drag-over");
  addBatchFiles(Array.from(e.dataTransfer.files || []));
});
batchFileInput.addEventListener("change", () => {
  addBatchFiles(Array.from(batchFileInput.files || []));
});

function addBatchFiles(files) {
  const accepted = files.filter(f =>
    f.type.startsWith("image/") || /\.(heic|heif|pdf)$/i.test(f.name)
  );
  _batchFiles = _batchFiles.concat(accepted);
  renderBatchFileList();
}

function renderBatchFileList() {
  if (!_batchFiles.length) {
    batchFileList.innerHTML = "";
    batchProcessBtn.disabled = true;
    return;
  }
  batchFileList.innerHTML =
    `<strong>${_batchFiles.length} file(s) selected:</strong><br>` +
    _batchFiles.map((f, i) =>
      `${escapeHtml(f.name)} (${(f.size / 1024).toFixed(0)} KB) <a href="#" class="remove-batch-file" data-idx="${i}" style="color:#dc2626;">remove</a>`
    ).join("<br>");
  batchProcessBtn.disabled = false;

  batchFileList.querySelectorAll(".remove-batch-file").forEach(a => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      _batchFiles.splice(Number(a.dataset.idx), 1);
      renderBatchFileList();
    });
  });
}

/* ── Batch upload: process all selected files ── */

batchProcessBtn.addEventListener("click", async () => {
  if (!_batchFiles.length) return;
  const ctx = getScanContext();

  batchProcessBtn.disabled = true;
  batchProgressWrap.style.display = "block";
  batchResultsEl.innerHTML = "";
  const allResults = [];
  const total = _batchFiles.length;

  for (let i = 0; i < total; i++) {
    const file = _batchFiles[i];
    batchProgressLabel.textContent = `Processing ${i + 1} / ${total}: ${file.name}…`;
    batchProgressFill.style.width = Math.round((i / total) * 100) + "%";

    const form = new FormData();
    form.append("file", file);
    if (ctx.event) form.append("event", ctx.event);
    if (ctx.booth_number) form.append("booth_number", ctx.booth_number);
    if (ctx.meeting_date) form.append("meeting_date", ctx.meeting_date);
    if (ctx.assigned_salesperson) form.append("assigned_salesperson", ctx.assigned_salesperson);

    try {
      const res = await fetch("/api/scan-batch-file", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        allResults.push({ pageLabel: file.name, success: false, error: data.error || "Upload failed" });
      } else {
        allResults.push(...data.results);
      }
    } catch (e) {
      allResults.push({ pageLabel: file.name, success: false, error: e.message });
    }
  }

  batchProgressFill.style.width = "100%";
  const succeeded = allResults.filter(r => r.success);
  const failed = allResults.filter(r => !r.success);
  batchProgressLabel.textContent = `Done — ${succeeded.length} card(s) saved${failed.length ? `, ${failed.length} failed` : ""}.`;

  renderBatchResults(allResults);
  _batchFiles = [];
  renderBatchFileList();
  loadCrmContacts(document.getElementById("crm-search-input").value);
  batchProcessBtn.disabled = false;
});

function renderBatchResults(results) {
  batchResultsEl.innerHTML = results.map(r => {
    if (r.success) {
      const statusLabel = r.updated ? "updated existing" : "new contact";
      const cacheNote = r.matchedContactId ? " · matched saved contact, no Apollo call" : "";
      return `<div class="msg-cache">
        <strong>${escapeHtml(r.full_name || "Unnamed")}</strong> — ${escapeHtml(r.company || "")}
        (${statusLabel}${cacheNote}) — from ${escapeHtml(r.pageLabel)}
      </div>`;
    }
    return `<div class="msg-error">${escapeHtml(r.pageLabel)}: ${escapeHtml(r.error)}</div>`;
  }).join("");
}

/* =======================================================================
   CRM: saved contacts & companies browser
   ======================================================================= */

let _crmContacts = [];
// Paging lives in _grid now (page + pageSize), because the server owns it.

// The CRM card used to be collapsible, from when every section shared one
// scrolling page. With a dedicated nav view there is nothing to collapse it
// *for*, so #crm-toggle is now just the page header (and the scroll anchor
// other flows still jump to).

function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// Merged, persistent filter state -- every control (existing filter inputs,
// the Browse-by-Company/Contact selectors, the Clear buttons) updates only
// its own key here so filters combine instead of clobbering each other.
let _crmActiveFilters = {};

/* ═══════════════════════════════════════════════════════════════════════
   Excel-style column filters for the contact grid.

   Three rules shape this code:

   1. The browser never holds the table. Every filter, sort and page is a
      query parameter; the server returns one page plus a true total. The
      grid is specified to scale to hundreds of thousands of contacts, and
      that is only true if nothing here ever calls .filter() on rows.

   2. The menus are built from the server's vocabulary, not a copy of it.
      Option keys come from /api/contacts/grid-vocab and counts from
      /api/contacts/facets, so a menu can never offer an option the SQL
      doesn't implement.

   3. Changes apply live. There is no Apply button: an Apply button in a
      filter menu is a second thing to forget, and the counts already tell
      you what a click will do before you make it.
   ═══════════════════════════════════════════════════════════════════════ */

const _grid = { columns: {}, sort: null, page: 1, pageSize: 25 };
let _crmTotal = 0;
let _crmTotalPages = 1;
let _gridVocab = null;
let _gridMenuCol = null;

// Per-column sort wording. "A → Z" is meaningless on a date or a count, and
// a grid that says it anyway reads as machine-generated.
const SORT_LABELS = {
  contact:  ["Sort A → Z 升序", "Sort Z → A 降序"],
  company:  ["Sort A → Z 升序", "Sort Z → A 降序"],
  email:    ["Sort A → Z 升序", "Sort Z → A 降序"],
  tags:     ["Sort A → Z 升序", "Sort Z → A 降序"],
  status:   ["Sort A → Z 升序", "Sort Z → A 降序"],
  source:   ["Sort A → Z 升序", "Sort Z → A 降序"],
  activity: ["Oldest first 最早在前", "Newest first 最近在前"],
  draft:    ["Fewest first 最少在前", "Most first 最多在前"],
};

async function gridVocab() {
  if (_gridVocab) return _gridVocab;
  const r = await fetch("/api/contacts/grid-vocab");
  _gridVocab = (await r.json());
  return _gridVocab;
}

/* Shared by the row query and the facet queries, so the menu counts are
   always computed against exactly the filter set the grid is showing. */
function gridQueryParams(query) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  Object.entries(_crmActiveFilters).forEach(([k, v]) => {
    if (Array.isArray(v)) { if (v.length) params.set(k, v.join(",")); }
    else if (v) params.set(k, v);
  });
  if (Object.keys(_grid.columns).length) params.set("columns", JSON.stringify(_grid.columns));
  if (_grid.sort) { params.set("sort", _grid.sort.column); params.set("dir", _grid.sort.direction); }
  return params;
}

function crmSearchTerm() {
  const el = document.getElementById("crm-search-input");
  return el ? el.value.trim() : "";
}

async function gridFacets(column, search) {
  const params = gridQueryParams(crmSearchTerm());
  params.set("column", column);
  if (search) params.set("search", search);
  try {
    const r = await fetch("/api/contacts/facets?" + params.toString());
    const d = await r.json();
    return d.options || [];
  } catch (e) {
    console.error("facets:", e);
    return [];
  }
}

/* ── Menu plumbing ──────────────────────────────────────────────────── */

function closeColumnMenu() {
  const menu = document.getElementById("crm-col-menu");
  if (menu) { menu.hidden = true; menu.innerHTML = ""; }
  _gridMenuCol = null;
}

function positionMenu(menu, btn) {
  const r = btn.getBoundingClientRect();
  menu.hidden = false;
  // Measure after unhiding, then flip left if the menu would overflow the
  // viewport — the rightmost columns are exactly where filters get used.
  const w = menu.offsetWidth;
  let left = r.left + window.scrollX;
  if (left + w > window.scrollX + document.documentElement.clientWidth - 8) {
    left = r.right + window.scrollX - w;
  }
  menu.style.left = Math.max(8, left) + "px";
  menu.style.top = (r.bottom + window.scrollY + 4) + "px";
}

function sortSectionHtml(col) {
  const [asc, desc] = SORT_LABELS[col] || SORT_LABELS.contact;
  const active = _grid.sort && _grid.sort.column === col ? _grid.sort.direction : null;
  return `
    <button class="cm-item" data-sort="asc">${active === "asc" ? "✓ " : ""}↑ ${asc}</button>
    <button class="cm-item" data-sort="desc">${active === "desc" ? "✓ " : ""}↓ ${desc}</button>
    ${_grid.sort && _grid.sort.column === col
      ? `<button class="cm-item" data-sort="clear">✕ Clear sort 清除排序</button>` : ""}
    <div class="cm-divider"></div>`;
}

function footHtml(col) {
  const has = Boolean(_grid.columns[col]);
  return `
    <div class="cm-foot">
      <button class="btn-sm btn-ghost" data-act="clear-col" ${has ? "" : "disabled"}>Clear 清除</button>
      <button class="btn-sm btn-primary" data-act="done">Done 完成</button>
    </div>`;
}

/* A checkbox list of vocabulary options, annotated with live counts. The
   count is the point: it turns "Reply received" from a guess into a
   statement about this dataset. */
function optionListHtml(options, counts, selected) {
  const byKey = Object.fromEntries((counts || []).map((c) => [c.key, c.n]));
  return options.map((o) => {
    const n = byKey[o.key] ?? 0;
    return `<label class="cm-item ${n === 0 ? "cm-zero" : ""}">
      <input type="checkbox" value="${escapeAttr(o.key)}" ${selected.includes(o.key) ? "checked" : ""}>
      <span>${escapeHtml(o.label)} ${escapeHtml(o.label_cn || "")}</span>
      <span class="cm-count">${n}</span>
    </label>`;
  }).join("");
}

async function openColumnMenu(col, btn) {
  if (_gridMenuCol === col) { closeColumnMenu(); return; }
  const menu = document.getElementById("crm-col-menu");
  _gridMenuCol = col;
  menu.innerHTML = `<div class="cm-section" style="color:#9ca3af">Loading… 加载中…</div>`;
  positionMenu(menu, btn);

  const vocab = await gridVocab();
  if (_gridMenuCol !== col) return;                 // user moved on while loading
  menu.innerHTML = await columnMenuHtml(col, vocab);
  positionMenu(menu, btn);
  wireColumnMenu(col, menu, btn);
}

async function columnMenuHtml(col, vocab) {
  const cur = _grid.columns[col] || {};
  const sort = sortSectionHtml(col);

  if (col === "contact") {
    const modes = [
      ["contains", "Contains 包含"], ["starts", "Starts with 开头为"],
      ["ends", "Ends with 结尾为"], ["equals", "Is exactly 完全等于"],
    ];
    const mode = cur.mode && cur.mode !== "empty" && cur.mode !== "notEmpty" ? cur.mode : "contains";
    return `${sort}
      <div class="cm-title">Search by name 按姓名搜索</div>
      <div class="cm-section">
        <select data-f="mode" style="margin-bottom:5px;">
          ${modes.map(([k, l]) => `<option value="${k}" ${mode === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <input type="text" data-f="value" placeholder="Type a name… 输入姓名…"
               value="${escapeAttr(cur.mode === "empty" || cur.mode === "notEmpty" ? "" : (cur.value || ""))}">
      </div>
      <div class="cm-divider"></div>
      <button class="cm-item" data-f="empty">${cur.mode === "empty" ? "✓ " : ""}Empty 为空</button>
      <button class="cm-item" data-f="notEmpty">${cur.mode === "notEmpty" ? "✓ " : ""}Not empty 非空</button>
      ${footHtml(col)}`;
  }

  if (col === "company" || col === "tags") {
    const selected = cur.values || [];
    const counts = await gridFacets(col, "");
    const isTags = col === "tags";
    const list = counts.length
      ? counts.map((o) => `<label class="cm-item ${o.n === 0 ? "cm-zero" : ""}">
            <input type="checkbox" value="${escapeAttr(o.key)}" ${selected.includes(o.key) ? "checked" : ""}>
            <span>${escapeHtml(o.name_cn ? `${o.key} ${o.name_cn}` : o.key)}</span>
            <span class="cm-count">${o.n}</span>
          </label>`).join("")
      : `<div class="cm-hint">${isTags
            ? "No tags applied to contacts yet 尚无联系人标签"
            : "No companies match 无匹配公司"}</div>`;
    // Any values already chosen but absent from the current facet page still
    // need a way back off — otherwise a filter could become unremovable from
    // its own menu.
    const orphans = selected.filter((v) => !counts.some((o) => o.key === v));
    return `${sort}
      <div class="cm-section">
        <input type="text" data-f="search" placeholder="${isTags ? "Search tags 搜索标签" : "Search companies 搜索公司"}">
      </div>
      ${isTags ? `
      <div class="cm-title">Match 匹配方式</div>
      <div class="cm-radio-row">
        <label class="cm-inline"><input type="radio" name="tagmatch" value="any" ${cur.match !== "all" ? "checked" : ""}> Any selected 任一</label>
        <label class="cm-inline"><input type="radio" name="tagmatch" value="all" ${cur.match === "all" ? "checked" : ""}> All selected 全部</label>
      </div>` : ""}
      <div class="cm-scroll" data-f="list">
        ${orphans.map((v) => `<label class="cm-item"><input type="checkbox" value="${escapeAttr(v)}" checked><span>${escapeHtml(v)}</span></label>`).join("")}
        ${list}
      </div>
      ${footHtml(col)}`;
  }

  if (col === "email") {
    const counts = await gridFacets("email", "");
    return `${sort}
      <div class="cm-scroll">${optionListHtml(vocab.email, counts, cur.modes || [])}</div>
      <div class="cm-divider"></div>
      <div class="cm-title">Contains domain 包含域名</div>
      <div class="cm-section">
        <input type="text" data-f="domain" placeholder="@tesla.com" value="${escapeAttr(cur.domain || "")}">
      </div>
      ${footHtml(col)}`;
  }

  if (col === "activity") {
    const counts = await gridFacets("activity", "");
    const within = cur.within || (cur.from || cur.to ? "custom" : "any");
    return `${sort}
      <div class="cm-scroll">${optionListHtml(vocab.activity, counts, cur.states || [])}</div>
      <div class="cm-divider"></div>
      <div class="cm-title">Last activity 最近活动</div>
      <div class="cm-section" style="display:flex;flex-direction:column;gap:4px;">
        <label class="cm-inline"><input type="radio" name="actwhen" value="any" ${within === "any" ? "checked" : ""}> Any time 不限时间</label>
        <label class="cm-inline"><input type="radio" name="actwhen" value="7d" ${within === "7d" ? "checked" : ""}> Last 7 days 近 7 天</label>
        <label class="cm-inline"><input type="radio" name="actwhen" value="30d" ${within === "30d" ? "checked" : ""}> Last 30 days 近 30 天</label>
        <label class="cm-inline"><input type="radio" name="actwhen" value="custom" ${within === "custom" ? "checked" : ""}> Custom range 自定义</label>
        <div data-f="range" style="display:${within === "custom" ? "flex" : "none"};gap:5px;margin-top:3px;">
          <input type="date" data-f="from" value="${escapeAttr(cur.from || "")}">
          <input type="date" data-f="to" value="${escapeAttr(cur.to || "")}">
        </div>
      </div>
      ${footHtml(col)}`;
  }

  // status / source / draft — plain vocabulary checkbox lists.
  const key = col === "draft" ? "states" : "values";
  const counts = await gridFacets(col, "");
  return `${sort}
    <div class="cm-scroll">${optionListHtml(vocab[col], counts, cur[key] || [])}</div>
    ${footHtml(col)}`;
}

/* ── Applying ───────────────────────────────────────────────────────── */

function setColumnFilter(col, spec) {
  if (spec && Object.keys(spec).length) _grid.columns[col] = spec;
  else delete _grid.columns[col];
  _grid.page = 1;                       // a narrower list makes page 7 meaningless
  loadCrmContacts(crmSearchTerm());
}

function checkedValues(menu) {
  return Array.from(menu.querySelectorAll('.cm-scroll input[type="checkbox"]:checked')).map((c) => c.value);
}

function wireColumnMenu(col, menu, btn) {
  const rerender = async () => {
    // Counts shift as filters change; re-render so the menu keeps telling
    // the truth about the *current* filter set rather than the one it opened with.
    menu.innerHTML = await columnMenuHtml(col, await gridVocab());
    positionMenu(menu, btn);
    wireColumnMenu(col, menu, btn);
  };

  menu.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {
    const d = b.dataset.sort;
    _grid.sort = d === "clear" ? null : { column: col, direction: d };
    loadCrmContacts(crmSearchTerm());
    closeColumnMenu();
  }));

  const foot = (act) => menu.querySelector(`[data-act="${act}"]`);
  if (foot("done")) foot("done").addEventListener("click", closeColumnMenu);
  if (foot("clear-col")) foot("clear-col").addEventListener("click", () => { setColumnFilter(col, null); closeColumnMenu(); });

  if (col === "contact") {
    const modeEl = menu.querySelector('[data-f="mode"]');
    const valEl = menu.querySelector('[data-f="value"]');
    const apply = () => {
      const v = valEl.value.trim();
      setColumnFilter(col, v ? { mode: modeEl.value, value: v } : null);
    };
    valEl.addEventListener("input", debounce(apply, 350));
    modeEl.addEventListener("change", apply);
    valEl.focus();
    menu.querySelector('[data-f="empty"]').addEventListener("click", () => {
      setColumnFilter(col, _grid.columns[col] && _grid.columns[col].mode === "empty" ? null : { mode: "empty", value: "" });
      closeColumnMenu();
    });
    menu.querySelector('[data-f="notEmpty"]').addEventListener("click", () => {
      setColumnFilter(col, _grid.columns[col] && _grid.columns[col].mode === "notEmpty" ? null : { mode: "notEmpty", value: "" });
      closeColumnMenu();
    });
    return;
  }

  if (col === "company" || col === "tags") {
    const search = menu.querySelector('[data-f="search"]');
    const readMatch = () => {
      const r = menu.querySelector('input[name="tagmatch"]:checked');
      return r ? r.value : "any";
    };
    const apply = () => {
      const values = checkedValues(menu)
        .concat(Array.from(menu.querySelectorAll('.cm-scroll > label > input:checked')).map((c) => c.value))
        .filter((v, i, a) => a.indexOf(v) === i);
      setColumnFilter(col, values.length
        ? (col === "tags" ? { values, match: readMatch() } : { values })
        : null);
    };
    menu.querySelectorAll('.cm-scroll input[type="checkbox"]').forEach((c) => c.addEventListener("change", apply));
    menu.querySelectorAll('input[name="tagmatch"]').forEach((r) => r.addEventListener("change", apply));
    if (search) {
      search.addEventListener("input", debounce(async () => {
        const list = menu.querySelector('[data-f="list"]');
        const term = search.value.trim();
        const counts = await gridFacets(col, term);
        const selected = (_grid.columns[col] || {}).values || [];
        list.innerHTML = counts.length
          ? counts.map((o) => `<label class="cm-item ${o.n === 0 ? "cm-zero" : ""}">
              <input type="checkbox" value="${escapeAttr(o.key)}" ${selected.includes(o.key) ? "checked" : ""}>
              <span>${escapeHtml(o.name_cn ? `${o.key} ${o.name_cn}` : o.key)}</span>
              <span class="cm-count">${o.n}</span></label>`).join("")
          : `<div class="cm-hint">No matches 无匹配</div>`;
        list.querySelectorAll('input[type="checkbox"]').forEach((c) => c.addEventListener("change", apply));
      }, 300));
      search.focus();
    }
    return;
  }

  if (col === "email") {
    const domainEl = menu.querySelector('[data-f="domain"]');
    const apply = () => {
      const modes = checkedValues(menu);
      const domain = domainEl.value.trim();
      setColumnFilter(col, modes.length || domain ? { modes, domain } : null);
    };
    menu.querySelectorAll('.cm-scroll input[type="checkbox"]').forEach((c) => c.addEventListener("change", apply));
    domainEl.addEventListener("input", debounce(apply, 350));
    return;
  }

  if (col === "activity") {
    const rangeEl = menu.querySelector('[data-f="range"]');
    const apply = () => {
      const states = checkedValues(menu);
      const whenEl = menu.querySelector('input[name="actwhen"]:checked');
      const when = whenEl ? whenEl.value : "any";
      rangeEl.style.display = when === "custom" ? "flex" : "none";
      const from = when === "custom" ? menu.querySelector('[data-f="from"]').value : "";
      const to = when === "custom" ? menu.querySelector('[data-f="to"]').value : "";
      const spec = {};
      if (states.length) spec.states = states;
      if (when === "7d" || when === "30d") spec.within = when;
      if (from) spec.from = from;
      if (to) spec.to = to;
      setColumnFilter(col, Object.keys(spec).length ? spec : null);
    };
    menu.querySelectorAll('.cm-scroll input[type="checkbox"]').forEach((c) => c.addEventListener("change", apply));
    menu.querySelectorAll('input[name="actwhen"]').forEach((r) => r.addEventListener("change", apply));
    menu.querySelectorAll('[data-f="from"], [data-f="to"]').forEach((d) => d.addEventListener("change", apply));
    return;
  }

  // status / source / draft
  const key = col === "draft" ? "states" : "values";
  const apply = () => {
    const values = checkedValues(menu);
    setColumnFilter(col, values.length ? { [key]: values } : null);
  };
  menu.querySelectorAll('.cm-scroll input[type="checkbox"]').forEach((c) => c.addEventListener("change", apply));
}

/* ── Chips + header state ───────────────────────────────────────────── */

function renderGridChips(chips) {
  const row = document.getElementById("crm-chip-row");
  if (!row) return;

  /* Sidebar filters used to render as their own chip strip in a separate
     element. Two chip rows describing one table is one row too many, so the
     sidebar's chips are folded in here — the row now answers "why am I
     seeing these rows" completely, whichever control did the narrowing. */
  const railChips = [];
  CRM_FILTER_CHIPS.forEach((f) => {
    const raw = _crmActiveFilters[f.key];
    const values = f.list ? (raw || []) : (raw ? [raw] : []);
    if (!values.length) return;
    const shown = f.describe ? f.describe(values) : values;
    const text = shown.length > 2 ? `${shown[0]} +${shown.length - 1}` : shown.join(", ");
    railChips.push({ column: `__rail:${f.key}`, text: `${f.label}: ${text}`, text_cn: "" });
  });
  const COL_LABELS = {
    contact: ["Contact", "联系人"], company: ["Company", "公司"], email: ["Email", "邮箱"],
    activity: ["Activity", "互动记录"], tags: ["Tags", "标签"], status: ["Status", "状态"],
    source: ["Source", "来源"], draft: ["Draft", "草稿"],
  };
  const sortChip = _grid.sort
    ? [(() => {
        const [en, cn] = COL_LABELS[_grid.sort.column] || [_grid.sort.column, _grid.sort.column];
        const arrow = _grid.sort.direction === "asc" ? "↑" : "↓";
        return { column: "__sort", text: `Sorted by ${en} ${arrow}`, text_cn: `按${cn}排序` };
      })()]
    : [];
  const all = sortChip.concat(railChips, chips || []);
  if (!all.length) { row.hidden = true; row.innerHTML = ""; return; }
  row.hidden = false;
  row.innerHTML = all.map((c, i) => `
    <span class="crm-chip">${escapeHtml(c.text)} <span style="opacity:.75">${escapeHtml(c.text_cn || "")}</span>
      <button data-chip="${i}" data-col="${escapeAttr(c.column)}" title="Remove 移除">×</button></span>`).join("")
    + `<button class="crm-chip-clear" id="crm-clear-all-filters">Clear all 全部清除</button>`;

  row.querySelectorAll("[data-chip]").forEach((b) => b.addEventListener("click", () => {
    const col = b.dataset.col;
    if (col === "__sort") { _grid.sort = null; loadCrmContacts(crmSearchTerm()); return; }
    if (col.startsWith("__rail:")) { removeCrmFilter(col.slice(7)); return; }
    // A chip removes its whole column: a per-option removal would need the
    // chip to carry which option it came from, and "Email: has + personal"
    // reads as one decision anyway.
    setColumnFilter(col, null);
  }));
  document.getElementById("crm-clear-all-filters").addEventListener("click", clearAllCrmFilters);
}

function renderThIndicators() {
  document.querySelectorAll("#crm-thead-row th[data-col]").forEach((th) => {
    const col = th.dataset.col;
    th.classList.toggle("col-filtered", Boolean(_grid.columns[col]));
    const s = th.querySelector(".th-sort");
    if (s) s.textContent = _grid.sort && _grid.sort.column === col
      ? (_grid.sort.direction === "asc" ? "↑" : "↓") : "";
  });
}

/* One delegated listener for every header button, so columns added later
   need no wiring of their own. */
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".th-filter");
  if (btn) { e.stopPropagation(); openColumnMenu(btn.dataset.col, btn); return; }
  const menu = document.getElementById("crm-col-menu");
  if (menu && !menu.hidden && !menu.contains(e.target)) closeColumnMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeColumnMenu(); });
window.addEventListener("resize", closeColumnMenu);

async function loadCrmContacts(query, filterPatch) {
  try {
    // A changed filter invalidates the current page number: page 7 of a
    // 900-row list is not page 7 of the 12 rows it just became.
    if (filterPatch) { Object.assign(_crmActiveFilters, filterPatch); _grid.page = 1; }

    const params = gridQueryParams(query);
    params.set("page", _grid.page);
    params.set("pageSize", _grid.pageSize);

    const r = await fetch("/api/contacts?" + params.toString());
    const d = await r.json();
    _crmContacts = d.contacts || [];        // one page, not the table
    _crmTotal = d.total || 0;
    _crmTotalPages = d.totalPages || 1;

    // Deleting the last rows of the last page can leave us past the end.
    if (!_crmContacts.length && _grid.page > 1) {
      _grid.page = 1;
      return loadCrmContacts(query);
    }

    renderCrmTable(_crmContacts);
    renderGridChips(d.chips);
    renderThIndicators();
    renderCrmFilterSummary();
    renderCrmCompanyBar();
  } catch (e) {
    // Not silent: these renders run in sequence, so a throw in an early one
    // skips every later one. Swallowing it hid a missing constant that had
    // quietly killed the filter chips and the active-company bar.
    console.error("loadCrmContacts:", e);
  }
}

/* ── Quick Browse: a cascade, not five independent filters ────────────────
   Company → Contact → Trade show → Category → matching companies.

   Each step narrows what the next one offers, and the bottom list is the
   *result* of the chain rather than another filter. Categories are scoped to
   the selected show, so adding a second trade show later brings its own
   taxonomy along instead of pooling everything into one flat list. */

const BOOTH_CATEGORY_META = {
  customer:   ["目标客户 · Target Customers", "#58a6ff"],
  competitor: ["竞争对手 · Competitors", "#f85149"],
  chinese:    ["中国企业 · Chinese Co.", "#f85149"],
  batmat:     ["电池材料 · Battery Materials", "#ffa657"],
  elec:       ["电子连接 · Electronics", "#39d353"],
  test:       ["测试检测 · Testing", "#3fb950"],
  mfg:        ["制造设备 · Manufacturing", "#f0883e"],
  line:       ["产线设备 · Assembly Line", "#f85149"],
  cert:       ["认证机构 · Certification", "#a371f7"],
  recycle:    ["回收安全 · Recycling", "#56d364"],
  gov:        ["政府机构 · Government", "#8b949e"],
  other:      ["其他 · Others", "#6b7280"],
};

let _crmCompanies = [];        // every company, with contact_count + event_id
let _crmShows = [];            // [{id, name}]
let _qbShow = "";              // selected show name ("" = 不限)
let _qbCats = [];              // selected categories (within _qbShow)

const lc = (v) => String(v || "").trim().toLowerCase();

/* Step ①②: which companies the upstream selections allow through.
   Selected companies constrain directly; selected contacts constrain via
   their employer. Both empty ⇒ everything is still on the table. */
function qbUpstreamCompanies() {
  const picked = (_crmActiveFilters.accounts || []).map(lc);
  const contactIds = _crmActiveFilters.contact_ids || [];
  let list = _crmCompanies;
  if (picked.length) list = list.filter((c) => picked.includes(lc(c.name)));
  if (contactIds.length) {
    const names = new Set(_contactOptions
      .filter((ct) => contactIds.includes(ct.id))
      .map((ct) => lc(ct.company)));
    list = list.filter((c) => names.has(lc(c.name)));
  }
  return list;
}

/* Step ③: only shows actually represented by the upstream companies. */
function renderQbShows() {
  const box = document.getElementById("crm-show-list");
  if (!box) return;
  const upstream = qbUpstreamCompanies();
  const byId = new Map(_crmShows.map((s) => [s.id, s.name]));
  const counts = {};
  upstream.forEach((c) => {
    if (!c.event_id) return;
    const n = byId.get(c.event_id);
    if (n) counts[n] = (counts[n] || 0) + 1;
  });
  const shows = _crmShows.filter((s) => counts[s.name]);

  if (!shows.length) {
    box.innerHTML = `<div style="padding:6px;font-size:0.7rem;color:#9ca3af;">No trade shows under the current filters</div>`;
    if (_qbShow) { _qbShow = ""; _qbCats = []; }
    return;
  }
  box.innerHTML = shows.map((s) => `
    <label class="crm-cat-item" title="${escapeHtml(s.name)}">
      <input type="radio" name="qb-show" value="${escapeHtml(s.name)}" ${_qbShow === s.name ? "checked" : ""} />
      <span class="crm-cat-label">${escapeHtml(s.name)}</span>
      <span class="crm-cat-count">${counts[s.name]}</span>
    </label>`).join("")
    + `<label class="crm-cat-item"><input type="radio" name="qb-show" value="" ${!_qbShow ? "checked" : ""} />
       <span class="crm-cat-label" style="color:#6b7280;">All shows · 不限展会</span></label>`;

  box.querySelectorAll('input[name="qb-show"]').forEach((r) => {
    r.addEventListener("change", () => {
      _qbShow = r.value;
      _qbCats = [];                       // taxonomy is per-show; start clean
      applyQbFilters();
    });
  });
}

/* Categories that exist inside the selected show. */
function renderQbCategories() {
  const box = document.getElementById("crm-cat-list");
  const head = document.getElementById("crm-cat-heading");
  if (!box) return;
  const upstream = qbUpstreamCompanies();
  const byId = new Map(_crmShows.map((s) => [s.id, s.name]));
  const inShow = _qbShow
    ? upstream.filter((c) => byId.get(c.event_id) === _qbShow)
    : upstream;

  const counts = {};
  inShow.forEach((c) => { if (c.booth_category) counts[c.booth_category] = (counts[c.booth_category] || 0) + 1; });
  const keys = Object.keys(BOOTH_CATEGORY_META).filter((k) => counts[k]);

  if (head) head.textContent = _qbShow ? `Category · ${_qbShow.replace(/^The\s+/, "")}` : "Category";
  if (!keys.length) {
    box.innerHTML = `<div style="padding:6px;font-size:0.7rem;color:#9ca3af;">${_qbShow ? "No categories in this show" : "Pick a trade show first"}</div>`;
    return;
  }
  box.innerHTML = keys.map((k) => {
    const [label, color] = BOOTH_CATEGORY_META[k];
    return `<label class="crm-cat-item" title="${escapeHtml(label)}">
      <input type="checkbox" value="${k}" ${_qbCats.includes(k) ? "checked" : ""} />
      <span class="crm-cat-dot" style="background:${color}"></span>
      <span class="crm-cat-label">${escapeHtml(label)}</span>
      <span class="crm-cat-count">${counts[k]}</span>
    </label>`;
  }).join("");
  box.querySelectorAll("input").forEach((i) => i.addEventListener("change", () => {
    _qbCats = [...box.querySelectorAll("input:checked")].map((x) => x.value);
    applyQbFilters();
  }));
}

/* The result set — everything the filters above agree on. */
function qbResultCompanies() {
  const byId = new Map(_crmShows.map((s) => [s.id, s.name]));
  // Narrowed by the one global search rather than a box of its own.
  const term = lc(crmSearchTerm());
  return qbUpstreamCompanies().filter((c) => {
    if (_qbShow && byId.get(c.event_id) !== _qbShow) return false;
    if (_qbCats.length && !_qbCats.includes(c.booth_category)) return false;
    if (term && !lc(`${c.name} ${c.chinese_name || ""}`).includes(term)) return false;
    return true;
  });
}

function renderCrmCompanyList() {
  const box = document.getElementById("crm-co-list");
  const countEl = document.getElementById("crm-co-count");
  if (!box) return;
  const list = qbResultCompanies();
  if (countEl) countEl.textContent = String(list.length);

  if (!list.length) {
    box.innerHTML = `<div style="padding:10px 6px;font-size:0.72rem;color:#9ca3af;">No matching companies</div>`;
    return;
  }
  // Which company the table is currently scoped to, so the list shows the
  // selection rather than leaving the user to infer it from the chip row.
  const active = new Set((_crmActiveFilters.accounts || []).map(lc));
  const shown = list.slice(0, 250);
  box.innerHTML = shown.map((c) => {
    const n = Number(c.contact_count) || 0;
    return `
      <div class="crm-co-item${active.has(lc(c.name)) ? " active" : ""}" data-cid="${c.id}" title="${escapeHtml(c.name)}${c.booth ? " · 展位 " + escapeHtml(c.booth) : ""}">
        <div class="crm-co-top">
          <span class="crm-co-name" data-no-i18n>${escapeHtml(c.chinese_name || c.name)}</span>
          ${c.booth ? `<span class="crm-co-booth">${escapeHtml(c.booth)}</span>` : ""}
          <span class="crm-co-n ${n ? "has" : "none"}">${n}</span>
        </div>
        <div class="crm-co-tools">
          ${c.booth ? `<button class="crm-co-tool" data-act="map" data-cid="${c.id}" title="Locate on the booth map">🗺</button>` : ""}
        </div>
      </div>`;
  }).join("") + (list.length > shown.length
    ? `<div style="padding:6px;font-size:0.68rem;color:#9ca3af;">Showing the first ${shown.length} — narrow with the search above<br>仅显示前 ${shown.length} 家，请用上方搜索缩小范围</div>`
    : "");

  const find = (el) => _crmCompanies.find((c) => c.id === Number(el.dataset.cid));
  // Row click scopes the contact table to that company — the list answers
  // "which companies match?", so selecting one is navigation into it.
  // Opening the booth map stayed, but as its own button rather than the
  // meaning of a click on the row.
  box.querySelectorAll(".crm-co-item").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    const co = find(el);
    if (co) setCrmAccounts([co.name], { toggle: true });
  }));
  box.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const co = find(b);
    if (!co) return;
    if (b.dataset.act === "map") openCompanyOnMap(co);
  }));
}

// Switches to the floor plan and centres on this company's booth. jumpTo()
// lives inside the booth-map iframe; it needs the map's canvas to exist, so
// give a cold iframe a moment to boot before calling in.
function openCompanyOnMap(co) {
  if (!co.booth) { showToast?.(`${co.name} 没有展位号`); return; }
  showView("booth-map");
  const frame = document.getElementById("bm-frame");
  let tries = 0;
  const go = () => {
    tries++;
    const w = frame && frame.contentWindow;
    if (w && typeof w.jumpTo === "function" && w.document.getElementById("cv")) {
      w.jumpTo(String(co.booth));
      return;
    }
    if (tries < 40) setTimeout(go, 250);
  };
  setTimeout(go, 300);
}

function applyQbFilters() {
  renderQbShows();
  renderQbCategories();
  renderCrmCompanyList();
  // The contact table follows the same chain.
  _crmActiveFilters.show_event = _qbShow || "";
  _crmActiveFilters.booth_categories = _qbCats;
  if (accountSelect) accountSelect.refreshOptions();
  loadCrmContacts(document.getElementById("crm-search-input").value.trim());
}

async function initCrmCategoryFilter() {
  const box = document.getElementById("crm-cat-list");
  if (!box || box.dataset.ready) return;
  box.dataset.ready = "1";

  try {
    const d = await getJSON("/api/events");
    _crmShows = d.events || d || [];
  } catch (e) { _crmShows = []; }

  const clear = document.getElementById("crm-cat-clearall");
  if (clear) clear.addEventListener("click", () => { _qbCats = []; applyQbFilters(); });

  await refreshCrmCompanies();
  renderQbShows();
  renderQbCategories();
}

async function refreshCrmCompanies() {
  try {
    const d = await getJSON("/api/companies");
    _crmCompanies = d.companies || [];
  } catch (e) { _crmCompanies = _crmCompanies || []; }
  renderCrmCompanyList();
}

/* Active-filter chips.

   The old summary reported only the account filter, which meant the table
   could be narrowed by five other things with nothing on screen saying so.
   Every applied filter now gets a chip, and every chip can be removed from
   where it is shown. Chips clear a whole group; the rail is where individual
   values are added and removed. */
const CRM_FILTER_CHIPS = [
  { key: "accounts", label: "Company", list: true,
    clear: () => { setCrmAccounts([]); return null; } },
  { key: "show_event", label: "Show",
    clear: () => { _qbShow = ""; _qbCats = []; return null; } },
  { key: "booth_categories", label: "Category", list: true,
    clear: () => { _qbCats = []; return null; },
    describe: (keys) => keys.map((k) => (BOOTH_CATEGORY_META[k] || [k])[0]) },
  { key: "event", label: "Event", input: "crm-filter-event" },
  { key: "industry", label: "Industry", input: "crm-filter-industry" },
  { key: "follow_up_status", label: "Status", input: "crm-filter-status",
    describe: (v) => [String(v).replace(/_/g, " ")] },
  { key: "assigned_salesperson", label: "Owner", input: "crm-filter-owner" },
  { key: "department_categories", label: "Department", list: true,
    clear: () => { deptSelect.clearAll(); return { department_categories: [] }; },
    describe: (keys) => keys.map((k) => (_departmentOptions.find((d) => d.key === k) || {}).label || k) },
  { key: "seniority_levels", label: "Seniority", list: true,
    clear: () => { senioritySelect.clearAll(); return { seniority_levels: [] }; },
    describe: (keys) => keys.map((k) => (_seniorityOptions.find((d) => d.key === k) || {}).label || k) },
];

/* Superseded by renderGridChips(), which shows sidebar and column filters
   in one row. Kept as a no-op because several flows still call it. */
function renderCrmFilterSummary() {}

/* Single-company context bar.

   The import target used to be reachable only by opening a modal and typing
   the company name again — while the user was already looking at that exact
   company's list. When the list is scoped to one company this states what
   they hold and offers to change it, pre-filled. */
/* The active company.

   Selecting a company in Matching companies makes it the working context,
   and this bar is that context made visible: who it is, what is known about
   it, and the two things you can do next. Previously the row offered a "fill
   into search" button that wrote into a field inside a closed dialog, so it
   appeared to do nothing at all — the capability existed but the path to it
   was invisible.

   Research and contacts are deliberately side by side. They are two
   capabilities acting on one company, not two separate workflows, and which
   one comes first depends on what the account is missing — so the bar says
   which that is rather than making the user work it out. */
function renderCrmCompanyBar() {
  const bar = document.getElementById("crm-company-bar");
  if (!bar) return;
  const accounts = _crmActiveFilters.accounts || [];
  if (accounts.length !== 1) { bar.hidden = true; bar.innerHTML = ""; return; }

  const name = accounts[0];
  const n = _crmTotal;                  // the filtered total, not this page
  // Analysis state comes from the company summaries the Companies tab uses;
  // if they aren't loaded yet, fetch them and re-render rather than guessing.
  const meta = _crmAccounts.find((c) => lc(c.name) === lc(name));
  if (!meta && !_crmAccounts.length) { loadCrmAccounts().then(renderCrmCompanyBar); }

  const analyzed = meta ? (Boolean(meta.ai_analyzed_at) || meta.has_summary || meta.tag_count > 0) : null;
  const tagCount = meta ? (meta.tag_count || 0) : 0;

  // Exactly one recommendation, matching the account record page's logic.
  let hint = "";
  if (analyzed === false) hint = `Not researched yet — start with Research company. 尚未研究`;
  else if (n === 0) hint = `No contacts yet — import them from Apollo. 暂无联系人`;
  else if (analyzed && tagCount && meta && !meta.confirmed_count) hint = `${tagCount} tags awaiting review. 个标签待确认`;

  const bits = [
    `${n} contact${n !== 1 ? "s" : ""} 位联系人`,
    analyzed === null ? "" : (analyzed ? `analyzed 已分析${tagCount ? ` · ${tagCount} tags 个标签` : ""}` : "not analyzed 未分析"),
  ].filter(Boolean);

  bar.innerHTML = `
    <span class="crm-co-bar-name" data-no-i18n>${escapeHtml(name)}</span>
    <span class="crm-co-bar-meta">${bits.join(" · ")}</span>
    ${hint ? `<span class="crm-co-bar-hint">${escapeHtml(hint)}</span>` : ""}
    <span class="crm-co-bar-actions">
      <button type="button" class="btn-sm btn-ghost" id="crm-co-bar-research">Research company</button>
      <button type="button" class="btn-sm btn-primary" id="crm-co-bar-more">${n ? "Add more contacts" : "Import contacts"}</button>
    </span>`;
  bar.hidden = false;

  // Company Intelligence for this exact company — the same record page the
  // Companies tab opens, so there is one place an account is worked.
  document.getElementById("crm-co-bar-research")?.addEventListener("click", async () => {
    if (!_crmAccounts.length) await loadCrmAccounts();
    const co = _crmAccounts.find((c) => lc(c.name) === lc(name));
    if (co) openCrmAccount(co.id, co.name);
    else showMessage(`No saved company record for “${name}” yet.`, "warn");
  });

  document.getElementById("crm-co-bar-more")?.addEventListener("click", () => {
    // Open on a target that would actually fetch something.
    const t = document.getElementById("topup-target");
    if (t) t.value = Math.min(500, Math.max(Number(t.value) || 0, n + 25));
    openCrmTopupModal(name);
  });
}

function removeCrmFilter(key) {
  const f = CRM_FILTER_CHIPS.find((x) => x.key === key);
  if (!f) return;
  if (f.input) {
    const el = document.getElementById(f.input);
    if (el) el.value = "";
    document.getElementById("crm-apply-filters-btn").click();   // one code path for field filters
    return;
  }
  const patch = f.clear ? f.clear() : null;
  // Show/category live in the Quick-Browse cascade, which reloads the table
  // itself; the multi-selects need their filter key explicitly cleared.
  if (patch) loadCrmContacts(document.getElementById("crm-search-input").value.trim(), patch);
  else applyQbFilters();
}

// Background enrichment for contacts on the current CRM page that have
// an Apollo ID but no email and haven't been checked yet.
/* ── Email resolution policy ────────────────────────────────────────────
   Reading an address the CRM already holds is free, whoever supplied it —
   an upload, a business card, a manual entry, or an Apollo *search* (which
   returns some addresses at no extra cost). Those render straight from the
   row, with no request at all.

   Asking Apollo to *reveal* an address it has not given us costs a credit.
   That never happens on load, scroll, filter, sort or paging. It happens
   only when the user asks for it, and only after being told the price.

   The previous version auto-revealed up to a page of contacts on every
   render. This function is deliberately not replaced by a smaller budget:
   a budgeted charge is still a charge nobody asked for. */

function emailNeedsApolloReveal(c) {
  if (!c) return false;
  const email = String(c.email || "").trim();
  if (email && !email.startsWith("(")) return false;          // already held — free
  if (c.email_lookup_status === "not_available") return false; // asked before; Apollo had none
  return Boolean(c.apollo_person_id);                          // only Apollo rows can be revealed
}

/* Renders the email cell for one row. Never issues a request: everything
   here is decided from data already loaded. */
function crmEmailCellHtml(c, i) {
  const email = String(c.email || "").trim();
  if (email && !email.startsWith("(")) {
    const prov = EMAIL_SOURCE_LABELS[c.email_source] || "";
    return `<span style="font-size:0.76rem;" ${prov ? `title="Email source 邮箱来源: ${escapeAttr(prov)}"` : ""}>${escapeHtml(email)}</span>`;
  }
  if (c.email_lookup_status === "not_available") {
    return `<span style="color:#9ca3af;font-size:0.76rem;" title="Apollo confirmed no address 已确认无邮箱">Email not available 邮箱不可用</span>`;
  }
  if (emailNeedsApolloReveal(c)) {
    // The price is on the control, not hidden behind it.
    return `<button class="btn-sm btn-ghost crm-enrich-btn" data-idx="${i}"
              style="font-size:11px;padding:2px 6px;"
              title="Ask Apollo to reveal this address. Uses 1 Apollo credit. 使用 1 个 Apollo 额度。">
              Reveal · 1 credit 揭示 · 1 额度</button>`;
  }
  // No stored address and nothing to reveal from: blank, per the source
  // policy — a non-Apollo contact is never sent to Apollo implicitly.
  return `<span style="color:#9ca3af;font-size:0.76rem;">—</span>`;
}

const EMAIL_SOURCE_LABELS = {
  apollo_search: "Apollo search 搜索（不消耗额度）",
  apollo_enrichment: "Apollo enrichment 增强（消耗额度）",
  business_card: "Business card 名片",
  manual: "Manually entered 手动输入",
  email_import: "Imported email 导入邮件",
  battery_show: "Battery Show data 电池展数据",
  apollo_legacy: "Apollo (source not recorded) Apollo（来源未记录）",
  legacy: "Not recorded 未记录",
  none: "No email stored 暂无邮箱",
};

document.getElementById("crm-apply-filters-btn").addEventListener("click", () => {
  loadCrmContacts(document.getElementById("crm-search-input").value, {
    event: document.getElementById("crm-filter-event").value.trim(),
    industry: document.getElementById("crm-filter-industry").value.trim(),
    follow_up_status: document.getElementById("crm-filter-status").value,
    assigned_salesperson: document.getElementById("crm-filter-owner").value.trim(),
  });
});
/* Clears every way the list can be narrowed: the sidebar fields, the
   show/category cascade, the multi-selects, the column filters and the sort.

   There used to be two "Clear all" controls — one in the filter rail, one in
   the chip row — with identical labels and different scopes, so neither
   told you what it would do and neither could clear the other's filters.
   One control, one meaning: everything. */
function clearAllCrmFilters() {
  document.getElementById("crm-filter-event").value = "";
  document.getElementById("crm-filter-industry").value = "";
  document.getElementById("crm-filter-status").value = "";
  document.getElementById("crm-filter-owner").value = "";
  clearDeptSeniorityFilters();
  const mergeBtn = document.getElementById("crm-merge-accounts-btn");
  if (mergeBtn) mergeBtn.style.display = "none";
  _selectedAccountsForMerge = [];
  // The show/category cascade was never reset here, so "Clear filters" left
  // the table silently scoped to a trade show and its categories. With every
  // filter now shown as a chip, that leftover is visible — and wrong.
  _qbShow = "";
  _qbCats = [];
  renderQbShows();
  renderQbCategories();
  renderCrmCompanyList();
  _grid.columns = {};
  _grid.sort = null;
  _grid.page = 1;
  loadCrmContacts(document.getElementById("crm-search-input").value, {
    event: "", industry: "", follow_up_status: "", assigned_salesperson: "",
    accounts: [], contact_ids: [], department_categories: [], seniority_levels: [],
    show_event: "", booth_categories: [], company_sources: [],
  });
}

/* Matches CONTACT_STATUSES in contact-query.js. The inline editor and the
   Status filter must offer the same vocabulary — a status you can filter on
   but never set is a dead option, and vice versa. */
const FOLLOW_UP_STATUSES = [
  { key: "not_contacted",     label: "Not contacted 未联系" },
  { key: "contacted",         label: "Contacted 已联系" },
  { key: "replied",           label: "Replied 已回复" },
  { key: "qualified",         label: "Qualified 已确认商机" },
  { key: "meeting_scheduled", label: "Meeting scheduled 已约会议" },
  { key: "customer",          label: "Customer 客户" },
  { key: "do_not_contact",    label: "Do not contact 请勿联系" },
  { key: "closed",            label: "Closed 已关闭" },
];

/* Contact sources. No file-upload entry: uploads supply company names, and
   the contacts that come back from Apollo for those names are Apollo
   contacts. See COMPANY_SOURCE_LABELS for where the file is recorded. */
const SOURCE_LABELS = {
  apollo: "Apollo", battery_show: "Battery Show 电池展",
  business_card: "Business Card 名片", manual: "Manual 手动", email_import: "Email Import 邮件导入",
};

const COMPANY_SOURCE_LABELS = {
  file_upload: "File upload 文件上传",
  manual: "Manually created 手动创建",
  exhibitor_list: "Exhibitor list 参展商名录",
  apollo: "Apollo",
  derived: "Derived from a contact 由联系人推导",
  legacy: "Not recorded 未记录",
};
function sourceLabel(v) { return SOURCE_LABELS[v] || v || "—"; }

function renderCrmTable(contacts) {
  // `contacts` is one server page; the count in the header is the server's
  // total for the whole filtered set, which are different numbers and were
  // the same one back when the browser held every row.
  const total = _crmTotal;
  const totalPages = _crmTotalPages;
  const pageSlice = contacts;
  const pageStart = 0;

  document.getElementById("crm-count").textContent =
    `${total} contact${total !== 1 ? "s" : ""} 位联系人`;

  if (!contacts.length) {
    document.getElementById("crm-tbody").innerHTML = `
      <tr><td colspan="9">
        <div class="table-empty-state">
          <div class="tes-icon">🗂️</div>
          <div class="tes-title">No contacts match 无匹配联系人</div>
          <div class="tes-hint">Remove a column filter or a sidebar filter, or use “Find contacts” to search Apollo and build your CRM.
            移除列筛选或侧栏筛选，或使用“查找联系人”从 Apollo 检索。</div>
        </div>
      </td></tr>`;
    renderCrmPagination(total, totalPages);
    return;
  }

  document.getElementById("crm-tbody").innerHTML = pageSlice.map((c, pi) => {
    const i = pageStart + pi;  // index into _crmContacts
    const hasDraft = c.has_draft || Boolean(c.draft_subject);
    const draftCount = Number(c.draft_count) || 0;
    const draftStatus = !hasDraft
      ? `<span style="font-size:0.72rem;color:#9ca3af;">No draft</span>`
      : draftCount > 1
        ? `<span style="font-size:0.72rem;color:#16a34a;font-weight:500;">${draftCount} drafts</span>`
        : `<span style="font-size:0.72rem;color:#16a34a;font-weight:500;">Saved</span>`;
    const emailCell = crmEmailCellHtml(c, i);
    const commCount = Number(c.comm_count) || 0;
    const commDraftCount = Number(c.comm_draft_count) || 0;
    const lastActivity = c.last_comm_at
      ? new Date(c.last_comm_at).toLocaleDateString()
      : c.last_contacted_at || "—";
    const lastType = c.last_comm_type
      ? `<span style="font-size:0.65rem;color:#6b7280;margin-left:3px;">${c.last_comm_type.replace(/_/g," ")}</span>`
      : "";
    // Two-line cells: the secondary attribute rides with the record it
    // describes (title under name, phone under email) instead of buying a
    // column of its own. Same information, four fewer columns to scan.
    // #crm-email-cell-* stays a dedicated inner element so an explicit
    // reveal can replace just that cell without re-rendering the row.
    return `<tr>
      <td class="col-check"><input type="checkbox" class="crm-check" data-idx="${i}"></td>
      <td data-no-i18n>
        <div class="cell-primary" style="font-weight:600;">${escapeHtml(c.full_name || "Unnamed")}</div>
        ${c.job_title ? `<div class="cell-sub">${escapeHtml(c.job_title)}</div>` : ""}
      </td>
      <td data-no-i18n>
        <div class="cell-primary">${escapeHtml(c.company || "—")}</div>
      </td>
      <td>
        <div id="crm-email-cell-${i}" data-no-i18n>${emailCell}</div>
        ${c.phone ? `<div class="cell-sub">${escapeHtml(c.phone)}</div>` : ""}
      </td>
      <td>
        <div class="cell-primary cell-nowrap">${lastActivity}${lastType}</div>
        <div class="cell-sub">${commCount ? `${commCount} interaction${commCount !== 1 ? "s" : ""}${commDraftCount ? ` · ${commDraftCount} draft${commDraftCount !== 1 ? "s" : ""}` : ""}` : "No interactions"}</div>
      </td>
      <td data-no-i18n><input type="text" class="crm-tags-input" data-id="${c.id}" value="${escapeAttr(c.tags || "")}"
            style="font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;" placeholder="tags…"></td>
      <td>
        <select class="crm-status-select" data-id="${c.id}" style="font-size:12px;padding:3px 4px;border:1px solid #d1d5db;border-radius:4px;">
          ${FOLLOW_UP_STATUSES.map(o => `<option value="${o.key}" ${c.follow_up_status === o.key ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>
      </td>
      <td data-no-i18n>
        <span class="badge badge-source">${escapeHtml(sourceLabel(c.source))}</span>
      </td>
      <td class="col-actions">
        <div id="crm-action-${i}">
          ${hasDraft
            ? `<button class="btn-sm btn-saved crm-view-draft-btn" data-idx="${i}" title="View saved draft">View</button>
               <button class="btn-sm btn-orange crm-redraft-btn" data-idx="${i}" title="Generate a new draft">Redraft</button>`
            : `<button class="btn-sm btn-primary crm-draft-btn" data-idx="${i}" title="Draft an email to this contact">Draft</button>`}
          <button class="btn-sm btn-ghost crm-details-btn" data-idx="${i}">Details</button>
        </div>
        <div class="crm-draft-state" id="crm-draft-status-${i}">${draftStatus}</div>
      </td>
    </tr>`;
  }).join("");

  document.querySelectorAll(".crm-enrich-btn").forEach(btn => {
    btn.addEventListener("click", () => enrichCrmEmail(Number(btn.dataset.idx)));
  });
  document.querySelectorAll(".crm-tags-input").forEach(inp => {
    inp.addEventListener("change", () => patchCrmContact(inp.dataset.id, { tags: inp.value.trim() }));
  });
  document.querySelectorAll(".crm-status-select").forEach(sel => {
    sel.addEventListener("change", () => patchCrmContact(sel.dataset.id, { follow_up_status: sel.value }));
  });
  document.querySelectorAll(".crm-draft-btn, .crm-view-draft-btn").forEach(btn => {
    btn.addEventListener("click", () => openCrmDraftModal(Number(btn.dataset.idx)));
  });
  document.querySelectorAll(".crm-redraft-btn").forEach(btn => {
    btn.addEventListener("click", () => openCrmDraftModal(Number(btn.dataset.idx), { forceRegenerateOnOpen: true }));
  });
  document.querySelectorAll(".crm-details-btn").forEach(btn => {
    btn.addEventListener("click", () => openContactDetailModal(_crmContacts[Number(btn.dataset.idx)]));
  });

  renderCrmPagination(total, totalPages);
}

function renderCrmPagination(total, totalPages) {
  const el = document.getElementById("crm-pagination");
  if (!el) return;
  const page = _grid.page;
  const from = total ? (page - 1) * _grid.pageSize + 1 : 0;
  const to = Math.min(page * _grid.pageSize, total);

  // Always rendered, even on a single page: the page-size control lives
  // here, and "1–25 of 870" is the fastest answer to "how much is left".
  el.innerHTML = `
    <button class="btn-sm btn-ghost" id="crm-first-btn" ${page <= 1 ? "disabled" : ""}>« First 首页</button>
    <button class="btn-sm btn-ghost" id="crm-prev-btn" ${page <= 1 ? "disabled" : ""}>← Prev 上一页</button>
    <span style="font-size:0.85rem;color:#555;">
      ${from}–${to} of ${total} · Page 第 ${page} / ${totalPages} 页
    </span>
    <button class="btn-sm btn-ghost" id="crm-next-btn" ${page >= totalPages ? "disabled" : ""}>Next 下一页 →</button>
    <button class="btn-sm btn-ghost" id="crm-last-btn" ${page >= totalPages ? "disabled" : ""}>Last 末页 »</button>
    <span style="margin-left:auto;font-size:0.8rem;color:#6b7280;">
      Rows 每页
      <select class="crm-page-size" id="crm-page-size">
        ${[10, 25, 50, 100, 200].map((n) => `<option value="${n}" ${_grid.pageSize === n ? "selected" : ""}>${n}</option>`).join("")}
      </select>
    </span>`;

  const go = (p) => {
    _grid.page = Math.min(Math.max(1, p), totalPages);
    loadCrmContacts(crmSearchTerm());
  };
  document.getElementById("crm-first-btn").addEventListener("click", () => go(1));
  document.getElementById("crm-prev-btn").addEventListener("click", () => go(page - 1));
  document.getElementById("crm-next-btn").addEventListener("click", () => go(page + 1));
  document.getElementById("crm-last-btn").addEventListener("click", () => go(totalPages));
  document.getElementById("crm-page-size").addEventListener("change", function () {
    _grid.pageSize = Number(this.value) || 25;
    _grid.page = 1;                      // row 260 is on a different page at a different size
    loadCrmContacts(crmSearchTerm());
  });
}

/* ── Quick Browse: Browse-by-Company / Browse-by-Contact multi-select ──
   These load from dedicated endpoints backed by the accounts/companies
   tables directly (not from the currently-loaded _crmContacts page), so a
   saved account/contact is always browsable even with zero contacts loaded
   on the current CRM page or search.

   Reusable multi-select: search input + checkbox dropdown + removable chips.
   Selections persist in _crmActiveFilters until "Clear all" / "Clear Filters"
   is clicked -- searching, paging, or changing other filters never resets
   them. The option lists themselves (lightweight name/count metadata, not
   full contact rows) are filtered client-side for a snappy dropdown even
   with a large number of accounts/contacts; the actual contact-table
   filtering always happens server-side via filterContacts(). */

let _accountOptions = [];
let _contactOptions = [];

function createMultiSelect({ inputId, dropdownId, chipsId, clearAllId, getItems, keyOf, renderChipLabel, renderOptionLabel, matchText, filterKey, onChange }) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  const chipsEl = document.getElementById(chipsId);
  // A control whose markup this layout doesn't include still has to expose
  // the API, so callers don't each need a null check.
  if (!input || !dropdown) {
    return { clearAll() {}, refreshOptions() {}, selectByKeys() {} };
  }
  const clearAllEl = document.getElementById(clearAllId);
  if (!input || !dropdown || !chipsEl) return null;

  let selectedKeys = new Set();
  let selectedItems = new Map(); // key -> item, so chips/labels survive even if the option list is filtered out

  function isSelected(item) { return selectedKeys.has(keyOf(item)); }

  function renderDropdown() {
    const term = input.value.toLowerCase();
    const items = getItems();
    const filtered = term ? items.filter((it) => matchText(it).toLowerCase().includes(term)) : items;
    dropdown.innerHTML = filtered.length
      ? filtered.slice(0, 300).map((it, i) => `
          <div class="crm-sel-opt${isSelected(it) ? ' selected' : ''}" data-i="${i}">
            <input type="checkbox" ${isSelected(it) ? 'checked' : ''} tabindex="-1">
            <span>${renderOptionLabel(it)}</span>
          </div>`).join("")
      : `<div class="crm-sel-empty">No matches</div>`;
    dropdown.querySelectorAll(".crm-sel-opt").forEach((el) => {
      el.addEventListener("click", () => {
        const item = filtered[Number(el.dataset.i)];
        toggle(item);
        renderDropdown(); // keep dropdown open so users can pick several in a row
      });
    });
  }

  function renderChips() {
    chipsEl.innerHTML = [...selectedItems.values()].map((it) => `
      <span class="crm-sel-chip" data-key="${escapeAttr(String(keyOf(it)))}">
        <span>${escapeHtml(renderChipLabel(it))}</span>
        <button type="button" title="Remove">✕</button>
      </span>`).join("");
    chipsEl.querySelectorAll(".crm-sel-chip button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.parentElement.dataset.key;
        const item = selectedItems.get(key) || [...selectedItems.values()].find((it) => String(keyOf(it)) === key);
        if (item) toggle(item, /* skipRender */ true);
        renderChips();
        renderDropdown();
        emitChange();
      });
    });
    if (clearAllEl) clearAllEl.classList.toggle("active", selectedItems.size > 0);
  }

  function emitChange() {
    onChange([...selectedItems.values()]);
  }

  function toggle(item, skipChipRender) {
    const key = keyOf(item);
    if (selectedKeys.has(key)) {
      selectedKeys.delete(key);
      selectedItems.delete(key);
    } else {
      selectedKeys.add(key);
      selectedItems.set(key, item);
    }
    if (!skipChipRender) { renderChips(); emitChange(); }
  }

  function clearAll() {
    selectedKeys = new Set();
    selectedItems = new Map();
    renderChips();
    renderDropdown();
  }

  input.addEventListener("focus", () => { renderDropdown(); dropdown.classList.add("open"); });
  input.addEventListener("input", () => { renderDropdown(); dropdown.classList.add("open"); });
  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.remove("open");
  });
  if (clearAllEl) {
    clearAllEl.addEventListener("click", () => {
      clearAll();
      emitChange();
    });
  }

  // Programmatic pre-selection (e.g. after a search, select the searched
  // company/account without the user manually re-picking it). Case-insensitive
  // since a typed search term and the stored account name may differ in case.
  function selectByKeys(keys) {
    const wanted = new Set((keys || []).map((k) => String(k).toLowerCase()));
    let changed = false;
    getItems().forEach((it) => {
      const key = keyOf(it);
      if (wanted.has(String(key).toLowerCase()) && !selectedKeys.has(key)) {
        selectedKeys.add(key);
        selectedItems.set(key, it);
        changed = true;
      }
    });
    renderChips();
    renderDropdown();
    if (changed) emitChange();
  }

  return { clearAll, refreshOptions: renderDropdown, selectByKeys };
}

let _selectedAccountsForMerge = [];

/* Account scope is now plain state rather than a searchable multi-select.

   Selecting a company is navigation — you click it in Matching Companies —
   so the only thing that needed to survive the removal of that control is
   the filter value itself, which the chip row already displays and clears.
   Everything that used to call accountSelect.selectByKeys() calls this. */
function setCrmAccounts(names, { toggle = false } = {}) {
  const current = _crmActiveFilters.accounts || [];
  let next = (names || []).filter(Boolean);
  if (toggle && next.length === 1) {
    const n = next[0];
    next = current.some((x) => lc(x) === lc(n))
      ? current.filter((x) => lc(x) !== lc(n))   // clicking the active one clears it
      : current.concat([n]);
  }
  _crmActiveFilters.accounts = next;

  // Merging operates on the selected accounts, so it follows this state.
  _selectedAccountsForMerge = _accountOptions.filter((a) => next.some((n) => lc(n) === lc(a.name)));
  const mergeBtn = document.getElementById("crm-merge-accounts-btn");
  if (mergeBtn) mergeBtn.style.display = _selectedAccountsForMerge.length >= 2 ? "" : "none";

  applyQbFilters();                                       // recompute the cascade
}

const accountSelect = { clearAll() {}, refreshOptions() {}, selectByKeys(names) { setCrmAccounts(names); } };

document.getElementById("crm-merge-accounts-btn").addEventListener("click", () => {
  if (_selectedAccountsForMerge.length < 2) return;
  const sorted = [..._selectedAccountsForMerge].sort((a, b) => (b.contact_count || 0) - (a.contact_count || 0));
  document.getElementById("merge-accounts-list").innerHTML =
    "Selected: " + sorted.map((a) => `${escapeHtml(a.name)} (${a.contact_count})`).join(", ");
  const targetSelect = document.getElementById("merge-accounts-target");
  targetSelect.innerHTML = sorted.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} (${a.contact_count})</option>`).join("");
  openModal("merge-accounts-modal");
});

function closeMergeAccountsModal() {
  closeModal("merge-accounts-modal");
}
document.getElementById("merge-accounts-close").addEventListener("click", closeMergeAccountsModal);
document.getElementById("merge-accounts-cancel").addEventListener("click", closeMergeAccountsModal);
document.getElementById("merge-accounts-modal").addEventListener("click", (e) => {
  if (e.target.id === "merge-accounts-modal") closeMergeAccountsModal();
});

document.getElementById("merge-accounts-ok").addEventListener("click", async () => {
  const targetAccountId = Number(document.getElementById("merge-accounts-target").value);
  const sourceAccountIds = _selectedAccountsForMerge.map((a) => a.id).filter((id) => id !== targetAccountId);
  if (!sourceAccountIds.length) { closeMergeAccountsModal(); return; }
  const okBtn = document.getElementById("merge-accounts-ok");
  okBtn.disabled = true;
  try {
    const r = await fetch("/api/accounts/merge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceAccountIds, targetAccountId }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "Failed to merge accounts");
    showMessage(`Merged ${d.accountsRemoved} account(s), moved ${d.companiesMoved} compan${d.companiesMoved !== 1 ? "ies" : "y"}.`, "info");
    closeMergeAccountsModal();
    clearAccountSelection();
    _selectedAccountsForMerge = [];
    document.getElementById("crm-merge-accounts-btn").style.display = "none";
    loadBrowseSelectors();
    loadCrmContacts(document.getElementById("crm-search-input").value, { accounts: [] });
  } catch (e) {
    showMessage(`Merge failed: ${e.message}`, "error");
  } finally {
    okBtn.disabled = false;
  }
});

/* The Browse-by-Contact multi-select is gone: picking one contact out of a
   dropdown to filter a table down to that same contact is what the global
   search does directly. The filter key stays supported server-side (the
   cascade still reads contact_ids) but nothing sets it any more. */
const contactSelect = { clearAll() {}, refreshOptions() {}, selectByKeys() {} };

let _departmentOptions = [];
let _seniorityOptions = [];

const deptSelect = createMultiSelect({
  inputId: "crm-sel-dept-input", dropdownId: "crm-sel-dept-dropdown",
  chipsId: "crm-sel-dept-chips", clearAllId: "crm-sel-dept-clearall",
  getItems: () => _departmentOptions,
  keyOf: (it) => it.key,
  matchText: (it) => it.label || "",
  renderOptionLabel: (it) => escapeHtml(it.label),
  renderChipLabel: (it) => it.label,
  onChange: (items) => {
    loadCrmContacts(document.getElementById("crm-search-input").value, { department_categories: items.map((it) => it.key) });
  },
});

const senioritySelect = createMultiSelect({
  inputId: "crm-sel-seniority-input", dropdownId: "crm-sel-seniority-dropdown",
  chipsId: "crm-sel-seniority-chips", clearAllId: "crm-sel-seniority-clearall",
  getItems: () => _seniorityOptions,
  keyOf: (it) => it.key,
  matchText: (it) => it.label || "",
  renderOptionLabel: (it) => escapeHtml(it.label),
  renderChipLabel: (it) => it.label,
  onChange: (items) => {
    loadCrmContacts(document.getElementById("crm-search-input").value, { seniority_levels: items.map((it) => it.key) });
  },
});

function clearAccountSelection() { setCrmAccounts([]); }
function clearContactSelection() { _crmActiveFilters.contact_ids = []; }
function clearDeptSeniorityFilters() {
  if (deptSelect) deptSelect.clearAll();
  if (senioritySelect) senioritySelect.clearAll();
}

async function loadBrowseSelectors() {
  try {
    const [accRes, contactRes, compRes] = await Promise.all([
      fetch("/api/accounts/grouped"), fetch("/api/contacts/names"),
      fetch("/api/companies").catch(() => null),
    ]);
    const accData = await accRes.json();
    const contactData = await contactRes.json();
    _accountOptions = accData.accounts || [];
    _contactOptions = contactData.contacts || [];
    if (accountSelect) accountSelect.refreshOptions();
    if (contactSelect) contactSelect.refreshOptions();
  } catch (e) { /* silent */ }
}

// Department/Seniority option lists are a small fixed taxonomy (see
// contactClassify.js) -- fetched once, not tied to currently-loaded contacts.
async function loadSearchTaxonomy() {
  try {
    const r = await fetch("/api/search-taxonomy");
    const d = await r.json();
    _departmentOptions = d.departments || [];
    _seniorityOptions = d.seniorities || [];
    if (deptSelect) deptSelect.refreshOptions();
    if (senioritySelect) senioritySelect.refreshOptions();
    renderSearchSettingsDepartmentCheckboxes();
  } catch (e) { /* silent */ }
}

function crmRowToDraftFormat(c) {
  return {
    name: c.full_name, title: c.job_title, company: c.company, department: c.department,
    email: c.email, linkedin: c.linkedin_url, contact_id: c.id, apollo_id: c.apollo_person_id,
    // Carried separately because Apollo masks surnames ("Dory Tu***g"): the
    // greeting rule needs a clean first name, not the display name.
    first_name: c.first_name, last_name: c.last_name,
  };
}

// Single entry point for every CRM-table draft button (Draft Email / View
// Draft / Redraft) -- the modal itself now detects whether a draft already
// exists (via GET current-draft) rather than each button needing its own
// fetch-vs-view branch, and refreshes the CRM table from the server after
// any lifecycle action instead of hand-patching the local _crmContacts array.
async function openCrmDraftModal(idx, options) {
  const c = _crmContacts[idx];
  if (!c) return;
  // Reveal first so the draft opens with a real recipient rather than a
  // placeholder the user has to chase.
  if (emailNeedsApolloReveal(c)) {
    const rev = await revealBeforeUse([c], "address the draft", "填写收件人");
    if (rev.cancelled) return;                // the user declined the charge
  }
  await openDraftModalForContact(crmRowToDraftFormat(c), () => {
    loadCrmContacts(document.getElementById("crm-search-input").value);
  }, options);
}

// #crm-action-* is the button row *inside* the actions cell, so replacing it
// leaves the draft-state line below it intact for the update further down.
function setCrmDraftButtons(idx) {
  const cell = document.getElementById(`crm-action-${idx}`);
  if (!cell) return;
  cell.innerHTML = `
    <button class="btn-sm btn-saved crm-view-draft-btn" data-idx="${idx}" title="View saved draft">View</button>
    <button class="btn-sm btn-orange crm-redraft-btn" data-idx="${idx}" title="Generate a new draft">Redraft</button>
    <button class="btn-sm btn-ghost crm-details-btn" data-idx="${idx}">Details</button>`;
  cell.querySelector(".crm-view-draft-btn").addEventListener("click", () => openCrmDraftModal(idx));
  cell.querySelector(".crm-redraft-btn").addEventListener("click", () => openCrmDraftModal(idx, { forceRegenerateOnOpen: true }));
  cell.querySelector(".crm-details-btn").addEventListener("click", () => openContactDetailModal(_crmContacts[idx]));

  const statusCell = document.getElementById(`crm-draft-status-${idx}`);
  if (statusCell) {
    const cnt = Number(_crmContacts[idx].draft_count) || 1;
    statusCell.innerHTML = cnt > 1
      ? `<span style="font-size:0.72rem;color:#16a34a;font-weight:500;">${cnt} drafts</span>`
      : `<span style="font-size:0.72rem;color:#16a34a;font-weight:500;">Saved</span>`;
  }
}

/* ── Contact detail editor (conference fields) ── */

const contactDetailModal = document.getElementById("contact-detail-modal");
let _detailContactId = null;

async function openContactDetailModal(c) {
  _detailContactId = c.id;
  document.getElementById("contact-detail-name").textContent = `${c.full_name || "Unnamed"} · ${c.company || ""}`;

  const emailEl = document.getElementById("cd-email-display");
  if (emailEl) {
    emailEl.textContent = c.email || "No email saved 暂无邮箱";
    emailEl.style.color = c.email ? "#374151" : "#9ca3af";
  }
  renderContactProvenance(c);
  loadContactThreads(c.id);

  // Load unified timeline
  await loadContactTimeline(c);

  document.getElementById("cd-event").value = "";
  document.getElementById("cd-booth").value = c.booth_number || "";
  document.getElementById("cd-date").value = c.meeting_date || "";
  document.getElementById("cd-interest").value = c.interest_level || "";
  document.getElementById("cd-products").value = c.products_discussed || "";
  document.getElementById("cd-meeting-notes").value = c.meeting_notes || "";
  document.getElementById("cd-salesperson").value = c.assigned_salesperson || "";
  openModal("contact-detail-modal");
}

/* Two facts, kept apart on purpose:
     Original source — where the contact record came from
     Email source    — where the stored address came from, and whether
                       obtaining it cost an Apollo credit
   A contact imported from the Battery Show can hold an Apollo-enriched
   address; a contact found through Apollo can hold one typed by hand. */
function renderContactProvenance(c) {
  const el = document.getElementById("cd-provenance");
  if (!el) return;

  const coKey = c.company_source || "legacy";
  const coLabel = COMPANY_SOURCE_LABELS[coKey] || coKey;
  const coFile = c.company_source_file
    ? ` <span class="cd-prov-k">(${escapeHtml(c.company_source_file)})</span>` : "";
  const srcLabel = SOURCE_LABELS[c.source] || c.source || "Not recorded 未记录";
  const emailKey = c.email_source || (c.email ? "legacy" : "none");
  const emailLabel = EMAIL_SOURCE_LABELS[emailKey] || emailKey;
  /* Only claim a cost when the provenance actually records one. Rows written
     before this column existed could have been revealed for a credit or
     supplied free with a search — there is no way to tell now, and saying
     "no credit used" over a row that may have cost one is a fabricated
     reassurance in exactly the report meant to prevent hidden charges. */
  const UNKNOWN_COST = new Set(["apollo_legacy", "legacy"]);
  const cost = !c.email || UNKNOWN_COST.has(emailKey)
    ? (c.email && UNKNOWN_COST.has(emailKey)
        ? `<span class="cd-prov-k">· credit usage not recorded 额度使用未记录</span>` : "")
    : emailKey === "apollo_enrichment"
      ? `<span class="cd-prov-paid">· used an Apollo credit 消耗额度</span>`
      : `<span class="cd-prov-free">· no Apollo credit used 未消耗额度</span>`;

  /* The chain, in the order it happened. Reading top to bottom answers
     "how did we get this person, and did their address cost anything" —
     which is three different questions with three different answers. */
  el.innerHTML = `
    <div><span class="cd-prov-k">Company source 公司来源:</span> ${escapeHtml(coLabel)}${coFile}</div>
    <div><span class="cd-prov-k">Contact source 联系人来源:</span> ${escapeHtml(srcLabel)}</div>
    <div><span class="cd-prov-k">Email source 邮箱来源:</span> ${escapeHtml(emailLabel)} ${cost}</div>`;
}

async function loadContactTimeline(c) {
  const el = document.getElementById("cd-timeline");
  if (!el) return;
  el.innerHTML = `<div style="font-size:0.73rem;color:#9ca3af;">Loading…</div>`;
  try {
    const r = await fetch(`/api/contacts/${c.id}/timeline`);
    const data = await r.json();
    const items = data.items || [];
    if (!items.length) {
      el.innerHTML = `<div style="font-size:0.73rem;color:#9ca3af;">No interactions yet</div>`;
      return;
    }
    el.innerHTML = items.map(item => renderTimelineItem(item, c)).join("");
    el.querySelectorAll(".tl-view-draft-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const subject = btn.dataset.subject || "";
        const body = btn.dataset.body || "";
        const contact = crmRowToDraftFormat(c);
        _modalContact = contact;
        _modalComm = null; // read-only historical timeline preview, not the live editable draft
        document.getElementById("modal-title").textContent = `Draft email to ${contact.name || "contact"}`;
        document.getElementById("modal-contact-info").textContent = `${c.job_title || ""} · ${c.company || ""}`;
        document.getElementById("modal-extra-instructions").value = "";
        openModal("email-modal");
        closeModal("contact-detail-modal");
        renderDraft({ subject, body, followup: "", rationale: "", claude_configured: true }, contact);
      });
    });
    el.querySelectorAll(".tl-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const body = btn.dataset.body || "";
        navigator.clipboard.writeText(body).catch(() => {});
        showMessage("Copied to clipboard", "info");
      });
    });
    el.querySelectorAll(".tl-duplicate-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        try {
          await fetch(`/api/communications/${id}/duplicate`, { method: "POST" });
          await loadContactTimeline(c);
        } catch (_) {}
      });
    });
    el.querySelectorAll(".tl-delete-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        if (!confirm("Delete this entry?")) return;
        try {
          await fetch(`/api/communications/${id}`, { method: "DELETE" });
          await loadContactTimeline(c);
        } catch (_) {}
      });
    });
  } catch (_) {
    el.innerHTML = `<div style="font-size:0.73rem;color:#9ca3af;">Could not load timeline</div>`;
  }
}

function renderTimelineItem(item, c) {
  const isDraft = item.comm_type === "draft";
  const isEmail = item.comm_type === "imported_email" || item.comm_type === "sent_email";
  const icon = isDraft ? "📄" : isEmail ? "📧" : "💬";
  const dotClass = isDraft ? "draft" : isEmail ? "imported_email" : "";
  const dateStr = item.sent_at || item.created_at
    ? new Date(item.sent_at || item.created_at).toLocaleDateString()
    : "";
  const catBadge = item.category
    ? `<span class="badge-category cat-${item.category}">${item.category.replace(/_/g, " ")}</span>`
    : "";
  const vLabel = isDraft && item.version ? `v${item.version} ` : "";
  const fromStr = isEmail && item.from_name ? ` · From: ${escapeHtml(item.from_name)}` : "";
  const actions = isDraft
    ? `<button class="btn-sm btn-ghost tl-view-draft-btn" data-subject="${escapeAttr(item.subject || "")}" data-body="${escapeAttr(item.body || "")}">View</button>
       <button class="btn-sm btn-ghost tl-copy-btn" data-body="${escapeAttr(item.body || "")}">Copy</button>
       <button class="btn-sm btn-ghost tl-duplicate-btn" data-id="${item.id}">Duplicate</button>
       <button class="btn-sm btn-ghost tl-delete-btn" data-id="${item.id}" style="color:#ef4444;">Delete</button>`
    : `<button class="btn-sm btn-ghost tl-delete-btn" data-id="${item.id}" style="color:#ef4444;">Delete</button>`;
  return `<div class="tl-item">
    <div class="tl-dot ${dotClass}">${icon}</div>
    <div style="flex:1;min-width:0;">
      <div class="tl-item-subject">${vLabel}${escapeHtml(item.subject || "(no subject)")}</div>
      <div class="tl-item-meta">${dateStr}${fromStr} ${catBadge}</div>
      <div class="tl-actions">${actions}</div>
    </div>
  </div>`;
}

/* The row-level reveal. Explicit by construction — it only ever runs from a
   click on the priced button — and it still confirms first, because a click
   on a 25-row grid is easy to make by accident and a credit is not
   refundable. */
async function enrichCrmEmail(idx) {
  const c = _crmContacts[idx];
  if (!c || !c.id) return;

  const ok = await confirmReveal(
    `Reveal the email address for ${c.full_name || "this contact"}?`,
    `为 ${c.full_name || "该联系人"} 揭示邮箱地址？`,
    1
  );
  if (!ok) return;

  const cell = document.getElementById(`crm-email-cell-${idx}`);
  if (cell) cell.innerHTML = `<span style="font-size:0.73rem;color:#6b7280;">Revealing… 揭示中…</span>`;
  try {
    const r = await fetch(`/api/contacts/${c.id}/enrich-email`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowApollo: true }),      // the user just said yes
    });
    const d = await r.json();
    if (d.email && !d.email.startsWith("(")) {
      _crmContacts[idx].email = d.email;
      _crmContacts[idx].email_lookup_status = 'found';
      _crmContacts[idx].email_source = d.email_source || 'apollo_enrichment';
    } else {
      _crmContacts[idx].email = "";
      _crmContacts[idx].email_lookup_status = d.email_lookup_status || 'not_available';
    }
    if (cell) cell.innerHTML = crmEmailCellHtml(_crmContacts[idx], idx);
    // Re-bind: the cell may now hold a fresh button (or none).
    cell?.querySelectorAll(".crm-enrich-btn").forEach((b) =>
      b.addEventListener("click", () => enrichCrmEmail(Number(b.dataset.idx))));
    refreshUsage();
  } catch (e) {
    if (cell) cell.innerHTML = `<span style="color:#9ca3af;font-size:0.76rem;">—</span>`;
  }
}

/* One confirmation shape for every paid reveal, so the price is always
   stated in the same place and the same words. */
function confirmReveal(questionEn, questionCn, credits) {
  const n = Number(credits) || 0;
  return Promise.resolve(window.confirm(
    `${questionEn}\n${questionCn}\n\n` +
    `This uses about ${n} Apollo credit${n === 1 ? "" : "s"}.\n` +
    `本次操作约消耗 ${n} 个 Apollo 额度。\n\n` +
    `Addresses already stored in the CRM are used for free and are not counted here.\n` +
    `CRM 中已保存的邮箱免费使用，不计入此数。`
  ));
}

document.getElementById("contact-detail-close").addEventListener("click", () => {
  closeModal("contact-detail-modal");
});
contactDetailModal.addEventListener("click", (e) => {
  if (e.target === contactDetailModal) closeModal("contact-detail-modal");
});

document.getElementById("contact-detail-save-btn").addEventListener("click", async () => {
  if (!_detailContactId) return;
  const fields = {
    booth_number: document.getElementById("cd-booth").value.trim(),
    meeting_date: document.getElementById("cd-date").value.trim(),
    interest_level: document.getElementById("cd-interest").value,
    products_discussed: document.getElementById("cd-products").value.trim(),
    meeting_notes: document.getElementById("cd-meeting-notes").value.trim(),
    assigned_salesperson: document.getElementById("cd-salesperson").value.trim(),
  };
  const eventName = document.getElementById("cd-event").value.trim();
  if (eventName) fields.event_name = eventName;

  await patchCrmContact(_detailContactId, fields);
  closeModal("contact-detail-modal");
  showMessage("Contact details updated.", "info");
  loadCrmContacts(document.getElementById("crm-search-input").value);
});

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

async function patchCrmContact(id, fields) {
  try {
    await fetch(`/api/contacts/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
  } catch (e) { /* silent */ }
}

/* One search, three surfaces.

   A term typed once narrows the contact table, the Matching Companies list
   and the Companies tab together, so "Tesla" never has to be entered twice.

   Read the term off the event, not `this`: debounce() re-invokes the handler
   as a plain call, so `this` was globalThis and `this.value` undefined —
   every keystroke reloaded the *unfiltered* list. */
function crmSearchTerm() {
  return (document.getElementById("crm-search-input")?.value || "").trim();
}

document.getElementById("crm-search-input").addEventListener("input", debounce((e) => {
  const term = e.target.value.trim();
  loadCrmContacts(term);          // contact table
  renderCrmCompanyList();         // Matching companies (rail)
  _crmAcctPage = 1;
  renderCrmAccounts();            // Companies tab
}, 300));
document.getElementById("crm-refresh-btn").addEventListener("click", () => {
  loadCrmContacts(document.getElementById("crm-search-input").value);
});
function getCheckedCrmIdxs() {
  const idxs = [];
  document.querySelectorAll(".crm-check:checked").forEach(cb => idxs.push(Number(cb.dataset.idx)));
  return idxs;
}

// The bulk bar is contextual: it slides in on selection and leaves when the
// selection is emptied, so drafting controls never sit on the page in a
// permanently-disabled state above the data (Gmail / Linear pattern).
function updateCrmSelectionUI() {
  const count = getCheckedCrmIdxs().length;
  document.getElementById("crm-bulk-draft-btn").disabled = count === 0;
  document.getElementById("crm-bulk-delete-btn").disabled = count === 0;
  document.getElementById("crm-selected-count").textContent = count ? `${count} selected` : "";
  const bar = document.getElementById("crm-bulkbar");
  if (bar) bar.hidden = count === 0;

  // Keep the header checkbox honest: checked only when the whole page is,
  // indeterminate on a partial selection.
  const all = document.querySelectorAll(".crm-check");
  const master = document.getElementById("crm-select-all");
  if (master) {
    master.checked = all.length > 0 && count === all.length;
    master.indeterminate = count > 0 && count < all.length;
  }
}

function clearCrmSelection() {
  document.querySelectorAll(".crm-check").forEach((c) => { c.checked = false; });
  updateCrmSelectionUI();
}

document.getElementById("crm-select-all").addEventListener("change", function () {
  document.querySelectorAll(".crm-check").forEach(c => c.checked = this.checked);
  updateCrmSelectionUI();
});
// Event delegation: individual row checkboxes are re-created on every table
// render, so listen on the stable tbody parent instead of each checkbox.
document.getElementById("crm-tbody").addEventListener("change", (e) => {
  if (e.target.classList.contains("crm-check")) updateCrmSelectionUI();
});

document.getElementById("crm-bulk-draft-btn").addEventListener("click", async () => {
  const idxs = getCheckedCrmIdxs();
  if (!idxs.length) { showMessage("Select at least one contact using the checkboxes.", "warn"); return; }

  const mode = document.getElementById("crm-mode-select").value;
  const extra = document.getElementById("crm-extra-instructions").value.trim();
  const btn = document.getElementById("crm-bulk-draft-btn");
  btn.disabled = true;

  /* Resolve addresses before drafting, not after. Every downstream step —
     the draft's To field, sending, export, the contact record — then reads a
     real address from our own database instead of each feature separately
     deciding whether it needs to call Apollo. */
  const bulkRev = await revealBeforeUse(
    idxs.map((i) => _crmContacts[i]).filter(Boolean), "address the drafts", "填写收件人");
  if (bulkRev.cancelled) {
    showMessage("Cancelled — no Apollo credits were used. 已取消，未消耗额度。", "info");
    return;
  }

  let reusedCount = 0;
  let generatedCount = 0;
  for (let n = 0; n < idxs.length; n++) {
    const i = idxs[n];
    const c = _crmContacts[i];
    btn.textContent = `Drafting ${n + 1} of ${idxs.length} selected…`;
    try {
      // No `regenerate` flag -- reuses an existing equivalent (contact, mode,
      // instructions) draft instead of re-calling Claude, so re-running this
      // over a category that's partly already drafted doesn't waste tokens.
      const r = await fetch("/api/draft-email", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact: crmRowToDraftFormat(c), sender: _sender, contactId: c.id, mode, extraInstructions: extra,
          options: currentDraftOptions(),
        }),
      });
      const d = await r.json();
      if (d.reused) reusedCount++; else generatedCount++;
    } catch (e) { /* skip */ }
  }

  btn.textContent = "Draft Emails for Selected";
  const reuseNote = reusedCount ? ` (${reusedCount} reused from cache, ${generatedCount} newly generated)` : "";
  showMessage(`Drafted emails for ${idxs.length} selected contact(s)${reuseNote} -- open "Draft Email" on each to review/edit before sending.`, "info");
  loadCrmContacts(document.getElementById("crm-search-input").value);
  refreshUsage();
});

/* ── Bulk delete ── */

document.getElementById("crm-bulk-delete-btn").addEventListener("click", () => {
  const idxs = getCheckedCrmIdxs();
  if (!idxs.length) return;
  document.getElementById("delete-confirm-text").textContent =
    `Are you sure you want to delete ${idxs.length} selected contact${idxs.length !== 1 ? "s" : ""}?`;
  openModal("delete-confirm-modal");
});

function closeDeleteConfirmModal() {
  closeModal("delete-confirm-modal");
}
document.getElementById("delete-confirm-close").addEventListener("click", closeDeleteConfirmModal);
document.getElementById("delete-confirm-cancel").addEventListener("click", closeDeleteConfirmModal);
document.getElementById("delete-confirm-modal").addEventListener("click", (e) => {
  if (e.target.id === "delete-confirm-modal") closeDeleteConfirmModal();
});

document.getElementById("delete-confirm-ok").addEventListener("click", async () => {
  const idxs = getCheckedCrmIdxs();
  if (!idxs.length) { closeDeleteConfirmModal(); return; }
  const ids = idxs.map(i => _crmContacts[i].id);
  const okBtn = document.getElementById("delete-confirm-ok");
  okBtn.disabled = true;
  try {
    const r = await fetch("/api/contacts/bulk-delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "Failed to delete contacts");
    showMessage(`Deleted ${d.deleted} contact${d.deleted !== 1 ? "s" : ""}.`, "info");
    closeDeleteConfirmModal();
    document.getElementById("crm-select-all").checked = false;
    loadCrmContacts(document.getElementById("crm-search-input").value);
    loadBrowseSelectors();
  } catch (e) {
    showMessage(`Delete failed: ${e.message}`, "error");
  } finally {
    okBtn.disabled = false;
  }
});

/* ══════════════════════════════════════════════════════════════════════
   CRM workspace wiring.

   Three behaviours the redesigned page depends on:
     1. Discovery (Apollo) opens in a modal instead of living above the list.
     2. Company Intelligence opens in a right-hand drawer.
     3. Filters apply on change — no "Apply filters" button to forget. The
        old button is kept (hidden) as the single implementation of that
        logic and is triggered programmatically.
   ══════════════════════════════════════════════════════════════════════ */

/* ── Import planner ──────────────────────────────────────────────────────
   "Find contacts" used to be a button you pressed and then found out what
   happened. Every decision it makes — how many you already hold, how many
   it will pull, what that costs, whether it appends or replaces — is now
   answered on screen before it runs, and the button states the outcome.

   The plan is read-only and free: /api/leads/plan never calls Apollo. The
   one figure it can't know for nothing is Apollo's true match count, so
   that is shown only when a previous search recorded it, with its date. */

function crmImportMode() {
  const el = document.querySelector('input[name="crm-import-mode"]:checked');
  return el ? el.value : "append";
}

function crmPlanInputs() {
  return {
    companies: (document.getElementById("company-input")?.value || "")
      .split(",").map((s) => s.trim()).filter(Boolean),
    target: Number(document.getElementById("search-per-company-limit")?.value) || 25,
    maxTotal: Number(document.getElementById("search-max-total")?.value) || 100,
    mode: crmImportMode(),
  };
}

function renderCrmPlan(plans) {
  const box = document.getElementById("crm-plan");
  const btn = document.getElementById("search-btn");
  if (!box) return;

  const totalNew = plans.reduce((n, p) => n + p.willRetrieve, 0);
  const totalReq = plans.reduce((n, p) => n + p.searchRequests, 0);
  const totalLookups = plans.reduce((n, p) => n + p.emailLookups, 0);
  const replacing = plans.some((p) => p.mode === "replace");
  // In replace mode the retrieved records are mostly ones already held, so
  // calling them "new" would overstate what actually gets added.
  const verb = replacing ? "to re-query" : "to retrieve";

  box.innerHTML = `
    <div class="crm-plan-head">What this will do</div>
    ${plans.map((p) => {
      const cost = p.searchRequests
        ? `~${p.searchRequests} Apollo search request${p.searchRequests !== 1 ? "s" : ""}${p.emailLookups ? `, plus up to ${p.emailLookups} email lookup${p.emailLookups !== 1 ? "s" : ""}` : ""}`
        : "No Apollo requests — nothing to fetch";
      const avail = p.apolloTotal
        ? `Apollo reported <b>${nf.format(p.apolloTotal)}</b> matching people${p.apolloTotalAt ? ` (as of ${new Date(p.apolloTotalAt).toLocaleDateString()})` : ""}.`
        : `How many more Apollo holds is unknown until the first search.`;
      return `
      <div class="crm-plan-row">
        <div class="crm-plan-co">${escapeHtml(p.company)}${p.known ? "" : `<span class="crm-plan-new">not yet in your CRM 尚未加入 CRM</span>`}</div>
        <div class="crm-plan-math">
          <span class="crm-plan-num"><b>${p.current}</b><span>now</span></span>
          <span class="crm-plan-op">→</span>
          <span class="crm-plan-num"><b>${p.target}</b><span>target</span></span>
          <span class="crm-plan-op">=</span>
          <span class="crm-plan-num crm-plan-get"><b>${p.willRetrieve > 0 ? (replacing ? "" : "+") + p.willRetrieve : "0"}</b><span>${verb}</span></span>
        </div>
        <div class="crm-plan-cost">${cost}. ${avail}</div>
        ${p.budgetLimited ? `<div class="crm-plan-warn">Trimmed by your "Maximum new contacts" cap — raise it to pull the rest.</div>` : ""}
        ${!p.willRetrieve && p.mode === "append" && p.current >= p.target
          ? `<div class="crm-plan-none">Already at or above the target — this company will be served from your database, costing nothing.</div>` : ""}
      </div>`;
    }).join("")}
    <div class="crm-plan-foot">
      ${replacing
        ? `<b>Full refresh.</b> Existing contacts are re-queried and updated in place — drafts, notes, tags, threads and history are kept. Nothing is deleted.`
        : `<b>Append only.</b> Your ${plans.reduce((n, p) => n + p.current, 0)} existing contact(s) are left untouched — new records are matched against them and only the missing ones are added.`}
    </div>`;
  box.hidden = false;

  if (btn && !btn.disabled) {
    btn.textContent = totalNew > 0
      ? (replacing
          ? `Refresh ${totalNew} contact${totalNew !== 1 ? "s" : ""}`
          : `Import up to ${totalNew} new contact${totalNew !== 1 ? "s" : ""}`)
      : "Search";
    btn.title = totalReq
      ? `About ${totalReq} Apollo search request(s) and up to ${totalLookups} email lookup(s)`
      : "";
  }
}

// Sequence number: editing the company and the target in quick succession
// fires two lookups, and the slower one must not repaint the plan with the
// older inputs' answer.
let _crmPlanSeq = 0;

async function refreshCrmPlan() {
  const box = document.getElementById("crm-plan");
  const btn = document.getElementById("search-btn");
  const { companies, target, maxTotal, mode } = crmPlanInputs();
  const seq = ++_crmPlanSeq;

  // Keep the checkbox doSearch() reads in step with the visible radios.
  const force = document.getElementById("crm-force-refresh");
  if (force) force.checked = mode === "replace";

  if (!companies.length) {
    if (box) { box.hidden = true; box.innerHTML = ""; }
    if (btn && !btn.disabled) { btn.textContent = "Search"; btn.title = ""; }
    return;
  }
  try {
    const d = await getJSON(`/api/leads/plan?companies=${encodeURIComponent(companies.join(","))}`
      + `&target=${target}&maxTotal=${maxTotal}&mode=${mode}`);
    if (seq !== _crmPlanSeq) return;      // a newer edit already answered
    renderCrmPlan(d.plans || []);
  } catch (e) {
    if (seq !== _crmPlanSeq) return;
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }
}

/* ══════════════════════════════════════════════════════════════════════
   Workflow dialogs: deliberate closing only

   Find contacts, Add more contacts and New company are multi-step
   configuration — companies, targets, departments, refresh mode — not
   confirmations. A stray click on the backdrop was discarding minutes of
   that, so the backdrop no longer closes them at all. They close on the ×,
   on Cancel, or on Esc, and if anything was configured, closing asks first.

   Dirty state is a snapshot comparison rather than a change flag: it stays
   correct when a user edits a field and then puts it back, which a flag
   would report as dirty forever.
   ══════════════════════════════════════════════════════════════════════ */

const _dialogBaselines = {};

function dialogFieldValue(el) {
  if (!el) return "";
  if (el.type === "checkbox" || el.type === "radio") return el.checked ? "1" : "0";
  return el.value == null ? "" : String(el.value);
}

// Snapshot every control inside the dialog, so a field added later is
// covered without anyone remembering to list it here.
function snapshotDialog(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  const snap = {};
  modal.querySelectorAll("input, textarea, select").forEach((el, i) => {
    snap[el.id || `#${i}`] = dialogFieldValue(el);
  });
  _dialogBaselines[modalId] = snap;
}

function dialogIsDirty(modalId) {
  const modal = document.getElementById(modalId);
  const base = _dialogBaselines[modalId];
  if (!modal || !base) return false;
  let dirty = false;
  modal.querySelectorAll("input, textarea, select").forEach((el, i) => {
    const key = el.id || `#${i}`;
    if (key in base && base[key] !== dialogFieldValue(el)) dirty = true;
  });
  return dirty;
}

function confirmDiscard(onDiscard) {
  const modal = document.getElementById("discard-changes-modal");
  if (!modal) { onDiscard(); return; }          // no confirm available: don't trap the user
  openModal("discard-changes-modal");
  const keep = document.getElementById("discard-keep-btn");
  const go = document.getElementById("discard-confirm-btn");
  const cleanup = () => {
    keep.replaceWith(keep.cloneNode(true));      // drop these one-shot handlers
    go.replaceWith(go.cloneNode(true));
    closeModal("discard-changes-modal");
  };
  keep.addEventListener("click", cleanup, { once: true });
  go.addEventListener("click", () => { cleanup(); onDiscard(); }, { once: true });
}

/* Wraps a dialog's close so it asks before discarding configuration. */
function guardedDialogClose(modalId, closeFn) {
  return () => {
    if (!dialogIsDirty(modalId)) { closeFn(); return; }
    confirmDiscard(closeFn);
  };
}

function openCrmDiscoverModal(prefillCompany) {
  const m = document.getElementById("crm-discover-modal");
  if (!m) return;
  m.classList.add("open");
  const input = document.getElementById("company-input");
  if (input) {
    if (prefillCompany) input.value = prefillCompany;
    setTimeout(() => { input.focus(); input.select(); }, 60);
  }
  // Snapshot AFTER prefilling, or a company carried in from elsewhere would
  // register as an unsaved change the user never made.
  snapshotDialog("crm-discover-modal");
  refreshCrmPlan();
}
function closeCrmDiscoverModal() {
  document.getElementById("crm-discover-modal")?.classList.remove("open");
}

/* ══════════════════════════════════════════════════════════════════════
   CRM object tabs: Contacts · Companies

   Company Intelligence outgrew the drawer it lived in. It is not a peer of
   the contact list — it is the record page for one account — so it now sits
   where Salesforce, HubSpot and Dynamics all put it: behind an object list
   view, opened by selecting a record.

   Both panes are mounted at all times and merely hidden, so switching tabs
   costs nothing and loses nothing: the contact table keeps its filters,
   page and selection; the company list keeps its search, filter and scroll.
   Neither pane re-fetches on a switch — only an explicit Refresh does.
   ══════════════════════════════════════════════════════════════════════ */

let _crmTab = "contacts";

function showCrmTab(name) {
  _crmTab = name === "companies" ? "companies" : "contacts";
  document.querySelectorAll("[data-crm-pane]").forEach((pane) => {
    pane.hidden = pane.dataset.crmPane !== _crmTab;
  });
  document.querySelectorAll("[data-crm-tab]").forEach((tab) => {
    const on = tab.dataset.crmTab === _crmTab;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  });
  // The bulk bar belongs to the contact table; it must not hover over the
  // company list.
  const bar = document.getElementById("crm-bulkbar");
  if (bar && _crmTab !== "contacts") bar.hidden = true;
  else if (bar && _crmTab === "contacts") updateCrmSelectionUI();

  // Load the company list lazily, once.
  if (_crmTab === "companies" && !_crmAccounts.length) loadCrmAccounts();
  try { localStorage.setItem("crm_tab", _crmTab); } catch (e) { /* ignore */ }
}

/* Opening an account = the Companies tab showing its record instead of the
   list. Kept as openCrmIntelDrawer()'s replacement, with the old names
   preserved as thin wrappers so existing call sites (e.g. the draft modal's
   "view/edit intelligence" link) keep working. */
function openCrmAccountRecord() {
  showCrmTab("companies");
  document.getElementById("crm-acct-list").hidden = true;
  document.getElementById("crm-acct-record").hidden = false;
}
function closeCrmAccountRecord() {
  document.getElementById("crm-acct-record").hidden = true;
  document.getElementById("crm-acct-list").hidden = false;
  // Counts and status may have changed while the record was open.
  loadCrmAccounts();
}
function openCrmIntelDrawer() { openCrmAccountRecord(); }
function closeCrmIntelDrawer() { /* records are navigated away from, not dismissed */ }

/* ── Companies list view ──────────────────────────────────────────────
   One row per account, showing the state the record page exists to
   resolve: does it have contacts, has it been analyzed, are its tags
   trusted — and therefore what to do next. The "Next step" column is the
   same computation the record page shows, so the list and the record can
   never disagree about what an account needs. */

let _crmAccounts = [];
let _crmAcctFilter = "all";
let _crmAcctPage = 1;
const CRM_ACCT_PAGE_SIZE = 25;

function acctNextStep(a) {
  if (!a.has_summary && !a.ai_analyzed_at && !a.tag_count) return { key: "analyze", label: "Run AI analysis" };
  if (!a.contact_count) return { key: "contacts", label: "Add contacts" };
  if (a.tag_count && !a.confirmed_count) return { key: "review", label: "Review tags" };
  return { key: "ready", label: "Ready" };
}

function crmAccountsFiltered() {
  const term = crmSearchTerm().toLowerCase();
  return _crmAccounts.filter((a) => {
    if (term) {
      const hay = `${a.name || ""} ${a.chinese_name || ""} ${a.industry || ""} ${a.booth || ""}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    // The source filter ANDs with the state filters rather than replacing
    // them: "uploaded companies that still have no contacts" is the question
    // this pair is actually for.
    if (_crmAcctSource && (a.source || "legacy") !== _crmAcctSource) return false;
    const step = acctNextStep(a).key;
    if (_crmAcctFilter === "no-contacts") return !a.contact_count;
    if (_crmAcctFilter === "not-analyzed") return step === "analyze";
    if (_crmAcctFilter === "needs-review") return step === "review";
    if (_crmAcctFilter === "ready") return step === "ready";
    return true;
  });
}

function renderCrmAccounts() {
  const tbody = document.getElementById("crm-acct-tbody");
  if (!tbody) return;
  const list = crmAccountsFiltered();
  const totalPages = Math.max(1, Math.ceil(list.length / CRM_ACCT_PAGE_SIZE));
  if (_crmAcctPage > totalPages) _crmAcctPage = totalPages;
  const slice = list.slice((_crmAcctPage - 1) * CRM_ACCT_PAGE_SIZE, _crmAcctPage * CRM_ACCT_PAGE_SIZE);

  setText("crm-tabcount-companies", _crmAccounts.length ? String(_crmAccounts.length) : "");

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7">
      <div class="table-empty-state">
        <div class="tes-icon">🏢</div>
        <div class="tes-title">No companies match</div>
        <div class="tes-hint">Clear the filter, or use “New company” to add one.</div>
      </div></td></tr>`;
    document.getElementById("crm-acct-pagination").innerHTML = "";
    return;
  }

  tbody.innerHTML = slice.map((a) => {
    const step = acctNextStep(a);
    const analysis = a.ai_analyzed_at
      ? `<span class="ca-ok">Analyzed</span><div class="cell-sub">${escapeHtml(intelFmtDate(a.ai_analyzed_at))}</div>`
      : a.has_summary || a.tag_count
        ? `<span class="ca-ok">Analyzed</span><div class="cell-sub">date not recorded</div>`
        : `<span class="ca-none">Not analyzed</span>`;
    const tags = a.tag_count
      ? `${a.tag_count} tag${a.tag_count !== 1 ? "s" : ""} 个标签<div class="cell-sub">${a.confirmed_count ? `${a.confirmed_count} confirmed 个已确认` : "none confirmed 无已确认"}</div>`
      : `<span class="ca-none">—</span>`;
    return `<tr class="crm-acct-row" data-acct-id="${a.id}" data-acct-name="${escapeAttr(a.name)}">
      <td data-no-i18n>
        <div class="cell-primary" style="font-weight:600;">${escapeHtml(a.name)}</div>
        ${a.chinese_name ? `<div class="cell-sub">${escapeHtml(a.chinese_name)}</div>` : ""}
      </td>
      <td data-no-i18n><div class="cell-primary">${escapeHtml(a.industry || "—")}</div>${a.booth ? `<div class="cell-sub">展位 ${escapeHtml(a.booth)}</div>` : ""}</td>
      <td data-no-i18n>
        <div class="ca-prov">${escapeHtml(COMPANY_SOURCE_LABELS[a.source || "legacy"] || a.source || "—")}</div>
        ${a.source_file ? `<div class="cell-sub">${escapeHtml(a.source_file)}</div>` : ""}
      </td>
      <td>${a.contact_count ? `<b>${a.contact_count}</b>` : `<span class="ca-none">0</span>`}</td>
      <td>${analysis}</td>
      <td>${tags}</td>
      <td><span class="ca-step ca-step-${step.key}">${step.label}</span></td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".crm-acct-row").forEach((row) => {
    row.addEventListener("click", () => openCrmAccount(Number(row.dataset.acctId), row.dataset.acctName));
  });

  const pag = document.getElementById("crm-acct-pagination");
  pag.innerHTML = totalPages <= 1 ? "" : `
    <button class="btn-sm btn-ghost" id="crm-acct-prev" ${_crmAcctPage <= 1 ? "disabled" : ""}>← Prev</button>
    <span style="font-size:0.85rem;color:#555;">Page 第 ${_crmAcctPage} / ${totalPages} 页 · ${list.length} 家公司</span>
    <button class="btn-sm btn-ghost" id="crm-acct-next" ${_crmAcctPage >= totalPages ? "disabled" : ""}>Next →</button>`;
  document.getElementById("crm-acct-prev")?.addEventListener("click", () => { _crmAcctPage--; renderCrmAccounts(); });
  document.getElementById("crm-acct-next")?.addEventListener("click", () => { _crmAcctPage++; renderCrmAccounts(); });
}

let _crmAcctSource = "";      // "" = all discovery paths

async function loadCrmAccounts() {
  try {
    const d = await getJSON("/api/companies/summary");
    _crmAccounts = d.companies || [];
    renderCrmAccounts();
    populateCompanySourceFilter();
  } catch (e) { /* leave whatever is already listed */ }
}

/* Options come with their counts, so the filter doubles as the answer to
   "how much of the CRM can we trace" — including how much still cannot. */
async function populateCompanySourceFilter() {
  const sel = document.getElementById("crm-acct-source");
  if (!sel || sel.dataset.filled) return;
  try {
    const d = await getJSON("/api/companies/source-counts");
    const total = (d.options || []).reduce((n, o) => n + o.n, 0);
    sel.innerHTML = `<option value="">All sources 全部来源 (${total})</option>`
      + (d.options || []).map((o) =>
          `<option value="${escapeAttr(o.key)}">${escapeHtml(COMPANY_SOURCE_LABELS[o.key] || o.key)} (${o.n})</option>`).join("");
    sel.dataset.filled = "1";
    sel.addEventListener("change", () => {
      _crmAcctSource = sel.value;
      _crmAcctPage = 1;
      renderCrmAccounts();
    });
  } catch (e) { console.error("company source counts:", e); }
}

// Opens one account's record page. The panel keeps its own sub-tabs for
// several open accounts, so comparing two companies doesn't mean losing
// either.
function openCrmAccount(id, name) {
  openCrmAccountRecord();
  addCrmIntelCompany(id, name);
}

/* ══════════════════════════════════════════════════════════════════════
   Add more contacts · 补充联系人

   Apollo enrichment for a company already in the CRM, as opposed to
   "Find contacts" (discovery, may be a company you don't hold) and
   "New contact" (manual, one person).

   It is the same append-only pipeline the account record page uses —
   /api/leads/plan to say what will happen, then /api/leads/search in
   append mode — so the guarantees are identical: dedupe against what you
   already hold, fetch only the shortfall, never rewrite an existing row.
   ══════════════════════════════════════════════════════════════════════ */

let _topupSeq = 0;

/* Which company the dialog should open on, and why.

   Two sources of context, in this order:

     1. The active company filter. If the list is already scoped to one
        company that is an explicit choice the user made, so it beats
        anything inferred from free text.
     2. The global search box — but only when the term resolves to exactly
        one company. "Zach" matches the contact Zachary and no company; a
        term matching several companies is equally unusable. In both cases
        guessing would be worse than not guessing, so the field is left
        empty and the candidates are offered instead.

   Returns { name, source, suggestions }. `name` empty means "don't
   prefill"; `suggestions` is what to show when we declined to guess. */
function resolveTopupCompany() {
  const scoped = (_crmActiveFilters.accounts || [])[0];
  if (scoped) return { name: scoped, source: "filter", suggestions: [] };

  const term = crmSearchTerm();
  if (!term) return { name: "", source: "none", suggestions: [] };

  const t = lc(term);
  const exact = _crmAccounts.find((c) => lc(c.name) === t || lc(c.chinese_name || "") === t);
  if (exact) return { name: exact.name, source: "search-exact", suggestions: [] };

  const matches = _crmAccounts.filter((c) =>
    lc(c.name).includes(t) || lc(c.chinese_name || "").includes(t));
  if (matches.length === 1) return { name: matches[0].name, source: "search-unique", suggestions: [] };

  // Ambiguous, or the term describes a person rather than a company.
  return {
    name: "",
    source: matches.length ? "ambiguous" : "no-company-match",
    suggestions: matches
      .slice()
      .sort((a, b) => (b.contact_count || 0) - (a.contact_count || 0))
      .slice(0, 6),
  };
}

function renderTopupContext(res) {
  const box = document.getElementById("topup-context");
  if (!box) return;
  const term = crmSearchTerm();

  if (res.source === "filter") {
    box.innerHTML = `<span class="topup-ctx-note">Using the company this list is filtered to. 已使用当前筛选的公司。</span>`;
  } else if (res.source === "search-exact" || res.source === "search-unique") {
    box.innerHTML = `<span class="topup-ctx-note">Matched “${escapeHtml(term)}” from the search bar. 已根据搜索栏内容匹配。</span>`;
  } else if (res.suggestions.length) {
    box.innerHTML = `<span class="topup-ctx-note">“${escapeHtml(term)}” matches several companies — pick one: 匹配到多家公司，请选择：</span>
      <span class="topup-sugs">${res.suggestions.map((c) =>
        `<button type="button" class="topup-sug" data-topup-pick="${escapeAttr(c.name)}"
           ><span data-no-i18n>${escapeHtml(c.name)}</span> <span class="topup-sug-n">${c.contact_count}</span></button>`).join("")}</span>`;
  } else if (term) {
    box.innerHTML = `<span class="topup-ctx-note">“${escapeHtml(term)}” doesn't match a saved company — choose one above. 未匹配到已保存的公司，请在上方选择。</span>`;
  } else {
    box.innerHTML = "";
  }

  box.querySelectorAll("[data-topup-pick]").forEach((b) => b.addEventListener("click", () => {
    const input = document.getElementById("topup-company");
    if (input) input.value = b.dataset.topupPick;
    box.innerHTML = "";
    refreshTopupPlan();
  }));
}

async function openCrmTopupModal(prefillCompany) {
  _topupPhase = "ready";           // a reopened dialog is never mid-run
  _topupResult = null;
  const m = document.getElementById("crm-topup-modal");
  if (!m) return;

  // The picker lists companies already in the CRM; this is enrichment, not
  // discovery, so a name that isn't saved yet belongs in "Find contacts".
  if (!_crmAccounts.length) await loadCrmAccounts();
  const list = document.getElementById("topup-company-list");
  if (list) {
    list.innerHTML = _crmAccounts
      .slice()
      .sort((a, b) => (b.contact_count || 0) - (a.contact_count || 0))
      .map((c) => `<option value="${escapeAttr(c.name)}">${escapeHtml(c.chinese_name || "")} · ${c.contact_count} contacts</option>`)
      .join("");
  }

  // An explicit caller (the company context bar) wins; otherwise infer from
  // the filter, then the search box. Prefilling only fills the field — it
  // never starts an import, and the plan preview it triggers is read-only
  // and free (/api/leads/plan never contacts Apollo).
  const res = prefillCompany
    ? { name: prefillCompany, source: "filter", suggestions: [] }
    : resolveTopupCompany();
  const input = document.getElementById("topup-company");
  if (input) input.value = res.name;
  renderTopupContext(res);

  m.classList.add("open");
  snapshotDialog("crm-topup-modal");
  refreshTopupPlan();
  // Land on the number when the company is settled, on the company when not.
  setTimeout(() => (res.name ? document.getElementById("topup-target") : input)?.focus(), 60);
}

function closeCrmTopupModal() {
  document.getElementById("crm-topup-modal")?.classList.remove("open");
}

async function refreshTopupPlan() {
  const name = (document.getElementById("topup-company")?.value || "").trim();
  const target = Math.max(1, Math.min(Number(document.getElementById("topup-target")?.value) || 50, 500));
  const box = document.getElementById("topup-plan");
  const runBtn = document.getElementById("topup-run");
  const current = document.getElementById("topup-current");
  const seq = ++_topupSeq;

  /* The primary action is disabled the moment anything changes, and only
     re-enabled by a fresh plan that says the import can actually run.

     Previously it kept its old state while a plan was in flight (300ms
     debounce plus a round trip) and after a failed request, so the dialog
     could show "not in your CRM" beside an enabled Append button — offering
     an action that could not do what its label claimed. */
  if (runBtn) runBtn.disabled = true;

  if (!name) {
    box.hidden = true;
    if (current) current.textContent = "";
    if (runBtn) runBtn.textContent = "Retrieve contacts";
    const t0 = document.getElementById("topup-title");
    if (t0) t0.textContent = "Add more contacts";
    return;
  }

  try {
    const d = await getJSON(`/api/leads/plan?companies=${encodeURIComponent(name)}`
      + `&target=${target}&maxTotal=${target}&mode=append`);
    if (seq !== _topupSeq) return;                 // a newer edit already answered
    const p = (d.plans || [])[0];
    if (!p) return;

    if (current) current.textContent = `${p.current} in CRM now 当前已有`;

    if (!p.known) {
      // A dead end is worse than a detour: hand the user straight into the
      // workflow that CAN do this, carrying the name and target across.
      box.innerHTML = `<div class="crm-plan-row">
        <div class="crm-plan-cost">
          “${escapeHtml(name)}” isn't in your CRM yet, so there is nothing to add to.
          Discovering it is the Find contacts workflow.
          <br><span class="i18n-zh" style="margin-left:0;">该公司尚未加入 CRM，无法执行「追加」。请改用「查找联系人」。</span>
        </div>
        <div class="crm-plan-row-actions">
          <button type="button" class="btn-primary btn-sm" id="topup-switch-find">Find contacts for “${escapeHtml(name)}”</button>
        </div>
      </div>`;
      box.hidden = false;
      if (runBtn) runBtn.textContent = "Retrieve contacts";
      document.getElementById("topup-switch-find")?.addEventListener("click", () => {
        closeCrmTopupModal();
        const t = document.getElementById("search-per-company-limit");
        if (t) t.value = target;                 // carry the target across
        openCrmDiscoverModal(name);
      });
      return;
    }

    /* Four distinct states, each with its own wording and action:
         · first import   — 0 held, so "append" was the wrong word entirely
         · top-up         — some held, add the difference
         · nothing to do  — already at or above the target
         · last search failed — say so instead of estimating over it

       Apollo's real match count, when a previous search recorded it, caps
       what can honestly be promised. Claiming "up to 75" when Apollo holds
       2 is the same over-promise in a politer form. */
    const first = p.firstImport;

    /* The dialog's own title was fixed at "Add more contacts / appends them"
       even when the company had none — describing an append that wasn't one.
       The header follows the state like everything else. */
    const title = document.getElementById("topup-title");
    const sub = document.getElementById("topup-subtitle");
    if (title) title.textContent = first ? "Import contacts" : "Add more contacts";
    if (sub) {
      sub.textContent = first
        ? "This company has no contacts yet. Pulls its first contacts from Apollo into your CRM. 该公司尚无联系人，将从 Apollo 导入首批联系人。"
        : "Pulls additional contacts from Apollo for one company and appends them. Existing contacts, drafts, tags, notes and history are never changed. 已有联系人、草稿、标签、备注与历史记录不会被修改。";
    }

    const avail = p.availableBeyondHeld;                 // null = unknown
    const realistic = avail == null ? p.willRetrieve : Math.min(p.willRetrieve, avail);
    const verb = first ? "to import" : "to add";

    const failureBanner = p.lastError ? `
      <div class="crm-plan-row topup-warn">
        <b>⚠ The last Apollo search for this company failed 上次搜索失败</b>
        <div class="crm-plan-cost">${escapeHtml(p.lastError)}${p.lastErrorAt ? ` · ${intelFmtDate(p.lastErrorAt)}` : ""}</div>
        <div class="crm-plan-cost">The estimate below assumes Apollo is reachable again. 以下预估假设 Apollo 已恢复。</div>
      </div>` : "";

    let availLine;
    if (avail == null) {
      availLine = `How many Apollo actually has here is unknown until we ask — it may return fewer than ${p.target}, or none.`;
    } else if (avail === 0) {
      availLine = `A previous search found <b>${nf.format(p.apolloTotal)}</b> matching people at this company${p.apolloTotalAt ? ` (${intelFmtDate(p.apolloTotalAt)})` : ""} — you already hold them all, so this will likely return nothing new.`;
    } else if (avail < p.willRetrieve) {
      availLine = `<b>Apollo only has ${nf.format(p.apolloTotal)} matching people at this company</b>${p.apolloTotalAt ? ` (seen ${intelFmtDate(p.apolloTotalAt)})` : ""}, so expect about <b>${realistic}</b>, not ${p.willRetrieve}. Apollo 匹配人数有限。`;
    } else {
      availLine = `A previous search saw <b>${nf.format(p.apolloTotal)}</b> matching people at this company${p.apolloTotalAt ? ` (${intelFmtDate(p.apolloTotalAt)})` : ""}.`;
    }

    box.innerHTML = `
      <div class="crm-plan-head">${first ? "First import for this company 首次导入" : "What this will do 本次操作预览"}</div>
      ${failureBanner}
      <div class="crm-plan-row">
        <div class="crm-plan-co" data-no-i18n>${escapeHtml(p.company)}</div>
        <div class="crm-plan-math">
          <span class="crm-plan-num"><b>${p.current}</b><span>now</span></span>
          <span class="crm-plan-op">→</span>
          <span class="crm-plan-num"><b>${p.target}</b><span>target</span></span>
          <span class="crm-plan-op">=</span>
          <span class="crm-plan-num crm-plan-get"><b>${p.willRetrieve > 0 ? "up to " + p.willRetrieve : "0"}</b><span>${verb}</span></span>
        </div>
        <div class="crm-plan-cost">${p.searchRequests
          ? `Costs about ${p.searchRequests} Apollo search request(s), plus up to ${p.emailLookups} email lookup(s).`
          : "No Apollo requests — nothing to fetch"}</div>
        <div class="crm-plan-cost">${availLine}</div>
        ${p.willRetrieve === 0 && p.current >= p.target
          ? `<div class="crm-plan-none">Already at or above the target — raise it to pull more.</div>` : ""}
      </div>
      <div class="crm-plan-foot">${first
        ? `<b>First import.</b> This company has no contacts yet, so nothing can be overwritten. 该公司尚无联系人。`
        : `<b>Append only.</b> The ${p.current} contact${p.current !== 1 ? "s" : ""} already saved are left exactly as they are. 已保存的 ${p.current} 位联系人保持不变。`}</div>`;
    box.hidden = false;
    if (runBtn) {
      runBtn.disabled = p.willRetrieve === 0;
      // "Import" for a company with nothing, "Add" for one being topped up —
      // and never a promise of an exact number Apollo hasn't confirmed.
      runBtn.textContent = p.willRetrieve === 0
        ? "Nothing to retrieve"
        : first
          ? `Import up to ${p.willRetrieve} contact${p.willRetrieve !== 1 ? "s" : ""} 最多导入 ${p.willRetrieve} 位`
          : `Add up to ${p.willRetrieve} contact${p.willRetrieve !== 1 ? "s" : ""} 最多补充 ${p.willRetrieve} 位`;
    }
  } catch (e) {
    if (seq !== _topupSeq) return;
    // Leave the action disabled (set at the top) and say why, rather than
    // silently hiding the panel with a stale enabled button behind it.
    box.innerHTML = `<div class="crm-plan-row"><div class="crm-plan-cost">
      Couldn't check this company just now — ${escapeHtml(e.message || "network error")}. Try again.
      </div></div>`;
    box.hidden = false;
  }
}

/* The dialog's action button changes meaning after a run: "Import" becomes
   "Close"/"View contacts". That was implemented by assigning btn.onclick —
   which does NOT replace the addEventListener that runs the import, so the
   finished-state click fired BOTH: another paid Apollo search, and then the
   close. The modal vanished, credits were spent, and nothing visible
   happened. One listener, one phase flag, no second handler to forget. */
let _topupPhase = "ready";        // ready → running → done
let _topupResult = null;          // { company, imported, total } for the done phase

function onTopupRunClick() {
  if (_topupPhase === "running") return;        // ignore double-clicks mid-flight
  if (_topupPhase === "done") { finishTopup(); return; }
  runCrmTopup();
}

/* Leaving the dialog after a successful import should land on the contacts
   it just created — that is what "import" implies. Closing onto an
   unchanged screen is why a working import read as a no-op. */
function finishTopup() {
  const r = _topupResult;
  _topupPhase = "ready";
  _topupResult = null;
  closeCrmTopupModal();
  if (r && r.imported > 0) {
    showCrmTab("contacts");
    setCrmAccounts([r.company]);
    showMessage(`${r.imported} contact${r.imported === 1 ? "" : "s"} imported for ${r.company}. `
      + `已为 ${r.company} 导入 ${r.imported} 位联系人。`, "info");
  }
}

async function runCrmTopup() {
  const name = (document.getElementById("topup-company")?.value || "").trim();
  const target = Math.max(1, Math.min(Number(document.getElementById("topup-target")?.value) || 50, 500));
  const btn = document.getElementById("topup-run");
  const box = document.getElementById("topup-plan");
  if (!name || !btn) return;

  /* Apollo can take 30-60s. Without feedback the dialog looks frozen, and a
     user who has just been told this spends credits will reasonably start
     clicking again. The stages below are honest about being indicative —
     the server does not stream progress, so they are labelled as such
     rather than pretending to track the real request. */
  _topupPhase = "running";
  btn.disabled = true;
  btn.textContent = "Retrieving… 检索中…";
  const stages = [
    "Searching Apollo for this company 搜索公司",
    "Finding people at the company 查找联系人",
    "Matching against your CRM 与 CRM 去重",
    "Saving new contacts 保存联系人",
  ];
  let stage = 0;
  const paint = () => {
    box.hidden = false;
    box.innerHTML = `<div class="crm-plan-row">
      <div class="topup-progress">
        ${stages.map((label, i) => `
          <div class="topup-stage ${i < stage ? "done" : i === stage ? "active" : ""}">
            <span class="topup-dot">${i < stage ? "✓" : i === stage ? "<span class='spinner'></span>" : "○"}</span>
            <span>${escapeHtml(label)}</span>
          </div>`).join("")}
      </div>
      <div class="crm-plan-cost">This can take up to a minute. Emails are revealed afterwards, in the contact list.
        <br>整个过程可能需要一分钟，请勿重复点击。</div>
    </div>`;
  };
  paint();
  const tick = setInterval(() => { if (stage < stages.length - 1) { stage++; paint(); } }, 4000);

  try {
    const r = await fetch("/api/leads/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      // force:false is what makes this append rather than re-query.
      body: JSON.stringify({ companies: name, force: false, perCompanyLimit: target, maxTotal: target, departments: [] }),
    });
    const d = await r.json();
    clearInterval(tick);

    if (!r.ok || d.error) {
      // Surface the real failure here instead of a toast behind the dialog.
      box.innerHTML = `<div class="crm-plan-row"><div class="topup-failed">
        <b>Apollo search failed 搜索失败</b><br>${escapeHtml(d.error || `HTTP ${r.status}`)}${d.details ? `<br><span class="crm-plan-cost">${escapeHtml(String(d.details).slice(0, 200))}</span>` : ""}
        <br><span class="crm-plan-cost">Nothing was imported. 未导入任何联系人。</span>
      </div></div>`;
      _topupPhase = "ready";
      btn.textContent = "Try again 重试";
      btn.disabled = false;
      return;
    }

    /* What actually happened, from the server's own counts — not what we
       predicted. Apollo routinely returns fewer than the target. */
    const sum = (d.summaries || [])[0] || {};
    const found = Number(sum.foundCount) || 0;
    const imported = Number(sum.importedCount) || 0;
    const held = Number(sum.alreadyHeldCount) || 0;
    const total = Number(sum.totalCount);
    const short = imported < target - held;
    box.innerHTML = `<div class="crm-plan-row">
      <div class="topup-done"><b>✓ Finished 完成</b></div>
      <ul class="topup-summary">
        <li>Apollo returned <b>${found}</b> record(s) Apollo 返回</li>
        <li><b>${imported}</b> new contact(s) imported 新增导入</li>
        <li><b>${held}</b> already in your CRM, left untouched 已存在，未改动</li>
        ${Number.isFinite(total) ? `<li>This company now has <b>${total}</b> contact(s) 当前共有</li>` : ""}
      </ul>
      ${short ? `<div class="crm-plan-cost">Fewer than the target — Apollo had no more matching people for this company. 少于目标数量，Apollo 已无更多匹配。</div>` : ""}
      ${(d.messages || []).filter((m) => !String(m).startsWith("CACHE:")).map((m) => `<div class="crm-plan-cost">${escapeHtml(m)}</div>`).join("")}
    </div>`;
    _topupPhase = "done";
    _topupResult = { company: name, imported, total };
    // The button says what it will do, which differs by outcome: there is
    // nothing to view when Apollo returned nobody.
    btn.textContent = imported > 0
      ? `View ${imported} new contact${imported === 1 ? "" : "s"} 查看新联系人`
      : "Close 关闭";
    btn.disabled = false;

    refreshUsage();
    loadBrowseSelectors();
    loadCrmAccounts();
  } catch (e) {
    clearInterval(tick);
    box.innerHTML = `<div class="crm-plan-row"><div class="topup-failed">
      <b>Network error 网络错误</b><br>${escapeHtml(e.message)}
      <br><span class="crm-plan-cost">Nothing was imported. 未导入任何联系人。</span></div></div>`;
    _topupPhase = "ready";
    btn.textContent = "Try again 重试";
    btn.disabled = false;
  }
}

function initCrmWorkspace() {
  document.getElementById("crm-find-btn")?.addEventListener("click", () => openCrmDiscoverModal());

  // ── Add more contacts ──
  document.getElementById("crm-topup-btn")?.addEventListener("click", () => openCrmTopupModal());
  const guardedTopupClose = guardedDialogClose("crm-topup-modal", closeCrmTopupModal);
  document.querySelectorAll("[data-topup-close]").forEach((b) =>
    b.addEventListener("click", guardedTopupClose));
  /* Invalidate synchronously, re-validate asynchronously.

     Disabling inside the debounced plan left a ~300ms window in which the
     button still carried the previous company's verdict — long enough to
     click "Append 49 contacts" for a company that had just been replaced.
     The keystroke itself now revokes the action; only a returned plan can
     grant it again. */
  const invalidateTopup = () => {
    const b = document.getElementById("topup-run");
    if (b) b.disabled = true;
  };
  const planSoon = debounce(refreshTopupPlan, 300);
  ["topup-company", "topup-target"].forEach((id) =>
    document.getElementById(id)?.addEventListener("input", () => { invalidateTopup(); planSoon(); }));
  document.getElementById("topup-run")?.addEventListener("click", onTopupRunClick);

  // ── Object tabs ──
  document.querySelectorAll("[data-crm-tab]").forEach((tab) =>
    tab.addEventListener("click", () => showCrmTab(tab.dataset.crmTab)));
  let savedTab = "contacts";
  try { savedTab = localStorage.getItem("crm_tab") || "contacts"; } catch (e) { /* ignore */ }
  showCrmTab(savedTab);

  // ── Companies list ──
  document.getElementById("crm-acct-refresh")?.addEventListener("click", loadCrmAccounts);
  document.getElementById("crm-acct-back")?.addEventListener("click", closeCrmAccountRecord);
  document.querySelectorAll("[data-acct-filter]").forEach((b) => b.addEventListener("click", () => {
    _crmAcctFilter = b.dataset.acctFilter;
    _crmAcctPage = 1;
    document.querySelectorAll("[data-acct-filter]").forEach((x) => x.classList.toggle("active", x === b));
    renderCrmAccounts();
  }));
  document.getElementById("crm-acct-new-btn")?.addEventListener("click", () => openNewCompanyModal());

  // ── New company dialog ──
  const guardedNewcoClose = guardedDialogClose("crm-newco-modal", closeNewCompanyModal);
  document.querySelectorAll("[data-newco-close]").forEach((b) =>
    b.addEventListener("click", guardedNewcoClose));
  document.getElementById("newco-create")?.addEventListener("click", submitNewCompany);
  document.getElementById("newco-name")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitNewCompany();
  });

  // Keep the plan in step with every input that changes its outcome.
  document.getElementById("company-input")?.addEventListener("input", debounce(refreshCrmPlan, 300));
  ["search-per-company-limit", "search-max-total"].forEach((id) =>
    document.getElementById(id)?.addEventListener("input", debounce(refreshCrmPlan, 250)));
  document.querySelectorAll('input[name="crm-import-mode"]').forEach((r) =>
    r.addEventListener("change", refreshCrmPlan));
  // Backdrop clicks are deliberately NOT wired: this dialog is a workflow,
  // and a stray click on the scrim was discarding a full configuration.
  const guardedDiscoverClose = guardedDialogClose("crm-discover-modal", closeCrmDiscoverModal);
  document.querySelectorAll("[data-crm-discover-close]").forEach((b) =>
    b.addEventListener("click", guardedDiscoverClose));

  document.getElementById("crm-intel-open-btn")?.addEventListener("click", openCrmIntelDrawer);
  document.getElementById("crm-intel-close")?.addEventListener("click", closeCrmIntelDrawer);
  document.getElementById("crm-intel-scrim")?.addEventListener("click", closeCrmIntelDrawer);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // The confirm sits on top; Esc there means "keep editing".
    const discard = document.getElementById("discard-changes-modal");
    if (discard && discard.classList.contains("open")) {
      closeModal("discard-changes-modal");
      return;
    }
    const open = (id) => document.getElementById(id)?.classList.contains("open");
    if (open("crm-newco-modal")) guardedNewcoClose();
    else if (open("crm-topup-modal")) guardedTopupClose();
    else if (open("crm-discover-modal")) guardedDiscoverClose();
  });

  // Filters apply as they change: text after a pause, selects immediately.
  const apply = () => document.getElementById("crm-apply-filters-btn").click();
  const applyDebounced = debounce(apply, 350);
  ["crm-filter-event", "crm-filter-industry", "crm-filter-owner"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", applyDebounced);
  });
  document.getElementById("crm-filter-status")?.addEventListener("change", apply);

  // Open "More filters" on load if anything inside it is already applied,
  // so an active filter is never hidden behind a closed disclosure.
  const more = document.getElementById("crm-more-filters");
  if (more) {
    const hasHidden = () => ["event", "industry", "follow_up_status", "assigned_salesperson"]
      .some((k) => _crmActiveFilters[k])
      || (_crmActiveFilters.department_categories || []).length
      || (_crmActiveFilters.seniority_levels || []).length;
    if (hasHidden()) more.open = true;
    // The rail scrolls internally, so an expanded disclosure can open
    // entirely below the fold and read as "nothing happened".
    more.addEventListener("toggle", () => {
      if (more.open) more.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  document.getElementById("crm-bulk-clear")?.addEventListener("click", clearCrmSelection);

  // ── Draft options in the bulk bar ──
  const optsBtn = document.getElementById("crm-bulk-opts-btn");
  const optsPop = document.getElementById("crm-bulk-opts-popover");
  if (optsBtn && optsPop) {
    const label = document.getElementById("crm-bulk-opts-label");
    const setLabel = async (o) => {
      const cat = await loadDraftOptionsCatalog();
      if (label) label.textContent = draftOptionsSummary(o || getSavedDraftOptions(), cat);
    };
    renderDraftOptions(document.getElementById("bulk-draft-options"), "bulk", setLabel);
    setLabel();
    optsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      optsPop.hidden = !optsPop.hidden;
      optsBtn.setAttribute("aria-expanded", optsPop.hidden ? "false" : "true");
    });
    document.addEventListener("click", (e) => {
      if (optsPop.hidden) return;
      if (!optsPop.contains(e.target) && e.target !== optsBtn) {
        optsPop.hidden = true;
        optsBtn.setAttribute("aria-expanded", "false");
      }
    });
  }
}

/* ── Init ── */

initAppShell();
loadSenderProfile();
loadDraftModes();
initIntelligenceView();
initAiUsageDashboard();
initEmailSettings();
initTagPriority();
loadCrmContacts();
loadBrowseSelectors();
loadSearchTaxonomy();
refreshUsage();

/* Deferred one microtask, until this script has finished evaluating.

   initCrmIntel() → loadCrmIntelCompanyOptions() → loadIntelTaxonomy(), whose
   first line reads `_intelTaxonomy` — a module-level `let` declared several
   hundred lines *below* this init block. Called synchronously here it hits
   the temporal dead zone and throws, and loadCrmIntelCompanyOptions()
   swallows the error in its catch, so the "+ add company…" dropdown was
   left permanently empty with nothing reported. A microtask runs after all
   top-level declarations are initialised. */
queueMicrotask(() => {
  initCrmIntel();
  initCrmWorkspace();
});

// =========================================================================
// Import Email modal
// =========================================================================

const importEmailModal = document.getElementById("import-email-modal");
let _importResult = null; // holds ingest API response during confirm step

const EMAIL_CATEGORIES = [
  { value: 'cold_outreach',        label: 'Cold outreach' },
  { value: 'follow_up',            label: 'Follow-up' },
  { value: 'conference_outreach',  label: 'Conference outreach' },
  { value: 'partnership_discussion', label: 'Partnership discussion' },
  { value: 'sales_discussion',     label: 'Sales discussion' },
  { value: 'innovation_update',    label: 'Innovation update' },
  { value: 'meeting_recap',        label: 'Meeting recap' },
  { value: 'other',                label: 'Other' }
];

function populateCategorySelect(sel, selectedValue) {
  sel.innerHTML = EMAIL_CATEGORIES.map(c =>
    `<option value="${c.value}" ${c.value === selectedValue ? 'selected' : ''}>${c.label}</option>`
  ).join('');
}

document.getElementById("crm-import-email-btn").addEventListener("click", () => {
  document.getElementById("import-email-form").style.display = "";
  document.getElementById("import-email-confirm").style.display = "none";
  document.getElementById("import-email-result").style.display = "none";
  document.getElementById("import-email-raw").value = "";
  document.getElementById("import-from").value = "";
  document.getElementById("import-to").value = "";
  document.getElementById("import-subject").value = "";
  document.getElementById("import-date").value = "";
  document.getElementById("import-body").value = "";
  _importResult = null;
  openModal("import-email-modal");
});

document.getElementById("import-email-close").addEventListener("click", () => {
  closeModal("import-email-modal");
});
importEmailModal.addEventListener("click", e => {
  if (e.target === importEmailModal) closeModal("import-email-modal");
});

document.getElementById("import-email-submit-btn").addEventListener("click", async () => {
  const btn = document.getElementById("import-email-submit-btn");
  const raw = document.getElementById("import-email-raw").value.trim();
  const from = document.getElementById("import-from").value.trim();
  const to = document.getElementById("import-to").value.trim();
  const subject = document.getElementById("import-subject").value.trim();
  const date = document.getElementById("import-date").value;
  const body = document.getElementById("import-body").value.trim();

  if (!raw && !from && !subject && !body) {
    showMessage("Please paste an email or fill in at least From / Subject / Body.", "warn");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Parsing…";
  try {
    const r = await fetch("/api/emails/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_text: raw || undefined, from: from || undefined, to: to || undefined, subject: subject || undefined, body: body || undefined, sent_at: date || undefined })
    });
    const d = await r.json();
    if (!r.ok || d.error) { showMessage("Error: " + (d.error || "Unknown"), "error"); return; }

    _importResult = d;

    // Show confirm step
    const matchedEl = document.getElementById("import-matched-contact");
    if (d.contact_name) {
      matchedEl.textContent = d.contact_name + (d.company_name ? ` · ${d.company_name}` : '');
      matchedEl.style.color = d.review_needed ? "#0F6CBD" : "#111827";
      if (d.review_needed) {
        matchedEl.textContent += " (new stub — please verify)";
      }
    } else {
      matchedEl.textContent = "No contact matched";
      matchedEl.style.color = "#9ca3af";
    }

    const catSel = document.getElementById("import-category-select");
    populateCategorySelect(catSel, d.category || 'other');

    document.getElementById("import-email-form").style.display = "none";
    document.getElementById("import-email-confirm").style.display = "";
  } catch (e) {
    showMessage("Network error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Parse & Save";
  }
});

document.getElementById("import-back-btn").addEventListener("click", () => {
  document.getElementById("import-email-form").style.display = "";
  document.getElementById("import-email-confirm").style.display = "none";
});

document.getElementById("import-confirm-btn").addEventListener("click", async () => {
  if (!_importResult) return;
  const btn = document.getElementById("import-confirm-btn");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const catSel = document.getElementById("import-category-select");
    const overrideSel = document.getElementById("import-contact-override");
    const newContactId = overrideSel.value ? Number(overrideSel.value) : undefined;
    const newCategory = catSel.value;

    // Update if category or contact changed
    if (newCategory !== _importResult.category || newContactId) {
      await fetch(`/api/emails/${_importResult.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: newCategory,
          contact_id: newContactId || _importResult.contact_id,
          review_needed: false
        })
      });
    } else if (_importResult.review_needed) {
      await fetch(`/api/emails/${_importResult.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review_needed: false })
      });
    }

    const resultEl = document.getElementById("import-email-result");
    resultEl.style.display = "";
    resultEl.innerHTML = `Saved: <strong>${escapeHtml(_importResult.subject || "(no subject)")}</strong> → <strong>${escapeHtml(_importResult.contact_name || "unmatched")}</strong> as <em>${newCategory.replace(/_/g,' ')}</em>`;
    document.getElementById("import-email-confirm").style.display = "none";
    document.getElementById("import-email-form").style.display = "";

    loadCrmContacts(document.getElementById("crm-search-input").value);
    refreshNeedsReviewBadge();
    _importResult = null;
  } finally {
    btn.disabled = false;
    btn.textContent = "Confirm & Save";
  }
});

document.getElementById("import-change-contact-btn").addEventListener("click", async () => {
  const sel = document.getElementById("import-contact-override");
  if (sel.style.display === "none") {
    // Lazy-load contact list into the select
    if (sel.options.length <= 1) {
      try {
        const r = await fetch("/api/contacts?limit=500");
        const d = await r.json();
        (d.contacts || []).forEach(c => {
          const opt = document.createElement("option");
          opt.value = c.id;
          opt.textContent = `${c.full_name || "Unnamed"} · ${c.company || ""}`;
          sel.appendChild(opt);
        });
      } catch (_) {}
    }
    sel.style.display = "";
  } else {
    sel.style.display = "none";
  }
});

// Needs-review badge in CRM title
async function refreshNeedsReviewBadge() {
  try {
    const r = await fetch("/api/emails/needs-review-count");
    const d = await r.json();
    const badge = document.getElementById("crm-review-badge");
    if (!badge) return;
    if (d.count > 0) {
      badge.style.display = "";
      badge.innerHTML = `<span class="needs-review-badge">${d.count} needs review</span>`;
    } else {
      badge.style.display = "none";
    }
  } catch (_) {}
}

refreshNeedsReviewBadge();

// ── Manual contact creation ──────────────────────────────────────────────────
const addContactModal = document.getElementById("add-contact-modal");
let _acSkipDupeCheck = false; // set true when user explicitly chooses "save anyway"

function acResetForm() {
  const ids = ["ac-first-name","ac-last-name","ac-title","ac-department","ac-email","ac-phone",
                "ac-linkedin","ac-tags","ac-contact-notes","ac-company","ac-industry",
                "ac-website","ac-country","ac-event","ac-booth","ac-company-notes"];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  const selects = ["ac-status","ac-followup","ac-priority"];
  selects.forEach(id => { const el = document.getElementById(id); if (el) el.selectedIndex = 0; });
  clearInlineError("ac-error");
  const dupe = document.getElementById("ac-duplicate-warning");
  if (dupe) dupe.style.display = "none";
  _acSkipDupeCheck = false;
}

function acGetPayload() {
  return {
    first_name: document.getElementById("ac-first-name").value.trim(),
    last_name: document.getElementById("ac-last-name").value.trim(),
    email: document.getElementById("ac-email").value.trim(),
    phone: document.getElementById("ac-phone").value.trim(),
    job_title: document.getElementById("ac-title").value.trim(),
    department: document.getElementById("ac-department").value.trim(),
    linkedin_url: document.getElementById("ac-linkedin").value.trim(),
    tags: document.getElementById("ac-tags").value.trim(),
    contact_notes: document.getElementById("ac-contact-notes").value.trim(),
    company: document.getElementById("ac-company").value.trim(),
    industry: document.getElementById("ac-industry").value.trim(),
    website: document.getElementById("ac-website").value.trim(),
    country: document.getElementById("ac-country").value.trim(),
    event_name: document.getElementById("ac-event").value.trim(),
    booth_number: document.getElementById("ac-booth").value.trim(),
    company_notes: document.getElementById("ac-company-notes").value.trim(),
    contact_status: document.getElementById("ac-status").value,
    follow_up_status: document.getElementById("ac-followup").value,
    priority: document.getElementById("ac-priority").value,
    source: "manual",
  };
}

async function acCheckDuplicate(payload) {
  if (_acSkipDupeCheck) return false;
  const params = new URLSearchParams();
  if (payload.email) params.set("email", payload.email);
  if (payload.first_name) params.set("first_name", payload.first_name);
  if (payload.last_name) params.set("last_name", payload.last_name);
  if (payload.company) params.set("company", payload.company);
  try {
    const r = await fetch(`/api/contacts/check-duplicate?${params}`);
    const d = await r.json();
    if (d.duplicate && d.contact) {
      const c = d.contact;
      document.getElementById("ac-duplicate-info").innerHTML =
        `<strong>${escapeHtml(c.full_name)}</strong>` +
        (c.job_title ? ` · ${escapeHtml(c.job_title)}` : "") +
        (c.company ? ` at ${escapeHtml(c.company)}` : "") +
        (c.email ? `<br>${escapeHtml(c.email)}` : "") +
        `<br><span style="color:#92400e;">Source: ${escapeHtml(c.source || "")}</span>`;
      document.getElementById("ac-duplicate-warning").style.display = "";
      document.getElementById("ac-view-existing-btn").dataset.contactId = c.id;
      return true;
    }
  } catch (_) {}
  document.getElementById("ac-duplicate-warning").style.display = "none";
  return false;
}

async function acSaveContact(closeAfter) {
  const payload = acGetPayload();
  const firstName = payload.first_name;
  const lastName = payload.last_name;

  if (!firstName && !lastName && !payload.email) {
    showInlineError("ac-error", "First name, last name, or email is required.");
    return false;
  }
  clearInlineError("ac-error");

  // Duplicate check (skipped if user already clicked "save anyway")
  const isDupe = await acCheckDuplicate(payload);
  if (isDupe) return false; // banner shown, user must decide

  const [btnSave, btnAnother] = [
    document.getElementById("add-contact-submit-btn"),
    document.getElementById("add-contact-save-another-btn"),
  ];
  btnSave.disabled = btnAnother.disabled = true;
  btnSave.textContent = "Saving…";

  try {
    const r = await fetch("/api/contacts/manual", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed to create contact");

    const name = d.full_name || [firstName, lastName].filter(Boolean).join(" ") || payload.email;
    showMessage(`Contact "${name}" added.`, "info");
    loadCrmContacts(document.getElementById("crm-search-input").value);

    if (closeAfter) {
      closeModal("add-contact-modal");
    } else {
      acResetForm();
      document.getElementById("ac-first-name").focus();
    }
    return true;
  } catch (err) {
    showInlineError("ac-error", err.message);
    return false;
  } finally {
    btnSave.disabled = btnAnother.disabled = false;
    btnSave.textContent = "Save Contact";
    btnAnother.textContent = "Save & Add Another";
  }
}

document.getElementById("crm-add-contact-btn").addEventListener("click", () => {
  acResetForm();
  openModal("add-contact-modal");
  document.getElementById("ac-first-name").focus();
});

document.getElementById("add-contact-close").addEventListener("click", () => {
  closeModal("add-contact-modal");
});
document.getElementById("add-contact-cancel-btn").addEventListener("click", () => {
  closeModal("add-contact-modal");
});
addContactModal.addEventListener("click", (e) => {
  if (e.target === addContactModal) closeModal("add-contact-modal");
});

document.getElementById("add-contact-submit-btn").addEventListener("click", () => acSaveContact(true));
document.getElementById("add-contact-save-another-btn").addEventListener("click", () => acSaveContact(false));

// Duplicate warning actions
document.getElementById("ac-save-anyway-btn").addEventListener("click", () => {
  _acSkipDupeCheck = true;
  document.getElementById("ac-duplicate-warning").style.display = "none";
  acSaveContact(true);
});
document.getElementById("ac-view-existing-btn").addEventListener("click", () => {
  const id = document.getElementById("ac-view-existing-btn").dataset.contactId;
  if (!id) return;
  const contact = _crmContacts.find(c => String(c.id) === String(id));
  if (contact) {
    closeModal("add-contact-modal");
    openContactDetailModal(contact);
  } else {
    // Contact might not be on the current page — navigate to CRM and search
    closeModal("add-contact-modal");
    showMessage("Opening CRM to find existing contact…", "info");
    loadCrmContacts(""); // reload without filter so the contact appears
  }
});

// Trigger duplicate check on email blur (fast feedback while typing)
document.getElementById("ac-email").addEventListener("blur", async () => {
  const email = document.getElementById("ac-email").value.trim();
  if (email && !_acSkipDupeCheck) {
    await acCheckDuplicate(acGetPayload());
  }
});

/* =======================================================================
   Customer Intelligence view — per-company tag review + AI research,
   plus the SKQ capability matrix. Self-contained; talks to /api/taxonomy,
   /api/companies/:id/intelligence|research|tags/*, and /api/skq/matrix.
   ======================================================================= */

let _intelTaxonomy = null;      // [{key,name_en,applies_to,tags:[{value,name_en}]}]
let _intelCompanyId = null;
let _intelActivePanelId = "intel-panel";
let _intelMatrix = null;        // {modules, systems, equipment}
const _aiInFlight = new Set();  // request dedup: prevents double-clicks / re-renders firing duplicate AI calls

/* ── Bilingual tag display. Language pref: 'bilingual' (default) | 'en' | 'zh'.
   The AI always receives the English `value`; these helpers are display only. ── */
function intelLang() { try { return localStorage.getItem("intel_lang") || "bilingual"; } catch { return "bilingual"; } }
function biLabel(en, cn) {
  en = (en || "").trim(); cn = (cn || "").trim();
  const lang = intelLang();
  if (lang === "en") return en || cn;
  if (lang === "zh") return cn || en;
  if (!en) return cn; if (!cn) return en;
  return `${en}（${cn}）`;
}
function catLabel(cat) { return biLabel(cat && cat.name_en, cat && cat.name_cn); }
function savedTagLabel(t) { return biLabel(t.value || t.tag_name_en, t.tag_name_cn); }   // row from listCompanyTags/listContactTags
function taxTagLabel(tg) { return biLabel(tg.value || tg.name_en, tg.name_cn); }          // row from the taxonomy
function skqLabel(m) { return biLabel(m.name_en, m.name_cn); }

// Re-render whatever intelligence surfaces are currently on screen after a
// language change.
function applyIntelLang() {
  const mf = document.getElementById("intel-matrix-filter");
  if (_intelMatrix) renderSkqMatrix(mf ? mf.value.trim().toLowerCase() : "");
  if (_crmIntelActiveId) loadCompanyIntel(_crmIntelActiveId, "crm-intel-panel");
  const topPanel = document.getElementById("intel-panel");
  if (topPanel && topPanel.dataset.companyId) loadCompanyIntel(Number(topPanel.dataset.companyId), "intel-panel");
  const emailModal = document.getElementById("email-modal");
  if (emailModal && emailModal.classList.contains("open") && _modalContact) loadModalIntel(_modalContact);
}

const INTEL_SOURCE_LABELS = {
  ai_suggested: "AI suggested",
  user_confirmed: "Confirmed",
  manual: "Manual",
  needs_review: "Needs review",
  rejected: "Rejected",
};

function initIntelligenceView() {
  const langSel = document.getElementById("intel-lang-select");
  if (langSel) {
    langSel.value = intelLang();
    langSel.addEventListener("change", () => {
      try { localStorage.setItem("intel_lang", langSel.value); } catch (e) { /* ignore */ }
      applyIntelLang();
    });
  }
  document.querySelectorAll(".intel-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const which = tab.dataset.intelTab;
      document.querySelectorAll(".intel-tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".intel-tabpane").forEach((p) => {
        p.style.display = p.dataset.intelPane === which ? "" : "none";
      });
      if (which === "matrix" && !_intelMatrix) loadSkqMatrix();
      if (which === "duplicates") loadDuplicateCompanies();
    });
  });

  const sel = document.getElementById("intel-company-select");
  sel.addEventListener("change", (e) => {
    const id = e.target.value;
    if (id) loadCompanyIntel(Number(id));
    else document.getElementById("intel-panel").innerHTML =
      '<div style="color:#9ca3af;font-size:0.85rem;">Select a company to view and review its customer intelligence.</div>';
  });
  document.getElementById("intel-refresh-companies").addEventListener("click", loadIntelCompanies);

  // Delegated handlers for the dynamically-rendered panel.
  const panel = document.getElementById("intel-panel");
  panel.addEventListener("click", onIntelPanelClick);
  panel.addEventListener("change", onIntelPanelChange);

  const mf = document.getElementById("intel-matrix-filter");
  if (mf) mf.addEventListener("input", () => renderSkqMatrix(mf.value.trim().toLowerCase()));

  // Lazy-load: only hit the API the first time the Intelligence view is opened
  // (avoids error toasts on every page load before the DB is configured).
  const navItem = document.querySelector('.app-nav-item[data-nav-view="intelligence"]');
  if (navItem) navItem.addEventListener("click", intelEnsureLoaded);
  let activeView = "search";
  try { activeView = localStorage.getItem("app_active_view") || "home"; } catch (e) { /* ignore */ }
  if (activeView === "intelligence") intelEnsureLoaded();
}

let _intelLoaded = false;
function intelEnsureLoaded() {
  if (_intelLoaded) return;
  _intelLoaded = true;
  loadIntelTaxonomy();
  loadIntelCompanies();
}

async function loadIntelTaxonomy() {
  if (_intelTaxonomy) return _intelTaxonomy;
  try {
    const r = await fetch("/api/taxonomy");
    const d = await r.json();
    if (d.ok) _intelTaxonomy = d.taxonomy;
  } catch (e) { /* ignore — panel still renders present tags */ }
  return _intelTaxonomy || [];
}

async function loadIntelCompanies() {
  try {
    const r = await fetch("/api/companies");
    const d = await r.json();
    const companies = d.companies || [];
    const sel = document.getElementById("intel-company-select");
    const cur = sel.value;
    sel.innerHTML =
      '<option value="">Select a company…</option>' +
      companies.map((c) =>
        `<option value="${c.id}">${escapeHtml(c.name)}${c.chinese_name ? " / " + escapeHtml(c.chinese_name) : ""}</option>`
      ).join("");
    if (cur) sel.value = cur;
  } catch (e) {
    showMessage("Failed to load companies: " + e.message, "error");
  }
}

async function loadCompanyIntel(companyId, panelId = "intel-panel") {
  _intelCompanyId = companyId;
  _intelActivePanelId = panelId;
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.dataset.companyId = String(companyId);
  panel.innerHTML = '<div style="color:#9ca3af;font-size:0.85rem;">Loading saved intelligence…</div>';
  try {
    await loadIntelTaxonomy();
    // DB-first: this only reads saved data — it never triggers the AI.
    const r = await fetch(`/api/companies/${companyId}/intelligence`);
    const d = await r.json();
    if (!d.ok) { panel.innerHTML = `<div class="msg-error">${escapeHtml(d.error || "Failed to load")}</div>`; return; }
    renderCompanyIntel(d, panelId);
  } catch (e) {
    panel.innerHTML = `<div class="msg-error">Network error: ${escapeHtml(e.message)}</div>`;
  }
}

function intelConfidencePct(conf) {
  if (conf == null) return "";
  return `<span class="ic-conf">${Math.round(conf * 100)}%</span>`;
}

function intelFmtDate(x) { return x ? new Date(x).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : ""; }

/* ── Account lifecycle: what exists, what's missing, what's next ─────────
   Company Intelligence was a tag editor that happened to sit next to a
   contact list. As the hub for an account it has to answer, in order:
   is this analyzed, are its tags trustworthy, and can I actually talk to
   anyone here? Exactly one step is recommended at a time — a page that
   flags five things equally recommends nothing. */
function intelNextStep(st, contacts) {
  const n = (contacts && contacts.count) || 0;
  if (!st.analyzed) {
    return { key: "analyze", title: "Run AI analysis",
      why: "Nothing is known about this account yet. Analysis writes a business description and suggests tags that shape every email drafted for it.",
      action: `<button class="btn-orange btn-sm" data-intel-action="research" data-mode="full">Generate AI analysis</button>` };
  }
  if (n === 0) {
    return { key: "contacts", title: "Add contacts",
      why: "This account is analyzed but has nobody to contact. Pull decision-makers from Apollo to start working it.",
      action: `<button class="btn-primary btn-sm" data-intel-action="focus-contacts">Add contacts</button>` };
  }
  if (st.tag_count > 0 && !st.confirmed_count) {
    return { key: "review", title: "Review the suggested tags",
      why: `${st.tag_count} AI tag(s) are being used unconfirmed. Confirming or rejecting them sharpens the drafting prompt.`,
      action: `<button class="btn-ghost btn-sm" data-intel-action="focus-tags">Review tags</button>` };
  }
  if (st.stale) {
    return { key: "refresh", title: "Refresh the analysis",
      why: `The last analysis is older than ${st.review_period_days} days.`,
      action: `<button class="btn-orange btn-sm" data-intel-action="research" data-mode="full">Refresh AI analysis</button>` };
  }
  return { key: "ready", title: "Ready to work",
    why: `Analyzed, tags reviewed, and ${n} contact(s) on file. Open it in the CRM to draft outreach.`,
    action: `<button class="btn-ghost btn-sm" data-intel-action="open-crm">Open in CRM</button>` };
}

function intelContactsSection(c, contacts, st) {
  // Account-level, matching what the import planner and the CRM's company
  // filter both count — see getCompanyContactStats().
  const n = (contacts && contacts.count) || 0;
  const withEmail = (contacts && contacts.with_email) || 0;
  const ownN = contacts && contacts.own_count != null ? contacts.own_count : n;
  const lastAdded = contacts && contacts.last_added_at ? intelFmtDate(contacts.last_added_at) : null;

  // Default ask: enough to be useful without being a blank cheque.
  const suggested = n > 0 ? Math.min(500, n + 25) : 25;

  const body = n === 0
    ? `<div class="ic-empty">
         <div class="ic-empty-title">No contacts yet</div>
         <div class="ic-empty-hint">Nobody at this company is in your CRM. Pull them from Apollo using the default executive + specialist departments, or pick your own.<br>该公司目前没有联系人。可使用默认的高管 + 专业岗位部门从 Apollo 获取，也可自行选择部门。</div>
       </div>`
    : `<div class="ic-stats">
         <span class="ic-stat"><b>${n}</b> contact${n !== 1 ? "s" : ""} 位联系人</span>
         <span class="ic-stat"><b>${withEmail}</b> with email 含邮箱</span>
         ${lastAdded ? `<span class="ic-stat">last added <b>${escapeHtml(lastAdded)}</b></span>` : ""}
         ${ownN !== n ? `<span class="ic-stat ic-stat-soft">${ownN} on this company record, the rest on related entities</span>` : ""}
       </div>`;

  return `
    <div class="intel-section" data-intel-contacts>
      <h3>Contacts <span style="font-weight:400;font-size:0.75rem;color:#9ca3af;">— from the Contact Engine</span></h3>
      ${body}
      <div class="ic-import">
        <label class="ic-import-label" for="ic-target-${c.id}">Target contacts for this company</label>
        <div class="ic-import-row">
          <input type="number" class="ic-target" id="ic-target-${c.id}" value="${suggested}" min="1" max="500">
          <button class="btn-primary btn-sm" data-intel-action="import-contacts">Preview import</button>
          ${n ? `<button class="btn-ghost btn-sm" data-intel-action="open-crm">View in CRM</button>` : ""}
        </div>
        <div class="ic-plan" data-intel-plan></div>
      </div>
    </div>`;
}

function renderCompanyIntel(intel, panelId = "intel-panel") {
  const c = intel.company || {};
  const tags = intel.tags || [];
  const sources = intel.sources || [];
  const st = intel.status || {};
  const contactStats = intel.contacts || { count: 0 };
  const companyCats = (_intelTaxonomy || []).filter((cat) => cat.applies_to === "company");

  // group present tags by category_key
  const byCat = {};
  tags.forEach((t) => { (byCat[t.category_key] = byCat[t.category_key] || []).push(t); });
  const missingCats = companyCats.filter((cat) => !(byCat[cat.key] || []).length);

  // ── Status line (DB-first: shows what's saved and how fresh it is) ──
  let statusBadge, statusStyle;
  if (!st.analyzed) { statusBadge = "Not analyzed"; statusStyle = "background:#f3f4f6;color:#6b7280;"; }
  else if (st.stale) { statusBadge = "Analysis stale"; statusStyle = "background:#fff7ed;color:#0C579A;"; }
  else if (st.confirmed_count > 0) { statusBadge = "Saved · reviewed"; statusStyle = "background:#ecfdf5;color:#047857;"; }
  else { statusBadge = "Saved · needs review"; statusStyle = "background:#fffbeb;color:#b45309;"; }

  const analyzedLine = !st.analyzed
    ? "Never analyzed by AI"
    : st.analyzed_at
      ? `Last analyzed ${intelFmtDate(st.analyzed_at)}${st.stale ? ` (older than ${st.review_period_days} days)` : ""}`
      : "Previously analyzed (run Refresh to record the date)";
  const reviewedLine = st.reviewed_at ? ` · Last reviewed ${intelFmtDate(st.reviewed_at)}` : "";

  // Primary AI button: generate if never analyzed; otherwise a deliberate full refresh.
  const primaryBtn = !st.analyzed
    ? `<button class="btn-orange btn-sm" data-intel-action="research" data-mode="full">🔎 Generate AI Analysis</button>`
    : `<button class="btn-orange btn-sm" data-intel-action="research" data-mode="full">🔄 Refresh AI Analysis</button>`;
  const fillMissingBtn = (st.analyzed && missingCats.length)
    ? `<button class="btn-ghost btn-sm" data-intel-action="research" data-mode="missing">✨ Fill ${missingCats.length} missing categor${missingCats.length === 1 ? "y" : "ies"}</button>`
    : "";

  let html = `
    <div class="intel-section">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
        <div>
          <h3 style="margin-bottom:4px;">${escapeHtml(c.name || "")}${c.chinese_name ? ' <span style="font-weight:400;color:#6b7280;">' + escapeHtml(c.chinese_name) + "</span>" : ""}</h3>
          <div style="font-size:0.78rem;color:#6b7280;">
            ${c.industry ? escapeHtml(c.industry) + " · " : ""}
            ${c.website ? `<a href="${escapeAttr(c.website)}" target="_blank" rel="noopener">${escapeHtml(c.website)}</a> · ` : ""}
            ${st.tag_count || 0} tags · ${st.confirmed_count || 0} confirmed
          </div>
          <div style="font-size:0.74rem;color:#9ca3af;margin-top:3px;">${escapeHtml(analyzedLine)}${escapeHtml(reviewedLine)}</div>
        </div>
        <span style="font-size:0.72rem;font-weight:600;padding:3px 9px;border-radius:12px;white-space:nowrap;${statusStyle}">${statusBadge}</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
        ${primaryBtn}${fillMissingBtn}
        <button class="btn-ghost btn-sm" data-intel-action="reviewed">✓ Mark Reviewed</button>
      </div>
      ${c.ai_research_summary
        ? `<div style="margin-top:12px;"><div class="intel-cat-title">Business description (AI research)</div><div style="font-size:0.83rem;color:#374151;background:#f9fafb;border:1px solid #eef2f7;border-radius:6px;padding:10px 12px;">${escapeHtml(c.ai_research_summary)}</div></div>`
        : ""}
      <div class="intel-research-note" style="margin-top:8px;font-size:0.78rem;color:#9ca3af;"></div>
    </div>`;

  /* ── Provenance ────────────────────────────────────────────────────
     How this company entered the CRM, and the audit trail of that record.
     Placed above the workflow sections because it is the first thing asked
     when a list is questioned ("where did these come from?"), and because
     an unlabelled origin is worth noticing before acting on the record. */
  const provKey = c.source || "legacy";
  const provLabel = COMPANY_SOURCE_LABELS[provKey] || provKey;
  const untraced = provKey === "legacy" || provKey === "crm_side_effect";
  html += `
    <div class="intel-section" data-no-i18n>
      <h3>Provenance 溯源</h3>
      <div class="cd-prov">
        <div><span class="cd-prov-k">Company source 公司来源:</span> ${escapeHtml(provLabel)}
          ${c.source_file ? `<span class="cd-prov-k">(${escapeHtml(c.source_file)})</span>` : ""}</div>
        <div><span class="cd-prov-k">Contacts here 联系人来源:</span>
          ${contactStats.count
            ? `${contactStats.count} contact${contactStats.count === 1 ? "" : "s"} · see each record for its own contact and email source
               ${contactStats.count} 位联系人 · 各自来源见联系人详情`
            : `No contacts yet 暂无联系人`}</div>
        ${untraced
          ? `<div style="color:#b45309;">This company predates provenance tracking, so its origin was never recorded.
               本公司创建于溯源功能之前，来源未记录。</div>`
          : ""}
      </div>
      <div id="intel-audit-${c.id}" class="cd-prov" style="margin-top:8px;">
        <span class="cd-prov-k">Loading audit trail… 加载审计记录…</span>
      </div>
    </div>`;

  // ── Recommended next step, then contact coverage ──
  const next = intelNextStep(st, contactStats);
  html += `
    <div class="intel-next intel-next-${next.key}">
      <div class="intel-next-body">
        <div class="intel-next-label">Next step</div>
        <div class="intel-next-title">${escapeHtml(next.title)}</div>
        <div class="intel-next-why">${escapeHtml(next.why)}</div>
      </div>
      <div class="intel-next-action">${next.action}</div>
    </div>`;
  html += intelContactsSection(c, contactStats, st);

  // ── Tags by category ──
  html += `
    <div class="intel-section">
      <h3>Tags <span style="font-weight:400;font-size:0.75rem;color:#9ca3af;">— AI tags are used by default; confirm/reject to refine</span></h3>
      <div class="intel-legend" style="margin-bottom:12px;">
        <span><span class="dot" style="background:#fffbeb;border-color:#fcd34d;"></span>AI suggested</span>
        <span><span class="dot" style="background:#ecfdf5;border-color:#6ee7b7;"></span>Confirmed</span>
        <span><span class="dot" style="background:#EDE9F7;border-color:#93c5fd;"></span>Manual</span>
        <span><span class="dot" style="background:#fff7ed;border-color:#fdba74;"></span>Needs review</span>
        <span><span class="dot" style="background:#f3f4f6;border-color:#d1d5db;"></span>Rejected</span>
      </div>`;

  companyCats.forEach((cat) => {
    const present = byCat[cat.key] || [];
    const presentValues = new Set(present.map((t) => t.value));
    const chips = present.map((t) => {
      const src = t.source || "ai_suggested";
      return `<span class="intel-chip src-${src}" title="${escapeAttr(INTEL_SOURCE_LABELS[src] || src)}${t.confidence != null ? " · confidence " + Math.round(t.confidence * 100) + "%" : ""}${t.confirmed_by ? " · by " + t.confirmed_by : ""}">
        ${escapeHtml(savedTagLabel(t))} ${intelConfidencePct(t.confidence)}
        <button data-intel-action="confirm" data-tag-id="${t.tag_id}" title="Confirm">✓</button>
        <button data-intel-action="reject" data-tag-id="${t.tag_id}" title="Reject">✕</button>
        <button data-intel-action="remove" data-tag-id="${t.tag_id}" title="Remove">🗑</button>
      </span>`;
    }).join("");

    const addable = (cat.tags || []).filter((tg) => !presentValues.has(tg.value));
    const addSelect = addable.length
      ? `<select class="intel-add" data-intel-add="${escapeAttr(cat.key)}">
           <option value="">+ add…</option>
           ${addable.map((tg) => `<option value="${escapeAttr(tg.value)}">${escapeHtml(taxTagLabel(tg))}</option>`).join("")}
         </select>`
      : "";

    html += `
      <div class="intel-cat">
        <div class="intel-cat-title">${escapeHtml(catLabel(cat))}</div>
        <div>${chips || '<span style="font-size:0.76rem;color:#cbd5e1;">none yet</span>'} ${addSelect}</div>
      </div>`;
  });
  html += `</div>`;

  // ── Recommended SKQ solutions / equipment / attachments (Phase 2) ──
  html += `
    <div class="intel-section">
      <h3>Recommended SKQ Solutions & Equipment</h3>
      <div style="font-size:0.8rem;color:#9ca3af;">Product/equipment matching is coming in Phase 2. Once tags here are confirmed, this will list matched SKQ modules, equipment, and recommended attachments — with the reason and confidence for each match — and those will feed contact targeting and email drafting.</div>
    </div>`;

  // ── Research sources ──
  html += `
    <div class="intel-section">
      <h3>Research Sources</h3>
      ${sources.length
        ? '<ul style="margin:0;padding-left:18px;font-size:0.8rem;">' +
            sources.map((s) => `<li><a href="${escapeAttr(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a></li>`).join("") +
          "</ul>"
        : '<div style="font-size:0.8rem;color:#9ca3af;">No sources yet — run AI analysis to populate.</div>'}
    </div>`;

  const panel = document.getElementById(panelId);
  // The name is needed by the contact-import actions, which address the
  // Contact Engine by company name rather than id.
  if (panel) {
    panel.dataset.companyId = String(c.id || "");
    panel.dataset.companyName = c.name || "";
    panel.innerHTML = html;
    // Loaded after paint: the audit trail is useful but never worth delaying
    // the record page for.
    loadCompanyAudit(c.id);
  }
}

/* The company audit trail: creation with its recorded source, plus any
   later correction. Read-only — an audit log you can edit is not one. */
async function loadCompanyAudit(companyId) {
  const el = document.getElementById(`intel-audit-${companyId}`);
  if (!el) return;
  try {
    const d = await getJSON(`/api/companies/${companyId}/activity`);
    const items = d.activity || [];
    if (!items.length) {
      el.innerHTML = `<span class="cd-prov-k">No audit entries — this company predates the audit trail.
        无审计记录 — 该公司创建于审计功能之前。</span>`;
      return;
    }
    el.innerHTML = `<div class="cd-prov-k" style="margin-bottom:2px;">Audit trail 审计记录</div>`
      + items.map((a) => `<div>· ${escapeHtml(a.description || a.activity_type)}
          <span class="cd-prov-k">${escapeHtml(intelFmtDate(a.created_at))}</span></div>`).join("");
  } catch (e) {
    el.innerHTML = `<span class="cd-prov-k">Audit trail unavailable 审计记录不可用</span>`;
  }
}

async function onIntelPanelClick(e) {
  const btn = e.target.closest("[data-intel-action]");
  if (!btn) return;
  const panel = e.currentTarget;                 // the panel this handler is bound to
  const panelId = panel.id;
  const companyId = Number(panel.dataset.companyId);
  if (!companyId) return;
  const action = btn.dataset.intelAction;
  const confirmedBy = (_sender && _sender.name) || undefined;
  const note = () => panel.querySelector(".intel-research-note");

  try {
    /* ── Contact Engine, run from the account hub ─────────────────────────
       Two deliberate steps: the first click only asks the planner what the
       import would do, and only the second spends anything. Pulling
       contacts costs Apollo credits, so it never happens on a single click
       from a screen the user opened to read tags. */
    if (action === "focus-contacts" || action === "focus-tags") {
      const sel = action === "focus-contacts" ? "[data-intel-contacts]" : ".intel-section:nth-of-type(2)";
      panel.querySelector(sel)?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (action === "focus-contacts") panel.querySelector(".ic-target")?.focus();
      return;
    }

    /* "View in CRM" — cross from analysing an account to working it.

       This dates from when Company Intelligence was a slide-over drawer:
       it closed the drawer (now a no-op) and re-showed the CRM view it was
       already inside, but never switched the object tab — so the user stayed
       on the Companies tab looking at the same record.

       It also scoped by free-text search. The account filter is the right
       instrument: it matches exactly, drives the filter chip and the
       active-company bar, and survives paging. The search box is cleared so
       a stale term can't imply a scope that isn't being applied — with a
       structured filter present the server ignores `q` entirely, so leaving
       text there would misreport what the list is showing. */
    if (action === "open-crm") {
      const name = panel.dataset.companyName || "";
      if (!name) return;
      const box = document.getElementById("crm-search-input");
      if (box) box.value = "";
      showCrmTab("contacts");
      setCrmAccounts([name]);     // filter chip + active-company bar + reload
      return;
    }

    if (action === "import-contacts" || action === "import-contacts-confirm") {
      const name = panel.dataset.companyName || "";
      const targetEl = panel.querySelector(".ic-target");
      const planBox = panel.querySelector("[data-intel-plan]");
      const target = Math.max(1, Math.min(Number(targetEl && targetEl.value) || 25, 500));
      if (!name) return;

      if (action === "import-contacts") {
        planBox.innerHTML = `<div class="ic-plan-line">Checking…</div>`;
        const d = await getJSON(`/api/leads/plan?companies=${encodeURIComponent(name)}&target=${target}&maxTotal=${target}&mode=append`);
        const p = (d.plans || [])[0];
        if (!p) { planBox.innerHTML = ""; return; }
        planBox.innerHTML = p.willRetrieve > 0
          ? `<div class="ic-plan-line"><b>${p.current}</b> now → <b>${p.target}</b> target = <b class="ic-plan-get">+${p.willRetrieve}</b> to retrieve.
               Costs about ${p.searchRequests} Apollo search request(s), plus up to ${p.emailLookups} email lookup(s).
               Existing contacts are kept as they are.</div>
             <div class="ic-plan-row">
               <button class="btn-orange btn-sm" data-intel-action="import-contacts-confirm">Import ${p.willRetrieve} contact${p.willRetrieve !== 1 ? "s" : ""} 导入 ${p.willRetrieve} 位联系人</button>
               <button class="btn-ghost btn-sm" data-intel-action="import-cancel">Cancel</button>
             </div>`
          : `<div class="ic-plan-line">Already at ${p.current} — raise the target above ${p.current} to pull more.</div>`;
        return;
      }

      // Confirmed: run the real import, then re-render from the server so
      // the counts and the recommended next step reflect what just landed.
      btn.disabled = true; btn.textContent = "Importing…";
      const r = await fetch("/api/leads/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companies: name, force: false, perCompanyLimit: target, maxTotal: target, departments: [] }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { showMessage(d.error || "Import failed.", "error"); btn.disabled = false; btn.textContent = "Retry"; return; }
      const s = (d.summaries || [])[0];
      showMessage(s
        ? `${name}: imported ${s.importedCount} new contact(s); ${s.alreadyHeldCount || 0} already in your CRM were left untouched.`
        : `${name}: import finished.`, "info");
      refreshUsage();
      loadBrowseSelectors();
      await loadCompanyIntel(companyId, panelId);
      return;
    }

    if (action === "import-cancel") {
      panel.querySelector("[data-intel-plan]").innerHTML = "";
      return;
    }

    if (action === "research") {
      const mode = btn.dataset.mode === "full" ? "full" : "missing";
      const key = `research:${companyId}:${mode}`;
      if (_aiInFlight.has(key)) return;          // dedup: ignore repeat clicks
      _aiInFlight.add(key);
      const original = btn.textContent;
      btn.disabled = true; btn.textContent = "Researching…";
      const n = note();
      if (n) n.textContent = "Researching with Claude web search — this can take 1–2 minutes. It keeps running server-side even if you navigate away; reopen the company to see results.";
      try {
        const r = await fetch(`/api/companies/${companyId}/research`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        const d = await r.json();
        if (!d.ok) { showMessage("Research: " + (d.error || d.details || "failed"), "error"); btn.disabled = false; btn.textContent = original; return; }
        renderCompanyIntel(d, panelId);
        const res = d.research || {};
        const n2 = note();
        if (n2) {
          if (res.skipped) n2.textContent = `Loaded from database — AI call avoided (0 tokens). Estimated saved: ${fmtTokens(res.saved_input)} in / ${fmtTokens(res.saved_output)} out. Use “Refresh AI Analysis” to re-run.`;
          else {
            const missing = (res.missing_info || []).length ? " Notes: " + res.missing_info.join("; ") : "";
            const scope = res.mode === "missing" ? " (missing categories only)" : "";
            n2.textContent = `New AI call — suggested ${res.suggested || 0} tag(s)${scope}, applied ${res.applied || 0}; ${res.skipped || 0} left untouched (protected/confirmed). Tokens: ${fmtTokens(res.input_tokens)} in / ${fmtTokens(res.output_tokens)} out.${missing}`;
          }
        }
        refreshUsage();
      } finally { _aiInFlight.delete(key); }
      return;
    }
    if (action === "reviewed") {
      await fetch(`/api/companies/${companyId}/reviewed`, { method: "POST" });
      showMessage("Marked as reviewed.", "info");
      loadCompanyIntel(companyId, panelId);
      return;
    }
    const tagId = btn.dataset.tagId;
    if (action === "remove") {
      await fetch(`/api/companies/${companyId}/tags/${tagId}`, { method: "DELETE" });
      loadCompanyIntel(companyId, panelId);
      return;
    }
    if (action === "confirm" || action === "reject") {
      const source = action === "confirm" ? "user_confirmed" : "rejected";
      await fetch(`/api/companies/${companyId}/tags/status`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagId: Number(tagId), source, confirmedBy }),
      });
      loadCompanyIntel(companyId, panelId);
      return;
    }
  } catch (err) {
    showMessage("Action failed: " + err.message, "error");
  }
}

async function onIntelPanelChange(e) {
  const sel = e.target.closest("[data-intel-add]");
  if (!sel || !sel.value) return;
  const panel = e.currentTarget;
  const panelId = panel.id;
  const companyId = Number(panel.dataset.companyId);
  if (!companyId) return;
  const categoryKey = sel.dataset.intelAdd;
  const value = sel.value;
  const confirmedBy = (_sender && _sender.name) || undefined;
  try {
    const r = await fetch(`/api/companies/${companyId}/tags/manual`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ categoryKey, value, confirmedBy }),
    });
    const d = await r.json();
    if (!d.ok) { showMessage(d.error || "Failed to add tag", "error"); return; }
    loadCompanyIntel(companyId, panelId);
  } catch (err) {
    showMessage("Add tag failed: " + err.message, "error");
  }
}

/* ── SKQ capability matrix ── */

async function loadSkqMatrix() {
  const box = document.getElementById("intel-matrix");
  box.innerHTML = '<div style="color:#9ca3af;font-size:0.85rem;">Loading matrix…</div>';
  try {
    const r = await fetch("/api/skq/matrix");
    const d = await r.json();
    if (!d.ok) { box.innerHTML = `<div class="msg-error">${escapeHtml(d.error || "Failed to load matrix")}</div>`; return; }
    _intelMatrix = d;
    const summary = document.getElementById("intel-matrix-summary");
    if (summary) summary.textContent = `${d.modules.length} modules · ${d.systems.length} systems · ${d.equipment.length} equipment`;
    renderSkqMatrix("");
  } catch (e) {
    box.innerHTML = `<div class="msg-error">Network error: ${escapeHtml(e.message)}</div>`;
  }
}

// deterministic pastel hue per module for quick visual grouping
function intelModuleHue(no) { return `hsl(${(Number(no) * 47) % 360}, 55%, 82%)`; }

function renderSkqMatrix(filter) {
  if (!_intelMatrix) return;
  const box = document.getElementById("intel-matrix");
  const term = (filter || "").toLowerCase();
  const modulesById = {};
  _intelMatrix.modules.forEach((m) => { modulesById[m.module_no] = m; });

  const match = (e) => {
    if (!term) return true;
    return [e.name_en, e.name_cn, e.module_name_en, e.module_name_cn, e.system_name_en, e.department]
      .filter(Boolean).some((s) => String(s).toLowerCase().includes(term));
  };
  const equipment = _intelMatrix.equipment.filter(match);

  // group by module_no
  const groups = {};
  equipment.forEach((e) => { (groups[e.module_no] = groups[e.module_no] || []).push(e); });
  const moduleNos = Object.keys(groups).map(Number).sort((a, b) => a - b);

  if (!moduleNos.length) { box.innerHTML = '<div style="color:#9ca3af;font-size:0.85rem;">No equipment matches that filter.</div>'; return; }

  let html = '<table class="intel-matrix-table"><thead><tr><th style="width:48px;">#</th><th>Equipment</th><th>System</th><th>Dept</th></tr></thead><tbody>';
  moduleNos.forEach((no) => {
    const m = modulesById[no] || {};
    html += `<tr class="intel-mod-head"><td colspan="4">
      <span class="intel-swatch" style="background:${intelModuleHue(no)};"></span>
      ${no}. ${escapeHtml(skqLabel(m))}
      ${m.color_name ? ` <span style="font-weight:400;color:#9ca3af;font-size:0.72rem;">(${escapeHtml(m.color_name)}${m.color_ral ? " " + escapeHtml(m.color_ral) : ""})</span>` : ""}
    </td></tr>`;
    groups[no].forEach((e) => {
      html += `<tr>
        <td style="color:#9ca3af;">${e.seq_no}</td>
        <td>${escapeHtml(e.name_en || "")}${e.name_cn ? ` <span style="color:#9ca3af;">/ ${escapeHtml(e.name_cn)}</span>` : ""}</td>
        <td style="color:#6b7280;">${e.system_no ? escapeHtml(e.system_name_en || "") : '<span style="color:#cbd5e1;">—</span>'}</td>
        <td style="color:#6b7280;">${escapeHtml(e.department || "")}</td>
      </tr>`;
    });
  });
  html += "</tbody></table>";
  box.innerHTML = html;
}

/* =======================================================================
   Inline CRM "Company Intelligence" — per-company sub-tabs, shown below the
   Search Companies area and above the contact filters. Reuses the same
   renderCompanyIntel/onIntelPanel* logic, targeting the #crm-intel-panel.
   DB-first: selecting/searching a company only LOADS saved intelligence;
   the AI runs only when the user clicks Generate/Refresh/Fill.
   ======================================================================= */

let _crmIntelCompanies = []; // [{id, name}] — the open sub-tabs
let _crmIntelActiveId = null;

function initCrmIntel() {
  const panel = document.getElementById("crm-intel-panel");
  if (panel) {
    panel.addEventListener("click", onIntelPanelClick);   // same handlers; keyed off panel.dataset.companyId
    panel.addEventListener("change", onIntelPanelChange);
  }
  const subtabs = document.getElementById("crm-intel-subtabs");
  if (subtabs) subtabs.addEventListener("click", onCrmIntelSubtabClick);
}

/* ── New company dialog ──────────────────────────────────────────────────
   Creating an account is a deliberate act with its own form, not a row
   tucked into a dropdown: the extra optional fields (Chinese name,
   industry, website) are what make the AI research that follows useful.
   Reuses POST /api/companies, so a hand-typed company is normalised and
   account-resolved exactly like an imported one. */

function openNewCompanyModal(prefillName) {
  const m = document.getElementById("crm-newco-modal");
  if (!m) return;
  ["newco-name", "newco-zh", "newco-industry", "newco-website"].forEach((id) => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  const nameEl = document.getElementById("newco-name");
  if (nameEl && prefillName) nameEl.value = prefillName;
  const err = document.getElementById("newco-error");
  if (err) { err.style.display = "none"; err.textContent = ""; }
  m.classList.add("open");
  snapshotDialog("crm-newco-modal");
  setTimeout(() => nameEl?.focus(), 60);
}

function closeNewCompanyModal() {
  document.getElementById("crm-newco-modal")?.classList.remove("open");
}

async function submitNewCompany() {
  const btn = document.getElementById("newco-create");
  const err = document.getElementById("newco-error");
  const name = (document.getElementById("newco-name")?.value || "").trim();
  const show = (msg) => { if (err) { err.textContent = msg; err.style.display = ""; } };

  if (!name) { show("Enter a company name."); return; }
  btn.disabled = true; btn.textContent = "Creating…";
  try {
    const r = await fetch("/api/companies", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        chinese_name: (document.getElementById("newco-zh")?.value || "").trim(),
        industry: (document.getElementById("newco-industry")?.value || "").trim(),
        website: (document.getElementById("newco-website")?.value || "").trim(),
      }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) { show(d.error || "Could not create the company."); return; }

    closeNewCompanyModal();
    showMessage(d.created
      ? `Created “${d.company.name}” — it's now a CRM account.`
      : `“${d.company.name}” already existed; opening it.`, "info");
    // Make the new account browsable everywhere, not just here.
    await loadCrmAccounts();
    loadBrowseSelectors();
    if (typeof refreshCrmCompanies === "function") refreshCrmCompanies();
    openCrmAccount(d.company.id, d.company.name);
  } catch (e) {
    show("Network error: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Create and open";
  }
}

function renderCrmIntelSubtabs() {
  const bar = document.getElementById("crm-intel-subtabs");
  const hint = document.getElementById("crm-intel-hint");
  if (!bar) return;
  if (!_crmIntelCompanies.length) { bar.innerHTML = ""; if (hint) hint.style.display = ""; return; }
  if (hint) hint.style.display = "none";
  bar.innerHTML = _crmIntelCompanies.map((co) =>
    `<span class="intel-subtab ${co.id === _crmIntelActiveId ? "active" : ""}" data-co-id="${co.id}">
       ${escapeHtml(co.name)}<span class="st-close" data-co-close="${co.id}" title="Remove tab">×</span>
     </span>`).join("");
}

function addCrmIntelCompany(id, name) {
  if (!_crmIntelCompanies.some((c) => c.id === id)) _crmIntelCompanies.push({ id, name: name || ("Company #" + id) });
  selectCrmIntelCompany(id);
}

function selectCrmIntelCompany(id) {
  _crmIntelActiveId = id;
  renderCrmIntelSubtabs();
  loadCompanyIntel(id, "crm-intel-panel");
}

function onCrmIntelSubtabClick(e) {
  const close = e.target.closest("[data-co-close]");
  if (close) {
    e.stopPropagation();
    const id = Number(close.dataset.coClose);
    _crmIntelCompanies = _crmIntelCompanies.filter((c) => c.id !== id);
    if (_crmIntelActiveId === id) {
      _crmIntelActiveId = _crmIntelCompanies.length ? _crmIntelCompanies[0].id : null;
      const panel = document.getElementById("crm-intel-panel");
      if (_crmIntelActiveId) loadCompanyIntel(_crmIntelActiveId, "crm-intel-panel");
      else if (panel) { panel.dataset.companyId = ""; panel.innerHTML = '<div style="color:#9ca3af;font-size:0.85rem;">No company selected.</div>'; }
    }
    renderCrmIntelSubtabs();
    return;
  }
  const tab = e.target.closest("[data-co-id]");
  if (tab) selectCrmIntelCompany(Number(tab.dataset.coId));
}

// After a company search completes, resolve each searched name to a saved
// company id and open a sub-tab for it (loading saved intelligence, not AI).
async function crmIntelFromSearch(companyNames) {
  if (!companyNames || !companyNames.length) return;
  try {
    for (const name of companyNames) {
      const r = await fetch("/api/companies?q=" + encodeURIComponent(name));
      const d = await r.json();
      const list = d.companies || [];
      const exact = list.find((c) => (c.name || "").toLowerCase() === name.toLowerCase());
      const co = exact || list[0];
      if (co && !_crmIntelCompanies.some((c) => c.id === co.id)) _crmIntelCompanies.push({ id: co.id, name: co.name });
    }
    if (_crmIntelCompanies.length) {
      if (!_crmIntelActiveId || !_crmIntelCompanies.some((c) => c.id === _crmIntelActiveId)) _crmIntelActiveId = _crmIntelCompanies[0].id;
      renderCrmIntelSubtabs();
      selectCrmIntelCompany(_crmIntelActiveId);
    }
    // Newly searched companies change the list view's counts.
    loadCrmAccounts();
  } catch (e) { /* ignore */ }
}

/* =======================================================================
   Draft Email modal ↔ Company Intelligence bridge. Loads the selected
   contact's SAVED company tags (DB-first, no AI) and shows them in the
   modal; the same confirmed tags are folded into the generation prompt
   server-side. "View / Edit Tags" jumps to the inline CRM intel tab.
   ======================================================================= */

let _modalIntelCompany = null; // {id, name} for the View/Edit button

async function loadModalIntel(contact) {
  const wrap = document.getElementById("modal-intel");
  const body = document.getElementById("modal-intel-body");
  const badge = document.getElementById("modal-intel-badge");
  _modalIntelCompany = null;
  if (!wrap || !body) return;
  if (badge) badge.textContent = "";

  if (!contact || !contact.contact_id) { wrap.style.display = "none"; return; }  // ephemeral contact
  wrap.style.display = "";
  body.innerHTML = '<div style="font-size:0.8rem;color:#9ca3af;">Loading saved company intelligence…</div>';
  try {
    await loadIntelTaxonomy();
    const r = await fetch(`/api/contacts/${contact.contact_id}/intelligence`);
    const d = await r.json();
    if (!d.ok) { wrap.style.display = "none"; return; }
    _modalIntelCompany = d.company ? { id: d.company.id, name: d.company.name } : null;
    renderModalIntel(d, contact);
  } catch (e) {
    body.innerHTML = `<div class="msg-error" style="font-size:0.8rem;">${escapeHtml(e.message)}</div>`;
  }
}

// Mirror of db.tagTier — AI tags are usable by default, confidence-tiered.
function clientTagTier(source, confidence) {
  if (source === "user_confirmed") return { tier: "confirmed", label: "Confirmed", used: true };
  if (source === "manual") return { tier: "manual", label: "Manual", used: true };
  if (source === "rejected") return { tier: "rejected", label: "Rejected", used: false };
  if (source === "needs_review") return { tier: "needs_review", label: "Needs review", used: false };
  const c = confidence == null ? 0.8 : Number(confidence);
  if (c >= 0.9) return { tier: "ai_confirmed", label: "Confirmed (AI)", used: true };
  if (c >= 0.7) return { tier: "ai_suggested", label: "AI Suggested", used: true };
  return { tier: "needs_review", label: "Needs review", used: false };
}
const TIER_CLASS = {
  confirmed: "src-user_confirmed", manual: "src-manual", ai_confirmed: "src-user_confirmed",
  ai_suggested: "src-ai_suggested", needs_review: "src-needs_review", rejected: "src-rejected",
};

let _modalIntelData = null;
let _modalSelectedTagIds = new Set();

function getModalIncludeTagIds() {
  if (!_modalIntelData || !_modalIntelData.company) return undefined;
  return [..._modalSelectedTagIds];
}

function tagCheckboxChip(t) {
  const tr = clientTagTier(t.source, t.confidence);
  if (tr.tier === "rejected") return "";
  const checked = _modalSelectedTagIds.has(t.tag_id) ? "checked" : "";
  const conf = t.confidence != null ? ` ${Math.round(t.confidence * 100)}%` : "";
  return `<label class="intel-chip ${TIER_CLASS[tr.tier] || ""}" title="${escapeAttr(tr.label + conf)}">
    <input type="checkbox" data-tag-id="${t.tag_id}" ${checked} style="margin:0 3px 0 0;vertical-align:middle;">
    ${escapeHtml(savedTagLabel(t))} <span class="ic-conf">${escapeHtml(tr.label)}${conf}</span></label>`;
}

function updateModalIntelBadge() {
  const badge = document.getElementById("modal-intel-badge");
  if (!badge || !_modalIntelData) return;
  const bd = (_modalIntelData.preview && _modalIntelData.preview.breakdown) || {};
  const ai = (bd.ai_confirmed || 0) + (bd.ai_suggested || 0);
  const total = _modalSelectedTagIds.size;
  badge.textContent = `Using ${total} tag${total === 1 ? "" : "s"} — ${ai} AI · ${bd.confirmed || 0} confirmed · ${bd.manual || 0} manual`;
}

function renderModalIntel(d, contact) {
  const body = document.getElementById("modal-intel-body");
  const badge = document.getElementById("modal-intel-badge");
  _modalIntelData = d;
  const company = d.company;

  if (!company) {
    _modalSelectedTagIds = new Set();
    if (badge) badge.textContent = "No company profile";
    body.innerHTML = `<div style="font-size:0.82rem;color:#6b7280;">No saved company profile for <strong>${escapeHtml(contact.company || "this company")}</strong>. Use <strong>View / Edit Tags</strong> to run AI analysis — the tags are then used automatically in email generation (no confirmation needed).</div>`;
    return;
  }

  const companyCats = (_intelTaxonomy || []).filter((c) => c.applies_to === "company");
  const tags = d.tags || [];
  const contactTags = d.contact_tags || [];
  const allTags = [...tags, ...contactTags];
  // Default selection = every non-rejected tag that is "used" by tier (AI ≥70% incl.)
  _modalSelectedTagIds = new Set(allTags.filter((t) => clientTagTier(t.source, t.confidence).used).map((t) => t.tag_id));

  const byCat = {};
  tags.forEach((t) => { (byCat[t.category_key] = byCat[t.category_key] || []).push(t); });

  let html = `<div style="font-size:0.76rem;color:#6b7280;margin-bottom:8px;">AI-generated tags are used by default. Uncheck any to exclude it from this email; confirm/edit in <strong>View / Edit Tags</strong>.</div>`;

  companyCats.forEach((cat) => {
    const present = (byCat[cat.key] || []).filter((t) => clientTagTier(t.source, t.confidence).tier !== "rejected");
    if (!present.length) return;
    html += `<div class="intel-cat"><div class="intel-cat-title">${escapeHtml(catLabel(cat))}</div><div>${present.map(tagCheckboxChip).join("")}</div></div>`;
  });

  const roleChips = contactTags.filter((t) => clientTagTier(t.source, t.confidence).tier !== "rejected").map(tagCheckboxChip).join("");
  html += `<div class="intel-cat"><div class="intel-cat-title">Contact Role &amp; Department</div><div>
      ${roleChips}
      ${contact.department ? `<span class="intel-chip" style="background:#f8fafc;">${escapeHtml(contact.department)}</span>` : ""}
      ${!roleChips && !contact.department ? '<span style="font-size:0.76rem;color:#cbd5e1;">none</span>' : ""}
    </div></div>`;

  /* SKQ capabilities are SUGGESTIONS, opt-in. Nothing here reaches the prompt
     until it is ticked: sending every tag match turned each email into a
     catalogue dump of whatever the tags happened to hit. The free-text row
     exists because the catalogue can't anticipate every angle, and a
     capability the sender knows is relevant beats a matched one that isn't. */
  const skq = (d.preview && d.preview.skq) || [];
  html += `<div class="intel-cat"><div class="intel-cat-title">Recommended SKQ Capabilities
        <span style="font-weight:400;color:#9ca3af;">(suggestions — tick the ones to send)</span></div>
      <div class="skq-picks">${skq.length
        ? skq.map((m) => {
            const nm = skqLabel(m);
            return `<label class="intel-chip skq-pick" style="background:#eef2ff;border-color:#c7d2fe;cursor:pointer;">
              <input type="checkbox" class="skq-check" value="${escapeAttr(nm)}" style="margin-right:5px;vertical-align:-1px;">
              ${escapeHtml(nm)}</label>`;
          }).join("")
        : '<span style="font-size:0.76rem;color:#cbd5e1;">no direct SKQ match for these tags yet</span>'}</div>
      <div class="skq-custom-row">
        <input type="text" id="modal-skq-custom" placeholder="Add another capability, then press Enter"
               autocomplete="off">
      </div>
      <div class="skq-chosen" id="modal-skq-chosen"></div>
      <div style="font-size:0.74rem;color:#9ca3af;margin-top:4px;">Nothing is sent to the prompt unless selected. Attachments are recommended in Phase 2, never auto-attached.</div></div>`;

  const st = d.status || {};
  const analyzed = st.analyzed_at ? `Last analyzed ${intelFmtDate(st.analyzed_at)}` : (st.analyzed ? "Previously analyzed" : "Not analyzed yet");
  html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:8px;flex-wrap:wrap;">
      <span style="font-size:0.72rem;color:#9ca3af;">${escapeHtml(analyzed)} · ${st.tag_count || tags.length} company tags</span>
      <button class="btn-sm btn-ghost" id="modal-intel-inspect" type="button">🔍 Prompt Inspector</button>
    </div>`;

  body.innerHTML = html;
  updateModalIntelBadge();
  // Guaranteed direct wiring for the Prompt Inspector button (the body is
  // re-rendered on every open, so wire it here rather than relying on delegation).
  const inspectBtn = document.getElementById("modal-intel-inspect");
  if (inspectBtn) inspectBtn.addEventListener("click", openPromptInspector);
  initModalSkqPicker();
}

/* ── SKQ capability selection (opt-in) ───────────────────────────────── */

let _modalSkqCustom = [];        // capabilities typed in by hand

function renderModalSkqChosen() {
  const box = document.getElementById("modal-skq-chosen");
  if (!box) return;
  box.innerHTML = _modalSkqCustom.map((nm, i) =>
    `<span class="intel-chip" style="background:#ecfdf5;border-color:#6ee7b7;">${escapeHtml(nm)}
       <button type="button" data-skq-remove="${i}" title="Remove">×</button></span>`).join("");
  box.querySelectorAll("[data-skq-remove]").forEach((b) => b.addEventListener("click", () => {
    _modalSkqCustom.splice(Number(b.dataset.skqRemove), 1);
    renderModalSkqChosen();
    refreshPromptInspectorSoon();
  }));
}

function initModalSkqPicker() {
  _modalSkqCustom = [];
  renderModalSkqChosen();
  // Capability selection changes the Product Context section.
  document.querySelectorAll(".skq-check").forEach((c) =>
    c.addEventListener("change", refreshPromptInspectorSoon));
  const input = document.getElementById("modal-skq-custom");
  if (!input) return;
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v || _modalSkqCustom.some((x) => x.toLowerCase() === v.toLowerCase())) { input.value = ""; return; }
    _modalSkqCustom.push(v);
    input.value = "";
    renderModalSkqChosen();
    refreshPromptInspectorSoon();
  });
}

// What the draft/inspect endpoints receive. Empty array = send no capability
// block at all, which is the default.
function getModalSkqSelection() {
  const ticked = [...document.querySelectorAll(".skq-check:checked")].map((c) => c.value);
  return ticked.concat(_modalSkqCustom);
}

/* ── Prompt Analytics: the exact assembled prompt + tag/token analysis (0 tokens) ── */
async function openPromptInspector(opts) {
  // A fresh open starts from the assembled prompt; a refresh triggered by an
  // option change keeps the user's section edits and reapplies them on top.
  if (!opts || !opts.keepEdits) _piEdits = {};
  // Portal-safety: hoist to <body> so it escapes any stacking context and (with
  // its higher z-index) renders ABOVE the draft modal instead of behind it.
  const modal = document.getElementById("prompt-inspector-modal");
  if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
  openModal("prompt-inspector-modal");     // always show feedback, even on error
  const body = document.getElementById("prompt-inspector-body");
  if (!body) return;
  if (!_modalContact) {
    body.innerHTML = `<div class="msg-error">Open a contact's draft first, then click Prompt Inspector.</div>`;
    return;
  }
  body.innerHTML = '<div style="text-align:center;padding:24px 0;"><span class="spinner"></span> Building…</div>';
  try {
    const r = await fetch("/api/draft-email/inspect", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contact: _modalContact, sender: _sender, contactId: _modalContact.contact_id,
        mode: _modalSelectedMode,
        extraInstructions: (document.getElementById("modal-extra-instructions") || {}).value?.trim() || "",
        options: currentDraftOptions(),
        skqSelected: getModalSkqSelection(),
        includeTagIds: getModalIncludeTagIds(),
      }),
    });
    let d = null;
    try { d = await r.json(); } catch (_) { d = null; }
    if (!r.ok || !d || !d.ok) {
      const msg = (d && (d.details || d.error)) || `Server returned HTTP ${r.status}`;
      body.innerHTML = `<div class="msg-error">Couldn't build the prompt: ${escapeHtml(msg)}</div>`;
      return;
    }
    renderPromptInspector(d);
  } catch (e) {
    body.innerHTML = `<div class="msg-error">Couldn't reach the server to build the prompt: ${escapeHtml(e.message)}</div>`;
  }
}

let _lastInspect = null;
// Used-tag names within a given taxonomy category (for the context breakdown).
function taByCat(ta, catKey) {
  return (ta.tags || []).filter((t) => t.used && t.category_key === catKey).map((t) => t.name_en || t.value).join(", ");
}
function renderPromptInspector(d) {
  _lastInspect = d;
  const body = document.getElementById("prompt-inspector-body");
  const ta = d.tag_analysis || { total: 0, used_count: 0, ignored_count: 0, tags: [] };
  const tok = d.token_summary || { sections: [], total: 0 };

  // 1) Summary
  let html = `<div class="pi-summary">
    <span><b>Model</b> ${escapeHtml(d.model || "—")}</span>
    <span><b>Category</b> ${escapeHtml(d.mode)}</span>
    <span><b>Tags</b> ${ta.used_count} used · ${ta.ignored_count} ignored · ${ta.total} total</span>
    <span><b>SKQ</b> ${(d.skq_modules || []).length} module(s)</span>
    <span><b>~Prompt tokens</b> ${tok.total}</span>
  </div>`;

  // 1b) Context provided to the model + Model & tokens
  const ctxRow = (k, v) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`;
  html += `<div class="pi-card"><div class="pi-h">Context provided to the model</div><table class="pi-ctx">
    ${ctxRow("Selected draft category", escapeHtml(d.mode || "—"))}
    ${ctxRow("Contact role", escapeHtml(d.contact_role || "—"))}
    ${ctxRow("Department", escapeHtml(d.contact_department || "—"))}
    ${ctxRow("Product-scope tags", escapeHtml(taByCat(ta, "product_scope") || "(none)"))}
    ${ctxRow("Customer-priority tags", escapeHtml(taByCat(ta, "customer_priority") || "(none)"))}
    ${ctxRow("Recommended SKQ capabilities", (d.skq_modules || []).length ? escapeHtml(d.skq_modules.join(", ")) : "(none matched)")}
    ${ctxRow("Additional instructions", escapeHtml(d.extra_instructions || "(none)"))}
    ${ctxRow("Email-thread context", escapeHtml(d.prior_interactions || "no prior interactions"))}
    ${ctxRow("Attachments", `<span id="pi-attach">checking…</span>`)}
  </table></div>`;
  html += `<div class="pi-card"><div class="pi-h">Model &amp; tokens</div><table class="pi-ctx">
    ${ctxRow("Model", escapeHtml(d.model || "—"))}
    ${ctxRow("Prompt tokens (est.)", String(tok.total))}
    ${ctxRow("Completion tokens", "measured on real generation (0-token preview)")}
    ${ctxRow("Total (est.)", String(tok.total))}
  </table><div class="pi-sub">Token counts are estimates (~4 chars/token); actual usage is recorded in the AI Usage dashboard when a draft is really generated.</div></div>`;

  // 2) Why these context sources were used
  if ((d.why || []).length) {
    html += `<div class="pi-card"><div class="pi-h">Why these were selected</div>
      <ul class="pi-why">${d.why.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`;
  }

  // 3) Company tags: ranked, used vs ignored with reasons (click a used tag to highlight)
  const cfg = d.tag_config || {};
  const cfgBits = [];
  if (cfg.max_tags) cfgBits.push(`max ${cfg.max_tags}`);
  if (cfg.min_relevance != null) cfgBits.push(`min relevance ${Number(cfg.min_relevance).toFixed(2)}`);
  if ((cfg.always_include || []).length) cfgBits.push(`always: ${cfg.always_include.join(", ")}`);
  if (cfg.prefer_technical) cfgBits.push("prefer technical");
  if (cfg.prefer_business) cfgBits.push("prefer business");
  const cfgNote = cfgBits.length ? `<div class="pi-sub" style="margin-bottom:6px;">Active rules: ${escapeHtml(cfgBits.join(" · "))} — configure in Settings → Tag Prioritization.</div>` : "";
  html += `<div class="pi-card"><div class="pi-h">Company Tags <span class="pi-sub">— ${ta.used_count} used, ${ta.ignored_count} ignored of ${ta.total}. Click a used tag to highlight it in the prompt.</span></div>${cfgNote}`;
  if (!ta.tags.length) {
    html += `<div class="pi-empty">No saved tags for this company yet.</div>`;
  } else {
    html += `<table class="pi-tags"><thead><tr><th>Tag</th><th>Score</th><th>Status / Reason</th></tr></thead><tbody>`;
    html += ta.tags.map((t) => `
      <tr class="${t.used ? "pi-used" : "pi-ignored"}" data-val="${escapeAttr(t.value)}" data-used="${t.used ? 1 : 0}">
        <td>${t.used ? "✅" : "⚠️"} ${escapeHtml(t.name_en || t.value)}${t.name_cn ? ` <span class="pi-cn">${escapeHtml(t.name_cn)}</span>` : ""}</td>
        <td class="pi-score">${t.score != null ? t.score.toFixed(2) : "—"}</td>
        <td>${t.used ? `<span class="pi-tag-ok">Used${(t.where && t.where.length) ? " · in " + t.where.map(escapeHtml).join(", ") : ""}</span>` : `<span class="pi-tag-no">${escapeHtml(t.reason || "Ignored")}</span>`}</td>
      </tr>`).join("");
    html += `</tbody></table>`;
  }
  html += `</div>`;

  // 4) Token usage by section
  const maxTok = Math.max(1, ...tok.sections.map((s) => s.tokens));
  html += `<div class="pi-card"><div class="pi-h">Token usage by section <span class="pi-sub">— approximate (~${APPROX_LABEL})</span></div>`;
  html += tok.sections.map((s) => `
    <div class="pi-bar-row"><span class="pi-bar-label">${escapeHtml(s.label)}</span>
      <span class="pi-bar"><span class="pi-bar-fill" style="width:${Math.round((s.tokens / maxTok) * 100)}%"></span></span>
      <span class="pi-bar-tok">${s.tokens}</span></div>`).join("");
  html += `<div class="pi-bar-row" style="font-weight:700;"><span class="pi-bar-label">Total</span><span class="pi-bar"></span><span class="pi-bar-tok">${tok.total}</span></div></div>`;

  /* 5) Prompt sections — editable.

     Each section is a textarea rather than one giant block, so the structure
     survives editing and a change is scoped to the part it belongs to. The
     sections concatenate back to the exact prompt, so leaving them untouched
     sends precisely what the assembler produced.

     Edits are per-draft and in-memory: nothing is persisted, and reopening
     the Inspector rebuilds from the current context. */
  // Edits are keyed by SECTION KEY, not index: changing language or tags
  // re-assembles the prompt and can add or drop sections, which would shift
  // every index and silently move an edit onto the wrong section.
  _piBaseline = (d.sections || []).map((s) => ({ key: s.key, label: s.label, text: s.text, tokens: s.tokens }));
  Object.keys(_piEdits).forEach((k) => {           // drop edits whose section vanished
    if (!_piBaseline.some((s) => s.key === k)) delete _piEdits[k];
  });
  html += `<div class="pi-card">
    <div class="pi-h">Prompt sections
      <span class="pi-sub">— editable; what you leave here is what gets sent</span>
      <button type="button" class="btn-sm btn-ghost" id="pi-reset-all" style="float:right;">Reset all sections</button>
    </div>
    <div class="pi-edit-note" id="pi-edit-note"></div>`;
  html += _piBaseline.map((s) => {
    const cur = s.key in _piEdits ? _piEdits[s.key] : s.text;
    const dirty = cur !== s.text;
    return `
    <details class="pi-section" ${s.key === "instructions" || dirty ? "open" : ""}>
      <summary>${escapeHtml(s.label)} <span class="pi-sub">· ${s.tokens || 0} tok</span>
        <span class="pi-edited" data-pi-flag="${escapeAttr(s.key)}" ${dirty ? "" : "hidden"}>edited</span></summary>
      <!-- The leading newline is deliberate: HTML drops a newline immediately
           after <textarea>, so without it every section that starts with one
           (most of them) would silently lose it the moment it was edited. -->
      <textarea class="pi-edit" data-pi-key="${escapeAttr(s.key)}" rows="${Math.min(18, Math.max(3, cur.split("\n").length))}">
${escapeHtml(cur)}</textarea>
      <button type="button" class="btn-sm btn-ghost pi-reset" data-pi-reset="${escapeAttr(s.key)}">Reset this section</button>
    </details>`;
  }).join("");
  html += `</div>`;

  /* The compiled prompt: the assembled sections with the user's edits applied,
     i.e. exactly what Generate Draft would send right now. Rebuilt on every
     edit so the sections above and this can never disagree. */
  html += `<div class="pi-h" style="margin-top:8px;">Compiled Prompt 编译后的提示词
      <span class="pi-sub">— exactly what will be sent if you generate now</span>
      <span class="pi-live" id="pi-live-badge">live</span>
      <span class="pi-sub" id="pi-compiled-meta"></span></div>
    <pre class="pi-final" id="pi-final-prompt"></pre>`;

  body.innerHTML = html;

  // Attachment metadata comes from the current draft (if one is open/saved).
  const attEl = document.getElementById("pi-attach");
  if (attEl) {
    if (_modalComm && _modalComm.id) {
      fetch(`/api/communications/${_modalComm.id}/attachments`).then((r) => r.json()).then((a) => {
        const list = (a && a.attachments) || [];
        attEl.textContent = list.length ? list.map((x) => `${x.original_filename} (${Math.round((x.file_size || 0) / 1024)} KB)`).join(", ") : "(none)";
      }).catch(() => { attEl.textContent = "(none)"; });
    } else {
      attEl.textContent = "(generate/save the draft first)";
    }
  }

  // Click a used tag → highlight its occurrences in the final prompt.
  body.querySelectorAll("tr.pi-used").forEach((tr) => tr.addEventListener("click", () => highlightTagInPrompt(tr.dataset.val)));
  initPromptEditor(body);
}

/* ── Live prompt composer ───────────────────────────────────────────────
   _piBaseline holds the assembled sections; _piEdits holds only what the
   user changed, keyed by section key. "Reset" is therefore just forgetting
   an entry, and an edit survives a re-assembly triggered by changing the
   language, tags or capabilities.

   The Compiled Prompt is derived from those two, never stored — so the
   sections and the preview cannot drift apart. Text edits recompile
   locally (no network); anything that changes the ASSEMBLED text re-runs
   the 0-token inspect endpoint and reapplies the edits on top. */
let _piBaseline = [];
let _piEdits = {};

function piCompiledText() {
  return _piBaseline.map((s) => (s.key in _piEdits ? _piEdits[s.key] : s.text)).join("");
}

function piRenderCompiled() {
  const pre = document.getElementById("pi-final-prompt");
  if (!pre) return;
  const text = piCompiledText();
  pre.textContent = text;                       // textContent: no escaping needed
  const meta = document.getElementById("pi-compiled-meta");
  if (meta) meta.textContent = `· ${text.length.toLocaleString()} chars · ~${Math.ceil(text.length / 4).toLocaleString()} tokens`;
  const badge = document.getElementById("pi-live-badge");
  if (badge) {                                   // brief pulse so a rebuild is visible
    badge.classList.remove("pulse");
    void badge.offsetWidth;
    badge.classList.add("pulse");
  }
  piSyncNote();
}

function piSyncNote() {
  const note = document.getElementById("pi-edit-note");
  const n = Object.keys(_piEdits).length;
  if (!note) return;
  note.innerHTML = n
    ? `<b>${n} section${n !== 1 ? "s" : ""} edited.</b> The Compiled Prompt below reflects your edits and is what the next draft will send. 下次生成将使用你编辑后的提示词。`
    : "";
  note.classList.toggle("on", n > 0);
}

function initPromptEditor(root) {
  const recompile = debounce(piRenderCompiled, 300);   // per the 300-500ms ask

  root.querySelectorAll(".pi-edit").forEach((ta) => {
    ta.addEventListener("input", () => {
      const key = ta.dataset.piKey;
      const base = (_piBaseline.find((x) => x.key === key) || {}).text || "";
      if (ta.value === base) delete _piEdits[key]; else _piEdits[key] = ta.value;
      const flag = root.querySelector(`[data-pi-flag="${CSS.escape(key)}"]`);
      if (flag) flag.hidden = ta.value === base;
      recompile();
    });
  });

  // Resets are deliberate, so they recompile immediately rather than debounced.
  root.querySelectorAll("[data-pi-reset]").forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.piReset;
    const ta = root.querySelector(`[data-pi-key="${CSS.escape(key)}"]`);
    if (!ta) return;
    ta.value = (_piBaseline.find((x) => x.key === key) || {}).text || "";
    delete _piEdits[key];
    const flag = root.querySelector(`[data-pi-flag="${CSS.escape(key)}"]`);
    if (flag) flag.hidden = true;
    piRenderCompiled();
  }));

  document.getElementById("pi-reset-all")?.addEventListener("click", () => {
    _piEdits = {};
    root.querySelectorAll(".pi-edit").forEach((ta) => {
      ta.value = (_piBaseline.find((x) => x.key === ta.dataset.piKey) || {}).text || "";
    });
    root.querySelectorAll("[data-pi-flag]").forEach((f) => { f.hidden = true; });
    piRenderCompiled();
  });

  piRenderCompiled();
}

/* Re-assemble from the server when something upstream of the text changes —
   language, tone, length, CTA, tag selection, SKQ capabilities. Only runs
   while the Inspector is open, and the inspect endpoint spends no tokens. */
const refreshPromptInspectorSoon = debounce(() => {
  const modal = document.getElementById("prompt-inspector-modal");
  if (!modal || !modal.classList.contains("open")) return;
  openPromptInspector({ keepEdits: true });
}, 350);

/* What the draft request should carry: null when nothing was edited, so an
   untouched Inspector leaves the normal assembly path alone. */
function currentPromptSections() {
  if (!_piBaseline.length || !Object.keys(_piEdits).length) return null;
  return _piBaseline.map((s) => ({ key: s.key, text: s.key in _piEdits ? _piEdits[s.key] : s.text }));
}
const APPROX_LABEL = "4 chars/token";

function highlightTagInPrompt(value) {
  const pre = document.getElementById("pi-final-prompt");
  if (!pre) return;
  // Search what is actually on screen — the compiled prompt including edits.
  const raw = piCompiledText();
  if (!value) { pre.innerHTML = escapeHtml(raw); return; }
  // Escape the prompt, then wrap escaped occurrences of the (escaped) value in <mark>.
  const escVal = escapeHtml(value);
  const escPrompt = escapeHtml(raw);
  const safe = escVal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  pre.innerHTML = safe ? escPrompt.replace(new RegExp(safe, "gi"), (m) => `<mark class="pi-mark">${m}</mark>`) : escPrompt;
  const first = pre.querySelector(".pi-mark");
  if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
}

// Header toggles the body; "View / Edit Tags" jumps to the CRM intel tab.
(function wireModalIntel() {
  const header = document.getElementById("modal-intel-header");
  const body = document.getElementById("modal-intel-body");
  const caret = document.getElementById("modal-intel-caret");
  if (header && body) {
    header.addEventListener("click", (e) => {
      if (e.target.closest("#modal-intel-viewedit")) return; // button handled below
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "";
      if (caret) caret.textContent = open ? "▸" : "▾";
    });
  }
  const viewEdit = document.getElementById("modal-intel-viewedit");
  if (viewEdit) {
    viewEdit.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!_modalIntelCompany) { showMessage("No saved company for this contact yet.", "warn"); return; }
      const co = _modalIntelCompany;
      if (typeof closeEmailModal === "function") closeEmailModal();
      showView("crm");
      addCrmIntelCompany(co.id, co.name);
      openCrmIntelDrawer();
    });
  }
  // Tag include/exclude checkboxes (Customize) + Prompt Inspector button.
  if (body) {
    body.addEventListener("change", (e) => {
      const cb = e.target.closest("input[type=checkbox][data-tag-id]");
      if (!cb) return;
      const id = Number(cb.dataset.tagId);
      if (cb.checked) _modalSelectedTagIds.add(id); else _modalSelectedTagIds.delete(id);
      updateModalIntelBadge();
      refreshPromptInspectorSoon();
    });
    // The Prompt Inspector button is wired directly in renderModalIntel (guaranteed).
  }
})();

document.getElementById("prompt-inspector-close").addEventListener("click", () => closeModal("prompt-inspector-modal"));
document.getElementById("prompt-inspector-modal").addEventListener("click", (e) => {
  if (e.target === document.getElementById("prompt-inspector-modal")) closeModal("prompt-inspector-modal");
});

/* =======================================================================
   AI Usage dashboard (left-nav "AI Usage"). KPIs + inline SVG charts +
   feature/model/company breakdowns + paginated request audit log + CSV
   export + budget config. All data from the persistent ai_usage_events.
   ======================================================================= */

let _aiuLoaded = false;
let _aiuData = null;
let _aiuEventsPage = 0;
let _aiuFeatureFilter = "";
const AIU_FEATURE_LABELS = {
  company_research: "Company Intelligence", email_draft: "Email Drafting", contact_intel: "Contact Intelligence",
  product_match: "Product Matching", attachment_rec: "Attachment Recs", email_classify: "Email Classification", other: "Other",
};

function initAiUsageDashboard() {
  // No nav-item listener and no "was this the saved view?" check here: both
  // are showView()'s job now, so every route into the view loads exactly once.
  const idle = document.getElementById("aiu-load");
  if (idle) idle.addEventListener("click", () => loadAiUsage());
  const period = document.getElementById("aiu-period");
  if (period) period.addEventListener("change", () => {
    const custom = period.value === "custom";
    document.getElementById("aiu-from").style.display = custom ? "" : "none";
    document.getElementById("aiu-to").style.display = custom ? "" : "none";
    if (!custom) loadAiUsage();
  });
  document.getElementById("aiu-refresh") && document.getElementById("aiu-refresh").addEventListener("click", () => loadAiUsage());
  const exp = document.getElementById("aiu-export");
  if (exp) exp.addEventListener("click", (e) => { e.preventDefault(); window.open("/api/ai-usage/export.csv?" + aiuQuery(), "_blank"); });
  // Footer AI/Claude labels open the dashboard.
  document.querySelectorAll("#usage-bar .u-label").forEach((el) => {
    if (el.textContent === "AI" || el.textContent === "Claude") {
      el.style.cursor = "pointer"; el.title = "Open AI Usage dashboard";
      el.addEventListener("click", () => showView("ai-usage"));
    }
  });
}

function aiuQuery() {
  const period = document.getElementById("aiu-period").value;
  const p = new URLSearchParams({ period });
  if (period === "custom") {
    const f = document.getElementById("aiu-from").value, t = document.getElementById("aiu-to").value;
    if (f) p.set("from", f); if (t) p.set("to", t);
  }
  if (_aiuFeatureFilter) p.set("feature", _aiuFeatureFilter);
  return p.toString();
}

/* A fetch with no timeout has no failure state — it just never settles, and
   the caller's spinner spins forever. That is what a request caught by a
   server restart looks like: not an error anyone can see or retry, just a
   page that appears to be loading. Every panel that opens with a spinner
   needs a deadline and a way back. */
async function fetchWithTimeout(url, ms = 20000, options = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function aiuErrorHtml(messageEn, messageCn) {
  return `<div style="text-align:center;padding:28px 12px;">
    <div class="msg-error" style="display:inline-block;text-align:left;max-width:520px;">
      ${escapeHtml(messageEn)}<br><span style="opacity:.8">${escapeHtml(messageCn)}</span>
    </div>
    <div style="margin-top:12px;"><button class="btn-sm btn-primary" id="aiu-retry">Try again 重试</button></div>
  </div>`;
}

async function loadAiUsage() {
  _aiuLoaded = true;
  const body = document.getElementById("aiu-body");
  body.innerHTML = '<div style="text-align:center;padding:32px 0;"><span class="spinner"></span> Loading…</div>';
  const fail = (en, cn) => {
    body.innerHTML = aiuErrorHtml(en, cn);
    document.getElementById("aiu-retry")?.addEventListener("click", loadAiUsage);
  };
  try {
    const r = await fetchWithTimeout("/api/ai-usage?" + aiuQuery());
    if (!r.ok) return fail(`Usage data request failed (HTTP ${r.status}).`, `用量数据请求失败（HTTP ${r.status}）。`);
    const d = await r.json();
    if (!d.ok) return fail(d.error || "Failed to load usage data.", "加载用量数据失败。");
    _aiuData = d;
    renderAiUsageDashboard(d);
    _aiuEventsPage = 0;
    loadAiUsageEvents();
  } catch (e) {
    if (e.name === "AbortError") {
      // Distinguished deliberately: "timed out" tells the user the server
      // stopped answering, which is a different action from "reload".
      return fail("Timed out waiting for usage data — the server did not respond.",
                  "等待用量数据超时，服务器未响应。");
    }
    fail(e.message || "Network error.", "网络错误。");
  }
}

function aiuBucketLabel(x) {
  const dt = new Date(x);
  return isNaN(dt) ? "" : dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function svgBars(series, key, color, fmt) {
  if (!series || !series.length) return '<div style="color:#9ca3af;font-size:0.78rem;padding:20px 0;">No data in range</div>';
  const vals = series.map((s) => Number(s[key]) || 0);
  const max = Math.max(1, ...vals);
  const h = 96, gap = 3, bw = Math.max(4, Math.min(40, Math.floor(560 / series.length) - gap));
  const w = series.length * (bw + gap);
  const bars = series.map((s, i) => {
    const v = Number(s[key]) || 0;
    const bh = Math.round((v / max) * (h - 16));
    const x = i * (bw + gap);
    return `<rect x="${x}" y="${h - bh - 12}" width="${bw}" height="${bh}" rx="1.5" fill="${color}"><title>${escapeAttr(aiuBucketLabel(s.bucket) + " · " + (fmt ? fmt(v) : v))}</title></rect>`;
  }).join("");
  return `<svg viewBox="0 0 ${Math.max(w, 60)} ${h}" preserveAspectRatio="none" style="width:100%;height:96px;">${bars}</svg>`;
}
function aiuKpiCard(label, value, sub) {
  return `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;background:#fff;">
      <div style="font-size:0.7rem;color:#6b7280;text-transform:uppercase;letter-spacing:.03em;">${escapeHtml(label)}</div>
      <div style="font-size:1.15rem;font-weight:700;color:#111827;margin-top:3px;">${value}</div>
      ${sub ? `<div style="font-size:0.72rem;color:#9ca3af;margin-top:1px;">${sub}</div>` : ""}</div>`;
}
function usd(x) { return "$" + Number(x || 0).toFixed(2); }
function usd4(x) { return "$" + Number(x || 0).toFixed(4); }

function renderAiUsageDashboard(d) {
  const k = d.kpis || {};
  const b = d.budget || {};
  const bs = d.budget_status || {};

  let html = "";

  // KPI cards
  html += `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px;">
    ${aiuKpiCard("Total tokens", fmtTokens(k.total_tokens), `${fmtTokens(k.input_tokens)} in / ${fmtTokens(k.output_tokens)} out`)}
    ${aiuKpiCard("Total AI cost", usd(k.cost_usd), `${k.new_calls || 0} billable calls`)}
    ${aiuKpiCard("Tokens saved", fmtTokens(k.saved_total), usd(k.saved_cost_usd) + " saved")}
    ${aiuKpiCard("AI requests", fmtTokens(k.requests), `${k.new_calls || 0} new · ${k.reuses || 0} reuse`)}
    ${aiuKpiCard("Reuse rate", Math.round((k.reuse_rate || 0) * 100) + "%", "DB/cache-first")}
    ${aiuKpiCard("Avg cost / call", usd4(k.avg_cost_usd), "per new AI call")}
    ${aiuKpiCard("Avg latency", k.avg_response_ms != null ? k.avg_response_ms + " ms" : "—", "AI response time")}
    ${aiuKpiCard("Failures", fmtTokens(k.failures), Math.round((k.failure_rate || 0) * 100) + "% fail rate")}
    ${aiuKpiCard("Input tokens", fmtTokens(k.input_tokens), "")}
    ${aiuKpiCard("Output tokens", fmtTokens(k.output_tokens), "")}
  </div>`;

  // Budget status bar
  if (b.daily_cost_budget || b.monthly_cost_budget || b.daily_token_budget || b.monthly_token_budget) {
    const chip = (label, pct) => {
      const over = pct >= 100, warn = pct >= (bs.warn_threshold_pct || 80);
      const col = over ? "#dc2626" : warn ? "#0C579A" : "#059669";
      return `<span style="font-size:0.78rem;color:#374151;margin-right:16px;">${label}: <b style="color:${col};">${pct}%</b></span>`;
    };
    html += `<div style="border:1px solid #eef2f7;background:#f9fafb;border-radius:8px;padding:8px 12px;margin-bottom:16px;">
      ${b.daily_cost_budget ? chip("Daily cost", bs.daily_cost_pct) : ""}
      ${b.monthly_cost_budget ? chip("Monthly cost", bs.monthly_cost_pct) : ""}
      ${b.daily_token_budget ? chip("Daily tokens", bs.daily_token_pct) : ""}
      ${b.monthly_token_budget ? chip("Monthly tokens", bs.monthly_token_pct) : ""}
      <span style="font-size:0.72rem;color:#9ca3af;">${b.hard_limit ? "Hard limit ON (blocks at 100%)" : "Warn-only (never blocks)"}</span>
    </div>`;
  }

  // Charts
  const ch = (title, svg) => `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;">
      <div style="font-size:0.78rem;font-weight:600;color:#374151;margin-bottom:8px;">${escapeHtml(title)}</div>${svg}</div>`;
  html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
    ${ch("Total tokens over time", svgBars(d.timeseries, "total_tokens", "#4E2A84", fmtTokens))}
    ${ch("AI cost over time", svgBars(d.timeseries, "cost_usd", "#7c3aed", (v) => usd(v)))}
    ${ch("Requests over time (new vs reuse)", svgBars(d.timeseries, "requests", "#0891b2", fmtTokens))}
    ${ch("Tokens saved over time", svgBars(d.timeseries, "saved_total", "#059669", fmtTokens))}
  </div>`;

  // Feature breakdown (click to drill into audit)
  html += `<h3 style="font-size:0.9rem;margin:6px 0 6px;">By feature <span style="font-weight:400;font-size:0.74rem;color:#9ca3af;">(click a row to filter the request log)</span></h3>
    <div style="overflow-x:auto;"><table class="intel-matrix-table" style="min-width:720px;margin-bottom:16px;"><thead><tr>
      <th>Feature</th><th>Requests</th><th>In</th><th>Out</th><th>Total</th><th>Cost</th><th>Saved</th><th>Avg latency</th><th>Fail%</th></tr></thead><tbody>`;
  (d.by_feature || []).forEach((f) => {
    const fail = f.requests ? Math.round((f.failures / f.requests) * 100) : 0;
    html += `<tr style="cursor:pointer;" data-aiu-feature="${escapeAttr(f.feature)}">
      <td><strong>${escapeHtml(AIU_FEATURE_LABELS[f.feature] || f.feature)}</strong></td>
      <td>${f.requests}</td><td>${fmtTokens(f.input_tokens)}</td><td>${fmtTokens(f.output_tokens)}</td>
      <td>${fmtTokens(f.total_tokens)}</td><td>${usd(f.cost_usd)}</td>
      <td style="color:#059669;">${fmtTokens(f.saved_total)} (${usd(f.saved_cost_usd)})</td>
      <td>${f.avg_response_ms != null ? Math.round(f.avg_response_ms) + " ms" : "—"}</td><td>${fail}%</td></tr>`;
  });
  if (!(d.by_feature || []).length) html += `<tr><td colspan="9" style="color:#9ca3af;">No AI usage in range.</td></tr>`;
  html += `</tbody></table></div>`;

  // By model + by company side by side
  html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
    <div><h3 style="font-size:0.9rem;margin:0 0 6px;">By model</h3><table class="intel-matrix-table"><thead><tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>
      ${(d.by_model || []).map((m) => `<tr><td>${escapeHtml(m.model)}</td><td>${m.requests}</td><td>${fmtTokens(m.total_tokens)}</td><td>${usd(m.cost_usd)}</td></tr>`).join("") || '<tr><td colspan="4" style="color:#9ca3af;">—</td></tr>'}
    </tbody></table></div>
    <div><h3 style="font-size:0.9rem;margin:0 0 6px;">Top companies</h3><table class="intel-matrix-table"><thead><tr><th>Company</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>
      ${(d.by_company || []).map((c) => `<tr><td>${escapeHtml(c.company_name || ("#" + c.company_id))}</td><td>${c.new_calls}</td><td>${fmtTokens(c.total_tokens)}</td><td>${usd(c.cost_usd)}</td></tr>`).join("") || '<tr><td colspan="4" style="color:#9ca3af;">—</td></tr>'}
    </tbody></table></div>
  </div>`;

  // Request audit log container
  html += `<h3 style="font-size:0.9rem;margin:6px 0 6px;display:flex;justify-content:space-between;align-items:center;">
      <span>Request log ${_aiuFeatureFilter ? `— <span style="color:#4E2A84;">${escapeHtml(AIU_FEATURE_LABELS[_aiuFeatureFilter] || _aiuFeatureFilter)}</span> <a href="#" id="aiu-clear-feature" style="font-size:0.74rem;">(clear)</a>` : ""}</span>
      <span style="font-size:0.74rem;font-weight:400;color:#9ca3af;">no prompts or email content shown</span>
    </h3>
    <div id="aiu-audit"><div style="color:#9ca3af;font-size:0.8rem;">Loading requests…</div></div>`;

  // Budget config
  html += `<h3 style="font-size:0.9rem;margin:16px 0 6px;">Budgets &amp; limits</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;font-size:0.8rem;">
      <label>Daily cost budget (USD)<input type="number" step="0.01" id="aib-daily-cost" value="${b.daily_cost_budget || 0}" class="aib-inp"></label>
      <label>Monthly cost budget (USD)<input type="number" step="0.01" id="aib-monthly-cost" value="${b.monthly_cost_budget || 0}" class="aib-inp"></label>
      <label>Per-user/day cost (USD)<input type="number" step="0.01" id="aib-user-cost" value="${b.per_user_cost_budget || 0}" class="aib-inp"></label>
      <label>Daily token budget<input type="number" id="aib-daily" value="${b.daily_token_budget || 0}" class="aib-inp"></label>
      <label>Monthly token budget<input type="number" id="aib-monthly" value="${b.monthly_token_budget || 0}" class="aib-inp"></label>
      <label>Warn threshold (%)<input type="number" id="aib-warn" value="${b.warn_threshold_pct || 80}" class="aib-inp"></label>
      <label>Max tokens / request<input type="number" id="aib-maxreq" value="${b.max_tokens_per_request || 0}" class="aib-inp"></label>
      <label>Max cost / request (USD)<input type="number" step="0.01" id="aib-maxcost" value="${b.max_cost_per_request || 0}" class="aib-inp"></label>
      <label style="display:flex;align-items:center;gap:6px;margin-top:18px;"><input type="checkbox" id="aib-hard" ${b.hard_limit ? "checked" : ""}> Hard limit (block at 100%)</label>
    </div>
    <label style="display:block;font-size:0.8rem;margin-top:8px;"><input type="checkbox" id="aib-autooff" ${b.auto_refresh_disabled ? "checked" : ""}> Disable automatic AI refreshes</label>
    <button class="btn-sm btn-orange" id="aib-save" style="margin-top:10px;">Save budgets</button>
    <div style="font-size:0.72rem;color:#9ca3af;margin-top:6px;">0 = unlimited. Warn-only unless "Hard limit" is enabled.</div>`;

  const body = document.getElementById("aiu-body");
  body.innerHTML = html;
  document.querySelector('style#aib-style') || (function () {
    const st = document.createElement("style"); st.id = "aib-style";
    st.textContent = ".aib-inp{width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;} #aiu-body label{display:block;color:#6b7280;}";
    document.head.appendChild(st);
  })();

  // wire feature drilldown
  document.querySelectorAll("[data-aiu-feature]").forEach((row) => {
    row.addEventListener("click", () => { _aiuFeatureFilter = row.dataset.aiuFeature; _aiuEventsPage = 0; renderAiUsageDashboard(_aiuData); loadAiUsageEvents(); });
  });
  const clr = document.getElementById("aiu-clear-feature");
  if (clr) clr.addEventListener("click", (e) => { e.preventDefault(); _aiuFeatureFilter = ""; _aiuEventsPage = 0; renderAiUsageDashboard(_aiuData); loadAiUsageEvents(); });
  document.getElementById("aib-save").addEventListener("click", saveAiBudgetDashboard);
}

async function loadAiUsageEvents() {
  const box = document.getElementById("aiu-audit");
  if (!box) return;
  const limit = 25;
  const params = new URLSearchParams({ period: document.getElementById("aiu-period").value, limit, offset: _aiuEventsPage * limit });
  if (document.getElementById("aiu-period").value === "custom") {
    const f = document.getElementById("aiu-from").value, t = document.getElementById("aiu-to").value;
    if (f) params.set("from", f); if (t) params.set("to", t);
  }
  if (_aiuFeatureFilter) params.set("feature", _aiuFeatureFilter);
  box.innerHTML = '<div style="padding:14px 0;color:#9ca3af;font-size:.8rem;"><span class="spinner"></span> Loading events…</div>';
  try {
    // Same deadline as the summary above: an untimed fetch has no failure
    // state, so a stalled call would leave this panel spinning for good.
    const r = await fetchWithTimeout("/api/ai-usage/events?" + params.toString());
    const d = await r.json();
    if (!d.ok) { box.innerHTML = `<div class="msg-error">${escapeHtml(d.error || "Failed")}</div>`; return; }
    let html = `<div style="overflow-x:auto;"><table class="intel-matrix-table" style="min-width:820px;"><thead><tr>
      <th>Time</th><th>Feature</th><th>Type</th><th>Status</th><th>Model</th><th>In</th><th>Out</th><th>Total</th><th>Cost</th><th>ms</th><th>User</th><th>Company</th></tr></thead><tbody>`;
    (d.rows || []).forEach((e) => {
      const statusColor = e.status === "error" ? "#dc2626" : "#059669";
      html += `<tr>
        <td style="white-space:nowrap;">${escapeHtml(new Date(e.created_at).toLocaleString())}</td>
        <td>${escapeHtml(AIU_FEATURE_LABELS[e.feature] || e.feature)}${e.sub_feature ? ` <span style="color:#9ca3af;">/${escapeHtml(e.sub_feature)}</span>` : ""}</td>
        <td>${escapeHtml(e.request_type || e.outcome || "")}</td>
        <td style="color:${statusColor};">${escapeHtml(e.status || "")}</td>
        <td>${escapeHtml(e.model || "—")}</td>
        <td>${fmtTokens(e.input_tokens)}</td><td>${fmtTokens(e.output_tokens)}</td><td>${fmtTokens(e.total_tokens)}</td>
        <td>${usd4(e.cost_usd)}</td><td>${e.response_ms != null ? e.response_ms : "—"}</td>
        <td>${escapeHtml(e.user_id || "—")}</td><td>${escapeHtml(e.company_name || (e.company_id ? "#" + e.company_id : "—"))}</td></tr>`;
    });
    if (!(d.rows || []).length) html += `<tr><td colspan="12" style="color:#9ca3af;">No requests.</td></tr>`;
    html += `</tbody></table></div>`;
    const pages = Math.ceil((d.total || 0) / limit);
    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:0.78rem;color:#6b7280;">
      <span>${d.total || 0} requests</span>
      <span>
        <button class="btn-sm btn-ghost" id="aiu-prev" ${_aiuEventsPage <= 0 ? "disabled" : ""}>‹ Prev</button>
        Page ${_aiuEventsPage + 1} / ${Math.max(1, pages)}
        <button class="btn-sm btn-ghost" id="aiu-next" ${_aiuEventsPage >= pages - 1 ? "disabled" : ""}>Next ›</button>
      </span></div>`;
    box.innerHTML = html;
    const prev = document.getElementById("aiu-prev"), next = document.getElementById("aiu-next");
    if (prev) prev.addEventListener("click", () => { if (_aiuEventsPage > 0) { _aiuEventsPage--; loadAiUsageEvents(); } });
    if (next) next.addEventListener("click", () => { _aiuEventsPage++; loadAiUsageEvents(); });
  } catch (e) {
    if (e.name === "AbortError") {
      return fail("Timed out waiting for the request log — the server did not respond.",
                  "等待请求日志超时，服务器未响应。");
    }
    fail(e.message || "Network error.", "网络错误。");
  }
}

async function saveAiBudgetDashboard() {
  const num = (id) => document.getElementById(id).value;
  const payload = {
    daily_cost_budget: num("aib-daily-cost"), monthly_cost_budget: num("aib-monthly-cost"), per_user_cost_budget: num("aib-user-cost"),
    daily_token_budget: num("aib-daily"), monthly_token_budget: num("aib-monthly"),
    warn_threshold_pct: num("aib-warn"), max_tokens_per_request: num("aib-maxreq"), max_cost_per_request: num("aib-maxcost"),
    hard_limit: document.getElementById("aib-hard").checked,
    auto_refresh_disabled: document.getElementById("aib-autooff").checked,
  };
  try {
    const r = await fetch("/api/ai-usage/budget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (d.ok) { showMessage("Budgets saved.", "info"); loadAiUsage(); }
    else showMessage(d.error || "Failed to save", "error");
  } catch (e) { showMessage("Save failed: " + e.message, "error"); }
}

/* ── Duplicate-company consolidation (Intelligence → Duplicate companies tab).
   Moves intelligence onto the row that has the contacts, so one company keeps
   one profile shared by all its contacts. ── */
async function loadDuplicateCompanies() {
  const box = document.getElementById("intel-duplicates");
  if (!box) return;
  box.innerHTML = '<div style="color:#9ca3af;font-size:0.85rem;">Loading…</div>';
  try {
    const r = await fetch("/api/companies/duplicates");
    const d = await r.json();
    if (!d.ok) { box.innerHTML = `<div class="msg-error">${escapeHtml(d.error || "Failed")}</div>`; return; }
    renderDuplicateCompanies(d.duplicates || []);
  } catch (e) { box.innerHTML = `<div class="msg-error">${escapeHtml(e.message)}</div>`; }
}

function renderDuplicateCompanies(rows) {
  const box = document.getElementById("intel-duplicates");
  const groups = {};
  rows.forEach((r) => { (groups[r.name_key] = groups[r.name_key] || []).push(r); });
  const keys = Object.keys(groups).filter((k) => groups[k].length > 1);
  if (!keys.length) {
    box.innerHTML = '<div style="color:#059669;font-size:0.85rem;">No duplicate companies — every company has a single row. 🎉</div>';
    return;
  }
  let html = "";
  keys.forEach((k) => {
    const g = groups[k].slice().sort((a, b) => b.contact_count - a.contact_count || b.tag_count - a.tag_count);
    const target = g[0];
    html += `<div class="intel-section"><h3 style="margin-bottom:6px;">${escapeHtml(target.name)} <span style="font-weight:400;color:#9ca3af;font-size:0.75rem;">— ${g.length} rows share this name</span></h3>
      <table class="intel-matrix-table" style="margin-bottom:8px;"><thead><tr><th>Row</th><th>Tags</th><th>Contacts</th><th></th></tr></thead><tbody>`;
    g.forEach((r) => {
      const isTarget = r.id === target.id;
      html += `<tr><td>#${r.id} ${escapeHtml(r.name)}${isTarget ? ' <span style="color:#4E2A84;font-weight:600;">← keep (has contacts)</span>' : ''}</td>
        <td>${r.tag_count}</td><td>${r.contact_count}</td>
        <td>${isTarget ? '' : `<button class="btn-sm btn-ghost" data-merge-from="${r.id}" data-merge-to="${target.id}">Merge → #${target.id}</button>`}</td></tr>`;
    });
    html += `</tbody></table>
      <button class="btn-sm btn-orange" data-consolidate="${escapeAttr(k)}">Consolidate all into #${target.id}</button></div>`;
  });
  box.innerHTML = html;

  box.querySelectorAll("[data-merge-from]").forEach((b) =>
    b.addEventListener("click", () => mergeDupCompany(Number(b.dataset.mergeFrom), Number(b.dataset.mergeTo))));
  box.querySelectorAll("[data-consolidate]").forEach((b) =>
    b.addEventListener("click", async () => {
      const g = groups[b.dataset.consolidate].slice().sort((a, c) => c.contact_count - a.contact_count || c.tag_count - a.tag_count);
      const target = g[0];
      let moved = 0;
      for (const r of g.slice(1)) { const d = await doMergeCompany(r.id, target.id); moved += (d.moved_tags || 0); }
      showMessage(`Consolidated into #${target.id} (${moved} tag(s) moved).`, "info");
      loadDuplicateCompanies();
    }));
}

async function doMergeCompany(from, to) {
  const r = await fetch(`/api/companies/${to}/merge-intelligence`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from }),
  });
  return r.json();
}
async function mergeDupCompany(from, to) {
  try {
    const d = await doMergeCompany(from, to);
    if (d.ok) { showMessage(`Merged ${d.moved_tags || 0} tag(s) into #${to}.`, "info"); loadDuplicateCompanies(); }
    else showMessage(d.error || "Merge failed", "error");
  } catch (e) { showMessage("Merge failed: " + e.message, "error"); }
}

/* =======================================================================
   Email configuration (Settings view). Provider-aware:
   • NetEase Enterprise Mail / 网易企业邮箱 and Custom → SMTP + IMAP (org
     servers set once by IT; each user connects their own @domain mailbox).
   • Microsoft 365 / Google → org-level OAuth sign-in.
   Four cards: Organization Email Configuration (admin), My Email Account,
   Signature & Sending Preferences, Connection Test History. Plus the
   Draft-modal "sending not configured yet" banner.
   ======================================================================= */
let _emailIsAdmin = false;
let _emOrgCfg = {};                    // last-loaded org config (no secrets)
let _emProviders = {};                 // provider registry from /api/email/providers
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const providerLabel = (id) => (_emProviders[id] && _emProviders[id].label) || id || "";
const providerType = (id) => (_emProviders[id] && _emProviders[id].type) || "";
const providerDefaults = (id) => (_emProviders[id] && _emProviders[id].defaults) || {};

// Load the provider catalog from the backend and fill the dropdown. Keeping the
// list server-driven means adding a provider is a one-file change (providers.js).
async function loadProviders() {
  try {
    const d = await (await fetch("/api/email/providers")).json();
    _emProviders = {};
    const sel = document.getElementById("em-org-provider_type");
    const cur = sel ? sel.value : "";
    let opts = '<option value="">Choose a provider…</option>';
    (d.providers || []).forEach((p) => { _emProviders[p.id] = p; opts += `<option value="${p.id}">${esc(p.label)}</option>`; });
    if (sel) { sel.innerHTML = opts; if (cur && _emProviders[cur]) sel.value = cur; }
  } catch (e) { /* ignore */ }
}
const emVal = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ""; };
const emSet = (id, v) => { const e = document.getElementById(id); if (e) e.value = (v == null ? "" : v); };
const emChk = (id) => { const e = document.getElementById(id); return e ? e.checked : false; };
const emSetChk = (id, v) => { const e = document.getElementById(id); if (e) e.checked = Boolean(v); };
function emBadge(id, text, cls) { const e = document.getElementById(id); if (e) { e.textContent = text; e.className = "em-badge " + cls; } }
function emResult(id, r) {
  const e = document.getElementById(id); if (!e) return;
  const ok = r && (r.ok !== false) && (!r.result || r.result.ok !== false);
  const msg = (r && r.result && r.result.message) || (r && r.message) || (r && r.error) || "";
  e.style.color = ok ? "#059669" : "#b91c1c";
  e.textContent = msg;
}
const isOAuthProvider = (p) => providerType(p) === "oauth";

// ── Tag Prioritization config (admin) ──────────────────────────────────────
async function initTagPriority() {
  const card = document.getElementById("tag-priority-card");
  if (!card) return;
  let d;
  try { d = await (await fetch("/api/tag-priority")).json(); } catch (e) { return; }
  card.style.display = d.is_admin ? "" : "none";
  if (!d.is_admin) return;
  const c = d.config || {};
  emSet("tp-max", c.max_tags != null ? c.max_tags : 0);
  emSet("tp-min", (c.min_relevance != null ? c.min_relevance : 0.7));
  emSet("tp-always", (c.always_include || []).join(", "));
  emSetChk("tp-tech", c.prefer_technical);
  emSetChk("tp-biz", c.prefer_business);
  const btn = document.getElementById("tp-save");
  if (btn && !btn._wired) {
    btn._wired = true;
    btn.addEventListener("click", saveTagPriority);
  }
}
async function saveTagPriority() {
  const body = {
    max_tags: Number(emVal("tp-max")) || 0,
    min_relevance: Number(emVal("tp-min")),
    always_include: emVal("tp-always").split(",").map((s) => s.trim()).filter(Boolean),
    prefer_technical: emChk("tp-tech"),
    prefer_business: emChk("tp-biz"),
  };
  try {
    const d = await (await fetch("/api/tag-priority", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    emResult("tp-result", d.ok ? { ok: true, message: "Saved. Applies to the next draft." } : d);
  } catch (e) { emResult("tp-result", { error: e.message }); }
}

async function initEmailSettings() {
  try {
    const me = await (await fetch("/api/me")).json();
    _emailIsAdmin = Boolean(me.is_admin);
  } catch (e) { /* ignore */ }
  const orgCard = document.getElementById("em-org-card");
  if (orgCard) orgCard.style.display = _emailIsAdmin ? "" : "none";

  // Surface the result of an OAuth round-trip (?email=connected|error) once.
  const q = new URLSearchParams(location.search);
  if (q.get("email")) {
    if (q.get("email") === "connected") showMessage("✅ Email account connected.", "info");
    else showMessage("Couldn't connect email: " + (q.get("reason") || "unknown error"), "error");
    history.replaceState(null, "", location.pathname);
  }

  await loadProviders();

  const wire = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener("click", fn); };
  const provSel = document.getElementById("em-org-provider_type");
  if (provSel) provSel.addEventListener("change", onProviderChange);
  wire("em-org-detect-btn", emailAutoDetect);
  wire("em-org-save", saveEmailOrg);
  wire("em-org-test-smtp", () => emailOrgAction("test-smtp"));
  wire("em-org-test-imap", () => emailOrgAction("test-imap"));
  wire("em-org-validate", () => emailOrgAction("validate-domain"));
  wire("em-acct-save", saveEmailAccount);
  wire("em-acct-test", testConnection);
  wire("em-acct-sendtest", () => emailAccountAction("send-test"));
  wire("em-acct-disconnect", () => emailAccountAction("disconnect"));
  wire("em-pref-save", saveEmailPrefs);
  wire("em-history-refresh", loadEmailHistory);
  // Live "what's missing" checklist as the user types their email / password.
  ["em-acct-email", "em-acct-secret"].forEach((id) => { const e = document.getElementById(id); if (e) e.addEventListener("input", updateEmailChecklist); });

  await loadEmailOrg();
  await loadEmailAccount();
  await loadEmailPrefs();
  await loadEmailHistory();
}

// Show only the configuration relevant to the selected provider.
function applyProviderVisibility(provider) {
  // Derive from the provider REGISTRY, never a hardcoded list — otherwise new
  // SMTP providers (GoDaddy M365/Workspace) get treated as "neither" and their
  // whole section is hidden.
  const type = providerType(provider);           // 'smtp' | 'oauth' | ''
  const oauth = type === "oauth";
  const smtp = type === "smtp";
  const show = (id, on) => { const e = document.getElementById(id); if (e) e.style.display = on ? "" : "none"; };
  show("em-org-oauth", oauth);
  show("em-org-smtpimap", smtp);
  document.querySelectorAll(".em-smtp-action").forEach((b) => { b.style.display = smtp ? "" : "none"; });
  // My Email Account: manual mailbox for SMTP providers; sign-in note for OAuth.
  show("em-acct-manual", smtp || !provider);
  show("em-acct-oauth", oauth);
  if (oauth) renderAcctOAuthNote(provider);
}

// Runs only when the admin explicitly changes provider (dropdown / auto-detect).
// It OVERWRITES the SMTP/IMAP endpoints with the chosen provider's defaults so
// no previous provider's servers can linger (the source of "testing both").
function onProviderChange() {
  const provider = emVal("em-org-provider_type");
  const defs = providerDefaults(provider);
  if (defs && defs.smtp_host) {
    emSet("em-org-smtp_host", defs.smtp_host); emSet("em-org-smtp_port", defs.smtp_port); emSet("em-org-smtp_encryption", defs.smtp_encryption);
    emSet("em-org-imap_host", defs.imap_host); emSet("em-org-imap_port", defs.imap_port); emSet("em-org-imap_encryption", defs.imap_encryption);
    if (defs.app_password_required != null) emSetChk("em-org-app_password_required", defs.app_password_required);
    emSet("em-org-provider_name", providerLabel(provider));
  } else if (provider === "custom_imap") {
    // Custom: clear so the admin types their own endpoints from scratch.
    ["smtp_host", "smtp_port", "imap_host", "imap_port"].forEach((k) => emSet("em-org-" + k, ""));
  }
  // Changing provider invalidates any prior verification — reflect that in the UI.
  emSet("em-org-spf_status", "unchecked"); emSet("em-org-dkim_status", "unchecked"); emSet("em-org-dmarc_status", "unchecked");
  const noteEl = document.getElementById("em-org-provider-note");
  if (noteEl) noteEl.textContent = (_emProviders[provider] && _emProviders[provider].note) || "";
  emResult("em-org-result", { ok: true, message: provider ? "Provider set to " + providerLabel(provider) + " — click Save Configuration to apply." : "" });
  updateAutoConfigNote(provider);
  applyProviderVisibility(provider);
  renderOrgOAuth();
  updateEmailChecklist();
}

// The green "settings configured automatically" summary above Advanced Settings.
function updateAutoConfigNote(provider) {
  const el = document.getElementById("em-org-autoconfig-note");
  if (!el) return;
  const host = emVal("em-org-smtp_host"), port = emVal("em-org-smtp_port"), enc = emVal("em-org-smtp_encryption");
  if (host && port) {
    el.style.display = "";
    el.innerHTML = `✓ SMTP/IMAP settings configured automatically — <strong>${esc(host)}:${esc(port)}</strong> (${esc((enc || "").toUpperCase())}). You don't need to change anything below.<br><span class="i18n-zh" style="margin-left:0;">SMTP / IMAP 设置已自动配置，下方内容无需修改。</span>`;
  } else if (provider === "custom_imap") {
    el.style.display = "";
    el.style.color = "#b45309"; el.style.background = "#fffbeb"; el.style.borderColor = "#fde68a";
    el.innerHTML = "⚠ Custom provider — open Advanced Settings and enter your SMTP/IMAP servers.";
  } else {
    el.style.display = "none";
  }
}

// Auto Detect — infer the provider from an email domain's MX records.
async function emailAutoDetect() {
  const email = emVal("em-org-detect-email");
  const out = document.getElementById("em-org-detect-result");
  const btn = document.getElementById("em-org-detect-btn");
  const show = (html, color) => { if (out) { out.style.color = color || "#374151"; out.innerHTML = html; } };
  if (!email) return show("Enter an email address first.", "#b91c1c");
  if (btn) { btn.disabled = true; btn.textContent = "Detecting…"; }
  try {
    const d = await (await fetch("/api/email/detect-provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) })).json();
    if (d.provider) {
      const sel = document.getElementById("em-org-provider_type");
      if (sel && _emProviders[d.provider]) sel.value = d.provider;
      if (!emVal("em-org-allowed_domain") && d.domain) emSet("em-org-allowed_domain", d.domain);
      onProviderChange();
      let msg = `Detected: <strong>${esc(d.label)}</strong>`;
      if (d.alt) msg += ` <span style="color:#6b7280;">— if GoDaddy-hosted, choose “${esc(d.alt.label)}”.</span>`;
      show("✅ " + msg, "#047857");
    } else {
      show("⚠️ " + esc(d.message || "Couldn't match a provider.") + " Pick one manually.", "#b45309");
    }
  } catch (e) { show("Detection failed: " + esc(e.message), "#b91c1c"); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "🔎 Auto Detect Provider"; } }
}

// ── Organization config (admin) ───────────────────────────────────────────
const EM_ORG_TEXT = ["allowed_domain", "provider_name", "provider_type", "smtp_host", "smtp_encryption", "smtp_auth_method",
  "imap_host", "imap_encryption", "imap_auth_method", "inbox_folder", "sent_folder", "draft_folder", "archive_folder", "trash_folder"];
const EM_ORG_NUM = ["smtp_port", "imap_port", "sync_interval_seconds", "max_attachment_mb", "hourly_send_limit", "daily_send_limit"];
const EM_ORG_BOOL = ["imap_idle", "ip_allowlist_required", "app_password_required"];
const EM_ORG_STATUS_LABEL = {
  not_configured: ["Not configured", "gray"],
  configuration_incomplete: ["Servers needed", "amber"],
  servers_configured: ["Configured", "blue"],
  verified: ["Verified", "blue"], ready_for_users: ["Ready", "green"],
};
async function loadEmailOrg() {
  try {
    const d = await (await fetch("/api/email/org-config")).json();
    const c = d.config || {};
    _emOrgCfg = c;
    const domainEl = document.getElementById("em-domain");
    if (domainEl) domainEl.textContent = c.allowed_domain || "skeqi.com";
    if (_emailIsAdmin) {
      EM_ORG_TEXT.forEach((k) => emSet("em-org-" + k, c[k]));
      EM_ORG_NUM.forEach((k) => emSet("em-org-" + k, c[k]));
      EM_ORG_BOOL.forEach((k) => emSetChk("em-org-" + k, c[k]));
      emSet("em-org-spf_status", c.spf_status || "unchecked");
      emSet("em-org-dkim_status", c.dkim_status || "unchecked");
      emSet("em-org-dmarc_status", c.dmarc_status || "unchecked");
      // Org badge: OAuth providers show their connection; SMTP providers use orgStatus.
      if (isOAuthProvider(c.provider_type)) {
        emBadge("em-org-status", c.oauth_connected ? "Ready for sending" : "Not configured", c.oauth_connected ? "green" : "gray");
      } else {
        const lbl = EM_ORG_STATUS_LABEL[d.status] || EM_ORG_STATUS_LABEL.not_configured;
        emBadge("em-org-status", lbl[0], lbl[1]);
      }
      applyProviderVisibility(c.provider_type || "");
      renderOrgOAuth();
      updateAutoConfigNote(c.provider_type || "");
    }
    updateEmailChecklist();
  } catch (e) { /* ignore */ }
}
async function saveEmailOrg() {
  const body = {};
  EM_ORG_TEXT.forEach((k) => { body[k] = emVal("em-org-" + k); });
  EM_ORG_NUM.forEach((k) => { const v = emVal("em-org-" + k); body[k] = v ? Number(v) : null; });
  EM_ORG_BOOL.forEach((k) => { body[k] = emChk("em-org-" + k); });
  if (body.allowed_domain) body.allowed_domain = body.allowed_domain.toLowerCase();
  try {
    const d = await (await fetch("/api/email/org-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    if (d.ok) { emResult("em-org-result", { ok: true, message: "Configuration saved." }); loadEmailOrg(); loadEmailAccount(); }
    else emResult("em-org-result", d);
  } catch (e) { emResult("em-org-result", { error: e.message }); }
}
async function emailOrgAction(action) {
  const map = { "test-smtp": "em-org-test-smtp", "test-imap": "em-org-test-imap", "validate-domain": "em-org-validate", enable: "em-org-enable", disable: "em-org-disable" };
  const b = document.getElementById(map[action]); const orig = b ? b.textContent : "";
  if (b) { b.disabled = true; b.textContent = "…"; }
  try {
    const d = await (await fetch("/api/email/org-config/" + action, { method: "POST" })).json();
    if (action === "validate-domain" && d.result) {
      emSet("em-org-spf_status", d.result.spf); emSet("em-org-dkim_status", d.result.dkim); emSet("em-org-dmarc_status", d.result.dmarc);
    }
    emResult("em-org-result", d.error ? d : { ok: true, message: (d.result && d.result.message) || (action === "enable" ? "Integration enabled." : action === "disable" ? "Integration disabled." : "Done.") });
    loadEmailOrg();
    loadEmailSendStatus();
    loadEmailHistory();
  } catch (e) { emResult("em-org-result", { error: e.message }); }
  finally { if (b) { b.disabled = false; b.textContent = orig; } }
}

// ── OAuth sub-section inside the org card (Microsoft 365 / Google) ─────────
function renderOrgOAuth() {
  const el = document.getElementById("em-org-oauth-body");
  if (!el) return;
  const c = _emOrgCfg || {};
  const provider = emVal("em-org-provider_type");
  if (!isOAuthProvider(provider)) return;
  if (c.oauth_connected && c.provider_type === provider) {
    const when = c.oauth_connected_at ? new Date(c.oauth_connected_at).toLocaleString() : "—";
    el.innerHTML = `
      <div class="em-status-card">
        <div class="em-status-row"><span class="em-status-k">Signed-in account</span><span class="em-status-v">${esc(c.oauth_email || "—")}${c.oauth_display_name ? " · " + esc(c.oauth_display_name) : ""}</span></div>
        <div class="em-status-row"><span class="em-status-k">Status</span><span class="em-status-v"><span class="em-badge green">✅ Connected</span></span></div>
        <div class="em-status-row"><span class="em-status-k">Connected</span><span class="em-status-v">${esc(when)}</span></div>
      </div>
      <div class="em-actions" style="margin-top:10px;">
        <button class="btn-sm btn-ghost" id="em-oauth-reconnect">Reconnect</button>
        <button class="btn-sm btn-ghost" id="em-oauth-disconnect">Disconnect Account</button>
      </div>`;
    document.getElementById("em-oauth-reconnect").addEventListener("click", emailConnectOAuth);
    document.getElementById("em-oauth-disconnect").addEventListener("click", emailDisconnectOAuth);
  } else {
    el.innerHTML = `
      <div style="font-size:0.86rem;color:#4b5563;margin-bottom:8px;">Sign in once with the organization ${esc(providerLabel(provider))} account. Each user will then send as their own signed-in address.</div>
      <button class="btn-sm btn-orange" id="em-oauth-connect">🔗 Connect &amp; sign in</button>
      <div class="em-result" id="em-oauth-result" style="margin-top:8px;"></div>`;
    document.getElementById("em-oauth-connect").addEventListener("click", emailConnectOAuth);
  }
}
async function emailConnectOAuth() {
  const provider = emVal("em-org-provider_type");
  const domain = emVal("em-org-allowed_domain");
  const result = document.getElementById("em-oauth-result");
  const setErr = (m) => { if (result) { result.style.color = "#b91c1c"; result.innerHTML = m; } };
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return setErr("Enter a valid organization domain first (e.g. skeqi.com).");
  try {
    await fetch("/api/email/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, domain: domain.toLowerCase() }) });
    const d = await (await fetch("/api/email/oauth/start?provider=" + encodeURIComponent(provider))).json();
    if (d.ok && d.url) { location.href = d.url; return; }
    if (d.error === "not_configured") {
      setErr(`<div style="color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px;line-height:1.5;text-align:left;">
        <strong>One-time setup needed by Skeqi IT.</strong><br>${esc(d.message)}<br>
        <span style="color:#6b7280;">Redirect URI to register:</span> <code>${esc(d.redirect_uri)}</code></div>`);
    } else setErr(esc(d.error || "Couldn't start sign-in."));
  } catch (e) { setErr(esc(e.message)); }
}
async function emailDisconnectOAuth() {
  if (!confirm("Disconnect the organization email account? Sending will be disabled until you reconnect.")) return;
  try {
    await fetch("/api/email/disconnect", { method: "POST" });
    await loadEmailOrg();
    loadEmailSendStatus();
    showMessage("Email account disconnected.", "info");
  } catch (e) { showMessage("Disconnect failed: " + e.message, "error"); }
}

// The note shown in "My Email Account" when the org uses an OAuth provider.
function renderAcctOAuthNote(provider) {
  const el = document.getElementById("em-acct-oauth");
  if (!el) return;
  const email = _emOrgCfg && _emOrgCfg.oauth_email;
  el.innerHTML = _emOrgCfg && _emOrgCfg.oauth_connected
    ? `Your organization uses <strong>${esc(providerLabel(provider))}</strong>. Sending uses the organization sign-in${email ? ` — messages go out as <strong>${esc(email)}</strong>` : ""}. Nothing to configure here.`
    : `Your organization uses <strong>${esc(providerLabel(provider))}</strong>. Once your administrator connects the account, sending is enabled automatically — you don't enter any credentials here.`;
}

// ── My Email Account (all users, SMTP/IMAP providers) ─────────────────────
let _emAccount = {};
async function loadEmailAccount() {
  try {
    const d = await (await fetch("/api/email/account")).json();
    const a = d.account || {};
    _emAccount = a;
    emSet("em-acct-name", a.sender_name); emSet("em-acct-email", a.sender_email);
    emSet("em-acct-replyto", a.reply_to); emSet("em-acct-username", a.mailbox_username);
    emSet("em-acct-authmethod", a.auth_method || "app_password");
    emSetChk("em-acct-sync", a.sync_enabled);
    const ls = document.getElementById("em-acct-lastsync");
    if (ls) ls.textContent = a.last_sync_at ? new Date(a.last_sync_at).toLocaleString() : "never";
    updateEmailChecklist();   // drives the connection-state badge + checklist
    // If a prior test failed, surface an actionable hint (full stages on retry).
    const res = document.getElementById("em-acct-result");
    if (res && a.connection_status === "failed" && !res.innerHTML.trim()) {
      res.style.color = "#b91c1c";
      res.innerHTML = "⚠ The last connection attempt failed. Check your password / app password, then click <strong>Test Connection</strong> to retry and see the exact failed stage.";
    }
  } catch (e) { /* ignore */ }
}

// Configuration Status: shows exactly what's done and what's missing, sets the
// connection-state badge, and tells the user the single next step. Separate from
// the org card's configuration-state message ("Configuration saved").
function updateEmailChecklist() {
  const el = document.getElementById("em-acct-checklist");
  const next = document.getElementById("em-acct-nextstep");
  if (!el) return;
  const cfg = _emOrgCfg || {}, acct = _emAccount || {};
  const provider = cfg.provider_type || "";
  // OAuth providers: no per-user email/password — the badge follows the org sign-in.
  if (isOAuthProvider(provider)) {
    emBadge("em-acct-status", cfg.oauth_connected ? "Connected" : "Not configured", cfg.oauth_connected ? "green" : "gray");
    const next = document.getElementById("em-acct-nextstep");
    if (next) next.textContent = cfg.oauth_connected ? "" : "Next: your administrator connects the organization account in Organization Email Configuration.";
    return;
  }
  const email = emVal("em-acct-email");
  const secret = emVal("em-acct-secret");
  const domain = (cfg.allowed_domain || "").toLowerCase();
  const providerOk = Boolean(provider);
  const serversOk = Boolean(cfg.smtp_host && cfg.smtp_port);
  const domainOk = Boolean(domain) && (!email || email.toLowerCase().endsWith("@" + domain));
  const emailOk = Boolean(email);
  const secretOk = Boolean(secret || acct.has_secret);   // typed now OR already saved
  const tested = acct.connection_status || "disconnected";
  const testedOk = tested === "connected";

  const items = [
    ["Organization provider configured", providerOk, providerOk ? providerLabel(provider) : "choose a provider above"],
    ["SMTP settings configured", serversOk, serversOk ? `${cfg.smtp_host}:${cfg.smtp_port} (${(cfg.smtp_encryption || "").toUpperCase()})` : "not configured"],
    ["Authorized email domain", domainOk, domain ? "@" + domain + (email && !domainOk ? " — your email must match" : "") : "not set"],
    ["Mailbox email", emailOk, emailOk ? email : "required"],
    ["Password / app password", secretOk, secretOk ? "provided" : "required"],
    ["Connection verified", testedOk, tested === "failed" ? "failed 失败 — see result below 见下方结果" : testedOk ? "connected 已连接 ✓" : "not verified 未验证"],
  ];
  el.innerHTML = items.map(([k, ok, v]) =>
    `<div class="em-check-item ${ok ? "done" : ""}"><span>${ok ? "✅" : "⚠️"}</span><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("");

  let step = "", badge = "Not configured", cls = "gray";
  if (!providerOk) step = "Next: choose your email provider in Organization Email Configuration.";
  else if (!serversOk) step = "Next: open Advanced Settings and complete the SMTP server, or re-select the provider.";
  else if (!emailOk) step = "Next: enter your mailbox email address.";
  else if (!domainOk) step = `Next: use an @${domain} address (or update the authorized domain in Organization Email Configuration).`;
  else if (!secretOk) step = "Next: enter your mailbox password / app password, then click Test Connection.";
  else if (!testedOk) {
    if (tested === "failed") { step = "Connection failed — check your password / app password and click Test Connection again."; badge = "Connection failed"; cls = "red"; }
    else { step = "Ready to test — click Test Connection."; badge = "Ready to test"; cls = "amber-blue"; }
  } else { step = ""; badge = "Connected"; cls = "green"; }
  if (next) next.textContent = step;
  emBadge("em-acct-status", badge, cls);
}

// POST the account fields; returns the parsed response (no UI side effects).
async function postEmailAccount() {
  const body = {
    sender_name: emVal("em-acct-name"), sender_email: emVal("em-acct-email"), reply_to: emVal("em-acct-replyto"),
    mailbox_username: emVal("em-acct-username"), auth_method: emVal("em-acct-authmethod"), sync_enabled: emChk("em-acct-sync"),
  };
  const secret = emVal("em-acct-secret"); if (secret) body.secret = secret;
  return (await fetch("/api/email/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
}
async function saveEmailAccount() {
  try {
    const d = await postEmailAccount();
    if (d.ok) { emResult("em-acct-result", { ok: true, message: "Saved (not tested)." }); await loadEmailAccount(); }
    else emResult("em-acct-result", d);
  } catch (e) { emResult("em-acct-result", { error: e.message }); }
}

// One-click: save the entered email + password, then run the staged test.
async function testConnection() {
  const b = document.getElementById("em-acct-test"); const orig = b ? b.textContent : "";
  const email = emVal("em-acct-email"), secret = emVal("em-acct-secret");
  if (!email) return emResult("em-acct-result", { error: "Enter your email address first." });
  if (!secret && !(_emAccount && _emAccount.has_secret)) return emResult("em-acct-result", { error: "Enter your mailbox password / app password first." });
  if (b) { b.disabled = true; b.textContent = "Testing…"; }
  try {
    const saved = await postEmailAccount();
    if (!saved.ok) { emResult("em-acct-result", saved); return; }
    const d = await (await fetch("/api/email/account/test", { method: "POST" })).json();
    if (d.result && Array.isArray(d.result.stages)) renderConnStages("em-acct-result", d.result);
    else emResult("em-acct-result", d);
    await loadEmailAccount();
    loadEmailHistory();
    loadEmailSendStatus();
  } catch (e) { emResult("em-acct-result", { error: e.message }); }
  finally { if (b) { b.disabled = false; b.textContent = orig || "🔌 Test Connection"; } }
}
async function emailAccountAction(action) {
  const btnMap = { test: "em-acct-test", reconnect: "em-acct-reconnect", "send-test": "em-acct-sendtest", disconnect: "em-acct-disconnect" };
  const b = document.getElementById(btnMap[action]); const orig = b ? b.textContent : "";
  if (b) { b.disabled = true; b.textContent = "…"; }
  try {
    const d = await (await fetch("/api/email/account/" + action, { method: "POST" })).json();
    if (d.result && Array.isArray(d.result.stages)) renderConnStages("em-acct-result", d.result);
    else emResult("em-acct-result", d);
    loadEmailAccount();
    loadEmailHistory();
    if (action === "send-test" || action === "reconnect" || action === "test") loadEmailSendStatus();
  } catch (e) { emResult("em-acct-result", { error: e.message }); }
  finally { if (b) { b.disabled = false; b.textContent = orig; } }
}

// Staged connection status — one line per stage (network, TLS, authentication,
// mailbox access, send capability) instead of a generic "Connection Failed."
const STAGE_LABELS = {
  config: "Configuration", network: "Network", tls: "TLS / encryption",
  authentication: "Authentication", mailbox_access: "Mailbox access",
  send_capability: "Send capability", oauth: "OAuth sign-in",
};
function renderConnStages(elId, result) {
  const el = document.getElementById(elId);
  if (!el) return;
  const stages = result.stages || [];
  const prov = result.provider ? providerLabel(result.provider) : "";
  const rows = stages.map((s) => {
    const icon = s.ok ? "✅" : "❌";
    const color = s.ok ? "#4b5563" : "#b91c1c";
    return `<div style="display:flex;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px solid #f3f4f6;">
      <span style="width:1.1em;">${icon}</span>
      <span style="min-width:130px;font-weight:600;color:#374151;">${esc(STAGE_LABELS[s.stage] || s.stage)}</span>
      <span style="color:${color};flex:1;">${esc(s.message)}</span></div>`;
  }).join("");
  el.style.color = "";
  el.innerHTML = `
    ${prov ? `<div style="font-size:0.78rem;color:#6b7280;margin-bottom:4px;">Provider tested: <strong>${esc(prov)}</strong></div>` : ""}
    <div>${rows}</div>
    <div style="margin-top:8px;font-weight:700;color:${result.ok ? "#047857" : "#b91c1c"};">
      ${result.ok ? "✅ All required checks passed — ready to send." : "❌ Connection didn't complete — see the failed stage above."}
    </div>`;
}

// ── Signature & Sending Preferences (all users) ───────────────────────────
async function loadEmailPrefs() {
  try {
    const d = await (await fetch("/api/email/prefs")).json();
    const p = d.prefs || {};
    emSet("em-pref-signature", p.signature); emSet("em-pref-default_cc", p.default_cc);
    emSet("em-pref-default_bcc", p.default_bcc); emSet("em-pref-default_reply_to", p.default_reply_to);
    emSet("em-pref-default_send_mode", p.default_send_mode || "draft"); emSet("em-pref-sync_frequency", p.sync_frequency || "normal");
    emSetChk("em-pref-confirm_before_send", p.confirm_before_send !== false);
  } catch (e) { /* ignore */ }
}
async function saveEmailPrefs() {
  const body = {
    signature: emVal("em-pref-signature"), default_cc: emVal("em-pref-default_cc"), default_bcc: emVal("em-pref-default_bcc"),
    default_reply_to: emVal("em-pref-default_reply_to"), default_send_mode: emVal("em-pref-default_send_mode"),
    sync_frequency: emVal("em-pref-sync_frequency"), confirm_before_send: emChk("em-pref-confirm_before_send"),
  };
  try {
    const d = await (await fetch("/api/email/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    emResult("em-pref-result", d.ok ? { ok: true, message: "Preferences saved." } : d);
  } catch (e) { emResult("em-pref-result", { error: e.message }); }
}

// ── Connection Test History (all users) ───────────────────────────────────
const EM_TEST_KIND = { smtp: "SMTP", imap: "IMAP", domain: "Domain DNS", mailbox: "Mailbox", send: "Send test" };
async function loadEmailHistory() {
  const el = document.getElementById("em-history-body");
  if (!el) return;
  try {
    const d = await (await fetch("/api/email/test-history")).json();
    const tests = (d && d.tests) || [];
    if (!tests.length) { el.innerHTML = `<div style="color:#9ca3af;font-size:0.85rem;padding:8px 0;">No tests run yet.</div>`; return; }
    el.innerHTML = `<div style="overflow-x:auto;"><table class="em-history">
      <thead><tr><th>When</th><th>Test</th><th>Target</th><th>Result</th><th>Detail</th></tr></thead>
      <tbody data-no-i18n>${tests.map((t) => `
        <tr>
          <td>${esc(new Date(t.created_at).toLocaleString())}</td>
          <td>${esc(EM_TEST_KIND[t.kind] || t.kind || "—")}${t.scope === "org" ? ' <span class="em-badge gray" style="font-size:0.62rem;">org</span>' : ""}</td>
          <td>${esc(t.target || "—")}</td>
          <td>${t.ok ? '<span class="em-badge green">✓ Pass</span>' : '<span class="em-badge red">✕ Fail</span>'}</td>
          <td style="color:#6b7280;max-width:260px;">${esc(t.message || "")}</td>
        </tr>`).join("")}</tbody></table></div>`;
  } catch (e) { el.innerHTML = `<div style="color:#b91c1c;font-size:0.85rem;">Couldn't load history: ${esc(e.message)}</div>`; }
}

async function loadEmailSendStatus() {
  const el = document.getElementById("email-send-status");
  if (!el) return;
  try {
    const d = await (await fetch("/api/email/status")).json();
    // Keep the "From" identity in sync with the connected mailbox (single source).
    _connectedEmail = (d.ok && d.can_send && d.email) ? d.email : "";
    _connectedName = (d.ok && d.can_send && d.display_name) ? d.display_name : "";
    try { updateUserMenuFromSender(); } catch (e) { /* ignore */ }
    if (d.ok && !d.can_send) {
      // Not configured yet — drafting still works, sending is disabled. Offer a
      // one-click jump into Settings → My Email Account.
      el.style.background = ""; el.style.color = "";
      el.innerHTML = "✉️ " + esc(d.message) +
        ' <a href="#" id="email-setup-link" style="color:#3D1E6E;font-weight:600;text-decoration:underline;margin-left:6px;">Complete Email Setup →</a>';
      el.style.display = "";
      const link = document.getElementById("email-setup-link");
      if (link) link.addEventListener("click", (ev) => { ev.preventDefault(); openEmailSetup(); });
    } else if (d.ok && d.can_send && d.email) {
      // Connected — the sender identity comes from the provider automatically.
      el.style.color = "#047857";
      el.textContent = "✅ Sending as " + (d.display_name ? d.display_name + " <" + d.email + ">" : d.email);
      el.style.display = "";
    } else {
      el.style.display = "none";
    }
  } catch (e) { el.style.display = "none"; }
}

// Jump from the draft warning straight to Settings → My Email Account, expanded
// and focused, so the user can finish connecting their mailbox.
function openEmailSetup() {
  try { closeModal("email-modal"); } catch (e) { /* ignore */ }
  try { showView("settings"); } catch (e) { /* ignore */ }
  // Make sure the account section is expanded/visible for the current provider.
  try { applyProviderVisibility((_emOrgCfg && _emOrgCfg.provider_type) || ""); } catch (e) { /* ignore */ }
  setTimeout(() => {
    const card = document.getElementById("em-acct-card");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    const email = document.getElementById("em-acct-email");
    if (email) email.focus();
  }, 120);
}


/* ── CRM reply notifications ─────────────────────────────────────────────
   The bell counts replies to emails the CRM sent — nothing else. The
   dropdown is a preview: it shows who replied and a snippet, and hands off
   to the Email page for anything more. Reading a message is a different
   activity from being told one arrived, and mixing them is how a
   notification tray turns into a second, worse mail client. */
let _notifTimer = null;

async function refreshReplyBadge() {
  try {
    const d = await getJSON('/api/replies/unread-count');
    const el = document.getElementById('app-notif-count');
    if (!el) return;
    const n = Number(d.count) || 0;
    el.textContent = n > 99 ? '99+' : String(n);
    el.style.display = n ? '' : 'none';
  } catch (e) { /* a badge is not worth an error banner */ }
}

function notifTimeAgo(ts) {
  const t = new Date(ts).getTime();
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now 刚刚';
  if (m < 60) return `${m} min ago ${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago ${h} 小时前`;
  return new Date(ts).toLocaleDateString();
}

async function openReplyDropdown() {
  const box = document.getElementById('notif-dropdown');
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '<div class="notif-empty">Loading… 加载中…</div>';
  try {
    const d = await getJSON('/api/replies?limit=15');
    const list = d.replies || [];
    if (!list.length) {
      box.innerHTML = '<div class="notif-empty">No replies yet 暂无回复<br><span style="font-size:.7rem">Only replies to emails sent from the CRM appear here 仅显示 CRM 发出邮件的回复</span></div>';
      return;
    }
    box.innerHTML = '<div class="notif-head"><span>Email replies 邮件回复</span>'
      + '<button id="notif-read-all" style="border:0;background:none;color:#2563eb;cursor:pointer;font-size:.72rem;">Mark all read 全部已读</button></div>'
      + list.map((r) => `<button class="notif-item ${r.unread ? 'is-unread' : ''}" data-id="${r.id}" data-thread="${escapeAttr(r.threadId || '')}" data-contact="${r.contactId || ''}">
          <div><span class="notif-from">${escapeHtml(r.contact || r.from || 'Unknown')}</span>${r.company ? `<span class="notif-co">${escapeHtml(r.company)}</span>` : ''}</div>
          <div class="notif-snip">${escapeHtml(r.snippet || '')}</div>
          <div class="notif-time">${escapeHtml(notifTimeAgo(r.receivedAt))}</div>
        </button>`).join('');

    box.querySelectorAll('.notif-item').forEach((el) => el.addEventListener('click', async () => {
      const id = Number(el.dataset.id);
      try { await fetch('/api/replies/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) }); } catch (e) {}
      box.hidden = true;
      refreshReplyBadge();
      openEmailThread(el.dataset.thread, Number(el.dataset.contact) || null);
    }));
    document.getElementById('notif-read-all')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await fetch('/api/replies/read', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: list.map((r) => r.id) }) });
      } catch (err) {}
      box.hidden = true;
      refreshReplyBadge();
    });
  } catch (e) {
    box.innerHTML = '<div class="notif-empty">Could not load replies 无法加载回复</div>';
  }
}

/* Deep link from a notification to the conversation it refers to. The
   dropdown never becomes the place you read mail. */
/* A notification is about a conversation with a person, so it opens that
   person's record at that conversation — not a separate mail application. */
async function openEmailThread(threadId, contactId) {
  if (!contactId) { showView('crm'); showCrmTab('contacts'); return; }
  showView('crm');
  showCrmTab('contacts');
  try {
    const d = await getJSON('/api/contacts?contact_ids=' + contactId + '&pageSize=1');
    const c = (d.contacts || [])[0];
    if (c) {
      openContactDetailModal(c);
      // Expand the history section and land on the thread in question.
      const toggle = document.getElementById('imported-emails-toggle');
      const body = document.getElementById('imported-emails-body');
      if (toggle && !toggle.classList.contains('open')) { toggle.classList.add('open'); body?.classList.add('open'); }
      loadContactThreads(contactId, threadId);
    }
  } catch (e) { console.error('openEmailThread:', e); }
}

document.getElementById('app-notifications-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openReplyDropdown();
});
document.addEventListener('click', (e) => {
  const box = document.getElementById('notif-dropdown');
  if (box && !box.hidden && !e.target.closest('.notif-wrap')) box.hidden = true;
});

refreshReplyBadge();
_notifTimer = setInterval(refreshReplyBadge, 60000);

/* Setup helper for the reply connector. */
function openIngestHelp() {
  const el = document.getElementById('ingest-url');
  if (el) el.value = window.location.origin + '/api/replies/ingest';
  openModal('ingest-help-modal');
}
document.querySelectorAll('[data-ingest-close]').forEach((b) =>
  b.addEventListener('click', () => closeModal('ingest-help-modal')));

/* ── Email relationship, inside the contact ──────────────────────────────
   Email is not a separate application: a conversation only means something
   in the context of the person it is with. Threads therefore render inside
   the Draft/Details modal, under the draft controls, reusing the same
   /api/threads endpoints rather than a parallel implementation.

   Scope is unchanged: CRM-managed conversations only — what this system
   drafted or sent, plus replies matched to those messages. */

function mailWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? '' : d.toLocaleString();
}

/* Every conversation with one contact. `focusThread` scrolls to a specific
   one, so a notification lands on the message it is about. */
async function loadContactThreads(contactId, focusThread) {
  const pane = document.getElementById('cd-thread-pane');
  if (!pane || !contactId) return;
  pane.innerHTML = '<div class="draft-activity-time">Loading conversation… 加载会话…</div>';
  try {
    const d = await getJSON('/api/threads?limit=100');
    const mine = (d.threads || []).filter((t) => Number(t.contact_id) === Number(contactId));
    const badge = document.getElementById('cd-thread-badge');
    const unread = mine.reduce((n, t) => n + (t.unread_replies || 0), 0);
    if (badge) badge.innerHTML = mine.length
      ? `<span class="draft-status-badge ${unread ? 'status-pending' : 'status-approved'}">${mine.length} thread${mine.length !== 1 ? 's' : ''}${unread ? ` · ${unread} unread` : ''}</span>`
      : '';
    if (!mine.length) {
      pane.innerHTML = '<div class="draft-activity-time">No emails sent to this contact yet. 尚未向该联系人发送邮件。</div>';
      return;
    }
    pane.innerHTML = '';
    for (const t of mine) {
      const el = document.createElement('div');
      el.className = 'draft-version-item';
      el.style.cssText = 'flex-direction:column;align-items:stretch;';
      el.id = 'cd-thread-' + encodeURIComponent(t.thread_id).replace(/%/g, '_');
      el.innerHTML = '<div class="draft-activity-time">Loading…</div>';
      pane.appendChild(el);
      renderContactThread(t, el);
    }
    if (focusThread) {
      const id = 'cd-thread-' + encodeURIComponent(focusThread).replace(/%/g, '_');
      setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 700);
    }
  } catch (e) {
    pane.innerHTML = '<div class="draft-activity-time">Could not load conversation 无法加载会话</div>';
  }
}

async function renderContactThread(t, el) {
  try {
    const d = await getJSON('/api/threads/' + encodeURIComponent(t.thread_id));
    const msgs = d.messages || [], reps = d.replies || [];
    const subject = (msgs.find((m) => m.subject) || {}).subject || '(no subject 无主题)';
    const last = msgs[msgs.length - 1] || {};
    // Sent and received interleaved by time: a thread is one conversation,
    // not a list of outbound messages beside a list of inbound ones.
    const items = msgs.map((m) => ({ t: m.sent_at || m.created_at, kind: 'sent', m }))
      .concat(reps.map((r) => ({ t: r.received_at, kind: 'reply', r })))
      .sort((a, b) => new Date(a.t) - new Date(b.t));

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;">
        <strong>${escapeHtml(subject)}</strong>
        <span class="draft-activity-time">${msgs.length} msg${msgs.length !== 1 ? 's' : ''}${reps.length ? ` · ${reps.length} repl${reps.length !== 1 ? 'ies' : 'y'}` : ''}</span>
      </div>
      ${items.map((it) => it.kind === 'sent' ? `
        <div style="border-top:1px solid #f1f5f9;padding:8px 0;margin-top:6px;">
          <div style="display:flex;justify-content:space-between;font-size:.78rem;">
            <span><b>${escapeHtml(it.m.from_name || it.m.from_email || 'You')}</b>
              <span class="draft-status-badge ${it.m.sent_at ? 'status-approved' : 'status-pending'}">${it.m.sent_at ? 'sent 已发送' : 'draft 草稿'}</span></span>
            <span class="draft-activity-time">${escapeHtml(mailWhen(it.t))}</span>
          </div>
          <div style="font-size:.74rem;color:#64748b;">To: ${escapeHtml(it.m.to_email || '')}${it.m.cc ? ` · Cc: ${escapeHtml(it.m.cc)}` : ''}</div>
          <div style="font-size:.82rem;white-space:pre-wrap;margin-top:5px;line-height:1.5;">${escapeHtml(it.m.body || '')}</div>
          ${it.m.attachment_count ? `<div style="font-size:.72rem;color:#475569;margin-top:4px;">📎 ${it.m.attachment_count} attachment${it.m.attachment_count !== 1 ? 's' : ''} 附件</div>` : ''}
        </div>` : `
        <div style="border-top:1px solid #f1f5f9;padding:8px;margin-top:6px;background:#f8fafc;border-radius:6px;">
          <div style="display:flex;justify-content:space-between;font-size:.78rem;">
            <span><b>${escapeHtml(it.r.from_name || it.r.from_email)}</b>
              <span class="draft-status-badge status-approved">reply 回复</span></span>
            <span class="draft-activity-time">${escapeHtml(mailWhen(it.t))}</span>
          </div>
          <div style="font-size:.82rem;margin-top:5px;">${escapeHtml(it.r.snippet || '')}</div>
          <div style="font-size:.7rem;color:#94a3b8;margin-top:3px;">Preview only — full message is in your mailbox 仅预览</div>
        </div>`).join('')}
      <div style="display:flex;gap:6px;margin-top:8px;">
        <button class="btn-sm btn-primary" data-tmail="reply">↩ Reply 回复</button>
        <button class="btn-sm btn-ghost" data-tmail="replyAll">↩↩ Reply All 全部回复</button>
        <button class="btn-sm btn-ghost" data-tmail="forward">➡ Forward 转发</button>
      </div>`;
    el.querySelectorAll('[data-tmail]').forEach((b) =>
      b.addEventListener('click', () => mailComposeFrom(b.dataset.tmail, last, reps, subject)));
    refreshReplyBadge();
  } catch (e) {
    el.innerHTML = '<div class="draft-activity-time">Could not load this thread 无法加载</div>';
  }
}

/* Reply / Reply All / Forward reuse the existing composer rather than
   introducing a second editor with its own quirks. */
function mailComposeFrom(mode, lastMsg, replies, subject) {
  const lastReply = replies && replies.length ? replies[replies.length - 1] : null;
  const to = mode === 'forward' ? '' : (lastReply && lastReply.from_email) || lastMsg.to_email || '';
  const cc = mode === 'replyAll' ? (lastMsg.cc || '') : '';
  const subj = String(subject || '').replace(/^((RE|FW):\s*)+/i, '');
  const quoted = '\n\n----- ' + (mode === 'forward' ? 'Forwarded message' : 'Original message') + ' -----\n'
    + (lastReply ? `From: ${lastReply.from_email}\n${lastReply.snippet || ''}`
                 : `To: ${lastMsg.to_email || ''}\n${lastMsg.body || ''}`);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('email-to', to); set('email-cc', cc);
  set('email-subject', (mode === 'forward' ? 'FW: ' : 'RE: ') + subj);
  set('email-body', quoted);
  openModal('email-modal');
}
