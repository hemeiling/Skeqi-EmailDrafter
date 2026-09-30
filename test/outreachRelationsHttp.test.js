/* Authorization over real HTTP: the server itself, not the page, decides who
   may record or revoke a company-identity decision — the application's
   isAdmin(req), the same rule as every other admin action.

   With today's single shared login, the only credential that can sign in is
   APP_USERNAME, and isAdmin() treats it as the administrator; an
   authenticated NON-admin cannot exist over HTTP. That case is covered by the
   module-level test (anything but canReview === true → 403) and by the wiring
   check below that every write route passes isAdmin(req). */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dbGuard = require('./dbGuard');

if (!dbGuard.available) {
  test('relations HTTP suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
  return;
}

const db = require('../db');
const { pool } = db;
const USER = 'reviewer';
const PASS = 'test-pass';
const RUN = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const F = { companies: [], contacts: [] };

function startServer(adminUsers) {
  const port = 38000 + Math.floor(Math.random() * 2000);
  const env = {
    ...process.env,
    NODE_ENV: 'test', PORT: String(port),
    DATABASE_URL: process.env.TEST_DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    APP_USERNAME: USER, APP_PASSWORD: PASS, ADMIN_USERS: adminUsers,
    // No external service can be reached from this test.
    CLAUDE_API_KEY: '', OPENAI_API_KEY: '', APOLLO_API_KEY: '', BAILIAN_API_KEY: '', TAVILY_API_KEY: '', MYS_COOKIE: '',
    NEON_DATABASE_URL: '', RENDER_DATABASE_URL: '', REPLY_INGEST_TOKEN: '',
  };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 30000);
    const on = (d) => { log += d; if (/running at/.test(log)) { clearTimeout(t); resolve(); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exited ${code}:\n${log}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') };
  const call = async (method, url, { body, type = 'application/json', login = true } = {}) => {
    const r = await fetch(base + url, { method, headers: { ...(login ? auth : {}), ...(body !== undefined ? { 'Content-Type': type } : {}) },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    let j = null; try { j = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, j };
  };
  return { ready, call, stop: () => new Promise((res) => { child.removeAllListeners('exit'); child.on('exit', res); child.kill(); }) };
}

const liveCount = async () => (await pool.query(
  'SELECT count(*)::int n FROM exhibitor_company_relations WHERE exhibitor_id = $1', [F.ex])).rows[0].n;

test.before(async () => {
  await db.initDb();
  const { rows: [ev] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [`ZZHTTP${RUN} Show`]);
  F.event = ev.id;
  const mk = async (name, website) => {
    const { rows: [c] } = await pool.query(`INSERT INTO companies (name, name_key, website, source) VALUES ($1, lower($1), $2, 'manual') RETURNING id`, [name, website]);
    F.companies.push(c.id); return c.id;
  };
  F.direct = await mk(`zzhttp${RUN} acme`, 'acme-http.example');
  F.cand = await mk(`zzhttp${RUN} acme labs`, null);
  F.contacts.push(await db.insertContact({ company_id: F.cand, company: '', full_name: 'Cand Person', email: 'p@acme-http.example' }));
  const { rows: [e] } = await pool.query(
    `INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name, company_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ev.id, `zzhttp${RUN}`, `zzhttp${RUN} acme`, F.direct]);
  F.ex = e.id;
  const { rows: [run] } = await pool.query(
    `INSERT INTO exhibitor_import_runs (event_id, status, dry_run, finished_at) VALUES ($1,'success',FALSE, NOW() + interval '2 days') RETURNING id`, [ev.id]);
  F.run = run.id;
});

test.after(async () => {
  try {
    await pool.query('DELETE FROM exhibitor_company_relations WHERE exhibitor_id = $1', [F.ex]);
    await pool.query('DELETE FROM crm_activity WHERE company_id = ANY($1::int[])', [F.companies]);
    await db.deleteContacts(F.contacts);
    await pool.query('DELETE FROM event_exhibitors WHERE id = $1', [F.ex]);
    await pool.query('DELETE FROM exhibitor_import_runs WHERE id = $1', [F.run]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [F.companies]);
    await pool.query('DELETE FROM events WHERE id = $1', [F.event]);
  } finally { await pool.end(); }
});

test('the relation routes pass exactly isAdmin(req) as the write permission', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = (route) => { const i = src.indexOf(route); assert.ok(i > 0, route); return src.slice(i, src.indexOf('\n});', i)); };
  for (const route of ["app.post('/api/outreach/exhibitors/:id/relations'", "app.post('/api/outreach/relations/:id/revoke'",
    "app.get('/api/outreach/exhibitors/:id/related'"]) {
    assert.match(block(route), /canReview: isAdmin\(req\)/, route);
  }
});

test('signed out → 401; the APP_USERNAME administrator can decide, change and revoke (ADMIN_USERS not needed)', async () => {
  const s = startServer('');
  try {
    await s.ready;
    assert.equal((await s.call('GET', `/api/outreach/exhibitors/${F.ex}/related`)).j.can_review, true);
    // Not signed in: every relation route is behind the login gate.
    assert.equal((await s.call('GET', `/api/outreach/exhibitors/${F.ex}/related`, { login: false })).status, 401);
    assert.equal((await s.call('POST', `/api/outreach/exhibitors/${F.ex}/relations`, { body: { related_company_id: F.cand, decision: 'same_company' }, login: false })).status, 401);
    assert.equal((await s.call('POST', '/api/outreach/relations/1/revoke', { body: {}, login: false })).status, 401);
    assert.equal(await liveCount(), 0);
    // Cross-site form shape.
    const form = await s.call('POST', `/api/outreach/exhibitors/${F.ex}/relations`, { body: `related_company_id=${F.cand}&decision=same_company`, type: 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);
    assert.equal(await liveCount(), 0);
    // Bad ids.
    assert.equal((await s.call('POST', `/api/outreach/exhibitors/abc/relations`, { body: { related_company_id: F.cand, decision: 'same_company' } })).status, 400);
    assert.equal((await s.call('POST', `/api/outreach/exhibitors/${F.ex}/relations`, { body: { related_company_id: F.direct, decision: 'same_company' } })).j.error, 'direct_company');
    // Decide.
    const a = await s.call('POST', `/api/outreach/exhibitors/${F.ex}/relations`, { body: { related_company_id: F.cand, decision: 'same_company', reason: 'shared domain' } });
    assert.equal(a.status, 200, JSON.stringify(a.j));
    assert.equal(a.j.relation.decided_by, USER);
    const detail = await s.call('GET', `/api/outreach/exhibitors/${F.ex}/contacts`);
    assert.equal(detail.j.reviewed.length, 1);
    assert.equal(detail.j.reviewed[0].contacts[0].link_type, 'reviewed');
    // Change, then revoke.
    const b = await s.call('POST', `/api/outreach/exhibitors/${F.ex}/relations`, { body: { related_company_id: F.cand, decision: 'not_same_company', reason: 'checked again' } });
    assert.equal(b.status, 200);
    const again = await s.call('POST', `/api/outreach/exhibitors/${F.ex}/relations`, { body: { related_company_id: F.cand, decision: 'not_same_company' } });
    assert.equal(again.status, 409);
    const rv = await s.call('POST', `/api/outreach/relations/${b.j.relation.id}/revoke`, { body: { reason: 'back to undecided' } });
    assert.equal(rv.status, 200);
    assert.equal((await s.call('POST', `/api/outreach/relations/${b.j.relation.id}/revoke`, { body: {} })).status, 409);
    const hist = await s.call('GET', `/api/outreach/exhibitors/${F.ex}/relations/history`);
    assert.deepEqual(hist.j.history.map((h) => h.decision), ['same_company', 'not_same_company']);
    assert.ok(hist.j.history.every((h) => h.revoked_at), 'both decisions are now history');
  } finally { await s.stop(); }
});
