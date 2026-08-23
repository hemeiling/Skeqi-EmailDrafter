// AI + Apollo usage tracking.
//
// Two layers:
//  1. In-memory SESSION counters (reset on server restart / the Reset button) —
//     what the footer shows as "this session".
//  2. Every AI-relevant event is ALSO persisted (db.recordAiUsage, injected via
//     setPersist to avoid a require cycle) so the detailed view can show today /
//     this month / all-time, per feature, and per company.
//
// A single entry point — recordAiEvent — is used for BOTH real AI calls and
// reuse/skip events (db_reuse / cache_hit / ai_avoided). Reuse events carry
// tokens_saved_* (estimated from a prior real call) and contribute ONLY to the
// "saved" counters — never to spent tokens or cost.

/* USD per million tokens, keyed "provider:model".

   Keyed on BOTH because model name alone is not a price. Two vendors now bill
   this app at rates 15× apart — Claude Sonnet at $3/$15 against GPT-5.6 Luna
   at $0.20/$1.20 — and the old model-only lookup fell back to a Claude-priced
   `_default` for anything it did not recognise. An unseeded OpenAI model would
   therefore have been billed at Sonnet's rate and reported ~15× too high.
   Nothing here may silently price one provider's tokens with another's card. */
const PRICING = {
  'anthropic:claude-sonnet-4-6': { in: 3.00, out: 15.00, cr: 0.30, cw: 3.75 },
  'anthropic:claude-opus-4-8':   { in: 5.00, out: 25.00, cr: 0.50, cw: 6.25 },
  'anthropic:claude-sonnet-5':   { in: 3.00, out: 15.00, cr: 0.30, cw: 3.75 },
  'anthropic:claude-haiku-4-5':  { in: 1.00, out: 5.00, cr: 0.10, cw: 1.25 },
  // developers.openai.com, verified Aug 2026: $0.20 in / $0.02 cached / $1.20 out.
  // OpenAI has no cache-WRITE fee, hence cw: 0 — writes are not billed separately.
  'openai:gpt-5.6-luna':         { in: 0.20, out: 1.20, cr: 0.02, cw: 0 },
  'openai:gpt-5.6-terra':        { in: 1.25, out: 10.00, cr: 0.125, cw: 0 },
  'openai:gpt-5.6-sol':          { in: 1.75, out: 14.00, cr: 0.175, cw: 0 },
  /* ESTIMATED — and labelled as such everywhere the number is shown.

     These are Alibaba's PUBLISHED PER-TOKEN LIST prices (Model Studio, checked
     Aug 2026): flash $0.1875/$1.125, plus $0.40/$1.60, max $2.00/$6.00 per 1M.
     Flash is carried at the 0.19/1.13 already seeded in ai_model_pricing so
     the code and the table cannot disagree; the difference is under 2% and is
     well inside the uncertainty below.

     They are marked estimated because our deployment bills against a prepaid
     Token Plan, and a Token Plan's drawdown per token is not something the
     list price establishes. TPM/PTU capacity pricing is a third number again
     and is deliberately not used here — capacity is not consumption, and
     dividing one by the other would be inventing a rate rather than reading
     one. Until an invoice confirms the drawdown, `est: true` follows the
     number into the event row, the API and the dashboard.

     `est` is a property of the RATE, not of the feature: set is_estimated to
     false on the ai_model_pricing row once an invoice confirms it and the
     label disappears on its own. Confirming a price is a data change here,
     never a deploy. */
  'bailian:qwen3.6-flash':       { in: 0.19, out: 1.13, cr: 0.019, cw: 0, est: true },
  'bailian:qwen3.7-plus':        { in: 0.40, out: 1.60, cr: 0.04, cw: 0, est: true },
  'bailian:qwen3.8-max':         { in: 2.00, out: 6.00, cr: 0.20, cw: 0, est: true },
};
// Per-provider last resort. Never cross-provider: an unknown Claude model is
// guessed at Sonnet's rate, an unknown OpenAI model at Luna's — never at
// each other's.
const PROVIDER_DEFAULT = {
  anthropic: { in: 3.00, out: 15.00, cr: 0.30, cw: 3.75, est: true },
  openai:    { in: 0.20, out: 1.20, cr: 0.02, cw: 0, est: true },
  bailian:   { in: 0.19, out: 1.13, cr: 0.019, cw: 0, est: true },
};

// Pricing loaded from the DB (ai_model_pricing) at startup overrides the seed
// above. That table is keyed (provider, model), so the key is built the same way.
let _pricing = null;
function setPricingTable(rows) {
  _pricing = {};
  for (const r of rows || []) {
    _pricing[`${r.provider || 'anthropic'}:${r.model}`] = {
      in: Number(r.input_price_per_m), out: Number(r.output_price_per_m),
      cr: Number(r.cache_read_price_per_m || 0), cw: Number(r.cache_write_price_per_m || 0),
      // Set on the row, so confirming a price is a data change, not a deploy.
      est: Boolean(r.is_estimated),
    };
  }
}

// Warn once per unpriced model rather than per request — a misconfigured model
// would otherwise either flood the log or, worse, stay silent while billing at
// a guessed rate.
const _warnedModels = new Set();
function priceFor(model, provider = 'anthropic') {
  const key = `${provider}:${model}`;
  if (_pricing && _pricing[key]) return _pricing[key];
  if (PRICING[key]) return PRICING[key];
  if (model && !_warnedModels.has(key)) {
    _warnedModels.add(key);
    console.warn(`[usage] no pricing for "${key}" — costs are estimated at the ${provider} default. `
      + `Add a row to ai_model_pricing to price it exactly.`);
  }
  return PROVIDER_DEFAULT[provider] || PROVIDER_DEFAULT.anthropic;
}

function costFor(model, input, output, cacheRead = 0, cacheWrite = 0, provider = 'anthropic') {
  const p = priceFor(model, provider);
  return ((input || 0) / 1e6) * p.in + ((output || 0) / 1e6) * p.out
    + ((cacheRead || 0) / 1e6) * (p.cr || 0) + ((cacheWrite || 0) / 1e6) * (p.cw || 0);
}

/* The same number, plus whether the card behind it is confirmed. A cost the
   dashboard cannot vouch for should not be displayed as though it can be. */
function costDetail(model, input, output, cacheRead = 0, cacheWrite = 0, provider = 'anthropic') {
  return {
    cost: costFor(model, input, output, cacheRead, cacheWrite, provider),
    estimated: Boolean(priceFor(model, provider).est),
  };
}

/**
 * Cost of ONE turn that may have taken several model calls.
 *
 * A turn is not one request. The assistant calls the model, runs tools, calls
 * it again — and if the first model fails, everything it spent before failing
 * is still billed. Charging those tokens at the SERVING model's rate is the
 * bug this exists to prevent: qwen3.8-max costs nine times qwen3.6-flash, so a
 * flash turn that fell back to max was being priced at max's card end to end.
 *
 * Each attempt is priced with its own model's card and the parts are summed.
 * Attempts with no usage (a connection that never answered) cost nothing and
 * are kept anyway, because "we tried it and got nothing" is worth seeing.
 */
function costOfAttempts(attempts) {
  let cost = 0;
  let estimated = false;
  const breakdown = [];
  for (const a of attempts || []) {
    const d = costDetail(a.model, a.input_tokens, a.output_tokens,
      a.cache_read_tokens, a.cache_write_tokens, a.provider);
    cost += d.cost;
    if (d.estimated) estimated = true;
    breakdown.push({
      model: a.model || null,
      provider: a.provider || null,
      input_tokens: a.input_tokens || 0,
      output_tokens: a.output_tokens || 0,
      cache_read_tokens: a.cache_read_tokens || 0,
      reasoning_tokens: a.reasoning_tokens || 0,
      calls: a.calls || 0,
      cost_usd: round6(d.cost),
      estimated: d.estimated,
      // Which one actually produced the answer; the rest were paid for and discarded.
      served: Boolean(a.served),
    });
  }
  return { cost, estimated, breakdown };
}

/* The price card of whichever model currently drafts email. Required lazily —
   config.js is cheap, but emailModel.js must not be pulled in from here, since
   it imports this module in turn. */
function emailModelPrice() {
  const cfg = require('./config');
  const m = cfg.EMAIL_MODELS[cfg.DEFAULT_EMAIL_MODEL_ID];
  return m && cfg.isEmailModelAvailable(m.id)
    ? priceFor(m.model, m.provider)
    : priceFor(cfg.CLAUDE_EMAIL_FALLBACK_MODEL, 'anthropic');
}

// Maps internal outcome → the user-facing request_type stored per event.
const REQUEST_TYPE = {
  new_ai_call: 'new_call', user_regeneration: 'regeneration', partial_refresh: 'partial_refresh',
  db_reuse: 'reuse', cache_hit: 'reuse', ai_avoided: 'reuse', background: 'background',
};

/* The catalogue. Anything not on this list is coerced to 'other' by
   recordAiEvent — which is how the AI Assistant spent its first weeks filing
   itself under 'other' despite passing feature: 'chat' at the call site. The
   coercion is right (an unknown feature must not create a column out of
   nowhere); the omission was the bug. */
const FEATURES = [
  'company_research', 'email_draft', 'contact_intel',
  'product_match', 'attachment_rec', 'email_classify',
  'account_research', 'chat', 'other',
];

// Server-side tool fees that are billed on top of tokens. The Anthropic web
// search tool is $10 per 1,000 searches; token-only accounting under-reports
// any feature that uses it.
const WEB_SEARCH_USD_PER_CALL = 0.01;
// Outcomes that reused saved data instead of spending tokens.
const REUSE_OUTCOMES = ['db_reuse', 'cache_hit', 'ai_avoided'];

function blankFeature() {
  return {
    new_calls: 0, reuses: 0,
    input_tokens: 0, output_tokens: 0, cost_usd: 0,
    saved_input: 0, saved_output: 0, saved_cost_usd: 0,
  };
}

let session;
function freshSession() {
  return {
    apollo_people_calls: 0,
    apollo_org_calls: 0,
    ai: {
      new_calls: 0, reuses: 0,
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      saved_input: 0, saved_output: 0, saved_cost_usd: 0,
    },
    by_feature: Object.fromEntries(FEATURES.map((f) => [f, blankFeature()])),
  };
}
session = freshSession();

let _persist = null; // (row) => Promise ; set by server after db is ready
function setPersist(fn) { _persist = fn; }

function isReuse(outcome) { return REUSE_OUTCOMES.includes(outcome); }
function round6(x) { return Math.round(x * 1e6) / 1e6; }

// The one instrumentation entry point. Returns the computed cost/savings.
function recordAiEvent(evt = {}) {
  const feature = FEATURES.includes(evt.feature) ? evt.feature : 'other';
  const outcome = evt.outcome || 'new_ai_call';
  const model = evt.model || null;
  /* Defaults to anthropic so the ~277 events already in the table, and every
     research call site that never passes a provider, keep costing exactly as
     they did. Only callers that opt in are priced as OpenAI. */
  const provider = evt.provider || 'anthropic';
  const input = evt.input_tokens || 0;
  const output = evt.output_tokens || 0;
  const cacheRead = evt.cache_read_tokens || 0;
  const cacheWrite = evt.cache_write_tokens || 0;
  const savedIn = evt.tokens_saved_input || 0;
  const savedOut = evt.tokens_saved_output || 0;
  const reuse = isReuse(outcome);
  // Server-side tool fees (e.g. web search) are billed in addition to tokens.
  const searchCalls = evt.web_search_calls || 0;
  const toolCost = reuse ? 0 : searchCalls * WEB_SEARCH_USD_PER_CALL;

  /* A caller that made several model calls in one turn passes them all, and
     each is priced with its own model's card. Without this the whole turn is
     costed at whichever model happened to answer last, which understates a
     turn that fell UP the chain and overstates one that fell down. Callers
     that make a single call pass nothing and are costed exactly as before. */
  const attempts = Array.isArray(evt.attempts) && evt.attempts.length ? evt.attempts : null;
  const parts = attempts && !reuse ? costOfAttempts(attempts) : null;
  const single = reuse ? { cost: 0, estimated: false }
    : costDetail(model, input, output, cacheRead, cacheWrite, provider);
  const cost = (parts ? parts.cost : single.cost) + toolCost;
  const costEstimated = parts ? parts.estimated : single.estimated;
  const savedCost = reuse ? costFor(model, savedIn, savedOut, 0, 0, provider) : 0;

  const f = session.by_feature[feature];
  if (reuse) { session.ai.reuses += 1; f.reuses += 1; }
  else { session.ai.new_calls += 1; f.new_calls += 1; }
  session.ai.input_tokens += input; session.ai.output_tokens += output; session.ai.cost_usd += cost;
  session.ai.saved_input += savedIn; session.ai.saved_output += savedOut; session.ai.saved_cost_usd += savedCost;
  f.input_tokens += input; f.output_tokens += output; f.cost_usd += cost;
  f.saved_input += savedIn; f.saved_output += savedOut; f.saved_cost_usd += savedCost;

  if (_persist) {
    Promise.resolve(_persist({
      feature, sub_feature: evt.sub_feature || null, outcome,
      request_type: REQUEST_TYPE[outcome] || 'new_call',
      model, provider, requested_provider: evt.requested_provider || null,
      input_tokens: reuse ? 0 : input,
      output_tokens: reuse ? 0 : output,
      cache_read_tokens: reuse ? 0 : cacheRead,
      cache_write_tokens: reuse ? 0 : cacheWrite,
      reasoning_tokens: reuse ? 0 : (evt.reasoning_tokens || 0),
      cost_usd: cost, currency: 'USD', web_search_calls: reuse ? 0 : searchCalls,
      /* Which model was ASKED for as against which answered, and whether the
         difference cost anything. Fallback frequency is not recoverable from
         the served model alone: a turn that started on flash and finished on
         max looks identical to one that was sent to max deliberately. */
      requested_model: evt.requested_model || null,
      fell_back: Boolean(evt.fell_back),
      cost_estimated: costEstimated,
      // Per-model parts of a multi-call turn, including attempts that failed.
      model_breakdown: parts ? parts.breakdown : null,
      tokens_saved_input: savedIn, tokens_saved_output: savedOut, cost_saved_usd: savedCost,
      company_id: evt.company_id || null, contact_id: evt.contact_id || null, thread_id: evt.thread_id || null,
      session_id: evt.session_id || null, user_id: evt.user_id || null,
      response_ms: evt.response_ms != null ? evt.response_ms : null,
      status: evt.status || 'success', error_message: evt.error_message || null,
      request_id: evt.request_id || null,
    })).catch(() => { /* never let telemetry break a request */ });
  }
  return { cost_usd: cost, cost_saved_usd: savedCost, reuse, cost_estimated: costEstimated };
}

/* Backward-compatible shim (email classification calls this).

   The name is historical — classification may now be served by OpenAI, so the
   provider and model are taken from the caller and only fall back to Claude
   when it does not say. Passing a normalised usage object through here is
   safe: emailModel.js already reports both providers with the same field
   names and the same meaning for input_tokens (cache reads excluded). */
function recordClaudeUsage(apiUsage, meta = {}) {
  const u = apiUsage || {};
  return recordAiEvent({
    feature: meta.feature || 'other',
    outcome: meta.outcome || 'new_ai_call',
    provider: meta.provider || u.provider || 'anthropic',
    model: meta.model || u.model || 'claude-sonnet-4-6',
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_tokens: u.cache_read_tokens || 0,
    reasoning_tokens: u.reasoning_tokens || 0,
    company_id: meta.company_id, contact_id: meta.contact_id,
  });
}

function recordApolloPeopleCall() { session.apollo_people_calls += 1; }
function recordApolloOrgCall() { session.apollo_org_calls += 1; }

function getUsage() {
  const ai = session.ai;
  const bf = session.by_feature;
  return {
    apollo_people_calls: session.apollo_people_calls,
    apollo_org_calls: session.apollo_org_calls,
    // legacy claude_* fields kept so any old binding keeps working
    claude_calls: bf.email_draft.new_calls,
    claude_input_tokens: ai.input_tokens,
    claude_output_tokens: ai.output_tokens,
    claude_cost_usd: round6(ai.cost_usd),
    /* These legacy fields advertise the per-token price of email drafting,
       which is no longer Claude's — so they quote the model that actually
       drafts. The names are frozen by old bindings; the numbers must still
       be true. */
    claude_input_price_per_m: emailModelPrice().in,
    claude_output_price_per_m: emailModelPrice().out,
    ai: {
      new_calls: ai.new_calls,
      reuses: ai.reuses,
      input_tokens: ai.input_tokens,
      output_tokens: ai.output_tokens,
      total_tokens: ai.input_tokens + ai.output_tokens,
      cost_usd: round6(ai.cost_usd),
      saved_input: ai.saved_input,
      saved_output: ai.saved_output,
      saved_total: ai.saved_input + ai.saved_output,
      saved_cost_usd: round6(ai.saved_cost_usd),
      company_analyses: bf.company_research.new_calls,
      contact_analyses: bf.contact_intel.new_calls + bf.contact_intel.reuses,
      product_matches: bf.product_match.new_calls,
      attachment_recs: bf.attachment_rec.new_calls,
      drafts: bf.email_draft.new_calls,
    },
    by_feature: bf,
  };
}

function resetUsage() { session = freshSession(); }

module.exports = {
  recordAiEvent, recordClaudeUsage,
  recordApolloPeopleCall, recordApolloOrgCall,
  getUsage, resetUsage, costFor, setPersist, setPricingTable,
  PRICING, FEATURES, REUSE_OUTCOMES, WEB_SEARCH_USD_PER_CALL,
  costDetail, costOfAttempts, FEATURES,
};
