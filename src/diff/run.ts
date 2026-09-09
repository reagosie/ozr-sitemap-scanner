import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import { compareShots, unchangedByHash, type DiffResult } from './compare.js';
import { blobKey } from '../store/runs.js';
import type { StorageBackend } from '../store/backend.js';
import type { BreakpointSpec } from '../capture/browser.js';
import type { PageCapture } from '../capture/run.js';
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

export interface DiffStats {
  /** Pairs settled by comparing hashes -- no bytes moved. */
  byHash: number;
  /** Pairs that needed both images fetched and decoded. */
  compared: number;
  bytesFetched: number;
}

export interface DiffOptions {
  breakpoints: BreakpointSpec[];
  threshold: number;
  concurrency?: number;
  onProgress?: (msg: string) => void;
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
  const { breakpoints, threshold, concurrency = 4, onProgress = () => {} } = opts;
  const limiter = pLimit(concurrency);
  const out: PageDiff[] = [];
  const stats: DiffStats = { byHash: 0, compared: 0, bytesFetched: 0 };
  let done = 0;

  const baseByLoc = new Map((baselineCaptures ?? []).map((c) => [c.loc, c]));

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

          const current = shot.sha256 ? await backend.getBuffer(blobKey(origin, shot.sha256)) : null;
          const baseline = baseShot?.sha256
            ? await backend.getBuffer(blobKey(origin, baseShot.sha256))
            : null;

          stats.bytesFetched += (current?.length ?? 0) + (baseline?.length ?? 0);
          stats.compared++;

          const outcome = compareShots(baseline, current, threshold);
          if (baseShot?.sha256) outcome.result.baselineSha256 = baseShot.sha256;

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

        done++;
        if (done % 50 === 0 || done === captures.length) onProgress(`    ${done}/${captures.length}`);
      }),
    ),
  );

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
