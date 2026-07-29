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

// USD per million tokens, by model.
const PRICING = {
  'claude-sonnet-4-6': { in: 3.00, out: 15.00, cr: 0.30, cw: 3.75 },
  'claude-opus-4-8':   { in: 5.00, out: 25.00, cr: 0.50, cw: 6.25 },
  'claude-sonnet-5':   { in: 3.00, out: 15.00, cr: 0.30, cw: 3.75 },
  'claude-haiku-4-5':  { in: 1.00, out: 5.00, cr: 0.10, cw: 1.25 },
  _default:            { in: 3.00, out: 15.00, cr: 0.30, cw: 3.75 },
};
// Pricing loaded from the DB (ai_model_pricing) at startup overrides the seed above.
let _pricing = null;
function setPricingTable(rows) {
  _pricing = {};
  for (const r of rows || []) {
    _pricing[r.model] = {
      in: Number(r.input_price_per_m), out: Number(r.output_price_per_m),
      cr: Number(r.cache_read_price_per_m || 0), cw: Number(r.cache_write_price_per_m || 0),
    };
  }
}
function priceFor(model) {
  if (_pricing && _pricing[model]) return _pricing[model];
  return PRICING[model] || PRICING._default;
}
function costFor(model, input, output, cacheRead = 0, cacheWrite = 0) {
  const p = priceFor(model);
  return ((input || 0) / 1e6) * p.in + ((output || 0) / 1e6) * p.out
    + ((cacheRead || 0) / 1e6) * (p.cr || 0) + ((cacheWrite || 0) / 1e6) * (p.cw || 0);
}

// Maps internal outcome → the user-facing request_type stored per event.
const REQUEST_TYPE = {
  new_ai_call: 'new_call', user_regeneration: 'regeneration', partial_refresh: 'partial_refresh',
  db_reuse: 'reuse', cache_hit: 'reuse', ai_avoided: 'reuse', background: 'background',
};

const FEATURES = [
  'company_research', 'email_draft', 'contact_intel',
  'product_match', 'attachment_rec', 'email_classify',
  'account_research', 'other',
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
  const cost = (reuse ? 0 : costFor(model, input, output, cacheRead, cacheWrite)) + toolCost;
  const savedCost = reuse ? costFor(model, savedIn, savedOut) : 0;

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
      model, provider: evt.provider || 'anthropic',
      input_tokens: reuse ? 0 : input,
      output_tokens: reuse ? 0 : output,
      cache_read_tokens: reuse ? 0 : cacheRead,
      cache_write_tokens: reuse ? 0 : cacheWrite,
      reasoning_tokens: reuse ? 0 : (evt.reasoning_tokens || 0),
      cost_usd: cost, currency: 'USD', web_search_calls: reuse ? 0 : searchCalls,
      tokens_saved_input: savedIn, tokens_saved_output: savedOut, cost_saved_usd: savedCost,
      company_id: evt.company_id || null, contact_id: evt.contact_id || null, thread_id: evt.thread_id || null,
      session_id: evt.session_id || null, user_id: evt.user_id || null,
      response_ms: evt.response_ms != null ? evt.response_ms : null,
      status: evt.status || 'success', error_message: evt.error_message || null,
      request_id: evt.request_id || null,
    })).catch(() => { /* never let telemetry break a request */ });
  }
  return { cost_usd: cost, cost_saved_usd: savedCost, reuse };
}

// Backward-compatible shim (claude.js email classification still calls this).
function recordClaudeUsage(apiUsage, meta = {}) {
  return recordAiEvent({
    feature: meta.feature || 'other',
    outcome: meta.outcome || 'new_ai_call',
    model: meta.model || 'claude-sonnet-4-6',
    input_tokens: (apiUsage && apiUsage.input_tokens) || 0,
    output_tokens: (apiUsage && apiUsage.output_tokens) || 0,
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
    claude_input_price_per_m: PRICING._default.in,
    claude_output_price_per_m: PRICING._default.out,
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
};
