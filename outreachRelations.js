/* ═══════════════════════════════════════════════════════════════════════════
   Exhibitor Outreach — human-reviewed related company records.

   An exhibitor is linked to exactly one CRM company (event_exhibitors.
   company_id). That link is canonical and nothing here changes it. This module
   finds OTHER company records that might be the same company, explains why
   and why not, and records a person's decision in exhibitor_company_relations.

   Hard rules:
     • nothing is decided automatically — similarity only ever produces a
       candidate for a person to review;
     • a shared account is never identity evidence (the CRM files every
       company an Apollo name search returns under the searched account);
     • a "same company" decision never merges companies, moves contacts or
       changes any company_id. Its contacts stay where they are and are
       labelled with the relationship wherever they appear;
     • only users listed in ADMIN_USERS may record or revoke a decision, and
       that is enforced here, not only in the page.
   ═══════════════════════════════════════════════════════════════════════════ */

const { normalizeNameKey } = require('./companyKey');
const { escapeLike } = require('./contact-query');
const { registrableDomain, companyEmailDomain } = require('./domains');

const DECISIONS = ['same_company', 'not_same_company'];
const MAX_CANDIDATES = 40;

class RelationError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}

/* Fail closed. The app's login gate has one shared credential and the older
   isAdmin() treats that login as admin, so it can never say no. Identity
   decisions need an explicit list: unset or empty ADMIN_USERS → nobody. */
function canReviewRelations(user, env = process.env) {
  const list = String(env.ADMIN_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return Boolean(user) && list.includes(String(user));
}

const usableEmail = (e) => /^[^\s@()]+@[^\s@()]+\.[^\s@()]+$/.test(String(e || '').trim());

/* ── Evidence ────────────────────────────────────────────────────────────── */

/* Everything the panel shows about one candidate, and exactly what is
   snapshotted when a decision is recorded. Pure: no database access. */
function evaluateCandidate(exhibitor, cand) {
  const exDomain = exhibitor.domain;
  const exKey = exhibitor.key;
  const candDomain = registrableDomain(cand.website);
  const emailDomains = {};
  for (const e of cand.emails || []) { const d = companyEmailDomain(e); if (d) emailDomains[d] = (emailDomains[d] || 0) + 1; }
  const workEmails = Object.values(emailDomains).reduce((a, b) => a + b, 0);
  const atEx = exDomain ? (emailDomains[exDomain] || 0) : 0;

  const forE = []; const against = []; const caveats = [];
  if (exDomain && candDomain === exDomain) forE.push({ key: 'same_website_domain', strength: 'strong', label: `Same website domain: ${exDomain}` });
  if (atEx > 0) forE.push({ key: 'email_domain', strength: 'strong', label: `${atEx} of ${workEmails} work email${workEmails === 1 ? '' : 's'} at ${exDomain}` });
  if (cand.key && exKey && cand.key === exKey) {
    forE.push({ key: 'same_name', strength: 'strong', label: `Same company name once punctuation and legal form are ignored ("${exhibitor.name}" / "${cand.name}")` });
  } else if (cand.key && exKey && (cand.key.startsWith(`${exKey} `) || exKey.startsWith(`${cand.key} `))) {
    forE.push({ key: 'name_prefix', strength: 'weak', label: `Name starts with "${cand.key.startsWith(exKey) ? exhibitor.name : cand.name}" — similar names alone do not show it is the same company` });
  }

  if (exDomain && candDomain && candDomain !== exDomain) against.push({ key: 'website_differs', label: `Website is ${candDomain}; the exhibitor's is ${exDomain}` });
  if (exDomain && workEmails > 0 && atEx === 0) {
    const top = Object.entries(emailDomains).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d, n]) => `${d} (${n})`).join(', ');
    against.push({ key: 'emails_elsewhere', label: `Work emails are at ${top}, not ${exDomain}` });
  }
  if (!exDomain) caveats.push({ key: 'exhibitor_no_domain', label: 'The exhibitor\'s CRM company has no website on file, so domains cannot be compared' });
  else if (!candDomain && workEmails === 0) caveats.push({ key: 'candidate_no_domain', label: `No website or work-email domain on this record to compare with ${exDomain}` });

  const strongFor = forE.some((f) => f.strength === 'strong');
  const anyFor = forE.length > 0;
  let tier = null;
  if (strongFor && against.length === 0) tier = 'strong';
  else if (strongFor) tier = 'possible';                         // conflicting evidence
  else if (anyFor && against.length === 0) tier = 'possible';    // name only, nothing against
  else if (anyFor) tier = 'unlikely';                            // name only, evidence against

  return {
    tier, conflicting: strongFor && against.length > 0,
    for: forE, against, caveats,
    shared_account: Boolean(exhibitor.account_id && cand.account_id === exhibitor.account_id),
    candidate: { id: cand.id, name: cand.name, website: cand.website || null, domain: candDomain, account_id: cand.account_id || null,
      contacts: cand.contacts, emailable: cand.emailable, work_email_domains: emailDomains },
    exhibitor: { exhibitor_id: exhibitor.exhibitor_id, company_id: exhibitor.company_id, name: exhibitor.name, website: exhibitor.website || null, domain: exDomain },
  };
}

/* ── Loading ─────────────────────────────────────────────────────────────── */

async function loadExhibitor(pool, exhibitorId) {
  const { rows: [e] } = await pool.query(
    `SELECT e.id AS exhibitor_id, e.event_id, e.source_name, e.company_id, e.attendance_status,
            co.name AS company_name, co.website, co.account_id
       FROM event_exhibitors e LEFT JOIN companies co ON co.id = e.company_id WHERE e.id = $1`, [exhibitorId]);
  if (!e) return null;
  const name = e.company_name || e.source_name;
  return { ...e, name, key: normalizeNameKey(name), domain: registrableDomain(e.website) };
}

function assertExhibitorInEvent(ex, eventId) {
  if (!ex || (eventId && ex.event_id !== eventId)) throw new RelationError(404, 'not_found', 'Exhibitor not found for this show.');
}

/* Company records worth showing: they hold contacts, are not the direct
   company, and either share a name/domain signal or already have a decision
   for this exhibitor. The SQL is a cheap prefilter; evaluateCandidate() decides. */
async function loadCandidates(pool, ex) {
  const params = [ex.company_id || -1, ex.exhibitor_id];
  const or = ['EXISTS (SELECT 1 FROM exhibitor_company_relations r WHERE r.exhibitor_id = $2 AND r.related_company_id = co.id)'];
  if (ex.key && ex.key.length >= 2) {
    params.push(ex.key, `${escapeLike(ex.key)} %`);
    or.push(`co.name_key = $${params.length - 1}`, `co.name_key LIKE $${params.length}`,
      `(length(co.name_key) >= 3 AND $${params.length - 1} LIKE replace(replace(replace(co.name_key, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || ' %')`);
  }
  if (ex.domain) {
    params.push(`%${escapeLike(ex.domain)}%`, `%@${escapeLike(ex.domain)}`, `%.${escapeLike(ex.domain)}`);
    const w = params.length - 2;
    or.push(`co.website ILIKE $${w}`,
      `EXISTS (SELECT 1 FROM contacts c3 WHERE c3.company_id = co.id AND (c3.email ILIKE $${w + 1} OR c3.email ILIKE $${w + 2}))`);
  }
  const { rows } = await pool.query(`
    SELECT co.id, co.name, co.name_key, co.website, co.account_id, co.source, co.source_file, co.created_at
      FROM companies co
     WHERE co.id <> $1
       AND EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = co.id)
       AND (${or.join(' OR ')})
     ORDER BY co.id
     LIMIT 400`, params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const { rows: people } = await pool.query(
    `SELECT id, company_id, email, job_title, source, created_at FROM contacts WHERE company_id = ANY($1::int[]) ORDER BY id`, [ids]);
  const { rows: acts } = await pool.query(
    `SELECT DISTINCT ON (company_id) company_id, activity_type, description, created_at
       FROM company_activity WHERE company_id = ANY($1::int[]) ORDER BY company_id, created_at, id`, [ids]);
  const byCo = new Map(); for (const p of people) byCo.set(p.company_id, [...(byCo.get(p.company_id) || []), p]);
  const actBy = new Map(acts.map((a) => [a.company_id, a]));
  return rows.map((r) => {
    const list = byCo.get(r.id) || [];
    const sources = {}; for (const p of list) sources[p.source || 'unknown'] = (sources[p.source || 'unknown'] || 0) + 1;
    const a = actBy.get(r.id);
    return {
      id: r.id, name: r.name, key: r.name_key || normalizeNameKey(r.name), website: r.website, account_id: r.account_id,
      contacts: list.length, emailable: list.filter((p) => usableEmail(p.email)).length, emails: list.map((p) => p.email),
      sample_titles: [...new Set(list.map((p) => (p.job_title || '').trim()).filter(Boolean))].slice(0, 3),
      provenance: {
        company_source: r.source || null, source_file: r.source_file || null,
        created_at: r.created_at, first_activity: a ? `${a.activity_type}: ${a.description}` : null,
        contact_sources: sources,
      },
    };
  });
}

async function liveRelationsFor(pool, exhibitorId) {
  const { rows } = await pool.query(
    `SELECT * FROM exhibitor_company_relations WHERE exhibitor_id = $1 AND revoked_at IS NULL`, [exhibitorId]);
  return new Map(rows.map((r) => [r.related_company_id, r]));
}

/* ── Panel ───────────────────────────────────────────────────────────────── */

async function relatedPanel(pool, { exhibitorId, eventId, user, env }) {
  const ex = await loadExhibitor(pool, exhibitorId);
  assertExhibitorInEvent(ex, eventId);
  let direct = null;
  if (ex.company_id) {
    const { rows: [d] } = await pool.query(
      `SELECT count(*)::int AS contacts,
              count(*) FILTER (WHERE email ~ '^[^[:space:]@()]+@[^[:space:]@()]+\\.[^[:space:]@()]+$')::int AS emailable
         FROM contacts WHERE company_id = $1`, [ex.company_id]);
    direct = { company_id: ex.company_id, name: ex.company_name, website: ex.website || null, domain: ex.domain, account_id: ex.account_id, ...d };
  }
  const [cands, live] = await Promise.all([loadCandidates(pool, ex), liveRelationsFor(pool, ex.exhibitor_id)]);
  const out = { strong: [], possible: [], unlikely: [], reviewed: [], rejected: [] };
  for (const c of cands) {
    const ev = evaluateCandidate(ex, c);
    const rel = live.get(c.id);
    const item = { ...ev, sample_titles: c.sample_titles, provenance: c.provenance,
      relation: rel ? { id: rel.id, decision: rel.decision, reason: rel.reason, decided_by: rel.decided_by, decided_at: rel.decided_at } : null };
    if (rel && rel.decision === 'same_company') out.reviewed.push(item);
    else if (rel && rel.decision === 'not_same_company') out.rejected.push(item);
    else if (ev.tier) out[ev.tier].push(item);
  }
  const order = (a, b) => b.candidate.emailable - a.candidate.emailable || b.candidate.contacts - a.candidate.contacts
    || String(a.candidate.name).localeCompare(String(b.candidate.name));
  for (const k of Object.keys(out)) out[k].sort(order);
  for (const k of ['strong', 'possible', 'unlikely']) out[k] = out[k].slice(0, MAX_CANDIDATES);
  return {
    exhibitor: { id: ex.exhibitor_id, name: ex.name, source_name: ex.source_name, domain: ex.domain, website: ex.website || null },
    direct, ...out,
    can_review: canReviewRelations(user, env),
    account_note: 'Sharing an account is not evidence of identity: the CRM files every company an Apollo name search returns under the account that was searched.',
  };
}

/* ── Decisions ───────────────────────────────────────────────────────────── */

async function audit(client, entry) {
  await client.query(
    `INSERT INTO crm_activity (actor, action, object_type, object_id, company_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
    [entry.actor, entry.action, 'exhibitor_company_relation', String(entry.objectId), entry.companyId || null, JSON.stringify(entry.metadata || {})]);
}

async function setDecision(pool, { exhibitorId, companyId, decision, reason, user, eventId, env }) {
  if (!canReviewRelations(user, env)) throw new RelationError(403, 'forbidden', 'Only users listed in ADMIN_USERS can record company-identity decisions.');
  if (!DECISIONS.includes(decision)) throw new RelationError(400, 'bad_decision', 'Decision must be same_company or not_same_company.');
  const why = String(reason || '').trim().slice(0, 1000);
  const ex = await loadExhibitor(pool, exhibitorId);
  assertExhibitorInEvent(ex, eventId);
  if (ex.company_id && Number(companyId) === ex.company_id) {
    throw new RelationError(400, 'direct_company', 'That is already the exhibitor\'s linked company.');
  }
  // Evidence is recomputed here from the database, never taken from the request.
  const cand = (await loadCandidates(pool, ex)).find((c) => c.id === Number(companyId));
  if (!cand) throw new RelationError(404, 'not_candidate', 'That company is not a candidate for this exhibitor.');
  const ev = evaluateCandidate(ex, cand);
  if (decision === 'same_company' && ev.tier !== 'strong' && why.length < 10) {
    throw new RelationError(400, 'reason_required',
      'This record has no strong evidence of being the same company. Say what evidence you have (at least 10 characters).');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [live] } = await client.query(
      `SELECT * FROM exhibitor_company_relations WHERE exhibitor_id = $1 AND related_company_id = $2 AND revoked_at IS NULL FOR UPDATE`,
      [ex.exhibitor_id, cand.id]);
    if (live && live.decision === decision) {
      throw new RelationError(409, 'unchanged', 'That decision is already recorded.', { relation_id: live.id });
    }
    if (live) {
      await client.query(
        `UPDATE exhibitor_company_relations SET revoked_by = $2, revoked_at = NOW(), revoke_reason = $3
          WHERE id = $1 AND revoked_at IS NULL`,
        [live.id, user, `Changed to ${decision}${why ? `: ${why}` : ''}`]);
    }
    const snapshot = { ...ev, sample_titles: cand.sample_titles, provenance: cand.provenance, computed_at: new Date().toISOString() };
    const { rows: [row] } = await client.query(
      `INSERT INTO exhibitor_company_relations (exhibitor_id, related_company_id, decision, reason, evidence, decided_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ex.exhibitor_id, cand.id, decision, why || null, JSON.stringify(snapshot), user]);
    await audit(client, { actor: user, action: 'outreach.relation.decide', objectId: row.id, companyId: cand.id,
      metadata: { exhibitor_id: ex.exhibitor_id, decision, replaced: live ? live.id : null, tier: ev.tier } });
    await client.query('COMMIT');
    return row;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') throw new RelationError(409, 'conflict', 'Someone else recorded a decision at the same moment. Reload and try again.');
    throw e;
  } finally {
    client.release();
  }
}

async function revokeDecision(pool, { relationId, reason, user, eventId, env }) {
  if (!canReviewRelations(user, env)) throw new RelationError(403, 'forbidden', 'Only users listed in ADMIN_USERS can revoke company-identity decisions.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [rel] } = await client.query(
      `SELECT r.*, e.event_id FROM exhibitor_company_relations r JOIN event_exhibitors e ON e.id = r.exhibitor_id
        WHERE r.id = $1 FOR UPDATE OF r`, [relationId]);
    if (!rel || (eventId && rel.event_id !== eventId)) throw new RelationError(404, 'not_found', 'Decision not found.');
    if (rel.revoked_at) throw new RelationError(409, 'already_revoked', 'That decision was already revoked.');
    const why = String(reason || '').trim().slice(0, 1000) || 'Returned to undecided';
    const { rows: [row] } = await client.query(
      `UPDATE exhibitor_company_relations SET revoked_by = $2, revoked_at = NOW(), revoke_reason = $3
        WHERE id = $1 RETURNING *`, [rel.id, user, why]);
    await audit(client, { actor: user, action: 'outreach.relation.revoke', objectId: rel.id, companyId: rel.related_company_id,
      metadata: { exhibitor_id: rel.exhibitor_id, decision: rel.decision } });
    await client.query('COMMIT');
    return row;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function relationHistory(pool, { exhibitorId, eventId }) {
  const ex = await loadExhibitor(pool, exhibitorId);
  assertExhibitorInEvent(ex, eventId);
  const { rows } = await pool.query(
    `SELECT r.id, r.related_company_id, co.name AS company_name, r.decision, r.reason, r.decided_by, r.decided_at,
            r.revoked_by, r.revoked_at, r.revoke_reason, r.evidence->>'tier' AS tier_at_decision
       FROM exhibitor_company_relations r JOIN companies co ON co.id = r.related_company_id
      WHERE r.exhibitor_id = $1 ORDER BY r.related_company_id, r.decided_at, r.id`, [ex.exhibitor_id]);
  return rows;
}

/* ── Live "same company" relations, for the rest of the page ─────────────── */

/* Live same-company relations of these exhibitors: which records' contacts
   are currently reviewed contacts, and under which decision. */
async function liveSameCompany(pool, exhibitorIds) {
  if (!exhibitorIds.length) return [];
  const { rows } = await pool.query(
    `SELECT r.id AS relation_id, r.exhibitor_id, r.related_company_id, co.name AS company_name,
            r.decided_by, r.decided_at, r.reason
       FROM exhibitor_company_relations r JOIN companies co ON co.id = r.related_company_id
      WHERE r.exhibitor_id = ANY($1::int[]) AND r.decision = 'same_company' AND r.revoked_at IS NULL
      ORDER BY r.exhibitor_id, co.name`, [exhibitorIds]);
  return rows;
}

/* Exhibitors of this show that a company is reviewed-same-company with. */
async function exhibitorsReviewedForCompany(pool, companyId, eventId) {
  if (!companyId || !eventId) return [];
  const { rows } = await pool.query(
    `SELECT r.id AS relation_id, e.id AS exhibitor_id, e.attendance_status
       FROM exhibitor_company_relations r JOIN event_exhibitors e ON e.id = r.exhibitor_id
      WHERE r.related_company_id = $1 AND r.decision = 'same_company' AND r.revoked_at IS NULL AND e.event_id = $2`,
    [companyId, eventId]);
  return rows;
}

module.exports = {
  canReviewRelations, evaluateCandidate, relatedPanel, setDecision, revokeDecision, relationHistory,
  liveSameCompany, exhibitorsReviewedForCompany, RelationError, DECISIONS,
};
