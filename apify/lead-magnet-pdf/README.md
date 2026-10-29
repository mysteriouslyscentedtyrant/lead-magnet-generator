# Lead Magnet PDF (private Apify actor)

Turns the print-ready HTML document of the Lead Magnet Generator into a PDF with headless Chrome,
so visitors get a real one-click download. Called by the n8n workflow *Lead Magnet API* (`/pdf` step).

- **Input:** `{ "html": "<!doctype html>…" }` (max 5 MB)
- **Output:** the PDF, stored as the run's `OUTPUT` record (returned directly by the `run-sync` API).
- **Safety:** scripts are forbidden by a Content-Security-Policy and all network requests are blocked
  except Google Fonts and embedded `data:` images. Nothing is fetched from other sites.
- **Resources:** 1024 MB memory, a few seconds per PDF.

## Setup option 1: from n8n (recommended, no Apify Console access needed)

Import `n8n/apify-setup-workflow.json`, select the **Apify account** credential in its 7 Apify nodes and click
**Execute workflow**. It creates this actor (private, 1024 MB, 120 s), builds it, makes a test PDF and shows the
`APIFY_ACTOR` value for the main workflow. Run it again to rebuild after code changes.

## Setup option 2: Apify Console (about 10 minutes)

1. **Actors → Development → Develop new → Link Git repository** (or create any actor and open its **Source** tab).
2. **Source type:** Git repository. **Git URL:**
   `https://github.com/mysteriouslyscentedtyrant/lead-magnet-generator#main:apify/lead-magnet-pdf`
3. **Settings:** name `lead-magnet-pdf`, keep it **private**. Default memory **1024 MB**, timeout **120 s**.
4. Click **Build**. The first build takes a few minutes.
5. **Test:** open the **Input** tab (a test document is prefilled), click **Start**, then open
   **Storage → Key-value store → OUTPUT**: you should see a one-page PDF.
6. Copy the actor's full name (e.g. `your-username/lead-magnet-pdf`) for the n8n setting `APIFY_ACTOR`
   (written with `~` instead of `/`: `your-username~lead-magnet-pdf`).
7. Optional: **Settings → Usage & billing → Limits**, set a monthly usage limit.
