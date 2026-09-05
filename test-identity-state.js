/* Regression tests for the two defects the 红旗 run exposed.
 *
 *  1. A late section callback resurrected a terminal job. failQwenJob() ran at
 *     18:12:28.511; section callbacks arriving until 18:12:28.871 each set
 *     status:'running'. The row ended up 85% running WITH a completion time and
 *     an error, which is what made Sessions and Progress disagree.
 *
 *  2. normalizeNameKey stripped CJK, so 红旗 normalised to '' and saveQwenReport
 *     threw. Neon held zero reports with a Chinese name; every CJK account had
 *     silently failed.
 *
 * Pure-function tests plus a live state-machine test against Neon that creates
 * and then removes its own throwaway job. No model call, no research run.
 */
const db = require('./db.js');
const { normalizeNameKey } = require('./companyKey.js');

let pass = 0; const fail = [];
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

(async () => {
  console.log('\n[A] Company identity keys survive CJK\n');
  for (const [name, want] of [
    ['红旗', '红旗'], ['宁德时代', '宁德时代'], ['中创新航', '中创新航'],
    ['Apple', 'apple'], ['EVE Energy Co., Ltd.', 'eve energy'],
    ['红旗 Hongqi', '红旗 hongqi'], ['トヨタ', 'トヨタ'], ['현대', '현대'],
  ]) ck(`normalizeNameKey(${name}) = ${want}`, normalizeNameKey(name) === want,
        JSON.stringify(normalizeNameKey(name)));
  ck('no CJK name normalises to empty',
     ['红旗', '宁德时代', '中创新航'].every((n) => normalizeNameKey(n) !== ''));

  console.log('\n[B] Identity hierarchy: CRM id > name > supplied domain\n');
  const cases = [
    [{ companyId: 42, companyName: '红旗', website: 'https://www.hongqi-auto.com' },
     'crm:42', 'crm_company_id', '红旗 already in CRM'],
    [{ companyName: '红旗', website: 'https://www.hongqi-auto.com' },
     '红旗', 'company_name', '红旗 + hongqi-auto.com'],
    [{ companyName: '宁德时代', website: 'https://www.catl.com' },
     '宁德时代', 'company_name', '宁德时代 / CATL'],
    [{ companyName: '中创新航', website: 'https://www.calb-tech.com' },
     '中创新航', 'company_name', '中创新航 / CALB'],
    [{ companyName: 'TE Connectivity', website: 'https://www.te.com' },
     'te connectivity', 'company_name', 'English-only account'],
    [{ companyName: '', website: 'https://www.hongqi-auto.com', alias: '红旗' },
     'domain:hongqi-auto.com', 'supplied_domain', 'Chinese alias + supplied domain'],
    [{ companyName: 'Newco Unknown Ltd', website: 'https://newco.example' },
     'newco unknown', 'company_name', 'new company not yet in CRM'],
  ];
  for (const [input, key, source, label] of cases) {
    const got = db.resolveIdentity(input);
    ck(`${label} -> ${key}`, got.key === key && got.source === source,
       `${JSON.stringify(got.key)} / ${got.source}`);
  }
  ck('an identity key is never empty',
     ['', null, undefined].every((n) => db.resolveIdentity({ companyName: n }).key !== ''));

  console.log('\n[C] The auto-discovered website is never an identity source\n');
  // 红旗 supplied hongqi-auto.com; retrieval later resolved pcauto.com.cn, a car
  // portal. A record-derived key would have filed the account under "pcauto".
  const supplied = db.resolveIdentity({ companyName: '红旗', website: 'https://www.hongqi-auto.com' });
  const resolved = db.resolveIdentity({ companyName: '红旗', website: 'https://pcauto.com.cn' });
  ck('supplied and auto-discovered domains give the SAME key', supplied.key === resolved.key,
     `${supplied.key} vs ${resolved.key}`);
  ck('the key is the account, not the portal', supplied.key === '红旗' &&
     !JSON.stringify(supplied).includes('pcauto'));

  console.log('\n[D] Terminal states\n');
  for (const t of ['completed', 'completed_with_limitations', 'interrupted',
                   'failed', 'synthesis_failed', 'save_failed']) {
    ck(`${t} is terminal`, db.isTerminalStatus(t));
  }
  for (const a of ['queued', 'running']) ck(`${a} is NOT terminal`, !db.isTerminalStatus(a));

  console.log('\n[E] The 红旗 sequence: a late callback cannot resurrect a job\n');
  const jobId = 'test_' + Date.now().toString(36);
  let created = null;
  try {
    created = await db.claimQwenJob({
      jobId, companyName: '红旗__TEST', website: 'https://www.hongqi-auto.com',
      model: 'test', createdBy: 'regression-test' });
    ck('job claimed', !!created);
    ck('company_key is never empty on a CJK job', !!(created && created.company_key),
       JSON.stringify(created && created.company_key));
    ck('identity_source recorded', !!(created && created.identity_source),
       String(created && created.identity_source));

    await db.updateQwenJob(jobId, { status: 'running', stage: 'model', progress: 85 });
    const term = await db.failQwenJob(jobId, 'Report generated but saving failed', 'save_failed');
    ck('terminalised to save_failed', term.status === 'save_failed', term.status);

    // The late section callback, exactly as the CRM issues it.
    await db.updateQwenJob(jobId, { status: 'running', stage: 'model', progress: 85 });
    const after = await db.getQwenJob(jobId);
    ck('status stays terminal', after.status === 'save_failed', after.status);
    ck('completed_at is preserved', !!after.completed_at);
    ck('the error is preserved', /saving failed/.test(after.error || ''), after.error);
    ck('progress is not rewound', after.progress_percent === 85, String(after.progress_percent));

    // An explicit terminal transition is still allowed: that is the retry path.
    const done = await db.completeQwenJob(jobId, 'test-report-id');
    ck('an explicit save retry can still complete it', done.status === 'completed', done.status);
    ck('progress becomes 100 on completion', done.progress_percent === 100);
  } finally {
    if (created) {
      await db.deleteQwenJobForTest ? null : null;
      const { Pool } = require('pg');
      const p = new Pool({ connectionString: process.env.DATABASE_URL,
                           ssl: { rejectUnauthorized: false } });
      await p.query('DELETE FROM account_research_qwen_jobs WHERE job_id = $1', [jobId]);
      await p.end();
      console.log('  (throwaway job removed)');
    }
  }

  console.log(`\n${pass} passed, ${fail.length} failed`);
  fail.forEach((f) => console.log('  FAILED: ' + f));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR:', e.message); process.exit(1); });
