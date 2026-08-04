#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   cleanup-test-data.js — remove fixture rows left behind in the live CRM.

   DELIBERATELY SEPARATE FROM THE TEST SUITE.

   The suites in test/ run against the real DATABASE_URL and clean up their
   own rows in an `after` hook, scoped to the run id they generated. That is
   the only deletion automated tests are allowed to do. This script exists
   because a suite that crashed, or one that predates a teardown fix, can
   still leave rows behind — and reaching for those requires a pattern match
   across the whole table, which is precisely the operation no automated run
   should ever perform against production data.

   So it is invoked by hand, it is never imported by anything, and it is not
   referenced by `npm test`.

   Usage:
     node scripts/cleanup-test-data.js              # dry run — reports only
     node scripts/cleanup-test-data.js --confirm    # actually deletes

   Every candidate must pass every safety check below. A row that fails even
   one is skipped and reported, never deleted "because it looked like the
   others".
   ═══════════════════════════════════════════════════════════════════════ */

require('dotenv').config();
const db = require('../db');

const CONFIRM = process.argv.includes('--confirm');

/* The prefixes the suites use. Anything outside them is not a candidate,
   full stop — this script never matches on "looks like test data". */
const NAME_PREFIXES = ['ZZTEST\\_', 'ZZGRID ', 'ZZGrid', 'ZZOther', 'ZZChain', 'ZZDemo', 'ZZAudit'];
const LIKE_CLAUSE = (col) => NAME_PREFIXES.map((p, i) => `${col} LIKE '${p}%'`).join(' OR ');

/* Addresses that can only be fictional. RFC 2606 reserves example.com for
   documentation and testing, so a fixture using it cannot collide with a
   real prospect. A "test" contact holding a real address is not a test
   contact as far as this script is concerned. */
const isFixtureEmail = (e) => {
  const v = String(e || '').trim().toLowerCase();
  return v === '' || v.endsWith('@example.com') || v.endsWith('@example.org') || v.endsWith('@example.net');
};

const line = (s = '') => console.log(s);
const bullet = (s) => console.log('   ' + s);

async function main() {
  line(CONFIRM ? '=== CLEANUP (deleting) ===' : '=== DRY RUN — nothing will be deleted ===');
  line('Pass --confirm to apply. Matching prefixes: ' + NAME_PREFIXES.join(', '));
  line();

  /* ── Contacts ──────────────────────────────────────────────────── */
  const contacts = await db.pool.query(
    `SELECT c.id, c.full_name, c.email, c.company, c.company_id, c.draft_body, c.notes,
            co.name AS company_name
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
     WHERE ${LIKE_CLAUSE('c.full_name')} ORDER BY c.id`);

  const keepContacts = [];
  const dropContacts = [];
  for (const c of contacts.rows) {
    const reasons = [];
    if (!isFixtureEmail(c.email)) reasons.push(`real-looking email ${c.email}`);
    // A fixture linked to a company that is NOT a fixture would mean a test
    // attached itself to production data; refuse rather than guess.
    if (c.company_id && c.company_name && !NAME_PREFIXES.some((p) => c.company_name.startsWith(p.replace('\\', ''))))
      reasons.push(`linked to non-test company "${c.company_name}"`);
    // Anything actually sent is real activity, whatever the row is called.
    const sent = await db.pool.query(
      `SELECT count(*)::int n FROM communications
       WHERE contact_id = $1 AND (sent_at IS NOT NULL OR delivery_status = 'sent')`, [c.id]);
    if (sent.rows[0].n) reasons.push(`${sent.rows[0].n} sent email(s)`);
    const hist = await db.pool.query(`SELECT count(*)::int n FROM email_history WHERE contact_id = $1`, [c.id]);
    if (hist.rows[0].n) reasons.push(`${hist.rows[0].n} email history row(s)`);

    (reasons.length ? keepContacts : dropContacts).push({ ...c, reasons });
  }

  line(`Contacts matching a test prefix: ${contacts.rows.length}`);
  if (keepContacts.length) {
    line(`  SKIPPED (failed a safety check): ${keepContacts.length}`);
    keepContacts.forEach((c) => bullet(`#${c.id} ${c.full_name} — ${c.reasons.join('; ')}`));
  }
  line(`  To delete: ${dropContacts.length}`);
  dropContacts.forEach((c) => bullet(`#${c.id} ${c.full_name} <${c.email || 'no email'}>`));
  line();

  const contactIds = dropContacts.map((c) => c.id);

  /* Rows that deleteContacts() does not remove and the schema would orphan.
     communications.contact_id and email_history.contact_id are ON DELETE SET
     NULL, so deleting a contact leaves those rows behind pointing at nobody.
     That is arguably right for real history — a sent email should outlive the
     record it was sent to — but for fixtures it is just litter, so they are
     removed explicitly here rather than by weakening the production path. */
  let orphanable = { communications: 0, email_history: 0, contact_tags: 0 };
  if (contactIds.length) {
    for (const t of ['communications', 'email_history', 'contact_tags']) {
      const r = await db.pool.query(
        `SELECT count(*)::int n FROM ${t} WHERE contact_id = ANY($1::int[])`, [contactIds]);
      orphanable[t] = r.rows[0].n;
    }
    line('Rows attached to those contacts that would otherwise orphan:');
    Object.entries(orphanable).forEach(([t, n]) => bullet(`${t}: ${n}`));
    line();
  }

  /* ── Companies ─────────────────────────────────────────────────── */
  const companies = await db.pool.query(
    `SELECT id, name, account_id, ai_research_summary FROM companies
     WHERE ${LIKE_CLAUSE('name')} ORDER BY id`);

  const keepCos = [];
  const dropCos = [];
  for (const co of companies.rows) {
    const reasons = [];
    // Contacts that are NOT being deleted in this run still need this company.
    const remaining = await db.pool.query(
      `SELECT count(*)::int n FROM contacts WHERE company_id = $1 AND NOT (id = ANY($2::int[]))`,
      [co.id, contactIds.length ? contactIds : [0]]);
    if (remaining.rows[0].n) reasons.push(`${remaining.rows[0].n} non-test contact(s) still attached`);
    if (co.ai_research_summary) reasons.push('has an AI research summary');
    const reports = await db.pool.query(`SELECT count(*)::int n FROM account_reports WHERE company_id = $1`, [co.id]);
    if (reports.rows[0].n) reasons.push(`${reports.rows[0].n} account report(s)`);
    (reasons.length ? keepCos : dropCos).push({ ...co, reasons });
  }

  line(`Companies matching a test prefix: ${companies.rows.length}`);
  if (keepCos.length) {
    line(`  SKIPPED: ${keepCos.length}`);
    keepCos.forEach((c) => bullet(`#${c.id} ${c.name} — ${c.reasons.join('; ')}`));
  }
  line(`  To delete: ${dropCos.length}`);
  dropCos.forEach((c) => bullet(`#${c.id} ${c.name}`));
  line();

  const companyIds = dropCos.map((c) => c.id);

  /* ── Accounts ──────────────────────────────────────────────────── */
  const accounts = await db.pool.query(
    `SELECT id, name FROM accounts WHERE ${LIKE_CLAUSE('name')} ORDER BY id`);
  const keepAccts = [];
  const dropAccts = [];
  for (const a of accounts.rows) {
    const remaining = await db.pool.query(
      `SELECT count(*)::int n FROM companies WHERE account_id = $1 AND NOT (id = ANY($2::int[]))`,
      [a.id, companyIds.length ? companyIds : [0]]);
    if (remaining.rows[0].n) keepAccts.push({ ...a, reasons: [`${remaining.rows[0].n} company/companies still attached`] });
    else dropAccts.push(a);
  }
  line(`Accounts matching a test prefix: ${accounts.rows.length}`);
  if (keepAccts.length) {
    line(`  SKIPPED: ${keepAccts.length}`);
    keepAccts.forEach((a) => bullet(`#${a.id} ${a.name} — ${a.reasons.join('; ')}`));
  }
  line(`  To delete: ${dropAccts.length}`);
  dropAccts.forEach((a) => bullet(`#${a.id} ${a.name}`));
  line();

  if (!CONFIRM) {
    line('Dry run complete. Re-run with --confirm to apply.');
    await db.pool.end();
    return;
  }

  /* ── Apply, in foreign-key-safe order, in one transaction ──────── */
  const client = await db.pool.connect();
  const removed = {};
  try {
    await client.query('BEGIN');

    if (contactIds.length) {
      // First the rows the production path would orphan…
      for (const t of ['communications', 'email_history', 'contact_tags']) {
        const r = await client.query(`DELETE FROM ${t} WHERE contact_id = ANY($1::int[])`, [contactIds]);
        removed[t] = r.rowCount;
      }
      // …then the same tables deleteContacts() clears, in its order.
      for (const t of ['contact_activity', 'business_cards', 'email_drafts', 'apollo_results']) {
        const r = await client.query(`DELETE FROM ${t} WHERE contact_id = ANY($1::int[])`, [contactIds]);
        removed[t] = r.rowCount;
      }
      const r = await client.query(`DELETE FROM contacts WHERE id = ANY($1::int[])`, [contactIds]);
      removed.contacts = r.rowCount;
    }

    if (companyIds.length) {
      for (const t of ['company_activity', 'company_tags', 'company_recommendations', 'research_sources']) {
        const r = await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::int[])`, [companyIds]);
        removed[t] = r.rowCount;
      }
      // NO ACTION / SET NULL references must be cleared by hand.
      await client.query(`DELETE FROM apollo_results WHERE company_id = ANY($1::int[])`, [companyIds]);
      await client.query(`UPDATE communications SET company_id = NULL WHERE company_id = ANY($1::int[])`, [companyIds]);
      await client.query(`UPDATE email_history SET company_id = NULL WHERE company_id = ANY($1::int[])`, [companyIds]);
      await client.query(`UPDATE account_reports SET company_id = NULL WHERE company_id = ANY($1::int[])`, [companyIds]);
      const r = await client.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [companyIds]);
      removed.companies = r.rowCount;
    }

    if (dropAccts.length) {
      const r = await client.query(`DELETE FROM accounts WHERE id = ANY($1::int[])`, [dropAccts.map((a) => a.id)]);
      removed.accounts = r.rowCount;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    line('FAILED — rolled back, nothing was deleted.');
    throw err;
  } finally {
    client.release();
  }

  line('Deleted:');
  Object.entries(removed).filter(([, n]) => n).forEach(([t, n]) => bullet(`${t}: ${n}`));

  /* ── Verify no orphan was created ──────────────────────────────── */
  line();
  line('Post-delete verification:');
  const leftContacts = await db.pool.query(`SELECT count(*)::int n FROM contacts WHERE ${LIKE_CLAUSE('full_name')}`);
  const leftCos = await db.pool.query(`SELECT count(*)::int n FROM companies WHERE ${LIKE_CLAUSE('name')}`);
  const leftAccts = await db.pool.query(`SELECT count(*)::int n FROM accounts WHERE ${LIKE_CLAUSE('name')}`);
  bullet(`test contacts remaining: ${leftContacts.rows[0].n}`);
  bullet(`test companies remaining: ${leftCos.rows[0].n}`);
  bullet(`test accounts remaining: ${leftAccts.rows[0].n}`);
  const dangling = await db.pool.query(
    `SELECT count(*)::int n FROM contacts c WHERE c.company_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = c.company_id)`);
  bullet(`contacts pointing at a missing company: ${dangling.rows[0].n}`);
  const danglingCo = await db.pool.query(
    `SELECT count(*)::int n FROM companies co WHERE co.account_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = co.account_id)`);
  bullet(`companies pointing at a missing account: ${danglingCo.rows[0].n}`);

  await db.pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
