/* One Apollo person = one canonical CRM contact, and rediscovery never
   downgrades it. Reveal is explicit, updates that same contact and never
   drafts.

   Apollo is MOCKED: a local HTTP server stands in for api.apollo.io
   (APOLLO_BASE_URL), records every request and answers from fixtures.
   server.js runs against the test database. Nothing here can reach the real
   Apollo or spend a credit. */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dbGuard = require('./dbGuard');

if (!dbGuard.available) {
  test('apollo contact identity suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
  return;
}

const db = require('../db');
const outreach = require('../outreach');
const { pool } = db;
const TAG = `Zi${Date.now().toString(36)}`;
const N = (s) => `${TAG} ${s}`;
const USER = 'tester';
const PASS = 'pw';
const calls = [];
const fx = { people: () => [], match: () => ({ status: 500, body: { error: 'no fixture' } }) };
const made = { companies: [], contacts: [] };

const person = (id, first, org, extra = {}) => ({
  id: `ap_${TAG}_${id}`, first_name: first, last_name_obfuscated: 'F***s', title: 'Director of Manufacturing',
  has_email: true, organization: org, ...extra,
});

function startMockApollo() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      calls.push({ path: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/people/match')) {
        const r = fx.match(body);
        res.statusCode = r.status; return res.end(JSON.stringify(r.body));
      }
      if (req.url.endsWith('/mixed_people/api_search')) {
        const people = fx.people(body);
        return res.end(JSON.stringify({ people, total_entries: people.length }));
      }
      res.end(JSON.stringify({ organizations: [] }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

let mock; let server; let base;
const auth = { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') };
async function post(url, body) {
  const r = await fetch(base + url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, j: await r.json().catch(() => null) };
}
const search = async (name, extra = {}) => (await post('/api/leads/search', { companies: name, perCompanyLimit: 25, maxTotal: 200, ...extra })).j;
const revealCalls = () => calls.filter((c) => c.path.endsWith('/people/match'));
const byApolloId = async (apId) => (await pool.query('SELECT * FROM contacts WHERE apollo_person_id = $1 ORDER BY id', [apId])).rows;
async function company(name, website) {
  const { rows: [c] } = await pool.query(`INSERT INTO companies (name, name_key, website, source) VALUES ($1, $2, $3, 'manual') RETURNING id`,
    [name, require('../companyKey').normalizeNameKey(name), website]);
  made.companies.push(c.id); return c.id;
}
const commsOf = async (contactId) => (await pool.query('SELECT id, comm_type FROM communications WHERE contact_id = $1', [contactId])).rows;

test.before(async () => {
  await db.initDb();
  mock = await startMockApollo();
  const port = 36000 + Math.floor(Math.random() * 900);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port),
      DATABASE_URL: process.env.TEST_DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      APP_USERNAME: USER, APP_PASSWORD: PASS, APOLLO_API_KEY: 'mock-key', APOLLO_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
      CLAUDE_API_KEY: '', OPENAI_API_KEY: '', BAILIAN_API_KEY: '', TAVILY_API_KEY: '', MYS_COOKIE: '', NEON_DATABASE_URL: '', RENDER_DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start\n${log}`)), 30000);
    const on = (d) => { log += d; if (/running at/.test(log)) { clearTimeout(t); resolve(); } };
    server.stdout.on('data', on); server.stderr.on('data', on);
    server.on('exit', (c) => { clearTimeout(t); reject(new Error(`server exited ${c}\n${log}`)); });
  });
});

test.after(async () => {
  try {
    server.removeAllListeners('exit'); server.kill(); mock.close();
    const { rows } = await pool.query('SELECT id FROM companies WHERE name LIKE $1', [`${TAG}%`]);
    const coIds = [...new Set([...made.companies, ...rows.map((r) => r.id)])];
    const { rows: people } = await pool.query(
      `SELECT id FROM contacts WHERE company_id = ANY($1::int[]) OR full_name LIKE $2 OR apollo_person_id LIKE $3 OR id = ANY($4::int[])`,
      [coIds, `%${TAG}%`, `ap_${TAG}%`, made.contacts]);
    const pids = people.map((p) => p.id);
    await pool.query('DELETE FROM apollo_results WHERE company_id = ANY($1::int[]) OR contact_id = ANY($2::int[])', [coIds, pids]).catch(() => {});
    await pool.query('DELETE FROM communications WHERE contact_id = ANY($1::int[])', [pids]);
    await db.deleteContacts(pids);
    await pool.query('DELETE FROM company_activity WHERE company_id = ANY($1::int[])', [coIds]).catch(() => {});
    await pool.query('DELETE FROM crm_activity WHERE company_id = ANY($1::int[])', [coIds]).catch(() => {});
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [coIds]);
    await pool.query('DELETE FROM company_search_cache WHERE company_key LIKE $1', [`${TAG.toLowerCase()}%`]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE name LIKE $1', [`${TAG}%`]);
    await db.ensureApolloPersonIdIndexes();   // leave the test DB with its index
  } finally { await pool.end(); }
});

/* ── Migration ─────────────────────────────────────────────────────────── */

test('index migration: duplicates block only the unique index — nothing is deleted, merged or moved', async () => {
  const co = await company(N('Dup Co'), null);
  await pool.query('DROP INDEX IF EXISTS uq_contacts_apollo_person_id');
  const dupId = `ap_${TAG}_dup`;
  const a = await db.insertContact({ company_id: co, company: N('Dup Co'), full_name: N('Dup A'), apollo_person_id: dupId });
  const b = await db.insertContact({ company_id: co, company: N('Dup Co'), full_name: N('Dup B'), apollo_person_id: dupId });
  // Many contacts without an Apollo id: NULL and '' are always allowed.
  const blanks = [];
  for (const v of ['', '', null, null]) {
    blanks.push(await db.insertContact({ company_id: co, company: N('Dup Co'), full_name: N(`Blank ${blanks.length}`) }));
    if (v === null) await pool.query('UPDATE contacts SET apollo_person_id = NULL WHERE id = $1', [blanks[blanks.length - 1]]);
  }
  made.contacts.push(a, b, ...blanks);
  const snapshot = async () => (await pool.query('SELECT id, company_id, apollo_person_id, full_name FROM contacts WHERE id = ANY($1::int[]) ORDER BY id', [[a, b, ...blanks]])).rows;
  const before = await snapshot();

  const r1 = await db.ensureApolloPersonIdIndexes();
  assert.equal(r1.unique, false, 'unique index not created over duplicates');
  assert.ok(r1.duplicates.some((d) => d.apollo_person_id === dupId && d.contact_ids.map(Number).join() === [a, b].join()));
  assert.deepEqual(await snapshot(), before, 'no contact changed');
  const { rows: [plain] } = await pool.query(`SELECT to_regclass('idx_contacts_apollo_person_id') IS NOT NULL AS ok`);
  assert.equal(plain.ok, true, 'the lookup index exists regardless');
  // Running again (every deploy runs initDb) is harmless.
  assert.equal((await db.ensureApolloPersonIdIndexes()).unique, false);

  // Once a person resolves the duplicate, the next start adds the unique index.
  await pool.query(`UPDATE contacts SET apollo_person_id = '' WHERE id = $1`, [b]);
  const r2 = await db.ensureApolloPersonIdIndexes();
  assert.equal(r2.unique, true);
  await assert.rejects(db.insertContact({ company_id: co, company: N('Dup Co'), full_name: N('Dup C'), apollo_person_id: dupId }), { code: '23505' });
  // Blank ids stay valid in any number under the unique index.
  const more = await db.insertContact({ company_id: co, company: N('Dup Co'), full_name: N('Blank more') });
  made.contacts.push(more);
});

/* ── Identity and monotonic re-import (through /api/leads/search) ───────── */

test('repeated discovery of one Apollo person resolves to one contact, idempotently', async () => {
  const co = await company(N('Idem Co'), 'idem.example');
  fx.people = () => [person('p1', 'Pat', { name: 'Idem Co' })];
  calls.length = 0;
  await search(N('Idem Co'));
  const first = await byApolloId(`ap_${TAG}_p1`);
  assert.equal(first.length, 1);
  assert.equal(first[0].company_id, co);
  // Force a full re-import (the path that used to overwrite), with a new title.
  fx.people = () => [person('p1', 'Pat', { name: 'Idem Co' }, { title: 'VP Manufacturing' })];
  await search(N('Idem Co'), { force: true });
  await search(N('Idem Co'), { force: true });
  const after = await byApolloId(`ap_${TAG}_p1`);
  assert.equal(after.length, 1, 'still exactly one contact');
  assert.equal(after[0].id, first[0].id, 'the same canonical contact');
  assert.equal(after[0].job_title, 'VP Manufacturing', 'descriptive fields refresh');
  assert.equal(revealCalls().length, 0, 'discovery never reveals');
});

test('Apollo id matches even when name, LinkedIn and company text all differ', async () => {
  const co = await company(N('Renamed Co'), 'renamed.example');
  const other = await company(N('Filed Elsewhere'), null);
  const prior = await db.insertContact({ company_id: other, company: N('Filed Elsewhere'), full_name: 'Patricia Hand-Corrected',
    apollo_person_id: `ap_${TAG}_p2` });
  made.contacts.push(prior);
  fx.people = () => [person('p2', 'Pat', { name: 'Renamed Co' })];
  await search(N('Renamed Co'), { force: true });
  const rows = await byApolloId(`ap_${TAG}_p2`);
  assert.deepEqual(rows.map((r) => r.id), [prior], 'no duplicate created');
  assert.equal(rows[0].company_id, other, 'company link preserved — never re-parented');
  assert.equal(rows[0].full_name, 'Patricia Hand-Corrected', 'manual name kept over the masked search name');
  assert.equal(rows[0].job_title, 'Director of Manufacturing', 'the search did reach this contact (title filled)');
  const { rows: onTarget } = await pool.query('SELECT id FROM contacts WHERE company_id = $1', [co]);
  assert.equal(onTarget.length, 0);
});

test('a revealed email, lookup state and full payload survive rediscovery', async () => {
  const co = await company(N('Reveal Co'), 'reveal.example');
  const rich = JSON.stringify({ id: `ap_${TAG}_p3`, email: 'rita@reveal.example', employment_history: [{ title: 'x' }] });
  const prior = await db.insertContact({ company_id: co, company: N('Reveal Co'), full_name: 'Rita Real', apollo_person_id: `ap_${TAG}_p3`,
    email: 'rita@reveal.example', email_source: 'apollo_enrichment', email_lookup_status: 'found', has_email: true, apollo_raw_json: rich });
  const gone = await db.insertContact({ company_id: co, company: N('Reveal Co'), full_name: 'Una Known', apollo_person_id: `ap_${TAG}_p4`,
    email_lookup_status: 'not_available', has_email: true });
  made.contacts.push(prior, gone);
  fx.people = () => [person('p3', 'Rita', { name: 'Reveal Co' }), person('p4', 'Una', { name: 'Reveal Co' })];
  const d = await search(N('Reveal Co'), { force: true });
  const [r] = await byApolloId(`ap_${TAG}_p3`);
  assert.equal(r.email, 'rita@reveal.example');
  assert.equal(r.email_source, 'apollo_enrichment');
  assert.equal(r.email_lookup_status, 'found');
  assert.equal(r.apollo_raw_json, rich, 'richer payload not replaced by the search payload');
  assert.equal(r.full_name, 'Rita Real');
  assert.equal(r.job_title, 'Director of Manufacturing', 'the search did reach this contact');
  const [u] = await byApolloId(`ap_${TAG}_p4`);
  assert.equal(u.email_lookup_status, 'not_available', 'a confirmed miss is not reset to not_checked (which would invite a paid re-reveal)');
  // The page is told what the CRM holds, not what the search returned.
  const shown = (d.contacts || []).find((c) => c.apollo_id === `ap_${TAG}_p3`);
  if (shown) {
    assert.equal(shown.email, 'rita@reveal.example');
    assert.equal(shown.email_lookup_status, 'found');
  }
  assert.equal(revealCalls().length, 0);
});

test('concurrent discovery of the same new person yields one contact', async () => {
  await company(N('Race Co'), 'race.example');
  fx.people = () => [person('p5', 'Rick', { name: 'Race Co' })];
  const got = await Promise.all([search(N('Race Co'), { force: true }), search(N('Race Co'), { force: true })]);
  assert.ok(got.every((g) => g && g.ok !== false), JSON.stringify(got.map((g) => g && g.error)));
  assert.equal((await byApolloId(`ap_${TAG}_p5`)).length, 1);
});

/* ── Reveal: gated, same contact, no draft ─────────────────────────────── */

test('without allowApollo:true nothing reveals — enrich-email and the legacy reveal route', async () => {
  const co = await company(N('Gate Co'), null);
  const id = await db.insertContact({ company_id: co, company: N('Gate Co'), full_name: N('Gate'), apollo_person_id: `ap_${TAG}_g1`, has_email: true });
  made.contacts.push(id);
  fx.match = () => ({ status: 200, body: { person: { email: 'must-not@see.example' } } });
  calls.length = 0;
  for (const body of [{}, { allowApollo: false }, { allowApollo: 'true' }, { allowApollo: 1 }]) {
    const r = await post(`/api/contacts/${id}/enrich-email`, body);
    assert.equal(r.status, 200);
    assert.equal(r.j.needsApollo, true, JSON.stringify(body));
    assert.equal(r.j.creditsUsed, 0);
  }
  const legacy = await post('/api/reveal-email', { apollo_id: `ap_${TAG}_g1`, contact_id: id });
  assert.equal(legacy.j.needsApollo, true);
  // The estimate is free.
  const est = await post('/api/contacts/reveal-estimate', { ids: [id] });
  assert.equal(est.j.estimatedCredits, 1);
  assert.equal(revealCalls().length, 0, 'no people/match request was made');
  const c = await db.getContact(id);
  assert.equal(c.email, '');
  assert.equal(c.email_lookup_status, 'not_checked');
});

test('explicit reveal: one people/match call, same contact updated, no draft created; drafts and sends stay on it', async () => {
  const co = await company(N('Explicit Co'), null);
  const exhibitorCo = co;
  const id = await db.insertContact({ company_id: co, company: N('Explicit Co'), full_name: N('Eve'), apollo_person_id: `ap_${TAG}_e1`, has_email: true });
  made.contacts.push(id);
  fx.match = (b) => ({ status: 200, body: { person: { id: b.id, email: 'eve@explicit.example', first_name: 'Eve' } } });
  calls.length = 0;
  const r = await post(`/api/contacts/${id}/enrich-email`, { allowApollo: true });
  assert.equal(r.status, 200);
  assert.equal(r.j.email, 'eve@explicit.example');
  assert.equal(r.j.creditsUsed, 1);
  assert.equal(revealCalls().length, 1);
  assert.equal(revealCalls()[0].body.id, `ap_${TAG}_e1`, 'revealed the stored Apollo person');
  const c = await db.getContact(id);
  assert.equal(c.email, 'eve@explicit.example');
  assert.equal(c.email_lookup_status, 'found');
  assert.equal(c.email_source, 'apollo_enrichment');
  assert.equal(c.company_id, co, 'same company');
  assert.deepEqual(await commsOf(id), [], 'a reveal never drafts');
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int n FROM contacts WHERE apollo_person_id = $1', [`ap_${TAG}_e1`]);
  assert.equal(n, 1, 'no second contact');

  // A second click is free: the address is stored.
  calls.length = 0;
  const again = await post(`/api/contacts/${id}/enrich-email`, { allowApollo: true });
  assert.equal(again.j.creditsUsed, 0);
  assert.equal(revealCalls().length, 0);

  // Draft then send: both hang off the same canonical contact.
  const draft = await db.insertCommunication({ contact_id: id, company_id: exhibitorCo, comm_type: 'draft', status: 'draft',
    draft_mode: 'cold_outreach', subject: 'Hi', body: 'B', to_email: c.email });
  let [row] = await outreach.contactsForCompanies(pool, [co]);
  assert.equal(row.id, id); assert.equal(row.status, 'drafted'); assert.equal(row.draft_id, draft.id);
  await db.markCommunicationSend(draft.id, { delivery_status: 'sent', sent_at: new Date() });
  [row] = await outreach.contactsForCompanies(pool, [co]);
  assert.equal(row.id, id); assert.equal(row.status, 'sent'); assert.equal(row.last_sent_id, draft.id);

  // And a later rediscovery leaves the revealed address alone.
  fx.people = () => [person('e1', 'Eve', { name: N('Explicit Co') })];
  await search(N('Explicit Co'), { force: true });
  const after = await db.getContact(id);
  assert.equal(after.email, 'eve@explicit.example');
  assert.equal(after.email_lookup_status, 'found');
});

test('reveal outcomes: Apollo has none → not_available; Apollo fails → 502 and nothing recorded', async () => {
  const co = await company(N('Outcome Co'), null);
  const none = await db.insertContact({ company_id: co, company: N('Outcome Co'), full_name: N('None'), apollo_person_id: `ap_${TAG}_o1`, has_email: true });
  const fail = await db.insertContact({ company_id: co, company: N('Outcome Co'), full_name: N('Fail'), apollo_person_id: `ap_${TAG}_o2`, has_email: true });
  made.contacts.push(none, fail);

  fx.match = () => ({ status: 200, body: { person: { email: null } } });
  const a = await post(`/api/contacts/${none}/enrich-email`, { allowApollo: true });
  assert.equal(a.status, 200);
  assert.equal(a.j.email, '');
  assert.equal(a.j.email_lookup_status, 'not_available');
  assert.equal((await db.getContact(none)).email_lookup_status, 'not_available');
  const rows = await outreach.contactsForCompanies(pool, [co]);
  assert.equal(rows.find((r) => r.id === none).status, 'no_email');
  assert.equal(rows.find((r) => r.id === none).revealable, false, 'not offered again');

  fx.match = () => ({ status: 503, body: { error: 'Apollo down' } });
  const b = await post(`/api/contacts/${fail}/enrich-email`, { allowApollo: true });
  assert.equal(b.status, 502);
  const f = await db.getContact(fail);
  assert.equal(f.email_lookup_status, 'not_checked', 'a failure is not recorded as "unavailable"');
  assert.equal((await outreach.contactsForCompanies(pool, [co])).find((r) => r.id === fail).status, 'email_locked', 'still offers Reveal (Retry)');
});
