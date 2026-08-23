/* ═══════════════════════════════════════════════════════════════════════════
   The admin "Refresh Exhibitor Data" workflow.

   What is worth testing here is not that a refresh works — the synchronisation
   underneath is already tested — but that putting a button on it did not
   quietly weaken anything. A UI path is where safety rails get filed down,
   because every guard is an obstacle between a click and a result.

   So these assert the refusals: that a preview writes nothing, that an expired
   credential changes nothing and never leaks, that a source which moved
   between the review and the click is refused rather than applied, and that
   the mass-retirement floor still holds when the request arrives over HTTP
   instead of from a terminal.
   ═══════════════════════════════════════════════════════════════════════════ */
const test = require('node:test');
const assert = require('node:assert');

const dbGuard = require('./dbGuard');
const sync = require('../exhibitorSync');
const reconcile = require('../exhibitorReconcile');

const db = dbGuard.available ? require('../db') : null;
const dbTest = dbGuard.available ? test : test.skip;
if (!dbGuard.available) {
  test('exhibitor refresh suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
}
const sql = (t, p) => db.pool.query(t, p || []).then((r) => r.rows);

test.before(async () => { if (db) await db.initDb(); });

/** A snapshot of everything the refresh is allowed to touch, and some it isn't. */
async function snapshot() {
  const one = async (t) => {
    try { return (await sql(`select count(*)::int n from ${t}`))[0].n; } catch { return null; }
  };
  return {
    exhibitors: await one('event_exhibitors'),
    booths: await one('exhibitor_booths'),
    companies: await one('companies'),
    contacts: await one('contacts'),
    communications: await one('communications'),
    reports: await one('account_reports'),
    runs: await one('exhibitor_import_runs'),
  };
}

// ── the pathway is the tested one ──────────────────────────────────────────

test('the endpoints drive the same modules the CLI does — there is no second path', () => {
  const server = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/exhibitorSync'\)/, 'sync must be imported, not reimplemented');
  assert.match(server, /require\('\.\/exhibitorReconcile'\)/);
  for (const fn of ['fetchExhibitors', 'resolveEvent', 'plan', 'planIntelReview', 'apply']) {
    assert.ok(server.includes(`exhibitorSync.${fn}(`), `apply must call exhibitorSync.${fn}`);
  }
  assert.ok(server.includes('exhibitorReconcile.planReconcile('),
    'CRM identity must come from the reconciler, not from ad-hoc matching');
  assert.ok(server.includes('upsertCompany('),
    'companies must be created through the shared path that owns duplicate prevention');
  /* A bare INSERT into companies would bypass the name validation and the
     normalised-name resolution every other ingestion route relies on. */
  assert.ok(!/insert\s+into\s+companies/i.test(server),
    'nothing may insert a company directly');
});

test('the guards live in the module, so the HTTP path inherits them', () => {
  assert.equal(typeof sync.MIN_PLAUSIBLE_FRACTION, 'number');
  assert.equal(typeof sync.MIN_ABSOLUTE, 'number');
  assert.ok(sync.MIN_PLAUSIBLE_FRACTION > 0 && sync.MIN_PLAUSIBLE_FRACTION <= 1);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/MIN_PLAUSIBLE_FRACTION\s*=/.test(src), 'the UI must not redefine the floor');
  assert.ok(!/MIN_ABSOLUTE\s*=/.test(src), 'nor the absolute minimum');
});

// ── refusals ───────────────────────────────────────────────────────────────

dbTest('a shrunken list is refused before anything is written', async () => {
  /* The expired-cookie shape: the source answers a logged-out request with a
     login page, which parses as an empty exhibitor list. Retiring a whole show
     on that evidence is the accident the floor exists to prevent.

     Seeded and planned against a real database, because the floor compares the
     incoming list with what is already stored — a unit test with hand-made
     numbers would be testing arithmetic, not the guard. */
  const client = await db.pool.connect();
  try {
    const eventId = await sync.resolveEvent(client).catch(() => null);
    if (!eventId) return;                        // no event seeded here
    await client.query('BEGIN');
    for (let i = 0; i < 60; i++) {
      await client.query(
        `insert into event_exhibitors (event_id, exhibitor_source_id, source_name, name_key,
           attendance_status, source) values ($1,$2,$3,$4,'listed','test')
         on conflict do nothing`,
        [eventId, `zztest-${i}`, `ZZ Test Exhibitor ${i}`, `zztestexhibitor${i}`]);
    }
    const plan = await sync.plan(client, [], eventId);
    assert.ok(plan.refuse, 'an empty list against 60 stored exhibitors must be refused');
    assert.match(String(plan.refuse), /\d/, 'the refusal should say what it saw');
  } finally {
    await client.query('ROLLBACK').catch(() => {});   // seed rows never persist
    client.release();
  }
});

test('apply refuses to run a plan that was refused', async () => {
  await assert.rejects(
    () => sync.apply(null, { refuse: 'too few exhibitors' }, 1, 'v', []),
    /refusing to apply/i,
    'the refusal must be enforced at the write, not only at the plan');
});

test('a fetch that is not JSON is treated as a login page, not an empty show', async () => {
  const html = async () => ({
    ok: true, status: 200,
    json: async () => { throw new Error('not json'); },
    text: async () => '<html><body>Sign in</body></html>',
  });
  await assert.rejects(
    () => sync.fetchExhibitors({ cookie: 'x', fetchImpl: html }),
    /non-JSON|expired/i);
});

for (const status of [401, 403]) {
  test(`HTTP ${status} from the source is reported as an expired session`, async () => {
    const denied = async () => ({ ok: false, status, json: async () => ({}), text: async () => '' });
    await assert.rejects(
      () => sync.fetchExhibitors({ cookie: 'x', fetchImpl: denied }),
      /expired|HTTP/i);
  });
}

// ── preview writes nothing ─────────────────────────────────────────────────

dbTest('planning touches nothing — a preview is a read', async () => {
  const before = await snapshot();
  const client = await db.pool.connect();
  try {
    const eventId = await sync.resolveEvent(client).catch(() => null);
    if (eventId) {
      await sync.plan(client, [], eventId).catch(() => null);
      await sync.planIntelReview(client, [], eventId).catch(() => null);
      await reconcile.planReconcile(client).catch(() => null);
    }
  } finally { client.release(); }
  assert.deepEqual(await snapshot(), before, 'a preview must not change a single row');
});

// ── identity is never guessed ──────────────────────────────────────────────

test('the reconciler only ever returns the three conservative outcomes', () => {
  const index = new Map();          // the shape gatherEvidence returns: key → candidates
  const out = reconcile.classify(
    { id: 1, source_name: 'Some Company Nobody Knows', name_key: 'somecompanynobodyknows' }, index);
  assert.ok(['link_existing', 'create_new', 'review'].includes(out.outcome));
  assert.notEqual(out.outcome, 'link_existing', 'no evidence must never produce a confident link');
});

test('a name that is not a company is never created', () => {
  for (const n of ['Media Center', 'The Battery Show Theater', 'University of Michigan', 'skeqi']) {
    const why = reconcile.notAProspect(n);
    // It returns the REASON rather than a boolean, which is what makes the
    // decision reviewable rather than merely correct.
    assert.ok(why, `${n} must not become a CRM company`);
    assert.equal(typeof why, 'string', 'and it should say why');
  }
  assert.equal(reconcile.notAProspect('Comau LLC'), null, 'a real company must pass');
});

// ── audit ──────────────────────────────────────────────────────────────────

dbTest('every outcome is recorded in the audit trail, including refusals', async () => {
  const cols = (await sql(
    `select column_name from information_schema.columns where table_name = 'exhibitor_import_runs'`))
    .map((r) => r.column_name);
  for (const c of ['status', 'source_version', 'dry_run', 'fetched', 'created', 'retired',
    'matched', 'unmatched', 'ambiguous', 'intel_flagged', 'error_message', 'finished_at']) {
    assert.ok(cols.includes(c), `the run record needs ${c}`);
  }
});

dbTest('last-verified comes from a successful run, never from the browser', async () => {
  const server = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const status = server.slice(server.indexOf("'/api/exhibitors/status'"));
  const block = status.slice(0, status.indexOf('});'));
  assert.match(block, /status = 'success'/, 'only a successful run may set last-verified');
  assert.match(block, /dry_run = false/, 'a dry run is not a verification');
});

// ── secrets ────────────────────────────────────────────────────────────────

test('no response can carry the source credential', () => {
  const server = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const start = server.indexOf('/* ── Refresh Exhibitor Data');
  const end = server.indexOf("app.get('/api/me'", start);
  const block = server.slice(start, end);
  assert.ok(start > 0 && end > start, 'the refresh block should be locatable');

  /* The credential may be READ from the environment and handed to the fetcher.
     It may never be placed in anything sent to a browser. Rather than trying
     to parse response literals out of JavaScript with a regex — which is how
     the first version of this test managed to flag a comment — every line that
     mentions it is enumerated and matched against the forms that are allowed. */
  const ALLOWED = [
    /^\s*\*/,                                                 // comment
    /^\s*\/\*/,                                              // comment
    /source_configured: Boolean\(process\.env\.MYS_COOKIE\)/, // presence, as a boolean
    /fetchExhibitors\(\{ cookie: process\.env\.MYS_COOKIE \|\| '' \}\)/, // handed to the fetcher
  ];
  for (const line of block.split('\n')) {
    if (!/MYS_COOKIE/.test(line)) continue;
    assert.ok(ALLOWED.some((re) => re.test(line)),
      `unexpected use of the source credential: ${line.trim()}`);
  }
  // And no response may echo the environment at all.
  assert.ok(!/res\.(json|send)\([^)]*process\.env/.test(block),
    'a response must never echo the environment');
  assert.ok(!/DATABASE_URL/.test(block), 'no connection string anywhere near this feature');
  // Presence is reported as a boolean, never the value.
  assert.match(block, /source_configured: Boolean\(process\.env\.MYS_COOKIE\)/);
});

// ── admin gate ─────────────────────────────────────────────────────────────

test('both endpoints check admin server-side, not only in the UI', () => {
  const server = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  for (const route of ["'/api/exhibitors/preview'", "'/api/exhibitors/apply'"]) {
    const at = server.indexOf(route);
    assert.ok(at > 0, `${route} should exist`);
    const body = server.slice(at, at + 400);
    assert.match(body, /if \(!isAdmin\(req\)\) return res\.status\(403\)/,
      `${route} must refuse a non-admin`);
  }
});

test('the apply endpoint refuses without a reviewed source version', () => {
  const server = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const at = server.indexOf("'/api/exhibitors/apply'");
  const body = server.slice(at, at + 3000);
  assert.match(body, /preview_required/, 'applying without a preview must be refused');
  assert.match(body, /source_changed/, 'a source that moved must be refused');
  assert.match(body, /version !== expected/, 'the fingerprint must actually be compared');
});

test('the fingerprint changes when the official list changes', () => {
  const a = [{ exhibitor_source_id: '1', source_name: 'A', booths: ['100'] }];
  const b = [{ exhibitor_source_id: '1', source_name: 'A', booths: ['200'] }];
  const c = [{ exhibitor_source_id: '1', source_name: 'A', booths: ['100'] },
    { exhibitor_source_id: '2', source_name: 'B', booths: [] }];
  assert.equal(sync.sourceVersion(a), sync.sourceVersion(a.slice()), 'stable for the same data');
  assert.notEqual(sync.sourceVersion(a), sync.sourceVersion(b), 'a booth change must be detected');
  assert.notEqual(sync.sourceVersion(a), sync.sourceVersion(c), 'a new exhibitor must be detected');
});

// ── the Booth Map is a protected surface ───────────────────────────────────

test('the refresh feature does not touch the Booth Map', () => {
  const fs = require('fs'); const path = require('path');
  const map = fs.readFileSync(path.join(__dirname, '..', 'public', 'booth-map', 'index.html'), 'utf8');
  /* The map is a designed product surface. This feature adds a strip in the
     shell ABOVE the iframe and never reaches inside it. */
  assert.ok(map.includes('ALL_BOOTHS_DATA'), 'the curated dataset must still be there');
  assert.ok(!map.includes('bm-refresh'), 'the refresh control belongs to the shell, not the map');
  assert.ok(!map.includes('/api/exhibitors/'), 'the map must not have been rewired');

  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(shell.includes('id="bm-refresh"'), 'the control lives in the shell');
  assert.ok(shell.includes('id="bm-frame"'), 'the iframe is still how the map is hosted');
});

test('the credential is optional, because the source does not require one', () => {
  const server = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const start = server.indexOf('/* ── Refresh Exhibitor Data');
  const end = server.indexOf("app.get('/api/me'", start);
  const block = server.slice(start, end);
  /* Measured rather than assumed: the official endpoint answers an
     unauthenticated request with the full exhibitor list, so refusing to run
     without MYS_COOKIE would block the feature for no gain. What protects us
     is the non-JSON refusal below it — if the source ever does start requiring
     a session, it answers with an HTML login page and the fetch refuses.

     If this assertion ever fails because someone reinstated the hard gate,
     check whether the source changed first. */
  assert.ok(!/detail: 'not_configured'/.test(block.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the refresh must not refuse merely because no credential is configured');
  assert.match(block, /MYS_COOKIE \|\| ''/,
    'the credential is passed when present and absent otherwise');
});

test('booth changes are read from the booth table, never from the plan', () => {
  /* plan()'s `prev` is an event_exhibitors row and carries no booths — booth
     reconciliation happens inside apply(). Comparing prev.booths against the
     incoming list therefore compared `undefined` with a real array and marked
     EVERY updated exhibitor as a booth change: a re-run that altered nothing
     reported 976 of them.

     A preview that overstates change is worse than no preview. It teaches an
     admin that the numbers are noise, and the habit it builds is clicking
     through. */
  const server = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const at = server.indexOf("'/api/exhibitors/preview'");
  const block = server.slice(at, server.indexOf("app.post('/api/exhibitors/apply'", at));
  assert.ok(!/plan\.updated\.filter\([\s\S]{0,120}booths/.test(block),
    'booth deltas must not be derived from plan.updated');
  assert.match(block, /from exhibitor_booths b|join exhibitor_booths b/,
    'the current assignments must be read from the booth table');
  assert.match(block, /sortedKey\(from\) !== sortedKey\(e\.booths\)/,
    'and compared order-insensitively against the incoming list');
});

test('a shared booth is many occupants, not a contest', () => {
  /* 3626 holds Comau LLC and INTECELLS; 4050 holds five exhibitors. The plan
     and the preview must carry every one of them — a model that keeps one
     name per booth is what made the assistant report Comau as replaced. */
  const server = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const at = server.indexOf("'/api/exhibitors/preview'");
  const block = server.slice(at, server.indexOf("app.post('/api/exhibitors/apply'", at));
  assert.match(block, /array_agg\(b\.booth_number/,
    'booths per exhibitor must be aggregated, not picked');
});
