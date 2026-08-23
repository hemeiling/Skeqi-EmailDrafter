/* ═══════════════════════════════════════════════════════════════════════════
   The tools the assistant is allowed to use.

   This file is the security boundary. The model never writes SQL, never names
   a table and never reaches the database except through one of the functions
   below — it emits a tool name and a JSON object, both of which are checked
   here before anything runs. Every query is parameterised, every result is
   capped, and nothing mutates.

   Three rules the shape of this file exists to enforce:

   1. Read-only. There is no write tool. Not "a write tool that checks a flag"
      — none, so no prompt can reach one.
   2. Bounded. Every tool caps its rows, and the cap is applied here rather
      than trusted from the arguments: a model asking for 10,000 rows gets 25.
   3. Honest about gaps. 16 booths have no CRM company and 18 curated briefs
      point at booths that are not in the map. Tools surface both as data
      rather than dropping them, because a confident answer built on a silent
      omission is worse than no answer.

   Results are compact on purpose. Column names are short, nulls are omitted
   and text is truncated: everything returned here is re-read by the model as
   input tokens, and a chatty tool result is paid for on every subsequent turn
   of the conversation.
   ═══════════════════════════════════════════════════════════════════════════ */

const db = require('./db');
const { normalizeNameKey } = require('./companyKey');

/** Nothing may return more than this, whatever the model asks for. */
const MAX_ROWS = 25;
/** Long prose (research bodies, competitor rationales) is cut to this. */
const SNIPPET = 400;

const pool = db.pool;

/* ── argument validation ──────────────────────────────────────────────────
   Model-generated arguments are untrusted input, not a function signature.
   These coerce and clamp rather than throwing wherever a sensible reading
   exists — a tool call that fails on a stray string wastes a turn — but they
   never widen a limit and never pass a value through unchecked. */

function asInt(v, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

/**
 * The size contract for every list this module returns.
 *
 * `count: rows.length` is a page size wearing the name of a total, and a model
 * reads it as the answer. Asked how many companies were at the show, the
 * assistant called six category tools, each capped at 25, and reported
 * 19 + 25 + 25 + 25 = 94. The true figure was 984, and three of those 25s were
 * really 488, 67 and 53.
 *
 * So a capped list now says so, in three fields that cannot be confused:
 *   total      what the database holds, from its own COUNT(*)
 *   returned   how many are in this payload
 *   truncated  whether the two differ
 *
 * `truncated` is redundant with total > returned and is included anyway,
 * because it is the field a model cannot misread. Two tools already used this
 * shape (get_company_contacts, get_communication_history); this makes it the
 * rule rather than the exception.
 */
function cardinality(total, rows) {
  const returned = rows.length;
  const t = Number(total);
  const known = Number.isFinite(t) ? t : returned;
  return {
    total: known,
    returned,
    truncated: known > returned,
    ...(known > returned
      ? { note: `showing ${returned} of ${known} — this is a page, not the total` }
      : {}),
  };
}

/** COUNT(*) for a capped list, run as its own query so `total` is a fact. */
async function totalFor(sql, params) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows.length ? Number(rows[0].n) : null;
  } catch {
    return null;      // a failed count must not fail the tool
  }
}

function asLimit(v, fallback = 10) {
  const n = asInt(v, { min: 1, max: MAX_ROWS });
  return n == null ? Math.min(fallback, MAX_ROWS) : n;
}

function asText(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function asEnum(v, allowed, fallback = null) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return allowed.includes(s) ? s : fallback;
}

/** Drops nulls and empty strings so the model is not billed for absent fields. */
function compact(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = typeof v === 'string' ? v : v;
  }
  return out;
}

const snip = (s, n = SNIPPET) => {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/* The booth categories the map defines, as the assistant may name them. Kept
   here so a model cannot probe for arbitrary category strings, and so the
   English words a user types map onto the source's short codes. */
const CATEGORY_ALIASES = {
  competitor: ['competitor_direct', 'competitor_indirect'],
  direct_competitor: ['competitor_direct'],
  indirect_competitor: ['competitor_indirect'],
  target_customer: ['customer'],
  customer: ['customer'],
  battery_materials: ['batmat'],
  materials: ['batmat'],
  electronics: ['elec'],
  testing: ['test'],
  manufacturing: ['mfg'],
  assembly_line: ['line'],
  certification: ['cert'],
  recycling: ['recycle'],
  government: ['gov'],
  ess_ev: ['ess_ev'],
  available: ['available'],
  other: ['other'],
};

/*
 * How a message is tied to a company.
 *
 * NOT `communications.company_id`: that column exists and is NULL on all 3,025
 * live rows. Outreach is attached to a CONTACT, and the contact carries the
 * company. Filtering on the column that looks right returns zero for every
 * company — which reads as "we have never contacted them" for accounts with
 * fifty-six drafts, and is the most damaging wrong answer this assistant could
 * give a salesperson.
 *
 * Both paths are checked so a future row that does set company_id still counts.
 */
const COMMS_FOR_COMPANY = `(
  m.company_id = $COMPANY$
  or m.contact_id in (select id from contacts where company_id = $COMPANY$)
)`;

/** The event every booth question is scoped to. */
async function currentEventId() {
  const { rows } = await pool.query(
    'select id from events order by id desc limit 1');
  return rows.length ? rows[0].id : null;
}

/* Section codes as the Account Research UI names them, so the assistant says
   "Financial data" rather than "fd". Mirrors SECTION_LABEL in
   public/account-research/index.html. */
const RESEARCH_SECTIONS = {
  od: 'Company overview',
  fd: 'Financial data',
  sd: 'Strategy & technology',
  nd: 'Recent news',
  cd: 'Competitive landscape & pain points',
  sal: 'Stakeholders & next steps',
};

/** Pulls readable headlines out of one section's nested findings. */
function sectionHighlights(value) {
  if (!value || typeof value !== 'object') return undefined;
  const out = [];
  for (const v of Object.values(value)) {
    if (!Array.isArray(v)) continue;
    for (const item of v.slice(0, 3)) {
      if (item && typeof item === 'object') {
        const title = item.title || item.name || item.headline;
        const body = item.body || item.summary || item.detail;
        if (title || body) out.push(snip([title, body].filter(Boolean).join(' — '), 220));
      }
    }
    if (out.length >= 4) break;
  }
  return out.length ? out.slice(0, 4) : undefined;
}

function renderReport(r, full) {
  const status = r.sections && typeof r.sections === 'object' ? r.sections : {};
  const live = Object.entries(status).filter(([, v]) => v === 'live').map(([k]) => RESEARCH_SECTIONS[k] || k);
  const fallback = Object.entries(status).filter(([, v]) => v !== 'live').map(([k]) => RESEARCH_SECTIONS[k] || k);

  const base = compact({
    report_id: r.id,
    company: r.company_name,
    type: r.report_type,
    created: r.created_at,
    researched_sections: live.length ? live : undefined,
    // Named explicitly: a placeholder must never be reported as a finding.
    placeholder_sections: fallback.length ? fallback : undefined,
  });
  if (!full) return base;

  const data = r.data && typeof r.data === 'object' ? r.data : {};
  const findings = [];
  for (const [code, label] of Object.entries(RESEARCH_SECTIONS)) {
    if (status[code] !== 'live') continue;      // placeholders are not findings
    const highlights = sectionHighlights(data[code]);
    if (highlights) findings.push({ section: label, highlights });
  }
  return { ...base, findings: findings.length ? findings : undefined };
}

/* ── the tools ────────────────────────────────────────────────────────────
   Each entry: a JSON-Schema description the model sees, and a run() that
   receives already-validated arguments. The description is prompt surface —
   it is what the model reasons about — so it says what the tool is FOR, not
   how it is implemented. */

const TOOLS = {

  get_booth_occupant: {
    description:
      'Who is at a given booth NOW, according to the official event floor plan. '
      + 'Use this for any "who is at booth X", "which company is at X", or "is '
      + 'company Y still at booth X" question. The booth map we render is a '
      + 'snapshot and can be out of date; this is the authoritative answer.',
    parameters: {
      type: 'object',
      properties: { booth_number: { type: 'string' } },
      required: ['booth_number'],
    },
    async run(args) {
      const booth = asText(args.booth_number, 20);
      if (!booth) return { error: 'booth_number is required' };
      const eventId = await currentEventId();

      /* The official assignment first. exhibitor_booths is refreshed from the
         event source; booth_map_booths is our own rendering snapshot. When they
         disagree the source wins — that ordering is the whole point of this
         tool, because the snapshot said Comau was at 3626 five months after
         INTECELLS took it. */
      const { rows: live } = await pool.query(
        `select e.source_name, e.company_id, e.attendance_status, e.last_verified_at,
                e.exhibitor_source_id, c.name company_name
           from exhibitor_booths b
           join event_exhibitors e on e.id = b.exhibitor_id
           left join companies c on c.id = e.company_id
          where b.booth_number = $1 and b.retired_at is null
            and e.attendance_status = 'listed'
            and ($2::int is null or e.event_id = $2)
          order by e.source_name`, [booth, eventId]);

      // What our own map still shows, kept separate and labelled as history.
      const { rows: [snapshot] } = await pool.query(
        `select source_company_name, company_id, category, occupant_status,
                live_occupant_name, occupant_checked_at, dims, x, y
           from booth_map_booths
          where booth_number = $1 and retired_at is null
            and ($2::int is null or event_id = $2)
          limit 1`, [booth, eventId]);

      const { rows: [run] } = await pool.query(
        `select finished_at, fetched from exhibitor_import_runs
          where status = 'success' order by finished_at desc limit 1`);

      const provenance = compact({
        source: 'official event floor plan (MapYourShow)',
        last_verified: run ? run.finished_at : undefined,
        exhibitors_in_list: run ? run.fetched : undefined,
      });

      if (!live.length) {
        /* No current occupant. Say what the snapshot used to show, clearly
           marked as former — never as "the company at this booth". */
        return compact({
          booth: booth,
          occupied: false,
          statement: snapshot && snapshot.source_company_name
            ? `no company is currently assigned to booth ${booth} in the official floor plan`
            : `booth ${booth} is not assigned in the official floor plan`,
          former_occupant_on_our_map: snapshot && snapshot.source_company_name
            ? compact({
              name: snapshot.source_company_name,
              note: 'from our own booth-map snapshot, NOT current — this company '
                + 'is no longer shown at this booth in the official floor plan',
              snapshot_status: snapshot.occupant_status,
            })
            : undefined,
          size: snapshot ? snapshot.dims : undefined,
          as_of: provenance,
        });
      }

      const changed = snapshot && snapshot.source_company_name
        && snapshot.occupant_status === 'reassigned';

      return compact({
        booth: booth,
        occupied: true,
        current_occupant: live.map((r) => compact({
          name: r.source_name,
          company_id: r.company_id,
          crm_name: r.company_name,
          crm_link: r.company_id ? undefined : 'not linked to a CRM company',
          attending: true,
        })),
        statement: `booth ${booth} is assigned to ${live.map((r) => r.source_name).join(', ')}`,
        /* The previous tenant, only when it actually changed, and explicitly
           flagged so it can never be read as the current answer. */
        previous_occupant_on_our_map: changed
          ? compact({
            name: snapshot.source_company_name,
            note: 'PREVIOUS occupant from our booth-map snapshot — no longer at '
              + 'this booth. Any classification we hold about them applies to '
              + 'THEM, not to the current occupant.',
          })
          : undefined,
        size: snapshot ? snapshot.dims : undefined,
        as_of: provenance,
      });
    },
  },

  get_event_attendance_summary: {
    description:
      'HOW MANY companies are at the show, in total. Use this for any question '
      + 'about the SIZE of the event — "how many companies are attending", '
      + '"how many exhibitors", "多少家公司去展会", "参展商总数". It is the ONLY '
      + 'correct source for a global count. Never add up category lists to reach '
      + 'a total: the categories overlap, most of them are capped, and a company '
      + 'can be in several at once. Never use the booth map row count either — '
      + 'that counts stands, including empty ones, not exhibitors.',
    parameters: { type: 'object', properties: {} },
    async run() {
      const eventId = await currentEventId();

      /* One query, from the attendance table itself. event_exhibitors is the
         canonical record of who is coming — booths are a separate fact, which
         is why a company can be listed with no booth and why counting booths
         answers a different question from the one being asked. */
      const { rows: [t] } = await pool.query(
        `select count(*)::int listed,
                count(*) filter (where exists (
                  select 1 from exhibitor_booths b
                   where b.exhibitor_id = e.id and b.retired_at is null))::int with_booth
           from event_exhibitors e
          where e.attendance_status = 'listed'
            and ($1::int is null or e.event_id = $1)`, [eventId]);

      const { rows: [ev] } = await pool.query(
        `select name from events where ($1::int is null or id = $1) order by id limit 1`, [eventId]);
      const { rows: [run] } = await pool.query(
        `select finished_at, fetched from exhibitor_import_runs
          where status = 'success' order by finished_at desc limit 1`);

      const listed = Number(t.listed) || 0;
      const withBooth = Number(t.with_booth) || 0;
      return compact({
        event: ev ? ev.name : undefined,
        total_listed: listed,
        with_booth: withBooth,
        without_booth: listed - withBooth,
        // Not a page. Said explicitly, because every other list here is one.
        is_complete_total: true,
        verified_at: run ? run.finished_at : undefined,
        source: 'official event exhibitor list (MapYourShow), stored in event_exhibitors',
        note: 'Attendance and booth assignment are separate facts. A company can be '
          + 'listed as attending with no booth published yet.',
      });
    },
  },

  check_event_attendance: {
    description:
      'Whether a company is an exhibitor at the show, and if so where. This is '
      + 'the ONLY way to answer "is X attending" — attendance and booth assignment '
      + 'are separate facts, and a company can be listed with no booth yet. Never '
      + 'conclude a company is absent because another tool returned no booth.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, company_id: { type: 'integer' } },
    },
    async run(args) {
      const name = asText(args.name, 120);
      const companyId = asInt(args.company_id);
      if (!name && !companyId) return { error: 'name or company_id is required' };

      const eventId = await currentEventId();
      const { rows: [ev] } = await pool.query('select name from events where id = $1', [eventId]);

      /* Matched on the same normalized key the sync uses, plus a contains
         search so a user typing "CATL" finds "CATL Debrecen" if that is what
         is listed. Both statuses are returned — a retired row is the evidence
         for "appeared in an earlier dataset but is not in the latest list",
         which is a different answer from "never heard of them". */
      const { rows } = await pool.query(
        `select e.id, e.exhibitor_source_id, e.source_name, e.company_id,
                e.attendance_status, e.last_verified_at, e.retired_at, e.source,
                coalesce(array_agg(b.booth_number order by b.booth_number)
                         filter (where b.retired_at is null), '{}') booths
           from event_exhibitors e
           left join exhibitor_booths b on b.exhibitor_id = e.id
          where e.event_id = $1
            and (($2::int is not null and e.company_id = $2)
              or ($3::text is not null and (
                    e.name_key = $4 or lower(e.source_name) like $5)))
          group by e.id
          order by (e.attendance_status = 'listed') desc, e.source_name
          limit 10`,
        [eventId, companyId, name || null, name ? normalizeNameKey(name) : null,
          name ? `%${name.toLowerCase()}%` : null]);

      /* When was the list itself last confirmed? Without this the assistant
         can say "not attending" with no sense of how old that claim is. */
      const { rows: [run] } = await pool.query(
        `select finished_at, fetched from exhibitor_import_runs
          where status = 'success' order by finished_at desc limit 1`);

      const verified = run ? run.finished_at : null;
      const asOf = { source: 'official event exhibitor list', last_verified: verified,
        exhibitors_in_list: run ? run.fetched : null };

      if (!rows.length) {
        /* The important distinction. Absent from the exhibitor list is a
           verified negative; it is NOT "we could not find a booth". */
        return compact({
          query: name || `company_id ${companyId}`,
          event: ev ? ev.name : undefined,
          attending: false,
          status: 'not_in_official_list',
          statement: `not present in the latest official exhibitor list`,
          as_of: asOf,
        });
      }

      return {
        event: ev ? ev.name : undefined,
        as_of: asOf,
        matches: rows.map((r) => {
          const booths = (r.booths || []).filter(Boolean);
          const listed = r.attendance_status === 'listed';
          return compact({
            name: r.source_name,
            company_id: r.company_id,
            crm_link: r.company_id ? undefined : 'not linked to a CRM company',
            attending: listed,
            status: listed
              ? (booths.length ? 'listed_with_booth' : 'listed_no_booth_yet')
              : 'retired_from_list',
            booths: booths.length ? booths : undefined,
            statement: listed
              ? (booths.length
                ? `listed as an exhibitor, booth ${booths.join(', ')}`
                : 'listed as an exhibitor, but no booth assignment is published yet')
              : 'appeared in an earlier version of the exhibitor list, but is not in the latest one',
            last_verified: r.last_verified_at,
            retired_at: r.retired_at,
          });
        }),
      };
    },
  },

  search_companies: {
    description:
      'Find companies by name, Chinese name, or industry. Returns CRM companies '
      + 'with their booth number and whether we hold research or contacts. Use this '
      + 'first when the user names a company and you need its id.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or partial name to search for.' },
        limit: { type: 'integer', description: 'Rows to return (max 25).' },
      },
      required: ['query'],
    },
    async run(args) {
      const query = asText(args.query, 120);
      if (!query) return { error: 'query is required' };
      const limit = asLimit(args.limit, 10);
      const like = `%${query.toLowerCase()}%`;
      const { rows } = await pool.query(
        `select c.id, c.name, c.chinese_name, c.industry, c.booth,
                (select count(*)::int from contacts ct where ct.company_id = c.id) contacts,
                (select count(*)::int from account_reports ar where ar.company_id = c.id) reports,
                (select count(*)::int from communications m
                  where m.deleted_at is null
                    and (m.company_id = c.id
                      or m.contact_id in (select id from contacts where company_id = c.id))) messages,
                b.category booth_category, b.booth_number
           from companies c
           left join booth_map_booths b
                  on b.company_id = c.id and b.retired_at is null
          where lower(c.name) like $1 or lower(coalesce(c.chinese_name,'')) like $1
             or lower(coalesce(c.industry,'')) like $1
          order by (lower(c.name) = $2) desc, c.name
          limit $3`, [like, query.toLowerCase(), limit]);
      return {
        ...cardinality(await totalFor(
          `select count(*)::int n from companies c
            where lower(c.name) like $1 or lower(coalesce(c.chinese_name,'')) like $1
               or lower(coalesce(c.industry,'')) like $1`, [like]), rows),
        companies: rows.map((r) => compact({
          id: r.id, name: r.name, zh: r.chinese_name, industry: r.industry,
          booth: r.booth_number || r.booth, category: r.booth_category,
          contacts: r.contacts, research_reports: r.reports, messages: r.messages,
        })),
      };
    },
  },

  get_company_profile: {
    description:
      'Everything known about one company: industry, booth, categories, tags, '
      + 'contact and research counts, and whether it is classified as a competitor, '
      + 'target customer or ESS/EV project at the show.',
    parameters: {
      type: 'object',
      properties: { company_id: { type: 'integer' }, name: { type: 'string' } },
    },
    async run(args) {
      let id = asInt(args.company_id);
      if (!id && asText(args.name)) {
        const found = await TOOLS.search_companies.run({ query: args.name, limit: 2 });
        if (!found.companies.length) return { found: false, searched: asText(args.name) };
        /* Two plausible companies is a question for the user, not a coin toss.
           Answering about the wrong Acme is worse than asking which one. */
        if (found.companies.length > 1) {
          return { ambiguous: true, candidates: found.companies };
        }
        id = found.companies[0].id;
      }
      if (!id) return { error: 'company_id or name is required' };

      const company = await db.getCompany(id);
      if (!company) return { found: false, company_id: id };

      /* occupant_status comes from the official floor plan. Without it this
         returned our snapshot as fact, which is how "Comau is at booth 3626"
         survived five months after INTECELLS moved in. */
      const { rows: booths } = await pool.query(
        `select booth_number, category, status, dims, x, y, intro,
                occupant_status, live_occupant_name
           from booth_map_booths where company_id = $1 and retired_at is null`, [id]);

      // What the official floor plan currently assigns this company.
      const { rows: officialBooths } = await pool.query(
        `select b.booth_number from exhibitor_booths b
           join event_exhibitors e on e.id = b.exhibitor_id
          where e.company_id = $1 and b.retired_at is null
            and e.attendance_status = 'listed'`, [id]);
      const { rows: intel } = await pool.query(
        `select i.kind, i.reason, i.priority_label, i.background, i.role, i.segments
           from booth_intel i join booth_map_booths b on b.id = i.booth_id
          where b.company_id = $1 and i.retired_at is null`, [id]);
      const { rows: [counts] } = await pool.query(
        `select (select count(*)::int from contacts where company_id = $1) contacts,
                (select count(*)::int from account_reports where company_id = $1) reports,
                (select count(*)::int from communications m
                  where m.deleted_at is null
                    and (m.company_id = $1
                      or m.contact_id in (select id from contacts where company_id = $1))) comms`, [id]);
      let tags = [];
      try { tags = await db.listCompanyTags(id); } catch { tags = []; }

      return compact({
        id: company.id,
        name: company.name,
        zh: company.chinese_name,
        industry: company.industry,
        website: company.website,
        // Confirmed by the official floor plan, and therefore quotable.
        current_booths: officialBooths.map((b) => b.booth_number),
        booths: booths.map((b) => compact({
          booth: b.booth_number, category: b.category, status: b.status,
          size: b.dims, intro: snip(b.intro, 300),
          /* A snapshot row whose booth has changed hands or emptied is
             history. Named as such so it cannot be quoted as a location. */
          occupancy: b.occupant_status === 'reassigned'
            ? `NOT CURRENT — this booth is now assigned to ${b.live_occupant_name || 'another company'}`
            : b.occupant_status === 'vacated'
              ? 'NOT CURRENT — this booth is no longer in the official floor plan'
              : undefined,
          historical: b.occupant_status === 'reassigned' || b.occupant_status === 'vacated'
            ? true : undefined,
        })),
        show_classification: intel.map((i) => compact({
          kind: i.kind, why: snip(i.reason || i.background, 300),
          priority: i.priority_label, role: i.role,
          segments: Array.isArray(i.segments) ? i.segments : undefined,
        })),
        contacts: counts.contacts,
        research_reports: counts.reports,
        communications: counts.comms,
        tags: (tags || []).slice(0, 12).map((t) => t.tag_value || t.value || t.name).filter(Boolean),
      });
    },
  },

  list_companies_by_category: {
    description:
      'List Battery Show booths in a category: competitors (direct or indirect), '
      + 'target customers, ESS/EV projects, Chinese companies, battery materials, '
      + 'electronics, testing, manufacturing, assembly line, certification, recycling, '
      + 'government, or available space. Says when a booth is not linked to a CRM company.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'One of: competitor, direct_competitor, indirect_competitor, '
            + 'target_customer, ess_ev, chinese_company, battery_materials, electronics, '
            + 'testing, manufacturing, assembly_line, certification, recycling, government, other.',
        },
        limit: { type: 'integer' },
      },
      required: ['category'],
    },
    async run(args) {
      const raw = asText(args.category, 40).toLowerCase().replace(/[\s-]+/g, '_');
      const limit = asLimit(args.limit, 20);
      const eventId = await currentEventId();

      // Classifications that live in booth_intel rather than the booth's own
      // category column.
      const INTEL_KINDS = {
        competitor: ['competitor_direct', 'competitor_indirect'],
        direct_competitor: ['competitor_direct'],
        indirect_competitor: ['competitor_indirect'],
        ess_ev: ['ess_ev'],
        chinese_company: ['chinese_company'],
        target_customer: ['target_customer'],
      };

      if (INTEL_KINDS[raw]) {
        const { rows } = await pool.query(
          `select b.booth_number, b.source_company_name, b.company_id, b.category,
                  i.kind, i.reason, i.priority_label, i.role
             from booth_intel i
             join booth_map_booths b on b.id = i.booth_id
            where i.kind = any($1) and i.retired_at is null and b.retired_at is null
              and ($2::int is null or b.event_id = $2)
            order by i.priority nulls last, b.booth_number
            limit $3`, [INTEL_KINDS[raw], eventId, limit]);
        return {
          category: raw,
          ...cardinality(await totalFor(
            `select count(*)::int n from booth_intel i
               join booth_map_booths b on b.id = i.booth_id
              where i.kind = any($1) and i.retired_at is null and b.retired_at is null
                and ($2::int is null or b.event_id = $2)`, [INTEL_KINDS[raw], eventId]), rows),
          companies: rows.map((r) => compact({
            booth: r.booth_number,
            name: r.source_company_name,
            company_id: r.company_id,
            // Stated, not implied by an absent field.
            crm_link: r.company_id ? undefined : 'not linked to a CRM company',
            kind: r.kind,
            why: snip(r.reason, 240),
            priority: r.priority_label,
            role: r.role,
          })),
        };
      }

      const codes = CATEGORY_ALIASES[raw];
      if (!codes) {
        return { error: `unknown category "${raw}"`, valid: Object.keys(CATEGORY_ALIASES) };
      }
      const { rows } = await pool.query(
        `select booth_number, source_company_name, company_id, category, status, dims
           from booth_map_booths
          where category = any($1) and retired_at is null
            and ($2::int is null or event_id = $2)
          order by booth_number limit $3`, [codes, eventId, limit]);
      return {
        category: raw,
        ...cardinality(await totalFor(
          `select count(*)::int n from booth_map_booths
            where category = any($1) and retired_at is null
              and ($2::int is null or event_id = $2)`, [codes, eventId]), rows),
        companies: rows.map((r) => compact({
          booth: r.booth_number, name: r.source_company_name,
          company_id: r.company_id,
          crm_link: r.company_id ? undefined : 'not linked to a CRM company',
          category: r.category, status: r.status, size: r.dims,
        })),
      };
    },
  },

  find_available_booths: {
    description:
      'Free floor space at the show. Optionally ranked by the curated traffic, '
      + 'visibility and relevance scoring, or sorted by proximity to a given booth number.',
    parameters: {
      type: 'object',
      properties: {
        near_booth: { type: 'string', description: 'Booth number to measure distance from.' },
        ranked_only: { type: 'boolean', description: 'Only booths with a curated ranking.' },
        limit: { type: 'integer' },
      },
    },
    async run(args) {
      const limit = asLimit(args.limit, 10);
      const near = asText(args.near_booth, 20);
      const eventId = await currentEventId();

      if (near) {
        const { rows: [origin] } = await pool.query(
          `select x, y, booth_number, source_company_name from booth_map_booths
            where booth_number = $1 and retired_at is null
              and ($2::int is null or event_id = $2) limit 1`, [near, eventId]);
        if (!origin) return { found: false, near_booth: near };
        /* Euclidean on the map's own grid. Not metres — the coordinates are
           layout units — so this ranks proximity and never claims a distance. */
        const { rows } = await pool.query(
          `select b.booth_number, b.dims, b.x, b.y,
                  sqrt(power(b.x - $1, 2) + power(b.y - $2, 2)) dist,
                  i.score, i.grade, i.badge
             from booth_map_booths b
             left join booth_intel i on i.booth_id = b.id
                   and i.kind = 'available_ranked' and i.retired_at is null
            where b.category = 'available' and b.retired_at is null
              and ($3::int is null or b.event_id = $3)
            order by dist asc limit $4`, [origin.x, origin.y, eventId, limit]);
        return {
          near_booth: near,
          near_company: origin.source_company_name,
          note: 'Ordered by proximity on the floor-plan grid, nearest first.',
          ...cardinality(await totalFor(
            `select count(*)::int n from booth_map_booths b
              where b.category = 'available' and b.retired_at is null
                and ($1::int is null or b.event_id = $1)`, [eventId]), rows),
          booths: rows.map((r) => compact({
            booth: r.booth_number, size: r.dims,
            proximity_rank_units: Math.round(Number(r.dist)),
            score: r.score ? Number(r.score) : undefined, grade: r.grade,
          })),
        };
      }

      const { rows } = await pool.query(
        `select b.booth_number, b.dims, i.score, i.grade, i.badge, i.analysis
           from booth_map_booths b
           ${args.ranked_only ? 'join' : 'left join'} booth_intel i
                  on i.booth_id = b.id and i.kind = 'available_ranked' and i.retired_at is null
          where b.category = 'available' and b.retired_at is null
            and ($1::int is null or b.event_id = $1)
          order by i.score desc nulls last, b.booth_number
          limit $2`, [eventId, limit]);
      return {
        ...cardinality(await totalFor(
          `select count(*)::int n from booth_map_booths b
            where b.category = 'available' and b.retired_at is null
              and ($1::int is null or b.event_id = $1)`, [eventId]), rows),
        booths: rows.map((r) => compact({
          booth: r.booth_number, size: r.dims,
          score: r.score ? Number(r.score) : undefined,
          grade: r.grade, badge: r.badge, why: snip(r.analysis, 240),
        })),
      };
    },
  },

  get_company_contacts: {
    description: 'The people we know at a company: name, title, seniority and whether we hold an email.',
    parameters: {
      type: 'object',
      properties: { company_id: { type: 'integer' }, limit: { type: 'integer' } },
      required: ['company_id'],
    },
    async run(args) {
      const id = asInt(args.company_id);
      if (!id) return { error: 'company_id is required' };
      const limit = asLimit(args.limit, 15);
      const { rows } = await pool.query(
        `select id, full_name, job_title, department, seniority,
                (email is not null and email <> '') has_email
           from contacts where company_id = $1
          order by (seniority = 'c_suite') desc, full_name limit $2`, [id, limit]);
      /*
       * The TOTAL, separately from the page.
       *
       * Without it the model reads `count` as "how many there are" and says
       * "we have 15 contacts for CATL" when there are 47 — an overconfident
       * claim produced entirely by the row cap. The page is what is shown; the
       * total is what is true.
       */
      const { rows: [t] } = await pool.query(
        'select count(*)::int n from contacts where company_id = $1', [id]);
      return {
        company_id: id,
        total_contacts: t.n,
        showing: rows.length,
        truncated: t.n > rows.length,
        /* Addresses are deliberately not returned. The assistant answers "who
           do we know", and a chat transcript is a poor place to spread contact
           details that already exist behind the CRM's own screens. */
        contacts: rows.map((r) => compact({
          id: r.id, name: r.full_name, title: r.job_title,
          department: r.department, seniority: r.seniority,
          email_on_file: r.has_email,
        })),
      };
    },
  },

  get_account_research: {
    description:
      'Account Research reports held for a company: which sections were researched '
      + 'live, which fell back to placeholders, and the findings. Use to answer '
      + '"have we researched them" and "what did we find".',
    parameters: {
      type: 'object',
      properties: {
        company_id: { type: 'integer' },
        report_id: { type: 'string', description: 'Fetch one report in full.' },
      },
    },
    async run(args) {
      /*
       * The shape here is not what it looks like, and live testing is how that
       * surfaced. `account_reports.id` is TEXT, not a serial. `sections` is a
       * STATUS map ({cd:'live', fd:'fallback', …}), not an array of content —
       * jsonb_array_length on it threw for every single report, so the whole
       * Account Research capability failed and fell back to the premium model.
       * The findings live in `data`, keyed by the same section codes.
       *
       * The live/fallback distinction is reported rather than hidden: a
       * "fallback" section means research failed and the text is a placeholder,
       * which a salesperson must not be handed as a finding.
       */
      const reportId = asText(args.report_id, 120);
      if (reportId) {
        const { rows } = await pool.query(
          `select id, company_name, report_type, created_at, sections, data
             from account_reports where id = $1`, [reportId]);
        if (!rows.length) return { found: false, report_id: reportId };
        return renderReport(rows[0], true);
      }

      const id = asInt(args.company_id);
      if (!id) return { error: 'company_id or report_id is required' };
      const { rows } = await pool.query(
        `select id, company_name, report_type, created_at, sections, data
           from account_reports where company_id = $1
          order by created_at desc limit 5`, [id]);

      let sources = [];
      try { sources = (await db.listResearchSources(id)) || []; } catch { sources = []; }

      return {
        company_id: id,
        has_research: rows.length > 0,
        // Capped at 5 like every other list here, and says so.
        ...cardinality(await totalFor(
          `select count(*)::int n from account_reports where company_id = $1`, [id]), rows),
        // Newest in full, the rest as headers — "summarise the latest" is the
        // question, and five full reports would be most of a context window.
        latest: rows.length ? renderReport(rows[0], true) : undefined,
        earlier: rows.slice(1).map((r) => renderReport(r, false)),
        sources: sources.slice(0, 8).map((x) => compact({ title: x.title, url: x.url })),
      };
    },
  },

  get_communication_history: {
    description:
      'Email and outreach history for a company or contact: subject, status, direction '
      + 'and dates. Answers "have we contacted them" and "what was sent".',
    parameters: {
      type: 'object',
      properties: {
        company_id: { type: 'integer' },
        contact_id: { type: 'integer' },
        limit: { type: 'integer' },
      },
    },
    async run(args) {
      const companyId = asInt(args.company_id);
      const contactId = asInt(args.contact_id);
      if (!companyId && !contactId) return { error: 'company_id or contact_id is required' };
      const limit = asLimit(args.limit, 15);
      const { rows } = await pool.query(
        `select m.id, m.subject, m.status, m.comm_type, m.category,
                m.sent_at, m.created_at, m.replied_at, c.full_name contact
           from communications m
           left join contacts c on c.id = m.contact_id
          where m.deleted_at is null
            and (($1::int is not null and ${COMMS_FOR_COMPANY.replace(/\$COMPANY\$/g, '$1')})
              or ($2::int is not null and m.contact_id = $2))
          order by coalesce(m.sent_at, m.created_at) desc
          limit $3`, [companyId, contactId, limit]);
      /* Totals, computed over everything rather than over the page. The same
         cap that truncated the list also made "sent" and "drafted" wrong: one
         live answer said 2 sent / 8 drafts and another said 1 sent / 56 total
         for the same company, because each was counting its own page. */
      const { rows: [t] } = await pool.query(
        `select count(*)::int total,
                count(*) filter (where m.sent_at is not null)::int sent
           from communications m
          where m.deleted_at is null
            and (($1::int is not null and (m.company_id = $1
                   or m.contact_id in (select id from contacts where company_id = $1)))
              or ($2::int is not null and m.contact_id = $2))`, [companyId, contactId]);
      return {
        total_messages: t.total,
        total_sent: t.sent,
        total_drafts: t.total - t.sent,
        showing: rows.length,
        truncated: t.total > rows.length,
        /* Subjects and status only. The body is real customer correspondence
           and is not what "have we contacted them" needs — get_latest_draft
           returns content, and only when asked for. */
        messages: rows.map((r) => compact({
          id: r.id, subject: r.subject, status: r.status, type: r.comm_type,
          category: r.category, contact: r.contact,
          sent: r.sent_at, replied: r.replied_at,
        })),
      };
    },
  },

  get_latest_draft: {
    description:
      'The most recent email draft, for a contact or for a company. Pass '
      + 'company_id when the user means "this company" and contact_id only when '
      + 'you have an actual contact id from get_company_contacts.',
    parameters: {
      type: 'object',
      properties: {
        company_id: { type: 'integer', description: 'Latest draft anywhere in this company.' },
        contact_id: { type: 'integer', description: 'Latest draft for one person.' },
      },
    },
    async run(args) {
      const companyId = asInt(args.company_id);
      const contactId = asInt(args.contact_id);
      if (!companyId && !contactId) return { error: 'company_id or contact_id is required' };

      /*
       * A contact id is verified to BE a contact before it is used.
       *
       * Live testing caught this: asked for "the latest draft for this
       * company" with company_id 3 in page context, the model passed
       * `contact_id: 3` — and contact 3 is a different person at a different
       * company. The tool answered confidently with another customer's email.
       * An id that resolves to nothing is a mistake; an id that resolves to
       * the WRONG row is a disclosure, so this refuses rather than guessing.
       */
      if (contactId) {
        const { rows: who } = await pool.query(
          'select id, company_id, full_name from contacts where id = $1', [contactId]);
        if (!who.length) return { found: false, contact_id: contactId, note: 'no such contact' };
        if (companyId && who[0].company_id !== companyId) {
          return {
            error: 'contact_id and company_id disagree',
            note: `contact ${contactId} belongs to company ${who[0].company_id}, not ${companyId}. `
              + 'Use get_company_contacts to find a contact at this company.',
          };
        }
      }

      const { rows } = await pool.query(
        `select m.id, m.subject, m.body, m.status, m.category, m.created_at, m.sent_at,
                c.full_name contact, c.company_id
           from communications m
           left join contacts c on c.id = m.contact_id
          where m.deleted_at is null
            and (($1::int is not null and m.contact_id = $1)
              or ($2::int is not null and (m.company_id = $2
                   or m.contact_id in (select id from contacts where company_id = $2))))
          order by m.created_at desc limit 1`, [contactId, companyId]);

      if (!rows.length) {
        return { found: false, company_id: companyId, contact_id: contactId };
      }
      const d = rows[0];
      return compact({
        id: d.id, subject: d.subject, status: d.status, category: d.category,
        to_contact: d.contact, company_id: d.company_id,
        created: d.created_at, sent: d.sent_at,
        body: snip(d.body, 1200),
      });
    },
  },

  find_gaps: {
    description:
      'Find where outreach is missing: companies with research but no email drafted, '
      + 'target customers with no contact at all, or booths in a category we have not '
      + 'approached. This is the "who should I follow up with" tool.',
    parameters: {
      type: 'object',
      properties: {
        gap: {
          type: 'string',
          description: 'One of: research_no_outreach, no_outreach, no_contacts, no_research.',
        },
        category: { type: 'string', description: 'Optional booth category to narrow to.' },
        limit: { type: 'integer' },
      },
      required: ['gap'],
    },
    async run(args) {
      const gap = asEnum(args.gap,
        ['research_no_outreach', 'no_outreach', 'no_contacts', 'no_research']);
      if (!gap) {
        return { error: 'unknown gap', valid: ['research_no_outreach', 'no_outreach', 'no_contacts', 'no_research'] };
      }
      const limit = asLimit(args.limit, 20);
      const eventId = await currentEventId();
      const catRaw = asText(args.category, 40).toLowerCase().replace(/[\s-]+/g, '_');
      const intelKind = { target_customer: 'target_customer', ess_ev: 'ess_ev',
        competitor: 'competitor_direct', chinese_company: 'chinese_company' }[catRaw] || null;
      const codes = CATEGORY_ALIASES[catRaw] || null;

      /* One query shape with the gap expressed as a predicate, so every gap is
         computed the same way and a company cannot appear under one framing
         and vanish under another. LEFT JOIN throughout: a booth with no CRM
         company is a gap, not a row to drop. */
      const PREDICATE = {
        research_no_outreach: 'r.n > 0 and m.n = 0',
        no_outreach: 'm.n = 0',
        no_contacts: 'ct.n = 0',
        no_research: 'r.n = 0',
      }[gap];

      const { rows } = await pool.query(
        `select b.booth_number, b.source_company_name, b.company_id, b.category,
                coalesce(ct.n,0) contacts, coalesce(r.n,0) reports, coalesce(m.n,0) messages,
                i.kind, i.priority_label
           from booth_map_booths b
           left join lateral (select count(*)::int n from contacts where company_id = b.company_id) ct on true
           left join lateral (select count(*)::int n from account_reports where company_id = b.company_id) r on true
           left join lateral (
             select count(*)::int n from communications m2
              where m2.deleted_at is null
                and (m2.company_id = b.company_id
                  or m2.contact_id in (select id from contacts where company_id = b.company_id))
           ) m on true
           left join booth_intel i on i.booth_id = b.id and i.retired_at is null
                 and ($4::text is null or i.kind = $4)
          where b.retired_at is null
            and b.match_confidence <> 'not_a_company'
            and ($1::int is null or b.event_id = $1)
            and ($2::text[] is null or b.category = any($2))
            and ($4::text is null or i.kind is not null)
            and ${PREDICATE}
          order by i.priority nulls last, b.booth_number
          limit $3`,
        [eventId, codes, limit, intelKind]);

      return {
        gap,
        category: catRaw || undefined,
        ...cardinality(null, rows),
        companies: rows.map((r) => compact({
          booth: r.booth_number, name: r.source_company_name, company_id: r.company_id,
          crm_link: r.company_id ? undefined : 'not linked to a CRM company',
          category: r.category, classification: r.kind, priority: r.priority_label,
          contacts: r.contacts, research_reports: r.reports, messages: r.messages,
        })),
      };
    },
  },

  summarize_account_activity: {
    description:
      'Everything that has happened on one account: contacts, research, outreach and '
      + 'its position at the show, in one call. Use when the user asks to summarise an account.',
    parameters: {
      type: 'object',
      properties: { company_id: { type: 'integer' } },
      required: ['company_id'],
    },
    async run(args) {
      const id = asInt(args.company_id);
      if (!id) return { error: 'company_id is required' };
      const profile = await TOOLS.get_company_profile.run({ company_id: id });
      if (profile.found === false) return profile;
      const [contacts, research, comms] = await Promise.all([
        TOOLS.get_company_contacts.run({ company_id: id, limit: 8 }),
        TOOLS.get_account_research.run({ company_id: id }),
        TOOLS.get_communication_history.run({ company_id: id, limit: 8 }),
      ]);
      return {
        company: profile,
        contacts: { total: contacts.total_contacts, showing: contacts.contacts },
        research: { has_research: research.has_research, count: research.report_count,
          latest: research.latest },
        outreach: {
          total: comms.total_messages, sent: comms.total_sent, drafts: comms.total_drafts,
          recent: (comms.messages || []).slice(0, 5),
        },
      };
    },
  },
};

/** The catalogue in the shape an OpenAI-compatible endpoint expects. */
function toolSchemas() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    type: 'function',
    function: { name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Runs one tool call. Never throws: a tool failure is an answer the model can
 * reason about ("I could not read that") rather than a crashed request.
 */
async function runTool(name, args, { timeoutMs = 8000 } = {}) {
  const tool = TOOLS[name];
  if (!tool) return { error: `unknown tool "${name}"` };

  let parsed = args;
  if (typeof args === 'string') {
    try { parsed = JSON.parse(args); } catch { return { error: 'arguments were not valid JSON' }; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

  const started = Date.now();
  try {
    const result = await Promise.race([
      tool.run(parsed),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tool timed out')), timeoutMs)),
    ]);
    return { ...result, _ms: Date.now() - started };
  } catch (e) {
    // The message, not the stack, and never the SQL — this goes back to a model
    // whose output the user reads.
    console.error(`[chat-tool] ${name} failed:`, e.message);
    return { error: `${name} failed to run`, detail: String(e.message).slice(0, 120) };
  }
}

module.exports = {
  TOOLS, MAX_ROWS, SNIPPET, CATEGORY_ALIASES, COMMS_FOR_COMPANY, RESEARCH_SECTIONS,
  toolSchemas, runTool,
  asInt, asLimit, asText, asEnum, compact, snip, currentEventId,
};
