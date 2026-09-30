/* ═══════════════════════════════════════════════════════════════════════════
   Exhibitor Outreach · 展商拓展

   One question, asked of data that already exists: for every exhibitor at the
   show, how far has our outreach got — and with whom?

       event_exhibitors → exhibitor_booths         where they are standing
                        → booth_intel / map        what we think of them
                        → companies → contacts     who we know there
                                    → communications   drafted / sent

   Nothing here is stored. Every status is derived at read time from the
   canonical rows, so an approved Exhibitor Refresh, a draft written in the CRM
   or an email sent from the drafter shows up on the next request, and there is
   no second copy of anything to drift out of agreement.

   The table, the KPIs and the export all go through baseRowsSql(), so the
   three cannot disagree about what "Sent" means.
   ═══════════════════════════════════════════════════════════════════════════ */

const ExcelJS = require('exceljs');
const { listDraftModes } = require('./claude');

/* ── What counts as what ─────────────────────────────────────────────────────

   Sent is deliberately narrow. Two kinds of row prove we sent something:

     • a draft the app itself delivered (delivery_status='sent', sent_at set)
     • an email someone logged by hand as sent outside the system
       (imported_email, source='manual_entry')

   Emails pasted or forwarded through /api/emails/ingest are NOT evidence of
   sending: that path matches the contact on the From address — usually the
   contact writing to us — and falls back to any contact at the same domain.
   Counting those would mark people as "Sent" who were never emailed. */
const SENT_COND = `(m.sent_at IS NOT NULL AND (
    (m.comm_type = 'draft' AND m.delivery_status = 'sent')
 OR (m.comm_type = 'imported_email' AND m.source = 'manual_entry')))`;

/* Drafted = a live, unsent draft in any recognised mode. Follow-ups
   (parent_email_id) are excluded: they are written after a send, so they say
   nothing about whether the first touch has been prepared. */
function draftCond(modesParam) {
  return `(m.comm_type = 'draft' AND m.parent_email_id IS NULL AND m.archived_at IS NULL
    AND m.sent_at IS NULL AND COALESCE(m.delivery_status, '') <> 'sent'
    AND COALESCE(NULLIF(m.draft_mode, ''), 'cold_outreach') = ANY(${modesParam}::text[]))`;
}

/* A usable address, by the same rule the CRM applies (emailNeedsApolloReveal):
   Apollo's placeholders start with "(" and are not addresses. */
const HAS_EMAIL = `(TRIM(COALESCE(c.email, '')) LIKE '%_@_%' AND TRIM(c.email) NOT LIKE '(%')`;
const REVEALABLE = `(NOT ${HAS_EMAIL} AND COALESCE(c.apollo_person_id, '') <> ''
                     AND COALESCE(c.email_lookup_status, '') <> 'not_available')`;

const DRAFT_MODE_KEYS = listDraftModes().map((m) => m.value);

/* booth_intel kinds that describe the company. available_ranked scores empty
   floor space and says nothing about an exhibitor. Order = precedence when an
   exhibitor carries more than one label. */
const INTEL_KINDS = ['target_customer', 'competitor_direct', 'competitor_indirect', 'ess_ev', 'chinese_company'];

const COMPANY_STATUSES = ['unmatched', 'no_contact', 'no_email', 'needs_draft', 'drafted',
  'contacted_partial', 'contacted_all'];
const CONTACT_STATUSES = ['sent', 'drafted', 'no_draft', 'email_locked', 'no_email'];

const SORTS = {
  company: 'lower(r.display_name) ASC, r.exhibitor_id ASC',
  booth: 'r.booth_sort ASC NULLS LAST, lower(r.display_name) ASC',
  status: `array_position(ARRAY[${COMPANY_STATUSES.map((s) => `'${s}'`).join(',')}]::text[], r.outreach_status) DESC, lower(r.display_name) ASC`,
  contacts: 'r.contacts DESC, lower(r.display_name) ASC',
  sent: 'r.last_sent_at DESC NULLS LAST, lower(r.display_name) ASC',
};

const MAX_PAGE_SIZE = 100;

/* ── Event ────────────────────────────────────────────────────────────────── */

/* The show whose exhibitor list was most recently refreshed successfully.
   Not "the newest events row" — adding an unrelated event must not quietly
   repoint this page at an empty list. */
async function resolveEventId(pool, requested) {
  const asked = Number(requested);
  if (Number.isInteger(asked) && asked > 0) {
    const { rows } = await pool.query('SELECT id FROM events WHERE id = $1', [asked]);
    return rows.length ? asked : null;
  }
  const { rows: [run] } = await pool.query(
    `SELECT event_id FROM exhibitor_import_runs
      WHERE status = 'success' AND dry_run = FALSE AND event_id IS NOT NULL
      ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`);
  if (run) return run.event_id;
  const { rows: [busiest] } = await pool.query(
    `SELECT event_id FROM event_exhibitors WHERE attendance_status = 'listed'
      GROUP BY event_id ORDER BY COUNT(*) DESC, event_id DESC LIMIT 1`);
  return busiest ? busiest.event_id : null;
}

async function eventMeta(pool, eventId) {
  const { rows: [ev] } = await pool.query('SELECT id, name FROM events WHERE id = $1', [eventId]);
  const { rows: [run] } = await pool.query(
    `SELECT finished_at FROM exhibitor_import_runs
      WHERE status = 'success' AND dry_run = FALSE AND (event_id = $1 OR event_id IS NULL)
      ORDER BY finished_at DESC NULLS LAST LIMIT 1`, [eventId]);
  return { id: ev ? ev.id : eventId, name: ev ? ev.name : null, verified_at: run ? run.finished_at : null };
}

/* ── Filters ──────────────────────────────────────────────────────────────── */

const yesNo = (v) => (v === 'yes' || v === 'no' ? v : null);

/* Everything the client can send, reduced to known values. Unknown keys and
   values are dropped rather than passed anywhere near SQL. */
function normalizeFilters(input = {}) {
  const f = {};
  const q = String(input.q || '').trim().slice(0, 120);
  if (q) f.q = q;
  const exId = Number(input.exhibitor);
  if (Number.isInteger(exId) && exId > 0) f.exhibitor = exId;
  const booth = String(input.booth || '').trim().slice(0, 20);
  if (booth) f.booth = booth;
  const cls = String(input.classification || '').trim().slice(0, 60);
  if (cls) f.classification = cls;
  for (const k of ['has_contacts', 'has_email', 'drafted', 'sent']) {
    const v = yesNo(input[k]);
    if (v) f[k] = v;
  }
  const status = String(input.status || '');
  if (COMPANY_STATUSES.includes(status) || status === 'needs_outreach' || status === 'contacted') f.status = status;
  f.include_withdrawn = input.include_withdrawn === true || input.include_withdrawn === 'true' || input.include_withdrawn === '1';
  f.sort = SORTS[input.sort] ? input.sort : 'company';
  return f;
}

/* ── SQL ──────────────────────────────────────────────────────────────────── */

/* Per-contact state for every contact at a company in `ex`. Shared by the
   company aggregate and — with more columns — by the detail and export. */
function contactStateCte(modesParam) {
  return `
  cs AS (
    SELECT c.id AS contact_id, c.company_id,
           ${HAS_EMAIL} AS has_email,
           ${REVEALABLE} AS revealable,
           CASE WHEN ${HAS_EMAIL} THEN lower(trim(c.email)) END AS email_norm,
           COALESCE(cm.sent, FALSE) AS sent,
           COALESCE(cm.drafted, FALSE) AS drafted,
           cm.last_sent_at
      FROM contacts c
      LEFT JOIN LATERAL (
        SELECT bool_or(${SENT_COND}) AS sent,
               bool_or(${draftCond(modesParam)}) AS drafted,
               max(m.sent_at) FILTER (WHERE ${SENT_COND}) AS last_sent_at
          FROM communications m
         WHERE m.contact_id = c.id AND m.deleted_at IS NULL
      ) cm ON TRUE
     WHERE c.company_id IN (SELECT company_id FROM ex WHERE company_id IS NOT NULL)
  )`;
}

/* One row per exhibitor with its derived outreach counts and status.
   $1 = event_id, $2 = include_withdrawn, $3 = draft modes. */
function baseRowsSql() {
  return `
  WITH ex AS (
    SELECT e.id AS exhibitor_id, e.source_name, e.company_id, e.attendance_status,
           e.match_confidence, e.hall, co.name AS company_name, co.chinese_name
      FROM event_exhibitors e
      LEFT JOIN companies co ON co.id = e.company_id
     WHERE e.event_id = $1
       AND (e.attendance_status = 'listed' OR $2::boolean)
  ),
  booths AS (
    SELECT b.exhibitor_id,
           string_agg(b.booth_number, ', ' ORDER BY b.booth_number) AS booths,
           min(NULLIF(regexp_replace(b.booth_number, '\\D', '', 'g'), '')::bigint) AS booth_sort
      FROM exhibitor_booths b
     WHERE b.retired_at IS NULL AND b.exhibitor_id IN (SELECT exhibitor_id FROM ex)
     GROUP BY b.exhibitor_id
  ),
  intel AS (
    /* Curated labels travel with the exhibitor. Older rows that still hang
       only off a booth count when our map says this exhibitor is the current
       occupant of that booth; anything under review is left out rather than
       shown as a judgement nobody has confirmed. */
    SELECT x.exhibitor_id, array_agg(DISTINCT x.kind) AS kinds
      FROM (
        SELECT bi.exhibitor_id, bi.kind FROM booth_intel bi
         WHERE bi.exhibitor_id IN (SELECT exhibitor_id FROM ex)
           AND bi.retired_at IS NULL AND COALESCE(bi.review_status, 'ok') = 'ok'
        UNION ALL
        SELECT bmb.exhibitor_id, bi.kind FROM booth_intel bi
          JOIN booth_map_booths bmb ON bmb.id = bi.booth_id
         WHERE bi.exhibitor_id IS NULL AND bmb.exhibitor_id IN (SELECT exhibitor_id FROM ex)
           AND bmb.occupant_status = 'current' AND bmb.retired_at IS NULL
           AND bi.retired_at IS NULL AND COALESCE(bi.review_status, 'ok') = 'ok'
      ) x
     WHERE x.kind = ANY(ARRAY[${INTEL_KINDS.map((k) => `'${k}'`).join(',')}]::text[])
     GROUP BY x.exhibitor_id
  ),
  mapcat AS (
    SELECT DISTINCT ON (bmb.exhibitor_id) bmb.exhibitor_id, bmb.category
      FROM booth_map_booths bmb
     WHERE bmb.exhibitor_id IN (SELECT exhibitor_id FROM ex)
       AND bmb.occupant_status = 'current' AND bmb.retired_at IS NULL
       AND COALESCE(bmb.category, '') <> ''
     ORDER BY bmb.exhibitor_id, bmb.booth_number
  ),
  ${contactStateCte('$3')},
  cstats AS (
    SELECT company_id,
           count(*)::int AS contacts,
           count(*) FILTER (WHERE has_email)::int AS contacts_with_email,
           count(DISTINCT email_norm) FILTER (WHERE has_email)::int AS emailable,
           count(*) FILTER (WHERE drafted AND NOT sent)::int AS drafted,
           count(*) FILTER (WHERE sent)::int AS sent,
           count(DISTINCT email_norm) FILTER (WHERE has_email AND sent)::int AS sent_emailable,
           max(last_sent_at) AS last_sent_at
      FROM cs GROUP BY company_id
  ),
  rows AS (
    SELECT ex.exhibitor_id, ex.source_name, ex.company_id, ex.company_name, ex.chinese_name,
           ex.attendance_status, ex.match_confidence, ex.hall,
           COALESCE(ex.company_name, ex.source_name) AS display_name,
           bo.booths, bo.booth_sort,
           COALESCE(${INTEL_KINDS.map((k) => `CASE WHEN '${k}' = ANY(it.kinds) THEN '${k}' END`).join(', ')},
                    mc.category) AS classification,
           CASE WHEN it.kinds IS NOT NULL THEN 'curated' WHEN mc.category IS NOT NULL THEN 'map' END
             AS classification_source,
           COALESCE(s.contacts, 0) AS contacts,
           COALESCE(s.contacts_with_email, 0) AS contacts_with_email,
           COALESCE(s.emailable, 0) AS emailable,
           COALESCE(s.drafted, 0) AS drafted,
           COALESCE(s.sent, 0) AS sent,
           COALESCE(s.sent_emailable, 0) AS sent_emailable,
           s.last_sent_at,
           CASE
             WHEN ex.company_id IS NULL THEN 'unmatched'
             WHEN COALESCE(s.contacts, 0) = 0 THEN 'no_contact'
             WHEN COALESCE(s.sent, 0) > 0 AND COALESCE(s.emailable, 0) > COALESCE(s.sent_emailable, 0)
               THEN 'contacted_partial'
             WHEN COALESCE(s.sent, 0) > 0 THEN 'contacted_all'
             WHEN COALESCE(s.drafted, 0) > 0 THEN 'drafted'
             WHEN COALESCE(s.emailable, 0) > 0 THEN 'needs_draft'
             ELSE 'no_email'
           END AS outreach_status
      FROM ex
      LEFT JOIN booths bo ON bo.exhibitor_id = ex.exhibitor_id
      LEFT JOIN intel it ON it.exhibitor_id = ex.exhibitor_id
      LEFT JOIN mapcat mc ON mc.exhibitor_id = ex.exhibitor_id
      LEFT JOIN cstats s ON s.company_id = ex.company_id
  )`;
}

/* WHERE clause over `rows r`, appending to params. */
function filterSql(f, params) {
  const where = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (f.q) {
    /* ILIKE on the raw columns, not lower(x) LIKE: contacts.full_name and
       .email carry trigram indexes that only the former can use. At 14.5k
       contacts that is 0.5 ms instead of a 10 ms sequential scan, and the gap
       grows with the CRM. % and _ are escaped so they match themselves. */
    const p = add(`%${f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    where.push(`(r.source_name ILIKE ${p} OR r.company_name ILIKE ${p}
      OR r.chinese_name ILIKE ${p} OR r.booths ILIKE ${p}
      OR EXISTS (SELECT 1 FROM contacts c2 WHERE c2.company_id = r.company_id
                 AND (c2.full_name ILIKE ${p} OR c2.email ILIKE ${p})))`);
  }
  if (f.exhibitor) where.push(`r.exhibitor_id = ${add(f.exhibitor)}`);
  if (f.booth) {
    const p = add(f.booth.toLowerCase());
    where.push(`EXISTS (SELECT 1 FROM exhibitor_booths b2 WHERE b2.exhibitor_id = r.exhibitor_id
      AND b2.retired_at IS NULL AND (lower(b2.booth_number) = ${p} OR lower(b2.booth_number) LIKE ${p} || '%'))`);
  }
  if (f.classification) {
    if (f.classification === 'none') where.push('r.classification IS NULL');
    else where.push(`r.classification = ${add(f.classification)}`);
  }
  if (f.has_contacts) where.push(f.has_contacts === 'yes' ? 'r.contacts > 0' : 'r.contacts = 0');
  if (f.has_email) where.push(f.has_email === 'yes' ? 'r.emailable > 0' : 'r.emailable = 0');
  if (f.drafted) where.push(f.drafted === 'yes' ? 'r.drafted > 0' : 'r.drafted = 0');
  if (f.sent) where.push(f.sent === 'yes' ? 'r.sent > 0' : 'r.sent = 0');
  if (f.status === 'needs_outreach') where.push('r.emailable > 0 AND r.sent = 0');
  else if (f.status === 'contacted') where.push(`r.outreach_status IN ('contacted_partial', 'contacted_all')`);
  else if (f.status) where.push(`r.outreach_status = ${add(f.status)}`);
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

function baseParams(eventId, f) {
  return [eventId, Boolean(f.include_withdrawn), DRAFT_MODE_KEYS];
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

async function listExhibitors(pool, eventId, input = {}, paging = {}) {
  const f = normalizeFilters(input);
  const params = baseParams(eventId, f);
  const where = filterSql(f, params);
  let limitSql = '';
  let page = 1;
  let pageSize = null;
  if (!paging.all) {
    pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(paging.page_size) || 50));
    page = Math.max(1, Math.floor(Number(paging.page) || 1));
    params.push(pageSize, (page - 1) * pageSize);
    limitSql = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }
  const { rows } = await pool.query(`${baseRowsSql()}
    SELECT r.*, count(*) OVER ()::int AS total_count
      FROM rows r ${where}
     ORDER BY ${SORTS[f.sort]}
     ${limitSql}`, params);
  const total = rows.length ? rows[0].total_count : (page > 1 ? await countOnly(pool, eventId, f) : 0);
  for (const r of rows) { delete r.total_count; delete r.booth_sort; }
  return { rows, total, page, page_size: pageSize, filters: f };
}

async function countOnly(pool, eventId, f) {
  const params = baseParams(eventId, f);
  const where = filterSql(f, params);
  const { rows: [r] } = await pool.query(`${baseRowsSql()} SELECT count(*)::int AS n FROM rows r ${where}`, params);
  return r.n;
}

/* KPIs for the whole event (never the filtered view), plus facet counts. */
async function summary(pool, eventId, input = {}) {
  const f = normalizeFilters({ include_withdrawn: input.include_withdrawn });
  const params = baseParams(eventId, f);
  const { rows: [k] } = await pool.query(`${baseRowsSql()}
    SELECT count(*)::int AS exhibitors,
           count(*) FILTER (WHERE company_id IS NULL)::int AS unmatched,
           count(*) FILTER (WHERE contacts > 0)::int AS with_contacts,
           COALESCE(sum(contacts), 0)::int AS contacts,
           count(*) FILTER (WHERE emailable > 0)::int AS with_email,
           COALESCE(sum(emailable), 0)::int AS emailable_contacts,
           count(*) FILTER (WHERE drafted > 0)::int AS drafted,
           COALESCE(sum(drafted), 0)::int AS drafted_contacts,
           count(*) FILTER (WHERE sent > 0)::int AS sent,
           COALESCE(sum(sent), 0)::int AS sent_contacts,
           count(*) FILTER (WHERE emailable > 0 AND sent = 0)::int AS needs_outreach,
           count(*) FILTER (WHERE outreach_status IN ('no_contact', 'no_email'))::int AS needs_discovery
      FROM rows`, params);
  const { rows: classes } = await pool.query(`${baseRowsSql()}
    SELECT COALESCE(classification, 'none') AS value, classification_source AS source, count(*)::int AS n
      FROM rows GROUP BY 1, 2 ORDER BY n DESC`, params);
  const { rows: statuses } = await pool.query(`${baseRowsSql()}
    SELECT outreach_status AS value, count(*)::int AS n FROM rows GROUP BY 1`, params);
  return { kpis: k, facets: { classification: classes, status: statuses } };
}

/* Full contact rows for a set of companies, in the CRM row shape so the
   existing drafter entry points (crmRowToDraftFormat, revealBeforeUse) take
   them unchanged. */
async function contactsForCompanies(pool, companyIds) {
  if (!companyIds.length) return [];
  const { rows } = await pool.query(`
    SELECT c.id, c.company_id, c.full_name, c.first_name, c.last_name, c.job_title, c.department,
           c.email, c.company, c.linkedin_url, c.apollo_person_id, c.email_lookup_status,
           c.department_category, c.seniority_level, c.source, c.meeting_date, c.meeting_notes,
           c.interest_level, c.contact_status, c.priority,
           ${HAS_EMAIL} AS has_email, ${REVEALABLE} AS revealable,
           ls.id AS last_sent_id, ls.sent_at AS last_sent_at, ls.to_email AS last_sent_to,
           CASE WHEN ls.id IS NULL THEN NULL
                WHEN ls.comm_type = 'imported_email' THEN 'manual' ELSE 'system' END AS last_sent_source,
           ls.user_id AS last_sent_user,
           ld.id AS draft_id, ld.draft_mode AS draft_mode, ld.status AS draft_status,
           ld.updated_at AS draft_updated_at, ld.version AS draft_version,
           COALESCE(rp.replied, FALSE) AS replied
      FROM contacts c
      LEFT JOIN LATERAL (
        SELECT m.id, m.sent_at, m.to_email, m.comm_type, m.user_id FROM communications m
         WHERE m.contact_id = c.id AND m.deleted_at IS NULL AND ${SENT_COND}
         ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) ls ON TRUE
      LEFT JOIN LATERAL (
        SELECT m.id, COALESCE(NULLIF(m.draft_mode, ''), 'cold_outreach') AS draft_mode, m.status,
               m.updated_at, m.version FROM communications m
         WHERE m.contact_id = c.id AND m.deleted_at IS NULL AND ${draftCond('$2')}
         ORDER BY m.updated_at DESC NULLS LAST, m.id DESC LIMIT 1) ld ON TRUE
      LEFT JOIN LATERAL (
        SELECT bool_or(m.replied_at IS NOT NULL) AS replied FROM communications m
         WHERE m.contact_id = c.id AND m.deleted_at IS NULL) rp ON TRUE
     WHERE c.company_id = ANY($1::int[])
     ORDER BY c.company_id, lower(COALESCE(c.full_name, '')), c.id`, [companyIds, DRAFT_MODE_KEYS]);
  for (const c of rows) c.status = contactStatus(c);
  return rows;
}

function contactStatus(c) {
  if (c.last_sent_id) return 'sent';
  if (c.draft_id) return 'drafted';
  if (c.has_email) return 'no_draft';
  if (c.revealable) return 'email_locked';
  return 'no_email';
}

/* ── Best contact ─────────────────────────────────────────────────────────────

   A recommendation only when the CRM holds evidence for one, and never from
   a name. Evidence comes in three tiers, and a higher tier always wins:

     1. interaction   — something happened between us and this person:
                        they replied, we met (meeting logged), we have their card
     2. crm_judgement — a person on our side recorded a view: existing customer
                        or partner, high interest, high priority
     3. title         — the job title alone puts them in a relevant function at
                        Director level or above (Manager counts only as a
                        tie-breaker, never on its own)

   Contacts are compared tier by tier (interaction first); a lower tier only
   separates contacts that are equal on every higher one. If the top two are
   still equal, or the leader has nothing but a Manager title, there is no
   recommendation — "we can't tell" is a better answer than a coin flip. */
const RELEVANT_DEPTS = new Set(['procurement', 'strategic_sourcing', 'supply_chain', 'operations',
  'manufacturing', 'engineering', 'digital_manufacturing', 'plant_management', 'executive']);
const SENIOR = new Set(['c_level', 'vp', 'director']);
const TIERS = ['interaction', 'crm_judgement', 'title'];
const BASIS_LABELS = {
  interaction: 'Interaction history',
  crm_judgement: 'CRM notes by your team',
  title: 'Job title only',
};

function bestContactEvidence(c) {
  const ev = [];
  const add = (tier, key, points, label) => ev.push({ tier, key, points, label });
  if (c.replied) add('interaction', 'replied', 3, 'Replied to a previous email');
  if (String(c.meeting_date || '').trim() || String(c.meeting_notes || '').trim()) {
    add('interaction', 'meeting', 2, 'Meeting recorded');
  }
  if (c.source === 'business_card') add('interaction', 'met_card', 2, 'Business card collected');
  if (c.contact_status === 'customer' || c.contact_status === 'partner') {
    add('crm_judgement', 'relationship', 2, `Marked as existing ${c.contact_status}`);
  }
  if (c.interest_level === 'high') add('crm_judgement', 'interest', 1, 'Marked high interest');
  if (c.priority === 'high') add('crm_judgement', 'priority', 1, 'Marked high priority');
  if (RELEVANT_DEPTS.has(c.department_category)) {
    if (SENIOR.has(c.seniority_level)) add('title', 'role_senior', 2, 'Director+ in a relevant function (from job title)');
    else if (c.seniority_level === 'manager') add('title', 'role_manager', 1, 'Manager in a relevant function (from job title)');
  }
  return ev;
}

function tierScores(ev) {
  return TIERS.map((t) => ev.filter((e) => e.tier === t).reduce((s, e) => s + e.points, 0));
}

function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
}

/* Returns { contact_id, basis, basis_label, reasons, evidence } or null.
   Only contacts we can actually email are candidates. */
function pickBestContact(contacts) {
  const scored = contacts
    .filter((c) => c.has_email)
    .map((c) => { const ev = bestContactEvidence(c); return { c, ev, scores: tierScores(ev) }; })
    .sort((x, y) => compareScores(x.scores, y.scores));
  if (!scored.length) return null;
  const [top, second] = scored;
  const [inter, judge, title] = top.scores;
  // A Manager title on its own is not enough to single someone out.
  if (!inter && !judge && title < 2) return null;
  if (second && compareScores(top.scores, second.scores) === 0) return null;
  const basis = TIERS.find((t, i) => top.scores[i] > 0);
  const ordered = [...top.ev].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || b.points - a.points);
  return {
    contact_id: top.c.id,
    basis,
    basis_label: BASIS_LABELS[basis],
    reasons: ordered.map((e) => e.label),
    evidence: ordered.map(({ tier, key, label }) => ({ tier, key, label })),
  };
}

/* One exhibitor with its contacts, for the expanded row. */
async function exhibitorDetail(pool, exhibitorId) {
  const { rows: [ex] } = await pool.query(
    `SELECT e.id AS exhibitor_id, e.event_id, e.source_name, e.company_id, e.attendance_status,
            co.name AS company_name
       FROM event_exhibitors e LEFT JOIN companies co ON co.id = e.company_id
      WHERE e.id = $1`, [exhibitorId]);
  if (!ex) return null;
  const contacts = ex.company_id ? await contactsForCompanies(pool, [ex.company_id]) : [];
  const best = pickBestContact(contacts);
  const emailable = contacts.filter((c) => c.has_email).length;
  return {
    exhibitor: ex,
    contacts: contacts.map(publicContact),
    best_contact: best,
    // Said, not implied: two or more candidates and still no pick.
    best_contact_note: !best && emailable >= 2 ? 'insufficient_evidence' : null,
  };
}

/* The client gets what the row needs; meeting notes stay on the server. */
function publicContact(c) {
  const out = { ...c };
  out.has_meeting = Boolean(String(c.meeting_date || '').trim() || String(c.meeting_notes || '').trim());
  delete out.meeting_notes;
  return out;
}

/* ── Manual "Sent" ────────────────────────────────────────────────────────── */

const EMAIL_RE = /^[^\s@()]+@[^\s@()]+\.[^\s@()]+$/;

class OutreachError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status; this.code = code; this.extra = extra || {};
  }
}

/* Parse the user's date. A bare YYYY-MM-DD is taken as noon UTC so the stored
   day is the day they picked in every timezone the team works in. */
function parseSentAt(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return now;
  const s = String(value).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new OutreachError(400, 'bad_date', 'Sent date is not a valid date.');
  if (d.getTime() > now.getTime() + 24 * 3600 * 1000) {
    throw new OutreachError(400, 'future_date', 'Sent date cannot be in the future.');
  }
  if (d.getUTCFullYear() < 2000) throw new OutreachError(400, 'bad_date', 'Sent date is too far in the past.');
  return d;
}

/* Records an email sent outside the system, through the same
   insertManualEmail path the drafter's "Log sent email" panel uses. Never
   touches the draft row: marking a draft delivered would claim the app sent
   it, with no message id behind the claim. */
async function markSent(db, { contactId, sentAt, draftId, notes, userId, eventId }) {
  const contact = await db.getContact(contactId);
  if (!contact) throw new OutreachError(404, 'not_found', 'Contact not found.');
  /* This endpoint serves the outreach page, so it only acts on contacts at an
     exhibitor of the show — not on any contact id someone types in. */
  if (!eventId) throw new OutreachError(404, 'no_event', 'No exhibitor list has been imported yet.');
  const { rows: [atShow] } = await db.pool.query(
    'SELECT 1 FROM event_exhibitors WHERE event_id = $1 AND company_id = $2 LIMIT 1',
    [eventId, contact.company_id || -1]);
  if (!atShow) throw new OutreachError(404, 'not_exhibitor_contact', 'This contact is not at an exhibitor of this show.');

  /* Always the contact's own address. Accepting one from the request would
     let a caller record a "send" to any address against any contact. */
  const to = String(contact.email || '').trim();
  if (!EMAIL_RE.test(to)) {
    throw new OutreachError(400, 'no_email', 'This contact has no usable email address to record a send against.');
  }
  const when = parseSentAt(sentAt);

  let draft = null;
  if (draftId != null && draftId !== '') {
    draft = await db.getCommunication(Number(draftId));
    if (!draft || draft.contact_id !== contact.id || draft.comm_type !== 'draft') {
      throw new OutreachError(400, 'bad_draft', 'That draft does not belong to this contact.');
    }
  }

  /* One logged send per contact, address and day. A double click or a second
     tab must not turn one email into two in the history. */
  const { rows: [dup] } = await db.pool.query(
    `SELECT id FROM communications
      WHERE contact_id = $1 AND comm_type = 'imported_email' AND source = 'manual_entry'
        AND deleted_at IS NULL AND lower(to_email) = lower($2)
        AND (sent_at AT TIME ZONE 'UTC')::date = ($3::timestamptz AT TIME ZONE 'UTC')::date
      LIMIT 1`, [contact.id, to, when.toISOString()]);
  if (dup) {
    throw new OutreachError(409, 'duplicate', 'A send to this address on this date is already recorded.',
      { communication_id: dup.id });
  }

  const row = await db.insertManualEmail({
    contactId: contact.id, companyId: contact.company_id,
    mode: draft ? draft.draft_mode : 'cold_outreach',
    subject: draft ? draft.subject : '', body: draft ? draft.body : '',
    toEmail: to, sentAt: when.toISOString(),
    notes: String(notes || '').slice(0, 2000),
    userId,
  });
  await db.logContactActivity(contact.id, 'email_logged',
    `Marked as sent to ${to} (${when.toISOString().slice(0, 10)}) from Exhibitor Outreach`);
  await db.logCrmActivity({
    actor: userId, action: 'outreach.mark_sent', objectType: 'communication', objectId: row.id,
    companyId: contact.company_id, contactId: contact.id,
    metadata: { source: 'manual', draft_id: draft ? draft.id : null },
  });
  return row;
}

/* Undo a manual "sent" record. Only a row this feature can create is
   accepted: an imported_email with source manual_entry, still live. A real
   delivery from the app — or any other communication — is refused, so an id
   typed into the request cannot trash unrelated history. Soft delete only;
   the drafter's Trash can restore it. */
async function undoManualSent(db, { communicationId, userId }) {
  const row = await db.getCommunication(communicationId);
  if (!row || row.deleted_at) throw new OutreachError(404, 'not_found', 'That sent record was not found.');
  if (row.comm_type !== 'imported_email' || row.source !== 'manual_entry') {
    throw new OutreachError(400, 'not_manual', 'Only a send recorded by hand can be undone here.');
  }
  await db.trashCommunication(row.id);
  await db.logCrmActivity({
    actor: userId, action: 'outreach.undo_sent', objectType: 'communication', objectId: row.id,
    companyId: row.company_id, contactId: row.contact_id,
  });
  return { id: row.id, contact_id: row.contact_id };
}

/* ── Export ───────────────────────────────────────────────────────────────── */

const CLASS_LABELS = {
  target_customer: 'Target customer', competitor_direct: 'Direct competitor',
  competitor_indirect: 'Indirect competitor', ess_ev: 'ESS / EV project', chinese_company: 'Chinese company',
};
const COMPANY_STATUS_LABELS = {
  unmatched: 'Unmatched', no_contact: 'No contact', no_email: 'No email', needs_draft: 'Needs draft',
  drafted: 'Drafted', contacted_partial: 'Contacted (partial)', contacted_all: 'Contacted (all)',
};
const CONTACT_STATUS_LABELS = {
  sent: 'Sent', drafted: 'Drafted', no_draft: 'No draft', email_locked: 'Email locked', no_email: 'No email',
};

function classificationLabel(v) {
  if (!v) return '';
  return CLASS_LABELS[v] || String(v).replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
}

const EXPORT_COLUMNS = [
  { key: 'company', header: 'Company', width: 34 },
  { key: 'booth', header: 'Booth', width: 14 },
  { key: 'classification', header: 'Classification', width: 20 },
  { key: 'contact_name', header: 'Contact Name', width: 24 },
  { key: 'title', header: 'Title', width: 30 },
  { key: 'email', header: 'Email', width: 30 },
  { key: 'draft_status', header: 'Draft Status', width: 14 },
  { key: 'sent_status', header: 'Sent Status', width: 12 },
  { key: 'sent_date', header: 'Sent Date', width: 12 },
  { key: 'outreach_status', header: 'Outreach Status', width: 20 },
  { key: 'best_contact', header: 'Best Contact', width: 12 },
  { key: 'best_contact_reason', header: 'Best Contact Reason', width: 40 },
  { key: 'sent_source', header: 'Sent Source', width: 12 },
  { key: 'draft_mode', header: 'Draft Mode', width: 20 },
  { key: 'company_match', header: 'Company Match', width: 14 },
  { key: 'exhibitor_id', header: 'Exhibitor ID', width: 12 },
];

/* Flattened, one row per contact. An exhibitor with no contacts — or no
   company match at all — still gets exactly one row, with the contact
   columns blank, so the file is a complete list of the show. */
async function exportRows(pool, eventId, input = {}) {
  const { rows: exhibitors } = await listExhibitors(pool, eventId, input, { all: true });
  const companyIds = [...new Set(exhibitors.map((e) => e.company_id).filter(Boolean))];
  const contacts = await contactsForCompanies(pool, companyIds);
  const byCompany = new Map();
  for (const c of contacts) {
    if (!byCompany.has(c.company_id)) byCompany.set(c.company_id, []);
    byCompany.get(c.company_id).push(c);
  }
  const modeLabels = Object.fromEntries(listDraftModes().map((m) => [m.value, m.label]));
  const out = [];
  for (const e of exhibitors) {
    const base = {
      company: e.display_name,
      booth: e.booths || '',
      classification: classificationLabel(e.classification),
      outreach_status: COMPANY_STATUS_LABELS[e.outreach_status] || e.outreach_status,
      company_match: e.company_id ? 'Matched' : 'Unmatched',
      exhibitor_id: e.exhibitor_id,
    };
    const list = e.company_id ? (byCompany.get(e.company_id) || []) : [];
    if (!list.length) {
      out.push({ ...base, contact_name: '', title: '', email: '', draft_status: '', sent_status: '',
        sent_date: null, best_contact: '', best_contact_reason: '', sent_source: '', draft_mode: '' });
      continue;
    }
    const best = pickBestContact(list);
    for (const c of list) {
      out.push({
        ...base,
        contact_name: c.full_name || '',
        title: c.job_title || '',
        email: c.has_email ? c.email.trim() : '',
        draft_status: c.draft_id ? 'Drafted' : (c.has_email ? 'No draft' : ''),
        sent_status: c.last_sent_id ? 'Sent' : 'Not sent',
        sent_date: c.last_sent_at ? new Date(c.last_sent_at) : null,
        best_contact: best && best.contact_id === c.id ? 'Yes' : '',
        best_contact_reason: best && best.contact_id === c.id
          ? `${best.basis_label}: ${best.reasons.join('; ')}` : '',
        sent_source: c.last_sent_source || '',
        draft_mode: c.draft_id ? (modeLabels[c.draft_mode] || c.draft_mode) : '',
      });
    }
  }
  return out;
}

/* A cell that starts with = + - @ (or a tab/CR) is a formula to Excel and
   LibreOffice. Company and contact names come from outside sources, so every
   text cell is neutralised with a leading apostrophe. */
function neutralize(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvCell(v) {
  let s;
  if (v instanceof Date) s = v.toISOString().slice(0, 10);
  else s = neutralize(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows) {
  const lines = [EXPORT_COLUMNS.map((c) => c.header).join(',')];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map((c) => csvCell(r[c.key])).join(','));
  // BOM so Excel opens UTF-8 (Chinese names) correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}

async function rowsToXlsx(rows, { title } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Exhibitor Outreach', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = EXPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  for (const r of rows) {
    const out = {};
    for (const c of EXPORT_COLUMNS) {
      const v = r[c.key];
      out[c.key] = v instanceof Date || typeof v === 'number' ? v : neutralize(v);
    }
    ws.addRow(out);
  }
  ws.getRow(1).font = { bold: true };
  ws.getColumn('sent_date').numFmt = 'yyyy-mm-dd';
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXPORT_COLUMNS.length } };
  if (title) wb.title = title;
  return wb.xlsx.writeBuffer();
}

/* ── Drafting context ────────────────────────────────────────────────────── */

/* Whether this company is a listed exhibitor at the current show, and where.
   Read at draft time and never written back: the company row is not the
   place to remember which show someone was drafting for. */
async function exhibitorContextForCompany(pool, companyId, knownEventId) {
  if (!companyId) return null;
  const eventId = knownEventId || await resolveEventId(pool);
  if (!eventId) return null;
  const { rows } = await pool.query(
    `SELECT ev.name AS event_name,
            array_remove(array_agg(DISTINCT b.booth_number ORDER BY b.booth_number), NULL) AS booths
       FROM event_exhibitors e
       JOIN events ev ON ev.id = e.event_id
       LEFT JOIN exhibitor_booths b ON b.exhibitor_id = e.id AND b.retired_at IS NULL
      WHERE e.company_id = $1 AND e.event_id = $2 AND e.attendance_status = 'listed'
      GROUP BY ev.name`, [companyId, eventId]);
  if (!rows.length) return null;
  return { eventName: rows[0].event_name, booths: rows[0].booths || [] };
}

/* The event line a draft for this company should carry, if any.

     • Listed exhibitor at the current show → that show, with booths.
     • Not listed at the current show → nothing about the current show, even
       when companies.event_id says otherwise. That column was filled from the
       booth map and is not kept in step with the exhibitor list, so a
       withdrawn company would otherwise be written to as if it were exhibiting.
     • companies.event_id pointing at some OTHER event keeps its old meaning
       (where we met them), exactly as before this feature. */
async function draftEventContext(pool, company) {
  if (!company || !company.id) return null;
  const currentEventId = await resolveEventId(pool);
  if (currentEventId) {
    const ex = await exhibitorContextForCompany(pool, company.id, currentEventId);
    if (ex) return { eventName: ex.eventName, booths: ex.booths, source: 'exhibitor' };
  }
  if (company.event_id && company.event_id !== currentEventId) {
    const { rows: [ev] } = await pool.query('SELECT name FROM events WHERE id = $1', [company.event_id]);
    if (ev) return { eventName: ev.name, source: 'company' };
  }
  return null;
}

module.exports = {
  resolveEventId, eventMeta, normalizeFilters, listExhibitors, summary, exhibitorDetail,
  contactsForCompanies, contactStatus, pickBestContact, bestContactEvidence, BASIS_LABELS,
  markSent, undoManualSent, parseSentAt, OutreachError,
  exportRows, rowsToCsv, rowsToXlsx, EXPORT_COLUMNS, neutralize,
  exhibitorContextForCompany, draftEventContext,
  COMPANY_STATUSES, CONTACT_STATUSES, DRAFT_MODE_KEYS, INTEL_KINDS,
};
