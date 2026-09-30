/* Apollo organisation identity rules (pure). */
const test = require('node:test');
const assert = require('node:assert/strict');
const id = require('../apolloIdentity');

const person = (org, extra = {}) => ({ id: `p${Math.random()}`, first_name: 'A', title: 'Director of Manufacturing', organization: org, ...extra });
const domainTarget = (website, name = 'AI Technology', companyId = 1) => id.buildTarget({ name, company: { id: companyId, name, website } });
const nameTarget = (name) => id.buildTarget({ name, company: null });

test('reliable company domain: registrable domain via the Public Suffix List', () => {
  assert.equal(id.reliableCompanyDomain('www.aitechnology.com'), 'aitechnology.com');
  assert.equal(id.reliableCompanyDomain('https://shop.eu.enpack.com.cn/zh'), 'enpack.com.cn', 'subdomain → registrable, .com.cn');
  assert.equal(id.reliableCompanyDomain('http://store.example.co.uk'), 'example.co.uk');
  assert.equal(id.reliableCompanyDomain('gmail.com'), null, 'free mail never identifies a company');
  assert.equal(id.reliableCompanyDomain('https://www.linkedin.com/company/acme'), null, 'a platform, not the company');
  assert.equal(id.reliableCompanyDomain(''), null);
  assert.equal(id.reliableCompanyDomain('not a website'), null);
});

test('targets: domain mode only with a reliable website; the reason is kept when one is unusable', () => {
  assert.equal(domainTarget('www.aitechnology.com').mode, 'domain');
  assert.equal(domainTarget('www.aitechnology.com').domain, 'aitechnology.com');
  const t = domainTarget('gmail.com');
  assert.equal(t.mode, 'name');
  assert.equal(t.unusableWebsite, 'gmail.com');
  assert.equal(nameTarget('Acme').mode, 'name');
  assert.equal(nameTarget('Acme').companyId, null);
});

test('AI Technology, name mode: similar names are held for review, never accepted', () => {
  const t = nameTarget('AI Technology');
  for (const n of ['AI Technology Futures', 'AI Technology Partners', 'AI Technology Consulting', 'AI TECHNOLOGY WORLD LTD']) {
    const r = id.classifyPerson(person({ name: n }), t);
    assert.equal(r.decision, 'review', n);
    assert.equal(r.basis, 'similar_name');
  }
  assert.equal(id.classifyPerson(person({ name: 'AI Technology, Inc.' }), t).decision, 'accept', 'same name once legal form is ignored');
  assert.equal(id.classifyPerson(person({ name: 'AI Technology, Inc.' }), t).basis, 'exact_name');
  assert.equal(id.classifyPerson(person({ name: 'Totally Other Co' }), t).decision, 'reject');
  assert.equal(id.classifyPerson(person({}), t).decision, 'review', 'no organisation → review');
});

test('AI Technology, domain mode: the similarly named firms cannot slip in', () => {
  const t = domainTarget('www.aitechnology.com');
  // Apollo returned a domain that differs → rejected, whatever the name.
  const futures = id.classifyPerson(person({ name: 'AI Technology Futures', primary_domain: 'aitechfutures.com' }), t);
  assert.equal(futures.decision, 'reject');
  assert.equal(futures.basis, 'domain_conflict');
  // Returned domain matches (via subdomain) → confirmed.
  const ok = id.classifyPerson(person({ name: 'AI Technology Inc', website_url: 'http://www.eu.aitechnology.com' }), t);
  assert.equal(ok.basis, 'domain_confirmed');
  // No domain in the payload (Apollo's obfuscated search) → accepted, but labelled as filter-only.
  const filtered = id.classifyPerson(person({ name: 'AI Technology, Inc.' }), t);
  assert.equal(filtered.decision, 'accept');
  assert.equal(filtered.basis, 'domain_filtered');
  assert.match(filtered.reason, /no organisation domain to confirm/);
});

test('.com.cn and .co.uk: sharing a public suffix is a conflict, not a match', () => {
  const t = domainTarget('www.enpack.com.cn', 'Enpack');
  assert.equal(id.classifyPerson(person({ name: 'Gotion', primary_domain: 'gotion.com.cn' }), t).decision, 'reject');
  assert.equal(id.classifyPerson(person({ name: 'Enpack', primary_domain: 'mail.enpack.com.cn' }), t).basis, 'domain_confirmed');
  const uk = domainTarget('acme.co.uk', 'Acme');
  assert.equal(id.classifyPerson(person({ name: 'Other', primary_domain: 'other.co.uk' }), uk).decision, 'reject');
});

test('batch consistency: a domain search that returns several organisations saves none of them', () => {
  const t = domainTarget('acme.co.uk', 'Acme');
  const res = id.classifyPeople([person({ name: 'Acme Ltd' }), person({ name: 'Beta GmbH' }), person({ name: 'Gamma SA' })], t);
  assert.equal(res.inconsistent, true);
  assert.equal(res.accepted, 0);
  assert.equal(res.review, 3);
  assert.ok(res.results.every((r) => r.basis === 'inconsistent_organizations'));
  // Several people at ONE organisation is the normal case.
  const one = id.classifyPeople([person({ name: 'Acme Ltd' }), person({ name: 'ACME Ltd.' }), person({ name: 'Acme Ltd' })], t);
  assert.equal(one.inconsistent, false);
  assert.equal(one.accepted, 3);
  // Confirmed and conflicting results are judged on their own domains, not by the batch rule.
  const mixed = id.classifyPeople([person({ name: 'Acme', primary_domain: 'acme.co.uk' }), person({ name: 'Zeta', primary_domain: 'zeta.com' })], t);
  assert.deepEqual([mixed.accepted, mixed.rejected, mixed.review], [1, 1, 0]);
});
