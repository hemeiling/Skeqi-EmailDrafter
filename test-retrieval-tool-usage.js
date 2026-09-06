/* Retrieval-tool usage is VISIBLE but never PRICED.
 *
 * The Ford production run made 8 Tavily searches that appeared nowhere in the
 * UI, while the displayed dollar figure read as if it were the run's total
 * cost. Both halves were misleading: the searches were invisible, and the
 * number was unlabelled.
 *
 * The fix is visibility only. Cost accounting semantics are unchanged, and no
 * monetary event is invented - Alibaba exposes no per-search usage, credit or
 * quota field through this MCP, and ai_model_pricing has only per-token
 * dimensions. "Cost unavailable" is the honest value; $0.00 would assert that
 * these searches were free.
 *
 * Run: node test-retrieval-tool-usage.js      (no network, no DB, no model call)
 */
const fs = require('fs');

let pass = 0; const fail = [];
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

const HTML = fs.readFileSync('public/index.html', 'utf8');
const APP = fs.readFileSync('public/app.js', 'utf8');
const DB = fs.readFileSync('db.js', 'utf8');
const SRV = fs.readFileSync('server.js', 'utf8');

console.log('\n[1] The dollar figure is labelled as MODEL cost\n');
ck('the bar names it AI Model Cost', HTML.includes('AI Model Cost'));
ck('bilingual', HTML.includes('AI 模型成本'));
ck('the sidebar summary agrees', /`AI Model \$\{cost/.test(APP) || APP.includes('`AI Model ${cost'),
   'the collapsed summary must not read as a total');

console.log('\n[2] Tavily counts are shown, sourced from the durable manifest\n');
for (const id of ['u-tavily-provider', 'u-tavily-general', 'u-tavily-total']) {
  ck('the bar has ' + id, HTML.includes('id="' + id + '"'));
  ck('and it is populated', APP.includes('"' + id + '"'));
}
ck('Tavily is labelled bilingually', HTML.includes('Tavily 使用量（累计）'));
// The two figures have DIFFERENT scopes: model cost is session state and resets,
// Tavily counts are all-time from the manifests. Showing them side by side
// without saying so invites the reader to compare them as one run's totals.
ck('the Tavily scope is stated in the label',
   HTML.includes('Tavily Usage (All Time)'));
ck('and in Chinese', HTML.includes('累计'));
ck('the tooltip repeats it, so a truncated label still carries the scope',
   /title="All-time totals from the durable execution manifests/.test(HTML));
ck('the model figure is NOT labelled all-time',
   !/AI Model Cost[^<]*All Time/.test(HTML), 'it is session-scoped and resettable');
ck('counts come from execution_manifest',
   /execution_manifest->'retrieval'->'tavily_provider'->>'searches'/.test(DB));
// Scope to the function body: db.js mentions both elsewhere, and the comment
// inside this very function explains why events are not used.
const AGG = DB.slice(DB.indexOf('async function retrievalToolUsage'),
                     DB.indexOf('async function setQwenJobManifest'));
ck('the aggregation queries the jobs table, not the events table',
   AGG.includes('FROM account_research_qwen_jobs') && !/FROM ai_usage_events/.test(AGG),
   'events carry a priced cost');
ck('provider and fallback are counted separately',
   AGG.includes("'tavily_provider'->>'searches'")
   && AGG.includes("'tavily_general'->>'searches'"));
ck('the total is the sum of the two', /provider \+ general/.test(DB));

console.log('\n[3] No fabricated monetary value\n');
ck('the aggregation reports cost as null', /cost_usd:\s*null/.test(DB));
ck('and flags it unavailable', /cost_available:\s*false/.test(DB));
ck('the UI says Cost unavailable', HTML.includes('Cost unavailable'));
ck('bilingual', HTML.includes('暂无成本信息'));
ck('it never renders $0.00 for Tavily',
   !/u-tavily-cost[\s\S]{0,80}\$0/.test(HTML), 'zero is a claim we cannot support');
ck('no Tavily row is written to ai_usage_events',
   !/recordAiEvent[\s\S]{0,300}tavily/i.test(SRV) && !/tavily/i.test(
     SRV.slice(SRV.indexOf('function recordResearchUsage'),
               SRV.indexOf('function recordResearchUsage') + 2000)));
ck('no Tavily entry is added to the pricing table',
   !/tavily/i.test(DB.slice(DB.indexOf('AI_PRICING_SEED'),
                            DB.indexOf('AI_PRICING_SEED') + 3000)));

console.log('\n[4] Model accounting is untouched\n');
ck('the model cost still comes from ai.cost_usd',
   /set\("u-cost",\s*"\$"\s*\+\s*Number\(ai\.cost_usd/.test(APP));
ck('retrieval and synthesis remain the only priced kinds',
   /kind\s*===\s*'synthesis'\s*\?\s*'synthesis'\s*:\s*'retrieval'/.test(SRV));
ck('the deterministic request id is unchanged',
   SRV.includes('`arq:${jobId}:${kind}:${i}`'));

console.log('\n[5] The endpoint degrades rather than blanking the bar\n');
const ep = SRV.slice(SRV.indexOf("app.get('/api/usage'"), SRV.indexOf("app.post('/api/usage/reset'"));
ck('retrieval tools are fetched', ep.includes('retrievalToolUsage'));
ck('a failure yields null, not a throw', /catch\s*\([\s\S]{0,60}retrieval_tools = null/.test(ep));
ck('model usage is returned either way', ep.includes('res.json(out)'));
ck('the client tolerates a null block',
   /d\.retrieval_tools \|\| \{\}/.test(APP), 'a missing block must render zeros, not crash');

console.log('\n[6] The sidebar cannot pick up the wrong figure\n');
ck('Tavily uses a distinct class', HTML.includes('class="u-cost-na"'));
ck('exactly one .u-cost remains in the bar',
   (HTML.match(/class="u-cost"/g) || []).length === 1,
   String((HTML.match(/class="u-cost"/g) || []).length));
ck('the summary selects .u-cost', APP.includes('bar.querySelector(".u-cost")'));

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
fail.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail.length ? 1 : 0);
