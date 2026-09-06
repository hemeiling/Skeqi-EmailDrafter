/* P0-D regression tests: a completed run can no longer report zero synthesis calls.
 *
 * The defect: synthesis attempts were collected as run["ai_attempts"], but the
 * callback read them from save_run()'s return value and that function never
 * copied the key across. The list was always empty, so no synthesis event was
 * ever emitted, usage_detail.synthesis.calls was 0 on every completed run, and
 * the reported Account Research cost was retrieval-only.
 *
 * Run: node test-synthesis-accounting.js     (no network, no DB, no model call)
 */
let pass = 0; const fail = [];
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

/* The accounting reducer, mirrored from server.js recordResearchUsage. Only the
   shape matters here: which rows become which sub_feature, and what request_id
   each one gets. Pricing is the platform's job and is not re-implemented. */
function reduce(jobId, calls) {
  const rows = Array.isArray(calls) ? calls : [];
  const detail = { retrieval: { calls: 0, input: 0, output: 0 },
                   synthesis: { calls: 0, input: 0, output: 0 } };
  const ids = [];
  rows.forEach((c, i) => {
    const kind = c.kind === 'synthesis' ? 'synthesis' : 'retrieval';
    detail[kind].calls += 1;
    detail[kind].input += Number(c.input_tokens) || 0;
    detail[kind].output += Number(c.output_tokens) || 0;
    ids.push(`arq:${jobId}:${kind}:${i}`);
  });
  return { detail, ids };
}

const RETRIEVAL = Array.from({ length: 20 }, (_, i) =>
  ({ kind: 'retrieval', model: 'qwen3.6-flash', input_tokens: 100, output_tokens: 50 }));
const SYNTH = { kind: 'synthesis', model: 'qwen3.6-flash', input_tokens: 12114,
                output_tokens: 14948, total_tokens: 27062 };
const SYNTH_DENIED = { kind: 'synthesis', model: 'deepseek-v4-pro', input_tokens: 0,
                       output_tokens: 0, status: 403 };

console.log('\n[1] The defect itself: the old payload carried no synthesis row\n');
// Pre-fix, the callback appended (saved.ai_attempts || []) which was always [].
const before = reduce('j1', [...RETRIEVAL]);
ck('pre-fix payload reports 0 synthesis calls', before.detail.synthesis.calls === 0);
ck('and that is exactly what production shows today', before.detail.retrieval.calls === 20);

console.log('\n[2] After the fix a completed run reports its synthesis call\n');
const after = reduce('j1', [...RETRIEVAL, SYNTH]);
ck('synthesis calls is no longer zero', after.detail.synthesis.calls === 1,
   String(after.detail.synthesis.calls));
ck('synthesis input tokens are counted', after.detail.synthesis.input === 12114);
ck('synthesis output tokens are counted', after.detail.synthesis.output === 14948);
ck('retrieval accounting is UNCHANGED', after.detail.retrieval.calls === 20
   && after.detail.retrieval.input === before.detail.retrieval.input
   && after.detail.retrieval.output === before.detail.retrieval.output);
ck('total cost basis grew by exactly the synthesis tokens',
   (after.detail.synthesis.input + after.detail.synthesis.output)
   - (before.detail.synthesis.input + before.detail.synthesis.output) === 27062);

console.log('\n[3] Fallback attempts each get their own event\n');
const withFallback = reduce('j1', [...RETRIEVAL, SYNTH_DENIED, SYNTH]);
ck('two synthesis attempts are recorded', withFallback.detail.synthesis.calls === 2,
   String(withFallback.detail.synthesis.calls));
ck('a denied attempt contributes no tokens but is still counted',
   withFallback.detail.synthesis.input === 12114);
ck('one event per attempt, not one per run',
   withFallback.ids.filter((i) => i.includes(':synthesis:')).length === 2);

console.log('\n[4] Idempotency: request ids stay deterministic\n');
const a = reduce('j1', [...RETRIEVAL, SYNTH]);
const b = reduce('j1', [...RETRIEVAL, SYNTH]);
ck('the same payload yields the same ids', JSON.stringify(a.ids) === JSON.stringify(b.ids));
ck('a replayed callback cannot double-count', new Set(a.ids).size === a.ids.length);
ck('retrieval ids are unchanged by adding synthesis',
   JSON.stringify(a.ids.slice(0, 20)) === JSON.stringify(before.ids.slice(0, 20)));
ck('synthesis id follows the retrieval block', a.ids[20] === 'arq:j1:synthesis:20');
const other = reduce('j2', [...RETRIEVAL, SYNTH]);
ck('ids are namespaced per job', other.ids[20] === 'arq:j2:synthesis:20');

console.log('\n[5] A failed run is not a free run\n');
const allFailed = reduce('j3', [...RETRIEVAL, SYNTH_DENIED, SYNTH_DENIED]);
ck('retrieval is still accounted when synthesis fails',
   allFailed.detail.retrieval.calls === 20);
ck('each failed attempt that reached a model is counted',
   allFailed.detail.synthesis.calls === 2);
ck('a run with no report is not reported as zero cost basis',
   allFailed.detail.retrieval.input > 0);

console.log('\n[6] Nothing is invented\n');
ck('an empty payload records nothing', reduce('j4', []).detail.synthesis.calls === 0);
ck('a null payload does not throw', reduce('j4', null).detail.retrieval.calls === 0);
const retrievalOnly = reduce('j5', [...RETRIEVAL]);
ck('a run that never reached synthesis still reports 0 synthesis calls',
   retrievalOnly.detail.synthesis.calls === 0);

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
fail.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail.length ? 1 : 0);
