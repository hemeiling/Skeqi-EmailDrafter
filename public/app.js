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

const APP_VIEW_LABELS = { search: "Search & Scan", crm: "CRM", settings: "Settings" };

function showView(name) {
  if (!APP_VIEW_LABELS[name]) return;
  document.querySelectorAll("[data-view]").forEach((el) => {
    el.classList.toggle("view-hidden", el.dataset.view !== name);
  });
  document.querySelectorAll(".app-nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.navView === name);
  });
  document.getElementById("app-breadcrumb-current").textContent = APP_VIEW_LABELS[name];
  try { localStorage.setItem("app_active_view", name); } catch (e) { /* ignore (private browsing, etc.) */ }
}

function initAppShell() {
  document.querySelectorAll(".app-nav-item").forEach((item) => {
    item.addEventListener("click", () => showView(item.dataset.navView));
  });

  let savedView = "search";
  try { savedView = localStorage.getItem("app_active_view") || "search"; } catch (e) { /* ignore */ }
  showView(APP_VIEW_LABELS[savedView] ? savedView : "search");

  const collapseBtn = document.getElementById("app-sidebar-collapse-btn");
  const collapseIcon = document.getElementById("app-sidebar-collapse-icon");
  function applyCollapsed(collapsed) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    collapseIcon.textContent = collapsed ? "▶" : "◀";
  }
  let savedCollapsed = false;
  try { savedCollapsed = localStorage.getItem("app_sidebar_collapsed") === "true"; } catch (e) { /* ignore */ }
  applyCollapsed(savedCollapsed);
  collapseBtn.addEventListener("click", () => {
    const collapsed = !document.body.classList.contains("sidebar-collapsed");
    applyCollapsed(collapsed);
    try { localStorage.setItem("app_sidebar_collapsed", String(collapsed)); } catch (e) { /* ignore */ }
  });

  // User-profile menu in the top bar mirrors the sender-profile name/company
  // (already tracked in `_sender`) rather than introducing a separate concept.
  document.getElementById("app-user-menu").addEventListener("click", () => showView("settings"));

  document.getElementById("app-global-search").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = e.target.value.trim();
    if (!q) return;
    showView("crm");
    document.getElementById("crm-search-input").value = q;
    loadCrmContacts(q);
  });
}

function updateUserMenuFromSender() {
  const name = (_sender && _sender.name) || "";
  document.getElementById("app-user-menu-name").textContent = name || "Your Profile";
  document.getElementById("app-user-avatar").textContent = name ? name.trim()[0].toUpperCase() : "U";
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
      updateUserMenuFromSender();
    }
  } catch (e) { /* silent */ }
}

let _senderSaveTimeout = null;
function saveSender() {
  _sender.name    = document.getElementById("sender-name").value.trim();
  _sender.title   = document.getElementById("sender-title").value.trim();
  _sender.company = document.getElementById("sender-company").value.trim();
  updateUserMenuFromSender();
  clearTimeout(_senderSaveTimeout);
  _senderSaveTimeout = setTimeout(() => {
    fetch("/api/settings/sender", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_sender),
    }).catch(() => {});
  }, 400);
}
["sender-name", "sender-title", "sender-company"].forEach(id => {
  document.getElementById(id).addEventListener("input", saveSender);
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
    const forceRefresh = document.getElementById("force-refresh")?.checked || false;
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
      <div class="table-empty-state">
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
        <tbody>${rows}</tbody>
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
        <tbody>${rows}</tbody>
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

async function exportSelected(fmt) {
  const selected = getSelectedContacts();
  if (!selected) { showMessage("Select at least one contact using the checkboxes.", "warn"); return; }

  if (fmt === "xlsx") {
    await downloadPostBlob("/api/export-xlsx", { contacts: selected }, "selected_contacts.xlsx");
    return;
  }
  const hasDrafts = selected.some(c => c.draft_subject);
  const draftCols = hasDrafts ? ["draft_subject", "draft_body", "draft_followup", "draft_rationale"] : [];
  let content;
  if (fmt === "json") {
    content = JSON.stringify(selected, null, 2);
    downloadFile(content, "selected_contacts.json", "application/json");
  } else if (fmt === "crm") {
    content = toCsvString(selected, [...CRM_FIELDS, ...draftCols]);
    downloadFile(content, "selected_crm.csv", "text/csv");
  } else {
    content = toCsvString(selected, [...CRM_FIELDS, ...draftCols]);
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

function toCsvString(contacts, fields) {
  const esc = v => {
    const s = String(v == null ? "" : v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [fields.join(","), ...contacts.map(c => fields.map(f => esc(c[f])).join(","))].join("\r\n");
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
  openModal("email-modal");
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
  document.getElementById("modal-body").innerHTML = `
    <div style="text-align:center;padding:32px 0;">
      <span class="spinner"></span> Generating personalised email draft with Claude…
    </div>`;
  try {
    const r = await fetch("/api/draft-email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact, sender: _sender, contactId: contact.contact_id, companyKey: contact.company,
        mode, extraInstructions, regenerate: Boolean(regenerate),
      }),
    });
    const d = await r.json();
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

const DRAFT_STATUS_LABELS = { draft: "Draft", ready_for_review: "Ready for Review", approved: "Approved", archived: "Archived", trash: "Trash" };
const DRAFT_SOURCE_LABELS = { email_draft: "AI Generated", manual_edit: "Manual", manual: "Manual", manual_entry: "Manually Imported", duplicated: "Duplicated", follow_up: "Follow-Up", apollo_search: "AI Generated" };

const DRAFT_ACTION_BAR = {
  draft: [["save", "Save Draft", "btn-orange"], ["ready", "Mark Ready for Review", "btn-ghost"], ["duplicate", "Duplicate", "btn-ghost"], ["trash", "Delete", "btn-danger"]],
  ready_for_review: [["save", "Save Changes", "btn-orange"], ["approve", "Approve", "btn-saved"], ["return_to_draft", "Return to Draft", "btn-ghost"], ["trash", "Delete", "btn-danger"]],
  approved: [["return_to_draft", "Return to Draft", "btn-ghost"], ["archive", "Archive", "btn-ghost"], ["duplicate", "Duplicate", "btn-ghost"], ["followup", "Create Follow-Up", "btn-ghost"]],
  archived: [["restore", "Restore", "btn-saved"], ["duplicate", "Duplicate", "btn-ghost"]],
  trash: [["restore", "Restore", "btn-saved"]],
};

function renderDraftEditor(comm, contact) {
  const status = effectiveDraftStatus(comm);
  const note = comm.claude_configured === false
    ? `<div class="draft-note">⚠ Claude key not set — this is a template stub. Add a Claude key in the Config section for AI-generated drafts.</div>`
    : "";

  document.getElementById("modal-body").innerHTML = `
    ${note}
    <div class="draft-meta-row">
      <div>
        <span class="draft-status-badge status-${status}">${DRAFT_STATUS_LABELS[status] || status}</span>
        <span class="draft-meta-text" style="margin-left:8px;">Source: ${DRAFT_SOURCE_LABELS[comm.source] || comm.source || "AI Generated"}</span>
      </div>
      <div class="draft-meta-text">
        ${comm.created_at ? `Created ${new Date(comm.created_at).toLocaleString()}` : ""}
        ${comm.updated_at && comm.updated_at !== comm.created_at ? ` · Edited ${new Date(comm.updated_at).toLocaleString()}` : ""}
      </div>
    </div>

    <div class="draft-recipient-grid">
      <div><div class="draft-label">Recipient</div><input class="draft-field" id="draft-field-to" value="${escapeAttr(comm.to_email || "")}" placeholder="recipient@example.com"></div>
      <div><div class="draft-label">CC</div><input class="draft-field" id="draft-field-cc" value="${escapeAttr(comm.cc || "")}" placeholder="optional"></div>
    </div>
    <div class="draft-recipient-grid">
      <div><div class="draft-label">BCC</div><input class="draft-field" id="draft-field-bcc" value="${escapeAttr(comm.bcc || "")}" placeholder="optional"></div>
      <div><div class="draft-label">From</div><input class="draft-field" value="${escapeAttr((_sender && _sender.name) || "")}" disabled></div>
    </div>

    <div class="draft-section">
      <div class="draft-label">Subject Line</div>
      <input class="draft-field" id="draft-field-subject" value="${escapeAttr(comm.subject || "")}">
    </div>
    <div class="draft-section">
      <div class="draft-label">Email Body</div>
      <textarea class="draft-field" id="draft-field-body" rows="8">${escapeHtml(comm.body || "")}</textarea>
    </div>
    <div class="draft-section">
      <div class="draft-label">Follow-up Template</div>
      <textarea class="draft-field" id="draft-field-followup" rows="3">${escapeHtml(comm.followup_text || comm.followup || "")}</textarea>
    </div>
    <div class="draft-section">
      <div class="draft-label">Why This Contact</div>
      <div class="draft-value">${escapeHtml(comm.rationale || "")}</div>
    </div>
    <div class="draft-section">
      <div class="draft-label">Internal Notes</div>
      <textarea class="draft-field" id="draft-field-notes" rows="2" placeholder="Notes only your team can see">${escapeHtml(comm.notes || "")}</textarea>
    </div>

    <div class="draft-section">
      <div class="draft-label">Attachments</div>
      <div id="draft-attachment-chips"></div>
      <button class="btn-sm btn-ghost" id="draft-add-attachment-btn" style="margin-top:6px;">+ Add Attachment</button>
      <button class="btn-sm btn-ghost" id="draft-attach-from-library-btn" style="margin-top:6px;">+ From Library</button>
    </div>

    <div class="draft-collapsible-header" id="draft-versions-toggle">Version History <span>▾</span></div>
    <div class="draft-collapsible-body" id="draft-versions-body"></div>

    <div class="draft-collapsible-header" id="draft-activity-toggle">Activity <span>▾</span></div>
    <div class="draft-collapsible-body" id="draft-activity-body"></div>

    <div class="modal-actions" id="draft-lifecycle-actions"></div>
    <div class="modal-actions">
      <button class="btn-sm copy-btn" id="copy-all-btn">Copy Full Draft</button>
      <button class="btn-sm btn-ghost" id="export-draft-txt-btn">Export .txt</button>
      <button class="btn-sm btn-ghost" id="export-draft-json-btn">Export JSON</button>
    </div>`;

  const fullText = `Subject: ${comm.subject}\n\n${comm.body}\n\n---\nFollow-up: ${comm.followup_text || comm.followup}\n\nRationale: ${comm.rationale}`;
  document.getElementById("copy-all-btn").addEventListener("click", () => copyDraft(fullText));
  document.getElementById("export-draft-txt-btn").addEventListener("click", () => exportDraftText(fullText, contact.name));
  document.getElementById("export-draft-json-btn").addEventListener("click", () => exportDraftJson(JSON.stringify(comm), contact.name));

  document.querySelectorAll(".draft-field").forEach((el) => el.addEventListener("input", () => { _modalDirty = true; }));

  renderDraftActionBar(status);
  loadAttachmentChips(comm.id, "draft-attachment-chips");
  document.getElementById("draft-add-attachment-btn").addEventListener("click", () => uploadOneOffAttachmentsTo(comm.id, "draft-attachment-chips"));
  document.getElementById("draft-attach-from-library-btn").addEventListener("click", () => attachFromLibraryTo(comm.id, "draft-attachment-chips"));

  document.getElementById("draft-versions-toggle").addEventListener("click", () =>
    toggleDraftCollapsible("draft-versions-body", () => loadDraftVersionsPanel(contact.contact_id)));
  document.getElementById("draft-activity-toggle").addEventListener("click", () =>
    toggleDraftCollapsible("draft-activity-body", () => loadDraftActivityPanel(contact.contact_id)));
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
  if (body) { body.classList.remove("open"); body.innerHTML = ""; }
}

async function loadImportedEmailsPanel(contactId, mode) {
  const body = document.getElementById("imported-emails-body");
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
    div.innerHTML = `
      <div class="msg-summary-title">Search completed — ${escapeHtml(s.company)}</div>
      <div class="msg-summary-row">${deptLine}</div>
      <div class="msg-summary-stats">
        <span>Contacts found: <b>${s.foundCount}</b></span>
        <span>Imported: <b>${s.importedCount}</b></span>
        <span>Duplicates skipped: <b>${s.duplicatesSkipped}</b></span>
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

async function refreshUsage() {
  try {
    const r = await fetch("/api/usage");
    const d = await r.json();
    document.getElementById("u-apollo-people").textContent = d.apollo_people_calls;
    document.getElementById("u-apollo-org").textContent = d.apollo_org_calls;
    document.getElementById("u-claude-calls").textContent = d.claude_calls;
    document.getElementById("u-claude-in").textContent = d.claude_input_tokens;
    document.getElementById("u-claude-out").textContent = d.claude_output_tokens;
    document.getElementById("u-cost").textContent = "$" + Number(d.claude_cost_usd).toFixed(6);
  } catch (e) { /* silent */ }
}

document.getElementById("usage-reset-btn").addEventListener("click", async () => {
  await fetch("/api/usage/reset", { method: "POST" });
  refreshUsage();
});

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
  modeSingleBtn.style.background = isSingle ? "#2563eb" : "#fff";
  modeSingleBtn.style.color = isSingle ? "#fff" : "#555";
  modeBatchBtn.style.background = isSingle ? "#fff" : "#2563eb";
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
let _crmPage = 1;
const CRM_PAGE_SIZE = 10;

document.getElementById("crm-toggle").addEventListener("click", () => {
  const body = document.getElementById("crm-body");
  const icon = document.getElementById("crm-toggle-icon");
  const hidden = body.style.display === "none";
  body.style.display = hidden ? "" : "none";
  icon.textContent = hidden ? "▼" : "▶";
});

function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// Merged, persistent filter state -- every control (existing filter inputs,
// the Browse-by-Company/Contact selectors, the Clear buttons) updates only
// its own key here so filters combine instead of clobbering each other.
let _crmActiveFilters = {};

async function loadCrmContacts(query, filterPatch) {
  try {
    if (filterPatch) Object.assign(_crmActiveFilters, filterPatch);
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    Object.entries(_crmActiveFilters).forEach(([k, v]) => {
      if (Array.isArray(v)) { if (v.length) params.set(k, v.join(",")); }
      else if (v) { params.set(k, v); }
    });
    const url = "/api/contacts" + (params.toString() ? "?" + params.toString() : "");
    const r = await fetch(url);
    const d = await r.json();
    _crmContacts = d.contacts || [];
    _crmPage = 1;
    renderCrmTable(_crmContacts);
    renderCrmFilterSummary();
    autoEnrichCrmPage();
  } catch (e) { /* silent */ }
}

function renderCrmFilterSummary() {
  const el = document.getElementById("crm-filter-summary");
  if (!el) return;
  const accounts = _crmActiveFilters.accounts || [];
  if (!accounts.length) { el.textContent = ""; return; }
  const scope = accounts.length === 1 ? accounts[0] : `${accounts.length} selected companies (${accounts.join(", ")})`;
  el.textContent = `Showing ${_crmContacts.length} contact${_crmContacts.length !== 1 ? "s" : ""} across ${scope}.`;
}

// Background enrichment for contacts on the current CRM page that have
// an Apollo ID but no email and haven't been checked yet.
async function autoEnrichCrmPage() {
  const pageStart = (_crmPage - 1) * CRM_PAGE_SIZE;
  const pageEnd = Math.min(pageStart + CRM_PAGE_SIZE, _crmContacts.length);
  for (let i = pageStart; i < pageEnd; i++) {
    const c = _crmContacts[i];
    if (!c || c.email || !c.apollo_person_id) continue;
    const status = c.email_lookup_status || 'not_checked';
    if (status === 'not_available' || status === 'found') continue;
    // Fire and update cell in-place — don't block the loop on errors
    (async () => {
      const cell = document.getElementById(`crm-email-cell-${i}`);
      if (cell) cell.innerHTML = `<span style="font-size:0.73rem;color:#6b7280;">Checking…</span>`;
      try {
        const r = await fetch(`/api/contacts/${c.id}/enrich-email`, {
          method: "POST", headers: { "Content-Type": "application/json" },
        });
        const d = await r.json();
        if (d.email && !d.email.startsWith("(")) {
          _crmContacts[i].email = d.email;
          _crmContacts[i].email_lookup_status = 'found';
          if (cell) cell.innerHTML = `<span style="font-size:0.76rem;">${escapeHtml(d.email)}</span>`;
        } else {
          _crmContacts[i].email_lookup_status = d.email_lookup_status || 'not_available';
          if (cell) cell.innerHTML = `<span style="color:#9ca3af;font-size:0.76rem;" title="Apollo confirmed no email">N/A</span>`;
        }
      } catch (_) {
        if (cell) cell.innerHTML = `<span style="color:#9ca3af;font-size:0.76rem;">N/A</span>`;
      }
    })();
  }
}

document.getElementById("crm-apply-filters-btn").addEventListener("click", () => {
  loadCrmContacts(document.getElementById("crm-search-input").value, {
    event: document.getElementById("crm-filter-event").value.trim(),
    industry: document.getElementById("crm-filter-industry").value.trim(),
    follow_up_status: document.getElementById("crm-filter-status").value,
    assigned_salesperson: document.getElementById("crm-filter-owner").value.trim(),
  });
});
document.getElementById("crm-clear-filters-btn").addEventListener("click", () => {
  document.getElementById("crm-filter-event").value = "";
  document.getElementById("crm-filter-industry").value = "";
  document.getElementById("crm-filter-status").value = "";
  document.getElementById("crm-filter-owner").value = "";
  clearAccountSelection();
  clearContactSelection();
  clearDeptSeniorityFilters();
  loadCrmContacts(document.getElementById("crm-search-input").value, {
    event: "", industry: "", follow_up_status: "", assigned_salesperson: "",
    accounts: [], contact_ids: [], department_categories: [], seniority_levels: [],
  });
});

const FOLLOW_UP_STATUSES = ["not_contacted", "contacted", "replied", "meeting_scheduled", "closed"];

function renderCrmTable(contacts) {
  const total = contacts.length;
  const totalPages = Math.max(1, Math.ceil(total / CRM_PAGE_SIZE));
  if (_crmPage > totalPages) _crmPage = totalPages;

  const pageStart = (_crmPage - 1) * CRM_PAGE_SIZE;
  const pageEnd   = Math.min(pageStart + CRM_PAGE_SIZE, total);
  const pageSlice = contacts.slice(pageStart, pageEnd);

  document.getElementById("crm-count").textContent =
    `${total} contact${total !== 1 ? "s" : ""} in your CRM`;

  if (!total) {
    document.getElementById("crm-tbody").innerHTML = `
      <tr><td colspan="13">
        <div class="table-empty-state">
          <div class="tes-icon">🗂️</div>
          <div class="tes-title">No contacts yet</div>
          <div class="tes-hint">Search a company above or click "+ Add Contact" to start building your CRM.</div>
        </div>
      </td></tr>`;
    document.getElementById("crm-pagination").innerHTML = "";
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
    const emailStatus = c.email_lookup_status || (c.email ? 'found' : 'not_checked');
    const emailCell = c.email
      ? `<span style="font-size:0.76rem;">${escapeHtml(c.email)}</span>`
      : emailStatus === 'not_available'
        ? `<span style="color:#9ca3af;font-size:0.76rem;" title="Apollo confirmed no email">N/A</span>`
        : c.apollo_person_id && emailStatus === 'not_checked'
          ? `<button class="btn-sm btn-ghost crm-enrich-btn" data-idx="${i}" style="font-size:11px;padding:2px 6px;">Enrich Email</button>`
          : `<span style="color:#9ca3af;font-size:0.76rem;">N/A</span>`;
    const commCount = Number(c.comm_count) || 0;
    const commDraftCount = Number(c.comm_draft_count) || 0;
    const lastActivity = c.last_comm_at
      ? new Date(c.last_comm_at).toLocaleDateString()
      : c.last_contacted_at || "—";
    const lastType = c.last_comm_type
      ? `<span style="font-size:0.65rem;color:#6b7280;margin-left:3px;">${c.last_comm_type.replace(/_/g," ")}</span>`
      : "";
    const interactionCell = commCount
      ? `<span style="font-size:0.75rem;">${commCount} <span style="color:#9ca3af;">(${commDraftCount}d)</span></span>`
      : `<span style="font-size:0.73rem;color:#9ca3af;">—</span>`;
    return `<tr>
      <td class="col-check"><input type="checkbox" class="crm-check" data-idx="${i}"></td>
      <td>${escapeHtml(c.full_name || "Unnamed")}</td>
      <td>${escapeHtml(c.job_title || "")}</td>
      <td>${escapeHtml(c.company || "")}</td>
      <td id="crm-email-cell-${i}">${emailCell}</td>
      <td style="font-size:0.76rem;color:#374151;">${escapeHtml(c.phone || "")}</td>
      <td style="font-size:0.76rem;color:#374151;">${lastActivity}${lastType}</td>
      <td>${interactionCell}</td>
      <td><span class="badge badge-source">${escapeHtml(c.source || "manual")}</span></td>
      <td><input type="text" class="crm-tags-input" data-id="${c.id}" value="${escapeAttr(c.tags || "")}"
            style="width:100px;font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;" placeholder="tags…"></td>
      <td>
        <select class="crm-status-select" data-id="${c.id}" style="font-size:12px;padding:3px 4px;border:1px solid #d1d5db;border-radius:4px;">
          ${FOLLOW_UP_STATUSES.map(s => `<option value="${s}" ${c.follow_up_status === s ? "selected" : ""}>${s.replace(/_/g, " ")}</option>`).join("")}
        </select>
      </td>
      <td id="crm-draft-status-${i}">${draftStatus}</td>
      <td id="crm-action-${i}">
        ${hasDraft
          ? `<button class="btn-sm btn-saved crm-view-draft-btn" data-idx="${i}">View Draft</button>
             <button class="btn-sm btn-orange crm-redraft-btn" data-idx="${i}">Redraft</button>`
          : `<button class="btn-sm btn-primary crm-draft-btn" data-idx="${i}">Draft Email</button>`}
        <button class="btn-sm btn-ghost crm-details-btn" data-idx="${i}">Details</button>
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
  if (totalPages <= 1) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <button class="btn-sm btn-ghost" id="crm-prev-btn" ${_crmPage <= 1 ? "disabled" : ""}>← Prev</button>
    <span style="font-size:0.85rem;color:#555;">Page ${_crmPage} of ${totalPages}</span>
    <button class="btn-sm btn-ghost" id="crm-next-btn" ${_crmPage >= totalPages ? "disabled" : ""}>Next →</button>`;
  document.getElementById("crm-prev-btn").addEventListener("click", () => {
    if (_crmPage > 1) { _crmPage--; renderCrmTable(_crmContacts); autoEnrichCrmPage(); }
  });
  document.getElementById("crm-next-btn").addEventListener("click", () => {
    if (_crmPage < totalPages) { _crmPage++; renderCrmTable(_crmContacts); autoEnrichCrmPage(); }
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

const accountSelect = createMultiSelect({
  inputId: "crm-sel-account-input", dropdownId: "crm-sel-account-dropdown",
  chipsId: "crm-sel-account-chips", clearAllId: "crm-sel-account-clearall",
  getItems: () => _accountOptions,
  keyOf: (it) => it.name,
  matchText: (it) => it.name || "",
  renderOptionLabel: (it) => `${escapeHtml(it.name)} <span class="crm-sel-sub">(${it.contact_count})</span>`,
  renderChipLabel: (it) => it.name,
  onChange: (items) => {
    loadCrmContacts(document.getElementById("crm-search-input").value, { accounts: items.map((it) => it.name) });
    _selectedAccountsForMerge = items;
    document.getElementById("crm-merge-accounts-btn").style.display = items.length >= 2 ? "" : "none";
  },
});

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

const contactSelect = createMultiSelect({
  inputId: "crm-sel-contact-input", dropdownId: "crm-sel-contact-dropdown",
  chipsId: "crm-sel-contact-chips", clearAllId: "crm-sel-contact-clearall",
  getItems: () => _contactOptions,
  keyOf: (it) => it.id,
  matchText: (it) => `${it.full_name || ""} ${it.company || ""}`,
  renderOptionLabel: (it) => `${escapeHtml(it.full_name || "Unnamed")}<br><span class="crm-sel-sub">${escapeHtml(it.company || "")}</span>`,
  renderChipLabel: (it) => `${it.full_name || "Unnamed"}${it.company ? " — " + it.company : ""}`,
  onChange: (items) => {
    loadCrmContacts(document.getElementById("crm-search-input").value, { contact_ids: items.map((it) => it.id) });
  },
});

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

function clearAccountSelection() { if (accountSelect) accountSelect.clearAll(); }
function clearContactSelection() { if (contactSelect) contactSelect.clearAll(); }
function clearDeptSeniorityFilters() {
  if (deptSelect) deptSelect.clearAll();
  if (senioritySelect) senioritySelect.clearAll();
}

async function loadBrowseSelectors() {
  try {
    const [accRes, contactRes] = await Promise.all([
      fetch("/api/accounts/grouped"), fetch("/api/contacts/names"),
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
  await openDraftModalForContact(crmRowToDraftFormat(c), () => {
    loadCrmContacts(document.getElementById("crm-search-input").value);
  }, options);
}

function setCrmDraftButtons(idx) {
  const cell = document.getElementById(`crm-action-${idx}`);
  if (!cell) return;
  cell.innerHTML = `
    <button class="btn-sm btn-saved crm-view-draft-btn" data-idx="${idx}">View Draft</button>
    <button class="btn-sm btn-orange crm-redraft-btn" data-idx="${idx}">Redraft</button>
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
    emailEl.textContent = c.email || "No email saved";
    emailEl.style.color = c.email ? "#374151" : "#9ca3af";
  }

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

async function enrichCrmEmail(idx) {
  const c = _crmContacts[idx];
  if (!c || !c.id) return;
  const cell = document.getElementById(`crm-email-cell-${idx}`);
  if (cell) cell.innerHTML = `<span style="font-size:0.73rem;color:#6b7280;">Enriching…</span>`;
  try {
    // Smart endpoint: checks stored apollo_raw_json first (free), then reveal API
    const r = await fetch(`/api/contacts/${c.id}/enrich-email`, {
      method: "POST", headers: { "Content-Type": "application/json" },
    });
    const d = await r.json();
    if (d.email && !d.email.startsWith("(")) {
      _crmContacts[idx].email = d.email;
      _crmContacts[idx].email_lookup_status = 'found';
      if (cell) cell.innerHTML = `<span style="font-size:0.76rem;">${escapeHtml(d.email)}</span>`;
    } else {
      _crmContacts[idx].email = "";
      _crmContacts[idx].email_lookup_status = d.email_lookup_status || 'not_available';
      if (cell) cell.innerHTML = `<span style="color:#9ca3af;font-size:0.76rem;" title="Apollo confirmed no email">N/A</span>`;
    }
    refreshUsage();
  } catch (e) {
    if (cell) cell.innerHTML = `<span style="color:#9ca3af;font-size:0.76rem;">N/A</span>`;
  }
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

document.getElementById("crm-search-input").addEventListener("input", debounce(function () {
  loadCrmContacts(this.value);
}, 300));
document.getElementById("crm-refresh-btn").addEventListener("click", () => {
  loadCrmContacts(document.getElementById("crm-search-input").value);
});
function getCheckedCrmIdxs() {
  const idxs = [];
  document.querySelectorAll(".crm-check:checked").forEach(cb => idxs.push(Number(cb.dataset.idx)));
  return idxs;
}

function updateCrmSelectionUI() {
  const count = getCheckedCrmIdxs().length;
  document.getElementById("crm-bulk-draft-btn").disabled = count === 0;
  document.getElementById("crm-bulk-delete-btn").disabled = count === 0;
  document.getElementById("crm-selected-count").textContent = count ? `${count} selected` : "";
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

/* ── Init ── */

initAppShell();
loadSenderProfile();
loadDraftModes();
loadCrmContacts();
loadBrowseSelectors();
loadSearchTaxonomy();
refreshUsage();

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
      matchedEl.style.color = d.review_needed ? "#ea580c" : "#111827";
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
