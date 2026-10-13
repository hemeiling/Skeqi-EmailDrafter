/* Battery CT · 电池CT检测 research overlay, and the "pending identity review"
   safeguard of the live Booth Map.

   The overlay is pinned on what it must NOT do: change geometry, occupancy,
   classifications, CRM relationships, contacts or the existing downloads; put
   a non-exhibitor or a 2D-only supplier on the map; or let a booth number from
   review time outlive the official list.

   DB parts run only against TEST_DATABASE_URL (see dbGuard). */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbGuard = require('./dbGuard');
const researchCt = require('../researchCt');
const M = require('../boothMapModel');

// ── the reviewed dataset ──────────────────────────────────────────────────

test('dataset: groups A–F + 2D, exhibitors by official ID, nothing invented', () => {
  const ds = researchCt.loadDataset();
  assert.deepEqual(Object.keys(ds.groups).sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'X']);
  assert.equal(ds.companies.length, 44);
  for (const c of ds.companies) {
    assert.ok(ds.groups[c.group], `${c.name}: unknown group`);
    assert.ok(['confirmed', 'low', 'indirect', 'not_ct'].includes(c.confidence), c.name);
    for (const u of c.sources) assert.match(u, /^https?:\/\//, `${c.name}: non-http source`);
    if (c.status === 'listed') {
      assert.ok(c.exhibitor_source_id, `${c.name}: an exhibitor needs its official exhibitor ID`);
      assert.ok(c.booths_at_review.length, `${c.name}: exhibitor without a reviewed booth`);
    } else {
      assert.equal(c.exhibitor_source_id, null, `${c.name}: a non-exhibitor must not carry an exhibitor ID`);
      assert.deepEqual(c.booths_at_review, [], `${c.name}: a non-exhibitor must not carry a booth`);
    }
    if (c.group === 'X') {
      assert.equal(c.ct_type, '2d_xray_only');
      assert.equal(c.confidence, 'not_ct');
      assert.notEqual(c.status, 'listed', '2D-only suppliers are research-list only');
    }
  }
  const by = (n) => ds.companies.find((c) => c.name === n);
  assert.equal(by('Lead Intelligent Equipment').group, 'F');
  assert.equal(by('Fraunhofer-Allianz Batterien c/o Fraunhofer ICT').confidence, 'indirect');
  assert.match(by('Fraunhofer-Allianz Batterien c/o Fraunhofer ICT').technology, /ALLIANCE BOOTH/);
  for (const n of ['Nordson Corporation', 'Applied Technical Services, Inc.', 'Eurofins EAG Laboratories']) {
    assert.equal(by(n).confidence, 'low', `${n} must be a low-confidence candidate`);
  }
});

test('dataset: the 14 exhibitors match the official list run #7 by exhibitor ID, booth and CRM ID', () => {
  // Pinned from the run #7 export, so a hand edit to the dataset cannot drift silently.
  const RUN7 = {
    14088: ['1113', 1359], 973272: ['3600', 962], 942047: ['5235', 1137], 7329: ['6305', 1194], 974878: ['6619', 628],
    29894: ['3816', 1049], 17009: ['5603', 887], 25915: ['3208', 1304], 372: ['5611', 735], 28686: ['3541', 561],
    936903: ['6017', 752], 32852: ['2800', 824], 954429: ['4429', 2873], 975839: ['3418', 945],
  };
  const listed = researchCt.loadDataset().companies.filter((c) => c.status === 'listed');
  assert.equal(listed.length, 14);
  for (const c of listed) {
    const r = RUN7[c.exhibitor_source_id];
    assert.ok(r, `${c.name}: exhibitor ID ${c.exhibitor_source_id} not in run #7 pin`);
    assert.deepEqual([c.booths_at_review.join(','), c.crm_company_id], r, c.name);
  }
});

test('the map only shows the CT filter when the server enables it', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'booth-map', 'index.html'), 'utf8');
  assert.match(html, /if\(!d\|\|!d\.ok\|\|!d\.enabled\|\|!Array\.isArray\(d\.on_map\)\)return;/);
  assert.equal(require('../config').BATTERY_CT_FILTER, process.env.BATTERY_CT_FILTER === 'on' ? 'on' : 'off');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /config\.BATTERY_CT_FILTER === 'on' \|\| \(req\.query\.ct === 'preview' && isAdmin\(req\)\)/);
});

test('the CT overlay and the map model never touch Apollo, contact discovery or write SQL', () => {
  for (const f of ['researchCt.js', 'boothMapModel.js', 'boothMapPreview.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /apollo|contactDiscovery|discovery\./i, `${f} references Apollo/discovery`);
    assert.doesNotMatch(src, /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\btruncate\b|\bdrop\s+table\b/i, `${f} writes`);
  }
});

// ── pending identity review (pure) ────────────────────────────────────────

test('pending: a classified same-booth rename is pending, never classified; a weak match is neither', () => {
  const ex = (id, name, booths) => ({ id, source_name: name, company_id: null, booths });
  const exhibitors = [ex(1, 'Kautex Textron GmbH & Co. KG', ['2604']), ex(2, 'Hubei Ruicheng Vacuum Technology', ['511']),
    ex(3, 'Pfeiffer Vacuum+Fab Solutions', ['2536']), ex(4, 'iTECH', ['5932']), ex(5, 'ITECH', ['5815']),
    ex(6, 'AWT Labels & Packaging', ['1713']), ex(7, 'Ningde SKEQI Intelligent Equipment', ['5407'])];
  const prof = (b, name, kinds, category = 'other') => ({ booth_number: b, name, kinds, category, company_id: null, exhibitor_id: null });
  const resolutions = M.resolveProfiles([
    prof('2604', 'Kautex Textron', ['target_customer', 'ess_ev'], 'customer'),
    prof('2536', 'Pfeiffer Vacuum', ['target_customer']),
    prof('6538', 'iTECH', ['target_customer']),
    prof('4345', 'ImageTek Labels', ['target_customer']),      // candidate at a different booth: not pending
    prof('5407', 'Skeqi', [], 'other'),                          // same booth but no judgement: nothing to protect
  ], exhibitors);
  const m = M.assemble({ run: { id: 1, source_version: 's', finished_at: 'f' }, exhibitors, resolutions,
    plan: { version: 'g', source: {}, counts: {}, historical: [],
      booths: ['2604', '511', '2536', '5932', '5815', '1713', '5407'].map((n, i) => ({ n, x: i * 16, y: 0, decision: 'kept', official_status: 'Reserved' })) },
    mapImport: null });
  const p = (id) => (m.exhibitors[id].pending || []).map((x) => x.reason);
  assert.deepEqual(p(1), ['same_booth_rename']);
  assert.deepEqual(p(3), ['same_booth_rename']);
  assert.deepEqual(p(2), [], 'a candidate at another booth is not marked');
  assert.deepEqual(p(4), ['ambiguous_identity']);
  assert.deepEqual(p(5), ['ambiguous_identity']);
  assert.deepEqual(p(6), []);
  assert.deepEqual(p(7), [], 'nothing curated to protect, so nothing pending');
  for (const id of [1, 3, 4, 5]) {
    assert.deepEqual(m.exhibitors[id].kinds, [], 'pending attaches no classification');
    assert.equal(m.exhibitors[id].category, null, 'pending attaches no category');
  }
  assert.deepEqual(M.validate(m).failures, []);
});

// ── database: the overlay changes nothing ─────────────────────────────────

const db = dbGuard.available ? require('../db') : null;
const dbTest = dbGuard.available ? test : test.skip;
if (!dbGuard.available) test('battery CT DB suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
const pool = db && db.pool;
const T = (s) => `bct-${process.pid}-${s}`;
const ids = { companies: [], booths: [], intel: [], runs: [] };
let eventId, dsFile;

async function exhibitor(src, name, booths, status = 'listed', companyId = null) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name, attendance_status, company_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [eventId, T(src), T(name), status, companyId]);
  for (const b of booths) await pool.query('INSERT INTO exhibitor_booths (exhibitor_id, booth_number) VALUES ($1,$2)', [r.id, b]);
  return r.id;
}
async function snapshotOfEverything() {
  const { rows: [r] } = await pool.query(`SELECT
    (SELECT count(*) FROM companies) c, (SELECT count(*) FROM contacts) ct, (SELECT count(*) FROM communications) cm,
    (SELECT count(*) FROM event_exhibitors) e, (SELECT md5(string_agg(exhibitor_id || ':' || booth_number || ':' || COALESCE(retired_at::text,''), ',' ORDER BY id)) FROM exhibitor_booths) b,
    (SELECT md5(string_agg(id || ':' || booth_number || ':' || COALESCE(x,0) || ',' || COALESCE(y,0) || ':' || COALESCE(category,''), ',' ORDER BY id)) FROM booth_map_booths) m,
    (SELECT md5(string_agg(id || ':' || kind || ':' || COALESCE(review_status,'') || ':' || COALESCE(exhibitor_id::text,''), ',' ORDER BY id)) FROM booth_intel) i,
    (SELECT count(*) FROM exhibitor_company_relations) r,
    (SELECT md5(string_agg(id || ':' || COALESCE(company_id::text,''), ',' ORDER BY id)) FROM event_exhibitors) links`);
  return r;
}

const F = {};
if (db) {
  test.before(async () => {
    await db.initDb();
    const { rows: [ev] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [T('Show')]);
    eventId = ev.id;
    const { rows: [co] } = await pool.query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [T('Lead')]);
    ids.companies.push(co.id);
    F.lead = await exhibitor('lead', 'Lead', ['3418'], 'listed', co.id);
    F.zeiss = await exhibitor('zeiss', 'Zeiss', ['1200']);           // reviewed at 1113; moved since
    F.gone = await exhibitor('gone', 'Gone', ['5000'], 'retired');   // withdrawn after review
    F.xray = await exhibitor('xray', 'XrayOnly', ['7000']);           // 2D-only, even though exhibiting
    const { rows: [bmb] } = await pool.query(
      `INSERT INTO booth_map_booths (event_id, booth_number, source_company_name, category, exhibitor_id, occupant_status)
       VALUES ($1,'3418',$2,'line',$3,'current') RETURNING id`, [eventId, T('Lead'), F.lead]);
    ids.booths.push(bmb.id);
    const { rows: [bi] } = await pool.query(
      `INSERT INTO booth_intel (booth_id, kind, exhibitor_id, reason) VALUES ($1,'competitor_direct',$2,'t') RETURNING id`, [bmb.id, F.lead]);
    ids.intel.push(bi.id);
    const { rows: [run] } = await pool.query(
      `INSERT INTO exhibitor_import_runs (event_id, status, dry_run, finished_at) VALUES ($1,'success',FALSE,NOW() + interval '3 days') RETURNING id`, [eventId]);
    ids.runs.push(run.id);

    const c = (name, group, src, booths, extra = {}) => ({ id: name, group, name: T(name), name_zh: '', status: 'listed',
      exhibitor_source_id: src ? T(src) : null, crm_company_id: null, booths_at_review: booths, ct_type: '3d_ct_system',
      confidence: 'confirmed', technology: 't', battery_application: 'a', levels: 'cell', mode: 'lab',
      skq_opportunity: 'o', skq_opportunity_zh: '', sources: [], notes: '', ...extra });
    dsFile = path.join(os.tmpdir(), `bct-${process.pid}.json`);
    fs.writeFileSync(dsFile, JSON.stringify({ version: 'test', title: 'CT', reviewed_at: 'r', rules: [],
      groups: { A: { en: 'A', zh: 'A' }, B: { en: 'B', zh: 'B' }, F: { en: 'F', zh: 'F' }, X: { en: 'X', zh: 'X' } },
      companies: [
        c('Lead', 'F', 'lead', ['3418']),
        c('Zeiss', 'B', 'zeiss', ['1113']),
        c('Gone', 'A', 'gone', ['5000']),
        c('XrayOnly', 'X', 'xray', ['7000'], { ct_type: '2d_xray_only', confidence: 'not_ct' }),
        c('Nikon', 'A', null, [], { status: 'not_exhibiting' }),
      ] }));
  });
  test.after(async () => {
    try {
      await pool.query('DELETE FROM booth_intel WHERE id = ANY($1::int[])', [ids.intel]);
      await pool.query('DELETE FROM booth_map_booths WHERE id = ANY($1::int[])', [ids.booths]);
      await pool.query('DELETE FROM event_exhibitors WHERE event_id = $1', [eventId]);
      await pool.query('DELETE FROM exhibitor_import_runs WHERE id = ANY($1::int[])', [ids.runs]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [ids.companies]);
      await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
      if (dsFile) fs.rmSync(dsFile, { force: true });
    } finally { await pool.end(); }
  });
}

dbTest('view: booths come from the latest run, the withdrawn and 2D-only stay off the map, LEAD keeps its label', async () => {
  const v = await researchCt.buildView(pool, { file: dsFile });
  const on = Object.fromEntries(v.on_map.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(on).sort(), ['Lead', 'Zeiss']);
  assert.deepEqual(on.Zeiss.booths, ['1200'], 'booth read from the verified run, not from review time');
  assert.equal(on.Zeiss.booth_changed_since_review, true);
  assert.deepEqual(on.Lead.existing_classification.kinds, ['competitor_direct']);
  const research = Object.fromEntries(v.research.map((c) => [c.id, c]));
  assert.equal(research.Gone.status_now, 'no_longer_listed');
  assert.deepEqual(research.Gone.booths, []);
  assert.ok(research.XrayOnly, 'a 2D-only supplier is research-list only even when exhibiting');
  assert.deepEqual(research.XrayOnly.booths, []);
  assert.equal(research.Nikon.status_now, 'not_exhibiting');
});

dbTest('the overlay writes nothing and leaves the model, classifications, links and downloads unchanged', async () => {
  const exhibitorExport = require('../exhibitorExport');
  const before = await snapshotOfEverything();
  const csvBefore = exhibitorExport.toCsv(await exhibitorExport.buildSnapshot(pool, {}));
  const v = await researchCt.buildView(pool, { file: dsFile });
  await researchCt.toXlsx(v);
  const csvAfter = exhibitorExport.toCsv(await exhibitorExport.buildSnapshot(pool, {}));
  assert.deepEqual(await snapshotOfEverything(), before, 'no table touched: geometry, occupancy, intel, relations, links, contacts');
  const strip = (s) => s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T');
  assert.equal(strip(csvAfter), strip(csvBefore), 'existing exhibitor export unchanged');
});
