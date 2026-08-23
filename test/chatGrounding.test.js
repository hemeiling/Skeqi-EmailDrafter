/* ═══════════════════════════════════════════════════════════════════════════
   The orchestration failure of 2026-08-23, and the six layers that answer it.

   A user asked "多少家公司去展会" and was shown this:

       <tool_call>
       <function=get_exhibitor_list>
       </function>
       </tool_call>

   Six defects interacted. There was no tool that could answer a global count,
   so the model reached for one it wished we had. qwen3.6-flash spent the whole
   turn's tool budget on six different category lists. The budget was shared
   across the fallback chain but the EVIDENCE was not, so qwen3.7-plus began
   the same question with no tool results and no tool calls left — and the loop
   responded to an exhausted budget by removing the tools array, which is the
   exact input that makes these models write protocol into prose. The grounding
   guard let it through because six tools had run, somewhere, earlier. And when
   the same question did not leak, it answered "19 + 25 + 25 + 25 = 94" by
   summing capped lists whose "count" was the page size — the real figure is
   984, and three of those 25s were 488, 67 and 53.

   These tests are written against the stub endpoint, because the interesting
   cases are the ones where a model misbehaves, and a real model cannot be
   asked to misbehave on cue. The live behaviour is verified separately.
   ═══════════════════════════════════════════════════════════════════════════ */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const dbGuard = require('./dbGuard');
const chat = require('../chat');
const config = require('../config');

let server; let baseUrl;
let script = [];          // queued replies, consumed in order
let received = [];
let byModel = {};         // model name → queued replies, for fallback scenarios

test.before(async () => {
  /* The tools run for real against the test database, so the schema has to
     exist. Only the MODEL is stubbed here — stubbing the tools too would test
     the orchestration against a fiction, and the bug being fixed lives in the
     seam between the two. */
  if (dbGuard.available) await require('../db').initDb();

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
      received.push(parsed);

      const model = parsed && parsed.model;
      const queue = (byModel[model] && byModel[model].length) ? byModel[model] : script;
      const next = queue.shift() || { content: 'No more script.' };

      if (next.status && next.status >= 400) {
        res.writeHead(next.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'stub failure' }));
      }
      const message = next.tool_calls
        ? { role: 'assistant', content: null, tool_calls: next.tool_calls }
        : { role: 'assistant', content: next.content };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model, choices: [{ message, finish_reason: next.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  for (const id of Object.keys(config.CHAT_MODELS)) {
    config.CHAT_MODELS[id].baseUrl = baseUrl;
    config.CHAT_MODELS[id].apiKey = 'stub-key';
  }
});
test.after(async () => { if (server) await new Promise((r) => server.close(r)); });
test.beforeEach(() => { script = []; received = []; byModel = {}; });

const ask = (content) => chat.runChat({ messages: [{ role: 'user', content }] });
const call = (name, args, id) => ([{ id: id || 'c1', type: 'function',
  function: { name, arguments: JSON.stringify(args || {}) } }]);
const PROTOCOL = /<tool_call>|<\/tool_call>|<function\s*=/i;
const FLASH = config.CHAT_MODELS.qwen.model;
const PLUS = config.CHAT_MODELS.qwen_fallback_1.model;

// ── LAYER 5: protocol never reaches a user ─────────────────────────────────

const LEAKS = [
  ['angle-bracket form', '<tool_call>\n<function=get_exhibitor_list>\n</function>\n</tool_call>'],
  ['json-in-tags form', '<tool_call>{"name": "get_exhibitor_list", "args": {}}</tool_call>'],
  ['bare json form', '{"name": "get_exhibitor_list", "arguments": {}}'],
  ['prose then protocol', '我需要查询参展商列表。\n\n<tool_call>{"name":"get_exhibitor_count"}</tool_call>'],
];

for (const [label, leak] of LEAKS) {
  test(`protocol guard: ${label} never becomes an answer`, async () => {
    script = [{ content: leak }, { content: leak }, { content: leak },
      { content: leak }, { content: leak }, { content: leak }];
    const r = await ask('多少家公司去展会');
    assert.ok(!PROTOCOL.test(r.reply || ''), `protocol reached the user: ${r.reply}`);
    assert.ok(!/get_exhibitor_list|get_exhibitor_count/.test(r.reply || ''),
      'an invented tool name reached the user');
  });
}

test('protocol guard: a leak is retried with the structured channel forced', async () => {
  script = [
    { content: '<tool_call>{"name":"get_exhibitor_list"}</tool_call>' },
    { tool_calls: call('get_event_attendance_summary', {}) },
    { content: '984 exhibitors are listed.' },
  ];
  const r = await ask('How many companies are going to the show?');
  assert.equal(r.ok, true, r.error);
  assert.match(r.reply, /984/);
  assert.equal(received.filter((b) => b && b.tool_choice === 'required').length, 1,
    'the leak should force exactly one structured retry');
});

// ── LAYER 3: budgets, and tools that stay attached ─────────────────────────

test('tools stay attached even when the budget is spent', async () => {
  // Seven tool calls requested; the allowance is five.
  script = Array.from({ length: 7 }, (_, i) => ({ tool_calls: call('search_companies', { query: 'q' + i }, 'c' + i) }))
    .concat([{ content: 'Here is what I found.' }]);
  await ask('Which competitors are exhibiting?');
  const withoutTools = received.filter((b) => b && !b.tools);
  assert.equal(withoutTools.length, 0,
    'every request must carry the tool schema — withdrawing it is what produced the leak');
});

test('execution is what runs out, and the model is told so', async () => {
  script = Array.from({ length: 8 }, (_, i) => ({ tool_calls: call('search_companies', { query: 'q' + i }, 'c' + i) }))
    .concat([{ content: 'Answering with what I have.' }]);
  const r = await ask('Which competitors are exhibiting?');
  /* toolCalls is turn-wide, so the ceiling is what bounds it. The PER-MODEL
     allowance is asserted from the attempt record, which is where the
     distinction actually lives — and which Analytics now carries too. */
  assert.ok(r.toolCalls.length <= config.CHAT_TURN_TOOL_CEILING,
    `turn ceiling is ${config.CHAT_TURN_TOOL_CEILING}, ran ${r.toolCalls.length}`);
  const primary = r.usage.attempts[0];
  assert.ok(primary.tools_executed <= config.CHAT_MAX_TOOL_CALLS,
    `primary allowance is ${config.CHAT_MAX_TOOL_CALLS}, it executed ${primary.tools_executed}`);
  for (const a of r.usage.attempts.slice(1)) {
    assert.ok(a.tools_executed <= config.CHAT_FALLBACK_TOOL_CALLS,
      `fallback allowance is ${config.CHAT_FALLBACK_TOOL_CALLS}, ${a.model} executed ${a.tools_executed}`);
  }
  const refusals = JSON.stringify(received).match(/no further lookups are available/g) || [];
  assert.ok(refusals.length > 0, 'the model must be told why, not silently ignored');
});

test('a fallback gets a working budget, not the loser\'s exhaustion', async () => {
  byModel[FLASH] = Array.from({ length: 6 }, (_, i) =>
    ({ tool_calls: call('search_companies', { query: 'q' + i }, 'f' + i) }))
    .concat([{ status: 500 }]);
  byModel[PLUS] = [
    { tool_calls: call('get_event_attendance_summary', {}) },
    { content: '984 exhibitors are listed for the show.' },
  ];
  const r = await ask('How many companies are going to the show?');
  assert.equal(r.ok, true, r.error);
  assert.match(r.reply, /984/);
  const plusReqs = received.filter((b) => b && b.model === PLUS);
  assert.ok(plusReqs.length > 0 && plusReqs.every((b) => b.tools && b.tools.length),
    'the fallback must be offered tools — it was offered none in production');
});

test('the turn ceiling bounds the whole turn, across models', async () => {
  byModel[FLASH] = Array.from({ length: 6 }, (_, i) =>
    ({ tool_calls: call('search_companies', { query: 'a' + i }, 'f' + i) })).concat([{ status: 500 }]);
  byModel[PLUS] = Array.from({ length: 6 }, (_, i) =>
    ({ tool_calls: call('search_companies', { query: 'b' + i }, 'p' + i) }))
    .concat([{ content: 'Done.' }]);
  const r = await ask('Which competitors are exhibiting?');
  assert.ok(r.toolCalls.length <= config.CHAT_TURN_TOOL_CEILING,
    `turn ceiling is ${config.CHAT_TURN_TOOL_CEILING}, ran ${r.toolCalls.length}`);
});

test('evidence crosses into the fallback so it does not start empty', async () => {
  byModel[FLASH] = [
    { tool_calls: call('get_event_attendance_summary', {}) },
    { status: 500 },
  ];
  byModel[PLUS] = [{ content: 'Based on the exhibitor data, 984 are listed.' }];
  const r = await ask('多少家公司去展会');
  assert.equal(r.ok, true, r.error);
  const plusReq = received.find((b) => b && b.model === PLUS);
  const carried = JSON.stringify(plusReq.messages);
  assert.match(carried, /ALREADY RETRIEVED THIS TURN/,
    'the fallback must inherit the turn\'s evidence, not just its budget');
});

// ── LAYER 3: unknown tools and repetition ──────────────────────────────────

test('an unknown tool name is never echoed back into the model\'s context', async () => {
  script = [
    { tool_calls: call('get_exhibitor_list', {}) },
    { tool_calls: call('get_event_attendance_summary', {}) },
    { content: '984 exhibitors are listed.' },
  ];
  const r = await ask('How many companies are going to the show?');
  assert.equal(r.ok, true, r.error);
  const transcript = JSON.stringify(received);
  assert.ok(!/get_exhibitor_list/.test(transcript.split('"tools"')[0] || ''),
    'the invented name must not be repeated back as a tool result');
  assert.ok(!/get_exhibitor_list/.test(r.reply), 'nor reach the user');
});

test('identical repeated calls are answered but not re-executed', async () => {
  const same = { query: 'CATL' };
  script = [
    { tool_calls: call('search_companies', same, 'a') },
    { tool_calls: call('search_companies', same, 'b') },
    { tool_calls: call('search_companies', same, 'c') },
    { content: 'Found it.' },
  ];
  const r = await ask('Have we emailed CATL?');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.toolCalls.length, 1,
    `the same call with the same arguments should execute once, ran ${r.toolCalls.length}`);
});

test('different arguments are a different question, so pagination still works', async () => {
  script = [
    { tool_calls: call('search_companies', { query: 'a', limit: 25 }, 'a') },
    { tool_calls: call('search_companies', { query: 'a', limit: 50 }, 'b') },
    { content: 'Both pages read.' },
  ];
  const r = await ask('Which competitors are exhibiting?');
  assert.equal(r.toolCalls.length, 2, 'deduplication must not block legitimate paging');
});

// ── LAYER 4: grounding belongs to the attempt that answered ────────────────

test('a discarded attempt\'s tool calls do not ground the fallback\'s answer', async () => {
  byModel[FLASH] = [
    { tool_calls: call('list_companies_by_category', { category: 'competitor' }) },
    { status: 500 },
  ];
  /* plus answers immediately, from nothing it fetched. The evidence carried
     over is what may ground it — never the bare fact that flash called
     something before failing. */
  byModel[PLUS] = [{ content: 'There are about 94 companies at the show.' }];
  const r = await ask('多少家公司去展会');
  const grounded = /ALREADY RETRIEVED/.test(JSON.stringify(
    received.find((b) => b && b.model === PLUS) || {}));
  assert.ok(grounded || r.refused,
    'the fallback answered a factual question with neither evidence nor a refusal');
});

test('a factual question with no successful tool result is refused', async () => {
  script = [{ content: 'There are 94 companies.' }, { content: 'There are 94 companies.' },
    { content: 'There are 94 companies.' }];
  const r = await ask('How many companies are going to the show?');
  assert.equal(r.refused, true, 'an ungrounded factual answer must not be returned');
  assert.ok(!/94/.test(r.reply), 'and the invented figure must not survive');
});

test('a failed tool result does not count as grounding', async () => {
  script = [
    { tool_calls: call('get_company_profile', { company_id: 999999999 }) },
    { content: 'There are 94 companies at the show.' },
    { content: 'There are 94 companies at the show.' },
  ];
  const r = await ask('How many companies are going to the show?');
  if (!r.refused) {
    assert.ok(r.toolCalls.some((t) => t.ok),
      'the answer was allowed through on a tool call that failed');
  }
});

// ── LAYER 6: provenance ────────────────────────────────────────────────────

test('provenance is user-facing, deduplicated, and only successful sources', () => {
  const out = chat.provenance([
    { name: 'get_event_attendance_summary', ok: true },
    { name: 'list_companies_by_category', ok: true },
    { name: 'list_companies_by_category', ok: true },
    { name: 'search_companies', ok: true },
    { name: 'get_booth_occupant', ok: false },
  ]);
  assert.deepEqual(out, ['Official Exhibitor Data', 'Booth Map', 'CRM']);
  assert.ok(!JSON.stringify(out).includes('_'), 'no internal name may appear');
});

test('every registered tool has a user-facing source label', () => {
  const chatTools = require('../chatTools');
  const missing = chatTools.toolSchemas()
    .map((t) => t.function.name)
    .filter((n) => !chat.TOOL_SOURCES[n]);
  assert.deepEqual(missing, [], `tools with no source label: ${missing.join(', ')}`);
});

test('an answer that names a tool is retried before being shown', async () => {
  script = [
    { tool_calls: call('get_event_attendance_summary', {}) },
    { content: 'I ran get_event_attendance_summary and found 984.' },
    { content: '984 exhibitors are listed, from the official exhibitor list.' },
  ];
  const r = await ask('How many companies are going to the show?');
  assert.ok(!/get_event_attendance_summary/.test(r.reply),
    `an internal name reached the user: ${r.reply}`);
  assert.match(r.reply, /984/);
});

// ── the original failure, both languages ───────────────────────────────────

for (const [label, question] of [
  ['Chinese', '多少家公司去展会'],
  ['Chinese with punctuation', '多少家公司去展会？'],
  ['English', 'How many companies are going to the show?'],
  ['English variant', 'How many exhibitors are attending The Battery Show?'],
]) {
  test(`${label}: the exact production failure cannot recur`, async () => {
    // A model that behaves exactly as production did.
    script = Array.from({ length: 6 }, (_, i) =>
      ({ tool_calls: call('list_companies_by_category', { category: 'c' + i }, 'x' + i) }))
      .concat([
        { content: '<tool_call>\n<function=get_exhibitor_list>\n</function>\n</tool_call>' },
        { content: '<tool_call>\n<function=get_exhibitor_list>\n</function>\n</tool_call>' },
        { content: '共有 94 家公司参展。' },
      ]);
    const r = await ask(question);
    assert.ok(!PROTOCOL.test(r.reply || ''), `protocol leaked: ${r.reply}`);
    assert.ok(!/get_exhibitor_list/.test(r.reply || ''), 'invented tool name leaked');
    assert.ok(!/\b94\b/.test(r.reply || ''),
      `the fabricated total survived: ${r.reply}`);
  });
}

test('19 + 25 + 25 + 25 = 94 is never accepted as an attendance total', async () => {
  /* Every step here is individually legitimate: real tools, real results,
     genuinely grounded. The aggregation is what is invalid — the categories
     overlap and the lists are capped. Grounding alone cannot catch this, which
     is why a global count must come from the one source that knows. */
  script = [
    { tool_calls: call('list_companies_by_category', { category: 'competitor' }, 'a') },
    { tool_calls: call('list_companies_by_category', { category: 'target_customer' }, 'b') },
    { content: '19 + 25 + 25 + 25 = 94 家公司参展。' },
    { content: '19 + 25 + 25 + 25 = 94 家公司参展。' },
    { content: '19 + 25 + 25 + 25 = 94 家公司参展。' },
  ];
  const r = await ask('多少家公司去展会');
  assert.ok(!/\b94\b/.test(r.reply || ''),
    `a sum of overlapping capped lists was returned as the attendance total: ${r.reply}`);
  assert.equal(r.refused, true, 'without the canonical source it must refuse, not improvise');
});

test('a global count answered from the canonical source is allowed through', async () => {
  script = [
    { tool_calls: call('get_event_attendance_summary', {}) },
    { content: '984 exhibitors are listed; 983 have booths and 1 does not.' },
  ];
  const r = await ask('How many companies are going to the show?');
  assert.equal(r.ok, true, r.error);
  assert.ok(!r.refused, 'the canonical source is exactly what should satisfy this');
  assert.match(r.reply, /984/);
  assert.deepEqual(r.sources, ['Official Exhibitor Data']);
});

test('a per-company count is NOT forced down the global-count path', async () => {
  script = [
    { tool_calls: call('search_companies', { query: 'CATL' }) },
    { content: 'We have 3 contacts for CATL.' },
  ];
  const r = await ask('How many contacts do we have for CATL?');
  assert.ok(!r.refused, 'this is a scoped question and must not require the event summary');
  assert.match(r.reply, /3 contacts/);
});

test('the prompt forbids summing categories and names the canonical tool', () => {
  assert.match(chat.SYSTEM_PROMPT, /get_event_attendance_summary/);
  assert.match(chat.SYSTEM_PROMPT, /NEVER add up category lists/i);
  assert.match(chat.SYSTEM_PROMPT, /truncated: true is a PAGE/);
});
