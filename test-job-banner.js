/* A job that is waiting has not failed.
 *
 * The Single Company reattach banner re-derived its own verdict from the raw
 * status: anything but the literal string 'completed' was rendered red, with
 * the durable status printed into the sentence. So SpaceX, whose one job row is
 * completed_with_limitations with a saved report, showed "Research did not
 * complete" while Recent History showed the report and an Open button.
 *
 * It could also fire on a job that was still QUEUED, because a dropped
 * /job-for-company request was indistinguishable from "no live job".
 *
 * These drive the shipped mapping and the shipped loop, lifted from the file.
 *
 *   node test-job-banner.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0; const fail = [];
const ck = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const QR = fs.readFileSync(path.join(__dirname, 'public/qwen-research.js'), 'utf8');
const SRV = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

const lift = (startRe, endMarker) => {
  const i = QR.search(startRe);
  const j = QR.indexOf(endMarker, i);
  if (i < 0 || j < 0) throw new Error('could not lift ' + startRe);
  return QR.slice(i, j + endMarker.length);
};

/* The shipped table and the shipped renderer, with msg() captured. */
const captured = [];
const sandbox = `
  const esc = (v) => String(v == null ? '' : v);
  const msg = (el, text, kind) => captured.push({ el, text, kind });
${lift(/^  const JOB_BANNER = \{/m, '\n  };')}
${lift(/^  function showJobBanner\(row\) \{/m, '\n  }')}
${lift(/^  const JOB_TERMINAL_STATES = new Set/m, ');')}
  return { JOB_BANNER, showJobBanner, JOB_TERMINAL_STATES };
`;
const api = new Function('captured', sandbox)(captured);
const banner = (row) => {
  captured.length = 0;
  api.showJobBanner(row);
  return captured[0];
};

console.log('\n[1] Waiting and running are not failures\n');
for (const st of ['queued', 'researching', 'generating']) {
  const b = banner({ state: st });
  ck(`${st} is never red`, b.kind !== 'err', b.kind);
  /* The old banner printed `latest.error || latest.status` - the bare database
     value - as the whole explanation. A sentence with a verb is the test. */
  ck(`${st} reads as a sentence, not a database value`,
     b.text.includes('<strong>') && /\.|。/.test(b.text) && b.text.length > 24,
     b.text.slice(0, 40));
}
ck('queued reads as queued research, in both languages',
   /Research queued/.test(banner({ state: 'queued' }).text)
   && /研究已排队/.test(banner({ state: 'queued' }).text));
ck('running reads as in progress, in both languages',
   /Research in progress/.test(banner({ state: 'researching' }).text)
   && /研究进行中/.test(banner({ state: 'researching' }).text));

console.log('\n[2] Success is not a failure either\n');
const lim = banner({ state: 'completed_with_limitations' });
ck('completed_with_limitations is not red', lim.kind !== 'err', lim.kind);
ck('it is an amber notice', lim.kind === 'warn', lim.kind);
ck('and it says what the limitation was',
   /Limited verified public evidence/.test(lim.text) && /可验证的公开信息有限/.test(lim.text));
ck('completed is not red', banner({ state: 'completed' }).kind !== 'err');

console.log('\n[3] Cancellation is not a failure\n');
const can = banner({ state: 'cancelled' });
ck('cancelled is neutral', can.kind === 'info', can.kind);
ck('and does not say the research failed',
   !/did not complete|failed|失败/.test(can.text), can.text);
const never = banner({ state: 'interrupted_before_start' });
ck('a job that never started is not called a failure', never.kind !== 'err', never.kind);
ck('and says so plainly', /never began/.test(never.text));

console.log('\n[4] Genuine failures still read as failures\n');
ck('failed is red', banner({ state: 'failed' }).kind === 'err');
ck('synthesis_failed is red', banner({ state: 'synthesis_failed' }).kind === 'err');
ck('and says the evidence was kept',
   /evidence that was retrieved is preserved/.test(banner({ state: 'synthesis_failed' }).text));
ck('interrupted is a warning, not a dead end',
   banner({ state: 'interrupted' }).kind === 'warn');
ck('save_failed is a warning and mentions the retry',
   banner({ state: 'save_failed' }).kind === 'warn'
   && /can be retried|可重试/.test(banner({ state: 'save_failed' }).text));
ck('a failure shows the row\'s own reason',
   /boom/.test(banner({ state: 'failed', error: 'boom' }).text));
ck('but a success never does',
   !/boom/.test(banner({ state: 'completed_with_limitations', error: 'boom' }).text),
   'an error string on a successful row would be noise');
ck('an unknown state falls back to a failure rather than silence',
   banner({ state: 'something-new' }).kind === 'err');

console.log('\n[5] One mapping, shared with everything else\n');
ck('the server sends the SAME state the sessions list uses',
   /const withState = \(r\) => \(r \? \{ \.\.\.r, state: sessionState\(r\) \} : null\);/.test(SRV));
ck('and both rows carry it',
   /res\.json\(\{ active: withState\(active\), latest: withState\(latest\) \}\)/.test(SRV));
ck('there is still exactly one sessionState on the server',
   (SRV.match(/^function sessionState\(row\)/gm) || []).length === 1);
ck('the client maps state, never raw status',
   /JOB_BANNER\[row && row\.state\]/.test(QR)
   && !/latest\.status === 'completed'/.test(
        QR.slice(QR.indexOf('async function resumeJob'), QR.indexOf('function scheduleLookup'))));
ck('the red catch-all is gone', !/Research did not complete/.test(QR));
ck('every state the server can emit has a banner',
   ['queued', 'researching', 'generating', 'completed', 'completed_with_limitations',
    'synthesis_failed', 'save_failed', 'interrupted', 'interrupted_before_start',
    'cancelled', 'failed'].every((k) => k in api.JOB_BANNER));
ck('live states are not counted as terminal',
   !['queued', 'researching', 'generating'].some((k) => api.JOB_TERMINAL_STATES.has(k)));

console.log('\n[6] A dropped request is not an outcome\n');
ck('jobForCompany reports whether it could ask',
   /return \{ ok: true, active: d\.active \|\| null, latest: d\.latest \|\| null \};/.test(QR)
   && /catch \(e\) \{ return \{ ok: false, active: null, latest: null \}; \}/.test(QR));
ck('a non-200 counts as a failed ask, not an empty answer',
   /r\.ok \? r\.json\(\) : Promise\.reject/.test(QR),
   'a 500 used to parse as {} and read as "nothing is running"');
const resume = QR.slice(QR.indexOf('async function resumeJob'), QR.indexOf('function scheduleLookup'));
ck('the reattach loop keeps waiting when it cannot ask',
   /if \(!look\.ok\) \{ await new Promise\(\(r\) => setTimeout\(r, 1500\)\); continue; \}/.test(resume));
ck('and only stops when the durable row says nothing is live',
   /if \(!look\.active\) break;/.test(resume));
const follow = QR.slice(QR.indexOf('async function followRowJob'), QR.indexOf('function batchTotals') > 0
  ? QR.indexOf('function batchTotals') : QR.indexOf('async function followRowJob') + 4000);
ck('Batch keeps waiting too, instead of marking the row interrupted',
   /if \(!look\.ok\) \{ await new Promise\(\(r\) => setTimeout\(r, 1500\)\); continue; \}/.test(follow),
   'one dropped lookup used to mark a live row interrupted');
ck('Batch still marks interrupted when the row really is gone',
   /if \(!look\.active\) \{[\s\S]{0,220}status: \(row && row\.status\) \|\| 'interrupted'/.test(follow));
ck('starting a run refuses to guess that nothing is running',
   /if \(!look\.ok\) return undefined;/.test(QR)
   && /if \(running === undefined\) \{/.test(QR),
   'a dropped lookup could otherwise start a second paid run');
ck('and says nothing was started',
   /Nothing was started\./.test(QR) && /未启动任务/.test(QR));
/* The failure is carried as `ok:false` beside the rows, not as a pretend
   lifecycle state that would then need a banner, a colour and a meaning. */
ck('no new state was invented for a fetch failure',
   !Object.keys(api.JOB_BANNER).some((k) => /fetch|lookup|unknown|offline/.test(k))
   && !/state: 'fetch|state: 'unknown|state: 'lookup/.test(QR),
   Object.keys(api.JOB_BANNER).join(','));
ck('it is carried as a plain ok flag instead',
   /return \{ ok: false, active: null, latest: null \};/.test(QR));

console.log('\n[7] The final state replaces whatever came before it\n');
ck('the loop ends with a fresh durable read',
   /const done = await jobForCompany\(company\);/.test(resume));
ck('the banner is rendered from THAT read',
   /showJobBanner\(latest\);/.test(resume));
ck('a completed run clears the banner rather than adding one',
   /if \(latest\.state === 'completed' && latest\.report_id\) \{[\s\S]{0,200}msg\('qr-single-msg', ''\);/
     .test(resume),
   'the report on screen is the message');
ck('and the report is opened BEFORE the outcome is written',
   resume.indexOf('await openReport(company, true);\n      }\n      showJobBanner(latest);') > 0
   || /openReport\(company, true\);[\s\S]{0,40}\}\s*\n\s*showJobBanner\(latest\);/.test(resume),
   'openReport clears the banner as its first act');
ck('nothing is claimed when the final read itself fails',
   /if \(!done\.ok \|\| !latest\) return;/.test(resume));

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
fail.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail.length ? 1 : 0);
