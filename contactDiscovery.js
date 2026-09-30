/* ═══════════════════════════════════════════════════════════════════════════
   Automatic Apollo contact discovery.

   Exhibitor → CRM company → Apollo people SEARCH → canonical contacts.

   What it does
     • A durable queue keyed by company (company_contact_discovery). Opening a
       page never queues anything: a company is queued only by an explicit
       request (a person, or the eligibility policy when it is switched on).
     • A worker claims one company at a time under a lease (FOR UPDATE SKIP
       LOCKED), reads Apollo page by page and records progress after every
       page, so a crash or restart resumes where it stopped and a second
       worker can never search the same company at the same time.
     • Requests are paced by one slot shared by every worker process
       (contact_discovery_settings.next_slot_at) and capped per day. A 429
       pushes the shared slot back by Retry-After; transient failures retry
       with exponential backoff; permanent ones stop.
     • People are saved through apolloContactStore.saveApolloContact — the
       same path as Find Contacts — so identity (domain-first, strict name
       otherwise), Apollo-id dedupe and the never-downgrade rules all apply.
       Held and rejected people are counted, never saved.

   What it never does
     People search only. This module does not call people/match, the reveal
     endpoints or enrichment, never reveals an address, drafts or sends.
     (test/contactDiscovery.test.js checks this source for those calls.)

   Switched off by default: contact_discovery_settings.worker_enabled and
   auto_queue_enabled are FALSE until an administrator turns them on, and the
   environment can force it off (CONTACT_DISCOVERY_WORKER=off).
   ═══════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const db = require('./db');
const leads = require('./leads');
const apolloIdentity = require('./apolloIdentity');
const { saveApolloContact } = require('./apolloContactStore');

const { pool } = db;
const STATUSES = ['queued', 'searching', 'found', 'no_results', 'needs_review', 'failed'];
const DONE = ['found', 'no_results', 'needs_review'];
const KINDS = ['search', 'refresh', 'more', 'retry', 'policy'];
const MAX_QUEUE_BATCH = 100;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const LEASE_MS = () => num(process.env.CONTACT_DISCOVERY_LEASE_MS, 120000);
const REQUEST_TIMEOUT_MS = () => num(process.env.CONTACT_DISCOVERY_TIMEOUT_MS, 30000);
const BACKOFF_BASE_MS = () => num(process.env.CONTACT_DISCOVERY_BACKOFF_MS, 30000);
const DEFAULT_RETRY_AFTER_MS = 60000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class DiscoveryError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/* ── Settings ─────────────────────────────────────────────────────────────── */

async function getSettings(client = pool) {
  const { rows: [s] } = await client.query('SELECT * FROM contact_discovery_settings WHERE id = 1');
  return s;
}

function envForcedOff() {
  return String(process.env.CONTACT_DISCOVERY_WORKER || '').toLowerCase() === 'off';
}

const SETTING_RULES = {
  worker_enabled: (v) => typeof v === 'boolean',
  auto_queue_enabled: (v) => typeof v === 'boolean',
  requests_per_minute: (v) => Number.isInteger(v) && v >= 1 && v <= 120,
  daily_request_cap: (v) => Number.isInteger(v) && v >= 0 && v <= 20000,
  pages_per_company: (v) => Number.isInteger(v) && v >= 1 && v <= 20,
  max_attempts: (v) => Number.isInteger(v) && v >= 1 && v <= 20,
};

/** Change the switch or pacing. Unknown keys and bad values are refused. Clears a pause. */
async function updateSettings(patch, user) {
  const sets = []; const vals = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'clear_pause') continue;
    if (!SETTING_RULES[k]) throw new DiscoveryError(400, 'bad_setting', `Unknown setting: ${k}`);
    if (!SETTING_RULES[k](v)) throw new DiscoveryError(400, 'bad_value', `Invalid value for ${k}`);
    vals.push(v); sets.push(`${k} = $${vals.length}`);
  }
  if (patch && patch.clear_pause === true) sets.push('paused_reason = NULL');
  if (!sets.length) throw new DiscoveryError(400, 'nothing_to_change', 'No settings given.');
  vals.push(user || null);
  const { rows: [s] } = await pool.query(
    `UPDATE contact_discovery_settings SET ${sets.join(', ')}, updated_by = $${vals.length}, updated_at = NOW() WHERE id = 1 RETURNING *`, vals);
  return s;
}

/* ── Queue ────────────────────────────────────────────────────────────────── */

/**
 * Ask for companies to be searched. Idempotent: queuing a company that is
 * already queued, searching or done is a no-op unless the kind says why:
 *   search/policy — first search only
 *   retry         — a failed company, resuming at the page it stopped on
 *   refresh       — a finished company, searched again from page 1
 *   more          — a finished company with more Apollo results: one more page
 */
async function queueCompanies(companyIds, { kind = 'search', user = null, priority = 0 } = {}) {
  if (!KINDS.includes(kind)) throw new DiscoveryError(400, 'bad_kind', 'Unknown request kind.');
  const ids = [...new Set((Array.isArray(companyIds) ? companyIds : []).map(Number))];
  if (!ids.length || ids.some((i) => !Number.isInteger(i) || i <= 0)) throw new DiscoveryError(400, 'bad_ids', 'Company ids must be positive integers.');
  if (ids.length > MAX_QUEUE_BATCH) throw new DiscoveryError(400, 'too_many', `At most ${MAX_QUEUE_BATCH} companies per request.`);
  const settings = await getSettings();
  const out = [];
  for (const id of ids) out.push(await queueOne(id, kind, user, priority, settings));
  return out;
}

async function queueOne(companyId, kind, user, priority, settings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [co] } = await client.query('SELECT id FROM companies WHERE id = $1', [companyId]);
    if (!co) { await client.query('ROLLBACK'); return { company_id: companyId, outcome: 'not_found' }; }
    const { rows: [cur] } = await client.query('SELECT * FROM company_contact_discovery WHERE company_id = $1 FOR UPDATE', [companyId]);
    let row = null; let outcome = 'unchanged';
    if (!cur) {
      if (kind === 'search' || kind === 'policy' || kind === 'refresh') {
        ({ rows: [row] } = await client.query(
          `INSERT INTO company_contact_discovery (company_id, status, request_kind, requested_by, priority, page_limit)
           VALUES ($1, 'queued', $2, $3, $4, $5) RETURNING *`, [companyId, kind === 'refresh' ? 'search' : kind, user, priority, settings.pages_per_company]));
        outcome = 'queued';
      } else outcome = 'not_applicable';
    } else if (kind === 'retry' && cur.status === 'failed') {
      ({ rows: [row] } = await client.query(
        `UPDATE company_contact_discovery SET status = 'queued', request_kind = 'retry', requested_by = $2, attempts = 0,
                next_attempt_at = NULL, last_error = NULL, last_error_code = NULL, queued_at = NOW(), updated_at = NOW()
          WHERE company_id = $1 RETURNING *`, [companyId, user]));
      outcome = 'queued';
    } else if (kind === 'refresh' && (DONE.includes(cur.status) || cur.status === 'failed')) {
      ({ rows: [row] } = await client.query(
        `UPDATE company_contact_discovery SET status = 'queued', request_kind = 'refresh', requested_by = $2, run_no = run_no + 1,
                pages_fetched = 0, next_page = 1, page_limit = $3, apollo_total = NULL, people_seen = 0, contacts_saved = 0,
                contacts_matched = 0, held_count = 0, rejected_count = 0, not_leadership = 0, held_orgs = '[]'::jsonb,
                attempts = 0, next_attempt_at = NULL, last_error = NULL, last_error_code = NULL,
                queued_at = NOW(), finished_at = NULL, updated_at = NOW()
          WHERE company_id = $1 RETURNING *`, [companyId, user, settings.pages_per_company]));
      outcome = 'queued';
    } else if (kind === 'more' && DONE.includes(cur.status) && hasMorePages(cur)) {
      ({ rows: [row] } = await client.query(
        `UPDATE company_contact_discovery SET status = 'queued', request_kind = 'more', requested_by = $2,
                page_limit = pages_fetched + 1, attempts = 0, next_attempt_at = NULL, queued_at = NOW(), finished_at = NULL, updated_at = NOW()
          WHERE company_id = $1 RETURNING *`, [companyId, user]));
      outcome = 'queued';
    } else if (kind !== 'search' && kind !== 'policy') outcome = 'not_applicable';
    await client.query('COMMIT');
    return { company_id: companyId, outcome, status: (row || cur).status };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

function hasMorePages(r) {
  return r.apollo_total != null && r.pages_fetched * leads.APOLLO_PAGE_SIZE < r.apollo_total;
}

/* ── Eligibility policy (explicit; never triggered by a page view) ────────── */

/** Listed exhibitors of an event whose CRM company has never been queued. */
async function eligibleCompanies(eventId, { limit = 50, includeWithContacts = false } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 50, 2000));
  const { rows } = await pool.query(`
    SELECT DISTINCT co.id AS company_id, co.name, co.website
      FROM event_exhibitors e
      JOIN companies co ON co.id = e.company_id
      LEFT JOIN company_contact_discovery d ON d.company_id = co.id
     WHERE e.event_id = $1 AND e.attendance_status = 'listed' AND d.company_id IS NULL
       AND ($2::boolean OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = co.id))
     ORDER BY co.id
     LIMIT $3`, [eventId, Boolean(includeWithContacts), lim]);
  return rows.map((r) => ({ ...r, mode: apolloIdentity.buildTarget({ name: r.name, company: r }).mode }));
}

/* ── Pacing: one request slot shared by all workers, plus a daily cap ───── */

/** Reserve the next Apollo request slot. null = disabled, paused or over the daily cap. */
async function reserveRequestSlot() {
  const { rows: [r] } = await pool.query(`
    UPDATE contact_discovery_settings
       SET requests_today = CASE WHEN requests_day = CURRENT_DATE THEN requests_today + 1 ELSE 1 END,
           requests_day = CURRENT_DATE,
           next_slot_at = GREATEST(next_slot_at, NOW()) + make_interval(secs => 60.0 / requests_per_minute)
     WHERE id = 1 AND worker_enabled AND paused_reason IS NULL
       AND (requests_day IS DISTINCT FROM CURRENT_DATE OR requests_today < daily_request_cap)
     RETURNING next_slot_at - make_interval(secs => 60.0 / requests_per_minute) AS slot_at`);
  return r ? new Date(r.slot_at) : null;
}

async function pushBackSlots(ms) {
  await pool.query(`UPDATE contact_discovery_settings SET next_slot_at = GREATEST(next_slot_at, NOW() + make_interval(secs => $1::double precision / 1000)) WHERE id = 1`, [ms]);
}

async function pause(reason) {
  await pool.query(`UPDATE contact_discovery_settings SET paused_reason = $1, updated_at = NOW() WHERE id = 1`, [String(reason).slice(0, 300)]);
}

/* ── Claim / lease ────────────────────────────────────────────────────────── */

/** Take the next due company, or reclaim one whose worker's lease ran out. */
async function claimNext(workerId) {
  const { rows: [row] } = await pool.query(`
    UPDATE company_contact_discovery d
       SET status = 'searching', worker_id = $1, lease_expires_at = NOW() + make_interval(secs => $2::double precision / 1000),
           heartbeat_at = NOW(), started_at = NOW(), updated_at = NOW()
     WHERE d.company_id = (
             SELECT company_id FROM company_contact_discovery
              WHERE (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
                 OR (status = 'searching' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()))
              ORDER BY priority DESC, queued_at, company_id
              FOR UPDATE SKIP LOCKED LIMIT 1)
       AND ((d.status = 'queued' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= NOW()))
            OR (d.status = 'searching' AND (d.lease_expires_at IS NULL OR d.lease_expires_at < NOW())))
     RETURNING d.*`, [workerId, LEASE_MS()]);
  return row || null;
}

/** An update that only lands while this worker still holds the lease. */
async function owned(companyId, workerId, setSql, params = []) {
  const { rows: [row] } = await pool.query(
    `UPDATE company_contact_discovery SET ${setSql}, updated_at = NOW()
      WHERE company_id = $1 AND worker_id = $2 AND status = 'searching' RETURNING *`,
    [companyId, workerId, ...params]);
  return row || null;
}

const heartbeat = (companyId, workerId) => owned(companyId, workerId,
  `heartbeat_at = NOW(), lease_expires_at = NOW() + make_interval(secs => $3::double precision / 1000)`, [LEASE_MS()]);

/* Put a company back in the queue for later (rate limit, transient failure,
   daily cap), or fail it once it has used up its attempts. */
async function deferOrFail(row, workerId, { countAttempt, code, message, delayMs, settings }) {
  const attempts = row.attempts + (countAttempt ? 1 : 0);
  if (countAttempt && attempts >= settings.max_attempts) {
    return owned(row.company_id, workerId,
      `status = 'failed', attempts = $3, last_error = $4, last_error_code = $5, worker_id = NULL, lease_expires_at = NULL,
       finished_at = NOW(), last_searched_at = NOW()`, [attempts, message, code]);
  }
  return owned(row.company_id, workerId,
    `status = 'queued', attempts = $3, last_error = $4, last_error_code = $5, worker_id = NULL, lease_expires_at = NULL,
     next_attempt_at = NOW() + make_interval(secs => $6::double precision / 1000)`, [attempts, message, code, delayMs]);
}

function backoffMs(attempts) {
  return Math.min(BACKOFF_BASE_MS() * 2 ** Math.max(0, attempts), MAX_BACKOFF_MS);
}

/* ── One company ──────────────────────────────────────────────────────────── */

function mergeHeldOrgs(existing, review) {
  const map = new Map((existing || []).map((h) => [`${h.basis}|${h.org}`, { ...h }]));
  for (const r of review) {
    const key = `${r.identity}|${r.apollo_org_name || ''}`;
    const cur = map.get(key) || { org: r.apollo_org_name || '', basis: r.identity, n: 0 };
    cur.n += 1; map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.n - a.n).slice(0, 20);
}

/**
 * Search one claimed company until its page limit, Apollo's last page, or a
 * stop. Every page is committed before the next is requested.
 * Returns the final row (or null when the lease was lost).
 */
async function processCompany(row, workerId, apiKey) {
  const settings = await getSettings();
  const company = await db.getCompany(row.company_id);
  if (!company) return null;                               // deleted: the row went with it (ON DELETE CASCADE)
  const target = apolloIdentity.buildTarget({ name: company.name, company });
  if (!target.key && !target.domain) {
    return owned(row.company_id, workerId,
      `status = 'failed', last_error = 'The company has no usable name or website to search for.', last_error_code = 'no_identity',
       worker_id = NULL, lease_expires_at = NULL, finished_at = NOW()`);
  }
  let cur = await owned(row.company_id, workerId, `search_mode = $3, domain_used = $4, name_used = $5`,
    [target.mode, target.domain, target.name]);
  if (!cur) return null;

  while (cur.next_page <= cur.page_limit) {
    const slot = await reserveRequestSlot();
    if (!slot) {
      // Switched off, paused or over today's budget: hand the company back untouched.
      const s = await getSettings();
      const overCap = s.worker_enabled && !s.paused_reason;
      return owned(cur.company_id, workerId,
        `status = 'queued', worker_id = NULL, lease_expires_at = NULL,
         next_attempt_at = CASE WHEN $3::boolean THEN date_trunc('day', NOW()) + interval '1 day 5 minutes' ELSE NULL END`, [overCap]);
    }
    // Wait for our slot, keeping the lease alive meanwhile.
    for (let wait = slot - Date.now(); wait > 0; wait = slot - Date.now()) {
      await sleep(Math.min(wait, Math.max(1000, LEASE_MS() / 3)));
      if (!(await heartbeat(cur.company_id, workerId))) return null;
    }
    if (!(cur = await heartbeat(cur.company_id, workerId))) return null;

    const page = cur.next_page;
    let res;
    try {
      res = await leads.searchPeoplePage(target, apiKey, page, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS()) });
    } catch (e) {
      const code = e && e.name === 'TimeoutError' ? 'timeout' : 'network';
      return deferOrFail(cur, workerId, { countAttempt: true, code, message: `Apollo request failed: ${String(e.message || e).slice(0, 200)}`,
        delayMs: backoffMs(cur.attempts), settings });
    }

    if (res.status === 429) {
      const delay = res.retryAfterMs != null ? Math.min(res.retryAfterMs, MAX_BACKOFF_MS) : DEFAULT_RETRY_AFTER_MS;
      await pushBackSlots(delay);                          // every worker waits, not just this one
      return deferOrFail(cur, workerId, { countAttempt: true, code: 'rate_limited', message: `Apollo rate limit (HTTP 429); retrying in ${Math.round(delay / 1000)}s`,
        delayMs: delay, settings });
    }
    if (res.status === 401 || res.status === 403) {
      // The key or plan, not this company: stop everything and let a person look.
      const said = String((res.data && (res.data.error || res.data.message || res.data.error_code)) || '').slice(0, 160);
      await pause(`Apollo HTTP ${res.status}${said ? `: ${said}` : ''}`);
      return owned(cur.company_id, workerId, `status = 'queued', worker_id = NULL, lease_expires_at = NULL, last_error = $3, last_error_code = 'auth'`,
        [`Apollo HTTP ${res.status}; discovery paused`]);
    }
    if (res.status >= 500 || res.status === 408) {
      return deferOrFail(cur, workerId, { countAttempt: true, code: `http_${res.status}`, message: `Apollo HTTP ${res.status}`,
        delayMs: backoffMs(cur.attempts), settings });
    }
    if (res.status !== 200) {
      const said = String((res.data && (res.data.error || res.data.message)) || '').slice(0, 200);
      return owned(cur.company_id, workerId,
        `status = 'failed', attempts = attempts + 1, last_error = $3, last_error_code = $4, worker_id = NULL, lease_expires_at = NULL,
         finished_at = NOW(), last_searched_at = NOW()`, [`Apollo HTTP ${res.status}${said ? `: ${said}` : ''}`, `http_${res.status}`]);
    }

    const people = Array.isArray(res.data.people) ? res.data.people : [];
    const pg = res.data.pagination || {};
    const total = Number.isFinite(Number(res.data.total_entries ?? pg.total_entries)) ? Number(res.data.total_entries ?? pg.total_entries) : null;
    const cls = leads.classifySearchPage(people, target);
    let saved = 0; let matched = 0;
    for (const c of cls.contacts) {
      const r = await saveApolloContact(c, { companyId: company.id, companyName: company.name,
        searchLabel: 'automatic contact discovery', domain: target.domain });
      if (r.updated) matched++; else saved++;
    }
    cur = await owned(cur.company_id, workerId,
      `pages_fetched = $3, next_page = $3 + 1, apollo_total = $4, people_seen = people_seen + $5,
       contacts_saved = contacts_saved + $6, contacts_matched = contacts_matched + $7,
       held_count = held_count + $8, rejected_count = rejected_count + $9, not_leadership = not_leadership + $10,
       held_orgs = $11::jsonb, attempts = 0, last_error = NULL, last_error_code = NULL, heartbeat_at = NOW(),
       lease_expires_at = NOW() + make_interval(secs => $12::double precision / 1000)`,
      [page, total, people.length, saved, matched, cls.review.length, cls.rejected.length, cls.notLeadership,
        JSON.stringify(mergeHeldOrgs(cur.held_orgs, cls.review)), LEASE_MS()]);
    if (!cur) return null;
    const exhausted = !people.length || total == null || page * leads.APOLLO_PAGE_SIZE >= total;
    if (exhausted) break;
  }

  return owned(cur.company_id, workerId,
    `status = CASE WHEN contacts_saved + contacts_matched > 0 THEN 'found'
                   WHEN held_count > 0 THEN 'needs_review' ELSE 'no_results' END,
     worker_id = NULL, lease_expires_at = NULL, next_attempt_at = NULL, finished_at = NOW(), last_searched_at = NOW()`);
}

/* ── Worker ───────────────────────────────────────────────────────────────── */

function createWorker({ apiKey, tickMs, eventIdFn, log = console } = {}) {
  const workerId = `cdw-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const every = num(tickMs, num(process.env.CONTACT_DISCOVERY_TICK_MS, 15000));
  let timer = null; let busy = false; let stopped = false; let lastPolicyAt = 0;

  async function tick() {
    if (busy || stopped) return 0;
    busy = true;
    let done = 0;
    try {
      const key = typeof apiKey === 'function' ? apiKey() : apiKey;
      if (envForcedOff() || !key) return 0;
      const s = await getSettings();
      if (!s || !s.worker_enabled || s.paused_reason) return 0;
      if (s.auto_queue_enabled && eventIdFn && Date.now() - lastPolicyAt > 10 * 60 * 1000) {
        lastPolicyAt = Date.now();
        const eventId = await eventIdFn();
        if (eventId) {
          const due = await eligibleCompanies(eventId, { limit: 25 });
          if (due.length) await queueCompanies(due.map((d) => d.company_id), { kind: 'policy', user: 'policy' });
        }
      }
      for (let i = 0; i < 10 && !stopped; i++) {
        const row = await claimNext(workerId);
        if (!row) break;
        const end = await processCompany(row, workerId, key);
        done++;
        // Handed back (switched off, paused, over budget, rate limited, transient
        // failure): stop claiming for this tick rather than cycling the queue.
        if (end && end.status === 'queued') break;
      }
    } catch (e) {
      log.error('[contact-discovery] tick failed:', e.message);
    } finally { busy = false; }
    return done;
  }

  const loop = async () => { await tick(); if (!stopped) timer = setTimeout(loop, every); };
  return {
    workerId, tick,
    start() { stopped = false; if (!timer) timer = setTimeout(loop, every); if (timer.unref) timer.unref(); return this; },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}

/* ── Reads for the UI ─────────────────────────────────────────────────────── */

/** Discovery state per company id. A search whose lease ran out reads as queued. */
async function statesFor(companyIds, client = pool) {
  const ids = [...new Set((companyIds || []).filter((i) => Number.isInteger(i) && i > 0))];
  if (!ids.length) return new Map();
  const { rows } = await client.query(`
    SELECT company_id,
           CASE WHEN status = 'searching' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()) THEN 'queued' ELSE status END AS status,
           request_kind, search_mode, domain_used, apollo_total, pages_fetched, page_limit, people_seen,
           contacts_saved, contacts_matched, held_count, rejected_count, held_orgs, attempts,
           last_error, last_error_code, next_attempt_at, last_searched_at, queued_at, finished_at
      FROM company_contact_discovery WHERE company_id = ANY($1::int[])`, [ids]);
  return new Map(rows.map((r) => [r.company_id, { ...r, has_more: hasMorePages(r) }]));
}

async function overview() {
  const settings = await getSettings();
  const { rows } = await pool.query(`SELECT status, count(*)::int n FROM company_contact_discovery GROUP BY status`);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) counts[r.status] = r.n;
  return { settings: { ...settings, env_forced_off: envForcedOff() }, counts };
}

module.exports = {
  STATUSES, KINDS, DiscoveryError, getSettings, updateSettings, queueCompanies, eligibleCompanies,
  reserveRequestSlot, claimNext, processCompany, createWorker, statesFor, overview, hasMorePages, backoffMs,
};
