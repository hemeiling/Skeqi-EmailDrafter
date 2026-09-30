/* Contact discovery over real HTTP, with the real server and its real worker
   (ticking fast) and Apollo MOCKED. What a deployment must guarantee:

     • starting the server queues nothing and sends nothing to Apollo
     • the Outreach page's reads never search
     • writes are administrator-only and JSON-only; input is validated
     • queuing while discovery is switched off stays queued: no request

   Runs only against TEST_DATABASE_URL. */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dbGuard = require('./dbGuard');

if (!dbGuard.available) {
  test('contact discovery HTTP suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
  return;
}

const db = require('../db');
const { pool } = db;
const TAG = `Zh${Date.now().toString(36)}`;
const USER = 'admin-user';
const PASS = 'pw';
const calls = [];
const made = { companies: [], exhibitors: [], events: [], runs: [] };
let mock; let server; let base;

const auth = { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') };
async function call(method, url, { body, type = 'application/json' } = {}) {
  const r = await fetch(base + url, { method, headers: { ...auth, ...(body !== undefined ? { 'Content-Type': type } : {}) },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, j };
}
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

test.before(async () => {
  await db.initDb();
  await pool.query(`UPDATE contact_discovery_settings SET worker_enabled = FALSE, auto_queue_enabled = FALSE, paused_reason = NULL WHERE id = 1`);
  mock = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => { calls.push({ path: req.url, body: raw }); res.setHeader('Content-Type', 'application/json'); res.end('{"people":[],"total_entries":0}'); });
  });
  await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
  const { rows: [ev] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [`${TAG} Show`]);
  made.events.push(ev.id);
  const { rows: [run] } = await pool.query(`INSERT INTO exhibitor_import_runs (event_id, status, dry_run, finished_at) VALUES ($1,'success',FALSE, NOW() + interval '5 days') RETURNING id`, [ev.id]);
  made.runs.push(run.id);
  for (const [name, site] of [['Alpha', 'alpha-h.example'], ['Beta', null]]) {
    const { rows: [c] } = await pool.query(`INSERT INTO companies (name, website, source) VALUES ($1,$2,'manual') RETURNING id`, [`${TAG} ${name}`, site]);
    made.companies.push(c.id);
    const { rows: [e] } = await pool.query(`INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name, company_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [ev.id, `${TAG}${name}`, `${TAG} ${name}`, c.id]);
    made.exhibitors.push(e.id);
  }
  const { rows: [u] } = await pool.query(`INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name) VALUES ($1,$2,$3) RETURNING id`,
    [ev.id, `${TAG}unmatched`, `${TAG} Unmatched`]);
  made.exhibitors.push(u.id);

  const port = 37000 + Math.floor(Math.random() * 900);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port),
      DATABASE_URL: process.env.TEST_DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      APP_USERNAME: USER, APP_PASSWORD: PASS, APOLLO_API_KEY: 'mock-key', APOLLO_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
      CONTACT_DISCOVERY_TICK_MS: '200', CONTACT_DISCOVERY_WORKER: '',
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
    await pool.query(`UPDATE contact_discovery_settings SET worker_enabled = FALSE, auto_queue_enabled = FALSE, paused_reason = NULL WHERE id = 1`);
    await pool.query('DELETE FROM company_contact_discovery WHERE company_id = ANY($1::int[])', [made.companies]);
    await pool.query('DELETE FROM event_exhibitors WHERE id = ANY($1::int[])', [made.exhibitors]);
    await pool.query('DELETE FROM exhibitor_import_runs WHERE id = ANY($1::int[])', [made.runs]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [made.companies]);
    await pool.query('DELETE FROM events WHERE id = ANY($1::int[])', [made.events]);
  } finally { await pool.end(); }
});

test('server start and page reads are inert: nothing queued, nothing sent to Apollo', async () => {
  await wait(1200);                                                  // several worker ticks
  const st = await call('GET', '/api/contact-discovery/status');
  assert.equal(st.status, 200);
  assert.equal(st.j.settings.worker_enabled, false);
  assert.equal(st.j.settings.auto_queue_enabled, false);
  assert.equal(st.j.can_manage, true);
  const list = await call('GET', '/api/outreach/exhibitors?page_size=100');
  const mine = list.j.rows.filter((r) => made.exhibitors.includes(r.exhibitor_id));
  assert.equal(mine.length, 3);
  assert.ok(mine.every((r) => r.discovery === null), 'no state: not searched');
  await call('GET', `/api/outreach/exhibitors/${made.exhibitors[0]}/contacts`);
  await call('GET', '/api/outreach/summary');
  const { rows } = await pool.query('SELECT count(*)::int n FROM company_contact_discovery WHERE company_id = ANY($1::int[])', [made.companies]);
  assert.equal(rows[0].n, 0);
  assert.equal(calls.length, 0, 'no Apollo request');
});

test('writes are JSON-only and validated', async () => {
  const ex = made.exhibitors[0];
  assert.equal((await call('POST', `/api/outreach/exhibitors/${ex}/discovery`, { body: 'action=search', type: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await call('POST', '/api/contact-discovery/settings', { body: 'worker_enabled=true', type: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await call('POST', `/api/outreach/exhibitors/${ex}/discovery`, { body: { action: 'reveal' } })).status, 400);
  assert.equal((await call('POST', '/api/outreach/exhibitors/abc/discovery', { body: { action: 'search' } })).status, 400);
  assert.equal((await call('POST', '/api/outreach/exhibitors/2147483000/discovery', { body: { action: 'search' } })).status, 404);
  assert.equal((await call('POST', `/api/outreach/exhibitors/${made.exhibitors[2]}/discovery`, { body: { action: 'search' } })).j.error, 'unmatched');
  assert.equal((await call('POST', '/api/contact-discovery/settings', { body: { worker_enabled: 'yes' } })).status, 400);
  assert.equal((await call('POST', '/api/contact-discovery/queue', { body: { company_ids: ['1; DROP'] } })).status, 400);
  const { rows: [s] } = await pool.query('SELECT worker_enabled FROM contact_discovery_settings WHERE id = 1');
  assert.equal(s.worker_enabled, false, 'nothing changed');
});

test('the eligibility preview is a read', async () => {
  const r = await call('GET', `/api/contact-discovery/eligible?event_id=${made.events[0]}&limit=10`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.companies.map((c) => c.company_id).sort(), [...made.companies].sort());
  const { rows } = await pool.query('SELECT count(*)::int n FROM company_contact_discovery WHERE company_id = ANY($1::int[])', [made.companies]);
  assert.equal(rows[0].n, 0);
});

test('queuing while switched off stays queued; switching on runs it — people search only', async () => {
  const ex = made.exhibitors[0];
  const q = await call('POST', `/api/outreach/exhibitors/${ex}/discovery`, { body: { action: 'search' } });
  assert.equal(q.status, 200);
  assert.equal(q.j.result.outcome, 'queued');
  assert.equal(q.j.discovery.status, 'queued');
  await wait(1000);
  assert.equal(calls.length, 0, 'switched off: no request');
  const row = (await call('GET', '/api/outreach/exhibitors?page_size=100')).j.rows.find((r) => r.exhibitor_id === ex);
  assert.equal(row.discovery.status, 'queued');

  const on = await call('POST', '/api/contact-discovery/settings', { body: { worker_enabled: true, requests_per_minute: 120 } });
  assert.equal(on.status, 200);
  await pool.query('UPDATE contact_discovery_settings SET next_slot_at = NOW() WHERE id = 1');
  for (let i = 0; i < 40 && !calls.length; i++) await wait(100);
  await wait(500);
  assert.equal(calls.length, 1, 'exactly one request');
  assert.ok(calls[0].path.endsWith('/mixed_people/api_search'));
  assert.match(calls[0].body, /"q_organization_domains_list":\["alpha-h.example"\]/);
  const after = (await call('GET', `/api/outreach/exhibitors/${ex}/contacts`)).j;
  assert.equal(after.discovery.status, 'no_results');
  // Only the one queued company was searched; the other stayed untouched.
  const { rows } = await pool.query('SELECT company_id FROM company_contact_discovery WHERE company_id = ANY($1::int[])', [made.companies]);
  assert.deepEqual(rows.map((r) => r.company_id), [made.companies[0]]);
  await call('POST', '/api/contact-discovery/settings', { body: { worker_enabled: false } });
});
