/* Batch Research must show WHICH company is executing.
 *
 * Every queued row used to render as "Researching", because three call sites
 * wrote status:'running' onto the live-job map regardless of what the backend
 * actually said. The badge then had no way to tell the two apart.
 *
 * These drive the real statusBadge and the real companyState, lifted out of the
 * shipped file, in a real DOM.
 *
 *   node test-batch-state.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const SHELL = path.join(process.env.HOME,
  'Library/Caches/ms-playwright/chromium_headless_shell-1228',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell');

let pass = 0; const fail = [];
const ck = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const SRC = fs.readFileSync(path.join(__dirname, 'public/qwen-research.js'), 'utf8');
const lift = (startRe, endMarker) => {
  const i = SRC.search(startRe);
  const j = SRC.indexOf(endMarker, i);
  if (i < 0 || j < 0) throw new Error('could not lift ' + startRe);
  return SRC.slice(i, j);
};

const HARNESS = `
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  window.rowJobs = new Map();
  const rowJobs = window.rowJobs;
${lift(/^  function companyState\(opts\) \{/m, '\n  const COMPANY_LABEL')}
${lift(/^  const COMPANY_LABEL = \{/m, '\n  };') + '\n  };'}
${lift(/^  const ROW_STAGE = \{/m, '\n  };') + '\n  };'}
${lift(/^  function statusBadge\(it\) \{/m, '\n  function websiteCell')}
  window.statusBadge = statusBadge;
  window.companyState = companyState;
`;

(async () => {
  const browser = await chromium.launch({ executablePath: SHELL });
  const page = await browser.newPage();
  await page.setContent('<div id="out"></div>');
  await page.addScriptTag({ content: HARNESS });

  const badge = (item, job) => page.evaluate(([it, j]) => {
    window.rowJobs.clear();
    if (j) window.rowJobs.set(it.company, j);
    const html = window.statusBadge(it);
    document.getElementById('out').innerHTML = html;
    return { html, text: document.getElementById('out').textContent };
  }, [item, job]);

  try {
    console.log('\n[1] The four company states render differently\n');

    const running = await badge({ company: 'A', _hasReport: false },
      { jobId: 'j1', status: 'running', stage: 'evidence', pct: 45 });
    ck('an actually running job says Researching',
       /Researching \/ 研究中/.test(running.text), running.text);
    ck('and carries its progress', /45%/.test(running.text), running.text);
    ck('and its stage', /Building evidence/.test(running.text), running.text);

    const queued = await badge({ company: 'A', _hasReport: false },
      { jobId: 'j2', status: 'queued', stage: 'queued', pct: 0 });
    ck('an actually queued job says Queued',
       /Queued \/ 排队中/.test(queued.text), queued.text);
    ck('and does NOT say Researching', !/Researching/.test(queued.text), queued.text);
    ck('and shows no progress bar', !/qr-rowprog/.test(queued.html));

    const stored = await badge({ company: 'A', _hasReport: true }, null);
    ck('a stored report says Existing Report',
       /Existing Report \/ 已有报告/.test(stored.text), stored.text);

    const pending = await badge({ company: 'A', _hasReport: false }, null);
    ck('neither says Pending', /Pending \/ 待处理/.test(pending.text), pending.text);

    ck('running and queued render differently',
       running.html !== queued.html && running.text !== queued.text);

    console.log('\n[2] The optimistic pre-claim state is queued, not running\n');
    /* The row is marked before the CRM has claimed anything; it must not claim
       to be executing. */
    const optimistic = await badge({ company: 'A', _hasReport: false },
      { status: 'running', stage: 'queued', pct: 0 });
    ck('status running + stage queued reads as Queued',
       /Queued \/ 排队中/.test(optimistic.text), optimistic.text);

    console.log('\n[3] A live job outranks a stored report\n');
    const both = await badge({ company: 'A', _hasReport: true },
      { jobId: 'j3', status: 'running', stage: 'model', pct: 80 });
    ck('running beats Existing Report',
       /Researching/.test(both.text) && !/Existing Report/.test(both.text), both.text);
    const queuedWithReport = await badge({ company: 'A', _hasReport: true },
      { jobId: 'j4', status: 'queued', stage: 'queued' });
    ck('queued beats Existing Report too',
       /Queued/.test(queuedWithReport.text) && !/Existing Report/.test(queuedWithReport.text),
       queuedWithReport.text);

    console.log('\n[4] Terminal run outcomes still show\n');
    for (const [st, want] of [['completed', 'Completed'], ['failed', 'Failed'],
                              ['interrupted', 'Interrupted'], ['cancelled', 'Cancelled']]) {
      const r = await badge({ company: 'A', _hasReport: false },
                            { jobId: 'j9', status: st, stage: st });
      ck(`${st} still reports its own outcome`, r.text.includes(want), r.text);
    }

    console.log('\n[5] A queued batch does not look like a running one\n');
    const table = await page.evaluate(() => {
      const rows = [
        { company: 'Running Co', job: { jobId: 'r', status: 'running', stage: 'model', pct: 70 } },
        { company: 'Q1', job: { jobId: 'a', status: 'queued', stage: 'queued' } },
        { company: 'Q2', job: { jobId: 'b', status: 'queued', stage: 'queued' } },
        { company: 'Q3', job: { jobId: 'c', status: 'queued', stage: 'queued' } },
      ];
      window.rowJobs.clear();
      rows.forEach((r) => window.rowJobs.set(r.company, r.job));
      const out = document.getElementById('out');
      return rows.map((r) => {
        out.innerHTML = window.statusBadge({ company: r.company, _hasReport: false });
        return out.textContent;
      });
    });
    ck('exactly one row says Researching',
       table.filter((t) => /Researching/.test(t)).length === 1, JSON.stringify(table));
    ck('the other three say Queued',
       table.filter((t) => /Queued/.test(t)).length === 3, JSON.stringify(table));

    console.log('\n[6] The shipped file no longer coerces queued to running\n');
    ck('the follower does not assert running on attach',
       /setRowJob\(company, \{ jobId \}\);/.test(SRC),
       'it used to write status: running before anything was claimed');
    ck('the durable fallback keeps the row\'s own status',
       /setRowJob\(company, \{ pct: row\.progress_percent, stage: row\.stage,\s*\n?\s*status: row\.status \}\);/.test(SRC));
    ck('reconnect keeps each job\'s own status',
       /setRowJob\(job\.company_name, \{ jobId: job\.job_id, status: job\.status,/.test(SRC),
       '/active-jobs returns queued AND running');
    ck('the badge asks the shared resolver',
       /const state = companyState\(\{ job, hasReport: it\._hasReport \}\);/.test(SRC));
    ck('and there is no second Batch-only state system',
       (SRC.match(/function companyState\(/g) || []).length === 1);
    ck('the running row is marked for the eye',
       /tr\.classList\.toggle\('is-running', running\)/.test(SRC));
    ck('by the same resolver as the badge',
       /const running = companyState\(\{ job: rowJobs\.get\(it\.company\),/.test(SRC));
    ck('no new polling path was added',
       (SRC.match(/api\('\/active-jobs'\)/g) || []).length === 1,
       'the live-job map already carried status, stage and progress');
    ck('queue position was NOT invented', !/排队第/.test(SRC));
  } finally {
    await browser.close();
  }

  console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
  fail.forEach((f) => console.log('  FAILED: ' + f));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR:', e.stack || e.message); process.exit(1); });
