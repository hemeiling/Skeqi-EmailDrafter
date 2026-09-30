/* What an Outreach row says about automatic contact discovery — pure rules
   (public/outreach-discovery.js) — and that the page itself never searches. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { discoveryView, contactsText, heldText } = require('../public/outreach-discovery');

const ON = { enabled: true, canManage: true };
const row = (discovery, contacts = 0, emailable = 0) => ({ company_id: 7, contacts, emailable, discovery });
const d = (status, extra = {}) => ({ status, pages_fetched: 1, apollo_total: null, held_count: 0, rejected_count: 0, has_more: false, ...extra });

test('zero contacts is never ambiguous', () => {
  assert.equal(discoveryView(row(null), ON).summary, 'Apollo not searched');
  assert.deepEqual(discoveryView(row(null), ON).actions, [{ kind: 'search', label: 'Search Apollo' }]);
  assert.equal(discoveryView(row(d('queued')), ON).summary, 'Queued for contact discovery');
  assert.equal(discoveryView(row(d('searching')), ON).summary, 'Searching Apollo…');
  assert.equal(discoveryView(row(d('no_results')), ON).summary, 'No contacts found');
  assert.equal(discoveryView(row(d('no_results', { rejected_count: 3 })), ON).summary, 'No contacts found · 3 at other organisations discarded');
  assert.equal(discoveryView(row(d('needs_review', { held_count: 4 })), ON).summary, 'Contact discovery needs review · 4 held');
  const failed = discoveryView(row(d('failed')), ON);
  assert.equal(failed.summary, 'Discovery failed');
  assert.deepEqual(failed.actions, [{ kind: 'retry', label: 'Retry' }]);
});

test('found: counts come from the canonical contacts; more pages are said out loud', () => {
  assert.equal(contactsText(8, 0), '8 contacts · emails not revealed');
  assert.equal(contactsText(37, 3), '37 contacts · 3 revealed emails');
  assert.equal(contactsText(1, 1), '1 contact · 1 revealed email');
  const more = discoveryView(row(d('found', { apollo_total: 140, has_more: true, held_count: 2 }), 25, 0), ON);
  assert.equal(more.line, '2 held for review · 25 of 140 Apollo results checked');
  assert.deepEqual(more.actions.map((a) => a.label), ['Find more', 'Refresh contacts']);
  const done = discoveryView(row(d('found', { apollo_total: 8 }), 8, 0), ON);
  assert.equal(done.line, null, 'nothing extra to say');
  assert.deepEqual(done.actions.map((a) => a.kind), ['refresh']);
});

test('queue actions only for people who may manage; paused is said; unmatched rows say nothing', () => {
  assert.deepEqual(discoveryView(row(null), { enabled: true, canManage: false }).actions, []);
  assert.equal(discoveryView(row(d('queued')), { enabled: false, canManage: true }).summary, 'Queued for contact discovery · discovery paused');
  assert.equal(discoveryView(row(d('queued', { last_error_code: 'rate_limited', next_attempt_at: new Date(Date.now() + 60000).toISOString() })), ON).summary,
    'Queued for contact discovery · waiting for Apollo rate limit');
  assert.deepEqual(discoveryView({ company_id: null, contacts: 0 }, ON), { summary: null, line: null, tone: 'grey', actions: [] });
  // Contacts already held (e.g. from Find Contacts) and never discovered: no nagging line.
  assert.deepEqual(discoveryView(row(null, 5, 1), ON), { summary: null, line: null, tone: 'grey', actions: [] });
});

test('held organisations are listed by name and reason, never as people', () => {
  assert.equal(heldText(d('needs_review', { held_orgs: [{ org: 'AI Technology Futures', basis: 'similar_name', n: 3 }, { org: '', basis: 'no_org_identity', n: 1 }] })),
    'AI Technology Futures ×3 (similar name), (no organisation) ×1 (no organisation)');
  assert.equal(heldText(null), '');
});

test('the Outreach page never searches on its own: it queues only from a button, and only through the queue route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'outreach.js'), 'utf8');
  assert.doesNotMatch(src, /leads\/search|people\/match/);
  // The discovery code in the page reveals nothing (Reveal email is its own button).
  const discCode = src.slice(src.indexOf('/* ── Automatic contact discovery'), src.indexOf('function renderPager'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');          // code, not comments
  assert.ok(discCode.length > 500);
  assert.doesNotMatch(discCode, /enrich-email|reveal|allowApollo/i);
  const posts = [...src.matchAll(/postJson\(`([^`]+)`/g)].map((m) => m[1]).filter((u) => /discovery/.test(u));
  assert.deepEqual(posts, ['/api/outreach/exhibitors/${exId}/discovery']);
  const fn = src.slice(src.indexOf('async function discoveryAction'), src.indexOf('function schedulePoll'));
  assert.match(fn, /postJson/);
  const callers = [...src.matchAll(/discoveryAction\(/g)].length;
  assert.equal(callers, 2, 'defined once, called once — from the [data-disc] button handler');
  assert.match(src, /querySelectorAll\("\[data-disc\]"\)\.forEach\(\(b\) => \{ b\.onclick = \(\) => discoveryAction/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/outreach-discovery.js') > 0 && html.indexOf('/outreach-discovery.js') < html.indexOf('/outreach.js"'));
});
