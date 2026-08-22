/* ═══════════════════════════════════════════════════════════════════════════
   Booth map → Postgres, as a rerunnable synchronization.

   The Battery Show booth data is curated by hand and lives as literal arrays
   inside public/booth-map/index.html. That file stays the source of truth and
   the map keeps rendering from it; this reads the same file and projects it
   into tables so the data can be *joined* against companies, contacts,
   research and email history. The interesting questions — "which target
   customers at the show have research but no outreach?" — need both halves in
   one query, and cannot be asked while booths live in a script tag.

   Design constraints, all of them learned rather than assumed:

   · One-way. Nothing here writes back to the static file, so a bad import can
     always be fixed by rerunning after correcting the source.
   · Idempotent. Rerunning with unchanged input changes nothing, and says so.
   · Transactional. A failure rolls the whole thing back — a half-synchronized
     booth map is worse than a stale one, because it looks current.
   · Non-destructive. A booth that disappears upstream is marked retired, never
     deleted. It may have been quoted in an email six weeks ago.
   · Honest about matching. 98% of named booths resolve to a company; the rest
     are stored with the source spelling and a null company_id. A wrong join
     would attach one company's research to another company's booth, which is
     the kind of error nobody catches by reading a leaderboard.

   The parsing is deliberately narrow: the arrays are extracted by name and
   JSON.parse'd. No eval, no script execution — the file is data here, and
   treating a 358KB literal as code to be run is how a UI file becomes a
   remote-execution surface.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeNameKey } = require('./companyKey');

const SOURCE_PATH = path.join(__dirname, 'public', 'booth-map', 'index.html');
const EVENT_NAME = 'The Battery Show North America 2026';

/* The six arrays the map defines. `ALL_BOOTHS_DATA` is the spine; the rest are
   overlays keyed by booth number that describe the same booths from different
   angles. Declared as a table so adding a seventh is one line. */
const OVERLAYS = [
  { name: 'DIRECT_COMP', kind: 'competitor_direct', shape: 'map' },
  { name: 'INDIRECT_COMP', kind: 'competitor_indirect', shape: 'map' },
  { name: 'ESS_EV', kind: 'ess_ev', shape: 'map' },
  { name: 'COMPANY_DB', kind: 'target_customer', shape: 'map' },
  { name: 'CN_COMPANIES', kind: 'chinese_company', shape: 'array', key: 'booth' },
  { name: 'AVAILABLE_RANKED', kind: 'available_ranked', shape: 'array', key: 'booth' },
];

/** Pulls one `const NAME=<json>;` literal out of the source, as data. */
function extractLiteral(html, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*([\\[{][\\s\\S]*?[\\]}])\\s*;\\s*\\n`);
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Reads the static booth map and returns everything the importer needs,
 * plus a fingerprint of exactly what was read.
 *
 * The fingerprint covers the parsed arrays rather than the whole file, so
 * editing a stylesheet or a tooltip in the same HTML does not present itself
 * as a data change.
 */
function readSource(sourcePath = SOURCE_PATH) {
  const html = fs.readFileSync(sourcePath, 'utf8');

  const booths = extractLiteral(html, 'ALL_BOOTHS_DATA');
  if (!Array.isArray(booths) || !booths.length) {
    throw new Error(`ALL_BOOTHS_DATA not found or empty in ${sourcePath}`);
  }

  const overlays = {};
  const warnings = [];
  for (const o of OVERLAYS) {
    const raw = extractLiteral(html, o.name);
    if (raw == null) {
      // Not fatal: an overlay may legitimately be removed upstream. It is
      // recorded so a silently-vanished classification is still visible.
      warnings.push({ type: 'overlay_missing', overlay: o.name });
      overlays[o.kind] = [];
      continue;
    }
    overlays[o.kind] = o.shape === 'map'
      ? Object.entries(raw).map(([booth, v]) => ({ booth: String(booth), ...v }))
      : raw.map((v) => ({ ...v, booth: String(v[o.key] ?? '') })).filter((v) => v.booth);
  }

  const source_version = crypto.createHash('sha256')
    .update(JSON.stringify({ booths, overlays }))
    .digest('hex')
    .slice(0, 16);

  return { booths, overlays, source_version, sourcePath, warnings };
}

/* ── Matching ──────────────────────────────────────────────────────────────
   Three tiers, most specific first, and a hard stop rather than a guess.

   Tier 1  exact name, case-insensitive     — the same rule companies' own
                                              unique index uses
   Tier 2  normalizeNameKey                 — "EVE Energy Co.,Ltd." vs
                                              "EVE Energy Co., Ltd."
   Tier 3  booth number on the same event   — the source and the CRM agree on
                                              where the company is standing

   More than one candidate at any tier is AMBIGUOUS, which resolves to no
   match with the candidates recorded. Picking the lowest id would be a coin
   toss that silently attaches one company's history to another's booth. */
function buildMatcher(companies) {
  const byExact = new Map();
  const byKey = new Map();
  const byBooth = new Map();

  for (const c of companies) {
    const exact = String(c.name || '').trim().toLowerCase();
    if (exact) {
      if (!byExact.has(exact)) byExact.set(exact, []);
      byExact.get(exact).push(c.id);
    }
    const key = c.name_key || normalizeNameKey(c.name);
    if (key) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(c.id);
    }
    const booth = String(c.booth || '').trim();
    if (booth) {
      if (!byBooth.has(booth)) byBooth.set(booth, []);
      byBooth.get(booth).push(c.id);
    }
  }

  return function match(booth) {
    const name = String(booth.nm || '').trim();
    const tiers = [
      ['name_exact', name ? byExact.get(name.toLowerCase()) : null],
      ['name_key', name ? byKey.get(normalizeNameKey(name)) : null],
      ['booth_number', byBooth.get(String(booth.n || '').trim())],
    ];

    for (const [method, candidates] of tiers) {
      if (!candidates || !candidates.length) continue;
      const unique = [...new Set(candidates)];
      if (unique.length === 1) {
        return { company_id: unique[0], match_method: method, match_confidence: 'confident', match_note: null };
      }
      return {
        company_id: null,
        match_method: method,
        match_confidence: 'ambiguous',
        // The ids, so a human can resolve it without re-deriving the collision.
        match_note: `${unique.length} candidates: ${unique.slice(0, 10).join(',')}`,
      };
    }
    return { company_id: null, match_method: 'none', match_confidence: 'unmatched', match_note: null };
  };
}

/**
 * Whether a booth names a company at all.
 *
 * Free floor space is carried in the same array as exhibitors, with the
 * literal placeholder "Available" in the company-name field. Treating that as
 * a company name made 165 empty stands report as unmatched companies, which
 * buried the 16 real misses in noise — and the unmatched list is only worth
 * having if a human will actually read it.
 */
function isCompanyBooth(b) {
  const name = String(b.nm || '').trim();
  if (!name) return false;
  if (b.c === 'available') return false;
  return !/^available$/i.test(name);
}

/** The booth fields that are modelled; everything else is kept in `data`. */
const MODELLED = new Set(['n', 'nm', 'zh', 'c', 'status', 'x', 'y', 'dims', 'edition', 'intro']);

function boothRow(b, matcher, source_version) {
  const extra = {};
  for (const [k, v] of Object.entries(b)) if (!MODELLED.has(k)) extra[k] = v;
  /* Empty floor space is not an unmatched company. Recorded as its own state
     so the two are never added together in a report. */
  const m = isCompanyBooth(b)
    ? matcher(b)
    : { company_id: null, match_method: 'not_a_company', match_confidence: 'not_a_company', match_note: null };
  return {
    booth_number: String(b.n),
    source_company_name: b.nm || null,
    source_company_name_zh: b.zh || null,
    name_key: b.nm ? normalizeNameKey(b.nm) : null,
    category: b.c || null,
    status: b.status || null,
    x: Number.isFinite(b.x) ? b.x : null,
    y: Number.isFinite(b.y) ? b.y : null,
    dims: b.dims || null,
    edition: b.edition || null,
    intro: b.intro || null,
    data: Object.keys(extra).length ? extra : null,
    source_version,
    ...m,
  };
}

/* Which columns decide "unchanged". Deliberately excludes the timestamps and
   source_version: a rerun of an unedited file must report `unchanged`, and
   comparing a fingerprint that changes whenever anything else in the file
   moved would report every row as updated. */
const COMPARED = [
  'source_company_name', 'source_company_name_zh', 'name_key', 'company_id',
  'match_method', 'match_confidence', 'match_note', 'category', 'status',
  'x', 'y', 'dims', 'edition', 'intro',
];

function differs(existing, next) {
  for (const col of COMPARED) {
    const a = existing[col] === undefined ? null : existing[col];
    const b = next[col] === undefined ? null : next[col];
    if (String(a ?? '') !== String(b ?? '')) return true;
  }
  return JSON.stringify(existing.data ?? null) !== JSON.stringify(next.data ?? null);
}

const INTEL_MODELLED = new Set([
  'booth', 'name', 'zh', 'reason', 'priority', 'priority_label', 'background',
  'segment', 'projects', 'role', 'score', 'grade', 'badge', 'traffic_score',
  'anchor_score', 'visibility_score', 'skeqi_relevance', 'traffic_analysis',
]);

function intelRow(kind, o, source_version) {
  const extra = {};
  for (const [k, v] of Object.entries(o)) if (!INTEL_MODELLED.has(k)) extra[k] = v;
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    kind,
    reason: o.reason || null,
    priority: Number.isFinite(o.priority) ? o.priority : null,
    priority_label: o.priority_label || null,
    background: o.background || null,
    segments: o.segment ? JSON.stringify(o.segment) : null,
    projects: o.projects ? JSON.stringify(o.projects) : null,
    role: o.role || null,
    score: num(o.score),
    grade: o.grade || null,
    badge: o.badge || null,
    traffic_score: num(o.traffic_score),
    anchor_score: num(o.anchor_score),
    visibility_score: num(o.visibility_score),
    skeqi_relevance: num(o.skeqi_relevance),
    analysis: o.traffic_analysis || null,
    data: Object.keys(extra).length ? JSON.stringify(extra) : null,
    source_version,
  };
}


/* ── Synchronization ───────────────────────────────────────────────────────
   Split from the CLI on purpose. Everything below takes a client and returns
   plain data, so the behaviour that actually matters — what counts as a
   change, what gets retired, whether a rerun is a no-op — is testable against
   any Postgres without a process, a socket or an environment variable.
   A sync whose only test is "run it against production and look" is not
   tested. */

/** What a run WOULD do. Reads only; the dry-run report is this, printed. */
async function plan(client, src, eventId) {
  const { rows: companies } = await client.query('select id, name, name_key, booth from companies');
  const matcher = buildMatcher(companies);

  /* A dry run is most useful before the tables exist — it is how you decide
     whether to create them. Postgres 42P01 is "undefined_table"; treating it
     as "nothing imported yet" makes the first report readable instead of a
     stack trace, and an apply against a missing table still fails loudly at
     the insert. */
  let existingRows = [];
  let tablesReady = true;
  try {
    ({ rows: existingRows } = await client.query(
      `select id, booth_number, ${COMPARED.join(', ')}, data, retired_at
         from booth_map_booths where event_id = $1`, [eventId]));
  } catch (e) {
    if (e.code !== '42P01') throw e;
    tablesReady = false;
  }
  const existing = new Map(existingRows.map((r) => [r.booth_number, r]));

  const created = [];
  const updated = [];
  const unchanged = [];
  const retired = [];
  const warnings = [...(src.warnings || [])];
  const stats = { matched: 0, unmatched: 0, ambiguous: 0, freeSpace: 0 };
  const rows = [];

  for (const b of src.booths) {
    const row = boothRow(b, matcher, src.source_version);
    rows.push(row);

    if (row.match_confidence === 'confident') stats.matched++;
    else if (row.match_confidence === 'ambiguous') {
      stats.ambiguous++;
      warnings.push({ type: 'ambiguous_match', booth: row.booth_number,
        name: row.source_company_name, note: row.match_note });
    } else if (row.match_confidence === 'unmatched') {
      stats.unmatched++;
    } else {
      stats.freeSpace++;   // available floor, named "Available" upstream
    }

    const prev = existing.get(row.booth_number);
    if (!prev) created.push(row);
    else if (differs(prev, row) || prev.retired_at) updated.push(row);
    else unchanged.push(row);
  }

  const seen = new Set(rows.map((r) => r.booth_number));
  for (const [num, prev] of existing) {
    if (!seen.has(num) && !prev.retired_at) retired.push(prev);
  }

  const intel = [];
  for (const [kind, records] of Object.entries(src.overlays)) {
    for (const o of records) {
      if (!seen.has(o.booth)) {
        // An overlay pointing at a booth that is not in the spine usually means
        // the source arrays have drifted apart. Surfaced, not dropped.
        warnings.push({ type: 'overlay_orphan', kind, booth: o.booth, name: o.name || null });
        continue;
      }
      intel.push({ booth_number: o.booth, ...intelRow(kind, o, src.source_version) });
    }
  }

  return { rows, created, updated, unchanged, retired, intel, stats, warnings, existingRows, tablesReady };
}

const WRITE_COLS = [
  'source_company_name', 'source_company_name_zh', 'name_key', 'company_id',
  'match_method', 'match_confidence', 'match_note', 'category', 'status',
  'x', 'y', 'dims', 'edition', 'intro', 'data', 'source_version',
];

const INTEL_COLS = [
  'reason', 'priority', 'priority_label', 'background', 'segments', 'projects',
  'role', 'score', 'grade', 'badge', 'traffic_score', 'anchor_score',
  'visibility_score', 'skeqi_relevance', 'analysis', 'data', 'source_version',
];

/**
 * Applies a plan. The caller owns the transaction — this issues no BEGIN or
 * COMMIT of its own, so a partial apply can never be committed by a helper
 * that does not know what else the caller is doing.
 */
async function apply(client, p, eventId, src) {
  const idByBooth = new Map(p.existingRows.map((r) => [r.booth_number, r.id]));

  /* Every seen booth is written, including unchanged ones: last_seen_at is how
     a later sync tells "still upstream" from "gone", and skipping the no-ops
     would make every unchanged booth look retired on the next run. */
  for (const row of [...p.created, ...p.updated, ...p.unchanged]) {
    const vals = WRITE_COLS.map((c) => (c === 'data' && row.data ? JSON.stringify(row.data) : row[c] ?? null));
    const { rows: [saved] } = await client.query(
      `insert into booth_map_booths (event_id, booth_number, ${WRITE_COLS.join(', ')}, last_seen_at, retired_at)
       values ($1, $2, ${WRITE_COLS.map((_, i) => `$${i + 3}`).join(', ')}, NOW(), NULL)
       on conflict (event_id, booth_number) do update set
         ${WRITE_COLS.map((c, i) => `${c} = $${i + 3}`).join(', ')},
         last_seen_at = NOW(), retired_at = NULL
       returning id`,
      [eventId, row.booth_number, ...vals]);
    idByBooth.set(row.booth_number, saved.id);
  }

  // Gone upstream. Retired, never deleted: it may already be quoted in an
  // email somebody sent last month.
  for (const prev of p.retired) {
    await client.query('update booth_map_booths set retired_at = NOW() where id = $1', [prev.id]);
    await client.query(
      'update booth_intel set retired_at = NOW() where booth_id = $1 and retired_at is null', [prev.id]);
  }

  let intelUpserted = 0;
  for (const o of p.intel) {
    const boothId = idByBooth.get(o.booth_number);
    if (!boothId) continue;
    await client.query(
      `insert into booth_intel (booth_id, kind, ${INTEL_COLS.join(', ')}, last_seen_at, retired_at)
       values ($1, $2, ${INTEL_COLS.map((_, i) => `$${i + 3}`).join(', ')}, NOW(), NULL)
       on conflict (booth_id, kind) do update set
         ${INTEL_COLS.map((c, i) => `${c} = $${i + 3}`).join(', ')},
         last_seen_at = NOW(), retired_at = NULL`,
      [boothId, o.kind, ...INTEL_COLS.map((c) => o[c] ?? null)]);
    intelUpserted++;
  }

  const live = new Set(p.intel.map((o) => `${idByBooth.get(o.booth_number)}:${o.kind}`));
  const { rows: allIntel } = await client.query(
    `select bi.id, bi.booth_id, bi.kind from booth_intel bi
       join booth_map_booths b on b.id = bi.booth_id
      where b.event_id = $1 and bi.retired_at is null`, [eventId]);
  let intelRetired = 0;
  for (const r of allIntel) {
    if (!live.has(`${r.booth_id}:${r.kind}`)) {
      await client.query('update booth_intel set retired_at = NOW() where id = $1', [r.id]);
      intelRetired++;
    }
  }

  return { intelUpserted, intelRetired };
}

/** The event a booth import is scoped to. Never created here — an import that
    invents an event would silently start a second, empty edition. */
async function resolveEvent(client, name = EVENT_NAME) {
  const { rows } = await client.query('select id from events where name = $1', [name]);
  if (!rows.length) {
    throw new Error(`event not found: "${name}". Booth data is scoped to an event; create it first.`);
  }
  return rows[0].id;
}

module.exports = {
  SOURCE_PATH, EVENT_NAME, OVERLAYS, COMPARED, WRITE_COLS, INTEL_COLS,
  extractLiteral, readSource, buildMatcher, boothRow, intelRow, differs, normalizeNameKey,
  isCompanyBooth,
  plan, apply, resolveEvent,
};
