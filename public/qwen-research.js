/* Current Account Research (Qwen-based) — native CRM workspace.
 *
 * Reads come from Neon through /api/aresearch/*; the research engine is only
 * consulted to RUN research and to render stored records. The report library,
 * every saved report, language switching and PDF export therefore keep working
 * when the engine is down or its models are not activated.
 *
 * This is a second engine, not a merge: nothing here touches the Claude-based
 * Account Research, its tables, prompts or routes.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = (p) => `/api/aresearch${p}`;

  const LANG_KEY = 'qrDisplayLanguage';
  const LANGS = ['en', 'zh', 'bilingual'];
  const MODEL_MSG = 'Model unavailable — activation/payment required.';
  const MODEL_MSG_ZH = '模型暂不可用 — 需要开通/付费。';
  /* Deliberately says nothing about payment: this is a connection state. */
  const CONN_MSG = 'Cannot reach the research service — model status unknown.';
  const CONN_MSG_ZH = '无法连接研究服务 — 模型状态未知。';

  let modelsAvailable = null;          // null = unknown until health is fetched
  let modelHealth = 'unknown';         // 'available' | 'denied' | 'unknown'
  let modelUnknownReason = '';         // why health could not be read, when known
  let modelStates = [];                // [{ model, label, state }] from /models/health
  let modelSelectable = [];            // the subset a user could actually pick
  let library = [];
  /* Companies ticked in the report library. Its own set: "Compile Selected"
     must never fall back to the batch table's selection, which the Reports tab
     does not show. */
  const librarySelection = new Set();
  /* The workspace is one account at a time. `current` used to be a bare global
     last-report cache keyed to nothing, so selecting Toyota repainted the session
     list and progress while Apple's report stayed mounted underneath with nothing
     saying whose it was. It is now only ever read through workspaceCompany. */
  let current = null;                  // { company, report }
  let workspaceCompany = null;         // the account the whole workspace shows
  let reportMode = 'current';          // 'current' | 'previous'
  let batchItems = [];
  let batchRows = [];

  function getLang() {
    try { const v = localStorage.getItem(LANG_KEY); if (LANGS.includes(v)) return v; }
    catch (e) { /* private browsing */ }
    return 'bilingual';
  }
  function setLang(v) { try { localStorage.setItem(LANG_KEY, v); } catch (e) { /* ignore */ } }

  function msg(el, text, kind) {
    const e = $(el);
    if (!e) return;
    if (!text) { e.hidden = true; return; }
    e.hidden = false;
    e.className = `qr-msg ${kind || 'info'}`;
    e.innerHTML = text;
  }

  /* ── Minimal Markdown → HTML. Enough for the report's headings, lists,
     tables, bold, citations and confidence tags. ── */
  function md(src) {
    const lines = String(src || '').split('\n');
    let out = '', inUl = false, inTable = false;
    const inline = (t) => esc(t)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(\d+)\]/g, '<span class="qr-cite">$1</span>')
      .replace(/(Verified \/ 已验证|Verified|已验证)/g, '<span class="qr-tagv">$1</span>')
      .replace(/(Likely \/ 可能|Likely|可能)/g, '<span class="qr-tagl">$1</span>')
      .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    const closeUl = () => { if (inUl) { out += '</ul>'; inUl = false; } };
    const closeTable = () => { if (inTable) { out += '</tbody></table>'; inTable = false; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (/^\s*\|.*\|\s*$/.test(line)) {
        const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (/^[\s:|-]+$/.test(line.replace(/\|/g, ''))) continue;
        if (!inTable) {
          closeUl();
          out += '<table><thead><tr>' + cells.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
          inTable = true;
        } else {
          out += '<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
        }
        continue;
      }
      closeTable();
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeUl(); const lvl = Math.min(h[1].length + 1, 4); out += `<h${lvl}>${inline(h[2])}</h${lvl}>`; continue; }
      const li = line.match(/^\s*[-*+]\s+(.*)$/) || line.match(/^\s*\d+\.\s+(.*)$/);
      if (li) { if (!inUl) { out += '<ul>'; inUl = true; } out += `<li>${inline(li[1])}</li>`; continue; }
      if (!line.trim()) { closeUl(); continue; }
      closeUl();
      out += `<p>${inline(line)}</p>`;
    }
    closeUl(); closeTable();
    return out;
  }

  /* ── Model availability ───────────────────────────────────────────────────
     THREE states, never two. Collapsing them is what made an unreachable engine
     report itself as a billing problem: /models/health answers 503 with
     { error } when CURRENT_ACCOUNT_RESEARCH_URL is unset or the engine is down,
     and Boolean(undefined) read that as "access denied".

       'available' — the response lists at least one usable model
       'denied'    — the response lists models and every one is access_denied
       'unknown'   — no usable response: transport error, non-OK status, or a
                     payload carrying no models array

     Only 'denied' is an activation/payment condition. ── */
  async function checkModels() {
    let d = null;
    try {
      const res = await fetch(api('/models/health'));
      const body = await res.json().catch(() => null);
      if (res.ok && body && Array.isArray(body.models)) d = body;
      else modelUnknownReason = (body && body.error) || `HTTP ${res.status}`;
    } catch (e) {
      modelUnknownReason = e.message;
    }

    if (d) {
      modelStates = d.models;
      modelSelectable = d.models.filter((m) => m.state !== 'access_denied');
      modelHealth = modelSelectable.length ? 'available' : (d.models.length ? 'denied' : 'unknown');
      modelUnknownReason = '';
    } else {
      modelStates = [];
      modelSelectable = [];
      modelHealth = 'unknown';
    }
    modelsAvailable = modelHealth === 'available';

    renderModelOptions();
    renderModelNotice();
    renderStatusCards();
  }

  /* Keep both pickers populated so the backend always receives a model id it
     recognises — the engine rejects an empty one. Routing itself is unchanged. */
  function renderModelOptions() {
    const html = modelStates.map((m) =>
      `<option value="${esc(m.model)}"${m.state === 'access_denied' ? ' disabled' : ''}>` +
      `${esc(m.label)}${m.state === 'access_denied' ? ' — Unavailable / 未开通' : ''}</option>`).join('');
    ['qr-model', 'qr-batchmodel'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      const keep = el.value;
      el.innerHTML = html;
      const usable = modelSelectable.map((m) => m.model);
      el.value = usable.includes(keep) ? keep : (usable[0] || (modelStates[0] || {}).model || '');
    });
    applyModelFieldVisibility();
  }

  /* A picker with nothing to choose between is noise. Hide the field entirely —
     no label, no control, no gap — and reflow the row it sat in. It reappears by
     itself as soon as the health response offers more than one usable model. */
  function applyModelFieldVisibility() {
    const show = modelSelectable.length > 1;
    document.querySelectorAll('#ar-pane-current .qr-modelfield').forEach((f) => {
      f.hidden = !show;
      const form = f.closest('.qr-form');
      if (form) form.classList.toggle('qr-nomodel', !show);
    });
  }

  /* The banner is a function of the live response and nothing else. It is
     removed from the layout when models are usable, and it never claims a
     payment condition for a connection failure. */
  function renderModelNotice() {
    const n = $('qr-model-notice');
    if (!n) return;
    if (modelHealth === 'available') {
      n.hidden = true;
      n.innerHTML = '';
      n.classList.remove('is-neutral');
      return;
    }
    n.hidden = false;
    if (modelHealth === 'denied') {
      n.classList.remove('is-neutral');
      n.innerHTML =
        `<div>${esc(MODEL_MSG)}<span class="i18n-zh">${esc(MODEL_MSG_ZH)}</span></div>` +
        '<div style="opacity:.85;margin-top:3px;">Saved reports, language views and PDFs are ' +
        'unaffected.<span class="i18n-zh">已保存的报告、语言切换与 PDF 不受影响。</span></div>';
    } else {
      n.classList.add('is-neutral');
      n.innerHTML =
        `<div>${esc(CONN_MSG)}<span class="i18n-zh">${esc(CONN_MSG_ZH)}</span></div>` +
        '<div style="opacity:.85;margin-top:3px;">Saved reports, language views and PDFs are ' +
        'unaffected.<span class="i18n-zh">已保存的报告、语言切换与 PDF 不受影响。</span></div>' +
        (modelUnknownReason ? `<div style="opacity:.7;margin-top:3px;font-size:.94em;">${esc(modelUnknownReason)}</div>` : '');
    }
  }

  /* ── Workspace status strip. Values come from the health and library
     responses this workspace already makes. No extra request, no model call. ── */
  function renderStatusCards() {
    const icon = $('qr-stat-icon');
    const mv = $('qr-stat-model');
    if (mv) {
      const chosen = $('qr-model') && $('qr-model').value;
      const hit = modelSelectable.find((m) => m.model === chosen)
               || modelSelectable[0] || modelStates[0];
      if (modelHealth === 'available' && hit) {
        mv.textContent = hit.label;
      } else if (modelHealth === 'denied') {
        mv.textContent = 'Activation required / 需开通付费';
      } else {
        mv.textContent = 'Service unreachable / 无法连接';
      }
      if (icon) {
        icon.className = 'qr-stat-icon' +
          (modelHealth === 'available' ? ' is-green' : modelHealth === 'denied' ? ' is-red' : '');
      }
    }
    if ($('qr-stat-reports')) $('qr-stat-reports').textContent = String(library.length);
    const lv = $('qr-stat-last');
    if (lv) {
      const latest = library.find((r) => r.researchedAt) || library[0];
      lv.textContent = latest
        ? `${reportDate(latest.researchedAt) || '—'} · ${latest.companyName}`
        : 'No reports yet / 暂无报告';
    }
  }

  /* Blocks a run that cannot succeed, and says WHY accurately: a billing state
     and an unreachable service are different problems. */
  function blockIfNoModel(target) {
    if (modelHealth === 'denied') {
      msg(target, `<strong>${esc(MODEL_MSG)}</strong><br><span>${esc(MODEL_MSG_ZH)}</span>`, 'err');
      return true;
    }
    if (modelHealth === 'unknown') {
      msg(target, `<strong>${esc(CONN_MSG)}</strong><br><span>${esc(CONN_MSG_ZH)}</span>`
                  + (modelUnknownReason ? `<br><span style="opacity:.7">${esc(modelUnknownReason)}</span>` : ''), 'err');
      return true;
    }
    return false;
  }

  /* ── Report library (Neon) ── */
  async function loadLibrary() {
    try {
      library = await fetch(api('/reports')).then((r) => r.json());
    } catch (e) { library = []; }
    const live = new Set(library.map((r) => r.companyName));
    [...librarySelection].forEach((c) => { if (!live.has(c)) librarySelection.delete(c); });
    renderLibrary();
    renderStatusCards();
    if ($('qr-company') && $('qr-company').value.trim()) lookupCompany($('qr-company').value);
  }

  function reportDate(v) { return v ? String(v).slice(0, 10) : ''; }

  function visibleLibraryRows() {
    const q = ($('qr-libsearch') ? $('qr-libsearch').value : '').trim().toLowerCase();
    return library.filter((r) => !q
      || (r.companyName || '').toLowerCase().includes(q)
      || (r.modelLabel || '').toLowerCase().includes(q));
  }

  function librarySelected() {
    return library.filter((r) => librarySelection.has(r.companyName)).map((r) => r.companyName);
  }

  /* Reflect the selection onto rows already on screen. Re-rendering the whole
     list on every tick would throw away the DOM the user is clicking. */
  function syncLibrarySelectionUI() {
    document.querySelectorAll('#qr-liblist .qr-libcb').forEach((cb) => {
      const on = librarySelection.has(cb.dataset.qrCo);
      if (cb.checked !== on) cb.checked = on;
      cb.closest('li').classList.toggle('sel', on);
    });
    const n = librarySelected().length;
    if ($('qr-lib-selcount')) {
      $('qr-lib-selcount').textContent = n ? `${n} selected / 已选 ${n} 份` : '';
    }
  }

  function renderLibrary() {
    const rows = visibleLibraryRows();
    if ($('qr-libcount')) {
      $('qr-libcount').textContent = library.length
        ? `${rows.length} / ${library.length} reports · 共 ${library.length} 份`
        : '';
    }
    $('qr-liblist').innerHTML = rows.length ? rows.map((r) => {
      const co = esc(r.companyName);
      return `
      <li>
        <input type="checkbox" class="qr-libcb" data-qr-co="${co}" aria-label="Select ${co}">
        <span class="co">${co}</span>
        <span class="mt">${esc(r.modelLabel || '')} · ${esc(reportDate(r.researchedAt))} · ${r.sourceCount ?? '—'} src</span>
        <span class="sp">
          <button data-qr-open="${co}">View / 查看</button>
          <button data-qr-pdf="${co}">PDF / 查看PDF</button>
          <details class="qr-menu"><summary>⋯</summary><div class="qr-menubox">
            <button data-qr-dl="${co}">Download PDF / 下载PDF</button>
            <button data-qr-refresh="${co}">Refresh / 刷新</button>
            <div class="qr-menusep"></div>
            <button class="del" data-qr-del="${co}">Delete Report / 删除报告</button>
          </div></details>
        </span>
      </li>`; }).join('')
      : `<li class="qr-empty">${library.length ? 'No reports match. 未找到匹配报告。' : 'No reports yet. 暂无报告。'}</li>`;
    syncLibrarySelectionUI();
  }

  /* ── Single report ── */
  /** keepProgress: true only when this call follows the run that produced the
   *  report, so the completed panel stays above it. Opening any other report
   *  clears it — a panel from an earlier run must not sit above someone else's. */
  async function openReport(company, keepProgress) {
    msg('qr-single-msg', '');
    if (!keepProgress && $('qr-progress')) $('qr-progress').hidden = true;
    showSub('single');
    try {
      const got = await fetch(api(`/company/${encodeURIComponent(company)}`)).then((r) => {
        if (r.status === 404) {
          const miss = new Error('No saved report for this company yet. 该公司暂无已保存报告。');
          miss.notFound = true;
          throw miss;
        }
        if (!r.ok) throw new Error(`The report service returned ${r.status}.`);
        return r.json();
      });
      if (workspaceCompany !== company) setWorkspace(company);
      current = { company, report: got.report };
      await renderReport();
    } catch (e) {
      current = null;
      $('qr-report-card').style.display = 'none';
      // A missing report is a LOOKUP result, not a failure. Only say "error"
      // when something actually went wrong fetching it.
      if (e && e.notFound) {
        renderLookup('new', null, company);
        msg('qr-single-msg', '');
      } else {
        msg('qr-single-msg', `Could not load the saved report. 无法加载已保存的报告。<br>`
            + `<span>${esc(e.message)}</span>`, 'err');
      }
    }
  }

  /* The language view is rendered server-side from the stored record, so the
     selection logic lives in one place instead of being mirrored here. */
  /* Switching accounts tears the workspace down before anything is rebuilt, so a
     stale report can never survive the switch. */
  function setWorkspace(company) {
    if (workspaceCompany === company) return;
    workspaceCompany = company || null;
    current = null;
    reportMode = 'current';
    if ($('qr-report-card')) $('qr-report-card').style.display = 'none';
    if ($('qr-prev-banner')) $('qr-prev-banner').hidden = true;
    if ($('qr-prevrow')) $('qr-prevrow').hidden = true;
  }

  async function renderReport() {
    if (!current) { $('qr-report-card').style.display = 'none'; return; }
    // A report belongs to an account. If the workspace has moved on, it is not ours.
    if (workspaceCompany && current.company !== workspaceCompany) {
      $('qr-report-card').style.display = 'none';
      return;
    }
    const prev = $('qr-prev-banner');
    if (prev) prev.hidden = reportMode !== 'previous';
    const r = current.report;
    $('qr-report-card').style.display = '';
    $('qr-report-title').textContent = `${r.company} — ${r.model_label || r.model || ''}`;
    const u = r.token_usage || {};
    $('qr-meta').innerHTML = [
      ['Sources / 来源', (r.sources || []).length],
      ['Input tokens / 输入', u.input ?? '—'],
      ['Output tokens / 输出', u.output ?? '—'],
      ['Total tokens / 合计', u.total ?? '—'],
      ['Latency / 耗时', (r.latency_seconds ?? '—') + ' s'],
      ['Researched / 研究时间', (r.timestamp || '').slice(0, 16).replace('T', ' ')],
    ].map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join('');

    const dm = r.decision_makers || [];
    $('qr-contacts').innerHTML = dm.length ? `
      <h3 style="font-size:0.88rem;margin:0 0 8px;">Key Contacts &amp; Decision Makers
        <span class="i18n-zh" style="opacity:.75;">关键联系人与决策者</span></h3>
      <div class="table-wrap"><table class="qr-table" style="min-width:0;">
        <thead><tr><th>Name / 姓名</th><th>Title / 职务</th><th>Department / 部门</th>
        <th>Contact / 联系方式</th><th>Source / 来源</th></tr></thead><tbody>
        ${dm.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.title || '—')}</td>
          <td>${esc(p.department || '—')}</td>
          <td>${p.email ? esc(p.email) : '<span style="opacity:.6">No email</span>'}<br>
              <span style="font-size:.7rem;opacity:.75">${esc(p.email_status || '')}</span></td>
          <td>${esc((p.sources || []).join(' + '))}</td></tr>`).join('')}
      </tbody></table></div>` : '';

    try {
      const d = await fetch(api(`/render?company=${encodeURIComponent(current.company)}&lang=${getLang()}`))
        .then((x) => x.json());
      $('qr-report').innerHTML = md(d.markdown || '');
    } catch (e) {
      $('qr-report').innerHTML = `<p class="qr-msg err">Could not render the report view. 无法渲染报告视图。</p>`;
    }

    const src = r.sources || [];
    $('qr-sources').innerHTML = src.length ? `
      <h3 style="font-size:0.88rem;margin:18px 0 6px;">Sources <span class="i18n-zh" style="opacity:.75;">信息来源</span></h3>
      <ul class="qr-srclist">${src.map((s) => `<li><span class="t">[${s.id}] ${esc(s.title || '(untitled)')}</span>
        <br><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></li>`).join('')}</ul>` : '';
  }

  /* ── PDF preview: a PDF in a frame, not an application in a frame ── */
  function pdfUrl(company, inline) {
    return api(`/render?company=${encodeURIComponent(company)}&lang=${getLang()}&format=pdf${inline ? '&inline=1' : ''}`);
  }
  function openPdf(company) {
    $('qr-pdfname').textContent = company;
    $('qr-pdfopen').href = pdfUrl(company, true);
    $('qr-pdfdl').href = pdfUrl(company, false);
    $('qr-pdfframe').src = pdfUrl(company, true);
    $('qr-pdfcard').style.display = '';
    $('qr-pdfcard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closePdf() {
    $('qr-pdfcard').style.display = 'none';
    $('qr-pdfframe').src = 'about:blank';
  }

  async function deleteReport(company) {
    if (!confirm(`Delete the saved report for ${company}?\n删除该公司的已保存报告？`)) return;
    const r = await fetch(api('/reports/delete'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companies: [company] }),
    }).then((x) => x.json());
    if (r.ok) {
      if (current && current.company === company) { current = null; $('qr-report-card').style.display = 'none'; }
      closePdf();
      await loadLibrary();
      await refreshExisting();
      const onLibrary = !document.querySelector('[data-qr-view="library"]').hidden;
      msg(onLibrary ? 'qr-lib-msg' : 'qr-single-msg', 'Report deleted. 报告已删除。', 'info');
    }
  }

  /* ── Report library: selection, compile and bulk delete ──
     Compile Selected reads THIS set, never the batch table's. The server already
     accepts a `companies` filter on /export/portfolio, so no backend change. ── */
  function initLibraryActions() {
    $('qr-lib-selall').addEventListener('click', () => {
      visibleLibraryRows().forEach((r) => librarySelection.add(r.companyName));
      syncLibrarySelectionUI();
    });
    $('qr-lib-selnone').addEventListener('click', () => {
      librarySelection.clear();
      syncLibrarySelectionUI();
    });

    $('qr-compile-sel').addEventListener('click', async () => {
      const companies = librarySelected();
      if (!companies.length) {
        return msg('qr-lib-msg', 'Select at least one report. 请至少选择一份报告。', 'err');
      }
      msg('qr-lib-msg', `Compiling ${companies.length}… 汇总中…`, 'info');
      try {
        const res = await fetch(api('/export/portfolio'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companies, lang: getLang() }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed.');
        const blob = await res.blob();
        const cd = res.headers.get('content-disposition') || '';
        const m = cd.match(/filename=?"?([^";]+)/);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = m ? m[1] : 'account_research_selected.pdf';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        msg('qr-lib-msg', `Compiled ${companies.length} report(s). 已汇总 ${companies.length} 份。`, 'info');
      } catch (e) { msg('qr-lib-msg', esc(e.message), 'err'); }
    });

    $('qr-lib-delsel').addEventListener('click', async () => {
      const companies = librarySelected();
      if (!companies.length) {
        return msg('qr-lib-msg', 'Select at least one report. 请至少选择一份报告。', 'err');
      }
      if (!confirm(`Delete ${companies.length} saved report(s)?\n`
                 + `删除 ${companies.length} 份已保存报告？`)) return;
      await fetch(api('/reports/delete'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies }),
      });
      librarySelection.clear();
      await loadLibrary();
      await refreshExisting();
      msg('qr-lib-msg', `Deleted ${companies.length} report(s). 已删除 ${companies.length} 份报告。`, 'info');
    });
  }

  /* ── Sub-tabs ── */
  function showSub(name) {
    document.querySelectorAll('.qr-subtab').forEach((b) =>
      b.classList.toggle('active', b.dataset.qrTab === name));
    document.querySelectorAll('.qr-view').forEach((v) => { v.hidden = v.dataset.qrView !== name; });
    if (name === 'library') loadLibrary();
    if (name === 'single') { wireSessions(); refreshSessions(); }
    // Rows pick their runs back up from Neon on every visit, so switching tabs
    // or refreshing does not lose sight of work that is still going.
    if (name === 'batch') reconnectBatchRows();
  }



  /* Live Research was removed from the UI: sections only began appearing during
     final generation, which is too late to be worth the complexity. The BACKEND
     is intact and dormant - the engine still publishes sections, the CRM still
     stores and serves them - so this can be revisited without rebuilding it.
     Nothing here polls /job/:id/sections any more. */

  /* ── Research Sessions ────────────────────────────────────────────────────
     The list is rendered from Neon, never from browser state, so a session
     survives navigation, a refresh, a closed browser and an engine restart.
     Selecting a session only READS it: nothing here can start a paid job. */

  const SESSION_STATE = {
    queued:                     ['Queued', '排队中', 'st-queued'],
    researching:                ['Researching', '研究中', 'st-researching'],
    generating:                 ['Generating', '生成中', 'st-generating'],
    completed:                  ['Completed', '已完成', 'st-completed'],
    completed_with_limitations: ['Completed with limitations', '已完成（有限制）', 'st-limited'],
    synthesis_failed:           ['Synthesis failed', '生成失败', 'st-failed'],
    interrupted:                ['Interrupted', '已中断', 'st-failed'],
    failed:                     ['Failed', '失败', 'st-failed'],
  };
  const SESSION_LIVE = new Set(['queued', 'researching', 'generating']);
  const SESSION_HAS_REPORT = new Set(['completed', 'completed_with_limitations']);

  let sessions = [];
  let sessionSel = null;         // job_id whose detail is on screen
  let sessionTimer = null;
  let sessionFollowing = null;   // job_id the follower loop is polling
  let sessionsWired = false;
  let sessionsExpanded = false;        // history: 5 by default, HISTORY_MAX expanded
  const HISTORY_SHORT = 5;
  const HISTORY_MAX = 25;

  const SESSION_STAGE = {
    queued: ['Queued', '排队中'], discover: ['Validating company', '识别公司'],
    official: ['Reading official website', '读取官网'], listing: ['Listing lookup', '上市信息'],
    queries: ['Planning research areas', '规划检索'], site: ['Reading official website', '读取官网'],
    search: ['Searching research areas', '检索资料'], verify: ['Verifying sources', '核实来源'],
    dedupe: ['Ranking sources', '排序来源'], evidence: ['Building evidence set', '构建证据'],
    financial: ['Financial sourcing', '财务信息'], apollo: ['Contact enrichment', '联系人补充'],
    contacts: ['Contact enrichment', '联系人补充'], quality: ['Assessing evidence', '评估证据'],
    model: ['Generating research', '生成报告'], synthesis: ['Generating research', '生成报告'],
    completed: ['Completed', '已完成'],
  };

  function sessionElapsed(s) {
    const sec = s.elapsed_seconds != null
      ? Number(s.elapsed_seconds)
      : (Date.now() - new Date(s.started_at || Date.now()).getTime()) / 1000;
    return fmtElapsed(sec) || '—';
  }

  function sessionStarted(s) {
    const d = new Date(s.started_at || Date.now());
    return Number.isNaN(d.getTime()) ? '—'
      : d.toLocaleString([], { month: 'short', day: 'numeric',
                               hour: '2-digit', minute: '2-digit' });
  }

  async function fetchSessions() {
    try {
      const r = await fetch(api('/sessions')).then((x) => x.json());
      return Array.isArray(r) ? r : null;
    } catch (e) {
      return null;                  // transient: keep whatever is on screen
    }
  }

  function renderSessions() {
    const box = $('qr-sessions'); const list = $('qr-sess-list');
    if (!box || !list) return;
    box.hidden = sessions.length === 0;
    /* Every active session is always shown - those are the ones the user is
       waiting on. History is bounded so the panel stops eating the page. This is
       presentation only: nothing in Neon is filtered, deleted or altered. */
    const active = sessions.filter((x) => SESSION_LIVE.has(x.state));
    const history = sessions.filter((x) => !SESSION_LIVE.has(x.state));
    const shown = sessionsExpanded ? HISTORY_MAX : HISTORY_SHORT;
    const visibleHistory = history.slice(0, shown);
    const count = $('qr-sess-count');
    if (count) {
      count.textContent = sessions.length
        ? `${active.length} running · ${history.length} previous` : '';
    }
    const toggle = $('qr-sess-toggle');
    if (toggle) {
      const more = history.length > HISTORY_SHORT;
      toggle.hidden = !more;
      toggle.innerHTML = sessionsExpanded
        ? 'Show Less <span class="i18n-zh">收起</span>'
        : `Show More <span class="i18n-zh">展开更多</span> (${history.length - HISTORY_SHORT})`;
    }
    const rows = active.concat(visibleHistory);
    list.innerHTML = rows.map((x, idx) => {
      const [en, zh, cls] = SESSION_STATE[x.state] || SESSION_STATE.failed;
      const [sen] = SESSION_STAGE[x.stage] || [x.stage || '—'];
      const pct = SESSION_HAS_REPORT.has(x.state) ? 100 : (x.progress_percent || 0);
      const host = (x.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      const co = esc(x.company_name || '');
      let acts = '';
      if (SESSION_HAS_REPORT.has(x.state)) {
        acts = `
          <div class="qr-sess-actions">
            <button data-qr-sess-view="${co}">View Report / 查看</button>
            <button data-qr-sess-pdf="${co}">PDF</button>
            <button data-qr-sess-regen="${co}" data-qr-sess-site="${esc(x.website || '')}">
              Regenerate / 重新生成</button>
          </div>`;
      } else if (!SESSION_LIVE.has(x.state) && libRowFor(x.company_name)) {
        // The run produced nothing, but an earlier report survived it. Offer that
        // one explicitly, labelled, rather than leaving the row a dead end.
        acts = `
          <div class="qr-sess-actions">
            <button data-qr-sess-prev="${co}">View Previous Report / 查看上一版本</button>
            <button data-qr-sess-regen="${co}" data-qr-sess-site="${esc(x.website || '')}">
              Regenerate / 重新生成</button>
          </div>`;
      }
      const divider = (idx === active.length && active.length && visibleHistory.length)
        ? `<li class="qr-sess-head">Previous Research <span class="i18n-zh">历史研究</span></li>`
        : '';
      return `${divider}<li class="qr-sess-row${x.job_id === sessionSel ? ' is-selected' : ''}"
                  data-qr-sess="${esc(x.job_id)}">
        <div class="qr-sess-main">
          <div class="qr-sess-co">${co}</div>
          <div class="qr-sess-meta">${esc(sen)}${host ? ` · ${esc(host)}` : ''}
            ${x.model ? ` · ${esc(x.model)}` : ''} · ${esc(sessionStarted(x))}
            · ${esc(sessionElapsed(x))}</div>
          ${acts}
        </div>
        <div class="qr-sess-pct">${pct}%</div>
        <div class="qr-sess-state ${cls}">${esc(en)}<span class="i18n-zh"> ${esc(zh)}</span></div>
      </li>`;
    }).join('');
  }

  /* Poll only while something is live, and stop the moment nothing is. */
  function scheduleSessions() {
    clearTimeout(sessionTimer);
    if (!sessions.some((x) => SESSION_LIVE.has(x.state))) return;
    sessionTimer = setTimeout(refreshSessions, 3000);
  }

  async function refreshSessions() {
    const rows = await fetchSessions();
    if (rows) {
      sessions = rows;
      if (sessionSel && !sessions.some((x) => x.job_id === sessionSel)) sessionSel = null;
      renderSessions();
    }
    scheduleSessions();
  }

  /* Follow one session's detailed progress. Reads the engine while it still
     remembers the job, and falls back to the durable row when it does not. */
  async function followSession(jobId) {
    if (sessionFollowing === jobId) return;
    sessionFollowing = jobId;
    const row = sessions.find((x) => x.job_id === jobId);
    if (!row) return;
    const startedAt = new Date(row.started_at || Date.now()).getTime();
    renderProgress(jobRowToSnapshot(row), startedAt);
    while (sessionFollowing === jobId) {
      const live = sessions.find((x) => x.job_id === jobId);
      if (!live || !SESSION_LIVE.has(live.state)) {
        renderProgress(jobRowToSnapshot(live || row), startedAt);
        break;
      }
      const snap = await fetch(api(`/job/${encodeURIComponent(jobId)}`))
        .then((r) => r.json()).catch(() => null);
      if (sessionFollowing !== jobId) return;
      renderProgress(snap && snap.status ? snap : jobRowToSnapshot(live), startedAt);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  function selectSession(jobId) {
    sessionSel = jobId;
    const row = sessionRow(jobId);
    setWorkspace(row ? row.company_name : null);
    renderSessions();
    followSession(jobId);
    syncWorkspaceReport(row);
  }

  /* What belongs under the progress panel for this session.

     While a run is live the saved report is NOT the output of that run, so it is
     offered collapsed behind an explicit control instead of being mounted as if
     it were. When the session is finished, its report is simply the report. */
  function syncWorkspaceReport(row) {
    const prevrow = $('qr-prevrow');
    if (!row) { if (prevrow) prevrow.hidden = true; return; }
    const live = SESSION_LIVE.has(row.state);
    const hasSaved = !!libRowFor(row.company_name);
    if (prevrow) prevrow.hidden = !(live && hasSaved);
    if (live) {
      reportMode = 'previous';
      if ($('qr-report-card')) $('qr-report-card').style.display = 'none';
      return;
    }
    reportMode = 'current';
    if (hasSaved) openReport(row.company_name, true);
  }

  function wireSessions() {
    if (sessionsWired) return;
    const list = $('qr-sess-list');
    if (!list) return;
    sessionsWired = true;
    const openPrev = $('qr-prev-open');
    if (openPrev) {
      openPrev.addEventListener('click', () => {
        const row = sessionRow(sessionSel);
        if (!row) return;
        reportMode = 'previous';       // banner, so it cannot read as this run's output
        openReport(row.company_name, true);
      });
    }
    const toggle = $('qr-sess-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        sessionsExpanded = !sessionsExpanded;
        renderSessions();
      });
    }
    list.addEventListener('click', (e) => {
      const view = e.target.closest('[data-qr-sess-view]');
      if (view) { e.stopPropagation(); return openReport(view.dataset.qrSessView, true); }
      const pdf = e.target.closest('[data-qr-sess-pdf]');
      if (pdf) { e.stopPropagation(); return openPdf(pdf.dataset.qrSessPdf); }
      const prev = e.target.closest('[data-qr-sess-prev]');
      if (prev) {
        e.stopPropagation();
        const co = prev.dataset.qrSessPrev;
        setWorkspace(co);
        reportMode = 'previous';
        return openReport(co, true);
      }
      const regen = e.target.closest('[data-qr-sess-regen]');
      if (regen) {
        e.stopPropagation();
        // startOrAttachJob attaches to a live run rather than starting a second
        // one; duplicate protection is enforced again in Neon behind it.
        return regenerateSession(regen.dataset.qrSessRegen, regen.dataset.qrSessSite);
      }
      const row = e.target.closest('[data-qr-sess]');
      if (row) selectSession(row.dataset.qrSess);
    });
  }

  async function regenerateSession(company, website) {
    try {
      const { jobId, attached } = await startOrAttachJob(company, website);
      msg('qr-single-msg', attached
        ? `Already researching ${esc(company)} — reconnected. 已有研究进行中，已重新连接。`
        : `Research started for ${esc(company)}. 已开始研究。`, 'info');
      await refreshSessions();
      selectSession(jobId);
    } catch (e) {
      msg('qr-single-msg', esc(e.message), 'err');
    }
  }

  window.qwenResearchInit = async function init() {
    /* Re-opening the tab re-reads health as well as the library. Without this the
       banner and the Model field were frozen at whatever the first page load saw,
       so access being granted — or the engine coming back — left a stale warning
       on screen until a full refresh. One small GET; no model is called. */
    /* Sessions are re-read from Neon on EVERY entry to the tab, including the
       early return below. That is the whole point: leaving and coming back must
       not lose sight of a run, and it must not start a second one either. */
    if (window.__qrReady) {
      checkModels(); loadLibrary(); wireSessions(); refreshSessions(); return;
    }
    window.__qrReady = true;

    document.querySelectorAll('.qr-subtab').forEach((b) =>
      b.addEventListener('click', () => showSub(b.dataset.qrTab)));

    document.querySelectorAll('#qr-lang button').forEach((b) => {
      b.addEventListener('click', async () => {
        setLang(b.dataset.qrLang);
        renderLang();
        closePdf();
        if (current) await renderReport();
      });
    });

    $('qr-libsearch').addEventListener('input', renderLibrary);
    $('qr-liblist').addEventListener('change', (e) => {
      const cb = e.target.closest('.qr-libcb');
      if (!cb) return;
      if (cb.checked) librarySelection.add(cb.dataset.qrCo);
      else librarySelection.delete(cb.dataset.qrCo);
      syncLibrarySelectionUI();
    });
    $('qr-liblist').addEventListener('click', (e) => {
      const open = e.target.closest('[data-qr-open]');
      if (open) return openReport(open.dataset.qrOpen);
      const pdf = e.target.closest('[data-qr-pdf]');
      if (pdf) return openPdf(pdf.dataset.qrPdf);
      const menu = e.target.closest('.qr-menu button');
      if (!menu) return;
      const box = menu.closest('.qr-menu');
      if (box) box.open = false;
      if (menu.dataset.qrDl) { window.location = pdfUrl(menu.dataset.qrDl, false); return; }
      if (menu.dataset.qrDel) return deleteReport(menu.dataset.qrDel);
      if (menu.dataset.qrRefresh) {
        const co = menu.dataset.qrRefresh;
        if (!confirm(`Refresh research for ${co}?\n\nThis makes a new AI research call `
                   + `and consumes tokens.\n这将发起新的 AI 研究请求并消耗 tokens。`)) return;
        showSub('single');
        $('qr-company').value = co;
        $('qr-website').value = '';
        return startResearch(true);
      }
    });
    /* One open ⋯ menu at a time, closed by a click anywhere else. */
    document.addEventListener('click', (e) => {
      document.querySelectorAll('#qr-liblist .qr-menu[open]').forEach((d) => {
        if (!d.contains(e.target)) d.open = false;
      });
    });
    initLibraryActions();
    $('qr-pdfclose').addEventListener('click', closePdf);
    $('qr-view-pdf').addEventListener('click', () => current && openPdf(current.company));
    $('qr-dl-pdf').addEventListener('click', () => {
      if (current) window.location = pdfUrl(current.company, false);
    });
    $('qr-delete').addEventListener('click', () => current && deleteReport(current.company));
    $('qr-generate').addEventListener('click', () => startResearch(false));
    $('qr-model').addEventListener('change', renderStatusCards);

    $('qr-company').addEventListener('input', scheduleLookup);
    $('qr-company').addEventListener('change', () => lookupCompany($('qr-company').value));

    $('qr-lookup').addEventListener('click', (e) => {
      const b = e.target.closest('[data-qr-lk]');
      if (!b) return;
      const co = $('qr-lookup').dataset.company || $('qr-company').value.trim();
      if (b.dataset.qrLk === 'view')   return openReport(co);
      if (b.dataset.qrLk === 'pdf')    return openPdf(co);
      if (b.dataset.qrLk === 'delete') return deleteReport(co);
      if (b.dataset.qrLk === 'regen')  return startResearch(true);
    });

    /* There is deliberately no "Research anyway" control. Evidence quality
       annotates a report; it never blocks one. See the best-effort continuation
       invariant in the engine's CLAUDE.md. */
    $('qr-regen').addEventListener('click', () => {
      if (!current) return;
      $('qr-company').value = current.company;
      $('qr-website').value = current.report.website || '';
      startResearch(true);
    });

    initBatch();
    initPortfolio();
    renderLang();
    await checkModels();
    await loadLibrary();
    showSub('single');
  };

  function renderLang() {
    const l = getLang();
    document.querySelectorAll('#qr-lang button').forEach((b) =>
      b.classList.toggle('active', b.dataset.qrLang === l));
  }

  /* ── Existing-report lookup ──────────────────────────────────────────────
     Three states that were previously collapsed into one red message:
       existing report | new company | a real failure
     "No saved report for this company" is a LOOKUP result. It is not an error,
     and it must never stand in for the outcome of a research run. ── */

  let lookupSeq = 0;              // guards against a slow reply overwriting a fast one
  let lookupTimer = null;
  let lookupHit = null;           // the library row for the name in the box, if any

  function libRowFor(company) {
    const key = String(company || '').trim().toLowerCase();
    if (!key) return null;
    return library.find((r) => String(r.companyName || '').trim().toLowerCase() === key) || null;
  }

  function setGenerateLabel(existing) {
    const b = $('qr-generate');
    if (!b) return;
    b.innerHTML = existing
      ? 'Regenerate Research <span class="i18n-zh">重新生成研究</span>'
      : 'Generate Research <span class="i18n-zh">生成研究报告</span>';
  }

  function renderLookup(state, row, company) {
    const box = $('qr-lookup');
    if (!box) return;
    box.classList.remove('is-existing', 'is-new');
    if (state === 'none') { box.hidden = true; box.innerHTML = ''; setGenerateLabel(false); return; }
    box.hidden = false;
    if (state === 'existing') {
      box.classList.add('is-existing');
      const facts = [];
      if (row && row.researchedAt) facts.push(`Last researched / 上次研究 <b>${esc(reportDate(row.researchedAt))}</b>`);
      if (row && row.modelLabel) facts.push(`Model / 模型 <b>${esc(row.modelLabel)}</b>`);
      if (row && row.sourceCount != null) facts.push(`Sources / 来源 <b>${esc(String(row.sourceCount))}</b>`);
      box.innerHTML =
        '<div class="qr-lk-title">Existing Report <span class="i18n-zh">已有报告</span></div>'
        + `<div class="qr-lk-facts">${facts.join('')}</div>`
        + `<div class="qr-lk-acts">
             <button data-qr-lk="view">View Report / 查看报告</button>
             <button data-qr-lk="pdf">View PDF / 查看PDF</button>
             <button data-qr-lk="regen">Regenerate / 重新生成</button>
             <button class="del" data-qr-lk="delete">Delete Report / 删除报告</button>
           </div>`;
      box.dataset.company = company;
      setGenerateLabel(true);
      return;
    }
    box.classList.add('is-new');
    box.innerHTML = '<div class="qr-lk-title">New company — ready to research.'
      + '<span class="i18n-zh">新公司 — 可以开始研究。</span></div>';
    box.dataset.company = company;
    setGenerateLabel(false);
  }

  /** Look the company up. The in-memory library answers most cases for free;
   *  /exists settles the rest server-side with the same normaliser the writes
   *  use. Neither is a search and neither calls a model. */
  async function lookupCompany(company) {
    const name = String(company || '').trim();
    const seq = ++lookupSeq;
    if (!name) { lookupHit = null; renderLookup('none'); return; }
    const local = libRowFor(name);
    if (local) { lookupHit = local; renderLookup('existing', local, name); return; }
    let exists = false;
    try {
      const d = await fetch(api(`/exists?companies=${encodeURIComponent(name)}`)).then((r) => r.json());
      // A legitimate `false` must not fall through to a fallback: read the key
      // we asked about, and only then the single entry the server keyed itself.
      const bag = (d && typeof d === 'object') ? d : {};
      const entries = Object.entries(bag);
      exists = Object.prototype.hasOwnProperty.call(bag, name) ? !!bag[name]
             : entries.length === 1 ? !!entries[0][1] : false;
    } catch (e) { /* lookup is advisory; never block the user on it */ }
    if (seq !== lookupSeq) return;                       // a newer keystroke won

    /* Before deciding "existing" or "new", ask whether a run is under way. The
       answer comes from Neon, so it is the same whether the user refreshed,
       switched tabs, or closed the browser an hour ago. */
    const { active } = await jobForCompany(name);
    if (seq !== lookupSeq) return;
    if (active) {
      renderLookup('none');
      msg('qr-single-msg',
          `Research already in progress for ${esc(name)} — reconnected. `
          + '已有研究进行中，已重新连接。', 'info');
      resumeJob(name, active);
      return;
    }

    lookupHit = exists ? (libRowFor(name) || { companyName: name }) : null;
    renderLookup(exists ? 'existing' : 'new', lookupHit, name);
  }

  /* Reattach to a run that is already going, without starting anything. */
  let resuming = null;
  async function resumeJob(company, row) {
    if (resuming === row.job_id) return;
    resuming = row.job_id;
    const startedAt = new Date(row.started_at || Date.now()).getTime();
    if ($('qr-lookup')) $('qr-lookup').hidden = true;
    renderProgress(jobRowToSnapshot(row), startedAt);
    try {
      while (true) {
        const snap = await fetch(api(`/job/${encodeURIComponent(row.job_id)}`))
          .then((r) => r.json()).catch(() => null);
        if (snap && snap.status) {
          renderProgress(snap, startedAt);
          if (snap.status !== 'running') break;
        } else {
          // The engine forgot it. The durable row is the remaining truth.
          const { active, latest } = await jobForCompany(company);
          const row2 = active || latest;
          renderProgress(jobRowToSnapshot(row2 || row), startedAt);
          if (!active) break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      const { latest } = await jobForCompany(company);
      if (latest && latest.status === 'completed') {
        msg('qr-single-msg', 'Research complete. 研究完成。', 'info');
        await loadLibrary();
        await openReport(company, true);
      } else if (latest) {
        msg('qr-single-msg', `<strong>Research did not complete.</strong> `
            + `<br><span>${esc(latest.error || latest.status)}</span>`, 'err');
      }
    } finally { resuming = null; }
  }

  function scheduleLookup() {
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(() => lookupCompany($('qr-company').value), 450);
  }

  /* ── Live research progress ─────────────────────────────────────────────
     Rendered from the job snapshot the polling loop ALREADY fetches. It issues
     no request of its own and triggers no model call.

     Every step below maps to a stage the engine actually emits, or to a phase
     or model-status transition. The engine reports retrieval as aggregate
     stages and returns the synthesis in one block, so there are deliberately no
     per-topic search steps and no per-section streaming: inventing either would
     be a progress bar that reports on itself rather than on the work. ── */

  const PROG_STEPS = [
    { k: 'validate',  en: 'Validating company',            zh: '验证公司' },
    { k: 'official',  en: 'Discovering official website',  zh: '查找官网' },
    { k: 'queries',   en: 'Planning search areas',         zh: '规划检索范围' },
    { k: 'site',      en: 'Reading the official site',     zh: '读取官网页面' },
    { k: 'search',    en: 'Searching across research areas', zh: '跨领域联网检索' },
    // optional:true — enrichment. It may fail without stopping the report, and a
    // failure must not stall the bar at the step where it happened.
    { k: 'financial', en: 'Financial sourcing',            zh: '财务信息来源', optional: true },
    { k: 'contacts',  en: 'Contact enrichment',            zh: '关键决策人',   optional: true,
      also: ['apollo'] },
    { k: 'dedupe',    en: 'Deduplicating evidence',        zh: '证据去重' },
    { k: 'evidence',  en: 'Building evidence set',         zh: '整理证据' },
    { k: 'synthesis', en: 'Generating research',           zh: '生成研究报告' },
    { k: 'pdf',       en: 'Generating PDF',                zh: '生成PDF' },
    { k: 'save',      en: 'Saving report',                 zh: '保存报告' },
  ];

  /* A stage message the engine reports as a real failure, as opposed to one it
     reports as "skipped, and here is why" — those must not read as errors. */
  const PROG_FAIL = /\b(failed|failure|error|unreachable|timed out|blocked)\b/i;
  const PROG_SKIP = /not configured|not forced|not needed|no -|not used|unlisted/i;

  function progModel(job) {
    const ids = Object.keys(job.models || {});
    if (!ids.length) return null;
    const active = ids.find((i) => (job.models[i] || {}).status === 'generating');
    return job.models[active || ids[0]] || null;
  }

  function progLastFor(job, key, also) {
    const keys = [key].concat(also || []);
    const hits = (job.stages || []).filter((s) => keys.includes(s.stage));
    return hits.length ? hits[hits.length - 1] : null;
  }

  /** State for one step: done | active | failed | skipped | todo, plus a note. */
  function progState(job, step) {
    const m = progModel(job) || {};
    const phase = job.phase;
    const retrievalOver = phase === 'synthesis' || phase === 'done' || phase === 'needs_review';
    const seen = (k) => !!progLastFor(job, k);

    if (step.k === 'validate') {
      const hit = progLastFor(job, 'discover') || progLastFor(job, 'official');
      if (hit || seen('queries') || retrievalOver) return { st: 'done' };
      return { st: job.status === 'running' ? 'active' : 'todo' };
    }
    if (step.k === 'synthesis') {
      if (m.status === 'complete') return { st: 'done' };
      if (['failed', 'timeout', 'access_denied'].includes(m.status)) {
        return { st: 'failed', note: m.error || m.status };
      }
      if (phase === 'synthesis') return { st: 'active', indeterminate: true };
      return { st: 'todo' };
    }
    if (step.k === 'pdf') {
      if (m.result && m.result.pdf) return { st: 'done' };
      if (m.status === 'complete') return { st: 'active' };
      return { st: 'todo' };
    }
    if (step.k === 'save') {
      if (m.persisted) return { st: 'done' };
      if (m.persistError) return { st: 'failed', note: m.persistError };
      if (m.status === 'complete') return { st: 'active' };
      return { st: 'todo' };
    }
    if (step.k === 'evidence') {
      if (seen('quality') || retrievalOver) return { st: 'done' };
      if (seen('evidence')) return { st: 'active' };
      return { st: 'todo' };
    }

    const hit = progLastFor(job, step.k, step.also);
    if (hit) {
      const text = hit.message || '';
      // The engine states the outcome explicitly on some stages; an explicit
      // verdict always beats inferring one from keywords.
      const verdict = /^(OK|WARN)\s+/i.exec(text);
      if (verdict) {
        const body = text.replace(/^(OK|WARN)\s+/i, '');
        return verdict[1].toUpperCase() === 'OK'
          ? { st: 'done', note: body }
          : { st: step.optional ? 'warned' : 'failed', note: body };
      }
      if (PROG_FAIL.test(text) && !PROG_SKIP.test(text)) {
        return { st: step.optional ? 'warned' : 'failed', note: text };
      }
      if (PROG_SKIP.test(text)) return { st: 'skipped', note: text };
      return { st: 'done', note: text };
    }
    if (retrievalOver) return { st: 'skipped' };
    return { st: 'todo' };
  }

  /* The one percentage. Order of truth: a terminal state is 100 or its last
     persisted value; otherwise the persisted progress_percent for this job;
     otherwise the engine snapshot's own figure. Never recomputed from stages. */
  function canonicalPct(job) {
    if (!job) return 0;
    if (job.status === 'done') return 100;
    const row = job._durable || sessionRow(job._jobId || jobIdOf(job));
    const p = row && row.progress_percent;
    if (typeof p === 'number') return Math.max(0, Math.min(100, p));
    if (typeof job._pct === 'number') return job._pct;
    return 0;
  }

  function jobIdOf(job) { return (job && job._jobId) || sessionSel || null; }

  function sessionRow(jobId) {
    return jobId ? sessions.find((x) => x.job_id === jobId) || null : null;
  }

  const PROG_MARK = { done: '✓', active: '→', failed: '✕', warned: '⚠', skipped: '○', todo: '○' };

  function fmtElapsed(sec) {
    if (sec == null) return null;
    const s = Math.max(0, Math.round(sec));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  function renderProgress(job, startedAt) {
    const box = $('qr-progress');
    if (!box) return;
    box.hidden = false;
    const states = PROG_STEPS.map((step) => ({ step, ...progState(job, step) }));
    /* The step list stays - it is the useful part. The HEADLINE NUMBER does not
       come from it. The engine reports a percentage for every stage and the CRM
       writes it to Neon on each callback, so Neon is already authoritative; the
       browser deriving its own figure over a different set of units (12 UI steps
       vs the engine's 16) is what made Sessions and Progress disagree. */
    const pct = canonicalPct(job);
    const running = job.status === 'running' || job.status === undefined;
    // The engine reports a stage as it FINISHES, so between two reports nothing
    // is explicitly active. The step the run must be working on is the first one
    // not yet settled — showing that beats falling back to "Starting…".
    let active = states.find((x) => x.st === 'active');
    if (!active && running) {
      active = states.find((x) => x.st === 'todo');
      if (active) active.st = 'active';
    }
    const failed = states.find((x) => x.st === 'failed');
    const finished = job.status === 'done' || job.status === 'error' || job.status === 'needs_review';

    box.classList.toggle('is-complete', job.status === 'done');
    box.classList.toggle('is-failed', job.status === 'error');

    const fill = $('qr-prog-fill');
    const indeterminate = !!(active && active.indeterminate) && !finished;
    fill.classList.toggle('is-indeterminate', indeterminate);
    /* A durable snapshot carries the percentage Neon recorded. Prefer it: the
       derived number counts settled steps, and a reconstructed run has only the
       stages we could infer from the last one persisted. */
    const shownPct = pct;
    fill.style.width = `${shownPct}%`;
    $('qr-prog-pct').textContent = `${shownPct}%`;

    const now = $('qr-prog-now');
    if (job.status === 'done') {
      now.innerHTML = '✓ Research completed<span class="zh">研究完成</span>';
    } else if (job.status === 'error') {
      now.innerHTML = `Research failed during ${esc(job.phase || 'the run')}.`
        + '<span class="zh">研究运行失败。以下步骤保留以便排查。</span>';
    } else if (job.status === 'needs_review') {
      now.innerHTML = 'Retrieval incomplete — needs review<span class="zh">检索不完整，需人工确认</span>';
    } else if (active) {
      const live = progLastFor(job, active.step.k);
      now.innerHTML = `${esc(active.step.en)}…<span class="zh">${esc(active.step.zh)}…</span>`
        + (live && live.message ? `<span class="zh">${esc(live.message)}</span>` : '');
    } else {
      now.innerHTML = 'Starting…<span class="zh">正在开始…</span>';
    }
    // Re-derive after the fallback so the list marker matches the headline.
    if (active && active.indeterminate === undefined) active.indeterminate = false;

    $('qr-prog-steps').innerHTML = states.map((x) => {
      const cls = x.st === 'done' ? 'is-done' : x.st === 'active' ? 'is-active'
                : x.st === 'failed' ? 'is-failed' : x.st === 'warned' ? 'is-warned' : '';
      // Prefer the engine's own sentence; the generic line is only a fallback
      // for a stage that reported nothing useful.
      // The row already names the step; do not repeat it in the detail.
      const detail = String(x.note || '')
        .replace(/^(Apollo|CRM):\s*/i, '')
        .replace(/^Contact enrichment\s*[-–—]\s*/i, '')
        .slice(0, 150);
      const note = x.st === 'warned'
                 ? ` — ${esc(detail || 'unavailable, continuing with available data / 不可用，使用现有数据继续')}`
                 : x.st === 'failed' ? ` — ${esc(detail)}`
                 : (x.st === 'skipped' || x.st === 'done') && detail && x.step.optional
                   ? ` — ${esc(detail)}` : '';
      return `<li class="${cls}"><span class="qr-mark">${PROG_MARK[x.st]}</span>`
           + `<span>${esc(x.step.en)} / ${esc(x.step.zh)}`
           + (note ? `<span class="qr-note">${note}</span>` : '') + '</span></li>';
    }).join('');

    // Counters: only values the snapshot actually carries.
    const m = progModel(job) || {};
    const bits = [];
    const srcs = (job.sources || []).length;
    if (srcs) bits.push(`Sources found / 来源 <b>${srcs}</b>`);
    const q = (job.search_queries || []).length;
    if (q) bits.push(`Search queries / 检索式 <b>${q}</b>`);
    if (m.label) bits.push(`Model / 模型 <b>${esc(m.label)}</b>`);
    const el = fmtElapsed(job.wall_seconds != null ? job.wall_seconds
                          : (Date.now() - startedAt) / 1000);
    if (el) bits.push(`Elapsed / 用时 <b>${el}</b>`);
    // Tokens appear only once the model has actually reported them.
    const tu = m.token_usage || {};
    if (tu.total != null) bits.push(`Tokens <b>${Number(tu.total).toLocaleString()}</b>`);
    if (m.fallback_used) bits.push(`<b>Fell back to ${esc(m.model_used || '?')}</b>`);
    $('qr-prog-counters').innerHTML = bits.join('');
  }

  function progressSummary(job) {
    const m = progModel(job) || {};
    const tu = m.token_usage || {};
    const parts = [`${(job.sources || []).length} sources`];
    if (tu.total != null) parts.push(`${Number(tu.total).toLocaleString()} tokens`);
    if (job.wall_seconds != null) parts.push(`${job.wall_seconds} sec`);
    return parts.join(' · ');
  }

  /* ── Research (blocked while models need activation) ── */
  /* Where a run lives is NEON, not this tab. sessionStorage could not answer
     "is anything running for this company" after a browser restart, and two
     tabs disagreed with each other. The server owns the answer now. */
  async function jobForCompany(company) {
    if (!company) return { active: null, latest: null };
    try {
      return await fetch(api(`/job-for-company?company=${encodeURIComponent(company)}`))
        .then((r) => r.json());
    } catch (e) { return { active: null, latest: null }; }
  }

  /** The durable record for a company that is still being researched. */
  async function findRunningJob(company) {
    const { active } = await jobForCompany(company);
    if (!active) return null;
    let snap = null;
    try {
      snap = await fetch(api(`/job/${encodeURIComponent(active.job_id)}`)).then((r) => r.json());
    } catch (e) { /* the engine may have restarted; the durable row still stands */ }
    return { id: active.job_id, snap: snap && snap.status ? snap : jobRowToSnapshot(active) };
  }

  /* When the engine no longer knows the job — it restarted — the durable row is
     still enough to draw the panel, so the user sees state rather than nothing. */
  /* Reconstruction lives in job-snapshot.js so the same code the page runs is
     the code the tests exercise. It rebuilds the step list from the PERSISTED
     stage and takes the percentage from the PERSISTED progress_percent. */
  const DONE_STATUSES = JobSnapshot.DONE_STATUSES;
  const DEAD_STATUSES = JobSnapshot.DEAD_STATUSES;
  const jobRowToSnapshot = JobSnapshot.jobRowToSnapshot;

  function reviewReasons(job) {
    const q = job.quality || {};
    const list = (q.reasons || []).slice(0, 4);
    return list.length ? list : [job.message || 'Retrieval did not return enough evidence.'];
  }

  async function startResearch(isRegen) {
    const company = $('qr-company').value.trim();
    if (!company) return msg('qr-single-msg', 'Company name is required. 请输入公司名称。', 'err');
    await checkModels();
    if (blockIfNoModel('qr-single-msg')) return;

    // The lookup panel belongs to the idle state; the run owns the screen now.
    if ($('qr-lookup')) $('qr-lookup').hidden = true;
    setWorkspace(company);
    const hadReport = libRowFor(company) ? { company } : null;
    // The saved report is NOT this run's output. Collapse it behind the control
    // and label it if the user opens it.
    reportMode = 'previous';
    if ($('qr-report-card')) $('qr-report-card').style.display = 'none';
    if ($('qr-prevrow')) $('qr-prevrow').hidden = !hadReport;
    const startedAt = Date.now();
    let last = null;
    $('qr-generate').disabled = true;
    // Visible before the POST, so a failing POST still shows where it stopped.
    renderProgress({ status: 'running', phase: 'retrieval', stages: [], models: {} }, startedAt);
    msg('qr-single-msg', 'Starting research… 正在开始研究…', 'info');

    try {
      let jobId;
      const running = await findRunningJob(company);
      if (running) {
        // Never pay twice for the same company.
        jobId = running.id;
        msg('qr-single-msg',
            'Reattached to the run already in progress for this company. 已接入正在进行的研究。', 'info');
        renderProgress(running.snap, startedAt);
      } else {
        const start = await fetch(api('/research'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company, website: $('qr-website').value.trim(),
                                 model: $('qr-model').value }),
        }).then((r) => r.json());
        if (start.error) throw new Error(start.error);
        if (!start.job_id) throw new Error('The research service did not return a job id.');
        jobId = start.job_id;
        // Show the run in Research Sessions immediately, and select it, so the
        // user can navigate away and still find it on the way back.
        refreshSessions().then(() => selectSession(jobId));
      }

      while (true) {
        const snap = await fetch(api(`/job/${jobId}`)).then((r) => r.json());
        last = snap;
        renderProgress(snap, startedAt);
        if (snap.modelUnavailable) { blockIfNoModel('qr-single-msg'); return; }
        if (snap.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 1500));
      }

      // ---- Terminal states, each said in its own words -------------------
      if (last.status === 'error') {
        throw new Error(last.message || modelErrorOf(last) || 'Research failed.');
      }
      /* needs_review no longer exists: thin evidence reaches synthesis in
         zero-grounding mode and the run completes with limitations. This branch
         only catches an older engine still reporting the old state, and it never
         offers "Research anyway" - researching anyway IS the behaviour now. */
      if (last.status === 'needs_review') {
        const reasons = reviewReasons(last).map((r) => `<li>${esc(r)}</li>`).join('');
        msg('qr-single-msg',
            '<strong>Limited verified public evidence was available for this company.</strong>'
            + '<br><span>该公司可验证的公开信息有限，部分章节可能不完整。</span>'
            + `<ul style="margin:6px 0 0 18px;">${reasons}</ul>`
            + (hadReport ? '<div style="margin-top:6px;">The existing report is unchanged. '
                           + '现有报告未被修改。</div>' : ''), 'warn');
        return;
      }
      if (last.status === 'synthesis_failed') {
        // The one genuinely fatal outcome. Retrieval is preserved on the engine.
        msg('qr-single-msg',
            '<strong>Report generation failed.</strong> 报告生成失败。<br>'
            + `<span>${esc(last.message || 'Every synthesis model failed.')}</span>`
            + '<div style="margin-top:6px;">Research evidence was retrieved and is '
            + 'preserved. 检索到的证据已保留。</div>', 'err');
        return;
      }
      const mErr = modelErrorOf(last);
      if (mErr) throw new Error(mErr);

      const limited = !!(last.zero_grounding
                         || (last.quality && last.quality.degraded)
                         || last.outcome === 'completed_with_limitations');
      msg('qr-single-msg', limited
        ? '<strong>Completed with limitations.</strong> 已完成（有限制）。<br>'
          + '<span>Limited verified public evidence was available for this company. '
          + 'Some sections may therefore be less complete. '
          + '该公司可验证的公开信息有限，部分章节可能不完整。</span>'
        : `Research complete. 研究完成。 ${esc(progressSummary(last))}`,
        limited ? 'warn' : 'info');
      await loadLibrary();
      reportMode = 'current';                 // the new report is the report now
      if ($('qr-prevrow')) $('qr-prevrow').hidden = true;
      await openReport(company, true);
    } catch (e) {
      if (last) renderProgress({ ...last, status: 'error' }, startedAt);
      // The real failure, never a lookup message standing in for one.
      msg('qr-single-msg', `<strong>Research failed.</strong> 研究失败。<br><span>${esc(e.message)}</span>`
          + (hadReport ? '<div style="margin-top:6px;">The existing report is unchanged. '
                         + '现有报告未被修改。</div>' : ''), 'err');
      // A regenerate that fails leaves the saved report untouched and reachable,
      // but it stays labelled as the previous version rather than this run's work.
      if (hadReport && $('qr-prevrow')) $('qr-prevrow').hidden = false;
    } finally {
      $('qr-generate').disabled = false;
      refreshSessions();
    }
  }

  /** The model-level error, when the job finished but the model did not. */
  function modelErrorOf(job) {
    const m = progModel(job) || {};
    if (m.status === 'complete') return null;
    if (m.error) return m.error;
    if (m.status === 'timeout') return 'The model timed out.';
    if (m.status === 'access_denied') return MODEL_MSG;
    if (m.status === 'failed') return 'The model did not return a report.';
    return null;
  }


  /* ── Batch ─────────────────────────────────────────────────────────────
     Rows are keyed by company and updated in place. A row being edited is not
     touched at all, so polling cannot move the caret, clear a selection or
     overwrite unsaved text. */
  const rowEls = new Map();
  const CELLS = 9;
  const setHTML = (el, html) => { if (el.__h !== html) { el.__h = html; el.innerHTML = html; } };
  const idx = (co) => batchItems.findIndex((x) => x.company === co);

  /* Stage keys the engine reports, in the words a reader wants. */
  const ROW_STAGE = {
    queued: ['Queued', '排队中'], discover: ['Validating', '验证中'],
    official: ['Validating', '验证中'], listing: ['Validating', '验证中'],
    queries: ['Searching', '搜索中'], site: ['Searching', '搜索中'],
    search: ['Searching', '搜索中'], financial: ['Searching', '搜索中'],
    apollo: ['Contacts', '联系人'], contacts: ['Contacts', '联系人'],
    dedupe: ['Building evidence', '整理证据'], evidence: ['Building evidence', '整理证据'],
    quality: ['Building evidence', '整理证据'], synthesis: ['Generating', '生成中'],
    model: ['Generating', '生成中'], pdf: ['Generating PDF', '生成PDF'],
    save: ['Saving', '保存中'], done: ['Completed', '已完成'],
    cancelled: ['Cancelled', '已取消'],
    completed: ['Completed', '已完成'], interrupted: ['Interrupted', '已中断'],
    failed: ['Failed', '失败'],
  };

  function statusBadge(it) {
    /* A row being regenerated shows the RUN, not the stale report status: the
       point of the button is to see that something is happening. */
    const job = rowJobs.get(it.company);
    if (job && job.status === 'running' && job.stage === 'queued' && !job.jobId) {
      return '<span class="qr-badge qr-b-Pending">Queued / 排队中</span>';
    }
    if (job && job.status === 'cancelled') {
      return '<span class="qr-badge qr-b-Pending">Cancelled / 已取消</span>';
    }
    if (job && job.status === 'running') {
      const [en, zh] = ROW_STAGE[job.stage] || ['Researching', '研究中'];
      const pct = Math.max(0, Math.min(100, job.pct || 0));
      return `<span class="qr-badge qr-b-Searching">Researching / 研究中${pct ? ' ' + pct + '%' : ''}</span>`
        + `<div class="qr-rowprog"><span class="bar"><i style="width:${pct}%"></i></span>`
        + `<span class="pct">${pct}%</span></div>`
        + `<div class="qr-rowstage">${esc(en)} / ${esc(zh)}</div>`;
    }
    if (job && job.status === 'completed') {
      // The run's own outcome, not whatever the report lookup last said.
      return '<span class="qr-badge qr-b-Completed">Completed / 已完成</span>';
    }
    if (job && (job.status === 'interrupted' || job.status === 'failed')) {
      const [en, zh] = ROW_STAGE[job.status];
      return `<span class="qr-badge qr-b-Failed">${en} / ${zh}</span>`
        + (job.error ? `<div class="qr-rowstage">${esc(String(job.error).slice(0, 90))}</div>` : '');
    }
    const st = it.status || 'Pending';
    const zh = { Completed: '已完成', 'Existing Report': '已有报告', Failed: '失败',
      'Timed Out': '超时', Pending: '待处理', Searching: '检索中', Generating: '生成中',
      'PDF Generating': '生成PDF', Skipped: '已跳过' }[st] || '';
    return `<span class="qr-badge qr-b-${st.replace(/\s+/g, '')}">${esc(st)}${zh ? ' / ' + zh : ''}</span>`;
  }

  function websiteCell(it) {
    if (it._editUrl) {
      return `<div class="qr-rowedit">
        <input type="url" data-qr-edit="url" data-co="${esc(it.company)}" value="${esc(it.website || '')}" placeholder="https://…">
        <button data-qr-act="cancelUrl" data-co="${esc(it.company)}">Cancel / 取消</button>
        <button data-qr-act="saveUrl" data-co="${esc(it.company)}">Save / 保存</button></div>`;
    }
    if (it._editCompany) {
      return `<div class="qr-rowedit">
        <input type="text" data-qr-edit="company" data-co="${esc(it.company)}" value="${esc(it.company)}">
        <input type="url" data-qr-edit="companyUrl" data-co="${esc(it.company)}" value="${esc(it.website || '')}" placeholder="https://…">
        <button data-qr-act="cancelCompany" data-co="${esc(it.company)}">Cancel / 取消</button>
        <button data-qr-act="saveCompany" data-co="${esc(it.company)}">Save / 保存</button></div>`;
    }
    return `${it.website ? `<a href="${esc(it.website)}" target="_blank" rel="noopener">${esc(it.website.replace(/^https?:\/\//, ''))}</a>` : '—'}
      <div class="qr-rowacts">
        <button data-qr-act="editUrl" data-co="${esc(it.company)}">Edit URL / 修改官网</button>
        <button data-qr-act="editCompany" data-co="${esc(it.company)}">Edit Company / 修改公司</button></div>`;
  }

  function actionsCell(it) {
    if (!it._hasReport) return '<span style="opacity:.5">—</span>';
    const co = esc(it.company);
    return `<div class="qr-acts">
      <button data-qr-act="view" data-co="${co}">View / 查看</button>
      <button data-qr-act="pdf" data-co="${co}">PDF / 查看PDF</button>
      <button data-qr-act="regen" data-co="${co}">Regenerate / 重新生成</button>
      <button data-qr-act="del" data-co="${co}" class="del">Delete / 删除</button></div>`;
  }

  function renderBatchSelCount() {
    const el = $('qr-batch-selcount');
    if (!el) return;
    const n = batchItems.filter((i) => i.selected).length;
    el.textContent = n ? `${n} of ${batchItems.length} selected / 已选 ${n} 家` : '';
  }

  function renderBatch() {
    const tb = document.querySelector('#qr-batchtable tbody');
    renderBatchSelCount();
    if (!batchItems.length) {
      rowEls.clear();
      tb.innerHTML = `<tr><td colspan="9" class="qr-empty">Upload a company list to begin.
        <span class="i18n-zh">上传公司列表后开始批量研究。</span></td></tr>`;
      tb.__empty = true;
      return;
    }
    if (tb.__empty || tb.querySelector('td.qr-empty')) { tb.innerHTML = ''; tb.__empty = false; }
    bindBatch();
    const seen = new Set();
    batchItems.forEach((it) => {
      seen.add(it.company);
      let tr = rowEls.get(it.company);
      if (!tr) {
        tr = document.createElement('tr');
        for (let c = 0; c < CELLS; c++) tr.appendChild(document.createElement('td'));
        const box = document.createElement('input');
        box.type = 'checkbox'; box.dataset.co = it.company;
        tr.children[0].appendChild(box);
        [5, 6, 7].forEach((i) => { tr.children[i].className = 'num'; });
        tb.appendChild(tr); rowEls.set(it.company, tr);
      }
      const editing = it._editUrl || it._editCompany;
      const box = tr.children[0].querySelector('input');
      if (box && document.activeElement !== box && box.checked !== !!it.selected) box.checked = !!it.selected;
      const mode = it._editUrl ? 'u' : it._editCompany ? 'c' : 'v';
      if (editing) {
        if (mode !== tr.dataset.mode) { tr.dataset.mode = mode; setHTML(tr.children[2], websiteCell(it)); }
        return;                                    // leave an editing row alone
      }
      tr.dataset.mode = mode;
      setHTML(tr.children[1], esc(it.company));
      setHTML(tr.children[2], websiteCell(it));
      setHTML(tr.children[3], statusBadge(it) + (it.error ? `<div style="font-size:.72rem;color:var(--color-danger)">${esc(it.error)}</div>` : ''));
      setHTML(tr.children[4], esc(it.model || '—'));
      setHTML(tr.children[5], String(it.sources ?? '—'));
      setHTML(tr.children[6], it.tokens ? Number(it.tokens).toLocaleString() : '—');
      setHTML(tr.children[7], it.seconds != null ? it.seconds + 's' : '—');
      setHTML(tr.children[8], actionsCell(it));
    });
    for (const [co, tr] of [...rowEls.entries()]) {
      if (!seen.has(co)) { tr.remove(); rowEls.delete(co); }
    }
  }

  function bindBatch() {
    const tb = document.querySelector('#qr-batchtable tbody');
    if (tb.__bound) return;
    tb.__bound = true;
    tb.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-qr-act]');
      if (b) rowAction(b.dataset.qrAct, b.dataset.co);
    });
    tb.addEventListener('change', (e) => {
      const box = e.target.closest('input[type="checkbox"][data-co]');
      if (!box) return;
      const i = idx(box.dataset.co);
      if (i >= 0) batchItems[i].selected = box.checked;
      renderBatchSelCount();
    });
  }

  const readInput = (sel, co) => {
    const el = document.querySelector(`[data-qr-edit="${sel}"][data-co="${CSS.escape(co)}"]`);
    return el ? el.value.trim() : '';
  };

  async function rowAction(act, co) {
    const i = idx(co);
    if (i < 0) return;
    const it = batchItems[i];
    if (act === 'editUrl') { it._editUrl = true; return renderBatch(); }
    if (act === 'cancelUrl') { it._editUrl = false; return renderBatch(); }
    if (act === 'editCompany') { it._editCompany = true; return renderBatch(); }
    if (act === 'cancelCompany') { it._editCompany = false; return renderBatch(); }
    if (act === 'saveUrl') { it.website = readInput('url', co); it._editUrl = false; return renderBatch(); }
    if (act === 'saveCompany') {
      const name = readInput('company', co) || it.company;
      const url = readInput('companyUrl', co);
      rowEls.delete(it.company);
      document.querySelectorAll(`#qr-batchtable tbody tr`).forEach((tr) => { if (!tr.children[1]) tr.remove(); });
      it.company = name; it.website = url; it._editCompany = false;
      await refreshExisting();
      return renderBatch();
    }
    if (act === 'view') return openReport(co);
    if (act === 'pdf') return openPdf(co);
    if (act === 'del') { await deleteReport(co); return refreshExisting(); }
    if (act === 'regen') {
      await checkModels();
      if (blockIfNoModel('qr-batch-msg')) return;
      // The SAME durable single-company path Single Company uses. Batch used to
      // start a one-row sub-batch here, which is a second job implementation
      // with none of the durability or duplicate protection.
      return regenerateRow(it);
    }
  }

  /* ── Row-level regeneration, on the durable job ─────────────────────────
     One implementation, shared with Single Company: the CRM claims a durable
     job, refuses a second one for a company already running, and the engine's
     callback persists only on success. The row shows the progress. */

  const rowJobs = new Map();          // company -> { jobId, stage, pct, status }

  function setRowJob(company, patch) {
    const cur = rowJobs.get(company) || {};
    rowJobs.set(company, { ...cur, ...patch });
    renderBatch();
  }

  /** Start research for one company, or attach to the run already going.
   *  The single source of "begin research" for every entry point. */
  async function startOrAttachJob(company, website) {
    const running = await findRunningJob(company);
    if (running) return { jobId: running.id, attached: true };
    const start = await fetch(api('/research'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company, website: website || '',
                             model: $('qr-batchmodel').value }),
    }).then((r) => r.json());
    if (start.error) throw new Error(start.error);
    if (!start.job_id) throw new Error('The research service did not return a job id.');
    return { jobId: start.job_id, attached: !!start.attached };
  }

  async function regenerateRow(it) {
    const company = it.company;
    if ((rowJobs.get(company) || {}).status === 'running') return;   // already shown
    setRowJob(company, { status: 'running', stage: 'queued', pct: 0 });
    msg('qr-batch-msg', '');
    try {
      const { jobId, attached } = await startOrAttachJob(company, it.website);
      if (attached) {
        msg('qr-batch-msg',
            `${esc(company)}: attached to the run already in progress. 已接入正在进行的研究。`, 'info');
      }
      await followRowJob(company, jobId);
    } catch (e) {
      setRowJob(company, { status: 'failed', stage: 'failed', error: e.message });
      msg('qr-batch-msg', `${esc(company)}: ${esc(e.message)}`, 'err');
    }
  }

  /* ── Bulk generation, on the same durable job ───────────────────────────
     One durable job per company, started one at a time. There is no separate
     batch research implementation any more: Generate Selected, Generate All and
     Retry Failed all queue the same per-company job that Single Company and row
     Regenerate use, so each company persists independently through the engine
     callback and a closed browser cannot lose any of them.

     Sequential on purpose: it bounds cost and load, and it means stopping the
     queue actually stops something. */
  let queueRunning = false;
  let queueCancelled = false;

  /** Rows worth retrying: the run failed, was interrupted, or never produced a
   *  report. A completed company is never re-run by Retry Failed. */
  function needsRetry(it) {
    const job = rowJobs.get(it.company) || {};
    if (['failed', 'interrupted', 'cancelled'].includes(job.status)) return true;
    if (job.status === 'completed' || job.status === 'running') return false;
    return ['Failed', 'Timed Out'].includes(it.status);
  }

  async function runBatchQueue(items) {
    if (!items.length) {
      return msg('qr-batch-msg', 'No companies selected. 未选择公司。', 'err');
    }
    if (queueRunning) {
      return msg('qr-batch-msg', 'A batch is already running. 批量任务已在进行中。', 'err');
    }
    await checkModels();
    if (blockIfNoModel('qr-batch-msg')) return;

    queueRunning = true;
    queueCancelled = false;
    $('qr-stop').hidden = false;
    // Everything waiting says so, so the table reads as a queue, not a freeze.
    items.forEach((it) => setRowJob(it.company, { status: 'running', stage: 'queued', pct: 0 }));
    let done = 0;
    let failed = 0;
    try {
      for (const it of items) {
        if (queueCancelled) {
          setRowJob(it.company, { status: 'cancelled', stage: 'cancelled', pct: 0 });
          continue;
        }
        msg('qr-batch-msg',
            `Researching ${esc(it.company)} — ${done + 1} of ${items.length}. `
            + `正在研究第 ${done + 1} / ${items.length} 家。`, 'info');
        try {
          const { jobId } = await startOrAttachJob(it.company, it.website);
          await followRowJob(it.company, jobId, { keep: true });
          const st = (rowJobs.get(it.company) || {}).status;
          if (st === 'completed') done += 1; else failed += 1;
        } catch (e) {
          failed += 1;
          setRowJob(it.company, { status: 'failed', stage: 'failed', error: e.message });
        }
      }
      msg('qr-batch-msg',
          `Batch finished — ${done} completed, ${failed} not completed. `
          + `批量完成 — ${done} 家成功，${failed} 家未完成。`, 'info');
    } finally {
      queueRunning = false;
      $('qr-stop').hidden = true;
      await refreshExisting();
      await loadLibrary();
    }
  }

  /** Poll one job and paint the row. Leaves the existing report alone unless
   *  and until the run actually completes. */
  async function followRowJob(company, jobId, opts) {
    setRowJob(company, { jobId, status: 'running' });
    while (true) {
      const snap = await fetch(api(`/job/${encodeURIComponent(jobId)}`))
        .then((r) => r.json()).catch(() => null);
      if (snap && snap.status) {
        const states = PROG_STEPS.map((step) => ({ step, ...progState(snap, step) }));
        const settled = states.filter(
          (x) => x.st === 'done' || x.st === 'skipped' || x.st === 'warned').length;
        const active = states.find((x) => x.st === 'active');
        setRowJob(company, {
          pct: Math.round((settled / PROG_STEPS.length) * 100),
          stage: active ? active.step.k : snap.phase,
          status: snap.status === 'running' ? 'running' : snap.status,
        });
        if (snap.status !== 'running') break;
      } else {
        // Engine forgot it; fall back to the durable row.
        const { active, latest } = await jobForCompany(company);
        const row = active || latest;
        if (!active) {
          setRowJob(company, { status: (row && row.status) || 'interrupted',
                               stage: (row && row.stage) || 'interrupted',
                               pct: (row && row.progress_percent) || 0 });
          break;
        }
        setRowJob(company, { pct: row.progress_percent, stage: row.stage, status: 'running' });
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    const { latest } = await jobForCompany(company);
    if (latest && latest.status === 'completed') {
      setRowJob(company, { status: 'completed', stage: 'completed', pct: 100 });
      await refreshExisting();
      await loadLibrary();
    } else if (latest) {
      setRowJob(company, { status: latest.status, stage: latest.stage,
                           error: latest.error });
      // The previous report is untouched: refreshExisting re-reads Neon.
      await refreshExisting();
    }
    // A queued run keeps its final state on the row; a one-off regenerate fades
    // back to the plain report status once the user has seen it.
    if (!(opts && opts.keep)) {
      setTimeout(() => { rowJobs.delete(company); renderBatch(); }, 8000);
    }
  }

  /* On tab open or refresh, pick any row back up from Neon. No session storage. */
  async function reconnectBatchRows() {
    let active = [];
    try { active = await fetch(api('/active-jobs')).then((r) => r.json()); }
    catch (e) { return; }
    if (!Array.isArray(active) || !active.length) return;

    /* Rebuild the table from Neon when the browser was closed and reopened:
       without this the runs are still going server-side but the user comes back
       to an empty Batch tab and cannot see them. */
    active.forEach((job) => {
      if (idx(job.company_name) < 0) {
        batchItems.push({ company: job.company_name, website: job.website || '',
                          status: 'Pending', selected: true, _restored: true });
      }
    });
    renderBatch();

    active.forEach((job) => {
      if ((rowJobs.get(job.company_name) || {}).jobId === job.job_id) return;
      setRowJob(job.company_name, { jobId: job.job_id, status: 'running',
                                    stage: job.stage, pct: job.progress_percent });
      followRowJob(job.company_name, job.job_id, { keep: true });
    });
    msg('qr-batch-msg',
        `Reconnected to ${active.length} run(s) still in progress. `
        + `已重新连接 ${active.length} 项进行中的研究。`, 'info');
  }

  /** Existing Report vs Generate, straight from Neon. */
  async function refreshExisting() {
    if (!batchItems.length) return;
    const names = batchItems.map((i) => i.company).join('||');
    try {
      const d = await fetch(api(`/exists?companies=${encodeURIComponent(names)}`)).then((r) => r.json());
      batchItems.forEach((it) => {
        it._hasReport = Boolean(d[it.company]);
        if (it._hasReport && (!it.status || it.status === 'Pending')) it.status = 'Existing Report';
        if (!it._hasReport && it.status === 'Existing Report') it.status = 'Pending';
      });
    } catch (e) { /* leave statuses as they are */ }
    renderBatch();
  }

  function renderKpis(s) {
    const el = $('qr-kpis');
    if (!s) { el.hidden = true; return; }
    el.hidden = false;
    const mins = (v) => v == null ? '—' : (v >= 60 ? Math.round(v / 60) + 'm' : Math.round(v) + 's');
    el.innerHTML = `<div class="qr-kpis">` + [
      ['Completed / 已完成', `${s.completed} / ${s.total}`],
      ['In Progress / 进行中', s.current ? 1 : 0],
      ['Failed / 失败', s.failed],
      ['Remaining / 剩余', s.remaining],
    ].map(([k, v]) => `<div class="qr-kpi"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')
      + `</div><div class="qr-metrics">
        <span><b>Total tokens</b>${(s.total_tokens || 0).toLocaleString()}</span>
        <span><b>Avg time</b>${s.avg_seconds != null ? s.avg_seconds + 's' : '—'}</span>
        <span><b>Elapsed</b>${mins(s.elapsed_seconds)}</span>
        <span><b>Est. remaining</b>${mins(s.eta_seconds)}</span></div>`;
  }

  /* startBatch()/pollBatch() are gone. They drove the engine's in-memory batch,
     which no browser-independent record ever saw: an engine restart lost the
     run, and each company's report reached Neon only if someone kept polling.
     Every entry point now queues the same durable per-company job. */

  function initBatch() {
    $('qr-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const fd = new FormData(); fd.append('file', f);
      try {
        const r = await fetch('/api/aresearch/batch/upload', { method: 'POST', body: fd }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        batchRows = r.rows;
        const map = r.mapping || {};
        const opts = (r.headers || []).map((h, i) =>
          `<option value="${i}">${esc(h || 'Column ' + (i + 1))}</option>`).join('');
        $('qr-colname').innerHTML = opts;
        $('qr-colsite').innerHTML = `<option value="">— none / 无 —</option>${opts}`;
        $('qr-colname').value = map.name ?? 0;
        $('qr-colsite').value = map.website == null ? '' : map.website;
        batchItems = (r.items || []).map((it) => ({ ...it, selected: true }));
        renderUploadSummary(r, map);
        await refreshExisting();
        msg('qr-batch-msg', '');
      } catch (err) { msg('qr-batch-msg', esc(err.message), 'err'); }
    });
    /* One line saying what was loaded and what was detected. The mapping
       dropdowns only appear when the company column is genuinely unsure — a
       missing website is not a problem, because research resolves the official
       site itself. */
    function renderUploadSummary(r, map) {
      const box = $('qr-upload-summary');
      const nameField = $('qr-colname-field');
      const siteField = $('qr-colsite-field');
      if (!box) return;
      const companies = batchItems.length;
      const sites = batchItems.filter((i) => (i.website || '').trim()).length;
      const ambiguous = map.ambiguous === true;
      box.hidden = false;
      box.classList.toggle('needs-mapping', ambiguous);
      if (ambiguous) {
        box.innerHTML = `⚠ ${companies} row(s) loaded, but the company-name column `
          + 'could not be identified from the headers. Please confirm it below.'
          + `<span class="i18n-zh">已载入 ${companies} 行，但无法识别公司名称列，请在下方确认。</span>`;
      } else {
        box.innerHTML = `✓ ${companies} companies loaded · ${sites} websites provided`
          + `<span class="i18n-zh">已载入 ${companies} 家公司 · ${sites} 个官网</span>`
          + (sites < companies
              ? '<span class="i18n-zh" style="display:block;opacity:.8;">'
                + 'Missing websites are resolved automatically. 缺少官网将自动查找。</span>'
              : '');
      }
      // Kept and used either way; only the visibility changes.
      if (nameField) nameField.hidden = !ambiguous;
      if (siteField) siteField.hidden = !ambiguous;
      const form = nameField && nameField.closest('.qr-form');
      if (form) form.classList.toggle('qr-nomodel', !ambiguous && !modelFieldVisible());
    }

    function modelFieldVisible() {
      const f = document.querySelector('[data-qr-view="batch"] .qr-modelfield');
      return !!f && !f.hidden;
    }

    const remap = async () => {
      const ni = +$('qr-colname').value;
      const rawSi = $('qr-colsite').value;
      const si = rawSi === '' ? null : +rawSi;
      batchItems = batchRows.map((row) => {
        let site = (si == null ? '' : (row[si] || '')).trim();
        if (site && !/^https?:\/\//i.test(site)) site = 'https://' + site.replace(/^\/+/, '');
        return { company: (row[ni] || '').trim(), website: site, status: 'Pending', selected: true };
      }).filter((x) => x.company);
      rowEls.clear();
      document.querySelector('#qr-batchtable tbody').innerHTML = '';
      await refreshExisting();
    };
    $('qr-colname').addEventListener('change', remap);
    $('qr-colsite').addEventListener('change', remap);
    $('qr-sel-all').addEventListener('click', () => { batchItems.forEach((i) => i.selected = true); renderBatch(); });
    $('qr-sel-none').addEventListener('click', () => { batchItems.forEach((i) => i.selected = false); renderBatch(); });
    /* All three go through the same durable per-company queue. There is no
       separate in-memory batch research any more. */
    $('qr-run-selected').addEventListener('click',
      () => runBatchQueue(batchItems.filter((i) => i.selected)));
    $('qr-run-all').addEventListener('click', () => runBatchQueue(batchItems.slice()));
    $('qr-retry').addEventListener('click', () => runBatchQueue(batchItems.filter(needsRetry)));
    /* Stop ends the QUEUE. Whatever company is mid-run keeps going server-side
       and still persists through the callback — the alternative is paying for a
       run and then throwing the result away. */
    $('qr-stop').addEventListener('click', () => {
      queueCancelled = true;
      msg('qr-batch-msg',
          'Queue stopped. The company already being researched will finish and be saved. '
          + '队列已停止，正在研究的公司将完成并保存。', 'info');
    });
    $('qr-del-selected').addEventListener('click', async () => {
      const targets = batchItems.filter((i) => i.selected && i._hasReport).map((i) => i.company);
      if (!targets.length) return msg('qr-batch-msg', 'Select companies that have a saved report. 请选择已有报告的公司。', 'err');
      if (!confirm(`Delete ${targets.length} saved report(s)?\n删除 ${targets.length} 份已保存报告？`)) return;
      await fetch(api('/reports/delete'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies: targets }),
      });
      await refreshExisting(); await loadLibrary();
      msg('qr-batch-msg', `Deleted ${targets.length} report(s). 已删除 ${targets.length} 份报告。`, 'info');
    });
  }

  /* ── Portfolio exports, built from the records in Neon ── */
  function initPortfolio() {
    const run = async (path, label) => {
      msg('qr-portfolio-msg', `${label}… 处理中…`, 'info');
      try {
        const res = await fetch(api(path), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lang: getLang() }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed.');
        const blob = await res.blob();
        const cd = res.headers.get('content-disposition') || '';
        const m = cd.match(/filename=?"?([^";]+)/);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = m ? m[1] : 'account_research';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        msg('qr-portfolio-msg', `${label} ready. 已生成。`, 'info');
      } catch (e) { msg('qr-portfolio-msg', esc(e.message), 'err'); }
    };
    $('qr-compile-all').addEventListener('click', () => run('/export/portfolio', 'Compiling'));
    $('qr-zip').addEventListener('click', () => run('/export/zip', 'Building ZIP'));
  }
})();
