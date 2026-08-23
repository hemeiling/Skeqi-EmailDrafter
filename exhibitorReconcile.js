/* ═══════════════════════════════════════════════════════════════════════════
   Second-pass reconciliation for exhibitors the sync could not link.

   The first pass matches an exhibitor name against `companies` only. That is
   the right rule for a bulk sync — conservative, one source, no guessing — but
   it leaves a tail, and "48 unmatched" is not a resting state. The CRM knows
   about companies in more places than the companies table's own name column:
   an account may carry the parent name, a contact may carry the employer as
   free text, and the booth map already resolved some names the sync did not.

   So this asks the whole CRM, deterministically, and sorts each exhibitor into
   exactly one outcome:

     link_existing   one CRM company, on evidence, from a named source
     create_new      genuinely absent, and genuinely a company
     review          more than one candidate, or not a company at all

   Two things it deliberately will not do:

   · No fuzzy matching. No edit distance, no substring containment, no
     "looks close enough". "GROB Systems, Inc." and "Dürr | GROB" share a
     word and are not the same legal entity; deciding otherwise by string
     similarity is how a CRM acquires wrong history.

   · No booth-number identity. Booths change hands — that is the bug this
     whole exercise exists to fix.

   And one judgement worth stating plainly: not every exhibitor is a prospect.
   The show's own Media Center, a trade magazine, a university department and
   Skeqi's own subsidiary are all legitimately on the exhibitor list and all
   would be noise as CRM companies. Those go to review with a reason rather
   than being created, because "should this be a customer record" is a sales
   decision, not a data-cleaning one.
   ═══════════════════════════════════════════════════════════════════════════ */

const { normalizeNameKey } = require('./companyKey');

/* Exhibitors that are not prospective customers. Matched on the whole name or
   an unmistakable token, never on a loose substring — "University" catches a
   university, and must not catch "University Loft Company". */
const NOT_A_PROSPECT = [
  { re: /^media center$/i, why: 'the show\'s own media centre, not a company' },
  { re: /^the battery show\b/i, why: 'another edition of this event' },
  { re: /\bmagazine$/i, why: 'trade press, not a prospect' },
  { re: /\bmanufacturers association$/i, why: 'industry association, not a prospect' },
  { re: /^university of\b/i, why: 'academic institution, not a prospect' },
  { re: /\bskeqi\b/i, why: 'Skeqi\'s own entity — must never become a CRM prospect' },
];

function notAProspect(name) {
  for (const rule of NOT_A_PROSPECT) if (rule.re.test(name)) return rule.why;
  return null;
}

/**
 * Everything the CRM knows that could identify a company, indexed by
 * normalized name. Each entry records WHERE the evidence came from, so a link
 * can be explained rather than merely asserted.
 */
async function gatherEvidence(client) {
  const index = new Map();
  const add = (name, companyId, source) => {
    const k = normalizeNameKey(name);
    if (!k || !companyId) return;
    if (!index.has(k)) index.set(k, []);
    const list = index.get(k);
    const seen = list.find((e) => e.company_id === companyId);
    if (seen) { if (!seen.sources.includes(source)) seen.sources.push(source); return; }
    list.push({ company_id: companyId, sources: [source] });
  };

  const { rows: companies } = await client.query('select id, name, chinese_name from companies');
  for (const c of companies) {
    add(c.name, c.id, 'companies.name');
    if (c.chinese_name) add(c.chinese_name, c.id, 'companies.chinese_name');
  }

  /* An account is the parent a user actually searched for; its companies are
     the legal entities underneath. A name that matches the account resolves
     only when that account has exactly one company — otherwise which one? */
  const { rows: accounts } = await client.query(
    `select a.id, a.name, array_agg(c.id) company_ids
       from accounts a join companies c on c.account_id = a.id
      group by a.id, a.name`);
  for (const a of accounts) {
    const ids = (a.company_ids || []).filter(Boolean);
    if (ids.length === 1) add(a.name, ids[0], 'accounts.name');
  }

  // A contact's employer, as typed. Often the only place a name appears.
  const { rows: contacts } = await client.query(
    `select company, company_id from contacts
      where company_id is not null and company is not null and company <> ''`);
  for (const c of contacts) add(c.company, c.company_id, 'contacts.company');

  /* The booth map already resolved some names the exhibitor sync did not —
     its source spelling differs, and it matched. */
  const { rows: booths } = await client.query(
    `select source_company_name, company_id from booth_map_booths
      where company_id is not null and source_company_name is not null`);
  for (const b of booths) add(b.source_company_name, b.company_id, 'booth_map_booths');

  return index;
}

/** One exhibitor's outcome, with the evidence that produced it. */
function classify(exhibitor, index) {
  const name = exhibitor.source_name;

  const why = notAProspect(name);
  if (why) return { outcome: 'review', reason: why, candidates: [] };

  const candidates = index.get(normalizeNameKey(name)) || [];
  if (candidates.length === 1) {
    return {
      outcome: 'link_existing',
      company_id: candidates[0].company_id,
      reason: `matched via ${candidates[0].sources.join(', ')}`,
      candidates,
    };
  }
  if (candidates.length > 1) {
    return {
      outcome: 'review',
      reason: `${candidates.length} CRM companies share this normalized name `
        + `(${candidates.map((c) => c.company_id).join(', ')})`,
      candidates,
    };
  }
  return { outcome: 'create_new', reason: 'not present anywhere in the CRM', candidates: [] };
}

async function planReconcile(client) {
  const { rows: unlinked } = await client.query(
    `select id, exhibitor_source_id, source_name, name_key
       from event_exhibitors
      where company_id is null and attendance_status = 'listed'
      order by source_name`);

  const index = await gatherEvidence(client);
  return unlinked.map((e) => ({ exhibitor: e, ...classify(e, index) }));
}

module.exports = { NOT_A_PROSPECT, notAProspect, gatherEvidence, classify, planReconcile };
