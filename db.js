const { Pool } = require('pg');

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
// Companies
// ===========================================================================

const pick = (newVal, oldVal) => (newVal === undefined || newVal === null || newVal === '' ? oldVal : newVal);
const pickNumber = (newVal, oldVal) => (newVal === undefined || newVal === null || newVal === '' ? oldVal : Number(newVal));

async function findCompanyByName(name) {
  if (!name || !name.trim()) return null;
  return q1(`SELECT * FROM companies WHERE LOWER(name) = LOWER($1)`, [name.trim()]);
}

async function getCompany(id) {
  return q1(`SELECT * FROM companies WHERE id = $1`, [id]);
}

async function upsertCompany(fields) {
  const name = (fields.name || '').trim();
  if (!name) return null;

  const eventRow = fields.event_name ? await getOrCreateEvent(fields.event_name) : null;
  const existing = await findCompanyByName(name);

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
        updated_at=NOW()
      WHERE id=$14
    `, [
      merged.name, merged.chinese_name, merged.industry, merged.booth, merged.event_id,
      merged.website, merged.notes, merged.category, merged.priority, merged.background,
      merged.opportunity, merged.mfg_location, merged.contact_tip, existing.id
    ]);
    return { id: existing.id, updated: true };
  }

  const [{ id }] = await q(`
    INSERT INTO companies (
      name, chinese_name, industry, booth, event_id, website, notes,
      category, priority, background, opportunity, mfg_location, contact_tip
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING id
  `, [
    name, fields.chinese_name || '', fields.industry || '', fields.booth || '',
    eventRow ? eventRow.id : null, fields.website || '', fields.notes || '',
    fields.category || '', fields.priority || 0, fields.background || '',
    fields.opportunity || '', fields.mfg_location || '', fields.contact_tip || ''
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

  let companyId = c.company_id || null;
  if (!companyId && c.company) {
    const result = await upsertCompany({ name: c.company });
    if (result) companyId = result.id;
  }

  let eventId = c.event_id || null;
  if (!eventId && c.event_name) {
    const ev = await getOrCreateEvent(c.event_name);
    if (ev) eventId = ev.id;
  }

  const [{ id }] = await q(`
    INSERT INTO contacts (
      first_name, last_name, full_name, job_title, department, seniority,
      email, phone, website, linkedin_url, company, company_id,
      address, notes, raw_text, apollo_person_id, apollo_raw_json, apollo_enriched_at,
      source, confidence, relevance,
      draft_subject, draft_body, draft_followup, draft_rationale,
      tags, follow_up_status, last_contacted_at,
      event_id, booth_number, meeting_date, meeting_notes, interest_level,
      products_discussed, assigned_salesperson, has_email, email_lookup_status
    ) VALUES (
      $1,  $2,  $3,  $4,  $5,  $6,  $7,  $8,  $9,  $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
      $31, $32, $33, $34, $35, $36, $37
    ) RETURNING id
  `, [
    first_name, last_name, c.full_name || '', c.job_title || '', c.department || '', c.seniority || '',
    c.email || '', c.phone || '', c.website || '', c.linkedin_url || '', c.company || '', companyId,
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
    c.email ? 'found' : (c.email_lookup_status || 'not_checked')
  ]);
  return id;
}

const DRAFT_COUNT_JOIN = `
  LEFT JOIN (
    SELECT contact_id, COUNT(*)::int AS draft_count, MAX(id) AS latest_draft_id
    FROM email_drafts GROUP BY contact_id
  ) ed ON ed.contact_id = c.id`;

async function listContacts(limit = 200) {
  return q(`
    SELECT c.*, COALESCE(ed.draft_count,0)::int AS draft_count, ed.latest_draft_id
    FROM contacts c ${DRAFT_COUNT_JOIN}
    ORDER BY c.id DESC LIMIT $1
  `, [limit]);
}

async function getContact(id) {
  return q1(`SELECT * FROM contacts WHERE id = $1`, [id]);
}

async function listContactsByCompany(company) {
  return q(`SELECT * FROM contacts WHERE LOWER(company) = LOWER($1) ORDER BY id DESC`, [company]);
}

async function deleteContact(id) {
  await q(`DELETE FROM contacts WHERE id = $1`, [id]);
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

  let companyId = c.company_id || existing.company_id || null;
  const newCompanyName = pick(c.company, existing.company);
  if (newCompanyName && (!companyId || (c.company && c.company !== existing.company))) {
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
      // Explicit value wins
      if (c.email_lookup_status) return c.email_lookup_status;
      // If we're writing an email that wasn't there before, mark as found
      if (merged.email && !existing.email) return 'found';
      // Otherwise preserve existing status
      return existing.email_lookup_status || 'not_checked';
    })()
  };

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
      email_lookup_status=$37, updated_at=NOW()
    WHERE id=$38
  `, [
    merged.first_name, merged.last_name, merged.full_name, merged.job_title, merged.department, merged.seniority,
    merged.email, merged.phone, merged.website, merged.linkedin_url, merged.company, merged.company_id,
    merged.address, merged.notes, merged.raw_text, merged.apollo_person_id, merged.apollo_raw_json, merged.apollo_enriched_at,
    merged.source, merged.confidence, merged.relevance,
    merged.draft_subject, merged.draft_body, merged.draft_followup, merged.draft_rationale,
    merged.tags, merged.follow_up_status, merged.last_contacted_at,
    merged.event_id, merged.booth_number, merged.meeting_date, merged.meeting_notes, merged.interest_level,
    merged.products_discussed, merged.assigned_salesperson, merged.has_email,
    merged.email_lookup_status,
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
      SELECT c.*, COALESCE(ed.draft_count,0)::int AS draft_count, ed.latest_draft_id
      FROM contacts c ${DRAFT_COUNT_JOIN}
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

  params.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = filters.sortBy === 'last_contacted' ? 'ORDER BY c.last_contacted_at DESC' : 'ORDER BY c.id DESC';

  return q(`
    SELECT c.*, COALESCE(ed.draft_count,0)::int AS draft_count, ed.latest_draft_id
    FROM contacts c
    LEFT JOIN companies comp ON comp.id = c.company_id
    ${DRAFT_COUNT_JOIN}
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

async function insertEmailDraftVersion(contactId, draft) {
  const row = await q1(`SELECT MAX(version) AS maxv FROM email_drafts WHERE contact_id = $1`, [contactId]);
  const nextVersion = (row && row.maxv ? Number(row.maxv) : 0) + 1;
  const [{ id }] = await q(`
    INSERT INTO email_drafts (contact_id, version, subject, body, followup, rationale)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
  `, [contactId, nextVersion, draft.subject || '', draft.body || '', draft.followup || '', draft.rationale || '']);
  return { id, version: nextVersion };
}

async function listEmailDraftsForContact(contactId) {
  return q(`SELECT * FROM email_drafts WHERE contact_id = $1 ORDER BY version DESC`, [contactId]);
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
  // companies
  upsertCompany, findCompanyByName, getCompany, listCompanies, getCompanyContacts,
  // contacts
  insertContact, listContacts, getContact, listContactsByCompany, deleteContact,
  updateContact, updateContactDraft, findExistingContact, upsertContact, splitName,
  searchContacts, filterContacts, patchContactCrmFields, logContactActivity, listContactActivity,
  // business cards
  insertBusinessCard, listBusinessCardsForContact,
  // apollo
  getApolloCache, setApolloCache, getCompanySearchCache, setCompanySearchCache,
  updateCachedLeadDraft, logApolloResult, listApolloResults,
  // email drafts
  insertEmailDraftVersion, listEmailDraftsForContact,
  // email history (forwarded / imported)
  insertEmailHistory, listEmailHistoryForContact, listNeedsReviewEmails,
  listRecentEmailHistory, updateEmailHistory,
  findContactByEmail, findContactByEmailDomain, findCompanyByDomain, countNeedsReviewEmails,
  // settings
  getSetting, setSetting
};
