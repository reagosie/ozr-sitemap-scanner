# WordPress Site Review Automation — Project Plan

## Background

Camp Ozark reviews all WordPress pages 2–3 times a year to catch broken links, layout issues, and rendering problems across screen sizes. Today this is done manually: clicking through every page, checking every link by hand, and eyeballing layout at different widths. Two failure modes drive this project:

1. **Missed pages** — the reviewer works from an ad hoc list and some pages get skipped.
2. **Slow, low-signal review time** — most pages haven't changed since the last review, but the reviewer has to look at everything with equal effort anyway.

## Goal

Build a tool that automates everything mechanical (finding every page, checking every link, capturing every screenshot, and flagging what's actually different) so a human only has to look at a short, prioritized list of real issues — not scroll through hundreds of unchanged pages.

**Explicitly not a goal:** full automation. A human still reviews and signs off. The tool's job is to make that review fast and complete, not to replace it.

## Why not a single giant PDF

Early idea was rendering every page/breakpoint into one huge PDF to scroll through. Rejected because:
- Doesn't fix the actual root cause (an incomplete page list).
- Link-checking inside a PDF is still manual — a human has to notice if a link is broken, rather than a tool verifying the HTTP response.
- No search, no filtering, no way to jump to a specific page.
- Every review looks at 100% of pages with equal effort, even ones that haven't changed.
- File size balloons fast with multiple breakpoints × many pages.

## Architecture — 5 components

### 1. Page inventory
Build the definitive list of URLs to check. Don't rely on `sitemap.xml` alone — it can silently omit noindexed, unpublished-to-nav, or orphaned pages.
- Pull `sitemap.xml`.
- Cross-check against the WordPress REST API (`/wp-json/wp/v2/pages`, plus any custom post types in use) or a direct DB/admin export.
- Reconcile the two lists; flag any URL in one list but not the other for a one-time manual check (this is where "missed pages" gets solved permanently).
- Output: a canonical `urls.json` used by every later step.

### 2. Automated link checking
Fully automatable — no human judgment needed.
- Crawl every URL from step 1, follow every internal and external link, record HTTP status codes, redirects, and timeouts.
- Options: Playwright/`broken-link-checker` script (full control, free, no URL cap) or Screaming Frog (GUI, free tier caps at 500 URLs — check whether the site is under that).
- Output: a report of broken/redirected links only — nothing to review if it's empty.

### 3. Screenshot capture
- Use Playwright to visit every URL at a defined set of breakpoints (e.g., mobile ~390px, tablet ~768px, desktop ~1440px — confirm actual widths against current design breakpoints).
- Full-page screenshots, stored on disk with a naming convention like `{url-slug}__{breakpoint}.png`.
- Keep this run's screenshots alongside the previous run's for diffing (step 4).

### 4. Visual diffing against the last run
This is the main time-saver.
- Pixel-diff each new screenshot against the equivalent screenshot from the last review cycle (Playwright's built-in screenshot comparison, or a library like `pixelmatch`/BackstopJS).
- Flag pages/breakpoints with diffs above a noise threshold (to avoid flagging trivial anti-aliasing/timestamp differences).
- Unflagged pages = no visual change since last review = nothing a human needs to look at.

### 5. Report generation
- Single HTML report (not a PDF): one row per URL, showing:
  - Link-check status (pass/fail, with details on fail)
  - Visual diff status per breakpoint (unchanged / flagged, with side-by-side old vs. new thumbnail on flagged rows)
  - Link to the live page for anything flagged
- Sortable/filterable so the reviewer can filter to "flagged only."
- This is the artifact the human actually works from.

## Data persistence between runs

Screenshots and the URL inventory from each run need to persist somewhere so the next run (in ~4 months) can diff against them. Options: a folder in the project repo (fine if the image set isn't huge), S3 (already in use at Camp Ozark per existing AWS footprint), or a dedicated storage bucket. This should be decided early since it affects the diffing step's design.

## Suggested tech stack

- **Language:** Node.js or Python — either works fine with Playwright; pick whichever the team is more comfortable maintaining.
- **Crawling/screenshots:** Playwright
- **Link checking:** Playwright-based crawl (reuse the same crawl for both) or a dedicated link-checker library
- **Diffing:** Playwright's built-in screenshot comparison, or `pixelmatch`
- **Report:** static HTML file (no server needed) generated from a template
- **Storage:** TBD — repo folder vs. S3 (see above)

## Scheduling / triggering

Since this only needs to run 2–3x/year, a manual trigger is fine to start (run locally or via a one-off script). If it proves useful, a scheduled GitHub Action (e.g., quarterly cron) could run it automatically and open a summary as an issue or Basecamp post.

## Open questions to settle before/during build

- Exact breakpoints to test (match current CSS breakpoints, not arbitrary widths)
- Diff sensitivity threshold (how much pixel difference counts as "flagged" vs. noise)
- Where run history/screenshots get stored long-term
- Whether external links should be checked too, or only internal ones (external link checks are slower and can produce false positives from bot-blocking)
- Any pages behind auth (parent portal, etc.) that need login handling before crawling

## Success criteria

- Every published page/post type is accounted for automatically (no manual list-building).
- Broken links are caught with zero manual clicking.
- A reviewer can complete a full site review by looking only at flagged rows in the report, not every page.
- The whole pipeline (crawl → screenshot → diff → report) runs as a single command.
