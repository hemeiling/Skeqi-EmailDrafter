#!/usr/bin/env node
/**
 * One-time import of the standalone Qwen Account Research reports into Neon.
 *
 *   node scripts/import-qwen-reports.js --dir "/path/to/standalone/reports"
 *   node scripts/import-qwen-reports.js --dir "…" --dry-run
 *
 * The standalone app saved each run as reports/<Company>/research_<model>.json.
 * Those files are the source of truth here and are NEVER modified or deleted —
 * they stay as the backup until the import is verified.
 *
 * Idempotent: the row id is derived from company + model + the engine's own
 * timestamp, so re-running updates the same rows instead of duplicating them.
 * A second run reports every report as "unchanged", not as new.
 *
 * Only the Qwen tables are touched. The Claude account_reports table is never
 * read or written.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes('--dry-run');
const ROOT = arg('--dir', '');

/* Only the CURRENT report per company is imported.

     <Company>/research_<model>.json   ← imported
     <Company>/research.json           ← a copy of the above; would duplicate
     <Company>/history/…               ← superseded runs; NOT imported

   There is one current report per company and no version history, so the
   archived runs have nowhere to go. They stay on disk as your backup. */
function discover(root) {
  const found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name);
  } catch (e) {
    throw new Error(`Cannot read ${root}: ${e.message}`);
  }
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    for (const f of fs.readdirSync(abs)) {
      if (/^research_.+\.json$/.test(f)) {
        found.push({ company_dir: dir, file: path.join(abs, f), kind: 'current' });
      }
    }
  }
  return found;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function readRecord(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const rec = JSON.parse(raw);
  if (!rec || typeof rec !== 'object') throw new Error('not an object');
  if (!rec.company) throw new Error('missing company');
  if (!rec.research_result && !rec.research_result_raw) throw new Error('no research result');
  return rec;
}

(async () => {
  if (!ROOT) {
    console.error('Usage: node scripts/import-qwen-reports.js --dir "<standalone reports dir>" [--dry-run]');
    process.exit(2);
  }
  console.log(`Source : ${ROOT}`);
  console.log(`Mode   : ${DRY ? 'DRY RUN (no writes)' : 'import'}\n`);

  await db.initDb();

  let files = discover(ROOT);
  const companies = new Set(files.map((f) => f.company_dir));

  /* Newest first, so if a folder somehow holds two current files the freshest
     one is the version that survives the upsert. */
  files = files.map((f) => {
    let ts = '';
    try { ts = JSON.parse(fs.readFileSync(f.file, 'utf8')).timestamp || ''; } catch (e) { /* handled below */ }
    return { ...f, ts };
  }).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  const archived = [...companies].reduce((n, d) => {
    const h = path.join(ROOT, d, 'history');
    return n + (fs.existsSync(h) ? fs.readdirSync(h).filter((f) => /\.json$/.test(f)).length : 0);
  }, 0);

  console.log(`Local reports discovered : ${files.length} current reports across ${companies.size} companies`);
  console.log(`  archived on disk       : ${archived} (kept as backup, not imported)\n`);

  const stats = { imported: 0, updated: 0, unchanged: 0, failed: 0 };
  const failures = [];

  for (const { company_dir, file } of files) {
    let rec;
    try {
      rec = readRecord(file);
    } catch (e) {
      stats.failed++;
      failures.push({ file: path.relative(ROOT, file), reason: e.message });
      continue;
    }
    if (DRY) {
      const existing = await db.getQwenReportForCompany(rec.company);
      if (existing) stats.unchanged++; else stats.imported++;
      continue;
    }
    try {
      const before = await db.getQwenReportForCompany(rec.company);
      const res = await db.saveQwenReport(rec, 'import');
      if (res.inserted) stats.imported++;
      else if (before && deepEqual(before.report, rec)) stats.unchanged++;
      else stats.updated++;
    } catch (e) {
      stats.failed++;
      failures.push({ file: path.relative(ROOT, file), reason: e.message });
    }
  }

  console.log('── Result ─────────────────────────────────────────');
  console.log(`  imported (new rows)      : ${stats.imported}`);
  console.log(`  updated (changed rows)   : ${stats.updated}`);
  console.log(`  skipped as duplicates    : ${stats.unchanged}`);
  console.log(`  failed                   : ${stats.failed}`);
  if (failures.length) {
    console.log('\n  failures:');
    failures.forEach((f) => console.log(`    ${f.file}: ${f.reason}`));
  }

  if (!DRY) {
    const rows = await db.listQwenReports();
    const inDb = new Set(rows.map((r) => r.companyName));
    console.log(`\n  rows now in account_research_qwen_reports : ${rows.length}`);
    console.log(`  distinct companies in database            : ${inDb.size}`);
    const missing = [...companies].filter((c) => ![...inDb].some(
      (n) => n.replace(/[^a-z0-9]/gi, '').toLowerCase() === c.replace(/[^a-z0-9]/gi, '').toLowerCase()));
    if (missing.length) console.log(`  company folders with no row               : ${missing.join(', ')}`);
  }

  /* Read three back out of the database and compare them to the files on disk.
     An import that reports success but stored something unreadable is worse
     than one that fails loudly. */
  if (!DRY) {
    console.log('\n── Verification (read back from Neon) ─────────────');
    const samples = files.slice(0, 3);
    for (const s of samples) {
      const disk = readRecord(s.file);
      const got = await db.getQwenReportForCompany(disk.company);
      if (!got) { console.log(`  ✗ ${disk.company}: not found in database`); continue; }
      const r = got.report;
      const ok = deepEqual(r, disk);
      const langs = ['English:', '中文'].filter((m) => String(r.research_result || '').includes(m));
      console.log(`  ${ok ? '✓' : '✗'} ${disk.company}`);
      console.log(`      model=${r.model} sources=${(r.sources || []).length}`
        + ` chars=${String(r.research_result || '').length}`
        + ` tokens=${(r.token_usage || {}).total ?? '—'}`
        + ` bilingual=${langs.length === 2 ? 'yes' : 'NO'}`
        + ` contacts=${(r.decision_makers || []).length}`);
    }
  }

  console.log('\nLocal files were not modified or deleted.');
  await db.pool.end();
  process.exit(stats.failed ? 1 : 0);
})().catch((e) => { console.error('Import failed:', e.message); process.exit(1); });
