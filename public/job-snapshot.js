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
  const DEAD_STATUSES = ['failed', 'interrupted', 'synthesis_failed', 'save_failed'];
  const LIVE_STATUSES = ['queued', 'running'];

  /* WHY a run stopped, kept apart from the coarse done/error/running the
     renderer needs for layout. Collapsing these lost the only thing the user
     actually needed: `interrupted` means execution was lost, and saying
     "Research failed during model" about it is false in both halves - the model
     did not fail, and for the reconciled jobs it had already written a full
     report. `save_failed` was missing from DEAD_STATUSES entirely, so a run
     whose report could not be saved rendered as still running. */
  const TERMINAL_COPY = {
    completed: {
      en: 'Research completed', zh: '研究完成', tone: 'ok', action: 'open' },
    completed_with_limitations: {
      en: 'Research completed with evidence limitations',
      zh: '研究完成，证据有限', tone: 'ok', action: 'open' },
    interrupted: {
      en: 'Research execution was interrupted',
      zh: '研究执行被中断', tone: 'warn', action: 'regenerate' },
    synthesis_failed: {
      en: 'Research evidence was collected, but final synthesis failed',
      zh: '已收集研究证据，但最终生成失败', tone: 'warn', action: 'regenerate' },
    save_failed: {
      en: 'Research was generated, but the report could not be saved',
      zh: '研究已生成，但报告保存失败', tone: 'warn', action: 'retry-save' },
    failed: {
      en: 'Research failed', zh: '研究失败', tone: 'bad', action: 'regenerate' },
  };

  /** What a terminal row should SAY, and what it should offer.
   *
   *  `hasArtifact` is the caller's answer to "does a saved report actually
   *  resolve for this row" - an interrupted run that still has one is a stale
   *  row to reconcile, not work to pay for again.
   *
   *  Synthesis-only retry is deliberately absent. The evidence package is
   *  written into research_data only when a report is saved, so a run whose
   *  synthesis failed leaves nothing to re-synthesise from; offering it would
   *  silently re-run retrieval and charge for it. Regenerate is the truthful
   *  action until evidence is persisted independently. */
  function terminalCopy(status, hasArtifact) {
    const base = TERMINAL_COPY[status];
    if (!base) return null;
    if (status === 'interrupted' && hasArtifact) {
      return Object.assign({}, base, {
        en: 'Research execution was interrupted; a saved report exists',
        zh: '研究执行被中断；已有保存的报告', action: 'reconcile' });
    }
    return base;
  }

  /** Where execution last reported progress. Not a cause, and never phrased as
   *  one: the stage a row stopped at is where the engine last checked in. */
  function lastStageLabel(stage) {
    return STAGE_LABELS[stage] || null;
  }

  const STAGE_LABELS = {
    queued: { en: 'Queued', zh: '排队中' },
    discover: { en: 'Validating company', zh: '确认公司' },
    official: { en: 'Reading the official site', zh: '读取官网' },
    listing: { en: 'Checking listing status', zh: '核查上市状态' },
    queries: { en: 'Planning searches', zh: '规划检索' },
    site: { en: 'Reading the official site', zh: '读取官网' },
    search: { en: 'Searching the web', zh: '网络检索' },
    verify: { en: 'Verifying sources', zh: '验证来源' },
    financial: { en: 'Financial lookup', zh: '财务检索' },
    apollo: { en: 'Contact enrichment', zh: '联系人补充' },
    contacts: { en: 'Contact enrichment', zh: '联系人补充' },
    dedupe: { en: 'Ranking sources', zh: '排序来源' },
    evidence: { en: 'Building evidence set', zh: '构建证据' },
    quality: { en: 'Assessing evidence', zh: '评估证据' },
    model: { en: 'Generating research', zh: '生成研究报告' },
    synthesis: { en: 'Generating research', zh: '生成研究报告' },
    pdf: { en: 'Generating PDF', zh: '生成PDF' },
    save: { en: 'Saving report', zh: '保存报告' },
    completed: { en: 'Completed', zh: '已完成' },
  };

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
      // The DURABLE status, kept beside the coarse one. `status` drives layout;
      // `state` is what the run actually ended as, and is what the headline and
      // the recommended action are derived from.
      state: row.status || null,
      has_artifact: !!row.report_id,
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

  /* A stored section is SELF-CONTAINED markdown: the engine writes
     "## <title>\n\n<body>" so each section stands alone for any consumer, which
     is right. The sections panel then renders its own title element on top, so
     the heading appeared twice - all 19 sections, both languages.

     Fixed at the display layer, not in storage: nothing saved is rewritten.

     Only an EXACT match is stripped, after normalising away heading marks,
     emphasis, whitespace and trailing punctuation. A first sentence that merely
     CONTAINS the title words is left alone - "Executive Summary of the year"
     is content, not a repeated heading. */
  function normalizeHeading(s) {
    return String(s == null ? '' : s)
      .replace(/^\s*#{1,6}\s*/, '')          // markdown heading marks
      .replace(/[*_`~]/g, '')                 // emphasis
      .replace(/[\s:：、，,.。!！?？\-–—]+$/, '')  // trailing punctuation, either script
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function stripLeadingTitle(text, title) {
    const body = String(text == null ? '' : text);
    if (!body.trim() || !String(title || '').trim()) return body;
    const lines = body.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i += 1;   // skip leading blanks
    if (i >= lines.length) return body;
    if (normalizeHeading(lines[i]) !== normalizeHeading(title)) return body;
    const rest = lines.slice(i + 1);
    while (rest.length && !rest[0].trim()) rest.shift();   // and the blank after it
    return rest.join('\n');
  }

  return {
    ENGINE_STAGE_ORDER, DONE_STATUSES, DEAD_STATUSES, LIVE_STATUSES,
    TERMINAL_COPY, STAGE_LABELS, terminalCopy, lastStageLabel,
    stagesUpTo, jobRowToSnapshot, stripLeadingTitle, normalizeHeading,
  };
}));
