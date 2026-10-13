/* ═══════════════════════════════════════════════════════════════════════════
   Booth Map identity confirmation — admin only.

   Answers one question per pair: is this entry from the earlier SKQ booth map
   the same company as this official exhibitor? An admin records confirmed,
   rejected or deferred, with a reason. The live Booth Map then:

     confirmed  shows SKQ's classification of the earlier entry on that
                exhibitor (identity tier "admin_confirmed")
     rejected   never proposes that pair again; the exhibitor is not "pending"
     deferred   leaves it pending, with the deferral on record

   What this never does: merge, edit or link CRM companies; write booth_intel,
   booth_map_booths, event_exhibitors or exhibitor_company_relations; or act
   on a pair the server did not itself put in the queue. The only table
   written is booth_map_identity_decisions, append-only: a change revokes the
   live row (who/when/why) and inserts a new one in the same transaction.
   ═══════════════════════════════════════════════════════════════════════════ */

const boothMapModel = require('./boothMapModel');

const DECISIONS = ['confirmed', 'rejected', 'deferred'];
const MAX_REASON = 500;

class IdentityError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Every row ever recorded for the queued pairs, newest first. */
async function history(pool, pairs) {
  if (!pairs.length) return new Map();
  const { rows } = await pool.query(
    `SELECT id, map_booth_id, exhibitor_id, decision, reason, decided_by, decided_at,
            revoked_by, revoked_at, revoke_reason
       FROM booth_map_identity_decisions
      WHERE (map_booth_id, exhibitor_id) IN (SELECT * FROM unnest($1::int[], $2::int[]))
      ORDER BY decided_at DESC, id DESC`,
    [pairs.map((p) => p.map_booth_id), pairs.map((p) => p.exhibitor_id)]);
  const by = new Map();
  for (const r of rows) {
    const k = boothMapModel.pairKey(r.map_booth_id, r.exhibitor_id);
    by.set(k, [...(by.get(k) || []), r]);
  }
  return by;
}

/** The queue as the admin panel shows it: current item, decision and full history. */
async function listQueue(pool, { isAdmin } = {}) {
  if (isAdmin !== true) throw new IdentityError(403, 'admin_only', 'Admin only');
  const model = await boothMapModel.buildModel(pool);
  let hist = new Map();
  try { hist = await history(pool, model.identity_queue); } catch (e) { if (e.code !== '42P01') throw e; }
  return {
    model_version: model.version,
    official: model.official,
    items: model.identity_queue.map((q) => ({ ...q, history: hist.get(q.key) || [] })),
    counts: DECISIONS.reduce((o, d) => ({ ...o, [d]: model.identity_queue.filter((q) => q.decision && q.decision.decision === d).length }),
      { undecided: model.identity_queue.filter((q) => !q.decision).length }),
  };
}

function normalize(input = {}) {
  const mapBoothId = Number(input.map_booth_id);
  const exhibitorId = Number(input.exhibitor_id);
  if (!Number.isInteger(mapBoothId) || mapBoothId <= 0 || !Number.isInteger(exhibitorId) || exhibitorId <= 0) {
    throw new IdentityError(400, 'bad_pair', 'map_booth_id and exhibitor_id are required.');
  }
  const decision = String(input.decision || '');
  if (!DECISIONS.includes(decision)) throw new IdentityError(400, 'bad_decision', 'decision must be confirmed, rejected or deferred.');
  const reason = String(input.reason || '').trim();
  if (reason.length > MAX_REASON) throw new IdentityError(400, 'reason_too_long', `Reason is limited to ${MAX_REASON} characters.`);
  if (decision !== 'deferred' && reason.length < 3) {
    throw new IdentityError(400, 'reason_required', 'Please give a short reason for a confirmation or rejection.');
  }
  return { mapBoothId, exhibitorId, decision, reason };
}

/**
 * Record a decision. `isAdmin` must be exactly true — the caller passes the
 * application's own isAdmin(req); anything else is refused before any read.
 */
async function recordDecision(pool, input, { isAdmin, user } = {}) {
  if (isAdmin !== true) throw new IdentityError(403, 'admin_only', 'Admin only');
  if (!user) throw new IdentityError(400, 'no_user', 'The deciding user is unknown.');
  const { mapBoothId, exhibitorId, decision, reason } = normalize(input);

  // Only pairs the server itself queued may be decided.
  const model = await boothMapModel.buildModel(pool);
  const item = model.identity_queue.find((q) => q.map_booth_id === mapBoothId && q.exhibitor_id === exhibitorId);
  if (!item) throw new IdentityError(409, 'not_eligible', 'This pair is not in the identity review queue.');
  if (item.decision && item.decision.decision === decision) {
    throw new IdentityError(409, 'unchanged', `This pair is already ${decision}.`);
  }

  const evidence = {
    historical: item.historical, official: item.official, evidence: item.evidence,
    official_run: model.official, model_version: model.version,
    note: 'Decision about the Booth Map display only. No CRM record was merged, linked or changed.',
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [live] } = await client.query(
      `SELECT id, decision FROM booth_map_identity_decisions
        WHERE map_booth_id = $1 AND exhibitor_id = $2 AND revoked_at IS NULL FOR UPDATE`, [mapBoothId, exhibitorId]);
    if (live) {
      await client.query(
        `UPDATE booth_map_identity_decisions SET revoked_by = $2, revoked_at = NOW(), revoke_reason = $3
          WHERE id = $1`, [live.id, user, `superseded by a new decision: ${decision}`]);
    }
    const { rows: [row] } = await client.query(
      `INSERT INTO booth_map_identity_decisions
         (event_id, map_booth_id, exhibitor_id, decision, reason, evidence, decided_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, map_booth_id, exhibitor_id, decision, reason, decided_by, decided_at`,
      [model.event.id, mapBoothId, exhibitorId, decision, reason || null, evidence, user]);
    await client.query('COMMIT');
    return { decision: row, superseded: live ? live.id : null };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') throw new IdentityError(409, 'conflict', 'Another decision was recorded at the same time. Please reload.');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { listQueue, recordDecision, normalize, IdentityError, DECISIONS };
