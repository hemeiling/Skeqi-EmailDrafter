/* ═══════════════════════════════════════════════════════════════════════
   The email model — one place that decides which vendor writes an email.

   Two workloads, deliberately split:

     Email drafting / classification  → Qwen 3.6 Flash by default, with GPT
                                        and Claude available   (this file)
     Account & company research       → Claude, unchanged      (research.js,
                                                                accountResearch.js)

   Research is untouched by anything here. It stays on Claude because it
   depends on Anthropic's server-side web search tool, which neither
   OpenAI-compatible path has an equivalent for; moving it would change
   results, not just cost.

   Qwen and GPT are both reached over OpenAI-compatible HTTP, so they share
   ONE client and differ only by the dialect recorded in the catalogue. There
   is no second drafting pipeline: `runEmailModel` remains the single entry
   point, and callers pass a preference rather than picking a transport.

   Callers get one normalised shape back regardless of who served it:

     { ok, text, usage: { provider, model, input_tokens, output_tokens,
                          cache_read_tokens, reasoning_tokens },
       requested_provider, fell_back, status, error }

   `usage` carries the provider that ACTUALLY ran — never the one intended.
   A fallback reported as the requested model would bill one vendor's tokens
   at another's rate, and would hide from Analytics that a fallback happened
   at all.
   ═══════════════════════════════════════════════════════════════════════ */

const {
  EMAIL_MODELS, DEFAULT_EMAIL_MODEL_ID, EMAIL_REQUEST_TIMEOUT_MS,
  emailProviderChain, isEmailModelAvailable, listEmailModelChoices,
} = require('./config');

const CLAUDE_MESSAGES_URL = process.env.CLAUDE_MESSAGES_URL || 'https://api.anthropic.com/v1/messages';

/* Every provider call is bounded. Without a deadline a stalled endpoint
   produces a promise that never settles, the draft route never responds, and
   the compose panel spins until the browser's own 20s timeout — with no
   fallback attempted, because nothing ever failed. A timeout is what turns a
   hang into an error the chain below can route around. */
async function fetchWithTimeout(url, options, ms = EMAIL_REQUEST_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ── One client for every OpenAI-compatible provider ───────────────────────
   Two dialect details that fail at request time if guessed:

   · The token-limit field. GPT-5.6 rejects `max_tokens` and wants
     `max_completion_tokens`; Qwen's compatible mode wants plain
     `max_tokens`. The field name comes from the catalogue.
   · `reasoning_effort` is OpenAI-specific. It is sent only when the
     catalogue supplies one, so Qwen never receives a parameter it has no
     concept of.

   And one accounting detail: OpenAI-compatible `prompt_tokens` INCLUDES
   cached tokens, whereas Anthropic reports cache reads separately. Cached
   tokens are subtracted out here so both providers mean the same thing by
   "input_tokens" and one cost formula stays correct for all three. */
async function callOpenAiCompatible(cfg, prompt, { maxTokens, json } = {}) {
  const body = {
    model: cfg.model,
    messages: [{ role: 'user', content: prompt }],
    [cfg.dialect.maxTokensField]: maxTokens || 4000,
  };
  if (cfg.dialect.reasoningEffort) body.reasoning_effort = cfg.dialect.reasoningEffort;
  // Provider-specific extras (e.g. Qwen's enable_thinking), sent top-level.
  if (cfg.dialect.extra) Object.assign(body, cfg.dialect.extra);
  /* OpenAI rejects `response_format: json_object` outright — HTTP 400 —
     unless the word "json" appears somewhere in the messages. Qwen and
     Claude impose no such rule, so a prompt edit that dropped the word would
     break GPT alone while the default provider carried on working: a failure
     that only appears for users who picked the premium option. Asking for
     JSON mode only when the prompt actually asks for JSON removes the trap.
     Every current drafting prompt qualifies; this guards future edits. */
  if (json && /json/i.test(prompt)) body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout(cfg.baseUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    // The label, not the vendor host — error strings reach the compose panel.
    return { ok: false, status: res.status, error: `${cfg.label} request failed (${res.status}): ${text.slice(0, 200)}` };
  }

  const data = await res.json();
  const u = data.usage || {};
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  const choice = (data.choices && data.choices[0]) || {};
  return {
    ok: true,
    text: (choice.message && choice.message.content) || '',
    usage: {
      provider: cfg.provider,
      model: data.model || cfg.model,
      input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached),
      output_tokens: u.completion_tokens || 0,   // already includes reasoning tokens
      cache_read_tokens: cached,
      reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
    },
  };
}

// Anthropic is not OpenAI-shaped and keeps its own client.
async function callAnthropic(cfg, prompt, { maxTokens } = {}) {
  const res = await fetchWithTimeout(CLAUDE_MESSAGES_URL, {
    method: 'POST',
    headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens || 1024, messages: [{ role: 'user', content: prompt }] }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, status: res.status, error: `${cfg.label} request failed (${res.status}): ${text.slice(0, 200)}` };
  }

  const data = await res.json();
  const u = data.usage || {};
  return {
    ok: true,
    text: (data.content && data.content[0] && data.content[0].text) || '',
    usage: {
      provider: cfg.provider, model: cfg.model,
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_read_tokens: u.cache_read_input_tokens || 0,
      reasoning_tokens: 0,
    },
  };
}

async function callProvider(id, prompt, opts) {
  const cfg = EMAIL_MODELS[id];
  if (!cfg) return { ok: false, error: `Unknown email model "${id}".` };
  return cfg.dialect.style === 'anthropic'
    ? callAnthropic(cfg, prompt, opts)
    : callOpenAiCompatible(cfg, prompt, opts);
}

// Resolve a user's selection to a real choice. Anything unknown, unset or
// no-longer-configured falls back to the default rather than erroring.
function resolveEmailModelId(requested) {
  if (requested && isEmailModelAvailable(requested)) return requested;
  if (isEmailModelAvailable(DEFAULT_EMAIL_MODEL_ID)) return DEFAULT_EMAIL_MODEL_ID;
  const first = listEmailModelChoices()[0];
  return first ? first.value : DEFAULT_EMAIL_MODEL_ID;
}

/* Run the chain: selection first, then the remaining configured providers.
   Fallbacks are logged with a reason but never with a key or a URL — a
   misconfigured provider should be diagnosable from the log without the log
   becoming a place credentials leak. */
async function runEmailModel(prompt, opts = {}) {
  const requestedId = resolveEmailModelId(opts.modelId);
  const chain = emailProviderChain(requestedId);

  if (!chain.length) {
    return { ok: false, requested_provider: null, fell_back: false,
      error: 'No email model is configured.' };
  }

  let lastError = null;
  for (const id of chain) {
    try {
      const r = await callProvider(id, prompt, opts);
      if (r.ok) {
        return { ...r, requested_provider: EMAIL_MODELS[requestedId].provider, fell_back: id !== requestedId };
      }
      lastError = r.error;
    } catch (err) {
      lastError = err.name === 'AbortError'
        ? `${EMAIL_MODELS[id].label} timed out after ${EMAIL_REQUEST_TIMEOUT_MS}ms`
        : `${EMAIL_MODELS[id].label} network error: ${err.message}`;
    }
    const next = chain[chain.indexOf(id) + 1];
    if (next) console.warn(`[email-model] ${EMAIL_MODELS[id].label} failed (${lastError}) — falling back to ${EMAIL_MODELS[next].label}`);
  }

  // Every configured provider failed. Report the last real reason, not a
  // generic one: the compose panel shows this and it must be actionable.
  return { ok: false, requested_provider: EMAIL_MODELS[requestedId].provider, fell_back: chain.length > 1,
    error: lastError || 'All configured email models failed.' };
}

/* Which model a draft WOULD use right now, for the reuse path: when a saved
   draft is served instead of calling the API, the tokens saved are valued at
   the price of the model that would otherwise have run. */
function activeEmailModel(modelId) {
  const cfg = EMAIL_MODELS[resolveEmailModelId(modelId)];
  return { provider: cfg.provider, model: cfg.model };
}

module.exports = { runEmailModel, activeEmailModel, resolveEmailModelId, callProvider };
