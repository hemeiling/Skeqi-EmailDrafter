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
