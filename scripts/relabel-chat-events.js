#!/usr/bin/env node
/**
 * Relabels historical AI Assistant events that were filed as `other`.
 *
 * The assistant passed feature: 'chat' from its first turn. recordAiEvent
 * coerces any feature not in its catalogue to 'other', and 'chat' was missing
 * from that list, so every turn since the assistant shipped is filed under a
 * bucket it does not belong in. The catalogue is fixed; these rows are not,
 * because cost_usd and feature are written once at request time and never
 * recomputed.
 *
 * Reclassifying analytics history is only defensible where the rows can be
 * identified WITHOUT guessing, so the test is deliberately narrow:
 *
 *     provider = 'bailian'
 *
 * Nothing else in this application talks to Bailian. Account Research,
 * drafting and classification are Anthropic and OpenAI, and every one of them
 * passes a feature the catalogue already knows — so a Bailian row filed as
 * `other` can only have come from the assistant.
 *
 * ── what this deliberately leaves behind ────────────────────────────────────
 *
 * Two rows from the broken GPT fallback are also assistant turns, and they are
 * NOT moved. Their provider is recorded as 'anthropic' — the 400 failed before
 * reporting one, and recordAiEvent defaults to Anthropic — so their cost was
 * computed at Claude's card: $0.016251 for 5,077 tokens, which is roughly
 * twenty times what those tokens could have cost. Moving them would import a
 * known-wrong figure into the number this whole exercise exists to get right,
 * and it would be about a quarter of the assistant's historical cost.
 *
 * They stay under `other` until provider and cost can be corrected together,
 * deterministically. A label fix that carries a bad cost with it is not a fix.
 *
 * Relabelling is not reversible — no column records where a row came from — so
 * a row wrongly moved in cannot be found again later. That asymmetry is why
 * the predicate errs toward leaving rows alone.
 *
 * ── the estimated flag ─────────────────────────────────────────────────────
 *
 * These rows also predate cost_estimated, so the column defaulted to false and
 * the dashboard would show their cost with no caveat. Every one of them was
 * priced from the same unconfirmed Bailian card the flag exists to announce,
 * so leaving it false would present an estimate as confirmed Token Plan
 * billing. It is corrected alongside the label.
 *
 * Only for rows written before the column existed, identified by having no
 * model_breakdown — every turn recorded by the current code has one. So if a
 * rate is later confirmed in ai_model_pricing and new rows start recording
 * cost_estimated = false, re-running this cannot wrongly re-flag them.
 *
 * Dry-run unless --apply is passed. Nothing else in the row is touched — not
 * cost, not tokens, not the provider, not the timestamp. Only the label and
 * the confidence flag.
 *
 *   node scripts/relabel-chat-events.js            # report only
 *   node scripts/relabel-chat-events.js --apply    # relabel
 */
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

/* The predicate, written once and used for counting, listing and updating, so
   the report cannot describe a different row set from the one that changes. */
const CERTAIN = `feature = 'other' AND provider = 'bailian'`;

(async () => {
  const host = new URL(process.env.DATABASE_URL).hostname;
  console.log(`\n  database: ${host}`);
  console.log(`  mode:     ${APPLY ? 'APPLY — rows will be relabelled' : 'dry run — nothing will be written'}\n`);

  const { rows: all } = await pool.query(
    `SELECT COUNT(*)::int n FROM ai_usage_events WHERE feature = 'other'`);
  const { rows: sure } = await pool.query(
    `SELECT provider, model, COUNT(*)::int n,
            COALESCE(SUM(cost_usd),0) cost,
            COALESCE(SUM(input_tokens+output_tokens),0)::int tokens
       FROM ai_usage_events WHERE ${CERTAIN}
      GROUP BY 1,2 ORDER BY n DESC`);

  const moving = sure.reduce((a, r) => a + r.n, 0);
  console.log(`  ${all[0].n} rows are filed as 'other'`);
  console.log(`  ${moving} of them are identifiable as assistant turns:\n`);
  for (const r of sure) {
    console.log(`    ${String(r.provider).padEnd(10)} ${String(r.model || '(none)').padEnd(16)}`
      + ` n=${String(r.n).padEnd(4)} ${r.tokens} tokens  $${Number(r.cost).toFixed(6)}`);
  }
  const staying = all[0].n - moving;
  console.log(`\n  ${staying} row${staying === 1 ? '' : 's'} stay in 'other':`);
  const { rows: held } = await pool.query(
    `SELECT provider, model, COUNT(*)::int n, COALESCE(SUM(cost_usd),0) cost,
            MAX(LEFT(error_message, 60)) sample
       FROM ai_usage_events WHERE feature = 'other' AND NOT (provider = 'bailian')
      GROUP BY 1,2`);
  for (const r of held) {
    console.log(`    ${String(r.provider).padEnd(10)} ${String(r.model || '(none)').padEnd(16)}`
      + ` n=${String(r.n).padEnd(4)} $${Number(r.cost).toFixed(6)}  ${r.sample ? r.sample.replace(/\s+/g, ' ') : ''}`);
  }
  if (held.length) {
    console.log('    ^ assistant turns too, but priced under the wrong provider.'
      + ' Held back until provider and cost can be corrected together.');
  }

  const { rows: [unflagged] } = await pool.query(`
    SELECT COUNT(*)::int n FROM ai_usage_events
     WHERE (${CERTAIN} OR feature = 'chat')
       AND provider = 'bailian' AND cost_estimated = false AND model_breakdown IS NULL`);
  if (unflagged.n) {
    console.log(`\n  ${unflagged.n} row${unflagged.n === 1 ? '' : 's'} priced from the unconfirmed`
      + ' Bailian rate are not marked estimated — that will be corrected too.');
  }

  if (!APPLY) {
    console.log('\n  Dry run. Re-run with --apply to relabel.\n');
    return pool.end();
  }

  const { rowCount } = await pool.query(
    `UPDATE ai_usage_events SET feature = 'chat' WHERE ${CERTAIN}`);
  console.log(`\n  relabelled ${rowCount} rows`);

  /* Separate statement, and deliberately not scoped to the rows this run just
     moved: a previous run may have relabelled without correcting the flag,
     which is exactly what happened the first time this was applied. */
  const flagged = await pool.query(`
    UPDATE ai_usage_events SET cost_estimated = true
     WHERE feature = 'chat' AND provider = 'bailian'
       AND cost_estimated = false AND model_breakdown IS NULL`);
  console.log(`  marked ${flagged.rowCount} rows as estimated (unconfirmed Bailian rate)`);

  const { rows: after } = await pool.query(
    `SELECT COUNT(*)::int n, COALESCE(SUM(cost_usd),0) cost
       FROM ai_usage_events WHERE feature = 'chat'`);
  console.log(`  feature 'chat' now holds ${after[0].n} rows, $${Number(after[0].cost).toFixed(6)}\n`);
  await pool.end();
})().catch((e) => { console.error(`  failed: ${e.message}`); process.exit(1); });
