# Apollo Leadership Contact Search (+ Card Scanner + lightweight CRM)

This is the original **Apollo Leadership Contact Search** ("EmailDrafter")
app — same layout, same colors, same navigation, same original drafting
behavior — expanded into a lightweight CRM. A **Scan Business Card** button
and a **CRM** browser have been added to the dashboard; every contact and
company, regardless of source, lives in one reusable local database.

**All configuration is backend-only, via a local `.env` file.** There is no
API-key entry screen anywhere in the UI — keys are read once on the server
and never sent to, stored in, or displayed by the browser.

## What's preserved (unchanged)

- The **original outreach email drafting function is untouched** —
  `buildPrompt()` in `claude.js` is byte-for-byte the same code as before.
  Drafting with no mode specified (or `cold_outreach` explicitly) produces
  identical output to the original app, verified by direct comparison.
- Upload a company list (CSV or Excel), searchable/filterable/selectable
  company table, batch search with progress bar, manual search
- Full contact results table: confidence bar, relevance badges, email
  reveal, LinkedIn links, select-all + per-row selection
- Draft Email modal (Claude), auto-drafting for every result after a search
- Export: Excel / JSON / XML / CSV / CRM CSV
- Sender profile, usage bar (Apollo/Claude cost tracking), login gate

## What's new: lightweight CRM

**Every contact and company is now a permanent, reusable database record —
not a one-time search result** — regardless of whether it came from Apollo,
a business card scan, a CSV/Excel upload, manual entry, or an email draft.

- **CRM — Saved Contacts & Companies** card on the main page: search/look up
  anything you've ever saved, by name, company, email, or tag. Select
  contacts with checkboxes. Edit tags and follow-up status inline (saved
  immediately). See last-contacted date at a glance.
- **Draft Emails for Selected** — pick contacts in the CRM table, choose a
  purpose/context, add optional instructions, and draft for all of them in
  one action.
- **Choose email purpose/context** — every draft (from search results, the
  CRM, or a re-draft) can use one of:
  - **Standard cold outreach** (the original, unchanged, default)
  - Conference outreach (e.g. The Battery Show)
  - General follow-up
  - Sharing company innovations
  - Partnership introduction
  - Sales outreach
  - Post-meeting follow-up

  New modes automatically pull in **company notes/background/opportunity**
  and the **event name** (e.g. "The Battery Show 2026") from the CRM, plus
  whatever free-text instructions you add — without you having to look
  anything up or retype it.
- **Regenerate in the draft modal** — after the initial draft (which always
  opens using the original default behavior), a "Redraft with a different
  purpose/context" control lets you pick a mode and regenerate, without
  losing the first draft's context.
- **Relationship history** (`contact_activity` table) — every save, scan,
  Apollo match, draft, note, and status change is logged per contact.
- **Tags & follow-up status** — `not_contacted` / `contacted` / `replied` /
  `meeting_scheduled` / `closed`, editable inline in the CRM table.
- **Emails are only ever drafted, never sent** — there is no send
  capability anywhere in this app.

## Environment variables & configuration

**`config.js` is the single, only place environment variables are read.**
No other file touches `process.env` — every module that needs a key, a
credential, or the port imports it from `config.js` instead. If you add a
new API key or service later, it gets one line in `config.js`, not scattered
`process.env.X` calls across the codebase.

```
DATABASE_URL=       # PostgreSQL connection string (required) -- Neon free tier works
APOLLO_API_KEY=     # Apollo.io API key -- enables card enrichment + lead search
CLAUDE_API_KEY=     # Anthropic API key -- enables AI email drafting
APP_USERNAME=       # optional login gate username
APP_PASSWORD=       # optional login gate password
PORT=               # optional, defaults to 3000
```

- Copy `.env.example` to `.env` and fill in whatever you have. All of it is
  optional -- the app runs with none of it set, just with fewer features
  (Apollo/Claude calls are skipped or stubbed; the login gate is off).
- **There is no in-UI key entry.** No config screen, no "Save Keys" button,
  no key values ever rendered anywhere in the browser. The frontend never
  sees your keys — every Apollo and Claude call happens entirely on the
  backend (`apollo.js`, `claude.js`, `leads.js`), reading from `config.js`.
- `.env` is git-ignored (see `.gitignore`) — only `.env.example` (no real
  values) is meant to be committed.
- `APP_USERNAME`/`APP_PASSWORD` gate the *entire* app (including static
  files) behind HTTP Basic Auth, checked on every request. Leave both blank
  to leave the app open.

## Requirements

- Node.js **22+**. Check with `node -v`.
- A PostgreSQL database (`DATABASE_URL` env var). [Neon](https://neon.tech) free tier works great.
- Internet access on first run (Tesseract.js downloads its OCR language
  model once, then caches it).

## Setup

```bash
npm install
cp .env.example .env   # fill in whichever keys you have
npm start
```

Open `http://localhost:3000`. The app works immediately after `.env` is
populated — nothing else to configure.

## CRM contact persistence (Apollo results)

Every field Apollo can return is now captured and permanently saved, not
just name/title/company/email:

first name, last name, full name, job title, department, seniority,
company, company website, business email, phone (if available), LinkedIn
URL (if available), source (`apollo` / `business_card` / `manual`), date
added, last updated.

**The email address specifically is treated as the source-of-truth trigger**
for skipping Apollo: `findExistingContact()` checks email first, before
anything else. Once a contact's email has been retrieved from Apollo (or
anywhere else), scanning their card again or searching their company again
reuses that saved email/contact — it never triggers a fresh Apollo call for
data you already have locally. See "Apollo Token Optimization" above for the
full priority order (saved contact → Apollo cache → fresh Apollo call).

## Batch business card upload

The **Scan Business Card** modal has two modes: **Single Card** (unchanged —
camera capture, review, save) and **Batch Upload** (new):

- Select multiple files at once, or drag-and-drop several onto the upload
  zone
- Supports **JPEG, PNG, HEIC/HEIF** (iPhone/iPad photos — converted
  server-side with `heic-convert`, no native dependencies required), and
  **PDF** (a multi-page PDF — e.g. a stack of cards scanned by a scanner app
  or conference badge scanner — is automatically split into one image per
  page using `pdfjs-dist` + `@napi-rs/canvas`, both pure-JS/prebuilt-binary
  so nothing extra needs to be installed on the host)
- Every card is processed **automatically**: OCR → check saved contacts →
  Apollo only if needed → saved immediately (no manual review step, unlike
  single-card mode) — with a progress bar showing "Processing X / Y"
- **Duplicate detection runs on every card**, same logic as everywhere else
  in the app: match by email → LinkedIn → name+company. A match updates the
  existing record (merging in new fields) instead of creating a duplicate
- Results are listed after processing: which cards were new vs. updated,
  and which ones failed (with the reason) — nothing is silently dropped

This works identically on desktop, tablet, and mobile — there's no
capture-only restriction on the batch upload input, so tablets/phones show
their native multi-select gallery picker, and desktop supports drag-and-drop
of a folder's worth of files at once.

## Conference contact management

The Scan Business Card modal has a **conference context** section (event,
booth number, meeting date, assigned salesperson) that applies to every card
scanned or uploaded in that session — fill it in once before a batch upload
at a trade show booth, and every card gets tagged automatically.

Each contact additionally supports: meeting notes, interest level
(low/medium/high), products discussed, and tags — editable any time via the
**Details** button on a CRM row (which opens a small editor for all of
these), or inline for tags/follow-up status directly in the CRM table.

**Filter the CRM by:** event, industry (via the linked company), follow-up
status, and assigned salesperson/owner — any combination, via the filter row
above the CRM table. (Free-text search — name/company/email/tags — remains
available separately and can be combined with these filters.)

## Apollo Token Optimization (still the highest priority)

The database is a **permanent cache**, checked before Apollo is ever called:

1. You search for a company (manually, via the uploaded company table, or
   by drafting for a CRM contact).
2. The app checks local `companies` + `contacts` first.
3. **If that company already has contacts saved** — from a previous Apollo
   search, a business card scan, a CSV import, or manual entry — those are
   returned directly. **Zero Apollo calls.**
4. Apollo is only called when there's genuinely no local data, or you check
   **"Force refresh."**
5. Every contact Apollo returns is immediately saved — so the next search
   for that company always takes the free path.

## Duplicate prevention

Every save path (`POST /api/contacts`, `POST /api/leads/save`, CSV import,
the CRM) goes through the same dedup-safe logic:

- **Contacts** — matched by email, then LinkedIn URL, then full name +
  company (both required). A match updates the existing row instead of
  creating a duplicate.
- **Companies** — matched by name (case-insensitive), same update-not-duplicate behavior.

## Company list import (CSV / Excel)

Column names are matched flexibly — a few known synonyms per field are
tried, since real exports vary slightly from what any one hardcoded name
would expect (e.g. the booth column matches `展位号` **or** `屏位号`;
opportunity matches `切入机会` **or** `参与机会`). If a file still can't be
matched (no recognized English-name column), the error message lists the
exact column headers detected in the file, so it's immediately obvious
whether it's a header-naming mismatch or simply the wrong kind of file
(e.g. a contacts export uploaded into the company-list slot by mistake).

## One unified SQL database

Single PostgreSQL database (hosted on Neon, schema auto-created on first startup):

| Table | Purpose |
|---|---|
| `companies` | name, Chinese name, industry, booth, event, website, notes, priority, background, opportunity, mfg location, contact tip |
| `contacts` | name fields, title, department, seniority, email, phone, website, LinkedIn, company (+ FK), source, confidence, relevance, current draft, tags, follow-up status, last contacted, **event (+ FK), booth number, meeting date, meeting notes, interest level, products discussed, assigned salesperson**, timestamps |
| `contact_activity` | append-only relationship history: every scan, search match, draft, note, and status change |
| `business_cards` | original scanned image, raw OCR text, parsed field JSON |
| `apollo_cache` / `company_search_cache` | the caching mechanism gating whether an Apollo call happens |
| `apollo_results` | append-only history log of every Apollo call made |
| `email_drafts` | every generated draft, versioned |
| `events` | e.g. "The Battery Show 2026" |
| `settings` | sender profile |

## Project structure

```
card-scanner/
├── config.js          Centralized env var loading -- the ONLY file that reads process.env
├── server.js           Express server + all API routes + login gate
├── db.js               PostgreSQL schema + all data access + CRM helpers
├── companyImport.js     CSV/XLSX company-list parsing
├── cardBatch.js          Batch upload: HEIC conversion + multi-page PDF rasterization
├── parse.js             OCR text -> structured card fields
├── apollo.js            Apollo People Enrichment (Scan Business Card) + email reveal
├── leads.js             Apollo company/people search + scoring + relevance tagging
├── claude.js             Claude drafting: original function (untouched) + new modes
├── export.js             CSV / XML / XLSX generation
├── usage.js              Apollo/Claude call + cost tracking
├── package.json
├── .env.example          Documents required env vars, no real values
└── public/
    ├── index.html        CSV upload, search, CRM browser, results, modals (no config UI)
    └── app.js             All client-side logic
```

## API

| Method | Route | Description |
|---|---|---|
| POST | `/api/scan` | OCR a business card; checks saved contacts, then Apollo cache, then Apollo |
| POST | `/api/scan-batch-file` | Batch upload (one file per call, looped by the frontend) — image/HEIC/multi-page PDF, auto-saves every card found |
| POST | `/api/contacts` | Save/update a contact (dedup-safe); logs activity |
| GET | `/api/contacts?q=` | Free-text CRM search |
| GET | `/api/contacts?event=&company=&industry=&follow_up_status=&tags=&assigned_salesperson=&sortBy=` | Structured CRM filtering |
| PATCH | `/api/contacts/:id` | Update tags / follow-up status / notes / event / booth / meeting date / interest level / products discussed / salesperson |
| GET/POST | `/api/contacts/:id/activity` | Relationship history for a contact |
| GET/POST | `/api/contacts/:id/drafts` | Versioned draft history |
| DELETE | `/api/contacts/:id` | Delete a contact |
| POST | `/api/companies/upload` | Upload a CSV/XLSX company list |
| GET | `/api/companies?q=` | Searchable company list |
| GET | `/api/companies/:id/contacts` | Contacts belonging to one company |
| GET | `/api/events` | List of events |
| POST | `/api/leads/search` | `{ companies, force }` — local-DB-first, Apollo as last resort |
| POST | `/api/leads/save` | Idempotent save (dedup-safe) |
| POST | `/api/reveal-email` | Reveal an Apollo-flagged-available email |
| GET | `/api/draft-modes` | Available drafting purposes/contexts |
| POST | `/api/draft-email` | `{ contact, sender, contactId?, companyKey?, mode?, extraInstructions? }` |
| GET/POST | `/api/settings/sender` | Sender profile |
| GET/POST | `/api/usage`, `/api/usage/reset` | Usage + cost tracking |
| GET | `/api/export`, `/api/export-csv`, POST `/api/export-xlsx` | Exports |

Note: there is no `/api/config-status` or `/api/save-config` route — those
existed in an earlier version of this app but have been removed entirely,
since keys are never configured or checked from the browser.

## Notes on scoring accuracy

The relevance-tagging logic uses simple substring matching (ported
faithfully from the original), which has a known quirk: "director" contains
the substring "cto," so some Director-level titles get tagged as C-suite.
Inherited as-is; see `leads.js` (`isCsuite`) if you want a word-boundary fix.

## A note on authentication/ownership

The optional login gate (`APP_USERNAME`/`APP_PASSWORD`) is one shared
password for the whole app, not per-user accounts — there's no per-user data
partitioning in this app or the original it's based on.
