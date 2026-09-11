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
import { silentReporter, type Reporter } from '../progress.js';
import { mergeAssetVersions, type AssetVersions } from '../assets.js';

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
  /** Anchor text per href. Absent on runs captured before this was recorded. */
  linkTexts?: Record<string, string>;
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
  /** Regions excluded from the collected copy, but still screenshotted. */
  textIgnoreSelectors?: string[];
  /**
   * Names the capture in the progress line. The confirmation pass re-captures
   * pages with the same function, and labelling both "capture" would read as
   * the scan having started over.
   */
  phaseLabel?: string;
  reporter?: Reporter;
}

export interface CaptureRun {
  captures: PageCapture[];
  stats: CaptureStats;
  /**
   * Theme and plugin versions for the whole site, merged from every page.
   *
   * Site-wide rather than per-page because it is the same everywhere, and
   * storing it 525 times would bloat captures.json for no benefit.
   */
  assetVersions: AssetVersions;
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

/**
 * How many times a page is attempted before the run gives up on it.
 *
 * A page that fails leaves a HOLE in the baseline: nothing to compare against
 * next time, so the next run reports it as new rather than checking whether it
 * still renders. That is the one outcome this tool exists to prevent, which is
 * why a transient failure is worth waiting out.
 */
const CAPTURE_ATTEMPTS = 3;

/** Long pauses on purpose: a 504 means the server is struggling. */
const CAPTURE_RETRY_MS = [4_000, 15_000];

/**
 * Should this failure be tried again?
 *
 * A 5xx is the server saying "not right now", not "this page does not exist".
 * campwareagle's baseline lost 52 of its 330 pages to HTTP 504 while six scans
 * ran at once -- and the SAME pages succeeded at another breakpoint minutes
 * later, which is the proof that they were fine and the server was just busy.
 *
 * Not retried: 404 and 410, which are settled answers, and anything already
 * marked `blocked` (403/429 from bot protection), where hammering again is the
 * exact wrong response.
 */
export function worthRetrying(result: { ok: boolean; blocked: boolean; status: number; error?: string }): boolean {
  if (result.ok || result.blocked) return false;
  if (result.status >= 500) return true;
  // status 0 means the navigation never produced a response: a socket reset, an
  // aborted request, or Playwright's own timeout.
  return result.status === 0;
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
    textIgnoreSelectors = [],
    phaseLabel = 'capture',
    reporter = silentReporter,
  } = opts;

  const origin = inv.canonicalOrigin;
  let targets = orderForCapture(inv.entries);

  if (changedOnly) {
    const baseByLoc = new Map((baseline?.entries ?? []).map((e) => [e.loc, e]));
    const before = targets.length;
    targets = targets.filter((e) => !isUnchanged(e.lastmod, baseByLoc.get(e.loc)?.lastmod));
    reporter.log(
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
  const assetVersions: AssetVersions = {};
  const browser = await launchBrowser();
  const linkUnion = new Map<string, Set<string>>();
  const textUnion = new Map<string, Record<string, string>>();

  try {
    for (const bp of breakpoints) {
      const ctx = await makeContext(browser, bp, blockUrls);
      const limiter = pLimit(concurrency);

      reporter.phase(`${phaseLabel} ${bp.name} (${bp.width}px)`, targets.length);

      await Promise.all(
        targets.map((entry) =>
          limiter(async () => {
            const cap = captures.get(entry.loc);
            if (!cap) return;

            const wantText = extractText && bp.name === textBreakpoint.name;

            let result = await capturePage(ctx, entry.loc, {
              mask,
              hide,
              extractText: wantText,
              textIgnoreSelector: textIgnoreSelectors.join(','),
            });
            for (let attempt = 1; attempt < CAPTURE_ATTEMPTS && worthRetrying(result); attempt++) {
              const wait = CAPTURE_RETRY_MS[attempt - 1] ?? 15_000;
              reporter.log(
                `    retrying ${entry.loc} in ${wait / 1000}s ` +
                  `(${result.error ?? `HTTP ${result.status}`}, attempt ${attempt + 1}/${CAPTURE_ATTEMPTS})`,
              );
              await new Promise((done) => setTimeout(done, wait));
              result = await capturePage(ctx, entry.loc, {
                mask,
                hide,
                extractText: wantText,
                textIgnoreSelector: textIgnoreSelectors.join(','),
              });
            }

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

            // Only from a page that actually loaded. A failed capture still has
            // text -- the error page's text -- and storing it means the
            // proofreader reads Cloudflare's "error 504" page instead of the
            // site. Its Ray ID is random hex, which the spellchecker then
            // reports as misspellings: "aef", "aedd", "cfe", "ebd", "cbd".
            if (wantText && result.ok && result.textBlocks.length) cap.textBlocks = result.textBlocks;
            mergeAssetVersions(assetVersions, result.assetVersions);

            const set = linkUnion.get(entry.loc) ?? new Set<string>();
            for (const l of result.links) set.add(l);
            linkUnion.set(entry.loc, set);

            const texts = textUnion.get(entry.loc) ?? {};
            for (const [href, text] of Object.entries(result.linkTexts)) {
              if (!texts[href]) texts[href] = text;
            }
            textUnion.set(entry.loc, texts);

            reporter.tick();
            if (!result.ok) {
              reporter.log(
                `    ${result.blocked ? 'BLOCKED' : 'FAILED'} ${entry.loc} ` +
                  `(${result.error ?? `HTTP ${result.status}`})`,
              );
            }
          }),
        ),
      );

      reporter.endPhase();
      await ctx.close();
    }
  } finally {
    reporter.endPhase();
    await browser.close().catch(() => {});
  }

  for (const [loc, set] of linkUnion) {
    const cap = captures.get(loc);
    if (!cap) continue;
    cap.links = [...set];
    const texts = textUnion.get(loc);
    if (texts && Object.keys(texts).length) cap.linkTexts = texts;
  }

  return { captures: [...captures.values()], stats, assetVersions };
}
