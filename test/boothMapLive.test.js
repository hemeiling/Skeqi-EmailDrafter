/* Live Booth Map — geometry plan, company-resolved classifications, the model
   the map/exports/assistant share, and the read-only sync preview.

   The rules worth pinning are the refusals: an ambiguous move is not made, a
   colliding booth is not drawn on top of another, a classification never
   lands on a different company, a CRM link made by booth number is not an
   identity, and building any of it writes nothing.

   DB parts run only against TEST_DATABASE_URL (see dbGuard); every row they
   create hangs off one throwaway event and is removed in `after`. */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbGuard = require('./dbGuard');

const plan = require('../scripts/booth-geometry-plan');
const M = require('../boothMapModel');
const boothImport = require('../boothImport');

// ── geometry plan (pure) ───────────────────────────────────────────────────

/* Our map is the official plan at 1/15 scale (X0=0, Y0=0); a few booths are
   then perturbed to exercise each rule. 20 rows × 5 columns of 10' booths. */
function fixtureGeometry() {
  const ours = [];
  const official = new Map();
  for (let r = 0; r < 20; r++) {
    for (let c = 0; c < 5; c++) {
      const n = String(1000 + r * 10 + c);
      const X = c * 240, Y = r * 240;           // 16 map units apart: no collisions
      ours.push({ n, x: X / 15, y: Y / 15 });
      official.set(n, { X, Y, dims: "10' x 10'", status: 'Reserved', exh: '' });
    }
  }
  official.get('1000').X += 15 * 24;               // a plausible move into free space: relocated, but…
  official.get('1001').X += 15 * 300;              // …this one is an implausible 300-unit jump
  official.get('1002').X = official.get('1003').X; // moves exactly onto 1003: collision
  official.set('NEW1', { X: 5 * 240, Y: 0, dims: "10' x 10'", status: 'Available', exh: '' });
  official.set('NEW2', { X: 3 * 240 + 30, Y: 240, dims: "10' x 10'", status: 'Reserved', exh: '' }); // overlaps 1013
  official.set('TEMP_9', { X: 0, Y: 99999, dims: "10' x 10'", status: 'Available', exh: '' });     // far outside
  official.delete('1194');                         // gone from the official plan
  return { ours, official };
}

test('plan: kept, relocated, ambiguous, collisions, new, outside-hall and historical', () => {
  const { ours, official } = fixtureGeometry();
  const p = plan.buildPlan(ours, official, { map_snapshot_version: 'x', source_sha256: 'y' });
  const by = Object.fromEntries([...p.booths, ...p.historical].map((b) => [b.n, b]));

  assert.equal(by['1010'].decision, 'kept');
  assert.deepEqual([by['1010'].x, by['1010'].y], [0, 16], 'kept booths keep their exact coordinates');
  assert.equal(by['1000'].decision, 'relocated');
  assert.equal(by['1000'].x, 24);
  assert.deepEqual(by['1000'].orig, { x: 0, y: 0 }, 'the original position is kept for rollback');
  assert.equal(by['1001'].decision, 'kept_ambiguous', 'an implausible move is not made');
  assert.equal(by['1001'].x, 16);
  assert.equal(by['1002'].decision, 'kept_ambiguous', 'a move onto another booth is not made');
  assert.equal(by.NEW1.decision, 'new');
  assert.equal(by.NEW2.decision, 'unplaced', 'a new booth that would overlap is not drawn');
  assert.equal(by.NEW2.x, null);
  assert.equal(by.TEMP_9.decision, 'unplaced', 'a placeholder far outside the hall is not drawn');
  assert.equal(by['1194'].decision, 'historical');
  // No two drawn booths share a cell.
  const drawn = p.booths.filter((b) => b.x !== null);
  for (const a of drawn) {
    for (const b of drawn) {
      if (a !== b) assert.ok(Math.abs(a.x - b.x) >= plan.CELL || Math.abs(a.y - b.y) >= plan.CELL, `${a.n} overlaps ${b.n}`);
    }
  }
});

test('plan: human review decisions can only keep a booth in place or leave a placeholder undrawn', () => {
  const { ours, official } = fixtureGeometry();
  const p = plan.buildPlan(ours, official, { decisions: {
    1000: { decision: 'kept_ambiguous', note: 'review', decided_at: 'd' },
    TEMP_9: { decision: 'placeholder', note: 'audit', decided_at: 'd' },
  } });
  const by = Object.fromEntries(p.booths.map((b) => [b.n, b]));
  assert.equal(by['1000'].decision, 'kept_ambiguous');
  assert.deepEqual([by['1000'].x, by['1000'].y], [0, 0], 'kept at the original coordinates');
  assert.equal(by.TEMP_9.decision, 'placeholder');
  assert.equal(by.TEMP_9.x, null, 'a placeholder is not drawn');
  assert.ok(by.TEMP_9, 'but its record is kept');
  assert.equal(p.decisions, undefined, 'the decisions input is not echoed into the plan');
  assert.throws(() => plan.buildPlan(ours, official, { decisions: { 1010: { decision: 'relocated' } } }), /not accepted/);
});

test('the committed plan carries the reviewed decisions for 4050 and TEMP_3446', () => {
  const p = JSON.parse(fs.readFileSync(M.PLAN_PATH, 'utf8'));
  const by = Object.fromEntries(p.booths.map((b) => [b.n, b]));
  assert.equal(by['4050'].decision, 'kept_ambiguous');
  assert.equal(by.TEMP_3446.decision, 'placeholder');
  assert.equal(by.TEMP_3446.x, null);
});

test('plan: refuses a conversion that does not reproduce the existing map', () => {
  const { ours, official } = fixtureGeometry();
  for (const [n, o] of official) if (Number(n) % 2) o.Y += 15 * 40; // scramble half the hall
  assert.throws(() => plan.buildPlan(ours, official, {}), /does not reproduce/);
});

test('parseOfficial: only booth objects; rooms, labels and duplicates are handled', () => {
  const raw = { COLUMNS: ['OBJECTTYPE', 'BOOTHDISPLAY', 'BOOTH', 'STARTXY', 'BOOTHDIMS', 'BOOTHSTATUS', 'EXHNAME'],
    DATA: [['booth', '1', '1', '0,0', "10' x 10'", 'Reserved', 'A'], ['room', '1', '1', '5,5', "1' x 1'", 'Room', 'A'],
      ['labels', 'L', 'L', '1,1', '', 'Available', ''], ['booth', '2', '2', '240,0', "10' x 10'", 'Available', '']] };
  const { booths, rooms } = plan.parseOfficial(raw);
  assert.deepEqual([...booths.keys()], ['1', '2']);
  assert.equal(booths.get('1').X, 0, 'the room marker does not overwrite the booth');
  assert.equal(rooms, 1);
  raw.DATA.push(['booth', '2', '2', '9,9', '', '', '']);
  assert.throws(() => plan.parseOfficial(raw), /duplicate booth/);
  assert.throws(() => plan.parseOfficial({ nope: 1 }), /unexpected shape/);
});

test('the committed geometry plan preserves every original coordinate and draws no two booths in one cell', () => {
  const p = JSON.parse(fs.readFileSync(M.PLAN_PATH, 'utf8'));
  const src = boothImport.readSource();
  const ours = new Map(src.booths.map((b) => [String(b.n), b]));
  assert.equal(p.map_snapshot_version, src.source_version, 'plan was built from the map currently served');
  assert.ok(p.transform.within_1_unit / p.transform.fitted_on >= 0.95);
  for (const b of [...p.booths, ...p.historical]) {
    const o = ours.get(b.n);
    if (b.decision === 'kept' || b.decision === 'kept_ambiguous') assert.deepEqual([b.x, b.y], [o.x, o.y], `${b.n} moved`);
    if (b.decision === 'relocated') assert.deepEqual(b.orig, { x: o.x, y: o.y }, `${b.n} lost its original`);
    if (b.decision === 'historical') assert.deepEqual([b.x, b.y], [o.x, o.y]);
    if (b.decision === 'new' || b.decision === 'unplaced') assert.equal(o, undefined);
  }
  assert.equal(p.booths.length + p.historical.length - p.booths.filter((b) => !ours.has(b.n)).length, ours.size,
    'every booth on the SKQ map is accounted for — none silently dropped');
  const drawn = p.booths.filter((b) => b.x !== null);
  const cells = new Set();
  for (const b of drawn) { const k = `${b.x},${b.y}`; assert.ok(!cells.has(k), `two booths at ${k}`); cells.add(k); }
});

// ── identity (pure) ────────────────────────────────────────────────────────

const ex = (id, name, extra = {}) => ({ id, source_name: name, company_id: null, booths: [], ...extra });
const prof = (booth, name, extra = {}) => ({ booth_number: booth, name, kinds: [], category: 'line', company_id: null, exhibitor_id: null, ...extra });

test('identity: each tier attaches only to exactly one exhibitor; ambiguity and similarity go to review', () => {
  const exhibitors = [ex(1, 'Acme Corp'), ex(2, 'Zeta North America', { company_id: 50 }), ex(3, 'iTECH'), ex(4, 'ITECH'),
    ex(5, 'Wevo Chemical Corporation'), ex(6, 'Global Automation Inc'), ex(7, 'Sub Holdings'),
    // A real exhibitor list has many "Automation" companies; that is what makes the word common.
    ex(8, 'Alpha Automation'), ex(9, 'Beta Automation Systems')];
  const r = M.resolveProfiles([
    prof('1', 'ACME Corp.', { exhibitor_id: 1 }),
    prof('2', 'Acme Corp'),
    prof('3', 'Zeta Holdings', { company_id: 50 }),
    prof('4', 'iTECH'),
    prof('5', 'WEVO-CHEMIE GmbH'),
    prof('6', 'Other Automation LLC'),
    prof('7', 'Parent Co', { company_id: 77 }),
  ], exhibitors, new Map([[77, [7]]]));
  const by = Object.fromEntries(r.map((x) => [x.profile.booth_number, x]));
  assert.equal(by['1'].tier, 'sync_anchor');
  assert.equal(by['2'].tier, 'exact_name');
  assert.equal(by['3'].tier, 'crm_company');
  assert.equal(by['3'].exhibitor.id, 2);
  assert.equal(by['4'].review, 'ambiguous', 'two exhibitors with the same name are not picked between');
  assert.equal(by['5'].review, 'possible_rename');
  assert.equal(by['5'].exhibitor, undefined, 'a possible rename attaches nothing on its own');
  assert.equal(by['6'].review, 'left_show', 'a common word like "Automation" is not similarity');
  assert.equal(by['7'].tier, 'reviewed_relation');
});

// ── assembly (pure) ────────────────────────────────────────────────────────

function assembleFixture(overrides = {}) {
  const exhibitors = [
    ex(1, 'Acme', { booths: ['100'] }), ex(2, 'Partner', { booths: ['100'] }),
    ex(3, 'Mover', { booths: ['200'] }), ex(4, 'Newcomer', { booths: ['101'] }), ex(5, 'Nobooth'),
  ];
  const profiles = [
    prof('100', 'Acme', { kinds: ['competitor_direct'] }),
    prof('101', 'Mover', { kinds: ['target_customer'], category: 'customer' }),   // Mover was at 101, now at 200
    prof('102', 'Gone', { kinds: ['ess_ev'] }),
  ];
  const geometry = {
    version: 'g1', source: { fetched_at: 't' }, counts: {},
    booths: [
      { n: '100', x: 0, y: 0, decision: 'kept', official_status: 'Reserved' },
      { n: '101', x: 16, y: 0, decision: 'kept', official_status: 'Reserved' },
      { n: '102', x: 32, y: 0, decision: 'kept', official_status: 'Available' },
      { n: '103', x: 48, y: 0, decision: 'kept', official_status: 'Reserved' },
      { n: '104', x: 64, y: 0, decision: 'kept', official_status: 'On Hold' },
      { n: '200', x: 80, y: 0, decision: 'new', official_status: 'Reserved' },
    ],
    historical: [{ n: '999', x: 0, y: 32 }],
  };
  const resolutions = M.resolveProfiles(profiles, exhibitors);
  return M.assemble({ run: { id: 7, source_version: 's', finished_at: 'f' }, plan: geometry, exhibitors, resolutions,
    mapImport: { source_version: 'm' }, ...overrides });
}

test('assembly: classifications follow the company; a new occupant is unclassified; statuses are distinct', () => {
  const m = assembleFixture();
  const booth = Object.fromEntries(m.booths.map((b) => [b.n, b]));
  assert.equal(booth['100'].st, 'shared');
  assert.equal(booth['100'].occ.length, 2);
  assert.equal(booth['101'].st, 'assigned');
  assert.equal(booth['102'].st, 'vacant');
  assert.equal(booth['103'].st, 'unverified');
  assert.equal(booth['104'].st, 'on_hold');
  assert.deepEqual(m.exhibitors[3].kinds, ['target_customer'], 'Mover keeps its classification at its new booth');
  assert.equal(m.exhibitors[3].category, 'customer');
  assert.deepEqual(m.exhibitors[3].from, ['101']);
  assert.deepEqual(m.exhibitors[4].kinds, [], 'the company now at 101 does not inherit Mover’s classification');
  assert.equal(m.exhibitors[4].category, null);
  assert.deepEqual(m.exhibitors[2].kinds, [], 'sharing a booth with a competitor does not make Partner one');
  assert.deepEqual(m.review.map((r) => [r.company, r.kind]), [['Gone', 'left_show']]);
  assert.deepEqual(m.no_booth, ['Nobooth']);
  assert.equal(m.historical.length, 1);
  const v = M.validate(m);
  assert.equal(v.failures.length, 0);
  assert.equal(v.drawn_at_every_booth, 4);
  assert.equal(v.shared_booths, 1);
});

test('assembly: version changes with occupancy, validation catches undrawn booths and foreign classifications', () => {
  const a = assembleFixture();
  const b = assembleFixture({ run: { id: 8, source_version: 's2', finished_at: 'f' } });
  assert.notEqual(a.version, b.version);
  const broken = JSON.parse(JSON.stringify(a));
  broken.booths = broken.booths.filter((x) => x.n !== '200');
  broken.exhibitors[4].kinds = ['competitor_direct'];
  const types = M.validate(broken).failures.map((f) => f.type).sort();
  assert.deepEqual(types, ['classification_not_from_company', 'not_drawn']);
});

// ── database ───────────────────────────────────────────────────────────────

const db = dbGuard.available ? require('../db') : null;
const dbTest = dbGuard.available ? test : test.skip;
if (!dbGuard.available) test('booth map live DB suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
const pool = db && db.pool;
const T = (s) => `bml-${process.pid}-${s}`;
const ids = { companies: [], booths: [], intel: [], runs: [], relations: [], imports: [] };
let eventId;
let planFile;

async function company(name) {
  const { rows: [r] } = await pool.query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [T(name)]);
  ids.companies.push(r.id); return r.id;
}
async function exhibitor(name, companyId, booths) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name, company_id, attendance_status)
     VALUES ($1,$2,$3,$4,'listed') RETURNING id`, [eventId, T(name), T(name), companyId]);
  for (const b of booths) await pool.query('INSERT INTO exhibitor_booths (exhibitor_id, booth_number) VALUES ($1,$2)', [r.id, b]);
  return r.id;
}
async function mapBooth(n, name, category, { companyId = null, method = 'name_exact', exhibitorId = null, kinds = [] } = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO booth_map_booths (event_id, booth_number, source_company_name, category, company_id, match_method, exhibitor_id, occupant_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [eventId, n, name === 'Available' ? 'Available' : T(name), category, companyId, method, exhibitorId, exhibitorId ? 'current' : 'unverified']);
  ids.booths.push(r.id);
  for (const k of kinds) {
    const { rows: [i] } = await pool.query(`INSERT INTO booth_intel (booth_id, kind, reason) VALUES ($1,$2,'test') RETURNING id`, [r.id, k]);
    ids.intel.push(i.id);
  }
  return r.id;
}
async function counts() {
  const { rows: [r] } = await pool.query(`SELECT
    (SELECT count(*) FROM companies) c, (SELECT count(*) FROM event_exhibitors) e, (SELECT count(*) FROM exhibitor_booths) b,
    (SELECT count(*) FROM booth_map_booths) m, (SELECT count(*) FROM booth_intel) i,
    (SELECT count(*) FROM exhibitor_company_relations) r, (SELECT md5(string_agg(id || ':' || COALESCE(review_status,'') || ':' || COALESCE(exhibitor_id::text,''), ',' ORDER BY id)) FROM booth_intel) ih`);
  return r;
}

const F = {};
if (db) {
  test.before(async () => {
    await db.initDb();
    const { rows: [ev] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [T('Show')]);
    eventId = ev.id;
    F.acmeCo = await company('Acme');
    F.zetaCo = await company('Zeta Holdings');
    F.tenantCo = await company('Old Tenant');
    F.parentCo = await company('Parent Group');

    F.acme = await exhibitor('Acme', F.acmeCo, ['100']);
    F.partner = await exhibitor('Partner', null, ['100']);           // shares 100
    F.mover = await exhibitor('Mover', null, ['200']);               // was at 101
    F.newcomer = await exhibitor('Newcomer', null, ['101']);         // took 101
    F.zeta = await exhibitor('Zeta North America', F.zetaCo, ['105']); // same CRM company as map's "Zeta Holdings"
    F.renamed = await exhibitor('Unrelated Tenant', F.tenantCo, ['103']); // CRM link on map was by booth number only
    F.sub = await exhibitor('Subsidiary', null, ['106']);            // admin-reviewed same company as Parent Group
    F.nobooth = await exhibitor('Nobooth', null, []);

    await mapBooth('100', 'Acme', 'line', { companyId: F.acmeCo, exhibitorId: F.acme, kinds: ['competitor_direct'] });
    await mapBooth('101', 'Mover', 'customer', { kinds: ['target_customer'] });
    await mapBooth('102', 'Gone', 'other', { kinds: ['ess_ev'] });
    await mapBooth('103', 'Old Tenant', 'mfg', { companyId: F.tenantCo, method: 'booth_number', kinds: ['target_customer'] });
    await mapBooth('104', 'Available', 'available');
    await mapBooth('105', 'Zeta Holdings', 'batmat', { companyId: F.zetaCo, kinds: ['ess_ev'] });
    await mapBooth('107', 'Parent Group', 'elec', { companyId: F.parentCo, kinds: ['target_customer'] });

    const { rows: [rel] } = await pool.query(
      `INSERT INTO exhibitor_company_relations (exhibitor_id, related_company_id, decision, evidence, decided_by)
       VALUES ($1,$2,'same_company','{}'::jsonb,'test') RETURNING id`, [F.sub, F.parentCo]);
    ids.relations.push(rel.id);
    const { rows: [run] } = await pool.query(
      `INSERT INTO exhibitor_import_runs (event_id, status, dry_run, source_version, finished_at)
       VALUES ($1,'success',FALSE,'live-test',NOW() + interval '2 days') RETURNING id`, [eventId]);
    ids.runs.push(run.id);
    F.run = run.id;

    const at = (n, x, decision = 'kept', status = 'Reserved') => ({ n, x, y: 0, decision, official_status: status, dims: "10' x 10'" });
    planFile = path.join(os.tmpdir(), `bml-plan-${process.pid}.json`);
    fs.writeFileSync(planFile, JSON.stringify({ version: 'testplan', source: { fetched_at: 'now' }, counts: {},
      booths: [at('100', 0), at('101', 16), at('102', 32, 'kept', 'Available'), at('103', 48), at('104', 64, 'kept', 'Available'),
        at('105', 80), at('106', 96, 'new'), at('200', 112, 'relocated'), { n: '300', x: null, y: null, decision: 'unplaced', official_status: 'Reserved' }],
      historical: [{ n: '107', x: 0, y: 32, decision: 'historical' }] }));
  });

  test.after(async () => {
    try {
      await pool.query('DELETE FROM exhibitor_company_relations WHERE id = ANY($1::int[])', [ids.relations]);
      await pool.query('DELETE FROM booth_intel WHERE id = ANY($1::int[])', [ids.intel]);
      await pool.query('DELETE FROM booth_map_booths WHERE id = ANY($1::int[])', [ids.booths]);
      await pool.query('DELETE FROM event_exhibitors WHERE event_id = $1', [eventId]);
      await pool.query('DELETE FROM exhibitor_import_runs WHERE id = ANY($1::int[])', [ids.runs]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [ids.companies]);
      await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
      if (planFile) fs.rmSync(planFile, { force: true });
    } finally {
      await pool.end();
    }
  });
}

dbTest('model: occupancy from the verified run, classifications attached only through a real identity', async () => {
  const before = await counts();
  const m = await M.buildModel(pool, { planFile });
  assert.equal(m.official.run_id, F.run);
  assert.equal(m.geometry.version, 'testplan');
  const e = m.exhibitors;
  assert.deepEqual(e[F.acme].kinds, ['competitor_direct']);
  assert.deepEqual(e[F.mover].kinds, ['target_customer'], 'Mover took its classification to booth 200');
  assert.equal(e[F.mover].category, 'customer');
  assert.deepEqual(e[F.newcomer].kinds, [], 'the new occupant of 101 is not labelled with Mover’s classification');
  assert.equal(e[F.newcomer].category, null);
  assert.deepEqual(e[F.zeta].kinds, ['ess_ev'], 'same CRM company record → same identity');
  assert.equal(e[F.zeta].tier, 'crm_company');
  assert.deepEqual(e[F.renamed].kinds, [], 'a CRM link made by booth number is not an identity');
  assert.deepEqual(e[F.sub].kinds, ['target_customer'], 'an admin-reviewed relation is an identity');
  assert.equal(e[F.sub].tier, 'reviewed_relation');
  assert.deepEqual(e[F.partner].kinds, []);

  const booth = Object.fromEntries(m.booths.map((b) => [b.n, b]));
  assert.equal(booth['100'].st, 'shared');
  assert.equal(booth['102'].st, 'vacant');
  assert.equal(booth['104'].st, 'vacant');
  assert.deepEqual(m.historical.map((h) => h.n), ['107']);
  assert.deepEqual(m.unplaced.map((u) => u.n), ['300']);
  assert.deepEqual(m.no_booth, [T('Nobooth')]);
  const review = Object.fromEntries(m.review.map((r) => [r.company, r.kind]));
  assert.equal(review[T('Gone')], 'left_show');
  assert.ok(review[T('Old Tenant')], 'the booth-number-linked profile is held for review, not attached');
  assert.deepEqual(M.validate(m).failures, []);
  assert.deepEqual(await counts(), before, 'building the model writes nothing');
});

dbTest('exports in live mode describe the same model the map draws', async () => {
  const exhibitorExport = require('../exhibitorExport');
  const m = await M.buildModel(pool, { planFile });
  const s = await exhibitorExport.buildSnapshot(pool, {}, { model: m });
  assert.equal(s.map.mode, 'live');
  assert.equal(s.map.model_version, m.version);
  const row = (n) => s.rows.find((r) => r.official_name === T(n));
  assert.match(row('Mover').classification, /Target customer/);
  assert.match(row('Mover').map_check, /Drawn at official booth/);
  assert.equal(row('Newcomer').classification, '');
  assert.match(row('Newcomer').map_category, /Unclassified/);
  assert.match(row('Nobooth').map_check, /No booth/);
  const unclassified = await exhibitorExport.buildSnapshot(pool, { filter: 'unclassified' }, { model: m });
  assert.ok(unclassified.rows.some((r) => r.official_name === T('Newcomer')));
  assert.ok(!unclassified.rows.some((r) => r.official_name === T('Mover')));
  await assert.rejects(exhibitorExport.buildSnapshot(pool, { filter: 'historical' }, { model: m }), { code: 'not_applicable' });
  const snap = await exhibitorExport.buildSnapshot(pool, {});
  assert.equal(snap.map.mode, 'snapshot', 'without a model the export is unchanged');
  assert.equal(snap.map.model_version, null);
});

dbTest('assistant tools answer from the live model only when the flag is on', async () => {
  const config = require('../config');
  const chatTools = require('../chatTools');
  const prev = config.BOOTH_MAP_MODE;
  try {
    config.BOOTH_MAP_MODE = 'snapshot';
    const off = await chatTools.runTool('list_companies_by_category', { category: 'target_customer', limit: 50 });
    assert.equal(off.map_version, undefined, 'flag off: the original snapshot tool');
    config.BOOTH_MAP_MODE = 'live';
    // The tool uses the committed plan; occupancy and classification must still come from the live model.
    const on = await chatTools.runTool('list_companies_by_category', { category: 'target_customer', limit: 200 });
    assert.ok(on.map_version, 'flag on: labelled with the model version');
    assert.match(on.source, /live booth map/);
    const names = on.companies.map((c) => c.name);
    assert.ok(names.includes(T('Mover')));
    assert.ok(!names.includes(T('Newcomer')), 'no classification for the company that took Mover’s old booth');
  } finally {
    config.BOOTH_MAP_MODE = prev;
  }
});

dbTest('the sync preview is read-only and reports before and after', async () => {
  const preview = require('../boothMapPreview');
  const before = await counts();
  // Uses the committed plan: the preview must build and validate whatever is configured.
  const p = await preview.buildPreview(pool);
  const s = preview.summary(p);
  assert.ok(s.versions.model && s.versions.geometry);
  assert.equal(s.after.booths_different_occupant, 0);
  assert.equal(typeof s.before.booths_different_occupant, 'number');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await preview.toXlsx(p));
  assert.ok(wb.getWorksheet('Summary 摘要') && wb.getWorksheet('Review 审核') && wb.getWorksheet('Geometry 位置'));
  assert.deepEqual(await counts(), before);
});

test('the map keeps snapshot behaviour unless the server says live, and falls back visibly', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'booth-map', 'index.html'), 'utf8');
  assert.match(html, /window\.addEventListener\('load',bootMap\)/);
  assert.match(html, /x\.d\.mode==='live'/, 'live is applied only when the server answers live');
  assert.match(html, /Live booth data unavailable/);
  assert.match(html, /throws BEFORE the embedded data is touched/);
  assert.equal(require('../config').BOOTH_MAP_MODE, process.env.BOOTH_MAP_MODE === 'live' ? 'live' : 'snapshot');
});
