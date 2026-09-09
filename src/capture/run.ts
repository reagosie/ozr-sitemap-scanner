import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import { launchBrowser, makeContext, type BreakpointSpec } from './browser.js';
import { capturePage, type TextBlock } from './screenshot.js';
import { isCaptured } from '../discover/classify.js';
import { isUnchanged, lastmodRank } from '../lastmod.js';
import { slugForUrl } from '../store/urls.js';
import { blobKey } from '../store/runs.js';
import type { StorageBackend } from '../store/backend.js';
import type { Inventory, Tier, UrlEntry } from '../types.js';

export interface ShotResult {
  /** Human-readable download name. Not a storage key. */
  file: string;
  /**
   * SHA-256 of the PNG bytes, and therefore its address in the blob store.
   *
   * This doubles as the change oracle: two runs whose hashes match are
   * byte-identical, so the diff stage can rule the page unchanged without
   * transferring either image.
   */
  sha256?: string;
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
  /** Page copy, collected once per page rather than once per breakpoint. */
  textBlocks?: TextBlock[];
}

export interface CaptureStats {
  /** Blobs written. */
  uploaded: number;
  /** Blobs already present -- an unchanged page since some earlier run. */
  reused: number;
  bytesUploaded: number;
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
  /** Collect page copy for the proofreader. */
  extractText?: boolean;
  onProgress?: (msg: string) => void;
}

export interface CaptureRun {
  captures: PageCapture[];
  stats: CaptureStats;
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
  backend: StorageBackend,
  opts: CaptureOptions,
): Promise<CaptureRun> {
  const {
    breakpoints,
    concurrency,
    mask = [],
    hide = [],
    blockUrls = [],
    limit,
    changedOnly = false,
    baseline = null,
    extractText = false,
    onProgress = () => {},
  } = opts;

  const origin = inv.canonicalOrigin;
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

  // Copy is collected at the WIDEST breakpoint only. The words are the same at
  // every width -- responsive CSS moves things, it does not rewrite them -- and
  // the widest layout is the one least likely to have content collapsed away.
  const textBreakpoint = breakpoints.reduce(
    (widest, bp) => (bp.width > widest.width ? bp : widest),
    breakpoints[0] as BreakpointSpec,
  );

  const stats: CaptureStats = { uploaded: 0, reused: 0, bytesUploaded: 0 };
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

            const wantText = extractText && bp.name === textBreakpoint.name;
            const result = await capturePage(ctx, entry.loc, {
              mask,
              hide,
              extractText: wantText,
            });

            const file = `${cap.slug}__${bp.name}.png`;
            let sha256: string | undefined;

            if (result.buffer) {
              sha256 = createHash('sha256').update(result.buffer).digest('hex');
              const key = blobKey(origin, sha256);
              // The dedup that makes repeat runs nearly free: an unchanged page
              // produces bytes we already hold, so a HEAD replaces a multi-MB PUT.
              if (await backend.exists(key)) {
                stats.reused++;
              } else {
                await backend.putBuffer(key, result.buffer, 'image/png');
                stats.uploaded++;
                stats.bytesUploaded += result.buffer.length;
              }
            }

            cap.breakpoints[bp.name] = {
              file,
              ...(sha256 ? { sha256 } : {}),
              height: result.height,
              ok: result.ok,
              status: result.status,
              blocked: result.blocked,
              ...(result.error ? { error: result.error } : {}),
            };

            if (wantText && result.textBlocks.length) cap.textBlocks = result.textBlocks;

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

  return { captures: [...captures.values()], stats };
}
