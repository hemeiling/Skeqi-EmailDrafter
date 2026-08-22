#!/usr/bin/env node
/**
 * Synchronizes the curated booth map into Postgres.
 *
 *   node scripts/import-booth-map.js --dry-run     # report only, writes nothing
 *   node scripts/import-booth-map.js               # apply, in one transaction
 *   node scripts/import-booth-map.js --verbose     # also list warnings
 *
 * Safe to run repeatedly: rerunning an unedited source changes nothing and says
 * so. Nothing is ever deleted — a booth that disappears upstream is marked
 * retired, because it may already be referenced by an email someone sent.
 *
 * The whole apply runs inside one BEGIN/COMMIT. A failure halfway through
 * leaves the previous state intact, which matters more than it looks: a
 * half-synchronized booth map is worse than a stale one, because it presents
 * itself as current.
 *
 * Prints the database it is about to write to, before writing to it.
 *
 * The logic lives in ../boothImport.js so it can be tested against a real
 * database without a process or a socket; this file is argument parsing,
 * transaction boundaries and printing.
 */
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const boothImport = require('../boothImport');

const DRY = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const LOCAL = /localhost|127\.0\.0\.1|::1/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: LOCAL ? false : { rejectUnauthorized: false },
  max: 1,
  // Never wait forever for a connection: an unreachable database should fail
  // the import with a message, not leave it hanging with no output.
  connectionTimeoutMillis: 15000,
});

/* An idle client that dies emits 'error' on the pool. With no listener that is
   an unhandled 'error' event, which takes the process down — and it fires
   AFTER the real failure has been reported, so the message an operator needs
   scrolls away behind a stack trace about the connection. db.js already does
   this; the importer's own pool needs it too. */
pool.on('error', (err) => {
  console.error(`  [db] idle client error: ${err.message}`);
});

/** Host and database only — never the credentials in between. */
function describeTarget() {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `${u.hostname}${u.pathname}${LOCAL ? '' : '   ** REMOTE **'}`;
  } catch {
    return 'unparseable or unset DATABASE_URL';
  }
}

const pad = (n) => String(n).padStart(5);

function report(p, src) {
  console.log('\n  booths');
  console.log(`    new         ${pad(p.created.length)}`);
  console.log(`    updated     ${pad(p.updated.length)}`);
  console.log(`    unchanged   ${pad(p.unchanged.length)}`);
  console.log(`    retired     ${pad(p.retired.length)}`);
  console.log('\n  company matching (booths that name a company)');
  console.log(`    matched     ${pad(p.stats.matched)}`);
  console.log(`    unmatched   ${pad(p.stats.unmatched)}`);
  console.log(`    ambiguous   ${pad(p.stats.ambiguous)}`);
  console.log(`    free space  ${pad(p.stats.freeSpace)}   (not a company)`);
  console.log(`\n  intel records ${pad(p.intel.length)}`);
  if (p.warnings.length) console.log(`  warnings      ${pad(p.warnings.length)}`);

  const unmatched = p.rows.filter((r) => r.match_confidence === 'unmatched');
  if (unmatched.length) {
    console.log(`\n  unmatched (${unmatched.length}) — kept verbatim, company_id NULL:`);
    for (const r of unmatched.slice(0, 40)) {
      console.log(`    ${String(r.booth_number).padEnd(8)}${String(r.category || '').padEnd(10)}${r.source_company_name}`);
    }
    if (unmatched.length > 40) console.log(`    … and ${unmatched.length - 40} more`);
  }

  const amb = p.rows.filter((r) => r.match_confidence === 'ambiguous');
  if (amb.length) {
    console.log(`\n  ambiguous (${amb.length}) — deliberately left unresolved:`);
    for (const r of amb) {
      console.log(`    ${String(r.booth_number).padEnd(8)}${r.source_company_name}  → ${r.match_note}`);
    }
  }

  if (VERBOSE && p.warnings.length) {
    console.log('\n  warnings:');
    for (const w of p.warnings.slice(0, 30)) console.log(`    ${JSON.stringify(w)}`);
    if (p.warnings.length > 30) console.log(`    … and ${p.warnings.length - 30} more`);
  }
}

async function main() {
  console.log(`\n  source : ${boothImport.SOURCE_PATH.replace(`${process.cwd()}/`, '')}`);
  console.log(`  target : ${describeTarget()}`);
  console.log(`  mode   : ${DRY ? 'DRY RUN — nothing will be written' : 'APPLY'}`);

  const src = boothImport.readSource();
  const overlayCount = Object.values(src.overlays).reduce((n, a) => n + a.length, 0);
  console.log(`\n  parsed ${src.booths.length} booths and ${overlayCount} overlay records ` +
    `(source version ${src.source_version})`);

  const client = await pool.connect();
  let runId = null;
  let released = false;
  /* The client is returned to the pool by whichever path finishes first. The
     pool holds a single connection, so anything that needs the database after
     a failure must wait until this one is back — see the catch block. */
  const release = () => { if (!released) { released = true; client.release(); } };
  try {
    const eventId = await boothImport.resolveEvent(client);
    const p = await boothImport.plan(client, src, eventId);
    if (!p.tablesReady) {
      console.log('\n  note: booth tables do not exist yet — everything below is a first import.');
    }
    report(p, src);

    if (DRY) {
      console.log('\n  DRY RUN — nothing was written.\n');
      return;
    }

    if (!p.tablesReady) {
      throw new Error('booth tables do not exist. Start the app once so initDb() creates them, then rerun.');
    }

    if (!p.created.length && !p.updated.length && !p.retired.length) {
      console.log('\n  Already synchronized — no booth changes to apply.');
    }

    await client.query('BEGIN');
    const { rows: [run] } = await client.query(
      `insert into booth_import_runs (event_id, source_version, source_path, dry_run, status)
       values ($1,$2,$3,false,'pending') returning id`,
      [eventId, src.source_version, boothImport.SOURCE_PATH]);
    runId = run.id;

    const applied = await boothImport.apply(client, p, eventId, src);

    await client.query(
      `update booth_import_runs set status='success', booths_seen=$2, created=$3, updated=$4,
              unchanged=$5, retired=$6, intel_upserted=$7, matched=$8, unmatched=$9,
              ambiguous=$10, warnings=$11, finished_at=NOW()
        where id = $1`,
      [runId, p.rows.length, p.created.length, p.updated.length, p.unchanged.length,
        p.retired.length, applied.intelUpserted, p.stats.matched, p.stats.unmatched,
        p.stats.ambiguous, p.warnings.length ? JSON.stringify(p.warnings.slice(0, 200)) : null]);

    await client.query('COMMIT');
    console.log(`\n  Applied as run #${runId}: ${p.created.length} new, ${p.updated.length} updated, ` +
      `${p.retired.length} retired, ${applied.intelUpserted} intel upserted` +
      (applied.intelRetired ? `, ${applied.intelRetired} intel retired` : '') + '.\n');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* the connection may already be gone */ }

    /* Release BEFORE recording the failure. The pool holds one connection and
       this client is it, so a pool.query() here would queue behind a client
       that `finally` has not returned yet — node-postgres waits forever by
       default, and the importer hung silently instead of reporting the error
       that caused it. The rollback has already happened, so nothing is at risk
       either way; what was lost was the ability to see what went wrong. */
    release();

    /* The pending run row rolled back with everything else, so the failure is
       recorded as its own statement. An import that fails and leaves no trace
       is exactly what this table exists to prevent. */
    if (!DRY) {
      try {
        await pool.query(
          `insert into booth_import_runs (source_path, dry_run, status, error_message, finished_at)
           values ($1,false,'failed',$2,NOW())`,
          [boothImport.SOURCE_PATH, String(e.message).slice(0, 500)]);
      } catch { /* nothing further to do */ }
    }
    throw e;
  } finally {
    release();
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(`\n  Import failed — nothing was changed: ${e.message}\n`);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
