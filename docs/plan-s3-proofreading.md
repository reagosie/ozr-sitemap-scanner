# Sitemap Scanner — S3 storage + copy proofreading

> Archived. The plan this work was built from, kept for the reasoning behind the
> storage layout and the proofreading design. See `docs/plan.md` for the original
> build.

## Context

Two changes to a tool that already works end to end.

**1. Storage is trapped on one laptop.** Everything the scanner produces lives in
`runs/`: 4.65 GB across four hosts today, growing ~4.5 GB per campozark scan.
Three consequences: the **baseline is unshareable**, so a teammate running the
tool gets 524 "new" pages and no change signal — losing the one feature that
turns a 524-page review into a 30-page one; **results can't be handed off**,
though the person who fixes the site isn't the person who runs the scan; and
nothing survives the laptop.

**2. Nobody is checking the copy.** The tool finds broken links and visual
changes but never reads the words. On a site reviewed 2–3×/year, typos and stale
dates ("Register for Summer 2024") persist for months.

**Not goals:** a hosted web app, public URLs, or CloudFront. Reports are files
that get emailed. And the tool must run anywhere with only Node — no mandatory
external service, no per-run API spend.

## Settled with user

| Decision | Choice |
|---|---|
| Bucket | `tfc-sitemap-scanner`, us-east-2, private, all public access blocked (verified available) |
| Layout | One bucket, two prefixes: `data/` and `reports/` |
| Report formats | Self-contained HTML **and** findings-only PDF, both written to `reports/` |
| HTML contents | Flagged pages embedded as before/after/diff thumbnails; other pages via presigned URLs (7-day expiry) |
| Existing runs | Migrate the 4 baselines only, via a `migrate` command run on demand |
| Team access | Others already have IAM users in account 117225656269 — ship a scoped policy, create no IAM resources |
| Proofreading engine | **Local libraries only, no LLM** — subscription does not cover API calls, and the tool must be self-contained |
| LanguageTool | Docker, auto-started **when present**; skipped with a report note when absent |
| Proofread runs | Every scan; `--no-proofread` to skip |
| Categories | Spelling, grammar, doubled words/punctuation, brand consistency, stale dates |
| Findings layout | Own report section, grouped by distinct text with the pages it appears on |

---

# Part 1 — S3 storage

## Layout

```
s3://tfc-sitemap-scanner/
  data/<host>/
    blobs/<sha256>.png              # content-addressed; shared across ALL runs
    runs/<runId>/
      manifest.json  inventory.json  captures.json  diffs.json
      links.json     copy.json
      report.html
    baseline.json                   # pointer, written conditionally
    copy-accepted.json              # dismissed proofreading findings, persists across runs
    lock.json                       # advisory run lock, TTL'd
  reports/<host>/<runId>/
    audit-<host>-<date>.html        # emailable, ~14 MB
    audit-<host>-<date>.pdf         # emailable, ~300 KB
```

## Why content-addressed, not a folder per run

The decision the whole design turns on. Screenshots are keyed by SHA-256 of
their bytes rather than `<runId>/shots/<slug>__<bp>.png`.

A full copy per run means **every scan downloads the entire 4.4 GB baseline** to
diff against — the dominant cost and the dominant wait, far more than upload.
Content addressing removes it:

- **Upload:** an unchanged page hashes the same, so `HeadObject` finds the blob
  and skips the PUT. Run 1 pushes 4.4 GB; run 2 pushes only what moved.
- **Diff:** equal hashes mean byte-identical files. Compare hashes from
  `captures.json` and download *nothing* for unchanged pages. Only differing
  hashes get fetched and run through pixelmatch.
- **Storage:** 5 retained runs share blobs instead of 22 GB of near-copies.

The hash shortcut also speeds up **local** mode — pixelmatch on ~1,500 identical
PNG pairs is pure wasted CPU today.

Cost: pruning becomes garbage collection. `pruneRuns` unions the hashes
referenced by surviving runs and deletes unreferenced blobs, with a 7-day minimum
age so a concurrent scan can't have fresh blobs collected before its
`captures.json` lands.

## Files

**New:** `src/store/backend.ts` (the `StorageBackend` interface — `putBuffer`,
`getBuffer`, `putJson`, `getJson`, `exists`, `list`, `remove`, `presign`),
`src/store/local.ts`, `src/store/s3.ts`, `src/report/emailable.ts`,
`docs/iam-policy.json`, `docs/plan.md` (the original build plan, preserved).

**Rewritten:** `src/store/runs.ts` → key builders over a backend. Keeps
`hostDir`, `newRunId`, and existing baseline/prune semantics including "never
prune the baseline".

**Touched at existing seams:**
- `src/capture/screenshot.ts` — `page.screenshot()` returns a Buffer instead of
  writing to `path`. The capture sequence itself is untouched: freeze CSS,
  Node-driven scroll, straggler repair, and the stability signature all stay.
- `src/capture/run.ts` — hash the buffer, upload if absent, record the hash
- `src/diff/compare.ts` — accept Buffers; hash-equality fast path before decoding
- `src/diff/run.ts` — skip the download entirely when hashes match
- `src/cli.ts` — six `runPaths()` call sites become key builders; add `migrate`
- `src/report/build.ts`, `src/report/serve.ts`, `src/config.ts`

**Reused as-is:** `slugForUrl` (still the readable half of a blob's identity in
`captures.json`, and the local backend still needs its MAX_PATH truncation),
`canonicalizeUrl`, `isInternal`, `lastmod.ts`, `classify.ts`, and the whole
discover pipeline.

## Emailable report

Generated in one Chromium launch after the S3 report:

- **HTML** — findings as text; flagged pages get before/after/diff at 600px wide,
  WebP q75, capped at 40 pages; every other page gets a presigned link.
  Measured basis: desktop shots are 1440×4300–5700px, avg 3.5 MB, so embedding
  all of them is impossible at any quality — 524 pages shrunk 12× is still 63 MB.
- **PDF** — findings only, via `page.pdf()`.

Thumbnails are downscaled **in Chromium via canvas `toDataURL('image/webp')`**,
not `sharp`. Chromium is already a dependency and already being launched for the
PDF; adding a native module with Windows build risk for ~120 images is a bad trade.

## Concurrency

- `baseline.json` written with a conditional PUT (`If-Match` on ETag); a lost
  race is reported, not silently overwritten
- `lock.json` written with `If-None-Match`, carrying a timestamp and TTL —
  advisory, overridable with `--force`

---

# Part 2 — Copy proofreading

## Engine: local libraries, no LLM

A Claude subscription does not cover API calls made from your own code — that is
metered separately through console.anthropic.com. Combined with the requirement
that this run anywhere self-contained, the proofreader is built entirely from
local libraries. All verified current on npm:

| Layer | Packages | Catches |
|---|---|---|
| Mechanical | `retext` 9, `retext-repeated-words` 5, `retext-indefinite-article` 5, `retext-quotes` 6, `retext-sentence-spacing` 6 | "the the", "a apple", quote/spacing errors — near-zero false positives |
| Spelling | `nspell` 2.1.5 + `dictionary-en` 4 | Misspellings, filtered by the site-derived dictionary below |
| Grammar | LanguageTool via Docker (optional) | ~5,000 rules: subject-verb agreement, their/there, tense |
| Consistency | none — own code | Brand and name variants across pages |
| Dates | none — own code | Past-year mentions in forward-looking contexts |

### The site-derived dictionary — what makes spellcheck usable

A stock dictionary flags "Ozark", "Gaga", "Mena", and every staff name, which is
exactly the cry-wolf failure the rest of this tool is built to avoid. Instead,
build the allowlist from the corpus itself: **a word appearing on ≥5 distinct
pages is site vocabulary, not a typo.** A word that is unknown to the dictionary,
appears on one page, *and* is within edit distance 2 of a frequent site word is a
high-confidence typo. Everything else is reported at low confidence, sorted below.

### Consistency by frequency, not by rules

Count capitalized phrases across all pages. "Camp Ozark" ×400 against "camp
ozark" ×2 falls straight out. This is exhaustive and deterministic in a way
per-page checking cannot be — a reviewer reading one page at a time never catches
it either.

### Stale dates are candidates, not verdicts

Surface every past-year mention with surrounding text, ranked by whether the
context looks forward-looking ("register", "join us", "this summer"). The tool
does not claim a date is wrong; it hands over a short sorted list. This is the
one check that genuinely degrades without an LLM, and it degrades to "skim a
list" rather than "miss it".

## Dedup is what makes this cheap and readable

Text blocks are hashed and checked **once**, carrying the list of pages they
appear on — the same `referrers` shape already used in
`src/crawl/links.ts:15`. A global footer typo is one finding across 157 pages,
not 157 findings. This is also why the pass is fast: campozark's ~1M words
collapse to a much smaller set of distinct blocks.

## Dismissals persist

`copy-accepted.json` in the host prefix stores findings a reviewer has marked as
not-a-problem, keyed by content hash. Once dismissed, a finding never returns.
Without this the same false positives resurface every cycle and the section gets
ignored — the same reasoning behind treating 403/429 as `blocked` rather than
`broken` in `src/crawl/links.ts:42`.

## Files

**New:** `src/copy/extract.ts` (text-block extraction from the rendered DOM),
`src/copy/mechanical.ts` (retext), `src/copy/spelling.ts` (nspell +
site-derived dictionary), `src/copy/consistency.ts`, `src/copy/dates.ts`,
`src/copy/languagetool.ts` (Docker lifecycle + client, all optional),
`src/copy/run.ts` (orchestration → `copy.json`).

**Touched:** `src/capture/screenshot.ts` extracts text blocks in the same
`page.evaluate` pass that already collects links — no extra page loads.
`src/cli.ts` adds a `proofread` command (re-run against a stored run, mirroring
`links`) and `--no-proofread`. `src/report/build.ts` gains the grouped section.

**Constraint to respect:** no named function may be declared inside
`page.evaluate` — esbuild's `__name` helper doesn't exist in the browser and
throws. Documented at `src/capture/screenshot.ts:164`.

**Scope:** Tier A+B pages only, matching capture. Tier C is link-checked but not
captured, so there is no text for it — consistent with existing tiering.

---

## Stages

1. **Storage abstraction + local backend.** Pure refactor, no behavior change.
2. **S3 backend + config + bucket creation.**
3. **Content-addressed capture + hash-shortcut diff.** The core storage change.
4. **`migrate` command** — push the 4 local baselines up.
5. **Copy extraction + mechanical + spelling + consistency + dates.** No Docker
   yet, so the degraded path is the one built and tested first.
6. **LanguageTool integration**, optional and auto-detected.
7. **Emailable HTML + PDF** into `reports/`, including the copy section.
8. **`serve` from S3;** prune → GC; conditional baseline write.
9. **Docs** — IAM policy, README on credentials/cost/proofreading, preserve the
   original plan as `docs/plan.md`.

## Verification

```bash
# Stage 1 — refactor is inert
npm run typecheck
npm run report -- https://campozark.com          # identical report from local run

# Stages 2-3 — smallest site first, real S3
npm run scan -- https://campozarkfoundation.org --limit 5
aws s3 ls s3://tfc-sitemap-scanner/data/campozarkfoundation.org/ --recursive | head

# The claim that must actually hold: run 2 uploads almost nothing
npm run scan -- https://campozarkfoundation.org --limit 5   # expect "N blobs reused, 0 uploaded"

# Stage 4 — the baseline that matters
npm run migrate -- https://campozark.com
npm run runs -- https://campozark.com

# Stages 5-6 — proofreading, degraded path first
docker stop languagetool 2>/dev/null
npm run scan -- https://campozark.com --limit 20   # must succeed, report notes LT skipped
npm run proofread -- https://campozark.com         # with Docker up, richer findings

# Stages 7-8 — end to end on the development target
npm run scan -- https://campozark.com
npm run serve -- https://campozark.com
```

Success criteria:
- A second scan of an unchanged site uploads ~0 bytes of image data and downloads
  ~0 bytes for the diff.
- Emailable HTML lands under 20 MB and opens with working thumbnails on a machine
  with no AWS credentials.
- Deleting `runs/` locally breaks nothing.
- **The proofreader runs with Node alone** — no Docker, no API key — and says so
  in the report rather than failing.
- Spelling findings are dominated by real typos, not proper nouns. Checked by
  hand against the first campozark run; if the site-derived dictionary isn't
  carrying its weight, raise the ≥5-page threshold before shipping.

## Cost

**AWS ~$1.50–2.00/month.** Storage of ~15 GB deduped is $0.35; ~3,200 PUTs per
run is $0.016; egress is small after run 1 — which is what content addressing
buys. **Proofreading: $0.** No API spend, no subscription needed.

## Open items

- The **51 MB screenshot** (`max=51808KB` in the current run) suggests a page with
  a runaway height. Worth a look during stage 3 — possibly a capture bug.
- Lifecycle to Infrequent Access deferred: at $0.35/mo the savings don't justify
  the retrieval-cost complexity.
- If stale-date candidates prove too noisy after a real run, the fallback is to
  narrow the forward-looking context patterns rather than widen them.
