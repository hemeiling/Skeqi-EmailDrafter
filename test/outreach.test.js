/* Exhibitor Outreach · 展商拓展 — status rules, filters, KPIs, manual Sent,
   export, best-contact and the drafting context.

   Runs only against TEST_DATABASE_URL (see dbGuard). Every row it creates
   hangs off one throwaway event, and is removed in `after`. */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const dbGuard = require('./dbGuard');

/* The pure parts need no database, so they run everywhere. */
const outreachPure = require('../outreach');

const pick = (list) => outreachPure.pickBestContact(list.map((c) => ({ has_email: true, ...c })));
const DIRECTOR = { department_category: 'manufacturing', seniority_level: 'director' };

test('best contact: nothing when there is no evidence, only a Manager title, or a tie', () => {
  assert.equal(outreachPure.pickBestContact([]), null);
  assert.equal(pick([{ id: 1 }, { id: 2 }]), null);
  assert.equal(pick([{ id: 1, department_category: 'engineering', seniority_level: 'manager' }]), null,
    'a Manager title alone never singles anyone out');
  assert.equal(pick([{ id: 1, ...DIRECTOR }, { id: 2, department_category: 'procurement', seniority_level: 'vp' }]), null,
    'two equally senior titles are a tie');
  assert.equal(pick([{ id: 1, replied: true, ...DIRECTOR }, { id: 2, replied: true, ...DIRECTOR }]), null,
    'equal on every tier is a tie');
  assert.equal(pick([{ id: 1, department_category: 'finance', seniority_level: 'c_level' }]), null,
    'seniority outside a relevant function earns nothing');
});

test('best contact: interaction beats team notes, and team notes beat title', () => {
  // Director + high interest + high priority still loses to someone we actually met.
  const a = pick([
    { id: 1, ...DIRECTOR, interest_level: 'high', priority: 'high', contact_status: 'customer' },
    { id: 2, source: 'business_card' },
  ]);
  assert.equal(a.contact_id, 2);
  assert.equal(a.basis, 'interaction');
  assert.deepEqual(a.reasons, ['Business card collected']);

  const b = pick([{ id: 1, ...DIRECTOR }, { id: 2, priority: 'high' }]);
  assert.equal(b.contact_id, 2);
  assert.equal(b.basis, 'crm_judgement');

  // Two who replied: the title only breaks the tie between them.
  const c = pick([{ id: 1, replied: true }, { id: 2, replied: true, ...DIRECTOR }]);
  assert.equal(c.contact_id, 2);
  assert.equal(c.basis, 'interaction');
  assert.deepEqual(c.reasons, ['Replied to a previous email', 'Director+ in a relevant function (from job title)']);
});

test('best contact: a title-only pick is allowed, and labelled as such', () => {
  const r = pick([{ id: 1, ...DIRECTOR }, { id: 2, department_category: 'engineering', seniority_level: 'manager' }, { id: 3 }]);
  assert.equal(r.contact_id, 1);
  assert.equal(r.basis, 'title');
  assert.equal(r.basis_label, 'Job title only');
  assert.match(r.reasons[0], /from job title/);
});

test('best contact: people without a usable email are never picked', () => {
  const r = outreachPure.pickBestContact([
    { id: 1, has_email: false, replied: true, source: 'business_card' },
    { id: 2, has_email: true, ...DIRECTOR },
  ]);
  assert.equal(r.contact_id, 2);
});

test('parseSentAt: bare dates, future dates and garbage', () => {
  const now = new Date('2026-09-29T15:00:00Z');
  assert.equal(outreachPure.parseSentAt('2026-09-20', now).toISOString(), '2026-09-20T12:00:00.000Z');
  assert.equal(outreachPure.parseSentAt('', now), now);
  assert.throws(() => outreachPure.parseSentAt('2026-12-01', now), { code: 'future_date' });
  assert.throws(() => outreachPure.parseSentAt('not a date', now), { code: 'bad_date' });
  assert.throws(() => outreachPure.parseSentAt('1970-01-01', now), { code: 'bad_date' });
});

test('normalizeFilters drops unknown keys and values', () => {
  const f = outreachPure.normalizeFilters({
    q: '  comau ', status: 'DROP TABLE', sort: 'id; --', has_email: 'maybe', sent: 'no', evil: 1,
  });
  assert.equal(f.q, 'comau');
  assert.equal(f.status, undefined);
  assert.equal(f.sort, 'company');
  assert.equal(f.has_email, undefined);
  assert.equal(f.sent, 'no');
  assert.equal(f.evil, undefined);
});

test('export cells that look like formulas are neutralised', () => {
  assert.equal(outreachPure.neutralize('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.equal(outreachPure.neutralize('+1 555'), "'+1 555");
  assert.equal(outreachPure.neutralize('@evil'), "'@evil");
  assert.equal(outreachPure.neutralize('Comau LLC'), 'Comau LLC');
  const csv = outreachPure.rowsToCsv([{ company: '=cmd|x', booth: '1, 2', exhibitor_id: 7 }]);
  assert.ok(csv.startsWith('﻿'), 'BOM for Excel');
  assert.ok(csv.includes(`'=cmd|x`));
  assert.ok(csv.includes('"1, 2"'));
});

test('the prompt names the booth when the company is an exhibitor, and is unchanged otherwise', () => {
  const { buildPromptForMode } = require('../claude');
  const contact = { name: 'John Smith', title: 'Director', company: 'Comau LLC' };
  const sender = { name: 'Mei', company: 'SKQ' };
  const withBooth = buildPromptForMode('cold_outreach', contact, sender,
    { eventName: 'The Battery Show 2026', exhibitorBooths: ['3626'] });
  assert.match(withBooth, /The Battery Show 2026 \(the recipient's company is an exhibitor — booth 3626\)/);
  const noBooth = buildPromptForMode('cold_outreach', contact, sender,
    { eventName: 'The Battery Show 2026', exhibitorBooths: [] });
  assert.match(noBooth, /booth not yet published/);
  const plain = buildPromptForMode('cold_outreach', contact, sender, { eventName: 'The Battery Show 2026' });
  assert.match(plain, /- Event: The Battery Show 2026\n/);
  assert.doesNotMatch(plain, /exhibitor/);
});

if (!dbGuard.available) {
  test('outreach database suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
  return;
}

const db = require('../db');
const outreach = require('../outreach');
const { pool } = db;

const RUN = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const T = (s) => `ZZOUT_${s}_${RUN}`;
const ids = { companies: [], contacts: [], exhibitors: [], booths: [], intel: [], runs: [] };
let eventId;
const F = {}; // fixture handles by name

async function company(name) {
  const { rows: [r] } = await pool.query(
    'INSERT INTO companies (name, source) VALUES ($1, $2) RETURNING id', [T(name), 'manual']);
  ids.companies.push(r.id);
  return r.id;
}

async function contact(companyId, fields) {
  const id = await db.insertContact({ company_id: companyId, company: '', ...fields,
    full_name: T(fields.full_name || 'c') });
  ids.contacts.push(id);
  return id;
}

async function exhibitor(name, companyId, booths = [], status = 'listed') {
  const { rows: [r] } = await pool.query(
    `INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name, company_id, attendance_status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [eventId, T(`src_${name}`), T(name), companyId, status]);
  ids.exhibitors.push(r.id);
  for (const b of booths) {
    await pool.query('INSERT INTO exhibitor_booths (exhibitor_id, booth_number) VALUES ($1, $2)', [r.id, b]);
  }
  return r.id;
}

async function comm(fields) {
  return db.insertCommunication(fields);
}

async function draft(contactId, extra = {}) {
  return comm({ contact_id: contactId, comm_type: 'draft', status: 'draft', draft_mode: 'cold_outreach',
    subject: 'Hello', body: 'Body', ...extra });
}

async function rowFor(exhibitorId, filters = {}) {
  const { rows } = await outreach.listExhibitors(pool, eventId, filters, { all: true });
  return rows.find((r) => r.exhibitor_id === exhibitorId);
}

test.before(async () => {
  await db.initDb();
  const { rows: [ev] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [T('Battery Show')]);
  eventId = ev.id;

  // 1. Unmatched: listed, no company link.
  F.unmatched = await exhibitor('Unmatched Co', null, ['9001']);

  // 2. Matched, no contacts.
  F.noContactCo = await company('NoContact Co');
  F.noContact = await exhibitor('NoContact Co', F.noContactCo, ['3626']);

  // 3. Shared booth: a second company at 3626.
  F.sharedCo = await company('Shared Booth Co');
  F.shared = await exhibitor('Shared Booth Co', F.sharedCo, ['3626']);

  // 4. Contacts but no usable email (Apollo placeholder, revealable).
  F.noEmailCo = await company('NoEmail Co');
  F.noEmail = await exhibitor('NoEmail Co', F.noEmailCo, ['1001']);
  F.lockedContact = await contact(F.noEmailCo, { full_name: 'Locked Person',
    email: '(email available via Apollo, not returned in payload)', apollo_person_id: 'ap_1' });

  // 5. Needs draft: emailable contact; an ingested email FROM them must not count as Sent,
  //    and a trashed, an archived and a follow-up draft must not count as Drafted.
  F.needsCo = await company('Needs Co');
  F.needs = await exhibitor('Needs Co', F.needsCo, ['1002']);
  F.needsContact = await contact(F.needsCo, { full_name: 'Needs Person', email: 'needs@example.com' });
  await comm({ contact_id: F.needsContact, comm_type: 'imported_email', source: 'manual_paste',
    from_email: 'needs@example.com', sent_at: new Date().toISOString() });
  const trashed = await draft(F.needsContact);
  await pool.query('UPDATE communications SET deleted_at = NOW() WHERE id = $1', [trashed.id]);
  const archived = await draft(F.needsContact);
  await pool.query('UPDATE communications SET archived_at = NOW() WHERE id = $1', [archived.id]);
  const parent = await draft(F.needsContact, { status: 'archived' });
  await pool.query('UPDATE communications SET archived_at = NOW() WHERE id = $1', [parent.id]);
  await draft(F.needsContact, { parent_email_id: parent.id, follow_up_sequence_number: 1 });

  // 6. Drafted: a live draft in a non-default mode.
  F.draftedCo = await company('Drafted Co');
  F.drafted = await exhibitor('Drafted Co', F.draftedCo, ['2002', '2004']);
  F.draftedContact = await contact(F.draftedCo, { full_name: 'Drafted Person', email: 'drafted@example.com' });
  F.draftRow = await draft(F.draftedContact, { draft_mode: 'engineering_outreach' });

  // 7. Partially contacted: 3 emailable contacts (one address duplicated), 1 system-sent.
  F.partialCo = await company('Partial Co');
  F.partial = await exhibitor('Partial Co', F.partialCo, ['3000']);
  F.sentA = await contact(F.partialCo, { full_name: 'Sent A', email: 'a@partial.com' });
  F.b = await contact(F.partialCo, { full_name: 'B', email: 'b@partial.com',
    job_title: 'Director of Manufacturing' });
  await contact(F.partialCo, { full_name: 'B dup', email: 'B@partial.com ' });
  const sentDraft = await draft(F.sentA);
  await db.markCommunicationSend(sentDraft.id, { delivery_status: 'sent', sent_at: new Date(), user_id: 'alice' });

  // 8. Fully contacted via a manual entry.
  F.allCo = await company('All Co');
  F.all = await exhibitor('All Co', F.allCo, ['3001']);
  F.allContact = await contact(F.allCo, { full_name: 'All Person', email: 'all@example.com' });
  await db.insertManualEmail({ contactId: F.allContact, companyId: F.allCo, toEmail: 'all@example.com',
    sentAt: '2026-09-01T12:00:00Z', userId: 'bob' });

  // A contact at a company that is not exhibiting at all.
  F.outsiderCo = await company('Outsider Co');
  F.outsider = await contact(F.outsiderCo, { full_name: 'Outsider', email: 'outsider@example.com' });

  // 9. Withdrawn exhibitor.
  F.withdrawnCo = await company('Withdrawn Co');
  F.withdrawn = await exhibitor('Withdrawn Co', F.withdrawnCo, [], 'retired');

  // Curated classification on Drafted Co; a label under review on Needs Co must not show.
  const { rows: [bm] } = await pool.query(
    `INSERT INTO booth_map_booths (event_id, booth_number, category, exhibitor_id, occupant_status)
     VALUES ($1, $2, 'customer', $3, 'current') RETURNING id`, [eventId, T('b2002'), F.drafted]);
  ids.booths.push(bm.id);
  const { rows: [bi] } = await pool.query(
    `INSERT INTO booth_intel (booth_id, kind, exhibitor_id) VALUES ($1, 'target_customer', $2) RETURNING id`,
    [bm.id, F.drafted]);
  ids.intel.push(bi.id);
  const { rows: [bm2] } = await pool.query(
    `INSERT INTO booth_map_booths (event_id, booth_number, category, exhibitor_id, occupant_status)
     VALUES ($1, $2, 'batmat', $3, 'current') RETURNING id`, [eventId, T('b1002'), F.needs]);
  ids.booths.push(bm2.id);
  const { rows: [bi2] } = await pool.query(
    `INSERT INTO booth_intel (booth_id, kind, exhibitor_id, review_status)
     VALUES ($1, 'competitor_direct', $2, 'needs_review') RETURNING id`, [bm2.id, F.needs]);
  ids.intel.push(bi2.id);

  const { rows: [run] } = await pool.query(
    `INSERT INTO exhibitor_import_runs (event_id, status, dry_run, finished_at)
     VALUES ($1, 'success', FALSE, NOW() + interval '1 day') RETURNING id`, [eventId]);
  ids.runs.push(run.id);
});

test.after(async () => {
  try {
    await pool.query('DELETE FROM booth_intel WHERE id = ANY($1::int[])', [ids.intel]);
    await pool.query('DELETE FROM booth_map_booths WHERE id = ANY($1::int[])', [ids.booths]);
    await pool.query('DELETE FROM event_exhibitors WHERE event_id = $1', [eventId]);
    await pool.query('DELETE FROM exhibitor_import_runs WHERE id = ANY($1::int[])', [ids.runs]);
    if (ids.contacts.length) {
      await pool.query(`DELETE FROM communication_attachments WHERE communication_id IN
        (SELECT id FROM communications WHERE contact_id = ANY($1::int[]))`, [ids.contacts]);
      await pool.query(`UPDATE communications SET parent_email_id = NULL WHERE contact_id = ANY($1::int[])`, [ids.contacts]);
      await pool.query('DELETE FROM communications WHERE contact_id = ANY($1::int[])', [ids.contacts]);
      await db.deleteContacts(ids.contacts);
    }
    await pool.query('DELETE FROM crm_activity WHERE company_id = ANY($1::int[])', [ids.companies]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [ids.companies]);
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
  } finally {
    await pool.end();
  }
});

test('company outreach status follows the defined progression', async () => {
  const expect = {
    unmatched: 'unmatched', noContact: 'no_contact', noEmail: 'no_email', needs: 'needs_draft',
    drafted: 'drafted', partial: 'contacted_partial', all: 'contacted_all',
  };
  for (const [k, status] of Object.entries(expect)) {
    const r = await rowFor(F[k]);
    assert.ok(r, `row for ${k}`);
    assert.equal(r.outreach_status, status, k);
  }
});

test('an ingested email is not a send; trashed, archived and follow-up drafts are not drafts', async () => {
  const r = await rowFor(F.needs);
  assert.equal(r.sent, 0);
  assert.equal(r.drafted, 0);
  assert.equal(r.emailable, 1);
});

test('one sent contact does not make the whole company Sent', async () => {
  const r = await rowFor(F.partial);
  assert.equal(r.contacts, 3);
  assert.equal(r.emailable, 2, 'duplicate address counted once');
  assert.equal(r.sent, 1);
  assert.equal(r.outreach_status, 'contacted_partial');
});

test('a shared booth yields one row per company, each showing the booth', async () => {
  const a = await rowFor(F.noContact);
  const b = await rowFor(F.shared);
  assert.equal(a.booths, '3626');
  assert.equal(b.booths, '3626');
  const { rows } = await outreach.listExhibitors(pool, eventId, { booth: '3626' }, { all: true });
  assert.deepEqual(rows.map((r) => r.exhibitor_id).sort(), [F.noContact, F.shared].sort());
});

test('classification: curated label wins over the map; labels under review are hidden', async () => {
  const d = await rowFor(F.drafted);
  assert.equal(d.classification, 'target_customer');
  assert.equal(d.classification_source, 'curated');
  const n = await rowFor(F.needs);
  assert.equal(n.classification, 'batmat', 'falls back to the map category');
  assert.equal(n.classification_source, 'map');
  const { rows } = await outreach.listExhibitors(pool, eventId, { classification: 'target_customer' }, { all: true });
  assert.deepEqual(rows.map((r) => r.exhibitor_id), [F.drafted]);
});

test('withdrawn exhibitors are hidden unless asked for', async () => {
  assert.equal(await rowFor(F.withdrawn), undefined);
  const r = await rowFor(F.withdrawn, { include_withdrawn: 'true' });
  assert.equal(r.attendance_status, 'retired');
});

test('filters: search reaches contacts, status and yes/no filters, pagination totals', async () => {
  const byContact = await outreach.listExhibitors(pool, eventId, { q: 'drafted person' }, { all: true });
  assert.deepEqual(byContact.rows.map((r) => r.exhibitor_id), [F.drafted]);

  const needs = await outreach.listExhibitors(pool, eventId, { status: 'needs_outreach' }, { all: true });
  assert.deepEqual(needs.rows.map((r) => r.exhibitor_id).sort(), [F.needs, F.drafted].sort());

  const noEmail = await outreach.listExhibitors(pool, eventId, { has_email: 'no' }, { all: true });
  assert.deepEqual(noEmail.rows.map((r) => r.exhibitor_id).sort(),
    [F.unmatched, F.noContact, F.shared, F.noEmail].sort());

  const page1 = await outreach.listExhibitors(pool, eventId, {}, { page: 1, page_size: 3 });
  const page3 = await outreach.listExhibitors(pool, eventId, {}, { page: 3, page_size: 3 });
  assert.equal(page1.total, 8);
  assert.equal(page1.rows.length, 3);
  assert.equal(page3.rows.length, 2);
  const beyond = await outreach.listExhibitors(pool, eventId, {}, { page: 9, page_size: 3 });
  assert.equal(beyond.rows.length, 0);
  assert.equal(beyond.total, 8, 'an empty page still reports the true total');

  const huge = await outreach.listExhibitors(pool, eventId, {}, { page: 1, page_size: 100000 });
  assert.equal(huge.page_size, 100, 'page size is capped');
});

test('summary KPIs are exact and company-level', async () => {
  const { kpis } = await outreach.summary(pool, eventId);
  assert.deepEqual({
    exhibitors: kpis.exhibitors, unmatched: kpis.unmatched, with_contacts: kpis.with_contacts,
    with_email: kpis.with_email, drafted: kpis.drafted, sent: kpis.sent,
    needs_outreach: kpis.needs_outreach, sent_contacts: kpis.sent_contacts,
    needs_discovery: kpis.needs_discovery,
  }, {
    exhibitors: 8, unmatched: 1, with_contacts: 5, with_email: 4, drafted: 1, sent: 2,
    needs_outreach: 2, sent_contacts: 2, needs_discovery: 3,
  });
});

test('contact detail: per-contact status, CRM row shape, best contact only with evidence', async () => {
  const d = await outreach.exhibitorDetail(pool, F.partial);
  const byName = Object.fromEntries(d.contacts.map((c) => [c.full_name.replace(/^ZZOUT_|_.*$/g, ''), c]));
  assert.equal(byName['Sent A'].status, 'sent');
  assert.equal(byName['Sent A'].last_sent_source, 'system');
  assert.equal(byName['Sent A'].last_sent_user, 'alice');
  assert.equal(byName.B.status, 'no_draft');
  for (const k of ['id', 'full_name', 'job_title', 'email', 'apollo_person_id', 'first_name', 'last_name']) {
    assert.ok(k in byName.B, `CRM shape carries ${k}`);
  }
  assert.ok(!('meeting_notes' in byName.B), 'notes stay on the server');
  // B is a Director of Manufacturing (title-derived); nobody else has evidence.
  assert.equal(d.best_contact && d.best_contact.contact_id, F.b);
  assert.equal(d.best_contact.basis, 'title');
  assert.equal(d.exhibitor.event_id, eventId);

  const locked = await outreach.exhibitorDetail(pool, F.noEmail);
  assert.equal(locked.contacts[0].status, 'email_locked');
  assert.equal(locked.best_contact, null);

  const unmatched = await outreach.exhibitorDetail(pool, F.unmatched);
  assert.deepEqual(unmatched.contacts, []);
  assert.equal(await outreach.exhibitorDetail(pool, 2147483000), null);
});

test('mark sent: recorded with user, draft untouched, duplicates and bad input refused, undo via trash', async () => {
  const row = await outreach.markSent(db, { contactId: F.draftedContact, sentAt: '2026-09-15',
    draftId: F.draftRow.id, userId: 'carol', eventId });
  assert.equal(row.comm_type, 'imported_email');
  assert.equal(row.source, 'manual_entry');
  assert.equal(row.user_id, 'carol');
  assert.equal(row.to_email, 'drafted@example.com');
  assert.equal(row.subject, 'Hello', 'draft content copied into the history');
  assert.equal(new Date(row.sent_at).toISOString(), '2026-09-15T12:00:00.000Z');

  const draftAfter = await db.getCommunication(F.draftRow.id);
  assert.equal(draftAfter.delivery_status, null, 'the draft is not claimed as delivered');
  assert.equal(draftAfter.sent_at, null);

  const r = await rowFor(F.drafted);
  assert.equal(r.outreach_status, 'contacted_all');

  await assert.rejects(outreach.markSent(db, { contactId: F.draftedContact, sentAt: '2026-09-15', userId: 'carol', eventId }),
    { code: 'duplicate', status: 409 });
  await assert.rejects(outreach.markSent(db, { contactId: F.lockedContact, userId: 'carol', eventId }),
    { code: 'no_email' });
  await assert.rejects(outreach.markSent(db, { contactId: F.needsContact, draftId: F.draftRow.id, userId: 'carol', eventId }),
    { code: 'bad_draft' }, "another contact's draft");
  await assert.rejects(outreach.markSent(db, { contactId: 2147483000, userId: 'carol', eventId }), { code: 'not_found' });
  await assert.rejects(outreach.markSent(db, { contactId: F.needsContact, sentAt: '2999-01-01', userId: 'carol', eventId }),
    { code: 'future_date' });
  await assert.rejects(outreach.markSent(db, { contactId: F.outsider, userId: 'carol', eventId }),
    { code: 'not_exhibitor_contact' }, 'a contact at a company that is not exhibiting');
  await assert.rejects(outreach.markSent(db, { contactId: F.needsContact, userId: 'carol', eventId: null }),
    { code: 'no_event' });

  const { rows: [audit] } = await pool.query(
    `SELECT actor FROM crm_activity WHERE action = 'outreach.mark_sent' AND object_id = $1`, [String(row.id)]);
  assert.equal(audit.actor, 'carol');

  // Undo accepts only a hand-recorded send, and only once.
  const systemSent = (await pool.query(`SELECT id FROM communications WHERE contact_id = $1 AND delivery_status = 'sent'`,
    [F.sentA])).rows[0].id;
  await assert.rejects(outreach.undoManualSent(db, { communicationId: systemSent, userId: 'carol' }), { code: 'not_manual' });
  await assert.rejects(outreach.undoManualSent(db, { communicationId: F.draftRow.id, userId: 'carol' }), { code: 'not_manual' });
  await assert.rejects(outreach.undoManualSent(db, { communicationId: 2147483000, userId: 'carol' }), { code: 'not_found' });
  const undoneRow = await outreach.undoManualSent(db, { communicationId: row.id, userId: 'carol' });
  assert.equal(undoneRow.contact_id, F.draftedContact);
  await assert.rejects(outreach.undoManualSent(db, { communicationId: row.id, userId: 'carol' }), { code: 'not_found' });
  const stillThere = await db.getCommunication(row.id);
  assert.ok(stillThere && stillThere.deleted_at, 'soft-deleted, not removed');
  const undone = await rowFor(F.drafted);
  assert.equal(undone.outreach_status, 'drafted', 'undo returns the contact to Drafted');
  assert.equal((await rowFor(F.partial)).sent, 1, 'the system send elsewhere is untouched');
});

test('export: one row per contact, exhibitors without contacts still present, view respects filters', async () => {
  const all = await outreach.exportRows(pool, eventId, {});
  const forEx = (id) => all.filter((r) => r.exhibitor_id === id);
  assert.equal(forEx(F.unmatched).length, 1);
  assert.equal(forEx(F.unmatched)[0].contact_name, '');
  assert.equal(forEx(F.unmatched)[0].company_match, 'Unmatched');
  assert.equal(forEx(F.noContact).length, 1);
  assert.equal(forEx(F.partial).length, 3);
  assert.ok(forEx(F.partial).every((r) => r.booth === '3000' && r.outreach_status === 'Contacted (partial)'));
  const bestRows = forEx(F.partial).filter((r) => r.best_contact === 'Yes');
  assert.equal(bestRows.length, 1);
  assert.match(bestRows[0].best_contact_reason, /^Job title only: Director\+/);
  const locked = forEx(F.noEmail)[0];
  assert.equal(locked.email, '', 'Apollo placeholders are not exported as addresses');
  assert.equal(forEx(F.withdrawn).length, 0);
  assert.equal(new Set(all.map((r) => r.exhibitor_id)).size, 8);

  const view = await outreach.exportRows(pool, eventId, { status: 'needs_outreach' });
  assert.deepEqual([...new Set(view.map((r) => r.exhibitor_id))].sort(), [F.needs, F.drafted].sort());

  const ExcelJS = require('exceljs');
  const buf = await outreach.rowsToXlsx(all);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Exhibitor Outreach');
  assert.equal(ws.rowCount, all.length + 1);
  assert.equal(ws.getRow(1).getCell(1).value, 'Company');
  assert.deepEqual(outreach.EXPORT_COLUMNS.slice(0, 10).map((c) => c.header), ['Company', 'Booth', 'Classification',
    'Contact Name', 'Title', 'Email', 'Draft Status', 'Sent Status', 'Sent Date', 'Outreach Status']);
});

test('drafting context: listed exhibitors get event + booths; others get nothing', async () => {
  const ctx = await outreach.exhibitorContextForCompany(pool, F.draftedCo);
  assert.equal(ctx.eventName, T('Battery Show'));
  assert.deepEqual(ctx.booths, ['2002', '2004']);
  const noBooth = await outreach.exhibitorContextForCompany(pool, F.withdrawnCo);
  assert.equal(noBooth, null, 'a withdrawn exhibitor is not described as exhibiting');
  assert.equal(await outreach.exhibitorContextForCompany(pool, null), null);
  // Nothing is written back to the company row.
  const { rows: [co] } = await pool.query('SELECT event_id FROM companies WHERE id = $1', [F.draftedCo]);
  assert.equal(co.event_id, null);
});

test('resolveEventId prefers the latest successful refresh, and rejects unknown ids', async () => {
  assert.equal(await outreach.resolveEventId(pool), eventId);
  assert.equal(await outreach.resolveEventId(pool, String(eventId)), eventId);
  assert.equal(await outreach.resolveEventId(pool, 2147483000), null);
});

test('in-app sends and manual entries record the user', async () => {
  const d = await draft(F.b);
  const sent = await db.markCommunicationSend(d.id, { delivery_status: 'sent', sent_at: new Date(), user_id: 'dave' });
  assert.equal(sent.user_id, 'dave');
  const plain = await draft(F.b);
  assert.equal(plain.user_id, null, 'writers that pass no user still work');
});

test('export current view covers exactly the companies in the filtered table, with all their contacts', async () => {
  const filterSets = [
    {}, { status: 'needs_outreach' }, { status: 'contacted' }, { has_contacts: 'no' }, { has_email: 'yes' },
    { drafted: 'yes', sent: 'no' }, { classification: 'target_customer' }, { classification: 'none' },
    { booth: '3626' }, { q: 'person' }, { q: 'zz-no-match' }, { include_withdrawn: 'true' },
    { status: 'unmatched' }, { sort: 'booth', has_contacts: 'yes' },
  ];
  for (const f of filterSets) {
    const table = await outreach.listExhibitors(pool, eventId, f, { all: true });
    const rows = await outreach.exportRows(pool, eventId, f);
    const label = JSON.stringify(f);
    assert.deepEqual([...new Set(rows.map((r) => r.exhibitor_id))].sort(), table.rows.map((r) => r.exhibitor_id).sort(), label);
    for (const t of table.rows) {
      const n = rows.filter((r) => r.exhibitor_id === t.exhibitor_id).length;
      assert.equal(n, Math.max(1, t.contacts), `${label}: exhibitor ${t.exhibitor_id} exports every contact (or one blank row)`);
    }
  }
  // Contact search selects the company; the export still carries its other contacts.
  const byName = await outreach.exportRows(pool, eventId, { q: 'sent a' });
  assert.equal(byName.filter((r) => r.exhibitor_id === F.partial).length, 3);
});

test('draft event context: the current exhibitor list decides; legacy event ids do not leak the show', async () => {
  const listed = await outreach.draftEventContext(pool, { id: F.draftedCo, event_id: null });
  assert.deepEqual(listed, { eventName: T('Battery Show'), booths: ['2002', '2004'], source: 'exhibitor' });

  // Withdrawn exhibitor whose company row still says "this show": no show context.
  assert.equal(await outreach.draftEventContext(pool, { id: F.withdrawnCo, event_id: eventId }), null);
  // Not exhibiting at all, legacy id pointing at the show: none either.
  assert.equal(await outreach.draftEventContext(pool, { id: F.outsiderCo, event_id: eventId }), null);
  assert.equal(await outreach.draftEventContext(pool, { id: F.outsiderCo, event_id: null }), null);

  // A different event keeps its old meaning.
  const { rows: [other] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [T('Other Expo')]);
  try {
    assert.deepEqual(await outreach.draftEventContext(pool, { id: F.outsiderCo, event_id: other.id }),
      { eventName: T('Other Expo'), source: 'company' });
  } finally {
    await pool.query('DELETE FROM events WHERE id = $1', [other.id]);
  }
});
