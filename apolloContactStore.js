/* ═══════════════════════════════════════════════════════════════════════════
   Saving people found by an Apollo people SEARCH into the canonical CRM.

   One path for every caller — Find Contacts (/api/leads/search) and automatic
   contact discovery (contactDiscovery.js) — so the rules cannot drift:

     • only people the identity check ACCEPTED reach this function; held and
       rejected people are never saved as contacts
     • the same Apollo person always resolves to the same canonical contact
       (Apollo id first, then email / LinkedIn / name — db.findExistingContact)
     • an existing contact is only filled in, never downgraded, re-parented
       or relabelled (contactReimport.js via db.upsertApolloSearchContact)
     • new people are attached to the searched company, never to a company
       created from Apollo's spelling of an organisation name

   A search never reveals: search results carry no address (at most a free
   one Apollo included), and email_lookup_status stays 'not_checked' until a
   person asks for a reveal.
   ═══════════════════════════════════════════════════════════════════════════ */

const db = require('./db');
const apolloIdentity = require('./apolloIdentity');

function cleanApolloEmail(email) {
  const v = String(email || '').trim();
  if (!v || v.startsWith('(') || v.includes('N/A')) return '';
  return v;
}

/**
 * Save one accepted person.
 * ctx: { companyId, companyName, searchLabel, domain, activityType }
 * Returns { id, updated, prior, email, email_lookup_status } — what the CRM
 * now holds, not what the search returned.
 */
async function saveApolloContact(c, ctx) {
  const cleanEmail = cleanApolloEmail(c.email);
  const rawJson = c._apollo_raw ? JSON.stringify(c._apollo_raw) : undefined;
  const { id, updated, existing: prior } = await db.upsertApolloSearchContact({
    full_name: c.name, job_title: c.title, department: c.department, seniority: c.seniority,
    company: ctx.companyName,
    company_id: ctx.companyId,
    website: c.company_website,
    email: cleanEmail, linkedin_url: c.linkedin, address: c.location,
    confidence: c.confidence, relevance: c.relevance,
    apollo_person_id: c.apollo_id, source: 'apollo',
    has_email: Boolean(c.has_email) || Boolean(cleanEmail),
    apollo_raw_json: rawJson,
    email_lookup_status: cleanEmail ? 'found' : 'not_checked',
    // Search-supplied, which costs no reveal credit — a distinction the
    // details panel and the export both surface.
    email_source: cleanEmail ? 'apollo_search' : 'none',
  });
  const basis = apolloIdentity.BASIS_TEXT[c.identity] || c.identity || 'unrecorded';
  await db.logContactActivity(id, ctx.activityType || 'apollo_search',
    `${updated ? 'Refreshed' : 'Found'} via ${ctx.searchLabel || 'Apollo search'} for ${ctx.companyName} — identity: ${basis}`
    + `${ctx.domain ? ` (${ctx.domain})` : ''}${c.apollo_org_name ? `; Apollo organisation "${c.apollo_org_name}"` : ''}`);
  return {
    id, updated, prior,
    email: cleanEmail || (prior && prior.email) || '',
    email_lookup_status: cleanEmail ? 'found' : ((prior && prior.email_lookup_status) || 'not_checked'),
  };
}

module.exports = { saveApolloContact, cleanApolloEmail };
