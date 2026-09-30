/* Exhibitor Outreach: merging a filter change with text still being typed.
   Regression for the search race found in the production smoke test. Pure. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeFilters } = require('../public/outreach-filters');

const base = { q: '', booth: '', classification: '', status: '', exhibitor: '', include_withdrawn: false, sort: 'company' };

test('text typed but not yet committed survives another filter change', () => {
  // The user typed "elring" and, within the debounce, picked a status.
  const next = mergeFilters(base, { status: 'needs_outreach' }, { q: 'elring', booth: '' });
  assert.equal(next.q, 'elring');
  assert.equal(next.status, 'needs_outreach');
});

test('both text boxes pending at once: neither is lost', () => {
  // Booth typed, then search typed immediately after — the exact production sequence.
  const next = mergeFilters({ ...base, booth: '3626' }, {}, { q: 'comau', booth: '' });
  assert.equal(next.booth, '', 'the cleared booth box is committed as cleared');
  assert.equal(next.q, 'comau', 'and the search text is kept');
});

test('an explicit value wins over what is in the box (Clear filters, chip ✕)', () => {
  const cleared = mergeFilters({ ...base, q: 'comau', status: 'drafted' }, { q: '', status: '' }, { q: 'comau', booth: '' });
  assert.equal(cleared.q, '');
  assert.equal(cleared.status, '');
});

test('KPI tile click keeps the search and replaces only the tile filters', () => {
  const next = mergeFilters({ ...base, q: 'battery', status: 'drafted' },
    { has_contacts: '', has_email: 'yes', drafted: '', sent: '', status: '' }, { q: 'battery', booth: '' });
  assert.equal(next.q, 'battery');
  assert.equal(next.has_email, 'yes');
  assert.equal(next.status, '');
});

test('text is trimmed; untouched fields and the input object are not mutated', () => {
  const current = { ...base, classification: 'target_customer' };
  const next = mergeFilters(current, {}, { q: '  lyten  ', booth: ' 22 ' });
  assert.equal(next.q, 'lyten');
  assert.equal(next.booth, '22');
  assert.equal(next.classification, 'target_customer');
  assert.equal(current.q, '', 'the previous state object is left alone');
});

test('a new search replaces a deep-linked single exhibitor; an unchanged one keeps it', () => {
  const linked = { ...base, exhibitor: '81' };
  assert.equal(mergeFilters(linked, {}, { q: 'eaton', booth: '' }).exhibitor, '');
  assert.equal(mergeFilters(linked, { status: 'drafted' }, { q: '', booth: '' }).exhibitor, '81');
  assert.equal(mergeFilters(linked, { exhibitor: '99' }, { q: 'x', booth: '' }).exhibitor, '99', 'explicit exhibitor wins');
});
