/* Session state vs company state.
 *
 * Two questions that were being answered by four independent implementations:
 * "what happened to this job" and "what is this company now". They are allowed
 * to differ - they must not contradict each other, and neither may be derived
 * from the other's facts.
 *
 * sessionState is loaded out of server.js and companyState out of the client,
 * so these test the shipped functions rather than a copy of their rules. */
const fs = require('fs');
const path = require('path');

let pass = 0; const fail = [];
const ck = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name + (detail ? '  [' + detail + ']' : '')); console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
};

/* ── Load the real functions, without booting the server ─────────────────── */

function extract(src, startRe, endMarker) {
  const i = src.search(startRe);
  if (i < 0) throw new Error('not found: ' + startRe);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('end not found for ' + startRe);
  return src.slice(i, j + endMarker.length);
}

const SRV = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const QR = fs.readFileSync(path.join(__dirname, 'public/qwen-research.js'), 'utf8');

const sessionSrc =
  extract(SRV, /const SESSION_LIVE_STATES = new Set/, "'failed']);")
  + '\n' + extract(SRV, /^function sessionState\(row\) \{/m, '\n}');
const sessionState = new Function(sessionSrc + '; return sessionState;')();
const SESSION_ATTENTION_STATES =
  new Function(sessionSrc + '; return SESSION_ATTENTION_STATES;')();
const SESSION_LIVE_STATES =
  new Function(sessionSrc + '; return SESSION_LIVE_STATES;')();

const companyState = new Function(
  extract(QR, /^  function companyState\(opts\) \{/m, '\n  }')
  + '; return companyState;')();

/* ── 1. The never-started state ──────────────────────────────────────────── */

console.log('\n[1] A job no worker ever claimed did not "get interrupted"\n');

const neverStarted = { status: 'interrupted', stage: 'queued', started_at: null, attempts: 0 };
ck('interrupted + no start + no attempt -> interrupted_before_start',
   sessionState(neverStarted) === 'interrupted_before_start',
   sessionState(neverStarted));

ck('attempts null counts as no attempt (older rows)',
   sessionState({ status: 'interrupted', started_at: null, attempts: null })
     === 'interrupted_before_start');

ck('a run that actually started stays interrupted',
   sessionState({ status: 'interrupted', stage: 'model',
                  started_at: '2026-09-06T15:00:00Z', attempts: 1 }) === 'interrupted',
   sessionState({ status: 'interrupted', started_at: '2026-09-06T15:00:00Z', attempts: 1 }));

ck('a claimed job that never recorded a start is still a real run',
   sessionState({ status: 'interrupted', started_at: null, attempts: 2 }) === 'interrupted',
   'attempts prove a worker took it');

ck('the stored status is never rewritten by this',
   /case 'interrupted':/.test(SRV) && !/UPDATE[\s\S]{0,120}status='interrupted_before_start'/i.test(SRV),
   'presentation only');

/* The "· Queued" the user saw came from appending the STAGE to the state. */
console.log('\n[2] It must not read as though research began\n');

const beforeStart = QR.slice(QR.indexOf("x.state === 'interrupted_before_start'"),
                             QR.indexOf("if (SESSION_NEEDS_ATTENTION.has(x.state))"));
ck('the branch exists', beforeStart.length > 0);
ck('it does NOT append the stage',
   !/stageEn/.test(beforeStart),
   'appending the stage is what produced "Interrupted · Queued"');
ck('its context is the timestamp alone', /ctx: when,/.test(beforeStart));
ck('the label is bilingual and names the truth',
   /Interrupted before start/.test(QR) && /启动前中断/.test(QR));

/* ── 3. Needs Attention ──────────────────────────────────────────────────── */

console.log('\n[3] Needs Attention means a person has something to do\n');

ck('a never-started job is NOT attention',
   !SESSION_ATTENTION_STATES.has('interrupted_before_start'));
ck('a real interrupted run IS attention',
   SESSION_ATTENTION_STATES.has('interrupted'));
ck('so are the other failures',
   ['save_failed', 'synthesis_failed', 'failed'].every((s) => SESSION_ATTENTION_STATES.has(s)));
ck('a cancelled job is NOT attention',
   !SESSION_ATTENTION_STATES.has('cancelled'),
   'a person stopped it on purpose; nothing failed');
ck('a cancelled job is not live either', !SESSION_LIVE_STATES.has('cancelled'));
ck('but it is still a state the list can render',
   sessionState({ status: 'cancelled', started_at: null, attempts: 0 }) === 'cancelled',
   'cancelled rows stay in history');
ck('a never-started job is not live either',
   !SESSION_LIVE_STATES.has('interrupted_before_start'),
   'nothing is running');
ck('the client set agrees with the server set',
   !/SESSION_NEEDS_ATTENTION = new Set\(\s*\[[^\]]*interrupted_before_start/.test(QR));

/* A company with a dead history and a live report must not be stuck in
   Needs Attention forever. */
ck('history does not follow the company into attention',
   companyState({ job: null, hasReport: true }) === 'existing',
   'the interrupted job stays in history, the company reads as researched');

/* ── 4. The count is a total, not a page ─────────────────────────────────── */

console.log('\n[4] The count describes the table, not the page\n');

ck('the server counts every job',
   /listQwenSessionStateInputs/.test(SRV),
   'it used to count the 25 loaded rows');
ck('and classifies them with the SAME function the rows use',
   /const st = sessionState\(r\);/.test(SRV),
   'a second copy of the rules would drift');
const DB = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
ck('the counting query is unpaged',
   /listQwenSessionStateInputs[\s\S]{0,700}FROM account_research_qwen_jobs\s*`/.test(DB),
   'no LIMIT, no cursor');
ck('it selects only the columns the rules read',
   /SELECT job_id, status, stage, started_at, attempts, report_id,/.test(DB),
   'no report bodies or manifests');
ck('the client prefers the server total',
   /const attnN = sessionTotals \? sessionTotals\.attention : attention\.length/.test(QR));
ck('and falls back to the page when the server sent none',
   /sessionTotals \? sessionTotals\.live : active\.length/.test(QR));
ck('a partly-loaded filter says so rather than contradicting the count',
   /Showing \$\{shown\.length\} of \$\{attnN\} loaded so far/.test(QR));
ck('the total never fails the list',
   /console\.error\('session totals failed:/.test(SRV),
   'advisory, per the best-effort rule');

/* ── 5. One company-state resolver ───────────────────────────────────────── */

console.log('\n[5] One company answer for both screens\n');

const cases = [
  ['running job',            { job: { status: 'running', stage: 'model' }, hasReport: false }, 'researching'],
  ['running job + report',   { job: { status: 'running', stage: 'model' }, hasReport: true },  'researching'],
  ['queued job',             { job: { status: 'queued', stage: 'queued' }, hasReport: false }, 'queued'],
  ['queued job + report',    { job: { status: 'queued' }, hasReport: true },                   'queued'],
  ['optimistic pre-claim',   { job: { status: 'running', stage: 'queued' }, hasReport: false }, 'queued'],
  ['report, nothing live',   { job: null, hasReport: true },                                   'existing'],
  ['nothing at all',         { job: null, hasReport: false },                                  'pending'],
];
for (const [label, input, want] of cases) {
  ck(label + ' -> ' + want, companyState(input) === want, companyState(input));
}

ck('an active job outranks a stored report',
   companyState({ job: { status: 'running' }, hasReport: true }) === 'researching');

/* The point of the whole exercise: history is not an input. */
console.log('\n[6] History never overrides current company state\n');

ck('companyState takes no history argument',
   !/interrupted|failed|history/i.test(
     QR.slice(QR.indexOf('function companyState(opts)'),
              QR.indexOf('const COMPANY_LABEL'))),
   'a failed job must not be able to change a company state');
ck('a company with an interrupted past and a report reads Existing Report',
   companyState({ job: null, hasReport: true }) === 'existing');
ck('a company with an interrupted past and a new run reads Researching',
   companyState({ job: { status: 'running' }, hasReport: false }) === 'researching');
ck('a company with an interrupted past and nothing else reads Pending',
   companyState({ job: null, hasReport: false }) === 'pending',
   'ready to research, not broken');

console.log('\n[7] Both screens call it\n');

/* Checked as a fact rather than as one exact expression: the badge must derive
   its state from the resolver and label it from the shared map. */
ck('Batch Research resolves its state through it',
   /const state = companyState\(\{ job, hasReport: it\._hasReport \}\);/.test(QR));
ck('and labels the resting states from the shared map',
   /\[st, zh\] = COMPANY_LABEL\[state\];/.test(QR));
ck('the live states come from the same value',
   /if \(state === 'queued'\)/.test(QR) && /if \(state === 'researching'\)/.test(QR),
   'the badge no longer reads job.status itself');
ck('the Single lookup resolves through it',
   /const state = companyState\(\{ job: active, hasReport: exists \}\)/.test(QR));
ck('Batch no longer writes its own Existing Report / Pending strings',
   !/it\.status = 'Existing Report'/.test(QR) && !/it\.status = 'Pending'/.test(QR));
ck('a library hit no longer skips the active-job check',
   /if \(!local\) \{/.test(QR),
   'it returned Existing Report for a company being researched');
ck('Recent Sessions keeps its own vocabulary',
   /interrupted_before_start:\s*\['Interrupted before start'/.test(QR)
   && !/COMPANY_LABEL\[[\s\S]{0,40}x\.state/.test(QR),
   'job history must not be forced into the four company states');

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
fail.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail.length ? 1 : 0);
