import path from 'node:path';
import pLimit from 'p-limit';
import { compareShots, type DiffResult } from './compare.js';
import type { BreakpointSpec } from '../capture/browser.js';
import type { PageCapture } from '../capture/run.js';
import type { RunPaths } from '../store/runs.js';
import type { Tier } from '../types.js';

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

export interface DiffOptions {
  breakpoints: BreakpointSpec[];
  threshold: number;
  concurrency?: number;
  onProgress?: (msg: string) => void;
}

export async function diffRuns(
  current: RunPaths,
  baseline: RunPaths,
  captures: PageCapture[],
  opts: DiffOptions,
): Promise<PageDiff[]> {
  const { breakpoints, threshold, concurrency = 4, onProgress = () => {} } = opts;
  const limiter = pLimit(concurrency);
  const out: PageDiff[] = [];
  let done = 0;

  await Promise.all(
    captures.map((cap) =>
      limiter(async () => {
        const diffs: Record<string, DiffResult> = {};

        for (const bp of breakpoints) {
          const shot = cap.breakpoints[bp.name];
          if (!shot) continue;

          diffs[bp.name] = await compareShots(
            path.join(baseline.shots, shot.file),
            path.join(current.shots, shot.file),
            path.join(current.diffs, shot.file),
            threshold,
          );
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

        done++;
        if (done % 50 === 0 || done === captures.length) onProgress(`    ${done}/${captures.length}`);
      }),
    ),
  );

  // Most-changed first: the reviewer's queue should open on the worst offender.
  return out.sort((a, b) => {
    const worst = (d: PageDiff) =>
      Math.max(0, ...Object.values(d.breakpoints).map((x) => (x.status === 'changed' ? x.ratio : 0)));
    return worst(b) - worst(a);
  });
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
