# Sitemap Scanner — original build plan

> Archived. This is the plan the tool was first built from, kept because its
> reconnaissance section is expensive to reproduce (it required probing six
> production sites) and because several non-obvious decisions in the code only
> make sense against it. The later S3 + proofreading work is described in
> `docs/plan-s3-proofreading.md`.

## Context

Camp Ozark reviews all website pages 2–3 times a year to catch broken links,
layout breakage, and rendering problems across screen sizes. Today that's
manual: click every page, check every link by hand, eyeball layout at different
widths. Two failure modes drive this project:

1. **Missed pages** — the reviewer works from an ad hoc list, and pages get skipped.
2. **Low-signal review time** — most pages haven't changed since the last review,
   but every page gets equal effort anyway.

The goal is to automate everything mechanical — find every page, check every
link, capture every screenshot, flag what actually changed — so a human reviews
a short prioritized list instead of hundreds of unchanged pages. **Full
automation is explicitly not the goal.** A human still reviews and signs off;
the tool makes that review fast and complete.

## Reconnaissance findings (all six sites, verified 2026-09)

| Site | Sitemap flavor | Sub-maps | Total URLs | Dominant churn | Est. capture set |
|---|---|---|---|---|---|
| campozark.com | Yoast | 29 | 797 | 207 `tec_recurring_events` | ~510 |
| campotx.com | Yoast | 25 | **1,656** | 780 `tribe_events`, 384 `streamitem`, 140 `ozrday`, 90 `ozrsession` | ~230 |
| campwareagle.org | **WP core** | 28 | **2,024** | 1,455 `tribe_events`, 176 `tribe_venue` | ~330 |
| onwardlx.com | Yoast | 8 | 48 | none | ~44 |
| ozarkleadershipinstitute.com | Yoast | 8 | 31 | none | ~27 |
| campozarkfoundation.org | Yoast | 5 | 23 | none | ~19 |

**Uniform across all six:** WordPress on WP Engine, behind Cloudflare, built with
Elementor, `Crawl-delay: 10` in robots.txt, and an open `/wp-json/wp/v2/types`
REST API.

That uniformity is the single most useful result: **the WordPress adapter is the
only adapter that needs building.** CMS detection stays in as a guard that fails
loudly on a non-WordPress target, not as the entry point to a multi-CMS
framework.

### Constraints this uncovered

1. **Two sitemap conventions, not one.** campwareagle.org serves **WP core
   sitemaps** (`wp-sitemap.xml` → `wp-sitemap-posts-<type>-N.xml`,
   `wp-sitemap-taxonomies-<tax>-N.xml`, `wp-sitemap-users-N.xml`); the other five
   serve **Yoast** (`sitemap_index.xml` → `<type>-sitemap.xml`). Post type is
   encoded differently in each. Core sitemaps are also **paginated** at 2,000
   entries — `tribe_events` is already at 1,455, so page 2 is a live near-term
   risk. Walking the index handles it as long as the parser doesn't assume `-1`.

2. **`lastmod` is not universal.** Yoast stamps it on every URL (1,656/1,656 on
   campotx). WP core omits it on **taxonomy and user sitemaps** — verified 0 of
   51 such URLs on campwareagle. The hazard is the natural form of skip logic:
   `if (url.lastmod === baseline.lastmod) skip` evaluates
   `undefined === undefined` as true, so those 51 URLs would be skipped on
   *every* run, forever — silently absent from review. That is the missed-pages
   failure mode reintroduced by the optimization meant to save time.
   **Rule: a missing `lastmod` means always capture.** It lives in one place,
   `src/lastmod.ts`.

   Separately, and applying even where `lastmod` *is* present: it tracks content
   edits to a single post only. It does not move for theme/global-CSS changes,
   Elementor global header/footer/template edits, plugin updates that alter
   rendering, or dynamically pulled content. A CSS regression breaking the header
   on all ~510 campozark pages moves zero timestamps. It also errs the other way
   — some setups bump it on any save, and bulk operations touch many posts at
   once. `lastmod` is therefore a good **prioritization signal** and a poor
   **change oracle**, which is why full capture is the default and
   `--changed-only` is a spot-check only.

3. **Churn type names are site-specific.** The actual churn types are
   `tribe_events`, `tribe_venue`, `tribe_organizer`, `tribe_event_series`,
   `streamitem`, `ozrday`, `ozrsession` — varying per site. On the two large
   sites, events are **81–84% of all URLs**. A hardcoded exclusion list would be
   wrong on every site, which is why `src/discover/classify.ts` tiers
   structurally and treats name lists as overridable defaults.

4. **WP Rocket delays JavaScript on two sites.** ozarkleadershipinstitute.com and
   onwardlx.com run WP Rocket with `wpr_delay_js`, which defers JS execution
   until a real user interaction, plus `wpr_lazyload_css_bg_img`. A headless
   visit that never interacts can capture an unhydrated page — hence the
   interaction-event dispatch in `src/capture/screenshot.ts`.

5. **Scale range is 88×** — 23 URLs to 2,024. The tool must not feel heavyweight
   on a 23-URL site.

6. **"Internal-looking" CPTs are real pages.** Sampled `cards`, `streamitem`,
   `pcomponent`, `olifaqs`, `quicklinks`, and `tribe_venue` URLs all render as
   complete pages with header, nav, and footer — not fragments. They are
   legitimately reviewable, just low-value in bulk. So they get **tiered, not
   hidden**.

## Capture tiering

Type names vary per site, so the tool **discovers and reports the type breakdown
first, then applies policy**:

- **Tier A — capture by default:** `page`, `post`, and primary content CPTs.
- **Tier B — capture, ranked lower:** thin or auxiliary CPTs (`cards`,
  `pcomponent`, `olifaqs`, `quicklinks`, `testimonials`).
- **Tier C — link-check only, no capture:** calendar/event churn (`tribe_*`,
  `tec_*`, `streamitem`, `ozrday`, `ozrsession`), taxonomy term archives, and
  author/user archives.

Tier C defaults come from **structural heuristics**, not a name list: anything
from a `wp-sitemap-taxonomies-*` or `wp-sitemap-users-*` sitemap, anything
matching a known calendar-plugin prefix, and (Yoast) any sitemap whose type
matches a registered taxonomy rather than a post type. Every assignment is
overridable in `scanner.config.json`, and `scan --discover-only` prints the full
per-type table so a new site's policy is set from real numbers.

**Everything not captured is still link-checked**, so nothing is invisible.

## Decisions settled with the user

- **Stack:** Node.js + TypeScript, ESM/NodeNext, `tsx` in dev.
- **Target site:** CLI argument per scan; WordPress asserted at run start.
- **Breakpoints:** 390 / 768 / 1440.
- **Auth:** public pages only; documented seam, no implementation.
- **External links:** checked, reported separately from internal.
- **Rate limiting:** ~3 concurrent, configurable. The declared `Crawl-delay: 10`
  is deliberately not honored (first-party sites; obeying it would add 2+ hours
  of pure waiting to a full pass).
- **Images:** PNG — Playwright-native, exact diffing, no conversion step.
- **Report:** static HTML plus a local preview server, so full-size PNGs load lazily.

## What the first full campozark run found

Evidence that the approach works, and the reason several thresholds are set
where they are:

- `/terms` returning 404/504 from the **global footer on 157 pages**
- `/pdfprinter/` HTTP 500 at all breakpoints
- Dead Apple (`/sn/` Senegal storefront) and Google Play links on 27 pages
- Two email addresses entered as relative paths instead of `mailto:`
- Two missing PDFs (job application, special events); an `/activites/` typo
- 39 Events Calendar recurring-date 404s
- `ozrsession-sitemap.xml` declared in the index but returning 404
- **16 published pages missing from the sitemap**, including `/careers/`
- 8 post types published but entirely absent from the sitemap

On campozarkfoundation.org: a YouTube link with an invisible Unicode
`%E2%80%A9` appended on 19 pages, five dead ozoneministries.com links, a 404 to
ozarkleadershipinstitute.com, and `http://donateoli/` (an invalid host).

## Capture determinism — the hard part

Getting a full-page screenshot to be byte-stable across runs took the most
iteration. Measured on the same 20 pages, captured twice:

| Change | Pages self-diffing /20 |
|---|---|
| Baseline | 19 |
| Hide `.instagram-gallery-feed` | 1–4 |
| + `loading='eager'` + event wait | 11 (worse) |
| + poll all-images-complete | 10 (worse) |
| + stability signature (2×300ms) | 7 |
| + stability (3×400ms) | 6 |
| + Node-driven scroll w/ per-step networkidle | 2 (clean median 0.0001%) |
| + straggler image repair | 2 (clean median **0.0000%**, max 0.0039%) |
| + re-capture confirmation pass | 5→3 |

Root causes found: a footer Instagram feed serving different reels per load, and
lazy-image races under concurrency. A probe proved content is **not** randomized
(3 serial loads → identical image sets, 28/28 complete), so the residual is
bandwidth contention — which is why the confirmation pass re-shoots flagged
pages **serially** rather than making every capture slower.

**Known limitation:** the race can corrupt a *baseline*, which cannot be
re-captured after the fact. It self-heals as each run's serial re-capture becomes
the next baseline.
