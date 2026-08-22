/* Booth map synchronization.
 *
 * The properties worth pinning are the ones that only fail quietly:
 *   · a rerun of an unedited source changes nothing (or the next sync's diff
 *     is meaningless and every booth looks touched);
 *   · a booth that vanishes upstream is retired, not deleted (it may already
 *     be quoted in a sent email);
 *   · a company match is never guessed (a wrong join attaches one company's
 *     research to another company's booth, and nothing downstream would show it);
 *   · a failure leaves nothing behind (a half-synchronized map presents itself
 *     as current).
 *
 * These run against a real Postgres — PGlite in-process, so there is no server
 * to start and no environment to configure — because every one of those
 * properties is about SQL semantics rather than JavaScript.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const boothImport = require('../boothImport');

const PGLITE = '/Users/meilinghe/Downloads/rich-habits/node_modules/@electric-sql/pglite/dist/index.js';

let PGlite = null;
try { ({ PGlite } = require(PGLITE)); } catch { /* reported below */ }

/** PGlite's query() is close enough to a `pg` client for this module. */
function asClient(db) {
  return { query: (text, params) => db.query(text, params || []) };
}

const SCHEMA = `
  create table events (id serial primary key, name text unique not null);
  create table companies (
    id serial primary key, name text not null, name_key text, booth text);
  create table booth_map_booths (
    id serial primary key,
    event_id integer not null references events(id),
    booth_number text not null,
    source_company_name text, source_company_name_zh text, name_key text,
    company_id integer references companies(id),
    match_method text, match_confidence text, match_note text,
    category text, status text, x integer, y integer, dims text,
    edition text, intro text, data jsonb, source_version text,
    first_imported_at timestamptz default now(),
    last_seen_at timestamptz default now(),
    retired_at timestamptz,
    unique (event_id, booth_number));
  create table booth_intel (
    id serial primary key,
    booth_id integer not null references booth_map_booths(id) on delete cascade,
    kind text not null, reason text, priority integer, priority_label text,
    background text, segments jsonb, projects jsonb, role text,
    score numeric(4,2), grade text, badge text,
    traffic_score numeric(4,2), anchor_score numeric(4,2),
    visibility_score numeric(4,2), skeqi_relevance numeric(4,2),
    analysis text, data jsonb, source_version text,
    last_seen_at timestamptz default now(), retired_at timestamptz,
    unique (booth_id, kind));
`;

async function freshDb() {
  const db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.exec(`insert into events (name) values ('${boothImport.EVENT_NAME}');`);
  return db;
}

/** A tiny source, so the assertions are about behaviour rather than volume. */
function fakeSource(booths, overlays = {}) {
  return {
    booths,
    overlays: { competitor_direct: [], competitor_indirect: [], ess_ev: [],
      target_customer: [], chinese_company: [], available_ranked: [], ...overlays },
    source_version: 'testver',
    warnings: [],
  };
}

const B = (n, nm, extra = {}) => ({ n, nm, c: 'other', status: 'Reserved', x: 1, y: 2, ...extra });

// ── parsing the real file ──────────────────────────────────────────────────

test('reads the real booth map without executing it', () => {
  const src = boothImport.readSource();
  assert.ok(src.booths.length > 1000, `expected >1000 booths, got ${src.booths.length}`);
  assert.match(src.source_version, /^[0-9a-f]{16}$/);
  // Every overlay the map defines is found; a silently-missing one is a warning.
  for (const o of boothImport.OVERLAYS) {
    assert.ok(Array.isArray(src.overlays[o.kind]), `${o.kind} missing`);
  }
  assert.deepEqual(src.warnings, [], 'no overlay should be missing from the real file');
});

test('the fingerprint tracks the data, not the whole file', () => {
  const a = boothImport.readSource().source_version;
  const b = boothImport.readSource().source_version;
  assert.equal(a, b, 'reading twice must produce the same version');
});

// ── matching ───────────────────────────────────────────────────────────────

test('matches an exact name', () => {
  const m = boothImport.buildMatcher([{ id: 7, name: 'Acme Corp', name_key: 'acme', booth: '100' }]);
  const r = m({ n: '999', nm: 'acme corp' });
  assert.equal(r.company_id, 7);
  assert.equal(r.match_method, 'name_exact');
  assert.equal(r.match_confidence, 'confident');
});

test('matches through the normalizer when spelling differs', () => {
  const m = boothImport.buildMatcher([
    { id: 3, name: 'EVE Energy Co., Ltd.', name_key: boothImport.normalizeNameKey('EVE Energy Co., Ltd.'), booth: null },
  ]);
  const r = m({ n: '1', nm: 'EVE Energy Co.,Ltd' });
  assert.equal(r.company_id, 3);
  assert.equal(r.match_method, 'name_key');
});

test('falls back to the booth number', () => {
  const m = boothImport.buildMatcher([{ id: 9, name: 'Totally Different', name_key: 'totally different', booth: '4405' }]);
  const r = m({ n: '4405', nm: 'Some Other Spelling' });
  assert.equal(r.company_id, 9);
  assert.equal(r.match_method, 'booth_number');
});

/* The load-bearing one. Two candidates must resolve to NO match: picking
   either would attach one company's history to another company's booth, and
   nothing downstream would ever reveal it. */
test('refuses to guess when two companies match', () => {
  const m = boothImport.buildMatcher([
    { id: 1, name: 'Acme', name_key: 'acme', booth: null },
    { id: 2, name: 'Acme', name_key: 'acme', booth: null },
  ]);
  const r = m({ n: '1', nm: 'Acme' });
  assert.equal(r.company_id, null, 'must not pick one of two candidates');
  assert.equal(r.match_confidence, 'ambiguous');
  assert.match(r.match_note, /1,2/, 'the candidates must be recorded for a human');
});

test('an unknown company is unmatched, not forced', () => {
  const m = boothImport.buildMatcher([{ id: 1, name: 'Acme', name_key: 'acme', booth: '1' }]);
  const r = m({ n: '9999', nm: 'Nobody We Know' });
  assert.equal(r.company_id, null);
  assert.equal(r.match_confidence, 'unmatched');
});

// ── change detection ───────────────────────────────────────────────────────

test('unchanged input is reported as unchanged', () => {
  const m = boothImport.buildMatcher([]);
  const row = boothImport.boothRow(B('100', 'Acme'), m, 'v1');
  assert.equal(boothImport.differs(row, row), false);
});

test('a changed field is detected, a new source version alone is not', () => {
  const m = boothImport.buildMatcher([]);
  const a = boothImport.boothRow(B('100', 'Acme'), m, 'v1');
  const sameDataNewVersion = boothImport.boothRow(B('100', 'Acme'), m, 'v2');
  assert.equal(boothImport.differs(a, sameDataNewVersion), false,
    'a version bump with identical data must not mark every row updated');

  const moved = boothImport.boothRow(B('100', 'Acme', { x: 999 }), m, 'v1');
  assert.equal(boothImport.differs(a, moved), true);
});

test('unmodelled source fields are preserved in data', () => {
  const m = boothImport.buildMatcher([]);
  const row = boothImport.boothRow(B('100', 'Acme', { somethingNew: 'keep me' }), m, 'v1');
  assert.deepEqual(row.data, { somethingNew: 'keep me' });
});

// ── synchronization, against a real database ───────────────────────────────

const dbTest = PGlite ? test : test.skip;

dbTest('first run creates, second run is a no-op', async () => {
  const db = await freshDb();
  const c = asClient(db);
  await db.exec("insert into companies (name, name_key) values ('Acme', 'acme');");
  const eventId = await boothImport.resolveEvent(c);
  const src = fakeSource([B('100', 'Acme'), B('101', 'Beta')]);

  const p1 = await boothImport.plan(c, src, eventId);
  assert.equal(p1.created.length, 2);
  assert.equal(p1.unchanged.length, 0);
  await boothImport.apply(c, p1, eventId, src);

  const p2 = await boothImport.plan(c, src, eventId);
  assert.equal(p2.created.length, 0, 'a rerun must create nothing');
  assert.equal(p2.updated.length, 0, 'a rerun must update nothing');
  assert.equal(p2.unchanged.length, 2);
  assert.equal(p2.retired.length, 0);
});

dbTest('a booth that disappears upstream is retired, never deleted', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await boothImport.resolveEvent(c);

  const before = fakeSource([B('100', 'Acme'), B('101', 'Beta')]);
  await boothImport.apply(c, await boothImport.plan(c, before, eventId), eventId, before);

  const after = fakeSource([B('100', 'Acme')]);
  const p = await boothImport.plan(c, after, eventId);
  assert.equal(p.retired.length, 1);
  await boothImport.apply(c, p, eventId, after);

  const { rows } = await db.query('select booth_number, retired_at from booth_map_booths order by booth_number');
  assert.equal(rows.length, 2, 'the row must still exist');
  assert.equal(rows[0].retired_at, null);
  assert.ok(rows[1].retired_at, 'the vanished booth must be marked retired');
});

dbTest('a booth that comes back is un-retired', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await boothImport.resolveEvent(c);

  const two = fakeSource([B('100', 'Acme'), B('101', 'Beta')]);
  await boothImport.apply(c, await boothImport.plan(c, two, eventId), eventId, two);
  const one = fakeSource([B('100', 'Acme')]);
  await boothImport.apply(c, await boothImport.plan(c, one, eventId), eventId, one);
  await boothImport.apply(c, await boothImport.plan(c, two, eventId), eventId, two);

  const { rows } = await db.query("select retired_at from booth_map_booths where booth_number='101'");
  assert.equal(rows[0].retired_at, null, 'returning upstream must clear the retirement');
});

dbTest('an unmatched booth is stored with its source spelling and no company', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await boothImport.resolveEvent(c);
  const src = fakeSource([B('100', 'Company We Do Not Have')]);
  await boothImport.apply(c, await boothImport.plan(c, src, eventId), eventId, src);

  const { rows } = await db.query('select * from booth_map_booths');
  assert.equal(rows[0].company_id, null);
  assert.equal(rows[0].match_confidence, 'unmatched');
  assert.equal(rows[0].source_company_name, 'Company We Do Not Have',
    'the source spelling is the whole point of an unmatched row');
});

dbTest('overlays are attached, and a booth can carry more than one', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await boothImport.resolveEvent(c);
  const src = fakeSource([B('4405', 'EVE')], {
    target_customer: [{ booth: '4405', priority: 1, background: 'existing customer' }],
    ess_ev: [{ booth: '4405', reason: 'storage line' }],
  });
  const p = await boothImport.plan(c, src, eventId);
  assert.equal(p.intel.length, 2);
  await boothImport.apply(c, p, eventId, src);

  const { rows } = await db.query('select kind from booth_intel order by kind');
  assert.deepEqual(rows.map((r) => r.kind), ['ess_ev', 'target_customer']);
});

dbTest('an overlay pointing at a missing booth warns rather than vanishing', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await boothImport.resolveEvent(c);
  const src = fakeSource([B('100', 'Acme')], { ess_ev: [{ booth: '9999', reason: 'orphan' }] });
  const p = await boothImport.plan(c, src, eventId);
  assert.equal(p.intel.length, 0);
  assert.ok(p.warnings.some((w) => w.type === 'overlay_orphan' && w.booth === '9999'));
});

/* The transaction is the caller's, which is what makes this testable: a
   failure mid-apply must leave nothing behind. */
dbTest('a failure part-way through leaves the database untouched', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await boothImport.resolveEvent(c);

  const src = fakeSource([B('100', 'Acme'), B('101', 'Beta'), B('102', 'Gamma')]);
  await db.exec('begin');
  try {
    // Fails on the third booth: 'x' is an integer column.
    const p = await boothImport.plan(c, src, eventId);
    p.created[2].x = 'not-an-integer';
    await boothImport.apply(c, p, eventId, src);
    await db.exec('commit');
    assert.fail('the bad row should have thrown');
  } catch {
    await db.exec('rollback');
  }

  const { rows } = await db.query('select count(*)::int n from booth_map_booths');
  assert.equal(rows[0].n, 0, 'a rolled-back import must leave no partial data');
});

dbTest('editions of the show coexist rather than overwrite', async () => {
  const db = await freshDb();
  const c = asClient(db);
  await db.exec("insert into events (name) values ('The Battery Show North America 2027');");
  const e2026 = await boothImport.resolveEvent(c);
  const e2027 = await boothImport.resolveEvent(c, 'The Battery Show North America 2027');

  const src = fakeSource([B('100', 'Acme')]);
  await boothImport.apply(c, await boothImport.plan(c, src, e2026), e2026, src);
  await boothImport.apply(c, await boothImport.plan(c, src, e2027), e2027, src);

  const { rows } = await db.query('select event_id from booth_map_booths order by event_id');
  assert.equal(rows.length, 2, 'the same booth number in two editions must be two rows');
});

dbTest('an import scoped to a missing event refuses rather than inventing one', async () => {
  const db = await freshDb();
  const c = asClient(db);
  await assert.rejects(
    () => boothImport.resolveEvent(c, 'A Show That Does Not Exist'),
    /event not found/);
});

if (!PGlite) {
  test('database tests were skipped — PGlite not resolvable', () => {
    assert.fail(`PGlite not found at ${PGLITE}; the synchronization tests did not run`);
  });
}

/* Free floor space arrives in the same array as exhibitors, named with the
   literal placeholder "Available". Counting those as unmatched companies put
   165 non-entries in a list whose whole purpose is that a human reads it. */
test('empty floor space is not an unmatched company', () => {
  assert.equal(boothImport.isCompanyBooth({ nm: 'Available', c: 'available' }), false);
  assert.equal(boothImport.isCompanyBooth({ nm: 'available', c: 'other' }), false);
  assert.equal(boothImport.isCompanyBooth({ nm: '', c: 'other' }), false);
  assert.equal(boothImport.isCompanyBooth({ nm: 'Acme Corp', c: 'other' }), true);

  const m = boothImport.buildMatcher([]);
  const free = boothImport.boothRow({ n: '1', nm: 'Available', c: 'available' }, m, 'v1');
  assert.equal(free.match_confidence, 'not_a_company');
  const real = boothImport.boothRow({ n: '2', nm: 'Acme Corp', c: 'other' }, m, 'v1');
  assert.equal(real.match_confidence, 'unmatched');
});

dbTest('the two are counted separately', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await boothImport.resolveEvent(c);
  const src = fakeSource([
    { n: '1', nm: 'Available', c: 'available' },
    { n: '2', nm: 'Available', c: 'available' },
    { n: '3', nm: 'Nobody We Know', c: 'other' },
  ]);
  const p = await boothImport.plan(c, src, eventId);
  assert.equal(p.stats.freeSpace, 2);
  assert.equal(p.stats.unmatched, 1, 'only the real company counts as unmatched');
});
