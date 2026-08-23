/* ═══════════════════════════════════════════════════════════════════════════
   The Analytics queries behind the AI Assistant panel, run against real
   Postgres (PGlite, in-process).

   These are here because the interesting part is SQL semantics, not
   JavaScript: aiChatByModel has to attribute cost from a JSONB array of
   per-model parts for rows that have one, AND from the flat columns for rows
   that do not — every event written before model_breakdown existed, and every
   turn that only ever called one model. Getting that wrong in either
   direction double-counts or drops real money, and neither shows up as an
   error; it shows up as a number that is quietly wrong.

   The query text is imported from db.js rather than retyped, so this cannot
   pass against a copy that has drifted from what the server runs.
   ═══════════════════════════════════════════════════════════════════════════ */
const test = require('node:test');
const assert = require('node:assert');

const dbGuard = require('./dbGuard');
const { CHAT_SUMMARY_SQL, CHAT_BY_MODEL_SQL } = require('../db');

const PGLITE = '/Users/meilinghe/Downloads/rich-habits/node_modules/@electric-sql/pglite/dist/index.js';
let PGlite = null;
try { ({ PGlite } = require(PGLITE)); } catch { /* reported below */ }

/* Only the columns these two queries read. A narrower table than production's
   on purpose: if a query starts depending on a column that is not here, that
   is worth finding out in a test rather than in the dashboard. */
const SCHEMA = `
  create table ai_usage_events (
    id serial primary key,
    feature text not null,
    status text default 'success',
    model text, provider text,
    requested_model text, fell_back boolean default false,
    input_tokens integer default 0, output_tokens integer default 0,
    reasoning_tokens integer default 0,
    cost_usd numeric default 0,
    cost_estimated boolean default false,
    model_breakdown jsonb,
    response_ms integer,
    created_at timestamptz default now());
`;

async function freshDb() {
  const db = await PGlite.create();
  await db.exec(SCHEMA);
  return db;
}

const insert = (db, e) => db.query(
  `insert into ai_usage_events
     (feature, status, model, provider, requested_model, fell_back,
      input_tokens, output_tokens, cost_usd, cost_estimated, model_breakdown, response_ms)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [e.feature || 'chat', e.status || 'success', e.model || null, e.provider || 'bailian',
    e.requested_model || null, Boolean(e.fell_back), e.input || 0, e.output || 0,
    e.cost || 0, Boolean(e.estimated), e.breakdown ? JSON.stringify(e.breakdown) : null,
    e.ms == null ? null : e.ms]);

const summary = async (db) => (await db.query(CHAT_SUMMARY_SQL('TRUE'), [])).rows[0];
const byModel = async (db) => (await db.query(CHAT_BY_MODEL_SQL('TRUE'), [])).rows;

const dbTest = PGlite ? test : test.skip;

// ── the summary ────────────────────────────────────────────────────────────

dbTest('counts turns, not model calls', async () => {
  const db = await freshDb();
  // One turn, four model calls inside it.
  await insert(db, { model: 'qwen3.6-flash', input: 8000, output: 400, cost: 0.002, ms: 3100,
    breakdown: [{ model: 'qwen3.6-flash', input_tokens: 8000, output_tokens: 400, cost_usd: 0.002, served: true }] });
  const s = await summary(db);
  assert.equal(Number(s.turns), 1, 'four calls in one turn is one turn');
  assert.equal(Number(s.total_tokens), 8400);
  await db.close();
});

dbTest('other features are not counted as chat', async () => {
  const db = await freshDb();
  await insert(db, { feature: 'email_draft', model: 'claude-sonnet-5', input: 5000, output: 900, cost: 0.03 });
  await insert(db, { feature: 'chat', model: 'qwen3.6-flash', input: 100, output: 20, cost: 0.0001 });
  const s = await summary(db);
  assert.equal(Number(s.turns), 1);
  assert.equal(Number(s.total_tokens), 120, 'the draft must not leak into the assistant total');
  await db.close();
});

dbTest('fallback rate and latency come from the turns themselves', async () => {
  const db = await freshDb();
  await insert(db, { model: 'qwen3.6-flash', fell_back: false, ms: 2000, input: 100, output: 10 });
  await insert(db, { model: 'qwen3.7-plus', fell_back: true, requested_model: 'qwen3.6-flash', ms: 6000, input: 300, output: 50 });
  await insert(db, { model: 'qwen3.6-flash', fell_back: false, ms: 1000, input: 100, output: 10 });
  await insert(db, { model: 'qwen3.6-flash', fell_back: false, ms: 3000, input: 100, output: 10, status: 'error' });
  const s = await summary(db);
  assert.equal(Number(s.turns), 4);
  assert.equal(Number(s.fallbacks), 1);
  assert.equal(Number(s.failures), 1);
  assert.equal(Number(s.avg_response_ms), 3000);
  await db.close();
});

dbTest('one estimated rate anywhere makes the total an estimate', async () => {
  const db = await freshDb();
  await insert(db, { model: 'claude-sonnet-5', estimated: false, cost: 1 });
  await insert(db, { model: 'qwen3.6-flash', estimated: true, cost: 0.001 });
  assert.equal((await summary(db)).cost_estimated, true,
    'a total that mixes a confirmed and an unconfirmed rate is not confirmed');
  await db.close();
});

dbTest('an empty range reports zero rather than null', async () => {
  const db = await freshDb();
  const s = await summary(db);
  assert.equal(Number(s.turns), 0);
  assert.equal(Number(s.total_tokens), 0);
  assert.equal(Number(s.cost_usd), 0);
  assert.equal(s.avg_response_ms, null, 'no turns means no average — not zero ms');
  assert.equal(s.cost_estimated, false);
  await db.close();
});

// ── cost by model ──────────────────────────────────────────────────────────

dbTest('a fallback turn puts each model\'s cost on that model', async () => {
  const db = await freshDb();
  await insert(db, {
    model: 'qwen3.7-plus', requested_model: 'qwen3.6-flash', fell_back: true,
    input: 8300, output: 450, cost: 0.0032, estimated: true,
    breakdown: [
      { model: 'qwen3.6-flash', provider: 'bailian', input_tokens: 8000, output_tokens: 400, cost_usd: 0.0020, estimated: true, served: false },
      { model: 'qwen3.7-plus', provider: 'bailian', input_tokens: 300, output_tokens: 50, cost_usd: 0.0012, estimated: true, served: true },
    ],
  });
  const rows = await byModel(db);
  assert.equal(rows.length, 2, 'both models appear — the failed one was still billed');
  const flash = rows.find((r) => r.model === 'qwen3.6-flash');
  const plus = rows.find((r) => r.model === 'qwen3.7-plus');
  assert.equal(Number(flash.cost_usd), 0.0020);
  assert.equal(Number(flash.served), 0, 'flash did not answer');
  assert.equal(Number(plus.served), 1);
  // The parts must reconcile with the turn.
  assert.ok(Math.abs((Number(flash.cost_usd) + Number(plus.cost_usd)) - 0.0032) < 1e-9);
  await db.close();
});

dbTest('a row with no breakdown is counted once, from its flat columns', async () => {
  const db = await freshDb();
  await insert(db, { model: 'qwen3.6-flash', input: 500, output: 40, cost: 0.00015 });
  const rows = await byModel(db);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].attempts), 1, 'a turn without a breakdown must not vanish');
  assert.equal(Number(rows[0].input_tokens), 500);
  assert.equal(Number(rows[0].cost_usd), 0.00015);
  assert.equal(Number(rows[0].served), 1, 'it answered — there was nothing else to answer');
  await db.close();
});

dbTest('breakdown rows and flat rows total correctly side by side', async () => {
  const db = await freshDb();
  // Historic shape (no breakdown) and current shape, on the same model.
  await insert(db, { model: 'qwen3.6-flash', input: 1000, output: 100, cost: 0.001 });
  await insert(db, { model: 'qwen3.6-flash', input: 2000, output: 200, cost: 0.002,
    breakdown: [{ model: 'qwen3.6-flash', provider: 'bailian', input_tokens: 2000, output_tokens: 200, cost_usd: 0.002, served: true }] });
  const rows = await byModel(db);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].cost_usd), 0.003, 'neither shape may be double-counted or dropped');
  assert.equal(Number(rows[0].input_tokens), 3000);
  const s = await summary(db);
  assert.ok(Math.abs(Number(s.cost_usd) - Number(rows[0].cost_usd)) < 1e-9,
    'by-model must reconcile with the summary total');
  await db.close();
});

dbTest('a turn with no model recorded is shown, not silently dropped', async () => {
  const db = await freshDb();
  await insert(db, { model: null, status: 'error', input: 0, output: 0 });
  const rows = await byModel(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, '(unknown)');
  await db.close();
});

if (!PGlite) {
  test('chat analytics SQL suite skipped — PGlite not available', { skip: true }, () => {});
}
