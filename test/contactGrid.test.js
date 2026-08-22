// Column-filter grid: the SQL builder (pure, no DB) and the queries it
// produces (against the real DATABASE_URL, like the other suites here).
//
// Fixture rows are tagged ZZGRID_<run id> and removed in the after hook, and
// every DB assertion is scoped to those rows via contact_ids, so a
// concurrently running app cannot shift a count out from under an assertion.
require('dotenv').config();
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
const {
  normalizeColumnFilters, buildWhere, buildOrderBy, describeFilters,
  escapeLike, OPTION_SQL, SORTABLE, CONTACT_SOURCES,
} = require('../contact-query');

/* ── Pure builder ─────────────────────────────────────────────────── */

test('normalize drops option keys outside the vocabulary', () => {
  const f = normalizeColumnFilters({
    source: { values: ['apollo', 'DROP TABLE contacts', 'manual'] },
    status: { values: ['not_contacted', 'nonsense'] },
    draft: { states: ['ai', '; DELETE FROM contacts'] },
  });
  assert.deepEqual(f.source.values, ['apollo', 'manual']);
  assert.deepEqual(f.status.values, ['not_contacted']);
  assert.deepEqual(f.draft.states, ['ai']);
});

test('normalize keeps empty/notEmpty without an operand, drops bare text modes', () => {
  assert.equal(normalizeColumnFilters({ contact: { mode: 'empty' } }).contact.mode, 'empty');
  assert.equal(normalizeColumnFilters({ contact: { mode: 'contains', value: '  ' } }).contact, undefined);
  assert.equal(normalizeColumnFilters({ contact: { mode: 'bogus', value: 'x' } }).contact.mode, 'contains');
});

test('every user value is bound, never interpolated', () => {
  const evil = "'; DROP TABLE contacts; --";
  const { where, params } = buildWhere({
    q: evil,
    columns: normalizeColumnFilters({
      contact: { mode: 'contains', value: evil },
      company: { values: [evil] },
      email: { domain: evil },
      tags: { values: [evil] },
    }),
  });
  assert.ok(!where.includes('DROP TABLE'), 'no user text reached the SQL string');
  assert.ok(params.some((p) => String(p).includes('DROP TABLE')), 'it travelled as a parameter instead');
});

test('LIKE metacharacters in a search term are escaped, not treated as wildcards', () => {
  assert.equal(escapeLike('50%_off'), '50\\%\\_off');
  const { params } = buildWhere({ columns: normalizeColumnFilters({ contact: { mode: 'starts', value: '100%' } }) });
  assert.ok(params.includes('100\\%%'));
});

test('filters from different columns AND together', () => {
  const { where } = buildWhere({
    columns: normalizeColumnFilters({
      source: { values: ['apollo'] },
      status: { values: ['not_contacted'] },
      email: { modes: ['has'] },
    }),
  });
  assert.equal(where.match(/AND/g).length >= 2, true);
  assert.ok(where.startsWith('WHERE'));
});

test('skipColumn omits only that column, for Excel-style facet counts', () => {
  const columns = normalizeColumnFilters({
    source: { values: ['apollo'] },
    status: { values: ['not_contacted'] },
  });
  const all = buildWhere({ columns });
  const skipped = buildWhere({ columns }, { skipColumn: 'source' });
  assert.ok(all.where.includes('c.source'));
  assert.ok(!skipped.where.includes('c.source'));
  assert.ok(skipped.where.includes('c.follow_up_status'));
});

test('sort accepts only whitelisted columns and always breaks ties', () => {
  assert.equal(buildOrderBy({ column: 'contact', direction: 'asc' }), 'ORDER BY c.full_name ASC NULLS LAST, c.id DESC');
  // An unknown column falls back to the default rather than reaching the SQL.
  assert.equal(buildOrderBy({ column: 'c.id; DROP TABLE contacts', direction: 'asc' }), 'ORDER BY c.id ASC');
  assert.ok(Object.keys(SORTABLE).length >= 8);
});

test('a single primary sort, not an accumulating list', () => {
  const o = buildOrderBy({ column: 'company', direction: 'desc' });
  assert.equal((o.match(/ORDER BY/g) || []).length, 1);
  assert.equal(o.split(',').length, 2);   // the sort key plus the id tiebreak
});

test('AI-draft and human-edited are mutually exclusive', () => {
  // Otherwise every edited draft would also count as an AI draft and the two
  // menu options would overlap into uselessness.
  assert.ok(OPTION_SQL.draft.ai.includes('NOT'));
  assert.ok(!OPTION_SQL.draft.edited.startsWith('NOT'));
});

test('text date columns are compared as absent when blank, not NULL', () => {
  // last_contacted_at/meeting_date are text and hold '' rather than NULL;
  // an IS NULL test against them is always false.
  assert.ok(OPTION_SQL.activity.never.includes("TRIM(c.last_contacted_at), ''"));
  assert.ok(OPTION_SQL.activity.meeting.includes("TRIM(c.meeting_date), ''"));
});

test('chips describe every active column bilingually', () => {
  const chips = describeFilters(normalizeColumnFilters({
    contact: { mode: 'starts', value: 'Ma' },
    email: { modes: ['has'], domain: '@tesla.com' },
    source: { values: ['apollo'] },
    tags: { values: ['Energy Storage'], match: 'all' },
  }));
  const cols = chips.map((c) => c.column);
  ['contact', 'email', 'source', 'tags'].forEach((c) => assert.ok(cols.includes(c), `missing chip for ${c}`));
  chips.forEach((c) => { assert.ok(c.text); assert.ok(c.text_cn); });
});

test('the canonical source list covers what the ingest paths write', () => {
  const keys = CONTACT_SOURCES.map((s) => s.key);
  ['apollo', 'manual', 'business_card', 'battery_show', 'email_import']
    .forEach((k) => assert.ok(keys.includes(k), `source ${k} missing`));
});

/* ── Against the database ─────────────────────────────────────────── */

const RUN = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const NAME = (n) => `ZZGRID ${n} ${RUN}`;
const ids = [];
const companyNames = [];   // torn down after the contacts that reference them
let scoped;   // filters pinned to this run's rows only

test.before(async () => {
  // insertContact materialises a company row for each contact's company
  // text, so those implicit rows have to be torn down as well — the first
  // version of this hook only removed the ones created explicitly and left
  // a ZZGridCo/ZZOther pair behind on every run.
  companyNames.push(`ZZGridCo ${RUN}`, `ZZOther ${RUN}`);
  const mk = async (fields) => { const id = await db.insertContact(fields); ids.push(id); return id; };
  await mk({ full_name: NAME('Alpha'), company: `ZZGridCo ${RUN}`, email: `a@zzgrid-${RUN}.com`, source: 'apollo', follow_up_status: 'not_contacted' });
  await mk({ full_name: NAME('Beta'),  company: `ZZGridCo ${RUN}`, email: `b@gmail.com`,          source: 'manual', follow_up_status: 'contacted' });
  await mk({ full_name: NAME('Gamma'), company: `ZZOther ${RUN}`,  email: '',                     source: 'apollo', follow_up_status: 'not_contacted' });
  scoped = { contact_ids: ids };
});

test.after(async () => {
  // Order matters: contacts.company_id is a foreign key, so the companies
  // cannot go until the contacts pointing at them have.
  if (ids.length) await db.pool.query('DELETE FROM contacts WHERE id = ANY($1::int[])', [ids]);
  if (companyNames.length) {
    await db.pool.query('DELETE FROM companies WHERE name = ANY($1::text[])', [companyNames]);
    await db.pool.query('DELETE FROM accounts WHERE name = ANY($1::text[])', [companyNames]);
  }
});

test('paging returns one page plus a true total', async () => {
  const total = await db.countContacts(scoped);
  assert.equal(total, 3);
  const page1 = await db.queryContactsPage(scoped, { column: 'contact', direction: 'asc' }, 1, 2);
  const page2 = await db.queryContactsPage(scoped, { column: 'contact', direction: 'asc' }, 2, 2);
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 1);
  // No row appears on two pages — the id tiebreak makes paging stable.
  const seen = page1.concat(page2).map((r) => r.id);
  assert.equal(new Set(seen).size, 3);
  assert.deepEqual(page1.map((r) => r.full_name), [NAME('Alpha'), NAME('Beta')]);
});

test('sort direction actually reverses the page', async () => {
  const asc = await db.queryContactsPage(scoped, { column: 'contact', direction: 'asc' }, 1, 10);
  const desc = await db.queryContactsPage(scoped, { column: 'contact', direction: 'desc' }, 1, 10);
  assert.deepEqual(asc.map((r) => r.full_name).reverse(), desc.map((r) => r.full_name));
});

test('email filters split company from personal addresses', async () => {
  const withCols = (columns) => ({ ...scoped, columns: normalizeColumnFilters(columns) });
  assert.equal(await db.countContacts(withCols({ email: { modes: ['has'] } })), 2);
  assert.equal(await db.countContacts(withCols({ email: { modes: ['missing'] } })), 1);
  assert.equal(await db.countContacts(withCols({ email: { modes: ['personal'] } })), 1);
  assert.equal(await db.countContacts(withCols({ email: { modes: ['company'] } })), 1);
  assert.equal(await db.countContacts(withCols({ email: { domain: 'gmail.com' } })), 1);
});

test('multiple column filters narrow together', async () => {
  const n = await db.countContacts({
    ...scoped,
    columns: normalizeColumnFilters({
      source: { values: ['apollo'] },
      status: { values: ['not_contacted'] },
      email: { modes: ['has'] },
    }),
  });
  assert.equal(n, 1);   // Alpha only: Gamma is apollo/not_contacted but has no email
});

test('contact text modes behave differently from one another', async () => {
  const c = (spec) => db.countContacts({ ...scoped, columns: normalizeColumnFilters({ contact: spec }) });
  assert.equal(await c({ mode: 'starts', value: 'ZZGRID Al' }), 1);
  assert.equal(await c({ mode: 'starts', value: 'Alpha' }), 0);
  assert.equal(await c({ mode: 'contains', value: 'Alpha' }), 1);
  assert.equal(await c({ mode: 'ends', value: RUN }), 3);
  assert.equal(await c({ mode: 'notEmpty' }), 3);
  assert.equal(await c({ mode: 'empty' }), 0);
});

test('facet counts match what the filter then returns', async () => {
  // The contract that makes a "(0)" in a menu trustworthy.
  const opts = await db.contactFacets(scoped, 'email');
  for (const o of opts) {
    const n = await db.countContacts({ ...scoped, columns: normalizeColumnFilters({ email: { modes: [o.key] } }) });
    assert.equal(n, o.n, `facet ${o.key} said ${o.n} but the filter returned ${n}`);
  }
});

test('a facet ignores its own column but respects the others', async () => {
  const filters = { ...scoped, columns: normalizeColumnFilters({ source: { values: ['apollo'] } }) };
  const sources = await db.contactFacets(filters, 'source');
  const bySource = Object.fromEntries(sources.map((r) => [r.key, r.n]));
  assert.equal(bySource.apollo, 2);
  assert.equal(bySource.manual, 1, 'the source menu still offers manual while apollo is selected');

  const emails = await db.contactFacets(filters, 'email');
  const byEmail = Object.fromEntries(emails.map((r) => [r.key, r.n]));
  assert.equal(byEmail.has, 1, 'the email menu is scoped by the active source filter');
});

/* ── Email provenance and the free/paid boundary ──────────────────────
   These lock the rule that decides whether a request can spend money. */

const {
  EMAIL_SOURCES, EMAIL_SOURCE_BY_KEY, PAID_EMAIL_SOURCES,
} = require('../contact-query');

test('exactly one email source costs credits, and it is the Apollo reveal', () => {
  assert.deepEqual(PAID_EMAIL_SOURCES, ['apollo_enrichment']);
  // Apollo *search* results arrive with the search we already paid for;
  // billing them again as an enrichment would double-count credits.
  assert.equal(EMAIL_SOURCE_BY_KEY.apollo_search.costsCredits, false);
  assert.equal(EMAIL_SOURCE_BY_KEY.business_card.costsCredits, false);
  assert.equal(EMAIL_SOURCE_BY_KEY.manual.costsCredits, false);
  assert.equal(EMAIL_SOURCE_BY_KEY.email_import.costsCredits, false);
  assert.equal(EMAIL_SOURCE_BY_KEY.battery_show.costsCredits, false);
});

test('every email source is labelled in both languages', () => {
  EMAIL_SOURCES.forEach((o) => {
    assert.ok(o.label, `${o.key} has no English label`);
    assert.ok(o.label_cn, `${o.key} has no Chinese label`);
    assert.equal(typeof o.costsCredits, 'boolean');
  });
});

test('a stored address is readable without any Apollo involvement', async () => {
  // The uploaded-contact case: an address already in the CRM is returned
  // whatever the contact's source, and costs nothing.
  const id = await db.insertContact({
    full_name: `ZZGRID Stored ${RUN}`, company: `ZZGridCo ${RUN}`,
    email: `stored@zzgrid-${RUN}.com`, source: 'file_upload', email_source: 'uploaded_file',
  });
  ids.push(id);
  const row = await db.getContact(id);
  assert.equal(row.email, `stored@zzgrid-${RUN}.com`);
  assert.equal(row.email_source, 'uploaded_file');
});

test('provenance survives an unrelated edit', async () => {
  // Editing a phone number must not relabel where the address came from.
  const id = await db.insertContact({
    full_name: `ZZGRID Prov ${RUN}`, company: `ZZGridCo ${RUN}`,
    email: `prov@zzgrid-${RUN}.com`, source: 'battery_show', email_source: 'apollo_enrichment',
  });
  ids.push(id);
  await db.updateContact(id, { phone: '+49 123 456' });
  const row = await db.getContact(id);
  assert.equal(row.email_source, 'apollo_enrichment', 'provenance was rewritten by an unrelated update');
  assert.equal(row.email, `prov@zzgrid-${RUN}.com`);
});

test('a genuinely new address takes new provenance', async () => {
  const id = await db.insertContact({
    full_name: `ZZGRID Replace ${RUN}`, company: `ZZGridCo ${RUN}`,
    email: `old@zzgrid-${RUN}.com`, source: 'apollo', email_source: 'apollo_search',
  });
  ids.push(id);
  await db.updateContact(id, { email: `new@zzgrid-${RUN}.com`, email_source: 'manual' });
  const row = await db.getContact(id);
  assert.equal(row.email, `new@zzgrid-${RUN}.com`);
  assert.equal(row.email_source, 'manual');
});

test('a contact with no Apollo id is never a reveal candidate', async () => {
  const id = await db.insertContact({
    full_name: `ZZGRID NoApollo ${RUN}`, company: `ZZGridCo ${RUN}`,
    email: '', source: 'manual',
  });
  ids.push(id);
  const rows = await db.listContactsByIds([id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].apollo_person_id || '', '', 'no apollo id, so nothing to reveal');
});

/* ── The discovery chain ──────────────────────────────────────────────
   An uploaded CSV/Excel supplies company *names*. The system matches or
   creates companies, Apollo returns contacts for them, and the addresses
   come either with the search or from a paid reveal. Three links, three
   separate records — collapsing them would make the upload look as though
   it produced the people. */

const { COMPANY_SOURCES, companySourceForContact } = require('../contact-query');

test('a file upload is a company source, never a contact source', () => {
  assert.ok(COMPANY_SOURCES.some((o) => o.key === 'file_upload'));
  assert.ok(!CONTACT_SOURCES.some((o) => o.key === 'file_upload'),
    'contacts are never created by an upload — Apollo returns them');
  assert.ok(!EMAIL_SOURCES.some((o) => o.key === 'uploaded_file'),
    'with no contact importer there is no such thing as an uploaded address');
});

test('the chain survives from upload through Apollo to the grid', async () => {
  const co = `ZZGridChain ${RUN}`;
  companyNames.push(co);
  await db.upsertCompany({ name: co, source: 'file_upload', source_file: 'list.csv' });
  const id = await db.insertContact({
    full_name: `ZZGRID Chained ${RUN}`, company: co,
    email: `chain@zzgrid-${RUN}.com`,
    source: 'apollo', email_source: 'apollo_search', apollo_person_id: 'zz-chain',
  });
  ids.push(id);

  const [row] = await db.queryContactsPage({ contact_ids: [id] }, null, 1, 1);
  assert.equal(row.company_source, 'file_upload');       // the file found the company
  assert.equal(row.company_source_file, 'list.csv');
  assert.equal(row.source, 'apollo');                    // Apollo found the person
  assert.equal(row.email_source, 'apollo_search');       // the search carried the address

});

test('a later Apollo search does not relabel how a company was discovered', async () => {
  const co = `ZZGridFirst ${RUN}`;
  companyNames.push(co);
  await db.upsertCompany({ name: co, source: 'file_upload', source_file: 'original.csv' });
  await db.upsertCompany({ name: co, source: 'apollo' });          // a search touches it later
  const row = await db.findCompanyByName(co);
  assert.equal(row.source, 'file_upload', 'first discovery must win');
  assert.equal(row.source_file, 'original.csv');
});

test('a placeholder origin is replaced by a real one', async () => {
  // An unlabelled path records 'crm_side_effect'; if an upload later names
  // the company explicitly, that is better information and should win.
  const co = `ZZGridDerived ${RUN}`;
  companyNames.push(co);
  await db.upsertCompany({ name: co });                            // no source given
  assert.equal((await db.findCompanyByName(co)).source, 'crm_side_effect');
  await db.upsertCompany({ name: co, source: 'file_upload', source_file: 'later.csv' });
  assert.equal((await db.findCompanyByName(co)).source, 'file_upload');
});

test('indirect creation names the operation that caused it', () => {
  // 'derived' said only "something else made this". These say which thing.
  assert.equal(companySourceForContact('apollo'), 'apollo');
  assert.equal(companySourceForContact('email_import'), 'email_import');
  assert.equal(companySourceForContact('business_card'), 'contact_creation');
  assert.equal(companySourceForContact('manual'), 'contact_creation');
  assert.equal(companySourceForContact(undefined), 'contact_creation');
  const keys = COMPANY_SOURCES.map((o) => o.key);
  ['contact_creation', 'email_import', 'crm_side_effect'].forEach((k) =>
    assert.ok(keys.includes(k), `company source ${k} missing`));
  assert.ok(!keys.includes('derived'), 'the vague value is gone');
});

test('saving a contact records why its company appeared', async () => {
  // The company is a side effect of the contact, and the audit trail should
  // say which kind of contact caused it rather than just "something did".
  const co = `ZZGridCause ${RUN}`;
  companyNames.push(co);
  const id = await db.insertContact({
    full_name: `ZZGRID Causer ${RUN}`, company: co, source: 'email_import', email: '',
  });
  ids.push(id);
  const row = await db.findCompanyByName(co);
  assert.equal(row.source, 'email_import');

  const trail = await db.listCompanyActivity(row.id);
  assert.ok(trail.length >= 1, 'creation was not audited');
  assert.match(trail[trail.length - 1].description, /source: email_import/);
});

test('the audit trail records a corrected origin', async () => {
  const co = `ZZGridAudit ${RUN}`;
  companyNames.push(co);
  await db.upsertCompany({ name: co });                              // placeholder
  await db.upsertCompany({ name: co, source: 'file_upload', source_file: 'q3.csv' });
  const row = await db.findCompanyByName(co);
  const trail = await db.listCompanyActivity(row.id);
  const corrections = trail.filter((a) => a.activity_type === 'source_recorded');
  assert.equal(corrections.length, 1);
  assert.match(corrections[0].description, /crm_side_effect → file_upload/);
  assert.match(corrections[0].description, /q3\.csv/);
});

test('company source filters contacts, and ANDs with other filters', async () => {
  const co = `ZZGridFiltered ${RUN}`;
  companyNames.push(co);
  await db.upsertCompany({ name: co, source: 'file_upload', source_file: 'f.csv' });
  const id = await db.insertContact({
    full_name: `ZZGRID Filtered ${RUN}`, company: co, source: 'apollo', email: `f@zzgrid-${RUN}.com`,
  });
  ids.push(id);

  // Scoped to this one contact: earlier tests in this file also create
  // file_upload companies, and asserting against the whole run's id set
  // would make this test depend on their order.
  const mine = { contact_ids: [id] };
  assert.equal(await db.countContacts({ ...mine, company_sources: ['file_upload'] }), 1);
  assert.equal(await db.countContacts({ ...mine, company_sources: ['manual'] }), 0);
  // ANDs with a column filter rather than replacing it: this contact has an
  // address, so "file_upload AND missing email" must match nothing.
  assert.equal(await db.countContacts({
    ...mine, company_sources: ['file_upload'],
    columns: normalizeColumnFilters({ email: { modes: ['missing'] } }),
  }), 0);
  assert.equal(await db.countContacts({
    ...mine, company_sources: ['file_upload'],
    columns: normalizeColumnFilters({ email: { modes: ['has'] } }),
  }), 1);
  // An unknown value is dropped, not passed through to the SQL.
  assert.equal(await db.countContacts({ contact_ids: ids, company_sources: ["'; DROP TABLE companies--"] }), ids.length);
});
