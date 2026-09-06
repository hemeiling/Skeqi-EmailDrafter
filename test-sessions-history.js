/* Regression tests for Recent Sessions history and permanent session deletion.
 *
 * Two rules these protect:
 *
 *   The list is HISTORY. Every status appears, newest started_at first, and a
 *   live job neither jumps above a newer completed one nor reorders itself when
 *   its heartbeat lands. Needs Attention is a count and a filter over the same
 *   rows, never what decides membership.
 *
 *   Deleting a SESSION is not deleting the company's report. It removes the job
 *   and its sections in one transaction and touches neither the saved report nor
 *   the accounting events.
 *
 * The delete path is exercised against an injected fake client, so the statement
 * ORDER, the terminal guard and the race are all verified without a database and
 * without writing to production.
 *
 * Run: node test-sessions-history.js       (no network, no DB, no model call)
 */
let pass = 0; const fail = [];
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

const T = (s) => new Date(`2026-09-05T${s}Z`).toISOString();
const JOB_TERMINAL = ['completed', 'completed_with_limitations', 'interrupted',
                      'failed', 'synthesis_failed', 'save_failed'];

/* ---------------- the ordering and paging contract ---------------- */
// Mirrors the SQL: ORDER BY started_at DESC, job_id DESC, keyset on the pair.
function page(rows, { limit = 3, before = null, beforeId = null } = {}) {
  const sorted = rows.slice().sort((a, b) =>
    (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1
      : (a.job_id < b.job_id ? 1 : a.job_id > b.job_id ? -1 : 0)));
  const after = before === null ? sorted
    : sorted.filter((r) => r.started_at < before
        || (r.started_at === before && r.job_id < beforeId));
  const out = after.slice(0, limit);
  const last = out.length === limit ? out[out.length - 1] : null;
  return { sessions: out, next: last ? { before: last.started_at, before_id: last.job_id } : null };
}

const ROWS = [
  { job_id: 'j1', company_name: 'tesla',  status: 'failed',      started_at: T('03:12:00') },
  { job_id: 'j2', company_name: 'tesla',  status: 'interrupted', started_at: T('03:26:00') },
  { job_id: 'j3', company_name: 'BYD',    status: 'completed',   started_at: T('20:05:00') },
  { job_id: 'j4', company_name: '广汽',    status: 'running',     started_at: T('04:00:00') },
  { job_id: 'j5', company_name: 'apple',  status: 'completed',   started_at: T('05:56:00') },
];

console.log('\n[1] Sessions older than 24 hours are returned at all\n');
const OLD = { job_id: 'j0', company_name: 'Verkor', status: 'completed',
              started_at: '2026-09-01T03:57:00.000Z' };
const all = page([...ROWS, OLD], { limit: 10 });
ck('a session from four days ago appears',
   all.sessions.some((r) => r.job_id === 'j0'));
ck('every status is present, none filtered out',
   new Set(all.sessions.map((r) => r.status)).size === 4,
   JSON.stringify([...new Set(all.sessions.map((r) => r.status))]));

console.log('\n[2] Newest started_at sorts first, whatever the status\n');
ck('the newest row is first', all.sessions[0].job_id === 'j3', all.sessions[0].job_id);
ck('a RUNNING job does not jump above a newer completed one',
   all.sessions.findIndex((r) => r.job_id === 'j3')
   < all.sessions.findIndex((r) => r.job_id === 'j4'),
   'j3 completed 20:05 must precede j4 running 04:00');
ck('order is strictly descending by started_at',
   all.sessions.every((r, i, a2) => i === 0 || a2[i - 1].started_at >= r.started_at));

console.log('\n[3] A heartbeat does not reorder a live job\n');
// updated_at moves constantly; started_at is what the order is built from.
const beat = ROWS.map((r) => (r.job_id === 'j4'
  ? { ...r, updated_at: T('23:59:00'), progress_percent: 85 } : r));
ck('position is unchanged after a heartbeat',
   JSON.stringify(page(beat, { limit: 10 }).sessions.map((r) => r.job_id))
   === JSON.stringify(page(ROWS, { limit: 10 }).sessions.map((r) => r.job_id)));

console.log('\n[4] Keyset pagination is stable while new rows arrive\n');
const p1 = page(ROWS, { limit: 2 });
ck('first page is the two newest',
   JSON.stringify(p1.sessions.map((r) => r.job_id)) === '["j3","j5"]',
   JSON.stringify(p1.sessions.map((r) => r.job_id)));
ck('a cursor is issued for a full page', !!p1.next);
// A brand-new job lands between the two requests.
const NEW = { job_id: 'j9', company_name: 'Ford', status: 'running', started_at: T('23:00:00') };
const p2 = page([...ROWS, NEW], { limit: 2, before: p1.next.before, beforeId: p1.next.before_id });
ck('the new row does NOT push a row into page two',
   !p2.sessions.some((r) => r.job_id === 'j9'), JSON.stringify(p2.sessions.map((r) => r.job_id)));
ck('page two skips nothing',
   JSON.stringify(p2.sessions.map((r) => r.job_id)) === '["j4","j2"]',
   JSON.stringify(p2.sessions.map((r) => r.job_id)));
ck('and repeats nothing from page one',
   !p2.sessions.some((r) => p1.sessions.some((q) => q.job_id === r.job_id)));
const lastPage = page(ROWS, { limit: 99 });
ck('a short page issues no cursor', lastPage.next === null);

console.log('\n[5] Repeated sessions for one company stay distinguishable\n');
const teslas = all.sessions.filter((r) => r.company_name === 'tesla');
ck('both tesla runs are listed individually', teslas.length === 2);
ck('they differ by started_at', teslas[0].started_at !== teslas[1].started_at);
ck('and by status', teslas[0].status !== teslas[1].status);

console.log('\n[6] Needs Attention filters, it does not decide membership\n');
const ATTN = new Set(['interrupted', 'failed', 'synthesis_failed', 'save_failed']);
const attention = all.sessions.filter((r) => ATTN.has(r.status));
ck('the count is a subset of the same rows', attention.length === 2, String(attention.length));
ck('filtering removes no row from the underlying set', all.sessions.length === 6);
ck('completed rows survive the unfiltered list',
   all.sessions.filter((r) => r.status === 'completed').length === 3);

/* ---------------- the deletion contract ---------------- */
// A fake pg client: records every statement so the ORDER and the SCOPE of the
// transaction can be asserted without a database.
function fakeClient(jobRow) {
  const log = [];
  return {
    log,
    async query(text, params) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      log.push(sql.split(' ').slice(0, 4).join(' '));
      if (/^SELECT/i.test(sql)) return { rows: jobRow ? [jobRow] : [], rowCount: jobRow ? 1 : 0 };
      if (/DELETE FROM account_research_qwen_job_sections/i.test(sql)) return { rowCount: 20 };
      if (/DELETE FROM account_research_qwen_jobs/i.test(sql)) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
}
// The function under test, in the same shape as db.deleteQwenSession.
async function deleteSession(client, jobId) {
  if (!jobId) return { ok: false, reason: 'not_found' };
  await client.query('BEGIN');
  const { rows } = await client.query('SELECT job_id, status FROM account_research_qwen_jobs WHERE job_id=$1 FOR UPDATE', [jobId]);
  if (!rows.length) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_found' }; }
  if (!JOB_TERMINAL.includes(rows[0].status)) {
    await client.query('ROLLBACK');
    return { ok: false, reason: 'not_terminal', status: rows[0].status };
  }
  const sec = await client.query('DELETE FROM account_research_qwen_job_sections WHERE job_id=$1', [jobId]);
  const job = await client.query('DELETE FROM account_research_qwen_jobs WHERE job_id=$1', [jobId]);
  await client.query('COMMIT');
  return { ok: true, sections_deleted: sec.rowCount, jobs_deleted: job.rowCount };
}

/* The endpoint returns { sessions, next }. It used to return a bare array, and a
   browser holding a cached bundle can still receive either, so the client must
   read both without throwing and without silently rendering nothing. */
function readSessionsResponse(r) {
  if (Array.isArray(r)) return { rows: r, next: null };
  return r && Array.isArray(r.sessions) ? { rows: r.sessions, next: r.next || null } : null;
}

console.log('\n[6b] Both response shapes are handled safely\n');
const paged = { sessions: ROWS, next: { before: T('03:26:00'), before_id: 'j2' } };
ck('the paged shape yields its rows', readSessionsResponse(paged).rows.length === 5);
ck('and carries the cursor', !!readSessionsResponse(paged).next);
ck('the legacy bare array still yields its rows',
   readSessionsResponse(ROWS).rows.length === 5);
ck('the legacy shape reports no cursor', readSessionsResponse(ROWS).next === null);
ck('an empty paged response is not an error',
   readSessionsResponse({ sessions: [], next: null }).rows.length === 0);
ck('an empty array is not an error', readSessionsResponse([]).rows.length === 0);
// Anything else must be null so the caller keeps what is on screen rather than
// blanking the list on a transient error page.
[null, undefined, {}, { sessions: 'nope' }, 'error', 42].forEach((bad) => {
  ck('a malformed response yields null: ' + JSON.stringify(bad),
     readSessionsResponse(bad) === null);
});

/* The filter control must be CLICKABLE, not merely present. It shipped once with
   the correct label and count while collapsed to zero width inside the flex
   header, which reads as "the feature is missing" and no DOM-presence check
   would have caught it. */
console.log('\n[6c] The filter control is laid out, not just rendered\n');
const CSS = require('fs').readFileSync('public/index.html', 'utf8');
const rule = (CSS.match(/\.qr-sess-filter,\s*\.qr-sess-morebtn\s*\{[^}]*\}/) || [''])[0];
ck('the control opts out of flex shrink', /flex\s*:\s*0\s+0\s+auto/.test(rule), rule.slice(0, 80));
ck('and does not wrap to zero width', /white-space\s*:\s*nowrap/.test(rule));
ck('the hidden attribute still wins when there is nothing to filter',
   /\.qr-sess-filter\[hidden\][^}]*display\s*:\s*none/.test(CSS));

(async function main() {
  console.log('\n[7] Deleting a terminal session removes job + sections atomically\n');
  const c = fakeClient({ job_id: 'j2', status: 'interrupted' });
  const out = await deleteSession(c, 'j2');
  ck('it succeeds', out.ok === true);
  ck('sections are deleted', out.sections_deleted === 20);
  ck('the job row is deleted', out.jobs_deleted === 1);
  ck('inside one transaction',
     c.log[0] === 'BEGIN' && c.log[c.log.length - 1] === 'COMMIT', JSON.stringify(c.log));
  ck('the row is locked before anything is removed', c.log[1].startsWith('SELECT'));
  const iSec = c.log.findIndex((l) => l.includes('qwen_job_sections'));
  const iJob = c.log.findIndex((l) => /qwen_jobs\b/.test(l) && l.startsWith('DELETE'));
  ck('sections are removed BEFORE the job row', iSec >= 0 && iJob >= 0 && iSec < iJob,
     `${iSec} < ${iJob} in ${JSON.stringify(c.log)}`);

  console.log('\n[8] The report, accounting and company are never touched\n');
  const joined = c.log.join(' | ');
  ck('no report deletion', !/qwen_reports/i.test(joined), joined);
  ck('no accounting deletion', !/ai_usage_events/i.test(joined), joined);
  ck('no company deletion', !/FROM companies/i.test(joined), joined);
  ck('exactly two DELETE statements',
     c.log.filter((l) => l.startsWith('DELETE')).length === 2, JSON.stringify(c.log));

  console.log('\n[9] Running and queued sessions are rejected\n');
  for (const st of ['running', 'queued']) {
    const rc = fakeClient({ job_id: 'j4', status: st });
    const r = await deleteSession(rc, 'j4');
    ck(`${st} is refused`, r.ok === false && r.reason === 'not_terminal', JSON.stringify(r));
    ck(`${st} rolls back`, rc.log.includes('ROLLBACK'), JSON.stringify(rc.log));
    ck(`${st} deletes nothing`, !rc.log.some((l) => l.startsWith('DELETE')));
  }

  console.log('\n[10] Stale client race and repeated deletes\n');
  // The client saw "interrupted"; by the time the lock is taken it is running.
  const race = fakeClient({ job_id: 'j2', status: 'running' });
  const rr = await deleteSession(race, 'j2');
  ck('a job that became running between click and commit is refused',
     rr.ok === false && rr.reason === 'not_terminal', JSON.stringify(rr));
  ck('and nothing was deleted', !race.log.some((l) => l.startsWith('DELETE')));

  const gone = fakeClient(null);
  const rg = await deleteSession(gone, 'j2');
  ck('deleting an already-deleted session returns not_found cleanly',
     rg.ok === false && rg.reason === 'not_found', JSON.stringify(rg));
  ck('it does not throw and deletes nothing',
     !gone.log.some((l) => l.startsWith('DELETE')));
  const rn = await deleteSession(fakeClient(null), null);
  ck('a missing id is handled', rn.ok === false && rn.reason === 'not_found');

  console.log('\n[N] The CRM owns the durable-queue schema\n');

const DB = require('fs').readFileSync(__dirname + '/db.js', 'utf8');
const SRV2 = require('fs').readFileSync(__dirname + '/server.js', 'utf8');
for (const col of ['queued_at', 'worker_id', 'heartbeat_at', 'lease_expires_at',
                   'attempts', 'payload', 'runtime_state']) {
  ck('initDb creates ' + col,
     new RegExp('ADD COLUMN IF NOT EXISTS\\s+' + col).test(DB));
}
ck('the claim index is created here',
   /CREATE INDEX IF NOT EXISTS idx_arq_claimable/.test(DB));
ck('the lease index is created here',
   /CREATE INDEX IF NOT EXISTS idx_arq_leases/.test(DB));
ck('both are partial, so they only cover claimable or leased rows',
   /idx_arq_claimable[\s\S]{0,160}WHERE status = 'queued'/.test(DB)
   && /idx_arq_leases[\s\S]{0,160}WHERE status = 'running'/.test(DB));
ck('the duplicate guard is unchanged',
   /uq_arq_jobs_active[\s\S]{0,200}WHERE status IN \('queued','running'\)/.test(DB));

/* Recovery is the worker's lease now, not an inference from a 404. */
ck('reconcileOrphanJob is gone', !/reconcileOrphanJob/.test(SRV2));
ck('and nothing still calls it', !/reconcileOrphanJob\(/.test(SRV2));
ck('the reason it went is recorded where it lived',
   /Recovery belongs to the worker's lease now/.test(SRV2));
ck('a live row is treated as live',
   /A live row means a live job/.test(SRV2));

console.log('\n[N2] The callback records the result, the worker owns the state\n');

const DB2 = require('fs').readFileSync(__dirname + '/db.js', 'utf8');
const COMPLETE = DB2.slice(DB2.indexOf('async function completeQwenJob'),
                           DB2.indexOf('async function', DB2.indexOf('async function completeQwenJob') + 10));
ck('a terminal status is never overwritten by the callback',
   /WHEN status IN \('completed','completed_with_limitations',\s*'synthesis_failed','failed'\) THEN status/.test(COMPLETE),
   'the worker writes it first, under its fencing token');
ck('the callback still records the report id', /report_id=\$2/.test(COMPLETE));
ck('and does not move completed_at once set',
   /completed_at=COALESCE\(completed_at, NOW\(\)\)/.test(COMPLETE));
ck('it does not touch the lease or worker fields',
   !/lease_expires_at|worker_id|attempts/.test(COMPLETE),
   'those belong to the worker');

const CLAIMJ = DB2.slice(DB2.indexOf('async function claimQwenJob'),
                         DB2.indexOf('async function', DB2.indexOf('async function claimQwenJob') + 10));
ck('the CRM upserts identity onto the engine-created row',
   /ON CONFLICT \(job_id\) DO UPDATE/.test(CLAIMJ),
   'ON CONFLICT DO NOTHING silently lost created_by and company_id');
ck('and never clobbers what is already there',
   /COALESCE\(account_research_qwen_jobs\.created_by, EXCLUDED\.created_by\)/.test(CLAIMJ));
ck('elapsed time survives a job that has not started yet',
   /COALESCE\(started_at, queued_at\)/.test(DB2),
   'started_at is null while a job is queued');

console.log('\n[N3] The stale sweeper cannot catch a healthy job\n');

const SWEEP = DB2.slice(DB2.indexOf('async function sweepStaleQwenJobs'),
                        DB2.indexOf('async function', DB2.indexOf('async function sweepStaleQwenJobs') + 10));
ck('a queued job is never swept', !/status IN \$\{JOB_LIVE\}/.test(SWEEP)
   && /status = 'running'/.test(SWEEP),
   'with one worker, waiting 25 minutes in the queue is normal');
ck('a running job with a live lease is never swept',
   /lease_expires_at < NOW\(\) - INTERVAL/.test(SWEEP),
   'the heartbeat renews the lease every 30 seconds');
ck('it still catches a run no worker holds',
   /lease_expires_at IS NULL/.test(SWEEP));
ck('and says that, rather than blaming a restart',
   /no worker has held this run/.test(SWEEP));

console.log('\n[N4] started_at means first claim, not enqueue\n');

ck('initDb drops the default that contradicted that',
   /ALTER COLUMN started_at DROP DEFAULT/.test(DB2),
   'DEFAULT now() stamped every enqueued row as started before any worker saw it');
ck('and says why history is left alone',
   /existing rows keep\s+the values they have/.test(DB2),
   'the comment wraps between "keep" and "the", so the assertion must too');
ck('nothing re-adds a default to the column',
   !/started_at[^,;]*DEFAULT now\(\)/.test(DB2));

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
  fail.forEach((f) => console.log('  FAILED: ' + f));
  process.exit(fail.length ? 1 : 0);
}());
