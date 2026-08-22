// Phase 0 of the Customer Intelligence feature: tag-taxonomy seed + SKQ
// product-capability matrix import.
//
// Like the other DB-backed suites, this runs against the real DATABASE_URL in
// .env. Unlike them it creates NO throwaway fixtures: the taxonomy and the SKQ
// matrix are permanent reference data, and every write here is idempotent, so
// the suite is safe to run repeatedly and intentionally leaves that data behind.
require('dotenv').config(); // db.js reads process.env.DATABASE_URL directly
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const dbGuard = require('./dbGuard');

/* Every test below needs a database. Without TEST_DATABASE_URL there is
   nowhere safe to run them, and the one place they must never run is the
   database .env points at — so the whole suite skips rather than falling back.
   `return` at module scope is legal in CommonJS and is the least invasive way
   to skip a file wholesale. */
if (!dbGuard.available) {
  require('node:test')('database suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
  return;
}

const db = require('../db');
const { parseMatrix, importMatrix, splitBilingual, parseSystem } = require('../scripts/import-skq-matrix');

const XLSX = path.join(__dirname, '..', '整线蓝本的15个模块分类.xlsx');

// --- Pure parser (no DB) -----------------------------------------------------
// These run without a database so the (novel) sheet-parsing logic is always
// exercised, even where DATABASE_URL is not configured.

test('parseMatrix yields 15 modules, 10 systems, 93 equipment', async () => {
  const { modules, systems, equipment } = await parseMatrix(XLSX);
  assert.equal(modules.length, 15);
  assert.equal(systems.length, 10);
  assert.equal(equipment.length, 93);
  // seq numbers are the full contiguous 1..93 with no duplicates
  const seqs = equipment.map((e) => e.seq_no).sort((a, b) => a - b);
  assert.equal(seqs[0], 1);
  assert.equal(seqs[92], 93);
  assert.equal(new Set(seqs).size, 93);
});

test('parseMatrix preserves bilingual names for every equipment', async () => {
  const { equipment } = await parseMatrix(XLSX);
  const missing = equipment.filter((e) => !e.name_en || !e.name_cn);
  assert.equal(missing.length, 0);
});

test('parseMatrix fills module/system down without bleeding across blocks', async () => {
  const { equipment } = await parseMatrix(XLSX);
  const bySeq = (n) => equipment.find((e) => e.seq_no === n);

  // Continuation row inherits its block's module + system.
  const ccs = bySeq(55); // CCS Laser Welding
  assert.equal(ccs.name_en, 'CCS Laser Welding');
  assert.equal(ccs.module_no, 10); // Welding
  assert.equal(ccs.system_no, 5); // Connection Process Equipment

  // Every equipment resolves a module...
  assert.equal(equipment.filter((e) => e.module_no == null).length, 0);

  // ...but modules 8, 9, 11 (which the sheet leaves with no system) must NOT
  // inherit the system of the module above them.
  const noSystemModules = new Set(
    equipment.filter((e) => e.system_no == null).map((e) => e.module_no)
  );
  assert.deepEqual([...noSystemModules].sort((a, b) => a - b), [8, 9, 11]);
});

test('splitBilingual and parseSystem parse the sheet formats', () => {
  assert.deepEqual(splitBilingual('Loading&Unloading\n上下料'), { en: 'Loading&Unloading', cn: '上下料' });
  assert.deepEqual(splitBilingual('电芯贴胶\nCell Taping'), { en: 'Cell Taping', cn: '电芯贴胶' });
  assert.deepEqual(parseSystem('2. 拿取搬运设备'), { no: 2, cn: '拿取搬运设备' });
  assert.deepEqual(parseSystem(''), { no: null, cn: '' });
});

// --- DB-backed: taxonomy seed + matrix import --------------------------------
// Requires a reachable DATABASE_URL. Writes permanent reference data (taxonomy
// + SKQ matrix); every write is idempotent so it is safe to re-run.
describe('database', () => {
  before(async () => {
    await db.initDb(); // seeds tag taxonomy + the 10 systems
  });

  after(async () => {
    await db.pool.end();
  });

  test('tag taxonomy is seeded with the expected categories and tag counts', async () => {
  const taxonomy = await db.getTaxonomy();
  const byKey = Object.fromEntries(taxonomy.map((c) => [c.key, c]));
  assert.equal(taxonomy.length, 7);
  assert.equal(byKey.segment.tags.length, 2);
  assert.equal(byKey.energy_storage_app.tags.length, 3);
  assert.equal(byKey.power_battery_app.tags.length, 5);
  assert.equal(byKey.cell_format.tags.length, 3);
  assert.equal(byKey.product_scope.tags.length, 11);
  assert.equal(byKey.contact_role.tags.length, 10);
  assert.equal(byKey.customer_priority.tags.length, 11);

  // hierarchy + applies_to wiring
  assert.equal(byKey.energy_storage_app.parent_category_key, 'segment');
  assert.equal(byKey.power_battery_app.parent_category_key, 'segment');
  assert.equal(byKey.contact_role.applies_to, 'contact');
  assert.equal(byKey.segment.applies_to, 'company');
});

test('re-seeding the taxonomy does not duplicate categories or tags', async () => {
  const before = await db.getTaxonomy();
  const beforeTags = before.reduce((n, c) => n + c.tags.length, 0);
  await db.initDb(); // idempotent re-run
  const after = await db.getTaxonomy();
  const afterTags = after.reduce((n, c) => n + c.tags.length, 0);
  assert.equal(after.length, before.length);
  assert.equal(afterTags, beforeTags);
});

// --- Matrix import (DB) ------------------------------------------------------

test('importMatrix loads the full matrix and links equipment to module + system', async () => {
  const counts = await importMatrix(XLSX);
  assert.deepEqual(counts, { modules: 15, systems: 10, equipment: 93 });

  const modules = await db.listSkqModules();
  const systems = await db.listSkqSystems();
  const equipment = await db.listSkqEquipment();
  assert.equal(modules.length, 15);
  assert.equal(systems.length, 10);
  assert.equal(equipment.length, 93);

  // systems keep their canonical English names (seeded, not in the sheet)
  const sys5 = systems.find((s) => s.system_no === 5);
  assert.equal(sys5.name_en, 'Connection Process Equipment');
  assert.equal(sys5.name_cn, '连接工艺设备');

  // joined spot-check: equipment #55 resolves to Welding / Connection Process
  const ccs = equipment.find((e) => e.seq_no === 55);
  assert.equal(ccs.module_name_en, 'Welding');
  assert.equal(ccs.system_no, 5);
  assert.equal(ccs.department, 'Mechanical');
});

  test('re-importing the matrix is idempotent (no duplicate rows)', async () => {
    await importMatrix(XLSX);
    await importMatrix(XLSX);
    assert.equal((await db.listSkqModules()).length, 15);
    assert.equal((await db.listSkqSystems()).length, 10);
    assert.equal((await db.listSkqEquipment()).length, 93);
  });
});
