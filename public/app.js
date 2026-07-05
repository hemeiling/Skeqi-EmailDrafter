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
    }
  } catch (e) { /* silent */ }
}

let _senderSaveTimeout = null;
function saveSender() {
  _sender.name    = document.getElementById("sender-name").value.trim();
  _sender.title   = document.getElementById("sender-title").value.trim();
  _sender.company = document.getElementById("sender-company").value.trim();
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
  const forceRefresh = document.getElementById("force-refresh")?.checked || false;

  for (const company of selected) {
    label.textContent = `Searching ${done + 1} / ${total}: ${company.english_name}…`;
    fill.style.width = Math.round((done / total) * 100) + "%";
    try {
      const r = await fetch("/api/leads/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companies: company.english_name, force: forceRefresh }),
      });
      const d = await r.json();
      if (d.error) {
        allMessages.push(`${company.english_name}: ${d.error}`);
      } else {
        _currentContacts.push(...(d.contacts || []));
        _currentCompanies.push(...(d.companies || [company.english_name]));
        (d.messages || []).forEach(m => allMessages.push(m));
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
      body: JSON.stringify({ companies: company, force: forceRefresh }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { showMessage(d.error || "Search failed.", "error"); return; }

    _currentContacts = d.contacts || [];
    _currentCompanies = d.companies || [company];

    (d.messages || []).forEach(m => showMessage(m, "warn"));

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
  resultsEl.querySelectorAll(".draft-email-btn").forEach(btn => {
    btn.addEventListener("click", () => openEmailDraft(Number(btn.dataset.idx)));
  });
  resultsEl.querySelectorAll(".view-draft-btn").forEach(btn => {
    btn.addEventListener("click", () => openSavedDraft(Number(btn.dataset.idx)));
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
  if (!selected) { alert("Select at least one contact using the checkboxes."); return; }

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
    if (!r.ok) { alert("Export failed: " + r.statusText); return; }
    const blob = await r.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  } catch (e) { alert("Export error: " + e.message); }
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

/* ── Email drafting modal ── */

let _modalContact = null;
let _modalOnUpdate = null;

async function openEmailDraft(idx) {
  const contact = _currentContacts[idx];
  if (!contact) return;
  await openEmailDraftForContact(contact, (d) => {
    _currentContacts[idx].draft_subject   = d.subject   || "";
    _currentContacts[idx].draft_body      = d.body       || "";
    _currentContacts[idx].draft_followup  = d.followup   || "";
    _currentContacts[idx].draft_rationale = d.rationale  || "";
    setDraftActionButton(idx);
  });
}

function setDraftActionButton(idx) {
  const cell = document.getElementById(`draft-action-${idx}`);
  if (!cell) return;
  cell.innerHTML = `<button class="btn-sm btn-saved view-draft-btn" data-idx="${idx}">View Draft</button>`;
  cell.querySelector(".view-draft-btn").addEventListener("click", () => openSavedDraft(idx));
}

function openSavedDraft(idx) {
  const contact = _currentContacts[idx];
  if (!contact) return;
  _modalContact = contact;
  _modalOnUpdate = (d) => {
    _currentContacts[idx].draft_subject   = d.subject   || "";
    _currentContacts[idx].draft_body      = d.body       || "";
    _currentContacts[idx].draft_followup  = d.followup   || "";
    _currentContacts[idx].draft_rationale = d.rationale  || "";
  };
  document.getElementById("modal-title").textContent = `Draft email to ${contact.name}`;
  document.getElementById("modal-contact-info").textContent =
    `${contact.title || ""} · ${contact.company || ""} · ${contact.department || ""}`;
  document.getElementById("modal-mode-select").value = "cold_outreach";
  document.getElementById("modal-extra-instructions").value = "";
  document.getElementById("email-modal").classList.add("open");
  renderDraft({
    subject: contact.draft_subject || "",
    body: contact.draft_body || "",
    followup: contact.draft_followup || "",
    rationale: contact.draft_rationale || "",
    claude_configured: true,
  }, contact);
}

// Generic entry point for drafting an email to any contact -- used by the
// search-results table AND the CRM browser. onUpdate(draft) is called after
// each successful draft so the caller can persist the result locally.
async function openEmailDraftForContact(contact, onUpdate) {
  _modalContact = contact;
  _modalOnUpdate = onUpdate || null;
  document.getElementById("modal-title").textContent = `Draft email to ${contact.name}`;
  document.getElementById("modal-contact-info").textContent =
    `${contact.title || ""} · ${contact.company || ""} · ${contact.department || ""}`;
  document.getElementById("modal-mode-select").value = "cold_outreach";
  document.getElementById("modal-extra-instructions").value = "";
  document.getElementById("email-modal").classList.add("open");
  await requestDraft(contact, "cold_outreach", "");
}

async function requestDraft(contact, mode, extraInstructions) {
  document.getElementById("modal-body").innerHTML = `
    <div style="text-align:center;padding:32px 0;">
      <span class="spinner"></span> Generating personalised email draft with Claude…
    </div>`;
  try {
    const r = await fetch("/api/draft-email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact, sender: _sender, contactId: contact.contact_id, companyKey: contact.company,
        mode, extraInstructions,
      }),
    });
    const d = await r.json();
    renderDraft(d, contact);
    if (_modalOnUpdate) _modalOnUpdate(d);
    refreshUsage();
  } catch (e) {
    document.getElementById("modal-body").innerHTML =
      `<div class="msg-error">Network error: ${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById("modal-regenerate-btn").addEventListener("click", () => {
  if (!_modalContact) return;
  const mode = document.getElementById("modal-mode-select").value;
  const extra = document.getElementById("modal-extra-instructions").value.trim();
  requestDraft(_modalContact, mode, extra);
});

async function loadDraftModes() {
  try {
    const r = await fetch("/api/draft-modes");
    const d = await r.json();
    const optionsHtml = (d.modes || []).map(m => `<option value="${m.value}">${escapeHtml(m.label)}</option>`).join("");
    document.getElementById("crm-mode-select").innerHTML = optionsHtml;
    document.getElementById("modal-mode-select").innerHTML = optionsHtml;
  } catch (e) { /* silent */ }
}

function renderDraft(d, contact) {
  const note = !d.claude_configured
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
  }).catch(() => alert("Copy failed — please select and copy manually."));
}

function exportDraftText(text, name) {
  downloadFile(text, (name || "draft").replace(/\s+/g, "_") + "_email.txt", "text/plain");
}

function exportDraftJson(jsonStr, name) {
  try {
    const obj = JSON.parse(jsonStr);
    downloadFile(JSON.stringify(obj, null, 2), (name || "draft").replace(/\s+/g, "_") + "_email.json", "application/json");
  } catch (e) { alert("JSON export error: " + e.message); }
}

function closeEmailModal() { document.getElementById("email-modal").classList.remove("open"); }
document.getElementById("email-modal-close").addEventListener("click", closeEmailModal);
document.getElementById("email-modal").addEventListener("click", e => {
  if (e.target === document.getElementById("email-modal")) closeEmailModal();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeEmailModal();
    closeScanModal();
  }
});

/* ── Auto-process: reveal emails + draft for all contacts ── */

async function autoProcessContacts() {
  const total = _currentContacts.length;
  if (!total) return;

  const prog  = document.getElementById("batch-progress");
  const fill  = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");
  prog.style.display = "block";

  const revealable = _currentContacts
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.has_email && (!c.email || c.email.startsWith("(")));

  for (let r = 0; r < revealable.length; r++) {
    const { c, i } = revealable[r];
    label.textContent = `Revealing emails… ${r + 1} / ${revealable.length}`;
    fill.style.width = Math.round((r / (revealable.length + total)) * 100) + "%";
    if (!c.apollo_id && !c.contact_id) continue;
    try {
      let d;
      if (c.contact_id) {
        const resp = await fetch(`/api/contacts/${c.contact_id}/enrich-email`, {
          method: "POST", headers: { "Content-Type": "application/json" },
        });
        d = await resp.json();
      } else {
        const resp = await fetch("/api/reveal-email", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apollo_id: c.apollo_id }),
        });
        d = await resp.json();
      }
      if (d.email && !d.email.startsWith("(")) _currentContacts[i].email = d.email;
    } catch (e) { /* skip */ }
  }

  renderContacts(_currentContacts, _currentCompanies.join(", "));
  renderExportBar(_currentCompanies[0]);

  const needDraft = _currentContacts
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !c.draft_subject);
  const skipped = total - needDraft.length;

  for (let d = 0; d < needDraft.length; d++) {
    const { c, i } = needDraft[d];
    label.textContent = `Drafting emails… ${d + 1} / ${needDraft.length}${skipped ? ` (${skipped} loaded from cache)` : ""}`;
    fill.style.width = Math.round(((revealable.length + d) / (revealable.length + needDraft.length)) * 100) + "%";
    try {
      const resp = await fetch("/api/draft-email", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: c, sender: _sender, contactId: c.contact_id, companyKey: c.company }),
      });
      const data = await resp.json();
      _currentContacts[i].draft_subject   = data.subject   || "";
      _currentContacts[i].draft_body      = data.body       || "";
      _currentContacts[i].draft_followup  = data.followup   || "";
      _currentContacts[i].draft_rationale = data.rationale  || "";
    } catch (e) { /* skip */ }
  }

  fill.style.width = "100%";
  const draftMsg = needDraft.length
    ? `${needDraft.length} new draft${needDraft.length !== 1 ? "s" : ""} generated`
    : "all drafts loaded from cache";
  const cacheMsg = skipped ? `, ${skipped} reused from cache (no Claude tokens used)` : "";
  label.textContent = `Done — ${draftMsg}${cacheMsg}. Download Excel/CSV to see all.`;
  renderContacts(_currentContacts, _currentCompanies.join(", "));
  if (_currentCompanies[0]) renderExportBar(_currentCompanies[0]);
  setTimeout(() => { prog.style.display = "none"; }, 4000);
  refreshUsage();
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
  scanModal.classList.add("open");
});
document.getElementById("scan-modal-close").addEventListener("click", closeScanModal);
scanModal.addEventListener("click", e => { if (e.target === scanModal) closeScanModal(); });

function closeScanModal() {
  scanModal.classList.remove("open");
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

async function loadCrmContacts(query, filters) {
  try {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (filters) {
      Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    }
    const url = "/api/contacts" + (params.toString() ? "?" + params.toString() : "");
    const r = await fetch(url);
    const d = await r.json();
    _crmContacts = d.contacts || [];
    _crmPage = 1;
    renderCrmTable(_crmContacts);
    renderCrmSidebar(_crmContacts);
  } catch (e) { /* silent */ }
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
  loadCrmContacts(document.getElementById("crm-search-input").value);
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

  document.getElementById("crm-tbody").innerHTML = pageSlice.map((c, pi) => {
    const i = pageStart + pi;  // index into _crmContacts
    const hasDraft = c.has_draft || Boolean(c.draft_subject);
    const draftCount = Number(c.draft_count) || 0;
    const draftStatus = !hasDraft
      ? `<span style="font-size:0.72rem;color:#9ca3af;">No draft</span>`
      : draftCount > 1
        ? `<span style="font-size:0.72rem;color:#16a34a;font-weight:500;">${draftCount} drafts</span>`
        : `<span style="font-size:0.72rem;color:#16a34a;font-weight:500;">Saved</span>`;
    const emailCell = c.email
      ? `<span style="font-size:0.76rem;">${escapeHtml(c.email)}</span>`
      : c.apollo_person_id
        ? `<button class="btn-sm btn-ghost crm-enrich-btn" data-idx="${i}" style="font-size:11px;padding:2px 6px;">Enrich Email</button>`
        : `<span style="color:#9ca3af;font-size:0.76rem;">N/A</span>`;
    return `<tr>
      <td class="col-check"><input type="checkbox" class="crm-check" data-idx="${i}"></td>
      <td>${escapeHtml(c.full_name || "Unnamed")}</td>
      <td>${escapeHtml(c.job_title || "")}</td>
      <td>${escapeHtml(c.company || "")}</td>
      <td id="crm-email-cell-${i}">${emailCell}</td>
      <td><span class="badge badge-source">${escapeHtml(c.source || "manual")}</span></td>
      <td><input type="text" class="crm-tags-input" data-id="${c.id}" value="${escapeAttr(c.tags || "")}"
            style="width:100px;font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;" placeholder="tags…"></td>
      <td>
        <select class="crm-status-select" data-id="${c.id}" style="font-size:12px;padding:3px 4px;border:1px solid #d1d5db;border-radius:4px;">
          ${FOLLOW_UP_STATUSES.map(s => `<option value="${s}" ${c.follow_up_status === s ? "selected" : ""}>${s.replace(/_/g, " ")}</option>`).join("")}
        </select>
      </td>
      <td style="font-size:0.76rem;color:#888;">${c.last_contacted_at ? escapeHtml(c.last_contacted_at) : "—"}</td>
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
  document.querySelectorAll(".crm-draft-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      openEmailDraftForContact(crmRowToDraftFormat(_crmContacts[idx]), (d) => {
        _crmContacts[idx].draft_subject   = d.subject   || "";
        _crmContacts[idx].draft_body      = d.body       || "";
        _crmContacts[idx].draft_followup  = d.followup   || "";
        _crmContacts[idx].draft_rationale = d.rationale  || "";
        setCrmDraftButtons(idx);
      });
    });
  });
  document.querySelectorAll(".crm-view-draft-btn").forEach(btn => {
    btn.addEventListener("click", () => openSavedCrmDraft(Number(btn.dataset.idx)));
  });
  document.querySelectorAll(".crm-redraft-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      openEmailDraftForContact(crmRowToDraftFormat(_crmContacts[idx]), (d) => {
        _crmContacts[idx].draft_subject   = d.subject   || "";
        _crmContacts[idx].draft_body      = d.body       || "";
        _crmContacts[idx].draft_followup  = d.followup   || "";
        _crmContacts[idx].draft_rationale = d.rationale  || "";
        setCrmDraftButtons(idx);
      });
    });
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
    if (_crmPage > 1) { _crmPage--; renderCrmTable(_crmContacts); }
  });
  document.getElementById("crm-next-btn").addEventListener("click", () => {
    if (_crmPage < totalPages) { _crmPage++; renderCrmTable(_crmContacts); }
  });
}

function renderCrmSidebar(contacts) {
  const companies = [...new Set(contacts.map(c => c.company).filter(Boolean))].sort().slice(0, 40);
  const recentContacts = contacts.slice(0, 35);

  const companiesEl = document.getElementById("crm-sidebar-companies");
  if (companiesEl) {
    companiesEl.innerHTML = companies.length
      ? companies.map(name => `<div class="crm-sb-item" data-val="${escapeAttr(name)}">${escapeHtml(name)}</div>`).join("")
      : `<div style="font-size:0.73rem;color:#9ca3af;padding:4px 6px;">No companies yet</div>`;
    companiesEl.querySelectorAll(".crm-sb-item").forEach(el => {
      el.addEventListener("click", () => {
        document.getElementById("crm-search-input").value = el.dataset.val;
        loadCrmContacts(el.dataset.val);
      });
    });
  }

  const contactsEl = document.getElementById("crm-sidebar-contacts");
  if (contactsEl) {
    contactsEl.innerHTML = recentContacts.length
      ? recentContacts.map(c => `<div class="crm-sb-item crm-sb-contact-item" data-val="${escapeAttr(c.full_name || "")}">
          <div style="font-size:0.75rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.full_name || "Unnamed")}</div>
          <div style="font-size:0.7rem;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.company || "")}</div>
        </div>`).join("")
      : `<div style="font-size:0.73rem;color:#9ca3af;padding:4px 6px;">No contacts yet</div>`;
    contactsEl.querySelectorAll(".crm-sb-contact-item").forEach(el => {
      el.addEventListener("click", () => {
        document.getElementById("crm-search-input").value = el.dataset.val;
        loadCrmContacts(el.dataset.val);
      });
    });
  }

  const searchEl = document.getElementById("crm-sidebar-search");
  if (searchEl) {
    searchEl.oninput = function () {
      const term = this.value.toLowerCase();
      document.querySelectorAll("#crm-sidebar-companies .crm-sb-item, #crm-sidebar-contacts .crm-sb-item").forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(term) ? "" : "none";
      });
    };
  }
}

function crmRowToDraftFormat(c) {
  return {
    name: c.full_name, title: c.job_title, company: c.company, department: c.department,
    email: c.email, linkedin: c.linkedin_url, contact_id: c.id, apollo_id: c.apollo_person_id,
  };
}

function openSavedCrmDraft(idx) {
  const c = _crmContacts[idx];
  if (!c) return;
  const contact = crmRowToDraftFormat(c);
  _modalContact = contact;
  _modalOnUpdate = (d) => {
    _crmContacts[idx].draft_subject   = d.subject   || "";
    _crmContacts[idx].draft_body      = d.body       || "";
    _crmContacts[idx].draft_followup  = d.followup   || "";
    _crmContacts[idx].draft_rationale = d.rationale  || "";
  };
  document.getElementById("modal-title").textContent = `Draft email to ${contact.name || "contact"}`;
  document.getElementById("modal-contact-info").textContent =
    `${c.job_title || ""} · ${c.company || ""} · ${c.department || ""}`;
  document.getElementById("modal-mode-select").value = "cold_outreach";
  document.getElementById("modal-extra-instructions").value = "";
  document.getElementById("email-modal").classList.add("open");
  renderDraft({
    subject: c.draft_subject || "",
    body: c.draft_body || "",
    followup: c.draft_followup || "",
    rationale: c.draft_rationale || "",
    claude_configured: true,
  }, contact);
}

function setCrmDraftButtons(idx) {
  const cell = document.getElementById(`crm-action-${idx}`);
  if (!cell) return;
  cell.innerHTML = `
    <button class="btn-sm btn-saved crm-view-draft-btn" data-idx="${idx}">View Draft</button>
    <button class="btn-sm btn-orange crm-redraft-btn" data-idx="${idx}">Redraft</button>
    <button class="btn-sm btn-ghost crm-details-btn" data-idx="${idx}">Details</button>`;
  cell.querySelector(".crm-view-draft-btn").addEventListener("click", () => openSavedCrmDraft(idx));
  cell.querySelector(".crm-redraft-btn").addEventListener("click", () => {
    openEmailDraftForContact(crmRowToDraftFormat(_crmContacts[idx]), (d) => {
      _crmContacts[idx].draft_subject   = d.subject   || "";
      _crmContacts[idx].draft_body      = d.body       || "";
      _crmContacts[idx].draft_followup  = d.followup   || "";
      _crmContacts[idx].draft_rationale = d.rationale  || "";
      _crmContacts[idx].draft_count     = (_crmContacts[idx].draft_count || 0) + 1;
      setCrmDraftButtons(idx);
    });
  });
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

  const historyEl = document.getElementById("cd-draft-history");
  if (historyEl) {
    historyEl.innerHTML = `<span style="font-size:0.73rem;color:#9ca3af;">Loading…</span>`;
    try {
      const r = await fetch(`/api/contacts/${c.id}/drafts`);
      const data = await r.json();
      const drafts = (data.drafts || []).slice(0, 10);
      if (!drafts.length) {
        historyEl.innerHTML = `<span style="font-size:0.73rem;color:#9ca3af;">No drafts saved yet</span>`;
      } else {
        historyEl.innerHTML = drafts.map(d => `
          <div style="border:1px solid #e5e7eb;border-radius:5px;padding:6px 10px;margin-bottom:5px;cursor:pointer;background:#fff;" class="cd-draft-row"
               data-subject="${escapeAttr(d.subject || "")}" data-body="${escapeAttr(d.body || "")}">
            <div style="font-size:0.75rem;font-weight:500;color:#374151;">v${d.version}: ${escapeHtml(d.subject || "(no subject)")}</div>
            <div style="font-size:0.7rem;color:#9ca3af;">${new Date(d.created_at).toLocaleDateString()}</div>
          </div>`).join("");
        historyEl.querySelectorAll(".cd-draft-row").forEach(row => {
          row.addEventListener("click", () => {
            const contact = crmRowToDraftFormat(c);
            _modalContact = contact;
            _modalOnUpdate = null;
            document.getElementById("modal-title").textContent = `Draft email to ${contact.name || "contact"}`;
            document.getElementById("modal-contact-info").textContent = `${c.job_title || ""} · ${c.company || ""}`;
            document.getElementById("modal-mode-select").value = "cold_outreach";
            document.getElementById("modal-extra-instructions").value = "";
            document.getElementById("email-modal").classList.add("open");
            contactDetailModal.classList.remove("open");
            renderDraft({ subject: row.dataset.subject, body: row.dataset.body, followup: "", rationale: "", claude_configured: true }, contact);
          });
        });
      }
    } catch (e) {
      historyEl.innerHTML = `<span style="font-size:0.73rem;color:#9ca3af;">Could not load draft history</span>`;
    }
  }

  document.getElementById("cd-event").value = "";
  document.getElementById("cd-booth").value = c.booth_number || "";
  document.getElementById("cd-date").value = c.meeting_date || "";
  document.getElementById("cd-interest").value = c.interest_level || "";
  document.getElementById("cd-products").value = c.products_discussed || "";
  document.getElementById("cd-meeting-notes").value = c.meeting_notes || "";
  document.getElementById("cd-salesperson").value = c.assigned_salesperson || "";
  contactDetailModal.classList.add("open");
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
      if (cell) cell.innerHTML = `<span style="font-size:0.76rem;">${escapeHtml(d.email)}</span>`;
    } else {
      _crmContacts[idx].email = "";
      if (cell) cell.innerHTML = `<span style="color:#9ca3af;font-size:0.76rem;">N/A</span>`;
    }
    refreshUsage();
  } catch (e) {
    if (cell) cell.innerHTML = `<span style="color:#9ca3af;font-size:0.76rem;">N/A</span>`;
  }
}

document.getElementById("contact-detail-close").addEventListener("click", () => {
  contactDetailModal.classList.remove("open");
});
contactDetailModal.addEventListener("click", (e) => {
  if (e.target === contactDetailModal) contactDetailModal.classList.remove("open");
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
  contactDetailModal.classList.remove("open");
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
document.getElementById("crm-select-all").addEventListener("change", function () {
  document.querySelectorAll(".crm-check").forEach(c => c.checked = this.checked);
});

document.getElementById("crm-bulk-draft-btn").addEventListener("click", async () => {
  const idxs = [];
  document.querySelectorAll(".crm-check:checked").forEach(cb => idxs.push(Number(cb.dataset.idx)));
  if (!idxs.length) { alert("Select at least one contact using the checkboxes."); return; }

  const mode = document.getElementById("crm-mode-select").value;
  const extra = document.getElementById("crm-extra-instructions").value.trim();
  const btn = document.getElementById("crm-bulk-draft-btn");
  btn.disabled = true;

  for (const i of idxs) {
    const c = _crmContacts[i];
    btn.textContent = `Drafting for ${c.full_name}…`;
    try {
      await fetch("/api/draft-email", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact: crmRowToDraftFormat(c), sender: _sender, contactId: c.id, mode, extraInstructions: extra,
        }),
      });
    } catch (e) { /* skip */ }
  }

  btn.disabled = false;
  btn.textContent = "Draft Emails for Selected";
  showMessage(`Drafted emails for ${idxs.length} selected contact(s) -- open "Draft Email" on each to review/edit before sending.`, "info");
  loadCrmContacts(document.getElementById("crm-search-input").value);
  refreshUsage();
});

/* ── Init ── */

loadSenderProfile();
loadDraftModes();
loadCrmContacts();
refreshUsage();
