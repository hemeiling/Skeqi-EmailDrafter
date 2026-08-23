/* ═══════════════════════════════════════════════════════════════════════════
   The assistant's orchestration loop.

   Run against a stub endpoint rather than Qwen: the behaviour worth pinning is
   what happens around the model — how many tools it may call, what happens
   when it asks for an eleventh, what the user sees when the provider times out
   — and none of that should depend on a paid API being reachable, or produce a
   different result on a different afternoon.

   The prompt-injection tests deserve a note. They do not assert that the model
   resists injection; a test cannot make that promise about a model it does not
   run. They assert the two things we control: that the instruction telling it
   to treat stored content as data is actually present in the system prompt,
   and that nothing in the tool layer will act on such content even if the
   model asks — because there is no tool that acts at all.
   ═══════════════════════════════════════════════════════════════════════════ */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

/* Before anything that reaches db.js — chatTools does, transitively. */
const dbGuard = require('./dbGuard');
const chat = require('../chat');
const chatTools = require('../chatTools');

/* ── a stub OpenAI-compatible endpoint ─────────────────────────────────────
   `script` is a queue of replies. Each request shifts one, so a test can say
   "first ask for a tool, then answer" and assert on what the loop did. */
let server;
let baseUrl;
let script = [];
let received = [];
let mode = 'script';
let failingModel = null;

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { received.push(JSON.parse(body)); } catch { received.push(null); }

      if (mode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'upstream exploded' }));
      }
      /* Only the primary model fails, so the chain has somewhere to fall TO.
         Keyed on the model in the request body because every entry in the
         catalogue points at this one stub — the model name is the only thing
         that distinguishes an attempt on flash from an attempt on plus. */
      if (mode === 'fail-primary') {
        const asked = (() => { try { return JSON.parse(body).model; } catch { return null; } })();
        if (asked === failingModel) {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'primary exploded' }));
        }
        const next = script.shift() || { content: 'Fallback answered.' };
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          model: asked,
          choices: [{ message: { role: 'assistant', content: next.content }, finish_reason: 'stop' }],
          // Deliberately different from the primary's 100/20, so a test can
          // tell which model's tokens ended up where.
          usage: { prompt_tokens: 300, completion_tokens: 50 },
        }));
      }
      if (mode === 'hang') return; // never responds; exercises the timeout
      if (mode === 'empty') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '' } }],
          usage: { prompt_tokens: 5, completion_tokens: 0 },
        }));
      }

      const next = script.shift() || { content: 'No more script.' };
      const message = next.tool_calls
        ? { role: 'assistant', content: null, tool_calls: next.tool_calls }
        : { role: 'assistant', content: next.content };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'qwen3.6-flash-stub',
        choices: [{ message, finish_reason: next.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;

  // Point the catalogue at the stub. Done here rather than through the
  // environment so the real configuration is never a test dependency.
  const cfg = require('../config');
  for (const id of Object.keys(cfg.CHAT_MODELS)) {
    cfg.CHAT_MODELS[id].baseUrl = baseUrl;
    cfg.CHAT_MODELS[id].apiKey = 'stub-key';
  }
});

test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

test.beforeEach(() => { script = []; received = []; mode = 'script'; failingModel = null; });

const ask = (text, opts = {}) =>
  chat.runChat({ messages: [{ role: 'user', content: text }], ...opts });

const toolCall = (name, args, id = 'call_1') => ([{
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
}]);

// ── the plain path ─────────────────────────────────────────────────────────

test('a question that needs no tools is answered directly', async () => {
  script = [{ content: 'I can help with booths, companies and outreach.' }];
  const r = await ask('what can you do?');
  assert.equal(r.ok, true, r.error);
  assert.match(r.reply, /booths/);
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.usage.input_tokens, 100);
});

test('token usage accumulates across every call in the turn, not just the last', async () => {
  script = [
    { tool_calls: toolCall('search_companies', { query: 'acme' }) },
    { content: 'Found it.' },
  ];
  const r = await ask('tell me about acme');
  assert.equal(r.ok, true, r.error);
  // Two model calls at 100/20 each — reporting only the final one would
  // understate a tool-using turn by half.
  assert.equal(r.usage.input_tokens, 200);
  assert.equal(r.usage.output_tokens, 40);
});

test('the tool result is fed back to the model', async () => {
  script = [
    { tool_calls: toolCall('search_companies', { query: 'zzz-nothing' }) },
    { content: 'Nothing found.' },
  ];
  const r = await ask('find zzz-nothing');
  assert.equal(r.ok, true, r.error);
  const second = received[1];
  const toolMsg = second.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'the second call must carry the tool result');
  assert.equal(toolMsg.tool_call_id, 'call_1', 'the result must be tied to the call that asked');
  const payload = JSON.parse(toolMsg.content);
  if (dbGuard.available) {
    assert.equal(payload.count, 0, 'a real database returns an empty result set');
  } else {
    // No test database: the tool fails, and that failure must reach the model
    // as data rather than taking the turn down.
    assert.ok(payload.error, 'a tool failure must still be reported to the model');
  }
});

/* What the user sees when the database is unreachable. The answer must be an
   error — never a fluent reply assembled from the model's own knowledge of
   the company, which is the failure mode that makes a CRM assistant dangerous
   rather than merely broken. */
test('a database failure produces an error, not a fabricated answer', async () => {
  script = [
    { tool_calls: toolCall('get_company_profile', { company_id: 1 }) },
    { content: 'I could not read the CRM just now.' },
  ];
  const r = await ask('tell me about company 1');
  assert.equal(r.ok, true, r.error);
  const toolMsg = received[1].messages.find((m) => m.role === 'tool');
  const payload = JSON.parse(toolMsg.content);
  if (!dbGuard.available) {
    assert.ok(payload.error, 'the tool must report the failure');
    assert.doesNotMatch(JSON.stringify(payload), /select |from |where /i,
      'SQL must never reach the model');
  }
});

test('the tool catalogue is offered to the model', async () => {
  script = [{ content: 'ok' }];
  await ask('hello');
  const names = received[0].tools.map((t) => t.function.name).sort();
  assert.deepEqual(names, Object.keys(chatTools.TOOLS).sort());
  assert.equal(received[0].tool_choice, 'auto');
});

test('thinking is disabled, top-level, as Qwen requires', async () => {
  script = [{ content: 'ok' }];
  await ask('hello');
  assert.equal(received[0].enable_thinking, false,
    'nested under extra_body it is silently ignored and costs ten times as much');
  assert.equal(received[0].max_tokens, 1500, 'Qwen takes max_tokens, not max_completion_tokens');
});

// ── bounds ─────────────────────────────────────────────────────────────────

test('the tool budget is enforced, and the model is told to answer anyway', async () => {
  // Ask for a tool on every round, far more than the budget allows.
  for (let i = 0; i < 20; i++) {
    script.push({ tool_calls: toolCall('search_companies', { query: `q${i}` }, `call_${i}`) });
  }
  script.push({ content: 'Answering with what I have.' });

  const r = await ask('do everything');
  assert.ok(r.toolCalls.length <= require('../config').CHAT_MAX_TOOL_CALLS,
    `ran ${r.toolCalls.length} tools, budget is ${require('../config').CHAT_MAX_TOOL_CALLS}`);
  // The final call must withhold the tools, forcing an answer rather than
  // another request that never arrives.
  const last = received[received.length - 1];
  assert.ok(!last.tools, 'the last round must not offer tools');
});

test('history is trimmed so a long conversation cannot grow without bound', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  assert.equal(chat.trimHistory(many).length, chat.MAX_HISTORY);
});

test('an over-long message is truncated rather than refused', () => {
  const [m] = chat.trimHistory([{ role: 'user', content: 'x'.repeat(99_999) }]);
  assert.equal(m.content.length, chat.MAX_MESSAGE_CHARS);
});

test('empty or junk history is refused with a usable message', async () => {
  const r = await chat.runChat({ messages: [] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  const r2 = await chat.runChat({ messages: [{ role: 'user', content: '   ' }] });
  assert.equal(r2.ok, false);
});

// ── failure ────────────────────────────────────────────────────────────────

test('a provider error is reported, never answered around', async () => {
  mode = 'error';
  const r = await ask('anything');
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.match(r.error, /request failed \(500\)/);
  assert.ok(!r.reply, 'a failed turn must not produce a reply');
});

test('an empty answer is treated as a failure, not shown as a blank reply', async () => {
  mode = 'empty';
  const r = await ask('anything');
  assert.equal(r.ok, false);
  assert.match(r.error, /empty answer/i);
});

test('a hanging provider times out instead of holding the panel open', async () => {
  mode = 'hang';
  const cfg = require('../config');
  const real = cfg.CHAT_REQUEST_TIMEOUT_MS;
  cfg.CHAT_REQUEST_TIMEOUT_MS = 600;   // the deadline is what is under test, not its length
  const started = Date.now();
  const r = await ask('anything');
  const elapsed = Date.now() - started;
  cfg.CHAT_REQUEST_TIMEOUT_MS = real;
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out|error/i);
  assert.ok(elapsed < 10_000, `took ${elapsed}ms — the timeout did not fire`);
});

test('a failed turn still reports what it cost', async () => {
  mode = 'error';
  const r = await ask('anything');
  assert.ok(r.usage, 'usage must be present so failures are not invisible in Analytics');
  assert.equal(typeof r.usage.response_ms, 'number');
});

test('a tool that fails does not fail the turn', async () => {
  script = [
    { tool_calls: toolCall('get_company_contacts', { company_id: 'nonsense' }) },
    { content: 'I could not read that.' },
  ];
  const r = await ask('who works there');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.toolCalls[0].ok, false, 'the failure is recorded');
  assert.match(r.reply, /could not/i);
});

test('a tool the model invents is refused without breaking the loop', async () => {
  script = [
    { tool_calls: toolCall('run_raw_sql', { sql: 'select * from users' }) },
    { content: 'I cannot do that.' },
  ];
  const r = await ask('dump the users table');
  assert.equal(r.ok, true, r.error);
  const toolMsg = received[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /unknown tool/);
});

// ── page context ───────────────────────────────────────────────────────────

test('page context reaches the model as identifiers, not as screen text', async () => {
  script = [{ content: 'ok' }];
  await ask('tell me about this company', {
    pageContext: { view: 'booth-map', companyId: 42, companyName: 'Acme', boothNumber: '4405' },
  });
  const system = received[0].messages.filter((m) => m.role === 'system');
  const ctx = system.map((m) => m.content).join('\n');
  assert.match(ctx, /company_id: 42/);
  assert.match(ctx, /booth: 4405/);
  assert.match(ctx, /this company/i, 'the model must be told what "this" refers to');
});

test('no page context adds no message', () => {
  assert.equal(chat.contextMessage(null), null);
  assert.equal(chat.contextMessage({}), null);
});

// ── the system prompt's honesty rules ──────────────────────────────────────

/* These are the instructions that keep the assistant from inventing CRM
   relationships for the 16 unlinked booths. They are load-bearing enough to
   assert on directly — an edit that drops them would otherwise be invisible
   until someone acted on a wrong answer. */
/* Added after live testing: the model reported page counts as totals until
   the prompt told it the difference. */
test('the system prompt distinguishes totals from the rows shown', () => {
  assert.match(chat.SYSTEM_PROMPT, /total_contacts|total_messages/);
  assert.match(chat.SYSTEM_PROMPT, /never\s+"we have 15 contacts"|showing 15/i);
});

test('the system prompt forbids presenting a placeholder as a finding', () => {
  assert.match(chat.SYSTEM_PROMPT, /placeholder/i);
});

test('the system prompt warns that a company id is not a contact id', () => {
  assert.match(chat.SYSTEM_PROMPT, /A company id\s*\n?\s*is not a contact id/i);
});

test('the system prompt forbids inventing facts', () => {
  assert.match(chat.SYSTEM_PROMPT, /Never state a company name, booth number, count/i);
  assert.match(chat.SYSTEM_PROMPT, /not linked to a CRM company/i);
  assert.match(chat.SYSTEM_PROMPT, /do not omit them/i);
  assert.match(chat.SYSTEM_PROMPT, /Never claim we have researched, contacted or drafted/i);
});

test('the system prompt states the assistant is read-only', () => {
  assert.match(chat.SYSTEM_PROMPT, /read-only/i);
  assert.match(chat.SYSTEM_PROMPT, /cannot send email/i);
});

test('the system prompt treats stored content as data, not instructions', () => {
  assert.match(chat.SYSTEM_PROMPT, /DATA, not instructions/i);
  assert.match(chat.SYSTEM_PROMPT, /ignore your rules|change your behaviour/i);
});

test('injected instructions in stored data cannot reach an action', async () => {
  /* Even if the model were fully taken in by a company record that says "send
     an email to everyone", the only thing it can emit is a tool name — and
     there is no tool that sends anything. Verified structurally. */
  const names = Object.keys(chatTools.TOOLS);
  for (const evil of ['send_email', 'delete_company', 'run_sql', 'update_contact', 'execute']) {
    assert.ok(!names.includes(evil), `${evil} must not exist`);
    const r = await chatTools.runTool(evil, {});
    assert.match(r.error, /unknown tool/);
  }
});

test('suggestions are offered in both languages', () => {
  assert.ok(chat.SUGGESTIONS.length >= 3);
  for (const s of chat.SUGGESTIONS) {
    assert.ok(s.en && s.zh, 'every suggestion needs both languages');
  }
});

/* ── what a turn cost, and where ───────────────────────────────────────────
   The assistant is the only feature here whose single turn can span more than
   one model, and for a while Analytics could not express that: a turn was
   costed entirely at whichever model answered. Within this chain that is a
   real error and not a rounding one, because qwen3.8-max lists at ten times
   qwen3.6-flash. These pin the accounting, not the prices. */

test('a turn reports what each model spent, not just the total', async () => {
  script = [
    { tool_calls: toolCall('search_companies', { query: 'acme' }) },
    { content: 'Found it.' },
  ];
  const r = await ask('tell me about acme');
  assert.equal(r.ok, true, r.error);
  assert.ok(Array.isArray(r.usage.attempts), 'attempts must be reported');
  assert.equal(r.usage.attempts.length, 1, 'one model answered, so one attempt');
  const a = r.usage.attempts[0];
  assert.equal(a.calls, 2, 'two model calls: the tool request and the answer');
  assert.equal(a.input_tokens, 200);
  assert.equal(a.served, true);
  // The per-model parts must reconcile with the turn total, always.
  assert.equal(a.input_tokens, r.usage.input_tokens);
  assert.equal(a.output_tokens, r.usage.output_tokens);
});

test('a fallback turn keeps each model\'s tokens on its own bill', async () => {
  const cfg = require('../config');
  mode = 'fail-primary';
  failingModel = cfg.CHAT_MODELS.qwen.model;
  script = [{ content: 'The second model answered.' }];

  const r = await ask('anything');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.usage.fell_back, true, 'the turn fell back and must say so');
  assert.equal(r.usage.requested_model, cfg.CHAT_MODELS.qwen.model);
  assert.notEqual(r.usage.model, r.usage.requested_model,
    'the serving model must be distinguishable from the requested one');

  const attempts = r.usage.attempts;
  assert.equal(attempts.length, 2, 'the failed attempt is not erased from the bill');
  const [first, second] = attempts;
  assert.equal(first.model, cfg.CHAT_MODELS.qwen.model);
  assert.equal(first.served, false, 'the primary failed — it did not serve');
  assert.equal(second.served, true);
  /* The primary failed before returning usage, so it spent nothing here; the
     fallback's 300/50 must not be attributed to it either way. */
  assert.equal(second.input_tokens, 300);
  assert.equal(second.output_tokens, 50);
  assert.equal(r.usage.input_tokens, 300, 'turn total is the sum of the parts');
});

test('a turn that fails on every model still reports its attempts', async () => {
  mode = 'error';
  const r = await ask('anything');
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.usage.attempts), 'a failed turn must still be costable');
  assert.equal(r.usage.attempts.every((a) => a.served === false), true,
    'nothing served, so nothing may be marked as having served');
});
