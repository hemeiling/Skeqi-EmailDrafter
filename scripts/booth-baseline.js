#!/usr/bin/env node
/**
 * A read-only baseline, taken immediately before or after a booth import.
 *
 *   node scripts/booth-baseline.js
 *
 * Two jobs. Before an import it records what the database looked like, so
 * "nothing else changed" is a comparison rather than an assurance. After one it
 * is the independent check — it reads the tables directly instead of trusting
 * the importer's own summary, because a script reporting on its own work is
 * the one witness you cannot use.
 *
 * Counts and classifications only: no company names, no contacts, no email
 * bodies. A baseline that has to be handled carefully is one nobody takes.
 */
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const boothImport = require('../boothImport');

const LOCAL = /localhost|127\.0\.0\.1|::1/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: LOCAL ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 15000,
});
pool.on('error', (e) => console.error(`  [db] idle client error: ${e.message}`));

const n = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows[0].n; } catch (e) {
    return e.code === '42P01' ? '(table absent)' : `(err ${e.code})`;
  }
};
const row = (label, value) => console.log(`    ${label.padEnd(30)}${String(value).padStart(9)}`);

async function main() {
  const u = new URL(process.env.DATABASE_URL);
  console.log(`\n  target : ${u.hostname}${u.pathname}${LOCAL ? '' : '   ** REMOTE **'}`);
  console.log(`  taken  : ${new Date().toISOString()}   (READ-ONLY)\n`);

  // ── the source, hashed independently of the importer's own bookkeeping ──
  const raw = fs.readFileSync(boothImport.SOURCE_PATH);
  const fileSha = crypto.createHash('sha256').update(raw).digest('hex');
  const src = boothImport.readSource();
  const overlayTotal = Object.values(src.overlays).reduce((a, b) => a + b.length, 0);

  console.log('  source');
  row('file sha256 (first 16)', fileSha.slice(0, 16));
  row('parsed data version', src.source_version);
  row('booths parsed', src.booths.length);
  row('overlay records parsed', overlayTotal);
  for (const o of boothImport.OVERLAYS) row(`  ${o.kind}`, src.overlays[o.kind].length);

  // ── the event this import is scoped to ─────────────────────────────────
  console.log('\n  events');
  const { rows: events } = await pool.query('select id, name from events order by id');
  for (const e of events) {
    const mark = e.name === boothImport.EVENT_NAME ? '  <- import target' : '';
    console.log(`    #${String(e.id).padEnd(4)}${e.name}${mark}`);
  }

  // ── booth tables ───────────────────────────────────────────────────────
  console.log('\n  booth tables');
  row('booth_map_booths', await n('select count(*)::int n from booth_map_booths'));
  row('  live (not retired)', await n('select count(*)::int n from booth_map_booths where retired_at is null'));
  row('  matched to a company', await n("select count(*)::int n from booth_map_booths where retired_at is null and company_id is not null"));
  row('  unmatched', await n("select count(*)::int n from booth_map_booths where retired_at is null and match_confidence = 'unmatched'"));
  row('  ambiguous', await n("select count(*)::int n from booth_map_booths where retired_at is null and match_confidence = 'ambiguous'"));
  row('  free space', await n("select count(*)::int n from booth_map_booths where retired_at is null and match_confidence = 'not_a_company'"));
  row('booth_intel', await n('select count(*)::int n from booth_intel'));
  row('  live', await n('select count(*)::int n from booth_intel where retired_at is null'));
  row('booth_import_runs', await n('select count(*)::int n from booth_import_runs'));

  // ── everything the import must NOT touch ───────────────────────────────
  console.log('\n  CRM core (must be unchanged by any import)');
  for (const t of ['companies', 'contacts', 'accounts', 'communications',
    'account_reports', 'research_sources', 'company_tags', 'email_drafts', 'events']) {
    row(t, await n(`select count(*)::int n from "${t}"`));
  }

  await pool.end();
  console.log();
}

main().catch(async (e) => {
  console.error(`\n  baseline failed: ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
