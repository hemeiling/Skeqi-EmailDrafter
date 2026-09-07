/* Cancelling queued research.
 *
 * Runs against live Neon on a THROWAWAY table that is an exact copy of the real
 * one, so the claim query, the partial indexes and the guarded updates are the
 * real statements against real Postgres. Nothing here touches production rows.
 *
 *   node -r dotenv/config test-queue-cancel.js
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { Pool } = require('pg');

let pass = 0; const fail = [];
const ck = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const T = 'test_arq_cancel_' + Date.now().toString(36);
const pool = new Pool({ connectionString: process.env.DATABASE_URL,
                        ssl: { rejectUnauthorized: false } });
const q = (sql, p) => pool.query(sql.replace(/\{t\}/g, T), p).then((r) => r.rows);

/* The production statements, with the table name swapped. Copied from db.js and
   job_store.py by shape, then asserted against those files at the end so a
   change there cannot silently pass here. */
const CANCEL_ONE = `
  UPDATE {t} SET status='cancelled', completed_at=NOW(), updated_at=NOW(), error=$2
   WHERE job_id=$1 AND status='queued'
  RETURNING job_id, company_name, status`;
const CANCEL_ALL = `
  UPDATE {t} SET status='cancelled', completed_at=NOW(), updated_at=NOW(), error=$1
   WHERE status='queued'
  RETURNING job_id, company_name`;
const CLAIM = `
  WITH claimable AS (
    SELECT job_id FROM {t} WHERE status='queued' ORDER BY queued_at LIMIT 1
    FOR UPDATE SKIP LOCKED)
  UPDATE {t} j SET status='running', worker_id=$1, attempts=j.attempts+1,
         started_at=COALESCE(j.started_at, now()), updated_at=now()
    FROM claimable c WHERE j.job_id=c.job_id
  RETURNING j.job_id, j.company_name`;

const seed = (id, company, status, extra = {}) => q(
  `INSERT INTO {t} (job_id, company_key, company_name, status, stage,
                    queued_at, started_at, attempts, worker_id)
   VALUES ($1,$2,$3,$4,$5,NOW() - ($6 || ' minutes')::interval,$7,$8,$9)`,
  [id, company.toLowerCase(), company, status, extra.stage || 'queued',
   String(extra.ageMin == null ? 1 : extra.ageMin),
   extra.started_at || null, extra.attempts || 0, extra.worker || null]);

(async () => {
  await q(`CREATE TABLE {t} (LIKE account_research_qwen_jobs
                             INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
  await q(`CREATE UNIQUE INDEX ON {t}(company_key) WHERE status IN ('queued','running')`);
  try {
    console.log('\n[A] A queued job can be cancelled\n');
    await seed('j1', 'Alpha', 'queued', { ageMin: 5 });
    const one = await q(CANCEL_ONE, ['j1', 'Cancelled from the queue before it started.']);
    ck('one row affected', one.length === 1, String(one.length));
    ck('its status is cancelled', one[0] && one[0].status === 'cancelled');
    const j1 = (await q(`SELECT * FROM {t} WHERE job_id='j1'`))[0];
    ck('completed_at was set', !!j1.completed_at);
    ck('started_at was NOT invented', j1.started_at === null,
       'the job never ran');
    ck('attempts was NOT incremented', Number(j1.attempts) === 0, String(j1.attempts));
    ck('no worker or lease was invented', j1.worker_id === null && j1.lease_expires_at === null);
    ck('it carries a reason', /Cancelled from the queue/.test(j1.error || ''));
    ck('identity is preserved', j1.company_name === 'Alpha' && j1.company_key === 'alpha');
    ck('the row still exists', !!j1, 'cancellation is not deletion');

    console.log('\n[B] A cancelled job cannot be claimed\n');
    const claimed = await q(CLAIM, ['worker-A']);
    ck('the worker finds nothing to claim', claimed.length === 0,
       claimed.map((c) => c.company_name).join(', '));
    const after = (await q(`SELECT status, attempts FROM {t} WHERE job_id='j1'`))[0];
    ck('and the cancelled row is untouched by the attempt',
       after.status === 'cancelled' && Number(after.attempts) === 0);

    console.log('\n[C] A cancelled job cannot be revived\n');
    /* The two production writers a late callback reaches. */
    const complete = await q(
      `UPDATE {t} SET status = CASE WHEN status IN ('completed','completed_with_limitations',
                                                    'synthesis_failed','failed','cancelled')
                                    THEN status ELSE 'completed' END,
              report_id=$2, updated_at=NOW()
        WHERE job_id=$1 RETURNING status`, ['j1', 'some-report']);
    ck('a late completeQwenJob cannot complete it',
       complete[0].status === 'cancelled', complete[0].status);
    const failed = await q(
      `UPDATE {t} SET status='failed', error='late', updated_at=NOW()
        WHERE job_id=$1 AND status <> 'cancelled' RETURNING status`, ['j1']);
    ck('a late failQwenJob affects zero rows', failed.length === 0, String(failed.length));
    const heartbeat = await q(
      `UPDATE {t} SET status = CASE WHEN status = ANY($2) THEN status ELSE 'running' END
        WHERE job_id=$1 RETURNING status`,
      ['j1', ['completed', 'completed_with_limitations', 'interrupted',
              'failed', 'synthesis_failed', 'save_failed', 'cancelled']]);
    ck('a late heartbeat cannot put it back to running',
       heartbeat[0].status === 'cancelled', heartbeat[0].status);

    console.log('\n[D] The race: a worker claims between the read and the cancel\n');
    await seed('j2', 'Beta', 'queued', { ageMin: 4 });
    const won = await q(CLAIM, ['worker-A']);
    ck('the worker claimed it first', won.length === 1 && won[0].job_id === 'j2');
    const late = await q(CANCEL_ONE, ['j2', 'Cancelled from the queue before it started.']);
    ck('the guarded cancel affects ZERO rows', late.length === 0, String(late.length));
    const j2 = (await q(`SELECT status, attempts, started_at, worker_id FROM {t} WHERE job_id='j2'`))[0];
    ck('the running job is intact', j2.status === 'running', j2.status);
    ck('its attempt and start time are the worker\'s, not ours',
       Number(j2.attempts) === 1 && j2.started_at !== null && j2.worker_id === 'worker-A');
    ck('the caller can report the CURRENT state', j2.status === 'running',
       'that is what cancelQueuedJob returns as reason already_running');

    console.log('\n[E] Cancel All touches only queued rows\n');
    await seed('j3', 'Gamma', 'queued', { ageMin: 3 });
    await seed('j4', 'Delta', 'queued', { ageMin: 2 });
    await seed('j5', 'Epsilon', 'completed', { started_at: new Date(), attempts: 1 });
    await seed('j6', 'Zeta', 'interrupted', { started_at: new Date(), attempts: 1 });
    const all = await q(CANCEL_ALL, ['Cancelled from the queue before it started.']);
    ck('exactly the two queued rows were cancelled', all.length === 2,
       all.map((a) => a.company_name).join(', '));
    const states = {};
    for (const r of await q(`SELECT job_id, status FROM {t}`)) states[r.job_id] = r.status;
    ck('the RUNNING job survived Cancel All', states.j2 === 'running', states.j2);
    ck('the completed job was not touched', states.j5 === 'completed', states.j5);
    ck('the historical interrupted job was not touched', states.j6 === 'interrupted', states.j6);
    ck('an already-cancelled job is not re-cancelled', states.j1 === 'cancelled');
    ck('Cancel All on an empty queue affects nothing',
       (await q(CANCEL_ALL, ['x'])).length === 0);

    console.log('\n[F] The company becomes eligible again\n');
    /* The live duplicate guard is a partial unique index over queued+running.
       Cancelling drops the row out of it, so a new run may be enqueued. */
    let reQueued = false;
    try {
      await seed('j7', 'Gamma', 'queued', { ageMin: 0 });
      reQueued = true;
    } catch (e) { reQueued = false; }
    ck('a new job for a cancelled company can be queued', reQueued,
       'the partial unique index covers only queued and running');
    let blocked = false;
    try { await seed('j8', 'Beta', 'queued', { ageMin: 0 }); }
    catch (e) { blocked = /unique|duplicate/i.test(e.message); }
    ck('but a company with a RUNNING job is still blocked', blocked,
       'the duplicate guard still holds where it should');

    console.log('\n[G] The queue summary counts what is live\n');
    const rows = await q(
      `SELECT status, EXTRACT(EPOCH FROM (NOW()-queued_at)) AS waiting_seconds
         FROM {t} WHERE status IN ('queued','running') ORDER BY queued_at`);
    const queued = rows.filter((r) => r.status === 'queued');
    const running = rows.filter((r) => r.status === 'running');
    ck('queued count', queued.length === 1, String(queued.length));
    ck('running count', running.length === 1, String(running.length));
    ck('cancelled rows are not counted as live',
       rows.length === 2, String(rows.length));
    ck('the oldest wait is a real elapsed time',
       queued.length && Number(queued[0].waiting_seconds) >= 0);

    console.log('\n[H] Cancelled is terminal and quiet, in the shipped code\n');
    const DB = fs.readFileSync(__dirname + '/db.js', 'utf8');
    const SRV = fs.readFileSync(__dirname + '/server.js', 'utf8');
    const QR = fs.readFileSync(__dirname + '/public/qwen-research.js', 'utf8');
    ck('JOB_TERMINAL includes cancelled',
       /JOB_TERMINAL = \[[^\]]*'cancelled'\]/s.test(DB));
    ck('completeQwenJob refuses to overwrite it',
       /'synthesis_failed','failed','cancelled'\) THEN status/.test(DB));
    ck('failQwenJob refuses to overwrite it',
       /WHERE job_id=\$1 AND status <> 'cancelled'/.test(DB));
    ck('the cancel guard is on the statement, not in JavaScript',
       /WHERE job_id = \$1 AND status = 'queued'/.test(DB));
    ck('Cancel All is scoped to queued only',
       /WHERE status = 'queued'\s*\n\s*RETURNING job_id, company_name, company_key/.test(DB));
    ck('the cancel never writes started_at, attempts, worker or lease',
       !/status = 'cancelled'[\s\S]{0,300}(started_at|attempts|worker_id|lease_expires_at)\s*=/.test(DB));
    ck('sessionState reports it', /case 'cancelled':\s*return 'cancelled';/.test(SRV));
    ck('it is NOT in the attention set',
       !/SESSION_ATTENTION_STATES = new Set\(\s*\[[^\]]*cancelled/.test(SRV));
    ck('it is NOT in the live set',
       !/SESSION_LIVE_STATES = new Set\(\[[^\]]*cancelled/.test(SRV));
    ck('the client shows it bilingually in history',
       /cancelled:\s*\['Cancelled', '已取消'/.test(QR));
    ck('and the client attention set excludes it',
       !/SESSION_NEEDS_ATTENTION = new Set\(\s*\[[^\]]*'cancelled'/.test(QR));
    ck('running cancellation is not offered',
       /\$\{queued\s*\n?\s*\? `<input type="checkbox"/.test(QR),
       'only a queued row gets a checkbox');
    ck('and Select All ticks queued rows only',
       /\.filter\(\(j\) => j\.status === 'queued'\)\s*\n?\s*\.forEach\(\(j\) => queueSel\.add/.test(QR));
    ck('Cancel All asks first, and says what is not affected',
       /Cancel all \$\{n\} queued research jobs\? Running jobs will not be affected\. `\s*\+ `Cancelled jobs remain in history\./.test(QR));
    ck('a job that started is explained, not reported as an error',
       /had already started and were not cancelled/.test(QR));
    ck('the worker claim query still selects only queued rows',
       /WHERE status = 'queued'/.test(
         fs.readFileSync('/Users/meilinghe/Downloads/Qwen API Search 测试用例/job_store.py', 'utf8')),
       'a cancelled row leaves the claimable index by itself');
  } finally {
    await q(`DROP TABLE IF EXISTS {t}`);
    console.log('\n  (throwaway table dropped)');
    await pool.end();
  }

  console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
  fail.forEach((f) => console.log('  FAILED: ' + f));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR:', e.stack || e.message); process.exit(1); });
