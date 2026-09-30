/* Exhibitor Outreach contact badge, email cell and actions — pure rules
   (public/outreach-status.js), plus source checks that the misleading
   wording is gone and that Reveal and Draft are separate actions. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../public/outreach-status');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('badge names every server status, including manual sends and confirmed-unavailable', () => {
  const b = (c) => S.contactBadge(c).label;
  assert.equal(b({ status: 'sent', last_sent_source: 'system' }), 'Sent');
  assert.equal(b({ status: 'sent', last_sent_source: 'manual' }), 'Marked sent');
  assert.equal(b({ status: 'drafted' }), 'Drafted');
  assert.equal(b({ status: 'no_draft' }), 'Not drafted');
  assert.equal(b({ status: 'email_locked' }), 'Email not revealed');
  assert.equal(b({ status: 'no_email' }), 'No email');
  assert.equal(b({ status: 'no_email', email_lookup_status: 'not_available' }), 'Email unavailable');
  assert.notEqual(S.contactBadge({ status: 'sent' }).cls, S.contactBadge({ status: 'drafted' }).cls, 'Drafted looks distinct from Sent');
});

test('email cell: address, pending, failed, not revealed, unavailable, none', () => {
  assert.deepEqual(S.emailState({ has_email: true, email: ' a@b.com ' }), { kind: 'email', email: 'a@b.com' });
  assert.equal(S.emailState({ revealable: true }, 'pending').label, 'Revealing…');
  assert.equal(S.emailState({ revealable: true }, 'failed').label, 'Reveal failed');
  assert.equal(S.emailState({ revealable: true }).label, 'Email not revealed');
  assert.equal(S.emailState({ email_lookup_status: 'not_available' }).label, 'Email unavailable');
  assert.equal(S.emailState({}).label, 'No email');
  // A held address always wins over any leftover page state.
  assert.equal(S.emailState({ has_email: true, email: 'a@b.com' }, 'failed').kind, 'email');
});

test('Reveal and Draft are separate actions; a failed reveal offers Retry', () => {
  const acts = (c, rs) => S.contactActions(c, rs).map((a) => `${a.act}:${a.label}`);
  assert.deepEqual(acts({ status: 'email_locked' }), ['reveal:Reveal email']);
  assert.deepEqual(acts({ status: 'email_locked' }, 'failed'), ['reveal:Retry']);
  assert.deepEqual(acts({ status: 'email_locked' }, 'pending'), [], 'no double submit while revealing');
  assert.deepEqual(acts({ status: 'no_draft' }), ['draft:Draft email', 'mark:Mark sent'], 'after a reveal: Draft email');
  assert.deepEqual(acts({ status: 'drafted' }), ['draft:View/Edit draft', 'mark:Mark sent']);
  assert.deepEqual(acts({ status: 'sent', last_sent_source: 'manual' }), ['draft:View emails', 'undo:Undo sent']);
  assert.deepEqual(acts({ status: 'no_email' }), []);
  for (const s of ['email_locked', 'no_email']) {
    assert.ok(!S.contactActions({ status: s }).some((a) => a.act === 'draft'), `${s}: no draft before an address exists`);
  }
});

test('the misleading Apollo wording is gone from the pages', () => {
  const ui = read('public/outreach.js') + read('public/app.js') + read('public/outreach-status.js');
  for (const s of ['Locked in Apollo', 'Reveal & draft', 'Email locked', 'not returned by Apollo']) {
    assert.ok(!ui.includes(s), `"${s}" removed`);
  }
  const i18n = read('public/i18n.js');
  for (const s of ['Email not revealed', 'Reveal email', 'Email unavailable', 'Reveal failed', 'Not drafted', 'Marked sent']) {
    assert.ok(i18n.includes(`["${s}",`), `translation for "${s}"`);
  }
});

test('the badge is rendered in the always-visible name cell, and the page loads the status module', () => {
  const ui = read('public/outreach.js');
  const whoCell = ui.slice(ui.indexOf('<span class="xo-ct-who"'), ui.indexOf('<span class="xo-ct-email"'));
  assert.match(whoCell, /xo-ct-badge/, 'badge sits in the who cell, not the draft column that folds away');
  const html = read('public/index.html');
  assert.ok(html.indexOf('/outreach-status.js') > 0 && html.indexOf('/outreach-status.js') < html.indexOf('/outreach.js"'));
  // No container rule hides the badge or the who cell.
  assert.doesNotMatch(html, /\.xo-ct-(badge|who)\s*\{[^}]*display:\s*none/);
});

test('the Outreach reveal never opens the drafter, and drafting never reveals', () => {
  const ui = read('public/outreach.js');
  const reveal = ui.slice(ui.indexOf('async function revealContact'), ui.indexOf('async function openDrafter'));
  assert.ok(reveal.length > 100);
  assert.doesNotMatch(reveal, /openDraftModalForContact|openDrafter\(/);
  assert.match(reveal, /revealBeforeUse\(\[c\]/, 'reuses the confirmed, estimated reveal path');
  const drafter = ui.slice(ui.indexOf('async function openDrafter'), ui.indexOf('function showMarkForm'));
  assert.doesNotMatch(drafter, /revealBeforeUse|enrich-email/);
});

test('a failed reveal request is counted as failed, not as "Apollo has no email"', () => {
  const app = read('public/app.js');
  const fn = app.slice(app.indexOf('async function revealEmailsForContacts'), app.indexOf('function revealProgressUi'));
  assert.match(fn, /r\.ok && email/);
  assert.match(fn, /email_lookup_status === "not_available"/);
  assert.match(fn, /result\.failed\+\+/);
  // A failed estimate still asks before spending.
  const before = app.slice(app.indexOf('async function revealBeforeUse'), app.indexOf('async function exportSelected'));
  assert.match(before, /could not be estimated/);
});
