// Runs against the real DATABASE_URL configured in .env (no separate test DB
// is set up for this project). Every fixture row created here is tagged with
// a random ZZTEST_ prefix and removed in the top-level `after` hook, so
// running this suite repeatedly never leaves stray data behind.
require('dotenv').config(); // db.js reads process.env.DATABASE_URL directly
const test = require('node:test');
const assert = require('node:assert/strict');
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
const { normalizeNameKey } = require('../companyKey');

const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const tag = (label) => `ZZTEST_${label}_${RUN_ID}`;

const createdContactIds = [];
const createdCompanyIds = [];
const createdAccountIds = [];

async function makeContact(fields) {
  const id = await db.insertContact(fields);
  createdContactIds.push(id);
  return id;
}

test.before(async () => {
  await db.initDb();
});

test.after(async () => {
  if (createdContactIds.length) {
    // Use deleteContacts (not a raw DELETE) -- it already clears
    // contact_activity/business_cards/email_drafts/apollo_results first,
    // which a plain `DELETE FROM contacts` would violate FK constraints on.
    await db.deleteContacts(createdContactIds);
  }
  if (createdCompanyIds.length) {
    await db.pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [createdCompanyIds]);
  }
  if (createdAccountIds.length) {
    await db.pool.query(`DELETE FROM accounts WHERE id = ANY($1::int[])`, [createdAccountIds]);
  }
  await db.pool.end();
});

test('deleteContacts removes a single selected contact', async () => {
  const email = `${tag('single')}@example.com`.toLowerCase();
  const id = await makeContact({ full_name: tag('Single Delete'), email });

  const deleted = await db.deleteContacts([id]);
  assert.equal(deleted, 1);

  const row = await db.getContact(id);
  assert.equal(row, null);
  createdContactIds.splice(createdContactIds.indexOf(id), 1); // already gone
});

test('deleteContacts removes a contact that has logged activity/drafts (FK cleanup regression)', async () => {
  const id = await makeContact({ full_name: tag('Has Activity'), email: `${tag('hasactivity')}@example.com` });
  await db.logContactActivity(id, 'manual_create', 'created for FK cleanup test');
  await db.insertEmailDraftVersion(id, { subject: 'hi', body: 'hi', followup: '', rationale: '' });

  const deleted = await db.deleteContacts([id]);
  assert.equal(deleted, 1);
  assert.equal(await db.getContact(id), null);
  createdContactIds.splice(createdContactIds.indexOf(id), 1); // already gone
});

test('deleteContacts removes multiple selected contacts', async () => {
  const id1 = await makeContact({ full_name: tag('Multi Delete A'), email: `${tag('multia')}@example.com` });
  const id2 = await makeContact({ full_name: tag('Multi Delete B'), email: `${tag('multib')}@example.com` });

  const deleted = await db.deleteContacts([id1, id2]);
  assert.equal(deleted, 2);

  assert.equal(await db.getContact(id1), null);
  assert.equal(await db.getContact(id2), null);
  [id1, id2].forEach((id) => createdContactIds.splice(createdContactIds.indexOf(id), 1));
});

test('deleteContacts is a no-op when nothing is selected (mirrors the bulk-delete route guard)', async () => {
  const before = await db.pool.query('SELECT COUNT(*)::int AS n FROM contacts');
  const deleted = await db.deleteContacts([]);
  assert.equal(deleted, 0);
  const after = await db.pool.query('SELECT COUNT(*)::int AS n FROM contacts');
  assert.equal(before.rows[0].n, after.rows[0].n);
});

test('getOrCreateAccount persists across repeated lookups (no duplicate on "refresh")', async () => {
  const name = tag('Ford');
  const first = await db.getOrCreateAccount(name);
  createdAccountIds.push(first.id);
  const second = await db.getOrCreateAccount(name);
  assert.equal(second.id, first.id);

  const rows = await db.pool.query('SELECT COUNT(*)::int AS n FROM accounts WHERE LOWER(name) = LOWER($1)', [name]);
  assert.equal(rows.rows[0].n, 1);
});

test('upsertCompany merges punctuation-only name variants via name_key (EVE Energy example)', async () => {
  const base = tag('EVE');
  const variantA = `${base} Energy Co.,Ltd.`;
  const variantB = `${base} Energy Co., Ltd.`;

  const resultA = await db.upsertCompany({ name: variantA });
  createdCompanyIds.push(resultA.id);
  createdAccountIds.push((await db.getCompany(resultA.id)).account_id);

  const resultB = await db.upsertCompany({ name: variantB });

  assert.equal(resultB.id, resultA.id, 'both punctuation variants should resolve to the same company row');
  assert.equal(resultB.updated, true);

  const row = await db.getCompany(resultA.id);
  assert.equal(normalizeNameKey(variantA), normalizeNameKey(variantB));
  assert.equal(row.name_key, normalizeNameKey(variantA));
});

test('Ford / Ford Motor Company / Ford Energy roll up under one Account', async () => {
  const accountName = tag('Ford2');
  const account = await db.getOrCreateAccount(accountName);
  createdAccountIds.push(account.id);

  const motorCo = await db.upsertCompany({ name: `${accountName} Motor Company`, account_name: accountName });
  const energyCo = await db.upsertCompany({ name: `${accountName} Energy`, account_name: accountName });
  createdCompanyIds.push(motorCo.id, energyCo.id);

  const c1 = await makeContact({ full_name: tag('Ford Contact 1'), email: `${tag('fordc1')}@example.com`, company_id: motorCo.id, company: `${accountName} Motor Company` });
  const c2 = await makeContact({ full_name: tag('Ford Contact 2'), email: `${tag('fordc2')}@example.com`, company_id: energyCo.id, company: `${accountName} Energy` });

  const groups = await db.listAccountGroups({ onlyWithContacts: true });
  const fordGroup = groups.find((g) => g.name === accountName);
  assert.ok(fordGroup, 'Account should appear in listAccountGroups');
  assert.equal(fordGroup.contact_count, 2, 'contacts from both child companies should be aggregated under one Account');

  // Also exercise the CRM filter path (Browse-by-Company selector, single selection)
  const filtered = await db.filterContacts({ accounts: [accountName] });
  const filteredIds = filtered.map((c) => c.id).sort();
  assert.deepEqual(filteredIds, [c1, c2].sort());
});

test('filterContacts({accounts}) multi-select is an OR across the selected companies, excluding unrelated ones', async () => {
  const fordName = tag('FordMulti');
  const teslaName = tag('TeslaMulti');
  const otherName = tag('OtherMulti');

  const fordAccount = await db.getOrCreateAccount(fordName);
  const teslaAccount = await db.getOrCreateAccount(teslaName);
  const otherAccount = await db.getOrCreateAccount(otherName);
  createdAccountIds.push(fordAccount.id, teslaAccount.id, otherAccount.id);

  const fordCo = await db.upsertCompany({ name: `${fordName} Motors Inc.`, account_name: fordName });
  const teslaCo = await db.upsertCompany({ name: `${teslaName} Energy`, account_name: teslaName });
  const otherCo = await db.upsertCompany({ name: `${otherName} Corp`, account_name: otherName });
  createdCompanyIds.push(fordCo.id, teslaCo.id, otherCo.id);

  const fordContact = await makeContact({ full_name: tag('Ford Multi Contact'), email: `${tag('fordmulti')}@example.com`, company_id: fordCo.id, company: `${fordName} Motors Inc.` });
  const teslaContact = await makeContact({ full_name: tag('Tesla Multi Contact'), email: `${tag('teslamulti')}@example.com`, company_id: teslaCo.id, company: `${teslaName} Energy` });
  const otherContact = await makeContact({ full_name: tag('Other Multi Contact'), email: `${tag('othermulti')}@example.com`, company_id: otherCo.id, company: `${otherName} Corp` });

  const filtered = await db.filterContacts({ accounts: [fordName, teslaName] });
  const filteredIds = filtered.map((c) => c.id).sort();
  assert.deepEqual(filteredIds, [fordContact, teslaContact].sort(), 'should union contacts from both selected companies');
  assert.ok(!filteredIds.includes(otherContact), 'should not include a company that was not selected');
});

test('filterContacts({contact_ids}) multi-select returns exactly the selected contacts (Browse-by-Contact-Name selector)', async () => {
  const id1 = await makeContact({ full_name: tag('Named Contact 1'), email: `${tag('namedc1')}@example.com` });
  const id2 = await makeContact({ full_name: tag('Named Contact 2'), email: `${tag('namedc2')}@example.com` });
  const other = await makeContact({ full_name: tag('Other Contact'), email: `${tag('otherc')}@example.com` });

  const filtered = await db.filterContacts({ contact_ids: [id1, id2] });
  assert.deepEqual(filtered.map((c) => c.id).sort(), [id1, id2].sort());
  assert.ok(!filtered.map((c) => c.id).includes(other));
});

test('upsertContact prevents duplicate contacts on repeated search/import for the same email', async () => {
  const email = `${tag('dupe')}@example.com`.toLowerCase();
  const first = await db.upsertContact({ full_name: tag('Dupe Contact'), email });
  createdContactIds.push(first.id);
  assert.equal(first.updated, false);

  const second = await db.upsertContact({ full_name: tag('Dupe Contact Updated Title'), email, job_title: 'VP' });
  assert.equal(second.id, first.id);
  assert.equal(second.updated, true);

  const rows = await db.pool.query('SELECT COUNT(*)::int AS n FROM contacts WHERE LOWER(email) = LOWER($1)', [email]);
  assert.equal(rows.rows[0].n, 1);
});

test('name_key normalization does not merge unrelated companies/accounts that only share a leading word', async () => {
  const base = tag('Atlas');
  const corpResult = await db.upsertCompany({ name: `${base} Corp` });
  const financialResult = await db.upsertCompany({ name: `${base} Financial Ltd` });
  createdCompanyIds.push(corpResult.id, financialResult.id);

  assert.notEqual(corpResult.id, financialResult.id, 'different base names must stay separate companies');

  const corpRow = await db.getCompany(corpResult.id);
  const financialRow = await db.getCompany(financialResult.id);
  createdAccountIds.push(corpRow.account_id, financialRow.account_id);
  assert.notEqual(corpRow.account_id, financialRow.account_id, 'unrelated companies must not share an auto-created Account');

  // Looking up one by name must not resolve to the other.
  const found = await db.findCompanyByName(`${base} Corp`);
  assert.equal(found.id, corpResult.id);
});

test('insertContact classifies department_category/seniority_level at write time (any source, not just Apollo)', async () => {
  const id = await makeContact({
    full_name: tag('Classified Contact'), email: `${tag('classified')}@example.com`,
    job_title: 'Strategic Procurement Manager', department: '', source: 'manual',
  });
  const row = await db.getContact(id);
  assert.equal(row.department_category, 'procurement');
  assert.equal(row.seniority_level, 'manager');
});

test('filterContacts({department_categories, seniority_levels}) multi-select OR-filters contacts by category', async () => {
  const procId = await makeContact({ full_name: tag('Procurement Contact'), email: `${tag('proccat')}@example.com`, job_title: 'Procurement Manager' });
  const engId = await makeContact({ full_name: tag('Engineering Contact'), email: `${tag('engcat')}@example.com`, job_title: 'Manufacturing Engineer' });
  const financeId = await makeContact({ full_name: tag('Finance Contact'), email: `${tag('financecat')}@example.com`, job_title: 'Finance Director' });

  const byDept = await db.filterContacts({ department_categories: ['procurement', 'manufacturing'] });
  const byDeptIds = byDept.map((c) => c.id);
  assert.ok(byDeptIds.includes(procId));
  assert.ok(byDeptIds.includes(engId));
  assert.ok(!byDeptIds.includes(financeId));

  const bySeniority = await db.filterContacts({ seniority_levels: ['director'] });
  const bySeniorityIds = bySeniority.map((c) => c.id);
  assert.ok(bySeniorityIds.includes(financeId));
  assert.ok(!bySeniorityIds.includes(procId), 'Procurement Manager should classify as manager, not director');
});

test('insertEmailDraftVersion stores the real mode/instructions passed in (regression: draft.mode is never set by the caller)', async () => {
  const id = await makeContact({ full_name: tag('Draft Mode Contact'), email: `${tag('draftmode')}@example.com` });
  await db.insertEmailDraftVersion(id, { subject: 's', body: 'b', followup: 'f', rationale: 'r' }, 'sales_outreach', 'mention the new product line');

  const found = await db.findLatestDraftForContact(id, 'sales_outreach', 'mention the new product line');
  assert.ok(found, 'should find the draft under its real mode/instructions');
  assert.equal(found.draft_mode, 'sales_outreach');
  assert.equal(found.extra_instructions, 'mention the new product line');
});

test('findLatestDraftForContact does not match a different mode or different instructions (must regenerate, not reuse)', async () => {
  const id = await makeContact({ full_name: tag('Draft Dedup Contact'), email: `${tag('draftdedup')}@example.com` });
  await db.insertEmailDraftVersion(id, { subject: 's', body: 'b', followup: '', rationale: '' }, 'cold_outreach', 'instructions A');

  assert.equal(await db.findLatestDraftForContact(id, 'sales_outreach', 'instructions A'), null, 'different mode should not match');
  assert.equal(await db.findLatestDraftForContact(id, 'cold_outreach', 'instructions B'), null, 'different instructions should not match');

  const match = await db.findLatestDraftForContact(id, 'cold_outreach', 'instructions A');
  assert.ok(match, 'exact (contact, mode, instructions) match should be found');
});

test('upsertCompany and getOrCreateAccount refuse to create a record from a job title (root-cause fix, not a display-layer filter)', async () => {
  assert.equal(await db.upsertCompany({ name: 'CEO' }), null);
  assert.equal(await db.upsertCompany({ name: 'Procurement' }), null);
  assert.equal(await db.getOrCreateAccount('Director'), null);
});

test('insertContact blanks an invalid company value instead of storing it as the contact\'s company text', async () => {
  const id = await makeContact({ full_name: tag('Blanked Company Contact'), email: `${tag('blankco')}@example.com`, job_title: 'CEO', company: 'CEO' });
  const row = await db.getContact(id);
  assert.equal(row.company, '', 'company text should be blanked, not "CEO"');
  assert.equal(row.company_id, null, 'no company row should have been linked/created');
  assert.equal(row.job_title, 'CEO', 'job_title itself is untouched -- only the company slot is validated');
});

test('mergeAccounts reassigns companies to the target and removes the source accounts, without touching contacts', async () => {
  const targetName = tag('FordMergeTarget');
  const sourceName1 = tag('FordMergeSource1');
  const sourceName2 = tag('FordMergeSource2');

  const targetAccount = await db.getOrCreateAccount(targetName);
  const sourceAccount1 = await db.getOrCreateAccount(sourceName1);
  const sourceAccount2 = await db.getOrCreateAccount(sourceName2);

  const targetCo = await db.upsertCompany({ name: `${targetName} Motor Company`, account_name: targetName });
  const sourceCo1 = await db.upsertCompany({ name: `${sourceName1} Credit`, account_name: sourceName1 });
  const sourceCo2 = await db.upsertCompany({ name: `${sourceName2} Energy`, account_name: sourceName2 });

  const c1 = await makeContact({ full_name: tag('Merge Contact 1'), email: `${tag('mergec1')}@example.com`, company_id: targetCo.id, company: `${targetName} Motor Company` });
  const c2 = await makeContact({ full_name: tag('Merge Contact 2'), email: `${tag('mergec2')}@example.com`, company_id: sourceCo1.id, company: `${sourceName1} Credit` });

  const result = await db.mergeAccounts([sourceAccount1.id, sourceAccount2.id], targetAccount.id);
  assert.equal(result.companiesMoved, 2);
  assert.equal(result.accountsRemoved, 2);

  const movedCo1 = await db.getCompany(sourceCo1.id);
  const movedCo2 = await db.getCompany(sourceCo2.id);
  assert.equal(movedCo1.account_id, targetAccount.id);
  assert.equal(movedCo2.account_id, targetAccount.id);

  assert.equal(await db.getAccount(sourceAccount1.id), null, 'source account should be removed');
  assert.equal(await db.getAccount(sourceAccount2.id), null, 'source account should be removed');

  // Contacts are untouched -- they're linked via company_id, which didn't change.
  const contact1 = await db.getContact(c1);
  const contact2 = await db.getContact(c2);
  assert.equal(contact1.company_id, targetCo.id);
  assert.equal(contact2.company_id, sourceCo1.id);

  createdAccountIds.push(targetAccount.id);
  createdCompanyIds.push(targetCo.id, sourceCo1.id, sourceCo2.id);
});

test('saveDraftEdit: in-place edit updates the same row; asNewVersion preserves the original and creates a new one', async () => {
  const id = await makeContact({ full_name: tag('Draft Editor Contact'), email: `${tag('drafteditor')}@example.com` });
  const created = await db.insertEmailDraftVersion(id, { subject: 'Original subject', body: 'Original body', followup: '', rationale: '' }, 'cold_outreach', '');

  const inPlace = await db.saveDraftEdit(created.communicationId, { subject: 'Edited subject' }, false);
  assert.equal(inPlace.id, created.communicationId, 'in-place edit keeps the same row id');
  assert.equal(inPlace.subject, 'Edited subject');
  assert.equal(inPlace.version, 1, 'in-place edit does not bump the version');

  const asNewVersion = await db.saveDraftEdit(created.communicationId, { subject: 'Version 2 subject' }, true);
  assert.notEqual(asNewVersion.id, created.communicationId, 'save-as-new-version creates a new row');
  assert.equal(asNewVersion.version, 2);

  const original = await db.getCommunication(created.communicationId);
  assert.equal(original.subject, 'Edited subject', 'the original version is preserved, not overwritten');

  const current = await db.getCurrentDraftForContact(id);
  assert.equal(current.id, asNewVersion.id, 'current draft is now the latest version');
});

test('setCommunicationStatus transitions draft -> ready_for_review -> approved -> draft, logging activity each time', async () => {
  const id = await makeContact({ full_name: tag('Status Contact'), email: `${tag('statusc')}@example.com` });
  const created = await db.insertEmailDraftVersion(id, { subject: 's', body: 'b', followup: '', rationale: '' }, 'cold_outreach', '');

  let row = await db.setCommunicationStatus(created.communicationId, 'ready_for_review');
  assert.equal(row.status, 'ready_for_review');
  row = await db.setCommunicationStatus(created.communicationId, 'approved');
  assert.equal(row.status, 'approved');
  row = await db.setCommunicationStatus(created.communicationId, 'draft');
  assert.equal(row.status, 'draft');

  const activity = await db.listContactActivity(id);
  const statusChanges = activity.filter((a) => a.activity_type === 'email_status_changed');
  assert.equal(statusChanges.length, 3, 'each transition logs an activity entry');
});

test('archiveCommunication/unarchiveCommunication preserve the underlying status (effective status is independent of draft/ready/approved)', async () => {
  const id = await makeContact({ full_name: tag('Archive Contact'), email: `${tag('archivec')}@example.com` });
  const created = await db.insertEmailDraftVersion(id, { subject: 's', body: 'b', followup: '', rationale: '' }, 'cold_outreach', '');
  await db.setCommunicationStatus(created.communicationId, 'approved');

  const archived = await db.archiveCommunication(created.communicationId);
  assert.ok(archived.archived_at, 'archived_at should be set');
  assert.equal(archived.status, 'approved', 'underlying status is preserved while archived');

  const unarchived = await db.unarchiveCommunication(created.communicationId);
  assert.equal(unarchived.archived_at, null);
  assert.equal(unarchived.status, 'approved', 'restoring keeps whatever state it was in');
});

test('trashCommunication/restoreCommunication soft-delete without losing the row, and excludes it from getCurrentDraftForContact', async () => {
  const id = await makeContact({ full_name: tag('Trash Contact'), email: `${tag('trashc')}@example.com` });
  const created = await db.insertEmailDraftVersion(id, { subject: 's', body: 'b', followup: '', rationale: '' }, 'cold_outreach', '');

  const trashed = await db.trashCommunication(created.communicationId);
  assert.ok(trashed.deleted_at);
  assert.equal(await db.getCurrentDraftForContact(id), null, 'a trashed draft should not be "the current draft"');

  const restored = await db.restoreCommunication(created.communicationId);
  assert.equal(restored.deleted_at, null);
  const current = await db.getCurrentDraftForContact(id);
  assert.equal(current.id, created.communicationId, 'restoring brings it back as the current draft');
});

test('duplicateCommunication carries cc/bcc/notes and logs activity', async () => {
  const id = await makeContact({ full_name: tag('Duplicate Contact'), email: `${tag('dupcontact')}@example.com` });
  const created = await db.insertEmailDraftVersion(id, { subject: 's', body: 'b', followup: '', rationale: '' }, 'cold_outreach', '', {
    cc: 'cc@example.com', bcc: 'bcc@example.com', notes: 'internal note',
  });

  const copy = await db.duplicateCommunication(created.communicationId);
  assert.notEqual(copy.id, created.communicationId);
  assert.equal(copy.cc, 'cc@example.com');
  assert.equal(copy.bcc, 'bcc@example.com');
  assert.equal(copy.notes, 'internal note');
  assert.equal(copy.status, 'draft');

  const activity = await db.listContactActivity(id);
  assert.ok(activity.some((a) => a.activity_type === 'draft_duplicated'));
});

test('createFollowUp links back via parent_email_id and increments follow_up_sequence_number', async () => {
  const id = await makeContact({ full_name: tag('Followup Contact'), email: `${tag('followupc')}@example.com` });
  const created = await db.insertEmailDraftVersion(id, { subject: 'Original', body: 'b', followup: 'Just checking in!', rationale: '' }, 'cold_outreach', '');

  const followUp1 = await db.createFollowUp(created.communicationId);
  assert.equal(followUp1.parent_email_id, created.communicationId);
  assert.equal(followUp1.follow_up_sequence_number, 1);
  assert.equal(followUp1.body, 'Just checking in!', 'seeded from the original\'s follow-up template');

  const followUp2 = await db.createFollowUp(created.communicationId);
  assert.equal(followUp2.follow_up_sequence_number, 2, 'sequence number increments per follow-up on the same parent');

  const activity = await db.listContactActivity(id);
  assert.equal(activity.filter((a) => a.activity_type === 'followup_created').length, 2);
});

test('checkEquivalentDraft finds a matching draft, returns null for no match, and ignores trashed drafts', async () => {
  const id = await makeContact({ full_name: tag('Check Draft Contact'), email: `${tag('checkdraftc')}@example.com` });
  const created = await db.insertEmailDraftVersion(id, { subject: 's', body: 'b', followup: '', rationale: '' }, 'sales_outreach', 'mention pricing');

  const found = await db.checkEquivalentDraft(id, 'sales_outreach', 'mention pricing');
  assert.equal(found.id, created.communicationId);

  assert.equal(await db.checkEquivalentDraft(id, 'cold_outreach', 'mention pricing'), null, 'different mode should not match');

  await db.trashCommunication(created.communicationId);
  assert.equal(await db.checkEquivalentDraft(id, 'sales_outreach', 'mention pricing'), null, 'a trashed draft should not count as an equivalent match');
});

test('listDraftVersionsForContact returns every version in descending order', async () => {
  const id = await makeContact({ full_name: tag('Version List Contact'), email: `${tag('versionlistc')}@example.com` });
  const v1 = await db.insertEmailDraftVersion(id, { subject: 'v1', body: 'b', followup: '', rationale: '' }, 'cold_outreach', '');
  const v2 = await db.insertEmailDraftVersion(id, { subject: 'v2', body: 'b', followup: '', rationale: '' }, 'cold_outreach', 'different instructions');

  const versions = await db.listDraftVersionsForContact(id);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].id, v2.communicationId, 'newest version first');
  assert.equal(versions[1].id, v1.communicationId);
});

test('multi-draft-per-category: two categories for the same contact have fully independent current-drafts and version numbering', async () => {
  const id = await makeContact({ full_name: tag('Multi Category Contact'), email: `${tag('multicat')}@example.com` });

  const cold1 = await db.insertEmailDraftVersion(id, { subject: 'Cold v1', body: 'b', followup: '', rationale: '' }, 'cold_outreach', '');
  const proc1 = await db.insertEmailDraftVersion(id, { subject: 'Procurement v1', body: 'b', followup: '', rationale: '' }, 'procurement_outreach', '');
  assert.equal(cold1.version, 1, 'first draft in cold_outreach is version 1');
  assert.equal(proc1.version, 1, 'first draft in procurement_outreach is ALSO version 1 -- independent chains, not interleaved');

  // Regenerating cold_outreach must not touch procurement_outreach's version count or content.
  const cold2 = await db.insertEmailDraftVersion(id, { subject: 'Cold v2', body: 'b', followup: '', rationale: '' }, 'cold_outreach', '');
  assert.equal(cold2.version, 2);

  const coldCurrent = await db.getCurrentDraftForContact(id, 'cold_outreach');
  const procCurrent = await db.getCurrentDraftForContact(id, 'procurement_outreach');
  assert.equal(coldCurrent.subject, 'Cold v2', 'cold_outreach current draft reflects its own latest version');
  assert.equal(procCurrent.subject, 'Procurement v1', 'procurement_outreach draft is completely unaffected by cold_outreach edits');
  assert.equal(procCurrent.version, 1, 'procurement_outreach version count did not increment from cold_outreach activity');

  // Trashing every cold_outreach version must not affect procurement_outreach.
  await db.trashCommunication(coldCurrent.id);
  await db.trashCommunication(cold1.communicationId);
  assert.equal(await db.getCurrentDraftForContact(id, 'cold_outreach'), null, 'no non-deleted version left in this category');
  const procStillThere = await db.getCurrentDraftForContact(id, 'procurement_outreach');
  assert.equal(procStillThere.subject, 'Procurement v1', 'deleting one category leaves the other category fully intact');
});

test('listDraftCategoriesForContact reports exists:false for a category with no draft, and the real status for generated ones', async () => {
  const id = await makeContact({ full_name: tag('Categories Contact'), email: `${tag('categoriesc')}@example.com` });
  await db.insertEmailDraftVersion(id, { subject: 's', body: 'b', followup: '', rationale: '' }, 'cold_outreach', '');
  const proc = await db.insertEmailDraftVersion(id, { subject: 's', body: 'b', followup: '', rationale: '' }, 'procurement_outreach', '');
  await db.setCommunicationStatus(proc.communicationId, 'ready_for_review');

  const generated = await db.listDraftCategoriesForContact(id);
  const byMode = new Map(generated.map((c) => [c.draft_mode, c]));
  assert.ok(byMode.has('cold_outreach'));
  assert.ok(byMode.has('procurement_outreach'));
  assert.equal(byMode.get('procurement_outreach').status, 'ready_for_review');
  assert.equal(byMode.has('engineering_outreach'), false, 'a category with no draft is simply absent from the generated list');
});

test('createFollowUp does not get mistaken for the category\'s current draft (excluded via parent_email_id)', async () => {
  const id = await makeContact({ full_name: tag('Followup Current Contact'), email: `${tag('followupcur')}@example.com` });
  const original = await db.insertEmailDraftVersion(id, { subject: 'Original', body: 'b', followup: 'Checking in', rationale: '' }, 'cold_outreach', '');
  await db.createFollowUp(original.communicationId);

  const current = await db.getCurrentDraftForContact(id, 'cold_outreach');
  assert.equal(current.id, original.communicationId, 'the follow-up must not supersede the category\'s current draft');
});

test('migration backfill: legacy communications rows with NULL draft_mode get backfilled to cold_outreach', async () => {
  const id = await makeContact({ full_name: tag('Legacy Draft Contact'), email: `${tag('legacydraft')}@example.com` });
  const inserted = await db.pool.query(
    `INSERT INTO communications (contact_id, comm_type, subject, body, status, version, source)
     VALUES ($1, 'draft', 'Legacy subject', 'Legacy body', 'saved', 1, 'migrated_draft') RETURNING id`,
    [id]
  );
  const legacyId = inserted.rows[0].id;
  const beforeBackfill = await db.getCommunication(legacyId);
  assert.equal(beforeBackfill.draft_mode, null, 'sanity check: row starts with NULL draft_mode');

  await db.initDb(); // re-runs the idempotent backfill migration

  const afterBackfill = await db.getCommunication(legacyId);
  assert.equal(afterBackfill.draft_mode, 'cold_outreach', 'legacy NULL draft_mode should be backfilled');
});
