/* A later Apollo search must never downgrade what we already know about a
   contact. Pure rules, no database — see contactReimport.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeApolloReimport } = require('../contactReimport');

// What a typical obfuscated search result looks like when saved.
const SEARCH = {
  full_name: 'Dana F***s', first_name: 'Dana', last_name: 'F***s', job_title: 'VP Manufacturing',
  company: 'Searched Name', company_id: 999, email: '', has_email: true, email_lookup_status: 'not_checked',
  email_source: 'none', apollo_person_id: 'ap_1', apollo_raw_json: '{"id":"ap_1","has_email":true}',
  source: 'apollo', linkedin_url: 'https://linkedin.com/in/dana',
};

test('a revealed email, its provenance and lookup state survive a search with no email', () => {
  const existing = { email: 'dana@acme.com', email_source: 'apollo_enrichment', email_lookup_status: 'found',
    has_email: true, apollo_raw_json: '{"id":"ap_1","email":"dana@acme.com","employment_history":[]}', apollo_person_id: 'ap_1' };
  const patch = safeApolloReimport(existing, SEARCH);
  for (const k of ['email', 'email_source', 'email_lookup_status', 'has_email', 'apollo_raw_json', 'apollo_person_id']) {
    assert.ok(!(k in patch), `${k} is left alone`);
  }
});

test('lookup state is never downgraded: not_available and found stay; only a new address raises it', () => {
  assert.ok(!('email_lookup_status' in safeApolloReimport({ email: '', email_lookup_status: 'not_available' }, SEARCH)));
  assert.ok(!('email_lookup_status' in safeApolloReimport({ email: 'x@y.com', email_lookup_status: 'found' }, { ...SEARCH, email: '' })));
  const filled = safeApolloReimport({ email: '', email_lookup_status: 'not_checked' },
    { ...SEARCH, email: 'dana@acme.com', email_source: 'apollo_search' });
  assert.equal(filled.email, 'dana@acme.com');
  assert.equal(filled.email_lookup_status, 'found');
  assert.equal(filled.email_source, 'apollo_search');
  assert.equal(filled.has_email, true);
});

test('a usable email is never replaced — not by a different address, not by a placeholder', () => {
  const existing = { email: 'dana@acme.com', email_lookup_status: 'found' };
  assert.ok(!('email' in safeApolloReimport(existing, { ...SEARCH, email: 'other@acme.com' })));
  assert.ok(!('email' in safeApolloReimport(existing, { ...SEARCH, email: '(email available via Apollo, not returned in payload)' })));
  // A stored placeholder is not a usable address: a real one may fill it.
  const p = safeApolloReimport({ email: '(email available via Apollo)' }, { ...SEARCH, email: 'dana@acme.com' });
  assert.equal(p.email, 'dana@acme.com');
});

test('has_email only ever rises', () => {
  assert.ok(!('has_email' in safeApolloReimport({ has_email: true }, { ...SEARCH, has_email: false })));
  assert.equal(safeApolloReimport({ has_email: false }, SEARCH).has_email, true);
});

test('a richer stored Apollo payload is not replaced by a weaker search payload', () => {
  assert.ok(!('apollo_raw_json' in safeApolloReimport({ apollo_raw_json: '{"email":"x"}' }, SEARCH)));
  assert.equal(safeApolloReimport({ apollo_raw_json: '' }, SEARCH).apollo_raw_json, SEARCH.apollo_raw_json);
});

test('names: a real or hand-corrected name is kept; a masked one is upgraded, never the reverse', () => {
  assert.ok(!('full_name' in safeApolloReimport({ full_name: 'Dana Fuchs' }, SEARCH)), 'masked never replaces real');
  assert.ok(!('full_name' in safeApolloReimport({ full_name: 'Dana Fuchs-Meyer (manual)' }, { ...SEARCH, full_name: 'Dana Fuchs' })),
    'a hand-maintained name is kept even against a clean one');
  const up = safeApolloReimport({ full_name: 'Dana F***s' }, { ...SEARCH, full_name: 'Dana Fuchs', last_name: 'Fuchs' });
  assert.equal(up.full_name, 'Dana Fuchs');
  assert.equal(up.last_name, 'Fuchs');
  assert.equal(safeApolloReimport({ full_name: '' }, SEARCH).full_name, SEARCH.full_name);
});

test('company, company_id and source are never touched — a search does not re-parent or relabel', () => {
  const p = safeApolloReimport({ company: 'Kept', company_id: 1, source: 'business_card' }, SEARCH);
  for (const k of ['company', 'company_id', 'source']) assert.ok(!(k in p), k);
});

test('identity links fill gaps only; descriptive fields refresh', () => {
  assert.ok(!('apollo_person_id' in safeApolloReimport({ apollo_person_id: 'ap_other' }, SEARCH)));
  assert.equal(safeApolloReimport({ apollo_person_id: '' }, SEARCH).apollo_person_id, 'ap_1');
  assert.ok(!('linkedin_url' in safeApolloReimport({ linkedin_url: 'https://linkedin.com/in/kept' }, SEARCH)));
  assert.equal(safeApolloReimport({ job_title: 'Engineer' }, SEARCH).job_title, 'VP Manufacturing');
  assert.ok(!('job_title' in safeApolloReimport({ job_title: 'Engineer' }, { ...SEARCH, job_title: '' })), 'blank never erases');
});

test('applying the same search twice changes nothing the second time', () => {
  const existing = { full_name: 'Dana F***s', email: '', has_email: false, apollo_person_id: '', apollo_raw_json: '' };
  const once = { ...existing, ...safeApolloReimport(existing, SEARCH) };
  const twice = safeApolloReimport(once, SEARCH);
  assert.deepEqual(Object.keys(twice).sort(), ['job_title'], 'only the refreshable title, with the same value');
  assert.equal(twice.job_title, once.job_title);
});
