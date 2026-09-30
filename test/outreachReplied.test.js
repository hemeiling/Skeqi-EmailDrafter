/* Sent → Replied. When a reply arrives, db.recordEmailReply flips the sent
   row's delivery_status from 'sent' to 'replied'. A reply is stronger proof
   of contact than a send, so the contact must stay Sent and the company stay
   Contacted — in the contact status, the company status, the KPIs, the
   Needs-outreach filter and the export. This drives the real reply path.

   Runs only against TEST_DATABASE_URL; its own throwaway event. */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const dbGuard = require('./dbGuard');

if (!dbGuard.available) {
  test('outreach replied suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
  return;
}

const db = require('../db');
const outreach = require('../outreach');
const { pool } = db;

const RUN = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const T = (s) => `ZZREP${RUN}_${s}`;
const ids = { companies: [], contacts: [], exhibitors: [], runs: [] };
const F = {};
let eventId;

async function company(name) {
  const { rows: [r] } = await pool.query('INSERT INTO companies (name, source) VALUES ($1, $2) RETURNING id', [T(name), 'manual']);
  ids.companies.push(r.id); return r.id;
}
async function contact(companyId, name, email) {
  const id = await db.insertContact({ company_id: companyId, company: '', full_name: T(name), email });
  ids.contacts.push(id); return id;
}
async function exhibitor(name, companyId) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name, company_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [eventId, T(`src_${name}`), T(name), companyId]);
  ids.exhibitors.push(r.id); return r.id;
}
const draft = (contactId) => db.insertCommunication({ contact_id: contactId, comm_type: 'draft', status: 'draft',
  draft_mode: 'cold_outreach', subject: 'Hello', body: 'Body' });
const row = async (exId) => (await outreach.listExhibitors(pool, eventId, {}, { all: true })).rows.find((r) => r.exhibitor_id === exId);
const kpis = async () => (await outreach.summary(pool, eventId)).kpis;
const statusOf = async (exId, contactId) => (await outreach.exhibitorDetail(pool, exId)).contacts.find((c) => c.id === contactId);

test.before(async () => {
  await db.initDb();
  const { rows: [ev] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [T('Show')]);
  eventId = ev.id;
  const { rows: [run] } = await pool.query(
    `INSERT INTO exhibitor_import_runs (event_id, status, dry_run, finished_at) VALUES ($1,'success',FALSE, NOW() + interval '3 days') RETURNING id`, [eventId]);
  ids.runs.push(run.id);

  // System send that will be replied to.
  F.repCo = await company('Replied Co'); F.rep = await exhibitor('Replied Co', F.repCo);
  F.repContact = await contact(F.repCo, 'Rae', 'rae@replied.example');
  F.repDraft = await draft(F.repContact);
  F.msgId = `<${RUN}@skq.test>`;
  await db.markCommunicationSend(F.repDraft.id, { delivery_status: 'sent', sent_at: new Date(), message_id: F.msgId, user_id: 'alice' });

  // Manual Mark Sent.
  F.manCo = await company('Manual Co'); F.man = await exhibitor('Manual Co', F.manCo);
  F.manContact = await contact(F.manCo, 'Max', 'max@manual.example');
  await db.insertManualEmail({ contactId: F.manContact, companyId: F.manCo, toEmail: 'max@manual.example',
    sentAt: '2026-09-01T12:00:00Z', userId: 'bob' });

  // Drafted, never sent.
  F.drCo = await company('Drafted Co'); F.dr = await exhibitor('Drafted Co', F.drCo);
  F.drContact = await contact(F.drCo, 'Dee', 'dee@drafted.example');
  await draft(F.drContact);

  // Emailable, nothing yet.
  F.ndCo = await company('Needs Co'); F.nd = await exhibitor('Needs Co', F.ndCo);
  F.ndContact = await contact(F.ndCo, 'Ned', 'ned@needs.example');
});

test.after(async () => {
  try {
    await pool.query('DELETE FROM email_replies WHERE contact_id = ANY($1::int[])', [ids.contacts]);
    await pool.query('DELETE FROM event_exhibitors WHERE id = ANY($1::int[])', [ids.exhibitors]);
    await pool.query('DELETE FROM exhibitor_import_runs WHERE id = ANY($1::int[])', [ids.runs]);
    await pool.query('UPDATE communications SET parent_email_id = NULL WHERE contact_id = ANY($1::int[])', [ids.contacts]);
    await pool.query('DELETE FROM communications WHERE contact_id = ANY($1::int[])', [ids.contacts]);
    await db.deleteContacts(ids.contacts);
    await pool.query('DELETE FROM crm_activity WHERE company_id = ANY($1::int[])', [ids.companies]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [ids.companies]);
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
  } finally { await pool.end(); }
});

const EXPECTED = {
  exhibitors: 4, sent: 2, drafted: 1, needs_outreach: 2, sent_contacts: 2, drafted_contacts: 1, needs_outreach_contacts: 2,
};
const pickK = (k) => Object.fromEntries(Object.keys(EXPECTED).map((x) => [x, k[x]]));

test('before the reply: sent, marked sent, drafted and needs outreach are distinct', async () => {
  assert.deepEqual(pickK(await kpis()), EXPECTED);
  assert.equal((await statusOf(F.rep, F.repContact)).status, 'sent');
  assert.equal((await statusOf(F.man, F.manContact)).status, 'sent');
  assert.equal((await statusOf(F.man, F.manContact)).last_sent_source, 'manual');
  assert.equal((await statusOf(F.dr, F.drContact)).status, 'drafted', 'Drafted stays distinct from Sent');
  assert.equal((await statusOf(F.nd, F.ndContact)).status, 'no_draft');
});

test('after the reply: the replied contact is still Sent, and nothing else moves', async () => {
  const before = await kpis();
  const r = await db.recordEmailReply({ inReplyTo: F.msgId, replyMessageId: `<re-${RUN}@example>`,
    fromEmail: 'rae@replied.example', snippet: 'Thanks' });
  assert.ok(r && !r.duplicate, 'the reply was matched to our send');
  const { rows: [m] } = await pool.query('SELECT delivery_status, replied_at FROM communications WHERE id = $1', [F.repDraft.id]);
  assert.equal(m.delivery_status, 'replied', 'the real reply path flipped the row');
  assert.ok(m.replied_at);

  const c = await statusOf(F.rep, F.repContact);
  assert.equal(c.status, 'sent', 'replied is not "unsent"');
  assert.equal(c.last_sent_id, F.repDraft.id);
  assert.equal(c.contact_id ?? c.id, F.repContact, 'same canonical contact');
  assert.equal(c.replied, true);
  assert.equal(c.draft_id, null, 'the replied draft is not counted as an open draft');

  const rr = await row(F.rep);
  assert.equal(rr.sent, 1);
  assert.equal(rr.outreach_status, 'contacted_all');
  assert.deepEqual(pickK(await kpis()), pickK(before), 'KPIs unchanged by a reply');

  // Needs-outreach and Contacted filters.
  const needs = await outreach.listExhibitors(pool, eventId, { status: 'needs_outreach' }, { all: true });
  assert.ok(!needs.rows.some((x) => x.exhibitor_id === F.rep), 'a replied exhibitor does not need outreach');
  const contacted = await outreach.listExhibitors(pool, eventId, { status: 'contacted' }, { all: true });
  assert.ok(contacted.rows.some((x) => x.exhibitor_id === F.rep));
  const sentYes = await outreach.listExhibitors(pool, eventId, { sent: 'yes' }, { all: true });
  assert.deepEqual(sentYes.rows.map((x) => x.exhibitor_id).sort(), [F.rep, F.man].sort());

  // Export carries the send.
  const exp = await outreach.exportRows(pool, eventId, {});
  const line = exp.find((x) => x.exhibitor_id === F.rep && x.email === 'rae@replied.example');
  assert.ok(line, 'export row for the replied contact');
  assert.equal(line.sent_status, 'Sent');
  assert.ok(line.sent_date, 'export shows the send date');
});

test('trashing the replied send un-sends it, restoring it re-sends it', async () => {
  // Trashing the replied send removes it, as for any send.
  await pool.query('UPDATE communications SET deleted_at = NOW() WHERE id = $1', [F.repDraft.id]);
  try {
    assert.equal((await statusOf(F.rep, F.repContact)).status, 'no_draft');
  } finally {
    await pool.query('UPDATE communications SET deleted_at = NULL WHERE id = $1', [F.repDraft.id]);
  }
  assert.equal((await statusOf(F.rep, F.repContact)).status, 'sent');
});
