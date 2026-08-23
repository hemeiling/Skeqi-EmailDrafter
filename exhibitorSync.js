/* ═══════════════════════════════════════════════════════════════════════════
   Exhibitor attendance, synchronized from the authoritative event source.

   The distinction this file exists to preserve:

     attending       is this company an exhibitor?          MapYourShow says
     booth           where are they standing?               MapYourShow says
     classification  what do WE think of them?              we say

   They used to be one fact — a booth row — so "no booth" and "not attending"
   were the same answer, and the assistant told a salesperson that CATL was
   not attending when what it actually knew was that it had no booth number.
   Nothing here infers one from another.

   Two rules that are not negotiable, because both failure modes are silent:

   · An empty, failed or unauthorized response is NEVER treated as "everyone
     withdrew". The session cookie this source needs expires, and an expired
     cookie returns a valid-looking empty list. Retiring 984 exhibitors on the
     strength of that would look exactly like a real result.

   · A classification is never moved by booth number. Somebody judged Comau a
     direct competitor; nobody judged booth 3626. When the organiser reassigns
     that booth to INTECELLS, inheriting the label would quietly mark an
     unrelated company a competitor — so it goes to review instead.
   ═══════════════════════════════════════════════════════════════════════════ */

const { normalizeNameKey } = require('./companyKey');

const HOST = 'https://tbsm26.mapyourshow.com';
const SEARCH = `${HOST}/8_0/ajax/remote-proxy.cfm?action=search&search=%2A`
  + '&searchtype=exhibitoralpha&sortfield=title_t&sortdirection=asc&show=all';
const EVENT_NAME = 'The Battery Show North America 2026';
const SOURCE = 'mapyourshow';

/* A pull smaller than this fraction of what we already hold is treated as a
   broken fetch rather than a real collapse in attendance. Shows lose the odd
   exhibitor; they do not lose half. */
const MIN_PLAUSIBLE_FRACTION = 0.5;
/* And an outright empty list is never plausible for a show with a floor plan. */
const MIN_ABSOLUTE = 25;

function headers(cookie) {
  return {
    accept: 'application/json, text/javascript, */*; q=0.01',
    referer: `${HOST}/8_0/exhview/index.cfm`,
    'x-requested-with': 'XMLHttpRequest',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
    cookie: cookie || '',
  };
}

/**
 * Fetches every exhibitor, paging as the source requires.
 *
 * Throws rather than returning a short list on any failure. A partial page set
 * is indistinguishable from exhibitors having withdrawn, so it must never
 * reach the planner as data.
 */
async function fetchExhibitors({ cookie, fetchImpl = fetch, onProgress } = {}) {
  const rows = [];
  let start = 0;
  let found = null;

  for (;;) {
    const res = await fetchImpl(`${SEARCH}&start=${start}`, { headers: headers(cookie) });
    if (!res.ok) {
      throw new Error(`exhibitor fetch failed: HTTP ${res.status}`
        + (res.status === 401 || res.status === 403 ? ' — MYS_COOKIE is probably expired' : ''));
    }
    let data;
    try { data = await res.json(); } catch {
      // An expired session commonly returns an HTML login page with HTTP 200.
      throw new Error('exhibitor fetch returned non-JSON — MYS_COOKIE is probably expired');
    }
    const block = data && data.DATA && data.DATA.results && data.DATA.results.exhibitor;
    if (!block) throw new Error('exhibitor fetch returned an unexpected shape');

    const hits = block.hit || [];
    if (found === null) found = Number(block.found || 0);
    rows.push(...hits.map((h) => h.fields || {}));
    start += hits.length;
    if (onProgress) onProgress(rows.length, found);
    if (!hits.length || start >= found) break;
  }

  if (found && rows.length < found) {
    throw new Error(`incomplete fetch: ${rows.length} of ${found} exhibitors`);
  }
  return normalize(rows);
}

/** The source's shape, reduced to what we store. */
function normalize(rows) {
  const out = [];
  for (const f of rows) {
    const name = String(f.exhname_t || '').trim();
    const exhid = String(f.exhid_l || '').trim();
    if (!name || !exhid) continue;
    const booths = (f.boothsdisplay_la || f.booths_la || [])
      .map((b) => String(b).replace('randomstring', '').trim())
      .filter(Boolean);
    out.push({
      exhibitor_source_id: exhid,
      source_name: name,
      name_key: normalizeNameKey(name),
      booths: [...new Set(booths)],
      hall: (f.hallid_la || [''])[0] || null,
    });
  }
  return out;
}

/** A fingerprint of what was fetched, so a run records exactly what it saw. */
function sourceVersion(exhibitors) {
  const crypto = require('crypto');
  const stable = exhibitors
    .map((e) => `${e.exhibitor_source_id}:${e.source_name}:${e.booths.join(',')}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

/* ── matching ──────────────────────────────────────────────────────────────
   The same conservative rules the booth importer uses, and for the same
   reason: a wrong join here attaches one company's research and outreach to
   another company's attendance. Exact name, then normalized key. Booth number
   is deliberately NOT a tier — booths change hands, which is the entire
   problem this file was written to fix. */
function buildMatcher(companies) {
  const byExact = new Map();
  const byKey = new Map();
  for (const c of companies) {
    const exact = String(c.name || '').trim().toLowerCase();
    if (exact) { if (!byExact.has(exact)) byExact.set(exact, []); byExact.get(exact).push(c.id); }
    const k = c.name_key || normalizeNameKey(c.name);
    if (k) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c.id); }
  }
  return function match(name) {
    const n = String(name || '').trim();
    for (const [method, candidates] of [
      ['name_exact', n ? byExact.get(n.toLowerCase()) : null],
      ['name_key', n ? byKey.get(normalizeNameKey(n)) : null],
    ]) {
      if (!candidates || !candidates.length) continue;
      const unique = [...new Set(candidates)];
      if (unique.length === 1) {
        return { company_id: unique[0], match_method: method, match_confidence: 'confident', match_note: null };
      }
      return { company_id: null, match_method: method, match_confidence: 'ambiguous',
        match_note: `${unique.length} candidates: ${unique.slice(0, 10).join(',')}` };
    }
    return { company_id: null, match_method: 'none', match_confidence: 'unmatched', match_note: null };
  };
}

async function resolveEvent(client, name = EVENT_NAME) {
  const { rows } = await client.query('select id from events where name = $1', [name]);
  if (!rows.length) throw new Error(`event not found: "${name}"`);
  return rows[0].id;
}

/**
 * What a refresh WOULD do. Reads only.
 *
 * Returns `refuse` rather than a plan when the fetched set is too small to be
 * believable, so the caller cannot accidentally apply a mass retirement it did
 * not mean. The check lives here rather than in the CLI because it is a
 * property of the data, not of how it was invoked.
 */
async function plan(client, exhibitors, eventId, opts = {}) {
  const minAbsolute = opts.minAbsolute ?? MIN_ABSOLUTE;
  const minFraction = opts.minFraction ?? MIN_PLAUSIBLE_FRACTION;
  /* A dry run is most useful before the tables exist — it is how you decide
     whether to create them. 42P01 is "undefined_table"; treating it as "nothing
     imported yet" makes the first report readable, and an apply against a
     missing table still fails loudly at the insert. */
  let existing = [];
  let tablesReady = true;
  try {
    ({ rows: existing } = await client.query(
      `select id, exhibitor_source_id, source_name, name_key, company_id,
              match_method, match_confidence, attendance_status, hall, retired_at
         from event_exhibitors where event_id = $1`, [eventId]));
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
    tablesReady = false;
  }

  const liveCount = exhibitors.length;
  const heldCount = existing.filter((e) => e.attendance_status === 'listed').length;
  if (liveCount < minAbsolute || (heldCount && liveCount < heldCount * minFraction)) {
    return {
      refuse: `fetched ${liveCount} exhibitors against ${heldCount} already listed — `
        + 'refusing to treat that as a mass withdrawal. Check MYS_COOKIE and rerun.',
      liveCount, heldCount,
    };
  }

  const { rows: companies } = await client.query('select id, name, name_key from companies');
  const matcher = buildMatcher(companies);

  const byId = new Map(existing.map((e) => [e.exhibitor_source_id, e]));
  const created = [];
  const updated = [];
  const unchanged = [];
  const revived = [];
  const stats = { matched: 0, unmatched: 0, ambiguous: 0 };

  for (const e of exhibitors) {
    const m = matcher(e.source_name);
    if (m.match_confidence === 'confident') stats.matched++;
    else if (m.match_confidence === 'ambiguous') stats.ambiguous++;
    else stats.unmatched++;

    const row = { ...e, ...m };
    const prev = byId.get(e.exhibitor_source_id);
    if (!prev) { created.push(row); continue; }
    if (prev.attendance_status === 'retired') { revived.push({ row, prev }); continue; }

    const changed = prev.source_name !== row.source_name
      || (prev.company_id ?? null) !== (row.company_id ?? null)
      || (prev.match_confidence ?? null) !== row.match_confidence
      || (prev.hall ?? null) !== (row.hall ?? null);
    (changed ? updated : unchanged).push({ row, prev });
  }

  const seen = new Set(exhibitors.map((e) => e.exhibitor_source_id));
  const retired = existing.filter((e) => e.attendance_status === 'listed' && !seen.has(e.exhibitor_source_id));

  return {
    created, updated, unchanged, revived, retired, stats,
    existing, liveCount, heldCount, tablesReady,
  };
}

/**
 * Which curated classifications can no longer be trusted where they sit.
 *
 * Two ways a classification goes stale, and neither is repaired here:
 *   · the booth changed hands — the label belongs to the old occupant
 *   · the company left the show — the label is about someone not attending
 *
 * Both are flagged for a human. Moving a judgement automatically is how
 * INTECELLS ends up marked a direct competitor because it took Comau's booth.
 */
async function planIntelReview(client, exhibitors, eventId) {
  const liveByBooth = new Map();
  const liveByKey = new Map();
  for (const e of exhibitors) {
    liveByKey.set(e.name_key, e);
    for (const b of e.booths) {
      const k = String(b);
      if (!liveByBooth.has(k)) liveByBooth.set(k, []);
      liveByBooth.get(k).push(e);
    }
  }

  let rows = [];
  try {
    ({ rows } = await client.query(
      `select bi.id, bi.kind, b.booth_number, b.source_company_name
         from booth_intel bi
         join booth_map_booths b on b.id = bi.booth_id
        where bi.retired_at is null and b.retired_at is null
          and b.source_company_name is not null
          and ($1::int is null or b.event_id = $1)`, [eventId]));
  } catch (e) {
    // 42P01 undefined_table, 42703 undefined_column — both mean "this database
    // has not been migrated yet", which a read-only preview must survive.
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }

  const flag = [];
  for (const r of rows) {
    const mineKey = normalizeNameKey(r.source_company_name);
    const occupants = liveByBooth.get(String(r.booth_number)) || [];
    const stillListed = liveByKey.has(mineKey);
    /* Only flag when the company we judged is genuinely NOT among the current
       occupants. Sharing a stand is not a reassignment, and flagging it sent
       three perfectly good classifications to review. */
    const stillAtBooth = occupants.some((o) => normalizeNameKey(o.source_name) === mineKey);

    if (occupants.length && !stillAtBooth) {
      flag.push({ ...r, review_reason:
        `booth ${r.booth_number} is now listed to `
        + `${occupants.map((o) => `"${o.source_name}"`).join(', ')}; `
        + `this classification was made about "${r.source_company_name}"`,
        subject_name: r.source_company_name,
        exhibitor: stillListed ? liveByKey.get(mineKey) : null });
    } else if (!stillListed) {
      flag.push({ ...r, review_reason:
        `"${r.source_company_name}" is not in the latest official exhibitor list`,
        subject_name: r.source_company_name, exhibitor: null });
    }
  }
  return flag;
}

/**
 * Applies a plan. The caller owns the transaction.
 *
 * Retirement is a status change and a timestamp, never a delete: a company
 * that withdraws is still a company we may have written to about this show.
 */
async function apply(client, p, eventId, version, intelFlags) {
  /* A refusal is not a plan. Without this, a caller that forgot to check
     `p.refuse` would crash halfway through — inside a transaction, having
     already written some rows — instead of doing nothing, which is the whole
     point of refusing. */
  if (!p || p.refuse) {
    throw new Error(`refusing to apply: ${p ? p.refuse : 'no plan supplied'}`);
  }
  const idFor = new Map(p.existing.map((e) => [e.exhibitor_source_id, e.id]));
  let boothsAdded = 0;
  let boothsRetired = 0;

  const upsert = async (row) => {
    const { rows: [saved] } = await client.query(
      `insert into event_exhibitors
         (event_id, exhibitor_source_id, source_name, name_key, company_id,
          match_method, match_confidence, match_note, attendance_status, hall,
          source, source_version, last_verified_at, retired_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'listed',$9,$10,$11,NOW(),NULL)
       on conflict (event_id, exhibitor_source_id) do update set
         source_name = $3, name_key = $4, company_id = $5,
         match_method = $6, match_confidence = $7, match_note = $8,
         attendance_status = 'listed', hall = $9, source_version = $11,
         last_verified_at = NOW(), retired_at = NULL
       returning id`,
      [eventId, row.exhibitor_source_id, row.source_name, row.name_key, row.company_id,
        row.match_method, row.match_confidence, row.match_note, row.hall, SOURCE, version]);
    idFor.set(row.exhibitor_source_id, saved.id);
    return saved.id;
  };

  const all = [...p.created, ...p.updated.map((u) => u.row), ...p.unchanged.map((u) => u.row),
    ...p.revived.map((u) => u.row)];

  for (const row of all) {
    const exhibitorId = await upsert(row);

    /* Retire first, then re-assert what the source currently says. The upsert
       clears retired_at, so a booth still held comes back live and one that is
       gone stays retired — the same end state as a diff, without needing an
       array parameter to express "not in this list". */
    const { rowCount: gone } = await client.query(
      'update exhibitor_booths set retired_at = NOW() where exhibitor_id = $1 and retired_at is null',
      [exhibitorId]);

    let reasserted = 0;
    for (const booth of row.booths) {
      const { rows: [saved] } = await client.query(
        `insert into exhibitor_booths (exhibitor_id, booth_number, hall, source_version, last_verified_at, retired_at)
         values ($1,$2,$3,$4,NOW(),NULL)
         on conflict (exhibitor_id, booth_number) do update set
           hall = $3, source_version = $4, last_verified_at = NOW(), retired_at = NULL
         returning (xmax = 0) as inserted`,
        [exhibitorId, booth, row.hall, version]);
      if (saved && saved.inserted) boothsAdded++;
      reasserted++;
    }
    boothsRetired += Math.max(0, gone - reasserted);
  }

  for (const e of p.retired) {
    await client.query(
      `update event_exhibitors set attendance_status = 'retired', retired_at = NOW(),
              last_verified_at = NOW(), source_version = $2
        where id = $1`, [e.id, version]);
    await client.query(
      'update exhibitor_booths set retired_at = NOW() where exhibitor_id = $1 and retired_at is null', [e.id]);
  }

  /* Link the map's booths to exhibitors, and record whether the source still
     agrees about who is standing there. Nothing is moved or deleted — the map
     keeps its geometry and its categories; it just learns the truth. */
  /* A booth can hold SEVERAL exhibitors — co-exhibitors share a stand, and
     nine of them do at this show. The first version of this kept one row per
     booth, so whichever exhibitor happened to be written last won and the
     other looked evicted: it reported Comau as replaced by INTECELLS when both
     are on the same stand, and flagged Comau's competitor classification for
     review on that false premise. */
  const liveByBooth = new Map();
  for (const row of all) {
    for (const b of row.booths) {
      const k = String(b);
      if (!liveByBooth.has(k)) liveByBooth.set(k, []);
      liveByBooth.get(k).push(row);
    }
  }

  const { rows: mapBooths } = await client.query(
    `select id, booth_number, source_company_name from booth_map_booths
      where event_id = $1 and retired_at is null and source_company_name is not null`, [eventId]);
  let current = 0, reassigned = 0, vacated = 0;
  for (const b of mapBooths) {
    const occupants = liveByBooth.get(String(b.booth_number)) || [];
    const mineKey = normalizeNameKey(b.source_company_name);
    // "Still here" means present among the occupants, not identical to one.
    const mine = occupants.find((o) => normalizeNameKey(o.source_name) === mineKey);

    let status;
    let exhibitorId = null;
    if (!occupants.length) { status = 'vacated'; vacated++; } else if (mine) {
      status = 'current'; current++; exhibitorId = idFor.get(mine.exhibitor_source_id) || null;
    } else { status = 'reassigned'; reassigned++; }

    await client.query(
      `update booth_map_booths
          set exhibitor_id = $2, occupant_status = $3,
              live_occupant_name = $4, occupant_checked_at = NOW()
        where id = $1`,
      // Every current occupant, so a shared stand reads as a shared stand.
      [b.id, exhibitorId, status, occupants.length ? occupants.map((o) => o.source_name).join(' | ') : null]);
  }

  /* Classifications: attached to the exhibitor where that is unambiguous,
     flagged where it is not. Never moved to whoever now holds the booth. */
  let flagged = 0;
  for (const f of intelFlags) {
    await client.query(
      `update booth_intel
          set review_status = 'needs_review', review_reason = $2,
              subject_name = $3, review_flagged_at = NOW(),
              exhibitor_id = $4
        where id = $1`,
      [f.id, f.review_reason.slice(0, 400), f.subject_name,
        f.exhibitor ? idFor.get(f.exhibitor.exhibitor_source_id) || null : null]);
    flagged++;
  }

  /* Clear a review flag that the corrected data disproves.
     
     Narrowly, and only in one direction. A classification is un-flagged when
     the official floor plan now shows its subject still standing at its booth
     — which is precisely the case the single-occupant bug got wrong, because
     sharing a stand read as being evicted from it. A flag raised because the
     company actually left the show is untouched: that one is still true, and
     is still a human's to resolve.
     
     `subject_name` is the test rather than the booth's own name, because it
     records who the judgement was about. */
  let unflagged = 0;
  const { rows: reviewing } = await client.query(
    `select bi.id, bi.subject_name, b.booth_number
       from booth_intel bi join booth_map_booths b on b.id = bi.booth_id
      where bi.review_status = 'needs_review' and bi.retired_at is null
        and b.event_id = $1 and bi.subject_name is not null`, [eventId]);
  const stillFlagged = new Set(intelFlags.map((f) => f.id));
  for (const r of reviewing) {
    if (stillFlagged.has(r.id)) continue;
    const occupants = liveByBooth.get(String(r.booth_number)) || [];
    const present = occupants.some(
      (o) => normalizeNameKey(o.source_name) === normalizeNameKey(r.subject_name));
    if (!present) continue;          // flagged for some other, still-valid reason
    await client.query(
      `update booth_intel
          set review_status = 'ok', review_reason = null, review_flagged_at = null
        where id = $1`, [r.id]);
    unflagged++;
  }

  // Everything not flagged is anchored to the company it was made about.
  await client.query(
    `update booth_intel bi
        set exhibitor_id = coalesce(bi.exhibitor_id, ee.id),
            company_id = coalesce(bi.company_id, ee.company_id),
            subject_name = coalesce(bi.subject_name, b.source_company_name)
       from booth_map_booths b
       left join event_exhibitors ee
              on ee.event_id = b.event_id
             and ee.name_key = lower(regexp_replace(coalesce(b.source_company_name,''), '\\s+', ' ', 'g'))
      where bi.booth_id = b.id and bi.review_status = 'ok' and bi.retired_at is null`);

  return { boothsAdded, boothsRetired, occupancy: { current, reassigned, vacated }, flagged, unflagged };
}

module.exports = {
  HOST, SEARCH, EVENT_NAME, SOURCE, MIN_PLAUSIBLE_FRACTION, MIN_ABSOLUTE,
  fetchExhibitors, normalize, sourceVersion, buildMatcher, resolveEvent,
  plan, planIntelReview, apply, headers,
};
