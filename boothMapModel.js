/* ═══════════════════════════════════════════════════════════════════════════
   Booth Map model — one answer to "what does the map show", for everyone.

   The visual map, the floor-plan PDF/PNG, the exhibitor Excel/CSV and the AI
   Assistant all read this, so they cannot disagree about who is where. Three
   inputs, each versioned and each authoritative for one thing only:

     occupancy        the latest SUCCESSFUL official exhibitor run
                      (event_exhibitors + exhibitor_booths)
     geometry         the reviewed geometry plan (data/booth-geometry/*.json,
                      built by scripts/booth-geometry-plan.js)
     classification   SKQ's curated judgements, as imported from the map
                      (booth_map_booths + booth_intel), resolved to the
                      COMPANY they were made about — never to a booth number

   A classification follows its company to whatever booth it holds now. It is
   attached to an exhibitor only through an identity the system already has:

     sync_anchor        the refresh already linked this map row to the exhibitor
     exact_name         normalised names are identical
     crm_company        both sides already point at the same CRM company record
     reviewed_relation  an admin recorded "same company" for this exhibitor

   Nothing is guessed. A classification whose company cannot be found this way
   is not drawn on anyone's booth; it goes to the admin review list, either as
   "possible rename" (a listed exhibitor has a similar name) or as "left the
   show". No company is merged and nothing is written: every query is a SELECT.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const outreach = require('./outreach');
const relations = require('./outreachRelations');
const { normalizeNameKey } = require('./companyKey');
const boothImport = require('./boothImport');

const PLAN_PATH = path.join(__dirname, 'data', 'booth-geometry', 'tbsm26.json');
const INTEL_KINDS = outreach.INTEL_KINDS;     // the five company judgements
const TIERS = ['sync_anchor', 'exact_name', 'crm_company', 'reviewed_relation'];

class ModelError extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}

/* ── Geometry plan ─────────────────────────────────────────────────────── */

let planCache = null;
function loadPlan(file = PLAN_PATH) {
  let stat;
  try { stat = fs.statSync(file); } catch {
    throw new ModelError('no_geometry', 'The booth geometry plan is missing on this server.');
  }
  if (!planCache || planCache.file !== file || planCache.mtimeMs !== stat.mtimeMs) {
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!plan.version || !Array.isArray(plan.booths) || !Array.isArray(plan.historical)) {
      throw new ModelError('bad_geometry', 'The booth geometry plan is malformed.');
    }
    planCache = { file, mtimeMs: stat.mtimeMs, plan };
  }
  return planCache.plan;
}

/* ── Identity ──────────────────────────────────────────────────────────── */

const STOP = new Set(['inc', 'llc', 'ltd', 'corp', 'co', 'gmbh', 'the', 'and', 'company', 'technology',
  'technologies', 'corporation', 'group', 'limited', 'usa', 'america', 'north', 'international', 'systems',
  'solutions', 'industries', 'kg', 'ag', 'sa', 'spa', 'bv', 'nv', 'srl', 'plc', 'de', 'cv']);
function tokens(name) {
  return new Set(normalizeNameKey(name).split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)));
}
/* A shared DISTINCTIVE word — one that appears in at most RARE exhibitor
   names, so "Automation" or "Materials" never pair two unrelated companies.
   Only ever used to route a classification to a human; it attaches nothing. */
const RARE = 2;
function documentFrequency(names) {
  const df = new Map();
  for (const n of names) for (const t of tokens(n)) df.set(t, (df.get(t) || 0) + 1);
  return df;
}
function similarNames(a, b, df = null) {
  const A = tokens(a);
  for (const t of tokens(b)) if (A.has(t) && (!df || (df.get(t) || 0) <= RARE)) return true;
  return false;
}

/**
 * Pure: snapshot profiles + listed exhibitors → which exhibitor each profile
 * belongs to. Each tier must name exactly one exhibitor; two candidates in a
 * tier is ambiguity, and ambiguity is a review item, not a pick.
 */
function resolveProfiles(profiles, exhibitors, reviewedByCompany = new Map()) {
  const byId = new Map(exhibitors.map((e) => [e.id, e]));
  const byKey = new Map();
  const byCompany = new Map();
  for (const e of exhibitors) {
    const k = normalizeNameKey(e.source_name);
    byKey.set(k, [...(byKey.get(k) || []), e]);
    if (e.company_id) byCompany.set(e.company_id, [...(byCompany.get(e.company_id) || []), e]);
  }
  const df = documentFrequency(exhibitors.map((e) => e.source_name));
  const out = [];
  for (const p of profiles) {
    const candidates = {
      sync_anchor: p.exhibitor_id && byId.has(p.exhibitor_id) ? [byId.get(p.exhibitor_id)] : [],
      exact_name: byKey.get(normalizeNameKey(p.name)) || [],
      crm_company: p.company_id ? (byCompany.get(p.company_id) || []) : [],
      reviewed_relation: p.company_id
        ? (reviewedByCompany.get(p.company_id) || []).map((id) => byId.get(id)).filter(Boolean) : [],
    };
    let resolved = null;
    let ambiguous = null;
    for (const tier of TIERS) {
      const c = [...new Map(candidates[tier].map((e) => [e.id, e])).values()];
      if (c.length === 1) { resolved = { exhibitor: c[0], tier }; break; }
      if (c.length > 1) { ambiguous = { tier, candidates: c.map((e) => e.source_name) }; break; }
    }
    if (resolved) { out.push({ profile: p, ...resolved }); continue; }
    if (ambiguous) {
      out.push({ profile: p, review: 'ambiguous', detail: `${ambiguous.tier}: ${ambiguous.candidates.join(' | ')}` });
      continue;
    }
    const similar = exhibitors.filter((e) => similarNames(e.source_name, p.name, df)).map((e) => e.source_name);
    out.push({ profile: p, review: similar.length ? 'possible_rename' : 'left_show',
      detail: similar.slice(0, 5).join(' | ') });
  }
  return out;
}

/* ── Reads ─────────────────────────────────────────────────────────────── */

async function loadRun(pool, eventId) {
  const { rows: [run] } = await pool.query(
    `SELECT id, finished_at, source_version, fetched FROM exhibitor_import_runs
      WHERE status = 'success' AND dry_run = FALSE AND (event_id = $1 OR event_id IS NULL)
      ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`, [eventId]);
  return run || null;
}

async function loadExhibitors(pool, eventId) {
  const { rows } = await pool.query(
    `SELECT e.id, e.exhibitor_source_id, e.source_name, e.company_id,
            co.name AS company_name, co.chinese_name,
            COALESCE(array_agg(b.booth_number ORDER BY b.booth_number)
                     FILTER (WHERE b.booth_number IS NOT NULL), '{}') AS booths
       FROM event_exhibitors e
       LEFT JOIN companies co ON co.id = e.company_id
       LEFT JOIN exhibitor_booths b ON b.exhibitor_id = e.id AND b.retired_at IS NULL
      WHERE e.event_id = $1 AND e.attendance_status = 'listed'
      GROUP BY e.id, co.name, co.chinese_name`, [eventId]);
  return rows.map((r) => ({ ...r, booths: r.booths.map(String) }));
}

/* Every company the snapshot map named, with what SKQ concluded about it.
   Retired intel is excluded; intel flagged for review stays in, because the
   flag was about the BOOTH changing hands — the judgement is still about this
   company, and following the company is exactly what resolves that. */
async function loadProfiles(pool, eventId) {
  const { rows } = await pool.query(
    `SELECT b.booth_number, b.source_company_name AS name, b.source_company_name_zh AS name_zh,
            b.category, b.exhibitor_id, b.occupant_status,
            /* A CRM link the importer made BY BOOTH NUMBER is a statement about
               the booth, not the company, so it is not an identity here. */
            CASE WHEN b.match_method IN ('name_exact', 'name_key') THEN b.company_id END AS company_id,
            COALESCE(array_agg(DISTINCT i.kind) FILTER (WHERE i.kind = ANY($2::text[])), '{}') AS kinds
       FROM booth_map_booths b
       LEFT JOIN booth_intel i ON i.booth_id = b.id AND i.retired_at IS NULL
      WHERE b.event_id = $1 AND b.retired_at IS NULL
      GROUP BY b.id`, [eventId, INTEL_KINDS]);
  return rows
    .filter((r) => boothImport.isCompanyBooth({ nm: r.name, c: r.category }))
    .map((r) => ({ ...r, booth_number: String(r.booth_number) }));
}

async function loadReviewed(pool, exhibitorIds) {
  const byCompany = new Map();
  for (const r of await relations.liveSameCompany(pool, exhibitorIds)) {
    byCompany.set(r.related_company_id, [...(byCompany.get(r.related_company_id) || []), r.exhibitor_id]);
  }
  return byCompany;
}

async function loadMapImport(pool, eventId) {
  const { rows: [run] } = await pool.query(
    `SELECT finished_at, source_version FROM booth_import_runs
      WHERE status = 'success' AND dry_run = FALSE AND (event_id = $1 OR event_id IS NULL)
      ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`, [eventId]);
  return run || null;
}

/* ── Model ─────────────────────────────────────────────────────────────── */

/** Pure assembly, so the rules can be tested without a database. */
function assemble({ run, plan, exhibitors, resolutions, mapImport, event }) {
  // Company → classification, merged across the snapshot booths it held.
  const cls = new Map();
  for (const r of resolutions) {
    if (!r.exhibitor) continue;
    const c = cls.get(r.exhibitor.id) || { kinds: new Set(), category: null, from: [], tiers: new Set(), zh: null };
    r.profile.kinds.forEach((k) => c.kinds.add(k));
    // A specific category beats "other"; the first specific one wins, deterministically.
    if (r.profile.category && (!c.category || (c.category === 'other' && r.profile.category !== 'other'))) {
      c.category = r.profile.category;
    }
    if (!c.zh && r.profile.name_zh) c.zh = r.profile.name_zh;
    c.from.push(r.profile.booth_number);
    c.tiers.add(r.tier);
    cls.set(r.exhibitor.id, c);
  }

  const exhibitorOut = {};
  const byBooth = new Map();
  for (const e of exhibitors) {
    const c = cls.get(e.id);
    exhibitorOut[e.id] = {
      name: e.source_name,
      zh: (c && c.zh) || e.chinese_name || '',
      company_id: e.company_id || null,
      kinds: c ? INTEL_KINDS.filter((k) => c.kinds.has(k)) : [],
      category: c ? c.category : null,                 // null = unclassified
      from: c ? [...new Set(c.from)].sort() : [],       // snapshot booths the profile came from
      tier: c ? [...c.tiers][0] : null,
      booths: e.booths,
    };
    for (const b of e.booths) byBooth.set(b, [...(byBooth.get(b) || []), e.id]);
  }

  const booths = [];
  const drawn = new Set();
  for (const g of plan.booths) {
    if (g.decision === 'unplaced' || g.decision === 'placeholder') continue;
    const occ = (byBooth.get(g.n) || []).sort((a, b) => exhibitorOut[a].name.localeCompare(exhibitorOut[b].name));
    let status;
    if (occ.length > 1) status = 'shared';
    else if (occ.length === 1) status = 'assigned';
    else if (/^available$/i.test(g.official_status)) status = 'vacant';
    else if (/hold/i.test(g.official_status)) status = 'on_hold';
    else status = 'unverified';                 // reserved in the floor plan, nobody in the verified list
    booths.push({ n: g.n, x: g.x, y: g.y, dims: g.dims, st: status, geo: g.decision, occ });
    drawn.add(g.n);
  }
  const historical = plan.historical.map((h) => ({ n: h.n, x: h.x, y: h.y }));
  const unplaced = plan.booths.filter((g) => g.decision === 'unplaced')
    .map((g) => ({ n: g.n, dims: g.dims, note: g.note, occ: byBooth.get(g.n) || [] }));
  const notDrawn = [];
  for (const [b, ids] of byBooth) if (!drawn.has(b)) notDrawn.push({ booth: b, exhibitors: ids.map((id) => exhibitorOut[id].name) });

  const version = crypto.createHash('sha256').update(JSON.stringify({
    run: run && [run.id, run.source_version], plan: plan.version,
    map: mapImport && mapImport.source_version,
    cls: [...cls.entries()].map(([id, c]) => [id, [...c.kinds].sort(), c.category]).sort((a, b) => a[0] - b[0]),
  })).digest('hex').slice(0, 12);

  const review = resolutions.filter((r) => r.review).map((r) => ({
    kind: r.review, snapshot_booth: r.profile.booth_number, company: r.profile.name,
    classifications: r.profile.kinds, category: r.profile.category, detail: r.detail,
  }));
  const tierCounts = {};
  for (const r of resolutions) if (r.tier) tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;

  return {
    version,
    event: event || null,
    official: run ? { run_id: run.id, verified_at: run.finished_at, source_version: run.source_version } : null,
    geometry: { version: plan.version, fetched_at: plan.source && plan.source.fetched_at, counts: plan.counts },
    snapshot: mapImport ? { version: mapImport.source_version, imported_at: mapImport.finished_at } : null,
    booths, historical, unplaced, not_drawn: notDrawn,
    // Deliberately not drawn (empty placeholders); kept so the decision is auditable.
    placeholders: plan.booths.filter((g) => g.decision === 'placeholder')
      .map((g) => ({ n: g.n, note: g.note, occ: byBooth.get(g.n) || [] })),
    no_booth: exhibitors.filter((e) => !e.booths.length).map((e) => e.source_name),
    exhibitors: exhibitorOut,
    review,
    identity_tiers: tierCounts,
    // Where each snapshot company's classification went. Server-side detail
    // for the preview and tests; the map endpoint does not send it.
    profiles: resolutions.map((r) => ({
      snapshot_booth: r.profile.booth_number, company: r.profile.name, kinds: r.profile.kinds,
      category: r.profile.category, exhibitor_id: r.exhibitor ? r.exhibitor.id : null,
      tier: r.tier || null, review: r.review || null,
    })),
  };
}

/**
 * The live model. Read-only; throws ModelError when it cannot honestly be
 * built (no verified run, no geometry plan) so callers fall back VISIBLY.
 */
async function buildModel(pool, { planFile } = {}) {
  const plan = loadPlan(planFile);
  const eventId = await outreach.resolveEventId(pool);
  if (!eventId) throw new ModelError('no_event', 'No verified exhibitor list is available yet.');
  const [event, run, exhibitors, profiles, mapImport] = await Promise.all([
    outreach.eventMeta(pool, eventId), loadRun(pool, eventId), loadExhibitors(pool, eventId),
    loadProfiles(pool, eventId), loadMapImport(pool, eventId),
  ]);
  if (!run) throw new ModelError('no_run', 'No successful exhibitor verification has run yet.');
  const reviewed = await loadReviewed(pool, exhibitors.map((e) => e.id));
  const resolutions = resolveProfiles(profiles, exhibitors, reviewed);
  return assemble({ run, plan, exhibitors, resolutions, mapImport, event: { id: event.id, name: event.name } });
}

/* ── Validation ────────────────────────────────────────────────────────── */

/**
 * What the model claims, checked against the official run it was built from.
 * Returns failures rather than throwing, so the preview can show them.
 */
function validate(model) {
  const failures = [];
  const drawnAt = new Map();
  for (const b of model.booths) for (const id of b.occ) drawnAt.set(`${id}@${b.n}`, true);
  const unplaced = new Set(model.unplaced.map((u) => u.n));
  let assigned = 0, drawnOk = 0;
  const pending = [];
  for (const [id, e] of Object.entries(model.exhibitors)) {
    if (!e.booths.length) continue;
    assigned++;
    const waiting = e.booths.filter((b) => unplaced.has(b));
    const missing = e.booths.filter((b) => !drawnAt.has(`${id}@${b}`) && !unplaced.has(b));
    if (missing.length) failures.push({ type: 'not_drawn', exhibitor: e.name, booths: missing });
    // Known and listed, so not a failure — but not "drawn" either.
    else if (waiting.length) pending.push({ exhibitor: e.name, booths: waiting });
    else drawnOk++;
  }
  const shared = model.booths.filter((b) => b.st === 'shared');
  for (const b of shared) if (b.occ.length < 2) failures.push({ type: 'shared_without_two', booth: b.n });
  const fromProfiles = new Map();
  for (const p of model.profiles || []) {
    if (!p.exhibitor_id) continue;
    const set = fromProfiles.get(p.exhibitor_id) || new Set();
    p.kinds.forEach((k) => set.add(k));
    fromProfiles.set(p.exhibitor_id, set);
  }
  for (const [id, e] of Object.entries(model.exhibitors)) {
    const own = fromProfiles.get(Number(id)) || new Set();
    const foreign = e.kinds.filter((k) => !own.has(k));
    if (foreign.length) failures.push({ type: 'classification_not_from_company', exhibitor: e.name, kinds: foreign });
  }
  const cells = new Map();
  for (const b of model.booths) {
    const k = `${b.x},${b.y}`;
    if (cells.has(k)) failures.push({ type: 'same_cell', booths: [cells.get(k), b.n] });
    cells.set(k, b.n);
  }
  return { assigned_exhibitors: assigned, drawn_at_every_booth: drawnOk, pending_placement: pending,
    shared_booths: shared.length, failures };
}

module.exports = {
  buildModel, assemble, resolveProfiles, validate, loadPlan, similarNames,
  ModelError, PLAN_PATH, TIERS,
};
