const config = require('./config');

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const {
  initDb,
  insertContact, listContacts, getContact, listContactsByCompany, deleteContact, deleteContacts,
  updateContactDraft, findExistingContact, upsertContact, updateContact,
  upsertCompany, findCompanyByName, getCompany, listCompanies, getCompanyContacts,
  getOrCreateAccount, getAccount, listAccounts, listAccountGroups, getAccountContacts,
  listCompaniesForAccount, mergeAccounts,
  insertBusinessCard, listBusinessCardsForContact,
  getApolloCache, setApolloCache,
  getCompanySearchCache, setCompanySearchCache, updateCachedLeadDraft,
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
  getSetting, setSetting, listEvents
} = require('./db');
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
const { draftEmail, listDraftModes, categorizeEmail, EMAIL_CATEGORIES, buildPromptForMode, CLAUDE_MODEL } = require('./claude');
const { contactsToCsv, contactsToXml, contactsToXlsx, safeFilename } = require('./export');
const { parseCompanyFile } = require('./companyImport');
const { normalizeFileToImages } = require('./cardBatch');
const { getUsage, resetUsage, recordAiEvent, setPersist, setPricingTable } = require('./usage');
const emailSvc = require('./email');
const providers = require('./providers');
const {
  recordAiUsage, aiUsageTotals, aiUsageByFeature, aiUsageByCompany, estimateAiSaved,
  getAiBudget, setAiBudget, listActivePricing, buildPeriodFilter,
  aiUsageKpis, aiUsageTimeseries, aiUsageFeatureBreakdown, aiUsageByModel, aiUsageByUser, aiUsageEvents,
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
  next();
});

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
app.get('/api/contacts', async (req, res) => {
  try {
    const { q, event, company, industry, follow_up_status, tags, assigned_salesperson, accounts, contact_ids, department_categories, seniority_levels, sortBy } = req.query;
    // Multi-select filters travel as comma-separated strings (?accounts=Ford,Tesla,CATL).
    const accountList = accounts ? String(accounts).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const contactIdList = contact_ids ? String(contact_ids).split(',').map(Number).filter((n) => Number.isInteger(n)) : [];
    const departmentList = department_categories ? String(department_categories).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const seniorityList = seniority_levels ? String(seniority_levels).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const hasStructuredFilter = event || company || industry || follow_up_status || tags || assigned_salesperson
      || accountList.length || contactIdList.length || departmentList.length || seniorityList.length;

    let contacts;
    if (hasStructuredFilter) {
      contacts = await filterContacts({
        event, company, industry, follow_up_status, tags, assigned_salesperson,
        accounts: accountList, contact_ids: contactIdList,
        department_categories: departmentList, seniority_levels: seniorityList, sortBy
      });
    } else if (q) {
      contacts = await searchContacts(q);
    } else {
      contacts = await listContacts(200);
    }

    const enriched = contacts.map(c => {
      const draftCount = Number(c.draft_count) || 0;
      return {
        ...c,
        draft_count: draftCount,
        latest_draft_id: c.latest_draft_id || null,
        has_draft: Boolean(c.draft_subject) || draftCount > 0,
      };
    });
    res.json({ ok: true, contacts: enriched });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load contacts' });
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

      if (!forceRefresh && account) {
        const existingContacts = await getAccountContacts(account.id);
        if (existingContacts.length > 0) {
          allContacts = allContacts.concat(existingContacts.map(contactRowToLeadFormat));
          messages.push(`CACHE:${companyName}:${existingContacts.length}:${account.updated_at}`);
          continue;
        }
      }

      if (!apolloConfigured()) {
        messages.push(`${companyName}: no local data found, and Apollo API key not configured.`);
        continue;
      }

      const result = await doCompanySearch(companyName, apiKey, {
        perCompanyLimit: Math.min(perCompanyLimit, remainingBudget),
        departments
      });
      if (result.error) {
        messages.push(`${companyName}: ${result.error}`);
        continue;
      }

      const contacts = result.contacts || [];
      remainingBudget -= contacts.length;
      const orgs = result.orgs || [];

      // Pre-upsert one company (legal-entity) row per distinct name Apollo
      // actually returned, parented to this Account -- so the per-contact
      // upsertContact() below (which resolves company_id from c.company text)
      // attaches to a row that's already correctly grouped under the Account.
      let lastCompanyId = null;
      const seenCompanyNames = new Set();
      for (const companyName2 of contacts.map((c) => c.company || companyName)) {
        if (seenCompanyNames.has(companyName2.toLowerCase())) continue;
        seenCompanyNames.add(companyName2.toLowerCase());
        const compResult = await upsertCompany({ name: companyName2, account_name: companyName });
        if (compResult) lastCompanyId = compResult.id;
      }
      if (!seenCompanyNames.size) {
        // No contacts came back at all -- still ensure a company row exists
        // under this Account so the search isn't a total no-op.
        const compResult = await upsertCompany({ name: companyName, account_name: companyName });
        if (compResult) lastCompanyId = compResult.id;
      }

      let importedCount = 0;
      let duplicatesSkipped = 0;
      for (const c of contacts) {
        const cleanEmail = c.email && !String(c.email).startsWith('(') && !String(c.email).includes('N/A') ? c.email : '';
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
          email_lookup_status: cleanEmail ? 'found' : 'not_checked'
        });
        c.contact_id = id;
        c.email_lookup_status = cleanEmail ? 'found' : 'not_checked';
        if (updated) duplicatesSkipped++; else importedCount++;
        console.log(`[leads/search] -> contact_id=${id} updated=${updated} email_saved=${JSON.stringify(cleanEmail)}`);
        await logContactActivity(id, 'apollo_search', updated ? `Refreshed via Apollo search for ${companyName}` : `Found via Apollo search for ${companyName}`);
      }

      await logApolloResult('people_search', lastCompanyId, null, companyName, JSON.stringify({ contacts, orgs }));
      await setCompanySearchCache(companyCacheKey(companyName), JSON.stringify({ company: companyName, contacts, orgs }));

      summaries.push({
        company: companyName, departments: departmentLabels,
        foundCount: contacts.length, importedCount, duplicatesSkipped
      });

      allContacts = allContacts.concat(contacts);
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

// POST /api/contacts/:id/enrich-email
// Smart enrich: checks apollo_raw_json first (free), then falls back to reveal API.
app.post('/api/contacts/:id/enrich-email', async (req, res) => {
  try {
    const contactId = Number(req.params.id);
    const contact = await getContact(contactId);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    if (contact.email) {
      return res.json({ ok: true, email: contact.email, source: 'neon_cached' });
    }

    let email = '';
    let source = '';

    // Step 1: try to extract from stored apollo_raw_json (free, no API call)
    if (contact.apollo_raw_json) {
      try {
        const rawPerson = JSON.parse(contact.apollo_raw_json);
        const candidate = extractApolloEmail(rawPerson);
        if (candidate) { email = candidate; source = 'apollo_raw_json'; }
        console.log(`[enrich-email] contact_id=${contactId} raw_json_check: email=${JSON.stringify(candidate)}`);
      } catch (e) {
        console.warn(`[enrich-email] contact_id=${contactId} failed to parse apollo_raw_json: ${e.message}`);
      }
    }

    // Step 2: if still missing and we have an Apollo ID, call the reveal API
    if (!email && contact.apollo_person_id) {
      if (!apolloConfigured()) {
        return res.json({ ok: true, email: '', email_lookup_status: 'not_checked', message: 'Apollo not configured' });
      }
      console.log(`[enrich-email] contact_id=${contactId} calling reveal for apollo_id=${contact.apollo_person_id}`);
      const result = await revealPersonEmail(contact.apollo_person_id, config.APOLLO_API_KEY);
      if (result.error) {
        return res.status(502).json({ error: result.error });
      }
      if (result.email && !result.email.startsWith('(')) {
        email = result.email;
        source = 'apollo_reveal';
        await updateContact(contactId, {
          email,
          email_lookup_status: 'found',
          apollo_raw_json: result.raw ? JSON.stringify(result.raw) : undefined
        });
      } else {
        // Apollo was called but returned no email — record this so we don't retry
        source = 'apollo_reveal';
        await updateContact(contactId, { email_lookup_status: 'not_available' });
      }
    } else if (email) {
      await updateContact(contactId, { email, email_lookup_status: 'found' });
    }

    const finalStatus = email ? 'found' : (contact.apollo_person_id ? 'not_available' : 'not_checked');
    console.log(`[enrich-email] contact_id=${contactId} result: email=${JSON.stringify(email)} source=${source} status=${finalStatus}`);
    res.json({ ok: true, email, email_lookup_status: finalStatus, source });
  } catch (err) {
    console.error('Enrich email error:', err);
    res.status(500).json({ error: err.message });
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
    const { mode, extraInstructions } = req.query;
    const draft = await checkEquivalentDraft(Number(req.params.id), mode, extraInstructions);
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
async function buildDraftContext(contact, mode, extraInstructions, resolvedContactId, includeTagIds) {
  const context = {};
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
      skqModules = await matchSkqForTags(profile.productValues);
      if (skqModules.length) {
        context.skqCapabilities =
          `Relevant SKQ capabilities (from SKQ's module catalog — include only those that fit this email):\n` +
          skqModules.map((m) => `- ${m.name_en}${m.name_cn ? ' / ' + m.name_cn : ''}`).join('\n');
      }
    }
    if (mode && mode !== 'cold_outreach') {
      const notesParts = [companyRow.notes, companyRow.background, companyRow.opportunity].filter(Boolean);
      if (notesParts.length) context.companyNotes = notesParts.join(' | ');
      if (companyRow.event_id) {
        const events = await listEvents();
        const event = events.find((e) => e.id === companyRow.event_id);
        if (event) context.eventName = event.name;
      }
    }
  }
  return { context, tagsUsed, breakdown, skqModules, companyId: companyRow ? companyRow.id : null,
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
  { re: /Relevant SKQ capabilities/, key: 'product', label: 'Product Context (SKQ)' },
  { re: /\n(Now write|Now write the)/, key: 'rules', label: 'Email Rules & CTA' },
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

    // Reuse an existing draft for the same (contact, mode, instructions)
    // instead of calling Claude again -- unless the user explicitly asked to
    // regenerate (the "Redraft" button always sets this). Trashed drafts
    // don't count -- the user already discarded that one.
    if (resolvedContactId && !regenerate) {
      const existing = await checkEquivalentDraft(Number(resolvedContactId), resolvedMode, resolvedInstructions);
      if (existing) {
        // Reused a saved draft — no AI call. Record the tokens saved.
        const saved = await estimateAiSaved('email_draft', {});
        recordAiEvent({
          feature: 'email_draft', sub_feature: resolvedMode, outcome: 'db_reuse',
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

    // Assemble the draft context from saved intelligence (AI tags used by
    // default, confidence-tiered) + deterministic SKQ grounding. No AI here.
    const built = await buildDraftContext(contact, mode, extraInstructions, resolvedContactId, req.body.includeTagIds);
    const context = built.context;
    const tagsUsed = built.tagsUsed;

    // About to spend tokens — enforce the budget.
    const blocked = await checkAiBudget();
    if (blocked) return res.status(429).json(blocked);

    const _t0 = Date.now();
    const draft = await draftEmail(contact, sender, mode, context);
    const _ms = Date.now() - _t0;

    // Record the real AI draft call.
    const du = draft._usage || {};
    recordAiEvent({
      feature: 'email_draft', sub_feature: resolvedMode,
      outcome: regenerate ? 'user_regeneration' : 'new_ai_call',
      model: du.model, company_id: built.companyId,
      contact_id: resolvedContactId ? Number(resolvedContactId) : null,
      input_tokens: du.input_tokens || 0, output_tokens: du.output_tokens || 0,
      response_ms: _ms, status: 'success', user_id: reqUser(req),
      session_id: SERVER_SESSION_ID, request_id: crypto.randomUUID(),
    });

    let commRow = null;
    if (resolvedContactId) {
      await updateContactDraft(Number(resolvedContactId), draft);
      const versionResult = await insertEmailDraftVersion(Number(resolvedContactId), draft, resolvedMode, resolvedInstructions, {
        to_email: contact.email || '',
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
    const { contact, sender, contactId, mode, extraInstructions, includeTagIds } = req.body || {};
    if (!contact) return res.status(400).json({ error: 'No contact provided' });
    const resolvedContactId = contactId || contact.contact_id;
    const resolvedMode = mode || 'cold_outreach';
    const built = await buildDraftContext(contact, resolvedMode, extraInstructions || '', resolvedContactId, includeTagIds);
    let priorSummary = null;
    if (resolvedContactId) {
      try {
        const timeline = await listTimelineForContact(Number(resolvedContactId));
        priorSummary = `${(timeline || []).length} prior interaction(s) on record`;
      } catch { priorSummary = null; }
    }
    const prompt = buildPromptForMode(resolvedMode, contact, sender || {}, built.context);

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

app.get('/api/settings/sender', async (req, res) => {
  try {
    const raw = await getSetting('sender_profile');
    res.json({ ok: true, sender: raw ? JSON.parse(raw) : { name: '', title: '', company: '' } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sender profile' });
  }
});

app.post('/api/settings/sender', async (req, res) => {
  try {
    const { name = '', title = '', company = '' } = req.body || {};
    await setSetting('sender_profile', JSON.stringify({ name, title, company }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save sender profile' });
  }
});

// =========================================================================
// Email configuration (My Email Account + Org config [admin] + Preferences)
// =========================================================================

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

app.get('/api/usage', (req, res) => {
  res.json(getUsage());
});

app.post('/api/usage/reset', (req, res) => {
  resetUsage();
  res.json({ ok: true });
});

// Full AI Usage dashboard payload: KPIs + time series + breakdowns (feature /
// model / company / user) + budget status, for a date range.
//   ?period=today|yesterday|7d|30d|month|prev_month|year|all|custom [&from=&to=][&bucket=day|week|month]
app.get('/api/ai-usage', async (req, res) => {
  try {
    const period = req.query.period || 'all';
    const filter = buildPeriodFilter(period, req.query.from, req.query.to);
    const bucket = req.query.bucket || ((period === 'year' || period === 'all') ? 'month' : 'day');
    const [kpis, timeseries, byFeature, byModel, byCompany, byUser, budget, todayK, monthK] = await Promise.all([
      aiUsageKpis(filter),
      aiUsageTimeseries(filter, bucket),
      aiUsageFeatureBreakdown(filter),
      aiUsageByModel(filter),
      aiUsageByCompany(period === 'custom' ? 'all' : period, 15),
      aiUsageByUser(filter),
      getAiBudget(),
      aiUsageKpis(buildPeriodFilter('today')),
      aiUsageKpis(buildPeriodFilter('month')),
    ]);
    const warn = budget.warn_threshold_pct || 80;
    const pct = (used, cap) => (cap ? Math.round((used / cap) * 100) : 0);
    res.json({
      ok: true, period, bucket,
      session: getUsage().ai,
      kpis, timeseries,
      by_feature: byFeature, by_model: byModel, by_company: byCompany, by_user: byUser,
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
    res.status(500).json({ error: 'Failed to load AI usage', details: err.message });
  }
});

// Paginated request-level audit log (metadata only — no prompts/email content).
app.get('/api/ai-usage/events', async (req, res) => {
  try {
    const filter = buildPeriodFilter(req.query.period || 'all', req.query.from, req.query.to);
    const out = await aiUsageEvents(filter, {
      feature: req.query.feature || null,
      status: req.query.status || null,
      limit: parseInt(req.query.limit, 10) || 50,
      offset: parseInt(req.query.offset, 10) || 0,
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load usage events', details: err.message });
  }
});

// CSV export of the audit log (respects the same filters).
app.get('/api/ai-usage/export.csv', async (req, res) => {
  try {
    const filter = buildPeriodFilter(req.query.period || 'all', req.query.from, req.query.to);
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
  try { res.json({ ok: true, pricing: await listActivePricing() }); }
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
    // Load model pricing from the DB so cost is computed from ai_model_pricing.
    try { setPricingTable(await listActivePricing()); } catch (e) { console.error('pricing load failed:', e.message); }
    initOcrWorker();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Lead Finder (+ card scanner) running at http://0.0.0.0:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
