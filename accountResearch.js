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
const { CLAUDE_API_KEY, isClaudeConfigured } = require('./config');
const { recordAiEvent, WEB_SEARCH_USD_PER_CALL } = require('./usage');

const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
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

// Agentic call: Claude may search several times before answering. Server-side
// tools resolve on Anthropic's side, so a `pause_turn` is resumed by replaying
// the assistant turn rather than by us executing anything.
async function callClaude({ model, prompt, useSearch, meta }) {
  if (!isClaudeConfigured()) throw new Error('CLAUDE_API_KEY is not configured');

  const messages = [{ role: 'user', content: prompt }];
  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  let searchCalls = 0;
  let finalText = '';
  const started = Date.now();

  for (let iter = 1; iter <= MAX_TOOL_ITER; iter++) {
    const body = { model, max_tokens: MAX_TOKENS, messages };
    if (useSearch) body.tools = [WEB_SEARCH_TOOL];

    const resp = await fetch(CLAUDE_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const msg = (err && err.error && err.error.message) || `HTTP ${resp.status}`;
      recordAiEvent({
        feature: 'account_research', sub_feature: meta && meta.section,
        model, status: 'error', error_message: msg,
        response_ms: Date.now() - started, user_id: meta && meta.userId,
      });
      throw new Error(msg);
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

    if (data.stop_reason === 'end_turn' || data.stop_reason === 'max_tokens' || finalText) {
      if (!finalText) throw new Error(`No text in response (stop_reason=${data.stop_reason})`);
      const { cost_usd } = recordAiEvent({
        feature: 'account_research', sub_feature: meta && meta.section,
        outcome: 'new_ai_call', model,
        input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadInputTokens,
        cache_write_tokens: usage.cacheCreationInputTokens,
        web_search_calls: searchCalls,
        company_id: meta && meta.companyId, user_id: meta && meta.userId,
        response_ms: Date.now() - started,
      });
      return { text: finalText, usage, apiCalls: iter, model, searchCalls, costUSD: cost_usd };
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
      res.status(500).json({ ok: false, error: err.message });
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
      const report = await db.getAccountReport(req.params.id);
      if (!report) return res.status(404).json({ ok: false, error: 'Report not found' });
      res.json({ ok: true, report });
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

module.exports = { createRouter, DEFAULT_MODEL, WEB_SEARCH_USD_PER_CALL };
