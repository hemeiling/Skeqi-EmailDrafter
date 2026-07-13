// Company-level Apollo lead search: finds VP+/C-suite/senior-specialist
// contacts at a target company, scores and tags them.
// Ported from EmailDrafter (app.py) -- same title/department term lists,
// same scoring formula, same relevance tags.

const APOLLO_PEOPLE_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const APOLLO_ORG_URL = 'https://api.apollo.io/api/v1/organizations/search';
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

async function searchPeople(company, apiKey, page = 1, titleFilters) {
  const primaryPayload = {
    q_organization_name: company,
    person_titles: (titleFilters && titleFilters.length) ? titleFilters : APOLLO_TITLE_FILTERS,
    page,
    per_page: APOLLO_PAGE_SIZE
  };
  const res = await fetch(APOLLO_PEOPLE_URL, {
    method: 'POST',
    headers: apolloHeaders(apiKey),
    body: JSON.stringify(primaryPayload)
  });
  recordApolloPeopleCall();
  const data = res.ok ? await res.json() : {};
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
  const data2 = res2.ok ? await res2.json() : {};
  return { status: res2.status, data: data2 };
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
  const departmentTitles = titleTermsForDepartments(options.departments);
  const titleFilters = departmentTitles.length ? departmentTitles : null;

  let page = 1;
  let firstPageResult;
  try {
    firstPageResult = await searchPeople(company, apiKey, page, titleFilters);
  } catch (err) {
    return { contacts: [], orgs: [], error: `Network error: ${err.message}` };
  }

  if (firstPageResult.status === 200) {
    let rawPeople = firstPageResult.data.people || [];
    const pagination = firstPageResult.data.pagination || {};
    const totalEntries = pagination.total_entries || rawPeople.length;

    // Fetch additional pages (same Apollo per_page chunk size) until we hit
    // the caller's per-company limit, run out of pages, or Apollo has no
    // more results -- never fetch unbounded results.
    while (rawPeople.length < perCompanyLimit && rawPeople.length < totalEntries && (page * APOLLO_PAGE_SIZE) < totalEntries) {
      page += 1;
      try {
        const nextResult = await searchPeople(company, apiKey, page, titleFilters);
        if (nextResult.status !== 200) break;
        const nextRaw = nextResult.data.people || [];
        if (!nextRaw.length) break;
        rawPeople = rawPeople.concat(nextRaw);
      } catch (err) {
        break; // keep what we already gathered rather than losing it to a later-page network error
      }
    }

    const trimmed = rawPeople.slice(0, perCompanyLimit);
    const contacts = trimmed
      .filter(isLeadershipContact)
      .map((p) => formatPerson(p, company))
      .filter((c) => isPlausiblyRelatedCompany(c.company, company));
    return { contacts, orgs: [], total: totalEntries, page };
  }

  const fallbackMsg = `People search returned HTTP ${firstPageResult.status} (often indicates a free-plan restriction). Showing org-level results instead.`;
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

module.exports = { doCompanySearch, CRM_FIELDS, isLeadershipContact, isPlausiblyRelatedCompany };
