# SKQ CRM — Project Status

> Last updated: 2026-09-03
> Updated by: Claude
> Scope of this document: **Current Account Research (Qwen-based)** inside the CRM.
> Branch: `account-research-qwen`
> Current phase: **PRODUCTION BASELINE** — UI parity pass committed (`1feeed9`) and
> verified against live Neon

`HANDOFF.md` remains the week-of-2026-08-23 handoff for the wider CRM (Booth Map
re-key, chat, exhibitor sync). It is untracked and was not touched.

---

## 0. MODEL STATUS — re-probed after activation, 2026-09-03

| Model | State |
|---|---|
| `qwen3.6-flash` | **available** |
| `deepseek-v4-pro` | **available** |
| `deepseek-v4-flash-0731` | **available** |

Confirmed by a forced probe (`?probe=1`) through the CRM proxy **and** directly
against the engine, after paid activation. A real single-company run then
succeeded end to end — see §2b.

> ### ⚠ Generate and Refresh are LIVE actions
>
> They call the model for real and **may consume paid tokens**. Refresh also
> **replaces** the saved report for that company — the store keeps one current
> report per company, and the upsert bumps `version` and rewrites
> `researched_at`. There is no history to roll back to.
>
> **Do not run Generate or Refresh merely to test.** Run them only when the user
> explicitly asks. A deliberate single-company paid end-to-end run is planned and
> will be requested when wanted.

Model access is **no longer blocked**. Any earlier note in this repository or in
the engine's own `STATUS.md` describing a 403 `AccessDenied`, "no model
entitlement", or "activation/payment required" as the *current* state is stale and
superseded by this section. The bilingual *Model unavailable — activation/payment
required.* string still exists in the UI as the **guard** shown if access is ever
withdrawn again; its presence in the code is not a statement about today.

---

## 1. Where are we?

The Current Account Research workspace is a **native CRM surface**, not an iframe.
Its research engine is a separate service reached through `/api/aresearch/*`;
reads come from Neon so the library, language switching and PDF export keep
working when the engine is down.

The Previous Account Research (Claude-based) page is unchanged and remains an
iframe to `/account-research/`. It is the **visual reference** for the Current
workspace and must not be redesigned.

| Item | Value |
|---|---|
| Workspace markup + styles | `public/index.html` (`#ar-pane-current`, `.qr-*` rules) |
| Workspace behaviour | `public/qwen-research.js` |
| Shell view switching | `public/app.js` → `showAccountResearchTab()` |
| CRM proxy + Neon persistence | `server.js`, `qwenResearch.js`, `db.js` |
| Visual reference (do not redesign) | `public/account-research/index.html` |
| Engine (separate repo) | `Qwen API Search 测试用例`, Flask, `app.py` |

---

## 2. What changed most recently — UI parity pass (2026-09-03)

Presentation only. **No change to research logic, prompts, model routing, Neon
persistence, Apollo, Yahoo Finance, or any API contract.** Two files touched:
`public/index.html` and `public/qwen-research.js`.

### One report-language control

`#qr-lang` is the only language selector in the workspace. Its label is now
**Report Language / 报告语言** with a muted helper line, *Controls report display
and PDF export / 控制报告显示及 PDF 导出语言*, and the three parts are grouped in
`.qr-langpick` so they read as one setting. Storage key `qrDisplayLanguage` and
the click handling are unchanged.

**Do not add a second language control** anywhere in this pane.

### Tabs

Both levels now fill with brand purple when selected, so which page is open is
never ambiguous:

- `.ar-tab.active` — Current / Previous.
- `.qr-subtab.active` — Single Company / Batch Research / Reports. This replaced
  a bottom-border underline that was too quiet next to the strip above it.

Inactive tabs stay muted with a `--color-primary-soft` hover. Only tab styling
changed; neither pane's content was touched.

### Matched to the Previous (Claude) page

Values copied from `public/account-research/index.html`, expressed in the CRM's
own token names:

| Element | Value | Source there |
|---|---|---|
| Card radius | `var(--radius-lg)` = 12px | `--radius:12px` |
| Card shadow | `var(--shadow-xs)` | `--shadow-xs` |
| Input height / padding / size | 38px, `0 12px`, 14px, 6px radius, `#d1d5db` | `.field-group input` |
| Focus ring | `0 0 0 3px rgba(78,42,132,.1)` | `.field-group input:focus` |
| Status card | 12px radius, 34px icon at 9px radius, .7rem label, .92rem value | `.ar-stat` |
| Optional marker | muted 999px pill | `.opt-tag` |
| Primary button | 6px radius, `0 22px`, 14px, 600 | `.btn-gen` |

The card radius override is **scoped to `#ar-pane-current`**. The CRM's shared
`.card` is unchanged everywhere else, so no other view moved.

### Single Company

- Three status cards above the form: **Model / Connection**, **Saved Reports**,
  **Last Generated**, same shape as the reference page's `.ar-stat` strip.
  Every value comes from `/models/health` and `/reports`, which this pane already
  calls. **No new endpoint and no model is consulted.**
- The form is `1fr 1fr`: Company Name beside Company Website, then Model beside
  Generate. Alignment comes from a fixed **18px label row** (`.qr-lab`) above a
  fixed `--qr-ctl-h:38px` control. The action cell has no label, so it carries an
  empty `.qr-labspacer` of the same height — that spacer is what puts the button
  on the inputs' baseline.
- `optional / 可选` is an inline pill, so the Website label stays one line.

### Batch Research

Three labelled areas: **Setup** (Company List | Model, then Company Column |
Website Column), **Generation** (Generate Selected / All / Retry Failed / Stop),
and **Selection & Management** (Select All / Clear Selection, a live count, then
Delete Selected Reports pushed right).

### Reports

Gained the management the tab was missing: a checkbox per report, Select All and
Clear Selection over the **filtered** rows, a live count, Compile Selected,
Delete Selected, and per-row `View | PDF | ⋯` where the overflow holds Download
PDF, Refresh and Delete.

**Behaviour preserved from the standalone approval:** Compile Selected reads
`librarySelection`, the report library's own set — **never the batch table's
selection**, which the Reports tab does not display. The server already accepts a
`companies` filter on `/api/aresearch/export/portfolio` (`qwenResearch.recordsFor`),
so this needed **no backend change**.

Selection is applied in place by `syncLibrarySelectionUI()`. Do not replace it
with a `renderLibrary()` call: rebuilding the list on every tick throws away the
DOM the user is clicking.

`.qr-liblist` lost its `max-height` / `overflow` — a scroll container clips the
per-row ⋯ menu.

---

## 2a. Model-health states and the Model field (2026-09-03)

Presentation and state handling only. **Model routing is unchanged** — the engine
still chooses and runs models exactly as before.

### The bug: two states where there are three

`checkModels()` did `modelsAvailable = Boolean(d.modelsAvailable)`. When the
engine is unreachable or `CURRENT_ACCOUNT_RESEARCH_URL` is unset, the proxy
answers **503 with `{error}`** and no `models` array. That parses fine, so nothing
threw: `Boolean(undefined)` became `false`, the picker emptied, and the yellow
**"Model unavailable — activation/payment required"** banner appeared. A
connection failure was being reported to the user as a billing problem.

The state is now explicit, and only one of the three is a payment condition:

| State | Meaning | Banner |
|---|---|---|
| `available` | the response lists ≥1 usable model | **hidden**, `hidden` attribute, zero height |
| `denied` | the response lists models and **every** one is `access_denied` | yellow activation/payment banner |
| `unknown` | non-OK status, transport error, or a payload with no `models` array | **neutral grey** "Cannot reach the research service — model status unknown / 无法连接研究服务", plus the reason. Never mentions payment |

`blockIfNoModel()` distinguishes the same three, so a blocked run says which
problem it hit. The status card follows: model label (green) / *Activation
required* (red) / *Service unreachable* (neutral).

The banner sits above all three sub-views, so Single Company, Batch Research and
Reports show the same state.

### Health is re-read when the workspace is opened

`qwenResearchInit()` short-circuited on re-entry and only reloaded the library, so
the banner and picker were frozen at whatever the first page load saw — access
being granted, or the engine returning, left a stale warning until a full browser
refresh. It now calls `checkModels()` too. One small GET; **no model is called.**

### The Model field hides when there is nothing to choose

Shown only when **more than one** selectable (non-`access_denied`) model exists.
Otherwise the whole field — label and control — is removed with
`.qr-form label[hidden]{display:none}`, needed because `.qr-form label` sets
`display:flex`, which outranks the plain `[hidden]` attribute. No empty control,
no reserved gap. It reappears on its own as soon as health offers two or more.

Both pickers stay **populated and valued** even while hidden, because the engine
rejects an empty model with `400 Unknown model:` — the request still carries a
valid id. That is selection, not routing.

Reflow, via `.qr-nomodel` on the form:

- **Single Company** — Company Name and Company Website keep row 1; Generate
  Research moves to its own full-width row, right-aligned, and its label spacer is
  dropped so no phantom gap remains.
- **Batch Setup** — Company List spans row 1; Company Column and Website Column
  share row 2.

### Verified 2026-09-03 — health endpoint only, no research run

Five health responses were injected and the UI measured after each. **No
Generate, Refresh, Retry Failed or Generate All was run**; the test asserted that
no request to `/research`, `/batch/start` or `/job/` was made at any point, and
that assertion passed.

| Health response | Banner | Model field |
|---|---|---|
| 3 usable | hidden, 0px | shown |
| 1 usable + 1 denied | hidden, 0px | hidden, 0px |
| all denied | activation/payment, warning style | hidden, 0px |
| 503 `{error}` | connection, neutral style, no payment wording | hidden, 0px |
| 200 with no `models` | connection, neutral style, no payment wording | hidden, 0px |

Also verified: the activation banner appears identically on Single Company, Batch
Research and Reports; going from denied back to available clears it **without a
page reload**; against the real engine the banner is hidden, the Model field is
shown, and `qwen3.6-flash` is selected; the reflow assertions hold in every state.

---

## 2b. Live paid end-to-end run — 2026-09-03

One approved single-company run through the production path: CRM → Current
Account Research → Single Company → Generate Research. Exactly one research
request was issued, asserted by counting calls to `/api/aresearch/research`.

| | |
|---|---|
| Test company | **Manz AG** (`https://www.manz.com`) — not one of the 29 |
| Model used | **`qwen3.6-flash`**, the default fast model. No fallback, no second model |
| Model health | all three `available` on a forced probe |
| Status | **done**, completed on the first attempt |
| Sources | **5** |
| Tokens | **4,953 in · 11,293 out · 16,246 total** |
| Latency | **92.9 s** (engine-reported) |
| Search queries issued | 23 |
| Decision makers | **5**, from web research |
| Apollo | **not configured** — `apollo_usage.status = "not_configured"`, 0 calls |
| Neon persistence | ✅ `manz-ag__qwen3-6-flash__20260903191553`, version 1 |
| Report body | 19 sections, ~21,900 chars bilingual |
| Quality level | `acceptable`; identity verified; 5 official-site sources |

**Pipeline confirmed end to end:** CRM request → engine → live web search →
model generation → result returned → persisted to Neon on poll → Reports library
→ language switching → PDF.

| Check | Result |
|---|---|
| Appears in Reports | ✅ library 29 → 30 |
| Metadata shown | ✅ sources, input/output/total tokens, latency, researched-at |
| Company-specific content | ✅ correctly reports the **February 2025 insolvency proceedings**, the divestment of the Asia, US and Slovak subsidiaries, and names the actual board |
| English / 中文 / Bilingual | ✅ 14,235 / 5,519 / 20,016 chars; CJK 52 / 3,090 / 3,289 |
| Language switch cost | ✅ **no** research or job call — rendered from the stored record |
| Inline PDF viewer | ✅ opens on the render route |
| PDF export | ✅ 47,634 bytes, 13 pages, cites `manz.com` |
| Reload persistence | ✅ reopens from Neon after a full page reload, **no** model call |
| Page errors | ✅ none |

### One content finding — since fixed in the engine

The report contained **one** *Not enough evidence / 证据不足* entry, in Competitor
Analysis. The cause is retrieval breadth, not synthesis — **all 5 sources are
`manz.com` pages**, so no third-party competitor data was available, and the model
declining to invent it is the evidence-first design working.

Per instruction, unsupported claims should now be **omitted rather than
announced**. `confidence.py` in the engine repository was corrected on 2026-09-03:
malformed badges are swept, absence prose is recognised by meaning rather than
length, and an absence clause is removed at sentence level so it cannot take a
sourced finding with it. Across all 30 stored reports, tagged occurrences went
**2,288 → 0** with no section lost. The stored record is untouched; only the
reading view changes. See the engine's `STATUS.md` §0b.

If a run should carry more third-party sourcing, that is a retrieval-tuning
question in `research_service.py`, deliberately **not** changed here.

### Cleanup

The test report was deleted through the Reports ⋯ menu. Library 30 → 29. The 29
rows were compared row for row against the pre-test snapshot: **identical**,
0 added, 0 removed, no Manz rows left. No existing report was modified.

### Note on the harness, not the app

The first attempt's browser driver was killed by a 2-minute tool timeout while
the engine was mid-synthesis. Rather than click Generate again and pay twice, the
in-flight job was polled through `/api/aresearch/job/:id`, which is also what
triggers persistence. The run completed and persisted normally. **No tokens were
spent twice.**

---

## 3. Recent test results — live Neon, 2026-09-03

**Live Neon verification — summary**

| | |
|---|---|
| Current reports | **29** |
| Compile Selected | **verified** — 2 selected, PDF contained exactly those 2 |
| Chinese compile | **verified** — same 2, English half dropped |
| Delete | **verified** using a disposable fixture, library back to 29 |
| Previous Claude pane | **unchanged** — still one untouched iframe |
| Console errors | **none** |

Run against the real CRM server on a local port with the production
`DATABASE_URL` from `.env` (Neon, `ep-wild-bar-atl4yxm9-pooler`, `neondb`) and the
research engine on `127.0.0.1:5062`. Driven through the browser as a user: sidebar
→ Account Research → Reports.

### Report library — 29 live reports

| Check | Result |
|---|---|
| Current is the default pane; Previous hidden | ✓ |
| Current tab filled `#4E2A84` | ✓ |
| All 29 Neon reports load | ✓ 29, label "29 / 29 REPORTS · 共 29 份" |
| Select exactly two | ✓ Eneroc New Energy Technology Co., Ltd. + Torus |
| Selection count reads 2 | ✓ "2 selected / 已选 2 份" |

### Compile Selected — contents and language

Both PDFs were downloaded through the button and their text extracted.

| Build | Pages | Contains the 2 picked | Any other company | CJK chars | English words |
|---|---|---|---|---|---|
| Bilingual | 26 | ✓ both | ✓ none | 7,732 | 3,761 |
| 中文 | 14 | ✓ both | ✓ none | 7,233 | 481 |

The Chinese build drops the English half — English words fall from 3,761 to 481
and the page count halves — so the global Report Language is respected. The
selection survived the language change.

### Per-row ⋯ menu

| Action | Result |
|---|---|
| Menu contents | ✓ Download PDF / Refresh / Delete Report |
| **Download** | ✓ returned a real PDF (55 KB, `%PDF` header) |
| **Refresh** — guard only, state forced | ✓ with the unavailable state simulated, it shows *Model unavailable — activation/payment required.* and *模型暂不可用 — 需要开通/付费。*, sends **no** research request, and the banner repeats it. **The live models are available (§0); this was the guard being exercised, not the current state.** |
| **Delete** | ✓ 30 → 29, row gone, count label back to "29 / 29" |

### Previous Account Research

| Check | Result |
|---|---|
| Still exactly one child, `#ar-frame` | ✓ |
| `src` is `/account-research/` | ✓ |
| The Claude page renders inside it (`.ar-status-row` present) | ✓ |

### Console

No console or page errors in any of the three live runs.

### How the destructive checks were kept safe

- **Delete** was run on a **disposable fixture**, not a real report. A row named
  `ZZ UI Delete Test (disposable)` was inserted directly (29 → 30), deleted through
  the ⋯ menu (30 → 29), and the library ends at **29**.
  Deletion is a hard `DELETE` with no history, so deleting a real report and
  re-inserting it would bump `version` and rewrite `researched_at`. That is a
  change to a production record, which a verification run should not make.
  A first attempt failed because the fixture's `company_key` was written naively;
  `deleteQwenReportsByCompany` matches on `normalizeNameKey`, which strips
  parentheses. **That was a bad fixture, not a UI defect** — with the correct key
  the delete worked first time.
- **Refresh** was verified with the model-unavailable state forced at the health
  endpoint. Per §0 the live models are **available**, so a real click would have
  spent tokens and replaced a production report. It was not clicked for real.
- **Post-run integrity:** the 29 rows were compared row for row against a snapshot
  taken before any test — id, company key, name, version and `researched_at` all
  **identical**, 0 added, 0 removed, no fixture rows left behind.

## 4. Known issues / uncertain

1. **Retrieval breadth on a thin-source company.** The Manz AG run returned 5
   sources, all from the company's own domain, which left Competitor Analysis
   without evidence (§2b). Worth watching; not addressed in this pass.
2. **Apollo is configured and live locally, pending on Render.**
   `APOLLO_API_KEY` now sits in the engine's `ai_credentials.env` and a live
   `/organizations/enrich` call authenticated successfully on 2026-09-03,
   resolving `skeqi.com` to *SKEQI Intelligent Equipment*. The Manz AG run
   predated it: the file was written at 19:18, three minutes after that run
   finished. **Still to do: add `APOLLO_API_KEY` to the Render ENGINE service** —
   `ai_credentials.env` is not deployed, and setting it on the CRM does nothing
   because Apollo is called from the engine. Enrichment is capped at 12 contacts
   (`APOLLO_ENRICH_LIMIT` overrides). See the engine's `STATUS.md` §0a.
3. **Refresh has not been run on an existing report**, deliberately — it would
   replace a production record. Generate is now proven (§2b).
4. **Batch Research generation was not re-run** against live Neon. Its layout was
   verified; its generation path is untouched by the UI pass.
5. **The live Render configuration is unconfirmed from here.** See §4a.
6. Deletion is a hard `DELETE` with no history. There is nothing to restore from
   if a real report is removed.

### 4a. Environment — local vs Render

These are two separate places and they do **not** share values.

**Local `.env`** (this machine, git-ignored). Verified by reading the key names
only:

| Variable | Local `.env` |
|---|---|
| `DATABASE_URL` | ✅ present — real Neon (`ep-wild-bar-atl4yxm9-pooler`, `neondb`) |
| `CURRENT_ACCOUNT_RESEARCH_URL` | ❌ **absent** |
| `ACCOUNT_RESEARCH_SERVICE_KEY` | ❌ **absent** |

The engine URL therefore has to be supplied on the command line to run the
workspace locally; that is how the live verification above was performed. This
says **nothing** about Render.

**Render** (`render.yaml`, service `skeqi-emaildrafter`). Both variables **are
declared** in the blueprint, each with `sync: false`:

```
- key: CURRENT_ACCOUNT_RESEARCH_URL
  sync: false
- key: ACCOUNT_RESEARCH_SERVICE_KEY   # must match APP_SERVICE_KEY on that service
  sync: false
```

`sync: false` means Render expects the value to be entered in the **dashboard**
and never committed. **The blueprint declaring a variable is not evidence that it
holds a value.**

**Not confirmed, and not confirmable from this machine.** Dashboard state is not
in the repository, and a probe of `https://skeqi-emaildrafter.onrender.com/healthz`
returned `404` with `x-render-routing: no-server`, meaning no Render service is
bound to that hostname. Either the CRM is deployed under a different name or it is
not deployed. `DEPLOY.md` uses placeholders (`<crm-service>`, `<this-service>`), so
the real hostnames are not recorded anywhere in either repository.

**To confirm, in the Render dashboard:**

1. Open the CRM service → **Environment**. Check that both keys exist and are
   non-empty. Do not paste the key anywhere.
2. `CURRENT_ACCOUNT_RESEARCH_URL` must be the **engine** service's public URL,
   `https://…onrender.com`, no trailing slash.
3. `ACCOUNT_RESEARCH_SERVICE_KEY` must equal `APP_SERVICE_KEY` on the **engine**
   service. If they differ the proxy returns 401 and every research, render and
   export call fails.
4. Quick live check once signed in: open Account Research → Reports. If the
   library lists reports but Compile Selected fails, the URL or the key is wrong.

**If both are already set correctly in the dashboard, no code change is needed.**
Nothing in this repository has to change for that case.

Also record the engine hostnames in `DEPLOY.md` once known, so the next session
does not have to guess.

## 5. Do not accidentally change

- Do not redesign the Previous (Claude) page. It is the reference.
- Do not add a second report-language control to this pane.
- Do not let Compile Selected read the batch table again.
- Do not re-render the whole library on a checkbox tick.
- Do not give `.qr-liblist` a scroll container — it clips the ⋯ menu.
- Do not widen the `#ar-pane-current` card-radius override to the shared `.card`.
- Do not translate status VALUES; they drive `.qr-b-*` classes.
- Do not touch research logic, prompts, model routing, Neon persistence, Apollo
  or Yahoo Finance from a UI pass.
- **Do not run Generate or Refresh to test.** They are live and cost tokens (§0),
  and Refresh replaces the saved report. Run them only when explicitly asked.
- Do not describe model access as blocked. It is available; see §0.
- Do not collapse the three model-health states back into a boolean. An
  unreachable engine is not a billing problem; see §2a.
- Do not remove `.qr-form label[hidden]{display:none}` — without it a hidden
  field still occupies its row.

---

## 6. NEXT ACTIONS

1. **Confirm the Render environment** for the CRM service: both
   `CURRENT_ACCOUNT_RESEARCH_URL` and `ACCOUNT_RESEARCH_SERVICE_KEY` present and
   non-empty, the key matching `APP_SERVICE_KEY` on the engine (§4a). No code
   change is needed if they are already set.
2. Record the real Render hostnames in `DEPLOY.md`, replacing the placeholders.
3. Open a PR for `account-research-qwen` and merge to `main`.
4. **When you choose:** one deliberate paid end-to-end run on a single company —
   Generate → Neon upsert → report → PDF. Not before; it costs tokens (§0).
5. Optionally add `CURRENT_ACCOUNT_RESEARCH_URL` to the local `.env` so the
   workspace runs locally without a command-line override.

---

## 7. Session handoff

**Current state:** this is the **production baseline**. Commit `1feeed9` on
`account-research-qwen`, pushed to `origin`. Working tree clean apart from
pre-existing untracked files (`HANDOFF.md`, `researchConfidence.js`,
`researchSections.js`, `skqCapabilities.js`), none of which were touched.

**Last successful operation:** live Neon verification, §3 — 29 reports, Compile
Selected in two languages with contents checked, Download, the Refresh guard, and
Delete on a disposable fixture. The 29 rows were compared row for row against a
pre-test snapshot and are identical.

**Open item:** the Render dashboard values in §4a. Everything else is done.

**Do not:** run Generate or Refresh to test. They are live (§0).

**Running locally:** `PORT=<port> CURRENT_ACCOUNT_RESEARCH_URL=http://127.0.0.1:5062 node server.js`
with the engine started from its own repository. `DATABASE_URL` in `.env` already
points at live Neon, so local runs read and write **production data** — take care
with delete and regenerate.
