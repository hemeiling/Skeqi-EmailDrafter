#!/usr/bin/env node
/**
 * Refreshes event attendance and booth assignment from the authoritative
 * event source.
 *
 *   node scripts/sync-exhibitors.js --dry-run     # report only, writes nothing
 *   node scripts/sync-exhibitors.js               # apply, in one transaction
 *   node scripts/sync-exhibitors.js --verbose     # also list every change
 *
 * Rerunnable. Nothing is deleted: an exhibitor absent from the latest pull is
 * retired with a timestamp, and its booths with it.
 *
 * Needs MYS_COOKIE — a browser session credential that expires. When it has,
 * the source answers with an HTML login page under HTTP 200, which parses as
 * "no exhibitors". That is why the fetch refuses non-JSON, and why the planner
 * refuses a suspiciously small result instead of retiring the whole show.
 *
 * Prints the database it is about to write to, before writing to it.
 */
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const sync = require('../exhibitorSync');

const DRY = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const LOCAL = /localhost|127\.0\.0\.1|::1/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: LOCAL ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 15000,
});
pool.on('error', (e) => console.error(`  [db] idle client error: ${e.message}`));

function describeTarget() {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `${u.hostname}${u.pathname}${LOCAL ? '' : '   ** REMOTE **'}`;
  } catch { return 'unparseable or unset DATABASE_URL'; }
}

const pad = (n) => String(n).padStart(5);

async function main() {
  console.log(`\n  source : ${sync.HOST}  (MapYourShow, official)`);
  console.log(`  target : ${describeTarget()}`);
  console.log(`  mode   : ${DRY ? 'DRY RUN — nothing will be written' : 'APPLY'}\n`);

  if (!process.env.MYS_COOKIE) {
    throw new Error('MYS_COOKIE is not set. Without it the source returns a login page, '
      + 'which parses as an empty exhibitor list.');
  }

  const exhibitors = await sync.fetchExhibitors({
    cookie: process.env.MYS_COOKIE,
    onProgress: (n, total) => process.stdout.write(`\r  fetching ${n}/${total}`),
  });
  process.stdout.write('\n');

  const version = sync.sourceVersion(exhibitors);
  const withBooth = exhibitors.filter((e) => e.booths.length);
  console.log(`  fetched ${exhibitors.length} exhibitors (source version ${version})`);
  console.log(`    with a booth assignment   ${pad(withBooth.length)}`);
  console.log(`    attending, no booth yet   ${pad(exhibitors.length - withBooth.length)}`);
  for (const e of exhibitors.filter((x) => !x.booths.length)) {
    console.log(`      → "${e.source_name}" (exhid ${e.exhibitor_source_id})`);
  }

  const client = await pool.connect();
  let released = false;
  const release = () => { if (!released) { released = true; client.release(); } };
  let runId = null;

  try {
    const eventId = await sync.resolveEvent(client);
    const p = await sync.plan(client, exhibitors, eventId);

    if (p.refuse) {
      /* The guard that matters. An expired cookie produces a small or empty
         list that is otherwise indistinguishable from real withdrawals. */
      console.error(`\n  REFUSED: ${p.refuse}\n`);
      if (!DRY) {
        await pool.query(
          `insert into exhibitor_import_runs (event_id, source, dry_run, status, fetched, error_message, finished_at)
           values ($1,$2,false,'aborted',$3,$4,NOW())`,
          [eventId, sync.SOURCE, p.liveCount, p.refuse.slice(0, 400)]);
      }
      process.exitCode = 1;
      return;
    }

    if (!p.tablesReady) {
      console.log('\n  note: exhibitor tables do not exist yet — this is a first import.');
    }
    const flags = await sync.planIntelReview(client, exhibitors, eventId);

    console.log('\n  exhibitors');
    console.log(`    new                       ${pad(p.created.length)}`);
    console.log(`    updated                   ${pad(p.updated.length)}`);
    console.log(`    unchanged                 ${pad(p.unchanged.length)}`);
    console.log(`    revived (were retired)    ${pad(p.revived.length)}`);
    console.log(`    RETIRED (gone from list)  ${pad(p.retired.length)}`);
    console.log('\n  CRM matching');
    console.log(`    confident                 ${pad(p.stats.matched)}`);
    console.log(`    unmatched                 ${pad(p.stats.unmatched)}`);
    console.log(`    ambiguous                 ${pad(p.stats.ambiguous)}`);
    console.log(`\n  classifications needing human review ${pad(flags.length)}`);

    if (VERBOSE || DRY) {
      const show = (label, rows, fmt) => {
        if (!rows.length) return;
        console.log(`\n  ${label} (${rows.length})`);
        for (const r of rows.slice(0, 12)) console.log(`    ${fmt(r)}`);
        if (rows.length > 12) console.log(`    … and ${rows.length - 12} more`);
      };
      show('new exhibitors', p.created,
        (r) => `+ ${r.source_name.slice(0, 46).padEnd(48)} booth ${r.booths.join(',') || '(none)'}`);
      show('retired — no longer in the official list', p.retired,
        (r) => `- ${String(r.source_name).slice(0, 46).padEnd(48)} exhid ${r.exhibitor_source_id}`);
      show('renamed (same exhid, new name)', p.updated.filter((u) => u.prev.source_name !== u.row.source_name),
        (u) => `~ "${u.prev.source_name}" → "${u.row.source_name}"`);
      show('classifications flagged for review', flags,
        (f) => `! ${f.kind.padEnd(20)} ${f.review_reason.slice(0, 96)}`);
    }

    if (DRY) {
      console.log('\n  ── what an APPLY would write ──');
      console.log(`    event_exhibitors    INSERT ${p.created.length}, UPDATE ${p.updated.length + p.unchanged.length + p.revived.length}, RETIRE ${p.retired.length}`);
      console.log(`    exhibitor_booths    upsert for every listed exhibitor's booths; unseen ones retired`);
      console.log(`    booth_map_booths    UPDATE exhibitor_id / occupant_status / live_occupant_name`);
      console.log(`    booth_intel         UPDATE ${flags.length} → review_status='needs_review' (never reassigned)`);
      console.log(`    exhibitor_import_runs INSERT 1`);
      console.log('\n  DRY RUN — nothing was written.\n');
      return;
    }

    if (!p.tablesReady) {
      throw new Error('exhibitor tables do not exist. Start the app once so initDb() creates them, then rerun.');
    }

    await client.query('BEGIN');
    const { rows: [run] } = await client.query(
      `insert into exhibitor_import_runs (event_id, source, source_version, dry_run, status, fetched)
       values ($1,$2,$3,false,'pending',$4) returning id`,
      [eventId, sync.SOURCE, version, exhibitors.length]);
    runId = run.id;

    const applied = await sync.apply(client, p, eventId, version, flags);

    await client.query(
      `update exhibitor_import_runs set status='success', created=$2, updated=$3, unchanged=$4,
              retired=$5, revived=$6, booths_added=$7, booths_retired=$8,
              matched=$9, unmatched=$10, ambiguous=$11, intel_flagged=$12, finished_at=NOW()
        where id=$1`,
      [runId, p.created.length, p.updated.length, p.unchanged.length, p.retired.length,
        p.revived.length, applied.boothsAdded, applied.boothsRetired,
        p.stats.matched, p.stats.unmatched, p.stats.ambiguous, applied.flagged]);

    await client.query('COMMIT');
    console.log(`\n  Applied as run #${runId}: ${p.created.length} new, ${p.retired.length} retired, `
      + `${applied.boothsAdded} booth rows, ${applied.flagged} classifications flagged.`);
    console.log(`  booth occupancy — current ${applied.occupancy.current}, `
      + `reassigned ${applied.occupancy.reassigned}, vacated ${applied.occupancy.vacated}\n`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    release();          // free the single connection before recording the failure
    if (!DRY) {
      try {
        await pool.query(
          `insert into exhibitor_import_runs (source, dry_run, status, error_message, finished_at)
           values ($1,false,'failed',$2,NOW())`, [sync.SOURCE, String(e.message).slice(0, 400)]);
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
    console.error(`\n  Sync failed — nothing was changed: ${e.message}\n`);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
