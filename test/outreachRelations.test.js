/* Exhibitor Outreach — human-reviewed related company records.
   Ranking/evidence, authorization, and the two decision lifecycles. */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const dbGuard = require('./dbGuard');

const domains = require('../domains');
const rel = require('../outreachRelations');

/* ── Pure: domains and authorization ─────────────────────────────────────── */

test('registrable domain uses the Public Suffix List, including two-level suffixes', () => {
  assert.equal(domains.registrableDomain('https://www.enpack.com.cn/about'), 'enpack.com.cn');
  assert.equal(domains.registrableDomain('mail.gotion.com.cn'), 'gotion.com.cn');
  assert.notEqual(domains.registrableDomain('enpack.com.cn'), domains.registrableDomain('gotion.com.cn'), 'sharing .com.cn is not a match');
  assert.equal(domains.registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(domains.registrableDomain('WWW.AITechnology.com'), 'aitechnology.com');
  assert.equal(domains.registrableDomain(''), null);
  assert.equal(domains.registrableDomain('(email available via Apollo)'), null);
});

test('free-mail and placeholder addresses are never company evidence', () => {
  assert.equal(domains.companyEmailDomain('a@gmail.com'), null);
  assert.equal(domains.companyEmailDomain('b@qq.com'), null);
  assert.equal(domains.companyEmailDomain('c@163.com'), null);
  assert.equal(domains.companyEmailDomain('(email available via Apollo, not returned in payload)'), null);
  assert.equal(domains.companyEmailDomain('d@sales.enpack.com.cn'), 'enpack.com.cn');
});

test('decide and revoke require canReview === true (the server passes isAdmin(req)); anything else is 403', async () => {
  // Refused before any database access, so no pool is needed.
  for (const canReview of [false, undefined, null, 'true', 1, {}]) {
    await assert.rejects(rel.setDecision(null, { exhibitorId: 1, companyId: 2, decision: 'same_company', user: 'x', canReview }),
      { status: 403, code: 'forbidden', message: /Only administrators can record/ }, String(canReview));
    await assert.rejects(rel.revokeDecision(null, { relationId: 1, user: 'x', canReview }),
      { status: 403, code: 'forbidden', message: /Only administrators can revoke/ }, String(canReview));
  }
  assert.equal('canReviewRelations' in rel, false, 'no separate ADMIN_USERS allowlist in the relation feature');
});

test('evaluateCandidate: evidence for and against, tiers, shared account is only a note', () => {
  const ex = { exhibitor_id: 1, company_id: 10, name: 'Enpack', key: 'enpack', website: 'www.enpack.com.cn', domain: 'enpack.com.cn', account_id: 7 };
  const base = { account_id: null, contacts: 2, emailable: 2 };
  const strong = rel.evaluateCandidate(ex, { ...base, id: 11, name: 'Enpack Composite', key: 'enpack composite', emails: ['a@enpack.com.cn', 'b@gmail.com'] });
  assert.equal(strong.tier, 'strong');
  assert.ok(strong.for.some((f) => f.key === 'email_domain' && /1 of 1 work email at enpack\.com\.cn/.test(f.label)), JSON.stringify(strong.for));
  const suffixOnly = rel.evaluateCandidate(ex, { ...base, id: 12, name: 'Enpack Trading', key: 'enpack trading', emails: ['x@gotion.com.cn'] });
  assert.equal(suffixOnly.tier, 'unlikely', 'a .com.cn email at another company is evidence AGAINST');
  assert.ok(suffixOnly.against.some((a) => a.key === 'emails_elsewhere'));
  const nameOnly = rel.evaluateCandidate(ex, { ...base, id: 13, name: 'Enpack Holdings', key: 'enpack holdings', emails: ['x@gmail.com'], account_id: 7 });
  assert.equal(nameOnly.tier, 'possible');
  assert.ok(nameOnly.caveats.some((c) => c.key === 'candidate_no_domain'));
  assert.equal(nameOnly.shared_account, true);
  assert.ok(!nameOnly.for.some((f) => /account/i.test(f.label)), 'shared account never appears as evidence');
  const conflicting = rel.evaluateCandidate(ex, { ...base, id: 14, name: 'Enpack Co., Ltd.', key: 'enpack', website: 'other.com', emails: [] });
  assert.equal(conflicting.tier, 'possible');
  assert.equal(conflicting.conflicting, true);
  const none = rel.evaluateCandidate(ex, { ...base, id: 15, name: 'Unrelated', key: 'unrelated', emails: [], account_id: 7 });
  assert.equal(none.tier, null, 'no signal → not a candidate, however the account looks');
});

if (!dbGuard.available) {
  test('relations database suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
  return;
}

const db = require('../db');
const outreach = require('../outreach');
const { pool } = db;
const RUN = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const T = (s) => `ZZREL${RUN} ${s}`;
const ids = { companies: [], contacts: [], exhibitors: [], runs: [], events: [] };
const F = {};

async function company(name, fields = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO companies (name, name_key, website, account_id, source) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, require('../companyKey').normalizeNameKey(name), fields.website || null, fields.account_id || null, fields.source || 'manual']);
  ids.companies.push(r.id); return r.id;
}
async function contact(companyId, name, email) {
  const id = await db.insertContact({ company_id: companyId, company: '', full_name: name, email, job_title: 'Director of Manufacturing' });
  ids.contacts.push(id); return id;
}
async function exhibitor(eventId, name, companyId, booths) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO event_exhibitors (event_id, exhibitor_source_id, source_name, company_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [eventId, `${name}_src`, name, companyId]);
  ids.exhibitors.push(r.id);
  for (const b of booths || []) await pool.query('INSERT INTO exhibitor_booths (exhibitor_id, booth_number) VALUES ($1,$2)', [r.id, b]);
  return r.id;
}
const panel = (exhibitorId, canReview = true) => rel.relatedPanel(pool, { exhibitorId, eventId: F.event, canReview });
const where = (p, companyId) => ['strong', 'possible', 'unlikely', 'reviewed', 'rejected'].find((k) => p[k].some((c) => c.candidate.id === companyId)) || null;

test.before(async () => {
  await db.initDb();
  const { rows: [ev] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [T('Show')]);
  const { rows: [old] } = await pool.query('INSERT INTO events (name) VALUES ($1) RETURNING id', [T('Old Show')]);
  F.event = ev.id; ids.events.push(ev.id, old.id);
  const { rows: [acct] } = await pool.query('INSERT INTO accounts (name) VALUES ($1) RETURNING id', [T('Acct')]);
  F.account = acct.id;

  F.direct = await company(T('Enpack'), { website: 'https://www.enpack.com.cn', account_id: acct.id });
  F.ex = await exhibitor(ev.id, T('Enpack'), F.direct, ['3718', '3720']);
  // Candidates, each built to land in a specific tier.
  F.strong = await company(T('Enpack Composite'));
  await contact(F.strong, 'Strong One', 'one@enpack.com.cn');
  F.possible = await company(T('Enpack Trading'), { account_id: acct.id });          // name only + free mail + shared account
  F.possibleContact = await contact(F.possible, 'Poss One', 'poss@gmail.com');
  await contact(F.possible, 'Poss Two', '(email available via Apollo, not returned in payload)');
  F.unlikely = await company(T('Enpack Holdings'), { website: 'enpack-holdings.de' });
  await contact(F.unlikely, 'Unl One', 'u@enpack-holdings.de');
  F.gotion = await company(T('Gotion'));                                            // shares only ".com.cn"
  await contact(F.gotion, 'Got One', 'g@gotion.com.cn');
  F.accountOnly = await company(T('Totally Different'), { account_id: acct.id });    // shares only the account
  await contact(F.accountOnly, 'Acc One', 'a@different.example');

  F.oldEx = await exhibitor(old.id, T('Enpack'), F.direct, []);
  const { rows: [run] } = await pool.query(
    `INSERT INTO exhibitor_import_runs (event_id, status, dry_run, finished_at) VALUES ($1,'success',FALSE, NOW() + interval '1 day') RETURNING id`, [ev.id]);
  ids.runs.push(run.id);
});

test.after(async () => {
  try {
    await pool.query('DELETE FROM exhibitor_company_relations WHERE exhibitor_id = ANY($1::int[])', [ids.exhibitors]);
    await pool.query('DELETE FROM crm_activity WHERE company_id = ANY($1::int[]) OR actor = $2', [ids.companies, 'reviewer']);
    await pool.query('DELETE FROM communications WHERE contact_id = ANY($1::int[])', [ids.contacts]);
    await db.deleteContacts(ids.contacts);
    await pool.query('DELETE FROM event_exhibitors WHERE id = ANY($1::int[])', [ids.exhibitors]);
    await pool.query('DELETE FROM exhibitor_import_runs WHERE id = ANY($1::int[])', [ids.runs]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [ids.companies]);
    await pool.query('DELETE FROM accounts WHERE id = $1', [F.account]);
    await pool.query('DELETE FROM events WHERE id = ANY($1::int[])', [ids.events]);
  } finally { await pool.end(); }
});

test('panel: direct company first, then strong / possible / unlikely; suffix-only and account-only never appear', async () => {
  const p = await panel(F.ex);
  assert.equal(p.direct.company_id, F.direct);
  assert.equal(p.direct.domain, 'enpack.com.cn');
  assert.equal(where(p, F.strong), 'strong');
  assert.equal(where(p, F.possible), 'possible');
  assert.equal(where(p, F.unlikely), 'unlikely');
  assert.equal(where(p, F.gotion), null, '.com.cn alone is not a signal');
  assert.equal(where(p, F.accountOnly), null, 'a shared account alone is not a signal');
  const poss = p.possible.find((c) => c.candidate.id === F.possible);
  assert.equal(poss.shared_account, true);
  assert.equal(poss.candidate.contacts, 2);
  assert.equal(poss.candidate.emailable, 1);
  assert.ok(poss.provenance && 'company_source' in poss.provenance && poss.provenance.contact_sources);
  assert.ok(p.strong[0].for.length && p.strong[0].against.length === 0);
  assert.ok(p.unlikely[0].against.length > 0, 'every unlikely candidate says why');
  assert.equal(p.can_review, true);
  assert.equal((await panel(F.ex, false)).can_review, false);
  assert.match(p.account_note, /not evidence of identity/);
});

test('authorization is enforced in the module: non-reviewers cannot decide or revoke, and nothing is written', async () => {
  for (const canReview of [false, undefined]) {
    await assert.rejects(rel.setDecision(pool, { exhibitorId: F.ex, companyId: F.strong, decision: 'same_company', user: 'reviewer', eventId: F.event, canReview }),
      { status: 403, code: 'forbidden' });
  }
  await assert.rejects(rel.revokeDecision(pool, { relationId: 1, user: 'reviewer', eventId: F.event, canReview: false }), { status: 403 });
  const { rows: [n] } = await pool.query('SELECT count(*)::int n FROM exhibitor_company_relations WHERE exhibitor_id = $1', [F.ex]);
  assert.equal(n.n, 0);
});

test('bad decisions are refused: direct company, non-candidate, other event, unknown decision, missing reason', async () => {
  const d = (over) => rel.setDecision(pool, { exhibitorId: F.ex, companyId: F.strong, decision: 'same_company', user: 'reviewer', eventId: F.event, canReview: true, ...over });
  await assert.rejects(d({ companyId: F.direct }), { code: 'direct_company' });
  await assert.rejects(d({ companyId: F.gotion }), { code: 'not_candidate' });
  await assert.rejects(d({ companyId: F.accountOnly }), { code: 'not_candidate' });
  await assert.rejects(d({ exhibitorId: F.oldEx }), { code: 'not_found' });
  await assert.rejects(d({ decision: 'merge' }), { code: 'bad_decision' });
  await assert.rejects(d({ companyId: F.possible }), { code: 'reason_required' }, 'name-only evidence needs a stated reason');
});

test('lifecycle: undecided → same company → outreach → revoke → gone from current, history intact', async () => {
  const kpisBefore = (await outreach.summary(pool, F.event)).kpis;
  const rowBefore = (await outreach.listExhibitors(pool, F.event, { exhibitor: F.ex }, { all: true })).rows[0];
  assert.equal(rowBefore.reviewed_contacts, 0);

  const r = await rel.setDecision(pool, { exhibitorId: F.ex, companyId: F.possible, decision: 'same_company',
    reason: 'Trade registry lists Enpack Trading as the export arm', user: 'reviewer', eventId: F.event, canReview: true });
  assert.equal(r.decided_by, 'reviewer');
  assert.equal(r.evidence.tier, 'possible', 'evidence snapshot is server-computed');
  assert.equal(r.evidence.shared_account, true);

  // Reviewed section; contacts available, labelled, still on their own company.
  assert.equal(where(await panel(F.ex), F.possible), 'reviewed');
  const det = await outreach.exhibitorDetail(pool, F.ex);
  assert.equal(det.contacts.length, 0, 'direct contacts unchanged');
  assert.equal(det.reviewed.length, 1);
  assert.equal(det.reviewed[0].relation.id, r.id);
  assert.ok(det.reviewed[0].contacts.every((c) => c.link_type === 'reviewed' && c.relation_id === r.id && c.company_id === F.possible));
  const row = (await outreach.listExhibitors(pool, F.event, { exhibitor: F.ex }, { all: true })).rows[0];
  assert.equal(row.reviewed_contacts, 2);
  assert.equal(row.contacts, rowBefore.contacts, 'direct count unchanged');
  assert.equal(row.outreach_status, rowBefore.outreach_status, 'status stays direct-only');
  assert.deepEqual((await outreach.summary(pool, F.event)).kpis, kpisBefore, 'KPIs unchanged');

  // Canonical links untouched.
  const { rows: [e] } = await pool.query('SELECT company_id FROM event_exhibitors WHERE id = $1', [F.ex]);
  assert.equal(e.company_id, F.direct);
  assert.equal((await db.getContact(F.possibleContact)).company_id, F.possible);

  // Drafting context comes from the live relation.
  const ctx = await outreach.draftEventContext(pool, { id: F.possible });
  assert.deepEqual(ctx, { eventName: T('Show'), booths: ['3718', '3720'], source: 'reviewed_relation',
    viaExhibitors: [T('Enpack')], relationIds: [r.id] });
  // The prompt says WHY this contact gets the show, instead of claiming their record is the exhibitor.
  const { buildPromptForMode } = require('../claude');
  const prompt = buildPromptForMode('cold_outreach', { name: 'Poss One', company: T('Enpack Trading') }, { name: 'S' },
    { eventName: ctx.eventName, exhibitorBooths: ctx.booths, exhibitorVia: { exhibitors: ctx.viaExhibitors, relationIds: ctx.relationIds } });
  assert.match(prompt, new RegExp(`reviewed as the same company as the exhibitor "${T('Enpack')}" — booth 3718, 3720`));

  // Mark sent works and records the provenance.
  const sent = await outreach.markSent(db, { contactId: F.possibleContact, sentAt: '2026-09-20', userId: 'reviewer', eventId: F.event });
  const { rows: [audit] } = await pool.query(
    `SELECT metadata FROM crm_activity WHERE action = 'outreach.mark_sent' AND object_id = $1`, [String(sent.id)]);
  assert.equal(audit.metadata.link, 'reviewed');
  assert.equal(audit.metadata.relation_id, r.id);
  // …and the contact's own, user-visible activity log says so too.
  const { rows: [act] } = await pool.query(
    `SELECT description FROM contact_activity WHERE contact_id = $1 AND activity_type = 'email_logged' ORDER BY id DESC LIMIT 1`, [F.possibleContact]);
  assert.match(act.description, new RegExp(`via reviewed related-company relation #${r.id}`));
  const commBefore = await db.getCommunication(sent.id);
  const { rows: actsBefore } = await pool.query('SELECT id, activity_type, description FROM contact_activity WHERE contact_id = $1 ORDER BY id', [F.possibleContact]);

  // Export: reviewed rows carry their provenance.
  const exp = (await outreach.exportRows(pool, F.event, { exhibitor: F.ex })).filter((x) => x.exhibitor_id === F.ex);
  assert.equal(exp.length, 2);
  assert.ok(exp.every((x) => x.contact_link_type === 'Reviewed' && x.reviewed_relation_id === r.id && x.contact_company === T('Enpack Trading')));
  assert.ok(exp.every((x) => x.best_contact === ''), 'best contact stays a direct-contact judgement');

  // Revoke → undecided.
  const rv = await rel.revokeDecision(pool, { relationId: r.id, reason: 'Registry entry was a different firm', user: 'reviewer', eventId: F.event, canReview: true });
  assert.equal(rv.revoked_by, 'reviewer');
  assert.equal(where(await panel(F.ex), F.possible), 'possible', 'reviewable again');
  assert.equal((await outreach.exhibitorDetail(pool, F.ex)).reviewed.length, 0);
  assert.equal((await outreach.listExhibitors(pool, F.event, { exhibitor: F.ex }, { all: true })).rows[0].reviewed_contacts, 0);
  assert.equal(await outreach.draftEventContext(pool, { id: F.possible }), null, 'no show context once revoked');
  await assert.rejects(outreach.markSent(db, { contactId: F.possibleContact, sentAt: '2026-09-21', userId: 'reviewer', eventId: F.event }),
    { code: 'not_exhibitor_contact' });

  // History survives untouched: the send row is identical, the activity log only grew.
  const comm = await db.getCommunication(sent.id);
  assert.deepEqual(comm, commBefore, 'revoking never rewrites or deletes a communication');
  const { rows: actsAfter } = await pool.query('SELECT id, activity_type, description FROM contact_activity WHERE contact_id = $1 ORDER BY id', [F.possibleContact]);
  assert.deepEqual(actsAfter.slice(0, actsBefore.length), actsBefore, 'earlier activity entries unchanged');
  const { rows: [cnt] } = await pool.query('SELECT count(*)::int n FROM communications WHERE contact_id = $1', [F.possibleContact]);
  assert.equal(cnt.n, 1);
  const hist = await rel.relationHistory(pool, { exhibitorId: F.ex, eventId: F.event });
  const h = hist.filter((x) => x.related_company_id === F.possible);
  assert.equal(h.length, 1);
  assert.equal(h[0].decision, 'same_company');
  assert.equal(h[0].revoke_reason, 'Registry entry was a different firm');
  await assert.rejects(rel.revokeDecision(pool, { relationId: r.id, user: 'reviewer', eventId: F.event, canReview: true }), { code: 'already_revoked' });
});

test('lifecycle: undecided → not same company → rejected → revoke → reviewable again', async () => {
  const r = await rel.setDecision(pool, { exhibitorId: F.ex, companyId: F.unlikely, decision: 'not_same_company',
    reason: 'German plastics firm, unrelated', user: 'reviewer', eventId: F.event, canReview: true });
  let p = await panel(F.ex);
  assert.equal(where(p, F.unlikely), 'rejected');
  assert.equal(p.rejected[0].relation.decision, 'not_same_company');
  await assert.rejects(rel.setDecision(pool, { exhibitorId: F.ex, companyId: F.unlikely, decision: 'not_same_company', user: 'reviewer', eventId: F.event, canReview: true }),
    { status: 409, code: 'unchanged' });
  await rel.revokeDecision(pool, { relationId: r.id, user: 'reviewer', eventId: F.event, canReview: true });
  p = await panel(F.ex);
  assert.equal(where(p, F.unlikely), 'unlikely');
});

test('changing a decision revokes the old row and inserts a new one in one step; history is the full timeline', async () => {
  const a = await rel.setDecision(pool, { exhibitorId: F.ex, companyId: F.strong, decision: 'same_company', user: 'reviewer', eventId: F.event, canReview: true });
  const b = await rel.setDecision(pool, { exhibitorId: F.ex, companyId: F.strong, decision: 'not_same_company', reason: 'Checked: separate legal entity', user: 'reviewer', eventId: F.event, canReview: true });
  const { rows } = await pool.query(
    'SELECT id, decision, decided_at, revoked_at, revoke_reason FROM exhibitor_company_relations WHERE exhibitor_id = $1 AND related_company_id = $2 ORDER BY decided_at, id',
    [F.ex, F.strong]);
  assert.deepEqual(rows.map((x) => x.id), [a.id, b.id]);
  assert.ok(rows[0].revoked_at && /^Changed to not_same_company/.test(rows[0].revoke_reason));
  assert.equal(rows[1].revoked_at, null);
  assert.equal(rows[0].revoked_at.getTime(), rows[1].decided_at.getTime(), 'same transaction: the timeline has no gap or overlap');
  const { rows: [live] } = await pool.query(
    'SELECT count(*)::int n FROM exhibitor_company_relations WHERE exhibitor_id = $1 AND related_company_id = $2 AND revoked_at IS NULL', [F.ex, F.strong]);
  assert.equal(live.n, 1, 'never two live decisions for one pair');
  await rel.revokeDecision(pool, { relationId: b.id, user: 'reviewer', eventId: F.event, canReview: true });
});

test('the database itself refuses a second live decision for the same pair', async () => {
  const ins = () => pool.query(
    `INSERT INTO exhibitor_company_relations (exhibitor_id, related_company_id, decision, evidence, decided_by)
     VALUES ($1,$2,'not_same_company','{}','reviewer') RETURNING id`, [F.ex, F.gotion]);
  const { rows: [first] } = await ins();
  await assert.rejects(ins(), { code: '23505' });
  await pool.query('UPDATE exhibitor_company_relations SET revoked_at = NOW(), revoked_by = $2 WHERE id = $1', [first.id, 'reviewer']);
  await assert.rejects(pool.query('UPDATE exhibitor_company_relations SET revoked_at = NOW() WHERE id = $1 AND revoked_by IS NULL', [first.id]).then(() =>
    pool.query(`INSERT INTO exhibitor_company_relations (exhibitor_id, related_company_id, decision, evidence, decided_by, revoked_at)
                VALUES ($1,$2,'not_same_company','{}','reviewer', NOW())`, [F.ex, F.gotion])), { code: '23514' }, 'revoked_at without revoked_by is refused');
});

test('initDb is additive and safe to re-run over existing decisions', async () => {
  const snap = async () => (await pool.query(
    'SELECT id, exhibitor_id, related_company_id, decision, reason, decided_by, decided_at, revoked_at FROM exhibitor_company_relations WHERE exhibitor_id = $1 ORDER BY id', [F.ex])).rows;
  const before = await snap();
  assert.ok(before.length >= 4, 'earlier tests left a history to protect');
  await db.initDb();
  await db.initDb();
  assert.deepEqual(await snap(), before, 'no row added, changed or removed');
  const { rows: idx } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'exhibitor_company_relations' ORDER BY indexname`);
  assert.deepEqual(idx.map((i) => i.indexname), ['exhibitor_company_relations_pkey', 'idx_ecr_company', 'idx_ecr_exhibitor', 'uq_ecr_live']);
  const { rows: [e] } = await pool.query('SELECT company_id FROM event_exhibitors WHERE id = $1', [F.ex]);
  assert.equal(e.company_id, F.direct, 'the canonical exhibitor link is untouched');
});

test('reviewed company later becomes the direct link: shadowed everywhere, history untouched — and applies again when it stops being direct', async () => {
  const r = await rel.setDecision(pool, { exhibitorId: F.ex, companyId: F.strong, decision: 'same_company',
    reason: 'Shadowing test', user: 'reviewer', eventId: F.event, canReview: true });
  const strongContact = (await pool.query('SELECT id FROM contacts WHERE company_id = $1', [F.strong])).rows[0].id;
  const row = async () => (await outreach.listExhibitors(pool, F.event, { exhibitor: F.ex }, { all: true })).rows[0];
  const relRow = async () => (await pool.query('SELECT * FROM exhibitor_company_relations WHERE id = $1', [r.id])).rows[0];
  const before = await relRow();
  assert.equal((await row()).reviewed_contacts, 1, 'applies while the company is not the direct link');

  // ── An Exhibitor Refresh links the exhibitor directly to the reviewed company.
  await pool.query('UPDATE event_exhibitors SET company_id = $2 WHERE id = $1', [F.ex, F.strong]);
  const shadowRow = await row();
  assert.equal(shadowRow.contacts, 1, 'the contact counts once — as direct');
  assert.equal(shadowRow.reviewed_contacts, 0, 'no "+N via reviewed records"');
  const det = await outreach.exhibitorDetail(pool, F.ex);
  assert.deepEqual(det.contacts.map((c) => [c.id, c.link_type]), [[strongContact, 'direct']]);
  assert.deepEqual(det.reviewed, [], 'not repeated under reviewed records');
  const exp = (await outreach.exportRows(pool, F.event, { exhibitor: F.ex })).filter((x) => x.exhibitor_id === F.ex);
  assert.deepEqual(exp.map((x) => [x.contact_link_type, x.reviewed_relation_id]), [['Direct', null]], 'one export row, direct provenance');
  const sentDirect = await outreach.markSent(db, { contactId: strongContact, sentAt: '2026-09-22', userId: 'reviewer', eventId: F.event });
  const auditOf = async (id) => (await pool.query(`SELECT metadata FROM crm_activity WHERE action = 'outreach.mark_sent' AND object_id = $1`, [String(id)])).rows[0].metadata;
  assert.deepEqual([(await auditOf(sentDirect.id)).link, (await auditOf(sentDirect.id)).relation_id], ['direct', null], 'Mark Sent goes through the direct link');
  assert.equal((await outreach.draftEventContext(pool, { id: F.strong })).source, 'exhibitor', 'drafting uses the direct link');
  const p = await panel(F.ex);
  assert.equal(where(p, F.strong), null, 'not shown as a candidate or reviewed record');
  assert.deepEqual(p.shadowed.map((s) => s.id), [r.id], 'listed as superseded, with an explanation');
  assert.match(p.shadowed[0].note, /Superseded by the current direct company link/);
  assert.deepEqual(await relRow(), before, 'the decision row itself is not changed');
  const kp = (await outreach.summary(pool, F.event)).kpis;
  const { rows: [distinct] } = await pool.query(
    `SELECT count(DISTINCT c.id)::int n FROM contacts c JOIN event_exhibitors e ON e.company_id = c.company_id WHERE e.event_id = $1 AND e.attendance_status = 'listed'`, [F.event]);
  assert.equal(kp.contacts, distinct.n, 'KPI contacts are distinct direct contacts — nothing counted twice');

  // ── Reverse: the direct link moves back; the still-live decision applies again.
  await pool.query('UPDATE event_exhibitors SET company_id = $2 WHERE id = $1', [F.ex, F.direct]);
  assert.equal((await row()).reviewed_contacts, 1);
  const det2 = await outreach.exhibitorDetail(pool, F.ex);
  assert.deepEqual(det2.reviewed.map((g) => g.relation.id), [r.id]);
  const exp2 = (await outreach.exportRows(pool, F.event, { exhibitor: F.ex })).filter((x) => x.exhibitor_id === F.ex);
  assert.deepEqual(exp2.map((x) => [x.contact_link_type, x.reviewed_relation_id]), [['Reviewed', r.id]]);
  const sentReviewed = await outreach.markSent(db, { contactId: strongContact, sentAt: '2026-09-23', userId: 'reviewer', eventId: F.event });
  assert.deepEqual([(await auditOf(sentReviewed.id)).link, (await auditOf(sentReviewed.id)).relation_id], ['reviewed', r.id]);
  assert.equal((await outreach.draftEventContext(pool, { id: F.strong })).source, 'reviewed_relation');
  const p2 = await panel(F.ex);
  assert.equal(where(p2, F.strong), 'reviewed');
  assert.deepEqual(p2.shadowed, []);
  assert.deepEqual(await relRow(), before, 'still the same, untouched decision');
  // Both recorded sends remain as history.
  for (const id of [sentDirect.id, sentReviewed.id]) assert.ok(!(await db.getCommunication(id)).deleted_at);

  await rel.revokeDecision(pool, { relationId: r.id, user: 'reviewer', eventId: F.event, canReview: true });
});
