/* ═══════════════════════════════════════════════════════════════════════════
   Booth Map downloads · 展位图下载 — the exhibitor list and the floor-plan
   manifest.

   Two sources, and the point of this file is to keep them apart in the
   output rather than blend them:

     • The official exhibitor list (event_exhibitors + exhibitor_booths), as of
       the last SUCCESSFUL refresh. This is who is exhibiting and where.
     • The SKQ booth map (public/booth-map/index.html, projected into
       booth_map_booths). This is the curated floor plan: geometry, our
       categories, our labels. It is a snapshot and does not update itself.

   Every row says which booth it is in according to the official list, and
   whether the SKQ map agrees. A download never re-reads the official source
   and never writes: what was last verified is exported and labelled as such,
   and anything that has drifted since is somebody's decision to refresh.

   Deliberately absent: contacts, emails, phone numbers, research text, audit
   detail. This is a show directory, not a CRM extract.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const ExcelJS = require('exceljs');
const outreach = require('./outreach');
const relations = require('./outreachRelations');
const boothImport = require('./boothImport');
const { normalizeNameKey } = require('./companyKey');

const OFFICIAL_SOURCE_LABEL = 'Official exhibitor list · MapYourShow (tbsm26)';
const OFFICIAL_FLOOR_PLAN_URL = 'https://tbsm26.mapyourshow.com/8_0/floorplan/';

/* Labels are bilingual in the file itself: the workbook is passed around
   outside the app, where the UI's translation layer does not exist. */
const KIND_LABELS = {
  target_customer: 'Target customer 目标客户',
  competitor_direct: 'Direct competitor 直接竞品',
  competitor_indirect: 'Indirect competitor 间接竞品',
  ess_ev: 'ESS / EV project 储能电动项目',
  chinese_company: 'Chinese company 中国企业',
};
const KIND_ORDER = Object.keys(KIND_LABELS);

// The map's own taxonomy, worded as the map's filter rail words it.
const MAP_CATEGORY_LABELS = {
  available: 'Available 可用展位', line: 'Assembly Line 产线设备', mfg: 'Manufacturing 制造设备',
  test: 'Testing 测试检测', cert: 'Certification 认证机构', customer: 'Target Customers 目标客户',
  ess_ev: 'ESS / EV Projects 储能电动项目', elec: 'Electronics 电子连接', batmat: 'Battery Materials 电池材料',
  recycle: 'Recycling 回收安全', gov: 'Government 政府机构', other: 'Others 其他',
};

/* The map's filter ids, and what each means against canonical data. The map
   filters booths; this filters exhibitors, so the three overlay filters go
   through the curated classification that travels with the exhibitor, and the
   category filters through the map category of the booth they occupy.
   "available" has no exhibitors by definition and is refused, not emptied. */
const FILTERS = {
  all: { label: 'All exhibitors 全部展商' },
  competitor: { kinds: ['competitor_direct', 'competitor_indirect'], label: 'Competitors 竞争对手' },
  ess_ev: { kinds: ['ess_ev'], label: 'ESS / EV Projects 储能电动项目' },
  chinese: { kinds: ['chinese_company'], label: 'Chinese companies 中国企业' },
};
for (const id of ['line', 'mfg', 'test', 'cert', 'customer', 'elec', 'batmat', 'recycle', 'gov', 'other']) {
  FILTERS[id] = { mapCategory: id, label: `Map category: ${MAP_CATEGORY_LABELS[id]}` };
}
// Live map only: official exhibitors SKQ has not classified yet.
FILTERS.unclassified = { unclassified: true, label: 'Unclassified official exhibitors 未分类展商' };
FILTERS.pending = { pending: true, label: 'Pending identity review 待身份审核' };
// Booth-only views of the live map: they hold no exhibitors to list.
const BOOTH_ONLY_FILTERS = new Set(['available', 'unverified', 'historical']);

class ExportError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function normalizeOptions(input = {}) {
  const filter = String(input.filter || 'all');
  if (BOOTH_ONLY_FILTERS.has(filter)) {
    throw new ExportError('not_applicable',
      'Available booths have no exhibitors. Choose "All exhibitors" or another filter.');
  }
  if (!FILTERS[filter]) throw new ExportError('bad_filter', 'Unknown filter.');
  const w = input.include_withdrawn;
  return { filter, includeWithdrawn: w === true || w === 'true' || w === '1' };
}

/* ── The map file actually being served ─────────────────────────────────────
   booth_map_booths is a projection of the HTML file, refreshed by an import
   script. If someone edits the file and forgets the import, the projection
   and what users see disagree — so the served file's fingerprint is computed
   here and compared, rather than assumed. Cached on mtime: the file is 670 KB. */
let servedCache = null;
function servedMapVersion() {
  try {
    const { mtimeMs } = fs.statSync(boothImport.SOURCE_PATH);
    if (!servedCache || servedCache.mtimeMs !== mtimeMs) {
      const src = boothImport.readSource();
      servedCache = { mtimeMs, version: src.source_version, booths: src.booths.length };
    }
    return servedCache;
  } catch (e) {
    console.warn('[booth-map export] could not fingerprint the served map:', e.message);
    return null;
  }
}

/* ── Snapshot ───────────────────────────────────────────────────────────── */

async function loadRun(pool, eventId) {
  const { rows: [run] } = await pool.query(
    `SELECT id, finished_at, source_version, fetched FROM exhibitor_import_runs
      WHERE status = 'success' AND dry_run = FALSE AND (event_id = $1 OR event_id IS NULL)
      ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`, [eventId]);
  return run || null;
}

async function loadMapImport(pool, eventId) {
  const { rows: [run] } = await pool.query(
    `SELECT id, finished_at, source_version, booths_seen FROM booth_import_runs
      WHERE status = 'success' AND dry_run = FALSE AND (event_id = $1 OR event_id IS NULL)
      ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`, [eventId]);
  return run || null;
}

/* Exhibitors with booths, curated classification and map category. The intel
   rule is the Outreach page's (curated labels travel with the exhibitor; a
   booth-only label counts when the map says this exhibitor is the current
   occupant; anything under review is left out), but every kind is kept
   rather than collapsed to one — a company can be a target AND an ESS project. */
async function loadExhibitors(pool, eventId, includeWithdrawn) {
  const kinds = outreach.INTEL_KINDS;
  const { rows } = await pool.query(`
    WITH ex AS (
      SELECT e.id, e.exhibitor_source_id, e.source_name, e.company_id, e.match_confidence,
             e.attendance_status, e.hall, e.last_verified_at,
             co.name AS company_name, co.chinese_name, co.website, co.industry
        FROM event_exhibitors e
        LEFT JOIN companies co ON co.id = e.company_id
       WHERE e.event_id = $1 AND (e.attendance_status = 'listed' OR $2::boolean)
    ),
    booths AS (
      SELECT b.exhibitor_id, array_agg(b.booth_number ORDER BY b.booth_number) AS booths
        FROM exhibitor_booths b
       WHERE b.retired_at IS NULL AND b.exhibitor_id IN (SELECT id FROM ex)
       GROUP BY b.exhibitor_id
    ),
    intel AS (
      SELECT x.exhibitor_id, array_agg(DISTINCT x.kind) AS kinds
        FROM (
          SELECT bi.exhibitor_id, bi.kind FROM booth_intel bi
           WHERE bi.exhibitor_id IN (SELECT id FROM ex)
             AND bi.retired_at IS NULL AND COALESCE(bi.review_status, 'ok') = 'ok'
          UNION ALL
          SELECT bmb.exhibitor_id, bi.kind FROM booth_intel bi
            JOIN booth_map_booths bmb ON bmb.id = bi.booth_id
           WHERE bi.exhibitor_id IS NULL AND bmb.exhibitor_id IN (SELECT id FROM ex)
             AND bmb.occupant_status = 'current' AND bmb.retired_at IS NULL
             AND bi.retired_at IS NULL AND COALESCE(bi.review_status, 'ok') = 'ok'
        ) x
       WHERE x.kind = ANY($3::text[])
       GROUP BY x.exhibitor_id
    ),
    mapcat AS (
      SELECT DISTINCT ON (bmb.exhibitor_id) bmb.exhibitor_id, bmb.category
        FROM booth_map_booths bmb
       WHERE bmb.exhibitor_id IN (SELECT id FROM ex)
         AND bmb.occupant_status = 'current' AND bmb.retired_at IS NULL
         AND COALESCE(bmb.category, '') <> ''
       ORDER BY bmb.exhibitor_id, bmb.booth_number
    )
    SELECT ex.*, COALESCE(bo.booths, '{}') AS booths, COALESCE(it.kinds, '{}') AS kinds,
           mc.category AS map_category
      FROM ex
      LEFT JOIN booths bo ON bo.exhibitor_id = ex.id
      LEFT JOIN intel it ON it.exhibitor_id = ex.id
      LEFT JOIN mapcat mc ON mc.exhibitor_id = ex.id`, [eventId, includeWithdrawn, kinds]);
  return rows;
}

async function loadMapBooths(pool, eventId) {
  const { rows } = await pool.query(
    `SELECT booth_number, source_company_name, source_company_name_zh, category, status
       FROM booth_map_booths WHERE event_id = $1 AND retired_at IS NULL`, [eventId]);
  return rows;
}

const isMapAvailable = (m) => !boothImport.isCompanyBooth({ nm: m.source_company_name, c: m.category });
const boothSort = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

/* What the SKQ map says about one exhibitor's official booths. The match rule
   is the sync's own (normalised name present at that booth), so this and the
   map's occupancy columns can never disagree about what "same" means. */
function mapCheck(ex, mapByBooth) {
  if (!ex.booths.length) return { code: 'no_booth', text: 'No booth assigned — not placed on SKQ map 未分配展位' };
  const key = normalizeNameKey(ex.source_name);
  const notes = [];
  let ok = 0;
  for (const b of ex.booths) {
    const m = mapByBooth.get(String(b));
    if (!m) notes.push(`${b}: not on SKQ map 展位图无此展位`);
    else if (isMapAvailable(m)) notes.push(`${b}: SKQ map shows Available 展位图显示为可用`);
    else if (normalizeNameKey(m.source_company_name) === key) ok++;
    else notes.push(`${b}: SKQ map shows "${m.source_company_name}"`);
  }
  if (!notes.length) return { code: 'match', text: 'Matches SKQ map 与展位图一致' };
  return { code: ok ? 'partial' : 'differs', text: notes.join('; ') };
}

/* A website column is a company field, but CRM data has addresses typed into
   it ("http://name@company.com"). Anything carrying an @ is a person, not a
   site, and is left out rather than published in a show directory. */
function publicWebsite(v) {
  const s = String(v || '').trim();
  if (!s || s.includes('@') || /\s/.test(s)) return '';
  return s;
}

function targetLabel(ex) {
  if (ex.kinds.includes('target_customer')) return 'Yes — SKQ curated 是（精选）';
  if (ex.map_category === 'customer') return 'Yes — SKQ map category 是（展位图类别）';
  return 'No 否';
}

function matchesFilter(ex, f) {
  if (f.unclassified) return !ex.map_category && !ex.kinds.length && !ex.pending;
  if (f.pending) return Boolean(ex.pending);
  if (f.kinds) return f.kinds.some((k) => ex.kinds.includes(k));
  if (f.mapCategory) return ex.map_category === f.mapCategory;
  return true;
}

/**
 * Everything a download needs, read once, so the floor plan's index, the
 * workbook and the CSV generated from one call describe the same moment.
 * Read-only: SELECTs only.
 */
/* Live mode: is each of this exhibitor's official booths drawn on the map? */
function liveCheck(ex, drawnAt, unplaced) {
  if (ex.attendance_status !== 'listed') return { code: 'withdrawn', text: 'Withdrawn — not drawn 已撤展，未绘制' };
  if (!ex.booths.length) return { code: 'no_booth', text: 'No booth assigned — not placed on SKQ map 未分配展位' };
  const notes = [];
  for (const b of ex.booths) {
    if (drawnAt.has(`${ex.id}@${b}`)) continue;
    notes.push(unplaced.has(String(b))
      ? `${b}: position pending manual placement 待人工定位`
      : `${b}: not drawn 未绘制`);
  }
  if (!notes.length) return { code: 'match', text: 'Drawn at official booth 已按官方展位绘制' };
  return { code: notes.length < ex.booths.length ? 'partial' : 'differs', text: notes.join('; ') };
}

function liveBoothIndex(model, occupants) {
  const row = (n, status, occ) => ({
    booth: n,
    exhibitors: (occupants.get(n) || []).map((o) => o.source_name),
    map_name: occ.map((id) => model.exhibitors[id].name).join(' / ') || (status === 'available' ? 'Available' : ''),
    map_name_zh: occ.map((id) => model.exhibitors[id].zh).filter(Boolean).join(' / '),
    map_category: occ.map((id) => MAP_CATEGORY_LABELS[model.exhibitors[id].category]
      || ((model.exhibitors[id].pending || []).length ? 'Pending identity review 待身份审核' : 'Unclassified 未分类')).join(' / '),
    status,
  });
  return [
    ...model.booths.map((b) => row(b.n, LIVE_BOOTH_STATUS[b.st] || b.st, b.occ)),
    ...model.unplaced.map((u) => row(u.n, 'unplaced', u.occ)),
  ].sort((a, b) => boothSort(a.booth, b.booth));
}

const LIVE_BOOTH_STATUS = { assigned: 'match', shared: 'match', vacant: 'available', on_hold: 'on_hold', unverified: 'unverified' };

/**
 * Everything a download needs. With `model` (the live Booth Map model), the
 * classification and map position of every listed exhibitor come from that
 * model — the same object the map draws — so the file and the map cannot
 * disagree. Without it, the snapshot comparison is used exactly as before.
 */
async function buildSnapshot(pool, input = {}, { model = null } = {}) {
  const opts = normalizeOptions(input);
  const eventId = await outreach.resolveEventId(pool);
  if (!eventId) throw new ExportError('no_event', 'No exhibitor list has been imported yet.', 503);

  const [event, run, mapImport, exhibitors, mapBooths] = await Promise.all([
    outreach.eventMeta(pool, eventId),
    loadRun(pool, eventId),
    loadMapImport(pool, eventId),
    loadExhibitors(pool, eventId, opts.includeWithdrawn),
    loadMapBooths(pool, eventId),
  ]);
  const served = servedMapVersion();

  if (model) {
    for (const e of exhibitors) {
      const m = model.exhibitors[e.id];
      if (m) { e.kinds = m.kinds; e.map_category = m.category; e.pending = m.pending && m.pending.length ? m.pending : null; }
    }
  }
  const drawnAt = new Set();
  if (model) for (const b of model.booths) for (const id of b.occ) drawnAt.add(`${id}@${b.n}`);
  const unplacedSet = new Set(model ? model.unplaced.map((u) => u.n) : []);
  const checkOf = (e) => (model ? liveCheck(e, drawnAt, unplacedSet) : mapCheck(e, mapByBooth));

  const mapByBooth = new Map(mapBooths.map((m) => [String(m.booth_number), m]));
  const listed = exhibitors.filter((e) => e.attendance_status === 'listed');

  // Who stands where, from listed exhibitors only: a withdrawn company shares nothing.
  const occupants = new Map();
  for (const e of listed) {
    for (const b of e.booths) {
      const k = String(b);
      if (!occupants.has(k)) occupants.set(k, []);
      occupants.get(k).push(e);
    }
  }

  const sourceNote = run ? `${OFFICIAL_SOURCE_LABEL} · run #${run.id}` : OFFICIAL_SOURCE_LABEL;
  const filter = FILTERS[opts.filter];
  const selected = exhibitors.filter((e) => matchesFilter(e, filter));

  /* One row per exhibitor–company relationship: the exhibitor's own CRM link
     (or none), plus one row per live reviewed "same company" decision. */
  const rels = await relations.liveSameCompany(pool, selected.map((e) => e.id));
  const relCompanyIds = [...new Set(rels.map((r) => r.related_company_id))];
  const relCompanies = new Map();
  if (relCompanyIds.length) {
    const { rows } = await pool.query(
      'SELECT id, name, chinese_name, website, industry FROM companies WHERE id = ANY($1::int[])', [relCompanyIds]);
    for (const c of rows) relCompanies.set(c.id, c);
  }
  const relsByEx = new Map();
  for (const r of rels) relsByEx.set(r.exhibitor_id, [...(relsByEx.get(r.exhibitor_id) || []), r]);

  const rows = [];
  for (const e of selected.sort((a, b) => (a.company_name || a.source_name)
    .localeCompare(b.company_name || b.source_name, 'en', { sensitivity: 'base' }))) {
    const shared = new Set();
    for (const b of e.booths) {
      for (const o of occupants.get(String(b)) || []) if (o.id !== e.id) shared.add(`${o.source_name} (${b})`);
    }
    const check = checkOf(e);
    const classification = KIND_ORDER.filter((k) => e.kinds.includes(k)).map((k) => KIND_LABELS[k]);
    const base = {
      official_name: e.source_name,
      booths: e.booths.length ? e.booths.join(', ') : 'No booth assigned 未分配展位',
      booth_count: e.booths.length,
      shared_with: [...shared].join('; '),
      hall: e.hall || '',
      exhibitor_source_id: e.exhibitor_source_id,
      exhibitor_record_id: e.id,
      map_category: MAP_CATEGORY_LABELS[e.map_category] || e.map_category
        || (model && e.pending ? `Pending identity review 待身份审核 (was “${e.pending.map((p) => p.company).join('; ')}”)` : '')
        || (model && e.attendance_status === 'listed' ? 'Unclassified 未分类' : ''),
      classification: classification.join('; '),
      target: targetLabel(e),
      attendance: e.attendance_status === 'listed' ? 'Listed 已列入' : 'Withdrawn 已撤展',
      map_check: check.text,
      map_check_code: check.code,
      last_verified: e.last_verified_at ? new Date(e.last_verified_at) : null,
      source: sourceNote,
    };
    rows.push({
      ...base,
      company: e.company_name || e.source_name,
      chinese_name: e.chinese_name || '',
      crm_company_id: e.company_id || null,
      link: e.company_id ? `Direct link 直接关联 (${e.match_confidence || 'matched'})` : 'Not linked to CRM 未关联CRM',
      website: publicWebsite(e.website),
      industry: e.industry || '',
    });
    for (const r of relsByEx.get(e.id) || []) {
      const c = relCompanies.get(r.related_company_id) || {};
      rows.push({
        ...base,
        company: c.name || r.company_name,
        chinese_name: c.chinese_name || '',
        crm_company_id: r.related_company_id,
        link: `Reviewed same company 人工确认同一公司 (relation #${r.relation_id})`,
        website: publicWebsite(c.website),
        industry: c.industry || '',
      });
    }
  }

  /* Booth index: the union of the official booths and the map's booths, so a
     booth that exists on only one side is visible rather than missing. In live
     mode the map IS the official occupancy, so the index is the drawn booths
     plus any official booth still awaiting a position. */
  const boothNumbers = new Set([...occupants.keys(), ...mapByBooth.keys()]);
  const booths = model ? liveBoothIndex(model, occupants) : [...boothNumbers].sort(boothSort).map((n) => {
    const occ = occupants.get(n) || [];
    const m = mapByBooth.get(n);
    const mapName = m ? (isMapAvailable(m) ? 'Available' : m.source_company_name) : '';
    let status;
    if (!m) status = 'official_only';
    else if (!occ.length) status = isMapAvailable(m) ? 'available' : 'map_only';
    else if (isMapAvailable(m)) status = 'differs';
    else status = occ.some((o) => normalizeNameKey(o.source_name) === normalizeNameKey(m.source_company_name))
      ? 'match' : 'differs';
    return {
      booth: n,
      exhibitors: occ.map((o) => o.source_name),
      map_name: mapName,
      map_name_zh: m && !isMapAvailable(m) ? (m.source_company_name_zh || '') : '',
      map_category: m ? (MAP_CATEGORY_LABELS[m.category] || m.category || '') : '',
      status,
    };
  });

  const count = (s) => booths.filter((b) => b.status === s).length;
  const differences = model ? {
    booths_matching: count('match'),
    booths_different_occupant: 0,
    booths_official_not_on_map: count('unplaced'),
    booths_on_map_not_official: 0,
    exhibitors_not_matching_map: listed.filter((e) => !['match', 'no_booth'].includes(checkOf(e).code)).length,
    booths_unverified: count('unverified'),
    historical_booths: model.historical.length,
    review_items: model.review.length,
  } : {
    booths_matching: count('match'),
    booths_different_occupant: count('differs'),
    booths_official_not_on_map: count('official_only'),
    booths_on_map_not_official: count('map_only'),
    // Exhibitors WITH a booth that the map disagrees about; no-booth ones are counted under without_booth.
    exhibitors_not_matching_map: listed.filter((e) => !['match', 'no_booth'].includes(checkOf(e).code)).length,
  };
  const verifiedAt = run ? run.finished_at : event.verified_at;
  const ageHours = verifiedAt ? (Date.now() - new Date(verifiedAt).getTime()) / 36e5 : null;

  return {
    generated_at: new Date(),
    event: { id: event.id, name: event.name },
    filter: { id: opts.filter, label: filter.label },
    include_withdrawn: opts.includeWithdrawn,
    official: {
      source: OFFICIAL_SOURCE_LABEL,
      floor_plan_url: OFFICIAL_FLOOR_PLAN_URL,
      verified_at: verifiedAt || null,
      verified_age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      run_id: run ? run.id : null,
      source_version: run ? run.source_version : null,
      listed: listed.length,
      with_booth: listed.filter((e) => e.booths.length).length,
      without_booth: listed.filter((e) => !e.booths.length).length,
    },
    map: {
      imported_at: mapImport ? mapImport.finished_at : null,
      import_version: mapImport ? mapImport.source_version : null,
      served_version: served ? served.version : null,
      // null when either side is unknown — never a guess in either direction.
      in_sync: mapImport && served ? mapImport.source_version === served.version : null,
      booths: mapBooths.length,
      company_booths: mapBooths.filter((m) => !isMapAvailable(m)).length,
      available_booths: mapBooths.filter(isMapAvailable).length,
      mode: model ? 'live' : 'snapshot',
      model_version: model ? model.version : null,
      geometry_version: model ? model.geometry.version : null,
      geometry_fetched_at: model ? model.geometry.fetched_at : null,
      drawn_booths: model ? model.booths.length : null,
    },
    differences,
    rows,
    exhibitor_count: selected.length,
    booths,
    no_booth: listed.filter((e) => !e.booths.length).map((e) => e.source_name).sort(),
  };
}

/* ── Files ──────────────────────────────────────────────────────────────── */

const COLUMNS = [
  { key: 'company', header: 'Company 公司', width: 34 },
  { key: 'chinese_name', header: 'Chinese name 中文名', width: 20 },
  { key: 'official_name', header: 'Official exhibitor name 官方展商名', width: 34 },
  { key: 'booths', header: 'Booth number(s) 展位号', width: 18 },
  { key: 'booth_count', header: 'Booth count 展位数', width: 10 },
  { key: 'shared_with', header: 'Shares booth with 同展位展商', width: 30 },
  { key: 'hall', header: 'Hall 展馆', width: 10 },
  { key: 'exhibitor_source_id', header: 'Official exhibitor ID 官方展商ID', width: 16 },
  { key: 'exhibitor_record_id', header: 'SKQ exhibitor record 展商记录ID', width: 14 },
  { key: 'crm_company_id', header: 'CRM company ID 公司ID', width: 12 },
  { key: 'link', header: 'CRM relationship 关联方式', width: 30 },
  { key: 'website', header: 'Website 官网', width: 28 },
  { key: 'industry', header: 'Industry 行业', width: 22 },
  { key: 'map_category', header: 'SKQ map category 展位图类别', width: 24 },
  { key: 'classification', header: 'SKQ classification 思客琦分类', width: 30 },
  { key: 'target', header: 'Target customer 目标客户', width: 22 },
  { key: 'attendance', header: 'Official listing status 参展状态', width: 16 },
  { key: 'map_check', header: 'SKQ map vs official 展位图核对', width: 36 },
  { key: 'last_verified', header: 'Last verified 最后核实', width: 18 },
  { key: 'source', header: 'Data source 数据来源', width: 40 },
];

const BOOTH_COLUMNS = [
  { key: 'booth', header: 'Booth 展位号', width: 12 },
  { key: 'exhibitors', header: 'Official exhibitor(s) 官方展商', width: 44 },
  { key: 'exhibitor_count', header: 'Exhibitors 展商数', width: 10 },
  { key: 'map_name', header: 'SKQ map label 展位图标注', width: 36 },
  { key: 'map_name_zh', header: 'SKQ map label (中文)', width: 20 },
  { key: 'map_category', header: 'SKQ map category 展位图类别', width: 24 },
  { key: 'status', header: 'Map vs official 核对结果', width: 30 },
];

const BOOTH_STATUS_LABELS = {
  match: 'Matches 一致',
  differs: 'Different occupant 展商不同',
  official_only: 'Official only — not on SKQ map 展位图无此展位',
  map_only: 'On SKQ map, no official exhibitor 官方无展商',
  available: 'Available 可用',
  on_hold: 'On hold (official) 官方保留',
  unverified: 'Reserved, occupant not in verified list 已预订，展商待核实',
  unplaced: 'Official booth — position pending manual placement 待人工定位',
};

const { neutralize } = outreach;

function cellValue(v) {
  if (v instanceof Date || typeof v === 'number') return v;
  return neutralize(v);
}

function csvCell(v) {
  const s = v instanceof Date ? v.toISOString() : neutralize(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(snapshot) {
  const lines = [COLUMNS.map((c) => csvCell(c.header)).join(',')];
  for (const r of snapshot.rows) lines.push(COLUMNS.map((c) => csvCell(r[c.key])).join(','));
  // BOM so Excel opens UTF-8 (Chinese names) correctly; CRLF as Excel writes it.
  return `﻿${lines.join('\r\n')}\r\n`;
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9F7' } };
const HEADER_FONT = { bold: true, color: { argb: 'FF3D1E6E' } };

function styleTable(ws, columns) {
  const head = ws.getRow(1);
  head.font = HEADER_FONT;
  head.fill = HEADER_FILL;
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 32;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

function fmtDate(d) {
  if (!d) return 'Never 从未';
  return `${new Date(d).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function metadataRows(s) {
  const o = s.official, m = s.map, d = s.differences;
  const stale = o.verified_age_hours !== null && o.verified_age_hours > 24;
  return [
    ['Event 展会', s.event.name || ''],
    ['Generated 生成时间', fmtDate(s.generated_at)],
    ['Scope 范围', s.filter.label + (s.include_withdrawn ? ' · including withdrawn 含已撤展' : ' · listed exhibitors only 仅已列入展商')],
    ['Exhibitors in this file 本文件展商数', s.exhibitor_count],
    ['Rows 行数', `${s.rows.length} (one per exhibitor–company relationship 每个展商-公司关系一行)`],
    [],
    ['EXHIBITOR DATA 展商数据', ''],
    ['Source 来源', o.source],
    ['Last verified 最后核实', fmtDate(o.verified_at)],
    ['Verification run 核实批次', o.run_id ? `#${o.run_id}` : 'None 无'],
    ['Source fingerprint 数据指纹', o.source_version || ''],
    ['Listed exhibitors 已列入展商', `${o.listed} (${o.with_booth} with a booth 有展位, ${o.without_booth} without 无展位)`],
    ['Freshness 时效', (stale
      ? `Last verified ${Math.round(o.verified_age_hours / 24)} day(s) ago — the official list may have changed since. `
      : 'Verified within the last 24 hours. ')
      + 'This download did not re-check the official source; an admin can run Refresh Exhibitor Data 更新展商数据 to check for changes.'],
    [],
    ['SKQ BOOTH MAP 思客琦展位图', ''],
    ['Map mode 展位图模式', m.mode === 'live'
      ? `Live — occupancy from verified run #${o.run_id}, geometry plan ${m.geometry_version}, model ${m.model_version} 实时`
      : 'Snapshot — the map’s embedded data 快照'],
    ['What it is 说明', 'SKQ’s curated floor plan. It is NOT the organizer’s official floor plan and is not updated automatically.'],
    ['Map snapshot imported 展位图快照导入', fmtDate(m.imported_at)],
    ['Map snapshot version 展位图版本', m.import_version || ''],
    ['Served map matches snapshot 当前展位图与快照一致', m.in_sync === null ? 'Unknown 未知' : (m.in_sync ? 'Yes 是' : `No 否 — served file is ${m.served_version}`)],
    ['Map booths 展位图展位数', `${m.booths} (${m.company_booths} labelled with a company, ${m.available_booths} available)`],
    [],
    ['MAP VS OFFICIAL LIST 展位图与官方名单对比', ''],
    ['Booths matching 一致展位', d.booths_matching],
    ['Booths with a different occupant 展商不同', d.booths_different_occupant],
    ['Official booths not on SKQ map 官方有、展位图无', d.booths_official_not_on_map],
    ['Map booths with no official exhibitor 展位图有、官方无', d.booths_on_map_not_official],
    ['Listed exhibitors whose booths differ from the map 展位与展位图不一致的展商', d.exhibitors_not_matching_map],
    [],
    ['Official organizer floor plan 主办方官方展位图', o.floor_plan_url],
    ['Contents 内容', 'Company-level data only. No contact names, emails or phone numbers are included. 不含联系人信息。'],
  ];
}

async function toXlsx(snapshot) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SKQ CRM';
  wb.created = snapshot.generated_at;
  wb.title = `Exhibitors — ${snapshot.event.name || ''}`;

  const ws = wb.addWorksheet('Exhibitors 展商', { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  for (const r of snapshot.rows) {
    const out = {};
    for (const c of COLUMNS) out[c.key] = cellValue(r[c.key]);
    const row = ws.addRow(out);
    // A row without a booth or out of step with the map should be findable by eye.
    if (r.booth_count === 0) row.getCell('booths').font = { italic: true, color: { argb: 'FF9A6700' } };
    if (r.map_check_code !== 'match') row.getCell('map_check').font = { color: { argb: 'FFA21D2A' } };
  }
  ws.getColumn('last_verified').numFmt = 'yyyy-mm-dd hh:mm';
  styleTable(ws, COLUMNS);

  const bs = wb.addWorksheet('Booths 展位', { views: [{ state: 'frozen', ySplit: 1 }] });
  bs.columns = BOOTH_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  for (const b of snapshot.booths) {
    bs.addRow({
      booth: neutralize(b.booth),
      exhibitors: neutralize(b.exhibitors.join('; ')),
      exhibitor_count: b.exhibitors.length,
      map_name: neutralize(b.map_name),
      map_name_zh: neutralize(b.map_name_zh),
      map_category: neutralize(b.map_category),
      status: BOOTH_STATUS_LABELS[b.status] || b.status,
    });
  }
  styleTable(bs, BOOTH_COLUMNS);

  const ms = wb.addWorksheet('About 说明');
  ms.columns = [{ key: 'k', width: 46 }, { key: 'v', width: 96 }];
  for (const [k, v] of metadataRows(snapshot)) {
    const row = ms.addRow({ k: k === undefined ? '' : k, v: v === undefined ? '' : cellValue(v) });
    row.getCell('v').alignment = { wrapText: true, vertical: 'top' };
    row.getCell('k').alignment = { vertical: 'top' };
    if (k && v === '') row.font = HEADER_FONT;
  }
  return wb.xlsx.writeBuffer();
}

function filename(snapshot, ext) {
  const verified = snapshot.official.verified_at
    ? new Date(snapshot.official.verified_at).toISOString().slice(0, 10) : 'unverified';
  return `battery-show-2026_exhibitors_${snapshot.filter.id}_verified-${verified}.${ext}`;
}

/* What the floor-plan export prints beside the map: provenance, the gap
   between map and list, and a booth index. No per-exhibitor CRM fields. */
function manifest(snapshot) {
  const { rows, ...rest } = snapshot;
  return {
    ...rest,
    booths: snapshot.booths.map((b) => ({ ...b, status_label: BOOTH_STATUS_LABELS[b.status] || b.status })),
  };
}

module.exports = {
  buildSnapshot, toCsv, toXlsx, filename, manifest, normalizeOptions, mapCheck, servedMapVersion, publicWebsite,
  loadExhibitors,
  ExportError, FILTERS, COLUMNS, BOOTH_COLUMNS, KIND_LABELS, OFFICIAL_FLOOR_PLAN_URL,
};
