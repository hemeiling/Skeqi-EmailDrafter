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

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
fail.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail.length ? 1 : 0);
