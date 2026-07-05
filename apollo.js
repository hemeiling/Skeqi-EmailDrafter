// Thin client around Apollo.io's People Enrichment endpoint.
// Docs: https://docs.apollo.io/reference/people-enrichment
//
// Enrichment is opt-in: it only runs if APOLLO_API_KEY is set in the
// environment. If it's missing, these functions no-op and the app falls
// back to whatever OCR read off the card.
//
// Design note: fetchApolloPerson() returns Apollo's *raw* person object.
// server.js is responsible for checking/writing the local cache (db.js)
// around this call, and for storing the raw object alongside the contact,
// so a full record of what Apollo returned is kept and never needs to be
// re-fetched for the same person.

const APOLLO_ENDPOINT = 'https://api.apollo.io/api/v1/people/match';
const { recordApolloPeopleCall } = require('./usage');

const { isApolloConfigured, APOLLO_API_KEY } = require('./config');

function isConfigured() {
  return isApolloConfigured();
}

// Best-effort extraction of a bare domain from a website string
// ("https://www.acme.com/about" -> "acme.com").
function domainFromWebsite(website) {
  if (!website) return '';
  try {
    const withProtocol = website.startsWith('http') ? website : `https://${website}`;
    const host = new URL(withProtocol).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return website.replace(/^www\./, '').split('/')[0];
  }
}

function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  if (parts.length === 0) return { first_name: '', last_name: '' };
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

// A stable key identifying "the same person" across scans, so repeat scans
// of the same card can reuse a cached Apollo lookup instead of spending
// another credit. Prefers email (most reliable); falls back to name+domain.
function buildCacheKey(scannedFields) {
  const email = (scannedFields.email || '').trim().toLowerCase();
  if (email) return `email:${email}`;

  const { first_name, last_name } = splitName(scannedFields.full_name);
  const domain = domainFromWebsite(scannedFields.website);
  if (first_name && (last_name || domain)) {
    return `name:${first_name.toLowerCase()}|${last_name.toLowerCase()}|domain:${domain.toLowerCase()}`;
  }
  return null; // not enough signal to build a meaningful cache key
}

// Calls Apollo and returns the raw `person` object from the response, or
// null if there's no match, no API key, or not enough info to search on.
async function fetchApolloPerson(scannedFields) {
  if (!isConfigured()) return null;

  const { first_name, last_name } = splitName(scannedFields.full_name);
  const domain = domainFromWebsite(scannedFields.website);

  const hasEnoughSignal = scannedFields.email || (first_name && (scannedFields.company || domain));
  if (!hasEnoughSignal) return null;

  const params = new URLSearchParams();
  if (scannedFields.email) params.set('email', scannedFields.email);
  if (first_name) params.set('first_name', first_name);
  if (last_name) params.set('last_name', last_name);
  if (scannedFields.company) params.set('organization_name', scannedFields.company);
  if (domain) params.set('domain', domain);

  try {
    const res = await fetch(`${APOLLO_ENDPOINT}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': APOLLO_API_KEY
      }
    });
    recordApolloPeopleCall();

    if (!res.ok) {
      console.error('Apollo enrichment request failed:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return (data && data.person) || null;
  } catch (err) {
    console.error('Apollo enrichment error:', err.message);
    return null;
  }
}

// Extracts the best available email from any Apollo person object, checking
// every field name Apollo has used across API versions and endpoints.
function extractApolloEmail(person) {
  if (!person) return '';
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
  return '';
}

// Reduces Apollo's (large, deeply-nested) raw person object down to the
// handful of fields the review form actually merges into the contact.
// The full raw object is stored separately (see server.js) so nothing is lost.
function summarizeApolloPerson(person) {
  if (!person) return null;
  const org = person.organization || {};
  return {
    person_id: person.id || '',
    title: person.title || '',
    email: extractApolloEmail(person),
    linkedin_url: person.linkedin_url || '',
    twitter_url: person.twitter_url || '',
    photo_url: person.photo_url || '',
    seniority: person.seniority || '',
    city: person.city || '',
    state: person.state || '',
    country: person.country || '',
    organization_name: org.name || '',
    organization_website: org.website_url || '',
    organization_phone: org.phone || '',
    organization_industry: org.industry || '',
    organization_employees: org.estimated_num_employees || ''
  };
}

// Calls Apollo's people/match with reveal_personal_emails to fetch the
// actual email address for a person we already have an Apollo ID for
// (used by POST /api/reveal-email, ported from the original app).
async function revealPersonEmail(apolloId, apiKey) {
  if (!apolloId || !apiKey) return { error: 'Missing apollo_id or API key' };
  try {
    const res = await fetch(APOLLO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': apiKey
      },
      body: JSON.stringify({ id: apolloId, reveal_personal_emails: true })
    });
    recordApolloPeopleCall();
    if (!res.ok) {
      const text = await res.text();
      return { error: `Apollo returned ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = await res.json();
    const person = data.person || {};
    const email = extractApolloEmail(person);
    return { email, raw: person };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  isConfigured,
  domainFromWebsite,
  splitName,
  buildCacheKey,
  fetchApolloPerson,
  summarizeApolloPerson,
  extractApolloEmail,
  revealPersonEmail
};
