/* Regression tests for durable progress reconstruction.
 *
 * The bug: a job persisted at stage=site, progress_percent=25 rendered as
 * 0% / "Validating company", because the snapshot derived its percentage from
 * `warnings` (empty on a healthy run) and never read the persisted stage.
 *
 * Run: node test-job-snapshot.js       (no network, no model call)
 */
const J = require('./public/job-snapshot.js');

let pass = 0; const fail = [];
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

console.log('\n[1] The exact reported case: stage=site, progress_percent=25\n');
const TESLA = {
  job_id: '18788fe8c22448e5b2da06d61b6c18a2', company_name: 'tesla',
  status: 'running', stage: 'site', progress_percent: 25, warnings: [],
  model: 'qwen3.6-flash', started_at: '2026-09-05T03:26:06.342Z',
  updated_at: '2026-09-05T03:26:07.044Z',
};
const s = J.jobRowToSnapshot(TESLA);
ck('percentage comes from progress_percent, not a warning count', s._pct === 25, String(s._pct));
ck('does NOT render as 0%', s._pct !== 0);
ck('phase is the persisted stage', s.phase === 'site', s.phase);
ck('status maps to running', s.status === 'running');
const keys = s.stages.map((x) => x.stage);
ck('earlier stages reconstructed as finished',
   ['discover', 'official', 'queries'].every((k) => keys.includes(k)), keys.join(','));
ck('the persisted stage is NOT marked finished (it is the active one)',
   !keys.includes('site'), keys.join(','));
ck('later stages are absent',
   !keys.includes('search') && !keys.includes('evidence'), keys.join(','));
ck('percentage is not derived from warnings', J.jobRowToSnapshot(
   Object.assign({}, TESLA, { warnings: ['a', 'b', 'c'] }))._pct === 25);

console.log('\n[2] Reconstruction is stateless — same row, same result\n');
const again = J.jobRowToSnapshot(JSON.parse(JSON.stringify(TESLA)));
ck('identical after a reload / new browser session',
   JSON.stringify(again.stages) === JSON.stringify(s.stages) && again._pct === s._pct);
ck('no dependence on prior calls', J.jobRowToSnapshot(TESLA)._pct === 25);

console.log('\n[3] Orphaned and terminal rows keep their persisted position\n');
const orphan = Object.assign({}, TESLA, {
  status: 'interrupted',
  error: 'Interrupted at 25% during site: the research service restarted.',
});
const o = J.jobRowToSnapshot(orphan);
ck('interrupted maps to an error state', o.status === 'error');
ck('interrupted KEEPS its last percentage', o._pct === 25, String(o._pct));
ck('interrupted keeps its last stage', o.phase === 'site');
ck('the reason survives', /restarted/.test(o.message));

const doneRow = Object.assign({}, TESLA, { status: 'completed', progress_percent: 100 });
ck('completed maps to done at 100%',
   J.jobRowToSnapshot(doneRow).status === 'done' && J.jobRowToSnapshot(doneRow)._pct === 100);
const limited = Object.assign({}, TESLA, {
  status: 'completed_with_limitations', progress_percent: 100 });
ck('completed_with_limitations is a SUCCESS, not an error',
   J.jobRowToSnapshot(limited).status === 'done');
ck('synthesis_failed is an error',
   J.jobRowToSnapshot(Object.assign({}, TESLA, { status: 'synthesis_failed' })).status === 'error');

console.log('\n[4] Stage ordering\n');
ck('queued implies nothing finished', J.stagesUpTo('queued').length === 0);
ck('an unknown stage implies nothing finished', J.stagesUpTo('nonsense').length === 0);
ck('a missing stage is safe', J.jobRowToSnapshot({ status: 'running' }).stages.length === 0);
ck('later stages imply more finished work',
   J.stagesUpTo('evidence').length > J.stagesUpTo('site').length);
ck('percentage is clamped',
   J.jobRowToSnapshot({ status: 'running', progress_percent: 999 })._pct === 100
   && J.jobRowToSnapshot({ status: 'running', progress_percent: -5 })._pct === 0);
ck('a row with no percentage yields null, not 0',
   J.jobRowToSnapshot({ status: 'running', stage: 'site' })._pct === null);

console.log('\n[5] Duplicate section heading is stripped at the display layer\n');

// Every heading the report actually uses, both languages, from the prompt.
const SECTIONS = [
  ['Executive Summary', '执行摘要'], ['Company Overview', '公司概况'],
  ['Strategic Initiatives', '战略举措'], ['Industry Trends', '行业趋势'],
  ['SWOT Analysis', 'SWOT分析'], ['Competitor Analysis', '竞争对手分析'],
  ['Existing Automation Providers', '现有自动化供应商'],
  ['Key Decision Makers', '关键决策人'], ['Upcoming Projects', '未来项目'],
  ['Latest News', '最新动态'], ['Financial Information', '财务信息'],
  ['Manufacturing Challenges', '制造挑战'],
  ['Sustainability Objectives', '可持续发展目标'],
  ['Relevant SKEQI Solutions', '思客琦相关解决方案'],
  ['Sales Strategies', '销售策略'], ['Strategic Objectives', '战略目标'],
  ['Potential SKEQI Use Cases', '潜在思客琦应用场景'],
  ['Acronyms & Business Terms', '术语与缩写'], ['Sources', '信息来源'],
  ['Research Evidence', '研究证据'],
];
ck('all 20 section types covered', SECTIONS.length === 20, String(SECTIONS.length));

let stripped = 0;
for (const [en, zh] of SECTIONS) {
  const bodyEn = '- point one\n- point two';
  const bodyZh = '- 第一点\n- 第二点';
  const gotEn = J.stripLeadingTitle('## ' + en + '\n\n' + bodyEn, en);
  const gotZh = J.stripLeadingTitle('## ' + zh + '\n\n' + bodyZh, zh);
  if (gotEn === bodyEn && gotZh === bodyZh) stripped++;
}
ck('every section strips its own heading in both languages',
   stripped === SECTIONS.length, stripped + '/' + SECTIONS.length);

console.log('\n[6] Normalisation variants still count as duplicates\n');
const T = 'Executive Summary';
for (const [label, line] of [
  ['plain', 'Executive Summary'],
  ['# heading', '# Executive Summary'],
  ['## heading', '## Executive Summary'],
  ['#### heading', '#### Executive Summary'],
  ['bold', '**Executive Summary**'],
  ['bold + heading', '## **Executive Summary**'],
  ['trailing colon', '## Executive Summary:'],
  ['fullwidth colon', '## Executive Summary：'],
  ['extra whitespace', '##   Executive   Summary   '],
  ['different case', '## EXECUTIVE SUMMARY'],
]) ck('stripped: ' + label, J.stripLeadingTitle(line + '\nbody', T) === 'body',
      JSON.stringify(J.stripLeadingTitle(line + '\nbody', T)));
for (const [label, line] of [
  ['CJK plain', '执行摘要'], ['CJK heading', '## 执行摘要'],
  ['CJK bold', '**执行摘要**'], ['CJK fullwidth colon', '## 执行摘要：'],
  ['CJK ideographic comma', '## 执行摘要、'],
]) ck('stripped: ' + label, J.stripLeadingTitle(line + '\n正文', '执行摘要') === '正文',
      JSON.stringify(J.stripLeadingTitle(line + '\n正文', '执行摘要')));

console.log('\n[7] A real first sentence is NOT removed\n');
for (const [label, first] of [
  ['contains the words', 'Executive Summary of the 2026 financial year follows.'],
  ['starts with them', 'Executive Summary highlights three risks.'],
  ['CJK contains them', '执行摘要显示三项风险。'],
  ['different section', '## Company Overview'],
  ['a bullet', '- Executive Summary'],
]) {
  const src = first + '\nrest';
  ck('kept: ' + label, J.stripLeadingTitle(src, T) === src || J.stripLeadingTitle(src, '执行摘要') === src,
     JSON.stringify(J.stripLeadingTitle(src, T)));
}
ck('only the FIRST heading goes, not a later one',
   J.stripLeadingTitle('## Sources\n\nbody\n\n## Sources\n\nmore', 'Sources')
     === 'body\n\n## Sources\n\nmore');

console.log('\n[8] Content without a repeated heading is untouched\n');
// The evidence block does not store its title; it must pass through unchanged.
const ev = '**Evidence collected: 16 source(s)**\n11 independent third-party sources';
ck('evidence content is unchanged', J.stripLeadingTitle(ev, 'Research Evidence') === ev);
ck('empty content is safe', J.stripLeadingTitle('', 'Sources') === '');
ck('null content is safe', J.stripLeadingTitle(null, 'Sources') === '');
ck('missing title is safe', J.stripLeadingTitle('## Sources\nbody', '') === '## Sources\nbody');
ck('heading-only content collapses to empty',
   J.stripLeadingTitle('## Sources', 'Sources') === '');

console.log('\n[N] Terminal states say what actually happened\n');

/* The defect: every non-done terminal state rendered as
   "Research failed during model." For the Sept 5 jobs that was false twice
   over - the model had already written a full report, and the run was lost to
   an engine restart, not to a model failure. */
const EXPECT = {
  completed:                  'Research completed',
  completed_with_limitations: 'Research completed with evidence limitations',
  interrupted:                'Research execution was interrupted',
  synthesis_failed:           'Research evidence was collected, but final synthesis failed',
  save_failed:                'Research was generated, but the report could not be saved',
  failed:                     'Research failed',
};
Object.keys(EXPECT).forEach((st) => {
  const c = J.terminalCopy(st, false);
  ck(st + ' has its own wording', !!c && c.en === EXPECT[st], c && c.en);
  ck(st + ' has Chinese wording', !!c && !!c.zh && c.zh.length > 3);
});

ck('interrupted never blames the model',
   !/model|synthesis|failed/i.test(J.terminalCopy('interrupted', false).en),
   J.terminalCopy('interrupted', false).en);
ck('only `failed` states a bare research failure',
   J.terminalCopy('failed', false).en === 'Research failed');
ck('save_failed does not claim the research failed',
   /was generated/.test(J.terminalCopy('save_failed', false).en));
ck('synthesis_failed credits the evidence that was collected',
   /evidence was collected/.test(J.terminalCopy('synthesis_failed', false).en));

console.log('\n[N+1] Recommended action is state-specific\n');
const ACT = {
  interrupted: 'regenerate', synthesis_failed: 'regenerate',
  save_failed: 'retry-save', failed: 'regenerate',
  completed: 'open', completed_with_limitations: 'open',
};
Object.keys(ACT).forEach((st) => {
  ck(st + ' -> ' + ACT[st],
     J.terminalCopy(st, false).action === ACT[st], J.terminalCopy(st, false).action);
});
ck('interrupted WITH a saved artifact -> reconcile, not regenerate',
   J.terminalCopy('interrupted', true).action === 'reconcile',
   J.terminalCopy('interrupted', true).action);
ck('and it says a saved report exists',
   /a saved report exists/.test(J.terminalCopy('interrupted', true).en));
ck('synthesis-only retry is never offered',
   !Object.keys(ACT).some((st) => /synth/.test(J.terminalCopy(st, false).action)));
ck('an unknown status yields no copy at all', J.terminalCopy('nonsense', false) === null);

console.log('\n[N+2] Stage is a location, not a cause\n');
ck('model reads as Generating research',
   J.lastStageLabel('model').en === 'Generating research', J.lastStageLabel('model').en);
ck('synthesis reads the same', J.lastStageLabel('synthesis').en === 'Generating research');
ck('site reads as reading the official site',
   /official site/i.test(J.lastStageLabel('site').en));
ck('no stage label contains the word failed',
   !Object.keys(J.STAGE_LABELS).some((k) => /fail/i.test(J.STAGE_LABELS[k].en)));
ck('an unknown stage yields no label', J.lastStageLabel('nope') === null);

console.log('\n[N+3] The durable state survives the snapshot\n');
const ROW = (st) => ({ job_id: 'j', company_name: 'X', status: st, stage: 'model',
                       progress_percent: 85, warnings: [], model: 'm' });
ck('save_failed no longer renders as a running job',
   J.jobRowToSnapshot(ROW('save_failed')).status === 'error',
   J.jobRowToSnapshot(ROW('save_failed')).status);
ck('save_failed is in DEAD_STATUSES', J.DEAD_STATUSES.indexOf('save_failed') >= 0);
Object.keys(EXPECT).forEach((st) => {
  ck(st + ' is carried through as `state`', J.jobRowToSnapshot(ROW(st)).state === st);
});
ck('has_artifact is false without a report_id',
   J.jobRowToSnapshot(ROW('interrupted')).has_artifact === false);
ck('has_artifact is true with one',
   J.jobRowToSnapshot(Object.assign(ROW('interrupted'), { report_id: 'r1' }))
     .has_artifact === true);
ck('a live row carries no terminal copy',
   J.terminalCopy(J.jobRowToSnapshot(ROW('running')).state, false) === null);

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
fail.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail.length ? 1 : 0);
