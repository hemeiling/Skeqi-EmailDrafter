/* ═══════════════════════════════════════════════════════════════════════════
   Booth Map sync preview — read-only, admin.

   Answers "what would change if the live map were switched on", before
   anyone switches it on:

     before   the snapshot map compared with the latest verified exhibitor run
     after    the live model built from that same run
     geometry every booth position decision, with the reason for each
     review   classifications the system will not attach on its own

   Built from the same functions the map and the downloads use, so the preview
   cannot describe a different map from the one that would be shown. Every
   query underneath is a SELECT.
   ═══════════════════════════════════════════════════════════════════════════ */

const ExcelJS = require('exceljs');
const exhibitorExport = require('./exhibitorExport');
const boothMapModel = require('./boothMapModel');
const { neutralize } = require('./outreach');

const REVIEW_LABELS = {
  possible_rename: 'Possible rename — confirm identity 疑似更名，请确认',
  left_show: 'Company not in the verified list 已不在官方名单',
  ambiguous: 'Ambiguous identity — more than one candidate 身份不唯一',
};
const GEO_LABELS = {
  kept: 'Kept (position unchanged) 位置未变',
  relocated: 'Relocated to official position 按官方位置调整',
  new: 'New booth from official plan 官方新增展位',
  kept_ambiguous: 'Kept — official move ambiguous, needs review 位置存疑，保留原位',
  unplaced: 'Not drawn — collides, needs manual placement 位置冲突，待人工定位',
  historical: 'Historical — not in official plan 历史展位',
  placeholder: 'Placeholder — not drawn, record kept 占位展位，不绘制，保留记录',
};

async function buildPreview(pool) {
  const model = await boothMapModel.buildModel(pool);
  const [before, after] = await Promise.all([
    exhibitorExport.buildSnapshot(pool, {}),
    exhibitorExport.buildSnapshot(pool, {}, { model }),
  ]);
  const plan = boothMapModel.loadPlan();
  const validation = boothMapModel.validate(model);

  // Before: classifications the snapshot map paints on a booth whose official
  // occupant is a different company.
  const occupantsOf = new Map(before.booths.map((b) => [b.booth, b]));
  const wrongBefore = model.profiles.filter((p) => p.kinds.length && (() => {
    const b = occupantsOf.get(p.snapshot_booth);
    return b && b.exhibitors.length && b.status === 'differs';
  })());
  const followed = Object.entries(model.exhibitors)
    .filter(([, e]) => e.from.length && e.from.some((f) => !e.booths.includes(f)))
    .map(([id, e]) => ({ exhibitor_id: Number(id), name: e.name, from: e.from, to: e.booths,
      kinds: e.kinds, category: e.category }));
  const unclassified = Object.values(model.exhibitors).filter((e) => !e.category && !e.kinds.length && !(e.pending || []).length);

  const count = (list, f) => list.filter(f).length;
  return {
    generated_at: new Date(),
    versions: {
      official_run: model.official.run_id, official_verified_at: model.official.verified_at,
      official_source_version: model.official.source_version,
      geometry: model.geometry.version, geometry_fetched_at: model.geometry.fetched_at,
      snapshot: model.snapshot && model.snapshot.version, model: model.version,
    },
    before: {
      ...before.differences,
      classifications_on_wrong_company: wrongBefore.length,
      official_exhibitors_drawn_correctly: before.official.with_booth - before.differences.exhibitors_not_matching_map,
    },
    after: {
      ...after.differences,
      classifications_on_wrong_company: count(validation.failures, (f) => f.type === 'classification_not_from_company'),
      official_exhibitors_drawn_correctly: validation.drawn_at_every_booth,
    },
    official: after.official,
    validation,
    geometry: {
      transform: plan.transform, counts: plan.counts,
      decisions: [...plan.booths, ...plan.historical].filter((g) => g.decision !== 'kept'),
    },
    classifications: {
      followed_company: followed,
      unclassified: unclassified.map((e) => ({ name: e.name, booths: e.booths })),
      identity_tiers: model.identity_tiers,
    },
    review: model.review,
    wrong_before: wrongBefore,
    beforeBooths: before.booths,
    model,
  };
}

/** The JSON the admin modal shows: counts, versions and the short lists. */
function summary(p) {
  const rc = {};
  for (const r of p.review) rc[r.kind] = (rc[r.kind] || 0) + 1;
  return {
    generated_at: p.generated_at, versions: p.versions, before: p.before, after: p.after,
    official: p.official,
    validation: { ...p.validation, failures: p.validation.failures.slice(0, 50) },
    geometry: { counts: p.geometry.counts, fitted_on: p.geometry.transform.fitted_on,
      within_1_unit: p.geometry.transform.within_1_unit,
      unplaced: p.geometry.decisions.filter((g) => g.decision === 'unplaced' || g.decision === 'placeholder'),
      ambiguous: p.geometry.decisions.filter((g) => g.decision === 'kept_ambiguous') },
    classifications: { followed_company: p.classifications.followed_company.length,
      unclassified: p.classifications.unclassified.length, identity_tiers: p.classifications.identity_tiers,
      pending_identity_review: Object.values(p.model.exhibitors).filter((e) => (e.pending || []).length).length },
    review_counts: rc,
  };
}

function sheet(wb, name, cols, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map(([key, header, width]) => ({ key, header, width }));
  for (const r of rows) {
    const o = {};
    for (const [k] of cols) {
      const v = r[k];
      o[k] = typeof v === 'number' || v instanceof Date ? v : neutralize(Array.isArray(v) ? v.join('; ') : v);
    }
    ws.addRow(o);
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return ws;
}

async function toXlsx(p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SKQ CRM';
  const v = p.versions;
  const metric = (label, key) => ({ metric: label, before: p.before[key] ?? '', after: p.after[key] ?? '' });
  sheet(wb, 'Summary 摘要', [['metric', 'Metric 指标', 64], ['before', 'Snapshot map 当前快照', 22], ['after', 'Live map 实时', 22]], [
    metric('Official exhibitors drawn at their verified booth(s) 展商按官方展位绘制', 'official_exhibitors_drawn_correctly'),
    metric('Booths matching the official occupant 展位与官方一致', 'booths_matching'),
    metric('Booths showing a different company 展位显示其他公司', 'booths_different_occupant'),
    metric('Official booths not drawn 官方展位未绘制', 'booths_official_not_on_map'),
    metric('Map booths with no official exhibitor 展位图有、官方无', 'booths_on_map_not_official'),
    metric('Exhibitors whose booths differ from the map 展位不一致的展商', 'exhibitors_not_matching_map'),
    metric('Classifications shown on the wrong company 分类显示在错误公司', 'classifications_on_wrong_company'),
    { metric: 'Reserved booths with no verified occupant 已预订未核实', before: '', after: p.after.booths_unverified },
    { metric: 'Historical booths (hidden by default) 历史展位（默认隐藏）', before: '', after: p.after.historical_booths },
    { metric: 'Admin review items 待管理员审核', before: '', after: p.review.length },
    {}, { metric: `Official run #${v.official_run} verified ${v.official_verified_at && new Date(v.official_verified_at).toISOString()} (${v.official_source_version})` },
    { metric: `Geometry plan ${v.geometry} (official floor plan fetched ${v.geometry_fetched_at})` },
    { metric: `Snapshot map ${v.snapshot} · live model ${v.model}` },
    { metric: `Validation: ${p.validation.drawn_at_every_booth}/${p.validation.assigned_exhibitors} assigned exhibitors drawn at every booth; ${p.validation.shared_booths} shared booths; ${p.validation.failures.length} failures` },
    { metric: 'Read-only preview. Nothing was changed. 只读预览，未做任何修改。' },
  ]);
  const afterBy = new Map(p.model.booths.map((b) => [b.n, b]));
  const unplaced = new Set(p.model.unplaced.map((u) => u.n));
  const hist = new Set(p.model.historical.map((h) => h.n));
  const geoBy = new Map([...p.geometry.decisions].map((g) => [g.n, g.decision]));
  sheet(wb, 'Booths 展位', [['booth', 'Booth 展位', 10], ['official', 'Official occupant(s) 官方展商', 44],
    ['before', 'Snapshot map shows 快照显示', 36], ['before_status', 'Snapshot vs official 快照核对', 30],
    ['after', 'Live map shows 实时显示', 36], ['after_status', 'Live status 实时状态', 18], ['geometry', 'Geometry 位置', 30]],
  buildBoothRows(p, afterBy, unplaced, hist, geoBy));
  sheet(wb, 'Geometry 位置', [['n', 'Booth 展位', 10], ['decision', 'Decision 决定', 44], ['orig', 'Original x,y 原位置', 14],
    ['official', 'Official x,y 官方位置', 14], ['drawn', 'Drawn x,y 绘制位置', 14], ['note', 'Note 说明', 60]],
  p.geometry.decisions.map((g) => ({ n: g.n, decision: GEO_LABELS[g.decision] || g.decision,
    orig: g.orig ? `${g.orig.x},${g.orig.y}` : (g.decision === 'historical' ? `${g.x},${g.y}` : ''),
    official: g.official ? `${g.official.x},${g.official.y}` : '',
    drawn: ['historical', 'unplaced', 'placeholder'].includes(g.decision) ? '' : `${g.x},${g.y}`, note: g.note || '' })));
  sheet(wb, 'Review 审核', [['kind', 'Review 类型', 40], ['company', 'Company on snapshot map 快照公司', 40],
    ['snapshot_booth', 'Snapshot booth 快照展位', 12], ['classifications', 'Classifications held back 暂不显示的分类', 34],
    ['category', 'Map category 类别', 14], ['detail', 'Candidates / detail 候选', 60]],
  p.review.map((r) => ({ ...r, kind: REVIEW_LABELS[r.kind] || r.kind })));
  sheet(wb, 'Followed company 随公司迁移', [['name', 'Company 公司', 40], ['from', 'Snapshot booth(s) 原展位', 16],
    ['to', 'Official booth(s) 现展位', 16], ['kinds', 'Classifications 分类', 40], ['category', 'Map category 类别', 14]],
  p.classifications.followed_company);
  sheet(wb, 'Unclassified 未分类', [['name', 'Official exhibitor 官方展商', 50], ['booths', 'Booth(s) 展位', 16]],
    p.classifications.unclassified);
  sheet(wb, 'Validation 校验', [['type', 'Failure 问题', 30], ['detail', 'Detail 详情', 80]],
    p.validation.failures.map((f) => ({ type: f.type, detail: JSON.stringify(f) })));
  return wb.xlsx.writeBuffer();
}

function buildBoothRows(p, afterBy, unplaced, hist, geoBy) {
  const beforeBy = new Map((p.beforeBooths || []).map((b) => [b.booth, b]));
  const numbers = new Set([...beforeBy.keys(), ...afterBy.keys(), ...unplaced, ...hist]);
  const names = (ids) => ids.map((id) => p.model.exhibitors[id].name).join(' / ');
  return [...numbers].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((n) => {
    const b = beforeBy.get(n) || {};
    const a = afterBy.get(n);
    return {
      booth: n,
      official: (b.exhibitors || []).join(' / '),
      before: b.map_name || '',
      before_status: b.status || '',
      after: a ? (names(a.occ) || (a.st === 'vacant' ? 'Available' : '')) : '',
      after_status: a ? a.st : (unplaced.has(n) ? 'unplaced' : (hist.has(n) ? 'historical' : '')),
      geometry: GEO_LABELS[geoBy.get(n) || (a ? 'kept' : '')] || '',
    };
  });
}

module.exports = { buildPreview, summary, toXlsx, REVIEW_LABELS, GEO_LABELS };
