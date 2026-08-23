const { Pool } = require('pg');
const { normalizeNameKey, isInvalidCompanyName } = require('./companyKey');
const { classifyDepartment, classifySeniority } = require('./contactClassify');
const { buildWhere, buildOrderBy, LAST_ACTIVITY_SQL, OPTION_SQL, escapeLike, companySourceForContact } = require('./contact-query');

/* ── Tests may not open the production database ────────────────────────────
   A backstop, not the main mechanism: test/dbGuard.js redirects DATABASE_URL
   to TEST_DATABASE_URL before this module loads, and every database-backed
   suite requires it. This catches the case that guard cannot — a suite added
   later that forgets to, and would otherwise inherit .env and start writing
   to production.

   It is scoped to NODE_ENV=test, which only `npm test` sets, so production and
   development behaviour are untouched: outside tests this block does nothing.

   Failing here is deliberate. The alternative is a suite that connects, runs
   190 inserts and reports green. */
if (process.env.NODE_ENV === 'test') {
  const testUrl = process.env.TEST_DATABASE_URL || '';
  const current = process.env.DATABASE_URL || '';
  const identity = (u) => {
    try { const x = new URL(u); return `${x.hostname}${x.pathname}`.toLowerCase(); } catch { return null; }
  };
  const id = identity(current);
  if (current && (!testUrl || id !== identity(testUrl))) {
    throw new Error(
      `Refusing to connect: tests may only use TEST_DATABASE_URL, and DATABASE_URL points at ${id || 'an unparseable URL'}. `
      + 'Require test/dbGuard before ../db, or set TEST_DATABASE_URL.',
    );
  }
}

// Enable SSL for production, for managed Postgres (Neon), or whenever the URL
// asks for it — otherwise Neon rejects the connection when running locally.
const DB_URL = process.env.DATABASE_URL || '';
const DB_NEEDS_SSL = process.env.NODE_ENV === 'production'
  || /sslmode=require/i.test(DB_URL)
  || /\.neon\.tech/i.test(DB_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: DB_NEEDS_SSL ? { rejectUnauthorized: false } : false,
  /* node-postgres defaults to 0 — wait for a connection forever. Against a
     managed database that can be unreachable or asleep, that turns every
     query into a promise that neither resolves nor rejects: the route never
     responds and the browser request stays pending. 10s is generous for a
     Neon endpoint waking from idle and still fails inside the dashboard's
     own 15s deadline. */
  connectionTimeoutMillis: 10000,
  /* Left at node-postgres' default (10) in production. Settable because a
     single-connection test database — PGlite, which is how this app is run
     against an isolated database locally — refuses the second connection and
     the boot fails with ECONNRESET. */
  ...(process.env.PG_POOL_MAX ? { max: Number(process.env.PG_POOL_MAX) } : {}),
});

/* An idle client that dies (network drop, Neon scaling the endpoint down)
   emits 'error' on the pool. With no listener that is an unhandled 'error'
   event, which takes the whole process down — and a server that exits
   mid-request leaves the browser waiting on a socket nobody will answer. */
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
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

  /* Grid indexes. The contact table is a server-side data grid now — every
     column filter, sort and facet count runs in Postgres, so the columns
     they touch need to be indexable. communications.contact_id in
     particular was unindexed while being the join behind Activity, Draft
     and last-activity sort: a sequential scan per contact, which is fine at
     870 rows and quadratic at scale. */
  /* Email provenance. Distinct from contacts.source: it records where the
     *address* came from, which is what decides whether re-reading it is free
     (it is, always) and whether obtaining it cost an Apollo credit. */
  /* Company discovery provenance. The uploaded CSV/Excel supplies company
     names, not contacts — so the file is recorded here, on the company, and
     never on the Apollo contacts that the company name later yields.
     source_file keeps the filename so an import can be traced back after
     the fact. */
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS source text`);
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS source_file text`);
  await pool.query(`UPDATE companies SET source = 'legacy' WHERE source IS NULL`);
  // 'derived' said only "something else made this". Split into named causes.
  await pool.query(`UPDATE companies SET source = 'crm_side_effect' WHERE source = 'derived'`);

  /* Company audit trail. contacts have had contact_activity for a while;
     companies had nothing, so how a company came to exist — and any later
     correction to that record — left no trace at all. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_activity (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      activity_type TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_company_activity_company ON company_activity (company_id, created_at DESC)`);

  /* ── Audit spine ──────────────────────────────────────────────────
     One append-only record of actions taken *inside* the CRM. Analytics
     derive from this rather than each feature keeping its own counters, so
     there is one definition of "what happened" and no double bookkeeping.

     Scope is deliberate: only actions performed in this system are written
     here. Nothing observes a user's mailbox, and no message body is stored
     — this table answers "is the platform being used and is it working",
     which is a different question from "what is this person doing". */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_activity (
      id BIGSERIAL PRIMARY KEY,
      actor TEXT,                      -- CRM user; null for system actions
      action TEXT NOT NULL,            -- session.start, email.sent, draft.generated, …
      object_type TEXT,                -- contact | company | report | email | …
      object_id TEXT,
      company_id INTEGER,
      contact_id INTEGER,
      metadata JSONB,                  -- counts and settings only, never content
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_activity_time ON crm_activity (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_activity_actor ON crm_activity (actor, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_activity_action ON crm_activity (action, created_at DESC)`);

  /* Reply notifications for CRM-originated threads only.

     A row exists here only because a message we sent was replied to: the
     link is the message_id we generated, so a mailbox message that does not
     answer a CRM email can never produce one. Snippet is a short preview for
     the bell; the full body stays in communications, and neither body nor
     subject is copied into crm_activity. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_replies (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      contact_id INTEGER,
      company_id INTEGER,
      thread_id TEXT,
      in_reply_to TEXT,             -- the CRM message_id being answered
      reply_message_id TEXT UNIQUE, -- provider id, so a re-poll cannot duplicate
      from_email TEXT,
      from_name TEXT,
      snippet TEXT,                 -- short preview only
      received_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_replies_unread ON email_replies (user_id, read_at, received_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_replies_thread ON email_replies (thread_id)`);

  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_source text`);
  /* Backfill once, from the contact source, for rows written before this
     column existed. Apollo rows get 'apollo_legacy' rather than a guess:
     search-supplied and reveal-supplied addresses are indistinguishable
     after the fact, and inventing the difference would put a wrong number
     in a credit-usage report. */
  await pool.query(`
    UPDATE contacts SET email_source = CASE
        WHEN email IS NULL OR TRIM(email) = '' THEN 'none'
        WHEN source = 'business_card' THEN 'business_card'
        WHEN source = 'manual'        THEN 'manual'
        WHEN source = 'email_import'  THEN 'email_import'
        WHEN source = 'battery_show'  THEN 'battery_show'
        WHEN source = 'apollo'        THEN 'apollo_legacy'
        ELSE 'legacy'
      END
    WHERE email_source IS NULL`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_source ON contacts (source)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_follow_up_status ON contacts (follow_up_status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_company_lower ON contacts (LOWER(company))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts (company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_last_contacted ON contacts (last_contacted_at)`);
  /* Prefix/contains matching on names and email needs trigram support;
     pg_trgm is available on Neon. Skipped silently where it is not — the
     filters still work, just without the index. */
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_full_name_trgm ON contacts USING gin (full_name gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_email_trgm ON contacts USING gin (email gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_company_trgm ON contacts USING gin (company gin_trgm_ops)`);
  } catch (e) {
    console.warn('pg_trgm unavailable, text filters will not use an index:', e.message);
  }
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

  /* These index and column statements used to sit ~100 lines earlier, before
     communications, contact_activity and email_drafts were created. Against an
     existing database that was invisible — the tables were already there — but
     it meant initDb() could not build a database from nothing, which is exactly
     what a test database is. Moved here, next to the table they describe. */
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_comm_contact ON communications (contact_id)`);

  /* Attribution for sends. communications recorded which mailbox sent a
     message but not which CRM user asked for it, so "emails sent per user"
     was not answerable. */
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS user_id TEXT`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS thread_id TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_comm_thread ON communications (thread_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_comm_user_sent ON communications (user_id, sent_at DESC)`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contact_activity_contact_type ON contact_activity (contact_id, activity_type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_drafts_contact ON email_drafts (contact_id)`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS extra_instructions TEXT`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS cc TEXT`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS bcc TEXT`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS notes TEXT`);
  // Which generation options (length/tone/language/CTA) produced this draft.
  // Stored so a saved draft is only reused when the request asks for the same
  // ones -- reusing a 400-word formal draft for a 60-word direct request would
  // silently ignore what the user chose. Empty string = the defaults, which is
  // what every draft written before this column existed effectively used.
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS draft_options TEXT`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS parent_email_id INTEGER REFERENCES communications(id)`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS follow_up_sequence_number INTEGER`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  // Send lifecycle + threading (Phase 1 uses delivery_status/message_id/scheduled_at;
  // in_reply_to/references_header are stored now for Phase 2 threading).
  for (const col of [
    `message_id TEXT`, `delivery_status TEXT`, `scheduled_at TIMESTAMPTZ`, `send_error TEXT`,
    `in_reply_to TEXT`, `references_header TEXT`,
  ]) { await pool.query(`ALTER TABLE communications ADD COLUMN IF NOT EXISTS ${col}`); }

  /* Partial on deleted_at, so it has to follow the column that adds it. */
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_comm_contact_type ON communications (contact_id, comm_type) WHERE deleted_at IS NULL`);
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

  // ===========================================================================
  // Customer Intelligence: tag taxonomy + SKQ product-capability matrix
  // ===========================================================================

  // Curated, hierarchical tag taxonomy. tag_categories/tags hold the reference
  // vocabulary (seeded below); company_tags/contact_tags hold per-entity tags,
  // each stamped with a source so AI suggestions never silently overwrite a
  // human-confirmed or manually-entered tag (enforced in the tagging layer).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tag_categories (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      name_en TEXT NOT NULL,
      name_cn TEXT,
      parent_category_key TEXT,
      applies_to TEXT NOT NULL DEFAULT 'company',
      multi_select BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tags (
      id SERIAL PRIMARY KEY,
      category_key TEXT NOT NULL REFERENCES tag_categories(key) ON DELETE CASCADE,
      value TEXT NOT NULL,
      name_en TEXT NOT NULL,
      name_cn TEXT,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(category_key, value)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_tags (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'ai_suggested',
      confidence REAL,
      verification_status TEXT DEFAULT 'unverified',
      confirmed_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_verified_at TIMESTAMPTZ,
      UNIQUE(company_id, tag_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_tags (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'ai_suggested',
      confidence REAL,
      verification_status TEXT DEFAULT 'unverified',
      confirmed_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_verified_at TIMESTAMPTZ,
      UNIQUE(contact_id, tag_id)
    )
  `);

  // SKQ product-capability matrix, imported from 整线蓝本的15个模块分类.xlsx by
  // scripts/import-skq-matrix.js. 15 modules, 10 systems, 93 equipment; each
  // equipment maps to one module + one system + a department. Bilingual names
  // from the sheet are preserved.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS skq_systems (
      id SERIAL PRIMARY KEY,
      system_no INTEGER UNIQUE NOT NULL,
      name_en TEXT,
      name_cn TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS skq_modules (
      id SERIAL PRIMARY KEY,
      module_no INTEGER UNIQUE NOT NULL,
      name_en TEXT,
      name_cn TEXT,
      color_name TEXT,
      color_ral TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS skq_equipment (
      id SERIAL PRIMARY KEY,
      seq_no INTEGER UNIQUE NOT NULL,
      name_en TEXT,
      name_cn TEXT,
      module_id INTEGER REFERENCES skq_modules(id) ON DELETE SET NULL,
      system_id INTEGER REFERENCES skq_systems(id) ON DELETE SET NULL,
      department TEXT
    )
  `);

  // Matching glue + outputs (populated in later phases, tables created now so
  // the schema is complete and stable).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_tag_mappings (
      id SERIAL PRIMARY KEY,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      weight REAL DEFAULT 1.0,
      note TEXT,
      UNIQUE(tag_id, target_type, target_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_recommendations (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      matched_tag_ids INTEGER[],
      reason TEXT,
      confidence TEXT,
      status TEXT NOT NULL DEFAULT 'suggested',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, target_type, target_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS research_sources (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      url TEXT,
      title TEXT,
      snippet TEXT,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attachment_product_mappings (
      id SERIAL PRIMARY KEY,
      library_key TEXT,
      attachment_id INTEGER REFERENCES attachments(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Persistent AI usage log — one row per AI-relevant event (real call OR a
  // reuse/skip). Powers today / month / all-time + per-feature + per-company
  // stats and the "tokens saved" accounting.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_usage_events (
      id SERIAL PRIMARY KEY,
      feature TEXT NOT NULL,
      outcome TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd NUMERIC DEFAULT 0,
      tokens_saved_input INTEGER DEFAULT 0,
      tokens_saved_output INTEGER DEFAULT 0,
      cost_saved_usd NUMERIC DEFAULT 0,
      company_id INTEGER,
      contact_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_events (created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_usage_feature ON ai_usage_events (feature)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_usage_company ON ai_usage_events (company_id)`);
  // Enterprise-grade event detail (added incrementally; all nullable).
  for (const col of [
    `session_id TEXT`, `user_id TEXT`, `sub_feature TEXT`, `thread_id INTEGER`,
    `provider TEXT DEFAULT 'anthropic'`, `cache_read_tokens INTEGER DEFAULT 0`,
    `cache_write_tokens INTEGER DEFAULT 0`, `reasoning_tokens INTEGER DEFAULT 0`,
    `total_tokens INTEGER DEFAULT 0`, `response_ms INTEGER`, `status TEXT DEFAULT 'success'`,
    `error_message TEXT`, `request_type TEXT`, `request_id TEXT`, `currency TEXT DEFAULT 'USD'`,
    /* The provider the user asked for, as opposed to `provider`, which is
       the one that answered. Fallback frequency is not derivable from the
       served provider alone — without this, a draft that quietly fell from
       Qwen to Claude is indistinguishable from one that chose Claude.
       Nullable: research and older events simply leave it empty. */
    `requested_provider TEXT`,
    /* The model asked for, alongside `model` (the one that answered) and
       `requested_provider` (which does not distinguish qwen3.6-flash from
       qwen3.8-max — they are the same provider). Fallback WITHIN a provider is
       invisible without this. */
    `requested_model TEXT`,
    `fell_back BOOLEAN DEFAULT false`,
    /* Whether the price card behind cost_usd is confirmed. Stored per event
       rather than looked up at read time, so a cost computed under an
       estimated rate stays labelled after the rate is confirmed. */
    `cost_estimated BOOLEAN DEFAULT false`,
    /* One turn can be several model calls — tool rounds, and failed attempts
       that were still billed. This holds the per-model parts so cost can be
       attributed to the model that actually spent it. Null for single-call
       features, which are fully described by the columns above. */
    `model_breakdown JSONB`,
  ]) {
    await pool.query(`ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS ${col}`);
  }
  // Idempotency: a non-null request_id may appear at most once (multiple NULLs allowed).
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_request_id ON ai_usage_events (request_id)`);

  /* ── Threaded assistant chat ──────────────────────────────────────────────
     Additive: two new tables and one nullable column elsewhere. Nothing
     existing is altered, so an old build and a new one can serve the same
     database — a request without a thread_id still behaves exactly as it did.

     user_id is present from the first row even though the login gate today
     validates a single shared credential, so every session is the same
     identity. That is deliberate. The scoping is structurally correct now and
     becomes materially correct the day real accounts exist, without a rewrite
     — and the shared identity is itself the marker that separates today's
     workspace threads from tomorrow's personal ones, which is why there is no
     separate visibility column here. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT,
      /* 'user' once someone renames it, so auto-titling never overwrites a
         name a human chose. */
      title_source TEXT,
      summary TEXT,
      summary_upto_message_id BIGINT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      last_message_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ,
      -- Soft, like every other retirement in this schema.
      deleted_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      thread_id BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      /* Denormalised so an authorisation check never has to trust a join.
         A message query filters on user_id in the same statement that finds
         the row, rather than fetching first and checking afterwards. */
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tools_used TEXT[],
      /* Identifiers and display names only — never tool payloads. Enough to
         re-render a company or booth reference by looking it up fresh. */
      entities JSONB,
      page_context JSONB,
      -- Points at ai_usage_events rather than copying any of it.
      usage_event_id BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_threads_user
    ON chat_threads (user_id, archived_at, last_message_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
    ON chat_messages (thread_id, id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_user
    ON chat_messages (user_id, created_at DESC)`);
  /* Search. pg_trgm is created earlier in initDb where available and skipped
     silently where it is not, so both indexes are attempted the same way:
     without them search still works, just without an index behind it. */
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_threads_title_trgm
      ON chat_threads USING GIN (title gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_content_trgm
      ON chat_messages USING GIN (content gin_trgm_ops)`);
  } catch (e) {
    console.warn('chat search indexes skipped (pg_trgm unavailable):', e.message);
  }

  /* Ties a usage event to the conversation that caused it, so cost, tokens,
     model, fallback and latency can be totalled per thread. Nullable, and
     written only by the chat route — email_draft and account_research rows
     keep leaving it NULL and their analytics are untouched. */
  await pool.query(`ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS thread_id BIGINT`);
  /* The column already exists on deployed databases, declared INTEGER by an
     earlier migration and never written to by anything. ADD COLUMN IF NOT
     EXISTS therefore does nothing there, and the code would go on claiming
     BIGINT while the table said INTEGER — the sort of quiet disagreement that
     is discovered years later by a value that does not fit.
     Widened explicitly. INTEGER to BIGINT loses nothing, and the check keeps
     it a no-op everywhere it has already been done. */
  const [threadCol] = await q(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = 'ai_usage_events' AND column_name = 'thread_id'`);
  if (threadCol && threadCol.data_type === 'integer') {
    await pool.query(`ALTER TABLE ai_usage_events ALTER COLUMN thread_id TYPE BIGINT`);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_usage_thread
    ON ai_usage_events (thread_id) WHERE thread_id IS NOT NULL`);

  // Model pricing table — cost is computed from the price ACTIVE at request time
  // and the resulting cost_usd is stored on each event (preserved if prices change).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_model_pricing (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_price_per_m NUMERIC NOT NULL,
      output_price_per_m NUMERIC NOT NULL,
      cache_read_price_per_m NUMERIC DEFAULT 0,
      cache_write_price_per_m NUMERIC DEFAULT 0,
      reasoning_price_per_m NUMERIC DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      effective_start DATE DEFAULT CURRENT_DATE,
      effective_end DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_pricing_model ON ai_model_pricing (provider, model, effective_start)`);
  /* Marks a rate we have not yet seen on an invoice. Default false so every
     existing row keeps its current meaning: the vendor price lists behind the
     Claude and GPT rows were confirmed when they were seeded. */
  await pool.query(`ALTER TABLE ai_model_pricing ADD COLUMN IF NOT EXISTS is_estimated BOOLEAN DEFAULT false`);
  await seedAiModelPricing();

  // Strategic category carried over from the booth map (available / competitor /
  // customer / batmat / …), so the CRM can filter by the same buckets the floor
  // plan uses. Backfilled by scripts/backfill_booth_categories.js.
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS booth_category TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_companies_booth_category ON companies(booth_category)`);
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS ai_research_summary TEXT`);
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS intelligence_reviewed_at TIMESTAMPTZ`);
  // Distinct from intelligence_reviewed_at (human review): when the AI last ran.
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS ai_analyzed_at TIMESTAMPTZ`);
  // Per-tag "last updated" (AI confidence refresh or human decision).
  await pool.query(`ALTER TABLE company_tags ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`ALTER TABLE contact_tags ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // Bilingual (and future multilingual) tag metadata. name_en/name_cn are the
  // two primary display languages; `translations` JSONB holds any additional
  // language ({ "ja": {"name":...,"description":...} }) so new languages need
  // NO schema change. The AI always receives the English `value`, never these.
  await pool.query(`ALTER TABLE tags ADD COLUMN IF NOT EXISTS description_en TEXT`);
  await pool.query(`ALTER TABLE tags ADD COLUMN IF NOT EXISTS description_cn TEXT`);
  await pool.query(`ALTER TABLE tags ADD COLUMN IF NOT EXISTS translations JSONB`);
  await pool.query(`ALTER TABLE tag_categories ADD COLUMN IF NOT EXISTS description_en TEXT`);
  await pool.query(`ALTER TABLE tag_categories ADD COLUMN IF NOT EXISTS description_cn TEXT`);
  await pool.query(`ALTER TABLE tag_categories ADD COLUMN IF NOT EXISTS translations JSONB`);

  // ── Email configuration (org-level shared infra + per-user mailbox/prefs) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_org_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      allowed_domain TEXT DEFAULT 'skeqi.com',
      provider_name TEXT, provider_type TEXT,
      smtp_host TEXT, smtp_port INTEGER, smtp_encryption TEXT DEFAULT 'starttls', smtp_auth_method TEXT DEFAULT 'password',
      imap_host TEXT, imap_port INTEGER, imap_encryption TEXT DEFAULT 'ssl', imap_auth_method TEXT DEFAULT 'password',
      inbox_folder TEXT DEFAULT 'INBOX', sent_folder TEXT DEFAULT 'Sent', draft_folder TEXT DEFAULT 'Drafts',
      archive_folder TEXT DEFAULT 'Archive', trash_folder TEXT DEFAULT 'Trash',
      sync_interval_seconds INTEGER DEFAULT 300, imap_idle BOOLEAN DEFAULT FALSE,
      max_attachment_mb INTEGER DEFAULT 25, hourly_send_limit INTEGER DEFAULT 100, daily_send_limit INTEGER DEFAULT 500,
      ip_allowlist_required BOOLEAN DEFAULT FALSE, oauth_available BOOLEAN DEFAULT FALSE, app_password_required BOOLEAN DEFAULT TRUE,
      spf_status TEXT, dkim_status TEXT, dmarc_status TEXT,
      smtp_verified BOOLEAN DEFAULT FALSE, imap_verified BOOLEAN DEFAULT FALSE, integration_enabled BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`INSERT INTO email_org_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  // OAuth connection (the simplified "connect your provider" model).
  for (const col of [
    `oauth_connected BOOLEAN DEFAULT FALSE`, `oauth_email TEXT`, `oauth_display_name TEXT`,
    `oauth_connected_at TIMESTAMPTZ`, `oauth_access_token TEXT`, `oauth_refresh_token TEXT`, `oauth_token_expires TIMESTAMPTZ`,
  ]) {
    await pool.query(`ALTER TABLE email_org_config ADD COLUMN IF NOT EXISTS ${col}`);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_user_account (
      user_id TEXT PRIMARY KEY,
      sender_name TEXT, sender_email TEXT, reply_to TEXT, mailbox_username TEXT,
      auth_method TEXT DEFAULT 'app_password', secret TEXT,
      connection_status TEXT DEFAULT 'disconnected',
      sync_enabled BOOLEAN DEFAULT FALSE, last_sync_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_user_prefs (
      user_id TEXT PRIMARY KEY,
      signature TEXT, default_cc TEXT, default_bcc TEXT, default_reply_to TEXT,
      default_send_mode TEXT DEFAULT 'draft', confirm_before_send BOOLEAN DEFAULT TRUE,
      sync_frequency TEXT DEFAULT 'normal', updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_test_log (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      kind TEXT,          -- 'smtp' | 'imap' | 'domain' | 'mailbox' | 'send'
      scope TEXT,         -- 'org' | 'user'
      target TEXT,        -- host:port or address tested
      ok BOOLEAN,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Server-side tool calls billed on top of tokens (web search: $10 / 1,000).
  await pool.query(`ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS web_search_calls INTEGER DEFAULT 0`);

  // ── Account Intelligence Report generator (ported from Skeqi-AccountResearch) ──
  // Reports were file-based JSON in the standalone app; here they live in
  // Postgres so they survive redeploys and are searchable alongside the CRM.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_reports (
      id TEXT PRIMARY KEY,
      report_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      target TEXT, target_zh TEXT, turl TEXT,
      company_name TEXT, company_name_zh TEXT,
      seller TEXT, surl TEXT,
      report_type TEXT DEFAULT 'Executive Account Plan · 高管账户计划',
      sections JSONB, usage JSONB,
      data JSONB NOT NULL,
      company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_account_reports_key ON account_reports(report_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_account_reports_created ON account_reports(created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_research_cache (
      cache_type TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      data JSONB NOT NULL,
      cost_usd NUMERIC(12,6) DEFAULT 0,
      cached_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (cache_type, cache_key)
    )
  `);

  /* ── Booth map, normalized ───────────────────────────────────────────────
     The Battery Show booth data is curated by hand and has lived as a literal
     array inside public/booth-map/index.html: 1,128 booths with coordinates,
     categories, competitor rationales and target-customer briefs. The map
     renders from that file and continues to — nothing here changes it.

     These tables exist so the data can be *joined*. The interesting questions
     span both halves of SKQ ("which target customers at the show have research
     but no outreach?") and cannot be answered while booths live in a script tag
     and companies live in Postgres. Import is one-way and rerunnable: the
     static file stays the source of truth, this is a synchronized projection
     of it. See scripts/import-booth-map.js.

     company_id is nullable on purpose. 98% of named booths match a company
     confidently; the rest are recorded with the source spelling and no match
     rather than being forced onto a plausible-looking row. A wrong join here
     would put one company's research against another company's booth. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booth_map_booths (
      id SERIAL PRIMARY KEY,
      -- Explicit, so editions of the show coexist instead of overwriting.
      event_id INTEGER NOT NULL REFERENCES events(id),
      booth_number TEXT NOT NULL,
      -- The company as the SOURCE spells it, kept verbatim for provenance:
      -- this is what a later sync diffs against, and what a human reads when
      -- deciding whether an unmatched booth is really a new company.
      source_company_name TEXT,
      source_company_name_zh TEXT,
      -- companyKey.normalizeNameKey(source_company_name); the tier-2 join.
      name_key TEXT,
      -- NULL means "not confidently matched", never "no company".
      company_id INTEGER REFERENCES companies(id),
      match_method TEXT,          -- name_exact | name_key | booth_number | none
      match_confidence TEXT,      -- confident | ambiguous | unmatched
      match_note TEXT,            -- candidate ids when ambiguous
      category TEXT,              -- the map's own taxonomy: customer, batmat, …
      status TEXT,                -- Reserved / Available as the source states
      x INTEGER,
      y INTEGER,
      dims TEXT,
      edition TEXT,
      intro TEXT,
      -- Anything the source carries that is not modelled above, so a new field
      -- upstream is preserved rather than dropped until someone adds a column.
      data JSONB,
      source_version TEXT,        -- sha256 of the parsed source arrays
      first_imported_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      -- Gone from the source. Retired, never deleted: a booth that disappears
      -- upstream must not take its history with it.
      retired_at TIMESTAMPTZ,
      UNIQUE (event_id, booth_number)
    )
  `);
  // The columns the assistant filters on, and the ones a sync scans.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bmb_event ON booth_map_booths (event_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bmb_company ON booth_map_booths (company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bmb_booth ON booth_map_booths (booth_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bmb_category ON booth_map_booths (category)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bmb_status ON booth_map_booths (status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bmb_retired ON booth_map_booths (retired_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bmb_name_key ON booth_map_booths (name_key)`);
  /* "Live booths in this category" is the shape of nearly every question the
     assistant will ask, and it is the one worth a composite. */
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_bmb_live ON booth_map_booths (event_id, category) WHERE retired_at IS NULL`);

  /* The curated overlays. Five separate structures in the source file
     (DIRECT_COMP, INDIRECT_COMP, ESS_EV, COMPANY_DB, CN_COMPANIES,
     AVAILABLE_RANKED) describing the same booths from different angles, so
     they are one table keyed by kind rather than five sparse column groups on
     the booth row. A booth can be both a target customer and an ESS/EV project;
     the unique key is (booth_id, kind), not booth_id. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booth_intel (
      id SERIAL PRIMARY KEY,
      booth_id INTEGER NOT NULL REFERENCES booth_map_booths(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      -- Why this classification was made. The sales-facing value of the whole
      -- dataset is in these sentences, not in the labels.
      reason TEXT,
      priority INTEGER,
      priority_label TEXT,
      background TEXT,
      segments JSONB,
      projects JSONB,
      role TEXT,                  -- CN_COMPANIES: direct_customer | competitor
      -- AVAILABLE_RANKED scoring, modelled because "best free booth" is a
      -- question worth answering with an ORDER BY rather than in the model.
      score NUMERIC(4,2),
      grade TEXT,
      badge TEXT,
      traffic_score NUMERIC(4,2),
      anchor_score NUMERIC(4,2),
      visibility_score NUMERIC(4,2),
      skeqi_relevance NUMERIC(4,2),
      analysis TEXT,
      data JSONB,
      source_version TEXT,
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      retired_at TIMESTAMPTZ,
      UNIQUE (booth_id, kind)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bintel_booth ON booth_intel (booth_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bintel_kind ON booth_intel (kind)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bintel_live ON booth_intel (kind) WHERE retired_at IS NULL`);

  /* ── Exhibitors, as a thing distinct from booths ──────────────────────────
     Attendance and booth assignment were the same fact here, and they are not
     the same fact. A booth row was the only evidence that a company was at the
     show, so "no booth" and "not attending" were indistinguishable — the
     assistant answered that CATL was not attending because it could not find a
     booth, which is a different claim from the one the data supported.

     Three separable things, and they change independently:

       attendance      is this company an exhibitor?      (MapYourShow)
       booth           where are they standing?           (MapYourShow + map)
       classification  what do WE think of them?          (curated by us)

     A company can be listed with no booth yet, listed and assigned, listed and
     later moved, or gone from the list entirely. All four are now expressible.

     exhibitor_source_id is MapYourShow's own exhid, and storing it is the
     point: the old snapshot kept only a name, so a company that renamed itself
     was indistinguishable from one company leaving and another arriving. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_exhibitors (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id),
      -- The stable external key. Never generated here, never reused.
      exhibitor_source_id TEXT NOT NULL,
      -- Verbatim from the source, so a rename is visible as a rename.
      source_name TEXT NOT NULL,
      name_key TEXT,
      -- NULL means "not confidently matched", never "no company".
      company_id INTEGER REFERENCES companies(id),
      match_method TEXT,
      match_confidence TEXT,
      match_note TEXT,
      /* listed  — present in the most recent authoritative pull
         retired — was present before, absent now. NOT deleted: a company that
                   withdraws is still a company we may have emailed about the
                   show, and the record of having listed them is history. */
      attendance_status TEXT NOT NULL DEFAULT 'listed',
      hall TEXT,
      source TEXT NOT NULL DEFAULT 'mapyourshow',
      source_version TEXT,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      -- What "as of" means when the assistant quotes attendance.
      last_verified_at TIMESTAMPTZ DEFAULT NOW(),
      retired_at TIMESTAMPTZ,
      UNIQUE (event_id, exhibitor_source_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_exh_event ON event_exhibitors (event_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_exh_company ON event_exhibitors (company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_exh_name_key ON event_exhibitors (name_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_exh_status ON event_exhibitors (attendance_status)`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_exh_listed ON event_exhibitors (event_id) WHERE attendance_status = 'listed'`);

  /* The booth numbers the authoritative source currently gives an exhibitor.
     Separate from booth_map_booths, which holds the floor-plan geometry and
     our own categories: one is "where the organiser says they are", the other
     is "what our map draws". Keeping them apart is what lets the assistant say
     "listed, but we have no booth for them" without inventing either half. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exhibitor_booths (
      id SERIAL PRIMARY KEY,
      exhibitor_id INTEGER NOT NULL REFERENCES event_exhibitors(id) ON DELETE CASCADE,
      booth_number TEXT NOT NULL,
      hall TEXT,
      source_version TEXT,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_verified_at TIMESTAMPTZ DEFAULT NOW(),
      -- A booth an exhibitor no longer holds is retired, not deleted: it may
      -- be the booth quoted in an email somebody already sent.
      retired_at TIMESTAMPTZ,
      UNIQUE (exhibitor_id, booth_number)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_exhbooth_number ON exhibitor_booths (booth_number)`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_exhbooth_live ON exhibitor_booths (exhibitor_id) WHERE retired_at IS NULL`);

  /* The map's booth rows learn which exhibitor they belong to, and whether the
     authoritative source still agrees that this company is standing there.
     Added rather than replaced: the geometry, categories and curated prose in
     booth_map_booths are still the only copy of that work. */
  await pool.query(`ALTER TABLE booth_map_booths ADD COLUMN IF NOT EXISTS exhibitor_id INTEGER REFERENCES event_exhibitors(id)`);
  /* current      — the source agrees this company is at this booth
     reassigned   — the source puts a DIFFERENT company here now
     vacated      — the booth is no longer in the source's floor plan
     unverified   — not yet checked against a pull */
  await pool.query(`ALTER TABLE booth_map_booths ADD COLUMN IF NOT EXISTS occupant_status TEXT DEFAULT 'unverified'`);
  await pool.query(`ALTER TABLE booth_map_booths ADD COLUMN IF NOT EXISTS occupant_checked_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE booth_map_booths ADD COLUMN IF NOT EXISTS live_occupant_name TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bmb_exhibitor ON booth_map_booths (exhibitor_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bmb_occupant ON booth_map_booths (occupant_status)`);

  /* Curated intelligence belongs to a COMPANY, not to a square of carpet.
     Somebody decided Comau is a direct competitor; they did not decide that
     booth 3626 is. When the organiser gives 3626 to INTECELLS, inheriting the
     classification would silently label an unrelated company a competitor —
     so these columns carry the judgement to the exhibitor, and anything that
     can no longer be placed confidently goes to review rather than being
     guessed at. */
  await pool.query(`ALTER TABLE booth_intel ADD COLUMN IF NOT EXISTS exhibitor_id INTEGER REFERENCES event_exhibitors(id)`);
  await pool.query(`ALTER TABLE booth_intel ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
  await pool.query(`ALTER TABLE booth_intel ADD COLUMN IF NOT EXISTS subject_name TEXT`);
  /* ok           — the classification still points at the company it was made about
     needs_review — the booth changed hands, or the company left the show
     A human decides; nothing here moves a judgement on its own. */
  await pool.query(`ALTER TABLE booth_intel ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'ok'`);
  await pool.query(`ALTER TABLE booth_intel ADD COLUMN IF NOT EXISTS review_reason TEXT`);
  await pool.query(`ALTER TABLE booth_intel ADD COLUMN IF NOT EXISTS review_flagged_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bintel_exhibitor ON booth_intel (exhibitor_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bintel_review ON booth_intel (review_status) WHERE review_status <> 'ok'`);

  /* One row per exhibitor refresh. The counts are what make a rerun legible,
     and `aborted` is what makes an expired cookie visible instead of looking
     like nine hundred companies withdrawing overnight. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exhibitor_import_runs (
      id SERIAL PRIMARY KEY,
      event_id INTEGER REFERENCES events(id),
      source TEXT NOT NULL DEFAULT 'mapyourshow',
      source_version TEXT,
      dry_run BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending',
      fetched INTEGER DEFAULT 0,
      created INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0,
      unchanged INTEGER DEFAULT 0,
      retired INTEGER DEFAULT 0,
      revived INTEGER DEFAULT 0,
      booths_added INTEGER DEFAULT 0,
      booths_retired INTEGER DEFAULT 0,
      matched INTEGER DEFAULT 0,
      unmatched INTEGER DEFAULT 0,
      ambiguous INTEGER DEFAULT 0,
      intel_flagged INTEGER DEFAULT 0,
      warnings JSONB,
      error_message TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_eir_started ON exhibitor_import_runs (started_at DESC)`);

  /* One row per import. Without this, "is the booth data current?" is only
     answerable by reading rows and guessing, and a partial or failed sync
     leaves no trace at all. Counts are what make a rerun's effect legible. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booth_import_runs (
      id SERIAL PRIMARY KEY,
      event_id INTEGER REFERENCES events(id),
      source_version TEXT,
      source_path TEXT,
      dry_run BOOLEAN NOT NULL DEFAULT FALSE,
      -- pending → success | failed. A row left 'pending' means the process
      -- died mid-import, which is itself worth being able to see.
      status TEXT NOT NULL DEFAULT 'pending',
      booths_seen INTEGER DEFAULT 0,
      created INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0,
      unchanged INTEGER DEFAULT 0,
      retired INTEGER DEFAULT 0,
      intel_upserted INTEGER DEFAULT 0,
      matched INTEGER DEFAULT 0,
      unmatched INTEGER DEFAULT 0,
      ambiguous INTEGER DEFAULT 0,
      -- Non-fatal things a human should look at: a booth whose name matches two
      -- companies, an overlay pointing at a booth number that no longer exists.
      warnings JSONB,
      error_message TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bir_started ON booth_import_runs (started_at DESC)`);

  await seedTagTaxonomy();
  await seedSkqSystems();
}

// ===========================================================================
// Customer Intelligence: tag taxonomy + SKQ matrix (seed + CRUD)
// ===========================================================================

// Curated tag taxonomy. Categories are hierarchical: parent_category_key gates
// display (e.g. the application categories only apply once a Segment is set).
// Each tag is [english_value, chinese_name]. The english value is the
// language-independent canonical (also what the AI receives); chinese is display.
const TAG_TAXONOMY = [
  { key: 'segment', name_en: 'Segment', name_cn: '业务板块', parent: null, applies_to: 'company',
    tags: [['Energy Storage', '储能'], ['Power Battery', '动力电池']] },
  { key: 'energy_storage_app', name_en: 'Energy Storage Application', name_cn: '储能应用', parent: 'segment', applies_to: 'company',
    tags: [['Residential ESS', '户用储能'], ['Commercial & Industrial ESS', '工商业储能'], ['Utility ESS', '电网储能']] },
  { key: 'power_battery_app', name_en: 'Power Battery Application', name_cn: '动力电池应用', parent: 'segment', applies_to: 'company',
    tags: [['Passenger EV', '乘用车'], ['Commercial Vehicle', '商用车'], ['Special Vehicle', '特种车辆'], ['Light Vehicle', '轻型车'], ['Power Tools', '电动工具']] },
  { key: 'cell_format', name_en: 'Cell Format', name_cn: '电芯形态', parent: null, applies_to: 'company',
    tags: [['Prismatic', '方形'], ['Cylindrical', '圆柱'], ['Pouch', '软包']] },
  { key: 'product_scope', name_en: 'Customer Product Scope', name_cn: '产品范围', parent: null, applies_to: 'company',
    tags: [['Cell', '电芯'], ['Module', '模组'], ['PACK', 'PACK'], ['Energy Storage System', '储能系统'],
           ['Battery Production Line', '电池产线'], ['Laser Welding', '激光焊接'], ['Resistance Welding', '电阻焊'],
           ['Vision Inspection', '视觉检测'], ['Intelligent Logistics', '智能物流'], ['Smart Factory', '智能工厂'],
           ['Automation', '自动化']] },
  { key: 'contact_role', name_en: 'Contact Role', name_cn: '联系人角色', parent: null, applies_to: 'contact',
    tags: [['Executive Decision Maker', '高层决策者'], ['R&D', '研发'], ['Engineering', '工程'], ['Manufacturing', '制造'],
           ['Automation', '自动化'], ['Purchasing', '采购'], ['Quality', '质量'], ['Operations', '运营'],
           ['Supply Chain', '供应链'], ['IT or Digital Transformation', 'IT/数字化转型']] },
  { key: 'customer_priority', name_en: 'Customer Priorities', name_cn: '客户优先事项', parent: null, applies_to: 'company',
    tags: [['Cost Reduction', '降本'], ['Capacity Expansion', '产能扩张'], ['Throughput', '生产节拍'], ['Yield Improvement', '良率提升'],
           ['Quality', '质量'], ['Traceability', '追溯'], ['Automation', '自动化'], ['Labor Reduction', '减少人工'],
           ['Flexible Manufacturing', '柔性制造'], ['Digitalization', '数字化'], ['Faster Commissioning', '快速调试']] },
];

// The 10 SKQ systems ("十大体系"). English names are canonical (the sheet only
// carries the Chinese name + a leading number); the importer links equipment to
// these by that number.
const SKQ_SYSTEMS = [
  { system_no: 1, name_en: 'Pick-and-Place Platform Equipment', name_cn: '取放平台设备' },
  { system_no: 2, name_en: 'Material Handling Equipment', name_cn: '拿取搬运设备' },
  { system_no: 3, name_en: 'Carrier Conveyance Equipment', name_cn: '载具输送设备' },
  { system_no: 4, name_en: 'Cleaning Equipment', name_cn: '清洁清洗设备' },
  { system_no: 5, name_en: 'Connection Process Equipment', name_cn: '连接工艺设备' },
  { system_no: 6, name_en: 'Inspection and Testing Equipment', name_cn: '检测检验设备' },
  { system_no: 7, name_en: 'Stacking and Assembly Equipment', name_cn: '堆叠合装设备' },
  { system_no: 8, name_en: 'Functional Standalone Equipment', name_cn: '功能单机设备' },
  { system_no: 9, name_en: 'Manual Workstations', name_cn: '人工工位' },
  { system_no: 10, name_en: 'Other Equipment', name_cn: '其他' },
];

// Idempotent: safe to run on every startup. Keeps names in sync but never
// removes categories/tags (so any that later carry live company_tags survive).
async function seedTagTaxonomy() {
  for (let ci = 0; ci < TAG_TAXONOMY.length; ci++) {
    const cat = TAG_TAXONOMY[ci];
    await q(`
      INSERT INTO tag_categories (key, name_en, name_cn, parent_category_key, applies_to, multi_select, sort_order)
      VALUES ($1, $2, $3, $4, $5, TRUE, $6)
      ON CONFLICT (key) DO UPDATE SET
        name_en = EXCLUDED.name_en,
        name_cn = EXCLUDED.name_cn,
        parent_category_key = EXCLUDED.parent_category_key,
        applies_to = EXCLUDED.applies_to,
        sort_order = EXCLUDED.sort_order
    `, [cat.key, cat.name_en, cat.name_cn || null, cat.parent, cat.applies_to, ci]);
    for (let ti = 0; ti < cat.tags.length; ti++) {
      const [value, cn] = cat.tags[ti];
      await q(`
        INSERT INTO tags (category_key, value, name_en, name_cn, sort_order)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (category_key, value) DO UPDATE SET
          name_en = EXCLUDED.name_en, name_cn = EXCLUDED.name_cn, sort_order = EXCLUDED.sort_order
      `, [cat.key, value, value, cn || null, ti]);
    }
  }
}

async function seedSkqSystems() {
  for (const s of SKQ_SYSTEMS) {
    await q(`
      INSERT INTO skq_systems (system_no, name_en, name_cn)
      VALUES ($1, $2, $3)
      ON CONFLICT (system_no) DO UPDATE SET
        name_en = EXCLUDED.name_en, name_cn = EXCLUDED.name_cn
    `, [s.system_no, s.name_en, s.name_cn]);
  }
}

// Full taxonomy (categories with their tags nested) for the tag-picker UI.
async function getTaxonomy() {
  const categories = await q(`SELECT * FROM tag_categories ORDER BY sort_order, id`);
  const tags = await q(`SELECT * FROM tags ORDER BY category_key, sort_order, id`);
  return categories.map((c) => ({
    ...c,
    tags: tags.filter((t) => t.category_key === c.key),
  }));
}

async function listTagCategories() {
  return q(`SELECT * FROM tag_categories ORDER BY sort_order, id`);
}

async function listTags() {
  return q(`SELECT * FROM tags ORDER BY category_key, sort_order, id`);
}

// --- SKQ matrix upserts (used by scripts/import-skq-matrix.js) ---------------
// COALESCE-on-conflict so re-importing never blanks a field the sheet left empty.

async function upsertSkqModule({ module_no, name_en, name_cn, color_name, color_ral }) {
  return q1(`
    INSERT INTO skq_modules (module_no, name_en, name_cn, color_name, color_ral)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (module_no) DO UPDATE SET
      name_en = COALESCE(EXCLUDED.name_en, skq_modules.name_en),
      name_cn = COALESCE(EXCLUDED.name_cn, skq_modules.name_cn),
      color_name = COALESCE(EXCLUDED.color_name, skq_modules.color_name),
      color_ral = COALESCE(EXCLUDED.color_ral, skq_modules.color_ral)
    RETURNING *
  `, [module_no, name_en || null, name_cn || null, color_name || null, color_ral || null]);
}

async function upsertSkqSystem({ system_no, name_en, name_cn }) {
  return q1(`
    INSERT INTO skq_systems (system_no, name_en, name_cn)
    VALUES ($1, $2, $3)
    ON CONFLICT (system_no) DO UPDATE SET
      name_en = COALESCE(EXCLUDED.name_en, skq_systems.name_en),
      name_cn = COALESCE(EXCLUDED.name_cn, skq_systems.name_cn)
    RETURNING *
  `, [system_no, name_en || null, name_cn || null]);
}

async function upsertSkqEquipment({ seq_no, name_en, name_cn, module_no, system_no, department }) {
  return q1(`
    INSERT INTO skq_equipment (seq_no, name_en, name_cn, module_id, system_id, department)
    VALUES ($1, $2, $3,
            (SELECT id FROM skq_modules WHERE module_no = $4),
            (SELECT id FROM skq_systems WHERE system_no = $5),
            $6)
    ON CONFLICT (seq_no) DO UPDATE SET
      name_en = COALESCE(EXCLUDED.name_en, skq_equipment.name_en),
      name_cn = COALESCE(EXCLUDED.name_cn, skq_equipment.name_cn),
      module_id = COALESCE(EXCLUDED.module_id, skq_equipment.module_id),
      system_id = COALESCE(EXCLUDED.system_id, skq_equipment.system_id),
      department = COALESCE(EXCLUDED.department, skq_equipment.department)
    RETURNING *
  `, [seq_no, name_en || null, name_cn || null, module_no || null, system_no || null, department || null]);
}

async function listSkqModules() {
  return q(`SELECT * FROM skq_modules ORDER BY module_no`);
}

async function listSkqSystems() {
  return q(`SELECT * FROM skq_systems ORDER BY system_no`);
}

async function listSkqEquipment() {
  return q(`
    SELECT e.*,
           m.module_no, m.name_en AS module_name_en, m.name_cn AS module_name_cn,
           s.system_no, s.name_en AS system_name_en, s.name_cn AS system_name_cn
    FROM skq_equipment e
    LEFT JOIN skq_modules m ON m.id = e.module_id
    LEFT JOIN skq_systems s ON s.id = e.system_id
    ORDER BY e.seq_no
  `);
}

// Effective status of a tag from its source + confidence. AI tags are USABLE by
// default (confirmation is refinement, not a gate): >=0.9 → confirmed-grade,
// >=0.7 → suggested, <0.7 → needs review (excluded by default, user can include).
function tagTier(source, confidence) {
  if (source === 'user_confirmed') return { tier: 'confirmed', label: 'Confirmed', used: true };
  if (source === 'manual') return { tier: 'manual', label: 'Manual', used: true };
  if (source === 'rejected') return { tier: 'rejected', label: 'Rejected', used: false };
  if (source === 'needs_review') return { tier: 'needs_review', label: 'Needs review', used: false };
  // ai_suggested (or anything else): confidence-tiered. Null confidence → treat as suggested.
  const c = confidence == null ? 0.8 : Number(confidence);
  if (c >= 0.9) return { tier: 'ai_confirmed', label: 'Confirmed (AI)', used: true };
  if (c >= 0.7) return { tier: 'ai_suggested', label: 'AI Suggested', used: true };
  return { tier: 'needs_review', label: 'Needs review', used: false };
}

// Deterministic tag → SKQ module mapping (NO AI). Maps customer tag values to
// keywords matched against skq_modules names, so email/product grounding pulls
// only relevant SKQ capabilities from the DB.
const TAG_TO_SKQ_KEYWORDS = {
  'Laser Welding': ['Welding'],
  'Resistance Welding': ['Welding', 'riveting'],
  'Vision Inspection': ['Visual'],
  'Cell': ['Loading', 'Electrical performance', 'Air tightness'],
  'Module': ['Stacking', 'Restrictive', 'Tightening'],
  'PACK': ['Stacking', 'Restrictive', 'Tightening', 'Welding'],
  'Energy Storage System': ['Stacking', 'Tightening', 'Air tightness'],
  'Battery Production Line': ['Loading', 'Stacking', 'Welding', 'Visual'],
  'Smart Factory': ['Manual workstation', 'ODM', 'Internal supplier'],
  'Automation': ['载具输送', 'Manual workstation'],
  'Intelligent Logistics': ['载具输送'],
  'Prismatic': ['Stacking', 'Welding', 'Restrictive'],
  'Cylindrical': ['Welding'],
  'Pouch': ['Stacking', 'Taping'],
  'Utility ESS': ['Stacking', 'Tightening'],
  'Passenger EV': ['Welding', 'Stacking'],
};

async function matchSkqForTags(values) {
  const kws = new Set();
  (values || []).forEach((v) => (TAG_TO_SKQ_KEYWORDS[v] || []).forEach((k) => kws.add(k)));
  if (!kws.size) return [];
  const arr = [...kws];
  const clauses = arr.map((_, i) => `name_en ILIKE $${i + 1} OR name_cn ILIKE $${i + 1}`).join(' OR ');
  const params = arr.map((k) => `%${k}%`);
  return q(`SELECT DISTINCT module_no, COALESCE(NULLIF(name_en,''), name_cn) AS name_en, name_cn FROM skq_modules WHERE ${clauses} ORDER BY module_no`, params);
}

// --- Company / contact tags --------------------------------------------------
// A human-reviewed tag must never be silently overwritten by AI. These sources
// are protected: an AI suggestion for the same (entity, tag) is a no-op.
// (Mirrored by the ON CONFLICT ... WHERE guards below — keep them in sync.)
const PROTECTED_TAG_SOURCES = ['user_confirmed', 'manual', 'rejected'];

// Pure mirror of the SQL guard, exported for unit testing.
function shouldReplaceWithSuggestion(existingSource) {
  return !existingSource || !PROTECTED_TAG_SOURCES.includes(existingSource);
}

async function tagIdFor(categoryKey, value) {
  const row = await q1(`SELECT id FROM tags WHERE category_key = $1 AND value = $2`, [categoryKey, value]);
  return row ? row.id : null;
}

// Bilingual resolver: match a tag within a category by its English value/name OR
// its Chinese name (so "方形" and "Prismatic" both resolve to the same tag).
async function resolveTagId(categoryKey, text) {
  if (!text) return null;
  const row = await q1(`
    SELECT id FROM tags
    WHERE category_key = $1
      AND (LOWER(value) = LOWER($2) OR LOWER(name_en) = LOWER($2) OR name_cn = $2)
    LIMIT 1
  `, [categoryKey, String(text).trim()]);
  return row ? row.id : null;
}

async function listCompanyTags(companyId) {
  return q(`
    SELECT ct.id, ct.tag_id, ct.source, ct.confidence, ct.verification_status,
           ct.confirmed_by, ct.created_at, ct.last_verified_at,
           t.category_key, t.value, t.name_en AS tag_name_en, t.name_cn AS tag_name_cn, t.sort_order AS tag_sort,
           tc.name_en AS category_name_en, tc.name_cn AS category_name_cn, tc.sort_order AS category_sort
    FROM company_tags ct
    JOIN tags t ON t.id = ct.tag_id
    JOIN tag_categories tc ON tc.key = t.category_key
    WHERE ct.company_id = $1
    ORDER BY tc.sort_order, t.sort_order
  `, [companyId]);
}

// Apply AI suggestions WITHOUT overwriting human-reviewed tags. New tags are
// inserted as 'ai_suggested'; existing non-protected rows have only their
// confidence refreshed (source/status untouched); protected rows are skipped.
async function applyCompanyTagSuggestions(companyId, suggestions) {
  let applied = 0;
  let skipped = 0;
  for (const s of suggestions || []) {
    const tagId = await tagIdFor(s.category_key, s.value);
    if (!tagId) { skipped++; continue; }
    const res = await pool.query(`
      INSERT INTO company_tags (company_id, tag_id, source, confidence, verification_status)
      VALUES ($1, $2, 'ai_suggested', $3, 'unverified')
      ON CONFLICT (company_id, tag_id) DO UPDATE SET confidence = EXCLUDED.confidence, updated_at = NOW()
      WHERE company_tags.source NOT IN ('user_confirmed', 'manual', 'rejected')
      RETURNING id
    `, [companyId, tagId, s.confidence == null ? null : s.confidence]);
    if (res.rowCount > 0) applied++; else skipped++;
  }
  return { applied, skipped };
}

// Set an explicit human decision on a tag (confirm / reject / manual /
// needs_review). Upserts so it works whether or not the tag already exists.
async function setCompanyTagStatus(companyId, tagId, source, confirmedBy) {
  return q1(`
    INSERT INTO company_tags (company_id, tag_id, source, verification_status, confirmed_by, last_verified_at)
    VALUES ($1, $2, $3, 'verified', $4, NOW())
    ON CONFLICT (company_id, tag_id) DO UPDATE SET
      source = EXCLUDED.source,
      verification_status = 'verified',
      confirmed_by = EXCLUDED.confirmed_by,
      last_verified_at = NOW(),
      updated_at = NOW()
    RETURNING *
  `, [companyId, tagId, source, confirmedBy || null]);
}

async function addManualCompanyTag(companyId, categoryKey, value, confirmedBy) {
  const tagId = await resolveTagId(categoryKey, value);
  if (!tagId) return null;
  return setCompanyTagStatus(companyId, tagId, 'manual', confirmedBy);
}

async function removeCompanyTag(companyId, tagId) {
  await q(`DELETE FROM company_tags WHERE company_id = $1 AND tag_id = $2`, [companyId, tagId]);
}

async function listResearchSources(companyId) {
  return q(`SELECT id, url, title, snippet, fetched_at FROM research_sources WHERE company_id = $1 ORDER BY id`, [companyId]);
}

// How long a saved AI analysis is considered fresh (staleness = DB-first cache
// window). Overridable per-deployment via the settings table key below.
const INTEL_REVIEW_PERIOD_DAYS = 90;

async function getIntelReviewPeriodDays() {
  const raw = await getSetting('intel_review_period_days');
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : INTEL_REVIEW_PERIOD_DAYS;
}

// Store the AI research summary + its cited sources (replacing any prior set),
// and stamp ai_analyzed_at so we know when the AI last ran (for DB-first reuse).
async function setCompanyResearch(companyId, summary, sources) {
  await q(`UPDATE companies SET ai_research_summary = COALESCE($1, ai_research_summary), ai_analyzed_at = NOW(), updated_at = NOW() WHERE id = $2`, [summary || null, companyId]);
  if (Array.isArray(sources) && sources.length) {
    await q(`DELETE FROM research_sources WHERE company_id = $1`, [companyId]);
    for (const src of sources) {
      await q(`INSERT INTO research_sources (company_id, url, title, snippet) VALUES ($1, $2, $3, $4)`,
        [companyId, src.url || null, src.title || null, src.snippet || null]);
    }
  }
}

// Company-scoped tag categories that currently have NO tag for this company —
// so a refresh can ask the AI for ONLY the missing ones (saves tokens).
async function missingCompanyCategories(companyId, taxonomy) {
  const present = await q(
    `SELECT DISTINCT t.category_key FROM company_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.company_id = $1`,
    [companyId]
  );
  const have = new Set(present.map((r) => r.category_key));
  return (taxonomy || [])
    .filter((c) => c.applies_to === 'company' && !have.has(c.key))
    .map((c) => c.key);
}

async function markIntelligenceReviewed(companyId) {
  await q(`UPDATE companies SET intelligence_reviewed_at = NOW() WHERE id = $1`, [companyId]);
}

// Everything the Customer Intelligence panel needs for one company, including
// the analysis freshness so the UI can be DB-first (reuse) vs. offer a refresh.
// Contact coverage for one company: what the Contact Engine has actually
// delivered for this account. Company Intelligence is the hub for an account,
// and "do I have anyone to talk to here yet?" is part of its state — not a
// separate page the user has to go and check.
// Reported at the ACCOUNT level, because that is the unit the Contact Engine
// imports into: /api/leads/search resolves a company name to its account, and
// the import planner counts the same way. Reporting the company row's own
// count as the headline instead would put two different numbers for the same
// thing on one screen ("47 contacts" beside "49 now → 60 target").
// `own_count` is kept so an account spanning several legal-entity rows
// ("Tesla", "Tesla Automation GmbH") can still say so.
async function getCompanyContactStats(companyId, accountId) {
  const scope = accountId
    ? { where: `comp.account_id = $1`, param: accountId }
    : { where: `c.company_id = $1`, param: companyId };

  const [stats, own] = await Promise.all([
    q1(`
      SELECT COUNT(DISTINCT c.id)::int AS count,
             COUNT(DISTINCT c.id) FILTER (WHERE COALESCE(c.email, '') <> '')::int AS with_email,
             MAX(c.created_at) AS last_added_at,
             MAX(c.updated_at) AS last_updated_at
      FROM contacts c JOIN companies comp ON comp.id = c.company_id
      WHERE ${scope.where}
    `, [scope.param]),
    q1(`SELECT COUNT(*)::int AS count FROM contacts WHERE company_id = $1`, [companyId]),
  ]);

  return {
    count: stats ? stats.count : 0,
    with_email: stats ? stats.with_email : 0,
    own_count: own ? own.count : 0,
    last_added_at: stats ? stats.last_added_at : null,
    last_updated_at: stats ? stats.last_updated_at : null,
  };
}

async function getCompanyIntelligence(companyId) {
  const company = await getCompany(companyId);
  if (!company) return null;
  const [tags, sources, reviewDays, contacts] = await Promise.all([
    listCompanyTags(companyId),
    listResearchSources(companyId),
    getIntelReviewPeriodDays(),
    getCompanyContactStats(companyId, company.account_id)
  ]);
  const analyzedAt = company.ai_analyzed_at ? new Date(company.ai_analyzed_at) : null;
  const ageDays = analyzedAt ? (Date.now() - analyzedAt.getTime()) / 86400000 : null;
  // "analyzed" tolerates rows written before ai_analyzed_at existed (have a
  // summary or tags but no timestamp) so they aren't treated as never-analyzed.
  const status = {
    analyzed: Boolean(analyzedAt) || Boolean(company.ai_research_summary) || tags.length > 0,
    analyzed_at: company.ai_analyzed_at || null,
    reviewed_at: company.intelligence_reviewed_at || null,
    review_period_days: reviewDays,
    stale: analyzedAt ? ageDays > reviewDays : false,
    tag_count: tags.length,
    confirmed_count: tags.filter((t) => t.source === 'user_confirmed' || t.source === 'manual').length
  };
  return { company, tags, sources, status, contacts };
}

// Consolidate one company's intelligence into another (for duplicate rows —
// e.g. tags landed on a contactless duplicate). Moves non-colliding tags,
// research summary, and sources into `toId`, then clears them from `fromId`.
// Never touches contacts. Returns a summary of what moved.
async function mergeCompanyIntelligence(fromId, toId) {
  fromId = Number(fromId); toId = Number(toId);
  if (!fromId || !toId || fromId === toId) return { moved_tags: 0 };
  const moved = await q(`
    UPDATE company_tags SET company_id = $2, updated_at = NOW()
    WHERE company_id = $1 AND tag_id NOT IN (SELECT tag_id FROM company_tags WHERE company_id = $2)
    RETURNING id
  `, [fromId, toId]);
  await q(`DELETE FROM company_tags WHERE company_id = $1`, [fromId]);

  const from = await getCompany(fromId);
  const to = await getCompany(toId);
  let movedSummary = false;
  if (from && to) {
    if (!to.ai_research_summary && from.ai_research_summary) {
      await q(`UPDATE companies SET ai_research_summary = $1, ai_analyzed_at = COALESCE(ai_analyzed_at, $2), updated_at = NOW() WHERE id = $3`,
        [from.ai_research_summary, from.ai_analyzed_at, toId]);
      movedSummary = true;
    }
    const toSrc = await q1(`SELECT COUNT(*)::int n FROM research_sources WHERE company_id = $1`, [toId]);
    if (toSrc.n === 0) await q(`UPDATE research_sources SET company_id = $1 WHERE company_id = $2`, [toId, fromId]);
    else await q(`DELETE FROM research_sources WHERE company_id = $1`, [fromId]);
  }
  // The source row is no longer an intelligence "profile".
  await q(`UPDATE companies SET ai_research_summary = NULL, ai_analyzed_at = NULL, intelligence_reviewed_at = NULL WHERE id = $1`, [fromId]);
  return { moved_tags: moved.length, moved_summary: movedSummary, from: fromId, to: toId };
}

// Company rows that share a name_key (likely duplicates), with which one has
// intelligence vs contacts — so the UI can flag "consolidate these".
async function findDuplicateCompanies() {
  return q(`
    SELECT c.id, c.name, c.name_key,
      (SELECT COUNT(*)::int FROM company_tags ct WHERE ct.company_id = c.id) AS tag_count,
      (SELECT COUNT(*)::int FROM contacts co WHERE co.company_id = c.id) AS contact_count
    FROM companies c
    WHERE c.name_key IN (
      SELECT name_key FROM companies WHERE name_key IS NOT NULL GROUP BY name_key HAVING COUNT(*) > 1
    )
    ORDER BY c.name_key, tag_count DESC
  `);
}

// Resolve a contact to its company's saved intelligence + the contact's own
// tags — the bridge the Draft Email modal and generation use. DB-only (no AI).
async function getContactCompanyIntelligence(contactId) {
  const contact = await getContact(contactId);
  if (!contact) return null;
  let company = null;
  if (contact.company_id) company = await getCompany(contact.company_id);
  if (!company && contact.company) company = await findCompanyByName(contact.company);
  const contactTags = await listContactTags(contactId);
  if (!company) {
    return { company: null, tags: [], sources: [], status: { analyzed: false }, contact_tags: contactTags, contact };
  }
  const intel = await getCompanyIntelligence(company.id);
  return { ...intel, contact_tags: contactTags, contact };
}

// Contact tags mirror company tags (used for the Contact Role category).
async function listContactTags(contactId) {
  return q(`
    SELECT ct.id, ct.tag_id, ct.source, ct.confidence, ct.verification_status,
           ct.confirmed_by, ct.created_at, ct.last_verified_at,
           t.category_key, t.value, t.name_en AS tag_name_en, t.name_cn AS tag_name_cn, t.sort_order AS tag_sort,
           tc.name_en AS category_name_en, tc.name_cn AS category_name_cn, tc.sort_order AS category_sort
    FROM contact_tags ct
    JOIN tags t ON t.id = ct.tag_id
    JOIN tag_categories tc ON tc.key = t.category_key
    WHERE ct.contact_id = $1
    ORDER BY tc.sort_order, t.sort_order
  `, [contactId]);
}

async function setContactTagStatus(contactId, tagId, source, confirmedBy) {
  return q1(`
    INSERT INTO contact_tags (contact_id, tag_id, source, verification_status, confirmed_by, last_verified_at)
    VALUES ($1, $2, $3, 'verified', $4, NOW())
    ON CONFLICT (contact_id, tag_id) DO UPDATE SET
      source = EXCLUDED.source,
      verification_status = 'verified',
      confirmed_by = EXCLUDED.confirmed_by,
      last_verified_at = NOW(),
      updated_at = NOW()
    RETURNING *
  `, [contactId, tagId, source, confirmedBy || null]);
}

async function addManualContactTag(contactId, categoryKey, value, confirmedBy) {
  const tagId = await resolveTagId(categoryKey, value);
  if (!tagId) return null;
  return setContactTagStatus(contactId, tagId, 'manual', confirmedBy);
}

async function removeContactTag(contactId, tagId) {
  await q(`DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = $2`, [contactId, tagId]);
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

// Look up an account WITHOUT creating one. The import planner runs on every
// keystroke while the user is still typing a company name — it must never
// leave a trail of empty accounts behind for half-typed words.
async function findAccountByName(name) {
  if (!name || !name.trim()) return null;
  return q1(`SELECT * FROM accounts WHERE LOWER(name) = LOWER($1)`, [name.trim()]);
}

// Contact counts for several accounts in one round trip, keyed by lowercased
// account name. The planner is type-ahead: doing this per company meant a
// separate remote query each, and getAccountContacts() pulls every full
// contact row (including apollo_raw_json) purely to take its length — enough
// latency to make the preview visibly lag behind typing.
// An account with no contacts still appears, with 0; an account that does not
// exist is simply absent, which is how the caller tells "new" from "empty".
async function contactCountsByAccountNames(names) {
  const keys = (names || []).map((n) => String(n || '').trim().toLowerCase()).filter(Boolean);
  if (!keys.length) return {};
  /* Resolve each name against BOTH accounts and companies.

     Matching account names alone reported companies we hold as absent: the
     company "ElringKlinger" is parented to the account "ElringKlinger AG",
     and every picker in the CRM lists company names, so the lookup and the
     thing being looked up disagreed. The join walks a company back to its
     account, then counts across that whole account. */
  const rows = await q(`
    SELECT k.name AS key, COUNT(DISTINCT c.id)::int AS n
    FROM unnest($1::text[]) AS k(name)
    JOIN accounts a
      ON LOWER(a.name) = k.name
      OR a.id = (SELECT comp0.account_id FROM companies comp0
                  WHERE LOWER(comp0.name) = k.name AND comp0.account_id IS NOT NULL
                  LIMIT 1)
    LEFT JOIN companies comp ON comp.account_id = a.id
    LEFT JOIN contacts c ON c.company_id = comp.id
    GROUP BY k.name
  `, [keys]);
  const out = {};
  rows.forEach((r) => { out[r.key] = r.n; });
  return out;
}

// Batched sibling of getCompanySearchCache(), for the same reason.
async function getCompanySearchCaches(cacheKeys) {
  const keys = (cacheKeys || []).filter(Boolean);
  if (!keys.length) return {};
  const rows = await q(`SELECT * FROM company_search_cache WHERE company_key = ANY($1::text[])`, [keys]);
  const out = {};
  rows.forEach((r) => { out[r.company_key] = r; });
  return out;
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

/* Resolve a company by name, EXACT match first.

   name_key is a normalised form ("Kautex Textron GmbH & Co. KG" and
   "Kautex Textron GmbH & Co K.G." both reduce to "kautex textron gmbh co
   kg"), and it is not unique. Matching on it alone could return a sibling
   row, whose name upsertCompany would then overwrite with the name the
   caller passed — colliding with the row that legitimately holds it and
   failing the whole request with:

     duplicate key value violates unique constraint "idx_companies_name_ci"

   That aborted real Apollo searches ("Lead search failed") after the
   credits had already been spent. Preferring an exact case-insensitive
   name match means the row that actually owns the name wins. */
async function findCompanyByName(name) {
  if (!name || !name.trim()) return null;
  const exact = await q1(`SELECT * FROM companies WHERE LOWER(name) = LOWER($1) LIMIT 1`, [name.trim()]);
  if (exact) return exact;
  const key = normalizeNameKey(name);
  if (!key) return null;
  return q1(`SELECT * FROM companies WHERE name_key = $1 ORDER BY id LIMIT 1`, [key]);
}

async function getCompany(id) {
  return q1(`SELECT * FROM companies WHERE id = $1`, [id]);
}

/* Append-only: activity is never updated or deleted, so it can support an
   audit trail later. A logging failure must never break the action it
   records. */
async function logCrmActivity(entry) {
  try {
    await q(`INSERT INTO crm_activity (actor, action, object_type, object_id, company_id, contact_id, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [entry.actor || null, entry.action, entry.objectType || null, entry.objectId != null ? String(entry.objectId) : null,
       entry.companyId || null, entry.contactId || null, entry.metadata ? JSON.stringify(entry.metadata) : null]);
  } catch (e) {
    console.warn('logCrmActivity failed:', e.message);
  }
}

/* Distinct actors seen per period. Derived from the spine, so "active" means
   "did something in the CRM", not "had a session cookie". */
async function activeUsers(days) {
  const rows = await q(`SELECT COUNT(DISTINCT actor)::int AS n FROM crm_activity
                        WHERE actor IS NOT NULL AND created_at > NOW() - ($1 || ' days')::interval`, [String(days)]);
  return rows.length ? rows[0].n : 0;
}

async function listCrmActivity({ actor, action, days = 30, limit = 200 } = {}) {
  const params = [String(days)];
  let where = `WHERE created_at > NOW() - ($1 || ' days')::interval`;
  if (actor)  { params.push(actor);  where += ` AND actor = $${params.length}`; }
  if (action) { params.push(action); where += ` AND action = $${params.length}`; }
  params.push(limit);
  return q(`SELECT * FROM crm_activity ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
}

/* Records a reply to a CRM-sent message. Refuses anything that does not
   answer a message we sent: `inReplyTo` must match a communications
   message_id, which is the technical guarantee that unrelated mailbox
   traffic can never enter the system. Returns null when unmatched. */
async function recordEmailReply(r) {
  /* A forwarded reply may reference the original in In-Reply-To or anywhere
     in References, and clients rewrite these inconsistently. Every candidate
     id is checked, and the first that matches a message WE sent wins. If
     none matches, the mail is not ours and nothing is stored. */
  const candidates = []
    .concat(r.inReplyTo || [], r.references || [])
    .flatMap((v) => String(v || '').split(/\s+/))
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (v.startsWith('<') ? v : `<${v}>`));
  if (!candidates.length) return null;

  const parent = await q1(
    `SELECT id, user_id, contact_id, company_id, thread_id, message_id
     FROM communications
     WHERE message_id = ANY($1::text[]) AND sent_at IS NOT NULL
     ORDER BY sent_at DESC LIMIT 1`, [candidates]);
  if (!parent) return null;                    // not ours — ignore entirely

  const snippet = String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const rows = await q(
    `INSERT INTO email_replies
       (user_id, contact_id, company_id, thread_id, in_reply_to, reply_message_id,
        from_email, from_name, snippet, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, NOW()))
     ON CONFLICT (reply_message_id) DO NOTHING
     RETURNING *`,
    [parent.user_id, parent.contact_id, parent.company_id,
     parent.thread_id || parent.message_id, r.inReplyTo, r.replyMessageId,
     r.fromEmail || '', r.fromName || '', snippet, r.receivedAt || null]);
  if (!rows.length) return { duplicate: true };   // already recorded; a re-delivery, not a stranger

  await q(`UPDATE communications SET replied_at = COALESCE(replied_at, NOW()),
             delivery_status = 'replied' WHERE id = $1`, [parent.id]);
  // Audit entry carries references and counts, never content.
  await logCrmActivity({
    actor: parent.user_id, action: 'email.reply_received',
    objectType: 'email', objectId: parent.message_id,
    companyId: parent.company_id, contactId: parent.contact_id,
    metadata: { thread_id: parent.thread_id || parent.message_id, reply_id: r.replyMessageId },
  });
  return rows[0];
}

async function listEmailReplies({ userId, unreadOnly = false, limit = 20 } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (userId)     { params.push(userId); where += ` AND (user_id = $${params.length} OR user_id IS NULL)`; }
  if (unreadOnly) { where += ' AND read_at IS NULL'; }
  params.push(limit);
  return q(`SELECT r.*, c.full_name AS contact_name, co.name AS company_name
            FROM email_replies r
            LEFT JOIN contacts c  ON c.id = r.contact_id
            LEFT JOIN companies co ON co.id = r.company_id
            ${where} ORDER BY r.received_at DESC LIMIT $${params.length}`, params);
}

async function unreadReplyCount(userId) {
  const row = await q1(
    `SELECT COUNT(*)::int n FROM email_replies
     WHERE read_at IS NULL AND ($1::text IS NULL OR user_id = $1 OR user_id IS NULL)`, [userId || null]);
  return row ? row.n : 0;
}

async function markRepliesRead(ids, userId) {
  const clean = (ids || []).map(Number).filter(Number.isInteger);
  if (!clean.length) return 0;
  const r = await q(`UPDATE email_replies SET read_at = NOW()
                     WHERE id = ANY($1::bigint[]) AND read_at IS NULL
                       AND ($2::text IS NULL OR user_id = $2 OR user_id IS NULL) RETURNING id`, [clean, userId || null]);
  return r.length;
}

/* ── Email page: threads ──────────────────────────────────────────────
   A thread is every message sharing a thread_id, falling back to the
   message's own id for one-message conversations. Only CRM-managed
   conversations appear: rows come from communications, which holds what
   this system drafted or sent, plus replies matched to them. */
async function listEmailThreads({ userId, limit = 50, unreadOnly = false } = {}) {
  const params = [limit];
  const userFilter = userId ? ` AND (c.user_id = '${String(userId).replace(/'/g, "''")}' OR c.user_id IS NULL)` : '';
  const unread = unreadOnly ? ' HAVING BOOL_OR(r.read_at IS NULL) ' : '';
  return q(`
    SELECT COALESCE(c.thread_id, c.message_id, c.id::text) AS thread_id,
           MAX(c.subject) FILTER (WHERE c.subject <> '')            AS subject,
           MAX(c.to_email)                                          AS to_email,
           MAX(c.from_email)                                        AS from_email,
           MAX(c.contact_id)                                        AS contact_id,
           MAX(c.company_id)                                        AS company_id,
           MAX(ct.full_name)                                        AS contact_name,
           MAX(co.name)                                             AS company_name,
           COUNT(*)::int                                            AS message_count,
           MAX(GREATEST(COALESCE(c.sent_at, c.created_at), COALESCE(r.received_at, 'epoch'))) AS last_at,
           COUNT(r.id)::int                                         AS reply_count,
           COUNT(r.id) FILTER (WHERE r.read_at IS NULL)::int        AS unread_replies
    FROM communications c
    LEFT JOIN contacts  ct ON ct.id = c.contact_id
    LEFT JOIN companies co ON co.id = c.company_id
    LEFT JOIN email_replies r ON r.thread_id = COALESCE(c.thread_id, c.message_id)
    WHERE c.deleted_at IS NULL ${userFilter}
    GROUP BY 1 ${unread}
    ORDER BY last_at DESC NULLS LAST
    LIMIT $1`, params);
}

/* Every message in one conversation, oldest first, so the reading pane can
   render it as a conversation rather than a list of fragments. */
async function getEmailThread(threadId) {
  const msgs = await q(`
    SELECT c.id, c.subject, c.body, c.from_email, c.from_name, c.to_email, c.cc, c.bcc,
           c.sent_at, c.created_at, c.delivery_status, c.message_id, c.comm_type, c.status,
           c.contact_id, c.company_id, c.user_id,
           (SELECT COUNT(*)::int FROM communication_attachments a WHERE a.communication_id = c.id) AS attachment_count
    FROM communications c
    WHERE COALESCE(c.thread_id, c.message_id, c.id::text) = $1 AND c.deleted_at IS NULL
    ORDER BY COALESCE(c.sent_at, c.created_at) ASC`, [threadId]);
  const replies = await q(`
    SELECT id, from_email, from_name, snippet, received_at, read_at, reply_message_id
    FROM email_replies WHERE thread_id = $1 ORDER BY received_at ASC`, [threadId]);
  return { messages: msgs, replies };
}

async function logCompanyActivity(companyId, activityType, description) {
  if (!companyId) return;
  try {
    await q(`INSERT INTO company_activity (company_id, activity_type, description) VALUES ($1, $2, $3)`,
      [companyId, activityType, description || '']);
  } catch (e) {
    // An audit write must never take down the operation it is recording.
    console.warn('logCompanyActivity failed:', e.message);
  }
}

async function listCompanyActivity(companyId, limit = 50) {
  return q(`SELECT id, activity_type, description, created_at FROM company_activity
            WHERE company_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [companyId, limit]);
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
    /* Renaming is only safe if no OTHER row already holds the incoming name.
       companies has a unique index on LOWER(name); a normalised-key match can
       return a sibling, and renaming it onto its twin's name aborts the whole
       request. When the name is taken, keep the row's existing name and merge
       the rest — the alternative is losing an entire Apollo search to a
       cosmetic field. */
    let incomingName = fields.name;
    if (incomingName && incomingName.trim().toLowerCase() !== String(existing.name || '').trim().toLowerCase()) {
      const taken = await q1(
        `SELECT id FROM companies WHERE LOWER(name) = LOWER($1) AND id <> $2 LIMIT 1`,
        [incomingName.trim(), existing.id]
      );
      if (taken) incomingName = '';        // fall through to existing.name via pick()
    }
    const merged = {
      name: pick(incomingName, existing.name),
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
    /* First discovery wins: a company found in an uploaded list and later
       touched by an Apollo search was still discovered from the file.
       'legacy'/'crm_side_effect' are placeholders, so better information
       replaces them — and that correction is recorded. */
    const isPlaceholder = (v) => !v || v === 'legacy' || v === 'crm_side_effect';
    const resolvedSource = !isPlaceholder(existing.source)
      ? existing.source
      : (fields.source || existing.source || 'legacy');
    if (fields.source && resolvedSource !== existing.source) {
      await logCompanyActivity(existing.id, 'source_recorded',
        `Source ${existing.source || 'unset'} → ${resolvedSource}`
        + `${fields.source_file ? ` (${fields.source_file})` : ''}`);
    }

    await q(`
      UPDATE companies SET
        name=$1, chinese_name=$2, industry=$3, booth=$4, event_id=$5, website=$6, notes=$7,
        category=$8, priority=$9, background=$10, opportunity=$11, mfg_location=$12, contact_tip=$13,
        account_id=$14, source=$15, source_file=$16, updated_at=NOW()
      WHERE id=$17
    `, [
      merged.name, merged.chinese_name, merged.industry, merged.booth, merged.event_id,
      merged.website, merged.notes, merged.category, merged.priority, merged.background,
      merged.opportunity, merged.mfg_location, merged.contact_tip, accountId,
      /* First discovery wins. A company found in an uploaded list and later
         touched by an Apollo search was still discovered from the file, and
         relabelling it 'apollo' would erase the only record of how it got
         here. 'legacy'/'derived' are placeholders, so a real source replaces
         them. */
      resolvedSource,
      fields.source_file || existing.source_file || '',
      existing.id
    ]);
    return { id: existing.id, updated: true };
  }

  /* Every creation path funnels through here, so this is the one place that
     can guarantee a source is written. An unlabelled path still produces a
     usable row — refusing would lose real data over a metadata gap — but it
     says so loudly, because a silent 'crm_side_effect' is how a new import
     path would quietly stop being traceable. */
  const createdSource = fields.source || 'crm_side_effect';
  if (!fields.source) {
    console.warn(`[upsertCompany] "${name}" created with no source; recorded as crm_side_effect. `
      + 'Pass { source } from the calling path to keep provenance accurate.');
  }

  const [{ id }] = await q(`
    INSERT INTO companies (
      name, chinese_name, industry, booth, event_id, website, notes,
      category, priority, background, opportunity, mfg_location, contact_tip,
      account_id, name_key, source, source_file
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING id
  `, [
    name, fields.chinese_name || '', fields.industry || '', fields.booth || '',
    eventRow ? eventRow.id : null, fields.website || '', fields.notes || '',
    fields.category || '', fields.priority || 0, fields.background || '',
    fields.opportunity || '', fields.mfg_location || '', fields.contact_tip || '',
    accountId, normalizeNameKey(name),
    createdSource, fields.source_file || ''
  ]);
  await logCompanyActivity(id, 'created',
    `Created · source: ${createdSource}${fields.source_file ? ` (${fields.source_file})` : ''}`);
  return { id, updated: false };
}

// contact_count lets the UI show which companies still need prospecting —
// the whole point of the "search contacts with Apollo" flow in Quick Browse.
const COMPANY_CONTACT_COUNT = `
  LEFT JOIN (
    SELECT company_id, COUNT(*)::int AS contact_count
    FROM contacts WHERE company_id IS NOT NULL GROUP BY company_id
  ) cc ON cc.company_id = c.id`;

/* Account list view: one row per company with just the columns the list
   shows, plus the two counts that describe its state.

   Deliberately not listCompanies(), which does SELECT c.* and therefore
   ships every row's ai_research_summary — several KB each across ~1,100
   companies. That payload is why the company picker used to take ~4s to
   populate; a list view must not pay for prose it never displays. */
async function listCompanySummaries() {
  return q(`
    SELECT c.id, c.name, c.chinese_name, c.industry, c.booth, c.priority,
           c.account_id, c.booth_category, c.source, c.source_file,
           c.ai_analyzed_at, c.intelligence_reviewed_at,
           (COALESCE(c.ai_research_summary, '') <> '') AS has_summary,
           COALESCE(cc.contact_count, 0)::int AS contact_count,
           COALESCE(tg.tag_count, 0)::int AS tag_count,
           COALESCE(tg.confirmed_count, 0)::int AS confirmed_count
    FROM companies c
    ${COMPANY_CONTACT_COUNT}
    LEFT JOIN (
      SELECT company_id,
             COUNT(*)::int AS tag_count,
             COUNT(*) FILTER (WHERE source IN ('user_confirmed', 'manual'))::int AS confirmed_count
      FROM company_tags GROUP BY company_id
    ) tg ON tg.company_id = c.id
    ORDER BY c.name
  `);
}

async function listCompanies(searchTerm) {
  if (searchTerm && searchTerm.trim()) {
    const like = `%${searchTerm.trim().toLowerCase()}%`;
    return q(`
      SELECT c.*, COALESCE(cc.contact_count, 0) AS contact_count
      FROM companies c ${COMPANY_CONTACT_COUNT}
      WHERE LOWER(c.name) LIKE $1 OR LOWER(c.chinese_name) LIKE $2 OR LOWER(c.industry) LIKE $3
      ORDER BY c.priority DESC, c.name
    `, [like, like, like]);
  }
  return q(`
    SELECT c.*, COALESCE(cc.contact_count, 0) AS contact_count
    FROM companies c ${COMPANY_CONTACT_COUNT}
    ORDER BY c.priority DESC, c.name`);
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
    // The company appears because a contact is being saved; which kind of
    // contact is what makes the record useful later.
    const result = await upsertCompany({ name: companyText, source: companySourceForContact(c.source) });
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
      contact_status, priority, country, department_category, seniority_level,
      email_source
    ) VALUES (
      $1,  $2,  $3,  $4,  $5,  $6,  $7,  $8,  $9,  $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
      $31, $32, $33, $34, $35, $36, $37, $38, $39, $40,
      $41, $42, $43
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
    departmentCategory ? departmentCategory.key : null, seniorityLevel.key,
    // An address arriving with no stated provenance is 'legacy', not a guess.
    c.email_source || (c.email ? 'legacy' : 'none')
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
  const cols = await contactListColumns();
  return q(`
    SELECT ${cols}, COALESCE(ed.draft_count,0)::int AS draft_count, ed.latest_draft_id,
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
    const result = await upsertCompany({ name: newCompanyName, source: companySourceForContact(c.source || existing.source) });
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
    /* Provenance follows the address. An update that leaves the email alone
       must not relabel where it came from — otherwise editing a phone number
       would rewrite the record of who supplied the address. */
    email_source: (() => {
      const incoming = (c.email || '').trim();
      const current = (existing.email || '').trim();
      if (incoming && incoming.toLowerCase() !== current.toLowerCase()) {
        return c.email_source || 'legacy';        // a genuinely new address
      }
      if (c.email_source && !existing.email_source) return c.email_source;
      return existing.email_source || (current ? 'legacy' : 'none');
    })(),
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
      department_category=$41, seniority_level=$42, email_source=$43, updated_at=NOW()
    WHERE id=$44
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
    merged.email_source,
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

/* Contact list columns — every column except the Apollo blob.

   apollo_raw_json averages ~5.7 KB per contact and is 4.1 MB of the 4.6 MB
   contacts table. No list view reads it (only the email-reveal endpoint
   does, and that loads its row directly), yet every list query selected it.
   Because the values are large they live in TOAST storage, so `SELECT c.*`
   paid an out-of-line read per row: searching "Tesla" took ~2.2s for 99
   rows. Excluding it in SQL — not just dropping it from the JSON — is what
   removes that cost, and is what lets one global search feel immediate.

   The list is read from the catalogue once per process rather than
   hardcoded, so a column added later is included automatically instead of
   silently vanishing from the API. */
let _contactListCols = null;
async function contactListColumns() {
  if (_contactListCols) return _contactListCols;
  const rows = await q(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts'
      AND column_name <> 'apollo_raw_json'
    ORDER BY ordinal_position
  `);
  // Fall back to c.* if the catalogue is unavailable: slower, never wrong.
  _contactListCols = rows.length ? rows.map((r) => `c."${r.column_name}"`).join(', ') : 'c.*';
  return _contactListCols;
}

async function searchContacts(term, limit = 500) {
  if (term && term.trim()) {
    const like = `%${term.trim().toLowerCase()}%`;
    const cols = await contactListColumns();
    return q(`
      SELECT ${cols}, COALESCE(ed.draft_count,0)::int AS draft_count, ed.latest_draft_id,
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
  // Show filter — matches on the *company's* event, not the contact's. A contact
  // scanned at a different show still belongs to an exhibitor of this one.
  if (filters.show_event) {
    params.push(filters.show_event);
    clauses.push(`comp.event_id IN (SELECT id FROM events WHERE LOWER(name) = LOWER($${params.length}))`);
  }
  // Booth-map strategic category (customer / competitor / batmat / …).
  const boothCategories = ([].concat(filters.booth_categories || [])).map((s) => String(s).trim()).filter(Boolean);
  if (boothCategories.length) {
    params.push(boothCategories);
    clauses.push(`comp.booth_category = ANY($${params.length}::text[])`);
  }

  params.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = filters.sortBy === 'last_contacted' ? 'ORDER BY c.last_contacted_at DESC' : 'ORDER BY c.id DESC';

  const cols = await contactListColumns();
  return q(`
    SELECT ${cols}, COALESCE(ed.draft_count,0)::int AS draft_count, ed.latest_draft_id,
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

/* ═══════════════════════════════════════════════════════════════════
   Server-side grid: one page of rows, the matching total, and the facet
   counts that populate each column menu.

   The grid is specified to scale to hundreds of thousands of contacts, so
   none of these three ever returns more than it must: the page query is
   LIMIT/OFFSET, the count is a scalar, and the facets are grouped
   aggregates. The browser holds one page at a time.
   ═══════════════════════════════════════════════════════════════════ */

// Shared FROM: companies/accounts are joined because the sidebar filters
// (trade show, booth category, account) live on them.
const GRID_FROM = `
  FROM contacts c
  LEFT JOIN companies comp ON comp.id = c.company_id
  LEFT JOIN accounts acc ON acc.id = comp.account_id`;

/* Just the fields the reveal planner needs, for a bounded set of ids.
   apollo_raw_json is TOASTed and deliberately excluded from every list
   query; it is pulled here because deciding "free or paid" requires
   knowing whether the payload we already own contains an address, and the
   id list is a user selection (one page at most), not the table. */
async function listContactsByIds(ids) {
  const clean = (ids || []).map(Number).filter(Number.isInteger);
  if (!clean.length) return [];
  return q(`
    SELECT id, full_name, email, email_source, email_lookup_status,
           apollo_person_id, source, apollo_raw_json
    FROM contacts WHERE id = ANY($1::int[])`, [clean]);
}

async function queryContactsPage(filters = {}, sort = null, page = 1, pageSize = 25) {
  const { where, params } = buildWhere(filters);
  const cols = await contactListColumns();
  const p = params.slice();
  p.push(pageSize); const limitP = `$${p.length}`;
  p.push((Math.max(1, page) - 1) * pageSize); const offsetP = `$${p.length}`;

  const rows = await q(`
    SELECT ${cols},
      COALESCE(ed.draft_count,0)::int AS draft_count, ed.latest_draft_id,
      COALESCE(cs.comm_count,0)::int AS comm_count,
      COALESCE(cs.comm_draft_count,0)::int AS comm_draft_count,
      cs.last_comm_at, cs.last_comm_type,
      -- Company discovery provenance rides along on the join the sidebar
      -- filters already need, so the full chain (company → contact → email)
      -- is available without a second query per row.
      comp.source AS company_source, comp.source_file AS company_source_file,
      ${LAST_ACTIVITY_SQL} AS last_activity_at
    ${GRID_FROM} ${DRAFT_COUNT_JOIN} ${COMM_STATS_JOIN}
    ${where}
    ${buildOrderBy(sort)}
    LIMIT ${limitP} OFFSET ${offsetP}
  `, p);
  return rows;
}

async function countContacts(filters = {}) {
  const { where, params } = buildWhere(filters);
  const r = await q1(`SELECT COUNT(*)::int AS n ${GRID_FROM} ${where}`, params);
  return r ? r.n : 0;
}

/* Counts for one column's menu, computed with every *other* active filter
   applied but not this column's own — so the menu shows what you could
   switch to, not just what you already picked. That is how Excel's filter
   dropdowns behave, and the reason a zero here is trustworthy: the option
   really would return nothing given the rest of the filter set. */
async function contactFacets(filters = {}, column) {
  const { where, params } = buildWhere(filters, { skipColumn: column });

  // Simple GROUP BY columns.
  if (column === 'source' || column === 'status') {
    const col = column === 'source' ? 'c.source' : 'c.follow_up_status';
    const rows = await q(`
      SELECT COALESCE(${col}, '') AS key, COUNT(*)::int AS n
      ${GRID_FROM} ${where} GROUP BY 1`, params);
    return rows;
  }

  if (column === 'company') {
    // Bounded: the picker is searchable, so the menu never needs every
    // company at once.
    const p = params.slice();
    const search = String(filters.facetSearch || '').trim();
    let extra = '';
    if (search) { p.push('%' + escapeLike(search) + '%'); extra = ` AND c.company ILIKE $${p.length} ESCAPE '\\'`; }
    const rows = await q(`
      SELECT c.company AS key, COUNT(*)::int AS n
      ${GRID_FROM} ${where ? where + extra : (extra ? 'WHERE 1=1' + extra : '')}
      GROUP BY 1 HAVING c.company IS NOT NULL AND TRIM(c.company) <> ''
      ORDER BY n DESC, 1 ASC LIMIT 300`, p);
    return rows;
  }

  if (column === 'tags') {
    const p = params.slice();
    const search = String(filters.facetSearch || '').trim();
    let extra = '';
    if (search) { p.push('%' + escapeLike(search) + '%'); extra = ` AND (t.value ILIKE $${p.length} ESCAPE '\\' OR t.name_cn ILIKE $${p.length} ESCAPE '\\')`; }
    const rows = await q(`
      SELECT t.value AS key, t.name_en, t.name_cn, COUNT(DISTINCT c.id)::int AS n
      ${GRID_FROM}
      JOIN contact_tags ct ON ct.contact_id = c.id
      JOIN tags t ON t.id = ct.tag_id
      ${where ? where + extra : (extra ? 'WHERE 1=1' + extra : '')}
      GROUP BY t.value, t.name_en, t.name_cn
      ORDER BY n DESC, 1 ASC LIMIT 300`, p);
    return rows;
  }

  // Boolean-per-option columns: one COUNT(*) FILTER per option in a single
  // pass, rather than one round trip per checkbox. The predicates are the
  // same constants the WHERE builder uses, so a menu count and the filter
  // it triggers cannot disagree.
  const optionSql = OPTION_SQL[column];
  if (!optionSql) return [];

  const selects = Object.entries(optionSql)
    .map(([key, cond]) => `COUNT(*) FILTER (WHERE ${cond})::int AS "${key}"`);
  const row = await q1(`SELECT ${selects.join(', ')} ${GRID_FROM} ${where}`, params);
  return Object.keys(optionSql).map((key) => ({ key, n: row ? row[key] : 0 }));
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
    draft_options: extraFields.draft_options || '',
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
       parent_email_id, follow_up_sequence_number, draft_options)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
    RETURNING *
  `, [
    e.contact_id || null, e.company_id || null,
    e.comm_type || 'note', e.subject || '', e.body || '',
    e.category || 'other', e.status || 'saved', e.version || 1,
    e.source || 'manual', e.from_email || '', e.from_name || '',
    e.to_email || '', e.draft_mode || '', e.followup_text || '', e.rationale || '',
    e.sent_at || null, Boolean(e.review_needed), e.raw_payload || '', e.extra_instructions || '',
    e.cc || '', e.bcc || '', e.notes || '', e.parent_email_id || null, e.follow_up_sequence_number || null,
    e.draft_options || ''
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

// Attachments for a communication including their binary data, for real sending.
async function getAttachmentsWithDataForCommunication(communicationId) {
  return q(`
    SELECT a.id, a.original_filename, a.mime_type, a.file_data
    FROM communication_attachments ca
    JOIN attachments a ON a.id = ca.attachment_id
    WHERE ca.communication_id = $1
    ORDER BY ca.created_at ASC
  `, [communicationId]);
}

// Record the outcome of a send/schedule attempt on a communication.
async function markCommunicationSend(id, patch) {
  const cols = []; const vals = []; let i = 1;
  for (const k of ['delivery_status', 'message_id', 'send_error', 'status']) {
    if (k in patch) { cols.push(`${k} = $${i++}`); vals.push(patch[k]); }
  }
  if ('sent_at' in patch) { cols.push(`sent_at = $${i++}`); vals.push(patch.sent_at); }
  if ('scheduled_at' in patch) { cols.push(`scheduled_at = $${i++}`); vals.push(patch.scheduled_at); }
  if (!cols.length) return getCommunication(id);
  vals.push(id);
  await q(`UPDATE communications SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $${i}`, vals);
  return getCommunication(id);
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
async function checkEquivalentDraft(contactId, mode, extraInstructions, optionsSignature) {
  return q1(`
    SELECT * FROM communications
    WHERE contact_id = $1 AND comm_type = 'draft' AND deleted_at IS NULL
      AND COALESCE(draft_mode, 'cold_outreach') = $2
      AND COALESCE(extra_instructions, '') = $3
      AND COALESCE(draft_options, '') = $4
    ORDER BY version DESC, id DESC
    LIMIT 1
  `, [contactId, mode || 'cold_outreach', extraInstructions || '', optionsSignature || '']);
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

// ===========================================================================
// AI usage log — persistence, aggregation, savings estimate, budgets
// ===========================================================================

/* Current model pricing (USD per 1M tokens). Seeded once; edit in the DB to
   change prices going forward — historical event costs are preserved.

   Rows are keyed (provider, model) and looked up that way, so the two vendors
   can never be priced with each other's card — they differ by up to 15×.
   OpenAI bills no separate cache-WRITE fee, so cw is 0 there rather than a
   guess. Luna's numbers are from developers.openai.com (Aug 2026); note that
   several third-party aggregators list it at half these rates, so if the bill
   disagrees, this table is the one line to correct. */
const AI_PRICING_SEED = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6', in: 3.00, out: 15.00, cr: 0.30, cw: 3.75 },
  { provider: 'anthropic', model: 'claude-opus-4-8', in: 5.00, out: 25.00, cr: 0.50, cw: 6.25 },
  { provider: 'anthropic', model: 'claude-sonnet-5', in: 3.00, out: 15.00, cr: 0.30, cw: 3.75 },
  { provider: 'anthropic', model: 'claude-haiku-4-5', in: 1.00, out: 5.00, cr: 0.10, cw: 1.25 },
  { provider: 'openai', model: 'gpt-5.6-luna', in: 0.20, out: 1.20, cr: 0.02, cw: 0 },
  { provider: 'openai', model: 'gpt-5.6-terra', in: 1.25, out: 10.00, cr: 0.125, cw: 0 },
  { provider: 'openai', model: 'gpt-5.6-sol', in: 1.75, out: 14.00, cr: 0.175, cw: 0 },
  /* The assistant's chain. Alibaba's published per-token list prices, flagged
     estimated because we bill against a prepaid Token Plan whose drawdown per
     token is not the list price — see the note in usage.js. Correct these HERE,
     in the table, not in code: set is_estimated = false once an invoice
     confirms a rate and the "estimated" label stops appearing by itself. */
  { provider: 'bailian', model: 'qwen3.6-flash', in: 0.19, out: 1.13, cr: 0.019, cw: 0, est: true },
  { provider: 'bailian', model: 'qwen3.7-plus', in: 0.40, out: 1.60, cr: 0.04, cw: 0, est: true },
  { provider: 'bailian', model: 'qwen3.8-max', in: 2.00, out: 6.00, cr: 0.20, cw: 0, est: true },
];
/* Seeding was check-then-insert, which is not atomic: two processes running
   initDb() at once (a server booting while the test suite runs, say) could
   both miss the row and both insert it. That produced genuine duplicate
   active prices, and a duplicate price is a costing bug waiting to happen —
   whichever row is read last silently wins.

   Fixed by making the database enforce it instead: one active price per
   (provider, model), so the second writer conflicts and does nothing. The
   duplicates already created are collapsed to the earliest row first, since
   the index cannot be built while they exist. */
async function seedAiModelPricing() {
  /* Duplicates are RETIRED, not deleted. Closing them with an effective_end
     satisfies the partial unique index below (which only constrains rows
     where effective_end IS NULL) while leaving every row in place, so no
     historical price and no audit trail is destroyed. A DELETE here would
     have been simpler and irreversible; this is neither. */
  await q(`
    UPDATE ai_model_pricing a
       SET effective_end = CURRENT_DATE
      FROM ai_model_pricing b
     WHERE a.effective_end IS NULL AND b.effective_end IS NULL
       AND a.provider = b.provider AND a.model = b.model
       AND a.id > b.id
  `);
  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_model_pricing_active_uniq
      ON ai_model_pricing (provider, model) WHERE effective_end IS NULL
  `);
  for (const p of AI_PRICING_SEED) {
    await q(`
      INSERT INTO ai_model_pricing
        (provider, model, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, is_estimated, effective_start)
      VALUES ($1,$2,$3,$4,$5,$6,$7, DATE '2025-01-01')
      ON CONFLICT DO NOTHING
    `, [p.provider, p.model, p.in, p.out, p.cr, p.cw, Boolean(p.est)]);
  }
}
async function listActivePricing() {
  return q(`
    SELECT provider, model, input_price_per_m, output_price_per_m,
           cache_read_price_per_m, cache_write_price_per_m, reasoning_price_per_m,
           currency, is_estimated
    FROM ai_model_pricing WHERE effective_end IS NULL ORDER BY model
  `);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Threaded assistant chat.

   Every function here takes userId and puts it in the WHERE clause of the same
   statement that finds the row. Not a lookup followed by a check: the two can
   drift, and the one that gets forgotten is the check. A thread that is not
   yours is indistinguishable from one that does not exist — these return
   undefined, and the routes turn that into 404 rather than 403, because 403
   confirms the row is there.

   Deletion and archiving are soft, like every other retirement in this schema.
   A conversation someone deletes by accident is recoverable by an operator;
   one that is gone is gone.
   ═══════════════════════════════════════════════════════════════════════════ */

const THREAD_COLS = `id, title, title_source, message_count, created_at, updated_at,
                     last_message_at, archived_at`;

async function createChatThread(userId, title) {
  const row = await q1(
    `INSERT INTO chat_threads (user_id, title, title_source, last_message_at)
     VALUES ($1, $2, $3, NOW()) RETURNING ${THREAD_COLS}`,
    [userId, title || null, title ? 'auto' : null]);
  return row;
}

/** The thread, or undefined — for any reason, including "not yours". */
async function getChatThread(userId, threadId) {
  return q1(
    `SELECT ${THREAD_COLS}, summary, summary_upto_message_id
       FROM chat_threads
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [threadId, userId]);
}

/**
 * The thread list, newest activity first.
 *
 * `q` searches titles AND message bodies, because people remember what they
 * asked far more often than what the thread ended up being called. Matching
 * messages contribute their thread once, with a snippet.
 */
async function listChatThreads(userId, opts = {}) {
  const params = [userId];
  let where = `t.user_id = $1 AND t.deleted_at IS NULL`;
  where += opts.archived ? ` AND t.archived_at IS NOT NULL` : ` AND t.archived_at IS NULL`;

  let snippet = `NULL::text AS snippet`;
  if (opts.q) {
    params.push(`%${String(opts.q).slice(0, 120)}%`);
    const i = params.length;
    where += ` AND (t.title ILIKE $${i} OR EXISTS (
                 SELECT 1 FROM chat_messages m
                  WHERE m.thread_id = t.id AND m.user_id = $1
                    AND m.deleted_at IS NULL AND m.content ILIKE $${i}))`;
    snippet = `(SELECT LEFT(m.content, 160) FROM chat_messages m
                 WHERE m.thread_id = t.id AND m.user_id = $1
                   AND m.deleted_at IS NULL AND m.content ILIKE $${i}
                 ORDER BY m.id LIMIT 1) AS snippet`;
  }
  const limit = Math.min(100, Math.max(1, opts.limit || 40));
  const offset = Math.max(0, opts.offset || 0);
  params.push(limit, offset);
  return q(
    `SELECT ${THREAD_COLS.split(',').map((c) => 't.' + c.trim()).join(', ')}, ${snippet}
       FROM chat_threads t
      WHERE ${where}
      ORDER BY t.last_message_at DESC NULLS LAST, t.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params);
}

/** Messages, oldest first. Scoped by user as well as thread, deliberately. */
async function listChatMessages(userId, threadId, opts = {}) {
  const limit = Math.min(500, Math.max(1, opts.limit || 200));
  return q(
    `SELECT id, role, content, tools_used, entities, page_context, created_at
       FROM chat_messages
      WHERE thread_id = $1 AND user_id = $2 AND deleted_at IS NULL
      ORDER BY id ASC LIMIT $3`,
    [threadId, userId, limit]);
}

/** The tail the model is actually shown, oldest-first once reversed. */
async function recentChatMessages(userId, threadId, limit) {
  const rows = await q(
    `SELECT id, role, content FROM chat_messages
      WHERE thread_id = $1 AND user_id = $2 AND deleted_at IS NULL
      ORDER BY id DESC LIMIT $3`,
    [threadId, userId, Math.min(100, Math.max(1, limit || 12))]);
  return rows.reverse();
}

async function addChatMessage(userId, threadId, msg) {
  const row = await q1(
    `INSERT INTO chat_messages
       (thread_id, user_id, role, content, tools_used, entities, page_context, usage_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [threadId, userId, msg.role, msg.content,
      msg.tools_used && msg.tools_used.length ? msg.tools_used : null,
      msg.entities ? JSON.stringify(msg.entities) : null,
      msg.page_context ? JSON.stringify(msg.page_context) : null,
      msg.usage_event_id || null]);

  /* Counters on the thread rather than a COUNT(*) per list request: the list
     is the hottest read here and it must not scan messages to render. */
  await q(
    `UPDATE chat_threads
        SET message_count = message_count + 1, last_message_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [threadId, userId]);
  return row;
}

/** Only ever sets a title; never clears one, and never overrides a human. */
async function setChatThreadTitle(userId, threadId, title, source) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean) return undefined;
  return q1(
    `UPDATE chat_threads SET title = $3, title_source = $4, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        AND ($4 = 'user' OR title_source IS DISTINCT FROM 'user')
      RETURNING ${THREAD_COLS}`,
    [threadId, userId, clean, source === 'user' ? 'user' : 'auto']);
}

async function setChatThreadArchived(userId, threadId, archived) {
  return q1(
    `UPDATE chat_threads SET archived_at = ${archived ? 'NOW()' : 'NULL'}, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      RETURNING ${THREAD_COLS}`,
    [threadId, userId]);
}

async function deleteChatThread(userId, threadId) {
  return q1(
    `UPDATE chat_threads SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [threadId, userId]);
}

async function setChatThreadSummary(userId, threadId, summary, uptoId) {
  return q1(
    `UPDATE chat_threads SET summary = $3, summary_upto_message_id = $4, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
    [threadId, userId, summary || null, uptoId || null]);
}

/** Per-thread cost, from the events already recorded. Nothing is duplicated. */
async function chatThreadUsage(userId, threadId) {
  return q1(
    `SELECT COUNT(*)::int turns,
            COALESCE(SUM(e.input_tokens),0)::bigint input_tokens,
            COALESCE(SUM(e.output_tokens),0)::bigint output_tokens,
            COALESCE(SUM(e.reasoning_tokens),0)::bigint reasoning_tokens,
            COALESCE(SUM(e.cost_usd),0) cost_usd,
            COALESCE(BOOL_OR(e.cost_estimated), false) cost_estimated,
            COUNT(*) FILTER (WHERE e.fell_back)::int fallbacks,
            AVG(e.response_ms) FILTER (WHERE e.response_ms IS NOT NULL) avg_response_ms
       FROM ai_usage_events e
       JOIN chat_threads t ON t.id = e.thread_id
      WHERE e.thread_id = $1 AND t.user_id = $2 AND t.deleted_at IS NULL`,
    [threadId, userId]);
}

async function recordAiUsage(evt) {
  const total = (evt.input_tokens || 0) + (evt.output_tokens || 0);
  await q(`
    INSERT INTO ai_usage_events
      (feature, sub_feature, outcome, request_type, model, provider,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
       cost_usd, currency, tokens_saved_input, tokens_saved_output, cost_saved_usd,
       company_id, contact_id, thread_id, session_id, user_id, response_ms, status, error_message, request_id,
       web_search_calls, requested_provider, requested_model, fell_back, cost_estimated, model_breakdown)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
    ON CONFLICT (request_id) DO NOTHING
  `, [
    evt.feature, evt.sub_feature || null, evt.outcome, evt.request_type || null, evt.model || null, evt.provider || 'anthropic',
    evt.input_tokens || 0, evt.output_tokens || 0, evt.cache_read_tokens || 0, evt.cache_write_tokens || 0, evt.reasoning_tokens || 0, total,
    evt.cost_usd || 0, evt.currency || 'USD', evt.tokens_saved_input || 0, evt.tokens_saved_output || 0, evt.cost_saved_usd || 0,
    evt.company_id || null, evt.contact_id || null, evt.thread_id || null, evt.session_id || null, evt.user_id || null,
    evt.response_ms || null, evt.status || 'success', evt.error_message || null, evt.request_id || null,
    evt.web_search_calls || 0, evt.requested_provider || null,
    evt.requested_model || null, Boolean(evt.fell_back), Boolean(evt.cost_estimated),
    evt.model_breakdown ? JSON.stringify(evt.model_breakdown) : null,
  ]);
}

// ===========================================================================
// Account Intelligence Reports (ported from the standalone Skeqi-AccountResearch
// app, whose file-based JSON store did not survive redeploys)
// ===========================================================================

function arSlugify(v) {
  return String(v || '').trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'na';
}

async function saveAccountReport(D, userId) {
  const key = `${arSlugify(D.target)}__${arSlugify(D.seller)}`;
  const vr = await q(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM account_reports WHERE report_key = $1`, [key]);
  const version = Number(vr[0].next);
  const id = `${key}__v${version}__${Date.now()}`;
  const sections = ['od', 'fd', 'sd', 'nd', 'cd', 'sal'].reduce((acc, k) => {
    const st = D._sectionStatus && D._sectionStatus[k];
    acc[k] = st === 'success' ? 'live' : (st === 'fallback' ? 'fallback' : (D[k] ? 'live' : 'fallback'));
    return acc;
  }, {});
  const usage = D._usage ? {
    model: D._usage.model || '', apiCalls: D._usage.apiCalls || 0,
    inputTokens: D._usage.inputTokens || 0, outputTokens: D._usage.outputTokens || 0,
    totalTokens: (D._usage.inputTokens || 0) + (D._usage.outputTokens || 0),
    costUSD: D._usage.costUSD || 0,
  } : null;
  // Link the report to a CRM company when the name matches one we already know.
  const cm = await q(
    `SELECT id FROM companies WHERE name_key = $1 LIMIT 1`, [normalizeNameKey(D.target)]);
  await q(`
    INSERT INTO account_reports
      (id, report_key, version, target, target_zh, turl, company_name, company_name_zh,
       seller, surl, sections, usage, data, company_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  `, [
    id, key, version, D.target, (D.od && D.od.companyNameZh) || '', D.turl || '',
    (D.od && D.od.companyName) || '', (D.od && D.od.companyNameZh) || '',
    D.seller, D.surl || '', JSON.stringify(sections), usage ? JSON.stringify(usage) : null,
    JSON.stringify({ ...D, id, key, version, createdAt: new Date().toISOString() }),
    cm.length ? cm[0].id : null, userId || null,
  ]);
  return { id, key, version };
}

async function listAccountReports(search) {
  const term = String(search || '').trim();
  const params = [];
  let where = '';
  if (term) {
    params.push(`%${term.toLowerCase()}%`);
    where = `WHERE LOWER(COALESCE(target,'') || ' ' || COALESCE(target_zh,'') || ' ' ||
                    COALESCE(seller,'') || ' ' || COALESCE(turl,'') || ' ' || COALESCE(surl,'')) LIKE $1`;
  }
  return await q(`
    SELECT id, report_key AS key, version, target, target_zh AS "targetZh", turl,
           company_name AS "companyName", company_name_zh AS "companyNameZh",
           seller, surl, report_type AS "reportType", sections, usage, company_id,
           created_at AS "createdAt"
    FROM account_reports ${where} ORDER BY created_at DESC LIMIT 500
  `, params);
}

/* Returns the stored report plus the version it was saved as. The version
   lives in its own column rather than inside `data`, and the loader needs it
   to tell the user which version is on screen. */
async function getAccountReport(id) {
  const rows = await q(`SELECT data, version FROM account_reports WHERE id = $1`, [id]);
  if (!rows.length) return null;
  return { report: rows[0].data, version: rows[0].version };
}

async function deleteAccountReport(id) {
  const rows = await q(`DELETE FROM account_reports WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

async function getAccountResearchCache(type, key, ttlMs) {
  const rows = await q(
    `SELECT data, cost_usd, cached_at FROM account_research_cache WHERE cache_type = $1 AND cache_key = $2`,
    [type, key]);
  if (!rows.length) return { found: false };
  const ageMs = Date.now() - new Date(rows[0].cached_at).getTime();
  if (ttlMs && ageMs > ttlMs) return { found: false, expired: true };
  return { found: true, data: rows[0].data, costUSD: Number(rows[0].cost_usd) || 0,
           cachedAt: new Date(rows[0].cached_at).getTime(), ageMs };
}

async function setAccountResearchCache(type, key, data, costUSD) {
  await q(`
    INSERT INTO account_research_cache (cache_type, cache_key, data, cost_usd, cached_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (cache_type, cache_key)
    DO UPDATE SET data = EXCLUDED.data, cost_usd = EXCLUDED.cost_usd, cached_at = NOW()
  `, [type, key, JSON.stringify(data), costUSD || 0]);
}

async function clearAccountResearchCache(type, key) {
  await q(`DELETE FROM account_research_cache WHERE cache_type = $1 AND cache_key = $2`, [type, key]);
}

// period → SQL WHERE body (no params). Custom ranges use buildPeriodFilter.
// `alias` qualifies the column for queries that join another table carrying its
// own created_at (e.g. companies) — without it those queries fail with
// "column reference created_at is ambiguous".
function periodWhere(period, alias = '') {
  const c = alias ? `${alias}.created_at` : 'created_at';
  switch (period) {
    case 'today': return `${c} >= date_trunc('day', NOW())`;
    case 'yesterday': return `${c} >= date_trunc('day', NOW()) - INTERVAL '1 day' AND ${c} < date_trunc('day', NOW())`;
    case '7d': return `${c} >= NOW() - INTERVAL '7 days'`;
    case '30d': return `${c} >= NOW() - INTERVAL '30 days'`;
    case 'month': return `${c} >= date_trunc('month', NOW())`;
    case 'prev_month': return `${c} >= date_trunc('month', NOW()) - INTERVAL '1 month' AND ${c} < date_trunc('month', NOW())`;
    case 'year': return `${c} >= date_trunc('year', NOW())`;
    default: return `TRUE`;
  }
}
// Returns { sql, params } — custom range binds dates as params.
// Pass `alias` when the consuming query joins a table that also has created_at.
function buildPeriodFilter(period, from, to, alias = '') {
  const c = alias ? `${alias}.created_at` : 'created_at';
  if (period === 'custom' && (from || to)) {
    const parts = []; const params = [];
    if (from) { params.push(from); parts.push(`${c} >= $${params.length}::date`); }
    if (to) { params.push(to); parts.push(`${c} < ($${params.length}::date + INTERVAL '1 day')`); }
    return { sql: parts.join(' AND ') || 'TRUE', params };
  }
  return { sql: periodWhere(period, alias), params: [] };
}

async function aiUsageTotals(period = 'all') {
  const row = await q1(`
    SELECT
      COUNT(*) FILTER (WHERE outcome IN ('db_reuse','cache_hit','ai_avoided')) AS reuses,
      COUNT(*) FILTER (WHERE outcome NOT IN ('db_reuse','cache_hit','ai_avoided')) AS new_calls,
      COALESCE(SUM(input_tokens),0) AS input_tokens,
      COALESCE(SUM(output_tokens),0) AS output_tokens,
      COALESCE(SUM(cost_usd),0) AS cost_usd,
      COALESCE(SUM(tokens_saved_input),0) AS saved_input,
      COALESCE(SUM(tokens_saved_output),0) AS saved_output,
      COALESCE(SUM(cost_saved_usd),0) AS saved_cost_usd,
      COUNT(*) FILTER (WHERE feature='company_research' AND outcome NOT IN ('db_reuse','cache_hit','ai_avoided')) AS company_analyses,
      COUNT(*) FILTER (WHERE feature='contact_intel') AS contact_analyses,
      COUNT(*) FILTER (WHERE feature='email_draft' AND outcome NOT IN ('db_reuse','cache_hit','ai_avoided')) AS drafts,
      COUNT(*) FILTER (WHERE feature='product_match') AS product_matches,
      COUNT(*) FILTER (WHERE feature='attachment_rec') AS attachment_recs
    FROM ai_usage_events WHERE ${periodWhere(period)}
  `);
  const num = (x) => Number(x || 0);
  return {
    new_calls: num(row.new_calls), reuses: num(row.reuses),
    input_tokens: num(row.input_tokens), output_tokens: num(row.output_tokens),
    total_tokens: num(row.input_tokens) + num(row.output_tokens),
    cost_usd: num(row.cost_usd),
    saved_input: num(row.saved_input), saved_output: num(row.saved_output),
    saved_total: num(row.saved_input) + num(row.saved_output),
    saved_cost_usd: num(row.saved_cost_usd),
    company_analyses: num(row.company_analyses), contact_analyses: num(row.contact_analyses),
    drafts: num(row.drafts), product_matches: num(row.product_matches), attachment_recs: num(row.attachment_recs),
  };
}

async function aiUsageByFeature(period = 'all') {
  return q(`
    SELECT feature,
      COUNT(*) FILTER (WHERE outcome NOT IN ('db_reuse','cache_hit','ai_avoided')) AS new_calls,
      COUNT(*) FILTER (WHERE outcome IN ('db_reuse','cache_hit','ai_avoided')) AS reuses,
      COALESCE(SUM(input_tokens),0)::int AS input_tokens,
      COALESCE(SUM(output_tokens),0)::int AS output_tokens,
      COALESCE(SUM(cost_usd),0) AS cost_usd,
      COALESCE(SUM(tokens_saved_input+tokens_saved_output),0)::int AS saved_total,
      COALESCE(SUM(cost_saved_usd),0) AS saved_cost_usd
    FROM ai_usage_events WHERE ${periodWhere(period)}
    GROUP BY feature ORDER BY cost_usd DESC
  `);
}

async function aiUsageByCompany(period = 'all', limit = 20) {
  return q(`
    SELECT e.company_id, c.name AS company_name,
      COUNT(*) FILTER (WHERE e.outcome NOT IN ('db_reuse','cache_hit','ai_avoided')) AS new_calls,
      COUNT(*) FILTER (WHERE e.outcome IN ('db_reuse','cache_hit','ai_avoided')) AS reuses,
      COALESCE(SUM(e.input_tokens+e.output_tokens),0)::int AS total_tokens,
      COALESCE(SUM(e.cost_usd),0) AS cost_usd,
      COALESCE(SUM(e.tokens_saved_input+e.tokens_saved_output),0)::int AS saved_total,
      COALESCE(SUM(e.cost_saved_usd),0) AS saved_cost_usd
    FROM ai_usage_events e LEFT JOIN companies c ON c.id = e.company_id
    WHERE ${periodWhere(period, 'e')} AND e.company_id IS NOT NULL
    GROUP BY e.company_id, c.name ORDER BY cost_usd DESC LIMIT $1
  `, [limit]);
}

// --- Rich reporting (filter = { sql, params } from buildPeriodFilter) --------
const REUSE_SQL = `outcome IN ('db_reuse','cache_hit','ai_avoided')`;

async function aiUsageKpis(filter) {
  const row = await q1(`
    SELECT
      COUNT(*) AS requests,
      COUNT(*) FILTER (WHERE ${REUSE_SQL}) AS reuses,
      COUNT(*) FILTER (WHERE NOT (${REUSE_SQL})) AS new_calls,
      COUNT(*) FILTER (WHERE status = 'error') AS failures,
      COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
      COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
      COALESCE(SUM(input_tokens+output_tokens),0)::bigint AS total_tokens,
      COALESCE(SUM(cost_usd),0) AS cost_usd,
      COALESCE(SUM(tokens_saved_input),0)::bigint AS saved_input,
      COALESCE(SUM(tokens_saved_output),0)::bigint AS saved_output,
      COALESCE(SUM(tokens_saved_input+tokens_saved_output),0)::bigint AS saved_total,
      COALESCE(SUM(cost_saved_usd),0) AS saved_cost_usd,
      AVG(response_ms) FILTER (WHERE response_ms IS NOT NULL) AS avg_response_ms
    FROM ai_usage_events WHERE ${filter.sql}
  `, filter.params);
  const n = (x) => Number(x || 0);
  const requests = n(row.requests), newCalls = n(row.new_calls), reuses = n(row.reuses);
  return {
    requests, new_calls: newCalls, reuses, failures: n(row.failures),
    input_tokens: n(row.input_tokens), output_tokens: n(row.output_tokens), total_tokens: n(row.total_tokens),
    cost_usd: n(row.cost_usd),
    saved_input: n(row.saved_input), saved_output: n(row.saved_output), saved_total: n(row.saved_total), saved_cost_usd: n(row.saved_cost_usd),
    avg_response_ms: row.avg_response_ms != null ? Math.round(Number(row.avg_response_ms)) : null,
    avg_cost_usd: newCalls ? n(row.cost_usd) / newCalls : 0,
    reuse_rate: requests ? reuses / requests : 0,
    failure_rate: requests ? n(row.failures) / requests : 0,
  };
}

async function aiUsageTimeseries(filter, bucket = 'day') {
  const trunc = bucket === 'month' ? 'month' : bucket === 'week' ? 'week' : 'day';
  return q(`
    SELECT date_trunc('${trunc}', created_at) AS bucket,
      COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
      COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
      COALESCE(SUM(input_tokens+output_tokens),0)::bigint AS total_tokens,
      COALESCE(SUM(cost_usd),0) AS cost_usd,
      COALESCE(SUM(tokens_saved_input+tokens_saved_output),0)::bigint AS saved_total,
      COALESCE(SUM(cost_saved_usd),0) AS saved_cost_usd,
      COUNT(*) AS requests,
      COUNT(*) FILTER (WHERE NOT (${REUSE_SQL})) AS new_calls,
      COUNT(*) FILTER (WHERE ${REUSE_SQL}) AS reuses
    FROM ai_usage_events WHERE ${filter.sql}
    GROUP BY bucket ORDER BY bucket
  `, filter.params);
}

async function aiUsageFeatureBreakdown(filter) {
  return q(`
    SELECT feature,
      COUNT(*) FILTER (WHERE NOT (${REUSE_SQL})) AS new_calls,
      COUNT(*) FILTER (WHERE ${REUSE_SQL}) AS reuses,
      COUNT(*) AS requests,
      COUNT(*) FILTER (WHERE status='error') AS failures,
      COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
      COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
      COALESCE(SUM(input_tokens+output_tokens),0)::bigint AS total_tokens,
      COALESCE(SUM(cost_usd),0) AS cost_usd,
      COALESCE(SUM(tokens_saved_input+tokens_saved_output),0)::bigint AS saved_total,
      COALESCE(SUM(cost_saved_usd),0) AS saved_cost_usd,
      AVG(response_ms) FILTER (WHERE response_ms IS NOT NULL) AS avg_response_ms
    FROM ai_usage_events WHERE ${filter.sql}
    GROUP BY feature ORDER BY cost_usd DESC, total_tokens DESC
  `, filter.params);
}

async function aiUsageByModel(filter) {
  return q(`
    SELECT provider, model,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens+output_tokens),0)::bigint AS total_tokens,
      COALESCE(SUM(cost_usd),0) AS cost_usd
    FROM ai_usage_events WHERE ${filter.sql} AND model IS NOT NULL
    GROUP BY provider, model ORDER BY cost_usd DESC
  `, filter.params);
}

/**
 * The AI Assistant, on its own terms.
 *
 * A chat turn is not a model call: one turn is a model call, some tools, and
 * another model call — and if the first model fails, a second model's calls on
 * top. Every other feature here is one row per call, so the generic breakdown
 * counts requests and gets the right answer. For chat, requests and turns are
 * the same number (one row per turn) but the cost inside a row is spread over
 * several models, which is why cost-by-model reads model_breakdown rather than
 * the `model` column.
 */
/* The SQL lives in these two constants rather than inline so the tests can run
   the exact text the application runs. A test that retypes a query proves the
   retyped query works. */
const CHAT_SUMMARY_SQL = (where) => `
    SELECT
      COUNT(*) AS turns,
      COUNT(*) FILTER (WHERE status = 'error') AS failures,
      COUNT(*) FILTER (WHERE fell_back) AS fallbacks,
      COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
      COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
      COALESCE(SUM(reasoning_tokens),0)::bigint AS reasoning_tokens,
      COALESCE(SUM(input_tokens+output_tokens),0)::bigint AS total_tokens,
      COALESCE(SUM(cost_usd),0) AS cost_usd,
      AVG(response_ms) FILTER (WHERE response_ms IS NOT NULL) AS avg_response_ms,
      -- One unconfirmed rate anywhere in the range makes the total an estimate.
      COALESCE(BOOL_OR(cost_estimated), false) AS cost_estimated
    FROM ai_usage_events
    WHERE feature = 'chat' AND ${where}
`;

async function aiChatSummary(filter) {
  const row = await q1(CHAT_SUMMARY_SQL(filter.sql), filter.params);
  const n = (x) => Number(x || 0);
  const turns = n(row.turns);
  return {
    turns,
    failures: n(row.failures),
    fallbacks: n(row.fallbacks),
    input_tokens: n(row.input_tokens),
    output_tokens: n(row.output_tokens),
    reasoning_tokens: n(row.reasoning_tokens),
    total_tokens: n(row.total_tokens),
    cost_usd: n(row.cost_usd),
    cost_estimated: Boolean(row.cost_estimated),
    avg_response_ms: row.avg_response_ms != null ? Math.round(Number(row.avg_response_ms)) : null,
    fallback_rate: turns ? n(row.fallbacks) / turns : 0,
    failure_rate: turns ? n(row.failures) / turns : 0,
  };
}

/**
 * Chat cost per model, counting attempts that were paid for and thrown away.
 *
 * The LEFT JOIN LATERAL is what makes both shapes work in one query: a turn
 * with a breakdown contributes one row per model it used, a turn without one
 * (single call, or a row written before this column existed) contributes a
 * single row that falls back to the flat columns. Neither is double-counted.
 */
const CHAT_BY_MODEL_SQL = (where) => `
    SELECT
      COALESCE(b->>'model', e.model, '(unknown)') AS model,
      COALESCE(b->>'provider', e.provider) AS provider,
      COUNT(*) AS attempts,
      COUNT(*) FILTER (WHERE b IS NULL OR (b->>'served')::boolean) AS served,
      COALESCE(SUM(COALESCE((b->>'input_tokens')::bigint, e.input_tokens)),0)::bigint AS input_tokens,
      COALESCE(SUM(COALESCE((b->>'output_tokens')::bigint, e.output_tokens)),0)::bigint AS output_tokens,
      COALESCE(SUM(COALESCE((b->>'cost_usd')::numeric, e.cost_usd)),0) AS cost_usd,
      COALESCE(BOOL_OR(COALESCE((b->>'estimated')::boolean, e.cost_estimated)), false) AS cost_estimated
    FROM ai_usage_events e
    LEFT JOIN LATERAL jsonb_array_elements(e.model_breakdown) b ON true
    WHERE e.feature = 'chat' AND ${where}
    GROUP BY 1, 2
    ORDER BY cost_usd DESC, attempts DESC
`;

async function aiChatByModel(filter) {
  return q(CHAT_BY_MODEL_SQL(filter.sql), filter.params);
}

async function aiUsageByUser(filter) {
  return q(`
    SELECT COALESCE(user_id,'(unknown)') AS user_id,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens+output_tokens),0)::bigint AS total_tokens,
      COALESCE(SUM(cost_usd),0) AS cost_usd
    FROM ai_usage_events WHERE ${filter.sql}
    GROUP BY user_id ORDER BY cost_usd DESC LIMIT 20
  `, filter.params);
}

// Paginated request-level audit log (no prompt/email content — metadata only).
// `filter` must be built with alias 'e' — both queries below alias the events
// table, and the row query joins companies (which carries its own created_at).
async function aiUsageEvents(filter, opts = {}) {
  const params = [...filter.params];
  let where = filter.sql;
  if (opts.feature) { params.push(opts.feature); where += ` AND e.feature = $${params.length}`; }
  if (opts.status) { params.push(opts.status); where += ` AND e.status = $${params.length}`; }
  const countRow = await q1(`SELECT COUNT(*)::int AS n FROM ai_usage_events e WHERE ${where}`, params);
  const limit = Math.min(200, Math.max(1, opts.limit || 50));
  const offset = Math.max(0, opts.offset || 0);
  params.push(limit); const limIdx = params.length;
  params.push(offset); const offIdx = params.length;
  const rows = await q(`
    SELECT e.id, e.created_at, e.feature, e.sub_feature, e.outcome, e.request_type, e.status,
           e.model, e.provider, e.input_tokens, e.output_tokens, e.total_tokens, e.cost_usd,
           -- So a single row in the log can be read as "asked for X, answered by Y".
           e.requested_model, e.fell_back, e.cost_estimated,
           e.response_ms, e.user_id, e.company_id, e.contact_id, e.error_message,
           c.name AS company_name
    FROM ai_usage_events e LEFT JOIN companies c ON c.id = e.company_id
    WHERE ${where} ORDER BY e.created_at DESC LIMIT $${limIdx} OFFSET $${offIdx}
  `, params);
  return { total: countRow.n, rows, limit, offset };
}

// Estimate what a reuse SAVED: tokens of the most recent real call for the same
// feature (company/contact-scoped when possible), falling back to per-feature
// defaults. Returns { input, output }.
const SAVED_DEFAULTS = {
  company_research: { input: 4000, output: 1500 },
  email_draft: { input: 1500, output: 450 },
  contact_intel: { input: 0, output: 0 },
  product_match: { input: 1200, output: 300 },
  attachment_rec: { input: 800, output: 200 },
  _default: { input: 1000, output: 300 },
};
async function estimateAiSaved(feature, ids = {}) {
  const filters = [`feature = $1`, `outcome NOT IN ('db_reuse','cache_hit','ai_avoided')`, `(input_tokens > 0 OR output_tokens > 0)`];
  const params = [feature];
  if (ids.company_id) { params.push(ids.company_id); filters.push(`company_id = $${params.length}`); }
  const row = await q1(`
    SELECT input_tokens, output_tokens FROM ai_usage_events
    WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT 1
  `, params);
  if (row) return { input: Number(row.input_tokens), output: Number(row.output_tokens) };
  return SAVED_DEFAULTS[feature] || SAVED_DEFAULTS._default;
}

// Budget/limit settings (stored in the settings table as JSON).
const AI_BUDGET_DEFAULTS = {
  daily_token_budget: 0,        // 0 = unlimited
  monthly_token_budget: 0,      // 0 = unlimited
  daily_cost_budget: 0,         // USD, 0 = unlimited
  monthly_cost_budget: 0,       // USD, 0 = unlimited
  per_user_cost_budget: 0,      // USD/day per user, 0 = unlimited
  max_tokens_per_request: 0,    // 0 = use per-feature default
  max_cost_per_request: 0,      // USD, 0 = unlimited
  warn_threshold_pct: 80,
  hard_limit: false,            // false = warn only; true = block when exceeded
  auto_refresh_disabled: false,
};
async function getAiBudget() {
  const raw = await getSetting('ai_budget');
  let parsed = {};
  if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = {}; } }
  return { ...AI_BUDGET_DEFAULTS, ...parsed };
}
async function setAiBudget(patch) {
  const current = await getAiBudget();
  const next = { ...current, ...patch };
  await setSetting('ai_budget', JSON.stringify(next));
  return next;
}

// ===========================================================================
// Email configuration (org-level + per-user)
// ===========================================================================
const EMAIL_ORG_COLS = ['allowed_domain', 'provider_name', 'provider_type',
  'smtp_host', 'smtp_port', 'smtp_encryption', 'smtp_auth_method',
  'imap_host', 'imap_port', 'imap_encryption', 'imap_auth_method',
  'inbox_folder', 'sent_folder', 'draft_folder', 'archive_folder', 'trash_folder',
  'sync_interval_seconds', 'imap_idle', 'max_attachment_mb', 'hourly_send_limit', 'daily_send_limit',
  'ip_allowlist_required', 'oauth_available', 'app_password_required',
  'spf_status', 'dkim_status', 'dmarc_status', 'smtp_verified', 'imap_verified', 'integration_enabled',
  'oauth_connected', 'oauth_email', 'oauth_display_name', 'oauth_connected_at',
  'oauth_access_token', 'oauth_refresh_token', 'oauth_token_expires'];

async function getEmailOrgConfig() {
  return q1(`SELECT * FROM email_org_config WHERE id = 1`);
}
async function saveEmailOrgConfig(patch) {
  const cols = []; const vals = []; let i = 1;
  for (const k of EMAIL_ORG_COLS) if (k in patch) { cols.push(`${k} = $${i++}`); vals.push(patch[k]); }
  if (cols.length) { vals.push(1); await q(`UPDATE email_org_config SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $${i}`, vals); }
  return getEmailOrgConfig();
}

const EMAIL_ACCT_COLS = ['sender_name', 'sender_email', 'reply_to', 'mailbox_username', 'auth_method', 'connection_status', 'sync_enabled', 'last_sync_at'];
async function getEmailUserAccount(userId) {
  return q1(`
    SELECT user_id, sender_name, sender_email, reply_to, mailbox_username, auth_method,
           connection_status, sync_enabled, last_sync_at, updated_at,
           (secret IS NOT NULL AND secret <> '') AS has_secret
    FROM email_user_account WHERE user_id = $1
  `, [userId]);
}
async function getEmailUserSecret(userId) {
  const row = await q1(`SELECT secret FROM email_user_account WHERE user_id = $1`, [userId]);
  return row ? row.secret : null;
}
async function saveEmailUserAccount(userId, patch) {
  await q(`INSERT INTO email_user_account (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const cols = []; const vals = []; let i = 1;
  for (const k of EMAIL_ACCT_COLS) if (k in patch) { cols.push(`${k} = $${i++}`); vals.push(patch[k]); }
  if (patch.secret != null && patch.secret !== '') { cols.push(`secret = $${i++}`); vals.push(patch.secret); }
  if (cols.length) { vals.push(userId); await q(`UPDATE email_user_account SET ${cols.join(', ')}, updated_at = NOW() WHERE user_id = $${i}`, vals); }
  return getEmailUserAccount(userId);
}

const EMAIL_PREF_COLS = ['signature', 'default_cc', 'default_bcc', 'default_reply_to', 'default_send_mode', 'confirm_before_send', 'sync_frequency'];
async function getEmailUserPrefs(userId) {
  const row = await q1(`SELECT * FROM email_user_prefs WHERE user_id = $1`, [userId]);
  return row || {
    user_id: userId, signature: '', default_cc: '', default_bcc: '', default_reply_to: '',
    default_send_mode: 'draft', confirm_before_send: true, sync_frequency: 'normal',
  };
}
async function saveEmailUserPrefs(userId, patch) {
  await q(`INSERT INTO email_user_prefs (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const cols = []; const vals = []; let i = 1;
  for (const k of EMAIL_PREF_COLS) if (k in patch) { cols.push(`${k} = $${i++}`); vals.push(patch[k]); }
  if (cols.length) { vals.push(userId); await q(`UPDATE email_user_prefs SET ${cols.join(', ')}, updated_at = NOW() WHERE user_id = $${i}`, vals); }
  return getEmailUserPrefs(userId);
}

// Connection Test History — every SMTP/IMAP/domain/mailbox/send test is logged
// so admins and users can see recent verification results on the Settings page.
async function recordEmailTest({ userId, kind, scope, target, ok, message }) {
  try {
    await q(
      `INSERT INTO email_test_log (user_id, kind, scope, target, ok, message) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId || null, kind || null, scope || null, target || null, Boolean(ok), (message || '').slice(0, 500)]
    );
  } catch { /* logging must never break the test itself */ }
}
async function listEmailTests({ userId, limit = 20, adminAll = false } = {}) {
  // Admins see org-scope tests plus everyone's; users see org tests + their own.
  return adminAll
    ? q(`SELECT * FROM email_test_log ORDER BY created_at DESC LIMIT $1`, [limit])
    : q(`SELECT * FROM email_test_log WHERE scope = 'org' OR user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId || '', limit]);
}

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
  queryContactsPage, countContacts, contactFacets, listContactsByIds,
  logCompanyActivity, listCompanyActivity,
  logCrmActivity, listCrmActivity, activeUsers,
  recordEmailReply, listEmailReplies, unreadReplyCount, markRepliesRead,
  listEmailThreads, getEmailThread,
  pool,
  initDb,
  // account intelligence reports
  saveAccountReport, listAccountReports, getAccountReport, deleteAccountReport,
  getAccountResearchCache, setAccountResearchCache, clearAccountResearchCache,
  // events
  getOrCreateEvent, listEvents,
  // accounts
  getOrCreateAccount, getAccount, findAccountByName, contactCountsByAccountNames, listAccounts, listAccountGroups, getAccountContacts,
  listCompaniesForAccount, mergeAccounts,
  // companies
  upsertCompany, findCompanyByName, getCompany, listCompanies, listCompanySummaries, getCompanyContacts,
  // contacts
  insertContact, listContacts, getContact, listContactsByCompany, deleteContact, deleteContacts,
  updateContact, updateContactDraft, findExistingContact, upsertContact, splitName,
  searchContacts, filterContacts, patchContactCrmFields, logContactActivity, listContactActivity,
  listContactNamesForBrowse,
  // business cards
  insertBusinessCard, listBusinessCardsForContact,
  // apollo
  getApolloCache, setApolloCache, getCompanySearchCache, getCompanySearchCaches, setCompanySearchCache,
  updateCachedLeadDraft, logApolloResult, listApolloResults,
  // email drafts
  insertEmailDraftVersion, listEmailDraftsForContact, findLatestDraftForContact,
  // communications (unified timeline)
  insertCommunication, listTimelineForContact, getCommunication,
  getAttachmentsWithDataForCommunication, markCommunicationSend,
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
  getSetting, setSetting,
  // customer intelligence: tag taxonomy + SKQ product-capability matrix
  getTaxonomy, listTagCategories, listTags,
  upsertSkqModule, upsertSkqSystem, upsertSkqEquipment,
  listSkqModules, listSkqSystems, listSkqEquipment,
  // customer intelligence: company/contact tags
  shouldReplaceWithSuggestion, PROTECTED_TAG_SOURCES,
  listCompanyTags, applyCompanyTagSuggestions, setCompanyTagStatus,
  addManualCompanyTag, removeCompanyTag,
  listResearchSources, setCompanyResearch, markIntelligenceReviewed, getCompanyIntelligence,
  missingCompanyCategories, getIntelReviewPeriodDays,
  listContactTags, setContactTagStatus, addManualContactTag, removeContactTag,
  getContactCompanyIntelligence, tagTier, matchSkqForTags,
  mergeCompanyIntelligence, findDuplicateCompanies,
  // AI usage log + budgets + reporting
  recordAiUsage, aiUsageTotals, aiUsageByFeature, aiUsageByCompany,
  estimateAiSaved, getAiBudget, setAiBudget,
  seedAiModelPricing, listActivePricing, buildPeriodFilter,
  aiUsageKpis, aiUsageTimeseries, aiUsageFeatureBreakdown, aiUsageByModel, aiUsageByUser, aiUsageEvents,
  aiChatSummary, aiChatByModel, CHAT_SUMMARY_SQL, CHAT_BY_MODEL_SQL,
  createChatThread, getChatThread, listChatThreads, listChatMessages, recentChatMessages,
  addChatMessage, setChatThreadTitle, setChatThreadArchived, deleteChatThread,
  setChatThreadSummary, chatThreadUsage,
  // email configuration
  getEmailOrgConfig, saveEmailOrgConfig,
  getEmailUserAccount, getEmailUserSecret, saveEmailUserAccount,
  getEmailUserPrefs, saveEmailUserPrefs,
  recordEmailTest, listEmailTests
};
