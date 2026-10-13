/* ═══════════════════════════════════════════════════════════════════════════
   Battery CT Inspection · 电池CT检测 — research overlay for the Booth Map.

   A reviewed research dataset (data/research/battery-ct-tbsm26.json), shown
   as a filter. It is an OVERLAY, never a classification:

     • it reads SKQ's own classifications to display them and writes nothing —
       LEAD is shown as a CT company AND keeps its direct-competitor label;
     • exhibitors are identified by official exhibitor ID, and their booths are
       read from the latest verified exhibitor run every time, so a booth that
       changes after review is shown where it is now, not where it was;
     • 2D X-ray-only suppliers and companies that are not exhibiting are a
       research list only and are never drawn on the map;
     • a company that drops out of the official list moves to the research
       list rather than keeping a booth it no longer has.

   Every query is a SELECT.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const outreach = require('./outreach');
const exhibitorExport = require('./exhibitorExport');

const DATA_PATH = path.join(__dirname, 'data', 'research', 'battery-ct-tbsm26.json');
const KIND_LABELS = exhibitorExport.KIND_LABELS;
const CT_TYPE_LABELS = {
  '3d_ct_system': '3D CT system 3D CT设备', ct_service: 'CT inspection service CT检测服务',
  ct_components: 'CT components 核心组件', ct_software: 'CT analysis software CT分析软件',
  alliance_indirect: 'Alliance booth — indirect 联盟展位（间接）', research_ct: 'Research CT 科研CT',
  '2d_xray_only': '2D X-ray only — not CT 仅二维X射线',
};
const CONFIDENCE_LABELS = {
  confirmed: 'Confirmed CT 已确认', low: 'Low-confidence candidate 待确认',
  indirect: 'Indirect (alliance) 间接关联', not_ct: 'Not CT 非CT',
};

let cache = null;
function loadDataset(file = DATA_PATH) {
  const { mtimeMs } = fs.statSync(file);
  if (!cache || cache.file !== file || cache.mtimeMs !== mtimeMs) {
    const ds = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!ds.version || !Array.isArray(ds.companies) || !ds.groups) throw new Error('battery CT dataset is malformed');
    cache = { file, mtimeMs, ds };
  }
  return cache.ds;
}

async function latestRun(pool, eventId) {
  const { rows: [run] } = await pool.query(
    `SELECT id, finished_at FROM exhibitor_import_runs
      WHERE status = 'success' AND dry_run = FALSE AND (event_id = $1 OR event_id IS NULL)
      ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`, [eventId]);
  return run || null;
}

/**
 * The filter's content. With `model` (live map) the existing classification
 * comes from the same model the map draws; otherwise from SKQ's curated
 * classifications as the exports read them.
 */
async function buildView(pool, { model = null, file } = {}) {
  const ds = loadDataset(file);
  const eventId = await outreach.resolveEventId(pool);
  if (!eventId) throw new Error('no verified exhibitor list');
  const run = await latestRun(pool, eventId);
  const ids = ds.companies.map((c) => c.exhibitor_source_id).filter(Boolean);
  const { rows } = await pool.query(
    `SELECT e.id, e.exhibitor_source_id, e.source_name, e.company_id, e.attendance_status,
            COALESCE(array_agg(b.booth_number ORDER BY b.booth_number)
                     FILTER (WHERE b.booth_number IS NOT NULL), '{}') AS booths
       FROM event_exhibitors e
       LEFT JOIN exhibitor_booths b ON b.exhibitor_id = e.id AND b.retired_at IS NULL
      WHERE e.event_id = $1 AND e.exhibitor_source_id = ANY($2::text[])
      GROUP BY e.id`, [eventId, ids]);
  const bySource = new Map(rows.map((r) => [String(r.exhibitor_source_id), r]));

  // Existing SKQ classification, read only.
  const existing = new Map();
  if (model) {
    for (const r of rows) {
      const m = model.exhibitors[r.id];
      if (m) existing.set(r.id, { kinds: m.kinds, category: m.category, pending: (m.pending || []).length > 0 });
    }
  } else {
    for (const e of await exhibitorExport.loadExhibitors(pool, eventId, false)) {
      if (bySource.has(String(e.exhibitor_source_id))) existing.set(e.id, { kinds: e.kinds, category: e.map_category, pending: false });
    }
  }

  const onMap = [];
  const research = [];
  for (const c of ds.companies) {
    const base = {
      ...c,
      group_label: ds.groups[c.group],
      ct_type_label: CT_TYPE_LABELS[c.ct_type] || c.ct_type,
      confidence_label: CONFIDENCE_LABELS[c.confidence] || c.confidence,
    };
    const ex = c.exhibitor_source_id ? bySource.get(String(c.exhibitor_source_id)) : null;
    const listed = ex && ex.attendance_status === 'listed' && c.group !== 'X';
    if (!listed) {
      research.push({ ...base,
        status_now: c.status !== 'listed' ? c.status : 'no_longer_listed',
        booths: [] });
      continue;
    }
    const cls = existing.get(ex.id) || { kinds: [], category: null, pending: false };
    const booths = ex.booths.map(String);
    onMap.push({
      ...base,
      exhibitor_id: ex.id,
      official_name: ex.source_name,
      booths,
      booth_changed_since_review: booths.join(',') !== (c.booths_at_review || []).join(','),
      crm_company_id_now: ex.company_id,
      crm_matches_review: String(ex.company_id || '') === String(c.crm_company_id || ''),
      existing_classification: {
        kinds: cls.kinds,
        labels: cls.kinds.map((k) => KIND_LABELS[k] || k),
        category: cls.category,
        pending: cls.pending,
      },
    });
  }
  return {
    version: ds.version,
    title: ds.title,
    reviewed_at: ds.reviewed_at,
    official: run ? { run_id: run.id, verified_at: run.finished_at } : null,
    map_version: model ? model.version : null,
    groups: ds.groups,
    rules: ds.rules,
    confidence_labels: CONFIDENCE_LABELS,
    on_map: onMap,
    research,
  };
}

async function toXlsx(view) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SKQ CRM';
  const ws = wb.addWorksheet('Battery CT 电池CT', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
  const cols = [['group', 'Group 分组', 34], ['name', 'Company 公司', 34], ['name_zh', '中文名', 16], ['where', 'On map / research 地图或研究名单', 20],
    ['booths', 'Booth(s) 展位 (latest verified run)', 16], ['confidence', 'Confidence 可信度', 22], ['ct_type', 'CT type 类型', 26],
    ['existing', 'Existing SKQ classification 现有分类 (unchanged)', 30], ['technology', 'Technology 技术/产品', 50],
    ['battery_application', 'Battery application 电池应用', 40], ['levels', 'Cell/Module/Pack 层级', 16], ['mode', 'Inline vs lab 产线/实验室', 18],
    ['opp', 'SKQ opportunity 合作/竞争关系', 46], ['opp_zh', '思客琦相关性', 40], ['sources', 'Sources 来源', 60], ['notes', 'Notes 备注', 40]];
  ws.columns = cols.map(([key, header, width]) => ({ key, header, width }));
  const row = (c, where) => ({
    group: `${c.group} · ${c.group_label.en} ${c.group_label.zh}`, name: c.name, name_zh: c.name_zh, where,
    booths: (c.booths || []).join(', ') || '—', confidence: c.confidence_label, ct_type: c.ct_type_label,
    existing: c.existing_classification ? (c.existing_classification.labels.join('; ') || (c.existing_classification.pending ? 'Pending identity review 待身份审核' : '—')) : '—',
    technology: c.technology, battery_application: c.battery_application, levels: c.levels, mode: c.mode,
    opp: c.skq_opportunity, opp_zh: c.skq_opportunity_zh, sources: (c.sources || []).join('\n'), notes: c.notes,
  });
  for (const c of view.on_map) ws.addRow(Object.fromEntries(Object.entries(row(c, 'On map 地图')).map(([k, v]) => [k, outreach.neutralize(v)])));
  for (const c of view.research) {
    const where = c.status_now === 'withdrawn' ? 'Research — withdrawn 已撤展' : c.status_now === 'no_longer_listed' ? 'Research — no longer listed 已不在名单' : 'Research — not exhibiting 未参展';
    ws.addRow(Object.fromEntries(Object.entries(row(c, where)).map(([k, v]) => [k, outreach.neutralize(v)])));
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  ws.eachRow((r) => { r.alignment = { wrapText: true, vertical: 'top' }; });
  const about = wb.addWorksheet('About 说明');
  about.columns = [{ key: 'v', width: 140 }];
  [`${view.title} — dataset ${view.version}, reviewed ${view.reviewed_at}.`,
    view.official ? `Booths from official exhibitor run #${view.official.run_id} (verified ${new Date(view.official.verified_at).toISOString()}).` : '',
    ...view.rules, 'Research overlay only: no CRM classification or company record is created or changed.'].forEach((v) => v && about.addRow({ v }));
  return wb.xlsx.writeBuffer();
}

module.exports = { buildView, toXlsx, loadDataset, DATA_PATH, CT_TYPE_LABELS, CONFIDENCE_LABELS };
