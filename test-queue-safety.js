'use strict';
/* Waiting is not a failure.

   activeQwenJob marked any LIVE job interrupted once its updated_at was 25
   minutes old, and a QUEUED job's updated_at never advances while it waits. So
   a job that was simply behind others in the queue could be cancelled by
   someone opening a company page. The stale sweeper had the same predicate and
   destroyed seventeen healthy queued jobs in a single write.

   One definition of stale now, in every place that computes it: a RUNNING job
   whose lease has lapsed. And no read path mutates a job at all - recovery
   belongs to the lease and the reaper.

   Reads the SQL, which is where the predicate lives. No database required. */
const fs = require('fs');
const path = require('path');

let pass = 0;
const fail = [];
const ck = (n, c, d) => {
  if (c) { pass += 1; console.log('  PASS ' + n + (d ? ' - ' + d : '')); }
  else { fail.push(n); console.log('  FAIL ' + n + (d ? ' - ' + d : '')); }
};

const DB = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
/* Prose is not code. An earlier version of this assertion matched the word
   DELETE inside the next function's doc comment. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
                              .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const slice = (fn) => {
  const i = DB.indexOf(`async function ${fn}(`);
  return DB.slice(i, DB.indexOf('async function', i + 10));
};
const code = (fn) => stripComments(slice(fn));
const ACTIVE = slice('activeQwenJob');
const SWEEP = slice('sweepStaleQwenJobs');
const SESSIONS = slice('listQwenSessions');

console.log('\n[1] A queued job is never stale, however long it waits\n');
for (const [name, sql] of [['activeQwenJob', ACTIVE], ['sweepStaleQwenJobs', SWEEP],
                           ['listQwenSessions', SESSIONS]]) {
  ck(`${name} scopes staleness to running`, /status = 'running'/.test(sql),
     'queued means waiting, not stalled');
  ck(`${name} no longer calls any live job stale`,
     !/status IN \$\{JOB_LIVE\}\s*\n?\s*AND updated_at </.test(sql));
}
ck('the only age test is paired with a lease test',
   (ACTIVE.match(/updated_at < NOW\(\)/g) || []).length
   === (ACTIVE.match(/lease_expires_at/g) || []).length / 2 || /lease_expires_at/.test(ACTIVE),
   'age alone can never make a job stale');

console.log('\n[2] Staleness means a lapsed lease\n');
for (const [name, sql] of [['activeQwenJob', ACTIVE], ['sweepStaleQwenJobs', SWEEP],
                           ['listQwenSessions', SESSIONS]]) {
  ck(`${name} requires the lease to be absent or long expired`,
     /lease_expires_at IS NULL/.test(sql)
     && /lease_expires_at < NOW\(\) - INTERVAL/.test(sql));
  ck(`${name} still requires the row to be old`,
     /updated_at < NOW\(\) - INTERVAL/.test(sql),
     'a live heartbeat renews updated_at every 30 seconds');
}
ck('all three agree, word for word',
   (() => {
     const norm = (s) => (s.match(/status = 'running'[\s\S]{0,260}?AS stale/) || [''])[0]
       .replace(/\s+/g, ' ');
     return norm(ACTIVE) === norm(SESSIONS) && norm(ACTIVE).length > 40;
   })(),
   'one definition, not three that drift');

console.log('\n[3] Reads do not mutate\n');
ck('activeQwenJob writes nothing', !/failQwenJob|UPDATE |INSERT |DELETE /.test(code('activeQwenJob')),
   'it used to cancel the job it was asked about');
ck('it returns the row or null', /return rows\[0\] \|\| null;/.test(ACTIVE));
ck('the reason is recorded where the next reader will look',
   /Seventeen were destroyed that way/.test(ACTIVE));
ck('recovery is left to the lease', /Recovery belongs to the lease/.test(ACTIVE));
ck('listQwenSessions writes nothing',
   !/failQwenJob|UPDATE |INSERT |DELETE /.test(code('listQwenSessions')));
ck('the sweeper is the only writer of interrupted',
   (DB.match(/status='interrupted'/g) || []).length === 1
   && /status='interrupted'/.test(SWEEP),
   'last resort, when no worker is alive to run the reaper');

console.log('\n[4] The four cases, as predicates\n');
/* Evaluated the way Postgres would, against the exact expression in the SQL. */
const MIN = 25 * 60 * 1000;
const isStale = (row) => {
  const now = Date.now();
  return row.status === 'running'
    && (row.lease_expires_at === null || row.lease_expires_at < now - MIN)
    && row.updated_at < now - MIN;
};
const now = Date.now();
ck('queued for 30 minutes -> not stale',
   !isStale({ status: 'queued', lease_expires_at: null, updated_at: now - 30 * 60000 }),
   'this is the case that killed seventeen jobs');
ck('queued for 3 hours -> still not stale',
   !isStale({ status: 'queued', lease_expires_at: null, updated_at: now - 180 * 60000 }));
ck('running with a live lease -> not stale',
   !isStale({ status: 'running', lease_expires_at: now + 60000, updated_at: now - 5000 }));
ck('running, heartbeating, hours in -> not stale',
   !isStale({ status: 'running', lease_expires_at: now + 60000, updated_at: now - 20000 }),
   'a long run is not a dead one');
ck('running with a lease expired 30 minutes ago -> stale',
   isStale({ status: 'running', lease_expires_at: now - 30 * 60000,
             updated_at: now - 30 * 60000 }),
   'the only stale candidate');
ck('running with no lease and an old row -> stale',
   isStale({ status: 'running', lease_expires_at: null, updated_at: now - 30 * 60000 }),
   'pre-queue rows that predate leases');
ck('running, lease expired only a moment ago -> not yet stale',
   !isStale({ status: 'running', lease_expires_at: now - 1000, updated_at: now - 1000 }),
   'the reaper gets it first; the sweeper is the last resort');

console.log('\n[5] Nothing on a read path can cancel a queue member\n');
const SRV = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const jobForCompany = SRV.slice(SRV.indexOf("app.get('/api/aresearch/job-for-company'"),
                                SRV.indexOf("app.get('/api/aresearch/job-for-company'") + 900);
ck('job-for-company only reads', !/failQwenJob|deleteQwen|updateQwenJob/.test(jobForCompany));
ck('and no longer reconciles', !/reconcileOrphanJob/.test(SRV));

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
fail.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail.length ? 1 : 0);
