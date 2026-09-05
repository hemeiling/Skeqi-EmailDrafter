/* Rebuilding a research run's on-screen progress from the DURABLE row.
 *
 * The engine holds the full stage history in memory; Neon holds only the LAST
 * stage and a percentage. So after a reload, a browser restart, or an engine
 * restart, this is everything we know — and it is enough. Reconstructing from
 * it is what keeps a running job visible instead of resetting to 0%.
 *
 * Previously this derived the percentage by counting entries in `warnings`,
 * which is empty for a healthy run. A job persisted at stage=site, 25% rendered
 * as 0% / "Validating company": the durable state was there and simply unread.
 *
 * Shared by the page and by the tests, so the reconstruction is verified
 * without a browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobSnapshot = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* The order the ENGINE reaches its stages (app.py STAGE_ORDER), plus the
     terminal markers it writes to the durable row. Position in this list is
     what tells us which steps a persisted stage implies are already behind us. */
  const ENGINE_STAGE_ORDER = [
    'queued', 'discover', 'official', 'listing', 'queries', 'site', 'search',
    'verify', 'financial', 'apollo', 'contacts', 'dedupe', 'evidence', 'quality',
    'model', 'synthesis', 'completed',
  ];

  const DONE_STATUSES = ['completed', 'completed_with_limitations'];
  const DEAD_STATUSES = ['failed', 'interrupted', 'synthesis_failed'];
  const LIVE_STATUSES = ['queued', 'running'];

  /** Engine stages strictly BEFORE the persisted one — those are finished.
   *  The persisted stage itself is left unmarked so it renders as the ACTIVE
   *  step: the engine reports a stage as it reaches it, not after it ends. */
  function stagesUpTo(stage) {
    const i = ENGINE_STAGE_ORDER.indexOf(stage);
    if (i <= 0) return [];
    return ENGINE_STAGE_ORDER.slice(0, i).map((k, n) => ({ at: n, stage: k, message: '' }));
  }

  /** A durable Neon row -> the shape renderProgress() expects. */
  function jobRowToSnapshot(row) {
    row = row || {};
    const done = DONE_STATUSES.indexOf(row.status) >= 0;
    const dead = DEAD_STATUSES.indexOf(row.status) >= 0;
    const pct = row.progress_percent == null ? null
      : Math.max(0, Math.min(100, Number(row.progress_percent) || 0));
    return {
      status: done ? 'done' : dead ? 'error' : 'running',
      phase: row.stage || 'retrieval',
      message: row.error || '',
      // Reconstructed from the persisted stage, NOT from warnings.
      stages: stagesUpTo(row.stage),
      sources: [], search_queries: [],
      models: { [row.model || 'model']: { label: row.model || 'Model', status: 'generating' } },
      // The authoritative percentage. renderProgress prefers this over the one
      // it would otherwise derive from a stage history it does not have.
      _pct: done ? 100 : pct,
      _warnings: row.warnings || [],
      _durable: row,
    };
  }

  return {
    ENGINE_STAGE_ORDER, DONE_STATUSES, DEAD_STATUSES, LIVE_STATUSES,
    stagesUpTo, jobRowToSnapshot,
  };
}));
