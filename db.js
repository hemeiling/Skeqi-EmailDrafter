const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, 'contacts.db');
const db = new DatabaseSync(dbPath);

// -----------------------------------------------------------------------
// Schema -- one SQLite file, multiple related tables. No separate database
// for any feature; Card Scanner writes into the exact same `contacts` table
// (and the exact same `companies` table) that Find Leads / CSV import use.
// -----------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name_ci ON companies (lower(name))`);

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Business card scans: the original image, raw OCR text, and the parsed
// field JSON, linked to whatever contact row it ended up saved as.
db.exec(`
  CREATE TABLE IF NOT EXISTS business_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER REFERENCES contacts(id),
    image_data TEXT,
    ocr_text TEXT,
    parsed_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Apollo enrichment cache (people/match), keyed by email or name+domain.
db.exec(`
  CREATE TABLE IF NOT EXISTS apollo_cache (
    cache_key TEXT PRIMARY KEY,
    raw_json TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  )
`);

// Company-level lead-search cache (mixed_people/api_search), keyed by company.
db.exec(`
  CREATE TABLE IF NOT EXISTS company_search_cache (
    company_key TEXT PRIMARY KEY,
    raw_json TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  )
`);

// Full history log of every Apollo call made (people search, org search,
// enrichment) -- append-only, for auditing/"search history" visibility.
// This is separate from the caches above, which exist to gate whether a
// call happens at all; this table exists purely to track what happened.
db.exec(`
  CREATE TABLE IF NOT EXISTS apollo_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    result_type TEXT NOT NULL,
    company_id INTEGER REFERENCES companies(id),
    contact_id INTEGER REFERENCES contacts(id),
    query_key TEXT,
    raw_json TEXT,
    searched_at TEXT DEFAULT (datetime('now'))
  )
`);

// Every generated email draft, versioned -- so draft history/prompt
// iterations are preserved, not just the latest one. contacts.draft_* stays
// as a fast "current draft" convenience column; this table is the full log.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER REFERENCES contacts(id),
    version INTEGER NOT NULL,
    subject TEXT,
    body TEXT,
    followup TEXT,
    rationale TEXT,
    sent_status TEXT DEFAULT 'not_sent',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Relationship history / activity log -- notes, status changes, scans,
// drafts, anything worth remembering about a contact over time. This is
// the foundation for "future CRM features like notes, follow-up status,
// tags, events, and relationship history."
db.exec(`
  CREATE TABLE IF NOT EXISTS contact_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    activity_type TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Small key/value store -- sender profile, etc.
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

// ===========================================================================
// Events
// ===========================================================================

function getOrCreateEvent(name) {
  if (!name || !name.trim()) return null;
  const trimmed = name.trim();
  const existing = db.prepare(`SELECT * FROM events WHERE lower(name) = lower(?)`).get(trimmed);
  if (existing) return existing;
  const info = db.prepare(`INSERT INTO events (name) VALUES (?)`).run(trimmed);
  return { id: Number(info.lastInsertRowid), name: trimmed };
}

function listEvents() {
  return db.prepare(`SELECT * FROM events ORDER BY name`).all();
}

// ===========================================================================
// Companies
// ===========================================================================

const pick = (newVal, oldVal) => (newVal === undefined || newVal === null || newVal === '' ? oldVal : newVal);
const pickNumber = (newVal, oldVal) => (newVal === undefined || newVal === null || newVal === '' ? oldVal : Number(newVal));

function findCompanyByName(name) {
  if (!name || !name.trim()) return null;
  return db.prepare(`SELECT * FROM companies WHERE lower(name) = lower(?)`).get(name.trim()) || null;
}

function getCompany(id) {
  return db.prepare(`SELECT * FROM companies WHERE id = ?`).get(id) || null;
}

// Finds a company by name (case-insensitive) and updates it with any new
// non-blank fields, or creates it if it doesn't exist yet. This is the single
// entry point for every path that touches a company: CSV/XLSX import, Apollo
// lead search results, and business-card scans that include a company name.
function upsertCompany(fields) {
  const name = (fields.name || '').trim();
  if (!name) return null;

  const eventRow = fields.event_name ? getOrCreateEvent(fields.event_name) : null;
  const existing = findCompanyByName(name);

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
    db.prepare(`
      UPDATE companies SET
        name=?, chinese_name=?, industry=?, booth=?, event_id=?, website=?, notes=?,
        category=?, priority=?, background=?, opportunity=?, mfg_location=?, contact_tip=?,
        updated_at=datetime('now')
      WHERE id=?
    `).run(
      merged.name, merged.chinese_name, merged.industry, merged.booth, merged.event_id,
      merged.website, merged.notes, merged.category, merged.priority, merged.background,
      merged.opportunity, merged.mfg_location, merged.contact_tip, existing.id
    );
    return { id: existing.id, updated: true };
  }

  const info = db.prepare(`
    INSERT INTO companies (
      name, chinese_name, industry, booth, event_id, website, notes,
      category, priority, background, opportunity, mfg_location, contact_tip
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, fields.chinese_name || '', fields.industry || '', fields.booth || '',
    eventRow ? eventRow.id : null, fields.website || '', fields.notes || '',
    fields.category || '', fields.priority || 0, fields.background || '',
    fields.opportunity || '', fields.mfg_location || '', fields.contact_tip || ''
  );
  return { id: Number(info.lastInsertRowid), updated: false };
}

function listCompanies(searchTerm) {
  if (searchTerm && searchTerm.trim()) {
    const like = `%${searchTerm.trim().toLowerCase()}%`;
    return db.prepare(`
      SELECT * FROM companies
      WHERE lower(name) LIKE ? OR lower(chinese_name) LIKE ? OR lower(industry) LIKE ?
      ORDER BY priority DESC, name
    `).all(like, like, like);
  }
  return db.prepare(`SELECT * FROM companies ORDER BY priority DESC, name`).all();
}

function getCompanyContacts(companyId) {
  return db.prepare(`SELECT * FROM contacts WHERE company_id = ? ORDER BY id DESC`).all(companyId);
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

function insertContact(c) {
  const { first_name, last_name } = c.first_name || c.last_name
    ? { first_name: c.first_name || '', last_name: c.last_name || '' }
    : splitName(c.full_name);

  let companyId = c.company_id || null;
  if (!companyId && c.company) {
    const result = upsertCompany({ name: c.company });
    if (result) companyId = result.id;
  }

  let eventId = c.event_id || null;
  if (!eventId && c.event_name) {
    const ev = getOrCreateEvent(c.event_name);
    if (ev) eventId = ev.id;
  }

  const stmt = db.prepare(`
    INSERT INTO contacts (
      first_name, last_name, full_name, job_title, department, seniority,
      email, phone, website, linkedin_url, company, company_id,
      address, notes, raw_text, apollo_person_id, apollo_raw_json, apollo_enriched_at,
      source, confidence, relevance,
      draft_subject, draft_body, draft_followup, draft_rationale,
      tags, follow_up_status, last_contacted_at,
      event_id, booth_number, meeting_date, meeting_notes, interest_level,
      products_discussed, assigned_salesperson
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
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
    c.products_discussed || '', c.assigned_salesperson || ''
  );
  return Number(info.lastInsertRowid);
}

function listContacts(limit = 200) {
  return db.prepare(`SELECT * FROM contacts ORDER BY id DESC LIMIT ?`).all(limit);
}

function getContact(id) {
  return db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(id) || null;
}

function listContactsByCompany(company) {
  return db.prepare(`SELECT * FROM contacts WHERE lower(company) = lower(?) ORDER BY id DESC`).all(company);
}

function deleteContact(id) {
  db.prepare(`DELETE FROM contacts WHERE id = ?`).run(id);
}

function updateContactDraft(id, draft) {
  db.prepare(`
    UPDATE contacts SET draft_subject = ?, draft_body = ?, draft_followup = ?, draft_rationale = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(draft.subject || '', draft.body || '', draft.followup || '', draft.rationale || '', id);
}

// Looks for an existing contact so scans/leads/CSV imports never create
// duplicates. Match priority: (1) email; (2) LinkedIn URL; (3) full_name +
// company (both required -- name alone is not enough, since two different
// people can share a name).
function findExistingContact(email, fullName, company, linkedinUrl) {
  if (email && email.trim()) {
    const row = db.prepare(`SELECT * FROM contacts WHERE email != '' AND lower(email) = lower(?) LIMIT 1`).get(email.trim());
    if (row) return row;
  }
  if (linkedinUrl && linkedinUrl.trim()) {
    const row = db.prepare(`SELECT * FROM contacts WHERE linkedin_url != '' AND lower(linkedin_url) = lower(?) LIMIT 1`).get(linkedinUrl.trim());
    if (row) return row;
  }
  if (fullName && fullName.trim() && company && company.trim()) {
    const row = db.prepare(`
      SELECT * FROM contacts
      WHERE full_name != '' AND company != ''
        AND lower(full_name) = lower(?) AND lower(company) = lower(?)
      LIMIT 1
    `).get(fullName.trim(), company.trim());
    if (row) return row;
  }
  return null;
}

function updateContact(id, c) {
  const existing = getContact(id);
  if (!existing) return;

  let companyId = c.company_id || existing.company_id || null;
  const newCompanyName = pick(c.company, existing.company);
  if (newCompanyName && (!companyId || (c.company && c.company !== existing.company))) {
    const result = upsertCompany({ name: newCompanyName });
    if (result) companyId = result.id;
  }

  let eventId = c.event_id || existing.event_id || null;
  if (c.event_name) {
    const ev = getOrCreateEvent(c.event_name);
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
    assigned_salesperson: pick(c.assigned_salesperson, existing.assigned_salesperson)
  };

  db.prepare(`
    UPDATE contacts SET
      first_name=?, last_name=?, full_name=?, job_title=?, department=?, seniority=?,
      email=?, phone=?, website=?, linkedin_url=?, company=?, company_id=?,
      address=?, notes=?, raw_text=?, apollo_person_id=?, apollo_raw_json=?, apollo_enriched_at=?,
      source=?, confidence=?, relevance=?,
      draft_subject=?, draft_body=?, draft_followup=?, draft_rationale=?,
      tags=?, follow_up_status=?, last_contacted_at=?,
      event_id=?, booth_number=?, meeting_date=?, meeting_notes=?, interest_level=?,
      products_discussed=?, assigned_salesperson=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    merged.first_name, merged.last_name, merged.full_name, merged.job_title, merged.department, merged.seniority,
    merged.email, merged.phone, merged.website, merged.linkedin_url, merged.company, merged.company_id,
    merged.address, merged.notes, merged.raw_text, merged.apollo_person_id, merged.apollo_raw_json, merged.apollo_enriched_at,
    merged.source, merged.confidence, merged.relevance,
    merged.draft_subject, merged.draft_body, merged.draft_followup, merged.draft_rationale,
    merged.tags, merged.follow_up_status, merged.last_contacted_at,
    merged.event_id, merged.booth_number, merged.meeting_date, merged.meeting_notes, merged.interest_level,
    merged.products_discussed, merged.assigned_salesperson,
    id
  );
}

// The single entry point every save path should use: finds a matching
// contact first, updates it if found, otherwise inserts a new row.
function upsertContact(c) {
  const existing = findExistingContact(c.email, c.full_name, c.company, c.linkedin_url);
  if (existing) {
    updateContact(existing.id, c);
    return { id: existing.id, updated: true };
  }
  return { id: insertContact(c), updated: false };
}

// CRM lookup: search across all contacts by name, company, email, or tags --
// this is the "look up existing companies and contacts" capability, browsing
// everything in the local database regardless of source (Apollo, business
// card, CSV import, manual entry).
function searchContacts(query, limit = 500) {
  if (query && query.trim()) {
    const like = `%${query.trim().toLowerCase()}%`;
    return db.prepare(`
      SELECT * FROM contacts
      WHERE lower(full_name) LIKE ? OR lower(company) LIKE ? OR lower(email) LIKE ?
         OR lower(job_title) LIKE ? OR lower(tags) LIKE ?
      ORDER BY id DESC LIMIT ?
    `).all(like, like, like, like, like, limit);
  }
  return listContacts(limit);
}

// Structured CRM filtering: any combination of event, company, industry
// (via a join to companies), follow-up status, tags, and assigned
// salesperson/owner. Used by the CRM browser's filter controls, in addition
// to the free-text searchContacts() above.
function filterContacts(filters = {}, limit = 1000) {
  const clauses = [];
  const params = [];

  if (filters.event) {
    clauses.push(`c.event_id IN (SELECT id FROM events WHERE lower(name) = lower(?))`);
    params.push(filters.event);
  }
  if (filters.company) {
    clauses.push(`lower(c.company) LIKE ?`);
    params.push(`%${filters.company.trim().toLowerCase()}%`);
  }
  if (filters.industry) {
    clauses.push(`lower(comp.industry) LIKE ?`);
    params.push(`%${filters.industry.trim().toLowerCase()}%`);
  }
  if (filters.follow_up_status) {
    clauses.push(`c.follow_up_status = ?`);
    params.push(filters.follow_up_status);
  }
  if (filters.tags) {
    clauses.push(`lower(c.tags) LIKE ?`);
    params.push(`%${filters.tags.trim().toLowerCase()}%`);
  }
  if (filters.assigned_salesperson) {
    clauses.push(`lower(c.assigned_salesperson) LIKE ?`);
    params.push(`%${filters.assigned_salesperson.trim().toLowerCase()}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = filters.sortBy === 'last_contacted'
    ? 'ORDER BY c.last_contacted_at DESC'
    : 'ORDER BY c.id DESC';

  params.push(limit);

  return db.prepare(`
    SELECT c.* FROM contacts c
    LEFT JOIN companies comp ON comp.id = c.company_id
    ${where}
    ${orderBy}
    LIMIT ?
  `).all(...params);
}

// Directly patches a known contact's CRM fields (tags, follow-up status,
// notes, event/booth/meeting/interest/products/salesperson) by ID -- no
// dedup matching needed since the ID is already known. Delegates to the
// same merge logic as updateContact() so every CRM-editable field is
// supported in one place.
function patchContactCrmFields(id, fields) {
  const existing = getContact(id);
  if (!existing) return null;
  updateContact(id, fields);
  return getContact(id);
}

// Relationship history / activity log.
function logContactActivity(contactId, activityType, description) {
  if (!contactId) return;
  db.prepare(`
    INSERT INTO contact_activity (contact_id, activity_type, description) VALUES (?, ?, ?)
  `).run(contactId, activityType, description || '');
}

function listContactActivity(contactId) {
  return db.prepare(`SELECT * FROM contact_activity WHERE contact_id = ? ORDER BY id DESC`).all(contactId);
}

// ===========================================================================
// Business cards
// ===========================================================================

function insertBusinessCard(contactId, imageData, ocrText, parsedJson) {
  const info = db.prepare(`
    INSERT INTO business_cards (contact_id, image_data, ocr_text, parsed_json)
    VALUES (?, ?, ?, ?)
  `).run(contactId, imageData || '', ocrText || '', parsedJson || '');
  return Number(info.lastInsertRowid);
}

function listBusinessCardsForContact(contactId) {
  return db.prepare(`SELECT * FROM business_cards WHERE contact_id = ? ORDER BY id DESC`).all(contactId);
}

// ===========================================================================
// Apollo caches + history log
// ===========================================================================

function getApolloCache(cacheKey) {
  if (!cacheKey) return null;
  return db.prepare(`SELECT * FROM apollo_cache WHERE cache_key = ?`).get(cacheKey) || null;
}
function setApolloCache(cacheKey, rawJson) {
  if (!cacheKey) return;
  db.prepare(`
    INSERT INTO apollo_cache (cache_key, raw_json, fetched_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(cache_key) DO UPDATE SET raw_json = excluded.raw_json, fetched_at = excluded.fetched_at
  `).run(cacheKey, rawJson);
}

function getCompanySearchCache(companyKey) {
  if (!companyKey) return null;
  return db.prepare(`SELECT * FROM company_search_cache WHERE company_key = ?`).get(companyKey) || null;
}
function setCompanySearchCache(companyKey, rawJson) {
  if (!companyKey) return;
  db.prepare(`
    INSERT INTO company_search_cache (company_key, raw_json, fetched_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(company_key) DO UPDATE SET raw_json = excluded.raw_json, fetched_at = excluded.fetched_at
  `).run(companyKey, rawJson);
}

function updateCachedLeadDraft(companyKey, apolloId, name, draft) {
  const cached = getCompanySearchCache(companyKey);
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
  setCompanySearchCache(companyKey, JSON.stringify(payload));
}

// Append-only history log -- every Apollo call, whether it hit or missed,
// gets one row here purely for auditing/"search history" visibility.
function logApolloResult(resultType, companyId, contactId, queryKey, rawJson) {
  db.prepare(`
    INSERT INTO apollo_results (result_type, company_id, contact_id, query_key, raw_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(resultType, companyId || null, contactId || null, queryKey || '', rawJson || '');
}

function listApolloResults(limit = 200) {
  return db.prepare(`SELECT * FROM apollo_results ORDER BY id DESC LIMIT ?`).all(limit);
}

// ===========================================================================
// Email drafts (versioned history)
// ===========================================================================

function insertEmailDraftVersion(contactId, draft) {
  const row = db.prepare(`SELECT MAX(version) AS maxv FROM email_drafts WHERE contact_id = ?`).get(contactId);
  const nextVersion = (row && row.maxv ? row.maxv : 0) + 1;
  const info = db.prepare(`
    INSERT INTO email_drafts (contact_id, version, subject, body, followup, rationale)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(contactId, nextVersion, draft.subject || '', draft.body || '', draft.followup || '', draft.rationale || '');
  return { id: Number(info.lastInsertRowid), version: nextVersion };
}

function listEmailDraftsForContact(contactId) {
  return db.prepare(`SELECT * FROM email_drafts WHERE contact_id = ? ORDER BY version DESC`).all(contactId);
}

// ===========================================================================
// Settings (sender profile, etc.)
// ===========================================================================

function getSetting(key) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

module.exports = {
  db,
  // events
  getOrCreateEvent, listEvents,
  // companies
  upsertCompany, findCompanyByName, getCompany, listCompanies, getCompanyContacts,
  // contacts
  insertContact, listContacts, getContact, listContactsByCompany, deleteContact,
  updateContactDraft, findExistingContact, upsertContact, splitName,
  searchContacts, filterContacts, patchContactCrmFields, logContactActivity, listContactActivity,
  // business cards
  insertBusinessCard, listBusinessCardsForContact,
  // apollo
  getApolloCache, setApolloCache, getCompanySearchCache, setCompanySearchCache,
  updateCachedLeadDraft, logApolloResult, listApolloResults,
  // email drafts
  insertEmailDraftVersion, listEmailDraftsForContact,
  // settings
  getSetting, setSetting
};
