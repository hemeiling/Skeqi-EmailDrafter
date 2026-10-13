-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: booth_map_identity_decisions  (reviewed 2026-10-13)
--
-- Purpose: an admin-only, append-only record of decisions about whether an
-- entry on the earlier SKQ booth map (booth_map_booths) is the same company as
-- an official exhibitor (event_exhibitors). Used ONLY by the live Booth Map to
-- decide whether SKQ's curated classification of the old entry may be shown on
-- the official exhibitor.
--
-- Safety review:
--   • Additive only: one new table + indexes. No existing table, column, row or
--     constraint is altered. Idempotent (IF NOT EXISTS) — safe on every boot.
--   • Schema: public (Email Drafter). Does not touch projection_area.
--   • Writes nothing on creation. Rows are only ever written by an admin action.
--   • Never merges or edits CRM companies, booth_intel, booth_map_booths,
--     event_exhibitors or exhibitor_company_relations.
--   • History is permanent: a decision is never edited or deleted; changing it
--     revokes the live row (who/when/why) and inserts a new one in the same
--     transaction. Foreign keys block deleting a booth entry or exhibitor that
--     has review history.
--   • Rollback: the feature reads this table only when BOOTH_MAP_MODE=live.
--     With the flag off it has no effect. Dropping it is NOT part of rollback
--     (it is an audit trail); it can simply be left unused.
--
-- Executed by db.js initDb() with exactly these statements.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS booth_map_identity_decisions (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  -- The earlier SKQ map entry (and its curated classification).
  map_booth_id INTEGER NOT NULL REFERENCES booth_map_booths(id),
  -- The official exhibitor it may or may not be.
  exhibitor_id INTEGER NOT NULL REFERENCES event_exhibitors(id),
  decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'rejected', 'deferred')),
  reason TEXT,
  -- Server-computed at decision time: names, booths, CRM ids, classifications,
  -- the official run and live-model version the admin was looking at.
  evidence JSONB NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by TEXT,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bmid_live
  ON booth_map_identity_decisions (map_booth_id, exhibitor_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bmid_event
  ON booth_map_identity_decisions (event_id) WHERE revoked_at IS NULL;
