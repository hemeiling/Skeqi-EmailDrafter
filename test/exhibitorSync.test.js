/* ═══════════════════════════════════════════════════════════════════════════
   Exhibitor attendance sync.

   The properties here are the ones whose failure is silent and expensive:

     · an expired session must never read as "everyone withdrew". The source
       returns an HTML login page under HTTP 200, so a naive parse yields zero
       exhibitors and a naive sync retires the entire show.
     · a classification must never follow a booth number. Somebody judged Comau
       a competitor; nobody judged booth 3626. Reassigning the label to whoever
       takes that booth silently libels an unrelated company.
     · attendance must never be inferred from a booth. That inference is what
       told a salesperson CATL was not attending when the truth was that we had
       no booth number for them.
   ═══════════════════════════════════════════════════════════════════════════ */
const test = require('node:test');
const assert = require('node:assert');

const dbGuard = require('./dbGuard');
const sync = require('../exhibitorSync');

const PGLITE = '/Users/meilinghe/Downloads/rich-habits/node_modules/@electric-sql/pglite/dist/index.js';
let PGlite = null;
try { ({ PGlite } = require(PGLITE)); } catch { /* db tests skip below */ }

const asClient = (db) => ({ query: (t, p) => db.query(t, p || []) });

const SCHEMA = `
  create table events (id serial primary key, name text unique not null);
  create table companies (id serial primary key, name text not null, name_key text, booth text);
  create table event_exhibitors (
    id serial primary key, event_id integer not null references events(id),
    exhibitor_source_id text not null, source_name text not null, name_key text,
    company_id integer references companies(id),
    match_method text, match_confidence text, match_note text,
    attendance_status text not null default 'listed', hall text,
    source text not null default 'mapyourshow', source_version text,
    first_seen_at timestamptz default now(), last_verified_at timestamptz default now(),
    retired_at timestamptz, unique (event_id, exhibitor_source_id));
  create table exhibitor_booths (
    id serial primary key,
    exhibitor_id integer not null references event_exhibitors(id) on delete cascade,
    booth_number text not null, hall text, source_version text,
    first_seen_at timestamptz default now(), last_verified_at timestamptz default now(),
    retired_at timestamptz, unique (exhibitor_id, booth_number));
  create table booth_map_booths (
    id serial primary key, event_id integer not null references events(id),
    booth_number text not null, source_company_name text, retired_at timestamptz,
    exhibitor_id integer references event_exhibitors(id),
    occupant_status text default 'unverified', occupant_checked_at timestamptz,
    live_occupant_name text);
  create table booth_intel (
    id serial primary key, booth_id integer not null references booth_map_booths(id),
    kind text not null, retired_at timestamptz,
    exhibitor_id integer references event_exhibitors(id),
    company_id integer references companies(id), subject_name text,
    review_status text default 'ok', review_reason text, review_flagged_at timestamptz);
`;

async function freshDb() {
  const db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.exec(`insert into events (name) values ('${sync.EVENT_NAME}');`);
  return db;
}

/* The production floors refuse a handful of exhibitors as implausible, which
   is right for a real show and wrong for a fixture. Declared explicitly so a
   test can never accidentally rely on the production threshold. */
const TINY = { minAbsolute: 1, minFraction: 0.1 };

const E = (id, name, booths = []) => ({
  exhibitor_source_id: String(id), source_name: name,
  name_key: require('../companyKey').normalizeNameKey(name), booths, hall: 'A',
});

// ── fetching, and the failure modes that look like success ─────────────────

const fakeRes = (body, ok = true, status = 200) => ({
  ok, status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

test('an expired session returning HTML is an error, not an empty show', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => { throw new SyntaxError('Unexpected token <'); },
  });
  await assert.rejects(() => sync.fetchExhibitors({ cookie: 'x', fetchImpl }),
    /non-JSON|expired/i);
});

test('a 401 or 403 names the likely cause', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      () => sync.fetchExhibitors({ cookie: '', fetchImpl: async () => fakeRes({}, false, status) }),
      /MYS_COOKIE/);
  }
});

test('an unexpected payload shape is refused rather than read as zero', async () => {
  await assert.rejects(
    () => sync.fetchExhibitors({ cookie: 'x', fetchImpl: async () => fakeRes({ nope: true }) }),
    /unexpected shape/);
});

test('a short page set is an incomplete fetch, not a smaller show', async () => {
  // Claims 500 exist but serves 2 and then stops.
  let call = 0;
  const fetchImpl = async () => {
    call++;
    return fakeRes({ DATA: { results: { exhibitor: {
      found: 500,
      hit: call === 1 ? [{ fields: { exhid_l: '1', exhname_t: 'A' } },
        { fields: { exhid_l: '2', exhname_t: 'B' } }] : [],
    } } } });
  };
  await assert.rejects(() => sync.fetchExhibitors({ cookie: 'x', fetchImpl }), /incomplete fetch/);
});

test('a healthy paged fetch is assembled in full', async () => {
  const page = (n, start) => ({ DATA: { results: { exhibitor: {
    found: n,
    hit: Array.from({ length: Math.min(200, n - start) }, (_, i) => ({
      fields: { exhid_l: String(start + i), exhname_t: `Co ${start + i}`,
        boothsdisplay_la: [`${1000 + start + i}randomstring`], hallid_la: ['A'] },
    })),
  } } } });
  let start = 0;
  const fetchImpl = async () => { const r = fakeRes(page(450, start)); start += 200; return r; };
  const out = await sync.fetchExhibitors({ cookie: 'x', fetchImpl });
  assert.equal(out.length, 450);
  assert.equal(out[0].booths[0], '1000', 'the source pads booth ids with a marker that must be stripped');
});

// ── the guard against mass retirement ──────────────────────────────────────

const dbTest = PGlite ? test : test.skip;

dbTest('an empty pull is refused, never applied', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await sync.resolveEvent(c);
  await sync.apply(c, await sync.plan(c, [E(1, 'Acme'), E(2, 'Beta')], eventId, TINY), eventId, 'v1', []);

  const p = await sync.plan(c, [], eventId);
  assert.ok(p.refuse, 'an empty list must be refused');
  assert.match(p.refuse, /mass withdrawal|MYS_COOKIE/i);
  assert.equal(p.created, undefined, 'a refusal carries no plan to apply');
});

dbTest('a collapse to under half is refused', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await sync.resolveEvent(c);
  const many = Array.from({ length: 100 }, (_, i) => E(i, `Co ${i}`));
  await sync.apply(c, await sync.plan(c, many, eventId), eventId, 'v1', []);

  const p = await sync.plan(c, many.slice(0, 40), eventId);
  assert.ok(p.refuse, '40 of 100 should be refused as implausible');
});

dbTest('a normal amount of churn is allowed through', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await sync.resolveEvent(c);
  const many = Array.from({ length: 100 }, (_, i) => E(i, `Co ${i}`));
  await sync.apply(c, await sync.plan(c, many, eventId), eventId, 'v1', []);

  const p = await sync.plan(c, many.slice(0, 95), eventId);
  assert.ok(!p.refuse, 'losing five of a hundred is ordinary');
  assert.equal(p.retired.length, 5);
});

// ── attendance, separately from booths ─────────────────────────────────────

dbTest('an exhibitor with no booth is still attending', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await sync.resolveEvent(c);
  await sync.apply(c, await sync.plan(c, [E(1, 'No Booth Co', [])], eventId, TINY), eventId, 'v1', []);

  const { rows } = await db.query(
    `select e.attendance_status, count(b.id)::int booths
       from event_exhibitors e left join exhibitor_booths b on b.exhibitor_id = e.id
      group by e.id, e.attendance_status`);
  assert.equal(rows[0].attendance_status, 'listed');
  assert.equal(rows[0].booths, 0, 'listed with zero booths is a valid, representable state');
});

dbTest('an exhibitor that disappears is retired, never deleted', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await sync.resolveEvent(c);
  await sync.apply(c, await sync.plan(c, [E(1, 'Acme', ['100']), E(2, 'Beta', ['200'])], eventId, TINY), eventId, 'v1', []);

  const many = [E(1, 'Acme', ['100'])];
  const p = await sync.plan(c, [...many, ...Array.from({ length: 3 }, (_, i) => E(10 + i, `Filler ${i}`))], eventId, TINY);
  await sync.apply(c, p, eventId, 'v2', []);

  const { rows } = await db.query(
    "select source_name, attendance_status, retired_at from event_exhibitors where exhibitor_source_id='2'");
  assert.equal(rows.length, 1, 'the row must still exist');
  assert.equal(rows[0].attendance_status, 'retired');
  assert.ok(rows[0].retired_at);

  const { rows: b } = await db.query(
    `select retired_at from exhibitor_booths where exhibitor_id =
       (select id from event_exhibitors where exhibitor_source_id='2')`);
  assert.ok(b[0].retired_at, 'its booth is retired with it');
});

dbTest('an exhibitor that comes back is revived, keeping its original first_seen_at', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await sync.resolveEvent(c);
  const base = Array.from({ length: 10 }, (_, i) => E(100 + i, `Base ${i}`));
  await sync.apply(c, await sync.plan(c, [...base, E(1, 'Acme', ['100'])], eventId, TINY), eventId, 'v1', []);
  const first = (await db.query("select first_seen_at from event_exhibitors where exhibitor_source_id='1'")).rows[0].first_seen_at;

  await sync.apply(c, await sync.plan(c, base, eventId, TINY), eventId, 'v2', []);
  await sync.apply(c, await sync.plan(c, [...base, E(1, 'Acme', ['100'])], eventId, TINY), eventId, 'v3', []);

  const { rows } = await db.query("select attendance_status, retired_at, first_seen_at from event_exhibitors where exhibitor_source_id='1'");
  assert.equal(rows[0].attendance_status, 'listed');
  assert.equal(rows[0].retired_at, null);
  assert.deepEqual(rows[0].first_seen_at, first, 'history is preserved across a round trip');
});

dbTest('a rename is a rename, because the exhid is stable', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await sync.resolveEvent(c);
  const base = Array.from({ length: 10 }, (_, i) => E(100 + i, `Base ${i}`));
  await sync.apply(c, await sync.plan(c, [...base, E(7, 'Old Name Ltd')], eventId, TINY), eventId, 'v1', []);
  const p = await sync.plan(c, [...base, E(7, 'New Name GmbH')], eventId, TINY);
  assert.equal(p.created.length, 0, 'a rename must not look like an arrival');
  assert.equal(p.retired.length, 0, 'nor like a departure');
  assert.equal(p.updated.length, 1);
});

// ── classifications stay with the company ──────────────────────────────────

dbTest('a reassigned booth flags its classification instead of transferring it', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await sync.resolveEvent(c);
  await db.exec(`
    insert into booth_map_booths (event_id, booth_number, source_company_name)
      values (1, '3626', 'Comau LLC');
    insert into booth_intel (booth_id, kind) values (1, 'competitor_direct');`);

  const live = [E(1, 'INTECELLS', ['3626']),
    ...Array.from({ length: 10 }, (_, i) => E(100 + i, `Base ${i}`))];
  const flags = await sync.planIntelReview(c, live, eventId);
  assert.equal(flags.length, 1);
  assert.match(flags[0].review_reason, /INTECELLS/);
  assert.match(flags[0].review_reason, /Comau/);

  await sync.apply(c, await sync.plan(c, live, eventId, TINY), eventId, 'v1', flags);
  const { rows } = await db.query('select kind, review_status, exhibitor_id, subject_name from booth_intel');
  assert.equal(rows[0].review_status, 'needs_review');
  assert.equal(rows[0].subject_name, 'Comau LLC', 'the judgement stays attached to who it was about');

  const { rows: intecells } = await db.query("select id from event_exhibitors where source_name='INTECELLS'");
  assert.notEqual(rows[0].exhibitor_id, intecells[0].id,
    'INTECELLS must NOT inherit a competitor classification by taking the booth');
});

dbTest('a company leaving the show flags its classification too', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await sync.resolveEvent(c);
  await db.exec(`
    insert into booth_map_booths (event_id, booth_number, source_company_name)
      values (1, '2604', 'Kautex Textron');
    insert into booth_intel (booth_id, kind) values (1, 'ess_ev');`);
  const live = Array.from({ length: 10 }, (_, i) => E(100 + i, `Base ${i}`));
  const flags = await sync.planIntelReview(c, live, eventId);
  assert.equal(flags.length, 1);
  assert.match(flags[0].review_reason, /not in the latest official exhibitor list/);
});

dbTest('a classification whose company still holds its booth is left alone', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await sync.resolveEvent(c);
  await db.exec(`
    insert into booth_map_booths (event_id, booth_number, source_company_name)
      values (1, '4405', 'EVE Energy');
    insert into booth_intel (booth_id, kind) values (1, 'target_customer');`);
  const live = [E(1, 'EVE Energy', ['4405']),
    ...Array.from({ length: 10 }, (_, i) => E(100 + i, `Base ${i}`))];
  assert.deepEqual(await sync.planIntelReview(c, live, eventId), []);
});

// ── booth occupancy is recorded, not corrected ─────────────────────────────

dbTest('the map records who the source says is at each booth', async () => {
  const db = await freshDb();
  const c = asClient(db);
  const eventId = await sync.resolveEvent(c);
  await db.exec(`
    insert into booth_map_booths (event_id, booth_number, source_company_name) values
      (1, '100', 'Stays Put Inc'), (1, '200', 'Moved Away Ltd'), (1, '300', 'Gone Co');`);
  const live = [E(1, 'Stays Put Inc', ['100']), E(2, 'New Tenant', ['200']),
    ...Array.from({ length: 10 }, (_, i) => E(100 + i, `Base ${i}`))];
  await sync.apply(c, await sync.plan(c, live, eventId, TINY), eventId, 'v1', []);

  const { rows } = await db.query(
    'select booth_number, occupant_status, live_occupant_name from booth_map_booths order by booth_number');
  assert.equal(rows[0].occupant_status, 'current');
  assert.equal(rows[1].occupant_status, 'reassigned');
  assert.equal(rows[1].live_occupant_name, 'New Tenant');
  assert.equal(rows[2].occupant_status, 'vacated');
  assert.equal(rows[1].source_company_name, undefined,
    'the map keeps its own name — nothing is overwritten');
});

// ── matching stays conservative ────────────────────────────────────────────

test('two candidates resolve to ambiguous, never to a pick', () => {
  const m = sync.buildMatcher([
    { id: 1, name: 'Acme', name_key: 'acme' },
    { id: 2, name: 'Acme', name_key: 'acme' },
  ]);
  const r = m('Acme');
  assert.equal(r.company_id, null);
  assert.equal(r.match_confidence, 'ambiguous');
});

test('booth number is deliberately not a matching tier', () => {
  // Booths change hands; matching on one would recreate the bug being fixed.
  const m = sync.buildMatcher([{ id: 9, name: 'Someone Else', name_key: 'someone else', booth: '3626' }]);
  assert.equal(m('INTECELLS').match_confidence, 'unmatched');
});

test('a fingerprint tracks the data, not the order it arrived in', () => {
  const a = [E(1, 'A', ['1']), E(2, 'B', ['2'])];
  assert.equal(sync.sourceVersion(a), sync.sourceVersion([...a].reverse()));
  assert.notEqual(sync.sourceVersion(a), sync.sourceVersion([E(1, 'A', ['9']), E(2, 'B', ['2'])]));
});

if (!PGlite) {
  test('database tests were skipped — PGlite not resolvable', () => {
    assert.fail(`PGlite not found at ${PGLITE}`);
  });
}
