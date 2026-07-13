const { Pool } = require('pg');
const { normalizeNameKey, isInvalidCompanyName } = require('./companyKey');
const { classifyDepartment, classifySeniority } = require('./contactClassify');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function q(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

async function q1(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Accounts: the logical parent a user actually searched for / cares about
  // (e.g. "Ford"). Companies (legal entities Apollo/CSV/manual entry return,
  // e.g. "Ford Motor Company", "Ford Credit") each belong to one account.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_name_ci ON accounts (LOWER(name))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      chinese_name TEXT,
      industry TEXT,
      booth TEXT,
      event_id INTEGER REFERENCES events(id),
      website TEXT,
      notes TEXT,
      category TEXT,
      priority INTEGER DEFAULT 0,
      background TEXT,
      opportunity TEXT,
      mfg_location TEXT,
      contact_tip TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name_ci ON companies (LOWER(name))`);
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id)`);
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS name_key TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_companies_name_key ON companies (name_key)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      full_name TEXT,
      job_title TEXT,
      department TEXT,
      seniority TEXT,
      email TEXT,
      phone TEXT,
      website TEXT,
      linkedin_url TEXT,
      company TEXT,
      company_id INTEGER REFERENCES companies(id),
      address TEXT,
      notes TEXT,
      raw_text TEXT,
      apollo_person_id TEXT,
      apollo_raw_json TEXT,
      apollo_enriched_at TEXT,
      source TEXT DEFAULT 'manual',
      confidence INTEGER,
      relevance TEXT,
      draft_subject TEXT,
      draft_body TEXT,
      draft_followup TEXT,
      draft_rationale TEXT,
      tags TEXT,
      follow_up_status TEXT DEFAULT 'not_contacted',
      last_contacted_at TEXT,
      event_id INTEGER REFERENCES events(id),
      booth_number TEXT,
      meeting_date TEXT,
      meeting_notes TEXT,
      interest_level TEXT,
      products_discussed TEXT,
      assigned_salesperson TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migrations: add columns to existing databases that predate them
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS has_email BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_lookup_status TEXT DEFAULT 'not_checked'`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_status TEXT DEFAULT 'prospect'`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'medium'`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS country TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS department_category TEXT`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS seniority_level TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_department_category ON contacts (department_category)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_seniority_level ON contacts (seniority_level)`);
  // Backfill: contacts that already have an email were implicitly found
  await pool.query(`UPDATE contacts SET email_lookup_status = 'found' WHERE email IS NOT NULL AND email != '' AND email_lookup_status != 'found'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_cards (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER REFERENCES contacts(id),
      image_data TEXT,
      ocr_text TEXT,
      parsed_json TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS apollo_cache (
      cache_key TEXT PRIMARY KEY,
      raw_json TEXT,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_search_cache (
      company_key TEXT PRIMARY KEY,
      raw_json TEXT,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS apollo_results (
      id SERIAL PRIMARY KEY,
      result_type TEXT NOT NULL,
      company_id INTEGER REFERENCES companies(id),
      contact_id INTEGER REFERENCES contacts(id),
      query_key TEXT,
      raw_json TEXT,
      searched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_drafts (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER REFERENCES contacts(id),
      version INTEGER NOT NULL,
      subject TEXT,
      body TEXT,
      followup TEXT,
      rationale TEXT,
      sent_status TEXT DEFAULT 'not_sent',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_activity (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      activity_type TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // ── Unified communications table ─────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS communications (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      comm_type TEXT NOT NULL DEFAULT 'note',
      subject TEXT,
      body TEXT,
      category TEXT DEFAULT 'other',
      status TEXT DEFAULT 'saved',
      version INTEGER DEFAULT 1,
      source TEXT DEFAULT 'manual',
      from_email TEXT, from_name TEXT, to_email TEXT,
      draft_mode TEXT,
      followup_text TEXT,
      rationale TEXT,
      sent_at TIMESTAMPTZ,
      review_needed BOOLEAN DEFAULT FALSE,
      raw_payload TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS extra_instructions TEXT`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS cc TEXT`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS bcc TEXT`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS notes TEXT`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS parent_email_id INTEGER REFERENCES communications(id)`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS follow_up_sequence_number INTEGER`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  // Rows migrated long ago from the old email_drafts table never set
  // draft_mode -- backfill so every draft has a real category (drafts are
  // now scoped/versioned per (contact, draft_mode), not just per contact).
  await pool.query(`UPDATE communications SET draft_mode = 'cold_outreach' WHERE comm_type = 'draft' AND (draft_mode IS NULL OR draft_mode = '')`);

  // Attachments: file bytes live in Postgres (bytea). A row is either a
  // one-off attachment on a single email (is_library_item=false, library_key
  // NULL) or a version in a named, reusable Attachment Library slot
  // (is_library_item=true, library_key shared across versions, version bumps
  // like draft versioning does). deleted_at soft-deletes a library slot
  // without losing history.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id SERIAL PRIMARY KEY,
      original_filename TEXT NOT NULL,
      mime_type TEXT,
      file_size INTEGER,
      file_data BYTEA NOT NULL,
      is_library_item BOOLEAN DEFAULT FALSE,
      library_key TEXT,
      library_name TEXT,
      library_category TEXT,
      version INTEGER DEFAULT 1,
      is_favorite BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )
  `);
  // Links a communications row (draft or manually-imported email) to one or
  // more attachments -- either a one-off upload or a reference to a library
  // item's version at the time it was attached.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS communication_attachments (
      id SERIAL PRIMARY KEY,
      communication_id INTEGER NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
      attachment_id INTEGER NOT NULL REFERENCES attachments(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // email_history must exist before we migrate from it
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_history (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      from_email TEXT,
      from_name TEXT,
      to_email TEXT,
      subject TEXT,
      body TEXT,
      sent_at TIMESTAMPTZ,
      category TEXT DEFAULT 'other',
      source TEXT DEFAULT 'manual_paste',
      review_needed BOOLEAN DEFAULT FALSE,
      raw_payload TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migrate email_drafts → communications (idempotent via conflict guard)
  await pool.query(`
    INSERT INTO communications
      (contact_id, comm_type, subject, body, version, source, followup_text, rationale, created_at, updated_at)
    SELECT ed.contact_id, 'draft', ed.subject, ed.body, ed.version, 'migrated_draft',
           ed.followup, ed.rationale, ed.created_at, ed.created_at
    FROM email_drafts ed
    WHERE ed.contact_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM communications c
        WHERE c.contact_id = ed.contact_id AND c.comm_type = 'draft'
          AND c.version = ed.version AND COALESCE(c.subject,'') = COALESCE(ed.subject,'')
      )
  `);
  // Migrate email_history → communications (idempotent)
  await pool.query(`
    INSERT INTO communications
      (contact_id, company_id, comm_type, subject, body, category, source,
       from_email, from_name, to_email, sent_at, review_needed, raw_payload, created_at, updated_at)
    SELECT eh.contact_id, eh.company_id, 'imported_email', eh.subject, eh.body, eh.category,
           eh.source, eh.from_email, eh.from_name, eh.to_email, eh.sent_at,
           eh.review_needed, eh.raw_payload, eh.created_at, eh.created_at
    FROM email_history eh
    WHERE NOT EXISTS (
      SELECT 1 FROM communications c
      WHERE c.comm_type = 'imported_email'
        AND LOWER(COALESCE(c.from_email,'')) = LOWER(COALESCE(eh.from_email,''))
        AND LOWER(COALESCE(c.subject,'')) = LOWER(COALESCE(eh.subject,''))
    )
  `);

  // Backfill: every company gets a name_key (for punctuation-insensitive
  // lookup) and an account_id (self-as-account default so every company
  // always belongs to some account, even ones created before this existed).
  const companiesNeedingBackfill = await q(
    `SELECT id, name FROM companies WHERE name_key IS NULL OR account_id IS NULL`
  );
  for (const company of companiesNeedingBackfill) {
    const nameKey = normalizeNameKey(company.name);
    const account = await getOrCreateAccount(company.name);
    await pool.query(
      `UPDATE companies SET name_key = COALESCE(name_key, $1), account_id = COALESCE(account_id, $2) WHERE id = $3`,
      [nameKey, account ? account.id : null, company.id]
    );
  }

  // Backfill: classify existing contacts (title-first, falling back to raw
  // department/seniority) so Department/Seniority CRM filters work for
  // contacts saved before this classification existed, regardless of source.
  const contactsNeedingBackfill = await q(
    `SELECT id, job_title, department, seniority FROM contacts WHERE department_category IS NULL OR seniority_level IS NULL`
  );
  for (const contact of contactsNeedingBackfill) {
    const dept = classifyDepartment(contact.job_title, contact.department);
    const seniority = classifySeniority(contact.job_title, contact.seniority);
    await pool.query(
      `UPDATE contacts SET department_category = COALESCE(department_category, $1), seniority_level = COALESCE(seniority_level, $2) WHERE id = $3`,
      [dept ? dept.key : null, seniority.key, contact.id]
    );
  }
}

// ===========================================================================
// Events
// ===========================================================================

async function getOrCreateEvent(name) {
  if (!name || !name.trim()) return null;
  const trimmed = name.trim();
  const existing = await q1(`SELECT * FROM events WHERE LOWER(name) = LOWER($1)`, [trimmed]);
  if (existing) return existing;
  const [row] = await q(`INSERT INTO events (name) VALUES ($1) RETURNING *`, [trimmed]);
  return row;
}

async function listEvents() {
  return q(`SELECT * FROM events ORDER BY name`);
}

// ===========================================================================
// Accounts (logical parent a user searched for, e.g. "Ford" — see companyKey.js
// for why company-name-text normalization alone can't do this job)
// ===========================================================================

async function getOrCreateAccount(name) {
  if (!name || !name.trim() || isInvalidCompanyName(name)) return null;
  const trimmed = name.trim();
  const existing = await q1(`SELECT * FROM accounts WHERE LOWER(name) = LOWER($1)`, [trimmed]);
  if (existing) return existing;
  const [row] = await q(`INSERT INTO accounts (name) VALUES ($1) RETURNING *`, [trimmed]);
  return row;
}

async function getAccount(id) {
  return q1(`SELECT * FROM accounts WHERE id = $1`, [id]);
}

async function listAccounts() {
  return q(`SELECT * FROM accounts ORDER BY name`);
}

async function listAccountGroups({ onlyWithContacts = false } = {}) {
  return q(`
    SELECT a.id, a.name, COUNT(DISTINCT c.id)::int AS contact_count
    FROM accounts a
    LEFT JOIN companies comp ON comp.account_id = a.id
    LEFT JOIN contacts c ON c.company_id = comp.id
    GROUP BY a.id, a.name
    ${onlyWithContacts ? 'HAVING COUNT(DISTINCT c.id) > 0' : ''}
    ORDER BY a.name
  `);
}

async function getAccountContacts(accountId) {
  return q(`
    SELECT c.* FROM contacts c
    JOIN companies comp ON comp.id = c.company_id
    WHERE comp.account_id = $1
    ORDER BY c.id DESC
  `, [accountId]);
}

// Companies (legal entities) currently parented under an account, with their
// own contact counts -- used by the Merge Accounts confirmation dialog to
// preview what will move.
async function listCompaniesForAccount(accountId) {
  return q(`
    SELECT comp.id, comp.name, COUNT(c.id)::int AS contact_count
    FROM companies comp
    LEFT JOIN contacts c ON c.company_id = comp.id
    WHERE comp.account_id = $1
    GROUP BY comp.id, comp.name
    ORDER BY comp.name
  `, [accountId]);
}

// Merges one or more source accounts into a single target account: every
// company currently parented under a source moves to the target, then the
// now-empty source account rows are removed. Contacts are never touched
// directly (they're linked via company_id, unaffected by which account a
// company belongs to) -- this only changes companies.account_id.
async function mergeAccounts(sourceAccountIds, targetAccountId) {
  const sources = (sourceAccountIds || [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id !== Number(targetAccountId));
  if (!sources.length) return { companiesMoved: 0, accountsRemoved: 0 };

  const moved = await q(
    `UPDATE companies SET account_id = $1, updated_at = NOW() WHERE account_id = ANY($2::int[]) RETURNING id`,
    [Number(targetAccountId), sources]
  );
  const removed = await q(
    `DELETE FROM accounts WHERE id = ANY($1::int[]) RETURNING id`,
    [sources]
  );
  return { companiesMoved: moved.length, accountsRemoved: removed.length };
}

// ===========================================================================
// Companies
// ===========================================================================

const pick = (newVal, oldVal) => (newVal === undefined || newVal === null || newVal === '' ? oldVal : newVal);
const pickNumber = (newVal, oldVal) => (newVal === undefined || newVal === null || newVal === '' ? oldVal : Number(newVal));

async function findCompanyByName(name) {
  if (!name || !name.trim()) return null;
  const key = normalizeNameKey(name);
  if (!key) return null;
  return q1(`SELECT * FROM companies WHERE name_key = $1 LIMIT 1`, [key]);
}

async function getCompany(id) {
  return q1(`SELECT * FROM companies WHERE id = $1`, [id]);
}

async function upsertCompany(fields) {
  const name = (fields.name || '').trim();
  // Every ingestion path (Apollo, CSV, manual, card scan) funnels through
  // here, so this one check keeps job titles/departments/placeholders from
  // ever becoming a company record regardless of where they came from.
  if (!name || isInvalidCompanyName(name)) return null;

  const eventRow = fields.event_name ? await getOrCreateEvent(fields.event_name) : null;
  const existing = await findCompanyByName(name);

  // Account resolution: explicit account_id > explicit account_name > keep
  // whatever the existing row already has (never blank it) > self-as-account
  // default for brand-new rows (so every company always belongs to an account).
  let accountId;
  if (fields.account_id) {
    accountId = fields.account_id;
  } else if (fields.account_name) {
    const accountRow = await getOrCreateAccount(fields.account_name);
    accountId = accountRow ? accountRow.id : null;
  } else if (existing && existing.account_id) {
    accountId = existing.account_id;
  } else {
    const selfAccount = await getOrCreateAccount(name);
    accountId = selfAccount ? selfAccount.id : null;
  }

  if (existing) {
    const merged = {
      name: pick(fields.name, existing.name),
      chinese_name: pick(fields.chinese_name, existing.chinese_name),
      industry: pick(fields.industry, existing.industry),
      booth: pick(fields.booth, existing.booth),
      event_id: eventRow ? eventRow.id : existing.event_id,
      website: pick(fields.website, existing.website),
      notes: pick(fields.notes, existing.notes),
      category: pick(fields.category, existing.category),
      priority: pickNumber(fields.priority, existing.priority),
      background: pick(fields.background, existing.background),
      opportunity: pick(fields.opportunity, existing.opportunity),
      mfg_location: pick(fields.mfg_location, existing.mfg_location),
      contact_tip: pick(fields.contact_tip, existing.contact_tip)
    };
    await q(`
      UPDATE companies SET
        name=$1, chinese_name=$2, industry=$3, booth=$4, event_id=$5, website=$6, notes=$7,
        category=$8, priority=$9, background=$10, opportunity=$11, mfg_location=$12, contact_tip=$13,
        account_id=$14, updated_at=NOW()
      WHERE id=$15
    `, [
      merged.name, merged.chinese_name, merged.industry, merged.booth, merged.event_id,
      merged.website, merged.notes, merged.category, merged.priority, merged.background,
      merged.opportunity, merged.mfg_location, merged.contact_tip, accountId, existing.id
    ]);
    return { id: existing.id, updated: true };
  }

  const [{ id }] = await q(`
    INSERT INTO companies (
      name, chinese_name, industry, booth, event_id, website, notes,
      category, priority, background, opportunity, mfg_location, contact_tip,
      account_id, name_key
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING id
  `, [
    name, fields.chinese_name || '', fields.industry || '', fields.booth || '',
    eventRow ? eventRow.id : null, fields.website || '', fields.notes || '',
    fields.category || '', fields.priority || 0, fields.background || '',
    fields.opportunity || '', fields.mfg_location || '', fields.contact_tip || '',
    accountId, normalizeNameKey(name)
  ]);
  return { id, updated: false };
}

async function listCompanies(searchTerm) {
  if (searchTerm && searchTerm.trim()) {
    const like = `%${searchTerm.trim().toLowerCase()}%`;
    return q(`
      SELECT * FROM companies
      WHERE LOWER(name) LIKE $1 OR LOWER(chinese_name) LIKE $2 OR LOWER(industry) LIKE $3
      ORDER BY priority DESC, name
    `, [like, like, like]);
  }
  return q(`SELECT * FROM companies ORDER BY priority DESC, name`);
}

async function getCompanyContacts(companyId) {
  return q(`SELECT * FROM contacts WHERE company_id = $1 ORDER BY id DESC`, [companyId]);
}

// ===========================================================================
// Contacts
// ===========================================================================

function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first_name: '', last_name: '' };
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

async function insertContact(c) {
  const { first_name, last_name } = c.first_name || c.last_name
    ? { first_name: c.first_name || '', last_name: c.last_name || '' }
    : splitName(c.full_name);

  // A job title/department/placeholder must never be stored as the contact's
  // company text either, not just skipped for company-row creation -- e.g. a
  // business-card OCR misread that put "CEO" in the company slot.
  const companyText = isInvalidCompanyName(c.company) ? '' : (c.company || '');

  let companyId = c.company_id || null;
  if (!companyId && companyText) {
    const result = await upsertCompany({ name: companyText });
    if (result) companyId = result.id;
  }

  let eventId = c.event_id || null;
  if (!eventId && c.event_name) {
    const ev = await getOrCreateEvent(c.event_name);
    if (ev) eventId = ev.id;
  }

  const departmentCategory = classifyDepartment(c.job_title, c.department);
  const seniorityLevel = classifySeniority(c.job_title, c.seniority);

  const [{ id }] = await q(`
    INSERT INTO contacts (
      first_name, last_name, full_name, job_title, department, seniority,
      email, phone, website, linkedin_url, company, company_id,
      address, notes, raw_text, apollo_person_id, apollo_raw_json, apollo_enriched_at,
      source, confidence, relevance,
      draft_subject, draft_body, draft_followup, draft_rationale,
      tags, follow_up_status, last_contacted_at,
      event_id, booth_number, meeting_date, meeting_notes, interest_level,
      products_discussed, assigned_salesperson, has_email, email_lookup_status,
      contact_status, priority, country, department_category, seniority_level
    ) VALUES (
      $1,  $2,  $3,  $4,  $5,  $6,  $7,  $8,  $9,  $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
      $31, $32, $33, $34, $35, $36, $37, $38, $39, $40,
      $41, $42
    ) RETURNING id
  `, [
    first_name, last_name, c.full_name || '', c.job_title || '', c.department || '', c.seniority || '',
    c.email || '', c.phone || '', c.website || '', c.linkedin_url || '', companyText, companyId,
    c.address || '', c.notes || '', c.raw_text || '', c.apollo_person_id || '',
    c.apollo_raw_json || '', c.apollo_enriched_at || '',
    c.source || 'manual',
    c.confidence === undefined || c.confidence === null || c.confidence === '' ? null : Number(c.confidence),
    c.relevance || '',
    c.draft_subject || '', c.draft_body || '', c.draft_followup || '', c.draft_rationale || '',
    c.tags || '', c.follow_up_status || 'not_contacted', c.last_contacted_at || '',
    eventId, c.booth_number || '', c.meeting_date || '', c.meeting_notes || '', c.interest_level || '',
    c.products_discussed || '', c.assigned_salesperson || '',
    c.has_email !== undefined ? Boolean(c.has_email) : false,
    c.email ? 'found' : (c.email_lookup_status || 'not_checked'),
    c.contact_status || 'prospect', c.priority || 'medium', c.country || '',
    departmentCategory ? departmentCategory.key : null, seniorityLevel.key
  ]);
  return id;
}

const DRAFT_COUNT_JOIN = `
  LEFT JOIN (
    SELECT contact_id, COUNT(*)::int AS draft_count, MAX(id) AS latest_draft_id
    FROM email_drafts GROUP BY contact_id
  ) ed ON ed.contact_id = c.id`;

const COMM_STATS_JOIN = `
  LEFT JOIN (
    SELECT contact_id,
      COUNT(*)::int AS comm_count,
      SUM(CASE WHEN comm_type = 'draft' THEN 1 ELSE 0 END)::int AS comm_draft_count,
      MAX(COALESCE(sent_at, created_at)) AS last_comm_at,
      (array_agg(comm_type ORDER BY COALESCE(sent_at, created_at) DESC NULLS LAST))[1] AS last_comm_type
    FROM communications GROUP BY contact_id
  ) cs ON cs.contact_id = c.id`;

async function listContacts(limit = 200) {
  return q(`
    SELECT c.*, COALESCE(ed.draft_count,0)::int AS draft_count, ed.latest_draft_id,
      COALESCE(cs.comm_count,0)::int AS comm_count,
      COALESCE(cs.comm_draft_count,0)::int AS comm_draft_count,
      cs.last_comm_at, cs.last_comm_type
    FROM contacts c ${DRAFT_COUNT_JOIN} ${COMM_STATS_JOIN}
    ORDER BY c.id DESC LIMIT $1
  `, [limit]);
}

async function getContact(id) {
  return q1(`SELECT * FROM contacts WHERE id = $1`, [id]);
}

async function listContactsByCompany(company) {
  return q(`SELECT * FROM contacts WHERE LOWER(company) = LOWER($1) ORDER BY id DESC`, [company]);
}

// Bulk delete. Companies are intentionally left untouched even if a company
// ends up with zero contacts afterward -- no existing code path in this app
// ever deletes a company row (uploaded company lists persist with 0 contacts
// too), so this doesn't introduce a new destructive pathway.
//
// contact_activity/business_cards/email_drafts/apollo_results all reference
// contacts.id with no ON DELETE clause (RESTRICT by default), so their rows
// must be removed first or the delete fails for any contact that has ever
// had activity logged against it -- true for almost every real contact.
// communications/email_history use ON DELETE SET NULL and don't need this.
async function deleteContacts(ids) {
  const numericIds = (ids || []).map(Number).filter((n) => Number.isInteger(n));
  if (!numericIds.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM contact_activity WHERE contact_id = ANY($1::int[])`, [numericIds]);
    await client.query(`DELETE FROM business_cards WHERE contact_id = ANY($1::int[])`, [numericIds]);
    await client.query(`DELETE FROM email_drafts WHERE contact_id = ANY($1::int[])`, [numericIds]);
    await client.query(`DELETE FROM apollo_results WHERE contact_id = ANY($1::int[])`, [numericIds]);
    await client.query(`DELETE FROM contacts WHERE id = ANY($1::int[])`, [numericIds]);
    await client.query('COMMIT');
    return numericIds.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteContact(id) {
  await deleteContacts([id]);
}

async function listContactNamesForBrowse() {
  return q(`
    SELECT c.id, c.full_name, c.last_name, comp.name AS company, acc.name AS account_name
    FROM contacts c
    LEFT JOIN companies comp ON comp.id = c.company_id
    LEFT JOIN accounts acc ON acc.id = comp.account_id
    ORDER BY NULLIF(c.last_name, '') IS NULL, c.last_name, c.full_name
  `);
}

async function updateContactDraft(id, draft) {
  await q(`
    UPDATE contacts SET
      draft_subject=$1, draft_body=$2, draft_followup=$3, draft_rationale=$4, updated_at=NOW()
    WHERE id=$5
  `, [draft.subject || '', draft.body || '', draft.followup || '', draft.rationale || '', id]);
}

async function findExistingContact(email, fullName, company, linkedinUrl) {
  if (email && email.trim()) {
    const row = await q1(
      `SELECT * FROM contacts WHERE email != '' AND LOWER(email) = LOWER($1) LIMIT 1`,
      [email.trim()]
    );
    if (row) return row;
  }
  if (linkedinUrl && linkedinUrl.trim()) {
    const row = await q1(
      `SELECT * FROM contacts WHERE linkedin_url != '' AND LOWER(linkedin_url) = LOWER($1) LIMIT 1`,
      [linkedinUrl.trim()]
    );
    if (row) return row;
  }
  if (fullName && fullName.trim() && company && company.trim()) {
    const row = await q1(`
      SELECT * FROM contacts
      WHERE full_name != '' AND company != ''
        AND LOWER(full_name) = LOWER($1) AND LOWER(company) = LOWER($2)
      LIMIT 1
    `, [fullName.trim(), company.trim()]);
    if (row) return row;
  }
  return null;
}

async function updateContact(id, c) {
  const existing = await getContact(id);
  if (!existing) return;

  // Treat an invalid incoming company value (job title/department/placeholder)
  // as if it were absent -- falls back to the existing company via pick(),
  // same as any other unset field, rather than overwriting a good value or
  // ever storing/looking up a title as a company.
  const incomingCompany = isInvalidCompanyName(c.company) ? '' : c.company;
  let companyId = c.company_id || existing.company_id || null;
  const newCompanyName = pick(incomingCompany, existing.company);
  if (newCompanyName && (!companyId || (incomingCompany && incomingCompany !== existing.company))) {
    const result = await upsertCompany({ name: newCompanyName });
    if (result) companyId = result.id;
  }

  let eventId = c.event_id || existing.event_id || null;
  if (c.event_name) {
    const ev = await getOrCreateEvent(c.event_name);
    if (ev) eventId = ev.id;
  }

  const namesGiven = c.first_name || c.last_name;
  const split = namesGiven ? { first_name: c.first_name || '', last_name: c.last_name || '' } : null;

  const merged = {
    first_name: split ? pick(split.first_name, existing.first_name) : existing.first_name,
    last_name: split ? pick(split.last_name, existing.last_name) : existing.last_name,
    full_name: pick(c.full_name, existing.full_name),
    job_title: pick(c.job_title, existing.job_title),
    department: pick(c.department, existing.department),
    seniority: pick(c.seniority, existing.seniority),
    email: pick(c.email, existing.email),
    phone: pick(c.phone, existing.phone),
    website: pick(c.website, existing.website),
    linkedin_url: pick(c.linkedin_url, existing.linkedin_url),
    company: newCompanyName,
    company_id: companyId,
    address: pick(c.address, existing.address),
    notes: pick(c.notes, existing.notes),
    raw_text: pick(c.raw_text, existing.raw_text),
    apollo_person_id: pick(c.apollo_person_id, existing.apollo_person_id),
    apollo_raw_json: pick(c.apollo_raw_json, existing.apollo_raw_json),
    apollo_enriched_at: pick(c.apollo_enriched_at, existing.apollo_enriched_at),
    source: pick(c.source, existing.source),
    confidence: pickNumber(c.confidence, existing.confidence),
    relevance: pick(c.relevance, existing.relevance),
    draft_subject: pick(c.draft_subject, existing.draft_subject),
    draft_body: pick(c.draft_body, existing.draft_body),
    draft_followup: pick(c.draft_followup, existing.draft_followup),
    draft_rationale: pick(c.draft_rationale, existing.draft_rationale),
    tags: pick(c.tags, existing.tags),
    follow_up_status: pick(c.follow_up_status, existing.follow_up_status),
    last_contacted_at: pick(c.last_contacted_at, existing.last_contacted_at),
    event_id: eventId,
    booth_number: pick(c.booth_number, existing.booth_number),
    meeting_date: pick(c.meeting_date, existing.meeting_date),
    meeting_notes: pick(c.meeting_notes, existing.meeting_notes),
    interest_level: pick(c.interest_level, existing.interest_level),
    products_discussed: pick(c.products_discussed, existing.products_discussed),
    assigned_salesperson: pick(c.assigned_salesperson, existing.assigned_salesperson),
    has_email: c.has_email !== undefined ? Boolean(c.has_email) : Boolean(existing.has_email),
    email_lookup_status: (() => {
      if (c.email_lookup_status) return c.email_lookup_status;
      if (pick(c.email, existing.email) && !existing.email) return 'found';
      return existing.email_lookup_status || 'not_checked';
    })(),
    contact_status: pick(c.contact_status, existing.contact_status) || 'prospect',
    priority: pick(c.priority, existing.priority) || 'medium',
    country: pick(c.country, existing.country) || '',
  };

  const departmentCategory = classifyDepartment(merged.job_title, merged.department);
  const seniorityLevel = classifySeniority(merged.job_title, merged.seniority);

  await q(`
    UPDATE contacts SET
      first_name=$1,  last_name=$2,   full_name=$3,          job_title=$4,        department=$5,       seniority=$6,
      email=$7,       phone=$8,       website=$9,            linkedin_url=$10,    company=$11,         company_id=$12,
      address=$13,    notes=$14,      raw_text=$15,          apollo_person_id=$16, apollo_raw_json=$17, apollo_enriched_at=$18,
      source=$19,     confidence=$20, relevance=$21,
      draft_subject=$22, draft_body=$23, draft_followup=$24, draft_rationale=$25,
      tags=$26,       follow_up_status=$27, last_contacted_at=$28,
      event_id=$29,   booth_number=$30, meeting_date=$31,    meeting_notes=$32,   interest_level=$33,
      products_discussed=$34, assigned_salesperson=$35, has_email=$36,
      email_lookup_status=$37, contact_status=$38, priority=$39, country=$40,
      department_category=$41, seniority_level=$42, updated_at=NOW()
    WHERE id=$43
  `, [
    merged.first_name, merged.last_name, merged.full_name, merged.job_title, merged.department, merged.seniority,
    merged.email, merged.phone, merged.website, merged.linkedin_url, merged.company, merged.company_id,
    merged.address, merged.notes, merged.raw_text, merged.apollo_person_id, merged.apollo_raw_json, merged.apollo_enriched_at,
    merged.source, merged.confidence, merged.relevance,
    merged.draft_subject, merged.draft_body, merged.draft_followup, merged.draft_rationale,
    merged.tags, merged.follow_up_status, merged.last_contacted_at,
    merged.event_id, merged.booth_number, merged.meeting_date, merged.meeting_notes, merged.interest_level,
    merged.products_discussed, merged.assigned_salesperson, merged.has_email,
    merged.email_lookup_status, merged.contact_status, merged.priority, merged.country,
    departmentCategory ? departmentCategory.key : null, seniorityLevel.key,
    id
  ]);
}

async function upsertContact(c) {
  const existing = await findExistingContact(c.email, c.full_name, c.company, c.linkedin_url);
  if (existing) {
    await updateContact(existing.id, c);
    return { id: existing.id, updated: true };
  }
  return { id: await insertContact(c), updated: false };
}

async function searchContacts(term, limit = 500) {
  if (term && term.trim()) {
    const like = `%${term.trim().toLowerCase()}%`;
    return q(`
      SELECT c.*, COALESCE(ed.draft_count,0)::int AS draft_count, ed.latest_draft_id,
        COALESCE(cs.comm_count,0)::int AS comm_count,
        COALESCE(cs.comm_draft_count,0)::int AS comm_draft_count,
        cs.last_comm_at, cs.last_comm_type
      FROM contacts c ${DRAFT_COUNT_JOIN} ${COMM_STATS_JOIN}
      WHERE LOWER(c.full_name) LIKE $1 OR LOWER(c.company) LIKE $2 OR LOWER(c.email) LIKE $3
         OR LOWER(c.job_title) LIKE $4 OR LOWER(c.tags) LIKE $5
      ORDER BY c.id DESC LIMIT $6
    `, [like, like, like, like, like, limit]);
  }
  return listContacts(limit);
}

async function filterContacts(filters = {}, limit = 1000) {
  const clauses = [];
  const params = [];

  if (filters.event) {
    params.push(filters.event);
    clauses.push(`c.event_id IN (SELECT id FROM events WHERE LOWER(name) = LOWER($${params.length}))`);
  }
  if (filters.company) {
    params.push(`%${filters.company.trim().toLowerCase()}%`);
    clauses.push(`LOWER(c.company) LIKE $${params.length}`);
  }
  if (filters.industry) {
    params.push(`%${filters.industry.trim().toLowerCase()}%`);
    clauses.push(`LOWER(comp.industry) LIKE $${params.length}`);
  }
  if (filters.follow_up_status) {
    params.push(filters.follow_up_status);
    clauses.push(`c.follow_up_status = $${params.length}`);
  }
  if (filters.tags) {
    params.push(`%${filters.tags.trim().toLowerCase()}%`);
    clauses.push(`LOWER(c.tags) LIKE $${params.length}`);
  }
  if (filters.assigned_salesperson) {
    params.push(`%${filters.assigned_salesperson.trim().toLowerCase()}%`);
    clauses.push(`LOWER(c.assigned_salesperson) LIKE $${params.length}`);
  }
  // Multi-select Browse-by-Company / Browse-by-Contact: OR within the
  // selection (any of the chosen accounts/contacts matches), AND'd together
  // with every other active filter above.
  const accounts = ([].concat(filters.accounts || [])).map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  if (accounts.length) {
    params.push(accounts);
    clauses.push(`LOWER(acc.name) = ANY($${params.length}::text[])`);
  }
  const contactIds = ([].concat(filters.contact_ids || [])).map(Number).filter((n) => Number.isInteger(n));
  if (contactIds.length) {
    params.push(contactIds);
    clauses.push(`c.id = ANY($${params.length}::int[])`);
  }
  // Department/Seniority category filters (review-and-categorize stage,
  // also what "draft by category" filters on): same OR-within-AND pattern.
  const departmentCategories = ([].concat(filters.department_categories || [])).map((d) => String(d).trim()).filter(Boolean);
  if (departmentCategories.length) {
    params.push(departmentCategories);
    clauses.push(`c.department_category = ANY($${params.length}::text[])`);
  }
  const seniorityLevels = ([].concat(filters.seniority_levels || [])).map((s) => String(s).trim()).filter(Boolean);
  if (seniorityLevels.length) {
    params.push(seniorityLevels);
    clauses.push(`c.seniority_level = ANY($${params.length}::text[])`);
  }

  params.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = filters.sortBy === 'last_contacted' ? 'ORDER BY c.last_contacted_at DESC' : 'ORDER BY c.id DESC';

  return q(`
    SELECT c.*, COALESCE(ed.draft_count,0)::int AS draft_count, ed.latest_draft_id,
      COALESCE(cs.comm_count,0)::int AS comm_count,
      COALESCE(cs.comm_draft_count,0)::int AS comm_draft_count,
      cs.last_comm_at, cs.last_comm_type
    FROM contacts c
    LEFT JOIN companies comp ON comp.id = c.company_id
    LEFT JOIN accounts acc ON acc.id = comp.account_id
    ${DRAFT_COUNT_JOIN} ${COMM_STATS_JOIN}
    ${where}
    ${orderBy}
    LIMIT $${params.length}
  `, params);
}

async function patchContactCrmFields(id, fields) {
  const existing = await getContact(id);
  if (!existing) return null;
  await updateContact(id, fields);
  return getContact(id);
}

async function logContactActivity(contactId, activityType, description) {
  if (!contactId) return;
  await q(`
    INSERT INTO contact_activity (contact_id, activity_type, description) VALUES ($1, $2, $3)
  `, [contactId, activityType, description || '']);
}

async function listContactActivity(contactId) {
  return q(`SELECT * FROM contact_activity WHERE contact_id = $1 ORDER BY id DESC`, [contactId]);
}

// ===========================================================================
// Business cards
// ===========================================================================

async function insertBusinessCard(contactId, imageData, ocrText, parsedJson) {
  const [{ id }] = await q(`
    INSERT INTO business_cards (contact_id, image_data, ocr_text, parsed_json)
    VALUES ($1, $2, $3, $4) RETURNING id
  `, [contactId, imageData || '', ocrText || '', parsedJson || '']);
  return id;
}

async function listBusinessCardsForContact(contactId) {
  return q(`SELECT * FROM business_cards WHERE contact_id = $1 ORDER BY id DESC`, [contactId]);
}

// ===========================================================================
// Apollo caches + history log
// ===========================================================================

async function getApolloCache(cacheKey) {
  if (!cacheKey) return null;
  return q1(`SELECT * FROM apollo_cache WHERE cache_key = $1`, [cacheKey]);
}

async function setApolloCache(cacheKey, rawJson) {
  if (!cacheKey) return;
  await q(`
    INSERT INTO apollo_cache (cache_key, raw_json) VALUES ($1, $2)
    ON CONFLICT(cache_key) DO UPDATE SET raw_json = EXCLUDED.raw_json, fetched_at = NOW()
  `, [cacheKey, rawJson]);
}

async function getCompanySearchCache(companyKey) {
  if (!companyKey) return null;
  return q1(`SELECT * FROM company_search_cache WHERE company_key = $1`, [companyKey]);
}

async function setCompanySearchCache(companyKey, rawJson) {
  if (!companyKey) return;
  await q(`
    INSERT INTO company_search_cache (company_key, raw_json) VALUES ($1, $2)
    ON CONFLICT(company_key) DO UPDATE SET raw_json = EXCLUDED.raw_json, fetched_at = NOW()
  `, [companyKey, rawJson]);
}

async function updateCachedLeadDraft(companyKey, apolloId, name, draft) {
  const cached = await getCompanySearchCache(companyKey);
  if (!cached) return;
  let payload;
  try { payload = JSON.parse(cached.raw_json); } catch { return; }
  const contacts = (payload && payload.contacts) || [];
  for (const c of contacts) {
    const match = (apolloId && c.apollo_id === apolloId) || (!apolloId && c.name === name);
    if (match) {
      c.draft_subject = draft.subject || '';
      c.draft_body = draft.body || '';
      c.draft_followup = draft.followup || '';
      c.draft_rationale = draft.rationale || '';
      break;
    }
  }
  payload.contacts = contacts;
  await setCompanySearchCache(companyKey, JSON.stringify(payload));
}

async function logApolloResult(resultType, companyId, contactId, queryKey, rawJson) {
  await q(`
    INSERT INTO apollo_results (result_type, company_id, contact_id, query_key, raw_json)
    VALUES ($1, $2, $3, $4, $5)
  `, [resultType, companyId || null, contactId || null, queryKey || '', rawJson || '']);
}

async function listApolloResults(limit = 200) {
  return q(`SELECT * FROM apollo_results ORDER BY id DESC LIMIT $1`, [limit]);
}

// ===========================================================================
// Email drafts (versioned history)
// ===========================================================================

// mode/extraInstructions must be passed explicitly -- draftEmail()'s return
// value never includes the mode it was called with, so relying on
// `draft.mode` (as this used to) silently mislabeled every stored draft as
// 'cold_outreach' regardless of the actual mode used.
// extraFields: optional { to_email, cc, bcc, notes, company_id } carried onto
// the communications row (the "current draft" the editor modal operates on).
//
// Two independent version counters: `email_drafts` is legacy (kept only for
// backward-compatible writes, no longer read by any UI) and stays numbered
// globally per contact, unchanged. The communications row's version -- the
// one shown in the UI -- is numbered per (contact, draft_mode), so each
// category's version history counts up on its own.
async function insertEmailDraftVersion(contactId, draft, mode, extraInstructions, extraFields = {}) {
  const resolvedMode = mode || 'cold_outreach';
  const legacyRow = await q1(`SELECT MAX(version) AS maxv FROM email_drafts WHERE contact_id = $1`, [contactId]);
  const legacyVersion = (legacyRow && legacyRow.maxv ? Number(legacyRow.maxv) : 0) + 1;
  const [{ id }] = await q(`
    INSERT INTO email_drafts (contact_id, version, subject, body, followup, rationale)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
  `, [contactId, legacyVersion, draft.subject || '', draft.body || '', draft.followup || '', draft.rationale || '']);

  const modeVersionRow = await q1(
    `SELECT MAX(version) AS maxv FROM communications WHERE contact_id=$1 AND comm_type='draft' AND COALESCE(draft_mode,'cold_outreach')=$2 AND parent_email_id IS NULL`,
    [contactId, resolvedMode]
  );
  const modeVersion = (modeVersionRow && modeVersionRow.maxv ? Number(modeVersionRow.maxv) : 0) + 1;

  // Dual-write to unified communications table -- this row IS "the current
  // draft" for this category the editor modal reads/writes (see
  // getCurrentDraftForContact).
  const commRow = await insertCommunication({
    contact_id: contactId, company_id: extraFields.company_id, comm_type: 'draft',
    subject: draft.subject || '', body: draft.body || '',
    category: resolvedMode, status: 'draft',
    version: modeVersion, source: 'email_draft',
    draft_mode: resolvedMode, extra_instructions: extraInstructions || '',
    followup_text: draft.followup || '', rationale: draft.rationale || '',
    to_email: extraFields.to_email || '', cc: extraFields.cc || '',
    bcc: extraFields.bcc || '', notes: extraFields.notes || ''
  });
  return { id, version: modeVersion, communicationId: commRow.id };
}

// Looks up the most recent draft for this exact (contact, mode, instructions)
// combination -- used to skip a redundant Claude call when an equivalent
// draft already exists (bulk-drafting a category that's partly already drafted).
async function findLatestDraftForContact(contactId, mode, extraInstructions) {
  return q1(`
    SELECT * FROM communications
    WHERE contact_id = $1 AND comm_type = 'draft'
      AND COALESCE(draft_mode, 'cold_outreach') = $2
      AND COALESCE(extra_instructions, '') = $3
    ORDER BY version DESC, id DESC
    LIMIT 1
  `, [contactId, mode || 'cold_outreach', extraInstructions || '']);
}

async function listEmailDraftsForContact(contactId) {
  return q(`SELECT * FROM email_drafts WHERE contact_id = $1 ORDER BY version DESC`, [contactId]);
}

// ===========================================================================
// Communications (unified interaction history)
// ===========================================================================

async function insertCommunication(e) {
  const [row] = await q(`
    INSERT INTO communications
      (contact_id, company_id, comm_type, subject, body, category, status, version,
       source, from_email, from_name, to_email, draft_mode, followup_text, rationale,
       sent_at, review_needed, raw_payload, extra_instructions, cc, bcc, notes,
       parent_email_id, follow_up_sequence_number)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
    RETURNING *
  `, [
    e.contact_id || null, e.company_id || null,
    e.comm_type || 'note', e.subject || '', e.body || '',
    e.category || 'other', e.status || 'saved', e.version || 1,
    e.source || 'manual', e.from_email || '', e.from_name || '',
    e.to_email || '', e.draft_mode || '', e.followup_text || '', e.rationale || '',
    e.sent_at || null, Boolean(e.review_needed), e.raw_payload || '', e.extra_instructions || '',
    e.cc || '', e.bcc || '', e.notes || '', e.parent_email_id || null, e.follow_up_sequence_number || null
  ]);
  return row;
}

async function listTimelineForContact(contactId, limit = 100) {
  return q(`
    SELECT * FROM communications
    WHERE contact_id = $1
    ORDER BY COALESCE(sent_at, created_at) DESC NULLS LAST
    LIMIT $2
  `, [contactId, limit]);
}

async function getCommunication(id) {
  return q1(`SELECT * FROM communications WHERE id = $1`, [id]);
}

async function updateCommunication(id, fields) {
  const allowed = [
    'subject','body','category','status','draft_mode','followup_text','rationale',
    'review_needed','contact_id','company_id','to_email','cc','bcc','notes','extra_instructions'
  ];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const key of allowed) {
    if (fields[key] !== undefined) { sets.push(`${key}=$${i++}`); vals.push(fields[key]); }
  }
  if (!sets.length) return;
  sets.push(`updated_at=NOW()`);
  vals.push(id);
  await q(`UPDATE communications SET ${sets.join(', ')} WHERE id=$${i}`, vals);
}

async function deleteCommunication(id) {
  // Attachment links cascade-delete with the row (FK ON DELETE CASCADE), but
  // a one-off attachment (not a library item) left with no remaining links
  // is dead weight -- clean it up so deleting an email doesn't leave orphaned
  // blobs behind. Library items are never touched by this.
  const linked = await q(`SELECT attachment_id FROM communication_attachments WHERE communication_id = $1`, [id]);
  await q(`DELETE FROM communications WHERE id = $1`, [id]);
  for (const { attachment_id } of linked) {
    await deleteOrphanedOneOffAttachment(attachment_id);
  }
}

async function deleteOrphanedOneOffAttachment(attachmentId) {
  const stillLinked = await q1(`SELECT 1 FROM communication_attachments WHERE attachment_id = $1 LIMIT 1`, [attachmentId]);
  if (stillLinked) return;
  await q(`DELETE FROM attachments WHERE id = $1 AND is_library_item = FALSE`, [attachmentId]);
}

async function duplicateCommunication(id) {
  const original = await q1(`SELECT * FROM communications WHERE id = $1`, [id]);
  if (!original) return null;
  // Version-numbered within the same category (draft_mode) as the original,
  // not the contact's whole draft history -- each category's chain is independent.
  const maxRow = await q1(
    `SELECT COALESCE(MAX(version),0) AS maxv FROM communications WHERE contact_id=$1 AND comm_type='draft' AND COALESCE(draft_mode,'cold_outreach')=$2`,
    [original.contact_id, original.draft_mode || 'cold_outreach']
  );
  const newVersion = (maxRow ? maxRow.maxv : 0) + 1;
  const [row] = await q(`
    INSERT INTO communications (contact_id, company_id, comm_type, subject, body, category,
      status, version, source, draft_mode, followup_text, rationale, to_email, cc, bcc, notes)
    SELECT contact_id, company_id, 'draft', subject, body, category,
      'draft', $1, 'duplicated', draft_mode, followup_text, rationale, to_email, cc, bcc, notes
    FROM communications WHERE id = $2
    RETURNING *
  `, [newVersion, id]);
  // "Use as Template" reuses this same duplicate path -- comm_type is always
  // forced to 'draft' regardless of the source row's own comm_type, so
  // duplicating a manually-imported email produces a fresh editable draft,
  // not another imported-email record. Carry the source's attachments over
  // so the new draft starts with the same files.
  if (row) {
    await q(`
      INSERT INTO communication_attachments (communication_id, attachment_id)
      SELECT $1, attachment_id FROM communication_attachments WHERE communication_id = $2
    `, [row.id, id]);
    await logContactActivity(row.contact_id, 'draft_duplicated', `Duplicated draft "${row.subject || '(no subject)'}" as version ${newVersion}`);
  }
  return row;
}

// ── Manually-imported emails (sent outside this system, logged after the fact) ──

async function insertManualEmail({ contactId, companyId, mode, subject, body, toEmail, sentAt, notes }) {
  return insertCommunication({
    contact_id: contactId, company_id: companyId || null,
    comm_type: 'imported_email', source: 'manual_entry', status: 'sent',
    draft_mode: mode || 'cold_outreach', subject, body, to_email: toEmail || '',
    sent_at: sentAt || new Date().toISOString(), notes: notes || '',
  });
}

async function listImportedEmailsForContact(contactId, mode) {
  const rows = await q(`
    SELECT * FROM communications
    WHERE contact_id = $1 AND comm_type = 'imported_email' AND deleted_at IS NULL
      AND COALESCE(draft_mode, 'cold_outreach') = $2
    ORDER BY COALESCE(sent_at, created_at) DESC, id DESC
  `, [contactId, mode || 'cold_outreach']);
  for (const row of rows) {
    row.attachments = await listAttachmentsForCommunication(row.id);
  }
  return rows;
}

// ── Attachments (one-off, on a specific email/draft) ──

async function uploadOneOffAttachment({ buffer, mimetype, originalname }) {
  const [row] = await q(`
    INSERT INTO attachments (original_filename, mime_type, file_size, file_data, is_library_item)
    VALUES ($1,$2,$3,$4, FALSE)
    RETURNING id, original_filename, mime_type, file_size, is_library_item, created_at
  `, [originalname, mimetype, buffer.length, buffer]);
  return row;
}

async function linkAttachmentToCommunication(communicationId, attachmentId) {
  await q(`INSERT INTO communication_attachments (communication_id, attachment_id) VALUES ($1,$2)`, [communicationId, attachmentId]);
}

async function listAttachmentsForCommunication(communicationId) {
  return q(`
    SELECT a.id, a.original_filename, a.mime_type, a.file_size, a.is_library_item, a.library_name
    FROM communication_attachments ca
    JOIN attachments a ON a.id = ca.attachment_id
    WHERE ca.communication_id = $1
    ORDER BY ca.created_at ASC
  `, [communicationId]);
}

async function unlinkAttachment(communicationId, attachmentId) {
  await q(`DELETE FROM communication_attachments WHERE communication_id = $1 AND attachment_id = $2`, [communicationId, attachmentId]);
  await deleteOrphanedOneOffAttachment(attachmentId);
}

async function getAttachment(id) {
  return q1(`SELECT * FROM attachments WHERE id = $1`, [id]);
}

// ── Attachment Library (reusable files: brochures, catalogs, etc.) ──

async function createLibraryAttachment({ name, category, buffer, mimetype, originalname }) {
  const libraryKey = `lib_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await q(`
    INSERT INTO attachments
      (original_filename, mime_type, file_size, file_data, is_library_item, library_key, library_name, library_category, version)
    VALUES ($1,$2,$3,$4, TRUE, $5,$6,$7, 1)
    RETURNING id, original_filename, mime_type, file_size, library_key, library_name, library_category, version, is_favorite, created_at
  `, [originalname, mimetype, buffer.length, buffer, libraryKey, name || originalname, category || 'other']);
  return row;
}

async function replaceLibraryAttachment(libraryKey, { buffer, mimetype, originalname }) {
  const current = await q1(`SELECT * FROM attachments WHERE library_key = $1 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`, [libraryKey]);
  if (!current) return null;
  const newVersion = current.version + 1;
  const [row] = await q(`
    INSERT INTO attachments
      (original_filename, mime_type, file_size, file_data, is_library_item, library_key, library_name, library_category, version, is_favorite)
    VALUES ($1,$2,$3,$4, TRUE, $5,$6,$7,$8,$9)
    RETURNING id, original_filename, mime_type, file_size, library_key, library_name, library_category, version, is_favorite, created_at
  `, [originalname, mimetype, buffer.length, buffer, libraryKey, current.library_name, current.library_category, newVersion, current.is_favorite]);
  return row;
}

async function listAttachmentLibrary({ search, category, favoritesOnly } = {}) {
  const conditions = [`is_library_item = TRUE`, `deleted_at IS NULL`];
  const vals = [];
  let i = 1;
  if (search) { conditions.push(`library_name ILIKE $${i++}`); vals.push(`%${search}%`); }
  if (category) { conditions.push(`library_category = $${i++}`); vals.push(category); }
  if (favoritesOnly) conditions.push(`is_favorite = TRUE`);
  return q(`
    SELECT DISTINCT ON (library_key) id, original_filename, mime_type, file_size,
      library_key, library_name, library_category, version, is_favorite, created_at
    FROM attachments
    WHERE ${conditions.join(' AND ')}
    ORDER BY library_key, version DESC
  `, vals);
}

async function listLibraryVersions(libraryKey) {
  return q(`
    SELECT id, original_filename, mime_type, file_size, version, created_at
    FROM attachments WHERE library_key = $1 AND deleted_at IS NULL
    ORDER BY version DESC
  `, [libraryKey]);
}

async function toggleLibraryFavorite(attachmentId) {
  const row = await q1(`SELECT library_key, is_favorite FROM attachments WHERE id = $1`, [attachmentId]);
  if (!row || !row.library_key) return null;
  const newFavorite = !row.is_favorite;
  // Favorite status belongs to the library slot, not a single version --
  // keep every version's flag in sync so it's consistent regardless of
  // which version happens to be "current" when displayed.
  await q(`UPDATE attachments SET is_favorite = $1 WHERE library_key = $2`, [newFavorite, row.library_key]);
  return { library_key: row.library_key, is_favorite: newFavorite };
}

async function deleteLibraryItem(libraryKey) {
  await q(`UPDATE attachments SET deleted_at = NOW() WHERE library_key = $1`, [libraryKey]);
}

// ── Draft lifecycle: current draft, version history, save, status, trash/archive, follow-ups ──

// "The current draft" for a (contact, category) is its latest non-deleted,
// non-follow-up version -- every regeneration already inserts a new
// communications row (see insertEmailDraftVersion), so no separate "live"
// record is needed. Each category (draft_mode) has its own independent
// current draft -- drafting "Procurement Outreach" never affects "Cold
// Outreach". parent_email_id IS NULL excludes follow-ups: a follow-up shares
// its parent's draft_mode but is a separate linked item, not a new version
// of that category's ongoing draft.
async function getCurrentDraftForContact(contactId, mode) {
  return q1(`
    SELECT * FROM communications
    WHERE contact_id = $1 AND comm_type = 'draft' AND deleted_at IS NULL
      AND COALESCE(draft_mode, 'cold_outreach') = $2 AND parent_email_id IS NULL
    ORDER BY version DESC, id DESC
    LIMIT 1
  `, [contactId, mode || 'cold_outreach']);
}

async function listDraftVersionsForContact(contactId, mode) {
  return q(`
    SELECT * FROM communications
    WHERE contact_id = $1 AND comm_type = 'draft'
      AND COALESCE(draft_mode, 'cold_outreach') = $2 AND parent_email_id IS NULL
    ORDER BY version DESC, id DESC
  `, [contactId, mode || 'cold_outreach']);
}

// asNewVersion=false: edit the row in place (cheap, for iterative typing).
// asNewVersion=true: snapshot the edit as a new version, same mechanism AI
// regeneration uses, so "Save as New Version" and "Redraft" share one path.
async function saveDraftEdit(id, fields, asNewVersion) {
  const existing = await getCommunication(id);
  if (!existing) return null;

  if (!asNewVersion) {
    await updateCommunication(id, fields);
    await logContactActivity(existing.contact_id, 'draft_edited', `Edited draft "${fields.subject || existing.subject || '(no subject)'}"`);
    return getCommunication(id);
  }

  // Version-numbered within this row's own category (draft_mode), not the
  // contact's whole draft history -- each category's chain is independent.
  const maxRow = await q1(
    `SELECT COALESCE(MAX(version),0) AS maxv FROM communications WHERE contact_id=$1 AND comm_type='draft' AND COALESCE(draft_mode,'cold_outreach')=$2`,
    [existing.contact_id, existing.draft_mode || 'cold_outreach']
  );
  const newVersion = (maxRow ? maxRow.maxv : 0) + 1;
  const merged = {
    contact_id: existing.contact_id, company_id: existing.company_id, comm_type: 'draft',
    subject: fields.subject !== undefined ? fields.subject : existing.subject,
    body: fields.body !== undefined ? fields.body : existing.body,
    category: existing.category, status: 'draft', version: newVersion, source: 'manual_edit',
    draft_mode: existing.draft_mode, extra_instructions: existing.extra_instructions,
    followup_text: fields.followup_text !== undefined ? fields.followup_text : existing.followup_text,
    rationale: existing.rationale,
    to_email: fields.to_email !== undefined ? fields.to_email : existing.to_email,
    cc: fields.cc !== undefined ? fields.cc : existing.cc,
    bcc: fields.bcc !== undefined ? fields.bcc : existing.bcc,
    notes: fields.notes !== undefined ? fields.notes : existing.notes,
  };
  const row = await insertCommunication(merged);
  await logContactActivity(existing.contact_id, 'draft_new_version', `Saved "${merged.subject || '(no subject)'}" as version ${newVersion}`);
  return row;
}

async function setCommunicationStatus(id, status) {
  const existing = await getCommunication(id);
  if (!existing) return null;
  await updateCommunication(id, { status });
  await logContactActivity(existing.contact_id, 'email_status_changed', `Status changed from "${existing.status}" to "${status}"`);
  return getCommunication(id);
}

async function trashCommunication(id) {
  const existing = await getCommunication(id);
  if (!existing) return null;
  await q(`UPDATE communications SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
  await logContactActivity(existing.contact_id, 'draft_trashed', `Moved "${existing.subject || '(no subject)'}" to Trash`);
  return getCommunication(id);
}

async function restoreCommunication(id) {
  const existing = await getCommunication(id);
  if (!existing) return null;
  await q(`UPDATE communications SET deleted_at = NULL, updated_at = NOW() WHERE id = $1`, [id]);
  await logContactActivity(existing.contact_id, 'draft_restored', `Restored "${existing.subject || '(no subject)'}" from Trash`);
  return getCommunication(id);
}

async function archiveCommunication(id) {
  const existing = await getCommunication(id);
  if (!existing) return null;
  await q(`UPDATE communications SET archived_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
  await logContactActivity(existing.contact_id, 'draft_archived', `Archived "${existing.subject || '(no subject)'}"`);
  return getCommunication(id);
}

async function unarchiveCommunication(id) {
  const existing = await getCommunication(id);
  if (!existing) return null;
  await q(`UPDATE communications SET archived_at = NULL, updated_at = NOW() WHERE id = $1`, [id]);
  await logContactActivity(existing.contact_id, 'draft_unarchived', `Unarchived "${existing.subject || '(no subject)'}"`);
  return getCommunication(id);
}

// Creates a new, independent draft seeded from the original's follow-up
// template, linked back via parent_email_id/follow_up_sequence_number.
async function createFollowUp(id) {
  const original = await getCommunication(id);
  if (!original) return null;
  const seqRow = await q1(
    `SELECT COUNT(*)::int AS n FROM communications WHERE parent_email_id = $1`,
    [id]
  );
  const seq = (seqRow ? seqRow.n : 0) + 1;
  const row = await insertCommunication({
    contact_id: original.contact_id, company_id: original.company_id, comm_type: 'draft',
    subject: `Follow-up: ${original.subject || '(no subject)'}`,
    body: original.followup_text || '',
    category: original.category, status: 'draft', version: 1, source: 'follow_up',
    draft_mode: original.draft_mode, to_email: original.to_email,
    parent_email_id: id, follow_up_sequence_number: seq,
  });
  await logContactActivity(original.contact_id, 'followup_created', `Created follow-up #${seq} for "${original.subject || '(no subject)'}"`);
  return row;
}

// Same lookup as findLatestDraftForContact, but excludes trashed drafts --
// a draft the user has already discarded shouldn't block generating a new one.
async function checkEquivalentDraft(contactId, mode, extraInstructions) {
  return q1(`
    SELECT * FROM communications
    WHERE contact_id = $1 AND comm_type = 'draft' AND deleted_at IS NULL
      AND COALESCE(draft_mode, 'cold_outreach') = $2
      AND COALESCE(extra_instructions, '') = $3
    ORDER BY version DESC, id DESC
    LIMIT 1
  `, [contactId, mode || 'cold_outreach', extraInstructions || '']);
}

// Draft Library data source: one row per category (draft_mode) that has a
// current draft for this contact, so a category with none yet is simply
// absent from the result -- the caller (server.js, which owns the mode list
// via claude.js's listDraftModes()) fills in "Not Generated" for those.
async function listDraftCategoriesForContact(contactId) {
  return q(`
    SELECT DISTINCT ON (COALESCE(draft_mode, 'cold_outreach'))
      id, COALESCE(draft_mode, 'cold_outreach') AS draft_mode, status, version, updated_at
    FROM communications
    WHERE contact_id = $1 AND comm_type = 'draft' AND deleted_at IS NULL AND parent_email_id IS NULL
    ORDER BY COALESCE(draft_mode, 'cold_outreach'), version DESC, id DESC
  `, [contactId]);
}

async function findDuplicateEmail(fromEmail, subject) {
  return q1(`
    SELECT id FROM communications
    WHERE comm_type = 'imported_email'
      AND LOWER(COALESCE(from_email,'')) = LOWER(COALESCE($1,''))
      AND LOWER(COALESCE(subject,''))    = LOWER(COALESCE($2,''))
    LIMIT 1
  `, [fromEmail || '', subject || '']);
}

// ===========================================================================
// Lookup helpers used by email ingestion
// ===========================================================================

async function findContactByEmail(email) {
  if (!email) return null;
  return q1(`SELECT * FROM contacts WHERE LOWER(email) = LOWER($1) LIMIT 1`, [email]);
}

async function findContactByEmailDomain(domain) {
  if (!domain) return null;
  return q1(`SELECT * FROM contacts WHERE email ILIKE $1 ORDER BY id DESC LIMIT 1`, [`%@${domain}`]);
}

async function findCompanyByDomain(domain) {
  if (!domain) return null;
  return q1(`SELECT * FROM companies WHERE website ILIKE $1 LIMIT 1`, [`%${domain}%`]);
}

async function countNeedsReviewEmails() {
  const row = await q1(`SELECT COUNT(*)::int AS count FROM email_history WHERE review_needed = TRUE`);
  return row ? row.count : 0;
}

// ===========================================================================
// Email history (forwarded / imported emails)
// ===========================================================================

async function insertEmailHistory(e) {
  const [row] = await q(`
    INSERT INTO email_history
      (contact_id, company_id, from_email, from_name, to_email,
       subject, body, sent_at, category, source, review_needed, raw_payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *
  `, [
    e.contact_id || null, e.company_id || null,
    e.from_email || '', e.from_name || '', e.to_email || '',
    e.subject || '', e.body || '',
    e.sent_at || null,
    e.category || 'other', e.source || 'manual_paste',
    Boolean(e.review_needed), e.raw_payload || ''
  ]);
  // Dual-write to unified communications table (skip if duplicate already there)
  const dup = await findDuplicateEmail(e.from_email, e.subject);
  if (!dup) {
    await insertCommunication({
      contact_id: e.contact_id, company_id: e.company_id,
      comm_type: 'imported_email',
      subject: e.subject, body: e.body,
      category: e.category || 'other', source: e.source || 'manual_paste',
      from_email: e.from_email, from_name: e.from_name, to_email: e.to_email,
      sent_at: e.sent_at, review_needed: e.review_needed, raw_payload: e.raw_payload
    });
  }
  return row;
}

async function listEmailHistoryForContact(contactId) {
  return q(`
    SELECT * FROM email_history
    WHERE contact_id = $1
    ORDER BY sent_at DESC NULLS LAST, created_at DESC
  `, [contactId]);
}

async function listNeedsReviewEmails(limit = 50) {
  return q(`
    SELECT eh.*,
      c.full_name AS contact_name, c.company AS contact_company,
      co.name AS company_name
    FROM email_history eh
    LEFT JOIN contacts c ON c.id = eh.contact_id
    LEFT JOIN companies co ON co.id = eh.company_id
    WHERE eh.review_needed = TRUE
    ORDER BY eh.created_at DESC
    LIMIT $1
  `, [limit]);
}

async function listRecentEmailHistory(limit = 100) {
  return q(`
    SELECT eh.*,
      c.full_name AS contact_name, c.company AS contact_company
    FROM email_history eh
    LEFT JOIN contacts c ON c.id = eh.contact_id
    ORDER BY eh.sent_at DESC NULLS LAST, eh.created_at DESC
    LIMIT $1
  `, [limit]);
}

async function updateEmailHistory(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (fields.contact_id !== undefined) { sets.push(`contact_id=$${i++}`); vals.push(fields.contact_id); }
  if (fields.company_id !== undefined) { sets.push(`company_id=$${i++}`); vals.push(fields.company_id); }
  if (fields.category !== undefined) { sets.push(`category=$${i++}`); vals.push(fields.category); }
  if (fields.review_needed !== undefined) { sets.push(`review_needed=$${i++}`); vals.push(Boolean(fields.review_needed)); }
  if (!sets.length) return;
  vals.push(id);
  await q(`UPDATE email_history SET ${sets.join(', ')} WHERE id=$${i}`, vals);
}

// ===========================================================================
// Settings
// ===========================================================================

async function getSetting(key) {
  const row = await q1(`SELECT value FROM settings WHERE key = $1`, [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await q(`
    INSERT INTO settings (key, value) VALUES ($1, $2)
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
  `, [key, value]);
}

module.exports = {
  pool,
  initDb,
  // events
  getOrCreateEvent, listEvents,
  // accounts
  getOrCreateAccount, getAccount, listAccounts, listAccountGroups, getAccountContacts,
  listCompaniesForAccount, mergeAccounts,
  // companies
  upsertCompany, findCompanyByName, getCompany, listCompanies, getCompanyContacts,
  // contacts
  insertContact, listContacts, getContact, listContactsByCompany, deleteContact, deleteContacts,
  updateContact, updateContactDraft, findExistingContact, upsertContact, splitName,
  searchContacts, filterContacts, patchContactCrmFields, logContactActivity, listContactActivity,
  listContactNamesForBrowse,
  // business cards
  insertBusinessCard, listBusinessCardsForContact,
  // apollo
  getApolloCache, setApolloCache, getCompanySearchCache, setCompanySearchCache,
  updateCachedLeadDraft, logApolloResult, listApolloResults,
  // email drafts
  insertEmailDraftVersion, listEmailDraftsForContact, findLatestDraftForContact,
  // communications (unified timeline)
  insertCommunication, listTimelineForContact, getCommunication,
  updateCommunication, deleteCommunication, duplicateCommunication, findDuplicateEmail,
  // draft lifecycle: current draft, versions, save, status, trash/archive, follow-ups
  getCurrentDraftForContact, listDraftVersionsForContact, saveDraftEdit,
  setCommunicationStatus, trashCommunication, restoreCommunication,
  archiveCommunication, unarchiveCommunication, createFollowUp, checkEquivalentDraft,
  listDraftCategoriesForContact,
  // manually-imported emails
  insertManualEmail, listImportedEmailsForContact,
  // attachments + attachment library
  uploadOneOffAttachment, linkAttachmentToCommunication, listAttachmentsForCommunication,
  unlinkAttachment, getAttachment,
  createLibraryAttachment, replaceLibraryAttachment, listAttachmentLibrary,
  listLibraryVersions, toggleLibraryFavorite, deleteLibraryItem,
  // email history (forwarded / imported)
  insertEmailHistory, listEmailHistoryForContact, listNeedsReviewEmails,
  listRecentEmailHistory, updateEmailHistory,
  findContactByEmail, findContactByEmailDomain, findCompanyByDomain, countNeedsReviewEmails,
  // settings
  getSetting, setSetting
};
