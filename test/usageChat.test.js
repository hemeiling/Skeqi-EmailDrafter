/* ═══════════════════════════════════════════════════════════════════════════
   Analytics accounting for the AI Assistant.

   Two defects are pinned here, both of which shipped and neither of which any
   existing test could have caught, because nothing asserted on what
   recordAiEvent actually persists.

   The first: `chat` was not in the feature catalogue, so every turn was
   silently filed as `other`. The call site passed feature: 'chat' the whole
   time — recordAiEvent coerces anything it does not recognise, which is the
   right behaviour and was the wrong list.

   The second: a turn was costed at the rate of whichever model answered it.
   Inside the Bailian chain that is not a rounding error. qwen3.8-max lists at
   ten times qwen3.6-flash, so a turn that burned four tool rounds on flash and
   then fell back was billed as though max had done all of it.

   These assert the ACCOUNTING, never the prices. The rates are estimates and
   live in ai_model_pricing precisely so they can change without a deploy; a
   test that hardcoded them would have to be edited the day an invoice
   confirms one, which is exactly backwards.
   ═══════════════════════════════════════════════════════════════════════════ */
const test = require('node:test');
const assert = require('node:assert');

const dbGuard = require('./dbGuard');
const usage = require('../usage');

/* Captures the row that would have been written, instead of writing it. */
let rows = [];
usage.setPersist((row) => { rows.push(row); return Promise.resolve(); });
test.beforeEach(() => { rows = []; });

const FLASH = 'qwen3.6-flash';
const PLUS = 'qwen3.7-plus';
const MAX = 'qwen3.8-max';
const rate = (model) => usage.costFor(model, 1e6, 0, 0, 0, 'bailian');
let loaderRows = null;   // what the injected pricing loader will return

// ── the catalogue ──────────────────────────────────────────────────────────

test('chat is a feature in its own right, not "other"', () => {
  assert.ok(usage.FEATURES.includes('chat'),
    'without this the assistant files itself under "other" and cannot be reported on');
  usage.recordAiEvent({ feature: 'chat', model: FLASH, provider: 'bailian',
    input_tokens: 100, output_tokens: 20 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feature, 'chat');
});

test('an unknown feature is still coerced, so a typo cannot invent a category', () => {
  usage.recordAiEvent({ feature: 'chatt', model: FLASH, provider: 'bailian' });
  assert.equal(rows[0].feature, 'other');
});

// ── pricing the three models apart ─────────────────────────────────────────

test('the three assistant models are priced separately', () => {
  const [f, p, m] = [rate(FLASH), rate(PLUS), rate(MAX)];
  assert.ok(f < p && p < m,
    `flash ${f} < plus ${p} < max ${m} — the chain is ordered cheapest-first and pricing must reflect that`);
  assert.notEqual(f, p);
  assert.notEqual(p, m);
});

test('every assistant rate is declared an estimate until an invoice says otherwise', () => {
  for (const model of [FLASH, PLUS, MAX]) {
    assert.equal(usage.costDetail(model, 1000, 100, 0, 0, 'bailian').estimated, true,
      `${model} is priced from a published list rate, not from our Token Plan drawdown`);
  }
});

test('a confirmed rate loses the estimate label without a code change', () => {
  usage.setPricingTable([
    { provider: 'bailian', model: FLASH, input_price_per_m: 0.19, output_price_per_m: 1.13, is_estimated: false },
  ]);
  assert.equal(usage.costDetail(FLASH, 1000, 100, 0, 0, 'bailian').estimated, false);
  usage.setPricingTable(null);   // back to the seeded, estimated rates
  assert.equal(usage.costDetail(FLASH, 1000, 100, 0, 0, 'bailian').estimated, true);
});

// ── the cost of a turn that used more than one model ───────────────────────

test('a fallback turn is billed per model, not at the serving model\'s rate', () => {
  const attempts = [
    { model: FLASH, provider: 'bailian', input_tokens: 8000, output_tokens: 400, calls: 3 },
    { model: MAX, provider: 'bailian', input_tokens: 8200, output_tokens: 500, calls: 1, served: true },
  ];
  usage.recordAiEvent({
    feature: 'chat', model: MAX, provider: 'bailian', requested_model: FLASH, fell_back: true,
    input_tokens: 16200, output_tokens: 900, attempts,
  });
  const row = rows[0];

  const wholeTurnAtMax = usage.costFor(MAX, 16200, 900, 0, 0, 'bailian');
  const perModel = usage.costFor(FLASH, 8000, 400, 0, 0, 'bailian')
    + usage.costFor(MAX, 8200, 500, 0, 0, 'bailian');

  assert.ok(Math.abs(row.cost_usd - perModel) < 1e-9, 'the parts must sum to the whole');
  assert.ok(row.cost_usd < wholeTurnAtMax,
    'the flash rounds must not be billed at the max rate — that is the bug this exists to prevent');
});

test('the failed attempt is on the bill, and named as not having served', () => {
  usage.recordAiEvent({
    feature: 'chat', model: PLUS, provider: 'bailian', requested_model: FLASH, fell_back: true,
    input_tokens: 300, output_tokens: 50,
    attempts: [
      { model: FLASH, provider: 'bailian', input_tokens: 2000, output_tokens: 100, calls: 1 },
      { model: PLUS, provider: 'bailian', input_tokens: 300, output_tokens: 50, calls: 1, served: true },
    ],
  });
  const bd = rows[0].model_breakdown;
  assert.equal(bd.length, 2);
  assert.equal(bd[0].model, FLASH);
  assert.equal(bd[0].served, false, 'it was paid for and discarded — both facts matter');
  assert.equal(bd[1].served, true);
  assert.ok(bd[0].cost_usd > 0, 'tokens spent on a model that then failed are still spent');
});

test('which model was asked for survives into the row', () => {
  usage.recordAiEvent({
    feature: 'chat', model: PLUS, provider: 'bailian',
    requested_model: FLASH, requested_provider: 'bailian', fell_back: true,
    input_tokens: 10, output_tokens: 2,
  });
  assert.equal(rows[0].requested_model, FLASH);
  assert.equal(rows[0].model, PLUS);
  assert.equal(rows[0].fell_back, true);
  assert.equal(rows[0].cost_estimated, true);
});

test('a single-model turn costs exactly what it did before attempts existed', () => {
  usage.recordAiEvent({ feature: 'chat', model: FLASH, provider: 'bailian',
    input_tokens: 1200, output_tokens: 90 });
  assert.ok(Math.abs(rows[0].cost_usd - usage.costFor(FLASH, 1200, 90, 0, 0, 'bailian')) < 1e-12,
    'features that make one call must be unaffected by any of this');
});

test('a failed turn is recorded with its cost, not as free', () => {
  usage.recordAiEvent({
    feature: 'chat', model: FLASH, provider: 'bailian', status: 'error',
    error_message: 'provider exploded', input_tokens: 4000, output_tokens: 0,
    attempts: [{ model: FLASH, provider: 'bailian', input_tokens: 4000, output_tokens: 0, calls: 2 }],
  });
  assert.equal(rows[0].status, 'error');
  assert.ok(rows[0].cost_usd > 0, 'a turn that failed after spending tokens did not cost nothing');
});

/* ── the price card refreshes itself ───────────────────────────────────────
   It used to load once at boot, which made the "correct it in the table, not
   in code" promise false in practice: qwen3.6-flash's estimated flag was fixed
   in ai_model_pricing and the running instance went on recording an
   unconfirmed rate as confirmed until the service restarted.

   What matters here is not that a reload works — it is that a reload cannot
   make things worse than not reloading. A failed query, an empty result or a
   burst of concurrent events must all leave the last known card intact,
   because repricing every model at the seeded defaults is a far worse
   outcome than being a few seconds stale. */

const ROW = (est) => ([{
  provider: 'bailian', model: FLASH,
  input_price_per_m: 0.19, output_price_per_m: 1.13,
  cache_read_price_per_m: 0.019, cache_write_price_per_m: 0,
  is_estimated: est,
}]);

const withLoader = async (fn, loader) => {
  usage.setPricingLoader(loader);
  try { return await fn(); } finally {
    usage.setPricingLoader(null);
    usage.setPricingTable(null);
  }
};

test('a flag corrected in the table reaches the next event, with no restart', async () => {
  await withLoader(async () => {
    // Boot state: the rate is recorded as confirmed.
    usage.setPricingTable(ROW(false));
    assert.equal(usage.costDetail(FLASH, 1000, 100, 0, 0, 'bailian').estimated, false);

    // Someone corrects the row. The process is not restarted.
    loaderRows = ROW(true);
    await usage.refreshPricing({ force: true });

    assert.equal(usage.costDetail(FLASH, 1000, 100, 0, 0, 'bailian').estimated, true,
      'this is the whole point: the running process must see the corrected row');
    usage.recordAiEvent({ feature: 'chat', model: FLASH, provider: 'bailian',
      input_tokens: 100, output_tokens: 10 });
    assert.equal(rows.at(-1).cost_estimated, true);
  }, () => Promise.resolve(loaderRows));
});

test('a confirmed invoice price takes effect the same way', async () => {
  await withLoader(async () => {
    usage.setPricingTable(ROW(true));
    loaderRows = [{ provider: 'bailian', model: FLASH,
      input_price_per_m: 0.05, output_price_per_m: 0.25,
      cache_read_price_per_m: 0, cache_write_price_per_m: 0, is_estimated: false }];
    await usage.refreshPricing({ force: true });
    const d = usage.costDetail(FLASH, 1e6, 0, 0, 0, 'bailian');
    assert.equal(d.estimated, false, 'confirmed means confirmed');
    assert.ok(Math.abs(d.cost - 0.05) < 1e-9, 'and the new rate is the one applied');
  }, () => Promise.resolve(loaderRows));
});

test('the TTL keeps the query rate down between refreshes', async () => {
  let calls = 0;
  await withLoader(async () => {
    usage.setPricingTable(ROW(true));
    for (let i = 0; i < 25; i++) await usage.refreshPricing();
    assert.equal(calls, 0, 'a card loaded a moment ago must not be re-read 25 times');
    await usage.refreshPricing({ force: true });
    assert.equal(calls, 1);
  }, () => { calls++; return Promise.resolve(ROW(true)); });
});

test('concurrent events share one query instead of stampeding the database', async () => {
  let calls = 0;
  await withLoader(async () => {
    usage.setPricingTable(null);          // force a load
    await Promise.all(Array.from({ length: 10 }, () => usage.refreshPricing({ force: true })));
    assert.equal(calls, 1, '10 simultaneous refreshes must issue one query, not ten');
  }, () => { calls++; return new Promise((r) => setTimeout(() => r(ROW(true)), 20)); });
});

test('a failed query keeps the last known card rather than blanking it', async () => {
  await withLoader(async () => {
    usage.setPricingTable(ROW(false));
    const before = usage.costFor(FLASH, 1e6, 0, 0, 0, 'bailian');
    await usage.refreshPricing({ force: true });     // the loader throws
    const after = usage.costFor(FLASH, 1e6, 0, 0, 0, 'bailian');
    assert.equal(after, before, 'a database blip must not silently reprice every model');
    assert.equal(usage.costDetail(FLASH, 1e6, 0, 0, 0, 'bailian').estimated, false);
  }, () => Promise.reject(new Error('connection reset')));
});

test('an empty result is treated as a failed read, not as "no prices exist"', async () => {
  await withLoader(async () => {
    usage.setPricingTable(ROW(false));
    await usage.refreshPricing({ force: true });
    assert.equal(usage.costDetail(FLASH, 1e6, 0, 0, 0, 'bailian').estimated, false,
      'an empty table and a broken query look identical, and both mean "keep what we have"');
  }, () => Promise.resolve([]));
});

test('with no loader registered, everything behaves exactly as before', async () => {
  usage.setPricingLoader(null);
  usage.setPricingTable(null);
  assert.equal(await usage.refreshPricing({ force: true }), false);
  // The seeded card still answers, so drafting and research are unaffected.
  assert.ok(usage.costFor('claude-sonnet-5', 1e6, 0, 0, 0, 'anthropic') > 0);
  assert.equal(usage.costDetail('claude-sonnet-5', 1000, 10, 0, 0, 'anthropic').estimated, false,
    'a confirmed vendor list price must not become an estimate because of this change');
});

test('recording an event never waits on the price card', async () => {
  let started = false;
  let resolveIt = null;
  usage.setPricingLoader(() => { started = true; return new Promise((r) => { resolveIt = r; }); });
  usage.setPricingTable(null);

  /* A loader that never settles. If recordAiEvent awaited it — or even ran it
     synchronously — this line could not return a cost. */
  const out = usage.recordAiEvent({ feature: 'chat', model: FLASH, provider: 'bailian',
    input_tokens: 10, output_tokens: 1 });
  assert.equal(typeof out.cost_usd, 'number', 'the cost must come back without waiting');
  assert.equal(started, false, 'the query is not even issued on the caller\'s stack');

  await new Promise((r) => setImmediate(r));
  assert.equal(started, true, 'it does run, just not in the caller\'s path');
  if (resolveIt) resolveIt(ROW(true));
  await new Promise((r) => setImmediate(r));
  usage.setPricingLoader(null);
  usage.setPricingTable(null);
});
