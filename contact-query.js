/* ═══════════════════════════════════════════════════════════════════════
   contact-query.js — one SQL builder for the CRM contact grid.

   Every way of narrowing the contact list compiles to the same WHERE:

     · the left sidebar   (trade show, booth category, account, seniority…)
     · the global search  (q)
     · the column filters (Excel-style menus in each table header)

   They are the *same* predicate list, so they AND together for free and
   the facet counts, the row page and the total all agree by construction.

   Nothing here reads or paginates in JS: the grid is specified to scale to
   hundreds of thousands of contacts, so filtering, sorting, counting and
   paging all happen in Postgres. The browser only ever holds one page.

   Every user value is bound as a parameter — none is interpolated into
   SQL text. Column names for ORDER BY come from a fixed whitelist.
   ═══════════════════════════════════════════════════════════════════════ */

/* Free-mail providers, used to split "company email" from "personal email".
   Includes the Chinese providers that show up in this dataset — an
   Anglo-only list would misfile every 163/qq/foxmail address as corporate. */
const PERSONAL_EMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'gmx.com', 'gmx.de',
  'protonmail.com', 'proton.me', 'mail.com', 'zoho.com', 'yandex.ru',
  'qq.com', '163.com', '126.com', 'sina.com', 'sina.cn', 'foxmail.com',
  'sohu.com', '139.com', '189.cn', 'aliyun.com', 'tom.com', '21cn.com',
];

/* ── Vocabularies ─────────────────────────────────────────────────────
   Each entry is an option in a column menu. `label`/`label_cn` drive the
   bilingual UI; `key` is what travels over the wire and what the SQL
   fragments below are keyed by. Kept server-side so the menu and the
   query can never drift apart. */

const EMAIL_MODES = [
  { key: 'has',      label: 'Has email',      label_cn: '有邮箱' },
  { key: 'missing',  label: 'Missing email',  label_cn: '缺少邮箱' },
  { key: 'company',  label: 'Company email',  label_cn: '公司邮箱' },
  { key: 'personal', label: 'Personal email', label_cn: '个人邮箱' },
];

const ACTIVITY_STATES = [
  { key: 'never',   label: 'Never contacted',   label_cn: '从未联系' },
  { key: 'draft',   label: 'Draft exists',      label_cn: '已有草稿' },
  { key: 'sent',    label: 'Email sent',        label_cn: '已发送' },
  { key: 'replied', label: 'Reply received',    label_cn: '已回复' },
  { key: 'bounced', label: 'Returned/Bounced',  label_cn: '退信' },
  { key: 'meeting', label: 'Meeting scheduled', label_cn: '已约会议' },
];

const DRAFT_STATES = [
  { key: 'none',      label: 'No draft',     label_cn: '无草稿' },
  { key: 'ai',        label: 'AI draft',     label_cn: 'AI 草稿' },
  { key: 'edited',    label: 'Human edited', label_cn: '人工编辑' },
  { key: 'sent',      label: 'Sent',         label_cn: '已发送' },
  { key: 'scheduled', label: 'Scheduled',    label_cn: '已排程' },
];

/* Extends the five statuses the inline <select> already wrote, with the
   three the grid spec asks for. Existing rows keep their values; the new
   ones are simply selectable now. */
const CONTACT_STATUSES = [
  { key: 'not_contacted',    label: 'Not contacted',  label_cn: '未联系' },
  { key: 'contacted',        label: 'Contacted',      label_cn: '已联系' },
  { key: 'replied',          label: 'Replied',        label_cn: '已回复' },
  { key: 'qualified',        label: 'Qualified',      label_cn: '已确认商机' },
  { key: 'meeting_scheduled',label: 'Meeting scheduled', label_cn: '已约会议' },
  { key: 'customer',         label: 'Customer',       label_cn: '客户' },
  { key: 'do_not_contact',   label: 'Do not contact', label_cn: '请勿联系' },
  { key: 'closed',           label: 'Closed',         label_cn: '已关闭' },
];

/* Canonical sources. The DB currently holds apollo/manual/business_card;
   the rest are declared so the ingest paths that will write them already
   have a name, and so the menu reads as a complete vocabulary rather than
   whatever happens to exist today. Counts come from the DB, so unused
   ones render as (0) instead of pretending. */
const CONTACT_SOURCES = [
  { key: 'apollo',        label: 'Apollo',        label_cn: 'Apollo' },
  { key: 'battery_show',  label: 'Battery Show',  label_cn: '电池展' },
  { key: 'business_card', label: 'Business Card', label_cn: '名片' },
  { key: 'manual',        label: 'Manual',        label_cn: '手动创建' },
  { key: 'email_import',  label: 'Email Import',  label_cn: '邮件导入' },
];

/* ── Company discovery ───────────────────────────────────────────────
   How a company entered the CRM. This is where an uploaded file belongs:
   the CSV/Excel supplies company *names*, the system matches or creates
   the company records, and Apollo then supplies the contacts. A contact
   found this way is an Apollo contact whose company was discovered from a
   file — three separate facts, and flattening them into one "source" is
   what would make the upload look like it produced the people. */
const COMPANY_SOURCES = [
  { key: 'file_upload',   label: 'File upload',      label_cn: '文件上传' },
  { key: 'manual',        label: 'Manually created', label_cn: '手动创建' },
  { key: 'exhibitor_list',label: 'Exhibitor list',   label_cn: '参展商名录' },
  { key: 'apollo',        label: 'Apollo',           label_cn: 'Apollo' },
  /* Indirect creation, split by which operation did it. These replace a
     single vague 'derived': knowing a company appeared because someone
     saved a contact is actionable, "derived" is not. crm_side_effect is the
     honest catch-all for any path that has not been labelled yet. */
  { key: 'contact_creation', label: 'Created with a contact', label_cn: '随联系人创建' },
  { key: 'email_import',     label: 'Email import',          label_cn: '邮件导入' },
  { key: 'crm_side_effect',  label: 'CRM side effect',       label_cn: 'CRM 附带创建' },
  { key: 'legacy',        label: 'Not recorded',     label_cn: '未记录' },
];

/* Which company source an indirectly-created company should get, based on
   what kind of contact caused it. Keeps the mapping in one place instead of
   repeated at each upsertCompany call site. */
function companySourceForContact(contactSource) {
  switch (contactSource) {
    case 'apollo':       return 'apollo';
    case 'email_import': return 'email_import';
    case 'business_card':
    case 'battery_show':
    case 'manual':       return 'contact_creation';
    default:             return 'contact_creation';
  }
}

/* ── Email provenance ────────────────────────────────────────────────
   Where a stored address came from, which is a different question from
   where the *contact* came from: a Battery Show contact can have an
   Apollo-revealed email, and an Apollo contact can have one typed by hand.

   `costsCredits` is the field that matters operationally. Reading an
   address that is already in the CRM is free no matter who originally
   supplied it; only asking Apollo to reveal one spends money. Anything
   that can spend money has to be chosen explicitly by the user. */
const EMAIL_SOURCES = [
  { key: 'apollo_search',     label: 'Apollo search',      label_cn: 'Apollo 搜索', costsCredits: false },
  { key: 'apollo_enrichment', label: 'Apollo enrichment',  label_cn: 'Apollo 增强', costsCredits: true },
  { key: 'business_card',     label: 'Business card',      label_cn: '名片',       costsCredits: false },
  { key: 'manual',            label: 'Manually entered',   label_cn: '手动输入',   costsCredits: false },
  { key: 'email_import',      label: 'Imported email',     label_cn: '导入邮件',   costsCredits: false },
  { key: 'battery_show',      label: 'Battery Show data',  label_cn: '电池展数据', costsCredits: false },
  // Rows that predate provenance tracking. Named rather than blank, so the
  // details panel can say "not recorded" instead of implying a known source.
  { key: 'apollo_legacy',     label: 'Apollo (source not recorded)', label_cn: 'Apollo（来源未记录）', costsCredits: false },
  { key: 'legacy',            label: 'Not recorded',       label_cn: '未记录',     costsCredits: false },
  { key: 'none',              label: 'No email stored',    label_cn: '暂无邮箱',   costsCredits: false },
];

const EMAIL_SOURCE_BY_KEY = Object.fromEntries(EMAIL_SOURCES.map((s) => [s.key, s]));

/* The only two values that are ever written after a paid Apollo call. Used
   by the reveal endpoint to label what it did, and by the audit test that
   asserts no free path can claim a paid provenance. */
const PAID_EMAIL_SOURCES = EMAIL_SOURCES.filter((s) => s.costsCredits).map((s) => s.key);

const TEXT_MODES = ['contains', 'starts', 'ends', 'equals', 'empty', 'notEmpty'];

const SORTABLE = {
  contact:  'c.full_name',
  company:  'c.company',
  email:    'c.email',
  activity: 'last_activity_at',
  tags:     'c.tags',
  status:   'c.follow_up_status',
  draft:    'draft_count',
  source:   'c.source',
  created:  'c.id',
};

/* contacts.last_contacted_at and contacts.meeting_date are text columns,
   and the rows that have no value hold '' rather than NULL. An IS NULL test
   against them is therefore always false and an IS NOT NULL always true —
   which is how "never contacted" first counted 0 of 870 and "meeting
   scheduled" counted all 870. Everything below goes through these two
   helpers instead of testing the raw columns.

   The regexp guard matters as well as the NULLIF: a free-text column can
   hold "next week", and an unguarded ::timestamptz cast on that aborts the
   whole query rather than skipping the row. */
const textDate = (col) => `(CASE WHEN ${col} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN ${col}::timestamptz END)`;
const LAST_CONTACTED_AT = textDate('c.last_contacted_at');
const HAS_LAST_CONTACTED = `NULLIF(TRIM(c.last_contacted_at), '') IS NOT NULL`;
const HAS_MEETING_DATE = `NULLIF(TRIM(c.meeting_date), '') IS NOT NULL`;

/* Last-touch timestamp, as one expression so the Activity date filter and
   the Activity sort agree on what "last activity" means. */
const LAST_ACTIVITY_SQL = `COALESCE(
  (SELECT MAX(COALESCE(x.sent_at, x.created_at)) FROM communications x WHERE x.contact_id = c.id),
  ${LAST_CONTACTED_AT}
)`;

/* ── Option predicates ───────────────────────────────────────────────
   The checkbox options for Email / Activity / Draft, as SQL.

   These are shared verbatim by two callers: the WHERE builder below, and
   the facet counter in db.js. They were written twice at first, and the
   two copies had already disagreed about NULL handling before this
   comment existed — one map means a menu can never show a count the
   filter won't reproduce.

   Every fragment is a constant: no user input reaches them, so they need
   no parameters and can be referenced anywhere. */
const PERSONAL_DOMAIN_LITERAL = `ARRAY[${PERSONAL_EMAIL_DOMAINS
  .map((d) => { if (!/^[a-z0-9.-]+$/.test(d)) throw new Error(`unsafe domain literal: ${d}`); return `'${d}'`; })
  .join(',')}]`;

const HAS_EMAIL = `(c.email IS NOT NULL AND TRIM(c.email) <> '')`;
const IS_PERSONAL_EMAIL = `SPLIT_PART(LOWER(TRIM(c.email)), '@', 2) = ANY(${PERSONAL_DOMAIN_LITERAL})`;
const commExists = (cond) => `EXISTS (SELECT 1 FROM communications x WHERE x.contact_id = c.id AND ${cond})`;
const liveComm = (cond) => commExists(`x.deleted_at IS NULL AND (${cond})`);
const ANY_DRAFT = `(${liveComm(`x.comm_type = 'draft'`)} OR (c.draft_body IS NOT NULL AND TRIM(c.draft_body) <> ''))`;
const WAS_EDITED = `(${liveComm(`x.source = 'manual_edit'`)}
  OR EXISTS (SELECT 1 FROM contact_activity a WHERE a.contact_id = c.id AND a.activity_type = 'draft_edited'))`;

const OPTION_SQL = {
  email: {
    has:      HAS_EMAIL,
    missing:  `(c.email IS NULL OR TRIM(c.email) = '')`,
    personal: `(${HAS_EMAIL} AND ${IS_PERSONAL_EMAIL})`,
    company:  `(${HAS_EMAIL} AND NOT (${IS_PERSONAL_EMAIL}))`,
  },
  activity: {
    never:   `(NOT ${commExists('TRUE')} AND NOT ${HAS_LAST_CONTACTED})`,
    draft:   liveComm(`x.comm_type = 'draft'`),
    sent:    `(${liveComm(`x.sent_at IS NOT NULL OR x.delivery_status = 'sent'`)} OR c.follow_up_status = 'contacted')`,
    replied: `(c.follow_up_status = 'replied' OR ${liveComm(`x.delivery_status = 'replied'`)})`,
    bounced: liveComm(`x.delivery_status IN ('bounced', 'failed') OR x.send_error IS NOT NULL`),
    meeting: `(c.follow_up_status = 'meeting_scheduled' OR ${HAS_MEETING_DATE})`,
  },
  draft: {
    none:      `NOT ${ANY_DRAFT}`,
    // "AI draft" means generated and never touched by a human — otherwise
    // every edited draft would also count as an AI one and the two options
    // would overlap into uselessness.
    ai:        `(${ANY_DRAFT} AND NOT ${WAS_EDITED})`,
    edited:    WAS_EDITED,
    sent:      liveComm(`x.sent_at IS NOT NULL OR x.delivery_status = 'sent'`),
    scheduled: liveComm(`x.scheduled_at IS NOT NULL AND x.sent_at IS NULL`),
  },
};

/* ── Parameter accumulator ───────────────────────────────────────────
   Hands out $1, $2 … in order so fragments can be written independently
   without any of them knowing its own position. */
class Params {
  constructor() { this.values = []; }
  add(v) { this.values.push(v); return `$${this.values.length}`; }
}

/* ── Normalisation ────────────────────────────────────────────────────
   Anything from the wire passes through here first. Unknown option keys
   are dropped rather than trusted, so a hand-edited URL cannot smuggle a
   value into a fragment. */

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const cleanStrings = (v) => asArray(v).map((s) => String(s).trim()).filter(Boolean);
const onlyKnown = (v, vocab) => {
  const allowed = new Set(vocab.map((o) => o.key));
  return cleanStrings(v).filter((s) => allowed.has(s));
};

function normalizeColumnFilters(raw = {}) {
  const f = {};

  const contact = raw.contact || {};
  const contactMode = TEXT_MODES.includes(contact.mode) ? contact.mode : 'contains';
  const contactValue = String(contact.value ?? '').trim();
  // "empty"/"notEmpty" need no operand; the text modes are inert without one.
  if (contactMode === 'empty' || contactMode === 'notEmpty') f.contact = { mode: contactMode, value: '' };
  else if (contactValue) f.contact = { mode: contactMode, value: contactValue };

  const companies = cleanStrings((raw.company || {}).values);
  if (companies.length) f.company = { values: companies };

  const email = raw.email || {};
  const emailModes = onlyKnown(email.modes, EMAIL_MODES);
  const domain = String(email.domain ?? '').trim();
  if (emailModes.length || domain) f.email = { modes: emailModes, domain };

  const activity = raw.activity || {};
  const activityStates = onlyKnown(activity.states, ACTIVITY_STATES);
  const within = ['7d', '30d'].includes(activity.within) ? activity.within : null;
  const from = String(activity.from ?? '').trim();
  const to = String(activity.to ?? '').trim();
  if (activityStates.length || within || from || to) {
    f.activity = { states: activityStates, within, from, to };
  }

  const tags = raw.tags || {};
  const tagValues = cleanStrings(tags.values);
  if (tagValues.length) f.tags = { values: tagValues, match: tags.match === 'all' ? 'all' : 'any' };

  const statuses = onlyKnown((raw.status || {}).values, CONTACT_STATUSES);
  if (statuses.length) f.status = { values: statuses };

  const draftStates = onlyKnown((raw.draft || {}).states, DRAFT_STATES);
  if (draftStates.length) f.draft = { states: draftStates };

  const sources = onlyKnown((raw.source || {}).values, CONTACT_SOURCES);
  if (sources.length) f.source = { values: sources };

  return f;
}

/* ── Column predicates ────────────────────────────────────────────────
   One function per column, each returning a single SQL string (already
   parenthesised where it contains OR) or null when inactive. */

function contactClause(spec, p) {
  const name = 'COALESCE(NULLIF(TRIM(c.full_name), \'\'), NULLIF(TRIM(CONCAT_WS(\' \', c.first_name, c.last_name)), \'\'))';
  switch (spec.mode) {
    case 'empty':    return `${name} IS NULL`;
    case 'notEmpty': return `${name} IS NOT NULL`;
    case 'starts':   return `${name} ILIKE ${p.add(escapeLike(spec.value) + '%')}`;
    case 'ends':     return `${name} ILIKE ${p.add('%' + escapeLike(spec.value))}`;
    case 'equals':   return `LOWER(${name}) = LOWER(${p.add(spec.value)})`;
    default:         return `${name} ILIKE ${p.add('%' + escapeLike(spec.value) + '%')}`;
  }
}

/* A user searching for "A&P (Ltd)" must not have their % and _ treated as
   wildcards; ESCAPE '\' pairs with this. */
function escapeLike(s) { return String(s).replace(/([\\%_])/g, '\\$1'); }

function emailClause(spec, p) {
  const parts = [];
  // Modes are alternatives within the column ("has OR personal"), matching
  // how a checkbox list reads.
  if (spec.modes.length) parts.push(`(${spec.modes.map((m) => OPTION_SQL.email[m]).join(' OR ')})`);
  if (spec.domain) {
    const d = spec.domain.replace(/^@?/, '@');   // "tesla.com" and "@tesla.com" mean the same thing
    parts.push(`LOWER(c.email) LIKE ${p.add('%' + escapeLike(d.toLowerCase()) + '%')} ESCAPE '\\'`);
  }
  return parts.length ? `(${parts.join(' AND ')})` : null;
}

function activityClause(spec, p) {
  const parts = [];
  if (spec.states.length) parts.push(`(${spec.states.map((st) => OPTION_SQL.activity[st]).join(' OR ')})`);

  // A date window narrows *when* the activity happened, so it ANDs with the
  // state rather than joining the OR list.
  if (spec.within === '7d')  parts.push(`${LAST_ACTIVITY_SQL} >= NOW() - INTERVAL '7 days'`);
  if (spec.within === '30d') parts.push(`${LAST_ACTIVITY_SQL} >= NOW() - INTERVAL '30 days'`);
  if (spec.from) parts.push(`${LAST_ACTIVITY_SQL} >= ${p.add(spec.from)}::timestamptz`);
  // Inclusive of the end date: a range ending "Aug 3" should contain Aug 3.
  if (spec.to)   parts.push(`${LAST_ACTIVITY_SQL} < (${p.add(spec.to)}::timestamptz + INTERVAL '1 day')`);

  return parts.length ? `(${parts.join(' AND ')})` : null;
}

/* Tags live in two places: the normalised contact_tags join and the free-text
   contacts.tags column the inline grid input writes. A tag matches if either
   store has it, so the filter keeps working through the migration between
   them instead of quietly missing half the data. */
function tagClause(spec, p) {
  const per = (value) => {
    const v = p.add(value);
    return `(EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
              WHERE ct.contact_id = c.id AND (t.value = ${v} OR t.name_en = ${v} OR t.name_cn = ${v}))
            OR c.tags ILIKE ${p.add('%' + escapeLike(value) + '%')} ESCAPE '\\')`;
  };
  const joiner = spec.match === 'all' ? ' AND ' : ' OR ';
  return `(${spec.values.map(per).join(joiner)})`;
}

function draftClause(spec) {
  return `(${spec.states.map((st) => OPTION_SQL.draft[st]).join(' OR ')})`;
}

/* ── Sidebar / global-search predicates ──────────────────────────────
   Unchanged in meaning from the previous filterContacts(); moved here so
   they share one parameter space with the column filters. */
function sidebarClauses(f, p) {
  const out = [];

  if (f.q) {
    const like = p.add('%' + escapeLike(f.q) + '%');
    out.push(`(c.full_name ILIKE ${like} ESCAPE '\\' OR c.company ILIKE ${like} ESCAPE '\\'
               OR c.email ILIKE ${like} ESCAPE '\\' OR c.job_title ILIKE ${like} ESCAPE '\\')`);
  }
  if (f.event) out.push(`c.event_id IN (SELECT id FROM events WHERE LOWER(name) = LOWER(${p.add(f.event)}))`);
  if (f.company) out.push(`c.company ILIKE ${p.add('%' + escapeLike(f.company) + '%')} ESCAPE '\\'`);
  if (f.industry) out.push(`comp.industry ILIKE ${p.add('%' + escapeLike(f.industry) + '%')} ESCAPE '\\'`);
  if (f.follow_up_status) out.push(`c.follow_up_status = ${p.add(f.follow_up_status)}`);
  if (f.assigned_salesperson) out.push(`c.assigned_salesperson ILIKE ${p.add('%' + escapeLike(f.assigned_salesperson) + '%')} ESCAPE '\\'`);

  const accounts = cleanStrings(f.accounts).map((s) => s.toLowerCase());
  if (accounts.length) out.push(`LOWER(acc.name) = ANY(${p.add(accounts)}::text[])`);

  const ids = asArray(f.contact_ids).map(Number).filter(Number.isInteger);
  if (ids.length) out.push(`c.id = ANY(${p.add(ids)}::int[])`);

  const depts = cleanStrings(f.department_categories);
  if (depts.length) out.push(`c.department_category = ANY(${p.add(depts)}::text[])`);

  const seniorities = cleanStrings(f.seniority_levels);
  if (seniorities.length) out.push(`c.seniority_level = ANY(${p.add(seniorities)}::text[])`);

  if (f.show_event) out.push(`comp.event_id IN (SELECT id FROM events WHERE LOWER(name) = LOWER(${p.add(f.show_event)}))`);

  const boothCats = cleanStrings(f.booth_categories);
  if (boothCats.length) out.push(`comp.booth_category = ANY(${p.add(boothCats)}::text[])`);

  // How the contact's company was discovered — an account-level attribute,
  // so it filters here with the other sidebar dimensions rather than as a
  // column menu on a column that shows the *contact's* source.
  const companySources = cleanStrings(f.company_sources)
    .filter((v) => COMPANY_SOURCES.some((o) => o.key === v));
  if (companySources.length) out.push(`comp.source = ANY(${p.add(companySources)}::text[])`);

  return out;
}

/* ── Assembly ─────────────────────────────────────────────────────────
   `skipColumn` drops one column's own predicate — that is what makes the
   facet counts behave like Excel's, where a column's menu still shows the
   options you could switch to rather than only the one already picked. */
function buildWhere(filters = {}, { skipColumn = null } = {}) {
  const p = new Params();
  const cols = filters.columns || {};
  const clauses = sidebarClauses(filters, p);

  const columnBuilders = {
    contact:  (s) => contactClause(s, p),
    company:  (s) => `LOWER(c.company) = ANY(${p.add(s.values.map((v) => v.toLowerCase()))}::text[])`,
    email:    (s) => emailClause(s, p),
    activity: (s) => activityClause(s, p),
    tags:     (s) => tagClause(s, p),
    status:   (s) => `c.follow_up_status = ANY(${p.add(s.values)}::text[])`,
    draft:    (s) => draftClause(s),
    source:   (s) => `c.source = ANY(${p.add(s.values)}::text[])`,
  };

  for (const [key, build] of Object.entries(columnBuilders)) {
    if (key === skipColumn) continue;
    if (!cols[key]) continue;
    const sql = build(cols[key]);
    if (sql) clauses.push(sql);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join('\n    AND ')}` : '',
    params: p.values,
    nextParam: p.values.length,
  };
}

/* Only one primary sort is active at a time, per spec. c.id breaks ties so
   paging is stable — without it Postgres may return the same row on two
   different pages when the sort key repeats. */
function buildOrderBy(sort) {
  const col = SORTABLE[sort && sort.column] ? sort.column : 'created';
  const dir = sort && String(sort.direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const expr = SORTABLE[col];
  if (col === 'created') return `ORDER BY c.id ${dir}`;
  return `ORDER BY ${expr} ${dir} NULLS LAST, c.id DESC`;
}

/* Describes the active filters for the chip row. Server-side so the chips
   and the query can't disagree about what is applied. */
function describeFilters(columns = {}) {
  const label = (vocab, key) => (vocab.find((o) => o.key === key) || {});
  const chips = [];
  const push = (column, text, text_cn) => chips.push({ column, text, text_cn });

  if (columns.contact) {
    const { mode, value } = columns.contact;
    const modeText = {
      contains: ['contains', '包含'], starts: ['starts with', '开头为'], ends: ['ends with', '结尾为'],
      equals: ['is', '等于'], empty: ['is empty', '为空'], notEmpty: ['is not empty', '非空'],
    }[mode] || ['contains', '包含'];
    push('contact', `Contact ${modeText[0]}${value ? ` "${value}"` : ''}`, `联系人${modeText[1]}${value ? ` “${value}”` : ''}`);
  }
  if (columns.company) {
    const v = columns.company.values;
    push('company', `Company: ${v.length > 2 ? `${v.length} selected` : v.join(', ')}`,
                    `公司：${v.length > 2 ? `已选 ${v.length} 个` : v.join('、')}`);
  }
  if (columns.email) {
    const modes = columns.email.modes.map((m) => label(EMAIL_MODES, m));
    modes.forEach((m) => push('email', m.label, m.label_cn));
    if (columns.email.domain) push('email', `Email contains ${columns.email.domain}`, `邮箱包含 ${columns.email.domain}`);
  }
  if (columns.activity) {
    columns.activity.states.forEach((s) => {
      const o = label(ACTIVITY_STATES, s);
      push('activity', o.label, o.label_cn);
    });
    const { within, from, to } = columns.activity;
    if (within === '7d')  push('activity', 'Last 7 days', '近 7 天');
    if (within === '30d') push('activity', 'Last 30 days', '近 30 天');
    if (from || to) push('activity', `Activity ${from || '…'} → ${to || '…'}`, `活动 ${from || '…'} → ${to || '…'}`);
  }
  if (columns.tags) {
    const { values, match } = columns.tags;
    const joiner = match === 'all' ? ' AND ' : ' OR ';
    push('tags', `Tags: ${values.join(joiner)}`, `标签：${values.join(match === 'all' ? ' 且 ' : ' 或 ')}`);
  }
  if (columns.status) {
    columns.status.values.forEach((s) => {
      const o = label(CONTACT_STATUSES, s);
      push('status', `Status: ${o.label}`, `状态：${o.label_cn}`);
    });
  }
  if (columns.draft) {
    columns.draft.states.forEach((s) => {
      const o = label(DRAFT_STATES, s);
      push('draft', `Draft: ${o.label}`, `草稿：${o.label_cn}`);
    });
  }
  if (columns.source) {
    columns.source.values.forEach((s) => {
      const o = label(CONTACT_SOURCES, s);
      push('source', `Source: ${o.label}`, `来源：${o.label_cn}`);
    });
  }
  return chips;
}

module.exports = {
  PERSONAL_EMAIL_DOMAINS,
  EMAIL_MODES, ACTIVITY_STATES, DRAFT_STATES, CONTACT_STATUSES, CONTACT_SOURCES,
  EMAIL_SOURCES, EMAIL_SOURCE_BY_KEY, PAID_EMAIL_SOURCES, COMPANY_SOURCES, companySourceForContact,
  TEXT_MODES, SORTABLE, LAST_ACTIVITY_SQL, OPTION_SQL,
  LAST_CONTACTED_AT, HAS_LAST_CONTACTED, HAS_MEETING_DATE,
  normalizeColumnFilters, buildWhere, buildOrderBy, describeFilters,
  escapeLike,
};
