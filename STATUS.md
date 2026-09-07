# SKQ CRM — Project Status

> Last updated: 2026-09-06
> Updated by: Claude
> Scope of this document: **Current Account Research (Qwen-based)** inside the CRM.
> Branch: `account-research-qwen`
> Current phase: **PRODUCTION** — durable queue (P0-A) live; company-key identity
> repaired across all historical rows; report-open fix committed at `52673be` and
> pushed, **deploy not yet confirmed**

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

## 2c. Live research progress panel — Single Company (2026-09-03)

Replaces the static *Researching… 研究中…* line with a panel under Generate.
**It issues no request of its own.** The polling loop already fetched a full job
snapshot every 1.5 s and used only `snap.status`; the same snapshot now also
draws the panel. Same interval, same call count, no model call.

### What is real, and what was deliberately not built

The engine reports retrieval as **aggregate** stages (`discover`, `official`,
`listing`, `queries`, `site`, `search`, `dedupe`, `evidence`, `financial`,
`apollo`, `quality`) and returns the synthesis **in one block**. So:

- **No per-topic search steps.** There is no "Searching leadership" signal to
  read; inventing nine topic rows would be a bar reporting on itself.
- **No per-section streaming.** Sections do not arrive one at a time.
- **No timer-based percentage.** It is `settled steps / 12`.

Twelve steps, each mapped to a stage key, a `phase`, or a model-status change:
validate · official website · plan search areas · read official site · search ·
financial · contacts · dedupe · evidence set · generate · PDF · save.

### Behaviour

- **Percentage** from completed steps. During synthesis, which reports no inner
  progress, the bar goes **indeterminate** (animated) rather than claiming a
  number. It respects `prefers-reduced-motion`.
- **Current stage** is always named. The engine reports a stage as it *finishes*,
  so between reports nothing is explicitly active; the panel shows the first
  unsettled step instead of falling back to "Starting…".
- **Counters** are snapshot values only: sources found, search queries, model
  label, elapsed. **Tokens appear only once `token_usage.total` is present**, so
  never during the run.
- **Completion** turns the panel into `✓ Research completed` with
  `N sources · T tokens · S sec`, and the report renders below it.
- **Soft failure** marks that one step `✕` with the engine's own message and the
  run continues. A stage the engine reports as skipped (`Apollo: not configured`,
  `Yahoo Finance used: No - unlisted`) shows `○` with its reason — **a skip is
  not dressed as an error**.
- **Hard failure** names the phase (*Research failed during synthesis*) and
  **keeps every completed step on screen** for troubleshooting.
- The panel is cleared when opening a different report from the library, and kept
  when it follows the run that produced the report.

### Verified 2026-09-03 — replayed, no model call

Driven by replaying the **real captured Manz AG job snapshots** through the live
frontend, plus two synthetic failure sequences. No research request was issued.

| Check | Result |
|---|---|
| Hidden at rest, appears on run | ✓ |
| Progress monotonic, never decreasing | ✓ 0 → 3 → 5 → 7 → 10 |
| 12 steps, no technical log dump | ✓ |
| Percentage varies with stages, not time | ✓ 0 / 25 / 42 / 75 / 100 |
| Indeterminate bar during synthesis, cleared after | ✓ |
| A stage is named at every point; never "Starting…" mid-run | ✓ |
| Counters: sources, queries, model, elapsed | ✓ |
| Tokens only after the model reports them | ✓ absent mid-run, 16,246 at the end |
| Ends `✓ Research completed` at 100%, steps still visible | ✓ |
| Soft failure names the stage, run still completes | ✓ *Financial sourcing — search failed - source unreachable* |
| Hard failure names the phase, completed steps retained | ✓ 7 steps kept |
| Extra requests introduced | ✓ none — 6 polls, 6 renders |

**Batch Research is NOT done yet.** The renderer is written against a job
snapshot, so it ports, but it has not been wired or verified there.

---

## 2d. Ford diagnosis — the incident behind the state model (2026-09-04)

> The durable contract is **§2e Single Company state model**. This section records
> what went wrong and how it was found.

### Root cause of the Ford click that "did nothing"

**No Ford job was ever in flight, and no tokens were spent.** Evidence: no
`reports/Ford*` on the engine, no Ford entry in `evidence_cache/`, no Ford row in
Neon, and `/api/aresearch/exists?companies=Ford` answers `{"Ford": false}`.

What happened is that **`needs_review` was treated as success.** The engine has a
quality guard that refuses to spend tokens when retrieval is too thin — for a name
as ambiguous as *Ford* with no website, identity cannot be confirmed — and it ends
the job with `status: "needs_review"` **before any model call**. The client did:

```js
if (snap.status !== 'running') break;      // needs_review falls through here
msg('Research complete. 研究完成。');       // ...and is announced as success
await openReport(company);                 // 404 — nothing was ever saved
// catch: msg('No saved report for this company.', 'err')   ← the red message
```

So a deliberate "we did not have enough evidence, and deliberately spent nothing"
outcome surfaced as a **red lookup error about a missing report**. The real reason
never reached the screen.

A second, independent trap was found while diagnosing: the engine's **unprobed**
health reports every model as `state: "unknown"`, and the proxy computes
`modelsAvailable = models.some(state === 'available')` → **false**, attaching an
`unavailableNotice`. Under the pre-`87ba3d9` client that blocked the run outright
with a payment message. The current client treats `unknown` as selectable, so it
does not block — verified against the live payload.

### The three states, now separate

| State | Styling | Says |
|---|---|---|
| **Existing report** | neutral purple panel | date, model, sources + View Report / View PDF / Regenerate / Delete; the main button becomes **Regenerate Research** |
| **New company** | neutral dashed panel | *New company — ready to research. 新公司 — 可以开始研究。* Never red |
| **Retrieval incomplete** (`needs_review`) | **warning**, not error | *nothing was generated*, the engine's own reasons, an existing report is untouched, and a **Research anyway** button that re-runs with the engine's `force` flag |
| **Real failure** | error | the actual API or job error, never a lookup message |

`openReport` no longer reports a 404 as a failure: a missing report renders the
**new-company** lookup panel. Only a non-404 fetch problem is styled as an error.

### Job execution

- The progress panel is rendered **on click, before the POST**, so a failing POST
  still shows where it stopped. Traced: click → POST `/research` → `job_id` →
  polling → panel updates → terminal state.
- **In-flight jobs are attached, not restarted.** The job id is kept per company in
  `sessionStorage`, so a second click — or a page reload mid-run — re-attaches and
  polls the existing job instead of paying twice. The user is told it reattached.

### Safe regeneration

Confirmed in the code, not assumed: the engine does `saved = save_run(...) if ok
else None`, and the CRM persists only `if (m.status === 'complete' && m.result)`.
A failed or needs-review run therefore **cannot** overwrite the stored report. The
UI matches: the previously displayed report is restored on failure and the user is
told it is unchanged.

### Verified 2026-09-04 — stubs and replay, no paid run

| Check | Result |
|---|---|
| Live all-`unknown` health does not block a run | ✓ |
| New company reads neutral, never red, keeps *Generate Research* | ✓ |
| Existing report shows date/model/sources + 4 actions, button becomes *Regenerate* | ✓ |
| Progress panel visible within ~250 ms of the click | ✓ |
| `needs_review` → warning, reasons listed, *Research anyway* offered | ✓ |
| `needs_review` never says "No saved report" | ✓ |
| Real failure → red, with the actual error | ✓ |
| In-flight job reattached, **no second POST** | ✓ |
| Missing report on open → lookup panel, no red box | ✓ |
| Lookup debounced | ✓ 13 keystrokes → 1 call |
| Progress + failure suites still pass | ✓ |

Retrieval, prompts, model routing, Apollo and the Neon schema were not touched.
**Batch Research still does not use any of this.**

---

## 2e. Single Company state model — CANONICAL

The contract for the Current Account Research → Single Company pane. §2d is the
incident that produced it; **this section is the reference.** Six states, and no
two of them may share a treatment. Conflating any pair is the bug class that
produced a red *"No saved report for this company"* in place of a research
outcome.

**Do not extend this to Batch Research yet.** Single Company is being held stable
first; Batch still uses its own status badges and is deliberately untouched.

### The six states

| # | State | Entered when | Billable? | UI treatment | Primary action | Also offered |
|---|---|---|---|---|---|---|
| 1 | **Existing report** | the lookup finds a Neon record for the name in the box | no | neutral **purple** panel, `.qr-lookup.is-existing` | **Regenerate Research / 重新生成研究** | View Report · View PDF · Regenerate · Delete Report |
| 2 | **New company** | the lookup finds none | no | neutral **dashed** panel, `.qr-lookup.is-new` | **Generate Research / 生成研究报告** | — |
| 3 | **Running** | POST `/research` returned a `job_id`, or an in-flight job was re-attached | yes, once | progress panel, 12 steps, live counters | Generate is **disabled** for the duration | — |
| 4 | **Needs review** | job ends `status: "needs_review"` | **NO — see below** | **warning** `.qr-msg.warn`, never red | **Research anyway / 仍然生成** (re-runs with the engine's `force`) | steps stay visible; existing report explicitly noted as unchanged |
| 5 | **Complete** | job ends `done` with a complete model | already spent | progress panel becomes `✓ Research completed` + `N sources · T tokens · S sec`; report renders below | report actions | library refreshes |
| 6 | **Error** | job ends `error`, or the model ends failed/timeout/access_denied, or a request throws | possibly, partially | **error** `.qr-msg.err` | retry is the user's call | the real API/job error text; completed steps retained; existing report noted as unchanged |

### State 4 — `needs_review` is a NON-BILLABLE, PRE-SYNTHESIS outcome

**This is the state that was being mis-reported, and the one to protect.**

`needs_review` means retrieval did not produce enough evidence to be worth
synthesising. The engine reaches it in exactly two places in `app.py`, **both
before any model is called**:

| Origin | Line | Mechanism |
|---|---|---|
| Quality guard | `if quality.get("blocking") and not force:` → `return` | **151** |
| Retrieval exhausted | `except rs.RetrievalError:` | **205** |

`run_model` is not even *defined* until line **159** and is not *called* until
line **195**. The guard returns at 151; the exception is raised during retrieval.
So:

- **No model request is made. No tokens are spent. Nothing is charged.**
- The per-model entries stay `status: "pending"` with no `token_usage`, so the UI
  correctly shows no token count.
- **Nothing is written to Neon.** The CRM persists only
  `if (m.status === 'complete' && m.result)`, and the engine only computes
  `saved = save_run(...) if ok else None`.
- **An existing report is therefore untouched**, and the panel says so.

**Rules:**

- Never style `needs_review` as an error. It is a decision point.
- Never announce it as "Research complete".
- Never let it fall through to `openReport()`, whose 404 then becomes the
  headline. That is exactly what happened with Ford.
- Always show the engine's own `quality.reasons`, not a generic sentence.
- Recovering from it costs tokens: **Research anyway** sets `force`, which skips
  the guard and does spend. That is the only billable path out of state 4.

### Rules that apply across all six

1. **A lookup result is never an error.** "No saved report" answers *does a report
   exist*, and may never stand in for *how did the run go*. A 404 from
   `/company/:name` renders **state 2**, not an error.
2. **Only states 4 and 6 may carry a non-neutral colour**, and they must not share
   one: warning for 4, error for 6.
3. **The real message wins.** State 6 shows the actual API or job error. No
   substitutions.
4. **Never pay twice.** A job id is kept per company in `sessionStorage`; a second
   click or a reload mid-run re-attaches to the running job.
5. **Progress is drawn before the POST**, so a failing POST still shows where it
   stopped.
6. **A failed run never replaces a good report** — enforced server-side, and
   mirrored in the UI by restoring the previous report on failure.

### State transitions

```
        ┌──────────────── lookup (debounced, /exists — no model) ───────────────┐
        │                                                                      │
   1 Existing report ──[Regenerate]──┐                    ┌──── 2 New company ──┘
                                     ▼                    ▼
                                   3 Running ◄── re-attach in-flight job
                                     │
             ┌───────────────────────┼────────────────────────┐
             ▼                       ▼                        ▼
   4 Needs review            5 Complete                  6 Error
   (no tokens, no write)     (report saved)              (report preserved)
             │
             └──[Research anyway → force]──► 3 Running   ← the only billable exit
```

---

## 2f. Contact enrichment — two real bugs, and CRM-first reuse (2026-09-04)

### Diagnosis of the Ford contact step

Answering the five questions asked, in order:

| Question | Answer |
|---|---|
| Was Apollo configured on the live engine? | **Yes.** `apollo_usage.configured: true` on both recent live runs. `load_config()` runs **per request**, so the long-lived engine picked up the key added at 19:18 |
| Was the company/domain resolved? | **Yes.** A live search resolved *Ford Motor Company → ford.com*. American Li-ion also resolved by domain. Resolution was never the problem |
| Does the CRM already hold Ford contacts? | **Yes — 40**, including Manufacturing VP, Plant Manager, Battery Cell Engineers; 12 carry an email |
| Can they be reused? | **Yes**, and they now are. See below |
| Did 0 candidates come from search, ranking, or mismatch? | **From the search call, which never reached Apollo.** Not ranking, not a mismatch |

**Bug 1 — `UnboundLocalError`, every POST.** `apollo_service._request` had
`import urllib.parse` *inside* the function while `urllib.request` was imported
at module level. That makes `urllib` a **local** name for the whole function
body, so every call path that skips the `params` branch — i.e. **every POST:
people search and bulk enrichment** — raised `UnboundLocalError` at
`urllib.request.Request` before a request was ever sent. The generic handler
turned it into "0 candidates".

Proof from the two live reports:
`"errors": ["UnboundLocalError: cannot access local variable 'urllib' ..."]`
on **both**, with `calls: 1` and `people_returned: 0`. Organization lookup worked
throughout, because it is a **GET with params** and so ran the local import.

This also explains why my 2026-09-03 connectivity check (§0a) passed: it exercised
only `resolve_organization`, the one path that worked. **That check was not
evidence that people search worked, and I should not have implied it was.**

**Bug 2 — the endpoint is retired.** With bug 1 fixed, Apollo answered **422**:
*"This endpoint is deprecated for API callers. Please use the new
mixed_people/api_search endpoint."* `search_people` now tries
`/mixed_people/api_search` first and falls back to the two older paths, treating
404 **and** 422 as "not on this tenant".

**Result after both fixes**, one live search, **0 credits** (search is free):

```
status: ok · people_returned: 100 · after SKEQI ranking: 94
```

### Apollo never blocked the report — the progress bar did

The pipeline was already non-blocking: `search_people` "never raises", and both
live runs **completed and persisted** despite Apollo erroring. What stalled was
the **progress panel** — a failed step was not counted as settled, so the bar
stopped at the step that failed. That is the "stuck at 67%".

Optional stages (`financial`, `contacts`) are now marked `optional: true`:

- a failure renders **⚠ amber**, not a red ✕
- the note reads *unavailable, continuing with available data / 不可用，使用现有数据继续*
- **it counts as settled**, so the bar keeps advancing to 100%

Critical stages keep the red ✕ and still stop the run: identity, no usable
evidence, synthesis, persistence.

### CRM contacts are used before Apollo

Contact source priority is now **CRM → official/web → Apollo**, with Apollo as a
gap-filler.

- `db.contactsForResearch()` matches on `company_id` (1,088 of 1,089 contacts
  carry one) and falls back to a normalised name compare. Ordered by real email,
  then LinkedIn, then seniority.
- `qwenResearch.crmContactsFor()` shapes them: name, title, department, seniority,
  company, location, email, email verification status, LinkedIn, CRM id.
- **The CRM proxy attaches them server-side** to `POST /api/aresearch/research`.
  Contact PII does not round-trip through the browser.
- The engine ranks them with the existing SKEQI ruleset via
  `people_service.from_crm()`, and **skips Apollo entirely** when the CRM already
  yields at least `enrich_limit` relevant contacts
  (`apollo_usage.status = "skipped_crm_sufficient"`).
- `merge()` dedupes on normalised name and gives CRM precedence: **a CRM email is
  never overwritten by Apollo**, and a CRM title beats an Apollo one.
- **No email is invented.** A contact with no email keeps an empty address; its
  status stays the CRM's own `not_checked` / `not_available`.

Note the existing relevance ruleset is unchanged: it targets manufacturing,
operations and plant leadership, and scores CFO and individual engineers **0**, so
those rows are dropped from the roster exactly as Apollo rows are. Re-tuning that
was not part of this change.

### Verified 2026-09-04

| Check | Result |
|---|---|
| Both Apollo call shapes reach the network | ✓ GET and POST, no `UnboundLocalError` |
| Live people search after the endpoint fix | ✓ 100 returned, 94 ranked, **0 credits** |
| CRM lookup for Ford Motor Company | ✓ 40 contacts, correct fields |
| Unknown company | ✓ 0 contacts, no error |
| Emails never invented | ✓ email-less rows keep `not_checked` / `not_available` |
| merge: CRM email and title win over Apollo | ✓ |
| Optional stage failure → ⚠, run completes | ✓ 50% → 75% → 100%, no ✕ |
| Critical failure still stops with ✕ | ✓ synthesis case unchanged |
| Progress, failure and state suites | ✓ 20 / 9 / 28 passing |

**No paid research run was made for any of this.**

---

## 2g. Durable research jobs — the CRM owns persistence (2026-09-04)

### What was wrong

Two failure modes, both able to lose research the user paid for.

1. **A finished report reached Neon only if a browser was polling.** `persistRun`
   was called from exactly one place: the CRM's job-poll handler. Close the tab
   before a run finished and the report existed only on the engine's disk —
   which on Render is ephemeral.
2. **Job state was a Python dict and a `sessionStorage` entry.** An engine
   restart erased in-flight work with no record anywhere, and the browser's copy
   could not answer "is anything running for this company" after a refresh.

### The model now

```
user clicks Generate
  → CRM checks Neon for an active job for that company
       ├─ found → returns that job_id, attaches, NO paid run
       └─ none  → claims a job row, proxies to the engine with callback_url
  → engine runs the research on its own
  → engine POSTs progress heartbeats to the CRM
  → engine POSTs the finished record to the CRM callback
  → CRM validates the service key, upserts the report, marks the job completed
```

**The browser is no longer in the persistence path.** Polling is read-only.

### The callback

`POST /api/qwen-research/callback`, server-to-server only.

- Authenticated with the shared secret: `APP_SERVICE_KEY` on the engine,
  `ACCOUNT_RESEARCH_SERVICE_KEY` on the CRM. Compared in constant time; a missing
  key on the CRM means **closed**, not open.
- Exempted from the human Basic-auth gate, because the caller is a server. That
  exemption is the only reason a browser-less completion can be stored, and the
  service key is the sole guard in front of it.
- Events: `progress` (stage, percent, warning), `completed` (the record),
  `failed` (reason).
- **Only a completed successful run is persisted.** `persistRun` rejects anything
  else, and the callback now answers **422 and marks the job failed** rather than
  reporting success with nothing stored — that silent success was found in
  testing.
- The engine never touches Neon. It has no database driver and no schema
  knowledge, so there is nothing to drift.

**New engine environment variable: `CRM_CALLBACK_URL`.** The CRM also passes its
own callback URL per request, so a correctly configured CRM works even if the
engine variable is unset. Set it on Render anyway, so the engine can report a run
that outlives the request that started it.

### The job table

`account_research_qwen_jobs`: job_id, company_key, company_id, company_name,
website, model, job_type, status, stage, progress_percent, warnings, error,
report_id, created_by, started_at, updated_at, completed_at.

**Duplicate protection is a partial unique index**, not a JavaScript check:

```sql
CREATE UNIQUE INDEX uq_arq_jobs_active ON account_research_qwen_jobs(company_key)
  WHERE status IN ('queued','running')
```

A second tab, a refresh, or a reopened browser all pass a client-side guard. The
database does not. A refused claim returns the existing `job_id` to attach to.

### Resume

`GET /api/aresearch/job-for-company?company=` returns the active and latest job.
The Single Company lookup calls it, and if a run is under way it restores the
progress panel and reattaches — **no session storage involved**. If the engine has
forgotten the job but the row says running, the panel is drawn from the row, so
the user sees state rather than a blank screen.

### Restart behaviour — stated plainly

**The in-flight model call does NOT survive an engine restart.** The worker is
still `threading.Thread(daemon=True)` inside the Flask process. A Render deploy,
crash or free-plan spin-down kills it, and there is no queue to resume from.
Claiming otherwise would need a real external worker, which is not built.

What *is* handled: a job with no heartbeat for **25 minutes** is swept to
`interrupted` — on CRM boot and every 5 minutes thereafter — with the reason
recorded. So an interrupted run is visible, it stops blocking the next attempt
for that company, and **the previous report is left untouched**.

### Regeneration safety

Enforced in three places, verified: the engine saves only on success, `persistRun`
accepts only a completed run, and a `failed` callback writes nothing. A failed
regeneration leaves the previous report at its existing version.

### Verified 2026-09-04 — real Neon, stubbed engine, no paid run

| Check | Result |
|---|---|
| Job table and indexes created | ✓ incl. the partial unique index |
| Second claim for a live company | ✓ refused by the database |
| Stage / progress / warnings persist | ✓ warning does not fail the job |
| Completion records report_id and 100% | ✓ |
| Completed and failed jobs stop blocking | ✓ |
| Stale job auto-marked interrupted with a reason | ✓ |
| Callback rejects missing / wrong / wrong-length key | ✓ 401 |
| Valid key accepted, written to Neon | ✓ |
| Bad record → 422, job failed, nothing stored | ✓ |
| Good record → report upserted, job completed | ✓ 32 → 33 |
| Failed regen leaves the old report | ✓ v1 stays v1 |
| Successful regen replaces it | ✓ v1 → v2 |
| Entering a company reconnects to a running job | ✓ 75%, no POST |
| Fresh browser context reconnects | ✓ no POST |
| Generate while running attaches | ✓ no duplicate POST |

All test rows removed; reports back to 32, jobs 0.

**Still to do:** Batch Research does not use any of this — it keeps its own
in-memory batch state and its Regenerate row action is unfixed.

---

## 2h. Batch Research — durable regeneration and a quieter Setup (2026-09-04)

### Row Regenerate now uses the SAME job as Single Company

It used to call `startBatch([one item])`, a second job implementation with none
of the durability: no durable row, no server-side duplicate guard, and a row that
did not visibly change until a poll came back, which is why it read as inert.

`rowAction('regen')` now calls `regenerateRow()`, which walks the same path as
Single Company:

```
click Regenerate
  → CRM checks Neon for an active job for that company
       ├─ found → attach, no paid run
       └─ none  → durable job claimed, engine started
  → row shows progress immediately
  → engine callback persists ONLY on success
  → existing report intact until the replacement lands
```

Verified: the click issues exactly one `POST /api/aresearch/research` and **zero**
calls to the old `/batch/start`.

### Row-level progress

The status cell shows the run rather than the stale report status, with a bar and
the stage in both languages:

`Researching / 研究中 75%` · `Generating / 生成中`

Stage names map from the engine's own keys: Queued, Validating, Searching,
Contacts, Building evidence, Generating, Generating PDF, Saving, Completed,
Interrupted, Failed. A failed or interrupted row shows the reason, and the report
it already had is untouched — `refreshExisting()` re-reads Neon rather than
assuming.

### Reconnecting

Opening the Batch tab calls `/api/aresearch/active-jobs` and reattaches any row
whose company is still running, so a tab switch, refresh or browser restart picks
the run back up. **No session storage** is involved.

### Setup is quieter

Company Column and Website Column are hidden. After an upload the card shows one
line:

`✓ 3 companies loaded · 2 websites provided`

plus a note that missing websites are resolved automatically. The mapping
dropdowns appear **only when the company column is genuinely ambiguous**, with an
amber prompt explaining why. The detected mapping is kept and used either way —
this is a UI change, not a logic change.

### Bilingual labels

`View / 查看` · `PDF / 查看PDF` · `Regenerate / 重新生成` · `Delete / 删除` ·
`Edit URL / 修改官网` · `Edit Company / 修改公司`. The `Regen` abbreviation is gone,
and the library row's bare `PDF` is now bilingual too.

### Verified 2026-09-04 — fixtures and stubs, NO paid batch run

| Check | Result |
|---|---|
| Confident headers → summary, no dropdowns | ✓ "3 companies loaded · 2 websites provided" |
| Straight to the company table | ✓ 3 rows |
| Ambiguous headers → mapping shown, amber, reason given | ✓ |
| Bilingual labels, no abbreviations | ✓ all six |
| Regenerate → one `/aresearch/research`, no `/batch/start` | ✓ |
| Row shows Researching with % and stage | ✓ 75%, "Generating / 生成中" |
| Row progress bar renders | ✓ |
| Engine-unreachable path | ✓ row shows Failed with the real reason |
| Tab switch does not restart anything | ✓ no new POST |
| Column detection across 8 header shapes | ✓ incl. 公司名称/官方网站, Domain, unlabelled URLs, junk column |

### Bulk generation is durable too (2026-09-04)

`startBatch()` and `pollBatch()` are **deleted**. They drove the engine's
in-memory batch, which no browser-independent record ever saw. Generate Selected,
Generate All and Retry Failed now queue the **same durable per-company job** as
Single Company and row Regenerate — one job per company, started one at a time.

```
Generate All
  → for each company, in order:
       start-or-attach a durable job   (startOrAttachJob)
       follow it, painting that row    (followRowJob)
       persist via the engine callback (independent of the browser)
```

- **Sequential on purpose**: it bounds cost and load, and it makes Stop mean
  something.
- **Each company persists independently.** One failure does not take the batch
  down, and completed companies are already in Neon before the next one starts.
- **Stop ends the QUEUE, not the run in flight.** The company already being
  researched finishes and is saved — the alternative is paying for a run and
  discarding it. The message says exactly that.
- **Retry Failed** re-runs only companies whose job failed, was interrupted or
  cancelled, or that never produced a report. A completed company is never
  re-run.
- **Reopening the tab rebuilds the table from Neon.** `/active-jobs` supplies any
  company still running, rows are recreated even with nothing uploaded, and each
  reattaches. No session storage anywhere.
- **Duplicate protection** is the same partial unique index: a company already
  running is attached to, never started twice.

Row states: `Queued / 排队中`, `Researching / 研究中` with the stage and a
percentage, `Completed / 已完成`, `Failed / 失败` with the reason,
`Interrupted / 中断`, `Cancelled / 已取消`.

### Verified 2026-09-04 — fixtures and stubs, NO paid batch run

| Check | Result |
|---|---|
| Generate All → one research call per company | ✓ 3 of 3 |
| Started sequentially, not in parallel | ✓ in order |
| Zero calls to the old `/batch/start` | ✓ |
| Every row ends Completed | ✓ |
| Generate Selected runs only ticked rows | ✓ 1 of 3 |
| A mid-batch failure does not stop the rest | ✓ 2 completed, 1 failed |
| Failed row shows the real reason | ✓ "upstream 500" |
| Summary counts completions and failures | ✓ |
| Retry Failed re-runs only the failure | ✓ 1 company |
| Retry Failed with nothing failed does nothing | ✓ no calls |
| Reopen with no upload rebuilds rows from Neon | ✓ row recreated, reconnected |
| Reopen does not start a new run | ✓ no research call |

### Remaining limitations

- **No paid batch run has been made.** All of the above is fixtures and stubs.
- **The queue lives in the browser tab.** Each company's job is durable and its
  report is safe, but if the tab closes mid-batch the *remaining* companies are
  never started. Reopening shows what is running and what finished; the rest need
  Generate again. A server-side queue would fix this and is not built.
- The in-flight model call still does not survive an engine restart (§2g).
- The engine's own `/api/batch/*` endpoints still exist and are unused by this
  UI.

---

## 2i. Research Sessions — ordered by what needs a person (2026-09-05) — TESTED

**Commit `31ec355`, frontend only** (`public/index.html`, `public/qwen-research.js`).
No backend, engine, retrieval or synthesis code was touched.

The list was previously ordered by recency, so finished work competed for
attention with work that was blocked. It is now three tiers:

| Tier | Contains | Rendering |
|---|---|---|
| NOW | `running` | one row each, blue rail `st-active` |
| NEEDS ATTENTION | `interrupted`, `save_failed`, `synthesis_failed`, `failed` | one row each, amber rail `st-attention` |
| DONE | `completed` | ONE collapsed line + `View all reports →` |

- A left status rail replaced the percentage-plus-chip pair. `railClass()` maps
  state to rail, so state lives in one function.
- **At most one inline action per row** (Regenerate, or Retry Save). Host, model
  and every secondary action moved into a `<details class="qr-menu">` overflow
  that reuses the Reports table pattern. An explicit guard stops opening the
  menu from switching workspace — the menu sits inside a clickable row.
- Completed sessions no longer render as rows at all; the summary names a few
  accounts and links to the Reports library.
- `save_failed` section counts are fetched lazily, only for those rows.

**Verification.** Three CRM suites green before commit — job-snapshot 51,
research-cost 44, identity-state 41. Production smoke after deploy: 29 browser
checks green, invariant-based (expectations derived from the live sessions API,
not hard-coded), plus a 6-check run for `save_failed`. No research POST was
issued by any check.

> `save_failed` exists in neither production data nor the unit tests, so its
> branch is verified by stubbing the sessions response **in the browser only**
> (`scratchpad/savefailed.py`). Nothing is written. If that branch is changed,
> re-run that script — no other test covers it.

---

## 2j. P0 — target website integrity (2026-09-05) — DIAGNOSED, NOT FIXED

**The defect.** A validated user-supplied domain can be silently replaced by
auto-discovery, and the substitute then monopolises the evidence.

红旗: job website `https://www.hongqi-auto.com`; stored report
`company_website` = `https://pcauto.com.cn`; all 16 retained sources on that
consumer car-price portal, classified `official-website`; zero automation
vendors named. Job `d9e9fd9677b0407ab4a494d420002dcc`.

**Path.** `resolve_website` → `validate_website` returns `ok=False`,
`website_mismatch` → the only trace is a `progress("discover", ...)` line, never
persisted → `discover_official_website` returns `pcauto.com.cn` as
`auto_discovered`, which becomes the official domain for tier classification,
for the `site:` query, and for the report's `company_website`.

**Root cause.** The gate is `score >= 5 and (named or multi)`. For 红旗 the call
returns score 4, signals `['about','contact','products','shallow-path']`. The
account name is CJK-only; the fetched page is English (10,495 chars, opens
`HONGQI AUTO OFFICIAL WEBSITE`, **zero** occurrences of 红旗). No signal compares
a transliterated domain against a CJK name. Note the **blocked**-host branch
already trusts `domain~name`; the reachable branch, with strictly more
information, uses no domain evidence at all.

**Second, larger defect — no per-domain ceiling.** `apply_evidence_caps` sorts
by tier first; `classify_source` gives tier 1/2 to anything on the resolved
domain *including subdomains*; `MAX_EVIDENCE_ITEMS` is 16; there is no per-host
or per-domain cap anywhere in retention or fetching (grepped: none). Official
pages therefore fill all 16 slots and third-party evidence is dropped as
`evidence cap` before the low-tier budget is consulted. **This is the mechanical
reason Competitor Analysis and Existing Automation Providers are weak** — the
evidence set contains no third-party sources, so no prompt change can fix it.

**Blast radius, measured against live Neon.**

- Supplied domain replaced in **3 of 12** jobs carrying both fields:
  BMW `bwm.com`→`bmw.com.cn` (benign typo fix), Volkswagen `vw.com`→`volkswagen.com`
  (benign), 红旗 `hongqi-auto.com`→`pcauto.com.cn` (harmful). Any correction must
  preserve the two benign ones.
- Concentration across all 43 reports, **by registrable domain**: 18 at ≥80% one
  domain (10 of them with ≥10 sources); 14 entirely single-domain (8 with ≥10);
  median top-domain share 75%.

> **Measurement trap:** an earlier cut computed this per *hostname* and reported
> 14, not 18 — 红旗 was invisible because its sources split across
> `pcauto.com.cn`, `m.pcauto.com.cn` and `price.pcauto.com.cn`. Always collapse
> to the registrable domain.

**Proposed smallest correction (NOT implemented).**
- *P0a* — add a `domain~name` corroboration signal to the reachable branch of
  `validate_website` (the rule the blocked branch already applies); and when
  discovery returns a domain sharing no token with the supplied one, keep the
  supplied domain, record the other as a candidate, and warn on the job.
- *P0b* — one counter in `apply_evidence_caps`: no single registrable domain may
  supply more than ~half of `MAX_EVIDENCE_ITEMS`.

**Concentration diagnostic (NOT implemented).** A report-level *warning*, never a
gate — the best-effort principle stands. Computed on the registrable domain,
persisted on the job (top domain, share, distinct-domain count, whether it is the
resolved official site), suppressed below a small source count (4 of the 14
single-domain reports have 1–2 sources).

Full write-up: artifact `b0e03927-9b83-4ee6-a30e-575645b9ef87`.

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
4. **Batch Research is deliberately unchanged.** It uses neither the §2e state
   model nor the §2c progress panel, and keeps its own status badges. This is a
   hold, not an oversight: Single Company is being kept stable first. Note that
   the batch path has the same latent trap — a `needs_review` company will read
   as an ordinary non-completion there — so it should be ported before batch is
   relied on for ambiguous company names. Its layout was
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

**Production CRM hostname — `https://skeqi-emaildrafter-i46d.onrender.com`.**
Confirmed by the user against the Render dashboard and verified from a shell on
2026-09-06. **`skeqi-emaildrafter.onrender.com` is OBSOLETE** — no Render service
is bound to it, so it answers `404` with `x-render-routing: no-server` on every
path including `/healthz`. Probing it looks exactly like a failed deploy when
nothing is wrong; two sessions have now lost time to it. Do not use it.

The **engine** hostname is still unrecorded. `DEPLOY.md` in the engine repository
carries the CRM hostname now and keeps `<this-service>` as a placeholder for the
engine's own.

Dashboard state itself is still not in the repository: the blueprint declaring a
variable is not evidence that it holds a value.

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
- **Do not collapse the six Single Company states (§2e).** In particular:
  `needs_review` is a NON-BILLABLE, pre-synthesis outcome — never style it as an
  error, never announce it as complete, and never let it fall through to
  `openReport()`.
- Do not let a lookup result ("no saved report") stand in for a run outcome.
- Do not extend the state model or the progress panel to Batch Research yet.
  Single Company is being held stable first.
- Do not re-add a function-local `import urllib.parse` to `apollo_service._request`;
  it shadows the module-level `urllib` and breaks every POST (§2f).
- Do not call Apollo before checking the CRM's own contacts (§2f).
- Do not let an optional enrichment stage stall the progress bar or show a red ✕.
- Do not collapse the three model-health states back into a boolean. An
  unreachable engine is not a billing problem; see §2a.
- Do not remove `.qr-form label[hidden]{display:none}` — without it a hidden
  field still occupies its row.

---

## 2l. Company-key identity repair (2026-09-06) — DONE, VERIFIED

**The defect.** A job and the report it produced could be written under different
company keys, because the engine derived its own key from the company name while
the CRM derived one through `resolveIdentity`. A completed session then offered
**Open**, the client sent a company NAME, the server resolved that name back
through the key, and found nothing. Comau LLC was the reported case.

**The fix, in two parts.**

1. *Code* (commit `52673be`). A session opens the report it actually produced,
   **by id**. The row button, the overflow menu, the PDF button and every later
   render of an open report all carry `report_id`; opening the right row and then
   re-resolving the markdown by name would have shown a different report.
   `Open` is now offered because a report EXISTS, not because a job reached a
   terminal state — a terminal job with no `report_id` shows `no report saved`.
   `getQwenReport` gained the job join `getQwenReportForCompany` already had, so
   both lookups answer with one shape; by-id used to drop the run's cost from the
   report card.

2. *Data* (one transaction, `repair-keys.js`, applied 2026-09-06). Every job and
   report key re-derived from its own company name.

| what | count |
| --- | --- |
| jobs re-keyed | 20 |
| reports re-keyed | 4 |
| jobs repointed to the merged AMADA row | 1 |
| superseded report rows deleted | 1 |

**Only the key moved on those jobs.** Status, error text, timestamps, attempts and
accounting were never in any UPDATE. The 17 jobs killed while still queued still
read exactly as before: `interrupted`, no start time, no report, error preserved.

**One CJK job carried an empty key.** `红旗` job `d9e9fd9677b0` had
`company_key = ''` — the engine's old normaliser erased the name. It is now `红旗`.
The current `resolveIdentity` cannot produce this; the regression test in
`test-identity-state.js` covers it.

**AMADA collision.** Two report rows existed. The canonical row
(`…__20260906153511`, keyed `amada weld tech`) kept its id and took the NEWER
content from the mis-keyed row, version `19 → 20`, researched `19:08:40`,
80,184 bytes, 16 sources. Note the newer content is SMALLER than the v19 content
it replaced (98,427 bytes); that is the run's own output, not a truncation. The
mis-keyed row was deleted after verification. No foreign key referenced report
ids, so the delete was safe.

**Four jobs still reference a report row that no longer exists** — ACRO
Automation Systems, BYD, Torus, and one AMADA job. This is PRE-EXISTING damage
from before report persistence was reliable, NOT caused by the repair, and it is
not repaired. The report-open fix makes it harmless: those rows now say
`no report saved` instead of offering a button that fails.

**Integrity checks** (`integrity-check.js`, all green): key derivation on 69 jobs
and 31 reports, one report per key, job/report identity agreement, the 17 queued
jobs unchanged, the AMADA merge, no new dangling reference, and name lookup still
resolving for all 22 companies that have a report.

Snapshot of every touched row before the repair:
`scratchpad/pre-repair-snapshot.json` (267 KB) — the repair is reversible from it.

---

## 2m. Post-repair production verification (2026-09-06) — DONE

Run against `https://skeqi-emaildrafter-i46d.onrender.com` with HTTP Basic. The
deployed `qwen-research.js` has the same SHA-256 as the working tree.

| check | result |
| --- | --- |
| Comau opens its own stored report by id | PASS, 165 KB returned |
| four jobs with a dead report pointer show `no report saved` | PASS, after `5a560ad` |
| every session key derives from its own company name | PASS, 70 rows |
| the 17 killed-while-queued jobs read as historical | PASS, none live, none stale |
| no contradictory `Interrupted · Queued` row | PASS |

### The first fix was incomplete — found by this verification

`52673be` gated Open on `report_id` being present. Four completed jobs HOLD an
id whose report row is gone, so they still rendered Open and it returned `404`.
Testing the id answered *"was a report ever saved"*; the question is *"can this
be opened now"*.

`deleteQwenSession` had said so in a comment for weeks — a session's `report_id`
is a historical pointer that may already resolve to nothing — and nothing acted
on it. **Read that comment before touching this again.**

`5a560ad` adds `report_exists` (an `EXISTS` against the report row) to BOTH
`listQwenSessions` and `listRecentQwenJobs`, and the client gates on it: the
row's button, the overflow menu, and the `Interrupted · report saved` /
Reconcile branch, which had the identical mistake. A payload without the field
falls back to the id, so an older client loses nothing.

### AMADA merged report — inspected, NOT changed

No section was lost: 20 sections before, 20 after. But the newer content is not
simply a smaller rendering of the same research, and **three verified facts
present in the superseded content are absent from it**:

- *Latest News* — the MacGregor Welding Systems acquisition, dated 2020-05-16,
  marked `Verified`, carrying four trade-press sources. Now `Not enough evidence`.
- *Upcoming Projects* — the MacGregor integration initiative, marked `Verified`.
  Now `Not enough evidence`.
- *Financial Information* — the primary value driver, marked `Verified`, and the
  ownership-structure line. Both gone.

The source sets differ accordingly. The older run cited `manufacturingdigital`,
`laserfocusworld`, `thefabricator`, `amadaweldtech.eu` and `awt.amada.co.jp`; the
newer cites `linkedin`, `caifuhao.eastmoney`, `chem17`, `ametchina` and
`finance.eastmoney`. Both are 8/16 from `amadaweldtech.com` — the source
concentration of §2j. **These are two independent runs, so this is retrieval
variance, NOT the merge losing data**; the merge copied the newer run faithfully.

The newer content is BETTER in one important place. The old *Competitor Analysis*
listed 18 "competitors" that were largely not organisations — a headline
(`Amada Miyachi America Europe Acquires MacGregor`), a page title
(`Company Profile (amada.co.jp)`), the account itself (`AMADA Micro Welding
Section`), a law firm, and `Terms, conditions` as an offering — with 12 of 18
citing `[comp-block]` rather than any numbered source. The new one says no
sufficiently verified competitors were found. **That is the GenAI-discovery
redesign working as designed**, and it accounts for most of the byte drop.

Left as it is, per the user: byte count alone is not a reason to change it.

### Two content defects visible in the canonical AMADA report

Both are instances of the deferred content-quality issue, now with evidence:

1. **Prompt scaffolding reaches the reader.** `SOURCE OF TRUTH`,
   `TABLE: [Empty per discovery result]`, `N/A per discovery`, and worst, an
   instruction addressed to the model: *"Do not turn this into an incumbency
   analysis; that lives in Existing Automation Providers."*
2. **A Chinese sentence appears inside the `**English:**` block** of Competitor
   Analysis, and `incumbency` is left untranslated in the Chinese block. The
   bilingual validator compares tables and cross-references, not language
   purity, so it does not catch this.

---

## 2n. Queue management + status semantics (2026-09-07) — DEPLOYED, PRODUCTION-PROVEN

CRM commits `0cfbd72` (status semantics) and `bf2af6c` (queue cancellation), live
on `skeqi-emaildrafter-i46d.onrender.com`, client asset hash matched.

### The stale local servers — READ THIS BEFORE DEBUGGING THE QUEUE AGAIN

**Two `node server.js` processes were still running on the developer machine from
2026-09-02 and 2026-09-03, against production Neon, and they were bulk-killing
healthy QUEUED jobs every five minutes.** They executed the pre-`a0745e6`
sweeper, whose filter was `status IN ('queued','running')`. Node caches modules
at require time, so fixing `db.js` on disk never reached either process.

They killed 32 jobs across three clusters (16 + 1 + 15). The 5-minute interval is
visible in the data: two clusters are exactly 300 seconds apart. Both processes
were stopped 2026-09-07 05:09Z; no cluster has appeared since.

> **A long-running local `node server.js` holds the OLD code and the PRODUCTION
> database.** Restart or stop local servers after any change to job lifecycle
> code, and check `ps aux | grep "node server.js"` before concluding that a
> deployed fix is not working.

### Two questions, two vocabularies

`sessionState` answers what a JOB did. `companyState` answers what a COMPANY is.
They are deliberately different and must not be merged.

- `interrupted` + no `started_at` + `attempts = 0` now presents as
  **Interrupted before start / 启动前中断**, with no stage appended — printing
  the stage produced "Interrupted · Queued", which read as though research began.
- `cancelled` presents as **Cancelled / 已取消**.
- Neither is in the attention set or the live set. Both stay in history.
- The stored status is never rewritten for presentation.
- Needs Attention is now a real total from the server, classified by the same
  `sessionState` the rows use. It counted the loaded page before, which is why it
  read 25 whatever the truth was.
- `companyState` has four states — Researching, Queued, Existing Report,
  Pending — and takes NO history argument, so a failed run can no longer keep a
  company looking broken. Used by Batch Research and the Single lookup.

### Queue cancellation

`GET /api/aresearch/queue` and `POST /api/aresearch/queue/cancel`
(`{scope:'all'}` or `{scope:'selected', job_ids:[…]}`).

The guard is the design: `WHERE job_id = $1 AND status = 'queued'`. Zero rows is
the ANSWER, not an error — the caller reads the row's current state and reports
`already_running`.

**The engine needed no change.** Its claim query already reads
`WHERE status = 'queued'` and `idx_arq_claimable` is partial on the same
predicate, so a cancelled row leaves the index by itself.

`cancelled` is terminal in THREE places, because terminality is computed in
three: `JOB_TERMINAL` (the heartbeat), `completeQwenJob`'s own inline list, and
`failQwenJob`, which previously wrote unconditionally.

### Production validation, 2026-09-07 — 49 checks, all green, no paid run

> **How to probe the queue safely.** A queued row in production is claimable
> within seconds and a claim SPENDS MONEY. `job_store.claim()` checks
> `LIVE_COUNT >= MAX_CONCURRENT` (2) BEFORE claiming, and `LIVE_COUNT` counts
> running rows with a LIVE lease. So plant two `running` probes with a lease ten
> minutes out first; every worker then declines to claim. Verified: zero jobs
> started during the window.

Proven live: route counts, cancellation, `completed_at` set while `started_at`
and `attempts` stay untouched, the row leaving the claimable set and the
duplicate guard, a company becoming eligible again, a company with a RUNNING job
still blocked, the claim/cancel race returning `already_running`, all three
callback guards refusing to revive a cancelled row, Cancel All touching only
queued rows, and the row remaining in history as Cancelled while Needs Attention
did not grow. All 6 probe rows deleted; zero remain; the table is back to 90.

Test suites: 674 checks across 12 files, plus 49 production probe checks.

---

## 2o. Live work, live UI, and orphan recovery (2026-09-07) — CRM DEPLOYED

CRM `24018be` live and hash-verified. Engine `5df07d7` **pushed but NOT yet
deployed** — the worker service still runs the old reaper (see below).

### Recent Sessions is patched, not rebuilt (`18f8cee`)

The overflow menu is a native `<details>`; its open state lives in the DOM and
nowhere else. `renderSessions` wrote `innerHTML` over the whole list every three
seconds, so the menu closed the instant it opened. The list is now reconciled by
`job_id`: rows keep their elements, only changed cells are written, and an open
menu is never swapped — new markup waits and is applied on close. Open menu,
scroll, focus, hover and selection all survive a poll. Polling is unchanged.

### Live work is surfaced, history is paged (`24018be`)

Manage Queue said "6 waiting, 1 running"; Recent Sessions said "7 running" and
showed one of them. Both came from one list doing two jobs: history is ordered by
`started_at` and paged 25 at a time, and **a queued job has no start time**, so
Postgres sorted the live work in among 32 historical rows that also had none.

- `listQwenActiveSessions()` — same `JOB_LIVE` predicate as the queue, UNPAGED,
  running first then queue order. Rendered as **Active Now / 当前任务**.
- `listQwenSessions()` — now `status NOT IN JOB_LIVE`. **Recent History / 最近历史**.
- Both read one `SESSION_COLUMNS` constant, so they cannot render different shapes.
- Header now reads `2 researching · 3 queued · 25 need attention · 25 of 100
  history shown`. It previously reported the sum of the first two as "running".

> **Invariant, tested and verified live:** the job ids Manage Queue calls live
> equal the job ids Active Now shows, subject only to the polling race.

### Batch Research tells you what is executing (`9ebd6f0`)

Three call sites wrote `status: 'running'` whatever the backend said — the
follower on attach, the durable fallback, and reconnect (which applies it to
`/active-jobs`, a route that returns queued rows too). All three now carry the
real status and the badge asks `companyState`. The executing row is tinted.
Queue position deliberately absent: no whole-queue poll exists on that tab.

### Orphan recovery (`5df07d7`, engine — NOT DEPLOYED)

**Reaping only ever ran inside `claim()`**, so a worker busy with a long run
could not rescue a job a dead process left behind. `JobStore.reap()` runs the
same statement under the same advisory lock without claiming, and `worker.py`
calls it from a thread every 45s.

**Measured in production on 2026-09-07, read-only, on the OLD code:**

| | |
| --- | --- |
| Masmec's lease expired | ~07:04:10Z |
| reaped and re-claimed | ~07:09:17Z |
| orphaned for | ~5 minutes |
| what unblocked it | the OTHER job (Lithos) finishing |

With the deployed fix that becomes ≤45 seconds and does not depend on another
job finishing. Worker `73d4d861` has now died mid-run **twice** in one evening.

### Ownership model — settled, do not change without production evidence

| owner | responsibility |
| --- | --- |
| worker maintenance reaper | ALL normal lease recovery, every 45s |
| CRM `sweepStaleQwenJobs` | 25-minute last-resort terminal cleanup only |

The sweeper predicate is UNCHANGED and stays unchanged. Decoupling the reaper
removes the race by itself: the reaper wins by ~24 minutes unless no worker
process exists at all, which is exactly what the sweeper's own comment claims to
detect. Residual: if the worker service is down >25 min, the sweeper still
terminalises a job with attempts remaining. Deliberate visibility.

Tests: CRM 769 across 15 suites; engine 40 in `test_orphan_recovery.py` plus 105
in `test_durable_queue.py`.

---

## 6. NEXT ACTIONS

1. **Deploy engine `5df07d7` to the worker service.** Pushed, not deployed. Until
   it is, an orphaned job waits for the current run to finish (§2o).
2. **Record the ENGINE's Render hostname** in `DEPLOY.md`. The CRM's is now
   recorded; the engine's is still `<this-service>`.
3. **Running-job cancellation** is deliberately NOT implemented. A running job
   is inside a worker with no way to be told to stop; the UI says so.
4. **Requeue the jobs killed while queued** — 32 now, deliberately deferred by
   the user; they are identity-repaired and ready.
5. **Content-quality pass** — now evidenced in §2m: reports emit prompt
   scaffolding into user-visible sections, including an instruction addressed to
   the model, and leak one language into the other's block.

**Deliberately NOT scheduled** (user decision, 2026-09-04): supplier/integrator
discovery expansion, distributor discovery, new competitor retrieval, prompt
changes, and Workstream 2 Version 4. Version 3 was measured and rejected —
NOT WORTH THE ADDED RETRIEVAL.

---

## 7. Session handoff

**Current state:** commit `52673be` on `account-research-qwen`, pushed to
`origin`. Engine production revision `627a80a`. The queue is IDLE — zero jobs
queued or running. No paid research has been started.

**Exact stopping point.** The company-key repair is APPLIED and VERIFIED against
live Neon (§2l). The report-open fix is COMMITTED, PUSHED and **DEPLOYED**: the
live `qwen-research.js` at `skeqi-emaildrafter-i46d.onrender.com` has the same
SHA-256 as the working tree. Post-repair UI verification against production is
recorded in §2m.

**Last successful operation:** CRM `24018be` deployed and verified live — the
Manage Queue / Active Now invariant holds against production, and no live row
appears on a history page.

**The queue is idle** and the table holds 90 jobs, unchanged by the probe.

**Untracked, deliberately not committed:** `repair-keys.js`, `integrity-check.js`,
`check-amada.js`, `observe-amada.js` (one-off operational scripts), and
`researchConfidence.js`, `researchSections.js`, `skqCapabilities.js`,
`reconcile-historical-jobs.js`, `test-reconcile.js` — none of which any module in
the running server requires. Verify that before assuming they are dead.

> **Deploy-verification trap, twice hit:** every CRM route except `/healthz` and
> the engine callback is behind HTTP Basic. An unauthenticated `curl` of a static
> asset returns the 15-byte body `Login required.`, so a hash comparison against
> it always "differs" and tells you nothing. Always pass `-u "$APP_USERNAME:$APP_PASSWORD"`.
> A 200/404 probe is likewise not a deploy signal — only an exact asset hash is.

**Open items:** §2j P0 (not implemented), P1 rejected-candidate persistence, the
Render dashboard values in §4a, and `APOLLO_API_KEY` on the Render engine
service (§0a). Batch Research remains on a deliberate hold (§2e).

**Do not:** run Generate or Refresh to test. They are live (§0).

**Running locally:** `PORT=<port> CURRENT_ACCOUNT_RESEARCH_URL=http://127.0.0.1:5062 node server.js`
with the engine started from its own repository. `DATABASE_URL` in `.env` already
points at live Neon, so local runs read and write **production data** — take care
with delete and regenerate.

**Browser tests** need an explicit Chromium path; the venv's bundled revision is
stale. Use
`~/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`.

---

## 2k. Research Sessions history + permanent deletion (2026-09-05) — DEPLOYED

Commits `fb3c4eb` (Sessions) and `2ecf435` (defensive CSS), on top of the
approved `d3e7981` (P0-D CRM) and `845a678` (manifest CRM). Deployed and
validated in production.

Sessions is now a **history**, not a work queue. Every status appears regardless
of age, ordered `started_at DESC` with `job_id` breaking ties, keyset-paged.
Needs Attention is a count and a filter over the same rows and no longer decides
membership. Permanent per-session deletion removes the job and its sections in
one transaction, re-asserting the terminal check inside the lock.

> **Correction on `2ecf435`.** It was initially attributed to a flex visibility
> bug found during smoke testing. That diagnosis was **wrong**. The actual issue
> was in the smoke harness: it had not opened the Account Research tab, so the
> pane sat inside a `display:none` view container and every visibility assertion
> was meaningless. **The filter itself was never broken.** The defensive
> `flex:0 0 auto` rule is harmless and is retained. The lesson is in the harness:
> count and text queries succeed on hidden elements, so a smoke test must assert
> the pane is visible before trusting any visibility result.

### Final production validation

| Check | Result |
|---|---|
| Recent history across >24h | verified — 3 dates, 5 rows older than 24h |
| `started_at` ordering | verified — strictly newest-first, DOM matches API |
| Needs Attention filter | verified — 22 rows narrow to 8 and restore |
| Completed Open action | verified — 14 completed rows, each individual |
| Terminal deletion | verified — job + 2 sections removed, re-delete 404 |
| Report preservation | verified — library unchanged at 44 |
| Zero orphaned sections | verified — 0 orphans after deletion |
| Pagination | **not production-exercised** — 21 sessions < 25 page size |
| Running deletion blocked | **not production-exercised** — no active job; unit-tested |
| Research / synthesis | none initiated |

Production after validation: 21 jobs, 44 reports, 197 sections, 0 orphans. All
smoke fixtures were disposable and are cleaned up.

