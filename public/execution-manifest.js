/* What a research run ACTUALLY did, as a compact durable record.
 *
 * The distinction this exists to hold: a configured provider is not a used one.
 * The Sessions view previously could only say which model was requested, so a
 * run that fell back, or that never reached synthesis, or that used a retrieval
 * provider, all looked identical. Nothing here is inferred from configuration,
 * from progress percentage, or from logs - every field is set from an execution
 * event the engine actually emitted.
 *
 * IDEMPOTENCY BY CONSTRUCTION. Every counter is ABSOLUTE, never incremental:
 * the engine reports "4 searches so far", not "+1 search". Merging the same
 * callback twice therefore changes nothing, which matters because callbacks are
 * retried and the whole point of a cost record is that it cannot double-count.
 *
 * Shared by the CRM and by the tests, so the merge rules are verified without a
 * database. It deliberately stores no rejected candidates - that is P1, and this
 * record has to stay small enough to read at a glance.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExecutionManifest = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;

  /* Contribution, not just usage. "Tavily ran" is far less useful than "Tavily
     contributed 6 verified sources and 2 named organisations", and it is the
     second question that decides whether a provider earns its place. */
  const CONTRIB = {
    candidates: 0, verified: 0, retained: 0, domains: 0,
    organizations: 0, account_relationships: 0,
  };

  function empty() {
    return {
      version: VERSION,
      active: { stage: null, provider: null, model: null, tool: null, intent: null },
      synthesis: { provider: null, models_attempted: [], successful_model: null,
                   calls: 0, fallback_attempts: 0 },
      retrieval: {
        current: Object.assign({ used: false, model_calls: 0, queries: 0 }, CONTRIB),
        official_site: { attempted: false, success: false, pages: 0 },
        tavily_provider: Object.assign({ used: false, searches: 0, extracts: 0,
                                         batches: 0 }, CONTRIB),
        tavily_general: Object.assign({ used: false, searches: 0, extracts: 0,
                                        reason_codes: [] }, CONTRIB),
      },
      fallbacks: [],
      usage: { model_calls: 0, input_tokens: 0, output_tokens: 0,
               estimated_cost_usd: null, cost_estimated: null,
               accounting_complete: false },
    };
  }

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  /** Absolute-set merge. Unknown keys are ignored so an older engine cannot
   *  corrupt the shape, and null/undefined never overwrites a known value. */
  function mergeInto(target, patch) {
    if (!isObj(patch)) return target;
    for (const k of Object.keys(target)) {
      if (!(k in patch)) continue;
      const pv = patch[k];
      if (pv === null || pv === undefined) continue;
      if (Array.isArray(target[k])) {
        // Arrays are set wholesale, then de-duplicated: replaying a callback
        // must not grow models_attempted or reason_codes.
        if (Array.isArray(pv)) target[k] = dedupe(pv);
      } else if (isObj(target[k])) {
        mergeInto(target[k], pv);
      } else if (typeof target[k] === 'number') {
        const n = num(pv);
        if (n !== null) target[k] = n;          // ABSOLUTE, never +=
      } else {
        target[k] = pv;
      }
    }
    return target;
  }

  function dedupe(arr) {
    const seen = new Set(); const out = [];
    for (const x of arr) {
      const k = typeof x === 'object' ? JSON.stringify(x) : String(x);
      if (seen.has(k)) continue;
      seen.add(k); out.push(x);
    }
    return out;
  }

  /** Apply an execution event to a manifest. Returns a NEW object. */
  function apply(existing, patch) {
    const m = existing && existing.version === VERSION
      ? JSON.parse(JSON.stringify(existing)) : empty();
    mergeInto(m, patch || {});
    // A provider that reports any real work is used; one that reports nothing
    // stays unused, so a configured-but-unused provider never appears as used.
    for (const key of ['tavily_provider', 'tavily_general']) {
      const r = m.retrieval[key];
      r.used = r.used || r.searches > 0 || r.extracts > 0;
    }
    m.retrieval.current.used = m.retrieval.current.used
      || m.retrieval.current.model_calls > 0 || m.retrieval.current.queries > 0;
    m.synthesis.calls = Math.max(m.synthesis.calls, m.synthesis.models_attempted.length);
    m.synthesis.fallback_attempts = Math.max(0, m.synthesis.calls
      - (m.synthesis.successful_model ? 1 : 0));
    return m;
  }

  /** A run has reached a terminal state. Clears `active` and decides whether the
   *  accounting can honestly be called complete. */
  function finalize(existing, opts) {
    const o = opts || {};
    const m = apply(existing, null);
    m.active = { stage: null, provider: null, model: null, tool: null, intent: null };
    /* A patch's null means "I do not know", so it never overwrites - otherwise a
       progress event would erase what a later stage learned. Ending with no
       successful model is different: it is a fact, and only a terminal caller
       can assert it, so it needs saying explicitly rather than through a null. */
    if (o.synthesisFailed === true) {
      m.synthesis.successful_model = null;
      m.synthesis.fallback_attempts = m.synthesis.calls;
    }
    // Complete means: this run was accounted for under P0-D, so every model
    // attempt that happened produced an event. A run that predates the fix, or
    // one whose accounting call failed, must say so rather than imply it is whole.
    m.usage.accounting_complete = o.accountingComplete === true;
    return m;
  }

  /** A job that ran before P0-D. Its synthesis attempts were never emitted, so
   *  the totals it carries are retrieval-only. We say that; we do not estimate
   *  the missing attempts and we do not reconstruct a partial figure. */
  function forLegacyJob(job) {
    const j = job || {};
    const m = empty();
    m.synthesis.provider = j.model ? 'bailian' : null;
    m.synthesis.successful_model = j.report_id ? (j.model || null) : null;
    const d = j.usage_detail || {};
    if (d.retrieval) {
      m.retrieval.current.used = (d.retrieval.calls || 0) > 0;
      m.retrieval.current.model_calls = d.retrieval.calls || 0;
    }
    m.usage.input_tokens = j.input_tokens || 0;
    m.usage.output_tokens = j.output_tokens || 0;
    m.usage.model_calls = (d.retrieval && d.retrieval.calls) || 0;
    m.usage.estimated_cost_usd = j.estimated_cost_usd == null
      ? null : String(j.estimated_cost_usd);
    m.usage.cost_estimated = j.cost_estimated == null ? null : !!j.cost_estimated;
    m.usage.accounting_complete = false;        // never true for a pre-P0-D job
    m.legacy = true;
    return m;
  }

  /** Providers that actually did something. Never derived from configuration. */
  function providersUsed(m) {
    if (!m) return [];
    const out = [];
    if (m.retrieval && m.retrieval.current.used) out.push('current_retrieval');
    if (m.retrieval && m.retrieval.official_site.attempted) out.push('official_site');
    if (m.retrieval && m.retrieval.tavily_provider.used) out.push('tavily_provider');
    if (m.retrieval && m.retrieval.tavily_general.used) out.push('tavily_general');
    if (m.synthesis && m.synthesis.calls > 0) out.push('synthesis');
    return out;
  }

  return { VERSION, empty, apply, finalize, forLegacyJob, providersUsed };
}));
