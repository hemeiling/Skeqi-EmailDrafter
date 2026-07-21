// Import the SKQ product-capability matrix (15 modules / 10 systems / 93
// equipment) from 整线蓝本的15个模块分类.xlsx into the database.
//
//   node scripts/import-skq-matrix.js [path-to-xlsx]
//
// Idempotent: upserts by module_no / system_no / seq_no, so re-running never
// duplicates. The sheet groups rows visually by leaving the category columns
// (module / module-name / system) BLANK on continuation rows (they are not
// real Excel merges). We fill those down with a state machine that RESETS the
// current system at every block boundary (a row where the module column has a
// value) — so equipment under a module with no system assigned (modules 8, 9,
// 11) stays unlinked instead of inheriting the module above it.
require('dotenv').config(); // db.js reads process.env.DATABASE_URL directly
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('../db');

const DEFAULT_FILE = path.join(__dirname, '..', '整线蓝本的15个模块分类.xlsx');
const CJK = /[㐀-鿿]/;

// Resolve a cell to plain trimmed text, flattening richtext / formula /
// hyperlink cell shapes.
function cellText(cell) {
  let v = cell ? cell.value : null;
  if (v && typeof v === 'object') {
    if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if (v.text !== undefined) v = v.text;
    else if (v.result !== undefined) v = v.result;
    else v = '';
  }
  return v == null ? '' : String(v).trim();
}

// Split a bilingual cell ("English\n中文" in either order) into { en, cn }.
function splitBilingual(text) {
  const parts = String(text).split(/[\n\r]+/).map((s) => s.trim()).filter(Boolean);
  let en = '';
  let cn = '';
  for (const p of parts) {
    if (CJK.test(p)) cn = cn ? `${cn} ${p}` : p;
    else en = en ? `${en} ${p}` : p;
  }
  return { en, cn };
}

// "2. 拿取搬运设备" -> { no: 2, cn: '拿取搬运设备' }
function parseSystem(text) {
  const m = String(text).match(/(\d+)\s*[.．、]?\s*(.*)/s);
  if (!m) return { no: null, cn: '' };
  return { no: parseInt(m[1], 10), cn: (m[2] || '').replace(/\s+/g, ' ').trim() };
}

// Parse the workbook into { modules, systems, equipment } — pure, no DB access.
async function parseMatrix(filePath = DEFAULT_FILE) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  const modules = new Map(); // module_no -> row
  const systems = new Map(); // system_no -> row
  const equipment = [];

  // Filled-down block state (see header note). curSystemNo resets on every
  // block boundary; curDept updates on any non-blank department cell.
  let curModuleNo = null;
  let curModuleName = { en: '', cn: '' };
  let curSystemNo = null;
  let curDept = null;

  ws.eachRow({ includeEmpty: false }, (row) => {
    const moduleNo = parseInt(cellText(row.getCell(1)), 10);
    const dept = cellText(row.getCell(3));
    const sys = parseSystem(cellText(row.getCell(4)));

    if (Number.isInteger(moduleNo)) {
      // Block boundary: refresh module, name, and system (system may be null
      // for a module that has none — this reset is what stops the bleed).
      curModuleNo = moduleNo;
      curModuleName = splitBilingual(cellText(row.getCell(2)));
      curSystemNo = Number.isInteger(sys.no) ? sys.no : null;
      if (!modules.has(moduleNo)) {
        modules.set(moduleNo, {
          module_no: moduleNo,
          name_en: curModuleName.en,
          name_cn: curModuleName.cn,
          color_name: cellText(row.getCell(8)) || null,
          color_ral: cellText(row.getCell(9)) || null,
        });
      }
    } else if (Number.isInteger(sys.no)) {
      // System change inside a block without a new module number.
      curSystemNo = sys.no;
    }
    if (dept) curDept = dept;
    if (Number.isInteger(sys.no) && !systems.has(sys.no)) {
      systems.set(sys.no, { system_no: sys.no, name_cn: sys.cn });
    }

    const seqNo = parseInt(cellText(row.getCell(5)), 10);
    if (!Number.isInteger(seqNo)) return; // header / spacer rows carry no seq number
    const equip = splitBilingual(cellText(row.getCell(6)));
    equipment.push({
      seq_no: seqNo,
      name_en: equip.en,
      name_cn: equip.cn,
      module_no: curModuleNo,
      system_no: curSystemNo,
      department: curDept || null,
    });
  });

  return {
    modules: [...modules.values()].sort((a, b) => a.module_no - b.module_no),
    systems: [...systems.values()].sort((a, b) => a.system_no - b.system_no),
    equipment,
  };
}

// Parse + upsert into the DB. Systems are seeded (with English names) by
// db.initDb(); here we only backfill their Chinese names and link equipment.
async function importMatrix(filePath = DEFAULT_FILE) {
  const { modules, systems, equipment } = await parseMatrix(filePath);
  for (const s of systems) await db.upsertSkqSystem(s);
  for (const m of modules) await db.upsertSkqModule(m);
  for (const e of equipment) await db.upsertSkqEquipment(e);
  return { modules: modules.length, systems: systems.length, equipment: equipment.length };
}

module.exports = { parseMatrix, importMatrix, splitBilingual, parseSystem, cellText };

if (require.main === module) {
  (async () => {
    const file = process.argv[2] || DEFAULT_FILE;
    await db.initDb();
    const counts = await importMatrix(file);
    console.log(
      `Imported SKQ matrix: ${counts.modules} modules, ${counts.systems} systems, ${counts.equipment} equipment`
    );
    await db.pool.end();
  })().catch((err) => {
    console.error('SKQ import failed:', err);
    process.exit(1);
  });
}
