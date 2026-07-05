const config = require('./config');

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const {
  initDb,
  insertContact, listContacts, getContact, listContactsByCompany, deleteContact,
  updateContactDraft, findExistingContact, upsertContact, updateContact,
  upsertCompany, findCompanyByName, getCompany, listCompanies, getCompanyContacts,
  insertBusinessCard, listBusinessCardsForContact,
  getApolloCache, setApolloCache,
  getCompanySearchCache, setCompanySearchCache, updateCachedLeadDraft,
  logApolloResult, listApolloResults,
  insertEmailDraftVersion, listEmailDraftsForContact,
  searchContacts, filterContacts, patchContactCrmFields, logContactActivity, listContactActivity,
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
const { draftEmail, listDraftModes } = require('./claude');
const { contactsToCsv, contactsToXml, contactsToXlsx, safeFilename } = require('./export');
const { parseCompanyFile } = require('./companyImport');
const { normalizeFileToImages } = require('./cardBatch');
const { getUsage, resetUsage } = require('./usage');

const app = express();
const PORT = config.PORT;
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

app.use((req, res, next) => {
  const expectedUser = config.APP_USERNAME;
  const expectedPass = config.APP_PASSWORD;
  if (!expectedUser || !expectedPass) return next();

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
    const { q, event, company, industry, follow_up_status, tags, assigned_salesperson, sortBy } = req.query;
    const hasStructuredFilter = event || company || industry || follow_up_status || tags || assigned_salesperson;

    let contacts;
    if (hasStructuredFilter) {
      contacts = await filterContacts({ event, company, industry, follow_up_status, tags, assigned_salesperson, sortBy });
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

    let allContacts = [];
    let allOrgs = [];
    const messages = [];

    for (const companyName of companyNames) {
      const companyRow = await findCompanyByName(companyName);

      if (!forceRefresh && companyRow) {
        const existingContacts = await getCompanyContacts(companyRow.id);
        if (existingContacts.length > 0) {
          allContacts = allContacts.concat(existingContacts.map(contactRowToLeadFormat));
          messages.push(`CACHE:${companyName}:${existingContacts.length}:${companyRow.updated_at}`);
          continue;
        }
      }

      if (!apolloConfigured()) {
        messages.push(`${companyName}: no local data found, and Apollo API key not configured.`);
        continue;
      }

      const result = await doCompanySearch(companyName, apiKey);
      if (result.error) {
        messages.push(`${companyName}: ${result.error}`);
        continue;
      }

      const contacts = result.contacts || [];
      const orgs = result.orgs || [];

      const companyResult = await upsertCompany({ name: companyName });
      const companyId = companyResult ? companyResult.id : null;

      for (const c of contacts) {
        const cleanEmail = c.email && !String(c.email).startsWith('(') && !String(c.email).includes('N/A') ? c.email : '';
        const rawJson = c._apollo_raw ? JSON.stringify(c._apollo_raw) : undefined;
        console.log(`[leads/search] ${c.name} @ ${c.company}: apollo_email_fields={email:${JSON.stringify(c._apollo_raw && c._apollo_raw.email)}, personal_emails:${JSON.stringify(c._apollo_raw && c._apollo_raw.personal_emails)}, business_emails:${JSON.stringify(c._apollo_raw && c._apollo_raw.business_emails)}, has_email:${c._apollo_raw && c._apollo_raw.has_email}} cleanEmail=${JSON.stringify(cleanEmail)}`);
        const { id, updated } = await upsertContact({
          full_name: c.name, job_title: c.title, department: c.department, seniority: c.seniority,
          company: c.company, website: c.company_website,
          email: cleanEmail, linkedin_url: c.linkedin, address: c.location,
          confidence: c.confidence, relevance: c.relevance,
          apollo_person_id: c.apollo_id, source: 'apollo',
          has_email: Boolean(c.has_email) || Boolean(cleanEmail),
          apollo_raw_json: rawJson,
          email_lookup_status: cleanEmail ? 'found' : 'not_checked'
        });
        c.contact_id = id;
        c.email_lookup_status = cleanEmail ? 'found' : 'not_checked';
        console.log(`[leads/search] -> contact_id=${id} updated=${updated} email_saved=${JSON.stringify(cleanEmail)}`);
        await logContactActivity(id, 'apollo_search', updated ? `Refreshed via Apollo search for ${companyName}` : `Found via Apollo search for ${companyName}`);
      }

      await logApolloResult('people_search', companyId, null, companyName, JSON.stringify({ contacts, orgs }));
      await setCompanySearchCache(companyCacheKey(companyName), JSON.stringify({ company: companyName, contacts, orgs }));

      allContacts = allContacts.concat(contacts);
      allOrgs = allOrgs.concat(orgs);
      if (result.fallback_message) messages.push(result.fallback_message);
    }

    res.json({ ok: true, contacts: allContacts, orgs: allOrgs, messages, companies: companyNames });
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
// Email drafting (Claude)
// =========================================================================

app.get('/api/draft-modes', (req, res) => {
  res.json({ ok: true, modes: listDraftModes() });
});

app.post('/api/draft-email', async (req, res) => {
  try {
    const { contact, sender, contactId, companyKey, mode, extraInstructions } = req.body;
    if (!contact) return res.status(400).json({ error: 'No contact provided' });

    let context = {};
    if (mode && mode !== 'cold_outreach') {
      const companyRow = await findCompanyByName(contact.company || '');
      if (companyRow) {
        const notesParts = [companyRow.notes, companyRow.background, companyRow.opportunity].filter(Boolean);
        context.companyNotes = notesParts.join(' | ');
        if (companyRow.event_id) {
          const events = await listEvents();
          const event = events.find((e) => e.id === companyRow.event_id);
          if (event) context.eventName = event.name;
        }
      }
      if (extraInstructions) context.extraInstructions = extraInstructions;
    }

    const draft = await draftEmail(contact, sender, mode, context);
    const resolvedContactId = contactId || contact.contact_id;

    if (resolvedContactId) {
      await updateContactDraft(Number(resolvedContactId), draft);
      await insertEmailDraftVersion(Number(resolvedContactId), draft);
      await logContactActivity(Number(resolvedContactId), 'draft_generated', `Mode: ${mode || 'cold_outreach'}`);
    } else if (companyKey) {
      await updateCachedLeadDraft(companyCacheKey(companyKey), contact.apollo_id, contact.name, draft);
    }

    res.json(draft);
  } catch (err) {
    console.error('Draft email error:', err);
    res.status(500).json({ error: 'Failed to draft email', details: err.message });
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
// Usage tracking
// =========================================================================

app.get('/api/usage', (req, res) => {
  res.json(getUsage());
});

app.post('/api/usage/reset', (req, res) => {
  resetUsage();
  res.json({ ok: true });
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
  .then(() => {
    initOcrWorker();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Lead Finder (+ card scanner) running at http://0.0.0.0:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
