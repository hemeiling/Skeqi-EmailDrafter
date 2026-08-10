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
process.env.CLAUDE_SECTION_DEADLINE_MS = '9000';
process.env.CLAUDE_RETRY_CAP_MS = '200';
process.env.CLAUDE_MAX_ATTEMPTS = '3';
process.env.CLAUDE_RETRY_BASE_MS = '40';
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let server, mode = 'ok', hits = 0, bodies = [], lastBody = null, callClaude, describeFetchError, classifyFailure;

test.before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { try { bodies.push(JSON.parse(raw)); } catch (e) {} }); }
    if (mode === 'reset') { req.socket.destroy(); return; }
    if (mode === 'hang') return;                                  // never answers
    if (mode === 'flaky' && hits < 3) { req.socket.destroy(); return; }
    if (mode === 'ratelimit') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    }
    if (mode === 'tool_use') {
      // First turn asks for a client-side tool; second turn answers normally.
      res.writeHead(200, { 'content-type': 'application/json' });
      if (hits === 1) {
        return res.end(JSON.stringify({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'some_tool', input: { q: 'x' } }],
          usage: { input_tokens: 3, output_tokens: 1 },
          stop_reason: 'tool_use',
        }));
      }
      return res.end(JSON.stringify({
        content: [{ type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 5, output_tokens: 2 },
        stop_reason: 'end_turn',
      }));
    }
    if (mode === 'container') {
      // Turn 1 pauses and provisions a container; turn 2 must echo its id.
      res.writeHead(200, { 'content-type': 'application/json' });
      if (hits === 1) {
        return res.end(JSON.stringify({
          content: [{ type: 'server_tool_use', id: 'stu_1', name: 'web_search', input: {} }],
          container: { id: 'container_abc123', expires_at: '2026-09-01T00:00:00Z' },
          usage: { input_tokens: 9, output_tokens: 1 }, stop_reason: 'pause_turn',
        }));
      }
      lastBody = lastBody || {};
      return res.end(JSON.stringify({
        content: [{ type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 5, output_tokens: 2 }, stop_reason: 'end_turn',
      }));
    }
    if (mode === 'container_expired') {
      res.writeHead(hits === 1 ? 200 : (hits === 2 ? 400 : 200), { 'content-type': 'application/json' });
      if (hits === 1) return res.end(JSON.stringify({
        content: [{ type: 'server_tool_use', id: 'stu_1', name: 'web_search', input: {} }],
        container: { id: 'container_dead', expires_at: '2020-01-01T00:00:00Z' },
        usage: {}, stop_reason: 'pause_turn' }));
      if (hits === 2) return res.end(JSON.stringify({ error: { message: 'container has expired' } }));
      return res.end(JSON.stringify({
        content: [{ type: 'text', text: '{"ok":true}' }], usage: {}, stop_reason: 'end_turn' }));
    }
    if (mode === 'no_blocks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ content: [], usage: {}, stop_reason: 'tool_use' }));
    }
    if (mode === 'bad_gateway') {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Bad gateway' } }));
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

  ({ callClaude, describeFetchError, classifyFailure } = require('../accountResearch').__test);
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  // Remove the usage rows these failures deliberately recorded.
  const db = require('../db');
  await db.pool.query(`DELETE FROM ai_usage_events WHERE sub_feature = 'zztest_retry'`);
});

const call = () => callClaude({ model: 'stub', prompt: 'hi', useSearch: false, meta: { section: 'zztest_retry' } });
const withMode = (m) => { mode = m; hits = 0; bodies = []; };

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

test('failures are classified into distinct, actionable kinds', () => {
  // The taxonomy is what lets the UI say "upstream API error" rather than
  // "fetch failed", and what decides retry vs give up.
  assert.deepEqual(classifyFailure({ status: 429 }), { kind: 'rate_limited', retryable: true });
  assert.deepEqual(classifyFailure({ status: 502 }), { kind: 'upstream_5xx', retryable: true });
  assert.deepEqual(classifyFailure({ status: 529 }), { kind: 'overloaded', retryable: true });
  assert.deepEqual(classifyFailure({ status: 401 }), { kind: 'auth', retryable: false });
  assert.deepEqual(classifyFailure({ status: 400 }), { kind: 'bad_request', retryable: false });
  assert.deepEqual(classifyFailure({ name: 'AbortError' }), { kind: 'timeout', retryable: true });
  assert.equal(classifyFailure({ cause: { code: 'ENOTFOUND' } }).kind, 'dns');
  assert.equal(classifyFailure({ cause: { code: 'ECONNRESET' } }).kind, 'connection_reset');
  assert.equal(classifyFailure({ cause: { code: 'CERT_HAS_EXPIRED' } }).retryable, false);
});

test('a 502 is retried and reported as an upstream fault', async () => {
  withMode('bad_gateway');
  await assert.rejects(call, (err) => {
    assert.equal(err.kind, 'upstream_5xx');
    assert.match(err.message, /Bad gateway/);
    return true;
  });
  assert.equal(hits, 3);
});

test('every attempt is traced with status and latency', async () => {
  withMode('bad_gateway');
  await call().catch((err) => {
    assert.ok(Array.isArray(err.trace), 'no trace attached');
    assert.equal(err.trace.length, 3, 'one entry per attempt');
    err.trace.forEach((t) => {
      assert.equal(t.status, 502);
      assert.equal(t.kind, 'upstream_5xx');
      assert.equal(typeof t.ms, 'number');
      assert.ok(t.attempt >= 1);
    });
    assert.equal(err.httpRequests, 3);
  });
});

test('the section deadline stops a doomed retry chain', async () => {
  // Three 900ms timeouts plus backoff must not be allowed to run for minutes;
  // this is what turned a failing section into a nine-minute stall.
  process.env.CLAUDE_SECTION_DEADLINE_MS = '2000';
  delete require.cache[require.resolve('../accountResearch')];
  const fresh = require('../accountResearch').__test;
  withMode('hang');
  const t0 = Date.now();
  await assert.rejects(() => fresh.callClaude({ model:'stub', prompt:'hi', useSearch:false, meta:{section:'zztest_retry'} }));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 6000, `gave up in ${elapsed}ms — must not keep retrying past the deadline`);
  process.env.CLAUDE_SECTION_DEADLINE_MS = '9000';
  delete require.cache[require.resolve('../accountResearch')];
});

test('describeFetchError names the underlying code', () => {
  const err = new Error('fetch failed');
  err.cause = { code: 'ECONNRESET', message: 'socket hang up' };
  const out = describeFetchError(err);
  assert.match(out, /ECONNRESET/);
  assert.notEqual(out, 'fetch failed');
});

test('an unexpected client-side tool_use turn is relayed, not fatal', async () => {
  // Previously this threw "Unexpected stop_reason: tool_use" and lost the
  // whole section. The original standalone app relayed it; that is safer.
  withMode('tool_use');
  const r = await call();
  assert.match(r.text, /ok/);
  assert.equal(hits, 2, 'should have continued the conversation, not given up');
});

test('a tool_use turn with no blocks is still an error', async () => {
  // Relaying nothing would loop to the iteration cap for no reason.
  withMode('no_blocks');
  await assert.rejects(call, /no tool_use blocks/);
});

test('the client-side headers ceiling is lifted above the request timeout', () => {
  // s3 of the live run died twice at ~301s against a 420s AbortController:
  // Node's default headersTimeout is 300s and sits beneath it, so the
  // AbortController was never the binding deadline. A dispatcher whose
  // headers ceiling is below REQUEST_TIMEOUT_MS silently reintroduces that.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'accountResearch.js'), 'utf8');
  assert.match(src, /dispatcher: CLAUDE_DISPATCHER/, 'the dispatcher is not attached to the request');
  const headers = Number(process.env.CLAUDE_HEADERS_TIMEOUT_MS) || 900000;
  const request = Number(process.env.CLAUDE_REQUEST_TIMEOUT_MS) || 420000;
  assert.ok(headers > request,
    `headersTimeout (${headers}ms) must exceed REQUEST_TIMEOUT_MS (${request}ms), or the client aborts first`);
  assert.ok(headers > 300000, 'must be above the 300s default that killed s3');
});

test('a container id is carried into the continuation request', async () => {
  // The s4 failure: the paused turn ran in a provisioned sandbox, and the
  // replay omitted its id, so the API rejected it with "container_id is
  // required when there are pending tool uses".
  withMode('container');
  const r = await call();
  assert.match(r.text, /ok/);
  assert.equal(hits, 2, 'should have continued the paused turn');
  await new Promise(res => setTimeout(res, 50));      // bodies arrive on 'end'
  assert.equal(bodies[0].container, undefined, 'first request must not invent a container');
  assert.equal(bodies[1].container, 'container_abc123', 'continuation dropped the container id');
});

test('an expired container is dropped rather than retried forever', async () => {
  // Documented recovery: resend without the parameter to be given a new one.
  withMode('container_expired');
  const r = await call();
  assert.match(r.text, /ok/);
  await new Promise(res => setTimeout(res, 50));
  assert.equal(bodies[1].container, 'container_dead', 'should have tried the container it was given');
  assert.equal(bodies[2].container, undefined, 'should have retried WITHOUT the dead container');
});

test('the container fix is generic, not keyed to any section', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'accountResearch.js'), 'utf8');
  // Branching on a section id would mean the next section to pause breaks
  // the same way. Mentioning s4 in a comment is documentation, not logic.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/section\s*===?\s*['"]s[0-9]/.test(code), 'callClaude must not branch on a section id');
  assert.match(code, /body\.container = containerId/, 'container must be sent on every continuation');
  assert.match(code, /data\.container/, 'container must be captured from every response');
});
