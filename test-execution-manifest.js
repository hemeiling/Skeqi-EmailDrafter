/* Regression tests for the durable per-job execution manifest.
 *
 * The rule these protect: the manifest records what a run ACTUALLY executed. A
 * configured provider is not a used one, a retried callback must not inflate a
 * counter, and a run whose synthesis went unaccounted must say so rather than
 * imply its cost is whole.
 *
 * Run: node test-execution-manifest.js       (no network, no DB, no model call)
 */
const M = require('./public/execution-manifest.js');

let pass = 0; const fail = [];
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

const CURRENT_ONLY = {
  synthesis: { provider: 'bailian', models_attempted: ['qwen3.6-flash'],
               successful_model: 'qwen3.6-flash', calls: 1 },
  retrieval: {
    current: { used: true, model_calls: 20, queries: 20, candidates: 171,
               verified: 16, retained: 16, domains: 7 },
    official_site: { attempted: true, success: false, pages: 0 },
  },
};

console.log('\n[1] Current-retrieval-only run\n');
let m = M.apply(null, CURRENT_ONLY);
ck('version is stamped', m.version === M.VERSION);
ck('current retrieval is used', m.retrieval.current.used === true);
ck('its contribution is recorded', m.retrieval.current.retained === 16
   && m.retrieval.current.domains === 7);
ck('official site attempted but unreadable',
   m.retrieval.official_site.attempted && !m.retrieval.official_site.success);
ck('synthesis records one call', m.synthesis.calls === 1);
ck('no fallback attempts', m.synthesis.fallback_attempts === 0);

console.log('\n[2] Configured-but-unused providers never appear as used\n');
ck('tavily provider discovery unused', m.retrieval.tavily_provider.used === false);
ck('tavily general fallback unused', m.retrieval.tavily_general.used === false);
ck('providersUsed lists only what ran',
   JSON.stringify(M.providersUsed(m))
   === JSON.stringify(['current_retrieval', 'official_site', 'synthesis']),
   JSON.stringify(M.providersUsed(m)));
// Declaring a provider without any work must not flip `used`.
const declared = M.apply(m, { retrieval: { tavily_provider: { searches: 0, extracts: 0 } } });
ck('a provider reporting zero work stays unused',
   declared.retrieval.tavily_provider.used === false);

console.log('\n[3] Synthesis fallback run\n');
const FALLBACK = {
  synthesis: { provider: 'bailian',
               models_attempted: ['deepseek-v4-pro', 'qwen3.6-flash'],
               successful_model: 'qwen3.6-flash', calls: 2 },
};
const f = M.apply(M.apply(null, CURRENT_ONLY), FALLBACK);
ck('both attempted models are recorded', f.synthesis.models_attempted.length === 2,
   JSON.stringify(f.synthesis.models_attempted));
ck('the successful model is named', f.synthesis.successful_model === 'qwen3.6-flash');
ck('one attempt is counted as a fallback', f.synthesis.fallback_attempts === 1,
   String(f.synthesis.fallback_attempts));

console.log('\n[4] synthesis_failed run\n');
const FAILED = M.finalize(M.apply(M.apply(null, CURRENT_ONLY), {
  synthesis: { provider: 'bailian', models_attempted: ['a', 'b'],
               successful_model: null, calls: 2 },
}), { accountingComplete: true, synthesisFailed: true });
ck('no successful model', FAILED.synthesis.successful_model === null);
ck('a null in a patch alone does NOT erase a known value',
   M.apply(M.apply(null, CURRENT_ONLY),
           { synthesis: { successful_model: null } }).synthesis.successful_model
   === 'qwen3.6-flash', 'null means unknown, not none');
ck('both failed attempts are still counted', FAILED.synthesis.calls === 2);
ck('all of them count as fallbacks', FAILED.synthesis.fallback_attempts === 2);
ck('retrieval contribution survives the failure',
   FAILED.retrieval.current.retained === 16);
ck('a failed run is not reported as free', FAILED.synthesis.calls > 0);

console.log('\n[5] Historical job: accounting is incomplete, never estimated\n');
const legacy = M.forLegacyJob({ model: 'qwen3.6-flash', report_id: 'r1',
  input_tokens: 96614, output_tokens: 59308, estimated_cost_usd: '0.085375',
  cost_estimated: true, usage_detail: { retrieval: { calls: 25 },
                                        synthesis: { calls: 0 } } });
ck('marked incomplete', legacy.usage.accounting_complete === false);
ck('flagged as legacy', legacy.legacy === true);
ck('retrieval calls are carried across', legacy.retrieval.current.model_calls === 25);
ck('synthesis attempts are NOT invented', legacy.synthesis.models_attempted.length === 0,
   JSON.stringify(legacy.synthesis.models_attempted));
ck('synthesis call count is not estimated', legacy.synthesis.calls === 0);
ck('the stored cost is carried verbatim, not recomputed',
   legacy.usage.estimated_cost_usd === '0.085375');
ck('a legacy job can never claim complete accounting',
   M.finalize(legacy, { accountingComplete: false }).usage.accounting_complete === false);

console.log('\n[6] Duplicate callbacks are idempotent\n');
const once = M.apply(null, CURRENT_ONLY);
const twice = M.apply(once, CURRENT_ONLY);
const thrice = M.apply(twice, CURRENT_ONLY);
ck('counters do not grow on replay',
   thrice.retrieval.current.model_calls === 20 && thrice.synthesis.calls === 1,
   `${thrice.retrieval.current.model_calls}/${thrice.synthesis.calls}`);
ck('arrays do not grow on replay',
   thrice.synthesis.models_attempted.length === 1,
   JSON.stringify(thrice.synthesis.models_attempted));
ck('the manifest is byte-identical after replay',
   JSON.stringify(once) === JSON.stringify(thrice));
const codes = M.apply(M.apply(null, { retrieval: { tavily_general: {
  used: true, searches: 4, reason_codes: ['no_target_verified_source'] } } }),
  { retrieval: { tavily_general: { searches: 4,
    reason_codes: ['no_target_verified_source'] } } });
ck('reason codes de-duplicate', codes.retrieval.tavily_general.reason_codes.length === 1);

console.log('\n[7] A running job reports the live tool and model\n');
let live = M.apply(null, { active: { stage: 'search', tool: 'model_search',
                                     provider: 'bailian', model: null } });
ck('the active stage is recorded', live.active.stage === 'search');
ck('the active tool is recorded', live.active.tool === 'model_search');
ck('no model is claimed before synthesis starts', live.active.model === null);
live = M.apply(live, { active: { stage: 'model', tool: null, model: 'qwen3.6-flash' } });
ck('the model appears once synthesis begins', live.active.model === 'qwen3.6-flash');
ck('and the stage follows it', live.active.stage === 'model');

console.log('\n[8] A terminal job has no active state\n');
const term = M.finalize(live, { accountingComplete: true });
ck('active stage cleared', term.active.stage === null);
ck('active model cleared', term.active.model === null);
ck('active tool cleared', term.active.tool === null);
ck('accounting marked complete for a post-P0-D run',
   term.usage.accounting_complete === true);
ck('finalize without the flag does not claim completeness',
   M.finalize(live, {}).usage.accounting_complete === false);

console.log('\n[9] Retrieval accounting is unchanged by any of this\n');
const base = M.apply(null, CURRENT_ONLY);
const withTavily = M.apply(base, { retrieval: { tavily_provider: {
  used: true, searches: 4, batches: 1, candidates: 32, verified: 12,
  retained: 5, domains: 9, organizations: 3, account_relationships: 2 } } });
ck('current retrieval numbers are untouched',
   JSON.stringify(withTavily.retrieval.current) === JSON.stringify(base.retrieval.current));
ck('tavily contribution is recorded separately',
   withTavily.retrieval.tavily_provider.organizations === 3
   && withTavily.retrieval.tavily_provider.account_relationships === 2);
ck('and it now counts as used', withTavily.retrieval.tavily_provider.used === true);
ck('providersUsed grows by exactly one',
   M.providersUsed(withTavily).length === M.providersUsed(base).length + 1);

console.log('\n[10] The record stays compact and robust\n');
ck('no rejected candidates are stored', !JSON.stringify(withTavily).includes('rejected'));
ck('a full manifest stays small', JSON.stringify(withTavily).length < 1400,
   String(JSON.stringify(withTavily).length));
ck('an unknown key from a newer engine is ignored',
   !('nonsense' in M.apply(null, { nonsense: 1 })));
ck('a null patch does not throw', M.apply(null, null).version === M.VERSION);
ck('a manifest of an unknown version is rebuilt, not trusted',
   M.apply({ version: 99, junk: true }, {}).version === M.VERSION);
ck('an unversioned object is not accepted as existing state',
   M.apply({ retrieval: { current: { retained: 99 } } }, {}).retrieval.current.retained === 0,
   'a patch must never be mistaken for a manifest');

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
fail.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail.length ? 1 : 0);
