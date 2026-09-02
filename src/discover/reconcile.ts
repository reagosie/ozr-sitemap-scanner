import pLimit from 'p-limit';
import { detectWordPress, resolveCanonicalOrigin } from './detect.js';
import { fetchRobots, SITEMAP_FALLBACKS } from './robots.js';
import { fetchSitemapIndex, fetchUrlset, parseSitemapName } from './sitemap.js';
import { fetchTaxonomies, fetchTypeCounts, fetchTypeLinks, fetchTypes, isInternalType } from './wpApi.js';
import { assignTier, isCaptured, type TierOverrides } from './classify.js';
import { canonicalizeUrl } from '../store/urls.js';
import type { Inventory, SubSitemapResult, TypeSummary, UrlEntry } from '../types.js';

export interface DiscoverOptions {
  concurrency?: number;
  tierOverrides?: TierOverrides;
  /** Skip REST cross-check (faster, but loses missed-page detection). */
  skipRest?: boolean;
  onProgress?: (msg: string) => void;
}

export async function discover(site: string, opts: DiscoverOptions = {}): Promise<Inventory> {
  const { concurrency = 3, tierOverrides = {}, skipRest = false, onProgress = () => {} } = opts;
  const errors: string[] = [];

  const canonicalOrigin = await resolveCanonicalOrigin(site);
  onProgress(`canonical origin: ${canonicalOrigin}`);

  const detection = await detectWordPress(canonicalOrigin);
  if (!detection.isWordPress) {
    throw new Error(
      `${canonicalOrigin} does not look like WordPress. Evidence: ${detection.evidence.join('; ') || 'none'}. ` +
        `This tool currently supports WordPress sites only.`,
    );
  }
  onProgress(`WordPress confirmed (${detection.evidence.length} signals)`);

  const robots = await fetchRobots(canonicalOrigin);
  if (!robots.fetched) errors.push(`robots.txt unavailable: ${robots.error}`);
  if (robots.crawlDelay !== null) {
    // Recorded for the record only. Deliberately not obeyed: first-party sites,
    // and a 10s delay would add hours of pure waiting to a full pass.
    onProgress(`robots.txt declares Crawl-delay: ${robots.crawlDelay} (recorded, not obeyed)`);
  }

  // --- locate the sitemap index -------------------------------------------
  const candidates = robots.sitemaps.length
    ? robots.sitemaps
    : SITEMAP_FALLBACKS.map((p) => new URL(p, canonicalOrigin).toString());

  let indexUrl = '';
  let children: string[] = [];
  const indexAttempts: string[] = [];

  for (const cand of candidates) {
    const r = await fetchSitemapIndex(cand);
    if (r.ok && r.isUrlset) {
      indexUrl = cand;
      children = [cand];
      break;
    }
    if (r.ok && r.children.length) {
      indexUrl = cand;
      children = r.children;
      break;
    }
    indexAttempts.push(`${cand}: ${r.error ?? 'no children'}`);
  }

  if (!children.length) throw new Error(`No usable sitemap found. Tried:\n  ${indexAttempts.join('\n  ')}`);
  onProgress(`sitemap index: ${indexUrl} (${children.length} sub-sitemaps)`);

  const flavor = parseSitemapName(children[0] ?? '').flavor;

  // --- fetch every sub-sitemap --------------------------------------------
  const limit = pLimit(concurrency);
  const fetched = await Promise.all(
    children.map((c) =>
      limit(async () => {
        const out = await fetchUrlset(c, canonicalOrigin);
        onProgress(
          out.result.ok
            ? `  ${out.result.type}: ${out.result.urlCount} urls (${out.result.withLastmod} w/lastmod)`
            : `  ${out.result.type}: FAILED - ${out.result.error}`,
        );
        return out;
      }),
    ),
  );

  const subSitemaps: SubSitemapResult[] = fetched.map((f) => f.result);
  let entries: UrlEntry[] = fetched.flatMap((f) => f.entries);

  // A sub-sitemap we could not read means an INCOMPLETE INVENTORY -- the exact
  // failure this tool exists to eliminate. Never let it pass as zero. A 404 is
  // called out separately because it is a durable site defect (the index
  // advertises a sitemap that does not exist), not a transient blip.
  for (const s of subSitemaps) {
    if (s.ok) continue;
    const kindOfFailure = /HTTP 404/.test(s.error ?? '')
      ? 'declared in the sitemap index but returns 404 (site defect, recurs every run)'
      : `unreadable after ${s.attempts} attempts`;
    errors.push(`sub-sitemap ${kindOfFailure}: ${s.url} (${s.error})`);
  }

  // --- resolve Yoast "unknown" kinds via the REST taxonomy list ------------
  let taxonomies = new Set<string>();
  if (detection.restBase && !skipRest) taxonomies = await fetchTaxonomies(detection.restBase);
  for (const e of entries) if (e.kind === 'unknown') e.kind = taxonomies.has(e.type) ? 'taxonomy' : 'post';
  for (const s of subSitemaps) if (s.kind === 'unknown') s.kind = taxonomies.has(s.type) ? 'taxonomy' : 'post';

  // --- REST cross-check ----------------------------------------------------
  const possiblyMissed: Inventory['possiblyMissed'] = [];
  const missingFromSitemap: Inventory['missingFromSitemap'] = [];
  const restCounts = new Map<string, number | null>();

  if (detection.restBase && !skipRest) {
    const { types, error } = await fetchTypes(detection.restBase);
    if (error) {
      errors.push(`REST types unavailable: ${error}`);
    } else {
      const withCounts = await fetchTypeCounts(detection.restBase, types, concurrency);
      const sitemapTypes = new Set(subSitemaps.map((s) => s.type));
      const allSitemapUrls = new Set(entries.map((e) => e.loc));

      for (const t of withCounts) {
        restCounts.set(t.slug, t.count);
        if (!sitemapTypes.has(t.slug) && (t.count ?? 0) > 0 && !isInternalType(t.slug)) {
          possiblyMissed.push({ type: t.slug, restCount: t.count as number, restBase: t.restBase });
        }
      }
      onProgress(`REST cross-check: ${withCounts.length} types, ${possiblyMissed.length} type(s) absent from sitemap`);

      // For types we would actually capture, enumerate permalinks and set-diff
      // against the sitemap. Restricted to capture tiers so we do not paginate
      // through thousands of event/stream records for no review value.
      const toEnumerate = withCounts.filter(
        (t) => sitemapTypes.has(t.slug) && (t.count ?? 0) > 0 && isCaptured(assignTier(t.slug, 'post', tierOverrides)),
      );

      const restEntries: UrlEntry[] = [];
      await Promise.all(
        toEnumerate.map((t) =>
          limit(async () => {
            const { links, error: linkErr } = await fetchTypeLinks(detection.restBase as string, t);
            if (linkErr) {
              errors.push(`REST enumeration failed for type "${t.slug}": ${linkErr}`);
              return;
            }
            const canon = links.flatMap((l) => {
              const loc = canonicalizeUrl(l.url, canonicalOrigin);
              return loc ? [{ loc, modified: l.modified }] : [];
            });

            const seenMissing = new Map<string, string | undefined>();
            for (const l of canon) {
              if (allSitemapUrls.has(l.loc) || seenMissing.has(l.loc)) continue;
              seenMissing.set(l.loc, l.modified);
            }
            const missing = [...seenMissing.keys()];
            if (!missing.length) return;

            const sitemapCount = entries.filter((e) => e.type === t.slug).length;
            missingFromSitemap.push({ type: t.slug, sitemapCount, restCount: t.count ?? 0, urls: missing });
            onProgress(`  ${t.slug}: ${missing.length} published URL(s) missing from the sitemap`);

            for (const [loc, modified] of seenMissing) {
              restEntries.push({
                loc,
                rawLoc: loc,
                ...(modified ? { lastmod: modified } : {}),
                type: t.slug,
                kind: 'post',
                tier: 'A',
                source: `rest:${t.restBase}`,
                discoveredVia: 'rest',
              });
            }
          }),
        ),
      );

      entries = entries.concat(restEntries);
    }
  }

  // --- tier + dedupe -------------------------------------------------------
  for (const e of entries) e.tier = assignTier(e.type, e.kind, tierOverrides);

  const seen = new Map<string, UrlEntry>();
  let duplicates = 0;
  for (const e of entries) {
    if (seen.has(e.loc)) {
      duplicates++;
      continue;
    }
    seen.set(e.loc, e);
  }
  entries = [...seen.values()];
  if (duplicates) onProgress(`deduplicated ${duplicates} repeated URLs`);

  // --- per-type rollup -----------------------------------------------------
  const byType = new Map<string, TypeSummary>();
  for (const e of entries) {
    const cur = byType.get(e.type) ?? {
      type: e.type,
      kind: e.kind,
      tier: e.tier,
      urls: 0,
      withLastmod: 0,
      restCount: restCounts.get(e.type) ?? null,
    };
    cur.urls++;
    if (e.lastmod) cur.withLastmod++;
    byType.set(e.type, cur);
  }

  const typeSummary = [...byType.values()].sort((a, b) => a.tier.localeCompare(b.tier) || b.urls - a.urls);

  return {
    site,
    canonicalOrigin,
    flavor,
    discoveredAt: new Date().toISOString(),
    robots,
    detection,
    entries,
    subSitemaps,
    typeSummary,
    possiblyMissed,
    missingFromSitemap,
    errors,
  };
}
