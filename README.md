# Sitemap Scanner

Finds every page on a WordPress site, screenshots it at three widths, checks
every link, and flags what actually changed since the last review — so a human
reviews a short list instead of clicking through hundreds of unchanged pages.

Full automation is explicitly not the goal. A person still reviews and signs
off; this makes that review fast and complete.

## Usage

```bash
npm install

npm run where                                   # which store am I pointed at?
npm run scan -- https://campozark.com --discover-only   # inventory only
npm run scan -- https://campozark.com --limit 20        # fast loop
npm run scan -- https://campozark.com                   # full run
npm run serve -- https://campozark.com                  # view latest report
npm run runs -- https://campozark.com                   # list runs

# Re-run one stage against a stored run, without re-capturing
npm run links -- https://campozark.com
npm run proofread -- https://campozark.com
npm run report -- https://campozark.com

npm run dismiss -- https://campozark.com <findingId>    # retire a false positive
npm run migrate -- https://campozark.com                # push local runs to S3
npm run prune -- https://campozark.com --dry-run        # what would the lifecycle rules remove?
```

The site is an argument, not configuration. WordPress is detected and asserted
at run start.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Clean run |
| 2 | The run completed, but the site's sitemap is incomplete |
| 1 | The scan itself failed |

2 is separate from 1 on purpose. campozark declares `ozrsession-sitemap.xml` in
its sitemap index and serves a 404 for it — a real defect, but one that recurs on
every run until someone fixes the site. Exiting 1 for it meant a ninety-minute
successful scan reported as failed, every time, and an exit code that always
fails is one nobody reads.

## Storage

Runs are stored centrally in S3 so the **baseline is shared**. That is the whole
point: the diff is what turns a 524-page review into a 30-page one, and a
baseline sitting on one laptop means everyone else gets 524 "new" pages and no
change signal.

```
s3://tfc-sitemap-scanner/
  data/<host>/
    blobs/<sha256>.png          screenshots, addressed by content
    <runId>/                    inventory, captures, diffs, links, copy, report
    baseline.json               what the next run compares against
    copy-accepted.json          dismissed proofreading findings
  reports/<host>/<runId>/       emailable HTML + PDF
```

**Screenshots are addressed by the SHA-256 of their bytes, not by run.** An
unchanged page hashes the same every time, so it uploads once and is shared by
every run that references it. Two consequences, both large:

- A repeat scan uploads almost nothing. Measured on 45 campozark pages: 36 of 45
  blobs already existed, so only 9 were sent.
- **The diff for an unchanged page transfers zero bytes.** Equal hashes prove the
  images are identical, so no download and no pixel comparison happens. Without
  this, every scan would pull the entire 4.4 GB baseline back down — by far the
  biggest cost in the whole pipeline.

Pruning is therefore garbage collection, not deletion: removing a run does not
free its images, because a surviving run may still reference them. Blobs are
collected only when nothing points at them **and** they are over 7 days old, so a
concurrent scan cannot have its freshly uploaded screenshots deleted before its
`captures.json` lands.

### Running without AWS

`storage.backend` defaults to `auto`: S3 when a bucket resolves, the local
filesystem otherwise. Everything works either way — you just lose the shared
baseline. Set `SITEMAP_SCANNER_BUCKET` to override the configured bucket without
editing a committed file.

Teammates need credentials in AWS account `117225656269`. `docs/iam-policy.json`
grants exactly what the tool uses and nothing else; attach it to a group and add
users to it.

### Moving existing runs in

`npm run migrate -- <site>` uploads local runs, re-keying every screenshot by
content hash on the way, sets the baseline pointer, and builds reports for what
it moved. By default it migrates only the run the baseline points at — pass
`--all` for every local run.

Migrate rather than starting fresh when a baseline is worth keeping: without it,
the next scan reports every page as new and gives you no change signal, which
costs a whole review cycle.

Note that a run captured before proofreading existed carries no page text, so
`proofread` will refuse it and say so. Screenshots cannot be un-read into words
— only a fresh scan collects copy.

### Reports

Every run produces three things:

| File | Where | For |
| --- | --- | --- |
| `report.html` | `data/` | The interactive worklist — filter, sort, "flagged only". Needs `npm run serve`. |
| `audit-<host>-<date>.html` | `reports/` | Self-contained. Email it. Opens with no AWS account and no tool. |
| `audit-<host>-<date>.pdf` | `reports/` | Findings only, for people who just want to read it. |

The emailable HTML embeds before/after/diff thumbnails for the pages that
actually changed, and links the rest via presigned URLs. It cannot embed
everything: desktop screenshots average 3.5 MB, so even shrinking 524 pages
twelvefold lands at 63 MB. **Presigned links expire after 7 days** — AWS's hard
ceiling for IAM-user signatures. The embedded thumbnails never expire; re-run
`npm run report` to mint fresh links.

`npm run serve` streams screenshots from S3 through localhost using your own
credentials, which is how the bucket stays private — nothing is ever made public
and no long-lived URLs are minted.

## Proofreading

Every scan also reads the words. It uses **local libraries only — no API, no
cost, no key** — so the tool still runs anywhere with just Node.

| Check | Catches |
| --- | --- |
| retext | Doubled words, "a apple", quote and spacing slips |
| nspell + site dictionary | Misspellings |
| LanguageTool (optional) | ~5,000 grammar rules: agreement, their/there, tense |
| Frequency analysis | Brand and name spellings that disagree across pages |
| Date scan | Past years in copy that reads as upcoming |

Text is collected during the capture pass — no extra page loads — at the widest
breakpoint only, since responsive CSS moves words but does not rewrite them.

**Findings are deduplicated by text, not by page.** A typo in the global footer
is one finding listed against 157 pages, never 157 findings.

### Why it isn't a spellchecker

A stock dictionary flags "Ozark", "Mena", "Gaga" and every staff surname. A
report like that gets ignored once and never opened again, which is the same
failure that makes 403-as-broken unacceptable in the link checker. Four rules do
the work:

- **The corpus is the dictionary.** A word on ≥5 distinct pages was written
  deliberately, whatever Hunspell thinks. The threshold scales down on small
  sites, where "5 pages" would mean "most of the site".
- **Capitalized mid-sentence means it is a name.** On staff bios this alone
  removed twelve of seventeen "high confidence" findings — Hoercher, Baggett,
  Weatherford, each helpfully offered a real word one edit away.
- **Capitalized *everywhere* means it is a name.** Catches the ones that only
  ever appear at the start of a list item, where the rule above cannot see them.
  Prose would have written "ouachita" in lower case somewhere; a name never does.
- **Emails and URLs are not prose.** Without masking them, a staff directory
  turns the spelling section into a list of email local parts.

Measured on 45 campozark pages (53,582 words): these took the findings from 49 to
6, of which 4 were real — including two different stale copyright years across 45
pages and a genuine `"is is"`.

### Naming consistency

Counting capitalized phrases across every page finds spellings that disagree —
"Camp Ozark" ×400 against "camp ozark" ×2. This is the one check a human
structurally cannot do, because reading one page at a time both look fine.

Two exclusions matter. A phrase only counts as a name if some word in it is
*not* in the dictionary, or "Learn More" vs "LEARN MORE" swamps everything. And
ALL CAPS is ignored entirely: `innerText` reflects CSS `text-transform`, so an
uppercased button arrives looking like someone typed it that way, and chasing it
sends a reviewer hunting for a text change that lives in a stylesheet.

### Stale dates

Reports **candidates, not defects**. Whether "Summer 2024" is stale or an
accurate historical reference depends on what the page is for, which no rule
knows. So it surfaces past-year mentions that read as forward-looking, skips
anything near a biography or history verb ("graduated in 2010" is correct
forever), and hands over a short ranked list. Copyright years are the exception —
those are unambiguous.

### LanguageTool

Optional and auto-detected. If Docker is present the container starts on demand;
if not, the check is skipped and the report says so. Its own spellchecker is
disabled — it does not know this site, and `spelling.ts` does.

It earns its keep on things rules cannot reach. On the first foundation run it
found *"Sunday, December 7th"* — and noted that December 7th, 2026 is a Monday.

### False positives

`npm run dismiss -- <site> <findingId>` retires one for good. Ids are stable
across runs, and the list lives beside the baseline so it is shared by everyone.
Without this the same wrong answers come back every cycle and the section stops
being read.

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

## Retention

The scanner enforces its own lifecycle. There is **no S3 lifecycle policy to
configure** -- the rules live in the code, travel with it to any bucket the tool
is pointed at, and work identically against a local `runs/` directory that AWS
could never manage.

Two independent rules, applied at the end of every scan and by `prune`:

| rule | default | why |
| --- | --- | --- |
| `retainRuns` | 5 newest runs per host | caps a busy site |
| `retainDays` | runs older than 365 days | caps a quiet one -- at 2-3 scans a year, five runs is two and a half years of screenshots nobody will open |

Removing a run removes its metadata **and its emailable reports**. Screenshots
are the exception, and this is the part worth understanding: they are addressed
by content and shared across runs, so a blob is never deleted for being old. A
screenshot uploaded two years ago is still the current image of every page that
has not changed since. Blobs leave only by becoming unreferenced by any
surviving run, and then only after a 7-day grace period so a concurrent scan
cannot have its fresh uploads collected before its `captures.json` lands.

**The baseline is never pruned**, by either rule. Deleting it is the one
expensive mistake available here: the next scan would have nothing to compare
against, call all ~525 pages new, and hand back a report with no change signal
at all. If a rule would have taken it, the run says so instead.

```bash
npm run prune -- https://campozark.com --dry-run     # list, remove nothing
npm run prune -- https://campozark.com               # apply
npm run runs -- https://campozark.com                # age and fate of each run
```

## Progress

Long stages print a live progress line with a percentage and an ETA:

```
  capture desktop (1440px)  [############..........]  56%  129/230  eta 12:41  (41:07 elapsed)
```

When stdout is not a terminal -- a background task, CI, a pipe -- carriage
returns would produce garbage, so the same line is printed every 20 seconds
instead. Set `SITEMAP_SCANNER_PLAIN=1` to force that mode on a real terminal.

## Commands worth knowing

`links <site> [runId]` re-runs the link check against an existing run, reusing
its already-captured pages. A full capture pass on campozark.com takes about 70
minutes; re-checking its links takes a few. Use it after changing link-check
settings rather than re-running a whole scan.

`diff <site> --current <id> --baseline <id>` compares two existing runs without
capturing anything, which is how the capture-determinism regression test works.

`prune <site> [--keep n] [--max-age-days n] [--dry-run]` applies the retention
rules without running a scan. `--dry-run` is the way to see what a scan is about
to delete before it deletes it.

## Config

`scanner.config.json`, per host:

Top level:

| key | meaning |
| --- | --- |
| `storage.backend` | `auto` (default), `local`, or `s3` |
| `storage.bucket` | overridden by `SITEMAP_SCANNER_BUCKET` |
| `proofread.siteWordMinPages` | pages a word must appear on to count as site vocabulary |
| `proofread.glossary` | words the spellchecker must never flag |
| `proofread.languageTool` | use LanguageTool when Docker is available |
| `retainRuns` | runs kept per host before pruning and blob GC (default 5) |
| `retainDays` | age at which a run is removed regardless of the count (default 365) |

Per host, under `sites`:

| key | meaning |
| --- | --- |
| `tiers` | override A/B/C assignment by post type |
| `hide` | selectors removed from layout before measurement (third-party embeds) |
| `mask` | selectors painted over after layout (first-party churn) |
| `blockUrls` | URL fragments blocked during capture |
| `glossary` | site-specific proper nouns |
| `canonicalNames` | the spelling a name *should* have, so variants are reported against it rather than against whichever form happens to be commonest |

`hide` and `mask` are not interchangeable. Masking covers changing pixels but
not a changing height; an embed that loads a variable number of items shifts
everything below it, and only removal makes the capture deterministic.

## Run layout

Identical keys on both backends — S3 under `data/`, and on disk under `runs/`:

```
<host>/<runId>/
  inventory.json   canonical URL list, tiers, provenance
  captures.json    per-URL screenshot hashes and extracted links
  links.json       link check results
  diffs.json       per-URL/per-breakpoint comparison against the baseline
  copy.json        proofreading findings
  manifest.json    config snapshot, counts, errors
  report.html      the interactive report
<host>/blobs/<sha256>.png    every screenshot and diff overlay, shared across runs
<host>/baseline.json         points at the run the next one compares against
<host>/copy-accepted.json    dismissed copy findings
```

`runs/` is git-ignored.
