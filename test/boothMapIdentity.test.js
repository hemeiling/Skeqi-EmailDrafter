/* Booth Map identity confirmation — admin-only, append-only, display-only.

   What is pinned: only an admin writes; only a pair the server queued can be
   decided; every change keeps the previous decision (revoked, never deleted);
   a confirmation shows the classification on the live map and nothing else —
   no CRM company, link, booth or classification row changes, ever.

   Runs only against TEST_DATABASE_URL (see dbGuard). */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dbGuard = require('./dbGuard');

test('routes: every identity write goes through isAdmin and JSON-only', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const post = server.slice(server.indexOf("app.post('/api/booth-map/identity-review'"));
  const body = post.slice(0, post.indexOf('\n});'));
  assert.match(body, /if \(!isAdmin\(req\)\) return res\.status\(403\)/);
  assert.match(body, /requireJson\(req, res\)/);
  assert.match(body, /recordDecision\(pool, req\.body \|\| \{\}, \{ isAdmin: isAdmin\(req\), user: reqUser\(req\) \}\)/);
  assert.match(body, /logCrmActivity\(/);
  const get = server.slice(server.indexOf("app.get('/api/booth-map/identity-review'"));
  assert.match(get.slice(0, 400), /listQueue\(pool, \{ isAdmin: isAdmin\(req\) \}\)/);
  const mig = fs.readFileSync(path.join(__dirname, '..', 'docs', 'migrations', '2026-10-13_booth_map_identity_decisions.sql'), 'utf8');
  const dbjs = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  for (const col of ['map_booth_id INTEGER NOT NULL REFERENCES booth_map_booths(id)', "CHECK (decision IN ('confirmed', 'rejected', 'deferred'))",
    'evidence JSONB NOT NULL', 'CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))', 'uq_bmid_live']) {
    assert.ok(mig.includes(col) && dbjs.includes(col), `migration file and db.js disagree on: ${col}`);
  }
  assert.doesNotMatch(mig, /\b(drop|alter|delete|truncate|update)\b/i, 'the migration is additive only');
});

test('input validation needs no database', () => {
  const { normalize } = require('../boothMapIdentity');
  assert.throws(() => normalize({ map_booth_id: 'x', exhibitor_id: 1, decision: 'deferred' }), { code: 'bad_pair' });
  assert.throws(() => normalize({ map_booth_id: 1, exhibitor_id: 2, decision: 'merge' }), { code: 'bad_decision' });
  assert.throws(() => normalize({ map_booth_id: 1, exhibitor_id: 2, decision: 'confirmed' }), { code: 'reason_required' });
  assert.throws(() => normalize({ map_booth_id: 1, exhibitor_id: 2, decision: 'rejected', reason: 'x'.repeat(501) }), { code: 'reason_too_long' });
  assert.equal(normalize({ map_booth_id: 1, exhibitor_id: 2, decision: 'deferred' }).reason, '');
});

const db = dbGuard.available ? require('../db') : null;
const dbTest = dbGuard.available ? test : test.skip;
if (!dbGuard.available) test('identity DB suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
const pool = db && db.pool;
const T = (s) => `bmi-${process.pid}-${s}`;
const ids = { companies: [], booths: [], intel: [], runs: [] };
let eventId;
const F = {};

async function everythingElse() {
  const { rows: [r] } = await pool.query(`SELECT
    (SELECT md5(string_agg(id || ':' || name, ',' ORDER BY id)) FROM companies) c,
    (SELECT md5(string_agg(id || ':' || COALESCE(company_id::text,'') || ':' || attendance_status, ',' ORDER BY id)) FROM event_exhibitors) e,
    (SELECT md5(string_agg(id || ':' || booth_number || ':' || COALESCE(category,'') || ':' || COALESCE(company_id::text,''), ',' ORDER BY id)) FROM booth_map_booths) m,
    (SELECT md5(string_agg(id || ':' || kind || ':' || COALESCE(review_status,'') || ':' || COALESCE(exhibitor_id::text,''), ',' ORDER BY id)) FROM booth_intel) i,
    (SELECT count(*) FROM exhibitor_company_relations) r, (SELECT count(*) FROM contacts) ct`);
  return r;
}

if (db) {
  test.before(async () => {
    await db.initDb();
    const { rows: [ev] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [T('Show')]);
    eventId = ev.id;
    const company = async (n) => { const { rows: [c] } = await pool.query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [T(n)]); ids.companies.push(c.id); return c.id; };
    F.oldCo = await company('Kautex Textron');
    F.newCo = await company('Kautex Textron GmbH & Co. KG');
    const ex = async (n, booth, co) => {
      const { rows: [r] } = await pool.query(`INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name, company_id, attendance_status)
        VALUES ($1,$2,$3,$4,'listed') RETURNING id`, [eventId, T(n), T(n), co]);
      await pool.query('INSERT INTO exhibitor_booths (exhibitor_id, booth_number) VALUES ($1,$2)', [r.id, booth]);
      return r.id;
    };
    F.kautex = await ex('Kautex Textron GmbH & Co. KG', '2604', F.newCo);
    F.other = await ex('Unrelated Exhibitor', '1002', null);
    const { rows: [b] } = await pool.query(
      `INSERT INTO booth_map_booths (event_id, booth_number, source_company_name, category, company_id, match_method)
       VALUES ($1,'2604',$2,'customer',$3,'name_exact') RETURNING id`, [eventId, T('Kautex Textron'), F.oldCo]);
    ids.booths.push(b.id); F.mb = b.id;
    const { rows: [i] } = await pool.query(`INSERT INTO booth_intel (booth_id, kind, reason) VALUES ($1,'target_customer','t') RETURNING id`, [b.id]);
    ids.intel.push(i.id);
    const { rows: [run] } = await pool.query(
      `INSERT INTO exhibitor_import_runs (event_id, status, dry_run, finished_at) VALUES ($1,'success',FALSE,NOW() + interval '5 days') RETURNING id`, [eventId]);
    ids.runs.push(run.id);
  });
  test.after(async () => {
    try {
      // Test-database cleanup only. Production history is never deleted.
      await pool.query('DELETE FROM booth_map_identity_decisions WHERE event_id = $1', [eventId]);
      await pool.query('DELETE FROM booth_intel WHERE id = ANY($1::int[])', [ids.intel]);
      await pool.query('DELETE FROM booth_map_booths WHERE id = ANY($1::int[])', [ids.booths]);
      await pool.query('DELETE FROM event_exhibitors WHERE event_id = $1', [eventId]);
      await pool.query('DELETE FROM exhibitor_import_runs WHERE id = ANY($1::int[])', [ids.runs]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [ids.companies]);
      await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    } finally { await pool.end(); }
  });
}

const M = () => require('../boothMapModel');
const I = () => require('../boothMapIdentity');
const decide = (decision, reason, opts = { isAdmin: true, user: 'admin-a' }) =>
  I().recordDecision(pool, { map_booth_id: F.mb, exhibitor_id: F.kautex, decision, reason }, opts);
const rows = async () => (await pool.query(
  'SELECT id, decision, decided_by, revoked_at, revoked_by FROM booth_map_identity_decisions WHERE map_booth_id = $1 ORDER BY id', [F.mb])).rows;

dbTest('queue: the same-booth classified rename is queued and shown as pending, not classified', async () => {
  const m = await M().buildModel(pool);
  const item = m.identity_queue.find((q) => q.map_booth_id === F.mb);
  assert.ok(item, 'queued');
  assert.equal(item.exhibitor_id, F.kautex);
  assert.equal(item.evidence.same_booth, true);
  assert.equal(item.evidence.same_crm_record, false, 'separate CRM records are reported, not merged');
  assert.deepEqual(item.historical.kinds, ['target_customer']);
  assert.equal(item.decision, null);
  assert.ok((m.exhibitors[F.kautex].pending || []).length);
  assert.deepEqual(m.exhibitors[F.kautex].kinds, []);
  const q = await I().listQueue(pool, { isAdmin: true });
  assert.ok(q.items.some((x) => x.map_booth_id === F.mb));
});

dbTest('permissions and eligibility are enforced before anything is written', async () => {
  const before = await rows();
  for (const opts of [{ isAdmin: false, user: 'u' }, { user: 'u' }, { isAdmin: 'true', user: 'u' }]) {
    await assert.rejects(decide('deferred', '', opts), { status: 403 });
  }
  await assert.rejects(I().listQueue(pool, {}), { status: 403 });
  await assert.rejects(I().recordDecision(pool, { map_booth_id: F.mb, exhibitor_id: F.other, decision: 'confirmed', reason: 'nope' },
    { isAdmin: true, user: 'admin-a' }), { code: 'not_eligible' });
  await assert.rejects(decide('confirmed', ''), { code: 'reason_required' });
  assert.deepEqual(await rows(), before, 'nothing recorded');
});

dbTest('defer → confirm → reject: permanent history, display-only effect, nothing else written', async () => {
  const untouched = await everythingElse();

  await decide('deferred', 'check with sales');
  let m = await M().buildModel(pool);
  assert.ok((m.exhibitors[F.kautex].pending || []).length, 'deferred stays pending');
  const v1 = m.version;

  await decide('confirmed', 'Same booth, same company; GmbH is the legal name');
  m = await M().buildModel(pool);
  const e = m.exhibitors[F.kautex];
  assert.deepEqual(e.kinds, ['target_customer'], 'classification shown after explicit confirmation');
  assert.equal(e.category, 'customer');
  assert.equal(e.tier, 'admin_confirmed');
  assert.ok(!(e.pending || []).length);
  assert.notEqual(m.version, v1, 'the model version moves with the decision');
  assert.deepEqual(M().validate(m).failures, []);
  assert.equal(m.identity_queue.find((q) => q.map_booth_id === F.mb).applied, true);
  await assert.rejects(decide('confirmed', 'again'), { code: 'unchanged' });

  await decide('rejected', 'Different legal entity after review', { isAdmin: true, user: 'admin-b' });
  m = await M().buildModel(pool);
  assert.deepEqual(m.exhibitors[F.kautex].kinds, [], 'rejected: classification not shown');
  assert.ok(!(m.exhibitors[F.kautex].pending || []).length, 'rejected: not pending either');
  assert.equal(m.identity_queue.find((q) => q.map_booth_id === F.mb).decision.decision, 'rejected', 'still listed so it can be changed');

  const h = await rows();
  assert.deepEqual(h.map((r) => r.decision), ['deferred', 'confirmed', 'rejected'], 'every decision kept, in order');
  assert.deepEqual(h.map((r) => Boolean(r.revoked_at)), [true, true, false], 'exactly one live decision');
  assert.equal(h[1].revoked_by, 'admin-b', 'who superseded it is recorded');
  const q = await I().listQueue(pool, { isAdmin: true });
  assert.equal(q.items.find((x) => x.map_booth_id === F.mb).history.length, 3);
  assert.deepEqual(await everythingElse(), untouched, 'no company, exhibitor link, booth, classification, relation or contact changed');
});

// ── over HTTP: authentication and JSON-only writes ─────────────────────────
dbTest('HTTP: unauthenticated and non-JSON writes are refused; the admin can read the queue', async () => {
  const USER = 'reviewer', PASS = 'test-pass';
  const port = 40000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, NODE_ENV: 'test', PORT: String(port),
    DATABASE_URL: process.env.TEST_DATABASE_URL, APP_USERNAME: USER, APP_PASSWORD: PASS, ADMIN_USERS: USER,
    CLAUDE_API_KEY: '', OPENAI_API_KEY: '', APOLLO_API_KEY: '', BAILIAN_API_KEY: '', TAVILY_API_KEY: '', MYS_COOKIE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start:\n${log}`)), 30000);
    const on = (d) => { log += d; if (/running at/.test(log)) { clearTimeout(t); res(); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
  });
  try {
    const base = `http://127.0.0.1:${port}/api/booth-map/identity-review`;
    const auth = { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') };
    assert.equal((await fetch(base)).status, 401, 'no credentials');
    const ok = await fetch(base, { headers: auth });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).items.some((x) => x.map_booth_id === F.mb));
    const before = await rows();
    const form = await fetch(base, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `map_booth_id=${F.mb}&exhibitor_id=${F.kautex}&decision=confirmed&reason=forged` });
    assert.equal(form.status, 415, 'a form post (cross-site shape) is refused');
    const anon = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(anon.status, 401);
    assert.deepEqual(await rows(), before, 'refused requests wrote nothing');
    const modelPublic = await (await fetch(`http://127.0.0.1:${port}/api/booth-map/model?map_mode=live`, { headers: auth })).json();
    assert.equal(modelPublic.identity_queue, undefined, 'the map endpoint never carries the admin queue');
  } finally {
    await new Promise((res) => { child.on('exit', res); child.kill(); });
  }
});
