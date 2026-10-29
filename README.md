# AI Lead Magnet Generator

A free web tool that turns a topic and a target audience into a polished ebook, guide or checklist PDF in minutes.

## How it works

```
systeme.io page (Raw HTML element)
   │  1. user picks format, topic, audience, options
   │  2. POST /webhook/outline ─────────►  n8n: validate → load prompt from GitHub → OpenAI → validate → reply
   │  3. user edits / approves outline
   │  4. POST /webhook/section  (once per section, with a progress bar) ──► n8n: same pattern
   │  5. user picks template, colors, fonts, logo, CTA link (live preview)
   │  6. "Download PDF" → POST /webhook/pdf ──► n8n: check → private Apify actor (headless Chrome) → PDF file
   ▼     backup if the PDF service fails: the browser's print window → Save as PDF
```

The OpenAI and Apify keys exist **only** inside n8n credentials. The frontend never sees them.

## Repo structure

```
/frontend      Raw HTML snippet for systeme.io + app.js / app.css (loaded via jsDelivr)   (Phase 4)
/templates     HTML/CSS design templates, shared by the live preview and the PDF        (Phase 5)
/prompts       Versioned AI prompts, fetched by n8n at runtime
/schema        JSON schemas: the shared document shape + the AI response formats
/n8n           Importable n8n workflow JSON files                                       (Phases 2-3)
/apify         Private Apify actor that turns the print-ready document into a PDF       (Last step)
/scripts       build_widget.py: builds the pinned systeme.io snippet
```

## Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-10-27 | PDF via browser print-to-PDF (option A). | Free, no infrastructure, vector text. Same HTML templates can move to Gotenberg or a paid API later. |
| 2026-10-27 | One AI call per section, not one call for the whole document. | Avoids webhook timeouts, gives real progress, allows regenerating one section. |
| 2026-10-27 | AI content is plain-text blocks, never HTML/Markdown. | Templates escape everything, so neither users nor the AI can inject scripts or links. |
| 2026-10-27 | AI model chosen in n8n, not in prompts. | Swap models without touching prompt files. Start with a low-cost model and upgrade if quality needs it. |
| 2026-10-27 | Optional `offer` input (outline prompts v2). | Live test showed CTAs guessing the offer (e.g. an invented webinar) and titles restating the topic. |
| 2026-10-27 | PDF via native browser paged media, no pagination library. | Current Chrome supports page size, named pages and page-number margin boxes; no extra dependency, and the output was tested with Chrome's own PDF engine. Firefox prints the same layout without page numbers. |
| 2026-10-27 | Repo is public. | n8n reads prompts with no token; jsDelivr can serve the frontend for free. No secrets live in the repo. |
| 2026-10-27 | OpenAI called with the HTTP Request node (OpenAI credential), not the OpenAI node. | Full control of strict JSON-schema output, independent of n8n node versions. Starting model: `gpt-4.1-mini`. |
| 2026-10-29 | Real PDF download through a private Apify actor (headless Chrome), print window kept as the backup. | One-click download with a clickable button, without running a browser next to n8n. The actor prints the same HTML as the print window, so both give the same layout. |

## The document format (`/schema`)

| File | What it is |
|---|---|
| `document.schema.json` | The full document: format, user inputs (`meta`), title, sections with content blocks, CTA, branding. Every step reads and writes this shape. |
| `outline.response.schema.json` | What the AI must return for an outline. Sent to OpenAI as a strict structured output. |
| `section.response.schema.json` | What the AI must return for one section (a list of blocks). |
| `example.document.json` | A small valid example, used to build and test templates. |

Content blocks (all have `type`, `text`, `items`):
`paragraph`, `subheading`, `bullets`, `steps`, `checklist`, `tip`, `warning`, `example`, `template`.

Section types per format:
- **ebook**: `intro`, 4–7 × `chapter`, `conclusion` (+ cover and CTA page built from title and `cta`)
- **guide**: `problem`, 3–7 × `step`, `mistakes`, `next_step` (+ CTA box)
- **checklist**: 3–5 × `group`, max 20 items, one page (+ CTA box)

## Prompts (`/prompts`)

| File | Used by | Placeholders |
|---|---|---|
| `outline.ebook.v3.md` (live) | outline step, format = ebook | topic, audience, offer, tone, length, language |
| `outline.guide.v3.md` (live) | outline step, format = guide | same |
| `outline.checklist.v3.md` (live) | outline step, format = checklist | same |
| `outline.*.v1.md`, `outline.*.v2.md` | previous versions, kept for rollback | |
| `section.v2.md` (live) | section step, all formats | same as v1 |
| `section.v1.md` | previous version, kept for rollback | format, title, subtitle, audience, offer, tone, length, language, outline, position, section_type, section_heading, section_goal, section_key_points |

Each file has a header (between `---` lines, for humans), then `===SYSTEM===` (the system message) and `===USER===` (the user message with `{{placeholders}}`). n8n splits on those two markers.

**Versioning rules**
1. Never edit a prompt that is live. Copy it to the next version (`section.v2.md`), change the copy, add a changelog line.
2. Switch n8n to the new filename. To roll back, switch it back.
3. Allowed values: tone = `friendly | professional | bold | inspiring | conversational`, length = `short | standard | detailed`.

**Security rules applied in every prompt**
- User text is wrapped in tags and declared as data, never instructions (prompt-injection defense).
- n8n must replace `<` and `>` in user input before filling placeholders, so a user can't close the tags.
- Outline prompts can return `status: "rejected"` for harmful or non-topics; the frontend shows `reason`.
- No URLs in AI content; the only link in the PDF is the user's CTA URL, which must be `http(s)://`.

## Frontend (`/frontend`)

| File | What it is |
|---|---|
| `widget.html` | **The snippet to paste** into a systeme.io Raw HTML element: the landing page (hero, how it works, what you get, FAQ, closing call to action) around the tool. Generated, don't edit by hand. |
| `page.template.html` | Source of the landing page texts and layout. Edit here, then run `scripts/build_widget.py`. |
| `app.js` | The whole tool: steps, outline editor, parallel section writing (3 at a time), autosave in the browser, live document preview, design step (3 templates, 6 palettes + custom colors, 5 font pairs, logo, brand name, CTA link, A4/Letter) with a live page preview, and PDF export. |
| `app.css` | Styles, all scoped under `.lmg` with a zero-weight `:where()` reset so the page's own CSS can't break the tool. |
| `probe.html` / `probe.js` | One-off page check (scripts, iframe, jsDelivr, fonts, CORS). Not needed in production. |

Options on `<div id="lead-magnet-generator">`: `data-turnstile-sitekey` (Cloudflare Turnstile site key; empty = no human check), `data-api` (n8n webhook base, e.g. `https://n8n.team-sio.com/webhook/lead-magnet`), `data-mock="1"` (fake answers, no AI calls: for demos and tests), `data-concurrency` (sections written at once, default 3), `data-pdf="server"` (one-click download through n8n + Apify; without it, "Download PDF" opens the print window).

Security: every piece of user or AI text is inserted with `textContent`, never as HTML. The only `innerHTML` is for fixed icon SVGs. Logos are re-drawn through a canvas (strips anything hidden in the file) and kept in the browser only. The CTA link must be `http(s)://`. Brand text placed in the PDF footer is escaped as a CSS string.

**How the PDF works:** the document is rendered into a hidden, print-only frame with the browser's native paged media: `@page` size (A4 or Letter), a full-bleed cover (named page with no margins), each ebook chapter on a new page, running footer with brand name and page number, a one-page checklist that scales its text to the number of items. With `data-pdf="server"`, the page sends that same print-ready HTML to n8n `/pdf`, which has the Apify actor print it with headless Chrome and returns the file (a few seconds). If that fails, the page offers "Use the print window", where the user picks "Save as PDF". Colors stay readable for any custom palette: text on colored areas switches between white and dark, and colors too light to read on white are darkened automatically.

**Releasing a new frontend version**
1. Change `frontend/app.js` / `app.css` / `page.template.html`, bump `VERSION` in `app.js`.
2. Commit and push, then run `python3 scripts/build_widget.py <commit-sha>` to regenerate `widget.html` (pinned URLs + integrity hashes). `--local out.html` builds a test page with fake answers.
3. Commit and push, then pin `widget.html` to that commit's full SHA (`@<sha>` in both jsDelivr URLs) and commit again. A commit SHA never changes, so the hashes always match. (This session can't push git tags; a GitHub release tag `vX.Y.Z` can be used instead when created from github.com.)
4. Paste the new `widget.html` into systeme.io and republish. Old pages keep working on their pinned version until then.

## n8n workflows (`/n8n`)

### Live: `lead-magnet-api-workflow.json` (v3.2, protected)

One workflow with four fixed webhook addresses (`/webhook/lead-magnet/outline`, `/section`, `/pass`, `/pdf`) that feed the same protected flow; `/pass` returns a fresh writing pass with no AI call; `/pdf` returns a PDF file. (Not a single `lead-magnet/:action` webhook: n8n puts the webhook ID into addresses with variable parts, so the short address would not match.) It replaces the two older workflows below (kept for reference). Request/response formats are unchanged, with these additions: requests may carry `turnstile` (human-check token) and `pass`; successful outline answers include `pass`.

**Protection (all settings at the top of the Guard node)**
- Allowed pages: `https://sehnounberoual.systeme.io`, `https://systeme.io`, `https://www.systeme.io` (CORS + origin check; requests without a matching Origin are refused).
- Human check: Cloudflare Turnstile, verified server-side (success + hostname). Off while `TURNSTILE_SECRET` is empty.
- Writing pass: HMAC-SHA256 signed, valid 24 h, required to write sections, so bots can't skip the outline step. Expired → the page does one quick check and gets a new pass from `/pass`.
- Limits: 1,000 lead magnets per day overall (UTC), 6 outlines and 80 sections per visitor per hour. Visitors are identified by a hashed IP, never stored in clear. Counters live in the workflow's static data and reset by themselves.
- PDFs: 20 per visitor per hour, 3,000 per day overall. Needs a valid writing pass (or a human check).
- Privacy: successful runs are not saved in Executions; failed runs are kept for debugging.

**`/pdf` step (v3.2)**
- Request: `{ "pass": "...", "html": "<!doctype html>…", "filename": "My title" }`. Response: the PDF file (`application/pdf`, downloaded as `<filename>.pdf`), or the usual JSON error.
- **Validate PDF input** refuses anything that is not the tool's own document: over 4 MB, scripts, frames, forms, `on…=` handlers, meta refresh, or a missing `<main class="lmt …">`. Setting: `APIFY_ACTOR` (`username~lead-magnet-pdf`, shown by the setup workflow below).
- **Apify: make PDF** calls the actor's `run-sync` API (1024 MB, 120 s, 2 retries) with the **Apify account** credential. **Check PDF** makes sure the answer really is a PDF.
- In the actor, the document is printed with scripts blocked by a Content-Security-Policy and every network request blocked except Google Fonts, so a crafted document can't run code or reach other sites. See `apify/lead-magnet-pdf/README.md` for the Apify setup.

### One-time: `apify-setup-workflow.json` (Lead Magnet PDF: one-time Apify setup)

Creates the private actor from this repo through the Apify API with the same **Apify account** credential, builds it, makes one test PDF, and shows the `APIFY_ACTOR` value. No Apify Console access needed. Run it by hand (no need to activate it). It is safe to run again: it reuses the actor and rebuilds it, which is how actor code changes go live. If the build fails, the **Build failed** node shows the end of the build log.

Error codes the page understands: `forbidden_origin` (403), `verify_required` / `verify_failed` (403), `rate_limited` (429), `daily_limit` (503), `invalid_input` (400), `rejected` (200), `generation_failed` (502). For `/pdf`, any error shows the "Use the print window" backup.

### Older (v2): `outline-workflow.json` and `section-workflow.json`

### `outline-workflow.json` — POST `/webhook/lead-magnet/outline`

Request body (JSON):

| Field | Required | Allowed values |
|---|---|---|
| `format` | yes | `ebook`, `guide`, `checklist` |
| `topic` | yes | 3–200 characters |
| `audience` | yes | 3–400 characters |
| `offer` | no (default empty) | 0–300 characters: what the user sells next, e.g. `1:1 coaching`, `$297 course` |
| `tone` | no (default `friendly`) | `friendly`, `professional`, `bold`, `inspiring`, `conversational` |
| `length` | no (default `standard`) | `short`, `standard`, `detailed` |
| `language` | no (default `English`) | a language name, e.g. `French` |

Responses:
- `200 {"ok": true, "document": {...}, "generator": {...}}`: `document` follows `document.schema.json` except `branding`, which the frontend adds. Every section has `status: "outlined"` and empty `blocks`.
- `200 {"ok": false, "code": "rejected", "message": "..."}`: topic refused; show `message` to the user.
- `400 {"ok": false, "code": "invalid_input", "message": "..."}`: show `message` to the user.
- `502 {"ok": false, "code": "generation_failed", "message": "..."}`: ask the user to retry. Details are in n8n **Executions** only.

Settings (model, prompt version, GitHub location) are at the top of the **Validate input** Code node.

### `section-workflow.json` — POST `/webhook/lead-magnet/section`

Writes ONE section. The page calls it once per section (progress bar, single-section regenerate).

Request body (JSON):

| Field | Required | Notes |
|---|---|---|
| `document` | yes | The approved outline as returned by the outline workflow, with any user edits. `blocks` and `branding` are ignored. Re-validated: same limits and section order rules as the outline. |
| `sectionId` | yes | e.g. `s3`, must exist in `document.sections` |

Responses:
- `200 {"ok": true, "sectionId": "s3", "blocks": [...], "generator": {...}}`: put `blocks` into that section and set its `status` to `written`.
- `200 {"ok": false, "code": "rejected", "sectionId": "s3", "message": "..."}`: show `message`; the user can edit the section and retry.
- `400 invalid_input` / `502 generation_failed`: same as the outline workflow; on 502 set the section `status` to `error` and offer a retry.

Output cleaning in **Check section**: links, email addresses and Markdown symbols are removed; list numbering and bullets are stripped (the design adds them); empty or unknown blocks are dropped; a checklist group becomes exactly one checklist block of 3–6 unique items.

## Open follow-ups

- None open. (Fixed in Phase 7: French/other capitalization in outline prompts, safe number cleanup in headings, word counts, ebook intro, checklist item length.)

## Roadmap

- [x] **Phase 1** — repo skeleton, document schema, AI response schemas, v1 prompts
- [x] **Phase 2** — n8n outline workflow (live-tested 2026-10-27: all 3 formats + invalid input, ~4–5 s per outline)
- [x] **Phase 3** — n8n section workflow (end-to-end tested 2026-10-27: ebook 6 sections in 15 s, French guide 8 sections in 17 s, checklist 4 groups in 8 s, 3 sections in parallel, 0 failures)
- [x] **Phase 4** — frontend steps 1–4 (form, outline editor, generation progress) — `v0.1.0`; step 5 shows a plain preview until Phase 5
- [x] **Phase 5** — 3 design templates, live preview, customization — `v0.2.0`
- [x] **Phase 6** — PDF export (print CSS) — `v0.2.0`, built together with Phase 5
- [x] **Phase 7** — hardening: Turnstile, signed writing pass, rate limits, daily cap, origin check, no success logs, prompt fixes (outline v3, section v2) — frontend `v0.3.0`, workflow v3
- [x] **Phase 8** — landing page around the tool, one download button under the preview — frontend `v0.4.0`
- [x] **Last step** — real one-click PDF download through a private Apify actor, print window kept as the backup — frontend `v0.5.0`, workflow v3.2, `apify/lead-magnet-pdf` (live-tested 2026-10-29: French ebook downloaded from the published page in Edge)
