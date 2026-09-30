/* ═══════════════════════════════════════════════════════════════════════════
   Which Apollo people belong to the company we meant — decided before
   anything is saved.

   Find Contacts used to ask Apollo for people by organisation NAME (a fuzzy
   text match) and then keep anyone whose organisation name merely STARTED
   with the searched term, creating a new CRM company for every distinct name
   that came back. Searching "AI Technology" therefore created "AI Technology
   Futures", "AI Technology Partners", "AI Technology Consulting"… as
   companies, and filed their people there. The search results carry no
   organisation domain or id (Apollo's people search is obfuscated: an
   organisation name and yes/no flags), so nothing downstream could tell.

   This module decides identity instead:

     • If the company we mean has a reliable website, the Apollo query is
       constrained to its registrable domain. Results are then checked:
         – a returned organisation domain that matches   → confirmed
         – a returned organisation domain that differs   → rejected
         – no domain returned, one consistent organisation → accepted as
           "domain-filtered" (Apollo applied the filter; we could not
           confirm it independently, and the record says so)
         – no domain returned, several organisations      → the filter was
           evidently not applied: nothing is saved; held for review
     • If there is no reliable website, name search remains, but only an
       organisation whose name is the SAME once punctuation and legal form
       are ignored is saved — as the company searched for, never as a new
       one. Similar names ("starts with") and results with no organisation
       at all are held back for a person to review. Nothing is ever saved
       as a new company because its name resembles the search.

   Pure: no network, no database.
   ═══════════════════════════════════════════════════════════════════════════ */

const { normalizeNameKey } = require('./companyKey');
const { registrableDomain, isFreeMailDomain } = require('./domains');

/* Hosts that appear in "website" fields but identify a platform, not the
   company: searching Apollo for linkedin.com would return LinkedIn's staff. */
const PLATFORM_DOMAINS = new Set([
  'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'google.com', 'goo.gl',
  'wikipedia.org', 'crunchbase.com', 'bloomberg.com', 'zoominfo.com', 'apollo.io', 'github.com', 'medium.com',
  'wix.com', 'wixsite.com', 'squarespace.com', 'wordpress.com', 'blogspot.com', 'weebly.com', 'godaddysites.com',
  'alibaba.com', '1688.com', 'made-in-china.com', 'amazon.com', 'mapyourshow.com', 'thebatteryshow.com',
]);

/** The registrable domain of a company website, or null if it cannot identify the company. */
function reliableCompanyDomain(website) {
  const d = registrableDomain(website);
  if (!d || isFreeMailDomain(d) || PLATFORM_DOMAINS.has(d)) return null;
  return d;
}

/** Everything identity decisions need about the company that was searched for. */
function buildTarget({ name, company }) {
  const label = (company && company.name) || name || '';
  const domain = company ? reliableCompanyDomain(company.website) : null;
  const rawDomain = company ? registrableDomain(company.website) : null;
  return {
    name: label,
    key: normalizeNameKey(label),
    companyId: company ? company.id : null,
    domain,
    // Said out loud when a website exists but cannot be used, so the result
    // message can explain why the search fell back to name matching.
    unusableWebsite: company && company.website && !domain ? (rawDomain || String(company.website)) : null,
    mode: domain ? 'domain' : 'name',
  };
}

/** The organisation identity Apollo returned for one person, as far as it goes. */
function personOrganization(person) {
  const org = (person && (person.organization || person.account)) || {};
  const name = org.name || (person && (person.organization_name || person.company_name)) || '';
  const domain = registrableDomain(org.primary_domain || org.website_url || org.domain || (person && person.organization_domain) || '');
  return { name: String(name || '').trim(), key: normalizeNameKey(name || ''), domain, id: org.id || (person && person.organization_id) || null };
}

/* Per-person decision:
     accept  — save, attached to the target company (never a new company)
     review  — not saved; returned for a person to look at
     reject  — not saved; a different organisation
   basis says why, in words that are stored with the contact's history. */
function classifyPerson(person, target) {
  const org = personOrganization(person);
  if (target.mode === 'domain') {
    if (org.domain && org.domain === target.domain) {
      return { decision: 'accept', basis: 'domain_confirmed', org, reason: `Apollo organisation domain ${org.domain} matches ${target.domain}` };
    }
    if (org.domain) {
      return { decision: 'reject', basis: 'domain_conflict', org, reason: `Apollo organisation domain ${org.domain} is not ${target.domain}` };
    }
    return { decision: 'accept', basis: 'domain_filtered', org,
      reason: `Returned by Apollo for ${target.domain}; Apollo gave no organisation domain to confirm it independently` };
  }
  // Name mode: no reliable domain for the company we meant.
  if (!org.key) return { decision: 'review', basis: 'no_org_identity', org, reason: 'Apollo returned no organisation for this person' };
  if (org.key === target.key) {
    return { decision: 'accept', basis: 'exact_name', org,
      reason: `Organisation name "${org.name}" equals "${target.name}" once punctuation and legal form are ignored (no website to confirm)` };
  }
  if (target.key && (org.key.startsWith(`${target.key} `) || target.key.startsWith(`${org.key} `))) {
    return { decision: 'review', basis: 'similar_name', org, reason: `"${org.name}" is a different name that only starts like "${target.name}"` };
  }
  return { decision: 'reject', basis: 'different_name', org, reason: `"${org.name}" is not "${target.name}"` };
}

/* A domain-constrained query should come back as ONE organisation. If the
   people Apollo returned without a domain span several organisation names,
   the constraint was evidently not applied — none of them can be trusted as
   the target, so all of them go to review instead of being saved. */
function applyBatchConsistency(results, target) {
  if (target.mode !== 'domain') return { results, inconsistent: false, orgNames: [] };
  const unconfirmed = results.filter((r) => r.basis === 'domain_filtered');
  const names = [...new Set(unconfirmed.map((r) => r.org.key).filter(Boolean))];
  if (names.length <= 1) return { results, inconsistent: false, orgNames: names };
  const out = results.map((r) => (r.basis === 'domain_filtered'
    ? { ...r, decision: 'review', basis: 'inconsistent_organizations',
        reason: `A search for ${target.domain} returned ${names.length} different organisations, so this result could not be tied to it` }
    : r));
  return { results: out, inconsistent: true, orgNames: names };
}

/** Classify a whole Apollo result set for one target. */
function classifyPeople(people, target) {
  const each = (people || []).map((p) => ({ person: p, ...classifyPerson(p, target) }));
  const { results, inconsistent, orgNames } = applyBatchConsistency(each, target);
  const count = (d) => results.filter((r) => r.decision === d).length;
  return { results, inconsistent, orgNames, accepted: count('accept'), review: count('review'), rejected: count('reject') };
}

/* Human-readable identity basis, stored in the contact's activity log. */
const BASIS_TEXT = {
  domain_confirmed: 'domain confirmed',
  domain_filtered: 'Apollo domain filter (not independently confirmed)',
  exact_name: 'exact company name (no website to confirm)',
};

module.exports = {
  reliableCompanyDomain, buildTarget, personOrganization, classifyPerson, classifyPeople, applyBatchConsistency,
  PLATFORM_DOMAINS, BASIS_TEXT,
};
