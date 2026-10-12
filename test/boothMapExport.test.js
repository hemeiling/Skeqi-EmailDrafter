/* Booth Map downloads · 展位图下载 — exhibitor export and floor-plan manifest.

   What matters here is not that a spreadsheet comes out, but that it is the
   right one: every exhibitor (with or without a booth), shared booths kept
   shared, one row per exhibitor–company relationship, the gap between the SKQ
   map and the official list stated rather than smoothed over, nothing private
   in the file, and nothing written to get it.

   Runs only against TEST_DATABASE_URL (see dbGuard). Every row it creates
   hangs off one throwaway event, and is removed in `after`. */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dbGuard = require('./dbGuard');
const ExcelJS = require('exceljs');

const xp = require('../exhibitorExport');

// ── pure ────────────────────────────────────────────────────────────────────

test('options: unknown filters are refused, "available" is refused with a reason', () => {
  assert.deepEqual(xp.normalizeOptions({}), { filter: 'all', includeWithdrawn: false });
  assert.equal(xp.normalizeOptions({ filter: 'competitor', include_withdrawn: 'true' }).includeWithdrawn, true);
  assert.throws(() => xp.normalizeOptions({ filter: "x'; drop table companies; --" }), { code: 'bad_filter' });
  assert.throws(() => xp.normalizeOptions({ filter: 'available' }), { code: 'not_applicable' });
});

test('mapCheck: match, different occupant, available, off-map and no booth are all distinguished', () => {
  const map = new Map([
    ['100', { source_company_name: 'Acme Corp.', category: 'line' }],
    ['101', { source_company_name: 'Somebody Else', category: 'mfg' }],
    ['102', { source_company_name: 'Available', category: 'available' }],
  ]);
  assert.equal(xp.mapCheck({ source_name: 'ACME Corp', booths: ['100'] }, map).code, 'match');
  assert.equal(xp.mapCheck({ source_name: 'Acme Corp', booths: ['101'] }, map).code, 'differs');
  assert.match(xp.mapCheck({ source_name: 'Acme Corp', booths: ['101'] }, map).text, /Somebody Else/);
  assert.match(xp.mapCheck({ source_name: 'Acme Corp', booths: ['102'] }, map).text, /Available/);
  assert.match(xp.mapCheck({ source_name: 'Acme Corp', booths: ['999'] }, map).text, /not on SKQ map/);
  assert.equal(xp.mapCheck({ source_name: 'Acme Corp', booths: ['100', '999'] }, map).code, 'partial');
  assert.equal(xp.mapCheck({ source_name: 'Acme Corp', booths: [] }, map).code, 'no_booth');
});

test('the export columns carry no contact or credential fields', () => {
  const keys = xp.COLUMNS.map((c) => c.key).join(' ');
  assert.doesNotMatch(keys, /email|phone|contact|linkedin|apollo|token|password|note/i);
});

test('the map hook is additive and the map data is untouched', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'booth-map', 'index.html'), 'utf8');
  assert.match(html, /window\.skqFloorPlan\s*=/);
  // The hook draws with the map's own draw(), and restores the view it borrowed.
  assert.match(html, /cv=saved\.cv; ctx=saved\.ctx; scale=saved\.scale/);
  // Data fingerprint the booth importer computes over the embedded arrays.
  assert.equal(require('../boothImport').readSource().source_version, '16837813384761fc',
    'the embedded booth data changed — re-import the map and update this pin deliberately');
});

test('the download routes are read-only and never touch the official source or Apollo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'exhibitorExport.js'), 'utf8');
  assert.doesNotMatch(src, /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\btruncate\b|\bdrop\s+table\b/i);
  assert.doesNotMatch(src, /fetchExhibitors|apollo|contactDiscovery/i);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = server.slice(server.indexOf("app.get('/api/booth-map/export/manifest'"),
    server.indexOf("app.get('/api/analytics/overview'"));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /fetchExhibitors|apply\(|apollo|contactDiscovery|pool\.query\(\s*['`]\s*(insert|update|delete)/i);
});

// ── database ────────────────────────────────────────────────────────────────

const db = dbGuard.available ? require('../db') : null;
const dbTest = dbGuard.available ? test : test.skip;
if (!dbGuard.available) {
  test('booth map export DB suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
}
const pool = db && db.pool;
const EVIL = `=HYPERLINK("http://${process.pid}")`;
const T = (s) => `bmx-${process.pid}-${s}`;
const ids = { companies: [], contacts: [], booths: [], runs: [], intel: [], relations: [] };
let eventId;
const F = {};

async function company(name, extra = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO companies (name, website, industry, chinese_name) VALUES ($1,$2,$3,$4) RETURNING id`,
    [T(name), extra.website || null, extra.industry || null, extra.chinese_name || null]);
  ids.companies.push(r.id);
  return r.id;
}
async function exhibitor(name, companyId, booths, status = 'listed', raw = false) {
  const n = raw ? name : T(name);
  const { rows: [r] } = await pool.query(
    `INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name, company_id, attendance_status, match_confidence)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [eventId, T(name), n, companyId, status, companyId ? 'confident' : null]);
  for (const b of booths) {
    await pool.query('INSERT INTO exhibitor_booths (exhibitor_id, booth_number) VALUES ($1,$2)', [r.id, b]);
  }
  return r.id;
}
async function mapBooth(n, name, category, exhibitorId = null) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO booth_map_booths (event_id, booth_number, source_company_name, category, exhibitor_id, occupant_status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [eventId, n, name, category, exhibitorId, exhibitorId ? 'current' : 'unverified']);
  ids.booths.push(r.id);
  return r.id;
}

async function counts() {
  const { rows: [r] } = await pool.query(`SELECT
    (SELECT count(*) FROM companies) c, (SELECT count(*) FROM contacts) ct,
    (SELECT count(*) FROM event_exhibitors) e, (SELECT count(*) FROM exhibitor_booths) b,
    (SELECT count(*) FROM booth_map_booths) m, (SELECT count(*) FROM booth_intel) i,
    (SELECT count(*) FROM exhibitor_company_relations) r, (SELECT count(*) FROM communications) cm`);
  return r;
}

if (db) {
  test.before(async () => {
    await db.initDb();
    const { rows: [ev] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [T('Show')]);
    eventId = ev.id;

    F.acmeCo = await company('Acme', { website: 'https://acme.example', industry: 'Automation', chinese_name: '阿克米' });
    F.acme = await exhibitor('Acme', F.acmeCo, ['3626', '3630']);           // two booths
    F.partner = await exhibitor('Partner', null, ['3626']);                 // shares 3626, not in CRM
    F.nobooth = await exhibitor('NoBooth', null, []);                       // listed, no booth
    F.evil = await exhibitor(EVIL, null, ['7777'], 'listed', true);     // formula + not on map
    F.gone = await exhibitor('Withdrawn', null, ['5000'], 'retired');       // withdrawn
    F.mover = await exhibitor('Mover', null, ['4100']);                     // map shows someone else

    await mapBooth('3626', T('Acme'), 'line', F.acme);
    await mapBooth('3630', T('Acme'), 'line', F.acme);
    await mapBooth('4100', 'Old Tenant', 'mfg');
    await mapBooth('4200', 'Available', 'available');
    await mapBooth('4300', 'Vacated Co', 'other');

    const { rows: [bi] } = await pool.query(
      `INSERT INTO booth_intel (booth_id, kind, exhibitor_id, reason) VALUES ($1,'competitor_direct',$2,'test') RETURNING id`,
      [ids.booths[0], F.acme]);
    ids.intel.push(bi.id);

    // A reviewed "same company" record with a private contact on it.
    F.subCo = await company('Acme Subsidiary', { website: 'https://sub.example' });
    const { rows: [ct] } = await pool.query(
      `INSERT INTO contacts (full_name, email, phone, company_id) VALUES ('Private Person','private@example.com','+1 555 0100',$1) RETURNING id`,
      [F.subCo]);
    ids.contacts.push(ct.id);
    const { rows: [rel] } = await pool.query(
      `INSERT INTO exhibitor_company_relations (exhibitor_id, related_company_id, decision, evidence, decided_by)
       VALUES ($1,$2,'same_company','{}'::jsonb,'test') RETURNING id`, [F.acme, F.subCo]);
    ids.relations.push(rel.id);

    const { rows: [run] } = await pool.query(
      `INSERT INTO exhibitor_import_runs (event_id, status, dry_run, source_version, finished_at)
       VALUES ($1,'success',FALSE,'testversion',NOW() + interval '1 day') RETURNING id`, [eventId]);
    ids.runs.push(run.id);
  });

  test.after(async () => {
    try {
      await pool.query('DELETE FROM exhibitor_company_relations WHERE id = ANY($1::int[])', [ids.relations]);
      await pool.query('DELETE FROM contacts WHERE id = ANY($1::int[])', [ids.contacts]);
      await pool.query('DELETE FROM booth_intel WHERE id = ANY($1::int[])', [ids.intel]);
      await pool.query('DELETE FROM booth_map_booths WHERE id = ANY($1::int[])', [ids.booths]);
      await pool.query('DELETE FROM event_exhibitors WHERE event_id = $1', [eventId]);
      await pool.query('DELETE FROM exhibitor_import_runs WHERE id = ANY($1::int[])', [ids.runs]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [ids.companies]);
      await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    } finally {
      await pool.end();
    }
  });
}

dbTest('every listed exhibitor is exported, booths and shared booths preserved', async () => {
  const s = await xp.buildSnapshot(pool, {});
  assert.equal(s.event.id, eventId);
  assert.equal(s.official.run_id, ids.runs[0]);
  assert.equal(s.official.listed, 5);
  assert.equal(s.official.with_booth, 4);
  assert.equal(s.official.without_booth, 1);
  assert.equal(s.exhibitor_count, 5, 'withdrawn exhibitors are excluded by default');

  const by = (n) => s.rows.filter((r) => r.official_name === T(n));
  const acme = by('Acme');
  assert.equal(acme.length, 2, 'direct link + reviewed relation = two rows');
  assert.equal(acme[0].booths, '3626, 3630');
  assert.equal(acme[0].booth_count, 2);
  assert.match(acme[0].shared_with, new RegExp(`${T('Partner')} \\(3626\\)`));
  assert.equal(acme[0].crm_company_id, F.acmeCo);
  assert.equal(acme[0].website, 'https://acme.example');
  assert.match(acme[0].classification, /Direct competitor/);
  assert.match(acme[0].map_check, /Matches/);
  assert.equal(acme[1].crm_company_id, F.subCo);
  assert.match(acme[1].link, /Reviewed same company/);

  const partner = by('Partner')[0];
  assert.match(partner.shared_with, new RegExp(T('Acme')));
  assert.match(partner.map_check, /SKQ map shows/, 'the map labels the shared booth with only one company');
  assert.equal(partner.crm_company_id, null);

  assert.match(by('NoBooth')[0].booths, /No booth assigned/);
  assert.match(by('Mover')[0].map_check, /Old Tenant/);
  assert.match(s.rows.find((r) => r.official_name === EVIL).map_check, /not on SKQ map/);
  assert.equal(by('Withdrawn').length, 0);

  const withdrawn = await xp.buildSnapshot(pool, { include_withdrawn: 'true' });
  assert.match(withdrawn.rows.find((r) => r.official_name === T('Withdrawn')).attendance, /Withdrawn/);
});

dbTest('map vs official differences and the booth index are reported', async () => {
  const s = await xp.buildSnapshot(pool, {});
  assert.deepEqual(s.differences, {
    booths_matching: 2, booths_different_occupant: 1, booths_official_not_on_map: 1,
    booths_on_map_not_official: 1, exhibitors_not_matching_map: 3,
  });
  const b3626 = s.booths.find((b) => b.booth === '3626');
  assert.equal(b3626.exhibitors.length, 2, 'a shared booth lists every exhibitor on it');
  assert.equal(s.booths.find((b) => b.booth === '4200').status, 'available');
  assert.equal(s.booths.find((b) => b.booth === '7777').status, 'official_only');
  assert.deepEqual(s.no_booth, [T('NoBooth')]);
  const man = xp.manifest(s);
  assert.equal(man.rows, undefined, 'the floor-plan manifest carries no per-company CRM rows');
});

dbTest('filters follow the map: overlay filters by classification, categories by map category', async () => {
  assert.deepEqual((await xp.buildSnapshot(pool, { filter: 'competitor' })).rows.map((r) => r.official_name),
    [T('Acme'), T('Acme')]);
  assert.equal((await xp.buildSnapshot(pool, { filter: 'line' })).exhibitor_count, 1);
  assert.equal((await xp.buildSnapshot(pool, { filter: 'gov' })).exhibitor_count, 0);
  await assert.rejects(xp.buildSnapshot(pool, { filter: 'available' }), { code: 'not_applicable' });
});

dbTest('files: formula injection neutralised, nothing private, workbook formatted', async () => {
  const s = await xp.buildSnapshot(pool, {});
  const csv = xp.toCsv(s);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://${process.pid}"")`), 'a formula-looking name is written as text');
  assert.doesNotMatch(csv, /private@example\.com|Private Person|555 0100/);
  assert.equal(csv.trim().split('\r\n').length, s.rows.length + 1);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await xp.toXlsx(s));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Exhibitors 展商', 'Booths 展位', 'About 说明']);
  const ws = wb.getWorksheet('Exhibitors 展商');
  assert.equal(ws.views[0].state, 'frozen');
  assert.ok(ws.autoFilter);
  let formulas = 0;
  wb.worksheets.forEach((w) => w.eachRow((r) => r.eachCell((c) => { if (c.formula) formulas++; })));
  assert.equal(formulas, 0);
  const about = [];
  wb.getWorksheet('About 说明').eachRow((r) => about.push(`${r.getCell(1).value}|${r.getCell(2).value}`));
  assert.ok(about.some((l) => l.startsWith('Verification run') && l.includes(`#${ids.runs[0]}`)));
  assert.ok(about.some((l) => l.includes('did not re-check the official source')));
  assert.match(xp.filename(s, 'xlsx'), /^battery-show-2026_exhibitors_all_verified-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

dbTest('building an export writes nothing', async () => {
  const before = await counts();
  const s = await xp.buildSnapshot(pool, { include_withdrawn: '1' });
  await xp.toXlsx(s); xp.toCsv(s); xp.manifest(s);
  assert.deepEqual(await counts(), before);
});
