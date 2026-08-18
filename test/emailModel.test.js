/* Email drafting runs on Qwen 3.6 Flash by default, with GPT and Claude
   selectable and used as fallback; research stays on Claude.

   These tests pin the split itself — which vendor is called, and that each
   one's tokens are costed with its own price card. Both endpoints are local
   stubs, so the suite needs no API keys and spends nothing.

   Env is set before requiring anything: config.js reads process.env once, at
   module load, and every other module imports from it. */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

let openaiServer, claudeServer, bailianServer;
const calls = { openai: [], claude: [], bailian: [] };

function stub(handler) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(JSON.parse(body || '{}'), res));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test.before(async () => {
  openaiServer = stub((body, res) => {
    calls.openai.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ subject: 'Hello from Luna', body: 'Draft body.', followup: '', rationale: 'test' }) } }],
      // prompt_tokens includes cached tokens, as the real API reports it.
      usage: {
        prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500,
        prompt_tokens_details: { cached_tokens: 200 },
        completion_tokens_details: { reasoning_tokens: 120 },
      },
    }));
  });
  claudeServer = stub((body, res) => {
    calls.claude.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      content: [{ text: JSON.stringify({ subject: 'Hello from Claude', body: 'Draft body.', followup: '', rationale: 'test' }) }],
      usage: { input_tokens: 1000, output_tokens: 500 },
    }));
  });

  const [op, cp] = [await listen(openaiServer), await listen(claudeServer)];
  process.env.OPENAI_CHAT_URL = `http://127.0.0.1:${op}/v1/chat/completions`;
  process.env.CLAUDE_MESSAGES_URL = `http://127.0.0.1:${cp}/v1/messages`;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.CLAUDE_API_KEY = 'test-claude-key';

  bailianServer = stub((body, res) => {
    calls.bailian.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ subject: 'Hello from Qwen', body: 'Draft body.', followup: '', rationale: 'test' }) } }],
      usage: { prompt_tokens: 900, completion_tokens: 220, prompt_tokens_details: { cached_tokens: 100 } },
    }));
  });
  process.env.BAILIAN_BASE_URL = `http://127.0.0.1:${await listen(bailianServer)}/compatible-mode/v1/chat/completions`;
  process.env.BAILIAN_API_KEY = 'test-bailian-key';
  process.env.BAILIAN_EMAIL_MODEL = 'qwen3.6-flash';
});

test.after(async () => {
  await new Promise((r) => openaiServer.close(r));
  await new Promise((r) => claudeServer.close(r));
  await new Promise((r) => bailianServer.close(r));
});

const freshConfig = () => {
  for (const m of ['../config', '../emailModel', '../claude']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
  return { cfg: require('../config'), em: require('../emailModel') };
};

test('Qwen 3.6 Flash is the default email drafting model', async () => {
  const { cfg, em } = freshConfig();
  calls.bailian.length = 0; calls.openai.length = 0; calls.claude.length = 0;
  assert.equal(cfg.DEFAULT_EMAIL_MODEL_ID, 'qwen');
  const r = await em.runEmailModel('draft something', { json: true });
  assert.equal(calls.bailian.length, 1, 'Bailian should serve the default');
  assert.equal(calls.openai.length, 0);
  assert.equal(calls.claude.length, 0);
  assert.equal(calls.bailian[0].model, 'qwen3.6-flash');
  assert.equal(r.usage.provider, 'bailian');
  assert.equal(r.fell_back, false);
});

test('each provider gets its own request dialect', async () => {
  const { em } = freshConfig();
  calls.bailian.length = 0; calls.openai.length = 0;
  await em.runEmailModel('x', { json: true });
  const q = calls.bailian[0];
  // Qwen speaks plain max_tokens and has no concept of reasoning_effort.
  assert.ok(q.max_tokens > 0, 'Qwen must receive max_tokens');
  assert.equal(q.max_completion_tokens, undefined, 'Qwen must not receive the OpenAI-only field');
  assert.equal(q.reasoning_effort, undefined, 'Qwen must not receive reasoning_effort');

  await em.runEmailModel('x', { json: true, modelId: 'gpt' });
  const g = calls.openai[0];
  assert.ok(g.max_completion_tokens > 0, 'GPT must receive max_completion_tokens');
  assert.equal(g.max_tokens, undefined, 'GPT must not receive the deprecated field');
  assert.equal(g.reasoning_effort, 'low');
});

test('fallback chains follow the specified order', () => {
  const { cfg } = freshConfig();
  assert.deepEqual(cfg.emailProviderChain('qwen'), ['qwen', 'gpt', 'claude']);
  assert.deepEqual(cfg.emailProviderChain('gpt'), ['gpt', 'claude', 'qwen']);
  assert.deepEqual(cfg.emailProviderChain('claude'), ['claude', 'gpt', 'qwen']);
});

test('unconfigured providers are dropped from the chain, never attempted', () => {
  const saved = process.env.OPENAI_API_KEY;
  // Emptied, not deleted: config.js calls dotenv on every fresh require, and
  // dotenv repopulates a DELETED key straight from the real .env — which
  // silently un-does the very condition under test.
  process.env.OPENAI_API_KEY = '';
  const { cfg } = freshConfig();
  assert.deepEqual(cfg.emailProviderChain('qwen'), ['qwen', 'claude'], 'GPT must not appear without a key');
  assert.ok(!cfg.listEmailModelChoices().some((c) => c.value === 'gpt'));
  process.env.OPENAI_API_KEY = saved;
  freshConfig();
});

test('a user selection is honoured and reaches the shared abstraction', async () => {
  const { em } = freshConfig();
  calls.bailian.length = 0; calls.claude.length = 0;
  const r = await em.runEmailModel('x', { json: true, modelId: 'claude' });
  assert.equal(calls.claude.length, 1, 'Claude should serve when selected');
  assert.equal(calls.bailian.length, 0, 'Qwen must not run when Claude is selected');
  assert.equal(r.usage.provider, 'anthropic');
});

test('a Qwen failure falls back and the event records BOTH providers', async () => {
  const failing = stub((body, res) => { calls.bailian.push(body); res.writeHead(500).end('bailian down'); });
  const port = await listen(failing);
  const savedUrl = process.env.BAILIAN_BASE_URL;
  process.env.BAILIAN_BASE_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
  const { em } = freshConfig();
  calls.bailian.length = 0; calls.openai.length = 0;

  const r = await em.runEmailModel('x', { json: true });
  assert.equal(calls.bailian.length, 1, 'Qwen was attempted');
  assert.equal(calls.openai.length, 1, 'GPT picked it up');
  assert.ok(r.ok);
  assert.equal(r.usage.provider, 'openai', 'usage names who actually ran');
  assert.equal(r.requested_provider, 'bailian', 'and who was asked');
  assert.equal(r.fell_back, true, 'so Analytics can count fallbacks');

  process.env.BAILIAN_BASE_URL = savedUrl;
  freshConfig();
  await new Promise((res) => failing.close(res));
});

test('bailian is priced as itself, never with another vendor card', () => {
  const { costFor } = require('../usage');
  const qwen = costFor('qwen3.6-flash', 1_000_000, 0, 0, 0, 'bailian');
  assert.ok(Math.abs(qwen - 0.19) < 1e-9, `expected $0.19/M input, got ${qwen}`);
  assert.notEqual(costFor('qwen3.6-flash', 1e6, 0, 0, 0, 'bailian'), costFor('claude-sonnet-4-6', 1e6, 0, 0, 0, 'anthropic'));
  // An unknown bailian model must not inherit Anthropic's default.
  assert.equal(costFor('qwen-does-not-exist', 1e6, 0, 0, 0, 'bailian'), 0.19);
});

test('the model choices sent to the browser expose no configuration', () => {
  const { cfg } = freshConfig();
  const json = JSON.stringify(cfg.listEmailModelChoices());
  assert.ok(!/key|http|endpoint|bailian|dashscope|aliyun|compatible/i.test(json), `leaked config: ${json}`);
  assert.deepEqual(cfg.listEmailModelChoices().map((c) => c.label), ['Qwen 3.6 Flash', 'GPT', 'Claude']);
});

test('Account Research is untouched: its model is still a hardcoded Claude constant', () => {
  const fs = require('node:fs');
  const ar = fs.readFileSync(require.resolve('../accountResearch.js'), 'utf8');
  const rs = fs.readFileSync(require.resolve('../research.js'), 'utf8');
  assert.ok(/const DEFAULT_MODEL = 'claude-sonnet-4-6'/.test(ar), 'accountResearch must keep its literal model');
  assert.ok(/const RESEARCH_MODEL = 'claude-sonnet-4-6'/.test(rs), 'research must keep its literal model');
  // And neither may reach into the email provider layer.
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [n, src] of [['accountResearch.js', ar], ['research.js', rs]]) {
    assert.ok(!/emailModel|bailian|qwen/i.test(strip(src)), `${n} must not reference the email model layer`);
  }
});

test('drafting goes to Qwen by default, and to GPT when GPT is selected', async () => {
  freshConfig();
  calls.bailian.length = 0; calls.openai.length = 0; calls.claude.length = 0;
  const { draftEmail } = require('../claude');

  const def = await draftEmail({ name: 'Ada', company: 'Acme' }, { name: 'Mei' }, 'cold_outreach', {});
  assert.equal(calls.bailian.length, 1, 'Qwen serves the default');
  assert.equal(calls.openai.length, 0);
  assert.equal(calls.claude.length, 0);
  assert.equal(def.subject, 'Hello from Qwen');
  assert.equal(def._usage.provider, 'bailian');
  assert.equal(def._usage.model, 'qwen3.6-flash');

  // The selection travels in draft options, through the shared abstraction.
  const picked = await draftEmail({ name: 'Ada' }, { name: 'Mei' }, 'cold_outreach', { options: { modelId: 'gpt' } });
  assert.equal(calls.openai.length, 1, 'GPT serves when selected');
  assert.equal(picked._usage.provider, 'openai');
  assert.equal(picked._usage.model, 'gpt-5.6-luna');
});

test('the OpenAI request uses the parameters GPT-5.6 requires', async () => {
  freshConfig();
  calls.openai.length = 0;
  const { draftEmail } = require('../claude');
  await draftEmail({ name: 'Ada' }, { name: 'Mei' }, 'cold_outreach', { options: { modelId: 'gpt' } });
  const sent = calls.openai[0];

  // max_tokens is deprecated and rejected by the GPT-5 family.
  assert.ok(sent.max_completion_tokens > 0, 'must send max_completion_tokens');
  assert.equal(sent.max_tokens, undefined, 'must not send the deprecated max_tokens');
  assert.equal(sent.reasoning_effort, 'low');
  assert.deepEqual(sent.response_format, { type: 'json_object' });
  assert.equal(sent.messages.length, 1);
  assert.equal(sent.messages[0].role, 'user');
});

test('cached prompt tokens are not double-counted as input', async () => {
  freshConfig();
  calls.openai.length = 0;
  const { draftEmail } = require('../claude');
  const draft = await draftEmail({ name: 'Ada' }, { name: 'Mei' }, 'cold_outreach', { options: { modelId: 'gpt' } });
  const u = draft._usage;

  // OpenAI's prompt_tokens (1000) INCLUDES the 200 cached; Anthropic reports
  // them separately. Normalising to Anthropic's meaning keeps one cost formula
  // correct for both — otherwise cached tokens bill at 10x their real rate.
  assert.equal(u.input_tokens, 800, 'input must exclude cached tokens');
  assert.equal(u.cache_read_tokens, 200);
  assert.equal(u.output_tokens, 500, 'output already includes reasoning tokens');
  assert.equal(u.reasoning_tokens, 120);
});

test('each provider is costed with its own price card, never the other one', () => {
  const { costFor } = require('../usage');

  // Luna: $0.20/M in, $1.20/M out, $0.02/M cached.
  const luna = costFor('gpt-5.6-luna', 800, 500, 200, 0, 'openai');
  assert.ok(Math.abs(luna - (0.00016 + 0.0006 + 0.000004)) < 1e-9, `unexpected Luna cost ${luna}`);

  // Sonnet: $3/M in, $15/M out — unchanged.
  const sonnet = costFor('claude-sonnet-4-6', 1000, 500, 0, 0, 'anthropic');
  assert.ok(Math.abs(sonnet - (0.003 + 0.0075)) < 1e-9, `unexpected Sonnet cost ${sonnet}`);

  // The regression this guards: same model name, wrong provider must not
  // silently inherit the other's rate.
  assert.notEqual(costFor('gpt-5.6-luna', 1000, 500, 0, 0, 'openai'),
                  costFor('claude-sonnet-4-6', 1000, 500, 0, 0, 'anthropic'));
  assert.ok(luna < sonnet / 10, 'Luna must be far cheaper than Sonnet for the same work');
});

test('an unpriced model falls back within its own provider, not across', () => {
  const { costFor } = require('../usage');
  const unknownOpenAi = costFor('gpt-does-not-exist', 1_000_000, 0, 0, 0, 'openai');
  const unknownClaude = costFor('claude-does-not-exist', 1_000_000, 0, 0, 0, 'anthropic');

  assert.equal(unknownOpenAi, 0.20, 'unknown OpenAI model must use the OpenAI default');
  assert.equal(unknownClaude, 3.00, 'unknown Claude model must use the Anthropic default');
});

test('research keeps its own Claude model and never touches the OpenAI path', () => {
  // Read as source: requiring accountResearch.js pulls in the DB layer.
  // Comments are stripped first — both files explain in prose why they stay
  // on Claude, and prose must not fail a check about code.
  const fs = require('node:fs');
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of ['../research.js', '../accountResearch.js']) {
    const src = stripComments(fs.readFileSync(require.resolve(file), 'utf8'));
    assert.ok(!/emailModel|openai|OPENAI/i.test(src), `${file} must not reference the OpenAI email path`);
    assert.ok(/claude-sonnet-4-6/.test(src), `${file} must still pin claude-sonnet-4-6`);
  }
  // Research reads no config from the email path at all — the isolation is
  // that these files and config.js share nothing.
  const { cfg } = freshConfig();
  assert.equal(cfg.RESEARCH_ROUTING, undefined, 'email config must not carry research routing');
});

test('drafting falls back when the default provider is unconfigured', async (t) => {
  // config.js caches env at load, so exercise the dispatcher directly with a
  // fresh module registry rather than mutating the loaded config.
  const savedB = process.env.BAILIAN_API_KEY, savedO = process.env.OPENAI_API_KEY;
  process.env.BAILIAN_API_KEY = '';   // emptied, not deleted — see note above
  process.env.OPENAI_API_KEY = '';

  calls.bailian.length = 0; calls.openai.length = 0; calls.claude.length = 0;
  const { em } = freshConfig();
  const r = await em.runEmailModel('draft something', { json: true });

  assert.equal(calls.bailian.length, 0, 'Qwen must not be called without a key');
  assert.equal(calls.openai.length, 0, 'GPT must not be called without a key');
  assert.equal(calls.claude.length, 1, 'Claude should serve the request instead');
  assert.equal(r.usage.provider, 'anthropic', 'usage must name the provider that actually ran');
  assert.equal(em.activeEmailModel().provider, 'anthropic');

  process.env.BAILIAN_API_KEY = savedB; process.env.OPENAI_API_KEY = savedO;
  freshConfig();
});

test('a GPT error falls back to Claude and is billed as Claude', async () => {
  const failing = stub((body, res) => {
    calls.openai.push(body);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('upstream exploded');
  });
  const port = await listen(failing);
  const savedUrl = process.env.OPENAI_CHAT_URL;
  process.env.OPENAI_CHAT_URL = `http://127.0.0.1:${port}/v1/chat/completions`;

  calls.openai.length = 0; calls.claude.length = 0; calls.bailian.length = 0;
  const { em } = freshConfig();
  // GPT selected → GPT → Claude → Qwen, so Claude catches it before Qwen.
  const r = await em.runEmailModel('draft something', { json: true, modelId: 'gpt' });

  assert.equal(calls.openai.length, 1, 'GPT was attempted');
  assert.equal(calls.claude.length, 1, 'and Claude picked it up');
  assert.equal(calls.bailian.length, 0, 'Qwen is last in the GPT chain and not needed');
  assert.ok(r.ok);
  // A fallback must be priced as what ran, or a broken provider would be
  // reported at the cheap rate while billing the expensive one.
  assert.equal(r.usage.provider, 'anthropic');
  assert.equal(r.requested_provider, 'openai');
  assert.equal(r.fell_back, true);

  process.env.OPENAI_CHAT_URL = savedUrl;
  freshConfig();
  await new Promise((res) => failing.close(res));
});
