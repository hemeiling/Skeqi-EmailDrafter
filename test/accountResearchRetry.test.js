/* How the account-research Claude call behaves when the network misbehaves.
 *
 * A section of a report is an agentic call that legitimately runs for
 * minutes. Before this, a single blip anywhere in that window threw
 * "fetch failed", dropped the section to fallback boilerplate, and recorded
 * nothing — so the failure was neither diagnosable nor visible.
 *
 * Every case here runs against a local stub server; the real API is never
 * called and no tokens are spent.
 */
process.env.CLAUDE_MESSAGES_URL = 'http://127.0.0.1:0/v1/messages';  // replaced in before()
process.env.CLAUDE_REQUEST_TIMEOUT_MS = '900';
process.env.CLAUDE_MAX_ATTEMPTS = '3';
process.env.CLAUDE_RETRY_BASE_MS = '40';
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let server, mode = 'ok', hits = 0, callClaude, describeFetchError, isRetryable;

test.before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (mode === 'reset') { req.socket.destroy(); return; }
    if (mode === 'hang') return;                                  // never answers
    if (mode === 'flaky' && hits < 3) { req.socket.destroy(); return; }
    if (mode === 'ratelimit') {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    }
    if (mode === 'auth') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 5, output_tokens: 2 },
      stop_reason: 'end_turn',
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.CLAUDE_MESSAGES_URL = `http://127.0.0.1:${server.address().port}/v1/messages`;

  ({ callClaude, describeFetchError, isRetryable } = require('../accountResearch').__test);
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  // Remove the usage rows these failures deliberately recorded.
  const db = require('../db');
  await db.pool.query(`DELETE FROM ai_usage_events WHERE sub_feature = 'zztest_retry'`);
});

const call = () => callClaude({ model: 'stub', prompt: 'hi', useSearch: false, meta: { section: 'zztest_retry' } });
const withMode = (m) => { mode = m; hits = 0; };

test('a healthy call makes exactly one request', async () => {
  withMode('ok');
  const r = await call();
  assert.equal(hits, 1);
  assert.match(r.text, /ok/);
});

test('a transient failure is retried and recovers', async () => {
  // The case that matters: two dropped connections then success. This used to
  // lose the whole section to fallback content on the first drop.
  withMode('flaky');
  const r = await call();
  assert.equal(hits, 3, 'should have retried twice before succeeding');
  assert.match(r.text, /ok/);
});

test('a network failure reports the real cause, not "fetch failed"', async () => {
  withMode('reset');
  await assert.rejects(call, (err) => {
    assert.notEqual(err.message, 'fetch failed', 'the underlying cause was discarded');
    assert.match(err.message, /UND_ERR|ECONN|socket|closed/i);
    return true;
  });
  assert.equal(hits, 3, 'a dropped connection is retryable');
});

test('a rate limit is retried', async () => {
  withMode('ratelimit');
  await assert.rejects(call, /rate limited/);
  assert.equal(hits, 3);
});

test('an auth error is NOT retried', async () => {
  // Retrying a bad key burns time to be told the same thing three times.
  withMode('auth');
  await assert.rejects(call, /invalid x-api-key/);
  assert.equal(hits, 1);
});

test('a hung connection times out instead of hanging the section', async () => {
  withMode('hang');
  await assert.rejects(call, /timed out/i);
  assert.ok(hits >= 1);
});

test('retryability is decided by the kind of failure', () => {
  assert.equal(isRetryable({ status: 429 }), true);
  assert.equal(isRetryable({ status: 503 }), true);
  assert.equal(isRetryable({ status: 401 }), false);
  assert.equal(isRetryable({ status: 400 }), false);
  assert.equal(isRetryable({ name: 'AbortError' }), true);
});

test('describeFetchError names the underlying code', () => {
  const err = new Error('fetch failed');
  err.cause = { code: 'ECONNRESET', message: 'socket hang up' };
  const out = describeFetchError(err);
  assert.match(out, /ECONNRESET/);
  assert.notEqual(out, 'fetch failed');
});
