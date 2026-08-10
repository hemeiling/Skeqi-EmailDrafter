// Account Intelligence Report generator — ported from the standalone
// Skeqi-AccountResearch app so it runs as a tab inside this application.
//
// Two things changed in the port, both deliberate:
//   1. Storage moved from files (DATA_DIR/reports/*.json) to PostgreSQL, so
//      reports survive redeploys and can be joined against the CRM.
//   2. Claude usage is recorded through usage.js, so the AI Usage dashboard
//      covers this feature too — including the web-search tool fee, which the
//      original app (and this project's research.js) never accounted for.

const express = require('express');
/* undici's own fetch, not the global one. Node bundles its own copy of
   undici internally, and a dispatcher built from the standalone package is
   rejected by it ("invalid onRequestStart method") — the two are different
   implementations. Taking both fetch and Agent from the same package keeps
   them compatible. */
const { Agent, fetch: undiciFetch } = require('undici');
const { CLAUDE_API_KEY, isClaudeConfigured } = require('./config');
const { recordAiEvent, WEB_SEARCH_USD_PER_CALL } = require('./usage');

const CLAUDE_MESSAGES_URL = process.env.CLAUDE_MESSAGES_URL || 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 16000;
const MAX_TOOL_ITER = 8;          // safety bound on the agentic search loop

// Newer server-side search tool than the original app used
// (web_search_20250305 + its beta header); this variant needs no beta header
// and matches what research.js already uses elsewhere in the project.
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 5 };

// Per-section cache lifetimes: fast-moving content expires sooner than
// slow-moving content. Mirrors the standalone app's TTL table.
const CACHE_TTL_MS = {
  s1: 30 * 24 * 3600e3,   // company overview
  s2: 7 * 24 * 3600e3,    // financials
  s3: 14 * 24 * 3600e3,   // strategy & technology
  s4: 1 * 24 * 3600e3,    // recent news
  s5: 7 * 24 * 3600e3,    // competitive & pain points
  s6: 14 * 24 * 3600e3,   // stakeholders & sales
  default: 7 * 24 * 3600e3,
};

// Count the server-side searches Claude actually performed, so the tool fee
// ($10 / 1,000 searches) can be billed alongside the tokens.
function countSearches(content) {
  return (content || []).filter(
    (b) => b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;
}

/* ── Retrieval configuration ──────────────────────────────────────────
   Every value here is measured, not guessed. From ai_usage_events, real
   successful account-research calls have run:

       211s, 230s, 245s, 252s, 271s, 297s   (median 245s)

   A previous version of this file set a 180s per-request timeout and
   described it as "well above" those numbers. It is below all of them. The
   result was that a normal call was aborted three times over nine minutes
   and then reported as a fallback -- the timeout was manufacturing the
   failures it appeared to be reporting.

   Two separate bounds, because they do different jobs:
     REQUEST_TIMEOUT_MS  — one HTTP request. Catches a dead socket. Must sit
                           above genuine request latency or it invents faults.
     SECTION_DEADLINE_MS — the whole section including retries. Stops three
                           doomed attempts from silently costing nine minutes. */
const REQUEST_TIMEOUT_MS  = Number(process.env.CLAUDE_REQUEST_TIMEOUT_MS)  || 420000;  // 7 min

/* Node's HTTP client applies its own headersTimeout of 300s, *below* any
   AbortController we set. A non-streaming research call sends nothing until
   the whole answer is ready, so a section that needs longer than five
   minutes to think is killed by the client before the server has done
   anything wrong.

   Measured, not inferred: s3 of the live Tesla run died twice at 301004ms
   and 301022ms while REQUEST_TIMEOUT_MS was 420000. Two independent
   attempts landing within 18ms of 300s is the default, not the network.
   This is also the original "fetch failed" — it predates every timeout this
   file has ever set, and the standalone app would hit it identically.

   The dispatcher below lifts that ceiling so the AbortController is once
   again the binding deadline. Note this is a floor-raise, not a fix for
   long calls in general: a five-minute silent request is fragile through
   any proxy or load balancer with its own idle timeout. The durable answer
   is streaming (stream: true), where tokens arrive continuously and no
   idle timer ever fires; that wants live validation before it lands. */
const CLAUDE_DISPATCHER = new Agent({
  headersTimeout: Number(process.env.CLAUDE_HEADERS_TIMEOUT_MS) || 900000,   // 15 min
  bodyTimeout:    Number(process.env.CLAUDE_BODY_TIMEOUT_MS)    || 900000,
  keepAliveTimeout: 60000,
  connections: 8,
});
const SECTION_DEADLINE_MS = Number(process.env.CLAUDE_SECTION_DEADLINE_MS) || 780000;  // 13 min
const MAX_ATTEMPTS        = Number(process.env.CLAUDE_MAX_ATTEMPTS)        || 3;
const RETRY_BASE_MS       = Number(process.env.CLAUDE_RETRY_BASE_MS)       || 1500;
const RETRY_CAP_MS        = Number(process.env.CLAUDE_RETRY_CAP_MS)        || 20000;

/* Node's fetch reports every network-level failure as the same two words,
   "fetch failed". The reason it actually failed -- DNS, reset connection,
   TLS, timeout -- is on err.cause, which is easy to discard by accident.
   Losing it makes every distinct fault look identical in the logs. */
function describeFetchError(err, timeoutMs) {
  if (err && err.name === 'AbortError') {
    return `Request timed out after ${Math.round((timeoutMs || REQUEST_TIMEOUT_MS) / 1000)}s`;
  }
  const cause = err && err.cause;
  if (cause) {
    const code = cause.code || cause.errno;
    const detail = cause.message && cause.message !== err.message ? cause.message : '';
    if (code) return `${err.message} (${code}${detail ? `: ${detail}` : ''})`;
    if (detail) return `${err.message} (${detail})`;
  }
  return (err && err.message) || 'Unknown network error';
}

/* Classification drives both the retry decision and what the user is told.
   These are genuinely different faults with different remedies, and calling
   them all "fetch failed" hid that. */
function classifyFailure(err) {
  if (err && err.name === 'AbortError') return { kind: 'timeout', retryable: true };
  if (err && err.status) {
    const s = err.status;
    if (s === 429) return { kind: 'rate_limited', retryable: true };
    if (s === 529) return { kind: 'overloaded', retryable: true };
    if (s >= 500)  return { kind: 'upstream_5xx', retryable: true };
    if (s === 401 || s === 403) return { kind: 'auth', retryable: false };
    return { kind: 'bad_request', retryable: false };
  }
  if (err && err.cause) {
    const code = (err.cause.code || '').toString();
    if (/ENOTFOUND|EAI_AGAIN/.test(code))        return { kind: 'dns', retryable: true };
    if (/ECONNRESET|UND_ERR_SOCKET|EPIPE/.test(code)) return { kind: 'connection_reset', retryable: true };
    if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(code)) return { kind: 'connect_timeout', retryable: true };
    if (/CERT|TLS|SSL/i.test(code))              return { kind: 'tls', retryable: false };
    return { kind: 'network', retryable: true };
  }
  return { kind: 'unknown', retryable: false };
}

/* Anthropic sends Retry-After on 429/529. Waiting the advertised time is
   both faster and politer than a fixed backoff curve guessed from nothing. */
function retryDelayMs(err, attempt) {
  const advertised = err && err.retryAfterSec;
  if (advertised && Number.isFinite(advertised)) {
    return Math.min(advertised * 1000, RETRY_CAP_MS);
  }
  // Exponential with jitter; jitter matters because six sections retrying in
  // lockstep would otherwise arrive at the API together.
  const base = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), RETRY_CAP_MS);
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* One HTTP request, with its own deadline. `budgetMs` lets the caller shorten
   the timeout when the section deadline is closer than the per-request one,
   so a request is never started that cannot possibly finish in time. */
async function postToClaude(body, budgetMs) {
  const timeoutMs = Math.max(5000, Math.min(REQUEST_TIMEOUT_MS, budgetMs));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const resp = await undiciFetch(CLAUDE_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
      dispatcher: CLAUDE_DISPATCHER,     // lifts the 300s headers ceiling
    });
    return { resp, ms: Date.now() - startedAt, timeoutMs };
  } catch (err) {
    err.__ms = Date.now() - startedAt;
    err.__timeoutMs = timeoutMs;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const API_HOST = (() => { try { return new URL(CLAUDE_MESSAGES_URL).host; } catch (e) { return CLAUDE_MESSAGES_URL; } })();

/* One structured line per HTTP attempt. Written as JSON so a Render log can
   be filtered and counted rather than read: every field the failure analysis
   needs -- host, section, attempt, iteration, status, latency, the timeout in
   force, the upstream request id, and the exact exception -- is on the line
   that records the attempt, not spread across several. */
function logAttempt(rec) {
  try { console.log('[research-fetch] ' + JSON.stringify(rec)); }
  catch (e) { console.log('[research-fetch] (unserialisable trace)'); }
}

// Agentic call: Claude may search several times before answering. Server-side
// tools resolve on Anthropic's side, so a `pause_turn` is resumed by replaying
// the assistant turn rather than by us executing anything.
async function callClaude({ model, prompt, useSearch, meta }) {
  if (!isClaudeConfigured()) throw new Error('CLAUDE_API_KEY is not configured');

  const section = (meta && meta.section) || 'unknown';
  const messages = [{ role: 'user', content: prompt }];
  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  let searchCalls = 0;
  let finalText = '';
  const started = Date.now();
  const deadline = started + SECTION_DEADLINE_MS;
  const trace = [];
  let httpRequests = 0;

  for (let iter = 1; iter <= MAX_TOOL_ITER; iter++) {
    const body = { model, max_tokens: MAX_TOKENS, messages };
    if (useSearch) body.tools = [WEB_SEARCH_TOOL];

    let resp = null;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const budget = deadline - Date.now();
      if (budget <= 5000) {
        lastError = new Error(`Section deadline of ${Math.round(SECTION_DEADLINE_MS / 1000)}s reached`);
        lastError.__kind = 'deadline';
        break;
      }

      httpRequests++;
      try {
        const out = await postToClaude(body, budget);
        resp = out.resp;
        const reqId = resp.headers.get('request-id') || resp.headers.get('x-request-id') || null;

        if (resp.ok) {
          trace.push({ iter, attempt, status: 200, ms: out.ms });
          logAttempt({ ev: 'ok', host: API_HOST, section, iter, attempt,
                       status: 200, ms: out.ms, timeout_ms: out.timeoutMs, request_id: reqId });
          lastError = null;
          break;
        }

        // An error response: read the body for Anthropic's own message.
        const errBody = await resp.json().catch(() => ({}));
        const msg = (errBody && errBody.error && errBody.error.message) || `HTTP ${resp.status}`;
        const httpErr = new Error(msg);
        httpErr.status = resp.status;
        const ra = resp.headers.get('retry-after');
        if (ra) httpErr.retryAfterSec = Number(ra) || null;
        const cls = classifyFailure(httpErr);
        httpErr.__kind = cls.kind;
        lastError = httpErr;

        trace.push({ iter, attempt, status: resp.status, ms: out.ms, kind: cls.kind });
        logAttempt({ ev: 'http_error', host: API_HOST, section, iter, attempt,
                     status: resp.status, kind: cls.kind, ms: out.ms, timeout_ms: out.timeoutMs,
                     request_id: reqId, retry_after: httpErr.retryAfterSec || null, error: msg });

        if (!cls.retryable || attempt === MAX_ATTEMPTS) break;
      } catch (netErr) {
        const described = describeFetchError(netErr, netErr.__timeoutMs);
        const cls = classifyFailure(netErr);
        const wrapped = new Error(described);
        wrapped.cause = netErr;
        wrapped.__kind = cls.kind;
        lastError = wrapped;

        trace.push({ iter, attempt, status: null, ms: netErr.__ms || 0, kind: cls.kind });
        logAttempt({ ev: 'network_error', host: API_HOST, section, iter, attempt,
                     status: null, kind: cls.kind, ms: netErr.__ms || 0,
                     timeout_ms: netErr.__timeoutMs || null,
                     error: described, cause_code: (netErr.cause && (netErr.cause.code || netErr.cause.errno)) || null });

        if (!cls.retryable || attempt === MAX_ATTEMPTS) break;
      }

      const wait = retryDelayMs(lastError, attempt);
      // Never sleep past the deadline just to start an attempt that cannot finish.
      if (Date.now() + wait + 5000 >= deadline) {
        logAttempt({ ev: 'giving_up', host: API_HOST, section, iter, attempt,
                     reason: 'retry would exceed the section deadline' });
        break;
      }
      logAttempt({ ev: 'retrying', host: API_HOST, section, iter, attempt, in_ms: wait });
      await sleep(wait);
    }

    if (lastError) {
      /* Recorded before throwing. Network-level failures used to bypass
         recordAiEvent entirely -- it only ran for !resp.ok -- so a section
         killed by a dropped connection left no trace in the usage dashboard.
         A failure nobody can see is a failure nobody can fix. */
      const summary = `${lastError.message} [${lastError.__kind || 'error'}; ${httpRequests} request(s), ${Math.round((Date.now() - started) / 1000)}s]`;
      recordAiEvent({
        feature: 'account_research', sub_feature: section,
        model, status: 'error', error_message: summary,
        response_ms: Date.now() - started, user_id: meta && meta.userId,
      });
      logAttempt({ ev: 'section_failed', host: API_HOST, section,
                   kind: lastError.__kind || 'error', total_ms: Date.now() - started,
                   http_requests: httpRequests, error: lastError.message });
      const out = new Error(lastError.message);
      out.kind = lastError.__kind || 'error';
      out.trace = trace;
      out.httpRequests = httpRequests;
      throw out;
    }

    const data = await resp.json();
    const content = data.content || [];
    if (data.usage) {
      usage.inputTokens += data.usage.input_tokens || 0;
      usage.outputTokens += data.usage.output_tokens || 0;
      usage.cacheCreationInputTokens += data.usage.cache_creation_input_tokens || 0;
      usage.cacheReadInputTokens += data.usage.cache_read_input_tokens || 0;
    }
    searchCalls += countSearches(content);

    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) finalText = text;

    // Server-side tools ran out of turns; resend to let Anthropic continue.
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content });
      continue;
    }

    /* A client-side tool request. We declare only the server-side web_search
       tool, whose loop resumes through pause_turn above, so this should not
       occur -- and the previous code treated it as unreachable and threw
       "Unexpected stop_reason: tool_use", losing the section outright.

       The original standalone app relayed these instead, and that is the
       safer behaviour: acknowledge each block so the conversation can
       continue rather than dying on a turn we merely did not expect. The
       reply echoes the request rather than executing anything -- we have no
       client-side tool to execute -- so this is a continuation, not a real
       tool result. It is logged because if it ever fires, the tool
       configuration is what actually needs looking at. MAX_TOOL_ITER still
       bounds the loop. */
    if (data.stop_reason === 'tool_use') {
      const toolUseBlocks = content.filter((b) => b.type === 'tool_use');
      if (!toolUseBlocks.length) {
        throw new Error('stop_reason=tool_use but no tool_use blocks in the response');
      }
      logAttempt({ ev: 'client_tool_use', host: API_HOST, section, iter,
                   tools: toolUseBlocks.map((b) => b.name).join(','),
                   note: 'unexpected for a server-side search tool; relaying to continue' });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: toolUseBlocks.map((tu) => ({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: tu.input ? JSON.stringify(tu.input) : '{}',
        })),
      });
      continue;
    }

    if (data.stop_reason === 'end_turn' || data.stop_reason === 'max_tokens' || finalText) {
      if (!finalText) throw new Error(`No text in response (stop_reason=${data.stop_reason})`);
      const { cost_usd } = recordAiEvent({
        feature: 'account_research', sub_feature: section,
        outcome: 'new_ai_call', model,
        input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadInputTokens,
        cache_write_tokens: usage.cacheCreationInputTokens,
        web_search_calls: searchCalls,
        company_id: meta && meta.companyId, user_id: meta && meta.userId,
        response_ms: Date.now() - started,
      });
      logAttempt({ ev: 'section_ok', host: API_HOST, section, total_ms: Date.now() - started,
                   http_requests: httpRequests, searches: searchCalls,
                   in_tokens: usage.inputTokens, out_tokens: usage.outputTokens });
      return { text: finalText, usage, apiCalls: iter, model, searchCalls, costUSD: cost_usd, trace };
    }

    throw new Error(`Unexpected stop_reason: ${data.stop_reason}`);
  }
  throw new Error(`Agentic loop exceeded ${MAX_TOOL_ITER} iterations`);
}

function createRouter(db) {
  const router = express.Router();
  const userOf = (req) => req.appUser || null;

  // Connectivity probe used by the UI's "Test" button.
  router.post('/api/test', async (req, res) => {
    try {
      const { text } = await callClaude({
        model: DEFAULT_MODEL,
        prompt: 'Reply with exactly: "Connected · 连接成功"',
        useSearch: false,
        meta: { section: 'test', userId: userOf(req) },
      });
      res.json({ ok: true, text });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // One research step. The UI drives the six sections itself and caches each.
  router.post('/api/research', async (req, res) => {
    const { prompt, useSearch = true, model = DEFAULT_MODEL, section, companyId } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ ok: false, error: 'prompt is required' });
    }
    try {
      const r = await callClaude({
        model, prompt, useSearch,
        meta: { section, companyId, userId: userOf(req) },
      });
      res.json({
        ok: true, text: r.text, usage: r.usage, apiCalls: r.apiCalls,
        model: r.model, searchCalls: r.searchCalls, costUSD: r.costUSD,
      });
    } catch (err) {
      res.status(500).json({
        ok: false, error: err.message,
        kind: err.kind || 'error',              // timeout / rate_limited / upstream_5xx / dns / …
        httpRequests: err.httpRequests || null,
        trace: err.trace || null,
      });
    }
  });

  // ── Report repository ────────────────────────────────────────────────────
  router.post('/api/reports', async (req, res) => {
    const D = req.body || {};
    if (!D.target || !D.seller) {
      return res.status(400).json({ ok: false, error: 'target and seller are required' });
    }
    try {
      const saved = await db.saveAccountReport(D, userOf(req));
      res.json({ ok: true, ...saved });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/api/reports', async (req, res) => {
    try {
      res.json({ ok: true, reports: await db.listAccountReports(req.query.q) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/api/reports/:id', async (req, res) => {
    try {
      const found = await db.getAccountReport(req.params.id);
      if (!found) return res.status(404).json({ ok: false, error: 'Report not found' });
      res.json({ ok: true, report: found.report, version: found.version });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.delete('/api/reports/:id', async (req, res) => {
    try {
      const gone = await db.deleteAccountReport(req.params.id);
      if (!gone) return res.status(404).json({ ok: false, error: 'Report not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Per-section research cache ───────────────────────────────────────────
  router.get('/api/research-cache/:type/:key', async (req, res) => {
    const { type, key } = req.params;
    try {
      const ttl = CACHE_TTL_MS[type] || CACHE_TTL_MS.default;
      const hit = await db.getAccountResearchCache(type, key, ttl);
      // A cache hit is a real saving — record it so the dashboard's reuse rate
      // reflects this feature the same way it does for the rest of the app.
      if (hit.found) {
        recordAiEvent({
          feature: 'account_research', sub_feature: type, outcome: 'cache_hit',
          model: DEFAULT_MODEL, user_id: userOf(req),
        });
      }
      res.json({ ok: true, ...hit });
    } catch (err) {
      res.json({ ok: true, found: false, error: err.message });
    }
  });

  router.post('/api/research-cache/:type/:key', async (req, res) => {
    const { data, costUSD } = req.body || {};
    if (data === undefined) return res.status(400).json({ ok: false, error: 'data is required' });
    try {
      await db.setAccountResearchCache(req.params.type, req.params.key, data, costUSD);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.delete('/api/research-cache/:type/:key', async (req, res) => {
    try {
      await db.clearAccountResearchCache(req.params.type, req.params.key);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/health', (_req, res) => {
    const key = CLAUDE_API_KEY || '';
    res.json({
      status: 'ok',
      hasKey: isClaudeConfigured(),
      // Enough to tell which key is loaded, not enough to be a leak.
      keyHint: key ? `${key.slice(0, 8)}…${key.slice(-4)}` : null,
      model: DEFAULT_MODEL,
    });
  });

  return router;
}

module.exports = { __test: { callClaude, describeFetchError, classifyFailure, retryDelayMs }, createRouter, DEFAULT_MODEL, WEB_SEARCH_USD_PER_CALL };
