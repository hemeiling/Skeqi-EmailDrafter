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

  let modelsAvailable = null;          // null = unknown until health is fetched
  let modelStates = [];                // [{ model, label, state }] from /models/health
  let library = [];
  /* Companies ticked in the report library. Its own set: "Compile Selected"
     must never fall back to the batch table's selection, which the Reports tab
     does not show. */
  const librarySelection = new Set();
  let current = null;                  // { company, report }
  let batchItems = [];
  let batchRows = [];
  let batchId = null;
  let batchPolling = false;

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

  /* ── Model availability. A 403 is a billing state, not a research failure. ── */
  async function checkModels() {
    try {
      const d = await fetch(api('/models/health')).then((r) => r.json());
      modelsAvailable = Boolean(d.modelsAvailable);
      modelStates = d.models || [];
      const sel = (d.models || []).map((m) =>
        `<option value="${esc(m.model)}"${m.state === 'access_denied' ? ' disabled' : ''}>` +
        `${esc(m.label)}${m.state === 'access_denied' ? ' — Unavailable / 未开通' : ''}</option>`).join('');
      if ($('qr-model')) $('qr-model').innerHTML = sel;
      if ($('qr-batchmodel')) $('qr-batchmodel').innerHTML = sel;
      const n = $('qr-model-notice');
      if (n) {
        n.hidden = modelsAvailable;
        n.innerHTML =
          `<div>${esc(MODEL_MSG)}<span class="i18n-zh">${esc(MODEL_MSG_ZH)}</span></div>` +
          '<div style="opacity:.85;margin-top:3px;">Saved reports, language views and PDFs are ' +
          'unaffected.<span class="i18n-zh">已保存的报告、语言切换与 PDF 不受影响。</span></div>';
      }
    } catch (e) {
      modelsAvailable = null;
      modelStates = [];
    }
    renderStatusCards();
  }

  /* ── Workspace status strip. Values come from the health and library
     responses this workspace already makes. No extra request, no model call. ── */
  function renderStatusCards() {
    const icon = $('qr-stat-icon');
    const mv = $('qr-stat-model');
    if (mv) {
      const chosen = $('qr-model') && $('qr-model').value;
      const hit = modelStates.find((m) => m.model === chosen) || modelStates[0];
      if (modelsAvailable === false) {
        mv.textContent = 'Activation required / 需开通付费';
      } else if (hit) {
        mv.textContent = hit.label + (hit.state === 'access_denied' ? ' — unavailable / 未开通' : '');
      } else {
        mv.textContent = modelsAvailable === null ? 'Unavailable / 无法连接' : 'Checking… 检测中…';
      }
      if (icon) {
        icon.className = 'qr-stat-icon' +
          (modelsAvailable === true ? ' is-green' : modelsAvailable === false ? ' is-red' : '');
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

  function blockIfNoModel(target) {
    if (modelsAvailable === false) {
      msg(target, `<strong>${esc(MODEL_MSG)}</strong><br><span>${esc(MODEL_MSG_ZH)}</span>`, 'err');
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
          <button data-qr-pdf="${co}">PDF</button>
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
  async function openReport(company) {
    msg('qr-single-msg', '');
    showSub('single');
    try {
      const got = await fetch(api(`/company/${encodeURIComponent(company)}`)).then((r) => {
        if (!r.ok) throw new Error('No saved report for this company.');
        return r.json();
      });
      current = { company, report: got.report };
      await renderReport();
    } catch (e) {
      current = null;
      $('qr-report-card').style.display = 'none';
      msg('qr-single-msg', esc(e.message), 'err');
    }
  }

  /* The language view is rendered server-side from the stored record, so the
     selection logic lives in one place instead of being mirrored here. */
  async function renderReport() {
    if (!current) { $('qr-report-card').style.display = 'none'; return; }
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
  }

  window.qwenResearchInit = async function init() {
    if (window.__qrReady) { loadLibrary(); return; }
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

  /* ── Research (blocked while models need activation) ── */
  async function startResearch(isRegen) {
    const company = $('qr-company').value.trim();
    if (!company) return msg('qr-single-msg', 'Company name is required. 请输入公司名称。', 'err');
    await checkModels();
    if (blockIfNoModel('qr-single-msg')) return;
    msg('qr-single-msg', isRegen ? 'Regenerating… 重新生成中…' : 'Researching… 研究中…', 'info');
    try {
      const start = await fetch(api('/research'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company, website: $('qr-website').value.trim(), model: $('qr-model').value }),
      }).then((r) => r.json());
      if (start.error) throw new Error(start.error);
      while (true) {
        const snap = await fetch(api(`/job/${start.job_id}`)).then((r) => r.json());
        if (snap.modelUnavailable) { blockIfNoModel('qr-single-msg'); return; }
        if (snap.status === 'error') throw new Error(snap.message || 'Research failed.');
        if (snap.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      msg('qr-single-msg', 'Research complete. 研究完成。', 'info');
      await loadLibrary();
      await openReport(company);
    } catch (e) {
      msg('qr-single-msg', esc(e.message), 'err');
    }
  }

  /* ── Batch ─────────────────────────────────────────────────────────────
     Rows are keyed by company and updated in place. A row being edited is not
     touched at all, so polling cannot move the caret, clear a selection or
     overwrite unsaved text. */
  const rowEls = new Map();
  const CELLS = 9;
  const setHTML = (el, html) => { if (el.__h !== html) { el.__h = html; el.innerHTML = html; } };
  const idx = (co) => batchItems.findIndex((x) => x.company === co);

  function statusBadge(it) {
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
      <button data-qr-act="pdf" data-co="${co}">PDF</button>
      <button data-qr-act="regen" data-co="${co}">Regen</button>
      <button data-qr-act="del" data-co="${co}" class="del">Delete</button></div>`;
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
      return startBatch([{ ...it, selected: true }], false);
    }
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

  async function startBatch(items, useExisting) {
    if (!items.length) return msg('qr-batch-msg', 'No companies selected. 未选择公司。', 'err');
    await checkModels();
    if (blockIfNoModel('qr-batch-msg')) return;
    msg('qr-batch-msg', '');
    try {
      const r = await fetch(api('/batch/start'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, model: $('qr-batchmodel').value, use_existing: useExisting !== false }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      batchId = r.batch_id;
      pollBatch(batchId);
    } catch (e) { msg('qr-batch-msg', esc(e.message), 'err'); }
  }

  async function pollBatch(id) {
    if (batchPolling) return;
    batchPolling = true;
    $('qr-stop').hidden = false;
    try {
      while (true) {
        const s = await fetch(api(`/batch/${id}`)).then((r) => r.json());
        if (s.error) throw new Error(s.error);
        (s.items || []).forEach((row) => {
          const i = idx(row.company);
          if (i >= 0) {
            const local = batchItems[i];
            batchItems[i] = { ...local, ...row, selected: local.selected,
              _editUrl: local._editUrl, _editCompany: local._editCompany,
              ...(local._editUrl || local._editCompany ? { company: local.company, website: local.website } : {}) };
          }
        });
        renderBatch();
        renderKpis(s);
        if (s.status !== 'running' && s.status !== 'queued') break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      await refreshExisting();
      await loadLibrary();
    } catch (e) {
      msg('qr-batch-msg', esc(e.message), 'err');
    } finally {
      batchPolling = false;
      $('qr-stop').hidden = true;
    }
  }

  function initBatch() {
    $('qr-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const fd = new FormData(); fd.append('file', f);
      try {
        const r = await fetch('/api/aresearch/batch/upload', { method: 'POST', body: fd }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        batchRows = r.rows;
        const opts = (r.headers || []).map((h, i) => `<option value="${i}">${esc(h || 'Column ' + (i + 1))}</option>`).join('');
        $('qr-colname').innerHTML = opts; $('qr-colsite').innerHTML = opts;
        $('qr-colname').value = r.mapping.name ?? 0;
        $('qr-colsite').value = r.mapping.website ?? 1;
        batchItems = (r.items || []).map((it) => ({ ...it, selected: true }));
        await refreshExisting();
        msg('qr-batch-msg', '');
      } catch (err) { msg('qr-batch-msg', esc(err.message), 'err'); }
    });
    const remap = async () => {
      const ni = +$('qr-colname').value, si = +$('qr-colsite').value;
      batchItems = batchRows.map((row) => {
        let site = (row[si] || '').trim();
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
    $('qr-run-selected').addEventListener('click', () => startBatch(batchItems.filter((i) => i.selected)));
    $('qr-run-all').addEventListener('click', () => startBatch(batchItems.map((i) => ({ ...i, selected: true }))));
    $('qr-retry').addEventListener('click', () => startBatch(
      batchItems.filter((i) => ['Failed', 'Timed Out'].includes(i.status)).map((i) => ({ ...i, selected: true }))));
    $('qr-stop').addEventListener('click', () => batchId && fetch(api(`/batch/${batchId}/stop`), { method: 'POST' }));
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
