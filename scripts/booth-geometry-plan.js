#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   Booth geometry plan — where each booth is DRAWN on the SKQ map.

   The SKQ map's coordinates were produced from the organiser's floor plan
   (MapYourShow GetBoothByHall) by a fixed scale and offset. The organiser has
   since re-laid parts of the hall: booths were added, merged, renumbered and a
   few moved. This script decides, booth by booth and by explicit rules, where
   the live map draws each one, and writes the decision to a reviewable file:

       data/booth-geometry/tbsm26.json

   Nothing here touches a database or the map's HTML. The map's embedded
   coordinates stay as they are and are copied into the plan as `orig`, so
   rolling back is "draw orig" — no data to restore.

   Rules (in order):
     1. The conversion is FITTED on the booths both sources share and must
        reproduce them: the fit is refused unless ≥ 95% land within 1 map unit.
     2. A booth whose official position converts to within 1 unit of where our
        map has it keeps our coordinates exactly ("kept").
     3. A booth the organiser moved is redrawn at the converted official
        position ("relocated") — unless the move is implausibly large (more
        than MAX_SHIFT units, i.e. an outlier that more likely means different
        data than a real move) or the new spot collides with another drawn
        booth. Either way it keeps its old position and is flagged
        ("kept_ambiguous"). Nothing ambiguous is moved silently.
     4. A booth that exists officially but not on our map is drawn at the
        converted position ("new"), unless that spot collides or lies outside
        the mapped hall (placeholder numbers such as TEMP_…), in which case
        it is NOT drawn and is flagged ("unplaced") for a human to place.
     5. A booth on our map that is no longer a booth in the official plan is
        "historical": never deleted, hidden by default, drawable on request.

   Usage:
     node scripts/booth-geometry-plan.js --raw <GetBoothByHall.json>   # from a saved response
     node scripts/booth-geometry-plan.js --fetch                        # fetch (public, ~2 min)
     add --out <path> to write elsewhere; --check to validate only.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const boothImport = require('../boothImport');

const GEOMETRY_URL = 'https://tbsm26.mapyourshow.com/8_0/exhview/02/exh-remote-proxy.cfm'
  + '?showid=TBSM26&selectedbooth=&hallid=A&action=GetBoothByHall&method=GetBoothByHall&regid=0';
const DEFAULT_OUT = path.join(__dirname, '..', 'data', 'booth-geometry', 'tbsm26.json');
const DECISIONS = path.join(__dirname, '..', 'data', 'booth-geometry', 'review-decisions.json');

const CELL = 8;            // the map draws every booth as an 8×8 cell (BW=BH=8)
const KEEP_WITHIN = 1;     // rounding noise between two integer grids
const MAX_SHIFT = 40;      // five booth widths; beyond this a "move" is treated as suspect
const MIN_FIT_SHARE = 0.95;
const HALL_MARGIN = 3 * CELL; // a new booth further than this outside the mapped hall is not drawn

/** Booth objects from a GetBoothByHall response. Rooms, labels, icons and
 *  outlines share booth numbers with real booths and are excluded. */
function parseOfficial(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || !Array.isArray(data.COLUMNS) || !Array.isArray(data.DATA)) {
    throw new Error('unexpected shape: not a GetBoothByHall response');
  }
  const ix = (k) => data.COLUMNS.indexOf(k);
  const booths = new Map();
  let rooms = 0;
  for (const r of data.DATA) {
    const type = r[ix('OBJECTTYPE')];
    if (type === 'room') rooms++;
    if (type !== 'booth') continue;
    const n = String(r[ix('BOOTHDISPLAY')] || r[ix('BOOTH')] || '').trim();
    const [X, Y] = String(r[ix('STARTXY')] || '').split(',').map(Number);
    if (!n || !Number.isFinite(X) || !Number.isFinite(Y)) continue;
    if (booths.has(n)) throw new Error(`duplicate booth object ${n}`);
    booths.set(n, {
      X, Y,
      dims: r[ix('BOOTHDIMS')] || '',
      status: r[ix('BOOTHSTATUS')] || '',
      exh: String(r[ix('EXHNAME')] || '').trim(),
    });
  }
  return { booths, rooms };
}

function lsq(pairs) {
  const n = pairs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [p, q] of pairs) { sx += p; sy += q; sxx += p * p; sxy += p * q; }
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return [a, (sy - a * sx) / n];
}

const overlaps = (p, q) => Math.abs(p.x - q.x) < CELL && Math.abs(p.y - q.y) < CELL;

/**
 * Pure: map booths + official booths → plan. Deterministic, so the same
 * inputs always give the same file and the same version.
 */
function buildPlan(mapBooths, official, meta = {}) {
  const ours = new Map(mapBooths.map((b) => [String(b.n), b]));
  const shared = [...ours.keys()].filter((n) => official.has(n));
  if (shared.length < 50) throw new Error(`only ${shared.length} booths in common — wrong show or wrong data`);

  /* Trimmed least squares: a booth the organiser really moved is an outlier,
     and one large move would otherwise drag the whole conversion. Fit, drop
     the worst-fitting tenth, refit — three times — then judge the result on
     ALL shared booths below. */
  let fitSet = shared;
  let a, b, c, d;
  for (let round = 0; round < 4; round++) {
    [a, b] = lsq(fitSet.map((n) => [official.get(n).X, ours.get(n).x]));
    [c, d] = lsq(fitSet.map((n) => [official.get(n).Y, ours.get(n).y]));
    const err = (n) => Math.max(Math.abs(a * official.get(n).X + b - ours.get(n).x),
      Math.abs(c * official.get(n).Y + d - ours.get(n).y));
    if (round === 3) break;
    fitSet = [...fitSet].sort((p, q) => err(p) - err(q)).slice(0, Math.max(50, Math.ceil(fitSet.length * 0.9)));
  }
  const conv = (o) => ({ x: Math.round(a * o.X + b), y: Math.round(c * o.Y + d) });
  const shift = (n) => {
    const p = conv(official.get(n)), o = ours.get(n);
    return Math.max(Math.abs(p.x - o.x), Math.abs(p.y - o.y));
  };
  const residuals = {};
  for (const n of shared) { const s = shift(n); residuals[s] = (residuals[s] || 0) + 1; }
  const within = shared.filter((n) => shift(n) <= KEEP_WITHIN).length;
  if (within / shared.length < MIN_FIT_SHARE) {
    throw new Error(`conversion does not reproduce the existing map: ${within}/${shared.length} within ${KEEP_WITHIN} unit`);
  }

  const xs = mapBooths.map((m) => m.x), ys = mapBooths.map((m) => m.y);
  const hall = { x0: Math.min(...xs) - HALL_MARGIN, x1: Math.max(...xs) + HALL_MARGIN,
    y0: Math.min(...ys) - HALL_MARGIN, y1: Math.max(...ys) + HALL_MARGIN };
  const inHall = (p) => p.x >= hall.x0 && p.x <= hall.x1 && p.y >= hall.y0 && p.y <= hall.y1;

  // First pass: what each official booth WANTS.
  const entries = [...official.keys()].sort((p, q) => p.localeCompare(q, 'en', { numeric: true })).map((n) => {
    const off = official.get(n), mine = ours.get(n), want = conv(off);
    const base = { n, dims: off.dims, official_status: off.status, official: want,
      orig: mine ? { x: mine.x, y: mine.y } : null };
    if (!mine) {
      return inHall(want) ? { ...base, decision: 'new', ...want }
        : { ...base, decision: 'unplaced', x: null, y: null,
          note: `official position ${want.x},${want.y} is outside the mapped hall; needs manual placement` };
    }
    const s = shift(n);
    if (s <= KEEP_WITHIN) return { ...base, decision: 'kept', x: mine.x, y: mine.y };
    if (s > MAX_SHIFT) {
      return { ...base, decision: 'kept_ambiguous', x: mine.x, y: mine.y,
        note: `official position is ${s} units away — larger than any plausible re-layout; kept for review` };
    }
    return { ...base, decision: 'relocated', x: want.x, y: want.y, shift: s };
  });

  /* Collisions, resolved conservatively and repeated until stable: anything
     that would MOVE into an occupied cell stays where it was (relocated →
     kept_ambiguous) or is not drawn (new → unplaced). Kept booths are never
     displaced to make room. */
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    const drawn = entries.filter((e) => e.decision !== 'unplaced');
    for (const e of entries) {
      if (e.decision !== 'relocated' && e.decision !== 'new') continue;
      const hit = drawn.filter((o) => o !== e && overlaps(e, o));
      if (!hit.length) continue;
      const with_ = hit.map((o) => o.n).join(', ');
      if (e.decision === 'relocated') {
        Object.assign(e, { decision: 'kept_ambiguous', x: e.orig.x, y: e.orig.y,
          note: `official position overlaps booth ${with_}; kept for review` });
      } else {
        Object.assign(e, { decision: 'unplaced', x: null, y: null,
          note: `official position overlaps booth ${with_}; needs manual placement` });
      }
      changed = true;
    }
    if (!changed) break;
  }

  /* Human decisions win over the computed ones, and can only make the plan
     more conservative: keep a booth where it was, or not draw a placeholder. */
  for (const [n, d] of Object.entries(meta.decisions || {})) {
    if (n.startsWith('_')) continue;
    const e = entries.find((x) => x.n === n);
    if (!e) continue;
    if (d.decision === 'kept_ambiguous' && e.orig) {
      Object.assign(e, { decision: 'kept_ambiguous', x: e.orig.x, y: e.orig.y, note: d.note, decided_at: d.decided_at });
    } else if (d.decision === 'placeholder') {
      Object.assign(e, { decision: 'placeholder', x: null, y: null, note: d.note, decided_at: d.decided_at });
    } else {
      throw new Error(`review decision for ${n} not accepted: ${d.decision}`);
    }
  }

  const historical = [...ours.keys()].filter((n) => !official.has(n))
    .sort((p, q) => p.localeCompare(q, 'en', { numeric: true }))
    .map((n) => ({ n, x: ours.get(n).x, y: ours.get(n).y, decision: 'historical' }));

  const counts = {};
  for (const e of [...entries, ...historical]) counts[e.decision] = (counts[e.decision] || 0) + 1;

  const body = {
    transform: { a, b, c, d, fitted_on: shared.length, trimmed_fit_on: fitSet.length, within_1_unit: within, residuals },
    policy: { cell: CELL, keep_within: KEEP_WITHIN, max_shift: MAX_SHIFT, min_fit_share: MIN_FIT_SHARE, hall_margin: HALL_MARGIN },
    counts, booths: entries, historical,
  };
  const version = crypto.createHash('sha256')
    .update(JSON.stringify({ map: meta.map_snapshot_version, src: meta.source_sha256, entries, historical }))
    .digest('hex').slice(0, 16);
  const { decisions, ...rest } = meta;
  return { version, ...rest, ...body };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  let raw;
  let fetchedAt;
  if (args.includes('--fetch')) {
    const r = await fetch(GEOMETRY_URL, { headers: { 'x-requested-with': 'XMLHttpRequest',
      referer: 'https://tbsm26.mapyourshow.com/8_0/exhview/index.cfm' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    raw = await r.text();
    fetchedAt = new Date().toISOString();
  } else if (opt('--raw')) {
    raw = fs.readFileSync(opt('--raw'), 'utf8');
    fetchedAt = opt('--fetched-at') || fs.statSync(opt('--raw')).mtime.toISOString();
  } else {
    console.error('usage: --raw <file> [--fetched-at ISO] | --fetch  [--out path] [--check]');
    process.exit(2);
  }
  const { booths: official, rooms } = parseOfficial(raw);
  const src = boothImport.readSource();
  const plan = buildPlan(src.booths, official, {
    generated_at: new Date().toISOString(),
    source: { url: GEOMETRY_URL, fetched_at: fetchedAt, booth_objects: official.size, room_objects: rooms },
    source_sha256: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16),
    map_snapshot_version: src.source_version,
    decisions: fs.existsSync(DECISIONS) ? JSON.parse(fs.readFileSync(DECISIONS, 'utf8')) : {},
  });
  console.log(`plan ${plan.version}: ${JSON.stringify(plan.counts)}`);
  console.log(`fit on ${plan.transform.fitted_on} booths, ${plan.transform.within_1_unit} within 1 unit`);
  for (const e of plan.booths.filter((x) => x.note)) console.log(`  ${e.n} ${e.decision}: ${e.note}`);
  if (args.includes('--check')) return;
  const out = opt('--out') || DEFAULT_OUT;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(plan, null, 1)}\n`);
  console.log(`wrote ${out}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { parseOfficial, buildPlan, CELL, KEEP_WITHIN, MAX_SHIFT, HALL_MARGIN };
