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
/* P1 is the storage of rejected CANDIDATES - urls, titles, reasons. A rejection
   COUNT is the opposite: it is what lets the record stay small while still
   saying how much was thrown away. So assert the shape, not the substring. */
ck('no rejected candidates are stored', (function () {
  const walk = (v) => {
    if (Array.isArray(v)) return v.every(walk);
    if (v && typeof v === 'object') {
      return Object.keys(v).every((k) =>
        (/rejected/i.test(k) ? typeof v[k] === 'number' : true) && walk(v[k]));
    }
    return true;
  };
  return walk(withTavily) && walk(M.apply(M.empty(),
    { competitor_discovery: { searches: 2, rejected_same_industry: 7 } }));
}()));
/* The bound exists to stop candidate LISTS from creeping in, not to freeze the
   number of counters. The discovery blocks now carry a refusal counter per
   guardrail, which is the whole point of them; each is still a fixed set of
   scalars, so the record fits on a screen. Raise this only alongside another
   block of counters, never to accommodate stored candidates. */
ck('a full manifest stays small', JSON.stringify(withTavily).length < 2600,
   String(JSON.stringify(withTavily).length));
ck('and it stores no list of any kind', (function () {
  const walk = (v) => {
    if (Array.isArray(v)) return v.every((x) => typeof x === 'string' && x.length < 60);
    if (v && typeof v === 'object') return Object.keys(v).every((k) => walk(v[k]));
    return true;
  };
  return walk(withTavily);
}()), 'counters and short labels only; never a candidate record');
ck('an unknown key from a newer engine is ignored',
   !('nonsense' in M.apply(null, { nonsense: 1 })));
ck('a null patch does not throw', M.apply(null, null).version === M.VERSION);
ck('a manifest of an unknown version is rebuilt, not trusted',
   M.apply({ version: 99, junk: true }, {}).version === M.VERSION);
ck('an unversioned object is not accepted as existing state',
   M.apply({ retrieval: { current: { retained: 99 } } }, {}).retrieval.current.retained === 0,
   'a patch must never be mistaken for a manifest');

console.log('\n[11] The discovery blocks match the engine field for field\n');

/* The exact keys the engine emits, from app._competitor_facts and
   app._channel_facts. mergeInto ignores keys the manifest does not declare, so
   a slot missing here is a counter silently discarded on arrival. That is not
   hypothetical: the discovery rewrite renamed these fields and twelve of
   twenty-one were being dropped before this test existed. */
const ENGINE_COMPETITOR = {
  used: true, failed: false, model_calls: 2, searches: 4, targeted_queries: 2,
  candidates_named: 2, pages_fetched: 6, sources_offered: 6, rows_proposed: 9,
  retained_competitors: 2, direct: 1, partial: 1, adjacent: 0,
  dropped_self: 3, dropped_placeholder: 2, dropped_uncited: 1,
  dropped_unsupported: 1, dropped_duplicate: 0, dropped_schema: 0,
  distinct_domains: 2, skip_reason: null,
};
const ENGINE_CHANNEL = {
  used: true, failed: false, model_calls: 2, searches: 4, targeted_queries: 1,
  candidates_named: 1, pages_fetched: 6, sources_offered: 6, rows_proposed: 1,
  channel_entities: 0, authorized: 0,
  dropped_self: 0, dropped_placeholder: 0, dropped_uncited: 0,
  dropped_unsupported: 1, dropped_duplicate: 0, dropped_schema: 0,
  distinct_domains: 0, go_to_market_model: 'UNKNOWN', skip_reason: null,
};

const disco = M.apply(M.empty(), { competitor_discovery: ENGINE_COMPETITOR,
                                  channel_discovery: ENGINE_CHANNEL });
const survives = (sent, stored) => Object.keys(sent).filter(
  (k) => !(k in stored) || (sent[k] !== null && JSON.stringify(stored[k]) !== JSON.stringify(sent[k])));

ck('every competitor field the engine sends survives the merge',
   survives(ENGINE_COMPETITOR, disco.competitor_discovery).length === 0,
   survives(ENGINE_COMPETITOR, disco.competitor_discovery).join(', '));
ck('every channel field the engine sends survives the merge',
   survives(ENGINE_CHANNEL, disco.channel_discovery).length === 0,
   survives(ENGINE_CHANNEL, disco.channel_discovery).join(', '));
ck('the manifest declares no competitor slot the engine stopped sending',
   Object.keys(M.empty().competitor_discovery)
     .filter((k) => !(k in ENGINE_COMPETITOR)).length === 0,
   Object.keys(M.empty().competitor_discovery)
     .filter((k) => !(k in ENGINE_COMPETITOR)).join(', '));
ck('nor a channel slot it stopped sending',
   Object.keys(M.empty().channel_discovery)
     .filter((k) => !(k in ENGINE_CHANNEL)).length === 0,
   Object.keys(M.empty().channel_discovery)
     .filter((k) => !(k in ENGINE_CHANNEL)).join(', '));

/* The refusal counters are the point of the rewrite: they are how anyone sees
   what the guardrails threw away. They must not be collapsed into one number. */
for (const k of ['dropped_self', 'dropped_placeholder', 'dropped_uncited',
                 'dropped_unsupported', 'dropped_duplicate', 'dropped_schema']) {
  ck(k + ' is carried on both blocks',
     k in disco.competitor_discovery && k in disco.channel_discovery);
}
ck('uncited and unsupported stay separate numbers',
   disco.competitor_discovery.dropped_uncited === 1
   && disco.competitor_discovery.dropped_unsupported === 1,
   'one had no evidence; the other had evidence that did not support the claim');
ck('the model calls are recorded', disco.competitor_discovery.model_calls === 2);
ck('targeted queries are distinguishable from the total',
   disco.competitor_discovery.targeted_queries === 2
   && disco.competitor_discovery.searches === 4);
ck('proposals are distinguishable from publications',
   disco.competitor_discovery.rows_proposed === 9
   && disco.competitor_discovery.retained_competitors === 2,
   'nine were proposed and seven were refused');

console.log('\n[11b] used, skips and failures\n');
ck('an empty manifest has run no discovery',
   M.empty().competitor_discovery.used === false
   && M.empty().channel_discovery.used === false);
ck('and neither appears in providersUsed',
   !M.providersUsed(M.empty()).includes('competitor_discovery')
   && !M.providersUsed(M.empty()).includes('channel_discovery'));
const skipped = M.apply(M.empty(), { competitor_discovery: {
  searches: 0, skip_reason: 'research returned no readable sources' } });
ck('a skipped path stays unused', skipped.competitor_discovery.used === false);
ck('and keeps its reason',
   skipped.competitor_discovery.skip_reason.indexOf('readable') > -1);
ck('a search makes it used', disco.competitor_discovery.used === true);
ck('it then appears in providersUsed',
   M.providersUsed(disco).includes('competitor_discovery')
   && M.providersUsed(disco).includes('channel_discovery'));
ck('a stage that broke says so',
   M.apply(M.empty(), { competitor_discovery: { failed: true } })
     .competitor_discovery.failed === true);
ck('no monetary field exists on either block',
   !Object.keys(disco.competitor_discovery).some((k) => /cost|price|usd/i.test(k))
   && !Object.keys(disco.channel_discovery).some((k) => /cost|price|usd/i.test(k)));

console.log('\n[12] Replay and history\n');
ck('replaying the same callback changes nothing',
   JSON.stringify(M.apply(disco, { competitor_discovery: ENGINE_COMPETITOR,
                                  channel_discovery: ENGINE_CHANNEL }))
     === JSON.stringify(disco),
   'counters are absolute, never incremental');
ck('a later callback overwrites rather than adds',
   M.apply(disco, { competitor_discovery: { searches: 6 } })
     .competitor_discovery.searches === 6);
/* Three shapes of history have to survive: a manifest with no discovery blocks
   at all, and one carrying the OLD field names from before the rewrite. */
const noBlocks = M.empty();
delete noBlocks.competitor_discovery;
delete noBlocks.channel_discovery;
ck('a manifest predating the blocks gains them',
   M.apply(noBlocks, { competitor_discovery: { searches: 2 } })
     .competitor_discovery.searches === 2);
const legacyNames = M.apply(M.empty(), {});
legacyNames.competitor_discovery.batches = 2;
legacyNames.competitor_discovery.verified_organizations = 34;
legacyNames.competitor_discovery.rejected_same_industry = 11;
const merged = M.apply(legacyNames, { competitor_discovery: ENGINE_COMPETITOR });
ck('retired field names do not break parsing',
   merged.competitor_discovery.searches === 4);
ck('and are left as the history they are, never merged onto',
   merged.competitor_discovery.batches === 2,
   'a stored number is not rewritten by a schema that no longer declares it');
ck('a legacy job still reports no discovery',
   M.forLegacyJob({ model: 'q', report_id: 1 }).competitor_discovery.used === false);
ck('finalize preserves both blocks',
   M.finalize(disco, { accountingComplete: true }).competitor_discovery.searches === 4
   && M.finalize(disco, { accountingComplete: true }).channel_discovery.searches === 4);

/* The Tavily rollup reads `searches` from four paths. Renaming everything else
   must not disturb the one field it depends on. */
ck('the Tavily rollup still has the field it sums',
   'searches' in disco.competitor_discovery && 'searches' in disco.channel_discovery);
ck('and the four paths still add up',
   disco.retrieval.tavily_provider.searches + disco.retrieval.tavily_general.searches
   + disco.competitor_discovery.searches + disco.channel_discovery.searches === 8);

console.log('\n[13] Synthesis payload diagnostics\n');

const noPay = M.empty();
ck('an empty manifest reports no payload', noPay.synthesis_payload.synthesis_payload_bytes === 0);
ck('and no compaction', noPay.synthesis_payload.synthesis_compaction_applied === false);

const paid = M.apply(M.empty(), { synthesis_payload: {
  synthesis_payload_bytes: 46109, synthesis_estimated_input_tokens: 12080,
  synthesis_budget_bytes: 48000, synthesis_compaction_applied: true,
  synthesis_emergency_compaction: false,
  synthesis_evidence_items_before: 16, synthesis_evidence_items_after: 16,
  synthesis_evidence_bytes_before: 59925, synthesis_evidence_bytes_after: 30600,
  synthesis_sources_preserved: 16, synthesis_domains_preserved: 7 } });
ck('sizes are recorded', paid.synthesis_payload.synthesis_payload_bytes === 46109);
ck('the request is under its own budget',
   paid.synthesis_payload.synthesis_payload_bytes
     < paid.synthesis_payload.synthesis_budget_bytes);
ck('no source was lost to the budget',
   paid.synthesis_payload.synthesis_evidence_items_after
     === paid.synthesis_payload.synthesis_evidence_items_before);
ck('replaying it changes nothing',
   JSON.stringify(M.apply(paid, { synthesis_payload: { synthesis_payload_bytes: 46109 } })
     .synthesis_payload) === JSON.stringify(paid.synthesis_payload));
ck('an emergency retry is distinguishable from a normal compaction',
   M.apply(M.empty(), { synthesis_payload: { synthesis_emergency_compaction: true } })
     .synthesis_payload.synthesis_emergency_compaction === true);
ck('no prompt body can be stored here',
   Object.keys(paid.synthesis_payload).every((k) =>
     typeof paid.synthesis_payload[k] === 'number'
     || typeof paid.synthesis_payload[k] === 'boolean'),
   'every field is a size, a count or a flag');
const olderPay = M.empty();
delete olderPay.synthesis_payload;
ck('a manifest without the block gains it',
   M.apply(olderPay, { synthesis_payload: { synthesis_payload_bytes: 5 } })
     .synthesis_payload.synthesis_payload_bytes === 5);
ck('finalize keeps it',
   M.finalize(paid, { accountingComplete: true }).synthesis_payload
     .synthesis_payload_bytes === 46109);
ck('payload diagnostics never touch retrieval or discovery counters',
   JSON.stringify(paid.retrieval) === JSON.stringify(M.empty().retrieval)
   && JSON.stringify(paid.competitor_discovery)
      === JSON.stringify(M.empty().competitor_discovery));

console.log('\n[14] Bilingual completeness diagnostics\n');

const noBi = M.empty();
ck('an empty manifest reports no bilingual check',
   noBi.bilingual.checked === false && noBi.bilingual.warnings === 0);
const bi = M.apply(M.empty(), { bilingual: {
  checked: true, warnings: 2,
  sections: ['Existing Automation Providers / 现有自动化供应商'],
  reasons: ['chinese_cross_reference', 'missing_chinese_table'] } });
ck('counts and reasons survive the merge',
   bi.bilingual.warnings === 2 && bi.bilingual.reasons.length === 2);
ck('the affected section is named', /Providers/.test(bi.bilingual.sections[0]));
ck('a clean run records that it was checked with zero warnings',
   M.apply(M.empty(), { bilingual: { checked: true, warnings: 0 } })
     .bilingual.checked === true);
ck('replaying it changes nothing',
   JSON.stringify(M.apply(bi, { bilingual: { warnings: 2 } }).bilingual)
     === JSON.stringify(bi.bilingual));
ck('no report text can be stored here',
   bi.bilingual.sections.every((s) => s.length < 200)
   && !Object.keys(bi.bilingual).some((k) => /body|report|text|content/i.test(k)));
const olderBi = M.empty();
delete olderBi.bilingual;
ck('a manifest predating the block gains it',
   M.apply(olderBi, { bilingual: { warnings: 1 } }).bilingual.warnings === 1);
ck('it does not disturb the payload or discovery blocks',
   JSON.stringify(bi.synthesis_payload) === JSON.stringify(M.empty().synthesis_payload)
   && JSON.stringify(bi.competitor_discovery)
      === JSON.stringify(M.empty().competitor_discovery));

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
fail.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail.length ? 1 : 0);
