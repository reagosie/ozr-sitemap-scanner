#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, siteConfig } from './config.js';
import { discover } from './discover/reconcile.js';
import { isCaptured } from './discover/classify.js';
import path from 'node:path';
import { initRun, newRunId, saveInventory, writeJson, readJson, listRuns, getBaseline, runPaths, setBaseline, pruneRuns } from './store/runs.js';
import type { Inventory } from './types.js';

const program = new Command();
program.name('sitemap-scanner').description('Crawl, screenshot, link-check and visually diff a WordPress site.');

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}
function rpad(s: string | number, n: number): string {
  const v = String(s);
  return v.length >= n ? v : ' '.repeat(n - v.length) + v;
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

program
  .command('scan')
  .argument('<site>', 'site URL, e.g. https://campozark.com')
  .option('--discover-only', 'build the inventory and stop')
  .option('--limit <n>', 'cap the number of URLs captured', (v) => parseInt(v, 10))
  .option('--concurrency <n>', 'concurrent requests', (v) => parseInt(v, 10))
  .option('--changed-only', 'capture only URLs whose lastmod moved (SPOT-CHECK ONLY, unsafe for a formal review)')
  .option('--no-external', 'skip external link checking')
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, opts) => {
    const config = await loadConfig(opts.config);
    const concurrency = opts.concurrency ?? config.concurrency;

    console.log(`\nSitemap Scanner - discovering ${site}\n`);

    const inv = await discover(site, {
      concurrency,
      onProgress: (m) => console.log(m),
    });

    const sc = siteConfig(config, inv.canonicalOrigin);
    if (sc.tiers) {
      const { assignTier } = await import('./discover/classify.js');
      for (const e of inv.entries) e.tier = assignTier(e.type, e.kind, sc.tiers);
      for (const t of inv.typeSummary) t.tier = assignTier(t.type, t.kind, sc.tiers);
      inv.typeSummary.sort((a, b) => a.tier.localeCompare(b.tier) || b.urls - a.urls);
    }

    printTypeTable(inv);

    const runId = newRunId();
    const paths = await initRun(inv.canonicalOrigin, runId);
    await saveInventory(paths, inv);
    await writeJson(paths.manifest, {
      runId,
      site,
      canonicalOrigin: inv.canonicalOrigin,
      startedAt: inv.discoveredAt,
      stage: opts.discoverOnly ? 'discover-only' : 'discover',
      baselineId: await getBaseline(inv.canonicalOrigin),
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


    console.log(`  run: ${paths.root}`);
    if (inv.errors.length) {
      console.log('\n  Inventory is incomplete - see errors above.\n');
      process.exitCode = 1;
    }

    if (opts.discoverOnly) return;

    const { captureAll } = await import('./capture/run.js');
    const baselineId = await getBaseline(inv.canonicalOrigin);
    const baselineInv = baselineId
      ? await readJson<Inventory>(runPaths(inv.canonicalOrigin, baselineId).inventory)
      : null;

    if (opts.changedOnly && !baselineInv) {
      console.log('  --changed-only ignored: no baseline run to compare against; capturing everything.');
    }
    console.log(`  baseline: ${baselineId ?? '(none - this run becomes the baseline)'}`);

    const captures = await captureAll(inv, paths, {
      breakpoints: config.breakpoints,
      concurrency,
      mask: sc.mask ?? [],
      hide: sc.hide ?? [],
      blockUrls: sc.blockUrls ?? [],
      ...(opts.limit ? { limit: opts.limit } : {}),
      changedOnly: Boolean(opts.changedOnly) && Boolean(baselineInv),
      baseline: baselineInv,
      onProgress: (m) => console.log(m),
    });

    await writeJson(path.join(paths.root, 'captures.json'), captures);

    const shots = captures.length * config.breakpoints.length;
    const failed = captures.filter((c) => Object.values(c.breakpoints).some((b) => !b.ok && !b.blocked)).length;
    const blocked = captures.filter((c) => Object.values(c.breakpoints).some((b) => b.blocked)).length;

    console.log('');
    console.log(`  captured ${captures.length} URLs x ${config.breakpoints.length} breakpoints = ${shots} screenshots`);
    if (failed) console.log(`  ${failed} URL(s) failed to capture`);
    if (blocked) console.log(`  ${blocked} URL(s) blocked by bot protection (not counted as broken)`);
    let diffs: import('./diff/run.js').PageDiff[] | null = null;
    if (baselineId) {
      const { diffRuns, summarizeDiffs } = await import('./diff/run.js');
      const basePaths = runPaths(inv.canonicalOrigin, baselineId);
      console.log(`  diffing against baseline ${baselineId}`);
      diffs = await diffRuns(paths, basePaths, captures, {
        breakpoints: config.breakpoints,
        threshold: config.diffThreshold,
        onProgress: (m) => console.log(m),
      });
      await writeJson(path.join(paths.root, 'diffs.json'), diffs);
      const sum = summarizeDiffs(diffs);
      console.log(
        `  diff: ${sum.flagged} flagged, ${sum.unchanged} unchanged, ` +
          `${sum.newPages} new, ${sum.errors} error(s)`,
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

      if (flagged.length && flagged.length <= RECHECK_CAP) {
        console.log('');
        console.log(`  re-checking ${flagged.length} flagged page(s) serially to rule out capture races`);

        const locs = new Set(flagged.map((d) => d.loc));
        const subset = { ...inv, entries: inv.entries.filter((e) => locs.has(e.loc)) };
        const { diffRuns: rerunDiff } = await import('./diff/run.js');
        const basePaths2 = runPaths(inv.canonicalOrigin, baselineId);

        // Overwrites the same screenshot files: the second, more careful capture
        // becomes the authoritative one for this run.
        const recaptured = await captureAll(subset, paths, {
          breakpoints: config.breakpoints,
          concurrency: 1,
          mask: sc.mask ?? [],
          hide: sc.hide ?? [],
          blockUrls: sc.blockUrls ?? [],
          onProgress: () => {},
        });

        const rechecked = await rerunDiff(paths, basePaths2, recaptured, {
          breakpoints: config.breakpoints,
          threshold: config.diffThreshold,
          onProgress: () => {},
        });

        const freshDiff = new Map(rechecked.map((d) => [d.loc, d]));
        diffs = diffs.map((d) => freshDiff.get(d.loc) ?? d);

        const freshCap = new Map(recaptured.map((c) => [c.loc, c]));
        for (let i = 0; i < captures.length; i++) {
          const c = captures[i];
          const replacement = c ? freshCap.get(c.loc) : undefined;
          if (replacement) captures[i] = replacement;
        }

        await writeJson(path.join(paths.root, 'diffs.json'), diffs);
        await writeJson(path.join(paths.root, 'captures.json'), captures);

        const still = diffs.filter((d) => d.flagged).length;
        console.log(
          `  after re-check: ${still} still flagged ` +
            `(${flagged.length - still} were capture noise, not real change)`,
        );
      } else if (flagged.length > RECHECK_CAP) {
        console.log(`  ${flagged.length} flagged pages exceeds the re-check cap; skipping confirmation pass`);
      }
    }


    // --- link checking ------------------------------------------------------
    const { collectLinks, checkLinks } = await import('./crawl/links.js');
    const targets = collectLinks(captures, inv.canonicalOrigin);

    // Tier C URLs are never screenshotted, but they ARE checked here so that
    // excluding them from capture never means excluding them from review.
    for (const e of inv.entries) {
      if (e.tier === 'C' && !targets.has(e.loc)) targets.set(e.loc, []);
    }

    console.log('');
    console.log('  checking links');
    const links = await checkLinks(targets, {
      canonicalOrigin: inv.canonicalOrigin,
      checkExternal: opts.external !== false,
      onProgress: (m) => console.log(m),
    });
    await writeJson(paths.links, links);
    console.log(
      `  links: ${links.checked} checked, ${links.broken} broken, ` +
        `${links.blocked} blocked (bot protection), ${links.redirects} redirects`,
    );

    // --- report -------------------------------------------------------------
    const { buildReport } = await import('./report/build.js');
    const reportFile = await buildReport(
      {
        inventory: inv,
        captures,
        diffs,
        links,
        runId,
        baselineId,
        breakpoints: config.breakpoints,
        threshold: config.diffThreshold,
      },
      paths.report,
    );

    await setBaseline(inv.canonicalOrigin, runId);
    const pruned = await pruneRuns(inv.canonicalOrigin, config.retainRuns, runId);
    if (pruned.length) console.log(`  pruned ${pruned.length} old run(s)`);

    console.log('');
    console.log(`  report: ${reportFile}`);
    console.log(`  view:   npm run serve -- ${site} ${runId}`);
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
    const config = await loadConfig(opts.config);
    const { resolveCanonicalOrigin } = await import('./discover/detect.js');
    const { diffRuns, summarizeDiffs } = await import('./diff/run.js');
    const origin = await resolveCanonicalOrigin(site);

    const cur = runPaths(origin, opts.current);
    const base = runPaths(origin, opts.baseline);
    const captures = await readJson<any[]>(path.join(cur.root, 'captures.json'));
    if (!captures) throw new Error(`no captures.json in ${cur.root}`);

    const threshold = opts.threshold ?? config.diffThreshold;
    console.log(`
  ${opts.current} vs ${opts.baseline}  (threshold ${threshold})
`);

    const diffs = await diffRuns(cur, base, captures, {
      breakpoints: config.breakpoints,
      threshold,
      onProgress: (m) => console.log(m),
    });
    await writeJson(path.join(cur.root, 'diffs.json'), diffs);

    const sum = summarizeDiffs(diffs);
    console.log(`
  ${sum.flagged} flagged, ${sum.unchanged} unchanged, ${sum.newPages} new, ${sum.errors} error(s)
`);

    for (const d of diffs.slice(0, 12)) {
      const parts = Object.entries(d.breakpoints).map(
        ([bp, r]) => `${bp}=${(r.ratio * 100).toFixed(3)}%${r.heightDelta ? ` (h${r.heightDelta > 0 ? '+' : ''}${r.heightDelta})` : ''}`,
      );
      console.log(`  ${d.flagged ? 'FLAG' : '    '} ${d.loc}`);
      console.log(`         ${parts.join('  ')}`);
    }
  });

program
  .command('serve')
  .description('serve a report locally so full-size screenshots load lazily')
  .argument('<site>', 'site URL')
  .argument('[runId]', 'run to view (default: most recent)')
  .option('--port <n>', 'port', (v) => parseInt(v, 10), 4173)
  .action(async (site: string, runId: string | undefined, opts) => {
    const { resolveCanonicalOrigin } = await import('./discover/detect.js');
    const { serveRun } = await import('./report/serve.js');
    const { hostDir, RUNS_ROOT } = await import('./store/runs.js');
    const origin = await resolveCanonicalOrigin(site);

    const id = runId ?? (await listRuns(origin))[0];
    if (!id) throw new Error(`no runs found for ${origin}`);

    const hostRoot = path.join(RUNS_ROOT, hostDir(origin));
    const url = await serveRun(hostRoot, id, opts.port);
    console.log(`
  ${url}

  Ctrl+C to stop.
`);
  });

program
  .command('report')
  .description('rebuild the HTML report for an existing run from its stored JSON')
  .argument('<site>', 'site URL')
  .argument('[runId]', 'run to rebuild (default: most recent)')
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, runId: string | undefined, opts) => {
    const config = await loadConfig(opts.config);
    const { resolveCanonicalOrigin } = await import('./discover/detect.js');
    const { buildReport } = await import('./report/build.js');
    const origin = await resolveCanonicalOrigin(site);

    const id = runId ?? (await listRuns(origin))[0];
    if (!id) throw new Error(`no runs found for ${origin}`);
    const p = runPaths(origin, id);

    const inventory = await readJson<Inventory>(p.inventory);
    if (!inventory) throw new Error(`no inventory.json in ${p.root}`);
    const captures = (await readJson<any[]>(path.join(p.root, 'captures.json'))) ?? [];
    const diffs = await readJson<any[]>(path.join(p.root, 'diffs.json'));
    const links = await readJson<any>(p.links);
    const manifest = await readJson<any>(p.manifest);

    const file = await buildReport(
      {
        inventory,
        captures,
        diffs,
        links,
        runId: id,
        baselineId: manifest?.baselineId ?? null,
        breakpoints: config.breakpoints,
        threshold: config.diffThreshold,
      },
      p.report,
    );
    console.log(`
  ${file}
`);
  });

program
  .command('links')
  .description('re-run the link check for an existing run, reusing its captured pages')
  .argument('<site>', 'site URL')
  .argument('[runId]', 'run to re-check (default: most recent)')
  .option('--no-external', 'skip external link checking')
  .option('--config <path>', 'config file', 'scanner.config.json')
  .action(async (site: string, runId: string | undefined, opts) => {
    const config = await loadConfig(opts.config);
    const { resolveCanonicalOrigin } = await import('./discover/detect.js');
    const { collectLinks, checkLinks } = await import('./crawl/links.js');
    const { buildReport } = await import('./report/build.js');
    const origin = await resolveCanonicalOrigin(site);

    const id = runId ?? (await listRuns(origin))[0];
    if (!id) throw new Error(`no runs found for ${origin}`);
    const p = runPaths(origin, id);

    const inventory = await readJson<Inventory>(p.inventory);
    if (!inventory) throw new Error(`no inventory.json in ${p.root}`);
    const captures = (await readJson<any[]>(path.join(p.root, 'captures.json'))) ?? [];
    const diffs = await readJson<any[]>(path.join(p.root, 'diffs.json'));
    const manifest = await readJson<any>(p.manifest);

    const targets = collectLinks(captures, inventory.canonicalOrigin);
    for (const e of inventory.entries) {
      if (e.tier === 'C' && !targets.has(e.loc)) targets.set(e.loc, []);
    }

    console.log(`
  re-checking links for ${id}`);
    const links = await checkLinks(targets, {
      canonicalOrigin: inventory.canonicalOrigin,
      checkExternal: opts.external !== false,
      onProgress: (m) => console.log(m),
    });
    await writeJson(p.links, links);
    console.log(
      `  links: ${links.checked} checked, ${links.broken} broken, ` +
        `${links.blocked} blocked, ${links.redirects} redirects`,
    );

    const file = await buildReport(
      {
        inventory,
        captures,
        diffs,
        links,
        runId: id,
        baselineId: manifest?.baselineId ?? null,
        breakpoints: config.breakpoints,
        threshold: config.diffThreshold,
      },
      p.report,
    );
    console.log(`  report: ${file}
`);
  });

program
  .command('runs')
  .argument('<site>', 'site URL')
  .action(async (site: string) => {
    const { resolveCanonicalOrigin } = await import('./discover/detect.js');
    const origin = await resolveCanonicalOrigin(site);
    const runs = await listRuns(origin);
    const baseline = await getBaseline(origin);
    if (!runs.length) {
      console.log(`no runs for ${origin}`);
      return;
    }
    for (const r of runs) console.log(`${r === baseline ? '* ' : '  '}${r}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
