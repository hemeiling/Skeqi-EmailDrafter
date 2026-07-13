// One-time data-hygiene cleanup for company/account records created before
// the isInvalidCompanyName validation existed (see companyKey.js, db.js).
//
// Dry-run by default -- prints exactly what it would change without touching
// the database. Pass --apply to actually commit. This is deliberately NOT
// run automatically on server startup (unlike the additive backfills in
// initDb()): it can clear a contact's company field, which needs a human
// to review first.
//
// Usage:
//   node scripts/cleanup-invalid-companies.js            # dry run, prints report
//   node scripts/cleanup-invalid-companies.js --apply    # actually commits

require('dotenv').config();
const db = require('../db');
const { isInvalidCompanyName } = require('../companyKey');

const APPLY = process.argv.includes('--apply');

async function main() {
  await db.initDb();

  const report = {
    contactsCleared: [],
    companiesRemoved: [],
    accountsRemoved: [],
    candidateMergeGroups: [],
  };

  // 1. Find invalid company rows (job titles/departments/placeholders that
  //    became a "company" before this validation existed).
  const allCompanies = await db.pool.query('SELECT id, name, account_id FROM companies');
  const invalidCompanies = allCompanies.rows.filter((c) => isInvalidCompanyName(c.name));

  // Tracks, per invalid company, how many of its contacts could NOT be
  // auto-cleared (title/company mismatch) -- used below to decide whether the
  // company is safe to remove. Computed in-memory so the dry-run report
  // accurately previews the end state, rather than re-querying the live DB
  // (which would show nothing cleared yet during a dry run and wrongly imply
  // the company/account won't be removed even after --apply).
  const skippedCountByCompany = new Map();

  for (const company of invalidCompanies) {
    const contacts = await db.pool.query(
      'SELECT id, full_name, job_title, company FROM contacts WHERE company_id = $1',
      [company.id]
    );

    let skipped = 0;
    for (const contact of contacts.rows) {
      const sameAsTitle = (contact.job_title || '').trim().toLowerCase() === (contact.company || '').trim().toLowerCase();
      if (!sameAsTitle) {
        skipped++;
        console.log(`SKIP (needs manual review): contact ${contact.id} "${contact.full_name}" has company_id pointing to invalid company "${company.name}" but job_title ("${contact.job_title}") doesn't match -- not auto-clearing.`);
        continue;
      }
      report.contactsCleared.push({
        contactId: contact.id, fullName: contact.full_name,
        clearedValue: contact.company, jobTitle: contact.job_title,
      });
      if (APPLY) {
        await db.pool.query('UPDATE contacts SET company = $1, company_id = NULL WHERE id = $2', ['', contact.id]);
      }
    }
    skippedCountByCompany.set(company.id, skipped);
  }

  // 2. Remove invalid company rows once nothing references them (a company
  //    is safe to remove once every one of its contacts was either cleared
  //    above or never existed -- i.e. zero skipped-for-review contacts).
  for (const company of invalidCompanies) {
    const skipped = skippedCountByCompany.get(company.id) || 0;
    if (skipped === 0) {
      report.companiesRemoved.push({ id: company.id, name: company.name });
      if (APPLY) await db.pool.query('DELETE FROM companies WHERE id = $1', [company.id]);
    } else {
      console.log(`SKIP removing company "${company.name}" (id ${company.id}): ${skipped} contact(s) above need manual review first.`);
    }
  }

  // 3. Remove invalid account rows once every company under them is also
  //    being removed above (same in-memory reasoning as step 2).
  const removedCompanyIds = new Set(report.companiesRemoved.map((c) => c.id));
  const allAccounts = await db.pool.query('SELECT id, name FROM accounts');
  const invalidAccounts = allAccounts.rows.filter((a) => isInvalidCompanyName(a.name));
  for (const account of invalidAccounts) {
    const companiesUnder = await db.pool.query('SELECT id FROM companies WHERE account_id = $1', [account.id]);
    const remaining = companiesUnder.rows.filter((c) => !removedCompanyIds.has(c.id));
    if (remaining.length === 0) {
      report.accountsRemoved.push({ id: account.id, name: account.name });
      if (APPLY) await db.pool.query('DELETE FROM accounts WHERE id = $1', [account.id]);
    } else {
      console.log(`SKIP removing account "${account.name}" (id ${account.id}): still has ${remaining.length} compan(y/ies) under it.`);
    }
  }

  // 4. Report (never auto-merge) candidate groups of accounts that share a
  //    leading word -- e.g. "CATL"/"CATL Debrecen", or the Ford-family
  //    accounts -- for you to review and merge deliberately via the new
  //    "Merge Selected" tool in Quick Browse.
  const remainingAccounts = await db.pool.query('SELECT id, name FROM accounts ORDER BY name');
  const byFirstWord = new Map();
  for (const acc of remainingAccounts.rows) {
    const firstWord = (acc.name || '').trim().split(/\s+/)[0]?.toLowerCase();
    if (!firstWord) continue;
    if (!byFirstWord.has(firstWord)) byFirstWord.set(firstWord, []);
    byFirstWord.get(firstWord).push(acc);
  }
  for (const [word, accs] of byFirstWord) {
    if (accs.length >= 2) {
      report.candidateMergeGroups.push({ sharedLeadingWord: word, accounts: accs.map((a) => `${a.name} (id ${a.id})`) });
    }
  }

  // ── Print report ──────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(70)}`);
  console.log(APPLY ? 'APPLIED CHANGES' : 'DRY RUN -- no changes made (pass --apply to commit)');
  console.log('='.repeat(70));

  console.log(`\nContacts with company field cleared (${report.contactsCleared.length}):`);
  report.contactsCleared.forEach((c) =>
    console.log(`  contact ${c.contactId} "${c.fullName}": company "${c.clearedValue}" -> "" (job_title "${c.jobTitle}" unchanged)`));

  console.log(`\nInvalid company records removed (${report.companiesRemoved.length}):`);
  report.companiesRemoved.forEach((c) => console.log(`  id ${c.id}: "${c.name}"`));

  console.log(`\nInvalid account records removed (${report.accountsRemoved.length}):`);
  report.accountsRemoved.forEach((a) => console.log(`  id ${a.id}: "${a.name}"`));

  console.log(`\nCandidate account groups worth reviewing for a manual merge (${report.candidateMergeGroups.length}):`);
  report.candidateMergeGroups.forEach((g) =>
    console.log(`  share leading word "${g.sharedLeadingWord}": ${g.accounts.join(', ')}`));

  console.log(`\n${'='.repeat(70)}`);
  if (!APPLY) console.log('This was a dry run. Re-run with --apply to commit these changes.');
  console.log('='.repeat(70) + '\n');

  await db.pool.end();
}

main().catch((err) => {
  console.error('Cleanup script failed:', err);
  process.exit(1);
});
