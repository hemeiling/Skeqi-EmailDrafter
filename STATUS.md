# SKQ CRM — Project Status

> Last updated: 2026-09-03
> Updated by: Claude
> Scope of this document: **Current Account Research (Qwen-based)** inside the CRM.
> Branch: `account-research-qwen`
> Current phase: UI parity pass ported from the standalone engine, **verified against live Neon**

`HANDOFF.md` remains the week-of-2026-08-23 handoff for the wider CRM (Booth Map
re-key, chat, exhibitor sync). It is untracked and was not touched.

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

## 3. Recent test results — live Neon, 2026-09-03

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
| **Refresh** — blocked state | ✓ shows *Model unavailable — activation/payment required.* and *模型暂不可用 — 需要开通/付费。*, sends **no** research request, and the banner repeats the condition |
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
  endpoint. See Known issues 1: the live models are now *available*, so a real
  click would have spent tokens and replaced a production report.
- **Post-run integrity:** the 29 rows were compared row for row against a snapshot
  taken before any test — id, company key, name, version and `researched_at` all
  **identical**, 0 added, 0 removed, no fixture rows left behind.

## 4. Known issues / uncertain

1. **The models are now AVAILABLE, which contradicts the older 403 note.**
   A live probe on 2026-09-03 returned `available` for all three:
   `qwen3.6-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-0731`. The engine's own
   STATUS.md still describes a 403 `AccessDenied`. **Consequence: Refresh and
   Generate now really run**, spend tokens and replace the saved report for that
   company. Treat them as live actions, not as no-ops.
2. **Refresh was not exercised end to end** for that reason. Its guard, its
   confirm step and its wiring were verified; a real regeneration was not run.
3. `CURRENT_ACCOUNT_RESEARCH_URL` and `ACCOUNT_RESEARCH_SERVICE_KEY` are absent
   from `.env`. The engine URL has to be supplied to run the workspace locally;
   without it, compile, render and research all fail.
4. Batch Research was not re-run against live Neon in this pass. Its layout was
   verified; its generation path is unchanged by this port.

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

---

## 6. NEXT ACTIONS

1. Run the workspace once against live Neon and confirm the library, Compile
   Selected, Delete Selected and the ⋯ actions behave on real records.
2. Commit `public/index.html` and `public/qwen-research.js` on
   `account-research-qwen`, then open a PR.
3. Set `CURRENT_ACCOUNT_RESEARCH_URL` and `ACCOUNT_RESEARCH_SERVICE_KEY` for
   local development and on Render.
4. When DashScope access is activated, run one company end-to-end: research →
   Neon upsert → report → PDF.
5. Fold the standalone engine's own UI pass into the repo it lives in, or retire
   that UI as a reference once the CRM is the only surface users see.

---

## 7. Session handoff

**Last successful operation:** the verification run in section 3, all checks
passing, against the real frontend with a stubbed API.

**Current stopping point:** the port is complete and **uncommitted** on
`account-research-qwen`. `public/index.html` and `public/qwen-research.js` are the
only modified tracked files; `HANDOFF.md`, `researchConfidence.js`,
`researchSections.js` and `skqCapabilities.js` were already untracked and were not
touched.

**Recommended next action:** verify once against live Neon, then commit.

**Runnable locally?** The frontend, yes. The server, no — it needs a reachable
`DATABASE_URL`.
