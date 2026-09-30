/* Automatic Apollo contact discovery — queue, worker, identity, persistence.

   Apollo is MOCKED: a local HTTP server stands in for api.apollo.io
   (APOLLO_BASE_URL, set before the modules load), records every request and
   answers from per-company fixtures. Every test ends by asserting that no
   reveal / enrichment endpoint was called — discovery is people search only.

   Runs only against TEST_DATABASE_URL (see dbGuard). */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dbGuard = require('./dbGuard');

/* Source guarantees need no database. */
test('discovery code never references a reveal, enrichment, draft or send path', () => {
  for (const f of ['contactDiscovery.js', 'apolloContactStore.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');            // code only, not the comments that promise this
    for (const bad of ['people/match', 'revealPersonEmail', 'reveal-email', 'enrich-email', 'allowApollo', 'reveal_personal_emails',
      'draftEmail', 'sendEmail', 'insertCommunication', 'markCommunicationSend', 'require(\'./apollo\')', 'organizations/search']) {
      assert.ok(!src.includes(bad), `${f} must not reference ${bad}`);
    }
  }
  const leadsSrc = fs.readFileSync(path.join(__dirname, '..', 'leads.js'), 'utf8');
  const fn = leadsSrc.slice(leadsSrc.indexOf('async function searchPeoplePage'), leadsSrc.indexOf('function parseRetryAfter'));
  assert.ok(fn.length > 200);
  assert.doesNotMatch(fn, /q_keywords|APOLLO_ORG_URL|people\/match/, 'strict page search: no keyword or org fallback');
});

test('Retry-After parsing: seconds, HTTP date, junk', () => {
  const { parseRetryAfter } = require('../leads');
  assert.equal(parseRetryAfter('30'), 30000);
  assert.equal(parseRetryAfter('0'), 0);
  const now = Date.parse('2026-09-30T00:00:00Z');
  assert.equal(parseRetryAfter('Wed, 30 Sep 2026 00:00:10 GMT', now), 10000);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(null), null);
});

if (!dbGuard.available) {
  test('contact discovery database suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
  return;
}

const MOCK_PORT = 41000 + Math.floor(Math.random() * 900);
process.env.APOLLO_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.CONTACT_DISCOVERY_LEASE_MS = '1500';
process.env.CONTACT_DISCOVERY_BACKOFF_MS = '150';
delete process.env.CONTACT_DISCOVERY_WORKER;

const db = require('../db');
const cd = require('../contactDiscovery');
const { pool } = db;

const TAG = `Zd${Date.now().toString(36)}`;
const N = (s) => `${TAG} ${s}`;
const calls = [];
const allCalls = [];        // never reset: the whole-suite check
const fixtures = new Map();       // domain or name → (page, body, callNo) => { status, people, total, headers, delayMs }
const made = { companies: [] };

const person = (id, first, org, extra = {}) => ({
  id: `ap_${TAG}_${id}`, first_name: first, last_name_obfuscated: 'X***', title: 'Director of Manufacturing',
  has_email: true, organization: org, ...extra,
});

let mock;
function startMock() {
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      const key = (body.q_organization_domains_list && body.q_organization_domains_list[0]) || body.q_organization_name || '';
      const callNo = calls.filter((c) => c.key === key).length + 1;
      calls.push({ path: req.url, body, key, at: Date.now() });
      allCalls.push({ path: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (!req.url.endsWith('/mixed_people/api_search')) { res.statusCode = 500; return res.end('{"error":"unexpected endpoint"}'); }
      const f = fixtures.get(key);
      const r = f ? f(body.page, body, callNo) : { people: [], total: 0 };
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
      if (r.drop) { req.socket.destroy(); return; }                       // a network failure
      for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
      res.statusCode = r.status || 200;
      res.end(JSON.stringify(r.status && r.status !== 200 ? (r.body || { error: `HTTP ${r.status}` })
        : { people: r.people || [], total_entries: r.total ?? (r.people || []).length }));
    });
  });
  return new Promise((ok) => mock.listen(MOCK_PORT, '127.0.0.1', ok));
}

const searchCalls = (key) => calls.filter((c) => c.path.endsWith('/mixed_people/api_search') && (!key || c.key === key));
function noRevealCalls() {
  assert.equal(calls.filter((c) => !c.path.endsWith('/mixed_people/api_search')).length, 0, 'only people search was called');
  assert.equal(calls.filter((c) => JSON.stringify(c.body).includes('reveal')).length, 0);
}
async function company(name, website) {
  const { rows: [c] } = await pool.query(`INSERT INTO companies (name, name_key, website, source) VALUES ($1, $2, $3, 'manual') RETURNING id`,
    [name, require('../companyKey').normalizeNameKey(name), website]);
  made.companies.push(c.id); return c.id;
}
const disc = async (id) => (await pool.query('SELECT * FROM company_contact_discovery WHERE company_id = $1', [id])).rows[0];
const contactsOf = async (id) => (await pool.query('SELECT * FROM contacts WHERE company_id = $1 ORDER BY id', [id])).rows;
const byApollo = async (apId) => (await pool.query('SELECT * FROM contacts WHERE apollo_person_id = $1', [apId])).rows;
const settings = (patch) => cd.updateSettings(patch, 'test');
const DEFAULTS = { worker_enabled: false, auto_queue_enabled: false, requests_per_minute: 20, daily_request_cap: 300, pages_per_company: 1, max_attempts: 5, clear_pause: true };
async function fastPacing() {
  // Each test that searches switches the worker on itself, at the fastest pace.
  await pool.query(`UPDATE contact_discovery_settings SET worker_enabled = TRUE, requests_per_minute = 120,
    next_slot_at = NOW(), requests_today = 0, requests_day = CURRENT_DATE WHERE id = 1`);
}
function worker() { return cd.createWorker({ apiKey: 'mock-key', tickMs: 60000, log: { error: () => {} } }); }
async function drain(w, rounds = 6) { let n = 0; for (let i = 0; i < rounds; i++) n += await w.tick(); return n; }

test.before(async () => {
  await db.initDb();
  await startMock();
  await settings(DEFAULTS);
});

test.after(async () => {
  try {
    mock.close();
    await settings(DEFAULTS);
    const { rows } = await pool.query('SELECT id FROM contacts WHERE company_id = ANY($1::int[]) OR apollo_person_id LIKE $2', [made.companies, `ap_${TAG}%`]);
    await db.deleteContacts(rows.map((r) => r.id));
    await pool.query('DELETE FROM company_contact_discovery WHERE company_id = ANY($1::int[])', [made.companies]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [made.companies]);
  } finally { await pool.end(); }
});

/* ── Inert by default ─────────────────────────────────────────────────── */

test('a fresh install is inert: disabled, no auto-queue, initDb queues nothing, a disabled worker calls nothing', async () => {
  const { rows: [s] } = await pool.query('SELECT * FROM contact_discovery_settings WHERE id = 1');
  assert.equal(s.worker_enabled, false);
  assert.equal(s.auto_queue_enabled, false);
  const co = await company(N('Inert Co'), 'inert.example');
  await db.initDb();                                              // a restart / deploy
  assert.equal(await disc(co), undefined, 'starting the server queues nothing');
  await cd.queueCompanies([co], { user: 'test' });
  calls.length = 0;
  const w = worker();
  assert.equal(await w.tick(), 0);
  assert.equal(calls.length, 0, 'queued, but no Apollo request while disabled');
  // The environment can force it off even when the setting is on.
  await settings({ worker_enabled: true, requests_per_minute: 120 });
  process.env.CONTACT_DISCOVERY_WORKER = 'off';
  try { assert.equal(await w.tick(), 0); } finally { delete process.env.CONTACT_DISCOVERY_WORKER; }
  assert.equal(calls.length, 0);
  // And with no API key.
  assert.equal(await cd.createWorker({ apiKey: '', tickMs: 60000 }).tick(), 0);
  assert.equal(calls.length, 0);
  await settings({ worker_enabled: false });
  await pool.query('DELETE FROM company_contact_discovery WHERE company_id = $1', [co]);
});

/* ── Identity and canonical persistence ───────────────────────────────── */

test('reliable domain: domain-filtered query, canonical contacts on the company, email not revealed', async () => {
  const co = await company(N('Domain Co'), 'https://www.domainco.example/about');
  fixtures.set('domainco.example', () => ({ people: [person('d1', 'Dana', { name: 'Domain Co Inc' }), person('d2', 'Dev', { name: 'Domain Co Inc' }),
    person('d3', 'Intern', { name: 'Domain Co Inc' }, { title: 'Marketing Intern' })], total: 3 }));
  await settings({ worker_enabled: true, requests_per_minute: 120 }); await fastPacing();
  await cd.queueCompanies([co], { user: 'test' });
  calls.length = 0;
  await drain(worker());
  const sent = searchCalls('domainco.example');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.q_organization_domains_list, ['domainco.example']);
  assert.equal(sent[0].body.q_organization_name, undefined);
  assert.equal(sent[0].body.q_keywords, undefined);
  const people = await contactsOf(co);
  assert.equal(people.length, 2, 'the two leaders are saved; the intern is filtered as Find Contacts does');
  for (const p of people) {
    assert.equal(p.company_id, co);
    assert.equal(p.email, '');
    assert.equal(p.email_lookup_status, 'not_checked', 'never revealed');
    assert.ok(p.apollo_person_id.startsWith(`ap_${TAG}_d`));
  }
  const d = await disc(co);
  assert.equal(d.status, 'found');
  assert.equal(d.search_mode, 'domain');
  assert.equal(d.domain_used, 'domainco.example');
  assert.equal(d.apollo_total, 3);
  assert.equal(d.pages_fetched, 1);
  assert.equal(d.contacts_saved, 2);
  assert.equal(d.not_leadership, 1);
  assert.ok(d.last_searched_at);
  const { rows: comms } = await pool.query('SELECT id FROM communications WHERE contact_id = ANY($1::int[])', [people.map((p) => p.id)]);
  assert.equal(comms.length, 0, 'no draft, no send');
  noRevealCalls();
});

test('no reliable domain: strict name query only; similar names held, never saved; never a new company', async () => {
  const co = await company(N('AI Technology'), 'gmail.com');       // free mail is not an identity
  fixtures.set(N('AI Technology'), () => ({ people: [
    person('n1', 'Nia', { name: `${N('AI Technology')}, Inc.` }),
    person('n2', 'Fut', { name: `${N('AI Technology')} Futures` }),
    person('n3', 'Par', { name: `${N('AI Technology')} Partners` }),
    person('n4', 'Oth', { name: 'Unrelated Industries' }),
  ], total: 4 }));
  await fastPacing();
  await cd.queueCompanies([co], { user: 'test' });
  calls.length = 0;
  await drain(worker());
  const sent = searchCalls(N('AI Technology'));
  assert.equal(sent.length, 1, 'one request, no keyword fallback');
  assert.equal(sent[0].body.q_organization_name, N('AI Technology'));
  assert.equal(calls.filter((c) => c.body.q_keywords).length, 0);
  const people = await contactsOf(co);
  assert.deepEqual(people.map((p) => p.full_name.split(' ')[0]), ['Nia'], 'only the exact name is saved');
  const d = await disc(co);
  assert.equal(d.status, 'found');
  assert.equal(d.search_mode, 'name');
  assert.equal(d.held_count, 2);
  assert.equal(d.rejected_count, 1);
  assert.deepEqual(d.held_orgs.map((h) => h.basis), ['similar_name', 'similar_name']);
  const { rows: twins } = await pool.query(`SELECT name FROM companies WHERE name LIKE $1`, [`${N('AI Technology')} %`]);
  assert.equal(twins.length, 0, 'no "Futures"/"Partners" company created');
  assert.equal((await byApollo(`ap_${TAG}_n2`)).length, 0, 'held people are not contacts');
  noRevealCalls();
});

test('only ambiguous organisations for a domain: nothing saved, needs review', async () => {
  const co = await company(N('Ambig Co'), 'ambig.example');
  fixtures.set('ambig.example', () => ({ people: [person('a1', 'Al', { name: 'Ambig One' }), person('a2', 'Bo', { name: 'Beta GmbH' })], total: 2 }));
  await fastPacing();
  await cd.queueCompanies([co], { user: 'test' });
  await drain(worker());
  assert.equal((await contactsOf(co)).length, 0);
  const d = await disc(co);
  assert.equal(d.status, 'needs_review');
  assert.equal(d.held_count, 2);
  noRevealCalls();
});

test('no results → no_results; a completed company is not searched again unless refreshed', async () => {
  const co = await company(N('Empty Co'), 'empty.example');
  fixtures.set('empty.example', () => ({ people: [], total: 0 }));
  await fastPacing();
  await cd.queueCompanies([co], { user: 'test' });
  calls.length = 0;
  await drain(worker());
  assert.equal((await disc(co)).status, 'no_results');
  assert.equal(searchCalls('empty.example').length, 1);
  // Asking again (a second click, the policy) changes nothing and sends nothing.
  const [again] = await cd.queueCompanies([co], { user: 'test' });
  assert.equal(again.outcome, 'unchanged');
  await drain(worker());
  assert.equal(searchCalls('empty.example').length, 1);
  // Refresh is the deliberate way back in.
  const [ref] = await cd.queueCompanies([co], { kind: 'refresh', user: 'test' });
  assert.equal(ref.outcome, 'queued');
  await fastPacing();
  await drain(worker());
  assert.equal(searchCalls('empty.example').length, 2);
  const d = await disc(co);
  assert.equal(d.run_no, 2);
  assert.equal(d.status, 'no_results');
  noRevealCalls();
});

test('rediscovery is idempotent and monotonic: same contacts, revealed email and company kept', async () => {
  const co = await company(N('Mono Co'), 'mono.example');
  const other = await company(N('Mono Elsewhere'), null);
  const revealed = await db.insertContact({ company_id: co, company: N('Mono Co'), full_name: 'Rita Real', apollo_person_id: `ap_${TAG}_m1`,
    email: 'rita@mono.example', email_source: 'apollo_enrichment', email_lookup_status: 'found', has_email: true, apollo_raw_json: '{"rich":true}' });
  const elsewhere = await db.insertContact({ company_id: other, company: N('Mono Elsewhere'), full_name: 'Eli Else', apollo_person_id: `ap_${TAG}_m2` });
  fixtures.set('mono.example', () => ({ people: [person('m1', 'Rita', { name: 'Mono' }), person('m2', 'Eli', { name: 'Mono' }), person('m3', 'New', { name: 'Mono' })], total: 3 }));
  await fastPacing();
  await cd.queueCompanies([co], { user: 'test' });
  const w = worker();
  await drain(w);
  await cd.queueCompanies([co], { kind: 'refresh', user: 'test' }); await fastPacing(); await drain(w);
  await cd.queueCompanies([co], { kind: 'refresh', user: 'test' }); await fastPacing(); await drain(w);
  for (const id of ['m1', 'm2', 'm3']) assert.equal((await byApollo(`ap_${TAG}_${id}`)).length, 1, `${id}: one canonical contact`);
  const r = await db.getContact(revealed);
  assert.equal(r.email, 'rita@mono.example');
  assert.equal(r.email_lookup_status, 'found');
  assert.equal(r.apollo_raw_json, '{"rich":true}');
  assert.equal(r.full_name, 'Rita Real');
  assert.equal((await db.getContact(elsewhere)).company_id, other, 'company relationship unchanged');
  const d = await disc(co);
  assert.equal(d.contacts_saved, 0, 'third run: nothing new');
  assert.equal(d.contacts_matched, 3);
  noRevealCalls();
});

/* ── Pagination ───────────────────────────────────────────────────────── */

const pageOf = (prefix, page, n) => Array.from({ length: n }, (_, i) => person(`${prefix}${page}_${i}`, `P${page}x${i}`, { name: 'Paged' }));

test('pagination: the first page only by default, Apollo total stored, Find more reads the next page', async () => {
  const co = await company(N('Paged Co'), 'paged.example');
  fixtures.set('paged.example', (page) => ({ people: page <= 2 ? pageOf('pg', page, 25) : pageOf('pg', page, 10), total: 60 }));
  await fastPacing();
  await cd.queueCompanies([co], { user: 'test' });
  calls.length = 0;
  await drain(worker());
  let d = await disc(co);
  assert.equal(d.status, 'found');
  assert.equal(d.pages_fetched, 1);
  assert.equal(d.next_page, 2);
  assert.equal(d.apollo_total, 60);
  assert.equal(cd.hasMorePages(d), true, '25 of 60 — more available');
  assert.equal((await contactsOf(co)).length, 25);
  const [more] = await cd.queueCompanies([co], { kind: 'more', user: 'test' });
  assert.equal(more.outcome, 'queued');
  await fastPacing(); await drain(worker());
  d = await disc(co);
  assert.equal(d.pages_fetched, 2);
  assert.deepEqual(searchCalls('paged.example').map((c) => c.body.page), [1, 2], 'page 2 requested once, page 1 not again');
  assert.equal((await contactsOf(co)).length, 50);
  await cd.queueCompanies([co], { kind: 'more', user: 'test' }); await fastPacing(); await drain(worker());
  d = await disc(co);
  assert.equal(d.pages_fetched, 3);
  assert.equal(cd.hasMorePages(d), false, 'all 60 read');
  const [none] = await cd.queueCompanies([co], { kind: 'more', user: 'test' });
  assert.equal(none.outcome, 'not_applicable', 'nothing more to find');
  noRevealCalls();
});

test('restart recovery: a worker that dies mid-company loses its lease; another resumes at the next page', async () => {
  const co = await company(N('Crash Co'), 'crash.example');
  await settings({ pages_per_company: 3 });
  // Page 2's first answer arrives after the lease (1.5s) has expired.
  fixtures.set('crash.example', (page, body, callNo) => ({ people: pageOf('cr', page, page < 3 ? 25 : 5), total: 55,
    delayMs: page === 2 && callNo === 2 ? 3500 : 0 }));
  await fastPacing();
  await cd.queueCompanies([co], { user: 'test' });
  calls.length = 0;
  const a = worker(); const b = worker();
  const slow = a.tick();                                            // page 1 done, stuck in page 2
  await new Promise((ok) => setTimeout(ok, 2500));
  let d = await disc(co);
  assert.equal(d.status, 'searching');
  assert.equal(d.pages_fetched, 1, 'page 1 was committed before page 2 was asked for');
  assert.ok(new Date(d.lease_expires_at) < new Date(), 'lease expired');
  await fastPacing();
  await b.tick();                                                    // reclaims, resumes at page 2
  await slow;                                                        // A's late answer must not land
  d = await disc(co);
  assert.equal(d.status, 'found');
  assert.equal(d.worker_id, null);
  assert.equal(d.pages_fetched, 3);
  const pages = searchCalls('crash.example').map((c) => c.body.page);
  assert.deepEqual(pages.filter((p) => p === 1).length, 1, 'page 1 not repeated after the restart');
  assert.equal((await contactsOf(co)).length, 55, 'every person exactly once');
  assert.equal(d.contacts_saved + d.contacts_matched, 55);
  await settings({ pages_per_company: 1 });
  noRevealCalls();
});

test('concurrent workers never search the same company twice', async () => {
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const co = await company(N(`Conc ${i}`), `conc${i}.example`);
    fixtures.set(`conc${i}.example`, () => ({ people: [person(`c${i}`, `C${i}`, { name: `Conc ${i}` })], total: 1 }));
    ids.push(co);
  }
  await fastPacing();
  await cd.queueCompanies(ids, { user: 'test' });
  calls.length = 0;
  const ws = [worker(), worker(), worker()];
  await Promise.all(ws.map((w) => drain(w, 3)));
  for (let i = 0; i < 4; i++) assert.equal(searchCalls(`conc${i}.example`).length, 1, `conc${i}: exactly one request`);
  for (const id of ids) assert.equal((await disc(id)).status, 'found');
  // Requests were paced by the shared slot, not fired together.
  const times = calls.map((c) => c.at).sort((x, y) => x - y);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 400, `spacing ${times[i] - times[i - 1]}ms`);
  noRevealCalls();
});

/* ── Failures ─────────────────────────────────────────────────────────── */

test('429: Retry-After honoured for the company and for every worker; then it completes', async () => {
  const co = await company(N('Limited Co'), 'limited.example');
  fixtures.set('limited.example', (page, body, callNo) => (callNo === 1
    ? { status: 429, headers: { 'Retry-After': '2' }, body: { error: 'rate limited' } }
    : { people: [person('l1', 'Lim', { name: 'Limited' })], total: 1 }));
  await fastPacing();
  await cd.queueCompanies([co], { user: 'test' });
  calls.length = 0;
  const w = worker();
  await w.tick();
  let d = await disc(co);
  assert.equal(d.status, 'queued');
  assert.equal(d.last_error_code, 'rate_limited');
  assert.equal(d.attempts, 1);
  assert.ok(new Date(d.next_attempt_at) - Date.now() > 1000, 'not before Retry-After');
  const { rows: [s] } = await pool.query('SELECT next_slot_at FROM contact_discovery_settings WHERE id = 1');
  assert.ok(new Date(s.next_slot_at) - Date.now() > 1000, 'the shared slot moved back too');
  await w.tick();
  assert.equal(searchCalls('limited.example').length, 1, 'not retried early');
  await new Promise((ok) => setTimeout(ok, 2300));
  await drain(w, 2);
  d = await disc(co);
  assert.equal(d.status, 'found');
  assert.equal(d.attempts, 0, 'reset after success');
  assert.equal(searchCalls('limited.example').length, 2);
  noRevealCalls();
});

test('transient 5xx and network errors back off and retry; after max attempts the company fails', async () => {
  const flaky = await company(N('Flaky Co'), 'flaky.example');
  fixtures.set('flaky.example', (page, body, callNo) => (callNo === 1 ? { drop: true } : callNo === 2 ? { status: 503 }
    : { people: [person('f1', 'Fla', { name: 'Flaky' })], total: 1 }));
  const dead = await company(N('Dead Co'), 'dead.example');
  fixtures.set('dead.example', () => ({ status: 500 }));
  await settings({ max_attempts: 3 });
  await fastPacing();
  await cd.queueCompanies([flaky, dead], { user: 'test' });
  calls.length = 0;
  const w = worker();
  for (let i = 0; i < 12; i++) { await w.tick(); await new Promise((ok) => setTimeout(ok, 700)); await fastPacing(); }
  assert.equal((await disc(flaky)).status, 'found');
  assert.equal(searchCalls('flaky.example').length, 3);
  const d = await disc(dead);
  assert.equal(d.status, 'failed');
  assert.equal(d.last_error_code, 'http_500');
  assert.equal(d.attempts, 3);
  assert.equal(searchCalls('dead.example').length, 3, 'stops at max attempts');
  // Retry is the explicit way back.
  const [r] = await cd.queueCompanies([dead], { kind: 'retry', user: 'test' });
  assert.equal(r.outcome, 'queued');
  assert.equal((await disc(dead)).attempts, 0);
  await pool.query('DELETE FROM company_contact_discovery WHERE company_id = $1', [dead]);
  await settings({ max_attempts: 5 });
  noRevealCalls();
});

test('permanent 4xx fails at once; 401/403 pause all discovery until cleared', async () => {
  const bad = await company(N('Bad Co'), 'bad.example');
  fixtures.set('bad.example', () => ({ status: 422, body: { error: 'invalid' } }));
  const auth = await company(N('Auth Co'), 'auth.example');
  let authOk = false;
  fixtures.set('auth.example', () => (authOk ? { people: [], total: 0 } : { status: 403, body: { error: 'plan does not include this' } }));
  await fastPacing();
  await cd.queueCompanies([bad], { user: 'test' });
  calls.length = 0;
  const w = worker();
  await drain(w, 2);
  let d = await disc(bad);
  assert.equal(d.status, 'failed');
  assert.equal(d.last_error_code, 'http_422');
  assert.equal(searchCalls('bad.example').length, 1, 'not retried');

  await cd.queueCompanies([auth], { user: 'test' });
  await fastPacing();
  await drain(w, 2);
  const { rows: [s] } = await pool.query('SELECT paused_reason FROM contact_discovery_settings WHERE id = 1');
  assert.match(s.paused_reason, /403/);
  d = await disc(auth);
  assert.equal(d.status, 'queued', 'the company is handed back, not failed');
  const before = calls.length;
  await drain(w, 3);
  assert.equal(calls.length, before, 'paused: nothing sent');
  authOk = true;
  await settings({ clear_pause: true }); await fastPacing();
  await drain(w, 2);
  assert.equal((await disc(auth)).status, 'no_results');
  noRevealCalls();
});

test('daily cap: the company is deferred to tomorrow without a request', async () => {
  const co = await company(N('Capped Co'), 'capped.example');
  fixtures.set('capped.example', () => ({ people: [], total: 0 }));
  await settings({ daily_request_cap: 0 }); await fastPacing();
  await cd.queueCompanies([co], { user: 'test' });
  calls.length = 0;
  await drain(worker(), 2);
  assert.equal(calls.length, 0);
  const d = await disc(co);
  assert.equal(d.status, 'queued');
  assert.ok(new Date(d.next_attempt_at) > new Date(), 'deferred');
  assert.equal(d.attempts, 0, 'not counted as a failure');
  await settings({ daily_request_cap: 300 });
  await pool.query('DELETE FROM company_contact_discovery WHERE company_id = $1', [co]);
});

/* ── Queue validation and policy ──────────────────────────────────────── */

test('queue input is validated; unknown companies are reported, not created', async () => {
  await assert.rejects(cd.queueCompanies([], {}), { code: 'bad_ids' });
  await assert.rejects(cd.queueCompanies(['x'], {}), { code: 'bad_ids' });
  await assert.rejects(cd.queueCompanies([1], { kind: 'reveal' }), { code: 'bad_kind' });
  await assert.rejects(cd.queueCompanies(Array.from({ length: 101 }, (_, i) => i + 1), {}), { code: 'too_many' });
  const [r] = await cd.queueCompanies([2147483000], {});
  assert.equal(r.outcome, 'not_found');
  await assert.rejects(cd.updateSettings({ worker_enabled: 'yes' }), { code: 'bad_value' });
  await assert.rejects(cd.updateSettings({ requests_per_minute: 1000 }), { code: 'bad_value' });
  await assert.rejects(cd.updateSettings({ drop: 1 }), { code: 'bad_setting' });
});

test('eligibility policy: listed exhibitors with a company, never queued, no contacts — a preview writes nothing', async () => {
  const { rows: [ev] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [N('Show')]);
  try {
    const a = await company(N('Elig A'), 'elig-a.example');
    const b = await company(N('Elig B'), null);
    const withContacts = await company(N('Elig C'), null);
    const queued = await company(N('Elig D'), null);
    const gone = await company(N('Elig E'), null);
    await db.insertContact({ company_id: withContacts, company: N('Elig C'), full_name: N('someone') });
    await cd.queueCompanies([queued], { user: 'test' });
    for (const [co, st] of [[a, 'listed'], [b, 'listed'], [withContacts, 'listed'], [queued, 'listed'], [gone, 'retired'], [null, 'listed']]) {
      await pool.query(`INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name, company_id, attendance_status) VALUES ($1,$2,$3,$4,$5)`,
        [ev.id, `${TAG}${co}${st}`, N(`ex ${co}`), co, st]);
    }
    const before = (await pool.query('SELECT count(*)::int n FROM company_contact_discovery')).rows[0].n;
    const el = await cd.eligibleCompanies(ev.id, { limit: 50 });
    assert.deepEqual(el.map((e) => e.company_id).sort(), [a, b].sort());
    assert.deepEqual(el.map((e) => e.mode).sort(), ['domain', 'name']);
    assert.equal((await pool.query('SELECT count(*)::int n FROM company_contact_discovery')).rows[0].n, before, 'preview writes nothing');
    assert.equal((await cd.eligibleCompanies(ev.id, { includeWithContacts: true })).length, 3);
    await pool.query('DELETE FROM company_contact_discovery WHERE company_id = $1', [queued]);
  } finally {
    await pool.query('DELETE FROM event_exhibitors WHERE event_id = $1', [ev.id]);
    await pool.query('DELETE FROM events WHERE id = $1', [ev.id]);
  }
});

test('outreach rows carry the discovery state without changing any count', async () => {
  const outreach = require('../outreach');
  const co = await company(N('Row Co'), 'row.example');
  const { rows: [ev] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [N('Row Show')]);
  try {
    const { rows: [ex] } = await pool.query(`INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name, company_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [ev.id, `${TAG}row`, N('Row Co'), co]);
    const k0 = (await outreach.summary(pool, ev.id)).kpis;
    let row = (await outreach.listExhibitors(pool, ev.id, {}, { all: true })).rows[0];
    assert.equal(row.discovery, null, 'not searched');
    await cd.queueCompanies([co], { user: 'test' });
    row = (await outreach.listExhibitors(pool, ev.id, {}, { all: true })).rows[0];
    assert.equal(row.discovery.status, 'queued');
    assert.deepEqual((await outreach.summary(pool, ev.id)).kpis, k0, 'KPIs untouched by the state');
    const det = await outreach.exhibitorDetail(pool, ex.id);
    assert.equal(det.discovery.status, 'queued');
    // An expired lease reads as queued, not "Searching…" forever.
    await pool.query(`UPDATE company_contact_discovery SET status = 'searching', worker_id = 'dead', lease_expires_at = NOW() - interval '1 minute' WHERE company_id = $1`, [co]);
    assert.equal((await cd.statesFor([co])).get(co).status, 'queued');
  } finally {
    await pool.query('DELETE FROM company_contact_discovery WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM event_exhibitors WHERE event_id = $1', [ev.id]);
    await pool.query('DELETE FROM events WHERE id = $1', [ev.id]);
  }
});

test('across the whole suite: zero reveal, enrichment or organisation calls', () => {
  assert.ok(allCalls.length > 20, 'the suite did search');
  assert.equal(allCalls.filter((c) => !c.path.endsWith('/mixed_people/api_search')).length, 0);
  assert.equal(allCalls.filter((c) => /reveal|allowApollo/.test(JSON.stringify(c.body))).length, 0);
});
