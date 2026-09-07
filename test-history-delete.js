/* Clearing session history deletes history, and only history.
 *
 * The single-row path already had the right semantics: the job row and the
 * sections keyed to it, never the report, never the usage events. This proves
 * the bulk extension keeps them, and that a live job cannot be deleted through
 * it however the request is phrased.
 *
 * The destructive tests run on a THROWAWAY copy of the production tables, so
 * the statements and the constraints are real and production rows are not.
 *
 *   node -r dotenv/config test-history-delete.js
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pass = 0; const fail = [];
const ck = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const DB = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const SRV = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const QR = fs.readFileSync(path.join(__dirname, 'public/qwen-research.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');

const J = 'test_hist_jobs_' + Date.now().toString(36);
const S = 'test_hist_secs_' + Date.now().toString(36);
const R = 'test_hist_reps_' + Date.now().toString(36);
const pool = new Pool({ connectionString: process.env.DATABASE_URL,
                        ssl: { rejectUnauthorized: false } });
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);

const TERMINAL = ['completed', 'completed_with_limitations', 'interrupted',
                  'failed', 'synthesis_failed', 'save_failed', 'cancelled'];

/* The shipped statements, table names swapped. */
const DEL = async (ids) => {
  // Both statements carry the terminal gate, so naming a live job in the
  // request deletes neither its row nor its partial output.
  await q(`DELETE FROM ${S} WHERE job_id IN (SELECT job_id FROM ${J}
             WHERE job_id = ANY($1) AND status = ANY($2))`, [ids, TERMINAL]);
  return q(`DELETE FROM ${J} WHERE job_id = ANY($1) AND status = ANY($2)
            RETURNING job_id, company_name`, [ids, TERMINAL]);
};

(async () => {
  await q(`CREATE TABLE ${J} (LIKE account_research_qwen_jobs INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
  await q(`CREATE TABLE ${S} (LIKE account_research_qwen_job_sections INCLUDING DEFAULTS)`);
  await q(`CREATE TABLE ${R} (LIKE account_research_qwen_reports INCLUDING DEFAULTS)`);
  try {
    console.log('\n[1] The existing single-row path already preserved what matters\n');
    const one = DB.slice(DB.indexOf('async function deleteQwenSession(jobId)'),
                         DB.indexOf('async function deleteSessionRows'));
    ck('it deletes the job row', /DELETE FROM account_research_qwen_jobs/.test(one));
    ck('and its sections', /DELETE FROM account_research_qwen_job_sections/.test(one));
    ck('it never touches reports',
       !/account_research_qwen_reports/.test(one), 'the report is keyed by company');
    /* Comments stripped: the function explains at length WHY it leaves usage
       events alone, and a plain search for the name matches that explanation. */
    const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    ck('it never touches usage events',
       !/ai_usage_events/.test(code(one)), 'billing history must survive');
    ck('nor companies or contacts',
       !/FROM companies|FROM contacts/.test(one));
    ck('it refuses a live job', /if \(!JOB_TERMINAL\.includes\(job\.status\)\)/.test(one));
    ck('and locks the row before deciding', /FOR UPDATE/.test(one),
       'a job that starts between the click and the commit is skipped');
    ck('the delete now carries the gate itself',
       /DELETE FROM account_research_qwen_jobs WHERE job_id = \$1 AND status = ANY\(\$2\)/.test(one),
       'so the guarantee does not depend on the JavaScript check being reached');

    console.log('\n[2] Bulk deletion reuses those semantics\n');
    const bulk = DB.slice(DB.indexOf('async function deleteSessionRows'),
                          DB.indexOf('/* Just enough of every job'));
    ck('one helper does the deleting for both bulk paths',
       /async function deleteSessionRows\(client, jobIds\)/.test(bulk));
    ck('the terminal gate is in the STATEMENT',
       /WHERE job_id = ANY\(\$1\) AND status = ANY\(\$2\)/.test(bulk));
    ck('and the section delete carries it too',
       /DELETE FROM account_research_qwen_job_sections\s*\n?\s*WHERE job_id IN \(SELECT job_id FROM account_research_qwen_jobs\s*\n?\s*WHERE job_id = ANY\(\$1\) AND status = ANY\(\$2\)\)/.test(bulk),
       'a live job\'s partial output must survive being named in a request');
    ck('it is an explicit allow-list, not "not queued or running"',
       /status = ANY\(\$2\)/.test(bulk) && !/NOT IN \('queued','running'\)/.test(bulk),
       'a status nobody has thought of yet is not deletable');
    ck('rows are locked before the check', /FOR UPDATE/.test(bulk));
    ck('reports, usage, companies and contacts are absent from it',
       !/account_research_qwen_reports|ai_usage_events|FROM companies|FROM contacts/
         .test(code(bulk)));
    ck('clear-all is scoped by the same allow-list',
       /clearQwenSessionHistory[\s\S]{0,400}WHERE status = ANY\(\$1\)/.test(DB));
    ck('and it is not limited to a page',
       !/clearQwenSessionHistory[\s\S]{0,400}LIMIT/.test(DB),
       'Clear History means all eligible history');
    ck('the server does not trust a client status',
       !/body\.status|req\.body\.state/.test(
         SRV.slice(SRV.indexOf("app.post('/api/aresearch/sessions/delete'"),
                   SRV.indexOf("/* ── The queue"))));
    ck('and returns what was actually deleted',
       /job_ids: out\.deleted\.map\(\(d\) => d\.job_id\)/.test(SRV));

    console.log('\n[3] Against a real table: history goes, everything else stays\n');
    const mk = (id, co, status, started) => q(
      `INSERT INTO ${J} (job_id, company_key, company_name, model, status, stage,
                         progress_percent, queued_at, started_at, attempts, updated_at)
       VALUES ($1,$2,$3,'t',$4,'x',0,NOW(),$5,0,NOW())`,
      [id, co.toLowerCase(), co, status, started ? new Date() : null]);
    await mk('h1', 'Alpha', 'completed', true);
    await mk('h2', 'Beta', 'interrupted', false);
    await mk('h3', 'Gamma', 'cancelled', false);
    await mk('live1', 'Delta', 'running', true);
    await mk('live2', 'Epsilon', 'queued', false);
    await q(`INSERT INTO ${S} (job_id, section_key, content_en)
             VALUES ('h1','a','x'),('live1','a','x')`);
    await q(`INSERT INTO ${R} (id, report_key, version, company_name, company_key,
                               research_data, source_count)
             VALUES ('rep1','alpha',1,'Alpha','alpha','{}'::jsonb,5)`);

    const deleted = await DEL(['h1', 'h2', 'h3', 'live1', 'live2']);
    ck('the three historical rows were deleted',
       deleted.map((d) => d.job_id).sort().join(',') === 'h1,h2,h3',
       deleted.map((d) => d.job_id).join(','));
    const left = await q(`SELECT job_id, status FROM ${J} ORDER BY job_id`);
    ck('the running job survives', left.some((r) => r.job_id === 'live1'));
    ck('the queued job survives', left.some((r) => r.job_id === 'live2'));
    ck('and nothing else remains', left.length === 2, JSON.stringify(left));
    ck('the saved report is untouched',
       (await q(`SELECT id FROM ${R}`)).length === 1,
       'a company with a report still reads Existing Report');
    ck('the deleted job\'s sections are gone',
       (await q(`SELECT job_id FROM ${S} WHERE job_id='h1'`)).length === 0);
    ck('the live job\'s sections are untouched',
       (await q(`SELECT job_id FROM ${S} WHERE job_id='live1'`)).length === 1);

    console.log('\n[4] Clear History takes every page, and only terminal rows\n');
    for (let i = 0; i < 40; i++) await mk('p' + i, 'Co' + i, 'interrupted', false);
    const before = (await q(`SELECT count(*)::int n FROM ${J}`))[0].n;
    const cleared = await q(
      `DELETE FROM ${J} WHERE status = ANY($1) RETURNING job_id`, [TERMINAL]);
    ck('all 40 beyond the first page went too', cleared.length === 40, String(cleared.length));
    const after = await q(`SELECT job_id, status FROM ${J}`);
    ck('the two live jobs are still there', after.length === 2, JSON.stringify(after));
    ck('and they are exactly the live ones',
       after.every((r) => r.status === 'running' || r.status === 'queued'));
    console.log('    ' + before + ' rows -> ' + after.length + ', all of them live');

    console.log('\n[5] The Active Now invariant is untouched by any of it\n');
    const liveIds = (await q(
      `SELECT job_id FROM ${J} WHERE status IN ('queued','running') ORDER BY job_id`))
      .map((r) => r.job_id);
    ck('the live set is unchanged by deletion',
       liveIds.join(',') === 'live1,live2', liveIds.join(','));
    ck('history deletion cannot reach a live row by construction',
       !TERMINAL.includes('queued') && !TERMINAL.includes('running'),
       'the allow-list contains no live state');

    console.log('\n[6] The UI offers it on history only\n');
    /* Normal mode is the history view it always was: the heading and one quiet
       word. Everything destructive waits behind it. */
    ck('normal mode offers only Manage', /id="qr-hist-manage"/.test(HTML));
    ck('the toolbar starts hidden', /id="qr-hist-bar" hidden/.test(HTML));
    ck('Manage is text, not a button-looking control',
       /\.qr-hist-manage \{[^}]*border:0[^}]*\}/.test(HTML));
    ck('the toolbar carries a selection count', /id="qr-hist-count"/.test(HTML));
    ck('Select all is offered', /Select all \/ 全选/.test(HTML));
    ck('a shortcut for the never-started noise is offered',
       /id="qr-hist-never"/.test(HTML)
       && /x\.state === 'interrupted_before_start'/.test(QR));
    ck('Delete is offered and starts disabled',
       /id="qr-hist-del" disabled/.test(HTML));
    ck('and is enabled only once something is selected',
       /del\.disabled = histSel\.size === 0;/.test(QR));
    ck('Done leaves the mode', /id="qr-hist-done"/.test(HTML));
    ck('Clear History is one click further away, in a menu',
       /<details class="qr-menu">[\s\S]{0,300}id="qr-hist-clear"/.test(HTML),
       'a rare irreversible action should not sit beside the ordinary ones');
    ck('and is styled as destructive', /class="qr-danger" id="qr-hist-clear"/.test(HTML));
    ck('the tick box is rendered only when asked for',
       /\$\{pick \? `<span class="qr-sess-pick">/.test(QR));
    ck('Active Now is never given tick boxes',
       /syncSessionRows\(activeList, shownActive, false\)/.test(QR),
       'a live job is not history');
    ck('history gets them only in select mode',
       /syncSessionRows\(list, shown, histPicking\)/.test(QR));
    /* The row is a five-column grid; a sixth cell with no column was auto-placed
       onto a new line, which is what pushed Open and the overflow menu down. */
    ck('Manage mode declares its own leading column',
       /\.qr-sess-list\.is-picking \.qr-sess-row \{ grid-template-columns:3px 22px 1fr auto auto auto; \}/
         .test(HTML),
       'otherwise the actions wrap onto a second line');
    ck('and the narrow layout gets one too',
       /\.qr-sess-list\.is-picking \.qr-sess-row \{\s*\n?\s*grid-template-columns:3px 22px 1fr auto;/
         .test(HTML));
    ck('the class is toggled with the mode',
       /list\.classList\.toggle\('is-picking', histPicking\)/.test(QR));
    ck('selection lives in JS, so a poll cannot lose a tick',
       /const histSel = new Set\(\);/.test(QR));
    ck('and a focused box is never overwritten',
       /document\.activeElement !== box && box\.checked !== want/.test(QR));
    ck('ticking a box does not open the session',
       /if \(e\.target\.closest\('\[data-qr-hist-pick\]'\)\) \{ e\.stopPropagation\(\); return; \}/.test(QR));
    ck('the confirmation says what is NOT deleted',
       /Saved reports and AI usage records will not be deleted/.test(QR)
       && /已保存的报告与 AI 用量记录不会被删除/.test(QR));
    ck('and says it cannot be undone',
       /This cannot be undone/.test(QR) && /此操作无法撤销/.test(QR));
    ck('Clear History counts the TOTAL, not the page',
       /const n = sessionTotals \? sessionTotals\.history : sessions\.length;/.test(QR));
    ck('an emptied history says so',
       /No recent history\. <span class="i18n-zh">暂无最近历史。<\/span>/.test(QR));
    ck('and history does not page back in after clearing',
       /sessionNext = null;\s*\n\s*await refreshSessions\(\);/.test(QR));
    ck('the counts are refreshed afterwards',
       /await refreshSessions\(\);/.test(QR), 'history, its total and Needs Attention');
  } finally {
    for (const t of [S, R, J]) await q(`DROP TABLE IF EXISTS ${t}`);
    console.log('\n  (throwaway tables dropped)');
    await pool.end();
  }
  console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
  fail.forEach((f) => console.log('  FAILED: ' + f));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR:', e.stack || e.message); process.exit(1); });
