const config = require('./config');
const qr = require('./qwenResearch.js');
const EM = require('./public/execution-manifest.js');

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const {
  initDb,
  insertContact, listContacts, getContact, listContactsByCompany, deleteContact, deleteContacts,
  updateContactDraft, findExistingContact, upsertContact, updateContact,
  upsertCompany, findCompanyByName, getCompany, listCompanies, listCompanySummaries, getCompanyContacts,
  getOrCreateAccount, getAccount, findAccountByName, contactCountsByAccountNames, listAccounts, listAccountGroups, getAccountContacts,
  listCompaniesForAccount, mergeAccounts,
  insertBusinessCard, listBusinessCardsForContact,
  getApolloCache, setApolloCache,
  getCompanySearchCache, getCompanySearchCaches, setCompanySearchCache, updateCachedLeadDraft,
  logApolloResult, listApolloResults,
  insertEmailDraftVersion, listEmailDraftsForContact,
  insertCommunication, listTimelineForContact, getCommunication,
  getAttachmentsWithDataForCommunication, markCommunicationSend,
  updateCommunication, deleteCommunication, duplicateCommunication, findDuplicateEmail,
  getCurrentDraftForContact, listDraftVersionsForContact, saveDraftEdit,
  setCommunicationStatus, trashCommunication, restoreCommunication,
  archiveCommunication, unarchiveCommunication, createFollowUp, checkEquivalentDraft,
  listDraftCategoriesForContact,
  insertManualEmail, listImportedEmailsForContact,
  uploadOneOffAttachment, linkAttachmentToCommunication, listAttachmentsForCommunication,
  unlinkAttachment, getAttachment,
  createLibraryAttachment, replaceLibraryAttachment, listAttachmentLibrary,
  listLibraryVersions, toggleLibraryFavorite, deleteLibraryItem,
  insertEmailHistory, listEmailHistoryForContact, listNeedsReviewEmails,
  listRecentEmailHistory, updateEmailHistory,
  findContactByEmail, findContactByEmailDomain, findCompanyByDomain, countNeedsReviewEmails,
  searchContacts, filterContacts, patchContactCrmFields, logContactActivity, listContactActivity,
  listContactNamesForBrowse,
  getSetting, setSetting, listEvents,
  queryContactsPage, countContacts, contactFacets, listContactsByIds,
  logCompanyActivity, listCompanyActivity, logCrmActivity, listCrmActivity, activeUsers,
  recordEmailReply, listEmailReplies, unreadReplyCount, markRepliesRead,
  listEmailThreads, getEmailThread, pool
} = require('./db');
const { normalizeColumnFilters, describeFilters, EMAIL_MODES, ACTIVITY_STATES, DRAFT_STATES, CONTACT_STATUSES, CONTACT_SOURCES, EMAIL_SOURCES, COMPANY_SOURCES } = require('./contact-query');
const { parseCardText } = require('./parse');
const {
  isConfigured: apolloConfigured,
  buildCacheKey,
  fetchApolloPerson,
  summarizeApolloPerson,
  extractApolloEmail,
  revealPersonEmail
} = require('./apollo');
const { doCompanySearch, CRM_FIELDS } = require('./leads');
const { DEPARTMENT_TAXONOMY, SENIORITY_TAXONOMY } = require('./contactClassify');
const {
  draftEmail, listDraftModes, categorizeEmail, EMAIL_CATEGORIES, buildPromptForMode, CLAUDE_MODEL,
  DRAFT_LENGTHS, DRAFT_TONES, DRAFT_LANGUAGES, DRAFT_CTAS, normalizeDraftOptions, draftOptionsSignature,
} = require('./claude');
const { contactsToCsv, contactsToXml, contactsToXlsx, safeFilename } = require('./export');
const { parseCompanyFile } = require('./companyImport');
const { normalizeFileToImages } = require('./cardBatch');
const { costDetail } = require('./usage');
const { getUsage, resetUsage, recordAiEvent, setPersist, setPricingTable,
  setPricingLoader, refreshPricing, pricingStatus } = require('./usage');
const { activeEmailModel } = require('./emailModel');
const { listEmailModelChoices, DEFAULT_EMAIL_MODEL_ID } = require('./config');
const emailSvc = require('./email');
const accountResearch = require('./accountResearch');
const providers = require('./providers');
const {
  recordAiUsage, aiUsageTotals, aiUsageByFeature, aiUsageByCompany, estimateAiSaved,
  getAiBudget, setAiBudget, listActivePricing, buildPeriodFilter,
  aiUsageKpis, aiUsageTimeseries, aiUsageFeatureBreakdown, aiUsageByModel, aiUsageByUser, aiUsageEvents,
  aiChatSummary, aiChatByModel,
  createChatThread, getChatThread, listChatThreads, listChatMessages, recentChatMessages,
  addChatMessage, setChatThreadTitle, setChatThreadArchived, deleteChatThread,
  setChatThreadSummary, chatThreadUsage,
  getEmailOrgConfig, saveEmailOrgConfig, getEmailUserAccount, getEmailUserSecret, saveEmailUserAccount,
  getEmailUserPrefs, saveEmailUserPrefs, recordEmailTest, listEmailTests,
  getTaxonomy, getCompanyIntelligence, listCompanyTags, applyCompanyTagSuggestions,
  setCompanyTagStatus, addManualCompanyTag, removeCompanyTag,
  setCompanyResearch, markIntelligenceReviewed, missingCompanyCategories,
  listContactTags, setContactTagStatus, addManualContactTag, removeContactTag,
  getContactCompanyIntelligence, tagTier, matchSkqForTags,
  mergeCompanyIntelligence, findDuplicateCompanies,
  listSkqModules, listSkqSystems, listSkqEquipment
} = require('./db');
const { researchCompanyTags } = require('./research');
/* Namespace import for the research-job helpers: server.js otherwise
   destructures db, and the job lifecycle is easier to read qualified. */
const jobsDb = require('./db.js');
const chat = require('./chat');
const { runChat, SUGGESTIONS } = chat;
const { parsePageContext } = require('./chatContext');

const app = express();
app.set('trust proxy', true); // so req.protocol is https behind Render's proxy (OAuth redirect URIs)
const PORT = config.PORT;

// Persist every AI usage event (recorded via usage.recordAiEvent) to the DB.
setPersist(recordAiUsage);

// Short-lived OAuth state store (CSRF protection for the connect flow).
const _oauthStates = new Map();
function baseUrl(req) { return `${req.protocol}://${req.get('host')}`; }

// Budget guard: block a new AI call when the daily or monthly token budget is
// already exceeded. Returns null when allowed, or an { error } object to send.
async function checkAiBudget() {
  try {
    const budget = await getAiBudget();
    // Warn-only unless the admin explicitly enabled a hard limit — never
    // interrupt critical work by default.
    if (!budget.hard_limit) return null;
    const anyLimit = budget.daily_token_budget || budget.monthly_token_budget || budget.daily_cost_budget || budget.monthly_cost_budget;
    if (!anyLimit) return null;
    const [today, month] = await Promise.all([aiUsageTotals('today'), aiUsageTotals('month')]);
    if (budget.daily_token_budget && today.total_tokens >= budget.daily_token_budget) {
      return { error: 'Daily AI token budget reached (hard limit)', scope: 'daily_tokens', used: today.total_tokens, budget: budget.daily_token_budget };
    }
    if (budget.monthly_token_budget && month.total_tokens >= budget.monthly_token_budget) {
      return { error: 'Monthly AI token budget reached (hard limit)', scope: 'monthly_tokens', used: month.total_tokens, budget: budget.monthly_token_budget };
    }
    if (budget.daily_cost_budget && today.cost_usd >= budget.daily_cost_budget) {
      return { error: 'Daily AI cost budget reached (hard limit)', scope: 'daily_cost', used: today.cost_usd, budget: budget.daily_cost_budget };
    }
    if (budget.monthly_cost_budget && month.cost_usd >= budget.monthly_cost_budget) {
      return { error: 'Monthly AI cost budget reached (hard limit)', scope: 'monthly_cost', used: month.cost_usd, budget: budget.monthly_cost_budget };
    }
    return null;
  } catch { return null; }
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

// -----------------------------------------------------------------------
// Optional login gate -- HTTP Basic Auth, credentials via env vars only
// (APP_USERNAME / APP_PASSWORD). If either is unset, auth is skipped
// entirely.
// -----------------------------------------------------------------------
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// A stable id for this server process (the "session" the footer shows).
const SERVER_SESSION_ID = crypto.randomUUID();
// Who/what to attribute AI usage to on a given request.
const _seenToday = new Map();
function reqUser(req) { return (req && req.appUser) || config.APP_USERNAME || 'local'; }
// Admin = the login-gate user, or any user listed in ADMIN_USERS. With no login
// gate configured (local dev), the single user is treated as admin.
function isAdmin(req) {
  if (!config.isLoginGateConfigured()) return true;
  const u = reqUser(req);
  const admins = String(process.env.ADMIN_USERS || config.APP_USERNAME || '').split(',').map((s) => s.trim()).filter(Boolean);
  return admins.includes(u) || u === config.APP_USERNAME;
}

app.use((req, res, next) => {
  const expectedUser = config.APP_USERNAME;
  const expectedPass = config.APP_PASSWORD;
  if (!expectedUser || !expectedPass) return next();

  // Health check must stay public so Render's probe can reach it without creds.
  if (req.path === '/healthz') return next();

  /* The research engine is a server, not a signed-in human, so it cannot present
     Basic credentials. Its callback carries the shared service key instead and
     verifies it itself — see the route, which rejects anything that does not
     match in constant time. Skipping the human gate here is what lets a finished
     report reach Neon with no browser involved. */
  if (req.path === '/api/qwen-research/callback') return next();

  const header = req.headers.authorization || '';
  let user = '';
  let pass = '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx !== -1) {
        user = decoded.slice(0, idx);
        pass = decoded.slice(idx + 1);
      }
    } catch { /* malformed header -- falls through as invalid */ }
  }

  const valid = timingSafeStringEqual(user, expectedUser) && timingSafeStringEqual(pass, expectedPass);
  if (!valid) {
    res.set('WWW-Authenticate', 'Basic realm="Lead Finder"');
    return res.status(401).send('Login required.');
  }
  req.appUser = user; // attribute AI usage to the logged-in user
  /* One session marker per user per day. Enough to answer "who used the
     platform" without recording every request, which would turn an adoption
     metric into a keystroke log. */
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (_seenToday.get(user) !== today) {
      _seenToday.set(user, today);
      logCrmActivity({ actor: user, action: 'session.start', metadata: { date: today } });
    }
  } catch (e) { /* never block a request to record a metric */ }
  next();
});

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Account Intelligence Report generator (its own tab in the SPA) ──────────
// Mounted under /account-research so its API surface can never collide with
// this app's own /api/* routes. It inherits the Basic Auth gate above.
app.use('/account-research', accountResearch.createRouter(require('./db')));
// Export libraries served locally — the ported UI must not depend on a CDN.
for (const [route, pkg] of [
  ['pptxgenjs', 'pptxgenjs/dist'], ['docx', 'docx/dist'],
  ['jspdf', 'jspdf/dist'], ['html2canvas', 'html2canvas/dist'],
]) {
  app.use(`/account-research/vendor/${route}`, express.static(path.join(__dirname, 'node_modules', pkg)));
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, status: 'healthy' });
});

// --- OCR worker: created once at startup and reused for every scan ---
let ocrWorker = null;
let ocrWorkerError = null;

async function initOcrWorker() {
  try {
    ocrWorker = await Tesseract.createWorker('eng');
    console.log('OCR worker ready.');
  } catch (err) {
    ocrWorkerError = err;
    console.error('Failed to initialize OCR worker:', err.message);
  }
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server stays up):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stays up):', err);
});

// =========================================================================
// Scan Business Card (shared core: OCR + enrichment, no saving)
// =========================================================================

async function processCardImage(imageDataUrl) {
  if (!ocrWorker) {
    const detail = ocrWorkerError
      ? `OCR engine failed to start: ${ocrWorkerError.message}`
      : 'OCR engine is still starting up, try again in a few seconds.';
    const err = new Error(detail);
    err.statusCode = 503;
    throw err;
  }

  const { data } = await ocrWorker.recognize(imageDataUrl);
  const rawText = data.text || '';
  const fields = parseCardText(rawText);

  let apolloRaw = null;
  let apolloFromCache = false;
  let apolloFromSavedContact = false;
  let apolloPersonId = '';
  let matchedContactId = null;

  const existingContact = await findExistingContact(fields.email, fields.full_name, fields.company, fields.linkedin_url);
  if (existingContact) {
    matchedContactId = existingContact.id;
    apolloFromSavedContact = true;
    apolloPersonId = existingContact.apollo_person_id || '';

    fields.job_title = fields.job_title || existingContact.job_title;
    fields.email = fields.email || existingContact.email;
    fields.website = fields.website || existingContact.website;
    fields.linkedin_url = fields.linkedin_url || existingContact.linkedin_url;
    fields.company = fields.company || existingContact.company;
    fields.address = fields.address || existingContact.address;

    if (existingContact.apollo_raw_json) {
      apolloRaw = JSON.parse(existingContact.apollo_raw_json);
    }
  }

  if (!apolloFromSavedContact && apolloConfigured()) {
    const cacheKey = buildCacheKey(fields);
    const cached = await getApolloCache(cacheKey);

    if (cached) {
      apolloRaw = JSON.parse(cached.raw_json);
      apolloFromCache = true;
    } else {
      apolloRaw = await fetchApolloPerson(fields);
      if (apolloRaw && cacheKey) await setApolloCache(cacheKey, JSON.stringify(apolloRaw));
    }

    const summary = summarizeApolloPerson(apolloRaw);
    if (summary) {
      apolloPersonId = summary.person_id;
      fields.job_title = fields.job_title || summary.title;
      fields.email = fields.email || summary.email;
      fields.linkedin_url = summary.linkedin_url || '';
      fields.company = fields.company || summary.organization_name;
      if (!fields.address && (summary.city || summary.state || summary.country)) {
        fields.address = [summary.city, summary.state, summary.country].filter(Boolean).join(', ');
      }
    }
  } else if (apolloFromSavedContact) {
    const summary = summarizeApolloPerson(apolloRaw);
    if (summary) {
      fields.job_title = fields.job_title || summary.title;
      fields.linkedin_url = fields.linkedin_url || summary.linkedin_url || '';
      if (!fields.address && (summary.city || summary.state || summary.country)) {
        fields.address = fields.address || [summary.city, summary.state, summary.country].filter(Boolean).join(', ');
      }
    }
  }

  return {
    fields,
    rawText,
    enriched: Boolean(apolloRaw),
    enrichedFromCache: apolloFromCache,
    enrichedFromSavedContact: apolloFromSavedContact,
    matchedContactId,
    apolloPersonId,
    apolloRaw
  };
}

// POST /api/scan  { image: "data:image/jpeg;base64,...." }
app.post('/api/scan', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    const result = await processCardImage(image);

    res.json({
      ok: true,
      fields: result.fields,
      enriched: result.enriched,
      enrichedFromCache: result.enrichedFromCache,
      enrichedFromSavedContact: result.enrichedFromSavedContact,
      matchedContactId: result.matchedContactId,
      apolloPersonId: result.apolloPersonId,
      apolloRaw: result.apolloRaw,
      _imageForCard: image,
      _ocrTextForCard: result.rawText
    });
  } catch (err) {
    console.error('OCR error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to scan image' });
  }
});

// POST /api/scan-batch-file  (multipart/form-data, field name "file")
app.post('/api/scan-batch-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file field in request' });

    const { event, booth_number, meeting_date, assigned_salesperson } = req.body || {};

    let images;
    try {
      images = await normalizeFileToImages(req.file.buffer, req.file.originalname, req.file.mimetype);
    } catch (err) {
      return res.status(400).json({ error: `Failed to process file: ${err.message}` });
    }

    const results = [];
    for (const img of images) {
      try {
        const processed = await processCardImage(img.imageDataUrl);
        const { fields } = processed;

        const payload = {
          ...fields,
          source: 'business_card',
          email_source: fields.email ? 'business_card' : 'none',
          apollo_person_id: processed.apolloPersonId || '',
          apollo_raw_json: processed.apolloRaw ? JSON.stringify(processed.apolloRaw) : '',
          apollo_enriched_at: processed.apolloRaw ? new Date().toISOString() : '',
          event_name: event || '',
          booth_number: booth_number || '',
          meeting_date: meeting_date || '',
          assigned_salesperson: assigned_salesperson || ''
        };

        const { id, updated } = await upsertContact(payload);
        await insertBusinessCard(id, img.imageDataUrl, processed.rawText, JSON.stringify(fields));
        await logContactActivity(id, 'business_card_scan', updated
          ? `Updated via batch scan (${img.pageLabel})`
          : `Created via batch scan (${img.pageLabel})`);

        results.push({
          pageLabel: img.pageLabel,
          success: true,
          contactId: id,
          updated,
          full_name: fields.full_name,
          company: fields.company,
          email: fields.email,
          enriched: processed.enriched,
          matchedContactId: processed.matchedContactId
        });
      } catch (err) {
        results.push({ pageLabel: img.pageLabel, success: false, error: err.message });
      }
    }

    res.json({ ok: true, filename: req.file.originalname, results });
  } catch (err) {
    console.error('Batch scan error:', err);
    res.status(500).json({ error: 'Batch scan failed', details: err.message });
  }
});

// POST /api/contacts  -> save/update a confirmed scanned contact (dedup-safe)
app.post('/api/contacts', async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.apollo_raw_json && !payload.apollo_enriched_at) {
      payload.apollo_enriched_at = new Date().toISOString();
    }
    const cardImage = payload._cardImage;
    const cardOcrText = payload._cardOcrText;
    delete payload._cardImage;
    delete payload._cardOcrText;

    const { id, updated } = await upsertContact(payload);

    if (cardImage || cardOcrText) {
      await insertBusinessCard(id, cardImage || '', cardOcrText || '', JSON.stringify(payload));
      await logContactActivity(id, 'business_card_scan', updated ? 'Updated via a new business card scan' : 'Created from a business card scan');
    } else {
      await logContactActivity(id, updated ? 'updated' : 'created', `Source: ${payload.source || 'manual'}`);
    }

    res.json({ ok: true, id, updated });
  } catch (err) {
    console.error('Insert error:', err);
    res.status(500).json({ error: 'Failed to save contact', details: err.message });
  }
});

// GET /api/contacts
/* GET /api/contacts — the CRM data grid.

   Filtering, sorting, counting and paging all happen in Postgres; the
   response carries one page plus the true total, so the browser never
   holds the whole table. Sidebar filters arrive as flat query params (as
   they always have); the Excel-style column filters arrive as one JSON
   blob in `columns`, because they are structured and nesting them into
   query params would be a worse encoding of the same tree. */
function gridFiltersFromQuery(query) {
  const {
    q, event, company, industry, follow_up_status, assigned_salesperson,
    accounts, contact_ids, department_categories, seniority_levels,
    show_event, booth_categories, company_sources, columns,
  } = query;

  const split = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

  let parsedColumns = {};
  if (columns) {
    // A malformed blob must narrow nothing rather than 500 the grid.
    try { parsedColumns = normalizeColumnFilters(JSON.parse(columns)); }
    catch { parsedColumns = {}; }
  }

  return {
    q: q ? String(q).trim() : '',
    event, company, industry, follow_up_status, assigned_salesperson,
    accounts: split(accounts),
    contact_ids: split(contact_ids).map(Number).filter(Number.isInteger),
    department_categories: split(department_categories),
    seniority_levels: split(seniority_levels),
    show_event,
    booth_categories: split(booth_categories),
    company_sources: split(company_sources),
    columns: parsedColumns,
  };
}

app.get('/api/contacts', async (req, res) => {
  try {
    const filters = gridFiltersFromQuery(req.query);
    const sort = req.query.sort
      ? { column: String(req.query.sort), direction: req.query.dir === 'asc' ? 'asc' : 'desc' }
      : null;

    // Legacy callers (dashboard counts, the import contact picker) pass no
    // page and expect a plain list, so the default page size stays where
    // listContacts() had it. The grid always sends its own.
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize || req.query.limit) || 200));
    const page = Math.max(1, Number(req.query.page) || 1);

    const [contacts, total] = await Promise.all([
      queryContactsPage(filters, sort, page, pageSize),
      countContacts(filters),
    ]);

    const enriched = contacts.map((c) => {
      const draftCount = Number(c.draft_count) || 0;
      return {
        ...c,
        draft_count: draftCount,
        latest_draft_id: c.latest_draft_id || null,
        has_draft: Boolean(c.draft_subject) || draftCount > 0,
      };
    });

    res.json({
      ok: true,
      contacts: enriched,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      sort,
      chips: describeFilters(filters.columns),
    });
  } catch (err) {
    console.error('List contacts error:', err);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

/* GET /api/contacts/facets?column=… — the option counts inside one column
   menu, computed against every other active filter. Lets the menu show
   "Reply received (0)" instead of offering a filter that silently returns
   nothing. */
app.get('/api/contacts/facets', async (req, res) => {
  try {
    const column = String(req.query.column || '');
    const filters = gridFiltersFromQuery(req.query);
    filters.facetSearch = req.query.search || '';
    res.json({ ok: true, column, options: await contactFacets(filters, column) });
  } catch (err) {
    console.error('Facets error:', err);
    res.status(500).json({ error: 'Failed to load filter options' });
  }
});

/* GET /api/contacts/grid-vocab — the option lists and their labels, so the
   menus are built from the same vocabulary the SQL is keyed by. */
app.get('/api/contacts/grid-vocab', (req, res) => {
  res.json({
    ok: true,
    email: EMAIL_MODES,
    activity: ACTIVITY_STATES,
    draft: DRAFT_STATES,
    status: CONTACT_STATUSES,
    source: CONTACT_SOURCES,
    emailSource: EMAIL_SOURCES,
    companySource: COMPANY_SOURCES,
  });
});

/* GET /api/companies/:id/activity — the company audit trail: how it was
   discovered, and any later correction to that record. */
app.get('/api/companies/:id/activity', async (req, res) => {
  try {
    res.json({ ok: true, activity: await listCompanyActivity(Number(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load company activity' });
  }
});

/* GET /api/companies/source-counts — how many companies came from each
   discovery path. Drives the Companies filter and answers "how much of the
   CRM can we actually trace". */
app.get('/api/companies/source-counts', async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT COALESCE(source, 'legacy') AS key, COUNT(*)::int AS n FROM companies GROUP BY 1 ORDER BY n DESC`);
    res.json({ ok: true, options: rows.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load company source counts' });
  }
});

/* ── The SKQ AI Assistant ──────────────────────────────────────────────────

   POST /api/chat  — one turn of conversation.

   Mounted below the auth middleware like every other route, so it inherits the
   same login gate; there is nothing extra to remember and no second way in.

   The model never reaches the database except through chatTools, and there is
   no write tool in that catalogue — not a guarded one, none — so no prompt can
   reach an action. Everything here is read-only by construction rather than by
   permission check. */
/* ── assistant conversations ───────────────────────────────────────────────
   Every route below scopes on reqUser(req) and takes 404 as the answer to
   "not yours". Today the login gate validates one shared credential, so that
   identity is the SKQ workspace rather than a person — the UI says "Chat
   History" and not "my chats" for exactly that reason. The scoping is in
   place regardless, so introducing real accounts later is an auth change and
   not a rewrite of this feature.

   A thread id arrives as a string from JSON and goes into a bigint column.
   Parsed strictly here, once, so no route has to think about it again — and
   so "12abc" or "1 OR 1=1" is a 400 rather than anything more interesting. */
function toThreadId(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Folds turns that have dropped out of the context window into the digest.
 *
 * Only past a threshold, and only ever forward: the digest covers everything
 * up to summary_upto_message_id and the window covers everything after it, so
 * a turn is in exactly one of them and never in neither.
 */
const CHAT_COMPACT_AFTER = 24;
async function compactThread(user, threadId) {
  const t = await getChatThread(user, threadId);
  if (!t || t.message_count < CHAT_COMPACT_AFTER) return;
  const all = await listChatMessages(user, threadId, { limit: 500 });
  const keep = chat.MAX_HISTORY;
  const older = all.slice(0, Math.max(0, all.length - keep));
  if (!older.length) return;
  const upto = older[older.length - 1].id;
  if (t.summary_upto_message_id && Number(t.summary_upto_message_id) >= Number(upto)) return;
  await setChatThreadSummary(user, threadId, chat.digest(older), upto);
}

app.get('/api/chat/threads', async (req, res) => {
  try {
    const rows = await listChatThreads(reqUser(req), {
      q: req.query.q || null,
      archived: req.query.archived === '1' || req.query.archived === 'true',
      limit: parseInt(req.query.limit, 10) || 40,
      offset: parseInt(req.query.offset, 10) || 0,
    });
    res.json({ ok: true, threads: rows });
  } catch (err) {
    console.error('[chat] thread list failed:', err.message);
    res.status(500).json({ error: 'Could not load conversations.' });
  }
});

app.get('/api/chat/threads/:id', async (req, res) => {
  const id = toThreadId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad conversation id.' });
  try {
    const user = reqUser(req);
    const thread = await getChatThread(user, id);
    if (!thread) return res.status(404).json({ error: 'Conversation not found.' });
    const messages = await listChatMessages(user, id, { limit: 200 });
    res.json({ ok: true, thread, messages });
  } catch (err) {
    console.error('[chat] thread read failed:', err.message);
    res.status(500).json({ error: 'Could not load that conversation.' });
  }
});

// Rename, archive and unarchive. One route because they are one row.
app.patch('/api/chat/threads/:id', async (req, res) => {
  const id = toThreadId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad conversation id.' });
  const user = reqUser(req);
  try {
    let out = null;
    if (typeof req.body.title === 'string') {
      const title = req.body.title.trim();
      if (!title) return res.status(400).json({ error: 'A name cannot be empty.' });
      out = await setChatThreadTitle(user, id, title, 'user');
    }
    if (typeof req.body.archived === 'boolean') {
      out = await setChatThreadArchived(user, id, req.body.archived);
    }
    if (!out) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ ok: true, thread: out });
  } catch (err) {
    console.error('[chat] thread update failed:', err.message);
    res.status(500).json({ error: 'Could not update that conversation.' });
  }
});

// Soft. The row and its messages stay; nothing here destroys a conversation.
app.delete('/api/chat/threads/:id', async (req, res) => {
  const id = toThreadId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad conversation id.' });
  try {
    const gone = await deleteChatThread(reqUser(req), id);
    if (!gone) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[chat] thread delete failed:', err.message);
    res.status(500).json({ error: 'Could not delete that conversation.' });
  }
});

// What one conversation cost, read from the usage events already recorded.
app.get('/api/chat/threads/:id/usage', async (req, res) => {
  const id = toThreadId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad conversation id.' });
  try {
    const user = reqUser(req);
    if (!await getChatThread(user, id)) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ ok: true, usage: await chatThreadUsage(user, id) });
  } catch (err) {
    console.error('[chat] thread usage failed:', err.message);
    res.status(500).json({ error: 'Could not load usage for that conversation.' });
  }
});

app.post('/api/chat', async (req, res) => {
  if (!config.isChatConfigured()) {
    return res.status(503).json({ error: 'The assistant is not configured.' });
  }

  // The same budget gate every other AI feature goes through.
  const blocked = await checkAiBudget();
  if (blocked) return res.status(429).json(blocked);

  const started = Date.now();
  const pageContext = parsePageContext(req.body && req.body.pageContext);
  const user = reqUser(req);

  try {
    /* ── which conversation is this? ───────────────────────────────────────
       A request with no thread_id behaves exactly as it always has, which is
       what keeps an older client working against this build. A thread_id that
       is not this user's resolves to nothing and 404s — never 403, which
       would confirm the row exists. */
    const askedThread = toThreadId(req.body && req.body.thread_id);
    let thread = null;
    if (askedThread) {
      thread = await getChatThread(user, askedThread);
      if (!thread) return res.status(404).json({ error: 'Conversation not found.' });
      if (thread.archived_at) {
        return res.status(409).json({ error: 'This conversation is archived. Unarchive it to continue.' });
      }
    }

    const incoming = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    const latest = incoming.length ? incoming[incoming.length - 1] : null;
    const question = latest && latest.role === 'user' ? String(latest.content || '').trim() : '';
    if (!question) return res.status(400).json({ error: 'Ask a question to begin.' });

    /* Where the conversation so far comes from.

       For a KNOWN thread: the database, never the request. The browser's copy
       is a rendering of the conversation, not the record of it. Reading it
       back from the client would let an edited transcript be replayed at the
       model — put words in the assistant's mouth and then ask it to build on
       them — and would break anyway the moment the same thread is open on a
       phone and a laptop at once.

       With NO thread, the client's array is used exactly as it always was.
       That is the pre-threading contract and it stays intact, so an older
       build of the panel keeps working against this server. Nothing is being
       protected by refusing it either: a first turn has no stored history to
       contradict, and anyone who can post here can simply ask the question. */
    let history = Array.isArray(incoming) && incoming.length
      ? incoming
      : [{ role: 'user', content: question }];
    let summary = null;
    if (thread) {
      const prior = await recentChatMessages(user, thread.id, chat.MAX_HISTORY - 1);
      history = prior.map((m) => ({ role: m.role, content: m.content }))
        .concat([{ role: 'user', content: question }]);
      summary = thread.summary || null;
    }

    const result = await runChat({
      messages: history,
      pageContext,
      modelId: req.body && req.body.modelId,
      summary,
      // Only ever on the first exchange, and never over a name a human chose.
      needTitle: !thread || (!thread.title && thread.title_source !== 'user'),
    });

    /* Recorded whether it succeeded or not. A failed turn still cost tokens if
       it got as far as the provider, and a feature whose failures are invisible
       looks cheaper and more reliable than it is. `chat` is its own feature so
       it never mixes with email_draft or account_research in Analytics. */
    /* Awaited, unlike everywhere else. cost_estimated is written onto the row
       once and never recomputed, so a turn recorded against a stale card keeps
       the wrong confidence label for good. A no-op unless the card is older
       than the TTL, and the query behind it reads ten rows. */
    try { await refreshPricing(); } catch { /* refreshPricing never rejects */ }

    /* The thread is created only once the model has actually answered, so a
       provider outage does not litter the history drawer with empty
       conversations nobody started. */
    if (result.ok && !thread) {
      thread = await createChatThread(user, result.title || chat.fallbackTitle(question));
    }

    const u = result.usage || {};
    recordAiEvent({
      feature: 'chat',
      // Ties spend to a conversation. Nullable, and written only here — the
      // drafting and research events keep leaving it NULL.
      thread_id: thread ? thread.id : null,
      /* A refused turn is labelled as such rather than as 'no_tools', so the
         guard's rate is visible in Analytics. A model that starts refusing
         often is a model that has stopped calling tools, and that should be
         findable without reading transcripts. */
      sub_feature: result.refused
        ? 'grounding_refused'
        : ((result.toolCalls || []).map((t) => t.name).slice(0, 4).join('+') || 'no_tools'),
      outcome: result.ok ? 'success' : 'error',
      status: result.ok ? 'success' : 'error',
      error_message: result.ok ? null : String(result.error || '').slice(0, 300),
      // The model that answered, and the one we asked for. Both, because
      // within Bailian they differ by 10× in price and not at all in provider.
      model: u.model || null,
      provider: u.provider || null,
      requested_provider: u.requested_provider || null,
      requested_model: u.requested_model || null,
      fell_back: Boolean(u.fell_back),
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_read_tokens: u.cache_read_tokens || 0,
      reasoning_tokens: u.reasoning_tokens || 0,
      /* Every model call the turn made, including tool rounds and any attempt
         that was billed and then failed. recordAiEvent prices each with its
         own card and sums them, so a fallback turn costs what it cost rather
         than what the winning model would have charged for all of it. */
      attempts: u.attempts || null,
      response_ms: u.response_ms || (Date.now() - started),
      company_id: pageContext && pageContext.companyId ? pageContext.companyId : null,
      contact_id: pageContext && pageContext.contactId ? pageContext.contactId : null,
      user_id: reqUser(req), session_id: SERVER_SESSION_ID,
      request_id: crypto.randomUUID(),
    });

    if (!result.ok) {
      return res.status(result.status || 502).json({ error: result.error });
    }

    /* Persisted after the answer, both halves together, so a failed turn
       leaves no orphan question in the transcript. Failures here are logged
       and swallowed: losing the archive copy of a message is bad, and refusing
       to show the user an answer they have already paid for is worse. */
    try {
      await addChatMessage(user, thread.id, {
        role: 'user', content: question, page_context: pageContext || null,
      });
      await addChatMessage(user, thread.id, {
        role: 'assistant', content: result.reply,
        tools_used: (result.toolCalls || []).map((t) => t.name),
        entities: result.entities && result.entities.length ? result.entities : null,
        page_context: pageContext || null,
      });
      if (result.title && !thread.title) {
        const named = await setChatThreadTitle(user, thread.id, result.title, 'auto');
        if (named) thread = named;
      }
      await compactThread(user, thread.id);
    } catch (e) {
      console.error('[chat] could not persist the turn:', e.message);
    }

    /* Which tools ran is returned so the panel can show what was consulted —
       an assistant that shows its working is easier to trust and much easier
       to debug. Never the arguments or the rows: those are CRM content. */
    res.json({
      reply: result.reply,
      /* What the user is shown: sources, not function names. The raw names
         stay on the usage event, where they are what you need to debug a
         turn. `consulted` is kept, deduplicated, so nothing that reads it
         breaks — but the panel renders `sources`. */
      sources: result.sources || [],
      consulted: [...new Set((result.toolCalls || []).map((t) => t.name))],
      fell_back: Boolean(u.fell_back),
      thread_id: thread ? thread.id : null,
      title: thread ? thread.title : null,
      entities: result.entities && result.entities.length ? result.entities : undefined,
    });
  } catch (err) {
    console.error('[chat]', err);
    res.status(500).json({ error: 'The assistant could not answer that. Please try again.' });
  }
});

/* GET /api/chat/config — what the panel needs before the first message.
   Deliberately no model string, endpoint or key: the browser learns whether
   the assistant is available and what to suggest, nothing about the plumbing. */
app.get('/api/chat/config', (req, res) => {
  res.json({ available: config.isChatConfigured(), suggestions: SUGGESTIONS });
});

/* Where the standalone Account Research app lives, for the iframe on the
   Account Research page. A URL, not a credential — the standalone app holds its
   own keys and gates its own access. Empty means "not configured", and the tab
   then explains that instead of framing a blank page. */
app.get('/api/account-research/config', (req, res) => {
  res.json({ currentUrl: config.CURRENT_ACCOUNT_RESEARCH_URL });
});

/* ── Account Research (Qwen-based) ────────────────────────────────────────
   Neon is the system of record; the standalone Python engine still runs the
   research and renders the PDFs. Reads never touch the engine, so the report
   library and every saved report keep working when the engine is down or its
   models are not activated.

   A SECOND engine: nothing here reads or writes account_reports. */

// Report library. Served from Neon, so it survives a restart of either app.
/* One vocabulary for session state, derived server-side so every client agrees.

   Recoverable degradation is NEVER reported as failure: a run that produced a
   report is completed_with_limitations, not failed. `failed` and `synthesis_failed`
   mean no report exists. */
/* Recovery used to be inferred from here: the CRM asked the engine about a job,
   read a 404 as "the research service restarted", and closed the row as
   interrupted. That inference produced 24 of the first 46 rows, and it is no
   longer true - the engine reads jobs from this same database, so a job that
   exists is never unknown to it.

   Recovery belongs to the worker's lease now. A lapsed lease is reclaimed by
   another worker within one lease interval, and only a job that has exhausted
   its attempts is failed, by the reaper, with the count in the error text. */

/* THE ONE ACCOUNTING BOUNDARY for Qwen Account Research.

   Every model call the engine actually made - each retrieval search and each
   synthesis attempt - becomes one ai_usage_event under the EXISTING
   account_research feature, priced by the central table with the model that
   actually handled that call. Nothing else in this codebase turns Account
   Research tokens into events; the job's own columns are a projection for
   display and history.

   Idempotent by construction: request_id is deterministic per (job, call) and
   the table has a unique index with ON CONFLICT DO NOTHING. A retried callback,
   a replay, or a retry-save therefore records nothing new - and retry-save
   makes no model call at all, so there is nothing to record. */
/* Fold an execution event into the job's durable manifest.

   Only ever called with facts the engine actually reported. Absolute values, so
   a retried callback is a no-op rather than a doubling, and a failure here can
   never change the outcome of a run - the manifest is a record, not a gate. */
async function updateManifest(jobId, patch, finalize = null) {
  try {
    const current = await jobsDb.getQwenJobManifest(jobId);
    let next = EM.apply(current, patch);
    if (finalize) next = EM.finalize(next, finalize);
    await jobsDb.setQwenJobManifest(jobId, next);
    return next;
  } catch (e) { return null; }
}

function recordResearchUsage(jobId, calls, meta = {}) {
  const rows = Array.isArray(calls) ? calls : [];
  let input = 0, output = 0, total = 0, cost = 0, estimated = false;
  const detail = { retrieval: { calls: 0, input: 0, output: 0 },
                   synthesis: { calls: 0, input: 0, output: 0 } };
  rows.forEach((c, i) => {
    const kind = c.kind === 'synthesis' ? 'synthesis' : 'retrieval';
    const inTok = Number(c.input_tokens) || 0;
    const outTok = Number(c.output_tokens) || 0;
    const tot = Number(c.total_tokens) || (inTok + outTok);
    input += inTok; output += outTok; total += tot;
    detail[kind].calls += 1; detail[kind].input += inTok; detail[kind].output += outTok;
    const priced = recordAiEvent({
      feature: 'account_research',           // NOT a new top-level feature
      sub_feature: kind,                     // retrieval | synthesis
      provider: 'bailian',
      model: c.model || meta.model || null,
      input_tokens: inTok,
      output_tokens: outTok,
      total_tokens: tot,
      status: (c.status && c.status !== 200) ? 'error' : 'success',
      request_type: 'new_call',
      request_id: `arq:${jobId}:${kind}:${i}`,   // deterministic -> idempotent
      company_id: meta.companyId || null,
      user_id: meta.userId || null,
    });
    // recordAiEvent returns { cost_usd, cost_saved_usd, reuse, cost_estimated }.
    if (priced && typeof priced.cost_usd === 'number') cost += priced.cost_usd;
    if (priced && priced.cost_estimated) estimated = true;
  });
  return { input_tokens: input, output_tokens: output, total_tokens: total,
           estimated_cost_usd: cost, cost_estimated: estimated, detail,
           calls: rows.length };
}

/* What cost, if any, we can honestly show for a report.

   Two different things wear two different labels:

   COMPLETE  the run was instrumented, so every retrieval call and every
             synthesis attempt was priced at generation time and summed on the
             job. That is the full Account Research cost.
   SYNTHESIS a historical run, from before retrieval was counted. We still have
             the provider's actual synthesis input/output, so we price THAT and
             say plainly that retrieval is missing. Showing the part we know
             beats showing nothing, as long as it is not called a total.

   The historical figure necessarily uses the CURRENT active price row: no cost
   was stored when those runs happened, so there is no generation-time rate to
   honour. New runs store theirs and are never repriced. */
function costViewFor(report, runUsage) {
  if (runUsage && runUsage.total_tokens != null) {
    return { kind: 'total',
             cost_usd: Number(runUsage.estimated_cost_usd) || 0,
             estimated: runUsage.cost_estimated !== false,
             total_tokens: runUsage.total_tokens };
  }
  const u = (report && report.token_usage) || {};
  const input = Number(u.input) || 0;
  const output = Number(u.output) || 0;
  if (!input && !output) return null;
  const model = (report && (report.model_used || report.model)) || null;
  if (!model) return null;
  const d = costDetail(model, input, output, 0, 0, 'bailian');
  return { kind: 'synthesis', cost_usd: d.cost, estimated: true,
           total_tokens: Number(u.total) || (input + output),
           note: 'retrieval_not_captured' };
}

/* Which states are live, and which are asking for a person.

   'interrupted_before_start' and 'cancelled' are deliberately in NEITHER.
   Nothing is running, and there is nothing to troubleshoot: one run never
   happened and the other was stopped on purpose. Whether those companies still
   want research is a question about the COMPANY, answered by its own state,
   not by a job that never began. */
const SESSION_LIVE_STATES = new Set(['queued', 'researching', 'generating']);
const SESSION_ATTENTION_STATES = new Set(
  ['interrupted', 'save_failed', 'synthesis_failed', 'failed']);

function sessionState(row) {
  const stale = row.stale === true;
  switch (row.status) {
    case 'queued':   return 'queued';
    case 'running':
      if (stale) return 'interrupted';
      return /synthes|model|generat/i.test(row.stage || '') ? 'generating' : 'researching';
    case 'completed':                   return 'completed';
    case 'completed_with_limitations':  return 'completed_with_limitations';
    case 'synthesis_failed':            return 'synthesis_failed';
    // Synthesis SUCCEEDED; only persistence failed. Retryable without paying again.
    case 'save_failed':                 return 'save_failed';
    /* A sweep that ran while this job was WAITING did not interrupt research:
       no worker ever claimed it, so nothing began. The stored status stays
       'interrupted' - this is presentation over the historical facts, and the
       facts are that started_at is null and no attempt was ever made. */
    case 'interrupted':
      return (row.started_at == null && Number(row.attempts || 0) === 0)
        ? 'interrupted_before_start' : 'interrupted';
    /* A person stopped this on purpose. It is history, not a fault: nothing
       failed and nobody needs to look into it. */
    case 'cancelled':                   return 'cancelled';
    default:                            return row.report_id ? 'completed' : 'failed';
  }
}

app.get('/api/aresearch/reports', async (req, res) => {
  try {
    res.json(await qr.listReports(req.query.q));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One stored report, canonical bilingual record included.
app.get('/api/aresearch/reports/:id', async (req, res) => {
  try {
    const got = await qr.getReport(req.params.id);
    if (!got) return res.status(404).json({ error: 'not found' });
    res.json(got);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The company's current report, or 404. This is also existing-report detection.
app.get('/api/aresearch/company/:company', async (req, res) => {
  try {
    /* A session knows which report it produced, so it sends report_id and this
       opens THAT report. Resolving by company name re-derives identity through
       the company key, and when a job and its report were written under a key
       the CRM could not match, a completed session offered Open and the lookup
       came back empty. The id is exact; the name is the fallback for a library
       card, which has no job behind it. */
    const got = req.query.report_id
      ? await qr.getReport(String(req.query.report_id))
      : await qr.getReportForCompany(req.params.company);
    if (!got) return res.status(404).json({ error: 'no report for that company' });
    await refreshPricing();                 // price from the live card, not a stale one
    res.json({ ...got, cost_view: costViewFor(got.report, got.run_usage) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Existing Report vs Generate, for a batch list. Booleans, no versions.
app.get('/api/aresearch/exists', async (req, res) => {
  const names = String(req.query.companies || '').split('||').map((s) => s.trim()).filter(Boolean);
  try {
    res.json(await qr.reportsExist(names));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Delete removes the company's current report. The company then reads as
   having none, and the next run generates fresh research. */
app.post('/api/aresearch/reports/delete', async (req, res) => {
  const body = req.body || {};
  let names = body.companies;
  if (typeof names === 'string') names = [names];
  if (!Array.isArray(names) || !names.length) {
    return res.status(400).json({ error: 'companies is required' });
  }
  try {
    const results = [];
    for (const n of names.slice(0, 200)) {
      results.push({ company: String(n), deleted: await qr.deleteReportForCompany(String(n)) });
    }
    res.json({ ok: true, deleted: results.reduce((a, r) => a + r.deleted, 0), results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Language view of a STORED report. No model call — the engine is used purely
   as the renderer that produced the record. */
app.get('/api/aresearch/render', async (req, res) => {
  const lang = req.query.lang || 'bilingual';
  const format = req.query.format === 'pdf' ? 'pdf' : 'markdown';
  try {
    // report_id is exact and is what a session sends; company is the fallback.
    const got = (req.query.id || req.query.report_id)
      ? await qr.getReport(String(req.query.id || req.query.report_id))
      : await qr.getReportForCompany(req.query.company || '');
    if (!got) return res.status(404).json({ error: 'no stored report' });
    if (format === 'markdown') {
      const out = await qr.renderStored(got.report, lang, 'markdown');
      return res.status(out.status).json(out.data);
    }
    const upstream = await qr.renderStored(got.report, lang, 'pdf');
    if (!upstream.ok) {
      return res.status(502).json({ error: 'PDF renderer unavailable' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    const disp = req.query.inline === '1' ? 'inline' : 'attachment';
    const name = (upstream.headers.get('content-disposition') || '').match(/filename=?"?([^";]+)/);
    res.setHeader('Content-Disposition', `${disp}; filename="${name ? name[1] : 'report.pdf'}"`);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* Combined portfolio PDF and ZIP, built from the records in Neon rather than
   from the engine's disk. The engine renders; the database decides what is in
   the export. No model is called. */
async function streamExport(req, res, path, filename) {
  const body = req.body || {};
  try {
    const records = await qr.recordsFor(body.companies);
    if (!records.length) return res.status(400).json({ error: 'No saved reports to export.' });
    const upstream = await qr.callEngine(path, {
      method: 'POST', raw: true,
      body: { records, lang: body.lang || 'bilingual', title: body.title },
    });
    if (!upstream.ok) return res.status(502).json({ error: 'Renderer unavailable' });
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    const cd = upstream.headers.get('content-disposition') || '';
    const m = cd.match(/filename=?"?([^";]+)/);
    res.setHeader('Content-Disposition', `attachment; filename="${m ? m[1] : filename}"`);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}

app.post('/api/aresearch/export/portfolio', (req, res) =>
  streamExport(req, res, '/api/render-portfolio', 'portfolio.pdf'));
app.post('/api/aresearch/export/zip', (req, res) =>
  streamExport(req, res, '/api/render-zip', 'account_research.zip'));

/* ── Proxy to the research engine ───────────────────────────────────────── */

// Model availability, surfaced as an activation state rather than an error.
app.get('/api/aresearch/models/health', async (req, res) => {
  try {
    const out = await qr.callEngine(`/api/models/health${req.query.probe === '1' ? '?probe=1' : ''}`);
    const models = (out.data && out.data.models) || [];
    res.status(out.status).json({
      ...out.data,
      modelsAvailable: models.some((m) => m.state === 'available'),
      unavailableNotice: models.length && !models.some((m) => m.state === 'available')
        ? qr.MODEL_UNAVAILABLE : null,
    });
  } catch (e) {
    res.status(503).json({ error: e.message, engineConfigured: qr.engineConfigured() });
  }
});

// Start a run. The engine does the research; polling persists the result.
/* ── Engine → CRM callback ────────────────────────────────────────────────
   Server-to-server only, authenticated with the shared service key. This is how
   a finished report reaches Neon: the engine posts it here when the run ends,
   whether or not a browser is open. The browser is no longer part of the
   persistence path at all.

   Mounted OUTSIDE the session-auth wall on purpose — the caller is the engine,
   not a signed-in human — so the service key is the only thing standing in
   front of it and is checked before the body is read for anything else. */
function callbackAuthorised(req) {
  const expected = String(process.env.ACCOUNT_RESEARCH_SERVICE_KEY || '').trim();
  if (!expected) return false;                 // unset means closed, not open
  const got = String(req.get('X-AR-Service-Key') || '').trim();
  if (!got || got.length !== expected.length) return false;
  try {
    return require('crypto').timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch (e) { return false; }
}

app.post('/api/qwen-research/callback', express.json({ limit: '25mb' }), async (req, res) => {
  if (!callbackAuthorised(req)) return res.status(401).json({ error: 'Invalid service key' });
  const b = req.body || {};
  const jobId = String(b.job_id || '').trim();
  if (!jobId) return res.status(400).json({ error: 'job_id is required' });
  try {
    if (b.event === 'progress') {
      // The live view of execution: what is running RIGHT NOW, reported by the
      // engine rather than guessed from the stage or the percentage.
      if (b.execution || b.active) {
        await updateManifest(jobId, Object.assign({}, b.execution || {},
          b.active ? { active: b.active } : {}));
      }
      // A heartbeat. Also what keeps the job from being swept as stale.
      await jobsDb.updateQwenJob(jobId, { status: 'running', stage: b.stage,
                                      progress: b.progress_percent, warning: b.warning });
      return res.json({ ok: true });
    }
    /* Live incremental output. The engine publishes a section as soon as it has
       one, and re-publishes it if a later stage enriches it. Buffered engine-side,
       so this is a handful of writes per run, not one per token. Partial output
       NEVER touches the saved report: that is written only by 'completed'. */
    if (b.event === 'section') {
      const secs = Array.isArray(b.sections) ? b.sections : (b.section ? [b.section] : []);
      if (!secs.length) return res.status(400).json({ error: 'section(s) required' });
      const saved = [];
      for (const sec of secs.slice(0, 40)) {
        if (!sec || !sec.section_key) continue;
        saved.push(await jobsDb.upsertQwenJobSection(jobId, sec));
      }
      // A section arriving is also a heartbeat: it keeps the run off the sweeper.
      await jobsDb.updateQwenJob(jobId, { status: 'running', stage: b.stage || null,
                                          progress: b.progress_percent });
      return res.json({ ok: true, stored: saved.length });
    }
    /* A fresh run for this job starts from a clean slate, so one company's live
       output can never show fragments of its previous attempt. */
    if (b.event === 'sections_reset') {
      await jobsDb.clearQwenJobSections(jobId);
      return res.json({ ok: true });
    }
    if (b.event === 'failed') {
      await jobsDb.failQwenJob(jobId, b.error || 'Research failed.');
      return res.json({ ok: true });           // the previous report is untouched
    }
    /* The one genuinely fatal execution outcome: retrieval succeeded but no model
       could synthesise. Kept distinct from 'failed' so the UI can offer "retry
       synthesis" rather than implying the whole run has to be paid for again. */
    if (b.event === 'synthesis_failed') {
      /* A failed run is not a free run. Retrieval executed and every synthesis
         attempt reached a model, so both were billed; recording nothing here
         made the most expensive outcome look like the cheapest. Same
         deterministic request_ids as the success path, so a later retry that
         completes re-sends the identical retrieval rows and they de-duplicate. */
      try {
        // `job` is bound further down, inside the completed branch, so it must be
        // fetched here rather than closed over - a ReferenceError inside this
        // try would be swallowed and reproduce the very silence being fixed.
        const failedJob = await jobsDb.getQwenJob(jobId);
        const u = recordResearchUsage(jobId, b.ai_usage, {
          companyId: failedJob && failedJob.company_id,
          userId: b.created_by || 'engine',
          model: b.model || (failedJob && failedJob.model),
        });
        if (u.calls) await jobsDb.setQwenJobUsage(jobId, u);
        await updateManifest(jobId, Object.assign({}, b.execution || {}, {
          usage: { model_calls: u.calls || 0, input_tokens: u.input_tokens || 0,
                   output_tokens: u.output_tokens || 0,
                   estimated_cost_usd: u.estimated_cost_usd == null
                     ? null : String(u.estimated_cost_usd),
                   cost_estimated: !!u.cost_estimated },
        }), { accountingComplete: !!(u.detail && u.detail.synthesis
                                     && u.detail.synthesis.calls > 0),
              synthesisFailed: true });
      } catch (e) { /* accounting must never change the outcome of a run */ }
      await jobsDb.failQwenJob(jobId, b.error || 'Synthesis failed after all fallbacks.',
                               'synthesis_failed');
      return res.json({ ok: true });
    }
    if (b.event === 'completed') {
      // ONLY a successful run is persisted, and only here.
      if (!b.record) return res.status(400).json({ error: 'record is required' });
      /* Identity comes from the JOB, established when it was claimed. Never from
         the record: 红旗 supplied hongqi-auto.com and the record resolved to
         pcauto.com.cn. */
      const job = await jobsDb.getQwenJob(jobId);
      let saved = null;
      try {
        saved = await qr.persistRun(b.record, b.created_by || 'engine',
                                    job && job.company_key);
      } catch (e) {
        /* Synthesis SUCCEEDED and only persistence failed. That is not a research
           failure: the work exists and must be retryable without paying for it
           again. The sections published during the run stay in Neon as the
           user-visible copy. */
        const why = `Report generated but saving failed: ${String(e.message).slice(0, 200)}`;
        await jobsDb.failQwenJob(jobId, why, 'save_failed');
        return res.status(500).json({ ok: false, error: why, state: 'save_failed' });
      }
      if (!saved) {
        /* persistRun refuses anything that is not a complete success. Reporting
           ok here would tell the engine the report is safe when nothing was
           written, and the job would read "completed" with no report behind it.
           Fail loudly instead — the engine logs this and the old report stands. */
        const why = 'Report rejected: the record was not a completed successful run '
                  + '(needs company, status 200 and research_result).';
        await jobsDb.failQwenJob(jobId, why);
        return res.status(422).json({ ok: false, error: why });
      }
      /* Accounting runs HERE and only here. Priced with the model that handled
         each call; the totals are then projected onto the job. */
      try {
        const u = recordResearchUsage(jobId, b.ai_usage, {
          companyId: job && job.company_id, userId: b.created_by || 'engine',
          model: b.model,
        });
        if (u.calls) await jobsDb.setQwenJobUsage(jobId, u);
        /* accounting_complete is asserted only when synthesis actually produced
           an accounted call. A run whose synthesis went unrecorded - every run
           before P0-D - must not claim a whole cost. */
        await updateManifest(jobId, Object.assign({}, b.execution || {}, {
          usage: { model_calls: u.calls || 0, input_tokens: u.input_tokens || 0,
                   output_tokens: u.output_tokens || 0,
                   estimated_cost_usd: u.estimated_cost_usd == null
                     ? null : String(u.estimated_cost_usd),
                   cost_estimated: !!u.cost_estimated },
        }), { accountingComplete: !!(u.detail && u.detail.synthesis
                                     && u.detail.synthesis.calls > 0) });
      } catch (e) { /* accounting must never fail a save */ }
      await jobsDb.completeQwenJob(jobId, saved.id, b.outcome);
      return res.json({ ok: true, report_id: saved.id, version: saved.version });
    }
    return res.status(400).json({ error: `Unknown event: ${b.event}` });
  } catch (e) {
    // Never lose the reason: the engine logs whatever we say here.
    try { await jobsDb.failQwenJob(jobId, `Callback failed: ${e.message}`); } catch (_) { /* noop */ }
    res.status(500).json({ error: e.message });
  }
});

/* Retry PERSISTENCE ONLY for a job whose synthesis already succeeded.

   No model call, no retrieval, no regeneration. The generated record is read back
   from the engine, which still holds it, and written with the identity the job
   established at claim time. If the engine has forgotten the run, the sections it
   published during the run are still in Neon and are reported as the remaining
   copy rather than silently doing nothing. */
app.post('/api/aresearch/job/:id/retry-save', async (req, res) => {
  const jobId = String(req.params.id || '');
  try {
    const job = await jobsDb.getQwenJob(jobId);
    if (!job) return res.status(404).json({ error: 'unknown job' });
    const out = await qr.callEngine(`/api/job/${encodeURIComponent(jobId)}`);
    const snap = out.data || {};
    const produced = Object.values(snap.models || {})
      .filter((m) => m && m.status === 'complete' && m.result);
    if (!produced.length) {
      const sections = await jobsDb.listQwenJobSections(jobId);
      return res.status(409).json({
        error: 'The research service no longer holds this run.',
        sections: sections.length,
        hint: sections.length
          ? 'The generated sections are still stored and remain viewable.'
          : 'Nothing recoverable remains for this job.',
      });
    }
    const saved = await qr.persistRun(produced[0].result, reqUser(req), job.company_key);
    if (!saved) return res.status(422).json({ error: 'The stored run is not a complete success.' });
    await jobsDb.completeQwenJob(jobId, saved.id);
    res.json({ ok: true, report_id: saved.id, version: saved.version });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/aresearch/research', async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    /* Contacts this CRM already holds go WITH the request, so the engine reuses
       them before paying Apollo for people we already know. Attached here rather
       than in the browser: the rows are contact PII and have no business making
       a round trip through the client. Best-effort — a lookup failure must not
       stop research. */
    try {
      body.known_contacts = await qr.crmContactsFor(body.company);
    } catch (e) {
      body.known_contacts = [];
    }
    /* Duplicate protection lives HERE, in the database, not in the browser.
       A refresh, a second tab or a closed-and-reopened session all pass a
       client-side check; a partial unique index does not. */
    const live = await jobsDb.activeQwenJob(body.company);
    /* A live row means a live job. The worker's lease is what keeps it alive,
       and a lapsed lease is reclaimed by another worker rather than judged dead
       from this side. */
    if (live && ['queued', 'running'].includes(live.status)) {
      return res.json({ job_id: live.job_id, attached: true,
                        status: live.status, stage: live.stage,
                        progress_percent: live.progress_percent });
    }

    /* Identity is resolved HERE and travels with the request. The engine writes
       the durable job row now, and when it computed its own key the two
       normalisations diverged: "ACRO Automation Systems" became
       "acro automation systems" here and "acroautomationsystems" there, so
       every company-keyed lookup - the company table, Existing Report, the
       duplicate guard, the report upsert - stopped finding the newer job. One
       normaliser, and this is it. */
    const ident = jobsDb.resolveIdentity({
      companyName: body.company, website: body.website });
    body.company_key = ident.key;
    body.identity_source = ident.source;

    // Tell the engine where to report back to, and who it is.
    body.callback_url = process.env.CRM_CALLBACK_URL
      || `${req.protocol}://${req.get('host')}/api/qwen-research/callback`;
    const out = await qr.callEngine('/api/research', { method: 'POST', body });
    if (out.status === 200 && out.data && out.data.job_id) {
      try {
        await jobsDb.claimQwenJob({
          jobId: out.data.job_id, companyName: body.company,
          website: body.website, model: body.model,
          jobType: 'single', createdBy: reqUser(req),
        });
      } catch (e) {
        /* The run is already underway; losing the row would only cost us the
           resume view, so never fail the request over it. */
      }
    }
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/* What the UI asks on load, instead of trusting sessionStorage: is anything
   running for this company, and what happened to the last run? */
app.get('/api/aresearch/job-for-company', async (req, res) => {
  try {
    const company = String(req.query.company || '').trim();
    if (!company) return res.json({ active: null, latest: null });
    let [active, latest] = await Promise.all([
      jobsDb.activeQwenJob(company),
      jobsDb.latestQwenJob(company),
    ]);
    // No reconciliation step: a row in a live state IS live, because a worker's
    // lease is what holds it there and a lapsed one is reclaimed, not orphaned.
    res.json({ active: active || null, latest: latest || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Research Sessions: everything running plus what recently finished.

   Reads Neon, never the engine. That is what makes a session survive a
   navigation, a refresh, a closed browser and an engine restart. The derived
   `state` is computed here so the browser never has to infer it. */
app.get('/api/aresearch/sessions', async (req, res) => {
  try {
    /* Session history: every status, newest first, keyset-paged. Needs Attention
       is a count and a filter over these rows, never what decides membership. */
    const rows = await jobsDb.listQwenSessions({
      limit: req.query.limit || 25,
      beforeStartedAt: req.query.before || null,
      beforeJobId: req.query.before_id || null,
    });
    /* Reconcile anything still marked live before reporting it as running. A row
       whose engine has forgotten it is interrupted, and must say so here rather
       than showing a frozen percentage that will never advance. */
    const out = rows.map((r) => ({ ...r, state: sessionState(r) }));
    /* Live work, unpaged and first. It used to be sorted into the same paged
       list, and because the order is by start time and a queued job has none,
       seven live jobs sat behind thirty-two historical rows that also had none.
       Same JOB_LIVE predicate the queue uses, so the two lists name the same
       jobs. */
    let active = [];
    try {
      active = (await jobsDb.listQwenActiveSessions())
        .map((r) => ({ ...r, state: sessionState(r) }));
    } catch (e) {
      console.error('active sessions failed:', e.message);
    }
    /* Totals over EVERY job, not over this page. Counting the page answered
       "how many of the 25 rows on screen", which read as a total and moved
       when the page size did. Classified by the same sessionState() the rows
       use, so a state cannot mean one thing in the list and another in the
       count. */
    let totals = null;
    try {
      const all = await jobsDb.listQwenSessionStateInputs();
      totals = { total: all.length, live: 0, attention: 0,
                 researching: 0, queued: 0, history: 0 };
      for (const r of all) {
        const st = sessionState(r);
        if (SESSION_LIVE_STATES.has(st)) totals.live += 1; else totals.history += 1;
        // The two halves of "live", so the header can say which is which.
        if (st === 'researching' || st === 'generating') totals.researching += 1;
        if (st === 'queued') totals.queued += 1;
        if (SESSION_ATTENTION_STATES.has(st)) totals.attention += 1;
      }
    } catch (e) {
      // Advisory only. A count that cannot be read must not fail the list.
      console.error('session totals failed:', e.message);
    }
    const last = out.length ? out[out.length - 1] : null;
    res.json({
      sessions: out,
      active,
      totals,
      // The cursor for the next page. Null when this page was not full, so the
      // client stops rather than paging forever against a shrinking table.
      next: last && out.length >= Number(req.query.limit || 25)
        ? { before: last.started_at, before_id: last.job_id } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Permanent deletion of one session. Deliberately NOT a report deletion: the
   saved report belongs to the company and outlives any single run. */
app.delete('/api/aresearch/job/:id', async (req, res) => {
  try {
    const out = await jobsDb.deleteQwenSession(req.params.id);
    if (out.ok) {
      logCrmActivity({ actor: reqUser(req), action: 'aresearch.session.delete',
                       metadata: { job_id: req.params.id, company: out.company_name,
                                   sections_deleted: out.sections_deleted } });
      return res.json(out);
    }
    if (out.reason === 'not_found') return res.status(404).json({ error: 'unknown session' });
    if (out.reason === 'not_terminal') {
      return res.status(409).json({
        error: 'This session is still running. Wait for it to finish, or for it to '
             + 'be marked interrupted, before deleting it.',
        status: out.status,
      });
    }
    return res.status(400).json({ error: 'could not delete session' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Live incremental output for one job. Read from Neon, so it survives a reload,
   a new browser session and an engine restart, and it is scoped to the job_id so
   two companies researching at once never mix. */
app.get('/api/aresearch/job/:id/sections', async (req, res) => {
  try {
    const [job, sections] = await Promise.all([
      jobsDb.getQwenJob(req.params.id),
      jobsDb.listQwenJobSections(req.params.id),
    ]);
    if (!job) return res.status(404).json({ error: 'unknown job' });
    res.json({
      job_id: job.job_id, company_name: job.company_name,
      status: job.status, stage: job.stage,
      progress_percent: job.progress_percent,
      report_id: job.report_id, sections,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Everything currently running, for the Reports tab. */
/* Bulk deletion of session HISTORY.

   Same deletion as the single-row path, applied to many rows: the job row and
   its sections, and nothing else. The client's idea of what is terminal is not
   consulted - the statement carries the allow-list, so asking to delete a
   running job simply deletes nothing and says so. */
app.post('/api/aresearch/sessions/delete', async (req, res) => {
  const body = req.body || {};
  const scope = body.scope === 'all' ? 'all' : 'selected';
  try {
    let out;
    if (scope === 'all') {
      out = await jobsDb.clearQwenSessionHistory();
    } else {
      const ids = Array.isArray(body.job_ids) ? body.job_ids.filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ error: 'no job_ids given' });
      out = await jobsDb.deleteQwenSessions(ids);
    }
    logCrmActivity({ actor: reqUser(req), action: 'aresearch.session.bulk_delete',
                     metadata: { scope, deleted: out.deleted.length,
                                 skipped: out.skipped.length } });
    res.json({ scope, deleted: out.deleted.length,
               job_ids: out.deleted.map((d) => d.job_id), skipped: out.skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── The queue ────────────────────────────────────────────────────────────
   One read for the summary line AND the management panel, so the two cannot
   disagree about what is waiting. */
app.get('/api/aresearch/queue', async (req, res) => {
  try {
    res.json(await jobsDb.queueSummary());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* One write for both "cancel this" and "cancel everything waiting".

   Only queued work can be cancelled. A running job is spending money in a
   worker that has no way to be told to stop, so asking is answered with an
   explanation rather than a partial attempt. */
app.post('/api/aresearch/queue/cancel', async (req, res) => {
  const body = req.body || {};
  const scope = body.scope === 'all' ? 'all' : 'selected';
  try {
    if (scope === 'all') {
      const out = await jobsDb.cancelAllQueuedJobs();
      return res.json({ scope, cancelled: out.cancelled, jobs: out.jobs, skipped: [] });
    }
    const ids = Array.isArray(body.job_ids) ? body.job_ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'no job_ids given' });
    const jobs = []; const skipped = [];
    for (const id of ids) {
      const r = await jobsDb.cancelQueuedJob(String(id));
      if (r.ok) jobs.push(r.job);
      /* A job claimed between the panel's read and this request is the normal
         race, not a failure. Name it so the user is told what happened. */
      else skipped.push({ job_id: String(id), reason: r.reason,
                          status: r.status || null, company_name: r.company_name || null });
    }
    res.json({ scope, cancelled: jobs.length, jobs, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/aresearch/active-jobs', async (req, res) => {
  try {
    res.json(await jobsDb.listActiveQwenJobs());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Poll a job and persist it the moment it completes.

   Persistence is best-effort ON TOP of the engine's own result: if Neon is
   unreachable the finished research is still returned to the browser and the
   engine still holds it. Losing the save must not lose the report. */
app.get('/api/aresearch/job/:id', async (req, res) => {
  try {
    const out = await qr.callEngine(`/api/job/${encodeURIComponent(req.params.id)}`);
    const job = out.data || {};
    if (out.status === 200 && job.status === 'done') {
      for (const m of Object.values(job.models || {})) {
        if (m && m.status === 'complete' && m.result) {
          try {
            const saved = await qr.persistRun(m.result, reqUser(req));
            if (saved) m.persisted = { id: saved.id, version: saved.version };
          } catch (e) {
            m.persistError = String(e.message).slice(0, 200);
          }
        }
      }
    }
    if (qr.looksLikeModelAccessError(job)) job.modelUnavailable = qr.MODEL_UNAVAILABLE;
    res.status(out.status).json(job);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// Batch: proxied straight through, with completed companies persisted on poll.
/* Company-list upload. Multipart is streamed straight through to the engine,
   which already knows how to parse .csv / .xlsx. */
app.post('/api/aresearch/batch/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer]), req.file.originalname || 'companies.csv');
    const headers = {};
    if (process.env.ACCOUNT_RESEARCH_SERVICE_KEY) {
      headers['X-AR-Service-Key'] = process.env.ACCOUNT_RESEARCH_SERVICE_KEY;
    }
    const upstream = await fetch(`${qr.ENGINE}/api/batch/upload`, {
      method: 'POST', body: form, headers,
    });
    res.status(upstream.status).json(await upstream.json());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/aresearch/batch/start', async (req, res) => {
  try {
    const out = await qr.callEngine('/api/batch/start', { method: 'POST', body: req.body || {} });
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

app.get('/api/aresearch/batch/:id', async (req, res) => {
  try {
    const out = await qr.callEngine(`/api/batch/${encodeURIComponent(req.params.id)}`);
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

app.post('/api/aresearch/batch/:id/stop', async (req, res) => {
  try {
    const out = await qr.callEngine(`/api/batch/${encodeURIComponent(req.params.id)}/stop`,
      { method: 'POST', body: {} });
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/* GET /api/booth-map/unmatched — the booths that did NOT resolve to a company.

   The importer refuses to guess: where a booth's company name matches two CRM
   rows, or none, it stores the source spelling with company_id NULL rather
   than picking something plausible. A wrong join there would file one
   company's research under another company's booth, and nothing downstream
   would ever look wrong enough to notice.

   That decision is only defensible if the gap is visible, which is what this
   is for. Read-only, and authenticated by the same middleware as every other
   route — it is mounted below it, so there is nothing extra to remember.

   Returns the source spelling and the booth, never a guess at what it should
   have been. */
app.get('/api/booth-map/unmatched', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.booth_number, b.source_company_name, b.source_company_name_zh,
              b.category, b.status, b.match_confidence, b.match_method, b.match_note,
              b.last_seen_at, e.name AS event_name
         FROM booth_map_booths b
         JOIN events e ON e.id = b.event_id
        WHERE b.retired_at IS NULL
          AND b.company_id IS NULL
          AND b.source_company_name IS NOT NULL
        ORDER BY b.match_confidence, b.booth_number
        LIMIT 500`);

    const { rows: totals } = await pool.query(
      `SELECT COUNT(*)::int AS live,
              COUNT(company_id)::int AS matched,
              COUNT(*) FILTER (WHERE match_confidence = 'ambiguous')::int AS ambiguous,
              COUNT(*) FILTER (WHERE match_confidence = 'unmatched'
                               AND source_company_name IS NOT NULL)::int AS unmatched
         FROM booth_map_booths WHERE retired_at IS NULL`);

    const { rows: lastRun } = await pool.query(
      `SELECT id, status, source_version, created, updated, unchanged, retired,
              matched, unmatched, ambiguous, error_message, started_at, finished_at
         FROM booth_import_runs ORDER BY started_at DESC LIMIT 1`);

    res.json({ ok: true, totals: totals[0] || null, lastRun: lastRun[0] || null, rows });
  } catch (err) {
    /* An absent table means the import has never run, which is a different
       answer from "nothing is unmatched" and must not be reported as one. */
    if (err && err.code === '42P01') {
      return res.status(503).json({ error: 'Booth data has not been imported yet.' });
    }
    console.error('[booth-map/unmatched]', err);
    res.status(500).json({ error: 'Failed to load unmatched booths' });
  }
});

/* GET /api/analytics/overview — adoption and platform value.

   Aggregates only. No message bodies, no subject lines, no per-message
   detail: the question is whether the platform is being adopted and whether
   outreach works, which never requires reading anyone's mail. Per-user rows
   are returned separately so they can be restricted independently. */
app.get('/api/analytics/overview', async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const iv = `${days} days`;
    const one = async (sql, params = []) => (await pool.query(sql, params)).rows;

    const [dau, wau, mau] = await Promise.all([activeUsers(1), activeUsers(7), activeUsers(30)]);

    const email = (await one(`
      SELECT
        COUNT(*) FILTER (WHERE comm_type='draft' AND deleted_at IS NULL)::int AS drafts_generated,
        COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int                      AS emails_sent,
        COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int                   AS replies_received,
        AVG(EXTRACT(EPOCH FROM (replied_at - sent_at))/3600)
          FILTER (WHERE replied_at IS NOT NULL AND sent_at IS NOT NULL)       AS avg_reply_hours
      FROM communications
      WHERE created_at > NOW() - $1::interval`, [iv]))[0];
    email.reply_rate = email.emails_sent ? +(email.replies_received / email.emails_sent).toFixed(4) : null;

    const ai = (await one(`
      SELECT COALESCE(SUM(total_tokens),0)::bigint AS tokens,
             COALESCE(SUM(cost_usd),0)::numeric(12,4) AS cost_usd,
             COALESCE(AVG(response_ms),0)::int AS avg_ms,
             COUNT(*)::int AS calls
      FROM ai_usage_events WHERE created_at > NOW() - $1::interval`, [iv]))[0];

    const aiByFeature = await one(`
      SELECT feature, COALESCE(SUM(total_tokens),0)::bigint tokens,
             COALESCE(SUM(cost_usd),0)::numeric(12,4) cost_usd, COUNT(*)::int calls
      FROM ai_usage_events WHERE created_at > NOW() - $1::interval
      GROUP BY 1 ORDER BY cost_usd DESC`, [iv]);

    const adoption = (await one(`
      SELECT
        (SELECT COUNT(*)::int FROM companies       WHERE created_at > NOW() - $1::interval) AS companies_created,
        (SELECT COUNT(*)::int FROM contacts        WHERE created_at > NOW() - $1::interval) AS contacts_added,
        (SELECT COUNT(*)::int FROM companies       WHERE ai_analyzed_at > NOW() - $1::interval) AS ai_analyses,
        (SELECT COUNT(*)::int FROM account_reports WHERE created_at > NOW() - $1::interval) AS research_reports`, [iv]))[0];

    res.json({ ok: true, days,
      platform: { dau, wau, mau },
      email, ai, aiByFeature, adoption });
  } catch (err) {
    console.error('analytics overview:', err);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

/* GET /api/analytics/by-user — per-person figures, separated from the
   aggregate endpoint so it can be locked down on its own. Counts and cost
   only; nothing about what was said to whom. */
app.get('/api/analytics/by-user', async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const iv = `${days} days`;
    const rows = (await pool.query(`
      SELECT u.actor,
             COALESCE(a.tokens,0)::bigint tokens, COALESCE(a.cost_usd,0)::numeric(12,4) cost_usd,
             COALESCE(c.drafts,0)::int drafts, COALESCE(c.sent,0)::int sent, COALESCE(c.replies,0)::int replies
      FROM (SELECT DISTINCT actor FROM crm_activity
            WHERE actor IS NOT NULL AND created_at > NOW() - $1::interval) u
      LEFT JOIN (SELECT user_id, SUM(total_tokens) tokens, SUM(cost_usd) cost_usd
                 FROM ai_usage_events WHERE created_at > NOW() - $1::interval GROUP BY 1) a ON a.user_id = u.actor
      LEFT JOIN (SELECT user_id,
                        COUNT(*) FILTER (WHERE comm_type='draft') drafts,
                        COUNT(*) FILTER (WHERE sent_at IS NOT NULL) sent,
                        COUNT(*) FILTER (WHERE replied_at IS NOT NULL) replies
                 FROM communications WHERE created_at > NOW() - $1::interval GROUP BY 1) c ON c.user_id = u.actor
      ORDER BY cost_usd DESC`, [iv])).rows;
    res.json({ ok: true, days, users: rows });
  } catch (err) {
    console.error('analytics by-user:', err);
    res.status(500).json({ error: 'Failed to load per-user analytics' });
  }
});

/* ── CRM reply notifications ─────────────────────────────────────────
   Everything here is scoped to replies to messages the CRM sent. There is
   no endpoint that reads a mailbox, and none that returns a message body. */

app.get('/api/replies/unread-count', async (req, res) => {
  try { res.json({ ok: true, count: await unreadReplyCount(reqUser(req)) }); }
  catch (err) { res.status(500).json({ error: 'Failed to load reply count' }); }
});

app.get('/api/replies', async (req, res) => {
  try {
    const rows = await listEmailReplies({
      userId: reqUser(req),
      unreadOnly: req.query.unread === '1',
      limit: Math.min(50, Number(req.query.limit) || 20),
    });
    // Snippet only — the bell is a preview, not a reader.
    res.json({ ok: true, replies: rows.map((r) => ({
      id: r.id, threadId: r.thread_id, contactId: r.contact_id, companyId: r.company_id,
      contact: r.contact_name || r.from_name || r.from_email,
      company: r.company_name || '', from: r.from_email,
      snippet: r.snippet, receivedAt: r.received_at, unread: !r.read_at,
    })) });
  } catch (err) { res.status(500).json({ error: 'Failed to load replies' }); }
});

app.post('/api/replies/read', async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    res.json({ ok: true, updated: await markRepliesRead(ids, reqUser(req)) });
  } catch (err) { res.status(500).json({ error: 'Failed to mark read' }); }
});

/* Connector credential. The forwarding rule is not a logged-in user, so it
   authenticates with a token of its own rather than sharing an operator's
   password. Its only power is to OFFER a candidate: everything it sends is
   still discarded unless it answers a message the CRM sent, so a leaked
   token cannot be used to inject arbitrary mail into the CRM or to read
   anything. */
function ingestAuth(req, res, next) {
  const expected = process.env.REPLY_INGEST_TOKEN || '';
  if (!expected) {
    return res.status(503).json({ error: 'Reply ingest is not configured. Set REPLY_INGEST_TOKEN.' });
  }
  const given = req.get('x-ingest-token') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  // Length-independent comparison keeps the check from leaking the token.
  const ok = given.length === expected.length &&
    require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'Invalid ingest token' });
  next();
}

/* POST /api/replies/ingest — the single entry point for inbound mail.

   Deliberately a push endpoint rather than a mailbox poller: whatever feeds
   it (a Graph subscription, an IMAP worker, a forwarding rule) hands over
   one candidate at a time, and recordEmailReply drops anything whose
   inReplyTo does not match a message the CRM sent. Unrelated mail cannot be
   stored even if it is offered. */
app.post('/api/replies/ingest', ingestAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const h = b.headers || {};
    // Accept either explicit fields or raw headers, since connectors differ.
    const inReplyTo = b.inReplyTo || h['In-Reply-To'] || h['in-reply-to'] || '';
    const references = b.references || h['References'] || h['references'] || '';
    const replyMessageId = b.replyMessageId || h['Message-ID'] || h['message-id'] || '';
    if ((!inReplyTo && !references) || !replyMessageId) {
      return res.status(400).json({ error: 'a Message-ID plus In-Reply-To or References is required' });
    }
    const saved = await recordEmailReply({
      inReplyTo, references, replyMessageId: String(replyMessageId),
      fromEmail: b.fromEmail || h['From'] || '', fromName: b.fromName,
      snippet: b.snippet || b.bodyPreview, receivedAt: b.receivedAt || h['Date'],
    });
    if (!saved) return res.json({ ok: true, matched: false, reason: 'not a reply to a CRM-sent message' });
    if (saved.duplicate) return res.json({ ok: true, matched: true, duplicate: true, reason: 'already recorded' });
    res.json({ ok: true, matched: true, id: saved.id, threadId: saved.thread_id });
  } catch (err) {
    console.error('reply ingest:', err);
    res.status(500).json({ error: 'Failed to ingest reply' });
  }
});

/* ── Email page ──────────────────────────────────────────────────────
   Serves only CRM-managed conversations: what this system drafted or sent,
   plus replies matched to those messages. There is no endpoint here that
   lists a mailbox. */
app.get('/api/threads', async (req, res) => {
  try {
    const rows = await listEmailThreads({
      userId: reqUser(req),
      limit: Math.min(100, Number(req.query.limit) || 50),
      unreadOnly: req.query.unread === '1',
    });
    res.json({ ok: true, threads: rows });
  } catch (err) {
    console.error('threads:', err);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

app.get('/api/threads/:id', async (req, res) => {
  try {
    const t = await getEmailThread(String(req.params.id));
    if (!t.messages.length && !t.replies.length) return res.status(404).json({ error: 'Thread not found' });
    // Opening a conversation clears its unread replies — the same act.
    const unread = t.replies.filter((r) => !r.read_at).map((r) => r.id);
    if (unread.length) await markRepliesRead(unread, reqUser(req));
    res.json({ ok: true, ...t });
  } catch (err) {
    console.error('thread:', err);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

// GET /api/accounts/grouped -- Browse-by-Account selector (name + contact count)
app.get('/api/accounts/grouped', async (req, res) => {
  try {
    res.json({ ok: true, accounts: await listAccountGroups({ onlyWithContacts: true }) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

// GET /api/accounts/:id/companies -- child companies + contact counts, for the Merge Accounts preview
app.get('/api/accounts/:id/companies', async (req, res) => {
  try {
    res.json({ ok: true, companies: await listCompaniesForAccount(Number(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load account companies' });
  }
});

// POST /api/accounts/merge -- merge one or more accounts into a target account
app.post('/api/accounts/merge', async (req, res) => {
  try {
    const { sourceAccountIds, targetAccountId } = req.body || {};
    if (!Array.isArray(sourceAccountIds) || !sourceAccountIds.length || !targetAccountId) {
      return res.status(400).json({ error: 'sourceAccountIds (array) and targetAccountId are required' });
    }
    const result = await mergeAccounts(sourceAccountIds, targetAccountId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Merge accounts error:', err);
    res.status(500).json({ error: 'Failed to merge accounts', details: err.message });
  }
});

// GET /api/contacts/names -- lightweight full list for Browse-by-Contact-Name selector
app.get('/api/contacts/names', async (req, res) => {
  try {
    res.json({ ok: true, contacts: await listContactNamesForBrowse() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load contact names' });
  }
});

// POST /api/contacts/bulk-delete
app.post('/api/contacts/bulk-delete', async (req, res) => {
  try {
    const ids = (req.body && req.body.ids) || [];
    const numericIds = ids.map(Number).filter((n) => Number.isInteger(n));
    if (!numericIds.length) return res.status(400).json({ error: 'No valid contact ids provided' });
    const deleted = await deleteContacts(numericIds);
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete contacts' });
  }
});

// DELETE /api/contacts/:id
app.delete('/api/contacts/:id', async (req, res) => {
  try {
    await deleteContact(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// PATCH /api/contacts/:id
app.patch('/api/contacts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const updated = await patchContactCrmFields(id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Contact not found' });
    if (req.body && req.body.follow_up_status) {
      await logContactActivity(id, 'status_change', `Status set to ${req.body.follow_up_status}`);
    }
    if (req.body && req.body.notes) {
      await logContactActivity(id, 'note', req.body.notes);
    }
    res.json({ ok: true, contact: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// GET /api/contacts/:id/activity
app.get('/api/contacts/:id/activity', async (req, res) => {
  try {
    res.json({ ok: true, activity: await listContactActivity(Number(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

// POST /api/contacts/:id/activity
app.post('/api/contacts/:id/activity', async (req, res) => {
  try {
    const { activity_type = 'note', description = '' } = req.body || {};
    await logContactActivity(Number(req.params.id), activity_type, description);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log activity' });
  }
});

// =========================================================================
// Company list upload (CSV / XLSX)
// =========================================================================

app.post('/api/companies/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file field in request' });

    let companies, headers;
    try {
      const result = await parseCompanyFile(req.file.buffer, req.file.originalname);
      companies = result.companies;
      headers = result.headers;
    } catch (err) {
      return res.status(400).json({ error: `Failed to parse file: ${err.message}` });
    }

    if (!companies.length) {
      const headerList = headers && headers.length ? headers.join(', ') : '(no headers detected)';
      return res.status(400).json({
        error:
          "No companies found — this file doesn't have a recognized English-name column (英文名). " +
          `Columns found in this file: ${headerList}. ` +
          "If this looks like a contacts export (e.g. name/title/email/company columns) rather than a company list, " +
          "it needs a different import path — this upload is specifically for company lists."
      });
    }

    const eventName = (req.body && req.body.event) || '';

    for (const c of companies) {
      await upsertCompany({
        name: c.english_name,
        chinese_name: c.chinese_name,
        industry: c.industry,
        booth: c.booth,
        event_name: eventName,
        // The uploaded file discovered the *company*. The contacts that an
        // Apollo search later returns for it remain Apollo contacts.
        source: 'file_upload',
        source_file: (req.file && req.file.originalname) || '',
        category: c.category,
        priority: c.priority,
        background: c.background,
        opportunity: c.opportunity,
        mfg_location: c.mfg_location,
        contact_tip: c.contact_tip
      });
    }

    res.json({ ok: true, companies, total: companies.length });
  } catch (err) {
    console.error('Company upload error:', err);
    res.status(500).json({ error: 'Failed to process upload', details: err.message });
  }
});

// GET /api/companies
app.get('/api/companies', async (req, res) => {
  try {
    res.json({ ok: true, companies: await listCompanies(req.query.q) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load companies' });
  }
});

// GET /api/companies/summary -- backs the Companies list view and the
// account picker. Lightweight by design; see listCompanySummaries().
app.get('/api/companies/summary', async (req, res) => {
  try {
    res.json({ ok: true, companies: await listCompanySummaries() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load companies' });
  }
});

/* POST /api/companies — create an account from scratch.

   Company Intelligence used to be a browser of rows that some other ingestion
   path had already created (CSV upload, Apollo search, card scan), so a
   company you had simply heard of could not be worked at all. This is the
   manual entry point: name it, and it exists as a real CRM account you can
   analyze and then staff with contacts.

   upsertCompany() is deliberately reused rather than a bare INSERT — it owns
   the name validation, the name_key normalisation and the account resolution
   that every other ingestion path already relies on, so a hand-typed company
   lands identically to an imported one. It also means re-adding an existing
   name returns that row instead of creating a duplicate. */
app.post('/api/companies', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A company name is required.' });

    const existing = await findCompanyByName(name);
    const result = await upsertCompany({
      name,
      chinese_name: req.body.chinese_name,
      website: req.body.website,
      industry: req.body.industry,
      notes: req.body.notes,
      source: 'manual',
    });
    if (!result) {
      // upsertCompany's guard is an exact-match blocklist ("engineering",
      // "n/a", bare legal suffixes like "Inc") aimed at junk produced by the
      // automated ingestion paths. It deliberately does not second-guess a
      // free-typed name — a human naming their own account is authoritative.
      return res.status(400).json({ error: `"${name}" can't be used as a company name.` });
    }
    const company = await getCompany(result.id);
    res.json({ ok: true, company, created: !existing });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create the company', details: err.message });
  }
});

// GET /api/companies/:id/contacts
app.get('/api/companies/:id/contacts', async (req, res) => {
  try {
    res.json({ ok: true, contacts: await getCompanyContacts(Number(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load company contacts' });
  }
});

// GET /api/events
app.get('/api/events', async (req, res) => {
  try {
    res.json({ ok: true, events: await listEvents() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load events' });
  }
});

// =========================================================================
// Lead search
// =========================================================================

function companyCacheKey(company) {
  return `company:${company.trim().toLowerCase()}`;
}

// Apollo uses the email field to carry non-addresses too -- "N/A" when it has
// none, and "(email available via Apollo, not returned in payload)" when it
// has one but won't hand it over. Neither is storable or usable as a dedupe
// key, so both collapse to empty.
function cleanApolloEmail(email) {
  const v = String(email || '').trim();
  if (!v || v.startsWith('(') || v.includes('N/A')) return '';
  return v;
}

function contactRowToLeadFormat(c) {
  return {
    name: c.full_name, title: c.job_title, company: c.company, department: c.department,
    email: c.email, linkedin: c.linkedin_url, confidence: c.confidence, relevance: c.relevance,
    location: c.address, apollo_id: c.apollo_person_id,
    has_email: Boolean(c.email) || Boolean(c.has_email),
    email_lookup_status: c.email_lookup_status || (c.email ? 'found' : 'not_checked'),
    draft_subject: c.draft_subject, draft_body: c.draft_body,
    draft_followup: c.draft_followup, draft_rationale: c.draft_rationale,
    contact_id: c.id
  };
}

/* GET /api/leads/plan?companies=CATL,BYD&target=40&mode=append

   Answers, before anything is spent or written: how many contacts do I hold
   for this company, how many will be retrieved, what will that cost, and is
   this appending or replacing?

   Read-only and free — it never calls Apollo and never creates an account.
   The one number it cannot know for free is how many matches Apollo actually
   has; that is reported only when a previous search recorded it, stamped
   with when, rather than guessed at. */
app.get('/api/leads/plan', async (req, res) => {
  try {
    const names = String(req.query.companies || '').split(',').map((s) => s.trim()).filter(Boolean);
    const target = Math.max(1, Math.min(Number(req.query.target) || 25, 500));
    const maxTotal = Math.max(1, Math.min(Number(req.query.maxTotal) || 100, 2000));
    const replace = String(req.query.mode || 'append') === 'replace';

    // Two batched round trips for the whole request, not two per company:
    // this runs on every keystroke, so its latency is felt directly.
    const [counts, caches] = await Promise.all([
      contactCountsByAccountNames(names),
      getCompanySearchCaches(names.map(companyCacheKey)),
    ]);

    let budget = maxTotal;
    const plans = [];
    for (const name of names) {
      const key = name.toLowerCase();
      const known = Object.prototype.hasOwnProperty.call(counts, key);
      const current = known ? counts[key] : 0;

      // Append tops up to the target; a full refresh re-reads the whole target.
      const wanted = replace ? target : Math.max(0, target - current);
      const willRetrieve = Math.min(wanted, budget);
      budget -= willRetrieve;

      // Apollo returns 25 records per request (APOLLO_PAGE_SIZE), and paging
      // starts at page 1, so reaching `target` costs ceil(target/25) requests.
      const searchRequests = willRetrieve > 0 ? Math.ceil(target / 25) : 0;

      // What a prior search recorded Apollo as holding, if anything.
      let apolloTotal = null, apolloTotalAt = null, lastError = null, lastErrorAt = null;
      const cached = caches[companyCacheKey(name)];
      if (cached) {
        try {
          const payload = JSON.parse(cached.raw_json);
          if (Number(payload.total)) { apolloTotal = Number(payload.total); apolloTotalAt = cached.fetched_at; }
          if (payload.lastError) { lastError = payload.lastError; lastErrorAt = payload.lastErrorAt || null; }
        } catch (e) { /* malformed cache entry is simply "unknown" */ }
      }

      plans.push({
        company: name,
        known,
        current,
        target,
        willRetrieve,
        // Upper bound: one people/match lookup per imported contact that
        // arrives without an email. Most do.
        emailLookups: willRetrieve,
        searchRequests,
        budgetLimited: wanted > willRetrieve,
        mode: replace ? 'replace' : 'append',
        // Whether this is a first import or a top-up changes the wording and
        // the action, so the planner states it rather than the UI guessing.
        firstImport: current === 0,
        // The most Apollo can actually supply beyond what we hold, when a
        // previous search told us the true match count.
        availableBeyondHeld: apolloTotal == null ? null : Math.max(0, apolloTotal - current),
        apolloTotal, apolloTotalAt, lastError, lastErrorAt,
      });
    }
    res.json({ ok: true, plans, maxTotal, remainingBudget: budget });
  } catch (err) {
    res.status(500).json({ error: 'Could not build an import plan' });
  }
});

app.post('/api/leads/search', async (req, res) => {
  try {
    const raw = (req.body.companies || '').trim();
    const companyNames = raw.split(',').map((c) => c.trim()).filter(Boolean);
    if (!companyNames.length) return res.status(400).json({ error: 'Please enter at least one company name.' });

    const forceRefresh = Boolean(req.body.force);
    const apiKey = config.APOLLO_API_KEY;

    // User-controlled search budget -- never fetch an unbounded number of
    // Apollo contacts. perCompanyLimit caps each company; maxTotal caps the
    // sum across every company in this request (shared, decrementing budget).
    const perCompanyLimit = Math.max(1, Math.min(Number(req.body.perCompanyLimit) || 25, 500));
    let remainingBudget = Math.max(1, Math.min(Number(req.body.maxTotal) || 100, 2000));
    const departments = Array.isArray(req.body.departments) ? req.body.departments : [];

    const departmentLabels = departments.map((key) => {
      const found = DEPARTMENT_TAXONOMY.find((d) => d.key === key);
      return found ? found.label : key;
    });

    let allContacts = [];
    let allOrgs = [];
    const messages = [];
    const summaries = [];

    for (const companyName of companyNames) {
      if (remainingBudget <= 0) {
        messages.push(`${companyName}: skipped -- reached your maximum total contacts limit (${req.body.maxTotal || 100}). Increase "Maximum total contacts" to fetch more.`);
        continue;
      }
      // The searched term is always the Account -- create/reuse it up front so
      // it persists even if Apollo returns zero contacts for this search.
      const account = await getOrCreateAccount(companyName);

      /* ── Apollo adds; the local DB owns everything else ──────────────────
         perCompanyLimit is read as the TARGET NUMBER OF CONTACTS this
         account should end up with, not as "fetch this many again":

           already >= target  -> serve from the DB, spend no Apollo credits
           already <  target   -> top up: query Apollo, drop everyone we
                                  already hold, import only the shortfall
           force refresh       -> re-query at the full target anyway

         Nothing is ever deleted or replaced. Contacts we already hold are
         not even re-written on a top-up, so their updated_at, drafts,
         notes, tags, threads, interaction history and CRM metadata are
         left exactly as they are rather than being churned by an import
         that had nothing new to say about them. */
      const existingContacts = account ? await getAccountContacts(account.id) : [];
      const existingCount = existingContacts.length;

      if (!forceRefresh && existingCount >= perCompanyLimit) {
        allContacts = allContacts.concat(existingContacts.map(contactRowToLeadFormat));
        messages.push(`CACHE:${companyName}:${existingCount}:${account.updated_at}`);
        continue;
      }

      // How many NEW contacts this company still needs. On a full refresh we
      // re-import whatever Apollo returns for the target instead.
      const shortfall = Math.max(0, perCompanyLimit - existingCount);

      // Dedupe index over what we already hold, mirroring the keys
      // findExistingContact() uses on write, plus apollo_person_id — the
      // most reliable identifier for Apollo-sourced rows and the one that
      // still works for the many contacts Apollo returns with no email.
      const existingKeys = new Set();
      for (const e of existingContacts) {
        if (e.apollo_person_id) existingKeys.add(`apollo:${String(e.apollo_person_id).toLowerCase()}`);
        if (e.email) existingKeys.add(`email:${String(e.email).trim().toLowerCase()}`);
        if (e.linkedin_url) existingKeys.add(`li:${String(e.linkedin_url).trim().toLowerCase()}`);
        if (e.full_name && e.company) {
          existingKeys.add(`name:${String(e.full_name).trim().toLowerCase()}|${String(e.company).trim().toLowerCase()}`);
        }
      }
      const alreadyHeld = (c) => {
        const email = cleanApolloEmail(c.email);
        if (c.apollo_id && existingKeys.has(`apollo:${String(c.apollo_id).toLowerCase()}`)) return true;
        if (email && existingKeys.has(`email:${email.trim().toLowerCase()}`)) return true;
        if (c.linkedin && existingKeys.has(`li:${String(c.linkedin).trim().toLowerCase()}`)) return true;
        const comp = c.company || companyName;
        if (c.name && comp && existingKeys.has(`name:${String(c.name).trim().toLowerCase()}|${String(comp).trim().toLowerCase()}`)) return true;
        return false;
      };

      if (!apolloConfigured()) {
        messages.push(`${companyName}: no local data found, and Apollo API key not configured.`);
        continue;
      }

      // Fetch up to the target for this account. Contacts we already hold
      // occupy the earlier rows of Apollo's result order, so asking for the
      // target (rather than just the shortfall) is what surfaces the extra
      // records beyond page one.
      const result = await doCompanySearch(companyName, apiKey, {
        perCompanyLimit,
        departments
      });
      if (result.error) {
        messages.push(`${companyName}: ${result.error}`);
        /* Remember the failure. Without this the planner had no way to know
           the last attempt failed, so it kept presenting a confident
           estimate beside "Lead search failed" messages on the page. */
        try {
          const key = companyCacheKey(companyName);
          const prev = await getCompanySearchCache(key);
          let payload = {};
          try { payload = prev ? JSON.parse(prev.raw_json) : {}; } catch (e) { payload = {}; }
          payload.lastError = String(result.error).slice(0, 300);
          payload.lastErrorAt = new Date().toISOString();
          await setCompanySearchCache(key, JSON.stringify(payload));
        } catch (e) { /* recording the failure must never mask it */ }
        continue;
      }

      const fetched = result.contacts || [];
      const orgs = result.orgs || [];

      // A full refresh re-imports everything Apollo returned (upsert only —
      // still no deletes). A normal search imports strictly what's missing,
      // capped at the shortfall and at the shared cross-company budget.
      const newlyFound = forceRefresh ? fetched : fetched.filter((c) => !alreadyHeld(c));
      const importCap = forceRefresh ? Math.min(fetched.length, remainingBudget)
                                     : Math.min(shortfall, remainingBudget);
      const contacts = newlyFound.slice(0, importCap);
      const alreadyHeldCount = fetched.length - newlyFound.length;

      if (!forceRefresh && existingCount > 0) {
        messages.push(
          contacts.length
            ? `${companyName}: ${existingCount} contact(s) already saved and left untouched; adding ${contacts.length} new one(s) to reach ${existingCount + contacts.length}.`
            : `${companyName}: ${existingCount} contact(s) already saved. Apollo returned no records beyond the ones you already have — raise "Contacts per company" to search deeper.`
        );
      }
      if (newlyFound.length > contacts.length) {
        messages.push(`${companyName}: ${newlyFound.length - contacts.length} further new contact(s) were found but not imported — raise "Contacts per company" or "Maximum total contacts".`);
      }

      // Budget counts what actually lands in the CRM; re-reading contacts we
      // already own costs the user nothing and shouldn't consume their cap.
      remainingBudget -= contacts.length;

      // Pre-upsert one company (legal-entity) row per distinct name Apollo
      // actually returned, parented to this Account -- so the per-contact
      // upsertContact() below (which resolves company_id from c.company text)
      // attaches to a row that's already correctly grouped under the Account.
      let lastCompanyId = null;
      const seenCompanyNames = new Set();
      for (const companyName2 of contacts.map((c) => c.company || companyName)) {
        if (seenCompanyNames.has(companyName2.toLowerCase())) continue;
        seenCompanyNames.add(companyName2.toLowerCase());
        const compResult = await upsertCompany({ name: companyName2, account_name: companyName, source: 'apollo' });
        if (compResult) lastCompanyId = compResult.id;
      }
      if (!seenCompanyNames.size) {
        // No contacts came back at all -- still ensure a company row exists
        // under this Account so the search isn't a total no-op.
        const compResult = await upsertCompany({ name: companyName, account_name: companyName, source: 'apollo' });
        if (compResult) lastCompanyId = compResult.id;
      }

      let importedCount = 0;
      let duplicatesSkipped = 0;
      for (const c of contacts) {
        const cleanEmail = cleanApolloEmail(c.email);
        const rawJson = c._apollo_raw ? JSON.stringify(c._apollo_raw) : undefined;
        console.log(`[leads/search] ${c.name} @ ${c.company}: apollo_email_fields={email:${JSON.stringify(c._apollo_raw && c._apollo_raw.email)}, personal_emails:${JSON.stringify(c._apollo_raw && c._apollo_raw.personal_emails)}, business_emails:${JSON.stringify(c._apollo_raw && c._apollo_raw.business_emails)}, has_email:${c._apollo_raw && c._apollo_raw.has_email}} cleanEmail=${JSON.stringify(cleanEmail)}`);
        const { id, updated } = await upsertContact({
          full_name: c.name, job_title: c.title, department: c.department, seniority: c.seniority,
          company: c.company || companyName, website: c.company_website,
          email: cleanEmail, linkedin_url: c.linkedin, address: c.location,
          confidence: c.confidence, relevance: c.relevance,
          apollo_person_id: c.apollo_id, source: 'apollo',
          has_email: Boolean(c.has_email) || Boolean(cleanEmail),
          apollo_raw_json: rawJson,
          email_lookup_status: cleanEmail ? 'found' : 'not_checked',
          // Search-supplied, which costs no reveal credit — a distinction the
          // details panel and the export both surface.
          email_source: cleanEmail ? 'apollo_search' : 'none'
        });
        c.contact_id = id;
        c.email_lookup_status = cleanEmail ? 'found' : 'not_checked';
        if (updated) duplicatesSkipped++; else importedCount++;
        console.log(`[leads/search] -> contact_id=${id} updated=${updated} email_saved=${JSON.stringify(cleanEmail)}`);
        await logContactActivity(id, 'apollo_search', updated ? `Refreshed via Apollo search for ${companyName}` : `Found via Apollo search for ${companyName}`);
      }

      await logApolloResult('people_search', lastCompanyId, null, companyName, JSON.stringify({ contacts, orgs }));
      // `total` is Apollo's own match count for this query. Persisting it is
      // what lets the import planner tell the user how much more is available
      // without spending a request to find out.
      // Success clears any recorded failure — the warning must not outlive it.
      await setCompanySearchCache(companyCacheKey(companyName),
        JSON.stringify({ company: companyName, contacts, orgs, total: result.total || null }));

      summaries.push({
        company: companyName, departments: departmentLabels,
        foundCount: fetched.length, importedCount, duplicatesSkipped,
        alreadyHeldCount, existingCount, totalCount: existingCount + importedCount,
        target: perCompanyLimit, forced: forceRefresh
      });

      // Hand back the account's full current roster, not just this batch, so
      // the caller sees the CRM's actual state after the import rather than
      // an increment it has to reconcile itself.
      allContacts = allContacts.concat(existingContacts.map(contactRowToLeadFormat), contacts);
      allOrgs = allOrgs.concat(orgs);
      if (result.fallback_message) messages.push(result.fallback_message);
    }

    res.json({ ok: true, contacts: allContacts, orgs: allOrgs, messages, companies: companyNames, summaries });
  } catch (err) {
    console.error('Lead search error:', err);
    res.status(500).json({ error: 'Lead search failed', details: err.message });
  }
});

// POST /api/leads/save
app.post('/api/leads/save', async (req, res) => {
  try {
    const c = req.body;
    const saveEmail = c.email && !String(c.email).includes('N/A') && !String(c.email).includes('not returned') ? c.email : '';
    const { id, updated } = await upsertContact({
      full_name: c.name,
      job_title: c.title,
      company: c.company,
      website: c.company_website,
      email: saveEmail,
      linkedin_url: c.linkedin,
      address: c.location,
      department: c.department,
      seniority: c.seniority,
      confidence: c.confidence,
      relevance: c.relevance,
      apollo_person_id: c.apollo_id,
      source: 'apollo',
      has_email: Boolean(c.has_email) || Boolean(saveEmail),
      draft_subject: c.draft_subject,
      draft_body: c.draft_body,
      draft_followup: c.draft_followup,
      draft_rationale: c.draft_rationale
    });
    await logContactActivity(id, 'apollo_search', updated ? 'Updated via Apollo lead search' : 'Created from Apollo lead search');
    res.json({ ok: true, id, updated });
  } catch (err) {
    console.error('Lead save error:', err);
    res.status(500).json({ error: 'Failed to save lead', details: err.message });
  }
});

// POST /api/reveal-email
app.post('/api/reveal-email', async (req, res) => {
  try {
    const apolloId = (req.body.apollo_id || '').trim();
    const contactId = req.body.contact_id || null;
    if (!apolloId) return res.status(400).json({ error: 'No apollo_id provided' });
    if (!apolloConfigured()) return res.status(400).json({ error: 'Apollo API key not configured' });

    const result = await revealPersonEmail(apolloId, config.APOLLO_API_KEY);
    if (result.error) return res.status(502).json({ error: result.error });

    // Persist revealed email so it survives page reload
    if (contactId && result.email && !result.email.startsWith('(')) {
      await updateContact(contactId, { email: result.email });
    }

    res.json({ email: result.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* POST /api/contacts/:id/enrich-email — resolve one contact's address.

   Two tiers, and the boundary between them is the whole point:

     free  — an address already stored in the CRM, or one sitting in the
             Apollo payload we already paid for and saved. Costs nothing,
             runs on any request.
     paid  — asking Apollo to reveal an address it has not given us. Costs a
             credit, and runs ONLY when the caller passes allowApollo.

   Without allowApollo the paid tier is not attempted: the route reports
   `needsApollo` with an estimate and spends nothing. That default is what
   makes it safe for any code path — present or future — to call this while
   rendering, and it is enforced here rather than at the call sites, because
   a call site that forgets is exactly how the charges got hidden before. */
app.post('/api/contacts/:id/enrich-email', async (req, res) => {
  try {
    const contactId = Number(req.params.id);
    const allowApollo = req.body && req.body.allowApollo === true;
    const contact = await getContact(contactId);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Tier 1a: already in the CRM. Free for every source, including uploads.
    if (contact.email) {
      return res.json({
        ok: true, email: contact.email, source: 'stored',
        email_source: contact.email_source || 'legacy',
        creditsUsed: 0, email_lookup_status: 'found',
      });
    }

    let email = '';
    let source = '';
    let emailSource = '';
    let creditsUsed = 0;

    // Tier 1b: the stored Apollo payload. Already bought and saved, so
    // reading it again is free.
    if (contact.apollo_raw_json) {
      try {
        const rawPerson = JSON.parse(contact.apollo_raw_json);
        const candidate = extractApolloEmail(rawPerson);
        if (candidate) { email = candidate; source = 'apollo_raw_json'; emailSource = 'apollo_search'; }
      } catch (e) {
        console.warn(`[enrich-email] contact_id=${contactId} failed to parse apollo_raw_json: ${e.message}`);
      }
    }

    if (email) {
      await updateContact(contactId, { email, email_lookup_status: 'found', email_source: emailSource });
      return res.json({ ok: true, email, source, email_source: emailSource, creditsUsed: 0, email_lookup_status: 'found' });
    }

    // Tier 2: a paid reveal is the only remaining option.
    if (contact.apollo_person_id) {
      if (!allowApollo) {
        return res.json({
          ok: true, email: '', source: 'none', creditsUsed: 0,
          needsApollo: true, estimatedCredits: 1,
          email_lookup_status: contact.email_lookup_status || 'not_checked',
          message: 'An Apollo reveal is required for this address and was not requested.',
        });
      }
      if (!apolloConfigured()) {
        return res.json({ ok: true, email: '', email_lookup_status: 'not_checked', creditsUsed: 0, message: 'Apollo not configured' });
      }
      const result = await revealPersonEmail(contact.apollo_person_id, config.APOLLO_API_KEY);
      if (result.error) return res.status(502).json({ error: result.error });

      creditsUsed = 1;   // the call was made; a miss costs the same as a hit
      if (result.email && !result.email.startsWith('(')) {
        email = result.email;
        source = 'apollo_reveal';
        emailSource = 'apollo_enrichment';
        await updateContact(contactId, {
          email, email_lookup_status: 'found', email_source: emailSource,
          apollo_raw_json: result.raw ? JSON.stringify(result.raw) : undefined,
        });
      } else {
        // Apollo answered "no address". Recorded so we never pay to ask twice.
        source = 'apollo_reveal';
        await updateContact(contactId, { email_lookup_status: 'not_available' });
      }
    }

    const finalStatus = email ? 'found' : (contact.apollo_person_id ? 'not_available' : 'not_checked');
    res.json({ ok: true, email, email_lookup_status: finalStatus, source, email_source: emailSource, creditsUsed });
  } catch (err) {
    console.error('Enrich email error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* POST /api/contacts/reveal-estimate — what would a reveal cost, and for
   whom, before anything is spent. Free: it only reads the CRM. */
app.post('/api/contacts/reveal-estimate', async (req, res) => {
  try {
    const ids = (req.body && Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
    if (!ids.length) return res.json({ ok: true, total: 0, alreadyStored: 0, freeFromPayload: 0, needsApollo: 0, noApolloId: 0, estimatedCredits: 0 });

    const rows = await listContactsByIds(ids);
    let alreadyStored = 0, freeFromPayload = 0, needsApollo = 0, noApolloId = 0;
    for (const c of rows) {
      if (c.email && String(c.email).trim()) { alreadyStored++; continue; }
      // Already asked and Apollo had none: asking again would cost a credit
      // to learn the same thing, so it is not offered.
      if (c.email_lookup_status === 'not_available') { noApolloId++; continue; }
      // The payload is already paid for; an address inside it is free.
      let inPayload = '';
      if (c.apollo_raw_json) {
        try { inPayload = extractApolloEmail(JSON.parse(c.apollo_raw_json)) || ''; } catch { inPayload = ''; }
      }
      if (inPayload) { freeFromPayload++; continue; }
      if (c.apollo_person_id) { needsApollo++; continue; }
      noApolloId++;
    }
    res.json({
      ok: true, total: rows.length, alreadyStored, freeFromPayload, needsApollo, noApolloId,
      estimatedCredits: needsApollo,
    });
  } catch (err) {
    console.error('Reveal estimate error:', err);
    res.status(500).json({ error: 'Failed to estimate reveal cost' });
  }
});

// GET /api/debug/contact/:id — diagnostic info for an individual contact
app.get('/api/debug/contact/:id', async (req, res) => {
  try {
    const contact = await getContact(Number(req.params.id));
    if (!contact) return res.status(404).json({ error: 'Not found' });

    let rawEmailFields = null;
    if (contact.apollo_raw_json) {
      try {
        const raw = JSON.parse(contact.apollo_raw_json);
        rawEmailFields = {
          email: raw.email,
          email_address: raw.email_address,
          work_email: raw.work_email,
          personal_emails: raw.personal_emails,
          business_emails: raw.business_emails,
          has_email: raw.has_email,
          extractedEmail: extractApolloEmail(raw)
        };
      } catch (e) { rawEmailFields = { parseError: e.message }; }
    }

    res.json({
      contact: {
        id: contact.id,
        full_name: contact.full_name,
        company: contact.company,
        email: contact.email,
        has_email: contact.has_email,
        apollo_person_id: contact.apollo_person_id,
        has_apollo_raw_json: Boolean(contact.apollo_raw_json),
        source: contact.source
      },
      apollo_raw_email_fields: rawEmailFields,
      diagnosis: {
        emailInNeon: Boolean(contact.email),
        hasApolloId: Boolean(contact.apollo_person_id),
        hasRawJson: Boolean(contact.apollo_raw_json),
        emailInRawJson: Boolean(rawEmailFields && rawEmailFields.extractedEmail),
        recommendation: contact.email
          ? 'Email already stored in Neon — no action needed'
          : contact.apollo_person_id
            ? 'POST /api/contacts/:id/enrich-email to fetch via Apollo'
            : 'No Apollo ID — manual entry required'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// =========================================================================
// Email history (forwarded / imported emails)
// =========================================================================

// Parses raw pasted email text into { from, to, subject, date, body }
function parseRawEmail(text) {
  if (!text) return {};
  const lines = text.split('\n');
  let from = '', to = '', subject = '', date = '', bodyStart = -1;

  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    // Strip forwarded-email quote markers (>, > >, etc.)
    const line = lines[i].replace(/^(>+\s?)+/, '').trim();
    if (!from    && /^from\s*:/i.test(line))    from    = line.replace(/^from\s*:\s*/i, '').trim();
    else if (!to && /^to\s*:/i.test(line))      to      = line.replace(/^to\s*:\s*/i,   '').trim();
    else if (!subject && /^subject\s*:/i.test(line)) subject = line.replace(/^subject\s*:\s*/i, '').trim();
    else if (!date && /^date\s*:/i.test(line))  date    = line.replace(/^date\s*:\s*/i,  '').trim();

    // Body starts after first blank line that follows at least one header
    if (bodyStart === -1 && (from || subject) && line === '') {
      bodyStart = i + 1;
      break;
    }
  }

  const bodyLines = lines
    .slice(bodyStart >= 0 ? bodyStart : 0)
    .map(l => l.replace(/^(>+\s?)+/, '')); // strip quote markers from body too
  const body = bodyLines.join('\n').trim();

  return { from, to, subject, date, body };
}

function parseEmailAddress(str) {
  if (!str) return { name: '', email: '' };
  const angleMatch = str.match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (angleMatch) {
    return {
      name: angleMatch[1].replace(/^["']|["']$/g, '').trim(),
      email: angleMatch[2].trim().toLowerCase()
    };
  }
  const emailMatch = str.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return { name: str.replace(emailMatch ? emailMatch[0] : '', '').trim(), email: emailMatch ? emailMatch[0].toLowerCase() : '' };
}

function domainFromEmail(email) {
  const at = (email || '').indexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

// POST /api/emails/ingest — parse + match + categorize + save
app.post('/api/emails/ingest', async (req, res) => {
  try {
    const { raw_text, from: rawFrom, to: rawTo, subject: rawSubject, body: rawBody, sent_at, source = 'manual_paste' } = req.body;

    // Parse raw pasted text if provided, else use explicit fields
    let from = rawFrom || '', to = rawTo || '', subject = rawSubject || '', body = rawBody || '', dateStr = sent_at || '';
    if (raw_text) {
      const parsed = parseRawEmail(raw_text);
      from    = from    || parsed.from    || '';
      to      = to      || parsed.to      || '';
      subject = subject || parsed.subject || '';
      body    = body    || parsed.body    || '';
      dateStr = dateStr || parsed.date    || '';
    }

    const { name: fromName, email: fromEmail } = parseEmailAddress(from);
    const sentAt = dateStr ? new Date(dateStr) : null;
    const validSentAt = sentAt && !isNaN(sentAt.getTime()) ? sentAt.toISOString() : null;

    // ── Contact matching ──────────────────────────────────────────────────
    let contact = null;
    let reviewNeeded = false;
    const PERSONAL_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','me.com'];

    if (fromEmail) {
      contact = await findContactByEmail(fromEmail);
    }

    // Fallback: match by email domain (only for company domains, not personal)
    if (!contact && fromEmail) {
      const domain = domainFromEmail(fromEmail);
      if (domain && !PERSONAL_DOMAINS.includes(domain)) {
        contact = await findContactByEmailDomain(domain);
      }
    }

    // No match → create stub contact flagged for review
    if (!contact && (fromEmail || fromName)) {
      const domain = domainFromEmail(fromEmail);
      const companyHint = domain && !PERSONAL_DOMAINS.includes(domain)
        ? domain.split('.')[0] : '';
      const { id: newId } = await upsertContact({
        full_name: fromName || fromEmail,
        email: fromEmail,
        company: companyHint,
        source: 'email_import',
        email_source: 'email_import',
        email_lookup_status: fromEmail ? 'found' : 'not_checked'
      });
      contact = await getContact(newId);
      reviewNeeded = true;
    }

    const contactId = contact ? contact.id : null;

    // ── Company matching ──────────────────────────────────────────────────
    let companyId = contact ? contact.company_id : null;
    if (!companyId && contact && contact.company) {
      const co = await findCompanyByName(contact.company);
      companyId = co ? co.id : null;
    }
    if (!companyId && fromEmail) {
      const domain = domainFromEmail(fromEmail);
      if (domain && !PERSONAL_DOMAINS.includes(domain)) {
        const co = await findCompanyByDomain(domain);
        companyId = co ? co.id : null;
      }
    }

    // ── Duplicate check ───────────────────────────────────────────────────
    const dup = await findDuplicateEmail(fromEmail, subject);
    if (dup) {
      return res.json({ ok: true, id: dup.id, duplicate: true, message: 'Email already imported (duplicate detected)' });
    }

    // ── Categorize ────────────────────────────────────────────────────────
    const { category, rationale } = await categorizeEmail(subject, body, fromName, fromEmail);

    // ── Save ──────────────────────────────────────────────────────────────
    const record = await insertEmailHistory({
      contact_id: contactId,
      company_id: companyId,
      from_email: fromEmail,
      from_name: fromName,
      to_email: to,
      subject,
      body,
      sent_at: validSentAt,
      category,
      source,
      review_needed: reviewNeeded,
      raw_payload: raw_text || ''
    });

    if (contactId) {
      await logContactActivity(contactId, 'email_imported', `Imported email: "${subject || '(no subject)'}"`);
    }

    res.json({
      ok: true,
      id: record.id,
      contact_id: contactId,
      contact_name: contact ? contact.full_name : null,
      company_id: companyId,
      company_name: contact ? contact.company : null,
      category,
      category_rationale: rationale,
      review_needed: reviewNeeded,
      from_email: fromEmail,
      from_name: fromName,
      subject
    });
  } catch (err) {
    console.error('Email ingest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emails — recent email history
app.get('/api/emails', async (req, res) => {
  try {
    const needsReview = req.query.needs_review === 'true';
    const emails = needsReview ? await listNeedsReviewEmails(100) : await listRecentEmailHistory(100);
    res.json({ ok: true, emails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emails/needs-review-count
app.get('/api/emails/needs-review-count', async (req, res) => {
  try {
    const count = await countNeedsReviewEmails();
    res.json({ ok: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:id/emails — email history for one contact
app.get('/api/contacts/:id/emails', async (req, res) => {
  try {
    const emails = await listEmailHistoryForContact(Number(req.params.id));
    res.json({ ok: true, emails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/emails/:id — correct contact/company/category after review
app.patch('/api/emails/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { contact_id, company_id, category, review_needed } = req.body;
    await updateEmailHistory(id, { contact_id, company_id, category, review_needed });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Email drafting (Claude)
// =========================================================================

// GET /api/contacts/:id/timeline — unified chronological interaction history
app.get('/api/contacts/:id/timeline', async (req, res) => {
  try {
    const items = await listTimelineForContact(Number(req.params.id));
    res.json({ ok: true, timeline: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/communications/:id
app.patch('/api/communications/:id', async (req, res) => {
  try {
    await updateCommunication(Number(req.params.id), req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/communications/:id
app.delete('/api/communications/:id', async (req, res) => {
  try {
    await deleteCommunication(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/communications/:id/duplicate
app.post('/api/communications/:id/duplicate', async (req, res) => {
  try {
    const copy = await duplicateCommunication(Number(req.params.id));
    if (!copy) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, communication: copy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:id/check-draft?mode=&extraInstructions= -- is there
// already an equivalent draft, before the modal offers to redraft?
app.get('/api/contacts/:id/check-draft', async (req, res) => {
  try {
    const { mode, extraInstructions, options } = req.query;
    // Same key as the generator, or the modal would report an equivalent
    // draft exists and then generate a different one anyway.
    let parsedOptions = {};
    try { parsedOptions = options ? JSON.parse(options) : {}; } catch { parsedOptions = {}; }
    const draft = await checkEquivalentDraft(Number(req.params.id), mode, extraInstructions, draftOptionsSignature(parsedOptions));
    res.json({ ok: true, exists: Boolean(draft), draft: draft || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:id/current-draft?mode= -- the latest non-deleted draft
// for this category, if any (each category has its own independent current draft)
app.get('/api/contacts/:id/current-draft', async (req, res) => {
  try {
    const draft = await getCurrentDraftForContact(Number(req.params.id), req.query.mode);
    res.json({ ok: true, draft: draft || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:id/draft-versions?mode= -- version history for one category
app.get('/api/contacts/:id/draft-versions', async (req, res) => {
  try {
    res.json({ ok: true, versions: await listDraftVersionsForContact(Number(req.params.id), req.query.mode) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:id/draft-categories -- Draft Library: every outreach
// category with its status, including categories with no draft yet
app.get('/api/contacts/:id/draft-categories', async (req, res) => {
  try {
    const modes = listDraftModes();
    const generated = await listDraftCategoriesForContact(Number(req.params.id));
    const byMode = new Map(generated.map((row) => [row.draft_mode, row]));
    const categories = modes.map((m) => {
      const row = byMode.get(m.value);
      return {
        mode: m.value, label: m.label, exists: Boolean(row),
        status: row ? row.status : null, communicationId: row ? row.id : null,
        version: row ? row.version : null, updated_at: row ? row.updated_at : null,
      };
    });
    res.json({ ok: true, categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// Manually-imported emails (sent outside this system, logged after the fact)
// =========================================================================

// POST /api/contacts/:id/imported-emails -- multipart: fields (mode, subject,
// body, toEmail, sentAt, notes) + optional attachment files + optional
// libraryAttachmentIds (JSON array string, to attach existing library files
// without re-uploading).
app.post('/api/contacts/:id/imported-emails', upload.array('attachments', 10), async (req, res) => {
  try {
    const contactId = Number(req.params.id);
    const contact = await getContact(contactId);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const { mode, subject, body, toEmail, sentAt, notes } = req.body;
    const row = await insertManualEmail({
      contactId, companyId: contact.company_id, mode, subject, body,
      toEmail: toEmail || contact.email || '', sentAt, notes,
    });

    for (const file of req.files || []) {
      const att = await uploadOneOffAttachment({ buffer: file.buffer, mimetype: file.mimetype, originalname: file.originalname });
      await linkAttachmentToCommunication(row.id, att.id);
    }
    let libraryIds = [];
    try { libraryIds = JSON.parse(req.body.libraryAttachmentIds || '[]'); } catch { /* ignore malformed */ }
    for (const attId of libraryIds) {
      await linkAttachmentToCommunication(row.id, Number(attId));
    }

    await logContactActivity(contactId, 'email_logged', `Logged a manually-sent email: "${subject || '(no subject)'}"`);
    const attachments = await listAttachmentsForCommunication(row.id);
    res.json({ ok: true, communication: row, attachments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:id/imported-emails?mode= -- manually-logged emails for one category
app.get('/api/contacts/:id/imported-emails', async (req, res) => {
  try {
    const emails = await listImportedEmailsForContact(Number(req.params.id), req.query.mode);
    res.json({ ok: true, emails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/communications/:id/imported-email -- edit a manually-imported email's fields
app.post('/api/communications/:id/imported-email', async (req, res) => {
  try {
    const { subject, body, to_email, notes, sentAt } = req.body || {};
    const fields = { subject, body, to_email, notes };
    if (sentAt !== undefined) fields.sent_at = sentAt;
    await updateCommunication(Number(req.params.id), fields);
    res.json({ ok: true, communication: await getCommunication(Number(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// Attachments (one-off files on a specific email/draft) + Attachment Library
// =========================================================================

// GET /api/communications/:id/attachments -- list files linked to any draft/imported email
app.get('/api/communications/:id/attachments', async (req, res) => {
  try {
    res.json({ ok: true, attachments: await listAttachmentsForCommunication(Number(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/communications/:id/attachments -- attach more files to any
// communications row (draft or imported email), by upload and/or by
// referencing existing library items.
app.post('/api/communications/:id/attachments', upload.array('files', 10), async (req, res) => {
  try {
    const commId = Number(req.params.id);
    for (const file of req.files || []) {
      const att = await uploadOneOffAttachment({ buffer: file.buffer, mimetype: file.mimetype, originalname: file.originalname });
      await linkAttachmentToCommunication(commId, att.id);
    }
    let libraryIds = [];
    try { libraryIds = JSON.parse(req.body.libraryAttachmentIds || '[]'); } catch { /* ignore malformed */ }
    for (const attId of libraryIds) {
      await linkAttachmentToCommunication(commId, Number(attId));
    }
    res.json({ ok: true, attachments: await listAttachmentsForCommunication(commId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/communications/:id/attachments/:attachmentId', async (req, res) => {
  try {
    await unlinkAttachment(Number(req.params.id), Number(req.params.attachmentId));
    res.json({ ok: true, attachments: await listAttachmentsForCommunication(Number(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attachments/:id/download', async (req, res) => {
  try {
    const att = await getAttachment(Number(req.params.id));
    if (!att) return res.status(404).send('Not found');
    res.set('Content-Type', att.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${safeFilename(att.original_filename || 'attachment')}"`);
    res.send(att.file_data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attachment-library', async (req, res) => {
  try {
    const items = await listAttachmentLibrary({
      search: req.query.search, category: req.query.category,
      favoritesOnly: req.query.favorite === 'true',
    });
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/attachment-library', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const row = await createLibraryAttachment({
      name: req.body.name, category: req.body.category,
      buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname,
    });
    res.json({ ok: true, item: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attachment-library/:key/versions', async (req, res) => {
  try {
    res.json({ ok: true, versions: await listLibraryVersions(req.params.key) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/attachment-library/:key/replace', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const row = await replaceLibraryAttachment(req.params.key, {
      buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname,
    });
    if (!row) return res.status(404).json({ error: 'Library item not found' });
    res.json({ ok: true, item: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/attachment-library/:id/favorite', async (req, res) => {
  try {
    const result = await toggleLibraryFavorite(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/attachment-library/:key', async (req, res) => {
  try {
    await deleteLibraryItem(req.params.key);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/communications/:id/save -- edit fields, optionally as a new version
app.post('/api/communications/:id/save', async (req, res) => {
  try {
    const { asNewVersion, ...fields } = req.body || {};
    const row = await saveDraftEdit(Number(req.params.id), fields, Boolean(asNewVersion));
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, communication: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/communications/:id/status -- body: { status }
app.post('/api/communications/:id/status', async (req, res) => {
  try {
    const row = await setCommunicationStatus(Number(req.params.id), req.body && req.body.status);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, communication: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve the current send readiness + engine for a user (single provider flow).
async function resolveSender(userId) {
  const cfg = await getEmailOrgConfig();
  const acct = await getEmailUserAccount(userId);
  const secret = await getEmailUserSecret(userId);
  const profileName = await senderProfileName();
  const isOAuth = OAUTH_PROVIDER_TYPES.includes(cfg.provider_type);
  const enabled = Boolean(cfg.integration_enabled);
  const canSend = isOAuth
    ? enabled && Boolean(cfg.oauth_connected)
    : enabled && Boolean(acct && acct.connection_status === 'connected');
  const senderEmail = isOAuth ? cfg.oauth_email : (acct && acct.sender_email);
  // Display name: configured account name first, then profile name, else none.
  const senderName = ((isOAuth ? cfg.oauth_display_name : (acct && acct.sender_name)) || '').trim() || profileName || '';
  return { cfg, acct, secret, isOAuth, canSend, senderEmail, senderName };
}

// POST /api/communications/:id/send — actually send the email to its recipient.
app.post('/api/communications/:id/send', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const b = req.body || {};
    // Persist the latest edits first so we send exactly what's on screen.
    const fields = {};
    for (const k of ['to_email', 'cc', 'bcc', 'subject', 'body']) if (b[k] != null) fields[k] = b[k];
    if (Object.keys(fields).length) await saveDraftEdit(id, fields, false);

    const comm = await getCommunication(id);
    if (!comm) return res.status(404).json({ error: 'Not found' });
    const to = (b.to_email != null ? b.to_email : comm.to_email) || '';
    if (!to.trim()) return res.status(400).json({ error: 'Add a recipient before sending.' });

    const s = await resolveSender(reqUser(req));
    if (!s.canSend) {
      return res.status(400).json({ error: 'not_ready', message: 'Email sending is not fully configured. Connect your mailbox in Settings → My Email Account.' });
    }
    if (s.isOAuth) {
      return res.status(400).json({ error: 'oauth_send_pending', message: 'Sending via Microsoft/Google API arrives in a later phase. For now use an SMTP provider (e.g. GoDaddy Microsoft 365) to send.' });
    }

    await markCommunicationSend(id, { delivery_status: 'sending' });
    console.log(`[email:send] comm=${id} provider=${s.cfg.provider_type} from=${s.senderEmail} to=${to}`);

    const atts = await getAttachmentsWithDataForCommunication(id);
    const attachments = atts.map((a) => ({ filename: a.original_filename, content: a.file_data, contentType: a.mime_type || undefined }));

    // Use the resolved display name (account name → profile name → none).
    const acctForSend = { ...s.acct, sender_name: s.senderName || '' };
    const engine = providers.createEngine({ orgConfig: s.cfg, account: acctForSend, secret: s.secret });
    const result = await engine.sendEmail({
      to, cc: comm.cc || undefined, bcc: comm.bcc || undefined,
      subject: comm.subject || '(no subject)', text: comm.body || '', attachments,
    });
    console.log(`[email:send] comm=${id} result ok=${result.ok} — ${result.message}`);

    if (!result.ok) {
      const failed = await markCommunicationSend(id, { delivery_status: 'failed', send_error: result.message });
      await recordEmailTest({ userId: reqUser(req), kind: 'send', scope: 'user', target: to, ok: false, message: result.message });
      return res.status(502).json({ error: 'send_failed', message: result.message, communication: failed });
    }
    const sent = await markCommunicationSend(id, {
      delivery_status: 'sent', message_id: result.id || null, send_error: null,
      status: 'approved', sent_at: new Date(),
    });
    await recordEmailTest({ userId: reqUser(req), kind: 'send', scope: 'user', target: to, ok: true, message: `Sent (id ${result.id || '?'})` });
    if (comm.contact_id) { try { await logContactActivity(comm.contact_id, 'email_sent', `Email sent to ${to}: ${comm.subject || '(no subject)'}`); } catch (e) { /* non-fatal */ } }
    res.json({ ok: true, communication: sent, result });
  } catch (err) {
    console.error('[email:send] error:', err.message);
    try { await markCommunicationSend(id, { delivery_status: 'failed', send_error: err.message }); } catch (e) { /* ignore */ }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/communications/:id/schedule — store a future send time (queued).
// NOTE: the background dispatcher that actually fires scheduled sends is a later
// phase; this records intent and marks the message Queued.
app.post('/api/communications/:id/schedule', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const when = (req.body && req.body.scheduled_at) ? new Date(req.body.scheduled_at) : null;
    if (!when || isNaN(when.getTime()) || when.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Pick a valid future date and time.' });
    }
    const comm = await markCommunicationSend(id, { delivery_status: 'queued', scheduled_at: when });
    if (comm && comm.contact_id) { try { await logContactActivity(comm.contact_id, 'email_scheduled', `Email scheduled for ${when.toLocaleString()}`); } catch (e) { /* ignore */ } }
    res.json({ ok: true, communication: comm, note: 'Queued. Automatic dispatch of scheduled sends is a later phase.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/communications/:id/trash | /restore | /archive | /unarchive
app.post('/api/communications/:id/trash', async (req, res) => {
  try {
    const row = await trashCommunication(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, communication: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/communications/:id/restore', async (req, res) => {
  try {
    const row = await restoreCommunication(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, communication: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/communications/:id/archive', async (req, res) => {
  try {
    const row = await archiveCommunication(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, communication: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/communications/:id/unarchive', async (req, res) => {
  try {
    const row = await unarchiveCommunication(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, communication: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/communications/:id/follow-up
app.post('/api/communications/:id/follow-up', async (req, res) => {
  try {
    const row = await createFollowUp(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, communication: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/check-duplicate — pre-save duplicate detection
app.get('/api/contacts/check-duplicate', async (req, res) => {
  try {
    const { email, first_name, last_name, company } = req.query;
    const fullName = [first_name, last_name].filter(Boolean).join(' ');
    const match = await findExistingContact(email || '', fullName, company || '', '');
    if (match) {
      res.json({
        duplicate: true,
        contact: {
          id: match.id, full_name: match.full_name, email: match.email || '',
          company: match.company || '', job_title: match.job_title || '',
          source: match.source || ''
        }
      });
    } else {
      res.json({ duplicate: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts/manual — manual contact creation from CRM form
app.post('/api/contacts/manual', async (req, res) => {
  try {
    const c = req.body;
    const firstName = (c.first_name || '').trim();
    const lastName = (c.last_name || '').trim();
    const fullName = (c.full_name || [firstName, lastName].filter(Boolean).join(' ')).trim();

    if (!firstName && !lastName && !fullName && !c.email) {
      return res.status(400).json({ error: 'Name or email is required' });
    }

    // Upsert company with full details so industry/website/notes are stored
    let companyId = null;
    if (c.company) {
      const compResult = await upsertCompany({
        name: c.company,
        industry: c.industry || '',
        website: c.website || '',
        notes: c.company_notes || '',
        event_name: c.event_name || '',
        booth: c.booth_number || '',
        // Created because a contact is being saved by hand, not discovered
        // independently — the distinction the audit trail exists to keep.
        source: 'contact_creation',
      });
      if (compResult) companyId = compResult.id;
    }

    const { id, updated } = await upsertContact({
      first_name: firstName, last_name: lastName, full_name: fullName,
      email: c.email || '', phone: c.phone || '',
      job_title: c.job_title || '', department: c.department || '',
      company: c.company || '', company_id: companyId,
      linkedin_url: c.linkedin_url || '', tags: c.tags || '',
      notes: c.contact_notes || c.notes || '',
      meeting_notes: c.meeting_notes || '',
      website: c.website || '',
      source: 'manual',
      email_source: (req.body.email || '').trim() ? 'manual' : 'none',
      contact_status: c.contact_status || 'prospect',
      follow_up_status: c.follow_up_status || 'not_contacted',
      priority: c.priority || 'medium',
      country: c.country || '',
      event_name: c.event_name || '',
      booth_number: c.booth_number || '',
      email_lookup_status: c.email ? 'found' : 'not_checked',
    });

    await logContactActivity(id, 'manual_create', `Contact created manually: ${fullName || c.email}`);
    res.json({ ok: true, id, updated, full_name: fullName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/draft-modes', (req, res) => {
  res.json({ ok: true, modes: listDraftModes() });
});

// GET /api/draft-options -- the generation controls the prompt layer supports.
// Served rather than hardcoded in the UI so the word ranges shown to the user
// are the same ones the prompt asks Claude for; they can never drift apart.
app.get('/api/draft-options', (req, res) => {
  const list = (obj, extra = () => ({})) =>
    Object.entries(obj).map(([value, v]) => ({ value, label: v.label, ...extra(v) }));
  res.json({
    ok: true,
    lengths: list(DRAFT_LENGTHS, (v) => ({ words: v.words, hint: v.hint, default: Boolean(v.default) })),
    tones: list(DRAFT_TONES),
    languages: list(DRAFT_LANGUAGES),
    ctas: list(DRAFT_CTAS),
    /* Only providers that are actually configured, and only their display
       names. No model string, endpoint or credential state crosses to the
       browser — the selector offers products, not deployment detail. */
    models: listEmailModelChoices(),
    defaultModel: DEFAULT_EMAIL_MODEL_ID,
  });
});

// GET /api/search-taxonomy -- department/seniority options for search settings + CRM filters
app.get('/api/search-taxonomy', (req, res) => {
  res.json({
    ok: true,
    departments: DEPARTMENT_TAXONOMY.map((d) => ({ key: d.key, label: d.label })),
    seniorities: SENIORITY_TAXONOMY.map((s) => ({ key: s.key, label: s.label })),
  });
});

// ── Configurable tag prioritization ────────────────────────────────────────
// Admins tune how saved tags are selected for drafting without touching code.
// Defaults preserve the previous behavior exactly (min 0.70 = the old tier
// threshold; no max cap; no preference boost).
const TECHNICAL_CATEGORIES = ['cell_format', 'product_scope'];
const BUSINESS_CATEGORIES = ['segment', 'energy_storage_app', 'power_battery_app', 'contact_role', 'customer_priority'];
const DEFAULT_TAG_CONFIG = { max_tags: 0, min_relevance: 0.7, always_include: [], prefer_technical: false, prefer_business: false };
async function getTagPriorityConfig() {
  try {
    const raw = await getSetting('tag_priority_config');
    if (!raw) return { ...DEFAULT_TAG_CONFIG };
    const c = JSON.parse(raw);
    return {
      max_tags: Number(c.max_tags) || 0,
      min_relevance: (c.min_relevance != null && !isNaN(Number(c.min_relevance))) ? Number(c.min_relevance) : 0.7,
      always_include: Array.isArray(c.always_include) ? c.always_include : [],
      prefer_technical: Boolean(c.prefer_technical),
      prefer_business: Boolean(c.prefer_business),
    };
  } catch { return { ...DEFAULT_TAG_CONFIG }; }
}

// Single source of truth for which saved tags become part of the prompt. Both
// the prompt builder AND the Prompt Analytics inspector use this, so the
// analysis always matches what's actually sent.
function selectTags(companyTags, contactTags, includeTagIds, config) {
  const cfg = { ...DEFAULT_TAG_CONFIG, ...(config || {}) };
  const useSet = Array.isArray(includeTagIds) ? new Set(includeTagIds.map(Number)) : null;
  const alwaysSet = new Set((cfg.always_include || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));

  // Unique by value (company + contact may overlap); keep the higher-confidence one.
  const byVal = new Map();
  for (const t of [...(companyTags || []), ...(contactTags || [])]) {
    const k = String(t.value || '').toLowerCase();
    const prev = byVal.get(k);
    const score = (t.confidence != null) ? Number(t.confidence) : (t.source === 'rejected' ? 0 : 1.0);
    if (!prev || score > prev._score) byVal.set(k, { ...t, _score: score });
  }
  const uniq = [...byVal.values()].map((t) => {
    const tier = tagTier(t.source, t.confidence);
    const isTech = TECHNICAL_CATEGORIES.includes(t.category_key);
    const isBiz = BUSINESS_CATEGORIES.includes(t.category_key);
    const isAlways = alwaysSet.has(String(t.value || '').toLowerCase());
    const eff = t._score + (cfg.prefer_technical && isTech ? 0.2 : 0) + (cfg.prefer_business && isBiz ? 0.2 : 0);
    return {
      tag_id: t.tag_id, value: t.value, name_en: t.name_en || t.value, name_cn: t.name_cn || '',
      category_key: t.category_key || '', source: t.source, tier: tier.tier, score: (t.confidence != null ? Number(t.confidence) : null),
      _eff: eff, _isAlways: isAlways,
    };
  });

  // Stage 1 — eligibility.
  const eligible = [];
  uniq.forEach((t) => {
    if (t.source === 'rejected') { t.used = false; t.reason = 'Rejected during tag review'; return; }
    if (useSet) { // per-email manual override wins over config
      if (useSet.has(Number(t.tag_id))) eligible.push(t);
      else { t.used = false; t.reason = 'Manually excluded for this email'; }
      return;
    }
    if (t._isAlways) { eligible.push(t); return; } // forced in regardless of score
    const sc = t.score != null ? t.score : 1.0;
    if (sc < cfg.min_relevance) { t.used = false; t.reason = `Below minimum relevance (${sc.toFixed(2)} < ${cfg.min_relevance.toFixed(2)})`; return; }
    eligible.push(t);
  });

  // Stage 2 — rank (always-include first, then by effective score).
  eligible.sort((a, b) => (Number(b._isAlways) - Number(a._isAlways)) || (b._eff - a._eff));

  // Stage 3 — cap at max_tags (0 = no cap). Always-include are ranked first so survive.
  eligible.forEach((t, i) => {
    if (cfg.max_tags > 0 && i >= cfg.max_tags && !t._isAlways) { t.used = false; t.reason = `Capped at maximum ${cfg.max_tags} tags (ranked #${i + 1})`; }
    else { t.used = true; t.reason = ''; }
  });

  const decisions = uniq.sort((a, b) => (b._eff - a._eff));
  return { decisions, used: decisions.filter((t) => t.used) };
}

// Build a rich "Customer Profile" narrative from the selected tags. Selection is
// delegated to selectTags() so the prompt and the inspector never disagree.
function buildCustomerProfile(company, companyTags, contactTags, taxonomy, includeTagIds, config) {
  const allTags = [...(companyTags || []), ...(contactTags || [])];
  const { used } = selectTags(companyTags, contactTags, includeTagIds, config);

  const breakdown = { ai_confirmed: 0, ai_suggested: 0, confirmed: 0, manual: 0, needs_review: 0, rejected: 0 };
  allTags.forEach((t) => { const tr = tagTier(t.source, t.confidence).tier; if (breakdown[tr] != null) breakdown[tr] += 1; });

  if (!used.length) return { text: '', count: 0, breakdown, productValues: [] };

  const order = (taxonomy || []).map((c) => c.key);
  const names = Object.fromEntries((taxonomy || []).map((c) => [c.key, c.name_en]));
  const byCat = {};
  used.forEach((t) => { (byCat[t.category_key] = byCat[t.category_key] || []).push(t.value); });

  const firstSentence = (company.ai_research_summary || '').split(/(?<=[.。])\s/)[0];
  const desc = firstSentence || `${company.name} operates in ${company.industry || 'battery manufacturing'}.`;
  const bullets = order.filter((k) => byCat[k]).map((k) => `- ${names[k] || k}: ${byCat[k].join(', ')}`);
  const text =
    `Customer Profile\n` +
    `${company.name}${company.chinese_name ? ' (' + company.chinese_name + ')' : ''} — ${desc}\n` +
    `Current focus (from saved company intelligence):\n${bullets.join('\n')}`;

  const productValues = []
    .concat(byCat['product_scope'] || [])
    .concat(byCat['cell_format'] || [])
    .concat(byCat['energy_storage_app'] || [])
    .concat(byCat['power_battery_app'] || []);
  return { text, count: used.length, breakdown, productValues };
}

// Assemble the full draft context (customer profile + SKQ grounding + company
// notes/event) from saved data. DB-only, no AI. Shared by /api/draft-email and
// the Prompt Inspector so what you preview is exactly what gets sent.
async function buildDraftContext(contact, mode, extraInstructions, resolvedContactId, includeTagIds, options, skqSelected) {
  const context = {};
  // Length/tone/language/CTA travel with the rest of the context so the
  // Prompt Inspector previews exactly the prompt that will be sent.
  context.options = normalizeDraftOptions(options);
  let tagsUsed = 0;
  let breakdown = null;
  let skqModules = [];
  let rawCompanyTags = [];
  let rawContactTags = [];
  const tagConfig = await getTagPriorityConfig();
  if (extraInstructions) context.extraInstructions = extraInstructions;

  // Resolve the company the SAME way the modal does — by the contact's
  // company_id first (reliable), then by name. Avoids matching a duplicate
  // company that shares a similar name but has no tags.
  let companyRow = null;
  if (resolvedContactId) {
    const contactRow = await getContact(Number(resolvedContactId));
    if (contactRow && contactRow.company_id) companyRow = await getCompany(contactRow.company_id);
  }
  if (!companyRow) companyRow = await findCompanyByName(contact.company || '');
  if (companyRow) {
    const [intel, taxonomy, contactTags] = await Promise.all([
      getCompanyIntelligence(companyRow.id),
      getTaxonomy(),
      resolvedContactId ? listContactTags(Number(resolvedContactId)) : Promise.resolve([]),
    ]);
    rawCompanyTags = intel ? intel.tags : [];
    rawContactTags = contactTags || [];
    const profile = buildCustomerProfile(companyRow, intel ? intel.tags : [], contactTags, taxonomy, includeTagIds, tagConfig);
    if (profile.count) {
      context.customerProfile = profile.text;
      tagsUsed = profile.count;
      breakdown = profile.breakdown;
      // Deterministic product grounding — retrieve matching SKQ modules from DB.
      // These are RECOMMENDATIONS. They are always computed so the UI can show
      // them, but nothing reaches the prompt unless the user picked it: sending
      // every match made each email a catalogue dump of whatever the tags
      // happened to hit, which is the opposite of a focused first touch.
      skqModules = await matchSkqForTags(profile.productValues);
    }
    {
      const notesParts = [companyRow.notes, companyRow.background, companyRow.opportunity].filter(Boolean);
      if (notesParts.length) context.companyNotes = notesParts.join(' | ');
      if (companyRow.event_id) {
        const events = await listEvents();
        const event = events.find((e) => e.id === companyRow.event_id);
        if (event) context.eventName = event.name;
      }
    }
  }
  // Selected capabilities: names the user ticked, plus any they typed in.
  // Free text is allowed because the catalogue can't anticipate every angle,
  // and an unmatched capability the sender knows is relevant is more useful
  // than a matched one that isn't.
  const picked = []
    .concat(Array.isArray(skqSelected) ? skqSelected : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  if (picked.length) {
    context.skqCapabilities =
      `SKQ capabilities the sender chose for THIS email (use these, and only these):\n` +
      picked.map((nm) => `- ${nm}`).join('\n');
  }

  return { context, tagsUsed, breakdown, skqModules, skqSelected: picked,
    companyId: companyRow ? companyRow.id : null,
    companyTags: rawCompanyTags, contactTags: rawContactTags, includeTagIds, tagConfig };
}

// ── Prompt Analytics helpers (0 tokens; pure DB + string analysis) ──────────
const APPROX_CHARS_PER_TOKEN = 4;
const estimateTokens = (s) => Math.max(0, Math.round((s || '').length / APPROX_CHARS_PER_TOKEN));

// Classify every available tag as used or ignored (score + reason), using the
// SAME selectTags() the prompt builder uses, so analytics == what's sent.
function analyzeTagUsage(companyTags, contactTags, includeTagIds, config) {
  const { decisions } = selectTags(companyTags, contactTags, includeTagIds, config);
  const tags = decisions.map((t) => ({
    tag_id: t.tag_id, value: t.value, name_en: t.name_en, name_cn: t.name_cn,
    category_key: t.category_key, source: t.source, tier: t.tier, score: t.score,
    used: Boolean(t.used), reason: t.reason || '',
  }));
  const used = tags.filter((t) => t.used);
  return { total: tags.length, used_count: used.length, ignored_count: tags.length - used.length, tags };
}

// Split the ACTUAL assembled prompt into labeled sections by anchor markers, so
// what's shown is byte-for-byte what's sent (never a summary). Unmatched text
// attaches to the preceding section.
const PROMPT_ANCHORS = [
  { re: /^You are drafting/m, key: 'role', label: 'Role' },
  { re: /Step 1 — Sender analysis/, key: 'personalization', label: 'Personalization Rules' },
  { re: /\nRecipient:\n/, key: 'contact', label: 'Contact Information' },
  { re: /\nSender \(the person writing/, key: 'sender', label: 'Sender' },
  { re: /\nAdditional context/, key: 'additional', label: 'Additional Context' },
  { re: /Customer Profile\n/, key: 'company', label: 'Company Context (tags)' },
  { re: /SKQ capabilities the sender chose/, key: 'product', label: 'Product Context (SKQ)' },
  { re: /\n(Now write|Now write the)/, key: 'rules', label: 'Email Rules & CTA' },
  // Its own section, so "are my instructions actually in there?" is answered
  // by looking rather than by reading the whole prompt.
  { re: /\nSender's instructions for THIS email/, key: 'instructions', label: "Your Additional Instructions" },
  { re: /\nOutput controls/, key: 'controls', label: 'Length · Tone · Language' },
  { re: /\nAlso provide:/, key: 'output', label: 'Output Format' },
];
function sectionizePrompt(prompt) {
  const found = [];
  for (const a of PROMPT_ANCHORS) {
    const m = prompt.match(a.re);
    if (m && m.index != null) found.push({ ...a, index: m.index });
  }
  found.sort((x, y) => x.index - y.index);
  const sections = [];
  for (let i = 0; i < found.length; i++) {
    const start = found[i].index;
    const end = i + 1 < found.length ? found[i + 1].index : prompt.length;
    const text = prompt.slice(start, end);
    sections.push({ key: found[i].key, label: found[i].label, text, tokens: estimateTokens(text) });
  }
  // Any preamble before the first anchor.
  if (found.length && found[0].index > 0) {
    const pre = prompt.slice(0, found[0].index);
    if (pre.trim()) sections.unshift({ key: 'intro', label: 'Intro', text: pre, tokens: estimateTokens(pre) });
  }
  if (!sections.length) sections.push({ key: 'prompt', label: 'Prompt', text: prompt, tokens: estimateTokens(prompt) });
  return sections;
}

app.post('/api/draft-email', async (req, res) => {
  try {
    const { contact, sender, contactId, companyKey, mode, extraInstructions, regenerate } = req.body;
    if (!contact) return res.status(400).json({ error: 'No contact provided' });

    const resolvedContactId = contactId || contact.contact_id;
    const resolvedMode = mode || 'cold_outreach';
    const resolvedInstructions = extraInstructions || '';
    // Length / tone / language / CTA. Unknown or absent values fall back to
    // the defaults, so an old client that sends none behaves exactly as before.
    const resolvedOptions = normalizeDraftOptions(req.body.options);
    let optionsSignature = draftOptionsSignature(req.body.options);
    const skqSig = (Array.isArray(req.body.skqSelected) ? req.body.skqSelected : []).join('~');
    if (skqSig) optionsSignature += `|skq:${skqSig}`;

    // Reuse an existing draft for the same (contact, mode, instructions,
    // generation options) instead of calling Claude again -- unless the user
    // explicitly asked to regenerate (the "Redraft" button always sets this).
    // Trashed drafts don't count -- the user already discarded that one.
    // The options are part of the key: reusing a 250-word formal draft for a
    // 60-word direct request would silently ignore what the user chose.
    if (resolvedContactId && !regenerate) {
      const existing = await checkEquivalentDraft(Number(resolvedContactId), resolvedMode, resolvedInstructions, optionsSignature);
      if (existing) {
        // Reused a saved draft — no AI call. Record the tokens saved.
        const saved = await estimateAiSaved('email_draft', {});
        // Value the saving at the model that would actually have run, and
        // record it so cache hits still appear in per-model analytics.
        const would = activeEmailModel(resolvedOptions && resolvedOptions.modelId);
        recordAiEvent({
          feature: 'email_draft', sub_feature: resolvedMode, outcome: 'db_reuse',
          model: would.model, provider: would.provider, requested_provider: would.provider,
          contact_id: Number(resolvedContactId),
          tokens_saved_input: saved.input, tokens_saved_output: saved.output,
          user_id: reqUser(req), session_id: SERVER_SESSION_ID,
        });
        return res.json({
          id: existing.id, subject: existing.subject || '', body: existing.body || '',
          followup: existing.followup_text || '', rationale: existing.rationale || '',
          to_email: existing.to_email || '', cc: existing.cc || '', bcc: existing.bcc || '',
          notes: existing.notes || '', status: existing.status, source: existing.source,
          created_at: existing.created_at, updated_at: existing.updated_at,
          claude_configured: true, reused: true,
          saved_input: saved.input, saved_output: saved.output,
        });
      }
    }

    /* A prompt edited in the Prompt Inspector replaces the assembled one.
       Sections arrive in order and are concatenated; sectionizePrompt splits
       on contiguous boundaries, so an untouched set rebuilds the original
       exactly and only real edits change anything.

       Recorded in the options signature too, so an edited draft is never
       silently reused for a later request that didn't edit the prompt. */
    const promptSections = Array.isArray(req.body.promptSections) ? req.body.promptSections : null;
    const promptOverride = promptSections && promptSections.length
      ? promptSections.map((x) => String((x && x.text) || '')).join('')
      : '';

    // Assemble the draft context from saved intelligence (AI tags used by
    // default, confidence-tiered) + deterministic SKQ grounding. No AI here.
    const built = await buildDraftContext(contact, mode, extraInstructions, resolvedContactId, req.body.includeTagIds, req.body.options, req.body.skqSelected);
    const context = built.context;
    if (promptOverride) context.promptOverride = promptOverride;
    const tagsUsed = built.tagsUsed;

    // About to spend tokens — enforce the budget.
    const blocked = await checkAiBudget();
    if (blocked) return res.status(429).json(blocked);

    // Ignore whatever identity the client posted: the signature must reflect
    // the configured profile and the connected mailbox, or it is a guess.
    const signingSender = await effectiveSenderIdentity(reqUser(req), sender);
    const _t0 = Date.now();
    const draft = await draftEmail(contact, signingSender, mode, context);
    const _ms = Date.now() - _t0;

    // Record the real AI draft call.
    const du = draft._usage || {};
    recordAiEvent({
      feature: 'email_draft', sub_feature: resolvedMode,
      outcome: regenerate ? 'user_regeneration' : 'new_ai_call',
      // Provider comes from the draft, not from config: on a fallback the call
      // was served by someone else and must be priced as that someone else.
      model: du.model, provider: du.provider,
      requested_provider: du.requested_provider || null,
      company_id: built.companyId,
      contact_id: resolvedContactId ? Number(resolvedContactId) : null,
      input_tokens: du.input_tokens || 0, output_tokens: du.output_tokens || 0,
      cache_read_tokens: du.cache_read_tokens || 0, reasoning_tokens: du.reasoning_tokens || 0,
      response_ms: _ms, status: 'success', user_id: reqUser(req),
      session_id: SERVER_SESSION_ID, request_id: crypto.randomUUID(),
    });

    let commRow = null;
    if (resolvedContactId) {
      await updateContactDraft(Number(resolvedContactId), draft);
      const versionResult = await insertEmailDraftVersion(Number(resolvedContactId), draft, resolvedMode, resolvedInstructions, {
        to_email: contact.email || '',
        draft_options: optionsSignature,
      });
      commRow = await getCommunication(versionResult.communicationId);
      await logContactActivity(Number(resolvedContactId), 'draft_generated', `Mode: ${resolvedMode}`);
    } else if (companyKey) {
      await updateCachedLeadDraft(companyCacheKey(companyKey), contact.apollo_id, contact.name, draft);
    }

    res.json({
      ...draft, reused: false, tags_used: tagsUsed,
      tag_breakdown: built.breakdown, skq_modules: (built.skqModules || []).map((m) => m.name_en),
      id: commRow ? commRow.id : null,
      to_email: commRow ? commRow.to_email : '', cc: commRow ? commRow.cc : '', bcc: commRow ? commRow.bcc : '',
      notes: commRow ? commRow.notes : '', status: commRow ? commRow.status : 'draft', source: commRow ? commRow.source : '',
      created_at: commRow ? commRow.created_at : null, updated_at: commRow ? commRow.updated_at : null,
    });
  } catch (err) {
    console.error('Draft email error:', err);
    res.status(500).json({ error: 'Failed to draft email', details: err.message });
  }
});

// Prompt Inspector (dev): assemble the exact draft context + final prompt from
// saved intelligence WITHOUT calling the LLM (0 tokens). Lets you verify the
// saved company intelligence actually reaches the prompt.
app.post('/api/draft-email/inspect', async (req, res) => {
  try {
    const { contact, sender, contactId, mode, extraInstructions, includeTagIds, options } = req.body || {};
    if (!contact) return res.status(400).json({ error: 'No contact provided' });
    const resolvedContactId = contactId || contact.contact_id;
    const resolvedMode = mode || 'cold_outreach';
    const built = await buildDraftContext(contact, resolvedMode, extraInstructions || '', resolvedContactId, includeTagIds, options, req.body.skqSelected);
    let priorSummary = null;
    if (resolvedContactId) {
      try {
        const timeline = await listTimelineForContact(Number(resolvedContactId));
        priorSummary = `${(timeline || []).length} prior interaction(s) on record`;
      } catch { priorSummary = null; }
    }
    const inspectSender = await effectiveSenderIdentity(reqUser(req), sender);
    const prompt = buildPromptForMode(resolvedMode, contact, inspectSender, built.context);

    // ── Prompt Analytics ──────────────────────────────────────────────────
    const sections = sectionizePrompt(prompt);
    const tagAnalysis = analyzeTagUsage(built.companyTags, built.contactTags, built.includeTagIds, built.tagConfig);
    // For each USED tag, note which prompt sections contain its text.
    tagAnalysis.tags.forEach((t) => {
      if (!t.used) { t.where = []; return; }
      t.where = sections.filter((s) => t.value && s.text.toLowerCase().includes(String(t.value).toLowerCase())).map((s) => s.label);
    });
    const tokenSummary = {
      sections: sections.map((s) => ({ key: s.key, label: s.label, tokens: s.tokens })),
      total: sections.reduce((n, s) => n + s.tokens, 0),
    };
    // Concise, rule-based "why" (which context sources were used — NOT chain-of-thought).
    const why = [];
    const topUsed = tagAnalysis.tags.filter((t) => t.used).slice(0, 3);
    if (topUsed[0]) why.push(`Highest-relevance tag: “${topUsed[0].name_en}” (score ${topUsed[0].score != null ? topUsed[0].score.toFixed(2) : 'n/a'}).`);
    if ((built.skqModules || []).length) why.push(`${built.skqModules.length} SKQ capability match(es) added from the tag → product catalog.`);
    if (tagAnalysis.ignored_count) why.push(`${tagAnalysis.ignored_count} tag(s) omitted — see the reason on each below.`);
    if (built.context.extraInstructions) why.push('Your additional instructions were included.');
    if (!tagAnalysis.total) why.push('No saved tags for this company — run tag analysis to enrich the prompt.');

    res.json({
      ok: true,
      mode: resolvedMode,
      tags_used: built.tagsUsed,
      breakdown: built.breakdown,
      customer_profile: built.context.customerProfile || null,
      skq_capabilities: built.context.skqCapabilities || null,
      skq_modules: (built.skqModules || []).map((m) => m.name_en),
      company_notes: built.context.companyNotes || null,
      event_name: built.context.eventName || null,
      extra_instructions: built.context.extraInstructions || null,
      prior_interactions: priorSummary,
      prompt,
      // analytics
      model: CLAUDE_MODEL,
      contact_role: (contact && contact.title) || '',
      contact_department: (contact && contact.department) || '',
      sections,
      tag_analysis: tagAnalysis,
      token_summary: tokenSummary,
      tag_config: built.tagConfig,
      why,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build prompt preview', details: err.message });
  }
});

// GET /api/contacts/:id/drafts
app.get('/api/contacts/:id/drafts', async (req, res) => {
  try {
    res.json({ ok: true, drafts: await listEmailDraftsForContact(Number(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load draft history' });
  }
});

// =========================================================================
// Customer Intelligence: taxonomy, company/contact tags, AI research, SKQ matrix
// =========================================================================

const TAG_STATUS_SOURCES = ['user_confirmed', 'rejected', 'manual', 'needs_review'];

// Full curated taxonomy (categories + tags) for the tag-picker UI.
app.get('/api/taxonomy', async (req, res) => {
  try {
    res.json({ ok: true, taxonomy: await getTaxonomy() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load taxonomy', details: err.message });
  }
});

// Duplicate company rows (same name_key) with tag/contact counts, so you can
// spot cases where intelligence and contacts are split across duplicates.
app.get('/api/companies/duplicates', async (req, res) => {
  try { res.json({ ok: true, duplicates: await findDuplicateCompanies() }); }
  catch (err) { res.status(500).json({ error: 'Failed to load duplicates', details: err.message }); }
});

// Consolidate intelligence from a duplicate into this company: the contact-
// bearing row keeps its contacts and gains the tags/summary.
app.post('/api/companies/:id/merge-intelligence', async (req, res) => {
  try {
    const from = Number((req.body || {}).from);
    if (!from) return res.status(400).json({ error: 'from company id is required' });
    const result = await mergeCompanyIntelligence(from, Number(req.params.id));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to merge intelligence', details: err.message });
  }
});

// SKQ product-capability matrix (15 modules / 10 systems / 93 equipment).
app.get('/api/skq/matrix', async (req, res) => {
  try {
    const [modules, systems, equipment] = await Promise.all([
      listSkqModules(), listSkqSystems(), listSkqEquipment()
    ]);
    res.json({ ok: true, modules, systems, equipment });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load SKQ matrix', details: err.message });
  }
});

// Everything the Customer Intelligence panel shows for one company.
app.get('/api/companies/:id/intelligence', async (req, res) => {
  try {
    const intel = await getCompanyIntelligence(Number(req.params.id));
    if (!intel) return res.status(404).json({ error: 'Company not found' });
    res.json({ ok: true, ...intel });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load intelligence', details: err.message });
  }
});

// Run AI web research → store the summary + sources, and apply the suggested
// tags WITHOUT overwriting any human-reviewed tag. DB-first: this endpoint is
// only meant to be hit on an explicit user action. mode:
//   'full'    — re-analyze every company category (the "Refresh AI Analysis" button)
//   'missing' — only categories with no tags yet (default; saves tokens, preserves summary)
// If mode is 'missing' and nothing is missing, no AI call is made.
app.post('/api/companies/:id/research', async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    const company = await getCompany(companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const mode = (req.body && req.body.mode) === 'full' ? 'full' : 'missing';
    const taxonomy = await getTaxonomy();

    let onlyCategories = null;
    if (mode === 'missing') {
      onlyCategories = await missingCompanyCategories(companyId, taxonomy);
      if (onlyCategories.length === 0) {
        // Nothing to fill — stay DB-first, don't spend tokens. Record the saving.
        const saved = await estimateAiSaved('company_research', { company_id: companyId });
        recordAiEvent({
          feature: 'company_research', sub_feature: 'reuse', outcome: 'ai_avoided', company_id: companyId,
          tokens_saved_input: saved.input, tokens_saved_output: saved.output,
          user_id: reqUser(req), session_id: SERVER_SESSION_ID,
        });
        const intel = await getCompanyIntelligence(companyId);
        return res.json({
          ok: true, ...intel,
          research: { skipped: true, reason: 'all_categories_present', mode, suggested: 0, applied: 0,
            saved_input: saved.input, saved_output: saved.output }
        });
      }
    }

    // About to spend tokens — enforce the budget.
    const blocked = await checkAiBudget();
    if (blocked) return res.status(429).json(blocked);

    const _rt0 = Date.now();
    const result = await researchCompanyTags(company, taxonomy, { onlyCategories });
    const _rms = Date.now() - _rt0;
    if (result.error) {
      recordAiEvent({
        feature: 'company_research', sub_feature: onlyCategories ? 'missing_categories' : 'full',
        outcome: 'new_ai_call', status: 'error', error_message: (result.missing_info || []).join('; '),
        company_id: companyId, response_ms: _rms, user_id: reqUser(req),
        session_id: SERVER_SESSION_ID, request_id: crypto.randomUUID(),
      });
      return res.status(502).json({ error: 'AI research failed', details: (result.missing_info || []).join('; ') });
    }
    // Record the real AI call.
    const u = result.usage || {};
    const outcome = onlyCategories ? 'partial_refresh'
      : ((company.ai_analyzed_at || company.ai_research_summary) ? 'user_regeneration' : 'new_ai_call');
    recordAiEvent({
      feature: 'company_research', sub_feature: onlyCategories ? 'missing_categories' : 'full',
      outcome, model: u.model, company_id: companyId,
      input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
      web_search_calls: u.web_search_calls || 0,
      response_ms: _rms, status: 'success', user_id: reqUser(req),
      session_id: SERVER_SESSION_ID, request_id: crypto.randomUUID(),
    });

    const applyResult = await applyCompanyTagSuggestions(companyId, result.tags);
    // On a partial (missing-only) run, keep the existing full summary/sources.
    const keepExisting = mode === 'missing' && company.ai_research_summary;
    await setCompanyResearch(companyId, keepExisting ? null : result.summary, keepExisting ? [] : result.sources);

    const intel = await getCompanyIntelligence(companyId);
    res.json({
      ok: true, ...intel,
      research: {
        mode, outcome, categories: onlyCategories, summary: result.summary, missing_info: result.missing_info,
        suggested: result.tags.length, ...applyResult,
        input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
        claude_configured: result.claude_configured
      }
    });
  } catch (err) {
    console.error('Company research error:', err);
    res.status(500).json({ error: 'Failed to research company', details: err.message });
  }
});

// Human decision on a company tag: confirm / reject / manual / needs_review.
app.post('/api/companies/:id/tags/status', async (req, res) => {
  try {
    const { tagId, source, confirmedBy } = req.body || {};
    if (!tagId || !TAG_STATUS_SOURCES.includes(source)) {
      return res.status(400).json({ error: 'tagId and a valid source are required' });
    }
    const row = await setCompanyTagStatus(Number(req.params.id), Number(tagId), source, confirmedBy || null);
    res.json({ ok: true, tag: row });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update tag', details: err.message });
  }
});

// Manually add a company tag by category + value (stored as source='manual').
app.post('/api/companies/:id/tags/manual', async (req, res) => {
  try {
    const { categoryKey, value, confirmedBy } = req.body || {};
    if (!categoryKey || !value) return res.status(400).json({ error: 'categoryKey and value are required' });
    const row = await addManualCompanyTag(Number(req.params.id), categoryKey, value, confirmedBy || null);
    if (!row) return res.status(400).json({ error: 'Unknown tag for that category/value' });
    res.json({ ok: true, tag: row });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add tag', details: err.message });
  }
});

app.delete('/api/companies/:id/tags/:tagId', async (req, res) => {
  try {
    await removeCompanyTag(Number(req.params.id), Number(req.params.tagId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove tag', details: err.message });
  }
});

// Stamp the company's intelligence as human-reviewed (Last Reviewed date).
app.post('/api/companies/:id/reviewed', async (req, res) => {
  try {
    await markIntelligenceReviewed(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark reviewed', details: err.message });
  }
});

// Bridge: a contact's company intelligence + the contact's own tags — read by
// the Draft Email modal. DB-first, never triggers AI.
app.get('/api/contacts/:id/intelligence', async (req, res) => {
  try {
    const intel = await getContactCompanyIntelligence(Number(req.params.id));
    if (!intel) return res.status(404).json({ error: 'Contact not found' });
    // Loading a contact's saved intelligence is a DB reuse (0 tokens) — counted
    // so the footer can show "contact analyses" without any AI spend.
    recordAiEvent({
      feature: 'contact_intel', outcome: 'db_reuse',
      contact_id: Number(req.params.id), company_id: intel.company ? intel.company.id : null,
      user_id: reqUser(req), session_id: SERVER_SESSION_ID,
    });
    // Preview exactly what the draft prompt will use (default tag selection +
    // deterministic SKQ grounding), so the modal can show "Using N tags" + SKQ.
    let preview = { count: 0, breakdown: null, skq: [] };
    if (intel.company) {
      const taxonomy = await getTaxonomy();
      const p = buildCustomerProfile(intel.company, intel.tags, intel.contact_tags, taxonomy, null);
      const skq = p.count ? await matchSkqForTags(p.productValues) : [];
      preview = { count: p.count, breakdown: p.breakdown, skq: skq.map((m) => ({ name_en: m.name_en, name_cn: m.name_cn })) };
    }
    res.json({ ok: true, ...intel, preview });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load contact intelligence', details: err.message });
  }
});

// Configurable tag prioritization — how saved tags are selected for drafting.
app.get('/api/tag-priority', async (req, res) => {
  try { res.json({ ok: true, config: await getTagPriorityConfig(), is_admin: isAdmin(req) }); }
  catch (err) { res.status(500).json({ error: 'Failed', details: err.message }); }
});
app.post('/api/tag-priority', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const b = req.body || {};
    const clamp = (n, lo, hi, d) => { const v = Number(n); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
    const cfg = {
      max_tags: Math.max(0, Math.round(clamp(b.max_tags, 0, 100, 0))),
      min_relevance: clamp(b.min_relevance, 0, 1, 0.7),
      always_include: Array.isArray(b.always_include)
        ? b.always_include.map((s) => String(s).trim()).filter(Boolean).slice(0, 50)
        : String(b.always_include || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50),
      prefer_technical: Boolean(b.prefer_technical),
      prefer_business: Boolean(b.prefer_business),
    };
    await setSetting('tag_priority_config', JSON.stringify(cfg));
    res.json({ ok: true, config: cfg });
  } catch (err) { res.status(500).json({ error: 'Failed to save', details: err.message }); }
});

// Contact tags (Contact Role category).
app.get('/api/contacts/:id/tags', async (req, res) => {
  try {
    res.json({ ok: true, tags: await listContactTags(Number(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load contact tags', details: err.message });
  }
});

app.post('/api/contacts/:id/tags/status', async (req, res) => {
  try {
    const { tagId, source, confirmedBy } = req.body || {};
    if (!tagId || !TAG_STATUS_SOURCES.includes(source)) {
      return res.status(400).json({ error: 'tagId and a valid source are required' });
    }
    const row = await setContactTagStatus(Number(req.params.id), Number(tagId), source, confirmedBy || null);
    res.json({ ok: true, tag: row });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update contact tag', details: err.message });
  }
});

app.post('/api/contacts/:id/tags/manual', async (req, res) => {
  try {
    const { categoryKey, value, confirmedBy } = req.body || {};
    if (!categoryKey || !value) return res.status(400).json({ error: 'categoryKey and value are required' });
    const row = await addManualContactTag(Number(req.params.id), categoryKey, value, confirmedBy || null);
    if (!row) return res.status(400).json({ error: 'Unknown tag for that category/value' });
    res.json({ ok: true, tag: row });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add contact tag', details: err.message });
  }
});

app.delete('/api/contacts/:id/tags/:tagId', async (req, res) => {
  try {
    await removeContactTag(Number(req.params.id), Number(req.params.tagId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove contact tag', details: err.message });
  }
});

// =========================================================================
// Sender profile
// =========================================================================

/* The identity a draft signs off with.

   Assembled from two places rather than one: the profile holds who the
   sender is (name/title/company/phone/website), while the address comes
   from the mailbox they actually send through. Taking the address from the
   connected account is what stops the model inventing one — a signature
   with a plausible but wrong email is worse than no signature. */
async function effectiveSenderIdentity(userId, overrides) {
  let profile = {};
  try {
    const raw = await getSetting('sender_profile');
    if (raw) profile = JSON.parse(raw) || {};
  } catch (e) { profile = {}; }

  let account = null;
  try { account = await getEmailUserAccount(userId); } catch (e) { account = null; }

  const o = overrides || {};
  return {
    name:    o.name    || profile.name    || (account && account.sender_name)  || '',
    title:   o.title   || profile.title   || '',
    company: o.company || profile.company || '',
    // Address always follows the sending account when one is connected.
    email:   (account && account.sender_email) || profile.email || '',
    phone:   profile.phone   || '',
    website: profile.website || '',
  };
}

app.get('/api/settings/sender', async (req, res) => {
  try {
    const sender = await effectiveSenderIdentity(reqUser(req));
    res.json({ ok: true, sender });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sender profile' });
  }
});

app.post('/api/settings/sender', async (req, res) => {
  try {
    const { name = '', title = '', company = '', phone = '', website = '' } = req.body || {};
    await setSetting('sender_profile', JSON.stringify({ name, title, company, phone, website }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save sender profile' });
  }
});

// =========================================================================
// Email configuration (My Email Account + Org config [admin] + Preferences)
// =========================================================================

/* ── Refresh Exhibitor Data ────────────────────────────────────────────────
   An admin button over the sync that has until now only run from a terminal.

   The rule this is built around: there is ONE synchronisation pathway, and
   these routes call it rather than reproducing it. exhibitorSync and
   exhibitorReconcile are imported untouched — every guard they contain (the
   non-JSON refusal that catches an expired cookie, the mass-retirement floor,
   the incomplete-fetch check, retire-never-delete, no-guess identity matching)
   applies here because it is the same code. A second implementation for the UI
   would be a second thing to get wrong, and the two would drift on the first
   change to either.

   Preview writes nothing and Apply re-derives everything. Nothing is carried
   between them except a fingerprint used to detect that the source moved. */

const exhibitorSync = require('./exhibitorSync');
const exhibitorReconcile = require('./exhibitorReconcile');

/* How much detail the review panel gets. Enough to inspect a real change,
   bounded so a first import of a thousand exhibitors cannot try to render a
   thousand rows into a modal. Uses the same total/returned/truncated contract
   the chat tools do, so a capped list can never read as a total. */
const REFRESH_SAMPLE = 200;
const sample = (rows, map) => ({
  total: rows.length,
  returned: Math.min(rows.length, REFRESH_SAMPLE),
  truncated: rows.length > REFRESH_SAMPLE,
  items: rows.slice(0, REFRESH_SAMPLE).map(map),
});

/** Maps a sync/fetch failure to something a person can act on. */
function refreshFailure(err) {
  const msg = String((err && err.message) || err || 'unknown error');
  /* An expired MYS_COOKIE does not announce itself: the source answers a
     logged-out request with an HTML login page under HTTP 200, which parses as
     "no exhibitors". exhibitorSync already refuses that; this turns its
     wording into something a salesperson can act on, without ever echoing the
     credential or the URL. */
  if (/expired|non-JSON|401|403|unexpected shape/i.test(msg)) {
    return { status: 502, error: 'Official exhibitor source needs to be re-authenticated.',
      detail: 'reauth_required' };
  }
  if (/event not found/i.test(msg)) {
    return { status: 503, error: 'This event is not set up on this server yet.', detail: 'no_event' };
  }
  if (/tables do not exist|undefined_table|42P01/i.test(msg)) {
    return { status: 503, error: 'Exhibitor tables are not ready on this server.', detail: 'not_ready' };
  }
  if (/incomplete fetch/i.test(msg)) {
    return { status: 502, error: 'The official source returned an incomplete list. Nothing was changed.',
      detail: 'incomplete' };
  }
  return { status: 500, error: 'Could not read the official exhibitor list. Nothing was changed.',
    detail: 'error' };
}

/** Provenance for the page header: the last SUCCESSFUL verification. */
app.get('/api/exhibitors/status', async (req, res) => {
  try {
    const { rows: [run] } = await pool.query(
      `select id, finished_at, fetched, created, retired, source_version
         from exhibitor_import_runs
        where status = 'success' and dry_run = false
        order by finished_at desc limit 1`);
    const { rows: [live] } = await pool.query(
      `select count(*)::int listed,
              count(*) filter (where exists (
                select 1 from exhibitor_booths b
                 where b.exhibitor_id = e.id and b.retired_at is null))::int with_booth
         from event_exhibitors e where e.attendance_status = 'listed'`);
    res.json({
      ok: true,
      is_admin: isAdmin(req),
      source_configured: Boolean(process.env.MYS_COOKIE),
      last_verified_at: run ? run.finished_at : null,
      last_run: run || null,
      listed: live ? live.listed : 0,
      with_booth: live ? live.with_booth : 0,
      without_booth: live ? live.listed - live.with_booth : 0,
    });
  } catch (err) {
    console.error('[exhibitors] status failed:', err.message);
    res.status(500).json({ error: 'Could not read exhibitor status.' });
  }
});

/**
 * PREVIEW — reads the official source, plans everything, writes nothing.
 *
 * Deliberately never opens a transaction: there is no write to roll back, and
 * a BEGIN here would hold a connection open across a network fetch that can
 * take half a minute.
 */
app.post('/api/exhibitors/preview', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });

  let exhibitors;
  try {
    /* MYS_COOKIE is sent when it is set and is not required.
       Measured, rather than assumed: this endpoint currently answers an
       unauthenticated request with the full 984-exhibitor list, so demanding a
       credential the source does not ask for would block the feature for no
       gain. What protects us is not the cookie but the guards below it — if
       the source ever does start requiring a session, it will answer with an
       HTML login page, fetchExhibitors will refuse the non-JSON body, and this
       becomes "needs to be re-authenticated" rather than "no exhibitors". */
    exhibitors = await exhibitorSync.fetchExhibitors({ cookie: process.env.MYS_COOKIE || '' });
  } catch (err) {
    const f = refreshFailure(err);
    console.warn('[exhibitors] preview fetch failed:', err.message);
    return res.status(f.status).json(f);
  }

  const client = await pool.connect();
  try {
    const eventId = await exhibitorSync.resolveEvent(client);
    const plan = await exhibitorSync.plan(client, exhibitors, eventId);
    const version = exhibitorSync.sourceVersion(exhibitors);

    if (plan.refuse) {
      /* The guard that matters most. A small or empty list is indistinguishable
         from every exhibitor having withdrawn, so the planner refuses rather
         than retiring a show. Surfaced as a refusal to proceed, not an error
         to retry. */
      return res.status(409).json({
        error: 'The official list looks wrong, so nothing will be changed.',
        detail: 'refused', reason: plan.refuse, fetched: plan.liveCount, source_version: version,
      });
    }

    const flags = await exhibitorSync.planIntelReview(client, exhibitors, eventId);
    const reconcile = await exhibitorReconcile.planReconcile(client);
    const by = { link_existing: [], create_new: [], review: [] };
    for (const r of reconcile) (by[r.outcome] || by.review).push(r);

    /* Booth changes come from the booth table, not from the plan.
       plan()'s `prev` is an event_exhibitors row and carries no booths —
       booth reconciliation happens inside apply() — so comparing
       prev.booths against row.booths compared undefined with the incoming
       list and reported EVERY updated exhibitor as a booth change. On a
       re-run that changed nothing it claimed 976 of them. A preview that
       overstates change is worse than no preview: it teaches an admin that
       the numbers are noise and to click through them. */
    const { rows: currentBooths } = await client.query(
      `select e.exhibitor_source_id,
              coalesce(array_agg(b.booth_number order by b.booth_number)
                       filter (where b.booth_number is not null), '{}') booths
         from event_exhibitors e
         left join exhibitor_booths b on b.exhibitor_id = e.id and b.retired_at is null
        where e.attendance_status = 'listed'
          and ($1::int is null or e.event_id = $1)
        group by e.exhibitor_source_id`, [eventId]);
    const boothsNow = new Map(currentBooths.map((r) => [String(r.exhibitor_source_id), r.booths.map(String)]));
    const sortedKey = (a) => (a || []).map(String).slice().sort().join(',');

    const changedBooths = exhibitors
      .filter((e) => boothsNow.has(String(e.exhibitor_source_id)))     // new ones count as added, not changed
      .map((e) => ({ e, from: boothsNow.get(String(e.exhibitor_source_id)) }))
      .filter(({ e, from }) => sortedKey(from) !== sortedKey(e.booths))
      .map(({ e, from }) => ({ prev: { booths: from }, row: e }));

    const renamed = plan.updated.filter((u) => u.prev.source_name !== u.row.source_name);

    res.json({
      ok: true,
      preview: true,
      source_version: version,          // carried into apply, to detect drift
      fetched_at: new Date().toISOString(),
      event_id: eventId,
      tables_ready: plan.tablesReady !== false,

      official: {
        total_listed: exhibitors.length,
        with_booth: exhibitors.filter((e) => e.booths.length).length,
        without_booth: exhibitors.filter((e) => !e.booths.length).length,
      },
      exhibitors: {
        added: sample(plan.created, (r) => ({ name: r.source_name, exhid: r.exhibitor_source_id, booths: r.booths })),
        retired: sample(plan.retired, (r) => ({ name: r.source_name, exhid: r.exhibitor_source_id })),
        revived: sample(plan.revived, (r) => ({ name: r.source_name, exhid: r.exhibitor_source_id })),
        renamed: sample(renamed, (u) => ({ from: u.prev.source_name, to: u.row.source_name })),
        unchanged: plan.unchanged.length,
      },
      booths: {
        changed: sample(changedBooths, (u) => ({
          name: u.row.source_name,
          from: u.prev.booths || [], to: (u.row.booths || []).map(String),
        })),
      },
      crm: {
        link_existing: sample(by.link_existing, (r) => ({
          exhibitor: r.exhibitor.source_name, company_id: r.company_id,
          company: r.company_name, why: r.reason })),
        create_new: sample(by.create_new, (r) => ({ exhibitor: r.exhibitor.source_name, why: r.reason })),
        review: sample(by.review, (r) => ({ exhibitor: r.exhibitor.source_name, why: r.reason })),
        matched: plan.stats.matched, unmatched: plan.stats.unmatched, ambiguous: plan.stats.ambiguous,
      },
      classifications: {
        needs_review: sample(flags, (f) => ({ kind: f.kind, subject: f.subject_name, why: f.review_reason })),
      },
    });
  } catch (err) {
    const f = refreshFailure(err);
    console.error('[exhibitors] preview failed:', err.message);
    res.status(f.status).json(f);
  } finally {
    client.release();
  }
});

/**
 * APPLY — the real synchronisation, in one transaction.
 *
 * Re-fetches and re-plans from scratch rather than trusting anything the
 * preview produced. A plan held server-side between two requests is a plan
 * that can be replayed or applied to a database that has since moved; a plan
 * posted back by the browser is worse. The only thing carried across is the
 * source fingerprint, and it is carried in order to REFUSE, not to trust.
 */
app.post('/api/exhibitors/apply', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const expected = String((req.body || {}).source_version || '').trim();
  if (!expected) {
    return res.status(400).json({ error: 'Run a preview first.', detail: 'preview_required' });
  }

  let exhibitors;
  try {
    exhibitors = await exhibitorSync.fetchExhibitors({ cookie: process.env.MYS_COOKIE || '' });
  } catch (err) {
    const f = refreshFailure(err);
    console.warn('[exhibitors] apply fetch failed:', err.message);
    return res.status(f.status).json(f);
  }

  const version = exhibitorSync.sourceVersion(exhibitors);
  if (version !== expected) {
    /* The official list moved between the review and the click. Whatever the
       admin approved is not what would be written, so nothing is. */
    return res.status(409).json({
      error: 'The official exhibitor list changed since you reviewed it. Nothing was applied — '
        + 'please review the new version.',
      detail: 'source_changed',
      reviewed_version: expected, current_version: version,
      fetched: exhibitors.length,
    });
  }

  const client = await pool.connect();
  let released = false;
  const release = () => { if (!released) { released = true; client.release(); } };
  let runId = null;

  try {
    const eventId = await exhibitorSync.resolveEvent(client);
    const plan = await exhibitorSync.plan(client, exhibitors, eventId);

    if (plan.refuse) {
      /* Recorded as an aborted run before returning: a refusal is a fact about
         the source worth keeping, not just a message on a screen. */
      await client.query(
        `insert into exhibitor_import_runs (event_id, source, dry_run, status, fetched, error_message, finished_at)
         values ($1,$2,false,'aborted',$3,$4,NOW())`,
        [eventId, exhibitorSync.SOURCE, plan.liveCount, String(plan.refuse).slice(0, 400)]);
      return res.status(409).json({
        error: 'The official list looks wrong, so nothing was changed.',
        detail: 'refused', reason: plan.refuse,
      });
    }
    if (plan.tablesReady === false) {
      return res.status(503).json({ error: 'Exhibitor tables are not ready on this server.',
        detail: 'not_ready' });
    }

    const flags = await exhibitorSync.planIntelReview(client, exhibitors, eventId);

    await client.query('BEGIN');
    const { rows: [run] } = await client.query(
      `insert into exhibitor_import_runs (event_id, source, source_version, dry_run, status, fetched)
       values ($1,$2,$3,false,'pending',$4) returning id`,
      [eventId, exhibitorSync.SOURCE, version, exhibitors.length]);
    runId = run.id;

    // Attendance, booths and occupancy — the same call the CLI makes.
    const applied = await exhibitorSync.apply(client, plan, eventId, version, flags);

    await client.query(
      `update exhibitor_import_runs set status='success', created=$2, updated=$3, unchanged=$4,
              retired=$5, revived=$6, booths_added=$7, booths_retired=$8,
              matched=$9, unmatched=$10, ambiguous=$11, intel_flagged=$12, finished_at=NOW()
        where id=$1`,
      [runId, plan.created.length, plan.updated.length, plan.unchanged.length, plan.retired.length,
        plan.revived.length, applied.boothsAdded, applied.boothsRetired,
        plan.stats.matched, plan.stats.unmatched, plan.stats.ambiguous, applied.flagged]);

    await client.query('COMMIT');

    const { rows: [verified] } = await client.query(
      `select finished_at from exhibitor_import_runs where id = $1`, [runId]);
    release();

    /* ── phase two: CRM identity ───────────────────────────────────────────
       Deliberately AFTER the commit and deliberately not transactional,
       because that is what the tested pathway does. upsertCompany owns its own
       connection — it is the single creation path every ingestion route in
       this application funnels through, and the normalised-name resolution
       inside it is the duplicate guard that makes running this twice safe.
       Wrapping it in the transaction above would mean either bypassing it with
       a bare INSERT, which loses that guard, or changing a function the whole
       CRM depends on to satisfy one caller.

       The trade is real and worth stating: if this phase fails halfway,
       attendance is correct and some exhibitors are not yet linked to a
       company. That state is recoverable by running it again — it is
       idempotent — and it is reported as partial rather than as success. */
    const crm = { linked: 0, created: 0, reused: 0, declined: 0, unresolved: 0, failed: 0 };
    let crmError = null;
    try {
      const reconcile = await exhibitorReconcile.planReconcile(pool);
      for (const r of reconcile) {
        if (r.outcome === 'link_existing') {
          await pool.query('update event_exhibitors set company_id = $2 where id = $1',
            [r.exhibitor.id, r.company_id]);
          crm.linked++;
        } else if (r.outcome === 'create_new') {
          const company = await upsertCompany({
            name: r.exhibitor.source_name,
            source: 'exhibitor_import',
            sourceFile: 'mapyourshow:battery-show-na-2026',
          });
          // upsertCompany refuses names that are not companies. That is its
          // judgement and this defers to it rather than forcing a row.
          if (!company) { crm.declined++; continue; }
          if (company.updated) crm.reused++; else crm.created++;
          await pool.query('update event_exhibitors set company_id = $2 where id = $1',
            [r.exhibitor.id, company.id]);
        } else {
          crm.unresolved++;      // ambiguous — left alone, never guessed
        }
      }
    } catch (e) {
      crmError = e.message;
      crm.failed = 1;
      console.error('[exhibitors] CRM reconciliation failed after a successful sync:', e.message);
    }

    res.json({
      ok: true,
      applied: true,
      // Not "success" when half of it did not happen.
      status: crmError ? 'partial' : 'success',
      partial_reason: crmError
        ? 'Attendance and booths were updated, but linking exhibitors to CRM companies did not '
          + 'finish. Nothing is lost — run the refresh again to complete it.'
        : undefined,
      run_id: runId, source_version: version,
      last_verified_at: verified ? verified.finished_at : null,
      results: {
        created: plan.created.length,
        retired: plan.retired.length,
        revived: plan.revived.length,
        booth_changed: applied.boothsAdded,
        booths_retired: applied.boothsRetired,
        linked: crm.linked,
        companies_created: crm.created,
        companies_reused: crm.reused,
        companies_declined: crm.declined,
        needs_review: applied.flagged,
        review_cleared: applied.unflagged || 0,
        unresolved: crm.unresolved,
        failed: crm.failed,
      },
      occupancy: applied.occupancy,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the connection may be gone */ }
    release();      // free the connection before recording the failure
    console.error('[exhibitors] apply failed:', err.message);
    try {
      await pool.query(
        `insert into exhibitor_import_runs (source, dry_run, status, error_message, finished_at)
         values ($1,false,'failed',$2,NOW())`,
        [exhibitorSync.SOURCE, String(err.message).slice(0, 400)]);
    } catch { /* nothing further to do */ }
    const f = refreshFailure(err);
    // Never a partial success: the transaction rolled back, so nothing changed.
    res.status(f.status).json({ ...f, applied: false, run_id: runId });
  } finally {
    release();
  }
});

app.get('/api/me', (req, res) => {
  res.json({ ok: true, user: reqUser(req), is_admin: isAdmin(req) });
});

// ── Simplified email configuration: provider + domain + OAuth connect ──
// Public config (no tokens/secrets ever leave the server).
app.get('/api/email/config', async (req, res) => {
  try {
    const c = await getEmailOrgConfig();
    const provider = c.provider_type || '';
    res.json({
      ok: true, is_admin: isAdmin(req),
      provider, domain: c.allowed_domain || '',
      connected: Boolean(c.oauth_connected), email: c.oauth_email || '', display_name: c.oauth_display_name || '',
      connected_at: c.oauth_connected_at || null,
      client_configured: provider ? emailSvc.oauthConfigured(provider) : false,
    });
  } catch (err) { res.status(500).json({ error: 'Failed to load config', details: err.message }); }
});

// Save provider + domain (admin). Changing provider resets the connection.
app.post('/api/email/config', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const provider = String((req.body || {}).provider || '').trim();
    const domain = String((req.body || {}).domain || '').trim().toLowerCase();
    const patch = { provider_type: provider, allowed_domain: domain };
    const cur = await getEmailOrgConfig();
    if (cur.provider_type && cur.provider_type !== provider) {
      Object.assign(patch, { oauth_connected: false, oauth_email: null, oauth_access_token: null, oauth_refresh_token: null, integration_enabled: false });
    }
    await saveEmailOrgConfig(patch);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to save', details: err.message }); }
});

// Start the OAuth flow. Returns the provider auth URL, or actionable setup
// instructions if the org's OAuth app credentials aren't configured yet.
app.get('/api/email/oauth/start', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const provider = String(req.query.provider || '');
    const meta = emailSvc.oauthProviderMeta(provider);
    if (!meta) return res.status(400).json({ error: 'Unknown provider' });
    const redirectUri = baseUrl(req) + '/api/email/oauth/callback';
    if (!emailSvc.oauthConfigured(provider)) {
      const env = emailSvc.oauthEnvNames(provider);
      return res.status(400).json({
        error: 'not_configured',
        message: `Skeqi IT must register a ${meta.label} OAuth app once, then set ${env.id} and ${env.secret} as environment variables.`,
        env, redirect_uri: redirectUri, provider_label: meta.label,
      });
    }
    const state = crypto.randomBytes(16).toString('hex');
    _oauthStates.set(state, { provider, at: Date.now() });
    // prune old states
    for (const [k, v] of _oauthStates) if (Date.now() - v.at > 600000) _oauthStates.delete(k);
    const creds = emailSvc.oauthCreds(provider);
    const url = emailSvc.oauthAuthUrl(provider, { clientId: creds.clientId, redirectUri, state });
    res.json({ ok: true, url });
  } catch (err) { res.status(500).json({ error: 'Failed to start OAuth', details: err.message }); }
});

// OAuth redirect target — the provider sends the browser here with a code.
app.get('/api/email/oauth/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.redirect('/?email=error&reason=' + encodeURIComponent(error_description || error));
    const s = _oauthStates.get(state);
    if (!s) return res.redirect('/?email=error&reason=invalid_state');
    _oauthStates.delete(state);
    const creds = emailSvc.oauthCreds(s.provider);
    const redirectUri = baseUrl(req) + '/api/email/oauth/callback';
    const tokens = await emailSvc.oauthExchangeCode(s.provider, { code, ...creds, redirectUri });
    const info = await emailSvc.oauthUserInfo(s.provider, tokens.access_token);
    await saveEmailOrgConfig({
      provider_type: s.provider, oauth_connected: true, oauth_email: info.email, oauth_display_name: info.name,
      oauth_connected_at: new Date(), oauth_access_token: tokens.access_token, oauth_refresh_token: tokens.refresh_token || null,
      oauth_token_expires: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      integration_enabled: true,
    });
    res.redirect('/?email=connected');
  } catch (err) {
    res.redirect('/?email=error&reason=' + encodeURIComponent(err.message || 'connect_failed'));
  }
});

app.post('/api/email/disconnect', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    await saveEmailOrgConfig({ oauth_connected: false, oauth_email: null, oauth_display_name: null, oauth_access_token: null, oauth_refresh_token: null, oauth_token_expires: null, integration_enabled: false });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed', details: err.message }); }
});

// Derives a status badge string from an org-config row.
// Strip OAuth tokens (and any secret) before an org config leaves the server.
function publicOrgConfig(cfg) {
  if (!cfg) return cfg;
  const { oauth_access_token, oauth_refresh_token, ...safe } = cfg;
  return safe;
}
// Organization *configuration* state (separate from per-user connection state).
function orgStatus(cfg) {
  if (!cfg || !cfg.provider_type) return 'not_configured';
  // OAuth providers: configuration is complete once the org account is connected.
  if (cfg.provider_type === 'microsoft365' || cfg.provider_type === 'google') {
    return cfg.oauth_connected ? 'ready_for_users' : 'not_configured';
  }
  const hasCore = cfg.smtp_host && cfg.smtp_port && cfg.imap_host && cfg.imap_port;
  if (!hasCore) return 'configuration_incomplete';
  if (cfg.integration_enabled && cfg.smtp_verified && cfg.imap_verified) return 'ready_for_users';
  if (cfg.smtp_verified && cfg.imap_verified) return 'verified';
  // Servers are present but not yet verified — this is a valid, complete config,
  // NOT "incomplete". Verification is a connection concern, tested per user.
  return 'servers_configured';
}

// Provider catalog — labels, connection type, and default SMTP/IMAP endpoints.
// Drives the Settings dropdown so the UI stays in sync with the backend registry.
app.get('/api/email/providers', (req, res) => {
  res.json({ ok: true, providers: providers.listProviders() });
});

// Auto Detect: infer the provider from an email address / domain via MX records.
app.post('/api/email/detect-provider', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim();
    res.json(await providers.detectProvider(email));
  } catch (err) { res.status(500).json({ error: 'Detection failed', details: err.message }); }
});

// Org config: readable by any logged-in user (no secrets stored here); only
// admins may modify or run tests.
app.get('/api/email/org-config', async (req, res) => {
  try {
    const cfg = await getEmailOrgConfig();
    res.json({ ok: true, config: publicOrgConfig(cfg), status: orgStatus(cfg), is_admin: isAdmin(req) });
  } catch (err) { res.status(500).json({ error: 'Failed to load config', details: err.message }); }
});

app.post('/api/email/org-config', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const patch = { ...(req.body || {}) };
    const cur = await getEmailOrgConfig();
    // Provider change ⇒ wipe the previous provider's state so ONLY the newly
    // selected provider's flow can ever run (no legacy Microsoft/OAuth or stale
    // SMTP endpoints lingering under a different provider).
    if (patch.provider_type && patch.provider_type !== cur.provider_type) {
      console.log(`[email:config] provider changed ${cur.provider_type || '(none)'} → ${patch.provider_type} — clearing legacy OAuth grant + verification flags`);
      Object.assign(patch, {
        oauth_connected: false, oauth_email: null, oauth_display_name: null,
        oauth_access_token: null, oauth_refresh_token: null, oauth_token_expires: null,
        oauth_connected_at: null,
        smtp_verified: false, imap_verified: false, integration_enabled: false,
      });
    }
    // Auto-enable sending for SMTP providers once servers are present — removes
    // the confusing manual "Enable Integration" step. Actual sending still
    // requires each user to connect their own mailbox (a real auth test).
    const effectiveProvider = patch.provider_type || cur.provider_type;
    const isSmtpProvider = effectiveProvider && effectiveProvider !== 'microsoft365' && effectiveProvider !== 'google';
    const smtpHost = patch.smtp_host !== undefined ? patch.smtp_host : cur.smtp_host;
    const imapHost = patch.imap_host !== undefined ? patch.imap_host : cur.imap_host;
    if (isSmtpProvider && smtpHost && imapHost) patch.integration_enabled = true;

    const cfg = await saveEmailOrgConfig(patch);
    console.log(`[email:config] saved provider=${cfg.provider_type || '(none)'} smtp=${cfg.smtp_host || '(none)'}:${cfg.smtp_port || '?'} imap=${cfg.imap_host || '(none)'}:${cfg.imap_port || '?'} domain=${cfg.allowed_domain || '(none)'} integration_enabled=${cfg.integration_enabled}`);
    res.json({ ok: true, config: publicOrgConfig(cfg), status: orgStatus(cfg) });
  } catch (err) { res.status(500).json({ error: 'Failed to save config', details: err.message }); }
});

app.post('/api/email/org-config/test-smtp', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const cfg = await getEmailOrgConfig();
    const secure = cfg.smtp_encryption === 'ssl' || cfg.smtp_encryption === 'tls' || Number(cfg.smtp_port) === 465;
    console.log(`[email:test-smtp] provider=${cfg.provider_type || '(none)'} host=${cfg.smtp_host || '(none)'}:${cfg.smtp_port || '?'} encryption=${cfg.smtp_encryption || '?'} secure=${secure}`);
    const result = await emailSvc.probeHost(cfg.smtp_host, cfg.smtp_port, secure);
    console.log(`[email:test-smtp] result ok=${result.ok} — ${result.message}`);
    await saveEmailOrgConfig({ smtp_verified: result.ok });
    await recordEmailTest({ userId: reqUser(req), kind: 'smtp', scope: 'org', target: `${cfg.smtp_host}:${cfg.smtp_port}`, ok: result.ok, message: result.message });
    res.json({ ok: true, result });
  } catch (err) { res.status(500).json({ error: 'Test failed', details: err.message }); }
});

app.post('/api/email/org-config/test-imap', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const cfg = await getEmailOrgConfig();
    const secure = cfg.imap_encryption === 'ssl' || cfg.imap_encryption === 'tls' || Number(cfg.imap_port) === 993;
    console.log(`[email:test-imap] provider=${cfg.provider_type || '(none)'} host=${cfg.imap_host || '(none)'}:${cfg.imap_port || '?'} encryption=${cfg.imap_encryption || '?'} secure=${secure}`);
    const result = await emailSvc.probeHost(cfg.imap_host, cfg.imap_port, secure);
    console.log(`[email:test-imap] result ok=${result.ok} — ${result.message}`);
    await saveEmailOrgConfig({ imap_verified: result.ok });
    await recordEmailTest({ userId: reqUser(req), kind: 'imap', scope: 'org', target: `${cfg.imap_host}:${cfg.imap_port}`, ok: result.ok, message: result.message });
    res.json({ ok: true, result });
  } catch (err) { res.status(500).json({ error: 'Test failed', details: err.message }); }
});

app.post('/api/email/org-config/validate-domain', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const cfg = await getEmailOrgConfig();
    const dns = await emailSvc.validateDomain(cfg.allowed_domain || 'skeqi.com');
    await saveEmailOrgConfig({ spf_status: dns.spf, dkim_status: dns.dkim, dmarc_status: dns.dmarc });
    await recordEmailTest({ userId: reqUser(req), kind: 'domain', scope: 'org', target: cfg.allowed_domain || 'skeqi.com', ok: dns.spf === 'pass', message: `SPF ${dns.spf} · DKIM ${dns.dkim} · DMARC ${dns.dmarc}` });
    res.json({ ok: true, result: dns });
  } catch (err) { res.status(500).json({ error: 'Domain validation failed', details: err.message }); }
});

async function setIntegration(req, res, enable) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    if (enable) {
      const cur = await getEmailOrgConfig();
      if (!cur.smtp_verified || !cur.imap_verified) {
        return res.status(400).json({ error: 'Verify SMTP and IMAP before enabling the integration.' });
      }
    }
    const cfg = await saveEmailOrgConfig({ integration_enabled: enable });
    res.json({ ok: true, config: publicOrgConfig(cfg), status: orgStatus(cfg) });
  } catch (err) { res.status(500).json({ error: 'Failed', details: err.message }); }
}
app.post('/api/email/org-config/enable', (req, res) => setIntegration(req, res, true));
app.post('/api/email/org-config/disable', (req, res) => setIntegration(req, res, false));

// Whether real sending is available yet (used to gate the Draft modal) and the
// sender identity. Two provider families:
//   • OAuth providers (Microsoft 365 / Google): the org-level sign-in is enough,
//     and the sender is the signed-in account.
//   • SMTP/IMAP providers (NetEase Enterprise Mail / Custom): the org SMTP+IMAP
//     must be verified AND each user must connect their own @domain mailbox.
const OAUTH_PROVIDER_TYPES = ['microsoft365', 'google'];
// The sender's display name comes from the configured email account first, then
// the user profile — never a hardcoded placeholder. Empty ⇒ show email only.
async function senderProfileName() {
  try { const raw = await getSetting('sender_profile'); return raw ? (JSON.parse(raw).name || '') : ''; }
  catch { return ''; }
}
app.get('/api/email/status', async (req, res) => {
  try {
    const cfg = await getEmailOrgConfig();
    const acct = await getEmailUserAccount(reqUser(req));
    const profileName = await senderProfileName();
    const enabled = Boolean(cfg && cfg.integration_enabled);
    const isOAuth = OAUTH_PROVIDER_TYPES.includes(cfg.provider_type);
    let canSend, email, name;
    if (isOAuth) {
      canSend = enabled && Boolean(cfg.oauth_connected);
      email = cfg.oauth_email || '';
      name = (cfg.oauth_display_name || '').trim() || profileName || '';
    } else {
      // SMTP providers: a successful per-user mailbox auth test is the real proof
      // of send capability (stronger than the org-level reachability probe).
      const userConnected = Boolean(acct && acct.connection_status === 'connected');
      canSend = enabled && userConnected;
      email = (acct && acct.sender_email) || '';
      name = ((acct && acct.sender_name) || '').trim() || profileName || '';
    }
    res.json({
      ok: true, ready: canSend, can_send: canSend,
      provider: cfg.provider_type || '', email, display_name: name,
      message: canSend ? '' : 'Email sending is not yet fully configured. Please complete and verify the organization and mailbox settings.',
    });
  } catch (err) { res.status(500).json({ error: 'Failed', details: err.message }); }
});

// Per-user mailbox account (every logged-in user).
app.get('/api/email/account', async (req, res) => {
  try { res.json({ ok: true, account: await getEmailUserAccount(reqUser(req)) }); }
  catch (err) { res.status(500).json({ error: 'Failed', details: err.message }); }
});

app.post('/api/email/account', async (req, res) => {
  try {
    const cfg = await getEmailOrgConfig();
    const b = req.body || {};
    const domain = (cfg.allowed_domain || 'skeqi.com').toLowerCase();
    if (b.sender_email && !String(b.sender_email).toLowerCase().endsWith('@' + domain)) {
      return res.status(400).json({ error: `Sender email must be an @${domain} address.` });
    }
    const patch = {};
    for (const k of ['sender_name', 'sender_email', 'reply_to', 'mailbox_username', 'auth_method']) if (b[k] != null) patch[k] = b[k];
    if (b.secret) patch.secret = b.secret;
    if (b.sync_enabled != null) patch.sync_enabled = Boolean(b.sync_enabled);
    const account = await saveEmailUserAccount(reqUser(req), patch);
    res.json({ ok: true, account });
  } catch (err) { res.status(500).json({ error: 'Failed to save account', details: err.message }); }
});

// Provider-agnostic, staged mailbox verification. The engine is built ONLY from
// the currently-selected provider, so exactly one authentication flow runs.
async function accountTest(req, res) {
  try {
    const userId = reqUser(req);
    const cfg = await getEmailOrgConfig();
    const acct = await getEmailUserAccount(userId);
    const secret = await getEmailUserSecret(userId);
    console.log(`[email:verify] user=${userId} selectedProvider=${cfg.provider_type || '(none)'} — running ONLY this provider's flow`);
    const engine = providers.createEngine({ orgConfig: cfg, account: acct, secret });
    const result = await engine.verifyConnectionStaged((line) => console.log('[email:verify] ' + line));
    const patch = { connection_status: result.ok ? 'connected' : 'failed' };
    if (result.ok) patch.last_sync_at = new Date();
    const account = await saveEmailUserAccount(userId, patch);
    const summary = (result.stages || []).map((s) => `${s.stage}:${s.ok ? 'ok' : 'fail'}`).join(' ');
    await recordEmailTest({ userId, kind: 'mailbox', scope: 'user', target: account.sender_email || '', ok: result.ok, message: summary });
    res.json({ ok: true, result: { ok: result.ok, stages: result.stages, provider: cfg.provider_type || '' }, account });
  } catch (err) {
    console.error('[email:verify] error:', err.message);
    res.status(500).json({ error: 'Test failed', details: err.message });
  }
}
app.post('/api/email/account/test', accountTest);
app.post('/api/email/account/reconnect', accountTest);

app.post('/api/email/account/send-test', async (req, res) => {
  try {
    const cfg = await getEmailOrgConfig();
    if (!cfg.integration_enabled) return res.status(400).json({ error: 'Email sending is not enabled by your administrator yet.' });
    const acct = await getEmailUserAccount(reqUser(req));
    const secret = await getEmailUserSecret(reqUser(req));
    if (!acct || !acct.sender_email || !secret) return res.status(400).json({ error: 'Connect your mailbox first.' });
    // Send via the provider engine — a self-addressed test message.
    const engine = providers.createEngine({ orgConfig: cfg, account: acct, secret });
    const result = await engine.sendEmail({
      to: acct.sender_email,
      subject: 'Skeqi EmailDrafter — test email',
      text: 'This is a test email from Skeqi EmailDrafter. If you received it, sending is working.',
    });
    await recordEmailTest({ userId: reqUser(req), kind: 'send', scope: 'user', target: acct.sender_email, ok: result.ok, message: result.message });
    res.json({ ok: true, result });
  } catch (err) { res.status(500).json({ error: 'Send failed', details: err.message }); }
});

app.post('/api/email/account/disconnect', async (req, res) => {
  try { res.json({ ok: true, account: await saveEmailUserAccount(reqUser(req), { connection_status: 'disconnected', sync_enabled: false }) }); }
  catch (err) { res.status(500).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/email/prefs', async (req, res) => {
  try { res.json({ ok: true, prefs: await getEmailUserPrefs(reqUser(req)) }); }
  catch (err) { res.status(500).json({ error: 'Failed', details: err.message }); }
});
app.post('/api/email/prefs', async (req, res) => {
  try { res.json({ ok: true, prefs: await saveEmailUserPrefs(reqUser(req), req.body || {}) }); }
  catch (err) { res.status(500).json({ error: 'Failed to save preferences', details: err.message }); }
});

// Recent connection-test results (org tests + this user's own; admins see all).
app.get('/api/email/test-history', async (req, res) => {
  try {
    const tests = await listEmailTests({ userId: reqUser(req), limit: 20, adminAll: isAdmin(req) });
    res.json({ ok: true, tests });
  } catch (err) { res.status(500).json({ error: 'Failed', details: err.message }); }
});

// =========================================================================
// Usage tracking
// =========================================================================

app.get('/api/usage', async (req, res) => {
  const out = getUsage();
  /* Retrieval-tool usage is DURABLE, not session state: it is read from the
     execution manifests, so it does not reset with the session bar and is
     labelled with its own scope in the UI. It carries no cost, because none is
     known - see retrievalToolUsage(). A failure here must not blank the usage
     bar, so the model figures are returned either way. */
  try {
    out.retrieval_tools = await jobsDb.retrievalToolUsage();
  } catch (e) {
    out.retrieval_tools = null;
  }
  res.json(out);
});

app.post('/api/usage/reset', (req, res) => {
  resetUsage();
  res.json({ ok: true });
});

/* The dashboard's two read endpoints each fan out to a handful of aggregate
   queries. A query that is merely slow is a slow page; one that is blocked —
   waiting on a lock, or on a connection that never opens — is a response that
   never gets sent, and the browser cannot tell that apart from a server still
   thinking. Bounding the wait turns the second case into a 503 the UI can
   render. Kept under the browser's own 20s deadline so this more specific
   error is the one that wins. */
const AIU_QUERY_DEADLINE_MS = 15000;
function withDeadline(promise, ms = AIU_QUERY_DEADLINE_MS) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Database did not respond in time'), { timedOut: true })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Full AI Usage dashboard payload: KPIs + time series + breakdowns (feature /
// model / company / user) + budget status, for a date range.
//   ?period=today|yesterday|7d|30d|month|prev_month|year|all|custom [&from=&to=][&bucket=day|week|month]
app.get('/api/ai-usage', async (req, res) => {
  try {
    const period = req.query.period || 'all';
    const filter = buildPeriodFilter(period, req.query.from, req.query.to);
    const bucket = req.query.bucket || ((period === 'year' || period === 'all') ? 'month' : 'day');
    /* The assistant needs its own filter object: aiChatByModel joins laterally
       against the events table and aliases it, so the period predicate has to
       be written against that alias rather than a bare column. */
    const chatFilter = buildPeriodFilter(period, req.query.from, req.query.to, 'e');
    const [kpis, timeseries, byFeature, byModel, byCompany, byUser, budget, todayK, monthK,
      chatSummary, chatByModel] = await withDeadline(Promise.all([
      aiUsageKpis(filter),
      aiUsageTimeseries(filter, bucket),
      aiUsageFeatureBreakdown(filter),
      aiUsageByModel(filter),
      aiUsageByCompany(period === 'custom' ? 'all' : period, 15),
      aiUsageByUser(filter),
      getAiBudget(),
      aiUsageKpis(buildPeriodFilter('today')),
      aiUsageKpis(buildPeriodFilter('month')),
      aiChatSummary(filter),
      aiChatByModel(chatFilter),
    ]));
    const warn = budget.warn_threshold_pct || 80;
    const pct = (used, cap) => (cap ? Math.round((used / cap) * 100) : 0);
    res.json({
      ok: true, period, bucket,
      session: getUsage().ai,
      kpis, timeseries,
      by_feature: byFeature, by_model: byModel, by_company: byCompany, by_user: byUser,
      // The AI Assistant as its own category — a turn is not a call, and its
      // cost is spread across the models the turn actually used.
      chat: { ...chatSummary, by_model: chatByModel },
      budget,
      budget_status: {
        warn_threshold_pct: warn,
        daily_token_pct: pct(todayK.total_tokens, budget.daily_token_budget),
        monthly_token_pct: pct(monthK.total_tokens, budget.monthly_token_budget),
        daily_cost_pct: pct(todayK.cost_usd, budget.daily_cost_budget),
        monthly_cost_pct: pct(monthK.cost_usd, budget.monthly_cost_budget),
        today_cost: todayK.cost_usd, month_cost: monthK.cost_usd,
        today_tokens: todayK.total_tokens, month_tokens: monthK.total_tokens,
      },
    });
  } catch (err) {
    // Logged, not just returned: when this page was stuck there was nothing in
    // the server log to correlate it against, which is half of why it was hard
    // to place. Every failure to answer should leave a trace here.
    console.error('[ai-usage] summary failed:', err.message);
    res.status(err.timedOut ? 503 : 500)
      .json({ ok: false, error: err.timedOut ? 'Usage database did not respond in time.' : 'Failed to load AI usage', details: err.message });
  }
});

// Paginated request-level audit log (metadata only — no prompts/email content).
app.get('/api/ai-usage/events', async (req, res) => {
  try {
    // alias 'e' — aiUsageEvents joins companies, which also has created_at.
    const filter = buildPeriodFilter(req.query.period || 'all', req.query.from, req.query.to, 'e');
    const out = await withDeadline(aiUsageEvents(filter, {
      feature: req.query.feature || null,
      status: req.query.status || null,
      limit: parseInt(req.query.limit, 10) || 50,
      offset: parseInt(req.query.offset, 10) || 0,
    }));
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[ai-usage] events failed:', err.message);
    res.status(err.timedOut ? 503 : 500)
      .json({ ok: false, error: err.timedOut ? 'Usage database did not respond in time.' : 'Failed to load usage events', details: err.message });
  }
});

// CSV export of the audit log (respects the same filters).
app.get('/api/ai-usage/export.csv', async (req, res) => {
  try {
    // alias 'e' — aiUsageEvents joins companies, which also has created_at.
    const filter = buildPeriodFilter(req.query.period || 'all', req.query.from, req.query.to, 'e');
    const out = await aiUsageEvents(filter, {
      feature: req.query.feature || null, status: req.query.status || null, limit: 200, offset: 0,
    });
    const cols = ['created_at', 'feature', 'sub_feature', 'request_type', 'status', 'model', 'provider',
      'input_tokens', 'output_tokens', 'total_tokens', 'cost_usd', 'response_ms', 'user_id', 'company_name', 'contact_id'];
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [cols.join(',')].concat(out.rows.map((r) => cols.map((c) => esc(r[c])).join(',')));
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="ai-usage.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: 'Failed to export', details: err.message });
  }
});

app.get('/api/ai-usage/pricing', async (req, res) => {
  try {
    // Forced: someone reading this endpoint is asking what is true now.
    await refreshPricing({ force: true });
    res.json({ ok: true, pricing: await listActivePricing(), cache: pricingStatus() });
  }
  catch (err) { res.status(500).json({ error: 'Failed to load pricing', details: err.message }); }
});

app.get('/api/ai-usage/budget', async (req, res) => {
  try { res.json({ ok: true, budget: await getAiBudget() }); }
  catch (err) { res.status(500).json({ error: 'Failed to load budget', details: err.message }); }
});

app.post('/api/ai-usage/budget', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    for (const k of ['daily_token_budget', 'monthly_token_budget', 'max_tokens_per_request', 'warn_threshold_pct']) {
      if (b[k] != null) patch[k] = Math.max(0, parseInt(b[k], 10) || 0);
    }
    for (const k of ['daily_cost_budget', 'monthly_cost_budget', 'per_user_cost_budget', 'max_cost_per_request']) {
      if (b[k] != null) patch[k] = Math.max(0, parseFloat(b[k]) || 0);
    }
    if (b.auto_refresh_disabled != null) patch.auto_refresh_disabled = Boolean(b.auto_refresh_disabled);
    if (b.hard_limit != null) patch.hard_limit = Boolean(b.hard_limit);
    res.json({ ok: true, budget: await setAiBudget(patch) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save budget', details: err.message });
  }
});

// =========================================================================
// Export (CSV / XML / XLSX / JSON)
// =========================================================================

async function getContactsForCompany(company) {
  const saved = await listContactsByCompany(company);
  return saved.map((c) => ({
    name: c.full_name, title: c.job_title, company: c.company, department: c.department,
    email: c.email, linkedin: c.linkedin_url, confidence: c.confidence, relevance: c.relevance,
    location: c.address, draft_subject: c.draft_subject, draft_body: c.draft_body,
    draft_followup: c.draft_followup, draft_rationale: c.draft_rationale
  }));
}

app.get('/api/export', async (req, res) => {
  try {
    const company = (req.query.company || '').trim();
    const format = (req.query.format || 'csv').toLowerCase();
    if (!company) return res.status(400).send("Missing 'company' parameter.");
    if (!['json', 'xml', 'csv', 'xlsx'].includes(format)) {
      return res.status(400).send('Unsupported format. Use json, xml, csv, or xlsx.');
    }

    const contacts = await getContactsForCompany(company);
    const safe = safeFilename(company);

    if (format === 'json') {
      res.set('Content-Disposition', `attachment; filename="${safe}_contacts.json"`);
      return res.json(contacts);
    }
    if (format === 'xml') {
      res.set('Content-Type', 'application/xml');
      res.set('Content-Disposition', `attachment; filename="${safe}_contacts.xml"`);
      return res.send(contactsToXml(contacts));
    }
    if (format === 'xlsx') {
      const buf = await contactsToXlsx(contacts);
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${safe}_contacts.xlsx"`);
      return res.send(Buffer.from(buf));
    }
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="${safe}_contacts.csv"`);
    res.send(contactsToCsv(contacts, [...CRM_FIELDS, 'company']));
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).send('Export failed.');
  }
});

app.get('/api/export-csv', async (req, res) => {
  try {
    const company = (req.query.company || '').trim();
    if (!company) return res.status(400).send("Missing 'company' parameter.");
    const contacts = await getContactsForCompany(company);
    const safe = safeFilename(company);
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="${safe}_crm.csv"`);
    res.send(contactsToCsv(contacts, CRM_FIELDS));
  } catch (err) {
    res.status(500).send('Export failed.');
  }
});

app.post('/api/export-xlsx', async (req, res) => {
  try {
    const contacts = req.body.contacts || [];
    if (!contacts.length) return res.status(400).send('No contacts provided.');
    const buf = await contactsToXlsx(contacts);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="selected_contacts.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).send('Export failed.');
  }
});

// =========================================================================
// Startup: init DB schema, then start OCR worker and HTTP server
// =========================================================================

initDb()
  .then(async () => {
    /* Cost is computed from ai_model_pricing. Registering the loader as well
       as loading once means a price corrected in the table takes effect on the
       running instance, within AI_PRICING_TTL_MS, instead of waiting for a
       redeploy — which is how an unconfirmed Qwen rate went on being reported
       as confirmed after the table already said otherwise. */
    setPricingLoader(listActivePricing);
    try { setPricingTable(await listActivePricing()); } catch (e) { console.error('pricing load failed:', e.message); }

    /* A research job whose worker died cannot report its own death. Sweep on
       boot, then periodically, so an interrupted run is marked as such instead
       of sitting "running" forever and blocking the next attempt for that
       company. This is also what makes an engine restart visible to the user. */
    const sweepJobs = async () => {
      try {
        const gone = await jobsDb.sweepStaleQwenJobs();
        if (gone.length) {
          console.log(`account research: marked ${gone.length} stalled job(s) interrupted `
                    + `(${gone.map((g) => g.company_name).join(', ')})`);
        }
      } catch (e) { console.error('job sweep failed:', e.message); }
    };
    await sweepJobs();
    setInterval(sweepJobs, 5 * 60 * 1000).unref();

    initOcrWorker();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Lead Finder (+ card scanner) running at http://0.0.0.0:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
