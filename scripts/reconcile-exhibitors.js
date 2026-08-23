#!/usr/bin/env node
/**
 * Resolves exhibitors the sync could not link to a CRM company.
 *
 *   node scripts/reconcile-exhibitors.js --dry-run
 *   node scripts/reconcile-exhibitors.js
 *
 * Rerunnable: an exhibitor already linked is not reconsidered, so a second run
 * finds only what a second run should find.
 *
 * Companies are created through the same upsertCompany the rest of the CRM
 * uses — not a bespoke INSERT — so provenance, name_key and account handling
 * behave exactly as they do everywhere else, and a company that turns out to
 * exist under a different spelling is matched rather than duplicated.
 */
require('dotenv').config({ quiet: true });
const dbApi = require('../db');
const reconcile = require('../exhibitorReconcile');

const DRY = process.argv.includes('--dry-run');
const pool = dbApi.pool;

function describeTarget() {
  try {
    const u = new URL(process.env.DATABASE_URL);
    const local = /^(localhost|127\.0\.0\.1|::1)$/.test(u.hostname);
    return `${u.hostname}${u.pathname}${local ? '' : '   ** REMOTE **'}`;
  } catch { return 'unparseable or unset DATABASE_URL'; }
}

async function main() {
  console.log(`\n  target : ${describeTarget()}`);
  console.log(`  mode   : ${DRY ? 'DRY RUN — nothing will be written' : 'APPLY'}\n`);

  const client = await pool.connect();
  let released = false;
  const release = () => { if (!released) { released = true; client.release(); } };

  try {
    const plan = await reconcile.planReconcile(client);
    const by = { link_existing: [], create_new: [], review: [] };
    for (const p of plan) by[p.outcome].push(p);

    console.log(`  ${plan.length} exhibitors with no CRM link\n`);
    console.log(`    link to an existing company   ${String(by.link_existing.length).padStart(4)}`);
    console.log(`    create a new company          ${String(by.create_new.length).padStart(4)}`);
    console.log(`    needs human review            ${String(by.review.length).padStart(4)}`);

    const show = (label, rows, fmt) => {
      if (!rows.length) return;
      console.log(`\n  ${label}`);
      for (const r of rows) console.log(`    ${fmt(r)}`);
    };
    show('link_existing', by.link_existing,
      (r) => `→ ${r.exhibitor.source_name.slice(0, 44).padEnd(46)} company ${String(r.company_id).padEnd(6)} ${r.reason}`);
    show('review', by.review,
      (r) => `? ${r.exhibitor.source_name.slice(0, 44).padEnd(46)} ${r.reason}`);
    show('create_new', by.create_new,
      (r) => `+ ${r.exhibitor.source_name}`);

    if (DRY) {
      console.log('\n  ── what an APPLY would write ──');
      console.log(`    companies         INSERT ${by.create_new.length} (via upsertCompany)`);
      console.log(`    event_exhibitors  UPDATE company_id on ${by.link_existing.length + by.create_new.length} rows`);
      console.log(`    review left for a human: ${by.review.length}`);
      console.log('\n  DRY RUN — nothing was written.\n');
      return;
    }

    let linked = 0;
    let created = 0;
    let reused = 0;

    for (const r of by.link_existing) {
      await client.query('update event_exhibitors set company_id = $2 where id = $1',
        [r.exhibitor.id, r.company_id]);
      linked++;
    }

    for (const r of by.create_new) {
      /* The shared creation path. It resolves an existing row by normalized
         name if there is one, which is the belt-and-braces against creating a
         duplicate: even if the evidence pass missed something, upsertCompany
         will not make a second row for a company already present. */
      const company = await dbApi.upsertCompany({
        name: r.exhibitor.source_name,
        source: 'exhibitor_import',
        sourceFile: 'mapyourshow:battery-show-na-2026',
      });
      if (!company) {
        // upsertCompany refuses names that are not companies at all. If it
        // declines one, that is its judgement and this defers to it.
        console.log(`    (declined by upsertCompany: "${r.exhibitor.source_name}")`);
        continue;
      }
      /* `updated` is upsertCompany's own answer to "did this already exist",
         which is a better duplicate check than counting rows: it is the same
         normalized-name resolution every other ingestion path relies on. */
      if (company.updated) reused++; else created++;

      const companyId = company.id;
      if (companyId) {
        await client.query('update event_exhibitors set company_id = $2 where id = $1',
          [r.exhibitor.id, companyId]);
      }
    }

    console.log(`\n  Applied: ${linked} linked, ${created} companies created`
      + (reused ? `, ${reused} resolved to an existing company by upsertCompany` : '')
      + `, ${by.review.length} left for review.\n`);
  } finally {
    release();
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(`\n  Reconcile failed: ${e.message}\n`);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
