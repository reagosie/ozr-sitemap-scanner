# Sitemap Scanner

Finds every page on a WordPress site, screenshots it at three widths, checks
every link, and flags what actually changed since the last review — so a human
reviews a short list instead of clicking through hundreds of unchanged pages.

Full automation is explicitly not the goal. A person still reviews and signs
off; this makes that review fast and complete.

## Usage

```bash
npm install

npx tsx src/cli.ts scan https://campozark.com --discover-only   # inventory only
npx tsx src/cli.ts scan https://campozark.com --limit 20        # fast loop
npx tsx src/cli.ts scan https://campozark.com                   # full run
npx tsx src/cli.ts serve https://campozark.com                  # view latest report
npx tsx src/cli.ts runs https://campozark.com                   # list runs
npx tsx src/cli.ts diff https://campozark.com --current <id> --baseline <id>
```

The site is an argument, not configuration. WordPress is detected and asserted
at run start.

## Decisions worth knowing

**robots.txt `Crawl-delay: 10` is deliberately not honored.** All six Camp Ozark
properties declare it. Obeying it literally would add over two hours of pure
waiting to a single pass of campozark.com. These are first-party sites, so the
crawler uses a modest configurable concurrency (default 3) instead. The declared
value is recorded in each run's manifest.

**A missing `lastmod` always means "capture".** Yoast stamps `lastmod` on every
URL, but WordPress core sitemaps omit it on taxonomy and user sitemaps — 51 such
URLs on campwareagle.org. The natural form of skip logic, `if (current ===
baseline) skip`, treats `undefined === undefined` as "unchanged" and would drop
those URLs from every run forever. `src/lastmod.ts` is the single place this rule
lives.

**`--changed-only` is a spot-check, never a review.** `lastmod` tracks edits to
one post. It does not move when a theme, global stylesheet, Elementor header or
plugin update changes how every page renders. A CSS regression breaking all ~510
campozark pages moves zero timestamps, so full capture is the default.

**Tier C is link-checked, not screenshotted.** Calendar/event post types,
taxonomy archives and author archives are excluded from capture because they
dominate URL counts (81–84% of all URLs on the two large sites) and churn every
run. They are still link-checked, and still listed in the report. Tiers are
assigned structurally and overridden per site in `scanner.config.json`; run
`scan --discover-only` to see the real per-type breakdown before setting policy.

**The link checker throttles itself hard.** It runs straight after the capture
pass, so the site has already had sustained traffic from us. A first full run of
campozark.com checked 1,876 internal links four at a time and 151 came back 429
-- the checker rate-limited the site, and those URLs were reported "unverified",
which is honest but useless. Internal checking now runs two at a time, honours
`Retry-After`, and backs off up to 30s; the same run then returned zero internal
429s and 147 more confirmed-good links. If a run starts reporting "blocked"
internal links again, lower `concurrency` before trusting the result.

**403 and 429 are reported as "blocked", not "broken".** Cloudflare fronts every
target site and rejects unfamiliar clients. A reviewer who learns to dismiss
false failures stops reading the report at all.

**One desktop user agent at every breakpoint.** Verified: campozark.com and
ozarkleadershipinstitute.com return byte-identical HTML to desktop and iPhone
user agents and do not vary on `User-Agent`. These are responsive-CSS sites with
no separate mobile render, so a single consistent UA keeps runs comparable — and
Cloudflare returns 403 to short or unusual UA strings.

## Capture determinism

The diff is only as trustworthy as the screenshots. Capturing an unchanged page
twice must produce (near-)identical images, or every run buries real problems in
noise. Guarding that:

- animations are collapsed to their final frame rather than disabled outright,
  so Elementor entrance effects do not freeze at `opacity: 0`
- the page is scrolled end to end to trigger lazy images, including WP Rocket's
  lazy CSS background images
- WP Rocket's deferred JavaScript is released with real interaction events
  (`ozarkleadershipinstitute.com`, `onwardlx.com`) or the page never hydrates
- third-party embeds that change every load are blocked at the network layer and
  hidden from layout — see `hide` and `blockUrls` in `scanner.config.json`

Re-running `scan --limit 20` twice against an unchanged site is the regression
test for all of this; the flagged count should be at or near zero.

## Commands worth knowing

`links <site> [runId]` re-runs the link check against an existing run, reusing
its already-captured pages. A full capture pass on campozark.com takes about 70
minutes; re-checking its links takes a few. Use it after changing link-check
settings rather than re-running a whole scan.

`diff <site> --current <id> --baseline <id>` compares two existing runs without
capturing anything, which is how the capture-determinism regression test works.

## Config

`scanner.config.json`, per host:

| key | meaning |
| --- | --- |
| `tiers` | override A/B/C assignment by post type |
| `hide` | selectors removed from layout before measurement (third-party embeds) |
| `mask` | selectors painted over after layout (first-party churn) |
| `blockUrls` | URL fragments blocked during capture |

`hide` and `mask` are not interchangeable. Masking covers changing pixels but
not a changing height; an embed that loads a variable number of items shifts
everything below it, and only removal makes the capture deterministic.

## Run layout

```
runs/<host>/<runId>/
  inventory.json   canonical URL list, tiers, provenance
  captures.json    per-URL screenshot results and extracted links
  links.json       link check results
  diffs.json       per-URL/per-breakpoint comparison against the baseline
  manifest.json    config snapshot, counts, errors
  shots/  diffs/  report/
runs/<host>/baseline.json   points at the run the next one compares against
```

`runs/` is git-ignored.
