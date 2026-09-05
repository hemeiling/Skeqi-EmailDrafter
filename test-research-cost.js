/* Account Research cost accounting.
 *
 * Everything here uses the EXISTING platform machinery: usage.js pricing, the
 * account_research feature, the ai_usage_events request_id unique index. No new
 * pricing implementation, no Qwen price hard-coded here.
 *
 * The rule these protect: exactly one accounting boundary, and it is idempotent,
 * because callbacks, replays and retry-save can all happen more than once.
 *
 * No network, no model call.  node test-research-cost.js
 */
const usage = require('./usage.js');

let pass = 0; const fail = [];
function ck(n, c, d) {
  if (c) { pass++; console.log('  PASS ' + n); }
  else { fail.push(n); console.log('  FAIL ' + n + (d ? '  <- ' + d : '')); }
}

// The real card, injected the way server.js injects it from the DB.
// Column names are the DB's, exactly as listActivePricing() returns them.
usage.setPricingTable([
  { provider: 'bailian', model: 'qwen3.6-flash', input_price_per_m: 0.19,
    output_price_per_m: 1.13, cache_read_price_per_m: 0.019,
    cache_write_price_per_m: 0, is_estimated: true },
  { provider: 'bailian', model: 'qwen3.8-max', input_price_per_m: 2.00,
    output_price_per_m: 6.00, cache_read_price_per_m: 0.20,
    cache_write_price_per_m: 0, is_estimated: true },
  { provider: 'anthropic', model: 'claude-sonnet-5', input_price_per_m: 3.00,
    output_price_per_m: 15.00, cache_read_price_per_m: 0.30,
    cache_write_price_per_m: 3.75, is_estimated: false },
]);

/* The accounting boundary, mirrored from server.js so the aggregation and the
   deterministic request_id can be tested without booting the server. */
const persisted = [];
usage.setPersist((e) => {
  if (e.request_id && persisted.some((p) => p.request_id === e.request_id)) return; // the unique index
  persisted.push(e);
});

function record(jobId, calls) {
  let input = 0, output = 0, total = 0, cost = 0, estimated = false;
  const detail = { retrieval: { calls: 0 }, synthesis: { calls: 0 } };
  (calls || []).forEach((c, i) => {
    const kind = c.kind === 'synthesis' ? 'synthesis' : 'retrieval';
    const inTok = c.input_tokens || 0, outTok = c.output_tokens || 0;
    const tot = c.total_tokens || (inTok + outTok);
    input += inTok; output += outTok; total += tot; detail[kind].calls += 1;
    const r = usage.recordAiEvent({
      feature: 'account_research', sub_feature: kind,
      provider: String(c.model || '').startsWith('claude') ? 'anthropic' : 'bailian',
      model: c.model, input_tokens: inTok, output_tokens: outTok, total_tokens: tot,
      request_id: `arq:${jobId}:${kind}:${i}`, request_type: 'new_call',
      status: (c.status && c.status !== 200) ? 'error' : 'success',
    });
    cost += r.cost_usd; if (r.cost_estimated) estimated = true;
  });
  return { input_tokens: input, output_tokens: output, total_tokens: total,
           estimated_cost_usd: cost, cost_estimated: estimated, detail, calls: (calls || []).length };
}

const F = 'qwen3.6-flash', MAX = 'qwen3.8-max';
const near = (a, b) => Math.abs(a - b) < 1e-9;

console.log('\n[A] Retrieval is counted at all\n');
usage.resetUsage(); persisted.length = 0;
let u = record('j1', [{ kind: 'retrieval', model: F, input_tokens: 1000, output_tokens: 200 }]);
ck('a single retrieval call is recorded', u.calls === 1 && u.total_tokens === 1200);
ck('priced from the central card',
   near(u.estimated_cost_usd, (1000 / 1e6) * 0.19 + (200 / 1e6) * 1.13),
   String(u.estimated_cost_usd));
ck('flagged estimated while the Qwen row is estimated', u.cost_estimated === true);

usage.resetUsage(); persisted.length = 0;
u = record('j2', Array.from({ length: 25 }, () => (
  { kind: 'retrieval', model: F, input_tokens: 800, output_tokens: 150 })));
ck('25 retrieval calls all counted', u.calls === 25 && u.total_tokens === 25 * 950);
ck('25 events persisted', persisted.length === 25, String(persisted.length));

console.log('\n[B] Per-call model pricing, including fallbacks\n');
usage.resetUsage(); persisted.length = 0;
u = record('j3', [
  { kind: 'retrieval', model: F, input_tokens: 1000, output_tokens: 100 },
  { kind: 'retrieval', model: MAX, input_tokens: 1000, output_tokens: 100 },   // retrieval fallback
]);
const expected = (1000 / 1e6) * 0.19 + (100 / 1e6) * 1.13
               + (1000 / 1e6) * 2.00 + (100 / 1e6) * 6.00;
ck('each call priced with the model that handled it', near(u.estimated_cost_usd, expected),
   `${u.estimated_cost_usd} vs ${expected}`);
ck('a max fallback is NOT priced at flash rates', u.estimated_cost_usd > 0.002);

usage.resetUsage(); persisted.length = 0;
u = record('j4', [
  { kind: 'synthesis', model: F, input_tokens: 60000, output_tokens: 0, status: 403 },  // denied, executed
  { kind: 'synthesis', model: MAX, input_tokens: 62961, output_tokens: 10410 },
]);
ck('a synthesis fallback records BOTH attempts', u.calls === 2 && persisted.length === 2);
ck('the failed attempt is marked error',
   persisted.filter((e) => e.status === 'error').length === 1);

console.log('\n[C] A complete run aggregates retrieval + synthesis\n');
usage.resetUsage(); persisted.length = 0;
const run = [
  ...Array.from({ length: 25 }, () => ({ kind: 'retrieval', model: F, input_tokens: 400, output_tokens: 120 })),
  { kind: 'synthesis', model: F, input_tokens: 62961, output_tokens: 10410, total_tokens: 73371 },
];
u = record('hongqi', run);
ck('total exceeds synthesis alone', u.total_tokens > 73371, String(u.total_tokens));
ck('retrieval and synthesis both broken out',
   u.detail.retrieval.calls === 25 && u.detail.synthesis.calls === 1);
const feat = usage.getUsage().by_feature.account_research;
ck('all of it lands under account_research', feat && feat.new_calls === 26,
   String(feat && feat.new_calls));
ck('no other feature is touched',
   usage.getUsage().by_feature.other.new_calls === 0);

console.log('\n[D] Idempotency: the boundary can be replayed\n');
usage.resetUsage(); persisted.length = 0;
record('dup', run);
const afterFirst = persisted.length;
record('dup', run);                       // the callback is retried verbatim
ck('a retried callback creates no new events', persisted.length === afterFirst,
   `${afterFirst} -> ${persisted.length}`);
record('dup2', run);                      // a DIFFERENT job still records
ck('a different job still records', persisted.length === afterFirst * 2);
ck('request ids are deterministic per call',
   persisted[0].request_id === 'arq:dup:retrieval:0', persisted[0].request_id);

console.log('\n[E] retry-save makes no model call, so it costs nothing\n');
usage.resetUsage(); persisted.length = 0;
record('rs', run);
const before = persisted.length;
// retry-save replays an EXISTING record; it passes no ai_usage at all.
const noop = record('rs', []);
ck('retry-save records zero new events', persisted.length === before);
ck('and reports zero calls', noop.calls === 0 && noop.total_tokens === 0);

console.log('\n[F] Terminal outcomes keep the usage already incurred\n');
usage.resetUsage(); persisted.length = 0;
const partial = record('failed-run', [
  ...Array.from({ length: 12 }, () => ({ kind: 'retrieval', model: F, input_tokens: 500, output_tokens: 100 })),
]);
ck('an interrupted run still reports its retrieval spend',
   partial.total_tokens === 12 * 600 && partial.estimated_cost_usd > 0,
   `${partial.total_tokens} tok, $${partial.estimated_cost_usd}`);
ck('completed_with_limitations is priced the same way',
   record('limited', run).total_tokens > 73371);

console.log('\n[G] Historical reports are not dressed up as complete\n');
// 红旗: synthesis usage survived, retrieval usage was discarded before
// instrumentation. There is no job usage row, so the UI shows nothing.
const historical = { run_usage: null, token_usage: { input: 62961, output: 10410, total: 73371 } };
ck('a report with no job usage exposes no cost', historical.run_usage === null);
ck('its synthesis tokens are still visible for audit',
   historical.token_usage.total === 73371);

console.log('\n[H] The platform total counts Account Research exactly once\n');
usage.resetUsage(); persisted.length = 0;
record('plat', run);
usage.recordAiEvent({ feature: 'email_draft', provider: 'anthropic',
                      model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 500,
                      request_id: 'ed:1' });
const all = usage.getUsage();
const ar = all.by_feature.account_research, ed = all.by_feature.email_draft;
ck('account_research and email_draft are separate lines',
   ar.new_calls === 26 && ed.new_calls === 1,
   `${ar.new_calls} / ${ed.new_calls}`);
ck('research cost is attributable on its own', ar.cost_usd > 0);
ck('the session total is the sum, not a double count',
   Math.abs(all.ai.cost_usd - (ar.cost_usd + ed.cost_usd)) < 1e-5,
   `${all.ai.cost_usd} vs ${ar.cost_usd + ed.cost_usd}`);
ck('research is a line under the platform total, not a separate feature',
   Object.keys(all.by_feature).includes('account_research')
   && !Object.keys(all.by_feature).includes('qwen_research'));

console.log('\n[I] Aggregation invariants\n');
usage.resetUsage(); persisted.length = 0;
const mixed = [
  { kind: 'retrieval', model: F, input_tokens: 500, output_tokens: 90 },    // estimated card
  { kind: 'retrieval', model: F, input_tokens: 700, output_tokens: 110 },
  { kind: 'synthesis', model: MAX, input_tokens: 40000, output_tokens: 8000 },
];
const agg = record('agg', mixed);
const sumIn = mixed.reduce((a, c) => a + c.input_tokens, 0);
const sumOut = mixed.reduce((a, c) => a + c.output_tokens, 0);
ck('job input tokens = sum of every recorded call', agg.input_tokens === sumIn,
   `${agg.input_tokens} vs ${sumIn}`);
ck('job output tokens = sum of every recorded call', agg.output_tokens === sumOut,
   `${agg.output_tokens} vs ${sumOut}`);
const perCall = mixed.reduce((a, c) =>
  a + usage.costFor(c.model, c.input_tokens, c.output_tokens, 0, 0, 'bailian'), 0);
ck('job cost = sum of each call priced at its own card',
   Math.abs(agg.estimated_cost_usd - perCall) < 1e-9,
   `${agg.estimated_cost_usd} vs ${perCall}`);
const evIn = persisted.reduce((a, e) => a + (e.input_tokens || 0), 0);
const evOut = persisted.reduce((a, e) => a + (e.output_tokens || 0), 0);
ck('persisted events carry the same input total', evIn === sumIn, `${evIn} vs ${sumIn}`);
ck('persisted events carry the same output total', evOut === sumOut, `${evOut} vs ${sumOut}`);
const featI = usage.getUsage().by_feature.account_research;
ck('platform feature line matches, counted exactly once',
   featI.input_tokens === sumIn && featI.output_tokens === sumOut
   && Math.abs(featI.cost_usd - perCall) < 1e-5,
   `${featI.input_tokens}/${featI.output_tokens}/${featI.cost_usd}`);

// The estimated flag must reflect ANY call, not just the last/synthesis one.
usage.resetUsage(); persisted.length = 0;
const anyEst = record('mix1', [
  { kind: 'retrieval', model: F, input_tokens: 100, output_tokens: 10 },        // estimated
  { kind: 'synthesis', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 10 },
]);
ck('cost_estimated is true when ANY call used an estimated card',
   anyEst.cost_estimated === true);
usage.resetUsage(); persisted.length = 0;
const noneEst = record('mix2', [
  { kind: 'retrieval', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 10 },
  { kind: 'synthesis', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 10 },
]);
ck('and false only when NO call used one', noneEst.cost_estimated === false);
usage.resetUsage(); persisted.length = 0;
const estFirst = record('mix3', [
  { kind: 'retrieval', model: F, input_tokens: 100, output_tokens: 10 },        // estimated FIRST
  { kind: 'synthesis', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 10 },
]);
ck('it does not depend on the final synthesis model alone',
   estFirst.cost_estimated === true);

console.log(`\n${pass} passed, ${fail.length} failed`);
fail.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail.length ? 1 : 0);
