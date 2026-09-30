/* Find Contacts end to end, with Apollo MOCKED: a local HTTP server stands in
   for api.apollo.io (APOLLO_BASE_URL), records every request, and answers
   from fixtures. server.js runs against the test database. Nothing here can
   reach the real Apollo or spend a credit — and every scenario asserts that
   no credit-spending endpoint (people/match) was called. */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dbGuard = require('./dbGuard');

if (!dbGuard.available) {
  test('lead identity suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
  return;
}

const db = require('../db');
const { pool } = db;
const TAG = `Zq${Date.now().toString(36)}`;
const N = (s) => `${TAG} ${s}`;
const USER = 'tester';
const PASS = 'pw';
const calls = [];
let fixtures = {};            // set per scenario: (body) => people[]
const made = { companies: [], contacts: [] };

const mkPerson = (name, org, extra = {}) => ({
  id: `ap_${TAG}_${name.replace(/\W+/g, '_')}`, first_name: name.split(' ')[0], last_name_obfuscated: 'X***',
  title: 'Director of Manufacturing', has_email: false, organization: org, ...extra,
});

function startMockApollo() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      calls.push({ path: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/people/match')) { res.statusCode = 500; return res.end('{"error":"must not be called in tests"}'); }
      if (req.url.endsWith('/mixed_people/api_search')) {
        const people = (fixtures.people && fixtures.people(body)) || [];
        return res.end(JSON.stringify({ people, total_entries: people.length }));
      }
      res.end(JSON.stringify({ organizations: [] }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

let mock; let server; let base;
const auth = { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') };
async function search(companies, extra = {}) {
  const r = await fetch(`${base}/api/leads/search`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ companies, perCompanyLimit: 25, maxTotal: 200, ...extra }) });
  return r.json();
}
const companiesNamed = async (like) => (await pool.query('SELECT id, name FROM companies WHERE name LIKE $1 ORDER BY name', [like])).rows;
const contactsOf = async (companyId) => (await pool.query('SELECT id, full_name, company_id FROM contacts WHERE company_id = $1 ORDER BY id', [companyId])).rows;
async function company(name, website) {
  const { rows: [c] } = await pool.query(`INSERT INTO companies (name, name_key, website, source) VALUES ($1, $2, $3, 'manual') RETURNING id`,
    [name, require('../companyKey').normalizeNameKey(name), website]);
  made.companies.push(c.id); return c.id;
}
function noCreditCalls() { assert.equal(calls.filter((c) => c.path.endsWith('/people/match')).length, 0, 'no credit-spending Apollo call'); }

test.before(async () => {
  await db.initDb();
  mock = await startMockApollo();
  const port = 39000 + Math.floor(Math.random() * 900);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port),
      DATABASE_URL: process.env.TEST_DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      APP_USERNAME: USER, APP_PASSWORD: PASS, APOLLO_API_KEY: 'mock-key', APOLLO_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
      CLAUDE_API_KEY: '', OPENAI_API_KEY: '', BAILIAN_API_KEY: '', TAVILY_API_KEY: '', MYS_COOKIE: '', NEON_DATABASE_URL: '', RENDER_DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start\n${log}`)), 30000);
    const on = (d) => { log += d; if (/running at/.test(log)) { clearTimeout(t); resolve(); } };
    server.stdout.on('data', on); server.stderr.on('data', on);
    server.on('exit', (c) => { clearTimeout(t); reject(new Error(`server exited ${c}\n${log}`)); });
  });
});

test.after(async () => {
  try {
    server.removeAllListeners('exit'); server.kill(); mock.close();
    const { rows } = await pool.query(`SELECT id FROM companies WHERE name LIKE $1`, [`${TAG}%`]);
    const coIds = [...new Set([...made.companies, ...rows.map((r) => r.id)])];
    const { rows: people } = await pool.query('SELECT id FROM contacts WHERE company_id = ANY($1::int[]) OR full_name LIKE $2', [coIds, `%${TAG}%`]);
    const pids = people.map((p) => p.id);
    await pool.query('DELETE FROM apollo_results WHERE company_id = ANY($1::int[]) OR contact_id = ANY($2::int[])', [coIds, pids]).catch(() => {});
    await db.deleteContacts(pids);
    await pool.query('DELETE FROM company_activity WHERE company_id = ANY($1::int[])', [coIds]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::int[])', [coIds]);
    await pool.query(`DELETE FROM company_search_cache WHERE company_key LIKE $1`, [`${TAG.toLowerCase()}%`]).catch(() => {});
    await pool.query(`DELETE FROM accounts WHERE name LIKE $1`, [`${TAG}%`]);
  } finally { await pool.end(); }
});

test('AI Technology: searched by domain; the similarly named firms are never requested, saved or created', async () => {
  const target = await company(N('AI Technology'), 'www.aitechnology.com');
  calls.length = 0;
  fixtures.people = (b) => {
    if (b.q_organization_domains_list) return [mkPerson(`Dana ${TAG}`, { name: 'AI Technology, Inc.' }), mkPerson(`Evan ${TAG}`, { name: 'AI Technology, Inc.' })];
    // What a name search would have returned — the old path. Must not be reached.
    return ['Futures', 'Partners', 'Consulting', 'Solutions'].map((s) => mkPerson(`Name ${s} ${TAG}`, { name: `${N('AI Technology')} ${s}` }));
  };
  const d = await search(N('AI Technology'));
  assert.equal(d.ok, true, JSON.stringify(d));
  const sent = calls.filter((c) => c.path.endsWith('/api_search'));
  assert.equal(sent.length, 1, 'one request');
  assert.deepEqual(sent[0].body.q_organization_domains_list, ['aitechnology.com']);
  assert.equal(sent[0].body.q_organization_name, undefined, 'no name query');
  assert.equal(calls.filter((c) => c.body.q_keywords).length, 0, 'no keyword fallback');
  const people = await contactsOf(target);
  assert.equal(people.length, 2, 'both people saved on the existing company');
  assert.deepEqual(await companiesNamed(`${N('AI Technology')}%`), [{ id: target, name: N('AI Technology') }], 'no new company created');
  const { rows: [act] } = await pool.query(`SELECT description FROM contact_activity WHERE contact_id = $1 AND activity_type = 'apollo_search'`, [people[0].id]);
  assert.match(act.description, /identity: Apollo domain filter \(not independently confirmed\) \(aitechnology\.com\)/);
  assert.equal(d.summaries[0].identityMode, 'domain');
  noCreditCalls();
});

test('subdomain and .com.cn: matching domains confirmed, a different .com.cn company discarded', async () => {
  const target = await company(N('Enpack'), 'https://shop.enpack.com.cn');
  fixtures.people = () => [
    mkPerson(`Fei ${TAG}`, { name: 'Enpack Composite', primary_domain: 'www.enpack.com.cn' }),
    mkPerson(`Gao ${TAG}`, { name: 'Gotion High-Tech', primary_domain: 'gotion.com.cn' }),
    mkPerson(`Hua ${TAG}`, { name: 'Enpack', website_url: 'http://eu.enpack.com.cn' }),
  ];
  calls.length = 0;
  const d = await search(N('Enpack'));
  assert.deepEqual(calls.find((c) => c.path.endsWith('/api_search')).body.q_organization_domains_list, ['enpack.com.cn']);
  assert.equal((await contactsOf(target)).length, 2);
  assert.equal((await companiesNamed('%Gotion%')).filter((c) => c.name.includes(TAG)).length, 0);
  assert.equal(d.summaries[0].rejectedCount, 1);
  noCreditCalls();
});

test('domain search that returns several organisations: nothing saved, all held for review', async () => {
  const target = await company(N('Acme Cells'), 'acme-cells.co.uk');
  fixtures.people = () => [mkPerson(`Ian ${TAG}`, { name: 'Acme Cells Ltd' }), mkPerson(`Jo ${TAG}`, { name: 'Beta GmbH' }), mkPerson(`Kim ${TAG}`, { name: 'Gamma SA' })];
  const d = await search(N('Acme Cells'));
  assert.equal((await contactsOf(target)).length, 0);
  assert.equal(d.summaries[0].inconsistent, true);
  assert.equal(d.summaries[0].heldForReview, 3);
  assert.equal(d.review.length, 3);
  assert.ok(d.messages.some((m) => /different organisations/.test(m)));
  noCreditCalls();
});

test('no website: exact name saved once as the searched company; similar names and missing organisations held; unrelated discarded', async () => {
  fixtures.people = () => [
    mkPerson(`Lee ${TAG}`, { name: `${N('Northwind')} Ltd.` }),
    mkPerson(`Max ${TAG}`, { name: `${N('Northwind')} Futures` }),
    mkPerson(`Ned ${TAG}`, { name: 'Unrelated Industries' }),
    mkPerson(`Ola ${TAG}`, undefined),
  ];
  calls.length = 0;
  const d = await search(N('Northwind'));
  assert.equal(calls.find((c) => c.path.endsWith('/api_search')).body.q_organization_name, N('Northwind'));
  const cos = await companiesNamed(`${N('Northwind')}%`);
  assert.deepEqual(cos.map((c) => c.name), [N('Northwind')], 'only the searched company exists — no "Futures", no "Ltd." twin');
  const people = await contactsOf(cos[0].id);
  assert.deepEqual(people.map((p) => p.full_name.split(' ')[0]), ['Lee']);
  assert.equal(d.summaries[0].identityMode, 'name');
  assert.equal(d.summaries[0].heldForReview, 2);
  assert.equal(d.summaries[0].rejectedCount, 1);
  assert.deepEqual(d.review.map((r) => r.basis).sort(), ['no_org_identity', 'similar_name']);
  noCreditCalls();
});

test('free-mail website is not an identity: falls back to strict name matching and says why', async () => {
  await company(N('Gmailco'), 'gmail.com');
  fixtures.people = () => [mkPerson(`Pia ${TAG}`, { name: N('Gmailco') })];
  calls.length = 0;
  const d = await search(N('Gmailco'));
  const sent = calls.find((c) => c.path.endsWith('/api_search')).body;
  assert.equal(sent.q_organization_domains_list, undefined, 'gmail.com is never sent as a company domain');
  assert.ok(d.messages.some((m) => /gmail\.com cannot identify the company/.test(m)));
  noCreditCalls();
});

test('domain search with no results: no name or keyword fallback', async () => {
  await company(N('Quiet Co'), 'quiet-co.example');
  fixtures.people = () => [];
  calls.length = 0;
  const d = await search(N('Quiet Co'));
  assert.equal(calls.filter((c) => c.path.endsWith('/api_search')).length, 1);
  assert.ok(calls.every((c) => !c.body.q_organization_name && !c.body.q_keywords));
  assert.ok(d.messages.some((m) => /no matching people at quiet-co\.example/.test(m)));
});

test('an existing contact filed elsewhere is not re-linked by a search', async () => {
  const target = await company(N('Relink'), 'relink.example');
  const elsewhere = await company(N('Relink Futures'), null);
  const li = `https://www.linkedin.com/in/${TAG}-rex`;
  const prior = await db.insertContact({ full_name: `Rex ${TAG}`, company: N('Relink Futures'), company_id: elsewhere, linkedin_url: li });
  made.contacts.push(prior);
  fixtures.people = () => [mkPerson(`Rex ${TAG}`, { name: 'Relink Inc' }, { linkedin_url: li }), mkPerson(`Sam ${TAG}`, { name: 'Relink Inc' })];
  await search(N('Relink'));
  assert.equal((await db.getContact(prior)).company_id, elsewhere, 'existing record keeps its company');
  const onTarget = await contactsOf(target);
  assert.deepEqual(onTarget.map((p) => p.full_name.split(' ')[0]), ['Sam'], 'only the new person joins the searched company');
});

test('explicit target by id resolves same-name records with different websites; without it the search stays name-only', async () => {
  const a = await company(N('Twin'), 'twin-one.example');
  await company(`${N('Twin')} GmbH`, 'twin-two.example');      // same name key, different domain
  fixtures.people = (b) => (b.q_organization_domains_list ? [mkPerson(`Uma ${TAG}`, { name: 'Twin One' })] : []);
  calls.length = 0;
  const amb = await search(N('Twin'));
  assert.equal(amb.summaries[0].identityMode, 'name', 'ambiguous → no domain assumed');
  assert.ok(amb.messages.some((m) => /different websites/.test(m)));
  calls.length = 0;
  const d = await search(N('Twin'), { targets: [{ name: N('Twin'), company_id: a }] });
  assert.deepEqual(calls.find((c) => c.path.endsWith('/api_search')).body.q_organization_domains_list, ['twin-one.example']);
  assert.equal(d.summaries[0].identityMode, 'domain');
  assert.equal((await contactsOf(a)).length, 1);
  noCreditCalls();
});
