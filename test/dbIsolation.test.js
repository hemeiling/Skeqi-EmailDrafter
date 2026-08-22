/* ═══════════════════════════════════════════════════════════════════════════
   `npm test` must not be able to write to production.

   This is a regression test for something that actually happened: the suite
   ran against the DATABASE_URL in .env, one of its files calls initDb(), and
   so running the tests created three tables in the production database. The
   suites had said "runs against the real DATABASE_URL" at the top for as long
   as they had existed, which is the tell — it was written down, and written
   down is not the same as safe.

   The assertions below are deliberately about the mechanism rather than the
   outcome, because the outcome is unobservable until it is too late. Nothing
   here connects to any database.
   ═══════════════════════════════════════════════════════════════════════════ */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dbGuard = require('./dbGuard');

/** Runs a snippet in a fresh node process with a controlled environment. */
function inChild(env, code) {
  try {
    const out = execFileSync(process.execPath, ['-e', code], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const FAKE_PROD = 'postgresql://u:p@ep-fake-prod-xyz.us-east-1.aws.neon.tech/neondb?sslmode=require';
const FAKE_TEST = 'postgresql://u:p@127.0.0.1:5999/skq_test';

// ── the invariant, in this very process ────────────────────────────────────

test('after requiring the guard, DATABASE_URL is never production', () => {
  assert.equal(dbGuard.pointsAtProduction(), false,
    'the test process must not be holding the production connection string');
});

test('the guard never falls back to DATABASE_URL', () => {
  if (dbGuard.available) {
    assert.equal(process.env.DATABASE_URL, dbGuard.TEST_URL,
      'when a test database is configured, that is what tests must use');
  } else {
    assert.equal(process.env.DATABASE_URL, '',
      'with no test database the URL must be emptied — deleting it lets dotenv put it back');
  }
});

// ── identity comparison, which is what "same database" rests on ────────────

test('the pooled and direct endpoints of one database are the same database', () => {
  assert.equal(dbGuard.sameDatabase(
    'postgresql://u:p@ep-a-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require',
    'postgresql://u:p@ep-a-pooler.c-9.us-east-1.aws.neon.tech/neondb',
  ), true, 'a query string must not disguise the same database');

  assert.equal(dbGuard.sameDatabase(FAKE_PROD, FAKE_TEST), false);
  assert.equal(dbGuard.sameDatabase('', FAKE_PROD), false, 'an empty URL matches nothing');
  assert.equal(dbGuard.sameDatabase('not a url', FAKE_PROD), false);
});

test('different databases on the same host are not the same database', () => {
  assert.equal(dbGuard.sameDatabase(
    'postgresql://u:p@host.neon.tech/neondb',
    'postgresql://u:p@host.neon.tech/scratch',
  ), false);
});

// ── the backstop in db.js, exercised in real child processes ───────────────

test('db.js refuses to load in a test process pointed at production', () => {
  const r = inChild(
    { NODE_ENV: 'test', DATABASE_URL: FAKE_PROD, TEST_DATABASE_URL: '' },
    "require('./db.js'); console.log('LOADED');",
  );
  assert.equal(r.ok, false, 'requiring db.js should have thrown');
  assert.match(r.out, /Refusing to connect/);
  assert.doesNotMatch(r.out, /LOADED/);
});

test('db.js refuses when the test URL names a different database than the one set', () => {
  const r = inChild(
    { NODE_ENV: 'test', DATABASE_URL: FAKE_PROD, TEST_DATABASE_URL: FAKE_TEST },
    "require('./db.js'); console.log('LOADED');",
  );
  assert.equal(r.ok, false,
    'DATABASE_URL still pointing at production must throw even when a test URL exists');
  assert.match(r.out, /Refusing to connect/);
});

test('db.js loads happily when pointed at the test database', () => {
  const r = inChild(
    { NODE_ENV: 'test', DATABASE_URL: FAKE_TEST, TEST_DATABASE_URL: FAKE_TEST },
    "require('./db.js'); console.log('LOADED');",
  );
  assert.equal(r.ok, true, r.out);
  assert.match(r.out, /LOADED/);
});

/* The guard is scoped to NODE_ENV=test so it cannot affect the deployed app.
   That scoping is load-bearing and therefore tested: a backstop that also
   fired in production would be worse than none. */
test('production and development are completely unaffected', () => {
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: '' }]) {
    const r = inChild(
      { ...env, DATABASE_URL: FAKE_PROD, TEST_DATABASE_URL: '' },
      "require('./db.js'); console.log('LOADED');",
    );
    assert.equal(r.ok, true, `NODE_ENV=${env.NODE_ENV || 'unset'} must load normally: ${r.out}`);
    assert.match(r.out, /LOADED/);
  }
});

// ── the guard itself, as a module ──────────────────────────────────────────

test('the guard throws outright if the two URLs are the same database', () => {
  const r = inChild(
    { NODE_ENV: 'test', DATABASE_URL: FAKE_PROD, TEST_DATABASE_URL: FAKE_PROD },
    "require('./test/dbGuard.js'); console.log('LOADED');",
  );
  assert.equal(r.ok, false, 'pointing the test URL at production must be fatal, not a skip');
  assert.match(r.out, /same database/i);
});

test('the guard removes the production URL when no test database is set', () => {
  const r = inChild(
    { NODE_ENV: 'test', DATABASE_URL: FAKE_PROD, TEST_DATABASE_URL: '' },
    "require('./test/dbGuard.js'); console.log('URL=' + (process.env.DATABASE_URL || 'GONE'));",
  );
  assert.equal(r.ok, true, r.out);
  assert.match(r.out, /URL=GONE/);
});

test('the guard redirects to the test database when one is set', () => {
  const r = inChild(
    { NODE_ENV: 'test', DATABASE_URL: FAKE_PROD, TEST_DATABASE_URL: FAKE_TEST },
    "const g = require('./test/dbGuard.js'); console.log('AVAILABLE=' + g.available + ' URL=' + process.env.DATABASE_URL);",
  );
  assert.equal(r.ok, true, r.out);
  assert.match(r.out, /AVAILABLE=true/);
  assert.match(r.out, /skq_test/);
  assert.doesNotMatch(r.out, /ep-fake-prod/, 'the production URL must not survive');
});

// ── every DB-backed suite is actually wired to the guard ───────────────────

/* The mechanism only holds if the suites use it, and a new suite added next
   month is exactly the case that will forget. This reads the files rather than
   trusting that they were updated. */
test('every suite that can reach ../db loads the guard first', () => {
  const fs = require('fs');

  /* Transitively, not just literally. chatTools requires db, so a suite that
     requires chatTools reaches production without ever naming db.js — which is
     exactly how the assistant's own tests first tripped the backstop. Checking
     only for `require('../db')` would have called that suite clean. */
  const reaches = new Map();
  const resolveLocal = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const p = path.resolve(path.dirname(from), spec);
    for (const candidate of [p, `${p}.js`, path.join(p, 'index.js')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const touchesDb = (file, seen = new Set()) => {
    if (reaches.has(file)) return reaches.get(file);
    if (seen.has(file)) return false;
    seen.add(file);
    if (path.basename(file) === 'db.js') return true;
    let src = '';
    try { src = fs.readFileSync(file, 'utf8'); } catch { return false; }
    let hit = false;
    for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      const target = resolveLocal(file, m[1]);
      if (target && path.basename(target) !== 'dbGuard.js' && touchesDb(target, seen)) { hit = true; break; }
    }
    reaches.set(file, hit);
    return hit;
  };

  const offenders = [];
  for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.test.js'))) {
    const full = path.join(__dirname, f);
    const src = fs.readFileSync(full, 'utf8');
    if (!touchesDb(full)) continue;
    const guardAt = src.indexOf("require('./dbGuard')");
    // The guard must load before the first local require that leads to db.js.
    const firstDbReq = [...src.matchAll(/require\(['"](\.\.[^'"]+)['"]\)/g)]
      .map((m) => ({ at: m.index, target: resolveLocal(full, m[1]) }))
      .find((r) => r.target && touchesDb(r.target));
    if (guardAt === -1 || (firstDbReq && guardAt > firstDbReq.at)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `these suites can reach the database without the guard loading first: ${offenders.join(', ')}`);
});

test('npm test sets NODE_ENV=test, which is what arms the backstop', () => {
  const pkg = require('../package.json');
  assert.match(pkg.scripts.test, /NODE_ENV=test/,
    'without NODE_ENV=test the db.js backstop never fires');
});


/* The subtle one. `delete process.env.DATABASE_URL` looks equivalent to
   emptying it and is not: dotenv skips keys already present, and a deleted key
   is absent, so the production URL came back the moment any module called
   dotenv.config() — which config.js does on load. */
test('dotenv cannot resurrect the production URL after the guard has run', () => {
  const r = inChild(
    { NODE_ENV: 'test', DATABASE_URL: FAKE_PROD, TEST_DATABASE_URL: '' },
    "require('./test/dbGuard.js');"
    + "require('dotenv').config({ quiet: true });"
    + "console.log('URL=' + (process.env.DATABASE_URL || 'EMPTY'));",
  );
  assert.equal(r.ok, true, r.out);
  assert.match(r.out, /URL=EMPTY/, 'dotenv put the production URL back');
});

test('a suite can require the app modules without a test database', () => {
  const r = inChild(
    { NODE_ENV: 'test', DATABASE_URL: FAKE_PROD, TEST_DATABASE_URL: '' },
    "require('./test/dbGuard.js'); require('./chat.js'); console.log('LOADED');",
  );
  assert.equal(r.ok, true, r.out);
  assert.match(r.out, /LOADED/);
});
