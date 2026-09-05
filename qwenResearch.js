/**
 * Account Research (Qwen-based) — CRM side.
 *
 * Two responsibilities, deliberately separated:
 *
 *   PERSISTENCE  Neon is the system of record. Reports are listed, read and
 *                deleted here, and survive a restart of either application.
 *   PROXY        Research itself still runs in the standalone Python engine,
 *                which owns the models, retrieval, Apollo and PDF rendering.
 *                Nothing about that logic is reimplemented here.
 *
 * One current report per company. A completed run upserts; there is no version
 * history. The old report is only replaced once a new one exists, so a failed
 * model call or a failed write can never leave a company with no report.
 *
 * This is a SECOND engine. It shares the database and the CRM shell with the
 * Claude-based account_reports and nothing else: separate tables, separate
 * prompts, separate service. The two never join.
 */

const db = require('./db.js');
const config = require('./config.js');

const ENGINE = (process.env.CURRENT_ACCOUNT_RESEARCH_URL || '').trim().replace(/\/+$/, '');
const SERVICE_KEY = (process.env.ACCOUNT_RESEARCH_SERVICE_KEY || '').trim();
const ENGINE_TIMEOUT_MS = Number(process.env.ACCOUNT_RESEARCH_TIMEOUT_MS || 600000);

function engineConfigured() { return Boolean(ENGINE); }

/* A 403 from the model provider is a billing state, not a research failure.
   It must never be reported as "retrieval failed" or "not enough evidence". */
const MODEL_UNAVAILABLE = {
  code: 'model_unavailable',
  message: 'Model unavailable — activation/payment required',
  messageZh: '模型暂不可用 — 需要开通/付费',
};

function looksLikeModelAccessError(payload) {
  const s = JSON.stringify(payload || '').toLowerCase();
  return s.includes('accessdenied') || s.includes('access to model denied')
      || s.includes('requires activation');
}

/** Call the engine. Never throws for an HTTP status; the caller decides. */
async function callEngine(path, { method = 'GET', body, raw = false } = {}) {
  if (!engineConfigured()) {
    const e = new Error('CURRENT_ACCOUNT_RESEARCH_URL is not set');
    e.status = 503;
    throw e;
  }
  const headers = {};
  if (SERVICE_KEY) headers['X-AR-Service-Key'] = SERVICE_KEY;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ENGINE_TIMEOUT_MS);
  try {
    const res = await fetch(`${ENGINE}${path}`, {
      method, headers, signal: ctl.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return res;
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text.slice(0, 400) }; }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/* ── Persistence ─────────────────────────────────────────────────────────── */

/** Save a completed run. Returns null (never throws) when there is nothing to
 *  save, so a caller can persist opportunistically without a try/catch. */
async function persistRun(record, userId, identity = null) {
  if (!record || !record.company) return null;
  if (record.status !== 200 || !record.research_result) return null;   // only successes
  // `identity` is the key the JOB established at claim time; see saveQwenReport.
  return db.saveQwenReport(record, userId || null, identity);
}

async function listReports(search) {
  return db.listQwenReports(search);
}

async function getReport(id) {
  return db.getQwenReport(id);
}

async function getReportForCompany(company) {
  return db.getQwenReportForCompany(company);
}

/** Existing-report detection, for one company or many. A boolean per company:
 *  there is no version history to scan. */
async function reportsExist(companies) {
  const out = {};
  for (const c of companies || []) out[c] = await db.hasQwenReport(c);
  return out;
}

async function deleteReportForCompany(company) {
  return db.deleteQwenReportsByCompany(company);
}

/* ── Rendering from stored data ──────────────────────────────────────────── */

/** Language-selected markdown for a stored report. No model call: the engine
 *  is only being used as the renderer that produced the record. */
async function renderStored(record, lang, format) {
  return callEngine('/api/render', {
    method: 'POST',
    body: { record, lang: lang || 'bilingual', format: format || 'markdown' },
    raw: format === 'pdf',
  });
}

/** Canonical records for a set of companies, straight from Neon. Exports are
 *  built from these, so a portfolio or ZIP never depends on what happens to be
 *  on the engine's filesystem. */
/* Contacts this CRM already holds for a company, shaped for the research
   engine. Reusing what we know beats paying Apollo to tell us again, and the
   CRM's own records carry verified emails that Apollo would charge for.

   Matching is by company_id where the CRM knows the company, falling back to a
   normalised name compare. The rows never reach the browser: the proxy attaches
   them to the research request server-side. */
async function crmContactsFor(company) {
  const name = String(company || '').trim();
  if (!name) return [];
  try {
    const rows = await db.contactsForResearch(name);
    return rows.map((r) => ({
      name: r.full_name || [r.first_name, r.last_name].filter(Boolean).join(' '),
      title: r.job_title || '',
      department: r.department || r.department_category || '',
      seniority: r.seniority || r.seniority_level || '',
      company: r.company || name,
      location: r.country || r.address || '',
      email: r.email || '',
      // Never invent a status: absent means absent.
      email_status: r.email || r.email_lookup_status
        ? (r.email_lookup_status || 'From CRM') : '',
      linkedin_url: r.linkedin_url || '',
      crm_contact_id: r.id,
    })).filter((p) => p.name && p.title);
  } catch (e) {
    return [];                       // enrichment reuse is best-effort, never fatal
  }
}

async function recordsFor(companies) {
  const out = [];
  if (Array.isArray(companies) && companies.length) {
    for (const c of companies) {
      const got = await db.getQwenReportForCompany(String(c));
      if (got) out.push(got.report);
    }
    return out;
  }
  for (const row of await db.listQwenReports()) {
    const got = await db.getQwenReport(row.id);
    if (got) out.push(got.report);
  }
  return out;
}

module.exports = {
  ENGINE, MODEL_UNAVAILABLE,
  engineConfigured, callEngine, looksLikeModelAccessError,
  persistRun, listReports, getReport, getReportForCompany, reportsExist,
  deleteReportForCompany, renderStored, recordsFor, crmContactsFor,
};
