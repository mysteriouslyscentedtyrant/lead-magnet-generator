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
   ▼  6. "Download PDF" → browser print dialog → Save as PDF
```

The OpenAI API key exists **only** inside n8n credentials. The frontend never sees it.

## Repo structure

```
/frontend      Raw HTML snippet for systeme.io + app.js / app.css (loaded via jsDelivr)   (Phase 4)
/templates     HTML/CSS design templates, shared by the live preview and the PDF        (Phase 5)
/prompts       Versioned AI prompts, fetched by n8n at runtime
/schema        JSON schemas: the shared document shape + the AI response formats
/n8n           Importable n8n workflow JSON files                                       (Phases 2-3)
```

## Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-10-27 | PDF via browser print-to-PDF (option A). | Free, no infrastructure, vector text. Same HTML templates can move to Gotenberg or a paid API later. |
| 2026-10-27 | One AI call per section, not one call for the whole document. | Avoids webhook timeouts, gives real progress, allows regenerating one section. |
| 2026-10-27 | AI content is plain-text blocks, never HTML/Markdown. | Templates escape everything, so neither users nor the AI can inject scripts or links. |
| 2026-10-27 | AI model chosen in n8n, not in prompts. | Swap models without touching prompt files. Start with a low-cost model and upgrade if quality needs it. |
| 2026-10-27 | Optional `offer` input (outline prompts v2). | Live test showed CTAs guessing the offer (e.g. an invented webinar) and titles restating the topic. |
| 2026-10-27 | Repo is public. | n8n reads prompts with no token; jsDelivr can serve the frontend for free. No secrets live in the repo. |
| 2026-10-27 | OpenAI called with the HTTP Request node (OpenAI credential), not the OpenAI node. | Full control of strict JSON-schema output, independent of n8n node versions. Starting model: `gpt-4.1-mini`. |

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
| `outline.ebook.v2.md` (live) | outline workflow, format = ebook | topic, audience, offer, tone, length, language |
| `outline.guide.v2.md` (live) | outline workflow, format = guide | same |
| `outline.checklist.v2.md` (live) | outline workflow, format = checklist | same |
| `outline.*.v1.md` | previous version, kept for rollback | topic, audience, tone, length, language |
| `section.v1.md` | section workflow, all formats | format, title, subtitle, audience, tone, length, language, outline, position, section_type, section_heading, section_goal, section_key_points |

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

## n8n workflows (`/n8n`)

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

## Roadmap

- [x] **Phase 1** — repo skeleton, document schema, AI response schemas, v1 prompts
- [x] **Phase 2** — n8n outline workflow (live-tested 2026-10-27: all 3 formats + invalid input, ~4–5 s per outline)
- [ ] **Phase 3** — n8n section workflow
- [ ] **Phase 4** — frontend steps 1–4 (form, outline editor, generation progress)
- [ ] **Phase 5** — 3 design templates, live preview, customization
- [ ] **Phase 6** — PDF export (print CSS)
- [ ] **Phase 7** — hardening: Turnstile, rate limit, origin check, error states, mobile pass
