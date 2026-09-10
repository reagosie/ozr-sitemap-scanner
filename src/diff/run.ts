import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import { compareShots, newByHeight, unchangedByHash, type DiffResult } from './compare.js';
import { blobKey } from '../store/runs.js';
import type { StorageBackend } from '../store/backend.js';
import type { BreakpointSpec } from '../capture/browser.js';
import type { PageCapture } from '../capture/run.js';
import type { Tier } from '../types.js';
import { silentReporter, type Reporter } from '../progress.js';

export interface PageDiff {
  loc: string;
  slug: string;
  type: string;
  tier: Tier;
  lastmod?: string;
  discoveredVia: 'sitemap' | 'rest';
  breakpoints: Record<string, DiffResult>;
  /** True when any breakpoint exceeded the threshold. Drives the report filter. */
  flagged: boolean;
}

export interface DiffStats {
  /** Unchanged, proven by equal content hashes -- no bytes moved. */
  byHash: number;
  /** New, because the baseline had no image -- also no bytes moved. */
  newPages: number;
  /** Pairs that needed both images fetched and decoded. */
  compared: number;
  bytesFetched: number;
}

export interface DiffOptions {
  breakpoints: BreakpointSpec[];
  threshold: number;
  concurrency?: number;
  reporter?: Reporter;
}

export interface DiffRun {
  diffs: PageDiff[];
  stats: DiffStats;
}

export async function diffRuns(
  backend: StorageBackend,
  origin: string,
  captures: PageCapture[],
  baselineCaptures: PageCapture[] | null,
  opts: DiffOptions,
): Promise<DiffRun> {
  const { breakpoints, threshold, concurrency = 4, reporter = silentReporter } = opts;
  const limiter = pLimit(concurrency);
  const out: PageDiff[] = [];
  const stats: DiffStats = { byHash: 0, newPages: 0, compared: 0, bytesFetched: 0 };

  const baseByLoc = new Map((baselineCaptures ?? []).map((c) => [c.loc, c]));

  reporter.phase('diff', captures.length);
  await Promise.all(
    captures.map((cap) =>
      limiter(async () => {
        const diffs: Record<string, DiffResult> = {};
        const basePage = baseByLoc.get(cap.loc);

        for (const bp of breakpoints) {
          const shot = cap.breakpoints[bp.name];
          if (!shot) continue;

          const baseShot = basePage?.breakpoints?.[bp.name];

          // The fast path, and the reason a remote baseline is affordable: equal
          // content hashes mean byte-identical PNGs, so nothing is fetched.
          if (shot.sha256 && baseShot?.sha256 && shot.sha256 === baseShot.sha256) {
            diffs[bp.name] = unchangedByHash(shot.height, baseShot.sha256).result;
            stats.byHash++;
            continue;
          }

          // Nothing to compare against: the page is NEW, and that verdict needs
          // no pixels. Skipping the fetch here matters most when a baseline's
          // captures.json is missing or half-written -- a partially completed
          // migration, say -- where the alternative is pulling back every
          // screenshot this run just uploaded.
          if (!baseShot?.sha256) {
            diffs[bp.name] = newByHeight(shot.height).result;
            stats.newPages++;
            continue;
          }

          const current = shot.sha256 ? await backend.getBuffer(blobKey(origin, shot.sha256)) : null;
          const baseline = await backend.getBuffer(blobKey(origin, baseShot.sha256));

          stats.bytesFetched += (current?.length ?? 0) + (baseline?.length ?? 0);
          stats.compared++;

          const outcome = compareShots(baseline, current, threshold);
          outcome.result.baselineSha256 = baseShot.sha256;

          if (outcome.diffBuffer) {
            const sha = createHash('sha256').update(outcome.diffBuffer).digest('hex');
            const key = blobKey(origin, sha);
            if (!(await backend.exists(key))) {
              await backend.putBuffer(key, outcome.diffBuffer, 'image/png');
            }
            outcome.result.diffSha256 = sha;
          }

          diffs[bp.name] = outcome.result;
        }

        const flagged = Object.values(diffs).some((d) => d.status === 'changed');
        out.push({
          loc: cap.loc,
          slug: cap.slug,
          type: cap.type,
          tier: cap.tier,
          ...(cap.lastmod ? { lastmod: cap.lastmod } : {}),
          discoveredVia: cap.discoveredVia,
          breakpoints: diffs,
          flagged,
        });

        reporter.tick();
      }),
    ),
  );
  reporter.endPhase();

  // Most-changed first: the reviewer's queue should open on the worst offender.
  out.sort((a, b) => {
    const worst = (d: PageDiff) =>
      Math.max(0, ...Object.values(d.breakpoints).map((x) => (x.status === 'changed' ? x.ratio : 0)));
    return worst(b) - worst(a);
  });

  return { diffs: out, stats };
}

export interface DiffSummary {
  compared: number;
  flagged: number;
  unchanged: number;
  newPages: number;
  errors: number;
}

export function summarizeDiffs(diffs: PageDiff[]): DiffSummary {
  let flagged = 0;
  let unchanged = 0;
  let newPages = 0;
  let errors = 0;

  for (const d of diffs) {
    const statuses = Object.values(d.breakpoints).map((b) => b.status);
    if (statuses.includes('changed')) flagged++;
    else if (statuses.includes('error')) errors++;
    else if (statuses.every((s) => s === 'new')) newPages++;
    else unchanged++;
  }

  return { compared: diffs.length, flagged, unchanged, newPages, errors };
}

/** The largest changed-pixel fraction across a page's breakpoints. */
export function worstRatio(d: PageDiff): number {
  return Math.max(0, ...Object.values(d.breakpoints).map((b) => (b.status === 'changed' ? b.ratio : 0)));
}

export interface OutlierReport {
  /** Typical change across the flagged pages. */
  median: number;
  /** Pages that changed far more than that. */
  outliers: PageDiff[];
}

/**
 * Find the pages that changed much more than the rest.
 *
 * When a theme or plugin update lands, it usually shifts every page by a similar
 * small amount -- a font swap might move 2% of the pixels on all 500 pages. A
 * page where the update actually BROKE the layout moves far more than that.
 *
 * Comparing each flagged page against the typical change makes that page stand
 * out, which is a warning the tool cannot produce by looking at any page on its
 * own. It is the answer to "the theme changed, so which pages did it damage?"
 *
 * This narrows nothing. Every flagged page is still reported and still needs
 * looking at. This only says which ones to open first.
 */
export function findOutliers(diffs: PageDiff[], minGroup = 10): OutlierReport {
  const flagged = diffs.filter((d) => d.flagged);
  if (flagged.length < minGroup) return { median: 0, outliers: [] };

  const ratios = flagged.map(worstRatio).sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const median =
    ratios.length % 2 ? ratios[mid]! : ((ratios[mid - 1]! + ratios[mid]!) / 2);

  // Three times the typical change, and at least five percentage points above
  // it. The absolute floor matters: when the typical change is 0.1% of pixels,
  // three times that is still far too small to mean anything.
  const threshold = Math.max(median * 3, median + 0.05);

  return {
    median,
    outliers: flagged.filter((d) => worstRatio(d) > threshold).sort((a, b) => worstRatio(b) - worstRatio(a)),
  };
}
