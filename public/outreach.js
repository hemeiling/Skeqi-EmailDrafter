/* ══════════════════════════════════════════════════════════════════════
   Exhibitor Outreach · 展商拓展

   One row per exhibitor; contacts load on demand underneath it. Every
   number comes from /api/outreach/*, which derives it from the canonical
   rows — this file never computes a status of its own, so the table, the
   KPIs and the export cannot disagree.

   Drafting goes through the existing Email Drafter modal
   (openDraftModalForContact in app.js). There is no second generator here.

   Failure is never shown as emptiness: a failed request renders an error
   with Retry, and the previous rows stay on screen until new ones arrive.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const PAGE_SIZE = 50;

  const CLASS_LABELS = {
    target_customer: "Target customer", competitor_direct: "Direct competitor",
    competitor_indirect: "Indirect competitor", ess_ev: "ESS / EV project", chinese_company: "Chinese company",
    customer: "Customer", batmat: "Battery materials", elec: "Electrical", competitor: "Competitor",
    other: "Other", none: "Unclassified",
  };
  const STATUS = {
    unmatched:         { label: "Unmatched",   cls: "xo-st-grey",   hint: "No CRM company linked to this exhibitor yet" },
    no_contact:        { label: "No contact",  cls: "xo-st-grey",   hint: "Company is in the CRM but has no contacts" },
    no_email:          { label: "No email",    cls: "xo-st-amber",  hint: "Contacts exist but none has a usable email" },
    needs_draft:       { label: "Needs draft", cls: "xo-st-purple", hint: "At least one contact can be emailed; nothing drafted or sent" },
    drafted:           { label: "Drafted",     cls: "xo-st-blue",   hint: "At least one draft is waiting to be sent" },
    contacted_partial: { label: "Contacted",   cls: "xo-st-green-l", hint: "Some, not all, emailable contacts have been sent to" },
    contacted_all:     { label: "Contacted",   cls: "xo-st-green",  hint: "Every emailable contact has been sent to" },
  };
  const CONTACT_STATUS = {
    sent: { label: "Sent", cls: "xo-st-green" },
    drafted: { label: "Drafted", cls: "xo-st-blue" },
    no_draft: { label: "No draft", cls: "xo-st-purple" },
    email_locked: { label: "Email locked", cls: "xo-st-amber" },
    no_email: { label: "No email", cls: "xo-st-grey" },
  };

  const state = {
    initialised: false,
    filters: { q: "", booth: "", classification: "", has_contacts: "", has_email: "", drafted: "", sent: "",
      status: "", include_withdrawn: false, sort: "company", exhibitor: "" },
    page: 1,
    total: 0,
    rows: [],
    expanded: new Set(),
    details: new Map(),       // exhibitor_id → { loading, error, data }
    listSeq: 0,
    summarySeq: 0,
    facets: null,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escapeHtml === "function" ? escapeHtml(s == null ? "" : String(s))
    : String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const fmtDate = (v) => {
    if (!v) return "";
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  };
  const today = () => new Date().toISOString().slice(0, 10);
  /* i18n.js localises new DOM from a MutationObserver, but ignores mutations
     that land while its own pass is running — so a row re-rendered right
     after a search could stay English. Localise what we render, directly;
     applyI18n skips anything already done. */
  const localize = (el) => { if (el && typeof applyI18n === "function") { try { applyI18n(el); } catch (e) { /* cosmetic */ } } };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;

  function queryString(extra) {
    const p = new URLSearchParams();
    const f = state.filters;
    for (const [k, v] of Object.entries(f)) {
      if (k === "include_withdrawn") { if (v) p.set(k, "true"); continue; }
      if (v !== "" && v != null) p.set(k, v);
    }
    for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
    return p.toString();
  }

  async function getJson(url) {
    const r = await fetch(url);
    let d = null;
    try { d = await r.json(); } catch (e) { /* non-JSON error page */ }
    if (!r.ok) {
      const err = new Error((d && (d.message || d.error)) || `Request failed (${r.status})`);
      err.status = r.status; err.code = d && d.error;
      throw err;
    }
    return d;
  }

  /* ── Summary / KPIs ─────────────────────────────────────────────────── */

  async function loadSummary() {
    const seq = ++state.summarySeq;
    const box = $("xo-kpis");
    box.classList.add("xo-loading");
    try {
      const d = await getJson(`/api/outreach/summary?${state.filters.include_withdrawn ? "include_withdrawn=true" : ""}`);
      if (seq !== state.summarySeq) return;
      state.facets = d.facets;
      renderHeader(d.event);
      renderKpis(d.kpis);
      renderClassificationOptions(d.facets.classification);
    } catch (e) {
      if (seq !== state.summarySeq) return;
      if (e.code === "no_event") {
        box.innerHTML = `<div class="xo-empty">No exhibitor list has been imported yet. Run an Exhibitor Refresh from the Booth Map first.</div>`;
        return;
      }
      box.innerHTML = `<div class="xo-error" role="alert">Couldn't load outreach totals. <button class="btn-ghost btn-sm" id="xo-kpi-retry">Retry</button></div>`;
      $("xo-kpi-retry").onclick = loadSummary;
    } finally {
      if (seq === state.summarySeq) box.classList.remove("xo-loading");
    }
  }

  function renderHeader(ev) {
    $("xo-event").textContent = ev && ev.name ? ev.name : "—";
    $("xo-verified").textContent = ev && ev.verified_at ? `List verified ${fmtDate(ev.verified_at)}` : "";
  }

  /* Every tile states two units and never mixes them: the big number counts
     EXHIBITORS (rows of the exhibitor list — what the table, its filters and
     the export count), the line under it counts individual CRM CONTACTS.
     Clicking a tile applies the filter whose row total equals the big number. */
  const n = (v) => Number(v || 0).toLocaleString();
  const KPI_DEFS = [
    { key: "exhibitors", label: "Exhibitors", unit: "exhibitor",
      sub: (k) => [`${n(k.unmatched)} not linked to a CRM company`, `${n(k.without_email)} without an emailable contact`],
      filter: {},
      title: "Exhibitors on the current show list. Not linked: no CRM company matched yet. "
        + "Without an emailable contact: no contact at the company has a usable email address (includes the not-linked ones)." },
    { key: "with_contacts", label: "With contacts", unit: "exhibitor",
      sub: (k) => [plural(k.contacts, "individual contact")], filter: { has_contacts: "yes" },
      title: "Exhibitors whose CRM company has at least one contact. Below: the number of distinct contacts at those exhibitors." },
    { key: "with_email", label: "With email", unit: "exhibitor",
      sub: (k) => [plural(k.emailable_contacts, "emailable contact")], filter: { has_email: "yes" },
      title: "Exhibitors with at least one contact who has a usable email. Below: distinct usable addresses at those exhibitors." },
    { key: "drafted", label: "Drafted", unit: "exhibitor",
      sub: (k) => [`${plural(k.drafted_contacts, "contact")} with an unsent draft`], filter: { drafted: "yes" },
      title: "Exhibitors where at least one contact has a draft that has not been sent. Below: how many contacts have one." },
    { key: "sent", label: "Contacted", unit: "exhibitor",
      sub: (k) => [`${plural(k.sent_contacts, "contact")} emailed`], filter: { sent: "yes" },
      title: "Exhibitors where at least one contact has been emailed — not necessarily every contact. "
        + "Below: individual contacts emailed, from SKQ or marked as sent." },
    { key: "needs_outreach", label: "Needs outreach", unit: "exhibitor",
      sub: (k) => [`${plural(k.needs_outreach_contacts, "emailable contact")}, none emailed yet`], filter: { status: "needs_outreach" },
      title: "Exhibitors with at least one emailable contact where nobody has been emailed yet (drafted or not). "
        + "Below: the emailable contacts at those exhibitors." },
  ];

  function renderKpis(k) {
    $("xo-kpis").innerHTML = KPI_DEFS.map((d) => `
      <button type="button" class="dash-stat xo-kpi" data-kpi="${d.key}" title="${esc(d.title)}">
        <span class="dash-stat-body">
          <span class="dash-stat-label">${esc(d.label)}</span>
          <span class="dash-stat-value">${n(k[d.key])}<span class="dash-stat-unit">${esc(Number(k[d.key]) === 1 ? d.unit : d.unit + "s")}</span></span>
          ${d.sub(k).map((line) => `<span class="xo-kpi-sub">${esc(line)}</span>`).join("")}
        </span>
      </button>`).join("");
    $("xo-kpis").querySelectorAll(".xo-kpi").forEach((b) => {
      b.onclick = () => {
        const def = KPI_DEFS.find((d) => d.key === b.dataset.kpi);
        applyFilters({ has_contacts: "", has_email: "", drafted: "", sent: "", status: "", ...def.filter });
      };
    });
    localize($("xo-kpis"));
  }

  function renderClassificationOptions(list) {
    const sel = $("xo-f-classification");
    const cur = state.filters.classification;
    const seen = new Map();
    for (const c of list || []) seen.set(c.value, (seen.get(c.value) || 0) + c.n);
    sel.innerHTML = `<option value="">Any classification</option>` + [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `<option value="${esc(v)}">${esc(CLASS_LABELS[v] || v)} (${n})</option>`).join("");
    sel.value = cur;
  }

  /* ── List ───────────────────────────────────────────────────────────── */

  async function loadList() {
    const seq = ++state.listSeq;
    const status = $("xo-list-status");
    status.innerHTML = `<span class="spinner"></span> Loading exhibitors…`;
    $("xo-list").setAttribute("aria-busy", "true");
    try {
      const d = await getJson(`/api/outreach/exhibitors?${queryString({ page: state.page, page_size: PAGE_SIZE })}`);
      if (seq !== state.listSeq) return;
      state.rows = d.rows;
      state.total = d.total;
      status.innerHTML = "";
      renderList();
    } catch (e) {
      if (seq !== state.listSeq) return;
      // Keep whatever was on screen; say what failed and offer a retry.
      status.innerHTML = `<div class="xo-error" role="alert">${e.code === "no_event"
        ? "No exhibitor list has been imported yet."
        : `Couldn't load exhibitors. <button class="btn-ghost btn-sm" id="xo-list-retry">Retry</button>`}</div>`;
      const r = $("xo-list-retry"); if (r) r.onclick = loadList;
    } finally {
      if (seq === state.listSeq) $("xo-list").setAttribute("aria-busy", "false");
    }
  }

  function statusChip(row) {
    const s = STATUS[row.outreach_status] || { label: row.outreach_status, cls: "xo-st-grey" };
    const frac = row.outreach_status === "contacted_partial" || row.outreach_status === "contacted_all"
      ? ` ${row.sent_emailable}/${row.emailable}` : "";
    return `<span class="xo-chip ${s.cls}" title="${esc(s.hint || "")}">${esc(s.label)}${frac}</span>`;
  }

  function summaryLine(r) {
    if (!r.company_id) return "Not linked to a CRM company";
    const parts = [plural(r.contacts, "contact"), plural(r.emailable, "email")];
    if (r.drafted) parts.push(`${r.drafted} drafted`);
    if (r.sent) parts.push(`${r.sent} sent`);
    return parts.join(" · ");
  }

  function renderList() {
    const list = $("xo-list");
    const count = $("xo-count");
    count.textContent = state.total ? `${state.total.toLocaleString()} exhibitor${state.total === 1 ? "" : "s"}` : "";
    renderActiveChips();
    if (!state.rows.length) {
      list.innerHTML = `<div class="xo-empty">No exhibitors match these filters.
        <button class="btn-ghost btn-sm" id="xo-empty-clear">Clear filters</button></div>`;
      $("xo-empty-clear").onclick = clearFilters;
      renderPager();
      localize(list); localize($("xo-chips"));
      return;
    }
    list.innerHTML = `
      <div class="xo-row xo-head" role="row">
        <span role="columnheader">Company</span><span role="columnheader">Booth</span>
        <span role="columnheader" class="xo-c-class">Classification</span>
        <span role="columnheader" class="xo-num">Contacts</span><span role="columnheader" class="xo-num">Drafted</span>
        <span role="columnheader" class="xo-num">Sent</span><span role="columnheader">Outreach status</span>
        <span role="columnheader" class="xo-c-actions">Actions</span>
      </div>` + state.rows.map(rowHtml).join("");
    list.querySelectorAll("[data-xo-toggle]").forEach((b) => { b.onclick = () => toggle(Number(b.dataset.xoToggle)); });
    list.querySelectorAll("[data-xo-crm]").forEach((b) => { b.onclick = () => openInCrm(b.dataset.xoCrm); });
    for (const id of state.expanded) renderDetail(id);
    renderPager();
    localize(list); localize($("xo-chips")); localize($("xo-pager"));
  }

  function rowHtml(r) {
    const open = state.expanded.has(r.exhibitor_id);
    const cls = r.classification ? (CLASS_LABELS[r.classification] || r.classification) : "";
    const withdrawn = r.attendance_status !== "listed" ? `<span class="xo-chip xo-st-grey">Withdrawn</span>` : "";
    const zh = r.chinese_name && r.chinese_name !== r.display_name ? `<span class="xo-zh">${esc(r.chinese_name)}</span>` : "";
    const canExpand = Boolean(r.company_id);
    return `
      <div class="xo-group${open ? " open" : ""}" data-ex="${r.exhibitor_id}">
        <div class="xo-row" role="row">
          <span class="xo-c-company">
            ${canExpand
              ? `<button type="button" class="xo-caret" data-xo-toggle="${r.exhibitor_id}" aria-expanded="${open}"
                   aria-controls="xo-detail-${r.exhibitor_id}" aria-label="Show contacts">${open ? "▾" : "▸"}</button>`
              : `<span class="xo-caret xo-caret-off" aria-hidden="true">·</span>`}
            <span class="xo-name-wrap">
              <span class="xo-name" data-no-i18n>${esc(r.display_name)}</span>${zh}${withdrawn}
              <span class="xo-sum">${esc(summaryLine(r))}</span>
              ${cls ? `<span class="xo-class-inline"><span class="xo-class">${esc(cls)}</span></span>` : ""}
            </span>
          </span>
          <span class="xo-c-booth" data-label="Booth" data-no-i18n>${esc(r.booths || "—")}</span>
          <span class="xo-c-class" data-label="Classification">${cls
            ? `<span class="xo-class" title="${r.classification_source === "curated" ? "Curated SKQ classification" : "From the booth map"}">${esc(cls)}</span>`
            : `<span class="xo-muted">—</span>`}</span>
          <span class="xo-num" data-label="Contacts">${r.company_id ? `${r.contacts}${r.contacts ? ` <span class="xo-muted">(${r.emailable}✉)</span>` : ""}` : "—"}</span>
          <span class="xo-num" data-label="Drafted">${r.drafted || "–"}</span>
          <span class="xo-num" data-label="Sent">${r.sent || "–"}</span>
          <span class="xo-c-status">${statusChip(r)}</span>
          <span class="xo-c-actions">
            ${canExpand
              ? `<button type="button" class="btn-ghost btn-sm" data-xo-toggle="${r.exhibitor_id}">${open ? "Hide contacts" : "Contacts"}</button>`
              : ""}
            <button type="button" class="btn-ghost btn-sm" data-xo-crm="${esc(r.display_name)}">Open in CRM</button>
          </span>
        </div>
        <div class="xo-detail" id="xo-detail-${r.exhibitor_id}" ${open ? "" : "hidden"}></div>
      </div>`;
  }

  function renderPager() {
    const pager = $("xo-pager");
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    if (pages <= 1) { pager.innerHTML = ""; return; }
    const from = (state.page - 1) * PAGE_SIZE + 1;
    const to = Math.min(state.total, state.page * PAGE_SIZE);
    pager.innerHTML = `
      <button class="btn-ghost btn-sm" id="xo-prev" ${state.page <= 1 ? "disabled" : ""}>‹ Previous</button>
      <span class="xo-muted">${from}–${to} of ${state.total.toLocaleString()} · page ${state.page} / ${pages}</span>
      <button class="btn-ghost btn-sm" id="xo-next" ${state.page >= pages ? "disabled" : ""}>Next ›</button>`;
    $("xo-prev").onclick = () => { state.page--; loadList(); scrollTop(); };
    $("xo-next").onclick = () => { state.page++; loadList(); scrollTop(); };
  }

  function scrollTop() {
    const h = document.querySelector('[data-view="outreach"]');
    if (h) h.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  /* ── Expanded contacts ─────────────────────────────────────────────── */

  function toggle(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else { state.expanded.add(id); loadDetail(id); }
    const group = document.querySelector(`.xo-group[data-ex="${id}"]`);
    if (!group) return;
    const row = state.rows.find((r) => r.exhibitor_id === id);
    if (row) {
      group.outerHTML = rowHtml(row);
      const g = document.querySelector(`.xo-group[data-ex="${id}"]`);
      g.querySelectorAll("[data-xo-toggle]").forEach((b) => { b.onclick = () => toggle(id); });
      g.querySelectorAll("[data-xo-crm]").forEach((b) => { b.onclick = () => openInCrm(b.dataset.xoCrm); });
      if (state.expanded.has(id)) renderDetail(id);
      localize(g);
    }
  }

  async function loadDetail(id) {
    const prev = state.details.get(id);
    state.details.set(id, { loading: true, error: null, data: prev && prev.data });
    renderDetail(id);
    try {
      const d = await getJson(`/api/outreach/exhibitors/${id}/contacts`);
      state.details.set(id, { loading: false, error: null, data: d });
    } catch (e) {
      state.details.set(id, { loading: false, error: e.message, data: prev && prev.data });
    }
    renderDetail(id);
  }

  /* After a draft or a send: the contact list and this row's counts. The
     KPIs move too, so they are refreshed alongside. */
  async function refreshExhibitor(id) {
    await loadDetail(id);
    try {
      const d = await getJson(`/api/outreach/exhibitors?${new URLSearchParams({ exhibitor: id, include_withdrawn: "true" })}`);
      const fresh = d.rows[0];
      const i = state.rows.findIndex((r) => r.exhibitor_id === id);
      if (fresh && i >= 0) {
        state.rows[i] = fresh;
        const g = document.querySelector(`.xo-group[data-ex="${id}"]`);
        if (g) {
          g.outerHTML = rowHtml(fresh);
          const n = document.querySelector(`.xo-group[data-ex="${id}"]`);
          n.querySelectorAll("[data-xo-toggle]").forEach((b) => { b.onclick = () => toggle(id); });
          n.querySelectorAll("[data-xo-crm]").forEach((b) => { b.onclick = () => openInCrm(b.dataset.xoCrm); });
          renderDetail(id);
          localize(n);
        }
      }
    } catch (e) { /* the row keeps its previous numbers; the detail shows its own error */ }
    loadSummary();
  }

  function renderDetail(id) {
    const box = $(`xo-detail-${id}`);
    if (!box) return;
    const st = state.details.get(id);
    if (!st || (st.loading && !st.data)) {
      box.innerHTML = `<div class="xo-detail-msg"><span class="spinner"></span> Loading contacts…</div>`;
      return;
    }
    if (st.error && !st.data) {
      box.innerHTML = `<div class="xo-error" role="alert">Couldn't load contacts. <button class="btn-ghost btn-sm" data-retry>Retry</button></div>`;
      box.querySelector("[data-retry]").onclick = () => loadDetail(id);
      return;
    }
    const d = st.data;
    const best = d.best_contact;
    const bestNote = best ? "" : (d.best_contact_note === "insufficient_evidence"
      ? `<div class="xo-muted xo-best-note">No best contact: the CRM doesn't hold enough to tell these contacts apart.</div>` : "");
    const errNote = st.error ? `<div class="xo-error" role="alert">Refresh failed: showing earlier data. <button class="btn-ghost btn-sm" data-retry>Retry</button></div>` : "";
    if (!d.contacts.length) {
      box.innerHTML = `${errNote}<div class="xo-detail-msg">No CRM contacts at this company yet.
        <button class="btn-ghost btn-sm" data-xo-crm="${esc(d.exhibitor.company_name || d.exhibitor.source_name)}">Find contacts in CRM</button></div>`;
    } else {
      box.innerHTML = errNote + bestNote + `<div class="xo-contacts" role="table" aria-label="Contacts">` +
        d.contacts.map((c) => contactHtml(c, best, id)).join("") + `</div>`;
    }
    const r = box.querySelector("[data-retry]"); if (r) r.onclick = () => loadDetail(id);
    box.querySelectorAll("[data-xo-crm]").forEach((b) => { b.onclick = () => openInCrm(b.dataset.xoCrm); });
    box.querySelectorAll("[data-act]").forEach((b) => {
      b.onclick = () => contactAction(id, Number(b.dataset.cid), b.dataset.act, b);
    });
    localize(box);
  }

  function contactHtml(c, best, exId) {
    const st = CONTACT_STATUS[c.status] || { label: c.status, cls: "xo-st-grey" };
    const isBest = best && best.contact_id === c.id;
    const email = c.has_email
      ? `<a href="mailto:${esc(c.email.trim())}" data-no-i18n>${esc(c.email.trim())}</a>`
      : `<span class="xo-muted">${c.revealable ? "🔒 Locked in Apollo" : "No email"}</span>`;
    let draftCell = `<span class="xo-muted">No draft</span>`;
    if (c.draft_id) draftCell = `<span class="xo-chip xo-st-blue">Drafted</span> <span class="xo-muted">v${c.draft_version || 1} · ${esc(fmtDate(c.draft_updated_at))}</span>`;
    else if (!c.has_email) draftCell = `<span class="xo-muted">—</span>`;
    const sentCell = c.last_sent_id
      ? `<span class="xo-chip xo-st-green">Sent</span> <span class="xo-muted">${esc(fmtDate(c.last_sent_at))} · ${c.last_sent_source === "manual" ? "manual" : "system"}${c.last_sent_user ? ` · ${esc(c.last_sent_user)}` : ""}</span>`
      : `<span class="xo-muted">Not sent</span>`;

    const btn = (act, label, kind) =>
      `<button type="button" class="btn-sm ${kind || "btn-ghost"}" data-act="${act}" data-cid="${c.id}">${label}</button>`;
    const actions = [];
    if (c.status === "no_draft") actions.push(btn("draft", "Draft email", "btn-primary"), btn("mark", "Mark sent"));
    if (c.status === "drafted") actions.push(btn("draft", "View/Edit draft", "btn-primary"), btn("mark", "Mark sent"));
    if (c.status === "sent") {
      actions.push(btn("draft", "View emails"));
      if (c.last_sent_source === "manual") actions.push(btn("undo", "Undo sent"));
    }
    if (c.status === "email_locked") actions.push(btn("draft", "Reveal & draft", "btn-primary"));

    return `
      <div class="xo-contact${isBest ? " is-best" : ""}" role="row" data-cid="${c.id}">
        <span class="xo-ct-who" role="cell">
          <span class="xo-ct-name" data-no-i18n>${esc(c.full_name || "(no name)")}</span>
          ${isBest ? `<span class="xo-best${best.basis === "title" ? " xo-best-title" : ""}" title="${esc(best.basis_label || "")}">★ Best contact</span>` : ""}
          <span class="xo-ct-title" data-no-i18n>${esc(c.job_title || "")}</span>
          ${isBest ? `<span class="xo-best-why"><b>Based on ${esc(String(best.basis_label || "").toLowerCase())}:</b> ${esc(best.reasons.join(" · "))}</span>` : ""}
        </span>
        <span class="xo-ct-email" role="cell">${email}</span>
        <span class="xo-ct-draft" role="cell" data-label="Draft">${draftCell}</span>
        <span class="xo-ct-sent" role="cell" data-label="Sent">${sentCell}</span>
        <span class="xo-ct-actions" role="cell">${actions.join("")}</span>
        <div class="xo-mark" id="xo-mark-${exId}-${c.id}" hidden></div>
      </div>`;
  }

  function contactById(exId, cid) {
    const st = state.details.get(exId);
    return st && st.data ? st.data.contacts.find((c) => c.id === cid) : null;
  }

  async function contactAction(exId, cid, act, btnEl) {
    const c = contactById(exId, cid);
    if (!c) return;
    if (act === "draft") return openDrafter(exId, c);
    if (act === "mark") return showMarkForm(exId, c);
    if (act === "undo") return undoSent(exId, c, btnEl);
  }

  /* The existing drafter, fed the contact in the CRM row shape it already
     accepts. Reveal first when the address is locked, exactly as the CRM
     table does, so the Apollo charge is confirmed by the user. */
  async function openDrafter(exId, c) {
    if (typeof openDraftModalForContact !== "function") return;
    if (typeof emailNeedsApolloReveal === "function" && emailNeedsApolloReveal(c)) {
      const rev = await revealBeforeUse([c], "address the draft", "填写收件人");
      if (rev.cancelled) return;
      if (rev.emails && rev.emails[c.id]) c.email = rev.emails[c.id];
      refreshExhibitor(exId);
    }
    await openDraftModalForContact(crmRowToDraftFormat(c), () => refreshExhibitor(exId),
      { preferredMode: "conference_outreach" });
  }

  function showMarkForm(exId, c) {
    const box = $(`xo-mark-${exId}-${c.id}`);
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `
      <form class="xo-mark-form">
        <span class="xo-mark-to">Record an email sent outside SKQ to <b data-no-i18n>${esc(c.email.trim())}</b></span>
        <label>Sent on <input type="date" name="sent_at" value="${today()}" max="${today()}" required></label>
        <label class="xo-mark-notes">Note <input type="text" name="notes" maxlength="500" placeholder="Optional"></label>
        <span class="xo-mark-btns">
          <button type="submit" class="btn-sm btn-primary">Save as sent</button>
          <button type="button" class="btn-sm btn-ghost" data-cancel>Cancel</button>
        </span>
        <span class="xo-mark-err" role="alert"></span>
      </form>`;
    localize(box);
    const form = box.querySelector("form");
    form.querySelector("[data-cancel]").onclick = () => { box.hidden = true; box.innerHTML = ""; };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      const errEl = form.querySelector(".xo-mark-err");
      errEl.textContent = "";
      try {
        const r = await fetch(`/api/outreach/contacts/${c.id}/mark-sent`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sent_at: form.sent_at.value, notes: form.notes.value, draft_id: c.draft_id || null }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || "Couldn't record the send.");
        if (typeof showMessage === "function") showMessage("Recorded as sent.", "info");
        await refreshExhibitor(exId);
      } catch (err) {
        errEl.textContent = err.message;
        submit.disabled = false;
      }
    };
    form.sent_at.focus();
  }

  /* Undo = the existing soft delete. The record goes to Trash and can be
     restored from the drafter; nothing is hard-deleted. */
  async function undoSent(exId, c, btnEl) {
    if (!window.confirm(`Undo the manually recorded send to ${c.email}? It moves to Trash and can be restored.`)) return;
    btnEl.disabled = true;
    try {
      const r = await fetch(`/api/outreach/sent/${c.last_sent_id}/undo`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || "Undo failed.");
      await refreshExhibitor(exId);
    } catch (e) {
      btnEl.disabled = false;
      if (typeof showMessage === "function") showMessage(e.message, "error");
    }
  }

  function openInCrm(name) {
    if (typeof showView !== "function") return;
    showView("crm");
    const input = $("crm-search-input");
    if (input) input.value = name;
    if (typeof loadCrmContacts === "function") loadCrmContacts(name);
  }

  /* ── Filters ────────────────────────────────────────────────────────── */

  const FILTER_LABELS = {
    has_contacts: { yes: "Has contacts", no: "No contacts" },
    has_email: { yes: "Has email", no: "No email" },
    drafted: { yes: "Has drafts", no: "No drafts" },
    sent: { yes: "Contacted", no: "Not contacted" },
    status: { needs_outreach: "Needs outreach", contacted: "Contacted", ...Object.fromEntries(
      Object.entries(STATUS).map(([k, v]) => [k, v.label + (k === "contacted_partial" ? " (partial)" : k === "contacted_all" ? " (all)" : "")])) },
  };

  /* Debounce timers for the two text boxes. They carry no value: when one
     fires it commits whatever the box holds at that moment. */
  const textTimers = { q: null, booth: null };
  const TEXT_INPUT = { q: "xo-search", booth: "xo-f-booth" };

  /* Every filter change goes through here. Pending text is committed first
     (see outreach-filters.js), so re-rendering the controls afterwards can
     only write back what the user typed — never an older value over it. */
  function applyFilters(patch) {
    for (const key of Object.keys(textTimers)) { clearTimeout(textTimers[key]); textTimers[key] = null; }
    const typed = { q: $(TEXT_INPUT.q).value, booth: $(TEXT_INPUT.booth).value };
    state.filters = window.xoFilters.mergeFilters(state.filters, patch || {}, typed);
    state.page = 1;
    syncFilterInputs();
    loadList();
  }

  function scheduleTextFilter(key) {
    clearTimeout(textTimers[key]);
    textTimers[key] = setTimeout(() => { textTimers[key] = null; applyFilters({}); }, 300);
  }

  function clearFilters() {
    applyFilters({ q: "", booth: "", classification: "", has_contacts: "", has_email: "", drafted: "", sent: "",
      status: "", exhibitor: "" });
  }

  function syncFilterInputs() {
    const f = state.filters;
    // Only when different: rewriting an identical value would still move the caret.
    if ($("xo-search").value.trim() !== f.q) $("xo-search").value = f.q;
    if ($("xo-f-booth").value.trim() !== f.booth) $("xo-f-booth").value = f.booth;
    $("xo-f-classification").value = f.classification;
    for (const k of ["has_contacts", "has_email", "drafted", "sent", "status", "sort"]) $(`xo-f-${k}`).value = f[k];
    $("xo-f-withdrawn").checked = f.include_withdrawn;
    const n = ["booth", "classification", "has_contacts", "has_email", "drafted", "sent", "status"]
      .filter((k) => f[k]).length + (f.include_withdrawn ? 1 : 0);
    $("xo-filter-toggle").textContent = n ? `Filters (${n})` : "Filters";
  }

  function renderActiveChips() {
    const f = state.filters;
    const chips = [];
    if (f.exhibitor) chips.push(["exhibitor", "One exhibitor (linked)"]);
    if (f.q) chips.push(["q", `“${f.q}”`]);
    if (f.booth) chips.push(["booth", `Booth ${f.booth}`]);
    if (f.classification) chips.push(["classification", CLASS_LABELS[f.classification] || f.classification]);
    for (const k of ["has_contacts", "has_email", "drafted", "sent", "status"]) {
      if (f[k]) chips.push([k, FILTER_LABELS[k][f[k]] || f[k]]);
    }
    if (f.include_withdrawn) chips.push(["include_withdrawn", "Including withdrawn"]);
    const box = $("xo-chips");
    box.innerHTML = chips.map(([k, l]) =>
      `<button type="button" class="xo-fchip" data-clear="${k}" aria-label="Remove filter ${esc(l)}">${esc(l)} ✕</button>`).join("")
      + (chips.length > 1 ? `<button type="button" class="xo-fchip xo-fchip-clear" data-clear="*">Clear all</button>` : "");
    box.querySelectorAll("[data-clear]").forEach((b) => {
      b.onclick = () => {
        if (b.dataset.clear === "*") return clearFilters();
        applyFilters({ [b.dataset.clear]: b.dataset.clear === "include_withdrawn" ? false : "" });
        if (b.dataset.clear === "include_withdrawn") loadSummary();
      };
    });
  }

  /* ── Download ───────────────────────────────────────────────────────── */

  function download(scope, format) {
    const qs = scope === "all"
      ? new URLSearchParams({ scope, format, ...(state.filters.include_withdrawn ? { include_withdrawn: "true" } : {}) }).toString()
      : queryString({ scope, format });
    // A plain navigation: the browser handles the attachment, and the
    // server builds the file from the database, never from this table.
    window.location.href = `/api/outreach/export?${qs}`;
    closeMenu();
  }

  function closeMenu() {
    $("xo-dl-menu").hidden = true;
    $("xo-dl-btn").setAttribute("aria-expanded", "false");
  }

  /* ── Wiring ─────────────────────────────────────────────────────────── */

  function init() {
    if (state.initialised) return;
    state.initialised = true;

    /* Chinese (and other IME) input sends input events for the unfinished
       composition; searching on those would query half-typed pinyin. Wait for
       the composition to end, then debounce as usual. */
    for (const [key, id] of Object.entries(TEXT_INPUT)) {
      const el = $(id);
      el.addEventListener("input", (e) => { if (!e.isComposing) scheduleTextFilter(key); });
      el.addEventListener("compositionend", () => scheduleTextFilter(key));
    }
    for (const k of ["classification", "has_contacts", "has_email", "drafted", "sent", "status", "sort"]) {
      $(`xo-f-${k}`).addEventListener("change", (e) => applyFilters({ [k]: e.target.value }));
    }
    $("xo-f-withdrawn").addEventListener("change", (e) => {
      applyFilters({ include_withdrawn: e.target.checked });
      loadSummary();
    });
    $("xo-filter-toggle").addEventListener("click", () => {
      const open = document.body.classList.toggle("xo-filters-open");
      $("xo-filter-toggle").setAttribute("aria-expanded", String(open));
    });
    $("xo-filters-done").addEventListener("click", () => {
      document.body.classList.remove("xo-filters-open");
      $("xo-filter-toggle").setAttribute("aria-expanded", "false");
    });
    $("xo-refresh").addEventListener("click", () => { loadSummary(); loadList(); });

    $("xo-dl-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const m = $("xo-dl-menu");
      m.hidden = !m.hidden;
      $("xo-dl-btn").setAttribute("aria-expanded", String(!m.hidden));
    });
    $("xo-dl-menu").querySelectorAll("[data-scope]").forEach((b) => {
      b.addEventListener("click", () => download(b.dataset.scope, b.dataset.format));
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".xo-dl")) closeMenu(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

    // Deep link: /?view=outreach&exhibitor=<id> opens that exhibitor, expanded.
    const q = new URLSearchParams(location.search);
    const ex = Number(q.get("exhibitor"));
    if (q.get("view") === "outreach" && Number.isInteger(ex) && ex > 0) {
      state.filters.exhibitor = String(ex);
      state.filters.include_withdrawn = true;
      state.expanded.add(ex);
      loadDetail(ex);
    }
    syncFilterInputs();
  }

  window.outreachShow = function () {
    init();
    loadSummary();
    loadList();
  };

  /* app.js restores the last-open view while it loads, before this file
     exists — so if that view was this one, nothing has fetched yet. A deep
     link wins over the remembered view. */
  const deep = new URLSearchParams(location.search).get("view") === "outreach";
  if (deep && typeof showView === "function") showView("outreach");
  else {
    const view = document.querySelector('[data-view="outreach"]');
    if (view && !view.classList.contains("view-hidden")) window.outreachShow();
  }
})();
