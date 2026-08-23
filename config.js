// Centralized configuration. This is the ONLY place environment variables
// are read from in the whole app -- every other module imports values from
// here instead of touching process.env directly. If a new API key or
// service is added later, it gets a line here, not scattered across files.
//
// All values come from the environment (a local .env file, loaded via
// dotenv below, or real env vars set on the host/deploy platform). Nothing
// here is ever sent to the browser -- see server.js, which only exposes
// boolean "is this configured" flags, never the values themselves.

require('dotenv').config();

const APOLLO_API_KEY = process.env.APOLLO_API_KEY || '';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
const APP_USERNAME = process.env.APP_USERNAME || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PORT = process.env.PORT || 3000;

/* ── Which model does which job ───────────────────────────────────────────
   Two workloads with different economics, so two independent settings.
   Neither default reads the other's variable, and nothing below is shared,
   so changing one model can never move the other.

     Email drafting  → Qwen 3.6 Flash by default, with GPT and Claude kept
                       available. Routine, high-volume writing: drafts,
                       replies, rewrites, tone changes, classification.
     Research        → Claude, unchanged. Account/company research depends on
                       Anthropic's server-side web search tool, which has no
                       equivalent in either OpenAI-compatible path.

   Every value is overridable from the environment; nothing here is shared
   between the two workloads, so changing an email model cannot move a
   research model. */

/* ── Bailian (Qwen) ────────────────────────────────────────────────────────
   Reached through its OpenAI-compatible endpoint, so it reuses the same
   client as GPT rather than getting a pipeline of its own.

   The base URL is read from the environment with no default. The deployment
   uses a token-plan MaaS host rather than the public dashscope.aliyuncs.com,
   and a hardcoded fallback would silently send traffic — and the API key —
   to the wrong host if the variable were ever missing. Absent URL therefore
   means "not configured", which is the safe reading. */
const BAILIAN_BASE_URL = process.env.BAILIAN_BASE_URL || '';
const BAILIAN_EMAIL_MODEL = process.env.BAILIAN_EMAIL_MODEL || 'qwen3.6-flash';
/* Qwen 3.6 is a reasoning family and thinks by DEFAULT, billing every
   reasoning token at the output rate. Measured on this endpoint: a request
   whose answer was 16 tokens emitted 1,980 — 1,960 of them reasoning — and
   took 10.4s instead of 0.5s. Left on, the "cheap" default costs about ten
   times GPT-5.6 Luna for the same draft and is four times slower.

   An outreach email is not a reasoning problem, so thinking is off. Note the
   flag must be sent TOP-LEVEL: nesting it under `extra_body`, as the Python
   SDK does, is ignored by the raw HTTP API and silently leaves it on. */
const BAILIAN_ENABLE_THINKING = String(process.env.BAILIAN_ENABLE_THINKING || 'false') === 'true';

/* The two settings follow different conventions: OPENAI_CHAT_URL is a full
   endpoint, while BAILIAN_BASE_URL is a base ending in /v1 — which is how
   both vendors document them, and how anyone copying from their consoles
   will paste them. POSTing to a bare base returns a confusing
   "url error, please check url" rather than anything naming the real cause,
   so the path is completed here and either form is accepted. */
function chatCompletionsUrl(url) {
  const u = String(url || '').replace(/\/+$/, '');
  if (!u) return '';
  return /\/chat\/completions$/.test(u) ? u : `${u}/chat/completions`;
}

// Verified against developers.openai.com: `gpt-5.6-luna` is the current ID and
// carries no dated snapshot alias. Luna is the GPT-5.6 cost tier (Sol =
// flagship, Terra = mid), $0.20/$1.20 per 1M in/out.
const OPENAI_EMAIL_MODEL = process.env.OPENAI_EMAIL_MODEL || 'gpt-5.6-luna';
const OPENAI_CHAT_URL = process.env.OPENAI_CHAT_URL || 'https://api.openai.com/v1/chat/completions';
/* GPT-5.6 is a reasoning family: reasoning tokens are drawn from the SAME
   budget as the visible reply and are billed at the output rate. Carrying
   Claude's max_tokens:1024 over verbatim would risk a request that spends
   its whole allowance thinking and returns an empty draft, so the budget is
   raised and the reasoning effort pinned low — an outreach email is not a
   reasoning problem, and low effort is both cheaper and faster. */
const OPENAI_EMAIL_MAX_TOKENS = Number(process.env.OPENAI_EMAIL_MAX_TOKENS || 4000);
const OPENAI_EMAIL_REASONING_EFFORT = process.env.OPENAI_EMAIL_REASONING_EFFORT || 'low';

// The Claude model offered for drafting. Named separately from anything
// research uses, so the premium email option can be retuned on its own.
const CLAUDE_EMAIL_FALLBACK_MODEL = process.env.CLAUDE_EMAIL_FALLBACK_MODEL || 'claude-sonnet-4-6';

/* ── The email model catalogue ─────────────────────────────────────────────
   One entry per provider the drafting UI can offer. `label` is what a user
   sees: a product name and nothing else. No endpoint, vendor platform or
   credential term appears here, because this object is what the browser is
   given — the selector must never become a description of the plumbing.

   `dialect` is the part that is easy to get wrong. All three speak different
   request shapes, and sending the wrong field is a request-time failure:
     · GPT-5.6 rejects `max_tokens`; the field is `max_completion_tokens`,
       and it accepts `reasoning_effort`.
     · Qwen's compatible mode expects plain `max_tokens` and has no
       `reasoning_effort` — sending OpenAI's spelling risks a 400.
     · Claude is not OpenAI-shaped at all and uses its own client.
   Keeping the shape beside the provider stops the client from guessing. */
const EMAIL_MODELS = {
  qwen: {
    id: 'qwen', label: 'Qwen 3.6 Flash', provider: 'bailian',
    model: BAILIAN_EMAIL_MODEL, baseUrl: chatCompletionsUrl(BAILIAN_BASE_URL), apiKey: BAILIAN_API_KEY,
    dialect: { style: 'openai-compatible', maxTokensField: 'max_tokens', reasoningEffort: null,
               extra: { enable_thinking: BAILIAN_ENABLE_THINKING } },
  },
  gpt: {
    id: 'gpt', label: 'GPT', provider: 'openai',
    model: OPENAI_EMAIL_MODEL, baseUrl: chatCompletionsUrl(OPENAI_CHAT_URL), apiKey: OPENAI_API_KEY,
    dialect: { style: 'openai-compatible', maxTokensField: 'max_completion_tokens', reasoningEffort: OPENAI_EMAIL_REASONING_EFFORT },
  },
  claude: {
    id: 'claude', label: 'Claude', provider: 'anthropic',
    model: CLAUDE_EMAIL_FALLBACK_MODEL, baseUrl: null, apiKey: CLAUDE_API_KEY,
    dialect: { style: 'anthropic' },
  },
};

// Default for drafting. Qwen unless the environment says otherwise.
const DEFAULT_EMAIL_MODEL_ID = process.env.DEFAULT_EMAIL_MODEL_ID || 'qwen';
// A stalled provider must not hold a draft open; the browser gives up at 20s.
const EMAIL_REQUEST_TIMEOUT_MS = Number(process.env.EMAIL_REQUEST_TIMEOUT_MS || 60000);

// Configured = has a key, and (for the OpenAI-shaped ones) somewhere to send it.
function isEmailModelAvailable(id) {
  const m = EMAIL_MODELS[id];
  if (!m || !m.apiKey) return false;
  return m.dialect.style === 'anthropic' ? true : Boolean(m.baseUrl);
}
function isBailianConfigured() { return isEmailModelAvailable('qwen'); }

/* What the drafting UI is allowed to show: id and label only. Never the
   model string, endpoint or key — a user picks a product, not a deployment. */
function listEmailModelChoices() {
  return Object.values(EMAIL_MODELS)
    .filter((m) => isEmailModelAvailable(m.id))
    .map((m) => ({ value: m.id, label: m.label }));
}

/* Chosen provider first, then the rest as fallback. The residual order is
   written out per selection rather than derived: picking a premium model
   should fall back to the other premium model before dropping to the cheap
   default, while the default falls back upward. A rule clever enough to
   produce all three from one sort would be harder to check than the table. */
const EMAIL_FALLBACK_CHAINS = {
  qwen: ['qwen', 'gpt', 'claude'],
  gpt: ['gpt', 'claude', 'qwen'],
  claude: ['claude', 'gpt', 'qwen'],
};
function emailProviderChain(selectedId) {
  const chain = EMAIL_FALLBACK_CHAINS[selectedId] || EMAIL_FALLBACK_CHAINS[DEFAULT_EMAIL_MODEL_ID] || ['qwen', 'gpt', 'claude'];
  // Unconfigured providers are dropped, never attempted.
  return chain.filter(isEmailModelAvailable);
}

/* ── The assistant's models ────────────────────────────────────────────────
   Configured separately from drafting, on purpose. They are different
   workloads with different economics — drafting writes one paragraph from a
   fixed prompt, the assistant runs a tool loop and re-reads every result — and
   sharing a variable would mean retuning one silently moved the other.

   The chain stays inside Bailian. That is not a preference: a fallback has to
   be able to do the job it is falling back to, and GPT-5.6 Luna rejects
   function tools outright when `reasoning_effort` is present —

     Function tools with reasoning_effort are not supported for gpt-5.6-luna

   — so a chain that dropped to GPT produced an HTTP 400 rather than a degraded
   answer. Live smoke tests hit that on two calls in five. Falling back within
   one vendor keeps the tool contract identical; the models differ in capability
   and price, not in dialect.

   Order is smallest-first. The assistant's work is choosing among eleven tools
   and summarising their output, which qwen3.6-flash handles at about 2.5s and a
   twentieth of a cent; the larger models exist for the turns it cannot finish,
   not as a default.

   Every entry is env-configurable so the chain can be retuned without a
   deploy — and so a model that turns out not to support tool calling can be
   removed in one line rather than shipped around. */
const BAILIAN_CHAT_MODEL = process.env.BAILIAN_CHAT_MODEL || 'qwen3.6-flash';
const BAILIAN_CHAT_FALLBACK_MODELS = String(
  process.env.BAILIAN_CHAT_FALLBACK_MODELS ?? 'qwen3.7-plus,qwen3.8-max',
).split(',').map((m) => m.trim()).filter(Boolean);

const CHAT_ENABLE_THINKING = String(process.env.CHAT_ENABLE_THINKING || 'false') === 'true';
/* A stalled provider must not hold the panel open. Shorter than drafting's:
   a chat reply that takes a minute has already lost the conversation. */
const CHAT_REQUEST_TIMEOUT_MS = Number(process.env.CHAT_REQUEST_TIMEOUT_MS || 30000);
/* The loop is bounded so a vague question cannot spend the afternoon calling
   tools. Six covers "research but no outreach, then tell me about the top
   one"; past that the model is usually going in circles. */
/* Tool budgets, per model attempt and per turn.

   Measured rather than chosen. Over eleven representative live questions the
   healthy turns used 0-3 tool calls — median 1, p95 3 — and the only turns
   that reached the old ceiling of 6 were the two asking how many companies
   were attending, which hit it because the capability to answer was missing
   rather than because the work was large.

   So 5 is comfortably above the p95 for a first attempt, and a fallback needs
   3 to run any path in that distribution end to end. The turn ceiling is their
   sum: a fallback can never be squeezed below what a p95 path costs, which was
   the flaw in 6/3/8 — a maximal primary left the fallback 2.

   These bound EXECUTION, never availability. Tools stay attached to every
   factual attempt; what runs out is permission to run them. Withdrawing the
   schema is what produced the protocol leak in the first place. */
const CHAT_MAX_TOOL_CALLS = Number(process.env.CHAT_MAX_TOOL_CALLS || 5);
const CHAT_FALLBACK_TOOL_CALLS = Number(process.env.CHAT_FALLBACK_TOOL_CALLS || 3);
const CHAT_TURN_TOOL_CEILING = Number(process.env.CHAT_TURN_TOOL_CEILING || 8);

/* The emergency exit, off unless someone turns it on. A cross-provider
   fallback is worth having when Bailian is unreachable entirely, and is worth
   NOT having in the normal path: its dialect differs, its price differs, and
   the reasoning_effort incompatibility above means it needs its own handling
   rather than inheriting the drafting catalogue's. */
const CHAT_EMERGENCY_FALLBACK = String(process.env.CHAT_EMERGENCY_FALLBACK || '')
  .split(',').map((m) => m.trim()).filter(Boolean);

/** One Bailian entry. All of them share the endpoint, the key and the dialect. */
function bailianChatModel(id, model) {
  return {
    id,
    label: model,
    provider: 'bailian',
    model,
    baseUrl: chatCompletionsUrl(BAILIAN_BASE_URL),
    apiKey: BAILIAN_API_KEY,
    dialect: {
      style: 'openai-compatible',
      maxTokensField: 'max_tokens',
      // Qwen has no concept of it, and sending OpenAI's spelling risks a 400.
      reasoningEffort: null,
      supportsTools: true,
      extra: { enable_thinking: CHAT_ENABLE_THINKING },
    },
  };
}

const CHAT_MODELS = {};
CHAT_MODELS.qwen = bailianChatModel('qwen', BAILIAN_CHAT_MODEL);
BAILIAN_CHAT_FALLBACK_MODELS.forEach((m, i) => {
  CHAT_MODELS[`qwen_fallback_${i + 1}`] = bailianChatModel(`qwen_fallback_${i + 1}`, m);
});

/* GPT and Claude remain available, but only when explicitly named in
   CHAT_EMERGENCY_FALLBACK. `supportsTools: false` on GPT is the lesson from the
   400 above: the tool loop must not offer tools to a model that will reject
   them, and the client reads this flag rather than discovering it at runtime. */
CHAT_MODELS.gpt = {
  id: 'gpt', label: 'GPT', provider: 'openai',
  model: OPENAI_EMAIL_MODEL, baseUrl: chatCompletionsUrl(OPENAI_CHAT_URL), apiKey: OPENAI_API_KEY,
  dialect: {
    style: 'openai-compatible',
    maxTokensField: 'max_completion_tokens',
    reasoningEffort: OPENAI_EMAIL_REASONING_EFFORT,
    // Rejects function tools while reasoning_effort is set.
    supportsTools: false,
  },
};
CHAT_MODELS.claude = {
  id: 'claude', label: 'Claude', provider: 'anthropic',
  model: CLAUDE_EMAIL_FALLBACK_MODEL, baseUrl: null, apiKey: CLAUDE_API_KEY,
  dialect: { style: 'anthropic', supportsTools: false },
};

const DEFAULT_CHAT_MODEL_ID = 'qwen';

function isChatModelAvailable(id) {
  const m = CHAT_MODELS[id];
  if (!m || !m.apiKey) return false;
  return m.dialect.style === 'anthropic' ? true : Boolean(m.baseUrl);
}
function isChatConfigured() { return isChatModelAvailable('qwen'); }

/**
 * The order the assistant tries models in.
 *
 * Bailian first, in configured order; the emergency providers only if someone
 * has named them. A model that cannot call tools is still worth having last —
 * it can answer "I could not reach the data" in a sentence rather than the
 * request failing outright — but it is never reached while a Qwen model works.
 */
function chatProviderChain(selectedId) {
  const bailian = ['qwen', ...BAILIAN_CHAT_FALLBACK_MODELS.map((_, i) => `qwen_fallback_${i + 1}`)];
  const emergency = CHAT_EMERGENCY_FALLBACK
    .map((name) => (name === 'gpt' || name === 'claude' ? name : null))
    .filter(Boolean);
  const ordered = selectedId && bailian.includes(selectedId)
    ? [selectedId, ...bailian.filter((id) => id !== selectedId)]
    : bailian;
  return [...ordered, ...emergency].filter(isChatModelAvailable);
}

/** What the chain looks like right now, for diagnostics. Never keys or URLs. */
function describeChatChain() {
  return chatProviderChain().map((id) => ({
    id, model: CHAT_MODELS[id].model, provider: CHAT_MODELS[id].provider,
    tools: CHAT_MODELS[id].dialect.supportsTools !== false,
  }));
}

function isApolloConfigured() {
  return Boolean(APOLLO_API_KEY);
}
function isClaudeConfigured() {
  return Boolean(CLAUDE_API_KEY);
}
function isOpenAiConfigured() {
  return Boolean(OPENAI_API_KEY);
}
// Drafting is available if EITHER provider can serve it.
// Drafting is available if ANY provider in the catalogue is usable.
function isEmailModelConfigured() {
  return listEmailModelChoices().length > 0;
}
function isLoginGateConfigured() {
  return Boolean(APP_USERNAME && APP_PASSWORD);
}

module.exports = {
  CHAT_MODELS, DEFAULT_CHAT_MODEL_ID, BAILIAN_CHAT_MODEL, BAILIAN_CHAT_FALLBACK_MODELS,
  CHAT_ENABLE_THINKING, CHAT_REQUEST_TIMEOUT_MS, CHAT_MAX_TOOL_CALLS,
  CHAT_FALLBACK_TOOL_CALLS, CHAT_TURN_TOOL_CEILING, CHAT_EMERGENCY_FALLBACK,
  isChatModelAvailable, isChatConfigured, chatProviderChain, describeChatChain,

  APOLLO_API_KEY,
  CLAUDE_API_KEY,
  OPENAI_API_KEY,
  APP_USERNAME,
  APP_PASSWORD,
  PORT,
  OPENAI_EMAIL_MODEL,
  OPENAI_CHAT_URL,
  OPENAI_EMAIL_MAX_TOKENS,
  OPENAI_EMAIL_REASONING_EFFORT,
  CLAUDE_EMAIL_FALLBACK_MODEL,
  EMAIL_MODELS,
  DEFAULT_EMAIL_MODEL_ID,
  EMAIL_REQUEST_TIMEOUT_MS,
  listEmailModelChoices,
  emailProviderChain,
  isEmailModelAvailable,
  isBailianConfigured,
  isApolloConfigured,
  isClaudeConfigured,
  isOpenAiConfigured,
  isEmailModelConfigured,
  isLoginGateConfigured
};
