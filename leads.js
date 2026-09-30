// Company-level Apollo lead search: finds VP+/C-suite/senior-specialist
// contacts at a target company, scores and tags them.
// Ported from EmailDrafter (app.py) -- same title/department term lists,
// same scoring formula, same relevance tags.

// Overridable only so tests can point at a local mock; production leaves it unset.
const APOLLO_BASE = (process.env.APOLLO_BASE_URL || 'https://api.apollo.io').replace(/\/+$/, '');
const APOLLO_PEOPLE_URL = `${APOLLO_BASE}/api/v1/mixed_people/api_search`;
const APOLLO_ORG_URL = `${APOLLO_BASE}/api/v1/organizations/search`;
const identity = require('./apolloIdentity');
const { recordApolloPeopleCall, recordApolloOrgCall } = require('./usage');
const { classifyDepartment, titleTermsForDepartments } = require('./contactClassify');

const APOLLO_PAGE_SIZE = 25;

const CSUITE_TERMS = ['chief', 'cto', 'cio', 'coo', 'cfo', 'cmo', 'ceo'];
const VP_TERMS = ['vp', 'vice president'];
const DIRECTOR_TERMS = ['director', 'head of'];

const SENIORITY_TERMS = [
  'vp', 'vice president', 'chief', 'president',
  'cto', 'cio', 'coo', 'cfo', 'cmo', 'ceo',
  'director', 'head of',
  'plant manager', 'factory manager', 'factory director',
  'engineering manager', 'manufacturing manager', 'automation manager',
  'quality manager', 'procurement manager', 'sourcing manager',
  'category manager', 'capital equipment',
  'mes manager', 'digital manufacturing', 'smart factory',
  'chief engineer', 'principal engineer', 'lead engineer', 'senior engineer',
  'process engineer', 'automation engineer', 'manufacturing engineer',
  'battery engineer', 'quality engineer', 'process development'
];

const MFG_ROLES = [
  'plant manager', 'factory manager', 'factory director',
  'manufacturing engineer', 'process engineer', 'automation engineer',
  'engineering manager', 'manufacturing manager', 'automation manager',
  'production manager'
];
const QUALITY_ROLES = ['quality manager', 'quality engineer', 'quality director', 'quality assurance', 'quality control', 'inspection'];
const PROCUREMENT_ROLES = ['procurement', 'sourcing', 'purchasing', 'category manager', 'capital equipment', 'supply chain'];
const DIGITAL_ROLES = ['mes', 'digital manufacturing', 'smart factory', 'industry 4', 'ot manager', 'it director', 'information technology'];
const RD_ROLES = ['r&d', 'research', 'battery engineer', 'chief engineer', 'process development', 'cell engineer', 'module engineer'];

const DEPARTMENT_KEYWORDS = [
  'manufacturing', 'operations', 'engineering', 'production', 'process',
  'automation', 'assembly', 'plant',
  'supply chain', 'procurement', 'sourcing', 'purchasing',
  'quality',
  'r&d', 'research', 'development',
  'it', 'digital', 'mes', 'smart factory', 'information technology', 'technology'
];

const APOLLO_TITLE_FILTERS = [
  'vp', 'vice president', 'chief', 'director', 'head of', 'president',
  'cto', 'cio', 'coo', 'cfo', 'ceo',
  'plant manager', 'factory manager', 'factory director',
  'manufacturing engineer', 'manufacturing manager',
  'process engineer', 'process development',
  'automation engineer', 'automation manager',
  'engineering manager',
  'procurement manager', 'sourcing manager', 'category manager',
  'capital equipment', 'supply chain manager',
  'quality manager', 'quality engineer', 'quality director',
  'r&d', 'battery engineer', 'chief engineer', 'cell engineer',
  'mes manager', 'digital manufacturing', 'smart factory', 'it director'
];

const norm = (v) => (v || '').trim().toLowerCase();
const matchesAny = (text, terms) => terms.some((t) => text.includes(t));

const isCsuite = (title) => matchesAny(norm(title), CSUITE_TERMS);
const isVpLevel = (title) => matchesAny(norm(title), VP_TERMS) || isCsuite(title);
const isDirectorLevel = (title) => matchesAny(norm(title), DIRECTOR_TERMS);
const isSenior = (title) => matchesAny(norm(title), SENIORITY_TERMS);
const deptMatches = (department) => matchesAny(norm(department), DEPARTMENT_KEYWORDS);

function getRelevanceTag(title, department) {
  const t = norm(title);
  const d = norm(department);

  if (matchesAny(t, CSUITE_TERMS)) return 'Executive Sponsor';
  if (isVpLevel(title) && matchesAny(`${t} ${d}`, ['operations', 'manufacturing', 'production', 'factory', 'plant'])) {
    return 'Executive Sponsor';
  }
  if (matchesAny(`${t} ${d}`, PROCUREMENT_ROLES)) return 'Economic Buyer';
  if (matchesAny(t, [...MFG_ROLES, ...QUALITY_ROLES, ...DIGITAL_ROLES, ...RD_ROLES])) return 'Technical Evaluator';
  if (matchesAny(d, ['quality', 'r&d', 'research', 'mes', 'digital', 'automation']) && isSenior(title)) {
    return 'Technical Evaluator';
  }
  if (matchesAny(`${t} ${d}`, ['plant', 'factory', 'manufacturing', 'production', 'assembly']) && isSenior(title)) {
    return 'Line Champion';
  }
  return isVpLevel(title) ? 'Executive Sponsor' : 'Line Champion';
}

function getConfidenceScore(title, department, hasEmail) {
  const t = norm(title);
  const d = norm(department);
  let score = 30;

  if (isCsuite(title) || isVpLevel(title)) score += 25;
  else if (isDirectorLevel(title)) score += 15;
  else if (isSenior(title)) score += 10;

  const priorityRoles = [...MFG_ROLES, ...QUALITY_ROLES, ...PROCUREMENT_ROLES, ...DIGITAL_ROLES, ...RD_ROLES];
  if (matchesAny(`${t} ${d}`, priorityRoles) || deptMatches(department)) score += 20;
  if (department) score += 10;
  if (hasEmail) score += 15;

  return Math.min(score, 100);
}

function extractName(person) {
  if (person.name) return person.name;
  const first = person.first_name || '';
  const last = person.last_name_obfuscated || person.last_name || '';
  return `${first} ${last}`.trim() || 'Unknown';
}

function extractEmail(person) {
  // Check every field name Apollo has used across API versions and endpoints
  if (person.email) return person.email;
  if (person.email_address) return person.email_address;
  if (person.work_email) return person.work_email;
  const personal = Array.isArray(person.personal_emails)
    ? person.personal_emails.find(e => e && !String(e).includes('catch-all'))
    : null;
  if (personal) return personal;
  const business = Array.isArray(person.business_emails)
    ? person.business_emails.find(e => e && !String(e).includes('catch-all'))
    : null;
  if (business) return business;
  if (person.has_email) return '(email available via Apollo, not returned in payload)';
  return 'N/A';
}

function extractLinkedin(person) {
  return person.linkedin_url || person.linkedin_profile_url || person.linkedin || '';
}

// Apollo's q_organization_name search is a broad fuzzy text match -- searching
// "Ford" also returns unrelated businesses that merely contain the word
// ("Rich Ford", "Chalmers Ford", the common "<Owner> Ford" car-dealership
// naming pattern). This accepts a returned organization only if its name
// equals the searched term or starts with it as a whole leading word (so
// "Ford Motor Company"/"Ford Credit"/"Ford Energy" pass, but "Rich Ford"/
// "Chalmers Ford" don't, since "Ford" isn't a leading word there).
//
// This is a name-text heuristic, not true identity verification -- it won't
// catch a related entity with a different legal name (e.g. CATL's official
// name "Contemporary Amperex Technology"), and it can't distinguish a
// legitimate subsidiary from an unrelated business that happens to also lead
// with the same word (e.g. "Ford Foundation"). Those need either domain/org-ID
// verification or manual review -- both out of scope here; the Merge/Quick
// Browse tools are the manual escape hatch for whatever slips through.
function isPlausiblyRelatedCompany(orgName, searchTerm) {
  const org = norm(orgName);
  const term = norm(searchTerm);
  if (!org || org === 'n/a' || !term) return true; // nothing to judge against, don't over-filter
  return org === term || org.startsWith(`${term} `) || org.startsWith(`${term},`);
}

function isLeadershipContact(person) {
  const rawTitle = person.title || person.job_title || '';
  const rawDept = person.department || '';
  const title = norm(rawTitle);
  const dept = norm(rawDept);
  const seniority = norm(person.seniority || '');

  const titleSenior = isSenior(title);
  const senioritySenior = matchesAny(seniority, ['vp', 'c_suite', 'c-suite', 'director', 'manager']);
  const specialistRoles = [...MFG_ROLES, ...QUALITY_ROLES, ...PROCUREMENT_ROLES, ...DIGITAL_ROLES, ...RD_ROLES];
  const isSpecialist = matchesAny(title, specialistRoles);

  const qualifies = titleSenior || senioritySenior || isSpecialist;
  if (!qualifies) return false;
  if (!dept) return true;

  const deptOk = deptMatches(dept) || matchesAny(dept, ['quality', 'r&d', 'research']);
  if (deptOk) return true;

  // Apollo's own `department` field is a coarse, Apollo-assigned category
  // that often doesn't textually match even for a real procurement/ops
  // person (e.g. tagged "operations & logistics"). Don't discard a contact
  // whose title clearly classifies into a real department bucket just
  // because that raw field happened not to match.
  return Boolean(classifyDepartment(rawTitle, rawDept));
}

function formatPerson(person, companyHint = '') {
  const title = person.title || person.job_title || 'N/A';
  const dept = person.department || 'N/A';
  const hasEmail = Boolean(person.has_email);
  const location = [person.city, person.state, person.country].filter(Boolean).join(', ') || 'N/A';
  const emailValue = extractEmail(person);
  const emailStatus = emailValue && !emailValue.includes('not returned')
    ? 'available'
    : (hasEmail ? 'apollo-available-not-returned' : 'unavailable');

  return {
    name: extractName(person),
    title,
    company: (person.organization && person.organization.name) || person.company_name || companyHint || 'N/A',
    company_website: (person.organization && person.organization.website_url) || '',
    department: dept,
    seniority: person.seniority || '',
    email: emailValue,
    email_status: emailStatus,
    linkedin: extractLinkedin(person),
    confidence: getConfidenceScore(title, dept, hasEmail),
    relevance: getRelevanceTag(title, dept),
    location,
    apollo_id: person.id || '',
    has_email: hasEmail,
    _apollo_raw: person
  };
}

function apolloHeaders(apiKey) {
  return {
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json',
    accept: 'application/json',
    'X-Api-Key': apiKey
  };
}

/* One people-search request. With a target that has a reliable domain the
   query is constrained to that organisation's domain instead of a fuzzy name,
   and there is no keyword fallback: "nobody at aitechnology.com" is an
   answer, not a reason to go looking for similar names. */
async function searchPeople(company, apiKey, page = 1, titleFilters, target) {
  const titles = (titleFilters && titleFilters.length) ? titleFilters : APOLLO_TITLE_FILTERS;
  if (target && target.mode === 'domain') {
    const res = await fetch(APOLLO_PEOPLE_URL, {
      method: 'POST',
      headers: apolloHeaders(apiKey),
      body: JSON.stringify({ q_organization_domains_list: [target.domain], person_titles: titles, page, per_page: APOLLO_PAGE_SIZE })
    });
    recordApolloPeopleCall();
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
  const primaryPayload = {
    q_organization_name: company,
    person_titles: titles,
    page,
    per_page: APOLLO_PAGE_SIZE
  };
  const res = await fetch(APOLLO_PEOPLE_URL, {
    method: 'POST',
    headers: apolloHeaders(apiKey),
    body: JSON.stringify(primaryPayload)
  });
  recordApolloPeopleCall();
  // Parse the body even on failure — Apollo puts the actionable reason there
  // (plan restriction vs bad key vs rate limit) and discarding it leaves the
  // caller with nothing but a status code to guess from.
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.people && data.people.length) {
    return { status: res.status, data };
  }

  // Fallback: broader keyword search
  const fallbackPayload = {
    q_keywords: `${company} vp vice president chief director`,
    page,
    per_page: APOLLO_PAGE_SIZE
  };
  const res2 = await fetch(APOLLO_PEOPLE_URL, {
    method: 'POST',
    headers: apolloHeaders(apiKey),
    body: JSON.stringify(fallbackPayload)
  });
  recordApolloPeopleCall();
  const data2 = await res2.json().catch(() => ({}));
  return { status: res2.status, data: data2 };
}

/* ONE page of an Apollo people SEARCH for automatic discovery — the same
   query Find Contacts sends, and nothing more:
     • reliable domain → q_organization_domains_list (domain-first, f98c70c)
     • otherwise       → q_organization_name, with NO keyword fallback: the
                         broad q_keywords query is what surfaced "AI Technology
                         Futures/Partners/…"; discovery never sends it
     • no organisation-search fallback: a failure is reported as a failure
   people search only — this never calls people/match or any reveal endpoint.
   Returns { status, data, retryAfterMs } or throws on a network error. */
async function searchPeoplePage(target, apiKey, page, options = {}) {
  const titles = (options.titleFilters && options.titleFilters.length) ? options.titleFilters : APOLLO_TITLE_FILTERS;
  const body = target.mode === 'domain'
    ? { q_organization_domains_list: [target.domain], person_titles: titles, page, per_page: APOLLO_PAGE_SIZE }
    : { q_organization_name: target.name, person_titles: titles, page, per_page: APOLLO_PAGE_SIZE };
  const res = await fetch(APOLLO_PEOPLE_URL, {
    method: 'POST', headers: apolloHeaders(apiKey), body: JSON.stringify(body),
    signal: options.signal,
  });
  recordApolloPeopleCall();
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
}

/* Retry-After is either delta-seconds or an HTTP date. */
function parseRetryAfter(v, now = Date.now()) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/* Identity + leadership filtering for one page, exactly as doCompanySearch
   applies them: accepted people are labelled as the TARGET company. */
function classifySearchPage(rawPeople, target) {
  const leaders = (rawPeople || []).filter(isLeadershipContact);
  const verdict = identity.classifyPeople(leaders, target);
  const shape = (r) => ({
    ...formatPerson(r.person, ''),
    apollo_org_name: r.org.name || '', apollo_org_domain: r.org.domain || '',
    identity: r.basis, identity_reason: r.reason,
  });
  return {
    contacts: verdict.results.filter((r) => r.decision === 'accept')
      .map((r) => ({ ...shape(r), company: target.name, company_id: target.companyId || null })),
    review: verdict.results.filter((r) => r.decision === 'review').map(shape),
    rejected: verdict.results.filter((r) => r.decision === 'reject').map(shape),
    notLeadership: (rawPeople || []).length - leaders.length,
    inconsistent: verdict.inconsistent, orgNames: verdict.orgNames,
  };
}

async function searchOrgs(company, apiKey) {
  const res = await fetch(APOLLO_ORG_URL, {
    method: 'POST',
    headers: apolloHeaders(apiKey),
    body: JSON.stringify({ q_keywords: company, page: 1, per_page: 5 })
  });
  recordApolloOrgCall();
  const data = res.ok ? await res.json() : {};
  return { status: res.status, data };
}

// Searches people first; falls back to org-level search if the people
// endpoint is blocked (common on Apollo free/basic plans).
//
// options.perCompanyLimit: max contacts to fetch for this one company
// (default 25, same as the old hardcoded ceiling -- but now a real ceiling
// the caller controls, not an accidental one). options.departments: array of
// contactClassify department keys used to build a narrower Apollo
// person_titles query; falls back to the full default list when empty, so
// existing behavior is unchanged for callers who don't pass it.
async function doCompanySearch(company, apiKey, options = {}) {
  const perCompanyLimit = Math.max(1, Math.min(Number(options.perCompanyLimit) || 25, 500));
  // Who we mean. Without one (older callers), it is the typed name, no domain.
  const target = options.target || identity.buildTarget({ name: company, company: null });
  const departmentTitles = titleTermsForDepartments(options.departments);
  const titleFilters = departmentTitles.length ? departmentTitles : null;

  let page = 1;
  let firstPageResult;
  try {
    firstPageResult = await searchPeople(company, apiKey, page, titleFilters, target);
  } catch (err) {
    return { contacts: [], orgs: [], error: `Network error: ${err.message}` };
  }

  if (firstPageResult.status === 200) {
    let rawPeople = firstPageResult.data.people || [];
    // mixed_people/api_search returns total_entries at the TOP level, not
    // inside a `pagination` object. Reading only pagination.total_entries
    // made this fall back to rawPeople.length — i.e. exactly one page — so
    // the loop below could never run and every company was silently capped
    // at 25 contacts no matter what perCompanyLimit was set to. (Tesla:
    // Apollo reports 6069 matches; the app concluded there were 25.)
    // Both spellings are accepted in case an endpoint does nest it.
    const pagination = firstPageResult.data.pagination || {};
    const totalEntries = pagination.total_entries
      || firstPageResult.data.total_entries
      || rawPeople.length;

    // Fetch additional pages (same Apollo per_page chunk size) until we hit
    // the caller's per-company limit, run out of pages, or Apollo has no
    // more results -- never fetch unbounded results.
    while (rawPeople.length < perCompanyLimit && rawPeople.length < totalEntries && (page * APOLLO_PAGE_SIZE) < totalEntries) {
      page += 1;
      try {
        const nextResult = await searchPeople(company, apiKey, page, titleFilters, target);
        if (nextResult.status !== 200) break;
        const nextRaw = nextResult.data.people || [];
        if (!nextRaw.length) break;
        rawPeople = rawPeople.concat(nextRaw);
      } catch (err) {
        break; // keep what we already gathered rather than losing it to a later-page network error
      }
    }

    const trimmed = rawPeople.slice(0, perCompanyLimit).filter(isLeadershipContact);
    /* Identity first, then formatting. Accepted people are labelled as the
       TARGET company — never as whatever organisation name Apollo spelled —
       so nothing downstream can create a new company from them. Everyone
       else is returned, unsaved, with the reason. */
    const verdict = identity.classifyPeople(trimmed, target);
    const shape = (r) => ({
      ...formatPerson(r.person, ''),
      apollo_org_name: r.org.name || '', apollo_org_domain: r.org.domain || '',
      identity: r.basis, identity_reason: r.reason,
    });
    const contacts = verdict.results.filter((r) => r.decision === 'accept')
      .map((r) => ({ ...shape(r), company: target.name, company_id: target.companyId || null }));
    const review = verdict.results.filter((r) => r.decision === 'review').map(shape);
    const rejected = verdict.results.filter((r) => r.decision === 'reject').map(shape);
    return { contacts, review, rejected, orgs: [], total: totalEntries, page,
      identity: { mode: target.mode, domain: target.domain, inconsistent: verdict.inconsistent, orgNames: verdict.orgNames,
        unusableWebsite: target.unusableWebsite } };
  }

  // Apollo states the reason plainly in the body ("…not included in your Free
  // plan…"), so pass that through instead of guessing from the status code —
  // a plan block and a bad key look identical otherwise, and only one of them
  // is worth spending time on.
  const apolloSaid = (firstPageResult.data
    && (firstPageResult.data.error || firstPageResult.data.error_message
        || firstPageResult.data.error_code)) || '';
  const fallbackMsg = apolloSaid
    ? `Apollo 人员搜索不可用（HTTP ${firstPageResult.status}）：${String(apolloSaid).slice(0, 220)} — 已改为返回公司级结果。`
    : `Apollo 人员搜索返回 HTTP ${firstPageResult.status}，已改为返回公司级结果。`;
  let orgResult;
  try {
    orgResult = await searchOrgs(company, apiKey);
  } catch (err) {
    return { contacts: [], orgs: [], error: `${fallbackMsg} Org search failed: ${err.message}` };
  }

  const orgs = [];
  if (orgResult.status === 200) {
    for (const o of orgResult.data.organizations || []) {
      orgs.push({
        name: o.name || 'N/A',
        domain: o.domain || 'N/A',
        industry: o.industry || 'N/A',
        founded: String(o.year_founded || 'N/A'),
        employees: String(o.estimated_num_employees || 'N/A')
      });
    }
  }
  return { contacts: [], orgs, fallback_message: fallbackMsg };
}

const CRM_FIELDS = ['name', 'title', 'company', 'department', 'email', 'linkedin', 'confidence', 'relevance', 'location'];

module.exports = { doCompanySearch, searchPeoplePage, classifySearchPage, parseRetryAfter, APOLLO_PAGE_SIZE,
  CRM_FIELDS, isLeadershipContact, isPlausiblyRelatedCompany };
