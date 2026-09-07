/* Live work is never hidden by history's paging.
 *
 * Recent Sessions is ordered by start time, and a queued job has none, so
 * Postgres sorted the seven live jobs in among thirty-two historical rows that
 * also had none. The result: Manage Queue said "6 waiting, 1 running" and
 * showed all seven, while Recent Sessions said "7 running" and displayed one.
 *
 * The invariant this pins: at one polling snapshot, the job ids Manage Queue
 * calls live are exactly the job ids Active Now shows.
 *
 *   node -r dotenv/config test-active-now.js
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const db = require('./db.js');

let pass = 0; const fail = [];
const ck = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const SRC = fs.readFileSync(path.join(__dirname, 'public/qwen-research.js'), 'utf8');
const DB = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const SRV = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const pool = new Pool({ connectionString: process.env.DATABASE_URL,
                        ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    console.log('\n[1] One definition of live, used by both surfaces\n');
    ck('the live session list uses JOB_LIVE',
       /listQwenActiveSessions[\s\S]{0,400}WHERE status IN \$\{JOB_LIVE\}/.test(DB));
    ck('the queue summary uses JOB_LIVE',
       /queueSummary[\s\S]{0,900}WHERE status IN \$\{JOB_LIVE\}/.test(DB));
    ck('there is exactly one JOB_LIVE',
       (DB.match(/const JOB_LIVE = /g) || []).length === 1,
       'a second definition is how the two surfaces would drift');
    ck('and no second live-state system in the client',
       (SRC.match(/const SESSION_LIVE = new Set/g) || []).length === 1);

    console.log('\n[2] History is history; live is not paged\n');
    ck('the paged list excludes live rows',
       /listQwenSessions[\s\S]{0,600}WHERE status NOT IN \$\{JOB_LIVE\}/.test(DB),
       'live work must not compete for a page slot');
    ck('the live list has no LIMIT and no cursor',
       !/listQwenActiveSessions[\s\S]{0,400}LIMIT/.test(DB));
    ck('both read the same columns',
       (DB.match(/\$\{SESSION_COLUMNS\}/g) || []).length === 2,
       'one select, so the two lists cannot render different shapes');
    ck('running sorts above queued',
       /ORDER BY \(status = 'running'\) DESC, queued_at/.test(DB));

    console.log('\n[3] The live jobs Manage Queue names are the ones Active Now shows\n');
    const queue = await db.queueSummary();
    const active = await db.listQwenActiveSessions();
    const qIds = queue.jobs.map((j) => j.job_id).sort();
    const aIds = active.map((j) => j.job_id).sort();
    console.log('    live jobs in production right now: ' + qIds.length);
    ck('the two sets are identical',
       JSON.stringify(qIds) === JSON.stringify(aIds),
       `queue ${qIds.length} vs active ${aIds.length}`);
    ck('and the counts agree',
       queue.queued + queue.running === active.length,
       `${queue.queued}+${queue.running} vs ${active.length}`);
    ck('every active row is queued or running',
       active.every((j) => j.status === 'queued' || j.status === 'running'),
       [...new Set(active.map((j) => j.status))].join(', '));

    console.log('\n[4] Paging cannot hide live work\n');
    /* The real failure: ask for ONE row of history and check the live list is
       still complete. Before this change the live jobs WERE the paged list. */
    const onePage = await db.listQwenSessions({ limit: 1 });
    ck('a one-row history page still leaves every live job listed',
       active.length === qIds.length,
       'the live list is a separate query');
    ck('and that page contains no live row',
       onePage.every((r) => r.status !== 'queued' && r.status !== 'running'),
       onePage.map((r) => r.status).join(', '));
    const bigPage = await db.listQwenSessions({ limit: 100 });
    ck('no page of history contains a live row at all',
       bigPage.every((r) => r.status !== 'queued' && r.status !== 'running'));
    ck('history plus live accounts for every job',
       (await pool.query('select count(*)::int n from account_research_qwen_jobs')).rows[0].n
         >= bigPage.length + active.length);

    console.log('\n[5] The server sends both, and the header can tell them apart\n');
    ck('the route returns an unpaged active list',
       /active = \(await jobsDb\.listQwenActiveSessions\(\)\)/.test(SRV));
    ck('classified by the same sessionState as the rows',
       /listQwenActiveSessions\(\)\)\s*\n?\s*\.map\(\(r\) => \(\{ \.\.\.r, state: sessionState\(r\) \}\)\)/.test(SRV));
    ck('a failure there does not fail the list',
       /console\.error\('active sessions failed:/.test(SRV),
       'best effort, like every other optional read');
    ck('totals split researching from queued',
       /totals\.researching \+= 1/.test(SRV) && /totals\.queued \+= 1/.test(SRV));
    ck('and count history separately',
       /else totals\.history \+= 1;/.test(SRV));

    console.log('\n[6] The client renders two sections and says which is which\n');
    ck('Active Now has its own list element', /\$\('qr-sess-active'\)/.test(SRC));
    ck('it renders through the same keyed reconciliation',
       /syncSessionRows\(activeList, shownActive, false\)/.test(SRC),
       'the menu fix from 18f8cee must still hold here');
    ck('history keeps its own reconciliation',
       /syncSessionRows\(list, shown, histPicking\)/.test(SRC));
    ck('the header reports researching and queued separately',
       /\$\{runN\} researching \/ \$\{runN\} 个研究中/.test(SRC)
       && /\$\{queueN\} queued \/ \$\{queueN\} 个排队中/.test(SRC));
    ck('and no longer calls the sum "running"',
       !/\$\{liveN\} running/.test(SRC) && !/\$\{liveN\} active/.test(SRC));
    ck('"shown of" now describes history only',
       /history shown/.test(SRC), 'live work is never paged, so it never counts');
    ck('polling continues while anything is live',
       /if \(!sessionActive\.length\) return;/.test(SRC));
    ck('both lists answer clicks',
       /list\.addEventListener\('click', onListClick\);/.test(SRC)
       && /activeList\.addEventListener\('click', onListClick\)/.test(SRC));
    ck('both lists defer an open menu',
       /list\.addEventListener\('toggle', onToggle, true\);/.test(SRC)
       && /activeList\.addEventListener\('toggle', onToggle, true\)/.test(SRC));
    ck('lookups still see live rows',
       /const allSessions = \(\) => sessionActive\.concat\(sessions\);/.test(SRC),
       'selecting a running session must still work');
    ck('an older server payload still fills the section',
       /r\.sessions\.filter\(\(x\) => SESSION_LIVE\.has\(x\.state\)\)/.test(SRC));
    ck('history and live are never merged into one array',
       !/sessions = sessions\.concat\(sessionActive/.test(SRC));
    ck('no historical status is rewritten anywhere here',
       !/UPDATE account_research_qwen_jobs[\s\S]{0,200}status='interrupted'/.test(
         DB.slice(DB.indexOf('const SESSION_COLUMNS'), DB.indexOf('async function deleteQwenSession'))));
  } finally {
    await pool.end();
  }
  console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
  fail.forEach((f) => console.log('  FAILED: ' + f));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR:', e.stack || e.message); process.exit(1); });
