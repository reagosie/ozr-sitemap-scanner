import path from 'node:path';
import pLimit from 'p-limit';
import { launchBrowser, makeContext, type BreakpointSpec } from './browser.js';
import { capturePage } from './screenshot.js';
import { isCaptured } from '../discover/classify.js';
import { isUnchanged, lastmodRank } from '../lastmod.js';
import { slugForUrl } from '../store/urls.js';
import type { RunPaths } from '../store/runs.js';
import type { Inventory, Tier, UrlEntry } from '../types.js';

export interface ShotResult {
  file: string;
  height: number;
  ok: boolean;
  status: number;
  blocked: boolean;
  error?: string;
}

export interface PageCapture {
  loc: string;
  slug: string;
  type: string;
  tier: Tier;
  lastmod?: string;
  discoveredVia: 'sitemap' | 'rest';
  breakpoints: Record<string, ShotResult>;
  links: string[];
}

export interface CaptureOptions {
  breakpoints: BreakpointSpec[];
  concurrency: number;
  mask?: string[];
  hide?: string[];
  blockUrls?: string[];
  limit?: number;
  changedOnly?: boolean;
  /** Previous run's inventory, required for --changed-only. */
  baseline?: Inventory | null;
  onProgress?: (msg: string) => void;
}

/**
 * Order the capture set: primary content first, then most-recently-modified.
 * Entries with no lastmod sort to the front of their tier -- unknown recency is
 * treated as "look at this", never as "skip this".
 */
export function orderForCapture(entries: UrlEntry[]): UrlEntry[] {
  return [...entries]
    .filter((e) => isCaptured(e.tier))
    .sort((a, b) => a.tier.localeCompare(b.tier) || lastmodRank(b.lastmod) - lastmodRank(a.lastmod));
}

export async function captureAll(
  inv: Inventory,
  paths: RunPaths,
  opts: CaptureOptions,
): Promise<PageCapture[]> {
  const {
    breakpoints,
    concurrency,
    mask = [],
    hide = [],
    blockUrls = [],
    limit,
    changedOnly = false,
    baseline = null,
    onProgress = () => {},
  } = opts;

  let targets = orderForCapture(inv.entries);

  if (changedOnly) {
    const baseByLoc = new Map((baseline?.entries ?? []).map((e) => [e.loc, e]));
    const before = targets.length;
    targets = targets.filter((e) => !isUnchanged(e.lastmod, baseByLoc.get(e.loc)?.lastmod));
    onProgress(
      `--changed-only: ${targets.length} of ${before} URLs (SPOT-CHECK ONLY - a theme or CSS change ` +
        `alters every page without moving any lastmod, and would be invisible in this mode)`,
    );
  }

  if (limit && limit > 0) targets = targets.slice(0, limit);

  const captures = new Map<string, PageCapture>();
  for (const e of targets) {
    captures.set(e.loc, {
      loc: e.loc,
      slug: slugForUrl(e.loc),
      type: e.type,
      tier: e.tier,
      ...(e.lastmod ? { lastmod: e.lastmod } : {}),
      discoveredVia: e.discoveredVia,
      breakpoints: {},
      links: [],
    });
  }

  const browser = await launchBrowser();
  const linkUnion = new Map<string, Set<string>>();

  try {
    for (const bp of breakpoints) {
      const ctx = await makeContext(browser, bp, blockUrls);
      const limiter = pLimit(concurrency);
      let done = 0;

      onProgress(`\n  ${bp.name} (${bp.width}px) - ${targets.length} URLs`);

      await Promise.all(
        targets.map((entry) =>
          limiter(async () => {
            const cap = captures.get(entry.loc);
            if (!cap) return;

            const file = `${cap.slug}__${bp.name}.png`;
            const result = await capturePage(ctx, entry.loc, {
              path: path.join(paths.shots, file),
              mask,
              hide,
            });

            cap.breakpoints[bp.name] = {
              file,
              height: result.height,
              ok: result.ok,
              status: result.status,
              blocked: result.blocked,
              ...(result.error ? { error: result.error } : {}),
            };

            const set = linkUnion.get(entry.loc) ?? new Set<string>();
            for (const l of result.links) set.add(l);
            linkUnion.set(entry.loc, set);

            done++;
            if (done % 25 === 0 || done === targets.length) {
              onProgress(`    ${done}/${targets.length}`);
            }
            if (!result.ok) {
              onProgress(
                `    ${result.blocked ? 'BLOCKED' : 'FAILED'} ${entry.loc} ` +
                  `(${result.error ?? `HTTP ${result.status}`})`,
              );
            }
          }),
        ),
      );

      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }

  for (const [loc, set] of linkUnion) {
    const cap = captures.get(loc);
    if (cap) cap.links = [...set];
  }

  return [...captures.values()];
}
