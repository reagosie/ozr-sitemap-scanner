#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, siteConfig, type Config } from './config.js';
import { discover } from './discover/reconcile.js';
import { isCaptured } from './discover/classify.js';
import { createBackends, resolveBucket, type Backends } from './store/factory.js';
import {
  newRunId,
  runKeys,
  listRuns,
  getBaseline,
  setBaseline,
  pruneRuns,
  acceptedKey,
} from './store/runs.js';
import type { PageCapture } from './capture/run.js';
import type { PageDiff } from './diff/run.js';
import type { LinkCheckReport } from './crawl/links.js';
import type { CopyReport } from './copy/types.js';
import type { Inventory } from './types.js';

/**
 * The run finished, but the site's own sitemap is incomplete.
 *
 * Distinct from 1 so automation can tell "the scanner broke" from "the scanner
 * worked and found something wrong with the site" -- the second recurs every run
 * until someone fixes the site, and must not look like a tool failure.
 */
const EXIT_SITE_DEFECT = 2;

const program = new Command();
program.name('sitemap-scanner').description('Crawl, screenshot, link-check, proofread and visually diff a WordPress site.');

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}
function rpad(s: string | number, n: number): string {
  const v = String(s);
  return v.length >= n ? v : ' '.repeat(n - v.length) + v;
}
function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** Shared setup: config, backends, canonical origin. */
async function context(
  site: string,
  configPath: string,
): Promise<{ config: Config; backends: Backends; origin: string }> {
  const config = await loadConfig(configPath);
  const backends = await createBackends(config);
  const { resolveCanonicalOrigin } = await import('./discover/detect.js');
  const origin = await resolveCanonicalOrigin(site);
  return { config, backends, origin };
}

/** Resolve a run id argument, defaulting to the most recent run. */
async function resolveRunId(
  backends: Backends,
  origin: string,
  runId: string | undefined,
): Promise<string> {
  const id = runId ?? (await listRuns(backends.data, origin))[0];
  if (!id) throw new Error(`no runs found for ${origin} in ${backends.data.describe}`);
  return id;
}

/** The per-type table. This is what a new site's tier policy gets set from. */
export function printTypeTable(inv: Inventory): void {
  console.log('');
  console.log(pad('TYPE', 26) + pad('KIND', 10) + 'TIER' + rpad('URLS', 8) + rpad('LASTMOD', 9) + rpad('REST', 7));
  console.log('-'.repeat(66));

  let captured = 0;
  let linkOnly = 0;
  for (const t of inv.typeSummary) {
    console.log(
      pad(t.type, 26) +
        pad(t.kind, 10) +
        pad(` ${t.tier}`, 4) +
        rpad(t.urls, 8) +
        rpad(t.withLastmod, 9) +
        rpad(t.restCount ?? '-', 7),
    );
    if (isCaptured(t.tier)) captured += t.urls;
    else linkOnly += t.urls;
  }

  console.log('-'.repeat(66));
  console.log(`${pad('TOTAL', 26)}${pad('', 10)}    ${rpad(inv.entries.length, 8)}`);
  console.log('');
  console.log(`  sitemap flavor   : ${inv.flavor}`);
  console.log(`  sub-sitemaps     : ${inv.subSitemaps.length} (${inv.subSitemaps.filter((s) => s.ok).length} ok)`);
  console.log(`  capture set (A+B): ${captured}`);
  console.log(`  link-check only  : ${linkOnly}`);

  const noLastmod = inv.entries.filter((e) => !e.lastmod).length;
  if (noLastmod) {
    console.log(`  without lastmod  : ${noLastmod}  (always captured -- never treated as unchanged)`);
  }

  if (inv.possiblyMissed.length) {
    console.log('');
    console.log('  POSSIBLY MISSED - published in REST but absent from the sitemap:');
    for (const m of inv.possiblyMissed) console.log(`    ${pad(m.type, 24)} ${m.restCount} published`);
  }

  if (inv.missingFromSitemap.length) {
    const total = inv.missingFromSitemap.reduce((n, m) => n + m.urls.length, 0);
    console.log('');
    console.log(`  MISSING FROM SITEMAP - ${total} published URL(s), recovered from REST and added to the inventory:`);
    for (const m of inv.missingFromSitemap) {
      console.log(`    ${pad(m.type, 22)} sitemap ${m.sitemapCount}  vs  REST ${m.restCount}   (+${m.urls.length})`);
      for (const u of m.urls.slice(0, 5)) console.log(`      ${u}`);
      if (m.urls.length > 5) console.log(`      ... and ${m.urls.length - 5} more (full list in inventory.json)`);
    }
  }

  if (inv.errors.length) {
    console.log('');
    console.log('  ERRORS - inventory is INCOMPLETE:');
    for (const e of inv.errors) console.log(`    ${e}`);
  }
  console.log('');
}

/** Run the copy checks and store the result. Never fails the run. */
async function runProofread(
  backends: Backends,
  origin: string,
  captures: PageCapture[],
  config: Config,
  sc: ReturnType<typeof siteConfig>,
): Promise<CopyReport | null> {
  const { proofread } = await import('./copy/run.js');
  const accepted =
    (await backends.data.getJson<{ ids: string[] }>(acceptedKey(origin)))?.ids ?? [];

  const copy = await proofread(captures, {
    siteWordMinPages: config.proofread.siteWordMinPages,
    glossary: [...config.proofread.glossary, ...(sc.glossary ?? [])],
    canonicalNames: sc.canonicalNames ?? [],
    languageTool: config.proofread.languageTool,
    languageToolPort: config.proofread.languageToolPort,
    accepted,
    onProgress: (m) => console.log(m),
  });

  const c = copy.counts;
  console.log(
    `  copy: ${copy.findings.length} finding(s) - ` +
      `${c.spelling} spelling, ${c.grammar} grammar, ${c.mechanical} mechanical, ` +
      `${c.consistency} consistency, ${c.date} date` +
      (copy.dismissed ? `  (${copy.dismissed} previously dismissed)` : ''),
  );
  for (const s of copy.skipped) console.log(`    ${s.check} skipped: ${s.reason}`);

  return copy;
}

/**
 * Write both reports for a run.
 *
 * Every command that changes a run's findings goes through here, so the
 * emailable file can never drift out of step with the interactive one -- which
 * matters because the emailable file is the copy that gets sent to someone.
 */
async function writeReports(
  input: import('./report/build.js').ReportInput,
  backends: Backends,
  origin: string,
  reportKey: string,
): Promise<void> {
  const { buildReport } = await import('./report/build.js');
  const { publishEmailable } = await import('./report/emailable.js');

  const html = buildReport(input);
  await backends.data.putBuffer(reportKey, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');

  const published = await publishEmailable(input, backends, origin, {
    onProgress: (m) => console.log(m),
  });

  console.log('');
  console.log(`  report:    ${backends.data.describe}/${reportKey}`);
  if (published) {
    console.log(`  emailable: ${published.htmlKey}  (${mb(published.htmlBytes)})`);
    console.log(`             ${published.pdfKey}  (${mb(published.pdfBytes)})`);
  }
}

program
  .command('scan')
  .argument('<site>', 'site URL, e.g. https://campozark.com')
  .option('--discover-only', 'build the inventory and stop')
  .option('--limit <n>', 'cap the number of URLs captured', (v) => parseInt(v, 10))
  .option('--concurrency <n>', 'concurrent requests', (v) => parseInt(v, 10))
  .option('--changed-only', 'capture only URLs whose lastmod moved (SPOT-CHECK ONLY, unsafe for a formal review)')
  .option('--no-external', 'skip external link checking')
  .option('--no-proofread', 'skip the copy checks')
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, opts) => {
    const config = await loadConfig(opts.config);
    const backends = await createBackends(config);
    const concurrency = opts.concurrency ?? config.concurrency;

    console.log(`\nSitemap Scanner - discovering ${site}`);
    console.log(`  storage: ${backends.data.describe}${backends.central ? '' : '  (local - runs are not shared)'}\n`);

    const inv = await discover(site, {
      concurrency,
      onProgress: (m) => console.log(m),
    });

    const origin = inv.canonicalOrigin;
    const sc = siteConfig(config, origin);
    if (sc.tiers) {
      const { assignTier } = await import('./discover/classify.js');
      for (const e of inv.entries) e.tier = assignTier(e.type, e.kind, sc.tiers);
      for (const t of inv.typeSummary) t.tier = assignTier(t.type, t.kind, sc.tiers);
      inv.typeSummary.sort((a, b) => a.tier.localeCompare(b.tier) || b.urls - a.urls);
    }

    printTypeTable(inv);

    const runId = newRunId();
    const keys = runKeys(origin, runId);
    const baselineId = await getBaseline(backends.data, origin);

    await backends.data.putJson(keys.inventory, inv);
    await backends.data.putJson(keys.manifest, {
      runId,
      site,
      canonicalOrigin: origin,
      startedAt: inv.discoveredAt,
      stage: opts.discoverOnly ? 'discover-only' : 'discover',
      baselineId,
      storage: backends.data.describe,
      config: { concurrency, breakpoints: config.breakpoints, diffThreshold: config.diffThreshold },
      crawlDelayDeclared: inv.robots.crawlDelay,
      counts: {
        total: inv.entries.length,
        recoveredFromRest: inv.entries.filter((e) => e.discoveredVia === 'rest').length,
        captureSet: inv.entries.filter((e) => isCaptured(e.tier)).length,
        withoutLastmod: inv.entries.filter((e) => !e.lastmod).length,
      },
      errors: inv.errors,
    });

    console.log(`  run: ${runId}`);
    if (inv.errors.length) {
      console.log('\n  Inventory is incomplete - see errors above.');
      console.log('  (exit 2: the run still completes; this flags a defect in the SITE, not the scan)\n');
      // Exit 2, not 1.
      //
      // campozark declares ozrsession-sitemap.xml in its sitemap index and
      // serves a 404 for it. That is a real defect worth reporting, but it
      // recurs on every single run, so exiting 1 meant a 90-minute successful
      // scan reported as failed forever -- and an exit code that is always
      // failing is one nobody reads. 1 stays reserved for the scan itself
      // failing, which the top-level catch handles.
      process.exitCode = EXIT_SITE_DEFECT;
    }

    if (opts.discoverOnly) return;

    const { captureAll } = await import('./capture/run.js');
    const baselineInv = baselineId
      ? await backends.data.getJson<Inventory>(runKeys(origin, baselineId).inventory)
      : null;
    const baselineCaptures = baselineId
      ? await backends.data.getJson<PageCapture[]>(runKeys(origin, baselineId).captures)
      : null;

    if (opts.changedOnly && !baselineInv) {
      console.log('  --changed-only ignored: no baseline run to compare against; capturing everything.');
    }
    console.log(`  baseline: ${baselineId ?? '(none - this run becomes the baseline)'}`);

    const wantProofread = opts.proofread !== false && config.proofread.enabled;

    const run = await captureAll(inv, backends.data, {
      breakpoints: config.breakpoints,
      concurrency,
      mask: sc.mask ?? [],
      hide: sc.hide ?? [],
      blockUrls: sc.blockUrls ?? [],
      ...(opts.limit ? { limit: opts.limit } : {}),
      changedOnly: Boolean(opts.changedOnly) && Boolean(baselineInv),
      baseline: baselineInv,
      extractText: wantProofread,
      textIgnoreSelectors: [...config.proofread.ignoreSelectors, ...(sc.ignoreSelectors ?? [])],
      onProgress: (m) => console.log(m),
    });
    let captures = run.captures;

    await backends.data.putJson(keys.captures, captures);

    const shots = captures.length * config.breakpoints.length;
    const failed = captures.filter((c) => Object.values(c.breakpoints).some((b) => !b.ok && !b.blocked)).length;
    const blocked = captures.filter((c) => Object.values(c.breakpoints).some((b) => b.blocked)).length;

    console.log('');
    console.log(`  captured ${captures.length} URLs x ${config.breakpoints.length} breakpoints = ${shots} screenshots`);
    console.log(
      `  blobs: ${run.stats.uploaded} new (${mb(run.stats.bytesUploaded)}), ` +
        `${run.stats.reused} reused from earlier runs`,
    );
    if (failed) console.log(`  ${failed} URL(s) failed to capture`);
    if (blocked) console.log(`  ${blocked} URL(s) blocked by bot protection (not counted as broken)`);

    let diffs: PageDiff[] | null = null;
    if (baselineId) {
      const { diffRuns, summarizeDiffs } = await import('./diff/run.js');
      console.log(`  diffing against baseline ${baselineId}`);
      const result = await diffRuns(backends.data, origin, captures, baselineCaptures, {
        breakpoints: config.breakpoints,
        threshold: config.diffThreshold,
        onProgress: (m) => console.log(m),
      });
      diffs = result.diffs;
      await backends.data.putJson(keys.diffs, diffs);

      const sum = summarizeDiffs(diffs);
      console.log(
        `  diff: ${sum.flagged} flagged, ${sum.unchanged} unchanged, ` +
          `${sum.newPages} new, ${sum.errors} error(s)`,
      );
      console.log(
        `  diff work: ${result.stats.byHash} settled by hash, ${result.stats.newPages} new ` +
          `(no transfer for either), ${result.stats.compared} compared ` +
          `(${mb(result.stats.bytesFetched)} fetched)`,
      );
    }

    // --- confirm flags by re-capture --------------------------------------
    //
    // Capture is deterministic for the large majority of pages (median self-diff
    // 0.0000%), but a few lose a lazy-image race under concurrency and flag
    // despite being identical -- verified: the same page loaded serially three
    // times is byte-stable, and the pages that flag CHANGE between runs.
    //
    // Rather than make every capture slow enough to be perfect (serial capture
    // would turn a 30-minute run into several hours), only the surprising pages
    // are re-shot, and serially. A genuine change flags both times; a race does
    // not survive the second look.
    if (diffs && baselineId) {
      const flagged = diffs.filter((d) => d.flagged);
      const RECHECK_CAP = 150;

      // Re-check the LEAST-changed pages first, and cap how many rather than
      // whether.
      //
      // The cap used to be all-or-nothing, which got it exactly backwards: on a
      // run where 227 of 525 pages flagged, the confirmation pass declined to
      // run at all -- precisely when knowing the noise rate mattered most, and
      // leaving no way to tell real change from a lazy-image race.
      //
      // Ambiguity is not uniform across flagged pages. One that moved 40% of its
      // pixels is plainly different and confirming it teaches nothing; one
      // sitting just over the threshold is where a capture race hides. Sorting
      // by change ratio ascending spends a bounded budget on the only pages
      // whose verdict is actually in doubt.
      const worstRatio = (d: PageDiff): number =>
        Math.max(0, ...Object.values(d.breakpoints).map((b) => (b.status === 'changed' ? b.ratio : 0)));
      const toRecheck = [...flagged].sort((a, b) => worstRatio(a) - worstRatio(b)).slice(0, RECHECK_CAP);

      if (toRecheck.length) {
        console.log('');
        console.log(
          `  re-checking ${toRecheck.length} flagged page(s) serially to rule out capture races` +
            (toRecheck.length < flagged.length
              ? ` (the least-changed of ${flagged.length}; the rest changed too much to be noise)`
              : ''),
        );

        const locs = new Set(toRecheck.map((d) => d.loc));
        const subset = { ...inv, entries: inv.entries.filter((e) => locs.has(e.loc)) };
        const { diffRuns: rerunDiff } = await import('./diff/run.js');

        // The second, more careful capture becomes the authoritative one for
        // this run: its hash replaces the first in captures.json.
        const recaptured = await captureAll(subset, backends.data, {
          breakpoints: config.breakpoints,
          concurrency: 1,
          mask: sc.mask ?? [],
          hide: sc.hide ?? [],
          blockUrls: sc.blockUrls ?? [],
          onProgress: () => {},
        });

        const rechecked = await rerunDiff(
          backends.data,
          origin,
          recaptured.captures,
          baselineCaptures,
          {
            breakpoints: config.breakpoints,
            threshold: config.diffThreshold,
            onProgress: () => {},
          },
        );

        const freshDiff = new Map(rechecked.diffs.map((d) => [d.loc, d]));
        diffs = diffs.map((d) => freshDiff.get(d.loc) ?? d);

        // Keep the original text blocks: the re-capture runs without text
        // extraction, and dropping them would empty the proofreader's corpus.
        const freshCap = new Map(recaptured.captures.map((c) => [c.loc, c]));
        captures = captures.map((c) => {
          const replacement = freshCap.get(c.loc);
          if (!replacement) return c;
          return { ...replacement, ...(c.textBlocks ? { textBlocks: c.textBlocks } : {}) };
        });

        await backends.data.putJson(keys.diffs, diffs);
        await backends.data.putJson(keys.captures, captures);

        const still = diffs.filter((d) => d.flagged).length;
        console.log(
          `  after re-check: ${still} still flagged ` +
            `(${flagged.length - still} of the ${toRecheck.length} re-shot were capture noise, ` +
            `not real change)`,
        );
      }
    }

    // --- link checking ------------------------------------------------------
    const { collectLinks, checkLinks } = await import('./crawl/links.js');
    const targets = collectLinks(captures, origin);

    // Tier C URLs are never screenshotted, but they ARE checked here so that
    // excluding them from capture never means excluding them from review.
    for (const e of inv.entries) {
      if (e.tier === 'C' && !targets.has(e.loc)) targets.set(e.loc, []);
    }

    console.log('');
    console.log('  checking links');
    const links = await checkLinks(targets, {
      canonicalOrigin: origin,
      checkExternal: opts.external !== false,
      onProgress: (m) => console.log(m),
    });
    await backends.data.putJson(keys.links, links);
    console.log(
      `  links: ${links.checked} checked, ${links.broken} broken, ` +
        `${links.blocked} blocked (bot protection), ${links.redirects} redirects`,
    );

    // --- proofreading -------------------------------------------------------
    let copy: CopyReport | null = null;
    if (wantProofread) {
      console.log('');
      console.log('  proofreading copy');
      copy = await runProofread(backends, origin, captures, config, sc);
      await backends.data.putJson(keys.copy, copy);
    }

    // --- reports ------------------------------------------------------------
    await writeReports(
      {
        inventory: inv,
        captures,
        diffs,
        links,
        copy,
        runId,
        baselineId,
        breakpoints: config.breakpoints,
        threshold: config.diffThreshold,
      },
      backends,
      origin,
      keys.report,
    );

    const baselineResult = await setBaseline(backends.data, origin, runId);
    if (!baselineResult.ok) {
      console.log(
        `\n  WARNING: another scan moved the baseline to ${baselineResult.conflictedWith ?? 'an unknown run'} ` +
          `while this one was running. This run's data is stored, but it is NOT the baseline.`,
      );
    }

    const pruned = await pruneRuns(backends.data, origin, config.retainRuns, runId);
    if (pruned.removedRuns.length || pruned.removedBlobs) {
      console.log(
        `  pruned ${pruned.removedRuns.length} old run(s), ` +
          `collected ${pruned.removedBlobs} unreferenced blob(s) (${mb(pruned.bytesFreed)})`,
      );
    }

    console.log(`  view:      npm run serve -- ${site} ${runId}`);
    console.log('');
  });

program
  .command('diff')
  .description('compare two existing runs without re-capturing')
  .argument('<site>', 'site URL')
  .requiredOption('--current <runId>', 'run to evaluate')
  .requiredOption('--baseline <runId>', 'run to compare against')
  .option('--threshold <n>', 'flag above this changed-pixel fraction', (v) => parseFloat(v))
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, opts) => {
    const { config, backends, origin } = await context(site, opts.config);
    const { diffRuns, summarizeDiffs } = await import('./diff/run.js');

    const cur = runKeys(origin, opts.current);
    const captures = await backends.data.getJson<PageCapture[]>(cur.captures);
    if (!captures) throw new Error(`no captures.json for run ${opts.current}`);
    const baselineCaptures = await backends.data.getJson<PageCapture[]>(
      runKeys(origin, opts.baseline).captures,
    );

    const threshold = opts.threshold ?? config.diffThreshold;
    console.log(`\n  ${opts.current} vs ${opts.baseline}  (threshold ${threshold})\n`);

    const result = await diffRuns(backends.data, origin, captures, baselineCaptures, {
      breakpoints: config.breakpoints,
      threshold,
      onProgress: (m) => console.log(m),
    });
    await backends.data.putJson(cur.diffs, result.diffs);

    const sum = summarizeDiffs(result.diffs);
    console.log(`\n  ${sum.flagged} flagged, ${sum.unchanged} unchanged, ${sum.newPages} new, ${sum.errors} error(s)\n`);

    for (const d of result.diffs.slice(0, 12)) {
      const parts = Object.entries(d.breakpoints).map(
        ([bp, r]) => `${bp}=${(r.ratio * 100).toFixed(3)}%${r.heightDelta ? ` (h${r.heightDelta > 0 ? '+' : ''}${r.heightDelta})` : ''}`,
      );
      console.log(`  ${d.flagged ? 'FLAG' : '    '} ${d.loc}`);
      console.log(`         ${parts.join('  ')}`);
    }
  });

program
  .command('serve')
  .description('serve a report locally, streaming screenshots from wherever they are stored')
  .argument('<site>', 'site URL')
  .argument('[runId]', 'run to view (default: most recent)')
  .option('--port <n>', 'port', (v) => parseInt(v, 10), 4173)
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, runId: string | undefined, opts) => {
    const { backends, origin } = await context(site, opts.config);
    const { serveRun } = await import('./report/serve.js');
    const id = await resolveRunId(backends, origin, runId);
    const url = await serveRun(backends.data, origin, id, opts.port);
    console.log(`\n  ${url}\n\n  Ctrl+C to stop.\n`);
  });

program
  .command('report')
  .description('rebuild the reports for an existing run from its stored JSON')
  .argument('<site>', 'site URL')
  .argument('[runId]', 'run to rebuild (default: most recent)')
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, runId: string | undefined, opts) => {
    const { config, backends, origin } = await context(site, opts.config);
    const id = await resolveRunId(backends, origin, runId);
    const keys = runKeys(origin, id);

    const inventory = await backends.data.getJson<Inventory>(keys.inventory);
    if (!inventory) throw new Error(`no inventory.json for run ${id}`);
    const manifest = await backends.data.getJson<{ baselineId?: string | null }>(keys.manifest);

    await writeReports(
      {
        inventory,
        captures: (await backends.data.getJson<PageCapture[]>(keys.captures)) ?? [],
        diffs: await backends.data.getJson<PageDiff[]>(keys.diffs),
        links: await backends.data.getJson<LinkCheckReport>(keys.links),
        copy: await backends.data.getJson<CopyReport>(keys.copy),
        runId: id,
        baselineId: manifest?.baselineId ?? null,
        breakpoints: config.breakpoints,
        threshold: config.diffThreshold,
      },
      backends,
      origin,
      keys.report,
    );
    console.log('');
  });

program
  .command('links')
  .description('re-run the link check for an existing run, reusing its captured pages')
  .argument('<site>', 'site URL')
  .argument('[runId]', 'run to re-check (default: most recent)')
  .option('--no-external', 'skip external link checking')
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, runId: string | undefined, opts) => {
    const { config, backends, origin } = await context(site, opts.config);
    const { collectLinks, checkLinks } = await import('./crawl/links.js');
    const { buildReport } = await import('./report/build.js');

    const id = await resolveRunId(backends, origin, runId);
    const keys = runKeys(origin, id);

    const inventory = await backends.data.getJson<Inventory>(keys.inventory);
    if (!inventory) throw new Error(`no inventory.json for run ${id}`);
    const captures = (await backends.data.getJson<PageCapture[]>(keys.captures)) ?? [];
    const diffs = await backends.data.getJson<PageDiff[]>(keys.diffs);
    const copy = await backends.data.getJson<CopyReport>(keys.copy);
    const manifest = await backends.data.getJson<{ baselineId?: string | null }>(keys.manifest);

    const targets = collectLinks(captures, inventory.canonicalOrigin);
    for (const e of inventory.entries) {
      if (e.tier === 'C' && !targets.has(e.loc)) targets.set(e.loc, []);
    }

    console.log(`\n  re-checking links for ${id}`);
    const links = await checkLinks(targets, {
      canonicalOrigin: inventory.canonicalOrigin,
      checkExternal: opts.external !== false,
      onProgress: (m) => console.log(m),
    });
    await backends.data.putJson(keys.links, links);
    console.log(
      `  links: ${links.checked} checked, ${links.broken} broken, ` +
        `${links.blocked} blocked, ${links.redirects} redirects`,
    );

    await writeReports(
      {
        inventory,
        captures,
        diffs,
        links,
        copy,
        runId: id,
        baselineId: manifest?.baselineId ?? null,
        breakpoints: config.breakpoints,
        threshold: config.diffThreshold,
      },
      backends,
      origin,
      keys.report,
    );
    console.log('');
  });

program
  .command('proofread')
  .description('re-run the copy checks for an existing run, reusing its captured text')
  .argument('<site>', 'site URL')
  .argument('[runId]', 'run to re-check (default: most recent)')
  .option('--no-language-tool', 'skip the LanguageTool grammar pass')
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, runId: string | undefined, opts) => {
    const { config, backends, origin } = await context(site, opts.config);
    const { buildReport } = await import('./report/build.js');

    const id = await resolveRunId(backends, origin, runId);
    const keys = runKeys(origin, id);

    const inventory = await backends.data.getJson<Inventory>(keys.inventory);
    if (!inventory) throw new Error(`no inventory.json for run ${id}`);
    const captures = (await backends.data.getJson<PageCapture[]>(keys.captures)) ?? [];
    if (!captures.some((c) => c.textBlocks?.length)) {
      throw new Error(
        `run ${id} has no captured text. It predates proofreading, or was run with --no-proofread; ` +
          `re-scan to collect it.`,
      );
    }

    if (opts.languageTool === false) config.proofread.languageTool = false;

    console.log(`\n  proofreading ${id}`);
    const sc = siteConfig(config, origin);
    const copy = await runProofread(backends, origin, captures, config, sc);
    if (copy) await backends.data.putJson(keys.copy, copy);

    const manifest = await backends.data.getJson<{ baselineId?: string | null }>(keys.manifest);
    await writeReports(
      {
        inventory,
        captures,
        diffs: await backends.data.getJson<PageDiff[]>(keys.diffs),
        links: await backends.data.getJson<LinkCheckReport>(keys.links),
        copy,
        runId: id,
        baselineId: manifest?.baselineId ?? null,
        breakpoints: config.breakpoints,
        threshold: config.diffThreshold,
      },
      backends,
      origin,
      keys.report,
    );
    console.log('');
  });

program
  .command('dismiss')
  .description('permanently hide copy findings by id, so they never resurface')
  .argument('<site>', 'site URL')
  .argument('<ids...>', 'finding ids from the report')
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, ids: string[], opts) => {
    const { backends, origin } = await context(site, opts.config);
    const key = acceptedKey(origin);
    const current = (await backends.data.getJson<{ ids: string[] }>(key))?.ids ?? [];
    const merged = [...new Set([...current, ...ids])];
    await backends.data.putJson(key, { ids: merged, updatedAt: new Date().toISOString() });
    console.log(`\n  dismissed ${ids.length} finding(s); ${merged.length} total for ${origin}\n`);
  });

program
  .command('migrate')
  .description('upload local runs to the configured central store')
  .argument('<site>', 'site URL')
  .option('--all', 'migrate every local run, not just the baseline')
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, opts) => {
    const { config, backends, origin } = await context(site, opts.config);
    if (!backends.central) {
      throw new Error(
        'migrate needs a central store. Set storage.bucket in scanner.config.json ' +
          'or SITEMAP_SCANNER_BUCKET.',
      );
    }
    const { migrateLocalRuns } = await import('./store/migrate.js');
    const result = await migrateLocalRuns(config, backends, origin, {
      all: Boolean(opts.all),
      onProgress: (m) => console.log(m),
    });

    // Build reports for what was just moved.
    //
    // A migrated run is uploaded precisely BECAUSE it has value -- its link
    // results and inventory are the record of the last review. Leaving it
    // viewable only to someone who knows to run a second command makes the
    // migration look like it half-worked.
    for (const runId of result.migrated) {
      const keys = runKeys(origin, runId);
      const inventory = await backends.data.getJson<Inventory>(keys.inventory);
      if (!inventory) continue;

      const manifest = await backends.data.getJson<{ baselineId?: string | null }>(keys.manifest);
      console.log(`\n  building reports for ${runId}`);
      await writeReports(
        {
          inventory,
          captures: (await backends.data.getJson<PageCapture[]>(keys.captures)) ?? [],
          diffs: await backends.data.getJson<PageDiff[]>(keys.diffs),
          links: await backends.data.getJson<LinkCheckReport>(keys.links),
          copy: await backends.data.getJson<CopyReport>(keys.copy),
          runId,
          baselineId: manifest?.baselineId ?? null,
          breakpoints: config.breakpoints,
          threshold: config.diffThreshold,
        },
        backends,
        origin,
        keys.report,
      );
    }
    console.log('');
  });

program
  .command('runs')
  .argument('<site>', 'site URL')
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, opts) => {
    const { backends, origin } = await context(site, opts.config);
    const runs = await listRuns(backends.data, origin);
    const baseline = await getBaseline(backends.data, origin);

    console.log(`\n  ${backends.data.describe}`);
    if (!runs.length) {
      console.log(`  no runs for ${origin}\n`);
      return;
    }
    for (const r of runs) console.log(`  ${r === baseline ? '*' : ' '} ${r}`);
    console.log('');
  });

program
  .command('where')
  .description('show which store this configuration resolves to')
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (opts) => {
    const config = await loadConfig(opts.config);
    const backends = await createBackends(config);
    console.log(`\n  data:    ${backends.data.describe}`);
    console.log(`  reports: ${backends.reports.describe}`);
    console.log(`  central: ${backends.central ? 'yes' : 'no - runs stay on this machine'}`);
    console.log(`  bucket:  ${resolveBucket(config) ?? '(none configured)'}\n`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
