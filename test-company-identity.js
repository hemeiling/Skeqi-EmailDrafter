'use strict';
/* One company, one key, every surface.

   The engine began writing the durable job row in P0-A and computed its own
   company_key. The two normalisations diverged - the CRM strips legal suffixes
   and keeps word spacing, the engine stripped every non-alphanumeric character -
   so "ACRO Automation Systems" became "acro automation systems" on one side and
   "acroautomationsystems" on the other. Twenty jobs and three reports were
   written under a key nothing in the CRM could match, and the company table went
   on showing an interrupted run from hours earlier while Recent Sessions showed
   the new one correctly.

   These tests pin the identity contract at every surface that joins on it. No
   database is required: they read the SQL and the resolver, which is where the
   divergence lived. */
const fs = require('fs');
const path = require('path');
const { normalizeNameKey } = require('./companyKey.js');

let pass = 0;
const fail = [];
const ck = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name + (detail ? ' - ' + detail : '')); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? ' - ' + detail : '')); }
};

const DB = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const SRV = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const ENGINE = (() => {
  const p = '/Users/meilinghe/Downloads/Qwen API Search 测试用例/app.py';
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
})();

/* The names that actually broke, plus the shapes the normaliser exists for. */
const NAMES = [
  ['ACRO Automation Systems', 'multi-word'],
  ['AMADA WELD TECH', 'multi-word, upper case'],
  ['Comau LLC', 'legal suffix'],
  ['American Honda Motor Co., Inc.', 'legal suffix and punctuation'],
  ['Eclipse Automation Inc.', 'legal suffix'],
  ['EVE Energy Co.,Ltd.', 'punctuation inside the suffix'],
  ['红旗', 'CJK'],
  ['宁德时代', 'CJK'],
];

console.log('\n[1] The CRM normaliser is the only one\n');
for (const [name, shape] of NAMES) {
  const key = normalizeNameKey(name);
  ck(`${name} (${shape})`, typeof key === 'string' && key.length > 0, `-> "${key}"`);
}
ck('a multi-word name keeps its spacing',
   normalizeNameKey('ACRO Automation Systems') === 'acro automation systems',
   'the engine used to strip it to "acroautomationsystems"');
ck('legal suffixes are stripped',
   normalizeNameKey('Comau LLC') === 'comau'
   && normalizeNameKey('Eclipse Automation Inc.') === 'eclipse automation');
ck('stacked suffixes are stripped',
   normalizeNameKey('EVE Energy Co.,Ltd.') === 'eve energy',
   normalizeNameKey('EVE Energy Co.,Ltd.'));
ck('punctuation goes, words stay',
   normalizeNameKey('American Honda Motor Co., Inc.') === 'american honda motor');
ck('CJK survives', normalizeNameKey('红旗') === '红旗'
   && normalizeNameKey('宁德时代') === '宁德时代',
   'stripping to [a-z0-9] used to erase these entirely');
ck('the same name always gives the same key',
   NAMES.every(([n]) => normalizeNameKey(n) === normalizeNameKey(n)));

console.log('\n[2] The engine no longer computes a key\n');
ck('the engine has no company_key() of its own',
   ENGINE.length > 0 && !/def company_key\(/.test(ENGINE),
   'a second normaliser is what caused this');
ck('it reads the key from the request', /def enqueue_key\(body\)/.test(ENGINE));
ck('the supplied key is used verbatim',
   /supplied = \(body\.get\("company_key"\) or ""\)\.strip\(\)/.test(ENGINE)
   && /if supplied:\s*\n\s*return supplied/.test(ENGINE));
ck('the enqueue uses it', /enqueue_key\(body\)/.test(ENGINE));
ck('no suffix-stripping was reimplemented there',
   !/ltd|llc|gmbh|corporation/i.test(ENGINE.slice(ENGINE.indexOf('def enqueue_key'),
                                                  ENGINE.indexOf('def enqueue_key') + 1400)));

console.log('\n[3] The proxy resolves identity before it calls the engine\n');
const research = SRV.slice(SRV.indexOf("app.post('/api/aresearch/research'"),
                           SRV.indexOf("app.get('/api/aresearch/job-for-company'"));
ck('it resolves identity', /jobsDb\.resolveIdentity\(/.test(research));
ck('and sends the key', /body\.company_key = ident\.key/.test(research));
ck('and the source alongside it', /body\.identity_source = ident\.source/.test(research));
ck('resolution happens before the engine call',
   research.indexOf('body.company_key = ident.key') < research.indexOf("callEngine('/api/research'"));
ck('resolveIdentity is exported for it', /resolveIdentity/.test(DB.slice(DB.indexOf('module.exports'))));

console.log('\n[4] Every company-keyed lookup uses that key\n');
for (const fn of ['activeQwenJob', 'latestQwenJob', 'hasQwenReport']) {
  const body = DB.slice(DB.indexOf(`async function ${fn}(`),
                        DB.indexOf('async function', DB.indexOf(`async function ${fn}(`) + 10));
  ck(`${fn} keys on normalizeNameKey`, /normalizeNameKey\(/.test(body));
  ck(`${fn} filters on company_key`, /company_key = \$1/.test(body));
}
const claim = DB.slice(DB.indexOf('async function claimQwenJob'),
                       DB.indexOf('async function', DB.indexOf('async function claimQwenJob') + 10));
ck('claimQwenJob resolves the same way', /resolveIdentity\(/.test(claim));
ck('the duplicate guard is built on the same column',
   /uq_arq_jobs_active[\s\S]{0,140}company_key/.test(DB));
ck('the report upsert is keyed on it too',
   /uq_arq_reports_company_key[\s\S]{0,120}company_key/.test(DB));

console.log('\n[5] Ordering is deterministic\n');
for (const fn of ['activeQwenJob', 'latestQwenJob']) {
  const body = DB.slice(DB.indexOf(`async function ${fn}(`),
                        DB.indexOf('async function', DB.indexOf(`async function ${fn}(`) + 10));
  ck(`${fn} orders by enqueue time as the tiebreak`,
     /ORDER BY COALESCE\(started_at, queued_at\) DESC, queued_at DESC/.test(body));
  ck(`${fn} no longer orders by started_at alone`,
     !/ORDER BY started_at DESC LIMIT/.test(body),
     'a queued job has no started_at since the durable queue landed');
}
ck('the reason is recorded where the next reader will look',
   /A QUEUED job has no started_at/.test(DB));

console.log('\n[6] The failure mode itself\n');
/* The exact divergence, reproduced: what the engine used to compute against
   what the CRM computes. If these ever agree again by accident, the test still
   holds, because the engine no longer computes anything. */
const oldEngineKey = (n) => String(n).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '');
const diverged = NAMES.filter(([n]) => oldEngineKey(n) !== normalizeNameKey(n));
ck('the old engine key differed for most real names',
   diverged.length >= 6, `${diverged.length} of ${NAMES.length}`);
ck('ACRO is one of them',
   oldEngineKey('ACRO Automation Systems') === 'acroautomationsystems'
   && normalizeNameKey('ACRO Automation Systems') === 'acro automation systems');
ck('single-token CJK names were the only ones that agreed',
   oldEngineKey('红旗') === normalizeNameKey('红旗'),
   'which is why 红旗 never showed the symptom');

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
fail.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail.length ? 1 : 0);
